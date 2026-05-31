#!/usr/bin/env python3
"""
patch-peer-drawer-v3.py — Phase 3A drawer refresh v3.

Adds:
  - Full IKE/ESP crypto detail block in the Crypto Profiles card
  - "Download spec" button in the drawer footer that generates a
    vendor-neutral plain-text specification for sharing with the
    remote end's engineer

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
    print("VPN Peer drawer — refresh v3 (crypto detail + spec download)\n")

    src = os.path.join(HERE, "VPNPeerDrawer.tsx")
    dst = os.path.join(REPO, "frontend/src/pages/VPNPeerDrawer.tsx")
    if not os.path.exists(src):
        die(f"missing source: {src}")
    if not os.path.exists(dst):
        die(f"target doesn't exist: {dst}")
    bak = dst + ".bak.refresh-v3"
    if not os.path.exists(bak):
        shutil.copy2(dst, bak)
    shutil.copy2(src, dst)
    print(f"  ✓ {dst}: replaced (backup at {bak})")

    css_src = os.path.join(HERE, "peer-drawer-v3.css.append")
    css_dst = os.path.join(REPO, "frontend/src/index.css")
    if not os.path.exists(css_src):
        die(f"missing CSS source: {css_src}")
    if not os.path.exists(css_dst):
        die(f"index.css not found at {css_dst}")
    with open(css_dst) as f:
        existing = f.read()
    if ".peer2-crypto-grid" in existing:
        print(f"  · {css_dst}: crypto-grid styles already present")
    else:
        bak = css_dst + ".bak.refresh-v3"
        if not os.path.exists(bak):
            shutil.copy2(css_dst, bak)
        with open(css_src) as f:
            additions = f.read()
        with open(css_dst, "a") as f:
            f.write(additions)
        print(f"  ✓ {css_dst}: crypto-grid styles appended")

    print()
    print("Done. Frontend-only — rebuild:")
    print()
    print("  docker compose build app && docker compose up -d")
    print()
    print("Then hard-refresh the browser and:")
    print("  1. Click a peer row — Crypto Profiles card now shows full IKE/ESP detail")
    print("  2. Click 'Download spec' in the drawer footer — text file downloads")


if __name__ == "__main__":
    main()
