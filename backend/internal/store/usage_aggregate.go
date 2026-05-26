package store

import (
	"context"
	"time"
)

// HourlyRollupsSince returns all 'hour' period rollups for a device with
// period_start >= since, oldest-first, every scope. The daily/monthly rollup
// derivation aggregates these. Separate from UsageRange (which is the read path
// for the API) so the aggregation query intent is explicit.
func (s *Store) HourlyRollupsSince(ctx context.Context, deviceID string, since time.Time) ([]UsageRollup, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT device_id, scope, period_type, period_start, rx_bytes, tx_bytes, had_reset, source
		FROM usage_rollups
		WHERE device_id = $1 AND period_type = 'hour' AND period_start >= $2
		ORDER BY period_start ASC, scope ASC
	`, deviceID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UsageRollup
	for rows.Next() {
		var r UsageRollup
		var rx, tx int64
		if err := rows.Scan(&r.DeviceID, &r.Scope, &r.PeriodType, &r.PeriodStart,
			&rx, &tx, &r.HadReset, &r.Source); err != nil {
			return nil, err
		}
		r.RXBytes, r.TXBytes = uint64(rx), uint64(tx)
		out = append(out, r)
	}
	return out, rows.Err()
}
