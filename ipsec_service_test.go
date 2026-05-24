package service

// Service-layer tests for IPsec. Each test guards against a specific
// regression we hit (and chased on a live VyOS device) during the
// integration. They run in milliseconds against fake clients — no
// network, no Postgres, no Docker.
//
// Fakes are defined inline at the bottom so each test reads top-to-bottom
// without jumping around files. Naming convention mirrors the translator
// tests: TestX_Reason where Reason describes what would break if this
// test didn't exist.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
)

// =============================================================================
// Tests
// =============================================================================

// Happy path: UpsertPeer pushes exactly one Configure batch containing the
// expected delete-then-set ops, with the audit row capturing the same ops
// but with the PSK secret redacted.
func TestUpsertPeer_AtomicOpsReachDevice(t *testing.T) {
	svc, fc, fs := newTestService()
	peer := model.Peer{
		Name:          "p1",
		RemoteAddress: "203.0.113.5",
		IKEGroup:      "IKE-DEFAULT",
		Authentication: model.PeerAuth{
			Mode: model.AuthPSK, PreSharedSecret: "rocket-launcher",
		},
	}
	if err := svc.UpsertPeer(context.Background(), "u1", "alice", "dev1", peer); err != nil {
		t.Fatal(err)
	}
	if len(fc.configureCalls) != 1 {
		t.Fatalf("expected exactly 1 Configure call, got %d", len(fc.configureCalls))
	}
	// First call should contain both delete + set ops for the peer.
	ops := fc.configureCalls[0].ops
	if !anyOpPath(ops, vyos.OpDelete, "vpn", "ipsec", "site-to-site", "peer", "p1") {
		t.Errorf("delete ops missing peer subtree wipe")
	}
	if !anyOpPath(ops, vyos.OpSet, "vpn", "ipsec", "site-to-site", "peer", "p1", "remote-address") {
		t.Errorf("set ops missing remote-address")
	}
	// Audit was recorded with PSK redacted (the device got the real one).
	if len(fs.auditCalls) != 1 {
		t.Fatalf("expected exactly 1 audit row, got %d", len(fs.auditCalls))
	}
	auditOps := fs.auditCalls[0].ops
	if pskOp := findAuditOp(auditOps, "secret"); pskOp == nil {
		t.Errorf("audit missing psk secret op")
	} else if pskOp.Value != "***REDACTED***" {
		t.Errorf("audit psk secret not redacted: got %q", pskOp.Value)
	}
}

// PSK preservation: when the operator edits a peer without re-supplying
// the secret (sentinel "(stored)" or empty), the service must fetch the
// existing PSK from the device and re-supply it. Otherwise the atomic
// delete-then-set wipes the psk block on the device.
func TestUpsertPeer_PSKPreservedOnEditWithEmptySecret(t *testing.T) {
	svc, fc, _ := newTestService()
	// Pre-arm the fake Retrieve: device already has a PSK stored.
	fc.retrieveResponses[strings.Join([]string{"vpn", "ipsec", "authentication", "psk", "p1", "secret"}, "/")] =
		json.RawMessage(`"already-on-device-secret"`)

	peer := model.Peer{
		Name:           "p1",
		RemoteAddress:  "203.0.113.5",
		IKEGroup:       "IKE-DEFAULT",
		Authentication: model.PeerAuth{Mode: model.AuthPSK, PreSharedSecret: "(stored)"},
	}
	if err := svc.UpsertPeer(context.Background(), "u1", "alice", "dev1", peer); err != nil {
		t.Fatal(err)
	}
	// The Configure call MUST include the secret op with the fetched value.
	ops := fc.configureCalls[0].ops
	secretOp := findOpAt(ops, []string{"vpn", "ipsec", "authentication", "psk", "p1", "secret"})
	if secretOp == nil {
		t.Fatal("PSK preservation failed — no secret op emitted; existing PSK would be wiped on commit")
	}
	if secretOp.Value != "already-on-device-secret" {
		t.Errorf("PSK preservation supplied wrong value: got %q", secretOp.Value)
	}
}

// PSK preservation: when the device has NO existing PSK and the operator
// sent an empty secret, the service must reject with a clear error rather
// than silently committing an empty psk block (which would cause
// authentication to fail at IKE negotiation).
func TestUpsertPeer_EmptyPSKWithNoExistingRejected(t *testing.T) {
	svc, _, _ := newTestService()
	// Retrieve returns the "configuration empty" error VyOS uses for
	// missing paths. fetchExistingPSK treats this as "no existing PSK".
	// We don't pre-arm the response — the fake returns that error by default.

	peer := model.Peer{
		Name:           "p1",
		RemoteAddress:  "203.0.113.5",
		IKEGroup:       "IKE-DEFAULT",
		Authentication: model.PeerAuth{Mode: model.AuthPSK, PreSharedSecret: ""},
	}
	err := svc.UpsertPeer(context.Background(), "u1", "alice", "dev1", peer)
	if err == nil {
		t.Fatal("expected error when both supplied and stored PSKs are empty")
	}
	if !strings.Contains(err.Error(), "PSK") && !strings.Contains(err.Error(), "psk") {
		t.Errorf("error should mention PSK, got: %v", err)
	}
}

// CreateTunnel: the wizard endpoint produces ONE Configure call with
// IKE + ESP + peer ops combined. Pre-batching this was three sequential
// calls and a partial-failure cleanup nightmare.
func TestCreateTunnel_SingleAtomicConfigureCall(t *testing.T) {
	svc, fc, fs := newTestService()
	ike := &model.IKEGroup{
		Name:       "IKE-X",
		IKEVersion: "ikev2",
		Proposals:  []model.IKEProposal{{Number: 10, Encryption: "aes256", Hash: "sha256", DHGroup: "14"}},
	}
	esp := &model.ESPGroup{
		Name:      "ESP-X",
		Mode:      model.ESPTunnel,
		Proposals: []model.ESPProposal{{Number: 10, Encryption: "aes256", Hash: "sha256"}},
	}
	peer := model.Peer{
		Name:           "p1",
		RemoteAddress:  "203.0.113.5",
		IKEGroup:       "IKE-X",
		Authentication: model.PeerAuth{Mode: model.AuthPSK, PreSharedSecret: "x"},
	}
	if err := svc.CreateTunnel(context.Background(), "u1", "alice", "dev1", ike, esp, peer); err != nil {
		t.Fatal(err)
	}
	if len(fc.configureCalls) != 1 {
		t.Fatalf("expected exactly 1 Configure call (atomic), got %d", len(fc.configureCalls))
	}
	ops := fc.configureCalls[0].ops
	// Must contain ops for all three subtrees.
	if !anyOpStartsWith(ops, []string{"vpn", "ipsec", "ike-group", "IKE-X"}) {
		t.Errorf("missing IKE ops")
	}
	if !anyOpStartsWith(ops, []string{"vpn", "ipsec", "esp-group", "ESP-X"}) {
		t.Errorf("missing ESP ops")
	}
	if !anyOpStartsWith(ops, []string{"vpn", "ipsec", "site-to-site", "peer", "p1"}) {
		t.Errorf("missing peer ops")
	}
	// Single audit row, single action.
	if len(fs.auditCalls) != 1 {
		t.Fatalf("expected 1 audit row, got %d", len(fs.auditCalls))
	}
	if fs.auditCalls[0].action != "ipsec.tunnel.create" {
		t.Errorf("audit action: got %q want %q", fs.auditCalls[0].action, "ipsec.tunnel.create")
	}
}

// CreateTunnel: when ike/esp are nil, the caller is opting to reuse
// existing groups. The service must NOT emit ops for them — that's the
// "reuse existing IKE-DEFAULT" path. Emitting them would clobber any
// out-of-band customisation.
func TestCreateTunnel_OmittedGroupsSkipUpsert(t *testing.T) {
	svc, fc, _ := newTestService()
	peer := model.Peer{
		Name:           "p2",
		RemoteAddress:  "203.0.113.5",
		IKEGroup:       "IKE-DEFAULT",
		Authentication: model.PeerAuth{Mode: model.AuthPSK, PreSharedSecret: "x"},
	}
	if err := svc.CreateTunnel(context.Background(), "u1", "alice", "dev1", nil, nil, peer); err != nil {
		t.Fatal(err)
	}
	ops := fc.configureCalls[0].ops
	if anyOpStartsWith(ops, []string{"vpn", "ipsec", "ike-group"}) {
		t.Errorf("ike-group ops emitted despite ike=nil — reuse path is broken")
	}
	if anyOpStartsWith(ops, []string{"vpn", "ipsec", "esp-group"}) {
		t.Errorf("esp-group ops emitted despite esp=nil — reuse path is broken")
	}
	// Peer ops must still be present.
	if !anyOpStartsWith(ops, []string{"vpn", "ipsec", "site-to-site", "peer", "p2"}) {
		t.Errorf("peer ops missing")
	}
}

// CreateTunnel: empty PSK on a fresh tunnel is a bug, not a request to
// preserve. The create path must reject early with a clear error rather
// than fall through to fetchExistingPSK (which would also fail, but with
// a more confusing error).
func TestCreateTunnel_EmptyPSKOnCreateRejected(t *testing.T) {
	svc, _, _ := newTestService()
	peer := model.Peer{
		Name:           "p1",
		RemoteAddress:  "203.0.113.5",
		IKEGroup:       "IKE-DEFAULT",
		Authentication: model.PeerAuth{Mode: model.AuthPSK, PreSharedSecret: ""},
	}
	err := svc.CreateTunnel(context.Background(), "u1", "alice", "dev1", nil, nil, peer)
	if err == nil {
		t.Fatal("expected error for empty PSK on tunnel create")
	}
	if !strings.Contains(err.Error(), "pre_shared_secret") && !strings.Contains(err.Error(), "PSK") {
		t.Errorf("error should mention pre_shared_secret, got: %v", err)
	}
}

// DeletePeer must wipe BOTH the peer subtree AND the sibling PSK block
// (which lives at vpn/ipsec/authentication/psk/<peer-name> on VyOS 1.5).
// Forgetting the PSK deletion leaks the secret on the device.
func TestDeletePeer_AlsoWipesPSK(t *testing.T) {
	svc, fc, _ := newTestService()
	if err := svc.DeletePeer(context.Background(), "u1", "alice", "dev1", "p1"); err != nil {
		t.Fatal(err)
	}
	ops := fc.configureCalls[0].ops

	deletePeer := false
	deletePSK := false
	for _, op := range ops {
		if op.Op != vyos.OpDelete {
			continue
		}
		if matchPathPrefix(op.Path, []string{"vpn", "ipsec", "site-to-site", "peer", "p1"}) {
			deletePeer = true
		}
		if matchPathPrefix(op.Path, []string{"vpn", "ipsec", "authentication", "psk", "p1"}) {
			deletePSK = true
		}
	}
	if !deletePeer {
		t.Errorf("peer subtree delete missing")
	}
	if !deletePSK {
		t.Errorf("psk block delete missing — secret would persist on device after peer is gone")
	}
}

// =============================================================================
// Test infrastructure
// =============================================================================

// newTestService returns a Service wired with fakes. The fakes are
// returned alongside so individual tests can pre-arm Retrieve responses
// and inspect captured Configure / audit calls.
func newTestService() (*Service, *fakeClient, *fakeStore) {
	fc := &fakeClient{
		retrieveResponses: map[string]json.RawMessage{},
	}
	fp := &fakeClientPool{client: fc}
	fs := newFakeStore()

	svc := &Service{
		// store is left nil. Service methods that touch the store go
		// through the s.audit(...) wrapper, which we override below
		// by passing a store-like interface. For these tests we work
		// around it by having runConfigure[Redacted] call back through
		// an injected audit recorder.
		store: nil,
		cp:    fp,
		// auditFn lets the test capture audit calls without needing a
		// real *store.Store. See the s.audit override below.
		auditFn: fs.record,
	}
	return svc, fc, fs
}

// --- Fake VyOS client ------------------------------------------------------

type configureCall struct {
	ops         []vyos.ConfigureOp
	confirmTime int
}

type fakeClient struct {
	configureCalls    []configureCall
	retrieveResponses map[string]json.RawMessage // key = "/"-joined path
}

func (f *fakeClient) Configure(_ context.Context, ops []vyos.ConfigureOp, confirmTime int) error {
	// Copy the slice so the caller can mutate its original after the call
	// without polluting our captured record.
	captured := append([]vyos.ConfigureOp(nil), ops...)
	f.configureCalls = append(f.configureCalls, configureCall{ops: captured, confirmTime: confirmTime})
	return nil
}

func (f *fakeClient) Confirm(_ context.Context) error { return nil }
func (f *fakeClient) Save(_ context.Context) error    { return nil }

func (f *fakeClient) Retrieve(_ context.Context, _ vyos.Op, path []string) (json.RawMessage, error) {
	key := strings.Join(path, "/")
	if resp, ok := f.retrieveResponses[key]; ok {
		return resp, nil
	}
	// Mirror real VyOS behaviour: paths that don't exist return this
	// specific error. fetchExistingPSK matches on the string.
	return nil, &fakeVyosErr{msg: "Configuration under specified path is empty"}
}

func (f *fakeClient) Show(_ context.Context, _ []string) (string, error) { return "", nil }
func (f *fakeClient) Info(_ context.Context) (*vyos.Info, error)         { return &vyos.Info{}, nil }
func (f *fakeClient) Reboot(_ context.Context) error                     { return nil }

type fakeVyosErr struct{ msg string }

func (e *fakeVyosErr) Error() string { return e.msg }

// --- Fake pool -------------------------------------------------------------

type fakeClientPool struct {
	client vyosClient
}

func (p *fakeClientPool) Get(_ context.Context, _ string) (vyosClient, error) {
	return p.client, nil
}

// --- Fake audit recorder ---------------------------------------------------

type auditCall struct {
	userID, userName, deviceID, deviceName, action string
	ops                                            []model.ConfigureOp
	success                                        bool
	errMsg                                         string
}

type fakeStore struct {
	auditCalls []auditCall
}

func newFakeStore() *fakeStore { return &fakeStore{} }

// record matches the auditFn signature expected by the service.
func (s *fakeStore) record(ctx context.Context, userID, userName, deviceID, deviceName, action string,
	ops []model.ConfigureOp, success bool, errMsg string) error {
	s.auditCalls = append(s.auditCalls, auditCall{
		userID: userID, userName: userName,
		deviceID: deviceID, deviceName: deviceName,
		action: action, ops: ops, success: success, errMsg: errMsg,
	})
	return nil
}

// --- Op-path helpers (mirror those in translator_test.go) ----------------

func anyOpPath(ops []vyos.ConfigureOp, want vyos.Op, path ...string) bool {
	for _, o := range ops {
		if o.Op == want && pathEqual(o.Path, path) {
			return true
		}
	}
	return false
}

func anyOpStartsWith(ops []vyos.ConfigureOp, prefix []string) bool {
	for _, o := range ops {
		if matchPathPrefix(o.Path, prefix) {
			return true
		}
	}
	return false
}

func findOpAt(ops []vyos.ConfigureOp, path []string) *vyos.ConfigureOp {
	for i := range ops {
		if pathEqual(ops[i].Path, path) {
			return &ops[i]
		}
	}
	return nil
}

func findAuditOp(ops []model.ConfigureOp, lastSegment string) *model.ConfigureOp {
	for i := range ops {
		if len(ops[i].Path) > 0 && ops[i].Path[len(ops[i].Path)-1] == lastSegment {
			return &ops[i]
		}
	}
	return nil
}

func pathEqual(a, b []string) bool {
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

func matchPathPrefix(p, prefix []string) bool {
	if len(p) < len(prefix) {
		return false
	}
	for i := range prefix {
		if p[i] != prefix[i] {
			return false
		}
	}
	return true
}
