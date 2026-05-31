package service

import (
	"context"
	"fmt"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
	"github.com/vyos-cp/vyos-cp/internal/vyos/translator"
)

// --- NAT -------------------------------------------------------------------

func (s *Service) ListNATRules(ctx context.Context, deviceID string, direction model.NATDirection) ([]model.NATRule, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"nat", string(direction)})
	if err != nil {
		return nil, err
	}
	return translator.DecodeNATRules(direction, raw)
}

func (s *Service) UpsertNATRule(ctx context.Context, userID, userName, deviceID string, r model.NATRule) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	newOps, err := translator.NATRuleOps(r)
	if err != nil {
		return err
	}
	ops := append(translator.DeleteNATRuleOps(r.Direction, r.Number), newOps...)
	return s.runConfigure(ctx, client, userID, userName, deviceID, "nat.upsert", ops)
}

func (s *Service) DeleteNATRule(ctx context.Context, userID, userName, deviceID string, direction model.NATDirection, number int) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops := translator.DeleteNATRuleOps(direction, number)
	return s.runConfigure(ctx, client, userID, userName, deviceID, "nat.delete", ops)
}

// --- Zones -----------------------------------------------------------------

type ZoneConfig struct {
	Zones    []model.Zone        `json:"zones"`
	Policies []model.ZonePolicy  `json:"policies"`
}

func (s *Service) GetZones(ctx context.Context, deviceID string) (*ZoneConfig, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"firewall", "zone"})
	if err != nil {
		return nil, err
	}
	zones, policies, err := translator.DecodeZones(raw)
	if err != nil {
		return nil, err
	}
	return &ZoneConfig{Zones: zones, Policies: policies}, nil
}

func (s *Service) UpsertZone(ctx context.Context, userID, userName, deviceID string, z model.Zone) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	newOps, err := translator.ZoneOps(z)
	if err != nil {
		return err
	}
	ops := append(translator.DeleteZoneOps(z.Name), newOps...)
	return s.runConfigure(ctx, client, userID, userName, deviceID, "zone.upsert", ops)
}

func (s *Service) SetZonePolicy(ctx context.Context, userID, userName, deviceID string, p model.ZonePolicy) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops, err := translator.ZonePolicyOps(p)
	if err != nil {
		return err
	}
	return s.runConfigure(ctx, client, userID, userName, deviceID, "zone.policy", ops)
}

// runConfigure is the shared commit+confirm+save+audit flow.
// The `client` parameter accepts the vyosClient interface so tests can
// inject a fake. In production, *vyos.Client satisfies the interface.
func (s *Service) runConfigure(ctx context.Context, client vyosClient,
	userID, userName, deviceID, action string, ops []vyos.ConfigureOp) error {

	dev, _ := s.getDeviceFn(ctx, deviceID)
	devName := ""
	if dev != nil {
		devName = dev.Name
	}
	err := client.Configure(ctx, ops, CommitConfirmMinutes)
	if err == nil && CommitConfirmMinutes > 0 {
		if confirmErr := client.Confirm(ctx); confirmErr != nil {
			// If confirm fails the commit will revert — surface that as an error.
			err = fmt.Errorf("commit-confirm failed, changes reverted: %w", confirmErr)
		} else {
			_ = client.Save(ctx)
		}
	}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	_ = s.auditFn(ctx, userID, userName, deviceID, devName, action, toModelOps(ops), err == nil, errMsg)
	return err
}

// runConfigureRedacted is runConfigure's secret-aware sibling. The device
// receives `ops` unchanged; the audit log receives `auditOps`. Callers that
// emit secrets (e.g. IPsec UpsertPeer with a PSK) produce auditOps via
// translator.RedactSecrets so secrets never reach the audit table.
//
// Splitting at the runConfigure boundary keeps redaction out of the device
// path entirely — there is no code path where audit-only ops can leak to
// VyOS and no path where unredacted ops can reach the audit table.
func (s *Service) runConfigureRedacted(ctx context.Context, client vyosClient,
	userID, userName, deviceID, action string,
	ops, auditOps []vyos.ConfigureOp) error {

	dev, _ := s.getDeviceFn(ctx, deviceID)
	devName := ""
	if dev != nil {
		devName = dev.Name
	}
	err := client.Configure(ctx, ops, CommitConfirmMinutes)
	if err == nil && CommitConfirmMinutes > 0 {
		if confirmErr := client.Confirm(ctx); confirmErr != nil {
			err = fmt.Errorf("commit-confirm failed, changes reverted: %w", confirmErr)
		} else {
			_ = client.Save(ctx)
		}
	}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	_ = s.auditFn(ctx, userID, userName, deviceID, devName, action, toModelOps(auditOps), err == nil, errMsg)
	return err
}

// --- RBAC helpers ----------------------------------------------------------

// RoleAllows checks whether any of the user's roles permits action.
// The rule is simple: admin=all, operator=write, viewer=read-only.
func RoleAllows(roles []string, action string) bool {
	hasAdmin := false
	hasOperator := false
	for _, r := range roles {
		switch model.Role(r) {
		case model.RoleAdmin:
			hasAdmin = true
		case model.RoleOperator:
			hasOperator = true
		}
	}
	if hasAdmin {
		return true
	}
	// Mutating actions start with one of these prefixes.
	write := []string{"device.add", "device.delete", "device.update",
		"rule.upsert", "rule.delete",
		"ruleset.push", "ruleset.delete",
		"group.upsert", "group.delete",
		"nat.upsert", "nat.delete",
		"zone.upsert", "zone.policy", "zone.delete",
		"interface.upsert",
		"qos.upsert", "qos.delete", "qos.bind",
		"snmp.upsert", "snmp.delete",
		"ipsec.globals",
		"ipsec.ike.upsert", "ipsec.ike.delete",
		"ipsec.esp.upsert", "ipsec.esp.delete",
		"ipsec.peer.upsert", "ipsec.peer.delete",
		"ipsec.tunnel.create",
		"vpn.profile.upsert", "vpn.profile.delete",
		"template.save", "user.create"}
	for _, a := range write {
		if action == a {
			return hasOperator
		}
	}
	// Everything else (reads, /me) is allowed for any authenticated user.
	return true
}
