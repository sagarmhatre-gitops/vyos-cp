package api

// IPsec API handlers. These slot into extras.go alongside the NAT/Zones
// handlers. The route registrations below should be added to
// RegisterExtras() — kept here as a single appendable block for ease of
// review.

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// RegisterIPsecRoutes is the block to drop into RegisterExtras() right
// after the SNMP routes, e.g.:
//
//	r.Get("/api/v1/devices/{id}/snmp", s.getSNMPConfig)
//	...
//	s.RegisterIPsecRoutes(r)  // <-- add this line
//
// The role names referenced here (ipsec.globals, ipsec.ike.upsert, ...) must
// be added to the `write` slice in nat_zones_rbac.go::RoleAllows so operators
// (not just admins) can mutate IPsec. Viewers can still read.
func (s *Server) RegisterIPsecRoutes(r chi.Router) {
	// Read
	r.Get("/api/v1/devices/{id}/ipsec", s.getIPsecConfig)
	r.Get("/api/v1/devices/{id}/ipsec/status", s.getIPsecStatus)

	// Globals
	r.Put("/api/v1/devices/{id}/ipsec/globals", s.setIPsecGlobals)

	// IKE / ESP groups
	r.Put("/api/v1/devices/{id}/ipsec/ike-groups/{name}", s.upsertIKEGroup)
	r.Delete("/api/v1/devices/{id}/ipsec/ike-groups/{name}", s.deleteIKEGroup)
	r.Put("/api/v1/devices/{id}/ipsec/esp-groups/{name}", s.upsertESPGroup)
	r.Delete("/api/v1/devices/{id}/ipsec/esp-groups/{name}", s.deleteESPGroup)

	// Peers
	r.Put("/api/v1/devices/{id}/ipsec/peers/{name}", s.upsertPeer)
	r.Delete("/api/v1/devices/{id}/ipsec/peers/{name}", s.deletePeer)

	// Tunnel = batched-create endpoint (wizard). Atomic IKE+ESP+peer.
	r.Post("/api/v1/devices/{id}/ipsec/tunnels", s.createTunnel)
}

// --- Read ------------------------------------------------------------------

func (s *Server) getIPsecConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.svc.GetIPsecConfig(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) getIPsecStatus(w http.ResponseWriter, r *http.Request) {
	st, err := s.svc.GetIPsecStatus(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// --- Globals ---------------------------------------------------------------

func (s *Server) setIPsecGlobals(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "ipsec.globals") {
		return
	}
	var g model.IPsecGlobals
	if err := json.NewDecoder(r.Body).Decode(&g); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.SetIPsecGlobals(r.Context(), uid, uname, chi.URLParam(r, "id"), g); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// --- IKE -------------------------------------------------------------------

func (s *Server) upsertIKEGroup(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "ipsec.ike.upsert") {
		return
	}
	var g model.IKEGroup
	if err := json.NewDecoder(r.Body).Decode(&g); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if g.Name == "" {
		g.Name = chi.URLParam(r, "name")
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.UpsertIKEGroup(r.Context(), uid, uname, chi.URLParam(r, "id"), g); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

func (s *Server) deleteIKEGroup(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "ipsec.ike.delete") {
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.DeleteIKEGroup(r.Context(), uid, uname, chi.URLParam(r, "id"), chi.URLParam(r, "name")); err != nil {
		writeVyosErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- ESP -------------------------------------------------------------------

func (s *Server) upsertESPGroup(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "ipsec.esp.upsert") {
		return
	}
	var g model.ESPGroup
	if err := json.NewDecoder(r.Body).Decode(&g); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if g.Name == "" {
		g.Name = chi.URLParam(r, "name")
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.UpsertESPGroup(r.Context(), uid, uname, chi.URLParam(r, "id"), g); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

func (s *Server) deleteESPGroup(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "ipsec.esp.delete") {
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.DeleteESPGroup(r.Context(), uid, uname, chi.URLParam(r, "id"), chi.URLParam(r, "name")); err != nil {
		writeVyosErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Peers -----------------------------------------------------------------

func (s *Server) upsertPeer(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "ipsec.peer.upsert") {
		return
	}
	var p model.Peer
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if p.Name == "" {
		p.Name = chi.URLParam(r, "name")
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.UpsertPeer(r.Context(), uid, uname, chi.URLParam(r, "id"), p); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) deletePeer(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "ipsec.peer.delete") {
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.DeletePeer(r.Context(), uid, uname, chi.URLParam(r, "id"), chi.URLParam(r, "name")); err != nil {
		writeVyosErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// createTunnel is the batched-creation endpoint for the Add Peer wizard.
// Takes IKE + ESP + peer in one body and commits them atomically.
// See service.CreateTunnel for rationale; the handler just unmarshals,
// validates IDs, and delegates.
func (s *Server) createTunnel(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "ipsec.tunnel.create") {
		return
	}
	var body struct {
		IKE  *model.IKEGroup `json:"ike_group,omitempty"`
		ESP  *model.ESPGroup `json:"esp_group,omitempty"`
		Peer model.Peer      `json:"peer"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Peer.Name == "" {
		writeErr(w, http.StatusBadRequest, "peer.name is required")
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.CreateTunnel(r.Context(), uid, uname,
		chi.URLParam(r, "id"), body.IKE, body.ESP, body.Peer); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, body.Peer)
}
