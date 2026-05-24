package model

// IPsec live-status domain types.
//
// These are EPHEMERAL. Unlike rules/groups/zones they are never persisted to
// Postgres — they are produced by the poller from `show vpn ike sa` and
// `show vpn ipsec sa detail`, then fanned out over the WebSocket hub to
// subscribed UI tabs. There is intentionally no store/migration for these.

// IKEState / ChildState are normalized across VyOS releases. The raw device
// strings ("up", "ESTABLISHED", "INSTALLED", "down", "connecting", ...) are
// mapped onto this small closed set by the parser so the UI never has to know
// which VyOS version produced them.
type IKEState string

const (
	IKEUp         IKEState = "up"
	IKEConnecting IKEState = "connecting"
	IKEDown       IKEState = "down"
	IKEUnknown    IKEState = "unknown"
)

type ChildState string

const (
	ChildInstalled  ChildState = "installed"
	ChildRekeying   ChildState = "rekeying"
	ChildConnecting ChildState = "connecting"
	ChildDown       ChildState = "down"
	ChildUnknown    ChildState = "unknown"
)

// IKESA is one Phase 1 security association (one peer connection).
type IKESA struct {
	Peer      string   `json:"peer"`       // connection name, e.g. "PEER-tunnel-1" or peer id
	State     IKEState `json:"state"`      // normalized
	RawState  string   `json:"rawState"`   // verbatim device token, for tooltip/debug
	IKEVer    string   `json:"ikeVer"`     // "IKEv1" / "IKEv2"
	LocalID   string   `json:"localId"`    // negotiated local id (item 1 surfaces here)
	RemoteID  string   `json:"remoteId"`   // negotiated remote id
	LocalIP   string   `json:"localIp"`
	RemoteIP  string   `json:"remoteIp"`
	Encrypt   string   `json:"encrypt"`    // e.g. AES_CBC_128
	Hash      string   `json:"hash"`       // e.g. HMAC_SHA1_96
	DHGroup   string   `json:"dhGroup"`    // e.g. MODP_2048
	NATT      bool     `json:"natt"`       // NAT traversal in use
	EstabSecs int64    `json:"estabSecs"`  // A-Time (seconds since established), -1 if unknown
	RekeySecs int64    `json:"rekeySecs"`  // L-Time (seconds to next rekey), -1 if unknown
}

// ChildSA is one Phase 2 / IPsec (CHILD) security association. A single peer
// may carry several of these — one per bound subnet pair (your item 4 future).
type ChildSA struct {
	Name        string     `json:"name"`        // CHILD name, usually "<conn>-tunnel-N"
	State       ChildState `json:"state"`       // normalized
	RawState    string     `json:"rawState"`    // verbatim, e.g. "INSTALLED"
	Proposal    string     `json:"proposal"`    // ESP proposal, e.g. AES_CBC_128/HMAC_SHA1_96/MODP_2048
	LocalSubnet string     `json:"localSubnet"` // e.g. 10.0.0.0/24  (item 3 requirement)
	RemoteSubnet string    `json:"remoteSubnet"`// e.g. 10.0.1.0/24
	BytesIn     uint64     `json:"bytesIn"`
	BytesOut    uint64     `json:"bytesOut"`
	PacketsIn   uint64     `json:"packetsIn"`
	PacketsOut  uint64     `json:"packetsOut"`
	UptimeSecs  int64      `json:"uptimeSecs"`  // installed N secs ago, -1 if unknown
	RekeySecs   int64      `json:"rekeySecs"`   // rekeying in N secs, -1 if unknown
}

// IPsecStatus is the per-device aggregate the poller publishes. The UI keys
// CHILD SAs under their parent IKE peer for the Phase1/Phase2 tree view.
type IPsecStatus struct {
	DeviceID string    `json:"deviceId"`
	IKE      []IKESA   `json:"ike"`
	Children []ChildSA `json:"children"`
	// ParseWarnings carries non-fatal parser notes (e.g. an unrecognized
	// state token) so the UI can show a soft badge without dropping the SA.
	ParseWarnings []string `json:"parseWarnings,omitempty"`
}
