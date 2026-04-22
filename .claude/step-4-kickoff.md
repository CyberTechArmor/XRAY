# XRay VPS Bridge — Step 4 kickoff

Paste this as the next session's opening prompt.

---

## Role

You are implementing one step of a five-step bridge to capture paying
XRay tenants on the current VPS before an on-prem migration. The full
plan is in the original session prompt and `CONTEXT.md`. Hold it in
context so your choices in this step don't paint future steps into a
corner.

## Current step

**Step 4 — OAuth `access_token` population + RS256 keypair provisioning
for the pipeline data-access token.**

Two related-but-separable pieces in one session:

1. **`access_token` claim in the n8n-bridge JWT.** Today it's always
   absent (see `mintBridgeJwt` in `server/src/lib/n8n-bridge.ts` —
   `access_token` is documented but the render call sites never set it).
   Wire every render path to look up the tenant's OAuth refresh token
   for the dashboard's `integration`, mint a short-lived OAuth access
   token (or reuse a cached one that hasn't expired), and pass it as
   `accessToken` into `mintBridgeJwt`. The JWT claim is then present on
   `authed_render`, `admin_impersonation`, `admin_preview`, and
   `public_share` — though public_share with a tenant-bound access
   token is an interesting question; see "open design questions" below.
2. **RS256 keypair + data-access JWT.** Pipeline-hardening notes
   (Model J in `.claude/pipeline-hardening-notes.md`) commit to a
   second JWT that XRay mints alongside the n8n-bridge JWT, audience
   `xray-pipeline`, verified by the pipeline DB's
   `pipeline.authorize(token)` SECURITY DEFINER function once that
   lands. Step 4 is where we provision the RS256 keypair, store it
   correctly, and start minting the data-access token in parallel —
   even before the pipeline DB consumes it. Piggybacking this into
   step 4 avoids a future session that just adds one keypair and one
   JWT-shape.

## State from prior sessions

Step 3 shipped on branch `claude/xray-tenant-capture-wmpGv`. Read
`CONTEXT.md` at the repo root for the full handoff. Summary of what's
left for step 4 to assume:

- **`fetch_headers` is gone.** Every render SELECT now gets
  `integration`, `bridge_secret`, and JWT label JOINs. There is no
  legacy path to preserve; don't rebuild one.
- **`mintBridgeJwt` input shape.** `BridgeJwtInput` already accepts
  `accessToken`. `setIfPresent` keeps an unset access_token absent
  rather than emitting `null`. Do not rename the claim — n8n workflows
  depend on `$json.access_token`.
- **`params` and the four `via` values stay.** `authed_render`,
  `admin_impersonation`, `public_share`, `admin_preview`. SOC 2 trail.
  See CONTEXT.md step 3 for why.
- **Bridge secret is HS256 per-dashboard.** Don't conflate it with the
  new RS256 keypair. The HS256 secret signs the n8n-bridge JWT; the
  RS256 private key signs the pipeline data-access JWT. Different
  audience, different issuer contract (`aud='n8n'` vs
  `aud='xray-pipeline'`).
- **`platform.connections.connection_details`** is already encrypted
  under `enc:v1:`. That's where OAuth refresh tokens currently live.
  Step 4 does NOT change the column — just reads through it with
  `decryptSecret`.

## Design commitments that apply to step 4

- **Claim keys are stable.** Don't rename anything in the JWT. `access_token`
  is the one you're populating; everything else stays exactly as it is.
  The expanded tenant/dashboard/user labels from the JWT-labels interlude
  must still fire on every mint site.
- **Cache access tokens, don't re-mint per render.** OAuth providers
  rate-limit and refresh tokens are sensitive. Keep a short-lived
  in-memory cache keyed by `(tenant_id, integration)` with TTL tied to
  the token's `expires_in`. Persist only refresh tokens; access tokens
  are ephemeral.
- **RS256 keypair goes to env, NOT a per-row DB column.** Platform-wide
  keypair. `XRAY_PIPELINE_JWT_PRIVATE_KEY` (PEM, RS256) on the server;
  the corresponding public key will ship to the pipeline DB later
  (Model J). Required at boot alongside `ENCRYPTION_KEY` etc. Add
  provisioning to `install.sh` + `update.sh` the way step 1 added
  `ENCRYPTION_KEY` — generate if unset, idempotent.
- **Do NOT collapse the two tokens into one.** n8n's native JWT Auth
  node verifies HS256 per-dashboard; the pipeline DB verifies RS256
  platform-wide. Two different verifiers with different key models.
  The bridge response carries both, side by side.
- **`withClient` vs `withTenantContext`** — still out of scope. Step 6.
- **Plaintext-read fallback in `encrypted-column.ts`** — still in place.
- **Embed endpoint projection** — still pre-existing, still out of scope.

## Open design questions to surface in the plan

These are decisions step 4 needs to make explicitly, not hide behind
implementation:

- **Public-share + access_token.** A public share link has no acting
  user, so which tenant's OAuth access token — if any — does the share
  render use? Options: (a) share renders never carry access_token;
  (b) share renders carry the tenant-owning dashboard's token
  (tenant-scoped but user-absent). The step-2 precedent was to leave
  user_* claims absent on public_share; extending the same logic,
  public_share probably should NOT carry access_token either, since
  the data-access audit row can't attribute the call to a human.
- **Token cache scope.** Per-server-process in-memory is fine for
  single-VPS. When XRay fans out, move to a shared cache (Redis, or
  a `platform.oauth_tokens_cache` table). Surface the choice; don't
  silently bet on a future topology.
- **What happens when a refresh token is missing / revoked.** Today
  `integration` can be set without an OAuth connection wired up
  (nothing enforces the link). Decide: does render fail closed (500
  `OAUTH_NOT_CONNECTED`), or does it mint the bridge JWT with
  `access_token` absent and let n8n decide? Recommendation: fail
  closed, because "integration wants a token but we don't have one"
  is a config error the operator should see.
- **Data-access token audience + claim minimum.** Pipeline notes say
  minimum claims are `tenant_id, user_id, is_platform_admin, via, jti,
  exp`. Confirm the exact shape during the plan phase — the pipeline
  DB's `pipeline.authorize()` contract is what step 4 freezes.

## Working agreement for this session

Identical to prior sessions:

1. Read CONTEXT.md, this kickoff, and `.claude/pipeline-hardening-notes.md`.
2. **There's no VPS-side cutover-safety SQL for step 4.** The additive
   changes (new claim, new env var, new token type) don't require a
   data guard the way step 3's column drop did. But do confirm against
   the VPS that tenants who *have* integrations wired up in
   `platform.connections` have live OAuth connections — otherwise
   the new render error surface will fire the moment code deploys.
3. Plan → wait for approval → implement in small commits.
4. Acceptance checks:
   - `npm test` green (25 specs baseline; expect new specs for
     access-token population and data-access token mint).
   - `npm run build` clean.
   - A JWT-path dashboard renders end-to-end; the n8n workflow sees
     `$json.access_token` and uses it to call the integration.
   - The RS256 data-access JWT verifies against the provisioned public
     key, has the committed claim shape, and carries `jti` distinct
     from the bridge JWT's `jti`.
5. Update CONTEXT.md with the step-4 handoff and write
   `.claude/step-5-kickoff.md`.

## Branch

Develop on `claude/xray-step-4-oauth-<suffix>` off main once step 3's
PR merges. Never push to a different branch without explicit permission.

## What step 4 must NOT do

- Rename JWT claim keys.
- Drop `params`.
- Collapse the four `via` values into fewer.
- Remove per-call-site audit metadata.
- Change the HS256 per-dashboard secret model.
- Touch RLS or `withTenantContext` (step 6).
- Land the pipeline DB side of Model J — that's a separate post-step-6
  phase (see pipeline-hardening-notes). Step 4 just mints the token;
  no consumer yet.
- Introduce a global `dashboard_templates` table.
- Weaken `bridge_secret` redaction.
