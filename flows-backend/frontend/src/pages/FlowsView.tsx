import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

// FlowsView — active connection table from conntrack (real device data via
// `show conntrack table ipv4`). No application/DPI column and no per-flow DSCP:
// conntrack does not carry those, so they are honestly omitted rather than
// guessed. Shows the original (pre-NAT) tuple; reply tuple reveals NAT when it
// differs.

type Flow = {
  conntrack_id: string
  protocol: string
  state: string
  orig_src_ip: string
  orig_src_port: string
  orig_dst_ip: string
  orig_dst_port: string
  reply_src_ip: string
  reply_dst_ip: string
  timeout_sec: number
}

export function FlowsView({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ['flows', deviceId],
    queryFn: () => api.deviceFlows(deviceId, 500),
    enabled: !!deviceId,
    refetchInterval: 15_000,
  })
  const flows: Flow[] = (q.data as Flow[]) ?? []

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <span className="card-title">Active flows</span>
        <span className="dim" style={{ fontSize: 11 }}>
          {flows.length ? `${flows.length} connections · conntrack` : 'conntrack'}
        </span>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Source</th><th>Destination</th><th>Proto</th>
            <th>State</th><th className="right">Timeout</th>
          </tr>
        </thead>
        <tbody>
          {flows.map((f) => {
            const nat = f.reply_dst_ip && f.reply_dst_ip !== f.orig_src_ip
            return (
              <tr key={f.conntrack_id}>
                <td className="mono">{f.orig_src_ip}{f.orig_src_port ? `:${f.orig_src_port}` : ''}</td>
                <td className="mono">
                  {f.orig_dst_ip}{f.orig_dst_port ? `:${f.orig_dst_port}` : ''}
                  {nat && <span className="badge info" style={{ marginLeft: 6, fontSize: 10 }} title={`NAT — reply via ${f.reply_dst_ip}`}>nat</span>}
                </td>
                <td><span className="badge info">{f.protocol}</span></td>
                <td className="dim">{f.state || '—'}</td>
                <td className="right mono dim">{f.timeout_sec}s</td>
              </tr>
            )
          })}
          {flows.length === 0 && !q.isLoading && (
            <tr><td colSpan={5} style={{ padding: 20, color: 'var(--ink-muted)' }}>
              No active flows in the latest snapshot.
            </td></tr>
          )}
          {q.isLoading && (
            <tr><td colSpan={5} style={{ padding: 20, color: 'var(--ink-muted)' }}>Loading flows…</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
