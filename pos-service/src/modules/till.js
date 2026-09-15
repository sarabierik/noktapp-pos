'use strict';
/**
 * KASA - vardiya, cekmece, kasa sayimi, X raporu.
 *
 * The shift ENGINE is not here. `modules/payments.js` already opens, closes,
 * moves money in and out of a drawer and knows how to compute what should be
 * in it; it is tested and every payment in the product already tags itself to
 * the open shift. Writing a second one would guarantee two answers to "how
 * much is in the till", which is the exact disease this build exists to cure.
 *
 * What lives here is everything payments.js deliberately does not do:
 *
 *   * the RULES around a movement (a cash-out with no reason is not a
 *     bookkeeping entry, it is a missing note - so it is refused),
 *   * the denomination count, so the cashier counts the drawer instead of
 *     typing a number and the arithmetic is the server's,
 *   * the X report, which is the shift position mid-service with nothing
 *     closed and nothing reset,
 *   * the drawer audit trail, because kicking the drawer open with no sale
 *     behind it is the oldest theft signal there is and until now it left no
 *     trace at all,
 *   * and the reading rule that makes a closed shift a RECORD: once closed,
 *     the figures come from the stored columns, never from a fresh query. A
 *     payment that syncs in from an offline device an hour later must not
 *     silently restate a drawer somebody already counted and signed off.
 */
const crypto = require('crypto');
const db = require('../db');
const payments = require('./payments');
const printing = require('../print');
const bd = require('../util/businessDay');
const { money, minor, fromMinor } = require('../util/http');

/**
 * Turkish notes and coins, largest first - the order a cashier stacks them in.
 *
 * 1, 5, 10 and 25 kurus coins are legal tender but nobody in a restaurant
 * counts them; 25 kr is the smallest that still turns up in change, so the
 * list stops there. Values are in kurus so the count never touches a float.
 */
const DENOMS = [
  { minor: 20000, label: '200 ₺', kind: 'banknot' },
  { minor: 10000, label: '100 ₺', kind: 'banknot' },
  { minor: 5000, label: '50 ₺', kind: 'banknot' },
  { minor: 2000, label: '20 ₺', kind: 'banknot' },
  { minor: 1000, label: '10 ₺', kind: 'banknot' },
  { minor: 500, label: '5 ₺', kind: 'banknot' },
  { minor: 100, label: '1 ₺', kind: 'madeni' },
  { minor: 50, label: '50 kr', kind: 'madeni' },
  { minor: 25, label: '25 kr', kind: 'madeni' },
];

function bad(message, status = 400, code = null) {
  const e = new Error(message); e.status = status; if (code) e.code = code; return e;
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));

/* --------------------------- kasa sayimi -------------------------- */
/**
 * Add up a denomination count.
 *
 * The client sends how many of each note it counted; the TOTAL is computed
 * here and nowhere else. A till that could post its own total could post a
 * total that does not match its own notes, and the variance - the only figure
 * anybody looks at afterwards - would be built on the cashier's arithmetic.
 *
 * `counts` is keyed by the kurus value of the denomination: { "20000": 3 }.
 */
function countTotal(counts = {}) {
  const lines = DENOMS.map(d => {
    const raw = counts[String(d.minor)] !== undefined ? counts[String(d.minor)] : counts[d.minor];
    const n = Math.trunc(Number(raw) || 0);
    if (n < 0) throw bad(`${d.label} adedi eksi olamaz`);
    return { minor: d.minor, label: d.label, kind: d.kind, count: n, total_minor: d.minor * n };
  });
  const totalMinor = lines.reduce((a, l) => a + l.total_minor, 0);
  return { lines, total_minor: totalMinor, total: fromMinor(totalMinor) };
}

/** Was anything actually counted? An all-zero form is not a count. */
function hasCount(counts) {
  if (!counts || typeof counts !== 'object') return false;
  return DENOMS.some(d => Math.trunc(Number(counts[String(d.minor)] || counts[d.minor] || 0)) > 0);
}

/* ------------------------------ durum ----------------------------- */
/**
 * The live position of one shift, or of the open one when no id is given.
 *
 * OPEN: recomputed from the ledger on every read, because a payment taken two
 * seconds ago has to show.
 * CLOSED: read back from the columns the close wrote. See the file header -
 * a closed drawer is a signed record, not a running query.
 */
async function position(clientId, shiftId = null) {
  const sum = await payments.shiftSummary(clientId, shiftId);
  if (!sum) return null;
  const s = sum.shift;
  const closed = s.status === 'closed';

  const base = {
    shift: {
      id: s.id, shift_no: s.shift_no, business_date: s.business_date, status: s.status,
      opened_at: s.opened_at, opened_by_name: s.opened_by_name,
      closed_at: s.closed_at, closed_by_name: s.closed_by_name, note: s.note,
    },
    /* the per-method split is presentation only - it comes from the same rows
       payments.js grouped, so it can never disagree with the headline */
    breakdown: sum.breakdown.map(b => ({ method: b.method, count: Number(b.cnt), total: money(b.total) })),
  };

  if (!closed) {
    return {
      ...base,
      opening_float: fromMinor(s.opening_float_minor),
      cash_sales: sum.cash_sales,
      card_sales: sum.card_sales,
      paid_in: sum.paid_in,
      paid_out: sum.paid_out,
      expected_cash: sum.expected_cash,
      counted_cash: null,
      variance: null,
      order_count: sum.order_count,
    };
  }
  return {
    ...base,
    opening_float: fromMinor(s.opening_float_minor),
    cash_sales: fromMinor(s.cash_sales_minor),
    card_sales: fromMinor(s.card_sales_minor),
    paid_in: fromMinor(s.paid_in_minor),
    paid_out: fromMinor(s.paid_out_minor),
    expected_cash: fromMinor(s.expected_cash_minor),
    counted_cash: s.counted_cash_minor === null ? null : fromMinor(s.counted_cash_minor),
    variance: s.variance_minor === null ? null : fromMinor(s.variance_minor),
    order_count: Number(s.order_count || 0),
  };
}

/** The non-sale drawer ledger for one shift, newest first, with who did it. */
async function movements(clientId, shiftId, limit = 100) {
  const rows = await db.query(
    `SELECT m.id, m.direction, m.amount_minor, m.reason, m.user_id, m.created_at,
            u.display_name user_name
       FROM pos_shift_movements m
       LEFT JOIN users u ON u.id=m.user_id
      WHERE m.client_id=? AND m.shift_id=? ORDER BY m.id DESC LIMIT ?`,
    [clientId, shiftId, Number(limit) || 100]);
  return rows.map(m => ({
    id: m.id, direction: m.direction, amount: fromMinor(m.amount_minor),
    reason: m.reason, user_id: m.user_id, user_name: m.user_name, created_at: m.created_at,
  }));
}

/** Everything the kasa screen draws in one round trip. */
async function state(clientId) {
  const open = await position(clientId);
  const date = await bd.currentBusinessDate();
  if (open) {
    return {
      business_date: date,
      shift: open,
      movements: await movements(clientId, open.shift.id),
      counts: await counts(clientId, open.shift.id),
      last_closed: null,
      denominations: DENOMS,
    };
  }
  /* No open drawer: the screen still has to show the last one that closed,
     because "how did the previous shift come out" is the first question the
     cashier taking over asks, and it used to mean opening a report. */
  const prev = await db.one(
    "SELECT id FROM pos_shifts WHERE client_id=? AND status='closed' ORDER BY id DESC LIMIT 1", [clientId]);
  return {
    business_date: date,
    shift: null,
    movements: prev ? await movements(clientId, prev.id) : [],
    counts: prev ? await counts(clientId, prev.id) : [],
    last_closed: prev ? await position(clientId, prev.id) : null,
    denominations: DENOMS,
  };
}

/* ------------------------------ vardiya ---------------------------- */
async function openShift(clientId, { userId, userName, openingFloat = 0, note = null }) {
  const float = money(openingFloat);
  /* A negative float is a typo every time - there is no such thing as owing
     the drawer money before the first sale - and it would poison every
     expected figure for the rest of the shift. */
  if (float < 0) throw bad('Açılış kasası eksi olamaz');
  const r = await payments.openShift(clientId, { userId, userName, openingFloat: float });
  if (note) await db.exec('UPDATE pos_shifts SET note=? WHERE id=? AND client_id=?', [String(note).slice(0, 255), r.id, clientId]);
  return position(clientId, r.id);
}

/**
 * Close the drawer against a physical count.
 *
 * `counts` (the denomination form) wins over `countedCash` (a typed total)
 * whenever anything was actually counted, so the number that reaches
 * pos_shifts is one the server added up itself.
 */
async function closeShift(clientId, { counts: form, countedCash, note, userId, userName }) {
  const open = await db.one(
    "SELECT * FROM pos_shifts WHERE client_id=? AND status='open' ORDER BY id DESC LIMIT 1", [clientId]);
  if (!open) throw bad('Açık vardiya yok', 409, 'no_open_shift');

  let counted = null;
  let breakdown = null;
  if (hasCount(form)) {
    breakdown = countTotal(form);
    counted = breakdown.total;
  } else if (countedCash !== undefined && countedCash !== null && countedCash !== '') {
    counted = money(countedCash);
  }
  if (counted === null) throw bad('Sayılan nakit tutarı gerekli');
  if (counted < 0) throw bad('Sayılan nakit eksi olamaz');

  const before = await position(clientId, open.id);
  const res = await payments.closeShift(clientId, { countedCash: counted, note, userId, userName });

  /* The count is filed even when the total was typed: an empty breakdown is
     itself the fact that nobody counted note by note. */
  await saveCount(clientId, open.id, {
    kind: 'close', counts: form, total: counted, expected: before.expected_cash,
    userId, userName, note,
  });
  return { ...(await position(clientId, open.id)), variance: money(res.variance) };
}

/** Closed drawers, newest first, with the variance that makes them worth reading. */
async function history(clientId, { limit = 30, from = null, to = null } = {}) {
  const where = ['client_id=?', "status='closed'"];
  const args = [clientId];
  if (from) { where.push('business_date>=?'); args.push(from); }
  if (to) { where.push('business_date<=?'); args.push(to); }
  args.push(Math.min(Number(limit) || 30, 200));
  const rows = await db.query(
    `SELECT * FROM pos_shifts WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, args);
  const shifts = rows.map(s => ({
    id: s.id, shift_no: s.shift_no, business_date: s.business_date,
    opened_at: s.opened_at, opened_by_name: s.opened_by_name,
    closed_at: s.closed_at, closed_by_name: s.closed_by_name, note: s.note,
    opening_float: fromMinor(s.opening_float_minor),
    cash_sales: fromMinor(s.cash_sales_minor), card_sales: fromMinor(s.card_sales_minor),
    paid_in: fromMinor(s.paid_in_minor), paid_out: fromMinor(s.paid_out_minor),
    expected_cash: fromMinor(s.expected_cash_minor),
    counted_cash: s.counted_cash_minor === null ? null : fromMinor(s.counted_cash_minor),
    variance: s.variance_minor === null ? null : fromMinor(s.variance_minor),
    order_count: Number(s.order_count || 0),
  }));
  /* The point of a history list is the pattern, not the row: one short drawer
     is a bad night, the same cashier short eight times is a conversation. */
  const byUser = {};
  for (const s of shifts) {
    const k = s.closed_by_name || '—';
    byUser[k] = byUser[k] || { name: k, shifts: 0, short: 0, over: 0, net: 0 };
    byUser[k].shifts++;
    byUser[k].net = money(byUser[k].net + (s.variance || 0));
    if ((s.variance || 0) < 0) byUser[k].short++;
    if ((s.variance || 0) > 0) byUser[k].over++;
  }
  return { shifts, by_user: Object.values(byUser).sort((a, b) => a.net - b.net) };
}

/* ---------------------------- hareketler --------------------------- */
/**
 * Money in or out of the drawer that is not a sale.
 *
 * The reason is mandatory on the way OUT and optional on the way in, and that
 * asymmetry is the whole control: money appearing in the drawer is at worst
 * untidy, money leaving it with no note beside it is indistinguishable from
 * money being taken. The old screen had a reason box and never checked it.
 */
async function movement(clientId, { direction, amount, reason, userId }) {
  const dir = direction === 'in' ? 'in' : direction === 'out' ? 'out' : null;
  if (!dir) throw bad('Hareket yönü geçersiz');
  const amt = money(amount);
  if (!(amt > 0)) throw bad('Tutar sıfırdan büyük olmalı');
  const why = reason === null || reason === undefined ? '' : String(reason).trim();
  if (dir === 'out' && !why) throw bad('Kasadan para çıkışı için açıklama zorunlu', 400, 'reason_required');

  const id = await payments.shiftMovement(clientId, { direction: dir, amount: amt, reason: why || null, userId });
  return { id, direction: dir, amount: amt, reason: why || null };
}

/* ---------------------------- kasa sayimi -------------------------- */
async function saveCount(clientId, shiftId, { kind = 'ara', counts: form, total, expected, userId, userName, note }) {
  const breakdown = hasCount(form) ? countTotal(form) : null;
  const totalMinor = breakdown ? breakdown.total_minor : minor(total);
  const expMinor = expected === null || expected === undefined ? null : minor(expected);
  const id = await db.insert(
    `INSERT INTO pos_cash_counts (client_id, shift_id, count_uid, kind, total_minor, expected_minor,
        variance_minor, breakdown_json, counted_by, counted_by_name, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())`,
    [clientId, shiftId, uuid(), kind, totalMinor, expMinor,
     expMinor === null ? null : totalMinor - expMinor,
     breakdown ? JSON.stringify(breakdown.lines.filter(l => l.count > 0).map(l => ({ minor: l.minor, count: l.count }))) : null,
     userId || null, userName || null, note ? String(note).slice(0, 255) : null]);
  return {
    id, kind, total: fromMinor(totalMinor),
    expected: expMinor === null ? null : fromMinor(expMinor),
    variance: expMinor === null ? null : fromMinor(totalMinor - expMinor),
    lines: breakdown ? breakdown.lines : [],
  };
}

/** A mid-shift count: the cashier checks the drawer without closing it. */
async function countDrawer(clientId, { counts: form, note, userId, userName }) {
  const open = await db.one(
    "SELECT id FROM pos_shifts WHERE client_id=? AND status='open' ORDER BY id DESC LIMIT 1", [clientId]);
  if (!open) throw bad('Açık vardiya yok', 409, 'no_open_shift');
  if (!hasCount(form)) throw bad('Sayım boş - hiçbir kupürden adet girilmemiş');
  const pos = await position(clientId, open.id);
  return saveCount(clientId, open.id, {
    kind: 'ara', counts: form, expected: pos.expected_cash, userId, userName, note,
  });
}

async function counts(clientId, shiftId) {
  const rows = await db.query(
    'SELECT * FROM pos_cash_counts WHERE client_id=? AND shift_id=? ORDER BY id DESC LIMIT 20',
    [clientId, shiftId]);
  return rows.map(c => ({
    id: c.id, kind: c.kind, total: fromMinor(c.total_minor),
    expected: c.expected_minor === null ? null : fromMinor(c.expected_minor),
    variance: c.variance_minor === null ? null : fromMinor(c.variance_minor),
    lines: c.breakdown_json ? JSON.parse(c.breakdown_json) : [],
    counted_by_name: c.counted_by_name, note: c.note, created_at: c.created_at,
  }));
}

/* ----------------------------- X raporu ---------------------------- */
/**
 * X raporu - the shift so far, with nothing closed and nothing reset.
 *
 * Every figure is read through position(), so the report and the screen above
 * it cannot drift apart: they are literally the same numbers. The drawer-open
 * count rides along because an X report is the moment somebody is looking, and
 * it is the cheapest place to surface it.
 */
async function xReport(clientId) {
  const pos = await position(clientId);
  if (!pos) throw bad('Açık vardiya yok', 409, 'no_open_shift');
  const takings = money(pos.cash_sales + pos.card_sales);
  const drawer = await db.one(
    `SELECT COUNT(*) total, SUM(CASE WHEN order_id IS NULL THEN 1 ELSE 0 END) no_sale
       FROM pos_drawer_events WHERE client_id=? AND shift_id=?`, [clientId, pos.shift.id]);
  return {
    kind: 'X',
    printed_at: new Date().toISOString(),
    shift: pos.shift,
    opening_float: pos.opening_float,
    breakdown: pos.breakdown,
    cash_sales: pos.cash_sales,
    card_sales: pos.card_sales,
    takings,
    paid_in: pos.paid_in,
    paid_out: pos.paid_out,
    expected_cash: pos.expected_cash,
    bill_count: pos.order_count,
    average_bill: pos.order_count ? money(takings / pos.order_count) : 0,
    drawer_opens: Number((drawer && drawer.total) || 0),
    drawer_opens_no_sale: Number((drawer && drawer.no_sale) || 0),
  };
}

/** The same report on the receipt printer, because the owner wants it on paper. */
async function printXReport(clientId, x) {
  const { Receipt } = require('../print/escpos');
  const width = Number(await db.getSetting('receipt_width', 48));
  const r = new Receipt(width);
  const c = await db.one('SELECT company_name FROM clients WHERE id=?', [clientId]);
  const f = (n) => Number(n || 0).toFixed(2);
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date();
  r.align('center').bold(true).double(true).line((c && c.company_name) || 'NOKTApp').double(false);
  r.line('X RAPORU').bold(false).align('left').rule('=');
  r.cols('Vardiya', '#' + x.shift.shift_no);
  r.cols('Is gunu', String(x.shift.business_date));
  r.cols('Acan', String(x.shift.opened_by_name || '-'));
  r.cols('Rapor', `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`);
  r.rule('-');
  r.line('ODEME TURLERI');
  for (const b of x.breakdown) r.cols('  ' + printing.methodLabel(b.method) + ` (${b.count})`, f(b.total));
  r.rule('-');
  r.bold(true).cols('TAHSILAT', f(x.takings)).bold(false);
  r.cols('Adisyon', String(x.bill_count));
  r.cols('Ortalama adisyon', f(x.average_bill));
  r.rule('-');
  r.cols('Acilis kasasi', f(x.opening_float));
  r.cols('Nakit satis', f(x.cash_sales));
  r.cols('Kart / diger', f(x.card_sales));
  r.cols('Kasaya giren', f(x.paid_in));
  r.cols('Kasadan cikan', f(x.paid_out));
  r.bold(true).cols('KASADA OLMASI GEREKEN', f(x.expected_cash)).bold(false);
  r.rule('-');
  r.cols('Cekmece acilisi', `${x.drawer_opens} (satissiz ${x.drawer_opens_no_sale})`);
  r.rule('=');
  r.align('center').line('Vardiya kapatilmadi').align('left');
  return printing.enqueue(clientId, { jobType: 'report', content: r.cut().build() });
}

/* ----------------------------- cekmece ----------------------------- */
/**
 * Open the drawer on purpose, and say so out loud.
 *
 * The kick pulse itself is one line; the row beside it is the feature. Every
 * opening is filed with the shift, the person and the reason, and an opening
 * with no order behind it is stored with order_id NULL so it can be counted
 * separately without a second table.
 */
async function openDrawer(clientId, { userId, userName, reason = null, orderId = null, ip = null } = {}) {
  const s = await db.one(
    "SELECT id FROM pos_shifts WHERE client_id=? AND status='open' ORDER BY id DESC LIMIT 1", [clientId]);
  const id = await db.insert(
    `INSERT INTO pos_drawer_events (client_id, shift_id, order_id, source, reason, user_id, user_name, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,NOW())`,
    [clientId, s ? s.id : null, orderId || null, orderId ? 'sale' : 'manual',
     reason ? String(reason).trim().slice(0, 190) : null, userId || null, userName || null,
     ip ? String(ip).slice(0, 64) : null]);
  /* The audit row is written FIRST and the pulse is best effort: a printer
     that is switched off must not lose the record that somebody asked. */
  let printed = true;
  try { await printing.openDrawer(clientId); } catch (_) { printed = false; }
  return { id, printed, shift_id: s ? s.id : null };
}

async function drawerLog(clientId, { limit = 100, shiftId = null, noSaleOnly = false } = {}) {
  const where = ['e.client_id=?'];
  const args = [clientId];
  if (shiftId) { where.push('e.shift_id=?'); args.push(shiftId); }
  if (noSaleOnly) where.push('e.order_id IS NULL');
  args.push(Math.min(Number(limit) || 100, 500));
  const rows = await db.query(
    `SELECT e.*, s.shift_no, o.adisyon_no
       FROM pos_drawer_events e
       LEFT JOIN pos_shifts s ON s.id=e.shift_id
       LEFT JOIN orders o ON o.id=e.order_id
      WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ?`, args);
  const byUser = await db.query(
    `SELECT COALESCE(user_name,'—') name, COUNT(*) total,
            SUM(CASE WHEN order_id IS NULL THEN 1 ELSE 0 END) no_sale
       FROM pos_drawer_events WHERE client_id=? GROUP BY COALESCE(user_name,'—')
      ORDER BY no_sale DESC`, [clientId]);
  return {
    events: rows.map(e => ({
      id: e.id, shift_id: e.shift_id, shift_no: e.shift_no, order_id: e.order_id,
      adisyon_no: e.adisyon_no, source: e.source, reason: e.reason,
      user_id: e.user_id, user_name: e.user_name, created_at: e.created_at,
    })),
    by_user: byUser.map(u => ({ name: u.name, total: Number(u.total), no_sale: Number(u.no_sale) })),
  };
}

module.exports = {
  DENOMS, countTotal, hasCount, position, movements, state,
  openShift, closeShift, history, movement,
  countDrawer, counts, saveCount, xReport, printXReport,
  openDrawer, drawerLog,
};
