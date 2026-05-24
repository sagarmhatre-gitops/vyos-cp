#!/usr/bin/env python3
"""patch_ipsec_test.py

Update the fakeStore.record() mock in ipsec_service_test.go to return
(int64, error) instead of error, since auditFunc's signature changed.

The mock's body just records calls — we don't care about the ID, so
all returns become 'return 0, ...'.

Idempotent.

Usage:
    python3 patch_ipsec_test.py /opt/vyos-cp/backend/internal/service/ipsec_service_test.go
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


def main(target: str) -> int:
    p = Path(target)
    src = p.read_text()

    if "success bool, errMsg string) (int64, error)" in src and "func (fs *fakeStore) record" in src:
        print("[ ok ] fakeStore.record already returns (int64, error)")
        return 0

    pat = re.compile(
        r"(func \(fs \*fakeStore\) record\(ctx context\.Context[^)]*\) )error \{([\s\S]*?)\n\}",
        re.MULTILINE,
    )
    m = pat.search(src)
    if not m:
        print(f"[fail] could not locate fakeStore.record in {target}", file=sys.stderr)
        return 2

    prefix = m.group(1)
    body = m.group(2)

    # Transform return statements: 'return nil' -> 'return 0, nil',
    # 'return err' / 'return someVar' -> 'return 0, <expr>'.
    new_body = body
    new_body = new_body.replace("return nil", "return 0, nil")
    new_body = re.sub(
        r"return ([a-zA-Z_][a-zA-Z0-9_.]*)\s*$",
        r"return 0, \1",
        new_body,
        flags=re.MULTILINE,
    )

    new = prefix + "(int64, error) {" + new_body + "\n}"
    src = src[: m.start()] + new + src[m.end():]
    p.write_text(src)
    print("[ ok ] fakeStore.record updated to (int64, error)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: patch_ipsec_test.py <path>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
