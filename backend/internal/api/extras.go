package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/service"
	"github.com/vyos-cp/vyos-cp/internal/store"
)

// RegisterExtras adds NAT, zones, and user-management routes.
// Called from Router() after the main route block.
func (s *Server) RegisterExtras(r chi.Router) {
	// Snapshots (Ship 1)
	s.RegisterSnapshotRoutes(r)

	r.Get("/api/v1/devices/{id}/nat/{direction}", s.listNATRules)
	r.Post("/api/v1/devices/{id}/nat/{direction}", s.upsertNATRule)
	r.Put("/api/v1/devices/{id}/nat/{direction}/{n}", s.upsertNATRule)
	r.Delete("/api/v1/devices/{id}/nat/{direction}/{n}", s.deleteNATRule)

	r.Get("/api/v1/devices/{id}/zones", s.getZones)
	r.Post("/api/v1/devices/{id}/zones", s.upsertZone)
	r.Post("/api/v1/devices/{id}/zones/policy", s.setZonePolicy)

	r.Get("/api/v1/devices/{id}/interfaces", s.listInterfaces)
	r.Put("/api/v1/devices/{id}/interfaces/{kind}/{name}", s.upsertInterface)

	r.Get("/api/v1/devices/{id}/firewall/groups", s.listGroups)

	r.Get("/api/v1/devices/{id}/throughput", s.deviceThroughput)
	r.Get("/api/v1/devices/{id}/throughput/history", s.deviceThroughputHistory)
	r.Get("/api/v1/fleet/throughput", s.fleetThroughput)
	r.Get("/api/v1/fleet/throughput/history", s.fleetThroughputHistory)

	r.Get("/api/v1/devices/{id}/usage", s.deviceUsage)

	r.Get("/api/v1/devices/{id}/flows", s.deviceFlows)

	// QoS
	r.Get("/api/v1/devices/{id}/qos/policies", s.listTrafficPolicies)
	r.Put("/api/v1/devices/{id}/qos/policies/{name}", s.upsertTrafficPolicy)
	r.Delete("/api/v1/devices/{id}/qos/policies/{engine}/{name}", s.deleteTrafficPolicy)
	r.Post("/api/v1/devices/{id}/qos/bind", s.bindTrafficPolicy)
	r.Post("/api/v1/devices/{id}/qos/unbind", s.unbindTrafficPolicy)
	r.Get("/api/v1/devices/{id}/qos/bindings", s.listTrafficPolicyBindings)
	r.Post("/api/v1/devices/{id}/qos/cleanup", s.cleanupQoSOrphans)

	// Quick actions — operator-essential one-click ops on a device.
	// Reboot is destructive (must be confirmed in UI), backup is read-only
	// and downloads as text.
	//
	// NOTE: Ping and traceroute are intentionally NOT exposed here. VyOS's
	// HTTP API does not surface them — the /show endpoint accepts only
	// op="show", and ping/traceroute are top-level op-mode commands with
	// no dedicated API endpoint (confirmed via VyOS T1868 + 1.4/1.5 docs).
	// To add them properly we'd need an SSH-based code path with separate
	// credential management; deferred to a later phase.
	r.Post("/api/v1/devices/{id}/reboot", s.rebootDevice)
	r.Get("/api/v1/devices/{id}/backup", s.backupConfig)

	// Global search — fan-out across devices, users, and (future) groups,
	// rule-sets, zones. Backs the topbar ⌘K search.
	r.Get("/api/v1/search", s.search)

	// Fleet-wide health rollup — backs the dashboard donut + critical/warning
	// alert tiles. Single endpoint computes the buckets server-side so the
	// dashboard doesn't have to download every device's metrics.
	r.Get("/api/v1/fleet/health", s.getFleetHealth)

	// Device overview — single endpoint for the per-device dashboard.
	r.Get("/api/v1/devices/{id}/overview", s.getDeviceOverview)

	// Device metrics history — backs the CPU sparkline on the Overview tab.
	// Query params: from (RFC3339), to (RFC3339). Defaults: from = -1h, to = now.
	r.Get("/api/v1/devices/{id}/metrics", s.deviceMetricsHistory)

	// SNMP
	r.Get("/api/v1/devices/{id}/snmp", s.getSNMPConfig)
	r.Put("/api/v1/devices/{id}/snmp", s.upsertSNMPConfig)
	r.Delete("/api/v1/devices/{id}/snmp", s.deleteSNMPConfig)

	// IPsec (site-to-site VPN)
	s.RegisterIPsecRoutes(r)
	s.RegisterVPNRoutes(r)
	s.RegisterVPNPeerRoutes(r)

	// Device tags (minimal endpoint for the production-marker toggle)
	r.Put("/api/v1/devices/{id}/tags", s.updateDeviceTags)

	// Device edit (address, hostname, api key, tls verify)
	r.Put("/api/v1/devices/{id}", s.updateDevice)

	// Completeness: deletes
	r.Delete("/api/v1/devices/{id}/firewall/{family}/name/{name}", s.deleteRuleSet)
	r.Delete("/api/v1/devices/{id}/firewall/groups/{kind}/{name}", s.deleteGroup)
	r.Delete("/api/v1/devices/{id}/zones/{name}", s.deleteZoneFull)

	// User management
	r.Get("/api/v1/users", s.listUsers)
	r.Post("/api/v1/users", s.createUser)
	r.Put("/api/v1/users/{id}", s.updateUser)
	r.Delete("/api/v1/users/{id}", s.deleteUser)
}

// --- NAT -------------------------------------------------------------------

func (s *Server) listNATRules(w http.ResponseWriter, r *http.Request) {
	dir := model.NATDirection(chi.URLParam(r, "direction"))
	if dir != model.NATSource && dir != model.NATDestination {
		writeErr(w, http.StatusBadRequest, "direction must be source or destination")
		return
	}
	rules, err := s.svc.ListNATRules(r.Context(), chi.URLParam(r, "id"), dir)
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rules)
}

func (s *Server) upsertNATRule(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "nat.upsert") {
		return
	}
	var rule model.NATRule
	if err := json.NewDecoder(r.Body).Decode(&rule); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	rule.Direction = model.NATDirection(chi.URLParam(r, "direction"))
	if n := chi.URLParam(r, "n"); n != "" {
		num, err := strconv.Atoi(n)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad rule number")
			return
		}
		rule.Number = num
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.UpsertNATRule(r.Context(), uid, uname, chi.URLParam(r, "id"), rule); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rule)
}

func (s *Server) deleteNATRule(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "nat.delete") {
		return
	}
	n, err := strconv.Atoi(chi.URLParam(r, "n"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad rule number")
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.DeleteNATRule(r.Context(), uid, uname,
		chi.URLParam(r, "id"),
		model.NATDirection(chi.URLParam(r, "direction")), n); err != nil {
		writeVyosErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Zones -----------------------------------------------------------------

func (s *Server) getZones(w http.ResponseWriter, r *http.Request) {
	zc, err := s.svc.GetZones(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, zc)
}

func (s *Server) upsertZone(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "zone.upsert") {
		return
	}
	var z model.Zone
	if err := json.NewDecoder(r.Body).Decode(&z); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.UpsertZone(r.Context(), uid, uname, chi.URLParam(r, "id"), z); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, z)
}

func (s *Server) setZonePolicy(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "zone.policy") {
		return
	}
	var p model.ZonePolicy
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.SetZonePolicy(r.Context(), uid, uname, chi.URLParam(r, "id"), p); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// --- Users -----------------------------------------------------------------

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "user.list") {
		return
	}
	users, err := s.svc.Store().ListUsers(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "user.create") {
		return
	}
	var body struct {
		Email       string       `json:"email"`
		DisplayName string       `json:"display_name"`
		Password    string       `json:"password"`
		Roles       []model.Role `json:"roles"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.Password) < 8 {
		writeErr(w, http.StatusBadRequest, "password must be at least 8 chars")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	u, err := s.svc.Store().CreateUser(r.Context(), model.User{
		Email: body.Email, DisplayName: body.DisplayName, Roles: body.Roles,
	}, string(hash))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

// --- RBAC helper -----------------------------------------------------------

// requireRole returns false and writes 403 if the caller lacks the action.
func (s *Server) requireRole(w http.ResponseWriter, r *http.Request, action string) bool {
	token := extractBearer(r)
	claims, err := s.parseJWT(token)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid token")
		return false
	}
	var roleStrings []string
	if rs, ok := claims["roles"].([]any); ok {
		for _, r := range rs {
			if s, ok := r.(string); ok {
				roleStrings = append(roleStrings, s)
			}
		}
	}
	if !service.RoleAllows(roleStrings, action) {
		writeErr(w, http.StatusForbidden, "insufficient permissions")
		return false
	}
	return true
}

// --- Interfaces ------------------------------------------------------------

func (s *Server) listInterfaces(w http.ResponseWriter, r *http.Request) {
	ifaces, err := s.svc.ListInterfaces(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ifaces)
}

func (s *Server) upsertInterface(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "interface.upsert") {
		return
	}
	var iface model.Interface
	if err := json.NewDecoder(r.Body).Decode(&iface); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	iface.Kind = chi.URLParam(r, "kind")
	iface.Name = chi.URLParam(r, "name")
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.UpsertInterface(r.Context(), uid, uname, chi.URLParam(r, "id"), iface); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, iface)
}

// --- Groups list -----------------------------------------------------------

func (s *Server) listGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := s.svc.ListGroups(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

// --- Throughput ------------------------------------------------------------

func (s *Server) deviceThroughput(w http.ResponseWriter, r *http.Request) {
	hist := s.poller.Thru.History(chi.URLParam(r, "id"))
	writeJSON(w, http.StatusOK, hist)
}

func (s *Server) fleetThroughput(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.poller.Thru.AggregateLatest())
}

// --- Throughput history (Postgres-backed) ----------------------------------

func parseHours(r *http.Request, def float64) time.Duration {
	s := r.URL.Query().Get("hours")
	if s == "" {
		return time.Duration(def * float64(time.Hour))
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f <= 0 || f > 24*30 {
		return time.Duration(def * float64(time.Hour))
	}
	return time.Duration(f * float64(time.Hour))
}

func (s *Server) deviceThroughputHistory(w http.ResponseWriter, r *http.Request) {
	window := parseHours(r, 24)
	rows, err := s.svc.Store().ThroughputRange(r.Context(),
		chi.URLParam(r, "id"), time.Now().Add(-window))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (s *Server) fleetThroughputHistory(w http.ResponseWriter, r *http.Request) {
	window := parseHours(r, 24)
	rows, err := s.svc.Store().FleetThroughputRange(r.Context(), time.Now().Add(-window))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// --- QoS -------------------------------------------------------------------

func (s *Server) listTrafficPolicies(w http.ResponseWriter, r *http.Request) {
	list, err := s.svc.ListTrafficPolicies(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) upsertTrafficPolicy(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "qos.upsert") {
		return
	}
	var p model.TrafficPolicy
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	p.Name = chi.URLParam(r, "name")
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.UpsertTrafficPolicy(r.Context(), uid, uname, chi.URLParam(r, "id"), p); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) deleteTrafficPolicy(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "qos.delete") {
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.DeleteTrafficPolicy(r.Context(), uid, uname,
		chi.URLParam(r, "id"),
		model.QoSEngine(chi.URLParam(r, "engine")),
		chi.URLParam(r, "name")); err != nil {
		writeVyosErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) bindTrafficPolicy(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "qos.bind") {
		return
	}
	var b model.TrafficPolicyBinding
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.BindTrafficPolicy(r.Context(), uid, uname, chi.URLParam(r, "id"), b); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, b)
}

func (s *Server) unbindTrafficPolicy(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "qos.bind") {
		return
	}
	var b model.TrafficPolicyBinding
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.UnbindTrafficPolicy(r.Context(), uid, uname, chi.URLParam(r, "id"), b); err != nil {
		writeVyosErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- SNMP ------------------------------------------------------------------

func (s *Server) getSNMPConfig(w http.ResponseWriter, r *http.Request) {
	c, err := s.svc.GetSNMPConfig(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) upsertSNMPConfig(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "snmp.upsert") {
		return
	}
	var c model.SNMPConfig
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.UpsertSNMPConfig(r.Context(), uid, uname, chi.URLParam(r, "id"), c); err != nil {
		// v2c-on-production violations come back as a sentinel error so we
		// can map them to 409 Conflict instead of a generic 500.
		if isV2CBlockedErr(err) {
			writeErr(w, http.StatusConflict, err.Error())
			return
		}
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) deleteSNMPConfig(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "snmp.delete") {
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.DeleteSNMPConfig(r.Context(), uid, uname, chi.URLParam(r, "id")); err != nil {
		writeVyosErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func isV2CBlockedErr(err error) bool {
	return err != nil && (err == service.ErrV2CBlocked ||
		(err.Error() != "" && contains(err.Error(), "snmpv2c is not permitted")))
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && indexOf(s, sub) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// updateDeviceTags replaces the device.tags array. Used by the production
// marker toggle. Requires write role.
func (s *Server) updateDeviceTags(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "device.add") {
		return
	}
	var body struct {
		Tags []string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.svc.Store().UpdateDeviceTags(r.Context(), chi.URLParam(r, "id"), body.Tags); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	d, _ := s.svc.Store().GetDevice(r.Context(), chi.URLParam(r, "id"))
	writeJSON(w, http.StatusOK, d)
}

// --- Completeness handlers -------------------------------------------------

func (s *Server) deleteRuleSet(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "rule.delete") {
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.DeleteRuleSet(r.Context(), uid, uname,
		chi.URLParam(r, "id"), chi.URLParam(r, "family"), chi.URLParam(r, "name")); err != nil {
		writeVyosErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteGroup(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "group.upsert") {
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.DeleteGroup(r.Context(), uid, uname,
		chi.URLParam(r, "id"), chi.URLParam(r, "kind"), chi.URLParam(r, "name")); err != nil {
		writeVyosErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteZoneFull(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "zone.upsert") {
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.DeleteZoneFull(r.Context(), uid, uname,
		chi.URLParam(r, "id"), chi.URLParam(r, "name")); err != nil {
		writeVyosErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) updateDevice(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "device.update") {
		return
	}
	// Pointer fields so omitted JSON keys stay nil (= "don't change").
	var body struct {
		Name               *string   `json:"name,omitempty"`
		Address            *string   `json:"address,omitempty"`
		Hostname           *string   `json:"hostname,omitempty"`
		APIKey             *string   `json:"api_key,omitempty"`
		InsecureSkipVerify *bool     `json:"insecure_skip_verify,omitempty"`
		Tags               *[]string `json:"tags,omitempty"`
		Location           *string   `json:"location,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.UpdateDevice(r.Context(), uid, uname, chi.URLParam(r, "id"),
		service.DeviceUpdate{
			Name:               body.Name,
			Address:            body.Address,
			Hostname:           body.Hostname,
			APIKey:             body.APIKey,
			InsecureSkipVerify: body.InsecureSkipVerify,
			Tags:               body.Tags,
			Location:           body.Location,
		}); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	out, _ := s.svc.Store().GetDevice(r.Context(), chi.URLParam(r, "id"))
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "user.create") {
		return
	}
	var body struct {
		Name     string       `json:"name"`
		Password string       `json:"password"`
		Roles    []model.Role `json:"roles"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	// Guard: don't let the last admin demote themselves to non-admin.
	hasAdmin := false
	for _, ro := range body.Roles {
		if ro == "admin" {
			hasAdmin = true
			break
		}
	}
	if !hasAdmin {
		n, _ := s.svc.Store().CountAdmins(r.Context())
		if n <= 1 {
			writeErr(w, http.StatusConflict, "refusing to demote last admin")
			return
		}
	}
	rolesStr := make([]string, len(body.Roles))
	for i, ro := range body.Roles {
		rolesStr[i] = string(ro)
	}
	var hash string
	if body.Password != "" {
		if len(body.Password) < 8 {
			writeErr(w, http.StatusBadRequest, "password must be at least 8 chars")
			return
		}
		h, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		hash = string(h)
	}
	if err := s.svc.Store().UpdateUser(r.Context(), chi.URLParam(r, "id"), body.Name, rolesStr, hash); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "user.create") {
		return
	}
	targetID := chi.URLParam(r, "id")
	callerID, _ := userFromCtx(r.Context())
	if callerID == targetID {
		writeErr(w, http.StatusConflict, "cannot delete your own account")
		return
	}
	// Guard: don't let the last admin be deleted.
	users, _ := s.svc.Store().ListUsers(r.Context())
	for _, u := range users {
		if u.ID == targetID {
			for _, ro := range u.Roles {
				if ro == "admin" {
					n, _ := s.svc.Store().CountAdmins(r.Context())
					if n <= 1 {
						writeErr(w, http.StatusConflict, "refusing to delete last admin")
						return
					}
				}
			}
		}
	}
	if err := s.svc.Store().DeleteUser(r.Context(), targetID); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listTrafficPolicyBindings(w http.ResponseWriter, r *http.Request) {
	list, err := s.svc.ListTrafficPolicyBindings(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) getDeviceOverview(w http.ResponseWriter, r *http.Request) {
	ov, err := s.svc.GetDeviceOverview(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ov)
}

func (s *Server) cleanupQoSOrphans(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "qos.bind") {
		return
	}
	uid, uname := userFromCtx(r.Context())
	n, err := s.svc.CleanupOrphanedIFBs(r.Context(), uid, uname, chi.URLParam(r, "id"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"cleaned": n})
}

// search backs the topbar ⌘K search dropdown. The query comes via ?q=.
// Empty query returns an empty array (not an error) so the UI can clear
// the dropdown without a refetch.
func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	hits, err := s.svc.Search(r.Context(), q)
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	if hits == nil {
		hits = []service.SearchHit{} // never nil over the wire
	}
	writeJSON(w, http.StatusOK, hits)
}

// --- Quick actions ---------------------------------------------------------
//
// Ping/traceroute were attempted here in v23/v27 but VyOS's HTTP API doesn't
// expose them (the /show endpoint only accepts op="show", and ping/traceroute
// are top-level op-mode commands with no API counterpart). The handlers and
// service methods were removed in v28. To add them back properly, we'd need
// an SSH-based code path — separate credential management, separate failure
// modes — which is its own phase.


// rebootDevice triggers a reboot. Gated by an explicit confirmation header
// so a misclick or replay can't fire it; the UI sends X-Confirm-Device
// with the device's current name as a typed challenge.
func (s *Server) rebootDevice(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "device.reboot") {
		return
	}
	id := chi.URLParam(r, "id")
	dev, err := s.svc.Store().GetDevice(r.Context(), id)
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	confirm := r.Header.Get("X-Confirm-Device")
	if confirm != dev.Name {
		writeJSON(w, http.StatusPreconditionFailed,
			map[string]string{"error": "confirmation mismatch; type the device name to proceed"})
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.RebootDevice(r.Context(), uid, uname, id); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "reboot queued"})
}

// backupConfig returns the running config as a downloadable text file.
// Content-Disposition makes the browser save it instead of rendering.
func (s *Server) backupConfig(w http.ResponseWriter, r *http.Request) {
	uid, uname := userFromCtx(r.Context())
	id := chi.URLParam(r, "id")
	raw, err := s.svc.BackupConfig(r.Context(), uid, uname, id)
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	dev, _ := s.svc.Store().GetDevice(r.Context(), id)
	name := "device"
	if dev != nil && dev.Name != "" {
		name = dev.Name
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s-config.txt"`, name))
	_, _ = w.Write([]byte(raw))
}

// deviceMetricsHistory returns CPU/memory/session samples for a device
// over a time window. Default window is the last hour.
func (s *Server) deviceMetricsHistory(w http.ResponseWriter, r *http.Request) {
	to := time.Now()
	from := to.Add(-1 * time.Hour)

	if v := r.URL.Query().Get("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			from = t
		}
	}
	if v := r.URL.Query().Get("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			to = t
		}
	}
	// Hard cap the window at 30 days to match retention. Prevents a "from=
	// year-2000" request from scanning the index pointlessly.
	if to.Sub(from) > 30*24*time.Hour {
		from = to.Add(-30 * 24 * time.Hour)
	}

	rows, err := s.svc.DeviceMetricsRange(r.Context(), chi.URLParam(r, "id"), from, to)
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	if rows == nil {
		rows = []store.DeviceMetricSample{} // never nil over the wire
	}
	writeJSON(w, http.StatusOK, rows)
}

// getFleetHealth returns fleet-wide health buckets for the dashboard.
// Cheap (one ListDevices + N indexed LIMIT 1 lookups), but cached briefly
// at the dashboard refetch interval so re-renders don't hammer the DB.
func (s *Server) getFleetHealth(w http.ResponseWriter, r *http.Request) {
	h, err := s.svc.GetFleetHealth(r.Context())
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h)
}
