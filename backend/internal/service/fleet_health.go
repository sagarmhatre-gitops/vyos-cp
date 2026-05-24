package service

import (
	"context"
	"time"
)

// FleetHealth is the aggregate the dashboard donut + alert tiles render from.
// All counts are derived from data we already collect — no new schema, no
// new poll cycles. The classification logic is intentionally simple so the
// dashboard's signal stays interpretable; if we later want richer alerts
// (BGP neighbor down, link flapping, threshold breach over N minutes) those
// belong in a real alerts engine, not here.
type FleetHealth struct {
	Total    int `json:"total"`
	Healthy  int `json:"healthy"`  // online + cpu < 80% + mem < 85%
	Warning  int `json:"warning"`  // online + (cpu >= 80% OR mem >= 85%)
	Critical int `json:"critical"` // status != online
	Stale    int `json:"stale"`    // online but last_seen > 5min ago
	Unknown  int `json:"unknown"`  // online but no metrics samples yet
}

// Thresholds. These match the per-tile highlight thresholds used on the
// device Overview page (Tile.highlight = warn when cpu > 80 or mem > 85).
// Keeping them aligned means a device that's amber on its own page is also
// counted as "warning" on the fleet dashboard — no surprises.
const (
	cpuWarnPct  = 80.0
	memWarnPct  = 85.0
	staleAfter  = 5 * time.Minute
)

// GetFleetHealth walks every device, looks at status + the latest device_metrics
// row, and buckets it. Cheap: one ListDevices query plus N tiny indexed lookups
// against device_metrics. For typical fleet sizes this is well under 50ms even
// without batching.
func (s *Service) GetFleetHealth(ctx context.Context) (*FleetHealth, error) {
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	out := FleetHealth{Total: len(devices)}

	for _, d := range devices {
		// Critical first — offline overrides everything else.
		if d.Status != "online" {
			out.Critical++
			continue
		}
		// Stale: online status but the poller hasn't successfully checked
		// in recently. Could be a network blip or a process hang on cp side;
		// either way the data we're showing is suspect.
		if !d.LastSeen.IsZero() && now.Sub(d.LastSeen) > staleAfter {
			out.Stale++
			continue
		}
		m, err := s.store.LatestDeviceMetric(ctx, d.ID)
		if err != nil {
			// DB error reading metrics — don't fail the whole fleet rollup.
			// Bucket as unknown and continue.
			out.Unknown++
			continue
		}
		if m == nil {
			// No samples collected yet — device may have just come online.
			out.Unknown++
			continue
		}
		// Compute mem % only when we have both used + total. Sample with
		// neither set is treated as no-data on that axis (won't trigger
		// warning by itself).
		var cpu, memPct float64
		if m.CPUPct != nil {
			cpu = *m.CPUPct
		}
		if m.MemUsedMB != nil && m.MemTotalMB != nil && *m.MemTotalMB > 0 {
			memPct = float64(*m.MemUsedMB) / float64(*m.MemTotalMB) * 100
		}
		if cpu >= cpuWarnPct || memPct >= memWarnPct {
			out.Warning++
			continue
		}
		out.Healthy++
	}
	return &out, nil
}
