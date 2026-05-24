import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, NATRule } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'

export function NAT() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [dir, setDir] = useState<'source' | 'destination'>('source')
  const [editing, setEditing] = useState<NATRule | null>(null)

  const q = useQuery({
    queryKey: ['nat', id, dir],
    queryFn: () => api.listNAT(id!, dir),
    enabled: !!id,
  })

  // Fetch interfaces so the NAT modal can autocomplete inbound/outbound pickers.
  const ifacesQ = useQuery({
    queryKey: ['interfaces', id],
    queryFn: () => api.listInterfaces(id!),
    enabled: !!id, staleTime: 30_000,
  })

  const save = useMutation({
    mutationFn: (r: NATRule) => api.upsertNAT(id!, r),
    onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: ['nat', id, dir] }) },
  })

  const rules = q.data || []
  const nextNum = rules.length ? Math.max(...rules.map(r => r.number)) + 10 : 10

  return (
    <>
      <DeviceHeader />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div><h2 style={{ fontSize: 16 }}>NAT</h2>
          <div className="hint">Source NAT (outbound masquerade) and Destination NAT (port forwards).</div></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select className="select" value={dir} onChange={e => setDir(e.target.value as any)}>
            <option value="source">source</option><option value="destination">destination</option>
          </select>
          <button className="btn btn-primary" onClick={() => setEditing({ number: nextNum, direction: dir })}>+ Add rule</button>
        </div>
      </div>

      <div className="card">
        <table className="tbl">
          <thead><tr>
            <th style={{ width: 60 }}>#</th><th>Interface</th><th>Source</th>
            <th>Destination</th><th>Translation</th><th className="right">Actions</th>
          </tr></thead>
          <tbody>
            {rules.map(r => (
              <tr key={r.number} onClick={() => setEditing(r)}>
                <td className="mono dim">{r.number}</td>
                <td className="mono dim">{r.direction === 'source' ? (r.outbound_interface || '—') : (r.inbound_interface || '—')}</td>
                <td className="mono">{r.source?.address || '—'}{r.source?.port ? `:${r.source.port}` : ''}</td>
                <td className="mono">{r.destination?.address || '—'}{r.destination?.port ? `:${r.destination.port}` : ''}</td>
                <td className="mono">{r.translation_address || '—'}{r.translation_port ? `:${r.translation_port}` : ''}</td>
                <td className="right"><button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }} onClick={e => { e.stopPropagation(); setEditing(r) }}>edit</button></td>
              </tr>
            ))}
            {rules.length === 0 && <tr><td colSpan={6} style={{ padding: 20, color: 'var(--ink-muted)' }}>No NAT rules.</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && <NATModal initial={editing} interfaces={ifacesQ.data || []} onClose={() => setEditing(null)} onSave={save.mutate} saving={save.isPending} />}
    </>
  )
}

function NATModal({ initial, interfaces, onClose, onSave, saving }: any) {
  const [r, setR] = useState<NATRule>(structuredClone(initial))
  const [dirty, setDirty] = useState(false)
  const set = (patch: Partial<NATRule>) => { setDirty(true); setR(x => ({ ...x, ...patch })) }
  const safeClose = () => {
    if (dirty && !confirm('Discard your changes?')) return
    onClose()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') safeClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty])

  const src = r.source || {}; const dst = r.destination || {}

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h2>NAT rule {r.number} ({r.direction})</h2>
          <button className="btn" onClick={safeClose} style={{ background: 'transparent', border: 0 }}>✕</button></div>
        <div className="modal-body">
          <div className="row2">
            <div className="field"><label>Number</label>
              <input type="text" value={r.number} onChange={e => set({ number: parseInt(e.target.value) || 0 })} /></div>
            <div className="field"><label>Protocol</label>
              <select className="select" value={r.protocol || ''} onChange={e => set({ protocol: e.target.value })}>
                <option value="">(any)</option><option value="tcp">tcp</option><option value="udp">udp</option><option value="all">all</option>
              </select></div>
          </div>
          <div className="field"><label>Description</label>
            <input type="text" value={r.description || ''} onChange={e => set({ description: e.target.value })} /></div>
          <div className="field">
            <label>{r.direction === 'source' ? 'Outbound interface' : 'Inbound interface'}</label>
            <input type="text" list="nat-ifaces"
              value={r.direction === 'source' ? (r.outbound_interface || '') : (r.inbound_interface || '')}
              onChange={e => set({
                [r.direction === 'source' ? 'outbound_interface' : 'inbound_interface']: e.target.value
              } as any)} placeholder="start typing: eth0, eth1, …" />
            <datalist id="nat-ifaces">
              {(interfaces || []).map((i: any) => (
                <option key={`${i.kind}:${i.name}`} value={i.name}>
                  {i.kind}{i.addresses?.length ? ` · ${i.addresses[0]}` : ''}
                </option>
              ))}
            </datalist>
          </div>
          <div className="row2">
            <div className="field"><label>Source address</label>
              <input type="text" value={src.address || ''} onChange={e => set({ source: { ...src, address: e.target.value } })} /></div>
            <div className="field"><label>Source port</label>
              <input type="text" value={src.port || ''} onChange={e => set({ source: { ...src, port: e.target.value } })} /></div>
          </div>
          <div className="row2">
            <div className="field"><label>Destination address</label>
              <input type="text" value={dst.address || ''} onChange={e => set({ destination: { ...dst, address: e.target.value } })} /></div>
            <div className="field"><label>Destination port</label>
              <input type="text" value={dst.port || ''} onChange={e => set({ destination: { ...dst, port: e.target.value } })} /></div>
          </div>
          <div className="row2">
            <div className="field"><label>Translation address</label>
              <input type="text" value={r.translation_address || ''}
                onChange={e => set({ translation_address: e.target.value })}
                placeholder={r.direction === 'source' ? 'masquerade, or 203.0.113.1' : '10.0.0.10'} /></div>
            <div className="field"><label>Translation port</label>
              <input type="text" value={r.translation_port || ''} onChange={e => set({ translation_port: e.target.value })} /></div>
          </div>
          <div style={{ display: 'flex', gap: 16 }}>
            <label><input type="checkbox" checked={!!r.log} onChange={e => set({ log: e.target.checked })} /> Log</label>
            <label><input type="checkbox" checked={!!r.disable} onChange={e => set({ disable: e.target.checked })} /> Disable</label>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={safeClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => onSave(r)}>
            {saving ? 'Committing…' : 'Commit'}
          </button>
        </div>
      </div>
    </div>
  )
}
