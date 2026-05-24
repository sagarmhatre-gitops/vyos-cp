#!/usr/bin/env python3
"""
patch-audit-filters.py — adds filtering + search to the audit log page.

What changes:
  frontend/src/pages/Audit.tsx — Audit() function gets:
    - Free-text search across action / device / user / error message
    - Action-prefix dropdown (firewall / nat / ipsec / etc.) auto-populated
      from the data, so filters that wouldn't match anything aren't offered
    - Device dropdown auto-populated from the data
    - User dropdown auto-populated from the data
    - Result radio: All / OK / Failed
    - Showing N of M counter, with ok/failed split
    - Filter state mirrored to URL params for bookmarkable views:
      /audit?action=ipsec&result=failed
    - "Clear filters" button when any filter is active
    - Empty-state message when filters hide all rows

  Templates() in the same file is untouched.

Idempotent. Run from /opt/vyos-cp. Expects Audit.tsx alongside this script.
"""
import os
import shutil
import sys

PATH = "frontend/src/pages/Audit.tsx"
SRC = "Audit.tsx"
MARKER = "Audit log with filtering"


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    src = os.path.join(here, SRC)
    dst = os.path.join(os.getcwd(), PATH)

    if not os.path.exists(src):
        print(f"ERROR: source file missing: {src}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(os.path.dirname(dst)):
        print(f"ERROR: target directory missing: {os.path.dirname(dst)} (run from /opt/vyos-cp)", file=sys.stderr)
        sys.exit(1)

    if os.path.exists(dst):
        with open(dst) as f:
            cur = f.read()
        if MARKER in cur:
            print(f"  · {PATH}: already current")
            return
        bak = dst + ".bak.audit-filters"
        if not os.path.exists(bak):
            shutil.copy2(dst, bak)
            print(f"  · backup saved at {bak}")

    shutil.copy2(src, dst)
    print(f"  ✓ {PATH}: written")
    print()
    print("Frontend-only — fast rebuild:")
    print("  docker compose down && docker compose build app && docker compose up -d")


if __name__ == "__main__":
    main()
