# vyos-cp — Rule Simulation & Shadow Detection Engine

## What this adds

| Feature | Detail |
|---|---|
| Packet simulation | Evaluate any packet against the live rule-set in VyOS execution order |
| Shadow detection | Automatically find unreachable, duplicated, or superseded rules |
| Risk analysis | Flag allow-any, exposed management ports, broad GeoIP, overlapping CIDRs |
| Translator preview | Show the exact `/configure` ops before committing |
| Audit integration | Every simulation stored in `simulation_sessions` for replay |

## New API endpoints

| Method | Path | Role |
|---|---|---|
| `POST` | `/api/v1/devices/{id}/rulesets/{name}/simulate` | Simulate a packet |
| `GET`  | `/api/v1/devices/{id}/rulesets/{name}/shadow`   | Run shadow + risk analysis |
| `POST` | `/api/v1/devices/{id}/rulesets/{name}/translate-preview` | Preview VyOS ops |

## Files deployed

```
backend/internal/simulation/
  engine.go          ← rule evaluation, shadow detection, translator preview
  engine_test.go     ← roundtrip + shadow + no-match tests

backend/internal/api/
  simulation.go      ← chi router wiring for the three endpoints

frontend/src/components/simulation/
  RuleSimulationPanel.tsx  ← drop-in React component for the editor

migrations/
  004_simulation_sessions.sql  ← audit table for simulation history
```

## Running tests

```bash
make sim-test        # unit tests inside Docker (no local Go required)
make sim-bench       # benchmark rule evaluation throughput
make test            # full backend suite including simulation package
```

## Design notes

- The engine is a pure Go struct (`simulation.Engine`) with no database or
  network dependency — it can be unit-tested without Docker.
- Shadow detection uses an O(n²) pairwise check which is fine for rule-sets
  up to ~1000 rules. Beyond that, consider indexing by protocol/port.
- All three API endpoints are role-gated: `viewer` can read shadow analysis
  and run simulations; only `operator`/`admin` can apply rules.
- The translator preview uses the same delete-then-set semantics as the main
  `vyos/translator` package so the preview is always accurate.
