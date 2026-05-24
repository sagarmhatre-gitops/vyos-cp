// Package parse handles the text-based output of VyOS op-mode `show`
// commands. These formats shift between versions, so every parser here is
// tested against real sample output from both 1.4 and 1.5 (see testdata/).
package parse

import (
	"bufio"
	"regexp"
	"strconv"
	"strings"
)

// Counter is one rule's live stats.
type Counter struct {
	Family  string
	Ruleset string
	Rule    int
	Packets uint64
	Bytes   uint64
	Action  string // "accept" | "drop" | etc, when the format includes it
}

// ShowFirewall parses `show firewall` output. VyOS 1.5 output looks like:
//
//	Ruleset Information
//
//	---------------------------------
//	IPv4 Firewall "name WAN-IN":
//
//	 rule  packets  bytes     action  source          destination  ...
//	 -----  -------  --------  ------  --------------  -----------
//	   10   842341   125M      accept  0.0.0.0/0       0.0.0.0/0
//	   20     3151    200K     drop    0.0.0.0/0       0.0.0.0/0
//
// 1.4 is slightly different — the header reads "IPv4 Firewall ..." too,
// but columns may be in a different order. We anchor on the per-row regex
// rather than column positions.
func ShowFirewall(out string) []Counter {
	var counters []Counter
	var curFamily, curRuleset string

	// Matches either "IPv4 Firewall "name WAN-IN":" or "IPv6 Firewall ..."
	headerRE := regexp.MustCompile(`(?i)^(IPv4|IPv6)\s+Firewall\s+"?\s*name\s+(\S+?)\s*"?:?\s*$`)
	// Matches a data row: leading space(s), rule number, packets, bytes,
	// then action. Bytes may use SI suffix (M, K, G) which we expand.
	rowRE := regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)`)

	scanner := bufio.NewScanner(strings.NewReader(out))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()

		if m := headerRE.FindStringSubmatch(line); len(m) == 3 {
			curFamily = strings.ToLower(m[1])
			curRuleset = m[2]
			continue
		}
		if curRuleset == "" {
			continue
		}
		m := rowRE.FindStringSubmatch(line)
		if len(m) != 5 {
			continue
		}
		// Skip obvious header rows like "rule packets bytes action ...".
		if m[1] == "" {
			continue
		}
		num, err := strconv.Atoi(m[1])
		if err != nil {
			continue
		}
		pkts, _ := strconv.ParseUint(m[2], 10, 64)
		bytes := parseByteSuffix(m[3])
		counters = append(counters, Counter{
			Family:  curFamily,
			Ruleset: curRuleset,
			Rule:    num,
			Packets: pkts,
			Bytes:   bytes,
			Action:  strings.ToLower(m[4]),
		})
	}
	return counters
}

// parseByteSuffix parses "125M" -> 125_000_000, "200K" -> 200_000,
// "2.4G" -> 2_400_000_000, or a raw integer.
func parseByteSuffix(s string) uint64 {
	if s == "" || s == "0" {
		return 0
	}
	mult := uint64(1)
	switch s[len(s)-1] {
	case 'K', 'k':
		mult, s = 1_000, s[:len(s)-1]
	case 'M', 'm':
		mult, s = 1_000_000, s[:len(s)-1]
	case 'G', 'g':
		mult, s = 1_000_000_000, s[:len(s)-1]
	case 'T', 't':
		mult, s = 1_000_000_000_000, s[:len(s)-1]
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return uint64(f * float64(mult))
	}
	return 0
}
