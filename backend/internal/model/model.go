// Package model contains the semantic firewall types exposed by the control
// plane REST API. The translator package converts these to/from VyOS path
// arrays. Keep this package free of VyOS-specific knowledge.
package model

import "time"

// --- Rules -----------------------------------------------------------------

type Action string

const (
	ActionAccept Action = "accept"
	ActionDrop   Action = "drop"
	ActionReject Action = "reject"
	ActionJump   Action = "jump"
	ActionReturn Action = "return"
	ActionQueue  Action = "queue"
)

// AddrSpec is a source or destination. Exactly one addressing method
// (Address, Network, Group) should normally be populated; the translator
// tolerates combinations but the UI enforces single-method.
type AddrSpec struct {
	Address string    `json:"address,omitempty"`      // "10.0.0.1", "!10.0.0.1", or CIDR
	Port    string    `json:"port,omitempty"`         // "443", "80,443", "1000-2000"
	MAC     string    `json:"mac,omitempty"`
	Group   *GroupRef `json:"group,omitempty"`
}

type GroupRef struct {
	AddressGroup   string `json:"address_group,omitempty"`
	NetworkGroup   string `json:"network_group,omitempty"`
	PortGroup      string `json:"port_group,omitempty"`
	DomainGroup    string `json:"domain_group,omitempty"`
	MACGroup       string `json:"mac_group,omitempty"`
	InterfaceGroup string `json:"interface_group,omitempty"`
}

type State struct {
	Established bool `json:"established,omitempty"`
	Related     bool `json:"related,omitempty"`
	New         bool `json:"new,omitempty"`
	Invalid     bool `json:"invalid,omitempty"`
}

// Rule is one entry in a named firewall rule-set.
type Rule struct {
	Number      int       `json:"number"`
	Description string    `json:"description,omitempty"`
	Action      Action    `json:"action"`
	Protocol    string    `json:"protocol,omitempty"` // "tcp", "udp", "icmp", "all", number
	Source      *AddrSpec `json:"source,omitempty"`
	Destination *AddrSpec `json:"destination,omitempty"`
	State       *State    `json:"state,omitempty"`
	Log         bool      `json:"log,omitempty"`
	Disable     bool      `json:"disable,omitempty"`
	JumpTarget  string    `json:"jump_target,omitempty"`

	// GeoIP filters. VyOS models source/destination GeoIP as nested under
	// the side ("source geoip country-code CC"); we hoist them to the top
	// level of the rule for UI ergonomics.
	SourceCountries      []string `json:"source_countries,omitempty"`
	DestinationCountries []string `json:"destination_countries,omitempty"`
}

// RuleSet is a named chain: `firewall <family> name <name> { ... }`.
type RuleSet struct {
	Name          string `json:"name"`
	Family        string `json:"family"` // "ipv4" | "ipv6"
	DefaultAction Action `json:"default_action"`
	Description   string `json:"description,omitempty"`
	Rules         []Rule `json:"rules,omitempty"`
}

// --- Groups ----------------------------------------------------------------

type GroupType string

const (
	GroupAddress   GroupType = "address-group"
	GroupNetwork   GroupType = "network-group"
	GroupPort      GroupType = "port-group"
	GroupDomain    GroupType = "domain-group"
	GroupMAC       GroupType = "mac-group"
	GroupInterface GroupType = "interface-group"
)

type Group struct {
	Name        string    `json:"name"`
	Type        GroupType `json:"type"`
	Family      string    `json:"family,omitempty"` // "ipv4"|"ipv6" for address/network
	Description string    `json:"description,omitempty"`
	Members     []string  `json:"members"`
}

// --- Device & audit --------------------------------------------------------

type Device struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	Address            string    `json:"address"` // https://vyos.local
	Tags               []string  `json:"tags,omitempty"`
	Location           string    `json:"location,omitempty"` // free-text site, e.g. "NYC DC"
	GroupID            string    `json:"group_id,omitempty"`
	InsecureSkipVerify bool      `json:"insecure_skip_verify"`
	Status             string    `json:"status"` // online | offline | unknown
	Version            string    `json:"version,omitempty"`
	Hostname           string    `json:"hostname,omitempty"`
	LastSeen           time.Time `json:"last_seen,omitempty"`
	LastError          string    `json:"last_error,omitempty"`
}

type DeviceGroup struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type AuditEntry struct {
	ID        int64         `json:"id"`
	Timestamp time.Time     `json:"timestamp"`
	UserID    string        `json:"user_id,omitempty"`
	UserName  string        `json:"user_name,omitempty"`
	DeviceID  string        `json:"device_id,omitempty"`
	Device    string        `json:"device,omitempty"`
	Action    string        `json:"action"`
	Ops       []ConfigureOp `json:"ops,omitempty"`
	Success   bool          `json:"success"`
	ErrorMsg  string        `json:"error_msg,omitempty"`
}

// ConfigureOp is re-declared here so model doesn't import vyos; the service
// layer translates between them. Keeping model free of device-client types
// lets the API package import only this one.
type ConfigureOp struct {
	Op    string   `json:"op"`
	Path  []string `json:"path"`
	Value string   `json:"value,omitempty"`
}

// --- Users & auth ----------------------------------------------------------

type Role string

const (
	RoleAdmin    Role = "admin"
	RoleOperator Role = "operator"
	RoleViewer   Role = "viewer"
)

type User struct {
	ID          string    `json:"id"`
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`
	Roles       []Role    `json:"roles"`
	CreatedAt   time.Time `json:"created_at"`
	Disabled    bool      `json:"disabled"`
}
