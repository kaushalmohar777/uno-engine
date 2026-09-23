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

function makeSessionOf(n) {
  return {
    players: Array.from({ length: n }, (_, i) => ({ userId: `u${i + 1}`, seatNumber: i + 1, isBot: false })),
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

  it('draw two is stackable: the obligation passes on instead of resolving immediately', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.DRAW_TWO, null, 'a'), makeCard(COLORS.BLUE, TYPES.NUMBER, 2, 'x')],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 6, 'b')],
        [makeCard(COLORS.BLUE, TYPES.NUMBER, 1, 'c')],
        [makeCard(COLORS.GREEN, TYPES.NUMBER, 2, 'd')],
      ],
    });
    const outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_draw_two_a' });
    expect(outcome.error).to.equal(null);
    expect(game.players[1].hand.length).to.equal(1); // nobody has drawn yet
    expect(game.pendingDraw).to.deep.equal({ count: 2 });
    expect(engine.currentActorId(game)).to.equal('u2');
  });

  it('draw two stacks across multiple players, then the player who cannot/will not stack draws the total and is skipped', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.DRAW_TWO, null, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.DRAW_TWO, null, 'a'), makeCard(COLORS.BLUE, TYPES.NUMBER, 9, 'a-filler')],
        [makeCard(COLORS.BLUE, TYPES.DRAW_TWO, null, 'b'), makeCard(COLORS.BLUE, TYPES.NUMBER, 8, 'b-filler')],
        [makeCard(COLORS.GREEN, TYPES.DRAW_TWO, null, 'c'), makeCard(COLORS.BLUE, TYPES.NUMBER, 7, 'c-filler')],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 5, 'd')],
      ],
    });
    game.pendingDraw = { count: 2 }; // as if u4 (previous player) had just played the top +2

    // u1 stacks
    let outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_draw_two_a' });
    expect(outcome.error).to.equal(null);
    expect(game.pendingDraw).to.deep.equal({ count: 4 });
    expect(engine.currentActorId(game)).to.equal('u2');

    // u2 stacks
    outcome = engine.applyPlayCard(game, { actorId: 'u2', cardId: 'blue_draw_two_b' });
    expect(outcome.error).to.equal(null);
    expect(game.pendingDraw).to.deep.equal({ count: 6 });
    expect(engine.currentActorId(game)).to.equal('u3');

    // u3 stacks (any color counts, regardless of the discard's active color)
    outcome = engine.applyPlayCard(game, { actorId: 'u3', cardId: 'green_draw_two_c' });
    expect(outcome.error).to.equal(null);
    expect(game.pendingDraw).to.deep.equal({ count: 8 });
    expect(engine.currentActorId(game)).to.equal('u4');

    // u4 has no +2 and cannot stack a plain number card while a +2 is pending
    const rejected = engine.applyPlayCard(game, { actorId: 'u4', cardId: 'yellow_number_5_d' });
    expect(rejected.error.message).to.include('A +2 is pending');

    // u4 draws instead — absorbs the full stacked total and is skipped
    outcome = engine.applyDrawCard(game, { actorId: 'u4' });
    expect(outcome.error).to.equal(null);
    expect(game.players[3].hand.length).to.equal(1 + 8);
    expect(game.pendingDraw).to.equal(null);
    expect(engine.currentActorId(game)).to.equal('u1');
  });

  it('wild draw four never stacks onto a pending +2', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.DRAW_TWO, null, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.DRAW_TWO, null, 'a'), makeCard(COLORS.BLUE, TYPES.NUMBER, 9, 'a-filler')],
        [makeCard(COLORS.WILD, TYPES.WILD_DRAW_FOUR, null, 'b')],
        [makeCard(COLORS.BLUE, TYPES.NUMBER, 1, 'c')],
        [makeCard(COLORS.GREEN, TYPES.NUMBER, 2, 'd')],
      ],
    });
    engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_draw_two_a' });
    const outcome = engine.applyPlayCard(game, { actorId: 'u2', cardId: 'wild_wild_draw_four_b', chosenColor: 'blue' });
    expect(outcome.error.message).to.include('A +2 is pending');
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

  it('rejects any play while a wild color choice is pending', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.WILD, TYPES.WILD, null, 'a'), makeCard(COLORS.BLUE, TYPES.NUMBER, 2, 'x')],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 6, 'b')],
        [makeCard(COLORS.BLUE, TYPES.NUMBER, 1, 'c')],
        [makeCard(COLORS.GREEN, TYPES.NUMBER, 2, 'd')],
      ],
    });
    const played = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'wild_wild_a' });
    expect(played.awaitingColorChoice).to.equal(true);
    expect(engine.currentActorId(game)).to.equal('u1'); // turn has not moved on yet

    const blocked = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'blue_number_2_x' });
    expect(blocked.error.message).to.include('color choice is pending');

    const resolved = engine.applyChooseColor(game, { actorId: 'u1', chosenColor: 'blue' });
    expect(resolved.error).to.equal(null);
    expect(game.activeColor).to.equal('blue');
    expect(engine.currentActorId(game)).to.equal('u2');
  });

  it('applies several consecutive special cards correctly (skip then reverse then draw two) in a 4-player game', () => {
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.SKIP, null, 'a'), makeCard(COLORS.BLUE, TYPES.NUMBER, 9, 'a-filler')],
        [makeCard(COLORS.RED, TYPES.DRAW_TWO, null, 'c'), makeCard(COLORS.BLUE, TYPES.NUMBER, 7, 'c-filler')],
        [makeCard(COLORS.RED, TYPES.REVERSE, null, 'b'), makeCard(COLORS.BLUE, TYPES.NUMBER, 8, 'b-filler')],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 1, 'd')],
      ],
    });
    // u1 skip: u2 loses their turn -> u3 is up.
    let outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_skip_a' });
    expect(outcome.error).to.equal(null);
    expect(engine.currentActorId(game)).to.equal('u3');

    // u3 reverse (4 players still at the table -> direction flips, no skip).
    outcome = engine.applyPlayCard(game, { actorId: 'u3', cardId: 'red_reverse_b' });
    expect(outcome.error).to.equal(null);
    expect(game.turnState.direction).to.equal(-1);
    expect(engine.currentActorId(game)).to.equal('u2');

    // u2 draw two: deferred, turn passes to u1 (direction is now -1).
    outcome = engine.applyPlayCard(game, { actorId: 'u2', cardId: 'red_draw_two_c' });
    expect(outcome.error).to.equal(null);
    expect(game.pendingDraw).to.deep.equal({ count: 2 });
    expect(engine.currentActorId(game)).to.equal('u1');
  });
});

describe('UNO engine rules — 2 and 3 player special cases', () => {
  it('reverse acts as a skip with exactly two players', () => {
    const session = makeSessionOf(2);
    engine.startGame(session);
    const game = session.game;
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.REVERSE, null, 'a'), makeCard(COLORS.BLUE, TYPES.NUMBER, 2, 'x')],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 6, 'b')],
      ],
    });
    const outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_reverse_a' });
    expect(outcome.error).to.equal(null);
    // u2 is skipped entirely — play returns to u1.
    expect(engine.currentActorId(game)).to.equal('u1');
  });

  it('reverse flips direction (not a skip) with three players', () => {
    const session = makeSessionOf(3);
    engine.startGame(session);
    const game = session.game;
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [makeCard(COLORS.RED, TYPES.REVERSE, null, 'a'), makeCard(COLORS.BLUE, TYPES.NUMBER, 9, 'a-filler')],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 6, 'b')],
        [makeCard(COLORS.BLUE, TYPES.NUMBER, 1, 'c')],
      ],
    });
    const outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_reverse_a' });
    expect(outcome.error).to.equal(null);
    expect(game.turnState.direction).to.equal(-1);
    // Direction reversed: from u1, "next" going backwards is u3, not u2.
    expect(engine.currentActorId(game)).to.equal('u3');
  });

  it('plays a full 2-player game to completion (draw/skip/reverse/draw-two/wild all exercised)', () => {
    const session = makeSessionOf(2);
    engine.startGame(session);
    const game = session.game;

    // u1 has just enough to go out; u2 has a spread of special cards so we
    // exercise draw, skip, reverse (as skip), draw-two, and wild along the way.
    setTable(game, {
      top: makeCard(COLORS.RED, TYPES.NUMBER, 1, 'top'),
      hands: [
        [
          makeCard(COLORS.RED, TYPES.SKIP, null, 'a1'),
          makeCard(COLORS.RED, TYPES.DRAW_TWO, null, 'a2'),
          makeCard(COLORS.RED, TYPES.REVERSE, null, 'a3'),
          makeCard(COLORS.WILD, TYPES.WILD, null, 'a4'),
          makeCard(COLORS.BLUE, TYPES.NUMBER, 9, 'a5'),
        ],
        [makeCard(COLORS.YELLOW, TYPES.NUMBER, 3, 'b1')],
      ],
    });

    // u1 skip -> u2 loses this turn entirely, back to u1.
    let outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_skip_a1' });
    expect(outcome.error).to.equal(null);
    expect(engine.currentActorId(game)).to.equal('u1');

    // u1 draw two -> deferred, u2 now owes 2.
    outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_draw_two_a2' });
    expect(outcome.error).to.equal(null);
    expect(game.pendingDraw).to.deep.equal({ count: 2 });
    expect(engine.currentActorId(game)).to.equal('u2');

    // u2 has no +2 to stack and no other legal play while it's pending -> draws.
    outcome = engine.applyDrawCard(game, { actorId: 'u2' });
    expect(outcome.error).to.equal(null);
    expect(game.players[1].hand.length).to.equal(3);
    expect(game.pendingDraw).to.equal(null);
    expect(engine.currentActorId(game)).to.equal('u1');

    // u1 reverse with 2 players -> acts as skip, u1 goes again.
    outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'red_reverse_a3' });
    expect(outcome.error).to.equal(null);
    expect(engine.currentActorId(game)).to.equal('u1');

    // u1 plays a wild, choosing blue.
    outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'wild_wild_a4', chosenColor: 'blue' });
    expect(outcome.error).to.equal(null);
    expect(outcome.awaitingColorChoice).to.equal(false);
    expect(game.activeColor).to.equal('blue');
    expect(engine.currentActorId(game)).to.equal('u2');

    // u2 has no blue card and nothing matching — draws.
    outcome = engine.applyDrawCard(game, { actorId: 'u2' });
    expect(outcome.error).to.equal(null);
    expect(engine.currentActorId(game)).to.equal('u1');

    // u1 finishes with their last card.
    outcome = engine.applyPlayCard(game, { actorId: 'u1', cardId: 'blue_number_9_a5', callUno: true });
    expect(outcome.completed).to.equal(true);
    expect(outcome.results.find((r) => r.userId === 'u1')).to.deep.include({ position: 1, role: 'winner' });
    expect(outcome.results.find((r) => r.userId === 'u2')).to.include({ position: 2, role: 'loser' });
    expect(game.status).to.equal('completed');
  });
});
