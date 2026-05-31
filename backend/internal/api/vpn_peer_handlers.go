package api

// VPN peers — HTTP handlers for the fleet-wide peer management
// endpoints. Phase 3A of the VPN object model refactor.
//
// Route layout:
//   GET    /api/v1/vpn/peers          → fleet read (all devices)
//   GET    /api/v1/vpn/peers/{id}     → single peer by UUID
//   DELETE /api/v1/vpn/peers/{id}     → delete (VyOS-first, then metadata)
//
// No POST or PUT in Phase 3A — create and edit redirect to the
// existing device-level IPsec wizard via Commit 3's deep-link
// support. Phase 3B will add inline create/edit if operators ask.
//
// The existing /api/v1/devices/{id}/ipsec/peers/* endpoints continue
// to work alongside these. Same separation as Phase 1:
//   - Device IPsec page → operational view, uses per-device endpoints
//   - VPN section       → management view, uses these endpoints

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/store"
)

// RegisterVPNPeerRoutes attaches the VPN peer endpoints to the router.
// Mounted from RegisterExtras() in extras.go.
func (s *Server) RegisterVPNPeerRoutes(r chi.Router) {
	r.Get("/api/v1/vpn/peers", s.listVPNPeers)
	r.Get("/api/v1/vpn/peers/{id}", s.getVPNPeer)
	r.Delete("/api/v1/vpn/peers/{id}", s.deleteVPNPeer)
}

func (s *Server) listVPNPeers(w http.ResponseWriter, r *http.Request) {
	out, err := s.svc.ListVPNPeers(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if out == nil {
		out = []model.VPNPeer{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) getVPNPeer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	out, err := s.svc.GetVPNPeer(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "vpn peer not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) deleteVPNPeer(w http.ResponseWriter, r *http.Request) {
	// Reuses the existing ipsec.peer.delete RBAC entry — already in
	// the write list per the snippet we verified, so no nat_zones_rbac
	// edit is needed in Phase 3A.
	if !s.requireRole(w, r, "ipsec.peer.delete") {
		return
	}
	id := chi.URLParam(r, "id")
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.DeleteVPNPeer(r.Context(), uid, uname, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "vpn peer not found")
			return
		}
		// Phase 5 will add reference-integrity checks for Tunnel
		// objects, with HTTP 409 as the contracted response. Wired
		// up here so the handler doesn't need re-shaping later.
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
