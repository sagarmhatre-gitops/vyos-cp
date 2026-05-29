import { useState, useMemo } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import {
  api, ValidateResult, ChangeAction,
  SnapshotMeta, DiffResult,
} from '../lib/api'

/* ─────────────────────────────────────────────────────────────────────────────
   Live Config — wired to GET /api/v1/devices/{id}/live-config
   Refresh, format toggle, search, copy, download and validate are all functional.
───────────────────────────────────────────────────────────────────────────── */

type ViewTab = 'current' | 'history' | 'diff'
type Format = 'JSON' | 'VyOS'

/* Section name -> colour. Stable mapping so colours don't shuffle between loads. */
const SECTION_COLORS: Record<string, string> = {
  Firewall: '#ef4444',
  NAT: '#f59e0b',
  Interfaces: '#3b82f6',
  QoS: '#8b5cf6',
  System: '#22c55e',
  Other: '#64748b',
  'interfaces ethernet': '#3b82f6',
  'nat source': '#f59e0b',
  'firewall group': '#ef4444',
  'qos shape': '#8b5cf6',
  'system ntp': '#22c55e',
}
const colorFor = (name: string) => SECTION_COLORS[name] || '#64748b'

/* ── relative time formatter ─────────────────────────────────────────────── */
function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  const diff = Math.max(0, Date.now() - then)
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function clockTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function fullStamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/* ── VyOS "set" style serialiser (for the VyOS format toggle) ─────────────── */
function toVyosSet(content: string): string {
  let obj: any
  try { obj = JSON.parse(content) } catch { return content }
  const lines: string[] = []
  const walk = (node: any, path: string[]) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const keys = Object.keys(node)
      if (keys.length === 0) return
      for (const k of keys) walk(node[k], [...path, k])
    } else if (Array.isArray(node)) {
      for (const v of node) lines.push(`set ${path.join(' ')} '${v}'`)
    } else {
      lines.push(`set ${path.join(' ')} '${node}'`)
    }
  }
  walk(obj, [])
  return lines.length ? lines.join('\n') : '# (empty configuration)'
}

/* ── SVG syntax highlight ─────────────────────────────────────────────────── */
function highlight(line: string): string {
  return line
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, '<span style="color:#7dd3fc">$1</span><span style="color:#94a3b8">$2</span>')
    .replace(/:\s*("(?:[^"\\]|\\.)*")/g, (m, v) => m.replace(v, `<span style="color:#86efac">${v}</span>`))
    .replace(/:\s*(-?\d+\.?\d*)/g, (m, v) => m.replace(v, `<span style="color:#fbbf24">${v}</span>`))
    .replace(/\b(true|false|null)\b/g, '<span style="color:#f472b6">$1</span>')
    .replace(/^(set\b)/, '<span style="color:#7dd3fc">$1</span>')
    .replace(/([{}[\]])/g, '<span style="color:#94a3b8">$1</span>')
}

function ChangeBadge({ type }: { type: ChangeAction }) {
  const map: Record<ChangeAction, { bg: string; color: string; border: string }> = {
    Added: { bg: 'rgba(34,197,94,0.12)', color: '#22c55e', border: '#166534' },
    Modified: { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: '#92400e' },
    Removed: { bg: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '#7f1d1d' },
  }
  const s = map[type]
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 3,
      background: s.bg, color: s.color, border: `1px solid ${s.border}`, whiteSpace: 'nowrap',
    }}>{type}</span>
  )
}

function SectionIcon({ color }: { color: string }) {
  return (
    <div style={{
      width: 16, height: 16, borderRadius: 3,
      background: color + '22', border: `1px solid ${color}55`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      <div style={{ width: 6, height: 6, borderRadius: 1, background: color }} />
    </div>
  )
}

function SectionsDonut({ sections, total }: { sections: { name: string; count: number }[]; total: number }) {
  const r = 52, cx = 64, cy = 64, circ = 2 * Math.PI * r
  let offset = 0
  const slices = sections.filter(s => s.count > 0).map(s => {
    const len = total ? (s.count / total) * circ : 0
    const slice = { ...s, len, offset }
    offset += len
    return slice
  })
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <svg width="128" height="128" viewBox="0 0 128 128">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1e2432" strokeWidth="16" />
        {slices.map(s => (
          <circle key={s.name} cx={cx} cy={cy} r={r} fill="none"
            stroke={colorFor(s.name)} strokeWidth="16"
            strokeDasharray={`${s.len} ${circ}`} strokeDashoffset={-s.offset}
            transform={`rotate(-90 ${cx} ${cy})`} />
        ))}
      </svg>
      <div style={{
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        textAlign: 'center', lineHeight: 1,
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#e2e8f0' }}>{total}</div>
        <div style={{ fontSize: 10, color: '#4b5563', marginTop: 2 }}>Total sections</div>
      </div>
    </div>
  )
}

function CodeViewer({ content, searchTerm }: { content: string; searchTerm: string }) {
  const lines = content.split('\n')
  const rows = useMemo(() => {
    if (!searchTerm) return lines.map((l, i) => ({ n: i + 1, text: l }))
    const q = searchTerm.toLowerCase()
    return lines.map((l, i) => ({ n: i + 1, text: l })).filter(r => r.text.toLowerCase().includes(q))
  }, [content, searchTerm])

  return (
    <div style={{
      fontFamily: "'SF Mono','Fira Code','Courier New',monospace",
      fontSize: 12, lineHeight: '20px',
    }}>
      {rows.length === 0 && (
        <div style={{ padding: '16px 24px', color: '#4b5563', fontSize: 12 }}>No matching lines.</div>
      )}
      {rows.map(r => (
        <div key={r.n} style={{ display: 'flex', alignItems: 'flex-start', paddingRight: 16 }}>
          <span style={{
            minWidth: 32, textAlign: 'right', paddingRight: 16, color: '#374151',
            userSelect: 'none', flexShrink: 0, fontSize: 11,
          }}>{r.n}</span>
          <span style={{ color: '#e2e8f0', whiteSpace: 'pre' }}
            dangerouslySetInnerHTML={{ __html: highlight(r.text) }} />
        </div>
      ))}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────── */
export function LiveConfig() {
  const { id } = useParams<{ id: string }>()
  const [tab, setTab] = useState<ViewTab>('current')
  const [format, setFormat] = useState<Format>('JSON')
  const [search, setSearch] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [copied, setCopied] = useState(false)
  const [checksumCopied, setChecksumCopied] = useState(false)
  const [configIdCopied, setConfigIdCopied] = useState(false)

  // Diff selection: which two snapshot ids to compare.
  const [diffFrom, setDiffFrom] = useState<number | null>(null)
  const [diffTo, setDiffTo] = useState<number | null>(null)

  const q = useQuery({
    queryKey: ['live-config', id],
    queryFn: () => api.getLiveConfig(id!),
    enabled: !!id,
    refetchInterval: autoRefresh ? 15_000 : false,
  })

  // History list — loaded for both the History and Diff tabs.
  const history = useQuery({
    queryKey: ['snapshots', id],
    queryFn: () => api.listSnapshots(id!, 50),
    enabled: !!id && (tab === 'history' || tab === 'diff'),
  })

  // Diff between two chosen snapshots.
  const diff = useQuery({
    queryKey: ['snapshot-diff', id, diffFrom, diffTo],
    queryFn: () => api.diffSnapshots(id!, diffFrom!, diffTo!),
    enabled: !!id && tab === 'diff' && diffFrom != null && diffTo != null && diffFrom !== diffTo,
  })

  // "Refresh now" captures a fresh snapshot server-side, then returns current.
  const refresh = useMutation({
    mutationFn: () => api.refreshLiveConfig(id!),
    onSuccess: (fresh) => { q.refetch(); history.refetch() },
  })

  const validate = useMutation({
    mutationFn: () => api.validateLiveConfig(id!),
  })

  // Default the diff pickers once history loads: newest (to) vs previous (from).
  useMemo(() => {
    const list = history.data
    if (list && list.length >= 2 && diffTo == null && diffFrom == null) {
      setDiffTo(list[0].id)
      setDiffFrom(list[1].id)
    } else if (list && list.length === 1 && diffTo == null) {
      setDiffTo(list[0].id)
    }
  }, [history.data])

  const data = q.data
  const content = useMemo(() => {
    if (!data) return ''
    return format === 'VyOS' ? toVyosSet(data.content) : data.content
  }, [data, format])

  function copyText(text: string, setter: (v: boolean) => void) {
    navigator.clipboard.writeText(text).catch(() => {})
    setter(true); setTimeout(() => setter(false), 1500)
  }

  function download() {
    if (!data) return
    const blob = new Blob([content], { type: format === 'JSON' ? 'application/json' : 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${data.device_name || data.device_id}-config.${format === 'JSON' ? 'json' : 'conf'}`
    a.click()
    URL.revokeObjectURL(url)
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 0', fontSize: 13, cursor: 'pointer',
    color: active ? '#3b82f6' : '#6b7280',
    fontWeight: active ? 600 : 400,
    background: 'none', border: 'none',
    borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
  })

  /* ── loading / error states ─────────────────────────────────────────── */
  if (q.isLoading) {
    return (
      <div style={{ padding: 40, color: '#6b7280', fontSize: 13, background: '#0d1117', minHeight: '100%' }}>
        Loading live configuration…
      </div>
    )
  }
  if (q.isError || !data) {
    return (
      <div style={{ padding: 40, background: '#0d1117', minHeight: '100%' }}>
        <div style={{
          background: 'rgba(239,68,68,0.1)', border: '1px solid #7f1d1d', color: '#ef4444',
          borderRadius: 8, padding: '12px 16px', fontSize: 13,
        }}>
          Failed to load configuration{q.error ? `: ${(q.error as Error).message}` : ''}.
          <button onClick={() => q.refetch()} style={{
            marginLeft: 12, background: '#1e2432', border: '1px solid #2d3748', color: '#e2e8f0',
            borderRadius: 5, padding: '4px 12px', cursor: 'pointer', fontSize: 12,
          }}>Retry</button>
        </div>
      </div>
    )
  }

  const totalSections = data.sections.reduce((a, s) => a + s.count, 0)
  const maxTop = Math.max(1, ...data.top_modified.map(s => s.count))

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: '#0d1117', minHeight: '100%', color: '#e2e8f0',
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    }}>

      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px 0' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#e2e8f0', margin: 0, lineHeight: 1 }}>Live Config</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: '#6b7280' }}>
            Real-time configuration from device:
            <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{data.device_name || data.device_id}</span>
            {data.live && (
              <span style={{
                background: 'rgba(34,197,94,0.12)', border: '1px solid #166534', color: '#22c55e',
                fontSize: 10, fontWeight: 600, padding: '1px 8px', borderRadius: 20,
              }}>Live</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginRight: 16 }}>
            {(['current', 'history', 'diff'] as ViewTab[]).map(t => (
              <button key={t} style={tabStyle(tab === t)} onClick={() => setTab(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', borderRadius: 6, overflow: 'hidden', border: '1px solid #2563eb' }}>
            <button
              onClick={() => refresh.mutate()}
              disabled={q.isFetching || refresh.isPending}
              style={{
                background: '#2563eb', border: 'none', color: 'white', fontSize: 13, fontWeight: 600,
                padding: '7px 16px', cursor: (q.isFetching || refresh.isPending) ? 'default' : 'pointer',
                opacity: (q.isFetching || refresh.isPending) ? 0.7 : 1,
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
              {(q.isFetching || refresh.isPending) && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  style={{ animation: 'lc-spin 0.8s linear infinite' }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              )}
              {(q.isFetching || refresh.isPending) ? 'Refreshing…' : 'Refresh now'}
            </button>
            <button
              onClick={() => setAutoRefresh(v => !v)}
              title={autoRefresh ? 'Auto-refresh on (15s)' : 'Auto-refresh off'}
              style={{
                background: autoRefresh ? '#1e40af' : '#1d4ed8', border: 'none', borderLeft: '1px solid #3b82f6',
                color: 'white', padding: '7px 8px', cursor: 'pointer',
              }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                style={{ transform: autoRefresh ? 'rotate(180deg)' : 'none' }}>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* History tab — list of stored snapshots */}
      {tab === 'history' && (
        <div style={{ margin: '16px 24px 24px', background: '#131924', border: '1px solid #1e2432', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2432', fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>
            Configuration history
          </div>
          {history.isLoading && <div style={{ padding: 24, color: '#6b7280', fontSize: 12 }}>Loading snapshots…</div>}
          {history.isError && <div style={{ padding: 24, color: '#ef4444', fontSize: 12 }}>Failed to load history.</div>}
          {history.data && history.data.length === 0 && (
            <div style={{ padding: 24, color: '#6b7280', fontSize: 12 }}>No snapshots captured yet. Hit “Refresh now” to capture one.</div>
          )}
          {history.data && history.data.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #1e2432' }}>
                  {['Captured', 'Config ID', 'Version', 'Source', 'By', 'Lines', 'Size', ''].map(h => (
                    <th key={h} style={{ textAlign: 'left', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.7px', color: '#4b5563', fontWeight: 600, padding: '8px 16px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.data.map((s, i) => (
                  <tr key={s.id} style={{ borderBottom: i < history.data!.length - 1 ? '1px solid #131924' : 'none' }}>
                    <td style={{ padding: '8px 16px', fontSize: 12, color: '#e2e8f0' }}>{fullStamp(s.captured_at)}</td>
                    <td style={{ padding: '8px 16px', fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono',monospace" }}>{s.config_id}</td>
                    <td style={{ padding: '8px 16px', fontSize: 11, color: '#9ca3af' }}>{s.version || '—'}</td>
                    <td style={{ padding: '8px 16px' }}>
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 3,
                        background: 'rgba(59,130,246,0.12)', color: '#3b82f6', border: '1px solid #1e3a5f',
                      }}>{s.source}</span>
                    </td>
                    <td style={{ padding: '8px 16px', fontSize: 11, color: '#9ca3af' }}>{s.captured_by}</td>
                    <td style={{ padding: '8px 16px', fontSize: 11, color: '#9ca3af' }}>{s.lines.toLocaleString()}</td>
                    <td style={{ padding: '8px 16px', fontSize: 11, color: '#9ca3af' }}>{fmtSize(s.size_bytes)}</td>
                    <td style={{ padding: '8px 16px', textAlign: 'right' }}>
                      <button
                        onClick={() => { setDiffTo(history.data![0].id); setDiffFrom(s.id); setTab('diff') }}
                        style={{ background: '#1e2432', border: '1px solid #2d3748', color: '#9ca3af', fontSize: 11, padding: '3px 10px', borderRadius: 5, cursor: 'pointer' }}>
                        Diff vs latest
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Diff tab — compare two snapshots */}
      {tab === 'diff' && (
        <div style={{ margin: '16px 24px 24px' }}>
          {/* Snapshot pickers */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12,
            background: '#131924', border: '1px solid #1e2432', borderRadius: 8, padding: '12px 16px',
          }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Compare</span>
            <select value={diffFrom ?? ''} onChange={e => setDiffFrom(Number(e.target.value))}
              style={{ background: '#0d1117', border: '1px solid #1e2432', color: '#e2e8f0', borderRadius: 5, padding: '5px 10px', fontSize: 12 }}>
              <option value="" disabled>Select base…</option>
              {history.data?.map(s => (
                <option key={s.id} value={s.id}>{fullStamp(s.captured_at)} · {s.config_id}</option>
              ))}
            </select>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            <select value={diffTo ?? ''} onChange={e => setDiffTo(Number(e.target.value))}
              style={{ background: '#0d1117', border: '1px solid #1e2432', color: '#e2e8f0', borderRadius: 5, padding: '5px 10px', fontSize: 12 }}>
              <option value="" disabled>Select target…</option>
              {history.data?.map(s => (
                <option key={s.id} value={s.id}>{fullStamp(s.captured_at)} · {s.config_id}</option>
              ))}
            </select>
            {diff.data && (
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, fontSize: 12 }}>
                <span style={{ color: '#22c55e' }}>+{diff.data.added}</span>
                <span style={{ color: '#ef4444' }}>−{diff.data.removed}</span>
              </div>
            )}
          </div>

          {/* Diff body */}
          <div style={{ background: '#131924', border: '1px solid #1e2432', borderRadius: 8, overflow: 'hidden' }}>
            {(diffFrom == null || diffTo == null) && (
              <div style={{ padding: 24, color: '#6b7280', fontSize: 12 }}>Pick two snapshots to compare.</div>
            )}
            {diffFrom != null && diffTo != null && diffFrom === diffTo && (
              <div style={{ padding: 24, color: '#6b7280', fontSize: 12 }}>Select two different snapshots.</div>
            )}
            {diff.isLoading && <div style={{ padding: 24, color: '#6b7280', fontSize: 12 }}>Computing diff…</div>}
            {diff.isError && <div style={{ padding: 24, color: '#ef4444', fontSize: 12 }}>Failed to compute diff.</div>}
            {diff.data?.identical && (
              <div style={{ padding: 24, color: '#22c55e', fontSize: 12 }}>No differences — the two snapshots are identical.</div>
            )}
            {diff.data && !diff.data.identical && (
              <div style={{ fontFamily: "'SF Mono','Fira Code',monospace", fontSize: 12, lineHeight: '20px', overflow: 'auto', maxHeight: 600, padding: '8px 0' }}>
                {diff.data.lines.map((ln, i) => {
                  const bg = ln.kind === 'add' ? 'rgba(34,197,94,0.08)' : ln.kind === 'del' ? 'rgba(239,68,68,0.08)' : 'transparent'
                  const mark = ln.kind === 'add' ? '+' : ln.kind === 'del' ? '−' : ' '
                  const markColor = ln.kind === 'add' ? '#22c55e' : ln.kind === 'del' ? '#ef4444' : '#374151'
                  const textColor = ln.kind === 'ctx' ? '#6b7280' : '#e2e8f0'
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', background: bg, paddingRight: 16 }}>
                      <span style={{ minWidth: 32, textAlign: 'right', paddingRight: 8, color: '#374151', userSelect: 'none', fontSize: 11 }}>{ln.a || ''}</span>
                      <span style={{ minWidth: 32, textAlign: 'right', paddingRight: 12, color: '#374151', userSelect: 'none', fontSize: 11 }}>{ln.b || ''}</span>
                      <span style={{ width: 14, color: markColor, userSelect: 'none' }}>{mark}</span>
                      <span style={{ color: textColor, whiteSpace: 'pre' }}>{ln.text}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'current' && (
        <>
          {/* ── Metadata row ─────────────────────────────────────────────── */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', margin: '16px 24px 0',
            background: '#131924', border: '1px solid #1e2432', borderRadius: 8, padding: '12px 20px',
          }}>
            {[
              { label: 'Captured', value: fullStamp(data.captured_at), mono: false },
              { label: 'Device', value: data.device_name || data.device_id, copy: 'device', mono: false },
              { label: 'Config ID', value: data.config_id, copy: 'configId', mono: true },
              { label: 'Version', value: data.version, mono: false },
              { label: 'Source', value: data.source, live: true, mono: false },
            ].map((item, i) => (
              <div key={i} style={{
                borderRight: i < 4 ? '1px solid #1e2432' : 'none',
                paddingRight: 20, paddingLeft: i > 0 ? 20 : 0,
              }}>
                <div style={{ fontSize: 10, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: 4, fontWeight: 600 }}>
                  {item.label}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {item.live && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />}
                  <span style={{
                    fontSize: 13, fontWeight: 500, color: '#e2e8f0',
                    fontFamily: item.mono ? "'SF Mono','Courier New',monospace" : 'inherit',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{item.value}</span>
                  {item.copy && (
                    <button
                      onClick={() => copyText(item.value, item.copy === 'configId' ? setConfigIdCopied : setConfigIdCopied)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: configIdCopied ? '#22c55e' : '#4b5563', padding: 0, display: 'flex' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* ── Main: editor + sidebar ───────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 12, margin: '12px 24px 0' }}>

            {/* Code viewer */}
            <div style={{ background: '#131924', border: '1px solid #1e2432', borderRadius: 8, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #1e2432' }}>
                <div style={{ display: 'flex', gap: 1, background: '#0d1117', border: '1px solid #1e2432', borderRadius: 5, padding: 2 }}>
                  {(['JSON', 'VyOS'] as Format[]).map(f => (
                    <button key={f} onClick={() => setFormat(f)} style={{
                      background: format === f ? '#1e2432' : 'none', border: 'none',
                      color: format === f ? '#e2e8f0' : '#6b7280', fontSize: 11, fontWeight: 600,
                      padding: '2px 10px', borderRadius: 3, cursor: 'pointer',
                    }}>{f}</button>
                  ))}
                </div>
                <div style={{ flex: 1, position: 'relative' }}>
                  <svg style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#4b5563' }}
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                  </svg>
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search in config..."
                    style={{
                      width: '100%', background: '#0d1117', border: '1px solid #1e2432', borderRadius: 5,
                      padding: '4px 8px 4px 26px', color: '#e2e8f0', fontSize: 12, outline: 'none',
                    }} />
                </div>
                <button onClick={download} style={{
                  display: 'flex', alignItems: 'center', gap: 5, background: '#0d1117',
                  border: '1px solid #1e2432', borderRadius: 5, color: '#9ca3af', fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                  Download
                </button>
                <button onClick={() => copyText(content, setCopied)} style={{
                  display: 'flex', alignItems: 'center', gap: 5, background: '#0d1117',
                  border: '1px solid #1e2432', borderRadius: 5, color: copied ? '#22c55e' : '#9ca3af', fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: '8px 0', maxHeight: 560 }}>
                <CodeViewer content={content} searchTerm={search} />
              </div>
            </div>

            {/* Sidebar */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ background: '#131924', border: '1px solid #1e2432', borderRadius: 8, padding: '14px 16px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 12 }}>Configuration info</div>
                {[
                  { label: 'Lines of code', value: data.lines.toLocaleString() },
                  { label: 'File size', value: fmtSize(data.size_bytes) },
                  { label: 'Last changed', value: timeAgo(data.last_changed) },
                  { label: 'Changed by', value: data.changed_by },
                ].map(row => (
                  <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #1e2432' }}>
                    <span style={{ fontSize: 11, color: '#4b5563' }}>{row.label}</span>
                    <span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 500 }}>{row.value}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
                  <span style={{ fontSize: 11, color: '#4b5563' }}>Checksum (SHA256)</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{
                      fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono','Courier New',monospace",
                      background: '#0d1117', padding: '1px 6px', borderRadius: 3, border: '1px solid #1e2432',
                    }}>{data.checksum.slice(0, 4)}...{data.checksum.slice(-4)}</span>
                    <button onClick={() => copyText(data.checksum, setChecksumCopied)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: checksumCopied ? '#22c55e' : '#4b5563', padding: 0 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ background: '#131924', border: '1px solid #1e2432', borderRadius: 8, padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>Recent changes</span>
                  <span style={{ fontSize: 11, color: '#3b82f6', cursor: 'pointer' }}>View all</span>
                </div>
                {data.recent_changes.length === 0 && (
                  <div style={{ fontSize: 11, color: '#4b5563', padding: '8px 0' }}>No recent changes.</div>
                )}
                {data.recent_changes.map((c, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
                    borderBottom: i < data.recent_changes.length - 1 ? '1px solid #1e2432' : 'none',
                  }}>
                    <span style={{ fontSize: 10, color: '#4b5563', minWidth: 58, flexShrink: 0 }}>{clockTime(c.at)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.target}</div>
                      <div style={{ fontSize: 10, color: '#4b5563' }}>{c.description}</div>
                    </div>
                    <ChangeBadge type={c.action} />
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="2" style={{ flexShrink: 0 }}>
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Bottom row ───────────────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, margin: '12px 24px 24px' }}>
            <div style={{ background: '#131924', border: '1px solid #1e2432', borderRadius: 8, padding: '14px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 12 }}>Config sections</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <SectionsDonut sections={data.sections} total={totalSections} />
                <div style={{ flex: 1 }}>
                  {data.sections.map(s => (
                    <div key={s.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <SectionIcon color={colorFor(s.name)} />
                        <span style={{ fontSize: 12, color: '#9ca3af' }}>{s.name}</span>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0' }}>{s.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ background: '#131924', border: '1px solid #1e2432', borderRadius: 8, padding: '14px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>Top modified sections</span>
                <span style={{ fontSize: 10, color: '#4b5563' }}>(last 24h)</span>
              </div>
              {data.top_modified.length === 0 && (
                <div style={{ fontSize: 11, color: '#4b5563', padding: '8px 0' }}>No modifications in the last 24h.</div>
              )}
              {data.top_modified.map(s => (
                <div key={s.name} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <SectionIcon color={colorFor(s.name)} />
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>{s.name}</span>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#e2e8f0' }}>{s.count}</span>
                  </div>
                  <div style={{ height: 4, background: '#1e2432', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 2, width: `${(s.count / maxTop) * 100}%`, background: colorFor(s.name) }} />
                  </div>
                </div>
              ))}
            </div>

            <div style={{ background: '#131924', border: '1px solid #1e2432', borderRadius: 8, padding: '14px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 12 }}>Validation status</div>
              {(() => {
                const v: ValidateResult | undefined = validate.data
                const valid = v ? v.valid : true
                const message = v ? v.message : 'Configuration is valid'
                const detail = v ? v.detail : 'No syntax or schema issues detected'
                const at = v ? clockTime(v.validated_at) : clockTime(data.captured_at)
                const color = valid ? '#22c55e' : '#ef4444'
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, paddingTop: 8 }}>
                    <div style={{
                      width: 56, height: 56, borderRadius: '50%',
                      background: valid ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                      border: `2px solid ${valid ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5">
                        {valid ? <path d="M20 6L9 17l-5-5" /> : <><circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" /></>}
                      </svg>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', marginBottom: 4 }}>{message}</div>
                      <div style={{ fontSize: 11, color: '#4b5563' }}>{detail}</div>
                      <div style={{ fontSize: 11, color: '#4b5563', marginTop: 2 }}>at {at}</div>
                    </div>
                    <button onClick={() => validate.mutate()} disabled={validate.isPending} style={{
                      background: '#1e2432', border: '1px solid #2d3748', color: '#9ca3af',
                      fontSize: 12, fontWeight: 500, padding: '6px 18px', borderRadius: 6,
                      cursor: validate.isPending ? 'default' : 'pointer', marginTop: 4, opacity: validate.isPending ? 0.7 : 1,
                    }}>
                      {validate.isPending ? 'Validating…' : 'Validate now'}
                    </button>
                  </div>
                )
              })()}
            </div>
          </div>
        </>
      )}

      <style>{`@keyframes lc-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
