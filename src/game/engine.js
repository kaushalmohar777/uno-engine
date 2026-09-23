// Wires deck/cards + turnManager + unoCallRules into UNO move validation,
// initial setup, and win detection. This module is the single source of
// truth for gameplay state — the realtime/session layer only transports
// `game:action` payloads in and reads the resulting state back out.
import { COLORS, PLAYABLE_COLORS, TYPES, isWildType, cardMatches } from './cards.js';
import { createPiles, drawFromPile, topOfDiscard, shuffle } from './deck.js';
import * as turnManager from './turnManager.js';
import * as unoCallRules from './unoCallRules.js';
import { completeRound } from './scoring.js';
import defaultVariant from './variants/standard.js';

function actorIdFor(sessionPlayer) {
  return sessionPlayer.userId ?? `bot:${sessionPlayer.seatNumber}`;
}

function getPlayer(gameState, actorId) {
  return gameState.players.find((p) => p.id === actorId) ?? null;
}

function error(message, kind = 'invalid_action') {
  return { error: { message, kind }, finishedPlayers: [], completed: false, results: null, awaitingColorChoice: false, turnChanged: false };
}

function ok(overrides = {}) {
  return {
    error: null,
    finishedPlayers: [],
    completed: false,
    results: null,
    awaitingColorChoice: false,
    turnChanged: true,
    ...overrides,
  };
}

/** Picks a reasonable default color when a wild's chooser can't act (auto-play/timeout). */
function autoPickColor(gameState) {
  const counts = Object.fromEntries(PLAYABLE_COLORS.map((c) => [c, 0]));
  for (const player of gameState.players) {
    if (player.finished) continue;
    for (const card of player.hand) {
      if (card.color !== COLORS.WILD) counts[card.color] += 1;
    }
  }
  return PLAYABLE_COLORS.reduce((best, c) => (counts[c] > counts[best] ? c : best), PLAYABLE_COLORS[0]);
}

function drawInitialDiscard(piles) {
  // House rule: a Wild Draw Four can never be the starting discard — reshuffle
  // it back in and try again.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const [card] = drawFromPile(piles, 1);
    if (card.type !== TYPES.WILD_DRAW_FOUR) return card;
    piles.drawPile = shuffle([...piles.drawPile, card]);
  }
}

/** Applies the "first card flipped" rule set that decides who plays first. */
function applyInitialDiscardEffect(gameState, card) {
  const len = gameState.turnState.order.length;

  switch (card.type) {
    case TYPES.SKIP:
      gameState.turnState.currentIndex = len > 0 ? 1 % len : 0;
      break;
    case TYPES.REVERSE:
      turnManager.reverseDirection(gameState.turnState);
      turnManager.stepIndex(gameState.turnState, 1);
      break;
    case TYPES.DRAW_TWO: {
      const firstId = turnManager.currentPlayerId(gameState.turnState);
      const firstPlayer = getPlayer(gameState, firstId);
      firstPlayer.hand.push(...drawFromPile(gameState.piles, 2));
      unoCallRules.resetCallIfHandSizeChanged(firstPlayer);
      turnManager.stepIndex(gameState.turnState, 1);
      break;
    }
    case TYPES.WILD:
      gameState.pendingAction = { type: 'choose_color', userId: turnManager.currentPlayerId(gameState.turnState), drawFour: false };
      break;
    default:
      gameState.activeColor = card.color;
  }
}

/**
 * Builds a fresh, independent game state for one session: new deck, dealt
 * hands, initial discard, and turn order. Attaches it to `session.game`.
 */
export function startGame(session, variant = defaultVariant) {
  const players = [...session.players]
    .sort((a, b) => a.seatNumber - b.seatNumber)
    .map((p) => ({
      id: actorIdFor(p),
      userId: p.userId,
      seatNumber: p.seatNumber,
      isBot: !!p.isBot,
      hand: [],
      calledUno: false,
      finished: false,
      position: null,
      role: null,
      points: null,
    }));

  const piles = createPiles(variant.buildDeck);
  for (const player of players) {
    player.hand = drawFromPile(piles, variant.handSize);
  }

  const gameState = {
    variant: variant.name,
    players,
    piles,
    activeColor: null,
    turnState: turnManager.createTurnState(players.map((p) => p.id)),
    pendingAction: null,
    status: 'active',
    nextPosition: 1,
    results: null,
  };

  const initialCard = drawInitialDiscard(piles);
  piles.discardPile.push(initialCard);
  if (initialCard.color !== COLORS.WILD) gameState.activeColor = initialCard.color;
  applyInitialDiscardEffect(gameState, initialCard);

  session.game = gameState;
  return gameState;
}

export function currentActorId(gameState) {
  return turnManager.currentPlayerId(gameState.turnState);
}

export function getPlayerByActorId(gameState, actorId) {
  return getPlayer(gameState, actorId);
}

export function applyPlayCard(gameState, { actorId, cardId, chosenColor, callUno }) {
  if (gameState.status !== 'active') return error('Game is not active');
  if (gameState.pendingAction) return error('A color choice is pending — play choose_color first');

  const player = getPlayer(gameState, actorId);
  if (!player || player.finished) return error('Player is not part of the active game');
  if (turnManager.currentPlayerId(gameState.turnState) !== player.id) return error("It is not this player's turn");

  const cardIndex = player.hand.findIndex((c) => c.id === cardId);
  if (cardIndex === -1) return error('Card is not in hand');
  const card = player.hand[cardIndex];

  const topCard = topOfDiscard(gameState.piles);
  if (!cardMatches(card, { topCard, activeColor: gameState.activeColor })) {
    return error('Card does not match the current color/card');
  }

  if (isWildType(card.type) && chosenColor !== undefined && !PLAYABLE_COLORS.includes(chosenColor)) {
    return error('Invalid color choice');
  }

  player.hand.splice(cardIndex, 1);
  gameState.piles.discardPile.push(card);
  unoCallRules.resetCallIfHandSizeChanged(player);
  if (callUno && unoCallRules.canCallUno(player)) unoCallRules.callUno(player);

  const finishedPlayers = [];
  let finishedNow = false;
  if (player.hand.length === 0) {
    player.finished = true;
    player.position = gameState.nextPosition++;
    finishedNow = true;
    finishedPlayers.push({ userId: player.userId, seatNumber: player.seatNumber, position: player.position });
    turnManager.removePlayer(gameState.turnState, player.id);
  }

  const isWild = isWildType(card.type);
  let effectiveColor = chosenColor;

  if (isWild) {
    if (!effectiveColor) {
      if (finishedNow) {
        effectiveColor = autoPickColor(gameState);
      } else {
        gameState.activeColor = null;
        gameState.pendingAction = { type: 'choose_color', userId: player.id, drawFour: card.type === TYPES.WILD_DRAW_FOUR };
        return ok({ finishedPlayers, awaitingColorChoice: true, turnChanged: false });
      }
    }
    gameState.activeColor = effectiveColor;
  } else {
    gameState.activeColor = card.color;
  }

  applyTurnAdvanceEffects(gameState, card, finishedNow);

  // Official UNO: the round ends as soon as a player empties their hand,
  // after that last card's skip/draw effects have resolved.
  if (finishedNow) {
    const standings = completeRound(gameState, player);
    return ok({
      finishedPlayers: standings.finishedPlayers,
      completed: true,
      results: standings.results,
      turnChanged: false,
    });
  }

  return ok({ finishedPlayers, completed: false, results: null });
}

function applyTurnAdvanceEffects(gameState, card, finishedNow) {
  const turnState = gameState.turnState;
  let drawCount = 0;
  let extraSteps = 0;

  switch (card.type) {
    case TYPES.SKIP:
      extraSteps = 1;
      break;
    case TYPES.REVERSE:
      if (turnState.order.length > 2) {
        turnManager.reverseDirection(turnState);
      } else if (turnState.order.length === 2) {
        extraSteps = 1; // acts as a skip with exactly two players left
      }
      break;
    case TYPES.DRAW_TWO:
      drawCount = 2;
      break;
    case TYPES.WILD_DRAW_FOUR:
      drawCount = 4;
      break;
    default:
      break;
  }

  if (!finishedNow) {
    turnManager.stepIndex(turnState, 1);
  }

  if (drawCount > 0 && turnState.order.length > 0) {
    const targetId = turnManager.currentPlayerId(turnState);
    const targetPlayer = getPlayer(gameState, targetId);
    if (targetPlayer) {
      targetPlayer.hand.push(...drawFromPile(gameState.piles, drawCount));
      unoCallRules.resetCallIfHandSizeChanged(targetPlayer);
    }
    turnManager.stepIndex(turnState, 1);
  } else if (extraSteps > 0 && turnState.order.length > 0) {
    turnManager.stepIndex(turnState, extraSteps);
  }
}

export function applyChooseColor(gameState, { actorId, chosenColor }) {
  if (gameState.status !== 'active') return error('Game is not active');
  if (!gameState.pendingAction) return error('No color choice is pending');
  if (gameState.pendingAction.userId !== actorId) return error('Only the player who played the wild card may choose the color');
  if (!PLAYABLE_COLORS.includes(chosenColor)) return error('Invalid color choice');

  const drawFour = gameState.pendingAction.drawFour;
  gameState.activeColor = chosenColor;
  gameState.pendingAction = null;

  const turnState = gameState.turnState;
  turnManager.stepIndex(turnState, 1);

  if (drawFour && turnState.order.length > 0) {
    const targetId = turnManager.currentPlayerId(turnState);
    const targetPlayer = getPlayer(gameState, targetId);
    if (targetPlayer) {
      targetPlayer.hand.push(...drawFromPile(gameState.piles, 4));
      unoCallRules.resetCallIfHandSizeChanged(targetPlayer);
    }
    turnManager.stepIndex(turnState, 1);
  }

  return ok({ finishedPlayers: [], completed: false, results: null });
}

export function applyDrawCard(gameState, { actorId }) {
  if (gameState.status !== 'active') return error('Game is not active');
  if (gameState.pendingAction) return error('A color choice is pending — play choose_color first');

  const player = getPlayer(gameState, actorId);
  if (!player || player.finished) return error('Player is not part of the active game');
  if (turnManager.currentPlayerId(gameState.turnState) !== player.id) return error("It is not this player's turn");

  player.hand.push(...drawFromPile(gameState.piles, 1));
  unoCallRules.resetCallIfHandSizeChanged(player);
  turnManager.stepIndex(gameState.turnState, 1);

  return ok();
}

export function applyCallUno(gameState, { actorId }) {
  if (gameState.status !== 'active') return error('Game is not active');

  const player = getPlayer(gameState, actorId);
  if (!player || player.finished) return error('Player is not part of the active game');
  if (!unoCallRules.canCallUno(player)) return error('You can only call UNO while holding exactly one card');

  unoCallRules.callUno(player);
  return ok({ turnChanged: false });
}

/**
 * Called when a turn/color-choice timer expires — keeps the game moving for
 * an AFK human or an unimplemented bot AI by auto-choosing a color or
 * auto-drawing on the stuck player's behalf.
 */
export function forceAdvanceOnTimeout(gameState) {
  if (gameState.status !== 'active') return error('Game is not active');

  if (gameState.pendingAction) {
    return applyChooseColor(gameState, { actorId: gameState.pendingAction.userId, chosenColor: autoPickColor(gameState) });
  }

  const actorId = turnManager.currentPlayerId(gameState.turnState);
  if (!actorId) return error('No active turn');
  return applyDrawCard(gameState, { actorId });
}

export function buildPublicView(gameState) {
  const topCard = topOfDiscard(gameState.piles);
  return {
    status: gameState.status,
    activeColor: gameState.activeColor,
    topCard,
    direction: gameState.turnState.direction,
    currentActorId: currentActorId(gameState),
    pendingColorChoice: gameState.pendingAction ? { userId: gameState.pendingAction.userId } : null,
    players: gameState.players.map((p) => ({
      userId: p.userId,
      seatNumber: p.seatNumber,
      isBot: p.isBot,
      handCount: p.hand.length,
      calledUno: p.calledUno,
      finished: p.finished,
      position: p.position,
      role: p.role || null,
      points: p.points ?? null,
    })),
  };
}

export function buildPrivateHand(gameState, actorId) {
  const player = getPlayer(gameState, actorId);
  return player ? player.hand : [];
}
