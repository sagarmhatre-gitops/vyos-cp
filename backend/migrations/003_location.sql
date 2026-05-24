-- Add location text field to devices.
--
-- Free-form human-readable site identifier ("New York DC", "Rack 12 - SJC2").
-- Operators set it from the edit-device modal; UI surfaces it in the device
-- header and the future geographic map (where it's used as the popup label).
-- Empty string is the default; nullable would force everywhere to handle NULL.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '';
