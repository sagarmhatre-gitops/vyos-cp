package model

// VPN profile types — Phase 1 of the VPN object model refactor.
//
// A VPNProfile is the fleet-level view of an IKE or ESP group: the VyOS
// config (encryption, lifetime, etc.) joined with the management metadata
// stored in vpn_profiles (description, tags, audit timestamps).
//
// Identity rules:
//   - id is a UUID that uniquely names the profile in URLs
//   - For profiles with a Postgres row: id == the row's id column
//   - For profiles that exist on VyOS but have no Postgres row yet:
//     id is synthesized deterministically from (device_id, type, name)
//     via uuid.NewSHA1(namespace, ...). Same input always gives same UUID,
//     so the URL is stable across reads even before the first edit.

import "time"

// VPNProfile is the unified shape returned by the /api/v1/vpn/profiles
// endpoint. Exactly one of IKE or ESP is populated depending on Type.
type VPNProfile struct {
	// Identity — UUID is the URL identifier; Type+Name+DeviceID is the
	// natural key on VyOS.
	ID         string `json:"id"`
	Type       string `json:"type"` // "ike" | "esp"
	Name       string `json:"name"`
	DeviceID   string `json:"device_id"`
	DeviceName string `json:"device_name,omitempty"`

	// VyOS config — exactly one of these is set.
	IKE *IKEGroup `json:"ike,omitempty"`
	ESP *ESPGroup `json:"esp,omitempty"`

	// Management metadata from Postgres. Empty when no row exists yet.
	Description string   `json:"description"`
	Tags        []string `json:"tags"`

	// Audit fields. Zero values when no Postgres row exists.
	CreatedBy string    `json:"created_by,omitempty"`
	UpdatedBy string    `json:"updated_by,omitempty"`
	// Pointers so omitempty actually skips them when no Postgres row
	// exists. With value-typed time.Time, omitempty has no effect (the
	// zero value is still a valid time.Time), so unset times serialize
	// as "0001-01-01T00:00:00Z" — visible in the UI as garbage.
	CreatedAt *time.Time `json:"created_at,omitempty"`
	UpdatedAt *time.Time `json:"updated_at,omitempty"`

	// Which peers reference this profile, computed by the fleet endpoint
	// across the device's peer list. Used by the UI for safe-delete UX.
	UsedBy []string `json:"used_by"`
}

// VPNProfileMetadata is the management-only slice of a profile, stored in
// the vpn_profiles Postgres table. The store package CRUDs this; the
// service layer joins it with VyOS data to produce VPNProfile.
type VPNProfileMetadata struct {
	ID          string    `json:"id"`
	DeviceID    string    `json:"device_id"`
	Type        string    `json:"type"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Tags        []string  `json:"tags"`
	CreatedBy   string    `json:"created_by"`
	UpdatedBy   string    `json:"updated_by"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// VPNProfileCreate / VPNProfileUpdate are the request bodies for the
// POST and PUT endpoints. Both carry the VyOS config alongside the
// metadata; the service writes VyOS first, Postgres second.
type VPNProfileCreate struct {
	DeviceID    string    `json:"device_id"`
	Type        string    `json:"type"` // "ike" | "esp"
	IKE         *IKEGroup `json:"ike,omitempty"`
	ESP         *ESPGroup `json:"esp,omitempty"`
	Description string    `json:"description"`
	Tags        []string  `json:"tags"`
}

type VPNProfileUpdate struct {
	IKE         *IKEGroup `json:"ike,omitempty"`
	ESP         *ESPGroup `json:"esp,omitempty"`
	Description string    `json:"description"`
	Tags        []string  `json:"tags"`
}
