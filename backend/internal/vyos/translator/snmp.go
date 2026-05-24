package translator

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
)

// --- SNMP encode ----------------------------------------------------------

// SNMPConfigOps returns the ops to replace the device's SNMP configuration
// with the given state. Idempotent: deletes `service snmp` first, then sets
// everything anew in a single batch. This avoids "partial update" states
// where a rollback leaves stale users/communities.
func SNMPConfigOps(c model.SNMPConfig) ([]vyos.ConfigureOp, error) {
	base := []string{"service", "snmp"}
	ops := []vyos.ConfigureOp{{Op: vyos.OpDelete, Path: base}}

	leaf := func(val string, keys ...string) {
		if val != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(base, keys...), Value: val})
		}
	}
	leaf(c.Contact, "contact")
	leaf(c.Location, "location")
	leaf(c.Description, "description")
	leaf(c.VRF, "vrf")

	// Listen.
	for _, addr := range c.ListenAddresses {
		ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(base, "listen-address"), Value: addr})
	}
	if c.ListenPort > 0 && c.ListenPort != 161 {
		for _, addr := range c.ListenAddresses {
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: appendCopy(base, "listen-address", addr, "port"),
				Value: strconv.Itoa(c.ListenPort),
			})
		}
	}

	// v2c communities.
	for _, com := range c.Communities {
		if com.Name == "" {
			return nil, fmt.Errorf("snmp community: name required")
		}
		cBase := appendCopy(base, "community", com.Name)
		if com.Authorization != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(cBase, "authorization"), Value: com.Authorization})
		}
		for _, client := range com.Clients {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(cBase, "client"), Value: client})
		}
		for _, net := range com.Network {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(cBase, "network"), Value: net})
		}
	}

	// v3 engine-id.
	if c.EngineID != "" {
		ops = append(ops, vyos.ConfigureOp{
			Op: vyos.OpSet, Path: appendCopy(base, "v3", "engineid"), Value: c.EngineID,
		})
	}

	// v3 views. Always emit a Set on the oid path itself so the view is
	// actually created — VyOS needs the node to exist before any group can
	// reference it. Mask/exclude are optional modifiers added on top.
	for _, v := range c.V3Views {
		if v.Name == "" {
			return nil, fmt.Errorf("snmp v3 view: name required")
		}
		vBase := appendCopy(base, "v3", "view", v.Name)
		for _, oid := range v.OIDs {
			ops = append(ops, vyos.ConfigureOp{
				Op: vyos.OpSet, Path: appendCopy(vBase, "oid", oid),
			})
			oBase := appendCopy(vBase, "oid", oid)
			if v.Mask != "" {
				ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(oBase, "mask"), Value: v.Mask})
			}
			if v.Exclude {
				ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(oBase, "exclude")})
			}
		}
	}

	// v3 groups.
	for _, g := range c.V3Groups {
		if g.Name == "" {
			return nil, fmt.Errorf("snmp v3 group: name required")
		}
		gBase := appendCopy(base, "v3", "group", g.Name)
		if g.Mode != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(gBase, "mode"), Value: g.Mode})
		}
		if g.SecLevel != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(gBase, "seclevel"), Value: g.SecLevel})
		}
		if g.View != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(gBase, "view"), Value: g.View})
		}
	}

	// v3 users.
	for _, u := range c.V3Users {
		if u.Name == "" {
			return nil, fmt.Errorf("snmp v3 user: name required")
		}
		if u.AuthProtocol == "md5" {
			return nil, fmt.Errorf("snmp v3 user %q: md5 is deprecated, use sha", u.Name)
		}
		uBase := appendCopy(base, "v3", "user", u.Name)
		if u.Group != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(uBase, "group"), Value: u.Group})
		}
		if u.EngineID != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(uBase, "engineid"), Value: u.EngineID})
		}
		if u.AuthProtocol != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(uBase, "auth", "type"), Value: u.AuthProtocol})
		}
		// Auth password: prefer plaintext (newly typed by user), else round-trip
		// the existing encrypted hash so VyOS keeps the existing credential
		// after the upstream `delete service snmp` wipes the tree.
		if u.AuthPassword != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(uBase, "auth", "plaintext-password"), Value: u.AuthPassword})
		} else if u.AuthEncrypted != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(uBase, "auth", "encrypted-password"), Value: u.AuthEncrypted})
		}
		if u.PrivProtocol != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(uBase, "privacy", "type"), Value: u.PrivProtocol})
		}
		if u.PrivPassword != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(uBase, "privacy", "plaintext-password"), Value: u.PrivPassword})
		} else if u.PrivEncrypted != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(uBase, "privacy", "encrypted-password"), Value: u.PrivEncrypted})
		}
		// TPMode is informational on our side; VyOS infers from what's set.
	}

	// Trap targets.
	for _, t := range c.TrapTargets {
		if t.Address == "" {
			return nil, fmt.Errorf("snmp trap-target: address required")
		}
		// VyOS path:
		//   v2c trap: `service snmp trap-target <addr>`
		//   v3 trap:  `service snmp v3 trap-target <addr>`
		var tBase []string
		if t.Version == model.SNMPv3 {
			tBase = appendCopy(base, "v3", "trap-target", t.Address)
		} else {
			tBase = appendCopy(base, "trap-target", t.Address)
		}
		if t.Port > 0 && t.Port != 162 {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(tBase, "port"), Value: strconv.Itoa(t.Port)})
		}
		if t.Community != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(tBase, "community"), Value: t.Community})
		}
		if t.V3User != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(tBase, "user"), Value: t.V3User})
		}
		if t.V3EngineID != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(tBase, "engineid"), Value: t.V3EngineID})
		}
		if t.Type != "" {
			ops = append(ops, vyos.ConfigureOp{Op: vyos.OpSet, Path: appendCopy(tBase, "type"), Value: t.Type})
		}
	}
	return ops, nil
}

// --- SNMP decode ----------------------------------------------------------

// DecodeSNMPConfig parses `service snmp` into the domain model. Sensitive
// fields (auth/priv passwords) are NOT returned — VyOS doesn't expose them
// via /retrieve, only the hashed form.
func DecodeSNMPConfig(raw json.RawMessage) (*model.SNMPConfig, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return &model.SNMPConfig{}, nil
	}
	var t map[string]json.RawMessage
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, err
	}
	c := &model.SNMPConfig{
		Contact:     unquote(t["contact"]),
		Location:    unquote(t["location"]),
		Description: unquote(t["description"]),
		VRF:         unquote(t["vrf"]),
	}
	// listen-address
	if v, ok := t["listen-address"]; ok {
		var la map[string]json.RawMessage
		if json.Unmarshal(v, &la) == nil {
			for addr := range la {
				c.ListenAddresses = append(c.ListenAddresses, addr)
			}
			sort.Strings(c.ListenAddresses)
		}
	}
	// community
	if v, ok := t["community"]; ok {
		var comMap map[string]json.RawMessage
		if json.Unmarshal(v, &comMap) == nil {
			for name, body := range comMap {
				com := model.SNMPCommunity{Name: name}
				var cb map[string]json.RawMessage
				if json.Unmarshal(body, &cb) == nil {
					com.Authorization = unquote(cb["authorization"])
					decodeStringList(cb["client"], &com.Clients)
					decodeStringList(cb["network"], &com.Network)
				}
				c.Communities = append(c.Communities, com)
			}
			sort.Slice(c.Communities, func(i, j int) bool { return c.Communities[i].Name < c.Communities[j].Name })
		}
	}
	// trap-target (v2c)
	if v, ok := t["trap-target"]; ok {
		var tMap map[string]json.RawMessage
		if json.Unmarshal(v, &tMap) == nil {
			for addr, body := range tMap {
				c.TrapTargets = append(c.TrapTargets, decodeTrap(addr, body, model.SNMPv2c))
			}
		}
	}
	// v3 branch
	if v, ok := t["v3"]; ok {
		var v3 map[string]json.RawMessage
		if json.Unmarshal(v, &v3) == nil {
			c.EngineID = unquote(v3["engineid"])
			decodeV3Users(v3["user"], c)
			decodeV3Groups(v3["group"], c)
			decodeV3Views(v3["view"], c)
			if tt, ok := v3["trap-target"]; ok {
				var tMap map[string]json.RawMessage
				if json.Unmarshal(tt, &tMap) == nil {
					for addr, body := range tMap {
						c.TrapTargets = append(c.TrapTargets, decodeTrap(addr, body, model.SNMPv3))
					}
				}
			}
		}
	}
	sort.Slice(c.TrapTargets, func(i, j int) bool {
		if c.TrapTargets[i].Version != c.TrapTargets[j].Version {
			return c.TrapTargets[i].Version < c.TrapTargets[j].Version
		}
		return c.TrapTargets[i].Address < c.TrapTargets[j].Address
	})
	return c, nil
}

func decodeV3Users(raw json.RawMessage, c *model.SNMPConfig) {
	if len(raw) == 0 {
		return
	}
	var users map[string]json.RawMessage
	if json.Unmarshal(raw, &users) != nil {
		return
	}
	for name, body := range users {
		u := model.SNMPV3User{Name: name}
		var ub map[string]json.RawMessage
		if json.Unmarshal(body, &ub) == nil {
			u.Group = unquote(ub["group"])
			u.EngineID = unquote(ub["engineid"])
			if a, ok := ub["auth"]; ok {
				var am map[string]json.RawMessage
				if json.Unmarshal(a, &am) == nil {
					u.AuthProtocol = unquote(am["type"])
					u.AuthEncrypted = unquote(am["encrypted-password"])
				}
			}
			if p, ok := ub["privacy"]; ok {
				var pm map[string]json.RawMessage
				if json.Unmarshal(p, &pm) == nil {
					u.PrivProtocol = unquote(pm["type"])
					u.PrivEncrypted = unquote(pm["encrypted-password"])
				}
			}
		}
		c.V3Users = append(c.V3Users, u)
	}
	sort.Slice(c.V3Users, func(i, j int) bool { return c.V3Users[i].Name < c.V3Users[j].Name })
}

func decodeV3Groups(raw json.RawMessage, c *model.SNMPConfig) {
	if len(raw) == 0 {
		return
	}
	var groups map[string]json.RawMessage
	if json.Unmarshal(raw, &groups) != nil {
		return
	}
	for name, body := range groups {
		g := model.SNMPV3Group{Name: name}
		var gb map[string]json.RawMessage
		if json.Unmarshal(body, &gb) == nil {
			g.Mode = unquote(gb["mode"])
			g.SecLevel = unquote(gb["seclevel"])
			g.View = unquote(gb["view"])
		}
		c.V3Groups = append(c.V3Groups, g)
	}
	sort.Slice(c.V3Groups, func(i, j int) bool { return c.V3Groups[i].Name < c.V3Groups[j].Name })
}

func decodeV3Views(raw json.RawMessage, c *model.SNMPConfig) {
	if len(raw) == 0 {
		return
	}
	var views map[string]json.RawMessage
	if json.Unmarshal(raw, &views) != nil {
		return
	}
	for name, body := range views {
		v := model.SNMPV3View{Name: name}
		var vb map[string]json.RawMessage
		if json.Unmarshal(body, &vb) == nil {
			if o, ok := vb["oid"]; ok {
				var om map[string]json.RawMessage
				if json.Unmarshal(o, &om) == nil {
					for oid := range om {
						v.OIDs = append(v.OIDs, oid)
					}
					sort.Strings(v.OIDs)
				}
			}
		}
		c.V3Views = append(c.V3Views, v)
	}
	sort.Slice(c.V3Views, func(i, j int) bool { return c.V3Views[i].Name < c.V3Views[j].Name })
}

func decodeTrap(addr string, body json.RawMessage, version model.SNMPVersion) model.SNMPTrapTarget {
	t := model.SNMPTrapTarget{Address: addr, Version: version}
	var tb map[string]json.RawMessage
	if json.Unmarshal(body, &tb) == nil {
		if p := unquote(tb["port"]); p != "" {
			t.Port, _ = strconv.Atoi(p)
		}
		t.Community = unquote(tb["community"])
		t.V3User = unquote(tb["user"])
		t.V3EngineID = unquote(tb["engineid"])
		t.Type = unquote(tb["type"])
	}
	return t
}

func decodeStringList(raw json.RawMessage, dst *[]string) {
	if len(raw) == 0 {
		return
	}
	// Shape can be either: {"10.0.0.1": {}} or ["10.0.0.1"] depending on
	// VyOS build. Handle both.
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) == nil {
		for k := range m {
			*dst = append(*dst, k)
		}
		sort.Strings(*dst)
		return
	}
	var arr []string
	if json.Unmarshal(raw, &arr) == nil {
		*dst = append(*dst, arr...)
		sort.Strings(*dst)
		return
	}
	var one string
	if json.Unmarshal(raw, &one) == nil && one != "" {
		*dst = append(*dst, one)
	}
}
