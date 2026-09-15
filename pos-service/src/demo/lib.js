'use strict';
/**
 * The plumbing the demo seeder needs and nothing else does.
 *
 * Two things matter here and both are about SIZE. Seven years of trading is
 * roughly half a million rows, and the naive way of writing them - one INSERT
 * per row through the same helpers the till uses - takes the better part of an
 * hour on a restaurant PC and looks like a hung installer.
 *
 *   bulk()      one INSERT per thousand rows instead of one per row.
 *   rng()       a SEEDED generator. The demo has to be reproducible: when
 *               somebody says "the 14 March 2023 report is wrong", the same
 *               build must produce the same 14 March. Math.random() cannot.
 */

const CHUNK = 500;

/**
 * Multi-row INSERT, chunked.
 *
 * The chunk is 500 rather than "all of them" because max_allowed_packet on a
 * default MariaDB is 16 MB and an order_items row is not small; a single
 * INSERT of 285,000 rows is a failed install with an error nobody can read.
 */
async function bulk(db, table, columns, rows, { ignore = false } = {}) {
  if (!rows.length) return 0;
  const cols = columns.map(c => '`' + c + '`').join(',');
  const ph = '(' + columns.map(() => '?').join(',') + ')';
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const sql = `INSERT ${ignore ? 'IGNORE ' : ''}INTO \`${table}\` (${cols}) VALUES ` +
      slice.map(() => ph).join(',');
    const params = [];
    for (const r of slice) for (const c of columns) params.push(r[c] === undefined ? null : r[c]);
    await db.exec(sql, params);
    written += slice.length;
  }
  return written;
}

/** mulberry32 - small, fast, and the same everywhere Node runs. */
function rng(seed = 20200101) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ dates */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const dt = (d) => ymd(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
const atTime = (day, h, m, s = 0) => {
  const x = new Date(day.getTime()); x.setHours(h, m, s, 0); return x;
};

/** Every day from `from` to `to` inclusive, as Date objects. */
function eachDay(from, to) {
  const out = [];
  for (let d = new Date(from.getTime()); d <= to; d = addDays(d, 1)) out.push(new Date(d.getTime()));
  return out;
}

/* ----------------------------------------------------------------- money */
/** Turkish menu prices: round to something a menu would actually print. */
function menuRound(v) {
  if (v < 50) return Math.max(5, Math.round(v / 5) * 5);
  if (v < 200) return Math.round(v / 5) * 5;
  return Math.round(v / 10) * 10;
}
const money = (v) => Math.round(v * 100) / 100;
const minor = (v) => Math.round(v * 100);

module.exports = { bulk, rng, ymd, dt, addDays, atTime, eachDay, menuRound, money, minor, CHUNK };
