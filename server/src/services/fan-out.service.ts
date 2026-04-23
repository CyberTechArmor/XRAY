import { createHash } from 'crypto';
import { withClient } from '../db/connection';
import { AppError } from '../middleware/error-handler';
import { decryptSecret } from '../lib/encrypted-column';
import { mintFanOutJwt } from '../lib/fan-out-jwt';
import {
  resolveAccessTokenForRender,
  type AuthMethod,
  type RenderTokenResult,
} from './integration.service';

// Fan-out dispatcher. n8n (or any authorized caller) hits
// POST /api/integrations/:slug/fan-out; this service loads every tenant
// connected to the integration, resolves each tenant's live credential
// via the existing render-path resolver, and POSTs a signed envelope
// once per connected tenant to the caller-supplied target URL.
//
// Owns:
//   - Creating a fan_out_runs row per dispatch (or returning a prior
//     summary when the caller supplies an idempotency_key that matches
//     an existing run).
//   - Per-tenant parallelism (up to integrations.fan_out_parallelism).
//   - Per-delivery retry (3 attempts, exp backoff [0s, 2s, 4s]).
//   - Writing fan_out_deliveries rows (one per tenant, dispatched or
//     skipped) with the per-(run, tenant) idempotency key.
//
// Does NOT own:
//   - The scheduling. n8n owns the cron; XRay only dispatches on demand.
//   - OAuth refresh. That stays in oauth-scheduler.ts.
//   - Shared-secret auth on the inbound call. The route layer handles
//     that before we reach the service.

export interface FanOutRequest {
  targetUrl: string;
  window?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
}

export interface FanOutSummary {
  fan_out_id: string;
  dispatched: number;
  skipped_needs_reconnect: number;
  skipped_inactive: number;
  skipped_integration_missing: number;
  replay: boolean;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

type SleeperLike = (ms: number) => Promise<void>;

let fetcher: FetchLike = globalThis.fetch as unknown as FetchLike;
let sleeper: SleeperLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Test seams so the service can assert dispatch/retry behavior without
// hitting the network or waiting real seconds.
export function __setFetcherForTest(next: FetchLike | null): void {
  fetcher = next ?? (globalThis.fetch as unknown as FetchLike);
}
export function __setSleeperForTest(next: SleeperLike | null): void {
  sleeper = next ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 2000, 4000];

export function computeDeliveryIdempotencyKey(fanOutId: string, tenantId: string): string {
  return createHash('sha256').update(`${fanOutId}:${tenantId}`).digest('hex');
}

interface IntegrationLoadResult {
  id: string;
  slug: string;
  display_name: string;
  status: 'active' | 'disabled' | 'pending';
  fan_out_secret: string | null;
  fan_out_parallelism: number;
}

async function loadIntegrationForDispatch(slug: string): Promise<IntegrationLoadResult> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT id, slug, display_name, status, fan_out_secret, fan_out_parallelism
         FROM platform.integrations
        WHERE slug = $1`,
      [slug]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'INTEGRATION_NOT_FOUND', `No integration with slug '${slug}'`);
    }
    const row = result.rows[0];
    if (row.status !== 'active') {
      throw new AppError(
        409,
        'INTEGRATION_NOT_ACTIVE',
        `Integration '${slug}' is ${row.status}; only active integrations can fan out`
      );
    }
    return row as IntegrationLoadResult;
  });
}

// Constant-time compare — a Bearer-token check needs this.
export function compareSecrets(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Pull the decrypted fan_out_secret for the inbound auth check. Kept
// separate from loadIntegrationForDispatch so the "I need the plaintext"
// surface stays greppable (matches the step-2 / step-4 secret-handling
// convention in integration.service.ts).
export async function getFanOutSecret(slug: string): Promise<{
  integrationId: string;
  integrationStatus: string;
  secret: string;
} | null> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT id, status, fan_out_secret FROM platform.integrations WHERE slug = $1`,
      [slug]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const secret = decryptSecret(row.fan_out_secret, `integrations:fan_out_secret:${row.id}`);
    if (!secret) return null;
    return { integrationId: row.id, integrationStatus: row.status, secret };
  });
}

interface ConnectedTenantRow {
  tenant_id: string;
  tenant_slug: string;
  connection_status: string;
}

async function listConnectedTenants(integrationId: string): Promise<ConnectedTenantRow[]> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT c.tenant_id, t.slug AS tenant_slug, c.status AS connection_status
         FROM platform.connections c
         JOIN platform.tenants t ON t.id = c.tenant_id
        WHERE c.integration_id = $1`,
      [integrationId]
    );
    return result.rows as ConnectedTenantRow[];
  });
}

async function findPriorRun(
  integrationId: string,
  idempotencyKey: string
): Promise<FanOutSummary | null> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT id, dispatched, skipped_needs_reconnect, skipped_inactive,
              skipped_integration_missing
         FROM platform.fan_out_runs
        WHERE integration_id = $1 AND idempotency_key = $2`,
      [integrationId, idempotencyKey]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      fan_out_id: row.id,
      dispatched: row.dispatched,
      skipped_needs_reconnect: row.skipped_needs_reconnect,
      skipped_inactive: row.skipped_inactive,
      skipped_integration_missing: row.skipped_integration_missing,
      replay: true,
    };
  });
}

async function insertRun(
  integrationId: string,
  req: FanOutRequest
): Promise<string> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      // Column is window_params (not `window`) — `window` is a reserved
      // keyword in Postgres. Public field name in the request body +
      // envelope JWT claim stays `window`; the rename is SQL-only.
      `INSERT INTO platform.fan_out_runs
         (integration_id, idempotency_key, target_url, window_params, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        integrationId,
        req.idempotencyKey || null,
        req.targetUrl,
        req.window || {},
        req.metadata || {},
      ]
    );
    return result.rows[0].id as string;
  });
}

async function upsertSkipped(
  fanOutId: string,
  tenantId: string,
  idempotencyKey: string,
  reason: string
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `INSERT INTO platform.fan_out_deliveries
         (fan_out_id, tenant_id, idempotency_key, status, skip_reason)
       VALUES ($1, $2, $3, 'skipped', $4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [fanOutId, tenantId, idempotencyKey, reason]
    );
  });
}

async function upsertDispatchAttempt(
  fanOutId: string,
  tenantId: string,
  idempotencyKey: string,
  status: 'delivered' | 'failed',
  attemptCount: number,
  lastError: string | null
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `INSERT INTO platform.fan_out_deliveries
         (fan_out_id, tenant_id, idempotency_key, status, attempt_count, last_error, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 = 'delivered' THEN now() ELSE NULL END)
       ON CONFLICT (idempotency_key) DO UPDATE
         SET status = EXCLUDED.status,
             attempt_count = EXCLUDED.attempt_count,
             last_error = EXCLUDED.last_error,
             delivered_at = EXCLUDED.delivered_at`,
      [fanOutId, tenantId, idempotencyKey, status, attemptCount, lastError]
    );
  });
}

async function finalizeRun(
  fanOutId: string,
  counts: Omit<FanOutSummary, 'fan_out_id' | 'replay'>
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `UPDATE platform.fan_out_runs
          SET dispatched = $2,
              skipped_needs_reconnect = $3,
              skipped_inactive = $4,
              skipped_integration_missing = $5,
              completed_at = now()
        WHERE id = $1`,
      [
        fanOutId,
        counts.dispatched,
        counts.skipped_needs_reconnect,
        counts.skipped_inactive,
        counts.skipped_integration_missing,
      ]
    );
  });
}

export async function deliverEnvelope(
  targetUrl: string,
  token: string,
  idempotencyKey: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; attempts: number; error: string | null }> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleeper(BACKOFF_MS[attempt - 1] ?? 0);
    try {
      const response = await fetcher(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-XRay-FanOut-Token': token,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (response.ok) return { ok: true, attempts: attempt, error: null };
      const text = await response.text().catch(() => '');
      lastError = `HTTP ${response.status} ${text.slice(0, 200)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, attempts: MAX_ATTEMPTS, error: lastError };
}

export async function dispatchFanOut(
  slug: string,
  req: FanOutRequest
): Promise<FanOutSummary> {
  if (!req.targetUrl || typeof req.targetUrl !== 'string') {
    throw new AppError(400, 'INVALID_TARGET_URL', 'target_url is required');
  }
  const integration = await loadIntegrationForDispatch(slug);
  if (!integration.fan_out_secret) {
    throw new AppError(
      409,
      'FAN_OUT_SECRET_NOT_SET',
      `Integration '${slug}' has no fan_out_secret configured. Generate one in the admin Integrations tab before dispatching.`
    );
  }

  // Idempotency: if caller supplied a key and a matching prior run
  // exists, return that summary instead of dispatching again. n8n retries
  // stay safe this way.
  if (req.idempotencyKey) {
    const prior = await findPriorRun(integration.id, req.idempotencyKey);
    if (prior) return prior;
  }

  const secret = decryptSecret(
    integration.fan_out_secret,
    `integrations:fan_out_secret:${integration.id}`
  );
  if (!secret) {
    throw new AppError(
      500,
      'FAN_OUT_SECRET_DECRYPT_FAILED',
      `Could not decrypt fan_out_secret for '${slug}'`
    );
  }

  const fanOutId = await insertRun(integration.id, req);
  const tenants = await listConnectedTenants(integration.id);

  let dispatched = 0;
  let skippedNeedsReconnect = 0;
  let skippedInactive = 0;
  const skippedIntegrationMissing = 0; // never hits here — we loaded the integration

  const parallelism = Math.max(1, integration.fan_out_parallelism);

  // Small bounded-parallelism runner without a new dep. Chunks the
  // tenant list into parallelism-sized batches, awaits each batch in
  // parallel, moves to the next.
  for (let i = 0; i < tenants.length; i += parallelism) {
    const chunk = tenants.slice(i, i + parallelism);
    const results = await Promise.all(
      chunk.map(async (row): Promise<'dispatched' | 'needs_reconnect' | 'inactive'> => {
        const idempotencyKey = computeDeliveryIdempotencyKey(fanOutId, row.tenant_id);
        let resolution: RenderTokenResult;
        try {
          resolution = await resolveAccessTokenForRender(row.tenant_id, integration.slug);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await upsertSkipped(fanOutId, row.tenant_id, idempotencyKey, 'resolver_error: ' + msg);
          return 'inactive';
        }
        if (resolution.kind === 'needs_reconnect') {
          await upsertSkipped(
            fanOutId,
            row.tenant_id,
            idempotencyKey,
            'needs_reconnect: ' + resolution.reason
          );
          return 'needs_reconnect';
        }
        if (resolution.kind === 'not_connected' || resolution.kind === 'unknown_integration') {
          await upsertSkipped(fanOutId, row.tenant_id, idempotencyKey, resolution.kind);
          return 'inactive';
        }
        // ready — mint envelope, deliver.
        const minted = mintFanOutJwt({
          tenantId: row.tenant_id,
          tenantSlug: row.tenant_slug,
          integrationSlug: integration.slug,
          fanOutId,
          secret,
          authMethod: resolution.authMethod satisfies AuthMethod,
          accessToken: resolution.accessToken,
          window: req.window,
          metadata: req.metadata,
        });
        const envelope: Record<string, unknown> = {
          fan_out_id: fanOutId,
          integration_slug: integration.slug,
          tenant_id: row.tenant_id,
          tenant_slug: row.tenant_slug,
          auth_method: resolution.authMethod,
          access_token: resolution.accessToken,
        };
        if (req.window) envelope.window = req.window;
        if (req.metadata) envelope.metadata = req.metadata;
        const delivery = await deliverEnvelope(
          req.targetUrl,
          minted.jwt,
          idempotencyKey,
          envelope
        );
        await upsertDispatchAttempt(
          fanOutId,
          row.tenant_id,
          idempotencyKey,
          delivery.ok ? 'delivered' : 'failed',
          delivery.attempts,
          delivery.error
        );
        return delivery.ok ? 'dispatched' : 'inactive';
      })
    );
    for (const r of results) {
      if (r === 'dispatched') dispatched++;
      else if (r === 'needs_reconnect') skippedNeedsReconnect++;
      else if (r === 'inactive') skippedInactive++;
    }
  }

  const summary = {
    dispatched,
    skipped_needs_reconnect: skippedNeedsReconnect,
    skipped_inactive: skippedInactive,
    skipped_integration_missing: skippedIntegrationMissing,
  };
  await finalizeRun(fanOutId, summary);

  return {
    fan_out_id: fanOutId,
    ...summary,
    replay: false,
  };
}

// Admin-facing "last fan-out" summary for the Integrations list UI.
export interface FanOutLastRunSummary {
  fan_out_id: string;
  dispatched: number;
  skipped_needs_reconnect: number;
  skipped_inactive: number;
  skipped_integration_missing: number;
  started_at: string;
  completed_at: string | null;
}

export async function listLastFanOutByIntegration(): Promise<
  Record<string, FanOutLastRunSummary>
> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT DISTINCT ON (r.integration_id)
              r.integration_id, r.id, r.dispatched, r.skipped_needs_reconnect,
              r.skipped_inactive, r.skipped_integration_missing,
              r.started_at, r.completed_at
         FROM platform.fan_out_runs r
        ORDER BY r.integration_id, r.started_at DESC`
    );
    const out: Record<string, FanOutLastRunSummary> = {};
    for (const row of result.rows) {
      out[row.integration_id] = {
        fan_out_id: row.id,
        dispatched: row.dispatched,
        skipped_needs_reconnect: row.skipped_needs_reconnect,
        skipped_inactive: row.skipped_inactive,
        skipped_integration_missing: row.skipped_integration_missing,
        started_at:
          row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
        completed_at:
          row.completed_at instanceof Date
            ? row.completed_at.toISOString()
            : row.completed_at
              ? String(row.completed_at)
              : null,
      };
    }
    return out;
  });
}
