package service

import (
	"context"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/store"
)

// CollectAndStoreMetrics is the entry point the poller calls every minute
// per online device. It reuses the existing GetDeviceOverview flow (4 op-mode
// calls in parallel, parsed) and persists a row to the device_metrics table.
//
// We deliberately don't add yet another path that does the same work — keeping
// one canonical way to read these metrics means the parsers always stay in
// sync with what the UI tile shows. The cost is one extra Postgres write per
// device per minute, which is negligible.
//
// Errors are absorbed (logged at the caller, not returned) because a single
// failed sample shouldn't tank the whole minute's poll cycle. Most failures
// (device offline, transient API timeout) are self-healing on the next tick.
func (s *Service) CollectAndStoreMetrics(ctx context.Context, deviceID string) error {
	ov, err := s.GetDeviceOverview(ctx, deviceID)
	if err != nil {
		return err
	}
	if ov == nil {
		return nil
	}
	// Skip if every parsed field is zero — likely the device is offline or
	// the API just returned errors. Avoid storing all-null rows that just
	// pollute the chart.
	if ov.MemoryTotalMB == 0 && ov.SessionCount == 0 && ov.Load1 == 0 {
		return nil
	}
	return s.store.InsertDeviceMetric(ctx, deviceID, time.Now(), *ov)
}

// DeviceMetricsRange returns historical samples for one device. Passthrough
// to the store layer so the API handler doesn't need to import store.
func (s *Service) DeviceMetricsRange(ctx context.Context, deviceID string, from, to time.Time) ([]store.DeviceMetricSample, error) {
	return s.store.DeviceMetricsRange(ctx, deviceID, from, to)
}
