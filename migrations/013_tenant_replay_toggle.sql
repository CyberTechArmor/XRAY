-- Migration 013: Add replay toggles per tenant (defaults off)
-- replay_enabled: controls whether rrweb recording runs for this tenant's users
-- replay_visible: controls whether the tenant can see the Replays tab and recordings

ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS replay_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS replay_visible BOOLEAN NOT NULL DEFAULT false;
