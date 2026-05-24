#!/usr/bin/env python3
"""patch_nat_zones_rbac.py

After auditFn is called in runConfigure (and runConfigureRedacted), capture
the new (int64, error) return values and fire captureSnapshotAfterCommit on
success.

Idempotent: detects already-patched state.

Usage:
    python3 patch_nat_zones_rbac.py /opt/vyos-cp/backend/internal/service/nat_zones_rbac.go
"""

from __future__ import annotations

import sys
from pathlib import Path


def main(target: str) -> int:
    p = Path(target)
    src = p.read_text()

    if "captureSnapshotAfterCommit" in src:
        print("[ ok ] nat_zones_rbac.go already calls captureSnapshotAfterCommit")
        return 0

    changes = 0

    # Pattern A: runConfigure tail
    old_a = (
        "\t_ = s.auditFn(ctx, userID, userName, deviceID, devName, action, "
        "toModelOps(ops), err == nil, errMsg)\n\treturn err\n}"
    )
    new_a = (
        "\tauditID, _ := s.auditFn(ctx, userID, userName, deviceID, devName, action, "
        "toModelOps(ops), err == nil, errMsg)\n"
        "\tif err == nil {\n"
        "\t\ts.captureSnapshotAfterCommit(ctx, client, deviceID, auditID)\n"
        "\t}\n"
        "\treturn err\n"
        "}"
    )
    n_a = src.count(old_a)
    if n_a == 1:
        src = src.replace(old_a, new_a, 1)
        changes += 1
    elif n_a > 1:
        print(f"[fail] runConfigure tail matched {n_a} times — ambiguous", file=sys.stderr)
        return 2

    # Pattern B: runConfigureRedacted tail
    old_b = (
        "\t_ = s.auditFn(ctx, userID, userName, deviceID, devName, action, "
        "toModelOps(auditOps), err == nil, errMsg)"
    )
    new_b = (
        "\tauditID, _ := s.auditFn(ctx, userID, userName, deviceID, devName, action, "
        "toModelOps(auditOps), err == nil, errMsg)\n"
        "\tif err == nil {\n"
        "\t\ts.captureSnapshotAfterCommit(ctx, client, deviceID, auditID)\n"
        "\t}"
    )
    n_b = src.count(old_b)
    if n_b >= 1:
        src = src.replace(old_b, new_b, 1)
        changes += 1

    if changes == 0:
        print("[fail] no auditFn call sites matched expected form", file=sys.stderr)
        return 3

    p.write_text(src)
    print(f"[ ok ] nat_zones_rbac.go: patched {changes} call site(s)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: patch_nat_zones_rbac.py <path>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
