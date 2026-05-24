#!/usr/bin/env python3
"""patch_store_snapshots.py

Append three new store methods to store/snapshots.go:
  - LinkSnapshotToAudit(snapshotID, auditID): promotes a row to control_plane
  - SnapshotForAuditLog(auditID): lookup snapshot by audit row
  - PreviousSnapshotForDevice(deviceID, beforeID): the snapshot just before
    the given one for the same device — the "from" half of a captured diff

Idempotent: appends only if the methods aren't already present.

Usage:
    python3 patch_store_snapshots.py /opt/vyos-cp/backend/internal/store/snapshots.go
"""

from __future__ import annotations

import sys
from pathlib import Path


ADDITION = r'''

// ---------------------------------------------------------------------------
// Ship 2.5 — audit/snapshot linkage methods.
// ---------------------------------------------------------------------------

// LinkSnapshotToAudit promotes an existing snapshot to source=control_plane
// and stamps it with the given audit_log_id. Used by the snapshot-after-commit
// hook when the post-commit /retrieve hashed identically to a previous row
// and AppendSnapshot returned the existing one rather than inserting.
//
// Idempotent: safe to call when the values already match.
func (s *Store) LinkSnapshotToAudit(ctx context.Context, snapshotID, auditID int64) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE device_snapshots
		SET audit_log_id = $2, source = 'control_plane'
		WHERE id = $1
	`, snapshotID, auditID)
	return err
}

// SnapshotForAuditLog returns the snapshot whose audit_log_id matches the
// given ID. Returns ErrNoSnapshot if no such snapshot exists (e.g. the audit
// row predates Ship 2.5, or the post-commit /retrieve failed at the time).
func (s *Store) SnapshotForAuditLog(ctx context.Context, auditID int64) (model.DeviceSnapshot, error) {
	var (
		out        model.DeviceSnapshot
		hash       []byte
		cfgJSON    []byte
		parentID   *int64
		auditLogID *int64
		createdBy  *uuid.UUID
	)
	err := s.pool.QueryRow(ctx, `
		SELECT id, device_id, taken_at, source, config_hash, config_json,
		       parent_id, audit_log_id, created_by
		FROM device_snapshots
		WHERE audit_log_id = $1
		ORDER BY id DESC LIMIT 1
	`, auditID).Scan(
		&out.ID, &out.DeviceID, &out.TakenAt, &out.Source,
		&hash, &cfgJSON, &parentID, &auditLogID, &createdBy,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.DeviceSnapshot{}, ErrNoSnapshot
	}
	if err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: by audit: %w", err)
	}
	if err := json.Unmarshal(cfgJSON, &out.Config); err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: decode config_json: %w", err)
	}
	out.ConfigHash = hex.EncodeToString(hash)
	out.ParentID = parentID
	out.AuditLogID = auditLogID
	out.CreatedBy = createdBy
	return out, nil
}

// PreviousSnapshotForDevice returns the snapshot for the device immediately
// before the supplied snapshot ID (largest id smaller than beforeID). Used
// by the diff-pointer endpoint to find the "before" half of a captured pair.
func (s *Store) PreviousSnapshotForDevice(ctx context.Context, deviceID string, beforeID int64) (model.DeviceSnapshot, error) {
	var (
		out        model.DeviceSnapshot
		hash       []byte
		cfgJSON    []byte
		parentID   *int64
		auditLogID *int64
		createdBy  *uuid.UUID
	)
	err := s.pool.QueryRow(ctx, `
		SELECT id, device_id, taken_at, source, config_hash, config_json,
		       parent_id, audit_log_id, created_by
		FROM device_snapshots
		WHERE device_id = $1 AND id < $2
		ORDER BY id DESC LIMIT 1
	`, deviceID, beforeID).Scan(
		&out.ID, &out.DeviceID, &out.TakenAt, &out.Source,
		&hash, &cfgJSON, &parentID, &auditLogID, &createdBy,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.DeviceSnapshot{}, ErrNoSnapshot
	}
	if err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: prev: %w", err)
	}
	if err := json.Unmarshal(cfgJSON, &out.Config); err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: decode config_json: %w", err)
	}
	out.ConfigHash = hex.EncodeToString(hash)
	out.ParentID = parentID
	out.AuditLogID = auditLogID
	out.CreatedBy = createdBy
	return out, nil
}
'''


def main(target: str) -> int:
    p = Path(target)
    src = p.read_text()

    if "LinkSnapshotToAudit" in src:
        print("[ ok ] snapshots.go already has Ship 2.5 methods")
        return 0

    # Sanity: required imports must be present (they will be, since these
    # methods reuse the same dependencies as the rest of the file).
    required = ["errors", "fmt", "encoding/json", "encoding/hex", "github.com/jackc/pgx/v5"]
    missing = [imp for imp in required if imp not in src]
    if missing:
        print(f"[warn] snapshots.go may be missing imports needed by Ship 2.5 methods: {missing}", file=sys.stderr)
        print("       go build will tell you for sure.", file=sys.stderr)

    p.write_text(src + ADDITION)
    print("[ ok ] snapshots.go: appended LinkSnapshotToAudit, SnapshotForAuditLog, PreviousSnapshotForDevice")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: patch_store_snapshots.py <path>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
