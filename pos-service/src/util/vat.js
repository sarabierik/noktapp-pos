'use strict';
/**
 * Turkish KDV, in one place.
 *
 * KDV is INCLUSIVE: the menu price already contains the tax, so
 *
 *     vat    = gross * rate / (100 + rate)
 *     matrah = gross - vat
 *
 * and nothing is ever added on top. `gross * rate / 100` on a shelf price is
 * always a bug - it overstates the tax by rate/(100+rate) and makes the bill
 * disagree with the money in the drawer.
 *
 * The second thing this file exists for is that a bill-level discount is real
 * money coming off the sale, so it takes its share of the tax with it. A 10%
 * discount on a 10% KDV bill leaves 10% less KDV to declare; leaving the VAT at
 * the undiscounted figure hands the state tax on money the restaurant never
 * took. The discount is therefore SPREAD across the lines - in kurus, by the
 * largest-remainder method - before any tax is worked out, so the parts sum to
 * the whole exactly instead of to within a kurus.
 *
 * Everything that has to agree about a bill's KDV - the order engine, the
 * printed hesap fisi, the Z report - goes through `billVat`, so they cannot
 * drift apart the way five separate copies of this sum always eventually do.
 */
const { money, minor, fromMinor } = require('./http');

/** The KDV contained in a KDV-inclusive gross. Never added on top. */
function vatOf(gross, rate) {
  const r = Number(rate) || 0;
  if (r <= 0) return 0;
  return money(Number(gross || 0) * r / (100 + r));
}

/**
 * Split `total` kurus across `weights` so the parts sum to `total` EXACTLY.
 *
 * Rounding each share on its own leaves a kurus or two unallocated, and that
 * remainder is precisely what makes a KDV breakdown fail to add up to the
 * header. Largest remainder gives the stray kurus to the lines that were
 * rounded down hardest, which is both the fairest split and an exact one.
 */
function allocate(total, weights) {
  const n = weights.length;
  const out = new Array(n).fill(0);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!(total > 0) || !(sum > 0)) return out;
  const want = Math.min(total, sum);
  const rem = [];
  let given = 0;
  for (let i = 0; i < n; i++) {
    const exact = want * weights[i] / sum;
    out[i] = Math.min(Math.floor(exact), weights[i]);
    given += out[i];
    rem.push({ i, r: exact - Math.floor(exact) });
  }
  rem.sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; given < want && k < rem.length; k++) {
    const i = rem[k].i;
    if (out[i] < weights[i]) { out[i]++; given++; }
  }
  // a second sweep only matters when the first pass hit a line's own ceiling
  for (let i = 0; given < want && i < n; i++) {
    while (given < want && out[i] < weights[i]) { out[i]++; given++; }
  }
  return out;
}

/**
 * What a bill's KDV actually is, once every discount has come off.
 *
 * `lines` are the live lines as `{ lineTotal, vatRate }`, where lineTotal is
 * already `qty * unit_price - discount_amount` - the per-line discount lives
 * inside it. `billDiscount` is the bill-wide one on top of that.
 *
 * Returns the tax per rate as well as the total, and by construction
 * `sum(breakdown.vat) === vatTotal` and `base + vat === gross` for every rate,
 * with `sum(breakdown.gross) === grand`. Rate 0 lines are returned too, with no
 * tax, so the parts still sum to the whole; a caller that does not print a %0
 * row can drop it, but the arithmetic here is complete.
 */
function billVat(lines, billDiscount = 0) {
  const rows = (lines || []).map(l => ({
    rate: Number(l.vatRate || l.vat_rate || 0),
    gross: minor(l.lineTotal !== undefined ? l.lineTotal : l.line_total),
  }));
  const sum = rows.reduce((s, r) => s + r.gross, 0);
  const disc = Math.max(0, Math.min(minor(billDiscount), sum));
  const share = allocate(disc, rows.map(r => r.gross));

  const byRate = new Map();
  let vatTotal = 0;
  for (let i = 0; i < rows.length; i++) {
    const gross = rows[i].gross - share[i];
    const rate = rows[i].rate;
    const vat = rate > 0 ? Math.round(gross * rate / (100 + rate)) : 0;
    vatTotal += vat;
    const cur = byRate.get(rate) || { rate, gross: 0, vat: 0 };
    cur.gross += gross;
    cur.vat += vat;
    byRate.set(rate, cur);
  }
  return {
    vatTotal: fromMinor(vatTotal),
    grand: fromMinor(sum - disc),
    subtotal: fromMinor(sum),
    discount: fromMinor(disc),
    breakdown: [...byRate.values()].sort((a, b) => a.rate - b.rate).map(r => ({
      rate: r.rate,
      gross: fromMinor(r.gross),
      vat: fromMinor(r.vat),
      base: fromMinor(r.gross - r.vat),
    })),
  };
}

/** Fold one bill's breakdown into a running per-rate map, in kurus. */
function accumulate(map, breakdown) {
  for (const b of breakdown) {
    const cur = map.get(b.rate) || { rate: b.rate, gross: 0, vat: 0 };
    cur.gross += minor(b.gross);
    cur.vat += minor(b.vat);
    map.set(b.rate, cur);
  }
  return map;
}

/** Turn that running map back into money rows, smallest rate first. */
function finish(map) {
  return [...map.values()].sort((a, b) => a.rate - b.rate).map(r => ({
    rate: r.rate,
    gross: fromMinor(r.gross),
    vat: fromMinor(r.vat),
    base: fromMinor(r.gross - r.vat),
  }));
}

module.exports = { vatOf, allocate, billVat, accumulate, finish };
