// Card types (color/type/value) and matching rules. Pure data + pure
// functions — no session/game-state knowledge lives here.

export const COLORS = Object.freeze({
  RED: 'red',
  YELLOW: 'yellow',
  GREEN: 'green',
  BLUE: 'blue',
  WILD: 'wild',
});

export const PLAYABLE_COLORS = Object.freeze([COLORS.RED, COLORS.YELLOW, COLORS.GREEN, COLORS.BLUE]);

export const TYPES = Object.freeze({
  NUMBER: 'number',
  SKIP: 'skip',
  REVERSE: 'reverse',
  DRAW_TWO: 'draw_two',
  WILD: 'wild',
  WILD_DRAW_FOUR: 'wild_draw_four',
});

export function isWildType(type) {
  return type === TYPES.WILD || type === TYPES.WILD_DRAW_FOUR;
}

export function isActionType(type) {
  return type === TYPES.SKIP || type === TYPES.REVERSE || type === TYPES.DRAW_TWO || isWildType(type);
}

export function makeCard(color, type, value, uniqueSuffix) {
  const idParts = [color, type];
  if (value !== undefined && value !== null) idParts.push(String(value));
  idParts.push(String(uniqueSuffix));
  return Object.freeze({ id: idParts.join('_'), color, type, value: value ?? null });
}

/**
 * Whether `card` can legally be played on top of the current discard,
 * given the table's active color (which, after a wild, is the chosen
 * color rather than the wild card's own `color: "wild"`).
 */
export function cardMatches(card, { topCard, activeColor }) {
  if (isWildType(card.type)) return true;
  if (card.color === activeColor) return true;
  if (topCard && card.type === topCard.type) {
    // Same action type (e.g. any-color skip on any-color skip) always
    // matches; same-type numbers must also share their value.
    if (card.type === TYPES.NUMBER) return card.value === topCard.value;
    return true;
  }
  return false;
}
