import { getPool } from '../db/connection';
import { generateToken } from '../lib/crypto';
import * as audit from './audit.service';

interface CreateWebhookParams {
  connectionId: string;
  tenantId: string;
  name: string;
  events?: string[];
  createdBy: string;
}

interface UpdateWebhookParams {
  name?: string;
  events?: string[];
  isActive?: boolean;
}

interface WebhookRow {
  id: string;
  connection_id: string;
  tenant_id: string;
  name: string;
  url_token: string;
  secret: string | null;
  events: string[];
  is_active: boolean;
  last_triggered_at: string | null;
  failure_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * Create a new webhook for a connection.
 * Generates a unique URL token and HMAC signing secret.
 */
export async function createWebhook(params: CreateWebhookParams) {
  const pool = getPool();
  const urlToken = generateToken(24); // Unique URL path component
  const secret = generateToken(32);   // HMAC signing secret

  const result = await pool.query(
    `INSERT INTO platform.webhooks (connection_id, tenant_id, name, url_token, secret, events, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.connectionId,
      params.tenantId,
      params.name,
      urlToken,
      secret,
      params.events || ['data.push'],
      params.createdBy,
    ]
  );

  audit.log({
    tenantId: params.tenantId,
    userId: params.createdBy,
    action: 'webhook.created',
    resourceType: 'webhook',
    resourceId: result.rows[0].id,
    metadata: { name: params.name, connectionId: params.connectionId },
  });

  return result.rows[0];
}

/**
 * List all webhooks for a connection.
 */
export async function listWebhooks(connectionId: string, tenantId: string): Promise<WebhookRow[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, connection_id, tenant_id, name, url_token, events, is_active,
            last_triggered_at, failure_count, created_by, created_at, updated_at
     FROM platform.webhooks
     WHERE connection_id = $1 AND tenant_id = $2
     ORDER BY created_at DESC`,
    [connectionId, tenantId]
  );
  return result.rows;
}

/**
 * List all webhooks across all connections for a tenant.
 */
export async function listAllWebhooks(tenantId: string): Promise<WebhookRow[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT w.id, w.connection_id, w.tenant_id, w.name, w.url_token, w.events, w.is_active,
            w.last_triggered_at, w.failure_count, w.created_by, w.created_at, w.updated_at,
            c.name as connection_name
     FROM platform.webhooks w
     JOIN platform.connections c ON c.id = w.connection_id
     WHERE w.tenant_id = $1
     ORDER BY w.created_at DESC`,
    [tenantId]
  );
  return result.rows;
}

/**
 * Get a single webhook by ID.
 */
export async function getWebhook(id: string, tenantId: string): Promise<WebhookRow | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM platform.webhooks WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  return result.rows[0] || null;
}

/**
 * Update a webhook.
 */
export async function updateWebhook(id: string, tenantId: string, params: UpdateWebhookParams): Promise<WebhookRow | null> {
  const pool = getPool();
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [];
  let idx = 1;

  if (params.name !== undefined) {
    sets.push(`name = $${idx}`);
    values.push(params.name);
    idx++;
  }
  if (params.events !== undefined) {
    sets.push(`events = $${idx}`);
    values.push(params.events);
    idx++;
  }
  if (params.isActive !== undefined) {
    sets.push(`is_active = $${idx}`);
    values.push(params.isActive);
    idx++;
  }

  values.push(id, tenantId);
  const result = await pool.query(
    `UPDATE platform.webhooks SET ${sets.join(', ')} WHERE id = $${idx} AND tenant_id = $${idx + 1} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

/**
 * Delete a webhook.
 */
export async function deleteWebhook(id: string, tenantId: string, deletedBy: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM platform.webhooks WHERE id = $1 AND tenant_id = $2 RETURNING id, name, connection_id`,
    [id, tenantId]
  );
  if (result.rows.length === 0) return false;

  audit.log({
    tenantId,
    userId: deletedBy,
    action: 'webhook.deleted',
    resourceType: 'webhook',
    resourceId: id,
    metadata: { name: result.rows[0].name, connectionId: result.rows[0].connection_id },
  });

  return true;
}

/**
 * Regenerate the signing secret for a webhook.
 */
export async function regenerateSecret(id: string, tenantId: string): Promise<{ secret: string } | null> {
  const pool = getPool();
  const newSecret = generateToken(32);
  const result = await pool.query(
    `UPDATE platform.webhooks SET secret = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3 RETURNING id`,
    [newSecret, id, tenantId]
  );
  if (result.rows.length === 0) return null;
  return { secret: newSecret };
}

/**
 * Validate an inbound webhook request by url_token.
 * Returns the webhook + connection info if valid.
 */
export async function validateInboundWebhook(urlToken: string) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT w.*, c.name as connection_name, c.source_type, c.status as connection_status
     FROM platform.webhooks w
     JOIN platform.connections c ON c.id = w.connection_id
     WHERE w.url_token = $1 AND w.is_active = true`,
    [urlToken]
  );
  if (result.rows.length === 0) return null;

  const webhook = result.rows[0];

  // Update last_triggered_at (fire-and-forget)
  pool.query(
    `UPDATE platform.webhooks SET last_triggered_at = now(), failure_count = 0 WHERE id = $1`,
    [webhook.id]
  ).catch(() => {});

  return webhook;
}

/**
 * Record a webhook delivery failure.
 */
export async function recordFailure(id: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE platform.webhooks SET failure_count = failure_count + 1, updated_at = now() WHERE id = $1`,
    [id]
  ).catch(() => {});
}
