-- Migration: add simulation_sessions table for storing simulation history
-- Applied by the embedded migration runner on first boot (or upgrade).

CREATE TABLE IF NOT EXISTS simulation_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ruleset     TEXT NOT NULL,
    packet_json JSONB NOT NULL,
    result_json JSONB NOT NULL,
    actor       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS simulation_sessions_device_id
    ON simulation_sessions(device_id, created_at DESC);

COMMENT ON TABLE simulation_sessions IS
    'Stores packet simulation runs for audit and replay. Immutable.';
