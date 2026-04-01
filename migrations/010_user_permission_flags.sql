-- Add permission flag columns to users table
ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS has_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS has_billing BOOLEAN NOT NULL DEFAULT false;
-- Owners always have both
UPDATE platform.users SET has_admin = true, has_billing = true WHERE is_owner = true;
