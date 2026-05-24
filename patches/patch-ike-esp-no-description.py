#!/usr/bin/env python3
"""
patch-ike-esp-no-description.py — VyOS doesn't accept `description` under
`vpn ipsec ike-group` or `vpn ipsec esp-group`. Remove those two emit lines
from the translator. The model fields stay (for future use / forward
compatibility); the translator just won't send them to the device.

Run from /opt/vyos-cp (the repo root). Idempotent. Creates a .bak.
"""
import os
import shutil
import sys

PATH = "backend/internal/vyos/translator/ipsec.go"

# In IKEGroupOps:
OLD_IKE = '\tleaf(g.Description, "description")\n\tif g.Lifetime > 0 {\n\t\tleaf(strconv.Itoa(g.Lifetime), "lifetime")\n\t}\n\tleaf(g.IKEVersion, "key-exchange")\n'
NEW_IKE = '\t// VyOS rejects `description` under ike-group; intentionally omitted.\n\tif g.Lifetime > 0 {\n\t\tleaf(strconv.Itoa(g.Lifetime), "lifetime")\n\t}\n\tleaf(g.IKEVersion, "key-exchange")\n'

# In ESPGroupOps:
OLD_ESP = '\tleaf(g.Description, "description")\n\tif g.Lifetime > 0 {\n\t\tleaf(strconv.Itoa(g.Lifetime), "lifetime")\n\t}\n\tif g.Mode != "" {\n\t\tleaf(string(g.Mode), "mode")\n\t}\n\tleaf(g.PFS, "pfs")\n'
NEW_ESP = '\t// VyOS rejects `description` under esp-group; intentionally omitted.\n\tif g.Lifetime > 0 {\n\t\tleaf(strconv.Itoa(g.Lifetime), "lifetime")\n\t}\n\tif g.Mode != "" {\n\t\tleaf(string(g.Mode), "mode")\n\t}\n\tleaf(g.PFS, "pfs")\n'


def patch_block(text, old, new, label):
    if "VyOS rejects `description` under " + label in text:
        print(f"  · {label}: already patched")
        return text, False
    if old not in text:
        print(f"ERROR: anchor for {label} not found in {PATH}; bailing.", file=sys.stderr)
        sys.exit(1)
    return text.replace(old, new, 1), True


def main():
    if not os.path.exists(PATH):
        print(f"ERROR: {PATH} not found — run from /opt/vyos-cp", file=sys.stderr)
        sys.exit(1)

    with open(PATH, "r") as f:
        text = f.read()

    bak = PATH + ".bak2"
    if not os.path.exists(bak):
        shutil.copy2(PATH, bak)

    text, c1 = patch_block(text, OLD_IKE, NEW_IKE, "ike-group")
    text, c2 = patch_block(text, OLD_ESP, NEW_ESP, "esp-group")

    if c1 or c2:
        with open(PATH, "w") as f:
            f.write(text)
        print(f"  ✓ {PATH}: patched (removed description emit from {('IKE' if c1 else '')}{(' and ' if c1 and c2 else '')}{('ESP' if c2 else '')})")
    else:
        print("Nothing to do.")
        return

    print()
    print("Now run: make rebuild")


if __name__ == "__main__":
    main()
