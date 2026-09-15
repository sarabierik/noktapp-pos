'use strict';
/**
 * Profit and loss.
 *
 * The old PHP system computes profit NINE different ways across nine files -
 * different revenue bases, different filters, different date columns - so the
 * same week shows a different profit depending on which screen you open. There
 * is one definition here, and every screen reads it.
 *
 * THE DEFINITION
 *
 *   Ciro (KDV dahil)   = SUM(orders.grand_total)      closed, not excluded
 *   KDV                = SUM(order_items VAT)          extracted, inclusive
 *   Ciro (KDV haric)   = ciro - KDV
 *   SMM (COGS)         = SUM(order_items.qty * cost_price)
 *   Brut kar           = ciro haric - SMM
 *   Giderler           = SUM(daily_costs.amount)
 *   NET KAR            = brut kar - giderler
 *
 * The one judgement call worth stating plainly: **KDV is taken out before
 * profit.** The old system did not do that - its "profit" was revenue
 * including VAT minus cost, which overstates every margin by roughly the VAT
 * rate, because the VAT was never the restaurant's money. A 10% KDV rate turns
 * a real 22% margin into a reported 30%, and that is the number an owner uses
 * to decide whether a dish is worth cooking.
 *
 * Because that changes the figure he is used to, `legacy_profit` is reported
 * alongside - computed exactly the old way - so the two can be reconciled
 * instead of argued about.
 *
 * DATE BASIS: the business day, which rolls at the configured hour (06:00 by
 * default), not midnight. A bill closed at 02:00 belongs to the night that is
 * still being worked, and the old system's DATE(closed_at) put it on the wrong
 * day - which is why late-night venues saw takings appear on the day after.
 */
const db = require('../db');
const bd = require('../util/businessDay');
const { money } = require('../util/http');

/*
 * A closed bill that counts. Cancelled bills, soft-deleted bills and bills
 * flagged out of reporting are all excluded, and each for its own reason - so
 * the predicate lives in one string and cannot drift between queries.
 */
const COUNTED = `o.status='closed' AND o.is_deleted=0 AND COALESCE(o.exclude_from_reports,0)=0`;
const DAY = `COALESCE(o.business_date, DATE(o.closed_at))`;

function pct(part, whole) {
  return whole > 0 ? money(part / whole * 100) : 0;
}

/** Fill in a zero row so a day with no trade still appears in the series. */
function blankDay(date) {
  return {
    date,
    orders: 0,
    revenue_gross: 0, discounts: 0, vat: 0, revenue_net: 0,
    cogs: 0, gross_profit: 0, gross_margin: 0,
    expenses: 0, net_profit: 0, net_margin: 0,
    legacy_profit: 0,
    cash: 0, card: 0, other: 0,
    cancelled_amount: 0, cancelled_orders: 0,
    average_ticket: 0,
  };
}

/**
 * Profit and loss for a range, day by day plus a total.
 *
 * Every component is a separate grouped query rather than one join: joining
 * orders to items and to payments in a single statement multiplies the rows
 * and silently doubles whichever side has more of them. That is the classic
 * way a POS reports twice the revenue it took.
 */
async function profitAndLoss(clientId, from, to) {
  const start = from || await bd.currentBusinessDate();
  const end = to || start;

  const revenue = await db.query(
    `SELECT ${DAY} AS d,
            COUNT(*)                           AS orders,
            COALESCE(SUM(o.total),0)           AS gross,
            COALESCE(SUM(o.discount_total),0)  AS discounts,
            COALESCE(SUM(o.grand_total),0)     AS net,
            COALESCE(SUM(o.vat_total),0)       AS vat
       FROM orders o
      WHERE o.client_id=? AND ${COUNTED} AND ${DAY} BETWEEN ? AND ?
      GROUP BY d`, [clientId, start, end]);

  /*
   * Cost is what the line cost when it was SOLD, not what the product costs
   * today: order_items.cost_price is frozen at sale time. Reading the current
   * products.cost_price instead would restate last month's profit every time
   * a supplier put their prices up.
   */
  const cogs = await db.query(
    `SELECT ${DAY} AS d,
            COALESCE(SUM(i.qty * i.cost_price),0) AS cost
       FROM order_items i
       JOIN orders o ON o.id=i.order_id AND o.client_id=i.client_id
      WHERE i.client_id=? AND i.is_deleted=0 AND ${COUNTED} AND ${DAY} BETWEEN ? AND ?
      GROUP BY d`, [clientId, start, end]);

  const pays = await db.query(
    `SELECT ${DAY} AS d, p.method, COALESCE(SUM(p.amount),0) AS amt
       FROM order_payments p
       JOIN orders o ON o.id=p.order_id AND o.client_id=p.client_id
      WHERE p.client_id=? AND p.is_deleted=0 AND p.voided_at IS NULL
        AND ${COUNTED} AND ${DAY} BETWEEN ? AND ?
      GROUP BY d, p.method`, [clientId, start, end]);

  const costs = await db.query(
    `SELECT date AS d, COALESCE(SUM(amount),0) AS amt
       FROM daily_costs WHERE client_id=? AND date BETWEEN ? AND ? GROUP BY date`,
    [clientId, start, end]);

  // reported separately rather than silently dropped: an owner wants to know
  // how much was voided, and a rising number is the thing worth noticing
  const cancelled = await db.query(
    `SELECT ${DAY} AS d, COUNT(*) AS n, COALESCE(SUM(o.grand_total),0) AS amt
       FROM orders o
      WHERE o.client_id=? AND ${DAY} BETWEEN ? AND ?
        AND (o.status='cancelled' OR COALESCE(o.exclude_from_reports,0)=1)
      GROUP BY d`, [clientId, start, end]);

  const days = new Map();
  const at = (d) => {
    const key = String(d).slice(0, 10);
    if (!days.has(key)) days.set(key, blankDay(key));
    return days.get(key);
  };

  for (const r of revenue) {
    const x = at(r.d);
    x.orders = Number(r.orders);
    x.revenue_gross = money(r.net);          // what the guests actually paid
    x.discounts = money(r.discounts);
    x.vat = money(r.vat);
  }
  for (const r of cogs) at(r.d).cogs = money(r.cost);
  for (const r of costs) at(r.d).expenses = money(r.amt);
  for (const r of pays) {
    const x = at(r.d);
    if (r.method === 'nakit') x.cash = money(Number(x.cash) + Number(r.amt));
    else if (r.method === 'kredi_karti') x.card = money(Number(x.card) + Number(r.amt));
    else x.other = money(Number(x.other) + Number(r.amt));
  }
  for (const r of cancelled) {
    const x = at(r.d);
    x.cancelled_orders = Number(r.n);
    x.cancelled_amount = money(r.amt);
  }

  for (const x of days.values()) {
    /*
     * orders.vat_total is already the tax on what was actually charged: the
     * order engine spreads a bill's discount over its lines before extracting
     * the KDV. This used to rescale it here by the day's discount ratio, which
     * is now a second helping of the same correction - and an approximate one,
     * because a ratio taken across a whole day cannot know which bill carried
     * the discount or at which rate.
     */
    x.revenue_net = money(x.revenue_gross - x.vat);
    x.gross_profit = money(x.revenue_net - x.cogs);
    x.gross_margin = pct(x.gross_profit, x.revenue_net);
    x.net_profit = money(x.gross_profit - x.expenses);
    x.net_margin = pct(x.net_profit, x.revenue_net);
    // the old system's number, for reconciliation: VAT left in, opex deducted
    x.legacy_profit = money(x.revenue_gross - x.cogs - x.expenses);
    x.average_ticket = x.orders ? money(x.revenue_gross / x.orders) : 0;
  }

  const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const sum = (k) => money(rows.reduce((s, r) => s + Number(r[k]), 0));
  const totals = {
    from: start, to: end, days: rows.length,
    orders: rows.reduce((s, r) => s + r.orders, 0),
    revenue_gross: sum('revenue_gross'), discounts: sum('discounts'), vat: sum('vat'),
    revenue_net: sum('revenue_net'), cogs: sum('cogs'),
    gross_profit: sum('gross_profit'), expenses: sum('expenses'),
    net_profit: sum('net_profit'), legacy_profit: sum('legacy_profit'),
    cash: sum('cash'), card: sum('card'), other: sum('other'),
    cancelled_amount: sum('cancelled_amount'),
    cancelled_orders: rows.reduce((s, r) => s + r.cancelled_orders, 0),
  };
  // margins are recomputed from the totals, never averaged across days: a
  // quiet Monday and a busy Saturday do not carry the same weight
  totals.gross_margin = pct(totals.gross_profit, totals.revenue_net);
  totals.net_margin = pct(totals.net_profit, totals.revenue_net);
  totals.average_ticket = totals.orders ? money(totals.revenue_gross / totals.orders) : 0;

  return { rows, totals };
}

/**
 * Where the money went, by expense category, for the same range.
 * Without this the expenses line in the P&L is a number nobody can act on.
 */
async function expenseBreakdown(clientId, from, to) {
  const rows = await db.query(
    `SELECT COALESCE(NULLIF(category,''),'Diger') AS category,
            COUNT(*) AS n, COALESCE(SUM(amount),0) AS total
       FROM daily_costs WHERE client_id=? AND date BETWEEN ? AND ?
      GROUP BY category ORDER BY total DESC`, [clientId, from, to]);
  const total = money(rows.reduce((s, r) => s + Number(r.total), 0));
  return rows.map(r => ({
    category: r.category, count: Number(r.n),
    total: money(r.total), share: pct(Number(r.total), total),
  }));
}

/**
 * Profit per product: which dishes actually earn.
 *
 * Sorted by total contribution rather than by margin percentage, because a
 * 70%-margin item sold twice matters less than a 30%-margin item sold four
 * hundred times, and a menu decision made on percentage alone deletes the
 * dish that pays the rent.
 */
async function productProfit(clientId, from, to, limit = 100) {
  const rows = await db.query(
    `SELECT p.id, p.name, c.name AS category,
            SUM(i.qty)                        AS qty,
            COALESCE(SUM(i.line_total),0)     AS revenue_gross,
            COALESCE(SUM(i.vat_total),0)      AS vat,
            COALESCE(SUM(i.qty*i.cost_price),0) AS cogs
       FROM order_items i
       JOIN orders o   ON o.id=i.order_id AND o.client_id=i.client_id
       JOIN products p ON p.id=i.product_id AND p.client_id=i.client_id
       LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
      WHERE i.client_id=? AND i.is_deleted=0 AND ${COUNTED} AND ${DAY} BETWEEN ? AND ?
      GROUP BY p.id, p.name, c.name`, [clientId, from, to]);

  const out = rows.map(r => {
    const gross = money(r.revenue_gross);
    const vat = money(r.vat);
    const net = money(gross - vat);
    const cogs = money(r.cogs);
    const profit = money(net - cogs);
    return {
      product_id: r.id, name: r.name, category: r.category || '',
      qty: Number(r.qty), revenue_gross: gross, vat, revenue_net: net,
      cogs, profit, margin: pct(profit, net),
      // no cost recorded means the margin is a fiction, not 100%
      costed: cogs > 0,
    };
  }).sort((a, b) => b.profit - a.profit);
  return out.slice(0, limit);
}

/**
 * The same question one level up: which CATEGORY earns.
 * This is the view that answers "should we keep doing breakfast".
 */
async function categoryProfit(clientId, from, to) {
  const products = await productProfit(clientId, from, to, 100000);
  const byCat = new Map();
  for (const p of products) {
    const key = p.category || 'Kategorisiz';
    const c = byCat.get(key) || { category: key, qty: 0, revenue_net: 0, cogs: 0, profit: 0 };
    c.qty += p.qty;
    c.revenue_net = money(c.revenue_net + p.revenue_net);
    c.cogs = money(c.cogs + p.cogs);
    c.profit = money(c.profit + p.profit);
    byCat.set(key, c);
  }
  return [...byCat.values()]
    .map(c => ({ ...c, margin: pct(c.profit, c.revenue_net) }))
    .sort((a, b) => b.profit - a.profit);
}

/**
 * Products with no cost price.
 *
 * Every one of these reports a 100% margin and quietly inflates the profit on
 * every screen above. Naming them is more useful than hiding them, so the
 * owner can see exactly how much of the reported profit is not yet costed.
 */
async function uncostedProducts(clientId, from, to) {
  const rows = await db.query(
    `SELECT p.id, p.name, SUM(i.qty) AS qty, COALESCE(SUM(i.line_total),0) AS revenue
       FROM order_items i
       JOIN orders o   ON o.id=i.order_id AND o.client_id=i.client_id
       JOIN products p ON p.id=i.product_id AND p.client_id=i.client_id
      WHERE i.client_id=? AND i.is_deleted=0 AND ${COUNTED} AND ${DAY} BETWEEN ? AND ?
        AND COALESCE(i.cost_price,0) = 0
      GROUP BY p.id, p.name ORDER BY revenue DESC`, [clientId, from, to]);
  return rows.map(r => ({
    product_id: r.id, name: r.name, qty: Number(r.qty), revenue: money(r.revenue),
  }));
}

/** Everything a P&L screen needs, in one call. */
async function statement(clientId, from, to) {
  const [pl, expenses, products, categories, uncosted] = await Promise.all([
    profitAndLoss(clientId, from, to),
    expenseBreakdown(clientId, from, to),
    productProfit(clientId, from, to, 50),
    categoryProfit(clientId, from, to),
    uncostedProducts(clientId, from, to),
  ]);
  const uncostedRevenue = money(uncosted.reduce((s, r) => s + r.revenue, 0));
  return {
    ...pl,
    expenses_by_category: expenses,
    products, categories,
    uncosted: {
      products: uncosted,
      revenue: uncostedRevenue,
      // the honest health warning on the profit figure above
      share_of_revenue: pct(uncostedRevenue, pl.totals.revenue_gross),
    },
  };
}

module.exports = {
  profitAndLoss, expenseBreakdown, productProfit, categoryProfit,
  uncostedProducts, statement,
};
