import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, Rule } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'
import { useLiveCounters, fmtCount, fmtBytes } from '../hooks/useLive'

export function RuleSetEditor() {
  const { id, family, name } = useParams<{ id: string; family: string; name: string }>()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Rule | null>(null)
  const [showNew, setShowNew] = useState(false)

  const counters = useLiveCounters(id)

  const rsQ = useQuery({
    queryKey: ['ruleset', id, family, name],
    queryFn: () => api.getRuleSet(id!, family!, name!),
    enabled: !!id && !!family && !!name,
  })

  // Fetch groups once so the rule builder can autocomplete group references.
  const groupsQ = useQuery({
    queryKey: ['groups', id],
    queryFn: () => api.listGroups(id!),
    enabled: !!id,
    staleTime: 30_000,
  })

  const upsert = useMutation({
    mutationFn: (rule: Rule) => api.upsertRule(id!, family!, name!, rule),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ruleset', id, family, name] })
      setEditing(null); setShowNew(false)
    },
  })

  const del = useMutation({
    mutationFn: (n: number) => api.deleteRule(id!, family!, name!, n),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ruleset', id, family, name] }),
  })

  const rules = rsQ.data?.rules || []
  const nextNumber = useMemo(() => {
    if (rules.length === 0) return 10
    return Math.max(...rules.map(r => r.number)) + 10
  }, [rules])

  return (
    <>
      <DeviceHeader />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 16 }} className="mono">{name}</h2>
          <div className="hint">
            {family} · default <span className="mono">{rsQ.data?.default_action || '—'}</span>
            {' '}· {rules.length} rule{rules.length === 1 ? '' : 's'}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ Add rule</button>
      </div>

      {rsQ.isError && <div className="err">Failed to load rule-set: {(rsQ.error as Error).message}</div>}
      {upsert.isError && <div className="err">Save failed: {(upsert.error as Error).message}</div>}

      <div className="card">
        <table className="tbl">
          <thead>
            <tr><th style={{ width: 60 }}>#</th><th style={{ width: 80 }}>Action</th><th>Match</th><th>Flags</th><th className="right">Actions</th></tr>
          </thead>
          <tbody>
            {rules.map(r => (
              <tr key={r.number} onClick={() => setEditing(r)}>
                <td className="mono dim">{r.number}</td>
                <td><ActionBadge action={r.action} /></td>
                <td className="mono" style={{ fontSize: 12 }}>{summariseMatch(r)}</td>
                <td>{flagBadges(r)}</td>
                <td className="right" onClick={e => e.stopPropagation()}>
                  <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }} onClick={() => setEditing(r)}>edit</button>
                  {' '}
                  <button className="btn btn-danger" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => confirm(`Delete rule ${r.number}?`) && del.mutate(r.number)}>
                    delete
                  </button>
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 20, color: 'var(--ink-muted)' }}>
                No rules yet. Click “+ Add rule”.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(editing || showNew) && (
        <RuleModal
          initial={editing || { number: nextNumber, action: 'accept' }}
          groups={groupsQ.data || []}
          onClose={() => { setEditing(null); setShowNew(false) }}
          onSave={(r) => upsert.mutate(r)}
          saving={upsert.isPending}
        />
      )}
    </>
  )
}

function ActionBadge({ action }: { action: string }) {
  const cls = action === 'accept' ? 'ok' :
              action === 'drop' || action === 'reject' ? 'danger' :
              action === 'jump' ? 'info' : 'warn'
  return <span className={`badge ${cls}`}>{action}</span>
}

function summariseMatch(r: Rule) {
  const parts: string[] = []
  if (r.protocol) parts.push(r.protocol)
  if (r.source?.address) parts.push(`src ${r.source.address}`)
  if (r.source?.port) parts.push(`sport ${r.source.port}`)
  if (r.source?.group?.address_group) parts.push(`src <${r.source.group.address_group}>`)
  if (r.destination?.address) parts.push(`dst ${r.destination.address}`)
  if (r.destination?.port) parts.push(`dport ${r.destination.port}`)
  if (r.destination?.group?.address_group) parts.push(`dst <${r.destination.group.address_group}>`)
  if (r.state) {
    const s = []
    if (r.state.established) s.push('est')
    if (r.state.related) s.push('rel')
    if (r.state.new) s.push('new')
    if (r.state.invalid) s.push('inv')
    if (s.length) parts.push(`state ${s.join(',')}`)
  }
  if (r.source_countries?.length) parts.push(`src geo ${r.source_countries.join(',')}`)
  if (r.destination_countries?.length) parts.push(`dst geo ${r.destination_countries.join(',')}`)
  return parts.join(' · ') || '—'
}

function flagBadges(r: Rule) {
  return (
    <>
      {r.log && <span className="badge info" style={{ marginRight: 4 }}>log</span>}
      {r.disable && <span className="badge warn" style={{ marginRight: 4 }}>disabled</span>}
    </>
  )
}

// --- Rule builder modal ---------------------------------------------------

export function RuleModal({ initial, groups, onClose, onSave, saving }: {
  initial: Rule; groups: Array<{ name: string; type: string; family?: string; members: string[] }>;
  onClose: () => void;
  onSave: (r: Rule) => void; saving: boolean;
}) {
  const [r, setR] = useState<Rule>(structuredClone(initial))
  const [dirty, setDirty] = useState(false)
  const update = (patch: Partial<Rule>) => { setDirty(true); setR(x => ({ ...x, ...patch })) }
  const updateSrc = (patch: any) => { setDirty(true); setR(x => ({ ...x, source: { ...(x.source || {}), ...patch } })) }
  const updateDst = (patch: any) => { setDirty(true); setR(x => ({ ...x, destination: { ...(x.destination || {}), ...patch } })) }
  const updateState = (patch: any) => { setDirty(true); setR(x => ({ ...x, state: { ...(x.state || {}), ...patch } })) }

  const safeClose = () => {
    if (dirty && !confirm('Discard your changes?')) return
    onClose()
  }

  // Escape key closes (with dirty prompt).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') safeClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty])

  // Filter groups by type for each picker. address-group fits IP rules;
  // network-group also works in source/destination; port-group fits ports.
  const addrGroups = groups.filter(g => g.type === 'address-group' || g.type === 'network-group')
  const portGroups = groups.filter(g => g.type === 'port-group')

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Rule {r.number}</h2>
          <button className="btn" type="button" onClick={safeClose} style={{ background: 'transparent', border: 0 }}>✕</button>
        </div>
        <div className="modal-body">
          <div className="row2">
            <div className="field">
              <label>Number</label>
              <input type="text" value={r.number}
                onChange={e => update({ number: parseInt(e.target.value) || 0 })} />
            </div>
            <div className="field">
              <label>Action</label>
              <select className="select" value={r.action} onChange={e => update({ action: e.target.value })}>
                <option value="accept">accept</option>
                <option value="drop">drop</option>
                <option value="reject">reject</option>
                <option value="jump">jump</option>
                <option value="return">return</option>
              </select>
            </div>
          </div>

          {r.action === 'jump' && (
            <div className="field">
              <label>Jump target</label>
              <input type="text" value={r.jump_target || ''}
                onChange={e => update({ jump_target: e.target.value })} placeholder="RULESET-NAME" />
            </div>
          )}

          <div className="field">
            <label>Description</label>
            <input type="text" value={r.description || ''}
              onChange={e => update({ description: e.target.value })} />
          </div>

          <div className="row2">
            <div className="field">
              <label>Protocol</label>
              <select className="select" value={r.protocol || ''} onChange={e => update({ protocol: e.target.value })}>
                <option value="">(any)</option>
                <option value="tcp">tcp</option>
                <option value="udp">udp</option>
                <option value="icmp">icmp</option>
                <option value="tcp_udp">tcp_udp</option>
                <option value="all">all</option>
              </select>
            </div>
            <div className="field" style={{ display: 'flex', alignItems: 'end', gap: 16 }}>
              <label><input type="checkbox" checked={!!r.log} onChange={e => update({ log: e.target.checked })} /> Log</label>
              <label><input type="checkbox" checked={!!r.disable} onChange={e => update({ disable: e.target.checked })} /> Disable</label>
            </div>
          </div>

          <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--ink-muted)', marginTop: 10, letterSpacing: '0.05em' }}>Source</h3>
          <div className="row2">
            <div className="field"><label>Address / CIDR</label>
              <input type="text" value={r.source?.address || ''} onChange={e => updateSrc({ address: e.target.value })} /></div>
            <div className="field"><label>Port</label>
              <input type="text" value={r.source?.port || ''} onChange={e => updateSrc({ port: e.target.value })} placeholder="443, 80,443, 1000-2000" /></div>
          </div>
          <div className="field"><label>Address-group reference</label>
            <input type="text" list="rule-addr-groups"
              value={r.source?.group?.address_group || ''}
              onChange={e => updateSrc({ group: { ...(r.source?.group || {}), address_group: e.target.value } })}
              placeholder="start typing to see existing groups" /></div>
          <div className="field"><label>GeoIP country codes <span className="hint">(comma-separated)</span></label>
            <input type="text"
              value={(r.source_countries || []).join(',')}
              onChange={e => update({ source_countries: e.target.value.split(/[,\s]+/).map(s => s.trim()).filter(Boolean) })}
              placeholder="CN, RU, KP" /></div>

          <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--ink-muted)', marginTop: 10, letterSpacing: '0.05em' }}>Destination</h3>
          <div className="row2">
            <div className="field"><label>Address / CIDR</label>
              <input type="text" value={r.destination?.address || ''} onChange={e => updateDst({ address: e.target.value })} /></div>
            <div className="field"><label>Port</label>
              <input type="text" value={r.destination?.port || ''} onChange={e => updateDst({ port: e.target.value })} /></div>
          </div>
          <div className="field"><label>Address-group reference</label>
            <input type="text" list="rule-addr-groups"
              value={r.destination?.group?.address_group || ''}
              onChange={e => updateDst({ group: { ...(r.destination?.group || {}), address_group: e.target.value } })}
              placeholder="start typing to see existing groups" /></div>

          <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--ink-muted)', marginTop: 10, letterSpacing: '0.05em' }}>Connection state</h3>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {(['established','related','new','invalid'] as const).map(k => (
              <label key={k}>
                <input type="checkbox"
                  checked={!!r.state?.[k]}
                  onChange={e => updateState({ [k]: e.target.checked })} /> {k}
              </label>
            ))}
          </div>

          <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--ink-muted)', marginTop: 14, letterSpacing: '0.05em' }}>Preview</h3>
          <div className="diff">
            {previewOps(r).map((op, i) => (
              <div key={i} className={op.op === 'delete' ? 'del' : 'add'}>
                {op.op === 'delete' ? '− ' : '+ '}
                {op.op} firewall ... rule {r.number} {op.path.slice(5).join(' ')}{op.value ? ` ${JSON.stringify(op.value)}` : ''}
              </div>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" type="button" onClick={safeClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} type="button" onClick={() => onSave(r)}>
            {saving ? 'Committing…' : 'Commit'}
          </button>
        </div>
        <datalist id="rule-addr-groups">
          {addrGroups.map(g => (
            <option key={`${g.type}:${g.name}`} value={g.name}>
              {g.type} · {g.members.length} members
            </option>
          ))}
        </datalist>
        <datalist id="rule-port-groups">
          {portGroups.map(g => (
            <option key={g.name} value={g.name}>
              {g.members.length} members
            </option>
          ))}
        </datalist>
      </div>
    </div>
  )
}

// Mirrors the server-side translator to show a diff. Not perfect — server is
// the source of truth — but gives the user visibility before commit.
function previewOps(r: Rule): Array<{ op: string; path: string[]; value?: string }> {
  const base = ['firewall', 'ipv4', 'name', 'RULESET', 'rule', String(r.number)]
  const out: Array<{ op: string; path: string[]; value?: string }> = []
  out.push({ op: 'delete', path: base })
  out.push({ op: 'set', path: [...base, 'action'], value: r.action })
  if (r.description) out.push({ op: 'set', path: [...base, 'description'], value: r.description })
  if (r.protocol) out.push({ op: 'set', path: [...base, 'protocol'], value: r.protocol })
  if (r.log) out.push({ op: 'set', path: [...base, 'log'] })
  if (r.disable) out.push({ op: 'set', path: [...base, 'disable'] })
  if (r.source?.address) out.push({ op: 'set', path: [...base, 'source', 'address'], value: r.source.address })
  if (r.source?.port) out.push({ op: 'set', path: [...base, 'source', 'port'], value: r.source.port })
  if (r.source?.group?.address_group) out.push({ op: 'set', path: [...base, 'source', 'group', 'address-group'], value: r.source.group.address_group })
  if (r.destination?.address) out.push({ op: 'set', path: [...base, 'destination', 'address'], value: r.destination.address })
  if (r.destination?.port) out.push({ op: 'set', path: [...base, 'destination', 'port'], value: r.destination.port })
  if (r.destination?.group?.address_group) out.push({ op: 'set', path: [...base, 'destination', 'group', 'address-group'], value: r.destination.group.address_group })
  for (const cc of r.source_countries || []) out.push({ op: 'set', path: [...base, 'source', 'geoip', 'country-code'], value: cc })
  for (const cc of r.destination_countries || []) out.push({ op: 'set', path: [...base, 'destination', 'geoip', 'country-code'], value: cc })
  if (r.state?.established) out.push({ op: 'set', path: [...base, 'state', 'established'] })
  if (r.state?.related) out.push({ op: 'set', path: [...base, 'state', 'related'] })
  if (r.state?.new) out.push({ op: 'set', path: [...base, 'state', 'new'] })
  if (r.state?.invalid) out.push({ op: 'set', path: [...base, 'state', 'invalid'] })
  return out
}
