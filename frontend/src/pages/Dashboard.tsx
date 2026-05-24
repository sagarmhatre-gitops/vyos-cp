import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, connectWS, WsEvent, Device, AuditEntry } from '../lib/api'
import { useFleetThroughput } from '../hooks/useLive'
import { Sparkline, fmtBps } from '../components/Sparkline'
import { DeviceMap } from '../components/DeviceMap'
import { FleetHealthDonut } from '../components/FleetHealthDonut'
import { FleetFilterBar, FleetFilter, emptyFilter, applyFleetFilter } from '../components/FleetFilterBar'

type WindowChoice = '10m' | '1h' | '24h'

export function Dashboard() {
  // Poll devices every 15s so the throughput column stays fresh even without
  // WebSocket activity. 15s matches the backend minute-bucket cadence closely.
  const devicesQ = useQuery({
    queryKey: ['devices'], queryFn: () => api.listDevices(),
    refetchInterval: 15_000,
  })
  const auditQ = useQuery({ queryKey: ['audit'], queryFn: () => api.listAudit('', 10) })

  // Fleet health rollup — drives the donut + the new alert tiles. Refetch
  // every 30s; this is server-aggregated so it's cheap.
  const healthQ = useQuery({
    queryKey: ['fleet-health'], queryFn: () => api.getFleetHealth(),
    refetchInterval: 30_000,
  })

  // Client-side filters applied to the device table. Persisted only in
  // local component state — no URL sync (would clutter; Dashboard is rarely
  // deep-linked with filters).
  const [filter, setFilter] = useState<FleetFilter>(emptyFilter)

  const [liveStatus, setLiveStatus] = useState<Record<string, string>>({})
  useEffect(() => {
    return connectWS((e: WsEvent) => {
      if (e.kind === 'status' && e.status) {
        setLiveStatus(s => ({ ...s, [e.device_id]: e.status! }))
      }
    })
  }, [])

  const [windowChoice, setWindowChoice] = useState<WindowChoice>('10m')
  const fleet = useFleetThroughput()

  // Short-window history from in-memory WebSocket feed (10s cadence).
  const [liveHistory, setLiveHistory] = useState<{ rx: number; tx: number }[]>([])
  useEffect(() => {
    setLiveHistory(h => {
      const last = h[h.length - 1]
      if (last && last.rx === fleet.rx_bps && last.tx === fleet.tx_bps) return h
      const next = [...h, { rx: fleet.rx_bps, tx: fleet.tx_bps }]
      return next.length > 60 ? next.slice(-60) : next
    })
  }, [fleet.rx_bps, fleet.tx_bps])

  // Long-window history from Postgres. Only fetched when the toggle is on 1h/24h.
  const longQ = useQuery({
    queryKey: ['fleet-throughput-history', windowChoice],
    queryFn: () => api.fleetThroughputHistory(windowChoice === '1h' ? 1 : 24),
    enabled: windowChoice !== '10m',
    refetchInterval: 60_000,
  })
  const longHistory = (longQ.data || []).map(r => ({ rx: r.rx_bps, tx: r.tx_bps }))
  const history = windowChoice === '10m' ? liveHistory : longHistory

  const devices = devicesQ.data || []
  const online = devices.filter(d => (liveStatus[d.id] ?? d.status) === 'online').length
  const offline = devices.length - online

  // Apply the dashboard filters to the device table only — the alert tiles,
  // health donut, and map continue to show fleet-wide totals regardless of
  // filter, because filtering those would mislead.
  const visibleDevices = useMemo(
    () => applyFleetFilter(devices, filter),
    [devices, filter])

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 18 }}>Fleet overview</h1>
          <div className="hint">{devices.length} device{devices.length === 1 ? '' : 's'}</div>
        </div>
        <Link to="/devices" className="btn btn-primary">Manage devices</Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 14 }}>
        <Metric label="Devices" value={String(devices.length)} sub={`${online} online · ${offline} offline`} />
        <Metric label="Online" value={String(online)} sub="healthy" subClass="ok" />
        <Metric label="Offline" value={String(offline)} sub={offline ? 'needs attention' : 'all good'} subClass={offline ? 'danger' : 'ok'} />
        <Metric label="Critical"
          value={healthQ.data ? String(healthQ.data.critical) : '—'}
          sub={healthQ.data && healthQ.data.critical > 0 ? 'devices offline' : 'all reachable'}
          subClass={healthQ.data && healthQ.data.critical > 0 ? 'danger' : 'ok'} />
        <Metric label="Warning"
          value={healthQ.data ? String(healthQ.data.warning) : '—'}
          sub={healthQ.data && healthQ.data.warning > 0 ? 'high CPU or mem' : 'within thresholds'}
          subClass={healthQ.data && healthQ.data.warning > 0 ? 'warn' : 'ok'} />
        <Metric label="VyOS versions" value={[...new Set(devices.map(d => major(d.version)))].filter(Boolean).join(' · ') || '—'} sub="in fleet" />
      </div>

      <section className="card" style={{ marginBottom: 14, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Fleet throughput
            </div>
            <div style={{ display: 'flex', gap: 24, marginTop: 6 }}>
              <div>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>↓ ingress</div>
                <div style={{ fontSize: 20, fontWeight: 500, fontFamily: 'var(--font-mono)', color: 'var(--ok)' }}>
                  {fmtBps(fleet.rx_bps)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>↑ egress</div>
                <div style={{ fontSize: 20, fontWeight: 500, fontFamily: 'var(--font-mono)', color: 'var(--brand)' }}>
                  {fmtBps(fleet.tx_bps)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>packets/sec</div>
                <div style={{ fontSize: 14, fontFamily: 'var(--font-mono)', color: 'var(--ink-muted)', marginTop: 6 }}>
                  {fleet.rx_pps.toLocaleString()} in · {fleet.tx_pps.toLocaleString()} out
                </div>
              </div>
            </div>
          </div>
          <div>
            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', marginBottom: 6 }}>
              {(['10m', '1h', '24h'] as WindowChoice[]).map(w => (
                <button key={w} onClick={() => setWindowChoice(w)}
                  style={{
                    fontSize: 11, padding: '2px 10px', cursor: 'pointer',
                    border: '1px solid var(--line-strong)', borderRadius: 4,
                    background: windowChoice === w ? 'var(--brand)' : 'transparent',
                    color: windowChoice === w ? '#fff' : 'var(--ink-muted)',
                    borderColor: windowChoice === w ? 'var(--brand)' : 'var(--line-strong)',
                  }}>
                  {w}
                </button>
              ))}
            </div>
            <Sparkline values={history.map(h => h.rx + h.tx)} width={240} height={44} />
          </div>
        </div>
      </section>

      {/* Fleet shape row: health donut, top-talkers placeholder, geographic
          map. Three roughly equal columns. The placeholder is honest about
          what's not yet implemented — better than rendering fake data to
          fill space, and gives the user a clear pointer to what's coming. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(280px, 1fr) minmax(280px, 1fr) minmax(280px, 1fr)',
        gap: 14, marginBottom: 14, alignItems: 'start',
      }}>
        {healthQ.data ? (
          <FleetHealthDonut data={healthQ.data} />
        ) : (
          <div className="card">
            <div className="card-head"><span className="card-title">Fleet health</span></div>
            <div style={{ padding: 14, color: 'var(--ink-muted)', fontSize: 12 }}>Loading…</div>
          </div>
        )}

        <div className="card">
          <div className="card-head">
            <span className="card-title">Top talkers</span>
            <span className="dim" style={{ fontSize: 11 }}>not yet implemented</span>
          </div>
          <div style={{ padding: 14, color: 'var(--ink-muted)', fontSize: 12, lineHeight: 1.6 }}>
            Per-flow visibility (top sources, destinations, applications) needs
            a NetFlow or sFlow exporter on each VyOS device plus a collector
            in the control plane. Tracked on the roadmap.
          </div>
        </div>

        <DeviceMap devices={devices} compact />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', gap: 14 }}>
        <section className="card">
          <div className="card-head">
            <span className="card-title">Devices</span>
            <Link to="/devices">Manage →</Link>
          </div>
          {devices.length === 0 ? (
            <div style={{ padding: 20, color: 'var(--ink-muted)' }}>
              No devices yet. <Link to="/devices">Add one →</Link>
            </div>
          ) : (
            <div style={{ padding: '10px 12px 0' }}>
              <FleetFilterBar filter={filter} onChange={setFilter} devices={devices} />
            </div>
          )}
          {devices.length > 0 && (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Device</th><th>Status</th><th>Version</th>
                  <th className="right">Throughput</th>
                  <th className="right">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {visibleDevices.map(d => {
                  const status = liveStatus[d.id] ?? d.status
                  const tp = d.throughput
                  return (
                    <tr key={d.id}>
                      <td className="mono">
                        <Link to={`/devices/${d.id}`}>{d.name}</Link>
                      </td>
                      <td>
                        <span className={`status ${status}`}><span className="d"/>{status}</span>
                      </td>
                      <td className="mono dim">{d.version || '—'}</td>
                      <td className="right mono" style={{ fontSize: 12, lineHeight: 1.3 }}>
                        {tp ? (
                          <>
                            <div style={{ color: 'var(--ok)' }}>↓ {fmtBps(tp.rx_bps)}</div>
                            <div style={{ color: 'var(--brand)' }}>↑ {fmtBps(tp.tx_bps)}</div>
                          </>
                        ) : <span className="dim">—</span>}
                      </td>
                      <td className="right dim mono">{lastSeen(d.last_seen)}</td>
                    </tr>
                  )
                })}
                {visibleDevices.length === 0 && (
                  <tr><td colSpan={5} style={{
                    padding: 20, color: 'var(--ink-muted)', fontSize: 12, textAlign: 'center',
                  }}>
                    No devices match the current filters.
                  </td></tr>
                )}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <span className="card-title">Recent changes</span>
            <Link to="/audit">Audit log →</Link>
          </div>
          <div style={{ padding: 10, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {(auditQ.data || []).map(e => (
              <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 4px' }}>
                <span>
                  <span className="dim">{fmtTime(e.timestamp)}</span>{' '}
                  {e.user_name || 'system'} · {e.action}
                </span>
                <span className={e.success ? 'status online' : 'status offline'}>
                  <span className="d"/>{e.success ? 'ok' : 'failed'}
                </span>
              </div>
            ))}
            {(!auditQ.data || auditQ.data.length === 0) && <div className="dim" style={{ padding: 8 }}>No activity yet.</div>}
          </div>
        </section>
      </div>
    </>
  )
}

function Metric({ label, value, sub, subClass }: { label: string; value: string; sub?: string; subClass?: string }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div style={{ fontSize: 10.5, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, marginTop: 4, fontFamily: 'var(--font-mono)' }}>{value}</div>
      {sub && <div className={`badge ${subClass || ''}`} style={{ marginTop: 6, background: 'transparent', color: 'var(--ink-muted)', padding: 0 }}>{sub}</div>}
    </div>
  )
}

function major(v?: string) { return v ? v.split('-')[0].split('.').slice(0, 2).join('.') : '' }
function lastSeen(t?: string) {
  if (!t) return '—'
  const d = new Date(t)
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return d.toLocaleDateString()
}
function fmtTime(t: string) {
  const d = new Date(t)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
