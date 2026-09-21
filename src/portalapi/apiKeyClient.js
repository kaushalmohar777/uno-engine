// Holds PORTALAPI_TO_UNO_API_KEY (validates inbound session-create calls came
// from portalapi) and UNO_TO_PORTALAPI_API_KEY (signs outbound result-webhook
// calls), per contract §11.
import config from '../config/index.js';

export function requireInboundApiKey(req, res, next) {
  const providedKey = req.header('X-API-Key');

  if (!config.portalapi.inboundApiKey) {
    return res.status(500).json({ error: 'server_misconfigured', message: 'PORTALAPI_TO_UNO_API_KEY is not configured' });
  }

  if (!providedKey || providedKey !== config.portalapi.inboundApiKey) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid or missing X-API-Key' });
  }

  return next();
}

export function getOutboundApiKey() {
  return config.portalapi.outboundApiKey;
}
