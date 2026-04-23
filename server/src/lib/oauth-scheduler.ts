import { withClient, withTransaction } from '../db/connection';
import { encryptSecret, decryptSecret } from './encrypted-column';
import {
  exchangeWithRetry,
  OAuthExchangeError,
  type TokenPair,
} from './oauth-tokens';

// Background scheduler that keeps every tenant's OAuth access_token fresh
// so render paths become a pure read — no provider round-trip on the hot
// path. See CONTEXT.md step-4 for the full design.
//
// Tick cadence: every 5 minutes. Each tick picks up any connection whose
// access token expires within the next 30 minutes. With a retry policy
// of [0, 30, 60, 120, 240] seconds per exchange (450s worst case), a
// 30-min window gives plenty of room to recover before the token
// actually expires.
//
// Per-connection advisory locks (pg_try_advisory_lock) serialize refreshes
// for the same connection across multiple scheduler instances — we don't
// run multiple instances today but this keeps the door open without an
// extra table. hashtext(id::text)::bigint is stable within the cluster.
//
// Failure accounting: on exchange error, oauth_refresh_failed_count is
// incremented. At >= 5 consecutive failures the connection flips to
// status='error' and the tenant sees a 'Needs reconnect' pill. Success
// resets the counter and clears oauth_last_error.

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const REFRESH_WINDOW_MINUTES = 30;
const FAIL_COUNT_BEFORE_ERROR = 5;

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

// WS push fires when the scheduler flips a connection to status='error'
// so the tenant's UI surfaces the 'Needs reconnect' pill without
// waiting for the next poll. Mirrors the integration:connected /
// integration:disconnected broadcasts in connection.routes. Dynamic
// import + catch so a WS layer that's not up (unit tests, early boot)
// doesn't fail the refresh transaction.
function notifyNeedsReconnect(tenantId: string, integrationSlug: string): void {
  import('../ws')
    .then(({ broadcastToTenant }) => {
      broadcastToTenant(tenantId, 'integration:needs_reconnect', {
        slug: integrationSlug,
      });
    })
    .catch(() => {});
}

export function startScheduler(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(tickSafely, TICK_INTERVAL_MS);
  // First tick runs immediately so the startup-sync case (server comes
  // up after a long outage, tokens are stale) doesn't wait 5 minutes.
  // Guard against stopScheduler() being called between schedule and
  // dispatch — if the interval got cleared, skip the tick. Prevents
  // pending setImmediate callbacks from firing tests' tickSafely after
  // the test has stopped the scheduler.
  setImmediate(() => {
    if (!intervalHandle) return;
    tickSafely();
  });
  console.log(
    `[oauth-scheduler] started — tick=${TICK_INTERVAL_MS / 1000}s, window=${REFRESH_WINDOW_MINUTES}min`
  );
}

export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function tickSafely(): Promise<void> {
  if (running) {
    // Guards against two ticks overlapping if the previous one is slow.
    // Advisory locks would catch it per-row anyway but we prefer a clean
    // serial-tick model for simplicity.
    return;
  }
  running = true;
  try {
    await tick();
  } catch (err) {
    console.error('[oauth-scheduler] tick failed:', err);
  } finally {
    running = false;
  }
}

// Exported for specs and for any future "refresh now" admin button.
export async function tick(): Promise<{
  considered: number;
  refreshed: number;
  failed: number;
}> {
  const candidates = await selectDueConnections();
  let refreshed = 0;
  let failed = 0;
  for (const id of candidates) {
    const ok = await refreshOneConnection(id);
    if (ok) refreshed++;
    else failed++;
  }
  return { considered: candidates.length, refreshed, failed };
}

async function selectDueConnections(): Promise<string[]> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    // oauth_access_token_expires_at IS NULL covers the "just connected,
    // never refreshed" case — callback wrote tokens and trusted the
    // scheduler to verify, or we're recovering from a clock skew.
    const result = await client.query(
      `SELECT c.id
         FROM platform.connections c
         JOIN platform.integrations i ON i.id = c.integration_id
        WHERE c.auth_method = 'oauth'
          AND c.integration_id IS NOT NULL
          AND c.status = 'active'
          AND i.status = 'active'
          AND (c.oauth_access_token_expires_at IS NULL
               OR c.oauth_access_token_expires_at < now() + ($1 || ' minutes')::interval)`,
      [String(REFRESH_WINDOW_MINUTES)]
    );
    return result.rows.map((r) => r.id as string);
  });
}

// Refreshes a single connection. Returns true on success, false on
// exhausted retries. Wrapped in a transaction per connection so the
// advisory lock + the row update are a coherent unit. Exported so tests
// can drive it deterministically with a mocked fetcher.
export async function refreshOneConnection(connectionId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    // Advisory lock keyed on the connection UUID. Hashed to bigint
    // because pg_try_advisory_lock takes bigint. Stable within cluster.
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS locked',
      [connectionId]
    );
    if (!lockResult.rows[0].locked) {
      // Another tick (future: another instance) is already working this
      // row. Back off — next tick will pick it up if still due.
      return true;
    }

    const rowResult = await client.query(
      `SELECT c.id, c.tenant_id, c.oauth_refresh_token, c.oauth_refresh_failed_count,
              i.token_url, i.client_id, i.client_secret, i.id AS integration_id, i.slug
         FROM platform.connections c
         JOIN platform.integrations i ON i.id = c.integration_id
        WHERE c.id = $1
          AND c.auth_method = 'oauth'
          AND c.integration_id IS NOT NULL`,
      [connectionId]
    );
    if (rowResult.rows.length === 0) return true; // gone since SELECT — skip
    const row = rowResult.rows[0];

    const refreshToken = decryptSecret(
      row.oauth_refresh_token,
      `connections:oauth_refresh_token:${row.id}`
    );
    if (!refreshToken) {
      // Connection is in an inconsistent state — auth_method=oauth but
      // no refresh_token. Flip to error so the tenant re-connects.
      await client.query(
        `UPDATE platform.connections
           SET status = 'error',
               oauth_last_error = $2,
               updated_at = now()
         WHERE id = $1`,
        [row.id, 'oauth_refresh_token missing — tenant must reconnect']
      );
      notifyNeedsReconnect(row.tenant_id, row.slug);
      return false;
    }
    const clientSecret = decryptSecret(
      row.client_secret,
      `integrations:client_secret:${row.integration_id}`
    );
    if (!clientSecret || !row.client_id || !row.token_url) {
      // Admin hasn't finished configuring the integration's OAuth
      // credentials. Not the tenant's fault — don't flip the row to
      // error, just log and skip until the admin fixes it.
      console.warn(
        `[oauth-scheduler] skipping connection=${row.id} — integration OAuth config incomplete`
      );
      return false;
    }

    let pair: TokenPair;
    try {
      pair = await exchangeWithRetry({
        tokenUrl: row.token_url,
        clientId: row.client_id,
        clientSecret,
        refreshToken,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nextFailCount = (row.oauth_refresh_failed_count ?? 0) + 1;
      const newStatus = nextFailCount >= FAIL_COUNT_BEFORE_ERROR ? 'error' : 'active';
      await client.query(
        `UPDATE platform.connections
           SET oauth_refresh_failed_count = $2,
               oauth_last_error = $3,
               status = $4,
               updated_at = now()
         WHERE id = $1`,
        [row.id, nextFailCount, message.slice(0, 500), newStatus]
      );
      if (newStatus === 'error') {
        notifyNeedsReconnect(row.tenant_id, row.slug);
      }
      return false;
    }

    // Success: rotate access_token, optionally rotate refresh_token if
    // the provider returned a new one, clear failure state.
    const expiresAt = new Date(Date.now() + pair.expiresIn * 1000).toISOString();
    const fieldsToUpdate: string[] = [
      'oauth_access_token = $2',
      'oauth_access_token_expires_at = $3',
      'oauth_last_refreshed_at = now()',
      'oauth_refresh_failed_count = 0',
      'oauth_last_error = NULL',
      'updated_at = now()',
    ];
    const values: unknown[] = [row.id, encryptSecret(pair.accessToken), expiresAt];
    if (pair.refreshToken) {
      fieldsToUpdate.push(`oauth_refresh_token = $${values.length + 1}`);
      values.push(encryptSecret(pair.refreshToken));
    }
    await client.query(
      `UPDATE platform.connections SET ${fieldsToUpdate.join(', ')} WHERE id = $1`,
      values
    );
    return true;
  });
}

// Test-only helper to reset the running-tick guard between specs.
export function __resetSchedulerForTest(): void {
  running = false;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
