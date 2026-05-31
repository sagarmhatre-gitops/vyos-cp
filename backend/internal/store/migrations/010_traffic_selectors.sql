-- 010_traffic_selectors.sql
-- Traffic Selectors — Phase 4 Commit 1
--
-- A Traffic Selector is a named CIDR with management metadata. Unlike
-- IKE/ESP profiles and Peers, a TS has NO VyOS-side counterpart — it
-- lives entirely in this control plane. At push time (Phase 4 Commit 2+)
-- a TS gets inlined into peer tunnel local-subnet/remote-subnet fields
-- (and later into NAT and routing rules).
--
-- Why this exists separately from peer.tunnel:
--   - Operators model real-world subnets as named objects ("marketing",
--     "datacenter-east"), not as inline strings repeated across peers.
--   - Changing a subnet in one place should propagate to every peer
--     that references it (Phase 4 Commit 3).
--   - Tags + descriptions become queryable: "what peers touch the
--     PCI subnet?" gets answered by a join.
--
-- v1 scope (sign-off above):
--   - Device-scoped — TS belongs to one device, matches Phase 1/3A
--   - Single CIDR per TS — promote to text[] if a real multi-CIDR
--     use case appears
--   - IPv4 only — add family column when v6 IPsec lands
--
-- Lifecycle:
--   - Pure Postgres object. No VyOS read needed.
--   - Reference integrity (Phase 4 Commit 2+): TS can't be deleted
--     while peer tunnels reference its name. Enforced in service.
--   - Cascade on device delete: TSs are tied to their device.

CREATE TABLE IF NOT EXISTS traffic_selectors (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id    UUID         NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name         TEXT         NOT NULL,
    cidr         TEXT         NOT NULL,
    description  TEXT         NOT NULL DEFAULT '',
    tags         TEXT[]       NOT NULL DEFAULT '{}',
    created_by   TEXT,
    updated_by   TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (device_id, name)
);

CREATE INDEX IF NOT EXISTS idx_traffic_selectors_device_id ON traffic_selectors (device_id);
CREATE INDEX IF NOT EXISTS idx_traffic_selectors_tags      ON traffic_selectors USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_traffic_selectors_cidr      ON traffic_selectors (cidr);
