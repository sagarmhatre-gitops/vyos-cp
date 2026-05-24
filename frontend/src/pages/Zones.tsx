import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, Zone, ZonePolicy } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'

export function Zones() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [editingZone, setEditingZone] = useState<Zone | null>(null)
  const [editingPolicy, setEditingPolicy] = useState<Partial<ZonePolicy> | null>(null)

  const q = useQuery({
    queryKey: ['zones', id], queryFn: () => api.getZones(id!), enabled: !!id,
  })

  // Fetch both IPv4 and IPv6 rule-sets so the policy modal can autocomplete.
  const rs4 = useQuery({
    queryKey: ['rulesets', id, 'ipv4'],
    queryFn: () => api.listRuleSets(id!, 'ipv4'),
    enabled: !!id, staleTime: 30_000,
  })
  const rs6 = useQuery({
    queryKey: ['rulesets', id, 'ipv6'],
    queryFn: () => api.listRuleSets(id!, 'ipv6'),
    enabled: !!id, staleTime: 30_000,
  })

  const saveZone = useMutation({
    mutationFn: (z: Zone) => api.upsertZone(id!, z),
    onSuccess: () => { setEditingZone(null); qc.invalidateQueries({ queryKey: ['zones', id] }) },
  })
  const savePolicy = useMutation({
    mutationFn: (p: ZonePolicy) => api.setZonePolicy(id!, p),
    onSuccess: () => { setEditingPolicy(null); qc.invalidateQueries({ queryKey: ['zones', id] }) },
  })
  const delZone = useMutation({
    mutationFn: (name: string) => api.deleteZone(id!, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['zones', id] }),
  })

  const zones = q.data?.zones || []
  const policies = q.data?.policies || []

  // Build a zone-to-zone matrix for display.
  const matrix: Record<string, Record<string, ZonePolicy | null>> = {}
  for (const f of zones) {
    matrix[f.name] = {}
    for (const t of zones) {
      if (f.name !== t.name) matrix[f.name][t.name] = null
    }
  }
  for (const p of policies) {
    if (matrix[p.from_zone]) matrix[p.from_zone][p.to_zone] = p
  }

  return (
    <>
      <DeviceHeader />
      {delZone.isError && <div className="err">Delete failed: {(delZone.error as Error).message}</div>}
      {saveZone.isError && <div className="err">Save failed: {(saveZone.error as Error).message}</div>}
      {savePolicy.isError && <div className="err">Policy save failed: {(savePolicy.error as Error).message}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div><h2 style={{ fontSize: 16 }}>Zones &amp; policies</h2>
          <div className="hint">Segment the network into zones and bind rule-sets to traffic between them.</div></div>
        <button className="btn btn-primary" onClick={() => setEditingZone({ name: '' })}>+ New zone</button>
      </div>

      <section className="card" style={{ marginBottom: 14 }}>
        <div className="card-head"><span className="card-title">Zones</span></div>
        <table className="tbl">
          <thead><tr><th>Name</th><th>Interfaces</th><th>Default action</th><th>Local</th><th className="right">Actions</th></tr></thead>
          <tbody>
            {zones.map(z => (
              <tr key={z.name}>
                <td className="mono">{z.name}</td>
                <td className="mono dim">{(z.interfaces || []).join(', ') || '—'}</td>
                <td>{z.default_action ? <span className="badge info">{z.default_action}</span> : '—'}</td>
                <td>{z.local_zone ? 'yes' : ''}</td>
                <td className="right">
                  <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }} onClick={() => setEditingZone(z)}>edit</button>
                  {' '}
                  <button className="btn btn-danger" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => {
                      if (!confirm(`Delete zone "${z.name}"? Its inter-zone policies will also be removed.`)) return
                      delZone.mutate(z.name)
                    }} disabled={delZone.isPending}>delete</button>
                </td>
              </tr>
            ))}
            {zones.length === 0 && <tr><td colSpan={5} style={{ padding: 20, color: 'var(--ink-muted)' }}>No zones.</td></tr>}
          </tbody>
        </table>
      </section>

      {zones.length > 0 && (
        <section className="card">
          <div className="card-head"><span className="card-title">Policy matrix (from → to)</span>
            <span className="card-sub">click a cell to set/change</span></div>
          <div style={{ overflowX: 'auto', padding: 4 }}>
            <table className="tbl" style={{ minWidth: 500 }}>
              <thead>
                <tr><th></th>{zones.map(z => <th key={z.name} className="mono">{z.name}</th>)}</tr>
              </thead>
              <tbody>
                {zones.map(f => (
                  <tr key={f.name}>
                    <td className="mono" style={{ background: 'var(--bg-subtle)' }}>{f.name}</td>
                    {zones.map(t => {
                      if (f.name === t.name) return <td key={t.name} style={{ background: 'var(--bg-subtle)' }}>—</td>
                      const p = matrix[f.name]?.[t.name]
                      return (
                        <td key={t.name} onClick={() => setEditingPolicy({
                          from_zone: f.name, to_zone: t.name, rule_set: p?.rule_set || '', family: 'ipv4',
                        })}>
                          {p ? <span className="mono">{p.rule_set}</span> : <span className="dim">—</span>}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {editingZone && <ZoneModal initial={editingZone} onClose={() => setEditingZone(null)} onSave={saveZone.mutate} saving={saveZone.isPending} />}
      {editingPolicy && <PolicyModal initial={editingPolicy as ZonePolicy}
        rulesets={[...(rs4.data || []), ...(rs6.data || [])]}
        onClose={() => setEditingPolicy(null)} onSave={savePolicy.mutate} saving={savePolicy.isPending} />}
    </>
  )
}

function ZoneModal({ initial, onClose, onSave, saving }: any) {
  const [z, setZ] = useState<Zone>({ ...initial, interfaces: initial.interfaces || [] })
  const [ifaces, setIfaces] = useState((initial.interfaces || []).join(', '))
  const [dirty, setDirty] = useState(false)
  const set = (patch: Partial<Zone>) => { setDirty(true); setZ(x => ({ ...x, ...patch })) }
  const safeClose = () => {
    if (dirty && !confirm('Discard your changes?')) return
    onClose()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') safeClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty])

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h2>{z.name ? `Zone ${z.name}` : 'New zone'}</h2>
          <button className="btn" onClick={safeClose} style={{ background: 'transparent', border: 0 }}>✕</button></div>
        <div className="modal-body">
          <div className="field"><label>Name</label>
            <input type="text" value={z.name} onChange={e => set({ name: e.target.value })} /></div>
          <div className="field"><label>Description</label>
            <input type="text" value={z.description || ''} onChange={e => set({ description: e.target.value })} /></div>
          <div className="field"><label>Interfaces <span className="hint">(comma-separated)</span></label>
            <input type="text" value={ifaces} onChange={e => { setDirty(true); setIfaces(e.target.value) }} placeholder="eth0, eth1" /></div>
          <div className="row2">
            <div className="field"><label>Default action</label>
              <select className="select" value={z.default_action || ''} onChange={e => set({ default_action: e.target.value })}>
                <option value="">(inherit)</option><option value="accept">accept</option>
                <option value="drop">drop</option><option value="reject">reject</option>
              </select></div>
            <div className="field" style={{ alignSelf: 'end' }}>
              <label><input type="checkbox" checked={!!z.local_zone} onChange={e => set({ local_zone: e.target.checked })} /> Local zone</label>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={safeClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => onSave({
            ...z, interfaces: ifaces.split(/[,\s]+/).filter(Boolean),
          })}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}

function PolicyModal({ initial, rulesets, onClose, onSave, saving }: any) {
  const [p, setP] = useState<ZonePolicy>(initial)
  const [dirty, setDirty] = useState(false)
  const set = (patch: Partial<ZonePolicy>) => { setDirty(true); setP({ ...p, ...patch }) }
  const safeClose = () => {
    if (dirty && !confirm('Discard your changes?')) return
    onClose()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') safeClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty])

  // Only show rulesets matching the selected family.
  const candidates = (rulesets || []).filter((rs: any) => rs.family === p.family)

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h2>Policy: {p.from_zone} → {p.to_zone}</h2>
          <button className="btn" onClick={safeClose} style={{ background: 'transparent', border: 0 }}>✕</button></div>
        <div className="modal-body">
          <div className="field"><label>Family</label>
            <select className="select" value={p.family} onChange={e => set({ family: e.target.value })}>
              <option value="ipv4">ipv4</option><option value="ipv6">ipv6</option>
            </select></div>
          <div className="field"><label>Rule-set name</label>
            <input type="text" list="zone-rulesets"
              value={p.rule_set} onChange={e => set({ rule_set: e.target.value })}
              placeholder="pick an existing rule-set" />
            <datalist id="zone-rulesets">
              {candidates.map((rs: any) => (
                <option key={rs.name} value={rs.name}>
                  default={rs.default_action} · {rs.rules?.length ?? 0} rules
                </option>
              ))}
            </datalist></div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={safeClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => onSave(p)}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
