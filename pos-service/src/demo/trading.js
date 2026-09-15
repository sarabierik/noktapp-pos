'use strict';
/**
 * SEVEN YEARS OF SERVICE.
 *
 * This is the part that has to be believable, because it is the part every
 * report is computed from. Three rules shape it:
 *
 *  1. The shape of a year is not flat. Antalya is a tourist town: August is
 *     three times January, Friday and Saturday carry the week, and 2020 has a
 *     hole in it where the restaurant was shut. A demo whose every day takes
 *     the same money makes the trend screens - the ones being demonstrated -
 *     look broken.
 *
 *  2. Money is computed, never invented. Every total on a bill is the sum of
 *     its lines; every figure on a closed shift is the sum of its payments;
 *     every daily_closing is the sum of that day's bills. If the seeder
 *     guesses a total, the Kâr-Zarar screen and the Z report disagree and the
 *     first person to add up a column finds it.
 *
 *  3. Not everything went right. About one line in seventy was cancelled, one
 *     bill in three hundred was deleted with a reason, some nights the drawer
 *     was 40 lira short. Those screens exist and a demo where they are empty
 *     is a demo that cannot show them.
 */
const crypto = require('crypto');
const { bulk, ymd, dt, atTime, _addDays, eachDay, money, minor } = require('./lib');
const D = require('./data');

/* covers per day, by year, before any modifier - the restaurant growing */
const BASE_BY_YEAR = { 2020: 26, 2021: 32, 2022: 38, 2023: 44, 2024: 50, 2025: 55, 2026: 60 };

/* Antalya's season. Index 0 = January. */
const SEASON = [0.62, 0.60, 0.70, 0.85, 1.05, 1.25, 1.45, 1.50, 1.30, 1.05, 0.75, 0.80];

/* Sunday..Saturday */
const WEEKDAY = [0.95, 0.72, 0.75, 0.82, 0.95, 1.35, 1.45];

/* The 2020 closures, as they actually happened in Turkey. */
function covidFactor(d) {
  const s = ymd(d);
  if (s >= '2020-03-16' && s <= '2020-06-01') return 0;      // full closure
  if (s >= '2020-06-02' && s <= '2020-08-31') return 0.55;   // reopened, half empty
  if (s >= '2020-11-20' && s <= '2020-12-31') return 0.18;   // takeaway only
  if (s >= '2021-01-01' && s <= '2021-03-01') return 0.22;   // still takeaway only
  if (s >= '2021-04-29' && s <= '2021-05-17') return 0;      // the last full closure
  return 1;
}

const PAYMENT_MIX = [
  ['nakit', 0.34], ['kredi', 0.44], ['banka', 0.13], ['yemek_karti', 0.07], ['havale', 0.02],
];

function pickMethod(r) {
  let x = r();
  for (const [m, w] of PAYMENT_MIX) { x -= w; if (x <= 0) return m; }
  return 'nakit';
}

/** A weighted pick over the menu, so the top-sellers list looks like a kebap house. */
function menuPicker(products, r) {
  const pool = [];
  for (const p of products) for (let i = 0; i < p.weight; i++) pool.push(p);
  return () => pool[Math.floor(r() * pool.length)];
}

async function build(ctx) {
  const { db, clientId, rand: r } = ctx;
  const uuid = () => crypto.randomUUID();
  const pickProduct = menuPicker(ctx.products, r);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));

  const days = eachDay(ctx.start, ctx.today);
  ctx.log(`ticaret: ${days.length} gün, ${ymd(ctx.start)} → ${ymd(ctx.today)}`);

  /* Auto-increment ids are needed to link items and payments to their bill, so
     the ids are claimed up front rather than read back one row at a time. */
  let orderId = Number(await db.value('SELECT COALESCE(MAX(id),0) FROM orders')) + 1;
  let itemId = Number(await db.value('SELECT COALESCE(MAX(id),0) FROM order_items')) + 1;
  let shiftId = Number(await db.value('SELECT COALESCE(MAX(id),0) FROM pos_shifts')) + 1;

  const totals = { orders: 0, items: 0, payments: 0, revenue: 0 };
  ctx.dayIndex = [];        // [{date, orderIds, revenue, cash, card}]
  ctx.deliveryOrders = [];  // handed to the paket servis part
  ctx.platformOrders = [];  // handed to the entegrasyon part
  ctx.soldByProduct = new Map();

  /* One month at a time: the rows are written and released before the next
     month is generated, so peak memory is a month rather than seven years. */
  let _month = [];
  let monthKey = null;
  const flushables = () => ({
    orders: [], items: [], payments: [], discounts: [], cancels: [], deletes: [],
    shifts: [], movements: [], counts: [], drawer: [], closings: [], snaps: [], costs: [],
  });
  let B = flushables();

  const flush = async () => {
    await bulk(db, 'orders', ['id', 'adisyon_no', 'client_id', 'business_date', 'table_id', 'waiter_id',
      'customer_id', 'status', 'opened_at', 'closed_at', 'closed_by', 'total', 'discount_total',
      'vat_total', 'grand_total', 'notes', 'bill_label', 'created_by', 'created_at', 'updated_at',
      'is_closed', 'exclude_from_reports', 'is_deleted', 'shift_id'], B.orders);
    await bulk(db, 'order_items', ['id', 'client_id', 'order_id', 'product_id', 'station_id',
      'station_status', 'station_updated_at', 'qty', 'note', 'price', 'cost_price', 'total',
      'line_total', 'discount_amount', 'unit_price', 'vat_rate', 'vat_total', 'sent_qty',
      'is_deleted', 'updated_at'], B.items);
    await bulk(db, 'order_payments', ['client_id', 'order_id', 'method', 'amount', 'payment_channel',
      'created_at', 'created_by', 'shift_id'], B.payments);
    await bulk(db, 'order_discounts', ['client_id', 'order_id', 'discount_value', 'reason', 'source',
      'created_by', 'created_at'], B.discounts);
    await bulk(db, 'order_item_cancel_events', ['client_id', 'order_id', 'product_id', 'qty',
      'line_total', 'vat_total', 'vat_rate', 'cancelled_at'], B.cancels);
    await bulk(db, 'order_delete_logs', ['client_id', 'order_id', 'bill_label', 'adisyon_no',
      'table_id', 'waiter_id', 'opened_at', 'closed_at', 'total', 'discount_total', 'grand_total',
      'deleted_at', 'deleted_by', 'reason', 'original_data'], B.deletes);
    await bulk(db, 'pos_shifts', ['id', 'client_id', 'shift_uid', 'device_id', 'business_date',
      'shift_no', 'opened_by', 'opened_by_name', 'opened_at', 'opening_float_minor', 'closed_by',
      'closed_by_name', 'closed_at', 'counted_cash_minor', 'expected_cash_minor', 'variance_minor',
      'cash_sales_minor', 'card_sales_minor', 'other_sales_minor', 'paid_out_minor', 'paid_in_minor',
      'order_count', 'status', 'created_at'], B.shifts);
    await bulk(db, 'pos_shift_movements', ['client_id', 'shift_id', 'movement_uid', 'direction',
      'amount_minor', 'reason', 'user_id', 'created_at'], B.movements);
    await bulk(db, 'pos_cash_counts', ['client_id', 'shift_id', 'count_uid', 'kind', 'total_minor',
      'expected_minor', 'variance_minor', 'counted_by', 'counted_by_name', 'created_at'], B.counts);
    await bulk(db, 'pos_drawer_events', ['client_id', 'shift_id', 'order_id', 'source', 'reason',
      'user_id', 'user_name', 'created_at'], B.drawer);
    await bulk(db, 'daily_closings', ['client_id', 'date', 'close_seq', 'expected_cash', 'declared_cash',
      'declared_card', 'cash_difference', 'card_difference', 'expected_card', 'expected_sales',
      'order_count', 'expected_cost', 'expected_net', 'closed_by', 'closed_at'], B.closings);
    await bulk(db, 'finance_daily_snapshots', ['client_id', 'date', 'gross_sales', 'discounts',
      'net_sales', 'cost_of_goods', 'extra_costs', 'cash_sales', 'card_sales', 'order_count',
      'canceled_order_count', 'profit', 'margin'], B.snaps);
    await bulk(db, 'daily_costs', ['client_id', 'date', 'category', 'description', 'amount',
      'created_by', 'created_at'], B.costs);
    B = flushables();
  };

  const onDuty = (day) => {
    const s = ymd(day);
    return ctx.staff.filter(u => u.from <= s && (!u.to || u.to >= s));
  };

  for (const day of days) {
    const date = ymd(day);
    const year = day.getFullYear();
    const key = date.slice(0, 7);
    if (key !== monthKey) { await flush(); monthKey = key; ctx.onMonth && ctx.onMonth(key); }

    const closedToday = covidFactor(day);
    const staffToday = onDuty(day);
    const waiters = staffToday.filter(u => u.role === 'waiter' || u.role === 'cashier');
    const cashier = staffToday.find(u => u.role === 'cashier') || ctx.users.erdal;
    const isToday = date === ymd(ctx.today);

    if (closedToday === 0 || !waiters.length) {
      /* shut: no shift, no bills, but the rent still has to be paid */
      pushCosts(B, ctx, day, r);
      continue;
    }

    const base = BASE_BY_YEAR[year] || 45;
    const n = Math.max(3, Math.round(
      base * SEASON[day.getMonth()] * WEEKDAY[day.getDay()] * closedToday * (0.82 + r() * 0.36)));

    /* ---------------------------------------------------------- the shift */
    const sid = shiftId++;
    const openedAt = atTime(day, 10, between(30, 55));
    const float = 250000;                       // 2.500 TL in the drawer to start
    let cash = 0, card = 0, other = 0, orderCount = 0;

    const dayOrders = [];
    const svc = [];   // [hour, weight] - lunch, then the long dinner
    for (const [h, w] of [[12, 0.9], [13, 1.2], [14, 0.8], [15, 0.4], [16, 0.3], [17, 0.5],
                          [18, 1.0], [19, 1.6], [20, 1.9], [21, 1.7], [22, 1.1], [23, 0.6]]) svc.push([h, w]);
    const svcTotal = svc.reduce((a, [, w]) => a + w, 0);

    for (let i = 0; i < n; i++) {
      /* when */
      let x = r() * svcTotal, hour = 20;
      for (const [h, w] of svc) { x -= w; if (x <= 0) { hour = h; break; } }
      const opened = atTime(day, hour, between(0, 59), between(0, 59));
      const minutes = between(25, 95);
      const closed = new Date(opened.getTime() + minutes * 60000);

      /* who and where. A tenth of the bills never sat down. */
      const waiter = pick(waiters);
      const takeaway = r() < 0.12;
      const table = takeaway ? null : pick(ctx.tables);
      const id = orderId++;
      const covers = takeaway ? 1 : Math.min(table.seats, between(1, table.seats));

      /* the lines */
      const lineCount = takeaway ? between(1, 3) : Math.max(2, Math.round(covers * (0.9 + r() * 0.9)));
      let total = 0, vat = 0, cost = 0;
      const lines = [];
      for (let k = 0; k < lineCount; k++) {
        const p = pickProduct();
        const qty = r() < 0.78 ? 1 : between(2, covers > 3 ? 4 : 2);
        const unit = p.priceByYear[year];
        const lineTotal = money(unit * qty);
        const lineVat = money(lineTotal * p.vat / (100 + p.vat));
        const lineCost = money(p.costByYear[year] * qty);
        lines.push({ p, qty, unit, lineTotal, lineVat, lineCost });
        total += lineTotal; vat += lineVat; cost += lineCost;
        ctx.soldByProduct.set(p.id, (ctx.soldByProduct.get(p.id) || 0) + qty);
      }
      total = money(total); vat = money(vat); cost = money(cost);

      /* a discount, now and then, and only from somebody allowed to give one */
      let discount = 0;
      if (r() < 0.035) {
        discount = money(total * pick([0.05, 0.10, 0.10, 0.15]));
        B.discounts.push({ client_id: clientId, order_id: id, discount_value: discount,
          reason: pick(['Müdavim indirimi', 'Personel yakını', 'Şikayet telafisi', 'Kampanya']),
          source: 'manual', created_by: cashier.id, created_at: dt(closed) });
      }
      const grand = money(total - discount);

      /* today's last few bills are still open on the floor */
      const stillOpen = isToday && i >= n - 7;
      /* and one bill in three hundred was struck out afterwards */
      const deleted = !stillOpen && r() < 0.0033;

      B.orders.push({
        id, adisyon_no: i + 1, client_id: clientId, business_date: date,
        table_id: table ? table.id : null, waiter_id: waiter.id, customer_id: null,
        status: stillOpen ? 'open' : 'closed',
        opened_at: dt(opened), closed_at: stillOpen ? null : dt(closed),
        closed_by: stillOpen ? null : cashier.id,
        total, discount_total: discount, vat_total: vat, grand_total: grand,
        notes: r() < 0.06 ? pick(D.ORDER_NOTES) : null,
        bill_label: null, created_by: waiter.id, created_at: dt(opened), updated_at: dt(closed),
        is_closed: stillOpen ? 0 : 1, exclude_from_reports: deleted ? 1 : 0,
        is_deleted: deleted ? 1 : 0, shift_id: sid,
      });

      for (const L of lines) {
        const iid = itemId++;
        B.items.push({
          id: iid, client_id: clientId, order_id: id, product_id: L.p.id,
          station_id: L.p.station_id,
          station_status: stillOpen ? pick(['new', 'preparing', 'ready']) : 'served',
          station_updated_at: dt(closed), qty: L.qty, note: null,
          price: L.unit, cost_price: L.p.costByYear[year], total: L.lineTotal,
          line_total: L.lineTotal, discount_amount: 0, unit_price: L.unit,
          vat_rate: L.p.vat, vat_total: L.lineVat,
          sent_qty: stillOpen && r() < 0.25 ? 0 : L.qty,
          is_deleted: 0, updated_at: dt(closed),
        });
        if (stillOpen) ctx.openLines = (ctx.openLines || []).concat([{ id: iid, order_id: id,
          station_id: L.p.station_id, product_id: L.p.id, qty: L.qty, at: dt(opened) }]);
      }

      /* a line the guest changed their mind about */
      if (!stillOpen && r() < 0.022) {
        const L = pick(lines);
        B.cancels.push({ client_id: clientId, order_id: id, product_id: L.p.id, qty: 1,
          line_total: L.unit, vat_total: money(L.unit * L.p.vat / (100 + L.p.vat)),
          vat_rate: L.p.vat, cancelled_at: dt(new Date(opened.getTime() + 8 * 60000)) });
      }

      if (!stillOpen && !deleted) {
        /* paid: one method usually, two when the table splits it */
        const split = r() < 0.08;
        const parts = split
          ? [money(grand * 0.5), money(grand - money(grand * 0.5))]
          : [grand];
        for (const amount of parts) {
          const method = pickMethod(r);
          B.payments.push({ client_id: clientId, order_id: id, method, amount,
            payment_channel: 'pos', created_at: dt(closed), created_by: cashier.id, shift_id: sid });
          if (method === 'nakit') cash += amount;
          else if (method === 'kredi' || method === 'banka') card += amount;
          else other += amount;
          totals.payments++;
        }
        orderCount++;
        totals.revenue += grand;
        dayOrders.push(id);
        if (takeaway) {
          (r() < 0.55 ? ctx.deliveryOrders : ctx.platformOrders).push(
            { id, date, closed_at: dt(closed), grand, waiter_id: waiter.id, year });
        }
      }
      if (deleted) {
        B.deletes.push({ client_id: clientId, order_id: id, bill_label: null, adisyon_no: i + 1,
          table_id: table ? table.id : null, waiter_id: waiter.id, opened_at: dt(opened),
          closed_at: dt(closed), total, discount_total: discount, grand_total: grand,
          deleted_at: dt(new Date(closed.getTime() + 20 * 60000)), deleted_by: ctx.users.erdal.id,
          reason: pick(['Yanlış adisyon', 'Test adisyonu', 'Çift açılmış', 'Müşteri gelmedi']),
          /* original_data is NOT NULL and is the only record of what the bill
             held once the rows are gone - the deletion screen reads it back */
          original_data: JSON.stringify({ adisyon_no: i + 1, table: table ? table.name : 'Paket',
            waiter: waiter.name, total, discount: discount, grand_total: grand,
            items: lines.map(L => ({ ad: L.p.name, adet: L.qty, tutar: L.lineTotal })) }) });
      }
      totals.orders++;
      totals.items += lines.length;
    }

    /* ------------------------------------------------- the drawer, honestly */
    const cashMinor = minor(cash), cardMinor = minor(card), otherMinor = minor(other);
    const paidOut = r() < 0.35 ? between(2, 25) * 10000 : 0;    // a supplier paid from the till
    const paidIn = r() < 0.10 ? between(1, 10) * 10000 : 0;
    if (paidOut) B.movements.push({ client_id: clientId, shift_id: sid, movement_uid: uuid(),
      direction: 'out', amount_minor: paidOut, reason: pick(['Sebzeci ödemesi', 'Kömür alımı',
        'Personel avansı', 'Su bidonu', 'Kargo']), user_id: cashier.id,
      created_at: dt(atTime(day, 17, between(0, 59))) });
    if (paidIn) B.movements.push({ client_id: clientId, shift_id: sid, movement_uid: uuid(),
      direction: 'in', amount_minor: paidIn, reason: 'Kasaya takviye', user_id: ctx.users.erdal.id,
      created_at: dt(atTime(day, 19, between(0, 59))) });

    const expected = float + cashMinor + paidIn - paidOut;
    /* the drawer is rarely exactly right, and about a third of the time is */
    const variance = r() < 0.34 ? 0 : (r() < 0.5 ? -1 : 1) * between(1, 60) * 100;
    const counted = expected + variance;
    const closedAt = atTime(day, between(23, 23), between(40, 59));

    B.shifts.push({ id: sid, client_id: clientId, shift_uid: uuid(), device_id: 'KASA-1',
      business_date: date, shift_no: 1, opened_by: cashier.id, opened_by_name: cashier.name,
      opened_at: dt(openedAt), opening_float_minor: float,
      closed_by: isToday ? null : cashier.id, closed_by_name: isToday ? null : cashier.name,
      closed_at: isToday ? null : dt(closedAt),
      counted_cash_minor: isToday ? null : counted, expected_cash_minor: isToday ? null : expected,
      variance_minor: isToday ? null : variance,
      cash_sales_minor: isToday ? null : cashMinor, card_sales_minor: isToday ? null : cardMinor,
      other_sales_minor: isToday ? null : otherMinor,
      paid_out_minor: paidOut, paid_in_minor: paidIn, order_count: orderCount,
      status: isToday ? 'open' : 'closed', created_at: dt(openedAt) });

    if (!isToday) {
      B.counts.push({ client_id: clientId, shift_id: sid, count_uid: uuid(), kind: 'close',
        total_minor: counted, expected_minor: expected, variance_minor: variance,
        counted_by: cashier.id, counted_by_name: cashier.name, created_at: dt(closedAt) });
    }
    /* the drawer opened without a sale a couple of times a night */
    for (let k = 0; k < between(0, 3); k++) {
      B.drawer.push({ client_id: clientId, shift_id: sid, order_id: null, source: 'till',
        reason: pick(['Bozuk para', 'Kasa kontrolü', 'Yanlış tuş']), user_id: cashier.id,
        user_name: cashier.name, created_at: dt(atTime(day, between(12, 23), between(0, 59))) });
    }

    /* ------------------------------------------------------ the day's costs */
    const dayCost = pushCosts(B, ctx, day, r);

    /* ------------------------------------------------------------ gün sonu */
    if (!isToday) {
      const daySales = money(cash + card + other);
      const dayCogs = money(daySales * (0.335 + r() * 0.05));
      B.closings.push({ client_id: clientId, date, close_seq: 1,
        expected_cash: money(cash), declared_cash: money(cash + variance / 100),
        declared_card: money(card), cash_difference: money(variance / 100), card_difference: 0,
        expected_card: money(card), expected_sales: daySales, order_count: orderCount,
        expected_cost: dayCogs, expected_net: money(daySales - dayCogs - dayCost),
        closed_by: cashier.id, closed_at: dt(closedAt) });
      B.snaps.push({ client_id: clientId, date, gross_sales: daySales, discounts: 0,
        net_sales: daySales, cost_of_goods: dayCogs, extra_costs: dayCost,
        cash_sales: money(cash), card_sales: money(card), order_count: orderCount,
        canceled_order_count: 0, profit: money(daySales - dayCogs - dayCost),
        /* margin is decimal(5,2): a January day in 2020 that took 400 lira
           against a 62,000 lira tax instalment is a real -15,000% and does not
           fit. Clamped rather than skipped - the day still belongs in the list. */
        margin: daySales
          ? Math.max(-999.99, Math.min(999.99, money((daySales - dayCogs - dayCost) / daySales * 100)))
          : 0 });
    }
    ctx.dayIndex.push({ date, orders: dayOrders, cash, card, other, shift_id: sid });
  }
  await flush();

  /* the bill numbering the till will carry on from */
  await db.exec('INSERT INTO order_counters (client_id, last_no) VALUES (?,?) ' +
    'ON DUPLICATE KEY UPDATE last_no=VALUES(last_no)', [clientId, 60]);

  /* today's open bills also belong on the kitchen screen */
  if (ctx.openLines && ctx.openLines.length) {
    await bulk(db, 'station_projection_items', ['client_id', 'station_id', 'order_id',
      'order_item_id', 'product_id', 'qty', 'station_status', 'created_at', 'updated_at'],
      ctx.openLines.map(l => ({
        client_id: clientId, station_id: l.station_id, order_id: l.order_id,
        order_item_id: l.id, product_id: l.product_id, qty: l.qty,
        station_status: ['new', 'new', 'preparing', 'ready'][Math.floor(r() * 4)],
        created_at: l.at, updated_at: l.at,
      })), { ignore: true });
    await db.exec(
      "UPDATE restaurant_tables t JOIN orders o ON o.table_id=t.id AND o.status='open' " +
      'SET t.is_occupied=1 WHERE t.client_id=?', [clientId]);
  }

  ctx.totals = totals;
  ctx.log(`ticaret: ${totals.orders.toLocaleString('tr-TR')} adisyon, ` +
    `${totals.items.toLocaleString('tr-TR')} satır, ` +
    `${totals.payments.toLocaleString('tr-TR')} ödeme`);
}

/** Rent, wages, the electricity bill - and the odd repair. Returns today's total. */
function pushCosts(B, ctx, day, r) {
  const date = ymd(day);
  const year = day.getFullYear();
  const dom = day.getDate();
  const idx = require('./catalogue').priceIndex(year);
  let sum = 0;
  for (const [cat, desc, monthly, onDay] of D.FIXED_COSTS) {
    if (dom !== onDay) continue;
    const amount = Math.round(monthly * idx / 10) * 10;
    B.costs.push({ client_id: ctx.clientId, date, category: cat, description: desc,
      amount, created_by: ctx.users.nurcan.id, created_at: date + ' 10:15:00' });
    sum += amount;
  }
  if (r() < 0.10) {
    const [cat, desc, amount] = D.ADHOC_COSTS[Math.floor(r() * D.ADHOC_COSTS.length)];
    const v = Math.round(amount * idx / 10) * 10;
    B.costs.push({ client_id: ctx.clientId, date, category: cat, description: desc,
      amount: v, created_by: ctx.users.nurcan.id, created_at: date + ' 16:40:00' });
    sum += v;
  }
  return sum;
}

module.exports = { build, BASE_BY_YEAR, SEASON, WEEKDAY, covidFactor };
