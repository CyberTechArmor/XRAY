import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { getServerHealth } from '../services/server-health.service';

const router = Router();
router.use(authenticateJWT, requirePermission('platform.admin'));

// ── GET /api/admin/health/server ────────────────────────────────
// Drives the Admin → Server health card. Returns the running
// process's uptime + the timestamps update.sh records into
// platform_settings (last cached run, last NO_CACHE refresh,
// last commit SHA). The frontend renders a stale-NO_CACHE warning
// when no_cache_stale=true so the operator gets nagged into
// running `NO_CACHE=1 ./update.sh` weekly to pull fresh Alpine
// CVE patches.
router.get('/server', async (_req, res, next) => {
  try {
    const info = await getServerHealth();
    res.json({ ok: true, data: info });
  } catch (err) {
    next(err);
  }
});

export default router;
