import { Request, Response, NextFunction } from 'express';
import { withAdminClient } from '../db/connection';
import { ipHash, isPublicSurface } from './rate-limit';

// Step 9 per-email-24h tier. Backed by platform.auth_attempts
// (migration 035). Counts failures in the trailing 24h for
// (email_lower, success=false). 20 failures → hard 429 with
// retry-after; banner threshold ≤ 10 remaining is surfaced in the
// 200 / 4xx response body so the auth modal can render the warning
// without a separate endpoint.
//
// Storage rationale (CLAUDE.md / step-9 kickoff): DB-backed, not
// in-memory. The counter must survive container restarts —
// otherwise an attacker waits for redeploy to reset their bucket.
//
// The ledger is read pre-tenant-context (we don't know the user's
// tenant until after primary auth resolves), so the middleware
// runs under withAdminClient. Migration 035's table has no RLS,
// matching the magic_links / platform_settings carve-out shape.
// New code does NOT use withClient directly — withAdminClient is
// the named opt-in per CLAUDE.md.

const WINDOW_HOURS = 24;
const HARD_LIMIT = 20;
const BANNER_THRESHOLD = 10;

function pickEmail(req: Request): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body.email === 'string' && body.email.trim()) {
    return body.email.trim().toLowerCase();
  }
  return null;
}

export interface AttemptCounters {
  failures_24h: number;
  remaining: number;
  retry_after_seconds: number | null;
}

async function countRecentFailures(emailLower: string): Promise<number> {
  return withAdminClient(async (client) => {
    const r = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM platform.auth_attempts
        WHERE email_lower = $1
          AND success = false
          AND attempted_at > NOW() - ($2 || ' hours')::interval`,
      [emailLower, String(WINDOW_HOURS)]
    );
    return r.rows[0]?.n ?? 0;
  });
}

async function oldestFailureWithinWindow(emailLower: string): Promise<Date | null> {
  return withAdminClient(async (client) => {
    const r = await client.query(
      `SELECT MIN(attempted_at) AS first
         FROM platform.auth_attempts
        WHERE email_lower = $1
          AND success = false
          AND attempted_at > NOW() - ($2 || ' hours')::interval`,
      [emailLower, String(WINDOW_HOURS)]
    );
    const first = r.rows[0]?.first;
    return first ? new Date(first) : null;
  });
}

// Express middleware. If the request body carries an `email`, look
// up the per-email-24h failure count and reject at HARD_LIMIT. Below
// the limit, attach `req.attemptCounters` so the route handler can
// surface remaining count in successful responses.
export async function perEmailAuthAttemptLimiter(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (isPublicSurface(req)) return next();
  const emailLower = pickEmail(req);
  if (!emailLower) return next();

  try {
    const failures = await countRecentFailures(emailLower);
    const remaining = Math.max(0, HARD_LIMIT - failures);

    if (failures >= HARD_LIMIT) {
      const oldest = await oldestFailureWithinWindow(emailLower);
      const resetAt = oldest
        ? oldest.getTime() + WINDOW_HOURS * 3600 * 1000
        : Date.now() + WINDOW_HOURS * 3600 * 1000;
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({
        ok: false,
        error: {
          code: 'AUTH_LOCKOUT',
          message: 'Too many failed login attempts. Try again later or contact support.',
          details: {
            failures_24h: failures,
            remaining: 0,
            retry_after_seconds: retryAfter,
          },
        },
        meta: {
          request_id: req.headers['x-request-id'] || '',
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    (req as any).attemptCounters = {
      failures_24h: failures,
      remaining,
      retry_after_seconds: null,
    } as AttemptCounters;
    next();
  } catch (err) {
    // Don't take the auth surface down on a rate-limit-table outage.
    // Log and pass through; the IP+device limiter still applies.
    console.error('[auth-attempts] counter lookup failed:', err);
    next();
  }
}

// Helper called by handlers after the auth attempt resolves. Records
// (email_lower, ip_hash, success) in platform.auth_attempts. Never
// throws — best-effort logging path.
export async function recordAuthAttempt(
  emailLower: string,
  req: Request,
  success: boolean
): Promise<void> {
  if (!emailLower) return;
  const e = emailLower.trim().toLowerCase();
  if (!e) return;
  try {
    await withAdminClient(async (client) => {
      await client.query(
        `INSERT INTO platform.auth_attempts (email_lower, ip_hash, success)
         VALUES ($1, $2, $3)`,
        [e, ipHash(req) || null, success]
      );
    });
  } catch (err) {
    console.error('[auth-attempts] insert failed:', err);
  }
}

// Helper for routes that want to surface remaining count alongside
// a success response — the auth modal renders the ≤10 banner from
// this number even on the success path so the user knows their
// next bad attempt counts.
export function attachAttemptCounters(req: Request, body: Record<string, unknown>): void {
  const c = (req as any).attemptCounters as AttemptCounters | undefined;
  if (!c) return;
  if (c.remaining <= BANNER_THRESHOLD) {
    body.attempts_remaining = c.remaining;
  }
}
