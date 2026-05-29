package poller

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// realisticSnapshot is a minimal but representative subset of a real VyOS
// /retrieve response: firewall with rules, interfaces with mixed
// modeled+unmodeled sub-keys, and a top-level "protocols" the model does not handle.
const realisticSnapshot = `{
  "firewall": {
    "ipv4": {
      "name": {
        "inside_to_mgmt": {
          "default-action": "drop",
          "rule": {
            "1": {"action": "accept", "protocol": "icmp"}
          }
        }
      }
    }
  },
  "interfaces": {
    "ethernet": {
      "eth0": {"mtu": "1500", "address": "10.10.0.1/24"}
    },
    "loopback": {
      "lo": {}
    },
    "input": {
      "ifb0": {}
    }
  },
  "protocols": {
    "static": {"route": {"0.0.0.0/0": {"next-hop": {"10.10.0.254": {}}}}}
  }
}`

func TestRouteSnapshotTree_RealisticShape(t *testing.T) {
	var tree map[string]any
	if err := json.Unmarshal([]byte(realisticSnapshot), &tree); err != nil {
		t.Fatalf("unmarshal sample: %v", err)
	}

	cfg := routeSnapshotTree(tree)

	// Firewall.IPv4 must have the rules.
	if cfg.Firewall.IPv4 == nil {
		t.Fatalf("expected Firewall.IPv4 populated, got nil")
	}
	if cfg.Firewall.IPv6 != nil {
		t.Errorf("expected Firewall.IPv6 nil, got %v", cfg.Firewall.IPv6)
	}
	if cfg.Firewall.Residual != nil {
		t.Errorf("expected Firewall.Residual empty, got %v", cfg.Firewall.Residual)
	}

	// Interfaces.Ethernet must have eth0; loopback + input must land in Residual.
	if _, ok := cfg.Interfaces.Ethernet["eth0"]; !ok {
		t.Errorf("expected Interfaces.Ethernet to contain eth0, got %v", cfg.Interfaces.Ethernet)
	}
	if _, ok := cfg.Interfaces.Residual["loopback"]; !ok {
		t.Errorf("expected Interfaces.Residual to contain loopback, got %v", cfg.Interfaces.Residual)
	}
	if _, ok := cfg.Interfaces.Residual["input"]; !ok {
		t.Errorf("expected Interfaces.Residual to contain input, got %v", cfg.Interfaces.Residual)
	}

	// "protocols" is genuinely unmodeled — must land in Extra.
	if _, ok := cfg.Extra["protocols"]; !ok {
		t.Errorf("expected Extra to contain protocols, got keys=%v", keysOf(cfg.Extra))
	}

	// Extra must NOT contain firewall/nat/interfaces — those were claimed.
	for _, claimed := range []string{"firewall", "nat", "interfaces"} {
		if _, ok := cfg.Extra[claimed]; ok {
			t.Errorf("Extra unexpectedly contains claimed key %q: %v", claimed, keysOf(cfg.Extra))
		}
	}
}

func TestRouteSnapshotTree_EmptyTreeStaysEmpty(t *testing.T) {
	cfg := routeSnapshotTree(map[string]any{})
	if !reflect.DeepEqual(cfg, model.DeviceConfig{}) {
		t.Errorf("expected zero-value DeviceConfig, got %+v", cfg)
	}
}

func TestRouteSnapshotTree_OnlyUnmodeledKeys(t *testing.T) {
	// VyOS returning only top-level keys the model does not recognise: everything lands in Extra.
	cfg := routeSnapshotTree(map[string]any{
		"system": map[string]any{"host-name": "vyos-1"},
		"vpn":    map[string]any{},
	})
	if cfg.Firewall.IPv4 != nil || cfg.NAT.Source != nil || cfg.Interfaces.Ethernet != nil {
		t.Errorf("expected typed fields empty, got %+v", cfg)
	}
	if _, ok := cfg.Extra["system"]; !ok {
		t.Errorf("expected Extra to contain system, got %v", keysOf(cfg.Extra))
	}
	if _, ok := cfg.Extra["vpn"]; !ok {
		t.Errorf("expected Extra to contain vpn, got %v", keysOf(cfg.Extra))
	}
}

func keysOf(m map[string]any) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}
