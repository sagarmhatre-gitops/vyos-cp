package poller

import (
	"context"
	"os"
	"strconv"
	"sync/atomic"
	"time"
)

// readCounterSnapEveryTicks reads VYOS_CP_USAGE_SNAP_TICKS (default 3 = ~30s at
// 10s ticks). 0 disables usage metering entirely.
func readCounterSnapEveryTicks() uint64 {
	if v := os.Getenv("VYOS_CP_USAGE_SNAP_TICKS"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			return n
		}
	}
	return 3
}

// maybePersistCounters persists raw interface counters on the cadence boundary.
// Mirrors maybeCaptureSnapshot's self-gating. Error-isolated (the persist calls
// log internally); never affects the throughput/status work in pollOne.
func (p *Poller) maybePersistCounters(ctx context.Context, deviceID string) {
	if p.counterSnapEveryTicks == 0 {
		return
	}
	v, _ := p.counterSnapTickCounter.LoadOrStore(deviceID, new(uint64))
	counter := v.(*uint64)
	n := atomic.AddUint64(counter, 1)
	if n != 1 && (n-1)%p.counterSnapEveryTicks != 0 {
		return
	}
	p.persistCounterSnapshots(ctx, deviceID)
}

// usageRollupLoop periodically rolls counter snapshots into usage_rollups for
// every device the poller knows about. Separate goroutine: isolated from
// collection. Runs every 5 minutes.
func (p *Poller) usageRollupLoop(ctx context.Context) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			devices, err := p.store.ListDevices(ctx)
			if err != nil {
				continue
			}
			for _, d := range devices {
				p.runUsageRollup(ctx, d.ID)
				p.runDailyMonthlyRollup(ctx, d.ID)
			}
		}
	}
}
