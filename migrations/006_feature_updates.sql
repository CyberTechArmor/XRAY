-- 006_feature_updates.sql
-- Feature updates: file uploads, new plan tiers, dashboard status, inbox tags

BEGIN;

-- 1. Add is_archived and tag to inbox_thread_participants
ALTER TABLE platform.inbox_thread_participants
    ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;

ALTER TABLE platform.inbox_thread_participants
    ADD COLUMN IF NOT EXISTS tag TEXT CHECK (tag IN ('dashboards','connectors','billing','other'));

-- 2. Create file_uploads table
CREATE TABLE IF NOT EXISTS platform.file_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES platform.tenants(id),
    uploaded_by UUID NOT NULL REFERENCES platform.users(id),
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    context_type TEXT NOT NULL CHECK (context_type IN ('connection','inbox','invoice','general')),
    context_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_file_uploads_context
    ON platform.file_uploads(context_type, context_id);

ALTER TABLE platform.file_uploads ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'platform' AND tablename = 'file_uploads' AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON platform.file_uploads
            USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'platform' AND tablename = 'file_uploads' AND policyname = 'platform_admin_bypass'
    ) THEN
        CREATE POLICY platform_admin_bypass ON platform.file_uploads
            USING (current_setting('app.is_platform_admin', true)::boolean = true);
    END IF;
END$$;

-- 3. Update billing_state plan_tier CHECK to include new tiers
ALTER TABLE platform.billing_state DROP CONSTRAINT IF EXISTS billing_state_plan_tier_check;
ALTER TABLE platform.billing_state ADD CONSTRAINT billing_state_plan_tier_check
    CHECK (plan_tier IN ('free','starter','professional','pro5','pro10','e20','e40'));

-- 4. Add 'disabled' to dashboard status CHECK
ALTER TABLE platform.dashboards DROP CONSTRAINT IF EXISTS dashboards_status_check;
ALTER TABLE platform.dashboards ADD CONSTRAINT dashboards_status_check
    CHECK (status IN ('draft','active','archived','disabled'));

-- 5. Add tag column to inbox_threads
ALTER TABLE platform.inbox_threads
    ADD COLUMN IF NOT EXISTS tag TEXT CHECK (tag IN ('dashboards','connectors','billing','other'));

-- 6. connections description/details — already present, no changes needed

COMMIT;
