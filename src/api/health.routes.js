// Liveness/readiness endpoint for ops/monitoring.
import { Router } from 'express';

const router = Router();

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

export default router;
