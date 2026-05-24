import { Fragment, useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api, Rule, RuleSet } from '../lib/api'
import { RuleModal } from './RuleSetEditor'

// Audit log with filtering — client-side filtering on the same 200-row
// fetch we did before. As the system gets used, the raw list grows fast
// (a single IPsec wizard run produces a 12+ op audit row, and operators
// scan back to confirm "what changed?"). Filters narrow the view to the
// rows that matter for the question being asked.
//
// Filters are reflected in URL params so a filtered view is bookmarkable
// and shareable in postmortems: ?action=ipsec&result=failed&user=alice
// is a self-contained snapshot of "every failed IPsec change alice made."

type ResultFilter = 'all' | 'ok' | 'failed'

export function Audit() {
  const q = useQuery({ queryKey: ['audit', ''], queryFn: () => api.listAudit('', 200) })
  const [expanded, setExpanded] = useState<number | null>(null)

  // Filter state, mirrored to the URL so views are shareable.
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState(params.get('q') || '')
  const [actionPrefix, setActionPrefix] = useState(params.get('action') || 'all')
  const [deviceFilter, setDeviceFilter] = useState(params.get('device') || 'all')
  const [userFilter, setUserFilter] = useState(params.get('user') || 'all')
  const [resultFilter, setResultFilter] = useState<ResultFilter>(
    (params.get('result') as ResultFilter) || 'all')

  // Push state changes back to URL params, omitting the default 'all' so
  // URLs stay short.
  useEffect(() => {
    const next = new URLSearchParams()
    if (search) next.set('q', search)
    if (actionPrefix !== 'all') next.set('action', actionPrefix)
    if (deviceFilter !== 'all') next.set('device', deviceFilter)
    if (userFilter !== 'all') next.set('user', userFilter)
    if (resultFilter !== 'all') next.set('result', resultFilter)
    setParams(next, { replace: true })
  }, [search, actionPrefix, deviceFilter, userFilter, resultFilter, setParams])

  const entries = q.data || []

  // Derive the dropdown options from the actual data so we never show
  // a "ipsec.*" filter on a fleet that has no IPsec activity, etc.
  // Prefixes are the first dot-separated segment of the action — for
  // "ipsec.peer.upsert" that's "ipsec".
  const actionPrefixes = useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) {
      const dot = e.action.indexOf('.')
      if (dot > 0) set.add(e.action.slice(0, dot))
    }
    return Array.from(set).sort()
  }, [entries])

  const deviceOptions = useMemo(() => {
    const set = new Set<string>()
    let hasFleetWide = false
    for (const e of entries) {
      if (e.device) set.add(e.device)
      else hasFleetWide = true
    }
    const list = Array.from(set).sort()
    if (hasFleetWide) list.push('__fleet__')
    return list
  }, [entries])

  const userOptions = useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) {
      if (e.user_name) set.add(e.user_name)
    }
    return Array.from(set).sort()
  }, [entries])

  // Apply the filter chain. Order is cheap-to-expensive: equality checks
  // first, free-text search last.
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return entries.filter(e => {
      if (actionPrefix !== 'all' && !e.action.startsWith(actionPrefix + '.')) return false
      if (deviceFilter !== 'all') {
        if (deviceFilter === '__fleet__') {
          if (e.device) return false
        } else if (e.device !== deviceFilter) {
          return false
        }
      }
      if (userFilter !== 'all' && e.user_name !== userFilter) return false
      if (resultFilter === 'ok' && !e.success) return false
      if (resultFilter === 'failed' && e.success) return false
      if (needle) {
        const hay = [e.action, e.device, e.user_name, e.user_id, e.error_msg]
          .filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [entries, search, actionPrefix, deviceFilter, userFilter, resultFilter])

  const filtersActive = search || actionPrefix !== 'all' || deviceFilter !== 'all'
    || userFilter !== 'all' || resultFilter !== 'all'

  const clearFilters = () => {
    setSearch('')
    setActionPrefix('all')
    setDeviceFilter('all')
    setUserFilter('all')
    setResultFilter('all')
  }

  return (
    <>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Audit log</h1>
      <div className="hint" style={{ marginBottom: 16 }}>
        Every device write, who ran it, and the exact VyOS ops that were committed.
      </div>

      {/* Filter bar */}
      <div className="card" style={{ marginBottom: 12, padding: 10 }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 160px 180px 160px 200px auto',
          gap: 8, alignItems: 'center',
        }}>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search action, device, user, error message…"
            style={{
              padding: '6px 10px', fontSize: 12,
              border: '1px solid var(--line)', borderRadius: 4,
              background: 'var(--bg)', color: 'var(--ink)',
            }}
          />

          <select className="select" value={actionPrefix}
            onChange={e => setActionPrefix(e.target.value)}
            style={{ fontSize: 12, padding: '6px 8px' }}
            title="Filter by action namespace">
            <option value="all">All actions</option>
            {actionPrefixes.map(p => (
              <option key={p} value={p}>{p}.*</option>
            ))}
          </select>

          <select className="select" value={deviceFilter}
            onChange={e => setDeviceFilter(e.target.value)}
            style={{ fontSize: 12, padding: '6px 8px' }}
            title="Filter by target device">
            <option value="all">All devices</option>
            {deviceOptions.map(d => (
              <option key={d} value={d}>
                {d === '__fleet__' ? '(fleet-wide)' : d}
              </option>
            ))}
          </select>

          <select className="select" value={userFilter}
            onChange={e => setUserFilter(e.target.value)}
            style={{ fontSize: 12, padding: '6px 8px' }}
            title="Filter by user who ran the action">
            <option value="all">All users</option>
            {userOptions.map(u => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>

          <div style={{ display: 'flex', gap: 4, fontSize: 11 }}>
            <ResultRadio current={resultFilter} value="all" label="All" onChange={setResultFilter} />
            <ResultRadio current={resultFilter} value="ok" label="OK" onChange={setResultFilter} />
            <ResultRadio current={resultFilter} value="failed" label="Failed" onChange={setResultFilter} />
          </div>

          <button
            className="btn"
            onClick={clearFilters}
            disabled={!filtersActive}
            style={{
              fontSize: 11, padding: '6px 10px',
              opacity: filtersActive ? 1 : 0.4,
              cursor: filtersActive ? 'pointer' : 'default',
            }}
            title="Reset all filters">
            Clear
          </button>
        </div>

        {/* Result count */}
        <div style={{
          marginTop: 8, fontSize: 11, color: 'var(--ink-muted)',
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>
            Showing <strong style={{ color: 'var(--ink)' }}>{filtered.length}</strong>
            {' of '}
            <strong style={{ color: 'var(--ink)' }}>{entries.length}</strong> entries
            {filtersActive && ' (filtered)'}
          </span>
          {filtered.length > 0 && (
            <span>
              {filtered.filter(e => e.success).length} ok
              {' · '}
              <span style={{ color: filtered.some(e => !e.success) ? 'var(--danger)' : undefined }}>
                {filtered.filter(e => !e.success).length} failed
              </span>
            </span>
          )}
        </div>
      </div>

      <div className="card">
        <table className="tbl">
          <thead><tr>
            <th style={{ width: 140 }}>When</th><th>User</th><th>Device</th>
            <th>Action</th><th>Ops</th><th>Result</th>
          </tr></thead>
          <tbody>
            {filtered.map(e => (
              <Fragment key={e.id}>
                <tr onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                  <td className="mono dim">{new Date(e.timestamp).toLocaleString()}</td>
                  <td>{e.user_name || <span className="dim">system</span>}</td>
                  <td className="mono">{e.device || <span className="dim">—</span>}</td>
                  <td className="mono">{e.action}</td>
                  <td className="dim">{e.ops?.length || 0} op{e.ops?.length === 1 ? '' : 's'}</td>
                  <td>
                    {e.success ? <span className="badge ok">ok</span> : <span className="badge danger">failed</span>}
                  </td>
                </tr>
                {expanded === e.id && (
                  <tr><td colSpan={6} style={{ background: 'var(--bg-subtle)' }}>
                    <div className="diff">
                      {(e.ops || []).map((op, i) => (
                        <div key={i} className={op.op === 'delete' ? 'del' : 'add'}>
                          {op.op === 'delete' ? '− ' : '+ '}
                          {op.op} {op.path.join(' ')}{op.value ? ` ${JSON.stringify(op.value)}` : ''}
                        </div>
                      ))}
                    </div>
                    {e.error_msg && <div className="err" style={{ marginTop: 8 }}>{e.error_msg}</div>}
                  </td></tr>
                )}
              </Fragment>
            ))}
            {filtered.length === 0 && entries.length > 0 && (
              <tr><td colSpan={6} style={{
                padding: 20, textAlign: 'center', color: 'var(--ink-muted)', fontSize: 12,
              }}>
                No entries match the current filters.{' '}
                <button onClick={clearFilters}
                  style={{
                    background: 'transparent', border: 'none', padding: 0,
                    color: 'var(--brand)', cursor: 'pointer', textDecoration: 'underline',
                  }}>
                  Clear filters
                </button>
              </td></tr>
            )}
            {entries.length === 0 && (
              <tr><td colSpan={6} style={{
                padding: 20, textAlign: 'center', color: 'var(--ink-muted)', fontSize: 12,
              }}>
                {q.isLoading ? 'Loading…' : 'No audit entries yet.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

function ResultRadio({ current, value, label, onChange }: {
  current: ResultFilter; value: ResultFilter; label: string
  onChange: (v: ResultFilter) => void
}) {
  const active = current === value
  return (
    <button onClick={() => onChange(value)}
      style={{
        padding: '4px 10px', fontSize: 11, fontWeight: active ? 500 : 400,
        border: `1px solid ${active ? 'var(--brand)' : 'var(--line)'}`,
        background: active ? 'var(--brand-soft, #e6f0ff)' : 'var(--bg)',
        color: active ? 'var(--brand-ink, var(--brand))' : 'var(--ink-muted)',
        borderRadius: 4, cursor: 'pointer',
      }}>
      {label}
    </button>
  )
}

// =============================================================================
// Templates page is unchanged. Imported into router same as before.
// =============================================================================

export function Templates() {
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

  // editor: null = closed; { create: true } = create mode;
  //         { name } = edit mode (loads template by name);
  //         { create: true, seed: RuleSet } = create mode pre-populated
  //         from an imported rule-set (used by ImportFromDeviceModal).
  const [editor, setEditor] = useState<
    { create?: boolean; name?: string; seed?: RuleSet } | null
  >(null)
  const [importing, setImporting] = useState(false)

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
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setImporting(true)}
            title="Build a template from an existing rule-set on a device">
            + Import from device
          </button>
          <button className="btn btn-primary" onClick={() => setEditor({ create: true })}>
            + New template
          </button>
        </div>
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
                      if (confirm(`Delete template "${t.name}"?\n\nThis only removes the template definition. Rule-sets already pushed to devices stay on those devices.`))
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
