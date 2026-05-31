#!/usr/bin/env python3
"""
patch-peer-drawer-v2.py — Phase 3A drawer refresh v2.

Replaces VPNPeerDrawer.tsx with the layout that matches the operator
reference image, and appends the .peer2-* CSS classes to index.css.

Idempotent. Run from /opt/vyos-cp.
"""
import os
import shutil
import sys

REPO = os.getcwd()
HERE = os.path.dirname(os.path.abspath(__file__))


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def main():
    print("VPN Peer drawer — refresh v2 (operator reference match)\n")

    # 1. Replace TSX (full rewrite of file we shipped earlier in this session)
    src = os.path.join(HERE, "VPNPeerDrawer.tsx")
    dst = os.path.join(REPO, "frontend/src/pages/VPNPeerDrawer.tsx")
    if not os.path.exists(src):
        die(f"missing source: {src}")
    if not os.path.exists(dst):
        die(f"target doesn't exist: {dst}")
    bak = dst + ".bak.refresh-v2"
    if not os.path.exists(bak):
        shutil.copy2(dst, bak)
    shutil.copy2(src, dst)
    print(f"  ✓ {dst}: replaced (backup at {bak})")

    # 2. Append CSS to index.css if not already present
    css_src = os.path.join(HERE, "peer-drawer-v2.css.append")
    css_dst = os.path.join(REPO, "frontend/src/index.css")
    if not os.path.exists(css_src):
        die(f"missing CSS source: {css_src}")
    if not os.path.exists(css_dst):
        die(f"index.css not found at {css_dst}")
    with open(css_dst) as f:
        existing = f.read()
    if ".peer2-hero {" in existing:
        print(f"  · {css_dst}: peer drawer v2 styles already present")
    else:
        bak = css_dst + ".bak.refresh-v2"
        if not os.path.exists(bak):
            shutil.copy2(css_dst, bak)
        with open(css_src) as f:
            additions = f.read()
        with open(css_dst, "a") as f:
            f.write(additions)
        print(f"  ✓ {css_dst}: peer drawer v2 styles appended")

    print()
    print("Done. Frontend-only — rebuild:")
    print()
    print("  docker compose build app")
    print("  docker compose up -d")
    print()
    print("Then hard-refresh the browser and click a peer row to see v2.")


if __name__ == "__main__":
    main()
