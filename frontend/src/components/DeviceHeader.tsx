import { Link, useParams, useLocation } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { prefetchForPath } from './prefetch'
import { api } from '../lib/api'
import { TagPills } from './TagPills'

// DeviceHeader shows the device name, status, tags, location, and a tab
// strip for Overview / Firewall / Groups / Zones / NAT / Interfaces / QoS /
// SNMP. Used at the top of every device-scoped page.
export function DeviceHeader() {
  const { id } = useParams<{ id: string }>()
  const loc = useLocation()
  const q = useQuery({
    queryKey: ['device', id],
    queryFn: () => api.getDevice(id!),
    enabled: !!id,
    refetchInterval: 15_000,
  })
  const d = q.data
  const _qc = useQueryClient()

  const tabs: Array<{ to: string; label: string; match: RegExp }> = [
    { to: `/devices/${id}`,                label: 'Overview', match: /\/devices\/[^/]+$|\/overview$/ },
    { to: `/devices/${id}/firewall/ipv4`, label: 'Firewall', match: /\/firewall\// },
    { to: `/devices/${id}/groups`,         label: 'Groups',   match: /\/groups$/ },
    { to: `/devices/${id}/zones`,          label: 'Zones',    match: /\/zones$/ },
    { to: `/devices/${id}/nat`,            label: 'NAT',      match: /\/nat$/ },
    { to: `/devices/${id}/interfaces`,     label: 'Interfaces', match: /\/interfaces/ },
    { to: `/devices/${id}/qos`,            label: 'QoS',      match: /\/qos/ },
    { to: `/devices/${id}/snmp`,           label: 'SNMP',     match: /\/snmp/ },
    { to: `/devices/${id}/ipsec`,          label: 'IPsec',    match: /\/ipsec/ },
    { to: `/devices/${id}/live-config`,     label: 'Live Config', match: /\/live-config/ },
  ]

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: 18 }} className="mono">{d?.name || 'device'}</h1>
            {d?.hostname && d.hostname !== d.name && (
              <span className="dim mono" style={{ fontSize: 12 }}>({d.hostname})</span>
            )}
            {d && (
              <span className={`status ${d.status}`}>
                <span className="d"/>{d.status}
              </span>
            )}
            <TagPills tags={d?.tags} />
          </div>
          <div className="hint mono" style={{ fontSize: 11, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span>{d?.address}</span>
            {d?.version && <span>· {d.version}</span>}
            {d?.location && (
              <span style={{ fontFamily: 'var(--font-sans)' }}>· 📍 {d.location}</span>
            )}
          </div>
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 2, borderBottom: '1px solid var(--line)',
        overflowX: 'auto',
      }}>
        {tabs.map(t => {
          const active = t.match.test(loc.pathname)
          return (
            <Link key={t.to} to={t.to}
              onMouseEnter={() => prefetchForPath(_qc, id!, t.to)}
              style={{
                padding: '8px 14px',
                fontSize: 13,
                color: active ? 'var(--brand)' : 'var(--ink-muted)',
                fontWeight: active ? 500 : 400,
                borderBottom: active ? '2px solid var(--brand)' : '2px solid transparent',
                marginBottom: -1,
                textDecoration: 'none',
                whiteSpace: 'nowrap',
              }}>
              {t.label}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
