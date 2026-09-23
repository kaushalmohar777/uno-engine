// Deck construction/shuffling and draw/discard pile management. Every
// session builds and owns its own independent pile state — nothing here is
// global or shared across sessions.
import { COLORS, TYPES, PLAYABLE_COLORS, makeCard } from './cards.js';

/** Builds one physical 108-card standard UNO deck (fresh array each call). */
export function buildStandardDeck() {
  const cards = [];
  let seq = 0;
  const next = () => seq++;

  for (const color of PLAYABLE_COLORS) {
    cards.push(makeCard(color, TYPES.NUMBER, 0, next()));
    for (let value = 1; value <= 9; value++) {
      cards.push(makeCard(color, TYPES.NUMBER, value, next()));
      cards.push(makeCard(color, TYPES.NUMBER, value, next()));
    }
    for (const type of [TYPES.SKIP, TYPES.REVERSE, TYPES.DRAW_TWO]) {
      cards.push(makeCard(color, type, null, next()));
      cards.push(makeCard(color, type, null, next()));
    }
  }

  for (let i = 0; i < 4; i++) {
    cards.push(makeCard(COLORS.WILD, TYPES.WILD, null, next()));
    cards.push(makeCard(COLORS.WILD, TYPES.WILD_DRAW_FOUR, null, next()));
  }

  return cards;
}

export function shuffle(cards) {
  const shuffled = [...cards];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Creates a fresh, shuffled draw pile and empty discard pile for one
 * session, using the given deck-builder (so a future variant can swap
 * `buildDeck` without touching pile/draw logic).
 */
export function createPiles(buildDeck = buildStandardDeck) {
  return { drawPile: shuffle(buildDeck()), discardPile: [] };
}

/**
 * Draws `count` cards from the pile, reshuffling the discard pile (minus
 * its top card) back into the draw pile whenever it runs dry. Returns
 * fewer than `count` cards only if the deck is truly exhausted (both piles
 * empty), which cannot happen in a standard 108-card game with realistic
 * hand/discard sizes.
 */
export function drawFromPile(piles, count = 1) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (piles.drawPile.length === 0) reshuffleDiscardIntoDraw(piles);
    if (piles.drawPile.length === 0) break;
    drawn.push(piles.drawPile.pop());
  }
  return drawn;
}

function reshuffleDiscardIntoDraw(piles) {
  if (piles.discardPile.length <= 1) return;
  const top = piles.discardPile[piles.discardPile.length - 1];
  const rest = piles.discardPile.slice(0, -1);
  piles.drawPile = shuffle(rest);
  piles.discardPile = [top];
}

export function topOfDiscard(piles) {
  return piles.discardPile.length > 0 ? piles.discardPile[piles.discardPile.length - 1] : null;
}
