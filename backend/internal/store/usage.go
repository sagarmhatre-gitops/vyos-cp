package store

import (
	"context"
	"time"
)

// CounterSnapshot is one raw cumulative-counter reading for one interface.
type CounterSnapshot struct {
	DeviceID string
	Iface    string
	Ts       time.Time
	RXBytes  uint64
	TXBytes  uint64
}

// UsageRollup is accumulated usage for one (device, scope, period).
type UsageRollup struct {
	DeviceID    string    `json:"device_id"`
	Scope       string    `json:"scope"`
	PeriodType  string    `json:"period_type"`
	PeriodStart time.Time `json:"period_start"`
	RXBytes     uint64    `json:"rx_bytes"`
	TXBytes     uint64    `json:"tx_bytes"`
	HadReset    bool      `json:"had_reset"`
	Source      string    `json:"source"`
}

// InsertCounterSnapshot persists one raw counter reading. Idempotent per
// (device, iface, ts).
func (s *Store) InsertCounterSnapshot(ctx context.Context, c CounterSnapshot) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO iface_counter_snapshots (device_id, iface, ts, rx_bytes, tx_bytes)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (device_id, iface, ts) DO NOTHING
	`, c.DeviceID, c.Iface, c.Ts, int64(c.RXBytes), int64(c.TXBytes))
	return err
}

// CounterSnapshotsSince returns snapshots for a device in [since, now], oldest
// first, ordered by iface then ts so the rollup can diff consecutive readings
// per interface.
func (s *Store) CounterSnapshotsSince(ctx context.Context, deviceID string, since time.Time) ([]CounterSnapshot, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT iface, ts, rx_bytes, tx_bytes
		FROM iface_counter_snapshots
		WHERE device_id = $1 AND ts >= $2
		ORDER BY iface ASC, ts ASC
	`, deviceID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CounterSnapshot
	for rows.Next() {
		c := CounterSnapshot{DeviceID: deviceID}
		var rx, tx int64
		if err := rows.Scan(&c.Iface, &c.Ts, &rx, &tx); err != nil {
			return nil, err
		}
		c.RXBytes, c.TXBytes = uint64(rx), uint64(tx)
		out = append(out, c)
	}
	return out, rows.Err()
}

// SetUsage upserts a rollup, REPLACING the period's byte totals with the
// recomputed value. The rollup job recomputes a whole period from all its
// snapshots each run, so replace (not add) makes re-runs idempotent — no
// double-counting if the job overlaps a period it already processed.
func (s *Store) SetUsage(ctx context.Context, r UsageRollup) error {
	if r.Source == "" {
		r.Source = "counter"
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO usage_rollups
			(device_id, scope, period_type, period_start, rx_bytes, tx_bytes, had_reset, source, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
		ON CONFLICT (device_id, scope, period_type, period_start) DO UPDATE SET
			rx_bytes  = EXCLUDED.rx_bytes,
			tx_bytes  = EXCLUDED.tx_bytes,
			had_reset = EXCLUDED.had_reset,
			updated_at = now()
	`, r.DeviceID, r.Scope, r.PeriodType, r.PeriodStart,
		int64(r.RXBytes), int64(r.TXBytes), r.HadReset, r.Source)
	return err
}

// UsageRange returns rollup rows for a device at a given period type, for
// periods starting at or after `since`, oldest-first.
func (s *Store) UsageRange(ctx context.Context, deviceID, periodType string, since time.Time) ([]UsageRollup, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT device_id, scope, period_type, period_start, rx_bytes, tx_bytes, had_reset, source
		FROM usage_rollups
		WHERE device_id = $1 AND period_type = $2 AND period_start >= $3
		ORDER BY period_start ASC, scope ASC
	`, deviceID, periodType, since)
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

// PruneCounterSnapshots deletes raw snapshots older than cutoff. Rolled-up
// usage is retained separately, so raw snapshots are short-lived.
func (s *Store) PruneCounterSnapshots(ctx context.Context, cutoff time.Time) (int64, error) {
	ct, err := s.pool.Exec(ctx, `DELETE FROM iface_counter_snapshots WHERE ts < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	return ct.RowsAffected(), nil
}

// LastRollupCursor returns the latest period_start we've rolled up for a device
// at a given period_type, or zero time if none. The rollup job uses this to
// know where to resume.
func (s *Store) LastRollupCursor(ctx context.Context, deviceID, periodType string) (time.Time, error) {
	var t *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT max(period_start) FROM usage_rollups
		WHERE device_id = $1 AND period_type = $2
	`, deviceID, periodType).Scan(&t)
	if err != nil {
		return time.Time{}, err
	}
	if t == nil {
		return time.Time{}, nil
	}
	return *t, nil
}
