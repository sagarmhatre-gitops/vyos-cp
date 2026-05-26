#!/usr/bin/env bash
# Phase 2.1 — daily/monthly usage rollups + period selector.
# Derives 'day' and 'month' rollups from existing hourly rows (recompute-and-
# replace, idempotent) and wires a hour/day/month selector into the UsageView.
# Additive; reuses the existing SetUsage/UsageRange/schema (period_type already
# supports 'day'/'month'). Run from repo root (e.g. /opt/vyos-cp).
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
[ -d backend/internal/poller ] || { echo "ERROR: run from repo root (e.g. /opt/vyos-cp)." >&2; exit 1; }

echo "1) New backend files (store aggregate read + poller aggregation + tests) ..."
cp -v "$SRC/backend/internal/store/usage_aggregate.go"        backend/internal/store/
cp -v "$SRC/backend/internal/poller/usage_aggregate.go"       backend/internal/poller/
cp -v "$SRC/backend/internal/poller/usage_aggregate_test.go"  backend/internal/poller/

echo "2) Wire daily/monthly job into the rollup loop ..."
python3 "$SRC/patch_rollup_loop.py"

echo "3) Frontend: UsageView with period selector ..."
cp -v "$SRC/frontend/src/pages/UsageView.tsx" frontend/src/pages/
CSS=frontend/src/index.css
if grep -q "usage period selector" "$CSS" 2>/dev/null; then
  echo "   period-selector CSS present — skip."
else
  cat "$SRC/frontend/usage_period.css" >> "$CSS"; echo "   period-selector CSS appended to $CSS"
fi

echo
echo "4) Run the aggregation unit tests BEFORE deploying:"
echo "   cd backend && go test ./internal/poller/ -run 'Accumulate|Aggregate' -v ; cd .."
echo
echo "5) Then build:  make rebuild && make logs"
echo
echo "Daily/monthly rows populate on the next 5-min rollup tick once hourly data"
echo "exists. The period selector switches granularity live (hour/day/month)."
