-- Migration 002: Connections redesign - add description, details, image, comments

-- Add new columns to connections
ALTER TABLE platform.connections ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE platform.connections ADD COLUMN IF NOT EXISTS connection_details TEXT;
ALTER TABLE platform.connections ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Connection comments
CREATE TABLE IF NOT EXISTS platform.connection_comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id   UUID NOT NULL REFERENCES platform.connections(id) ON DELETE CASCADE,
    author_id       UUID REFERENCES platform.users(id),
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conn_comments_conn ON platform.connection_comments(connection_id, created_at DESC);

-- RLS for connection_comments
ALTER TABLE platform.connection_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_admin_bypass ON platform.connection_comments USING (current_setting('app.is_platform_admin', true)::boolean = true);
