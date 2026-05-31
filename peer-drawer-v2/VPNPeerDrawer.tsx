import { useQuery } from '@tanstack/react-query'
import { Drawer } from '../components/Drawer'
import { api, VPNPeer } from '../lib/api'
import { Link } from 'react-router-dom'

// VPNPeerDrawer — read-only details view, v2 (post operator feedback).
//
// Layout at 720px wide ("mixed"):
//
//   ┌─ Hero strip ────────────────────────────────────────┐
//   │ name [Configured]  · device · description           │
//   ├─────────────────────────────────────────────────────┤
//   │ ▣ Overview      ▣ Connection      (2 cards side-by-side)
//   │ ▣ Authentication                  (1 card full-width)
//   │ ▣ Crypto Profiles  ▣ Tunnels      (2 cards side-by-side)
//   ├─ Footer ────────────────────────────────────────────┤
//   │ Last commit: ...  ·  Last polled: ...               │
//   └─────────────────────────────────────────────────────┘
//
// Each card has a tinted icon-square in the header for visual rhythm.
// Static "Configured" pill — no live operational claims.
// Tunnels presented as a compact table.

type Props = {
  peer: VPNPeer
  onClose: () => void
}

export function VPNPeerDrawer({ peer, onClose }: Props) {
  const p = peer.peer
  const tunnels = p?.tunnels || []

  // Audit log — used for "last config commit" footer line.
  // Filtered by device, limited to a small window (we only need the
  // most recent entry).
  const auditQ = useQuery({
    queryKey: ['audit', peer.device_id],
    queryFn: () => api.listAudit(peer.device_id, 5),
  })
  const lastCommit = auditQ.data?.[0]?.timestamp

  // Device record — used for "last polled" footer line.
  const devicesQ = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.listDevices(),
  })
  const device = devicesQ.data?.find(d => d.id === peer.device_id)
  const lastPolled = device?.last_seen

  const editURL =
    `/devices/${peer.device_id}/ipsec` +
    `?peer=${encodeURIComponent(peer.name)}&action=edit`

  return (
    <Drawer
      title="Peer details"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <Link
            to={editURL}
            className="btn btn-primary"
            style={{ textDecoration: 'none' }}
            onClick={onClose}
          >
            Edit on device
          </Link>
        </>
      }
    >
      {/* Hero strip ──────────────────────────────────────────── */}
      <div className="peer2-hero">
        <div className="peer2-hero-icon" aria-hidden>
          <IconLink />
        </div>
        <div className="peer2-hero-text">
          <div className="peer2-hero-line1">
            <span className="peer2-hero-name mono">{peer.name}</span>
            {p?.disable
              ? <span className="peer2-pill peer2-pill-muted">Disabled</span>
              : <span className="peer2-pill peer2-pill-ok">Configured</span>}
          </div>
          <div className="peer2-hero-line2 dim">
            <span>Device:</span>{' '}
            <span className="mono">{peer.device_name || peer.device_id}</span>
          </div>
          {p?.description && (
            <div className="peer2-hero-desc">{p.description}</div>
          )}
        </div>
        <div className="peer2-hero-hint dim">This is a read-only view.</div>
      </div>

      {/* Row 1: Overview + Connection ────────────────────────── */}
      <div className="peer2-card-row">
        <div className="peer2-card">
          <div className="peer2-card-head">
            <span className="peer2-icon peer2-icon-info" aria-hidden>
              <IconInfo />
            </span>
            <span className="peer2-card-title">Overview</span>
          </div>
          <div className="peer2-card-body">
            <Row k="Name" v={peer.name} mono />
            <Row
              k="Description"
              v={p?.description || '—'}
              dim={!p?.description}
            />
            <Row k="Device" v={peer.device_name || peer.device_id} mono />
            <Row
              k="Status"
              v={p?.disable ? 'Disabled' : 'Configured'}
            />
          </div>
        </div>

        <div className="peer2-card">
          <div className="peer2-card-head">
            <span className="peer2-icon peer2-icon-link" aria-hidden>
              <IconLink />
            </span>
            <span className="peer2-card-title">Connection</span>
          </div>
          <div className="peer2-card-body">
            <Row k="Remote gateway" v={p?.remote_address || '—'} mono />
            <Row
              k="Local address"
              v={p?.local_address || 'any (default outgoing)'}
              mono
            />
          </div>
        </div>
      </div>

      {/* Row 2: Authentication ───────────────────────────────── */}
      <div className="peer2-card peer2-card-wide">
        <div className="peer2-card-head">
          <span className="peer2-icon peer2-icon-auth" aria-hidden>
            <IconShield />
          </span>
          <span className="peer2-card-title">Authentication</span>
        </div>
        <div className="peer2-card-body">
          <Row k="Mode" v={p?.authentication?.mode || '—'} mono />
          {p?.authentication?.local_id && (
            <Row k="Local ID" v={p.authentication.local_id} mono />
          )}
          {p?.authentication?.remote_id && (
            <Row k="Remote ID" v={p.authentication.remote_id} mono />
          )}
          {p?.authentication?.id_type && (
            <Row k="ID type" v={p.authentication.id_type} />
          )}
          {p?.authentication?.mode === 'pre-shared-secret' && (
            <Row k="PSK" v="(stored, redacted)" dim />
          )}
          {p?.authentication?.x509_certificate && (
            <Row
              k="X.509 certificate"
              v={p.authentication.x509_certificate}
              mono
            />
          )}
        </div>
      </div>

      {/* Row 3: Crypto Profiles + Tunnels ────────────────────── */}
      <div className="peer2-card-row">
        <div className="peer2-card">
          <div className="peer2-card-head">
            <span className="peer2-icon peer2-icon-key" aria-hidden>
              <IconKey />
            </span>
            <span className="peer2-card-title">Crypto Profiles</span>
          </div>
          <div className="peer2-card-body">
            <Row k="IKE profile" v={p?.ike_group || '—'} mono />
            <Row
              k="ESP profile (default)"
              v={p?.default_esp_group || '—'}
              mono
            />
          </div>
        </div>

        <div className="peer2-card">
          <div className="peer2-card-head">
            <span className="peer2-icon peer2-icon-tunnel" aria-hidden>
              <IconTunnel />
            </span>
            <span className="peer2-card-title">Tunnels ({tunnels.length})</span>
          </div>
          <div className="peer2-card-body peer2-card-body-flush">
            {tunnels.length === 0 ? (
              <div className="peer2-empty">
                No tunnels configured.
              </div>
            ) : (
              <table className="peer2-tunnels-table">
                <thead>
                  <tr>
                    <th>Tunnel</th>
                    <th>Local subnet</th>
                    <th>Remote subnet</th>
                    <th>ESP override</th>
                  </tr>
                </thead>
                <tbody>
                  {tunnels.map((t, idx) => (
                    <tr key={idx}>
                      <td className="mono">#{t.number}</td>
                      <td className="mono">{t.local_subnet || '—'}</td>
                      <td className="mono">{t.remote_subnet || '—'}</td>
                      <td className="mono">
                        {t.esp_group && t.esp_group !== p?.default_esp_group
                          ? t.esp_group
                          : <span className="dim">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* VTI — rare, only shown when present */}
      {p?.vti_interface && (
        <div className="peer2-card peer2-card-wide">
          <div className="peer2-card-head">
            <span className="peer2-icon peer2-icon-info" aria-hidden>
              <IconInfo />
            </span>
            <span className="peer2-card-title">VTI</span>
          </div>
          <div className="peer2-card-body">
            <Row k="Interface" v={p.vti_interface} mono />
          </div>
        </div>
      )}

      {/* Footer timestamps ───────────────────────────────────── */}
      <div className="peer2-footer">
        <span className="peer2-footer-item dim">
          <strong>Last commit:</strong>{' '}
          {lastCommit
            ? new Date(lastCommit).toLocaleString()
            : auditQ.isLoading ? 'loading…' : 'no audit entries'}
        </span>
        <span className="peer2-footer-sep dim">·</span>
        <span className="peer2-footer-item dim">
          <strong>Last polled:</strong>{' '}
          {lastPolled
            ? new Date(lastPolled).toLocaleString()
            : devicesQ.isLoading ? 'loading…' : '—'}
        </span>
      </div>
    </Drawer>
  )
}

// --- Row helper -------------------------------------------------------------

function Row({
  k, v, mono, dim,
}: {
  k: string
  v: string
  mono?: boolean
  dim?: boolean
}) {
  return (
    <div className="peer2-row">
      <span className="peer2-row-k">{k}</span>
      <span className={'peer2-row-v' + (mono ? ' mono' : '') + (dim ? ' dim' : '')}>
        {v}
      </span>
    </div>
  )
}

// --- Tiny inline SVG icons (no external dep) -------------------------------
// Sized 14×14, currentColor stroke so they inherit the tinted color.

const IconInfo = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
)
const IconLink = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
)
const IconShield = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
)
const IconKey = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7.5" cy="15.5" r="5.5" />
    <path d="M21 2l-9.6 9.6" />
    <path d="M15.5 7.5l3 3L22 7l-3-3" />
  </svg>
)
const IconTunnel = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <line x1="3" y1="10" x2="21" y2="10" />
    <line x1="3" y1="14" x2="21" y2="14" />
  </svg>
)
