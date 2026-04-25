import { authenticator } from 'otplib';
import { toDataURL as qrToDataURL } from 'qrcode';
import { withTenantContext, withTenantTransaction } from '../db/connection';
import { encryptSecret, decryptSecret } from '../lib/encrypted-column';
import { AppError } from '../middleware/error-handler';
import { config } from '../config';

// otplib defaults: 30s step, 6 digits, SHA1 — RFC 6238 baseline that
// every Authenticator app supports. window=1 lets a code valid in the
// previous or next 30s slot pass too, smoothing over clock drift
// without weakening the cap. verify() is constant-time per otplib's
// docs (it uses crypto.timingSafeEqual on the HMAC output).
authenticator.options = { window: 1 };

const ISSUER = 'XRay';

interface EnrollResult {
  secret: string;
  otpauth_url: string;
  qr_data_url: string;
}

// Helper: TOTP otpauth label is conventionally "Issuer:account" so
// the authenticator-app entry shows both. Encoding the user's email
// (already known to the user) avoids a privacy regression vs. a
// random opaque label they wouldn't recognise on rotation.
function buildOtpauthUrl(secret: string, accountLabel: string): string {
  return authenticator.keyuri(accountLabel, ISSUER, secret);
}

// Step 9 helper — every TOTP service entry-point above takes
// (userId, tenantId) and operates under withTenantContext, gated by
// the tenant_isolation policy on platform.user_totp_secrets
// (migration 031). Confirmation status is held in confirmed_at:
// NULL = enrollment in flight, NOT NULL = active second factor.

export async function hasConfirmedTotp(userId: string, tenantId: string): Promise<boolean> {
  return withTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `SELECT confirmed_at IS NOT NULL AS confirmed
         FROM platform.user_totp_secrets
        WHERE user_id = $1`,
      [userId]
    );
    return r.rowCount === 1 && r.rows[0].confirmed === true;
  });
}

export async function enrollTotp(
  userId: string,
  tenantId: string,
  accountLabel: string
): Promise<EnrollResult> {
  const secret = authenticator.generateSecret();
  const otpauth = buildOtpauthUrl(secret, accountLabel);
  const qrDataUrl = await qrToDataURL(otpauth);
  const ciphertext = encryptSecret(secret);
  if (!ciphertext) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Failed to encrypt TOTP secret');
  }

  // UPSERT: if the user re-runs enrollment without confirming, replace
  // the in-flight secret. A confirmed row is preserved by the WHERE
  // guard — confirmed users must explicitly disable before re-enrolling.
  await withTenantTransaction(tenantId, async (client) => {
    const update = await client.query(
      `UPDATE platform.user_totp_secrets
          SET secret_ciphertext = $1,
              confirmed_at = NULL,
              created_at = NOW()
        WHERE user_id = $2 AND confirmed_at IS NULL`,
      [ciphertext, userId]
    );
    if (update.rowCount === 1) return;

    const existing = await client.query(
      `SELECT confirmed_at FROM platform.user_totp_secrets WHERE user_id = $1`,
      [userId]
    );
    if (existing.rowCount && existing.rows[0].confirmed_at) {
      throw new AppError(
        409,
        'TOTP_ALREADY_ENROLLED',
        'TOTP is already enrolled. Disable it before re-enrolling.'
      );
    }

    await client.query(
      `INSERT INTO platform.user_totp_secrets
         (user_id, tenant_id, secret_ciphertext, confirmed_at, created_at)
       VALUES ($1, $2, $3, NULL, NOW())`,
      [userId, tenantId, ciphertext]
    );
  });

  return { secret, otpauth_url: otpauth, qr_data_url: qrDataUrl };
}

// Verify the first code from the user's authenticator and flip
// confirmed_at. Returns true only on success — caller is responsible
// for issuing backup codes via backup-codes.service after this resolves.
export async function confirmTotp(
  userId: string,
  tenantId: string,
  code: string
): Promise<boolean> {
  return withTenantTransaction(tenantId, async (client) => {
    const r = await client.query(
      `SELECT secret_ciphertext, confirmed_at
         FROM platform.user_totp_secrets
        WHERE user_id = $1`,
      [userId]
    );
    if (!r.rowCount) {
      throw new AppError(400, 'TOTP_NOT_ENROLLED', 'No TOTP enrollment in flight');
    }
    if (r.rows[0].confirmed_at) {
      throw new AppError(409, 'TOTP_ALREADY_CONFIRMED', 'TOTP is already confirmed');
    }

    const secret = decryptSecret(
      r.rows[0].secret_ciphertext,
      `user_totp_secrets:secret_ciphertext:${userId}`
    );
    if (!secret) {
      throw new AppError(500, 'INTERNAL_ERROR', 'Failed to decrypt TOTP secret');
    }

    if (!authenticator.verify({ token: code, secret })) {
      // No attempts column on user_totp_secrets — a wrong code at
      // confirm time just bounces. The per-user-24h auth_attempts
      // ledger covers brute-force at the network layer.
      return false;
    }

    await client.query(
      `UPDATE platform.user_totp_secrets
          SET confirmed_at = NOW()
        WHERE user_id = $1`,
      [userId]
    );
    return true;
  });
}

// Login-time verify. Caller (auth.service MFA gate) has already
// confirmed the primary factor and is gating session issuance on
// this boolean. Constant-time comparison via otplib's HMAC compare.
export async function verifyTotp(
  userId: string,
  tenantId: string,
  code: string
): Promise<boolean> {
  return withTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `SELECT secret_ciphertext
         FROM platform.user_totp_secrets
        WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
      [userId]
    );
    if (!r.rowCount) return false;
    const secret = decryptSecret(
      r.rows[0].secret_ciphertext,
      `user_totp_secrets:secret_ciphertext:${userId}`
    );
    if (!secret) return false;
    return authenticator.verify({ token: code, secret });
  });
}

// Disable requires a current valid code. The DELETE cascades to
// platform.user_backup_codes (FK ON DELETE CASCADE in migration 032).
export async function disableTotp(
  userId: string,
  tenantId: string,
  currentCode: string
): Promise<void> {
  const valid = await verifyTotp(userId, tenantId, currentCode);
  if (!valid) {
    throw new AppError(400, 'INVALID_CODE', 'Incorrect TOTP code');
  }
  await withTenantContext(tenantId, async (client) => {
    await client.query(
      `DELETE FROM platform.user_totp_secrets WHERE user_id = $1`,
      [userId]
    );
  });
}

// config is imported only to anchor the import surface; downstream
// code may surface ISSUER/window via config in a future iteration.
void config;
