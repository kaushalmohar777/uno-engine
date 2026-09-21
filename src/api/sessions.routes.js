// POST /sessions (session-create, contract §3).
import { Router } from 'express';
import { requireInboundApiKey } from '../portalapi/apiKeyClient.js';
import { createSession } from './sessions.controller.js';

const router = Router();

router.post('/sessions', requireInboundApiKey, createSession);

export default router;
