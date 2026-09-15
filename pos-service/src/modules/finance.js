'use strict';
/**
 * Finans arka ofisi: İşlemler, Gün sonu, Finans raporu.
 *
 * Three screens live here, and they exist because the old PHP spread the same
 * job over eighty-eight files that disagreed with each other:
 *
 *   1. İŞLEMLER - the closed-bill list, with the destructive buttons on it.
 *      Deleting a bill is how money leaves the books, so every one of those
 *      buttons is owner-only on the SERVER and every one of them is stopped by
 *      the checkpoint below.
 *   2. GÜN SONU - the day list, the day detail, close and reopen.
 *   3. FİNANS RAPORU - the period report.
 *
 * Nothing here computes profit. `pnl.js` is the one profit engine in the
 * product and every figure on these three screens comes out of it, so the
 * finance report, the P&L screen and the closing record can never disagree
 * about what a Tuesday was worth. The old system had nine answers.
 *
 * ------------------------------------------------------------------------
 * THE CHECKPOINT - what "kapalı gün" actually locks
 *
 * A checkpoint is NOT a date. It is the most recent `daily_closings.closed_at`
 * for this tenant, across every date. Closing any one day therefore freezes
 * every bill in the tenant's history that was closed at or before that moment.
 * That is deliberate: once you have signed off a day, the takings that were on
 * the books when you signed cannot be quietly altered afterwards.
 *
 * We deviate from the PHP in one place. The PHP's reopen DELETED the closing
 * row, so the checkpoint moved back on its own. We keep the row and flag
 * `is_reopened=1` (that is what `reports.reopenDay` already does, and it is the
 * only record that the day was ever signed off), so the checkpoint query has to
 * skip reopened closings - otherwise reopening a day would unlock nothing.
 */
const db = require('../db');
const pnl = require('./pnl');
const reports = require('./reports');
const bd = require('../util/businessDay');
const { money } = require('../util/http');

/*
 * These two must stay character-for-character identical to pnl.js. A bill that
 * counts on the P&L screen and does not count on the finance report is the
 * exact bug this rebuild exists to remove.
 */
const COUNTED = `o.status='closed' AND o.is_deleted=0 AND COALESCE(o.exclude_from_reports,0)=0`;
const DAY = `COALESCE(o.business_date, DATE(o.closed_at))`;

const TR_DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

function pct(part, whole) { return whole > 0 ? money(part / whole * 100) : 0; }
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function day10(v) { return String(v || '').slice(0, 10); }
function weekday(date) {
  const d = new Date(day10(date) + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? '' : TR_DAYS[d.getDay()];
}
function bad(message, status = 400, code = null) {
  const e = new Error(message); e.status = status; e.code = code; return e;
}
function shift(date, days) {
  const d = new Date(day10(date) + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Clean a date range. An unparseable date is replaced rather than passed to
 * MariaDB, and a backwards range is swapped instead of silently returning
 * nothing - a user who types the two dates the wrong way round has made a typo,
 * not a request for an empty report.
 */
async function bounds(from, to) {
  const today = await bd.currentBusinessDate();
  let f = isDate(from) ? from : today;
  let t = isDate(to) ? to : today;
  if (f > t) { const x = f; f = t; t = x; }
  return { from: f, to: t };
}

/* =====================================================================
   CHECKPOINT
   ===================================================================== */

/** The moment the tenant last signed off a day, or null if never. */
async function checkpoint(clientId) {
  const v = await db.value(
    `SELECT MAX(closed_at) FROM daily_closings
      WHERE client_id=? AND COALESCE(is_reopened,0)=0`, [clientId]);
  return v ? String(v) : null;
}

/*
 * Both closed_at values are 'YYYY-MM-DD HH:MM:SS' strings (the pool runs with
 * dateStrings), and that format sorts lexicographically, so no Date objects and
 * therefore no timezone can get between the bill and the checkpoint.
 */
function lockedAgainst(closedAt, cp) {
  if (!cp || !closedAt) return false;
  return String(closedAt).slice(0, 19) <= String(cp).slice(0, 19);
}

async function orderIsLocked(clientId, orderId, cp) {
  const point = cp === undefined ? await checkpoint(clientId) : cp;
  if (!point) return false;
  const row = await db.one('SELECT closed_at FROM orders WHERE id=? AND client_id=? LIMIT 1',
    [orderId, clientId]);
  return !!row && lockedAgainst(row.closed_at, point);
}

/**
 * How many bills in this range a bulk delete would be refused on.
 *
 * Counts only the bills such an operation would actually touch - closed and
 * still on the books. A range whose only frozen bills were already deleted is
 * not blocked, because deleting them again would have been a no-op and refusing
 * would just be a wrong answer with a number attached.
 */
async function lockedCountInRange(clientId, from, to, cp) {
  const point = cp === undefined ? await checkpoint(clientId) : cp;
  if (!point) return 0;
  return Number(await db.value(
    `SELECT COUNT(*) FROM orders o
      WHERE o.client_id=? AND o.status='closed' AND COALESCE(o.exclude_from_reports,0)=0
        AND o.closed_at IS NOT NULL AND o.closed_at<=?
        AND ${DAY} BETWEEN ? AND ?`, [clientId, point, from, to]));
}

const LOCK_MESSAGE = 'Bu adisyon kapatılmış bir güne ait, silinemez veya geri alınamaz. '
  + 'Önce ilgili günü yeniden açın.';

/* =====================================================================
   AUDIT
   ===================================================================== */
/*
 * The PHP wrote NOTHING for any of this: not audit_logs, not order_delete_logs,
 * not payment_delete_logs. A bill could leave the takings and the only trace
 * was the money missing from a report. Every mutation below writes a row.
 */
function json(v) { return v === null || v === undefined ? null : JSON.stringify(v); }

async function audit(t, clientId, actor, action, entityType, entityId, before, after, meta) {
  await t.exec(
    `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id,
        before_json, after_json, meta_json, ip, user_agent, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())`,
    [clientId, actor.userId || null, actor.role || null, action, entityType, String(entityId),
     json(before), json(after), json(meta || null), actor.ip || null,
     (actor.userAgent || '').slice(0, 255) || null]);
}

/* =====================================================================
   1. İŞLEMLER - closed bills
   ===================================================================== */

/*
 * The four status chips. `deleted` is the important one: the PHP's original
 * query hard-filtered status='closed' AND exclude_from_reports=0, which hid
 * every deleted bill and made "Geri al" unreachable - a bill could be removed
 * from the books and never brought back.
 */
function statusClause(status) {
  if (status === 'paid') return `AND o.status='closed' AND COALESCE(o.exclude_from_reports,0)=0`;
  if (status === 'cancelled') return `AND o.status='cancelled'`;
  /*
   * "Iptal edildi" is ONE state on screen, and it has to be one state here too.
   *
   * A bill leaves the books by two roads: the owner deletes it from the bill
   * screen (status becomes 'cancelled' and it is excluded), or the owner takes
   * it off the books from Islemler (it stays 'closed' and is excluded). Both
   * mean the same thing to a restaurant - that sale did not happen - so both
   * belong in the same list. Filtering on `excluded` alone hid the first kind
   * from the very screen that exists to show what was removed.
   */
  if (status === 'deleted') return `AND (o.status='cancelled' OR COALESCE(o.exclude_from_reports,0)=1)`;
  return '';
}

/**
 * The closed-bill list for a range.
 *
 * `paid` is the sum of the payments that still stand, and every row carries its
 * own `locked` flag so the screen can grey out what the checkpoint has frozen
 * instead of offering a button that will be refused.
 */
async function transactions(clientId, { from, to, status = 'all', q = '', limit = 1000 } = {}) {
  const r = await bounds(from, to);
  const st = ['all', 'paid', 'cancelled', 'deleted'].includes(status) ? status : 'all';
  const params = [clientId, r.from, r.to];
  let search = '';
  const term = String(q || '').trim();
  if (term) {
    // one box, four things a cashier might type: bill no, label, table, amount
    search = ` AND (o.adisyon_no=? OR o.bill_label LIKE ? OR rt.name LIKE ? OR o.grand_total=?)`;
    params.push(Number(term) || 0, '%' + term + '%', '%' + term + '%', Number(term.replace(',', '.')) || -1);
  }
  const rows = await db.query(
    `SELECT o.id, o.adisyon_no, o.bill_label, o.opened_at, o.closed_at, o.status,
            COALESCE(o.exclude_from_reports,0) AS excluded,
            o.total, o.discount_total, o.vat_total, o.grand_total,
            rt.name AS table_name,
            COALESCE(NULLIF(u.display_name,''), u.username, '') AS waiter_name,
            COALESCE((SELECT SUM(p.amount) FROM order_payments p
                       WHERE p.order_id=o.id AND p.client_id=o.client_id AND p.is_deleted=0
                         AND p.voided_at IS NULL),0) AS paid,
            (SELECT COUNT(DISTINCT p.method) FROM order_payments p
               WHERE p.order_id=o.id AND p.client_id=o.client_id AND p.is_deleted=0
                 AND p.voided_at IS NULL) AS method_count,
            (SELECT GROUP_CONCAT(DISTINCT p.method) FROM order_payments p
               WHERE p.order_id=o.id AND p.client_id=o.client_id AND p.is_deleted=0
                 AND p.voided_at IS NULL) AS methods
       FROM orders o
       LEFT JOIN restaurant_tables rt ON rt.id=o.table_id AND rt.client_id=o.client_id
       LEFT JOIN users u ON u.id=o.waiter_id AND u.client_id=o.client_id
      WHERE o.client_id=? AND o.status IN ('closed','cancelled')
        AND ${DAY} BETWEEN ? AND ?
        ${statusClause(st)}${search}
      ORDER BY o.closed_at DESC, o.id DESC
      LIMIT ${Math.min(Number(limit) || 1000, 5000)}`, params);

  const cp = await checkpoint(clientId);
  const out = rows.map(o => {
    const excluded = Number(o.excluded) === 1;
    const cancelled = o.status === 'cancelled';
    /*
     * A cancelled bill usually has no payments left, and showing 0,00 next to
     * it makes the list read as if nothing had ever been rung up. Fall back to
     * the bill's own total, exactly as the PHP screen did.
     */
    const paid = money(o.paid);
    return {
      id: o.id,
      adisyon_no: o.adisyon_no,
      bill_label: o.bill_label || '',
      table_name: o.table_name || '',
      waiter_name: o.waiter_name || '',
      opened_at: o.opened_at, closed_at: o.closed_at,
      status: o.status, excluded, cancelled,
      total: money(o.total), discount_total: money(o.discount_total),
      vat_total: money(o.vat_total), grand_total: money(o.grand_total),
      paid: cancelled && paid <= 0 ? money(o.grand_total) : paid,
      method_count: Number(o.method_count || 0),
      methods: o.methods ? String(o.methods).split(',') : [],
      locked: lockedAgainst(o.closed_at, cp),
    };
  });

  const sum = (k, f = () => true) => money(out.filter(f).reduce((s, x) => s + x[k], 0));
  /*
   * Money taken is money the restaurant KEPT. A cancelled or deleted bill's
   * payments were reversed with it, so counting them made the Islemler header
   * read "Tahsilat 11.700" next to "Silinen 11.700" for the same single bill -
   * the same money, once as income and once as a loss.
   */
  const stands = (x) => !x.excluded && !x.cancelled;
  return {
    // `status_filter`, not `status`: a field called `status` on a JSON envelope
    // collides with the HTTP status every client in this codebase merges in
    range: r, status_filter: st, q: term, checkpoint: cp,
    rows: out,
    totals: {
      count: out.length,
      grand_total: sum('grand_total'),
      paid: sum('paid', stands),
      discount_total: sum('discount_total', stands),
      // what is on the books, i.e. what the reports actually count
      counted: sum('grand_total', x => !x.excluded && !x.cancelled),
      deleted: sum('grand_total', x => x.excluded || x.cancelled),
      cancelled: sum('grand_total', x => x.cancelled),
      // how many of the listed rows are off the books, for the header line
      deleted_count: out.filter(x => x.excluded || x.cancelled).length,
      locked: out.filter(x => x.locked).length,
    },
  };
}

/**
 * One bill: header, lines, payments.
 *
 * The PHP's version was broken twice over. It selected `oi.price` and rebuilt
 * the line total as `qty * price` - a column no write path fills, so every line
 * read 0,00 - and it ignored `discount_amount`, so a discounted bill's lines
 * would not have added up to its own total even if the column had been right.
 * We read what the till actually writes: `unit_price`, `discount_amount` and
 * the stored `line_total`, and the lines therefore sum to the bill.
 */
async function orderDetail(clientId, orderId) {
  const o = await db.one(
    `SELECT o.id, o.adisyon_no, o.bill_label, o.status, o.opened_at, o.closed_at,
            o.business_date, o.total, o.discount_total, o.vat_total, o.grand_total, o.notes,
            COALESCE(o.exclude_from_reports,0) AS excluded,
            rt.name AS table_name,
            COALESCE(NULLIF(u.display_name,''), u.username, '') AS waiter_name
       FROM orders o
       LEFT JOIN restaurant_tables rt ON rt.id=o.table_id AND rt.client_id=o.client_id
       LEFT JOIN users u ON u.id=o.waiter_id AND u.client_id=o.client_id
      WHERE o.id=? AND o.client_id=? LIMIT 1`, [orderId, clientId]);
  if (!o) throw bad('Adisyon bulunamadı', 404);

  const items = await db.query(
    `SELECT oi.id, COALESCE(p.name,'-') AS product_name, oi.qty, oi.unit_price,
            oi.discount_amount, oi.line_total, oi.vat_rate, oi.vat_total, oi.note
       FROM order_items oi
       LEFT JOIN products p ON p.id=oi.product_id AND p.client_id=oi.client_id
      WHERE oi.order_id=? AND oi.client_id=? AND oi.is_deleted=0
      ORDER BY oi.id ASC`, [orderId, clientId]);

  /*
   * Deleted payments are LISTED, not filtered: the whole point of opening a
   * removed bill is to see what was taken off it and by which method.
   */
  const payments = await db.query(
    `SELECT id, method, amount, is_deleted, voided_at, created_at
       FROM order_payments WHERE order_id=? AND client_id=? ORDER BY id ASC`, [orderId, clientId]);

  const lines = items.map(i => ({
    id: i.id, product_name: i.product_name, qty: Number(i.qty),
    unit_price: money(i.unit_price), discount_amount: money(i.discount_amount),
    line_total: money(i.line_total), vat_rate: Number(i.vat_rate || 0),
    vat_total: money(i.vat_total), note: i.note || '',
  }));
  const subtotal = money(lines.reduce((s, l) => s + money(l.qty * l.unit_price), 0));
  const lineDiscount = money(lines.reduce((s, l) => s + l.discount_amount, 0));
  /*
   * A bill can carry BOTH kinds of discount at once, and this used to show
   * whichever it found first and drop the other. Line discounts are already
   * inside line_total; the bill-level one is not, so it comes off here - and
   * without it a fully paid bill with 10% off showed an outstanding balance.
   */
  const billDiscount = money(o.discount_total);
  const grand = money(money(lines.reduce((s, l) => s + l.line_total, 0)) - billDiscount);
  const paid = money(payments.filter(p => !Number(p.is_deleted) && !p.voided_at)
    .reduce((s, p) => s + Number(p.amount), 0));

  return {
    order: {
      ...o, excluded: Number(o.excluded) === 1,
      total: money(o.total), discount_total: money(o.discount_total),
      vat_total: money(o.vat_total), grand_total: money(o.grand_total),
      locked: await orderIsLocked(clientId, orderId),
    },
    items: lines,
    payments: payments.map(p => ({
      id: p.id, method: p.method, amount: money(p.amount),
      is_deleted: !!Number(p.is_deleted), voided: !!p.voided_at, created_at: p.created_at,
    })),
    totals: {
      subtotal,
      // everything that came off the bill, from either level - so
      // subtotal - discount === grand, which is the only way it can be read
      discount: money(lineDiscount + billDiscount),
      // the tax on what was actually charged, through the one KDV engine
      vat: require('../util/vat').billVat(lines.map(l => ({
        lineTotal: l.line_total, vatRate: l.vat_rate,
      })), billDiscount).vatTotal,
      grand, paid, balance: money(grand - paid),
    },
  };
}

/** Everything needed to put a bill back exactly as it was. */
async function preImage(clientId, orderId) {
  const order = await db.one('SELECT * FROM orders WHERE id=? AND client_id=? LIMIT 1', [orderId, clientId]);
  if (!order) return null;
  const payments = await db.query('SELECT * FROM order_payments WHERE order_id=? AND client_id=?',
    [orderId, clientId]);
  /*
   * The LINES belong in the snapshot too.
   *
   * This fed `order_delete_logs.original_data`, which is the only record of a
   * bill that was taken off the books - and it carried the header and the
   * payments and not one word about what was actually ordered. An owner
   * looking at a removed 11.700 TL bill six weeks later could see the total
   * and never what it was for, which is the one question they would be asking.
   */
  const items = await db.query(
    `SELECT i.*, p.name AS product_name FROM order_items i
       LEFT JOIN products p ON p.id=i.product_id AND p.client_id=i.client_id
      WHERE i.order_id=? AND i.client_id=?`, [orderId, clientId]);
  return { order, items, payments };
}

/**
 * Take one bill off the books.
 *
 * A "delete" here is exactly what the PHP meant by it and no more: the bill is
 * flagged out of reporting and its payments are flagged deleted. The rows stay,
 * because an owner who deletes yesterday's cash bill by mistake has to be able
 * to get it back, and because the tax record is not ours to destroy.
 */
async function deleteOne(t, clientId, orderId, actor, cp) {
  const pre = await preImage(clientId, orderId);
  if (!pre) return 'missing';
  if (lockedAgainst(pre.order.closed_at, cp)) return 'locked';
  if (Number(pre.order.exclude_from_reports) === 1) return 'already';

  await t.exec(
    `UPDATE order_payments SET is_deleted=1, deleted_at=NOW(), deleted_by=?
      WHERE order_id=? AND client_id=? AND is_deleted=0`, [actor.userId || null, orderId, clientId]);
  await t.exec('UPDATE orders SET exclude_from_reports=1, updated_at=NOW() WHERE id=? AND client_id=?',
    [orderId, clientId]);
  await t.exec(
    `INSERT INTO order_delete_logs (client_id, order_id, bill_label, adisyon_no, table_id, waiter_id,
        opened_at, closed_at, total, discount_total, grand_total, deleted_at, deleted_by, reason,
        ip_address, user_agent, original_data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),?,?,?,?,?)`,
    [clientId, orderId, pre.order.bill_label, pre.order.adisyon_no, pre.order.table_id,
     pre.order.waiter_id, pre.order.opened_at, pre.order.closed_at, pre.order.total,
     pre.order.discount_total, pre.order.grand_total, actor.userId || 0,
     (actor.reason || '').slice(0, 255), actor.ip || null, (actor.userAgent || '').slice(0, 255),
     JSON.stringify(pre)]);
  await audit(t, clientId, actor, 'order.delete', 'order', orderId,
    { exclude_from_reports: 0 }, { exclude_from_reports: 1 },
    { grand_total: Number(pre.order.grand_total), screen: 'finance/islemler' });
  return 'deleted';
}

/* =====================================================================
   KALICI SILME - the bill stops existing
   =====================================================================

   There are two different acts here and the owner was right that the product
   only offered one.

   `deleteOne` above CANCELS: the bill comes off the books and out of the
   takings, its record stays, and "Geri al" puts it back. That is what a
   mistake needs, and it is what the floor should ever be able to do.

   This one is the other act: the sale is struck out of the system. The rows
   go - lines, payments, discounts, kitchen projections, print jobs. What
   survives is `order_delete_logs`, which is the audit trail, not the bill: a
   snapshot of what was removed, by whom, when and why. Deleting THAT too would
   not be tidiness, it would be removing the evidence that anything was ever
   removed, and no set of books should be able to do that from a button.

   Two rules make it safe enough to exist:

     * the owner only - the same test that guards taking money off the books;
     * never inside a closed day. A bill that a signed Z report counted cannot
       be made never to have happened; reopen the day first, deliberately, and
       the reopening is itself on the record.

   The bill is cancelled first, in the same transaction, so stock, reçete
   materials, loyalty stamps and the kitchen all unwind through the paths that
   already know how to unwind them - then what is left is deleted. Doing it the
   other way round would leave a restaurant's stock counting a dinner nobody
   can find.
   ===================================================================== */

/* Child rows, deepest first. Anything referencing an order goes here or it is
   left behind as an orphan the reports will trip over later. */
const ORDER_CHILDREN = [
  'station_projection_items',
  'order_item_cancel_events',
  'order_discounts',
  'order_payments',
  'order_items',
  'print_jobs',
];

async function purgeOne(t, clientId, orderId, actor, cp) {
  const pre = await preImage(clientId, orderId);
  if (!pre) return 'missing';
  if (lockedAgainst(pre.order.closed_at, cp)) return 'locked';

  /*
   * Unwind before removing. `orders.deleteBill` is the till's own cancel: it
   * gives back the finished goods and the recipe's raw materials, resets
   * `stock_applied`, withdraws the payments and frees the table. Running it
   * here means the stock arithmetic has exactly one implementation.
   */
  if (Number(pre.order.exclude_from_reports) !== 1) {
    const orders = require('./orders');
    await orders.deleteBillIn(t, clientId, orderId, {
      userId: actor.userId, reason: actor.reason || 'Kalıcı silme öncesi iptal',
      ip: actor.ip, ua: actor.userAgent,
    });
  }

  /*
   * The audit snapshot is written BEFORE the rows go, and it carries the whole
   * bill - header, lines, payments - because after this statement there is
   * nowhere else to read them from.
   */
  await t.exec(
    `INSERT INTO order_delete_logs (client_id, order_id, bill_label, adisyon_no, table_id, waiter_id,
        opened_at, closed_at, total, discount_total, grand_total, deleted_at, deleted_by, reason,
        ip_address, user_agent, original_data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),?,?,?,?,?)`,
    [clientId, orderId, pre.order.bill_label, pre.order.adisyon_no, pre.order.table_id,
     pre.order.waiter_id, pre.order.opened_at, pre.order.closed_at, pre.order.total,
     pre.order.discount_total, pre.order.grand_total, actor.userId || 0,
     ('KALICI SILME: ' + (actor.reason || '')).slice(0, 255),
     actor.ip || null, (actor.userAgent || '').slice(0, 255),
     JSON.stringify({ ...pre, purged: true })]);
  await audit(t, clientId, actor, 'order.purge', 'order', orderId,
    { adisyon_no: pre.order.adisyon_no, grand_total: Number(pre.order.grand_total) }, null,
    { screen: 'finance/islemler', reason: actor.reason || null });

  for (const table of ORDER_CHILDREN) {
    await t.exec(`DELETE FROM \`${table}\` WHERE order_id=? AND client_id=?`, [orderId, clientId]);
  }
  await t.exec('DELETE FROM orders WHERE id=? AND client_id=?', [orderId, clientId]);
  return 'purged';
}

/**
 * Permanently remove one or more bills. Owner only, never inside a closed day.
 *
 * A locked bill is SKIPPED and counted rather than refusing the whole batch,
 * the same way the cancel does - one frozen bill in a selection of forty must
 * not block the other thirty-nine, and the caller says on screen how many were
 * left alone and why.
 */
async function purgeSelected(clientId, ids, actor) {
  const clean = [...new Set((Array.isArray(ids) ? ids : String(ids || '').split(','))
    .map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0))];
  if (!clean.length) throw bad('Kalıcı silinecek adisyon seçilmedi');
  if (clean.length > 200) throw bad('Tek seferde en fazla 200 adisyon kalıcı silinebilir');
  if (!String(actor.reason || '').trim()) throw bad('Kalıcı silme sebebi zorunlu');

  const cp = await checkpoint(clientId);
  const out = { purged: 0, locked: 0, missing: 0 };
  await db.tx(async t => {
    for (const id of clean) {
      const r = await purgeOne(t, clientId, id, actor, cp);
      out[r] = (out[r] || 0) + 1;
    }
  });
  return out;
}

/**
 * Delete a selection. At most 500 at a time - the PHP's limit, and a sensible
 * one: past that it is not a correction, it is a rewrite of the month.
 *
 * Locked bills are SKIPPED and counted, not refused, so that one frozen bill in
 * a selection of forty does not block the other thirty-nine. The caller is told
 * how many were skipped and says so on screen.
 */
async function deleteSelected(clientId, ids, actor) {
  const clean = [...new Set((Array.isArray(ids) ? ids : String(ids || '').split(','))
    .map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0))];
  if (!clean.length) throw bad('Silinecek adisyon seçilmedi');
  if (clean.length > 500) throw bad('Tek seferde en fazla 500 adisyon silinebilir');

  const cp = await checkpoint(clientId);
  const out = { deleted: 0, locked: 0, missing: 0, already: 0 };
  await db.tx(async t => {
    for (const id of clean) {
      const r = await deleteOne(t, clientId, id, actor, cp);
      out[r] = (out[r] || 0) + 1;
    }
  });
  return out;
}

/**
 * Every cash (or card) bill in a range, off the books in one go.
 *
 * If ANY bill in the range is frozen the whole operation is refused rather than
 * half-applied: a bulk delete that silently did 60% of what the button said is
 * how a set of books stops being reconcilable.
 */
async function deleteByMethod(clientId, method, from, to, actor) {
  if (!isDate(from) || !isDate(to)) throw bad('Tarih aralığı gerekli');
  const r = await bounds(from, to);
  const cp = await checkpoint(clientId);
  const frozen = await lockedCountInRange(clientId, r.from, r.to, cp);
  if (frozen > 0) {
    throw bad(`Bu aralıktaki ${frozen} adisyon kapatılmış güne ait. Toplu silme yapılamadı; `
      + 'önce ilgili günleri yeniden açın.', 409, 'DAY_CLOSED');
  }
  const rows = await db.query(
    `SELECT DISTINCT o.id
       FROM orders o
       JOIN order_payments p ON p.order_id=o.id AND p.client_id=o.client_id
      WHERE o.client_id=? AND o.status='closed' AND COALESCE(o.exclude_from_reports,0)=0
        AND p.method=? AND p.is_deleted=0 AND p.voided_at IS NULL
        AND ${DAY} BETWEEN ? AND ?`, [clientId, method, r.from, r.to]);
  if (!rows.length) return { deleted: 0, locked: 0, missing: 0, already: 0 };
  return deleteSelected(clientId, rows.map(x => x.id), { ...actor, reason: actor.reason || `toplu silme: ${method}` });
}

/**
 * Put a deleted bill back.
 *
 * DELIBERATE DEVIATION. The PHP's "Geri al" set `status='open'`,
 * `closed_at=NULL`, `is_closed=0` - it did not undo the delete, it reopened the
 * bill onto the floor, which took it out of every report just as surely as the
 * delete had. An owner clicking Geri al wants yesterday's money back in the
 * takings, not a table reopened. So we undo exactly what the delete changed and
 * nothing else: the bill stays closed, at its original closing time.
 */
async function restore(clientId, orderId, actor) {
  const cp = await checkpoint(clientId);
  const pre = await preImage(clientId, orderId);
  if (!pre) throw bad('Adisyon bulunamadı', 404);
  if (lockedAgainst(pre.order.closed_at, cp)) throw bad(LOCK_MESSAGE, 409, 'DAY_CLOSED');
  if (Number(pre.order.exclude_from_reports) !== 1) throw bad('Bu adisyon zaten raporlarda görünüyor');

  await db.tx(async t => {
    await t.exec('UPDATE orders SET exclude_from_reports=0, updated_at=NOW() WHERE id=? AND client_id=?',
      [orderId, clientId]);
    await t.exec(
      `UPDATE order_payments SET is_deleted=0, deleted_at=NULL, deleted_by=NULL
        WHERE order_id=? AND client_id=? AND is_deleted=1`, [orderId, clientId]);
    /*
     * The delete log records a deletion that no longer stands, and the Z report
     * and the cancellations report both read it - leaving it would report the
     * same money as lost twice. It is carried into the audit row first, so the
     * history survives where history belongs.
     */
    const logs = await t.query('SELECT * FROM order_delete_logs WHERE client_id=? AND order_id=?',
      [clientId, orderId]);
    await t.exec('DELETE FROM order_delete_logs WHERE client_id=? AND order_id=?', [clientId, orderId]);
    await audit(t, clientId, actor, 'order.restore', 'order', orderId,
      { exclude_from_reports: 1, delete_logs: logs.length }, { exclude_from_reports: 0 },
      { grand_total: Number(pre.order.grand_total), screen: 'finance/islemler' });
  });
  return { restored: true };
}

/* =====================================================================
   2. GÜN SONU - day list, day detail, close, reopen
   ===================================================================== */

/** The closing records for a range, newest close first. */
async function closingsFor(clientId, from, to) {
  const rows = await db.query(
    `SELECT c.*, COALESCE(NULLIF(u.display_name,''), u.username, '') AS closed_by_name,
            COALESCE(NULLIF(ru.display_name,''), ru.username, '') AS reopened_by_name
       FROM daily_closings c
       LEFT JOIN users u ON u.id=c.closed_by AND u.client_id=c.client_id
       LEFT JOIN users ru ON ru.id=c.reopened_by AND ru.client_id=c.client_id
      WHERE c.client_id=? AND c.date BETWEEN ? AND ?
      ORDER BY c.date ASC, c.close_seq ASC, c.id ASC`, [clientId, from, to]);
  const byDate = new Map();
  for (const r of rows) {
    const d = day10(r.date);
    const list = byDate.get(d) || [];
    list.push(r);
    byDate.set(d, list);
  }
  return byDate;
}

/**
 * The day list.
 *
 * Live figures come from `pnl.js`, and the CLOSING figures come from the row
 * written at close time. Both are shown, because they answer different
 * questions: "what does this day look like now" and "what did we sign off".
 * When they differ, someone changed a bill after the day was closed and the
 * owner deserves to see it rather than have history quietly rewritten - which
 * is exactly what the old system did, since it stored zeros and recomputed
 * everything live every time.
 */
async function dayList(clientId, from, to, onlyClosed = false) {
  const r = await bounds(from, to);
  const [pl, closings] = await Promise.all([
    pnl.profitAndLoss(clientId, r.from, r.to),
    closingsFor(clientId, r.from, r.to),
  ]);

  const days = new Map();
  for (const d of pl.rows) days.set(d.date, d);
  // a day with no trade but a closing on it still has to appear in the list
  for (const d of closings.keys()) {
    if (!days.has(d)) days.set(d, { ...blankDay(d) });
  }

  const rows = [...days.values()].map(d => {
    const cs = closings.get(d.date) || [];
    const active = [...cs].reverse().find(c => Number(c.is_reopened) !== 1) || null;
    const last = cs.length ? cs[cs.length - 1] : null;
    const totalCost = money(d.cogs + d.expenses);
    return {
      date: d.date, weekday: weekday(d.date),
      orders: d.orders,
      gross_sales: d.revenue_gross, discounts: d.discounts, vat: d.vat,
      net_sales: d.revenue_gross,          // ciro = what the guests paid, KDV dahil
      revenue_net: d.revenue_net,
      cogs: d.cogs, expenses: d.expenses, total_cost: totalCost,
      profit: d.net_profit, margin: d.net_margin,
      cash: d.cash, card: d.card, other: d.other,
      cancelled: d.cancelled_amount, cancelled_orders: d.cancelled_orders,
      average_ticket: d.average_ticket,
      is_closed: !!active,
      is_reopened: !active && !!last && Number(last.is_reopened) === 1,
      closed_at: active ? active.closed_at : (last ? last.closed_at : null),
      closed_by: active ? active.closed_by_name : (last ? last.closed_by_name : ''),
      reopened_at: last && last.reopened_at ? last.reopened_at : null,
      reopened_by: last ? last.reopened_by_name : '',
      close_seq: active ? Number(active.close_seq) : (last ? Number(last.close_seq) : 0),
      // what was signed off, verbatim from the closing row
      stored: active ? storedFigures(active) : null,
    };
  }).sort((a, b) => b.date.localeCompare(a.date));

  const list = onlyClosed ? rows.filter(x => x.is_closed) : rows;
  const sum = (k) => money(list.reduce((s, x) => s + Number(x[k] || 0), 0));
  const totals = {
    days: list.length,
    orders: list.reduce((s, x) => s + x.orders, 0),
    gross_sales: sum('gross_sales'), discounts: sum('discounts'), vat: sum('vat'),
    net_sales: sum('net_sales'), cogs: sum('cogs'), expenses: sum('expenses'),
    total_cost: sum('total_cost'), profit: sum('profit'),
    cash: sum('cash'), card: sum('card'), other: sum('other'), cancelled: sum('cancelled'),
  };
  totals.margin = pct(totals.profit, totals.net_sales);
  return { range: r, rows: list, totals, only_closed: !!onlyClosed };
}

function blankDay(date) {
  return {
    date, orders: 0, revenue_gross: 0, discounts: 0, vat: 0, revenue_net: 0,
    cogs: 0, expenses: 0, net_profit: 0, net_margin: 0,
    cash: 0, card: 0, other: 0, cancelled_amount: 0, cancelled_orders: 0, average_ticket: 0,
  };
}

function storedFigures(c) {
  return {
    sales: money(c.expected_sales), orders: Number(c.order_count),
    cost: money(c.expected_cost), net: money(c.expected_net),
    cash: money(c.expected_cash), card: money(c.expected_card),
    declared_cash: money(c.declared_cash), declared_card: money(c.declared_card),
    cash_difference: money(c.cash_difference), card_difference: money(c.card_difference),
    close_seq: Number(c.close_seq),
  };
}

/** One day, in full. */
async function dayDetail(clientId, date) {
  const d = isDate(date) ? date : await bd.currentBusinessDate();
  const list = await dayList(clientId, d, d);
  const summary = list.rows[0] || {
    ...blankDay(d), weekday: weekday(d), net_sales: 0, total_cost: 0, profit: 0, margin: 0,
    cancelled: 0, is_closed: false, is_reopened: false, closed_at: null, closed_by: '', stored: null,
  };

  const [orders, products, waiters, costs, cancels] = await Promise.all([
    /*
     * No status filter: cancelled and excluded bills are LISTED and labelled
     * rather than hidden, because "where did the 400 lira go" is answered by
     * seeing the bill marked Hariç, not by its absence.
     */
    db.query(
      `SELECT o.id, o.adisyon_no, o.bill_label, o.opened_at, o.closed_at, o.status,
              COALESCE(o.exclude_from_reports,0) AS excluded,
              o.total, o.discount_total, o.vat_total, o.grand_total,
              rt.name AS table_name,
              COALESCE(NULLIF(u.display_name,''), u.username, '-') AS waiter_name,
              COALESCE((SELECT SUM(p.amount) FROM order_payments p
                         WHERE p.order_id=o.id AND p.client_id=o.client_id
                           AND p.is_deleted=0 AND p.voided_at IS NULL),0) AS paid
         FROM orders o
         LEFT JOIN restaurant_tables rt ON rt.id=o.table_id AND rt.client_id=o.client_id
         LEFT JOIN users u ON u.id=o.waiter_id AND u.client_id=o.client_id
        WHERE o.client_id=? AND ${DAY}=? AND o.is_deleted=0 AND o.closed_at IS NOT NULL
        ORDER BY o.closed_at ASC`, [clientId, d]),
    pnl.productProfit(clientId, d, d, 500),
    reports.waiterPerformance(clientId, d, d),
    db.query('SELECT id, category, description, amount FROM daily_costs WHERE client_id=? AND date=? ORDER BY id',
      [clientId, d]),
    db.query(
      `SELECT e.order_id, e.qty, e.line_total, e.cancelled_at, COALESCE(p.name,'-') AS product_name
         FROM order_item_cancel_events e
         LEFT JOIN products p ON p.id=e.product_id AND p.client_id=e.client_id
        WHERE e.client_id=? AND DATE(e.cancelled_at)=? ORDER BY e.cancelled_at ASC`, [clientId, d]),
  ]);

  const pay = await paymentSplit(clientId, d, d);
  return {
    date: d, prev: shift(d, -1), next: shift(d, 1),
    summary,
    orders: orders.map(o => ({
      ...o, excluded: Number(o.excluded) === 1,
      total: money(o.total), discount_total: money(o.discount_total),
      vat_total: money(o.vat_total), grand_total: money(o.grand_total), paid: money(o.paid),
    })),
    products, waiters,
    costs: costs.map(c => ({ ...c, amount: money(c.amount) })),
    costs_total: money(costs.reduce((s, c) => s + Number(c.amount), 0)),
    cancels: cancels.map(c => ({ ...c, qty: Number(c.qty), line_total: money(c.line_total) })),
    payments: pay.rows,
  };
}

/**
 * Close a business day.
 *
 * THE FIX. The PHP's `close_day.php` inserted four columns and left
 * `expected_sales`, `order_count`, `expected_cost`, `expected_net`,
 * `expected_cash` and `expected_card` at their 0.00 defaults - every closing
 * row in the live database is zeros. That is not a signature, it is a
 * timestamp: change a bill afterwards and there is nothing to compare against,
 * so history rewrites itself silently. Here the day's figures are computed from
 * `pnl.js` and WRITTEN, and the day list shows stored next to live.
 *
 * `expected_card` holds every NON-CASH method, not only 'kredi_karti'. There is
 * no column for the rest, and dropping yemek kartı and havale would mean the
 * stored figures did not add up to the day's takings - which is the one thing a
 * closing record has to do.
 */
async function closeDay(clientId, { date, userId = null, declaredCash = 0, declaredCard = 0,
  role = null, ip = null, userAgent = null, reason = '' } = {}) {
  const d = isDate(date) ? date : await bd.currentBusinessDate();
  const today = await bd.currentBusinessDate();
  if (d > today) throw bad('Gelecek bir gün kapatılamaz', 400);

  const open = Number(await db.value(
    `SELECT COUNT(*) FROM orders WHERE client_id=? AND business_date=? AND status='open' AND is_deleted=0`,
    [clientId, d]));
  if (open) throw bad(`${open} adisyon hâlâ açık. Önce onları kapatın.`, 409);

  const existing = await db.one(
    `SELECT * FROM daily_closings WHERE client_id=? AND date=? AND COALESCE(is_reopened,0)=0
      ORDER BY id DESC LIMIT 1`, [clientId, d]);
  if (existing) throw bad('Bu gün zaten kapatılmış', 409, 'ALREADY_CLOSED');

  const pl = await pnl.profitAndLoss(clientId, d, d);
  const f = pl.rows[0] || blankDay(d);
  const sales = money(f.revenue_gross);
  const cost = money(f.cogs + f.expenses);
  const cash = money(f.cash);
  const nonCash = money(f.card + f.other);
  const dc = money(declaredCash), dk = money(declaredCard);

  /*
   * Two tills, one day.
   *
   * The check above runs before the P&L is computed, which takes long enough
   * for a second till to get through it too - so it catches the ordinary case
   * (somebody pressing the button twice) and nothing else. The real guard is
   * the pair below: the sequence is read inside the transaction, and
   * daily_closings has a UNIQUE key on (client_id, date, close_seq) so the
   * database, not the timing, decides who closed the day. The loser gets the
   * same 409 as the ordinary case rather than a raw duplicate-key error.
   */
  let closingId, seq = 0;
  try {
    closingId = await db.tx(async t => {
      seq = Number(await t.value(
      'SELECT COALESCE(MAX(close_seq),0)+1 FROM daily_closings WHERE client_id=? AND date=? FOR UPDATE',
      [clientId, d]));
    /*
     * FOR UPDATE, and not for the lock - for the READ.
     *
     * A plain SELECT here is served from the snapshot this transaction began
     * with, which predates a closing another till committed a moment ago. It
     * finds nothing, and the day is signed off a second time. A locking read
     * sees the committed row. The database refuses the duplicate either way
     * (uq_dc_active_day), so this is about answering "bu gün zaten kapatılmış"
     * instead of a duplicate-key error - but it is the check itself that was
     * wrong, and a check that cannot see is worse than no check, because it
     * reads like one.
     */
    const again = await t.one(
      `SELECT id FROM daily_closings WHERE client_id=? AND date=? AND COALESCE(is_reopened,0)=0
        ORDER BY id DESC LIMIT 1 FOR UPDATE`, [clientId, d]);
    if (again) throw bad('Bu gün zaten kapatılmış', 409, 'ALREADY_CLOSED');
    const id = await t.insert(
      `INSERT INTO daily_closings (client_id, date, close_seq, expected_cash, declared_cash, declared_card,
          cash_difference, card_difference, expected_card, expected_sales, order_count,
          expected_cost, expected_net, closed_by, closed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [clientId, d, seq, cash, dc, dk, money(dc - cash), money(dk - nonCash), nonCash,
       sales, f.orders, cost, money(f.net_profit), userId]);
    /*
     * The snapshot table has the unique key the closing table lacks, so this is
     * an upsert: re-closing a reopened day refreshes it instead of duplicating.
     */
    await t.exec(
      `INSERT INTO finance_daily_snapshots (client_id, date, gross_sales, discounts, net_sales,
          cost_of_goods, extra_costs, cash_sales, card_sales, order_count, canceled_order_count,
          profit, margin, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE gross_sales=VALUES(gross_sales), discounts=VALUES(discounts),
          net_sales=VALUES(net_sales), cost_of_goods=VALUES(cost_of_goods),
          extra_costs=VALUES(extra_costs), cash_sales=VALUES(cash_sales),
          card_sales=VALUES(card_sales), order_count=VALUES(order_count),
          canceled_order_count=VALUES(canceled_order_count), profit=VALUES(profit),
          margin=VALUES(margin)`,
      [clientId, d, sales, money(f.discounts), sales, money(f.cogs), money(f.expenses),
       cash, nonCash, f.orders, f.cancelled_orders, money(f.net_profit),
       money(Math.max(-999.99, Math.min(999.99, f.net_margin)))]);
    /*
     * The full day row goes into the audit entry, `other` payments included.
     * daily_closings has no column for every figure, and an owner asking "what
     * did we actually sign off on the 14th" should get the whole answer.
     */
    await audit(t, clientId, { userId, role, ip, userAgent }, 'day.close', 'day', d, null,
      { ...f, close_seq: seq, declared_cash: dc, declared_card: dk },
      { screen: 'finance/gun-sonu', reason: reason || null });
    return id;
    });
  } catch (e) {
    /* The unique key fired: another till committed its closing while this one
       was still adding up the day. Same answer as pressing the button twice. */
    if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) {
      throw bad('Bu gün zaten kapatılmış', 409, 'ALREADY_CLOSED');
    }
    throw e;
  }

  return {
    date: d, close_seq: seq, closing_id: closingId,
    expected_sales: sales, order_count: f.orders, expected_cost: cost,
    expected_net: money(f.net_profit), expected_cash: cash, expected_card: nonCash,
    declared_cash: dc, declared_card: dk,
    cash_difference: money(dc - cash), card_difference: money(dk - nonCash),
  };
}

/**
 * Reopen a day: the checkpoint moves back and the bills it froze become
 * editable again.
 *
 * DELIBERATE DEVIATION. The PHP deleted the closing row (and the snapshot), so
 * afterwards nothing recorded that the day had ever been signed off, by whom,
 * or with what figures - the audit row was the only survivor and it carried
 * only the snapshot. We flag `is_reopened=1` and keep everything, which is also
 * what `reports.reopenDay` does; `checkpoint()` skips reopened rows, so the
 * unlocking still happens.
 */
async function reopenDay(clientId, date, actor) {
  const d = isDate(date) ? date : null;
  if (!d) throw bad('Geçersiz tarih');
  const row = await db.one(
    `SELECT * FROM daily_closings WHERE client_id=? AND date=? AND COALESCE(is_reopened,0)=0
      ORDER BY id DESC LIMIT 1`, [clientId, d]);
  if (!row) throw bad('Bu gün kapatılmamış', 404, 'DAY_NOT_CLOSED');

  await db.tx(async t => {
    await t.exec('UPDATE daily_closings SET is_reopened=1, reopened_at=NOW(), reopened_by=? WHERE id=?',
      [actor.userId || null, row.id]);
    // the snapshot was built from the closing; it goes with it
    await t.exec('DELETE FROM finance_daily_snapshots WHERE client_id=? AND date=?', [clientId, d]);
    await audit(t, clientId, actor, 'day.reopen', 'day', d, storedFigures(row), null,
      { closing_id: row.id, close_seq: Number(row.close_seq), screen: 'finance/gun-sonu',
        reason: actor.reason || null });
  });
  return { date: d, closing_id: row.id, checkpoint: await checkpoint(clientId) };
}

/* =====================================================================
   3. FİNANS RAPORU
   ===================================================================== */

/**
 * Payment-method split.
 *
 * DELIBERATE DEVIATION. The PHP's `rq_payments` read `order_payments` with no
 * join to `orders` at all and grouped on `p.created_at`, so voided payments,
 * deleted payments and payments on excluded bills were all in the total - the
 * split never agreed with the sales figure printed above it. This is scoped to
 * the same bills, on the same business-day basis, as everything else on the
 * screen, so the split sums to the takings.
 */
async function paymentSplit(clientId, from, to) {
  const r = await bounds(from, to);
  const rows = await db.query(
    `SELECT p.method, COUNT(*) AS n, COALESCE(SUM(p.amount),0) AS total
       FROM order_payments p
       JOIN orders o ON o.id=p.order_id AND o.client_id=p.client_id
      WHERE p.client_id=? AND p.is_deleted=0 AND p.voided_at IS NULL
        AND ${COUNTED} AND ${DAY} BETWEEN ? AND ?
      GROUP BY p.method ORDER BY total DESC`, [clientId, r.from, r.to]);
  const total = money(rows.reduce((s, x) => s + Number(x.total), 0));
  return {
    range: r, total,
    rows: rows.map(x => ({
      method: x.method, count: Number(x.n), total: money(x.total),
      share: pct(Number(x.total), total),
    })),
  };
}

/**
 * Purchases against sales - the one number that says whether the kitchen is
 * buying faster than the dining room is selling.
 */
async function purchases(clientId, from, to) {
  const r = await bounds(from, to);
  const head = await db.one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(d.total_amount),0) AS total
       FROM inventory_documents d
      WHERE d.client_id=? AND d.status='approved' AND d.type='purchase'
        AND d.document_date BETWEEN ? AND ?`, [clientId, r.from, r.to]);
  const vat = await db.value(
    `SELECT COALESCE(SUM(i.vat_amount),0)
       FROM inventory_document_items i
       JOIN inventory_documents d ON d.id=i.document_id
      WHERE d.client_id=? AND d.status='approved' AND d.type='purchase'
        AND i.is_approved=1 AND d.document_date BETWEEN ? AND ?`, [clientId, r.from, r.to]);
  const total = money(head.total);
  const v = money(vat);
  return {
    count: Number(head.n), total, vat: v, net: money(Math.max(0, total - v)),
    vat_share: pct(v, total), net_share: pct(Math.max(0, total - v), total),
  };
}

/**
 * Discounts. The PHP had no discount report at all - the figure appeared as a
 * single number on the P&L and nobody could ask which bills it came off.
 */
async function discountReport(clientId, from, to, limit = 500) {
  const r = await bounds(from, to);
  const rows = await db.query(
    `SELECT o.id, o.adisyon_no, o.bill_label, o.closed_at, ${DAY} AS day,
            o.total, o.discount_total, o.grand_total,
            rt.name AS table_name,
            COALESCE(NULLIF(u.display_name,''), u.username, '-') AS waiter_name
       FROM orders o
       LEFT JOIN restaurant_tables rt ON rt.id=o.table_id AND rt.client_id=o.client_id
       LEFT JOIN users u ON u.id=o.waiter_id AND u.client_id=o.client_id
      WHERE o.client_id=? AND ${COUNTED} AND ${DAY} BETWEEN ? AND ?
        AND COALESCE(o.discount_total,0) > 0
      ORDER BY o.discount_total DESC
      LIMIT ${Math.min(Number(limit) || 500, 5000)}`, [clientId, r.from, r.to]);

  const byWaiter = new Map();
  for (const o of rows) {
    const k = o.waiter_name || '-';
    const w = byWaiter.get(k) || { waiter_name: k, count: 0, discount: 0 };
    w.count += 1; w.discount = money(w.discount + Number(o.discount_total));
    byWaiter.set(k, w);
  }
  const total = money(rows.reduce((s, o) => s + Number(o.discount_total), 0));
  return {
    range: r, count: rows.length, total,
    rows: rows.map(o => ({
      id: o.id, adisyon_no: o.adisyon_no, bill_label: o.bill_label || '',
      date: day10(o.day), closed_at: o.closed_at,
      table_name: o.table_name || '', waiter_name: o.waiter_name,
      total: money(o.total), discount_total: money(o.discount_total),
      grand_total: money(o.grand_total),
      share: pct(Number(o.discount_total), Number(o.total) || Number(o.discount_total)),
    })),
    by_waiter: [...byWaiter.values()].sort((a, b) => b.discount - a.discount),
  };
}

/**
 * Cancellations, in the three shapes they come in: whole bills cancelled,
 * single lines voided mid-service, and bills taken off the books afterwards.
 * `reports.cancelReport` already reads the last two; the cancelled-bill list is
 * the one it does not have.
 */
async function cancellationReport(clientId, from, to) {
  const r = await bounds(from, to);
  const orders = await db.query(
    `SELECT o.id, o.adisyon_no, o.bill_label, o.closed_at, ${DAY} AS day, o.status,
            COALESCE(o.exclude_from_reports,0) AS excluded, o.grand_total,
            rt.name AS table_name,
            COALESCE(NULLIF(u.display_name,''), u.username, '-') AS waiter_name
       FROM orders o
       LEFT JOIN restaurant_tables rt ON rt.id=o.table_id AND rt.client_id=o.client_id
       LEFT JOIN users u ON u.id=o.waiter_id AND u.client_id=o.client_id
      WHERE o.client_id=? AND ${DAY} BETWEEN ? AND ?
        AND (o.status='cancelled' OR COALESCE(o.exclude_from_reports,0)=1)
      ORDER BY o.closed_at DESC`, [clientId, r.from, r.to]);
  const legacy = await reports.cancelReport(clientId, r.from, r.to);
  return {
    range: r,
    orders: orders.map(o => ({
      id: o.id, adisyon_no: o.adisyon_no, bill_label: o.bill_label || '',
      date: day10(o.day), closed_at: o.closed_at, status: o.status,
      excluded: Number(o.excluded) === 1,
      table_name: o.table_name || '', waiter_name: o.waiter_name,
      grand_total: money(o.grand_total),
    })),
    orders_total: money(orders.reduce((s, o) => s + Number(o.grand_total), 0)),
    items: legacy.items.map(i => ({
      order_id: i.order_id, product_name: i.product_name, qty: Number(i.qty),
      line_total: money(i.line_total), cancelled_at: i.cancelled_at,
    })),
    items_total: money(legacy.items.reduce((s, i) => s + Number(i.line_total || 0), 0)),
    deleted: legacy.bills.map(b => ({
      order_id: b.order_id, bill_label: b.bill_label || '', adisyon_no: b.adisyon_no,
      grand_total: money(b.grand_total), deleted_at: b.deleted_at,
      deleted_by: b.deleted_by_name || '', reason: b.reason || '',
    })),
    deleted_total: money(legacy.bills.reduce((s, b) => s + Number(b.grand_total || 0), 0)),
  };
}

/**
 * The finance report screen, in one call.
 *
 * One round trip on purpose: the KPI band, the tables and the payment split all
 * have to describe the same range at the same instant. Five separate fetches
 * are five chances to show an owner two panels computed either side of a sale.
 */
async function financeReport(clientId, from, to) {
  const r = await bounds(from, to);
  const today = await bd.currentBusinessDate();
  const d7 = shift(today, -6);
  const d30 = shift(today, -29);

  const [pl, prod, cat, pay, buy, disc, cancels, todayPl, pl30, pay7] = await Promise.all([
    pnl.profitAndLoss(clientId, r.from, r.to),
    pnl.productProfit(clientId, r.from, r.to, 500),
    pnl.categoryProfit(clientId, r.from, r.to),
    paymentSplit(clientId, r.from, r.to),
    purchases(clientId, r.from, r.to),
    discountReport(clientId, r.from, r.to),
    cancellationReport(clientId, r.from, r.to),
    pnl.profitAndLoss(clientId, today, today),
    pnl.profitAndLoss(clientId, d30, today),
    paymentSplit(clientId, d7, today),
  ]);

  const T = pl.totals;
  const cash7 = pay7.rows.filter(x => x.method === 'nakit').reduce((s, x) => s + x.total, 0);
  const card7 = pay7.rows.filter(x => x.method !== 'nakit').reduce((s, x) => s + x.total, 0);

  return {
    range: r,
    /* the four live cards across the top */
    kpi: {
      today_sales: todayPl.totals.revenue_gross,
      today_orders: todayPl.totals.orders,
      last30_sales: pl30.totals.revenue_gross,
      last7_cash: money(cash7),
      last7_card: money(card7),
    },
    totals: T,
    /*
     * The period bars. Each share is honest even above 100% - the İptal bar can
     * legitimately exceed the takings on a bad day, and clamping it to 100 was
     * how the old screen hid exactly the day worth looking at.
     */
    summary: {
      profit: T.net_profit, profit_share: pct(T.net_profit, T.revenue_gross),
      cost: money(T.cogs + T.expenses), cost_share: pct(T.cogs + T.expenses, T.revenue_gross),
      vat: T.vat, vat_share: pct(T.vat, T.revenue_gross),
      cancelled: T.cancelled_amount, cancelled_share: pct(T.cancelled_amount, T.revenue_gross),
      discounts: T.discounts, discount_share: pct(T.discounts, T.revenue_gross),
    },
    purchases: { ...buy, vs_sales: pct(buy.total, T.revenue_gross) },
    products: prod, categories: cat,
    payments: pay.rows, payments_total: pay.total,
    discounts: disc,
    cancellations: cancels,
    daily: pl.rows,
  };
}

/* =====================================================================
   4. X RAPORU + gün sonu özeti e-postası
   ===================================================================== */

/**
 * X raporu: the same figures as the Z, taken mid-shift, with nothing closed.
 *
 * The one thing a Z cannot tell you and an X must: what is still sitting open
 * on the tables. That is the difference between "we have taken 14.000 today"
 * and "we have taken 14.000 and there is another 3.200 on the floor".
 */
async function xReport(clientId, date) {
  const d = isDate(date) ? date : await bd.currentBusinessDate();
  const z = await reports.zReport(clientId, d);
  const open = await db.query(
    `SELECT o.id, o.adisyon_no, o.bill_label, o.opened_at, o.grand_total,
            rt.name AS table_name,
            COALESCE(NULLIF(u.display_name,''), u.username, '') AS waiter_name
       FROM orders o
       LEFT JOIN restaurant_tables rt ON rt.id=o.table_id AND rt.client_id=o.client_id
       LEFT JOIN users u ON u.id=o.waiter_id AND u.client_id=o.client_id
      WHERE o.client_id=? AND o.business_date=? AND o.status='open' AND o.is_deleted=0
      ORDER BY o.opened_at ASC`, [clientId, d]);
  const closed = await db.one(
    `SELECT COUNT(*) c FROM daily_closings WHERE client_id=? AND date=? AND COALESCE(is_reopened,0)=0`,
    [clientId, d]);
  return {
    ...z,
    kind: 'X',
    taken_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    day_closed: Number(closed.c) > 0,
    open_bills: open.map(o => ({
      id: o.id, adisyon_no: o.adisyon_no, bill_label: o.bill_label || '',
      table_name: o.table_name || '', waiter_name: o.waiter_name || '',
      opened_at: o.opened_at, grand_total: money(o.grand_total),
    })),
    open_total: money(open.reduce((s, o) => s + Number(o.grand_total), 0)),
  };
}

// rounded by the one money() rather than by a private copy of the same line,
// so the e-mailed figure cannot round differently from the stored one
const trMoney = (n) => money(n)
  .toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';

/** The day's figures as an e-mail an owner can read on a phone. */
async function daySummaryHtml(clientId, date) {
  const detail = await dayDetail(clientId, date);
  const s = detail.summary;
  const biz = await db.one('SELECT business_name FROM business_settings WHERE client_id=? LIMIT 1', [clientId])
    .catch(() => null);
  const name = (biz && biz.business_name) || 'İşletme';
  const row = (k, v, strong) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${k}</td>`
    + `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;`
    + `font-weight:${strong ? 700 : 400}">${v}</td></tr>`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#18181B">
    <h2 style="margin:0 0 4px">${name}</h2>
    <p style="margin:0 0 14px;color:#8E8E96">Gün sonu özeti — ${detail.date} ${s.weekday || ''}</p>
    <table style="border-collapse:collapse;width:100%;max-width:420px;font-size:14px">
      ${row('Adisyon', String(s.orders))}
      ${row('Ciro', trMoney(s.net_sales), true)}
      ${row('İndirim', trMoney(s.discounts))}
      ${row('KDV', trMoney(s.vat))}
      ${row('Ürün maliyeti', trMoney(s.cogs))}
      ${row('Giderler', trMoney(s.expenses))}
      ${row('Net kâr', trMoney(s.profit), true)}
      ${row('Nakit', trMoney(s.cash))}
      ${row('Kart / diğer', trMoney(money(s.card + s.other)))}
      ${row('İptal / hariç', trMoney(s.cancelled))}
    </table>
    ${detail.costs.length ? `<p style="margin:16px 0 6px;font-weight:600">Gün giderleri</p>
      <table style="border-collapse:collapse;width:100%;max-width:420px;font-size:13px">
        ${detail.costs.map(c => row(`${c.category} — ${c.description || ''}`, trMoney(c.amount))).join('')}
      </table>` : ''}
    <p style="margin-top:18px;color:#8E8E96;font-size:12px">NOKTApp POS</p>
  </div>`;
  return { html, subject: `${name} — Gün sonu ${detail.date}`, detail };
}

/** Queue the summary. Sending is `mail.js`'s job, and it retries on its own. */
async function mailDaySummary(clientId, date, toEmail) {
  const to = String(toEmail || '').trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw bad('Geçerli bir e-posta adresi girin');
  const { html, subject } = await daySummaryHtml(clientId, date);
  const id = await db.insert(
    `INSERT INTO np_mail_queue (client_id, order_id, to_email, subject, body_html, status, created_at)
     VALUES (?,NULL,?,?,?,'pending',NOW())`, [clientId, to, subject, html]);
  require('../mail').drain().catch(() => {});
  return { id, to, subject };
}

/* =====================================================================
   5. EXPORTS
   ===================================================================== */
/*
 * The rendering lives in report/sheet.js, because the Raporlar screen's
 * exports have to come out of the same builder as these. They did not: this
 * file wrote a BOM, semicolons and comma decimals while routes/reports.js
 * quoted every cell and shipped raw "1234.56" and "2026-09-01" - so half the
 * app's CSVs opened correctly in a Turkish Excel and half did not.
 */
const sheetfmt = require('../report/sheet');
const { MONEY, INT, PCT, TXT, DATE, DT } = sheetfmt;

const COLS = {
  transactions: [
    { k: 'closed_at', tr: 'Kapanış', t: DT }, { k: 'adisyon_no', tr: 'Adisyon No', t: INT, nosum: true },
    { k: 'bill_label', tr: 'Etiket', t: TXT }, { k: 'table_name', tr: 'Masa', t: TXT },
    { k: 'waiter_name', tr: 'Personel', t: TXT }, { k: 'durum', tr: 'Durum', t: TXT },
    { k: 'odeme', tr: 'Ödeme', t: TXT }, { k: 'total', tr: 'Ara Toplam', t: MONEY },
    { k: 'discount_total', tr: 'İndirim', t: MONEY }, { k: 'vat_total', tr: 'KDV', t: MONEY },
    { k: 'grand_total', tr: 'Tutar', t: MONEY }, { k: 'paid', tr: 'Tahsilat', t: MONEY },
  ],
  days: [
    { k: 'date', tr: 'Tarih', t: DATE }, { k: 'weekday', tr: 'Gün', t: TXT },
    { k: 'durum', tr: 'Durum', t: TXT }, { k: 'closed_by', tr: 'Kapatan', t: TXT },
    { k: 'orders', tr: 'Adisyon', t: INT }, { k: 'net_sales', tr: 'Ciro', t: MONEY },
    { k: 'discounts', tr: 'İndirim', t: MONEY }, { k: 'vat', tr: 'KDV', t: MONEY },
    { k: 'cogs', tr: 'Ürün Maliyeti', t: MONEY }, { k: 'expenses', tr: 'Gider', t: MONEY },
    { k: 'profit', tr: 'Kâr', t: MONEY }, { k: 'margin', tr: 'Marj %', t: PCT },
    { k: 'cash', tr: 'Nakit', t: MONEY }, { k: 'card', tr: 'Kart', t: MONEY },
    { k: 'other', tr: 'Diğer', t: MONEY }, { k: 'cancelled', tr: 'İptal', t: MONEY },
  ],
  products: [
    { k: 'name', tr: 'Ürün', t: TXT }, { k: 'category', tr: 'Kategori', t: TXT },
    { k: 'qty', tr: 'Adet', t: INT }, { k: 'revenue_gross', tr: 'Ciro (KDV dahil)', t: MONEY },
    { k: 'vat', tr: 'KDV', t: MONEY }, { k: 'revenue_net', tr: 'Ciro (KDV hariç)', t: MONEY },
    { k: 'cogs', tr: 'Maliyet', t: MONEY }, { k: 'profit', tr: 'Kâr', t: MONEY },
    { k: 'margin', tr: 'Marj %', t: PCT },
  ],
  categories: [
    { k: 'category', tr: 'Kategori', t: TXT }, { k: 'qty', tr: 'Adet', t: INT },
    { k: 'revenue_net', tr: 'Ciro (KDV hariç)', t: MONEY }, { k: 'cogs', tr: 'Maliyet', t: MONEY },
    { k: 'profit', tr: 'Kâr', t: MONEY }, { k: 'margin', tr: 'Marj %', t: PCT },
  ],
  payments: [
    { k: 'method_label', tr: 'Yöntem', t: TXT }, { k: 'count', tr: 'İşlem', t: INT },
    { k: 'total', tr: 'Tutar', t: MONEY }, { k: 'share', tr: 'Pay %', t: PCT },
  ],
  discounts: [
    { k: 'date', tr: 'Tarih', t: DATE }, { k: 'adisyon_no', tr: 'Adisyon No', t: INT, nosum: true },
    { k: 'table_name', tr: 'Masa', t: TXT }, { k: 'waiter_name', tr: 'Personel', t: TXT },
    { k: 'total', tr: 'Ara Toplam', t: MONEY }, { k: 'discount_total', tr: 'İndirim', t: MONEY },
    { k: 'grand_total', tr: 'Tutar', t: MONEY }, { k: 'share', tr: 'Oran %', t: PCT },
  ],
  cancellations: [
    { k: 'tip', tr: 'Tür', t: TXT }, { k: 'tarih', tr: 'Tarih', t: DATE },
    { k: 'aciklama', tr: 'Açıklama', t: TXT }, { k: 'adet', tr: 'Adet', t: INT },
    { k: 'tutar', tr: 'Tutar', t: MONEY },
  ],
  daily: [
    { k: 'date', tr: 'Tarih', t: DATE }, { k: 'orders', tr: 'Adisyon', t: INT },
    { k: 'revenue_gross', tr: 'Ciro (KDV dahil)', t: MONEY }, { k: 'vat', tr: 'KDV', t: MONEY },
    { k: 'revenue_net', tr: 'Ciro (KDV hariç)', t: MONEY }, { k: 'cogs', tr: 'Maliyet', t: MONEY },
    { k: 'expenses', tr: 'Gider', t: MONEY }, { k: 'net_profit', tr: 'Net Kâr', t: MONEY },
    { k: 'net_margin', tr: 'Marj %', t: PCT }, { k: 'cash', tr: 'Nakit', t: MONEY },
    { k: 'card', tr: 'Kart', t: MONEY }, { k: 'other', tr: 'Diğer', t: MONEY },
  ],
  dayorders: [
    { k: 'closed_at', tr: 'Kapanış', t: DT }, { k: 'adisyon_no', tr: 'Adisyon No', t: INT, nosum: true },
    { k: 'table_name', tr: 'Masa', t: TXT }, { k: 'waiter_name', tr: 'Personel', t: TXT },
    { k: 'durum', tr: 'Durum', t: TXT }, { k: 'grand_total', tr: 'Tutar', t: MONEY },
    { k: 'discount_total', tr: 'İndirim', t: MONEY }, { k: 'paid', tr: 'Ödenen', t: MONEY },
  ],
  summary: [
    { k: 'kalem', tr: 'Kalem', t: TXT }, { k: 'tutar', tr: 'Tutar', t: MONEY },
  ],
};

const METHOD_TR = {
  nakit: 'Nakit', kredi_karti: 'Kredi kartı', yemek_karti: 'Yemek kartı',
  havale: 'Havale / EFT', ikram: 'İkram', acik_hesap: 'Açık hesap',
};
const methodLabel = (m) => METHOD_TR[m] || m || '-';

function txStatusLabel(o) {
  const bits = [];
  if (o.cancelled) bits.push('İptal');
  if (o.excluded) bits.push('Silindi');
  if (!bits.length) bits.push('Geçerli');
  return bits.join(' + ');
}
function payLabel(o) {
  if (o.method_count > 1) return 'KARIŞIK';
  if (o.method_count === 1) return methodLabel(o.methods[0]).toUpperCase();
  return '—';
}

/**
 * Every table on every finance screen, exportable, and built from the SAME
 * function the screen used - so a CSV can never show different rows from the
 * page it was downloaded off.
 */
async function exportSheets(clientId, kind, q = {}) {
  const r = await bounds(q.from, q.to);
  const stamp = `${r.from}_${r.to}`;
  if (kind === 'transactions') {
    const t = await transactions(clientId, { ...q, from: r.from, to: r.to });
    return {
      name: `islemler-${stamp}`,
      sheets: [{
        name: 'İşlemler', cols: COLS.transactions,
        rows: t.rows.map(o => ({ ...o, durum: txStatusLabel(o), odeme: payLabel(o) })),
      }],
    };
  }
  if (kind === 'days') {
    const d = await dayList(clientId, r.from, r.to, q.only_closed);
    return {
      name: `gun-sonu-${stamp}`,
      sheets: [{
        name: 'Gün sonu', cols: COLS.days,
        rows: d.rows.map(x => ({
          ...x, durum: x.is_closed ? 'Kapatıldı' : (x.is_reopened ? 'Yeniden açıldı' : 'Açık'),
        })),
      }],
    };
  }
  if (kind === 'day') {
    const d = await dayDetail(clientId, q.date);
    return {
      name: `gun-${d.date}`,
      sheets: [
        { name: 'Adisyonlar', cols: COLS.dayorders,
          rows: d.orders.map(o => ({
            ...o, durum: (o.excluded || o.status === 'cancelled') ? 'Hariç / İptal' : 'Geçerli',
          })) },
        { name: 'Ürünler', cols: COLS.products, rows: d.products },
        { name: 'Giderler', cols: COLS.summary,
          rows: d.costs.map(c => ({ kalem: `${c.category} — ${c.description || ''}`, tutar: c.amount })) },
      ],
    };
  }
  if (kind === 'products') {
    return { name: `urunler-${stamp}`,
      sheets: [{ name: 'Ürünler', cols: COLS.products, rows: await pnl.productProfit(clientId, r.from, r.to, 100000) }] };
  }
  if (kind === 'categories') {
    return { name: `kategoriler-${stamp}`,
      sheets: [{ name: 'Kategoriler', cols: COLS.categories, rows: await pnl.categoryProfit(clientId, r.from, r.to) }] };
  }
  if (kind === 'payments') {
    const p = await paymentSplit(clientId, r.from, r.to);
    return { name: `odemeler-${stamp}`,
      sheets: [{ name: 'Ödemeler', cols: COLS.payments,
        rows: p.rows.map(x => ({ ...x, method_label: methodLabel(x.method) })) }] };
  }
  if (kind === 'discounts') {
    const d = await discountReport(clientId, r.from, r.to, 100000);
    return { name: `indirimler-${stamp}`, sheets: [{ name: 'İndirimler', cols: COLS.discounts, rows: d.rows }] };
  }
  if (kind === 'cancellations') {
    const c = await cancellationReport(clientId, r.from, r.to);
    const rows = [
      ...c.orders.map(o => ({ tip: o.status === 'cancelled' ? 'İptal adisyon' : 'Rapor dışı adisyon',
        tarih: o.date, aciklama: `#${o.adisyon_no || o.id} ${o.table_name}`, adet: 1, tutar: o.grand_total })),
      ...c.items.map(i => ({ tip: 'İptal ürün', tarih: day10(i.cancelled_at),
        aciklama: i.product_name, adet: i.qty, tutar: i.line_total })),
      ...c.deleted.map(b => ({ tip: 'Silinen adisyon', tarih: day10(b.deleted_at),
        aciklama: `#${b.adisyon_no || b.order_id} ${b.reason || ''}`, adet: 1, tutar: b.grand_total })),
    ];
    return { name: `iptaller-${stamp}`, sheets: [{ name: 'İptaller', cols: COLS.cancellations, rows }] };
  }
  if (kind === 'daily') {
    const pl = await pnl.profitAndLoss(clientId, r.from, r.to);
    return { name: `gunluk-${stamp}`, sheets: [{ name: 'Günlük', cols: COLS.daily, rows: pl.rows }] };
  }
  if (kind === 'report') {
    // the whole screen, one workbook, one tab per panel
    const rep = await financeReport(clientId, r.from, r.to);
    const T = rep.totals;
    return {
      name: `finans-raporu-${stamp}`,
      sheets: [
        // unlike figures in one column: a footer summing them means nothing
        { name: 'Özet', cols: COLS.summary, noTotal: true, rows: [
          { kalem: 'Ciro (KDV dahil)', tutar: T.revenue_gross },
          { kalem: 'İndirim', tutar: T.discounts },
          { kalem: 'KDV', tutar: T.vat },
          { kalem: 'Ciro (KDV hariç)', tutar: T.revenue_net },
          { kalem: 'Ürün maliyeti', tutar: T.cogs },
          { kalem: 'Giderler', tutar: T.expenses },
          { kalem: 'Net kâr', tutar: T.net_profit },
          { kalem: 'Adisyon', tutar: T.orders },
          { kalem: 'Ortalama adisyon', tutar: T.average_ticket },
          { kalem: 'Alımlar', tutar: rep.purchases.total },
          { kalem: 'İptal / hariç', tutar: T.cancelled_amount },
        ] },
        { name: 'Günlük', cols: COLS.daily, rows: rep.daily },
        { name: 'Ürünler', cols: COLS.products, rows: rep.products },
        { name: 'Kategoriler', cols: COLS.categories, rows: rep.categories },
        { name: 'Ödemeler', cols: COLS.payments,
          rows: rep.payments.map(x => ({ ...x, method_label: methodLabel(x.method) })) },
        { name: 'İndirimler', cols: COLS.discounts, rows: rep.discounts.rows },
      ],
    };
  }
  throw bad('Bilinmeyen rapor', 404);
}

/* --------------------------------------------------------- the pack --- */
const TITLE = {
  transactions: 'İşlem (adisyon) raporu', days: 'Gün sonu raporu', day: 'Gün raporu',
  products: 'Ürün kârlılık raporu', categories: 'Kategori kârlılık raporu',
  payments: 'Ödeme dağılımı raporu', discounts: 'İndirim raporu',
  cancellations: 'İptal ve silme raporu', daily: 'Günlük ciro raporu',
  report: 'Finans raporu',
};

/**
 * The same export, plus everything an accountant's file copy has to carry.
 *
 * The CSV needs `sheets` and nothing else. The PDF needs those exact sheets -
 * so the two files sent on the same day cannot show different rows - and on
 * top of them the legal furniture: which days, the KDV per rate, the payment
 * split, the headline figures and what is left out. Building the furniture
 * here rather than in the PDF renderer is what lets a second renderer (mail,
 * print) be added later without any of it being written twice.
 */
async function exportPack(clientId, kind, q = {}) {
  const pack = await exportSheets(clientId, kind, q);
  const r = kind === 'day' && isDate(q.date)
    ? { from: q.date, to: q.date }
    : await bounds(q.from, q.to);

  const [vat, pay, pl] = await Promise.all([
    reports.vatRange(clientId, r.from, r.to),
    paymentSplit(clientId, r.from, r.to),
    pnl.profitAndLoss(clientId, r.from, r.to),
  ]);
  const T = pl.totals;

  const notes = [];
  if (kind === 'cancellations') {
    notes.push('Bu rapor, diğer raporların DIŞINDA tutulan adisyon ve satırların dökümüdür; '
      + 'buradaki tutarlar ciroya, KDV dökümüne ve tahsilata dahil değildir.');
  }
  if (kind === 'transactions' || kind === 'day') {
    /*
     * This one lists bills one per line, and that includes the cancelled
     * ones - marked "İptal" / "Silindi" - because an owner looking for a
     * missing bill has to be able to find it. So the table's TOPLAM is the
     * sum of the LINES, not the period's turnover, and saying so is the
     * difference between a document an accountant trusts and one they query.
     */
    notes.push('Bu listede iptal edilen ve silinen adisyonlar da satır olarak yer alır ve '
      + '"Durum" sütununda öyle işaretlenir; tahsilatları 0,00\'dır. Tablonun TOPLAM satırı '
      + 'satırların toplamıdır. Dönemin cirosu, KDV dökümü ve ödeme dağılımı bu adisyonları '
      + 'içermez.');
  }
  if (kind === 'products' || kind === 'categories') {
    notes.push('Ürün ve kategori tabloları satır tutarlarını (adisyon indirimi düşülmeden) gösterir. '
      + 'KDV dökümü ise adisyon indirimleri düşüldükten sonra hesaplanır; aradaki fark indirim tutarıdır.');
  }

  return {
    ...pack,
    title: TITLE[kind] || 'Rapor',
    range: r,
    vat: vat.rows,
    payments: pay.rows.map(x => ({ label: methodLabel(x.method), count: x.count, total: x.total })),
    total: T.revenue_gross,
    notes,
    facts: [
      ['Ciro (KDV dahil)', sheetfmt.tlText(T.revenue_gross) + ' TL'],
      ['İndirim', sheetfmt.tlText(T.discounts) + ' TL'],
      ['KDV', sheetfmt.tlText(T.vat) + ' TL'],
      ['Ciro (KDV hariç)', sheetfmt.tlText(T.revenue_net) + ' TL'],
      ['Ürün maliyeti', sheetfmt.tlText(T.cogs) + ' TL'],
      ['Giderler', sheetfmt.tlText(T.expenses) + ' TL'],
      ['Adisyon', String(T.orders)],
      ['İptal / rapor dışı', sheetfmt.tlText(T.cancelled_amount) + ' TL'],
      ['NET KÂR', sheetfmt.tlText(T.net_profit) + ' TL', true],
    ],
  };
}

module.exports = {
  checkpoint, orderIsLocked, lockedCountInRange, lockedAgainst, LOCK_MESSAGE,
  transactions, orderDetail, deleteSelected, deleteByMethod, restore, purgeSelected,
  dayList, dayDetail, closeDay, reopenDay,
  paymentSplit, purchases, discountReport, cancellationReport, financeReport,
  xReport, daySummaryHtml, mailDaySummary,
  exportSheets, exportPack, methodLabel,
};
