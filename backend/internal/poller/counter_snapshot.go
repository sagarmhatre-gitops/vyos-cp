package poller

import (
	"context"
	"log"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/store"
)

// persistCounterSnapshots writes the latest raw cumulative interface counters
// (already fetched by the throughput collector and held in Thru.prev) into
// iface_counter_snapshots. Ground-truth for usage accumulation.
//
// Additive and error-isolated: any failure logs and returns; it never affects
// throughput/status collection. Gated by counterSnapEveryTicks cadence.
func (p *Poller) persistCounterSnapshots(ctx context.Context, deviceID string) {
	raw := p.Thru.RawCounters(deviceID)
	if len(raw) == 0 {
		return
	}
	now := time.Now().Truncate(time.Second)
	for iface, c := range raw {
		if err := p.store.InsertCounterSnapshot(ctx, store.CounterSnapshot{
			DeviceID: deviceID, Iface: iface, Ts: now,
			RXBytes: c.RXBytes, TXBytes: c.TXBytes,
		}); err != nil {
			log.Printf("counter-snapshot: persist err device=%s iface=%s: %v", deviceID, iface, err)
		}
	}
}
