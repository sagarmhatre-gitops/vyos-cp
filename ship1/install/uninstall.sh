#!/usr/bin/env bash
#
# Ship 1 uninstaller. Removes the files the installer added and restores
# any backups it took. Does NOT touch the database — drop the table by hand
# if you want a full rollback (the SQL is at the bottom of this script).

set -euo pipefail

if [[ -t 1 ]]; then
    C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_RED=$'\033[31m'; C_RST=$'\033[0m'
else
    C_GRN=""; C_YLW=""; C_RED=""; C_RST=""
fi

ok()   { printf "%s[ ok ]%s %s\n" "$C_GRN" "$C_RST" "$*"; }
warn() { printf "%s[warn]%s %s\n" "$C_YLW" "$C_RST" "$*"; }
fail() { printf "%s[fail]%s %s\n" "$C_RED" "$C_RST" "$*" >&2; exit 1; }

REPO_DIR="$(pwd)"
[[ -f "${REPO_DIR}/Makefile" && -d "${REPO_DIR}/backend" ]] \
    || fail "run from the vyos-cp repo root"

# Files the installer adds
FILES=(
    "backend/internal/model/snapshot.go"
    "backend/internal/store/snapshots.go"
    "backend/internal/store/snapshots_test.go"
    "backend/internal/poller/snapshot.go"
    "backend/internal/api/snapshots.go"
    "backend/internal/api/snapshots_routes.go"
    "frontend/src/lib/snapshots.ts"
    "frontend/src/pages/LiveConfigTab.tsx"
)
for f in "${FILES[@]}"; do
    if [[ -f "${REPO_DIR}/${f}" ]]; then
        rm "${REPO_DIR}/${f}"
        ok "removed ${f}"
    fi
done

# Migration (filename is variable — match the pattern)
shopt -s nullglob
for mig in "${REPO_DIR}"/backend/migrations/*_device_snapshots.sql; do
    rm "$mig"
    ok "removed $(basename "$mig")"
done
shopt -u nullglob

# Restore latest backup snapshot if present
LATEST_BACKUP=$(find "${REPO_DIR}/.ship1-backup" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort | tail -1)
if [[ -n "$LATEST_BACKUP" ]]; then
    warn "restoring backed-up files from ${LATEST_BACKUP#"$REPO_DIR"/}"
    (cd "$LATEST_BACKUP" && find . -type f) | while read -r rel; do
        rel="${rel#./}"
        cp "${LATEST_BACKUP}/${rel}" "${REPO_DIR}/${rel}"
        ok "restored ${rel}"
    done
else
    warn "no backups found in .ship1-backup/ — nothing to restore"
fi

cat <<'EOS'

Filesystem rollback complete.

To drop the database table as well, run:

    docker compose exec db psql -U vyos_cp -d vyos_cp <<SQL
    BEGIN;
    DROP TABLE IF EXISTS device_snapshots;
    DROP TYPE  IF EXISTS snapshot_source;
    COMMIT;
    SQL

Then: make rebuild
EOS
