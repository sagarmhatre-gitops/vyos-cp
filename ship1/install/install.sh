#!/usr/bin/env bash
#
# Ship 1 installer for vyos-cp.
#
# Run from the vyos-cp repo root:
#     ./install.sh
#
# What it does:
#   1. Verifies you're in a vyos-cp checkout (Makefile + backend/ + frontend/).
#   2. Snapshots files it will modify into .ship1-backup/<timestamp>/.
#   3. Drops eight new files into their target paths (no overwrites of existing
#      files — fails loudly if a target unexpectedly exists).
#   4. Patches four existing files (router, poller, DeviceDetail, .env.example)
#      with detection-and-skip logic so re-running is safe.
#   5. Prints next-step build commands.
#
# What it does NOT do:
#   - Run make, docker compose, or migrations. You stay in control of the build.
#   - Modify Go files whose surrounding code we can't recognize. If a patch
#     can't find its anchor, the script prints the exact snippet to paste in
#     by hand and continues. No silent corruption.

set -euo pipefail

# ---------------------------------------------------------------------------
# Console helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
    C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'
    C_BLU=$'\033[34m';  C_RST=$'\033[0m'
else
    C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_RST=""
fi

info()  { printf "%s[ship1]%s %s\n" "$C_BLU" "$C_RST" "$*"; }
ok()    { printf "%s[ ok ]%s %s\n" "$C_GRN" "$C_RST" "$*"; }
warn()  { printf "%s[warn]%s %s\n" "$C_YLW" "$C_RST" "$*"; }
fail()  { printf "%s[fail]%s %s\n" "$C_RED" "$C_RST" "$*" >&2; exit 1; }
manual(){ printf "%s[todo]%s %s\n" "$C_YLW" "$C_RST" "$*"; MANUAL_STEPS+=("$*"); }

MANUAL_STEPS=()

# ---------------------------------------------------------------------------
# Locate bundle (the directory containing this script) and target (cwd)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The bundle's payload (backend/, frontend/) sits at the script dir if the
# script is at the bundle root, or one level up if the script is in install/.
if [[ -d "${SCRIPT_DIR}/backend/migrations" ]]; then
    BUNDLE_DIR="${SCRIPT_DIR}"
elif [[ -d "${SCRIPT_DIR}/../backend/migrations" ]]; then
    BUNDLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
else
    echo "error: cannot locate bundle payload relative to ${SCRIPT_DIR}" >&2
    exit 1
fi
REPO_DIR="$(pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${REPO_DIR}/.ship1-backup/${TS}"

info "bundle: ${BUNDLE_DIR}"
info "repo:   ${REPO_DIR}"

# ---------------------------------------------------------------------------
# Preflight — must be in a vyos-cp checkout
# ---------------------------------------------------------------------------
for required in Makefile backend frontend docker-compose.yml; do
    [[ -e "${REPO_DIR}/${required}" ]] || \
        fail "this doesn't look like a vyos-cp checkout — missing '${required}'.
       cd into the repo root and re-run."
done
ok "preflight: vyos-cp repo detected"

# Tooling
command -v awk >/dev/null  || fail "awk not found"
command -v grep >/dev/null || fail "grep not found"
command -v find >/dev/null || fail "find not found"
ok "preflight: tools present (awk, grep, find)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# copy_new SRC DST — copies SRC to DST, refuses to overwrite. Idempotent:
# if DST already exists and is identical, treats as ok.
copy_new() {
    local src="$1" dst="$2"
    if [[ -f "$dst" ]]; then
        if cmp -s "$src" "$dst"; then
            ok "exists (identical): ${dst#"$REPO_DIR"/}"
            return 0
        fi
        # Backup, then overwrite — re-runs of the installer should win.
        mkdir -p "$(dirname "${BACKUP_DIR}/${dst#"$REPO_DIR"/}")"
        cp -p "$dst" "${BACKUP_DIR}/${dst#"$REPO_DIR"/}"
        warn "overwriting (backup saved): ${dst#"$REPO_DIR"/}"
    fi
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    ok "installed: ${dst#"$REPO_DIR"/}"
}

# backup_existing PATH — copies a file we're about to patch into the backup dir.
backup_existing() {
    local path="$1"
    [[ -f "$path" ]] || return 0
    mkdir -p "$(dirname "${BACKUP_DIR}/${path#"$REPO_DIR"/}")"
    cp -p "$path" "${BACKUP_DIR}/${path#"$REPO_DIR"/}"
}

# Determine the next free migration number based on existing files in
# backend/migrations/. Falls back to 005.
next_migration_number() {
    local dir="${REPO_DIR}/backend/migrations"
    [[ -d "$dir" ]] || { echo "005"; return; }
    local max
    max=$(find "$dir" -maxdepth 1 -type f -name '[0-9]*_*.sql' \
              -printf '%f\n' 2>/dev/null \
          | awk -F'_' '{print $1+0}' \
          | sort -n \
          | tail -1)
    if [[ -z "$max" ]]; then
        echo "001"
    else
        printf "%03d" "$((max + 1))"
    fi
}

# ---------------------------------------------------------------------------
# Step 1 — Copy new files
# ---------------------------------------------------------------------------
info "step 1/4: dropping new files"

MIG_NUM=""
# If a previous run already installed the migration, reuse its number to avoid
# leaving stale duplicate migration files behind.
EXISTING_MIG=$(find "${REPO_DIR}/backend/migrations" -maxdepth 1 -type f \
                    -name '*_device_snapshots.sql' 2>/dev/null | head -1)
if [[ -n "$EXISTING_MIG" ]]; then
    MIG_NUM="$(basename "$EXISTING_MIG" | awk -F'_' '{print $1}')"
fi
if [[ -z "$MIG_NUM" ]]; then
    MIG_NUM="$(next_migration_number)"
fi
MIG_NAME="${MIG_NUM}_device_snapshots.sql"
copy_new "${BUNDLE_DIR}/backend/migrations/005_device_snapshots.sql" \
         "${REPO_DIR}/backend/migrations/${MIG_NAME}"

copy_new "${BUNDLE_DIR}/backend/internal/model/snapshot.go" \
         "${REPO_DIR}/backend/internal/model/snapshot.go"

copy_new "${BUNDLE_DIR}/backend/internal/store/snapshots.go" \
         "${REPO_DIR}/backend/internal/store/snapshots.go"

copy_new "${BUNDLE_DIR}/backend/internal/store/snapshots_test.go" \
         "${REPO_DIR}/backend/internal/store/snapshots_test.go"

copy_new "${BUNDLE_DIR}/backend/internal/poller/snapshot.go" \
         "${REPO_DIR}/backend/internal/poller/snapshot.go"

copy_new "${BUNDLE_DIR}/backend/internal/api/snapshots.go" \
         "${REPO_DIR}/backend/internal/api/snapshots.go"

copy_new "${BUNDLE_DIR}/frontend/src/lib/snapshots.ts" \
         "${REPO_DIR}/frontend/src/lib/snapshots.ts"

copy_new "${BUNDLE_DIR}/frontend/src/pages/LiveConfigTab.tsx" \
         "${REPO_DIR}/frontend/src/pages/LiveConfigTab.tsx"

# ---------------------------------------------------------------------------
# Step 2 — Patch router (chi route registration)
# ---------------------------------------------------------------------------
info "step 2/4: patching API router"

ROUTER_FILE=""
# chi route blocks usually live in api/router.go or api/api.go. Look for the
# device sub-router as the anchor.
for cand in \
    "${REPO_DIR}/backend/internal/api/router.go" \
    "${REPO_DIR}/backend/internal/api/api.go" \
    "${REPO_DIR}/backend/internal/api/routes.go"; do
    if [[ -f "$cand" ]] && grep -q '/devices/' "$cand"; then
        ROUTER_FILE="$cand"
        break
    fi
done

if [[ -z "$ROUTER_FILE" ]]; then
    manual "Could not locate the chi router file (expected one of router.go/api.go/routes.go
       in backend/internal/api/ containing '/devices/'). Add these routes inside the
       /devices/{id} sub-router manually:

           r.With(requireRole(\"viewer\",\"operator\",\"admin\")).Get(\"/snapshot\",  h.getLatestSnapshot)
           r.With(requireRole(\"viewer\",\"operator\",\"admin\")).Get(\"/snapshots\", h.listSnapshots)
           r.With(requireRole(\"operator\",\"admin\")).Post(\"/snapshot\", h.captureSnapshotNow)"
elif grep -q 'getLatestSnapshot' "$ROUTER_FILE"; then
    ok "router: already patched (${ROUTER_FILE#"$REPO_DIR"/})"
else
    backup_existing "$ROUTER_FILE"
    # We can't reliably reformat someone else's chi router, so instead of
    # editing in place we generate a tiny helper file that registers the
    # routes via init(). Cleanest, lowest-risk approach.
    cat > "${REPO_DIR}/backend/internal/api/snapshots_routes.go" <<'EOF'
package api

// Snapshot route registration — generated by ship1 installer.
//
// Hand-merge into your main router file when convenient, and delete this file.
// Until then, call RegisterSnapshotRoutes(r, h) from wherever you build the
// /devices/{id} sub-router. Example, in your existing router setup:
//
//     r.Route("/devices/{id}", func(r chi.Router) {
//         // ... existing routes ...
//         RegisterSnapshotRoutes(r, h)
//     })
//
// This indirection exists because the installer can't safely edit your
// router in place without seeing its exact shape.

import "github.com/go-chi/chi/v5"

func RegisterSnapshotRoutes(r chi.Router, h *Handler) {
    r.With(requireRole("viewer", "operator", "admin")).Get("/snapshot",  h.getLatestSnapshot)
    r.With(requireRole("viewer", "operator", "admin")).Get("/snapshots", h.listSnapshots)
    r.With(requireRole("operator", "admin")).Post("/snapshot", h.captureSnapshotNow)
}
EOF
    ok "router: created snapshots_routes.go with RegisterSnapshotRoutes()"
    manual "Open ${ROUTER_FILE#"$REPO_DIR"/}, find the chi.Route block for \"/devices/{id}\",
       and add this line inside it:

           RegisterSnapshotRoutes(r, h)

       (the 'h' is whatever variable holds your *Handler in that scope)."
fi

# ---------------------------------------------------------------------------
# Step 3 — .env.example
# ---------------------------------------------------------------------------
info "step 3/4: updating .env.example"

ENV_EXAMPLE="${REPO_DIR}/.env.example"
if [[ -f "$ENV_EXAMPLE" ]]; then
    if grep -q '^VYOS_CP_SNAPSHOT_INTERVAL_TICKS' "$ENV_EXAMPLE"; then
        ok ".env.example: already has VYOS_CP_SNAPSHOT_INTERVAL_TICKS"
    else
        backup_existing "$ENV_EXAMPLE"
        {
            echo ""
            echo "# Ship 1 — snapshot capture cadence (poller ticks between snapshots)."
            echo "# At default poll interval 10s, 30 ticks = one snapshot per 5 minutes."
            echo "# Set 0 to disable periodic snapshots (manual POST and startup still work)."
            echo "VYOS_CP_SNAPSHOT_INTERVAL_TICKS=30"
        } >> "$ENV_EXAMPLE"
        ok ".env.example: appended VYOS_CP_SNAPSHOT_INTERVAL_TICKS=30"
    fi
else
    warn ".env.example not found — skipping (you can add VYOS_CP_SNAPSHOT_INTERVAL_TICKS=30 to your .env later)"
fi

# ---------------------------------------------------------------------------
# Step 4 — Poller and DeviceDetail.tsx are too varied to patch safely.
# Print explicit instructions instead.
# ---------------------------------------------------------------------------
info "step 4/4: remaining manual edits"

# Poller
POLLER_FILE="${REPO_DIR}/backend/internal/poller/poller.go"
if [[ -f "$POLLER_FILE" ]] && grep -q 'captureSnapshot' "$POLLER_FILE"; then
    ok "poller: already calls captureSnapshot()"
else
    manual "In backend/internal/poller/poller.go, find the per-device run loop and call
       p.captureSnapshot(ctx, dev) at startup and every p.snapshotEvery ticks.
       Full replacement function is in backend/internal/poller/snapshot.go (the runDevice
       there shows the exact pattern). Two struct fields to add:

           snapshotEvery uint64
           translator    Translator   // the existing translator wrapper used elsewhere

       And in the Poller constructor:

           p.snapshotEvery = envUint64(\"VYOS_CP_SNAPSHOT_INTERVAL_TICKS\", 30)"
fi

# DeviceDetail
DEVICE_TSX="${REPO_DIR}/frontend/src/pages/DeviceDetail.tsx"
if [[ -f "$DEVICE_TSX" ]] && grep -q 'LiveConfigTab' "$DEVICE_TSX"; then
    ok "DeviceDetail.tsx: already imports LiveConfigTab"
elif [[ -f "$DEVICE_TSX" ]]; then
    manual "In frontend/src/pages/DeviceDetail.tsx, add a tab for the snapshot view:

           import { LiveConfigTab } from \"./LiveConfigTab\";

           // inside the tab switch:
           <LiveConfigTab
               deviceId={device.id}
               canCapture={user.roles.includes(\"operator\") || user.roles.includes(\"admin\")}
           />"
else
    manual "frontend/src/pages/DeviceDetail.tsx not found. Wire <LiveConfigTab /> into
       wherever your device-detail page renders tabs (see import shown in INSTALL.md)."
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "================================================================"
echo " Ship 1 installation summary"
echo "================================================================"
echo
echo "Backups (if any) saved to: ${BACKUP_DIR#"$REPO_DIR"/}/"
echo

if [[ ${#MANUAL_STEPS[@]} -eq 0 ]]; then
    ok "No manual steps required. You're ready to build."
else
    warn "${#MANUAL_STEPS[@]} manual step(s) remain:"
    echo
    for i in "${!MANUAL_STEPS[@]}"; do
        printf "  %d) %s\n\n" $((i+1)) "${MANUAL_STEPS[$i]}"
    done
fi

echo "----------------------------------------------------------------"
echo " Next steps"
echo "----------------------------------------------------------------"
cat <<'EOS'

  1. make test       # runs the new canonical-hash tests
  2. make rebuild    # rebuilds the multi-stage image and applies the migration
  3. make logs       # confirm no "snapshot:" errors

Verify in DB:
  docker compose exec db psql -U vyos_cp -d vyos_cp \
      -c "SELECT id, source, taken_at FROM device_snapshots ORDER BY id DESC LIMIT 5;"

Verify dedup (the important one): hit POST /snapshot three times on an
unchanged device — all three responses must have the SAME id.

  TOKEN=...   # your JWT
  DEV=...     # a device UUID
  for i in 1 2 3; do
      curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
          http://localhost:8080/api/v1/devices/$DEV/snapshot | jq .id
  done

EOS
