#!/usr/bin/env bash
#
# Ship 2 frontend installer for vyos-cp.
#
# Run from /opt/vyos-cp (or wherever your repo lives):
#     ./install-ship2-frontend.sh
#
# What it does:
#   1. Backs up the existing LiveConfigTab.tsx and api.ts
#   2. Replaces LiveConfigTab.tsx with the Ship 2 (sub-tab) version
#   3. Adds the diff types and computeDiff/getSnapshotByID methods to api.ts
#      (idempotent — safe to re-run)
#   4. Prints the rebuild command
#
# This script does NOT run `make rebuild` for you. After it completes, run
# `make rebuild` yourself, then hard-refresh the browser.

set -euo pipefail

# Colour helpers
if [[ -t 1 ]]; then
    C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_RED=$'\033[31m'
    C_BLU=$'\033[34m'; C_RST=$'\033[0m'
else
    C_GRN=""; C_YLW=""; C_RED=""; C_BLU=""; C_RST=""
fi
info()  { printf "%s[ship2]%s %s\n" "$C_BLU" "$C_RST" "$*"; }
ok()    { printf "%s[ ok ]%s %s\n" "$C_GRN" "$C_RST" "$*"; }
warn()  { printf "%s[warn]%s %s\n" "$C_YLW" "$C_RST" "$*"; }
fail()  { printf "%s[fail]%s %s\n" "$C_RED" "$C_RST" "$*" >&2; exit 1; }

# Locate the bundle (this script lives next to LiveConfigTab.tsx).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Locate the target repo.
REPO_DIR="$(pwd)"
[[ -f "${REPO_DIR}/Makefile" && -d "${REPO_DIR}/frontend/src" ]] \
    || fail "run from the vyos-cp repo root (where the Makefile and frontend/ live)"

# Required Python.
command -v python3 >/dev/null || fail "python3 not found in PATH"

LIVE_TAB="${REPO_DIR}/frontend/src/pages/LiveConfigTab.tsx"
API_TS="${REPO_DIR}/frontend/src/lib/api.ts"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${REPO_DIR}/.ship2-backup/${TS}"

[[ -f "$LIVE_TAB" ]] || fail "expected $LIVE_TAB to exist (Ship 1 must be installed first)"
[[ -f "$API_TS"   ]] || fail "expected $API_TS to exist"

# 1. Backups.
info "creating backups under ${BACKUP_DIR#"$REPO_DIR"/}/"
mkdir -p "${BACKUP_DIR}/frontend/src/pages" "${BACKUP_DIR}/frontend/src/lib"
cp -p "$LIVE_TAB" "${BACKUP_DIR}/frontend/src/pages/LiveConfigTab.tsx"
cp -p "$API_TS"   "${BACKUP_DIR}/frontend/src/lib/api.ts"
ok "backups taken"

# 2. Replace LiveConfigTab.tsx.
info "installing new LiveConfigTab.tsx"
[[ -f "${SCRIPT_DIR}/LiveConfigTab.tsx" ]] \
    || fail "bundle missing LiveConfigTab.tsx (expected next to this script)"
cp "${SCRIPT_DIR}/LiveConfigTab.tsx" "$LIVE_TAB"
ok "LiveConfigTab.tsx replaced"

# 3. Patch api.ts via Python (idempotent).
info "patching api.ts"
python3 <<'PYEOF' "$API_TS"
import sys, re

p = sys.argv[1]
src = open(p).read()
changed = False

# (A) Types block — only insert if not already there.
if "export type SnapshotDiff" not in src:
    types_block = """
export type DiffOp = 'add' | 'remove' | 'modify';

export type DiffChange = {
  path: string;
  op: DiffOp;
  before?: unknown;
  after?: unknown;
};

export type SnapshotDiff = {
  from: number;
  to: number;
  changes: DiffChange[];
};
"""
    anchor = "export const api = new API();"
    if anchor not in src:
        sys.exit("[fail] api.ts: missing 'export const api = new API();' anchor")
    src = src.replace(anchor, types_block + "\n" + anchor, 1)
    changed = True
    print("[ ok ] added diff types")
else:
    print("[ ok ] diff types already present")

# (B) Methods — only insert if not already there.
if "computeDiff" not in src:
    # Anchor: the captureSnapshotNow method added in Ship 1.
    anchor = """  // Force a synchronous capture. Backend RBAC requires operator/admin.
  captureSnapshotNow(id: string) {
    return this.req<DeviceSnapshot>(`/api/v1/devices/${id}/snapshot`, { method: 'POST' });
  }"""
    new_block = anchor + """

  // Ship 2 — fetch a specific historical snapshot (full config).
  getSnapshotByID(deviceID: string, snapshotID: number) {
    return this.req<DeviceSnapshot>(
      `/api/v1/devices/${deviceID}/snapshots/${snapshotID}`,
    );
  }

  // Ship 2 — compute the diff between two snapshots. `to` defaults to 'latest'.
  computeDiff(
    deviceID: string,
    fromID: number,
    toID: number | 'latest' = 'latest',
  ) {
    const t = typeof toID === 'number' ? String(toID) : toID;
    return this.req<SnapshotDiff>(
      `/api/v1/devices/${deviceID}/diff?from=${fromID}&to=${t}`,
    );
  }"""
    if anchor not in src:
        sys.exit("[fail] api.ts: missing captureSnapshotNow anchor; was Ship 1 installed?")
    src = src.replace(anchor, new_block, 1)
    changed = True
    print("[ ok ] added computeDiff and getSnapshotByID")
else:
    print("[ ok ] diff methods already present")

if changed:
    open(p, "w").write(src)
PYEOF

# 4. Final sanity check.
info "verifying everything is in place"
grep -q "export type SnapshotDiff" "$API_TS"   || fail "api.ts patch failed (types missing)"
grep -q "computeDiff"              "$API_TS"   || fail "api.ts patch failed (methods missing)"
grep -q "Three sub-tabs"           "$LIVE_TAB" || fail "LiveConfigTab.tsx is not the Ship 2 version"
ok "all four required markers present"

echo
echo "================================================================"
echo " Ship 2 frontend installed."
echo "================================================================"
echo
echo " Backups: ${BACKUP_DIR#"$REPO_DIR"/}/"
echo
echo " Next:"
echo "   cd $REPO_DIR"
echo "   make rebuild"
echo "   docker compose up -d"
echo
echo " Then hard-refresh the browser and open the Live Config tab."
echo " You should see three sub-tabs: Current · History · Diff."
echo
