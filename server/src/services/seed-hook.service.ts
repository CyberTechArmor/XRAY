import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { withAdminClient } from '../db/connection';
import { decryptSecret } from '../lib/encrypted-column';

// Seed-on-connect webhook (migration 048).
//
// Fires on every fresh connection INSERT — including reconnects, since
// disconnect now DELETEs the row (migration 052 + connection.routes
// disconnect path). Receivers must be idempotent on backfill.
//
// Wire format
// -----------
//   POST integration.seed_url
//     Authorization: Bearer <jwt>          ← HS256, key = fan_out_secret
//     Content-Type: application/json
//     X-XRay-Event: connection.created
//     User-Agent: XRay-SeedHook/2
//
//   Body (no secrets — credential lives only in the JWT):
//     { event, tenant_id, tenant_slug, integration_slug,
//       connection_id, auth_method, timestamp }
//
//   JWT claims (HS256, exp 60s):
//     iss=xray, aud=n8n-seed-hook
//     sub=<tenant_id>, jti=<uuid>
//     tenant_id, tenant_slug, integration, connection_id,
//     auth_method, access_token, timestamp
//
// n8n verifies the Authorization header with its JWT Auth node
// (algorithm HS256, secret = the fan_out_secret you copied from
// Admin → Integrations) and reads access_token from the verified
// payload to call the upstream (HouseCall Pro, etc.).
//
// Fire-and-forget: failures are logged but never block the connection
// INSERT response. The connection row is already committed by the
// time this runs.

const SEED_HOOK_AUDIENCE = 'n8n-seed-hook';
const SEED_HOOK_ISSUER = 'xray';
const SEED_HOOK_JWT_EXPIRY_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 5_000;

interface SeedHookEnvelope {
  event: 'connection.created';
  tenant_id: string;
  tenant_slug: string | null;
  integration_slug: string;
  connection_id: string;
  auth_method: 'api_key' | 'oauth' | null;
  timestamp: string;
}

interface SeedHookContext {
  slug: string;
  seedUrl: string;
  fanOutSecret: string;          // decrypted
  tenantSlug: string | null;
  authMethod: 'api_key' | 'oauth' | null;
  accessToken: string | null;    // decrypted; null if creds aren't on the row
}

async function loadSeedHookContext(input: {
  integrationId: string;
  tenantId: string;
  connectionId: string;
}): Promise<SeedHookContext | null> {
  return withAdminClient(async (client) => {
    const integ = await client.query<{
      slug: string;
      seed_url: string | null;
      fan_out_secret: string | null;
    }>(
      `SELECT slug, seed_url, fan_out_secret
         FROM platform.integrations WHERE id = $1`,
      [input.integrationId]
    );
    const row = integ.rows[0];
    if (!row) return null;
    const url = (row.seed_url || '').trim();
    if (!url) return null;
    if (!row.fan_out_secret) {
      // We require a signing secret — the contract is JWT-authenticated.
      // An integration with seed_url but no fan_out_secret is a
      // mis-configuration, not a "send unsigned" path.
      console.warn(
        `[seed-hook] integration ${row.slug} has seed_url set but no fan_out_secret; skipping fire`
      );
      return null;
    }
    const fanOutSecret = decryptSecret(
      row.fan_out_secret,
      `integrations:fan_out_secret:${input.integrationId}`
    );

    const tenant = await client.query<{ slug: string | null }>(
      'SELECT slug FROM platform.tenants WHERE id = $1',
      [input.tenantId]
    );
    const tenantSlug = tenant.rows[0]?.slug ?? null;

    const conn = await client.query<{
      auth_method: 'api_key' | 'oauth' | null;
      api_key: string | null;
      oauth_access_token: string | null;
    }>(
      `SELECT auth_method, api_key, oauth_access_token
         FROM platform.connections WHERE id = $1`,
      [input.connectionId]
    );
    const c = conn.rows[0];
    let accessToken: string | null = null;
    const authMethod: 'api_key' | 'oauth' | null = c?.auth_method ?? null;
    if (c) {
      if (c.auth_method === 'api_key' && c.api_key) {
        accessToken = decryptSecret(
          c.api_key,
          `connections:api_key:${input.connectionId}`
        );
      } else if (c.auth_method === 'oauth' && c.oauth_access_token) {
        accessToken = decryptSecret(
          c.oauth_access_token,
          `connections:oauth_access_token:${input.connectionId}`
        );
      }
    }
    return {
      slug: row.slug,
      seedUrl: url,
      fanOutSecret,
      tenantSlug,
      authMethod,
      accessToken,
    };
  });
}

export async function fireSeedHookForConnection(input: {
  integrationId: string;
  tenantId: string;
  connectionId: string;
}): Promise<void> {
  // All side-effects are wrapped in a try/catch so an HTTP error or
  // network blip on the receiver never propagates back to the caller
  // (which is mid-INSERT of a connection row). The seed hook is
  // strictly best-effort.
  try {
    const ctx = await loadSeedHookContext(input);
    if (!ctx) return;

    const envelope: SeedHookEnvelope = {
      event: 'connection.created',
      tenant_id: input.tenantId,
      tenant_slug: ctx.tenantSlug,
      integration_slug: ctx.slug,
      connection_id: input.connectionId,
      auth_method: ctx.authMethod,
      timestamp: new Date().toISOString(),
    };

    const jti = randomUUID();
    const token = jwt.sign(
      {
        ...envelope,
        sub: input.tenantId,
        jti,
        // Credential travels only in the JWT — body keeps no secrets.
        access_token: ctx.accessToken,
      },
      ctx.fanOutSecret,
      {
        algorithm: 'HS256',
        issuer: SEED_HOOK_ISSUER,
        audience: SEED_HOOK_AUDIENCE,
        expiresIn: SEED_HOOK_JWT_EXPIRY_SECONDS,
      }
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'XRay-SeedHook/2',
      'Authorization': `Bearer ${token}`,
      'X-XRay-Event': envelope.event,
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(ctx.seedUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(envelope),
        signal: ac.signal,
      });
      if (!resp.ok) {
        console.warn(
          `[seed-hook] non-2xx response from ${ctx.seedUrl}: ${resp.status} ${resp.statusText}`
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn(
      `[seed-hook] failed to fire seed hook for integration=${input.integrationId} tenant=${input.tenantId}:`,
      err instanceof Error ? err.message : err
    );
  }
}
