'use strict';
/**
 * Money, in minor units, as strings.
 *
 * WHY NOT NUMBERS. JavaScript numbers are binary floating point. 0.1 + 0.2 is
 * 0.30000000000000004, and a till that adds a few hundred lines a night will
 * eventually disagree with the fiscal device about the total by one kuruş. The
 * device then rejects the basket, or worse, accepts a total the receipt does
 * not match. So every amount that crosses a boundary in this module is a
 * DECIMAL INTEGER STRING in minor units: "10990" is 109.90 TRY.
 *
 * Quantities are decimal strings with a scale, because 1.250 kg is a real
 * basket line and 1.25 is not the same string even though it is the same
 * number. The device's own scale decides which one it will accept; that
 * conversion belongs in the adapter, not here.
 *
 * Nothing in this file knows a VAT rate. Tax comes from the commissioned
 * device's approved mapping, never from a hard-coded national number.
 */

const MINOR = /^-?\d{1,18}$/;
const DECIMAL = /^-?\d{1,15}(\.\d{1,6})?$/;   // no exponent syntax, ever

function isMinor(v) { return typeof v === 'string' && MINOR.test(v); }
function isDecimal(v) { return typeof v === 'string' && DECIMAL.test(v); }

function bad(msg, code = 'AMOUNT_INVALID') {
  const e = new Error(msg); e.status = 400; e.code = code; return e;
}

/** Parse a minor-unit string to BigInt. Throws rather than guessing. */
function minor(v, field = 'amount') {
  if (!isMinor(v)) throw bad(`${field}: minor-unit integer string bekleniyor, gelen: ${JSON.stringify(v)}`);
  return BigInt(v);
}

/** BigInt back to the canonical string. */
function str(b) { return b.toString(); }

/**
 * A decimal amount as it comes out of the database -> minor-unit string.
 *
 * The till stores money as DECIMAL(10,2) and the driver hands it back as
 * "320.00" or 320. Everything in this module wants "32000". The obvious
 * conversion is Math.round(Number(v) * 100), which is what util/http.minor
 * does - and it is float arithmetic, which is exactly what this file exists
 * to keep away from a fiscal document. So the digits are moved by string
 * surgery and the result is built with BigInt; no Number is involved.
 *
 * More fraction digits than the scale is refused, not rounded. Silently
 * dropping a digit off a price is how a receipt stops matching the bill.
 */
function minorFromDecimal(v, field = 'amount', scale = 2) {
  const sv = (typeof v === 'string' ? v : String(v === null || v === undefined ? '' : v)).trim();
  if (!isDecimal(sv)) {
    throw bad(`${field}: ondalik tutar metni bekleniyor, gelen: ${JSON.stringify(v)}`);
  }
  const neg = sv.startsWith('-');
  const [whole, frac = ''] = sv.replace('-', '').split('.');
  if (frac.length > scale) {
    throw bad(`${field}: ${scale} haneden fazla kurus basamagi var (${sv}); `
      + 'yuvarlamak yerine reddediliyor.');
  }
  const out = BigInt(whole + (frac + '0'.repeat(scale)).slice(0, scale));
  return str(neg ? -out : out);
}

/**
 * Decimal string x minor-unit price -> minor units, half-up, exact.
 *
 * Done entirely in BigInt: the decimal is scaled to an integer, multiplied,
 * then divided back with an explicit rounding decision. No float touches it.
 */
function mulDecimal(quantity, unitPriceMinor, field = 'line') {
  if (!isDecimal(quantity)) throw bad(`${field}: miktar ondalik metin olmali, gelen: ${JSON.stringify(quantity)}`);
  const neg = quantity.startsWith('-');
  const [whole, frac = ''] = quantity.replace('-', '').split('.');
  const scale = BigInt(10) ** BigInt(frac.length);
  const q = BigInt(whole + frac);
  const p = minor(unitPriceMinor, `${field}.unitPrice`);
  const product = q * p;                       // scaled by `scale`
  // half-up on the absolute value, then restore the sign
  const half = scale / BigInt(2);
  const rest = product % scale;
  let out = product / scale;
  if (rest >= half && scale > BigInt(1)) out += BigInt(1);
  return str(neg ? -out : out);
}

function add(...vals) {
  return str(vals.reduce((a, v) => a + minor(v), BigInt(0)));
}
function sub(a, b) { return str(minor(a) - minor(b)); }
function cmp(a, b) { const x = minor(a), y = minor(b); return x < y ? -1 : x > y ? 1 : 0; }
function isNegative(v) { return minor(v) < BigInt(0); }
function isZero(v) { return minor(v) === BigInt(0); }

/** For a screen or a log line only. Never send this to a device. */
function human(v, currency = 'TRY') {
  const b = minor(v);
  const neg = b < BigInt(0);
  const s = (neg ? -b : b).toString().padStart(3, '0');
  const t = `${s.slice(0, -2)},${s.slice(-2)}`;
  return `${neg ? '-' : ''}${t} ${currency === 'TRY' ? '₺' : currency}`;
}

/**
 * The only currency the first production release accepts.
 *
 * A hotel folio that DISPLAYS euro does not establish that a Turkish fiscal
 * device will accept euro. Widening this is a vendor-contract decision, not a
 * code change.
 */
const CURRENCY = 'TRY';
function assertCurrency(c, field = 'currency') {
  if (c !== CURRENCY) throw bad(`${field}: yalnizca ${CURRENCY} destekleniyor, gelen: ${c}`, 'CURRENCY_UNSUPPORTED');
}

module.exports = {
  CURRENCY, isMinor, isDecimal, minor, str, minorFromDecimal,
  mulDecimal, add, sub, cmp, isNegative, isZero, human, assertCurrency, bad,
};
