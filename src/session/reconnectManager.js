// Reconnect grace-period handling: gives a disconnected player a window to
// re-present the same sessionToken (contract §8) before the disconnect is
// treated as a forfeit. Purely engine-internal timer bookkeeping.
import config from '../config/index.js';

/** @type {Map<string, NodeJS.Timeout>} `${gameEngineSessionId}:${userId}` -> timer */
const graceTimers = new Map();

function key(gameEngineSessionId, userId) {
  return `${gameEngineSessionId}:${userId}`;
}

/**
 * Starts (or restarts) the reconnect grace period for a player who just
 * disconnected. `onExpire()` fires if they have not reconnected in time.
 */
export function scheduleDisconnectGrace(gameEngineSessionId, userId, onExpire, graceMs = config.reconnect.graceMs) {
  cancelDisconnectGrace(gameEngineSessionId, userId);
  const timer = setTimeout(() => {
    graceTimers.delete(key(gameEngineSessionId, userId));
    onExpire();
  }, graceMs);
  timer.unref?.();
  graceTimers.set(key(gameEngineSessionId, userId), timer);
}

/** Cancels a pending grace timer, e.g. because the player reconnected. */
export function cancelDisconnectGrace(gameEngineSessionId, userId) {
  const k = key(gameEngineSessionId, userId);
  const timer = graceTimers.get(k);
  if (timer) {
    clearTimeout(timer);
    graceTimers.delete(k);
  }
}

export function hasPendingGrace(gameEngineSessionId, userId) {
  return graceTimers.has(key(gameEngineSessionId, userId));
}
