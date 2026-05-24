#!/usr/bin/env python3
"""patch_liveconfigtab.py

Wire LiveConfigTab.tsx to honour ?from=X&to=Y URL params on mount: when
present, pre-select those snapshot IDs in `picked` and switch to the Diff
tab. This is what the Audit page's "View captured diff" link drives.

Idempotent.

Usage:
    python3 patch_liveconfigtab.py /opt/vyos-cp/frontend/src/pages/LiveConfigTab.tsx
"""

from __future__ import annotations

import sys
from pathlib import Path


def main(target: str) -> int:
    p = Path(target)
    src = p.read_text()

    if "initialFromUrl" in src:
        print("[ ok ] LiveConfigTab.tsx already parses ?from/?to")
        return 0

    changes = 0

    # 1. Add useSearchParams import. The existing import line uses double
    # quotes per our Ship 2 rewrite.
    old_import_dq = 'import { useEffect, useMemo, useState, type ReactNode } from "react";'
    new_import_dq = (
        old_import_dq
        + '\nimport { useSearchParams } from "react-router-dom";'
    )
    old_import_sq = "import { useEffect, useMemo, useState, type ReactNode } from 'react';"
    new_import_sq = (
        old_import_sq
        + "\nimport { useSearchParams } from 'react-router-dom';"
    )

    if old_import_dq in src:
        src = src.replace(old_import_dq, new_import_dq, 1)
        changes += 1
    elif old_import_sq in src:
        src = src.replace(old_import_sq, new_import_sq, 1)
        changes += 1
    else:
        print("[fail] could not find React import line in expected form", file=sys.stderr)
        return 2

    # 2. Right after the `const [tab, setTab] = useState<Tab>("current");` line,
    # inject the URL-param parsing block.
    tab_anchor = 'const [tab, setTab] = useState<Tab>("current");'
    if tab_anchor not in src:
        # Try single-quoted variant
        tab_anchor_sq = "const [tab, setTab] = useState<Tab>('current');"
        if tab_anchor_sq in src:
            tab_anchor = tab_anchor_sq
        else:
            print("[fail] could not find tab useState anchor", file=sys.stderr)
            return 3

    inject = tab_anchor + '''
    const [searchParams] = useSearchParams();

    // Ship 2.5 — if the URL has ?from=X&to=Y, pre-select those snapshots
    // and switch to the Diff tab. This is how the Audit page's "View
    // captured diff" link drives navigation. We resolve only on mount;
    // subsequent in-tab clicks shouldn't fight the URL.
    const initialFromUrl = useMemo(() => {
        const f = parseInt(searchParams.get("from") || "", 10);
        const t = parseInt(searchParams.get("to") || "", 10);
        if (Number.isFinite(f) && Number.isFinite(t)) return [f, t];
        return null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);'''
    src = src.replace(tab_anchor, inject, 1)
    changes += 1

    # 3. Seed `picked` from initialFromUrl.
    old_picked = "const [picked, setPicked] = useState<number[]>([]);"
    new_picked = "const [picked, setPicked] = useState<number[]>(() => initialFromUrl ?? []);"
    if old_picked in src:
        src = src.replace(old_picked, new_picked, 1)
        changes += 1

    # 4. Add a useEffect that jumps to the Diff tab on mount when
    # initialFromUrl is set. Anchor on the existing loadCurrent useEffect.
    old_eff = "useEffect(() => {\n        void loadCurrent();\n    }, [deviceId]);"
    new_eff = old_eff + '''

    // Ship 2.5 — if the user arrived via an Audit "View captured diff"
    // link, jump straight to the Diff tab on mount.
    useEffect(() => {
        if (initialFromUrl) setTab("diff");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);'''
    if old_eff in src:
        src = src.replace(old_eff, new_eff, 1)
        changes += 1

    p.write_text(src)
    print(f"[ ok ] LiveConfigTab.tsx: {changes} edit(s) applied")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: patch_liveconfigtab.py <path>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
