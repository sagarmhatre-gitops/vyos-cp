-- Throughput history, one row per device per minute.
-- `per` is per-interface JSONB so we can render a detail chart later.
CREATE TABLE IF NOT EXISTS throughput_samples (
  device_id    UUID         NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts           TIMESTAMPTZ  NOT NULL,
  rx_bps       BIGINT       NOT NULL DEFAULT 0,
  tx_bps       BIGINT       NOT NULL DEFAULT 0,
  rx_pps       BIGINT       NOT NULL DEFAULT 0,
  tx_pps       BIGINT       NOT NULL DEFAULT 0,
  per_iface    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (device_id, ts)
);

-- Range-scan friendly for "last N hours" queries.
CREATE INDEX IF NOT EXISTS idx_throughput_ts ON throughput_samples (ts DESC);

-- For the fleet aggregate query we scan all devices in a window.
CREATE INDEX IF NOT EXISTS idx_throughput_window ON throughput_samples (ts DESC, device_id);
