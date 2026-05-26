package model

import "time"

// Flow is one conntrack connection row, parsed from `show conntrack table ipv4`.
// Sourced from the VyOS HTTP API /show endpoint (op-mode, API-reachable).
// We keep the original (pre-NAT) tuple as the primary src/dst since that is what
// operators reason about; reply tuple is retained for NAT visibility.
type Flow struct {
	ConntrackID string    `json:"conntrack_id"`
	Protocol    string    `json:"protocol"`
	State       string    `json:"state"` // empty for stateless protos (udp/icmp)
	OrigSrcIP   string    `json:"orig_src_ip"`
	OrigSrcPort string    `json:"orig_src_port"`
	OrigDstIP   string    `json:"orig_dst_ip"`
	OrigDstPort string    `json:"orig_dst_port"`
	ReplySrcIP  string    `json:"reply_src_ip"`
	ReplyDstIP  string    `json:"reply_dst_ip"`
	TimeoutSec  int       `json:"timeout_sec"`
	SeenAt      time.Time `json:"seen_at"`
}
