import { useEffect, useState } from 'react'
import { Route, Routes, Navigate, Link, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from './lib/api'
import { GlobalProgress } from './components/GlobalProgress'
import { useTheme } from './hooks/useTheme'
import { GlobalSearch } from './components/GlobalSearch'
import { Login } from './pages/Login'
import { Dashboard } from './pages/Dashboard'
import { Devices } from './pages/Devices'
import { RuleSetEditor } from './pages/RuleSetEditor'
import { RuleSetsList } from './pages/RuleSetsList'
import { Groups } from './pages/Groups'
import { Zones } from './pages/Zones'
import { NAT } from './pages/NAT'
import { Interfaces } from './pages/Interfaces'
import { QoS } from './pages/QoS'
import { SNMP } from './pages/SNMP'
import { IPsec } from './pages/IPsec'
import { VPNIKEProfiles } from './pages/VPNIKEProfiles'
import { VPNESPProfiles } from './pages/VPNESPProfiles'
import { VPNPeersPage } from './pages/VPNPeersPage'
import { LiveConfig } from './pages/LiveConfig'
import { Users } from './pages/Users'
import { Overview } from './pages/Overview'
import { Audit, Templates } from './pages/Audit'

type User = { id: string; name: string; email?: string; roles?: string[] } | null

export default function App() {
  const [user, setUser] = useState<User>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const tok = api.getToken()
    if (!tok) { setChecking(false); return }
    api.req<any>('/api/v1/me')
      .then((u) => setUser({ id: u.id, name: u.name }))
      .catch(() => api.setToken(null))
      .finally(() => setChecking(false))
  }, [])

  if (checking) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-muted)' }}>Loading…</div>
  }

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login onAuthed={(u: any) => setUser({ id: u.id, name: u.display_name })} />} />
      </Routes>
    )
  }

  return <Shell user={user} onLogout={() => { api.setToken(null); setUser(null) }} />
}

function Shell({ user, onLogout }: { user: NonNullable<User>; onLogout: () => void }) {
  const [railOpen, setRailOpen] = useState(false)
  const loc = useLocation()
  const crumbs = loc.pathname.split('/').filter(Boolean)

  return (
    <div className="shell">
      <GlobalProgress />
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn" onClick={() => setRailOpen(o => !o)}
            style={{ background: 'transparent', border: 0, color: '#fff', display: 'none' }}
            aria-label="Menu">☰</button>
          <div className="brand">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8">
              <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z"/>
            </svg>
            <span>Vynetra-cp</span>
          </div>
        </div>

        <GlobalSearch />

        <div className="right">
          <ThemeToggle />
          <span>{user.name}</span>
          <span className="avatar">{initials(user.name)}</span>
          <button className="btn" style={{ background: 'transparent', color: '#fff', borderColor: 'rgba(255,255,255,0.2)' }}
            onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <div className="crumbs">
        <Link to="/">home</Link>
        <SmartCrumbs segments={crumbs} />
      </div>

      <Rail open={railOpen} />

      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/devices/:id" element={<Overview />} />
          <Route path="/devices/:id/overview" element={<Overview />} />
          <Route path="/devices/:id/firewall/:family" element={<RuleSetsList />} />
          <Route path="/devices/:id/firewall/:family/:name" element={<RuleSetEditor />} />
          <Route path="/devices/:id/groups" element={<Groups />} />
          <Route path="/devices/:id/zones" element={<Zones />} />
          <Route path="/devices/:id/nat" element={<NAT />} />
          <Route path="/devices/:id/interfaces" element={<Interfaces />} />
          <Route path="/devices/:id/qos" element={<QoS />} />
          <Route path="/devices/:id/snmp" element={<SNMP />} />
          <Route path="/devices/:id/ipsec" element={<IPsec />} />
          <Route path="/vpn" element={<Navigate to="/vpn/ike-profiles" replace />} />
          <Route path="/vpn/ike-profiles" element={<VPNIKEProfiles />} />
          <Route path="/vpn/esp-profiles" element={<VPNESPProfiles />} />
          <Route path="/vpn/peers" element={<VPNPeersPage />} />
          <Route path="/devices/:id/live-config" element={<LiveConfig />} />
          <Route path="/users" element={<Users />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}

function Rail({ open }: { open: boolean }) {
  const [groups, setGroups] = useState<Record<string, boolean>>({
    overview: true, security: true, network: false, vpn: true, ops: true, platform: false,
  })
  const loc = useLocation()
  const toggle = (k: string) => setGroups(g => ({ ...g, [k]: !g[k] }))

  return (
    <aside className={`rail ${open ? 'open' : ''}`}>
      <Group label="Overview" k="overview" open={groups.overview} toggle={toggle}>
        <Item to="/" label="Dashboard" active={loc.pathname === '/'} />
        <Item to="/devices" label="Devices" active={loc.pathname.startsWith('/devices')} />
        <Item to="/audit" label="Audit log" active={loc.pathname === '/audit'} />
      </Group>
      <Group label="Security policy" k="security" open={groups.security} toggle={toggle}>
        <Item to="/templates" label="Rule-set templates" active={loc.pathname === '/templates'} />
        <div className="rail-item dim" style={{ fontSize: 11, paddingLeft: 20 }}>
          Pick a device ↑ to edit rules, groups, zones, NAT
        </div>
      </Group>
      <Group label="VPN" k="vpn" open={groups.vpn} toggle={toggle}>
        <Item to="/vpn/ike-profiles" label="IKE Profiles" active={loc.pathname === '/vpn/ike-profiles'} />
        <Item to="/vpn/esp-profiles" label="ESP Profiles" active={loc.pathname === '/vpn/esp-profiles'} />
        <Item to="/vpn/peers" label="Peers" active={loc.pathname === '/vpn/peers'} />
      </Group>
      <Group label="Operations" k="ops" open={groups.ops} toggle={toggle}>
        <Item to="/audit" label="Audit log" active={loc.pathname === '/audit'} />
        <Item to="/users" label="Users" active={loc.pathname === '/users'} />
      </Group>
    </aside>
  )
}

function Group({ label, k, open, toggle, children }: any) {
  return (
    <div className="rail-group" data-open={open ? 'true' : 'false'}>
      <div className="rail-group-header" onClick={() => toggle(k)}>
        <span>{label}</span><span className="chev">▾</span>
      </div>
      <div className="rail-items">{children}</div>
    </div>
  )
}

function Item({ to, label, active }: { to: string; label: string; active: boolean }) {
  return <Link to={to} className={`rail-item ${active ? 'active' : ''}`}>{label}</Link>
}

function initials(name: string) {
  return name.split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase()
}

// ThemeToggle — single-button cycle through light → dark → auto.
//
// We chose a cycle button rather than a dropdown to keep the topbar
// uncluttered. The icon reflects the *current* theme (☀ in light, ☾ in
// dark, ◐ in auto), and tooltip names the *next* state so the action is
// clear without a menu. Power users who want to set a specific theme can
// click multiple times; muscle memory forms quickly with three states.
function ThemeToggle() {
  const { theme, cycle } = useTheme()
  const icon = theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐'
  const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'auto' : 'light'
  const title = `Theme: ${theme} (click for ${next})`
  return (
    <button className="theme-toggle" onClick={cycle} title={title} aria-label={title}>
      {icon}
    </button>
  )
}

// SmartCrumbs renders the path breadcrumb with friendly substitutions:
//   - UUIDs that follow the "devices" segment are replaced with the device
//     name (looked up from the cached device list)
//   - Each segment links back to its level so users can jump up the tree
//   - The final segment is highlighted as "here" but is not a link
//
// We don't try to humanize every segment ("ipv4" → "IPv4 firewall"); the
// path words are short and operators read them fine. The big win is just
// not showing "efe4640b-a37c-4ab6-94ad-a04aae64f353" in the chrome.
function SmartCrumbs({ segments }: { segments: string[] }) {
  const devicesQ = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.listDevices(),
    staleTime: 30_000,
  })
  const byID = new Map((devicesQ.data || []).map(d => [d.id, d.name]))

  return (
    <>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1
        const isDeviceID = i > 0 && segments[i - 1] === 'devices'
        const label = isDeviceID ? (byID.get(seg) || seg) : seg
        const href = '/' + segments.slice(0, i + 1).join('/')
        return (
          <span key={i}>
            <span className="sep">›</span>
            {isLast ? (
              <span className="here">{label}</span>
            ) : (
              <Link to={href} style={{ color: 'inherit' }}>{label}</Link>
            )}
          </span>
        )
      })}
    </>
  )
}
