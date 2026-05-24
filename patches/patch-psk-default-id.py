#!/usr/bin/env python3
"""
patch-psk-default-id.py — VyOS 1.5 requires at least one `id` on every
authentication.psk block. When the operator hasn't supplied an explicit
local/remote ID, default to the peer's remote_address (which is what
charon would fall back to anyway).

Run from /opt/vyos-cp. Idempotent.
"""
import os
import shutil
import sys

PATH = "backend/internal/vyos/translator/ipsec.go"
MARKER = "default-id fallback"

# The current block ends with the `secret` set op. Insert a default-id op
# right after it, before the LocalID conditional.
OLD = '''		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: append(append([]string{}, pskBase...), "secret"),
			Value: p.Authentication.PreSharedSecret,
		})
		// VyOS 1.5 also wants `id` entries on the psk so charon knows which'''

NEW = '''		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: append(append([]string{}, pskBase...), "secret"),
			Value: p.Authentication.PreSharedSecret,
		})
		// default-id fallback: VyOS 1.5 rejects a psk block with neither
		// `id` nor `secret`. Even with `secret` set, the validator wants
		// at least one `id`. When the operator hasn't supplied one, fall
		// back to the remote-address — that's what charon would use anyway.
		if p.Authentication.LocalID == "" && p.Authentication.RemoteID == "" && p.RemoteAddress != "" {
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: append(append([]string{}, pskBase...), "id"),
				Value: p.RemoteAddress,
			})
		}
		// VyOS 1.5 also wants `id` entries on the psk so charon knows which'''


def main():
    if not os.path.exists(PATH):
        print(f"ERROR: {PATH} not found — run from /opt/vyos-cp", file=sys.stderr)
        sys.exit(1)

    with open(PATH, "r") as f:
        text = f.read()

    if MARKER in text:
        print(f"  · {PATH}: already patched")
        return

    if OLD not in text:
        print(f"ERROR: anchor not found.", file=sys.stderr)
        print("This patch expects the previous patch-vyos15-psk.py to have been applied first.", file=sys.stderr)
        sys.exit(1)

    bak = PATH + ".bak4"
    if not os.path.exists(bak):
        shutil.copy2(PATH, bak)

    text = text.replace(OLD, NEW, 1)
    with open(PATH, "w") as f:
        f.write(text)

    print(f"  ✓ {PATH}: patched (added default-id fallback)")
    print()
    print("Now: make rebuild, then retry the wizard.")
    print("Don't forget to delete orphan IKE-DEFAULT and ESP-DEFAULT first")
    print("(either via the UI or via vyos config-mode delete).")


if __name__ == "__main__":
    main()
