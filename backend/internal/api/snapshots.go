package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/vyos-cp/vyos-cp/internal/diff"
	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/store"
)

// Snapshot handlers — Ship 1.
//
// Routes:
//   GET  /api/v1/devices/{id}/snapshot       — latest snapshot (full config)
//   GET  /api/v1/devices/{id}/snapshots      — history summaries (no config_json)
//   POST /api/v1/devices/{id}/snapshot       — force a capture now (operator+ when RBAC lands)
//
// Mounted by Server.RegisterSnapshotRoutes() from extras.go.

func (s *Server) getLatestSnapshot(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "id")
	if deviceID == "" {
		http.Error(w, "missing device id", http.StatusBadRequest)
		return
	}

	snap, err := s.svc.Store().LatestSnapshot(r.Context(), deviceID)
	if errors.Is(err, store.ErrNoSnapshot) {
		http.Error(w, "no snapshot yet", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "load snapshot: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) listSnapshots(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "id")
	if deviceID == "" {
		http.Error(w, "missing device id", http.StatusBadRequest)
		return
	}

	limit := 50
	if q := r.URL.Query().Get("limit"); q != "" {
		if n, err := strconv.Atoi(q); err == nil {
			switch {
			case n < 1:
				limit = 1
			case n > 500:
				limit = 500
			default:
				limit = n
			}
		}
	}

	out, err := s.svc.Store().ListSnapshots(r.Context(), deviceID, limit)
	if err != nil {
		http.Error(w, "list snapshots: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if out == nil {
		out = []model.SnapshotSummary{}
	}
	writeJSON(w, http.StatusOK, out)
}

// captureSnapshotNow runs one poller cycle on demand and then returns the
// latest snapshot (which will be the row that cycle just inserted, or the
// existing one if dedup-on-hash kicked in).
//
// Delegating to the poller avoids duplicating the /retrieve + decode + persist
// path in two places. The poller's CaptureSnapshot is intentionally tolerant
// of failures (logs and swallows them) so we still LatestSnapshot after the
// call and surface any underlying failure via ErrNoSnapshot.
func (s *Server) captureSnapshotNow(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "id")
	if deviceID == "" {
		http.Error(w, "missing device id", http.StatusBadRequest)
		return
	}

	s.poller.CaptureSnapshot(r.Context(), deviceID)

	snap, err := s.svc.Store().LatestSnapshot(r.Context(), deviceID)
	if errors.Is(err, store.ErrNoSnapshot) {
		// CaptureSnapshot must have failed (logged inside the poller); we
		// can't bubble that error directly, so surface a clear 502.
		http.Error(w, "capture failed: device unreachable or returned no config",
			http.StatusBadGateway)
		return
	}
	if err != nil {
		http.Error(w, "load snapshot after capture: "+err.Error(),
			http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, snap)
}

// getSnapshotByID returns a specific historical snapshot, including its
// full config. Used by the diff viewer's snapshot picker to load whatever
// the user clicked, not just the most recent.
//
// GET /api/v1/devices/{id}/snapshots/{snapshotId}
func (s *Server) getSnapshotByID(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "id")
	if deviceID == "" {
		http.Error(w, "missing device id", http.StatusBadRequest)
		return
	}
	snapIDStr := chi.URLParam(r, "snapshotId")
	snapID, err := strconv.ParseInt(snapIDStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid snapshot id", http.StatusBadRequest)
		return
	}

	snap, err := s.svc.Store().GetSnapshot(r.Context(), snapID)
	if errors.Is(err, store.ErrNoSnapshot) {
		http.Error(w, "snapshot not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "load snapshot: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// Cheap sanity check: ensure the snapshot actually belongs to the
	// device in the URL. Prevents enumeration across devices via a guessed
	// snapshot ID.
	if snap.DeviceID != deviceID {
		http.Error(w, "snapshot not found for this device", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// computeDiff compares two snapshots and returns the change list.
// `from` is required (a numeric snapshot id). `to` defaults to "latest"
// when omitted, otherwise expects a snapshot id.
//
// GET /api/v1/devices/{id}/diff?from=<id>&to=<id|latest>
func (s *Server) computeDiff(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "id")
	if deviceID == "" {
		http.Error(w, "missing device id", http.StatusBadRequest)
		return
	}

	fromStr := r.URL.Query().Get("from")
	if fromStr == "" {
		http.Error(w, "missing 'from' query parameter", http.StatusBadRequest)
		return
	}
	fromID, err := strconv.ParseInt(fromStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid 'from' id", http.StatusBadRequest)
		return
	}

	fromSnap, err := s.svc.Store().GetSnapshot(r.Context(), fromID)
	if errors.Is(err, store.ErrNoSnapshot) {
		http.Error(w, "'from' snapshot not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "load from snapshot: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if fromSnap.DeviceID != deviceID {
		http.Error(w, "'from' snapshot belongs to a different device", http.StatusBadRequest)
		return
	}

	var toSnap model.DeviceSnapshot
	toStr := r.URL.Query().Get("to")
	if toStr == "" || toStr == "latest" {
		toSnap, err = s.svc.Store().LatestSnapshot(r.Context(), deviceID)
	} else {
		toID, perr := strconv.ParseInt(toStr, 10, 64)
		if perr != nil {
			http.Error(w, "invalid 'to' id", http.StatusBadRequest)
			return
		}
		toSnap, err = s.svc.Store().GetSnapshot(r.Context(), toID)
	}
	if errors.Is(err, store.ErrNoSnapshot) {
		http.Error(w, "'to' snapshot not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "load to snapshot: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if toSnap.DeviceID != deviceID {
		http.Error(w, "'to' snapshot belongs to a different device", http.StatusBadRequest)
		return
	}

	// Diff against the raw VyOS tree (DeviceConfig.Extra), not the
	// translator-modeled fields, so we don't silently miss drift in
	// system settings, services, etc.
	changes := diff.Diff(fromSnap.Config.Extra, toSnap.Config.Extra)

	writeJSON(w, http.StatusOK, map[string]any{
		"from":    fromSnap.ID,
		"to":      toSnap.ID,
		"changes": changes,
	})
}

// RegisterSnapshotRoutes adds the snapshot + diff endpoints to the protected
// router. Called from extras.go::RegisterExtras.
func (s *Server) RegisterSnapshotRoutes(r chi.Router) {
	r.Get("/api/v1/devices/{id}/snapshot", s.getLatestSnapshot)
	r.Get("/api/v1/devices/{id}/snapshots", s.listSnapshots)
	r.Post("/api/v1/devices/{id}/snapshot", s.captureSnapshotNow)
	r.Get("/api/v1/devices/{id}/snapshots/{snapshotId}", s.getSnapshotByID)
	r.Get("/api/v1/devices/{id}/diff", s.computeDiff)
}
