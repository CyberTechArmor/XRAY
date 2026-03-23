-- Migration 008: Convert webhooks table from inbound to outbound model
-- Adds target_url column, removes connection_id/url_token if they exist

-- Add target_url column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'platform' AND table_name = 'webhooks' AND column_name = 'target_url'
  ) THEN
    ALTER TABLE platform.webhooks ADD COLUMN target_url TEXT NOT NULL DEFAULT '';
  END IF;
END $$;

-- Add secret column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'platform' AND table_name = 'webhooks' AND column_name = 'secret'
  ) THEN
    ALTER TABLE platform.webhooks ADD COLUMN secret TEXT;
  END IF;
END $$;

-- Add failure_count column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'platform' AND table_name = 'webhooks' AND column_name = 'failure_count'
  ) THEN
    ALTER TABLE platform.webhooks ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Add last_triggered_at column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'platform' AND table_name = 'webhooks' AND column_name = 'last_triggered_at'
  ) THEN
    ALTER TABLE platform.webhooks ADD COLUMN last_triggered_at TIMESTAMPTZ;
  END IF;
END $$;

-- Drop old inbound columns if they exist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'platform' AND table_name = 'webhooks' AND column_name = 'connection_id'
  ) THEN
    ALTER TABLE platform.webhooks DROP COLUMN connection_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'platform' AND table_name = 'webhooks' AND column_name = 'url_token'
  ) THEN
    ALTER TABLE platform.webhooks DROP COLUMN url_token;
  END IF;
END $$;

-- Ensure support_calls table exists (for WebSocket feature)
CREATE TABLE IF NOT EXISTS platform.support_calls (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_code   TEXT NOT NULL,
    join_url    TEXT NOT NULL,
    caller_id   UUID NOT NULL REFERENCES platform.users(id),
    tenant_id   UUID NOT NULL REFERENCES platform.tenants(id),
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','missed','expired')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    answered_at TIMESTAMPTZ,
    expired_at  TIMESTAMPTZ
);
