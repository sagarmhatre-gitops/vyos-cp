package poller

import (
	"context"
	"log"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/store"
)

// usageDelta computes bytes transferred between two consecutive cumulative
// counter readings, with reset detection.
//
// Rule (matches standard SNMP/metering practice — discard negative diffs):
//   curr >= prev : usage = curr - prev          (normal monotonic increase)
//   curr <  prev : usage = curr, reset=true     (reboot/wrap: counter restarted
//                                                 at 0 and counted up to curr)
//
// We do NOT estimate the traffic lost between `prev` and the reset moment — that
// data died with the counter. We record only what we can prove and flag the
// reset so the billing layer can decide. Conservative: never over-counts.
func usageDelta(prev, curr uint64) (usage uint64, reset bool) {
	if curr >= prev {
		return curr - prev, false
	}
	return curr, true
}

// periodStart truncates t to the start of the given period type.
func periodStart(t time.Time, periodType string) time.Time {
	t = t.UTC()
	switch periodType {
	case "hour":
		return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), 0, 0, 0, time.UTC)
	case "day":
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	case "month":
		return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	}
	return t
}

// accumulate walks per-interface snapshots (already sorted by iface, then ts)
// and produces per-(scope, hour) usage increments. Each consecutive pair within
// the same interface contributes a reset-aware delta to the hour bucket of the
// LATER reading. Returns hourly rollups keyed by (scope, hourStart); the device
// scope is the sum across interfaces.
//
// Pure function over the snapshot slice — no I/O — so it is unit-tested directly.
func accumulate(deviceID string, snaps []store.CounterSnapshot) []store.UsageRollup {
	type key struct {
		scope string
		hour  time.Time
	}
	agg := map[key]*store.UsageRollup{}

	get := func(scope string, hour time.Time) *store.UsageRollup {
		k := key{scope, hour}
		if agg[k] == nil {
			agg[k] = &store.UsageRollup{
				DeviceID: deviceID, Scope: scope, PeriodType: "hour",
				PeriodStart: hour, Source: "counter",
			}
		}
		return agg[k]
	}

	var prevIface string
	var prev store.CounterSnapshot
	havePrev := false

	for _, s := range snaps {
		if s.Iface != prevIface {
			// new interface — first reading is only a baseline, no delta yet
			prevIface = s.Iface
			prev = s
			havePrev = true
			continue
		}
		if !havePrev {
			prev = s
			havePrev = true
			continue
		}
		rx, rxReset := usageDelta(prev.RXBytes, s.RXBytes)
		tx, txReset := usageDelta(prev.TXBytes, s.TXBytes)
		reset := rxReset || txReset
		hour := periodStart(s.Ts, "hour")

		// per-interface scope
		ifb := get(s.Iface, hour)
		ifb.RXBytes += rx
		ifb.TXBytes += tx
		ifb.HadReset = ifb.HadReset || reset

		// device scope (sum across interfaces)
		dev := get("device", hour)
		dev.RXBytes += rx
		dev.TXBytes += tx
		dev.HadReset = dev.HadReset || reset

		prev = s
	}

	out := make([]store.UsageRollup, 0, len(agg))
	for _, r := range agg {
		out = append(out, *r)
	}
	return out
}

// runUsageRollup recomputes hourly usage for a bounded recent window from raw
// snapshots and REPLACES those hour buckets. Recompute-and-replace is idempotent:
// running every few minutes simply recomputes the current (and just-completed)
// hour from all its snapshots — no cursor, no double-counting. Isolated from
// collection: errors log and return.
func (p *Poller) runUsageRollup(ctx context.Context, deviceID string) {
	// 2h look-back covers the current hour plus the one before (so a
	// just-completed hour gets its final value once no more snapshots arrive).
	since := time.Now().Add(-2 * time.Hour)
	snaps, err := p.store.CounterSnapshotsSince(ctx, deviceID, since)
	if err != nil {
		log.Printf("usage-rollup: snapshots err device=%s: %v", deviceID, err)
		return
	}
	if len(snaps) < 2 {
		return
	}
	// Only (over)write the current and immediately-prior hour. Older hours in
	// the look-back window were already fully computed on earlier runs when they
	// were "current"; recomputing them now from a truncated window could write a
	// partial (under-counted) value, so we leave them intact.
	writeFrom := periodStart(time.Now(), "hour").Add(-1 * time.Hour)
	for _, r := range accumulate(deviceID, snaps) {
		if r.PeriodStart.Before(writeFrom) {
			continue
		}
		if err := p.store.SetUsage(ctx, r); err != nil {
			log.Printf("usage-rollup: setusage err device=%s scope=%s: %v", deviceID, r.Scope, err)
		}
	}
}
