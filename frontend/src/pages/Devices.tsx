import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { fmtBps } from '../components/Sparkline'
import { TagPills } from '../components/TagPills'

export function Devices() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [editing, setEditing] = useState<{
    id: string; name: string; address: string; hostname?: string;
    insecure_skip_verify?: boolean; tags?: string[]; location?: string;
  } | null>(null)
  const devices = useQuery({
    queryKey: ['devices'], queryFn: () => api.listDevices(),
    refetchInterval: 15_000,
  })

  // Tag universe for the filter row — collect unique tags across the fleet
  // and surface them as clickable pills above the table.
  const allTags = useMemo(() => {
    const s = new Set<string>()
    for (const d of devices.data || []) for (const t of d.tags || []) s.add(t)
    return [...s].sort()
  }, [devices.data])

  // Apply tag filter if one is active.
  const visibleDevices = useMemo(() => {
    const list = devices.data || []
    if (!tagFilter) return list
    return list.filter(d => (d.tags || []).includes(tagFilter))
  }, [devices.data, tagFilter])

  const del = useMutation({
    mutationFn: (id: string) => api.deleteDevice(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  })

  const editDevice = useMutation({
    mutationFn: (body: {
      id: string; name: string; address: string; hostname: string;
      api_key: string; insecure_skip_verify: boolean;
      tags: string[]; location: string;
    }) =>
      api.updateDevice(body.id, {
        name: body.name, address: body.address, hostname: body.hostname,
        api_key: body.api_key, insecure_skip_verify: body.insecure_skip_verify,
        tags: body.tags, location: body.location,
      }),
    onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: ['devices'] }) },
  })

  const toggleProd = useMutation({
    mutationFn: async (d: { id: string; tags: string[]; on: boolean }) => {
      const next = d.on
        ? [...new Set([...d.tags, 'production'])]
        : d.tags.filter(t => t.toLowerCase() !== 'production')
      return api.updateDeviceTags(d.id, next)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  })

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div><h1 style={{ fontSize: 18 }}>Devices</h1><div className="hint">Managed VyOS instances</div></div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add device</button>
      </div>

      {allTags.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8,
          marginBottom: 10, fontSize: 11, flexWrap: 'wrap' }}>
          <span className="dim">Filter by tag:</span>
          <button
            onClick={() => setTagFilter(null)}
            style={{
              padding: '2px 8px', fontSize: 11, borderRadius: 3,
              border: tagFilter === null ? '1px solid var(--brand)' : '1px solid var(--line)',
              background: tagFilter === null ? 'var(--brand-soft)' : 'transparent',
              color: tagFilter === null ? 'var(--brand-ink)' : 'var(--ink-muted)',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}>all ({(devices.data || []).length})</button>
          <TagPills tags={allTags}
            onClick={(t) => setTagFilter(tagFilter === t ? null : t)} />
          {tagFilter && (
            <span className="dim" style={{ marginLeft: 6 }}>
              showing {visibleDevices.length} matching <code className="mono">{tagFilter}</code>
            </span>
          )}
        </div>
      )}

      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th><th>Address</th><th>Status</th>
              <th>VyOS</th><th>Hostname</th>
              <th className="right">Throughput</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleDevices.map(d => (
              <tr key={d.id}>
                <td className="mono">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Link to={`/devices/${d.id}`}>{d.name}</Link>
                    <TagPills tags={d.tags} size="sm" />
                  </div>
                  {d.location && (
                    <div className="dim" style={{ fontSize: 10.5, marginTop: 2, fontFamily: 'var(--font-sans)' }}>
                      {d.location}
                    </div>
                  )}
                </td>
                <td className="mono dim">{d.address}</td>
                <td>
                  <span className={`status ${d.status}`}><span className="d"/>{d.status}</span>
                </td>
                <td className="mono dim">{d.version || '—'}</td>
                <td className="mono dim">{d.hostname || '—'}</td>
                <td className="right mono" style={{ fontSize: 12, lineHeight: 1.3 }}>
                  {d.throughput ? (
                    <>
                      <div style={{ color: 'var(--ok)' }}>↓ {fmtBps(d.throughput.rx_bps)}</div>
                      <div style={{ color: 'var(--brand)' }}>↑ {fmtBps(d.throughput.tx_bps)}</div>
                    </>
                  ) : <span className="dim">—</span>}
                </td>
                <td className="right">
                  <Link to={`/devices/${d.id}/firewall/ipv4`}>rules</Link>{' · '}
                  <Link to={`/devices/${d.id}/groups`}>groups</Link>{' · '}
                  <Link to={`/devices/${d.id}/nat`}>nat</Link>{' · '}
                  <Link to={`/devices/${d.id}/zones`}>zones</Link>{' · '}
                  <Link to={`/devices/${d.id}/qos`}>qos</Link>{' · '}
                  <Link to={`/devices/${d.id}/snmp`}>snmp</Link>{' · '}
                  <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => setEditing({
                      id: d.id, name: d.name, address: d.address, hostname: d.hostname,
                      insecure_skip_verify: d.insecure_skip_verify,
                      tags: d.tags || [], location: d.location || '',
                    })}>
                    edit
                  </button>
                  {' · '}
                  <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => {
                      const isProd = (d.tags || []).some(t => t.toLowerCase() === 'production')
                      toggleProd.mutate({ id: d.id, tags: d.tags || [], on: !isProd })
                    }}>
                    {(d.tags || []).some(t => t.toLowerCase() === 'production') ? 'unmark prod' : 'mark prod'}
                  </button>
                  {' · '}
                  <button className="btn btn-danger" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => confirm(`Remove ${d.name}?`) && del.mutate(d.id)}>delete</button>
                </td>
              </tr>
            ))}
            {(devices.data || []).length === 0 && (
              <tr><td colSpan={7} style={{ padding: 20, color: 'var(--ink-muted)' }}>
                No devices yet. Click “+ Add device”.
              </td></tr>
            )}
            {(devices.data || []).length > 0 && visibleDevices.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 20, color: 'var(--ink-muted)' }}>
                No devices match tag <code className="mono">{tagFilter}</code>.
                {' '}<a onClick={() => setTagFilter(null)} style={{ cursor: 'pointer' }}>Clear filter</a>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {adding && <AddDeviceModal onClose={() => setAdding(false)}
        onAdded={() => { setAdding(false); qc.invalidateQueries({ queryKey: ['devices'] }) }} />}
      {editing && <EditDeviceModal initial={editing}
        pending={editDevice.isPending}
        error={editDevice.error as Error | null}
        onClose={() => setEditing(null)}
        onSave={editDevice.mutate} />}
    </>
  )
}

function AddDeviceModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('')
  const [address, setAddress] = useState('https://')
  const [apiKey, setApiKey] = useState('')
  const [skip, setSkip] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setBusy(true)
    try {
      await api.addDevice({ name, address, api_key: apiKey, insecure_skip_verify: skip })
      onAdded()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h2>Add VyOS device</h2>
          <button className="btn" type="button" onClick={onClose} style={{ background: 'transparent', border: 0 }}>✕</button>
        </div>
        <div className="modal-body">
          {err && <div className="err">{err}</div>}
          <div className="field">
            <label>Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label>Address <span className="hint">(include scheme and port)</span></label>
            <input type="text" value={address} onChange={e => setAddress(e.target.value)} placeholder="https://vyos.local" required />
          </div>
          <div className="field">
            <label>API key</label>
            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} required />
          </div>
          <div className="field">
            <label>
              <input type="checkbox" checked={skip} onChange={e => setSkip(e.target.checked)} />
              {' '}Skip TLS verification (for self-signed certs)
            </label>
          </div>
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--ink-muted)' }}>How do I get an API key?</summary>
            <pre style={{ background: 'var(--bg-subtle)', padding: 10, borderRadius: 6, fontSize: 11, marginTop: 8, overflowX: 'auto' }}>
{`On the VyOS device:
  configure
  set service https api rest
  set service https api keys id vyos-cp key <YOUR_SECRET>
  commit
  save`}
            </pre>
          </details>
        </div>
        <div className="modal-foot">
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} type="submit">
            {busy ? 'Verifying…' : 'Add device'}
          </button>
        </div>
      </form>
    </div>
  )
}

function EditDeviceModal({ initial, onClose, onSave, pending, error }: {
  initial: {
    id: string; name: string; address: string; hostname?: string;
    insecure_skip_verify?: boolean; tags?: string[]; location?: string;
  }
  onClose: () => void
  onSave: (b: {
    id: string; name: string; address: string; hostname: string;
    api_key: string; insecure_skip_verify: boolean;
    tags: string[]; location: string;
  }) => void
  pending: boolean
  error: Error | null
}) {
  const [name, setName] = useState(initial.name)
  const [address, setAddress] = useState(initial.address)
  const [hostname, setHostname] = useState(initial.hostname || '')
  const [apiKey, setApiKey] = useState('')
  const [skip, setSkip] = useState(initial.insecure_skip_verify ?? false)
  const [rotating, setRotating] = useState(false)
  // Tags input is comma-separated text — easier than building a chip-input
  // widget. We trim/split on save.
  const [tagsRaw, setTagsRaw] = useState((initial.tags || []).join(', '))
  const [location, setLocation] = useState(initial.location || '')

  return (
    <div className="modal-backdrop" onClick={() => !pending && onClose()}>
      <form className="modal" onClick={e => e.stopPropagation()}
        onSubmit={e => {
          e.preventDefault()
          const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean)
          onSave({
            id: initial.id, name, address, hostname,
            api_key: apiKey, insecure_skip_verify: skip,
            tags, location,
          })
        }} style={{ width: 540 }}>
        <div className="modal-head">
          <h2 className="mono">Edit {initial.name}</h2>
          <button type="button" className="btn" onClick={onClose}
            style={{ background: 'transparent', border: 0 }}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field"><label>Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required /></div>
          <div className="field"><label>Address</label>
            <input type="text" value={address} onChange={e => setAddress(e.target.value)}
              placeholder="https://10.10.0.1" required /></div>
          <div className="row2">
            <div className="field"><label>Hostname <span className="hint">(optional label)</span></label>
              <input type="text" value={hostname} onChange={e => setHostname(e.target.value)} /></div>
            <div className="field"><label>Location <span className="hint">(site / DC / rack)</span></label>
              <input type="text" value={location} onChange={e => setLocation(e.target.value)}
                placeholder="NYC DC, Rack 12" /></div>
          </div>

          <div className="field">
            <label>Tags <span className="hint">(comma-separated; "production" / "staging" / "dev" get semantic colors)</span></label>
            <input type="text" value={tagsRaw} onChange={e => setTagsRaw(e.target.value)}
              placeholder="edge, production, nyc" />
          </div>

          <div className="field"><label>
            <input type="checkbox" checked={skip}
              onChange={e => setSkip(e.target.checked)}
              style={{ marginRight: 6 }} />
            Skip TLS verification <span className="hint">(self-signed cert)</span>
          </label></div>

          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              API key
              {!rotating && (
                <button type="button" className="btn" style={{ height: 20, padding: '0 8px', fontSize: 10 }}
                  onClick={() => setRotating(true)}>rotate</button>
              )}
            </label>
            {rotating ? (
              <>
                <input type="password" value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="new API key; leave blank to cancel rotation"
                  autoFocus />
                <div className="hint" style={{ marginTop: 2 }}>
                  Existing key kept if you leave this blank.
                </div>
              </>
            ) : (
              <div className="dim mono" style={{ fontSize: 12 }}>•••••••••••• (stored; click rotate to replace)</div>
            )}
          </div>

          {error && <div className="err">{error.message}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={pending}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
