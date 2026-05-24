// Package parse — interface counter parser.
package parse

import (
	"regexp"
	"strconv"
	"strings"
)

type IfaceCounter struct {
	Name    string
	RXBytes uint64
	TXBytes uint64
	RXPkts  uint64
	TXPkts  uint64
}

// Matches the ip-style summary block the /show API returns for
// `show interfaces ethernet <name>`:
//
//     RX:       bytes  packets  errors  dropped  overrun       mcast
//          3173152056  6888453       0     2044        0           0
//     TX:       bytes  packets  errors  dropped  carrier  collisions
//            52793062   597605       0        0        0           0
//
// It also gracefully handles the ethtool-style `rx_queue_N_bytes:` format
// returned by `show interfaces ethernet <name> statistics`, summing queues.
var (
	rxTxLineRE    = regexp.MustCompile(`(?m)^\s*(RX|TX):\s*bytes\s+packets`)
	numericRowRE  = regexp.MustCompile(`(?m)^\s+(\d+)\s+(\d+)\b`)
	ethtoolBytes  = regexp.MustCompile(`(rx|tx)_queue_\d+_bytes:\s*(\d+)`)
	ethtoolPkts   = regexp.MustCompile(`(rx|tx)_queue_\d+_packets:\s*(\d+)`)
)

func ShowInterfacesStats(name, output string) IfaceCounter {
	c := IfaceCounter{Name: name}

	// Primary path: ip-style RX/TX summary. Look for the RX header line, then
	// grab the first all-numeric row after it for rx; repeat for TX.
	lines := strings.Split(output, "\n")
	for i, line := range lines {
		m := rxTxLineRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		// Scan forward for the first line whose first two tokens are both numeric.
		for j := i + 1; j < len(lines) && j < i+3; j++ {
			row := numericRowRE.FindStringSubmatch(lines[j])
			if row == nil {
				continue
			}
			bytes, _ := strconv.ParseUint(row[1], 10, 64)
			pkts, _ := strconv.ParseUint(row[2], 10, 64)
			if m[1] == "RX" {
				c.RXBytes, c.RXPkts = bytes, pkts
			} else {
				c.TXBytes, c.TXPkts = bytes, pkts
			}
			break
		}
	}
	if c.RXBytes > 0 || c.TXBytes > 0 {
		return c
	}

	// Fallback: ethtool-style per-queue stats (summed).
	for _, m := range ethtoolBytes.FindAllStringSubmatch(output, -1) {
		n, _ := strconv.ParseUint(m[2], 10, 64)
		if m[1] == "rx" {
			c.RXBytes += n
		} else {
			c.TXBytes += n
		}
	}
	for _, m := range ethtoolPkts.FindAllStringSubmatch(output, -1) {
		n, _ := strconv.ParseUint(m[2], 10, 64)
		if m[1] == "rx" {
			c.RXPkts += n
		} else {
			c.TXPkts += n
		}
	}
	return c
}

// ShowInterfaces parses the multi-interface summary `show interfaces`.
var summaryRE = regexp.MustCompile(`^(\S+)\s+([\d.:/a-f]+|-)\s+([uDA])/([uDA])`)

type IfaceSummary struct {
	Name    string
	Address string
	AdminUp bool
	LinkUp  bool
}

func ShowInterfaces(output string) []IfaceSummary {
	var out []IfaceSummary
	for _, line := range strings.Split(output, "\n") {
		m := summaryRE.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		out = append(out, IfaceSummary{
			Name:    m[1],
			Address: m[2],
			AdminUp: m[3] == "u",
			LinkUp:  m[4] == "u",
		})
	}
	return out
}
