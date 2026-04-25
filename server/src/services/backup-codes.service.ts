import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { withTenantContext, withTenantTransaction } from '../db/connection';
import { AppError } from '../middleware/error-handler';

// Step 9 backup-code surface. Pairs with totp.service: every
// confirmed TOTP enrollment yields exactly one batch of these codes,
// shown to the user once at confirm time and stored only as bcrypt
// hashes in platform.user_backup_codes (migration 032).
//
// Format: three 4-character base32-ish groups joined with hyphens
// (e.g. "abcd-efgh-ijkl"). 12 base32-character entropy ≈ 60 bits —
// well above the brute-force margin given we cap to 8 codes per
// user and the per-day rate limiter blocks at 20 failures anyway.

const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 4;
const DEFAULT_BATCH = 8;
const BCRYPT_COST = 12;

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function generateCode(): string {
  const buf = randomBytes(CODE_GROUPS * CODE_GROUP_LEN);
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    let s = '';
    for (let i = 0; i < CODE_GROUP_LEN; i++) {
      s += ALPHABET[buf[g * CODE_GROUP_LEN + i] % ALPHABET.length];
    }
    groups.push(s);
  }
  return groups.join('-');
}

function normalizeInput(code: string): string {
  // Accept user input with arbitrary case/whitespace/dashes and
  // canonicalise before hash compare. Storage is always lower-case
  // dash-grouped.
  const stripped = code.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (stripped.length !== CODE_GROUPS * CODE_GROUP_LEN) return '';
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    groups.push(stripped.slice(g * CODE_GROUP_LEN, (g + 1) * CODE_GROUP_LEN));
  }
  return groups.join('-');
}

export async function generateBackupCodes(
  userId: string,
  tenantId: string,
  count: number = DEFAULT_BATCH
): Promise<string[]> {
  const codes = Array.from({ length: count }, generateCode);
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(c, BCRYPT_COST)));

  await withTenantTransaction(tenantId, async (client) => {
    for (let i = 0; i < codes.length; i++) {
      await client.query(
        `INSERT INTO platform.user_backup_codes (user_id, tenant_id, code_hash)
         VALUES ($1, $2, $3)`,
        [userId, tenantId, hashes[i]]
      );
    }
  });

  return codes;
}

// Replaces the entire batch — invalidates everything previously
// issued (used or unused) and writes a fresh set. Caller surfaces
// the new plaintext codes to the user once.
export async function regenerateBackupCodes(
  userId: string,
  tenantId: string,
  count: number = DEFAULT_BATCH
): Promise<string[]> {
  const codes = Array.from({ length: count }, generateCode);
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(c, BCRYPT_COST)));

  await withTenantTransaction(tenantId, async (client) => {
    await client.query(
      `DELETE FROM platform.user_backup_codes WHERE user_id = $1`,
      [userId]
    );
    for (let i = 0; i < codes.length; i++) {
      await client.query(
        `INSERT INTO platform.user_backup_codes (user_id, tenant_id, code_hash)
         VALUES ($1, $2, $3)`,
        [userId, tenantId, hashes[i]]
      );
    }
  });

  return codes;
}

// Atomic "verify and consume" — bcrypt-compare against every unused
// row, and on the first match flip used_at via a conditional UPDATE
// guarded on used_at IS NULL so a concurrent retry can't double-spend
// the same code. Returns true only if the UPDATE actually flipped
// the row.
export async function verifyAndConsumeBackupCode(
  userId: string,
  tenantId: string,
  code: string
): Promise<boolean> {
  const normalized = normalizeInput(code);
  if (!normalized) return false;

  return withTenantTransaction(tenantId, async (client) => {
    const r = await client.query(
      `SELECT id, code_hash FROM platform.user_backup_codes
        WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );
    for (const row of r.rows) {
      const match = await bcrypt.compare(normalized, row.code_hash);
      if (match) {
        const upd = await client.query(
          `UPDATE platform.user_backup_codes
              SET used_at = NOW()
            WHERE id = $1 AND used_at IS NULL`,
          [row.id]
        );
        return upd.rowCount === 1;
      }
    }
    return false;
  });
}

export async function countUnusedCodes(userId: string, tenantId: string): Promise<number> {
  return withTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM platform.user_backup_codes
        WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );
    return r.rows[0]?.n ?? 0;
  });
}

void AppError;
