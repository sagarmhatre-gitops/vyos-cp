import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { api, TrafficPolicy, TrafficClass, ClassMatcher, QoSEngine, TrafficPolicyBinding, Interface } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'

export function QoS() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<TrafficPolicy | null>(null)
  const [binding, setBinding] = useState<{ policy: string } | null>(null)

  const q = useQuery({
    queryKey: ['qos', id], queryFn: () => api.listTrafficPolicies(id!), enabled: !!id,
  })
  const ifacesQ = useQuery({
    queryKey: ['interfaces', id], queryFn: () => api.listInterfaces(id!),
    enabled: !!id, staleTime: 30_000,
  })
  const bindingsQ = useQuery({
    queryKey: ['qos-bindings', id], queryFn: () => api.listQoSBindings(id!),
    enabled: !!id, refetchInterval: 20_000,
  })

  const save = useMutation({
    mutationFn: (p: TrafficPolicy) => api.upsertTrafficPolicy(id!, p),
    onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: ['qos', id] }) },
  })
  const del = useMutation({
    mutationFn: (p: { engine: string; name: string }) => api.deleteTrafficPolicy(id!, p.engine, p.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['qos', id] }),
  })
  const bind = useMutation({
    mutationFn: (b: TrafficPolicyBinding) => api.bindTrafficPolicy(id!, b),
    onSuccess: () => { setBinding(null); qc.invalidateQueries({ queryKey: ['qos', id] }); qc.invalidateQueries({ queryKey: ['qos-bindings', id] }) },
  })
  const unbind = useMutation({
    mutationFn: (b: TrafficPolicyBinding) => api.unbindTrafficPolicy(id!, b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['qos-bindings', id] }) },
  })
  const cleanup = useMutation({
    mutationFn: () => api.cleanupQoSOrphans(id!),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['qos-bindings', id] })
      qc.invalidateQueries({ queryKey: ['interfaces', id] })
      alert(`Removed ${r.cleaned} orphaned IFB declaration(s).`)
    },
    onError: (e: any) => alert(`Cleanup failed: ${e.message}`),
  })

  const policies = q.data || []

  return (
    <>
      <DeviceHeader />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 16 }}>Traffic policies</h2>
          <div className="hint">Shaping, policing, and priority queues — HTB / HFSC / FQ-CoDel.</div>
          <div style={{ marginTop: 6, fontSize: 11, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: 4,
              background: 'var(--ok, #0a8f50)',
            }} />
            <span style={{ color: 'var(--ink-muted)' }}>
              {policies.length} {policies.length === 1 ? 'policy' : 'policies'} on device
              {q.dataUpdatedAt ? ` · fetched ${new Date(q.dataUpdatedAt).toLocaleTimeString()}` : ''}
            </span>
            <button className="btn" style={{ height: 20, padding: '0 8px', fontSize: 10 }}
              onClick={() => q.refetch()}>↻ refetch</button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {policies.length > 0 && (
            <button className="btn btn-danger" onClick={() => {
              if (!confirm(`Delete all ${policies.length} QoS policies from the device?`)) return
              policies.forEach(p => del.mutate({ engine: p.engine, name: p.name }))
            }}>
              Delete all
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setEditing({
            name: '', engine: 'htb', bandwidth: '100mbit',
            default_bandwidth: '10mbit', default_ceiling: '100mbit', default_priority: 5,
            classes: [],
          })}>+ New policy</button>
        </div>
      </div>

      {save.isError && <div className="err">{(save.error as Error).message}</div>}
      {bind.isError && <div className="err">Bind failed: {(bind.error as Error).message}</div>}
      {del.isError && <div className="err">Delete failed: {(del.error as Error).message}</div>}
      {unbind.isError && <div className="err">Unbind failed: {(unbind.error as Error).message}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th><th>Engine</th><th>Bandwidth</th>
              <th className="right">Classes</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {policies.map(p => (
              <tr key={`${p.engine}:${p.name}`} onClick={() => setEditing(p)}>
                <td className="mono">{p.name}</td>
                <td><span className="badge info">{p.engine}</span></td>
                <td className="mono dim">{p.bandwidth || '—'}</td>
                <td className="right mono dim">{p.classes?.length ?? 0}</td>
                <td className="right" onClick={e => e.stopPropagation()}>
                  <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => setBinding({ policy: p.name })}>bind</button>
                  {' '}
                  <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => setEditing(p)}>edit</button>
                  {' '}
                  <button className="btn btn-danger" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => {
                      // Count interfaces this policy is bound on so the
                      // confirm message can warn the operator. The cascade
                      // happens server-side; this is just user-facing notice.
                      const bound = (bindingsQ.data || []).filter(
                        b => b.policy_name === p.name).length
                      const msg = bound > 0
                        ? `Delete "${p.name}"?\n\n` +
                          `This policy is currently bound on ${bound} interface${bound === 1 ? '' : 's'}. ` +
                          `Deleting it will also unbind these interfaces, removing any active traffic shaping.`
                        : `Delete "${p.name}"?`
                      if (confirm(msg)) {
                        del.mutate({ engine: p.engine, name: p.name })
                      }
                    }}>
                    delete
                  </button>
                </td>
              </tr>
            ))}
            {policies.length === 0 && !q.isLoading && (
              <tr><td colSpan={5} style={{ padding: 20, color: 'var(--ink-muted)' }}>
                No traffic policies. Click “+ New policy”.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <BindingsCard bindings={bindingsQ.data || []}
        onUnbind={unbind.mutate} unbinding={unbind.isPending}
        onCleanup={() => {
          if (confirm('Remove any orphaned IFB declarations? Healthy bindings are left alone.')) {
            cleanup.mutate()
          }
        }}
        cleaning={cleanup.isPending} />

      {editing && (
        <PolicyModal initial={editing} onClose={() => setEditing(null)}
          onSave={save.mutate} saving={save.isPending} />
      )}
      {binding && (
        <BindModal policyName={binding.policy} interfaces={ifacesQ.data || []}
          onClose={() => setBinding(null)} onSave={bind.mutate} saving={bind.isPending} />
      )}
    </>
  )
}

function BindingsCard({ bindings, onUnbind, unbinding, onCleanup, cleaning }: {
  bindings: TrafficPolicyBinding[]
  onUnbind: (b: TrafficPolicyBinding) => void
  unbinding: boolean
  onCleanup: () => void
  cleaning: boolean
}) {
  const orphanCount = bindings.filter(b => /^ifb\d+$/.test(b.interface)).length
    - bindings.filter(b => !/^ifb\d+$/.test(b.interface)).length // crude: more ifbs than reals
  const showCleanup = orphanCount > 0 || bindings.some(b => /^ifb\d+$/.test(b.interface))
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-head">
        <span className="card-title">Interface bindings</span>
        {showCleanup && (
          <button className="btn"
            style={{ height: 22, padding: '0 8px', fontSize: 11 }}
            onClick={onCleanup} disabled={cleaning}
            title="Remove IFB declarations that no longer have a complete redirect+qos pairing">
            {cleaning ? 'Cleaning…' : 'Reset orphaned IFBs'}
          </button>
        )}
      </div>
      <table className="tbl">
        <thead><tr>
          <th>Interface</th><th>Kind</th><th>Direction</th><th>Policy</th>
          <th className="right">Actions</th>
        </tr></thead>
        <tbody>
          {bindings.map((b, i) => {
            const isIFB = /^ifb\d+$/.test(b.interface) || b.interface.startsWith('ifb-')
            return (
              <tr key={`${b.kind}:${b.interface}:${b.direction}`}>
                <td className="mono">
                  {b.interface}
                  {isIFB && (
                    <span className="badge info" style={{ marginLeft: 6, fontSize: 10 }}
                      title="Intermediate Functional Block — receives redirected ingress traffic from a real interface to enable two-direction shaping">
                      ingress shaping
                    </span>
                  )}
                </td>
                <td className="dim">{b.kind || (isIFB ? 'ifb' : '—')}</td>
                <td><span className="badge info">{b.direction}</span></td>
                <td className="mono">{b.policy_name}</td>
                <td className="right">
                  <button className="btn btn-danger"
                    style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    disabled={unbinding}
                    onClick={() => {
                      // For real interfaces, the backend will detect any
                      // paired IFB via `interfaces ethernet <n> redirect` and
                      // tear it down too — we just need to set shape_ingress.
                      const hasPairedIFB = !isIFB && bindings.some(x =>
                        /^ifb\d+$/.test(x.interface) || x.interface.startsWith('ifb-'))
                      const msg = hasPairedIFB
                        ? `Unbind ${b.policy_name} from ${b.interface}? This also removes the IFB ingress shaping.`
                        : `Unbind ${b.policy_name} from ${b.interface} ${b.direction}?`
                      if (!confirm(msg)) return
                      onUnbind({ ...b, shape_ingress: hasPairedIFB })
                    }}>unbind</button>
                </td>
              </tr>
            )
          })}
          {bindings.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 20, color: 'var(--ink-muted)' }}>
              No policies bound. Use the “bind” button on a policy row above.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function PolicyModal({ initial, onClose, onSave, saving }: {
  initial: TrafficPolicy; onClose: () => void;
  onSave: (p: TrafficPolicy) => void; saving: boolean;
}) {
  const [p, setP] = useState<TrafficPolicy>(structuredClone(initial))
  const [dirty, setDirty] = useState(false)
  const set = (patch: Partial<TrafficPolicy>) => { setDirty(true); setP(x => ({ ...x, ...patch })) }

  const safeClose = () => {
    if (dirty && !confirm('Discard your changes?')) return
    onClose()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') safeClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty])

  const addClass = () => {
    const nextID = p.classes?.length
      ? Math.max(...p.classes.map(c => c.id)) + 10
      : 10
    set({ classes: [...(p.classes || []), {
      id: nextID, bandwidth: '10mbit', priority: 5, matchers: [],
    }] })
  }
  const updateClass = (i: number, patch: Partial<TrafficClass>) => {
    set({ classes: (p.classes || []).map((c, idx) => idx === i ? { ...c, ...patch } : c) })
  }
  const removeClass = (i: number) => {
    set({ classes: (p.classes || []).filter((_, idx) => idx !== i) })
  }
  const addMatcher = (ci: number) => {
    const cls = (p.classes || [])[ci]
    const name = `m${(cls.matchers?.length || 0) + 1}`
    updateClass(ci, { matchers: [...(cls.matchers || []), { name }] })
  }
  const updateMatcher = (ci: number, mi: number, patch: Partial<ClassMatcher>) => {
    const cls = (p.classes || [])[ci]
    updateClass(ci, { matchers: (cls.matchers || []).map((m, idx) => idx === mi ? { ...m, ...patch } : m) })
  }
  const removeMatcher = (ci: number, mi: number) => {
    const cls = (p.classes || [])[ci]
    updateClass(ci, { matchers: (cls.matchers || []).filter((_, idx) => idx !== mi) })
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 720, maxWidth: '95vw' }}>
        <div className="modal-head">
          <h2 className="mono">{p.name || 'New policy'}</h2>
          <button className="btn" onClick={safeClose} style={{ background: 'transparent', border: 0 }}>✕</button>
        </div>
        <div className="modal-body">
          <div className="row2">
            <div className="field"><label>Name</label>
              <input type="text" value={p.name} onChange={e => set({ name: e.target.value })} /></div>
            <div className="field"><label>Engine</label>
              <select className="select" value={p.engine}
                onChange={e => set({ engine: e.target.value as QoSEngine })}>
                <option value="htb">HTB — hierarchical token bucket</option>
                <option value="hfsc">HFSC — hierarchical fair-service curve</option>
                <option value="fq-codel">FQ-CoDel — fair-queue CoDel (no hierarchy)</option>
              </select>
            </div>
          </div>
          <div className="row2">
            <div className="field"><label>Total bandwidth</label>
              <input type="text" value={p.bandwidth || ''} onChange={e => set({ bandwidth: e.target.value })}
                placeholder="100mbit, 1gbit, auto" /></div>
            <div className="field"><label>Description</label>
              <input type="text" value={p.description || ''} onChange={e => set({ description: e.target.value })} /></div>
          </div>

          {p.engine === 'fq-codel' && (
            <div className="row2">
              <div className="field"><label>CoDel target</label>
                <input type="text" value={p.codel_target || ''}
                  onChange={e => set({ codel_target: e.target.value })} placeholder="5ms" /></div>
              <div className="field"><label>CoDel interval</label>
                <input type="text" value={p.codel_interval || ''}
                  onChange={e => set({ codel_interval: e.target.value })} placeholder="100ms" /></div>
            </div>
          )}

          {p.engine !== 'fq-codel' && (
            <>
              <h3 style={sectionHeadStyle}>Default class</h3>
              {p.engine === 'hfsc' && (
                <div style={{
                  fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8,
                  padding: '6px 10px', background: 'var(--bg-subtle)', borderRadius: 4,
                  borderLeft: '2px solid var(--brand)',
                }}>
                  HFSC uses link-share and upper-limit curves. The values below
                  set the <code className="mono">m2</code> (steady-state rate) of each curve.
                  Most operators only need these two; <code className="mono">m1</code>/<code className="mono">d</code> slope shaping is rarely used.
                </div>
              )}
              <div className="row2">
                <div className="field">
                  <label>{p.engine === 'hfsc' ? 'Link-share rate (m2)' : 'Bandwidth'}</label>
                  <input type="text" value={p.default_bandwidth || ''}
                    onChange={e => set({ default_bandwidth: e.target.value })}
                    placeholder="e.g. 100mbit, 50%" />
                </div>
                <div className="field">
                  <label>{p.engine === 'hfsc' ? 'Upper-limit rate (m2, optional)' : 'Ceiling (borrow up to)'}</label>
                  <input type="text" value={p.default_ceiling || ''}
                    onChange={e => set({ default_ceiling: e.target.value })}
                    placeholder={p.engine === 'hfsc' ? 'leave blank for none' : 'e.g. 100mbit, 100%'} />
                </div>
              </div>
              {p.engine === 'htb' && (
                <div className="row2">
                  <div className="field"><label>Priority <span className="hint">(0 highest, 7 lowest)</span></label>
                    <input type="number" min={0} max={7} value={p.default_priority ?? 5}
                      onChange={e => set({ default_priority: parseInt(e.target.value) || 5 })} /></div>
                  <div className="field"><label>Queue type <span className="hint">(default class)</span></label>
                    <select className="select" value={p.default_queue || ''}
                      onChange={e => set({ default_queue: e.target.value })}>
                      <option value="">(default — fq-codel)</option>
                      <option value="fq-codel">fq-codel</option>
                      <option value="fair-queue">fair-queue (SFQ)</option>
                      <option value="drop-tail">drop-tail (FIFO)</option>
                      <option value="priority">priority</option>
                      <option value="random-detect">random-detect (RED)</option>
                    </select>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                <h3 style={sectionHeadStyle}>Classes</h3>
                <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                  onClick={addClass}>+ class</button>
              </div>
              {(p.classes || []).map((c, ci) => (
                <div key={ci} style={classCardStyle}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 500 }}>class {c.id}</span>
                    <button className="btn btn-danger" style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                      onClick={() => removeClass(ci)}>remove</button>
                  </div>
                  <div className="row2">
                    <div className="field"><label>ID</label>
                      <input type="number" value={c.id}
                        onChange={e => updateClass(ci, { id: parseInt(e.target.value) || 0 })} /></div>
                    <div className="field"><label>Description</label>
                      <input type="text" value={c.description || ''}
                        onChange={e => updateClass(ci, { description: e.target.value })} /></div>
                  </div>
                  <div className="row2">
                    <div className="field">
                      <label>{p.engine === 'hfsc' ? 'Link-share rate (m2)' : 'Bandwidth (guaranteed)'}</label>
                      <input type="text" value={c.bandwidth}
                        onChange={e => updateClass(ci, { bandwidth: e.target.value })} placeholder="10mbit" /></div>
                    <div className="field">
                      <label>{p.engine === 'hfsc' ? 'Upper-limit (m2, optional)' : 'Ceiling (borrow)'}</label>
                      <input type="text" value={c.ceiling || ''}
                        onChange={e => updateClass(ci, { ceiling: e.target.value })} placeholder="50mbit" /></div>
                  </div>
                  {p.engine === 'htb' && (
                    <div className="row2">
                      <div className="field"><label>Priority</label>
                        <input type="number" min={0} max={7} value={c.priority ?? 5}
                          onChange={e => updateClass(ci, { priority: parseInt(e.target.value) || 5 })} /></div>
                      <div className="field"><label>Burst (HTB only)</label>
                        <input type="text" value={c.burst || ''}
                          onChange={e => updateClass(ci, { burst: e.target.value })} placeholder="15kb" /></div>
                    </div>
                  )}
                  <div className="field"><label>Queue type</label>
                    <select className="select" value={c.queue || ''}
                      onChange={e => updateClass(ci, { queue: e.target.value })}>
                      <option value="">(default — fq-codel)</option>
                      <option value="fq-codel">fq-codel</option>
                      <option value="fair-queue">fair-queue (SFQ)</option>
                      <option value="drop-tail">drop-tail (FIFO)</option>
                      <option value="priority">priority</option>
                      <option value="random-detect">random-detect (RED)</option>
                    </select>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: 0.05 }}>Matchers</span>
                    <button className="btn" style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                      onClick={() => addMatcher(ci)}>+ matcher</button>
                  </div>
                  {(c.matchers || []).map((m, mi) => (
                    <div key={mi} style={matcherCardStyle}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <input type="text" value={m.name}
                          onChange={e => updateMatcher(ci, mi, { name: e.target.value })}
                          style={{ width: 140, fontSize: 12, height: 24, padding: '0 6px' }} />
                        <button className="btn btn-danger" style={{ height: 22, padding: '0 6px', fontSize: 11 }}
                          onClick={() => removeMatcher(ci, mi)}>✕</button>
                      </div>
                      <div className="row2" style={{ gap: 6 }}>
                        <input type="text" placeholder="protocol (tcp/udp/all)" value={m.protocol || ''}
                          onChange={e => updateMatcher(ci, mi, { protocol: e.target.value })}
                          style={smallInputStyle} />
                        <input type="text" placeholder="DSCP (ef, cs6, 46)" value={m.dscp || ''}
                          onChange={e => updateMatcher(ci, mi, { dscp: e.target.value })}
                          style={smallInputStyle} />
                      </div>
                      <div className="row2" style={{ gap: 6 }}>
                        <input type="text" placeholder="src addr" value={m.source_address || ''}
                          onChange={e => updateMatcher(ci, mi, { source_address: e.target.value })}
                          style={smallInputStyle} />
                        <input type="text" placeholder="src port" value={m.source_port || ''}
                          onChange={e => updateMatcher(ci, mi, { source_port: e.target.value })}
                          style={smallInputStyle} />
                      </div>
                      <div className="row2" style={{ gap: 6 }}>
                        <input type="text" placeholder="dst addr" value={m.dest_address || ''}
                          onChange={e => updateMatcher(ci, mi, { dest_address: e.target.value })}
                          style={smallInputStyle} />
                        <input type="text" placeholder="dst port" value={m.dest_port || ''}
                          onChange={e => updateMatcher(ci, mi, { dest_port: e.target.value })}
                          style={smallInputStyle} />
                      </div>
                      <input type="text" placeholder="mark (connmark/fwmark)" value={m.mark || ''}
                        onChange={e => updateMatcher(ci, mi, { mark: e.target.value })}
                        style={{ ...smallInputStyle, width: '100%', marginTop: 4 }} />
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={safeClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => onSave(p)}>
            {saving ? 'Committing…' : 'Commit'}
          </button>
        </div>
      </div>
    </div>
  )
}

function BindModal({ policyName, interfaces, onClose, onSave, saving }: {
  policyName: string; interfaces: Interface[];
  onClose: () => void; onSave: (b: TrafficPolicyBinding) => void; saving: boolean;
}) {
  const [b, setB] = useState<TrafficPolicyBinding>({
    policy_name: policyName, interface: '', kind: 'ethernet', direction: 'egress',
  })
  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Bind {policyName}</h2>
          <button className="btn" onClick={onClose} style={{ background: 'transparent', border: 0 }}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field"><label>Interface</label>
            <select className="select" value={b.interface}
              onChange={e => setB({ ...b, interface: e.target.value })}>
              <option value="">(pick one)</option>
              {interfaces.map(i => (
                <option key={`${i.kind}:${i.name}`} value={i.name}>
                  {i.name} · {i.kind}{i.addresses?.length ? ` · ${i.addresses[0]}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field"><label>Shape direction</label>
            <select className="select"
              value={b.shape_ingress ? 'both' : 'egress'}
              onChange={e => {
                const v = e.target.value
                setB({
                  ...b,
                  direction: 'egress', // always egress on the real interface
                  shape_ingress: v === 'both',
                })
              }}>
              <option value="egress">Outbound only (egress on {b.interface || 'interface'})</option>
              <option value="both">Both directions (egress + IFB ingress)</option>
            </select>
            {b.shape_ingress && (
              <div style={{
                marginTop: 6, fontSize: 11, color: 'var(--ink-muted)',
                padding: '6px 10px', background: 'var(--bg-subtle)', borderRadius: 4,
                borderLeft: '2px solid var(--brand)',
              }}>
                vyos-cp will allocate the next free IFB device (e.g. <code className="mono">ifb0</code>),
                redirect <code className="mono">{b.interface || '<iface>'}</code> ingress
                traffic into it, and apply <code className="mono">{policyName}</code> as
                egress on the IFB. Effect: download traffic shaped to the same policy as upload.
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving || !b.interface} onClick={() => onSave(b)}>
            {saving ? 'Binding…' : 'Bind'}
          </button>
        </div>
      </div>
    </div>
  )
}

const sectionHeadStyle: React.CSSProperties = {
  fontSize: 12, textTransform: 'uppercase', color: 'var(--ink-muted)',
  letterSpacing: '0.05em', marginTop: 12, marginBottom: 8,
}
const classCardStyle: React.CSSProperties = {
  border: '1px solid var(--line)', borderRadius: 6, padding: 10, marginBottom: 8,
  background: 'var(--bg-subtle)',
}
const matcherCardStyle: React.CSSProperties = {
  background: 'var(--bg-raised)', border: '1px solid var(--line)',
  borderRadius: 4, padding: 6, marginTop: 4,
}
const smallInputStyle: React.CSSProperties = {
  width: '100%', fontSize: 11, height: 24, padding: '0 6px',
  border: '1px solid var(--line-strong)', borderRadius: 4, background: 'var(--bg)',
}
