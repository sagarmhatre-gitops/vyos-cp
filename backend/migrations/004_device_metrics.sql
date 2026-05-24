-- device_metrics — minute-bucket samples of device-level health metrics.
--
-- Populated by an in-process poller that calls the existing GetDeviceOverview
-- service every 60s per online device. We keep ~30 days of history; the
-- prune pass runs alongside the throughput-history prune.
--
-- Schema is deliberately wide-and-flat (one row per (device, minute)) instead
-- of normalized into a (device, metric_name, value) shape. The wide form is
-- ~3x faster to query for the common "give me the last N hours of all
-- metrics for a device" pattern, and migrations remain cheap because adding
-- a new metric is just ALTER TABLE ADD COLUMN.

CREATE TABLE IF NOT EXISTS device_metrics (
    device_id      UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    bucket         TIMESTAMPTZ NOT NULL,

    cpu_pct        REAL,    -- 1-minute load average reported as a percent
    cpu_pct_5m     REAL,    -- 5-minute average
    cpu_pct_15m    REAL,    -- 15-minute average
    mem_used_mb    INTEGER,
    mem_total_mb   INTEGER,
    sessions       INTEGER,

    PRIMARY KEY (device_id, bucket)
);

-- The dashboard queries by (device, time-range) and the prune job needs
-- bucket-only scans.
CREATE INDEX IF NOT EXISTS device_metrics_bucket_idx ON device_metrics (bucket);
