import { createHmac } from 'crypto';
import { withAdminClient } from '../db/connection';
import { decryptSecret } from '../lib/encrypted-column';

// Seed-on-connect webhook (migration 048).
//
// Fires once per (tenant × integration) connection — only on the
// INSERT path of connection creation, not on UPDATE (which would
// re-fire on every OAuth refresh, which we don't want).
//
// Contract: POST integration.seed_url with a JSON body. If the
// integration has fan_out_secret set, also include an
// X-XRay-Signature: sha256=<hex> header — HMAC-SHA256 of the raw
// body using the (decrypted) fan_out_secret as the key. Receivers
// can verify the signature to confirm the post is from XRay.
//
// Fire-and-forget: failures are logged + audited but never block
// the connection-creation response. The receiving end is best-effort
// — operators should run idempotent backfill so a missed delivery
// can be replayed by re-clicking Connect (which would update, not
// insert, so it WOULDN'T re-fire) or by the operator running their
// backfill manually.

const REQUEST_TIMEOUT_MS = 5_000;

interface SeedHookPayload {
  event: 'connection.created';
  tenant_id: string;
  tenant_slug: string | null;
  integration_slug: string;
  connection_id: string;
  // ISO 8601 UTC. Receiver can use it for replay-protection windowing.
  timestamp: string;
}

interface IntegrationSeedConfig {
  slug: string;
  seed_url: string | null;
  fan_out_secret: string | null;  // ciphertext or null
}

async function loadIntegrationSeedConfig(integrationId: string): Promise<IntegrationSeedConfig | null> {
  return withAdminClient(async (client) => {
    const result = await client.query<IntegrationSeedConfig>(
      `SELECT slug, seed_url, fan_out_secret
         FROM platform.integrations WHERE id = $1`,
      [integrationId]
    );
    return result.rows[0] || null;
  });
}

async function loadTenantSlug(tenantId: string): Promise<string | null> {
  return withAdminClient(async (client) => {
    const result = await client.query<{ slug: string | null }>(
      'SELECT slug FROM platform.tenants WHERE id = $1',
      [tenantId]
    );
    return result.rows[0]?.slug ?? null;
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
    const integration = await loadIntegrationSeedConfig(input.integrationId);
    if (!integration) return;
    const url = (integration.seed_url || '').trim();
    if (!url) return;

    const tenantSlug = await loadTenantSlug(input.tenantId);
    const payload: SeedHookPayload = {
      event: 'connection.created',
      tenant_id: input.tenantId,
      tenant_slug: tenantSlug,
      integration_slug: integration.slug,
      connection_id: input.connectionId,
      timestamp: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'XRay-SeedHook/1',
      'X-XRay-Event': payload.event,
    };

    if (integration.fan_out_secret) {
      // Decrypt the stored secret and compute HMAC-SHA256 over the
      // raw body. Header shape mirrors GitHub's signature scheme so
      // operators familiar with that pattern can reuse a verifier.
      const secret = decryptSecret(
        integration.fan_out_secret,
        `integrations:fan_out_secret:${input.integrationId}`
      );
      if (secret) {
        const sig = createHmac('sha256', secret).update(body).digest('hex');
        headers['X-XRay-Signature'] = `sha256=${sig}`;
      }
    }

    // Node's global fetch with AbortController for the timeout — keeps
    // the deps minimal (no axios / got / etc.). Failures are caught by
    // the outer try/catch.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: ac.signal,
      });
      if (!resp.ok) {
        console.warn(
          `[seed-hook] non-2xx response from ${url}: ${resp.status} ${resp.statusText}`
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Log but don't throw — connection creation already committed.
    console.warn(
      `[seed-hook] failed to fire seed hook for integration=${input.integrationId} tenant=${input.tenantId}:`,
      err instanceof Error ? err.message : err
    );
  }
}
