package model

// Interface is a network interface on a VyOS device.
type Interface struct {
	Kind        string   `json:"kind"` // "ethernet" | "bond" | "bridge" | "loopback" | "dummy" | "wireguard" | "vlan"
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Addresses   []string `json:"addresses,omitempty"`
	MTU         string   `json:"mtu,omitempty"`
	VRF         string   `json:"vrf,omitempty"`
	HWID        string   `json:"hw_id,omitempty"`
	Disabled    bool     `json:"disabled,omitempty"`
	// Live state populated by the poller, not persisted to VyOS.
	LinkState   string `json:"link_state,omitempty"`   // up | down | admin-down
	RXBytes     uint64 `json:"rx_bytes,omitempty"`
	TXBytes     uint64 `json:"tx_bytes,omitempty"`
}
