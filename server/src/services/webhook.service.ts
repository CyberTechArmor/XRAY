import { getPool, withClient } from '../db/connection';
import { generateToken } from '../lib/crypto';
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
      [params.tenantId, params.name, params.url, secret, params.events || ['account.created'], params.createdBy]
    );

    audit.log({
      tenantId: params.tenantId,
      userId: params.createdBy,
      action: 'webhook.created',
      resourceType: 'webhook',
      resourceId: result.rows[0].id,
      metadata: { name: params.name, url: params.url },
    });

    return result.rows[0];
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
    const result = await client.query(`SELECT * FROM platform.webhooks WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
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
      `UPDATE platform.webhooks SET ${sets.join(', ')} WHERE id = $${idx} AND tenant_id = $${idx + 1} RETURNING *`,
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
      [newSecret, id, tenantId]
    );
    if (result.rows.length === 0) return null;
    return { secret: newSecret };
  });
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
    const events: string[] = w.events || [];
    return events.includes(event) || events.includes('*');
  });

  for (const wh of matching) {
    const body = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString(), webhook_id: wh.id });
    const signature = wh.secret
      ? crypto.createHmac('sha256', wh.secret).update(body).digest('hex')
      : '';

    fetch(wh.target_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Event': event,
        'X-Webhook-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    }).then(async (res) => {
      if (res.ok) {
        getPool().query(`UPDATE platform.webhooks SET last_triggered_at = now(), failure_count = 0 WHERE id = $1`, [wh.id]).catch(() => {});
      } else {
        getPool().query(`UPDATE platform.webhooks SET failure_count = failure_count + 1, updated_at = now() WHERE id = $1`, [wh.id]).catch(() => {});
      }
    }).catch(() => {
      getPool().query(`UPDATE platform.webhooks SET failure_count = failure_count + 1, updated_at = now() WHERE id = $1`, [wh.id]).catch(() => {});
    });
  }
}
