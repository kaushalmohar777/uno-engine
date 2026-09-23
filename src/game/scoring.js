// Official UNO leftover-card scoring (Mattel):
// number cards = face value, skip/reverse/draw two = 20, wilds = 50.
import { TYPES } from './cards.js';

export function cardPoints(card) {
  if (!card) return 0;
  if (card.type === TYPES.NUMBER) return Number(card.value) || 0;
  if (card.type === TYPES.WILD || card.type === TYPES.WILD_DRAW_FOUR) return 50;
  return 20;
}

export function handPoints(hand) {
  return (hand || []).reduce((sum, card) => sum + cardPoints(card), 0);
}

function toResult(player) {
  return {
    userId: player.userId,
    seatNumber: player.seatNumber,
    position: player.position,
    role: player.role,
    points: player.points,
  };
}

/**
 * Ends the round the moment a player empties their hand (official UNO).
 * Winner is awarded the sum of leftover card points in every other hand.
 * Remaining players are losers, ranked by leftover points (lower is better).
 */
export function completeRound(gameState, winner) {
  const leftover = new Map(
    gameState.players.map((p) => [p.id, p.id === winner.id ? 0 : handPoints(p.hand)])
  );
  const awarded = gameState.players
    .filter((p) => p.id !== winner.id)
    .reduce((sum, p) => sum + leftover.get(p.id), 0);

  winner.finished = true;
  winner.position = 1;
  winner.role = 'winner';
  winner.points = awarded;

  const rankedLosers = gameState.players
    .filter((p) => p.id !== winner.id)
    .sort((a, b) => leftover.get(a.id) - leftover.get(b.id) || a.seatNumber - b.seatNumber);

  rankedLosers.forEach((player, index) => {
    player.finished = true;
    player.position = index + 2;
    player.role = 'loser';
    player.points = leftover.get(player.id);
  });

  gameState.status = 'completed';
  gameState.pendingAction = null;
  gameState.pendingDraw = null;
  gameState.turnState.order = [];
  gameState.results = [...gameState.players]
    .sort((a, b) => a.position - b.position)
    .map(toResult);

  return {
    finishedPlayers: gameState.results,
    results: gameState.results,
    winner: gameState.results[0],
    losers: gameState.results.filter((r) => r.role === 'loser'),
  };
}
