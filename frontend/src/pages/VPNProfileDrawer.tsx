import { useState } from 'react'
import { Drawer } from '../components/Drawer'
import { api, VPNProfile, IKEGroup, ESPGroup } from '../lib/api'

// VPNProfileDrawer — shared create/edit form for both IKE and ESP
// profiles. The drawer takes either:
//   - `initial: VPNProfile`  (edit mode — full existing profile)
//   - `createType: 'ike' | 'esp'` + `deviceID` (create mode — start blank)
//
// On Save:
//   - Edit mode: PUT /api/v1/vpn/profiles/{id} with the full body
//   - Create mode: POST /api/v1/vpn/profiles with device_id + type + body
//
// VyOS-side constraints (verified against the backend translator):
//   - Name is required, alphanumeric+hyphen+underscore only
//   - At least one proposal required
//   - Lifetime is optional (defaults: 28800 IKE, 3600 ESP)
//   - IKE version defaults to ikev2 if empty
//
// The form is opinionated: we hide options we don't have UI for yet
// (DPD action customization, IKE Mode, ESP PFS modes other than
// enable/disable). Operators who need those can keep using the
// device-level IPsec page in the meantime.

type Props = {
  initial?: VPNProfile
  createType?: 'ike' | 'esp'
  createDeviceID?: string
  // Used for displaying the device name in the drawer header in create mode.
  createDeviceName?: string
  onClose: () => void
  onSaved: () => void
}

export function VPNProfileDrawer({
  initial, createType, createDeviceID, createDeviceName, onClose, onSaved,
}: Props) {
  const isEdit = !!initial
  const type = initial?.type ?? createType
  if (!type) throw new Error('VPNProfileDrawer needs either initial or createType')

  // Initialize state from `initial` (edit) or sensible defaults (create).
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [tags, setTags] = useState<string[]>(initial?.tags ?? [])
  const [tagInput, setTagInput] = useState('')

  // IKE-specific fields
  const initialIKE = initial?.ike
  const [ikeVersion, setIkeVersion] = useState(initialIKE?.ike_version ?? 'ikev2')
  const [ikeLifetime, setIkeLifetime] = useState(initialIKE?.lifetime ?? 28800)
  const [ikeProposals, setIkeProposals] = useState<IKEProposalForm[]>(
    initialIKE?.proposals?.map(p => ({
      number: p.number, encryption: p.encryption, hash: p.hash,
      dh_group: p.dh_group, prf: p.prf ?? '',
    })) ?? [{ number: 10, encryption: 'aes256', hash: 'sha256', dh_group: '14', prf: '' }],
  )

  // ESP-specific fields
  const initialESP = initial?.esp
  const [espLifetime, setEspLifetime] = useState(initialESP?.lifetime ?? 3600)
  const [espPFS, setEspPFS] = useState(initialESP?.pfs ?? '')
  const [espProposals, setEspProposals] = useState<ESPProposalForm[]>(
    initialESP?.proposals?.map(p => ({
      number: p.number, encryption: p.encryption, hash: p.hash ?? '',
    })) ?? [{ number: 10, encryption: 'aes256', hash: 'sha256' }],
  )

  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  // Dirty detection — drives the "discard changes?" prompt.
  const dirty = !isEdit
    ? (name !== '' || description !== '' || tags.length > 0)
    : (description !== initial!.description || !sameStringArray(tags, initial!.tags || []) ||
       (type === 'ike' && !sameIKE(buildIKE(), initial!.ike!)) ||
       (type === 'esp' && !sameESP(buildESP(), initial!.esp!)))

  function buildIKE(): IKEGroup {
    return {
      name,
      ike_version: ikeVersion || undefined,
      lifetime: ikeLifetime || undefined,
      proposals: ikeProposals.map(p => ({
        number: p.number,
        encryption: p.encryption,
        hash: p.hash,
        dh_group: p.dh_group,
        prf: p.prf || undefined,
      })),
    }
  }

  function buildESP(): ESPGroup {
    return {
      name,
      lifetime: espLifetime || undefined,
      pfs: espPFS || undefined,
      proposals: espProposals.map(p => ({
        number: p.number,
        encryption: p.encryption,
        hash: p.hash || undefined,
      })),
    }
  }

  const addTag = () => {
    const t = tagInput.trim()
    if (!t) return
    if (!tags.includes(t)) setTags([...tags, t])
    setTagInput('')
  }

  const removeTag = (t: string) => setTags(tags.filter(x => x !== t))

  const addProposal = () => {
    if (type === 'ike') {
      const nextNum = Math.max(0, ...ikeProposals.map(p => p.number)) + 10
      setIkeProposals([...ikeProposals, {
        number: nextNum, encryption: 'aes256', hash: 'sha256', dh_group: '14', prf: '',
      }])
    } else {
      const nextNum = Math.max(0, ...espProposals.map(p => p.number)) + 10
      setEspProposals([...espProposals, {
        number: nextNum, encryption: 'aes256', hash: 'sha256',
      }])
    }
  }

  const removeProposal = (idx: number) => {
    if (type === 'ike') {
      if (ikeProposals.length <= 1) return // keep at least one
      setIkeProposals(ikeProposals.filter((_, i) => i !== idx))
    } else {
      if (espProposals.length <= 1) return
      setEspProposals(espProposals.filter((_, i) => i !== idx))
    }
  }

  const validate = (): string => {
    if (!name) return 'Name is required'
    if (!/^[A-Za-z0-9_-]+$/.test(name))
      return 'Name must contain only letters, numbers, hyphens, and underscores'
    const proposals = type === 'ike' ? ikeProposals : espProposals
    if (proposals.length === 0) return 'At least one proposal is required'
    for (const p of proposals) {
      if (!p.encryption) return `Proposal #${p.number}: encryption is required`
      if (type === 'ike' && !(p as IKEProposalForm).dh_group)
        return `Proposal #${p.number}: DH group is required`
    }
    return ''
  }

  const save = async () => {
    const v = validate()
    if (v) { setErr(v); return }
    setErr('')
    setSaving(true)
    try {
      if (isEdit) {
        await api.updateVPNProfile(initial!.id, {
          ike: type === 'ike' ? buildIKE() : undefined,
          esp: type === 'esp' ? buildESP() : undefined,
          description, tags,
        })
      } else {
        await api.createVPNProfile({
          device_id: createDeviceID!,
          type,
          ike: type === 'ike' ? buildIKE() : undefined,
          esp: type === 'esp' ? buildESP() : undefined,
          description, tags,
        })
      }
      onSaved()
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const titleLabel = (type === 'ike' ? 'IKE' : 'ESP') + ' profile'
  const title = isEdit
    ? `Edit ${titleLabel}: ${initial!.name}`
    : `New ${titleLabel}` + (createDeviceName ? ` — ${createDeviceName}` : '')

  return (
    <Drawer
      title={title}
      onClose={onClose}
      dirty={dirty}
      busy={saving}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create profile'}
          </button>
        </>
      }
    >
      {/* Identity --------------------------------------------------- */}
      <div className="field">
        <label>Name *</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={type === 'ike' ? 'e.g. IKE-AES256-AWS' : 'e.g. ESP-STANDARD'}
          disabled={isEdit}
          style={isEdit ? { background: 'var(--bg-subtle)', cursor: 'not-allowed' } : undefined}
          title={isEdit ? 'Names cannot be changed. Delete and recreate to rename.' : ''}
        />
        {isEdit && (
          <div className="hint" style={{ fontSize: 11 }}>
            Names cannot be changed. Delete and recreate to rename.
          </div>
        )}
      </div>

      <div className="field">
        <label>Description</label>
        <input
          type="text"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="What this profile is for"
        />
      </div>

      <div className="field">
        <label>Tags</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {tags.map(t => (
            <span key={t} className="badge" style={{
              padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
              {t}
              <button
                onClick={() => removeTag(t)}
                style={{ background: 'transparent', border: 0, cursor: 'pointer', fontSize: 12 }}
                aria-label={`Remove tag ${t}`}
              >×</button>
            </span>
          ))}
        </div>
        <input
          type="text"
          value={tagInput}
          onChange={e => setTagInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              addTag()
            }
          }}
          onBlur={addTag}
          placeholder="Type a tag and press Enter"
        />
      </div>

      {/* Type-specific fields -------------------------------------- */}
      {type === 'ike' && (
        <>
          <div className="row2">
            <div className="field">
              <label>IKE version</label>
              <select className="select" value={ikeVersion}
                onChange={e =>
                  setIkeVersion(
                    e.target.value as "" | "ikev1" | "ikev2"
                  )
                }>
                <option value="ikev2">ikev2 (recommended)</option>
                <option value="ikev1">ikev1</option>
                <option value="">any</option>
              </select>
            </div>
            <div className="field">
              <label>Lifetime (seconds)</label>
              <input
                type="number"
                value={ikeLifetime}
                onChange={e => setIkeLifetime(parseInt(e.target.value) || 0)}
                min={0}
              />
              <div className="hint" style={{ fontSize: 11 }}>
                VyOS default: 28800 (8 hours). 0 uses VyOS default.
              </div>
            </div>
          </div>
        </>
      )}

      {type === 'esp' && (
        <div className="row2">
          <div className="field">
            <label>Lifetime (seconds)</label>
            <input
              type="number"
              value={espLifetime}
              onChange={e => setEspLifetime(parseInt(e.target.value) || 0)}
              min={0}
            />
            <div className="hint" style={{ fontSize: 11 }}>
              VyOS default: 3600 (1 hour). 0 uses VyOS default.
            </div>
          </div>
          <div className="field">
            <label>Perfect Forward Secrecy (PFS)</label>
            <select className="select" value={espPFS}
              onChange={e => setEspPFS(e.target.value)}>
              <option value="">disable</option>
              <option value="enable">enable</option>
              <option value="dh-group2">dh-group2</option>
              <option value="dh-group14">dh-group14</option>
              <option value="dh-group19">dh-group19</option>
              <option value="dh-group20">dh-group20</option>
            </select>
          </div>
        </div>
      )}

      {/* Proposals -------------------------------------------------- */}
      <div style={{
        marginTop: 12,
        fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.05,
        color: 'var(--ink-muted)', fontWeight: 500,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span>Proposals</span>
        <button className="btn"
          style={{ fontSize: 11, padding: '4px 10px' }}
          onClick={addProposal}>
          + Add proposal
        </button>
      </div>

      <table className="tbl" style={{ fontSize: 12, marginTop: 8 }}>
        <thead><tr>
          <th style={{ width: 50 }}>#</th>
          <th>Encryption</th>
          <th>Hash</th>
          {type === 'ike' && <th>DH group</th>}
          {type === 'ike' && <th>PRF</th>}
          <th className="right" style={{ width: 80 }}>Actions</th>
        </tr></thead>
        <tbody>
          {type === 'ike' && ikeProposals.map((p, idx) => (
            <tr key={idx}>
              <td>
                <input type="number" value={p.number} min={1} max={65535}
                  style={{ width: 60 }}
                  onChange={e => updateAt(ikeProposals, setIkeProposals, idx, {
                    number: parseInt(e.target.value) || 0,
                  })} />
              </td>
              <td>
                <select className="select" value={p.encryption}
                  onChange={e => updateAt(ikeProposals, setIkeProposals, idx, {
                    encryption: e.target.value,
                  })}>
                  {IKE_ENC_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </td>
              <td>
                <select className="select" value={p.hash}
                  onChange={e => updateAt(ikeProposals, setIkeProposals, idx, {
                    hash: e.target.value,
                  })}>
                  {HASH_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </td>
              <td>
                <select className="select" value={p.dh_group}
                  onChange={e => updateAt(ikeProposals, setIkeProposals, idx, {
                    dh_group: e.target.value,
                  })}>
                  {DH_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </td>
              <td>
                <select className="select" value={p.prf}
                  onChange={e => updateAt(ikeProposals, setIkeProposals, idx, {
                    prf: e.target.value,
                  })}>
                  <option value="">(auto)</option>
                  {HASH_OPTIONS.map(o => <option key={o} value={'prfsha' + o.replace(/^sha/, '')}>
                    {'prfsha' + o.replace(/^sha/, '')}</option>)}
                </select>
              </td>
              <td className="right">
                <button className="btn btn-danger"
                  style={{ height: 22, padding: '0 6px', fontSize: 11 }}
                  disabled={ikeProposals.length <= 1}
                  onClick={() => removeProposal(idx)}>
                  remove
                </button>
              </td>
            </tr>
          ))}

          {type === 'esp' && espProposals.map((p, idx) => (
            <tr key={idx}>
              <td>
                <input type="number" value={p.number} min={1} max={65535}
                  style={{ width: 60 }}
                  onChange={e => updateAt(espProposals, setEspProposals, idx, {
                    number: parseInt(e.target.value) || 0,
                  })} />
              </td>
              <td>
                <select className="select" value={p.encryption}
                  onChange={e => updateAt(espProposals, setEspProposals, idx, {
                    encryption: e.target.value,
                  })}>
                  {ESP_ENC_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </td>
              <td>
                <select className="select" value={p.hash}
                  onChange={e => updateAt(espProposals, setEspProposals, idx, {
                    hash: e.target.value,
                  })}>
                  <option value="">(none / AEAD)</option>
                  {HASH_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </td>
              <td className="right">
                <button className="btn btn-danger"
                  style={{ height: 22, padding: '0 6px', fontSize: 11 }}
                  disabled={espProposals.length <= 1}
                  onClick={() => removeProposal(idx)}>
                  remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {err && (
        <div style={{ marginTop: 14, color: 'var(--danger)', fontSize: 12 }}>
          {err}
        </div>
      )}
    </Drawer>
  )
}

// --- supporting types + helpers ---------------------------------------------

type IKEProposalForm = {
  number: number
  encryption: string
  hash: string
  dh_group: string
  prf: string
}

type ESPProposalForm = {
  number: number
  encryption: string
  hash: string
}

const IKE_ENC_OPTIONS = [
  'aes128', 'aes192', 'aes256',
  'aes128gcm128', 'aes256gcm128',
  '3des',
]
const ESP_ENC_OPTIONS = [
  'aes128', 'aes192', 'aes256',
  'aes128gcm128', 'aes256gcm128',
  '3des',
]
const HASH_OPTIONS = ['sha1', 'sha256', 'sha384', 'sha512']
const DH_OPTIONS = ['2', '5', '14', '15', '16', '19', '20', '21']

function updateAt<T>(arr: T[], setArr: (next: T[]) => void, idx: number, patch: Partial<T>) {
  const next = [...arr]
  next[idx] = { ...next[idx], ...patch }
  setArr(next)
}

function sameStringArray(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sameIKE(a: IKEGroup, b: IKEGroup) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function sameESP(a: ESPGroup, b: ESPGroup) {
  return JSON.stringify(a) === JSON.stringify(b)
}
