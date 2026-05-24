#!/usr/bin/env python3
"""patch_audit_tsx.py

Inject AuditDiffLink helper component into Audit.tsx and render it inside
the expanded audit row (next to the per-op delta), but only when the row
is a successful device write.

The helper handles graceful 404 (audit row not linked to a snapshot) by
swapping itself for a muted "no captured diff available" hint, so users
aren't confused when older audit rows lack a link.

Idempotent.

Usage:
    python3 patch_audit_tsx.py /opt/vyos-cp/frontend/src/pages/Audit.tsx
"""

from __future__ import annotations

import sys
from pathlib import Path


HELPER = r'''

// Ship 2.5 — View captured diff link, rendered inside an expanded audit row.
// On click, fetches the from/to snapshot IDs from the backend and navigates
// to the device's Live Config diff view. Hides itself (replaced by a hint)
// if the backend returns 404 — that means the audit row predates Ship 2.5
// or the post-commit /retrieve failed at the time.
function AuditDiffLink({ auditID }: { auditID: number }) {
    const navigate = useNavigate()
    const [pending, setPending] = useState(false)
    const [unavailable, setUnavailable] = useState(false)

    if (unavailable) {
        return (
            <span className="dim" style={{ fontSize: 11 }}
                  title="No snapshot was captured for this audit row (it predates Ship 2.5, or the device was unreachable right after the commit).">
                no captured diff available
            </span>
        )
    }

    return (
        <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                disabled={pending}
                title="Show the actual device config change captured immediately after this commit landed."
                onClick={async (ev) => {
                    ev.stopPropagation()
                    setPending(true)
                    try {
                        const ptr = await api.auditDiffPointer(auditID)
                        navigate(`/devices/${ptr.device_id}/live-config?from=${ptr.from}&to=${ptr.to}`)
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e)
                        if (/404/.test(msg)) {
                            setUnavailable(true)
                        } else {
                            // eslint-disable-next-line no-console
                            console.error('auditDiffPointer:', msg)
                        }
                    } finally {
                        setPending(false)
                    }
                }}>
            {pending ? 'loading…' : 'View captured diff →'}
        </button>
    )
}
'''


def main(target: str) -> int:
    p = Path(target)
    src = p.read_text()

    if "AuditDiffLink" in src:
        print("[ ok ] Audit.tsx already has AuditDiffLink")
        return 0

    changes = 0

    # 1. Add useNavigate to the react-router-dom import.
    if "useNavigate" not in src:
        # The existing import in Audit.tsx (single-quoted, per the grep we
        # did earlier) is: useSearchParams from 'react-router-dom'
        old_import = "import { useSearchParams } from 'react-router-dom'"
        new_import = "import { useNavigate, useSearchParams } from 'react-router-dom'"
        if old_import in src:
            src = src.replace(old_import, new_import, 1)
            changes += 1
        else:
            print("[warn] could not find react-router-dom import in expected form", file=sys.stderr)

    # 2. Insert HELPER right before `export function Audit()`.
    anchor = "export function Audit()"
    if anchor not in src:
        print(f"[fail] could not find 'export function Audit()' anchor in {target}", file=sys.stderr)
        return 2
    src = src.replace(anchor, HELPER + "\n" + anchor, 1)
    changes += 1

    # 3. Insert the AuditDiffLink JSX into the expanded row, right after
    # the error_msg block. The exact text from your earlier grep:
    #
    #   {e.error_msg && <div className="err" style={{ marginTop: 8 }}>{e.error_msg}</div>}
    #                </td></tr>
    #
    # Indentation in the file matches that pattern (verified via the earlier
    # sed -n).
    old_block = (
        "{e.error_msg && <div className=\"err\" style={{ marginTop: 8 }}>{e.error_msg}</div>}\n"
        "                  </td></tr>"
    )
    new_block = (
        "{e.error_msg && <div className=\"err\" style={{ marginTop: 8 }}>{e.error_msg}</div>}\n"
        "                    {e.success && e.device && (\n"
        "                      <div style={{ marginTop: 10 }}>\n"
        "                        <AuditDiffLink auditID={e.id} />\n"
        "                      </div>\n"
        "                    )}\n"
        "                  </td></tr>"
    )
    if old_block in src:
        src = src.replace(old_block, new_block, 1)
        changes += 1
    else:
        print("[warn] could not locate exact error_msg block in Audit.tsx;", file=sys.stderr)
        print("       check indentation manually if the link doesn't appear.", file=sys.stderr)

    p.write_text(src)
    print(f"[ ok ] Audit.tsx: {changes} edit(s) applied")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: patch_audit_tsx.py <path>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
