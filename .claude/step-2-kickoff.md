# XRay VPS Bridge — Step 2 kickoff

Paste this as the next session's opening prompt.

---

## Role

You are implementing one step of a five-step bridge to capture paying
XRay tenants on the current VPS before an on-prem migration. The full
plan is in the prior session prompt. Hold it in context so your choices
in this step don't paint future steps into a corner.

## Current step

**Step: 2 — XRay ↔ n8n JWT bridge.**

HS256, shared secret in env, 60-second expiry. Claims:
`iss`, `aud=n8n`, `sub=tenant_id`, `exp`, `iat`, `user_id`,
`template_id`, `integration`, `access_token` (OAuth token — populated
once step 4 lands; until then this claim may be absent or empty), and
`params`. XRay mints per render call; n8n validates.

After all dashboards are cut over to the JWT path, the read path stops
reading `dashboards.fetch_headers`. **Leave the column in place** — step
3 drops it as part of the schema refactor.

## State from prior sessions

Step 1 shipped on branch `claude/document-security-postgres-setup-526x5`.
Read `CONTEXT.md` at the repo root for the full handoff. Summary:

- All three credential columns (`webhooks.secret`,
  `connections.connection_details`, `dashboards.fetch_headers`) are now
  encrypted at rest with AES-256-GCM under the platform-wide
  `ENCRYPTION_KEY`. Format: `enc:v1:<base64>` for TEXT,
  `{"_enc":"enc:v1:<base64>"}` for JSONB.
- `server/src/lib/encrypted-column.ts` exposes
  `encryptSecret`/`decryptSecret`/`encryptJsonField`/`decryptJsonField`.
  Use these helpers if step 2 stores any new secrets.
- Migration 017 installed a BEFORE INSERT/UPDATE trigger on each column
  that rejects non-envelope writes. If step 2 introduces new secret
  storage, extend the trigger pattern rather than inventing a parallel
  guard.
- The transitional plaintext-read fallback in `encrypted-column.ts` is
  still in place. Don't remove it this session — that's a separate
  cleanup once VPS logs have been quiet for a few days.
- Follow-ups left behind: revisit whether `dashboards.fetch_body` should
  be encrypted once step 2 decides what goes in the body (likely the
  JWT, which is short-lived and does not need to be encrypted at rest).

## Design commitments that apply to step 2

- `withClient` vs `withTenantContext` — do NOT fold into this step. It's
  step 6, after step 5 ships. Only touch call sites you're already editing.
- New env var required (JWT bridge secret). Name it something like
  `N8N_BRIDGE_JWT_SECRET`. Validate at boot the same way `ENCRYPTION_KEY`
  is validated. Document in CONTEXT.md and note that both sides (XRay +
  n8n) must agree on the value.
- `platform.audit_log` entry per render call with the JWT `jti` or a
  minted-token fingerprint so a leaked token can be traced back to the
  user+tenant+dashboard. Reuse `services/audit.service.log()`.
- Keep HCP assumptions out of the bridge — `integration` is a string,
  the JWT schema is integration-agnostic, and the n8n validation story
  should work for QBO in step 4+ with zero bridge changes.

## Working agreement for this session

Identical to the prior session prompt: read the repo first, confirm
understanding, produce a plan, wait for approval, implement in small
commits, run the acceptance check, update CONTEXT.md, and write the
step-3 kickoff prompt.
