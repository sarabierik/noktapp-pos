'use strict';
/**
 * Payments and the shift cash drawer.
 * A payment can be plain (cash / card typed in by the cashier) or fiscal -
 * when the ÖKC device is in play the fiscal module creates the transaction and
 * calls back in here once the device approves it.
 */
const db = require('../db');
const orders = require('./orders');
const { money, minor } = require('../util/http');

const METHODS = ['nakit', 'kredi_karti', 'yemek_karti', 'havale', 'ikram', 'acik_hesap'];

async function addPayment(clientId, orderId, { method, amount, userId, channel = 'pos', guest = null, fiscalTxId = null }) {
  if (!METHODS.includes(method)) { const e = new Error('Gecersiz odeme turu'); e.status = 400; throw e; }
  return db.tx(async t => {
    const o = await t.one('SELECT * FROM orders WHERE id=? AND client_id=? AND is_deleted=0 FOR UPDATE', [orderId, clientId]);
    if (!o) { const e = new Error('Adisyon bulunamadi'); e.status = 404; throw e; }
    if (o.status === 'cancelled') { const e = new Error('Iptal edilmis adisyona odeme alinamaz'); e.status = 409; throw e; }
    const paid = Number(await t.value(
      'SELECT COALESCE(SUM(amount),0) FROM order_payments WHERE order_id=? AND client_id=? AND is_deleted=0 AND voided_at IS NULL',
      [orderId, clientId]));
    const due = money(Number(o.grand_total) - paid);
    const amt = money(amount);
    /*
     * An OPEN bill with nothing left to pay is finished, and closing it is the
     * only thing left to do. No payment row is written - there is no money to
     * record - and the close is itself the record.
     *
     * Two real bills reach this. A bill given away whole (100% ikram, or a
     * loyalty reward that covered every line) has grand_total 0: it was refused
     * here, refused by closeIfPaid, and sat open for ever - table red, stock
     * never deducted, gun sonu blocked because "a bill is still open", so one
     * free meal stopped the restaurant ending its day. And a bill REOPENED to
     * be looked at and not changed still carries the payment that closed it, so
     * its due is already zero: there was no way back to closed through the till
     * at all - test/smoke.js had to force it with an UPDATE.
     *
     * "Adisyonda odenecek tutar kalmadi" now means what it says: the bill is
     * settled AND already closed.
     */
    if (due <= 0) {
      if (o.status === 'open') {
        const closedNow = await orders.closeIfPaid(t, clientId, orderId, userId);
        if (closedNow) return { id: null, amount: 0, tendered: money(amount) || 0, due_before: 0, change: 0, closed: true };
      }
      const e = new Error('Adisyonda odenecek tutar kalmadi'); e.status = 409; throw e;
    }
    if (amt <= 0) { const e = new Error('Tutar sifirdan buyuk olmali'); e.status = 400; throw e; }

    /*
     * The drawer gets the tendered note; the BILL gets what it is owed.
     *
     * Storing the whole 100 TL handed over for an 85 TL bill made the payments
     * sum to more than the bill, so the Z report's tahsilat, the shift's
     * expected cash and the day's takings were each over by the para ustu that
     * had already been handed back across the counter. What stays in the till
     * is exactly `applied`; `change` is what leaves it again.
     */
    const applied = money(Math.min(amt, due));
    const change = money(amt - applied);

    const shift = await t.one("SELECT id FROM pos_shifts WHERE client_id=? AND status='open' ORDER BY id DESC LIMIT 1", [clientId]);
    const id = await t.insert(
      `INSERT INTO order_payments (client_id, order_id, method, amount, fiscal_transaction_id,
          paid_by_guest, payment_channel, created_at, created_by, is_deleted, shift_id)
       VALUES (?,?,?,?,?,?,?,NOW(),?,0,?)`,
      [clientId, orderId, method, applied, fiscalTxId, guest, channel, userId || null, shift ? shift.id : null]);

    const closed = await orders.closeIfPaid(t, clientId, orderId, userId);
    return { id, amount: applied, tendered: amt, due_before: due, change, closed };
  });
}

async function voidPayment(clientId, paymentId, { userId, reason, ip, ua }) {
  return db.tx(async t => {
    const p = await t.one('SELECT * FROM order_payments WHERE id=? AND client_id=? FOR UPDATE', [paymentId, clientId]);
    if (!p) { const e = new Error('Odeme bulunamadi'); e.status = 404; throw e; }
    if (p.voided_at || p.is_deleted) return { alreadyVoid: true };
    await t.exec('UPDATE order_payments SET voided_at=NOW(), voided_by=?, void_reason=? WHERE id=?',
      [userId || null, reason || null, paymentId]);
    await t.insert(
      `INSERT INTO payment_delete_logs (client_id, payment_id, order_id, table_id, method, amount,
          payment_created_at, deleted_at, deleted_by, ip_address, user_agent, original_data)
       VALUES (?,?,?,(SELECT table_id FROM orders WHERE id=?),?,?,?,NOW(),?,?,?,?)`,
      [clientId, paymentId, p.order_id, p.order_id, p.method, p.amount, p.created_at,
       userId || 0, ip || null, ua || null, JSON.stringify(p)]);
    // a voided payment can un-close a bill
    const o = await t.one('SELECT * FROM orders WHERE id=? AND client_id=?', [p.order_id, clientId]);
    const paid = Number(await t.value(
      'SELECT COALESCE(SUM(amount),0) FROM order_payments WHERE order_id=? AND client_id=? AND is_deleted=0 AND voided_at IS NULL',
      [p.order_id, clientId]));
    if (o.status === 'closed' && paid < Number(o.grand_total)) {
      await t.exec("UPDATE orders SET status='open', is_closed=0, closed_at=NULL, closed_by=NULL WHERE id=?", [p.order_id]);
      if (o.table_id) await t.exec('UPDATE restaurant_tables SET is_occupied=1 WHERE id=?', [o.table_id]);
    }
    return { voided: true };
  });
}

/* ---------------------------- shifts ------------------------------ */
async function openShift(clientId, { userId, userName, openingFloat = 0, deviceId = null }) {
  const bd = require('../util/businessDay');
  const date = await bd.currentBusinessDate();
  return db.tx(async t => {
    const cur = await t.one("SELECT id FROM pos_shifts WHERE client_id=? AND status='open'", [clientId]);
    if (cur) { const e = new Error('Zaten acik bir vardiya var'); e.status = 409; throw e; }
    const no = Number(await t.value('SELECT COALESCE(MAX(shift_no),0)+1 FROM pos_shifts WHERE client_id=? AND business_date=?',
      [clientId, date]));
    const id = await t.insert(
      `INSERT INTO pos_shifts (client_id, shift_uid, device_id, business_date, shift_no, opened_by, opened_by_name,
          opened_at, opening_float_minor, status, created_at)
       VALUES (?,UUID(),?,?,?,?,?,NOW(),?,'open',NOW())`,
      [clientId, deviceId, date, no, userId || null, userName || null, minor(openingFloat)]);
    return { id, shift_no: no, business_date: date };
  });
}

/**
 * Money in or out of the drawer between sales.
 *
 * Validated here rather than in the screen, because there are two doors into
 * this: the till screen and the phone API. Unvalidated, a negative amount ADDED
 * to the drawer (out × −50 = +50), any direction that was not 'in' silently
 * became 'out', and a cash-out with no reason was accepted through the phone -
 * which is the one movement that most needs a reason next to it.
 */
async function shiftMovement(clientId, { direction, amount, reason, userId }) {
  const dir = String(direction || '').toLowerCase();
  if (dir !== 'in' && dir !== 'out') {
    const e = new Error('Hareket yonu "in" veya "out" olmali'); e.status = 400; throw e;
  }
  const amt = money(amount);
  if (!(amt > 0)) {
    const e = new Error('Tutar sifirdan buyuk olmali'); e.status = 400; throw e;
  }
  const why = String(reason == null ? '' : reason).trim();
  if (dir === 'out' && !why) {
    const e = new Error('Kasadan para cikisi icin sebep zorunlu'); e.status = 400; throw e;
  }
  return db.tx(async t => {
    const s = await t.one("SELECT id FROM pos_shifts WHERE client_id=? AND status='open' ORDER BY id DESC LIMIT 1", [clientId]);
    if (!s) { const e = new Error('Acik vardiya yok'); e.status = 409; throw e; }
    const id = await t.insert(
      `INSERT INTO pos_shift_movements (client_id, shift_id, movement_uid, direction, amount_minor, reason, user_id, created_at)
       VALUES (?,?,UUID(),?,?,?,?,NOW())`,
      [clientId, s.id, dir, minor(amt), why || null, userId || null]);
    return id;
  });
}

async function shiftSummary(clientId, shiftId = null) {
  const s = shiftId
    ? await db.one('SELECT * FROM pos_shifts WHERE id=? AND client_id=?', [shiftId, clientId])
    : await db.one("SELECT * FROM pos_shifts WHERE client_id=? AND status='open' ORDER BY id DESC LIMIT 1", [clientId]);
  if (!s) return null;
  const pays = await db.query(
    `SELECT method, COALESCE(SUM(amount),0) total, COUNT(*) cnt
       FROM order_payments WHERE client_id=? AND shift_id=? AND is_deleted=0 AND voided_at IS NULL
      GROUP BY method`, [clientId, s.id]);
  const mv = await db.query(
    'SELECT direction, COALESCE(SUM(amount_minor),0) t FROM pos_shift_movements WHERE client_id=? AND shift_id=? GROUP BY direction',
    [clientId, s.id]);
  const paidIn = Number((mv.find(m => m.direction === 'in') || {}).t || 0);
  const paidOut = Number((mv.find(m => m.direction === 'out') || {}).t || 0);
  const cash = Number((pays.find(p => p.method === 'nakit') || {}).total || 0);
  const card = pays.filter(p => p.method !== 'nakit').reduce((a, p) => a + Number(p.total), 0);
  /*
   * `voided_at IS NULL` to match every money figure beside it. Without it a
   * voided payment still counted its bill, so the X report's "ortalama adisyon"
   * divided real takings by bills that contributed nothing.
   */
  const orderCount = Number(await db.value(
    `SELECT COUNT(DISTINCT order_id) FROM order_payments
      WHERE client_id=? AND shift_id=? AND is_deleted=0 AND voided_at IS NULL`, [clientId, s.id]));
  return {
    shift: s, breakdown: pays,
    expected_cash: money(Number(s.opening_float_minor) / 100 + cash + paidIn / 100 - paidOut / 100),
    cash_sales: money(cash), card_sales: money(card),
    paid_in: money(paidIn / 100), paid_out: money(paidOut / 100),
    order_count: orderCount,
  };
}

async function closeShift(clientId, { countedCash, note, userId, userName }) {
  const sum = await shiftSummary(clientId);
  if (!sum) { const e = new Error('Acik vardiya yok'); e.status = 409; throw e; }
  const s = sum.shift;
  const counted = money(countedCash);
  /*
   * `AND status='open'` is the whole guard. Without it two cashiers closing at
   * once both succeeded and the slower one's count silently overwrote the
   * first - so the drawer variance recorded was whichever of them was later,
   * not whichever was counted. rowCount 0 means somebody got here first.
   */
  const n = await db.exec(
    `UPDATE pos_shifts SET closed_by=?, closed_by_name=?, closed_at=NOW(), counted_cash_minor=?,
        expected_cash_minor=?, variance_minor=?, cash_sales_minor=?, card_sales_minor=?,
        paid_in_minor=?, paid_out_minor=?, order_count=?, status='closed', note=?
      WHERE id=? AND status='open'`,
    [userId || null, userName || null, minor(counted), minor(sum.expected_cash),
     minor(counted - sum.expected_cash), minor(sum.cash_sales), minor(sum.card_sales),
     minor(sum.paid_in), minor(sum.paid_out), sum.order_count, note || null, s.id]);
  if (!n) { const e = new Error('Vardiya bu arada baska bir kasiyer tarafindan kapatildi'); e.status = 409; throw e; }
  return { ...sum, counted_cash: counted, variance: money(counted - sum.expected_cash) };
}

module.exports = { METHODS, addPayment, voidPayment, openShift, closeShift, shiftSummary, shiftMovement };
