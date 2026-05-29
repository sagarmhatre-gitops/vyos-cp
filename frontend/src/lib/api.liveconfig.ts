// ─────────────────────────────────────────────────────────────────────────────
// Live Config — types + client methods. Add to your existing src/lib/api.ts.
// Replace `request(...)` with whatever authed-fetch helper your file already has.
// ─────────────────────────────────────────────────────────────────────────────

export type ChangeAction = 'Added' | 'Modified' | 'Removed'

export interface SectionCount { name: string; count: number }
export interface TopSection { name: string; count: number }

export interface RecentChangeItem {
  at: string
  target: string
  description: string
  action: ChangeAction
}

export interface LiveConfig {
  snapshot_id: number
  captured_at: string
  device_id: string
  device_name: string
  config_id: string
  version: string
  source: string
  content: string
  lines: number
  size_bytes: number
  checksum: string
  last_changed: string | null
  changed_by: string
  live: boolean
  sections: SectionCount[]
  top_modified: TopSection[]
  recent_changes: RecentChangeItem[]
}

export interface ValidateResult {
  valid: boolean
  message: string
  detail: string
  validated_at: string
}

export interface SnapshotMeta {
  id: number
  captured_at: string
  config_id: string
  checksum: string
  version: string
  source: string         // 'commit' | 'manual' | 'poll'
  captured_by: string
  lines: number
  size_bytes: number
}

export interface Snapshot extends SnapshotMeta {
  device_id: string
  content: string
}

export type DiffKind = 'add' | 'del' | 'ctx'
export interface DiffLine { kind: DiffKind; text: string; a: number; b: number }
export interface DiffResult {
  from_id: number
  to_id: number
  added: number
  removed: number
  lines: DiffLine[]
  identical: boolean
}

// ── client methods — splice into the `api` object ───────────────────────────
//
//   export const api = {
//     ...existing,
//
//     getLiveConfig: (deviceId: string) =>
//       request<LiveConfig>(`/api/v1/devices/${deviceId}/live-config`),
//
//     refreshLiveConfig: (deviceId: string) =>
//       request<LiveConfig>(`/api/v1/devices/${deviceId}/live-config/refresh`, { method: 'POST' }),
//
//     validateLiveConfig: (deviceId: string) =>
//       request<ValidateResult>(`/api/v1/devices/${deviceId}/live-config/validate`, { method: 'POST' }),
//
//     listSnapshots: (deviceId: string, limit = 50) =>
//       request<SnapshotMeta[]>(`/api/v1/devices/${deviceId}/snapshots?limit=${limit}`),
//
//     getSnapshot: (deviceId: string, snapId: number) =>
//       request<Snapshot>(`/api/v1/devices/${deviceId}/snapshots/${snapId}`),
//
//     diffSnapshots: (deviceId: string, fromId: number, toId: number) =>
//       request<DiffResult>(`/api/v1/devices/${deviceId}/snapshots/diff?from=${fromId}&to=${toId}`),
//   }
