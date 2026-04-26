# XRay — Step 12 kickoff

Paste this as the next session's opening prompt (after step 11 ships in full,
including PR #275 and the CodeQL-suppression PR).

---

## Role

You are implementing step 12 of the XRay platform hardening track.

Where we are: steps 1–7 hardened the platform DB / RLS / embed
projection / portability / branded admin invitations. Step 8
added CI plumbing (Dependabot, secret scanning, gitleaks,
CodeQL, Trivy, lockfile-strict). Step 9 closed the brute-force
+ MFA gaps. Step 10 closed the auth surface — CSRF, session
rotation, impersonation, magic-link fingerprint capture, GDPR
Art. 17 + 20 endpoints. Step 11 closed the privacy-compliance
gap — versioned `policy_documents`, per-user `policy_acceptances`
ledger, public `/legal/<slug>` SPA pages, re-acceptance modal,
landing-page cookie banner, Admin → Policies CRUD UI, plus
post-CI hardening (DOMPurify XSS sanitize, Trivy dep cleanup,
multer 1→2, npm-eviction from runtime image, CodeQL
js/missing-token-validation suppression with rationale). See
the **Step 9** + **Step 10** + **Step 11** + **Roadmap**
sections of `CONTEXT.md`.

Step 12 is **pipeline DB Model D + automated backups + tested
restore drill + `PROBE_RLS=1` in CI** — the FOURTH and final
of the four pre-launch blockers (steps 8, 9, 10, 11 shipped;
12 is the last gate). It is a **Tier-1 hard blocker** per the
gating logic in CONTEXT.md's Roadmap. **PRODUCTION READY AFTER
THIS STEP.**

## Current step

**Step 12 — Pipeline DB Model D + backups + PROBE_RLS=1 in CI.**

Roadmap allocates 12–15 commits across three concerns. Read
`.claude/pipeline-hardening-notes.md` end-to-end before starting
— it captures Model D's design (the Apr-22 commitments) and the
ordering/dependencies. Step 12 lands Model D only; Model J is
deferred to the post-launch Step 15.

Develop on **`claude/xray-pipeline-d-and-backups-<suffix>`** from
the post-step-11 head.

### Three concerns, in suggested landing order

#### A. Pipeline DB Model D — RLS for the data-lake DB

The pipeline / data-lake Postgres instance currently runs without
RLS — n8n connects as a superuser-equivalent and is trusted to
gate by `WHERE tenant_id = $1`. Step 12 lands the model-D
architecture from the hardening notes:

1. **Audit existing pipeline tables** — produce
   `.claude/pipeline-rls-audit.md` listing every table, whether
   `tenant_id UUID NOT NULL` exists, and whether RLS is enabled.
   The current setup is one hard-coded client; the audit doubles
   as the "what's the table inventory" doc the Phase-A rollout
   needs anyway.
2. **Add `tenant_id` columns** where missing, backfill from the
   single existing tenant, and add a `NOT NULL` constraint after
   the backfill. One commit per table to keep the rollout
   reviewable.
3. **`pipeline_user` role provisioning** — non-superuser, GRANT
   on the data tables but NO ownership (so RLS bites). Migration
   creates the role + grants idempotently. n8n credential
   updated to use this role; document the credential rotation in
   `docs/operator.md`.
4. **Permissive RLS first** — `ENABLE ROW LEVEL SECURITY` +
   policy `USING (tenant_id = current_setting('app.current_tenant', true)::uuid OR current_setting('app.current_tenant', true) = '')`
   so a workflow that hasn't been updated yet still works while
   the rollout proceeds. One commit per table.
5. **Update n8n workflows** — every pipeline-touching transaction
   starts with `SELECT set_config('app.current_tenant', $jwt.tenant_id, true)`.
   Workflow inventory comes from concern A.1's audit. Workflows
   are versioned in `n8n/workflows/*.json` (or wherever the
   operator stores the export); commit the updates.
6. **Flip to strict RLS** — drop the permissive `OR` clause once
   every workflow is on the new pattern. One commit per table,
   in a tail-end run.
7. **Cross-tenant probe** — extend
   `server/src/db/rls-probe.test.ts` (already exists for the
   platform DB per step 6) with a parallel test against the
   pipeline DB. Live integration test, not a fake-pool spec.
   Gated on `PROBE_PIPELINE_RLS=1` (env-flag-gated so a default
   `npm test` run doesn't need a pipeline DB).

#### B. Automated backups + tested restore drill

8. **`pg_basebackup` schedule** — operator-side cron (NOT a
   Postgres `pg_cron` extension since the platform DB is a
   plain Postgres without it). Document the recommended cadence
   (hourly for platform DB, hourly+WAL for pipeline DB given
   tenant data) and the script in `docs/operator.md`.
9. **WAL archiving** — `archive_command` + `archive_mode=on` on
   both the platform DB and the pipeline DB. Retention: 14 days
   default. Document the env-vars / volume mounts in
   `docs/operator.md` + the docker-compose snippet.
10. **Tested restore drill** — write `scripts/restore-drill.sh`
    that pulls the latest base backup + replays WAL up to a
    target timestamp into a sidecar Postgres container, runs
    `\d` to confirm schema, and runs a smoke query against the
    `platform.tenants` table. Idempotent. Operator runs it
    monthly per the recommended cadence in
    `docs/operator.md`. Test the script ONCE in this step
    against the live system and capture the output verbatim
    in the docs (commit-time snapshot — the drill output is
    the proof the restore path works).
11. **Restore-from-cold runbook** — `docs/operator.md` gets a
    "When the platform DB has been lost entirely" section
    walking through `pg_basebackup` restore + WAL replay +
    `npm run migrate` + the existing first-boot self-heal
    path. Reference the step-1 / step-6 backfill scripts for
    the encrypted-credentials path.

#### C. `PROBE_RLS=1` in CI

12. **Ephemeral Postgres in GitHub Actions** —
    `.github/workflows/ci.yml` gains a `services: postgres:` block
    on the test job, with the platform schema initialised
    via `init.sql` + `migrations/*.sql`. The existing
    `typecheck + test (server)` job runs unchanged on every
    PR; a NEW `rls-probe (platform)` job runs
    `PROBE_RLS=1 npx vitest run src/db/rls-probe.test.ts`
    against the ephemeral DB. Gates merges on RLS-probe
    green.
13. **`PROBE_PIPELINE_RLS=1` follow-up** — same pattern as #12
    for the pipeline DB. The ephemeral Postgres needs the
    pipeline schema seeded (concern A's migrations). Gates
    merges on pipeline-RLS-probe green.
14. **Probe doc** — `docs/operator.md` gains a "what the RLS
    probe covers" section so a future contributor reading a
    failed-probe CI log knows the exact contract being checked
    (cross-tenant SELECT returns zero rows, cross-tenant
    INSERT raises, admin bypass works).

### D. Acceptance + handoff

15. **CONTEXT.md handoff** — append "Step 12 — Pipeline DB Model
    D + backups + PROBE_RLS=1 in CI (shipped)" using the
    step-9 / step-10 / step-11 close-out shape. Roadmap row 12
    → "shipped". State explicitly that the
    production-readiness gate is now met.

## Working rhythm

- One concern per commit. Audit doc + per-table migrations
  alone first; Model J is explicitly out of scope (step 15).
- `npm ci && npm run typecheck && npm test` after each commit
  — local typecheck without `npm ci` silently degrades (the
  step-10 commit-15 lesson).
- Run the restore drill ONCE end-to-end against the live
  system before declaring concern B green. The drill output
  is the proof; without it we have a backup *script* but
  not a tested restore.
- Develop on `claude/xray-pipeline-d-and-backups-<suffix>`
  from the post-step-11 head.

## Acceptance

- Pipeline DB: every table has `tenant_id NOT NULL`,
  `tenant_isolation` policy, `platform_admin_bypass` policy.
  `pipeline_user` role exists, lacks ownership, has minimum
  necessary GRANTs.
- n8n workflows: every pipeline-touching transaction starts
  with `set_config('app.current_tenant', ...)`. The hard-
  coded client's workflows are migrated to the new pattern.
- Cross-tenant probe (`PROBE_PIPELINE_RLS=1`): a query under
  tenant A's `current_tenant` returns zero rows for tenant B's
  data; cross-tenant INSERT raises; admin bypass works.
- `pg_basebackup` runs nightly via cron; WAL archiving on both
  DBs to the documented volume.
- `scripts/restore-drill.sh` runs end-to-end against the live
  system; output captured in `docs/operator.md`.
- `docs/operator.md` covers: backup cadence, restore drill,
  cold-restore runbook, RLS-probe contract.
- CI: `rls-probe (platform)` and `rls-probe (pipeline)` jobs
  run on every PR; gate merges.
- `npm run typecheck` clean; `npm test` green.

## What step 12 must NOT do

- **No Model J work.** Pipeline `pipeline.authorize()` SECURITY
  DEFINER + RS256 verification + per-tenant role provisioning
  is step 15 (post-launch). Model D is the production-ready
  floor; J is the SOC-2 Type II tightener.
- **No further auth-surface work** — closed in step 10.
- **No further privacy / compliance work** — closed in step 11.
- **No new MFA work** — closed in step 9.
- **No `withClient` allow-list changes.** Every new code path
  uses `withTenantContext` / `withTenantTransaction` /
  `withAdminClient` per CLAUDE.md.
- **No platform-DB backup-script consolidation with the existing
  step-1 + step-6 backfill scripts.** Backfill scripts run
  on-deploy; backup scripts run on a schedule. Different ops
  shape; keeping them separate is the right factoring.
- **No production deployment of the migrations against the
  hard-coded client without operator coordination.** The
  workflow inventory + the role-cutover need operator-side
  scheduling (n8n credential swap is a brief outage). Land the
  code, hand the migration timing to the operator.

## Open decisions — wait for operator approval

1. **Backup target storage** — local volume only (recommended
   for the current scale; cheap; restore-from-cold is the
   primary use case) vs. S3-compatible offsite (better DR
   posture but adds an env-var + an external dep). Local-only
   assumed throughout; offsite is a step-13 nice-to-have.

2. **Backup cadence** — hourly base + continuous WAL
   (recommended for the pipeline DB; tenant data is
   irreplaceable) vs. nightly base + WAL (lighter for the
   platform DB which is smaller and re-seedable). Per-DB
   cadence assumed throughout; confirm before shipping.

3. **WAL retention window** — 14 days (recommended; covers a
   2-week vacation + the restore drill's monthly cadence) vs.
   30 days (more headroom but doubles the storage footprint).
   14 days assumed throughout.

4. **Hard-coded client migration timing** — land the code in
   step 12 with the existing client still on the pre-D
   workflow path (permissive policy keeps it working) and
   schedule the cutover as a separate operator-driven window
   vs. include the cutover in step 12 (more risk, faster
   reaches the SOC-2 posture). Land-then-cutover assumed
   throughout.

5. **`pipeline_user` credential rotation cadence** — quarterly
   manual (recommended; stable secret reduces n8n credential
   churn) vs. monthly automated (better posture but needs
   tooling we don't have today). Quarterly assumed throughout.

Wait for operator approval on points 1–5 before pushing the
first commit.

## After step 12 — production-ready?

**Yes.** Step 12 closes the last pre-launch blocker. The system
meets the production-readiness gate described in CONTEXT.md's
Roadmap:

- **Tenant data isolation** — RLS top-to-bottom (platform DB
  step 6/7, pipeline DB step 12).
- **Auth strength** — passkey + TOTP + backup codes; MFA-
  required for admins (operator-flippable); brute-force
  throttled (tier 1 + tier 2, behind operator flag pending
  UX calibration).
- **Session hygiene** — CSRF-protected, rotated on auth state
  change, impersonation visible.
- **Privacy compliance** — T&C + privacy + cookie + DPA + AUP
  + sub-processors all admin-editable + versioned + acceptance-
  tracked; GDPR Art. 17 + 20 endpoints.
- **Supply chain** — SCA + SAST + container scanning + secrets
  scanning all in CI; CodeQL on every PR; Trivy on every
  built image.
- **Backups** — automated `pg_basebackup` + WAL archive with
  tested restore drill.
- **Audit trail** — `platform.audit_log` (Model D's foundation).

Still gapped (acknowledged, post-launch tracks):

- Step 13 — mini-queue cleanup bundle.
- Step 14 — Globals starter pack.
- Step 15 — pipeline DB Model J (DB-side JWT auth + per-tenant
  roles + `pipeline.access_audit`).
- Steps 16–21 — `dashboards.view_html/css/js` retirement track
  (architectural cleanup, no security benefit).
- Observability (separate operator track).
- SOC 2 Type II (~6-month engagement; organisational controls).

## First action

Read this kickoff + `.claude/pipeline-hardening-notes.md` (full
file — Model D vs. Model J, the access-audit decision, the
ordering and dependencies). Read CONTEXT.md's **Step 6**, **Step
7**, **Step 11**, and **Roadmap** sections (Step 6/7 are the
platform-DB precedents for RLS migration patterns; Step 11 is
the most recent close-out shape). Confirm operator preferences
on the five open decisions above before pushing the first
commit.
