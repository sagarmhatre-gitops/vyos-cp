# Flows backend — build notes & REQUIRED integration checks

## What this adds (real data, confirmed reachable)
Active connection (flow) tracking from `show conntrack table ipv4`, which we
verified IS reachable through the VyOS HTTP API /show endpoint (returned
success:true with the flow table). Poll + store + API + UI table.

## VERIFIED
- Parser (`parse/conntrack.go`) — 7 unit tests, all confirmed passing against the
  EXACT text your device's API returned, including the tricky UDP-blank-state rows
  (where State collapses and Timeout must not shift into it). Run:
    cd backend && go test ./internal/vyos/parse/ -run Conntrack -v
- All Go files brace/paren-balanced.
- Migration 007 is additive (one new table, CREATE TABLE IF NOT EXISTS).

## !! TWO INTEGRATION SEAMS YOU MUST CONFIRM (I could not see these files) !!
This build touches the vyos client and poller internals, which I have NOT read —
only their described behavior. Two method names are GUESSES and will likely need
renaming to match your actual code:

1. `c.showOp(ctx, []string{...})` in `vyos/conntrack.go`
   — the client's primitive that POSTs {op:"show",path:[...]} to /show and returns
   the `data` string. Your client already does this for `show interfaces` etc.
   Find the real method:
     grep -rn 'func (c \*Client)' backend/internal/vyos/*.go | grep -i 'show\|op'
   Then rename `c.showOp(...)` to match. It must return (string, error) with the
   envelope's data field. If your primitive returns raw JSON, unwrap .data first.

2. `p.clientFor(deviceID)` in `poller/flows.go`
   — returns the *vyos.Client for a device (same one throughput polling uses).
   Find it:
     grep -rn 'clientFor\|ClientPool\|\.For(' backend/internal/poller/*.go backend/internal/service/*.go
   Rename `p.clientFor(deviceID)` to match (might be p.pool.For(id), p.clients.Get(id), etc).

Also confirm the api.Server field is `s.poller` and that `writeJSON(w,status,data)`
exists (used by the existing throughput/usage handlers — it does if usage.go works).

## WIRING (after fixing the two seams)
- Migration: place 007_flows.sql in backend/internal/store/migrations/ (NOT
  backend/migrations/ — that was the path bug last time; the //go:embed is in
  internal/store/store.go).
- Poller: call p.collectFlows(ctx, deviceID) from pollOne (next to
  maybePersistCounters), gated by a cadence if you want (conntrack can be large;
  every ~30-60s is plenty). And add a prune of PruneFlowSnapshots in retentionLoop.
- Route: r.Get("/api/v1/devices/{id}/flows", s.deviceFlows) in extras.go.
- Frontend: add deviceFlows() (flows_api_method.txt) to api.ts; wire <FlowsView
  deviceId={id!}/> into QoS.tsx (or wherever you want it).

## What this does NOT include (and why)
- Traffic-distribution donut (by app) — needs tc class byte stats. CONFIRMED
  unreachable: `show queueing` and `show ... traffic-policy` both return
  "Invalid command" via the API. tc is raw shell the HTTP API won't run.
- Violations panel — same root cause (drops/overlimits live only in tc stats).
- Per-flow DSCP, application/DPI labels — conntrack doesn't carry them.
These three reference-mockup panels are NOT buildable through the API-only
architecture. Getting them requires an SSH/agent-based tc collector — a deliberate
departure from the API-only design, scoped separately.

## Honest status
The parser is rock-solid (tested against your real data). The store/migration/API
are straightforward. The RISK is the two client/poller seam names above — expect
to rename 2 method calls and possibly one unwrap. Once those match, `go build` and
`go test ./internal/vyos/parse/` are the real checks. This is a bigger, less
certain change than the metering pipeline because it reaches into client/poller
internals I built against description, not source.
