package model

import (
	"time"

	"github.com/google/uuid"
)

// SnapshotSource mirrors the snapshot_source enum in the database.
type SnapshotSource string

const (
	// SourceControlPlane: vyos-cp captured this snapshot right after its own
	// /configure call landed. The audit_log_id is populated.
	SourceControlPlane SnapshotSource = "control_plane"

	// SourceDevice: the fleet poller captured this snapshot during its
	// periodic /retrieve. The most common source by volume.
	SourceDevice SnapshotSource = "device"

	// SourceManual: an operator hit POST /snapshot to force a capture.
	// The created_by column identifies the user.
	SourceManual SnapshotSource = "manual"
)

// DeviceSnapshot is a captured point-in-time view of a VyOS device's
// configuration, decoded into the domain model.
//
// The Config field is the full decoded tree (potentially large). Callers
// that need only metadata should use SnapshotSummary instead.
type DeviceSnapshot struct {
	ID         int64          `json:"id"`
	DeviceID   string      `json:"device_id"`
	TakenAt    time.Time      `json:"taken_at"`
	Source     SnapshotSource `json:"source"`
	ConfigHash string         `json:"config_hash"` // hex-encoded for transport
	Config     DeviceConfig   `json:"config"`

	// Optional cross-references. Populated when applicable; omitted on the wire.
	ParentID   *int64     `json:"parent_id,omitempty"`
	AuditLogID *int64     `json:"audit_log_id,omitempty"`
	CreatedBy  *uuid.UUID `json:"created_by,omitempty"`
}

// SnapshotSummary is the lightweight row returned by the list endpoint —
// metadata only, no config_json. Avoids shipping megabytes when an operator
// just wants to scroll the history.
type SnapshotSummary struct {
	ID         int64          `json:"id"`
	DeviceID   string      `json:"device_id"`
	TakenAt    time.Time      `json:"taken_at"`
	Source     SnapshotSource `json:"source"`
	ConfigHash string         `json:"config_hash"`
}

// DeviceConfig is the decoded root of a VyOS configuration tree.
//
// The concrete shape comes from the existing translator package — this struct
// is a thin wrapper that names the well-known sub-trees vyos-cp manages.
// Anything the translator doesn't yet model is preserved in Extra so that
// snapshots remain lossless even when new VyOS features ship faster than the
// translator can absorb them.
type DeviceConfig struct {
	Firewall   FirewallConfig   `json:"firewall,omitempty"`
	NAT        NATConfig        `json:"nat,omitempty"`
	Interfaces InterfacesConfig `json:"interfaces,omitempty"`

	// Extra preserves anything the translator did not recognise. Critical
	// for snapshot fidelity: we'd rather store an opaque blob than silently
	// drop unmodeled config.
	Extra map[string]any `json:"extra,omitempty"`
}

// The sub-config types below are placeholders that should be replaced with
// (or aliased to) the corresponding types already defined in the translator
// package. Kept here so this file compiles in isolation during review.

type FirewallConfig struct {
	IPv4 map[string]any `json:"ipv4,omitempty"`
	IPv6 map[string]any `json:"ipv6,omitempty"`

	// Residual catches sub-keys under "firewall" that this struct doesn't
	// model yet (e.g. group, zone, bridge, flowtable, global-options).
	// Preserved verbatim so snapshots stay lossless.
	Residual map[string]any `json:"residual,omitempty"`
}

type NATConfig struct {
	Source      map[string]any `json:"source,omitempty"`
	Destination map[string]any `json:"destination,omitempty"`

	// Residual catches sub-keys under "nat" we don't yet model.
	Residual map[string]any `json:"residual,omitempty"`
}

type InterfacesConfig struct {
	Ethernet map[string]any `json:"ethernet,omitempty"`
	Bonding  map[string]any `json:"bonding,omitempty"`
	VLAN     map[string]any `json:"vlan,omitempty"`

	// Residual catches sub-keys under "interfaces" we don't yet model
	// (e.g. loopback, dummy, bridge, wireguard, tunnel, pppoe, input).
	Residual map[string]any `json:"residual,omitempty"`
}
