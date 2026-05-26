package poller

import (
	"testing"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/store"
)

func hr(y int, mo time.Month, d, h int) time.Time {
	return time.Date(y, mo, d, h, 0, 0, 0, time.UTC)
}

func hourly(scope string, t time.Time, rx, tx uint64, reset bool) store.UsageRollup {
	return store.UsageRollup{
		Scope: scope, PeriodType: "hour", PeriodStart: t,
		RXBytes: rx, TXBytes: tx, HadReset: reset, Source: "counter",
	}
}

func TestAggregateHourly_Daily(t *testing.T) {
	rows := []store.UsageRollup{
		hourly("device", hr(2026, 5, 26, 10), 100, 50, false),
		hourly("device", hr(2026, 5, 26, 11), 200, 80, true),
		hourly("device", hr(2026, 5, 26, 12), 150, 60, false),
		hourly("device", hr(2026, 5, 25, 23), 10, 5, false), // prior day
	}
	out := aggregateHourly("dev1", rows, "day")

	d26 := findPeriod(out, "device", hr(2026, 5, 26, 0))
	if d26 == nil || d26.RXBytes != 450 || d26.TXBytes != 190 || !d26.HadReset {
		t.Fatalf("day 26 wrong: %+v", d26)
	}
	if d26.PeriodType != "day" {
		t.Fatalf("period_type not 'day': %s", d26.PeriodType)
	}
	d25 := findPeriod(out, "device", hr(2026, 5, 25, 0))
	if d25 == nil || d25.RXBytes != 10 || d25.HadReset {
		t.Fatalf("day 25 wrong: %+v", d25)
	}
}

func TestAggregateHourly_Monthly(t *testing.T) {
	rows := []store.UsageRollup{
		hourly("device", hr(2026, 5, 26, 10), 100, 50, false),
		hourly("device", hr(2026, 5, 25, 23), 10, 5, true),
		hourly("device", hr(2026, 4, 30, 12), 999, 1, false), // prior month
	}
	out := aggregateHourly("dev1", rows, "month")

	may := findPeriod(out, "device", hr(2026, 5, 1, 0))
	if may == nil || may.RXBytes != 110 || may.TXBytes != 55 || !may.HadReset {
		t.Fatalf("May wrong: %+v", may)
	}
	apr := findPeriod(out, "device", hr(2026, 4, 1, 0))
	if apr == nil || apr.RXBytes != 999 {
		t.Fatalf("April wrong: %+v", apr)
	}
}

func TestAggregateHourly_PerScope(t *testing.T) {
	rows := []store.UsageRollup{
		hourly("device", hr(2026, 5, 26, 10), 300, 0, false),
		hourly("eth0", hr(2026, 5, 26, 10), 200, 0, false),
		hourly("eth1", hr(2026, 5, 26, 10), 100, 0, false),
		hourly("eth0", hr(2026, 5, 26, 11), 50, 0, false),
	}
	out := aggregateHourly("dev1", rows, "day")
	if e0 := findPeriod(out, "eth0", hr(2026, 5, 26, 0)); e0 == nil || e0.RXBytes != 250 {
		t.Fatalf("eth0 day wrong: %+v", e0)
	}
	if dev := findPeriod(out, "device", hr(2026, 5, 26, 0)); dev == nil || dev.RXBytes != 300 {
		t.Fatalf("device day wrong: %+v", dev)
	}
}

func TestAggregateHourly_Idempotent(t *testing.T) {
	rows := []store.UsageRollup{
		hourly("device", hr(2026, 5, 26, 10), 100, 50, false),
		hourly("device", hr(2026, 5, 26, 11), 200, 80, true),
	}
	a := aggregateHourly("dev1", rows, "day")
	b := aggregateHourly("dev1", rows, "day")
	if len(a) != 1 || len(b) != 1 {
		t.Fatalf("expected 1 day bucket, got a=%d b=%d", len(a), len(b))
	}
	if a[0].RXBytes != b[0].RXBytes || a[0].TXBytes != b[0].TXBytes || a[0].HadReset != b[0].HadReset {
		t.Fatal("aggregation not idempotent")
	}
}

func TestAggregateHourly_Empty(t *testing.T) {
	if out := aggregateHourly("dev1", nil, "day"); len(out) != 0 {
		t.Fatalf("empty input should yield nothing, got %d", len(out))
	}
}

func findPeriod(rs []store.UsageRollup, scope string, ps time.Time) *store.UsageRollup {
	for i := range rs {
		if rs[i].Scope == scope && rs[i].PeriodStart.Equal(ps) {
			return &rs[i]
		}
	}
	return nil
}
