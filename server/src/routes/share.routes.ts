import { Router } from 'express';
import * as dashboardService from '../services/dashboard.service';

const router = Router();

// GET /:token - render public shared dashboard (no auth, token-based)
router.get('/:token', async (req, res, next) => {
  try {
    const data = await dashboardService.renderPublicDashboard(req.params.token);
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
