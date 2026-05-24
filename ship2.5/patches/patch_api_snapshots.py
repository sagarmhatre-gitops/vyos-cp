#!/usr/bin/env python3
"""patch_api_snapshots.py

Add the auditDiffPointer endpoint to api/snapshots.go and wire it into
RegisterSnapshotRoutes.

  GET /api/v1/audit/{id}/diff
    → {device_id, from, to}  or 404

Idempotent: detects already-applied state.

Usage:
    python3 patch_api_snapshots.py /opt/vyos-cp/backend/internal/api/snapshots.go
"""

from __future__ import annotations

import sys
from pathlib import Path


HANDLER = r'''
// auditDiffPointer returns the snapshot pair (from, to) bracketing a given
// audit_log row, plus its device id. Ship 2.5: lets the Audit UI deep-link
// to the Live Config diff viewer for any device-write audit row.
//
// GET /api/v1/audit/{id}/diff
// Responses:
//   200 OK { device_id, from, to }
//   404    audit row not linked to a snapshot (predates Ship 2.5 or
//          post-commit retrieve failed at the time)
func (s *Server) auditDiffPointer(w http.ResponseWriter, r *http.Request) {
	auditIDStr := chi.URLParam(r, "id")
	auditID, err := strconv.ParseInt(auditIDStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid audit id", http.StatusBadRequest)
		return
	}

	toSnap, err := s.svc.Store().SnapshotForAuditLog(r.Context(), auditID)
	if errors.Is(err, store.ErrNoSnapshot) {
		http.Error(w, "no snapshot captured for this audit row", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "lookup audit snapshot: "+err.Error(), http.StatusInternalServerError)
		return
	}

	fromSnap, err := s.svc.Store().PreviousSnapshotForDevice(r.Context(), toSnap.DeviceID, toSnap.ID)
	if errors.Is(err, store.ErrNoSnapshot) {
		http.Error(w, "no prior snapshot to diff against", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "lookup previous snapshot: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"device_id": toSnap.DeviceID,
		"from":      fromSnap.ID,
		"to":        toSnap.ID,
	})
}
'''


def main(target: str) -> int:
    p = Path(target)
    src = p.read_text()

    if "auditDiffPointer" in src:
        print("[ ok ] auditDiffPointer already present")
        return 0

    # Insert handler before RegisterSnapshotRoutes if possible, otherwise
    # at end of file.
    anchor = "// RegisterSnapshotRoutes adds the snapshot"
    if anchor in src:
        src = src.replace(anchor, HANDLER.strip() + "\n\n" + anchor, 1)
    else:
        # Append at end
        src = src.rstrip() + "\n" + HANDLER + "\n"

    # Register the route. Look for the last existing r.Get/Post line inside
    # RegisterSnapshotRoutes.
    old_reg_marker = 'r.Get("/api/v1/devices/{id}/diff", s.computeDiff)'
    new_reg_block = (
        old_reg_marker
        + '\n\tr.Get("/api/v1/audit/{id}/diff", s.auditDiffPointer)'
    )
    if old_reg_marker not in src:
        print("[warn] could not find computeDiff route registration to anchor against;", file=sys.stderr)
        print("       add this line to RegisterSnapshotRoutes manually:", file=sys.stderr)
        print('       r.Get("/api/v1/audit/{id}/diff", s.auditDiffPointer)', file=sys.stderr)
    else:
        src = src.replace(old_reg_marker, new_reg_block, 1)

    p.write_text(src)
    print("[ ok ] auditDiffPointer endpoint added and registered")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: patch_api_snapshots.py <path>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
