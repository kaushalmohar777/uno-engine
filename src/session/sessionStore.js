// Live session state store, keyed by gameEngineSessionId. In-memory today;
// kept behind this module's function API so the backing store can move to
// Redis later without gameplay/socket code changing. Ephemeral only — never
// the durable record of a match result (that's portalapi's job via the
// result webhook).
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';

/** @type {Map<string, object>} gameEngineSessionId -> session */
const sessions = new Map();

/** @type {Map<string, string>} matchId -> gameEngineSessionId, for duplicate-create detection */
const sessionIdByMatchId = new Map();

const ACTIVE_STATUSES = new Set(['pending', 'active']);

function generateSessionId() {
  return `uno_${crypto.randomBytes(12).toString('hex')}`;
}

function signPlayerToken({ gameEngineSessionId, matchId, userId, seatNumber }) {
  return jwt.sign(
    { gameEngineSessionId, matchId, userId, seatNumber },
    config.sessionToken.secret,
    { expiresIn: config.sessionToken.ttlSeconds }
  );
}

export function findActiveSessionByMatchId(matchId) {
  const existingId = sessionIdByMatchId.get(matchId);
  if (!existingId) return undefined;
  const existing = sessions.get(existingId);
  if (existing && ACTIVE_STATUSES.has(existing.status)) return existing;
  return undefined;
}

/**
 * Creates a new session from a validated portalapi session-create payload.
 * Returns { gameEngineSessionId, playerTokens, expiresInSec }.
 */
export function createSession({ source, contextId, matchId, gameTypeSlug, players }) {
  const gameEngineSessionId = generateSessionId();
  const now = Date.now();
  const expiresInSec = config.sessionToken.ttlSeconds;

  const playerTokens = {};
  const sessionPlayers = players.map((p) => {
    const token = p.isBot ? null : signPlayerToken({
      gameEngineSessionId,
      matchId,
      userId: p.userId,
      seatNumber: p.seatNumber,
    });

    if (!p.isBot) {
      playerTokens[p.userId] = token;
    }

    return {
      userId: p.userId,
      seatNumber: p.seatNumber,
      isBot: !!p.isBot,
      botProfile: p.botProfile || null,
      connected: !!p.isBot, // bots are always "present"
      socketId: null,
      token,
    };
  });

  const session = {
    gameEngineSessionId,
    source,
    contextId,
    matchId,
    gameTypeSlug,
    players: sessionPlayers,
    status: 'pending', // pending -> active -> completed
    createdAt: now,
    expiresAt: now + expiresInSec * 1000,
    startedAt: null,
    game: null, // set by src/game/engine.js#startGame once the match begins
    resultReport: null,
  };

  sessions.set(gameEngineSessionId, session);
  sessionIdByMatchId.set(matchId, gameEngineSessionId);

  return { gameEngineSessionId, playerTokens, expiresInSec };
}

export function getSession(gameEngineSessionId) {
  return sessions.get(gameEngineSessionId);
}

export function findPlayer(session, userId) {
  return session.players.find((p) => (p.userId ?? `bot:${p.seatNumber}`) === userId);
}

export function markPlayerSocket(session, userId, socketId) {
  const player = findPlayer(session, userId);
  if (!player) return;
  player.socketId = socketId;
  player.connected = true;
}

export function markPlayerDisconnected(session, userId) {
  const player = findPlayer(session, userId);
  if (!player) return;
  player.connected = false;
  player.socketId = null;
}

export function allSeatsPresent(session) {
  return session.players.every((p) => p.isBot || p.connected);
}

export function touchExpiry(session) {
  session.expiresAt = Date.now() + config.sessionToken.ttlSeconds * 1000;
}

export function deleteSession(gameEngineSessionId) {
  const session = sessions.get(gameEngineSessionId);
  if (session) sessionIdByMatchId.delete(session.matchId);
  sessions.delete(gameEngineSessionId);
}

export function _clearAllForTests() {
  sessions.clear();
  sessionIdByMatchId.clear();
}
