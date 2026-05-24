// Package translator converts between the semantic domain model and the
// VyOS path-based configuration tree. It's the single source of truth for
// how a Rule, Group, etc. maps to VyOS paths — any schema change must
// update encode and decode together.
package translator

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
)

// --- Encode: domain -> VyOS ops -------------------------------------------

// RuleSetOps returns ops for the rule-set container (default-action, desc)
// but NOT its rules. Callers append rule ops separately.
func RuleSetOps(rs model.RuleSet) ([]vyos.ConfigureOp, error) {
	if rs.Name == "" || (rs.Family != "ipv4" && rs.Family != "ipv6") {
		return nil, fmt.Errorf("invalid rule-set: name=%q family=%q", rs.Name, rs.Family)
	}
	base := []string{"firewall", rs.Family, "name", rs.Name}
	ops := []vyos.ConfigureOp{{
		Op: vyos.OpSet, Path: appendCopy(base, "default-action"),
		Value: string(rs.DefaultAction),
	}}
	if rs.Description != "" {
		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: appendCopy(base, "description"), Value: rs.Description,
		})
	}
	return ops, nil
}

// RuleOps returns ops for one rule — typically preceded by DeleteRuleOps
// for atomic replace semantics.
func RuleOps(family, ruleset string, r model.Rule) ([]vyos.ConfigureOp, error) {
	if err := validateRule(r); err != nil {
		return nil, err
	}
	base := []string{"firewall", family, "name", ruleset, "rule", strconv.Itoa(r.Number)}
	ops := []vyos.ConfigureOp{
		{Op: vyos.OpSet, Path: appendCopy(base, "action"), Value: string(r.Action)},
	}
	leaf := func(val string, keys ...string) {
		if val != "" {
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: joinPath(base, keys...), Value: val,
			})
		}
	}
	flag := func(on bool, keys ...string) {
		if on {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: joinPath(base, keys...)})
		}
	}

	leaf(r.Description, "description")
	leaf(r.Protocol, "protocol")
	flag(r.Log, "log")
	flag(r.Disable, "disable")
	if r.Action == model.ActionJump {
		leaf(r.JumpTarget, "jump-target")
	}

	ops = append(ops, addrSpecOps(base, "source", r.Source)...)
	ops = append(ops, addrSpecOps(base, "destination", r.Destination)...)

	if r.State != nil {
		flag(r.State.Established, "state", "established")
		flag(r.State.Related, "state", "related")
		flag(r.State.New, "state", "new")
		flag(r.State.Invalid, "state", "invalid")
	}

	for _, cc := range r.SourceCountries {
		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: joinPath(base, "source", "geoip", "country-code"), Value: cc,
		})
	}
	for _, cc := range r.DestinationCountries {
		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: joinPath(base, "destination", "geoip", "country-code"), Value: cc,
		})
	}
	return ops, nil
}

// DeleteRuleOps wipes a single rule.
func DeleteRuleOps(family, ruleset string, number int) []vyos.ConfigureOp {
	return []vyos.ConfigureOp{{
		Op:   vyos.OpDelete,
		Path: []string{"firewall", family, "name", ruleset, "rule", strconv.Itoa(number)},
	}}
}

// GroupOps returns ops to create or update a group.
func GroupOps(g model.Group) ([]vyos.ConfigureOp, error) {
	if g.Name == "" {
		return nil, fmt.Errorf("group name required")
	}
	base := groupBase(g)
	ops := []vyos.ConfigureOp{}
	if g.Description != "" {
		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: appendCopy(base, "description"), Value: g.Description,
		})
	}
	memberKey := memberKeyForGroup(g.Type)
	for _, m := range g.Members {
		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: appendCopy(base, memberKey), Value: m,
		})
	}
	return ops, nil
}

// DeleteGroupOps wipes a whole group (used before upsert for idempotency).
func DeleteGroupOps(g model.Group) []vyos.ConfigureOp {
	return []vyos.ConfigureOp{{Op: vyos.OpDelete, Path: groupBase(g)}}
}

// --- Decode: VyOS JSON -> domain ------------------------------------------

// DecodeRuleSet parses the JSON returned by retrieve(showConfig) for
// `firewall <family> name <n>`.
func DecodeRuleSet(family, name string, raw json.RawMessage) (*model.RuleSet, error) {
	var tree map[string]json.RawMessage
	// An empty/missing rule-set comes back as "null" or an empty object.
	if len(raw) == 0 || string(raw) == "null" {
		return &model.RuleSet{Name: name, Family: family}, nil
	}
	if err := json.Unmarshal(raw, &tree); err != nil {
		return nil, fmt.Errorf("decode rule-set: %w", err)
	}
	rs := &model.RuleSet{Name: name, Family: family}
	rs.DefaultAction = model.Action(unquote(tree["default-action"]))
	rs.Description = unquote(tree["description"])

	if rulesRaw, ok := tree["rule"]; ok && len(rulesRaw) > 0 {
		var rulesMap map[string]json.RawMessage
		if err := json.Unmarshal(rulesRaw, &rulesMap); err != nil {
			return nil, fmt.Errorf("decode rules map: %w", err)
		}
		for numStr, ruleRaw := range rulesMap {
			num, err := strconv.Atoi(numStr)
			if err != nil {
				continue
			}
			r, err := decodeRule(num, ruleRaw)
			if err != nil {
				return nil, fmt.Errorf("rule %d: %w", num, err)
			}
			rs.Rules = append(rs.Rules, r)
		}
		sort.Slice(rs.Rules, func(i, j int) bool { return rs.Rules[i].Number < rs.Rules[j].Number })
	}
	return rs, nil
}

// DecodeRuleSetList parses `firewall <family> name` (a map of name→ruleset).
func DecodeRuleSetList(family string, raw json.RawMessage) ([]model.RuleSet, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	out := make([]model.RuleSet, 0, len(m))
	for name, body := range m {
		rs, err := DecodeRuleSet(family, name, body)
		if err != nil {
			return nil, err
		}
		out = append(out, *rs)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// DecodeGroup parses one group's config body.
func DecodeGroup(name string, gtype model.GroupType, family string, raw json.RawMessage) (*model.Group, error) {
	g := &model.Group{Name: name, Type: gtype, Family: family}
	if len(raw) == 0 || string(raw) == "null" {
		return g, nil
	}
	var tree map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tree); err != nil {
		return nil, err
	}
	g.Description = unquote(tree["description"])
	memberKey := memberKeyForGroup(gtype)
	if v, ok := tree[memberKey]; ok {
		// VyOS returns multi-value leaves as an array; single-value as a string.
		if err := json.Unmarshal(v, &g.Members); err != nil {
			var s string
			if err := json.Unmarshal(v, &s); err == nil {
				g.Members = []string{s}
			}
		}
	}
	return g, nil
}

// --- internals -------------------------------------------------------------

func decodeRule(number int, raw json.RawMessage) (model.Rule, error) {
	var tree map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tree); err != nil {
		return model.Rule{}, err
	}
	r := model.Rule{Number: number}
	r.Action = model.Action(unquote(tree["action"]))
	r.Description = unquote(tree["description"])
	r.Protocol = unquote(tree["protocol"])
	r.JumpTarget = unquote(tree["jump-target"])
	_, r.Log = tree["log"]
	_, r.Disable = tree["disable"]
	if v, ok := tree["state"]; ok {
		r.State = decodeState(v)
	}
	if v, ok := tree["source"]; ok {
		r.Source, r.SourceCountries = decodeAddrSpec(v)
	}
	if v, ok := tree["destination"]; ok {
		r.Destination, r.DestinationCountries = decodeAddrSpec(v)
	}
	return r, nil
}

func decodeState(raw json.RawMessage) *model.State {
	var tree map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tree); err != nil {
		return nil
	}
	s := &model.State{}
	_, s.Established = tree["established"]
	_, s.Related = tree["related"]
	_, s.New = tree["new"]
	_, s.Invalid = tree["invalid"]
	return s
}

func decodeAddrSpec(raw json.RawMessage) (*model.AddrSpec, []string) {
	var tree map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tree); err != nil {
		return nil, nil
	}
	a := &model.AddrSpec{
		Address: unquote(tree["address"]),
		Port:    unquote(tree["port"]),
		MAC:     unquote(tree["mac-address"]),
	}
	if v, ok := tree["group"]; ok {
		a.Group = decodeGroupRef(v)
	}
	var countries []string
	if v, ok := tree["geoip"]; ok {
		var gt map[string]json.RawMessage
		if json.Unmarshal(v, &gt) == nil {
			if cc, ok := gt["country-code"]; ok {
				if err := json.Unmarshal(cc, &countries); err != nil {
					var one string
					if json.Unmarshal(cc, &one) == nil && one != "" {
						countries = []string{one}
					}
				}
			}
		}
	}
	if a.Address == "" && a.Port == "" && a.MAC == "" && a.Group == nil {
		a = nil
	}
	return a, countries
}

func decodeGroupRef(raw json.RawMessage) *model.GroupRef {
	var tree map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tree); err != nil {
		return nil
	}
	g := &model.GroupRef{
		AddressGroup:   unquote(tree["address-group"]),
		NetworkGroup:   unquote(tree["network-group"]),
		PortGroup:      unquote(tree["port-group"]),
		DomainGroup:    unquote(tree["domain-group"]),
		MACGroup:       unquote(tree["mac-group"]),
		InterfaceGroup: unquote(tree["interface-group"]),
	}
	return g
}

func addrSpecOps(base []string, side string, a *model.AddrSpec) []vyos.ConfigureOp {
	if a == nil {
		return nil
	}
	var ops []vyos.ConfigureOp
	leaf := func(val string, keys ...string) {
		if val != "" {
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: joinPath(base, append([]string{side}, keys...)...), Value: val,
			})
		}
	}
	leaf(a.Address, "address")
	leaf(a.Port, "port")
	leaf(a.MAC, "mac-address")
	if a.Group != nil {
		leaf(a.Group.AddressGroup, "group", "address-group")
		leaf(a.Group.NetworkGroup, "group", "network-group")
		leaf(a.Group.PortGroup, "group", "port-group")
		leaf(a.Group.DomainGroup, "group", "domain-group")
		leaf(a.Group.MACGroup, "group", "mac-group")
		leaf(a.Group.InterfaceGroup, "group", "interface-group")
	}
	return ops
}

func groupBase(g model.Group) []string {
	base := []string{"firewall", "group"}
	switch g.Type {
	case model.GroupAddress, model.GroupNetwork:
		if g.Family == "ipv6" {
			base = append(base, "ipv6-"+string(g.Type))
		} else {
			base = append(base, string(g.Type))
		}
	default:
		base = append(base, string(g.Type))
	}
	return append(base, g.Name)
}

func memberKeyForGroup(t model.GroupType) string {
	switch t {
	case model.GroupAddress:
		return "address"
	case model.GroupNetwork:
		return "network"
	case model.GroupPort:
		return "port"
	case model.GroupDomain:
		return "address"
	case model.GroupMAC:
		return "mac-address"
	case model.GroupInterface:
		return "interface"
	}
	return "address"
}

func validateRule(r model.Rule) error {
	if r.Number < 1 || r.Number > 999999 {
		return fmt.Errorf("rule number must be 1..999999, got %d", r.Number)
	}
	if r.Action == "" {
		return fmt.Errorf("action required")
	}
	if r.Action == model.ActionJump && r.JumpTarget == "" {
		return fmt.Errorf("jump-target required when action=jump")
	}
	return nil
}

// appendCopy / joinPath: never share backing arrays between ops. A subtle
// but critical correctness point — without these helpers, a later append
// on one op's Path can clobber an earlier op's Path.
func appendCopy(base []string, extra ...string) []string {
	out := make([]string, 0, len(base)+len(extra))
	out = append(out, base...)
	out = append(out, extra...)
	return out
}

func joinPath(base []string, extra ...string) []string { return appendCopy(base, extra...) }

func unquote(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}
