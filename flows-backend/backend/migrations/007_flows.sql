-- Phase 2: conntrack flow history. Stores periodic snapshots of active flows
-- parsed from `show conntrack table ipv4`. Short retention (flows are churny);
-- the poller prunes old rows. Additive — no changes to existing tables.
CREATE TABLE IF NOT EXISTS flow_snapshots (
  device_id     TEXT        NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  conntrack_id  TEXT        NOT NULL,
  protocol      TEXT        NOT NULL,
  state         TEXT        NOT NULL DEFAULT '',
  orig_src_ip   TEXT        NOT NULL,
  orig_src_port TEXT        NOT NULL DEFAULT '',
  orig_dst_ip   TEXT        NOT NULL,
  orig_dst_port TEXT        NOT NULL DEFAULT '',
  reply_src_ip  TEXT        NOT NULL DEFAULT '',
  reply_dst_ip  TEXT        NOT NULL DEFAULT '',
  timeout_sec   INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, ts, conntrack_id)
);
CREATE INDEX IF NOT EXISTS idx_flow_dev_ts ON flow_snapshots (device_id, ts DESC);
