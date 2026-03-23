import { withClient, PoolClient } from '../db/connection';
import { AppError } from '../middleware/error-handler';
import * as webauthn from '../lib/webauthn';

/** Bypass RLS — these service functions are already guarded by JWT + RBAC middleware */
async function bypassRLS(client: PoolClient) {
  await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
}

export async function getUserTenants(userId: string) {
  return withClient(async (client) => {
    await bypassRLS(client);
    // Get current user's email
    const userResult = await client.query('SELECT email FROM platform.users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
    const email = userResult.rows[0].email;

    // Find all active tenants this email belongs to
    const result = await client.query(
      `SELECT u.id as user_id, u.tenant_id, u.is_owner, t.name as tenant_name, r.slug as role_slug
       FROM platform.users u
       JOIN platform.tenants t ON t.id = u.tenant_id
       JOIN platform.roles r ON r.id = u.role_id
       WHERE u.email = $1 AND u.status = 'active' AND t.status NOT IN ('archived', 'suspended')
       ORDER BY t.name`,
      [email]
    );
    return result.rows.map((r: any) => ({
      id: r.tenant_id,
      name: r.tenant_name,
      role: r.role_slug,
      is_owner: r.is_owner,
      is_current: r.tenant_id === undefined, // will be set client-side
    }));
  });
}

export async function getProfile(userId: string) {
  return withClient(async (client) => {
    await bypassRLS(client);

    const result = await client.query(
      `SELECT u.id, u.email, u.name, u.is_owner, u.auth_method, u.status, u.last_login_at,
              u.created_at, u.tenant_id, r.name as role_name, r.slug as role_slug,
              r.is_platform as is_platform_admin
       FROM platform.users u
       JOIN platform.roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [userId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');

    const user = result.rows[0];

    // Fetch permissions for this user's role
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       JOIN platform.users u ON u.role_id = rp.role_id
       WHERE u.id = $1`,
      [userId]
    );
    user.permissions = permResult.rows.map((r: { key: string }) => r.key);
    user.is_platform_admin = user.role_slug === 'platform_admin';

    return user;
  });
}

export async function updateProfile(userId: string, updates: { name?: string }) {
  return withClient(async (client) => {
    await bypassRLS(client);
    if (!updates.name) throw new AppError(400, 'NO_UPDATES', 'No fields to update');
    const result = await client.query(
      `UPDATE platform.users SET name = $1, updated_at = now() WHERE id = $2 RETURNING id, name, email`,
      [updates.name, userId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
    return result.rows[0];
  });
}

export async function listPasskeys(userId: string) {
  return withClient(async (client) => {
    await bypassRLS(client);
    const result = await client.query(
      `SELECT id, device_name, backed_up, last_used_at, created_at
       FROM platform.user_passkeys WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows;
  });
}

export async function registerPasskey(userId: string) {
  return withClient(async (client) => {
    await bypassRLS(client);
    const userResult = await client.query(
      'SELECT id, email, name, tenant_id FROM platform.users WHERE id = $1', [userId]
    );
    if (userResult.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
    const user = userResult.rows[0];

    const existingPasskeys = await client.query(
      'SELECT credential_id, public_key, counter, transports FROM platform.user_passkeys WHERE user_id = $1',
      [userId]
    );

    const options = await webauthn.generateRegOptions(
      user.id,
      user.email,
      existingPasskeys.rows.map((p: { credential_id: Buffer; public_key: Buffer; counter: number; transports: string[] }) => ({
        credentialId: p.credential_id,
        publicKey: p.public_key,
        counter: p.counter,
        transports: p.transports,
      }))
    );

    // Store the challenge in user_sessions so verifyPasskeyRegistration can retrieve it
    const crypto = await import('crypto');
    const fakeHash = crypto.randomBytes(32).toString('hex');
    // Clean up any previous registration challenges for this user
    await client.query(
      `DELETE FROM platform.user_sessions WHERE user_id = $1 AND device_info->>'type' = 'passkey_registration'`,
      [userId]
    );
    await client.query(
      `INSERT INTO platform.user_sessions (user_id, tenant_id, refresh_token_hash, device_info, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '5 minutes')`,
      [userId, user.tenant_id, fakeHash, JSON.stringify({ type: 'passkey_registration', challenge: options.challenge })]
    );

    return options;
  });
}

export async function verifyPasskeyRegistration(userId: string, body: unknown) {
  return withClient(async (client) => {
    await bypassRLS(client);
    // Retrieve the pending challenge for this user
    const challengeResult = await client.query(
      `SELECT id, device_info FROM platform.user_sessions
       WHERE user_id = $1 AND device_info->>'type' = 'passkey_registration' AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (challengeResult.rows.length === 0) {
      throw new AppError(400, 'NO_CHALLENGE', 'No pending registration challenge found. Please start registration again.');
    }

    const expectedChallenge = challengeResult.rows[0].device_info.challenge;
    const verification = await webauthn.verifyRegResponse(
      body as import('@simplewebauthn/server/script/deps').RegistrationResponseJSON,
      expectedChallenge
    );

    if (!verification.verified || !verification.registrationInfo) {
      throw new AppError(400, 'VERIFICATION_FAILED', 'Passkey verification failed');
    }

    const { credentialID, credentialPublicKey, counter, credentialBackedUp } = verification.registrationInfo;

    // Get user's tenant_id for the passkey record
    const userRow = await client.query('SELECT tenant_id FROM platform.users WHERE id = $1', [userId]);
    const tenantId = userRow.rows[0]?.tenant_id;

    // Store the new passkey
    await client.query(
      `INSERT INTO platform.user_passkeys
         (user_id, tenant_id, credential_id, public_key, counter, backed_up)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        tenantId,
        Buffer.from(credentialID, 'base64url'),
        Buffer.from(credentialPublicKey),
        counter,
        credentialBackedUp,
      ]
    );

    // Clean up the registration challenge
    await client.query(
      `DELETE FROM platform.user_sessions WHERE user_id = $1 AND device_info->>'type' = 'passkey_registration'`,
      [userId]
    );

    return { verified: true };
  });
}

export async function revokePasskey(userId: string, passkeyId: string) {
  return withClient(async (client) => {
    await bypassRLS(client);
    const result = await client.query(
      'DELETE FROM platform.user_passkeys WHERE id = $1 AND user_id = $2 RETURNING id',
      [passkeyId, userId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Passkey not found');
  });
}

export async function listSessions(userId: string) {
  return withClient(async (client) => {
    await bypassRLS(client);
    const result = await client.query(
      `SELECT id, device_info, last_active_at, created_at, expires_at
       FROM platform.user_sessions WHERE user_id = $1 ORDER BY last_active_at DESC`,
      [userId]
    );
    return result.rows;
  });
}

export async function revokeSession(userId: string, sessionId: string) {
  return withClient(async (client) => {
    await bypassRLS(client);
    const result = await client.query(
      'DELETE FROM platform.user_sessions WHERE id = $1 AND user_id = $2 RETURNING id',
      [sessionId, userId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Session not found');
  });
}

export async function listUsers(tenantId: string, query: { page: number; limit: number }) {
  return withClient(async (client) => {
    await bypassRLS(client);
    const offset = (query.page - 1) * query.limit;
    const result = await client.query(
      `SELECT u.id, u.email, u.name, u.is_owner, u.status, u.last_login_at, u.created_at,
              r.name as role_name, r.slug as role_slug
       FROM platform.users u
       JOIN platform.roles r ON r.id = u.role_id
       WHERE u.tenant_id = $1
       ORDER BY u.created_at DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, query.limit, offset]
    );
    return result.rows;
  });
}

export async function updateUser(
  tenantId: string,
  userId: string,
  updates: { name?: string; roleId?: string; status?: string }
) {
  return withClient(async (client) => {
    await bypassRLS(client);
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (updates.name !== undefined) { fields.push(`name = $${idx}`); values.push(updates.name); idx++; }
    if (updates.roleId !== undefined) { fields.push(`role_id = $${idx}`); values.push(updates.roleId); idx++; }
    if (updates.status !== undefined) { fields.push(`status = $${idx}`); values.push(updates.status); idx++; }

    if (fields.length === 0) throw new AppError(400, 'NO_UPDATES', 'No fields to update');
    fields.push('updated_at = now()');
    values.push(userId, tenantId);

    const result = await client.query(
      `UPDATE platform.users SET ${fields.join(', ')} WHERE id = $${idx} AND tenant_id = $${idx + 1} RETURNING *`,
      values
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
    return result.rows[0];
  });
}

// ── User Settings (stored in preferences JSONB column) ──

export async function getUserSettings(userId: string): Promise<Record<string, unknown>> {
  return withClient(async (client) => {
    await bypassRLS(client);
    // Ensure preferences column exists
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    const result = await client.query('SELECT preferences FROM platform.users WHERE id = $1', [userId]);
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
    return result.rows[0].preferences || {};
  });
}

export async function updateUserSettings(userId: string, settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  return withClient(async (client) => {
    await bypassRLS(client);
    // Ensure preferences column exists
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    const result = await client.query(
      `UPDATE platform.users SET preferences = COALESCE(preferences, '{}'::jsonb) || $1::jsonb WHERE id = $2 RETURNING preferences`,
      [JSON.stringify(settings), userId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
    return result.rows[0].preferences;
  });
}

export async function deleteUser(tenantId: string, userId: string): Promise<void> {
  return withClient(async (client) => {
    await bypassRLS(client);
    // Check user exists and belongs to tenant
    const userCheck = await client.query(
      'SELECT id, is_owner FROM platform.users WHERE id = $1 AND tenant_id = $2',
      [userId, tenantId]
    );
    if (userCheck.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
    if (userCheck.rows[0].is_owner) throw new AppError(400, 'CANNOT_DELETE_OWNER', 'Cannot delete the tenant owner');

    // Remove from inbox thread participants
    await client.query('DELETE FROM platform.inbox_thread_participants WHERE user_id = $1', [userId]);
    // Remove sessions
    await client.query('DELETE FROM platform.user_sessions WHERE user_id = $1', [userId]);
    // Remove passkeys
    await client.query('DELETE FROM platform.passkeys WHERE user_id = $1', [userId]);
    // Delete user
    await client.query('DELETE FROM platform.users WHERE id = $1 AND tenant_id = $2', [userId, tenantId]);
  });
}
