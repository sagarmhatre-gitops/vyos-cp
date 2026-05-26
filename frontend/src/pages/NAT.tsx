import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, NATRule, AddrSpec } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'

// NAT — redesigned overview.
//   KPI tiles + NAT flow diagram + type donut + SNAT/DNAT tables.
//   All real: counts/tables from listNAT (both directions). No sparklines
//   (no rule history), no NAT Statistics (no conntrack collection), no
//   Conflicts tile (no conflict-check engine) — those have no data source
//   and are intentionally omitted rather than faked.

function fmtAddr(a?: AddrSpec): string {
  if (!a) return 'any'
  if (a.address) return a.address + (a.port ? `:${a.port}` : '')
  if (a.port) return `:${a.port}`
  return 'any'
}

export function NAT() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<NATRule | null>(null)

  // Fetch BOTH directions so the overview can show counts + both tables.
  const srcQ = useQuery({
    queryKey: ['nat', id, 'source'],
    queryFn: () => api.listNAT(id!, 'source'),
    enabled: !!id,
  })
  const dstQ = useQuery({
    queryKey: ['nat', id, 'destination'],
    queryFn: () => api.listNAT(id!, 'destination'),
    enabled: !!id,
  })
  const ifacesQ = useQuery({
    queryKey: ['interfaces', id],
    queryFn: () => api.listInterfaces(id!),
    enabled: !!id, staleTime: 30_000,
  })

  const save = useMutation({
    mutationFn: (r: NATRule) => api.upsertNAT(id!, r),
    onSuccess: () => {
      setEditing(null)
      qc.invalidateQueries({ queryKey: ['nat', id, 'source'] })
      qc.invalidateQueries({ queryKey: ['nat', id, 'destination'] })
    },
  })

  const snat = srcQ.data || []
  const dnat = dstQ.data || []
  const total = snat.length + dnat.length
  const pct = (n: number) => total ? Math.round(n / total * 100) : 0

  const nextNum = (rules: NATRule[]) => rules.length ? Math.max(...rules.map(r => r.number)) + 10 : 10

  // distinct source CIDRs from SNAT rules, for the flow diagram's "internal" box
  const internalNets = Array.from(new Set(
    snat.map(r => r.source?.address).filter(Boolean) as string[]
  )).slice(0, 3)

  return (
    <>
      <DeviceHeader />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 16 }}>NAT</h2>
          <div className="hint">Source NAT (outbound masquerade) and Destination NAT (port forwards).</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setEditing({ number: nextNum(snat), direction: 'source' })}>+ SNAT</button>
          <button className="btn btn-primary" onClick={() => setEditing({ number: nextNum(dnat), direction: 'destination' })}>+ DNAT</button>
        </div>
      </div>

      {/* KPI tiles — real counts. No Conflicts tile (no conflict-check engine). */}
      <div className="nat-kpi-row">
        <NatKpi icon="⇄" label="Total NAT Rules" value={String(total)} sub="Across all types" />
        <NatKpi icon="→" label="SNAT Rules" value={String(snat.length)} sub={`${pct(snat.length)}% of total`} accent="brand" />
        <NatKpi icon="⇆" label="DNAT Rules" value={String(dnat.length)} sub={`${pct(dnat.length)}% of total`} accent="muted" />
      </div>

      {/* Flow diagram + type donut */}
      <div className="nat-mid">
        <div className="card">
          <div className="card-head"><div className="card-title">NAT Flow Overview</div></div>
          <div className="nat-flow">
            <div className="nat-node internal">
              <div className="nat-node-title">Internal Networks</div>
              {internalNets.length ? internalNets.map(n => <div key={n} className="mono nat-node-ip">{n}</div>)
                : <div className="mono nat-node-ip dim">private subnets</div>}
            </div>
            <div className="nat-arrow">
              <span className="nat-arrow-count">{snat.length}</span>
              <span className="nat-arrow-line snat">→</span>
              <span className="dim" style={{ fontSize: 10 }}>SNAT</span>
            </div>
            <div className="nat-node gateway">
              <div className="nat-node-title">NAT Gateway</div>
              <div className="mono nat-node-ip dim">this device</div>
            </div>
            <div className="nat-arrow">
              <span className="nat-arrow-count">{dnat.length}</span>
              <span className="nat-arrow-line dnat">→</span>
              <span className="dim" style={{ fontSize: 10 }}>DNAT</span>
            </div>
            <div className="nat-node external">
              <div className="nat-node-title">External / Internet</div>
              <div className="mono nat-node-ip dim">0.0.0.0/0</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">NAT Types</div></div>
          <div className="nat-donut-wrap">
            <NatDonut snat={snat.length} dnat={dnat.length} total={total} />
            <div className="nat-legend">
              <div><span className="lg" style={{ background: 'var(--brand)' }} />Source NAT (SNAT)<b className="mono">{snat.length} ({pct(snat.length)}%)</b></div>
              <div><span className="lg" style={{ background: '#9b6fe6' }} />Destination NAT (DNAT)<b className="mono">{dnat.length} ({pct(dnat.length)}%)</b></div>
            </div>
          </div>
        </div>
      </div>

      {/* SNAT + DNAT tables */}
      <div className="nat-tables">
        <NatTable
          title="SNAT Rules" count={snat.length} kind="snat"
          rules={snat} onEdit={setEditing}
          cols={['Name', 'Source', 'Translated Source', 'Outbound Interface', 'Description']}
          row={r => [
            r.description || `rule-${r.number}`,
            fmtAddr(r.source),
            r.translation_address || 'masquerade',
            r.outbound_interface || '—',
            r.description || '—',
          ]}
        />
        <NatTable
          title="DNAT Rules" count={dnat.length} kind="dnat"
          rules={dnat} onEdit={setEditing}
          cols={['Name', 'External', 'External Port', 'Translated To', 'Inbound Interface']}
          row={r => [
            r.description || `rule-${r.number}`,
            r.destination?.address || '—',
            r.destination?.port || r.translation_port || '—',
            r.translation_address || '—',
            r.inbound_interface || '—',
          ]}
        />
      </div>

      {editing && <NATModal initial={editing} interfaces={ifacesQ.data || []} onClose={() => setEditing(null)} onSave={save.mutate} saving={save.isPending} />}
    </>
  )
}

function NatKpi({ icon, label, value, sub, accent }: {
  icon: string; label: string; value: string; sub?: string; accent?: string
}) {
  return (
    <div className={'nat-kpi' + (accent ? ' ' + accent : '')}>
      <div className="nat-kpi-icon">{icon}</div>
      <div className="nat-kpi-value mono">{value}</div>
      <div className="nat-kpi-label">{label}</div>
      {sub && <div className="nat-kpi-sub">{sub}</div>}
    </div>
  )
}

function NatTable({ title, count, kind, rules, cols, row, onEdit }: {
  title: string; count: number; kind: string; rules: NATRule[]
  cols: string[]; row: (r: NATRule) => string[]; onEdit: (r: NATRule) => void
}) {
  return (
    <div className={'card nat-table ' + kind}>
      <div className="card-head">
        <div className="card-title">{title} <span className="nat-count">{count}</span></div>
      </div>
      <table className="tbl">
        <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}<th className="right">Actions</th></tr></thead>
        <tbody>
          {rules.map(r => (
            <tr key={r.number} onClick={() => onEdit(r)}>
              {row(r).map((cell, i) => (
                <td key={i} className={i === 0 ? 'mono' : 'mono dim'} style={{ fontSize: i === 0 ? 13 : 12 }}>
                  {cell}{i === 0 && r.disable && <span className="badge warn" style={{ marginLeft: 6 }}>off</span>}
                </td>
              ))}
              <td className="right" onClick={e => e.stopPropagation()}>
                <button className="btn" style={{ height: 22, padding: '0 7px', fontSize: 10 }} onClick={() => onEdit(r)}>edit</button>
              </td>
            </tr>
          ))}
          {rules.length === 0 && (
            <tr><td colSpan={cols.length + 1} style={{ padding: 18, color: 'var(--ink-muted)', fontSize: 12 }}>
              No {kind.toUpperCase()} rules.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function NatDonut({ snat, dnat, total }: { snat: number; dnat: number; total: number }) {
  const r = 40, c = 2 * Math.PI * r
  const segs = [
    { n: snat, color: 'var(--brand)' },
    { n: dnat, color: '#9b6fe6' },
  ].filter(s => s.n > 0)
  let offset = 0
  return (
    <svg width={110} height={110} viewBox="0 0 110 110" style={{ flex: 'none' }}>
      <circle cx={55} cy={55} r={r} fill="none" stroke="var(--bg-subtle)" strokeWidth={12} />
      {total > 0 && segs.map((s, i) => {
        const len = (s.n / total) * c
        const el = (
          <circle key={i} cx={55} cy={55} r={r} fill="none" stroke={s.color} strokeWidth={12}
            strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}
            transform="rotate(-90 55 55)" strokeLinecap="butt" />
        )
        offset += len
        return el
      })}
      <text x={55} y={51} textAnchor="middle" fontSize={22} fontWeight={700} fill="var(--ink)" fontFamily="var(--font-mono)">{total}</text>
      <text x={55} y={66} textAnchor="middle" fontSize={9} fill="var(--ink-faint)" textTransform="uppercase">Total</text>
    </svg>
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
