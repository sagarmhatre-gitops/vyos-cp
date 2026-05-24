#!/usr/bin/env python3
"""
patch-add-peer-wizard-refresh.py — visual refresh for the Add IPsec Peer
wizard. Pure UI work: same backend, same fields, same submit flow.

What changes:

1. frontend/src/index.css — adds .modal.wide and .modal.split styles for
   the two-column wizard layout.

2. frontend/src/pages/IPsec.tsx — replaces the AddPeerWizard component
   with a redesigned version:
     - Two-column layout (form left, Configuration Summary right) on
       screens >= 1024px; collapses to single column below
     - Section headers with light dividers (Identity / Authentication /
       Traffic selectors / Crypto profiles)
     - PSK: show/hide eye, Generate-strong button, calm one-line hint
       replacing the misleading "Audit log redaction is a known TODO"
     - Crypto profiles: segmented toggle ("Use existing | Create new")
       replacing the mixed-mode dropdown
     - Encryption / Hash / DH group on one row of three when creating new
     - Updated error message: now reflects the atomic-batching behaviour
       (no orphan groups on failure)
     - Configuration Summary panel: live mirror of the form state

3. No other files touched. No backend changes. Same validation, same
   createTunnel call.

Idempotent. Run from /opt/vyos-cp. Expects no companion files — the patch
embeds the entire new AddPeerWizard inline.
"""
import os
import re
import shutil
import sys

REPO = os.getcwd()

# =========================================================================
# CSS additions
# =========================================================================

CSS_PATH = "frontend/src/index.css"

# Anchor on the existing .modal rule. Insert new rules right after it.
CSS_ANCHOR = """.modal {
  background: var(--bg-raised); border-radius: var(--radius-lg);
  width: min(560px, 92vw); max-height: 88vh; overflow-y: auto;
  box-shadow: var(--shadow);
}"""

CSS_INSERT = """.modal {
  background: var(--bg-raised); border-radius: var(--radius-lg);
  width: min(560px, 92vw); max-height: 88vh; overflow-y: auto;
  box-shadow: var(--shadow);
}

/* Wider variant for forms that benefit from a side summary panel. */
.modal.wide { width: min(880px, 94vw); }

/* Two-column layout used inside the wizard. On narrow screens it
   collapses to a single column so the form remains usable. */
.modal-split { display: grid; gap: 18px; grid-template-columns: 1fr; }
@media (min-width: 900px) {
  .modal-split { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); }
}

/* Section divider in the wizard. Visually groups Identity / Auth /
   Networks / Crypto without nesting card frames inside the modal. */
.wiz-section { padding-top: 14px; margin-top: 14px; border-top: 1px solid var(--line); }
.wiz-section:first-child { padding-top: 0; margin-top: 0; border-top: 0; }
.wiz-section-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--ink-muted); margin-bottom: 10px; font-weight: 500; }

/* Segmented toggle for "use existing | create new" choices. */
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.seg button {
  background: var(--bg); color: var(--ink-muted);
  border: 0; padding: 5px 12px; font-size: 12px; cursor: pointer;
  border-right: 1px solid var(--line);
}
.seg button:last-child { border-right: 0; }
.seg button.active { background: var(--brand-soft, #e6f0ff); color: var(--brand-ink, var(--brand)); font-weight: 500; }

/* Summary card in the right column. */
.wiz-summary {
  background: var(--bg-subtle); border: 1px solid var(--line); border-radius: 8px;
  padding: 14px; font-size: 12px; align-self: start;
}
.wiz-summary-row { display: flex; justify-content: space-between; padding: 4px 0; gap: 10px; }
.wiz-summary-row + .wiz-summary-row { border-top: 1px solid var(--line); }
.wiz-summary-label { color: var(--ink-muted); }
.wiz-summary-value { color: var(--ink); font-family: var(--font-mono);
  text-align: right; word-break: break-word; max-width: 60%; }
.wiz-summary-value.unset { color: var(--ink-muted); font-style: italic; font-family: inherit; }"""

CSS_MARKER = ".modal.wide { width: min(880px, 94vw); }"


# =========================================================================
# AddPeerWizard replacement
# =========================================================================

IPSEC_PATH = "frontend/src/pages/IPsec.tsx"

# Match the full existing AddPeerWizard function. We anchor on the
# function start line and the closing }/comment that follows it.
WIZARD_REGEX = re.compile(
    r"^function AddPeerWizard\(\{[\s\S]*?\n\}\n",
    re.MULTILINE,
)

# Sentinel string that lets us detect "this patch was already applied".
WIZARD_MARKER = "// Add Peer wizard — visual refresh (Option 1)"

WIZARD_NEW = '''// Add Peer wizard — visual refresh (Option 1)
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
      authentication: { mode: 'pre-shared-secret', pre_shared_secret: s.psk },
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

'''


# =========================================================================
# Modal component — add wide prop
# =========================================================================

MODAL_PATH = "frontend/src/components/Modal.tsx"

MODAL_OLD_SIG = '''export function Modal({ title, onClose, dirty, busy, children, footer }: {
  title: string
  onClose: () => void
  dirty?: boolean
  busy?: boolean
  children: ReactNode
  footer?: ReactNode
}) {'''

MODAL_NEW_SIG = '''export function Modal({ title, onClose, dirty, busy, children, footer, wide }: {
  title: string
  onClose: () => void
  dirty?: boolean
  busy?: boolean
  children: ReactNode
  footer?: ReactNode
  /** If true, use the wider .modal.wide variant (880px). Used by the
   *  Add IPsec peer wizard which has a side summary panel. */
  wide?: boolean
}) {'''

MODAL_OLD_DIV = '<div className="modal" onClick={e => e.stopPropagation()} style={{ position: \'relative\' }}>'
MODAL_NEW_DIV = '<div className={"modal" + (wide ? " wide" : "")} onClick={e => e.stopPropagation()} style={{ position: \'relative\' }}>'

MODAL_MARKER = "wide?: boolean"


# =========================================================================
# Driver
# =========================================================================

def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def patch_css():
    dst = os.path.join(REPO, CSS_PATH)
    if not os.path.exists(dst):
        die(f"file missing: {CSS_PATH}")
    with open(dst) as f:
        text = f.read()
    if CSS_MARKER in text:
        print(f"  · {CSS_PATH}: already patched")
        return
    if CSS_ANCHOR not in text:
        die(f"{CSS_PATH}: CSS anchor not found — .modal rule changed?")
    bak = dst + ".bak.wizard-refresh"
    if not os.path.exists(bak):
        shutil.copy2(dst, bak)
    with open(dst, "w") as f:
        f.write(text.replace(CSS_ANCHOR, CSS_INSERT, 1))
    print(f"  ✓ {CSS_PATH}: wizard CSS appended")


def patch_modal_component():
    dst = os.path.join(REPO, MODAL_PATH)
    if not os.path.exists(dst):
        die(f"file missing: {MODAL_PATH}")
    with open(dst) as f:
        text = f.read()
    if MODAL_MARKER in text:
        print(f"  · {MODAL_PATH}: already patched")
        return
    if MODAL_OLD_SIG not in text:
        die(f"{MODAL_PATH}: signature anchor not found — Modal.tsx changed?")
    if MODAL_OLD_DIV not in text:
        die(f"{MODAL_PATH}: div anchor not found")
    bak = dst + ".bak.wizard-refresh"
    if not os.path.exists(bak):
        shutil.copy2(dst, bak)
    text = text.replace(MODAL_OLD_SIG, MODAL_NEW_SIG, 1)
    text = text.replace(MODAL_OLD_DIV, MODAL_NEW_DIV, 1)
    with open(dst, "w") as f:
        f.write(text)
    print(f"  ✓ {MODAL_PATH}: added `wide` prop")


def patch_wizard():
    dst = os.path.join(REPO, IPSEC_PATH)
    if not os.path.exists(dst):
        die(f"file missing: {IPSEC_PATH}")
    with open(dst) as f:
        text = f.read()
    if WIZARD_MARKER in text:
        print(f"  · {IPSEC_PATH}: already patched")
        return
    m = WIZARD_REGEX.search(text)
    if not m:
        die(f"{IPSEC_PATH}: could not locate AddPeerWizard function")
    bak = dst + ".bak.wizard-refresh"
    if not os.path.exists(bak):
        shutil.copy2(dst, bak)
    new_text = text[:m.start()] + WIZARD_NEW + text[m.end():]
    with open(dst, "w") as f:
        f.write(new_text)
    print(f"  ✓ {IPSEC_PATH}: AddPeerWizard replaced ({m.end() - m.start()} → {len(WIZARD_NEW)} chars)")


def main():
    print("Applying Add Peer wizard visual refresh…\n")
    print("[1/3] index.css — adding wizard styles")
    patch_css()
    print("\n[2/3] Modal.tsx — adding `wide` prop")
    patch_modal_component()
    print("\n[3/3] IPsec.tsx — replacing AddPeerWizard")
    patch_wizard()
    print()
    print("Done. Frontend-only — fast rebuild:")
    print("  docker compose down && docker compose build app && docker compose up -d")


if __name__ == "__main__":
    main()
