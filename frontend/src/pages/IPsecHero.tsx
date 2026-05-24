import type { SAStatus, IKEGroup, ESPGroup, Peer } from '../lib/api'

// IPsecHero — the live topology + real-telemetry hero for the IPsec page.
//
// Every value shown is REAL, sourced from data the page already fetches:
//   - nodes/IPs:        peer.local_address / peer.remote_address
//   - link live state:  sa.state === 'up' (the glow + flow animate only when up)
//   - crypto string:    derived from the IKE group + ESP group the peer references
//   - stats strip:      sa.uptime_sec, bytes_in/out, local_net/remote_net
//   - rekey:            NOT shown unless present — we don't fabricate it
//
// No latency / jitter / packet-loss / security-score: the backend does not
// collect those for tunnels, so they are intentionally absent rather than faked.

function fmtBytes(n?: number): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${u[i]}`
}
function fmtUptime(s?: number): string {
  if (s == null || s < 0) return '—'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// Build a human crypto string from the groups the peer references.
function cryptoString(peer: Peer | undefined, ike?: IKEGroup, esp?: ESPGroup): string {
  const parts: string[] = []
  const ikeP = ike?.proposals?.[0]
  if (ikeP) {
    const enc = (ikeP.encryption || '').toUpperCase().replace('AES', 'AES-')
    if (enc) parts.push(enc)
    if (ikeP.hash) parts.push(ikeP.hash.toUpperCase().replace('SHA', 'SHA-'))
    if (ikeP.dh_group) parts.push(`DH-${ikeP.dh_group}`)
  }
  return parts.length ? parts.join(' / ') : (ike?.ike_version?.toUpperCase() || 'IPsec')
}

export default function IPsecHero({
  peer, sa, ike, esp,
}: {
  peer?: Peer
  sa?: SAStatus            // the live SA for this peer's first tunnel, if any
  ike?: IKEGroup
  esp?: ESPGroup
}) {
  const up = sa?.state === 'up'
  const linkClass = up ? 'topo-link up' : 'topo-link'
  const nodeClass = up ? 'topo-node live' : 'topo-node'

  return (
    <div className="ipsec-hero">
      <div className="ipsec-hero-grid">
        <div className={nodeClass}>
          <div className="icon">▤</div>
          <div className="label">VyOS Gateway</div>
          <div className="sub">{peer?.local_address || 'any'}</div>
        </div>

        <div className={linkClass}>
          <div className="track" />
          <div className="flow" /><div className="flow" /><div className="flow" />
          <div className="lock">{up ? '🔒' : '🔓'}</div>
          <div className="crypto-cap">{cryptoString(peer, ike, esp)}</div>
        </div>

        <div className={nodeClass}>
          <div className="icon">▢</div>
          <div className="label">{peer?.name || 'peer'}</div>
          <div className="sub">{peer?.remote_address || '—'}</div>
        </div>
      </div>

      <div className="hero-stats">
        <div className="hero-stat">
          <div className="k">State</div>
          <div className={up ? 'v ok' : 'v'}>{(sa?.state || 'down').toUpperCase()}</div>
        </div>
        <div className="hero-stat">
          <div className="k">Uptime</div>
          <div className="v">{fmtUptime(sa?.uptime_sec)}</div>
        </div>
        <div className="hero-stat">
          <div className="k">In / Out</div>
          <div className="v" style={{ fontSize: 14 }}>{fmtBytes(sa?.bytes_in)} / {fmtBytes(sa?.bytes_out)}</div>
        </div>
        <div className="hero-stat">
          <div className="k">Local</div>
          <div className="v" style={{ fontSize: 13 }}>{sa?.local_net || '—'}</div>
        </div>
        <div className="hero-stat">
          <div className="k">Remote</div>
          <div className="v" style={{ fontSize: 13 }}>{sa?.remote_net || '—'}</div>
        </div>
        <div className="hero-stat">
          <div className="k">Auth</div>
          <div className="v" style={{ fontSize: 13 }}>{peer?.authentication?.mode || '—'}</div>
        </div>
      </div>
    </div>
  )
}
