package store

import (
	"testing"

	"vyos-cp/internal/model"
)

// TestCanonicalHash_KeyOrderInvariant verifies that two configs with the same
// content but different map insertion order hash identically. This is the
// invariant that makes dedup work.
func TestCanonicalHash_KeyOrderInvariant(t *testing.T) {
	a := model.DeviceConfig{
		Firewall: model.FirewallConfig{
			IPv4: map[string]any{
				"name": map[string]any{
					"WAN-IN": map[string]any{
						"rule": map[string]any{
							"10": map[string]any{"action": "accept", "protocol": "tcp"},
							"20": map[string]any{"action": "drop", "protocol": "udp"},
						},
					},
				},
			},
		},
	}
	// Same content, different key insertion order at every level.
	b := model.DeviceConfig{
		Firewall: model.FirewallConfig{
			IPv4: map[string]any{
				"name": map[string]any{
					"WAN-IN": map[string]any{
						"rule": map[string]any{
							"20": map[string]any{"protocol": "udp", "action": "drop"},
							"10": map[string]any{"protocol": "tcp", "action": "accept"},
						},
					},
				},
			},
		},
	}

	ha, err := CanonicalHash(a)
	if err != nil {
		t.Fatalf("hash a: %v", err)
	}
	hb, err := CanonicalHash(b)
	if err != nil {
		t.Fatalf("hash b: %v", err)
	}
	if string(ha) != string(hb) {
		t.Fatalf("hashes differ for semantically equal configs: %x vs %x", ha, hb)
	}
}

// TestCanonicalHash_DetectsChange verifies that a single-field change produces
// a different hash. The dedup path depends on this.
func TestCanonicalHash_DetectsChange(t *testing.T) {
	base := model.DeviceConfig{
		Firewall: model.FirewallConfig{
			IPv4: map[string]any{
				"name": map[string]any{
					"WAN-IN": map[string]any{
						"rule": map[string]any{
							"10": map[string]any{"action": "accept"},
						},
					},
				},
			},
		},
	}
	changed := model.DeviceConfig{
		Firewall: model.FirewallConfig{
			IPv4: map[string]any{
				"name": map[string]any{
					"WAN-IN": map[string]any{
						"rule": map[string]any{
							"10": map[string]any{"action": "drop"}, // accept -> drop
						},
					},
				},
			},
		},
	}

	ha, _ := CanonicalHash(base)
	hb, _ := CanonicalHash(changed)
	if string(ha) == string(hb) {
		t.Fatalf("hashes identical despite content change")
	}
}

// TestCanonicalHash_EmptyConfig is a regression guard — an empty config
// should still hash successfully and produce a stable value.
func TestCanonicalHash_EmptyConfig(t *testing.T) {
	empty := model.DeviceConfig{}
	h1, err := CanonicalHash(empty)
	if err != nil {
		t.Fatalf("hash empty: %v", err)
	}
	h2, err := CanonicalHash(empty)
	if err != nil {
		t.Fatalf("hash empty (2nd): %v", err)
	}
	if string(h1) != string(h2) {
		t.Fatalf("empty config not stable: %x vs %x", h1, h2)
	}
	if len(h1) != 32 {
		t.Fatalf("expected 32-byte sha256, got %d", len(h1))
	}
}
