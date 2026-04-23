import { Router } from 'express';
import { AppError } from '../middleware/error-handler';
import {
  dispatchFanOut,
  getFanOutSecret,
  compareSecrets,
  type FanOutRequest,
} from '../services/fan-out.service';

// Public-ish integration endpoints. These do NOT use the tenant JWT
// middleware — auth for fan-out rides on a per-integration shared
// secret, not on a user session. The one endpoint here is the fan-out
// dispatcher n8n calls on its own cron.
//
// Other integration concerns (tenant-facing /my-integrations, OAuth
// connect/callback, admin CRUD) live under their existing route files
// (connection.routes.ts, oauth.routes.ts, admin.routes.ts) — this file
// exists specifically for the shared-secret entry points.

const router = Router();

// POST /api/integrations/:slug/fan-out
// Caller auth: Authorization: Bearer <fan_out_secret> (compared
// constant-time against the decrypted integrations.fan_out_secret).
// 401 on absent/mismatched auth, 404 on unknown slug, 409 when the
// integration row has no fan_out_secret configured.
router.post('/:slug/fan-out', async (req, res, next) => {
  try {
    const slug = req.params.slug;
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authorization: Bearer <fan_out_secret> required');
    }
    const presented = auth.slice('Bearer '.length).trim();

    const record = await getFanOutSecret(slug);
    if (!record) {
      // Either no integration with this slug, or it has no secret
      // configured. 401 in both cases so an attacker can't probe which
      // slugs exist.
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or missing fan-out credentials');
    }
    if (!compareSecrets(presented, record.secret)) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or missing fan-out credentials');
    }
    if (record.integrationStatus !== 'active') {
      throw new AppError(
        409,
        'INTEGRATION_NOT_ACTIVE',
        `Integration '${slug}' is ${record.integrationStatus}; only active integrations can fan out`
      );
    }

    const body = (req.body || {}) as {
      target_url?: unknown;
      window?: unknown;
      metadata?: unknown;
      idempotency_key?: unknown;
    };
    if (typeof body.target_url !== 'string' || body.target_url.length === 0) {
      throw new AppError(400, 'INVALID_TARGET_URL', 'target_url (string) is required');
    }
    // Basic URL hygiene — reject non-http(s). Leaves per-tenant URL
    // allowlisting to a later hardening step.
    if (!/^https?:\/\//i.test(body.target_url)) {
      throw new AppError(400, 'INVALID_TARGET_URL', 'target_url must be http(s)://');
    }

    const req0: FanOutRequest = {
      targetUrl: body.target_url,
      window:
        body.window && typeof body.window === 'object'
          ? (body.window as Record<string, unknown>)
          : null,
      metadata:
        body.metadata && typeof body.metadata === 'object'
          ? (body.metadata as Record<string, unknown>)
          : null,
      idempotencyKey: typeof body.idempotency_key === 'string' ? body.idempotency_key : null,
    };

    const summary = await dispatchFanOut(slug, req0);
    res.json({ ok: true, data: summary });
  } catch (err) {
    next(err);
  }
});

export default router;
