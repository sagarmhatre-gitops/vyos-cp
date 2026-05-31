import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api, VPNPeer } from '../lib/api'
import { VPNPeerDrawer } from './VPNPeerDrawer'

// VPNPeersPage — fleet-wide list of IPsec peers across all devices.
//
// Phase 3A scope (Path C):
//   - Read-only list with details drawer (click row to view)
//   - "+ New peer" button redirects to device IPsec wizard
//   - Delete supported with confirm
//   - No inline create/edit (defer to Phase 3B if operators ask)
//
// Columns: Peer · Device · Remote · IKE · ESP · Tunnels · Actions
//
// The tunnels column shows just the count. Operators who want to see
// the actual subnets click the row → drawer shows full tunnel detail.

export function VPNPeersPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const peers = useQuery({
    queryKey: ['vpn-peers'],
    queryFn: () => api.listVPNPeers(),
    refetchInterval: 30_000,
  })
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.listDevices(),
  })

  const [deviceFilter, setDeviceFilter] = useState<string>('')
  const [search, setSearch] = useState('')
  const [viewing, setViewing] = useState<VPNPeer | null>(null)

  const visible = useMemo(() => {
    let list = peers.data || []
    if (deviceFilter) list = list.filter(p => p.device_id === deviceFilter)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.peer?.remote_address || '').toLowerCase().includes(q) ||
        (p.peer?.description || '').toLowerCase().includes(q) ||
        (p.peer?.ike_group || '').toLowerCase().includes(q) ||
        (p.peer?.default_esp_group || '').toLowerCase().includes(q),
      )
    }
    return list
  }, [peers.data, deviceFilter, search])

  const del = useMutation({
    mutationFn: (id: string) => api.deleteVPNPeer(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vpn-peers'] }),
  })

  const onDelete = (e: React.MouseEvent, p: VPNPeer) => {
    e.stopPropagation()  // don't open the drawer
    if (!confirm(
      `Delete peer "${p.name}" on ${p.device_name}?\n\n` +
      `This tears down the tunnel immediately on the device. Cannot be undone.`,
    )) return
    del.mutate(p.id)
  }

  // "+ New peer" — redirect to the device's IPsec wizard. If multiple
  // devices, prompt for which device first. If only one, jump straight in.
  const onNewPeer = () => {
    const ds = devices.data || []
    if (ds.length === 0) {
      alert('Add a device first.')
      return
    }
    if (ds.length === 1) {
      navigate(`/devices/${ds[0].id}/ipsec?action=add`)
      return
    }
    // Multi-device case: simple prompt. Phase 3B could make this nicer
    // with a proper device picker modal.
    const names = ds.map((d, i) => `${i + 1}. ${d.name}`).join('\n')
    const pick = prompt(
      `Add a peer to which device?\n\n${names}\n\nEnter the number:`)
    if (!pick) return
    const idx = parseInt(pick, 10) - 1
    if (idx < 0 || idx >= ds.length) {
      alert('Invalid selection.')
      return
    }
    navigate(`/devices/${ds[idx].id}/ipsec?action=add`)
  }

  return (
    <>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'flex-end', marginBottom: 16,
      }}>
        <div>
          <h1 style={{ fontSize: 18 }}>Peers</h1>
          <div className="hint">
            Site-to-site IPsec peers across the fleet. Click a row for details.
          </div>
        </div>
        <button className="btn btn-primary" onClick={onNewPeer}>
          + New peer
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
          placeholder="Search name, remote, profile, description"
          style={{ flex: 1, maxWidth: 320 }}
        />
        <span className="dim" style={{ fontSize: 11 }}>
          {visible.length} of {(peers.data || []).length} peer
          {(peers.data || []).length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Table ------------------------------------------------------ */}
      <div className="card">
        <table className="tbl">
          <thead><tr>
            <th>Peer</th>
            <th>Device</th>
            <th>Remote</th>
            <th>IKE</th>
            <th>ESP</th>
            <th className="right" style={{ width: 80 }}>Tunnels</th>
            <th className="right" style={{ width: 100 }}>Actions</th>
          </tr></thead>
          <tbody>
            {visible.map(p => (
              <tr
                key={p.id}
                onClick={() => setViewing(p)}
                style={{ cursor: 'pointer' }}
                title="Click to view details"
              >
                <td className="mono" style={{ fontWeight: 500 }}>{p.name}</td>
                <td className="dim" style={{ fontSize: 12 }}>{p.device_name}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {p.peer?.remote_address || <span className="dim">—</span>}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {p.peer?.ike_group || <span className="dim">—</span>}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {p.peer?.default_esp_group || <span className="dim">—</span>}
                </td>
                <td className="right" style={{ fontSize: 12 }}>
                  {p.peer?.tunnels?.length ?? 0}
                </td>
                <td className="right">
                  <button
                    className="btn btn-danger"
                    style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={e => onDelete(e, p)}
                    disabled={del.isPending}
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center' }}>
                {peers.isLoading
                  ? <span className="dim">Loading…</span>
                  : (peers.data || []).length === 0
                    ? (
                      <>
                        <div style={{ color: 'var(--ink-muted)', fontSize: 13, marginBottom: 6 }}>
                          No peers found on any device.
                        </div>
                        <button className="btn btn-primary" onClick={onNewPeer}>
                          + Add your first peer
                        </button>
                      </>
                    )
                    : <span className="dim">No peers match the current filter.</span>}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Details drawer --------------------------------------------- */}
      {viewing && (
        <VPNPeerDrawer
          peer={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  )
}
