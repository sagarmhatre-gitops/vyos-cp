-- 008_vpn_profiles.sql — control-plane metadata for VPN profiles.
--
-- Phase 1 of the VPN object model refactor.
--
-- This table stores management metadata (description, tags, ownership,
-- timestamps) for VPN profile objects whose actual configuration lives
-- on the VyOS device. The (device_id, type, name) triple is the join
-- key from this row to the corresponding VyOS object.
--
-- Source-of-truth split:
--   - VyOS device:  "what profiles exist + their crypto parameters"
--   - This table:   "metadata about those profiles"
--
-- A profile can exist on VyOS without a row here (operator created via
-- VyOS CLI directly, or via the existing per-device IPsec page). The
-- fleet read tolerates this and returns the profile with empty metadata;
-- the first edit through the new VPN section creates the row.
--
-- A row here without a corresponding VyOS object is garbage-collected
-- on the next fleet read. Drift detection — surfacing this state as a
-- user-visible signal — is a Phase 2 concern.
--
-- The `type` column is intentionally TEXT with a CHECK constraint rather
-- than a Postgres enum, so Phase 3-5 can extend to 'peer', 'ts',
-- 'tunnel' without altering the column type.

CREATE TABLE IF NOT EXISTS vpn_profiles (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Reference into VyOS-side state. (device_id, type, name) is the
    -- triple that locates the corresponding object on the device.
    device_id    UUID         NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    type         TEXT         NOT NULL CHECK (type IN ('ike', 'esp')),
    name         TEXT         NOT NULL,

    -- Management metadata — never written to VyOS.
    description  TEXT         NOT NULL DEFAULT '',
    tags         TEXT[]       NOT NULL DEFAULT '{}',

    -- Audit trail. Strings (not FKs) so deleting a user does not cascade
    -- into deleting their historical metadata. Matches the convention
    -- used by audit_log.
    created_by   TEXT         NOT NULL DEFAULT '',
    updated_by   TEXT         NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- A device cannot have two profiles of the same type with the same
    -- name. Mirrors VyOS's own constraint.
    UNIQUE (device_id, type, name)
);

CREATE INDEX IF NOT EXISTS vpn_profiles_device_idx ON vpn_profiles (device_id);
CREATE INDEX IF NOT EXISTS vpn_profiles_type_idx   ON vpn_profiles (type);
-- GIN for tag filtering — Phase 2 uses this; cheap to create now so we
-- don't have to re-index after the table has grown.
CREATE INDEX IF NOT EXISTS vpn_profiles_tags_idx   ON vpn_profiles USING GIN (tags);
