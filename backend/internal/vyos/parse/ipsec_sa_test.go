package parse

import (
	"testing"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// Fixtures captured from VyOS official docs (1.5 rolling) and forum/AWS
// captures (1.4). These are the real wire shapes the parser must survive.

const ike15 = `
Peer ID / IP                            Local ID / IP
------------                            -------------
192.168.1.2 192.168.1.2                 192.168.0.1 192.168.0.1

    State  IKEVer  Encrypt      Hash          D-H Group      NAT-T  A-Time  L-Time
    -----  ------  -------      ----          ---------      -----  ------  ------
    up     IKEv2   AES_CBC_128  HMAC_SHA1_96  MODP_2048      no     162     27023
`

const ike14AWS = `
Peer ID / IP            Local ID / IP
------------            -------------
3.230.21.112 3.230.21.112   10.113.129.113 23.23.46.168

    State  IKEVer  Encrypt      Hash               D-H Group  NAT-T  A-Time  L-Time
    -----  ------  -------      ----               ---------  -----  ------  ------
    up     IKEv2   AES_CBC_256  HMAC_SHA2_256_128  ECP_256    yes    4987    22920
`

const childDetail15 = `
PEER: #1, ESTABLISHED, IKEv2, 101275ac719d5a1b_i* 68ea4ec3bed3bf0c_r
  local  '192.168.0.1' @ 192.168.0.1[4500]
  remote '192.168.1.2' @ 192.168.1.2[4500]
  AES_CBC-128/HMAC_SHA1_96/PRF_HMAC_SHA1/MODP_2048
  established 4054s ago, rekeying in 23131s
  PEER-tunnel-1: #2, reqid 1, INSTALLED, TUNNEL, ESP:AES_CBC-128/HMAC_SHA1_96/MODP_2048
    installed 1065s ago, rekeying in 1998s, expires in 2535s
    in  c5821882,    168 bytes,     2 packets,    81s ago
    out c433406a,    168 bytes,     2 packets,    81s ago
    local  10.0.0.0/24
    remote 10.0.1.0/24
`

func TestParseIKE_15(t *testing.T) {
	st := ParseIPsecStatus("dev1", ike15, "", VyOS15)
	if len(st.IKE) != 1 {
		t.Fatalf("want 1 IKE SA, got %d (%+v)", len(st.IKE), st.IKE)
	}
	sa := st.IKE[0]
	if sa.State != model.IKEUp {
		t.Errorf("state: want up, got %s", sa.State)
	}
	if sa.IKEVer != "IKEv2" {
		t.Errorf("ikever: got %q", sa.IKEVer)
	}
	if sa.Encrypt != "AES_CBC_128" || sa.Hash != "HMAC_SHA1_96" || sa.DHGroup != "MODP_2048" {
		t.Errorf("crypto: got %q/%q/%q", sa.Encrypt, sa.Hash, sa.DHGroup)
	}
	if sa.NATT {
		t.Errorf("natt: want false")
	}
	if sa.EstabSecs != 162 || sa.RekeySecs != 27023 {
		t.Errorf("times: got estab=%d rekey=%d", sa.EstabSecs, sa.RekeySecs)
	}
	if sa.RemoteIP != "192.168.1.2" || sa.LocalIP != "192.168.0.1" {
		t.Errorf("ips: remote=%q local=%q", sa.RemoteIP, sa.LocalIP)
	}
}

func TestParseIKE_14_distinctIDs(t *testing.T) {
	st := ParseIPsecStatus("dev2", ike14AWS, "", VyOS14)
	if len(st.IKE) != 1 {
		t.Fatalf("want 1 IKE SA, got %d", len(st.IKE))
	}
	sa := st.IKE[0]
	if sa.RemoteIP != "3.230.21.112" {
		t.Errorf("remote ip: got %q", sa.RemoteIP)
	}
	// distinct local IP and ID must split correctly
	if sa.LocalIP != "10.113.129.113" || sa.LocalID != "23.23.46.168" {
		t.Errorf("local split wrong: ip=%q id=%q", sa.LocalIP, sa.LocalID)
	}
	if sa.NATT != true {
		t.Errorf("natt: want true")
	}
	if sa.Hash != "HMAC_SHA2_256_128" {
		t.Errorf("hash: got %q", sa.Hash)
	}
}

func TestParseChildDetail_15(t *testing.T) {
	st := ParseIPsecStatus("dev1", "", childDetail15, VyOS15)
	if len(st.Children) != 1 {
		t.Fatalf("want 1 CHILD SA, got %d (%+v)", len(st.Children), st.Children)
	}
	c := st.Children[0]
	if c.Name != "PEER-tunnel-1" {
		t.Errorf("name: got %q", c.Name)
	}
	if c.State != model.ChildInstalled {
		t.Errorf("state: want installed, got %s", c.State)
	}
	if c.Proposal != "AES_CBC-128/HMAC_SHA1_96/MODP_2048" {
		t.Errorf("proposal: got %q", c.Proposal)
	}
	if c.LocalSubnet != "10.0.0.0/24" || c.RemoteSubnet != "10.0.1.0/24" {
		t.Errorf("subnets: local=%q remote=%q", c.LocalSubnet, c.RemoteSubnet)
	}
	if c.BytesIn != 168 || c.BytesOut != 168 {
		t.Errorf("bytes: in=%d out=%d", c.BytesIn, c.BytesOut)
	}
	if c.PacketsIn != 2 || c.PacketsOut != 2 {
		t.Errorf("packets: in=%d out=%d", c.PacketsIn, c.PacketsOut)
	}
	if c.UptimeSecs != 1065 || c.RekeySecs != 1998 {
		t.Errorf("times: uptime=%d rekey=%d", c.UptimeSecs, c.RekeySecs)
	}
}

func TestParseEmpty(t *testing.T) {
	st := ParseIPsecStatus("dev3", "", "", VyOS15)
	if len(st.IKE) != 0 || len(st.Children) != 0 {
		t.Errorf("empty inputs should yield no SAs")
	}
}

func TestCompoundDuration(t *testing.T) {
	cases := map[string]int64{
		"162":     162,
		"162s":    162,
		"16m30s":  990,
		"34m50s":  2090,
		"1h2m3s":  3723,
		"n/a":     -1,
		"":        -1,
	}
	for in, want := range cases {
		if got := atoiSecs(in); got != want {
			t.Errorf("atoiSecs(%q): want %d got %d", in, want, got)
		}
	}
}
