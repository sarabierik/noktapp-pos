'use strict';
/**
 * Reporting + end of day.
 * Every figure here comes from the same place the bill did, so the Z report and
 * the KDV breakdown always agree with what the customer paid.
 */
const db = require('../db');
const bd = require('../util/businessDay');
const { money, minor } = require('../util/http');
const kdv = require('../util/vat');

/*
 * A bill that was taken off the books contributes NOTHING.
 *
 * Deleting a bill sets `exclude_from_reports`; the older, harder delete also
 * sets `is_deleted`. The headline totals here checked both, but the queries
 * underneath them - payment breakdown, top products, hourly, the VAT split,
 * cost of goods - checked only `is_deleted`. So a bill removed from Islemler
 * vanished from the day's turnover and stayed in its payment methods, its
 * product counts and its cost. The Z report did not add up to itself.
 *
 * One predicate, used by every query in this file.
 */
const ON_BOOKS = `o.is_deleted=0 AND COALESCE(o.exclude_from_reports,0)=0`;

async function dashboard(clientId) {
  const date = await bd.currentBusinessDate();
  const sales = await db.one(
    `SELECT COUNT(*) orders, COALESCE(SUM(grand_total),0) total, COALESCE(SUM(discount_total),0) disc,
            COALESCE(SUM(vat_total),0) vat
       FROM orders WHERE client_id=? AND business_date=? AND is_deleted=0 AND exclude_from_reports=0`,
    [clientId, date]);
  const open = await db.one(
    `SELECT COUNT(*) c, COALESCE(SUM(grand_total),0) t FROM orders
      WHERE client_id=? AND status='open' AND is_deleted=0`, [clientId]);
  const byMethod = await db.query(
    `SELECT p.method, COALESCE(SUM(p.amount),0) total FROM order_payments p
       JOIN orders o ON o.id=p.order_id
      WHERE p.client_id=? AND o.business_date=? AND p.is_deleted=0 AND p.voided_at IS NULL
        AND ${ON_BOOKS}
      GROUP BY p.method`, [clientId, date]);
  const top = await db.query(
    `SELECT pr.name, SUM(i.qty) qty, SUM(i.line_total) total
       FROM order_items i JOIN orders o ON o.id=i.order_id JOIN products pr ON pr.id=i.product_id
      WHERE i.client_id=? AND o.business_date=? AND i.is_deleted=0 AND ${ON_BOOKS}
      GROUP BY pr.id ORDER BY qty DESC LIMIT 8`, [clientId, date]);
  const hourly = await db.query(
    `SELECT HOUR(o.opened_at) h, COUNT(*) c, COALESCE(SUM(o.grand_total),0) t
       FROM orders o WHERE o.client_id=? AND o.business_date=? AND ${ON_BOOKS}
      GROUP BY HOUR(o.opened_at) ORDER BY h`, [clientId, date]);
  return {
    business_date: date,
    orders: Number(sales.orders), total: money(sales.total), discount: money(sales.disc), vat: money(sales.vat),
    open_bills: Number(open.c), open_total: money(open.t),
    average: sales.orders ? money(Number(sales.total) / Number(sales.orders)) : 0,
    by_method: byMethod.map(m => ({ method: m.method, total: money(m.total) })),
    top_products: top, hourly,
  };
}

/** Z report for one business day. */
async function zReport(clientId, date) {
  const d = date || await bd.currentBusinessDate();
  const head = await db.one(
    `SELECT COUNT(*) orders, COALESCE(SUM(total),0) gross, COALESCE(SUM(discount_total),0) discount,
            COALESCE(SUM(grand_total),0) net
       FROM orders WHERE client_id=? AND business_date=? AND is_deleted=0 AND exclude_from_reports=0`,
    [clientId, d]);

  /*
   * The KDV split is built bill by bill from the LINES, not with one grouped
   * SUM over the day.
   *
   * Two reasons, and both of them are "the report has to add up to itself".
   * A bill-level discount belongs to one bill, so the tax it takes off can only
   * be worked out inside that bill - a SUM across the day has nowhere to put
   * it. And a per-rate figure rounded once at the end does not have to equal
   * the header it sits under; adding up the same kurus the bills were charged
   * in does. Every bill goes through the same util/vat as the till used, so the
   * breakdown and the bill in the guest's hand are the same arithmetic.
   */
  const lineRows = await db.query(
    `SELECT o.id, o.discount_total, i.line_total, i.vat_rate
       FROM order_items i JOIN orders o ON o.id=i.order_id AND o.client_id=i.client_id
      WHERE i.client_id=? AND o.business_date=? AND i.is_deleted=0 AND ${ON_BOOKS}
      ORDER BY o.id`, [clientId, d]);
  const perBill = new Map();
  for (const r of lineRows) {
    if (!perBill.has(r.id)) perBill.set(r.id, { discount: r.discount_total, lines: [] });
    perBill.get(r.id).lines.push({ lineTotal: r.line_total, vatRate: r.vat_rate });
  }
  const rates = new Map();
  let vatMinor = 0;
  for (const b of perBill.values()) {
    const v = kdv.billVat(b.lines, b.discount);
    vatMinor += minor(v.vatTotal);
    kdv.accumulate(rates, v.breakdown);
  }
  const vat = kdv.finish(rates);
  const pay = await db.query(
    `SELECT p.method, COUNT(*) cnt, COALESCE(SUM(p.amount),0) total
       FROM order_payments p JOIN orders o ON o.id=p.order_id
      WHERE p.client_id=? AND o.business_date=? AND p.is_deleted=0 AND p.voided_at IS NULL
        AND ${ON_BOOKS}
      GROUP BY p.method`, [clientId, d]);
  const cancels = await db.one(
    `SELECT COUNT(*) c, COALESCE(SUM(line_total),0) t FROM order_item_cancel_events
      WHERE client_id=? AND DATE(cancelled_at)=?`, [clientId, d]);
  const deleted = await db.one(
    'SELECT COUNT(*) c, COALESCE(SUM(grand_total),0) t FROM order_delete_logs WHERE client_id=? AND DATE(deleted_at)=?',
    [clientId, d]);
  const shifts = await db.query('SELECT * FROM pos_shifts WHERE client_id=? AND business_date=? ORDER BY shift_no', [clientId, d]);
  const cost = await db.one(
    `SELECT COALESCE(SUM(i.cost_price * i.qty),0) c FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE i.client_id=? AND o.business_date=? AND i.is_deleted=0 AND ${ON_BOOKS}`, [clientId, d]);
  const extra = await db.one('SELECT COALESCE(SUM(amount),0) c FROM daily_costs WHERE client_id=? AND date=?', [clientId, d]);
  const net = money(head.net);
  const vatTotal = money(vatMinor / 100);
  const cogs = money(cost.c);
  const extras = money(extra.c);
  /*
   * KDV comes OUT before profit, exactly as modules/pnl.js defines it - that
   * file is the one definition and this report must not invent a second one.
   * Leaving the tax in overstated the day's profit by the whole of the KDV,
   * which on a 10% menu turns a real 22% margin into a reported 30% - and that
   * is the number an owner prices the menu off.
   */
  const netExVat = money(net - vatTotal);
  const profit = money(netExVat - cogs - extras);
  return {
    date: d,
    orders: Number(head.orders), gross: money(head.gross), discount: money(head.discount),
    net, vat_total: vatTotal, net_ex_vat: netExVat,
    vat_breakdown: vat,
    payments: pay.map(p => ({ method: p.method, count: Number(p.cnt), total: money(p.total) })),
    cancelled_items: { count: Number(cancels.c), total: money(cancels.t) },
    deleted_bills: { count: Number(deleted.c), total: money(deleted.t) },
    shifts,
    cost_of_goods: cogs, extra_costs: extras,
    profit,
    margin: netExVat ? money((profit / netExVat) * 100) : 0,
  };
}

/** Close the business day. Refuses while a bill is still open. */
async function closeDay(clientId, { userId, declaredCash = 0, declaredCard = 0 }) {
  const date = await bd.currentBusinessDate();
  const openCount = Number(await db.value(
    "SELECT COUNT(*) FROM orders WHERE client_id=? AND business_date=? AND status='open' AND is_deleted=0",
    [clientId, date]));
  if (openCount) { const e = new Error(`${openCount} adisyon hala acik. Once onlari kapatin.`); e.status = 409; throw e; }
  const openShift = await db.one("SELECT id FROM pos_shifts WHERE client_id=? AND status='open'", [clientId]);
  if (openShift) { const e = new Error('Acik vardiya var. Once vardiyayi kapatin.'); e.status = 409; throw e; }
  /*
   * A day that is already signed off is not signed off again. Nothing checked,
   * so pressing "Gun sonu" twice - which is exactly what a cashier does when
   * the first press seems not to have printed - wrote a second daily_closings
   * row for the same date and the Finans screen showed two day-ends where
   * there had been one evening.
   *
   * `isDayClosed` and not "does a row exist": a day that has been REOPENED has
   * to be closable again, and that is what its close_seq 2 is for.
   */
  if (await bd.isDayClosed(clientId, date)) {
    const e = new Error('Bu gunun gun sonu zaten alinmis.'); e.status = 409; e.code = 'DAY_CLOSED'; throw e;
  }

  const z = await zReport(clientId, date);
  const cash = z.payments.find(p => p.method === 'nakit');
  const card = z.payments.filter(p => p.method !== 'nakit').reduce((a, p) => a + p.total, 0);
  const expectedCash = cash ? cash.total : 0;
  const seq = Number(await db.value('SELECT COALESCE(MAX(close_seq),0)+1 FROM daily_closings WHERE client_id=? AND date=?',
    [clientId, date]));

  await db.tx(async t => {
    try {
    await t.insert(
      `INSERT INTO daily_closings (client_id, date, close_seq, expected_cash, declared_cash, declared_card,
          cash_difference, card_difference, expected_card, expected_sales, order_count, expected_cost,
          expected_net, closed_by, closed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [clientId, date, seq, expectedCash, money(declaredCash), money(declaredCard),
       money(Number(declaredCash) - expectedCash), money(Number(declaredCard) - card),
       money(card), z.net, z.orders, z.cost_of_goods, z.profit, userId || null]);
    await t.exec(
      `INSERT INTO finance_daily_snapshots (client_id, date, gross_sales, discounts, net_sales, cost_of_goods,
          extra_costs, cash_sales, card_sales, order_count, canceled_order_count, profit, margin)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE gross_sales=VALUES(gross_sales), net_sales=VALUES(net_sales),
          profit=VALUES(profit), margin=VALUES(margin)`,
      [clientId, date, z.gross, z.discount, z.net, z.cost_of_goods, z.extra_costs,
       expectedCash, money(card), z.orders, z.deleted_bills.count, z.profit, z.margin]);
    /*
     * The day-end is the checkpoint everything downstream is measured against,
     * and until now the till's own "Gun sonu" button wrote no audit row at all
     * - only the Finans screen's version of the same action did. Two doors,
     * one record: an owner asking "who signed off the 14th, and what did it
     * say" got an answer from one of them and silence from the other.
     */
    await t.exec(
      `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id, after_json, meta_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,NOW())`,
      [clientId, userId || null, 'admin', 'day.close', 'day', date,
       JSON.stringify({ close_seq: seq, net: z.net, orders: z.orders, expected_cash: expectedCash,
         declared_cash: money(declaredCash), declared_card: money(declaredCard), profit: z.profit }),
       JSON.stringify({ screen: 'pos/gun-sonu' })]);
    } catch (err) {
      /*
       * uq_dc_client_date_seq is the real guard: close_seq is worked out before
       * the transaction, so two tills pressing Gun sonu together compute the
       * same number and one of them loses on the unique key. It used to lose
       * with a raw "Duplicate entry" out of the driver; the till should say
       * what happened, and nothing should be half-written.
       */
      if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
        const e = new Error('Gun sonu bu arada baska bir kasadan alindi.'); e.status = 409; throw e;
      }
      throw err;
    }
  });
  const sync = require('../sync');
  sync.push('daily_closing', `${clientId}:${date}:${seq}`, z).catch(() => {});
  return { ...z, close_seq: seq, expected_cash: expectedCash, declared_cash: money(declaredCash) };
}

async function reopenDay(clientId, date, userId) {
  const row = await db.one('SELECT * FROM daily_closings WHERE client_id=? AND date=? ORDER BY id DESC LIMIT 1',
    [clientId, date]);
  if (!row) { const e = new Error('Bu gun icin gun sonu yok'); e.status = 404; throw e; }
  await db.exec('UPDATE daily_closings SET is_reopened=1, reopened_at=NOW(), reopened_by=? WHERE id=?', [userId || null, row.id]);
  await db.exec(
    `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id, created_at)
     VALUES (?,?,?,?,?,?,NOW())`,
    [clientId, userId || null, 'admin', 'day.reopen', 'day', date]);
  return true;
}

/* ------------------------- range reports -------------------------- */

/**
 * The KDV split for a RANGE, built the same way the Z report builds a day's.
 *
 * Bill by bill from the lines, through util/vat, and never with one grouped
 * SUM: a bill-level discount belongs to one bill, so the tax it takes off can
 * only be worked out inside that bill, and a per-rate figure rounded once at
 * the end does not have to equal the header it sits under. Adding up the same
 * kurus the guests were charged in does.
 *
 * Returns `{ rows, total, gross }` where `gross` is what the breakdown says
 * the period took - the figure the report total has to agree with.
 */
async function vatRange(clientId, from, to, { closedOnly = true } = {}) {
  /*
   * Two predicates, because two families of report ask two different
   * questions and each one's KDV has to reconcile with its OWN total.
   *
   * Kâr/Zarar and everything on the Finans screens count a bill once it is
   * closed - money taken - and date it by business day falling back to the
   * closing time. Satış / Personel on the Raporlar screen count every bill
   * that is on the books for that business day, open ones included. Handing
   * both the same breakdown would put an open table's KDV into a P&L that
   * does not contain its turnover, and the page would visibly not add up.
   */
  const where = closedOnly
    ? `o.status='closed' AND o.is_deleted=0 AND COALESCE(o.exclude_from_reports,0)=0
       AND COALESCE(o.business_date, DATE(o.closed_at)) BETWEEN ? AND ?`
    : `${ON_BOOKS} AND o.business_date BETWEEN ? AND ?`;
  const lineRows = await db.query(
    `SELECT o.id, o.discount_total, i.line_total, i.vat_rate
       FROM order_items i JOIN orders o ON o.id=i.order_id AND o.client_id=i.client_id
      WHERE i.client_id=? AND i.is_deleted=0 AND ${where}
      ORDER BY o.id`, [clientId, from, to]);
  const perBill = new Map();
  for (const r of lineRows) {
    if (!perBill.has(r.id)) perBill.set(r.id, { discount: r.discount_total, lines: [] });
    perBill.get(r.id).lines.push({ lineTotal: r.line_total, vatRate: r.vat_rate });
  }
  const rates = new Map();
  let vatMinor = 0;
  for (const b of perBill.values()) {
    const v = kdv.billVat(b.lines, b.discount);
    vatMinor += minor(v.vatTotal);
    kdv.accumulate(rates, v.breakdown);
  }
  const rows = kdv.finish(rates);
  return {
    rows,
    total: money(vatMinor / 100),
    gross: money(rows.reduce((s, r) => s + r.gross, 0)),
  };
}

async function salesRange(clientId, from, to) {
  return db.query(
    `SELECT o.business_date d, COUNT(*) orders, COALESCE(SUM(o.grand_total),0) total,
            COALESCE(SUM(o.discount_total),0) discount, COALESCE(SUM(o.vat_total),0) vat
       FROM orders o WHERE o.client_id=? AND o.business_date BETWEEN ? AND ?
        AND o.is_deleted=0 AND o.exclude_from_reports=0
      GROUP BY o.business_date ORDER BY o.business_date`, [clientId, from, to]);
}

async function productSales(clientId, from, to) {
  return db.query(
    /*
     * Profit is revenue EXCLUDING KDV minus cost - the one definition, the one
     * modules/pnl.js states and every other screen reads. This used to subtract
     * the cost from the KDV-inclusive revenue, which is a second, higher answer
     * to the same question: on a %10 menu it reports a 30% margin where the
     * real one is 22%, and that is the number a menu gets priced off.
     */
    `SELECT pr.id, pr.name, c.name category, SUM(i.qty) qty, SUM(i.line_total) revenue,
            SUM(i.vat_total) vat, SUM(i.line_total) - SUM(i.vat_total) revenue_net,
            SUM(i.cost_price*i.qty) cost,
            SUM(i.line_total) - SUM(i.vat_total) - SUM(i.cost_price*i.qty) profit
       FROM order_items i
       JOIN orders o ON o.id=i.order_id
       JOIN products pr ON pr.id=i.product_id
       LEFT JOIN categories c ON c.id=pr.category_id
      WHERE i.client_id=? AND o.business_date BETWEEN ? AND ? AND i.is_deleted=0
        AND o.is_deleted=0 AND o.exclude_from_reports=0
      GROUP BY pr.id ORDER BY revenue DESC`, [clientId, from, to]);
}

async function waiterPerformance(clientId, from, to) {
  return db.query(
    `SELECT u.id, u.display_name, COUNT(DISTINCT o.id) orders, COALESCE(SUM(o.grand_total),0) total,
            COALESCE(AVG(o.grand_total),0) avg_ticket
       FROM orders o JOIN users u ON u.id=o.waiter_id
      WHERE o.client_id=? AND o.business_date BETWEEN ? AND ? AND o.is_deleted=0 AND o.exclude_from_reports=0
      GROUP BY u.id ORDER BY total DESC`, [clientId, from, to]);
}

async function cancelReport(clientId, from, to) {
  const items = await db.query(
    `SELECT e.*, p.name product_name FROM order_item_cancel_events e
       LEFT JOIN products p ON p.id=e.product_id
      WHERE e.client_id=? AND DATE(e.cancelled_at) BETWEEN ? AND ? ORDER BY e.cancelled_at DESC`,
    [clientId, from, to]);
  const bills = await db.query(
    `SELECT l.*, u.display_name deleted_by_name FROM order_delete_logs l
       LEFT JOIN users u ON u.id=l.deleted_by
      WHERE l.client_id=? AND DATE(l.deleted_at) BETWEEN ? AND ? ORDER BY l.deleted_at DESC`,
    [clientId, from, to]);
  const payments = await db.query(
    `SELECT * FROM payment_delete_logs WHERE client_id=? AND DATE(deleted_at) BETWEEN ? AND ? ORDER BY deleted_at DESC`,
    [clientId, from, to]);
  return { items, bills, payments };
}

/* ==================================================================== *
 * EXPORTS - Raporlar / Dönem raporları                                 *
 * ==================================================================== */
/*
 * These used to go out through a four-line toCsv() that wrapped every cell in
 * quotes and shipped the value exactly as MySQL handed it over: "1234.56" and
 * "2026-09-01". In a Turkish Excel that is a column of text, not a column of
 * money and not a column of dates - the accountant cannot sum it, cannot sort
 * it, and rings the restaurant. The finance screens had already been fixed;
 * this half of the app had not, which is why one CSV worked and the other did
 * not.
 *
 * So: the same typed sheets, the same renderer, the same PDF. One export
 * pipeline, and the two halves cannot drift again.
 */
const S = require('../report/sheet');
const { MONEY, INT, PCT, TXT, DATE } = S;

const COLS = {
  sales: [
    { k: 'd', tr: 'Tarih', t: DATE }, { k: 'orders', tr: 'Adisyon', t: INT },
    { k: 'total', tr: 'Ciro (KDV dahil)', t: MONEY }, { k: 'discount', tr: 'İndirim', t: MONEY },
    { k: 'vat', tr: 'KDV', t: MONEY },
  ],
  products: [
    { k: 'name', tr: 'Ürün', t: TXT }, { k: 'category', tr: 'Kategori', t: TXT },
    { k: 'qty', tr: 'Adet', t: INT }, { k: 'revenue', tr: 'Ciro (KDV dahil)', t: MONEY },
    { k: 'vat', tr: 'KDV', t: MONEY }, { k: 'revenue_net', tr: 'Ciro (KDV hariç)', t: MONEY },
    { k: 'cost', tr: 'Maliyet', t: MONEY }, { k: 'profit', tr: 'Kâr', t: MONEY },
  ],
  waiters: [
    { k: 'display_name', tr: 'Personel', t: TXT }, { k: 'orders', tr: 'Adisyon', t: INT },
    { k: 'total', tr: 'Ciro (KDV dahil)', t: MONEY },
    { k: 'avg_ticket', tr: 'Ortalama Adisyon', t: MONEY },
  ],
  daily: [
    { k: 'date', tr: 'Tarih', t: DATE }, { k: 'orders', tr: 'Adisyon', t: INT },
    { k: 'revenue_gross', tr: 'Ciro (KDV dahil)', t: MONEY }, { k: 'vat', tr: 'KDV', t: MONEY },
    { k: 'revenue_net', tr: 'Ciro (KDV hariç)', t: MONEY }, { k: 'cogs', tr: 'Maliyet', t: MONEY },
    { k: 'expenses', tr: 'Gider', t: MONEY }, { k: 'net_profit', tr: 'Net Kâr', t: MONEY },
    { k: 'net_margin', tr: 'Marj %', t: PCT }, { k: 'cash', tr: 'Nakit', t: MONEY },
    { k: 'card', tr: 'Kart', t: MONEY }, { k: 'other', tr: 'Diğer', t: MONEY },
  ],
  pnlProducts: [
    { k: 'name', tr: 'Ürün', t: TXT }, { k: 'category', tr: 'Kategori', t: TXT },
    { k: 'qty', tr: 'Adet', t: INT }, { k: 'revenue_gross', tr: 'Ciro (KDV dahil)', t: MONEY },
    { k: 'vat', tr: 'KDV', t: MONEY }, { k: 'revenue_net', tr: 'Ciro (KDV hariç)', t: MONEY },
    { k: 'cogs', tr: 'Maliyet', t: MONEY }, { k: 'profit', tr: 'Kâr', t: MONEY },
    { k: 'margin', tr: 'Marj %', t: PCT },
  ],
  pnlCategories: [
    { k: 'category', tr: 'Kategori', t: TXT }, { k: 'qty', tr: 'Adet', t: INT },
    { k: 'revenue_net', tr: 'Ciro (KDV hariç)', t: MONEY }, { k: 'cogs', tr: 'Maliyet', t: MONEY },
    { k: 'profit', tr: 'Kâr', t: MONEY }, { k: 'margin', tr: 'Marj %', t: PCT },
  ],
};

const METHOD_TR = {
  nakit: 'Nakit', kredi_karti: 'Kredi kartı', yemek_karti: 'Yemek kartı',
  havale: 'Havale / EFT', ikram: 'İkram', acik_hesap: 'Açık hesap',
};

/** Money taken in the range, by method. Same ON_BOOKS predicate as the rest. */
async function paymentsRange(clientId, from, to) {
  const rows = await db.query(
    `SELECT p.method, COUNT(*) n, COALESCE(SUM(p.amount),0) total
       FROM order_payments p JOIN orders o ON o.id=p.order_id AND o.client_id=p.client_id
      WHERE p.client_id=? AND p.is_deleted=0 AND p.voided_at IS NULL
        AND o.business_date BETWEEN ? AND ? AND ${ON_BOOKS}
      GROUP BY p.method ORDER BY total DESC`, [clientId, from, to]);
  return rows.map(r => ({
    label: METHOD_TR[r.method] || r.method, count: Number(r.n), total: money(r.total),
  }));
}

const TITLE = {
  sales: 'Satış raporu', products: 'Ürün satış raporu', waiters: 'Personel raporu',
  pnl: 'Kâr / Zarar raporu', 'pnl-products': 'Ürün kârlılık raporu',
  'pnl-categories': 'Kategori kârlılık raporu',
};

/**
 * One report, as the typed sheets every renderer reads, plus the furniture an
 * accountant's copy needs: the KDV split, the payment split and the period's
 * headline figures. The rows are the SAME rows the screen asked for, from the
 * same functions - a PDF can never show a different period from its CSV.
 */
async function exportSheets(clientId, kind, q = {}) {
  const pnl = require('./pnl');
  const to = q.to || new Date().toISOString().slice(0, 10);
  const from = q.from || to;
  const stamp = `${from}_${to}`;
  const title = TITLE[kind];
  if (!title) { const e = new Error('Bilinmeyen rapor'); e.status = 404; throw e; }

  /*
   * Satış / Ürün / Personel count every bill on the books for the business
   * day, open tables included; Kâr/Zarar counts closed bills only. The KDV
   * split is asked for on the same terms as the report it sits in, so the
   * breakdown always reconciles with the total printed above it.
   */
  const closedOnly = kind.startsWith('pnl');
  const [vat, payments] = await Promise.all([
    vatRange(clientId, from, to, { closedOnly }),
    paymentsRange(clientId, from, to),
  ]);
  const base = {
    title, range: { from, to }, vat: vat.rows, payments,
    total: vat.gross, notes: [],
  };

  /*
   * A product or category table sums LINE totals, which are before any
   * bill-level discount; the KDV block is worked out after it. The two
   * therefore differ by the discounts, and saying so is the difference
   * between a document an accountant trusts and one they query.
   */
  const LINE_NOTE = 'Ürün ve kategori tabloları satır tutarlarını (adisyon indirimi düşülmeden) '
    + 'gösterir. KDV dökümü ise adisyon indirimleri düşüldükten sonra hesaplanır; aradaki fark '
    + 'indirim tutarıdır.';

  if (kind === 'sales') {
    const rows = await salesRange(clientId, from, to);
    const gross = money(rows.reduce((a, r) => a + Number(r.total), 0));
    return { name: `satis-${stamp}`, sheets: [{ name: 'Satış', cols: COLS.sales, rows }],
      ...base, total: gross,
      facts: totalsFacts(gross, rows.reduce((a, r) => a + Number(r.orders), 0), vat) };
  }
  if (kind === 'products') {
    const rows = await productSales(clientId, from, to);
    return { name: `urun-satis-${stamp}`, sheets: [{ name: 'Ürünler', cols: COLS.products, rows }],
      ...base, notes: [LINE_NOTE] };
  }
  if (kind === 'waiters') {
    const rows = await waiterPerformance(clientId, from, to);
    const gross = money(rows.reduce((a, r) => a + Number(r.total), 0));
    return { name: `personel-${stamp}`, sheets: [{ name: 'Personel', cols: COLS.waiters, rows }],
      ...base, total: gross,
      facts: totalsFacts(gross, rows.reduce((a, r) => a + Number(r.orders), 0), vat) };
  }
  if (kind === 'pnl') {
    const pl = await pnl.profitAndLoss(clientId, from, to);
    const T = pl.totals;
    return {
      name: `kar-zarar-${stamp}`,
      sheets: [{ name: 'Günlük', cols: COLS.daily, rows: pl.rows }],
      ...base,
      facts: [
        ['Ciro (KDV dahil)', S.tlText(T.revenue_gross) + ' TL'],
        ['İndirim', S.tlText(T.discounts) + ' TL'],
        ['KDV', S.tlText(T.vat) + ' TL'],
        ['Ciro (KDV hariç)', S.tlText(T.revenue_net) + ' TL'],
        ['Ürün maliyeti', S.tlText(T.cogs) + ' TL'],
        ['Giderler', S.tlText(T.expenses) + ' TL'],
        ['Adisyon', String(T.orders)],
        ['NET KÂR', S.tlText(T.net_profit) + ' TL', true],
      ],
      total: T.revenue_gross,
    };
  }
  if (kind === 'pnl-products') {
    const rows = await pnl.productProfit(clientId, from, to, 100000);
    return { name: `urun-karlilik-${stamp}`,
      sheets: [{ name: 'Ürünler', cols: COLS.pnlProducts, rows }], ...base, notes: [LINE_NOTE] };
  }
  const rows = await pnl.categoryProfit(clientId, from, to);
  return { name: `kategori-karlilik-${stamp}`,
    sheets: [{ name: 'Kategoriler', cols: COLS.pnlCategories, rows }], ...base, notes: [LINE_NOTE] };
}

/** The headline three, for a report that has no P&L block of its own. */
function totalsFacts(gross, orders, vat) {
  return [
    ['Adisyon', String(Math.round(orders))],
    ['KDV', S.tlText(vat.total) + ' TL'],
    ['Ciro (KDV dahil)', S.tlText(gross) + ' TL', true],
  ];
}

module.exports = { dashboard, zReport, closeDay, reopenDay, salesRange, productSales,
  waiterPerformance, cancelReport, vatRange, exportSheets };
