import { useEffect, useState, type ReactNode } from "react";
import {
    api,
    type DeviceSnapshot,
    type SnapshotSummary,
    type SnapshotDiff,
    type DiffChange,
} from "../lib/api";

interface Props {
    deviceId: string;
    canCapture: boolean;
}

type Tab = "current" | "history" | "diff";

/**
 * LiveConfigTab — Ship 2.
 *
 * Three sub-tabs:
 *   Current — most recent decoded config (Ship 1 behavior)
 *   History — list of past snapshots; pick two to compare
 *   Diff    — unified diff between the two picked snapshots
 *
 * The diff is computed server-side (GET .../diff) so the UI stays dumb:
 * it just renders the JSON the API hands back.
 */
export function LiveConfigTab({ deviceId, canCapture }: Props) {
    const [tab, setTab] = useState<Tab>("current");

    // Current
    const [snap, setSnap] = useState<DeviceSnapshot | null>(null);
    const [loadingCurrent, setLoadingCurrent] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [currentError, setCurrentError] = useState<string | null>(null);

    // History + picker
    const [history, setHistory] = useState<SnapshotSummary[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const [picked, setPicked] = useState<number[]>([]); // up to 2 snapshot ids

    // Diff
    const [diff, setDiff] = useState<SnapshotDiff | null>(null);
    const [loadingDiff, setLoadingDiff] = useState(false);
    const [diffError, setDiffError] = useState<string | null>(null);
    const [pathFilter, setPathFilter] = useState("");

    // ---- Loaders -----------------------------------------------------------

    async function loadCurrent() {
        setCurrentError(null);
        setLoadingCurrent(true);
        try {
            const s = await api.getLatestSnapshot(deviceId);
            setSnap(s);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/404/.test(msg)) setSnap(null);
            else setCurrentError(msg);
        } finally {
            setLoadingCurrent(false);
        }
    }

    async function refreshNow() {
        setCurrentError(null);
        setRefreshing(true);
        try {
            const s = await api.captureSnapshotNow(deviceId);
            setSnap(s);
            // Refreshing creates new history; reload it if user has the tab open.
            void loadHistory();
        } catch (e: unknown) {
            setCurrentError(e instanceof Error ? e.message : String(e));
        } finally {
            setRefreshing(false);
        }
    }

    async function loadHistory() {
        setHistoryError(null);
        setLoadingHistory(true);
        try {
            const rows = await api.listSnapshots(deviceId, 50);
            setHistory(rows);
        } catch (e: unknown) {
            setHistoryError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoadingHistory(false);
        }
    }

    async function loadDiff() {
        if (picked.length !== 2) return;
        setDiffError(null);
        setLoadingDiff(true);
        try {
            // Older id is "from", newer id is "to".
            const [a, b] = [...picked].sort((x, y) => x - y);
            const d = await api.computeDiff(deviceId, a, b);
            setDiff(d);
        } catch (e: unknown) {
            setDiffError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoadingDiff(false);
        }
    }

    // ---- Effects -----------------------------------------------------------

    useEffect(() => {
        void loadCurrent();
    }, [deviceId]);

    useEffect(() => {
        if (tab === "history" && history.length === 0) void loadHistory();
    }, [tab, deviceId]);

    useEffect(() => {
        if (tab === "diff" && picked.length === 2) void loadDiff();
    }, [tab, picked]);

    // ---- Picker handling ---------------------------------------------------

    function togglePick(id: number) {
        setPicked((prev) => {
            if (prev.includes(id)) return prev.filter((x) => x !== id);
            // Cap at 2 selections. New click bumps the older one out.
            if (prev.length < 2) return [...prev, id];
            return [prev[1], id];
        });
    }

    // ---- Renderers ---------------------------------------------------------

    const filteredChanges =
        diff && pathFilter
            ? diff.changes.filter((c) =>
                  c.path.toLowerCase().includes(pathFilter.toLowerCase()),
              )
            : diff?.changes ?? [];

    return (
        <div className="p-4 space-y-4">
            <div className="flex items-center justify-between border-b pb-2">
                <h2 className="text-lg font-semibold">Live Config</h2>
                <div className="flex gap-1 text-sm">
                    <TabButton
                        active={tab === "current"}
                        onClick={() => setTab("current")}
                    >
                        Current
                    </TabButton>
                    <TabButton
                        active={tab === "history"}
                        onClick={() => setTab("history")}
                    >
                        History
                    </TabButton>
                    <TabButton
                        active={tab === "diff"}
                        onClick={() => setTab("diff")}
                        disabled={picked.length !== 2}
                        title={
                            picked.length !== 2
                                ? "Pick two snapshots in History first"
                                : undefined
                        }
                    >
                        Diff {picked.length > 0 && `(${picked.length}/2)`}
                    </TabButton>
                </div>
            </div>

            {tab === "current" && (
                <CurrentView
                    snap={snap}
                    loading={loadingCurrent}
                    refreshing={refreshing}
                    error={currentError}
                    canCapture={canCapture}
                    onRefresh={refreshNow}
                />
            )}

            {tab === "history" && (
                <HistoryView
                    rows={history}
                    loading={loadingHistory}
                    error={historyError}
                    picked={picked}
                    onToggle={togglePick}
                />
            )}

            {tab === "diff" && (
                <DiffView
                    diff={diff}
                    loading={loadingDiff}
                    error={diffError}
                    picked={picked}
                    pathFilter={pathFilter}
                    setPathFilter={setPathFilter}
                    filteredChanges={filteredChanges}
                />
            )}
        </div>
    );
}

// ---- Sub-tab components ----------------------------------------------------

function TabButton(props: {
    active: boolean;
    onClick: () => void;
    disabled?: boolean;
    title?: string;
    children: ReactNode;
}) {
    return (
        <button
            onClick={props.onClick}
            disabled={props.disabled}
            title={props.title}
            className={
                "px-3 py-1 rounded text-sm transition " +
                (props.active
                    ? "bg-blue-600 text-white"
                    : props.disabled
                    ? "text-gray-400 cursor-not-allowed"
                    : "hover:bg-gray-100 text-gray-700")
            }
        >
            {props.children}
        </button>
    );
}

function CurrentView(props: {
    snap: DeviceSnapshot | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    canCapture: boolean;
    onRefresh: () => void;
}) {
    if (props.loading) {
        return <div className="text-sm text-gray-500">Loading…</div>;
    }
    return (
        <>
            <div className="flex items-center justify-between">
                {props.snap ? (
                    <p className="text-xs text-gray-500">
                        Captured{" "}
                        <time dateTime={props.snap.taken_at}>
                            {new Date(props.snap.taken_at).toLocaleString()}
                        </time>
                        {" · "}
                        <span className="font-mono">{props.snap.source}</span>
                        {" · "}
                        <span
                            className="font-mono"
                            title={props.snap.config_hash}
                        >
                            {(props.snap.config_hash || "").slice(0, 12)}
                        </span>
                    </p>
                ) : (
                    <p className="text-xs text-gray-500">
                        No snapshot yet. The poller captures one on startup and
                        every few minutes after that.
                    </p>
                )}
                {props.canCapture && (
                    <button
                        onClick={props.onRefresh}
                        disabled={props.refreshing}
                        className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm
                                   hover:bg-blue-700 disabled:opacity-50"
                    >
                        {props.refreshing ? "Refreshing…" : "Refresh now"}
                    </button>
                )}
            </div>

            {props.error && (
                <div
                    className="text-sm text-red-700 bg-red-50 border border-red-200
                               rounded px-3 py-2 mt-3"
                >
                    {props.error}
                </div>
            )}

            {props.snap && (
                <pre
                    className="text-xs bg-gray-50 border rounded p-3 overflow-auto
                               max-h-[70vh] font-mono whitespace-pre-wrap mt-3"
                >
                    {JSON.stringify(props.snap.config, null, 2)}
                </pre>
            )}
        </>
    );
}

function HistoryView(props: {
    rows: SnapshotSummary[];
    loading: boolean;
    error: string | null;
    picked: number[];
    onToggle: (id: number) => void;
}) {
    if (props.loading) {
        return <div className="text-sm text-gray-500">Loading history…</div>;
    }
    if (props.error) {
        return (
            <div
                className="text-sm text-red-700 bg-red-50 border border-red-200
                           rounded px-3 py-2"
            >
                {props.error}
            </div>
        );
    }
    if (props.rows.length === 0) {
        return (
            <div className="text-sm text-gray-500">
                No snapshots yet. The poller will capture one on its next tick.
            </div>
        );
    }
    return (
        <>
            <div className="text-xs text-gray-500 mb-2">
                Each row is a moment when the config differed from the previous
                capture. Pick two to compare ({props.picked.length}/2 selected).
                {props.picked.length > 0 && (
                    <button
                        onClick={() =>
                            props.picked.forEach((id) => props.onToggle(id))
                        }
                        className="ml-2 text-blue-600 hover:underline"
                    >
                        clear
                    </button>
                )}
            </div>
            <table className="w-full text-sm font-mono">
                <thead className="text-xs text-gray-500 border-b">
                    <tr>
                        <th className="text-left py-1 w-8"></th>
                        <th className="text-left py-1 w-16">id</th>
                        <th className="text-left py-1">when</th>
                        <th className="text-left py-1 w-24">source</th>
                        <th className="text-left py-1">hash</th>
                    </tr>
                </thead>
                <tbody>
                    {props.rows.map((r) => {
                        const isPicked = props.picked.includes(r.id);
                        return (
                            <tr
                                key={r.id}
                                onClick={() => props.onToggle(r.id)}
                                className={
                                    "cursor-pointer border-b hover:bg-blue-50 " +
                                    (isPicked ? "bg-blue-100" : "")
                                }
                            >
                                <td className="py-1">
                                    <input
                                        type="checkbox"
                                        checked={isPicked}
                                        readOnly
                                        className="pointer-events-none"
                                    />
                                </td>
                                <td className="py-1">{r.id}</td>
                                <td className="py-1">
                                    {new Date(r.taken_at).toLocaleString()}
                                </td>
                                <td className="py-1">{r.source}</td>
                                <td className="py-1" title={r.config_hash}>
                                    {(r.config_hash || "").slice(0, 12)}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </>
    );
}

function DiffView(props: {
    diff: SnapshotDiff | null;
    loading: boolean;
    error: string | null;
    picked: number[];
    pathFilter: string;
    setPathFilter: (s: string) => void;
    filteredChanges: DiffChange[];
}) {
    if (props.picked.length !== 2) {
        return (
            <div className="text-sm text-gray-500">
                Pick two snapshots in the History tab to see what changed.
            </div>
        );
    }
    if (props.loading) {
        return (
            <div className="text-sm text-gray-500">Computing diff…</div>
        );
    }
    if (props.error) {
        return (
            <div
                className="text-sm text-red-700 bg-red-50 border border-red-200
                           rounded px-3 py-2"
            >
                {props.error}
            </div>
        );
    }
    if (!props.diff) return null;

    if (props.diff.changes.length === 0) {
        return (
            <div className="text-sm text-gray-500">
                No differences between snapshot #{props.diff.from} and #
                {props.diff.to}. The dedup-on-hash should normally make this
                impossible — if you see this, two snapshots have different IDs
                but identical content.
            </div>
        );
    }

    return (
        <>
            <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
                <span>
                    Diff from <strong>#{props.diff.from}</strong> to{" "}
                    <strong>#{props.diff.to}</strong>:{" "}
                    {props.diff.changes.length} change
                    {props.diff.changes.length === 1 ? "" : "s"}
                    {props.pathFilter &&
                        props.filteredChanges.length !==
                            props.diff.changes.length && (
                            <>
                                {" "}
                                ({props.filteredChanges.length} matching filter)
                            </>
                        )}
                </span>
                <input
                    type="text"
                    placeholder="filter by path…"
                    value={props.pathFilter}
                    onChange={(e) => props.setPathFilter(e.target.value)}
                    className="px-2 py-1 border rounded text-xs w-64 font-mono"
                />
            </div>
            <div className="font-mono text-xs space-y-1 max-h-[70vh] overflow-auto">
                {props.filteredChanges.map((c, i) => (
                    <ChangeRow key={i} change={c} />
                ))}
            </div>
        </>
    );
}

function ChangeRow({ change }: { change: DiffChange }) {
    const sigil =
        change.op === "add" ? "+" : change.op === "remove" ? "−" : "~";
    const color =
        change.op === "add"
            ? "text-green-700 bg-green-50"
            : change.op === "remove"
            ? "text-red-700 bg-red-50"
            : "text-amber-700 bg-amber-50";

    return (
        <div className={`px-2 py-1 rounded ${color}`}>
            <div className="flex gap-2">
                <span className="font-bold w-4 flex-shrink-0">{sigil}</span>
                <span className="font-semibold">{change.path}</span>
            </div>
            {change.op === "modify" && (
                <div className="ml-6 mt-1 space-y-0.5">
                    <div className="text-red-700">
                        <span className="opacity-60">before:</span>{" "}
                        {renderValue(change.before)}
                    </div>
                    <div className="text-green-700">
                        <span className="opacity-60">after: </span>{" "}
                        {renderValue(change.after)}
                    </div>
                </div>
            )}
            {(change.op === "add" || change.op === "remove") && (
                <div className="ml-6 mt-1">
                    {renderValue(
                        change.op === "add" ? change.after : change.before,
                    )}
                </div>
            )}
        </div>
    );
}

function renderValue(v: unknown): string {
    if (v === null || v === undefined) return "(null)";
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    // Object / array: pretty-print but cap length so a huge sub-tree
    // doesn't blow up the row.
    const s = JSON.stringify(v, null, 2);
    if (s.length > 400) return s.slice(0, 400) + "…";
    return s;
}
