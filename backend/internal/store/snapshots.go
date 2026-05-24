package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// ErrNoSnapshot is returned when a device has no snapshots yet.
var ErrNoSnapshot = errors.New("store: no snapshot for device")

// CanonicalHash produces a stable sha256 of the decoded config.
//
// The hash must be deterministic across runs: two configs that are semantically
// equal MUST hash identically, otherwise the dedup path inserts duplicates
// forever. encoding/json sorts map keys, but it does NOT sort slice elements,
// so any slice whose order is not semantically meaningful (e.g. a set of
// group members) needs to be normalized before hashing.
//
// For Ship 1 we accept the default stdlib behavior — slices keep their order —
// because the translator's output is already deterministic. Revisit if/when
// the decoder is rewritten.
func CanonicalHash(cfg model.DeviceConfig) ([]byte, error) {
	b, err := canonicalJSON(cfg)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(b)
	return sum[:], nil
}

// canonicalJSON marshals v with sorted map keys (stdlib default) and
// re-serializes generic map[string]any sub-trees through the same path to
// ensure nested maps inside `extra` also sort.
func canonicalJSON(v any) ([]byte, error) {
	// Two-pass: marshal to interface, normalize, marshal again. Slightly
	// wasteful but trivial compared to the network call we're about to make.
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return nil, err
	}
	return marshalSorted(generic)
}

// marshalSorted walks the value, sorting map keys at every level.
func marshalSorted(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeSorted(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeSorted(buf *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			kb, _ := json.Marshal(k)
			buf.Write(kb)
			buf.WriteByte(':')
			if err := writeSorted(buf, t[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeSorted(buf, e); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return err
		}
		buf.Write(b)
	}
	return nil
}

// AppendSnapshot inserts a snapshot for the device, with dedup-on-hash.
//
// If the most recent snapshot for the device has an identical config_hash,
// no row is inserted and the existing snapshot is returned. This is the
// single most important behavior in Ship 1: without it, polling every
// 5 minutes against an idle fleet of 50 devices produces ~14,400 redundant
// rows per day.
//
// The caller passes a DeviceSnapshot with DeviceID, Source, Config, and
// optionally ParentID / AuditLogID / CreatedBy populated. ID, TakenAt, and
// ConfigHash are filled in on return.
func (s *Store) AppendSnapshot(ctx context.Context, snap model.DeviceSnapshot) (model.DeviceSnapshot, error) {
	hash, err := CanonicalHash(snap.Config)
	if err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: hash config: %w", err)
	}

	// Dedup check. ORDER BY taken_at DESC LIMIT 1 hits idx_snapshots_device_taken.
	var latestHash []byte
	var latestID int64
	var latestTakenAt = snap.TakenAt
	err = s.pool.QueryRow(ctx, `
		SELECT id, config_hash, taken_at
		FROM device_snapshots
		WHERE device_id = $1
		ORDER BY taken_at DESC
		LIMIT 1
	`, snap.DeviceID).Scan(&latestID, &latestHash, &latestTakenAt)

	switch {
	case err == nil && bytes.Equal(hash, latestHash):
		// Identical to the last snapshot — return that one untouched.
		// We deliberately do NOT update taken_at: the snapshot's meaning is
		// "the device looked like this at this moment", and the most recent
		// such moment is when it first changed to look like this.
		return s.loadSnapshotByID(ctx, latestID)

	case err != nil && !errors.Is(err, pgx.ErrNoRows):
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: dedup lookup: %w", err)
	}

	cfgJSON, err := json.Marshal(snap.Config)
	if err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: marshal config: %w", err)
	}

	// Set parent_id to the previous latest if the caller didn't supply one.
	// Cheap historical breadcrumb that Ship 5 will lean on.
	parentID := snap.ParentID
	if parentID == nil && latestID != 0 {
		parentID = &latestID
	}

	var (
		insertedID      int64
		insertedTakenAt = snap.TakenAt
	)
	err = s.pool.QueryRow(ctx, `
		INSERT INTO device_snapshots
			(device_id, source, config_hash, config_json,
			 parent_id, audit_log_id, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, taken_at
	`,
		snap.DeviceID,
		snap.Source,
		hash,
		cfgJSON,
		parentID,
		snap.AuditLogID,
		snap.CreatedBy,
	).Scan(&insertedID, &insertedTakenAt)
	if err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: insert: %w", err)
	}

	snap.ID = insertedID
	snap.TakenAt = insertedTakenAt
	snap.ConfigHash = hex.EncodeToString(hash)
	snap.ParentID = parentID
	return snap, nil
}

// GetSnapshot returns a single snapshot by its primary key, including the
// full decoded config. Used by the diff endpoint to fetch arbitrary
// historical snapshots, not just the latest one.
func (s *Store) GetSnapshot(ctx context.Context, id int64) (model.DeviceSnapshot, error) {
	var (
		out       model.DeviceSnapshot
		hash      []byte
		cfgJSON   []byte
		parentID  *int64
		auditID   *int64
		createdBy *uuid.UUID
	)
	err := s.pool.QueryRow(ctx, `
		SELECT id, device_id, taken_at, source, config_hash, config_json,
		       parent_id, audit_log_id, created_by
		FROM device_snapshots
		WHERE id = $1
	`, id).Scan(
		&out.ID, &out.DeviceID, &out.TakenAt, &out.Source,
		&hash, &cfgJSON, &parentID, &auditID, &createdBy,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.DeviceSnapshot{}, ErrNoSnapshot
	}
	if err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: get by id: %w", err)
	}
	if err := json.Unmarshal(cfgJSON, &out.Config); err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: decode config_json: %w", err)
	}
	out.ConfigHash = hex.EncodeToString(hash)
	out.ParentID = parentID
	out.AuditLogID = auditID
	out.CreatedBy = createdBy
	return out, nil
}

// LatestSnapshot returns the most recent snapshot for a device.
// Returns ErrNoSnapshot if the device has never been snapshotted.
func (s *Store) LatestSnapshot(ctx context.Context, deviceID string) (model.DeviceSnapshot, error) {
	var (
		out      model.DeviceSnapshot
		hash     []byte
		cfgJSON  []byte
		parentID *int64
		auditID  *int64
		createdBy *uuid.UUID
	)
	err := s.pool.QueryRow(ctx, `
		SELECT id, device_id, taken_at, source, config_hash, config_json,
		       parent_id, audit_log_id, created_by
		FROM device_snapshots
		WHERE device_id = $1
		ORDER BY taken_at DESC
		LIMIT 1
	`, deviceID).Scan(
		&out.ID, &out.DeviceID, &out.TakenAt, &out.Source,
		&hash, &cfgJSON, &parentID, &auditID, &createdBy,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.DeviceSnapshot{}, ErrNoSnapshot
	}
	if err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: latest: %w", err)
	}

	if err := json.Unmarshal(cfgJSON, &out.Config); err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: decode config_json: %w", err)
	}
	out.ConfigHash = hex.EncodeToString(hash)
	out.ParentID = parentID
	out.AuditLogID = auditID
	out.CreatedBy = createdBy
	return out, nil
}

// ListSnapshots returns lightweight summaries (no config_json) for a device,
// newest first. Limit is clamped by the caller.
func (s *Store) ListSnapshots(ctx context.Context, deviceID string, limit int) ([]model.SnapshotSummary, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, device_id, taken_at, source, config_hash
		FROM device_snapshots
		WHERE device_id = $1
		ORDER BY taken_at DESC
		LIMIT $2
	`, deviceID, limit)
	if err != nil {
		return nil, fmt.Errorf("snapshot: list: %w", err)
	}
	defer rows.Close()

	out := make([]model.SnapshotSummary, 0, limit)
	for rows.Next() {
		var (
			s    model.SnapshotSummary
			hash []byte
		)
		if err := rows.Scan(&s.ID, &s.DeviceID, &s.TakenAt, &s.Source, &hash); err != nil {
			return nil, fmt.Errorf("snapshot: scan: %w", err)
		}
		s.ConfigHash = hex.EncodeToString(hash)
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("snapshot: rows: %w", err)
	}
	return out, nil
}

// loadSnapshotByID is an internal helper used by the dedup branch.
func (s *Store) loadSnapshotByID(ctx context.Context, id int64) (model.DeviceSnapshot, error) {
	var (
		out       model.DeviceSnapshot
		hash      []byte
		cfgJSON   []byte
		parentID  *int64
		auditID   *int64
		createdBy *uuid.UUID
	)
	err := s.pool.QueryRow(ctx, `
		SELECT id, device_id, taken_at, source, config_hash, config_json,
		       parent_id, audit_log_id, created_by
		FROM device_snapshots
		WHERE id = $1
	`, id).Scan(
		&out.ID, &out.DeviceID, &out.TakenAt, &out.Source,
		&hash, &cfgJSON, &parentID, &auditID, &createdBy,
	)
	if err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: load by id: %w", err)
	}
	if err := json.Unmarshal(cfgJSON, &out.Config); err != nil {
		return model.DeviceSnapshot{}, fmt.Errorf("snapshot: decode config_json: %w", err)
	}
	out.ConfigHash = hex.EncodeToString(hash)
	out.ParentID = parentID
	out.AuditLogID = auditID
	out.CreatedBy = createdBy
	return out, nil
}
