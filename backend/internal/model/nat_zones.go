package model

// --- NAT -------------------------------------------------------------------

type NATDirection string

const (
	NATSource      NATDirection = "source"
	NATDestination NATDirection = "destination"
)

type NATRule struct {
	Number             int          `json:"number"`
	Direction          NATDirection `json:"direction"`
	Description        string       `json:"description,omitempty"`
	Disable            bool         `json:"disable,omitempty"`
	Protocol           string       `json:"protocol,omitempty"`
	InboundInterface   string       `json:"inbound_interface,omitempty"`
	OutboundInterface  string       `json:"outbound_interface,omitempty"`
	Source             *AddrSpec    `json:"source,omitempty"`
	Destination        *AddrSpec    `json:"destination,omitempty"`
	TranslationAddress string       `json:"translation_address,omitempty"` // "masquerade" or IP
	TranslationPort    string       `json:"translation_port,omitempty"`
	Log                bool         `json:"log,omitempty"`
}

// --- Zones -----------------------------------------------------------------

type Zone struct {
	Name          string   `json:"name"`
	Description   string   `json:"description,omitempty"`
	Interfaces    []string `json:"interfaces,omitempty"`
	LocalZone     bool     `json:"local_zone,omitempty"`
	DefaultAction Action   `json:"default_action,omitempty"`
}

// ZonePolicy binds a rule-set to traffic from one zone to another.
type ZonePolicy struct {
	FromZone string `json:"from_zone"`
	ToZone   string `json:"to_zone"`
	RuleSet  string `json:"rule_set"`
	Family   string `json:"family"` // ipv4 | ipv6
}
