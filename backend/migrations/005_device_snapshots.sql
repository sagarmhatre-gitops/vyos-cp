-- 005_device_snapshots.sql — Ship 1, idempotent.
--
-- store.go re-executes every migration on every startup (no
-- schema_migrations table). This file MUST be safe to run repeatedly.

DO $$ BEGIN
    CREATE TYPE snapshot_source AS ENUM ('control_plane', 'device', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS device_snapshots (
    id              BIGSERIAL       PRIMARY KEY,
    device_id       UUID            NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    taken_at        TIMESTAMPTZ     NOT NULL DEFAULT now(),
    source          snapshot_source NOT NULL,
    config_hash     BYTEA           NOT NULL CHECK (octet_length(config_hash) = 32),
    config_json     JSONB           NOT NULL,
    parent_id       BIGINT          REFERENCES device_snapshots(id) ON DELETE SET NULL,
    audit_log_id    BIGINT          REFERENCES audit_log(id)        ON DELETE SET NULL,
    created_by      UUID            REFERENCES users(id)            ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_device_taken
    ON device_snapshots (device_id, taken_at DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_device_source_taken
    ON device_snapshots (device_id, source, taken_at DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_device_hash
    ON device_snapshots (device_id, config_hash);
