package model

import "time"

// VPNPeer is the fleet-management view of a site-to-site IPsec peer.
// Phase 3A delivers this as a read-only fleet object — operators still
// create and edit peers through the existing device-level wizard.
//
// Source-of-truth shape (same as VPNProfile in Phase 1):
//   - VyOS is authoritative for the peer config (Peer field below).
//   - Postgres (vpn_peers table) is authoritative for management
//     metadata: Description, Tags, audit fields. A peer that exists
//     on VyOS but has no Postgres row gets a synthesized UUID and
//     empty metadata; the first edit through a future endpoint
//     would persist the row.
//   - UsedBy is computed at read time from Tunnel objects (Phase 5).
//     For Phase 3A it's always an empty slice — no Tunnel objects
//     exist yet.
type VPNPeer struct {
	// ID is the Postgres metadata-row UUID, or a synthesized UUID
	// derived from (device_id, name) when no row exists yet. Stable
	// across calls — URLs minted from a fleet read remain valid
	// even before the first metadata write.
	ID string `json:"id"`

	// Name is the VyOS peer-id label (NOT necessarily an IP).
	Name string `json:"name"`

	DeviceID   string `json:"device_id"`
	DeviceName string `json:"device_name,omitempty"`

	// Peer is the full VyOS-side config. Embedding the existing
	// model.Peer type means we get IKE/ESP profile references,
	// tunnels, auth (with PSK already redacted by the per-device
	// reader), etc. for free.
	Peer *Peer `json:"peer,omitempty"`

	// Management metadata — Postgres-side fields.
	Description string   `json:"description"`
	Tags        []string `json:"tags"`

	CreatedBy string     `json:"created_by,omitempty"`
	UpdatedBy string     `json:"updated_by,omitempty"`
	CreatedAt *time.Time `json:"created_at,omitempty"`
	UpdatedAt *time.Time `json:"updated_at,omitempty"`

	// UsedBy lists the Tunnel objects (Phase 5) that reference this
	// peer. Empty in Phase 3A. Reference-integrity checks on delete
	// gate on this slice once Tunnels exist.
	UsedBy []string `json:"used_by"`
}

// VPNPeerMetadata is the projection of the vpn_peers table —
// just the Postgres-side fields without the joined VyOS config.
// Used by the store layer and the lazy-join logic in the service.
type VPNPeerMetadata struct {
	ID          string
	DeviceID    string
	Name        string
	Description string
	Tags        []string
	CreatedBy   string
	UpdatedBy   string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}
