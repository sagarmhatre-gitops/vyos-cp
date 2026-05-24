import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { DeviceHeader } from '../components/DeviceHeader'

export function RuleSetsList() {
  const { id, family } = useParams<{ id: string; family: string }>()
  const qc = useQueryClient()
  const [err, setErr] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['rulesets', id, family],
    queryFn: () => api.listRuleSets(id!, family!),
    enabled: !!id && !!family,
  })

  const del = useMutation({
    mutationFn: (name: string) => api.deleteRuleSet(id!, family!, name),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['rulesets', id, family] }) },
    onError: (e: any) => setErr(e.message),
  })

  return (
    <>
      <DeviceHeader />
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 16 }}>Rule-sets ({family})</h2>
        <div className="hint">
          IPv4 / IPv6 named firewall chains.&nbsp;
          <Link to={`/devices/${id}/firewall/${family === 'ipv4' ? 'ipv6' : 'ipv4'}`}>
            Switch to {family === 'ipv4' ? 'IPv6' : 'IPv4'}
          </Link>
        </div>
      </div>
      {err && <div className="err">Delete failed: {err}</div>}
      <div className="card">
        <table className="tbl">
          <thead><tr>
            <th>Name</th><th>Default action</th>
            <th className="right">Rules</th>
            <th className="right">Actions</th>
          </tr></thead>
          <tbody>
            {(q.data || []).map(rs => (
              <tr key={rs.name}>
                <td className="mono">
                  <Link to={`/devices/${id}/firewall/${family}/${rs.name}`}>{rs.name}</Link>
                </td>
                <td><span className={`badge ${rs.default_action === 'accept' ? 'ok' : 'danger'}`}>{rs.default_action || '—'}</span></td>
                <td className="right dim mono">{rs.rules?.length ?? 0}</td>
                <td className="right">
                  <button className="btn btn-danger"
                    style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                    onClick={() => {
                      if (!confirm(`Delete rule-set "${rs.name}"? VyOS will reject this if a zone policy references it.`)) return
                      del.mutate(rs.name)
                    }}
                    disabled={del.isPending}>delete</button>
                </td>
              </tr>
            ))}
            {q.data && q.data.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 20, color: 'var(--ink-muted)' }}>No rule-sets on this device.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
