package poller

import (
	"context"
	"log"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/store"
)

// aggregateHourly rolls a slice of hourly usage rows up into a coarser period
// ('day' or 'month'), summing rx/tx per (scope, period) and OR-ing had_reset.
// Pure function over the input slice — no I/O — so it is unit-tested directly,
// exactly like accumulate. Recompute-and-replace: re-running over the same
// hourly rows yields identical output, so it is idempotent.
func aggregateHourly(deviceID string, hourly []store.UsageRollup, periodType string) []store.UsageRollup {
	type key struct {
		scope  string
		period time.Time
	}
	agg := map[key]*store.UsageRollup{}
	for _, h := range hourly {
		ps := periodStart(h.PeriodStart, periodType)
		k := key{h.Scope, ps}
		r := agg[k]
		if r == nil {
			r = &store.UsageRollup{
				DeviceID: deviceID, Scope: h.Scope, PeriodType: periodType,
				PeriodStart: ps, Source: "counter",
			}
			agg[k] = r
		}
		r.RXBytes += h.RXBytes
		r.TXBytes += h.TXBytes
		r.HadReset = r.HadReset || h.HadReset
	}
	out := make([]store.UsageRollup, 0, len(agg))
	for _, r := range agg {
		out = append(out, *r)
	}
	return out
}

// runDailyMonthlyRollup derives 'day' and 'month' rollups from existing hourly
// rows and REPLACES those buckets. Same recompute-and-replace discipline as the
// hourly job: it reads a bounded look-back of hourly rows, aggregates, and only
// (over)writes the current and immediately-prior day/month — older complete
// periods are left intact (recomputing them from a truncated hourly window could
// under-count). Error-isolated.
func (p *Poller) runDailyMonthlyRollup(ctx context.Context, deviceID string) {
	now := time.Now().UTC()

	// --- daily: look back far enough to cover yesterday + today fully.
	// 50h ensures the whole of "yesterday" is present even right after midnight.
	daySince := now.Add(-50 * time.Hour)
	if hourly, err := p.store.HourlyRollupsSince(ctx, deviceID, daySince); err != nil {
		log.Printf("usage-rollup(day): read err device=%s: %v", deviceID, err)
	} else {
		writeFrom := periodStart(now, "day").AddDate(0, 0, -1) // yesterday 00:00
		for _, r := range aggregateHourly(deviceID, hourly, "day") {
			if r.PeriodStart.Before(writeFrom) {
				continue // older complete day — leave intact
			}
			if err := p.store.SetUsage(ctx, r); err != nil {
				log.Printf("usage-rollup(day): setusage err device=%s scope=%s: %v", deviceID, r.Scope, err)
			}
		}
	}

	// --- monthly: look back to cover the prior month + current month.
	// Start from the first day of the previous month.
	prevMonth := periodStart(now, "month").AddDate(0, -1, 0)
	if hourly, err := p.store.HourlyRollupsSince(ctx, deviceID, prevMonth); err != nil {
		log.Printf("usage-rollup(month): read err device=%s: %v", deviceID, err)
	} else {
		writeFrom := prevMonth // previous month 1st 00:00
		for _, r := range aggregateHourly(deviceID, hourly, "month") {
			if r.PeriodStart.Before(writeFrom) {
				continue
			}
			if err := p.store.SetUsage(ctx, r); err != nil {
				log.Printf("usage-rollup(month): setusage err device=%s scope=%s: %v", deviceID, r.Scope, err)
			}
		}
	}
}
