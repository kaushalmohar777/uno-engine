import { expect } from 'chai';
import { makeCard, TYPES, COLORS } from '../../src/game/cards.js';
import * as engine from '../../src/game/engine.js';
import * as turnManager from '../../src/game/turnManager.js';

function makeSession() {
  return {
    players: [
      { userId: 'u1', seatNumber: 1, isBot: false },
      { userId: 'u2', seatNumber: 2, isBot: false },
      { userId: 'u3', seatNumber: 3, isBot: false },
      { userId: 'u4', seatNumber: 4, isBot: false },
    ],
  };
}

function setTable(game, { hands, top, color = top.color, current = 'u1' }) {
  game.status = 'active';
  game.pendingAction = null;
  game.activeColor = color;
  game.piles.discardPile = [top];
  game.players.forEach((player, index) => {
    player.hand = hands[index];
    player.finished = false;
    player.position = null;
    player.role = null;
    player.points = null;
    player.calledUno = false;
  });
  game.turnState = turnManager.createTurnState(game.players.map((p) => p.id));
  game.turnState.currentIndex = game.turnState.order.indexOf(current);
}

describe('UNO engine rules', () => {
  let session;
  let game;

  beforeEach(() => {
    session = makeSession();
    engine.startGame(session);
    game = session.game;
  });

  it('rejects a play that is not the current player', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.NUMBER, 5, 'a')],
        [makeCard(COLORS.RED, TYPES.NUMBER, 6, 'b')],
        [makeCard(COLORS.BLUE, TYPES.NUMBER, 1, 'c')],
        [makeCard(COLORS.GREEN, TYPES.NUMBER, 2, 'd')],
      ],
      current: 'u1',
    });
    const outcome = engine.applyPlayCard(game, { actorId: 'u2', cardId: 'red_number_6_b' });
    expect(outcome.error.message).to.equal("It is not this player's turn");
  });

  it('rejects a card that does not match color or type', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.BLUE, TYPES.NUMBER, 9, 'a')],
        [makeCard(COLORS.RED, TYPES.NUMBER, 6, 'b')],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 1, 'c')],
        [makeCard(COLORS.GREEN, TYPES.NUMBER, 2, 'd')],
      ],
    });
    const outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'blue_number_9_a' });
    expect(outcome.error.message).to.equal('Card does not match the current color/card');
  });

  it('allows a matching color play and advances the turn', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.NUMBER, 5, 'a'), makeCard(COLORS.BLUE, TYPES.NUMBER, 2, 'x')],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 6, 'b')],
        [makeCard(COLORS.BLUE, TYPES.NUMBER, 1, 'c')],
        [makeCard(COLORS.GREEN, TYPES.NUMBER, 2, 'd')],
      ],
    });
    const outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_number_5_a' });
    expect(outcome.error).to.equal(null);
    expect(game.activeColor).to.equal(COLORS.RED);
    expect(engine.currentActorId(game)).to.equal('u2');
  });

  it('skip jumps the next seat', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.SKIP, null, 'a'), makeCard(COLORS.BLUE, TYPES.NUMBER, 2, 'x')],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 6, 'b')],
        [makeCard(COLORS.BLUE, TYPES.NUMBER, 1, 'c')],
        [makeCard(COLORS.GREEN, TYPES.NUMBER, 2, 'd')],
      ],
    });
    engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_skip_a' });
    expect(engine.currentActorId(game)).to.equal('u3');
  });

  it('draw two forces the next player to draw and skips them', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.DRAW_TWO, null, 'a'), makeCard(COLORS.BLUE, TYPES.NUMBER, 2, 'x')],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 6, 'b')],
        [makeCard(COLORS.BLUE, TYPES.NUMBER, 1, 'c')],
        [makeCard(COLORS.GREEN, TYPES.NUMBER, 2, 'd')],
      ],
    });
    engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_draw_two_a' });
    expect(game.players[1].hand.length).to.equal(3);
    expect(engine.currentActorId(game)).to.equal('u3');
  });

  it('only allows UNO while holding exactly one card', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.NUMBER, 5, 'a'), makeCard(COLORS.BLUE, TYPES.NUMBER, 2, 'x')],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 6, 'b')],
        [makeCard(COLORS.BLUE, TYPES.NUMBER, 1, 'c')],
        [makeCard(COLORS.GREEN, TYPES.NUMBER, 2, 'd')],
      ],
    });
    expect(engine.applyCallUno(game, { actorId: 'u1' }).error.message).to.include('exactly one card');
    game.players[0].hand = [makeCard(COLORS.RED, TYPES.NUMBER, 5, 'a')];
    const ok = engine.applyCallUno(game, { actorId: 'u1' });
    expect(ok.error).to.equal(null);
    expect(game.players[0].calledUno).to.equal(true);
  });

  it('ends the round when a player empties their hand and scores leftover cards', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.NUMBER, 5, 'win')],
        [makeCard(COLORS.BLUE, TYPES.NUMBER, 3, 'a')],
        [makeCard(COLORS.WILD, TYPES.WILD, null, 'b')],
        [makeCard(COLORS.GREEN, TYPES.SKIP, null, 'c')],
      ],
    });
    const outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_number_5_win', callUno: true });
    expect(outcome.completed).to.equal(true);
    expect(outcome.results[0]).to.deep.include({
      userId: 'u1',
      position: 1,
      role: 'winner',
      points: 73,
    });
    expect(outcome.results.filter((r) => r.role === 'loser').map((r) => ({ userId: r.userId, points: r.points, position: r.position }))).to.deep.equal([
      { userId: 'u2', points: 3, position: 2 },
      { userId: 'u4', points: 20, position: 3 },
      { userId: 'u3', points: 50, position: 4 },
    ]);
    expect(game.status).to.equal('completed');
  });

  it('applies a finishing draw-two before scoring leftover hands', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.DRAW_TWO, null, 'win')],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 1, 'a')],
        [makeCard(COLORS.BLUE, TYPES.NUMBER, 2, 'b')],
        [makeCard(COLORS.GREEN, TYPES.NUMBER, 3, 'c')],
      ],
    });
    const before = game.players[1].hand.length;
    const outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_draw_two_win' });
    expect(outcome.completed).to.equal(true);
    expect(game.players[1].hand.length).to.equal(before + 2);
    const u2 = outcome.results.find((r) => r.userId === 'u2');
    expect(u2.points).to.be.greaterThan(1);
    expect(outcome.results[0].points).to.equal(
      outcome.results.filter((r) => r.role === 'loser').reduce((sum, r) => sum + r.points, 0)
    );
  });
});
