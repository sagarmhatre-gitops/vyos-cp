// Interfaces and Groups list — translator additions for read/edit support.
package translator

import (
	"encoding/json"
	"sort"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
)

// --- Interfaces ------------------------------------------------------------

// DecodeInterfaces parses `interfaces` config into a flat list. Covers
// ethernet, bond, bridge, loopback, vlan, dummy, wireguard. VRF, MTU,
// description, and address lists are surfaced.
func DecodeInterfaces(raw json.RawMessage) ([]model.Interface, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var tree map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tree); err != nil {
		return nil, err
	}

	var out []model.Interface
	for kind, body := range tree {
		// body is a map of interface name -> properties for most kinds;
		// "loopback" uses a single-name "lo" container, but same shape.
		var members map[string]json.RawMessage
		if err := json.Unmarshal(body, &members); err != nil {
			continue
		}
		for name, propsRaw := range members {
			iface := model.Interface{Kind: kind, Name: name}
			var props map[string]json.RawMessage
			if err := json.Unmarshal(propsRaw, &props); err == nil {
				iface.Description = unquote(props["description"])
				iface.MTU = unquote(props["mtu"])
				iface.VRF = unquote(props["vrf"])
				iface.HWID = unquote(props["hw-id"])
				if v, ok := props["address"]; ok {
					if err := json.Unmarshal(v, &iface.Addresses); err != nil {
						var single string
						if json.Unmarshal(v, &single) == nil && single != "" {
							iface.Addresses = []string{single}
						}
					}
				}
				if v, ok := props["disable"]; ok {
					_ = v
					iface.Disabled = true
				}
			}
			out = append(out, iface)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// InterfaceOps returns ops to upsert an interface. Address lists use
// delete-then-set for idempotent replace.
func InterfaceOps(iface model.Interface) ([]vyos.ConfigureOp, error) {
	base := []string{"interfaces", iface.Kind, iface.Name}
	ops := []vyos.ConfigureOp{
		{Op: vyos.OpDelete, Path: appendCopy(base, "address")},
	}
	leaf := func(val, key string) {
		if val != "" {
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: appendCopy(base, key), Value: val,
			})
		}
	}
	leaf(iface.Description, "description")
	leaf(iface.MTU, "mtu")
	leaf(iface.VRF, "vrf")
	for _, addr := range iface.Addresses {
		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: appendCopy(base, "address"), Value: addr,
		})
	}
	if iface.Disabled {
		ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(base, "disable")})
	}
	return ops, nil
}

// --- Groups list -----------------------------------------------------------

// DecodeAllGroups parses `firewall group` into a flat list of Group values.
func DecodeAllGroups(raw json.RawMessage) ([]model.Group, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var tree map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tree); err != nil {
		return nil, err
	}
	var out []model.Group
	for typeKey, body := range tree {
		// typeKey is one of: address-group, network-group, port-group,
		// domain-group, mac-group, interface-group, ipv6-address-group,
		// ipv6-network-group.
		family := "ipv4"
		gtype := typeKey
		if len(typeKey) > 5 && typeKey[:5] == "ipv6-" {
			family = "ipv6"
			gtype = typeKey[5:]
		}
		var members map[string]json.RawMessage
		if err := json.Unmarshal(body, &members); err != nil {
			continue
		}
		for name, groupBody := range members {
			g, err := DecodeGroup(name, model.GroupType(gtype), family, groupBody)
			if err != nil || g == nil {
				continue
			}
			out = append(out, *g)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type < out[j].Type
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}
