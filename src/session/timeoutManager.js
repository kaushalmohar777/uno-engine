// Turn timers, purely engine-internal (contract §7/§8 — this never calls
// back into portalapi except through the normal result webhook once a
// match ends). Generic turn-clock bookkeeping only; whose turn it is and
// what happens on timeout is decided by the caller (socketServer.js).
import config from '../config/index.js';

/** @type {Map<string, NodeJS.Timeout>} gameEngineSessionId -> timer */
const turnTimers = new Map();

/** Starts (replacing any existing) turn timer for a session. */
export function startTurnTimer(gameEngineSessionId, onTimeout, timeoutMs = config.turn.timeoutMs) {
  clearTurnTimer(gameEngineSessionId);
  const timer = setTimeout(() => {
    turnTimers.delete(gameEngineSessionId);
    onTimeout();
  }, timeoutMs);
  timer.unref?.();
  turnTimers.set(gameEngineSessionId, timer);
}

export function clearTurnTimer(gameEngineSessionId) {
  const timer = turnTimers.get(gameEngineSessionId);
  if (timer) {
    clearTimeout(timer);
    turnTimers.delete(gameEngineSessionId);
  }
}
