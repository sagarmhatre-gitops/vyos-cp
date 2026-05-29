import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import {
  api,
  SNMPConfig, SNMPCommunity, SNMPV3User, SNMPV3Group, SNMPV3View, SNMPTrapTarget,
} from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'

type Modal =
  | { type: 'community';    item: SNMPCommunity  | null }
  | { type: 'user';         item: SNMPV3User      | null }
  | { type: 'group';        item: SNMPV3Group     | null }
  | { type: 'view';         item: SNMPV3View      | null }
  | { type: 'trap';         item: SNMPTrapTarget  | null }
  | { type: 'deleteAll' }

export function SNMP() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [modal, setModal] = useState<Modal | null>(null)

  // Section refs — "View all" links scroll to these
  const refCommunities = useRef<HTMLDivElement>(null)
  const refUsers       = useRef<HTMLDivElement>(null)
  const refHosts       = useRef<HTMLDivElement>(null)
  const refViews       = useRef<HTMLDivElement>(null)
  const refEvents      = useRef<HTMLDivElement>(null)
  const scrollTo = (ref: React.RefObject<HTMLDivElement>) =>
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  const q = useQuery({
    queryKey: ['snmp', id],
    queryFn: () => api.getSNMPConfig(id!),
    enabled: !!id,
  })

  const save = useMutation({
    mutationFn: (cfg: SNMPConfig) => api.upsertSNMPConfig(id!, cfg),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['snmp', id] })
      setModal(null)
    },
  })

  const deleteAll = useMutation({
    mutationFn: () => api.deleteSNMPConfig(id!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['snmp', id] }),
  })

  const cfg: SNMPConfig = q.data ?? {}
  const communities     = cfg.communities  ?? []
  const v3users         = cfg.v3_users     ?? []
  const v3groups        = cfg.v3_groups    ?? []
  const v3views         = cfg.v3_views     ?? []
  const traps           = cfg.trap_targets ?? []

  const updatedAt = q.dataUpdatedAt
    ? new Date(q.dataUpdatedAt).toLocaleTimeString() : null

  // Patch helpers — replace/add/remove one item then POST full config
  function saveCommunity(item: SNMPCommunity, orig: SNMPCommunity | null) {
    const list = orig
      ? communities.map(c => c.name === orig.name ? item : c)
      : [...communities, item]
    save.mutate({ ...cfg, communities: list })
  }
  function deleteCommunity(name: string) {
    save.mutate({ ...cfg, communities: communities.filter(c => c.name !== name) })
  }

  function saveUser(item: SNMPV3User, orig: SNMPV3User | null) {
    const list = orig
      ? v3users.map(u => u.name === orig.name ? item : u)
      : [...v3users, item]
    save.mutate({ ...cfg, v3_users: list })
  }
  function deleteUser(name: string) {
    save.mutate({ ...cfg, v3_users: v3users.filter(u => u.name !== name) })
  }

  function saveView(item: SNMPV3View, orig: SNMPV3View | null) {
    const list = orig
      ? v3views.map(v => v.name === orig.name ? item : v)
      : [...v3views, item]
    save.mutate({ ...cfg, v3_views: list })
  }
  function deleteView(name: string) {
    save.mutate({ ...cfg, v3_views: v3views.filter(v => v.name !== name) })
  }

  function saveTrap(item: SNMPTrapTarget, orig: SNMPTrapTarget | null) {
    const list = orig
      ? traps.map(t => t.address === orig.address ? item : t)
      : [...traps, item]
    save.mutate({ ...cfg, trap_targets: list })
  }
  function deleteTrap(address: string) {
    save.mutate({ ...cfg, trap_targets: traps.filter(t => t.address !== address) })
  }

  return (
    <>
      <DeviceHeader />

      {/* ── Page header ──────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <h2 style={{ fontSize: 16, marginBottom: 4 }}>SNMP</h2>
          <div className="hint">v2c communities, v3 users/groups/views, and trap destinations.</div>
          {updatedAt && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--ok)' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', display: 'inline-block', flexShrink: 0 }} />
                In sync · fetched {updatedAt}
              </span>
              <button className="btn" style={{ height: 24, fontSize: 11, padding: '0 10px' }}
                onClick={() => q.refetch()} disabled={q.isFetching}>↺ refetch</button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-danger" style={{ fontSize: 12 }}
            onClick={() => setModal({ type: 'deleteAll' })}>Delete all</button>
          <button className="btn btn-primary" style={{ fontSize: 12 }}
            onClick={() => setModal({ type: 'community', item: null })}>+ Add community / user</button>
        </div>
      </div>

      {/* ── Metric cards ────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 14 }}>
        {/* Each card is also a clickable shortcut to its section */}
        <MetricCard icon={<IconGrid />}    value={communities.length} label="SNMP Communities" sub="Configured"
          color="#185FA5" bg="#E6F1FB" onClick={() => scrollTo(refCommunities)} />
        <MetricCard icon={<IconUsers />}   value={v3users.length}     label="SNMP Users"       sub="Configured"
          color="#1D9E75" bg="#E1F5EE" onClick={() => scrollTo(refUsers)} />
        <MetricCard icon={<IconMonitor />} value={traps.length}       label="SNMP Hosts"       sub="Allowed"
          color="#7B3FBF" bg="#F3E8FF" onClick={() => scrollTo(refHosts)} />
        <MetricCard icon={<IconBell />}    value="0"                  label="Auth Failures"    sub="Last 24h"
          color="#BA7517" bg="#FBF0DB" onClick={() => scrollTo(refEvents)} />
        <MetricCard icon={<IconShield />}  value={v3users.length > 0 ? 'v3' : 'v2c'} label="SNMPv3"
          sub={v3users.length > 0 ? 'Enabled' : 'Disabled'}
          color="#0F6E56" bg="#E1F5EE" onClick={() => scrollTo(refUsers)} />
      </div>

      {/* ── Engine + Traffic ─────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: 12, marginBottom: 14 }}>
        <div className="card">
          <div className="card-head">
            <span className="card-title">SNMP Engine</span>
            <span className="card-sub">Engine ID and uptime information</span>
          </div>
          <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>Engine ID</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--bg-subtle)', padding: '4px 8px', borderRadius: 4, border: '1px solid var(--line)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {cfg.engine_id || <span style={{ color: 'var(--ink-faint)', fontStyle: 'italic' }}>auto-generated</span>}
                </code>
                {cfg.engine_id && (
                  <button className="btn" style={{ height: 26, padding: '0 8px', fontSize: 11, flexShrink: 0 }}
                    onClick={() => navigator.clipboard.writeText(cfg.engine_id!)} title="Copy">⎘</button>
                )}
              </div>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>SNMP Status</div>
              <span className="badge ok">Enabled</span>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>Engine Boots</div>
              <div style={{ fontSize: 13 }}>—</div>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>SNMP Versions</div>
              <div style={{ display: 'flex', gap: 5 }}>
                {communities.length > 0 && <span className="badge info" style={{ fontSize: 10 }}>v1</span>}
                {communities.length > 0 && <span className="badge info" style={{ fontSize: 10 }}>v2c</span>}
                {v3users.length > 0 && <span className="badge ok" style={{ fontSize: 10 }}>v3</span>}
                {communities.length === 0 && v3users.length === 0 && <span className="dim">—</span>}
              </div>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>Listen port</div>
              <div className="mono" style={{ fontSize: 13 }}>{cfg.listen_port || 161}</div>
            </div>
            <div>
              <div className="dim" style={{ fontSize: 11, marginBottom: 4 }}>Engine Time</div>
              <div style={{ fontSize: 13 }}>—</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">SNMP Traffic</span>
            <span className="card-sub">Last 5 minutes</span>
          </div>
          <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'center' }}>
            <div>
              <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 11 }}>
                {[['#185FA5','Queries'],['#1D9E75','Responses'],['#BA7517','Errors']].map(([c,l]) => (
                  <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 24, height: 2, background: c, display: 'inline-block', borderRadius: 1 }} />
                    <span className="dim">{l}</span>
                  </span>
                ))}
              </div>
              <div style={{ height: 90, background: 'var(--bg-subtle)', borderRadius: 6, border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="dim" style={{ fontSize: 11 }}>Live data requires /snmp/status endpoint</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 120 }}>
              {[['Total Queries','—','var(--ink)'],['Total Responses','—','var(--ink)'],['Errors','—','var(--danger)']].map(([l,v,c]) => (
                <div key={l}>
                  <div className="dim" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{l}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: c }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Three-column tables ───────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>

        {/* Communities */}
        <div className="card" ref={refCommunities} style={{ scrollMarginTop: 16 }}>
          <div className="card-head">
            <span className="card-title">SNMP Communities <span className="badge" style={{ marginLeft: 6 }}>{communities.length}</span></span>
            <button className="btn" style={{ height: 26, fontSize: 11, padding: '0 10px' }}
              onClick={() => setModal({ type: 'community', item: null })}>+ Add</button>
          </div>
          <table className="tbl">
            <thead><tr>
              <th>Community</th><th>Access</th><th>View</th><th>Version</th><th className="right">Actions</th>
            </tr></thead>
            <tbody>
              {communities.length === 0 && <tr><td colSpan={5}><Empty /></td></tr>}
              {communities.map((c, i) => (
                <tr key={i}>
                  <td className="mono" style={{ fontSize: 12 }}>{c.name}</td>
                  <td><span className={`badge ${c.authorization === 'ro' ? 'info' : 'warn'}`} style={{ fontSize: 10 }}>{c.authorization || 'ro'}</span></td>
                  <td style={{ fontSize: 12 }}>default</td>
                  <td className="dim" style={{ fontSize: 11 }}>v1, v2c</td>
                  <td className="right">
                    <RowBtns onEdit={() => setModal({ type: 'community', item: c })} onDelete={() => deleteCommunity(c.name)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* "View all" scrolls to the full communities section below */}
          <ViewAll label="View all communities" onClick={() => scrollTo(refCommunities)} />
        </div>

        {/* V3 Users */}
        <div className="card" ref={refUsers} style={{ scrollMarginTop: 16 }}>
          <div className="card-head">
            <span className="card-title">SNMP Users (v3) <span className="badge" style={{ marginLeft: 6 }}>{v3users.length}</span></span>
            <button className="btn" style={{ height: 26, fontSize: 11, padding: '0 10px' }}
              onClick={() => setModal({ type: 'user', item: null })}>+ Add</button>
          </div>
          <table className="tbl">
            <thead><tr>
              <th>User</th><th>Security</th><th>Auth Protocol</th><th>Priv Protocol</th><th className="right">Actions</th>
            </tr></thead>
            <tbody>
              {v3users.length === 0 && <tr><td colSpan={5}><Empty /></td></tr>}
              {v3users.map((u, i) => {
                const sec = u.auth_protocol ? (u.priv_protocol ? 'authPriv' : 'authNoPriv') : 'noAuthNoPriv'
                return (
                  <tr key={i}>
                    <td className="mono" style={{ fontSize: 12 }}>{u.name}</td>
                    <td><span className={`badge ${sec === 'authPriv' ? 'ok' : 'info'}`} style={{ fontSize: 9 }}>{sec}</span></td>
                    <td style={{ fontSize: 12 }}>{u.auth_protocol || '—'}</td>
                    <td style={{ fontSize: 12 }}>{u.priv_protocol || '—'}</td>
                    <td className="right">
                      <RowBtns onEdit={() => setModal({ type: 'user', item: u })} onDelete={() => deleteUser(u.name)} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <ViewAll label="View all users" onClick={() => scrollTo(refUsers)} />
        </div>

        {/* Trap targets / Allowed Hosts */}
        <div className="card" ref={refHosts} style={{ scrollMarginTop: 16 }}>
          <div className="card-head">
            <span className="card-title">Allowed Hosts <span className="badge" style={{ marginLeft: 6 }}>{traps.length}</span></span>
            <button className="btn" style={{ height: 26, fontSize: 11, padding: '0 10px' }}
              onClick={() => setModal({ type: 'trap', item: null })}>+ Add</button>
          </div>
          <table className="tbl">
            <thead><tr>
              <th>Host / Network</th><th>Version</th><th>Type</th><th className="right">Actions</th>
            </tr></thead>
            <tbody>
              {traps.length === 0 && <tr><td colSpan={4}><Empty /></td></tr>}
              {traps.map((t, i) => (
                <tr key={i}>
                  <td className="mono" style={{ fontSize: 12 }}>{t.address}</td>
                  <td><span className="badge" style={{ fontSize: 10 }}>{t.version}</span></td>
                  <td style={{ fontSize: 12 }}>{t.address?.includes('/') ? 'Network' : 'Host'}</td>
                  <td className="right">
                    <RowBtns onEdit={() => setModal({ type: 'trap', item: t })} onDelete={() => deleteTrap(t.address)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ViewAll label="View all allowed hosts" onClick={() => scrollTo(refHosts)} />
        </div>
      </div>

      {/* ── Views + Events ───────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

        <div className="card" ref={refViews} style={{ scrollMarginTop: 16 }}>
          <div className="card-head">
            <span className="card-title">SNMP Views <span className="badge" style={{ marginLeft: 6 }}>{v3views.length}</span></span>
            <button className="btn" style={{ height: 26, fontSize: 11, padding: '0 10px' }}
              onClick={() => setModal({ type: 'view', item: null })}>+ Add view</button>
          </div>
          <table className="tbl">
            <thead><tr>
              <th>View name</th><th>OID subtree</th><th>Type</th><th>Description</th><th className="right">Actions</th>
            </tr></thead>
            <tbody>
              {v3views.length === 0 && <tr><td colSpan={5}><Empty /></td></tr>}
              {v3views.map((v, i) => (
                <tr key={i}>
                  <td style={{ fontSize: 12 }}>{v.name}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{v.oids?.join(', ') || '1.3.6.1'}</td>
                  <td><span className={`badge ${v.exclude ? 'danger' : 'ok'}`} style={{ fontSize: 9 }}>{v.exclude ? 'excluded' : 'included'}</span></td>
                  <td className="dim" style={{ fontSize: 11 }}>
                    {v.name === 'default' ? 'Full access to all standard MIBs'
                      : v.name === 'restricted' ? 'System information and interfaces only' : '—'}
                  </td>
                  <td className="right">
                    <RowBtns onEdit={() => setModal({ type: 'view', item: v })} onDelete={() => deleteView(v.name)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ViewAll label="View all views" onClick={() => scrollTo(refViews)} />
        </div>

        <div className="card" ref={refEvents} style={{ scrollMarginTop: 16 }}>
          <div className="card-head">
            <span className="card-title">Recent SNMP Events</span>
            <button className="btn" style={{ height: 26, fontSize: 11, padding: '0 10px', background: 'transparent', border: 'none', color: 'var(--brand)', cursor: 'pointer' }}
              onClick={() => scrollTo(refEvents)}>View all →</button>
          </div>
          <table className="tbl">
            <thead><tr><th>Time</th><th>Event</th><th>Source</th><th>Details</th></tr></thead>
            <tbody><tr><td colSpan={4}><Empty text="No events — backend /snmp/events endpoint not yet implemented" /></td></tr></tbody>
          </table>
        </div>
      </div>

      {/* ── Modals ─────────────────────────────────── */}
      {modal?.type === 'community' && (
        <CommunityModal item={modal.item} saving={save.isPending} onSave={saveCommunity} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'user' && (
        <UserModal item={modal.item} saving={save.isPending} onSave={saveUser} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'view' && (
        <ViewModal item={modal.item} saving={save.isPending} onSave={saveView} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'trap' && (
        <TrapModal item={modal.item} saving={save.isPending} onSave={saveTrap} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'deleteAll' && (
        <ConfirmModal
          title="Delete all SNMP configuration?"
          body="This will remove all communities, users, views, and trap targets from the device. This cannot be undone."
          danger saving={deleteAll.isPending}
          onConfirm={() => deleteAll.mutate()} onClose={() => setModal(null)}
        />
      )}
    </>
  )
}

// ─── Community modal ──────────────────────────────────────────
function CommunityModal({ item, saving, onSave, onClose }: {
  item: SNMPCommunity | null; saving: boolean
  onSave: (c: SNMPCommunity, orig: SNMPCommunity | null) => void; onClose: () => void
}) {
  const [name, setName]       = useState(item?.name ?? '')
  const [auth, setAuth]       = useState<'ro'|'rw'>(item?.authorization ?? 'ro')
  const [networks, setNets]   = useState((item?.network ?? []).join('\n'))

  return (
    <Backdrop onClose={onClose}>
      <div className="modal-head"><strong>{item ? 'Edit community' : 'Add community'}</strong><button className="btn" onClick={onClose}>✕</button></div>
      <div className="modal-body">
        <Field label="Community name">
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="public" disabled={!!item} />
        </Field>
        <Field label="Access">
          <select value={auth} onChange={e => setAuth(e.target.value as 'ro'|'rw')}
            style={{ width: '100%', height: 32, padding: '0 10px', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius)', fontSize: 13, background: 'var(--bg)' }}>
            <option value="ro">ro — read-only</option>
            <option value="rw">rw — read-write</option>
          </select>
        </Field>
        <Field label="Allowed networks (one per line, blank = any)">
          <textarea value={networks} onChange={e => setNets(e.target.value)} placeholder={"192.168.1.0/24\n10.0.0.0/8"} rows={3} />
        </Field>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!name || saving}
          onClick={() => onSave({ name, authorization: auth, network: networks.split('\n').map(s=>s.trim()).filter(Boolean) }, item)}>
          {saving ? 'Saving…' : item ? 'Save changes' : 'Add community'}
        </button>
      </div>
    </Backdrop>
  )
}

// ─── V3 User modal ────────────────────────────────────────────
function UserModal({ item, saving, onSave, onClose }: {
  item: SNMPV3User | null; saving: boolean
  onSave: (u: SNMPV3User, orig: SNMPV3User | null) => void; onClose: () => void
}) {
  const [name, setName]       = useState(item?.name ?? '')
  const [group, setGroup]     = useState(item?.group ?? '')
  const [authProto, setAuthP] = useState(item?.auth_protocol ?? '')
  const [authPass, setAuthPw] = useState('')
  const [privProto, setPrivP] = useState(item?.priv_protocol ?? '')
  const [privPass, setPrivPw] = useState('')

  return (
    <Backdrop onClose={onClose}>
      <div className="modal-head"><strong>{item ? 'Edit v3 user' : 'Add v3 user'}</strong><button className="btn" onClick={onClose}>✕</button></div>
      <div className="modal-body">
        <div className="row2">
          <Field label="Username"><input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="snmp-admin" disabled={!!item} /></Field>
          <Field label="Group (optional)"><input type="text" value={group} onChange={e => setGroup(e.target.value)} placeholder="snmp-ro" /></Field>
        </div>
        <div className="row2">
          <Field label="Auth protocol">
            <select value={authProto} onChange={e => setAuthP(e.target.value)}
              style={{ width: '100%', height: 32, padding: '0 10px', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius)', fontSize: 13, background: 'var(--bg)' }}>
              <option value="">None</option>
              <option>MD5</option><option>SHA</option><option>SHA-224</option><option>SHA-256</option><option>SHA-384</option><option>SHA-512</option>
            </select>
          </Field>
          <Field label="Auth password"><input type="password" value={authPass} onChange={e => setAuthPw(e.target.value)} placeholder={item ? '(unchanged)' : 'min 8 chars'} disabled={!authProto} /></Field>
        </div>
        <div className="row2">
          <Field label="Privacy protocol">
            <select value={privProto} onChange={e => setPrivP(e.target.value)} disabled={!authProto}
              style={{ width: '100%', height: 32, padding: '0 10px', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius)', fontSize: 13, background: 'var(--bg)' }}>
              <option value="">None</option>
              <option>DES</option><option>AES</option><option>AES-128</option><option>AES-192</option><option>AES-256</option>
            </select>
          </Field>
          <Field label="Privacy password"><input type="password" value={privPass} onChange={e => setPrivPw(e.target.value)} placeholder={item ? '(unchanged)' : 'min 8 chars'} disabled={!privProto} /></Field>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!name || saving} onClick={() => onSave({
          name, group: group || undefined,
          auth_protocol: authProto || undefined, auth_password: authPass || undefined,
          priv_protocol: privProto || undefined, priv_password: privPass || undefined,
        }, item)}>
          {saving ? 'Saving…' : item ? 'Save changes' : 'Add user'}
        </button>
      </div>
    </Backdrop>
  )
}

// ─── View modal ───────────────────────────────────────────────
function ViewModal({ item, saving, onSave, onClose }: {
  item: SNMPV3View | null; saving: boolean
  onSave: (v: SNMPV3View, orig: SNMPV3View | null) => void; onClose: () => void
}) {
  const [name, setName] = useState(item?.name ?? '')
  const [oids, setOids] = useState((item?.oids ?? ['1.3.6.1']).join('\n'))
  const [excl, setExcl] = useState(item?.exclude ?? false)

  return (
    <Backdrop onClose={onClose}>
      <div className="modal-head"><strong>{item ? 'Edit view' : 'Add view'}</strong><button className="btn" onClick={onClose}>✕</button></div>
      <div className="modal-body">
        <Field label="View name"><input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="default" disabled={!!item} /></Field>
        <Field label="OID subtrees (one per line)"><textarea value={oids} onChange={e => setOids(e.target.value)} placeholder={"1.3.6.1\n1.3.6.1.2.1.1"} rows={3} /></Field>
        <Field label="Type">
          <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
            {(['included','excluded'] as const).map(v => (
              <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input type="radio" checked={excl === (v === 'excluded')} onChange={() => setExcl(v === 'excluded')} />
                {v}
              </label>
            ))}
          </div>
        </Field>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!name || saving}
          onClick={() => onSave({ name, oids: oids.split('\n').map(s=>s.trim()).filter(Boolean), exclude: excl }, item)}>
          {saving ? 'Saving…' : item ? 'Save changes' : 'Add view'}
        </button>
      </div>
    </Backdrop>
  )
}

// ─── Trap modal ───────────────────────────────────────────────
function TrapModal({ item, saving, onSave, onClose }: {
  item: SNMPTrapTarget | null; saving: boolean
  onSave: (t: SNMPTrapTarget, orig: SNMPTrapTarget | null) => void; onClose: () => void
}) {
  const [addr, setAddr]     = useState(item?.address ?? '')
  const [port, setPort]     = useState(String(item?.port ?? 162))
  const [ver, setVer]       = useState<'v2c'|'v3'>(item?.version ?? 'v2c')
  const [community, setCom] = useState(item?.community ?? '')
  const [v3user, setV3u]    = useState(item?.v3_user ?? '')

  return (
    <Backdrop onClose={onClose}>
      <div className="modal-head"><strong>{item ? 'Edit trap destination' : 'Add trap destination'}</strong><button className="btn" onClick={onClose}>✕</button></div>
      <div className="modal-body">
        <div className="row2">
          <Field label="Address"><input type="text" value={addr} onChange={e => setAddr(e.target.value)} placeholder="192.168.1.100" disabled={!!item} /></Field>
          <Field label="Port"><input type="text" value={port} onChange={e => setPort(e.target.value)} placeholder="162" /></Field>
        </div>
        <Field label="Version">
          <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
            {(['v2c','v3'] as const).map(v => (
              <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input type="radio" checked={ver === v} onChange={() => setVer(v)} />{v}
              </label>
            ))}
          </div>
        </Field>
        {ver === 'v2c' && <Field label="Community"><input type="text" value={community} onChange={e => setCom(e.target.value)} placeholder="public" /></Field>}
        {ver === 'v3'  && <Field label="v3 username"><input type="text" value={v3user} onChange={e => setV3u(e.target.value)} placeholder="snmp-admin" /></Field>}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!addr || saving}
          onClick={() => onSave({ address: addr, port: Number(port) || 162, version: ver,
            community: ver === 'v2c' ? community : undefined,
            v3_user: ver === 'v3' ? v3user : undefined }, item)}>
          {saving ? 'Saving…' : item ? 'Save changes' : 'Add destination'}
        </button>
      </div>
    </Backdrop>
  )
}

// ─── Confirm modal ────────────────────────────────────────────
function ConfirmModal({ title, body, danger, saving, onConfirm, onClose }: {
  title: string; body: string; danger?: boolean; saving: boolean; onConfirm: () => void; onClose: () => void
}) {
  return (
    <Backdrop onClose={onClose}>
      <div className="modal-head"><strong>{title}</strong></div>
      <div className="modal-body"><p style={{ margin: 0, fontSize: 13 }}>{body}</p></div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={saving} onClick={onConfirm}>
          {saving ? 'Deleting…' : 'Yes, delete all'}
        </button>
      </div>
    </Backdrop>
  )
}

// ─── Shared pieces ────────────────────────────────────────────
function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="field"><label>{label}</label>{children}</div>
}

function Empty({ text = 'None configured' }: { text?: string }) {
  return <div style={{ padding: '16px 14px', textAlign: 'center', color: 'var(--ink-muted)', fontSize: 12 }}>{text}</div>
}

// "View all" now accepts an onClick — scrolls to the relevant section
function ViewAll({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div style={{ padding: '8px 14px', borderTop: '1px solid var(--line)' }}>
      <button
        onClick={onClick}
        style={{ background: 'none', border: 'none', padding: 0, fontSize: 12, color: 'var(--brand)', cursor: 'pointer', fontFamily: 'inherit' }}
      >
        {label} →
      </button>
    </div>
  )
}

function RowBtns({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 12 }}
        onClick={e => { e.stopPropagation(); onEdit() }}>✏</button>
      <button className="btn btn-danger" style={{ height: 24, padding: '0 8px', fontSize: 12 }}
        onClick={e => { e.stopPropagation(); if (confirm('Delete this item?')) onDelete() }}>✕</button>
    </span>
  )
}

// ─── Metric card ─────────────────────────────────────────────
function MetricCard({ icon, value, label, sub, color, bg, onClick }: {
  icon: React.ReactNode; value: number | string; label: string; sub: string
  color: string; bg: string; onClick?: () => void
}) {
  return (
    <div className="card" style={{ padding: 0, cursor: onClick ? 'pointer' : 'default' }} onClick={onClick}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px' }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color }}>
          {icon}
        </div>
        <div>
          <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.1, fontFamily: 'var(--font-mono)' }}>{value}</div>
          <div style={{ fontSize: 13, fontWeight: 500, marginTop: 2 }}>{label}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 1 }}>{sub}</div>
        </div>
      </div>
    </div>
  )
}

// ─── Icons ────────────────────────────────────────────────────
function IconGrid()    { return <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> }
function IconUsers()   { return <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a6 6 0 0 1 12 0v2"/><path d="M17 11a3 3 0 1 1 0-6"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg> }
function IconMonitor() { return <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg> }
function IconBell()    { return <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg> }
function IconShield()  { return <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg> }
