package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
	"github.com/vyos-cp/vyos-cp/internal/vyos/translator"
)

// --- Groups ----------------------------------------------------------------

// DeleteGroup removes an address/network/port group from the device. VyOS
// will reject the commit if the group is referenced by a firewall rule,
// surfacing an error the caller can show to the user.
func (s *Service) DeleteGroup(ctx context.Context, userID, userName, deviceID, kind, name string) error {
	if kind == "" || name == "" {
		return fmt.Errorf("group kind and name required")
	}
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops := []vyos.ConfigureOp{{
		Op:   vyos.OpDelete,
		Path: []string{"firewall", "group", kind, name},
	}}
	return s.runConfigure(ctx, client, userID, userName, deviceID, "group.delete", ops)
}

// --- Rule-sets -------------------------------------------------------------

// DeleteRuleSet removes an entire named rule-set. VyOS blocks the commit if
// the rule-set is referenced by a zone policy.
func (s *Service) DeleteRuleSet(ctx context.Context, userID, userName, deviceID, family, name string) error {
	if family == "" || name == "" {
		return fmt.Errorf("rule-set family and name required")
	}
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops := []vyos.ConfigureOp{{
		Op:   vyos.OpDelete,
		Path: []string{"firewall", family, "name", name},
	}}
	return s.runConfigure(ctx, client, userID, userName, deviceID, "ruleset.delete", ops)
}

// --- Zones -----------------------------------------------------------------

// DeleteZoneFull removes a zone and cascades: VyOS requires its inter-zone
// policies to be removed first, so we delete them in the same batch.
func (s *Service) DeleteZoneFull(ctx context.Context, userID, userName, deviceID, zoneName string) error {
	if zoneName == "" {
		return fmt.Errorf("zone name required")
	}
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops := translator.DeleteZoneOps(zoneName)
	return s.runConfigure(ctx, client, userID, userName, deviceID, "zone.delete", ops)
}

// --- QoS bindings listing --------------------------------------------------

// ListTrafficPolicyBindings inspects qos.interface in the running config and
// returns every interface that has a policy bound, with direction. Two-
// direction bindings (egress + IFB-redirected ingress shaping) are detected
// by cross-referencing interfaces.<kind>.<iface>.redirect — when the
// physical interface redirects to an IFB that ALSO has its own qos binding,
// we mark ShapeIngress=true so the UI can show an "ingress shaping" badge
// and the unbind path knows to clean up the IFB plumbing.
//
// VyOS 1.5 response shapes (confirmed via /retrieve in the customer env):
//   GET qos.interface     → {"interface": {"eth0": {"egress": "policy"}, ...}}
//   GET interfaces.ethernet.eth0.redirect → {"redirect": "ifb2"}
// Both wrap the response with the last path segment as the outer key — a
// shape change introduced in 1.5-rolling. Earlier versions of this function
// looked at interfaces.<kind>.<name>.traffic-policy which never existed in
// 1.5; that's why the bindings list was always empty.
func (s *Service) ListTrafficPolicyBindings(ctx context.Context, deviceID string) ([]model.TrafficPolicyBinding, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}

	// 1) Load qos.interface to find every interface with any direction bound.
	qosRaw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"qos", "interface"})
	if err != nil {
		// "is empty" / "does not exist" mean no policies bound — return [].
		// Any other error bubbles up so the UI shows a real error rather
		// than a misleading empty list.
		if strings.Contains(err.Error(), "is empty") ||
			strings.Contains(err.Error(), "does not exist") ||
			strings.Contains(err.Error(), "not valid") {
			return []model.TrafficPolicyBinding{}, nil
		}
		return nil, err
	}
	if len(qosRaw) == 0 || string(qosRaw) == "null" {
		return []model.TrafficPolicyBinding{}, nil
	}

	// VyOS 1.5 wraps with the last-segment outer key. Strip it.
	var qosWrap struct {
		Interface map[string]map[string]string `json:"interface"`
	}
	if err := json.Unmarshal(qosRaw, &qosWrap); err != nil {
		// Don't silently swallow — log so future shape changes are visible
		// in the cp logs rather than producing mysterious empty lists.
		log.Printf("qos: list bindings: unmarshal qos.interface failed: %v; raw=%s", err, string(qosRaw))
		return []model.TrafficPolicyBinding{}, nil
	}
	if len(qosWrap.Interface) == 0 {
		return []model.TrafficPolicyBinding{}, nil
	}

	// 2) Load interfaces tree to discover the kind (ethernet/bonding/input)
	// of each iface and any redirect relationships. This is best-effort —
	// if it fails we still return the qos bindings, just without
	// ShapeIngress detection.
	type ifaceMeta struct {
		Kind     string // "ethernet", "input" (IFB), "bonding", ...
		Redirect string // for ethernet only — name of the IFB it redirects to
	}
	meta := map[string]ifaceMeta{}

	ifsRaw, ifsErr := client.Retrieve(ctx, vyos.OpShowConfig, []string{"interfaces"})
	if ifsErr == nil && len(ifsRaw) > 0 && string(ifsRaw) != "null" {
		var ifsWrap struct {
			Interfaces map[string]map[string]struct {
				Redirect string `json:"redirect,omitempty"`
			} `json:"interfaces"`
		}
		if err := json.Unmarshal(ifsRaw, &ifsWrap); err == nil {
			for kind, ifaces := range ifsWrap.Interfaces {
				for name, body := range ifaces {
					meta[name] = ifaceMeta{Kind: kind, Redirect: body.Redirect}
				}
			}
		} else {
			log.Printf("qos: list bindings: unmarshal interfaces failed (non-fatal): %v", err)
		}
	}

	// 3) Build the binding list. Each (iface, direction) → one row.
	// Skip IFB inputs whose policy is the "shadow" of a physical iface's
	// ingress shaping — they show up implicitly via ShapeIngress on the
	// physical row, not as their own row.
	ifbsAsShadow := map[string]bool{}
	for _, m := range meta {
		if m.Kind == "ethernet" && m.Redirect != "" {
			// The redirected-to IFB is a "shadow" only if it has a qos binding.
			if _, hasQoS := qosWrap.Interface[m.Redirect]; hasQoS {
				ifbsAsShadow[m.Redirect] = true
			}
		}
	}

	var out []model.TrafficPolicyBinding
	for iface, dirs := range qosWrap.Interface {
		if ifbsAsShadow[iface] {
			continue // hidden — surfaces via the physical iface's row instead
		}
		for dir, policy := range dirs {
			if policy == "" {
				continue
			}
			b := model.TrafficPolicyBinding{
				PolicyName: policy,
				Interface:  iface,
				Kind:       meta[iface].Kind,
				Direction:  dir,
			}
			// Two-direction shaping detection: this physical iface redirects
			// to an IFB that has its own qos binding. The unbind path needs
			// this flag to know to clean up the IFB + redirect too.
			if m, ok := meta[iface]; ok && m.Kind == "ethernet" && m.Redirect != "" {
				if _, hasQoS := qosWrap.Interface[m.Redirect]; hasQoS {
					b.ShapeIngress = true
					b.IFB = m.Redirect
				}
			}
			out = append(out, b)
		}
	}
	return out, nil
}

// --- Device updates --------------------------------------------------------

// UpdateDevice modifies an existing device's mutable fields. Name and ID are
// immutable; address, hostname, api key and tls verification are editable.
// If apiKey is non-empty, it replaces the sealed ciphertext.
// DeviceUpdate is the patch shape for UpdateDevice. Each field is a pointer
// so callers can leave it nil to keep the existing value (PATCH semantics).
// Using pointers also lets us distinguish "unset to empty" (a non-nil empty
// pointer) from "not provided" (nil), which matters for tags and location
// where empty is a real value.
type DeviceUpdate struct {
	Name               *string
	Address            *string
	Hostname           *string
	APIKey             *string
	InsecureSkipVerify *bool
	Tags               *[]string
	Location           *string
}

func (s *Service) UpdateDevice(ctx context.Context, userID, userName, deviceID string, u DeviceUpdate) error {
	existing, err := s.store.GetDevice(ctx, deviceID)
	if err != nil {
		return err
	}
	if u.Name != nil {
		existing.Name = *u.Name
	}
	if u.Address != nil && *u.Address != "" {
		existing.Address = *u.Address
	}
	if u.Hostname != nil {
		existing.Hostname = *u.Hostname
	}
	if u.InsecureSkipVerify != nil {
		existing.InsecureSkipVerify = *u.InsecureSkipVerify
	}
	if u.Tags != nil {
		existing.Tags = *u.Tags
	}
	if u.Location != nil {
		existing.Location = *u.Location
	}
	apiKey := ""
	if u.APIKey != nil {
		apiKey = *u.APIKey
	}
	if err := s.store.UpdateDevice(ctx, *existing, apiKey); err != nil {
		return err
	}
	_ = s.store.RecordAudit(ctx, model.AuditEntry{
		UserID: userID, UserName: userName,
		Action: "device.update", DeviceID: deviceID, Device: existing.Name,
		Success: true,
	})
	// Invalidate any cached client so the next call uses the new address/key.
	s.clients.Invalidate(deviceID)
	return nil
}
