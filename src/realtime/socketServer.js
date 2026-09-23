// The engine's own Socket.IO server that clients connect to directly using
// their sessionToken (contract §8). Emits/consumes ONLY the shared game:*
// event envelope defined in eventContract.js (contract §5) — no
// uno:play-card, uno:draw-card, uno:uno-call, or any other game-named event.
//
// UNO rules themselves live in src/game/* (engine.js is authoritative for
// state transitions) — this module only authenticates sockets, transports
// game:action payloads into the engine, and turns the engine's results back
// into frontend-facing game:* events (including per-player hand privacy).
import { Server } from 'socket.io';
import config from '../config/index.js';
import { EVENTS, buildEnvelope, validateEnvelope } from './eventContract.js';
import { authenticate, SessionAuthError } from './sessionAuth.js';
import * as sessionStore from '../session/sessionStore.js';
import * as reconnectManager from '../session/reconnectManager.js';
import * as timeoutManager from '../session/timeoutManager.js';
import * as engine from '../game/engine.js';
import { reportMatchResult } from '../portalapi/resultWebhook.js';

const QUICK_CHAT_KINDS = new Set(['good_luck', 'nice_move', 'oops', 'thanks', 'hurry_up', 'gg']);

function roomFor(session) {
  return session.gameEngineSessionId;
}

function emitToRoom(io, session, { event, type, kind, userId = null, data = {} }) {
  io.to(roomFor(session)).emit(
    event,
    buildEnvelope({ type, kind, sessionId: session.gameEngineSessionId, matchId: session.matchId, userId, data })
  );
}

/** Sends a `game:state-updated` to a single connected human player, with that player's own hand attached — never another player's. */
function emitStateToPlayer(io, session, sessionPlayer, { type, kind, actionUserId, extraData = {} }) {
  if (sessionPlayer.isBot || !sessionPlayer.socketId) return;
  io.to(sessionPlayer.socketId).emit(
    EVENTS.STATE_UPDATED,
    buildEnvelope({
      type,
      kind,
      sessionId: session.gameEngineSessionId,
      matchId: session.matchId,
      userId: actionUserId,
      data: {
        ...engine.buildPublicView(session.game),
        yourHand: engine.buildPrivateHand(session.game, sessionPlayer.userId),
        ...extraData,
      },
    })
  );
}

function broadcastState(io, session, { type, kind, actionUserId = null, extraData = {} }) {
  for (const player of session.players) {
    emitStateToPlayer(io, session, player, { type, kind, actionUserId, extraData });
  }
}

function emitError(socket, session, matchId, message, kind = 'invalid_action') {
  socket.emit(
    EVENTS.ERROR,
    buildEnvelope({
      type: 'error',
      kind,
      sessionId: session ? session.gameEngineSessionId : undefined,
      matchId,
      userId: null,
      data: { message },
    })
  );
}

function emitTurnChanged(io, session) {
  const gameState = session.game;
  const actorId = engine.currentActorId(gameState);
  if (!actorId) return;
  const player = engine.getPlayerByActorId(gameState, actorId);
  emitToRoom(io, session, {
    event: EVENTS.TURN_CHANGED,
    type: 'turn_changed',
    userId: player.userId,
    data: { currentUserId: player.userId, seatNumber: player.seatNumber, turnDeadlineAt: Date.now() + config.turn.timeoutMs },
  });
}

function emitPlayerFinished(io, session, finishedPlayers) {
  for (const f of finishedPlayers) {
    emitToRoom(io, session, {
      event: EVENTS.PLAYER_FINISHED,
      type: 'player_finished',
      userId: f.userId,
      data: { position: f.position, seatNumber: f.seatNumber, role: f.role, points: f.points },
    });
  }
}

function emitCompleted(io, session, results) {
  session.status = 'completed';
  emitToRoom(io, session, {
    event: EVENTS.COMPLETED,
    type: 'completed',
    data: {
      results,
      winner: results.find((r) => r.role === 'winner') || results[0] || null,
      losers: results.filter((r) => r.role === 'loser'),
    },
  });
  reportMatchResult(session, { results, endedReason: 'completed' }).catch((err) => {
    console.error(`[resultWebhook] unexpected error for match ${session.matchId}: ${err.message}`);
  });
}

/** Applies an outcome from engine.js to sockets: state, finishes, completion, turn clock. */
function applyOutcome(io, session, outcome, { type, kind, actionUserId }) {
  broadcastState(io, session, { type, kind, actionUserId });

  if (outcome.finishedPlayers.length > 0) {
    emitPlayerFinished(io, session, outcome.finishedPlayers);
  }

  if (outcome.completed) {
    timeoutManager.clearTurnTimer(session.gameEngineSessionId);
    emitCompleted(io, session, outcome.results);
    return;
  }

  if (outcome.turnChanged) {
    emitTurnChanged(io, session);
  }

  // Either a normal turn handoff or a pending wild-color choice needs a
  // fresh clock — both are "someone must act next" states.
  if (outcome.turnChanged || outcome.awaitingColorChoice) {
    armTurnTimer(io, session);
  }
}

function armTurnTimer(io, session) {
  timeoutManager.startTurnTimer(session.gameEngineSessionId, () => {
    if (session.status !== 'active' || !session.game || session.game.status !== 'active') return;
    const wasAwaitingColor = !!session.game.pendingAction;
    const outcome = engine.forceAdvanceOnTimeout(session.game);
    if (outcome.error) return; // no active turn to advance (shouldn't happen while active)
    applyOutcome(io, session, outcome, {
      type: wasAwaitingColor ? 'color_chosen' : 'card_drawn',
      kind: 'timeout',
      actionUserId: null,
    });
  });
}

function maybeStartMatch(io, session) {
  if (session.status !== 'pending') return;
  if (!sessionStore.allSeatsPresent(session)) return;

  session.status = 'active';
  session.startedAt = Date.now();
  engine.startGame(session);

  emitToRoom(io, session, { event: EVENTS.STARTED, type: 'started' });
  broadcastState(io, session, { type: 'card_played', kind: 'initial_deal' });
  emitTurnChanged(io, session);
  armTurnTimer(io, session);
}

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
  });

  io.use((socket, next) => {
    try {
      // Prefer the auth payload (contract §8), but accept a `token` query
      // param too — some clients (Postman's Socket.IO UI, browser test
      // pages) make the query string easier to set than a handshake auth
      // object.
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      const { session, player } = authenticate(token);
      socket.data.gameEngineSessionId = session.gameEngineSessionId;
      socket.data.matchId = session.matchId;
      socket.data.userId = player.userId;
      socket.data.seatNumber = player.seatNumber;
      next();
    } catch (err) {
      if (err instanceof SessionAuthError) {
        next(new Error(err.message));
      } else {
        next(new Error('Authentication failed'));
      }
    }
  });

  io.on('connection', (socket) => {
    const session = sessionStore.getSession(socket.data.gameEngineSessionId);
    if (!session) {
      socket.disconnect(true);
      return;
    }
    const { userId, matchId } = socket.data;

    socket.join(roomFor(session));
    sessionStore.markPlayerSocket(session, userId, socket.id);
    sessionStore.touchExpiry(session);
    reconnectManager.cancelDisconnectGrace(session.gameEngineSessionId, userId);

    emitToRoom(io, session, { event: EVENTS.PLAYER_JOINED, type: 'player_joined', userId });

    if (session.status === 'pending') {
      maybeStartMatch(io, session);
    } else if (session.status === 'active' && session.game) {
      // Reconnect mid-game: bring this one player's view current without
      // re-broadcasting to everyone else.
      const player = session.players.find((p) => p.userId === userId);
      if (player) emitStateToPlayer(io, session, player, { type: 'card_played', kind: 'resync' });
    }

    socket.on(EVENTS.ACTION, (message) => {
      const { valid, error } = validateEnvelope(message);
      if (!valid) {
        emitError(socket, session, matchId, error);
        return;
      }
      if (message.sessionId !== session.gameEngineSessionId || message.matchId !== matchId) {
        emitError(socket, session, matchId, 'sessionId/matchId does not match this connection');
        return;
      }
      if (session.status !== 'active' || !session.game) {
        emitError(socket, session, matchId, 'Session is not active');
        return;
      }

      const data = message.data || {};
      let outcome;
      let responseType;

      switch (message.type) {
        case 'play_card':
          outcome = engine.applyPlayCard(session.game, {
            actorId: userId,
            cardId: data.cardId,
            chosenColor: data.chosenColor,
            callUno: !!data.callUno,
          });
          responseType = 'card_played';
          break;
        case 'draw_card':
          outcome = engine.applyDrawCard(session.game, { actorId: userId });
          responseType = 'card_drawn';
          break;
        case 'call_uno':
          outcome = engine.applyCallUno(session.game, { actorId: userId });
          responseType = 'uno_called';
          break;
        case 'choose_color':
          outcome = engine.applyChooseColor(session.game, { actorId: userId, chosenColor: data.chosenColor });
          responseType = 'color_chosen';
          break;
        default:
          emitError(socket, session, matchId, `Unsupported action type "${message.type}"`);
          return;
      }

      if (outcome.error) {
        emitError(socket, session, matchId, outcome.error.message, outcome.error.kind);
        return;
      }

      applyOutcome(io, session, outcome, { type: responseType, kind: message.kind, actionUserId: userId });
    });

    socket.on(EVENTS.QUICK_CHAT, (message) => {
      const { valid, error } = validateEnvelope(message);
      if (!valid) {
        emitError(socket, session, matchId, error);
        return;
      }
      if (message.type !== 'quick_chat' || !QUICK_CHAT_KINDS.has(message.kind)) {
        emitError(socket, session, matchId, 'Unsupported quick-chat kind', 'invalid_action');
        return;
      }
      socket.to(roomFor(session)).emit(
        EVENTS.QUICK_CHAT,
        buildEnvelope({
          type: 'quick_chat',
          kind: message.kind,
          sessionId: session.gameEngineSessionId,
          matchId,
          userId,
          data: message.data || {},
        })
      );
    });

    socket.on('disconnect', () => {
      sessionStore.markPlayerDisconnected(session, userId);
      emitToRoom(io, session, { event: EVENTS.PLAYER_LEFT, type: 'player_left', kind: 'disconnected', userId });

      reconnectManager.cancelDisconnectGrace(session.gameEngineSessionId, userId);
      reconnectManager.scheduleDisconnectGrace(session.gameEngineSessionId, userId, () => {
        // Grace period lapsed with no reconnect. Generic plumbing stops
        // here — turning this into a forfeit (result webhook / match
        // cleanup) belongs to the result-reporting layer once implemented.
        emitToRoom(io, session, { event: EVENTS.PLAYER_LEFT, type: 'player_left', kind: 'left', userId });
      });
    });
  });

  return io;
}
