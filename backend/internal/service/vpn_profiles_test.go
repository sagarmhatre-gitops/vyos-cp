package service

// Service-level tests for the VPN profiles helpers. Focused on the
// internal logic that doesn't require wiring up a full Service struct
// or the seam infrastructure — used-by computation, deterministic UUID
// synthesis, join shape, orphan detection.
//
// End-to-end tests of CreateVPNProfile / UpdateVPNProfile / DeleteVPNProfile
// would require the clientPool/store seams and are deferred to a follow-up.
// The internal helpers below are the highest-value, easiest-to-test
// surface — and they're where the actual logic lives.

import (
	"testing"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// synthesizeVPNProfileID must produce the same UUID for the same inputs
// across processes. URLs minted at fleet-read time must stay stable.
func TestSynthesizeVPNProfileID_Deterministic(t *testing.T) {
	id1 := synthesizeVPNProfileID("dev-uuid-1", "ike", "IKE-DEFAULT")
	id2 := synthesizeVPNProfileID("dev-uuid-1", "ike", "IKE-DEFAULT")
	if id1 != id2 {
		t.Errorf("non-deterministic: got %q then %q", id1, id2)
	}
}

// Different inputs must produce different UUIDs. Otherwise we get URL
// collisions between distinct profiles.
func TestSynthesizeVPNProfileID_Distinguishing(t *testing.T) {
	cases := [][3]string{
		{"dev-1", "ike", "X"},
		{"dev-2", "ike", "X"},        // different device
		{"dev-1", "esp", "X"},        // different type
		{"dev-1", "ike", "Y"},        // different name
		{"dev-1", "ike", "X-tunnel"}, // name overlap that could trip naive concatenation
	}
	seen := map[string]string{}
	for _, c := range cases {
		id := synthesizeVPNProfileID(c[0], c[1], c[2])
		if prev, ok := seen[id]; ok {
			t.Errorf("collision: %v collides with %s", c, prev)
		}
		seen[id] = c[0] + "/" + c[1] + "/" + c[2]
	}
}

// buildVPNUsedBy must correctly attribute IKE and ESP references to
// peers, handling the per-tunnel ESP override case and deduplication.
func TestBuildVPNUsedBy_PerTunnelOverrides(t *testing.T) {
	peers := []model.Peer{
		{
			Name:            "peer-a",
			IKEGroup:        "IKE-DEFAULT",
			DefaultESPGroup: "ESP-DEFAULT",
			Tunnels: []model.Tunnel{
				{Number: 1, ESPGroup: "ESP-DEFAULT"}, // matches default, shouldn't dedupe-fail
				{Number: 2, ESPGroup: "ESP-FAST"},    // override
			},
		},
		{
			Name:            "peer-b",
			IKEGroup:        "IKE-DEFAULT", // shares with peer-a
			DefaultESPGroup: "ESP-DEFAULT",
		},
		{
			Name:     "peer-c",
			IKEGroup: "IKE-HIGH-SEC", // unique
			// No default ESP — only set per-tunnel.
			Tunnels: []model.Tunnel{
				{Number: 1, ESPGroup: "ESP-FAST"}, // shares ESP-FAST with peer-a
			},
		},
	}
	ike, esp := buildVPNUsedBy(peers)

	expectIke := map[string][]string{
		"IKE-DEFAULT":  {"peer-a", "peer-b"},
		"IKE-HIGH-SEC": {"peer-c"},
	}
	expectEsp := map[string][]string{
		"ESP-DEFAULT": {"peer-a", "peer-b"},
		"ESP-FAST":    {"peer-a", "peer-c"},
	}
	assertUsedBy(t, "ike", ike, expectIke)
	assertUsedBy(t, "esp", esp, expectEsp)
}

// Peers with empty group references must not produce phantom entries.
func TestBuildVPNUsedBy_EmptyRefs(t *testing.T) {
	peers := []model.Peer{
		{Name: "p1", IKEGroup: "", DefaultESPGroup: ""},
		{Name: "p2", IKEGroup: "IKE-X"},
	}
	ike, esp := buildVPNUsedBy(peers)
	if _, ok := ike[""]; ok {
		t.Errorf("phantom empty-name IKE entry: %v", ike)
	}
	if _, ok := esp[""]; ok {
		t.Errorf("phantom empty-name ESP entry: %v", esp)
	}
	if len(ike["IKE-X"]) != 1 || ike["IKE-X"][0] != "p2" {
		t.Errorf("expected IKE-X used by [p2], got %v", ike["IKE-X"])
	}
}

// appendUnique must not duplicate the same value.
func TestAppendUnique(t *testing.T) {
	s := []string{}
	s = appendUnique(s, "a")
	s = appendUnique(s, "b")
	s = appendUnique(s, "a") // duplicate
	if len(s) != 2 || s[0] != "a" || s[1] != "b" {
		t.Errorf("expected [a b], got %v", s)
	}
}

// --- helpers ---------------------------------------------------------------

func assertUsedBy(t *testing.T, label string, got, want map[string][]string) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s map size: got %d (%v) want %d (%v)",
			label, len(got), got, len(want), want)
		return
	}
	for k, wantPeers := range want {
		gotPeers := got[k]
		if !sameStringSetOrdered(gotPeers, wantPeers) {
			t.Errorf("%s[%s]: got %v want %v", label, k, gotPeers, wantPeers)
		}
	}
}

func sameStringSetOrdered(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
