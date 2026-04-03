import { Router } from 'express';
import * as dashboardService from '../services/dashboard.service';

const router = Router();

// In-memory cache for public dashboard renders (30 min TTL)
const shareCache = new Map<string, { data: any; ts: number }>();
const SHARE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/** Clear cache entries for a specific token or all entries for a dashboard */
export function clearShareCache(token?: string) {
  if (token) {
    shareCache.delete(token);
  } else {
    shareCache.clear();
  }
}

// GET /:token - render public shared dashboard (no auth, token-based)
router.get('/:token', async (req, res, next) => {
  try {
    const token = req.params.token;
    const now = Date.now();

    // Check cache
    const cached = shareCache.get(token);
    if (cached && (now - cached.ts) < SHARE_CACHE_TTL) {
      res.set('X-Cache', 'HIT');
      res.json({
        ok: true,
        data: cached.data,
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }

    const data = await dashboardService.renderPublicDashboard(token);

    // Dispatch dashboard.public_accessed webhook event (fire-and-forget)
    dashboardService.getPublicDashboard(token).then(dash => {
      import('../services/webhook.service').then(wh => {
        wh.dispatchEvent(dash.tenant_id, 'dashboard.public_accessed', {
          dashboardId: dash.id,
          dashboardName: dash.name,
          publicToken: token,
        });
      });
    }).catch(() => {});

    // Store in cache
    shareCache.set(token, { data, ts: now });

    // Evict old entries periodically
    if (shareCache.size > 100) {
      for (const [key, val] of shareCache) {
        if (now - val.ts > SHARE_CACHE_TTL) shareCache.delete(key);
      }
    }

    res.set('X-Cache', 'MISS');
    res.json({
      ok: true,
      data,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
