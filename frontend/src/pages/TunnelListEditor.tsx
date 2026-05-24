import { useState } from 'react'
import type { Tunnel, ESPGroup } from '../lib/api'

// TunnelListEditor — edits a peer's full tunnel list (item 4: multiple
// local/remote subnet pairs, each with its own ESP/crypto group; item 2:
// per-tunnel enable/disable).
//
// Contract: fully controlled. Parent holds `tunnels` state and passes it in;
// every edit calls onChange with the next array. The parent submits the array
// as peer.tunnels. The backend (UpsertPeer) does atomic delete-then-set, so a
// removed tunnel or a re-enabled tunnel needs no explicit delete op — the array
// IS the desired end state.
//
// Tunnel numbering: VyOS keys tunnels by number. We NEVER reindex on delete —
// surviving tunnels keep their numbers so config never silently moves between
// tunnels. New tunnels get max(existing)+1.

function nextTunnelNumber(ts: Tunnel[]): number {
  let max = 0
  for (const t of ts) if (t.number > max) max = t.number
  return max + 1
}

export default function TunnelListEditor({
  tunnels,
  onChange,
  espGroups,
  defaultESPGroup,
}: {
  tunnels: Tunnel[]
  onChange: (next: Tunnel[]) => void
  espGroups: ESPGroup[]              // existing ESP groups for the crypto dropdown
  defaultESPGroup?: string           // peer default; shown as the "(peer default)" option
}) {
  // Local validation hint per row (CIDR-ish). Non-blocking — VyOS is the
  // authority; this just nudges the operator.
  const looksLikeCIDR = (v: string) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(v.trim())

  const update = (idx: number, patch: Partial<Tunnel>) => {
    onChange(tunnels.map((t, i) => (i === idx ? { ...t, ...patch } : t)))
  }
  const remove = (idx: number) => {
    if (tunnels.length <= 1) return // guard: a site-to-site peer needs >=1 tunnel
    onChange(tunnels.filter((_, i) => i !== idx))
  }
  const add = () => {
    onChange([
      ...tunnels,
      {
        number: nextTunnelNumber(tunnels),
        local_subnet: '',
        remote_subnet: '',
        esp_group: defaultESPGroup || espGroups[0]?.name || '',
        disable: false,
      },
    ])
  }

  return (
    <div className="tunnel-editor">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <label style={{ fontWeight: 600 }}>Tunnels (local ↔ remote subnet pairs)</label>
        <button type="button" className="btn" onClick={add}>
          + Add tunnel
        </button>
      </div>

      {tunnels.length === 0 && (
        <div className="hint" style={{ fontSize: 12, color: 'var(--warn-ink)' }}>
          No tunnels. Add at least one local/remote subnet pair.
        </div>
      )}

      {tunnels.map((t, idx) => (
        <div
          key={t.number}
          style={{
            border: '1px solid var(--border, #e2e2e2)',
            borderRadius: 8,
            padding: 10,
            marginBottom: 8,
            background: t.disable ? 'var(--bg-subtle, #f6f6f6)' : 'transparent',
            opacity: t.disable ? 0.7 : 1,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
            }}
          >
            <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
              Tunnel #{t.number}
            </span>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={!!t.disable}
                  onChange={e => update(idx, { disable: e.target.checked })}
                />
                Disabled
              </label>
              <button
                type="button"
                className="btn"
                onClick={() => remove(idx)}
                disabled={tunnels.length <= 1}
                title={tunnels.length <= 1 ? 'A peer needs at least one tunnel' : 'Remove this tunnel'}
                style={{ fontSize: 12 }}
              >
                Remove
              </button>
            </div>
          </div>

          <div className="row2">
            <div className="field">
              <label>Local subnet</label>
              <input
                type="text"
                value={t.local_subnet || ''}
                onChange={e => update(idx, { local_subnet: e.target.value })}
                placeholder="10.10.0.0/24"
              />
              {t.local_subnet && !looksLikeCIDR(t.local_subnet) && (
                <div className="hint" style={{ fontSize: 11, color: 'var(--warn-ink)' }}>
                  expected CIDR (e.g. 10.10.0.0/24)
                </div>
              )}
            </div>
            <div className="field">
              <label>Remote subnet</label>
              <input
                type="text"
                value={t.remote_subnet || ''}
                onChange={e => update(idx, { remote_subnet: e.target.value })}
                placeholder="192.168.50.0/24"
              />
              {t.remote_subnet && !looksLikeCIDR(t.remote_subnet) && (
                <div className="hint" style={{ fontSize: 11, color: 'var(--warn-ink)' }}>
                  expected CIDR
                </div>
              )}
            </div>
          </div>

          <div className="field" style={{ marginTop: 6 }}>
            <label>Crypto profile (ESP group)</label>
            <select
              value={t.esp_group || ''}
              onChange={e => update(idx, { esp_group: e.target.value || undefined })}
            >
              <option value="">
                {defaultESPGroup ? `(peer default: ${defaultESPGroup})` : '(peer default)'}
              </option>
              {espGroups.map(g => (
                <option key={g.name} value={g.name}>
                  {g.name}
                </option>
              ))}
            </select>
            <div className="hint" style={{ fontSize: 11 }}>
              Blank = use the peer's default ESP group. Set a different group to tag this
              tunnel with its own crypto profile.
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
