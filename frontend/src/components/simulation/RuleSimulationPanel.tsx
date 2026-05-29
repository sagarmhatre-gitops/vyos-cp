// RuleSimulationPanel — Rule Simulation + Shadow Detection UI for vyos-cp.
// Mounts inside RuleSetEditor; uses the shared `api` client (token handled
// centrally) and the real /firewall/{family}/rulesets/{name}/... endpoints.
import { useState, useEffect, useCallback } from 'react'
import { api } from '../../lib/api'
import './RuleSimulationPanel.css'

// ─── Types (mirror backend JSON) ───────────────────────────────────────────

interface Packet {
  src_ip: string
  dst_ip: string
  proto: string
  dst_port: number
  in_iface: string
  out_iface: string
  state: string
  geo_code: string
}

interface RuleSnapshot {
  number: number
  action: string
  description?: string
  protocol?: string
}

interface TraceEntry {
  rule: RuleSnapshot
  status: 'match' | 'no_match' | 'not_evaluated'
  reasons: string[] | null
}

interface SimResult {
  matched: boolean
  matched_rule: RuleSnapshot | null
  final_action: string
  trace: TraceEntry[]
}

interface Finding {
  level: 'critical' | 'high' | 'medium' | 'low'
  rule_num: number
  related_num: number
  code: string
  title: string
  detail: string
}

interface Props {
  id: string
  family: string
  name: string
}

const ACTION_CLASS: Record<string, string> = {
  accept: 'sim-act-accept',
  drop: 'sim-act-drop',
  reject: 'sim-act-reject',
}

const LEVEL_CLASS: Record<string, string> = {
  critical: 'sim-find-critical',
  high: 'sim-find-high',
  medium: 'sim-find-medium',
  low: 'sim-find-low',
}

// ─── Component ──────────────────────────────────────────────────────────────

export function RuleSimulationPanel({ id, family, name }: Props) {
  const [pkt, setPkt] = useState<Packet>({
    src_ip: '8.8.8.8',
    dst_ip: '142.79.253.233',
    proto: 'tcp',
    dst_port: 443,
    in_iface: 'eth0',
    out_iface: 'eth1',
    state: 'new',
    geo_code: '',
  })

  const [sim, setSim] = useState<SimResult | null>(null)
  const [findings, setFindings] = useState<Finding[]>([])
  const [loadingSim, setLoadingSim] = useState(false)
  const [loadingRisk, setLoadingRisk] = useState(false)
  const [simErr, setSimErr] = useState('')
  const [openTrace, setOpenTrace] = useState(true)
  const [openSim, setOpenSim] = useState(true)
  const [openRisk, setOpenRisk] = useState(true)

  const fetchShadows = useCallback(async () => {
    setLoadingRisk(true)
    try {
      const data = await api.shadowAnalysis(id, family, name)
      setFindings(data.findings ?? [])
    } catch {
      setFindings([])
    } finally {
      setLoadingRisk(false)
    }
  }, [id, family, name])

  useEffect(() => {
    fetchShadows()
  }, [fetchShadows])

  const runSim = async () => {
    setLoadingSim(true)
    setSimErr('')
    setSim(null)
    try {
      const res = await api.simulatePacket(id, family, name, pkt)
      setSim(res)
      setOpenTrace(true)
    } catch (e) {
      setSimErr(e instanceof Error ? e.message : 'Simulation failed')
    } finally {
      setLoadingSim(false)
    }
  }

  const setField = (k: keyof Packet, v: string | number) =>
    setPkt(p => ({ ...p, [k]: v }))

  const criticalCount = findings.filter(f => f.level === 'critical' || f.level === 'high').length
  const warnCount = findings.filter(f => f.level === 'medium' || f.level === 'low').length

  return (
    <div className="sim-root">
      {/* ── Simulation ── */}
      <div className="card sim-card">
        <div className="sim-head" onClick={() => setOpenSim(v => !v)}>
          <span className="sim-head-title">Rule Simulation</span>
          <span className="sim-badge sim-badge-info">Test Traffic</span>
          <span className="sim-chev">{openSim ? '▾' : '▸'}</span>
        </div>
        {openSim && (
          <div className="sim-body">
            <div className="sim-grid">
              <label className="sim-field">
                <span>Source IP</span>
                <input value={pkt.src_ip} onChange={e => setField('src_ip', e.target.value)} />
              </label>
              <label className="sim-field">
                <span>Destination IP</span>
                <input value={pkt.dst_ip} onChange={e => setField('dst_ip', e.target.value)} />
              </label>
              <label className="sim-field">
                <span>Protocol</span>
                <select value={pkt.proto} onChange={e => setField('proto', e.target.value)}>
                  <option>tcp</option><option>udp</option><option>icmp</option><option>any</option>
                </select>
              </label>
              <label className="sim-field">
                <span>Destination Port</span>
                <input type="number" value={pkt.dst_port}
                  onChange={e => setField('dst_port', Number(e.target.value))} />
              </label>
              <label className="sim-field">
                <span>In Interface</span>
                <input value={pkt.in_iface} onChange={e => setField('in_iface', e.target.value)} />
              </label>
              <label className="sim-field">
                <span>Out Interface</span>
                <input value={pkt.out_iface} onChange={e => setField('out_iface', e.target.value)} />
              </label>
              <label className="sim-field">
                <span>Conn State</span>
                <select value={pkt.state} onChange={e => setField('state', e.target.value)}>
                  <option>new</option><option>established</option><option>related</option><option>invalid</option>
                </select>
              </label>
              <label className="sim-field">
                <span>GeoIP Code</span>
                <input value={pkt.geo_code} placeholder="CN, RU…"
                  onChange={e => setField('geo_code', e.target.value.toUpperCase())} />
              </label>
            </div>
            <button className="btn btn-primary sim-run" onClick={runSim} disabled={loadingSim}>
              {loadingSim ? 'Simulating…' : '▶ Run Simulation'}
            </button>

            {simErr && <div className="err sim-result">{simErr}</div>}
            {sim && (
              <div className={`sim-result ${sim.matched
                ? (sim.final_action === 'accept' ? 'sim-result-ok' : 'sim-result-drop')
                : 'sim-result-none'}`}>
                {sim.matched ? (
                  <>
                    <div className="sim-result-title">
                      MATCH FOUND — Rule {sim.matched_rule!.number}
                    </div>
                    {sim.matched_rule!.description &&
                      <div className="sim-result-sub">{sim.matched_rule!.description}</div>}
                    <span className={`sim-badge ${sim.final_action === 'accept' ? 'sim-badge-ok' : 'sim-badge-err'}`}>
                      {sim.final_action.toUpperCase()}
                    </span>
                  </>
                ) : (
                  <div className="sim-result-title">No rule matched — default policy applies</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Shadow & Risk ── */}
      <div className="card sim-card">
        <div className="sim-head" onClick={() => setOpenRisk(v => !v)}>
          <span className="sim-head-title">Shadow &amp; Risk Analysis</span>
          {criticalCount > 0 && <span className="sim-badge sim-badge-err">{criticalCount} critical</span>}
          {warnCount > 0 && <span className="sim-badge sim-badge-warn">{warnCount} warnings</span>}
          {loadingRisk && <span className="sim-badge sim-badge-info">analysing…</span>}
          <span className="sim-chev">{openRisk ? '▾' : '▸'}</span>
        </div>
        {openRisk && (
          <div className="sim-body">
            {findings.length === 0 && !loadingRisk && (
              <div className="hint">No issues detected in this rule-set.</div>
            )}
            {findings.map((f, i) => (
              <div key={i} className={`sim-find ${LEVEL_CLASS[f.level]}`}>
                <div className="sim-find-title">{f.title}</div>
                <div className="sim-find-detail">{f.detail}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Rule Trace ── */}
      {sim && (
        <div className="card sim-card">
          <div className="sim-head" onClick={() => setOpenTrace(v => !v)}>
            <span className="sim-head-title">Rule Trace</span>
            <span className="sim-badge sim-badge-info">Simulation path</span>
            <span className="sim-chev">{openTrace ? '▾' : '▸'}</span>
          </div>
          {openTrace && (
            <div className="sim-body">
              <table className="tbl sim-trace">
                <thead>
                  <tr><th style={{ width: 50 }}>#</th><th>Rule</th><th style={{ width: 80 }}>Action</th><th style={{ width: 160 }}>Status</th></tr>
                </thead>
                <tbody>
                  {sim.trace.map((t, i) => (
                    <tr key={i} className={
                      t.status === 'match' ? 'sim-trace-match'
                        : t.status === 'not_evaluated' ? 'sim-trace-ne' : ''}>
                      <td className="mono dim">{t.rule.number}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {t.rule.description || t.rule.protocol || '—'}
                        {t.reasons && t.reasons.length > 0 &&
                          <div className="sim-trace-reason">{t.reasons.join(', ')}</div>}
                      </td>
                      <td><span className={ACTION_CLASS[t.rule.action]}>{t.rule.action}</span></td>
                      <td>
                        {t.status === 'match' && <span className="sim-trace-arrow">← MATCH</span>}
                        {t.status === 'no_match' && <span className="dim">(no match)</span>}
                        {t.status === 'not_evaluated' && <span className="dim">(not evaluated)</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
