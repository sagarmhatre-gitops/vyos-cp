package parse

import (
	"bufio"
	"strconv"
	"strings"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// IPsec status parsing.
//
// Two device commands feed this:
//   show vpn ike sa            -> Phase 1 table (fixed-width columns)
//   show vpn ipsec sa detail   -> Phase 2 line-oriented detail (carries subnets,
//                                 bytes, packets, uptime, rekey — everything)
//
// We deliberately parse `sa detail` rather than the plain `sa` table: the table
// format has shifted across releases (CHILD dedup, AEAD cipher rendering), while
// the detail block is line-oriented and stable. See VyOS T1925 / T1735.
//
// Version branching: VyOS 1.4 (Sagitta) and 1.5 (Circinus rolling) differ in
// minor whitespace and the presence of the `sa detail` subcommand. The IKEVer
// default also drifted (T3656). We normalize both onto model.* closed sets.

// VyOSVersion is the coarse branch the caller derives from GET /info.
type VyOSVersion int

const (
	VyOS14 VyOSVersion = iota
	VyOS15
)

// ParseIPsecStatus combines the two raw command outputs into one aggregate.
// Either input may be empty (e.g. a device with no IKE SAs yet); the parser
// degrades gracefully and records soft warnings rather than erroring.
func ParseIPsecStatus(deviceID, ikeRaw, childDetailRaw string, v VyOSVersion) model.IPsecStatus {
	st := model.IPsecStatus{DeviceID: deviceID}
	st.IKE = parseIKESAs(ikeRaw, v, &st)
	st.Children = parseChildDetail(childDetailRaw, v, &st)
	return st
}

// ---- Phase 1: show vpn ike sa ----------------------------------------------
//
// Layout (1.5 rolling, 1.4 nearly identical):
//
//   Peer ID / IP                 Local ID / IP
//   ------------                 -------------
//   192.168.1.2 192.168.1.2      192.168.0.1 192.168.0.1
//
//       State  IKEVer  Encrypt      Hash          D-H Group   NAT-T  A-Time  L-Time
//       -----  ------  -------      ----          ---------   -----  ------  ------
//       up     IKEv2   AES_CBC_128  HMAC_SHA1_96  MODP_2048   no     162     27023
//
// The output pairs a "peer header" line with a following "state" line. We walk
// the lines, capturing the most recent peer/local id header, then attaching the
// next all-token state row to it.
func parseIKESAs(raw string, v VyOSVersion, st *model.IPsecStatus) []model.IKESA {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []model.IKESA
	var pendingPeerIP, pendingPeerID, pendingLocalIP, pendingLocalID string
	havePeer := false

	sc := bufio.NewScanner(strings.NewReader(raw))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), " \t")
		t := strings.TrimSpace(line)
		if t == "" || isRuleHeader(t) || strings.HasPrefix(t, "Peer ID") || isIKETitleRow(t) {
			continue
		}
		fields := strings.Fields(t)

		// A state row begins with a known state token. Everything else with
		// content is treated as a peer/local id header line.
		if havePeer && looksLikeIKEStateRow(fields) {
			sa := model.IKESA{
				Peer:      firstNonEmpty(pendingPeerID, pendingPeerIP),
				RemoteID:  pendingPeerID,
				RemoteIP:  pendingPeerIP,
				LocalID:   pendingLocalID,
				LocalIP:   pendingLocalIP,
				EstabSecs: -1,
				RekeySecs: -1,
			}
			fillIKEStateRow(&sa, fields, st)
			out = append(out, sa)
			havePeer = false
			continue
		}

		// Peer header: "<peerIP> <peerID>   <localIP> <localID>". Column split
		// is by run of whitespace; both halves may collapse to a single token
		// when id == ip.
		pip, pid, lip, lid := splitPeerHeader(line)
		if pip != "" || pid != "" {
			pendingPeerIP, pendingPeerID = pip, pid
			pendingLocalIP, pendingLocalID = lip, lid
			havePeer = true
		}
	}
	return out
}

// splitPeerHeader divides the header on the wide gap between the Peer column
// and the Local column. VyOS pads the gap with multiple spaces; a single space
// separates IP from ID within each column.
func splitPeerHeader(line string) (peerIP, peerID, localIP, localID string) {
	// Split on 2+ spaces -> [peerHalf, localHalf].
	halves := splitOnWideGap(line)
	if len(halves) == 0 {
		return
	}
	peerIP, peerID = ipIDPair(halves[0])
	if len(halves) > 1 {
		localIP, localID = ipIDPair(halves[1])
	}
	return
}

func ipIDPair(half string) (ip, id string) {
	f := strings.Fields(half)
	switch len(f) {
	case 0:
		return "", ""
	case 1:
		return f[0], f[0]
	default:
		return f[0], f[1]
	}
}

func looksLikeIKEStateRow(fields []string) bool {
	if len(fields) == 0 {
		return false
	}
	switch strings.ToLower(fields[0]) {
	case "up", "down", "connecting", "established", "rekeying":
		return true
	}
	return false
}

// fillIKEStateRow maps: State IKEVer Encrypt Hash D-H NAT-T A-Time L-Time.
// Some columns can be "n/a"; we tolerate short rows.
func fillIKEStateRow(sa *model.IKESA, f []string, st *model.IPsecStatus) {
	get := func(i int) string {
		if i < len(f) {
			return f[i]
		}
		return ""
	}
	sa.RawState = get(0)
	sa.State = normalizeIKEState(get(0), st)
	sa.IKEVer = get(1)
	sa.Encrypt = naBlank(get(2))
	sa.Hash = naBlank(get(3))
	sa.DHGroup = naBlank(get(4))
	sa.NATT = strings.EqualFold(get(5), "yes")
	sa.EstabSecs = atoiSecs(get(6))
	sa.RekeySecs = atoiSecs(get(7))
}

func normalizeIKEState(s string, st *model.IPsecStatus) model.IKEState {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "up", "established":
		return model.IKEUp
	case "connecting":
		return model.IKEConnecting
	case "down", "":
		return model.IKEDown
	default:
		warn(st, "unknown IKE state token: "+s)
		return model.IKEUnknown
	}
}

// ---- Phase 2: show vpn ipsec sa detail -------------------------------------
//
// Layout (1.5 rolling):
//
//   PEER: #1, ESTABLISHED, IKEv2, <spis>
//     local  '192.168.0.1' @ 192.168.0.1[4500]
//     remote '192.168.1.2' @ 192.168.1.2[4500]
//     AES_CBC-128/HMAC_SHA1_96/PRF_HMAC_SHA1/MODP_2048
//     established 4054s ago, rekeying in 23131s
//     PEER-tunnel-1: #2, reqid 1, INSTALLED, TUNNEL, ESP:AES_CBC-128/HMAC_SHA1_96/MODP_2048
//       installed 1065s ago, rekeying in 1998s, expires in 2535s
//       in  c5821882,    168 bytes,     2 packets,    81s ago
//       out c433406a,    168 bytes,     2 packets,    81s ago
//       local  10.0.0.0/24
//       remote 10.0.1.0/24
//
// A CHILD SA is the indented "<name>: #N, ... INSTALLED, TUNNEL, ESP:<prop>"
// block plus its following in/out/local/remote lines. We accumulate fields into
// a current ChildSA and flush on the next CHILD header or EOF.
func parseChildDetail(raw string, v VyOSVersion, st *model.IPsecStatus) []model.ChildSA {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []model.ChildSA
	var cur *model.ChildSA
	flush := func() {
		if cur != nil {
			out = append(out, *cur)
			cur = nil
		}
	}

	sc := bufio.NewScanner(strings.NewReader(raw))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		raw := sc.Text()
		t := strings.TrimSpace(raw)
		if t == "" {
			continue
		}

		// CHILD header: contains "ESP:" and an INSTALLED/REKEYED/etc state and
		// a leading "<name>: #".
		if idx := strings.Index(t, "ESP:"); idx >= 0 && strings.Contains(t, ":") && childNameLike(t) {
			flush()
			c := newChild()
			fillChildHeader(&c, t, idx, st)
			cur = &c
			continue
		}
		if cur == nil {
			continue // still in the parent IKE block; ignore
		}

		switch {
		case strings.HasPrefix(t, "installed "):
			cur.UptimeSecs = firstSecsAfter(t, "installed")
			cur.RekeySecs = secsAfterKeyword(t, "rekeying in")
		case strings.HasPrefix(t, "in "):
			b, p := bytesPacketsFromCounterLine(t)
			cur.BytesIn, cur.PacketsIn = b, p
		case strings.HasPrefix(t, "out "):
			b, p := bytesPacketsFromCounterLine(t)
			cur.BytesOut, cur.PacketsOut = b, p
		case strings.HasPrefix(t, "local "):
			cur.LocalSubnet = strings.TrimSpace(strings.TrimPrefix(t, "local"))
		case strings.HasPrefix(t, "remote "):
			cur.RemoteSubnet = strings.TrimSpace(strings.TrimPrefix(t, "remote"))
		}
	}
	flush()
	return out
}

func newChild() model.ChildSA {
	return model.ChildSA{UptimeSecs: -1, RekeySecs: -1}
}

// childNameLike screens header lines: "<name>: #<n>, ..." where name has a tunnel-ish form.
func childNameLike(t string) bool {
	c := strings.Index(t, ":")
	if c <= 0 || c+1 >= len(t) {
		return false
	}
	rest := strings.TrimSpace(t[c+1:])
	return strings.HasPrefix(rest, "#")
}

func fillChildHeader(c *model.ChildSA, t string, espIdx int, st *model.IPsecStatus) {
	c.Name = strings.TrimSpace(t[:strings.Index(t, ":")])
	c.Proposal = strings.TrimSpace(t[espIdx+len("ESP:"):])
	// State is one of the comma fields before ESP:, typically INSTALLED.
	for _, part := range strings.Split(t[:espIdx], ",") {
		p := strings.TrimSpace(part)
		switch strings.ToUpper(p) {
		case "INSTALLED":
			c.RawState, c.State = p, model.ChildInstalled
		case "REKEYED", "REKEYING":
			c.RawState, c.State = p, model.ChildRekeying
		case "CONNECTING":
			c.RawState, c.State = p, model.ChildConnecting
		}
	}
	if c.State == "" {
		c.State = model.ChildUnknown
		warn(st, "no recognized CHILD state in: "+t)
	}
}

// bytesPacketsFromCounterLine parses "in  c5821882,  168 bytes,  2 packets, 81s ago".
// Byte values may carry K/M/G/T suffixes on some builds.
func bytesPacketsFromCounterLine(t string) (bytes, packets uint64) {
	for _, seg := range strings.Split(t, ",") {
		s := strings.TrimSpace(seg)
		switch {
		case strings.HasSuffix(s, "bytes"):
			bytes = parseIPsecByteCount(strings.TrimSpace(strings.TrimSuffix(s, "bytes")))
		case strings.HasSuffix(s, "packets"):
			packets, _ = parseUint(strings.TrimSpace(strings.TrimSuffix(s, "packets")))
		case strings.HasSuffix(s, "packet"):
			packets, _ = parseUint(strings.TrimSpace(strings.TrimSuffix(s, "packet")))
		}
	}
	return
}

// ---- shared small helpers ---------------------------------------------------

func firstSecsAfter(t, keyword string) int64 {
	// "installed 1065s ago, ..." -> 1065
	rest := strings.TrimSpace(strings.TrimPrefix(t, keyword))
	f := strings.Fields(rest)
	if len(f) == 0 {
		return -1
	}
	return atoiSecs(f[0])
}

func secsAfterKeyword(t, keyword string) int64 {
	i := strings.Index(t, keyword)
	if i < 0 {
		return -1
	}
	rest := strings.TrimSpace(t[i+len(keyword):])
	f := strings.Fields(rest)
	if len(f) == 0 {
		return -1
	}
	return atoiSecs(f[0])
}

// atoiSecs accepts "162", "162s", "16m30s", "4054s", "n/a", and tolerates a
// trailing comma ("1998s,") from inline comma-separated detail lines.
func atoiSecs(s string) int64 {
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, ",.;")
	if s == "" || strings.EqualFold(s, "n/a") {
		return -1
	}
	// compound duration like 16m30s / 1h2m3s / 34m50s
	if strings.ContainsAny(s, "hms") && !isPlainNumber(s) {
		return parseCompoundDuration(s)
	}
	s = strings.TrimSuffix(s, "s")
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return -1
	}
	return n
}

func parseCompoundDuration(s string) int64 {
	var total, n int64
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			n = n*10 + int64(r-'0')
		case r == 'h':
			total += n * 3600
			n = 0
		case r == 'm':
			total += n * 60
			n = 0
		case r == 's':
			total += n
			n = 0
		default:
			return -1
		}
	}
	return total
}

func isPlainNumber(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return len(s) > 0
}

func splitOnWideGap(line string) []string {
	var parts []string
	var b strings.Builder
	spaces := 0
	for _, r := range line {
		if r == ' ' {
			spaces++
			continue
		}
		if spaces >= 2 && b.Len() > 0 {
			parts = append(parts, b.String())
			b.Reset()
		}
		if spaces > 0 && b.Len() > 0 {
			b.WriteByte(' ')
		}
		spaces = 0
		b.WriteRune(r)
	}
	if b.Len() > 0 {
		parts = append(parts, b.String())
	}
	return parts
}

func parseUint(s string) (uint64, bool) {
	n, err := strconv.ParseUint(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func naBlank(s string) string {
	if strings.EqualFold(strings.TrimSpace(s), "n/a") {
		return ""
	}
	return s
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func isRuleHeader(t string) bool {
	// dashed separator line like "----- ------"
	return strings.Trim(t, "- ") == ""
}

// isIKETitleRow detects the column-title line of the state table so it is not
// mistaken for a peer/local id header. The line begins with "State" and lists
// the fixed column names.
func isIKETitleRow(t string) bool {
	return strings.HasPrefix(t, "State") && strings.Contains(t, "IKEVer") && strings.Contains(t, "A-Time")
}

func warn(st *model.IPsecStatus, msg string) {
	if st == nil {
		return
	}
	st.ParseWarnings = append(st.ParseWarnings, msg)
}

// parseIPsecByteCount parses a byte value that may carry a K/M/G/T suffix, e.g.
// "168", "1.5K", "12M". Self-contained on purpose: the IPsec SA detail output
// uses the same byte-suffix convention as `show firewall`, but we keep a private
// copy here so this file has no cross-dependency inside the parse package.
// Uniquely named to avoid colliding with the existing show-firewall byte parser.
func parseIPsecByteCount(s string) uint64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	mult := float64(1)
	switch s[len(s)-1] {
	case 'K', 'k':
		mult, s = 1<<10, s[:len(s)-1]
	case 'M', 'm':
		mult, s = 1<<20, s[:len(s)-1]
	case 'G', 'g':
		mult, s = 1<<30, s[:len(s)-1]
	case 'T', 't':
		mult, s = 1<<40, s[:len(s)-1]
	case 'B', 'b':
		s = s[:len(s)-1]
	}
	s = strings.TrimSpace(s)
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return uint64(f * mult)
	}
	return 0
}
