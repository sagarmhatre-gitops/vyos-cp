#!/usr/bin/env python3
"""patch_record_audit.py

Change Store.RecordAudit's signature from `error` to `(int64, error)` and
modify the body to RETURN the inserted row id.

Idempotent: detects already-patched state and exits cleanly.

Usage:
    python3 patch_record_audit.py /opt/vyos-cp/backend/internal/store/audit.go
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


def main(target: str) -> int:
    p = Path(target)
    src = p.read_text()

    if "RecordAudit(ctx context.Context, entry model.AuditEntry) (int64, error)" in src:
        print("[ ok ] RecordAudit already returns (int64, error)")
        return 0

    old_sig = "func (s *Store) RecordAudit(ctx context.Context, entry model.AuditEntry) error {"
    new_sig = "func (s *Store) RecordAudit(ctx context.Context, entry model.AuditEntry) (int64, error) {"

    if old_sig not in src:
        print(f"[fail] RecordAudit signature does not match expected form in {target}", file=sys.stderr)
        return 2

    src = src.replace(old_sig, new_sig, 1)

    # Pattern A: 'return s.pool.Exec(ctx, `...`, args...)' as the entire body.
    pat_a = re.compile(
        r"(\n\t+)return s\.pool\.Exec\(ctx,\s*`([^`]+)`(.*?)\)\s*\n\}",
        re.DOTALL,
    )
    m = pat_a.search(src)
    if m:
        indent = m.group(1)
        sql = m.group(2).rstrip().rstrip(";").rstrip()
        args = m.group(3)
        if "RETURNING id" not in sql and "returning id" not in sql.lower():
            sql = sql + " RETURNING id"
        replacement = (
            f"{indent}var id int64"
            f"{indent}err := s.pool.QueryRow(ctx, `{sql}`{args}).Scan(&id)"
            f"{indent}return id, err\n}}"
        )
        src = src[: m.start()] + replacement + src[m.end():]
        p.write_text(src)
        print("[ ok ] RecordAudit now returns (int64, error) — pattern A")
        return 0

    # Pattern B: explicit error check
    pat_b = re.compile(
        r"(\n\t+)_, err := s\.pool\.Exec\(ctx,\s*`([^`]+)`(.*?)\)\s*"
        r"(\n\t+if err != nil \{\s*\n\t+return err\s*\n\t+\}\s*\n\t+return nil)",
        re.DOTALL,
    )
    m = pat_b.search(src)
    if m:
        indent = m.group(1)
        sql = m.group(2).rstrip().rstrip(";").rstrip()
        args = m.group(3)
        if "RETURNING id" not in sql:
            sql = sql + " RETURNING id"
        replacement = (
            f"{indent}var id int64"
            f"{indent}err := s.pool.QueryRow(ctx, `{sql}`{args}).Scan(&id)"
            f"{indent}if err != nil {{{indent}\treturn 0, err{indent}}}"
            f"{indent}return id, nil"
        )
        src = src[: m.start()] + replacement + src[m.end():]
        p.write_text(src)
        print("[ ok ] RecordAudit now returns (int64, error) — pattern B")
        return 0

    print("[fail] could not pattern-match RecordAudit body; apply by hand:", file=sys.stderr)
    print("       1. add `var id int64` at the top", file=sys.stderr)
    print("       2. use s.pool.QueryRow(...).Scan(&id) and append RETURNING id to the SQL", file=sys.stderr)
    print("       3. return (id, err)", file=sys.stderr)
    return 3


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: patch_record_audit.py <path-to-audit.go>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
