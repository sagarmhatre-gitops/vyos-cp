// QuickActions — operator-essential one-click ops on a device.
//
// Surfaces two actions that VyOS's HTTP API supports:
//   - Backup config (download): one-click; pulls running config as
//     "set" commands and saves to a file the user can re-import or stash.
//   - Reboot device (destructive): typed-name challenge, warn about
//     downtime, then fire. Admin-only.
//
// Ping and Traceroute were attempted in v23/v27 but VyOS's HTTP API
// doesn't expose them — both attempts hit hard-coded op whitelists in
// the API. Will return as part of an SSH-based code path in a future
// phase, with separate credential management.

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Modal } from './Modal'

export function QuickActions({ deviceID, deviceName }: {
  deviceID: string
  deviceName: string
}) {
  const [rebootOpen, setRebootOpen] = useState(false)

  return (
    <>
      <div className="card">
        <div className="card-head">
          <span className="card-title">Quick actions</span>
        </div>
        <div style={{ padding: 14, display: 'grid', gap: 8 }}>
          <ActionButton label="Backup config"
            hint="Download running config as text"
            onClick={async () => {
              try {
                await api.downloadBackup(deviceID, `${deviceName}-config.txt`)
              } catch (e: any) { alert(e.message) }
            }} />
          <ActionButton label="Reboot device"
            hint="Restart the device — 1-3 min downtime"
            danger
            onClick={() => setRebootOpen(true)} />
        </div>
      </div>

      {rebootOpen && (
        <RebootModal deviceID={deviceID} deviceName={deviceName}
          onClose={() => setRebootOpen(false)} />
      )}
    </>
  )
}

function ActionButton({ label, hint, onClick, danger }: {
  label: string; hint: string; onClick: () => void; danger?: boolean
}) {
  return (
    <button onClick={onClick}
      style={{
        display: 'block', textAlign: 'left',
        padding: '8px 10px', borderRadius: 4,
        border: '1px solid var(--line)',
        background: 'var(--bg-subtle)',
        color: danger ? 'var(--danger-ink)' : 'inherit',
        cursor: 'pointer',
      }}>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 1 }}>{hint}</div>
    </button>
  )
}

// RebootModal — typed challenge (must enter device name) before firing.
// Same pattern we use for "delete production device" — friction proportional
// to blast radius.
function RebootModal({ deviceID, deviceName, onClose }: {
  deviceID: string; deviceName: string; onClose: () => void
}) {
  const [typed, setTyped] = useState('')
  const m = useMutation({
    mutationFn: () => api.rebootDevice(deviceID, deviceName),
    onSuccess: () => {
      alert(`Reboot queued for ${deviceName}. Device will be unreachable for 1-3 minutes.`)
      onClose()
    },
    onError: (e: any) => alert(`Reboot failed: ${e.message}`),
  })
  const matches = typed === deviceName
  return (
    <Modal title="Reboot device" onClose={onClose}>
      <div style={{ padding: 14 }}>
        <div className="err" style={{ marginBottom: 12 }}>
          Rebooting will make this device unreachable for 1-3 minutes. All
          traffic passing through it will be dropped during the restart.
          Existing TCP connections will be reset.
        </div>
        <div className="field">
          <label>To confirm, type the device name: <code className="mono">{deviceName}</code></label>
          <input type="text" value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder={deviceName} autoFocus />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger"
            disabled={!matches || m.isPending}
            onClick={() => m.mutate()}>
            {m.isPending ? 'Rebooting…' : 'Reboot now'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
