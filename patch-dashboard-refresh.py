#!/usr/bin/env python3
"""
patch-dashboard-refresh.py — Path A visual refresh for the device overview.

What changes:
  1. frontend/src/components/Sparkline.tsx — adds optional `variant` prop
     ('area' | 'line' | 'bars'). Backward compatible; 'area' is default.
  2. frontend/src/pages/Overview.tsx — new layout:
     - Refresh control bar (last-updated timestamp + interval dropdown)
     - 6-tile KPI row: Health · Throughput · Sessions · CPU · Memory · IPsec
     - Interface Status table (replaces card grid)
     - IPsec / VPN Status panel with per-peer list
     - Restyled audit + config + quick actions row

Both files are full replacements; previous versions backed up alongside.

Idempotent. Run from /opt/vyos-cp.
"""
import os
import shutil
import sys

REPO = os.getcwd()

# Files written wholesale. Each has a sentinel string that lets us detect
# whether a previous apply already installed our version.
WRITES = [
    {
        "path": "frontend/src/components/Sparkline.tsx",
        "src":  "Sparkline.tsx",
        "marker": "variant?: 'area' | 'line' | 'bars'",
    },
    {
        "path": "frontend/src/pages/Overview.tsx",
        "src":  "Overview.tsx",
        "marker": "Path A refresh — visual polish",
    },
]

def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    print("Applying Path A dashboard refresh…\n")
    for w in WRITES:
        dst = os.path.join(REPO, w["path"])
        src = os.path.join(here, w["src"])
        if not os.path.exists(src):
            die(f"source file missing: {src}")
        if not os.path.exists(os.path.dirname(dst)):
            die(f"target directory missing: {os.path.dirname(dst)} (run from /opt/vyos-cp)")
        if os.path.exists(dst):
            with open(dst) as f:
                cur = f.read()
            if w["marker"] in cur:
                print(f"  · {w['path']}: already current")
                continue
            bak = dst + ".bak.dashboard-refresh"
            if not os.path.exists(bak):
                shutil.copy2(dst, bak)
        shutil.copy2(src, dst)
        print(f"  ✓ {w['path']}: written")
    print()
    print("Done. Frontend-only — fast rebuild:")
    print("  docker compose down && docker compose build app && docker compose up -d")

if __name__ == "__main__":
    main()
