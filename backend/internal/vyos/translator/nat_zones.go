package translator

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
)

// --- NAT encode -----------------------------------------------------------

func NATRuleOps(r model.NATRule) ([]vyos.ConfigureOp, error) {
	if r.Direction != model.NATSource && r.Direction != model.NATDestination {
		return nil, fmt.Errorf("invalid NAT direction: %q", r.Direction)
	}
	if r.Number < 1 || r.Number > 999999 {
		return nil, fmt.Errorf("NAT rule number must be 1..999999, got %d", r.Number)
	}
	base := []string{"nat", string(r.Direction), "rule", strconv.Itoa(r.Number)}
	var ops []vyos.ConfigureOp
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
	// VyOS 1.4+ uses `inbound-interface name <if>` and `outbound-interface name <if>`.
	leaf(r.InboundInterface, "inbound-interface", "name")
	leaf(r.OutboundInterface, "outbound-interface", "name")
	ops = append(ops, addrSpecOps(base, "source", r.Source)...)
	ops = append(ops, addrSpecOps(base, "destination", r.Destination)...)
	leaf(r.TranslationAddress, "translation", "address")
	leaf(r.TranslationPort, "translation", "port")
	flag(r.Disable, "disable")
	flag(r.Log, "log")
	return ops, nil
}

func DeleteNATRuleOps(direction model.NATDirection, number int) []vyos.ConfigureOp {
	return []vyos.ConfigureOp{{
		Op:   vyos.OpDelete,
		Path: []string{"nat", string(direction), "rule", strconv.Itoa(number)},
	}}
}

// --- NAT decode ------------------------------------------------------------

// DecodeNATRules parses `nat <direction>` config.
func DecodeNATRules(direction model.NATDirection, raw json.RawMessage) ([]model.NATRule, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var tree map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tree); err != nil {
		return nil, err
	}
	rulesRaw, ok := tree["rule"]
	if !ok {
		return nil, nil
	}
	var rulesMap map[string]json.RawMessage
	if err := json.Unmarshal(rulesRaw, &rulesMap); err != nil {
		return nil, err
	}
	var out []model.NATRule
	for numStr, body := range rulesMap {
		num, err := strconv.Atoi(numStr)
		if err != nil {
			continue
		}
		var rt map[string]json.RawMessage
		if err := json.Unmarshal(body, &rt); err != nil {
			continue
		}
		r := model.NATRule{Number: num, Direction: direction}
		r.Description = unquote(rt["description"])
		r.Protocol = unquote(rt["protocol"])
		_, r.Disable = rt["disable"]
		_, r.Log = rt["log"]

		if v, ok := rt["inbound-interface"]; ok {
			var ii map[string]json.RawMessage
			if json.Unmarshal(v, &ii) == nil {
				r.InboundInterface = unquote(ii["name"])
			}
		}
		if v, ok := rt["outbound-interface"]; ok {
			var oi map[string]json.RawMessage
			if json.Unmarshal(v, &oi) == nil {
				r.OutboundInterface = unquote(oi["name"])
			}
		}
		if v, ok := rt["source"]; ok {
			r.Source, _ = decodeAddrSpec(v)
		}
		if v, ok := rt["destination"]; ok {
			r.Destination, _ = decodeAddrSpec(v)
		}
		if v, ok := rt["translation"]; ok {
			var tr map[string]json.RawMessage
			if json.Unmarshal(v, &tr) == nil {
				r.TranslationAddress = unquote(tr["address"])
				r.TranslationPort = unquote(tr["port"])
			}
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out, nil
}

// --- Zones encode ----------------------------------------------------------

func ZoneOps(z model.Zone) ([]vyos.ConfigureOp, error) {
	if z.Name == "" {
		return nil, fmt.Errorf("zone name required")
	}
	base := []string{"firewall", "zone", z.Name}
	var ops []vyos.ConfigureOp
	if z.Description != "" {
		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: appendCopy(base, "description"), Value: z.Description,
		})
	}
	if z.LocalZone {
		ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(base, "local-zone")})
	}
	if z.DefaultAction != "" {
		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: appendCopy(base, "default-action"), Value: string(z.DefaultAction),
		})
	}
	for _, iface := range z.Interfaces {
		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: appendCopy(base, "interface"), Value: iface,
		})
	}
	return ops, nil
}

func DeleteZoneOps(name string) []vyos.ConfigureOp {
	return []vyos.ConfigureOp{{Op: vyos.OpDelete, Path: []string{"firewall", "zone", name}}}
}

// ZonePolicyOps sets the rule-set that applies to traffic from → to.
// VyOS 1.4+ syntax: firewall zone <to> from <from> firewall <family>-name <rs>
func ZonePolicyOps(p model.ZonePolicy) ([]vyos.ConfigureOp, error) {
	if p.FromZone == "" || p.ToZone == "" || p.RuleSet == "" {
		return nil, fmt.Errorf("from_zone, to_zone, rule_set all required")
	}
	if p.Family != "ipv4" && p.Family != "ipv6" {
		p.Family = "ipv4"
	}
	nameKey := "name"
	if p.Family == "ipv6" {
		nameKey = "ipv6-name"
	}
	return []vyos.ConfigureOp{{
		Op:    vyos.OpSet,
		Path:  []string{"firewall", "zone", p.ToZone, "from", p.FromZone, "firewall", nameKey},
		Value: p.RuleSet,
	}}, nil
}

// --- Zones decode ---------------------------------------------------------

// DecodeZones parses `firewall zone` config into Zones + ZonePolicies.
func DecodeZones(raw json.RawMessage) ([]model.Zone, []model.ZonePolicy, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil, nil
	}
	var tree map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tree); err != nil {
		return nil, nil, err
	}
	var zones []model.Zone
	var policies []model.ZonePolicy
	for zoneName, body := range tree {
		var zt map[string]json.RawMessage
		if err := json.Unmarshal(body, &zt); err != nil {
			continue
		}
		z := model.Zone{Name: zoneName}
		z.Description = unquote(zt["description"])
		_, z.LocalZone = zt["local-zone"]
		z.DefaultAction = model.Action(unquote(zt["default-action"]))
		if v, ok := zt["interface"]; ok {
			_ = json.Unmarshal(v, &z.Interfaces)
			if z.Interfaces == nil {
				var one string
				if json.Unmarshal(v, &one) == nil && one != "" {
					z.Interfaces = []string{one}
				}
			}
		}
		zones = append(zones, z)

		if v, ok := zt["from"]; ok {
			var froms map[string]json.RawMessage
			if json.Unmarshal(v, &froms) == nil {
				for fromName, fromBody := range froms {
					var ft map[string]json.RawMessage
					if err := json.Unmarshal(fromBody, &ft); err != nil {
						continue
					}
					if fw, ok := ft["firewall"]; ok {
						var fwt map[string]json.RawMessage
						if json.Unmarshal(fw, &fwt) == nil {
							if rs := unquote(fwt["name"]); rs != "" {
								policies = append(policies, model.ZonePolicy{
									FromZone: fromName, ToZone: zoneName,
									RuleSet: rs, Family: "ipv4",
								})
							}
							if rs := unquote(fwt["ipv6-name"]); rs != "" {
								policies = append(policies, model.ZonePolicy{
									FromZone: fromName, ToZone: zoneName,
									RuleSet: rs, Family: "ipv6",
								})
							}
						}
					}
				}
			}
		}
	}
	sort.Slice(zones, func(i, j int) bool { return zones[i].Name < zones[j].Name })
	sort.Slice(policies, func(i, j int) bool {
		if policies[i].FromZone != policies[j].FromZone {
			return policies[i].FromZone < policies[j].FromZone
		}
		return policies[i].ToZone < policies[j].ToZone
	})
	return zones, policies, nil
}
