# XRay — Step 11 kickoff

Paste this as the next session's opening prompt (after step 10 ships).

---

## Role

You are implementing step 11 of the XRay platform hardening track.

Where we are: steps 1–7 hardened the platform DB / RLS / embed
projection / portability / branded admin invitations. Step 8
added CI plumbing (Dependabot, secret scanning, gitleaks,
CodeQL, Trivy, lockfile-strict). Step 9 closed the brute-force
+ MFA gaps — TOTP + backup codes alongside passkey, two-tier
rate limiting (100/60s IP+device, 20/24h per email), magic-link
per-link counter, passkey enumeration guard, operator-flippable
`require_mfa_for_platform_admins`. Step 10 closed the auth
surface — CSRF (double-submit token), session rotation on auth
state change, platform-admin impersonation start/stop with a
persistent red banner, magic-link IP/UA fingerprint capture
(enforcement deferred), GDPR Art. 17 account deletion (soft-
delete + cascade-clear), GDPR Art. 20 data export. Six
post-deploy fixes (commits 15–20) hardened the rollout. See
the **Step 9** + **Step 10** + **Roadmap** sections of
`CONTEXT.md`.

Step 11 is **privacy & compliance docs** — the third of three
remaining pre-launch blockers (steps 10, 11, 12). It is a
**Tier-1 hard blocker** per the gating logic in CONTEXT.md's
Roadmap: not having published, accepted, versioned T&C +
privacy policy + cookie banner + DPA + sub-processors is a
contract you can't unsign once a single user signs up.

## Current step

**Step 11 — Privacy & compliance docs.**

Roadmap allocates 10–12 commits. Six concerns, in suggested
landing order:

1. `policy_documents` versioned append-only table.
2. `policy_acceptances` table — per-user-per-version row.
3. Admin-side markdown editor in Admin → Policies (CRUD on
   `policy_documents`).
4. Public read routes — `GET /api/legal/<slug>` + an SPA
   `/legal/<slug>` view that hydrates from it.
5. Re-acceptance modal on version bump — when a logged-in
   user's `policy_acceptances` is older than the current
   `policy_documents` version for any required slug, force a
   modal before they can interact with the app.
6. Cookie banner on the landing page — slim bottom bar,
   "Accept all" / "Essential only" / "Manage", persisted in
   localStorage, also recorded server-side in
   `policy_acceptances` (slug `cookie_policy`).

Slugs to seed (defaults supplied; admin can edit):
`terms_of_service`, `privacy_policy`, `cookie_policy`, `dpa`,
`subprocessors`, `acceptable_use`.

Develop on **`claude/xray-privacy-compliance-<suffix>`** from
the post-step-10 head.

### A. Migrations (foundation — land first, alone)

1. **`migrations/039_policy_documents.sql`** — new
   `platform.policy_documents`:
   ```
   id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   slug         TEXT NOT NULL,        -- terms_of_service, privacy_policy, ...
   version      INT  NOT NULL,        -- monotonically increases per slug
   title        TEXT NOT NULL,
   body_md      TEXT NOT NULL,        -- markdown source of truth
   is_required  BOOLEAN NOT NULL DEFAULT true,  -- gates re-acceptance
   published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   published_by UUID REFERENCES platform.users(id),
   UNIQUE (slug, version)
   ```
   Append-only — never UPDATE in place. Editing a published
   policy mints a new row with `version + 1`. Carve-out
   (no RLS) — every logged-out visitor needs read access via
   `/api/legal/<slug>` for the public legal pages. Index on
   `(slug, version DESC)` so the "latest published version per
   slug" lookup is index-only.

2. **`migrations/040_policy_acceptances.sql`** — new
   `platform.policy_acceptances`:
   ```
   id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   user_id       UUID NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
   tenant_id     UUID NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
   slug          TEXT NOT NULL,
   version       INT  NOT NULL,
   accepted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   ip_hash       TEXT,                 -- sha256(req.ip||JWT_SECRET) — forensic
   ua_hash       TEXT,                 -- same shape as step-10 fingerprint
   UNIQUE (user_id, slug, version)
   ```
   RLS enabled per CLAUDE.md — `tenant_isolation` (user reads
   own tenant's acceptances) + `platform_admin_bypass` (audit
   queries). Index on `(user_id, slug, version DESC)` for the
   "user's latest acceptance per slug" lookup.

3. **`migrations/041_seed_default_policies.sql`** — seed v1 of
   each of the six required slugs with placeholder body_md so
   the operator has something to edit on first deploy. Use
   ON CONFLICT DO NOTHING so re-runs preserve admin edits.
   Bodies are short ("This document is a placeholder. The
   operator should publish v2 with the actual policy text
   before opening signups.") so the operator can't ship the
   placeholder by accident — the public page surfaces the
   placeholder warning prominently.

4. **`migrations/042_cookie_consent_setting.sql`** — seed
   `platform_settings`:
   ```
   INSERT INTO platform.platform_settings (key, value, is_secret)
   VALUES ('cookie_banner_enabled', 'true', false),
          ('cookie_banner_essential_only_default', 'false', false)
   ON CONFLICT (key) DO NOTHING;
   ```
   Operator can flip `cookie_banner_enabled` to `'false'` to
   suppress the landing-page banner (e.g., behind their own
   custom GTM-based consent layer). Default on so the legal
   posture is correct out of the box.

### B. Service layer

5. **`services/policy.service.ts`** (new). Surface:
   - `listLatest(): { slug, version, title, published_at }[]`
     — one row per slug, latest version. Public read for the
     legal-index page + the re-acceptance check.
   - `getLatest(slug)`: `{ slug, version, title, body_md,
     published_at, is_required } | null`. Public read for
     `/api/legal/<slug>`.
   - `publishVersion(slug, { title, body_md, is_required },
     publishedByUserId)`: appends a new row with
     `version = max(version) + 1 for slug`. Throws on missing
     slug? No — admin can introduce a new slug; we don't gate
     on a slug enum.
   - `recordAcceptance(userId, tenantId, slug, version, req)`:
     INSERTs into `policy_acceptances` with hashed IP+UA.
     Idempotent on the (user_id, slug, version) UNIQUE.
   - `pendingForUser(userId, tenantId)`: returns
     `[{ slug, current_version, accepted_version | null }]`
     for every required slug where the user's latest
     acceptance is older than the current published version.
     Empty array means the user is up to date.

   `publishVersion` runs under `withAdminClient` (cross-tenant
   admin write); `recordAcceptance` runs under
   `withTenantContext`; the read paths run under plain
   `withClient` since `policy_documents` is the no-RLS
   carve-out.

   **Add `policy.service.ts` to the `withClient` allow-list**
   in `scripts/check-withclient-allowlist.sh` — first allow-list
   addition since step 7. Document the carve-out reason in the
   header comment (matches the `magic_links` /
   `platform_settings` shape: pre-tenant public-read path).

### C. Routes

6. **`routes/legal.routes.ts`** (new), mounted at `/api/legal`:
   - `GET /api/legal` — list of slugs + latest version + title
     for the public legal index page.
   - `GET /api/legal/:slug` — full latest version of a slug.
     Returns 404 with `LEGAL_SLUG_NOT_FOUND` if the slug has
     no published versions.
   - `GET /api/legal/:slug/v/:version` — historical fetch for
     the "this version was accepted on YYYY-MM-DD" link in
     the user's profile.
   - **No CSRF** (GET-only) and **no auth** (public surface).
     Add `/api/legal` to the CSRF skip-list pattern alongside
     `/api/embed/*`, `/api/share/*`, `/api/health`.

7. **`routes/admin.routes.ts` — Policies CRUD** (extend
   existing file, mount under the existing
   `requirePermission('platform.admin')` gate):
   - `GET /api/admin/policies` — list every slug + every
     version + acceptance counts (via JOIN on
     `policy_acceptances`).
   - `POST /api/admin/policies/:slug` — body `{ title,
     body_md, is_required }` → `policy.service.publishVersion`.
   - `GET /api/admin/policies/:slug/acceptances` — paginated
     list of acceptors for the latest version (audit trail).

8. **`routes/user.routes.ts` — acceptance endpoints**:
   - `GET /api/users/me/policy-status` — returns the
     `pendingForUser` array. Frontend re-acceptance modal
     polls this on app boot + on every successful refresh.
   - `POST /api/users/me/policy-accept` — body `{ slug,
     version }` → `recordAcceptance`. Returns the new
     pending list (so a single round-trip clears any
     remaining acceptances batched in the modal).

### D. Frontend

9. **Public legal pages** — new `/legal/<slug>` SPA route.
   The SPA shell already serves `index.html` for any non-API
   path (see `index.ts` SPA fallback). Add a frontend handler
   in `app.js` that reads `location.pathname`, fetches
   `/api/legal/<slug>` via plain `fetch` (public — no auth
   header), and renders the markdown via `marked` (or
   equivalent). Add `marked` to frontend deps if not present.

   **Hard requirement**: the legal pages render even when the
   user is logged-out, so they cannot live behind the auth
   modal. The SPA's existing landing-screen logic shows the
   landing page on `/` for unauthenticated users; the legal
   handler short-circuits that for `/legal/*` paths.

10. **Re-acceptance modal** — `frontend/app.js` adds a
    `checkPolicyStatus()` call right after `enterApp()` reads
    `/api/users/me`. If `pendingForUser` returns a non-empty
    array, render a blocking modal listing every pending slug
    with a checkbox + a link to the public `/legal/<slug>`
    page. "I accept" enabled only when every checkbox is
    checked → POST `policy-accept` for each → close modal +
    proceed.

    Modal uses the existing modal CSS surface (matches the
    auth modal shape).

11. **Cookie banner on the landing page** —
    `frontend/landing.js` + `landing.css`:
    - Slim bottom bar appears on first landing-page visit
      (no `xray_cookie_consent` localStorage key).
    - Three buttons: "Accept all" / "Essential only" /
      "Manage". The third opens a small inline panel listing
      cookie categories (essential, analytics, marketing) with
      per-category toggles.
    - On any choice, write `xray_cookie_consent =
      { version: <slug-version>, choices: {...},
      decided_at: ISO8601 }` to localStorage AND POST
      `/api/users/me/policy-accept` with `slug:
      'cookie_policy'` if the user is signed in (no-op
      otherwise). Logged-out visits store locally only — the
      acceptance lands later when they sign up.
    - Banner hidden when `cookie_banner_enabled === 'false'`
      in platform settings (fetched once on page load via the
      existing public-config endpoint, OR a new `/api/legal`
      GET that includes the flag in its response).

12. **Account → Privacy card** — extend the step-10 card to
    list the user's accepted policy versions with a link to
    each archived version. "View history" link opens a modal
    showing every `(slug, version, accepted_at)` row from
    `policy_acceptances` for the user.

### E. Acceptance + handoff

13. **Tests** —
    - `services/policy.service.test.ts` (new) — fake-pool
      round-trip: publish v1 → record acceptance →
      `pendingForUser` empty; publish v2 → `pendingForUser`
      lists the slug; re-record → empty.
    - `middleware/csrf.test.ts` extension — `/api/legal/*`
      is on the GET-bypass / public-surface skip set; POST to
      `/api/users/me/policy-accept` requires CSRF.

14. **CONTEXT.md handoff** — append "Step 11 — Privacy &
    compliance docs (shipped)". Roadmap row 11 → "shipped".

## Working rhythm

- One concern per commit. Migrations alone first.
- `npm ci && npm run typecheck && npm test` after each commit
  — local typecheck without `npm ci` silently degrades (the
  step-10 commit-15 lesson).
- Smoke-test the cookie banner + re-acceptance modal in a real
  browser before declaring green. Markdown rendering is the
  fragile bit — verify a few real-world policy templates
  (long lists, links, headings) round-trip correctly.
- Develop on `claude/xray-privacy-compliance-<suffix>` from
  the post-step-10 head.

## Acceptance

- Public `/legal/terms_of_service` (and the other 5 slugs)
  loads without auth, renders the markdown, and shows a
  prominent placeholder warning when the operator hasn't
  published past v1.
- Admin → Policies edits a slug → version increments →
  every signed-in user is presented with the re-acceptance
  modal on their next page load.
- Cookie banner shows on first landing visit, persists choice
  in localStorage + (when authenticated) records the
  acceptance row server-side.
- New signup flow funnels through the cookie banner +
  acceptance step → `policy_acceptances` shows v1 of every
  required slug for the new user.
- Account → Privacy card lists the user's acceptance history
  with archived-version links.
- `npm run typecheck` clean; `npm test` green including the
  new `policy.service.test.ts`.
- `withClient` allow-list grows by one entry
  (`services/policy.service.ts`); the pre-commit guard passes.

## What step 11 must NOT do

- **No further auth-surface work** — step 10 closed it.
- **No pipeline DB changes / backups** — step 12.
- **No restoration of step-10's IP/UA-hash gates.** Behind
  `auth_rate_limit_enabled` is a separate follow-up commit
  pair (see CONTEXT.md's "Follow-up backlog (post-step-10)").
- **No tenant ownership-transfer UI.** Same follow-up bucket.
- **No new MFA work** — step 9.
- **No `withClient` allow-list changes beyond
  `policy.service.ts`.** Every other new code path uses
  `withTenantContext` / `withTenantTransaction` /
  `withAdminClient` per CLAUDE.md.

## Open decisions — wait for operator approval

1. **Cookie banner shape** — slim bottom bar (recommended;
   non-intrusive, GDPR-compliant when the "Manage" panel
   surfaces granular toggles) vs. intrusive modal (better
   acceptance rate but worse UX) vs. settings-page link (does
   not satisfy "explicit consent before non-essential
   cookies"). Bottom-bar assumed throughout.

2. **Markdown rendering library** — `marked` (recommended;
   small, no dependencies, ships an XSS-safe `sanitize`
   option) vs. `markdown-it` (more configurable, larger) vs.
   server-side render-to-HTML (eliminates client-side parser
   surface but ties policy edits to a deploy cycle). `marked`
   client-side assumed throughout.

3. **Acceptance tracking shape** — per-user-per-version row
   in `policy_acceptances` (recommended; full audit trail,
   clean re-acceptance check) vs. JSONB `accepted_policies`
   on the `users` row (denser but loses per-acceptance
   metadata like ip_hash + ua_hash). Per-row table assumed
   throughout.

4. **Default seed for v1 of each slug** — placeholder body
   that prominently warns "operator must publish v2 before
   opening signups" (recommended; legally safer than shipping
   a real but unreviewed template) vs. a starter template
   based on a public template (e.g. termsofservicegenerator
   output) (faster to deploy but creates legal exposure if
   the operator forgets to review). Placeholder assumed.

5. **Required vs. optional slugs** — the migration treats
   every seeded slug as `is_required = true` (recommended;
   gates re-acceptance on every version bump). Operator can
   later flip a specific slug (e.g., `subprocessors`) to
   `is_required = false` so it's published but doesn't
   trigger the re-acceptance modal. Confirm before shipping.

Wait for operator approval on points 1–5 before pushing the
first commit.

## After step 11 — production-ready?

**Almost.** Step 11 closes the privacy-compliance gap. Still
required:

- **Step 12** — pipeline DB Model D + automated backups +
  tested restore drill + `PROBE_RLS=1` in CI.

After **step 12** the system meets the production-readiness
gate described in CONTEXT.md's Roadmap. Step 11 is three of
four pre-launch steps closed (8, 9, 10 shipped + 11 will
ship; 12 remaining).

## First action

Read this kickoff + CONTEXT.md's **Step 9** + **Step 10** +
**Roadmap** sections + `.claude/withclient-audit.md`. Confirm
operator preferences on the five open decisions above before
pushing the first commit.

