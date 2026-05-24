import { Fragment, useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'

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
  const qc = useQueryClient()
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.listTemplates() })
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api.listDevices() })
  const [pushing, setPushing] = useState<string | null>(null)
  const [selectedDevs, setSelectedDevs] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<Record<string, { status: string; error?: string }> | null>(null)

  const push = useMutation({
    mutationFn: () => api.pushTemplate(pushing!, Object.keys(selectedDevs).filter(k => selectedDevs[k])),
    onSuccess: (r) => setResults(r),
  })
  const del = useMutation({
    mutationFn: (name: string) => api.deleteTemplate(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  })

  return (
    <>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Rule-set templates</h1>
      <div className="hint" style={{ marginBottom: 16 }}>Define a rule-set once, push it to many devices in parallel.</div>

      <div className="card">
        <table className="tbl">
          <thead><tr><th>Name</th><th>Family</th><th className="right">Rules</th><th className="right">Actions</th></tr></thead>
          <tbody>
            {(templates.data || []).map(t => (
              <tr key={t.name}>
                <td className="mono">{t.name}</td>
                <td>{t.family}</td>
                <td className="right mono dim">{t.rules?.length ?? 0}</td>
                <td className="right">
                  <button className="btn btn-primary" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => { setPushing(t.name); setResults(null) }}>push to fleet</button>
                  {' '}
                  <button className="btn btn-danger" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => { if (confirm(`Delete template "${t.name}"?`)) del.mutate(t.name) }}
                    disabled={del.isPending}>delete</button>
                </td>
              </tr>
            ))}
            {(templates.data || []).length === 0 && (
              <tr><td colSpan={4} style={{ padding: 20, color: 'var(--ink-muted)' }}>
                No templates. Save one via POST /api/v1/templates.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {pushing && (
        <div className="modal-backdrop">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Push “{pushing}” to…</h2>
              <button className="btn" onClick={() => setPushing(null)} style={{ background: 'transparent', border: 0 }}>✕</button>
            </div>
            <div className="modal-body">
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
              <button className="btn btn-primary" disabled={push.isPending || Object.keys(selectedDevs).filter(k => selectedDevs[k]).length === 0}
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
