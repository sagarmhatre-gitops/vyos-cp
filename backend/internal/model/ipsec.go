package model

// IPsec domain types. Kept free of VyOS-specific knowledge — the translator
// package maps these to/from VyOS path arrays. Follows the same pattern as
// model/nat_zones.go.
//
// Scope of v1 integration:
//   - IKE proposals (IKEv1 / IKEv2 phase-1 crypto)
//   - ESP proposals (phase-2 crypto)
//   - Peers (site-to-site tunnels: remote-gateway, authentication, IKE/ESP refs)
//   - Tunnels (per-peer SA: local/remote subnets, protocol)
//
// Not in v1: PKI/x509 cert provisioning UI, mobile-VPN (IKEv2 EAP),
// dynamic routing over the tunnel. The model leaves room for these.

// --- IKE (phase 1) ---------------------------------------------------------

type IKEMode string

const (
	IKEMain       IKEMode = "main"
	IKEAggressive IKEMode = "aggressive"
)

type IKEProposal struct {
	Number     int    `json:"number"`        // 1..65535 (proposal priority)
	Encryption string `json:"encryption"`    // "aes128" | "aes256" | "aes128gcm128" | ...
	Hash       string `json:"hash"`          // "sha1" | "sha256" | "sha384" | "sha512"
	DHGroup    string `json:"dh_group"`      // "2" | "14" | "19" | "20" | ...
	PRF        string `json:"prf,omitempty"` // optional; IKEv2 only
}

// IKEGroup is a named bag of proposals plus lifetime/DPD/version settings.
// VyOS path: `vpn ipsec ike-group <name>`.
type IKEGroup struct {
	Name        string        `json:"name"`
	Description string        `json:"description,omitempty"`
	Lifetime    int           `json:"lifetime,omitempty"`    // seconds; VyOS default 28800
	IKEVersion  string        `json:"ike_version,omitempty"` // "ikev1" | "ikev2" | "" (any)
	Mode        IKEMode       `json:"mode,omitempty"`        // IKEv1 only
	DeadPeer    *DPD          `json:"dead_peer_detection,omitempty"`
	Proposals   []IKEProposal `json:"proposals"`
}

type DPDAction string

const (
	DPDHold    DPDAction = "hold"
	DPDClear   DPDAction = "clear"
	DPDRestart DPDAction = "restart"
)

type DPD struct {
	Action   DPDAction `json:"action"`             // restart | clear | hold
	Interval int       `json:"interval,omitempty"` // seconds; VyOS default 30
	Timeout  int       `json:"timeout,omitempty"`  // seconds; VyOS default 120
}

// --- ESP (phase 2) ---------------------------------------------------------

type ESPMode string

const (
	ESPTunnel    ESPMode = "tunnel"
	ESPTransport ESPMode = "transport"
)

type ESPProposal struct {
	Number     int    `json:"number"`         // 1..65535
	Encryption string `json:"encryption"`     // "aes128" | "aes256gcm128" | ...
	Hash       string `json:"hash,omitempty"` // empty for AEAD ciphers (gcm)
}

// ESPGroup → VyOS `vpn ipsec esp-group <name>`.
type ESPGroup struct {
	Name        string        `json:"name"`
	Description string        `json:"description,omitempty"`
	Lifetime    int           `json:"lifetime,omitempty"` // seconds; VyOS default 3600
	Mode        ESPMode       `json:"mode,omitempty"`     // tunnel | transport
	PFS         string        `json:"pfs,omitempty"`      // "enable" | "disable" | "dh-group2" | "dh-group14"
	Proposals   []ESPProposal `json:"proposals"`
}

// --- Authentication --------------------------------------------------------

type AuthMode string

const (
	AuthPSK  AuthMode = "pre-shared-secret"
	AuthRSA  AuthMode = "rsa"
	AuthX509 AuthMode = "x509"
)

type IDType string

const (
	IDAddress  IDType = "address"
	IDFQDN     IDType = "fqdn"
	IDUserFQDN IDType = "user-fqdn"
	IDKeyID    IDType = "keyid"
)

type PeerAuth struct {
	Mode AuthMode `json:"mode"`
	// Only one of these is meaningful per mode.
	PreSharedSecret string `json:"pre_shared_secret,omitempty"` // sealed at rest, never returned to UI in clear
	X509Certificate string `json:"x509_certificate,omitempty"`  // PKI cert name (CLI: `pki certificate <name>`)
	X509CAName      string `json:"x509_ca_name,omitempty"`      // PKI CA name
	LocalID         string `json:"local_id,omitempty"`
	RemoteID        string `json:"remote_id,omitempty"`
	IDType          IDType `json:"id_type,omitempty"`
}

// --- Peer (site-to-site IPsec connection) ----------------------------------

// VyOS path: `vpn ipsec site-to-site peer <peer-id>`.
// The "peer-id" is a label in the VyOS CLI; not necessarily an IP.
type Peer struct {
	Name            string   `json:"name"` // peer-id in CLI
	Description     string   `json:"description,omitempty"`
	Disable         bool     `json:"disable,omitempty"`
	RemoteAddress   string   `json:"remote_address"`              // IP / FQDN / "any" (responder-only)
	LocalAddress    string   `json:"local_address,omitempty"`     // IP / "any" (use default outgoing)
	IKEGroup        string   `json:"ike_group"`                   // reference to IKEGroup.Name
	DefaultESPGroup string   `json:"default_esp_group,omitempty"` // reference to ESPGroup.Name
	Authentication  PeerAuth `json:"authentication"`
	Tunnels         []Tunnel `json:"tunnels,omitempty"`
	// VTI is the alternative to tunnel { local/remote subnet } — bind to a
	// vti<N> interface and use routing instead. Left for v2.
	VTIInterface string `json:"vti_interface,omitempty"`
}

// Tunnel is one phase-2 SA on a Peer.
// VyOS path: `vpn ipsec site-to-site peer <name> tunnel <N>`.
type Tunnel struct {
	Number       int    `json:"number"` // 0..N — VyOS uses 0 as the first
	Disable      bool   `json:"disable,omitempty"`
	Description  string `json:"description,omitempty"`
	ESPGroup     string `json:"esp_group,omitempty"`    // override peer default
	Protocol     string `json:"protocol,omitempty"`     // "all" | "tcp" | "udp" | numeric
	LocalSubnet  string `json:"local_subnet,omitempty"` // CIDR
	LocalPort    string `json:"local_port,omitempty"`
	RemoteSubnet string `json:"remote_subnet,omitempty"` // CIDR
	RemotePort   string `json:"remote_port,omitempty"`
}

// --- Global options --------------------------------------------------------

// IPsecGlobals → `vpn ipsec` top-level knobs needed before any peer comes up.
type IPsecGlobals struct {
	// `ipsec-interfaces interface <if>` enables IPsec on the listed interfaces.
	// On VyOS 1.4+ this is auto-derived from local-address when "any"; the
	// field stays here for explicit control on 1.3-era configs.
	Interfaces []string `json:"interfaces,omitempty"`
	// NAT-T pass-through: most fleets need this on for NAT'd remote peers.
	NATTraversal bool `json:"nat_traversal"`
	LogLevel     int  `json:"log_level,omitempty"` // 0..5; 0 = off
}

// --- Runtime status (read-only) -------------------------------------------

// Reported by `show vpn ipsec sa` op-mode output.
type SAStatus struct {
	Peer       string `json:"peer"`
	Tunnel     int    `json:"tunnel"`
	State      string `json:"state"` // "up" | "down" | "connecting"
	LocalNet   string `json:"local_net,omitempty"`
	RemoteNet  string `json:"remote_net,omitempty"`
	BytesIn    int64  `json:"bytes_in"`
	BytesOut   int64  `json:"bytes_out"`
	PacketsIn  int64  `json:"packets_in"`
	PacketsOut int64  `json:"packets_out"`
	UptimeSec  int64  `json:"uptime_sec,omitempty"`
}

// IPsecConfig is the aggregate read returned by GetIPsecConfig — backs the
// IPsec page in the UI. Keeps the chatty multi-retrieve to one round-trip
// from the browser's perspective.
type IPsecConfig struct {
	Globals   IPsecGlobals `json:"globals"`
	IKEGroups []IKEGroup   `json:"ike_groups,omitempty"`
	ESPGroups []ESPGroup   `json:"esp_groups,omitempty"`
	Peers     []Peer       `json:"peers,omitempty"`
}
