// Snapshot client — Ship 1.
//
// Append to backend/src/lib/api.ts (or import alongside it). Mirrors the
// shape of the existing devices/* client functions in this file so callers
// can use it without learning anything new.

import { authFetch } from "./api"; // existing helper that injects the JWT

export type SnapshotSource = "control_plane" | "device" | "manual";

export interface SnapshotSummary {
    id: number;
    device_id: string;
    taken_at: string;          // ISO-8601
    source: SnapshotSource;
    config_hash: string;       // hex
}

export interface DeviceSnapshot extends SnapshotSummary {
    config: DeviceConfig;
    parent_id?: number | null;
    audit_log_id?: number | null;
    created_by?: string | null;
}

// DeviceConfig mirrors the Go side; kept loose because the translator's output
// shape will continue to evolve. Use a typed view in pages that render
// specific sub-trees (firewall editor, NAT editor, etc.).
export interface DeviceConfig {
    firewall?: Record<string, unknown>;
    nat?: Record<string, unknown>;
    interfaces?: Record<string, unknown>;
    extra?: Record<string, unknown>;
}

/**
 * Fetch the latest snapshot for a device, including the full decoded config.
 * Returns null if the device has no snapshots yet (the poller hasn't captured
 * the initial one). Callers should render an empty-state in that case.
 */
export async function getLatestSnapshot(
    deviceId: string,
): Promise<DeviceSnapshot | null> {
    const r = await authFetch(`/api/v1/devices/${deviceId}/snapshot`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`getLatestSnapshot: ${r.status} ${await r.text()}`);
    return r.json();
}

/**
 * Fetch snapshot summaries (metadata only) for the history list.
 * Default limit is 50; max is 500 server-side.
 */
export async function listSnapshots(
    deviceId: string,
    limit = 50,
): Promise<SnapshotSummary[]> {
    const r = await authFetch(
        `/api/v1/devices/${deviceId}/snapshots?limit=${limit}`,
    );
    if (!r.ok) throw new Error(`listSnapshots: ${r.status} ${await r.text()}`);
    return r.json();
}

/**
 * Force a synchronous snapshot capture right now. Requires operator+ role.
 * Returns the newly created snapshot (or an existing one if the live config
 * was identical to the previous snapshot — server-side dedup).
 */
export async function captureSnapshotNow(
    deviceId: string,
): Promise<DeviceSnapshot> {
    const r = await authFetch(`/api/v1/devices/${deviceId}/snapshot`, {
        method: "POST",
    });
    if (!r.ok) throw new Error(`captureSnapshotNow: ${r.status} ${await r.text()}`);
    return r.json();
}
