#!/usr/bin/env python3
"""patch_service_go.py

Update service.go to make auditFunc and s.audit return (int64, error)
instead of error.

Idempotent: detects already-patched state and exits cleanly.

Usage:
    python3 patch_service_go.py /opt/vyos-cp/backend/internal/service/service.go
"""

from __future__ import annotations

import sys
from pathlib import Path


def main(target: str) -> int:
    p = Path(target)
    src = p.read_text()

    if "ops []model.ConfigureOp, success bool, errMsg string) (int64, error)" in src:
        print("[ ok ] auditFunc already returns (int64, error)")
        return 0

    old_type = (
        "type auditFunc func(ctx context.Context, userID, userName, deviceID, deviceName, action string,\n"
        "\tops []model.ConfigureOp, success bool, errMsg string) error"
    )
    new_type = (
        "type auditFunc func(ctx context.Context, userID, userName, deviceID, deviceName, action string,\n"
        "\tops []model.ConfigureOp, success bool, errMsg string) (int64, error)"
    )
    if old_type not in src:
        print(f"[fail] auditFunc type not in expected form in {target}", file=sys.stderr)
        return 2
    src = src.replace(old_type, new_type, 1)

    old_audit = (
        "func (s *Service) audit(ctx context.Context, userID, userName, deviceID, device, action string, "
        "ops []model.ConfigureOp, success bool, errMsg string) error {\n"
        "\treturn s.store.RecordAudit(ctx, model.AuditEntry{"
    )
    new_audit = (
        "func (s *Service) audit(ctx context.Context, userID, userName, deviceID, device, action string, "
        "ops []model.ConfigureOp, success bool, errMsg string) (int64, error) {\n"
        "\treturn s.store.RecordAudit(ctx, model.AuditEntry{"
    )
    if old_audit not in src:
        print(f"[fail] s.audit body not in expected form in {target}", file=sys.stderr)
        return 3
    src = src.replace(old_audit, new_audit, 1)

    p.write_text(src)
    print("[ ok ] service.go: auditFunc + s.audit updated to (int64, error)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: patch_service_go.py <path>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
