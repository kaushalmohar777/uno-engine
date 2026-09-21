// Centralized config — loaded from env (contract §11).
import dotenv from 'dotenv';

dotenv.config();

function required(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  return value;
}

const config = {
  port: Number(process.env.PORT || 4200),

  portalapi: {
    baseUrl: required('PORTALAPI_BASE_URL', ''),
    inboundApiKey: required('PORTALAPI_TO_UNO_API_KEY', ''),
    outboundApiKey: required('UNO_TO_PORTALAPI_API_KEY', ''),
  },

  sessionToken: {
    secret: required('SESSION_TOKEN_SECRET', 'dev-insecure-secret-change-me'),
    ttlSeconds: Number(process.env.SESSION_TOKEN_TTL_SECONDS || 300),
  },

  redisUrl: required('REDIS_URL', ''),

  gameTypeSlug: 'uno',

  turn: {
    timeoutMs: Number(process.env.TURN_TIMEOUT_MS || 30000),
  },

  reconnect: {
    graceMs: Number(process.env.RECONNECT_GRACE_MS || 60000),
  },
};

export default config;
