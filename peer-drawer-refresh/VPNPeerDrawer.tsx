import { Drawer } from '../components/Drawer'
import { VPNPeer } from '../lib/api'
import { Link } from 'react-router-dom'

// VPNPeerDrawer — read-only details view for a fleet peer.
//
// Phase 3A is intentionally read-only. Operators who need to edit
// a peer click "Edit on device" which deep-links into the existing
// per-device IPsec wizard. This avoids duplicating the wizard inside
// the VPN section while we validate whether operators actually want
// inline editing here.
//
// The drawer shows:
//   - Connection (remote_address, local_address)
//   - Authentication (mode, local_id, remote_id; PSK is never shown)
//   - Crypto profile references (IKE / ESP names)
//   - Tunnels — fully expanded with per-tunnel subnets, protocol,
//     ESP override
//
// Inline styles only — no reliance on CSS classes that may not exist.
// The few classes we do use (.btn, .btn-primary, .mono, .dim, .badge,
// .hint, .card) are confirmed present from Phase 1's drawer and the
// rest of the app.

type Props = {
  peer: VPNPeer
  onClose: () => void
}

const ROW: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '160px 1fr',
  gap: 8,
  padding: '6px 0',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  fontSize: 12,
}
const ROW_LAST: React.CSSProperties = { ...ROW, borderBottom: 'none' }
const LABEL: React.CSSProperties = {
  color: 'rgba(255,255,255,0.55)',
}
const SECTION: React.CSSProperties = {
  marginTop: 18,
  marginBottom: 8,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.05,
  color: 'rgba(255,255,255,0.55)',
  fontWeight: 500,
}

export function VPNPeerDrawer({ peer, onClose }: Props) {
  const p = peer.peer
  const tunnels = p?.tunnels || []

  // Deep-link into the device IPsec page in edit mode for this peer.
  // Requires the deep-link handler on IPsec.tsx (also in Commit 3).
  const editURL = `/devices/${peer.device_id}/ipsec?peer=${encodeURIComponent(peer.name)}&action=edit`

  return (
    <Drawer
      title={`Peer: ${peer.name}`}
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
      {/* Identity */}
      <KV label="Device" value={peer.device_name || peer.device_id} />
      <KV label="Name" value={peer.name} mono />
      {p?.description && <KV label="Description" value={p.description} />}
      {p?.disable && <KV label="Status" value="disabled" last />}

      {/* Connection */}
      <div style={SECTION}>Connection</div>
      <KV label="Remote gateway" value={p?.remote_address || '—'} mono />
      <KV
        label="Local address"
        value={p?.local_address || 'any (default outgoing)'}
        mono
        last
      />

      {/* Authentication */}
      <div style={SECTION}>Authentication</div>
      <KV label="Mode" value={p?.authentication?.mode || '—'} />
      {p?.authentication?.local_id && (
        <KV label="Local ID" value={p.authentication.local_id} mono />
      )}
      {p?.authentication?.remote_id && (
        <KV label="Remote ID" value={p.authentication.remote_id} mono />
      )}
      {p?.authentication?.id_type && (
        <KV label="ID type" value={p.authentication.id_type} />
      )}
      {p?.authentication?.mode === 'pre-shared-secret' && (
        <KV label="PSK" value="(stored, redacted)" dim last />
      )}
      {p?.authentication?.x509_certificate && (
        <KV
          label="X.509 certificate"
          value={p.authentication.x509_certificate}
          mono
          last
        />
      )}

      {/* Crypto profile refs */}
      <div style={SECTION}>Crypto profiles</div>
      <KV label="IKE profile" value={p?.ike_group || '—'} mono />
      <KV
        label="ESP profile (default)"
        value={p?.default_esp_group || '—'}
        mono
        last
      />

      {/* Tunnels */}
      <div style={SECTION}>Tunnels ({tunnels.length})</div>
      {tunnels.length === 0 ? (
        <div className="dim" style={{ fontSize: 12, padding: '8px 0' }}>
          No tunnels configured. A peer with zero tunnels won't establish.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tunnels.map((t, idx) => (
            <div
              key={idx}
              className="card"
              style={{ padding: 10, fontSize: 12 }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 6,
                  alignItems: 'center',
                }}
              >
                <strong className="mono">Tunnel #{t.number}</strong>
                {t.disable && (
                  <span className="badge dim" style={{ fontSize: 10 }}>
                    disabled
                  </span>
                )}
              </div>
              {t.description && (
                <KV label="Description" value={t.description} small />
              )}
              <KV
                label="Local subnet"
                value={t.local_subnet || '—'}
                mono
                small
              />
              <KV
                label="Remote subnet"
                value={t.remote_subnet || '—'}
                mono
                small
              />
              {t.protocol && t.protocol !== 'all' && (
                <KV label="Protocol" value={t.protocol} small />
              )}
              {t.local_port && (
                <KV label="Local port" value={t.local_port} small />
              )}
              {t.remote_port && (
                <KV label="Remote port" value={t.remote_port} small />
              )}
              {t.esp_group && (
                <KV label="ESP override" value={t.esp_group} mono small last />
              )}
            </div>
          ))}
        </div>
      )}

      {/* VTI (rare) */}
      {p?.vti_interface && (
        <>
          <div style={SECTION}>VTI</div>
          <KV label="VTI interface" value={p.vti_interface} mono last />
        </>
      )}

      <div className="hint" style={{ marginTop: 20, fontSize: 11 }}>
        This is a read-only view. To make changes, click <em>Edit on device</em>.
      </div>
    </Drawer>
  )
}

// --- KV row helper ----------------------------------------------------------

function KV({
  label,
  value,
  mono,
  dim,
  small,
  last,
}: {
  label: string
  value: string
  mono?: boolean
  dim?: boolean
  small?: boolean
  last?: boolean
}) {
  const rowStyle: React.CSSProperties = {
    ...(last ? ROW_LAST : ROW),
    ...(small ? { fontSize: 11, padding: '4px 0' } : null),
  }
  const valueClass = [mono ? 'mono' : '', dim ? 'dim' : ''].filter(Boolean).join(' ')
  return (
    <div style={rowStyle}>
      <div style={LABEL}>{label}</div>
      <div className={valueClass}>{value}</div>
    </div>
  )
}
