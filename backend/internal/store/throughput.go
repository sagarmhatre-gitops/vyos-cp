package store

import (
	"context"
	"encoding/json"
	"time"
)

// ThroughputRow is one persisted sample.
type ThroughputRow struct {
	DeviceID  string          `json:"device_id"`
	Timestamp time.Time       `json:"ts"`
	RXBps     uint64          `json:"rx_bps"`
	TXBps     uint64          `json:"tx_bps"`
	RXPps     uint64          `json:"rx_pps"`
	TXPps     uint64          `json:"tx_pps"`
	PerIface  json.RawMessage `json:"per_iface,omitempty"`
}

// InsertThroughput persists one minute-aggregated sample for one device.
func (s *Store) InsertThroughput(ctx context.Context, r ThroughputRow) error {
	per := r.PerIface
	if len(per) == 0 {
		per = json.RawMessage(`{}`)
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO throughput_samples (device_id, ts, rx_bps, tx_bps, rx_pps, tx_pps, per_iface)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (device_id, ts) DO UPDATE SET
			rx_bps = EXCLUDED.rx_bps, tx_bps = EXCLUDED.tx_bps,
			rx_pps = EXCLUDED.rx_pps, tx_pps = EXCLUDED.tx_pps,
			per_iface = EXCLUDED.per_iface
	`, r.DeviceID, r.Timestamp, r.RXBps, r.TXBps, r.RXPps, r.TXPps, per)
	return err
}

// ThroughputRange returns a device's samples in [since, now], oldest first.
func (s *Store) ThroughputRange(ctx context.Context, deviceID string, since time.Time) ([]ThroughputRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT ts, rx_bps, tx_bps, rx_pps, tx_pps, per_iface
		FROM throughput_samples
		WHERE device_id = $1 AND ts >= $2
		ORDER BY ts ASC
	`, deviceID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ThroughputRow
	for rows.Next() {
		r := ThroughputRow{DeviceID: deviceID}
		var per []byte
		if err := rows.Scan(&r.Timestamp, &r.RXBps, &r.TXBps, &r.RXPps, &r.TXPps, &per); err != nil {
			return nil, err
		}
		r.PerIface = json.RawMessage(per)
		out = append(out, r)
	}
	return out, rows.Err()
}

// FleetThroughputRange returns timestamp-bucketed sums across every device.
// Buckets are on the minute boundary.
func (s *Store) FleetThroughputRange(ctx context.Context, since time.Time) ([]ThroughputRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT
			date_trunc('minute', ts) AS bucket,
			SUM(rx_bps)::BIGINT, SUM(tx_bps)::BIGINT,
			SUM(rx_pps)::BIGINT, SUM(tx_pps)::BIGINT
		FROM throughput_samples
		WHERE ts >= $1
		GROUP BY bucket
		ORDER BY bucket ASC
	`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ThroughputRow
	for rows.Next() {
		var r ThroughputRow
		if err := rows.Scan(&r.Timestamp, &r.RXBps, &r.TXBps, &r.RXPps, &r.TXPps); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// LatestThroughputByDevice returns the most recent sample per device as a
// map keyed by device ID. Used to add a Throughput column to the devices list
// without a second request.
func (s *Store) LatestThroughputByDevice(ctx context.Context) (map[string]ThroughputRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (device_id) device_id, ts, rx_bps, tx_bps, rx_pps, tx_pps
		FROM throughput_samples
		WHERE ts >= NOW() - INTERVAL '5 minutes'
		ORDER BY device_id, ts DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]ThroughputRow{}
	for rows.Next() {
		var r ThroughputRow
		if err := rows.Scan(&r.DeviceID, &r.Timestamp, &r.RXBps, &r.TXBps, &r.RXPps, &r.TXPps); err != nil {
			return nil, err
		}
		out[r.DeviceID] = r
	}
	return out, rows.Err()
}

// PruneThroughput deletes samples older than cutoff. Run at startup and
// periodically thereafter to keep the table bounded.
func (s *Store) PruneThroughput(ctx context.Context, cutoff time.Time) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM throughput_samples WHERE ts < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
