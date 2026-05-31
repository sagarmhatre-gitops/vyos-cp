import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, VPNProfile } from '../lib/api'
import { VPNProfileDrawer } from './VPNProfileDrawer'

// VPNProfilesPage — fleet-wide list of VPN profiles, filtered by type
// (ike or esp). One shared component because IKE and ESP behave
// identically from a list/edit perspective; only the table columns
// and proposal shape differ, and those are localized in the drawer.
//
// Phase 1 features:
//   - List across all devices
//   - Filter by device (dropdown)
//   - Free-text search (name + description)
//   - Click row → edit in drawer
//   - "+ New IKE/ESP profile" button → create in drawer
//   - Delete with reference-integrity preflight (server-side, surfaces
//     HTTP 409 with the offending peer names)
//
// Phase 2 will add tag filtering. Tags are stored and displayed now.

export function VPNProfilesPage({ type }: { type: 'ike' | 'esp' }) {
  const qc = useQueryClient()
  const profiles = useQuery({
    queryKey: ['vpn-profiles'],
    queryFn: () => api.listVPNProfiles(),
    refetchInterval: 30_000,
  })
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.listDevices(),
  })

  const [deviceFilter, setDeviceFilter] = useState<string>('')
  const [search, setSearch] = useState('')
  // editor: null = closed; { create: true } = create-new mode;
  //         { profile } = edit-existing mode
  const [editor, setEditor] = useState<
    { create?: boolean; profile?: VPNProfile } | null
  >(null)

  // Just the profiles of this page's type.
  const typed = useMemo(() => {
    return (profiles.data || []).filter(p => p.type === type)
  }, [profiles.data, type])

  const visible = useMemo(() => {
    let list = typed
    if (deviceFilter) list = list.filter(p => p.device_id === deviceFilter)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.tags || []).some(t => t.toLowerCase().includes(q)),
      )
    }
    return list
  }, [typed, deviceFilter, search])

  const del = useMutation({
    mutationFn: (id: string) => api.deleteVPNProfile(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vpn-profiles'] }),
  })

  const onDelete = (p: VPNProfile) => {
    const used = p.used_by || []
    if (used.length > 0) {
      // Belt-and-suspenders preflight on the frontend — backend also
      // enforces this. Frontend version explains the situation in
      // friendlier prose.
      alert(
        `Cannot delete ${p.type.toUpperCase()} profile "${p.name}".\n\n` +
        `It is still referenced by ${used.length} peer(s): ${used.join(', ')}.\n\n` +
        `Remove the reference from those peers first, then try again.`,
      )
      return
    }
    if (!confirm(
      `Delete ${p.type.toUpperCase()} profile "${p.name}" on ${p.device_name}?\n\n` +
      `This removes it from the device immediately. Cannot be undone.`,
    )) return
    del.mutate(p.id)
  }

  const titleLabel = type === 'ike' ? 'IKE Profiles' : 'ESP Profiles'
  const phase = type === 'ike' ? 'Phase 1' : 'Phase 2'

  // Pick the device for create. If only one device, use it; if more
  // than one, prompt via the drawer's device dropdown (Phase 2 — for
  // now we default to the first device and the operator can switch).
  const firstDeviceID = (devices.data || [])[0]?.id
  const firstDeviceName = (devices.data || [])[0]?.name

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 18 }}>{titleLabel}</h1>
          <div className="hint">
            {type === 'ike'
              ? 'Phase 1 cryptographic profiles, shared across IPsec peers on a device.'
              : 'Phase 2 cryptographic profiles, shared across IPsec peers on a device.'}
          </div>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setEditor({ create: true })}
          disabled={!firstDeviceID}
          title={!firstDeviceID ? 'Add a device first' : ''}
        >
          + New {type.toUpperCase()} profile
        </button>
      </div>

      {/* Filter row ------------------------------------------------- */}
      <div style={{
        display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center',
        fontSize: 12, flexWrap: 'wrap',
      }}>
        <span className="dim">Device:</span>
        <select
          className="select"
          value={deviceFilter}
          onChange={e => setDeviceFilter(e.target.value)}
          style={{ minWidth: 180 }}
        >
          <option value="">All devices</option>
          {(devices.data || []).map(d => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, description, tags"
          style={{ flex: 1, maxWidth: 320 }}
        />
        <span className="dim" style={{ fontSize: 11 }}>
          {visible.length} of {typed.length} profile{typed.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Table ------------------------------------------------------ */}
      <div className="card">
        <table className="tbl">
          <thead><tr>
            <th>Name</th>
            <th>Device</th>
            <th>Description</th>
            <th>Tags</th>
            <th>Used by</th>
            <th>Last updated</th>
            <th className="right">Actions</th>
          </tr></thead>
          <tbody>
            {visible.map(p => (
              <tr key={p.id}
                onClick={() => setEditor({ profile: p })}
                style={{ cursor: 'pointer' }}
                title="Click to edit">
                <td className="mono" style={{ fontWeight: 500 }}>{p.name}</td>
                <td className="dim" style={{ fontSize: 12 }}>{p.device_name}</td>
                <td className="dim" style={{ fontSize: 12 }}>
                  {p.description || <em style={{ fontStyle: 'italic' }}>—</em>}
                </td>
                <td>
                  {(p.tags || []).length === 0
                    ? <span className="dim" style={{ fontSize: 11 }}>—</span>
                    : (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {(p.tags || []).map(t => (
                          <span key={t} className="badge" style={{ fontSize: 10, padding: '1px 6px' }}>{t}</span>
                        ))}
                      </div>
                    )}
                </td>
                <td className="dim" style={{ fontSize: 12 }}>
                  {(p.used_by || []).length === 0
                    ? <span className="dim">unused</span>
                    : (p.used_by || []).join(', ')}
                </td>
                <td className="dim" style={{ fontSize: 11 }}>
                  {p.updated_at ? new Date(p.updated_at).toLocaleString() : '—'}
                </td>
                <td className="right" onClick={e => e.stopPropagation()}>
                  <button
                    className="btn btn-danger"
                    style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => onDelete(p)}
                    disabled={del.isPending}
                    title={(p.used_by || []).length > 0 ? 'Still referenced by peers' : ''}
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center' }}>
                {profiles.isLoading
                  ? <span className="dim">Loading…</span>
                  : (
                    <>
                      <div style={{ color: 'var(--ink-muted)', fontSize: 13, marginBottom: 6 }}>
                        {typed.length === 0
                          ? `No ${type.toUpperCase()} profiles found on any device.`
                          : 'No profiles match the current filter.'}
                      </div>
                      {typed.length === 0 && firstDeviceID && (
                        <button className="btn btn-primary"
                          onClick={() => setEditor({ create: true })}>
                          + Create your first {type.toUpperCase()} profile
                        </button>
                      )}
                    </>
                  )}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Editor drawer --------------------------------------------- */}
      {editor && (
        <VPNProfileDrawer
          initial={editor.profile}
          createType={editor.create ? type : undefined}
          createDeviceID={editor.create ? firstDeviceID : undefined}
          createDeviceName={editor.create ? firstDeviceName : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            qc.invalidateQueries({ queryKey: ['vpn-profiles'] })
          }}
        />
      )}
    </>
  )
}
