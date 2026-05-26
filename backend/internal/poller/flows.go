package poller

import (
	"context"
	"log"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/vyos"
)

// collectFlows fetches the current conntrack table for a device and stores it as
// a flow snapshot. Takes the already-resolved *vyos.Client (same pattern as
// maybeCaptureSnapshot) so it shares the client pollOne already holds.
// Error-isolated: any failure logs and returns without affecting throughput/usage.
func (p *Poller) collectFlows(ctx context.Context, deviceID string, client *vyos.Client) {
	flows, err := client.ShowConntrack(ctx)
	if err != nil {
		log.Printf("flows: show conntrack err device=%s: %v", deviceID, err)
		return
	}
	if len(flows) == 0 {
		return
	}
	ts := time.Now().Truncate(time.Second)
	if err := p.store.ReplaceFlowSnapshot(ctx, deviceID, ts, flows); err != nil {
		log.Printf("flows: store err device=%s: %v", deviceID, err)
	}
}

// FlowsLatest exposes the most recent flow snapshot to the API layer
// (api.Server holds *Poller). Thin pass-through.
func (p *Poller) FlowsLatest(ctx context.Context, deviceID string, limit int) (interface{}, error) {
	return p.store.LatestFlows(ctx, deviceID, limit)
}
