package vyos

import (
	"encoding/json"
	"strings"
	"testing"
)

// realistic snapshot subset, drawn from the actual VM data:
//   firewall.ipv4.name.mgmt_to_inside.rule.{1,2}  (rule 2 has a state array)
//   firewall.ipv4.name.mgmt_to_inside.default-action
//   interfaces.residual.loopback.lo  (empty-object leaf)
//   interfaces.residual.input.ifb0   (empty-object leaf)
const realisticConfig = `{
  "firewall": {
    "ipv4": {
      "name": {
        "mgmt_to_inside": {
          "rule": {
            "1": {"action": "accept", "protocol": "icmp"},
            "2": {"state": ["related", "established"], "action": "accept"}
          },
          "default-action": "drop"
        }
      }
    }
  },
  "interfaces": {
    "residual": {
      "loopback": {"lo": {}},
      "input":    {"ifb0": {}}
    }
  }
}`

func TestSynthesize_RealisticConfig(t *testing.T) {
	var tree map[string]any
	if err := json.Unmarshal([]byte(realisticConfig), &tree); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := SynthesizeCLI(tree)

	// The exact ordering matters (alphabetical at each level, numeric for rule keys),
	// so we can compare against a stable expected string.
	want := strings.Join([]string{
		// firewall.ipv4.name.mgmt_to_inside: default-action then rule (alphabetical)
		`set firewall ipv4 name mgmt_to_inside default-action drop`,
		// rule 1: action, protocol (alphabetical within rule)
		`set firewall ipv4 name mgmt_to_inside rule 1 action accept`,
		`set firewall ipv4 name mgmt_to_inside rule 1 protocol icmp`,
		// rule 2: action, then state (expanded to two ops because it's an array)
		`set firewall ipv4 name mgmt_to_inside rule 2 action accept`,
		`set firewall ipv4 name mgmt_to_inside rule 2 state related`,
		`set firewall ipv4 name mgmt_to_inside rule 2 state established`,
		// interfaces.residual: input then loopback (alphabetical)
		`set interfaces residual input ifb0`,
		`set interfaces residual loopback lo`,
	}, "\n")

	if got != want {
		t.Errorf("synthesize mismatch.\nGOT:\n%s\nWANT:\n%s", got, want)
	}
}

func TestSynthesize_NumericKeysSortNumerically(t *testing.T) {
	// Rule numbers "1", "2", "10", "20" must come out as 1,2,10,20 (numeric),
	// not 1,10,2,20 (lexicographic).
	cfg := `{"r": {"1":{},"2":{},"10":{},"20":{}}}`
	var tree map[string]any
	_ = json.Unmarshal([]byte(cfg), &tree)
	got := SynthesizeCLI(tree)
	want := "set r 1\nset r 2\nset r 10\nset r 20"
	if got != want {
		t.Errorf("numeric-key ordering wrong.\nGOT:\n%s\nWANT:\n%s", got, want)
	}
}

func TestSynthesize_EmptyObjectIsLeafNode(t *testing.T) {
	// `loopback.lo = {}` means: lo is a node, no attributes. Emit `set loopback lo`,
	// NOT `set loopback lo {}` and NOT skip.
	cfg := `{"loopback": {"lo": {}}}`
	var tree map[string]any
	_ = json.Unmarshal([]byte(cfg), &tree)
	got := SynthesizeCLI(tree)
	want := "set loopback lo"
	if got != want {
		t.Errorf("empty-object leaf wrong.\nGOT: %q\nWANT: %q", got, want)
	}
}

func TestSynthesize_ScalarArrayExpands(t *testing.T) {
	cfg := `{"state": ["related", "established", "new"]}`
	var tree map[string]any
	_ = json.Unmarshal([]byte(cfg), &tree)
	got := SynthesizeCLI(tree)
	want := "set state related\nset state established\nset state new"
	if got != want {
		t.Errorf("array expansion wrong.\nGOT:\n%s\nWANT:\n%s", got, want)
	}
}

func TestSynthesize_ValueWithSpacesIsQuoted(t *testing.T) {
	// vyos.OpsToCLI already handles this; sanity-check the pipeline.
	cfg := `{"description": "office uplink"}`
	var tree map[string]any
	_ = json.Unmarshal([]byte(cfg), &tree)
	got := SynthesizeCLI(tree)
	want := `set description "office uplink"`
	if got != want {
		t.Errorf("quoting wrong.\nGOT: %q\nWANT: %q", got, want)
	}
}

func TestSynthesize_EmptyTreeProducesNoOps(t *testing.T) {
	got := SynthesizeCLI(map[string]any{})
	if got != "" {
		t.Errorf("expected empty string for empty tree, got: %q", got)
	}
}
