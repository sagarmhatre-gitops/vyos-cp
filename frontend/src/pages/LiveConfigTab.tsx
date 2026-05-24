import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
    api,
    type DeviceSnapshot,
    type SnapshotSummary,
    type SnapshotDiff,
    type DiffChange,
} from "../lib/api";
import "./LiveConfigTab.css";

interface Props {
    deviceId: string;
    canCapture: boolean;
}

type Tab = "current" | "history" | "diff";

/**
 * LiveConfigTab — Ship 2 (v3: hand-styled to match vyos-cp design system).
 *
 * Uses index.css design tokens (--brand, --ok, --warn, --danger, --ink, ...)
 * and existing semantic classes (.btn, .btn-primary, .card, .tbl, .mono,
 * .dim, .badge). Companion styles in LiveConfigTab.css cover the few
 * elements that don't map to existing classes (diff cards, JSON viewer,
 * sub-tab nav).
 *
 * Three sub-tabs:
 *   Current — most recent decoded config + syntax-highlighted JSON viewer
 *   History — table of past snapshots; pick two to compare
 *   Diff    — structured diff between two snapshots, with colored cards
 */
export function LiveConfigTab({ deviceId, canCapture }: Props) {
    const [tab, setTab] = useState<Tab>("current");

    // Current
    const [snap, setSnap] = useState<DeviceSnapshot | null>(null);
    const [loadingCurrent, setLoadingCurrent] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [currentError, setCurrentError] = useState<string | null>(null);
    const [currentFilter, setCurrentFilter] = useState("");

    // History
    const [history, setHistory] = useState<SnapshotSummary[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const [picked, setPicked] = useState<number[]>([]);

    // Diff
    const [diff, setDiff] = useState<SnapshotDiff | null>(null);
    const [loadingDiff, setLoadingDiff] = useState(false);
    const [diffError, setDiffError] = useState<string | null>(null);
    const [pathFilter, setPathFilter] = useState("");

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
            const [a, b] = [...picked].sort((x, y) => x - y);
            const d = await api.computeDiff(deviceId, a, b);
            setDiff(d);
        } catch (e: unknown) {
            setDiffError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoadingDiff(false);
        }
    }

    useEffect(() => {
        void loadCurrent();
    }, [deviceId]);

    useEffect(() => {
        if (tab === "history" && history.length === 0) void loadHistory();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, deviceId]);

    useEffect(() => {
        if (tab === "diff" && picked.length === 2) void loadDiff();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, picked]);

    function togglePick(id: number) {
        setPicked((prev) => {
            if (prev.includes(id)) return prev.filter((x) => x !== id);
            if (prev.length < 2) return [...prev, id];
            return [prev[1], id];
        });
    }

    const filteredChanges = useMemo(() => {
        if (!diff) return [];
        if (!pathFilter) return diff.changes;
        const needle = pathFilter.toLowerCase();
        return diff.changes.filter((c) => c.path.toLowerCase().includes(needle));
    }, [diff, pathFilter]);

    return (
        <div className="lc">
            <div className="lc-head">
                <h2>Live Config</h2>
                <nav className="lc-tabs">
                    <button
                        className={"lc-tab" + (tab === "current" ? " active" : "")}
                        onClick={() => setTab("current")}
                    >
                        Current
                    </button>
                    <button
                        className={"lc-tab" + (tab === "history" ? " active" : "")}
                        onClick={() => setTab("history")}
                    >
                        History
                        {history.length > 0 && (
                            <span className="lc-tab-count">{history.length}</span>
                        )}
                    </button>
                    <button
                        className={"lc-tab" + (tab === "diff" ? " active" : "")}
                        onClick={() => setTab("diff")}
                        disabled={picked.length !== 2}
                        title={
                            picked.length !== 2
                                ? "Pick two snapshots in History first"
                                : undefined
                        }
                    >
                        Diff
                        {picked.length > 0 && (
                            <span className="lc-tab-count">
                                ({picked.length}/2)
                            </span>
                        )}
                    </button>
                </nav>
            </div>

            {tab === "current" && (
                <CurrentView
                    snap={snap}
                    loading={loadingCurrent}
                    refreshing={refreshing}
                    error={currentError}
                    canCapture={canCapture}
                    onRefresh={refreshNow}
                    filter={currentFilter}
                    setFilter={setCurrentFilter}
                />
            )}

            {tab === "history" && (
                <HistoryView
                    rows={history}
                    loading={loadingHistory}
                    error={historyError}
                    picked={picked}
                    onToggle={togglePick}
                    onClear={() => setPicked([])}
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

function SourcePill({ source }: { source: string }) {
    // .badge is the base; .lc-src.<source> adds the tint.
    return <span className={`badge lc-src ${source}`}>{source}</span>;
}

function CurrentView(props: {
    snap: DeviceSnapshot | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    canCapture: boolean;
    onRefresh: () => void;
    filter: string;
    setFilter: (s: string) => void;
}) {
    if (props.loading) return <div className="lc-empty">Loading…</div>;
    return (
        <>
            <div className="lc-strip">
                {props.snap ? (
                    <div className="lc-strip-meta">
                        <span>
                            Captured{" "}
                            <time dateTime={props.snap.taken_at}>
                                {new Date(props.snap.taken_at).toLocaleString()}
                            </time>
                        </span>
                        <SourcePill source={props.snap.source} />
                        <span className="hash" title={props.snap.config_hash}>
                            {(props.snap.config_hash || "").slice(0, 12)}
                        </span>
                    </div>
                ) : (
                    <span className="hint">
                        No snapshot yet. The poller captures one on startup
                        and every few minutes after that.
                    </span>
                )}
                <div className="lc-strip-actions">
                    {props.snap && (
                        <input
                            type="text"
                            placeholder="search config…"
                            value={props.filter}
                            onChange={(e) => props.setFilter(e.target.value)}
                            className="lc-search"
                        />
                    )}
                    {props.canCapture && (
                        <button
                            className="btn btn-primary"
                            onClick={props.onRefresh}
                            disabled={props.refreshing}
                        >
                            {props.refreshing ? "Refreshing…" : "Refresh now"}
                        </button>
                    )}
                </div>
            </div>

            {props.error && <div className="lc-error">{props.error}</div>}

            {props.snap && (
                <JsonViewer value={props.snap.config} filter={props.filter} />
            )}
        </>
    );
}

function JsonViewer({ value, filter }: { value: unknown; filter: string }) {
    const raw = useMemo(() => JSON.stringify(value, null, 2), [value]);
    const lines = useMemo(() => raw.split("\n"), [raw]);

    const needle = filter.trim().toLowerCase();
    const visible = useMemo(() => {
        const indexed = lines.map((line, i) => ({ line, n: i + 1 }));
        if (!needle) return indexed;
        return indexed.filter((row) => row.line.toLowerCase().includes(needle));
    }, [lines, needle]);

    return (
        <div className="lc-json">
            <div className="lc-json-scroll">
                <table className="lc-json-tbl">
                    <tbody>
                        {visible.map(({ line, n }) => (
                            <tr key={n}>
                                <td className="lc-ln">{n}</td>
                                <td className="lc-code">
                                    <HighlightedJsonLine
                                        line={line}
                                        highlight={needle}
                                    />
                                </td>
                            </tr>
                        ))}
                        {visible.length === 0 && (
                            <tr>
                                <td colSpan={2} className="lc-empty">
                                    No lines match "{filter}".
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function HighlightedJsonLine({
    line,
    highlight,
}: {
    line: string;
    highlight: string;
}) {
    const tokenRe =
        /("(?:\\.|[^"\\])*")(\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

    const parts: { text: string; cls: string }[] = [];
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(line)) !== null) {
        if (m.index > cursor) {
            parts.push({ text: line.slice(cursor, m.index), cls: "tok-plain" });
        }
        if (m[1]) {
            parts.push({ text: m[1], cls: "tok-key" });
            parts.push({ text: m[2], cls: "tok-punct" });
        } else if (m[3]) {
            parts.push({ text: m[3], cls: "tok-string" });
        } else if (m[4]) {
            parts.push({ text: m[4], cls: "tok-number" });
        } else if (m[5]) {
            parts.push({ text: m[5], cls: "tok-literal" });
        } else if (m[6]) {
            parts.push({ text: m[6], cls: "tok-punct" });
        }
        cursor = m.index + m[0].length;
    }
    if (cursor < line.length) {
        parts.push({ text: line.slice(cursor), cls: "tok-plain" });
    }

    return (
        <>
            {parts.map((p, i) => (
                <span key={i} className={p.cls}>
                    {highlight ? (
                        <Highlighted text={p.text} needle={highlight} />
                    ) : (
                        p.text
                    )}
                </span>
            ))}
        </>
    );
}

function Highlighted({ text, needle }: { text: string; needle: string }) {
    if (!needle) return <>{text}</>;
    const lower = text.toLowerCase();
    const idx = lower.indexOf(needle);
    if (idx === -1) return <>{text}</>;
    return (
        <>
            {text.slice(0, idx)}
            <mark className="lc-hl">
                {text.slice(idx, idx + needle.length)}
            </mark>
            <Highlighted
                text={text.slice(idx + needle.length)}
                needle={needle}
            />
        </>
    );
}

function HistoryView(props: {
    rows: SnapshotSummary[];
    loading: boolean;
    error: string | null;
    picked: number[];
    onToggle: (id: number) => void;
    onClear: () => void;
}) {
    if (props.loading) return <div className="lc-empty">Loading history…</div>;
    if (props.error) return <div className="lc-error">{props.error}</div>;
    if (props.rows.length === 0) {
        return (
            <div className="lc-empty">
                No snapshots yet. The poller will capture one on its next tick.
            </div>
        );
    }
    return (
        <>
            <div className="lc-toolbar">
                <span>
                    Each row is a moment when the config differed from the
                    previous capture.{" "}
                    <span className="dim">
                        Pick two to compare ({props.picked.length}/2 selected).
                    </span>
                </span>
                {props.picked.length > 0 && (
                    <button className="link-btn" onClick={props.onClear}>
                        clear selection
                    </button>
                )}
            </div>
            <div className="card">
                <table className="tbl">
                    <thead>
                        <tr>
                            <th className="lc-pick-col"></th>
                            <th>id</th>
                            <th>when</th>
                            <th>source</th>
                            <th>hash</th>
                        </tr>
                    </thead>
                    <tbody>
                        {props.rows.map((r) => {
                            const isPicked = props.picked.includes(r.id);
                            return (
                                <tr
                                    key={r.id}
                                    onClick={() => props.onToggle(r.id)}
                                    className={isPicked ? "lc-picked" : ""}
                                >
                                    <td>
                                        <input
                                            type="checkbox"
                                            checked={isPicked}
                                            readOnly
                                            style={{ pointerEvents: "none" }}
                                        />
                                    </td>
                                    <td className="mono dim">#{r.id}</td>
                                    <td>
                                        {new Date(r.taken_at).toLocaleString()}
                                    </td>
                                    <td>
                                        <SourcePill source={r.source} />
                                    </td>
                                    <td
                                        className="mono dim"
                                        title={r.config_hash}
                                    >
                                        {(r.config_hash || "").slice(0, 12)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
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
            <div className="lc-empty">
                Pick two snapshots in the History tab to see what changed.
            </div>
        );
    }
    if (props.loading) return <div className="lc-empty">Computing diff…</div>;
    if (props.error) return <div className="lc-error">{props.error}</div>;
    if (!props.diff) return null;

    if (props.diff.changes.length === 0) {
        return (
            <div className="lc-empty">
                No differences between snapshot #{props.diff.from} and #
                {props.diff.to}.
            </div>
        );
    }

    const summary = props.filteredChanges.reduce(
        (acc, c) => {
            acc[c.op]++;
            return acc;
        },
        { add: 0, remove: 0, modify: 0 } as Record<string, number>,
    );

    return (
        <>
            <div className="lc-diff-summary">
                <div className="lc-diff-summary-left">
                    <span>
                        Diff{" "}
                        <span className="lc-range-id">#{props.diff.from}</span>{" "}
                        <span className="lc-arrow">→</span>{" "}
                        <span className="lc-range-id">#{props.diff.to}</span>
                    </span>
                    {summary.add > 0 && (
                        <span className="badge ok">{summary.add} added</span>
                    )}
                    {summary.remove > 0 && (
                        <span className="badge danger">
                            {summary.remove} removed
                        </span>
                    )}
                    {summary.modify > 0 && (
                        <span className="badge warn">
                            {summary.modify} modified
                        </span>
                    )}
                    {props.pathFilter &&
                        props.filteredChanges.length !==
                            props.diff.changes.length && (
                            <span className="dim">
                                ({props.filteredChanges.length} of{" "}
                                {props.diff.changes.length})
                            </span>
                        )}
                </div>
                <input
                    type="text"
                    placeholder="filter by path…"
                    value={props.pathFilter}
                    onChange={(e) => props.setPathFilter(e.target.value)}
                    className="lc-search"
                />
            </div>

            <div className="lc-changes">
                {props.filteredChanges.map((c, i) => (
                    <ChangeCard
                        key={i}
                        change={c}
                        highlight={props.pathFilter}
                    />
                ))}
                {props.filteredChanges.length === 0 && (
                    <div className="lc-empty">
                        No changes match "{props.pathFilter}".
                    </div>
                )}
            </div>
        </>
    );
}

function ChangeCard({
    change,
    highlight,
}: {
    change: DiffChange;
    highlight: string;
}) {
    const sigil =
        change.op === "add" ? "+" : change.op === "remove" ? "−" : "~";
    const label =
        change.op === "add"
            ? "added"
            : change.op === "remove"
            ? "removed"
            : "modified";
    const badgeKind =
        change.op === "add"
            ? "ok"
            : change.op === "remove"
            ? "danger"
            : "warn";

    return (
        <div className={`lc-change ${change.op}`}>
            <div className="lc-sigil">{sigil}</div>
            <div className="lc-change-body">
                <div className="lc-change-head">
                    <span className={`badge ${badgeKind}`}>{label}</span>
                    <PathDisplay path={change.path} highlight={highlight} />
                </div>

                {change.op === "modify" && (
                    <div className="lc-change-values">
                        <div className="lc-value before">
                            <span className="lc-value-label">before</span>
                            {renderValue(change.before)}
                        </div>
                        <div className="lc-value after">
                            <span className="lc-value-label">after</span>
                            {renderValue(change.after)}
                        </div>
                    </div>
                )}
                {change.op === "add" && (
                    <div className="lc-value after single">
                        <span className="lc-value-label">new value</span>
                        {renderValue(change.after)}
                    </div>
                )}
                {change.op === "remove" && (
                    <div className="lc-value before single">
                        <span className="lc-value-label">removed value</span>
                        {renderValue(change.before)}
                    </div>
                )}
            </div>
        </div>
    );
}

function PathDisplay({
    path,
    highlight,
}: {
    path: string;
    highlight: string;
}) {
    const segments = path.split(".");
    return (
        <span className="lc-change-path">
            {segments.map((seg, i) => (
                <span key={i}>
                    {i > 0 && <span className="dot">.</span>}
                    <span className="seg">
                        {highlight ? (
                            <Highlighted
                                text={seg}
                                needle={highlight.toLowerCase()}
                            />
                        ) : (
                            seg
                        )}
                    </span>
                </span>
            ))}
        </span>
    );
}

function renderValue(v: unknown): ReactNode {
    if (v === null || v === undefined)
        return <span className="dim">(null)</span>;
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = JSON.stringify(v, null, 2);
    if (s.length > 800) return s.slice(0, 800) + "…";
    return s;
}
