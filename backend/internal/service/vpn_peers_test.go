package service

// Unit tests for the pure-function helpers in vpn_peers.go.
// Integration tests (full fleet read against a live device) are run
// manually via the smoke-test scripts — the same approach used for
// vpn_profiles. We deliberately don't mock the device HTTP client
// here because the contract value is the VyOS-side behavior, not
// the Go function signatures.

import (
	"testing"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

func TestSynthesizeVPNPeerID_DeterministicAndStable(t *testing.T) {
	a := synthesizeVPNPeerID("device-1", "shivalik-peer")
	b := synthesizeVPNPeerID("device-1", "shivalik-peer")
	if a != b {
		t.Fatalf("synthesizeVPNPeerID not deterministic: %s vs %s", a, b)
	}
	// Frozen value — if this fails after a code change, someone has
	// changed the namespace UUID or the input encoding, which will
	// break every existing VyOS-only peer URL. Regenerate intentionally.
	const expected = "3f429348-0470-5af4-88ed-ec55f1468d37"
	if a != expected {
		t.Fatalf("synthesizeVPNPeerID(device-1, shivalik-peer) = %s, want %s\n"+
			"(changing the namespace breaks existing URLs)", a, expected)
	}
}

func TestSynthesizeVPNPeerID_DifferentByDevice(t *testing.T) {
	a := synthesizeVPNPeerID("device-1", "peer")
	b := synthesizeVPNPeerID("device-2", "peer")
	if a == b {
		t.Fatal("expected different UUIDs for different devices")
	}
}

func TestSynthesizeVPNPeerID_DifferentByName(t *testing.T) {
	a := synthesizeVPNPeerID("device-1", "peer-a")
	b := synthesizeVPNPeerID("device-1", "peer-b")
	if a == b {
		t.Fatal("expected different UUIDs for different peer names")
	}
}

func TestSynthesizeVPNPeerID_DistinctFromProfileNamespace(t *testing.T) {
	// A peer and a profile with the same (device, name) should never
	// collide on UUID — different namespaces. Belt-and-suspenders
	// regression test against accidentally sharing the namespace.
	peerID := synthesizeVPNPeerID("device-1", "DEFAULT")
	profileID := synthesizeVPNProfileID("device-1", "ike", "DEFAULT")
	if peerID == profileID {
		t.Fatal("peer and profile UUIDs collided; namespaces likely shared")
	}
}

func TestJoinVPNPeer_SynthesizedWhenNoMetadata(t *testing.T) {
	dev := model.Device{ID: "dev-1", Name: "edge-01"}
	peer := model.Peer{Name: "branch-nyc"}
	joined := joinVPNPeer(dev, peer, model.VPNPeerMetadata{})

	if joined.ID == "" {
		t.Fatal("expected synthesized ID, got empty")
	}
	if joined.ID != synthesizeVPNPeerID(dev.ID, peer.Name) {
		t.Fatal("synthesized ID does not match expected derivation")
	}
	if joined.CreatedAt != nil || joined.UpdatedAt != nil {
		t.Fatal("timestamps must be nil when no metadata row exists")
	}
	if joined.Tags == nil {
		t.Fatal("Tags must be non-nil empty slice for JSON round-trip")
	}
	if joined.UsedBy == nil {
		t.Fatal("UsedBy must be non-nil empty slice for JSON round-trip")
	}
}

func TestJoinVPNPeer_PreservesMetadataUUID(t *testing.T) {
	now := time.Now().UTC()
	dev := model.Device{ID: "dev-1", Name: "edge-01"}
	peer := model.Peer{Name: "branch-nyc"}
	meta := model.VPNPeerMetadata{
		ID:          "11111111-2222-3333-4444-555555555555",
		DeviceID:    dev.ID,
		Name:        peer.Name,
		Description: "branch office",
		Tags:        []string{"nyc", "branch"},
		CreatedBy:   "alice",
		UpdatedBy:   "bob",
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	joined := joinVPNPeer(dev, peer, meta)
	if joined.ID != meta.ID {
		t.Fatalf("expected metadata UUID preserved, got %s", joined.ID)
	}
	if joined.Description != "branch office" {
		t.Fatalf("description not propagated: %q", joined.Description)
	}
	if len(joined.Tags) != 2 || joined.Tags[0] != "nyc" {
		t.Fatalf("tags not propagated: %v", joined.Tags)
	}
	if joined.CreatedAt == nil || joined.UpdatedAt == nil {
		t.Fatal("timestamps should be non-nil when metadata row exists")
	}
	if !joined.CreatedAt.Equal(now) {
		t.Fatalf("CreatedAt mismatch: got %v want %v", *joined.CreatedAt, now)
	}
}

func TestJoinVPNPeer_UsedByAlwaysEmptyInPhase3A(t *testing.T) {
	// Phase 5 will populate UsedBy from Tunnel objects. In Phase 3A
	// it must always be an empty (non-nil) slice.
	dev := model.Device{ID: "dev-1"}
	peer := model.Peer{Name: "p"}
	joined := joinVPNPeer(dev, peer, model.VPNPeerMetadata{})
	if joined.UsedBy == nil || len(joined.UsedBy) != 0 {
		t.Fatalf("UsedBy must be empty non-nil slice in Phase 3A, got %v",
			joined.UsedBy)
	}
}
