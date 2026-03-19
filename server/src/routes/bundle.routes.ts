import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import * as bundleService from '../services/bundle.service';

const router = Router();

// GET /dashboards - get tenant's dashboard bundle (JWT)
router.get('/dashboards', authenticateJWT, async (req, res, next) => {
  try {
    const result = await bundleService.getDashboardBundle(req.user!.tid);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// HEAD /dashboards - get dashboard bundle version header only (JWT)
router.head('/dashboards', authenticateJWT, async (req, res, next) => {
  try {
    const version = await bundleService.getDashboardBundleVersion(req.user!.tid);
    res.set('X-Bundle-Version', version);
    res.status(200).end();
  } catch (err) {
    next(err);
  }
});

export default router;
