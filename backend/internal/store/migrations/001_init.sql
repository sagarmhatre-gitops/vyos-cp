-- 001_init.sql — vyos-cp initial schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    roles         TEXT[] NOT NULL DEFAULT ARRAY['viewer'],
    disabled      BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                 TEXT NOT NULL UNIQUE,
    address              TEXT NOT NULL,
    api_key_enc          BYTEA NOT NULL,
    insecure_skip_verify BOOLEAN NOT NULL DEFAULT false,
    tags                 TEXT[] NOT NULL DEFAULT '{}',
    group_id             UUID REFERENCES device_groups(id) ON DELETE SET NULL,
    status               TEXT NOT NULL DEFAULT 'unknown',
    version              TEXT,
    hostname             TEXT,
    last_seen            TIMESTAMPTZ,
    last_error           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS devices_group_idx  ON devices(group_id);
CREATE INDEX IF NOT EXISTS devices_status_idx ON devices(status);

CREATE TABLE IF NOT EXISTS rule_set_templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    family      TEXT NOT NULL,
    description TEXT,
    body        JSONB NOT NULL,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGSERIAL PRIMARY KEY,
    ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    user_name  TEXT,
    device_id  UUID,
    device     TEXT,
    action     TEXT NOT NULL,
    ops        JSONB,
    success    BOOLEAN NOT NULL,
    error_msg  TEXT
);

CREATE INDEX IF NOT EXISTS audit_device_ts_idx ON audit_log(device_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_user_ts_idx   ON audit_log(user_id, ts DESC);
