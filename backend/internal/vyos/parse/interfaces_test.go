package parse

import "testing"

// Exact output from a VyOS 1.5-rolling device running `show interfaces ethernet eth0`.
const sampleStats15 = `NIC statistics:
     rx_queue_0_packets: 4962429
     rx_queue_0_bytes: 369531631
     rx_queue_0_drops: 0
     rx_queue_0_xdp_packets: 0
     rx_queue_0_xdp_tx: 0
     rx_queue_0_xdp_redirects: 0
     rx_queue_0_xdp_drops: 0
     rx_queue_0_kicks: 110
     tx_queue_0_packets: 57036
     tx_queue_0_bytes: 14370594
     tx_queue_0_xdp_tx: 0
     tx_queue_0_xdp_tx_drops: 0
     tx_queue_0_kicks: 51004
     tx_queue_0_tx_timeouts: 0`

func TestShowInterfacesStats(t *testing.T) {
	c := ShowInterfacesStats("eth0", sampleStats15)
	if c.RXBytes != 369531631 {
		t.Errorf("rx_bytes: got %d want 369531631", c.RXBytes)
	}
	if c.TXBytes != 14370594 {
		t.Errorf("tx_bytes: got %d want 14370594", c.TXBytes)
	}
	if c.RXPkts != 4962429 {
		t.Errorf("rx_packets: got %d want 4962429", c.RXPkts)
	}
	if c.TXPkts != 57036 {
		t.Errorf("tx_packets: got %d want 57036", c.TXPkts)
	}
}

// Multi-queue NIC (10G cards typically have 8+ queues; summed).
const sampleMultiQueue = `NIC statistics:
     rx_queue_0_bytes: 100
     rx_queue_1_bytes: 200
     rx_queue_2_bytes: 300
     tx_queue_0_bytes: 10
     tx_queue_1_bytes: 20`

func TestShowInterfacesStats_MultiQueue(t *testing.T) {
	c := ShowInterfacesStats("eth0", sampleMultiQueue)
	if c.RXBytes != 600 {
		t.Errorf("multi-queue rx sum: got %d want 600", c.RXBytes)
	}
	if c.TXBytes != 30 {
		t.Errorf("multi-queue tx sum: got %d want 30", c.TXBytes)
	}
}

// The summary parser — the output you showed from `show interfaces summary`.
const sampleSummary = `Codes: S - State, L - Link, u - Up, D - Down, A - Admin Down
Interface        IP Address                        S/L  Description
---------        ----------                        ---  -----------
eth0             103.42.50.77/23                   u/u
eth1             100.64.16.197/22                  u/u
eth2             10.10.0.1/24                      u/u
lo               127.0.0.1/8                       u/u`

func TestShowInterfaces(t *testing.T) {
	out := ShowInterfaces(sampleSummary)
	if len(out) != 4 {
		t.Fatalf("got %d interfaces, want 4", len(out))
	}
	if out[0].Name != "eth0" || out[0].Address != "103.42.50.77/23" {
		t.Errorf("eth0 parse: %+v", out[0])
	}
	if !out[0].AdminUp || !out[0].LinkUp {
		t.Errorf("eth0 state: admin=%v link=%v", out[0].AdminUp, out[0].LinkUp)
	}
}
