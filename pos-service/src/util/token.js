'use strict';
/**
 * MASA JETONU - the code printed on a table's card.
 *
 * One generator, in one place, because there were two: floor.js minted 24 hex
 * characters and catalog.js minted 32, so a table created by the setup wizard
 * and a table created from the floor plan carried tokens of different lengths.
 * Nothing was broken by that - the column is UNIQUE and the lookup is an exact
 * match either way - but "how long is a table token" had two answers, and the
 * next person to write a validator would have picked one of them.
 *
 * The shape, and why:
 *
 *   * RANDOM, NOT DERIVED. Not the table id, not the name, not a counter. A
 *     guest who can work out masa 12's address from the card on masa 11 can
 *     order for masa 12. 96 bits from crypto.randomBytes has no relationship
 *     to the table it lands on, so there is nothing to increment.
 *   * 24 HEX CHARACTERS. 96 bits is far past guessing, and it still fits the
 *     varchar(32) column with room to spare. It is also short enough that a
 *     waiter can read one off a card and type it into a browser when a phone
 *     camera will not focus - which is a real thing that happens.
 *   * STORED, NOT COMPUTED. It lives on restaurant_tables.qr_token with
 *     qr_token_at beside it, so it survives a rename: a printed card lasts
 *     years and the name over the table does not.
 *   * RE-ISSUABLE ONE AT A TIME. floor.regenerateToken writes a new one for a
 *     single table, which kills the cards printed for THAT table and touches
 *     nothing else - the whole point of the button you press when a card has
 *     been photographed.
 *
 * Lower-case hex on purpose. The column's collation is case-insensitive, so a
 * card read back in capitals still resolves; keeping what we mint in one case
 * means the stored value and the printed value are the same string.
 */
const crypto = require('crypto');

const LENGTH = 24;

function tableToken() {
  return crypto.randomBytes(16).toString('hex').slice(0, LENGTH);
}

/** Shape only - whether a token could exist, not whether it does. */
function looksLikeToken(v) {
  return new RegExp(`^[0-9a-fA-F]{${LENGTH}}$`).test(String(v || '').trim());
}

module.exports = { tableToken, looksLikeToken, LENGTH };
