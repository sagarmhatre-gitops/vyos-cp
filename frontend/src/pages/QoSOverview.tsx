import React from 'react'
import type { TrafficPolicy, TrafficPolicyBinding } from '../lib/api'

// QoSOverview — real-config overview for the QoS page: KPI tiles + a shaping
// flow diagram. Uses ONLY configured data (policies + bindings). No live
// throughput / queue health / efficiency / drops — the backend collects no QoS
// statistics, so those panels from the mockup are intentionally absent rather
// than fabricated.

const IconShield = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l8 3.5v5c0 4.5-3.2 7.2-8 8.5-4.8-1.3-8-4-8-8.5v-5L12 3z" /><path d="M9 12l2 2 4-4" />
  </svg>
)
const IconChip = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
    <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
  </svg>
)
const IconGauge = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 0 1 18 0" /><path d="M12 12l5-3" /><circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </svg>
)
const IconArrow = () => (
  <svg viewBox="0 0 40 14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <path d="M2 7h32M34 7l-5-4M34 7l-5 4" />
  </svg>
)

export function QoSOverview({ policies, bindings }: {
  policies: TrafficPolicy[]
  bindings: TrafficPolicyBinding[]
}) {
  const primary = policies[0]
  const engine = primary?.engine?.toUpperCase() || '—'
  const bandwidth = primary?.bandwidth || '—'
  // split the bandwidth into number + unit for display (e.g. "100mbit")
  const bwMatch = bandwidth.match(/^(\d+)\s*(\w+)?$/)
  const bwNum = bwMatch ? bwMatch[1] : bandwidth
  const bwUnit = bwMatch && bwMatch[2] ? bwMatch[2].replace('mbit', 'Mbit').replace('gbit', 'Gbit') : ''

  const ingressIfaces = bindings.filter(b => /^ifb\d+$/.test(b.interface) || b.interface.startsWith('ifb-')).map(b => b.interface)
  const egressIfaces = bindings.filter(b => !(/^ifb\d+$/.test(b.interface) || b.interface.startsWith('ifb-'))).map(b => b.interface)
  const classCount = primary?.classes?.length ?? 0

  return (
    <>
      <div className="qos-kpi-row">
        <div className="qos-kpi brand">
          <div className="qos-kpi-icon"><IconShield /></div>
          <div>
            <div className="qos-kpi-value mono">{policies.length}</div>
            <div className="qos-kpi-label">{policies.length === 1 ? 'Active Policy' : 'Active Policies'}</div>
            <div className="qos-kpi-sub">on device</div>
          </div>
        </div>
        <div className="qos-kpi muted">
          <div className="qos-kpi-icon"><IconChip /></div>
          <div>
            <div className="qos-kpi-value mono">{engine}</div>
            <div className="qos-kpi-label">Shaping Engine</div>
            <div className="qos-kpi-sub">in use</div>
          </div>
        </div>
        <div className="qos-kpi ok">
          <div className="qos-kpi-icon"><IconGauge /></div>
          <div>
            <div className="qos-kpi-value mono">{bwNum}{bwUnit && <small>{bwUnit}</small>}</div>
            <div className="qos-kpi-label">Shaped Bandwidth</div>
            <div className="qos-kpi-sub">configured limit</div>
          </div>
        </div>
      </div>

      {primary && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <span className="card-title">Shaping Overview</span>
            <span className="dim" style={{ fontSize: 11 }}>configured policy</span>
          </div>
          <div className="qos-flow">
            <div className="qos-flow-node io">
              <div className="dim">Ingress</div>
              <div className="mono" style={{ marginTop: 4 }}>{ingressIfaces.length ? ingressIfaces.join(' · ') : '—'}</div>
            </div>
            <div className="qos-flow-arrow"><IconArrow /></div>
            <div className="qos-shaper">
              <div className="qos-shaper-icon"><IconChip /></div>
              <div className="qos-shaper-name">{primary.name}</div>
              <div className="qos-shaper-meta">{engine} · {bandwidth} · {classCount} {classCount === 1 ? 'class' : 'classes'}</div>
            </div>
            <div className="qos-flow-arrow"><IconArrow /></div>
            <div className="qos-flow-node io">
              <div className="dim">Egress</div>
              <div className="mono" style={{ marginTop: 4 }}>{egressIfaces.length ? egressIfaces.join(' · ') : '—'}</div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
