import { useEffect, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, SNMPConfig, SNMPCommunity, SNMPV3User, SNMPV3Group, SNMPTrapTarget, Interface } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'
import { Loading } from '../components/Loading'

type SnmpTab = 'system' | 'v2c' | 'v3' | 'traps'

// Generate a 12-byte random hex engine ID (VyOS accepts 10-32 byte hex).
function generateEngineID(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return '8000' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

// Alphanumeric-only sanitizer for VyOS names (underscore + hyphen allowed,
// but VyOS's own grammar varies — we keep it permissive and let VyOS be the
// final arbiter. For SNMP user/community names specifically VyOS rejects
// hyphens, so we aggressively strip those for those fields.)
const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '')
const cleanStrict = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '')

export function SNMP() {
  const { id } = useParams<{ id: string }>()
  const [tab, setTab] = useState<SnmpTab>('system')
  const [cfg, setCfg] = useState<SNMPConfig | null>(null)
  const [dirty, setDirty] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const [editMode, setEditMode] = useState(false)

  const deviceQ = useQuery({ queryKey: ['device', id], queryFn: () => api.getDevice(id!), enabled: !!id })
  const q = useQuery({ queryKey: ['snmp', id], queryFn: () => api.getSNMPConfig(id!), enabled: !!id })
  const ifacesQ = useQuery({
    queryKey: ['interfaces', id], queryFn: () => api.listInterfaces(id!),
    enabled: !!id, staleTime: 30_000,
  })

  useEffect(() => { if (q.data) setCfg(q.data) }, [q.data])

  const save = useMutation({
    mutationFn: () => {
      // Auto-fill engine ID if missing but v3 users exist (VyOS 1.5 requires
      // an engine ID to hash v3 passwords; without it the commit explodes).
      let c = cfg!
      if ((c.v3_users?.length || 0) > 0 && !c.engine_id) {
        c = { ...c, engine_id: generateEngineID() }
      }
      return api.upsertSNMPConfig(id!, c)
    },
    onSuccess: () => {
      setErr(null); setOk(true); setDirty(false)
      setTimeout(() => setOk(false), 2500)
      // Refetch from VyOS to show what actually landed — encrypted passwords,
      // normalized names, engine IDs that VyOS may have rewritten.
      q.refetch()
    },
    onError: (e: any) => setErr(e.message),
  })

  // Destructive: removes the entire `service snmp` subtree from the device.
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteAll = useMutation({
    mutationFn: () => api.deleteSNMPConfig(id!),
    onSuccess: () => {
      setErr(null); setOk(true); setDirty(false); setConfirmDelete(false)
      setEditMode(false)
      setTimeout(() => setOk(false), 2500)
      q.refetch()
    },
    onError: (e: any) => { setErr(e.message); setConfirmDelete(false) },
  })

  if (q.isError) return (
    <>
      <DeviceHeader />
      <div className="err" style={{ marginTop: 12 }}>
        Failed to load SNMP config: {(q.error as Error).message}
      </div>
    </>
  )
  if (!cfg) return (
    <>
      <DeviceHeader />
      <div className="card" style={{ padding: 8 }}><Loading /></div>
    </>
  )

  const isProd = (deviceQ.data?.tags || []).some(t => t.toLowerCase() === 'production')
  const hasV2C = (cfg.communities?.length || 0) > 0
    || (cfg.trap_targets || []).some(t => t.version === 'v2c')

  // Pre-flight: every selected listen-address must exist on the device, and
  // its interface VRF must match the configured SNMP VRF.
  const ifaces = ifacesQ.data || []
  const addrToVRF: Record<string, { iface: string; vrf: string }> = {}
  for (const i of ifaces) {
    for (const a of i.addresses || []) {
      const bare = a.split('/')[0]
      if (bare && !bare.startsWith('fe80')) {
        addrToVRF[bare] = { iface: i.name, vrf: i.vrf || '' }
      }
    }
  }
  const cfgVRF = (cfg.vrf || '').trim()
  const addrErrors: string[] = []
  for (const sel of cfg.listen_addresses || []) {
    const m = addrToVRF[sel]
    if (!m) { addrErrors.push(`${sel} is not on any interface`); continue }
    if ((m.vrf || '') !== cfgVRF) {
      addrErrors.push(`${sel} → VRF ${m.vrf || 'default'}, but SNMP VRF is ${cfgVRF || 'default'}`)
    }
  }
  const hasAddrError = addrErrors.length > 0
  const update = (patch: Partial<SNMPConfig>) => { setDirty(true); setCfg({ ...cfg, ...patch }) }

  return (
    <>
      <DeviceHeader />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 16 }}>SNMP</h2>
          <div className="hint">v2c communities, v3 users/groups/views, and trap destinations.</div>
          <div style={{ marginTop: 6, fontSize: 11, display: 'flex', alignItems: 'center', gap: 8 }}>
            {dirty ? (
              <>
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: 4,
                  background: 'var(--warn, #e08e00)',
                }} />
                <span style={{ color: 'var(--warn-ink, #e08e00)' }}>
                  Staged changes — not yet committed to device
                </span>
              </>
            ) : (
              <>
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: 4,
                  background: 'var(--ok, #0a8f50)',
                }} />
                <span style={{ color: 'var(--ink-muted)' }}>
                  In sync with {deviceQ.data?.address || 'device'}
                  {q.dataUpdatedAt ? ` · fetched ${new Date(q.dataUpdatedAt).toLocaleTimeString()}` : ''}
                </span>
                <button className="btn" style={{
                  height: 20, padding: '0 8px', fontSize: 10, marginLeft: 4,
                }} onClick={() => q.refetch()}>↻ refetch</button>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!editMode ? (
            <>
              <button className="btn btn-danger"
                onClick={() => setConfirmDelete(true)}
                disabled={isEmptyConfig(cfg)}
                title={isEmptyConfig(cfg) ? 'Nothing to delete' : 'Remove the entire SNMP configuration from the device'}>
                Delete all
              </button>
              <button className="btn btn-primary" onClick={() => setEditMode(true)}>
                Edit
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => {
                if (dirty && !confirm('Discard unsaved changes?')) return
                if (q.data) setCfg(q.data)
                setDirty(false); setErr(null); setEditMode(false)
              }}>
                Cancel
              </button>
              <button className="btn btn-primary"
                disabled={save.isPending || !dirty || hasAddrError}
                title={hasAddrError ? `Fix ${addrErrors.length} validation error(s) before saving` : ''}
                onClick={() => save.mutate(undefined, {
                  onSuccess: () => setEditMode(false),
                })}>
                {save.isPending ? 'Committing…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>

      {isProd && hasV2C && (
        <div style={{
          background: 'var(--danger-soft)', color: 'var(--danger-ink)',
          padding: '10px 14px', borderRadius: 6, marginBottom: 12,
          fontSize: 13, borderLeft: '3px solid var(--danger)',
        }}>
          <strong>Production device with v2c config</strong> — the commit will be
          rejected. Remove v2c communities and trap targets, or untag the device as production.
        </div>
      )}
      {err && <div className="err">{err}</div>}
      {ok && <div style={{
        background: 'var(--ok-soft)', color: 'var(--ok)',
        padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 12,
      }}>Saved.</div>}

      <div style={{
        display: 'flex', gap: 2, borderBottom: '1px solid var(--line)',
        marginBottom: 14, overflowX: 'auto',
      }}>
        {(['system','v2c','v3','traps'] as SnmpTab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={subTabStyle(tab === t)}>
            {label(t)}{badge(t, cfg)}
          </button>
        ))}
      </div>

      <fieldset disabled={!editMode} style={{
        border: 0, padding: 0, margin: 0,
        opacity: editMode ? 1 : 0.92,
      }}>
        {tab === 'system' && <SystemTab cfg={cfg} update={update} interfaces={ifacesQ.data || []} />}
        {tab === 'v2c' && <V2CTab cfg={cfg} update={update} isProd={isProd} />}
        {tab === 'v3' && <V3Tab cfg={cfg} update={update} />}
        {tab === 'traps' && <TrapsTab cfg={cfg} update={update} />}
      </fieldset>

      {!editMode && (
        <div style={{
          fontSize: 11, color: 'var(--ink-muted)', marginTop: 10, textAlign: 'right',
        }}>
          Click <strong>Edit</strong> to make changes.
        </div>
      )}

      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => !deleteAll.isPending && setConfirmDelete(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 460 }}>
            <div className="modal-head">
              <h2 style={{ color: 'var(--danger)' }}>Delete all SNMP config?</h2>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
                This runs <code style={{
                  fontFamily: 'var(--font-mono)', fontSize: 12,
                  background: 'var(--bg-subtle)', padding: '2px 6px', borderRadius: 3,
                }}>delete service snmp</code> on the device and commits immediately.
              </p>
              <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
                Everything below will be removed:
              </p>
              <ul style={{ fontSize: 12, color: 'var(--ink-muted)', marginLeft: 20, lineHeight: 1.7 }}>
                <li>System info (sysContact, sysLocation, sysDescr)</li>
                <li>Listen addresses, port, VRF</li>
                <li>{cfg.communities?.length || 0} v2c community string(s)</li>
                <li>{cfg.v3_users?.length || 0} v3 user(s)</li>
                <li>{cfg.v3_groups?.length || 0} v3 group(s)</li>
                <li>{cfg.v3_views?.length || 0} v3 view(s)</li>
                <li>{cfg.trap_targets?.length || 0} trap destination(s)</li>
                <li>Engine ID</li>
              </ul>
              <p style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 10 }}>
                Audit log records this action. You can rollback from the VyOS CLI
                with <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>rollback 1</code>.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setConfirmDelete(false)}
                disabled={deleteAll.isPending}>Cancel</button>
              <button className="btn btn-danger" onClick={() => deleteAll.mutate()}
                disabled={deleteAll.isPending}>
                {deleteAll.isPending ? 'Deleting…' : 'Yes, delete everything'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// isEmptyConfig returns true if there's nothing meaningful to delete.
function isEmptyConfig(c: SNMPConfig): boolean {
  return !c.contact && !c.location && !c.description && !c.vrf && !c.engine_id
    && (c.listen_addresses?.length || 0) === 0
    && (c.communities?.length || 0) === 0
    && (c.v3_users?.length || 0) === 0
    && (c.v3_groups?.length || 0) === 0
    && (c.v3_views?.length || 0) === 0
    && (c.trap_targets?.length || 0) === 0
}

function SystemTab({ cfg, update, interfaces }: {
  cfg: SNMPConfig; update: (p: Partial<SNMPConfig>) => void; interfaces: Interface[]
}) {
  // Build a flat list of (address, interface, vrf) tuples from device interfaces
  // so the user picks from the device's actual topology rather than typing.
  type AddrChoice = { addr: string; iface: string; vrf: string }
  const choices: AddrChoice[] = []
  for (const i of interfaces) {
    for (const a of i.addresses || []) {
      // Strip CIDR suffix; SNMP listens on a bare IP, not a network.
      const bare = a.split('/')[0]
      if (!bare || bare.startsWith('fe80')) continue // skip link-local v6
      choices.push({ addr: bare, iface: i.name, vrf: i.vrf || '' })
    }
  }
  // VRFs available on the device, with "(default)" as option zero.
  const vrfs = Array.from(new Set(interfaces.map(i => i.vrf || ''))).sort()

  // Validate: every selected listen address must exist on the device, and
  // its interface's VRF must match cfg.vrf (or both must be empty/default).
  const selectedVRF = (cfg.vrf || '').trim()
  const validation: string[] = []
  for (const sel of cfg.listen_addresses || []) {
    const match = choices.find(c => c.addr === sel)
    if (!match) {
      validation.push(`${sel} is not configured on any interface of this device.`)
      continue
    }
    if ((match.vrf || '') !== selectedVRF) {
      validation.push(
        `${sel} is on ${match.iface} in ${match.vrf ? `VRF "${match.vrf}"` : 'default VRF'}, ` +
        `but SNMP is bound to ${selectedVRF ? `VRF "${selectedVRF}"` : 'default VRF'}. ` +
        `Either pick a different address or change the VRF.`
      )
    }
  }

  const toggleAddr = (addr: string) => {
    const cur = cfg.listen_addresses || []
    const next = cur.includes(addr) ? cur.filter(a => a !== addr) : [...cur, addr]
    update({ listen_addresses: next })
  }

  // When the user picks an address but no VRF set yet, auto-suggest the VRF
  // of the first selected address. This makes the common path one-click.
  const autoFillVRF = (addr: string) => {
    const c = choices.find(x => x.addr === addr)
    if (c && !cfg.vrf) update({ vrf: c.vrf })
  }

  return (
    <section className="card" style={{ padding: 14 }}>
      <div className="row2">
        <div className="field"><label>sysContact</label>
          <input type="text" value={cfg.contact || ''} onChange={e => update({ contact: e.target.value })}
            placeholder="noc@example.com" /></div>
        <div className="field"><label>sysLocation</label>
          <input type="text" value={cfg.location || ''} onChange={e => update({ location: e.target.value })}
            placeholder="dc1-rack-3" /></div>
      </div>
      <div className="field"><label>sysDescr</label>
        <input type="text" value={cfg.description || ''} onChange={e => update({ description: e.target.value })} /></div>

      <div className="row2">
        <div className="field"><label>VRF
          <span className="hint"> (must match the listen address's VRF)</span>
        </label>
          <select className="select" value={cfg.vrf || ''}
            onChange={e => update({ vrf: e.target.value })}>
            <option value="">(default VRF)</option>
            {vrfs.filter(v => v !== '').map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>
        <div className="field"><label>Listen port</label>
          <input type="number" value={cfg.listen_port ?? 161}
            onChange={e => update({ listen_port: parseInt(e.target.value) || 161 })} /></div>
      </div>

      <div className="field">
        <label>Listen addresses <span className="hint">(pick one or more from this device)</span></label>
        <div style={{
          border: '1px solid var(--line)', borderRadius: 6,
          padding: 8, background: 'var(--bg)',
          maxHeight: 220, overflowY: 'auto',
        }}>
          {choices.length === 0 && (
            <div style={{ padding: 12, color: 'var(--ink-muted)', fontSize: 12 }}>
              No interface addresses found. Configure an interface first, then revisit this page.
            </div>
          )}
          {choices.map(c => {
            const checked = (cfg.listen_addresses || []).includes(c.addr)
            const vrfMatches = (c.vrf || '') === selectedVRF
            return (
              <label key={`${c.iface}-${c.addr}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '5px 6px', borderRadius: 4, cursor: 'pointer',
                  background: checked ? 'var(--brand-soft)' : 'transparent',
                }}>
                <input type="checkbox" checked={checked}
                  onChange={() => { toggleAddr(c.addr); if (!checked) autoFillVRF(c.addr) }} />
                <span className="mono" style={{ fontSize: 12, minWidth: 140 }}>{c.addr}</span>
                <span className="dim mono" style={{ fontSize: 11 }}>{c.iface}</span>
                <span style={{
                  marginLeft: 'auto', fontSize: 10,
                  padding: '1px 6px', borderRadius: 10,
                  background: vrfMatches ? 'var(--ok-soft)' : 'var(--warn-soft)',
                  color: vrfMatches ? 'var(--ok)' : 'var(--warn-ink)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {c.vrf ? `vrf: ${c.vrf}` : 'default vrf'}
                </span>
              </label>
            )
          })}
        </div>
        {validation.length > 0 && (
          <div style={{
            marginTop: 8, padding: '8px 10px', borderRadius: 6,
            background: 'var(--warn-soft)', color: 'var(--warn-ink)',
            fontSize: 12, lineHeight: 1.5,
            borderLeft: '3px solid var(--warn, #e08e00)',
          }}>
            <strong>Pre-flight check:</strong>
            <ul style={{ marginLeft: 18, marginTop: 4 }}>
              {validation.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          </div>
        )}
      </div>

      <div className="field">
        <label>Engine ID <span className="hint">(hex; required for v3 — auto-generated on commit if blank)</span></label>
        <input type="text" value={cfg.engine_id || ''} onChange={e => update({ engine_id: e.target.value })}
          placeholder="leave blank to auto-generate" />
      </div>
    </section>
  )
}

function V2CTab({ cfg, update, isProd }: { cfg: SNMPConfig; update: (p: Partial<SNMPConfig>) => void; isProd: boolean }) {
  const comms = cfg.communities || []
  const add = () => update({ communities: [...comms, { name: '', authorization: 'ro' }] })
  const edit = (i: number, patch: Partial<SNMPCommunity>) => update({
    communities: comms.map((c, idx) => idx === i ? { ...c, ...patch } : c)
  })
  const remove = (i: number) => update({ communities: comms.filter((_, idx) => idx !== i) })

  return (
    <>
      {isProd && (
        <div style={{
          background: 'var(--warn-soft)', color: 'var(--warn-ink)',
          padding: '10px 14px', borderRadius: 6, marginBottom: 12, fontSize: 12,
        }}>
          This device is tagged <span className="mono">production</span>. v2c is
          insecure. Any v2c config here will be rejected on commit — use the v3 tab instead.
        </div>
      )}
      <div className="card">
        <div className="card-head">
          <span className="card-title">v2c communities</span>
          <button className="btn btn-primary" style={{ height: 24, padding: '0 10px', fontSize: 11 }}
            onClick={add}>+ community</button>
        </div>
        <table className="tbl">
          <thead>
            <tr><th>Community</th><th>Auth</th><th>Clients</th><th className="right">Actions</th></tr>
          </thead>
          <tbody>
            {comms.map((c, i) => (
              <tr key={i}>
                <td><input type="text" value={c.name}
                  onChange={e => edit(i, { name: cleanStrict(e.target.value) })}
                  placeholder="public" /></td>
                <td><select className="select" value={c.authorization || 'ro'}
                  onChange={e => edit(i, { authorization: e.target.value as 'ro' | 'rw' })}>
                  <option value="ro">ro</option><option value="rw">rw</option>
                </select></td>
                <td><input type="text" value={(c.clients || []).join(', ')}
                  onChange={e => edit(i, { clients: e.target.value.split(/[,\s]+/).filter(Boolean) })}
                  placeholder="10.0.0.0/24" /></td>
                <td className="right">
                  <button className="btn btn-danger" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => remove(i)}>remove</button>
                </td>
              </tr>
            ))}
            {comms.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 20, color: 'var(--ink-muted)' }}>
                No v2c communities.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

function V3Tab({ cfg, update }: { cfg: SNMPConfig; update: (p: Partial<SNMPConfig>) => void }) {
  const users = cfg.v3_users || []
  const groups = cfg.v3_groups || []
  const views = cfg.v3_views || []

  // First-user adds seed the default view + group, mirroring the canonical
  // VyOS chain: user → group → view → OID.
  const addUserWithDefaults = () => {
    const nextViews = views.some(v => v.name === 'default') ? views
      : [...views, { name: 'default', oids: ['1'] }]
    const nextGroups = groups.some(g => g.name === 'default') ? groups
      : [...groups, { name: 'default', mode: 'ro' as const, sec_level: 'priv', view: 'default' }]
    update({
      v3_views: nextViews,
      v3_groups: nextGroups,
      v3_users: [...users, {
        name: '', group: 'default', auth_protocol: 'sha', priv_protocol: 'aes', tp_mode: 'priv',
      }],
    })
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <span className="card-title">v3 users</span>
          <button className="btn btn-primary" style={{ height: 24, padding: '0 10px', fontSize: 11 }}
            onClick={addUserWithDefaults}>+ user</button>
        </div>
        <div style={{ padding: 12 }}>
          {users.length === 0 && (
            <div style={{ padding: 20, color: 'var(--ink-muted)', textAlign: 'center' }}>
              No v3 users yet. “+ user” also seeds a default view and group.
            </div>
          )}
          {users.map((u, i) => (
            <UserCard key={i} user={u} groups={groups}
              onChange={patch => update({
                v3_users: users.map((x, idx) => idx === i ? { ...x, ...patch } : x)
              })}
              onRemove={() => update({ v3_users: users.filter((_, idx) => idx !== i) })} />
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <span className="card-title">v3 groups <span className="hint">(bind security level + view)</span></span>
          <button className="btn" style={{ height: 24, padding: '0 10px', fontSize: 11 }}
            onClick={() => update({ v3_groups: [...groups, {
              name: '', mode: 'ro', sec_level: 'priv', view: 'default',
            }] })}>+ group</button>
        </div>
        <table className="tbl">
          <thead><tr>
            <th style={{ width: '25%' }}>Name</th>
            <th style={{ width: '15%' }}>Mode</th>
            <th style={{ width: '15%' }}>Security</th>
            <th style={{ width: '30%' }}>View</th>
            <th className="right" style={{ width: '15%' }}>Actions</th>
          </tr></thead>
          <tbody>
            {groups.map((g, i) => (
              <tr key={i}>
                <td><input type="text" value={g.name}
                  onChange={e => update({ v3_groups: groups.map((x, idx) =>
                    idx === i ? { ...x, name: cleanStrict(e.target.value) } : x) })} /></td>
                <td><select className="select" value={g.mode}
                  onChange={e => update({ v3_groups: groups.map((x, idx) =>
                    idx === i ? { ...x, mode: e.target.value as 'ro' | 'rw' } : x) })}>
                  <option value="ro">ro</option><option value="rw">rw</option>
                </select></td>
                <td><select className="select" value={g.sec_level || 'priv'}
                  onChange={e => update({ v3_groups: groups.map((x, idx) =>
                    idx === i ? { ...x, sec_level: e.target.value } : x) })}>
                  <option value="priv">priv</option>
                  <option value="auth">auth</option>
                </select></td>
                <td><select className="select" value={g.view || ''}
                  onChange={e => update({ v3_groups: groups.map((x, idx) =>
                    idx === i ? { ...x, view: e.target.value } : x) })}>
                  <option value="">(pick a view)</option>
                  {views.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
                </select></td>
                <td className="right">
                  <button className="btn btn-danger" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => update({ v3_groups: groups.filter((_, idx) => idx !== i) })}>remove</button>
                </td>
              </tr>
            ))}
            {groups.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 20, color: 'var(--ink-muted)' }}>No groups.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">v3 views <span className="hint">(filter which OIDs are exposed)</span></span>
          <button className="btn" style={{ height: 24, padding: '0 10px', fontSize: 11 }}
            onClick={() => update({ v3_views: [...views, { name: '', oids: ['1'] }] })}>+ view</button>
        </div>
        <table className="tbl">
          <thead><tr>
            <th style={{ width: '30%' }}>Name</th>
            <th style={{ width: '55%' }}>OIDs <span className="hint">(comma-separated)</span></th>
            <th className="right" style={{ width: '15%' }}>Actions</th>
          </tr></thead>
          <tbody>
            {views.map((v, i) => (
              <tr key={i}>
                <td><input type="text" value={v.name}
                  onChange={e => update({ v3_views: views.map((x, idx) =>
                    idx === i ? { ...x, name: cleanStrict(e.target.value) } : x) })} /></td>
                <td><input type="text" value={(v.oids || []).join(', ')}
                  onChange={e => update({ v3_views: views.map((x, idx) =>
                    idx === i ? { ...x, oids: e.target.value.split(/[,\s]+/).filter(Boolean) } : x) })}
                  placeholder="1   (entire tree)    or    1.3.6.1.2.1" /></td>
                <td className="right">
                  <button className="btn btn-danger" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => update({ v3_views: views.filter((_, idx) => idx !== i) })}>remove</button>
                </td>
              </tr>
            ))}
            {views.length === 0 && (
              <tr><td colSpan={3} style={{ padding: 20, color: 'var(--ink-muted)' }}>
                No views. Each group needs one. “1” means the entire OID tree.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

function UserCard({ user, groups, onChange, onRemove }: {
  user: SNMPV3User; groups: SNMPV3Group[];
  onChange: (p: Partial<SNMPV3User>) => void; onRemove: () => void;
}) {
  return (
    <div style={{
      border: '1px solid var(--line)', borderRadius: 6, padding: 12, marginBottom: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="mono" style={{ fontSize: 12, fontWeight: 500 }}>
          {user.name || '(unnamed user)'}
        </span>
        <button className="btn btn-danger" style={{ height: 22, padding: '0 8px', fontSize: 11 }}
          onClick={onRemove}>remove</button>
      </div>
      <div className="row2">
        <div className="field">
          <label>Name <span className="hint">(letters, digits, underscore)</span></label>
          <input type="text" value={user.name}
            onChange={e => onChange({ name: cleanStrict(e.target.value) })}
            placeholder="nwmgmt_ro_only" />
        </div>
        <div className="field"><label>Group</label>
          <select className="select" value={user.group || ''}
            onChange={e => onChange({ group: e.target.value })}>
            <option value="">(pick a group)</option>
            {groups.map(g => <option key={g.name} value={g.name}>{g.name} ({g.mode})</option>)}
          </select>
        </div>
      </div>
      <div className="row2">
        <div className="field"><label>Auth protocol</label>
          <select className="select" value={user.auth_protocol || 'sha'}
            onChange={e => onChange({ auth_protocol: e.target.value })}>
            <option value="sha">SHA (recommended)</option>
            <option value="md5" disabled>MD5 (deprecated — rejected)</option>
          </select>
        </div>
        <div className="field">
          <label>Auth password
            <span className="hint">{user.auth_encrypted ? ' — already configured' : ' (min 8 chars)'}</span>
          </label>
          {user.auth_encrypted && !user.auth_password ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="dim mono" style={{ fontSize: 12 }}>•••••••••• (encrypted on device)</span>
              <button type="button" className="btn"
                style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                onClick={() => onChange({ auth_encrypted: '' })}>rotate</button>
            </div>
          ) : (
            <input type="password" value={user.auth_password || ''}
              onChange={e => onChange({ auth_password: e.target.value })}
              placeholder="enter password (min 8 chars)"
              minLength={8} />
          )}
        </div>
      </div>
      <div className="row2">
        <div className="field"><label>Privacy protocol</label>
          <select className="select" value={user.priv_protocol || 'aes'}
            onChange={e => onChange({ priv_protocol: e.target.value })}>
            <option value="aes">AES (AES-128)</option>
            <option value="des">DES (deprecated)</option>
          </select>
        </div>
        <div className="field">
          <label>Privacy password
            <span className="hint">{user.priv_encrypted ? ' — already configured' : ' (min 8 chars)'}</span>
          </label>
          {user.priv_encrypted && !user.priv_password ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="dim mono" style={{ fontSize: 12 }}>•••••••••• (encrypted on device)</span>
              <button type="button" className="btn"
                style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                onClick={() => onChange({ priv_encrypted: '' })}>rotate</button>
            </div>
          ) : (
            <input type="password" value={user.priv_password || ''}
              onChange={e => onChange({ priv_password: e.target.value })}
              placeholder="enter password (min 8 chars)"
              minLength={8} />
          )}
        </div>
      </div>
      <div className="field"><label>Security level</label>
        <select className="select" value={user.tp_mode || 'priv'}
          onChange={e => onChange({ tp_mode: e.target.value })}>
          <option value="priv">authPriv (recommended)</option>
          <option value="auth">authNoPriv</option>
          <option value="no-auth">noAuthNoPriv (insecure)</option>
        </select>
      </div>
    </div>
  )
}

function TrapsTab({ cfg, update }: { cfg: SNMPConfig; update: (p: Partial<SNMPConfig>) => void }) {
  const traps = cfg.trap_targets || []
  const add = () => update({ trap_targets: [...traps, { address: '', version: 'v3', type: 'trap' }] })
  const edit = (i: number, patch: Partial<SNMPTrapTarget>) => update({
    trap_targets: traps.map((t, idx) => idx === i ? { ...t, ...patch } : t)
  })
  const remove = (i: number) => update({ trap_targets: traps.filter((_, idx) => idx !== i) })

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Trap destinations</span>
        <button className="btn btn-primary" style={{ height: 24, padding: '0 10px', fontSize: 11 }}
          onClick={add}>+ trap target</button>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Address</th><th>Port</th><th>Version</th><th>Type</th><th>Credential</th>
            <th className="right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {traps.map((t, i) => (
            <tr key={i}>
              <td><input type="text" value={t.address}
                onChange={e => edit(i, { address: e.target.value })}
                placeholder="10.0.50.5 or splunk.internal" /></td>
              <td style={{ width: 80 }}><input type="number" value={t.port ?? 162}
                onChange={e => edit(i, { port: parseInt(e.target.value) || 162 })} /></td>
              <td style={{ width: 90 }}>
                <select className="select" value={t.version}
                  onChange={e => edit(i, { version: e.target.value as any })}>
                  <option value="v3">v3</option>
                  <option value="v2c">v2c</option>
                </select>
              </td>
              <td style={{ width: 100 }}>
                <select className="select" value={t.type || 'trap'}
                  onChange={e => edit(i, { type: e.target.value as any })}>
                  <option value="trap">trap</option>
                  <option value="inform">inform</option>
                </select>
              </td>
              <td>
                {t.version === 'v2c'
                  ? <input type="text" value={t.community || ''}
                      onChange={e => edit(i, { community: cleanStrict(e.target.value) })}
                      placeholder="community" />
                  : <input type="text" value={t.v3_user || ''}
                      onChange={e => edit(i, { v3_user: cleanStrict(e.target.value) })}
                      placeholder="v3 user name" />}
              </td>
              <td className="right">
                <button className="btn btn-danger" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                  onClick={() => remove(i)}>remove</button>
              </td>
            </tr>
          ))}
          {traps.length === 0 && (
            <tr><td colSpan={6} style={{ padding: 20, color: 'var(--ink-muted)' }}>
              No trap destinations.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function subTabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '8px 14px', fontSize: 13,
    color: active ? 'var(--brand)' : 'var(--ink-muted)',
    fontWeight: active ? 500 : 400,
    borderBottom: active ? '2px solid var(--brand)' : '2px solid transparent',
    marginBottom: -1,
    background: 'transparent', border: 'none', cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}
function label(t: SnmpTab) {
  return t === 'v2c' ? 'SNMPv2c'
    : t === 'v3' ? 'SNMPv3'
    : t === 'traps' ? 'Trap destinations'
    : 'System info'
}
function badge(t: SnmpTab, c: SNMPConfig) {
  const n = t === 'v2c' ? c.communities?.length
    : t === 'v3' ? (c.v3_users?.length || 0) + (c.v3_groups?.length || 0) + (c.v3_views?.length || 0)
    : t === 'traps' ? c.trap_targets?.length
    : undefined
  if (!n) return null
  return <span style={{
    marginLeft: 6, padding: '1px 6px', borderRadius: 10,
    background: 'var(--brand-soft)', color: 'var(--brand-ink)',
    fontSize: 10, fontFamily: 'var(--font-mono)',
  }}>{n}</span>
}
