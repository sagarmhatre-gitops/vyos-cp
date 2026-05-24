-- 005_device_snapshots.sql
--
-- Ship 1 of the drift-detection / reconciliation track.
--
-- Captures periodic decoded views of each VyOS device's live config so the
-- control plane can later (Ship 2) diff them, (Ship 3) flag drift against the
-- last known-good control-plane write, (Ship 4) reconcile against templates,
-- and (Ship 5) replay history into a git-backed store.
--
-- IMPORTANT: This migration is forward-only. Audit and snapshot rows are
-- append-only by design; do not add UPDATE or DELETE paths in application code.

BEGIN;

-- Source of a snapshot row:
--   control_plane: written immediately after vyos-cp itself committed to the device
--   device:        captured by the fleet poller from /retrieve
--   manual:        captured synchronously via POST /api/v1/devices/{id}/snapshot
CREATE TYPE snapshot_source AS ENUM ('control_plane', 'device', 'manual');

CREATE TABLE device_snapshots (
    id              BIGSERIAL       PRIMARY KEY,
    device_id       UUID            NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    taken_at        TIMESTAMPTZ     NOT NULL DEFAULT now(),
    source          snapshot_source NOT NULL,

    -- sha256 over the canonical JSON form of config_json.
    -- Stored raw (32 bytes) rather than hex-encoded for compactness.
    config_hash     BYTEA           NOT NULL CHECK (octet_length(config_hash) = 32),

    -- Full decoded domain model. JSONB so we can later add expression indexes
    -- on common paths (e.g. firewall.ipv4.name.*) without schema churn.
    config_json     JSONB           NOT NULL,

    -- Optional links to other tables. Wired in now so we never have to
    -- backfill: Ship 3 / Ship 5 will start populating these.
    parent_id       BIGINT          REFERENCES device_snapshots(id) ON DELETE SET NULL,
    audit_log_id    BIGINT          REFERENCES audit_log(id)        ON DELETE SET NULL,
    created_by      UUID            REFERENCES users(id)            ON DELETE SET NULL
);

-- Hot path: "latest snapshot for device X". Used by GET /snapshot
-- and by the dedup check on every insert.
CREATE INDEX idx_snapshots_device_taken
    ON device_snapshots (device_id, taken_at DESC);

-- Ship 3 will run this query: "latest control_plane snapshot for device X".
CREATE INDEX idx_snapshots_device_source_taken
    ON device_snapshots (device_id, source, taken_at DESC);

-- Dedup support: "have we already stored this exact config?"
CREATE INDEX idx_snapshots_device_hash
    ON device_snapshots (device_id, config_hash);

COMMIT;
