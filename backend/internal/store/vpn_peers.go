package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// VPN peer metadata storage — mirrors vpn_profiles.go from Phase 1
// almost line-for-line, just without the `type` column.

// ListVPNPeersByDevice returns all metadata rows for one device.
// Used by the service layer to join with the VyOS-side peer list.
func (s *Store) ListVPNPeersByDevice(ctx context.Context, deviceID string) ([]model.VPNPeerMetadata, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, device_id::text, name, description, tags,
		       COALESCE(created_by, ''), COALESCE(updated_by, ''),
		       created_at, updated_at
		  FROM vpn_peers
		 WHERE device_id = $1::uuid
		 ORDER BY name`,
		deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.VPNPeerMetadata
	for rows.Next() {
		var m model.VPNPeerMetadata
		var tags []string
		if err := rows.Scan(
			&m.ID, &m.DeviceID, &m.Name, &m.Description, &tags,
			&m.CreatedBy, &m.UpdatedBy, &m.CreatedAt, &m.UpdatedAt,
		); err != nil {
			return nil, err
		}
		if tags == nil {
			tags = []string{}
		}
		m.Tags = tags
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetVPNPeerMetadata fetches one metadata row by UUID. Returns
// ErrNotFound when no row matches — callers use this to distinguish
// "synthesized-UUID, no metadata yet" from "real UUID, fetch the row".
func (s *Store) GetVPNPeerMetadata(ctx context.Context, id string) (model.VPNPeerMetadata, error) {
	var m model.VPNPeerMetadata
	var tags []string
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, device_id::text, name, description, tags,
		       COALESCE(created_by, ''), COALESCE(updated_by, ''),
		       created_at, updated_at
		  FROM vpn_peers
		 WHERE id = $1::uuid`,
		id,
	).Scan(
		&m.ID, &m.DeviceID, &m.Name, &m.Description, &tags,
		&m.CreatedBy, &m.UpdatedBy, &m.CreatedAt, &m.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.VPNPeerMetadata{}, ErrNotFound
	}
	if err != nil {
		return model.VPNPeerMetadata{}, err
	}
	if tags == nil {
		tags = []string{}
	}
	m.Tags = tags
	return m, nil
}

// DeleteVPNPeerMetadata removes a metadata row. Used during orphan
// garbage collection (VyOS peer deleted out-of-band) and after a
// device-level DELETE through the service.
func (s *Store) DeleteVPNPeerMetadata(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM vpn_peers WHERE id = $1::uuid`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteVPNPeerMetadataByDeviceName removes a metadata row by the
// natural key (device_id, name). Used by the service when a peer is
// deleted on VyOS and we need to clean up the metadata row even when
// the synthesized UUID didn't match a real row.
func (s *Store) DeleteVPNPeerMetadataByDeviceName(ctx context.Context, deviceID, name string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM vpn_peers WHERE device_id = $1::uuid AND name = $2`,
		deviceID, name)
	return err
}

// touchVPNPeerMetadata is a small helper to bump updated_at when
// metadata changes through endpoints we haven't built yet (PUT in
// Phase 3B). Defined now so the table contract is complete; unused
// in Phase 3A.
func (s *Store) touchVPNPeerMetadata(ctx context.Context, id string, when time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE vpn_peers SET updated_at = $2 WHERE id = $1::uuid`,
		id, when)
	return err
}
