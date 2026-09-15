'use strict';
/**
 * MATEMATIK - the arithmetic of the till, proved to the kurus.
 *
 * Everything here runs against a real MariaDB through the real modules. No
 * mocks: the bugs this suite exists to catch all lived in the seam between the
 * JavaScript and the database - a trigger that computed KDV from the price
 * before the discount, a roll-up that summed cancelled lines back in, a line
 * discount that was written into the line AND into the bill's discount ledger
 * and so came off twice.
 *
 * The rules being checked, in the order a restaurant meets them:
 *
 *   1  KDV is INCLUSIVE. vat = gross * rate / (100 + rate), matrah = gross-vat.
 *   2  Money is decimal and rounds once. Every assertion is kurus-exact.
 *   3  A line is qty * unit_price - discount_amount, and qty can be a half.
 *   4  A bill is the sum of its lines minus the bill discount, and the four
 *      header columns must agree with the lines.
 *   5  The KDV breakdown sums to vat_total, and matrah + KDV = gross per rate.
 *   6  Payments sum to the bill. Change is tendered - due.
 *   7  The Z report adds up to itself.
 *   8  Profit = net excluding KDV - cost. The tax comes out first.
 *   9  A deleted bill contributes nothing.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/matematik.js
 */
const assert = require('assert');
const db = require('../src/db');
const { money, minor } = require('../src/util/http');
const kdv = require('../src/util/vat');

const CID = 19;
const UID = 0;

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

/** Two figures are the same figure when they agree to the kurus. */
const eq = (a, b, what) => assert.strictEqual(money(a), money(b), `${what}: ${money(a)} != ${money(b)}`);

let orders, payments, reports, pnl, doc, bd;
let P = {}, TABLE = null, DAY = null;

/* -------------------------------------------------------------- fixture */
/**
 * A menu whose arithmetic can be checked by hand, and an empty day to sell it
 * in. The suites share one database, so this tenant's trade is cleared out -
 * a day another suite closed refuses every new bill, and its bills would
 * otherwise turn up in this one's Z report.
 */
async function fixture() {
  for (const sql of [
    'DELETE FROM loyalty_events WHERE client_id=?',
    'DELETE FROM order_discounts WHERE client_id=?',
    'DELETE FROM order_item_cancel_events WHERE client_id=?',
    'DELETE FROM order_delete_logs WHERE client_id=?',
    'DELETE FROM payment_delete_logs WHERE client_id=?',
    'DELETE FROM order_payments WHERE client_id=?',
    'DELETE FROM station_projection_items WHERE client_id=?',
    'DELETE FROM order_items WHERE client_id=?',
    'DELETE FROM orders WHERE client_id=?',
    'DELETE FROM daily_costs WHERE client_id=?',
    'DELETE FROM daily_closings WHERE client_id=?',
    'DELETE FROM finance_daily_snapshots WHERE client_id=?',
    'DELETE FROM pos_shifts WHERE client_id=?',
  ]) await db.exec(sql, [CID]).catch(() => {});

  const CAT = 'Matematik';
  let cat = await db.one('SELECT id FROM categories WHERE client_id=? AND name=?', [CID, CAT]);
  if (!cat) {
    cat = { id: await db.insert(
      'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,97,1,1,1)',
      [CID, CAT]) };
  }
  /* Products survive the fixture on purpose: the bills that referenced them are
     gone, the menu row is not, and re-inserting it trips the unique name. */
  const mk = async (name, price, cost, vat) => {
    const row = await db.one('SELECT id FROM products WHERE client_id=? AND name=?', [CID, name]);
    if (row) {
      await db.exec('UPDATE products SET price=?, cost_price=?, vat_rate=?, is_active=1, track_stock=0 WHERE id=?',
        [price, cost, vat, row.id]);
      return row.id;
    }
    return db.insert(
      `INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,sort_order,
          is_active,use_in_pos,use_in_qr,track_stock) VALUES (?,?,?,?,?,?,0,1,1,1,0)`,
      [CID, cat.id, name, price, cost, vat]);
  };
  P = {
    ekmek: await mk('Mat Ekmek', 15, 4, 1),        // %1  - the reduced staple rate
    kebap: await mk('Mat Kebap', 420, 160, 10),    // %10 - food
    bira: await mk('Mat Bira', 180, 70, 20),       // %20 - alcohol
    // 17,77 at %10 is 1,6154... - the division does NOT come out even, which is
    // where a "round once at the end" engine stops agreeing with itself
    tuhaf: await mk('Mat Tuhaf Fiyat', 17.77, 5, 10),
  };

  const NAME = 'Matematik Masasi';
  let table = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? AND name=?', [CID, NAME]);
  if (!table) {
    let zone = await db.one('SELECT id FROM table_zones WHERE client_id=? LIMIT 1', [CID]);
    const zoneId = zone ? zone.id : await db.insert(
      'INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']);
    table = { id: await db.insert(
      'INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active) VALUES (?,?,?,97,1)',
      [CID, zoneId, NAME]) };
  }
  TABLE = table.id;
  DAY = await bd.currentBusinessDate();
}

/** Open a bill and ring up `lines` of [productId, qty]. Returns the order id. */
async function ring(lines, opts = {}) {
  const id = await orders.openOrder(CID, { tableId: opts.table === null ? null : TABLE, userId: UID });
  for (const [product, qty] of lines) await orders.addItem(CID, id, { productId: product, qty, userId: UID });
  return id;
}

const head = (id) => db.one('SELECT * FROM orders WHERE id=? AND client_id=?', [id, CID]);
const liveLines = (id) => db.query(
  'SELECT * FROM order_items WHERE order_id=? AND client_id=? AND is_deleted=0 ORDER BY id', [id, CID]);
const paidOn = async (id) => money(await db.value(
  `SELECT COALESCE(SUM(amount),0) FROM order_payments
    WHERE order_id=? AND client_id=? AND is_deleted=0 AND voided_at IS NULL`, [id, CID]));

/**
 * Settle whatever is still open, the way a day-end demands.
 *
 * The Z report's sales figure is every bill on the books; its payment figure is
 * what was collected. Those two can only be equal once nothing is still on a
 * table - which is exactly why closeDay refuses while a bill is open - so the
 * checks below put the day into that state rather than pretending it is.
 */
async function settleEverything() {
  const open = await db.query(
    "SELECT id, grand_total FROM orders WHERE client_id=? AND status='open' AND is_deleted=0", [CID]);
  for (const o of open) {
    const due = money(Number(o.grand_total) - await paidOn(o.id));
    if (due > 0) await payments.addPayment(CID, o.id, { method: 'nakit', amount: due, userId: UID });
    else await db.exec("UPDATE orders SET status='closed', is_closed=1, closed_at=NOW() WHERE id=?", [o.id]);
  }
}

/** The four header columns, checked against the lines they are a cache of. */
async function headerAgreesWithLines(id, what) {
  const o = await head(id);
  const lines = await liveLines(id);
  const sum = money(lines.reduce((s, l) => s + Number(l.line_total), 0));
  eq(o.total, sum, `${what}: orders.total vs sum of line_total`);
  eq(o.grand_total, money(Number(o.total) - Number(o.discount_total)),
    `${what}: grand_total vs total - discount_total`);
  const v = kdv.billVat(lines, o.discount_total);
  eq(o.vat_total, v.vatTotal, `${what}: orders.vat_total vs the KDV in the lines`);
  return { o, lines, v };
}

(async () => {
  await db.init();
  db.setClientId(CID);
  bd = require('../src/util/businessDay');
  orders = require('../src/modules/orders');
  payments = require('../src/modules/payments');
  reports = require('../src/modules/reports');
  pnl = require('../src/modules/pnl');
  doc = require('../src/print/document');

  await fixture();
  console.log('\nNOKTApp POS - matematik\n');

  /* ===================================================== 1. KDV dahil === */
  await step('KDV is taken out of the price at %1, %10 and %20, never added on top', async () => {
    // the price on the menu already contains the tax, so the bill total is the
    // price - the number the guest reads off the board is the number they pay
    // quantities chosen so the inclusive answer and the on-top one differ by
    // more than a kurus - at %1 on a single 15 TL loaf they round to the same
    // figure, and a check that can pass by coincidence proves nothing
    const cases = [
      [P.ekmek, 10, 150, 1, 1.49],    // 150 * 1/101   = 1,4851  -> 1,49  (on top: 1,50)
      [P.kebap, 1, 420, 10, 38.18],   // 420 * 10/110  = 38,1818 -> 38,18 (on top: 42,00)
      [P.bira, 1, 180, 20, 30.00],    // 180 * 20/120  = 30,00 exactly    (on top: 36,00)
    ];
    for (const [product, qty, gross, rate, vat] of cases) {
      const id = await ring([[product, qty]]);
      const o = await head(id);
      eq(o.grand_total, gross, `%${rate} bill total must be the shelf price`);
      eq(o.vat_total, vat, `%${rate} KDV`);
      eq(money(Number(o.grand_total) - Number(o.vat_total)), money(gross - vat), `%${rate} matrah`);
      // the wrong sum, spelled out, so a regression cannot hide behind rounding
      assert.notStrictEqual(money(o.vat_total), money(gross * rate / 100),
        `%${rate}: KDV was added on top instead of taken out`);
    }
  });

  await step('a price whose KDV does not divide evenly still adds up exactly', async () => {
    // 17,77 at %10: the tax is 1,61545..., so matrah + KDV can only come back to
    // 17,77 if the rounding happens once, on the tax, and the matrah is the rest
    const id = await ring([[P.tuhaf, 3]]);       // 53,31 gross
    const o = await head(id);
    eq(o.grand_total, 53.31, 'gross');
    eq(o.vat_total, 4.85, 'KDV on 53,31 at %10 is 4,8463 -> 4,85');
    eq(money(Number(o.grand_total) - Number(o.vat_total)), 48.46, 'matrah');
    eq(money(48.46 + 4.85), 53.31, 'matrah + KDV must be the gross again');
  });

  /* ================================================== 3. yarim porsiyon = */
  await step('a half portion is charged as a half, not rounded to a whole one', async () => {
    const id = await ring([[P.kebap, 0.5]]);
    const [l] = await liveLines(id);
    eq(l.qty, 0.5, 'qty');
    eq(l.line_total, 210, 'half of 420');
    const o = await head(id);
    eq(o.grand_total, 210, 'bill total');
    eq(o.vat_total, 19.09, 'KDV on 210 at %10 is 19,0909 -> 19,09');
  });

  await step('a quantity finer than a half snaps to one rather than being priced', async () => {
    const id = await ring([[P.kebap, 0.33]]);
    const [l] = await liveLines(id);
    eq(l.qty, 0.5, 'a third of a portion nobody can plate becomes a half');
    eq(l.line_total, 210, 'and is charged as one');
  });

  /* ================================= 3 + 4. indirimler, ayni adisyonda == */
  let BILL = null;
  await step('a line discount comes off ONCE, not once in the line and again on the bill', async () => {
    /*
     * The bug this exists for: the line discount was subtracted inside
     * line_total AND written to order_discounts, which recalc reads as the
     * bill-level discount. A 40 TL discount made the guest 80 TL better off.
     */
    BILL = await ring([[P.kebap, 2], [P.bira, 1]]);
    const lines = await liveLines(BILL);
    await orders.updateItem(CID, BILL, lines[0].id, { discountAmount: 40, reason: 'Yanmis', userId: UID });
    const o = await head(BILL);
    eq(o.total, 980, '2*420 - 40 + 180');
    eq(o.discount_total, 0, 'a line discount is not a bill discount');
    eq(o.grand_total, 980, 'the guest owes 980, not 940');
    await headerAgreesWithLines(BILL, 'line discount');
  });

  await step('a bill percentage discount lands on top of the line discount', async () => {
    const grand = await orders.setBillDiscount(CID, BILL, { percent: 10, reason: 'Sadik musteri', userId: UID });
    eq(grand, 882, '980 less 10%');
    const { o } = await headerAgreesWithLines(BILL, 'both discounts');
    eq(o.total, 980, 'total is still the lines');
    eq(o.discount_total, 98, 'the bill-level discount alone');
    eq(o.grand_total, 882, 'total - discount');
    // and the line discount is still on record, just not charged twice
    const rec = await db.query(
      "SELECT source, discount_value FROM order_discounts WHERE order_id=? AND client_id=? ORDER BY id", [BILL, CID]);
    assert.strictEqual(rec.filter(r => r.source === 'line').length, 1, 'the line discount lost its audit row');
    assert.strictEqual(rec.filter(r => r.source === 'manual').length, 1, 'the bill discount lost its ledger row');
  });

  await step('changing an item afterwards does not lose the bill discount', async () => {
    // recalc reads the ledger every time rather than trusting the column, so a
    // later item change cannot quietly hand a redeemed discount back
    const lines = await liveLines(BILL);
    await orders.updateItem(CID, BILL, lines[1].id, { qty: 1, userId: UID });
    const { o } = await headerAgreesWithLines(BILL, 'after an item change');
    eq(o.discount_total, 98, 'the discount survived');
  });

  /* ======================================================= 5. KDV dokumu = */
  await step('the KDV breakdown sums exactly to vat_total, with matrah + KDV = gross per rate', async () => {
    const { o, lines } = await headerAgreesWithLines(BILL, 'breakdown');
    const v = kdv.billVat(lines, o.discount_total);
    // the 98 TL discount is spread over the lines before any tax is worked out,
    // so 800 at %10 becomes 720 and 180 at %20 becomes 162
    const ten = v.breakdown.find(b => b.rate === 10);
    const twenty = v.breakdown.find(b => b.rate === 20);
    eq(ten.gross, 720, '%10 gross after its share of the discount');
    eq(ten.vat, 65.45, '720 * 10/110');
    eq(ten.base, 654.55, 'matrah');
    eq(twenty.gross, 162, '%20 gross after its share of the discount');
    eq(twenty.vat, 27, '162 * 20/120');
    eq(twenty.base, 135, 'matrah');
    for (const b of v.breakdown) eq(money(b.base + b.vat), b.gross, `%${b.rate}: matrah + KDV`);
    eq(v.breakdown.reduce((s, b) => s + b.vat, 0), o.vat_total, 'the breakdown vs the header');
    eq(v.breakdown.reduce((s, b) => s + b.gross, 0), o.grand_total, 'the breakdown vs what is owed');
    // to the kurus, not to a tolerance - a rounded-once-at-the-end engine
    // fails this and a per-line one does not
    assert.strictEqual(minor(o.vat_total), minor(ten.vat) + minor(twenty.vat), 'off by a kurus');
  });

  await step('the printed bill shows the same KDV the header stores', async () => {
    const o = await orders.getOrder(CID, BILL);
    const d = await doc.billDocument(CID, o);
    eq(d.totals.subtotal, 980, 'Ara Toplam');
    eq(d.totals.discount, 98, 'Indirim');
    eq(d.totals.grand, 882, 'Genel Toplam');
    eq(d.totals.vatTotal, Number(o.vat_total), 'the paper and the database must not disagree');
    eq(d.vat.reduce((s, v) => s + v.vat, 0), d.totals.vatTotal, 'the printed rows vs the printed total');
    eq(d.vat.reduce((s, v) => s + v.base + v.vat, 0), d.totals.grand, 'matrah + KDV vs the total owed');
  });

  /* ========================================================= 6. odemeler = */
  await step('a split payment of cash and card leaves the bill owing exactly nothing', async () => {
    const first = await payments.addPayment(CID, BILL, { method: 'nakit', amount: 400, userId: UID });
    assert.strictEqual(first.closed, false, '400 of 882 must not close the bill');
    eq(first.due_before, 882, 'due before the first payment');
    eq(first.change, 0, 'no change on a partial payment');
    const rest = await payments.addPayment(CID, BILL, { method: 'kredi_karti', amount: 482, userId: UID });
    assert.strictEqual(rest.closed, true, 'the bill did not close on the exact balance');
    const o = await orders.getOrder(CID, BILL);
    eq(o.paid, 882, 'payments sum to the bill');
    assert.strictEqual(minor(o.due), 0, 'due must be exactly zero, not nearly');
    eq(await paidOn(BILL), o.grand_total, 'the ledger vs the header');
  });

  await step('a payment bigger than the bill gives change and banks only what is owed', async () => {
    /*
     * The 20 TL para ustu goes back across the counter, so it was never in the
     * drawer. Storing the whole 200 made the day's takings, the Z report and
     * the shift's expected cash each over by the change that had been handed
     * back - the classic reason a till "reads" more than it holds.
     */
    const id = await ring([[P.bira, 1]]);
    const r = await payments.addPayment(CID, id, { method: 'nakit', amount: 200, userId: UID });
    eq(r.due_before, 180, 'due');
    eq(r.tendered, 200, 'what the guest handed over');
    eq(r.amount, 180, 'what the bill absorbed');
    eq(r.change, 20, 'para ustu = tendered - due');
    assert.strictEqual(r.closed, true);
    eq(await paidOn(id), 180, 'the payment ledger must not exceed the bill');
    const o = await orders.getOrder(CID, id);
    assert.strictEqual(minor(o.due), 0, 'due');
  });

  await step('change is never negative and a paid bill takes no further payment', async () => {
    const id = await ring([[P.ekmek, 2]]);
    const r = await payments.addPayment(CID, id, { method: 'nakit', amount: 10, userId: UID });
    eq(r.change, 0, 'underpaying gives no change, it leaves a balance');
    eq((await orders.getOrder(CID, id)).due, 20, 'still owed');
    await payments.addPayment(CID, id, { method: 'nakit', amount: 20, userId: UID });
    await assert.rejects(
      () => payments.addPayment(CID, id, { method: 'nakit', amount: 5, userId: UID }),
      /kalmadi/, 'a settled bill accepted more money and would have over-reported the day');
  });

  /* ============================================= 3. bolme ve birlestirme = */
  await step('splitting a discounted line splits its discount with it', async () => {
    const id = await ring([[P.kebap, 2]]);
    const [l] = await liveLines(id);
    await orders.updateItem(CID, id, l.id, { discountAmount: 40, userId: UID });
    const before = money((await head(id)).grand_total);
    eq(before, 800, '2*420 - 40');
    const newId = await orders.splitBill(CID, id, [{ itemId: l.id, qty: 1 }], UID);
    const a = await head(id), b = await head(newId);
    eq(a.grand_total, 400, 'the half that stayed keeps half the discount');
    eq(b.grand_total, 400, 'the half that moved takes the other half');
    eq(money(Number(a.grand_total) + Number(b.grand_total)), before,
      'a split may move money between bills, never create or destroy it');
    await headerAgreesWithLines(id, 'split source');
    await headerAgreesWithLines(newId, 'split target');
    await payments.addPayment(CID, id, { method: 'nakit', amount: 400, userId: UID });
    await payments.addPayment(CID, newId, { method: 'nakit', amount: 400, userId: UID });
  });

  await step('merging two bills keeps the discount that was given on each', async () => {
    const a = await ring([[P.kebap, 1]]);
    const b = await ring([[P.bira, 1]]);
    await orders.setBillDiscount(CID, b, { percent: 50, userId: UID });   // 90 off the beer
    const before = money(Number((await head(a)).grand_total) + Number((await head(b)).grand_total));
    eq(before, 510, '420 + 90');
    await orders.mergeBills(CID, a, b, UID);
    const merged = await head(a), emptied = await head(b);
    eq(merged.grand_total, 510, 'the discount travelled with the lines');
    eq(merged.discount_total, 90, 'and is still recorded as a discount');
    eq(emptied.grand_total, 0, 'the emptied bill must not keep totals it no longer owns');
    await headerAgreesWithLines(a, 'merged bill');
    await payments.addPayment(CID, a, { method: 'nakit', amount: 510, userId: UID });
  });

  await step('cancelling half a discounted line leaves the other half at its discounted price', async () => {
    const id = await ring([[P.kebap, 2]]);
    const [l] = await liveLines(id);
    await orders.updateItem(CID, id, l.id, { discountAmount: 40, userId: UID });
    await orders.cancelItem(CID, id, l.id, { qty: 1, reason: 'Musteri vazgecti', userId: UID });
    const [rest] = await liveLines(id);
    eq(rest.qty, 1, 'one portion left');
    eq(rest.discount_amount, 20, 'half the discount left with the portion that went back');
    eq(rest.line_total, 400, '420 - 20');
    await headerAgreesWithLines(id, 'after a partial cancel');
    await payments.addPayment(CID, id, { method: 'nakit', amount: 400, userId: UID });
  });

  await step('a cancelled line takes its KDV off the bill with it', async () => {
    // the roll-up trigger summed soft-deleted lines back in, so a cancelled
    // kebab kept declaring its tax for the rest of the night
    const id = await ring([[P.kebap, 1], [P.bira, 1]]);
    const before = await head(id);
    eq(before.vat_total, 68.18, '38,18 + 30,00');
    const lines = await liveLines(id);
    await orders.cancelItem(CID, id, lines[1].id, { reason: 'Yanlis girildi', userId: UID });
    const after = await head(id);
    eq(after.total, 420, 'the beer is off the bill');
    eq(after.vat_total, 38.18, 'and so is its KDV');
    await headerAgreesWithLines(id, 'after a cancel');
    await payments.addPayment(CID, id, { method: 'nakit', amount: 420, userId: UID });
  });

  /* ================================================ 4. recalc is stable == */
  await step('recomputing a settled bill changes nothing', async () => {
    const before = await head(BILL);
    await db.tx(t => orders.recalc(t, CID, BILL));
    await db.tx(t => orders.recalc(t, CID, BILL));
    const after = await head(BILL);
    for (const k of ['total', 'discount_total', 'vat_total', 'grand_total']) {
      eq(after[k], before[k], `recalc is not idempotent: ${k}`);
    }
  });

  await step('the cost of a sold line is the one frozen on it, not today\'s', async () => {
    const id = await ring([[P.kebap, 2]]);
    const [l] = await liveLines(id);
    eq(l.cost_price, 160, 'the cost was copied onto the line when it was rung up');
    await db.exec('UPDATE products SET cost_price=999 WHERE id=? AND client_id=?', [P.kebap, CID]);
    const [again] = await liveLines(id);
    eq(again.cost_price, 160, 'a supplier raising his price restated a sale that already happened');
    await db.exec('UPDATE products SET cost_price=160 WHERE id=? AND client_id=?', [P.kebap, CID]);
    await payments.addPayment(CID, id, { method: 'nakit', amount: 840, userId: UID });
  });

  /* ======================================== 9. kapat / geri al / kapat === */
  await step('a bill closed, reopened and closed again does not double any figure', async () => {
    const id = await ring([[P.kebap, 1], [P.ekmek, 2]]);   // 420 + 30
    const opened = await head(id);
    await payments.addPayment(CID, id, { method: 'nakit', amount: 450, userId: UID });
    const closed = await head(id);
    assert.strictEqual(closed.status, 'closed');

    await orders.reopen(CID, id, { userId: UID, userName: 'Test', reason: 'Yanlislikla kapatildi' });
    const reopened = await head(id);
    assert.strictEqual(reopened.status, 'open');
    eq(reopened.grand_total, opened.grand_total, 'reopening changed the total');

    // re-closed through the same funnel every payment path uses, with the money
    // that is already on the bill - nothing new is taken
    await db.tx(t => orders.closeIfPaid(t, CID, id, UID));
    const again = await head(id);
    assert.strictEqual(again.status, 'closed', 'the bill did not close a second time');
    for (const k of ['total', 'discount_total', 'vat_total', 'grand_total']) {
      eq(again[k], closed[k], `${k} moved on the second close`);
    }
    eq(await paidOn(id), 450, 'the payment was counted twice');
    assert.strictEqual(Number(await db.value(
      'SELECT COUNT(*) FROM order_payments WHERE order_id=? AND client_id=?', [id, CID])), 1,
      'a second payment row appeared from nowhere');
    eq(Number(again.grand_total) - Number(await paidOn(id)), 0, 'due after the re-close');
  });

  /* ============================================ 7 + 9. Z raporu, gun sonu */
  let Z = null;
  await step('the Z report adds up to itself over a day with a discount and a deleted bill', async () => {
    // one more bill to delete, so the day has a bill that must contribute nothing
    const doomed = await ring([[P.kebap, 3]]);
    await payments.addPayment(CID, doomed, { method: 'kredi_karti', amount: 1260, userId: UID });
    await orders.deleteBill(CID, doomed, { userId: UID, reason: 'Yanlis adisyon', approvedBy: UID });
    await settleEverything();

    await db.insert(
      'INSERT INTO daily_costs (client_id,date,category,description,amount,created_by) VALUES (?,?,?,?,?,?)',
      [CID, DAY, 'Personel', 'Matematik testi', 250, UID]);

    Z = await reports.zReport(CID, DAY);

    eq(Z.net, money(Z.gross - Z.discount), 'net = brut - indirim');
    eq(Z.vat_breakdown.reduce((s, v) => s + v.vat, 0), Z.vat_total, 'the KDV breakdown vs the header');
    eq(Z.vat_breakdown.reduce((s, v) => s + v.gross, 0), Z.net, 'the KDV breakdown vs net sales');
    for (const v of Z.vat_breakdown) eq(money(v.base + v.vat), v.gross, `%${v.rate}: matrah + KDV`);
    eq(Z.payments.reduce((s, p) => s + p.total, 0), Z.net, 'what was collected vs what was sold');
    eq(Z.net_ex_vat, money(Z.net - Z.vat_total), 'net excluding KDV');
  });

  await step('the deleted bill is in none of the day\'s figures', async () => {
    assert.strictEqual(Z.deleted_bills.count, 1, 'the deletion was not recorded');
    eq(Z.deleted_bills.total, 1260, 'and its value was not recorded');
    // 1260 was rung up and paid by card, and appears in neither the sales nor
    // the payments - the two places the old engine kept it
    assert.ok(!Z.payments.some(p => minor(p.total) === minor(1260)),
      'the deleted bill is still in the payment breakdown');
    const withIt = money(Z.net + 1260);
    assert.notStrictEqual(minor(Z.net), minor(withIt));
    eq(Z.payments.reduce((s, p) => s + p.total, 0), Z.net,
      'payments and sales agree, which they cannot if only one of them dropped it');
  });

  /* ============================================================ 8. kar === */
  await step('profit is net excluding KDV minus cost, with the KDV proven to be out', async () => {
    const cogs = money(await db.value(
      `SELECT COALESCE(SUM(i.qty*i.cost_price),0) FROM order_items i JOIN orders o ON o.id=i.order_id
        WHERE i.client_id=? AND o.business_date=? AND i.is_deleted=0
          AND o.is_deleted=0 AND COALESCE(o.exclude_from_reports,0)=0`, [CID, DAY]));
    eq(Z.cost_of_goods, cogs, 'cost of goods');
    eq(Z.extra_costs, 250, 'the day\'s other costs');
    eq(Z.profit, money(Z.net - Z.vat_total - Z.cost_of_goods - Z.extra_costs), 'the definition');
    // the KDV is genuinely out: the old figure left it in and was higher by
    // exactly the tax, which is the amount of profit a restaurant never had
    const legacy = money(Z.net - Z.cost_of_goods - Z.extra_costs);
    eq(money(legacy - Z.profit), Z.vat_total, 'profit still contains the KDV');
    assert.ok(Z.vat_total > 0 && legacy > Z.profit, 'the day had no tax to prove anything with');
  });

  await step('the P&L and the Z report tell the same story about the same day', async () => {
    const { totals: T } = await pnl.profitAndLoss(CID, DAY, DAY);
    eq(T.revenue_net, money(T.revenue_gross - T.vat), 'ciro haric = ciro dahil - KDV');
    eq(T.gross_profit, money(T.revenue_net - T.cogs), 'brut kar');
    eq(T.net_profit, money(T.gross_profit - T.expenses), 'net kar');
    // the old, VAT-inclusive figure is reported alongside for reconciliation and
    // must be higher by exactly the tax
    eq(money(T.legacy_profit - T.net_profit), T.vat, 'legacy profit vs the real one');
    // the P&L counts closed bills only, so it can be smaller than the Z report,
    // never larger, and every closed bill's KDV is the same KDV
    assert.ok(minor(T.revenue_gross) <= minor(Z.net), 'the P&L reports more revenue than the day had');
  });

  await step('a day with no trade reports zeros rather than dividing by them', async () => {
    const empty = await reports.zReport(CID, '2001-01-01');
    for (const k of ['gross', 'discount', 'net', 'vat_total', 'cost_of_goods', 'profit', 'margin']) {
      assert.strictEqual(money(empty[k]), 0, `${k} on an empty day is ${empty[k]}`);
    }
    assert.deepStrictEqual(empty.vat_breakdown, []);
  });

  /* ================================================ 2. the money helpers = */
  await step('the discount allocation gives away every kurus and never more', async () => {
    /*
     * The spread has to be exact or the KDV breakdown cannot equal the header.
     * A third of a kurus is the case that catches a "round each share" engine:
     * three equal lines and 0,01 to divide between them.
     */
    const three = [{ lineTotal: 10, vatRate: 10 }, { lineTotal: 10, vatRate: 10 }, { lineTotal: 10, vatRate: 10 }];
    const v = kdv.billVat(three, 0.01);
    eq(v.grand, 29.99, 'the discount was given away twice or not at all');
    eq(v.breakdown.reduce((s, b) => s + b.gross, 0), 29.99, 'the rates do not sum to the bill');
    // 1 kurus over three equal lines: somebody has to get it, and only one
    assert.deepStrictEqual(kdv.allocate(1, [1000, 1000, 1000]), [1, 0, 0]);
    assert.strictEqual(kdv.allocate(100, [50, 30, 20]).reduce((a, b) => a + b, 0), 100,
      'the allocation lost a kurus');
    assert.strictEqual(kdv.allocate(0, [5, 5]).reduce((a, b) => a + b, 0), 0, 'nothing to give away');
    assert.strictEqual(kdv.allocate(500, [0, 0]).reduce((a, b) => a + b, 0), 0, 'nothing to give it to');
    assert.strictEqual(kdv.allocate(500, [10, 10]).reduce((a, b) => a + b, 0), 20,
      'more was given away than the lines could hold');
    // a discount bigger than the bill cannot take the bill below zero
    eq(kdv.billVat([{ lineTotal: 50, vatRate: 20 }], 90).grand, 0, 'the bill went negative');
  });

  await step('money() rounds once and the same way everywhere', async () => {
    eq(money(0.1 + 0.2), 0.3, 'float noise reached a stored figure');
    assert.strictEqual(minor(money(money(17.775))), minor(money(17.775)),
      'rounding a rounded figure moved it, which is double rounding');
    assert.strictEqual(kdv.vatOf(180, 20), 30);
    assert.strictEqual(kdv.vatOf(100, 0), 0, 'a %0 line has no KDV, not NaN');
  });

  /* ================================= results ============================ */
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
