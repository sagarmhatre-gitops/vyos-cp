package translator_test

// Translator tests for IPsec. Every test here guards against a specific
// regression that bit us against a live VyOS 1.5 device during the initial
// integration. They run in milliseconds and fail loudly on schema drift,
// so the next person to touch ipsec.go gets a precise pointer to what
// broke instead of an opaque "Commit failed" from a real device.
//
// Naming convention: TestX_Reason where Reason names what would have been
// broken if this test didn't exist. The Reason should be readable from the
// test runner output without opening the file.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
	"github.com/vyos-cp/vyos-cp/internal/vyos/translator"
)

// --- Encode regressions --------------------------------------------------

// VyOS 1.5 rejects `description` under ike-group, even though it accepts
// description on nearly every other node in the schema. Bit us as the very
// first integration test failure.
func TestIKEGroupOps_NoDescriptionLeaf(t *testing.T) {
	ops, err := translator.IKEGroupOps(model.IKEGroup{
		Name:        "IKE-DEFAULT",
		Description: "should not emit", // explicitly setting it
		IKEVersion:  "ikev2",
		Proposals:   []model.IKEProposal{{Number: 10, Encryption: "aes256", Hash: "sha256", DHGroup: "14"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, op := range ops {
		last := op.Path[len(op.Path)-1]
		if last == "description" {
			t.Fatalf("IKE group emitted a description leaf: %v — VyOS 1.5 rejects this", op.Path)
		}
	}
}

// Same regression for ESP groups.
func TestESPGroupOps_NoDescriptionLeaf(t *testing.T) {
	ops, err := translator.ESPGroupOps(model.ESPGroup{
		Name:        "ESP-DEFAULT",
		Description: "should not emit",
		Mode:        model.ESPTunnel,
		Proposals:   []model.ESPProposal{{Number: 10, Encryption: "aes256", Hash: "sha256"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, op := range ops {
		last := op.Path[len(op.Path)-1]
		if last == "description" {
			t.Fatalf("ESP group emitted a description leaf: %v — VyOS 1.5 rejects this", op.Path)
		}
	}
}

// On VyOS 1.5+ the PSK secret does NOT go under the peer's authentication
// subtree — it lives in `vpn ipsec authentication psk <name> secret`.
// Emitting the old form makes commit fail with "is not valid".
func TestPeerOps_PSKGoesToCentralAuthSubtree(t *testing.T) {
	ops := mustPeerOps(t, model.Peer{
		Name:           "p1",
		RemoteAddress:  "203.0.113.5",
		IKEGroup:       "IKE-DEFAULT",
		Authentication: model.PeerAuth{Mode: model.AuthPSK, PreSharedSecret: "shhh"},
	})

	// The wrong-shape op (the 1.4-era inline form) must NOT appear.
	wrong := []string{"vpn", "ipsec", "site-to-site", "peer", "p1", "authentication", "pre-shared-secret"}
	if findOp(ops, wrong) != nil {
		t.Fatal("peer emits 1.4-era inline pre-shared-secret; VyOS 1.5 rejects this")
	}

	// The right-shape op MUST appear with the actual secret value.
	right := []string{"vpn", "ipsec", "authentication", "psk", "p1", "secret"}
	got := findOp(ops, right)
	if got == nil {
		t.Fatal("peer did not emit central-tree psk secret op")
	}
	if got.Value != "shhh" {
		t.Errorf("psk secret value: got %q want %q", got.Value, "shhh")
	}
}

// VyOS 1.5 rejects a psk block that has neither `id` nor `secret`. Even
// with `secret` set, the validator wants at least one `id`. When the
// operator doesn't supply one explicitly we default to the remote-address.
func TestPeerOps_PSKAutoDefaultsIDFromRemoteAddress(t *testing.T) {
	ops := mustPeerOps(t, model.Peer{
		Name:           "p1",
		RemoteAddress:  "203.0.113.5",
		IKEGroup:       "IKE-DEFAULT",
		Authentication: model.PeerAuth{Mode: model.AuthPSK, PreSharedSecret: "shhh"},
	})

	idOp := findOp(ops, []string{"vpn", "ipsec", "authentication", "psk", "p1", "id"})
	if idOp == nil {
		t.Fatal("psk block has no `id` op; VyOS 1.5 will reject commit")
	}
	if idOp.Value != "203.0.113.5" {
		t.Errorf("default psk id: got %q want remote-address %q", idOp.Value, "203.0.113.5")
	}
}

// When the operator DOES supply explicit local/remote IDs, the auto-default
// must not fire (we shouldn't pile a third id onto the psk block alongside
// the user-supplied ones).
func TestPeerOps_PSKAutoDefaultSkippedWhenExplicitIDGiven(t *testing.T) {
	ops := mustPeerOps(t, model.Peer{
		Name:          "p1",
		RemoteAddress: "203.0.113.5",
		IKEGroup:      "IKE-DEFAULT",
		Authentication: model.PeerAuth{
			Mode: model.AuthPSK, PreSharedSecret: "shhh",
			LocalID: "@local.example", RemoteID: "@remote.example",
		},
	})

	pskIDOps := 0
	for _, op := range ops {
		if matchPath(op.Path, []string{"vpn", "ipsec", "authentication", "psk", "p1", "id"}) {
			pskIDOps++
		}
	}
	if pskIDOps != 2 {
		t.Errorf("expected exactly 2 psk id ops (explicit local + remote); got %d", pskIDOps)
	}
	// Specifically: the remote-address should NOT have been auto-supplied
	// as a third id, since the operator provided their own.
	for _, op := range ops {
		if matchPath(op.Path, []string{"vpn", "ipsec", "authentication", "psk", "p1", "id"}) &&
			op.Value == "203.0.113.5" {
			t.Errorf("auto-default id fired even though explicit IDs were set")
		}
	}
}

// VyOS 1.5 requires local-address (or dhcp-interface) to be explicit on
// every site-to-site peer. Earlier versions silently defaulted to the
// system's outbound IP. When the operator doesn't pin a WAN we default
// to the literal string "any", which VyOS accepts.
func TestPeerOps_LocalAddressDefaultsToAny(t *testing.T) {
	ops := mustPeerOps(t, model.Peer{
		Name:           "p1",
		RemoteAddress:  "203.0.113.5",
		IKEGroup:       "IKE-DEFAULT",
		LocalAddress:   "", // operator left blank
		Authentication: model.PeerAuth{Mode: model.AuthPSK, PreSharedSecret: "shhh"},
	})

	la := findOp(ops, []string{"vpn", "ipsec", "site-to-site", "peer", "p1", "local-address"})
	if la == nil {
		t.Fatal("peer has no local-address op; VyOS 1.5 will reject commit")
	}
	if la.Value != "any" {
		t.Errorf("default local-address: got %q want %q", la.Value, "any")
	}
}

// An explicit local-address (e.g. pinning to a specific WAN IP) must
// override the "any" default. Otherwise the auto-default would silently
// undo what the operator typed.
func TestPeerOps_LocalAddressExplicitOverridesDefault(t *testing.T) {
	ops := mustPeerOps(t, model.Peer{
		Name:           "p1",
		RemoteAddress:  "203.0.113.5",
		IKEGroup:       "IKE-DEFAULT",
		LocalAddress:   "10.10.0.1",
		Authentication: model.PeerAuth{Mode: model.AuthPSK, PreSharedSecret: "shhh"},
	})

	la := findOp(ops, []string{"vpn", "ipsec", "site-to-site", "peer", "p1", "local-address"})
	if la == nil || la.Value != "10.10.0.1" {
		t.Errorf("explicit local-address not respected; got %+v", la)
	}
}

// DeletePeerOps must also wipe the sibling psk entry. The PSK lives outside
// the peer subtree on VyOS 1.5, so deleting just the peer leaks the secret
// on the device and (worse) in the running config. Two delete ops expected.
func TestDeletePeerOps_AlsoWipesPSK(t *testing.T) {
	ops := translator.DeletePeerOps("p1")
	if len(ops) != 2 {
		t.Fatalf("expected 2 delete ops (peer + psk), got %d", len(ops))
	}
	wantPeer := []string{"vpn", "ipsec", "site-to-site", "peer", "p1"}
	wantPSK := []string{"vpn", "ipsec", "authentication", "psk", "p1"}
	if !matchPath(ops[0].Path, wantPeer) || !matchPath(ops[1].Path, wantPSK) {
		t.Errorf("delete paths wrong: %+v", ops)
	}
	for _, op := range ops {
		if op.Op != vyos.OpDelete {
			t.Errorf("expected delete op, got %q on %v", op.Op, op.Path)
		}
	}
}

// --- Redaction -----------------------------------------------------------

// RedactSecrets must replace the psk secret value with the sentinel, leave
// the original slice untouched, and not redact anything else (id, tunnel
// prefixes, mode, etc).
func TestRedactSecrets_OnlyPSKSecret(t *testing.T) {
	ops := mustPeerOps(t, model.Peer{
		Name:          "p1",
		RemoteAddress: "203.0.113.5",
		IKEGroup:      "IKE-DEFAULT",
		Authentication: model.PeerAuth{
			Mode: model.AuthPSK, PreSharedSecret: "supersecret",
			LocalID: "@local",
		},
		Tunnels: []model.Tunnel{{Number: 0, LocalSubnet: "10.0.0.0/24", RemoteSubnet: "10.1.0.0/24"}},
	})

	redacted := translator.RedactSecrets(ops)

	// Original slice unchanged.
	if findOp(ops, []string{"vpn", "ipsec", "authentication", "psk", "p1", "secret"}).Value != "supersecret" {
		t.Error("RedactSecrets mutated the input slice")
	}

	// Redacted copy has the sentinel.
	sec := findOp(redacted, []string{"vpn", "ipsec", "authentication", "psk", "p1", "secret"})
	if sec == nil {
		t.Fatal("redacted slice lost the secret op entirely")
	}
	if sec.Value != "***REDACTED***" {
		t.Errorf("psk secret not redacted: got %q", sec.Value)
	}

	// Non-secret values must be preserved.
	for _, op := range redacted {
		last := op.Path[len(op.Path)-1]
		if last == "secret" {
			continue
		}
		// Tunnel prefix, ike-group ref, local-id, remote-address, etc. — all
		// should be intact. Catch the bug where someone "helpfully" widens
		// the redaction.
		if op.Value == "***REDACTED***" {
			t.Errorf("non-secret op got redacted: %v", op.Path)
		}
	}
}

// Guard against future schema drift: if VyOS ever adds another secret
// node, this test catches the case where we only redact the first one.
// Today there's only one psk-secret per peer; if a code path emits two,
// both should redact. Same matcher → same result.
func TestRedactSecrets_AllMatchingPathsHit(t *testing.T) {
	ops := []vyos.ConfigureOp{
		{Op: vyos.OpSet, Path: []string{"vpn", "ipsec", "authentication", "psk", "a", "secret"}, Value: "one"},
		{Op: vyos.OpSet, Path: []string{"vpn", "ipsec", "authentication", "psk", "b", "secret"}, Value: "two"},
		{Op: vyos.OpSet, Path: []string{"vpn", "ipsec", "site-to-site", "peer", "x", "remote-address"}, Value: "1.2.3.4"},
	}
	out := translator.RedactSecrets(ops)
	if out[0].Value != "***REDACTED***" || out[1].Value != "***REDACTED***" {
		t.Errorf("not all psk secrets redacted: %+v", out)
	}
	if out[2].Value != "1.2.3.4" {
		t.Errorf("non-secret op corrupted: %+v", out[2])
	}
}

// --- Decode --------------------------------------------------------------

// Decoding what a real VyOS retrieve looks like for vpn ipsec.
// Fixture captured from VyOS 1.5-rolling against a populated device.
func TestDecodeIPsec_HappyPath(t *testing.T) {
	raw := json.RawMessage(`{
		"nat-traversal": "enable",
		"ike-group": {
			"IKE-DEFAULT": {
				"key-exchange": "ikev2",
				"lifetime": "28800",
				"dead-peer-detection": {
					"action": "restart", "interval": "30", "timeout": "120"
				},
				"proposal": {
					"10": {"encryption": "aes256", "hash": "sha256", "dh-group": "14"}
				}
			}
		},
		"esp-group": {
			"ESP-DEFAULT": {
				"mode": "tunnel", "pfs": "dh-group14", "lifetime": "3600",
				"proposal": {"10": {"encryption": "aes256", "hash": "sha256"}}
			}
		},
		"site-to-site": {
			"peer": {
				"branch-nyc": {
					"remote-address": "203.0.113.5",
					"local-address": "any",
					"ike-group": "IKE-DEFAULT",
					"default-esp-group": "ESP-DEFAULT",
					"authentication": {"mode": "pre-shared-secret"},
					"tunnel": {
						"0": {
							"local": {"prefix": "10.0.1.0/24"},
							"remote": {"prefix": "10.0.2.0/24"}
						}
					}
				}
			}
		}
	}`)

	cfg, err := translator.DecodeIPsec(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Globals.NATTraversal {
		t.Error("NAT-T not decoded")
	}
	if len(cfg.IKEGroups) != 1 || cfg.IKEGroups[0].Name != "IKE-DEFAULT" {
		t.Errorf("IKE group: %+v", cfg.IKEGroups)
	}
	if cfg.IKEGroups[0].Lifetime != 28800 || cfg.IKEGroups[0].IKEVersion != "ikev2" {
		t.Errorf("IKE fields: %+v", cfg.IKEGroups[0])
	}
	if len(cfg.IKEGroups[0].Proposals) != 1 || cfg.IKEGroups[0].Proposals[0].DHGroup != "14" {
		t.Errorf("IKE proposal: %+v", cfg.IKEGroups[0].Proposals)
	}
	if len(cfg.ESPGroups) != 1 || cfg.ESPGroups[0].PFS != "dh-group14" {
		t.Errorf("ESP group: %+v", cfg.ESPGroups)
	}
	if len(cfg.Peers) != 1 || cfg.Peers[0].Name != "branch-nyc" {
		t.Errorf("peer: %+v", cfg.Peers)
	}
	if cfg.Peers[0].RemoteAddress != "203.0.113.5" || cfg.Peers[0].LocalAddress != "any" {
		t.Errorf("peer addresses: %+v", cfg.Peers[0])
	}
	if len(cfg.Peers[0].Tunnels) != 1 {
		t.Fatalf("tunnel count: %d", len(cfg.Peers[0].Tunnels))
	}
	if cfg.Peers[0].Tunnels[0].LocalSubnet != "10.0.1.0/24" {
		t.Errorf("tunnel subnet: %+v", cfg.Peers[0].Tunnels[0])
	}
}

// VyOS returns an empty `null` body when the path exists but has no config.
// The decoder must not crash; it should return an empty config.
func TestDecodeIPsec_EmptyBody(t *testing.T) {
	for _, raw := range []json.RawMessage{
		json.RawMessage(``),
		json.RawMessage(`null`),
		json.RawMessage(`{}`),
	} {
		cfg, err := translator.DecodeIPsec(raw)
		if err != nil {
			t.Errorf("decode %q: %v", string(raw), err)
		}
		if cfg == nil {
			t.Errorf("decode %q: returned nil", string(raw))
		}
	}
}

// --- helpers -------------------------------------------------------------

func mustPeerOps(t *testing.T, p model.Peer) []vyos.ConfigureOp {
	t.Helper()
	ops, err := translator.PeerOps(p)
	if err != nil {
		t.Fatalf("PeerOps: %v", err)
	}
	return ops
}

// findOp returns the first op whose path equals want exactly, or nil.
func findOp(ops []vyos.ConfigureOp, want []string) *vyos.ConfigureOp {
	for i := range ops {
		if matchPath(ops[i].Path, want) {
			return &ops[i]
		}
	}
	return nil
}

func matchPath(a, b []string) bool {
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

// pathString is for error messages — joins a path with slashes.
func pathString(p []string) string { return strings.Join(p, "/") }

var _ = pathString // keep referenced for future helpers
