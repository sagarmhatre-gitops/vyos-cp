package service

// VPN peers — service layer for the fleet-wide peer management surface
// (Phase 3A). Read-only fleet view + delete; create/edit are routed back
// to the existing per-device IPsec wizard (Commit 3 will add deep-link
// support so the redirect lands directly in the wizard).
//
// Source-of-truth rules (same as vpn_profiles.go):
//   - VyOS is authoritative for "what peers exist + config"
//   - vpn_peers table is authoritative for management metadata
//     (description, tags, audit timestamps)
//
// Lazy-create semantics: peers that exist on VyOS but have no Postgres
// row are returned with a deterministic synthesized UUID and empty
// metadata. The first metadata write (Phase 3B) would create the row,
// preserving the UUID.
//
// Orphan Postgres rows (VyOS peer deleted out-of-band) are garbage-
// collected on the next fleet read.

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/store"
)

// vpnPeerNamespace is a fixed UUID used to derive deterministic UUIDs
// for VyOS peers that don't yet have a Postgres row. Generated once
// and frozen — changing it would invalidate every existing synthesized
// peer URL. Distinct from vpnProfileNamespace so a peer and a profile
// with the same name never collide on UUID.
var vpnPeerNamespace = uuid.MustParse("7e5c8d92-4b3f-4a8b-b1d2-9c5e7f1a3b4c")

// synthesizeVPNPeerID returns the deterministic UUID for a peer
// identified by (device_id, name). Stable across calls.
func synthesizeVPNPeerID(deviceID, name string) string {
	return uuid.NewSHA1(vpnPeerNamespace,
		[]byte(deviceID+"\x00"+name)).String()
}

// ListVPNPeers fans out across every device in the fleet, fetches
// the peer list from each, and joins with Postgres metadata.
// Returns one VPNPeer per (device, name) pair.
//
// Garbage-collects orphan Postgres rows: any metadata row whose
// (device_id, name) no longer corresponds to a VyOS-side peer is
// deleted.
func (s *Service) ListVPNPeers(ctx context.Context) ([]model.VPNPeer, error) {
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}

	var (
		mu  sync.Mutex
		out []model.VPNPeer
		wg  sync.WaitGroup
	)
	// Bounded concurrency — don't open 100 client connections at once.
	sem := make(chan struct{}, 8)

	for _, d := range devices {
		d := d
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			peers, err := s.listDeviceVPNPeers(ctx, d)
			if err != nil {
				// One offline device shouldn't poison the whole fleet
				// view. Log and skip — matches the pattern in
				// vpn_profiles.go and the fleet poller.
				fmt.Printf("vpn-peers: device %s (%s): %v\n", d.Name, d.ID, err)
				return
			}
			mu.Lock()
			out = append(out, peers...)
			mu.Unlock()
		}()
	}
	wg.Wait()
	return out, nil
}

// listDeviceVPNPeers returns the joined peer view for one device.
// Building block for the fleet endpoint and the per-UUID get.
func (s *Service) listDeviceVPNPeers(ctx context.Context, d model.Device) ([]model.VPNPeer, error) {
	cfg, err := s.GetIPsecConfig(ctx, d.ID)
	if err != nil {
		return nil, err
	}

	metadata, err := s.store.ListVPNPeersByDevice(ctx, d.ID)
	if err != nil {
		return nil, err
	}
	// Index metadata by name (device is implicit — we're inside a
	// per-device join here).
	metaIdx := make(map[string]model.VPNPeerMetadata, len(metadata))
	for _, m := range metadata {
		metaIdx[m.Name] = m
	}

	// Track which peers we saw on VyOS so we can GC orphan metadata.
	seen := make(map[string]bool, len(cfg.Peers))

	out := make([]model.VPNPeer, 0, len(cfg.Peers))
	for _, p := range cfg.Peers {
		p := p
		seen[p.Name] = true
		out = append(out, joinVPNPeer(d, p, metaIdx[p.Name]))
	}

	// Orphan GC — metadata row exists for a peer that no longer does.
	// Best-effort; errors here are logged but don't fail the read.
	for name, m := range metaIdx {
		if !seen[name] {
			if err := s.store.DeleteVPNPeerMetadata(ctx, m.ID); err != nil {
				fmt.Printf("vpn-peers: orphan gc failed for %s/%s: %v\n",
					d.Name, name, err)
			}
		}
	}
	return out, nil
}

// joinVPNPeer builds the unified VPNPeer from the VyOS-side peer
// config and the optional Postgres-side metadata. meta.ID == ""
// means no metadata row exists, so we synthesize the deterministic
// UUID and the response carries empty metadata fields.
func joinVPNPeer(d model.Device, p model.Peer, meta model.VPNPeerMetadata) model.VPNPeer {
	id := meta.ID
	if id == "" {
		id = synthesizeVPNPeerID(d.ID, p.Name)
	}
	tags := meta.Tags
	if tags == nil {
		tags = []string{}
	}

	// Hide zero timestamps when there's no metadata row — same
	// pointer-with-omitempty trick we used for vpn_profiles.
	var createdAt, updatedAt *time.Time
	if meta.ID != "" {
		ca, ua := meta.CreatedAt, meta.UpdatedAt
		createdAt, updatedAt = &ca, &ua
	}

	// UsedBy is Phase 5 territory (Tunnel objects). Always empty here.
	return model.VPNPeer{
		ID:          id,
		Name:        p.Name,
		DeviceID:    d.ID,
		DeviceName:  d.Name,
		Peer:        &p,
		Description: meta.Description,
		Tags:        tags,
		CreatedBy:   meta.CreatedBy,
		UpdatedBy:   meta.UpdatedBy,
		CreatedAt:   createdAt,
		UpdatedAt:   updatedAt,
		UsedBy:      []string{},
	}
}

// GetVPNPeer returns a single peer by UUID. The UUID may be a real
// Postgres row UUID or a synthesized one — we handle both by trying
// the metadata lookup first, then falling back to scanning the fleet
// for a synthesized match.
//
// This is more work than a database lookup, but it keeps URLs stable
// for VyOS-only peers. Synthesized UUIDs are deterministic, so we
// only need to scan if the metadata lookup fails.
func (s *Service) GetVPNPeer(ctx context.Context, id string) (model.VPNPeer, error) {
	// Fast path: real Postgres-row UUID.
	if meta, err := s.store.GetVPNPeerMetadata(ctx, id); err == nil {
		dev, err := s.store.GetDevice(ctx, meta.DeviceID)
		if err != nil {
			return model.VPNPeer{}, fmt.Errorf("get device: %w", err)
		}
		peers, err := s.listDeviceVPNPeers(ctx, *dev)
		if err != nil {
			return model.VPNPeer{}, err
		}
		for _, p := range peers {
			if p.ID == id {
				return p, nil
			}
		}
		// Metadata row exists but VyOS-side peer is gone. The
		// fleet-read GC would clean this up; reflect that here too.
		_ = s.store.DeleteVPNPeerMetadata(ctx, id)
		return model.VPNPeer{}, store.ErrNotFound
	} else if !errors.Is(err, store.ErrNotFound) {
		return model.VPNPeer{}, err
	}

	// Slow path: synthesized UUID. Scan the fleet.
	all, err := s.ListVPNPeers(ctx)
	if err != nil {
		return model.VPNPeer{}, err
	}
	for _, p := range all {
		if p.ID == id {
			return p, nil
		}
	}
	return model.VPNPeer{}, store.ErrNotFound
}

// DeleteVPNPeer removes a peer from VyOS, then deletes the metadata
// row. VyOS-first ordering: if the device call fails we leave the
// metadata in place; if VyOS succeeds we always clean up the row
// even if Postgres reports it didn't exist (synthesized-UUID case).
//
// Audit is written even when the device call fails, matching the
// pattern from Phase 1 and the existing per-device peer delete.
//
// Reference integrity to Tunnel objects (Phase 5) will gate this in
// the future. For Phase 3A, deletes proceed unconditionally.
func (s *Service) DeleteVPNPeer(ctx context.Context, userID, userName, id string) error {
	peer, err := s.GetVPNPeer(ctx, id)
	if err != nil {
		return err
	}

	// Delegate the actual device-side delete to the existing
	// per-device service method. It already handles ops translation,
	// PSK cleanup, audit, and the client pool — Phase 3A is a thin
	// fleet wrapper, not a reimplementation.
	if err := s.DeletePeer(ctx, userID, userName, peer.DeviceID, peer.Name); err != nil {
		return err
	}

	// Best-effort metadata cleanup. The natural-key delete handles
	// both the real-UUID case (row matches id) and the synthesized
	// case (no row to delete, returns nil).
	if delErr := s.store.DeleteVPNPeerMetadataByDeviceName(
		ctx, peer.DeviceID, peer.Name); delErr != nil {
		// Don't fail the operation on a metadata cleanup hiccup —
		// the device delete already succeeded. Log it for ops.
		fmt.Printf("vpn-peers: metadata cleanup failed for %s/%s: %v\n",
			peer.DeviceID, peer.Name, delErr)
	}
	return nil
}
