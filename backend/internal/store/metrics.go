package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// DeviceMetricSample is one row in the device_metrics table. All fields are
// pointers so the JSON layer can omit nulls — a reading is allowed to miss
// individual fields without dropping the whole row (e.g. memory parsed but
// CPU didn't).
type DeviceMetricSample struct {
	Bucket      time.Time `json:"bucket"`
	CPUPct      *float64  `json:"cpu_pct,omitempty"`
	CPUPct5m    *float64  `json:"cpu_pct_5m,omitempty"`
	CPUPct15m   *float64  `json:"cpu_pct_15m,omitempty"`
	MemUsedMB   *int      `json:"mem_used_mb,omitempty"`
	MemTotalMB  *int      `json:"mem_total_mb,omitempty"`
	Sessions    *int      `json:"sessions,omitempty"`
}

// InsertDeviceMetric upserts one minute-bucket of device health. The bucket
// timestamp is rounded to the minute by the caller so concurrent samples
// from a few seconds apart collapse into the same row (last write wins).
func (s *Store) InsertDeviceMetric(ctx context.Context, deviceID string, bucket time.Time, m model.DeviceOverview) error {
	// Round to the minute. Doing it here (not at the call site) means callers
	// don't have to remember; a sample from 14:23:45 lands in bucket 14:23:00.
	bucket = bucket.UTC().Truncate(time.Minute)

	// We always insert all six columns; nullable values use NULL. UPSERT on
	// the composite primary key.
	var cpu1, cpu5, cpu15 *float64
	var memU, memT, sess *int
	if m.Load1 != 0 {
		v := m.Load1
		cpu1 = &v
	}
	if m.Load5 != 0 {
		v := m.Load5
		cpu5 = &v
	}
	if m.Load15 != 0 {
		v := m.Load15
		cpu15 = &v
	}
	if m.MemoryUsedMB != 0 {
		v := m.MemoryUsedMB
		memU = &v
	}
	if m.MemoryTotalMB != 0 {
		v := m.MemoryTotalMB
		memT = &v
	}
	if m.SessionCount != 0 {
		v := m.SessionCount
		sess = &v
	}

	_, err := s.pool.Exec(ctx, `
		INSERT INTO device_metrics
		  (device_id, bucket, cpu_pct, cpu_pct_5m, cpu_pct_15m,
		   mem_used_mb, mem_total_mb, sessions)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (device_id, bucket) DO UPDATE SET
		  cpu_pct      = COALESCE(EXCLUDED.cpu_pct,      device_metrics.cpu_pct),
		  cpu_pct_5m   = COALESCE(EXCLUDED.cpu_pct_5m,   device_metrics.cpu_pct_5m),
		  cpu_pct_15m  = COALESCE(EXCLUDED.cpu_pct_15m,  device_metrics.cpu_pct_15m),
		  mem_used_mb  = COALESCE(EXCLUDED.mem_used_mb,  device_metrics.mem_used_mb),
		  mem_total_mb = COALESCE(EXCLUDED.mem_total_mb, device_metrics.mem_total_mb),
		  sessions     = COALESCE(EXCLUDED.sessions,     device_metrics.sessions)
	`, deviceID, bucket, cpu1, cpu5, cpu15, memU, memT, sess)
	return err
}

// DeviceMetricsRange returns samples for one device in [from, to], oldest
// first. Empty slice (not nil) when there are no samples — the UI then
// renders an empty chart placeholder rather than treating it as a fetch error.
func (s *Store) DeviceMetricsRange(ctx context.Context, deviceID string, from, to time.Time) ([]DeviceMetricSample, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT bucket, cpu_pct, cpu_pct_5m, cpu_pct_15m,
		       mem_used_mb, mem_total_mb, sessions
		FROM device_metrics
		WHERE device_id = $1 AND bucket >= $2 AND bucket <= $3
		ORDER BY bucket ASC
	`, deviceID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DeviceMetricSample{}
	for rows.Next() {
		var s DeviceMetricSample
		if err := rows.Scan(&s.Bucket, &s.CPUPct, &s.CPUPct5m, &s.CPUPct15m,
			&s.MemUsedMB, &s.MemTotalMB, &s.Sessions); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// PruneDeviceMetrics deletes rows older than the given cutoff. Called from
// the same prune loop that handles throughput_samples.
func (s *Store) PruneDeviceMetrics(ctx context.Context, olderThan time.Time) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM device_metrics WHERE bucket < $1`, olderThan)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// LatestDeviceMetric returns the most recent metrics row for one device, or
// nil if no samples have been collected yet. Used by the fleet health endpoint
// to bucket each device into healthy/warning/critical without re-running the
// full overview poll.
func (s *Store) LatestDeviceMetric(ctx context.Context, deviceID string) (*DeviceMetricSample, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT bucket, cpu_pct, cpu_pct_5m, cpu_pct_15m,
		       mem_used_mb, mem_total_mb, sessions
		FROM device_metrics
		WHERE device_id = $1
		ORDER BY bucket DESC
		LIMIT 1
	`, deviceID)
	var m DeviceMetricSample
	err := row.Scan(&m.Bucket, &m.CPUPct, &m.CPUPct5m, &m.CPUPct15m,
		&m.MemUsedMB, &m.MemTotalMB, &m.Sessions)
	if err != nil {
		// "No rows" is a normal state for devices that just came online —
		// caller treats nil as "unknown". Anything else is a real failure.
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &m, nil
}
