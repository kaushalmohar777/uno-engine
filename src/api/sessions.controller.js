// Handles POST /sessions: validates the portalapi request, creates a
// session, returns {gameEngineSessionId, playerTokens, expiresInSec} per
// contract §3.
import config from '../config/index.js';
import * as sessionStore from '../session/sessionStore.js';

const VALID_SOURCES = new Set(['tournament', 'duel']);

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function validatePlayer(player, index) {
  if (!player || typeof player !== 'object') {
    throw validationError(`players[${index}] must be an object`);
  }
  const { userId, seatNumber, isBot, botProfile } = player;

  if (typeof seatNumber !== 'number' || !Number.isInteger(seatNumber)) {
    throw validationError(`players[${index}].seatNumber must be an integer`);
  }

  if (isBot !== undefined && typeof isBot !== 'boolean') {
    throw validationError(`players[${index}].isBot must be a boolean`);
  }

  const bot = !!isBot;

  if (bot) {
    if (userId !== null && userId !== undefined) {
      throw validationError(`players[${index}].userId must be null for a bot seat`);
    }
    if (botProfile !== undefined && (typeof botProfile !== 'object' || botProfile === null)) {
      throw validationError(`players[${index}].botProfile must be an object when present`);
    }
  } else {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw validationError(`players[${index}].userId is required for a non-bot seat`);
    }
  }

  return { userId: bot ? null : userId, seatNumber, isBot: bot, botProfile: botProfile || null };
}

function validateCreatePayload(body) {
  if (!body || typeof body !== 'object') {
    throw validationError('Request body is required');
  }

  const { source, contextId, matchId, gameTypeSlug, players } = body;

  if (!VALID_SOURCES.has(source)) {
    throw validationError(`source must be one of ${[...VALID_SOURCES].join(', ')}`);
  }
  if (typeof contextId !== 'string' || contextId.length === 0) {
    throw validationError('contextId is required');
  }
  if (typeof matchId !== 'string' || matchId.length === 0) {
    throw validationError('matchId is required');
  }
  if (gameTypeSlug !== config.gameTypeSlug) {
    throw validationError(`gameTypeSlug must be "${config.gameTypeSlug}"`);
  }
  if (!Array.isArray(players) || players.length === 0) {
    throw validationError('players must be a non-empty array');
  }

  const seenSeats = new Set();
  const validatedPlayers = players.map((player, index) => {
    const validated = validatePlayer(player, index);
    if (seenSeats.has(validated.seatNumber)) {
      throw validationError(`Duplicate seatNumber ${validated.seatNumber} in players`);
    }
    seenSeats.add(validated.seatNumber);
    return validated;
  });

  return { source, contextId, matchId, gameTypeSlug, players: validatedPlayers };
}

export function createSession(req, res) {
  let payload;
  try {
    payload = validateCreatePayload(req.body);
  } catch (err) {
    if (err.statusCode === 400) {
      return res.status(400).json({ error: 'invalid_request', message: err.message });
    }
    throw err;
  }

  // Idempotency: a retried session-create for a matchId that already has a
  // live (pending/active) session returns that same session instead of
  // minting a second one.
  const existing = sessionStore.findActiveSessionByMatchId(payload.matchId);
  if (existing) {
    const playerTokens = {};
    for (const p of existing.players) {
      if (!p.isBot) playerTokens[p.userId] = p.token;
    }
    return res.status(200).json({
      gameEngineSessionId: existing.gameEngineSessionId,
      playerTokens,
      expiresInSec: Math.max(0, Math.round((existing.expiresAt - Date.now()) / 1000)),
    });
  }

  const result = sessionStore.createSession(payload);
  return res.status(201).json(result);
}
