import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, Group } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'
import { LoadingRow } from '../components/Loading'

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

  const save = useMutation({
    mutationFn: (g: Group) => api.upsertGroup(id!, g),
    onSuccess: () => {
      setEditing(null)
      qc.invalidateQueries({ queryKey: ['groups', id] })
    },
  })

  const del = useMutation({
    mutationFn: (g: { kind: string; name: string }) => api.deleteGroup(id!, g.kind, g.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups', id] }),
  })

  const groups = q.data || []
  const types = Array.from(new Set(groups.map(g => g.type)))
  const filtered = filter === 'all' ? groups : groups.filter(g => g.type === filter)

  return (
    <>
      <DeviceHeader />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 16 }}>Firewall groups</h2>
          <div className="hint">Reusable address / network / port / domain / MAC / interface groups</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select className="select" value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="all">All types ({groups.length})</option>
            {types.map(t => (
              <option key={t} value={t}>{t} ({groups.filter(g => g.type === t).length})</option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={() => setEditing({
            name: '', type: 'address-group', family: 'ipv4', members: [],
          })}>+ New group</button>
        </div>
      </div>

      {save.isError && <div className="err">{(save.error as Error).message}</div>}
      {del.isError && <div className="err">Delete failed: {(del.error as Error).message}</div>}

      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th><th>Type</th><th>Family</th>
              <th className="right">Members</th><th>Description</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(g => (
              <tr key={`${g.type}:${g.family}:${g.name}`} onClick={() => setEditing(g)}>
                <td className="mono">{g.name}</td>
                <td><span className="badge info">{g.type}</span></td>
                <td className="mono dim">{g.family || '—'}</td>
                <td className="right mono dim">{g.members?.length ?? 0}</td>
                <td className="dim" style={{ fontSize: 12 }}>{g.description || '—'}</td>
                <td className="right" onClick={e => e.stopPropagation()}>
                  <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => setEditing(g)}>edit</button>
                  {' '}
                  <button className="btn btn-danger"
                    style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => {
                      if (!confirm(`Delete group "${g.name}"? VyOS will reject this if the group is referenced by a firewall rule.`)) return
                      del.mutate({ kind: g.type, name: g.name })
                    }}>delete</button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !q.isLoading && (
              <tr><td colSpan={6} style={{ padding: 20, color: 'var(--ink-muted)' }}>
                {groups.length === 0 ? 'No groups on this device.' : `No ${filter} groups.`}
              </td></tr>
            )}
            {q.isLoading && (
              <LoadingRow colSpan={6} />
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <GroupModal initial={editing} onClose={() => setEditing(null)}
          onSave={save.mutate} saving={save.isPending} />
      )}
    </>
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
