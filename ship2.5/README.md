# Ship 2.5 — "View captured diff" link

Connects audit rows to snapshots: click any successful device-write audit
entry, jump straight to the diff between the snapshot taken right before
the commit and the snapshot taken right after.

## What it does

**Backend:**
- `Store.RecordAudit` returns `(int64, error)` instead of `error` — the
  inserted row's ID flows back to the caller.
- `runConfigure` and `runConfigureRedacted` capture this ID. On a successful
  commit they fire `captureSnapshotAfterCommit(ctx, client, deviceID, auditID)`.
- That helper does one `/retrieve` against VyOS and persists a snapshot
  tagged `source = control_plane` with the audit row's ID stamped on it.
  If the hash matches the previous row (dedup case), we instead UPDATE
  that row to promote it to `control_plane` and stamp the audit_log_id.
- New endpoint: `GET /api/v1/audit/{id}/diff` returns `{device_id, from, to}`
  or 404.
- Three new store methods: `LinkSnapshotToAudit`, `SnapshotForAuditLog`,
  `PreviousSnapshotForDevice`.

**Frontend:**
- `LiveConfigTab.tsx` parses `?from=X&to=Y` URL params on mount, pre-selects
  those snapshots, and switches to the Diff tab automatically.
- The Audit page's expanded row gets a small **"View captured diff →"**
  button, but only when the row is a successful device write. On 404 it
  gracefully swaps to a muted "no captured diff available" hint.

## Standards (same as Ship 1 and Ship 2)

- Installer preflights Ships 1 + 2 and the repo layout
- Idempotent: detects already-applied state, safe to re-run
- Every file edit backed up under `.ship2.5-backup/<timestamp>/`
- All surgical edits done in **Python patch scripts** (one per file), each
  invoked with the target path as `sys.argv[1]`. No bash sed; no escape
  fragility from the Ship 2 installer
- Python patches detect already-applied state and exit cleanly
- The bash orchestrator is small and dumb — just preflights, backs up,
  invokes patches, prints summary
- Smoke-tested against a fake repo before release

## Install

```bash
# 1. Get the bundle next to your repo
cd /opt/vyos-cp
unzip /home/ubuntu/vyos-cp-ship2.5.zip   # or however you got it here

# 2. Run the installer
./ship2.5/install-ship2.5.sh

# 3. Rebuild
make rebuild
docker compose up -d
```

## Verify after rebuild

1. **Make a config change in the UI** — e.g., add or modify a firewall
   rule, create a NAT rule, change an IPsec setting. Anything that
   produces an audit row tagged as success and tied to a device.
2. **Go to the Audit log page.** Find the row for the change you just
   made (top of the list).
3. **Click the row** to expand it. You'll see the per-op detail like before,
   plus a new **"View captured diff →"** button.
4. **Click the button.** The browser navigates to that device's Live Config
   tab, the Diff sub-tab is active, and the two relevant snapshots are
   pre-selected.

If the button shows **"no captured diff available"**, the snapshot-after-commit
hook didn't produce a snapshot for that audit row. Possible reasons:

- The audit row predates Ship 2.5 (older than the install)
- The device became unreachable immediately after the commit
- The post-commit `/retrieve` failed

The audit row itself is still valid — only the diff link is unavailable.

## Smoke test from terminal

```bash
TOKEN='paste-jwt'

# After making a change in the UI, get the latest audit row's ID:
AUDIT_ID=$(curl -sS -H "Authorization: Bearer $TOKEN" \
    http://localhost:8080/api/v1/audit | jq '.[0].id')

# Then fetch the diff pointer for it:
curl -sS -H "Authorization: Bearer $TOKEN" \
    http://localhost:8080/api/v1/audit/$AUDIT_ID/diff | jq .
```

Expected:
```json
{ "device_id": "efe4640b-...", "from": 5, "to": 6 }
```

## What's where in the bundle

```
ship2.5/
├── install-ship2.5.sh             # orchestrator (this is what you run)
├── snapshot_after_commit.go       # new file → backend/internal/service/
├── README.md                       # this file
└── patches/
    ├── patch_record_audit.py       # store/audit.go: (int64, error) signature
    ├── patch_service_go.py         # service.go: auditFunc + s.audit signatures
    ├── patch_nat_zones_rbac.py     # service: capture auditID + fire hook
    ├── patch_ipsec_test.py         # test mock signature update
    ├── patch_store_snapshots.py    # store/snapshots.go: three new methods
    ├── patch_api_snapshots.py      # api/snapshots.go: auditDiffPointer
    ├── patch_api_ts.py             # frontend api.ts: new method + type
    ├── patch_liveconfigtab.py      # LiveConfigTab.tsx: ?from/?to params
    └── patch_audit_tsx.py          # Audit.tsx: View captured diff link
```

## Rollback

```bash
LATEST=$(ls -t /opt/vyos-cp/.ship2.5-backup/ | head -1)
cp -r /opt/vyos-cp/.ship2.5-backup/$LATEST/* /opt/vyos-cp/
rm /opt/vyos-cp/backend/internal/service/snapshot_after_commit.go
cd /opt/vyos-cp && make rebuild
```

This restores all the files Ship 2.5 touched and removes the new helper.
You're back to the post-Ship-2 state.
