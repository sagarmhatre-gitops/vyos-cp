import type { IKEGroup, ESPGroup, AuditEntry } from '../lib/api'

// IPsecPanels — two honest, real-data panels for the IPsec page:
//   1. CryptoParameters — IKE (phase 1) + ESP (phase 2) values from the groups.
//   2. ActivityFeed — recent config events from the audit log for this device.
// Both use data the page already has access to. No fabricated metrics.

export function CryptoParameters({ ike, esp }: { ike?: IKEGroup; esp?: ESPGroup }) {
  const ikeP = ike?.proposals?.[0]
  const espP = esp?.proposals?.[0]
  const up = (s?: string) => (s || '—').toUpperCase().replace('AES', 'AES-').replace('SHA', 'SHA-')

  return (
    <div className="ipsec-panel">
      <div className="ipsec-panel-head">
        <span className="ipsec-panel-title">Crypto Parameters</span>
        <span className="dim" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
          {(ike?.ike_version || 'ipsec').toUpperCase()}
        </span>
      </div>
      <div className="crypto-cols">
        <div className="crypto-col">
          <div className="crypto-phase">IKE <span className="dim">(Phase 1)</span></div>
          <CryptoRow k="Encryption" v={up(ikeP?.encryption)} />
          <CryptoRow k="Integrity" v={up(ikeP?.hash)} />
          <CryptoRow k="DH Group" v={ikeP?.dh_group ? `Group ${ikeP.dh_group}` : '—'} />
          <CryptoRow k="Version" v={(ike?.ike_version || '—').toUpperCase()} />
          <CryptoRow k="SA Lifetime" v={ike?.lifetime ? `${ike.lifetime}s` : '—'} />
          {ike?.dead_peer_detection?.action && (
            <CryptoRow k="DPD" v={`${ike.dead_peer_detection.action}${ike.dead_peer_detection.interval ? ` · ${ike.dead_peer_detection.interval}s` : ''}`} />
          )}
        </div>
        <div className="crypto-col">
          <div className="crypto-phase">ESP <span className="dim">(Phase 2)</span></div>
          <CryptoRow k="Encryption" v={up(espP?.encryption)} />
          <CryptoRow k="Integrity" v={up(espP?.hash)} />
          <CryptoRow k="PFS" v={esp?.pfs && esp.pfs !== 'disable' ? esp.pfs : 'off'} />
          <CryptoRow k="Mode" v={esp?.mode || '—'} />
          <CryptoRow k="SA Lifetime" v={esp?.lifetime ? `${esp.lifetime}s` : '—'} />
        </div>
      </div>
    </div>
  )
}

function CryptoRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="crypto-row">
      <span className="crypto-k">{k}</span>
      <span className="crypto-v mono">{v}</span>
    </div>
  )
}

// Summarize an audit entry's ops into a short human phrase.
function summarize(e: AuditEntry): string {
  if (!e.ops || e.ops.length === 0) return e.action || 'config change'
  const first = e.ops[0]
  const path = first.path?.join(' ') || ''
  const verb = first.op === 'delete' ? 'Removed' : first.op === 'set' ? 'Set' : first.op
  const more = e.ops.length > 1 ? ` (+${e.ops.length - 1} more)` : ''
  return `${verb} ${path}${more}`.trim()
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (isNaN(t)) return iso
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function ActivityFeed({ entries, loading }: { entries: AuditEntry[]; loading: boolean }) {
  const recent = entries.slice(0, 8)
  return (
    <div className="ipsec-panel">
      <div className="ipsec-panel-head">
        <span className="ipsec-panel-title">Activity Feed</span>
        <span className="dim" style={{ fontSize: 11 }}>config events</span>
      </div>
      {loading ? (
        <div className="feed-empty">Loading recent activity…</div>
      ) : recent.length === 0 ? (
        <div className="feed-empty">No recent configuration changes recorded for this device.</div>
      ) : (
        <ul className="feed-list">
          {recent.map(e => (
            <li key={e.id} className="feed-item">
              <span className={'feed-dot ' + (e.success ? 'ok' : 'err')} />
              <div className="feed-body">
                <div className="feed-title">{summarize(e)}</div>
                <div className="feed-meta mono">
                  {e.user_name || 'system'} · {relTime(e.timestamp)}
                  {!e.success && <span className="feed-fail"> · failed</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
