import { withClient, withTransaction } from '../db/connection';
import { generateCode, generateToken, hashToken, hashRefreshToken, generateUUID } from '../lib/crypto';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { signAccessToken, signRefreshToken } from './jwt.service';
import { sendTemplateEmail } from './email.service';
import * as auditService from './audit.service';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

interface MagicLink {
  id: string;
  email: string;
  code: string;
  token_hash: string;
  purpose: string;
  tenant_id: string | null;
  metadata: Record<string, unknown> | null;
  used: boolean;
  attempts: number;
  expires_at: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getUserPermissions(userId: string): Promise<string[]> {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT p.key
       FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       JOIN platform.users u ON u.role_id = rp.role_id
       WHERE u.id = $1`,
      [userId]
    );
    return result.rows.map((r: { key: string }) => r.key);
  });
}

async function createMagicLink(
  email: string,
  purpose: string,
  tenantId?: string,
  metadata?: Record<string, unknown>
): Promise<{ code: string; token: string }> {
  const code = generateCode(6);
  const token = generateToken(48);
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.magicLink.expiryMinutes * 60_000);

  await withClient(async (client) => {
    // Rate limit: check how many magic links sent to this email in the last hour
    const rateCheck = await client.query(
      `SELECT COUNT(*) FROM platform.magic_links
       WHERE email = $1 AND created_at > now() - INTERVAL '1 hour'`,
      [email]
    );
    if (parseInt(rateCheck.rows[0].count, 10) >= config.magicLink.rateLimitPerHour) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
    }

    await client.query(
      `INSERT INTO platform.magic_links (email, code, token_hash, purpose, tenant_id, metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [email, code, tokenHash, purpose, tenantId || null, metadata ? JSON.stringify(metadata) : null, expiresAt]
    );
  });

  return { code, token };
}

// ─── First-boot setup ───────────────────────────────────────────────────────

export async function getSetupStatus(): Promise<{ setupRequired: boolean }> {
  return withClient(async (client) => {
    const result = await client.query('SELECT COUNT(*) FROM platform.users');
    const count = parseInt(result.rows[0].count, 10);
    return { setupRequired: count === 0 };
  });
}

export async function firstBootSetup(input: {
  email: string;
  name: string;
  tenantName: string;
}): Promise<TokenPair> {
  return withTransaction(async (client) => {
    // Only allowed when zero users exist
    const countResult = await client.query('SELECT COUNT(*) FROM platform.users');
    if (parseInt(countResult.rows[0].count, 10) > 0) {
      throw new AppError(403, 'SETUP_COMPLETE', 'Platform is already set up');
    }

    // Seed roles if they don't exist (handles pre-existing DB without seed data)
    const roleCheck = await client.query("SELECT id FROM platform.roles WHERE slug = 'platform_admin'");
    if (roleCheck.rows.length === 0) {
      await client.query(`
        INSERT INTO platform.roles (name, slug, description, is_system, is_platform) VALUES
          ('Platform Admin', 'platform_admin', 'Full platform access', true, true),
          ('Owner',          'owner',          'Tenant owner',          true, false),
          ('Admin',          'admin',          'Tenant admin',          true, false),
          ('Member',         'member',         'Standard member',       true, false),
          ('Viewer',         'viewer',         'View-only access',      true, false)
        ON CONFLICT (slug) DO NOTHING
      `);

      // Seed permissions
      await client.query(`
        INSERT INTO platform.permissions (key, label, category, description) VALUES
          ('platform.admin',      'Platform admin',     'platform',    'Full platform administration'),
          ('account.view',        'View account',       'account',     'View own profile and sessions'),
          ('account.edit',        'Edit account',       'account',     'Edit own profile'),
          ('users.view',          'View users',         'users',       'View team members'),
          ('users.manage',        'Manage users',       'users',       'Invite and manage users'),
          ('dashboards.view',     'View dashboards',    'dashboards',  'View dashboards'),
          ('dashboards.manage',   'Manage dashboards',  'dashboards',  'Create and edit dashboards'),
          ('connections.view',    'View connections',    'connections', 'View data connections'),
          ('connections.manage',  'Manage connections',  'connections', 'Manage data connections'),
          ('billing.view',        'View billing',       'billing',     'View plan and invoices'),
          ('billing.manage',      'Manage billing',     'billing',     'Change plan'),
          ('audit.view',          'View audit log',     'audit',       'View audit log')
        ON CONFLICT (key) DO NOTHING
      `);

      // platform_admin gets all permissions
      await client.query(`
        INSERT INTO platform.role_permissions (role_id, permission_id)
          SELECT r.id, p.id FROM platform.roles r CROSS JOIN platform.permissions p
          WHERE r.slug = 'platform_admin'
        ON CONFLICT DO NOTHING
      `);

      // owner gets everything except platform.admin
      await client.query(`
        INSERT INTO platform.role_permissions (role_id, permission_id)
          SELECT r.id, p.id FROM platform.roles r CROSS JOIN platform.permissions p
          WHERE r.slug = 'owner' AND p.key != 'platform.admin'
        ON CONFLICT DO NOTHING
      `);

      console.log('[SETUP] Seeded roles and permissions');
    }

    // Get platform_admin role
    const roleResult = await client.query(
      "SELECT id FROM platform.roles WHERE slug = 'platform_admin'"
    );
    if (roleResult.rows.length === 0) {
      throw new AppError(500, 'ROLE_NOT_FOUND', "Role 'platform_admin' not found");
    }
    const roleId = roleResult.rows[0].id;

    // Create tenant
    const slug = input.tenantName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const tenantResult = await client.query(
      `INSERT INTO platform.tenants (name, slug) VALUES ($1, $2) RETURNING *`,
      [input.tenantName, slug]
    );
    const tenant = tenantResult.rows[0];

    // Create user
    const userResult = await client.query(
      `INSERT INTO platform.users (tenant_id, email, name, role_id, is_owner, status)
       VALUES ($1, $2, $3, $4, true, 'active')
       RETURNING *`,
      [tenant.id, input.email, input.name, roleId]
    );
    const user = userResult.rows[0];

    // Link owner to tenant
    await client.query(
      'UPDATE platform.tenants SET owner_user_id = $1 WHERE id = $2',
      [user.id, tenant.id]
    );

    // Create billing state
    await client.query(
      `INSERT INTO platform.billing_state (tenant_id, plan_tier, dashboard_limit, payment_status)
       VALUES ($1, 'free', 0, 'none')`,
      [tenant.id]
    );

    // Create warehouse schema
    const schemaName = `tn_${tenant.id.replace(/-/g, '')}`;
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

    // Get permissions
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [roleId]
    );
    const permissions = permResult.rows.map((r: { key: string }) => r.key);

    // Create session
    const refreshToken = signRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    const sessionResult = await client.query(
      `INSERT INTO platform.user_sessions (user_id, tenant_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, tenant.id, refreshTokenHash, expiresAt]
    );

    const accessToken = signAccessToken({
      sub: user.id,
      tid: tenant.id,
      role: 'platform_admin',
      permissions,
      is_owner: true,
      is_platform_admin: true,
    });

    auditService.log({
      tenantId: tenant.id,
      userId: user.id,
      action: 'user.setup',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { is_platform_admin: true, first_boot: true },
    });

    console.log(`[SETUP] Platform admin created: ${input.email}`);

    return {
      accessToken,
      refreshToken,
      sessionId: sessionResult.rows[0].id,
    };
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function initiateSignup(input: {
  email: string;
  name: string;
  tenantName: string;
}): Promise<{ message: string }> {
  // Check if email already exists
  const existing = await withClient(async (client) => {
    const result = await client.query(
      'SELECT id FROM platform.users WHERE email = $1',
      [input.email]
    );
    return result.rows[0];
  });

  if (existing) {
    throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists');
  }

  const { code, token } = await createMagicLink(input.email, 'signup', undefined, {
    name: input.name,
    tenantName: input.tenantName,
  });

  try {
    await sendTemplateEmail('signup_verification', input.email, {
      name: input.name,
      code,
      link: `${config.webauthn.origin}/auth/verify?token=${token}&purpose=signup`,
    });
  } catch (err) {
    // Log but don't expose SMTP errors to caller
    console.error('Failed to send signup email:', err);
  }

  return { message: 'Verification email sent. Please check your inbox.' };
}

export async function initiateLogin(email: string): Promise<{ message: string }> {
  // Check if user exists
  const user = await withClient(async (client) => {
    const result = await client.query(
      'SELECT id, tenant_id, name FROM platform.users WHERE email = $1 AND status = $2',
      [email, 'active']
    );
    return result.rows[0];
  });

  if (!user) {
    // Don't reveal whether user exists — still return success
    return { message: 'If an account exists, a login link has been sent.' };
  }

  const { code, token } = await createMagicLink(email, 'login', user.tenant_id);

  try {
    await sendTemplateEmail('login_code', email, {
      name: user.name,
      code,
      link: `${config.webauthn.origin}/auth/verify?token=${token}&purpose=login`,
    });
  } catch (err) {
    console.error('Failed to send login email:', err);
  }

  return { message: 'If an account exists, a login link has been sent.' };
}

export async function verifyCode(input: {
  email: string;
  code: string;
}): Promise<MagicLink> {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT * FROM platform.magic_links
       WHERE email = $1 AND used = false AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.email]
    );

    const magicLink = result.rows[0] as MagicLink | undefined;
    if (!magicLink) {
      throw new AppError(400, 'INVALID_CODE', 'No valid verification code found');
    }

    if (magicLink.attempts >= config.magicLink.maxAttempts) {
      // Mark as used to prevent further attempts
      await client.query(
        'UPDATE platform.magic_links SET used = true WHERE id = $1',
        [magicLink.id]
      );
      throw new AppError(400, 'MAX_ATTEMPTS', 'Maximum verification attempts exceeded');
    }

    if (magicLink.code !== input.code) {
      await client.query(
        'UPDATE platform.magic_links SET attempts = attempts + 1 WHERE id = $1',
        [magicLink.id]
      );
      throw new AppError(400, 'INVALID_CODE', 'Incorrect verification code');
    }

    // Mark as used
    await client.query(
      'UPDATE platform.magic_links SET used = true WHERE id = $1',
      [magicLink.id]
    );

    return magicLink;
  });
}

export async function verifyToken(token: string): Promise<MagicLink> {
  const tokenHash = hashToken(token);

  return withClient(async (client) => {
    const result = await client.query(
      `SELECT * FROM platform.magic_links
       WHERE token_hash = $1 AND used = false AND expires_at > now()`,
      [tokenHash]
    );

    const magicLink = result.rows[0] as MagicLink | undefined;
    if (!magicLink) {
      throw new AppError(400, 'INVALID_TOKEN', 'Invalid or expired verification token');
    }

    // Mark as used
    await client.query(
      'UPDATE platform.magic_links SET used = true WHERE id = $1',
      [magicLink.id]
    );

    return magicLink;
  });
}

export async function completeSignup(magicLink: MagicLink): Promise<TokenPair> {
  const metadata = magicLink.metadata as { name: string; tenantName: string } | null;
  if (!metadata) {
    throw new AppError(400, 'INVALID_METADATA', 'Signup metadata missing');
  }

  return withTransaction(async (client) => {
    // Check if this is the first user on the platform (platform admin bootstrap)
    const userCountResult = await client.query('SELECT COUNT(*) FROM platform.users');
    const isFirstUser = parseInt(userCountResult.rows[0].count, 10) === 0;

    // Determine the role
    let roleSlug: string;
    let isPlatformAdmin = false;

    if (isFirstUser) {
      roleSlug = 'platform_admin';
      isPlatformAdmin = true;
    } else {
      roleSlug = 'owner';
    }

    const roleResult = await client.query(
      'SELECT id FROM platform.roles WHERE slug = $1',
      [roleSlug]
    );
    if (roleResult.rows.length === 0) {
      throw new AppError(500, 'ROLE_NOT_FOUND', `Role '${roleSlug}' not found`);
    }
    const roleId = roleResult.rows[0].id;

    // Create slug from tenant name
    const slug = metadata.tenantName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Create tenant
    const tenantResult = await client.query(
      `INSERT INTO platform.tenants (name, slug)
       VALUES ($1, $2)
       RETURNING *`,
      [metadata.tenantName, slug]
    );
    const tenant = tenantResult.rows[0];

    // Create user
    const userResult = await client.query(
      `INSERT INTO platform.users (tenant_id, email, name, role_id, is_owner, status)
       VALUES ($1, $2, $3, $4, true, 'active')
       RETURNING *`,
      [tenant.id, magicLink.email, metadata.name, roleId]
    );
    const user = userResult.rows[0];

    // Link owner to tenant
    await client.query(
      'UPDATE platform.tenants SET owner_user_id = $1 WHERE id = $2',
      [user.id, tenant.id]
    );

    // Create billing state for tenant
    await client.query(
      `INSERT INTO platform.billing_state (tenant_id, plan_tier, dashboard_limit, payment_status)
       VALUES ($1, 'free', 0, 'none')`,
      [tenant.id]
    );

    // Create warehouse schema
    const schemaName = `tn_${tenant.id.replace(/-/g, '')}`;
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

    // Get permissions for this user
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [roleId]
    );
    const permissions = permResult.rows.map((r: { key: string }) => r.key);

    // Create session
    const refreshToken = signRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    const sessionResult = await client.query(
      `INSERT INTO platform.user_sessions (user_id, tenant_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, tenant.id, refreshTokenHash, expiresAt]
    );

    const accessToken = signAccessToken({
      sub: user.id,
      tid: tenant.id,
      role: roleSlug,
      permissions,
      is_owner: true,
      is_platform_admin: isPlatformAdmin,
    });

    auditService.log({
      tenantId: tenant.id,
      userId: user.id,
      action: 'user.signup',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { is_platform_admin: isPlatformAdmin },
    });

    return {
      accessToken,
      refreshToken,
      sessionId: sessionResult.rows[0].id,
    };
  });
}

export async function completeLogin(magicLink: MagicLink): Promise<TokenPair> {
  return withTransaction(async (client) => {
    const userResult = await client.query(
      `SELECT u.*, r.slug as role_slug
       FROM platform.users u
       JOIN platform.roles r ON r.id = u.role_id
       WHERE u.email = $1 AND u.status = 'active'`,
      [magicLink.email]
    );

    if (userResult.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found or inactive');
    }

    const user = userResult.rows[0];

    // Update last login
    await client.query(
      'UPDATE platform.users SET last_login_at = now() WHERE id = $1',
      [user.id]
    );

    // Get permissions
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [user.role_id]
    );
    const permissions = permResult.rows.map((r: { key: string }) => r.key);

    const isPlatformAdmin = user.role_slug === 'platform_admin';

    // Create session
    const refreshToken = signRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    const sessionResult = await client.query(
      `INSERT INTO platform.user_sessions (user_id, tenant_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, user.tenant_id, refreshTokenHash, expiresAt]
    );

    const accessToken = signAccessToken({
      sub: user.id,
      tid: user.tenant_id,
      role: user.role_slug,
      permissions,
      is_owner: user.is_owner,
      is_platform_admin: isPlatformAdmin,
    });

    auditService.log({
      tenantId: user.tenant_id,
      userId: user.id,
      action: 'user.login',
      resourceType: 'user',
      resourceId: user.id,
    });

    return {
      accessToken,
      refreshToken,
      sessionId: sessionResult.rows[0].id,
    };
  });
}

export async function initiateRecovery(email: string): Promise<{ message: string }> {
  const user = await withClient(async (client) => {
    const result = await client.query(
      'SELECT id, tenant_id, name FROM platform.users WHERE email = $1 AND status = $2',
      [email, 'active']
    );
    return result.rows[0];
  });

  if (!user) {
    // Don't reveal whether user exists
    return { message: 'If an account exists, a recovery email has been sent.' };
  }

  const { code, token } = await createMagicLink(email, 'verify', user.tenant_id);

  try {
    await sendTemplateEmail('account_recovery', email, {
      name: user.name,
      code,
      link: `${config.webauthn.origin}/auth/recover?token=${token}`,
    });
  } catch (err) {
    console.error('Failed to send recovery email:', err);
  }

  return { message: 'If an account exists, a recovery email has been sent.' };
}

export async function refreshSession(refreshTokenHash: string): Promise<TokenPair> {
  return withTransaction(async (client) => {
    // Find existing session
    const sessionResult = await client.query(
      `SELECT s.*, u.role_id, u.is_owner, u.email, u.tenant_id, r.slug as role_slug
       FROM platform.user_sessions s
       JOIN platform.users u ON u.id = s.user_id
       JOIN platform.roles r ON r.id = u.role_id
       WHERE s.refresh_token_hash = $1 AND s.expires_at > now()`,
      [refreshTokenHash]
    );

    if (sessionResult.rows.length === 0) {
      throw new AppError(401, 'INVALID_SESSION', 'Session expired or invalid');
    }

    const session = sessionResult.rows[0];
    const isPlatformAdmin = session.role_slug === 'platform_admin';

    // Rotate refresh token
    const newRefreshToken = signRefreshToken();
    const newRefreshTokenHash = hashRefreshToken(newRefreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    await client.query(
      `UPDATE platform.user_sessions
       SET refresh_token_hash = $1, expires_at = $2, last_active_at = now()
       WHERE id = $3`,
      [newRefreshTokenHash, expiresAt, session.id]
    );

    // Get permissions
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [session.role_id]
    );
    const permissions = permResult.rows.map((r: { key: string }) => r.key);

    const accessToken = signAccessToken({
      sub: session.user_id,
      tid: session.tenant_id,
      role: session.role_slug,
      permissions,
      is_owner: session.is_owner,
      is_platform_admin: isPlatformAdmin,
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      sessionId: session.id,
    };
  });
}

export async function logout(sessionId: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      'DELETE FROM platform.user_sessions WHERE id = $1',
      [sessionId]
    );
  });
}

export async function createSession(
  userId: string,
  tenantId: string,
  deviceInfo?: Record<string, unknown>
): Promise<TokenPair> {
  return withTransaction(async (client) => {
    const userResult = await client.query(
      `SELECT u.*, r.slug as role_slug
       FROM platform.users u
       JOIN platform.roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    const user = userResult.rows[0];
    const isPlatformAdmin = user.role_slug === 'platform_admin';

    const permissions = await getUserPermissions(userId);

    const refreshToken = signRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    const sessionResult = await client.query(
      `INSERT INTO platform.user_sessions (user_id, tenant_id, refresh_token_hash, device_info, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, tenantId, refreshTokenHash, deviceInfo ? JSON.stringify(deviceInfo) : null, expiresAt]
    );

    const accessToken = signAccessToken({
      sub: userId,
      tid: tenantId,
      role: user.role_slug,
      permissions,
      is_owner: user.is_owner,
      is_platform_admin: isPlatformAdmin,
    });

    return {
      accessToken,
      refreshToken,
      sessionId: sessionResult.rows[0].id,
    };
  });
}
