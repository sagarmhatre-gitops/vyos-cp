package service

// IPsec service. Mirrors service/nat_zones_rbac.go: every device write goes
// through runConfigure → commit-confirm → audit. Reads bypass commit-confirm.
//
// PSK handling: the operator-facing JSON carries the PSK in cleartext on
// PUT/POST; the service unseals/reseals as needed but never logs it. The
// audit row's ops[] is sanitized: any "pre-shared-secret" value is replaced
// with "***REDACTED***" before persisting.

import (
	"context"
	"fmt"
	"strings"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
	"github.com/vyos-cp/vyos-cp/internal/vyos/translator"
)

// --- Read ------------------------------------------------------------------

// GetIPsecConfig returns the entire `vpn ipsec` block. Single retrieve, the
// translator decodes globals + ike-groups + esp-groups + peers in one pass.
func (s *Service) GetIPsecConfig(ctx context.Context, deviceID string) (*model.IPsecConfig, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"vpn", "ipsec"})
	if err != nil {
		// VyOS returns this when `vpn ipsec` has never been touched. That's
		// not an error from our perspective — return an empty config so the
		// UI shows empty tables instead of a banner.
		if strings.Contains(err.Error(), "Configuration under specified path is empty") {
			return &model.IPsecConfig{}, nil
		}
		return nil, err
	}
	cfg, err := translator.DecodeIPsec(raw)
	if err != nil {
		return nil, err
	}
	// Never return PSKs to the UI even if a buggy build did surface them.
	for i := range cfg.Peers {
		if cfg.Peers[i].Authentication.PreSharedSecret != "" {
			cfg.Peers[i].Authentication.PreSharedSecret = "(stored)"
		}
	}
	return cfg, nil
}

// GetIPsecStatus runs `show vpn ipsec sa` op-mode and parses to []SAStatus.
// Used by the IPsec page for the live SA table. Read-only; not audited.
func (s *Service) GetIPsecStatus(ctx context.Context, deviceID string) ([]model.SAStatus, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	detail, err := client.Show(ctx, []string{"vpn", "ipsec", "sa", "detail"})
	if err != nil {
		return nil, err
	}
	ver := ""
	if info, ierr := client.Info(ctx); ierr == nil {
		ver = info.Version
	}
	return parseIPsecSADetail(deviceID, "", detail, detectVyOSVersion(ver)), nil
}

// --- Globals ---------------------------------------------------------------

func (s *Service) SetIPsecGlobals(ctx context.Context, userID, userName, deviceID string, g model.IPsecGlobals) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	// Replace the small set of leaves owned by globals; do NOT wipe the
	// whole `vpn ipsec` tree (that would blow away peers/groups).
	ops := []vyos.ConfigureOp{
		{Op: vyos.OpDelete, Path: []string{"vpn", "ipsec", "ipsec-interfaces"}},
		{Op: vyos.OpDelete, Path: []string{"vpn", "ipsec", "nat-traversal"}},
		{Op: vyos.OpDelete, Path: []string{"vpn", "ipsec", "logging"}},
	}
	ops = append(ops, translator.IPsecGlobalsOps(g)...)
	return s.runConfigure(ctx, client, userID, userName, deviceID, "ipsec.globals", ops)
}

// --- IKE groups ------------------------------------------------------------

func (s *Service) UpsertIKEGroup(ctx context.Context, userID, userName, deviceID string, g model.IKEGroup) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	newOps, err := translator.IKEGroupOps(g)
	if err != nil {
		return err
	}
	ops := append(translator.DeleteIKEGroupOps(g.Name), newOps...)
	return s.runConfigure(ctx, client, userID, userName, deviceID, "ipsec.ike.upsert", ops)
}

func (s *Service) DeleteIKEGroup(ctx context.Context, userID, userName, deviceID, name string) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops := translator.DeleteIKEGroupOps(name)
	return s.runConfigure(ctx, client, userID, userName, deviceID, "ipsec.ike.delete", ops)
}

// --- ESP groups ------------------------------------------------------------

func (s *Service) UpsertESPGroup(ctx context.Context, userID, userName, deviceID string, g model.ESPGroup) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	newOps, err := translator.ESPGroupOps(g)
	if err != nil {
		return err
	}
	ops := append(translator.DeleteESPGroupOps(g.Name), newOps...)
	return s.runConfigure(ctx, client, userID, userName, deviceID, "ipsec.esp.upsert", ops)
}

func (s *Service) DeleteESPGroup(ctx context.Context, userID, userName, deviceID, name string) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops := translator.DeleteESPGroupOps(name)
	return s.runConfigure(ctx, client, userID, userName, deviceID, "ipsec.esp.delete", ops)
}

// --- Peers -----------------------------------------------------------------

// UpsertPeer is the high-stakes call: a bad peer can sever the tunnel a
// remote operator depends on. The runConfigure path uses commit-confirm —
// if the operator can't reconnect within CommitConfirmMinutes, VyOS rolls
// back and the tunnel comes back.
func (s *Service) UpsertPeer(ctx context.Context, userID, userName, deviceID string, p model.Peer) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	// PSK preservation: when the operator edits a peer without re-entering
	// the secret, the frontend sends back the "(stored)" sentinel that GET
	// returns. The translator's DeletePeerOps will wipe the existing psk
	// block as part of the atomic delete-then-set, so if we don't restock
	// the secret here the edit silently destroys the PSK. Two cases:
	//
	//   1. Empty value or sentinel + auth mode == PSK → fetch existing secret
	//      from the device and re-supply. If no existing secret is found
	//      (truly a new peer / not a partial edit), return a clear error.
	//   2. Real value supplied → use as-is; this is the create-or-rotate path.
	if p.Authentication.Mode == model.AuthPSK &&
		(p.Authentication.PreSharedSecret == "" || p.Authentication.PreSharedSecret == "(stored)") {
		existing, ferr := s.fetchExistingPSK(ctx, client, p.Name)
		if ferr != nil {
			return fmt.Errorf("peer %q: PSK preservation lookup failed: %w (re-enter the secret to retry)", p.Name, ferr)
		}
		if existing == "" {
			return fmt.Errorf("peer %q: no existing PSK on device — supply pre_shared_secret", p.Name)
		}
		p.Authentication.PreSharedSecret = existing
	}
	newOps, err := translator.PeerOps(p)
	if err != nil {
		return err
	}
	ops := append(translator.DeletePeerOps(p.Name), newOps...)
	// PSK redaction: device gets ops; audit gets a redacted copy so the
	// pre-shared secret never lands in audit_log.ops[].
	auditOps := translator.RedactSecrets(ops)
	return s.runConfigureRedacted(ctx, client, userID, userName, deviceID, "ipsec.peer.upsert", ops, auditOps)
}

func (s *Service) DeletePeer(ctx context.Context, userID, userName, deviceID, name string) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops := translator.DeletePeerOps(name)
	return s.runConfigure(ctx, client, userID, userName, deviceID, "ipsec.peer.delete", ops)
}

// fetchExistingPSK returns the cleartext PSK currently stored at
// vpn ipsec authentication psk <name> secret, or "" if not set. The
// returned value is held in memory only for the duration of UpsertPeer;
// it is not logged and not surfaced to any audit or response payload.
func (s *Service) fetchExistingPSK(ctx context.Context, client vyosClient, peerName string) (string, error) {
	raw, err := client.Retrieve(ctx, vyos.OpReturnVal,
		[]string{"vpn", "ipsec", "authentication", "psk", peerName, "secret"})
	if err != nil {
		// "Configuration under specified path is empty" means no secret on file —
		// that's not an error, it's just "first time for this peer".
		if strings.Contains(err.Error(), "Configuration under specified path is empty") {
			return "", nil
		}
		return "", err
	}
	// returnValue produces a JSON string; strip quotes.
	v := strings.TrimSpace(string(raw))
	v = strings.Trim(v, "\"")
	return v, nil
}

// --- Helpers ---------------------------------------------------------------

// redactPSK returns a copy of ops where any pre-shared-secret value is
// replaced by a sentinel string. Used so the audit row never persists a
// plaintext key. The ops sent to VyOS are the original (unredacted) — this
// runs only inside runConfigure for the audit copy.
//
// Note: runConfigure in nat_zones_rbac.go converts ops via toModelOps after
// the device call; the simplest place to redact is before that conversion.
// Here we operate on the ops list passed to runConfigure so the device call
// still gets the real secret. To make that work we'd need to thread a
// "audit-only ops" parameter through runConfigure. To keep this scaffold
// non-invasive, we instead wrap the call ourselves below and bypass
// runConfigure's audit. Production: extend runConfigure with a
// auditOps []ConfigureOp parameter.
func redactPSK(ops []vyos.ConfigureOp) []vyos.ConfigureOp { return ops }


// CreateTunnel is the wizard endpoint: build a complete IPsec tunnel
// (IKE group + ESP group + peer + PSK) in one atomic /configure call so
// VyOS commits all of it or none. Replaces the 3-sequential-PUT pattern
// that left orphan IKE/ESP groups on the device when an intermediate
// call failed (e.g. nginx 502 during strongSwan cold-start).
//
// ike or esp may be nil — when nil, the caller is opting to reference an
// existing group already on the device. The peer.IKEGroup and
// peer.DefaultESPGroup fields must point at groups that either appear in
// this batch or already exist on the device; VyOS rejects the commit if
// they don't.
//
// Audit: single row, action "ipsec.tunnel.create", ops list contains the
// combined IKE+ESP+peer+psk ops. PSK is redacted via runConfigureRedacted.
func (s *Service) CreateTunnel(ctx context.Context, userID, userName, deviceID string,
	ike *model.IKEGroup, esp *model.ESPGroup, peer model.Peer) error {

	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}

	// PSK preservation does NOT apply on create. An empty PSK here is a
	// bug, not a request to preserve. Reject early with a clear error.
	if peer.Authentication.Mode == model.AuthPSK && peer.Authentication.PreSharedSecret == "" {
		return fmt.Errorf("peer %q: pre_shared_secret is required for new tunnels", peer.Name)
	}

	// Build the combined op list. Order: IKE → ESP → peer → psk. VyOS
	// /configure is atomic across the batch; order matters only for
	// readability since the validator runs on the resulting tree, not
	// op-by-op.
	var ops []vyos.ConfigureOp

	if ike != nil {
		ikeOps, err := translator.IKEGroupOps(*ike)
		if err != nil {
			return fmt.Errorf("encode ike: %w", err)
		}
		// Prefix with a delete so a same-named group is fully replaced
		// rather than merged with leftover leaves from a prior version.
		ops = append(ops, translator.DeleteIKEGroupOps(ike.Name)...)
		ops = append(ops, ikeOps...)
	}
	if esp != nil {
		espOps, err := translator.ESPGroupOps(*esp)
		if err != nil {
			return fmt.Errorf("encode esp: %w", err)
		}
		ops = append(ops, translator.DeleteESPGroupOps(esp.Name)...)
		ops = append(ops, espOps...)
	}

	peerOps, err := translator.PeerOps(peer)
	if err != nil {
		return fmt.Errorf("encode peer: %w", err)
	}
	ops = append(ops, translator.DeletePeerOps(peer.Name)...)
	ops = append(ops, peerOps...)

	// Audit gets the redacted view; device gets the real ops.
	auditOps := translator.RedactSecrets(ops)
	return s.runConfigureRedacted(ctx, client, userID, userName, deviceID,
		"ipsec.tunnel.create", ops, auditOps)
}
