// Shared envelope builder/validator for the generic game:* event contract
// (contract §5): {gameType, type, kind, sessionId, matchId, userId, data}.
// UNO-specific action vocabulary belongs entirely inside `type`/`kind`/`data`
// on top of the fixed event names — never as new Socket.IO event names.
import config from '../config/index.js';

// The complete, exhaustive list of Socket.IO event names this engine ever
// emits or listens for (contract §5a). Never add a game-specific name here.
export const EVENTS = Object.freeze({
  SESSION_CREATED: 'game:session-created',
  PLAYER_JOINED: 'game:player-joined',
  PLAYER_LEFT: 'game:player-left',
  STARTED: 'game:started',
  ACTION: 'game:action',
  STATE_UPDATED: 'game:state-updated',
  TURN_CHANGED: 'game:turn-changed',
  PLAYER_FINISHED: 'game:player-finished',
  COMPLETED: 'game:completed',
  ERROR: 'game:error',
  QUICK_CHAT: 'game:quick-chat',
});

export const FIXED_EVENT_NAMES = new Set(Object.values(EVENTS));

export function buildEnvelope({ type, kind, sessionId, matchId, userId = null, data = {} }) {
  return {
    gameType: config.gameTypeSlug,
    type,
    kind: kind ?? undefined,
    sessionId,
    matchId,
    userId,
    data,
  };
}

/**
 * Validates an inbound envelope's shape. Returns { valid, error }.
 * Does not validate `type`/`kind` vocabulary — that is game-owned and
 * enforced (if at all) by the handler for the specific fixed event.
 */
export function validateEnvelope(message) {
  if (!message || typeof message !== 'object') {
    return { valid: false, error: 'Envelope must be an object' };
  }
  if (message.gameType !== config.gameTypeSlug) {
    return { valid: false, error: `gameType must be "${config.gameTypeSlug}"` };
  }
  if (typeof message.type !== 'string' || message.type.length === 0) {
    return { valid: false, error: 'type is required' };
  }
  if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
    return { valid: false, error: 'sessionId is required' };
  }
  if (typeof message.matchId !== 'string' || message.matchId.length === 0) {
    return { valid: false, error: 'matchId is required' };
  }
  if (!('data' in message)) {
    return { valid: false, error: 'data is required (use {} if empty)' };
  }
  return { valid: true, error: null };
}
