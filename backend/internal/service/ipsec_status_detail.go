package service

import (
	"strings"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos/parse"
)

// IPsec SA status — detail-based parsing.
//
// This replaces the old plain-table path (`show vpn ipsec sa` + parseIPsecSA)
// with `show vpn ipsec sa detail`, which carries per-CHILD local/remote subnets,
// bytes, packets, uptime and rekey — fields the plain table omits. The result is
// mapped down to the existing []model.SAStatus so the route/handler/UI contract
// is unchanged; LocalNet/RemoteNet are now populated.
//
// Wiring: GetIPsecStatus (in ipsec.go) calls parseIPsecSADetail instead of
// parseIPsecSA. See README for the 6-line edit.

func parseIPsecSADetail(deviceID, ikeRaw, detailRaw string, v parse.VyOSVersion) []model.SAStatus {
	return buildSAStatus(parse.ParseIPsecStatus(deviceID, ikeRaw, detailRaw, v))
}

func buildSAStatus(st model.IPsecStatus) []model.SAStatus {
	if len(st.Children) == 0 {
		return nil
	}
	out := make([]model.SAStatus, 0, len(st.Children))
	for _, c := range st.Children {
		uptime := int64(0)
		if c.UptimeSecs > 0 {
			uptime = c.UptimeSecs
		}
		out = append(out, model.SAStatus{
			Peer:       parentPeerName(c.Name),
			Tunnel:     tunnelNumFromName(c.Name),
			State:      mapChildState(c.State),
			LocalNet:   c.LocalSubnet,
			RemoteNet:  c.RemoteSubnet,
			BytesIn:    int64(c.BytesIn),
			BytesOut:   int64(c.BytesOut),
			PacketsIn:  int64(c.PacketsIn),
			PacketsOut: int64(c.PacketsOut),
			UptimeSec:  uptime,
		})
	}
	return out
}

func parentPeerName(name string) string {
	if i := strings.Index(name, "-tunnel-"); i >= 0 {
		return name[:i]
	}
	return name
}

func tunnelNumFromName(name string) int {
	i := strings.LastIndex(name, "-")
	if i < 0 || i+1 >= len(name) {
		return 0
	}
	n := 0
	for _, r := range name[i+1:] {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	return n
}

func mapChildState(s model.ChildState) string {
	switch s {
	case model.ChildInstalled:
		return "up"
	case model.ChildRekeying, model.ChildConnecting:
		return "connecting"
	default:
		return "down"
	}
}

// detectVyOSVersion maps an Info.Version string ("1.5.x...", "1.4...") to the
// parser branch. Defaults to 1.4 when unclear.
func detectVyOSVersion(version string) parse.VyOSVersion {
	if strings.Contains(version, "1.5") {
		return parse.VyOS15
	}
	return parse.VyOS14
}
