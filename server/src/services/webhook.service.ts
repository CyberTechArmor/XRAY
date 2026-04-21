import { getPool, withClient } from '../db/connection';
import { generateToken } from '../lib/crypto';
import { encryptSecret, decryptSecret } from '../lib/encrypted-column';
import * as audit from './audit.service';
import crypto from 'crypto';

async function bypassRLS(client: import('pg').PoolClient) {
  await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
}

interface CreateWebhookParams {
  tenantId: string;
  name: string;
  url: string;
  events?: string[];
  createdBy: string;
}

interface UpdateWebhookParams {
  name?: string;
  url?: string;
  events?: string[];
  isActive?: boolean;
}

/**
 * Create a new outbound webhook.
 * Generates a signing secret for HMAC verification.
 */
export async function createWebhook(params: CreateWebhookParams) {
  return withClient(async (client) => {
    await bypassRLS(client);
    const secret = generateToken(32);

    const result = await client.query(
      `INSERT INTO platform.webhooks (tenant_id, name, target_url, secret, events, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [params.tenantId, params.name, params.url, encryptSecret(secret), params.events || ['account.created'], params.createdBy]
    );

    audit.log({
      tenantId: params.tenantId,
      userId: params.createdBy,
      action: 'webhook.created',
      resourceType: 'webhook',
      resourceId: result.rows[0].id,
      metadata: { name: params.name, url: params.url },
    });

    // Return plaintext secret to the caller — this is the only time
    // it's revealed; the DB row holds the enc:v1: envelope.
    return { ...result.rows[0], secret };
  });
}

/**
 * List all webhooks for a tenant.
 */
export async function listAllWebhooks(tenantId: string) {
  return withClient(async (client) => {
    await bypassRLS(client);
    const result = await client.query(
      `SELECT id, tenant_id, name, target_url, events, is_active,
              last_triggered_at, failure_count, created_by, created_at, updated_at
       FROM platform.webhooks WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    return result.rows;
  });
}

export async function getWebhook(id: string, tenantId: string) {
  return withClient(async (client) => {
    await bypassRLS(client);
    const result = await client.query(
      `SELECT id, tenant_id, name, target_url, events, is_active,
              last_triggered_at, failure_count, created_by, created_at, updated_at
       FROM platform.webhooks WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] || null;
  });
}

export async function updateWebhook(id: string, tenantId: string, params: UpdateWebhookParams) {
  return withClient(async (client) => {
    await bypassRLS(client);
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    let idx = 1;
    if (params.name !== undefined) { sets.push(`name = $${idx}`); values.push(params.name); idx++; }
    if (params.url !== undefined) { sets.push(`target_url = $${idx}`); values.push(params.url); idx++; }
    if (params.events !== undefined) { sets.push(`events = $${idx}`); values.push(params.events); idx++; }
    if (params.isActive !== undefined) { sets.push(`is_active = $${idx}`); values.push(params.isActive); idx++; }
    values.push(id, tenantId);
    const result = await client.query(
      `UPDATE platform.webhooks SET ${sets.join(', ')} WHERE id = $${idx} AND tenant_id = $${idx + 1}
       RETURNING id, tenant_id, name, target_url, events, is_active,
                 last_triggered_at, failure_count, created_by, created_at, updated_at`,
      values
    );
    return result.rows[0] || null;
  });
}

export async function deleteWebhook(id: string, tenantId: string, deletedBy: string): Promise<boolean> {
  return withClient(async (client) => {
    await bypassRLS(client);
    const result = await client.query(
      `DELETE FROM platform.webhooks WHERE id = $1 AND tenant_id = $2 RETURNING id, name`,
      [id, tenantId]
    );
    if (result.rows.length === 0) return false;
    audit.log({ tenantId, userId: deletedBy, action: 'webhook.deleted', resourceType: 'webhook', resourceId: id,
      metadata: { name: result.rows[0].name } });
    return true;
  });
}

export async function regenerateSecret(id: string, tenantId: string): Promise<{ secret: string } | null> {
  return withClient(async (client) => {
    await bypassRLS(client);
    const newSecret = generateToken(32);
    const result = await client.query(
      `UPDATE platform.webhooks SET secret = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3 RETURNING id`,
      [encryptSecret(newSecret), id, tenantId]
    );
    if (result.rows.length === 0) return null;
    return { secret: newSecret };
  });
}

/**
 * Send an HTTP POST to a single webhook and update its status.
 */
async function sendWebhook(wh: { id: string; target_url: string; secret: string | null }, event: string, payload: Record<string, unknown>): Promise<boolean> {
  const body = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString(), webhook_id: wh.id });
  const plaintextSecret = decryptSecret(wh.secret, `webhooks:secret:${wh.id}`);
  const signature = plaintextSecret
    ? crypto.createHmac('sha256', plaintextSecret).update(body).digest('hex')
    : '';

  try {
    const res = await fetch(wh.target_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Event': event,
        'X-Webhook-Signature': signature,
        'User-Agent': 'XRay-Webhook/1.0',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      await getPool().query(`UPDATE platform.webhooks SET last_triggered_at = now(), failure_count = 0 WHERE id = $1`, [wh.id]).catch(() => {});
      return true;
    } else {
      console.error(`Webhook ${wh.id} delivery failed: ${res.status} ${res.statusText}`);
      await getPool().query(`UPDATE platform.webhooks SET failure_count = failure_count + 1, updated_at = now() WHERE id = $1`, [wh.id]).catch(() => {});
      return false;
    }
  } catch (err) {
    console.error(`Webhook ${wh.id} delivery error:`, err instanceof Error ? err.message : err);
    await getPool().query(`UPDATE platform.webhooks SET failure_count = failure_count + 1, updated_at = now() WHERE id = $1`, [wh.id]).catch(() => {});
    return false;
  }
}

/**
 * Dispatch an event to all matching active webhooks for a tenant.
 * Signs the payload with HMAC-SHA256 using the webhook secret.
 */
export async function dispatchEvent(tenantId: string, event: string, payload: Record<string, unknown>) {
  const webhooks = await withClient(async (client) => {
    await bypassRLS(client);
    const result = await client.query(
      `SELECT id, target_url, secret, events FROM platform.webhooks
       WHERE tenant_id = $1 AND is_active = true`,
      [tenantId]
    );
    return result.rows;
  });

  const matching = webhooks.filter(w => {
    // PostgreSQL TEXT[] may come back as a string "{a,b,c}" depending on driver config
    let events: string[] = w.events || [];
    if (typeof events === 'string') {
      events = (events as string).replace(/^\{|\}$/g, '').split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    return events.includes(event) || events.includes('*');
  });

  // Fire all webhooks concurrently (fire-and-forget from caller's perspective)
  const promises = matching.map(wh => sendWebhook(wh, event, payload));
  Promise.allSettled(promises).catch(() => {});
}

/**
 * Send a test event directly to a specific webhook, bypassing event filter.
 */
export async function testWebhook(webhookId: string, tenantId: string): Promise<{ success: boolean; error?: string }> {
  const wh = await withClient(async (client) => {
    await bypassRLS(client);
    const result = await client.query(
      `SELECT id, target_url, secret FROM platform.webhooks WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
      [webhookId, tenantId]
    );
    return result.rows[0] || null;
  });

  if (!wh) return { success: false, error: 'Webhook not found or inactive' };

  const ok = await sendWebhook(wh, 'webhook.test', {
    message: 'This is a test event from XRay',
    webhook_id: webhookId,
  });

  return ok ? { success: true } : { success: false, error: 'Delivery failed — check target URL and server logs' };
}
