import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, IKEGroup, ESPGroup, Peer, Tunnel } from '../lib/api'
import TunnelListEditor from './TunnelListEditor'
import IPsecHero from './IPsecHero'
import { CryptoParameters, ActivityFeed } from './IPsecPanels'
import { DeviceHeader } from '../components/DeviceHeader'
import { Modal } from '../components/Modal'

// IPsec page — read-mostly v1.5. Visually structured around the operator's
// mental model: "what tunnels exist, are they up, and what crypto profiles
// back them?" Peers are the primary subject; IKE/ESP groups are reference
// data that lives at the bottom in a compact two-column section.
//
// Hierarchy from top to bottom:
//   1. Page header + Add peer (primary action)
//   2. Status bar: NAT-T toggle, log-level, interfaces (informational)
//   3. Peers (the things operators come here to manage)
//   4. Active SAs (live telemetry for those peers)
//   5. Crypto profiles (IKE + ESP, side-by-side — reference data)
export function IPsec() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  // Edit state — non-null means "edit modal is open for this object".
  // Three slots, because peers, IKE groups, and ESP groups each have
  // their own edit modal (different fields, different concerns).
  const [editingPeer, setEditingPeer] = useState<Peer | null>(null)
  const [editingIKE, setEditingIKE] = useState<IKEGroup | null>(null)
  const [editingESP, setEditingESP] = useState<ESPGroup | null>(null)

  const cfgQ = useQuery({
    queryKey: ['ipsec', id],
    queryFn: () => api.getIPsec(id!),
    enabled: !!id,
  })

  const statusQ = useQuery({
    queryKey: ['ipsec-status', id],
    queryFn: () => api.getIPsecStatus(id!),
    enabled: !!id,
    refetchInterval: 10_000,
  })

  const refetch = () => qc.invalidateQueries({ queryKey: ['ipsec', id] })

  const auditQ = useQuery({
    queryKey: ['audit', id],
    queryFn: () => api.listAudit(id!, 100),
    enabled: !!id,
  })
  const delPeer = useMutation({ mutationFn: (name: string) => api.deletePeer(id!, name), onSuccess: refetch })
  const delIKE  = useMutation({ mutationFn: (name: string) => api.deleteIKEGroup(id!, name), onSuccess: refetch })
  const delESP  = useMutation({ mutationFn: (name: string) => api.deleteESPGroup(id!, name), onSuccess: refetch })

  // Reference-integrity preflight for IKE/ESP deletes. VyOS rejects the
  // commit at the device level if a peer still references the group, but
  // the raw error is opaque ("invalid name"). We can catch this earlier
  // and refuse the delete with a list of referencing peers — operator
  // knows exactly what to unreference (or what to delete first) without
  // touching the device.
  //
  // ikeRefs/espRefs are computed below from the live config; this helper
  // captures them at call time via closure.
  const tryDeleteGroup = (kind: 'IKE' | 'ESP', name: string, refs: string[] | undefined,
                          mutate: (n: string) => void) => {
    if (refs && refs.length > 0) {
      const peerList = refs.map(p => `\u2022 ${p}`).join('\n')
      alert(
        `Can't delete ${kind} group "${name}" — it's still referenced by:\n\n${peerList}\n\n` +
        `Edit those peers to use a different group first, or delete them.`
      )
      return
    }
    if (confirm(`Delete ${kind} group "${name}"?`)) {
      mutate(name)
    }
  }

  const cfg = cfgQ.data
  const sas = statusQ.data || []
  const peerCount = cfg?.peers?.length ?? 0
  const activeCount = sas.filter(s => s.state === 'up').length
  const [profilesOpen, setProfilesOpen] = useState(false)

  // Build "used by" maps so each crypto profile can show which peers reference it.
  // The Crypto profiles section is where new operators get confused — they create
  // two peers, see one IKE/ESP block, and worry the second peer is missing crypto.
  // Showing the reference list makes the sharing relationship explicit.
  const ikeRefs: Record<string, string[]> = {}
  const espRefs: Record<string, string[]> = {}
  for (const p of cfg?.peers || []) {
    if (p.ike_group) (ikeRefs[p.ike_group] = ikeRefs[p.ike_group] || []).push(p.name)
    const espName = p.default_esp_group
    if (espName) (espRefs[espName] = espRefs[espName] || []).push(p.name)
    // Per-tunnel ESP overrides also count as references.
    for (const t of p.tunnels || []) {
      if (t.esp_group && t.esp_group !== espName) {
        (espRefs[t.esp_group] = espRefs[t.esp_group] || []).push(p.name)
      }
    }
  }

  return (
    <>
      <DeviceHeader />

      {/* Page header + primary action */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 16 }}>IPsec</h2>
          <div className="hint">
            Site-to-site VPN tunnels.
            {peerCount > 0 && <> {peerCount} peer{peerCount === 1 ? '' : 's'}, {activeCount} active.</>}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add peer</button>
      </div>

      {cfgQ.isLoading && <div className="card" style={{ padding: 20, color: 'var(--ink-muted)' }}>Loading…</div>}
      {cfgQ.isError && <div className="card" style={{ padding: 20, color: 'var(--danger)' }}>
        Failed to load IPsec config: {(cfgQ.error as Error).message}
      </div>}

      {cfg && (
        <>
          {/* Compact status strip — informational, not a primary panel */}
          <div style={{
            display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16,
            padding: '8px 12px', fontSize: 12,
            background: 'var(--bg-raised)', border: '1px solid var(--line)', borderRadius: 'var(--radius)',
          }}>
            <span className="dim">Globals</span>
            <Pill label="NAT-T" value={cfg.globals.nat_traversal ? 'enabled' : 'disabled'}
                  tone={cfg.globals.nat_traversal ? 'ok' : 'neutral'} />
            <Pill label="log-level" value={String(cfg.globals.log_level ?? 0)} tone="neutral" />
            <Pill label="interfaces"
                  value={cfg.globals.interfaces?.length ? cfg.globals.interfaces.join(', ') : 'auto'}
                  tone="neutral" />
          </div>

          {/* Live topology hero — first peer + its SA (real data only) */}
          {peerCount > 0 && (() => {
            const heroPeer = cfg.peers![0]
            const heroSA = sas.find(s => s.peer === heroPeer.name)
            const heroIKE = (cfg.ike_groups || []).find(g => g.name === heroPeer.ike_group)
            const heroESP = (cfg.esp_groups || []).find(g => g.name === heroPeer.default_esp_group)
            return (
              <>
                <IPsecHero peer={heroPeer} sa={heroSA} ike={heroIKE} esp={heroESP} />
                <div className="ipsec-panels-row">
                  <CryptoParameters ike={heroIKE} esp={heroESP} />
                  <ActivityFeed entries={auditQ.data || []} loading={auditQ.isLoading} />
                </div>
              </>
            )
          })()}
          {/* Peers — primary content */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <div>
                <div className="card-title">Peers</div>
                <div className="card-sub">Site-to-site tunnels · live telemetry refreshes every 10s</div>
              </div>
              {peerCount > 0 && (
                <div className="dim" style={{ fontSize: 11 }}>
                  {activeCount} of {peerCount} {peerCount === 1 ? 'peer' : 'peers'} up
                </div>
              )}
            </div>
            {peerCount === 0 ? (
              <EmptyState
                icon="🔗"
                title="No peers yet"
                body="Add a peer to create your first site-to-site tunnel."
                cta={<button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add peer</button>}
              />
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Name</th><th>Remote</th><th>Local</th>
                  <th>IKE / ESP</th><th>Auth</th><th>Tunnels</th>
                  <th>State</th><th className="right">In / Out</th><th className="right">Uptime</th>
                  <th className="right">Actions</th>
                </tr></thead>
                <tbody>
                  {(cfg.peers || []).map(p => {
                    const peerSAs = sas.filter(s => s.peer === p.name)
                    const sa = peerSAs[0]
                    const anyUp = peerSAs.some(s => s.state === 'up')
                    const sumIn = peerSAs.reduce((a, s) => a + (s.bytes_in || 0), 0)
                    const sumOut = peerSAs.reduce((a, s) => a + (s.bytes_out || 0), 0)
                    const maxUp = peerSAs.reduce((a, s) => Math.max(a, s.uptime_sec || 0), 0)
                    return (
                      <tr key={p.name}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <StateDot state={sa?.state} disabled={p.disable} />
                            <span className="mono"><strong>{p.name}</strong></span>
                          </div>
                          {p.description && <div className="dim" style={{ fontSize: 11, marginLeft: 16, marginTop: 2 }}>{p.description}</div>}
                        </td>
                        <td className="mono">{p.remote_address}</td>
                        <td className="mono dim">{p.local_address || 'any'}</td>
                        <td className="mono dim" style={{ fontSize: 11 }}>
                          {p.ike_group}
                          {p.default_esp_group && <> / {p.default_esp_group}</>}
                        </td>
                        <td className="mono dim" style={{ fontSize: 11 }}>{p.authentication.mode}</td>
                        <td>
                          {(p.tunnels || []).length === 0
                            ? <span className="dim" style={{ fontSize: 11 }}>none</span>
                            : (p.tunnels || []).map(t => (
                                <div key={t.number} className="mono" style={{ fontSize: 11, lineHeight: 1.6 }}>
                                  <span className="dim">#{t.number}</span>{' '}
                                  {t.local_subnet || '—'} <span className="dim">↔</span> {t.remote_subnet || '—'}
                                </div>
                              ))}
                        </td>
                        <td>
                          {peerSAs.length === 0
                            ? <span className="dim" style={{ fontSize: 11 }}>—</span>
                            : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                                <span className={'live-dot ' + (anyUp ? 'up' : 'down')} />
                                <span className={'mono ' + (anyUp ? 'signal-up' : 'signal-down')}>{anyUp ? 'up' : 'down'}</span>
                              </span>}
                        </td>
                        <td className="mono right" style={{ fontSize: 11 }}>{peerSAs.length ? `${fmtBytes(sumIn)} / ${fmtBytes(sumOut)}` : '—'}</td>
                        <td className="mono right dim" style={{ fontSize: 11 }}>{peerSAs.length ? fmtUptime(maxUp) : '—'}</td>
                        <td className="right">
                          <button className="btn" style={miniBtn}
                            onClick={() => setEditingPeer(p)}>edit</button>
                          {' '}
                          <button className="btn" style={miniBtn}
                            onClick={() => confirm(`Delete peer "${p.name}"?`) && delPeer.mutate(p.name)}>delete</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Crypto profiles — side-by-side, smaller. Reference data, lower in hierarchy. */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <div>
                <div className="card-title">Crypto profiles</div>
                <div className="card-sub">Shared IKE (phase 1) and ESP (phase 2) parameters referenced by peers</div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: '1px solid var(--line)' }}>
              <div style={{ borderRight: '1px solid var(--line)' }}>
                <div style={subHeaderStyle}>IKE groups (phase 1)</div>
                {(cfg.ike_groups || []).length === 0 ? (
                  <div style={subEmptyStyle}>No IKE groups defined.</div>
                ) : (
                  <div>
                    {(cfg.ike_groups || []).map(g => (
                      <div key={g.name} style={profileRowStyle}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <span className="mono"><strong>{g.name}</strong></span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button className="btn" style={miniBtn}
                              onClick={() => setEditingIKE(g)}>edit</button>
                            <button className="btn" style={{
                              ...miniBtn,
                              opacity: (ikeRefs[g.name]?.length || 0) > 0 ? 0.5 : 1,
                            }}
                              title={(ikeRefs[g.name]?.length || 0) > 0
                                ? `In use by ${ikeRefs[g.name].length} peer(s) — unreference first`
                                : ''}
                              onClick={() => tryDeleteGroup('IKE', g.name, ikeRefs[g.name], delIKE.mutate)}>delete</button>
                          </div>
                        </div>
                        <div className="mono dim" style={{ fontSize: 11, marginTop: 4 }}>
                          {g.ike_version || 'ike-auto'} · {g.lifetime ? `${g.lifetime}s` : 'default ttl'}
                          {g.dead_peer_detection && <> · DPD {g.dead_peer_detection.action}</>}
                        </div>
                        <div className="mono" style={{ fontSize: 11, marginTop: 4 }}>
                          {g.proposals.map(p => `${p.encryption}/${p.hash}/dh${p.dh_group}`).join(', ')}
                        </div>
                        <UsedBy refs={ikeRefs[g.name]} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div style={subHeaderStyle}>ESP groups (phase 2)</div>
                {(cfg.esp_groups || []).length === 0 ? (
                  <div style={subEmptyStyle}>No ESP groups defined.</div>
                ) : (
                  <div>
                    {(cfg.esp_groups || []).map(g => (
                      <div key={g.name} style={profileRowStyle}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <span className="mono"><strong>{g.name}</strong></span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button className="btn" style={miniBtn}
                              onClick={() => setEditingESP(g)}>edit</button>
                            <button className="btn" style={{
                              ...miniBtn,
                              opacity: (espRefs[g.name]?.length || 0) > 0 ? 0.5 : 1,
                            }}
                              title={(espRefs[g.name]?.length || 0) > 0
                                ? `In use by ${espRefs[g.name].length} peer(s) — unreference first`
                                : ''}
                              onClick={() => tryDeleteGroup('ESP', g.name, espRefs[g.name], delESP.mutate)}>delete</button>
                          </div>
                        </div>
                        <div className="mono dim" style={{ fontSize: 11, marginTop: 4 }}>
                          {g.mode || 'tunnel'} · PFS {g.pfs || 'off'} · {g.lifetime ? `${g.lifetime}s` : 'default ttl'}
                        </div>
                        <div className="mono" style={{ fontSize: 11, marginTop: 4 }}>
                          {g.proposals.map(p => `${p.encryption}${p.hash ? '/' + p.hash : ' (AEAD)'}`).join(', ')}
                        </div>
                        <UsedBy refs={espRefs[g.name]} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {adding && (
        <AddPeerWizard
          deviceId={id!}
          existingIKE={cfg?.ike_groups || []}
          existingESP={cfg?.esp_groups || []}
          onClose={() => setAdding(false)}
          onDone={refetch}
        />
      )}
      {editingPeer && (
        <EditPeerModal
          deviceId={id!}
          peer={editingPeer}
          existingIKE={cfg?.ike_groups || []}
          existingESP={cfg?.esp_groups || []}
          onClose={() => setEditingPeer(null)}
          onDone={() => { setEditingPeer(null); refetch() }}
        />
      )}
      {editingIKE && (
        <EditIKEGroupModal
          deviceId={id!}
          group={editingIKE}
          onClose={() => setEditingIKE(null)}
          onDone={() => { setEditingIKE(null); refetch() }}
        />
      )}
      {editingESP && (
        <EditESPGroupModal
          deviceId={id!}
          group={editingESP}
          onClose={() => setEditingESP(null)}
          onDone={() => { setEditingESP(null); refetch() }}
        />
      )}
    </>
  )
}

// --- visual helpers --------------------------------------------------------

const miniBtn: React.CSSProperties = { height: 24, padding: '0 10px', fontSize: 11 }
const subHeaderStyle: React.CSSProperties = {
  padding: '8px 14px', fontSize: 11, color: 'var(--ink-muted)',
  textTransform: 'uppercase', letterSpacing: 0.5, background: 'var(--bg-subtle)',
  borderBottom: '1px solid var(--line)',
}
const profileRowStyle: React.CSSProperties = {
  padding: '10px 14px', borderBottom: '1px solid var(--line)',
}
const subEmptyStyle: React.CSSProperties = {
  padding: '20px 14px', color: 'var(--ink-faint)', fontSize: 12, textAlign: 'center',
}

// UsedBy renders a small "Used by: …" line under a crypto profile, listing
// the peers that reference it. When nothing references the profile, shows
// an unused state in warn tone (since it's safe to delete but probably
// indicates leftover config).
function UsedBy({ refs }: { refs?: string[] }) {
  if (!refs || refs.length === 0) {
    return (
      <div style={{ fontSize: 11, marginTop: 6, color: 'var(--ink-faint)' }}>
        Used by: <em>(none — safe to delete)</em>
      </div>
    )
  }
  return (
    <div style={{ fontSize: 11, marginTop: 6, color: 'var(--ink-muted)' }}>
      Used by:{' '}
      {refs.map((name, i) => (
        <span key={name}>
          <span className="mono" style={{ color: 'var(--ink)' }}>{name}</span>
          {i < refs.length - 1 ? ', ' : ''}
        </span>
      ))}
    </div>
  )
}

function Pill({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'neutral' | 'warn' }) {
  const colors = {
    ok:      { bg: 'var(--ok-soft)',    fg: 'var(--ok)' },
    warn:    { bg: 'var(--warn-soft)',  fg: 'var(--warn-ink)' },
    neutral: { bg: 'transparent',       fg: 'var(--ink-muted)' },
  }[tone]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, fontSize: 11 }}>
      <span style={{ color: 'var(--ink-faint)' }}>{label}</span>
      <span className="mono" style={{
        padding: tone === 'neutral' ? 0 : '1px 6px',
        borderRadius: 3, background: colors.bg, color: colors.fg, fontWeight: 500,
      }}>{value}</span>
    </span>
  )
}

function StateDot({ state, disabled }: { state?: string; disabled?: boolean }) {
  let color = 'var(--ink-faint)'
  let title = 'no SA'
  if (disabled)            { color = 'var(--ink-faint)'; title = 'disabled' }
  else if (state === 'up') { color = 'var(--ok)';        title = 'up' }
  else if (state)          { color = 'var(--warn)';      title = state }
  return (
    <span title={title} style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: color, flex: '0 0 8px',
    }} />
  )
}

function EmptyState({ icon, title, body, cta }: { icon: string; title: string; body: string; cta?: React.ReactNode }) {
  return (
    <div style={{
      padding: '40px 20px', textAlign: 'center', color: 'var(--ink-muted)',
    }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, marginBottom: cta ? 16 : 0 }}>{body}</div>
      {cta}
    </div>
  )
}

// --- Add-peer wizard (unchanged) ------------------------------------------

type WizardState = {
  peer_name: string
  description: string
  remote_address: string
  local_address: string
  psk: string
  local_id: string
  remote_id: string
  local_subnet: string
  remote_subnet: string
  // 'existing' = pick a group already on the device by name and just reference it;
  //              the wizard will NOT upsert it (preserves whatever config is on the device).
  // 'new'      = create a new group with the encryption/hash/dh values below.
  ike_mode: 'existing' | 'new'
  esp_mode: 'existing' | 'new'
  ike_name: string
  esp_name: string
  encryption: string
  hash: string
  dh_group: string
}

const defaults: WizardState = {
  peer_name: '',
  description: '',
  remote_address: '',
  local_address: '',
  psk: '',
  local_id: '',
  remote_id: '',
  local_subnet: '',
  remote_subnet: '',
  ike_mode: 'existing',
  esp_mode: 'existing',
  ike_name: 'IKE-DEFAULT',
  esp_name: 'ESP-DEFAULT',
  encryption: 'aes256',
  hash: 'sha256',
  dh_group: '14',
}

// Add Peer wizard — visual refresh (Option 1)
//
// Two-column modal: form on the left, live Configuration Summary on the
// right. The backend contract is unchanged — same fields, same atomic
// createTunnel call, same audit row.
//
// Visual decisions:
//   - Section headers (uppercase + thin top border) group Identity /
//     Authentication / Traffic selectors / Crypto profiles. No nested
//     cards inside the modal — that gets visually heavy fast.
//   - PSK gets show/hide + a Generate button + a calm one-line hint.
//     The old "Audit log redaction is a known TODO" line is removed
//     because PSK redaction shipped.
//   - "Use existing | Create new" becomes an explicit segmented toggle
//     for each of IKE and ESP, replacing the dropdown-that-mixed-modes.
//     The crypto-cipher inputs only appear when "Create new" is active.
//   - The footer error message no longer mentions partial state — the
//     wizard uses POST /ipsec/tunnels which is atomic. On failure
//     nothing is left on the device.

function generateStrongPSK(): string {
  // 32 chars from URL-safe alphabet → ~190 bits of entropy. Strong by
  // any reasonable measure; matches what `openssl rand -base64 24` gives.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  let s = ''
  for (let i = 0; i < arr.length; i++) s += alphabet[arr[i] % alphabet.length]
  return s
}

function AddPeerWizard({
  deviceId, existingIKE, existingESP, onClose, onDone,
}: {
  deviceId: string
  existingIKE: IKEGroup[]
  existingESP: ESPGroup[]
  onClose: () => void
  onDone: () => void
}) {
  const initial: WizardState = {
    ...defaults,
    ike_mode: existingIKE.length > 0 ? 'existing' : 'new',
    esp_mode: existingESP.length > 0 ? 'existing' : 'new',
    ike_name: existingIKE[0]?.name || defaults.ike_name,
    esp_name: existingESP[0]?.name || defaults.esp_name,
  }
  const [s, setS] = useState<WizardState>(initial)
  const [step, setStep] = useState<'edit' | 'submitting' | 'done' | 'error'>('edit')
  const [progress, setProgress] = useState<string[]>([])
  const [err, setErr] = useState<string>('')
  const [showPSK, setShowPSK] = useState(false)

  const set = (patch: Partial<WizardState>) => setS(x => ({ ...x, ...patch }))
  const dirty = step === 'edit' && (s.peer_name !== '' || s.remote_address !== '' || s.psk !== '')

  const submit = async () => {
    const missing: string[] = []
    if (!s.peer_name) missing.push('peer name')
    if (!s.remote_address) missing.push('remote address')
    if (!s.psk) missing.push('pre-shared secret')
    if (!s.local_subnet) missing.push('local subnet')
    if (!s.remote_subnet) missing.push('remote subnet')
    if (missing.length) { setErr(`Missing required fields: ${missing.join(', ')}`); return }

    setStep('submitting')
    setErr('')
    setProgress([])

    const ike: IKEGroup = {
      name: s.ike_name,
      ike_version: 'ikev2',
      lifetime: 28800,
      dead_peer_detection: { action: 'restart', interval: 30, timeout: 120 },
      proposals: [{ number: 10, encryption: s.encryption, hash: s.hash, dh_group: s.dh_group }],
    }
    const esp: ESPGroup = {
      name: s.esp_name,
      mode: 'tunnel',
      lifetime: 3600,
      proposals: [{ number: 10, encryption: s.encryption, hash: isAEAD(s.encryption) ? '' : s.hash }],
    }
    const peer: Peer = {
      name: s.peer_name,
      description: s.description || undefined,
      remote_address: s.remote_address,
      local_address: s.local_address || undefined,
      ike_group: s.ike_name,
      default_esp_group: s.esp_name,
      authentication: {
        mode: 'pre-shared-secret',
        pre_shared_secret: s.psk,
        local_id: s.local_id || undefined,
        remote_id: s.remote_id || undefined,
      },
      tunnels: [{ number: 1, local_subnet: s.local_subnet, remote_subnet: s.remote_subnet, esp_group: s.esp_name }],
    }

    try {
      const body: { ike_group?: typeof ike; esp_group?: typeof esp; peer: typeof peer } = { peer }
      if (s.ike_mode === 'new') {
        setProgress(p => [...p, `Will create IKE group "${s.ike_name}"`])
        body.ike_group = ike
      } else {
        setProgress(p => [...p, `Reusing existing IKE group "${s.ike_name}"`])
      }
      if (s.esp_mode === 'new') {
        setProgress(p => [...p, `Will create ESP group "${s.esp_name}"`])
        body.esp_group = esp
      } else {
        setProgress(p => [...p, `Reusing existing ESP group "${s.esp_name}"`])
      }
      setProgress(p => [...p, `Committing tunnel "${s.peer_name}" atomically…`])
      await api.createTunnel(deviceId, body)
      setProgress(p => [...p, 'Done — committed to device in one atomic operation.'])
      setStep('done')
      onDone()
    } catch (e: any) {
      setErr(e?.message || String(e))
      setStep('error')
    }
  }

  return (
    <Modal
      title="Add IPsec peer"
      onClose={onClose}
      dirty={dirty}
      wide
      footer={
        step === 'edit' ? (
          <>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={submit}>Commit</button>
          </>
        ) : step === 'submitting' ? (
          <button className="btn" disabled>Working…</button>
        ) : (
          <>
            {step === 'error' && <button className="btn" onClick={() => setStep('edit')}>Back</button>}
            <button className="btn btn-primary" onClick={onClose}>Close</button>
          </>
        )
      }
    >
      {step === 'edit' && (
        <div className="modal-split">
          {/* === Left column: the form ============================ */}
          <div>
            {/* --- Identity --------------------------------------- */}
            <section className="wiz-section">
              <div className="wiz-section-head">Identity</div>
              <div className="row2">
                <div className="field">
                  <label>Peer name *</label>
                  <input type="text" value={s.peer_name} onChange={e => set({ peer_name: e.target.value })}
                    placeholder="e.g. branch-nyc" />
                </div>
                <div className="field">
                  <label>Description</label>
                  <input type="text" value={s.description} onChange={e => set({ description: e.target.value })} />
                </div>
              </div>
              <div className="row2">
                <div className="field">
                  <label>Remote gateway *</label>
                  <input type="text" value={s.remote_address} onChange={e => set({ remote_address: e.target.value })}
                    placeholder="IP or FQDN (e.g. 203.0.113.5)" />
                </div>
                <div className="field">
                  <label>Local address</label>
                  <input type="text" value={s.local_address} onChange={e => set({ local_address: e.target.value })}
                    placeholder="leave blank for any" />
                </div>
              </div>
            </section>

            {/* --- Authentication -------------------------------- */}
            <section className="wiz-section">
              <div className="wiz-section-head">Authentication</div>
              <div className="row2">
                <div className="field">
                  <label>Local ID</label>
                  <input type="text" value={s.local_id} onChange={e => set({ local_id: e.target.value })}
                    placeholder={s.local_address || 'defaults to local address'} />
                </div>
                <div className="field">
                  <label>Remote ID</label>
                  <input type="text" value={s.remote_id} onChange={e => set({ remote_id: e.target.value })}
                    placeholder={s.remote_address || 'defaults to remote address'} />
                </div>
              </div>
              <div className="field">
                <label>Pre-shared secret *</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <div style={{ position: 'relative', flex: 1 }}>
                    <input
                      type={showPSK ? 'text' : 'password'}
                      value={s.psk}
                      onChange={e => set({ psk: e.target.value })}
                      placeholder="shared with the remote side"
                      autoComplete="new-password"
                      style={{ paddingRight: 36, width: '100%' }} />
                    <button
                      type="button"
                      onClick={() => setShowPSK(v => !v)}
                      title={showPSK ? 'Hide secret' : 'Show secret'}
                      style={{
                        position: 'absolute', right: 4, top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--ink-muted)', padding: '4px 8px', fontSize: 13,
                      }}>
                      {showPSK ? 'hide' : 'show'}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => { set({ psk: generateStrongPSK() }); setShowPSK(true) }}
                    style={{ fontSize: 12, padding: '0 12px' }}
                    title="Fill a strong random secret">
                    Generate
                  </button>
                </div>
                <div className="hint" style={{ fontSize: 11, marginTop: 4 }}>
                  Stored sealed on device · redacted in audit log · min 8 chars recommended
                </div>
              </div>
            </section>

            {/* --- Traffic selectors ----------------------------- */}
            <section className="wiz-section">
              <div className="wiz-section-head">Traffic selectors</div>
              <div className="row2">
                <div className="field">
                  <label>Local subnet *</label>
                  <input type="text" value={s.local_subnet} onChange={e => set({ local_subnet: e.target.value })}
                    placeholder="10.0.1.0/24" />
                </div>
                <div className="field">
                  <label>Remote subnet *</label>
                  <input type="text" value={s.remote_subnet} onChange={e => set({ remote_subnet: e.target.value })}
                    placeholder="10.0.2.0/24" />
                </div>
              </div>
            </section>

            {/* --- Crypto profiles ------------------------------- */}
            <section className="wiz-section">
              <div className="wiz-section-head">Crypto profiles</div>

              {/* IKE row */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                  <label style={{ fontSize: 12, color: 'var(--ink-muted)', minWidth: 130 }}>
                    IKE group (phase 1)
                  </label>
                  <div className="seg">
                    <button type="button"
                      className={s.ike_mode === 'existing' ? 'active' : ''}
                      onClick={() => set({ ike_mode: 'existing', ike_name: existingIKE[0]?.name || 'IKE-DEFAULT' })}
                      disabled={existingIKE.length === 0}
                      title={existingIKE.length === 0 ? 'No existing IKE groups on this device' : ''}>
                      Use existing
                    </button>
                    <button type="button"
                      className={s.ike_mode === 'new' ? 'active' : ''}
                      onClick={() => set({ ike_mode: 'new', ike_name: 'IKE-DEFAULT' })}>
                      Create new
                    </button>
                  </div>
                </div>
                {s.ike_mode === 'existing' ? (
                  <select className="select" style={{ width: '100%' }}
                    value={s.ike_name}
                    onChange={e => set({ ike_name: e.target.value })}>
                    {existingIKE.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
                  </select>
                ) : (
                  <input type="text" value={s.ike_name}
                    onChange={e => set({ ike_name: e.target.value })}
                    placeholder="e.g. IKE-AZURE"
                    style={{ width: '100%' }} />
                )}
              </div>

              {/* ESP row */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                  <label style={{ fontSize: 12, color: 'var(--ink-muted)', minWidth: 130 }}>
                    ESP group (phase 2)
                  </label>
                  <div className="seg">
                    <button type="button"
                      className={s.esp_mode === 'existing' ? 'active' : ''}
                      onClick={() => set({ esp_mode: 'existing', esp_name: existingESP[0]?.name || 'ESP-DEFAULT' })}
                      disabled={existingESP.length === 0}
                      title={existingESP.length === 0 ? 'No existing ESP groups on this device' : ''}>
                      Use existing
                    </button>
                    <button type="button"
                      className={s.esp_mode === 'new' ? 'active' : ''}
                      onClick={() => set({ esp_mode: 'new', esp_name: 'ESP-DEFAULT' })}>
                      Create new
                    </button>
                  </div>
                </div>
                {s.esp_mode === 'existing' ? (
                  <select className="select" style={{ width: '100%' }}
                    value={s.esp_name}
                    onChange={e => set({ esp_name: e.target.value })}>
                    {existingESP.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
                  </select>
                ) : (
                  <input type="text" value={s.esp_name}
                    onChange={e => set({ esp_name: e.target.value })}
                    placeholder="e.g. ESP-AZURE"
                    style={{ width: '100%' }} />
                )}
              </div>

              {/* Cipher row — only when at least one group is being created.
                  Three short dropdowns sit naturally in a single row. */}
              {(s.ike_mode === 'new' || s.esp_mode === 'new') ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Encryption</label>
                    <select className="select" value={s.encryption} onChange={e => set({ encryption: e.target.value })}>
                      <option value="aes256">aes256</option>
                      <option value="aes128">aes128</option>
                      <option value="aes256gcm128">aes256gcm128 (AEAD)</option>
                      <option value="aes128gcm128">aes128gcm128 (AEAD)</option>
                    </select>
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Hash</label>
                    <select className="select" value={s.hash} onChange={e => set({ hash: e.target.value })}
                      disabled={isAEAD(s.encryption)}
                      title={isAEAD(s.encryption) ? 'AEAD ciphers include integrity — hash not used' : ''}>
                      <option value="sha256">sha256</option>
                      <option value="sha384">sha384</option>
                      <option value="sha512">sha512</option>
                      <option value="sha1">sha1</option>
                    </select>
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>DH group</label>
                    <select className="select" value={s.dh_group} onChange={e => set({ dh_group: e.target.value })}>
                      <option value="14">14 (2048-bit MODP)</option>
                      <option value="19">19 (256-bit ECP)</option>
                      <option value="20">20 (384-bit ECP)</option>
                      <option value="2">2 (1024-bit MODP — legacy)</option>
                    </select>
                  </div>
                </div>
              ) : (
                <div className="hint" style={{ fontSize: 11, marginTop: 4 }}>
                  Both profiles reused as-is. To change crypto parameters, switch to "Create new" above.
                </div>
              )}
            </section>

            {err && <div style={{ marginTop: 12, color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
          </div>

          {/* === Right column: live summary ====================== */}
          <SummaryPanel s={s} />
        </div>
      )}

      {step !== 'edit' && (
        <div style={{ minHeight: 100 }}>
          {progress.map((line, i) => (
            <div key={i} className="mono" style={{ fontSize: 12, marginBottom: 4 }}>· {line}</div>
          ))}
          {step === 'error' && (
            <div style={{ marginTop: 12, color: 'var(--danger)', fontSize: 12 }}>
              Failed: {err}
              <div className="hint" style={{ fontSize: 11, marginTop: 4 }}>
                The tunnel is committed atomically — nothing was written to the device.
                Adjust the fields and try again.
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

// SummaryPanel mirrors the form state so the operator can see exactly
// what will be committed before clicking Commit. Updates live as the form
// changes — uses the same WizardState the form uses, no shadow state.
function SummaryPanel({ s }: { s: WizardState }) {
  const row = (label: string, value: string) => {
    const isUnset = value === '' || value === '—'
    return (
      <div className="wiz-summary-row">
        <span className="wiz-summary-label">{label}</span>
        <span className={`wiz-summary-value${isUnset ? ' unset' : ''}`}>
          {isUnset ? '—' : value}
        </span>
      </div>
    )
  }
  return (
    <div className="wiz-summary">
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.05,
        color: 'var(--ink-muted)', marginBottom: 8, fontWeight: 500 }}>
        Configuration summary
      </div>
      {row('Peer name', s.peer_name)}
      {row('Description', s.description)}
      {row('Remote gateway', s.remote_address)}
      {row('Local address', s.local_address || 'any')}
      {row('Local subnet', s.local_subnet)}
      {row('Remote subnet', s.remote_subnet)}
      {row(`IKE (${s.ike_mode})`, s.ike_name)}
      {row(`ESP (${s.esp_mode})`, s.esp_name)}
      {(s.ike_mode === 'new' || s.esp_mode === 'new') && row('Crypto',
        `${s.encryption} / ${isAEAD(s.encryption) ? '—' : s.hash} / dh${s.dh_group}`)}
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)',
        fontSize: 11, color: 'var(--ink-muted)' }}>
        Committed atomically. On failure, nothing changes on the device.
      </div>
    </div>
  )
}


// =============================================================================
// Edit modals — one per object type (peer / IKE group / ESP group).
//
// Design notes:
//   - Names are read-only. A rename is delete-then-recreate-with-refs-updated,
//     which is a multi-object atomic op beyond v1 scope.
//   - PSK edit: the input is empty with placeholder "Leave blank to keep
//     existing". On submit, blank → omitted → backend re-supplies from device.
//   - Each modal calls its own `upsert*` endpoint and refreshes on success.
//   - All three follow the same shape: dirty tracking, validation, error
//     surface, single submit. No wizard-style multi-step here — these are
//     single-object edits.
// =============================================================================

function EditPeerModal({
  deviceId, peer, existingIKE, existingESP, onClose, onDone,
}: {
  deviceId: string
  peer: Peer
  existingIKE: IKEGroup[]
  existingESP: ESPGroup[]
  onClose: () => void
  onDone: () => void
}) {
  const [description, setDescription] = useState(peer.description || '')
  const [remoteAddress, setRemoteAddress] = useState(peer.remote_address)
  const [localAddress, setLocalAddress] = useState(peer.local_address || '')
  const [localId, setLocalId] = useState(peer.authentication?.local_id || '')
  const [remoteId, setRemoteId] = useState(peer.authentication?.remote_id || '')
  const [ikeGroup, setIkeGroup] = useState(peer.ike_group)
  const [espGroup, setEspGroup] = useState(peer.default_esp_group || '')
  const [psk, setPsk] = useState('')                 // empty → preserve existing
  const [tunnels, setTunnels] = useState<Tunnel[]>(
    (peer.tunnels && peer.tunnels.length > 0)
      ? peer.tunnels.map(t => ({ ...t }))
      : [{ number: 1, local_subnet: '', remote_subnet: '' }]
  )
  const [disabled, setDisabled] = useState(!!peer.disable)

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const dirty =
    description !== (peer.description || '') ||
    remoteAddress !== peer.remote_address ||
    localAddress !== (peer.local_address || '') ||
    localId !== (peer.authentication?.local_id || '') ||
    remoteId !== (peer.authentication?.remote_id || '') ||
    ikeGroup !== peer.ike_group ||
    espGroup !== (peer.default_esp_group || '') ||
    psk !== '' ||
    JSON.stringify(tunnels) !== JSON.stringify(peer.tunnels || []) ||
    disabled !== !!peer.disable

  const submit = async () => {
    setErr('')
    if (!remoteAddress) { setErr('Remote gateway is required'); return }
    if (!ikeGroup) { setErr('IKE group is required'); return }

    setBusy(true)
    try {
      const updated: Peer = {
        ...peer,
        description,
        disable: disabled,
        remote_address: remoteAddress,
        local_address: localAddress || undefined,
        ike_group: ikeGroup,
        default_esp_group: espGroup || undefined,
        authentication: {
          ...peer.authentication,
          pre_shared_secret: psk || undefined,
          local_id: localId || undefined,
          remote_id: remoteId || undefined,
        },
        tunnels,
      }
      await api.upsertPeer(deviceId, updated)
      onDone()
    } catch (e: any) {
      setErr(e?.message || String(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Edit peer: ${peer.name}`}
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name (read-only — rename via delete + recreate)</label>
        <input type="text" value={peer.name} readOnly
          style={{ background: 'var(--bg-subtle)', color: 'var(--ink-muted)' }} />
      </div>

      <div className="row2">
        <div className="field">
          <label>Description</label>
          <input type="text" value={description} onChange={e => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label>Status</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 4 }}>
            <input type="checkbox" checked={disabled} onChange={e => setDisabled(e.target.checked)} />
            Disabled (peer kept in config, tunnel down)
          </label>
        </div>
      </div>

      <div className="row2">
        <div className="field">
          <label>Remote gateway *</label>
          <input type="text" value={remoteAddress} onChange={e => setRemoteAddress(e.target.value)} />
        </div>
        <div className="field">
          <label>Local address</label>
          <input type="text" value={localAddress} onChange={e => setLocalAddress(e.target.value)}
            placeholder="leave blank for any" />
        </div>
      </div>

      <div className="row2">
        <div className="field">
          <label>IKE group *</label>
          <select className="select" value={ikeGroup} onChange={e => setIkeGroup(e.target.value)}>
            {existingIKE.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
            {!existingIKE.find(g => g.name === ikeGroup) &&
              <option value={ikeGroup}>{ikeGroup} (not on device)</option>}
          </select>
        </div>
        <div className="field">
          <label>Default ESP group</label>
          <select className="select" value={espGroup} onChange={e => setEspGroup(e.target.value)}>
            <option value="">(none)</option>
            {existingESP.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
            {espGroup && !existingESP.find(g => g.name === espGroup) &&
              <option value={espGroup}>{espGroup} (not on device)</option>}
          </select>
        </div>
      </div>

      <div className="field">
        <label>Pre-shared secret</label>
        <input type="password" value={psk} onChange={e => setPsk(e.target.value)}
          placeholder="Leave blank to keep existing secret" autoComplete="new-password" />
        <div className="hint" style={{ fontSize: 11 }}>
          Type a new value to rotate the secret. Blank = keep what's currently on the device.
        </div>
      </div>

      <TunnelListEditor
        tunnels={tunnels}
        onChange={setTunnels}
        espGroups={existingESP}
        defaultESPGroup={espGroup}
      />

      {err && <div style={{ marginTop: 12, color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
    </Modal>
  )
}

function EditIKEGroupModal({
  deviceId, group, onClose, onDone,
}: {
  deviceId: string
  group: IKEGroup
  onClose: () => void
  onDone: () => void
}) {
  const p0 = group.proposals[0] || { number: 10, encryption: 'aes256', hash: 'sha256', dh_group: '14' }
  const [ikeVersion, setIkeVersion] = useState<string>(group.ike_version || 'ikev2')
  const [lifetime, setLifetime] = useState(String(group.lifetime || 28800))
  const [encryption, setEncryption] = useState(p0.encryption)
  const [hash, setHash] = useState(p0.hash)
  const [dhGroup, setDhGroup] = useState(p0.dh_group)
  const [dpdAction, setDpdAction] = useState<string>(group.dead_peer_detection?.action || 'restart')
  const [dpdInterval, setDpdInterval] = useState(String(group.dead_peer_detection?.interval || 30))
  const [dpdTimeout, setDpdTimeout] = useState(String(group.dead_peer_detection?.timeout || 120))

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const dirty =
    ikeVersion !== (group.ike_version || 'ikev2') ||
    lifetime !== String(group.lifetime || 28800) ||
    encryption !== p0.encryption || hash !== p0.hash || dhGroup !== p0.dh_group ||
    dpdAction !== (group.dead_peer_detection?.action || 'restart') ||
    dpdInterval !== String(group.dead_peer_detection?.interval || 30) ||
    dpdTimeout !== String(group.dead_peer_detection?.timeout || 120)

  const submit = async () => {
    setErr('')
    setBusy(true)
    try {
      const updated: IKEGroup = {
        ...group,
        ike_version: ikeVersion as 'ikev1' | 'ikev2',
        lifetime: parseInt(lifetime, 10) || undefined,
        dead_peer_detection: {
          action: dpdAction as 'hold' | 'clear' | 'restart',
          interval: parseInt(dpdInterval, 10) || undefined,
          timeout: parseInt(dpdTimeout, 10) || undefined,
        },
        proposals: [{ number: p0.number, encryption, hash, dh_group: dhGroup }],
      }
      await api.upsertIKEGroup(deviceId, updated)
      onDone()
    } catch (e: any) {
      setErr(e?.message || String(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Edit IKE group: ${group.name}`}
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name (read-only)</label>
        <input type="text" value={group.name} readOnly
          style={{ background: 'var(--bg-subtle)', color: 'var(--ink-muted)' }} />
      </div>

      <div className="row2">
        <div className="field">
          <label>IKE version</label>
          <select className="select" value={ikeVersion} onChange={e => setIkeVersion(e.target.value)}>
            <option value="ikev2">ikev2</option>
            <option value="ikev1">ikev1</option>
          </select>
        </div>
        <div className="field">
          <label>Lifetime (seconds)</label>
          <input type="number" value={lifetime} onChange={e => setLifetime(e.target.value)} />
        </div>
      </div>

      <div className="row2">
        <div className="field">
          <label>Encryption</label>
          <select className="select" value={encryption} onChange={e => setEncryption(e.target.value)}>
            <option value="aes256">aes256</option>
            <option value="aes128">aes128</option>
            <option value="aes256gcm128">aes256gcm128 (AEAD)</option>
            <option value="aes128gcm128">aes128gcm128 (AEAD)</option>
          </select>
        </div>
        <div className="field">
          <label>Hash</label>
          <select className="select" value={hash} onChange={e => setHash(e.target.value)}>
            <option value="sha256">sha256</option>
            <option value="sha384">sha384</option>
            <option value="sha512">sha512</option>
            <option value="sha1">sha1</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label>DH group</label>
        <select className="select" value={dhGroup} onChange={e => setDhGroup(e.target.value)}>
          <option value="14">14 (2048-bit MODP)</option>
          <option value="19">19 (256-bit ECP)</option>
          <option value="20">20 (384-bit ECP)</option>
          <option value="2">2 (1024-bit MODP — legacy)</option>
        </select>
      </div>

      <div className="hint" style={{ fontSize: 12, marginTop: 12, marginBottom: 4 }}>Dead-peer detection</div>
      <div className="row2">
        <div className="field">
          <label>Action</label>
          <select className="select" value={dpdAction} onChange={e => setDpdAction(e.target.value)}>
            <option value="restart">restart</option>
            <option value="clear">clear</option>
            <option value="hold">hold</option>
          </select>
        </div>
        <div className="field">
          <label>Interval (s)</label>
          <input type="number" value={dpdInterval} onChange={e => setDpdInterval(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Timeout (s)</label>
        <input type="number" value={dpdTimeout} onChange={e => setDpdTimeout(e.target.value)} />
      </div>

      {err && <div style={{ marginTop: 12, color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
    </Modal>
  )
}

function EditESPGroupModal({
  deviceId, group, onClose, onDone,
}: {
  deviceId: string
  group: ESPGroup
  onClose: () => void
  onDone: () => void
}) {
  const p0 = group.proposals[0] || { number: 10, encryption: 'aes256', hash: 'sha256' }
  const [mode, setMode] = useState<'tunnel' | 'transport'>(group.mode || 'tunnel')
  const [pfs, setPfs] = useState(group.pfs || 'dh-group14')
  const [lifetime, setLifetime] = useState(String(group.lifetime || 3600))
  const [encryption, setEncryption] = useState(p0.encryption)
  const [hash, setHash] = useState(p0.hash || '')

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const dirty =
    mode !== (group.mode || 'tunnel') ||
    pfs !== (group.pfs || 'dh-group14') ||
    lifetime !== String(group.lifetime || 3600) ||
    encryption !== p0.encryption || hash !== (p0.hash || '')

  const submit = async () => {
    setErr('')
    setBusy(true)
    try {
      const updated: ESPGroup = {
        ...group,
        mode,
        pfs,
        lifetime: parseInt(lifetime, 10) || undefined,
        // AEAD ciphers must NOT have a hash field. The translator strips
        // empty strings, but be explicit here so the round-trip is clean.
        proposals: [{
          number: p0.number,
          encryption,
          hash: isAEAD(encryption) ? undefined : hash,
        }],
      }
      await api.upsertESPGroup(deviceId, updated)
      onDone()
    } catch (e: any) {
      setErr(e?.message || String(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Edit ESP group: ${group.name}`}
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name (read-only)</label>
        <input type="text" value={group.name} readOnly
          style={{ background: 'var(--bg-subtle)', color: 'var(--ink-muted)' }} />
      </div>

      <div className="row2">
        <div className="field">
          <label>Mode</label>
          <select className="select" value={mode} onChange={e => setMode(e.target.value as 'tunnel' | 'transport')}>
            <option value="tunnel">tunnel</option>
            <option value="transport">transport</option>
          </select>
        </div>
        <div className="field">
          <label>PFS</label>
          <select className="select" value={pfs} onChange={e => setPfs(e.target.value)}>
            <option value="dh-group14">dh-group14</option>
            <option value="dh-group19">dh-group19</option>
            <option value="dh-group20">dh-group20</option>
            <option value="dh-group2">dh-group2 (legacy)</option>
            <option value="enable">enable (negotiate)</option>
            <option value="disable">disable</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label>Lifetime (seconds)</label>
        <input type="number" value={lifetime} onChange={e => setLifetime(e.target.value)} />
      </div>

      <div className="row2">
        <div className="field">
          <label>Encryption</label>
          <select className="select" value={encryption} onChange={e => setEncryption(e.target.value)}>
            <option value="aes256">aes256</option>
            <option value="aes128">aes128</option>
            <option value="aes256gcm128">aes256gcm128 (AEAD)</option>
            <option value="aes128gcm128">aes128gcm128 (AEAD)</option>
          </select>
        </div>
        <div className="field">
          <label>Hash</label>
          {isAEAD(encryption) ? (
            <div style={{ fontSize: 12, color: 'var(--ink-faint)', padding: '8px 0' }}>
              not used (AEAD cipher provides integrity)
            </div>
          ) : (
            <select className="select" value={hash} onChange={e => setHash(e.target.value)}>
              <option value="sha256">sha256</option>
              <option value="sha384">sha384</option>
              <option value="sha512">sha512</option>
              <option value="sha1">sha1</option>
            </select>
          )}
        </div>
      </div>

      {err && <div style={{ marginTop: 12, color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
    </Modal>
  )
}

function isAEAD(cipher: string): boolean {
  return cipher.endsWith('gcm128') || cipher.endsWith('gcm96') || cipher.endsWith('gcm64') ||
    cipher.startsWith('chacha20')
}

// =============================================================================

function fmtBytes(n: number): string {
  if (!n) return '0'
  const units = ['B', 'K', 'M', 'G', 'T']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 10 ? 0 : 1)}${units[i]}`
}

function fmtUptime(s?: number): string {
  if (!s) return '—'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
