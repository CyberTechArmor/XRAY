import { Router } from 'express';
import * as embedService from '../services/embed.service';

const router = Router();

// GET /:token - get embedded dashboard (no auth, token-based)
router.get('/:token', async (req, res, next) => {
  try {
    const result = await embedService.getEmbedDashboard(req.params.token);
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
