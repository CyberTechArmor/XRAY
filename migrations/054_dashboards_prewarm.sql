-- Per-dashboard mass-prewarm controls.
--
-- prewarm_enabled
--   When true, the dashboards-list page fans out a parallel
--   POST /api/dashboards/:id/render?prewarm=1 for this dashboard
--   so the server-side render cache is warm by the time the user
--   clicks the tile. Off by default — operators opt in per dashboard
--   on the admin builder.
--
-- prewarm_stale_after_sec
--   Cache freshness override (seconds) used only when prewarm_enabled.
--   NULL means "On Click": the cache is invalidated on every click,
--   so the next click hits upstream fresh — recommended for dashboards
--   that are cheap to refetch and where same-session staleness matters.
--   A positive integer means "serve from cache for at most N seconds
--   since the last upstream fetch, then refetch on the next render".
--   Ignored when prewarm_enabled is false (the global
--   DASHBOARD_RENDER_CACHE_MAX_AGE_SEC env applies in that case).
ALTER TABLE platform.dashboards
  ADD COLUMN IF NOT EXISTS prewarm_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS prewarm_stale_after_sec integer
    CHECK (prewarm_stale_after_sec IS NULL OR prewarm_stale_after_sec >= 0);

COMMENT ON COLUMN platform.dashboards.prewarm_enabled IS
  'Operator opt-in for the dashboards-list mass-prewarm. Off by default.';
COMMENT ON COLUMN platform.dashboards.prewarm_stale_after_sec IS
  'When prewarm_enabled, cache freshness window in seconds. NULL = On Click (bust on every render).';
