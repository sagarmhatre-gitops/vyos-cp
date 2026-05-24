#!/usr/bin/env python3
"""
patch-templates-import-from-device.py — adds "Import from device" to the
Rule-set templates page. Lets operators turn an existing rule-set on a
device into a fleet-pushable template, without retyping all the rules.

What this changes (frontend only):

  frontend/src/pages/Audit.tsx
    - New "+ Import from device" button next to "+ New template"
    - New ImportFromDeviceModal component:
        Step 1: pick device
        Step 2: pick family (ipv4/ipv6) and rule-set
        Step 3: preview — rule count, default action, group references,
                editable template name with collision warning
    - On import: closes the picker, opens the existing TemplateEditor in
      create mode pre-populated with the imported rule-set
    - The TemplateEditor's `initial` prop already accepts a RuleSet, so
      it works as-is — no editor changes needed.

Idempotent. Run from /opt/vyos-cp. No companion files needed.
"""
import os
import re
import shutil
import sys

REPO = os.getcwd()
AUDIT_PATH = "frontend/src/pages/Audit.tsx"
MARKER = "// Import from device — opens a 3-step picker"


# =========================================================================
# Patches applied in order
# =========================================================================

# Patch 1: add `listRuleSets` and `getRuleSet` to local state if not
# already imported. They're already in api.ts so this is just a usage,
# not an import. Skip.

# Patch 2: add a `Device` import. Audit.tsx may or may not have it.
# It's used to type the device list dropdown.

# Patch 3: add the state for the import modal at the top of Templates().
TEMPLATES_OPEN_OLD = '''  // editor: null = closed; { create: true } = create mode; { name } = edit mode
  const [editor, setEditor] = useState<{ create?: boolean; name?: string } | null>(null)'''

TEMPLATES_OPEN_NEW = '''  // editor: null = closed; { create: true } = create mode;
  //         { name } = edit mode (loads template by name);
  //         { create: true, seed: RuleSet } = create mode pre-populated
  //         from an imported rule-set (used by ImportFromDeviceModal).
  const [editor, setEditor] = useState<
    { create?: boolean; name?: string; seed?: RuleSet } | null
  >(null)
  const [importing, setImporting] = useState(false)'''

TEMPLATES_OPEN_MARKER = "const [importing, setImporting] = useState"


# Patch 4: add the Import button next to "+ New template".
NEW_BTN_OLD = '''        <button className="btn btn-primary" onClick={() => setEditor({ create: true })}>
          + New template
        </button>'''

NEW_BTN_NEW = '''        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setImporting(true)}
            title="Build a template from an existing rule-set on a device">
            + Import from device
          </button>
          <button className="btn btn-primary" onClick={() => setEditor({ create: true })}>
            + New template
          </button>
        </div>'''

NEW_BTN_MARKER = "+ Import from device"


# Patch 5: when the editor is opened with a `seed`, TemplateEditor needs
# to receive it as `initial`. The existing call passes `editingTemplate`
# which is the lookup-by-name. Extend to fall back to `editor.seed`.
EDITOR_CALL_OLD = '''      {editor && (
        <TemplateEditor
          mode={editor.create ? 'create' : 'edit'}
          initial={editingTemplate}
          existingNames={(templates.data || []).map(t => t.name)}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            qc.invalidateQueries({ queryKey: ['templates'] })
          }} />
      )}'''

EDITOR_CALL_NEW = '''      {editor && (
        <TemplateEditor
          mode={editor.create ? 'create' : 'edit'}
          initial={editingTemplate || editor.seed}
          existingNames={(templates.data || []).map(t => t.name)}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            qc.invalidateQueries({ queryKey: ['templates'] })
          }} />
      )}

      {importing && (
        <ImportFromDeviceModal
          devices={devices.data || []}
          existingTemplateNames={(templates.data || []).map(t => t.name)}
          onClose={() => setImporting(false)}
          onImport={(rs) => {
            setImporting(false)
            // Open the template editor in create mode with the imported
            // rule-set as initial state. Operator can review and tweak
            // before saving.
            setEditor({ create: true, seed: rs })
          }} />
      )}'''

EDITOR_CALL_MARKER = "<ImportFromDeviceModal"


# Patch 6: append the ImportFromDeviceModal component definition at
# end of file.
NEW_COMPONENT = '''
// =============================================================================
// Import from device — opens a 3-step picker
//   1. Pick device
//   2. Pick family (ipv4/ipv6) + rule-set name
//   3. Preview rule count + default action + referenced groups + template name
//
// On Import: hands the RuleSet back to the parent which opens the
// TemplateEditor in create mode pre-populated. The operator gets to
// review and tweak before persisting; nothing is saved until they click
// "Create template" in the editor.
//
// Group references in the imported rule-set are surfaced but NOT
// validated against the target devices the template might later be
// pushed to. That's intentional — templates are device-agnostic by
// design; group existence is a push-time concern. We just tell the
// operator which groups the rule-set depends on.
// =============================================================================

function ImportFromDeviceModal({ devices, existingTemplateNames, onClose, onImport }: {
  devices: Array<{ id: string; name: string; status?: string }>
  existingTemplateNames: string[]
  onClose: () => void
  onImport: (rs: RuleSet) => void
}) {
  const [deviceID, setDeviceID] = useState<string>('')
  const [family, setFamily] = useState<'ipv4' | 'ipv6'>('ipv4')
  const [rulesetName, setRulesetName] = useState<string>('')
  const [templateName, setTemplateName] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [preview, setPreview] = useState<RuleSet | null>(null)

  // Fetch rule-set list when device + family are picked. We re-fetch on
  // every change so the family toggle is responsive.
  const rulesetsQ = useQuery({
    queryKey: ['rulesets', deviceID, family],
    queryFn: () => api.listRuleSets(deviceID, family),
    enabled: !!deviceID,
    staleTime: 30_000,
  })

  // When a specific rule-set is picked, fetch its full body for preview.
  const loadPreview = async (rsName: string) => {
    setLoading(true); setErr(''); setPreview(null)
    try {
      const rs = await api.getRuleSet(deviceID, family, rsName)
      setPreview(rs)
      // Default the template name to the source rule-set name. Operator
      // can change it before importing.
      setTemplateName(rs.name)
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleSelectRuleset = (name: string) => {
    setRulesetName(name)
    if (name) loadPreview(name)
    else setPreview(null)
  }

  // List of group names this rule-set references. Surfaces to the
  // operator so they know what needs to exist on push targets.
  const referencedGroups = preview ? extractGroupReferences(preview) : []

  const nameCollides = templateName && existingTemplateNames.includes(templateName)

  const canImport = !!preview && !!templateName.trim() && /^[A-Za-z0-9_-]+$/.test(templateName)

  const doImport = () => {
    if (!preview) return
    // Hand the parent a copy with the (possibly renamed) template name.
    // The TemplateEditor will treat this as `initial` and the operator
    // can keep editing before saving.
    onImport({ ...preview, name: templateName })
  }

  return (
    <div className="modal-backdrop">
      <div className="modal wide" onClick={e => e.stopPropagation()} style={{ position: 'relative' }}>
        <div className="modal-head">
          <h2>Import rule-set from device</h2>
          <button className="btn" onClick={onClose}
            style={{ background: 'transparent', border: 0 }}>✕</button>
        </div>

        <div className="modal-body">
          {/* Step 1: device */}
          <div className="field">
            <label>Device *</label>
            <select className="select" value={deviceID}
              onChange={e => {
                setDeviceID(e.target.value)
                setRulesetName(''); setPreview(null); setErr('')
              }}>
              <option value="">Pick a device…</option>
              {devices.map(d => (
                <option key={d.id} value={d.id}>
                  {d.name}{d.status ? ` (${d.status})` : ''}
                </option>
              ))}
            </select>
            {devices.length === 0 && (
              <div className="hint" style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
                No devices registered. Add one under Devices first.
              </div>
            )}
          </div>

          {/* Step 2: family + rule-set */}
          {deviceID && (
            <div className="row2">
              <div className="field">
                <label>Family</label>
                <select className="select" value={family}
                  onChange={e => {
                    setFamily(e.target.value as 'ipv4' | 'ipv6')
                    setRulesetName(''); setPreview(null)
                  }}>
                  <option value="ipv4">ipv4</option>
                  <option value="ipv6">ipv6</option>
                </select>
              </div>
              <div className="field">
                <label>Rule-set</label>
                <select className="select" value={rulesetName}
                  onChange={e => handleSelectRuleset(e.target.value)}
                  disabled={rulesetsQ.isLoading || (rulesetsQ.data || []).length === 0}>
                  <option value="">
                    {rulesetsQ.isLoading
                      ? 'Loading…'
                      : (rulesetsQ.data || []).length === 0
                        ? `No ${family} rule-sets on this device`
                        : 'Pick a rule-set…'}
                  </option>
                  {(rulesetsQ.data || []).map(rs => (
                    <option key={rs.name} value={rs.name}>
                      {rs.name} ({rs.rules?.length ?? 0} rules)
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Step 3: preview */}
          {loading && (
            <div style={{ color: 'var(--ink-muted)', fontSize: 12, marginTop: 14 }}>
              Loading rule-set…
            </div>
          )}

          {preview && !loading && (
            <div style={{
              marginTop: 14, padding: 12,
              background: 'var(--bg-subtle)', border: '1px solid var(--line)',
              borderRadius: 6,
            }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.05,
                color: 'var(--ink-muted)', marginBottom: 8, fontWeight: 500 }}>
                Preview
              </div>
              <div className="wiz-summary-row">
                <span className="wiz-summary-label">Source rule-set</span>
                <span className="wiz-summary-value">{preview.name}</span>
              </div>
              <div className="wiz-summary-row">
                <span className="wiz-summary-label">Family</span>
                <span className="wiz-summary-value">{preview.family}</span>
              </div>
              <div className="wiz-summary-row">
                <span className="wiz-summary-label">Default action</span>
                <span className="wiz-summary-value">{preview.default_action}</span>
              </div>
              <div className="wiz-summary-row">
                <span className="wiz-summary-label">Rules</span>
                <span className="wiz-summary-value">{preview.rules?.length ?? 0}</span>
              </div>
              {referencedGroups.length > 0 && (
                <div className="wiz-summary-row" style={{ alignItems: 'flex-start' }}>
                  <span className="wiz-summary-label">Referenced groups</span>
                  <span className="wiz-summary-value" style={{ textAlign: 'right' }}>
                    {referencedGroups.map(g => (
                      <div key={g} className="mono" style={{ fontSize: 11 }}>{g}</div>
                    ))}
                  </span>
                </div>
              )}
              {referencedGroups.length > 0 && (
                <div className="hint" style={{ fontSize: 11, marginTop: 8 }}>
                  These groups must exist on every device this template is pushed to.
                  Push will fail at commit time if any are missing.
                </div>
              )}

              {/* Template name + collision warning */}
              <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
                <label>Save as template named *</label>
                <input type="text" value={templateName}
                  onChange={e => setTemplateName(e.target.value)}
                  placeholder="e.g. WAN-IN-STANDARD" />
                {!templateName.trim() && (
                  <div className="hint" style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
                    Template name is required.
                  </div>
                )}
                {templateName && !/^[A-Za-z0-9_-]+$/.test(templateName) && (
                  <div className="hint" style={{ fontSize: 11, color: 'var(--danger)' }}>
                    Letters, numbers, hyphens, and underscores only.
                  </div>
                )}
                {nameCollides && (
                  <div style={{
                    marginTop: 6, padding: '6px 10px', borderRadius: 4,
                    background: 'var(--warn-soft, #fff4d1)',
                    color: 'var(--warn-ink, #8a5a00)', fontSize: 11,
                  }}>
                    ⚠ A template named <strong>{templateName}</strong> already exists.
                    Importing will open the editor — saving will overwrite the existing template.
                  </div>
                )}
              </div>
            </div>
          )}

          {err && <div style={{ marginTop: 12, color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={doImport} disabled={!canImport}>
            Open in editor →
          </button>
        </div>
      </div>
    </div>
  )
}

// Walk a rule-set's rules and collect every group name referenced
// (address-group, network-group, port-group on source or destination).
// Used to surface dependencies in the import preview.
function extractGroupReferences(rs: RuleSet): string[] {
  const groups = new Set<string>()
  const collect = (e: any, kind: 'src' | 'dst') => {
    if (!e) return
    if (e.address_group) groups.add(`${kind}:address-group ${e.address_group}`)
    if (e.network_group) groups.add(`${kind}:network-group ${e.network_group}`)
    if (e.port_group) groups.add(`${kind}:port-group ${e.port_group}`)
  }
  for (const r of rs.rules || []) {
    collect(r.source, 'src')
    collect(r.destination, 'dst')
  }
  return Array.from(groups).sort()
}
'''

NEW_COMPONENT_MARKER = "function ImportFromDeviceModal"


# =========================================================================
# Driver
# =========================================================================

def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def patch_in_place(dst, old, new, marker, label):
    with open(dst) as f:
        text = f.read()
    if marker in text:
        print(f"  · {label}: already patched")
        return text
    if old not in text:
        die(f"{label}: anchor not found — Audit.tsx changed?")
    return text.replace(old, new, 1)


def main():
    dst = os.path.join(REPO, AUDIT_PATH)
    if not os.path.exists(dst):
        die(f"file missing: {AUDIT_PATH} (run from /opt/vyos-cp)")

    with open(dst) as f:
        text = f.read()

    if MARKER in text:
        print(f"  · {AUDIT_PATH}: already patched")
        return

    print("Adding import-from-device to Rule-set templates…\n")
    print("[1/4] Extending Templates() state for import modal")
    if TEMPLATES_OPEN_MARKER not in text:
        if TEMPLATES_OPEN_OLD not in text:
            die("state anchor not found")
        text = text.replace(TEMPLATES_OPEN_OLD, TEMPLATES_OPEN_NEW, 1)
        print(f"  ✓ state extended")
    else:
        print(f"  · state already extended")

    print("\n[2/4] Adding `+ Import from device` button")
    if NEW_BTN_MARKER not in text:
        if NEW_BTN_OLD not in text:
            die("button anchor not found")
        text = text.replace(NEW_BTN_OLD, NEW_BTN_NEW, 1)
        print(f"  ✓ button added")
    else:
        print(f"  · button already added")

    print("\n[3/4] Wiring ImportFromDeviceModal into Templates()")
    if EDITOR_CALL_MARKER not in text:
        if EDITOR_CALL_OLD not in text:
            die("editor-call anchor not found")
        text = text.replace(EDITOR_CALL_OLD, EDITOR_CALL_NEW, 1)
        print(f"  ✓ wired")
    else:
        print(f"  · already wired")

    print("\n[4/4] Appending ImportFromDeviceModal component")
    if NEW_COMPONENT_MARKER not in text:
        text = text.rstrip() + "\n" + NEW_COMPONENT
        print(f"  ✓ component appended")
    else:
        print(f"  · component already present")

    # Single write of the fully patched file. Backup once.
    bak = dst + ".bak.import-from-device"
    if not os.path.exists(bak):
        shutil.copy2(dst, bak)
    with open(dst, "w") as f:
        f.write(text)
    print()
    print("Done. Frontend-only — fast rebuild:")
    print("  docker compose down && docker compose build app && docker compose up -d")


if __name__ == "__main__":
    main()
