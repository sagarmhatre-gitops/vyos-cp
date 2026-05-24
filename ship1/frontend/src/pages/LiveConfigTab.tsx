import { useEffect, useState } from "react";
import {
    captureSnapshotNow,
    getLatestSnapshot,
    type DeviceSnapshot,
} from "../lib/snapshots";

interface Props {
    deviceId: string;
    /** Caller-supplied role check; render the Refresh button only if true. */
    canCapture: boolean;
}

/**
 * LiveConfigTab — Ship 1 of the drift-detection track.
 *
 * Shows the most recent decoded VyOS config for a device. The first capture
 * lands on poller startup, then every snapshot interval (default 5 minutes).
 * Operators can hit "Refresh now" to force an immediate /retrieve.
 *
 * Intentionally minimal in v1:
 *   - No diff view (that's Ship 2).
 *   - No drift badge (Ship 3).
 *   - No reconcile button (Ship 4).
 * The JSON tree is just <pre> for now; pagination/collapse can come later
 * when we know how operators actually use it.
 */
export function LiveConfigTab({ deviceId, canCapture }: Props) {
    const [snap, setSnap] = useState<DeviceSnapshot | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function load() {
        setError(null);
        setLoading(true);
        try {
            const s = await getLatestSnapshot(deviceId);
            setSnap(s);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }

    async function refresh() {
        setError(null);
        setRefreshing(true);
        try {
            const s = await captureSnapshotNow(deviceId);
            setSnap(s);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setRefreshing(false);
        }
    }

    useEffect(() => {
        void load();
    }, [deviceId]);

    if (loading) {
        return <div className="p-4 text-sm text-gray-500">Loading…</div>;
    }

    return (
        <div className="p-4 space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
                <div className="space-y-1">
                    <h2 className="text-lg font-semibold">Live Config</h2>
                    {snap ? (
                        <p className="text-xs text-gray-500">
                            Captured{" "}
                            <time dateTime={snap.taken_at}>
                                {new Date(snap.taken_at).toLocaleString()}
                            </time>
                            {" · "}
                            <span className="font-mono">{snap.source}</span>
                            {" · "}
                            <span className="font-mono" title={snap.config_hash}>
                                {snap.config_hash.slice(0, 12)}
                            </span>
                        </p>
                    ) : (
                        <p className="text-xs text-gray-500">
                            No snapshot yet. The poller captures one on startup
                            and every few minutes after that.
                        </p>
                    )}
                </div>

                {canCapture && (
                    <button
                        onClick={() => void refresh()}
                        disabled={refreshing}
                        className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm
                                   hover:bg-blue-700 disabled:opacity-50"
                    >
                        {refreshing ? "Refreshing…" : "Refresh now"}
                    </button>
                )}
            </div>

            {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200
                                rounded px-3 py-2">
                    {error}
                </div>
            )}

            {snap && (
                <pre className="text-xs bg-gray-50 border rounded p-3 overflow-auto
                                max-h-[70vh] font-mono whitespace-pre-wrap">
                    {JSON.stringify(snap.config, null, 2)}
                </pre>
            )}
        </div>
    );
}
