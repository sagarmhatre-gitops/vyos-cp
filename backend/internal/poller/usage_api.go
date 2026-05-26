package poller

import (
	"context"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/store"
)

// UsageRange exposes accumulated usage rollups to the API layer (the api.Server
// holds *Poller, not *store.Store). Thin pass-through.
func (p *Poller) UsageRange(ctx context.Context, deviceID, periodType string, since time.Time) ([]store.UsageRollup, error) {
	return p.store.UsageRange(ctx, deviceID, periodType, since)
}
