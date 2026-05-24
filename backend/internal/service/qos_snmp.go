package service

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
	"github.com/vyos-cp/vyos-cp/internal/vyos/translator"
)

// --- QoS -------------------------------------------------------------------

// ListTrafficPolicies reads all traffic-policy definitions from the device.
func (s *Service) ListTrafficPolicies(ctx context.Context, deviceID string) ([]model.TrafficPolicy, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"qos", "policy"})
	if err != nil {
		if strings.Contains(err.Error(), "is empty") ||
			strings.Contains(err.Error(), "not valid") ||
			strings.Contains(err.Error(), "is not configured") {
			return []model.TrafficPolicy{}, nil
		}
		return nil, err
	}
	return translator.DecodeTrafficPolicies(raw)
}

// UpsertTrafficPolicy commits a policy atomically (delete + set). Covers
// HTB, HFSC, and FQ-CoDel via the engine field.
func (s *Service) UpsertTrafficPolicy(ctx context.Context, userID, userName, deviceID string, p model.TrafficPolicy) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops, err := translator.TrafficPolicyOps(p)
	if err != nil {
		return err
	}
	return s.runConfigure(ctx, client, userID, userName, deviceID, "qos.upsert", ops)
}

func (s *Service) DeleteTrafficPolicy(ctx context.Context, userID, userName, deviceID string, engine model.QoSEngine, name string) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}

	// Cascade-unbind first. VyOS validates referential integrity at commit
	// time: if any qos.interface.<iface>.<dir> still references this policy
	// after the delete, the commit fails with
	//   [ qos ] Selected QoS policy "<name>" does not exist!
	// We discover the affected interfaces by re-using the same parser the
	// bindings list page uses, then emit UnbindOps for each. Both unbind
	// and delete go in the same /configure call so VyOS sees them as one
	// atomic transaction — no half-committed intermediate state possible.
	bindings, err := s.ListTrafficPolicyBindings(ctx, deviceID)
	if err != nil {
		return fmt.Errorf("could not enumerate bindings before delete: %w", err)
	}

	var ops []vyos.ConfigureOp
	for _, b := range bindings {
		if b.PolicyName != name {
			continue
		}
		// Reuse the same UnbindOps translator the per-row unbind button
		// uses; it handles the ShapeIngress (IFB + redirect) cleanup so
		// two-direction bindings are unwound completely.
		ops = append(ops, translator.UnbindOps(b)...)
	}

	deleteOps, err := translator.DeleteTrafficPolicyOps(engine, name)
	if err != nil {
		return err
	}
	ops = append(ops, deleteOps...)

	return s.runConfigure(ctx, client, userID, userName, deviceID, "qos.delete", ops)
}

func (s *Service) BindTrafficPolicy(ctx context.Context, userID, userName, deviceID string, b model.TrafficPolicyBinding) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	// If two-direction shaping is requested and the caller hasn't picked an
	// IFB name, find one that:
	//   1) the kernel has actually instantiated (in /sys/class/net) — VyOS
	//      rejects the commit otherwise with "Incorrect path /sys/class/net/<n>"
	//   2) isn't already in use by another binding's qos/interfaces-input
	//
	// This is the proper pre-flight check that earlier patches missed.
	if b.ShapeIngress && b.IFB == "" {
		kernel, err := s.kernelIFBNames(ctx, client)
		if err != nil {
			return fmt.Errorf("could not enumerate kernel IFB devices: %w", err)
		}
		if len(kernel) == 0 {
			return fmt.Errorf("device has no IFB kernel devices (numifbs=0); " +
				"raise it on the device with `modprobe ifb numifbs=4` (or persist " +
				"via /etc/modprobe.d/ifb.conf), reboot, then retry")
		}
		used, err := s.usedIFBNames(ctx, client)
		if err != nil {
			return fmt.Errorf("could not enumerate IFB usage: %w", err)
		}
		picked := ""
		for _, name := range kernel {
			if !used[name] {
				picked = name
				break
			}
		}
		if picked == "" {
			return fmt.Errorf("all %d kernel IFB devices are in use; "+
				"unbind an existing two-direction binding or raise numifbs", len(kernel))
		}
		b.IFB = picked
	}
	ops, err := translator.BindingOps(b)
	if err != nil {
		return err
	}
	return s.runConfigure(ctx, client, userID, userName, deviceID, "qos.bind", ops)
}

// kernelIFBNames returns the IFB devices the kernel has pre-allocated, in
// numerical order. We probe via `show interfaces` and filter for names
// matching `ifb\d+`. This is the source of truth for what `interfaces input`
// will accept on commit.
func (s *Service) kernelIFBNames(ctx context.Context, client vyosClient) ([]string, error) {
	raw, err := client.Show(ctx, []string{"interfaces"})
	if err != nil {
		return nil, err
	}
	// `show interfaces` returns text columns; we only need to find ifbN names.
	var found []string
	seen := map[string]bool{}
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		name := fields[0]
		if !isIFBName(name) {
			continue
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		found = append(found, name)
	}
	// Sort numerically: ifb0, ifb1, ifb2, ifb10 — not lexicographic.
	sort.Slice(found, func(i, j int) bool {
		ni, _ := strconv.Atoi(strings.TrimPrefix(found[i], "ifb"))
		nj, _ := strconv.Atoi(strings.TrimPrefix(found[j], "ifb"))
		return ni < nj
	})
	return found, nil
}

// usedIFBNames returns the set of IFB names currently bound by the device's
// configuration. Reads from `interfaces input` and `qos interface`.
func (s *Service) usedIFBNames(ctx context.Context, client vyosClient) (map[string]bool, error) {
	used := map[string]bool{}

	// `interfaces input` — explicit IFB declarations.
	if raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"interfaces", "input"}); err == nil {
		var tree map[string]json.RawMessage
		if json.Unmarshal(raw, &tree) == nil {
			// VyOS may wrap with an "input" outer key; unwrap if so.
			if inner, ok := tree["input"]; ok && len(tree) == 1 {
				_ = json.Unmarshal(inner, &tree)
			}
			for name := range tree {
				used[name] = true
			}
		}
	}

	// Also any names referenced by `qos interface` that look like IFBs —
	// belt-and-suspenders in case the input declaration is missing.
	if raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"qos", "interface"}); err == nil {
		var tree map[string]json.RawMessage
		if json.Unmarshal(raw, &tree) == nil {
			if inner, ok := tree["interface"]; ok && len(tree) == 1 {
				_ = json.Unmarshal(inner, &tree)
			}
			for name := range tree {
				if isIFBName(name) {
					used[name] = true
				}
			}
		}
	}
	return used, nil
}

func (s *Service) UnbindTrafficPolicy(ctx context.Context, userID, userName, deviceID string, b model.TrafficPolicyBinding) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}

	// We always want full cleanup of any IFB pairing, regardless of which row
	// the user clicked. Two cases converge on the same op set:
	//
	//   A) User clicked the real interface row (e.g. eth0). Look up its
	//      redirect target — if it points to an IFB, that's our pair; tear
	//      down both ends.
	//   B) User clicked the IFB row (e.g. ifb0). Find which real interface
	//      redirects to it; tear down that pair from the IFB perspective.
	//
	// Either way we end up with the same (realIface, ifb) tuple and emit the
	// same 4 deletes via translator.UnbindOps with ShapeIngress=true.

	var realIface, ifb, kind string

	if isIFBName(b.Interface) {
		// Branch B: user clicked the IFB row.
		ifb = b.Interface
		var err error
		realIface, kind, err = s.findRedirectorOf(ctx, client, ifb)
		if err != nil || realIface == "" {
			// No real interface points to this IFB — it's a bare orphan.
			// Just delete the IFB-side artefacts.
			return s.runConfigure(ctx, client, userID, userName, deviceID, "qos.unbind",
				orphanedIFBCleanupOps(ifb))
		}
	} else {
		// Branch A: user clicked a real interface row.
		realIface = b.Interface
		kind = b.Kind
		if kind == "" {
			kind = "ethernet"
		}
		// See if there's an IFB pairing to clean up. Authoritative: ask the
		// device what redirect target this interface has, regardless of
		// what the UI thought.
		if name, lerr := s.lookupRedirectTarget(ctx, client, realIface, kind); lerr == nil && name != "" {
			ifb = name
		}
	}

	// Build the unbind binding from what we resolved. ShapeIngress=true iff
	// we actually found a paired IFB; that drives the 4-op cleanup.
	cleanup := model.TrafficPolicyBinding{
		Interface:    realIface,
		Kind:         kind,
		Direction:    "egress",
		ShapeIngress: ifb != "",
		IFB:          ifb,
	}
	ops := translator.UnbindOps(cleanup)
	return s.runConfigure(ctx, client, userID, userName, deviceID, "qos.unbind", ops)
}

// findRedirectorOf scans `interfaces ethernet *.redirect` looking for the
// one redirecting traffic into the given IFB. Returns the real iface + kind.
func (s *Service) findRedirectorOf(ctx context.Context, client vyosClient, ifb string) (string, string, error) {
	for _, kind := range []string{"ethernet", "bonding", "bridge"} {
		raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"interfaces", kind})
		if err != nil {
			continue
		}
		var tree map[string]json.RawMessage
		if json.Unmarshal(raw, &tree) == nil {
			// Unwrap if VyOS 1.5 wrapped under last-segment.
			if inner, ok := tree[kind]; ok && len(tree) == 1 {
				_ = json.Unmarshal(inner, &tree)
			}
			for name, body := range tree {
				var props map[string]json.RawMessage
				if json.Unmarshal(body, &props) != nil {
					continue
				}
				if r, ok := props["redirect"]; ok {
					var target string
					if json.Unmarshal(r, &target) == nil && target == ifb {
						return name, kind, nil
					}
				}
			}
		}
	}
	return "", "", nil
}

// orphanedIFBCleanupOps emits the standalone deletes needed to remove an
// IFB's qos binding and `interfaces input` declaration. Used when a user
// unbinds directly from an IFB row — we don't try to delete a redirect we
// don't know about.
func orphanedIFBCleanupOps(ifb string) []vyos.ConfigureOp {
	return []vyos.ConfigureOp{
		{Op: vyos.OpDelete, Path: []string{"qos", "interface", ifb}},
		{Op: vyos.OpDelete, Path: []string{"interfaces", "input", ifb}},
	}
}

// isIFBName matches the kernel's IFB device naming: "ifb" + digits.
func isIFBName(s string) bool {
	if len(s) < 4 || s[:3] != "ifb" {
		return false
	}
	for _, r := range s[3:] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// ifNameStr is a placeholder kept for readability; not used directly.
func ifNameStr(_ bool, s string) string { return s }

// lookupRedirectTarget reads `interfaces ethernet <name> redirect` from the
// device and returns the configured target (an IFB name, typically). Returns
// empty string when no redirect is configured.
func (s *Service) lookupRedirectTarget(ctx context.Context, client vyosClient, iface, kind string) (string, error) {
	if kind == "" {
		kind = "ethernet"
	}
	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"interfaces", kind, iface, "redirect"})
	if err != nil {
		return "", nil
	}
	var s_ string
	if json.Unmarshal(raw, &s_) == nil {
		return s_, nil
	}
	return "", nil
}

// --- SNMP ------------------------------------------------------------------

// GetSNMPConfig reads the device's SNMP state. Password fields will be empty
// since VyOS doesn't return them via /retrieve.
func (s *Service) GetSNMPConfig(ctx context.Context, deviceID string) (*model.SNMPConfig, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"service", "snmp"})
	if err != nil {
		// VyOS returns "Configuration under specified path is empty" when
		// the path simply hasn't been configured yet. Treat that as an
		// empty config rather than a fetch failure, so the UI can render
		// the editor for first-time configuration.
		if strings.Contains(err.Error(), "is empty") ||
			strings.Contains(err.Error(), "not valid") ||
			strings.Contains(err.Error(), "is not configured") {
			return &model.SNMPConfig{}, nil
		}
		return nil, err
	}
	return translator.DecodeSNMPConfig(raw)
}

// UpsertSNMPConfig replaces the SNMP config on a device. Enforces the
// production-tag guard: if the device has tag "production" (case-insensitive)
// and the new config defines any v2c communities, the commit is refused with
// ErrV2CBlocked. v3 trap targets are fine on production; v2c trap targets
// are not.
func (s *Service) UpsertSNMPConfig(ctx context.Context, userID, userName, deviceID string, c model.SNMPConfig) error {
	dev, err := s.store.GetDevice(ctx, deviceID)
	if err != nil {
		return err
	}
	if isProduction(dev.Tags) {
		if violation := findV2CViolations(c); violation != "" {
			return fmt.Errorf("%w: %s", ErrV2CBlocked, violation)
		}
	}

	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops, err := translator.SNMPConfigOps(c)
	if err != nil {
		return err
	}
	return s.runConfigure(ctx, client, userID, userName, deviceID, "snmp.upsert", ops)
}

// ErrV2CBlocked is returned when a v2c config is attempted on a device
// tagged "production". Surface as HTTP 409 Conflict in the API layer.
var ErrV2CBlocked = fmt.Errorf("snmpv2c is not permitted on production devices")

// isProduction returns true if any tag matches "production" (case-insensitive).
func isProduction(tags []string) bool {
	for _, t := range tags {
		if strings.EqualFold(strings.TrimSpace(t), "production") {
			return true
		}
	}
	return false
}

// findV2CViolations returns a human-readable description of the first v2c
// element found in the config, or "" if none.
func findV2CViolations(c model.SNMPConfig) string {
	if len(c.Communities) > 0 {
		return fmt.Sprintf("found %d v2c community definition(s); remove them and configure v3 users instead", len(c.Communities))
	}
	for _, t := range c.TrapTargets {
		if t.Version == model.SNMPv2c {
			return fmt.Sprintf("trap-target %q uses SNMPv2c; switch to v3", t.Address)
		}
	}
	return ""
}

// DeleteSNMPConfig removes the entire `service snmp` subtree from the device.
func (s *Service) DeleteSNMPConfig(ctx context.Context, userID, userName, deviceID string) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops := []vyos.ConfigureOp{{
		Op:   vyos.OpDelete,
		Path: []string{"service", "snmp"},
	}}
	return s.runConfigure(ctx, client, userID, userName, deviceID, "snmp.delete", ops)
}

// CleanupOrphanedIFBs scans the device for IFB-related config that no longer
// has a complete pairing and deletes the orphans. We consider an IFB a
// "complete" pair when ALL THREE of these exist:
//
//   - interfaces input <ifbN> declared
//   - some interfaces <kind> <X> redirect = <ifbN>
//   - qos interface <ifbN> egress <policy>
//
// Anything missing one of those legs is an orphan from a partial cleanup or
// an interrupted commit. We emit deletes for the dangling pieces. Bookkeeping
// errors aren't fatal — best-effort.
func (s *Service) CleanupOrphanedIFBs(ctx context.Context, userID, userName, deviceID string) (int, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return 0, err
	}

	// Collect declared inputs.
	declared := map[string]bool{}
	if raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"interfaces", "input"}); err == nil {
		var tree map[string]json.RawMessage
		if json.Unmarshal(raw, &tree) == nil {
			if inner, ok := tree["input"]; ok && len(tree) == 1 {
				_ = json.Unmarshal(inner, &tree)
			}
			for n := range tree {
				declared[n] = true
			}
		}
	}

	// Collect IFBs referenced by qos.interface.
	qosBound := map[string]bool{}
	if raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"qos", "interface"}); err == nil {
		var tree map[string]json.RawMessage
		if json.Unmarshal(raw, &tree) == nil {
			if inner, ok := tree["interface"]; ok && len(tree) == 1 {
				_ = json.Unmarshal(inner, &tree)
			}
			for n := range tree {
				if isIFBName(n) {
					qosBound[n] = true
				}
			}
		}
	}

	// Collect IFBs referenced by any interface's redirect= leaf.
	redirected := map[string]bool{}
	for _, kind := range []string{"ethernet", "bonding", "bridge"} {
		raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"interfaces", kind})
		if err != nil {
			continue
		}
		var tree map[string]json.RawMessage
		if json.Unmarshal(raw, &tree) == nil {
			if inner, ok := tree[kind]; ok && len(tree) == 1 {
				_ = json.Unmarshal(inner, &tree)
			}
			for _, body := range tree {
				var props map[string]json.RawMessage
				if json.Unmarshal(body, &props) != nil {
					continue
				}
				if r, ok := props["redirect"]; ok {
					var t string
					if json.Unmarshal(r, &t) == nil && isIFBName(t) {
						redirected[t] = true
					}
				}
			}
		}
	}

	// Decide which IFBs are orphans. Any IFB that's declared OR has-qos OR
	// is-redirected to, but is missing at least one of the other legs, is
	// orphaned. We delete the legs it does have so the slate is clean.
	all := map[string]bool{}
	for k := range declared {
		all[k] = true
	}
	for k := range qosBound {
		all[k] = true
	}
	for k := range redirected {
		all[k] = true
	}

	var ops []vyos.ConfigureOp
	cleaned := 0
	for ifb := range all {
		if declared[ifb] && qosBound[ifb] && redirected[ifb] {
			continue // healthy pairing, leave alone
		}
		// Orphan — delete whatever legs exist.
		if qosBound[ifb] {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpDelete, Path: []string{"qos", "interface", ifb}})
		}
		if declared[ifb] {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpDelete, Path: []string{"interfaces", "input", ifb}})
		}
		// Note: we don't proactively delete redirects pointing at this ifb here —
		// if a real interface still redirects to it, the operator wants that
		// pairing intact and we should restore the declaration instead. For now
		// flagging only deletes the dangling halves, not the cross-references.
		cleaned++
	}

	if len(ops) == 0 {
		return 0, nil
	}
	if err := s.runConfigure(ctx, client, userID, userName, deviceID, "qos.cleanup", ops); err != nil {
		return 0, err
	}
	return cleaned, nil
}
