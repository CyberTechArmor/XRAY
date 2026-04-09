-- Migration 013: Add replay_enabled toggle per tenant (default off)
-- Platform admins can enable/disable replay recording per tenant.

ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS replay_enabled BOOLEAN NOT NULL DEFAULT false;
