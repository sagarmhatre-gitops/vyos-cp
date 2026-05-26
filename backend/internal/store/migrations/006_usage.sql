-- Phase 2: bandwidth usage accumulation (ground-truth, counter-based).
-- Additive only — no changes to existing tables.

-- Raw cumulative interface byte counters, snapshotted periodically.
-- These are the device's own odometer readings; usage is derived by diffing
-- consecutive rows (with reset detection). Short retention: rolled-up data
-- lives in usage_rollups, so raw snapshots only need to survive long enough
-- for the rollup job to consume them.
CREATE TABLE IF NOT EXISTS iface_counter_snapshots (
  device_id  TEXT        NOT NULL,
  iface      TEXT        NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  rx_bytes   BIGINT      NOT NULL,
  tx_bytes   BIGINT      NOT NULL,
  PRIMARY KEY (device_id, iface, ts)
);
CREATE INDEX IF NOT EXISTS idx_snap_dev_iface_ts
  ON iface_counter_snapshots (device_id, iface, ts);

-- Accumulated usage per (device, scope, period). scope is 'device' or an
-- interface name. had_reset flags that a counter reset occurred within the
-- period (so the future billing layer can apply its own policy). source records
-- provenance: 'counter' = ground-truth diff; 'integrated' = rate-integration
-- fallback (not used yet, reserved so the schema is source-agnostic).
CREATE TABLE IF NOT EXISTS usage_rollups (
  device_id    TEXT        NOT NULL,
  scope        TEXT        NOT NULL,
  period_type  TEXT        NOT NULL,   -- 'hour' | 'day' | 'month'
  period_start TIMESTAMPTZ NOT NULL,
  rx_bytes     BIGINT      NOT NULL DEFAULT 0,
  tx_bytes     BIGINT      NOT NULL DEFAULT 0,
  had_reset    BOOLEAN     NOT NULL DEFAULT FALSE,
  source       TEXT        NOT NULL DEFAULT 'counter',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, scope, period_type, period_start)
);
CREATE INDEX IF NOT EXISTS idx_rollup_dev_period
  ON usage_rollups (device_id, period_type, period_start DESC);
