'use strict';
/**
 * End-to-end smoke test against a real MariaDB.
 * Exercises the path a restaurant actually walks every day:
 *   setup -> staff -> table -> order -> kitchen -> payment -> reopen -> day close
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/smoke.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7461';
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
let TOKEN = null;
const CID = 19;

async function api(method, path, body, token = TOKEN) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - service smoke test\n');

  await step('health endpoint answers and the database is up', async () => {
    const r = await api('GET', '/api/health');
    assert.strictEqual(r.ok, true); assert.strictEqual(r.db, true);
  });

  await step('setup reports an un-configured install', async () => {
    const r = await api('GET', '/api/setup/state');
    assert.strictEqual(r.ok, true); assert.strictEqual(r.activated, true);
  });

  // a tenant token is what the online login would have produced
  TOKEN = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Test Restoran', kind: 'tenant' });

  let managerId, openBillId;
  await step('first manager is created with a PIN', async () => {
    await db.exec('DELETE FROM users WHERE client_id=?', [CID]);
    const r = await api('POST', '/api/setup/first-user',
      { display_name: 'Erik Yonetici', username: 'erik', pin: '4321', password: 'Sifre1234' });
    assert.strictEqual(r.ok, true, r.error); managerId = r.id;
  });

  await step('the owner signs in with the PIN pad and is the licence holder', async () => {
    /*
     * The setup wizard's first account is `superadmin`, not `admin`.
     *
     * The owner does not work the till on a tenant token - he taps a PIN like
     * everyone else - and deleting a bill, reopening a closed day and taking
     * money off the books are all guarded by "is this the licence holder",
     * which `admin` deliberately does not satisfy. Creating that first account
     * as `admin` therefore told the person who bought the licence that only
     * the business owner was allowed. Whoever runs the wizard IS that person.
     */
    const r = await api('POST', '/api/auth/pin', { pin: '4321' });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.user.role, 'superadmin', 'the first user is not the owner');
    assert.ok(r.perms.includes('order.create'));
    TOKEN = r.token;
  });

  await step('a wrong PIN is refused', async () => {
    const r = await api('POST', '/api/auth/pin', { pin: '0000' });
    assert.strictEqual(r.ok, undefined === r.ok ? undefined : false);
    assert.strictEqual(r.status, 401);
  });

  let _zoneId, tableId;
  await step('tables are created in bulk', async () => {
    await db.exec('DELETE FROM restaurant_tables WHERE client_id=?', [CID]);
    const r = await api('POST', '/api/setup/tables', { zone_name: 'Salon', prefix: 'Masa', from: 1, to: 6 });
    assert.strictEqual(r.ok, true, r.error); assert.strictEqual(r.tables, 6);
    const t = await db.one('SELECT id, zone_id FROM restaurant_tables WHERE client_id=? ORDER BY id LIMIT 1', [CID]);
    tableId = t.id; _zoneId = t.zone_id;
  });

  let catId, p1, p2;
  await step('menu is created (category + two products with different VAT)', async () => {
    const kitchen = await db.one("SELECT id FROM stations WHERE client_id=? AND name='Mutfak'", [CID]);
    const c = await api('POST', '/api/manage/categories', { name: 'Ana Yemek', station_id: kitchen.id, use_in_pos: 1 });
    catId = c.id;
    p1 = (await api('POST', '/api/manage/products',
      { category_id: catId, name: 'Adana Kebap', price: 320, cost_price: 140, vat_rate: 10, track_stock: 1 })).id;
    p2 = (await api('POST', '/api/manage/products',
      { category_id: catId, name: 'Ayran', price: 40, cost_price: 12, vat_rate: 20 })).id;
    assert.ok(p1 && p2);
    await api('POST', '/api/pos/stock/' + p1, { quantity: 50 });
  });

  await step('a shift is opened with a cash float', async () => {
    await db.exec("UPDATE pos_shifts SET status='closed' WHERE client_id=? AND status='open'", [CID]);
    const r = await api('POST', '/api/pos/shift/open', { opening_float: 500 });
    assert.strictEqual(r.ok, true, r.error);
  });

  let orderId;
  await step('a bill is opened on a table', async () => {
    const _r = await api('POST', '/api/pos', undefined); // wrong path on purpose -> 404
    const r2 = await api('POST', '/api/pos/orders', { table_id: tableId });
    assert.strictEqual(r2.ok, true, r2.error);
    orderId = r2.order_id;
    assert.ok(r2.order.adisyon_no >= 1);
  });

  await step('items are added and VAT is computed by the database, inclusive', async () => {
    await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: p1, qty: 2 });
    const r = await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: p2, qty: 3, note: 'az buzlu' });
    assert.strictEqual(r.ok, true, r.error);
    const o = r.order;
    assert.strictEqual(Number(o.total), 760);                 // 2*320 + 3*40
    // KDV dahil: 640 at 10% -> 58.18 ; 120 at 20% -> 20.00
    assert.strictEqual(Number(o.vat_total).toFixed(2), '78.18');
    assert.strictEqual(Number(o.grand_total), 760);
  });

  await step('sending to the kitchen queues a slip and does NOT yet move stock', async () => {
    /*
     * Stock deliberately does not move here any more.
     *
     * Deducting at send-to-kitchen time set stock_applied=1 before the bill
     * closed, so the close then skipped the line and the raw materials its
     * recipe consumes were never taken out of the store at all. It also
     * deducted for a bill that might still be cancelled before anyone paid.
     * The deduction now happens once, at close - see the close step below.
     */
    const before = Number(await db.value('SELECT stock FROM product_stock WHERE client_id=? AND product_id=?', [CID, p1]));
    const r = await api('POST', `/api/pos/orders/${orderId}/send`);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.sent, 2);
    const after = Number(await db.value('SELECT stock FROM product_stock WHERE client_id=? AND product_id=?', [CID, p1]));
    assert.strictEqual(before, after, 'the kitchen slip must not move stock; the close does');
    const flagged = Number(await db.value(
      'SELECT COUNT(*) FROM order_items WHERE order_id=? AND stock_applied=1', [orderId]));
    assert.strictEqual(flagged, 0, 'stock_applied must still be 0, or the close will skip the line');
    const jobs = Number(await db.value('SELECT COUNT(*) FROM print_jobs WHERE order_id=?', [orderId]));
    assert.ok(jobs >= 1, 'kitchen slip was not queued');
  });

  await step('an item already sent cannot silently shrink', async () => {
    const item = await db.one('SELECT id FROM order_items WHERE order_id=? AND product_id=?', [orderId, p1]);
    const r = await api('PUT', `/api/pos/orders/${orderId}/items/${item.id}`, { qty: 1 });
    assert.strictEqual(r.status, 409, 'expected a refusal, got ' + r.status);
  });

  await step('cancelling a sent item logs it and gives the stock back', async () => {
    const item = await db.one('SELECT id FROM order_items WHERE order_id=? AND product_id=?', [orderId, p2]);
    const r = await api('DELETE', `/api/pos/orders/${orderId}/items/${item.id}`, { qty: 1, reason: 'Musteri vazgecti' });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(Number(r.order.total), 720);
    const ev = Number(await db.value('SELECT COUNT(*) FROM order_item_cancel_events WHERE order_id=?', [orderId]));
    assert.ok(ev >= 1);
  });

  await step('a percentage discount recalculates the bill', async () => {
    const r = await api('POST', `/api/pos/orders/${orderId}/discount`, { percent: 10, reason: 'Sadik musteri' });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(Number(r.grand_total), 648);           // 720 - 10%
  });

  await step('a partial payment leaves the bill open', async () => {
    const r = await api('POST', `/api/pos/orders/${orderId}/payments`, { method: 'nakit', amount: 300 });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.closed, false);
    assert.strictEqual(Number(r.order.due), 348);
  });

  await step('paying the rest closes the bill, frees the table AND moves the stock', async () => {
    /*
     * The close is the single funnel every payment path goes through, so this
     * is where stock moves. In the old system only one of the four close paths
     * deducted, so a bill settled on the OKC banked the money and left the
     * stock untouched - the same sale with two different outcomes.
     */
    const before = Number(await db.value('SELECT stock FROM product_stock WHERE client_id=? AND product_id=?', [CID, p1]));
    const sold = Number(await db.value(
      'SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id=? AND product_id=? AND is_deleted=0',
      [orderId, p1]));
    const r = await api('POST', `/api/pos/orders/${orderId}/payments`, { method: 'kredi_karti', amount: 348 });
    assert.strictEqual(r.closed, true, 'bill did not close');
    const occupied = Number(await db.value('SELECT is_occupied FROM restaurant_tables WHERE id=?', [tableId]));
    assert.strictEqual(occupied, 0);
    const after = Number(await db.value('SELECT stock FROM product_stock WHERE client_id=? AND product_id=?', [CID, p1]));
    assert.strictEqual(before - after, sold,
      `close should have deducted ${sold}, moved ${before - after}`);
  });

  await step('a bill closed by mistake can be reopened on the same table', async () => {
    const r = await api('POST', `/api/pos/orders/${orderId}/reopen`, { reason: 'Yanlislikla kapatildi' });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.order.status, 'open');
    assert.strictEqual(Number(r.order.reopen_count), 1);
    const occupied = Number(await db.value('SELECT is_occupied FROM restaurant_tables WHERE id=?', [tableId]));
    assert.strictEqual(occupied, 1);
    // put it back
    await api('POST', `/api/pos/orders/${orderId}/payments`, { method: 'nakit', amount: 0.01 });
    await db.exec("UPDATE orders SET status='closed', is_closed=1, closed_at=NOW() WHERE id=?", [orderId]);
    await db.exec('UPDATE restaurant_tables SET is_occupied=0 WHERE id=?', [tableId]);
  });

  await step('splitting a bill moves the chosen lines onto a new adisyon', async () => {
    const o2 = (await api('POST', '/api/pos/orders', { table_id: tableId })).order_id;
    await api('POST', `/api/pos/orders/${o2}/items`, { product_id: p1, qty: 4 });
    const item = await db.one('SELECT id FROM order_items WHERE order_id=? ORDER BY id DESC LIMIT 1', [o2]);
    const r = await api('POST', `/api/pos/orders/${o2}/split`, { lines: [{ itemId: item.id, qty: 1 }] });
    assert.strictEqual(r.ok, true, r.error);
    const src = (await api('GET', `/api/pos/orders/${o2}`)).order;
    const dst = (await api('GET', `/api/pos/orders/${r.order_id}`)).order;
    assert.strictEqual(Number(src.total), 960);
    assert.strictEqual(Number(dst.total), 320);
    await api('POST', `/api/pos/orders/${o2}/payments`, { method: 'nakit', amount: 960 });
    await api('POST', `/api/pos/orders/${r.order_id}/payments`, { method: 'nakit', amount: 320 });
  });

  await step('the ÖKC simulator completes a fiscal card payment', async () => {
    await db.setSetting('fiscal_enabled', '1');
    await db.exec('DELETE FROM fiscal_devices WHERE client_id=?', [CID]);
    const dev = await api('POST', '/api/manage/fiscal/devices',
      { provider: 'simulator', device_model: 'Sanal OKC', serial_number: 'SIM-0001', environment: 'test' });
    assert.strictEqual(dev.ok, true, dev.error);
    const t = await api('POST', `/api/manage/fiscal/devices/${dev.id}/test`);
    assert.strictEqual(t.ok, true, t.error);
    assert.strictEqual(t.status.state, 'ready');

    const o3 = (await api('POST', '/api/pos/orders', { table_id: tableId })).order_id;
    await api('POST', `/api/pos/orders/${o3}/items`, { product_id: p2, qty: 2 });
    const pay = await api('POST', `/api/pos/orders/${o3}/fiscal/pay`, { method: 'kredi_karti' });
    assert.strictEqual(pay.ok, true, pay.error);
    // wait for the device to answer
    let tx = null;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 400));
      tx = (await api('GET', `/api/pos/fiscal/transactions/${pay.transactionId}`)).transaction;
      if (tx && ['approved', 'declined', 'error'].includes(tx.state)) break;
    }
    assert.strictEqual(tx.state, 'approved', 'fiscal state was ' + (tx && tx.state));
    assert.ok(tx.receipt && tx.receipt.fiscal_receipt_no, 'no fiscal receipt stored');
    const o = (await api('GET', `/api/pos/orders/${o3}`)).order;
    assert.strictEqual(o.status, 'closed', 'bill should close after the ÖKC approves');
    assert.strictEqual(Number(await db.value('SELECT COUNT(*) FROM order_payment_locks WHERE order_id=?', [o3])), 0);
  });

  await step('the phone pairs, takes an order and asks for the bill', async () => {
    await db.exec('DELETE FROM np_mobile_pairings WHERE client_id=?', [CID]);
    const code = await api('POST', '/api/auth/pair-code');
    assert.strictEqual(code.ok, true, code.error);
    const paired = await api('POST', '/api/auth/pair', {
      code: code.code, device_id: 'test-phone', device_name: 'Test Telefon', platform: 'android',
      username: 'erik', password: 'Sifre1234',
    });
    assert.strictEqual(paired.ok, true, paired.error);

    const boot = await api('GET', '/api/mobile/bootstrap', undefined, paired.token);
    assert.ok(boot.menu.length >= 1);
    assert.ok(boot.tables.length === 6);

    const take = await api('POST', '/api/mobile/orders/take', {
      table_id: boot.tables[2].id,
      items: [{ product_id: p1, qty: 1, note: 'az acili' }, { product_id: p2, qty: 2 }],
    }, paired.token);
    assert.strictEqual(take.ok, true, take.error);
    assert.strictEqual(Number(take.order.total), 400);
    assert.strictEqual(take.sent.sent, 2, 'kitchen was not told');

    const printed = await api('POST', `/api/mobile/orders/${take.order_id}/print`, {}, paired.token);
    assert.strictEqual(printed.ok, true, printed.error);
    const mailed = await api('POST', `/api/mobile/orders/${take.order_id}/mail`,
      { email: 'misafir@example.com' }, paired.token);
    assert.strictEqual(mailed.ok, true, mailed.error);
    assert.ok(mailed.pdf, 'no PDF was produced for the mailed bill');
    await api('POST', `/api/pos/orders/${take.order_id}/payments`, { method: 'nakit', amount: 400 });
  });

  /*
   * Two parties on one table, from a phone.
   *
   * The waiter app could not do this: it read the table's open bills and took
   * `list.first`, so on a six-top shared by two couples every round landed on
   * whichever tab came back first, and nobody found out until somebody asked
   * for the bill. The server always understood `forceNew`; this route simply
   * never passed it on. Both halves are checked here - opening a second bill,
   * and then aiming a round at a named one.
   */
  await step('telefon aynı masada ikinci adisyon açabilir ve doğru adisyona ekler', async () => {
    const tok = await auth.issueToken({ cid: CID, uid: managerId, role: 'admin', name: 'Erik', kind: 'mobile' });
    const boot = await api('GET', '/api/mobile/bootstrap', undefined, tok);
    const table = boot.tables[4].id;

    const first = await api('POST', '/api/mobile/orders/take',
      { table_id: table, items: [{ product_id: p1, qty: 1 }] }, tok);
    assert.strictEqual(first.ok, true, first.error);

    /* without force_new the same table must reuse the bill that is open */
    const same = await api('POST', '/api/mobile/orders/take',
      { table_id: table, items: [{ product_id: p2, qty: 1 }] }, tok);
    assert.strictEqual(same.order_id, first.order_id, 'a second round opened a new bill by itself');

    /* with it, a second party gets their own */
    const second = await api('POST', '/api/mobile/orders/take',
      { table_id: table, force_new: true, items: [{ product_id: p2, qty: 1 }] }, tok);
    assert.strictEqual(second.ok, true, second.error);
    assert.notStrictEqual(second.order_id, first.order_id, 'force_new did not open a second bill');

    const open = await api('GET', `/api/mobile/tables/${table}/order`, undefined, tok);
    assert.strictEqual(open.orders.length, 2, 'the table does not show two bills: ' + open.orders.length);

    /* and a round aimed at the FIRST bill must land there, not on the newest */
    const aimed = await api('POST', '/api/mobile/orders/take',
      { order_id: first.order_id, items: [{ product_id: p1, qty: 1 }] }, tok);
    assert.strictEqual(aimed.order_id, first.order_id, 'the round went to the wrong bill');

    /* Pay both off. The day-close checks further down count open bills, and a
       test that leaves its own tables occupied breaks the ones after it. */
    for (const id of [first.order_id, second.order_id]) {
      const o = (await api('GET', `/api/mobile/orders/${id}`, undefined, tok)).order;
      await api('POST', `/api/pos/orders/${id}/payments`, { method: 'nakit', amount: Number(o.grand_total) });
    }
  });

  /* Yarım porsiyon, all the way from a phone. The till has snapped quantities
     to halves since the beginning; what was missing was anybody sending one. */
  await step('telefondan yarım porsiyon geçer ve yarım olarak durur', async () => {
    const tok = await auth.issueToken({ cid: CID, uid: managerId, role: 'admin', name: 'Erik', kind: 'mobile' });
    const boot = await api('GET', '/api/mobile/bootstrap', undefined, tok);
    const r = await api('POST', '/api/mobile/orders/take',
      { table_id: boot.tables[5].id, items: [{ product_id: p1, qty: 0.5, note: 'yarım' }] }, tok);
    assert.strictEqual(r.ok, true, r.error);
    const line = r.order.items.find(i => Number(i.product_id) === Number(p1));
    assert.ok(line, 'the half portion did not reach the bill');
    assert.strictEqual(Number(line.qty), 0.5, 'a half was stored as ' + line.qty);
    assert.strictEqual(line.note, 'yarım', 'the note did not travel with the line');
    /* anything finer than a half snaps rather than being charged */
    const third = await api('POST', '/api/mobile/orders/take',
      { order_id: r.order_id, items: [{ product_id: p2, qty: 0.33 }] }, tok);
    const t = third.order.items.find(i => Number(i.product_id) === Number(p2));
    assert.strictEqual(Number(t.qty), 0.5, '0,33 was stored as ' + t.qty);
    await api('POST', `/api/pos/orders/${r.order_id}/payments`,
      { method: 'nakit', amount: Number(third.order.grand_total) });
  });

  await step('the same phone operation sent twice is applied once', async () => {
    const tok = await auth.issueToken({ cid: CID, uid: managerId, role: 'admin', name: 'Erik', kind: 'mobile' });
    const op = { op_id: 'op-test-1', type: 'take_order', table_id: tableId, items: [{ product_id: p2, qty: 1 }] };
    const a = await api('POST', '/api/mobile/sync', { ops: [op] }, tok);
    const b = await api('POST', '/api/mobile/sync', { ops: [op] }, tok);
    assert.strictEqual(a.results[0].status, 'applied', a.results[0].error);
    assert.strictEqual(b.results[0].status, 'applied');
    assert.strictEqual(a.results[0].response.order_id, b.results[0].response.order_id);
    await api('POST', `/api/pos/orders/${a.results[0].response.order_id}/payments`, { method: 'nakit', amount: 40 });
  });

  await step('the Z report adds up and the KDV breakdown is per rate', async () => {
    const r = await api('GET', '/api/reports/z');
    assert.strictEqual(r.ok, true, r.error);
    const z = r.report;
    assert.ok(z.orders >= 4);
    assert.ok(z.vat_breakdown.length >= 2, 'expected both 10% and 20% lines');
    const payTotal = z.payments.reduce((s, p) => s + p.total, 0);
    assert.ok(Math.abs(payTotal - z.net) < 1, `payments ${payTotal} vs net ${z.net}`);
  });

  await step('the day will not close while a bill is open', async () => {
    const open = (await api('POST', '/api/pos/orders', { table_id: tableId })).order_id;
    await api('POST', `/api/pos/orders/${open}/items`, { product_id: p2, qty: 1 });
    const r = await api('POST', '/api/reports/close-day', { declared_cash: 100 });
    assert.strictEqual(r.status, 409, 'day closed with an open bill!');
    openBillId = open;
  });

  await step('only the owner may delete a bill, and only with a reason', async () => {
    /*
     * Erik's rule, and it is a money rule: a manager can void a LINE and it is
     * on the record, but making a whole bill disappear is the one action that
     * leaves no trace of the sale, so it belongs to the licence holder alone.
     * The PIN token in TOKEN is a manager - it must be refused here.
     */
    /*
     * TOKEN is the owner's own PIN session now, so the refusal has to be
     * proved with a real manager: an `admin` account is somebody the owner
     * hired, and a manager who can make a whole sale disappear is the hole
     * this rule exists to close.
     */
    const manager = await auth.issueToken({ cid: CID, uid: managerId, role: 'admin', name: 'Mudur', kind: 'staff' });
    const refused = await api('DELETE', `/api/pos/orders/${openBillId}`, { reason: 'yonetici denemesi' }, manager);
    assert.strictEqual(refused.status, 403, 'a manager deleted a bill');

    // the owner is the tenant token the online login issues
    const owner = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Test Restoran', kind: 'tenant' });
    const noReason = await api('DELETE', `/api/pos/orders/${openBillId}`, {}, owner);
    assert.strictEqual(noReason.status, 400, 'a bill was deleted without a reason');

    const done = await api('DELETE', `/api/pos/orders/${openBillId}`, { reason: 'test temizligi' }, owner);
    assert.strictEqual(done.ok, true, done.error);
    const gone = await db.one('SELECT status, is_deleted, exclude_from_reports FROM orders WHERE id=?', [openBillId]);
    assert.strictEqual(Number(gone.is_deleted), 1, 'the bill is not marked deleted');
    assert.strictEqual(Number(gone.exclude_from_reports), 1, 'a deleted bill still counts in the reports');
    // the copy that survives the delete: what it was, who removed it, and why
    const logged = await db.one('SELECT reason, deleted_by, original_data FROM order_delete_logs WHERE order_id=?', [openBillId]);
    assert.ok(logged, 'nothing was written to order_delete_logs');
    assert.strictEqual(logged.reason, 'test temizligi');
    // the driver hands JSON columns back already parsed on some versions
    const snap = typeof logged.original_data === 'string'
      ? JSON.parse(logged.original_data) : logged.original_data;
    assert.ok(snap.items.length > 0, 'the deleted lines were not kept');
    assert.ok(snap.order.grand_total !== undefined, 'the deleted bill total was not kept');
  });

  await step('the day closes once the shift is closed too', async () => {
    const s = await api('POST', '/api/pos/shift/close', { counted_cash: 1200 });
    assert.strictEqual(s.ok, true, s.error);
    const r = await api('POST', '/api/reports/close-day', { declared_cash: 1200, declared_card: 348, print: false });
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(r.report.close_seq >= 1);
    const closed = Number(await db.value('SELECT COUNT(*) FROM daily_closings WHERE client_id=?', [CID]));
    assert.ok(closed >= 1);
  });

  await step('no new bill can be opened after the day is closed', async () => {
    const r = await api('POST', '/api/pos/orders', { table_id: tableId });
    assert.strictEqual(r.status, 409);
  });

  await step('a backup of the local database can be produced on demand', async () => {
    const r = await api('POST', '/api/manage/backups/run');
    if (!r.ok) throw new Error(r.error);
    assert.ok(r.size > 1000, 'backup looks empty');
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) { failed.forEach(f => console.log('  ! ' + f[1] + ': ' + f[2])); }
  server.close();
  process.exit(failed.length ? 1 : 0);
})();
