# `dashboards.view_html / view_css / view_js` reader audit — step 7 (C3)

Migration 026 added `platform.dashboard_render_cache` keyed on
`(dashboard_id, tenant_id)` to hold per-tenant rendered content for
Globals + to serve as the fallback for proxy-fetch failures. The
step-7 kickoff asked whether the legacy `view_html / view_css /
view_js` columns on `platform.dashboards` can now be retired.

**Decision: no — the columns stay. Retirement requires additional
reader migration that is out of scope for step 7 (close-out).**

## Readers that still depend on the columns

| # | Site | Why it reads `view_*` |
|---|---|---|
| 1 | `routes/dashboard.routes.ts` POST `/:id/render` static-content branch | Dashboards with no `fetch_url` store their HTML directly on `platform.dashboards` and serve it as-is. The render cache is populated from upstream-fetch responses only; static dashboards never hit the cache path. Dropping the columns would break every static "custom HTML" dashboard. |
| 2 | `routes/dashboard.routes.ts` POST `/:id/render` fallback branch | When the proxy fetch exhausts, the fallback is `cached?.view_html || (scope='tenant' ? dashboard.view_html : null)`. For Tenant-scoped rows the column is a secondary fallback behind the cache; for first-render failures (cache empty) it's the only fallback. |
| 3 | `services/dashboard.service.ts` `renderPublicDashboard` | Same two branches (static and fallback) on the public-share render path. |
| 4 | `services/dashboard.service.ts` `buildDashboardBundle` | The per-dashboard bundle payload carries `view_html / view_css / view_js` so the app shell can render dashboards without a round-trip to the render route. Dropping the columns would break the bundle loader. |
| 5 | `services/dashboard.service.ts` `getEmbedDashboard` (via `EMBED_PROJECTED_COLUMNS`) | Embed tokens return the render-ready shape, which includes `view_html / view_css / view_js`. |
| 6 | `services/admin.service.ts` `createConnection`-family + admin UPDATE mapper | Admin-authored dashboards carry their HTML payload on the dashboards row. |
| 7 | `services/portability.service.ts` export/import | Round-trips the columns. |

## Writers (also must be kept coherent with any future drop)

| # | Site | Notes |
|---|---|---|
| A | `services/dashboard.service.ts` `createDashboard` | Insert includes `view_html / view_css / view_js`. |
| B | `services/dashboard.service.ts` `updateDashboard` | Allows patching `view_*`. |
| C | `services/admin.service.ts` admin dashboard create/update | Admin UI field mapper. |
| D | `routes/dashboard.routes.ts` POST `/:id/render` post-fetch dual-write | After a successful proxy fetch, `view_html / view_css / view_js` on `platform.dashboards` is updated in parallel with the render-cache row (`scope='tenant'` only). This is the ONLY writer that keeps the legacy columns fresh for Tenant-scoped proxy dashboards. Globals never write the legacy columns (their cache is per-tenant only). |

## What would be required to drop the columns

1. Move the static-HTML payload for no-`fetch_url` dashboards into
   `dashboard_render_cache` (either keyed on `tenant_id` for
   tenant-scoped rows, or a new per-dashboard-only cache row that
   holds the author-written content). Update readers 1 + 3 to read
   from the new location.
2. Make `dashboard_render_cache` the single source of truth for the
   fallback path (reader 2 + 3's fallback branch), which already is
   the first-choice read — just remove the `|| dashboard.view_html`
   fallback once every proxy-fetch dashboard has a cache row.
3. Move the bundle's `view_*` fields into the same new cache location
   so `buildDashboardBundle` (reader 4) reads from there.
4. Decide how `EMBED_PROJECTED_COLUMNS` surfaces render content
   without the columns — likely by JOINing the cache row at the embed
   SELECT rather than projecting from `dashboards`.
5. Backfill: every existing tenant-scoped dashboard with non-NULL
   `view_html` needs a cache row written in the pre-drop migration
   (a one-shot data migration, not a column drop).
6. Portability export/import needs a matching round-trip for the new
   location (pairs naturally with step 7 C4).

This is a multi-session effort — new cache shape, reader migration,
backfill migration, writer migration, portability migration. It
significantly exceeds the "close-out" framing of step 7.

## What step 7 *does* ship as part of C3

- This audit doc.
- **No column drop.** Columns remain.
- **No reader migration.** Readers remain.

Follow-up issue to file post-step-7: "Retire
`dashboards.view_html / view_css / view_js`" with the six-step plan
above as the task list.
