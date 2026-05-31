package api

// VPN profiles — HTTP handlers for the fleet-wide profile management
// endpoints. Phase 1 of the VPN object model refactor.
//
// Route layout:
//   GET    /api/v1/vpn/profiles          → fleet read (both types)
//   GET    /api/v1/vpn/profiles/{id}     → single profile by UUID
//   POST   /api/v1/vpn/profiles          → create (body specifies type)
//   PUT    /api/v1/vpn/profiles/{id}     → full replace (VyOS + metadata)
//   DELETE /api/v1/vpn/profiles/{id}     → delete (refuses if used by peers)
//
// The existing /api/v1/devices/{id}/ipsec/ike-groups/* and esp-groups/*
// endpoints continue to work alongside these. Per the design doc:
//   - Device IPsec page → operational view, uses per-device endpoints
//   - VPN section       → management view, uses these endpoints

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/store"
)

// RegisterVPNRoutes attaches the VPN profile endpoints to the router.
// Mounted from RegisterExtras() in extras.go.
func (s *Server) RegisterVPNRoutes(r chi.Router) {
	r.Get("/api/v1/vpn/profiles", s.listVPNProfiles)
	r.Get("/api/v1/vpn/profiles/{id}", s.getVPNProfile)
	r.Post("/api/v1/vpn/profiles", s.createVPNProfile)
	r.Put("/api/v1/vpn/profiles/{id}", s.updateVPNProfile)
	r.Delete("/api/v1/vpn/profiles/{id}", s.deleteVPNProfile)
}

func (s *Server) listVPNProfiles(w http.ResponseWriter, r *http.Request) {
	out, err := s.svc.ListVPNProfiles(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if out == nil {
		out = []model.VPNProfile{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) getVPNProfile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	p, err := s.svc.GetVPNProfile(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "vpn profile not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) createVPNProfile(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "vpn.profile.upsert") {
		return
	}
	var req model.VPNProfileCreate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, uname := userFromCtx(r.Context())
	p, err := s.svc.CreateVPNProfile(r.Context(), uid, uname, req)
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) updateVPNProfile(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "vpn.profile.upsert") {
		return
	}
	id := chi.URLParam(r, "id")
	var req model.VPNProfileUpdate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, uname := userFromCtx(r.Context())
	p, err := s.svc.UpdateVPNProfile(r.Context(), uid, uname, id, req)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "vpn profile not found")
			return
		}
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) deleteVPNProfile(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "vpn.profile.delete") {
		return
	}
	id := chi.URLParam(r, "id")
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.DeleteVPNProfile(r.Context(), uid, uname, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "vpn profile not found")
			return
		}
		// Reference-integrity conflict — the profile is still used by a
		// peer. HTTP 409 communicates this cleanly to UIs and curl users;
		// 500 implies a server bug, which this is not.
		if strings.Contains(err.Error(), "still referenced by peer") {
			writeErr(w, http.StatusConflict, err.Error())
			return
		}
		writeVyosErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
