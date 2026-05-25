import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { api, RuleSet, Rule, AddrSpec } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'

// RuleSetsList — redesigned firewall overview.
//   KPI tiles + chain-flow diagram + flat rules-overview table.
// All data is real: listRuleSets returns rulesets WITH their rules[] populated,
// so no extra fetches. Navigation to the per-chain editor and the delete
// mutation are preserved from the original.

// Render an AddrSpec (address | port | group | mac) as a compact string.
function fmtAddr(a?: AddrSpec): string {
  if (!a) return 'any'
  if (a.address) return a.address + (a.port ? `:${a.port}` : '')
  if (a.group) {
    // group is an object keyed by group kind -> name; show the first value
    const v = Object.values(a.group).find(Boolean)
    if (v) return `grp:${v}`
  }
  if (a.mac) return a.mac
  if (a.port) return `:${a.port}`
  return 'any'
}

const PAGE = 8

export function RuleSetsList() {
  const { id, family } = useParams<{ id: string; family: string }>()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')   // by rule-set name
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const q = useQuery({
    queryKey: ['rulesets', id, family],
    queryFn: () => api.listRuleSets(id!, family!),
    enabled: !!id && !!family,
  })

  const del = useMutation({
    mutationFn: (name: string) => api.deleteRuleSet(id!, family!, name),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['rulesets', id, family] }) },
    onError: (e: any) => setErr(e.message),
  })

  const rulesets: RuleSet[] = q.data || []

  // --- KPI aggregates (all real) ---
  const totalRuleSets = rulesets.length
  const acceptDefaults = rulesets.filter(r => r.default_action === 'accept').length
  const dropDefaults = rulesets.filter(r => r.default_action === 'drop' || r.default_action === 'reject').length
  const totalRules = rulesets.reduce((s, r) => s + (r.rules?.length || 0), 0)
  const dropRules = rulesets.reduce((s, r) =>
    s + (r.rules?.filter(x => x.action === 'drop' || x.action === 'reject').length || 0), 0)

  // --- flat rules for the overview table ---
  const flatRules = useMemo(() => {
    const rows: Array<{ rs: string; rule: Rule }> = []
    for (const rs of rulesets) {
      if (filter !== 'all' && rs.name !== filter) continue
      for (const rule of (rs.rules || [])) rows.push({ rs: rs.name, rule })
    }
    const s = search.trim().toLowerCase()
    if (!s) return rows
    return rows.filter(({ rs, rule }) =>
      rs.toLowerCase().includes(s) ||
      String(rule.number).includes(s) ||
      (rule.description || '').toLowerCase().includes(s) ||
      (rule.action || '').toLowerCase().includes(s) ||
      (rule.protocol || '').toLowerCase().includes(s))
  }, [rulesets, filter, search])

  const pageCount = Math.max(1, Math.ceil(flatRules.length / PAGE))
  const pageRows = flatRules.slice((page - 1) * PAGE, page * PAGE)

  const actionBadge = (a: string) =>
    a === 'accept' ? 'ok' : (a === 'drop' || a === 'reject') ? 'danger' : 'info'

  return (
    <>
      <DeviceHeader />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 16 }}>Firewall ({family?.toUpperCase()})</h2>
          <div className="hint">
            IPv4 / IPv6 named firewall chains.&nbsp;
            <Link to={`/devices/${id}/firewall/${family === 'ipv4' ? 'ipv6' : 'ipv4'}`}>
              Switch to {family === 'ipv4' ? 'IPv6' : 'IPv4'}
            </Link>
          </div>
        </div>
      </div>

      {err && <div className="err">Delete failed: {err}</div>}

      {/* KPI tiles — all real, computed from the rulesets + their rules */}
      <div className="fw-kpi-row">
        <FwKpi icon="▤" label="Total Rule-sets" value={String(totalRuleSets)} sub={`${family?.toUpperCase()} chains`} />
        <FwKpi icon="✓" label="Accept Defaults" value={String(acceptDefaults)} sub="Default action" accent="ok" />
        <FwKpi icon="✕" label="Drop Defaults" value={String(dropDefaults)} sub="Default action" accent="danger" />
        <FwKpi icon="≡" label="Total Rules" value={String(totalRules)} sub="Across all chains" accent="muted" />
        <FwKpi icon="⛒" label="Drop Rules" value={String(dropRules)} sub="Across all chains" accent="warn" />
      </div>

      {/* Chain-flow diagram — each chain is a clickable box -> editor */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><div className="card-title">Rule-sets (Chains)</div></div>
        <div className="fw-chains">
          {rulesets.length === 0 && (
            <div style={{ padding: 20, color: 'var(--ink-muted)' }}>No rule-sets on this device.</div>
          )}
          {rulesets.map((rs, i) => {
            const drop = rs.default_action === 'drop' || rs.default_action === 'reject'
            return (
              <div key={rs.name} className="fw-chain-wrap">
                <div className={'fw-chain ' + (drop ? 'drop' : 'accept')}
                     onClick={() => navigate(`/devices/${id}/firewall/${family}/${rs.name}`)}>
                  <div className="fw-chain-head">
                    <div className="fw-chain-name mono">{rs.name}</div>
                    <button className="fw-chain-del" title={`Delete ${rs.name}`}
                      disabled={del.isPending}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (!confirm(`Delete rule-set "${rs.name}"? VyOS will reject this if a zone policy references it.`)) return
                        del.mutate(rs.name)
                      }}>✕</button>
                  </div>
                  <span className={`badge ${drop ? 'danger' : 'ok'}`}>{rs.default_action || '—'}</span>
                  <div className="fw-chain-foot">Default Action<br/><span className="mono">{rs.default_action || '—'}</span></div>
                </div>
                <div className="fw-chain-count">
                  <span className="mono">{rs.rules?.length ?? 0}</span>
                  <span className="dim">Rules</span>
                </div>
                {i < rulesets.length - 1 && <div className="fw-chain-arrow">→</div>}
              </div>
            )
          })}
        </div>
      </div>

      {/* Rules overview — flat table across all chains, searchable + paginated */}
      <div className="card">
        <div className="card-head">
          <div className="card-title">Rules Overview</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="select" value={filter}
              onChange={e => { setFilter(e.target.value); setPage(1) }}>
              <option value="all">All rule-sets</option>
              {rulesets.map(rs => <option key={rs.name} value={rs.name}>{rs.name}</option>)}
            </select>
            <input type="text" placeholder="Search rules…" value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              style={{ width: 200 }} />
          </div>
        </div>
        <table className="tbl">
          <thead><tr>
            <th>Rule-set</th><th>Rule</th><th>Action</th><th>Protocol</th>
            <th>Source</th><th>Destination</th><th>Description</th>
            <th className="right">Actions</th>
          </tr></thead>
          <tbody>
            {pageRows.map(({ rs, rule }) => (
              <tr key={`${rs}-${rule.number}`} onClick={() => navigate(`/devices/${id}/firewall/${family}/${rs}`)}>
                <td className="mono dim">{rs}</td>
                <td className="mono">rule-{rule.number}{rule.disable && <span className="badge warn" style={{ marginLeft: 6 }}>off</span>}</td>
                <td><span className={`badge ${actionBadge(rule.action)}`}>{rule.action}</span></td>
                <td className="mono dim">{rule.protocol || 'any'}</td>
                <td className="mono dim" style={{ fontSize: 11 }}>{fmtAddr(rule.source)}</td>
                <td className="mono dim" style={{ fontSize: 11 }}>{fmtAddr(rule.destination)}</td>
                <td className="dim" style={{ fontSize: 12 }}>{rule.description || '—'}</td>
                <td className="right" onClick={e => e.stopPropagation()}>
                  <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => navigate(`/devices/${id}/firewall/${family}/${rs}`)}>edit</button>
                </td>
              </tr>
            ))}
            {flatRules.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 20, color: 'var(--ink-muted)' }}>
                {rulesets.length === 0 ? 'No rule-sets on this device.' : 'No rules match.'}
              </td></tr>
            )}
          </tbody>
        </table>
        {pageCount > 1 && (
          <div className="fw-pager">
            <span className="dim">Showing {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, flatRules.length)} of {flatRules.length} rules</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="btn" disabled={page === 1} onClick={() => setPage(p => p - 1)} style={{ height: 26 }}>‹</button>
              {Array.from({ length: pageCount }, (_, i) => i + 1).map(p => (
                <button key={p} className={'btn' + (p === page ? ' btn-primary' : '')}
                  onClick={() => setPage(p)} style={{ height: 26, minWidth: 26 }}>{p}</button>
              ))}
              <button className="btn" disabled={page === pageCount} onClick={() => setPage(p => p + 1)} style={{ height: 26 }}>›</button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function FwKpi({ icon, label, value, sub, accent }: {
  icon: string; label: string; value: string; sub?: string
  accent?: 'ok' | 'danger' | 'muted' | 'warn'
}) {
  return (
    <div className={'fw-kpi' + (accent ? ' ' + accent : '')}>
      <div className="fw-kpi-icon">{icon}</div>
      <div className="fw-kpi-value mono">{value}</div>
      <div className="fw-kpi-label">{label}</div>
      {sub && <div className="fw-kpi-sub">{sub}</div>}
    </div>
  )
}
