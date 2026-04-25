# XRay — Step 10 kickoff

Paste this as the next session's opening prompt (after step 9 ships).

---

## Role

You are implementing step 10 of the XRay platform hardening track.

Where we are: steps 1-7 hardened the platform DB / RLS / embed
projection / portability / branded admin invitations. Step 8 added
CI plumbing (Dependabot, secret scanning, gitleaks, CodeQL, Trivy,
lockfile-strict). Step 9 closed the brute-force + MFA gaps — TOTP +
backup codes alongside passkey, two-tier rate limiting (100/60s
IP+device, 20/24h per email), magic-link per-link counter, passkey
enumeration guard, operator-flippable
`require_mfa_for_platform_admins`. See the **Step 7** + **Step 8** +
**Step 9** sections of `CONTEXT.md` and the **Roadmap** section at
the end.

Step 10 is **auth surface area cleanup** — the second of three
remaining pre-launch blockers (steps 10, 11, 12). It is a **Tier-2
STRONG-but-not-hard pre-launch blocker** per the gating logic in
CONTEXT.md's Roadmap: deferring it doesn't violate a contract, but
the exposure window from signup → ship-date is the cost. It must
ship before signups open.

## Current step

**Step 10 — Auth surface area cleanup.**

Roadmap allocates 10-13 commits. Six concerns, in suggested
landing order:

1. CSRF (double-submit token) middleware.
2. Session rotation on auth state change (login, MFA-verify,
   impersonation start, impersonation stop).
3. Impersonation start/stop UI + persistent banner.
4. Magic-link IP/UA binding.
5. Account-deletion cascade endpoint.
6. GDPR Art. 20 data-export endpoint.

Develop on **`claude/xray-csrf-impersonation-<suffix>`** from the
post-step-9 head (current branch
`claude/xray-hardening-step-10-4RQgy` already exists from the
session bootstrap and can be reused).

### A. Migrations (foundation — land first, alone)

1. **`migrations/036_user_sessions_impersonator.sql`** — extend
   `platform.user_sessions`:
   ```
   ALTER TABLE platform.user_sessions
     ADD COLUMN impersonator_user_id UUID
       REFERENCES platform.users(id) ON DELETE SET NULL;
   CREATE INDEX idx_user_sessions_impersonator
     ON platform.user_sessions(impersonator_user_id)
     WHERE impersonator_user_id IS NOT NULL;
   ```
   Audit metadata only — RLS already enabled on the table
   (init.sql:410), policies untouched. NULL on every existing
   row + every non-impersonated session.

2. **`migrations/037_magic_link_fingerprint.sql`** — extend
   `platform.magic_links`:
   ```
   ALTER TABLE platform.magic_links
     ADD COLUMN issuer_ip_hash TEXT,
     ADD COLUMN issuer_ua_hash TEXT;
   ```
   Both NULL-able so existing in-flight links keep working
   through the deploy window. New issuance always populates;
   consumption only enforces the match when both columns are
   non-NULL on the row (skip-on-NULL is the upgrade-safe
   posture). Carve-out table — no RLS, no policy change.

3. **`migrations/038_csrf_secret_setting.sql`** — seed
   `platform_settings`:
   ```
   INSERT INTO platform.platform_settings (key, value, is_secret)
   VALUES ('csrf_signing_secret', encode(gen_random_bytes(32), 'hex'), true)
   ON CONFLICT (key) DO NOTHING;
   ```
   Used to HMAC the CSRF cookie payload so a forged cookie can't
   be paired with an attacker-chosen header value. Reusing
   `JWT_SECRET` would work but a dedicated key keeps the rotation
   blast radius scoped — operator can rotate CSRF without
   invalidating outstanding sessions. Auto-seeded on first boot.

### B. CSRF middleware (double-submit token)

4. **`middleware/csrf.ts`** (new). Mints a CSRF cookie + matching
   `X-CSRF-Token` header on every authenticated request. Shape:
   - **Issue**: on response from any path that sets the
     `refresh_token` cookie (login, refresh, signup, invite-accept,
     impersonate start/stop), set a sibling `xsrf_token` cookie
     containing `<random>.<hmac(random, csrf_signing_secret)>`.
     Path `/`, `SameSite=Lax`, `Secure` in production, **NOT**
     HttpOnly (the SPA must read it to mirror into the header).
   - **Verify**: on every state-changing method (POST/PUT/PATCH/
     DELETE) reaching a route that authenticated via the
     cookie-paired access token, require `req.headers['x-csrf-token']
     === req.cookies['xsrf_token']` AND HMAC verify. Mismatch /
     missing → `403 CSRF_INVALID`.
   - **Skip list**:
     - `Authorization: Bearer xray_*` (API keys — header-auth,
       not cookie-auth).
     - `/api/embed/*`, `/api/share/*` (public token surfaces).
     - `/api/health`.
     - Webhook ingest paths (`/api/webhooks/*`, anywhere a route
       does sender-signature verification — to be discovered + a
       skip predicate added per route, not a blanket prefix skip).
     - GET / HEAD / OPTIONS (no state change).
   - **Where to mount**: in `index.ts` immediately after
     `cookieParser()`, before any state-changing route mounts.
     Issuance is a response hook — `csrf.issueOnLogin(res)` called
     from `setRefreshCookie` helper sites in `auth.routes`,
     `user.routes` (signup completion), `invitation.routes`,
     `admin.routes` (impersonation).

5. **Frontend wiring (`frontend/app.js`).** The `api._fetch`
   wrapper grows a CSRF mirror: read `document.cookie` for
   `xsrf_token`, set `X-CSRF-Token: <value>` on every non-GET
   request. Existing 401 → refresh → retry path is unchanged.
   Already-mounted XHR-style code paths (passkey enroll, push
   subscribe) go through `api.post` so they pick up the header
   for free.

### C. Session rotation on auth state change

6. **`services/auth.service.ts` — `rotateSession(sessionId, opts?)`
   helper** (new). Returns `{ refreshToken, refreshTokenHash,
   accessToken }`. Single-purpose: load the session row, generate
   a fresh refresh token, `UPDATE user_sessions SET
   refresh_token_hash = $new, last_active_at = now()` keyed on
   the row id, mint a new access token from the row's user/tenant.
   Mirrors the rotation that `refreshSession` already does — but
   keyed on the session id rather than the old hash, so callers
   that just authenticated via passkey/MFA/etc. can rotate without
   knowing the previous hash.

7. **Call-site rotation wiring.** Each transition issues a new
   session row OR rotates an existing one — clarify per site:
   - `completeLogin` (post-magic-link primary) — already
     **inserts** a new session row. No rotation needed; this is
     the row that lives until the next state change.
   - `completePasskeyAuth` — same; new row on success.
   - `/api/auth/totp/verify` (post-MFA) — currently mints the
     full session via `createSession`. **Rotate** the
     just-issued primary-auth session row instead so the
     pre-MFA interim window leaves no live refresh token. (If
     today's flow doesn't issue the row until after MFA, this is
     a no-op — confirm during commit 6.)
   - `POST /api/admin/impersonate/:tenantId/:userId` — issues a
     new session row owned by the target user with
     `impersonator_user_id` set to the calling admin. Old
     admin-session row stays alive (so Stop can find it via
     `impersonator_user_id`).
   - `POST /api/admin/impersonate/stop` — looks up the original
     admin user via `impersonator_user_id` on the current
     session, rotates a fresh session **for that admin user**,
     deletes the impersonation session row.

### D. Impersonation start/stop

8. **`services/admin.service.ts` — `startImpersonation` /
   `stopImpersonation`.**
   - `startImpersonation(adminUserId, targetTenantId,
     targetUserId, req)`. Guard: caller is `is_platform_admin`.
     Resolve target user (must exist, not deactivated,
     `tenant_id` matches the route param — defense in depth).
     Insert a new `user_sessions` row with
     `user_id = targetUserId`, `tenant_id = targetTenantId`,
     `impersonator_user_id = adminUserId`,
     `device_info = { impersonation: true, ... }`. Mint access
     token whose payload mirrors the target user's role / perms
     / `is_owner` / `is_platform_admin` / etc. but adds
     `imp: { admin_id: adminUserId, admin_email: '...' }` so the
     UI banner can render without a follow-up call. Audit-log
     `admin.impersonation.start` under
     `withTenantContext(targetTenantId)` (tenant audit_log row
     for the target's tenant) AND a paired
     `audit.impersonation.start` under
     `withAdminClient` for the platform audit trail.
   - `stopImpersonation(impSessionId, req)`. Guard: current
     session row has non-NULL `impersonator_user_id`. Read the
     admin user, rotate a fresh session for that admin user,
     delete the impersonation session row, audit-log
     `admin.impersonation.stop` (paired log shape as start).

9. **`routes/admin.routes.ts` — three routes.**
   - `POST /api/admin/impersonate/:tenantId/:userId` →
     `startImpersonation`. Returns
     `{ access_token, refresh_token (cookie-set) }` so the
     frontend can swap to the new identity in-place.
   - `POST /api/admin/impersonate/stop` → `stopImpersonation`.
     Returns the same shape but for the admin's restored
     session.
   - All routes already mount under `requirePlatformAdmin` —
     the stop route additionally requires `req.user.imp` truthy
     (no-op for non-impersonating admins).

10. **Frontend — Admin → Tenants row CTA + persistent banner.**
    - `bundles/general.json` `admin_tenants` view: new
      "Impersonate owner" CTA per tenant row (matches the
      step-7 "Invite Owner" CTA shape — gear-menu /
      kebab-menu, not a destructive primary button).
    - `frontend/app.js`: `startImpersonation(tenantId, userId)`
      hits the start route, replaces stored access token,
      reloads the app shell.
    - **App shell red banner** rendered above the sidebar when
      `req.user.imp` is set: copy "You are signed in as
      {target_email} on behalf of {admin_email}" + "Stop
      impersonating" button. Banner styling in `app.css` —
      `.impersonation-banner` rule, top-fixed, red background
      (`--danger-bg`), z-index above sidebar. Stop button →
      `/api/admin/impersonate/stop` → swap token → reload.

### E. Magic-link IP/UA binding

11. **`services/auth.service.ts` — issuance + consumption.**
    - `sendMagicLink` / `initiateLogin` / `initiateSignup`:
      compute `issuer_ip_hash = sha256(ip || JWT_SECRET)`,
      `issuer_ua_hash = sha256(ua || JWT_SECRET)` (reuse the
      step-9 `ip_hash` salt convention) and INSERT them into
      the new columns. `req` already threaded through these
      paths via the rate-limiter wiring from step 9.
    - `verifyCode` / `verifyToken`: when both columns are
      non-NULL on the loaded row, compare against
      `req.ip` / `req.headers['user-agent']` hashes. Mismatch
      → bump `attempts` per the existing per-link counter (so
      a fingerprint mismatch eats one of the 5 attempts) AND
      throw `400 LINK_FINGERPRINT_MISMATCH` with
      `{ attempts_remaining }` in details. Surface the new
      error code in the auth modal as a generic "this link was
      opened on a different device — request a new one"
      message (don't echo the fingerprint).
    - **Skip-on-NULL** is the upgrade path — links issued
      pre-migration-037 don't have hashes; they consume
      normally. New issuance always populates.

### F. Account-deletion cascade

12. **`services/user.service.ts` — `deleteOwnAccount(userId,
    tenantId, req)`.** `withTenantTransaction` body:
    - Pre-check: `is_owner = true` AND tenant has any other
      active user (`status='active'` and `id != $1`)? → throw
      `409 OWNER_DELETE_BLOCKED` with
      `{ message: 'Transfer ownership before deleting your
      account.' }`. The Tenants ownership-transfer surface is
      OUT of scope for step 10 — the error is the UI signal.
    - Revoke sessions: `DELETE FROM platform.user_sessions
      WHERE user_id = $1`.
    - Clear passkeys: `DELETE FROM platform.user_passkeys
      WHERE user_id = $1`.
    - Clear TOTP + backup codes: `DELETE FROM
      platform.user_totp_secrets WHERE user_id = $1` (FK
      cascade clears `user_backup_codes`).
    - Soft-delete user: `UPDATE platform.users SET
      status='deactivated', email = email || '.deactivated.'
      || extract(epoch from now())::bigint, updated_at = now()
      WHERE id = $1`. The email-suffix dance is so the
      `(tenant_id, email)` UNIQUE constraint doesn't block a
      future signup with the same address.
    - Audit-log `user.account.delete` with `actor_user_id =
      $1`, `target_user_id = $1`, IP+UA hashes from `req`.
    - Hard-purge of soft-deleted rows is a scheduled task
      (see "deferred" — out of scope for step 10).

13. **`routes/user.routes.ts` — `DELETE /api/users/me`.**
    Mounts `authenticateJWT` + `csrf.verify` (DELETE is a
    state-changing method → CSRF-required). Reads
    `req.user.sub` + `req.user.tid`, forwards to
    `deleteOwnAccount`. On success, clears the refresh cookie
    and the CSRF cookie. Returns
    `{ ok: true, message: 'Account deactivated.' }`.

### G. GDPR Art. 20 data export

14. **`services/portability.service.ts` — `exportUser(tenantId,
    userId)`.** Reuses the step-7 archive shape (manifest +
    data/*.json + images/*) but every query is filtered by the
    user_id, not just the tenant_id. Sections:
    - `user.json` — own row from `platform.users` (excludes
      `role_id` internal, includes role slug + name).
    - `sessions.json` — `user_sessions` rows for this user
      (audit metadata: when/where you logged in).
    - `passkeys.json` — credential-id + nickname + created_at
      (NOT the raw public key — the user can't act on it,
      and exporting it is a needless surface).
    - `totp.json` — `confirmed_at` only, never the
      ciphertext. Backup-codes count remaining; codes
      themselves never exported (they're hashed).
    - `audit_log.json` — `audit_log` rows where
      `actor_user_id = $1` OR `target_user_id = $1`.
    - `inbox.json` — `inbox_messages` rows authored by the
      user + threads they participate in.
    - `dashboards_authored.json` — `dashboards` where
      `created_by = $1`.
    - `manifest.json` — `{ platform: 'xray-bi', version,
      kind: 'user-export', user_id, tenant_id, exported_at,
      sha256_per_file }`. Immutable shape — no consumer
      relies on field order.

15. **`routes/user.routes.ts` — `GET /api/users/me/export`.**
    Streams the ZIP back via `archiver`. Sets
    `Content-Disposition: attachment;
    filename="xray-export-{user_id}-{YYYYMMDD}.zip"`. CSRF
    skipped (GET method). Audit-log `user.export.request`
    before streaming so a failed export still leaves a
    trail. **No body input** — implicit user_id from the JWT.

### H. Frontend surfaces

16. **`bundles/general.json` — Account → Privacy card.**
    New card under existing Security card. Two CTAs:
    - "Download my data" → `GET /api/users/me/export` →
      browser saves the ZIP. Loading state + error toast.
    - "Delete my account" → confirmation modal (typing the
      tenant slug to confirm — destructive-action standard
      shape). On confirm → `DELETE /api/users/me` → on
      success: clear local storage, redirect to `/`. On
      `OWNER_DELETE_BLOCKED`: show the
      "transfer ownership first" message inline.

17. **App-shell impersonation banner.** Already covered in
    commit 10 — pulled out here so the frontend chunk reads
    end-to-end.

### I. Acceptance + handoff

18. **Tests** —
    - `services/portability.service.test.ts` (extend) — new
      describe block: `exportUser` round-trip on a fake-pool
      tenant with two users, asserts the second user's rows
      are absent.
    - `middleware/csrf.test.ts` (new) — issuance sets
      cookie; verify rejects mismatched, accepts matched,
      skips Bearer-API-key + skip-list paths.
    - `services/auth.service.test.ts` (extend) —
      magic-link IP/UA mismatch path; `LINK_FINGERPRINT_
      MISMATCH` decrements `attempts_remaining`.

19. **CONTEXT.md handoff** — append a "Step 10 — shipped"
    section modeled on step 9's. Roadmap row 10 → "shipped",
    note that step 11 + step 12 remain before
    production-readiness.

## Working rhythm

- **One concern per commit.** Migrations alone first (no app
  code in the same commit as a migration).
- Run `npm run typecheck` + `npm test` after each commit.
- The CSRF middleware mount is the riskiest single commit —
  it changes the request lifecycle for every authenticated
  state-changing route. Smoke-test login → dashboard render
  → settings save → logout in a real browser before declaring
  green.
- Impersonation start/stop changes the JWT shape (`imp`
  claim). Verify with both an impersonating session and a
  normal admin session that the banner shows / hides
  correctly.
- Develop on `claude/xray-csrf-impersonation-<suffix>` (the
  pre-created `claude/xray-hardening-step-10-4RQgy` branch
  is acceptable as the suffix-bearing variant).

## Acceptance

- **CSRF**: state-changing request without `X-CSRF-Token` →
  `403 CSRF_INVALID`. Bearer-API-key path bypasses the check.
  Webhook ingest path bypasses the check. Frontend `api.post`
  calls succeed end-to-end.
- **Session rotation**: `refresh_token_hash` for the same
  user changes between primary auth and post-MFA-verify.
  Verify with a SQL probe before/after the totp/verify call.
- **Impersonation**: admin → Tenants → "Impersonate owner" on
  tenant T → app reloads as the target user, red banner
  visible. "Stop impersonating" → app reloads as the admin,
  banner gone. `audit_log` shows the start + stop pair on
  both the target tenant and the platform-admin scope.
- **Magic-link IP/UA mismatch**: issue link from device A,
  open from device B → `400 LINK_FINGERPRINT_MISMATCH`,
  `attempts_remaining` decremented.
- **Account deletion** (non-owner): `DELETE /api/users/me` →
  `users.status = 'deactivated'`, `user_sessions` empty for
  that user, `user_passkeys` empty, `user_totp_secrets` +
  `user_backup_codes` empty.
- **Account deletion** (owner with other active members):
  → `409 OWNER_DELETE_BLOCKED`.
- **Data export**: `GET /api/users/me/export` returns a
  valid ZIP. `manifest.json` validates. Inspecting the
  archive shows only the calling user's rows (cross-user
  rows from the same tenant absent).
- `npm test`: green, including new csrf middleware specs +
  extended portability/auth specs.
- `tsc --noEmit`: clean.
- `withClient` direct-call count unchanged from step 9's
  9-file allow-list. New code uses `withTenantContext` /
  `withTenantTransaction` / `withAdminClient` /
  `withUserContext` per CLAUDE.md.

## What step 10 must NOT do

- **No new MFA work** — step 9 closed that gap.
- **No privacy policy / T&C / cookie banner** — step 11.
- **No pipeline DB changes / backups** — step 12.
- **No `withClient` allow-list changes** — new code uses
  `withTenantContext` / `withAdminClient` / `withUserContext`
  per CLAUDE.md.
- **No tenant ownership-transfer UI.** The
  `OWNER_DELETE_BLOCKED` error is the UI signal for "transfer
  first" — the actual transfer surface is a separate task.
- **No hard-purge scheduled task** for soft-deleted users.
  Soft-delete is the step-10 deliverable; the 30-day-after
  cron-style purge is a follow-up.
- **No CSRF on `Authorization: Bearer xray_*` API-key paths.**
  API keys are header-authenticated and not subject to the
  cross-site cookie-replay attack CSRF protects against.
- **No CSRF on webhook ingest.** Sender-signed payloads have
  their own auth — adding CSRF would just break webhooks.

## Updating CONTEXT.md

Append a **"Step 10 — Auth surface area cleanup (shipped)"**
section after step 9's entry. Keep the table/section shape
consistent. Update the **Roadmap** section's step-10 row to
"shipped" and surface any deferred items (ownership transfer
UI, soft-delete hard-purge cron) in the appropriate next-step
row or a new "Pre-launch nice-to-have" entry.

## After step 10 — production-ready?

**No.** Step 10 closes the auth-surface gaps. Still required:

- **Step 11** — privacy & compliance docs (admin-editable +
  versioned + acceptance-tracked + cookie banner +
  sub-processors page).
- **Step 12** — pipeline DB Model D + automated backups +
  tested restore drill + `PROBE_RLS` in CI.

After **step 12** the system meets the production-readiness
gate described in CONTEXT.md's Roadmap section. Step 10 is
two of four remaining pre-launch steps closed.

## First action

Read this kickoff + CONTEXT.md's **Step 9** + **Roadmap**
sections + `.claude/withclient-audit.md`. Confirm operator
preferences on the four open decisions below before pushing
the first commit.

## Open decisions — wait for operator approval

1. **CSRF token storage** — cookie + matching `X-CSRF-Token`
   custom header (recommended; standard double-submit; clean
   fit with the existing `api._fetch` wrapper) vs. cookie +
   `<input>` body field. Header approach assumed throughout
   this kickoff; flip to body-field if operator prefers
   form-encoded compatibility (XRay has no form-encoded
   surfaces today, so default stands).

2. **Impersonation UI placement** — Admin → Tenants row CTA
   (recommended; aligns with step-7's "Invite Owner" shape;
   no new top-level nav) vs. dedicated Admin → Impersonate
   page. Row CTA assumed throughout.

3. **Account-deletion soft vs. hard** — soft (recommended;
   `status='deactivated'`, retain rows for the 30-day audit
   window, hard-purge on a future scheduled task) vs. hard
   (faster to ship but loses audit trail and breaks
   cross-tenant audit references). Soft assumed throughout;
   the schema already supports it (`users.status` enum
   includes `'deactivated'`).

4. **Data-export format** — JSON-in-ZIP (recommended; mirrors
   `portability.service`; trivially parseable; GDPR-acceptable)
   vs. one-CSV-per-table-in-ZIP (more human-friendly in Excel,
   but loses nested shapes — `device_info` JSONB on sessions,
   `metadata` on audit_log). JSON assumed throughout.

5. **(Sub-decision) CSRF signing secret source** — dedicated
   `csrf_signing_secret` row in `platform_settings` (recommended,
   migration 038; allows independent rotation) vs. reuse
   `JWT_SECRET` (one fewer migration, but rotation invalidates
   sessions). Dedicated key assumed throughout.

Wait for operator approval on points 1-4 (5 is a follow-up to 1)
before pushing the first commit.
