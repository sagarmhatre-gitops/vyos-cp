// Package store is the pgx-backed persistence layer for vyos-cp.
package store

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vyos-cp/vyos-cp/internal/crypto"
	"github.com/vyos-cp/vyos-cp/internal/model"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

var ErrNotFound = errors.New("not found")

type Store struct {
	pool   *pgxpool.Pool
	sealer *crypto.Sealer
}

func Open(ctx context.Context, dsn string, sealer *crypto.Sealer) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("dsn: %w", err)
	}
	cfg.MaxConns = 20
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, err
	}
	s := &Store{pool: pool, sealer: sealer}
	if err := s.migrate(ctx); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) migrate(ctx context.Context) error {
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	for _, e := range entries {
		body, err := migrationsFS.ReadFile("migrations/" + e.Name())
		if err != nil {
			return err
		}
		if _, err := s.pool.Exec(ctx, string(body)); err != nil {
			return fmt.Errorf("%s: %w", e.Name(), err)
		}
	}
	return nil
}

// --- Devices ---------------------------------------------------------------

func (s *Store) CreateDevice(ctx context.Context, d model.Device, apiKey string) (*model.Device, error) {
	enc, err := s.sealer.Seal(apiKey)
	if err != nil {
		return nil, err
	}
	var gid *string
	if d.GroupID != "" {
		gid = &d.GroupID
	}
	row := s.pool.QueryRow(ctx, `
		INSERT INTO devices (name, address, api_key_enc, insecure_skip_verify, tags, group_id, location)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
	`, d.Name, d.Address, enc, d.InsecureSkipVerify, d.Tags, gid, d.Location)
	if err := row.Scan(&d.ID); err != nil {
		return nil, err
	}
	return &d, nil
}

func (s *Store) GetDevice(ctx context.Context, id string) (*model.Device, error) {
	d, _, err := s.GetDeviceWithKey(ctx, id)
	return d, err
}

func (s *Store) GetDeviceWithKey(ctx context.Context, id string) (*model.Device, string, error) {
	var d model.Device
	var enc []byte
	var groupID *string
	var hostname, version, lastErr *string
	var lastSeen *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, name, address, api_key_enc, insecure_skip_verify,
		       COALESCE(tags,'{}'), group_id::text, status, hostname, version,
		       last_seen, last_error, COALESCE(location,'')
		FROM devices WHERE id=$1
	`, id).Scan(&d.ID, &d.Name, &d.Address, &enc, &d.InsecureSkipVerify,
		&d.Tags, &groupID, &d.Status, &hostname, &version, &lastSeen, &lastErr, &d.Location)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	if groupID != nil {
		d.GroupID = *groupID
	}
	if hostname != nil {
		d.Hostname = *hostname
	}
	if version != nil {
		d.Version = *version
	}
	if lastSeen != nil {
		d.LastSeen = *lastSeen
	}
	if lastErr != nil {
		d.LastError = *lastErr
	}
	key, err := s.sealer.Open(enc)
	if err != nil {
		return nil, "", err
	}
	return &d, key, nil
}

func (s *Store) ListDevices(ctx context.Context) ([]model.Device, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, name, address, COALESCE(tags,'{}'), status,
		       COALESCE(hostname,''), COALESCE(version,''),
		       last_seen, COALESCE(last_error,''), insecure_skip_verify,
		       COALESCE(location,'')
		FROM devices ORDER BY name
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Device
	for rows.Next() {
		var d model.Device
		var lastSeen *time.Time
		if err := rows.Scan(&d.ID, &d.Name, &d.Address, &d.Tags, &d.Status,
			&d.Hostname, &d.Version, &lastSeen, &d.LastError, &d.InsecureSkipVerify,
			&d.Location); err != nil {
			return nil, err
		}
		if lastSeen != nil {
			d.LastSeen = *lastSeen
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) DeleteDevice(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM devices WHERE id=$1`, id)
	return err
}

func (s *Store) UpdateDeviceStatus(ctx context.Context, id, status, version, hostname, lastErr string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE devices
		SET status=$2,
		    version=NULLIF($3,''),
		    hostname=NULLIF($4,''),
		    last_error=NULLIF($5,''),
		    last_seen=now(),
		    updated_at=now()
		WHERE id=$1
	`, id, status, version, hostname, lastErr)
	return err
}

// --- Audit -----------------------------------------------------------------

func (s *Store) RecordAudit(ctx context.Context, e model.AuditEntry) error {
	opsJSON, _ := json.Marshal(e.Ops)
	var userID, deviceID *string
	if e.UserID != "" {
		userID = &e.UserID
	}
	if e.DeviceID != "" {
		deviceID = &e.DeviceID
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO audit_log (user_id, user_name, device_id, device, action, ops, success, error_msg)
		VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''))
	`, userID, e.UserName, deviceID, e.Device, e.Action, opsJSON, e.Success, e.ErrorMsg)
	return err
}

func (s *Store) ListAudit(ctx context.Context, deviceID string, limit int) ([]model.AuditEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, ts,
		       COALESCE(user_id::text,''), COALESCE(user_name,''),
		       COALESCE(device_id::text,''), COALESCE(device,''),
		       action, COALESCE(ops::text,'[]'), success, COALESCE(error_msg,'')
		FROM audit_log
		WHERE $1='' OR device_id::text=$1
		ORDER BY id DESC LIMIT $2
	`, deviceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.AuditEntry
	for rows.Next() {
		var e model.AuditEntry
		var opsJSON string
		if err := rows.Scan(&e.ID, &e.Timestamp, &e.UserID, &e.UserName,
			&e.DeviceID, &e.Device, &e.Action, &opsJSON, &e.Success, &e.ErrorMsg); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(opsJSON), &e.Ops)
		out = append(out, e)
	}
	return out, rows.Err()
}

// --- Templates -------------------------------------------------------------

func (s *Store) SaveTemplate(ctx context.Context, name string, rs model.RuleSet, userID string) error {
	body, _ := json.Marshal(rs)
	var uid *string
	if userID != "" {
		uid = &userID
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO rule_set_templates (name, family, description, body, created_by)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (name) DO UPDATE
		  SET family=EXCLUDED.family, description=EXCLUDED.description,
		      body=EXCLUDED.body, updated_at=now()
	`, name, rs.Family, rs.Description, body, uid)
	return err
}

func (s *Store) ListTemplates(ctx context.Context) ([]model.RuleSet, error) {
	rows, err := s.pool.Query(ctx, `SELECT name, body FROM rule_set_templates ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.RuleSet
	for rows.Next() {
		var name string
		var body []byte
		if err := rows.Scan(&name, &body); err != nil {
			return nil, err
		}
		var rs model.RuleSet
		if err := json.Unmarshal(body, &rs); err != nil {
			continue
		}
		out = append(out, rs)
	}
	return out, rows.Err()
}

func (s *Store) GetTemplate(ctx context.Context, name string) (*model.RuleSet, error) {
	var body []byte
	err := s.pool.QueryRow(ctx, `SELECT body FROM rule_set_templates WHERE name=$1`, name).Scan(&body)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var rs model.RuleSet
	if err := json.Unmarshal(body, &rs); err != nil {
		return nil, err
	}
	return &rs, nil
}

// --- Users -----------------------------------------------------------------

func (s *Store) CreateUser(ctx context.Context, u model.User, passwordHash string) (*model.User, error) {
	u.ID = uuid.NewString()
	u.CreatedAt = time.Now()
	roles := make([]string, len(u.Roles))
	for i, r := range u.Roles {
		roles[i] = string(r)
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO users (id, email, display_name, password_hash, roles)
		VALUES ($1,$2,$3,$4,$5)
	`, u.ID, u.Email, u.DisplayName, passwordHash, roles)
	return &u, err
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*model.User, string, error) {
	var u model.User
	var pw string
	var roles []string
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, email, display_name, password_hash, roles, disabled, created_at
		FROM users WHERE email=$1
	`, email).Scan(&u.ID, &u.Email, &u.DisplayName, &pw, &roles, &u.Disabled, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	u.Roles = make([]model.Role, len(roles))
	for i, r := range roles {
		u.Roles[i] = model.Role(r)
	}
	return &u, pw, nil
}

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

// UpdateDeviceTags replaces the tags array for a device. Used by the
// production-marker toggle in the UI.
func (s *Store) UpdateDeviceTags(ctx context.Context, id string, tags []string) error {
	if tags == nil {
		tags = []string{}
	}
	_, err := s.pool.Exec(ctx, `UPDATE devices SET tags = $2, updated_at = NOW() WHERE id = $1`, id, tags)
	return err
}

// UpdateDevice persists mutable device fields. Name and ID are immutable.
// If apiKey is non-empty, it's sealed and replaces the stored ciphertext;
// blank keeps the existing value.
func (s *Store) UpdateDevice(ctx context.Context, d model.Device, apiKey string) error {
	if apiKey != "" {
		enc, err := s.sealer.Seal(apiKey)
		if err != nil {
			return err
		}
		_, err = s.pool.Exec(ctx, `
			UPDATE devices SET
				name = $2, address = $3, hostname = $4, api_key_enc = $5,
				insecure_skip_verify = $6, tags = $7, location = $8,
				updated_at = NOW()
			WHERE id = $1
		`, d.ID, d.Name, d.Address, d.Hostname, enc, d.InsecureSkipVerify, d.Tags, d.Location)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE devices SET
			name = $2, address = $3, hostname = $4,
			insecure_skip_verify = $5, tags = $6, location = $7,
			updated_at = NOW()
		WHERE id = $1
	`, d.ID, d.Name, d.Address, d.Hostname, d.InsecureSkipVerify, d.Tags, d.Location)
	return err
}

// ListUsers returns all cp users. Password hashes are NEVER returned.
func (s *Store) ListUsers(ctx context.Context) ([]model.User, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, email, display_name, roles, disabled, created_at
		FROM users ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.User
	for rows.Next() {
		var u model.User
		var roles []string
		if err := rows.Scan(&u.ID, &u.Email, &u.DisplayName, &roles, &u.Disabled, &u.CreatedAt); err != nil {
			return nil, err
		}
		u.Roles = make([]model.Role, len(roles))
		for i, r := range roles {
			u.Roles[i] = model.Role(r)
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// UpdateUser modifies mutable fields (display_name, roles, optionally password).
func (s *Store) UpdateUser(ctx context.Context, id, displayName string, roles []string, newPasswordHash string) error {
	if newPasswordHash != "" {
		_, err := s.pool.Exec(ctx, `
			UPDATE users SET display_name = $2, roles = $3, password_hash = $4 WHERE id = $1
		`, id, displayName, roles, newPasswordHash)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE users SET display_name = $2, roles = $3 WHERE id = $1
	`, id, displayName, roles)
	return err
}

// DeleteUser removes a user. Caller must guard against deleting the last
// admin or the currently-authenticated user.
func (s *Store) DeleteUser(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id)
	return err
}

// CountAdmins returns the number of users with the "admin" role. Used to
// prevent demotion/deletion of the last admin.
func (s *Store) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM users WHERE 'admin' = ANY(roles)`).Scan(&n)
	return n, err
}

// DeleteTemplate removes a named rule-set template.
func (s *Store) DeleteTemplate(ctx context.Context, name string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM rule_set_templates WHERE name = $1`, name)
	return err
}
