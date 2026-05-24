// Device overview page.
//
// Path A refresh — visual polish on the data we already have, plus the
// IPsec tunnel-health KPI. What's explicitly not here: WAN latency
// probes, BGP/OSPF neighbor scrapers, NetFlow top talkers, firewall
// drop counters, threshold alerts. Each of those needs its own backend
// scraper and was scoped out of v1.
//
// Layout, top to bottom:
//   - Refresh control bar: "Last updated 10:32:45 AM • [5m]"
//   - 6-tile KPI row: Health · Throughput · Sessions · CPU · Memory · IPsec
//   - Interface Status (table)
//   - IPsec / VPN Status (per-peer card)
//   - Identity strip (uptime + system version)
//   - Activity row: Recent config changes · Configuration · Quick actions
//   - Diagnostics (collapsed)
//
// Health Score (KPI tile #1) is computed client-side from existing inputs.
// See computeHealthScore() for the formula. Operators can hover the tile
// for the breakdown.

import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useState, useMemo } from 'react'
import { api, Interface } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'
import { Sparkline } from '../components/Sparkline'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { QuickActions } from '../components/QuickActions'
import { useLiveThroughput, fmtBytes, fmtCount } from '../hooks/useLive'

type RefreshChoice = '15s' | '1m' | '5m' | 'off'
const REFRESH_MS: Record<RefreshChoice, number | false> = {
  '15s': 15_000, '1m': 60_000, '5m': 300_000, 'off': false,
}

export function Overview() {
  const { id } = useParams<{ id: string }>()
  const [refresh, setRefresh] = useState<RefreshChoice>('15s')
  const interval = REFRESH_MS[refresh]

  const ovQ = useQuery({
    queryKey: ['overview', id], queryFn: () => api.getDeviceOverview(id!),
    enabled: !!id, refetchInterval: interval,
  })
  const ifacesQ = useQuery({
    queryKey: ['interfaces', id], queryFn: () => api.listInterfaces(id!),
    enabled: !!id, staleTime: 30_000,
  })
  const auditQ = useQuery({
    queryKey: ['audit', id], queryFn: () => api.listAudit(id),
    enabled: !!id, refetchInterval: interval !== false ? Math.max(interval, 30_000) : false,
  })
  const ipsecQ = useQuery({
    queryKey: ['ipsec', id], queryFn: () => api.getIPsec(id!),
    enabled: !!id, staleTime: 30_000,
  })
  const ipsecStatusQ = useQuery({
    queryKey: ['ipsec-status', id], queryFn: () => api.getIPsecStatus(id!),
    enabled: !!id, refetchInterval: interval,
  })
  const devicesQ = useQuery({
    queryKey: ['devices'], queryFn: () => api.listDevices(), staleTime: 30_000,
  })
  const device = devicesQ.data?.find(d => d.id === id)
  const throughput = useLiveThroughput(id)

  const ov = ovQ.data
  const ifaces = (ifacesQ.data || []).filter(i => i.name !== 'lo' && i.kind !== 'loopback')
  const audit = (auditQ.data || []).slice(0, 5)

  const throughputArr = throughput || []
  const last = throughputArr.length > 0 ? throughputArr[throughputArr.length - 1] : null
  const latestRx = last?.total?.rx_bps ?? 0
  const latestTx = last?.total?.tx_bps ?? 0

  const memPct = (ov?.memory_total_mb && ov.memory_used_mb != null
    && ov.memory_total_mb > 0
    && ov.memory_used_mb >= 0
    && ov.memory_used_mb <= ov.memory_total_mb)
    ? Math.round(ov.memory_used_mb / ov.memory_total_mb * 100)
    : null

  // The data-updated timestamp for the refresh control bar. Picks the
  // most recent of the polling queries so the operator sees how fresh
  // the dashboard is end-to-end, not just one query.
  const lastUpdated = Math.max(
    ovQ.dataUpdatedAt || 0,
    ipsecStatusQ.dataUpdatedAt || 0,
    last?.ts ? new Date(last.ts).getTime() : 0,
  )

  return (
    <>
      <DeviceHeader />
      <RefreshBar
        lastUpdated={lastUpdated}
        refresh={refresh}
        onRefreshChange={setRefresh}
        onManualRefresh={() => { ovQ.refetch(); ipsecStatusQ.refetch(); ifacesQ.refetch(); auditQ.refetch() }}
      />
      <ErrorBoundary label="Device overview">
        <OverviewBody id={id!} ov={ov} ifaces={ifaces} audit={audit}
          throughput={throughputArr} latestRx={latestRx} latestTx={latestTx}
          memPct={memPct} device={device}
          ipsecPeers={ipsecQ.data?.peers} ipsecSAs={ipsecStatusQ.data} />
      </ErrorBoundary>
    </>
  )
}

function OverviewBody({ id, ov, ifaces, audit, throughput, latestRx, latestTx, memPct, device,
                       ipsecPeers, ipsecSAs }: {
  id: string
  ov: any
  ifaces: Interface[]
  audit: any[]
  throughput: any[]
  latestRx: number
  latestTx: number
  memPct: number | null
  device: any
  ipsecPeers?: Array<{ name: string; disable?: boolean }>
  ipsecSAs?: Array<{ peer: string; state: string }>
}) {
  // 1-hour history for the CPU + Memory mini-charts on the tiles.
  const metricsQ = useQuery({
    queryKey: ['metrics', id, '1h'],
    queryFn: () => api.getDeviceMetrics(id),
    enabled: !!id,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const cpuSeries = (metricsQ.data || [])
    .map(s => s.cpu_pct ?? 0)
    .filter(n => Number.isFinite(n))
  const memSeries = (metricsQ.data || [])
    .filter(s => s.mem_total_mb && s.mem_used_mb != null)
    .map(s => Math.round((s.mem_used_mb! / s.mem_total_mb!) * 100))

  const throughputSeries = (throughput || [])
    .map(p => (p?.total?.rx_bps ?? 0) + (p?.total?.tx_bps ?? 0))
    .filter(n => Number.isFinite(n))

  // IPsec health for both the KPI tile and the panel below.
  const ipsecHealth = useMemo(() => ipsecHealthSummary(ipsecPeers, ipsecSAs),
    [ipsecPeers, ipsecSAs])

  const healthScore = computeHealthScore({
    cpuPct: ov?.load_1 ?? null,
    memPct,
    ipsecPeersDown: ipsecHealth.downCount,
    interfacesAdminDownButConfigured: ifaces.filter(i =>
      i.disabled && (i.addresses || []).length > 0).length,
  })

  return (
    <>
      {/* === Region 1: 6 KPI tiles ============================ */}
      <div style={tileGridStyle}>
        <HealthTile score={healthScore.score} label={healthScore.label}
          breakdown={healthScore.breakdown} />

        <Tile label="Throughput" primary={`${fmtBytes(latestRx + latestTx)}/s`}
          subtitle={`↓ ${fmtBytes(latestRx)}/s   ↑ ${fmtBytes(latestTx)}/s`}>
          <ErrorBoundary label="Throughput sparkline">
            {throughputSeries.length > 1 && (
              <Sparkline values={throughputSeries} height={32} variant="line" />
            )}
          </ErrorBoundary>
        </Tile>

        <Tile label="Active sessions"
          primary={ov?.session_count ? fmtCount(ov.session_count) : '—'}
          subtitle="conntrack entries" />

        <Tile label="CPU usage"
          primary={ov?.load_1 != null ? `${ov.load_1.toFixed(1)}%` : '—'}
          subtitle={ov?.load_5 != null ? `5m: ${ov.load_5.toFixed(1)}%   15m: ${ov.load_15?.toFixed(1)}%` : ''}
          highlight={ov?.load_1 != null && ov.load_1 > 80 ? 'warn' : undefined}>
          {cpuSeries.length > 1 && (
            <Sparkline values={cpuSeries} height={28} variant="line" />
          )}
        </Tile>

        <Tile label="Memory"
          primary={memPct != null ? `${memPct}%` : '—'}
          subtitle={ov?.memory_total_mb && ov.memory_used_mb != null ?
            `${ov.memory_used_mb} / ${ov.memory_total_mb} MB` : ''}
          highlight={memPct != null && memPct > 85 ? 'warn' : undefined}>
          {memSeries.length > 1 && (
            <Sparkline values={memSeries} height={28} variant="line" />
          )}
        </Tile>

        <IPsecTile deviceId={id} peers={ipsecPeers} sas={ipsecSAs} />
      </div>

      {/* === Region 2: Identity strip =========================== */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 18, fontSize: 12 }}>
        {ov?.uptime_seconds ? (
          <Stat label="Uptime" value={fmtUptime(ov.uptime_seconds)} />
        ) : null}
        {ov?.version_details ? (
          <Stat label="System" value={
            <span className="mono" style={{ fontSize: 11 }}>
              {ov.version_details.split('\n')[0]}
            </span>
          } />
        ) : null}
      </div>

      {/* === Region 3: Two-column panels — Interfaces + IPsec ====== */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: ipsecHealth.peerCount > 0 ? '1fr 1fr' : '1fr',
        gap: 14, marginBottom: 14,
      }}>
        <div className="card">
          <div className="card-head">
            <span className="card-title">Interface status</span>
            <Link to={`/devices/${id}/interfaces`} style={{ fontSize: 11 }}>
              View all →
            </Link>
          </div>
          <InterfaceTable ifaces={ifaces} />
        </div>

        {ipsecHealth.peerCount > 0 && (
          <div className="card">
            <div className="card-head">
              <span className="card-title">IPsec / VPN status</span>
              <Link to={`/devices/${id}/ipsec`} style={{ fontSize: 11 }}>
                View all →
              </Link>
            </div>
            <IPsecPanel
              peers={ipsecPeers || []}
              upPeerNames={ipsecHealth.upPeerNames}
              downCount={ipsecHealth.downCount}
              upCount={ipsecHealth.upCount} />
          </div>
        )}
      </div>

      {/* === Region 4: Activity row =============================== */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 14 }}>
        <div className="card">
          <div className="card-head">
            <span className="card-title">Recent config changes</span>
            <Link to="/audit" style={{ fontSize: 11 }}>Full log →</Link>
          </div>
          <table className="tbl" style={{ fontSize: 12 }}>
            <tbody>
              {audit.map(a => (
                <tr key={a.id}>
                  <td className="dim mono" style={{ fontSize: 11, width: 90 }}>
                    {fmtRelTime(a.timestamp)}
                  </td>
                  <td className="mono">{a.action}</td>
                  <td className="dim">{a.user_name || a.user_id}</td>
                  <td className="right">
                    <span className={`badge ${a.success ? 'ok' : 'danger'}`}>
                      {a.success ? 'ok' : 'fail'}
                    </span>
                  </td>
                </tr>
              ))}
              {audit.length === 0 && (
                <tr><td colSpan={4} style={{ padding: 14, color: 'var(--ink-muted)', fontSize: 12 }}>
                  No recorded changes for this device.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Configuration</span>
          </div>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ActionLink to={`/devices/${id}/firewall/ipv4`} label="Firewall rules"
              hint="Edit rule-sets and zone policies" />
            <ActionLink to={`/devices/${id}/groups`} label="Groups"
              hint="Address / network / port groups" />
            <ActionLink to={`/devices/${id}/nat`} label="NAT"
              hint="Source / destination NAT rules" />
            <ActionLink to={`/devices/${id}/qos`} label="QoS"
              hint="Traffic shaping policies and bindings" />
            <ActionLink to={`/devices/${id}/snmp`} label="SNMP"
              hint="System info, v2c, v3, traps" />
          </div>
        </div>

        <QuickActions deviceID={id!} deviceName={device?.name || ''} />
      </div>

      {ov && (ov.raw_memory || ov.raw_uptime || ov.raw_sessions) && (
        <details style={{ marginTop: 14, fontSize: 12 }}>
          <summary style={{
            cursor: 'pointer', color: 'var(--ink-muted)',
            padding: '4px 0',
          }}>
            Diagnostics — raw VyOS output (click to expand)
          </summary>
          <div style={{ padding: 10, background: 'var(--bg-subtle)', borderRadius: 6, marginTop: 6 }}>
            {ov.raw_memory && <RawBlock title="show system memory" body={ov.raw_memory} />}
            {ov.raw_uptime && <RawBlock title="show system uptime" body={ov.raw_uptime} />}
            {ov.raw_sessions && <RawBlock title="show conntrack statistics" body={ov.raw_sessions} />}
          </div>
        </details>
      )}
    </>
  )
}

// =============================================================================
// Refresh bar
// =============================================================================

function RefreshBar({ lastUpdated, refresh, onRefreshChange, onManualRefresh }: {
  lastUpdated: number
  refresh: RefreshChoice
  onRefreshChange: (c: RefreshChoice) => void
  onManualRefresh: () => void
}) {
  const ts = lastUpdated > 0 ? new Date(lastUpdated) : null
  return (
    <div style={{
      display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
      gap: 12, marginBottom: 12, fontSize: 11, color: 'var(--ink-muted)',
    }}>
      <button onClick={onManualRefresh} title="Refresh now"
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--ink-muted)', padding: 2, fontSize: 14,
        }}>↻</button>
      <span>
        Last updated{' '}
        <span className="mono" style={{ color: 'var(--ink)' }}>
          {ts ? ts.toLocaleTimeString() : '—'}
        </span>
      </span>
      <select
        value={refresh}
        onChange={e => onRefreshChange(e.target.value as RefreshChoice)}
        style={{
          fontSize: 11, padding: '2px 6px',
          border: '1px solid var(--line)', borderRadius: 4,
          background: 'var(--bg)', color: 'var(--ink)',
        }}
        title="Refresh interval"
      >
        <option value="15s">15s</option>
        <option value="1m">1m</option>
        <option value="5m">5m</option>
        <option value="off">off</option>
      </select>
    </div>
  )
}

// =============================================================================
// Health score
// =============================================================================

type HealthBreakdown = { line: string; impact: number }
type HealthResult = {
  score: number
  label: 'Healthy' | 'Degraded' | 'Critical' | 'Unknown'
  breakdown: HealthBreakdown[]
}

function computeHealthScore(inputs: {
  cpuPct: number | null
  memPct: number | null
  ipsecPeersDown: number
  interfacesAdminDownButConfigured: number
}): HealthResult {
  const breakdown: HealthBreakdown[] = []
  let score = 100

  if (inputs.cpuPct == null && inputs.memPct == null) {
    return { score: 0, label: 'Unknown', breakdown: [{ line: 'No metrics yet', impact: 0 }] }
  }

  if (inputs.cpuPct != null) {
    if (inputs.cpuPct > 90) {
      score -= 25; breakdown.push({ line: `CPU critical (${inputs.cpuPct.toFixed(1)}%)`, impact: -25 })
    } else if (inputs.cpuPct > 80) {
      score -= 15; breakdown.push({ line: `CPU high (${inputs.cpuPct.toFixed(1)}%)`, impact: -15 })
    }
  }
  if (inputs.memPct != null) {
    if (inputs.memPct > 95) {
      score -= 25; breakdown.push({ line: `Memory critical (${inputs.memPct}%)`, impact: -25 })
    } else if (inputs.memPct > 85) {
      score -= 15; breakdown.push({ line: `Memory high (${inputs.memPct}%)`, impact: -15 })
    }
  }
  if (inputs.ipsecPeersDown > 0) {
    const impact = Math.min(40, inputs.ipsecPeersDown * 20)
    score -= impact
    breakdown.push({ line: `${inputs.ipsecPeersDown} IPsec peer${inputs.ipsecPeersDown > 1 ? 's' : ''} down`, impact: -impact })
  }
  if (inputs.interfacesAdminDownButConfigured > 0) {
    const impact = Math.min(20, inputs.interfacesAdminDownButConfigured * 10)
    score -= impact
    breakdown.push({ line: `${inputs.interfacesAdminDownButConfigured} configured interface(s) admin-down`, impact: -impact })
  }

  score = Math.max(0, Math.min(100, score))
  const label: HealthResult['label'] =
    score >= 85 ? 'Healthy' : score >= 60 ? 'Degraded' : 'Critical'
  return { score, label, breakdown }
}

function HealthTile({ score, label, breakdown }: {
  score: number; label: HealthResult['label']; breakdown: HealthBreakdown[]
}) {
  const color =
    label === 'Healthy' ? 'var(--ok, #0a8f50)' :
    label === 'Degraded' ? 'var(--warn, #e08e00)' :
    label === 'Critical' ? 'var(--danger)' :
    'var(--ink-muted)'
  const tooltip = breakdown.length === 0
    ? 'All systems nominal'
    : breakdown.map(b => `${b.line} (${b.impact >= 0 ? '+' : ''}${b.impact})`).join('\n')
  return (
    <Tile label="Health score" highlight={label === 'Critical' ? 'crit' : label === 'Degraded' ? 'warn' : undefined}
      primary={
        <span>
          <span style={{ color }}>{score}</span>
          <span style={{ fontSize: 12, color: 'var(--ink-muted)', marginLeft: 4 }}>%</span>
        </span>
      }
      subtitle={<span style={{ color, fontWeight: 500 }} title={tooltip}>{label}</span>}
    />
  )
}

// =============================================================================
// IPsec helpers
// =============================================================================

function ipsecHealthSummary(
  peers?: Array<{ name: string; disable?: boolean }>,
  sas?: Array<{ peer: string; state: string }>
) {
  const peerCount = peers?.length ?? 0
  const upPeerNames = new Set(
    (sas || []).filter(s => s.state === 'up').map(s => s.peer)
  )
  const upCount = upPeerNames.size
  const downCount = Math.max(0, peerCount - upCount)
  return { peerCount, upCount, downCount, upPeerNames }
}

function IPsecTile({ deviceId, peers, sas }: {
  deviceId: string
  peers?: Array<{ name: string; disable?: boolean }>
  sas?: Array<{ peer: string; state: string }>
}) {
  const navigate = useNavigate()
  const { peerCount, upCount, downCount } = ipsecHealthSummary(peers, sas)
  if (peerCount === 0) {
    return <Tile label="IPsec" primary="—" subtitle="Not configured" />
  }
  const highlight = downCount > 0 ? 'warn' as const : undefined
  return (
    <Tile label="IPsec"
      primary={`${upCount} / ${peerCount}`}
      subtitle={downCount > 0 ? `${downCount} down` : 'Tunnels up'}
      highlight={highlight}
      onClick={() => navigate(`/devices/${deviceId}/ipsec`)} />
  )
}

function IPsecPanel({ peers, upPeerNames, upCount, downCount }: {
  peers: Array<{ name: string; remote_address?: string; disable?: boolean }>
  upPeerNames: Set<string>
  upCount: number
  downCount: number
}) {
  return (
    <div style={{ padding: 12 }}>
      {/* Summary line */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <span style={{ fontSize: 22, fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
          {upCount} <span style={{ color: 'var(--ink-muted)', fontSize: 14 }}>/ {upCount + downCount}</span>
        </span>
        <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>Tunnels up</span>
        {downCount > 0 && (
          <span style={{
            fontSize: 11, color: 'var(--warn-ink, #8a5a00)',
            background: 'var(--warn-soft, #fff4d1)', padding: '1px 6px', borderRadius: 3,
          }}>
            {downCount} down
          </span>
        )}
      </div>

      {/* Per-peer list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {peers.map(p => {
          const isUp = upPeerNames.has(p.name)
          const disabled = !!p.disable
          const color = disabled ? 'var(--ink-muted)' : isUp ? 'var(--ok, #0a8f50)' : 'var(--danger)'
          const stateText = disabled ? 'disabled' : isUp ? 'up' : 'down'
          return (
            <div key={p.name} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '4px 0',
            }}>
              <span style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: 4,
                background: color, flex: '0 0 8px',
              }} />
              <span className="mono" style={{ fontSize: 12, fontWeight: 500, flex: 1 }}>
                {p.name}
              </span>
              {p.remote_address && (
                <span className="mono dim" style={{ fontSize: 11 }}>{p.remote_address}</span>
              )}
              <span className="mono" style={{
                fontSize: 11, color, minWidth: 44, textAlign: 'right',
              }}>
                {stateText}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// =============================================================================
// Interface table
// =============================================================================

function InterfaceTable({ ifaces }: { ifaces: Interface[] }) {
  if (ifaces.length === 0) {
    return (
      <div style={{ padding: 16, color: 'var(--ink-muted)', fontSize: 12 }}>
        No interfaces reported.
      </div>
    )
  }
  return (
    <table className="tbl" style={{ fontSize: 12 }}>
      <thead>
        <tr>
          <th style={{ width: 30 }}></th>
          <th>Interface</th>
          <th>Address</th>
          <th>VRF</th>
          <th className="right">Description</th>
        </tr>
      </thead>
      <tbody>
        {ifaces.map(i => {
          const hasAddr = (i.addresses || []).length > 0
          const lsRaw = (i.link_state || '').toLowerCase()
          const linkUp = lsRaw === 'up' || (lsRaw === '' && hasAddr)
          const isUp = linkUp && !i.disabled
          const isAdminDown = i.disabled
          const dotColor = isUp ? 'var(--ok, #0a8f50)'
            : isAdminDown ? 'var(--ink-muted)'
            : 'var(--danger)'
          return (
            <tr key={i.name}>
              <td>
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: 4,
                  background: dotColor,
                }} title={isUp ? 'up' : isAdminDown ? 'admin-down' : 'down'} />
              </td>
              <td className="mono" style={{ fontWeight: 500 }}>{i.name}</td>
              <td className="mono dim" style={{ fontSize: 11 }}>
                {hasAddr ? (i.addresses || []).slice(0, 2).join(', ') :
                  <em style={{ fontStyle: 'italic' }}>{isAdminDown ? 'admin-down' : 'no address'}</em>}
              </td>
              <td className="mono dim" style={{ fontSize: 11 }}>{i.vrf || ''}</td>
              <td className="right dim" style={{ fontSize: 11 }}>{i.description || ''}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// =============================================================================
// Tile + general helpers
// =============================================================================

function Tile({ label, primary, subtitle, highlight, children, onClick }: {
  label: string; primary: React.ReactNode; subtitle?: React.ReactNode
  highlight?: 'warn' | 'crit'; children?: React.ReactNode
  onClick?: () => void
}) {
  const borderColor = highlight === 'crit' ? 'var(--danger)'
    : highlight === 'warn' ? 'var(--warn, #e08e00)'
    : 'var(--line)'
  return (
    <div className="card"
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      style={{
        padding: 14, borderLeft: `3px solid ${borderColor}`,
        cursor: onClick ? 'pointer' : undefined,
      }}>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)',
        textTransform: 'uppercase', letterSpacing: 0.05, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
        {primary}
      </div>
      {subtitle && (
        <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 2 }}>
          {subtitle}
        </div>
      )}
      {children && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--ink-muted)',
        textTransform: 'uppercase', letterSpacing: 0.05 }}>{label}</div>
      <div>{value}</div>
    </div>
  )
}

function ActionLink({ to, label, hint }: { to: string; label: string; hint: string }) {
  return (
    <Link to={to} style={{
      display: 'block', padding: '8px 10px', borderRadius: 4,
      textDecoration: 'none', color: 'inherit',
      border: '1px solid var(--line)', background: 'var(--bg-subtle)',
    }}>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 1 }}>{hint}</div>
    </Link>
  )
}

function RawBlock({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="mono dim" style={{ fontSize: 11, marginBottom: 2 }}>$ {title}</div>
      <pre style={{
        margin: 0, padding: 8, background: 'var(--bg)',
        border: '1px solid var(--line)', borderRadius: 4,
        fontSize: 11, fontFamily: 'var(--font-mono)',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>{body}</pre>
    </div>
  )
}

// --- Format helpers ---------------------------------------------------------

function fmtUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function fmtRelTime(iso: string): string {
  const t = new Date(iso).getTime()
  const ago = Math.floor((Date.now() - t) / 1000)
  if (ago < 60) return `${ago}s ago`
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`
  return `${Math.floor(ago / 86400)}d ago`
}

const tileGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
  gap: 12, marginBottom: 14,
}
