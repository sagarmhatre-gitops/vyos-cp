package simulation_test

import (
	"testing"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/simulation"
)

func rule(num int, action model.Action, proto, srcAddr, dstAddr, dstPort string,
	st *model.State, srcGeo []string) model.Rule {
	r := model.Rule{
		Number:          num,
		Action:          action,
		Protocol:        proto,
		State:           st,
		SourceCountries: srcGeo,
	}
	if srcAddr != "" {
		r.Source = &model.AddrSpec{Address: srcAddr}
	}
	if dstAddr != "" || dstPort != "" {
		r.Destination = &model.AddrSpec{Address: dstAddr, Port: dstPort}
	}
	return r
}

var testRules = []model.Rule{
	rule(1, model.ActionAccept, "all", "", "", "", &model.State{Established: true, Related: true}, nil),
	rule(5, model.ActionDrop, "all", "", "", "", nil, []string{"CN", "RU"}),
	rule(10, model.ActionAccept, "udp", "", "", "53", nil, nil),
	rule(12, model.ActionAccept, "tcp", "0.0.0.0/0", "", "", nil, nil),
	rule(17, model.ActionAccept, "tcp", "0.0.0.0/0", "142.79.253.233/32", "443", nil, []string{"CN", "RU"}),
	rule(25, model.ActionDrop, "all", "", "", "", nil, nil),
}

func TestSimulation_MatchesRule12(t *testing.T) {
	pkt := simulation.Packet{
		SrcIP: "8.8.8.8", DstIP: "142.79.253.233",
		Proto: "tcp", DstPort: 443, State: "new",
	}
	res := simulation.NewEngine(testRules).RunSimulation(pkt)

	if !res.Matched {
		t.Fatal("expected a match")
	}
	if res.MatchedRule.Number != 12 {
		t.Fatalf("expected rule 12 to match first, got %d", res.MatchedRule.Number)
	}
	if res.FinalAction != "accept" {
		t.Fatalf("expected accept, got %s", res.FinalAction)
	}
}

func TestSimulation_Rule17Shadowed(t *testing.T) {
	findings := simulation.NewEngine(testRules).AnalyzeRuleSet()

	shadowed := false
	for _, f := range findings {
		if f.Code == "shadowed" && f.RuleNum == 17 && f.RelatedNum == 12 {
			shadowed = true
		}
	}
	if !shadowed {
		t.Error("expected rule 17 to be detected as shadowed by rule 12")
	}
}

func TestTranslateRule_DeleteThenSet(t *testing.T) {
	r := rule(17, model.ActionAccept, "tcp", "0.0.0.0/0", "142.79.253.233/32", "443",
		&model.State{New: true, Established: true}, []string{"CN", "RU"})
	r.Description = "Allow HTTPS from trusted"

	ops := simulation.TranslateRule("inside_to_mgmt", r)
	if len(ops) < 2 {
		t.Fatalf("expected at least 2 ops, got %d", len(ops))
	}
	if ops[0].Op != "delete" {
		t.Errorf("first op must be delete, got %s", ops[0].Op)
	}
}

func TestSimulation_NoMatchFallthrough(t *testing.T) {
	rules := []model.Rule{
		rule(10, model.ActionAccept, "tcp", "", "", "80", nil, nil),
	}
	pkt := simulation.Packet{Proto: "udp", DstPort: 9000}
	res := simulation.NewEngine(rules).RunSimulation(pkt)
	if res.Matched {
		t.Error("should not match")
	}
}

func TestPortMatches_RangeAndList(t *testing.T) {
	rules := []model.Rule{
		rule(10, model.ActionAccept, "tcp", "", "", "1000-2000", nil, nil),
	}
	hit := simulation.NewEngine(rules).RunSimulation(simulation.Packet{Proto: "tcp", DstPort: 1500})
	if !hit.Matched {
		t.Error("expected port 1500 to match range 1000-2000")
	}
	miss := simulation.NewEngine(rules).RunSimulation(simulation.Packet{Proto: "tcp", DstPort: 3000})
	if miss.Matched {
		t.Error("expected port 3000 to miss range 1000-2000")
	}
}
// ── Append these tests to engine_test.go ──

func TestRisk_GroupScopedSourceNotExposed(t *testing.T) {
	// Rule 3001: tcp port 22, source = address-group "neysa-trusted".
	// Must NOT be flagged as "exposed management port" — source is restricted.
	r := model.Rule{
		Number:   3001,
		Action:   model.ActionAccept,
		Protocol: "tcp",
		Source:   &model.AddrSpec{Group: &model.GroupRef{AddressGroup: "neysa-trusted"}},
		Destination: &model.AddrSpec{Address: "10.10.0.10", Port: "22"},
	}
	findings := simulation.NewEngine([]model.Rule{r}).AnalyzeRuleSet()
	for _, f := range findings {
		if f.Code == "exposed_mgmt" {
			t.Errorf("group-scoped source should not be flagged as exposed mgmt port; got: %s", f.Detail)
		}
	}
}

func TestRisk_BareAnySourcePortIsExposed(t *testing.T) {
	// Same port 22 but truly from any source — SHOULD be flagged.
	r := model.Rule{
		Number:      99,
		Action:      model.ActionAccept,
		Protocol:    "tcp",
		Destination: &model.AddrSpec{Port: "22"},
	}
	findings := simulation.NewEngine([]model.Rule{r}).AnalyzeRuleSet()
	hit := false
	for _, f := range findings {
		if f.Code == "exposed_mgmt" {
			hit = true
		}
	}
	if !hit {
		t.Error("port 22 from any source should be flagged as exposed mgmt port")
	}
}

func TestShadow_GroupScopedRuleDoesNotShadow(t *testing.T) {
	// A group-scoped accept must not shadow a later rule.
	rules := []model.Rule{
		{Number: 1, Action: model.ActionAccept, Protocol: "tcp",
			Source: &model.AddrSpec{Group: &model.GroupRef{AddressGroup: "trusted"}}},
		{Number: 2, Action: model.ActionAccept, Protocol: "tcp",
			Destination: &model.AddrSpec{Address: "10.0.0.5/32", Port: "443"}},
	}
	for _, f := range simulation.NewEngine(rules).AnalyzeRuleSet() {
		if f.Code == "shadowed" && f.RuleNum == 2 {
			t.Error("group-scoped rule 1 must not shadow rule 2")
		}
	}
}
