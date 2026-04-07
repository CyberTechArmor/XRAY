-- Migration 012: Add has_replay permission flag to users
-- Similar to has_admin and has_billing, this controls per-user replay access

ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS has_replay BOOLEAN NOT NULL DEFAULT false;

-- Owners get replay access by default
UPDATE platform.users SET has_replay = true WHERE is_owner = true;
