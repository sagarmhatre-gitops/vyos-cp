// FleetFilterBar — compact filter row above the dashboard's device table.
//
// Three controls:
//   - free-text search (matches device name or hostname, case-insensitive)
//   - status dropdown (all / online / offline)
//   - tag dropdown (all / each unique tag in the fleet)
//
// All filtering is client-side. The fleet sizes we expect (single-digit to
// low-hundreds) don't justify pushing this to the backend yet — and keeping
// it client-side means filtering is instant with no round-trip.

import { Device } from '../lib/api'

export type FleetFilter = {
  q: string
  status: 'all' | 'online' | 'offline'
  tag: string // empty string = all
}

export const emptyFilter: FleetFilter = { q: '', status: 'all', tag: '' }

export function applyFleetFilter(devices: Device[], f: FleetFilter): Device[] {
  const q = f.q.trim().toLowerCase()
  return devices.filter(d => {
    if (f.status !== 'all' && d.status !== f.status) return false
    if (f.tag && !(d.tags || []).includes(f.tag)) return false
    if (q) {
      const hay = `${d.name} ${d.hostname || ''} ${d.address}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

export function FleetFilterBar({ filter, onChange, devices }: {
  filter: FleetFilter
  onChange: (f: FleetFilter) => void
  devices: Device[]
}) {
  // Tag universe across all devices, deduped + sorted. Recompute on every
  // render is cheap (max a few hundred entries) and saves us a useMemo cost.
  const tags = [...new Set(devices.flatMap(d => d.tags || []))].sort()

  const inputStyle: React.CSSProperties = {
    height: 28, padding: '0 8px', fontSize: 12,
    border: '1px solid var(--line)', borderRadius: 4,
    background: 'var(--bg)', color: 'var(--ink)',
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
      <input
        type="text"
        placeholder="Search devices, hostnames, IPs…"
        value={filter.q}
        onChange={e => onChange({ ...filter, q: e.target.value })}
        style={{ ...inputStyle, flex: '1 1 240px', minWidth: 180 }}
      />
      <select
        value={filter.status}
        onChange={e => onChange({ ...filter, status: e.target.value as FleetFilter['status'] })}
        style={inputStyle}
      >
        <option value="all">All status</option>
        <option value="online">Online</option>
        <option value="offline">Offline</option>
      </select>
      <select
        value={filter.tag}
        onChange={e => onChange({ ...filter, tag: e.target.value })}
        style={inputStyle}
        disabled={tags.length === 0}
      >
        <option value="">All tags</option>
        {tags.map(t => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      {(filter.q || filter.status !== 'all' || filter.tag) && (
        <button
          onClick={() => onChange(emptyFilter)}
          style={{
            ...inputStyle,
            cursor: 'pointer', color: 'var(--ink-muted)',
            background: 'var(--bg-subtle)',
          }}>
          Clear
        </button>
      )}
    </div>
  )
}
