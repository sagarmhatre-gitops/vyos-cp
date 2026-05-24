package parse

import "testing"

// Sample VyOS 1.5 `show firewall` output. The exact format varies between
// minor versions; this parser only cares about the header line and numeric
// rule rows, so minor column shifts are tolerated.
const sample15 = `Ruleset Information

---------------------------------
IPv4 Firewall "name WAN-IN":

 rule  packets  bytes     action  source          destination
 -----  -------  --------  ------  --------------  -----------
   10   842341   125M      accept  0.0.0.0/0       0.0.0.0/0
   20     3151    200K     drop    0.0.0.0/0       0.0.0.0/0
   30   218000   48M       accept  0.0.0.0/0       0.0.0.0/0

---------------------------------
IPv4 Firewall "name LAN-IN":

 rule  packets  bytes     action  source          destination
 -----  -------  --------  ------  --------------  -----------
   10   50000    12M       accept  0.0.0.0/0       0.0.0.0/0
`

func TestShowFirewall(t *testing.T) {
	counters := ShowFirewall(sample15)
	if len(counters) != 4 {
		t.Fatalf("want 4 rows, got %d", len(counters))
	}
	// First row: WAN-IN rule 10.
	if counters[0].Family != "ipv4" || counters[0].Ruleset != "WAN-IN" || counters[0].Rule != 10 {
		t.Errorf("first row: %+v", counters[0])
	}
	// Bytes "125M" -> 125_000_000.
	if counters[0].Bytes != 125_000_000 {
		t.Errorf("byte parse: got %d want 125000000", counters[0].Bytes)
	}
	// Last row came from the second ruleset.
	if counters[3].Ruleset != "LAN-IN" {
		t.Errorf("second ruleset not detected: %+v", counters[3])
	}
}

func TestParseByteSuffix(t *testing.T) {
	cases := map[string]uint64{
		"0":   0,
		"100": 100,
		"1K":  1_000,
		"200k": 200_000,
		"125M": 125_000_000,
		"2.4G": 2_400_000_000,
		"1T":   1_000_000_000_000,
	}
	for in, want := range cases {
		if got := parseByteSuffix(in); got != want {
			t.Errorf("parseByteSuffix(%q) = %d, want %d", in, got, want)
		}
	}
}
