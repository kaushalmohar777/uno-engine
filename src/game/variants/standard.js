// Default UNO variant config. A future variant (e.g. a house-rules or
// player-count-specific deck) is a sibling module exporting the same shape
// — engine.js takes it as a parameter so swapping variants never requires
// touching engine/turn/deck logic.
import { buildStandardDeck } from '../deck.js';

export default {
  name: 'standard',
  handSize: 7,
  buildDeck: buildStandardDeck,
};
