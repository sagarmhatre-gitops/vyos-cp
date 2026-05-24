package service

// Ship 2.5 — snapshot-after-commit hook.
//
// When runConfigure (or runConfigureRedacted) successfully commits to a
// device, this helper fires a follow-up /retrieve and stores the resulting
// config as a snapshot tagged source=control_plane with audit_log_id set
// to the row written in the same code path.
//
// The Audit UI uses this linkage to build "View captured diff" — a click
// from any device-write audit row to the exact before/after pair in the
// Live Config diff viewer.
//
// Dependency direction note: this lives in service/, not poller/, on
// purpose. The poller.go header explicitly documents the layering as
// service -> store; poller -> store; server -> service, poller. Making
// service import poller would invert that hierarchy, so we duplicate the
// ~20 lines of capture-and-persist code rather than crossing the boundary.

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
)

// captureSnapshotAfterCommit reads the device's full config tree and persists
// it as a control_plane-source snapshot linked to the supplied audit row.
//
// All errors are logged and swallowed: a failed snapshot must never undo
// a successful commit or surface as an error to the caller. The audit row
// remains valid; the diff link for that audit row will 404 gracefully.
//
// If the post-commit config happens to hash identically to the previous
// snapshot (rare on a real change, but possible — e.g. a delete-then-set
// that reverts to an earlier state), the dedup logic in AppendSnapshot
// returns the existing row. We then promote that row to control_plane and
// stamp the audit_log_id via LinkSnapshotToAudit so the diff link still
// works.
//
// The `client` parameter is the vyosClient interface used by the rest of
// the service package — we don't use it directly here (we get a fresh
// *vyos.Client from the pool for the Retrieve), but accepting it in the
// signature keeps the call site at runConfigure readable.
func (s *Service) captureSnapshotAfterCommit(ctx context.Context, _ vyosClient, deviceID string, auditID int64) {
	if auditID <= 0 {
		return // no audit row to link to; nothing to do
	}

	// Use a fresh context with its own deadline. We don't want the caller's
	// context cancellation (e.g. request done, client disconnected) to
	// abort the snapshot — the commit already landed on the device.
	cctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Pull a concrete *vyos.Client from the pool (cached).
	realClient, err := s.GetClient(cctx, deviceID)
	if err != nil {
		log.Printf("snapshot-after-commit: get client device=%s audit=%d err=%v", deviceID, auditID, err)
		return
	}

	raw, err := realClient.Retrieve(cctx, vyos.OpShowConfig, []string{})
	if err != nil {
		log.Printf("snapshot-after-commit: retrieve device=%s audit=%d err=%v", deviceID, auditID, err)
		return
	}
	var tree map[string]any
	if err := json.Unmarshal(raw, &tree); err != nil {
		log.Printf("snapshot-after-commit: decode device=%s audit=%d err=%v", deviceID, auditID, err)
		return
	}

	snap := model.DeviceSnapshot{
		DeviceID:   deviceID,
		Source:     model.SourceControlPlane,
		Config:     model.DeviceConfig{Extra: tree},
		AuditLogID: &auditID,
	}
	out, err := s.store.AppendSnapshot(cctx, snap)
	if err != nil {
		log.Printf("snapshot-after-commit: persist device=%s audit=%d err=%v", deviceID, auditID, err)
		return
	}

	// Dedup case: AppendSnapshot returned an existing row that probably has
	// a different source/audit_log_id (it was a poller-tick row). Promote it.
	// LinkSnapshotToAudit is idempotent — safe to call even if it already
	// matches.
	if out.AuditLogID == nil || *out.AuditLogID != auditID || out.Source != model.SourceControlPlane {
		if err := s.store.LinkSnapshotToAudit(cctx, out.ID, auditID); err != nil {
			log.Printf("snapshot-after-commit: link device=%s snap=%d audit=%d err=%v",
				deviceID, out.ID, auditID, err)
		}
	}
}
