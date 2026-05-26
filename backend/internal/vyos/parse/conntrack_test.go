package parse

import "testing"

const sampleConntrack = `Id          Original src          Original dst        Reply src           Reply dst             Protocol    State        Timeout    Mark    Zone
----------  --------------------  ------------------  ------------------  --------------------  ----------  -----------  ---------  ------  ------
3989510625  10.10.0.10:46584      10.10.0.1:443       10.10.0.1:443       10.10.0.10:46584      tcp         ESTABLISHED  431973     0
211650344   100.64.16.197:58071   8.8.8.8:53          8.8.8.8:53          100.64.16.197:58071   udp                      8          0
900273854   15.204.156.92:25166   103.42.50.77:5060   103.42.50.77:5060   15.204.156.92:25166   udp                      3569       0
2411087007  142.79.252.196:58106  103.42.50.77:1024   10.10.0.10:22       142.79.252.196:58106  tcp         ESTABLISHED  431988     0`

func TestParseConntrack_Basic(t *testing.T) {
	flows := ParseConntrack(sampleConntrack)
	if len(flows) != 4 {
		t.Fatalf("want 4 flows, got %d", len(flows))
	}
}

func TestParseConntrack_TCPRow(t *testing.T) {
	f := ParseConntrack(sampleConntrack)[0]
	if f.ConntrackID != "3989510625" {
		t.Errorf("id: %s", f.ConntrackID)
	}
	if f.Protocol != "tcp" || f.State != "ESTABLISHED" {
		t.Errorf("proto/state: %s/%s", f.Protocol, f.State)
	}
	if f.OrigSrcIP != "10.10.0.10" || f.OrigSrcPort != "46584" {
		t.Errorf("orig src: %s:%s", f.OrigSrcIP, f.OrigSrcPort)
	}
	if f.OrigDstIP != "10.10.0.1" || f.OrigDstPort != "443" {
		t.Errorf("orig dst: %s:%s", f.OrigDstIP, f.OrigDstPort)
	}
	if f.TimeoutSec != 431973 {
		t.Errorf("timeout: %d", f.TimeoutSec)
	}
}

func TestParseConntrack_UDPBlankState(t *testing.T) {
	// UDP rows have no State column — must not shift Timeout into State.
	f := ParseConntrack(sampleConntrack)[1]
	if f.Protocol != "udp" {
		t.Errorf("proto: %s", f.Protocol)
	}
	if f.State != "" {
		t.Errorf("udp state should be empty, got %q", f.State)
	}
	if f.OrigDstPort != "53" {
		t.Errorf("dst port: %s", f.OrigDstPort)
	}
	if f.TimeoutSec != 8 {
		t.Errorf("timeout should be 8, got %d (state-shift bug?)", f.TimeoutSec)
	}
}

func TestParseConntrack_SIPFlow(t *testing.T) {
	f := ParseConntrack(sampleConntrack)[2]
	if f.OrigDstPort != "5060" || f.Protocol != "udp" || f.State != "" {
		t.Errorf("sip flow wrong: %+v", f)
	}
}

func TestParseConntrack_NATRow(t *testing.T) {
	// Row 4: reply dst differs from orig src -> NAT visible. Just confirm parse.
	f := ParseConntrack(sampleConntrack)[3]
	if f.OrigSrcIP != "142.79.252.196" || f.OrigDstPort != "1024" {
		t.Errorf("nat row: %+v", f)
	}
}

func TestParseConntrack_SkipsHeaderAndJunk(t *testing.T) {
	in := "Id  Original src\n----  ----\n\ngarbage line with no proto\n"
	if got := ParseConntrack(in); len(got) != 0 {
		t.Errorf("expected 0 flows from header/junk, got %d", len(got))
	}
}

func TestParseConntrack_Empty(t *testing.T) {
	if got := ParseConntrack(""); len(got) != 0 {
		t.Errorf("empty input -> 0 flows, got %d", len(got))
	}
}
