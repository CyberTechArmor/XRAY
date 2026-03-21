-- Dashboard comments
CREATE TABLE IF NOT EXISTS platform.dashboard_comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id    UUID NOT NULL REFERENCES platform.dashboards(id) ON DELETE CASCADE,
    author_id       UUID REFERENCES platform.users(id),
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dash_comments_dash ON platform.dashboard_comments(dashboard_id, created_at DESC);

-- Dashboard view tracking (excludes platform admin views)
CREATE TABLE IF NOT EXISTS platform.dashboard_views (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id    UUID NOT NULL REFERENCES platform.dashboards(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES platform.users(id),
    viewed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dash_views_dash ON platform.dashboard_views(dashboard_id);
