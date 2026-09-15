'use strict';
/** Small helpers so every route handler looks the same. */
function ok(res, data = {}) { res.json({ ok: true, ...data }); }
function fail(res, message, status = 400, code = null) {
  res.status(status).json({ ok: false, error: message, code });
}
/** Wrap an async handler so a rejected promise becomes a 500 instead of a hang. */
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
/*
 * A missing required field is the person's mistake, not the server's: it must
 * come back as a 400 they can read, never as a 500 with the database's column
 * name in it. Throw this from a module and the error handler does the rest.
 */
function bad(message) { const e = new Error(message); e.status = 400; return e; }
/** Reject empty / whitespace-only values, returning the trimmed text. */
function need(value, message) {
  const t = value === undefined || value === null ? '' : String(value).trim();
  if (!t) throw bad(message);
  return t;
}
function num(v, def = 0) { const n = Number(v); return Number.isFinite(n) ? n : def; }
/*
 * A required id, as a number, or a 400 saying which one was missing.
 *
 * `Number(req.body.courier_id)` on an absent field is NaN, and NaN handed to
 * the driver arrives at MariaDB as the bare word NaN - which it reads as a
 * COLUMN. The answer the cashier got was HTTP 500 and "Unknown column 'NaN' in
 * 'WHERE'", for the everyday mistake of tapping Assign before picking a
 * courier. Anywhere an id comes off the wire and goes into SQL, it comes
 * through here instead.
 */
function id(value, message) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw bad(message);
  return Math.trunc(n);
}
function money(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function minor(v) { return Math.round((Number(v) || 0) * 100); }
function fromMinor(v) { return Math.round(Number(v) || 0) / 100; }
/*
 * The LOCAL date, not the UTC one. `toISOString()` is UTC, so on a till in
 * Istanbul (UTC+3) everything defaulting to "today" flipped to tomorrow's date
 * at 21:00 - three hours of every evening service reported under the next day.
 */
function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/*
 * NUMBERS IN THE ADDRESS BAR.
 *
 * `/api/settings/users/abc/pin` used to answer HTTP 500 with "Unknown column
 * 'NaN' in 'WHERE'" - the driver had passed NaN straight through to MariaDB,
 * which reads the bare word NaN as a column name. Thirty-eight endpoints did
 * it, because thirty-eight handlers wrote `Number(req.params.id)` and none of
 * them could have known the id was rubbish.
 *
 * It is not a way in - the permission gate has already run and refused anybody
 * who should not be here - but it is the database's internals on a cashier's
 * screen, from nothing worse than a stale browser tab or a mistyped link.
 *
 * One `router.param` per router catches all of them before a handler runs.
 * Only the parameter names that ARE numbers everywhere: `/api/device/:id` and
 * `/api/auth/devices/:id` carry a hardware id, which is a varchar, and a
 * router that has one passes `except`.
 */
const NUMERIC_PARAMS = ['id', 'itemId', 'tableId', 'productId', 'orderId', 'userId',
  'customerId', 'zoneId', 'shiftId', 'programId', 'cardId', 'locationId', 'supplierId',
  'documentId', 'categoryId', 'stationId', 'deviceId', 'courierId', 'paymentId'];

function numericParams(router, except = []) {
  for (const name of NUMERIC_PARAMS) {
    if (except.includes(name)) continue;
    router.param(name, (req, res, next, value) => {
      if (/^\d{1,12}$/.test(String(value))) return next();
      return res.status(400).json({ ok: false, error: 'Geçersiz kayıt numarası', code: 'BAD_ID' });
    });
  }
  return router;
}

module.exports = { ok, fail, wrap, bad, need, num, id, numericParams, money, minor, fromMinor, today };
