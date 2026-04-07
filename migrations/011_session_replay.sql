-- Migration 011: Session Replay (rrweb)
-- Tables for recording, storing, and replaying user sessions

BEGIN;

-- Sessions table
CREATE TABLE IF NOT EXISTS platform.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    duration_seconds INTEGER,
    user_agent TEXT,
    viewport_width INTEGER,
    viewport_height INTEGER,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON platform.sessions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON platform.sessions(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON platform.sessions(is_active) WHERE is_active = true;

-- Session segments
CREATE TABLE IF NOT EXISTS platform.session_segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES platform.sessions(id) ON DELETE CASCADE,
    segment_type TEXT NOT NULL CHECK (segment_type IN ('platform', 'dashboard')),
    dashboard_id UUID REFERENCES platform.dashboards(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    duration_seconds INTEGER,
    click_count INTEGER DEFAULT 0,
    page_count INTEGER DEFAULT 0,
    idle_percentage DECIMAL(5,2) DEFAULT 0,
    storage_type TEXT NOT NULL DEFAULT 'postgres' CHECK (storage_type IN ('postgres', 's3')),
    storage_ref TEXT,
    recording_deleted BOOLEAN NOT NULL DEFAULT false,
    is_permanent BOOLEAN NOT NULL DEFAULT false,
    is_training BOOLEAN NOT NULL DEFAULT false,
    shadow_views JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_segments_session ON platform.session_segments(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_segments_dashboard ON platform.session_segments(dashboard_id, started_at DESC) WHERE dashboard_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_segments_training ON platform.session_segments(is_training) WHERE is_training = true;

-- Segment recordings (event data stored in postgres)
CREATE TABLE IF NOT EXISTS platform.segment_recordings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id UUID NOT NULL REFERENCES platform.session_segments(id) ON DELETE CASCADE,
    events BYTEA NOT NULL,  -- gzip compressed rrweb events JSON
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recordings_segment ON platform.segment_recordings(segment_id);

-- Segment tags
CREATE TABLE IF NOT EXISTS platform.segment_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id UUID NOT NULL REFERENCES platform.session_segments(id) ON DELETE CASCADE,
    tag VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES platform.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(segment_id, tag)
);

-- Segment comments
CREATE TABLE IF NOT EXISTS platform.segment_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id UUID NOT NULL REFERENCES platform.session_segments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
    timestamp_seconds INTEGER,  -- nullable, playback position
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comments_segment ON platform.segment_comments(segment_id, created_at);

-- RLS
ALTER TABLE platform.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.session_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.segment_recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.segment_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.segment_comments ENABLE ROW LEVEL SECURITY;

-- Tenant isolation policies
CREATE POLICY tenant_isolation ON platform.sessions USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.session_segments USING (session_id IN (SELECT id FROM platform.sessions WHERE tenant_id = current_setting('app.current_tenant', true)::uuid));
CREATE POLICY tenant_isolation ON platform.segment_recordings USING (segment_id IN (SELECT id FROM platform.session_segments WHERE session_id IN (SELECT id FROM platform.sessions WHERE tenant_id = current_setting('app.current_tenant', true)::uuid)));
CREATE POLICY tenant_isolation ON platform.segment_tags USING (segment_id IN (SELECT id FROM platform.session_segments WHERE session_id IN (SELECT id FROM platform.sessions WHERE tenant_id = current_setting('app.current_tenant', true)::uuid)));
CREATE POLICY tenant_isolation ON platform.segment_comments USING (segment_id IN (SELECT id FROM platform.session_segments WHERE session_id IN (SELECT id FROM platform.sessions WHERE tenant_id = current_setting('app.current_tenant', true)::uuid)));

-- Platform admin bypass
CREATE POLICY platform_admin_bypass ON platform.sessions USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.session_segments USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.segment_recordings USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.segment_tags USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.segment_comments USING (current_setting('app.is_platform_admin', true)::boolean = true);

-- Add replay permissions
INSERT INTO platform.permissions (key, label, category, description)
VALUES
  ('session_replay.view', 'View session replays', 'replay', 'View recorded session replays for assigned dashboards'),
  ('session_replay.manage', 'Manage session replays', 'replay', 'Flag, comment, tag session replays')
ON CONFLICT (key) DO NOTHING;

-- Grant replay permissions to platform admin and owner
INSERT INTO platform.role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM platform.roles r
  CROSS JOIN platform.permissions p
  WHERE r.slug IN ('platform_admin', 'owner')
    AND p.key IN ('session_replay.view', 'session_replay.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
