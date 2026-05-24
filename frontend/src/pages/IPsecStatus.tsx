import { useEffect, useMemo, useState } from "react";

// IPsecStatus page — live Phase 1 (IKE) / Phase 2 (CHILD) SA view.
//
// Data flow:
//   1. On mount, GET /api/v1/devices/{id}/ipsec/status for an instant snapshot.
//   2. Subscribe to the existing WebSocket; "ipsec-status" events for this
//      device replace the snapshot live (the poller pushes one per tick).
//
// This matches the app's existing pattern in src/lib/api.ts (fetch + WS client).
// Replace the inline fetch/WS with your api.ts helpers on integration; they are
// inlined here only to keep this page self-contained for review.

type IKEState = "up" | "connecting" | "down" | "unknown";
type ChildState = "installed" | "rekeying" | "connecting" | "down" | "unknown";

interface IKESA {
  peer: string;
  state: IKEState;
  rawState: string;
  ikeVer: string;
  localId: string;
  remoteId: string;
  localIp: string;
  remoteIp: string;
  encrypt: string;
  hash: string;
  dhGroup: string;
  natt: boolean;
  estabSecs: number;
  rekeySecs: number;
}

interface ChildSA {
  name: string;
  state: ChildState;
  rawState: string;
  proposal: string;
  localSubnet: string;
  remoteSubnet: string;
  bytesIn: number;
  bytesOut: number;
  packetsIn: number;
  packetsOut: number;
  uptimeSecs: number;
  rekeySecs: number;
}

interface IPsecStatus {
  deviceId: string;
  ike: IKESA[] | null;
  children: ChildSA[] | null;
  parseWarnings?: string[];
}

const STATE_COLOR: Record<string, string> = {
  up: "var(--ok, #2e7d32)",
  installed: "var(--ok, #2e7d32)",
  connecting: "var(--warn, #b88300)",
  rekeying: "var(--warn, #b88300)",
  down: "var(--err, #c62828)",
  unknown: "var(--muted, #777)",
};

function fmtSecs(s: number): string {
  if (s < 0) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

function Dot({ state }: { state: string }) {
  return (
    <span
      aria-label={state}
      style={{
        display: "inline-block",
        width: 9,
        height: 9,
        borderRadius: "50%",
        marginRight: 8,
        background: STATE_COLOR[state] ?? STATE_COLOR.unknown,
        boxShadow: state === "up" || state === "installed" ? "0 0 6px var(--ok, #2e7d32)" : "none",
      }}
    />
  );
}

export default function IPsecStatusPage({ deviceId }: { deviceId: string }) {
  const [status, setStatus] = useState<IPsecStatus | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 1. snapshot
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/devices/${deviceId}/ipsec/status`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((s: IPsecStatus) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  // 2. live WS — same socket the app already opens for status/throughput
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/api/v1/ws?device=${deviceId}`);
    ws.onopen = () => setLive(true);
    ws.onclose = () => setLive(false);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "ipsec-status" && msg.device === deviceId) {
          setStatus(msg.status as IPsecStatus);
        }
      } catch {
        /* ignore non-JSON frames */
      }
    };
    return () => ws.close();
  }, [deviceId]);

  // group children under their parent IKE peer by name prefix
  const grouped = useMemo(() => {
    const ike = status?.ike ?? [];
    const children = status?.children ?? [];
    return ike.map((sa) => ({
      ike: sa,
      children: children.filter(
        (c) => c.name === sa.peer || c.name.startsWith(sa.peer + "-") || c.name.startsWith(sa.peer)
      ),
    }));
  }, [status]);

  const orphanChildren = useMemo(() => {
    const ike = status?.ike ?? [];
    const children = status?.children ?? [];
    if (ike.length === 0) return children;
    return children.filter(
      (c) => !ike.some((sa) => c.name === sa.peer || c.name.startsWith(sa.peer))
    );
  }, [status]);

  return (
    <div style={S.page}>
      <header style={S.head}>
        <h1 style={S.h1}>IPsec — {deviceId}</h1>
        <span style={S.liveBadge(live)}>{live ? "● live" : "○ offline"}</span>
      </header>

      {error && <div style={S.error}>Snapshot failed: {error}. Live stream will populate on next poll.</div>}

      {status?.parseWarnings?.length ? (
        <div style={S.warn}>
          {status.parseWarnings.length} parser note(s): {status.parseWarnings.join("; ")}
        </div>
      ) : null}

      {!status && !error && <div style={S.muted}>Loading SA status…</div>}

      {status && grouped.length === 0 && orphanChildren.length === 0 && (
        <div style={S.muted}>No active IPsec security associations.</div>
      )}

      {grouped.map(({ ike, children }) => (
        <section key={ike.peer} style={S.card}>
          <div style={S.cardHead}>
            <div style={S.peerTitle}>
              <Dot state={ike.state} />
              <strong style={S.mono}>{ike.peer}</strong>
              <span style={S.tag}>Phase 1 · {ike.ikeVer || "IKE"}</span>
            </div>
            <div style={S.times}>
              <span>up {fmtSecs(ike.estabSecs)}</span>
              <span style={S.dim}>rekey {fmtSecs(ike.rekeySecs)}</span>
            </div>
          </div>

          <div style={S.ikeMeta}>
            <Meta k="Local" v={`${ike.localIp}${ike.localId && ike.localId !== ike.localIp ? ` (${ike.localId})` : ""}`} />
            <Meta k="Remote" v={`${ike.remoteIp}${ike.remoteId && ike.remoteId !== ike.remoteIp ? ` (${ike.remoteId})` : ""}`} />
            <Meta k="Crypto" v={[ike.encrypt, ike.hash, ike.dhGroup].filter(Boolean).join(" / ")} />
            <Meta k="NAT-T" v={ike.natt ? "yes" : "no"} />
          </div>

          {children.length === 0 ? (
            <div style={S.noChild}>No Phase 2 (CHILD) SAs established.</div>
          ) : (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>CHILD</th>
                  <th style={S.th}>State</th>
                  <th style={S.th}>Local subnet</th>
                  <th style={S.th}>Remote subnet</th>
                  <th style={S.thR}>In</th>
                  <th style={S.thR}>Out</th>
                  <th style={S.thR}>Pkts I/O</th>
                  <th style={S.thR}>Up</th>
                  <th style={S.thR}>Rekey</th>
                </tr>
              </thead>
              <tbody>
                {children.map((c) => (
                  <tr key={c.name}>
                    <td style={S.tdMono}>{c.name}</td>
                    <td style={S.td}>
                      <Dot state={c.state} />
                      {c.rawState || c.state}
                    </td>
                    <td style={S.tdMono}>{c.localSubnet || "—"}</td>
                    <td style={S.tdMono}>{c.remoteSubnet || "—"}</td>
                    <td style={S.tdR}>{fmtBytes(c.bytesIn)}</td>
                    <td style={S.tdR}>{fmtBytes(c.bytesOut)}</td>
                    <td style={S.tdR}>
                      {c.packetsIn}/{c.packetsOut}
                    </td>
                    <td style={S.tdR}>{fmtSecs(c.uptimeSecs)}</td>
                    <td style={S.tdR}>{fmtSecs(c.rekeySecs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}

      {orphanChildren.length > 0 && (
        <section style={S.card}>
          <div style={S.cardHead}>
            <span style={S.peerTitle}>Unmatched CHILD SAs</span>
          </div>
          <table style={S.table}>
            <tbody>
              {orphanChildren.map((c) => (
                <tr key={c.name}>
                  <td style={S.tdMono}>{c.name}</td>
                  <td style={S.td}>
                    <Dot state={c.state} />
                    {c.rawState}
                  </td>
                  <td style={S.tdMono}>
                    {c.localSubnet} ↔ {c.remoteSubnet}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div style={S.meta}>
      <span style={S.metaK}>{k}</span>
      <span style={S.metaV}>{v || "—"}</span>
    </div>
  );
}

const mono = "ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, monospace";

const S: Record<string, any> = {
  page: { padding: "20px 24px", fontFamily: "var(--font-body, system-ui)", color: "var(--fg, #1a1a1a)", maxWidth: 1100 },
  head: { display: "flex", alignItems: "center", gap: 14, marginBottom: 16 },
  h1: { fontSize: 18, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" },
  liveBadge: (live: boolean) => ({
    fontSize: 12,
    fontFamily: mono,
    color: live ? "var(--ok, #2e7d32)" : "var(--muted, #999)",
    border: `1px solid ${live ? "var(--ok, #2e7d32)" : "var(--border, #ddd)"}`,
    borderRadius: 4,
    padding: "2px 8px",
  }),
  card: {
    border: "1px solid var(--border, #e2e2e2)",
    borderRadius: 8,
    marginBottom: 14,
    background: "var(--card, #fff)",
    overflow: "hidden",
  },
  cardHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 14px",
    borderBottom: "1px solid var(--border, #eee)",
    background: "var(--card-head, #fafafa)",
  },
  peerTitle: { display: "flex", alignItems: "center", gap: 10, fontSize: 14 },
  tag: { fontSize: 11, fontFamily: mono, color: "var(--muted, #888)", border: "1px solid var(--border,#ddd)", borderRadius: 3, padding: "1px 6px" },
  times: { display: "flex", gap: 14, fontSize: 12, fontFamily: mono },
  dim: { color: "var(--muted, #999)" },
  ikeMeta: { display: "flex", flexWrap: "wrap", gap: "10px 28px", padding: "10px 14px", borderBottom: "1px solid var(--border,#f0f0f0)" },
  meta: { display: "flex", flexDirection: "column", gap: 2 },
  metaK: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted,#999)" },
  metaV: { fontSize: 13, fontFamily: mono },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 12px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--muted,#999)", borderBottom: "1px solid var(--border,#eee)" },
  thR: { textAlign: "right", padding: "8px 12px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--muted,#999)", borderBottom: "1px solid var(--border,#eee)" },
  td: { padding: "8px 12px", borderBottom: "1px solid var(--border,#f4f4f4)" },
  tdMono: { padding: "8px 12px", borderBottom: "1px solid var(--border,#f4f4f4)", fontFamily: mono },
  tdR: { padding: "8px 12px", borderBottom: "1px solid var(--border,#f4f4f4)", textAlign: "right", fontFamily: mono },
  mono: { fontFamily: mono },
  noChild: { padding: "10px 14px", fontSize: 13, color: "var(--muted,#999)" },
  muted: { color: "var(--muted,#999)", fontSize: 13, padding: "8px 0" },
  error: { background: "var(--err-bg,#fdecea)", color: "var(--err,#c62828)", padding: "8px 12px", borderRadius: 6, fontSize: 13, marginBottom: 12 },
  warn: { background: "var(--warn-bg,#fff8e1)", color: "var(--warn,#8a6d00)", padding: "8px 12px", borderRadius: 6, fontSize: 12, marginBottom: 12, fontFamily: mono },
};
