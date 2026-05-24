#!/usr/bin/env python3
"""patch_api_ts.py

Add AuditDiffPointer type and auditDiffPointer method to frontend/src/lib/api.ts.

Idempotent.

Usage:
    python3 patch_api_ts.py /opt/vyos-cp/frontend/src/lib/api.ts
"""

from __future__ import annotations

import sys
from pathlib import Path


TYPES_BLOCK = """
export type AuditDiffPointer = {
  device_id: string;
  from: number;
  to: number;
};
"""

METHOD_BLOCK = """

  // Ship 2.5 — returns the snapshot pair bracketing a given audit row,
  // or 404 if no snapshot was captured for it.
  auditDiffPointer(auditID: number) {
    return this.req<AuditDiffPointer>(`/api/v1/audit/${auditID}/diff`);
  }"""


def main(target: str) -> int:
    p = Path(target)
    src = p.read_text()

    if "auditDiffPointer" in src:
        print("[ ok ] api.ts already has auditDiffPointer")
        return 0

    # 1. Add the type before "export const api = new API();"
    types_anchor = "export const api = new API();"
    if types_anchor not in src:
        print(f"[fail] missing 'export const api = new API();' anchor in {target}", file=sys.stderr)
        return 2
    if "export type AuditDiffPointer" not in src:
        src = src.replace(types_anchor, TYPES_BLOCK + "\n" + types_anchor, 1)

    # 2. Append the method right after computeDiff's closing brace.
    # We anchor on the full method block so we don't accidentally hit the
    # ` ` line at the end of some other method.
    method_anchor = (
        "  computeDiff(\n"
        "    deviceID: string,\n"
        "    fromID: number,\n"
        "    toID: number | 'latest' = 'latest',\n"
        "  ) {\n"
        "    const t = typeof toID === 'number' ? String(toID) : toID;\n"
        "    return this.req<SnapshotDiff>(\n"
        "      `/api/v1/devices/${deviceID}/diff?from=${fromID}&to=${t}`,\n"
        "    );\n"
        "  }"
    )
    if method_anchor not in src:
        print("[fail] could not find computeDiff method anchor in api.ts;", file=sys.stderr)
        print("       Ship 2 may not be installed cleanly.", file=sys.stderr)
        return 3

    src = src.replace(method_anchor, method_anchor + METHOD_BLOCK, 1)

    p.write_text(src)
    print("[ ok ] api.ts: added AuditDiffPointer type and auditDiffPointer method")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: patch_api_ts.py <path>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
