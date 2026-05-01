import { describe, it, expect, beforeAll, afterEach } from 'vitest';

// Pure-logic + retry-seam specs for fan-out.service. Matches the
// pattern in oauth-scheduler.test.ts / integration.service.test.ts:
// DB-backed dispatcher behavior is covered by higher-level integration
// tests once the route stack is live. Here we lock the contracts that
// don't need a Postgres:
//   - constant-time secret compare rejects length-mismatch fast
//   - delivery idempotency key is deterministic per (run, tenant)
//   - deliverEnvelope retries up to 3 attempts with backoff and
//     stops on 2xx, surfaces last HTTP / thrown error on exhaustion

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

async function importLib() {
  return await import('./fan-out.service');
}

afterEach(async () => {
  const lib = await importLib();
  lib.__setFetcherForTest(null);
  lib.__setSleeperForTest(null);
});

describe('fan-out.service.compareSecrets', () => {
  it('matches identical strings', async () => {
    const { compareSecrets } = await importLib();
    expect(compareSecrets('abc123', 'abc123')).toBe(true);
  });

  it('rejects a different string of equal length', async () => {
    const { compareSecrets } = await importLib();
    expect(compareSecrets('abc123', 'abd123')).toBe(false);
  });

  it('rejects length mismatch without crashing (constant-time compare precondition)', async () => {
    const { compareSecrets } = await importLib();
    expect(compareSecrets('abc', 'abcd')).toBe(false);
    expect(compareSecrets('', 'abc')).toBe(false);
    expect(compareSecrets('abc', '')).toBe(false);
  });

  it('rejects empty strings (never a valid shared secret)', async () => {
    const { compareSecrets } = await importLib();
    expect(compareSecrets('', '')).toBe(false);
  });
});

describe('fan-out.service.computeDeliveryIdempotencyKey', () => {
  it('is deterministic per (fanOutId, tenantId)', async () => {
    const { computeDeliveryIdempotencyKey } = await importLib();
    const a = computeDeliveryIdempotencyKey('run-1', 'tenant-A');
    const b = computeDeliveryIdempotencyKey('run-1', 'tenant-A');
    expect(a).toBe(b);
  });

  it('differs when the run id differs', async () => {
    const { computeDeliveryIdempotencyKey } = await importLib();
    const a = computeDeliveryIdempotencyKey('run-1', 'tenant-A');
    const b = computeDeliveryIdempotencyKey('run-2', 'tenant-A');
    expect(a).not.toBe(b);
  });

  it('differs when the tenant id differs', async () => {
    const { computeDeliveryIdempotencyKey } = await importLib();
    const a = computeDeliveryIdempotencyKey('run-1', 'tenant-A');
    const b = computeDeliveryIdempotencyKey('run-1', 'tenant-B');
    expect(a).not.toBe(b);
  });

  it('returns a 64-char hex string (sha256)', async () => {
    const { computeDeliveryIdempotencyKey } = await importLib();
    const key = computeDeliveryIdempotencyKey('x', 'y');
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('fan-out.service.deliverEnvelope', () => {
  it('returns ok on first-attempt 2xx without sleeping', async () => {
    const lib = await importLib();
    let calls = 0;
    let sleeps = 0;
    lib.__setFetcherForTest(async () => {
      calls++;
      return { ok: true, status: 200, text: async () => '' };
    });
    lib.__setSleeperForTest(async () => {
      sleeps++;
    });
    const result = await lib.deliverEnvelope('https://example/n8n', 'tok', 'idk', { a: 1 });
    expect(result).toEqual({ ok: true, attempts: 1, error: null });
    expect(calls).toBe(1);
    // No sleep on the first (immediate) attempt; backoff only precedes retries.
    expect(sleeps).toBe(0);
  });

  it('retries up to 3 times on transient 5xx and returns the final HTTP error', async () => {
    const lib = await importLib();
    let calls = 0;
    const sleepDelays: number[] = [];
    lib.__setFetcherForTest(async () => {
      calls++;
      return { ok: false, status: 503, text: async () => 'Service Unavailable' };
    });
    lib.__setSleeperForTest(async (ms) => {
      sleepDelays.push(ms);
    });
    const result = await lib.deliverEnvelope('https://example/n8n', 'tok', 'idk', {});
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error).toMatch(/HTTP 503/);
    expect(calls).toBe(3);
    // Backoff precedes retries only — attempt 1 is immediate, then 2s
    // before attempt 2, then 4s before attempt 3. Two sleep calls total.
    expect(sleepDelays).toEqual([2000, 4000]);
  });

  it('stops early on success after a first-attempt failure', async () => {
    const lib = await importLib();
    const statuses = [500, 200];
    let calls = 0;
    lib.__setFetcherForTest(async () => {
      const status = statuses[calls]!;
      calls++;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => '',
      };
    });
    lib.__setSleeperForTest(async () => {});
    const result = await lib.deliverEnvelope('https://example/n8n', 'tok', 'idk', {});
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('captures a thrown fetcher error as the last_error and retries', async () => {
    const lib = await importLib();
    let calls = 0;
    lib.__setFetcherForTest(async () => {
      calls++;
      throw new Error('ECONNREFUSED');
    });
    lib.__setSleeperForTest(async () => {});
    const result = await lib.deliverEnvelope('https://example/n8n', 'tok', 'idk', {});
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error).toBe('ECONNREFUSED');
    expect(calls).toBe(3);
  });

  it('sends the expected headers on every attempt (envelope JWT + idempotency key)', async () => {
    const lib = await importLib();
    const captured: Array<{ method: string; headers: Record<string, string>; body: string }> = [];
    lib.__setFetcherForTest(async (_url: string, init) => {
      captured.push(init);
      return { ok: true, status: 200, text: async () => '' };
    });
    lib.__setSleeperForTest(async () => {});
    await lib.deliverEnvelope('https://example/n8n', 'the-jwt', 'idk-hash', { ping: 'pong' });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.headers['Content-Type']).toBe('application/json');
    expect(captured[0]!.headers['Authorization']).toBe('Bearer the-jwt');
    expect(captured[0]!.headers['Idempotency-Key']).toBe('idk-hash');
    expect(JSON.parse(captured[0]!.body)).toEqual({ ping: 'pong' });
  });
});
