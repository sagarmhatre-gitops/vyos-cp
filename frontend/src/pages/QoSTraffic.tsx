import { useQuery } from '@tanstack/react-query'
import { api, TrafficPolicy } from '../lib/api'

// QoSTraffic — LIVE traffic layer for the QoS page. All real data, sourced from
// the existing throughput pipeline (poller -> throughput_samples -> API):
//   • Total Inbound / Outbound (latest sample, bits/s -> Mbps)
//   • Live throughput sparkline (history)
//   • Bandwidth utilization (live tx ÷ configured policy bandwidth)
//   • Interface drops/errors are NOT shown here — per-class queue stats are
//     unreachable via the VyOS /show API (no `show queueing` path), so we do
//     NOT fabricate Queue Health / per-class efficiency.
// Refreshes every 10s to match the poller cadence.

// bits/sec -> human Mbps/Gbps string
function fmtBps(bps: number): { num: string; unit: string } {
  if (bps >= 1e9) return { num: (bps / 1e9).toFixed(1), unit: 'Gbps' }
  if (bps >= 1e6) return { num: (bps / 1e6).toFixed(1), unit: 'Mbps' }
  if (bps >= 1e3) return { num: (bps / 1e3).toFixed(0), unit: 'Kbps' }
  return { num: String(Math.round(bps)), unit: 'bps' }
}

// parse a VyOS bandwidth string ("100mbit", "1gbit", "512kbit") -> bits/sec
function bandwidthToBps(bw?: string): number | null {
  if (!bw) return null
  const m = bw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(g|m|k)?bit$/)
  if (!m) return null
  const n = parseFloat(m[1])
  const mult = m[2] === 'g' ? 1e9 : m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1
  return n * mult
}

const IconDown = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v14M12 18l-5-5M12 18l5-5" />
  </svg>
)
const IconUp = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20V6M12 6l-5 5M12 6l5 5" />
  </svg>
)

// Tiny inline sparkline from a series of values.
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div className="qos-spark-empty">collecting…</div>
  const w = 240, h = 40, max = Math.max(...values, 1), min = Math.min(...values, 0)
  const span = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - ((v - min) / span) * (h - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg className="qos-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// Utilization gauge — semicircle, live tx ÷ configured bandwidth.
function UtilGauge({ pct }: { pct: number }) {
  const clamped = Math.min(100, Math.max(0, pct))
  const r = 46, c = Math.PI * r // half circumference
  const dash = (clamped / 100) * c
  const color = clamped >= 85 ? 'var(--danger)' : clamped >= 60 ? 'var(--warn-ink, #F5C977)' : 'var(--ok)'
  return (
    <svg width={120} height={72} viewBox="0 0 120 72">
      <path d="M 12 64 A 46 46 0 0 1 108 64" fill="none" stroke="var(--bg-subtle)" strokeWidth={10} strokeLinecap="round" />
      <path d="M 12 64 A 46 46 0 0 1 108 64" fill="none" stroke={color} strokeWidth={10} strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`} />
      <text x={60} y={56} textAnchor="middle" fontSize={20} fontWeight={700} fill="var(--ink)" fontFamily="var(--font-mono)">{clamped.toFixed(0)}%</text>
    </svg>
  )
}

export function QoSTraffic({ deviceId, policies }: { deviceId: string; policies: TrafficPolicy[] }) {
  // Live ring-buffer samples (last ~10 min), refreshing at poll cadence.
  const liveQ = useQuery({
    queryKey: ['qos-throughput', deviceId],
    queryFn: () => api.deviceThroughput(deviceId),
    enabled: !!deviceId,
    refetchInterval: 10_000,
  })
  // History for the sparkline (24h).
  const histQ = useQuery({
    queryKey: ['qos-throughput-hist', deviceId],
    queryFn: () => api.deviceThroughputHistory(deviceId, 24),
    enabled: !!deviceId,
    refetchInterval: 60_000,
  })

  const samples = liveQ.data || []
  const latest = samples.length ? samples[samples.length - 1] : null
  const rxBps = latest?.total.rx_bps ?? 0
  const txBps = latest?.total.tx_bps ?? 0
  const rxIn = fmtBps(rxBps)
  const txOut = fmtBps(txBps)

  // sparkline series from live ring buffer (rx + tx)
  const rxSeries = samples.map(s => s.total.rx_bps)
  const txSeries = samples.map(s => s.total.tx_bps)

  // utilization vs the configured policy bandwidth (use the first policy with a bandwidth)
  const bwBps = policies.map(p => bandwidthToBps(p.bandwidth)).find(b => b != null) || null
  const utilPct = bwBps ? (txBps / bwBps) * 100 : null

  const loading = liveQ.isLoading
  const noData = !loading && samples.length === 0

  return (
    <div className="qos-traffic-row">
      <div className="qos-tile in">
        <div className="qos-tile-head"><span className="qos-tile-icon in"><IconDown /></span>Total Inbound</div>
        <div className="qos-tile-value mono">{rxIn.num}<small>{rxIn.unit}</small></div>
        <div className="qos-tile-pps mono">{Math.round((latest?.total.rx_pps ?? 0)).toLocaleString()} pps</div>
        <Sparkline values={rxSeries} color="var(--brand)" />
      </div>

      <div className="qos-tile out">
        <div className="qos-tile-head"><span className="qos-tile-icon out"><IconUp /></span>Total Outbound</div>
        <div className="qos-tile-value mono">{txOut.num}<small>{txOut.unit}</small></div>
        <div className="qos-tile-pps mono">{Math.round((latest?.total.tx_pps ?? 0)).toLocaleString()} pps</div>
        <Sparkline values={txSeries} color="var(--ok)" />
      </div>

      <div className="qos-tile util">
        <div className="qos-tile-head">Bandwidth Utilization</div>
        {utilPct != null ? (
          <>
            <UtilGauge pct={utilPct} />
            <div className="qos-tile-sub mono">
              {fmtBps(txBps).num} {fmtBps(txBps).unit} of {policies.find(p => bandwidthToBps(p.bandwidth))?.bandwidth}
            </div>
          </>
        ) : (
          <div className="qos-tile-sub dim" style={{ paddingTop: 18 }}>
            No configured bandwidth to measure against.
          </div>
        )}
      </div>

      {(loading || noData) && (
        <div className="qos-traffic-status dim">
          {loading ? 'Loading live throughput…' : 'No throughput samples yet — the poller collects every 10s.'}
        </div>
      )}
    </div>
  )
}
