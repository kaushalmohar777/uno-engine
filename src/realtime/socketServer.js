// The engine's own Socket.IO server that clients connect to directly using
// their sessionToken (contract §8). Emits/consumes ONLY the shared game:*
// event envelope defined in eventContract.js (contract §5) — no
// uno:play-card, uno:draw-card, uno:uno-call, or any other game-named event.
//
// This module wires generic session-lifecycle plumbing (join/start/leave,
// turn rotation, reconnect, quick-chat relay). It does not implement UNO
// rules — game:action is currently a generic pass-through/turn-rotation
// stub for src/game/* to plug real validation into later.
import { Server } from 'socket.io';
import config from '../config/index.js';
import { EVENTS, buildEnvelope, validateEnvelope } from './eventContract.js';
import { authenticate, SessionAuthError } from './sessionAuth.js';
import * as sessionStore from '../session/sessionStore.js';
import * as reconnectManager from '../session/reconnectManager.js';
import * as timeoutManager from '../session/timeoutManager.js';

const QUICK_CHAT_KINDS = new Set(['good_luck', 'nice_move', 'oops', 'thanks', 'hurry_up', 'gg']);

function roomFor(session) {
  return session.gameEngineSessionId;
}

function emitTo(io, session, { type, kind, userId = null, data = {} }) {
  io.to(roomFor(session)).emit(
    /** event name */ eventNameFor(type),
    buildEnvelope({ type, kind, sessionId: session.gameEngineSessionId, matchId: session.matchId, userId, data })
  );
}

// Fixed event names map 1:1 to the outbound occasions we emit for.
function eventNameFor(type) {
  switch (type) {
    case 'player_joined': return EVENTS.PLAYER_JOINED;
    case 'player_left': return EVENTS.PLAYER_LEFT;
    case 'started': return EVENTS.STARTED;
    case 'state_updated': return EVENTS.STATE_UPDATED;
    case 'turn_changed': return EVENTS.TURN_CHANGED;
    case 'player_finished': return EVENTS.PLAYER_FINISHED;
    case 'completed': return EVENTS.COMPLETED;
    case 'error': return EVENTS.ERROR;
    case 'quick_chat': return EVENTS.QUICK_CHAT;
    default: return EVENTS.STATE_UPDATED;
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

function maybeStartMatch(io, session) {
  if (session.status !== 'pending') return;
  if (!sessionStore.allSeatsPresent(session)) return;

  session.status = 'active';
  session.startedAt = Date.now();

  emitTo(io, session, { type: 'started' });

  const firstTurnUserId = sessionStore.currentTurnUserId(session);
  emitTo(io, session, {
    type: 'turn_changed',
    userId: firstTurnUserId,
    data: { currentUserId: firstTurnUserId, turnDeadlineAt: Date.now() + config.turn.timeoutMs },
  });

  armTurnTimer(io, session);
}

function armTurnTimer(io, session) {
  timeoutManager.startTurnTimer(session.gameEngineSessionId, () => {
    if (session.status !== 'active') return;
    const nextUserId = sessionStore.advanceTurn(session);
    emitTo(io, session, {
      type: 'turn_changed',
      userId: nextUserId,
      data: { currentUserId: nextUserId, turnDeadlineAt: Date.now() + config.turn.timeoutMs, reason: 'timeout' },
    });
    armTurnTimer(io, session);
  });
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

    emitTo(io, session, { type: 'player_joined', userId });
    maybeStartMatch(io, session);

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

      if (session.status !== 'active') {
        emitError(socket, session, matchId, 'Session is not active');
        return;
      }

      if (sessionStore.currentTurnUserId(session) !== userId) {
        emitError(socket, session, matchId, 'It is not your turn');
        return;
      }

      // Generic pass-through: broadcast the accepted action as authoritative
      // state, advance turn order, and reset the turn clock. Real UNO move
      // validation/effects (skip, reverse, draw stacks, wild colors, win
      // detection) belong in src/game/* and replace this stub.
      emitTo(io, session, {
        type: 'state_updated',
        kind: message.kind,
        userId,
        data: { appliedType: message.type, appliedData: message.data },
      });

      const nextUserId = sessionStore.advanceTurn(session);
      emitTo(io, session, {
        type: 'turn_changed',
        userId: nextUserId,
        data: { currentUserId: nextUserId, turnDeadlineAt: Date.now() + config.turn.timeoutMs },
      });
      armTurnTimer(io, session);
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
      emitTo(io, session, { type: 'player_left', kind: 'disconnected', userId });

      reconnectManager.scheduleDisconnectGrace(session.gameEngineSessionId, userId, () => {
        // Grace period lapsed with no reconnect. Generic plumbing stops
        // here — turning this into a forfeit (result webhook / match
        // cleanup) belongs to the gameplay layer once implemented.
        emitTo(io, session, { type: 'player_left', kind: 'left', userId });
      });
    });
  });

  return io;
}
