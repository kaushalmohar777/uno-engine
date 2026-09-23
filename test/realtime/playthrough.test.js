import { expect } from 'chai';
import express from 'express';
import { createServer } from 'node:http';
import { io as ioc } from 'socket.io-client';
import sessionsRoutes from '../../src/api/sessions.routes.js';
import { createSocketServer } from '../../src/realtime/socketServer.js';
import * as sessionStore from '../../src/session/sessionStore.js';
import config from '../../src/config/index.js';
import { cardMatches } from '../../src/game/cards.js';

const PLAYERS = [
  { userId: '67286eb612db69183d1456f0', seatNumber: 1 },
  { userId: '6748179ed64d689e4ef197b3', seatNumber: 2 },
  { userId: '67273a3312db69183d144616', seatNumber: 3 },
  { userId: '6725f74012db69183d143524', seatNumber: 4 },
];

function envelope(type, sessionId, matchId, userId, data = {}, kind) {
  const message = { gameType: 'uno', type, sessionId, matchId, userId, data };
  if (kind) message.kind = kind;
  return message;
}

function waitFor(socket, event, timeoutMs = 4000) {
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

function playableCards(hand, view) {
  return (hand || []).filter((card) => cardMatches(card, { topCard: view.topCard, activeColor: view.activeColor }));
}

describe('4-player UNO playthrough', function () {
  this.timeout(20000);

  let httpServer;
  let port;
  let sessionId;
  let matchId;
  let tokens;
  let clients;

  before(async () => {
    sessionStore._clearAllForTests();
    const app = express();
    app.use(express.json());
    app.use(sessionsRoutes);
    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = httpServer.address().port;
    matchId = `match_playthrough_${Date.now()}`;

    const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.portalapi.inboundApiKey },
      body: JSON.stringify({
        source: 'duel',
        contextId: '6aabc83303ddfbc39c7de50d',
        matchId,
        gameTypeSlug: 'uno',
        players: PLAYERS.map((p) => ({ ...p, isBot: false })),
      }),
    });
    expect(res.status).to.equal(201);
    const body = await res.json();
    sessionId = body.gameEngineSessionId;
    tokens = body.playerTokens;
  });

  after(async () => {
    for (const client of clients || []) client.socket.close();
    sessionStore._clearAllForTests();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  it('plays a legal game to completion with a winner, losers, and leftover points', async () => {
    const url = `http://127.0.0.1:${port}`;
    clients = PLAYERS.map((player) => {
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

    const started = waitFor(clients[0].socket, 'game:started');
    clients.forEach((c) => c.socket.connect());
    await Promise.all(clients.map((c) => (c.socket.connected ? Promise.resolve() : waitFor(c.socket, 'connect'))));
    await started;
    await Promise.all(clients.map((c) => (c.view ? Promise.resolve() : waitFor(c.socket, 'game:state-updated'))));

    const offTurn = clients.find((c) => c.view.currentActorId !== c.userId);
    const illegal = offTurn.hand[0];
    if (illegal) {
      offTurn.socket.emit(
        'game:action',
        envelope('play_card', sessionId, matchId, offTurn.userId, { cardId: illegal.id })
      );
      const err = await waitFor(offTurn.socket, 'game:error');
      expect(err.data.message).to.equal("It is not this player's turn");
    }

    for (let step = 0; step < 400; step += 1) {
      if (clients.some((c) => c.completed)) break;
      const view = clients.find((c) => c.view)?.view;
      expect(view, 'expected a public view').to.exist;

      if (view.pendingColorChoice) {
        const chooser = clients.find((c) => c.userId === view.pendingColorChoice.userId);
        chooser.socket.emit(
          'game:action',
          envelope('choose_color', sessionId, matchId, chooser.userId, { chosenColor: 'red' })
        );
        await Promise.race([
          waitFor(chooser.socket, 'game:state-updated'),
          waitFor(chooser.socket, 'game:completed'),
          waitFor(chooser.socket, 'game:error'),
        ]);
        continue;
      }

      const actor = clients.find((c) => c.userId === view.currentActorId);
      expect(actor, `missing actor ${view.currentActorId}`).to.exist;
      const matches = playableCards(actor.hand, view);
      const nonWild = matches.filter((c) => c.type !== 'wild' && c.type !== 'wild_draw_four');
      const card = nonWild[0] || matches[0];

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
    expect(completed.winner).to.include({ role: 'winner', position: 1 });
    expect(completed.losers).to.have.length(3);
    expect(completed.losers.every((l) => l.role === 'loser')).to.equal(true);
    expect(completed.results).to.have.length(4);

    const loserPoints = completed.losers.reduce((sum, l) => sum + l.points, 0);
    expect(completed.winner.points).to.equal(loserPoints);
    expect(completed.winner.points).to.be.at.least(0);
    expect(new Set(completed.results.map((r) => r.position))).to.deep.equal(new Set([1, 2, 3, 4]));

    const winnerClient = clients.find((c) => c.userId === completed.winner.userId);
    expect(winnerClient.view.players.find((p) => p.userId === completed.winner.userId).handCount).to.equal(0);
  });
});
