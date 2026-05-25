import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, Group, RuleSet, Rule } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'

// Groups — redesigned firewall-groups overview.
//   KPI tiles by type + per-type group cards with REAL usage counts + a
//   usage donut + most-used list. Usage = number of distinct firewall rules
//   that reference the group (cross-referenced from rulesets, both families).
//   NO per-group sparklines: there is no per-group usage-over-time data, so a
//   sparkline there would be fabricated. Dropped by design.

const TYPE_META: Record<string, { label: string; icon: string; accent: string }> = {
  'address-group':   { label: 'Address Groups',   icon: '◐', accent: 'ok' },
  'network-group':   { label: 'Network Groups',   icon: '▦', accent: 'muted' },
  'port-group':      { label: 'Port Groups',      icon: '⊞', accent: 'warn' },
  'mac-group':       { label: 'MAC Groups',       icon: '▢', accent: 'brand' },
  'interface-group': { label: 'Interface Groups', icon: '⇄', accent: 'brand' },
  'domain-group':    { label: 'Domain Groups',    icon: '◇', accent: 'muted' },
}

// Which AddrSpec.group.* field references a given group type.
function refFieldFor(type: string): keyof NonNullable<NonNullable<Rule['source']>['group']> | null {
  switch (type) {
    case 'address-group':   return 'address_group'
    case 'network-group':   return 'network_group'
    case 'port-group':      return 'port_group'
    case 'domain-group':    return 'domain_group'
    case 'mac-group':       return 'mac_group'
    case 'interface-group': return 'interface_group'
  }
  return null
}

export function Groups() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Group | null>(null)
  const [filter, setFilter] = useState<string>('all')

  const q = useQuery({
    queryKey: ['groups', id],
    queryFn: () => api.listGroups(id!),
    enabled: !!id,
  })

  // For usage cross-reference: fetch rulesets for both families. These are
  // cached and shared with the Firewall page's queries (same queryKey shape).
  const rs4 = useQuery({
    queryKey: ['rulesets', id, 'ipv4'],
    queryFn: () => api.listRuleSets(id!, 'ipv4'),
    enabled: !!id,
  })
  const rs6 = useQuery({
    queryKey: ['rulesets', id, 'ipv6'],
    queryFn: () => api.listRuleSets(id!, 'ipv6'),
    enabled: !!id,
  })

  const save = useMutation({
    mutationFn: (g: Group) => api.upsertGroup(id!, g),
    onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: ['groups', id] }) },
  })
  const del = useMutation({
    mutationFn: (g: { kind: string; name: string }) => api.deleteGroup(id!, g.kind, g.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups', id] }),
  })

  const groups = q.data || []

  // Build groupName+type -> count of DISTINCT rules referencing it.
  const usage = useMemo(() => {
    const allRules: Rule[] = []
    for (const rs of [...(rs4.data || []), ...(rs6.data || [])]) {
      for (const r of (rs.rules || [])) allRules.push(r)
    }
    const map: Record<string, number> = {}
    for (const g of groups) {
      const field = refFieldFor(g.type)
      if (!field) { map[`${g.type}:${g.name}`] = 0; continue }
      let n = 0
      for (const rule of allRules) {
        const s = rule.source?.group?.[field]
        const d = rule.destination?.group?.[field]
        if (s === g.name || d === g.name) n++   // distinct rule counted once
      }
      map[`${g.type}:${g.name}`] = n
    }
    return map
  }, [groups, rs4.data, rs6.data])

  const usageOf = (g: Group) => usage[`${g.type}:${g.name}`] ?? 0

  // --- type buckets + KPI counts ---
  const byType = groups.reduce<Record<string, Group[]>>((acc, g) => {
    (acc[g.type] = acc[g.type] || []).push(g); return acc
  }, {})
  const count = (t: string) => byType[t]?.length || 0
  const total = groups.length
  const otherCount = count('mac-group') + count('interface-group') + count('domain-group')

  // most-used (real, by rule references)
  const mostUsed = [...groups]
    .map(g => ({ g, n: usageOf(g) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .filter(x => x.n > 0)

  const filtered = filter === 'all' ? groups : groups.filter(g => g.type === filter)
  const usageLoading = rs4.isLoading || rs6.isLoading

  // donut: share by group COUNT per type
  const donutData = [
    { label: 'Address', n: count('address-group'), color: 'var(--ok)' },
    { label: 'Network', n: count('network-group'), color: '#9b6fe6' },
    { label: 'Port', n: count('port-group'), color: 'var(--warn-ink)' },
    { label: 'MAC/Iface', n: count('mac-group') + count('interface-group'), color: 'var(--brand)' },
  ].filter(d => d.n > 0)

  return (
    <>
      <DeviceHeader />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 16 }}>Firewall Groups</h2>
          <div className="hint">Reusable address / network / port / domain / MAC / interface groups</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select className="select" value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="all">All types ({total})</option>
            {Object.keys(byType).map(t => <option key={t} value={t}>{t} ({count(t)})</option>)}
          </select>
          <button className="btn btn-primary" onClick={() => setEditing({
            name: '', type: 'address-group', family: 'ipv4', members: [],
          })}>+ New group</button>
        </div>
      </div>

      {save.isError && <div className="err">{(save.error as Error).message}</div>}
      {del.isError && <div className="err">Delete failed: {(del.error as Error).message}</div>}

      {/* KPI tiles */}
      <div className="grp-kpi-row">
        <GrpKpi icon="◷" label="Total Groups" value={String(total)} sub="Across all types" />
        <GrpKpi icon="◐" label="Address Groups" value={String(count('address-group'))} sub="reusable hosts" accent="ok" />
        <GrpKpi icon="⊞" label="Port Groups" value={String(count('port-group'))} sub="TCP / UDP" accent="warn" />
        <GrpKpi icon="▦" label="Network Groups" value={String(count('network-group'))} sub="CIDR blocks" accent="muted" />
        <GrpKpi icon="▢" label="Other Groups" value={String(otherCount)} sub="MAC / Interface" accent="brand" />
      </div>

      {/* Per-type cards: two columns. Each type either lists its groups or shows empty state */}
      <div className="grp-grid">
        {['address-group', 'network-group', 'port-group', 'mac-group', 'interface-group', 'domain-group']
          .filter(t => count(t) > 0 || ['address-group', 'network-group', 'port-group', 'mac-group'].includes(t))
          .map(type => (
            <GroupTypeCard key={type} type={type} groups={byType[type] || []}
              usageOf={usageOf} usageLoading={usageLoading} onEdit={setEditing} onDelete={(g) => {
                if (!confirm(`Delete group "${g.name}"? VyOS will reject this if it is referenced by a firewall rule.`)) return
                del.mutate({ kind: g.type, name: g.name })
              }} />
          ))}

        {/* Usage overview donut */}
        <div className="grp-side-card">
          <div className="side-title">Group Usage Overview</div>
          <div className="donut-wrap">
            <CountDonut data={donutData} total={total} />
            <div className="donut-legend">
              {donutData.map(d => (
                <div key={d.label}>
                  <span className="lg" style={{ background: d.color }} />{d.label}
                  <b className="mono" style={{ marginLeft: 6 }}>{d.n} ({total ? Math.round(d.n / total * 100) : 0}%)</b>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Most used (real, by rule references) */}
        <div className="grp-side-card">
          <div className="side-title">Most Used Groups</div>
          {usageLoading ? (
            <div className="dim" style={{ fontSize: 12 }}>computing usage…</div>
          ) : mostUsed.length === 0 ? (
            <div className="dim" style={{ fontSize: 12 }}>No groups are referenced by any rule yet.</div>
          ) : (
            <ol className="grp-mostused">
              {mostUsed.map(({ g, n }, i) => (
                <li key={`${g.type}:${g.name}`}>
                  <span className="rank">{i + 1}.</span>
                  <span className="mono nm">{g.name}</span>
                  <span className="mono dim ru">{n} rule{n === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div className="hint" style={{ marginTop: 14, fontSize: 12 }}>
        Tip: use groups to simplify rule management and improve reusability across firewall policies.
      </div>

      {editing && (
        <GroupModal initial={editing} onClose={() => setEditing(null)}
          onSave={save.mutate} saving={save.isPending} />
      )}
    </>
  )
}

function GroupTypeCard({ type, groups, usageOf, usageLoading, onEdit, onDelete }: {
  type: string; groups: Group[]
  usageOf: (g: Group) => number; usageLoading: boolean
  onEdit: (g: Group) => void; onDelete: (g: Group) => void
}) {
  const meta = TYPE_META[type] || { label: type, icon: '○', accent: '' }
  const memberLabel = type === 'network-group' ? 'Networks'
    : type === 'interface-group' ? 'Interfaces'
    : type === 'port-group' ? 'Ports' : 'Members'

  return (
    <div className={'grp-card ' + meta.accent}>
      <div className="grp-card-head">
        <span className="grp-card-title">{meta.label}</span>
        <span className="grp-card-count">{groups.length}</span>
        <span className="grp-card-icon">{meta.icon}</span>
      </div>
      {groups.length === 0 ? (
        <div className="grp-empty">
          <div className="grp-empty-icon">{meta.icon}</div>
          <div>No {meta.label.toLowerCase()} defined.</div>
          <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
            Create one to reuse across rules.
          </div>
        </div>
      ) : (
        <table className="tbl grp-tbl">
          <thead><tr>
            <th>Name</th><th className="right">{memberLabel}</th><th className="right">Usage</th><th></th>
          </tr></thead>
          <tbody>
            {groups.map(g => {
              const n = usageOf(g)
              return (
                <tr key={g.name} onClick={() => onEdit(g)}>
                  <td className="mono">{g.name}</td>
                  <td className="right mono dim">{g.members?.length ?? 0}</td>
                  <td className="right mono" style={{ color: n > 0 ? 'var(--ok)' : 'var(--ink-faint)' }}>
                    {usageLoading ? '…' : `${n} rule${n === 1 ? '' : 's'}`}
                  </td>
                  <td className="right" onClick={e => e.stopPropagation()}>
                    <button className="btn" style={{ height: 22, padding: '0 7px', fontSize: 10 }}
                      onClick={() => onEdit(g)}>edit</button>
                    {' '}
                    <button className="btn btn-danger" style={{ height: 22, padding: '0 7px', fontSize: 10 }}
                      onClick={() => onDelete(g)}>del</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

function GrpKpi({ icon, label, value, sub, accent }: {
  icon: string; label: string; value: string; sub?: string
  accent?: string
}) {
  return (
    <div className={'grp-kpi' + (accent ? ' ' + accent : '')}>
      <div className="grp-kpi-icon">{icon}</div>
      <div className="grp-kpi-value mono">{value}</div>
      <div className="grp-kpi-label">{label}</div>
      {sub && <div className="grp-kpi-sub">{sub}</div>}
    </div>
  )
}

function CountDonut({ data, total }: { data: Array<{ label: string; n: number; color: string }>; total: number }) {
  const r = 40, c = 2 * Math.PI * r
  let offset = 0
  return (
    <svg width={96} height={96} viewBox="0 0 110 110" style={{ flex: 'none' }}>
      <circle cx={55} cy={55} r={r} fill="none" stroke="var(--bg-subtle)" strokeWidth={11} />
      {total > 0 && data.map(d => {
        const len = (d.n / total) * c
        const el = (
          <circle key={d.label} cx={55} cy={55} r={r} fill="none" stroke={d.color} strokeWidth={11}
            strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}
            transform="rotate(-90 55 55)" />
        )
        offset += len
        return el
      })}
      <text x={55} y={59} textAnchor="middle" fontSize={16} fontWeight={600}
        fill="var(--ink)" fontFamily="var(--font-mono)">{total}</text>
    </svg>
  )
}

function GroupModal({ initial, onClose, onSave, saving }: {
  initial: Group; onClose: () => void;
  onSave: (g: Group) => void; saving: boolean;
}) {
  const [g, setG] = useState<Group>(structuredClone(initial))
  const [membersText, setMembersText] = useState(g.members.join('\n'))
  const commit = () => onSave({
    ...g, members: membersText.split(/\n/).map(s => s.trim()).filter(Boolean),
  })
  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{g.name || 'New group'}</h2>
          <button className="btn" onClick={onClose}
            style={{ background: 'transparent', border: 0 }}>✕</button>
        </div>
        <div className="modal-body">
          <div className="row2">
            <div className="field"><label>Name</label>
              <input type="text" value={g.name}
                onChange={e => setG({ ...g, name: e.target.value })} /></div>
            <div className="field"><label>Type</label>
              <select className="select" value={g.type}
                onChange={e => setG({ ...g, type: e.target.value })}>
                <option value="address-group">address-group</option>
                <option value="network-group">network-group</option>
                <option value="port-group">port-group</option>
                <option value="domain-group">domain-group</option>
                <option value="mac-group">mac-group</option>
                <option value="interface-group">interface-group</option>
              </select>
            </div>
          </div>
          {(g.type === 'address-group' || g.type === 'network-group') && (
            <div className="field"><label>Family</label>
              <select className="select" value={g.family || 'ipv4'}
                onChange={e => setG({ ...g, family: e.target.value })}>
                <option value="ipv4">ipv4</option><option value="ipv6">ipv6</option>
              </select></div>
          )}
          <div className="field"><label>Description</label>
            <input type="text" value={g.description || ''}
              onChange={e => setG({ ...g, description: e.target.value })} /></div>
          <div className="field"><label>Members <span className="hint">(one per line)</span></label>
            <textarea value={membersText}
              onChange={e => setMembersText(e.target.value)} rows={8}
              placeholder={memberPlaceholder(g.type)} /></div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={commit}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function memberPlaceholder(t: string): string {
  switch (t) {
    case 'address-group': return '10.0.0.1\n10.0.0.5\n10.0.0.10'
    case 'network-group': return '10.0.0.0/24\n192.168.1.0/24'
    case 'port-group':    return '443\n80\n8080-8090'
    case 'domain-group':  return 'example.com\ninternal.corp'
    case 'mac-group':     return '00:11:22:33:44:55'
    case 'interface-group': return 'eth0\neth1'
    default: return ''
  }
}
