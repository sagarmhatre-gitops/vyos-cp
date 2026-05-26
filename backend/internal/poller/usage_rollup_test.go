package poller

import (
	"testing"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/store"
)

// ts returns a fixed base time plus n minutes, so all snapshots in a test land
// in the same hour bucket (used by accumulate's hourly keying).
func ts(n int) time.Time {
	base := time.Date(2025, 1, 2, 10, 0, 0, 0, time.UTC)
	return base.Add(time.Duration(n) * time.Minute)
}

func TestAccumulate_SteadyTraffic(t *testing.T) {
	snaps := []store.CounterSnapshot{
		{Iface: "eth0", Ts: ts(0), RXBytes: 100, TXBytes: 10},
		{Iface: "eth0", Ts: ts(1), RXBytes: 200, TXBytes: 30}, // +100 / +20
		{Iface: "eth0", Ts: ts(2), RXBytes: 350, TXBytes: 60}, // +150 / +30
	}
	out := accumulate("dev1", snaps)
	dev := findScope(out, "device")
	if dev == nil {
		t.Fatal("no device scope")
	}
	if dev.RXBytes != 250 { // 100 + 150
		t.Fatalf("want rx=250 got %d", dev.RXBytes)
	}
	if dev.TXBytes != 50 { // 20 + 30
		t.Fatalf("want tx=50 got %d", dev.TXBytes)
	}
	if dev.HadReset {
		t.Fatal("did not expect a reset")
	}
}

func TestAccumulate_RebootMidSeries(t *testing.T) {
	snaps := []store.CounterSnapshot{
		{Iface: "eth0", Ts: ts(0), RXBytes: 1000, TXBytes: 0},
		{Iface: "eth0", Ts: ts(1), RXBytes: 1200, TXBytes: 0}, // +200
		{Iface: "eth0", Ts: ts(2), RXBytes: 50, TXBytes: 0},   // reset -> +50, flag
		{Iface: "eth0", Ts: ts(3), RXBytes: 300, TXBytes: 0},  // +250
	}
	out := accumulate("dev1", snaps)
	dev := findScope(out, "device")
	if dev == nil {
		t.Fatal("no device scope")
	}
	if dev.RXBytes != 500 { // 200 + 50 + 250
		t.Fatalf("want rx=500 got %d", dev.RXBytes)
	}
	if !dev.HadReset {
		t.Fatal("expected had_reset=true after reboot")
	}
}

func TestAccumulate_GapRecovered(t *testing.T) {
	// device offline between ts(1) and ts(2): counter kept counting, recovered
	snaps := []store.CounterSnapshot{
		{Iface: "eth0", Ts: ts(0), RXBytes: 100},
		{Iface: "eth0", Ts: ts(1), RXBytes: 100}, // idle
		{Iface: "eth0", Ts: ts(2), RXBytes: 900}, // +800 recovered
	}
	out := accumulate("dev1", snaps)
	dev := findScope(out, "device")
	if dev == nil || dev.RXBytes != 800 || dev.HadReset {
		t.Fatalf("gap recovery wrong: %+v", dev)
	}
}

func TestAccumulate_MultiInterfaceSummed(t *testing.T) {
	snaps := []store.CounterSnapshot{
		{Iface: "eth0", Ts: ts(0), RXBytes: 100},
		{Iface: "eth0", Ts: ts(1), RXBytes: 300}, // +200
		{Iface: "eth1", Ts: ts(0), RXBytes: 50},
		{Iface: "eth1", Ts: ts(1), RXBytes: 150}, // +100
	}
	out := accumulate("dev1", snaps)
	dev := findScope(out, "device")
	if dev == nil || dev.RXBytes != 300 { // 200 + 100
		t.Fatalf("device sum wrong: %+v", dev)
	}
	if e0 := findScope(out, "eth0"); e0 == nil || e0.RXBytes != 200 {
		t.Fatalf("eth0 wrong: %+v", e0)
	}
	if e1 := findScope(out, "eth1"); e1 == nil || e1.RXBytes != 100 {
		t.Fatalf("eth1 wrong: %+v", e1)
	}
}

func TestAccumulate_FirstSnapshotIsBaselineOnly(t *testing.T) {
	// a single snapshot per iface produces no usage (no pair to diff)
	snaps := []store.CounterSnapshot{
		{Iface: "eth0", Ts: ts(0), RXBytes: 100},
	}
	out := accumulate("dev1", snaps)
	if len(out) != 0 {
		t.Fatalf("single snapshot should yield no rollups, got %d", len(out))
	}
}

func TestUsageDelta_WrapTreatedAsReset(t *testing.T) {
	// counter wrap (uint64 near-max -> small value) is treated as a reset.
	u, reset := usageDelta(^uint64(0)-50, 30)
	if u != 30 || !reset {
		t.Fatalf("wrap: want usage=30 reset=true, got usage=%d reset=%v", u, reset)
	}
}

func findScope(rs []store.UsageRollup, scope string) *store.UsageRollup {
	for i := range rs {
		if rs[i].Scope == scope {
			return &rs[i]
		}
	}
	return nil
}
