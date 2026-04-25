# XRay — Step 9 kickoff

Paste this as the next session's opening prompt (after step 8 ships).

---

## Role

You are implementing step 9 of the XRay platform hardening track.

Where we are: steps 1-7 hardened the platform DB / RLS / embed
projection / portability / branded admin invitations. Step 8 (CI
plumbing) added Dependabot, GitHub secret scanning, gitleaks
pre-commit, CodeQL, Trivy, `npm ci` lockfile-strict, and branch
protection — protective baseline before more sensitive code lands.
See the **Step 7** + **Step 8** sections of `CONTEXT.md` and the
**Roadmap** section at the end of `CONTEXT.md` for the full plan.

Step 9 is **brute-force + MFA hardening** — the highest-CVSS gap
on the way to production-ready. Today there is **no rate limiting
anywhere** (the index.ts comment literally says "Rate limiting
removed") and **no MFA enforcement** beyond the already-shipped
optional passkey path. Step 9 closes both gaps in one session.

This is a **Tier-2 STRONG-but-not-hard pre-launch blocker** per
the gating logic in CONTEXT.md's Roadmap section: deferring it
doesn't violate a contract, but the exposure window from
signup → ship-date is the cost. It must ship before signups open.

## Current step

**Step 9 — Brute-force + MFA hardening.**

Roadmap allocates 12-15 commits. Items, in suggested order:

### A. Migrations (foundation — land first, alone)

1. **`migrations/031_user_totp.sql`** — new
   `platform.user_totp_secrets`:
   ```
   user_id UUID PRIMARY KEY REFERENCES platform.users(id) ON DELETE CASCADE,
   secret_ciphertext TEXT NOT NULL,         -- enc:v1: envelope
   confirmed_at TIMESTAMPTZ,                -- NULL until first code verified
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   tenant_id UUID NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE
   ```
   RLS enabled. `tenant_isolation` + `platform_admin_bypass`
   policies — see migration 029 for the canonical shape. Encrypted
   column trigger on `secret_ciphertext` per migration 017+ pattern.

2. **`migrations/032_user_backup_codes.sql`** — new
   `platform.user_backup_codes`:
   ```
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   user_id UUID NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
   tenant_id UUID NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
   code_hash TEXT NOT NULL,                 -- bcrypt or argon2id
   used_at TIMESTAMPTZ,                     -- NULL = unused
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   ```
   Index on (user_id, used_at). RLS + policies as above.

3. **`migrations/033_magic_link_attempts.sql`** — extend
   `platform.magic_links`:
   ```
   ALTER TABLE platform.magic_links
     ADD COLUMN attempts_count INT NOT NULL DEFAULT 0,
     ADD COLUMN max_attempts INT NOT NULL DEFAULT 5;
   ```
   The 5-attempt-per-link limit is independent of the per-day
   per-user 20-attempt limit — both apply.

4. **`migrations/034_require_mfa_setting.sql`** — seed
   `platform_settings` row:
   ```
   INSERT INTO platform.platform_settings (key, value, is_secret)
   VALUES ('require_mfa_for_platform_admins', 'false', false)
   ON CONFLICT (key) DO NOTHING;
   ```
   Operator flips to `true` in production via Admin → Platform
   Settings (already shipped).

5. **`migrations/035_auth_attempts.sql`** — new
   `platform.auth_attempts` for the 24h per-user counter:
   ```
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   email_lower TEXT NOT NULL,
   attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   ip_hash TEXT,
   success BOOLEAN NOT NULL DEFAULT FALSE
   ```
   Index on `(email_lower, attempted_at)`. **No RLS** — carve-out,
   pre-tenant lookup path (the rate limiter runs before user_id is
   known). Add to the `withClient` allow-list in
   `scripts/check-withclient-allowlist.sh` if the rate-limit
   middleware uses `withClient` directly; prefer
   `withAdminClient` so the carve-out exception isn't needed.

### B. TOTP service + backup codes

5. **`services/totp.service.ts`** (new). Uses `otplib` (or
   `speakeasy`) and `qrcode`. Functions:
   - `enrollTotp(userId, tenantId)` — generates secret, returns
     `{ secret, otpauth_url, qr_data_url }`. Stores
     `secret_ciphertext` with `confirmed_at = NULL`.
   - `confirmTotp(userId, tenantId, code)` — verifies first code,
     sets `confirmed_at = NOW()`. Returns 8 freshly-generated
     backup codes (one-time view).
   - `verifyTotp(userId, tenantId, code)` — used during login.
     Constant-time comparison. Returns boolean.
   - `disableTotp(userId, tenantId, currentCode)` — requires a
     valid current code, deletes the row. Cascade to backup
     codes via FK.

6. **`services/backup-codes.service.ts`** (new):
   - `generateBackupCodes(userId, tenantId, count = 8)` — creates
     8 random codes (format: `xxxx-xxxx-xxxx`), hashes each,
     inserts. Returns plaintext array — caller is responsible for
     showing them once.
   - `verifyAndConsumeBackupCode(userId, tenantId, code)` — looks
     up by hash, sets `used_at = NOW()` atomically, returns
     boolean.
   - `regenerateBackupCodes(userId, tenantId)` — invalidates
     existing unused codes + generates new ones.
   - `countUnusedCodes(userId, tenantId)` — for the "X codes
     remaining" UI affordance.

7. **Auth flow integration** — `auth.service.ts`:
   - After primary auth (passkey OR magic-link verified), check:
     - User has TOTP enrolled? → Force TOTP step.
     - User is platform admin AND `require_mfa_for_platform_admins`
       is `true` AND TOTP NOT enrolled? → Force TOTP enrollment
       step (block login until enrolled).
     - Otherwise → issue session.
   - New endpoint: `POST /api/auth/totp/verify` — accepts
     `{ session_token (interim), code }` and either a TOTP code
     or a backup code. Returns full session on success.

### C. Brute-force throttling

8. **Magic-link per-link attempt counter wiring.** In
   `auth.service.consumeMagicLink` (or equivalent), on code
   mismatch:
   - `UPDATE platform.magic_links SET attempts_count = attempts_count + 1`
   - If `attempts_count >= max_attempts`, mark consumed (locked).
   - Return `{ attempts_remaining: max - attempts_count }` so the
     UI can show "N attempts left" / final-attempt warning.

9. **App-layer rate limiter — IP+device tier.**
   `middleware/rate-limit.ts` (new). Use `express-rate-limit`
   with a custom keyGenerator that combines `req.ip` and a device
   fingerprint hash (header-derived: UA + Accept-Language hash).
   Window: 60s, max: 100. Skip: `/api/health`, `/api/embed/*`,
   `/api/share/*` (public/embed routes get their own bucket).
   Apply globally before route mounting in `index.ts`.

10. **App-layer rate limiter — per-user-id tier on
    `/api/auth/*`.** New table OR an in-memory LRU keyed on
    `email_lower`. Window: 24h rolling, max: 20. Banner triggers
    at `attempts_remaining <= 10`, hard lockout at 0 with
    `retry-after` seconds. Surface remaining count in
    `WWW-Authenticate` header or response body so the auth modal
    can render the banner without a separate endpoint.

    Decision: **DB-backed**. In-memory loses state on restart,
    which is the wrong default for a security counter.
    `platform.auth_attempts` table: `(email_lower, attempted_at,
    ip_hash, success)`. Query: count where `attempted_at >
    NOW() - INTERVAL '24 hours' AND email_lower = $1`. Index on
    `(email_lower, attempted_at)`.

### D. Passkey enumeration guard

11. **`/api/auth/webauthn/options` enumeration guard.** Today the
    endpoint returns the user's real `allowCredentials` list (or
    nothing if the user has no passkeys), which leaks "this email
    has passkeys registered" vs. "this email is unknown."

    Fix: always return a credential-list shape. If the user has
    no passkeys, return a deterministic-looking dummy list keyed
    on `hash(email + server_secret)` so the response is
    indistinguishable. The browser will fail at WebAuthn time
    but the timing + response shape is constant.

### E. Frontend — Account → Security UI

12. **`frontend/app.js`** + matching markup in `index.html`:
    - "Account → Security" panel.
    - "Enroll TOTP" → shows QR + secret string, prompts for first
      code, displays 8 backup codes (with a "I've saved these"
      checkbox required to dismiss).
    - "View backup codes remaining: N / 8" — link to regenerate.
    - "Disable TOTP" → prompts for current code.

13. **Login flow UI** — banner for "N attempts left" on the auth
    modal during the magic-link verify step. Triggers at ≤ 10
    remaining (the per-user 24h bucket). Distinct copy from the
    per-link 5-attempt counter.

### F. Acceptance + handoff

14. **Tests** — `services/totp.service.test.ts` (enroll →
    confirm → verify → disable round-trip), magic-link attempt
    counter (lockout at 5), per-user 24h counter (lockout at 20).

15. **CONTEXT.md handoff** — append a "Step 9 — shipped" section
    modeled on step 7's shape: commit trail, what shipped,
    acceptance, deploy notes, post-deploy verification.

## Working rhythm

- One concern per commit. Migrations alone first (no app code in
  the same commit as a migration).
- Run `npm test` + `npx tsc --noEmit` after each commit.
- Manually test the enrollment flow in a browser before shipping
  the UI commit. The QR code rendering + first-code-verify
  handshake is fragile across `otplib` versions — verify with a
  real authenticator app (Google Authenticator, 1Password, Authy)
  before declaring it green.
- Develop on `claude/xray-bruteforce-mfa-<suffix>` from the
  post-step-8 head.

## Acceptance

- Brute-force a magic-link code → locked at 5 attempts on that
  link, banner shows "0 attempts left."
- 21 login attempts from the same email in 24h → 21st rejected
  with `retry-after`. Banner triggered at attempt 10.
- Admin user without TOTP enrolled, with
  `require_mfa_for_platform_admins=true` → blocked at login until
  enrollment complete.
- Admin user with TOTP enrolled → second factor required after
  passkey/magic-link.
- TOTP enroll → confirm → verify with a real authenticator app.
- Backup code consumes once, then fails on retry.
- Disable TOTP requires a current code.
- Passkey enumeration: `/api/auth/webauthn/options` for unknown
  email and known-no-passkey email return indistinguishable
  shapes (manual `curl` diff).
- 100 requests/min from one IP → 101st returns 429.
- `npm test`: green, including new totp.service.test.ts.
- `tsc --noEmit`: clean.

## What step 9 must NOT do

- **No CSRF middleware** — that's step 10.
- **No session rotation logic** — step 10.
- **No impersonation start/stop UI** — step 10.
- **No magic-link IP/UA binding** — step 10 (separate concern
  from per-link attempt counter).
- **No account deletion / data export endpoints** — step 10.
- **No privacy policy / T&C / cookie banner** — step 11.
- **No pipeline DB changes, no backups work** — step 12.
- **No `withClient` allow-list changes** — step 9 should not
  introduce new direct withClient calls; new code uses
  `withTenantContext` / `withAdminClient` per CLAUDE.md.

## Updating CONTEXT.md

Append a **"Step 9 — Brute-force + MFA hardening (shipped)"**
section after step 8's entry. Keep the table/section shape
consistent. Update the **Roadmap** section's step-9 row to
"shipped" and add any deferred items to the appropriate next-step
row.

## After step 9 — production-ready?

**No.** Step 9 closes the brute-force and MFA gaps. Still
required for production-ready:
- **Step 10** — CSRF, session rotation, impersonation UI,
  account deletion, data export.
- **Step 11** — privacy & compliance docs (admin-editable +
  versioned + acceptance-tracked + cookie banner + sub-processors
  page).
- **Step 12** — pipeline DB Model D + automated backups + tested
  restore drill + PROBE_RLS in CI.

After **step 12** the system meets the production-readiness gate
described in CONTEXT.md's Roadmap section. Step 9 is one of four
remaining pre-launch steps.

## First action

Read this kickoff + the **Step 7** + **Step 8** sections of
CONTEXT.md + the **Roadmap** section. Confirm:

1. `otplib` vs `speakeasy` choice. Both work; otplib is more
   actively maintained. Run `npm ls otplib speakeasy` from
   `server/` to see if either is already a transitive dep.
2. Backup-code hashing choice — bcrypt is already in the tree
   (verify with `npm ls bcrypt`); if not, add as a step-9 dep.
   Argon2id is theoretically stronger but introduces a new dep.
   Default: reuse bcrypt unless it's not present.
3. Per-user-24h tier storage decision — DB-backed `auth_attempts`
   table is the recommendation in this kickoff. Confirm before
   the migration commit.
4. Whether `require_mfa_for_platform_admins` should default to
   `true` in production via the `init.sql` seed AND the migration
   seed, or stay default-`false` and the operator flips it. The
   kickoff recommends `false` so the migration is non-disruptive
   on existing installs; operator flips it post-deploy.

Wait for operator approval on points 1-4 before pushing the
first commit.
