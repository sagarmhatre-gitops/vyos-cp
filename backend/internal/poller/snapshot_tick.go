package poller

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
)

// readSnapshotEveryTicks reads VYOS_CP_SNAPSHOT_INTERVAL_TICKS at startup.
// Default 30 (= 5 minutes at the default 10s poll interval). Zero disables
// automatic capture while leaving the manual POST /snapshot path intact.
func readSnapshotEveryTicks() uint64 {
	if v := os.Getenv("VYOS_CP_SNAPSHOT_INTERVAL_TICKS"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			return n
		}
	}
	return 30
}

// maybeCaptureSnapshot is called once per pollOne at the tail. On every
// snapshotEveryTicks-th call for a given device it captures a snapshot.
// Per-device counters so a newly-onboarded device captures immediately
// rather than waiting up to 5 minutes.
func (p *Poller) maybeCaptureSnapshot(ctx context.Context, deviceID string, client *vyos.Client) {
	if p.snapshotEveryTicks == 0 {
		return
	}
	v, _ := p.snapshotTickCounter.LoadOrStore(deviceID, new(uint64))
	counter := v.(*uint64)
	n := atomic.AddUint64(counter, 1)
	if n != 1 && (n-1)%p.snapshotEveryTicks != 0 {
		return
	}
	p.captureSnapshot(ctx, deviceID, client)
}

// captureSnapshot is the single place that turns "live VyOS config" into a
// stored snapshot row. Both the periodic tick and the manual API call route
// through here so the wire shape (raw JSON tree → DeviceConfig.Extra) is
// identical regardless of trigger.
func (p *Poller) captureSnapshot(ctx context.Context, deviceID string, client *vyos.Client) {
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	raw, err := client.Retrieve(cctx, vyos.OpShowConfig, []string{})
	if err != nil {
		log.Printf("snapshot: retrieve failed device=%s err=%v", deviceID, err)
		return
	}
	var tree map[string]any
	if err := json.Unmarshal(raw, &tree); err != nil {
		log.Printf("snapshot: decode failed device=%s err=%v", deviceID, err)
		return
	}
	cfg := routeSnapshotTree(tree) // snapshot routing v1
	if _, err := p.store.AppendSnapshot(cctx, model.DeviceSnapshot{
		DeviceID: deviceID,
		Source:   model.SourceDevice,
		Config:   cfg,
	}); err != nil {
		log.Printf("snapshot: persist failed device=%s err=%v", deviceID, err)
	}
}

// CaptureSnapshot is the exported entry point used by the API handler for
// the manual "Refresh now" button. Resolves the client itself since the
// handler doesn't have one in scope.
func (p *Poller) CaptureSnapshot(ctx context.Context, deviceID string) {
	client, err := p.getClient(ctx, deviceID)
	if err != nil {
		log.Printf("snapshot: client unavailable device=%s err=%v", deviceID, err)
		return
	}
	p.captureSnapshot(ctx, deviceID, client)
}


// routeSnapshotTree turns a raw VyOS /retrieve response into a DeviceConfig
// with well-known sub-trees in their typed fields and anything else in Extra.
//
// This is intentionally simple: it pulls firewall/nat/interfaces if present,
// routes their known sub-keys into typed fields, and stores unmodeled
// sub-keys in a Residual map on each sub-config. Anything we don't recognise
// at the top level (protocols, qos, service, system, vpn, vrf, ...) lands in
// Extra so it's preserved losslessly for future modeling.
func routeSnapshotTree(tree map[string]any) model.DeviceConfig {
	cfg := model.DeviceConfig{}

	if fw, ok := tree["firewall"].(map[string]any); ok {
		cfg.Firewall = routeFirewall(fw)
		delete(tree, "firewall")
	}
	if nat, ok := tree["nat"].(map[string]any); ok {
		cfg.NAT = routeNAT(nat)
		delete(tree, "nat")
	}
	if iface, ok := tree["interfaces"].(map[string]any); ok {
		cfg.Interfaces = routeInterfaces(iface)
		delete(tree, "interfaces")
	}

	if len(tree) > 0 {
		cfg.Extra = tree
	}
	return cfg
}

func routeFirewall(fw map[string]any) model.FirewallConfig {
	out := model.FirewallConfig{}
	if v, ok := fw["ipv4"].(map[string]any); ok {
		out.IPv4 = v
		delete(fw, "ipv4")
	}
	if v, ok := fw["ipv6"].(map[string]any); ok {
		out.IPv6 = v
		delete(fw, "ipv6")
	}
	if len(fw) > 0 {
		out.Residual = fw
	}
	return out
}

func routeNAT(nat map[string]any) model.NATConfig {
	out := model.NATConfig{}
	if v, ok := nat["source"].(map[string]any); ok {
		out.Source = v
		delete(nat, "source")
	}
	if v, ok := nat["destination"].(map[string]any); ok {
		out.Destination = v
		delete(nat, "destination")
	}
	if len(nat) > 0 {
		out.Residual = nat
	}
	return out
}

func routeInterfaces(iface map[string]any) model.InterfacesConfig {
	out := model.InterfacesConfig{}
	if v, ok := iface["ethernet"].(map[string]any); ok {
		out.Ethernet = v
		delete(iface, "ethernet")
	}
	if v, ok := iface["bonding"].(map[string]any); ok {
		out.Bonding = v
		delete(iface, "bonding")
	}
	if v, ok := iface["vlan"].(map[string]any); ok {
		out.VLAN = v
		delete(iface, "vlan")
	}
	if len(iface) > 0 {
		out.Residual = iface
	}
	return out
}
