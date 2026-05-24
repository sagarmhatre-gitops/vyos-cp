import { Interface, ThroughputSample } from '../lib/api'
import { Sparkline, fmtBps } from '../components/Sparkline'

// InterfacesView — presentational redesign of the Interfaces tab.
// Pure: receives data from the page, owns no fetching. Every value shown is
// real (interface inventory + live throughput). No fabricated tiles.

type Rate = { rx_bps: number; tx_bps: number }

function modeOf(vals: string[]): string {
  const c: Record<string, number> = {}
  let best = '', bestN = 0
  for (const v of vals) { if (!v) continue; c[v] = (c[v] || 0) + 1; if (c[v] > bestN) { bestN = c[v]; best = v } }
  return best || '—'
}

export function InterfacesView({
  ifaces, samples, latest, onEdit,
}: {
  ifaces: Interface[]
  samples: ThroughputSample[]
  latest: Record<string, Rate>
  onEdit: (i: Interface) => void
}) {
  const byKind = ifaces.reduce<Record<string, Interface[]>>((acc, i) => {
    (acc[i.kind] = acc[i.kind] || []).push(i); return acc
  }, {})
  const kinds = Object.keys(byKind).sort()

  // --- real aggregates ---
  // NOTE: model.Interface.link_state is NOT populated by the backend parser
  // (it parses admin/link booleans into a different struct that never reaches
  // the frontend). So link_state is always empty here. We derive state from the
  // signals that ARE real: disabled flag, assigned address, and live traffic.
  //   disabled            -> 'idle' (admin-down)
  //   address or traffic  -> 'up'
  //   otherwise           -> 'down'
  const ifaceState = (i: Interface): 'up' | 'down' | 'idle' => {
    if (i.disabled) return 'idle'
    const r = latest[i.name]
    const hasTraffic = !!r && (r.rx_bps > 0 || r.tx_bps > 0)
    const hasAddr = !!i.addresses && i.addresses.length > 0
    if (hasTraffic || hasAddr) return 'up'
    return 'down'
  }

  const upCount = ifaces.filter(i => ifaceState(i) === 'up').length
  const downCount = ifaces.filter(i => ifaceState(i) === 'down').length
  const idleCount = ifaces.filter(i => ifaceState(i) === 'idle').length
  const totalRx = ifaces.reduce((s, i) => s + (latest[i.name]?.rx_bps || 0), 0)
  const totalTx = ifaces.reduce((s, i) => s + (latest[i.name]?.tx_bps || 0), 0)
  const defaultMTU = modeOf(ifaces.map(i => i.mtu || ''))

  // top interface by total traffic (real insight)
  let topName = '', topRate = 0
  for (const i of ifaces) {
    const r = (latest[i.name]?.rx_bps || 0) + (latest[i.name]?.tx_bps || 0)
    if (r > topRate) { topRate = r; topName = i.name }
  }
  const totalAll = totalRx + totalTx
  const topPct = totalAll > 0 ? Math.round((topRate / totalAll) * 100) : 0

  const seriesByIface = (name: string) =>
    samples.map(s => (s.per[name]?.rx_bps || 0) + (s.per[name]?.tx_bps || 0))

  const inOutRatio = totalAll > 0 ? Math.round((totalRx / totalAll) * 100) : 0

  return (
    <div className="if-layout">
      <div className="if-main">
        {/* KPI tiles — all real */}
        <div className="kpi-row">
          <Kpi icon="▦" label="Total Interfaces" value={String(ifaces.length)} sub={`Across ${kinds.length} types`} />
          <Kpi icon="◉" label="Active Interfaces" value={String(upCount)}
               sub={`${ifaces.length ? Math.round((upCount / ifaces.length) * 100) : 0}% of total`} accent="ok" series={[]} />
          <Kpi icon="↓" label="Total Throughput In" value={fmtBps(totalRx)} accent="ok"
               series={samples.map(s => s.total?.rx_bps || 0)} />
          <Kpi icon="↑" label="Total Throughput Out" value={fmtBps(totalTx)} accent="brand"
               series={samples.map(s => s.total?.tx_bps || 0)} />
          <Kpi icon="◯" label="Default MTU" value={defaultMTU} sub="Most common" accent="muted" />
        </div>

        {/* Interface cards grouped by kind */}
        {kinds.map(kind => (
          <section key={kind} className="if-group">
            <div className="if-group-head">
              <span className="if-group-name">{kind}</span>
              <span className="if-group-count">{byKind[kind].length}</span>
            </div>
            <div className="if-cards">
              {byKind[kind].map(iface => {
                const rate = latest[iface.name]
                const series = seriesByIface(iface.name)
                const st = ifaceState(iface)
                const up = st === 'up'
                return (
                  <div key={iface.name} className={'if-card' + (up ? ' up' : '')} onClick={() => onEdit(iface)}>
                    <div className="if-card-top">
                      <span className="if-name mono">{iface.name}</span>
                      <span className={'if-state ' + st}>
                        <span className={'live-dot ' + (up ? 'up' : 'down')} /> {st.toUpperCase()}
                      </span>
                    </div>
                    <div className="if-addr mono">
                      {iface.addresses?.length ? iface.addresses[0] : <span className="dim">—</span>}
                    </div>
                    <div className="if-meta">
                      <span className="if-mtu mono">MTU {iface.mtu || '—'}</span>
                      {iface.vrf && <span className="if-vrf mono">VRF {iface.vrf}</span>}
                    </div>
                    <div className="if-spark">
                      {rate ? <Sparkline values={series} width={150} height={34} variant="area" />
                            : <span className="dim" style={{ fontSize: 11 }}>{samples.length === 0 ? 'collecting…' : 'idle'}</span>}
                    </div>
                    <div className="if-rates mono">
                      <span className="rx">↓ {rate ? fmtBps(rate.rx_bps) : '0 bps'}</span>
                      <span className="tx">↑ {rate ? fmtBps(rate.tx_bps) : '0 bps'}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {/* Right sidebar — real telemetry */}
      <aside className="if-side">
        <div className="side-card">
          <div className="side-title">Throughput Overview</div>
          <div className="donut-wrap">
            {(() => {
              const parts = fmtBps(totalAll).split(' ')
              return <Donut pct={inOutRatio} centerValue={parts[0]} centerUnit={parts[1] || 'bps'} />
            })()}
            <div className="donut-legend">
              <div><span className="lg ok" />Inbound<br/><b className="mono">↓ {fmtBps(totalRx)}</b></div>
              <div><span className="lg brand" />Outbound<br/><b className="mono">↑ {fmtBps(totalTx)}</b></div>
            </div>
          </div>
          {topName && (
            <div className="side-foot">
              Top interface by traffic
              <div className="top-iface"><span className="mono">{topName}</span><span className="mono dim">{fmtBps(topRate)}</span></div>
            </div>
          )}
        </div>

        <div className="side-card">
          <div className="side-title">Interface Health</div>
          <HealthRow color="var(--ok)" n={upCount} label="Up" total={ifaces.length} />
          <HealthRow color="var(--danger)" n={downCount} label="Down" total={ifaces.length} />
          <HealthRow color="var(--brand)" n={idleCount} label="Idle" total={ifaces.length} />
        </div>

        <div className="side-card">
          <div className="side-title">Quick Insights</div>
          {topName ? (
            <div className="insight"><span className="ic ok">↗</span>{topName} is carrying {topPct}% of total traffic</div>
          ) : (
            <div className="insight"><span className="ic">·</span>No live traffic on any interface yet</div>
          )}
          <div className="insight"><span className="ic ok">✓</span>{upCount} of {ifaces.length} interfaces up</div>
        </div>
      </aside>
    </div>
  )
}

function Kpi({ icon, label, value, sub, accent, series }: {
  icon: string; label: string; value: string; sub?: string
  accent?: 'ok' | 'brand' | 'muted'; series?: number[]
}) {
  return (
    <div className={'kpi' + (accent ? ' ' + accent : '')}>
      <div className="kpi-icon">{icon}</div>
      <div className="kpi-body">
        <div className="kpi-value mono">{value}</div>
        <div className="kpi-label">{label}</div>
        {sub && <div className="kpi-sub">{sub}</div>}
        {series && series.length > 1 &&
          <div className="kpi-spark"><Sparkline values={series} width={120} height={22} variant="line"
            color={accent === 'brand' ? 'var(--brand)' : 'var(--ok)'} /></div>}
      </div>
    </div>
  )
}

function Donut({ pct, centerValue, centerUnit }: { pct: number; centerValue: string; centerUnit: string }) {
  // viewBox 120, center 60, radius 44, stroke 9 -> inner hole diameter ~70px.
  // Center text must fit inside that hole, so value sits on its own line in a
  // smaller size and the unit goes beneath it. The track is the full ring;
  // the inbound arc is drawn on top, oriented from 12 o'clock via rotate(-90).
  const r = 44, c = 2 * Math.PI * r
  const inLen = Math.max(0, Math.min(100, pct)) / 100 * c
  return (
    <svg width={104} height={104} viewBox="0 0 120 120" style={{ flex: 'none' }}>
      {/* full track = outbound/base */}
      <circle cx={60} cy={60} r={r} fill="none" stroke="var(--brand)" strokeWidth={9} opacity={0.3} />
      {/* inbound arc on top */}
      <circle cx={60} cy={60} r={r} fill="none" stroke="var(--ok)" strokeWidth={9}
        strokeDasharray={`${inLen} ${c - inLen}`} strokeLinecap="round"
        transform="rotate(-90 60 60)"
        style={{ filter: 'drop-shadow(0 0 5px rgba(43,224,166,0.45))' }} />
      {/* center text — sized to fit the hole, two lines */}
      <text x={60} y={58} textAnchor="middle" fontSize={15} fontWeight={600}
        fill="var(--ink)" fontFamily="var(--font-mono)">{centerValue}</text>
      <text x={60} y={74} textAnchor="middle" fontSize={9}
        fill="var(--ink-muted)">{centerUnit}</text>
    </svg>
  )
}

function HealthRow({ color, n, label, total }: { color: string; n: number; label: string; total: number }) {
  const pct = total > 0 ? (n / total) * 100 : 0
  return (
    <div className="health-row">
      <span className="health-dot" style={{ background: color }} />
      <span className="health-n mono">{n}</span>
      <span className="health-label">{label}</span>
      <span className="health-bar"><span style={{ width: `${pct}%`, background: color }} /></span>
    </div>
  )
}
