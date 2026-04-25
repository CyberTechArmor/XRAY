import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Pure-logic + fake-pool specs for totp.service + backup-codes.service.
// Pattern follows fan-out.service.test.ts: lock the contracts that
// don't need a live Postgres by driving the service through a fake
// pg.Pool installed via db/connection.__setPoolForTest. The
// integration shape (RLS scoping, real disk writes) is covered by
// the cross-tenant probe in src/db/rls-probe.test.ts when
// PROBE_RLS=1 is set.

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

interface FakeClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
  release: () => void;
}

type Responder = (sql: string, params?: unknown[]) => { rows: any[]; rowCount: number };

function makeFakePool(respond: Responder) {
  const log: { sql: string; params?: unknown[] }[] = [];
  const client: FakeClient = {
    query: (sql: string, params?: unknown[]) => {
      log.push({ sql, params });
      return Promise.resolve(respond(sql, params));
    },
    release: () => {},
  };
  return {
    pool: {
      connect: () => Promise.resolve(client),
      on: () => {},
      end: () => Promise.resolve(),
    } as unknown as import('pg').Pool,
    log,
  };
}

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(async () => {
  const { __setPoolForTest } = await import('../db/connection');
  __setPoolForTest(null);
});

describe('totp.service round-trip (fake pool)', () => {
  it('enroll returns secret + otpauth_url + qr_data_url and stores enc:v1: ciphertext', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    let stored: string | undefined;
    const { pool, log } = makeFakePool((sql, params) => {
      if (sql.startsWith('UPDATE platform.user_totp_secrets')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('SELECT confirmed_at')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('INSERT INTO platform.user_totp_secrets')) {
        stored = (params as any[])[2] as string;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    __setPoolForTest(pool);

    const { enrollTotp } = await import('./totp.service');
    const result = await enrollTotp(USER_ID, TENANT_ID, 'user@example.com');

    expect(result.secret).toMatch(/^[A-Z2-7]+$/);
    expect(result.otpauth_url).toMatch(/^otpauth:\/\/totp\/XRay:/);
    expect(result.otpauth_url).toContain(`secret=${result.secret}`);
    expect(result.qr_data_url).toMatch(/^data:image\/png;base64,/);
    expect(stored).toBeDefined();
    expect(stored!.startsWith('enc:v1:')).toBe(true);
    // set_config for RLS context fired before the data SQL.
    expect(log.some((l) => l.sql.includes('app.current_tenant'))).toBe(true);
  });

  it('confirm verifies the live code, flips confirmed_at, and rejects wrong codes', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { encryptSecret } = await import('../lib/encrypted-column');
    const { authenticator } = await import('otplib');
    const secret = authenticator.generateSecret();
    const ciphertext = encryptSecret(secret)!;
    let confirmed = false;

    const { pool } = makeFakePool((sql) => {
      if (sql.startsWith('SELECT secret_ciphertext')) {
        return {
          rows: [{ secret_ciphertext: ciphertext, confirmed_at: null }],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE platform.user_totp_secrets')) {
        confirmed = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    __setPoolForTest(pool);

    const { confirmTotp } = await import('./totp.service');
    expect(await confirmTotp(USER_ID, TENANT_ID, '000000')).toBe(false);
    expect(confirmed).toBe(false);

    const liveCode = authenticator.generate(secret);
    expect(await confirmTotp(USER_ID, TENANT_ID, liveCode)).toBe(true);
    expect(confirmed).toBe(true);
  });

  it('verifyTotp returns false when no confirmed row exists and true for a live code', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { encryptSecret } = await import('../lib/encrypted-column');
    const { authenticator } = await import('otplib');
    const secret = authenticator.generateSecret();
    const ciphertext = encryptSecret(secret)!;

    const { pool: emptyPool } = makeFakePool(() => ({ rows: [], rowCount: 0 }));
    __setPoolForTest(emptyPool);
    const { verifyTotp } = await import('./totp.service');
    expect(await verifyTotp(USER_ID, TENANT_ID, '123456')).toBe(false);

    const { pool: confirmedPool } = makeFakePool((sql) => {
      if (sql.startsWith('SELECT secret_ciphertext')) {
        return { rows: [{ secret_ciphertext: ciphertext }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    __setPoolForTest(confirmedPool);
    const liveCode = authenticator.generate(secret);
    expect(await verifyTotp(USER_ID, TENANT_ID, liveCode)).toBe(true);
    expect(await verifyTotp(USER_ID, TENANT_ID, '000000')).toBe(false);
  });

  it('disableTotp requires a valid current code and emits a DELETE on success', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { encryptSecret } = await import('../lib/encrypted-column');
    const { authenticator } = await import('otplib');
    const secret = authenticator.generateSecret();
    const ciphertext = encryptSecret(secret)!;

    let deleted = false;
    const { pool } = makeFakePool((sql) => {
      if (sql.startsWith('SELECT secret_ciphertext')) {
        return { rows: [{ secret_ciphertext: ciphertext }], rowCount: 1 };
      }
      if (sql.startsWith('DELETE FROM platform.user_totp_secrets')) {
        deleted = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    __setPoolForTest(pool);

    const { disableTotp } = await import('./totp.service');
    await expect(disableTotp(USER_ID, TENANT_ID, '000000')).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    expect(deleted).toBe(false);

    const liveCode = authenticator.generate(secret);
    await disableTotp(USER_ID, TENANT_ID, liveCode);
    expect(deleted).toBe(true);
  });
});

describe('backup-codes.service round-trip (fake pool)', () => {
  it('generateBackupCodes inserts N hashed rows and returns plaintext codes in xxxx-xxxx-xxxx format', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const inserts: { user: string; tenant: string; hash: string }[] = [];
    const { pool } = makeFakePool((sql, params) => {
      if (sql.startsWith('INSERT INTO platform.user_backup_codes')) {
        const p = params as any[];
        inserts.push({ user: p[0], tenant: p[1], hash: p[2] });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    __setPoolForTest(pool);

    const { generateBackupCodes } = await import('./backup-codes.service');
    const codes = await generateBackupCodes(USER_ID, TENANT_ID, 8);
    expect(codes).toHaveLength(8);
    for (const c of codes) {
      expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    }
    expect(inserts).toHaveLength(8);
    expect(inserts.every((i) => i.user === USER_ID && i.tenant === TENANT_ID)).toBe(true);
    // Hashes must be bcrypt-shaped — never the plaintext code.
    expect(inserts.every((i) => i.hash.startsWith('$2'))).toBe(true);
  });

  it('verifyAndConsumeBackupCode matches a known code, flips used_at, and refuses replay', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const bcrypt = (await import('bcrypt')).default;
    const plaintext = 'abcd-efgh-ijkl';
    const hash = await bcrypt.hash(plaintext, 4);
    let used = false;

    const { pool } = makeFakePool((sql) => {
      if (sql.startsWith('SELECT id, code_hash')) {
        if (used) return { rows: [], rowCount: 0 };
        return { rows: [{ id: 'row-1', code_hash: hash }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE platform.user_backup_codes')) {
        used = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    __setPoolForTest(pool);

    const { verifyAndConsumeBackupCode } = await import('./backup-codes.service');
    expect(await verifyAndConsumeBackupCode(USER_ID, TENANT_ID, plaintext)).toBe(true);
    expect(used).toBe(true);
    // Replay: the row is now consumed; SELECT returns no unused rows.
    expect(await verifyAndConsumeBackupCode(USER_ID, TENANT_ID, plaintext)).toBe(false);
  });

  it('verifyAndConsumeBackupCode normalises whitespace + case and rejects malformed input', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const bcrypt = (await import('bcrypt')).default;
    const stored = 'wxyz-2345-jkmn';
    const hash = await bcrypt.hash(stored, 4);

    const { pool } = makeFakePool((sql) => {
      if (sql.startsWith('SELECT id, code_hash')) {
        return { rows: [{ id: 'row-1', code_hash: hash }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE platform.user_backup_codes')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    __setPoolForTest(pool);

    const { verifyAndConsumeBackupCode } = await import('./backup-codes.service');
    // Same code, different casing/spacing — must still match.
    expect(
      await verifyAndConsumeBackupCode(USER_ID, TENANT_ID, '  WXYZ 2345 JKMN  ')
    ).toBe(true);
  });

  it('verifyAndConsumeBackupCode returns false on length-mismatch input without scanning', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    let scanned = false;
    const { pool } = makeFakePool((sql) => {
      if (sql.startsWith('SELECT id, code_hash')) {
        scanned = true;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    __setPoolForTest(pool);

    const { verifyAndConsumeBackupCode } = await import('./backup-codes.service');
    expect(await verifyAndConsumeBackupCode(USER_ID, TENANT_ID, 'short')).toBe(false);
    expect(scanned).toBe(false);
  });

  it('countUnusedCodes returns the integer from the SELECT', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeFakePool((sql) => {
      if (sql.startsWith('SELECT COUNT(*)::int')) {
        return { rows: [{ n: 5 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    __setPoolForTest(pool);

    const { countUnusedCodes } = await import('./backup-codes.service');
    expect(await countUnusedCodes(USER_ID, TENANT_ID)).toBe(5);
  });
});
