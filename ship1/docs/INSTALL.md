# Ship 1 — Install & Verify

This bundle adds **device config snapshots** to vyos-cp. It is the foundation
for Ships 2–5 (diff viewer, drift detection, reconciliation, git history).

What you get:

- A new `device_snapshots` Postgres table
- Periodic snapshot capture in the fleet poller (every ~5 min, configurable)
- `GET /api/v1/devices/{id}/snapshot` — latest decoded config
- `GET /api/v1/devices/{id}/snapshots` — history (metadata only)
- `POST /api/v1/devices/{id}/snapshot` — force an immediate capture (operator+)
- A "Live Config" tab in the device UI

---

## 1. Drop files into the repo

From the bundle root, copy into the vyos-cp checkout:

```
backend/migrations/005_device_snapshots.sql       → backend/migrations/
backend/internal/model/snapshot.go                → backend/internal/model/
backend/internal/store/snapshots.go               → backend/internal/store/
backend/internal/store/snapshots_test.go          → backend/internal/store/
backend/internal/poller/snapshot.go               → backend/internal/poller/
backend/internal/api/snapshots.go                 → backend/internal/api/
frontend/src/lib/snapshots.ts                     → frontend/src/lib/
frontend/src/pages/LiveConfigTab.tsx              → frontend/src/pages/
```

> If you have a different migration number than `005`, rename the SQL file
> to your next free number. The migration is self-contained, no foreign-key
> dependencies on other new migrations.

---

## 2. Wire the pieces that touch existing code

Four places need a couple of lines each. None of these files are in the
bundle because they have local context that varies by your repo state.

### 2.1 `backend/internal/model/` — alias the config sub-types (optional)

If the translator package already defines `FirewallConfig`, `NATConfig`,
and `InterfacesConfig`, replace the placeholders in `snapshot.go`:

```go
import "vyos-cp/internal/vyos/translator"

type FirewallConfig   = translator.FirewallConfig
type NATConfig        = translator.NATConfig
type InterfacesConfig = translator.InterfacesConfig
```

Otherwise leave the placeholders — they are functional, just lossy on
exotic config shapes (which land in `extra`).

### 2.2 `backend/internal/poller/poller.go` — add the snapshot tick

Replace the existing `runDevice` body with the one in
`internal/poller/snapshot.go`, and add two fields to the `Poller` struct:

```go
type Poller struct {
    // ... existing fields ...
    snapshotEvery uint64        // ticks between snapshots
    translator    Translator    // existing translator.Decode wrapper
}
```

In the Poller constructor:

```go
ticks := envUint64("VYOS_CP_SNAPSHOT_INTERVAL_TICKS", 30)
p.snapshotEvery = ticks
```

### 2.3 `backend/internal/api/router.go` — register routes

Inside the `/devices/{id}` group:

```go
r.With(requireRole("viewer", "operator", "admin")).
    Get("/snapshot",  h.getLatestSnapshot)
r.With(requireRole("viewer", "operator", "admin")).
    Get("/snapshots", h.listSnapshots)
r.With(requireRole("operator", "admin")).
    Post("/snapshot", h.captureSnapshotNow)
```

The `Handler` struct must have `store`, `pool`, `translator`, and `log`
fields. All three are already present in v1; nothing new is needed.

### 2.4 `frontend/src/pages/DeviceDetail.tsx` — add the tab

```tsx
import { LiveConfigTab } from "./LiveConfigTab";

// inside the tab switch / router for the device page:
<LiveConfigTab
    deviceId={device.id}
    canCapture={user.roles.includes("operator") || user.roles.includes("admin")}
/>
```

---

## 3. Configuration

One new (optional) environment variable:

| Variable                          | Default | Meaning                                |
|-----------------------------------|---------|----------------------------------------|
| `VYOS_CP_SNAPSHOT_INTERVAL_TICKS` | `30`    | Poller ticks between snapshot captures |

At the default poll interval of 10s, 30 ticks = one snapshot every 5 minutes.
Set to `0` to disable periodic snapshots entirely (the manual `POST` and the
startup snapshot still work).

Add a line to `.env` if you want to override:

```
VYOS_CP_SNAPSHOT_INTERVAL_TICKS=30
```

---

## 4. Build & run

```bash
# Run tests first — they don't need the DB.
make test

# Rebuild everything. The migration runs on app startup.
make rebuild

# Watch the logs; you should see no errors related to "snapshot:".
make logs
```

---

## 5. Verify end-to-end

### 5.1 Migration applied

```bash
docker compose exec db psql -U vyos_cp -d vyos_cp -c "\d device_snapshots"
```

Expect to see the table with the columns listed in the migration.

### 5.2 Poller is capturing

Wait ~30 seconds after `make up` for the startup snapshot, then:

```bash
docker compose exec db psql -U vyos_cp -d vyos_cp -c \
  "SELECT id, device_id, taken_at, source FROM device_snapshots ORDER BY id DESC LIMIT 5;"
```

You should see one row per onboarded device with `source = device`.

### 5.3 API

```bash
TOKEN=...   # your JWT
DEV=...     # a device UUID

# Latest snapshot (full config)
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/v1/devices/$DEV/snapshot | jq .source

# History
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/v1/devices/$DEV/snapshots?limit=10 | jq 'length'

# Manual capture (operator+)
curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/v1/devices/$DEV/snapshot | jq .id
```

### 5.4 Dedup behavior (the important one)

Make no changes on the device, then hit `POST /snapshot` three times in a
row. All three responses should have the **same `id`** — the dedup-on-hash
path is preventing redundant inserts. If you see three different IDs, the
canonical-hash invariant is broken; check the translator output for
nondeterministic ordering and re-run `go test ./internal/store/...`.

### 5.5 UI

Open the device page, click the "Live Config" tab. You should see the
decoded config rendered as JSON, with the capture timestamp and short hash
in the header. The "Refresh now" button only appears for operator/admin.

---

## 6. Rollback

The migration is forward-only but the table is isolated:

```sql
BEGIN;
DROP TABLE device_snapshots;
DROP TYPE snapshot_source;
COMMIT;
```

Revert the code by deleting the eight files listed in step 1 and removing
the four wire-up edits in step 2.

---

## 7. What's next

Ship 1's snapshot table is the substrate for everything that follows:

- **Ship 2** adds a diff endpoint over any two snapshot IDs (or `latest`).
- **Ship 3** writes a `control_plane` snapshot inside the same transaction
  as every audit row, then compares each new `device` snapshot's hash to
  the most recent `control_plane` one. Mismatch → drift event.
- **Ship 4** computes the diff between a template and the latest snapshot
  and turns it into a `[]ConfigureOp` for reconciliation.
- **Ship 5** mirrors every inserted snapshot to a git repo on disk.

None of those ships require schema changes — `parent_id`, `audit_log_id`,
and `created_by` are already in place.
