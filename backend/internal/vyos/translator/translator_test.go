package translator_test

import (
	"encoding/json"
	"testing"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
	"github.com/vyos-cp/vyos-cp/internal/vyos/translator"
)

// TestRuleOps_PathIsolation guards the subtle slice-aliasing bug where a
// later append() would overwrite the tail of an earlier op's Path.
func TestRuleOps_PathIsolation(t *testing.T) {
	ops, err := translator.RuleOps("ipv4", "WAN-IN", model.Rule{
		Number: 10, Action: model.ActionAccept, Protocol: "tcp",
		Destination: &model.AddrSpec{Port: "443"},
	})
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]int{}
	for _, op := range ops {
		last := op.Path[len(op.Path)-1]
		seen[last]++
	}
	// Every leaf should be unique — a duplicate means paths aliased.
	for leaf, n := range seen {
		if n > 1 {
			t.Errorf("leaf %q appears %d times — paths are aliased", leaf, n)
		}
	}
}

func TestRuleOps_JumpRequiresTarget(t *testing.T) {
	_, err := translator.RuleOps("ipv4", "WAN-IN", model.Rule{
		Number: 10, Action: model.ActionJump,
	})
	if err == nil {
		t.Error("expected error for jump without target")
	}
}

func TestRuleOps_StateFlags(t *testing.T) {
	ops, err := translator.RuleOps("ipv4", "WAN-IN", model.Rule{
		Number: 10, Action: model.ActionAccept,
		State: &model.State{Established: true, Related: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"established": false, "related": false}
	for _, op := range ops {
		if len(op.Path) < 2 {
			continue
		}
		last := op.Path[len(op.Path)-1]
		prev := op.Path[len(op.Path)-2]
		if prev == "state" {
			if _, ok := want[last]; ok {
				want[last] = true
			}
		}
	}
	for k, seen := range want {
		if !seen {
			t.Errorf("missing state flag: %s", k)
		}
	}
}

func TestDecode_RuleSet(t *testing.T) {
	raw := json.RawMessage(`{
		"default-action": "drop",
		"description": "main WAN ingress",
		"rule": {
			"10": {
				"action": "accept",
				"state": {"established": {}, "related": {}}
			},
			"30": {
				"action": "accept",
				"protocol": "tcp",
				"destination": {"port": "443"},
				"source": {"group": {"address-group": "trusted-admins"}},
				"log": {}
			},
			"50": {
				"action": "drop",
				"source": {"geoip": {"country-code": ["CN", "RU", "KP"]}},
				"log": {}
			}
		}
	}`)
	rs, err := translator.DecodeRuleSet("ipv4", "WAN-IN", raw)
	if err != nil {
		t.Fatal(err)
	}
	if rs.DefaultAction != model.ActionDrop {
		t.Errorf("default action: got %q", rs.DefaultAction)
	}
	if len(rs.Rules) != 3 {
		t.Fatalf("rule count: got %d want 3", len(rs.Rules))
	}
	if rs.Rules[0].Number != 10 || rs.Rules[2].Number != 50 {
		t.Errorf("rules not sorted: %v", []int{rs.Rules[0].Number, rs.Rules[2].Number})
	}
	if !rs.Rules[0].State.Established || !rs.Rules[0].State.Related {
		t.Error("state flags not decoded")
	}
	if rs.Rules[1].Source == nil || rs.Rules[1].Source.Group == nil ||
		rs.Rules[1].Source.Group.AddressGroup != "trusted-admins" {
		t.Errorf("group ref not decoded: %+v", rs.Rules[1].Source)
	}
	if !rs.Rules[1].Log {
		t.Error("log flag not decoded")
	}
	if got := rs.Rules[2].SourceCountries; len(got) != 3 || got[0] != "CN" {
		t.Errorf("geoip countries: %v", got)
	}
}

// Round-trip: encode a rule, synthesise the VyOS tree from ops, decode it
// back, verify the key fields survive. Catches asymmetric drift between
// encode/decode path schemas.
func TestEncodeDecode_Symmetry(t *testing.T) {
	original := model.Rule{
		Number: 30, Action: model.ActionAccept, Protocol: "tcp",
		Log: true,
		Destination: &model.AddrSpec{Port: "443"},
		Source: &model.AddrSpec{
			Group: &model.GroupRef{AddressGroup: "trusted-admins"},
		},
		State: &model.State{Established: true, Related: true},
	}
	ops, err := translator.RuleOps("ipv4", "WAN-IN", original)
	if err != nil {
		t.Fatal(err)
	}
	tree := map[string]any{}
	for _, op := range ops {
		applyOp(tree, op)
	}
	ruleRaw, _ := json.Marshal(tree["firewall"].(map[string]any)["ipv4"].
		(map[string]any)["name"].(map[string]any)["WAN-IN"])
	decoded, err := translator.DecodeRuleSet("ipv4", "WAN-IN", ruleRaw)
	if err != nil {
		t.Fatal(err)
	}
	if len(decoded.Rules) != 1 {
		t.Fatalf("rules: got %d want 1", len(decoded.Rules))
	}
	got := decoded.Rules[0]
	if got.Action != original.Action || got.Protocol != original.Protocol {
		t.Errorf("action/protocol drift: %+v", got)
	}
	if got.Source == nil || got.Source.Group == nil ||
		got.Source.Group.AddressGroup != "trusted-admins" {
		t.Errorf("source group drift: %+v", got.Source)
	}
	if !got.Log || got.State == nil || !got.State.Established {
		t.Errorf("flags drift: %+v", got)
	}
}

func TestNATRule_Roundtrip(t *testing.T) {
	ops, err := translator.NATRuleOps(model.NATRule{
		Number: 10, Direction: model.NATSource,
		OutboundInterface:  "eth0",
		Source:             &model.AddrSpec{Address: "10.0.0.0/24"},
		TranslationAddress: "masquerade",
	})
	if err != nil {
		t.Fatal(err)
	}
	var hasMasq, hasIface bool
	for _, op := range ops {
		last := op.Path[len(op.Path)-1]
		if op.Value == "masquerade" && last == "address" {
			hasMasq = true
		}
		if op.Value == "eth0" && last == "name" {
			hasIface = true
		}
	}
	if !hasMasq || !hasIface {
		t.Errorf("NAT encoding incomplete: masq=%v iface=%v", hasMasq, hasIface)
	}
}

// applyOp walks op.Path and writes into a synthetic tree.
func applyOp(tree map[string]any, op vyos.ConfigureOp) {
	cur := tree
	for i, seg := range op.Path {
		last := i == len(op.Path)-1
		if last {
			if op.Value != "" {
				cur[seg] = op.Value
			} else {
				cur[seg] = map[string]any{}
			}
			return
		}
		next, ok := cur[seg].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[seg] = next
		}
		cur = next
	}
}
