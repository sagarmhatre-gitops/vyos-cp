package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/simulation"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
	"github.com/vyos-cp/vyos-cp/internal/vyos/translator"
)

// simulatePacket evaluates a packet against a device's live rule-set in exact
// execution order and returns the first matching rule plus a full trace.
//
// POST /api/v1/devices/{id}/firewall/{family}/rulesets/{name}/simulate
// Body: simulation.Packet
func (s *Server) simulatePacket(w http.ResponseWriter, r *http.Request) {
	var pkt simulation.Packet
	if err := json.NewDecoder(r.Body).Decode(&pkt); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	rs, err := s.svc.GetRuleSet(r.Context(),
		chi.URLParam(r, "id"), chi.URLParam(r, "family"), chi.URLParam(r, "name"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}

	eng := simulation.NewEngine(rs.Rules)
	result := eng.RunSimulation(pkt)
	writeJSON(w, http.StatusOK, result)
}

// shadowAnalysis runs shadow + risk detection across a device's live rule-set.
//
// GET /api/v1/devices/{id}/firewall/{family}/rulesets/{name}/shadow
func (s *Server) shadowAnalysis(w http.ResponseWriter, r *http.Request) {
	rs, err := s.svc.GetRuleSet(r.Context(),
		chi.URLParam(r, "id"), chi.URLParam(r, "family"), chi.URLParam(r, "name"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}

	eng := simulation.NewEngine(rs.Rules)
	findings := eng.AnalyzeRuleSet()
	writeJSON(w, http.StatusOK, map[string]any{
		"ruleset":  rs.Name,
		"family":   rs.Family,
		"findings": findings,
		"count":    len(findings),
	})
}

// translatePreview returns the VyOS /configure ops for a candidate rule without
// committing — lets the UI show the generated config before saving.
//
// POST /api/v1/devices/{id}/firewall/{family}/rulesets/{name}/translate-preview
// Body: model.Rule
//
// Returns the atomic op array UpsertRule would commit, the equivalent VyOS
// configuration-mode CLI lines, and metadata. Does not contact the device,
// does not write to audit, does not commit. Validation errors return 400.
func (s *Server) translatePreview(w http.ResponseWriter, r *http.Request) {
	var rule model.Rule
	if err := json.NewDecoder(r.Body).Decode(&rule); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	family := chi.URLParam(r, "family")
	ruleset := chi.URLParam(r, "name")

	// Use the real translator — same code path as UpsertRule — so the preview
	// matches what gets committed. The previous simulation.TranslateRule helper
	// missed log/disable/jump-target/source.port/group refs/multi-country fields
	// and emitted "value: enable" on state flags that VyOS expects bare.
	newOps, err := translator.RuleOps(family, ruleset, rule)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ops := append(translator.DeleteRuleOps(family, ruleset, rule.Number), newOps...)

	writeJSON(w, http.StatusOK, map[string]any{
		"ruleset": ruleset,
		"family":  family,
		"ops":     ops,
		"count":   len(ops),
		"cli":     vyos.OpsToCLI(ops),
	})
}
