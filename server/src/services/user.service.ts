import { withAdminClient, withTenantContext, withTenantTransaction } from '../db/connection';
import { AppError } from '../middleware/error-handler';
import * as webauthn from '../lib/webauthn';
import * as auditService from './audit.service';

export async function getUserTenants(userId: string) {
  return withAdminClient(async (client) => {
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
  return withAdminClient(async (client) => {

    // Check if new permission columns exist
    const colCheck = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'platform' AND table_name = 'users' AND column_name = 'has_admin'`
    );
    const hasNewCols = colCheck.rows.length > 0;

    const extraCols = hasNewCols ? 'u.has_admin, u.has_billing, u.has_replay,' : 'false as has_admin, false as has_billing, false as has_replay,';
    const result = await client.query(
      `SELECT u.id, u.email, u.name, u.is_owner, u.auth_method, u.status, u.last_login_at,
              u.created_at, u.tenant_id, ${extraCols}
              r.name as role_name, r.slug as role_slug,
              r.is_platform as is_platform_admin,
              COALESCE(t.replay_enabled, false) as replay_enabled,
              COALESCE(t.replay_visible, false) as replay_visible
       FROM platform.users u
       JOIN platform.roles r ON r.id = u.role_id
       LEFT JOIN platform.tenants t ON t.id = u.tenant_id
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
  return withAdminClient(async (client) => {
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
  return withAdminClient(async (client) => {
    const result = await client.query(
      `SELECT id, device_name, backed_up, last_used_at, created_at
       FROM platform.user_passkeys WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows;
  });
}

export async function registerPasskey(userId: string) {
  return withAdminClient(async (client) => {
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
  return withAdminClient(async (client) => {
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
  return withAdminClient(async (client) => {
    const result = await client.query(
      'DELETE FROM platform.user_passkeys WHERE id = $1 AND user_id = $2 RETURNING id',
      [passkeyId, userId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Passkey not found');
  });
}

export async function listSessions(userId: string) {
  return withAdminClient(async (client) => {
    const result = await client.query(
      `SELECT id, device_info, last_active_at, created_at, expires_at
       FROM platform.user_sessions WHERE user_id = $1 ORDER BY last_active_at DESC`,
      [userId]
    );
    return result.rows;
  });
}

export async function revokeSession(userId: string, sessionId: string) {
  return withAdminClient(async (client) => {
    const result = await client.query(
      'DELETE FROM platform.user_sessions WHERE id = $1 AND user_id = $2 RETURNING id',
      [sessionId, userId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Session not found');
  });
}

export async function listUsers(tenantId: string, query: { page: number; limit: number }) {
  return withTenantContext(tenantId, async (client) => {
    const offset = (query.page - 1) * query.limit;

    // Check if new columns exist via information_schema (never fails)
    const colCheck = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'platform' AND table_name = 'users' AND column_name = 'has_admin'`
    );
    const extraCols = colCheck.rows.length > 0
      ? 'u.has_admin, u.has_billing, u.has_replay, u.tenant_id,'
      : 'false as has_admin, false as has_billing, false as has_replay, u.tenant_id,';

    const result = await client.query(
      `SELECT u.id, u.email, u.name, u.is_owner, u.status, u.last_login_at, u.created_at,
              ${extraCols}
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
  updates: { name?: string; roleId?: string; status?: string; has_admin?: boolean; has_billing?: boolean; has_replay?: boolean }
) {
  return withTenantContext(tenantId, async (client) => {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (updates.name !== undefined) { fields.push(`name = $${idx}`); values.push(updates.name); idx++; }
    if (updates.roleId !== undefined) { fields.push(`role_id = $${idx}`); values.push(updates.roleId); idx++; }
    if (updates.status !== undefined) { fields.push(`status = $${idx}`); values.push(updates.status); idx++; }
    if (updates.has_admin !== undefined) { fields.push(`has_admin = $${idx}`); values.push(updates.has_admin); idx++; }
    if (updates.has_billing !== undefined) { fields.push(`has_billing = $${idx}`); values.push(updates.has_billing); idx++; }
    if (updates.has_replay !== undefined) { fields.push(`has_replay = $${idx}`); values.push(updates.has_replay); idx++; }

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

// platform.users.preferences column is owned by the postgres bootstrap
// user and added by migration 050. Runtime ALTER TABLE attempts fail
// post-role-split with "must be owner of table users" — Postgres
// checks ownership before evaluating ADD COLUMN IF NOT EXISTS.

export async function getUserSettings(userId: string): Promise<Record<string, unknown>> {
  return withAdminClient(async (client) => {
    const result = await client.query('SELECT preferences FROM platform.users WHERE id = $1', [userId]);
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
    return result.rows[0].preferences || {};
  });
}

export async function updateUserSettings(userId: string, settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  return withAdminClient(async (client) => {
    const result = await client.query(
      `UPDATE platform.users SET preferences = COALESCE(preferences, '{}'::jsonb) || $1::jsonb WHERE id = $2 RETURNING preferences`,
      [JSON.stringify(settings), userId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
    return result.rows[0].preferences;
  });
}

// Step 10: GDPR Art. 17-style account deletion. Soft-delete +
// cascade-clear of credentials so the user is functionally
// removed but the audit trail (audit_log rows referring to this
// user_id) remains attributable for the 30-day retention
// window. A future scheduled job hard-purges status='deactivated'
// rows past the retention horizon — out of scope for step 10.
//
// Tenant-owner protection: if the caller is the tenant owner AND
// the tenant has any other active user, throw
// OWNER_DELETE_BLOCKED so the UI can surface the "transfer
// ownership first" message. The owner can delete themselves only
// when the tenant is empty.
export async function deleteOwnAccount(
  tenantId: string,
  userId: string,
): Promise<{ message: string }> {
  return withTenantTransaction(tenantId, async (client) => {
    const userRow = await client.query(
      `SELECT id, email, is_owner, status FROM platform.users WHERE id = $1`,
      [userId]
    );
    if (userRow.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }
    const user = userRow.rows[0];
    if (user.status === 'deactivated') {
      throw new AppError(400, 'ALREADY_DEACTIVATED', 'Account is already deactivated');
    }
    if (user.is_owner) {
      const otherActive = await client.query(
        `SELECT COUNT(*)::int AS n FROM platform.users
          WHERE tenant_id = $1 AND id <> $2 AND status = 'active'`,
        [tenantId, userId]
      );
      if (otherActive.rows[0].n > 0) {
        throw new AppError(
          409,
          'OWNER_DELETE_BLOCKED',
          'Transfer ownership before deleting your account.',
        );
      }
    }

    // Revoke active sessions for this user (any device, any browser).
    await client.query(
      `DELETE FROM platform.user_sessions WHERE user_id = $1`,
      [userId]
    );

    // Clear passkeys.
    await client.query(
      `DELETE FROM platform.user_passkeys WHERE user_id = $1`,
      [userId]
    );

    // Clear TOTP + backup codes. user_backup_codes cascades on the
    // user_id FK so the DELETE on user_totp_secrets isn't strictly
    // needed to clear the codes, but doing both explicitly is
    // belt-and-braces against a future schema change that breaks
    // the cascade.
    await client.query(
      `DELETE FROM platform.user_totp_secrets WHERE user_id = $1`,
      [userId]
    );
    await client.query(
      `DELETE FROM platform.user_backup_codes WHERE user_id = $1`,
      [userId]
    );

    // Inbox participation — leave message authorship attributed
    // (audit value) but remove participant rows so the deleted
    // user no longer surfaces in thread members lists.
    await client.query(
      `DELETE FROM platform.inbox_thread_participants WHERE user_id = $1`,
      [userId]
    );

    // Soft-delete the user. Email gets a unique suffix so the
    // (tenant_id, email) UNIQUE constraint doesn't block a future
    // signup with the same address. The original email is preserved
    // in the audit_log metadata below for the retention window.
    const newEmail = `${user.email}.deactivated.${Math.floor(Date.now() / 1000)}`;
    await client.query(
      `UPDATE platform.users
          SET status = 'deactivated',
              email = $2,
              updated_at = now()
        WHERE id = $1`,
      [userId, newEmail]
    );
  }).then(() => {
    // Audit-log AFTER the transaction commits so the row reflects
    // the final state. Fire-and-forget per audit.service convention.
    auditService.log({
      tenantId,
      userId,
      action: 'user.account.delete',
      resourceType: 'user',
      resourceId: userId,
      metadata: { soft_delete: true },
    });
    return { message: 'Account deactivated.' };
  });
}

export async function deleteUser(tenantId: string, userId: string): Promise<void> {
  return withAdminClient(async (client) => {
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
