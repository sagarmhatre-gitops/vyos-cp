package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"vyos-cp/internal/model"
	"vyos-cp/internal/store"
)

// Snapshot handlers — Ship 1.
//
// Wire these into the existing router alongside the other /devices/{id}
// routes. Suggested placement in api/router.go:
//
//   r.Route("/devices/{id}", func(r chi.Router) {
//       // ... existing routes ...
//       r.With(requireRole("viewer", "operator", "admin")).
//           Get("/snapshot",  h.getLatestSnapshot)
//       r.With(requireRole("viewer", "operator", "admin")).
//           Get("/snapshots", h.listSnapshots)
//       r.With(requireRole("operator", "admin")).
//           Post("/snapshot", h.captureSnapshotNow)
//   })

// getLatestSnapshot returns the most recent snapshot for the device,
// including the full decoded config_json.
//
// GET /api/v1/devices/{id}/snapshot
// RBAC: viewer, operator, admin
// Responses:
//   200 OK — DeviceSnapshot
//   400 Bad Request — invalid device id
//   404 Not Found — device has no snapshot yet
//   500 Internal Server Error
func (h *Handler) getLatestSnapshot(w http.ResponseWriter, r *http.Request) {
	deviceID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid device id")
		return
	}

	snap, err := h.store.LatestSnapshot(r.Context(), deviceID)
	if errors.Is(err, store.ErrNoSnapshot) {
		writeError(w, http.StatusNotFound, "no snapshot yet for this device")
		return
	}
	if err != nil {
		h.log.Error("getLatestSnapshot", "device", deviceID, "err", err)
		writeError(w, http.StatusInternalServerError, "failed to load snapshot")
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// listSnapshots returns lightweight summaries (no config_json) for a device,
// newest first. Use for the history list / timeline UI.
//
// GET /api/v1/devices/{id}/snapshots?limit=50
// RBAC: viewer, operator, admin
// Responses:
//   200 OK — []SnapshotSummary (may be empty)
//   400 Bad Request — invalid device id
//   500 Internal Server Error
func (h *Handler) listSnapshots(w http.ResponseWriter, r *http.Request) {
	deviceID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid device id")
		return
	}

	// limit: default 50, clamped to [1, 500].
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

	out, err := h.store.ListSnapshots(r.Context(), deviceID, limit)
	if err != nil {
		h.log.Error("listSnapshots", "device", deviceID, "err", err)
		writeError(w, http.StatusInternalServerError, "failed to list snapshots")
		return
	}
	// Always return an array, never null, so the frontend can `.map` safely.
	if out == nil {
		out = []model.SnapshotSummary{}
	}
	writeJSON(w, http.StatusOK, out)
}

// captureSnapshotNow performs a synchronous /retrieve + decode + persist,
// bypassing the poller cadence. Useful for "show me current state" before
// making a change.
//
// POST /api/v1/devices/{id}/snapshot
// RBAC: operator, admin (manual capture is a write-class action — it hits
//       the device and produces an audit-relevant row).
// Responses:
//   201 Created — DeviceSnapshot
//   400 Bad Request — invalid device id
//   404 Not Found — unknown device
//   502 Bad Gateway — VyOS device unreachable or returned an error
//   500 Internal Server Error
func (h *Handler) captureSnapshotNow(w http.ResponseWriter, r *http.Request) {
	deviceID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid device id")
		return
	}

	// Caller identity for the created_by column.
	user, ok := userFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "no user in context")
		return
	}

	dev, err := h.store.GetDevice(r.Context(), deviceID)
	if errors.Is(err, store.ErrDeviceNotFound) {
		writeError(w, http.StatusNotFound, "device not found")
		return
	}
	if err != nil {
		h.log.Error("captureSnapshotNow: GetDevice", "device", deviceID, "err", err)
		writeError(w, http.StatusInternalServerError, "failed to load device")
		return
	}

	client, err := h.pool.For(dev.ID)
	if err != nil {
		writeError(w, http.StatusBadGateway, "device client unavailable")
		return
	}

	raw, err := client.RetrieveAll(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "device retrieve failed: "+err.Error())
		return
	}

	cfg, err := h.translator.Decode(raw)
	if err != nil {
		h.log.Error("captureSnapshotNow: decode", "device", deviceID, "err", err)
		writeError(w, http.StatusInternalServerError, "failed to decode device config")
		return
	}

	snap, err := h.store.AppendSnapshot(r.Context(), model.DeviceSnapshot{
		DeviceID:  dev.ID,
		Source:    model.SourceManual,
		Config:    cfg,
		CreatedBy: &user.ID,
	})
	if err != nil {
		h.log.Error("captureSnapshotNow: AppendSnapshot", "device", deviceID, "err", err)
		writeError(w, http.StatusInternalServerError, "failed to persist snapshot")
		return
	}

	writeJSON(w, http.StatusCreated, snap)
}
