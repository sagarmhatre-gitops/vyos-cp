#!/usr/bin/env python3
"""
patch-templates-create-edit.py — adds create/edit UI to Rule-set templates.

What this changes:

1. frontend/src/pages/RuleSetEditor.tsx
   Exports the existing RuleModal component so the Templates page can
   reuse it. One-character change (add `export`).

2. frontend/src/pages/Audit.tsx
   Replaces the Templates() function. New behaviour:
     - "+ New template" button in the header opens the editor in create mode
     - Clicking a template row opens the editor in edit mode
     - TemplateEditor: name/family/description + list of rules with
       +Add / edit / delete using the existing RuleModal
     - Empty state replaced from "POST /api/v1/templates" with a friendly
       create-your-first call to action
     - Push and Delete preserved verbatim

Reuses the existing api.listTemplates / saveTemplate / pushTemplate /
deleteTemplate methods. No backend changes.

Idempotent. Run from /opt/vyos-cp.
"""
import os
import re
import shutil
import sys

REPO = os.getcwd()


# =========================================================================
# 1. Export RuleModal from RuleSetEditor.tsx
# =========================================================================

EDITOR_PATH = "frontend/src/pages/RuleSetEditor.tsx"

EDITOR_OLD = "function RuleModal({ initial, groups, onClose, onSave, saving }: {"
EDITOR_NEW = "export function RuleModal({ initial, groups, onClose, onSave, saving }: {"
EDITOR_MARKER = "export function RuleModal"


# =========================================================================
# 2. Replace Templates() in Audit.tsx
# =========================================================================

AUDIT_PATH = "frontend/src/pages/Audit.tsx"

# Match the Templates function from its export line to its closing brace.
# The next thing in the file is end-of-file, so we anchor on end-of-file too.
TEMPLATES_REGEX = re.compile(
    r"^export function Templates\(\) \{[\s\S]*?\n\}\n*\Z",
    re.MULTILINE,
)

TEMPLATES_MARKER = "// Templates page — create / edit / push (Option B)"

TEMPLATES_NEW = '''export function Templates() {
  // Templates page — create / edit / push (Option B)
  //
  // Templates are RuleSets (name + family + rules) stored centrally so
  // operators can define a rule-set once and push it to many devices in
  // parallel. The empty state used to be developer-only "POST /api/v1/templates";
  // this version adds a real create/edit modal that reuses RuleSetEditor's
  // RuleModal for individual rules.
  //
  // The save path is upsert: POST /api/v1/templates with the same name
  // overwrites. This is a v1 simplification — concurrent edits stomp each
  // other. Acceptable for single-operator teams; worth flagging for larger
  // ones if it becomes a real problem.
  //
  // Rename is not supported (would need delete-then-recreate atomically).
  // Name is editable on create, read-only on edit.
  const qc = useQueryClient()
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.listTemplates() })
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api.listDevices() })

  const [pushing, setPushing] = useState<string | null>(null)
  const [selectedDevs, setSelectedDevs] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<Record<string, { status: string; error?: string }> | null>(null)

  // editor: null = closed; { create: true } = create mode; { name } = edit mode
  const [editor, setEditor] = useState<{ create?: boolean; name?: string } | null>(null)

  const push = useMutation({
    mutationFn: () => api.pushTemplate(pushing!, Object.keys(selectedDevs).filter(k => selectedDevs[k])),
    onSuccess: (r) => setResults(r),
  })
  const del = useMutation({
    mutationFn: (name: string) => api.deleteTemplate(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  })

  const editingTemplate = editor?.name
    ? (templates.data || []).find(t => t.name === editor.name)
    : undefined

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 18, marginBottom: 4 }}>Rule-set templates</h1>
          <div className="hint">Define a rule-set once, push it to many devices in parallel.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditor({ create: true })}>
          + New template
        </button>
      </div>

      <div className="card">
        <table className="tbl">
          <thead><tr>
            <th>Name</th>
            <th>Family</th>
            <th>Description</th>
            <th className="right">Rules</th>
            <th className="right">Actions</th>
          </tr></thead>
          <tbody>
            {(templates.data || []).map(t => (
              <tr key={t.name}
                onClick={() => setEditor({ name: t.name })}
                style={{ cursor: 'pointer' }}
                title="Click to edit">
                <td className="mono" style={{ fontWeight: 500 }}>{t.name}</td>
                <td>{t.family}</td>
                <td className="dim" style={{ fontSize: 12 }}>
                  {t.description || <em style={{ fontStyle: 'italic' }}>—</em>}
                </td>
                <td className="right mono dim">{t.rules?.length ?? 0}</td>
                <td className="right" onClick={e => e.stopPropagation()}>
                  <button className="btn btn-primary"
                    style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => { setPushing(t.name); setResults(null); setSelectedDevs({}) }}>
                    push to fleet
                  </button>
                  {' '}
                  <button className="btn btn-danger"
                    style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => {
                      if (confirm(`Delete template "${t.name}"?\\n\\nThis only removes the template definition. Rule-sets already pushed to devices stay on those devices.`))
                        del.mutate(t.name)
                    }}
                    disabled={del.isPending}>
                    delete
                  </button>
                </td>
              </tr>
            ))}
            {(templates.data || []).length === 0 && (
              <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center' }}>
                <div style={{ color: 'var(--ink-muted)', fontSize: 13, marginBottom: 4 }}>
                  No rule-set templates yet.
                </div>
                <div style={{ color: 'var(--ink-muted)', fontSize: 11, marginBottom: 14 }}>
                  Define a firewall rule-set here, then push it to one or many devices.
                </div>
                <button className="btn btn-primary" onClick={() => setEditor({ create: true })}>
                  + Create your first template
                </button>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editor && (
        <TemplateEditor
          mode={editor.create ? 'create' : 'edit'}
          initial={editingTemplate}
          existingNames={(templates.data || []).map(t => t.name)}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            qc.invalidateQueries({ queryKey: ['templates'] })
          }} />
      )}

      {pushing && (
        <div className="modal-backdrop">
          <div className="modal" onClick={e => e.stopPropagation()} style={{ position: 'relative' }}>
            <div className="modal-head">
              <h2>Push "{pushing}" to…</h2>
              <button className="btn" onClick={() => setPushing(null)}
                style={{ background: 'transparent', border: 0 }}>✕</button>
            </div>
            <div className="modal-body">
              {(devices.data || []).length === 0 && (
                <div style={{ color: 'var(--ink-muted)', fontSize: 12, padding: 8 }}>
                  No devices registered.
                </div>
              )}
              {(devices.data || []).map(d => (
                <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                  <input type="checkbox" checked={!!selectedDevs[d.id]}
                    onChange={e => setSelectedDevs(s => ({ ...s, [d.id]: e.target.checked }))} />
                  <span className="mono">{d.name}</span>
                  <span className={`status ${d.status}`}><span className="d"/>{d.status}</span>
                </label>
              ))}
              {results && (
                <div style={{ marginTop: 14 }}>
                  <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--ink-muted)', letterSpacing: '0.05em', marginBottom: 6 }}>Results</h3>
                  {Object.entries(results).map(([devID, r]) => {
                    const d = (devices.data || []).find(x => x.id === devID)
                    return (
                      <div key={devID} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                        <span className="mono">{d?.name || devID}</span>
                        {r.status === 'ok' ? <span className="badge ok">ok</span> :
                          <span className="badge danger" title={r.error}>{r.error?.slice(0, 40) || 'failed'}</span>}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setPushing(null)}>Close</button>
              <button className="btn btn-primary"
                disabled={push.isPending || Object.keys(selectedDevs).filter(k => selectedDevs[k]).length === 0}
                onClick={() => push.mutate()}>
                {push.isPending ? 'Pushing…' : `Push to ${Object.keys(selectedDevs).filter(k => selectedDevs[k]).length} device(s)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// =============================================================================
// TemplateEditor — create or edit a single template
//
// The template body is a RuleSet (name + family + description + rules[]).
// The rule-editing UI is RuleModal from RuleSetEditor.tsx — same component
// the per-device flow uses, passed an empty groups array (templates don't
// have a device, so no autocomplete; operators type group names directly).
// =============================================================================

function TemplateEditor({ mode, initial, existingNames, onClose, onSaved }: {
  mode: 'create' | 'edit'
  initial?: RuleSet
  existingNames: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const blank: RuleSet = {
    name: '', family: 'ipv4', default_action: 'drop',
    description: '', rules: [],
  }
  const [t, setT] = useState<RuleSet>(initial ? structuredClone(initial) : blank)
  const [editingRule, setEditingRule] = useState<{ rule: Rule; isNew: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const dirty = mode === 'create'
    ? (t.name !== '' || t.description !== '' || (t.rules?.length ?? 0) > 0)
    : initial != null && JSON.stringify(t) !== JSON.stringify(initial)

  const update = (patch: Partial<RuleSet>) => setT(x => ({ ...x, ...patch }))

  const nextRuleNumber = (): number => {
    const used = new Set((t.rules || []).map(r => r.number))
    // Standard convention: rule numbers in 10s so there's room to insert
    // between them later (10, 20, 30…). Find the first unused 10-multiple.
    for (let n = 10; n < 65535; n += 10) {
      if (!used.has(n)) return n
    }
    return Math.max(...used) + 1
  }

  const blankRule = (): Rule => ({
    number: nextRuleNumber(),
    action: 'accept',
    description: '',
  })

  const saveRule = (rule: Rule) => {
    setT(x => {
      const rules = [...(x.rules || [])]
      const existingIdx = rules.findIndex(r => r.number === rule.number)
      if (existingIdx >= 0 && !editingRule?.isNew) {
        rules[existingIdx] = rule
      } else if (existingIdx >= 0) {
        // Trying to add a new rule with a number that already exists.
        // RuleModal allows the user to change the number; if they
        // collided, replace the existing rule.
        rules[existingIdx] = rule
      } else {
        rules.push(rule)
        rules.sort((a, b) => a.number - b.number)
      }
      return { ...x, rules }
    })
    setEditingRule(null)
  }

  const removeRule = (number: number) => {
    if (!confirm(`Remove rule ${number} from this template?`)) return
    setT(x => ({ ...x, rules: (x.rules || []).filter(r => r.number !== number) }))
  }

  const save = async () => {
    setErr('')
    if (!t.name.trim()) { setErr('Name is required'); return }
    // Names should be VyOS-safe: alphanumeric, hyphen, underscore. No spaces.
    if (!/^[A-Za-z0-9_-]+$/.test(t.name)) {
      setErr('Name must contain only letters, numbers, hyphens, and underscores')
      return
    }
    if (mode === 'create' && existingNames.includes(t.name)) {
      setErr(`A template named "${t.name}" already exists`)
      return
    }
    setSaving(true)
    try {
      await api.saveTemplate(t)
      onSaved()
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modal-backdrop">
        <div className="modal wide" onClick={e => e.stopPropagation()} style={{ position: 'relative' }}>
          <div className="modal-head">
            <h2>{mode === 'create' ? 'New template' : `Edit template: ${t.name}`}</h2>
            <button className="btn" onClick={() => {
              if (dirty && !confirm('Discard your changes?')) return
              onClose()
            }} style={{ background: 'transparent', border: 0 }}>✕</button>
          </div>

          <div className="modal-body">
            {/* --- Identity ----------------------------------------- */}
            <div className="row2">
              <div className="field">
                <label>Name *</label>
                <input type="text" value={t.name}
                  onChange={e => update({ name: e.target.value })}
                  placeholder="e.g. WAN-IN-STANDARD"
                  disabled={mode === 'edit'}
                  style={mode === 'edit' ? { background: 'var(--bg-subtle)', cursor: 'not-allowed' } : undefined}
                  title={mode === 'edit' ? 'Rename is not supported. Delete and recreate to change the name.' : ''} />
                {mode === 'edit' && (
                  <div className="hint" style={{ fontSize: 11 }}>
                    Names cannot be changed. Delete and recreate to rename.
                  </div>
                )}
              </div>
              <div className="field">
                <label>Family</label>
                <select className="select" value={t.family}
                  onChange={e => update({ family: e.target.value })}>
                  <option value="ipv4">ipv4</option>
                  <option value="ipv6">ipv6</option>
                </select>
              </div>
            </div>

            <div className="row2">
              <div className="field">
                <label>Default action</label>
                <select className="select" value={t.default_action}
                  onChange={e => update({ default_action: e.target.value })}>
                  <option value="drop">drop</option>
                  <option value="reject">reject</option>
                  <option value="accept">accept</option>
                </select>
                <div className="hint" style={{ fontSize: 11 }}>
                  Applied when no rule matches.
                </div>
              </div>
              <div className="field">
                <label>Description</label>
                <input type="text" value={t.description || ''}
                  onChange={e => update({ description: e.target.value })}
                  placeholder="What this rule-set does" />
              </div>
            </div>

            {/* --- Rules -------------------------------------------- */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginTop: 14, marginBottom: 8,
            }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.05,
                color: 'var(--ink-muted)', fontWeight: 500 }}>
                Rules
              </div>
              <button className="btn"
                onClick={() => setEditingRule({ rule: blankRule(), isNew: true })}
                style={{ fontSize: 11, padding: '4px 10px' }}>
                + Add rule
              </button>
            </div>

            {(t.rules?.length ?? 0) === 0 ? (
              <div style={{
                padding: 16, textAlign: 'center', color: 'var(--ink-muted)', fontSize: 12,
                border: '1px dashed var(--line)', borderRadius: 6,
              }}>
                No rules yet. Click "+ Add rule" to define one.
              </div>
            ) : (
              <table className="tbl" style={{ fontSize: 12 }}>
                <thead><tr>
                  <th style={{ width: 60 }}>#</th>
                  <th style={{ width: 80 }}>Action</th>
                  <th style={{ width: 70 }}>Proto</th>
                  <th>Source</th>
                  <th>Destination</th>
                  <th className="right">Flags</th>
                  <th className="right">Actions</th>
                </tr></thead>
                <tbody>
                  {(t.rules || []).map(r => (
                    <tr key={r.number} onClick={() => setEditingRule({ rule: r, isNew: false })}
                      style={{ cursor: 'pointer' }} title="Click to edit">
                      <td className="mono">{r.number}</td>
                      <td><span className={`badge ${actionBadgeClass(r.action)}`}>{r.action}</span></td>
                      <td className="mono dim">{r.protocol || '—'}</td>
                      <td className="mono dim" style={{ fontSize: 11 }}>{ruleEndpointSummary(r.source)}</td>
                      <td className="mono dim" style={{ fontSize: 11 }}>{ruleEndpointSummary(r.destination)}</td>
                      <td className="right">
                        {r.log && <span className="badge" style={{ marginRight: 2 }}>log</span>}
                        {r.disable && <span className="badge" style={{ marginRight: 2 }}>off</span>}
                      </td>
                      <td className="right" onClick={e => e.stopPropagation()}>
                        <button className="btn btn-danger"
                          style={{ height: 22, padding: '0 6px', fontSize: 11 }}
                          onClick={() => removeRule(r.number)}>
                          remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {err && <div style={{ marginTop: 14, color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
          </div>

          <div className="modal-foot">
            <button className="btn" onClick={() => {
              if (dirty && !confirm('Discard your changes?')) return
              onClose()
            }}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : mode === 'create' ? 'Create template' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>

      {/* Rule edit nested modal — reuses RuleSetEditor's RuleModal */}
      {editingRule && (
        <RuleModal
          initial={editingRule.rule}
          groups={[]}
          onClose={() => setEditingRule(null)}
          onSave={saveRule}
          saving={false} />
      )}
    </>
  )
}

// --- Tiny helpers used by the template rules table -------------------------

function actionBadgeClass(action: string): string {
  switch (action) {
    case 'accept': return 'ok'
    case 'drop': case 'reject': return 'danger'
    default: return ''
  }
}

function ruleEndpointSummary(e: any): string {
  if (!e) return '—'
  const bits: string[] = []
  if (e.address) bits.push(e.address)
  if (e.network) bits.push(e.network)
  if (e.address_group) bits.push(`@${e.address_group}`)
  if (e.network_group) bits.push(`@${e.network_group}`)
  if (e.port) bits.push(`:${e.port}`)
  if (e.port_group) bits.push(`:@${e.port_group}`)
  return bits.length > 0 ? bits.join(' ') : 'any'
}
'''


# =========================================================================
# Driver
# =========================================================================

def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def patch_editor():
    dst = os.path.join(REPO, EDITOR_PATH)
    if not os.path.exists(dst):
        die(f"file missing: {EDITOR_PATH}")
    with open(dst) as f:
        text = f.read()
    if EDITOR_MARKER in text:
        print(f"  · {EDITOR_PATH}: RuleModal already exported")
        return
    if EDITOR_OLD not in text:
        die(f"{EDITOR_PATH}: anchor not found — RuleModal signature changed?")
    bak = dst + ".bak.templates-create-edit"
    if not os.path.exists(bak):
        shutil.copy2(dst, bak)
    with open(dst, "w") as f:
        f.write(text.replace(EDITOR_OLD, EDITOR_NEW, 1))
    print(f"  ✓ {EDITOR_PATH}: RuleModal exported")


def patch_audit():
    dst = os.path.join(REPO, AUDIT_PATH)
    if not os.path.exists(dst):
        die(f"file missing: {AUDIT_PATH}")
    with open(dst) as f:
        text = f.read()
    if TEMPLATES_MARKER in text:
        print(f"  · {AUDIT_PATH}: Templates already patched")
        return

    # Find the Templates() function and everything after it (it's the last
    # thing in the file).
    m = TEMPLATES_REGEX.search(text)
    if not m:
        die(f"{AUDIT_PATH}: could not locate Templates() function")

    # Need to make sure Rule, RuleSet, RuleModal are imported.
    # Existing imports: import { api, AuditEntry, RuleSet } from '../lib/api'
    # We need: AuditEntry, Rule, RuleSet from api lib; RuleModal from RuleSetEditor.
    # Inspect current imports and add only what's missing.
    new_text = text[:m.start()] + TEMPLATES_NEW
    bak = dst + ".bak.templates-create-edit"
    if not os.path.exists(bak):
        shutil.copy2(dst, bak)

    # Update top-level imports.
    # Old: import { api } from '../lib/api'
    # New: import { api, Rule, RuleSet } from '../lib/api'  (+ RuleModal from RuleSetEditor)
    import_old = "import { api } from '../lib/api'"
    import_new = ("import { api, Rule, RuleSet } from '../lib/api'\n"
                  "import { RuleModal } from './RuleSetEditor'")
    if import_old in new_text:
        new_text = new_text.replace(import_old, import_new, 1)
    else:
        # Maybe imports were already partially extended; try a more
        # forgiving anchor. Bail with a clear message if not.
        if "from '../lib/api'" not in new_text:
            die(f"{AUDIT_PATH}: api imports not found")
        # Already imports something from api. Tack RuleModal import on as
        # a separate line right after the existing api import.
        api_import_line_regex = re.compile(r"^(import \{[^}]*\} from '\.\./lib/api')$", re.MULTILINE)
        m2 = api_import_line_regex.search(new_text)
        if not m2:
            die(f"{AUDIT_PATH}: could not place RuleModal import")
        # Ensure Rule and RuleSet are in the api import list.
        line = m2.group(1)
        if "Rule" not in line:
            line2 = line.replace("api,", "api, Rule, RuleSet,").replace("{ api }", "{ api, Rule, RuleSet }")
            new_text = new_text.replace(m2.group(1), line2, 1)
        # Add RuleModal import after this line.
        new_text = new_text.replace(line, line + "\nimport { RuleModal } from './RuleSetEditor'", 1)

    with open(dst, "w") as f:
        f.write(new_text)
    print(f"  ✓ {AUDIT_PATH}: Templates rewritten with create/edit UI")


def main():
    print("Adding create/edit UI to Rule-set templates…\n")
    print("[1/2] Exporting RuleModal from RuleSetEditor.tsx")
    patch_editor()
    print("\n[2/2] Rewriting Templates() in Audit.tsx")
    patch_audit()
    print()
    print("Done. Frontend-only — fast rebuild:")
    print("  docker compose down && docker compose build app && docker compose up -d")


if __name__ == "__main__":
    main()
