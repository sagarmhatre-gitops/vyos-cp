import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, Interface } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'
import { Loading } from '../components/Loading'
import { useLiveThroughput } from '../hooks/useLive'
import { Sparkline, fmtBps } from '../components/Sparkline'
import { InterfacesView } from './InterfacesView'

export function Interfaces() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Interface | null>(null)

  const q = useQuery({
    queryKey: ['interfaces', id],
    queryFn: () => api.listInterfaces(id!),
    enabled: !!id,
    refetchInterval: 20_000,
  })

  // Live throughput samples for the sparkline + latest rate tags per iface.
  const samples = useLiveThroughput(id)
  const latest = samples[samples.length - 1]?.per || {}

  const save = useMutation({
    mutationFn: (iface: Interface) => api.upsertInterface(id!, iface),
    onSuccess: () => {
      setEditing(null)
      qc.invalidateQueries({ queryKey: ['interfaces', id] })
    },
  })

  const ifaces = q.data || []
  // Group by kind so the page reads like the VyOS config tree.
  const byKind = ifaces.reduce<Record<string, Interface[]>>((acc, iface) => {
    (acc[iface.kind] = acc[iface.kind] || []).push(iface)
    return acc
  }, {})
  const kinds = Object.keys(byKind).sort()

  return (
    <>
      <DeviceHeader />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 16 }}>Interfaces</h2>
          <div className="hint">{ifaces.length} interface{ifaces.length === 1 ? '' : 's'} across {kinds.length} type{kinds.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      {save.isError && <div className="err">{(save.error as Error).message}</div>}
      {q.isError && <div className="err">Failed to load: {(q.error as Error).message}</div>}

      {q.isLoading ? (
        <div className="card" style={{ padding: 8 }}><Loading /></div>
      ) : kinds.length === 0 ? (
        <div className="card" style={{ padding: 20, color: 'var(--ink-muted)' }}>No interfaces found.</div>
      ) : (
        <InterfacesView ifaces={ifaces} samples={samples} latest={latest} onEdit={setEditing} />
      )}

      {editing && (
        <InterfaceModal initial={editing} onClose={() => setEditing(null)}
          onSave={save.mutate} saving={save.isPending} />
      )}
    </>
  )
}

function InterfaceModal({ initial, onClose, onSave, saving }: {
  initial: Interface; onClose: () => void;
  onSave: (i: Interface) => void; saving: boolean;
}) {
  const [iface, setIface] = useState<Interface>(structuredClone(initial))
  const [addrText, setAddrText] = useState((initial.addresses || []).join('\n'))

  const commit = () => onSave({
    ...iface,
    addresses: addrText.split(/\n/).map(s => s.trim()).filter(Boolean),
  })

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="mono">{iface.kind} {iface.name}</h2>
          <button className="btn" onClick={onClose}
            style={{ background: 'transparent', border: 0 }}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Description</label>
            <input type="text" value={iface.description || ''}
              onChange={e => setIface({ ...iface, description: e.target.value })} />
          </div>
          <div className="field">
            <label>Addresses <span className="hint">(CIDR or 'dhcp' / 'dhcpv6', one per line)</span></label>
            <textarea value={addrText} onChange={e => setAddrText(e.target.value)}
              rows={4} placeholder="10.0.0.1/24&#10;2001:db8::1/64" />
          </div>
          <div className="row2">
            <div className="field">
              <label>MTU</label>
              <input type="text" value={iface.mtu || ''}
                onChange={e => setIface({ ...iface, mtu: e.target.value })}
                placeholder="1500" />
            </div>
            <div className="field">
              <label>VRF</label>
              <input type="text" value={iface.vrf || ''}
                onChange={e => setIface({ ...iface, vrf: e.target.value })}
                placeholder="(none)" />
            </div>
          </div>
          {iface.hw_id && (
            <div className="field">
              <label>Hardware ID</label>
              <input type="text" value={iface.hw_id} disabled
                style={{ opacity: 0.6 }} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
            <label>
              <input type="checkbox" checked={!!iface.disabled}
                onChange={e => setIface({ ...iface, disabled: e.target.checked })} />
              {' '}Administratively disabled
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={commit}>
            {saving ? 'Committing…' : 'Commit'}
          </button>
        </div>
      </div>
    </div>
  )
}
