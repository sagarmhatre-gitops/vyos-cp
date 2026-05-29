#!/usr/bin/env bash
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
[ -f frontend/src/pages/QoS.tsx ] || { echo "ERROR: run from repo root (/opt/vyos-cp)." >&2; exit 1; }

echo "1) Patch QoS.tsx — make the 3 bands collapsible (config collapsed by default) ..."
python3 "$SRC/patch_collapse.py"

echo "2) Append collapse CSS ..."
CSS=frontend/src/index.css
if grep -q "QoS collapsible bands" "$CSS"; then
  echo "   collapse CSS already present — skip."
else
  cp "$CSS" "$CSS.bak.collapse"
  cat "$SRC/collapse.css" >> "$CSS"
  echo "   appended."
fi

echo
echo "3) make rebuild && make logs"
make rebuild
echo
echo "Done. Headers toggle on click; Configuration starts collapsed."
echo "Rollback: cp frontend/src/pages/QoS.tsx.bak.collapse frontend/src/pages/QoS.tsx ; cp frontend/src/index.css.bak.collapse frontend/src/index.css"
