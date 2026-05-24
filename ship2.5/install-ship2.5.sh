#!/usr/bin/env bash
#
# Ship 2.5 installer — "View captured diff" linking audit rows to snapshots.
#
# Standards (same as Ship 1 and Ship 2):
#   - Idempotent: safe to re-run; each patch detects already-applied state
#   - Backs up every file it touches into .ship2.5-backup/<timestamp>/
#   - Uses Python patches (one per file) — no bash sed/heredoc fragility
#   - Preflight: bails out cleanly if Ships 1 + 2 aren't installed
#
# Run from /opt/vyos-cp (or wherever your repo lives):
#     ./install-ship2.5.sh

set -euo pipefail

# ---- Colour output --------------------------------------------------------

if [[ -t 1 ]]; then
    C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_RED=$'\033[31m'
    C_BLU=$'\033[34m'; C_RST=$'\033[0m'
else
    C_GRN=""; C_YLW=""; C_RED=""; C_BLU=""; C_RST=""
fi
info() { printf "%s[ship2.5]%s %s\n" "$C_BLU" "$C_RST" "$*"; }
ok()   { printf "%s[ ok ]%s %s\n"   "$C_GRN" "$C_RST" "$*"; }
warn() { printf "%s[warn]%s %s\n"   "$C_YLW" "$C_RST" "$*"; }
fail() { printf "%s[fail]%s %s\n"   "$C_RED" "$C_RST" "$*" >&2; exit 1; }

# ---- Locate bundle + repo -------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_DIR="$SCRIPT_DIR"
PATCHES_DIR="${BUNDLE_DIR}/patches"

[[ -d "$PATCHES_DIR" ]] \
    || fail "bundle is missing patches/ directory (expected at ${PATCHES_DIR})"
[[ -f "${BUNDLE_DIR}/snapshot_after_commit.go" ]] \
    || fail "bundle is missing snapshot_after_commit.go"

REPO_DIR="$(pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${REPO_DIR}/.ship2.5-backup/${TS}"

info "bundle: ${BUNDLE_DIR}"
info "repo:   ${REPO_DIR}"

# ---- Preflight ------------------------------------------------------------

for required in Makefile backend frontend docker-compose.yml; do
    [[ -e "${REPO_DIR}/${required}" ]] \
        || fail "this doesn't look like a vyos-cp checkout — missing '${required}'"
done

[[ -f "${REPO_DIR}/backend/internal/model/snapshot.go" ]] \
    || fail "Ship 1 not installed (no model/snapshot.go); run Ship 1 first"
[[ -f "${REPO_DIR}/backend/internal/diff/diff.go" ]] \
    || fail "Ship 2 not installed (no internal/diff package); run Ship 2 first"
grep -q "computeDiff" "${REPO_DIR}/frontend/src/lib/api.ts" \
    || fail "Ship 2 frontend not installed (api.ts missing computeDiff); run Ship 2 first"

command -v python3 >/dev/null || fail "python3 not found in PATH"

ok "preflight: vyos-cp + Ship 1 + Ship 2 detected"

# ---- Helpers --------------------------------------------------------------

# backup_file <relative-path>
# Copies the file into the backup tree (preserving relative structure).
# No-op if the file doesn't exist.
backup_file() {
    local rel="$1"
    local src="${REPO_DIR}/${rel}"
    [[ -f "$src" ]] || return 0
    mkdir -p "$(dirname "${BACKUP_DIR}/${rel}")"
    cp -p "$src" "${BACKUP_DIR}/${rel}"
}

# run_patch <patch-script-name> <relative-target-path>
# Backs up the target, runs the patch, prints failure context on non-zero.
run_patch() {
    local patch="$1"
    local rel="$2"
    local script="${PATCHES_DIR}/${patch}"
    local target="${REPO_DIR}/${rel}"

    [[ -f "$script" ]] || fail "missing patch script: $script"
    [[ -f "$target" ]] || fail "target file not found: $target"

    backup_file "$rel"

    if ! python3 "$script" "$target"; then
        fail "patch failed: $patch on $rel — see message above. Backup is at ${BACKUP_DIR}/${rel}"
    fi
}

# locate <pattern> <hint-message>
# Find the first file under backend/internal/store that contains <pattern>.
# Used to find audit.go (could be audit.go or store.go).
locate_store_file() {
    local pattern="$1"
    local match
    match="$(grep -rln "$pattern" "${REPO_DIR}/backend/internal/store/" 2>/dev/null | head -1 || true)"
    [[ -n "$match" ]] || fail "could not locate file containing '$pattern' under backend/internal/store/"
    echo "${match#"$REPO_DIR/"}"
}

# ---- The patches ----------------------------------------------------------

info "step 1/8: backend/internal/store — RecordAudit returns (int64, error)"
AUDIT_REL="$(locate_store_file 'func (s \*Store) RecordAudit')"
run_patch "patch_record_audit.py" "$AUDIT_REL"

info "step 2/8: backend/internal/service/service.go — auditFunc signature"
run_patch "patch_service_go.py" "backend/internal/service/service.go"

info "step 3/8: backend/internal/service/nat_zones_rbac.go — fire snapshot hook"
run_patch "patch_nat_zones_rbac.py" "backend/internal/service/nat_zones_rbac.go"

info "step 4/8: backend/internal/service/snapshot_after_commit.go — install helper"
TARGET="${REPO_DIR}/backend/internal/service/snapshot_after_commit.go"
if [[ -f "$TARGET" ]] && cmp -s "${BUNDLE_DIR}/snapshot_after_commit.go" "$TARGET"; then
    ok "snapshot_after_commit.go already present (identical)"
else
    [[ -f "$TARGET" ]] && backup_file "backend/internal/service/snapshot_after_commit.go"
    cp "${BUNDLE_DIR}/snapshot_after_commit.go" "$TARGET"
    ok "snapshot_after_commit.go installed"
fi

info "step 5/8: backend/internal/service/ipsec_service_test.go — mock signature"
if [[ -f "${REPO_DIR}/backend/internal/service/ipsec_service_test.go" ]]; then
    run_patch "patch_ipsec_test.py" "backend/internal/service/ipsec_service_test.go"
else
    warn "ipsec_service_test.go not found — skipping (tests may fail to compile)"
fi

info "step 6/8: backend/internal/store/snapshots.go — three new methods"
run_patch "patch_store_snapshots.py" "backend/internal/store/snapshots.go"

info "step 7/8: backend/internal/api/snapshots.go — auditDiffPointer endpoint"
run_patch "patch_api_snapshots.py" "backend/internal/api/snapshots.go"

info "step 8/8: frontend wiring (api.ts, LiveConfigTab.tsx, Audit.tsx)"
run_patch "patch_api_ts.py"          "frontend/src/lib/api.ts"
run_patch "patch_liveconfigtab.py"   "frontend/src/pages/LiveConfigTab.tsx"
run_patch "patch_audit_tsx.py"       "frontend/src/pages/Audit.tsx"

# ---- Summary --------------------------------------------------------------

echo
echo "================================================================"
echo " Ship 2.5 installed."
echo "================================================================"
echo
echo " Backups under: .ship2.5-backup/${TS}/"
echo
echo " Next steps:"
echo "   cd ${REPO_DIR}"
echo "   make rebuild"
echo "   docker compose up -d"
echo
echo " Verification (after rebuild):"
echo "   1. Make a config change in the UI"
echo "      (e.g. add or modify a firewall rule, NAT rule, etc.)"
echo "   2. Open the Audit log page"
echo "   3. Click the row for the change you just made"
echo "   4. Click 'View captured diff' — opens Live Config Diff tab"
echo "      with the right snapshots pre-selected"
echo
echo " Smoke test from terminal:"
echo "   TOKEN=<paste-jwt>"
echo "   curl -sS -H \"Authorization: Bearer \$TOKEN\" \\"
echo "       http://localhost:8080/api/v1/audit | jq '.[0].id'"
echo "   # Then for that ID:"
echo "   curl -sS -H \"Authorization: Bearer \$TOKEN\" \\"
echo "       http://localhost:8080/api/v1/audit/<id>/diff | jq ."
echo "   # Expect: { device_id, from, to }"
echo
