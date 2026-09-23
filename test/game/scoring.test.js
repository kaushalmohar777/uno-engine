import { expect } from 'chai';
import { makeCard, TYPES, COLORS } from '../../src/game/cards.js';
import { cardPoints, handPoints, completeRound } from '../../src/game/scoring.js';

describe('UNO leftover scoring', () => {
  it('scores number cards at face value', () => {
    expect(cardPoints(makeCard(COLORS.RED, TYPES.NUMBER, 0, 1))).to.equal(0);
    expect(cardPoints(makeCard(COLORS.BLUE, TYPES.NUMBER, 9, 2))).to.equal(9);
  });

  it('scores skip/reverse/draw two at 20', () => {
    expect(cardPoints(makeCard(COLORS.RED, TYPES.SKIP, null, 1))).to.equal(20);
    expect(cardPoints(makeCard(COLORS.YELLOW, TYPES.REVERSE, null, 2))).to.equal(20);
    expect(cardPoints(makeCard(COLORS.GREEN, TYPES.DRAW_TWO, null, 3))).to.equal(20);
  });

  it('scores wilds at 50', () => {
    expect(cardPoints(makeCard(COLORS.WILD, TYPES.WILD, null, 1))).to.equal(50);
    expect(cardPoints(makeCard(COLORS.WILD, TYPES.WILD_DRAW_FOUR, null, 2))).to.equal(50);
  });

  it('awards the winner the sum of leftover hands and ranks losers by leftover', () => {
    const winner = { id: 'w', userId: 'w', seatNumber: 1, hand: [] };
    const a = { id: 'a', userId: 'a', seatNumber: 2, hand: [makeCard(COLORS.RED, TYPES.NUMBER, 3, 1)] };
    const b = { id: 'b', userId: 'b', seatNumber: 3, hand: [makeCard(COLORS.WILD, TYPES.WILD, null, 2)] };
    const c = { id: 'c', userId: 'c', seatNumber: 4, hand: [makeCard(COLORS.BLUE, TYPES.SKIP, null, 3)] };
    const gameState = {
      players: [winner, a, b, c],
      pendingAction: { type: 'choose_color' },
      turnState: { order: ['a', 'b', 'c'], currentIndex: 0, direction: 1 },
    };

    const standings = completeRound(gameState, winner);

    expect(handPoints(a.hand)).to.equal(3);
    expect(standings.winner).to.deep.include({ userId: 'w', position: 1, role: 'winner', points: 73 });
    expect(standings.losers.map((l) => l.userId)).to.deep.equal(['a', 'c', 'b']);
    expect(standings.losers.map((l) => l.points)).to.deep.equal([3, 20, 50]);
    expect(gameState.status).to.equal('completed');
  });
});
