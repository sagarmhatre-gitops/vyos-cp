package service

// VPN profiles — service layer for the fleet-wide profile management
// surface. Phase 1 supports IKE and ESP profile types. Phase 3-5 extend
// to peers, traffic selectors, and tunnels using the same shape.
//
// Source-of-truth rules:
//   - VyOS is authoritative for "what profiles exist + crypto params"
//   - vpn_profiles table is authoritative for management metadata
//     (description, tags, audit timestamps)
//
// Lazy-create semantics: profiles that exist on VyOS but have no Postgres
// row are returned by the fleet read with a deterministic synthesized
// UUID and empty metadata. The first write through the new endpoints
// creates the row, preserving the UUID so the URL stays stable.
//
// Orphan Postgres rows (VyOS object deleted out-of-band) are garbage-
// collected on the next fleet read. Drift detection (surfacing this
// state to operators) is a Phase 2 concern.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/store"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
	"github.com/vyos-cp/vyos-cp/internal/vyos/translator"
)

// vpnProfileNamespace is a fixed UUID used to derive deterministic UUIDs
// for VyOS profiles that don't yet have a Postgres row. Generated once
// with `uuidgen` and frozen here — changing it would invalidate every
// existing synthesized URL.
var vpnProfileNamespace = uuid.MustParse("3a4cf6b9-9b7e-4f23-9b3a-1cf0e2b9d4f1")

// synthesizeVPNProfileID returns the deterministic UUID for a profile
// identified by (device_id, type, name). The same triple always yields
// the same UUID, so a URL minted at fleet-read time is stable even
// before any metadata row is created.
func synthesizeVPNProfileID(deviceID, ptype, name string) string {
	return uuid.NewSHA1(vpnProfileNamespace,
		[]byte(deviceID+"\x00"+ptype+"\x00"+name)).String()
}

// ListVPNProfiles fans out across every device in the fleet, fetches
// IKE and ESP groups, and joins with Postgres metadata. Returns one
// VPNProfile per (device, type, name) triple.
//
// Garbage-collects orphan Postgres rows: any metadata row that no
// longer corresponds to a VyOS-side profile is deleted.
func (s *Service) ListVPNProfiles(ctx context.Context) ([]model.VPNProfile, error) {
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}

	// Per-device fanout. One slice per device, gathered under a mutex
	// since goroutines append in parallel.
	var (
		mu  sync.Mutex
		out []model.VPNProfile
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
			profiles, err := s.listDeviceVPNProfiles(ctx, d)
			if err != nil {
				// One offline device shouldn't poison the whole fleet
				// view. Log via stdout (matches other fanout patterns in
				// the codebase) and skip.
				fmt.Printf("vpn: device %s (%s): %v\n", d.Name, d.ID, err)
				return
			}
			mu.Lock()
			out = append(out, profiles...)
			mu.Unlock()
		}()
	}
	wg.Wait()
	return out, nil
}

// listDeviceVPNProfiles returns the joined VPN profile view for one
// device. Used as a building block by both the fleet endpoint and the
// per-UUID get.
func (s *Service) listDeviceVPNProfiles(ctx context.Context, d model.Device) ([]model.VPNProfile, error) {
	cfg, err := s.GetIPsecConfig(ctx, d.ID)
	if err != nil {
		return nil, err
	}

	metadata, err := s.store.ListVPNProfilesByDevice(ctx, d.ID)
	if err != nil {
		return nil, err
	}
	// Index metadata by (type, name) for O(1) join.
	metaIdx := make(map[string]model.VPNProfileMetadata, len(metadata))
	for _, m := range metadata {
		metaIdx[m.Type+"\x00"+m.Name] = m
	}

	// Used-by maps: which peers reference each IKE/ESP group name.
	// Computed once per device by walking the peer list.
	ikeUsedBy, espUsedBy := buildVPNUsedBy(cfg.Peers)

	// Track which (type, name) we saw on VyOS so we can garbage-collect
	// orphan metadata rows after the join.
	seen := make(map[string]bool, len(cfg.IKEGroups)+len(cfg.ESPGroups))

	var out []model.VPNProfile
	for _, g := range cfg.IKEGroups {
		g := g
		key := "ike\x00" + g.Name
		seen[key] = true
		out = append(out, joinVPNProfile(d, "ike", g.Name, metaIdx[key], &g, nil, ikeUsedBy[g.Name]))
	}
	for _, g := range cfg.ESPGroups {
		g := g
		key := "esp\x00" + g.Name
		seen[key] = true
		out = append(out, joinVPNProfile(d, "esp", g.Name, metaIdx[key], nil, &g, espUsedBy[g.Name]))
	}

	// Orphan GC — metadata row exists for a VyOS profile that no longer
	// does. Best-effort delete; errors here are logged but don't fail
	// the fleet read.
	for key, m := range metaIdx {
		if !seen[key] {
			if err := s.store.DeleteVPNProfileMetadata(ctx, m.ID); err != nil {
				fmt.Printf("vpn: orphan gc failed for %s: %v\n", m.ID, err)
			}
		}
	}
	return out, nil
}

// joinVPNProfile builds the unified VPNProfile from the VyOS-side config
// and the optional Postgres-side metadata. metadata.ID == "" when no
// row exists — in that case we synthesize the deterministic UUID.
func joinVPNProfile(d model.Device, ptype, name string,
	meta model.VPNProfileMetadata, ike *model.IKEGroup, esp *model.ESPGroup,
	usedBy []string) model.VPNProfile {

	id := meta.ID
	if id == "" {
		id = synthesizeVPNProfileID(d.ID, ptype, name)
	}
	tags := meta.Tags
	if tags == nil {
		tags = []string{}
	}
	if usedBy == nil {
		usedBy = []string{}
	}
	// Only expose timestamps when a real metadata row exists. The
	// VPNProfileMetadata zero value has zero times; copying those into
	// the response surfaces "0001-01-01T00:00:00Z" to operators. Using
	// pointer fields with omitempty hides them cleanly.
	var createdAt, updatedAt *time.Time
	if meta.ID != "" {
		ca, ua := meta.CreatedAt, meta.UpdatedAt
		createdAt, updatedAt = &ca, &ua
	}
	return model.VPNProfile{
		ID: id, Type: ptype, Name: name,
		DeviceID: d.ID, DeviceName: d.Name,
		IKE: ike, ESP: esp,
		Description: meta.Description, Tags: tags,
		CreatedBy: meta.CreatedBy, UpdatedBy: meta.UpdatedBy,
		CreatedAt: createdAt, UpdatedAt: updatedAt,
		UsedBy: usedBy,
	}
}

// buildVPNUsedBy walks the peer list once and returns two maps:
// IKE-group-name → peers that use it, and ESP-group-name → peers.
// A peer references at most one IKE group (peer.IKEGroup) and may
// reference an ESP group via peer.DefaultESPGroup or per-tunnel overrides.
func buildVPNUsedBy(peers []model.Peer) (map[string][]string, map[string][]string) {
	ike := map[string][]string{}
	esp := map[string][]string{}
	for _, p := range peers {
		if p.IKEGroup != "" {
			ike[p.IKEGroup] = append(ike[p.IKEGroup], p.Name)
		}
		if p.DefaultESPGroup != "" {
			esp[p.DefaultESPGroup] = appendUnique(esp[p.DefaultESPGroup], p.Name)
		}
		for _, t := range p.Tunnels {
			if t.ESPGroup != "" && t.ESPGroup != p.DefaultESPGroup {
				esp[t.ESPGroup] = appendUnique(esp[t.ESPGroup], p.Name)
			}
		}
	}
	return ike, esp
}

func appendUnique(s []string, v string) []string {
	for _, x := range s {
		if x == v {
			return s
		}
	}
	return append(s, v)
}

// GetVPNProfile resolves a profile UUID to its VPNProfile.
// Two paths:
//   - UUID found in vpn_profiles → look up by natural key
//   - UUID not found → scan every device for a profile whose synthesized
//     UUID matches (lazy path — happens when no metadata row exists yet)
func (s *Service) GetVPNProfile(ctx context.Context, id string) (*model.VPNProfile, error) {
	meta, err := s.store.GetVPNProfileByID(ctx, id)
	if err == nil {
		d, derr := s.store.GetDevice(ctx, meta.DeviceID)
		if derr != nil {
			return nil, derr
		}
		profiles, perr := s.listDeviceVPNProfiles(ctx, *d)
		if perr != nil {
			return nil, perr
		}
		for i := range profiles {
			if profiles[i].ID == id {
				return &profiles[i], nil
			}
		}
		return nil, store.ErrNotFound
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	// Synthesized UUID path: scan every device.
	all, lerr := s.ListVPNProfiles(ctx)
	if lerr != nil {
		return nil, lerr
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, store.ErrNotFound
}

// CreateVPNProfile pushes a new IKE/ESP group to the device and writes
// the metadata row. VyOS first, Postgres second — if VyOS fails nothing
// is created; if Postgres fails the profile works but has no metadata
// (the next edit fills it in).
func (s *Service) CreateVPNProfile(ctx context.Context,
	userID, userName string, req model.VPNProfileCreate) (*model.VPNProfile, error) {

	if req.DeviceID == "" {
		return nil, fmt.Errorf("device_id is required")
	}
	if req.Type != "ike" && req.Type != "esp" {
		return nil, fmt.Errorf("type must be 'ike' or 'esp', got %q", req.Type)
	}

	var (
		name string
		ops  []vyos.ConfigureOp
		err  error
	)
	switch req.Type {
	case "ike":
		if req.IKE == nil || req.IKE.Name == "" {
			return nil, fmt.Errorf("ike group payload required for type=ike")
		}
		name = req.IKE.Name
		ops, err = translator.IKEGroupOps(*req.IKE)
	case "esp":
		if req.ESP == nil || req.ESP.Name == "" {
			return nil, fmt.Errorf("esp group payload required for type=esp")
		}
		name = req.ESP.Name
		ops, err = translator.ESPGroupOps(*req.ESP)
	}
	if err != nil {
		return nil, fmt.Errorf("translator: %w", err)
	}

	client, err := s.cp.Get(ctx, req.DeviceID)
	if err != nil {
		return nil, err
	}
	action := "vpn.profile.upsert"
	if err := s.runConfigure(ctx, client, userID, userName, req.DeviceID, action, ops); err != nil {
		return nil, err
	}

	// VyOS write succeeded — now persist metadata. Failures here are
	// non-fatal but logged; the next edit recovers.
	meta := model.VPNProfileMetadata{
		ID:          synthesizeVPNProfileID(req.DeviceID, req.Type, name),
		DeviceID:    req.DeviceID,
		Type:        req.Type,
		Name:        name,
		Description: req.Description,
		Tags:        req.Tags,
		CreatedBy:   userID,
		UpdatedBy:   userID,
	}
	if _, mErr := s.store.UpsertVPNProfileMetadata(ctx, meta); mErr != nil {
		fmt.Printf("vpn: metadata write failed for %s/%s/%s: %v\n",
			req.DeviceID, req.Type, name, mErr)
		// Continue — VyOS write is authoritative.
	}
	return s.GetVPNProfile(ctx, meta.ID)
}

// UpdateVPNProfile pushes new VyOS config for an existing profile and
// updates the metadata row. PUT semantics: full replace of both VyOS
// config and metadata (description, tags).
func (s *Service) UpdateVPNProfile(ctx context.Context,
	userID, userName, id string, req model.VPNProfileUpdate) (*model.VPNProfile, error) {

	// Resolve the URL UUID to the actual profile.
	existing, err := s.GetVPNProfile(ctx, id)
	if err != nil {
		return nil, err
	}

	var ops []vyos.ConfigureOp
	switch existing.Type {
	case "ike":
		if req.IKE == nil {
			return nil, fmt.Errorf("ike group payload required")
		}
		// Force the name to match what's already on the device — operators
		// can't rename through this path.
		req.IKE.Name = existing.Name
		ops, err = translator.IKEGroupOps(*req.IKE)
	case "esp":
		if req.ESP == nil {
			return nil, fmt.Errorf("esp group payload required")
		}
		req.ESP.Name = existing.Name
		ops, err = translator.ESPGroupOps(*req.ESP)
	default:
		return nil, fmt.Errorf("unknown profile type %q", existing.Type)
	}
	if err != nil {
		return nil, fmt.Errorf("translator: %w", err)
	}

	client, err := s.cp.Get(ctx, existing.DeviceID)
	if err != nil {
		return nil, err
	}
	if err := s.runConfigure(ctx, client, userID, userName,
		existing.DeviceID, "vpn.profile.upsert", ops); err != nil {
		return nil, err
	}

	// Update metadata. Use the synthesized UUID so the row id matches
	// the URL on first write.
	meta := model.VPNProfileMetadata{
		ID:          existing.ID,
		DeviceID:    existing.DeviceID,
		Type:        existing.Type,
		Name:        existing.Name,
		Description: req.Description,
		Tags:        req.Tags,
		CreatedBy:   existing.CreatedBy,
		UpdatedBy:   userID,
	}
	if meta.CreatedBy == "" {
		meta.CreatedBy = userID
	}
	if _, mErr := s.store.UpsertVPNProfileMetadata(ctx, meta); mErr != nil {
		fmt.Printf("vpn: metadata update failed for %s: %v\n", id, mErr)
	}
	return s.GetVPNProfile(ctx, existing.ID)
}

// DeleteVPNProfile removes the profile from VyOS and (best-effort) the
// metadata row. Refuses if peers still reference it (reference-integrity
// preflight, mirrors the IPsec page's check).
func (s *Service) DeleteVPNProfile(ctx context.Context,
	userID, userName, id string) error {

	existing, err := s.GetVPNProfile(ctx, id)
	if err != nil {
		return err
	}
	if len(existing.UsedBy) > 0 {
		return fmt.Errorf("cannot delete %s profile %q: still referenced by peer(s): %s",
			existing.Type, existing.Name, strings.Join(existing.UsedBy, ", "))
	}

	var ops []vyos.ConfigureOp
	switch existing.Type {
	case "ike":
		ops = translator.DeleteIKEGroupOps(existing.Name)
	case "esp":
		ops = translator.DeleteESPGroupOps(existing.Name)
	default:
		return fmt.Errorf("unknown profile type %q", existing.Type)
	}

	client, err := s.cp.Get(ctx, existing.DeviceID)
	if err != nil {
		return err
	}
	if err := s.runConfigure(ctx, client, userID, userName,
		existing.DeviceID, "vpn.profile.delete", ops); err != nil {
		return err
	}
	// Best-effort metadata cleanup.
	if mErr := s.store.DeleteVPNProfileMetadataByNatKey(ctx,
		existing.DeviceID, existing.Type, existing.Name); mErr != nil {
		fmt.Printf("vpn: metadata delete failed for %s: %v\n", id, mErr)
	}
	return nil
}
