-- 009_vpn_peers.sql
-- VPN Peers — Phase 3A
--
-- Mirrors vpn_profiles (008): a Postgres metadata table that joins to
-- VyOS-side peer objects at read time. The actual peer config (remote
-- address, auth, tunnels, profile refs) lives on the device. We only
-- store control-plane metadata here: description, tags, owner, audit
-- timestamps.
--
-- Lifecycle (same semantics as vpn_profiles):
--   - VyOS is the source of truth for *existence*. A peer is "real"
--     when the device has it.
--   - Postgres is the source of truth for *metadata*. Description,
--     tags, owner, audit fields live only here.
--   - UUIDs are synthesized via uuid.NewSHA1(NAMESPACE, device_id+name)
--     for VyOS-only peers with no Postgres row, so URLs are stable.
--   - Orphan Postgres rows (peers deleted on the device but still in
--     this table) are GC'd on the next fleet read.
--   - DELETE goes VyOS-first, then Postgres. Reference integrity to
--     Tunnel objects (Phase 5) will gate this; for now any peer can
--     be deleted.

CREATE TABLE IF NOT EXISTS vpn_peers (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id    UUID         NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name         TEXT         NOT NULL,
    description  TEXT         NOT NULL DEFAULT '',
    tags         TEXT[]       NOT NULL DEFAULT '{}',
    created_by   TEXT,
    updated_by   TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (device_id, name)
);

CREATE INDEX IF NOT EXISTS idx_vpn_peers_device_id ON vpn_peers (device_id);
CREATE INDEX IF NOT EXISTS idx_vpn_peers_tags      ON vpn_peers USING GIN (tags);
