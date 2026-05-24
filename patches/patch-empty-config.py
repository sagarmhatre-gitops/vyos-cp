#!/usr/bin/env python3
"""
patch-empty-config.py — fix the "Configuration under specified path is empty"
error so a freshly-added device shows empty IPsec tables instead of a red
banner.

Run from /opt/vyos-cp (the repo root). Idempotent. Creates a .bak.
"""
import os
import shutil
import sys

PATH = "backend/internal/service/ipsec.go"

# The existing block:
OLD = '''	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"vpn", "ipsec"})
	if err != nil {
		return nil, err
	}
'''

# What it should become:
NEW = '''	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"vpn", "ipsec"})
	if err != nil {
		// VyOS returns this when `vpn ipsec` has never been touched. That's
		// not an error from our perspective — return an empty config so the
		// UI shows empty tables instead of a banner.
		if strings.Contains(err.Error(), "Configuration under specified path is empty") {
			return &model.IPsecConfig{}, nil
		}
		return nil, err
	}
'''

# Also need to add "strings" import if not present.
IMPORT_OLD = '''import (
	"context"
	"strings"
'''
IMPORT_OLD_ALT = '''import (
	"context"
'''
IMPORT_NEW = '''import (
	"context"
	"strings"
'''


def main():
    if not os.path.exists(PATH):
        print(f"ERROR: {PATH} not found — run from /opt/vyos-cp", file=sys.stderr)
        sys.exit(1)

    with open(PATH, "r") as f:
        text = f.read()

    if "Configuration under specified path is empty" in text:
        print(f"  · {PATH}: already patched")
        return

    if OLD not in text:
        print(f"ERROR: anchor not found in {PATH}; bailing.", file=sys.stderr)
        sys.exit(1)

    # Make backup
    bak = PATH + ".bak"
    if not os.path.exists(bak):
        shutil.copy2(PATH, bak)

    text = text.replace(OLD, NEW, 1)

    # Add strings import if not already present.
    if '"strings"' not in text.split("import (", 1)[1].split(")", 1)[0]:
        if IMPORT_OLD_ALT in text:
            text = text.replace(IMPORT_OLD_ALT, IMPORT_NEW, 1)
        else:
            print("WARNING: couldn't auto-add 'strings' import; you may need to add it manually.", file=sys.stderr)

    with open(PATH, "w") as f:
        f.write(text)

    print(f"  ✓ {PATH}: patched")
    print()
    print("Now run: make rebuild")


if __name__ == "__main__":
    main()
