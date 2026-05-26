package poller

import (
	"context"
	"log"
	"time"
)

// collectFlows fetches the current conntrack table for a device and stores it as
// a flow snapshot. Error-isolated: any failure logs and returns without
// affecting throughput/usage collection. Gated by the flow-snapshot cadence.
func (p *Poller) collectFlows(ctx context.Context, deviceID string) {
	client, err := p.clientFor(deviceID)
	if err != nil {
		return // device client unavailable; throughput path logs this already
	}
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

// FlowsLatest exposes the most recent flow snapshot to the API layer (api.Server
// holds *Poller). Thin pass-through.
func (p *Poller) FlowsLatest(ctx context.Context, deviceID string, limit int) (interface{}, error) {
	return p.store.LatestFlows(ctx, deviceID, limit)
}
