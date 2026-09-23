// Turn order, direction (reverse), and seat rotation. Operates on a plain
// `{ order, currentIndex, direction }` turn-state object — knows nothing
// about cards, hands, or sockets.

export function buildTurnOrder(players) {
  return [...players]
    .sort((a, b) => a.seatNumber - b.seatNumber)
    .map((p) => p.userId ?? `bot:${p.seatNumber}`);
}

export function createTurnState(playerIds) {
  return { order: [...playerIds], currentIndex: 0, direction: 1 };
}

export function currentPlayerId(turnState) {
  return turnState.order[turnState.currentIndex] ?? null;
}

export function reverseDirection(turnState) {
  turnState.direction *= -1;
}

/** Moves the turn pointer `steps` seats forward in the current direction. */
export function stepIndex(turnState, steps = 1) {
  const len = turnState.order.length;
  if (len === 0) {
    turnState.currentIndex = 0;
    return;
  }
  turnState.currentIndex = (((turnState.currentIndex + steps * turnState.direction) % len) + len) % len;
}

/**
 * Removes a player who has finished (emptied their hand) from the rotation.
 * When the removed seat is the current turn holder, the pointer lands on
 * whoever is now "next" for free (the array shifted under it) — callers
 * should treat that as the equivalent of one normal turn-advance step and
 * not call `stepIndex` again for the base advance.
 */
export function removePlayer(turnState, playerId) {
  const idx = turnState.order.indexOf(playerId);
  if (idx === -1) return;

  turnState.order.splice(idx, 1);
  if (idx < turnState.currentIndex) {
    turnState.currentIndex -= 1;
  }
  if (turnState.order.length > 0) {
    turnState.currentIndex = ((turnState.currentIndex % turnState.order.length) + turnState.order.length) % turnState.order.length;
  } else {
    turnState.currentIndex = 0;
  }
}
