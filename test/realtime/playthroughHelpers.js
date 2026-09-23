// Shared simulation harness for the N-player UNO socket playthrough tests
// (2p/4p) — connects real Socket.IO clients against a real session/engine
// and plays a full legal game, respecting pending color choices and the
// stackable-+2 obligation (§3.1) along the way.
import { expect } from 'chai';
import express from 'express';
import { createServer } from 'node:http';
import { io as ioc } from 'socket.io-client';
import sessionsRoutes from '../../src/api/sessions.routes.js';
import { createSocketServer } from '../../src/realtime/socketServer.js';
import * as sessionStore from '../../src/session/sessionStore.js';
import config from '../../src/config/index.js';
import { cardMatches } from '../../src/game/cards.js';

export function envelope(type, sessionId, matchId, userId, data = {}, kind) {
  const message = { gameType: 'uno', type, sessionId, matchId, userId, data };
  if (kind) message.kind = kind;
  return message;
}

export function waitFor(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, onEvent);
  });
}

export function playableCards(hand, view) {
  return (hand || []).filter((card) => cardMatches(card, { topCard: view.topCard, activeColor: view.activeColor }));
}

export async function startServer() {
  sessionStore._clearAllForTests();
  const app = express();
  app.use(express.json());
  app.use(sessionsRoutes);
  const httpServer = createServer(app);
  createSocketServer(httpServer);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;
  return { httpServer, port };
}

export async function stopServer(httpServer, clients) {
  for (const client of clients || []) client.socket.close();
  sessionStore._clearAllForTests();
  await new Promise((resolve) => httpServer.close(resolve));
}

export async function createSession(port, { matchId, contextId, players }) {
  const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': config.portalapi.inboundApiKey },
    body: JSON.stringify({
      source: 'duel',
      contextId,
      matchId,
      gameTypeSlug: 'uno',
      players: players.map((p) => ({ ...p, isBot: false })),
    }),
  });
  expect(res.status).to.equal(201);
  const body = await res.json();
  return { sessionId: body.gameEngineSessionId, tokens: body.playerTokens };
}

export function connectClients(port, players, tokens) {
  const url = `http://127.0.0.1:${port}`;
  return players.map((player) => {
    const socket = ioc(url, {
      auth: { token: tokens[player.userId] },
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
    });
    const ctx = { ...player, socket, hand: [], view: null, completed: null, errors: [], started: null };
    socket.on('game:state-updated', (msg) => {
      ctx.view = msg.data;
      if (msg.data?.yourHand) ctx.hand = msg.data.yourHand;
    });
    socket.on('game:error', (msg) => ctx.errors.push(msg));
    socket.on('game:completed', (msg) => {
      ctx.completed = msg.data;
    });
    socket.on('game:started', (msg) => {
      ctx.started = msg;
    });
    return ctx;
  });
}

/**
 * Plays a full legal game to completion via real sockets. Returns the final
 * `game:completed` data. `maxSteps` defaults generously — simulated 2-player
 * games have been observed to run 500+ turns (repeated reverse-as-skip
 * exchanges), so a tight cap here just makes the test randomly flaky rather
 * than catching a real stall.
 */
export async function playToCompletion(clients, sessionId, matchId, { maxSteps = 1000 } = {}) {
  const started = waitFor(clients[0].socket, 'game:started');
  clients.forEach((c) => c.socket.connect());
  await Promise.all(clients.map((c) => (c.socket.connected ? Promise.resolve() : waitFor(c.socket, 'connect'))));
  await started;
  await Promise.all(clients.map((c) => (c.view ? Promise.resolve() : waitFor(c.socket, 'game:state-updated'))));

  const offTurn = clients.find((c) => c.view.currentActorId !== c.userId);
  const illegal = offTurn?.hand[0];
  if (illegal) {
    offTurn.socket.emit('game:action', envelope('play_card', sessionId, matchId, offTurn.userId, { cardId: illegal.id }));
    const err = await waitFor(offTurn.socket, 'game:error');
    expect(err.data.message).to.equal("It is not this player's turn");
  }

  for (let step = 0; step < maxSteps; step += 1) {
    if (clients.some((c) => c.completed)) break;
    const view = clients.find((c) => c.view)?.view;
    expect(view, 'expected a public view').to.exist;

    if (view.pendingColorChoice) {
      const chooser = clients.find((c) => c.userId === view.pendingColorChoice.userId);
      chooser.socket.emit('game:action', envelope('choose_color', sessionId, matchId, chooser.userId, { chosenColor: 'red' }));
      await Promise.race([
        waitFor(chooser.socket, 'game:state-updated'),
        waitFor(chooser.socket, 'game:completed'),
        waitFor(chooser.socket, 'game:error'),
      ]);
      continue;
    }

    const actor = clients.find((c) => c.userId === view.currentActorId);
    expect(actor, `missing actor ${view.currentActorId}`).to.exist;

    // A pending stackable +2 (§3.1) restricts this turn to either stacking
    // another +2 (any color) or drawing the accumulated pile — normal
    // color/type matching does not apply while it's owed.
    let card;
    if (view.pendingDraw) {
      card = actor.hand.find((c) => c.type === 'draw_two');
    } else {
      const matches = playableCards(actor.hand, view);
      const nonWild = matches.filter((c) => c.type !== 'wild' && c.type !== 'wild_draw_four');
      card = nonWild[0] || matches[0];
    }

    if (card) {
      const callUno = actor.hand.length === 2;
      const data = { cardId: card.id, callUno };
      if (card.type === 'wild' || card.type === 'wild_draw_four') data.chosenColor = view.activeColor || 'red';
      actor.socket.emit('game:action', envelope('play_card', sessionId, matchId, actor.userId, data, card.type));
    } else {
      actor.socket.emit('game:action', envelope('draw_card', sessionId, matchId, actor.userId, {}));
    }

    await Promise.race([
      waitFor(actor.socket, 'game:state-updated'),
      waitFor(actor.socket, 'game:completed'),
      waitFor(actor.socket, 'game:error'),
    ]);
  }

  const completed = clients.find((c) => c.completed)?.completed;
  expect(completed, 'game should complete').to.exist;
  return completed;
}
