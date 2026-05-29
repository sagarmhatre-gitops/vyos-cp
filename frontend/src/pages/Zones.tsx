import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, Zone, ZonePolicy } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'

/* ─────────────────────────────────────────────────────────────────────────────
   Inline styles – all dark-theme tokens match the app's existing palette.
   We intentionally avoid importing a CSS file so the component is self-contained.
───────────────────────────────────────────────────────────────────────────── */

const S = {
  // layout
  page: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: 14,
  },
  // ── stat cards ────────────────────────────────────────────────────────────
  statGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: 10,
  },
  statCard: {
    background: 'var(--bg-raised)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    padding: '12px 14px',
    display: 'flex',
    alignItems: 'center' as const,
    gap: 10,
  },
  statIcon: (color: string, bg: string) => ({
    width: 36,
    height: 36,
    borderRadius: 7,
    background: bg,
    color,
    display: 'flex',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    flexShrink: 0,
  }),
  statVal: {
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--ink)',
    lineHeight: 1,
  },
  statLabel: { fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 },
  statSub: { fontSize: 10, color: 'var(--ink-faint)', marginTop: 1 },
  // ── panels ────────────────────────────────────────────────────────────────
  panel: {
    background: 'var(--bg-raised)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    padding: 14,
  },
  panelTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--ink)',
    display: 'flex',
    alignItems: 'center' as const,
    gap: 6,
    marginBottom: 2,
  },
  panelSub: { fontSize: 10, color: 'var(--ink-faint)', marginBottom: 12 },
  // ── middle row (topology + summary) ───────────────────────────────────────
  middleRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 320px',
    gap: 10,
  },
  // ── zone boxes in topology ────────────────────────────────────────────────
  zoneBox: (borderColor: string, bgColor: string) => ({
    borderRadius: 8,
    padding: '10px 12px',
    minWidth: 110,
    textAlign: 'center' as const,
    border: `1.5px solid ${borderColor}`,
    background: bgColor,
  }),
  zoneBoxName: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--ink)',
    marginBottom: 1,
  },
  zoneBoxType: { fontSize: 10, color: 'var(--ink-faint)', marginBottom: 8 },
  zoneBoxIp: { fontSize: 10, color: 'var(--ink-muted)', marginTop: 6 },
  zoneBoxIface: { fontSize: 10, color: 'var(--ink-faint)' },
  // ── arrow between zones ───────────────────────────────────────────────────
  arrowBlock: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center' as const,
    gap: 2,
    padding: '0 6px',
    minWidth: 80,
  },
  arrowLabel: (color: string, bg: string) => ({
    fontSize: 9,
    fontWeight: 600,
    padding: '1px 6px',
    borderRadius: 3,
    background: bg,
    color,
    whiteSpace: 'nowrap' as const,
  }),
  arrowLine: {
    display: 'flex',
    alignItems: 'center' as const,
    width: '100%',
    marginTop: 4,
  },
  arrowShaft: (color: string) => ({
    flex: 1,
    height: 1.5,
    background: color,
  }),
  // ── zone summary table ────────────────────────────────────────────────────
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 70px 60px 1fr',
    gap: 4,
  },
  summaryHead: {
    fontSize: 9,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
    color: 'var(--ink-faint)',
    fontWeight: 600,
  },
  summaryRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 70px 60px 1fr',
    gap: 4,
    padding: '6px 0',
    borderBottom: '1px solid var(--bg-subtle)',
    alignItems: 'center' as const,
  },
  typeBadge: (color: string, bg: string, border: string) => ({
    fontSize: 9,
    padding: '2px 7px',
    borderRadius: 3,
    fontWeight: 600,
    display: 'inline-block',
    background: bg,
    color,
    border: `1px solid ${border}`,
  }),
  // ── bottom row ────────────────────────────────────────────────────────────
  bottomRow: {
    display: 'grid',
    gridTemplateColumns: '1.1fr 0.85fr 1.05fr',
    gap: 10,
  },
  // ── zone pairs table ──────────────────────────────────────────────────────
  pairsGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 70px 70px 40px 70px',
    gap: 4,
  },
  pairsHead: {
    fontSize: 9,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
    color: 'var(--ink-faint)',
    fontWeight: 600,
  },
  pairsRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 70px 70px 40px 70px',
    gap: 4,
    padding: '6px 0',
    borderBottom: '1px solid var(--bg-subtle)',
    alignItems: 'center' as const,
  },
  // ── activity table ────────────────────────────────────────────────────────
  actGrid: {
    display: 'grid',
    gridTemplateColumns: '1.2fr 70px 50px',
    gap: 4,
  },
  actHead: {
    fontSize: 9,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
    color: 'var(--ink-faint)',
    fontWeight: 600,
  },
  actRow: {
    display: 'grid',
    gridTemplateColumns: '1.2fr 70px 50px',
    gap: 4,
    padding: '6px 0',
    borderBottom: '1px solid var(--bg-subtle)',
    alignItems: 'center' as const,
  },
  // ── misc ──────────────────────────────────────────────────────────────────
  divider: { borderBottom: '1px solid var(--line)', margin: '6px 0 8px' },
  mono: { fontFamily: "'SF Mono','Courier New',monospace" as const },
  viewLink: { fontSize: 11, color: '#3b82f6', cursor: 'pointer' },
  viewAllLink: {
    fontSize: 11,
    color: '#3b82f6',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center' as const,
    gap: 3,
    marginTop: 8,
  },
  tipBar: {
    display: 'flex',
    alignItems: 'center' as const,
    gap: 6,
    fontSize: 11,
    color: 'var(--ink-faint)',
    padding: '8px 12px',
    background: 'var(--bg-subtle)',
    borderRadius: 6,
    border: '1px solid var(--line)',
  },
  addBtn: {
    background: '#1d4ed8',
    border: 'none',
    color: 'white',
    fontSize: 12,
    padding: '6px 12px',
    borderRadius: 5,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center' as const,
    gap: 4,
    fontWeight: 500,
  },
  err: {
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid #7f1d1d',
    color: '#ef4444',
    borderRadius: 6,
    padding: '8px 12px',
    fontSize: 12,
  },
}

/* ─────────────────────────────────────────────────────────────────────────────
   Small SVG icon helpers
───────────────────────────────────────────────────────────────────────────── */
const Icon = {
  target: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="3" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="21"/><line x1="3" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="21" y2="12"/>
    </svg>
  ),
  arrows: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M7 16l-4-4 4-4M17 8l4 4-4 4M14 4l-4 16"/>
    </svg>
  ),
  rules: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 8h8M8 12h6M8 16h4"/>
    </svg>
  ),
  warn: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
  shield: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
  info: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
    </svg>
  ),
  globe: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  ),
  server: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5">
      <rect x="2" y="8" width="20" height="8" rx="2"/><path d="M6 12h.01M10 12h.01"/>
    </svg>
  ),
  users: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="1.5">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  plus: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M12 5v14M5 12h14"/>
    </svg>
  ),
  infoBlue: () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
    </svg>
  ),
}

/* ─────────────────────────────────────────────────────────────────────────────
   Derived helpers
───────────────────────────────────────────────────────────────────────────── */
function zoneColor(type?: string) {
  if (type === 'trust') return { text: '#22c55e', border: '#166534', bg: 'rgba(34,197,94,0.06)' }
  if (type === 'untrust') return { text: '#ef4444', border: '#7f1d1d', bg: 'rgba(239,68,68,0.08)' }
  return { text: '#3b82f6', border: '#1e3a5f', bg: 'rgba(59,130,246,0.06)' } // transit / default
}

function zoneIcon(type?: string) {
  if (type === 'trust') return <Icon.users />
  if (type === 'untrust') return <Icon.globe />
  return <Icon.server />
}

function typeBadge(type?: string) {
  if (type === 'trust') return (
    <span style={S.typeBadge('#22c55e', 'rgba(34,197,94,0.12)', '#166534')}>trust</span>
  )
  if (type === 'untrust') return (
    <span style={S.typeBadge('#ef4444', 'rgba(239,68,68,0.12)', '#7f1d1d')}>untrust</span>
  )
  return (
    <span style={S.typeBadge('#3b82f6', 'rgba(59,130,246,0.12)', '#1e3a5f')}>{type || 'transit'}</span>
  )
}

/** Infer a zone's trust type from its name or default_action heuristic */
function inferType(z: Zone): string {
  const n = z.name.toUpperCase()
  if (n === 'LAN' || n.includes('TRUST') || n.includes('INSIDE')) return 'trust'
  if (n === 'WAN' || n.includes('UNTRUST') || n.includes('OUTSIDE')) return 'untrust'
  return 'transit'
}

/** Count total rules across all policies */
function totalRules(policies: ZonePolicy[]): number {
  return policies.reduce((acc, p) => acc + (p.rule_set ? 1 : 0), 0)
}

/* ─────────────────────────────────────────────────────────────────────────────
   Zone topology arrow
───────────────────────────────────────────────────────────────────────────── */
function ZoneArrow({ policy, label, restrict }: { policy: ZonePolicy | null; label: string; restrict?: boolean }) {
  const color = restrict ? '#ef4444' : '#22c55e'
  const bg = restrict ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)'
  const rulesLabel = policy ? '1 Rule' : '0 Rules'
  return (
    <div style={S.arrowBlock}>
      <span style={{ fontSize: 9, fontWeight: 600, color, marginBottom: 1 }}>{rulesLabel}</span>
      <span style={S.arrowLabel(color, bg)}>{label}</span>
      <div style={S.arrowLine}>
        <div style={S.arrowShaft(color)} />
        <span style={{ color, fontSize: 14, lineHeight: 1 }}>▶</span>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────────
   Donut chart (SVG)
───────────────────────────────────────────────────────────────────────────── */
function DonutChart({ zones }: { zones: Zone[] }) {
  const types = zones.map(inferType)
  const trust = types.filter(t => t === 'trust').length
  const transit = types.filter(t => t === 'transit').length
  const untrust = types.filter(t => t === 'untrust').length
  const total = zones.length || 1
  const r = 42, cx = 55, cy = 55, circ = 2 * Math.PI * r

  function slice(count: number, offset: number, color: string) {
    const len = (count / total) * circ
    return (
      <circle
        cx={cx} cy={cy} r={r}
        fill="none" stroke={color} strokeWidth="18"
        strokeDasharray={`${len} ${circ}`}
        strokeDashoffset={-offset}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    )
  }
  const trustLen = (trust / total) * circ
  const transitLen = (transit / total) * circ

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <svg width="110" height="110" viewBox="0 0 110 110">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1e2432" strokeWidth="18" />
        {slice(trust, 0, '#22c55e')}
        {slice(transit, trustLen, '#3b82f6')}
        {slice(untrust, trustLen + transitLen, '#ef4444')}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
        {[
          { label: 'Trust', color: '#22c55e', count: trust },
          { label: 'Transit', color: '#3b82f6', count: transit },
          { label: 'Untrust', color: '#ef4444', count: untrust },
        ].map(({ label, color, count }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11 }}>
            <div style={{ display: 'flex', alignItems: 'center', color: 'var(--ink-muted)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', marginRight: 6 }} />
              {label}
            </div>
            <span style={{ color: 'var(--ink-muted)' }}>{count} ({total ? Math.round((count / total) * 100) : 0}%)</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────────
   Main Zones page
───────────────────────────────────────────────────────────────────────────── */
export function Zones() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [editingZone, setEditingZone] = useState<Zone | null>(null)
  const [editingPolicy, setEditingPolicy] = useState<Partial<ZonePolicy> | null>(null)

  const q = useQuery({
    queryKey: ['zones', id],
    queryFn: () => api.getZones(id!),
    enabled: !!id,
  })
  const rs4 = useQuery({
    queryKey: ['rulesets', id, 'ipv4'],
    queryFn: () => api.listRuleSets(id!, 'ipv4'),
    enabled: !!id, staleTime: 30_000,
  })
  const rs6 = useQuery({
    queryKey: ['rulesets', id, 'ipv6'],
    queryFn: () => api.listRuleSets(id!, 'ipv6'),
    enabled: !!id, staleTime: 30_000,
  })

  const saveZone = useMutation({
    mutationFn: (z: Zone) => api.upsertZone(id!, z),
    onSuccess: () => { setEditingZone(null); qc.invalidateQueries({ queryKey: ['zones', id] }) },
  })
  const savePolicy = useMutation({
    mutationFn: (p: ZonePolicy) => api.setZonePolicy(id!, p),
    onSuccess: () => { setEditingPolicy(null); qc.invalidateQueries({ queryKey: ['zones', id] }) },
  })
  const delZone = useMutation({
    mutationFn: (name: string) => api.deleteZone(id!, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['zones', id] }),
  })

  const zones = q.data?.zones || []
  const policies = q.data?.policies || []

  /* Build from→to matrix */
  const matrix: Record<string, Record<string, ZonePolicy | null>> = {}
  for (const f of zones) {
    matrix[f.name] = {}
    for (const t of zones) {
      if (f.name !== t.name) matrix[f.name][t.name] = null
    }
  }
  for (const p of policies) {
    if (matrix[p.from_zone]) matrix[p.from_zone][p.to_zone] = p
  }

  /* Conflict detection: a zone listed in >1 pair with no rule-set */
  const conflictCount = policies.filter(p => !p.rule_set).length

  /* For topology diagram pick first 3 zones (or pad) */
  const topoZones = zones.slice(0, 3)

  /* ── stat cards data ── */
  const statCards = [
    {
      icon: <Icon.target />,
      iconStyle: S.statIcon('#3b82f6', 'rgba(59,130,246,0.12)'),
      val: zones.length,
      label: 'Total Zones',
      sub: 'Active',
    },
    {
      icon: <Icon.arrows />,
      iconStyle: S.statIcon('#22c55e', 'rgba(34,197,94,0.12)'),
      val: policies.length,
      label: 'Zone Pairs',
      sub: 'Configured',
    },
    {
      icon: <Icon.rules />,
      iconStyle: S.statIcon('#8b5cf6', 'rgba(139,92,246,0.12)'),
      val: totalRules(policies),
      label: 'Active Rules',
      sub: 'Across all pairs',
    },
    {
      icon: <Icon.warn />,
      iconStyle: S.statIcon('#f59e0b', 'rgba(245,158,11,0.12)'),
      val: conflictCount,
      label: 'Zone Conflicts',
      sub: 'Detected',
    },
    {
      icon: <Icon.shield />,
      iconStyle: S.statIcon('#14b8a6', 'rgba(20,184,166,0.12)'),
      val: null,
      valText: 'Secure',
      valColor: '#14b8a6',
      label: 'Default Posture',
      sub: 'Drop',
    },
  ]

  return (
    <>
      <DeviceHeader />

      {delZone.isError && (
        <div style={S.err}>Delete failed: {(delZone.error as Error).message}</div>
      )}
      {saveZone.isError && (
        <div style={S.err}>Save failed: {(saveZone.error as Error).message}</div>
      )}
      {savePolicy.isError && (
        <div style={S.err}>Policy save failed: {(savePolicy.error as Error).message}</div>
      )}

      <div style={S.page}>

        {/* ── stat cards ─────────────────────────────────────────────────── */}
        <div style={S.statGrid}>
          {statCards.map((c, i) => (
            <div key={i} style={S.statCard}>
              <div style={c.iconStyle}>{c.icon}</div>
              <div>
                {c.val !== null ? (
                  <div style={S.statVal}>{c.val}</div>
                ) : (
                  <div style={{ ...S.statVal, fontSize: 15, color: c.valColor }}>{c.valText}</div>
                )}
                <div style={S.statLabel}>{c.label}</div>
                <div style={S.statSub}>{c.sub}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── middle row: topology + summary ─────────────────────────────── */}
        <div style={S.middleRow}>

          {/* Zone Topology */}
          <div style={S.panel}>
            <div style={S.panelTitle}>
              Zone Topology
              <span style={{ color: 'var(--ink-faint)' }}><Icon.info /></span>
            </div>
            <div style={S.panelSub}>Visual representation of zone relationships and trust boundaries</div>

            {/* Topology diagram */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '10px 0' }}>
              {topoZones.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>No zones configured.</span>
              ) : (
                topoZones.map((z, idx) => {
                  const type = inferType(z)
                  const c = zoneColor(type)
                  const nextZone = topoZones[idx + 1]
                  const policy = nextZone ? (matrix[z.name]?.[nextZone.name] ?? null) : null
                  const isRestrict = type === 'transit' || inferType(nextZone!) === 'untrust'
                  return (
                    <div key={z.name} style={{ display: 'flex', alignItems: 'center' }}>
                      {/* Zone box */}
                      <div style={S.zoneBox(c.border, c.bg)}>
                        <div style={S.zoneBoxName}>{z.name}</div>
                        <div style={S.zoneBoxType}>{type}</div>
                        <div style={{ margin: '4px 0', lineHeight: 1 }}>{zoneIcon(type)}</div>
                        <div style={{ ...S.zoneBoxIp, ...S.mono }}>
                          {(z.interfaces && z.interfaces.length > 0)
                            ? z.interfaces[0]
                            : '—'}
                        </div>
                        <div style={S.zoneBoxIface}>
                          {z.interfaces?.length ?? 0} interface{z.interfaces?.length !== 1 ? 's' : ''}
                        </div>
                      </div>
                      {/* Arrow to next zone */}
                      {nextZone && (
                        <ZoneArrow
                          policy={policy}
                          label={isRestrict ? 'Restrict' : 'Allow'}
                          restrict={isRestrict}
                        />
                      )}
                    </div>
                  )
                })
              )}
            </div>

            {/* Footer */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)',
            }}>
              <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
                Default policy between unlinked zones:{' '}
                <span style={{ color: '#ef4444', fontWeight: 600 }}>DROP</span>
              </span>
              <button
                style={{
                  background: 'var(--bg-subtle)', border: '1px solid #2d3748',
                  color: 'var(--ink-muted)', fontSize: 11, padding: '4px 10px',
                  borderRadius: 5, cursor: 'pointer',
                }}
              >
                View all zone pairs
              </button>
            </div>
          </div>

          {/* Zone Summary */}
          <div style={S.panel}>
            <div style={S.panelTitle}>Zone Summary</div>
            <div style={{ marginTop: 8 }}>
              {/* Header */}
              <div style={{ ...S.summaryGrid, paddingBottom: 6, borderBottom: '1px solid var(--line)', marginBottom: 6 }}>
                <div style={S.summaryHead}>Zone</div>
                <div style={S.summaryHead}>Type</div>
                <div style={S.summaryHead}>Interfaces</div>
                <div style={S.summaryHead}>Subnets</div>
              </div>
              {zones.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--ink-muted)', padding: '12px 0' }}>No zones configured.</div>
              )}
              {zones.map(z => {
                const type = inferType(z)
                return (
                  <div key={z.name} style={S.summaryRow}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{z.name}</div>
                    <div>{typeBadge(type)}</div>
                    <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{z.interfaces?.length ?? 0}</div>
                    <div style={{ fontSize: 10, color: 'var(--ink-faint)', ...S.mono }}>
                      {z.interfaces?.[0] || '—'}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* ── bottom row: pairs + donut + activity ───────────────────────── */}
        <div style={S.bottomRow}>

          {/* Zone Pairs */}
          <div style={S.panel}>
            <div style={S.panelTitle}>Zone Pairs</div>
            <div style={S.panelSub}>Traffic flow between zones
              <span style={{ marginLeft: 4, color: '#3b82f6', cursor: 'pointer' }}><Icon.info /></span>
            </div>
            {/* Header */}
            <div style={{ ...S.pairsGrid, paddingBottom: 6, borderBottom: '1px solid var(--line)', marginBottom: 2 }}>
              {['Source Zone', 'Destination Zone', 'Status', 'Policy', 'Rules', 'Action'].map(h => (
                <div key={h} style={S.pairsHead}>{h}</div>
              ))}
            </div>
            {policies.length === 0 && zones.length > 1 && (
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', padding: '12px 0' }}>No policies configured. Click a zone pair to add one.</div>
            )}
            {/* All from→to pairs (including unset ones) */}
            {zones.flatMap(f =>
              zones
                .filter(t => t.name !== f.name)
                .map(t => {
                  const p = matrix[f.name]?.[t.name]
                  const active = !!p?.rule_set
                  const fType = inferType(f)
                  const tType = inferType(t)
                  const fColor = zoneColor(fType).text
                  const tColor = zoneColor(tType).text
                  const statusColor = active ? '#22c55e' : '#f59e0b'
                  const statusLabel = active ? 'Active' : 'Inactive'
                  const policyLabel = p?.rule_set || 'Drop (Default)'
                  const rulesCount = p?.rule_set ? 1 : 0
                  return (
                    <div key={`${f.name}-${t.name}`} style={S.pairsRow}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: fColor }}>{f.name}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: tColor }}>{t.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', fontSize: 11, color: statusColor }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, display: 'inline-block', marginRight: 4 }} />
                        {statusLabel}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{policyLabel}</div>
                      <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{rulesCount}</div>
                      <div
                        style={S.viewLink}
                        onClick={() => setEditingPolicy({ from_zone: f.name, to_zone: t.name, rule_set: p?.rule_set || '', family: 'ipv4' })}
                      >
                        View rules
                      </div>
                    </div>
                  )
                })
            )}
            <div style={S.viewAllLink}>View all zone pairs →</div>
          </div>

          {/* Zone Distribution */}
          <div style={S.panel}>
            <div style={S.panelTitle}>Zone Distribution</div>
            <div style={S.panelSub}>By type</div>
            <DonutChart zones={zones} />
          </div>

          {/* Zone Activity */}
          <div style={S.panel}>
            <div style={S.panelTitle}>
              Zone Activity
              <span style={{ color: 'var(--ink-faint)', fontWeight: 400, fontSize: 10 }}>(Last 5 minutes)</span>
            </div>
            <div style={S.panelSub}>Traffic between zones</div>
            {/* Header */}
            <div style={{ ...S.actGrid, paddingBottom: 6, borderBottom: '1px solid var(--line)', marginBottom: 2 }}>
              {['Zone Pair', 'Traffic', 'Packets'].map(h => (
                <div key={h} style={S.actHead}>{h}</div>
              ))}
            </div>
            {zones.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', padding: '12px 0' }}>No data.</div>
            ) : (
              zones.flatMap(f =>
                zones
                  .filter(t => t.name !== f.name)
                  .slice(0, 1) // one pair per source for compact display
                  .map(t => {
                    const fType = inferType(f)
                    const tType = inferType(t)
                    return (
                      <div key={`act-${f.name}-${t.name}`} style={S.actRow}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--ink-muted)' }}>
                          <span style={{ fontWeight: 600, color: zoneColor(fType).text }}>{f.name}</span>
                          <span style={{ color: 'var(--ink-faint)' }}>→</span>
                          <span style={{ fontWeight: 600, color: zoneColor(tType).text }}>{t.name}</span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--ink)', ...S.mono }}>—</div>
                        <div style={{ fontSize: 11, color: 'var(--ink-faint)', ...S.mono }}>—</div>
                      </div>
                    )
                  })
              )
            )}
            <div style={S.viewAllLink}>View traffic analytics →</div>
          </div>
        </div>

        {/* ── Add zone button row ─────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button style={S.addBtn} onClick={() => setEditingZone({ name: '' })}>
            <Icon.plus /> Add zone
          </button>
        </div>

        {/* ── tip bar ────────────────────────────────────────────────────── */}
        <div style={S.tipBar}>
          <Icon.infoBlue />
          Tip: Use zones to create logical security boundaries and control traffic flow between different network segments.
        </div>
      </div>

      {/* ── Modals (unchanged logic) ──────────────────────────────────────── */}
      {editingZone && (
        <ZoneModal
          initial={editingZone}
          onClose={() => setEditingZone(null)}
          onSave={saveZone.mutate}
          saving={saveZone.isPending}
        />
      )}
      {editingPolicy && (
        <PolicyModal
          initial={editingPolicy as ZonePolicy}
          rulesets={[...(rs4.data || []), ...(rs6.data || [])]}
          onClose={() => setEditingPolicy(null)}
          onSave={savePolicy.mutate}
          saving={savePolicy.isPending}
        />
      )}
    </>
  )
}

/* ─────────────────────────────────────────────────────────────────────────────
   ZoneModal  (logic identical to original)
───────────────────────────────────────────────────────────────────────────── */
function ZoneModal({ initial, onClose, onSave, saving }: any) {
  const [z, setZ] = useState<Zone>({ ...initial, interfaces: initial.interfaces || [] })
  const [ifaces, setIfaces] = useState((initial.interfaces || []).join(', '))
  const [dirty, setDirty] = useState(false)
  const set = (patch: Partial<Zone>) => { setDirty(true); setZ(x => ({ ...x, ...patch })) }
  const safeClose = () => {
    if (dirty && !confirm('Discard your changes?')) return
    onClose()
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{z.name ? `Zone ${z.name}` : 'New zone'}</h2>
          <button className="btn" onClick={safeClose} style={{ background: 'transparent', border: 0 }}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field"><label>Name</label>
            <input type="text" value={z.name} onChange={e => set({ name: e.target.value })} /></div>
          <div className="field"><label>Description</label>
            <input type="text" value={z.description || ''} onChange={e => set({ description: e.target.value })} /></div>
          <div className="field">
            <label>Interfaces <span className="hint">(comma-separated)</span></label>
            <input type="text" value={ifaces} onChange={e => { setDirty(true); setIfaces(e.target.value) }} placeholder="eth0, eth1" />
          </div>
          <div className="row2">
            <div className="field"><label>Default action</label>
              <select className="select" value={z.default_action || ''} onChange={e => set({ default_action: e.target.value })}>
                <option value="">(inherit)</option>
                <option value="accept">accept</option>
                <option value="drop">drop</option>
                <option value="reject">reject</option>
              </select>
            </div>
            <div className="field" style={{ alignSelf: 'end' }}>
              <label>
                <input type="checkbox" checked={!!z.local_zone} onChange={e => set({ local_zone: e.target.checked })} />{' '}
                Local zone
              </label>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={safeClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving}
            onClick={() => onSave({ ...z, interfaces: ifaces.split(/[,\s]+/).filter(Boolean) })}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────────
   PolicyModal  (logic identical to original)
───────────────────────────────────────────────────────────────────────────── */
function PolicyModal({ initial, rulesets, onClose, onSave, saving }: any) {
  const [p, setP] = useState<ZonePolicy>(initial)
  const [dirty, setDirty] = useState(false)
  const set = (patch: Partial<ZonePolicy>) => { setDirty(true); setP({ ...p, ...patch }) }
  const safeClose = () => {
    if (dirty && !confirm('Discard your changes?')) return
    onClose()
  }
  const candidates = (rulesets || []).filter((rs: any) => rs.family === p.family)

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Policy: {p.from_zone} → {p.to_zone}</h2>
          <button className="btn" onClick={safeClose} style={{ background: 'transparent', border: 0 }}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field"><label>Family</label>
            <select className="select" value={p.family} onChange={e => set({ family: e.target.value })}>
              <option value="ipv4">ipv4</option>
              <option value="ipv6">ipv6</option>
            </select>
          </div>
          <div className="field"><label>Rule-set name</label>
            <input type="text" list="zone-rulesets"
              value={p.rule_set} onChange={e => set({ rule_set: e.target.value })}
              placeholder="pick an existing rule-set" />
            <datalist id="zone-rulesets">
              {candidates.map((rs: any) => (
                <option key={rs.name} value={rs.name}>
                  default={rs.default_action} · {rs.rules?.length ?? 0} rules
                </option>
              ))}
            </datalist>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={safeClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => onSave(p)}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
