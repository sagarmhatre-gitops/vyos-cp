import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, User } from '../lib/api'

type Role = 'admin' | 'operator' | 'viewer'
const ALL_ROLES: Role[] = ['admin', 'operator', 'viewer']

export function Users() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const meQ = useQuery({ queryKey: ['me'], queryFn: () => api.me() })
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.listUsers() })

  const create = useMutation({
    mutationFn: (u: { email: string; display_name: string; password: string; roles: string[] }) =>
      api.createUser(u),
    onSuccess: () => { setAdding(false); setErr(null); qc.invalidateQueries({ queryKey: ['users'] }) },
    onError: (e: any) => setErr(e.message),
  })
  const save = useMutation({
    mutationFn: (u: { id: string; name: string; password: string; roles: string[] }) =>
      api.updateUser(u.id, { name: u.name, password: u.password || undefined, roles: u.roles }),
    onSuccess: () => { setEditing(null); setErr(null); qc.invalidateQueries({ queryKey: ['users'] }) },
    onError: (e: any) => setErr(e.message),
  })
  const del = useMutation({
    mutationFn: (id: string) => api.deleteUser(id),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['users'] }) },
    onError: (e: any) => setErr(e.message),
  })

  const users = q.data || []
  const meID = meQ.data?.id

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 18 }}>Users</h1>
          <div className="hint">Control-plane accounts. Device-level credentials are managed on each device.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ New user</button>
      </div>

      {err && <div className="err">{err}</div>}

      <div className="card">
        <table className="tbl">
          <thead><tr>
            <th>Email</th><th>Name</th><th>Roles</th><th>Created</th>
            <th className="right">Actions</th>
          </tr></thead>
          <tbody>
            {users.map(u => {
              const isMe = u.id === meID
              return (
                <tr key={u.id}>
                  <td className="mono">
                    {u.email}
                    {isMe && <span className="badge info" style={{ marginLeft: 6 }}>you</span>}
                    {u.disabled && <span className="badge warn" style={{ marginLeft: 6 }}>disabled</span>}
                  </td>
                  <td>{u.display_name}</td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {u.roles.map(r => (
                      <span key={r} className={`badge ${r === 'admin' ? 'danger' : r === 'operator' ? 'info' : ''}`}
                        style={{ marginRight: 4 }}>{r}</span>
                    ))}
                  </td>
                  <td className="dim mono" style={{ fontSize: 11 }}>
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                  <td className="right">
                    <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                      onClick={() => setEditing(u)}>edit</button>
                    {' '}
                    <button className="btn btn-danger"
                      style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                      disabled={isMe}
                      title={isMe ? 'You cannot delete your own account' : ''}
                      onClick={() => {
                        if (!confirm(`Delete user "${u.email}"? They will lose access immediately.`)) return
                        del.mutate(u.id)
                      }}>delete</button>
                  </td>
                </tr>
              )
            })}
            {users.length === 0 && !q.isLoading && (
              <tr><td colSpan={5} style={{ padding: 20, color: 'var(--ink-muted)' }}>
                No users yet. Click “+ New user”.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {adding && <AddUserModal onClose={() => setAdding(false)}
        onSave={create.mutate} pending={create.isPending} />}
      {editing && <EditUserModal initial={editing} onClose={() => setEditing(null)}
        onSave={save.mutate} pending={save.isPending} />}
    </>
  )
}

function AddUserModal({ onClose, onSave, pending }: {
  onClose: () => void
  onSave: (u: { email: string; display_name: string; password: string; roles: string[] }) => void
  pending: boolean
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [roles, setRoles] = useState<Role[]>(['viewer'])

  const toggleRole = (r: Role) => setRoles(rs => rs.includes(r) ? rs.filter(x => x !== r) : [...rs, r])

  return (
    <div className="modal-backdrop" onClick={() => !pending && onClose()}>
      <form className="modal" onClick={e => e.stopPropagation()}
        onSubmit={e => { e.preventDefault(); onSave({ email, display_name: name, password, roles }) }}>
        <div className="modal-head"><h2>New user</h2>
          <button type="button" className="btn" onClick={onClose}
            style={{ background: 'transparent', border: 0 }}>✕</button></div>
        <div className="modal-body">
          <div className="field"><label>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
          <div className="field"><label>Display name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required /></div>
          <div className="field"><label>Password <span className="hint">(min 8 chars)</span></label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              minLength={8} required /></div>
          <div className="field"><label>Roles</label>
            <div style={{ display: 'flex', gap: 12 }}>
              {ALL_ROLES.map(r => (
                <label key={r} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={roles.includes(r)} onChange={() => toggleRole(r)} />
                  <code className="mono">{r}</code>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={pending}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={pending || roles.length === 0}>
            {pending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}

function EditUserModal({ initial, onClose, onSave, pending }: {
  initial: User
  onClose: () => void
  onSave: (u: { id: string; name: string; password: string; roles: string[] }) => void
  pending: boolean
}) {
  const [name, setName] = useState(initial.display_name)
  const [password, setPassword] = useState('')
  const [roles, setRoles] = useState<Role[]>(initial.roles as Role[])

  const toggleRole = (r: Role) => setRoles(rs => rs.includes(r) ? rs.filter(x => x !== r) : [...rs, r])

  return (
    <div className="modal-backdrop" onClick={() => !pending && onClose()}>
      <form className="modal" onClick={e => e.stopPropagation()}
        onSubmit={e => { e.preventDefault(); onSave({ id: initial.id, name, password, roles }) }}>
        <div className="modal-head"><h2 className="mono">{initial.email}</h2>
          <button type="button" className="btn" onClick={onClose}
            style={{ background: 'transparent', border: 0 }}>✕</button></div>
        <div className="modal-body">
          <div className="field"><label>Email <span className="hint">(immutable)</span></label>
            <input type="email" value={initial.email} disabled /></div>
          <div className="field"><label>Display name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required /></div>
          <div className="field"><label>Password <span className="hint">(leave blank to keep)</span></label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="unchanged" /></div>
          <div className="field"><label>Roles</label>
            <div style={{ display: 'flex', gap: 12 }}>
              {ALL_ROLES.map(r => (
                <label key={r} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={roles.includes(r)} onChange={() => toggleRole(r)} />
                  <code className="mono">{r}</code>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={pending}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={pending || roles.length === 0}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
