package store

// vpn_profiles store — CRUD on the metadata table created by
// migration 008. The schema is described in 008_vpn_profiles.sql.
//
// This file is intentionally narrow: it does not know about VyOS, only
// about the Postgres table. The service layer is responsible for joining
// these rows with VyOS-side state.
//
// Errors use the existing ErrNotFound sentinel for consistency with the
// rest of the store package.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// GetVPNProfileByID looks up a metadata row by its UUID primary key.
// Returns ErrNotFound if no row exists.
func (s *Store) GetVPNProfileByID(ctx context.Context, id string) (*model.VPNProfileMetadata, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT id::text, device_id::text, type, name, description, tags,
		       created_by, updated_by, created_at, updated_at
		FROM vpn_profiles
		WHERE id = $1
	`, id)
	return scanVPNProfile(row)
}

// GetVPNProfileByNatKey looks up by the (device_id, type, name) triple.
// Returns ErrNotFound if no row exists.
func (s *Store) GetVPNProfileByNatKey(ctx context.Context,
	deviceID, ptype, name string) (*model.VPNProfileMetadata, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT id::text, device_id::text, type, name, description, tags,
		       created_by, updated_by, created_at, updated_at
		FROM vpn_profiles
		WHERE device_id = $1 AND type = $2 AND name = $3
	`, deviceID, ptype, name)
	return scanVPNProfile(row)
}

// ListVPNProfilesByDevice returns all metadata rows for one device.
// Used by the fleet endpoint to look up metadata in bulk.
func (s *Store) ListVPNProfilesByDevice(ctx context.Context,
	deviceID string) ([]model.VPNProfileMetadata, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, device_id::text, type, name, description, tags,
		       created_by, updated_by, created_at, updated_at
		FROM vpn_profiles
		WHERE device_id = $1
		ORDER BY type, name
	`, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.VPNProfileMetadata
	for rows.Next() {
		m, err := scanVPNProfile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

// UpsertVPNProfileMetadata inserts or updates a metadata row by the
// (device_id, type, name) natural key.
//
// On insert, if `id` is empty the table's DEFAULT gen_random_uuid()
// assigns one. If `id` is non-empty (e.g. the deterministic synthesized
// UUID for a previously-row-less profile), it's used verbatim so the
// URL stays stable across the lazy row-create transition.
//
// On conflict the description/tags/updated_by/updated_at fields are
// overwritten but id, created_by, created_at are preserved.
func (s *Store) UpsertVPNProfileMetadata(ctx context.Context,
	m model.VPNProfileMetadata) (*model.VPNProfileMetadata, error) {

	now := time.Now().UTC()
	tags := m.Tags
	if tags == nil {
		tags = []string{}
	}

	var (
		id        string
		createdBy string
		createdAt time.Time
	)
	var err error
	if m.ID != "" {
		err = s.pool.QueryRow(ctx, `
			INSERT INTO vpn_profiles
				(id, device_id, type, name, description, tags,
				 created_by, updated_by, created_at, updated_at)
			VALUES ($9, $1, $2, $3, $4, $5, $6, $7, $8, $8)
			ON CONFLICT (device_id, type, name) DO UPDATE
			SET description = EXCLUDED.description,
			    tags        = EXCLUDED.tags,
			    updated_by  = EXCLUDED.updated_by,
			    updated_at  = EXCLUDED.updated_at
			RETURNING id::text, created_by, created_at
		`, m.DeviceID, m.Type, m.Name, m.Description, tags,
			m.CreatedBy, m.UpdatedBy, now, m.ID,
		).Scan(&id, &createdBy, &createdAt)
	} else {
		err = s.pool.QueryRow(ctx, `
			INSERT INTO vpn_profiles
				(device_id, type, name, description, tags,
				 created_by, updated_by, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
			ON CONFLICT (device_id, type, name) DO UPDATE
			SET description = EXCLUDED.description,
			    tags        = EXCLUDED.tags,
			    updated_by  = EXCLUDED.updated_by,
			    updated_at  = EXCLUDED.updated_at
			RETURNING id::text, created_by, created_at
		`, m.DeviceID, m.Type, m.Name, m.Description, tags,
			m.CreatedBy, m.UpdatedBy, now,
		).Scan(&id, &createdBy, &createdAt)
	}
	if err != nil {
		return nil, err
	}
	return &model.VPNProfileMetadata{
		ID: id, DeviceID: m.DeviceID, Type: m.Type, Name: m.Name,
		Description: m.Description, Tags: tags,
		CreatedBy: createdBy, UpdatedBy: m.UpdatedBy,
		CreatedAt: createdAt, UpdatedAt: now,
	}, nil
}

// DeleteVPNProfileMetadata removes a metadata row by UUID. Idempotent —
// no error if the row doesn't exist (the VyOS deletion is the
// authoritative action; metadata cleanup is best-effort).
func (s *Store) DeleteVPNProfileMetadata(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM vpn_profiles WHERE id = $1`, id)
	return err
}

// DeleteVPNProfileMetadataByNatKey is used by the lazy-create path's
// garbage collector when a VyOS-side profile has been deleted out-of-band.
func (s *Store) DeleteVPNProfileMetadataByNatKey(ctx context.Context,
	deviceID, ptype, name string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM vpn_profiles
		WHERE device_id = $1 AND type = $2 AND name = $3
	`, deviceID, ptype, name)
	return err
}

// scanVPNProfile is shared by Get and List paths. Accepts pgx.Row so it
// works with both QueryRow and Query+Rows scanning.
func scanVPNProfile(row pgx.Row) (*model.VPNProfileMetadata, error) {
	var m model.VPNProfileMetadata
	err := row.Scan(&m.ID, &m.DeviceID, &m.Type, &m.Name,
		&m.Description, &m.Tags,
		&m.CreatedBy, &m.UpdatedBy, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if m.Tags == nil {
		m.Tags = []string{}
	}
	return &m, nil
}
