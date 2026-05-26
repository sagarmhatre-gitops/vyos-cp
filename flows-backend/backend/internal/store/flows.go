package store

import (
	"context"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// ReplaceFlowSnapshot stores the latest full set of flows for a device at one
// timestamp, in a single transaction. Flows are a point-in-time snapshot, so we
// insert the batch under one ts; the API reads back the most recent ts.
func (s *Store) ReplaceFlowSnapshot(ctx context.Context, deviceID string, ts time.Time, flows []model.Flow) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, f := range flows {
		_, err := tx.Exec(ctx, `
			INSERT INTO flow_snapshots
			  (device_id, ts, conntrack_id, protocol, state,
			   orig_src_ip, orig_src_port, orig_dst_ip, orig_dst_port,
			   reply_src_ip, reply_dst_ip, timeout_sec)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
			ON CONFLICT (device_id, ts, conntrack_id) DO NOTHING
		`, deviceID, ts, f.ConntrackID, f.Protocol, f.State,
			f.OrigSrcIP, f.OrigSrcPort, f.OrigDstIP, f.OrigDstPort,
			f.ReplySrcIP, f.ReplyDstIP, f.TimeoutSec)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// LatestFlows returns the flows from the most recent snapshot for a device.
func (s *Store) LatestFlows(ctx context.Context, deviceID string, limit int) ([]model.Flow, error) {
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	rows, err := s.pool.Query(ctx, `
		SELECT conntrack_id, protocol, state, orig_src_ip, orig_src_port,
		       orig_dst_ip, orig_dst_port, reply_src_ip, reply_dst_ip, timeout_sec, ts
		FROM flow_snapshots
		WHERE device_id = $1
		  AND ts = (SELECT max(ts) FROM flow_snapshots WHERE device_id = $1)
		ORDER BY protocol, orig_src_ip
		LIMIT $2
	`, deviceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Flow
	for rows.Next() {
		var f model.Flow
		if err := rows.Scan(&f.ConntrackID, &f.Protocol, &f.State,
			&f.OrigSrcIP, &f.OrigSrcPort, &f.OrigDstIP, &f.OrigDstPort,
			&f.ReplySrcIP, &f.ReplyDstIP, &f.TimeoutSec, &f.SeenAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// PruneFlowSnapshots deletes flow rows older than cutoff.
func (s *Store) PruneFlowSnapshots(ctx context.Context, cutoff time.Time) (int64, error) {
	ct, err := s.pool.Exec(ctx, `DELETE FROM flow_snapshots WHERE ts < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	return ct.RowsAffected(), nil
}
