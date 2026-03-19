import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import * as dataService from '../services/data.service';

const router = Router();

// GET /:dashboardId/:sourceKey - query data with cadence enforcement (JWT)
router.get('/:dashboardId/:sourceKey', authenticateJWT, async (req, res, next) => {
  try {
    const { dashboardId, sourceKey } = req.params;
    const result = await dataService.queryData(
      req.user!.tid,
      req.user!.sub,
      dashboardId,
      sourceKey,
    );
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
