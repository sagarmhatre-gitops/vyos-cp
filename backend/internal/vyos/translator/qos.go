package translator

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
)

// --- Traffic policy encode ------------------------------------------------

// TrafficPolicyOps produces the ops to create/replace a policy idempotently.
// Emits a single delete at the root so that stale classes from a prior
// definition don't linger after the set-ops apply.
func TrafficPolicyOps(p model.TrafficPolicy) ([]vyos.ConfigureOp, error) {
	if p.Name == "" {
		return nil, fmt.Errorf("traffic-policy name required")
	}
	shaperKey, err := shaperKeyFor(p.Engine)
	if err != nil {
		return nil, err
	}
	base := []string{"qos", "policy", shaperKey, p.Name}
	ops := []vyos.ConfigureOp{{Op: vyos.OpDelete, Path: base}}

	leaf := func(val string, keys ...string) {
		if val != "" {
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: appendCopy(base, keys...), Value: val,
			})
		}
	}
	leaf(p.Description, "description")
	leaf(p.Bandwidth, "bandwidth")

	switch p.Engine {
	case model.QoSFQCoDel:
		// Non-hierarchical: only target/interval knobs apply.
		leaf(p.CodelTarget, "target")
		leaf(p.CodelInterval, "interval")
	case model.QoSHTB:
		// HTB default class accepts bandwidth / ceiling / priority directly.
		def := appendCopy(base, "default")
		if p.DefaultBandwidth != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(def, "bandwidth"), Value: p.DefaultBandwidth})
		}
		if p.DefaultCeiling != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(def, "ceiling"), Value: p.DefaultCeiling})
		}
		if p.DefaultPriority > 0 {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(def, "priority"), Value: strconv.Itoa(p.DefaultPriority)})
		}
		if p.DefaultQueue != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(def, "queue-type"), Value: p.DefaultQueue})
		}
		// Classes.
		for _, c := range p.Classes {
			cOps, err := classOps(base, c, p.Engine)
			if err != nil {
				return nil, fmt.Errorf("class %d: %w", c.ID, err)
			}
			ops = append(ops, cOps...)
		}
	case model.QoSHFSC:
		// HFSC uses a totally different shape — link-share + real-time +
		// upper-limit curves, each with m1/d/m2 parameters. We expose the
		// simple m2 values via DefaultBandwidth (linkshare) and DefaultCeiling
		// (upperlimit). HFSC has no priority concept.
		def := appendCopy(base, "default")
		if p.DefaultBandwidth != "" {
			// linkshare m2 = guaranteed throughput (the usual "bandwidth").
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: appendCopy(def, "linkshare", "m2"), Value: p.DefaultBandwidth,
			})
		}
		if p.DefaultCeiling != "" {
			// upperlimit m2 = hard ceiling (the usual "ceiling").
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: appendCopy(def, "upperlimit", "m2"), Value: p.DefaultCeiling,
			})
		}
		// Classes.
		for _, c := range p.Classes {
			cOps, err := classOps(base, c, p.Engine)
			if err != nil {
				return nil, fmt.Errorf("class %d: %w", c.ID, err)
			}
			ops = append(ops, cOps...)
		}
	default:
		return nil, fmt.Errorf("unsupported QoS engine: %q", p.Engine)
	}
	return ops, nil
}

func shaperKeyFor(e model.QoSEngine) (string, error) {
	switch e {
	case model.QoSHTB:
		return "shaper", nil
	case model.QoSHFSC:
		return "shaper-hfsc", nil
	case model.QoSFQCoDel:
		return "fq-codel", nil
	default:
		return "", fmt.Errorf("unknown QoS engine: %q", e)
	}
}

func classOps(policyBase []string, c model.TrafficClass, engine model.QoSEngine) ([]vyos.ConfigureOp, error) {
	if c.ID < 2 || c.ID > 4095 {
		return nil, fmt.Errorf("class ID must be 2..4095, got %d", c.ID)
	}
	if c.Bandwidth == "" {
		return nil, fmt.Errorf("class %d bandwidth is required", c.ID)
	}
	base := appendCopy(policyBase, "class", strconv.Itoa(c.ID))
	var ops []vyos.ConfigureOp

	if engine == model.QoSHFSC {
		// HFSC: bandwidth → linkshare m2, ceiling → upperlimit m2.
		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: appendCopy(base, "linkshare", "m2"), Value: c.Bandwidth,
		})
		if c.Ceiling != "" {
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: appendCopy(base, "upperlimit", "m2"), Value: c.Ceiling,
			})
		}
	} else {
		// HTB: direct bandwidth/ceiling/priority leaves.
		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: appendCopy(base, "bandwidth"), Value: c.Bandwidth,
		})
		if c.Ceiling != "" {
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: appendCopy(base, "ceiling"), Value: c.Ceiling,
			})
		}
		if c.Priority > 0 {
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: appendCopy(base, "priority"), Value: strconv.Itoa(c.Priority),
			})
		}
		if c.Burst != "" {
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: appendCopy(base, "burst"), Value: c.Burst,
			})
		}
	}

	// Universal leaves (apply to both HTB and HFSC):
	leaf := func(val string, keys ...string) {
		if val != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(base, keys...), Value: val})
		}
	}
	leaf(c.Description, "description")
	leaf(c.Queue, "queue-type")

	// Matchers.
	for _, m := range c.Matchers {
		if m.Name == "" {
			return nil, fmt.Errorf("class %d: matcher name required", c.ID)
		}
		mBase := appendCopy(base, "match", m.Name)
		leafM := func(val string, keys ...string) {
			if val != "" {
				ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(mBase, keys...), Value: val})
			}
		}
		leafM(m.Description, "description")
		// ipv4-level fields live under "ip" in VyOS config.
		ipBase := appendCopy(mBase, "ip")
		leafIP := func(val string, keys ...string) {
			if val != "" {
				ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(ipBase, keys...), Value: val})
			}
		}
		leafIP(m.Protocol, "protocol")
		leafIP(m.SourceAddress, "source", "address")
		leafIP(m.SourcePort, "source", "port")
		leafIP(m.DestAddress, "destination", "address")
		leafIP(m.DestPort, "destination", "port")
		leafIP(m.DSCP, "dscp")
		leafM(m.Mark, "mark")
		if m.VIF > 0 {
			leafM(strconv.Itoa(m.VIF), "vif")
		}
		for _, flag := range m.TCPFlags {
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: appendCopy(ipBase, "tcp", "flags"), Value: flag,
			})
		}
	}
	return ops, nil
}

// --- Traffic policy decode ------------------------------------------------

// DecodeTrafficPolicies parses the `qos.policy` config subtree into a flat
// list of policies. Handles all three shaper types (shaper, shaper-hfsc,
// fq-codel); other types are skipped but not errored. Tolerates VyOS 1.5
// wrapping the response under an outer "policy" key.
func DecodeTrafficPolicies(raw json.RawMessage) ([]model.TrafficPolicy, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var tree map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tree); err != nil {
		return nil, err
	}
	// VyOS 1.5 sometimes wraps /retrieve responses with the last path segment
	// as an outer key ("policy" here). If we see that, unwrap one level.
	if inner, ok := tree["policy"]; ok && len(tree) == 1 {
		if err := json.Unmarshal(inner, &tree); err != nil {
			return nil, err
		}
	}
	kinds := map[string]model.QoSEngine{
		"shaper":      model.QoSHTB,
		"shaper-hfsc": model.QoSHFSC,
		"fq-codel":    model.QoSFQCoDel,
	}
	var out []model.TrafficPolicy
	for key, body := range tree {
		engine, ok := kinds[key]
		if !ok {
			continue
		}
		var members map[string]json.RawMessage
		if err := json.Unmarshal(body, &members); err != nil {
			continue
		}
		for name, polBody := range members {
			p, err := decodePolicy(name, engine, polBody)
			if err != nil {
				continue
			}
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func decodePolicy(name string, engine model.QoSEngine, raw json.RawMessage) (model.TrafficPolicy, error) {
	p := model.TrafficPolicy{Name: name, Engine: engine}
	var pt map[string]json.RawMessage
	if err := json.Unmarshal(raw, &pt); err != nil {
		return p, err
	}
	p.Description = unquote(pt["description"])
	p.Bandwidth = unquote(pt["bandwidth"])

	if engine == model.QoSFQCoDel {
		p.CodelTarget = unquote(pt["target"])
		p.CodelInterval = unquote(pt["interval"])
		return p, nil
	}

	// Default class — HTB has flat bandwidth/ceiling/priority leaves, HFSC
	// has linkshare/upperlimit/realtime curves with m1/d/m2 sub-leaves. We
	// only consume the m2 (rate) value of linkshare and upperlimit, which is
	// what most operators care about; m1/d for slope shaping is rarely used.
	if dRaw, ok := pt["default"]; ok {
		var d map[string]json.RawMessage
		if json.Unmarshal(dRaw, &d) == nil {
			if engine == model.QoSHFSC {
				if ls, ok := d["linkshare"]; ok {
					var lsMap map[string]json.RawMessage
					if json.Unmarshal(ls, &lsMap) == nil {
						p.DefaultBandwidth = unquote(lsMap["m2"])
					}
				}
				if ul, ok := d["upperlimit"]; ok {
					var ulMap map[string]json.RawMessage
					if json.Unmarshal(ul, &ulMap) == nil {
						p.DefaultCeiling = unquote(ulMap["m2"])
					}
				}
			} else {
				p.DefaultBandwidth = unquote(d["bandwidth"])
				p.DefaultCeiling = unquote(d["ceiling"])
				if prio := unquote(d["priority"]); prio != "" {
					p.DefaultPriority, _ = strconv.Atoi(prio)
				}
				p.DefaultQueue = unquote(d["queue-type"])
			}
		}
	}
	if cRaw, ok := pt["class"]; ok {
		var classes map[string]json.RawMessage
		if json.Unmarshal(cRaw, &classes) == nil {
			for idStr, cBody := range classes {
				id, err := strconv.Atoi(idStr)
				if err != nil {
					continue
				}
				p.Classes = append(p.Classes, decodeClass(id, cBody, engine))
			}
			sort.Slice(p.Classes, func(i, j int) bool { return p.Classes[i].ID < p.Classes[j].ID })
		}
	}
	return p, nil
}

func decodeClass(id int, raw json.RawMessage, engine model.QoSEngine) model.TrafficClass {
	c := model.TrafficClass{ID: id}
	var ct map[string]json.RawMessage
	if err := json.Unmarshal(raw, &ct); err != nil {
		return c
	}
	c.Description = unquote(ct["description"])

	if engine == model.QoSHFSC {
		// linkshare m2 = bandwidth, upperlimit m2 = ceiling (mirror of encoder).
		if ls, ok := ct["linkshare"]; ok {
			var lsMap map[string]json.RawMessage
			if json.Unmarshal(ls, &lsMap) == nil {
				c.Bandwidth = unquote(lsMap["m2"])
			}
		}
		if ul, ok := ct["upperlimit"]; ok {
			var ulMap map[string]json.RawMessage
			if json.Unmarshal(ul, &ulMap) == nil {
				c.Ceiling = unquote(ulMap["m2"])
			}
		}
	} else {
		c.Bandwidth = unquote(ct["bandwidth"])
		c.Ceiling = unquote(ct["ceiling"])
		c.Burst = unquote(ct["burst"])
	}
	c.Queue = unquote(ct["queue-type"])
	if p := unquote(ct["priority"]); p != "" {
		c.Priority, _ = strconv.Atoi(p)
	}
	if mRaw, ok := ct["match"]; ok {
		var matches map[string]json.RawMessage
		if json.Unmarshal(mRaw, &matches) == nil {
			for name, mBody := range matches {
				c.Matchers = append(c.Matchers, decodeMatcher(name, mBody))
			}
			sort.Slice(c.Matchers, func(i, j int) bool { return c.Matchers[i].Name < c.Matchers[j].Name })
		}
	}
	return c
}

func decodeMatcher(name string, raw json.RawMessage) model.ClassMatcher {
	m := model.ClassMatcher{Name: name}
	var mt map[string]json.RawMessage
	if err := json.Unmarshal(raw, &mt); err != nil {
		return m
	}
	m.Description = unquote(mt["description"])
	m.Mark = unquote(mt["mark"])
	if v := unquote(mt["vif"]); v != "" {
		m.VIF, _ = strconv.Atoi(v)
	}
	if ipRaw, ok := mt["ip"]; ok {
		var ip map[string]json.RawMessage
		if json.Unmarshal(ipRaw, &ip) == nil {
			m.Protocol = unquote(ip["protocol"])
			m.DSCP = unquote(ip["dscp"])
			if s, ok := ip["source"]; ok {
				var sm map[string]json.RawMessage
				if json.Unmarshal(s, &sm) == nil {
					m.SourceAddress = unquote(sm["address"])
					m.SourcePort = unquote(sm["port"])
				}
			}
			if d, ok := ip["destination"]; ok {
				var dm map[string]json.RawMessage
				if json.Unmarshal(d, &dm) == nil {
					m.DestAddress = unquote(dm["address"])
					m.DestPort = unquote(dm["port"])
				}
			}
		}
	}
	return m
}

// --- Interface binding ----------------------------------------------------

// BindingOps attaches a policy to an interface. Emits one or three ops
// depending on the binding mode:
//
//   - egress only: `set qos interface <iface> egress <policy>`
//   - both directions (ShapeIngress=true): emits the egress binding on the
//     real interface, AND wires an IFB device + redirect + egress binding on
//     the IFB so that ingress traffic is shaped via the IFB egress queue
//
// VyOS 1.5 paths used for two-direction shaping:
//
//	set qos interface eth0 egress NeysaShaper       # outbound shaping
//	set interfaces ethernet eth0 redirect ifb-eth0   # mirror eth0 ingress -> ifb
//	set interfaces input ifb-eth0                    # declare the IFB device
//	set qos interface ifb-eth0 egress NeysaShaper    # shape ifb egress (= eth0 ingress)
func BindingOps(b model.TrafficPolicyBinding) ([]vyos.ConfigureOp, error) {
	if b.PolicyName == "" || b.Interface == "" {
		return nil, fmt.Errorf("policy_name and interface are required")
	}
	kind := b.Kind
	if kind == "" {
		kind = "ethernet"
	}
	dir := normaliseDir(b.Direction)

	var ops []vyos.ConfigureOp

	// Always emit the primary binding on the real interface.
	ops = append(ops, vyos.ConfigureOp{
		Op:    vyos.OpSet,
		Path:  []string{"qos", "interface", b.Interface, dir},
		Value: b.PolicyName,
	})

	// If ShapeIngress is on, set up the IFB pattern. Only meaningful when
	// the primary direction is egress (so we shape outbound directly and
	// route inbound via the IFB).
	if b.ShapeIngress && dir == "egress" {
		ifb := b.IFB
		if ifb == "" {
			ifb = ifbNameFor(b.Interface)
		}
		// Redirect ingress traffic from the real interface to the IFB.
		ops = append(ops, vyos.ConfigureOp{
			Op:    vyos.OpSet,
			Path:  []string{"interfaces", kind, b.Interface, "redirect"},
			Value: ifb,
		})
		// Declare the IFB so VyOS instantiates it at commit time.
		ops = append(ops, vyos.ConfigureOp{
			Op:   vyos.OpSet,
			Path: []string{"interfaces", "input", ifb},
		})
		// Apply the same policy as egress on the IFB — this is what actually
		// shapes the inbound traffic that was redirected here.
		ops = append(ops, vyos.ConfigureOp{
			Op:    vyos.OpSet,
			Path:  []string{"qos", "interface", ifb, "egress"},
			Value: b.PolicyName,
		})
	}

	return ops, nil
}

// UnbindOps removes the policy attachment, including any IFB plumbing if
// ShapeIngress was set when binding. Order matters: VyOS rejects deleting
// an IFB while its qos binding still references it, so we tear down qos first.
func UnbindOps(b model.TrafficPolicyBinding) []vyos.ConfigureOp {
	dir := normaliseDir(b.Direction)
	kind := b.Kind
	if kind == "" {
		kind = "ethernet"
	}

	ops := []vyos.ConfigureOp{{
		Op:   vyos.OpDelete,
		Path: []string{"qos", "interface", b.Interface, dir},
	}}

	if b.ShapeIngress && dir == "egress" {
		ifb := b.IFB
		if ifb == "" {
			ifb = ifbNameFor(b.Interface)
		}
		ops = append(ops,
			vyos.ConfigureOp{Op: vyos.OpDelete, Path: []string{"qos", "interface", ifb}},
			vyos.ConfigureOp{Op: vyos.OpDelete, Path: []string{"interfaces", kind, b.Interface, "redirect"}},
			vyos.ConfigureOp{Op: vyos.OpDelete, Path: []string{"interfaces", "input", ifb}},
		)
	}
	return ops
}

// normaliseDir converts legacy "in"/"out" to VyOS 1.5 "ingress"/"egress".
func normaliseDir(d string) string {
	switch d {
	case "", "out":
		return "egress"
	case "in":
		return "ingress"
	}
	return d
}

// ifbNameForFallback returns a deterministic IFB name when the caller
// hasn't allocated one. We use ifb0; for multiple two-direction bindings
// the service layer should allocate ifb1, ifb2, ... by inspecting the
// running config first. The kernel auto-creates ifb0..N (numifbs= module
// param, default 2 on Linux), so these names are special — VyOS only
// accepts them as `interfaces input` when /sys/class/net/<name> exists.
//
// Earlier we tried ifb-eth0 (clearer pairing) but VyOS rejected it because
// the kernel doesn't create that name. The dashed form would require
// `ip link add` outside the VyOS config tree, which we don't want to do.
func ifbNameFor(iface string) string {
	return "ifb0"
}

// DeleteTrafficPolicyOps drops an entire policy from the device.
func DeleteTrafficPolicyOps(engine model.QoSEngine, name string) ([]vyos.ConfigureOp, error) {
	shaperKey, err := shaperKeyFor(engine)
	if err != nil {
		return nil, err
	}
	return []vyos.ConfigureOp{{
		Op: vyos.OpDelete, Path: []string{"qos", "policy", shaperKey, name},
	}}, nil
}
