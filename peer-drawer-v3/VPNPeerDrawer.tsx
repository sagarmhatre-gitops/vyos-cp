import { useQuery } from '@tanstack/react-query'
import { Drawer } from '../components/Drawer'
import { api, VPNPeer, VPNProfile, IKEGroup, ESPGroup } from '../lib/api'
import { Link } from 'react-router-dom'

// VPNPeerDrawer v3 — adds full crypto detail block + downloadable spec.
//
// Layout (720px wide):
//   Hero
//   Overview | Connection           (row 1, 2-up)
//   Authentication                  (row 2, full width)
//   Crypto Profiles                 (row 3, full width — IKE | ESP side-by-side)
//   Tunnels                         (row 4, full width)
//   Footer: timestamps + actions
//
// Crypto Profiles fetches full IKE/ESP group details via the existing
// /api/v1/vpn/profiles endpoint (Phase 1) and renders the same fields
// the device-level IPsec page's Crypto Parameters panel shows.
//
// Download spec: assembles a vendor-neutral text document for sharing
// with the remote end's engineer. PSK is redacted with neutral wording
// ("see PSK owner"); a future MFA-gated reveal will populate that slot.

type Props = {
  peer: VPNPeer
  onClose: () => void
}

export function VPNPeerDrawer({ peer, onClose }: Props) {
  const p = peer.peer
  const tunnels = p?.tunnels || []

  const auditQ = useQuery({
    queryKey: ['audit', peer.device_id],
    queryFn: () => api.listAudit(peer.device_id, 5),
  })
  const lastCommit = auditQ.data?.[0]?.timestamp

  const devicesQ = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.listDevices(),
  })
  const device = devicesQ.data?.find(d => d.id === peer.device_id)
  const lastPolled = device?.last_seen

  // Full VPN profiles (with proposals, lifetimes, etc.) — used to
  // render the Crypto Profiles detail block.
  const profilesQ = useQuery({
    queryKey: ['vpn-profiles'],
    queryFn: () => api.listVPNProfiles(),
  })
  const ikeGroup = findIKE(profilesQ.data, peer.device_id, p?.ike_group)
  const espGroup = findESP(profilesQ.data, peer.device_id, p?.default_esp_group)

  const editURL =
    `/devices/${peer.device_id}/ipsec` +
    `?peer=${encodeURIComponent(peer.name)}&action=edit`

  const handleDownload = () => {
    const text = buildSpecText({
      peer, p, ike: ikeGroup, esp: espGroup,
      deviceName: peer.device_name || peer.device_id,
      lastCommit, lastPolled,
    })
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = specFilename(peer.name)
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <Drawer
      title="Peer details"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn" onClick={handleDownload}
            title="Download a vendor-neutral spec to share with the remote site's engineer">
            ↓ Download spec
          </button>
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
            <span className="peer2-icon peer2-icon-info" aria-hidden><IconInfo /></span>
            <span className="peer2-card-title">Overview</span>
          </div>
          <div className="peer2-card-body">
            <Row k="Name" v={peer.name} mono />
            <Row k="Description" v={p?.description || '—'} dim={!p?.description} />
            <Row k="Device" v={peer.device_name || peer.device_id} mono />
            <Row k="Status" v={p?.disable ? 'Disabled' : 'Configured'} />
          </div>
        </div>

        <div className="peer2-card">
          <div className="peer2-card-head">
            <span className="peer2-icon peer2-icon-link" aria-hidden><IconLink /></span>
            <span className="peer2-card-title">Connection</span>
          </div>
          <div className="peer2-card-body">
            <Row k="Remote gateway" v={p?.remote_address || '—'} mono />
            <Row k="Local address" v={p?.local_address || 'any (default outgoing)'} mono />
          </div>
        </div>
      </div>

      {/* Row 2: Authentication ───────────────────────────────── */}
      <div className="peer2-card peer2-card-wide">
        <div className="peer2-card-head">
          <span className="peer2-icon peer2-icon-auth" aria-hidden><IconShield /></span>
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
            <Row k="X.509 certificate" v={p.authentication.x509_certificate} mono />
          )}
        </div>
      </div>

      {/* Row 3: Crypto Profiles (full-width, IKE | ESP side-by-side) */}
      <div className="peer2-card peer2-card-wide">
        <div className="peer2-card-head">
          <span className="peer2-icon peer2-icon-key" aria-hidden><IconKey /></span>
          <span className="peer2-card-title">Crypto Profiles</span>
        </div>
        <div className="peer2-card-body">
          <div className="peer2-crypto-grid">
            {/* IKE / Phase 1 */}
            <div className="peer2-crypto-col">
              <div className="peer2-crypto-phase">
                IKE <span className="dim">(Phase 1)</span>
              </div>
              <Row k="Profile" v={p?.ike_group || '—'} mono />
              {ikeGroup ? (
                <>
                  {ikeGroup.ike_version && (
                    <Row k="Version" v={ikeGroup.ike_version} />
                  )}
                  {ikeGroup.mode && (
                    <Row k="Mode" v={ikeGroup.mode} />
                  )}
                  {ikeGroup.proposals && ikeGroup.proposals.length > 0 && (
                    <>
                      <Row
                        k="Encryption"
                        v={uniqueValues(ikeGroup.proposals.map(p => p.encryption))}
                        mono
                      />
                      <Row
                        k="Hash"
                        v={uniqueValues(ikeGroup.proposals.map(p => p.hash))}
                        mono
                      />
                      <Row
                        k="DH Group"
                        v={uniqueValues(ikeGroup.proposals.map(p => p.dh_group))}
                        mono
                      />
                    </>
                  )}
                  {ikeGroup.lifetime !== undefined && (
                    <Row k="Lifetime" v={`${ikeGroup.lifetime}s`} mono />
                  )}
                  {ikeGroup.dead_peer_detection && (
                    <Row
                      k="DPD"
                      v={formatDPD(ikeGroup.dead_peer_detection)}
                      mono
                    />
                  )}
                </>
              ) : (
                <Row
                  k=""
                  v={profilesQ.isLoading ? 'loading…' : 'profile not found'}
                  dim
                />
              )}
            </div>

            {/* ESP / Phase 2 */}
            <div className="peer2-crypto-col">
              <div className="peer2-crypto-phase">
                ESP <span className="dim">(Phase 2)</span>
              </div>
              <Row k="Profile" v={p?.default_esp_group || '—'} mono />
              {espGroup ? (
                <>
                  {espGroup.mode && (
                    <Row k="Mode" v={espGroup.mode} />
                  )}
                  {espGroup.proposals && espGroup.proposals.length > 0 && (
                    <>
                      <Row
                        k="Encryption"
                        v={uniqueValues(espGroup.proposals.map(p => p.encryption))}
                        mono
                      />
                      <Row
                        k="Hash"
                        v={uniqueValues(
                          espGroup.proposals
                            .map(p => p.hash)
                            .filter((h): h is string => !!h),
                        ) || '(AEAD)'}
                        mono
                      />
                    </>
                  )}
                  <Row k="PFS" v={espGroup.pfs || 'off'} mono />
                  {espGroup.lifetime !== undefined && (
                    <Row k="Lifetime" v={`${espGroup.lifetime}s`} mono />
                  )}
                </>
              ) : (
                <Row
                  k=""
                  v={profilesQ.isLoading ? 'loading…' : 'profile not found'}
                  dim
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Row 4: Tunnels (full-width) ─────────────────────────── */}
      <div className="peer2-card peer2-card-wide">
        <div className="peer2-card-head">
          <span className="peer2-icon peer2-icon-tunnel" aria-hidden><IconTunnel /></span>
          <span className="peer2-card-title">Tunnels ({tunnels.length})</span>
        </div>
        <div className="peer2-card-body peer2-card-body-flush">
          {tunnels.length === 0 ? (
            <div className="peer2-empty">No tunnels configured.</div>
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

      {/* VTI — rare */}
      {p?.vti_interface && (
        <div className="peer2-card peer2-card-wide">
          <div className="peer2-card-head">
            <span className="peer2-icon peer2-icon-info" aria-hidden><IconInfo /></span>
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

// --- Helpers ---------------------------------------------------------------

function Row({ k, v, mono, dim }: {
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

function uniqueValues(arr: string[]): string {
  const seen: string[] = []
  for (const v of arr) {
    if (v && !seen.includes(v)) seen.push(v)
  }
  return seen.length === 0 ? '—' : seen.join(', ')
}

function formatDPD(dpd: { action?: string; interval?: number; timeout?: number }): string {
  const parts: string[] = []
  if (dpd.action) parts.push(dpd.action)
  if (dpd.interval !== undefined) parts.push(`${dpd.interval}s`)
  if (dpd.timeout !== undefined) parts.push(`timeout ${dpd.timeout}s`)
  return parts.length === 0 ? '—' : parts.join(' · ')
}

function findIKE(
  profiles: VPNProfile[] | undefined,
  deviceID: string,
  name: string | undefined,
): IKEGroup | undefined {
  if (!profiles || !name) return undefined
  const match = profiles.find(
    p => p.type === 'ike' && p.device_id === deviceID && p.name === name,
  )
  return match?.ike
}

function findESP(
  profiles: VPNProfile[] | undefined,
  deviceID: string,
  name: string | undefined,
): ESPGroup | undefined {
  if (!profiles || !name) return undefined
  const match = profiles.find(
    p => p.type === 'esp' && p.device_id === deviceID && p.name === name,
  )
  return match?.esp
}

// --- Spec text builder -----------------------------------------------------

function specFilename(peerName: string): string {
  const date = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
  // Replace any character not safe for filenames with _
  const safeName = peerName.replace(/[^A-Za-z0-9_-]/g, '_')
  return `vpn-peer-spec_${safeName}_${date}.txt`
}

function buildSpecText(args: {
  peer: VPNPeer
  p: VPNPeer['peer']
  ike: IKEGroup | undefined
  esp: ESPGroup | undefined
  deviceName: string
  lastCommit: string | undefined
  lastPolled: string | undefined
}): string {
  const { peer, p, ike, esp, deviceName, lastCommit, lastPolled } = args
  const generated = new Date().toUTCString()
  const commit = lastCommit ? new Date(lastCommit).toUTCString() : 'unknown'
  const polled = lastPolled ? new Date(lastPolled).toUTCString() : 'unknown'

  const ikeEnc = ike?.proposals?.map(x => x.encryption).filter(Boolean) || []
  const ikeHash = ike?.proposals?.map(x => x.hash).filter(Boolean) || []
  const ikeDH = ike?.proposals?.map(x => x.dh_group).filter(Boolean) || []
  const espEnc = esp?.proposals?.map(x => x.encryption).filter(Boolean) || []
  const espHash = esp?.proposals?.map(x => x.hash).filter((h): h is string => !!h) || []

  const lines: string[] = []
  lines.push('=====================================================================')
  lines.push('  IPsec Site-to-Site VPN Peer Specification')
  lines.push('=====================================================================')
  lines.push(`  Peer name:        ${peer.name}`)
  lines.push(`  Our device:       ${deviceName}`)
  lines.push(`  Generated:        ${generated}`)
  lines.push(`  Last commit:      ${commit}`)
  lines.push(`  Device polled:    ${polled}`)
  if (p?.description) {
    lines.push(`  Description:      ${p.description}`)
  }
  lines.push('')
  lines.push('  This document describes the parameters required to configure the')
  lines.push('  REMOTE end of this site-to-site IPsec tunnel. Mirror the values')
  lines.push('  below on your firewall / VPN gateway.')
  lines.push('')
  lines.push('---------------------------------------------------------------------')
  lines.push('  CONNECTION')
  lines.push('---------------------------------------------------------------------')
  lines.push(`  Our public IP:    ${p?.local_address || '(default outgoing — any)'}`)
  lines.push(`  Your public IP:   ${p?.remote_address || '(unknown)'}`)
  lines.push('')
  lines.push('---------------------------------------------------------------------')
  lines.push('  TRAFFIC SELECTORS  (subnets to be encrypted)')
  lines.push('---------------------------------------------------------------------')
  if ((p?.tunnels || []).length === 0) {
    lines.push('  (no tunnels configured)')
  } else {
    for (const t of (p?.tunnels || [])) {
      lines.push(`  Tunnel #${t.number}:`)
      lines.push(`    Our subnet:     ${t.local_subnet || '—'}`)
      lines.push(`    Your subnet:    ${t.remote_subnet || '—'}`)
      if (t.protocol && t.protocol !== 'all') {
        lines.push(`    Protocol:       ${t.protocol}`)
      }
      if (t.local_port) lines.push(`    Our port:       ${t.local_port}`)
      if (t.remote_port) lines.push(`    Your port:      ${t.remote_port}`)
      if (t.esp_group && t.esp_group !== p?.default_esp_group) {
        lines.push(`    ESP override:   ${t.esp_group}`)
      }
    }
  }
  lines.push('')
  lines.push('---------------------------------------------------------------------')
  lines.push('  IKE / PHASE 1')
  lines.push('---------------------------------------------------------------------')
  if (ike) {
    if (ike.ike_version) lines.push(`  Version:          ${ike.ike_version}`)
    if (ike.mode) lines.push(`  Mode:             ${ike.mode}`)
    lines.push(`  Encryption:       ${uniqueValues(ikeEnc)}`)
    lines.push(`  Hash:             ${uniqueValues(ikeHash)}`)
    lines.push(`  DH Group:         ${uniqueValues(ikeDH)}`)
    if (ike.lifetime !== undefined) lines.push(`  Lifetime:         ${ike.lifetime} seconds`)
    if (ike.dead_peer_detection) {
      lines.push(`  DPD:              ${formatDPD(ike.dead_peer_detection)}`)
    }
    lines.push('')
    lines.push(`  Proposal string:  ${proposalString(ikeEnc, ikeHash, ikeDH, '-')}`)
  } else {
    lines.push(`  Profile reference: ${p?.ike_group || '(none)'}`)
    lines.push('  (full details unavailable — IKE profile not loaded)')
  }
  lines.push('')
  lines.push('---------------------------------------------------------------------')
  lines.push('  ESP / PHASE 2')
  lines.push('---------------------------------------------------------------------')
  if (esp) {
    if (esp.mode) lines.push(`  Mode:             ${esp.mode}`)
    lines.push(`  Encryption:       ${uniqueValues(espEnc)}`)
    lines.push(`  Hash:             ${espHash.length > 0 ? uniqueValues(espHash) : '(AEAD — none)'}`)
    lines.push(`  PFS:              ${esp.pfs || 'off'}`)
    if (esp.lifetime !== undefined) lines.push(`  Lifetime:         ${esp.lifetime} seconds`)
    lines.push('')
    lines.push(`  Proposal string:  ${proposalString(espEnc, espHash, [], '-')}`)
  } else {
    lines.push(`  Profile reference: ${p?.default_esp_group || '(none)'}`)
    lines.push('  (full details unavailable — ESP profile not loaded)')
  }
  lines.push('')
  lines.push('---------------------------------------------------------------------')
  lines.push('  AUTHENTICATION')
  lines.push('---------------------------------------------------------------------')
  lines.push(`  Method:           ${p?.authentication?.mode || '—'}`)
  if (p?.authentication?.local_id) {
    lines.push(`  Our identifier:   ${p.authentication.local_id}`)
  }
  if (p?.authentication?.remote_id) {
    lines.push(`  Your identifier:  ${p.authentication.remote_id}`)
  }
  if (p?.authentication?.id_type) {
    lines.push(`  ID type:          ${p.authentication.id_type}`)
  }
  if (p?.authentication?.mode === 'pre-shared-secret') {
    lines.push(`  PSK:              <REDACTED — see PSK owner>`)
  }
  if (p?.authentication?.x509_certificate) {
    lines.push(`  X.509 cert:       ${p.authentication.x509_certificate}`)
  }
  lines.push('')
  lines.push('=====================================================================')
  lines.push('  End of specification')
  lines.push('=====================================================================')
  return lines.join('\n')
}

function proposalString(enc: string[], hash: string[], dh: string[], sep: string): string {
  const parts = [
    ...new Set(enc.filter(Boolean)),
    ...new Set(hash.filter(Boolean)),
    ...new Set(dh.filter(Boolean).map(d => `modp${dhBits(d)}` || d)),
  ]
  return parts.join(sep) || '(none)'
}

// Best-effort DH group → modp bits mapping. Used only in proposal-string
// formatting; falls back to the raw group number for unknown groups.
function dhBits(group: string): string {
  const map: Record<string, string> = {
    '2': '1024', '5': '1536', '14': '2048', '15': '3072',
    '16': '4096', '18': '8192', '19': '256', '20': '384',
    '21': '521',
  }
  return map[group] || group
}

// --- Tiny inline SVG icons -------------------------------------------------

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
