import { getPool } from '../db/connection';
import { generateToken, hashToken } from '../lib/crypto';
import * as audit from './audit.service';

const API_KEY_PREFIX = 'xray_';

interface CreateApiKeyParams {
  name: string;
  scopes: string[];
  createdBy: string;
  tenantId?: string;
  expiresAt?: string;
}

interface ApiKeyRow {
  id: string;
  tenant_id: string | null;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_by: string;
  is_active: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

/**
 * Create a new API key. Returns the full key only once — it is never stored.
 */
export async function createApiKey(params: CreateApiKeyParams) {
  const pool = getPool();
  const rawKey = generateToken(32); // 256-bit random token
  const fullKey = `${API_KEY_PREFIX}${rawKey}`;
  const keyHash = hashToken(fullKey);
  const keyPrefix = fullKey.slice(0, 12); // "xray_XXXXXXX" visible prefix

  const result = await pool.query(
    `INSERT INTO platform.api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, tenant_id, name, key_prefix, scopes, created_by, is_active, expires_at, created_at`,
    [
      params.tenantId || null,
      params.name,
      keyPrefix,
      keyHash,
      params.scopes,
      params.createdBy,
      params.expiresAt || null,
    ]
  );

  audit.log({
    tenantId: params.tenantId || '00000000-0000-0000-0000-000000000000',
    userId: params.createdBy,
    action: 'api_key.created',
    resourceType: 'api_key',
    resourceId: result.rows[0].id,
    metadata: { name: params.name, scopes: params.scopes },
  });

  return {
    ...result.rows[0],
    key: fullKey, // Only returned once at creation time
  };
}

/**
 * List all API keys (never exposes the full key).
 */
export async function listApiKeys(): Promise<ApiKeyRow[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, tenant_id, name, key_prefix, scopes, created_by, is_active, last_used_at, expires_at, created_at
     FROM platform.api_keys
     ORDER BY created_at DESC`
  );
  return result.rows;
}

/**
 * Revoke (deactivate) an API key.
 */
export async function revokeApiKey(id: string, revokedBy: string): Promise<ApiKeyRow | null> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE platform.api_keys SET is_active = false WHERE id = $1 RETURNING *`,
    [id]
  );
  if (result.rows.length === 0) return null;

  audit.log({
    tenantId: result.rows[0].tenant_id || '00000000-0000-0000-0000-000000000000',
    userId: revokedBy,
    action: 'api_key.revoked',
    resourceType: 'api_key',
    resourceId: id,
    metadata: { name: result.rows[0].name },
  });

  return result.rows[0];
}

/**
 * Validate a bearer token that is an API key (starts with xray_).
 * Returns the key record if valid, null otherwise.
 * Also updates last_used_at.
 */
export async function validateApiKey(fullKey: string): Promise<ApiKeyRow | null> {
  if (!fullKey.startsWith(API_KEY_PREFIX)) return null;

  const pool = getPool();
  const keyHash = hashToken(fullKey);

  const result = await pool.query(
    `SELECT id, tenant_id, name, key_prefix, scopes, created_by, is_active, last_used_at, expires_at, created_at
     FROM platform.api_keys
     WHERE key_hash = $1 AND is_active = true`,
    [keyHash]
  );

  if (result.rows.length === 0) return null;

  const key = result.rows[0];

  // Check expiry
  if (key.expires_at && new Date(key.expires_at) < new Date()) {
    return null;
  }

  // Update last_used_at (fire-and-forget)
  pool.query(
    `UPDATE platform.api_keys SET last_used_at = now() WHERE id = $1`,
    [key.id]
  ).catch(() => {});

  return key;
}

/**
 * Get a single API key by ID.
 */
export async function getApiKey(id: string): Promise<ApiKeyRow | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, tenant_id, name, key_prefix, scopes, created_by, is_active, last_used_at, expires_at, created_at
     FROM platform.api_keys WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}
