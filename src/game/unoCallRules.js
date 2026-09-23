// "UNO" call bookkeeping. A player who ends a turn holding exactly one card
// without having called UNO is vulnerable to an automatic catch-up penalty
// the next time turn control leaves them (no separate challenge_uno action
// in this iteration — see engine.js).

export function resetCallIfHandSizeChanged(player) {
  if (player.hand.length !== 1) {
    player.calledUno = false;
  }
}

export function canCallUno(player) {
  return player.hand.length === 1;
}

export function callUno(player) {
  if (!canCallUno(player)) return false;
  player.calledUno = true;
  return true;
}

/** True if the player must be penalized for holding one card silently. */
export function isCaughtWithoutCall(player) {
  return player.hand.length === 1 && !player.calledUno;
}
