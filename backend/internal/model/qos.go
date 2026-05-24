package model

// QoS engine. VyOS supports several shaper types; we expose three for v1.
type QoSEngine string

const (
	QoSHTB      QoSEngine = "htb"       // hierarchical token bucket — most common
	QoSHFSC     QoSEngine = "hfsc"      // hierarchical fair service curve — most flexible
	QoSFQCoDel  QoSEngine = "fq-codel"  // fair-queue CoDel — bufferbloat solver, no hierarchy
)

// TrafficPolicy is a reusable shaping template that gets attached to one or
// more interfaces via set interfaces ethernet <N> traffic-policy out <name>.
type TrafficPolicy struct {
	Name        string          `json:"name"`
	Engine      QoSEngine       `json:"engine"`
	Description string          `json:"description,omitempty"`
	Bandwidth   string          `json:"bandwidth,omitempty"` // e.g. "1gbit", "100mbit", "auto"
	// Classes are only meaningful for HTB/HFSC. Ignored for FQ-CoDel.
	Classes []TrafficClass `json:"classes,omitempty"`
	// Default class attributes when no matcher hits (HTB/HFSC).
	DefaultBandwidth string `json:"default_bandwidth,omitempty"`
	DefaultCeiling   string `json:"default_ceiling,omitempty"`
	DefaultPriority  int    `json:"default_priority,omitempty"`
	DefaultQueue     string `json:"default_queue,omitempty"` // "fair-queue", "fq-codel", etc.
	// FQ-CoDel tunables (ignored by HTB/HFSC).
	CodelTarget   string `json:"codel_target,omitempty"`   // "5ms"
	CodelInterval string `json:"codel_interval,omitempty"` // "100ms"
}

// TrafficClass is one bucket inside an HTB/HFSC policy.
type TrafficClass struct {
	ID          int              `json:"id"`                  // 2..4095; 1 is reserved for default
	Description string           `json:"description,omitempty"`
	Bandwidth   string           `json:"bandwidth"`           // guaranteed — e.g. "100mbit"
	Ceiling     string           `json:"ceiling,omitempty"`   // max with borrowing; omit = no limit
	Priority    int              `json:"priority,omitempty"`  // 0..7, lower is higher priority
	Burst       string           `json:"burst,omitempty"`     // e.g. "15kb" — HTB only
	// Matchers decide which packets enter this class.
	Matchers []ClassMatcher `json:"matchers,omitempty"`
	// Queue discipline inside the class (codel/sfq/pfifo). Default: fq-codel.
	Queue string `json:"queue,omitempty"`
}

// ClassMatcher is a condition that selects packets for a class. Multiple
// matchers OR together; within one matcher all set fields AND together.
type ClassMatcher struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// IP-level fields.
	Protocol       string `json:"protocol,omitempty"` // tcp | udp | icmp | all
	SourceAddress  string `json:"source_address,omitempty"`
	SourcePort     string `json:"source_port,omitempty"`
	DestAddress    string `json:"dest_address,omitempty"`
	DestPort       string `json:"dest_port,omitempty"`
	DSCP           string `json:"dscp,omitempty"`     // "ef", "cs6", or numeric 0-63
	Mark           string `json:"mark,omitempty"`     // connmark / fwmark (set by firewall rules)
	VIF            int    `json:"vif,omitempty"`      // VLAN tag
	// TCP flag match (for prioritising ACKs etc).
	TCPFlags []string `json:"tcp_flags,omitempty"`
}

// TrafficPolicyBinding attaches a policy to an interface in a direction.
//
// VyOS shaper/HFSC/FQ-CoDel policies only operate on egress. To shape
// ingress (download) traffic, the kernel pattern is to redirect the iface's
// ingress packets to an IFB ("Intermediate Functional Block") and apply
// the shaper as egress on that IFB. We expose this via ShapeIngress: when
// true, the binding emits the IFB redirect + interface declaration + a
// second binding on the IFB, all in one atomic commit.
type TrafficPolicyBinding struct {
	PolicyName    string `json:"policy_name"`
	Interface     string `json:"interface"`               // "eth0"
	Kind          string `json:"kind"`                    // "ethernet" | "bond" | "vlan"
	Direction     string `json:"direction"`               // "egress" | "ingress" (legacy "in"/"out" accepted)
	ShapeIngress  bool   `json:"shape_ingress,omitempty"` // also emit IFB-based ingress shaping
	IFB           string `json:"ifb,omitempty"`           // IFB device name (auto-derived if empty)
}
