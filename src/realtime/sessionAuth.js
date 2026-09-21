// Validates a client's sessionToken on socket connect/reconnect against the
// session it was minted for (contract §8). Engine-minted tokens only — this
// is never portalapi's JWT.
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import * as sessionStore from '../session/sessionStore.js';

export class SessionAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionAuthError';
  }
}

/**
 * Verifies a session token and resolves it to a live session + player.
 * Throws SessionAuthError on any failure (bad signature, expired, session
 * gone, player not part of that session).
 */
export function authenticate(token) {
  if (!token || typeof token !== 'string') {
    throw new SessionAuthError('Missing session token');
  }

  let payload;
  try {
    payload = jwt.verify(token, config.sessionToken.secret);
  } catch (err) {
    throw new SessionAuthError('Invalid or expired session token');
  }

  const { gameEngineSessionId, matchId, userId, seatNumber } = payload;

  const session = sessionStore.getSession(gameEngineSessionId);
  if (!session) {
    throw new SessionAuthError('Session no longer exists');
  }
  if (session.matchId !== matchId) {
    throw new SessionAuthError('Token does not match session');
  }

  const player = sessionStore.findPlayer(session, userId);
  if (!player || player.isBot || player.seatNumber !== seatNumber) {
    throw new SessionAuthError('Token does not authorize this player for this session');
  }

  return { session, player };
}
