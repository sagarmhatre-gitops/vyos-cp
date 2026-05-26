package parse

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// colSplit splits a conntrack row on runs of 2+ spaces. Single spaces never
// occur inside fields (ip:port has none), so this cleanly separates columns
// even when the State column is blank (stateless protocols).
var colSplit = regexp.MustCompile(`\s{2,}`)

// stateTok matches a conntrack state word (all-caps, e.g. ESTABLISHED, TIME_WAIT).
var stateTok = regexp.MustCompile(`^[A-Z_]+$`)

// knownProtos guards the proto column position; parsing is anchored on the
// 5 address fields + proto, so trailing mark/zone columns are tolerated whether
// present or absent.
var knownProtos = map[string]bool{
	"tcp": true, "udp": true, "icmp": true, "icmpv6": true,
	"sctp": true, "dccp": true, "gre": true, "udplite": true, "unknown": true,
}

// ParseConntrack parses the text table returned by
// `show conntrack table ipv4` (VyOS HTTP API /show) into Flow records.
//
// Layout (whitespace-aligned):
//   Id  OrigSrc  OrigDst  ReplySrc  ReplyDst  Protocol  [State]  Timeout  [Mark]  [Zone]
//
// State is present only for connection-tracked protocols (tcp/sctp/...); for
// udp/icmp it is blank, collapsing the column. We detect that by checking
// whether the token after Protocol looks like a state word. Header and the
// dashed separator line are skipped. Rows that don't parse are skipped, never
// fabricated.
func ParseConntrack(raw string) []model.Flow {
	var out []model.Flow
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		// skip header and dashed separator
		if strings.HasPrefix(t, "Id") || strings.HasPrefix(t, "----") {
			continue
		}
		cols := colSplit.Split(t, -1)
		if len(cols) < 7 {
			continue // too few columns to be a valid row
		}
		// Fixed leading layout: id, origSrc, origDst, replySrc, replyDst, proto
		proto := cols[5]
		if !knownProtos[proto] {
			continue // not a recognizable conntrack row
		}
		rest := cols[6:]
		state := ""
		idx := 0
		if len(rest) > 0 && stateTok.MatchString(rest[0]) {
			state = rest[0]
			idx = 1
		}
		timeout := 0
		if idx < len(rest) {
			timeout, _ = strconv.Atoi(rest[idx])
		}

		oSrcIP, oSrcPort := splitIPPort(cols[1])
		oDstIP, oDstPort := splitIPPort(cols[2])
		rSrcIP, _ := splitIPPort(cols[3])
		rDstIP, _ := splitIPPort(cols[4])

		out = append(out, model.Flow{
			ConntrackID: cols[0],
			Protocol:    proto,
			State:       state,
			OrigSrcIP:   oSrcIP, OrigSrcPort: oSrcPort,
			OrigDstIP: oDstIP, OrigDstPort: oDstPort,
			ReplySrcIP: rSrcIP, ReplyDstIP: rDstIP,
			TimeoutSec: timeout,
		})
	}
	return out
}

// splitIPPort splits "host:port" into (host, port). IPv6 literals in conntrack
// output are bracketed, so the final colon after a ']' is the port separator;
// for plain IPv4 the single colon splits. Returns ("", "") tolerance for
// portless tokens.
func splitIPPort(s string) (host, port string) {
	if s == "" {
		return "", ""
	}
	i := strings.LastIndex(s, ":")
	if i < 0 {
		return s, ""
	}
	return s[:i], s[i+1:]
}
