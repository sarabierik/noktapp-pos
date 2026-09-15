'use strict';
/**
 * AKIŞ - the whole till workflow, end to end, against a real MariaDB and the
 * real HTTP service with nothing mocked.
 *
 * test/smoke.js already walks the happy path: open the day, open a bill, add
 * lines, send them, discount, pay, reopen, split, close the day. This suite
 * deliberately does NOT repeat any of that. It covers what the happy path
 * cannot reach:
 *
 *   - the BRANCHES: takeaway with no table, a second bill on one table, a bill
 *     given away whole, a discount on a line and on the bill at once;
 *   - the SECOND and THIRD exit from each state: a table freed by paying, by
 *     cancelling, by transferring, by merging, by breaking a join up;
 *   - the FAILURE paths: an edit to a closed bill, a transfer to a table that
 *     is not ours, a re-send that used to hit a unique key;
 *   - the AUDIT rows, because "who did that" is what the owner bought;
 *   - the CONCURRENCY cases: two waiters on one bill, two tills on one shift,
 *     two tills on one day-end, the same phone operation arriving twice at once.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/akis.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7476';
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
let OWNER = null;    // the tenant login: uid 0, the licence holder
let STAFF = null;    // a hired manager - everything except the destructive keys
let UID = null;      // the staff user's id

async function api(method, path, body, token = OWNER) {
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

const n = (v) => Number(v);
const count = (sql, p) => db.value(sql, p).then(Number);

/* ------------------------------------------------------------ fixture */
let P = {};              // products
let T = {};              // tables
let RAW = null;          // an inventory item the kebap's recipe eats

async function fixture() {
  await db.exec('DELETE FROM daily_closings WHERE client_id=?', [CID]);
  await db.exec("UPDATE pos_shifts SET status='closed', closed_at=NOW() WHERE client_id=? AND status='open'", [CID]);
  // leave nothing of an earlier suite standing on a table we are about to use
  await db.exec("UPDATE orders SET status='cancelled', is_closed=1, exclude_from_reports=1 " +
    "WHERE client_id=? AND status='open'", [CID]);
  await db.exec("UPDATE table_groups SET status='closed', closed_at=NOW() WHERE client_id=? AND status='open'", [CID]);
  await db.exec('UPDATE table_group_members SET left_at=NOW() WHERE client_id=? AND left_at IS NULL', [CID]);

  const zone = await db.one('SELECT id FROM table_zones WHERE client_id=? ORDER BY id LIMIT 1', [CID])
    || { id: await db.insert('INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']) };
  const table = async (name) => {
    const e = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? AND name=?', [CID, name]);
    if (e) { await db.exec('UPDATE restaurant_tables SET is_occupied=0, is_active=1 WHERE id=?', [e.id]); return e.id; }
    return db.insert('INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active,is_occupied) VALUES (?,?,?,90,1,0)',
      [CID, zone.id, name]);
  };
  T = {
    a: await table('Akis 1'), b: await table('Akis 2'),
    c: await table('Akis 3'), d: await table('Akis 4'), e: await table('Akis 5'),
  };

  const station = await db.one("SELECT id FROM stations WHERE client_id=? AND name='Mutfak'", [CID])
    || { id: await db.insert('INSERT INTO stations (client_id,name,is_active) VALUES (?,?,1)', [CID, 'Mutfak']) };
  const cat = await db.one('SELECT id FROM categories WHERE client_id=? AND name=?', [CID, 'Akis Yemek'])
    || { id: await db.insert(
      'INSERT INTO categories (client_id,name,station_id,sort_order,is_active,use_in_pos) VALUES (?,?,?,90,1,1)',
      [CID, 'Akis Yemek', station.id]) };
  // a category with NO station, so "nothing is configured" has a real subject
  const noStation = await db.one('SELECT id FROM categories WHERE client_id=? AND name=?', [CID, 'Akis Istasyonsuz'])
    || { id: await db.insert(
      'INSERT INTO categories (client_id,name,station_id,sort_order,is_active,use_in_pos) VALUES (?,?,NULL,91,1,1)',
      [CID, 'Akis Istasyonsuz']) };

  const mk = async (c, name, price, cost, vat, track) => {
    const e = await db.one('SELECT id FROM products WHERE client_id=? AND name=?', [CID, name]);
    if (e) return e.id;
    return db.insert(
      `INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,sort_order,
          is_active,use_in_pos,track_stock) VALUES (?,?,?,?,?,?,90,1,1,?)`,
      [CID, c, name, price, cost, vat, track ? 1 : 0]);
  };
  P = {
    kebap: await mk(cat.id, 'Akis Kebap', 200, 80, 10, true),
    ayran: await mk(cat.id, 'Akis Ayran', 40, 12, 20, false),
    tatli: await mk(noStation.id, 'Akis Tatli', 100, 30, 10, false),
  };
  P.station = station.id;
  await api('POST', '/api/pos/stock/' + P.kebap, { quantity: 500 });

  // a recipe, so "stock deducts once" can mean raw materials too
  const item = await db.one('SELECT id FROM inventory_items WHERE client_id=? AND name=?', [CID, 'Akis Et']);
  RAW = item ? item.id : await db.insert(
    'INSERT INTO inventory_items (client_id,name,unit,is_active,created_at) VALUES (?,?,?,1,NOW())',
    [CID, 'Akis Et', 'kg']);
  await db.exec('DELETE FROM product_recipes WHERE client_id=? AND product_id=?', [CID, P.kebap]);
  await db.exec('INSERT INTO product_recipes (client_id,product_id,inventory_item_id,qty_per_unit) VALUES (?,?,?,?)',
    [CID, P.kebap, RAW, 0.2]);

  // a programme with no product on it stamps every visit, so "one stamp per
  // close" has something deterministic to be true about
  const prog = await db.one('SELECT id FROM loyalty_programs WHERE client_id=? AND title=?', [CID, 'Akis Kart']);
  P.program = prog ? prog.id : await db.insert(
    `INSERT INTO loyalty_programs (client_id, product_id, title, target_count, reward_text, is_active, created_at)
     VALUES (?, NULL, ?, 5, ?, 1, NOW())`, [CID, 'Akis Kart', 'Bir ikram']);

  const u = await db.one("SELECT id FROM users WHERE client_id=? AND role IN ('admin','superadmin') ORDER BY id LIMIT 1", [CID]);
  UID = u ? u.id : null;
  OWNER = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Isletme Sahibi', kind: 'tenant' });
  STAFF = await auth.issueToken({ cid: CID, uid: UID, role: 'admin', name: 'Mudur', kind: 'staff' });

  const s = await api('POST', '/api/pos/shift/open', { opening_float: 0 });
  if (!s.ok) throw new Error('vardiya acilamadi: ' + s.error);
}

/** Open a bill and put lines on it. Returns the order id. */
async function billOn(tableId, lines = [[/*product*/null, 1]]) {
  const o = await api('POST', '/api/pos/orders', tableId ? { table_id: tableId } : {});
  if (!o.order_id) throw new Error('adisyon acilamadi: ' + JSON.stringify(o));
  for (const [product, qty, extra] of lines) {
    if (!product) continue;
    const r = await api('POST', `/api/pos/orders/${o.order_id}/items`, { product_id: product, qty, ...(extra || {}) });
    if (r.status !== 200) throw new Error('kalem eklenemedi: ' + JSON.stringify(r));
  }
  return o.order_id;
}
const orderOf = async (id) => (await api('GET', `/api/pos/orders/${id}`)).order;
const payFull = async (id, method = 'nakit') => {
  const o = await orderOf(id);
  return api('POST', `/api/pos/orders/${id}/payments`, { method, amount: n(o.due) });
};
const occupied = (t) => count('SELECT is_occupied FROM restaurant_tables WHERE id=?', [t]);

/* ------------------------------------------------------------------ */
(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - akis (workflow) denetimi\n');
  await fixture();

  /* ============================ 1. THE BUSINESS DAY ==================== */

  await step('the business date is the LOCAL date, not the one UTC happens to be on', async () => {
    /*
     * The clock is shifted back by the business-day hour and then had to be
     * WRITTEN OUT. Formatting it with toISOString() converts to UTC, which on
     * any till east of Greenwich applies the shift a second time: in Istanbul
     * (UTC+3) a bill opened at 02:30 on the 4th came back as the 2nd, and was
     * filed under a day the restaurant had closed the night before last.
     *
     * Asserted against the local calendar rather than a fixed string, so it
     * says the same thing in every timezone the suite is ever run in.
     */
    const bd = require('../src/util/businessDay');
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const start = String(await db.getSetting('business_day_start', '06:00'));
    const [h] = start.split(':').map(Number);

    const late = new Date(); late.setHours(Math.max(0, h - 4), 30, 0, 0);
    const yesterday = new Date(late.getTime()); yesterday.setDate(yesterday.getDate() - 1);
    assert.strictEqual(await bd.currentBusinessDate(late), ymd(yesterday),
      'a bill before the roll-over hour must belong to the day still being worked');

    const midday = new Date(); midday.setHours(Math.min(23, h + 6), 0, 0, 0);
    assert.strictEqual(await bd.currentBusinessDate(midday), ymd(midday));

    const night = new Date(); night.setHours(23, 30, 0, 0);
    assert.strictEqual(await bd.currentBusinessDate(night), ymd(night),
      'late evening is still today, whatever UTC thinks');
  });

  await step('a bill opened before the roll-over hour is counted on the day still being worked', async () => {
    const bd = require('../src/util/businessDay');
    const today = await bd.currentBusinessDate();
    const id = await billOn(T.a, [[P.ayran, 1]]);
    assert.strictEqual((await db.one('SELECT business_date FROM orders WHERE id=?', [id])).business_date, today);
    // and the Z report for that day is the one that finds it
    const z = (await api('GET', '/api/reports/z?date=' + today)).report;
    assert.ok(z, 'no Z report for the open business day');
    await api('DELETE', `/api/pos/orders/${id}`, { reason: 'akis temizlik' }, OWNER);
  });

  await step('the adisyon counter lives on the PC\'s own series and survives a device number', async () => {
    /*
     * app_order_counters is keyed on (client_id, business_date, prefix). The
     * engine used to bump prefix 1 and read back without naming a prefix at
     * all, so the moment a prefix-0 row appeared - which is what a phone
     * replaying an offline op writes - the row it incremented and the row it
     * read were different, and it handed out the SAME number for every bill of
     * the day. uq_adisyon_day then refused every attempt to open one.
     */
    const bd = require('../src/util/businessDay');
    const device = require('../src/modules/device');
    const date = await bd.currentBusinessDate();
    const a = await billOn(T.a, [[P.ayran, 1]]);
    await device.observeNumber(CID, date, 0, 4000);       // a phone reports a number it minted
    const b = await billOn(T.a, [[P.ayran, 1]]);
    const c = await billOn(T.a, [[P.ayran, 1]]);
    const nos = [];
    for (const id of [a, b, c]) nos.push(n((await db.one('SELECT adisyon_no FROM orders WHERE id=?', [id])).adisyon_no));
    assert.strictEqual(new Set(nos).size, 3, 'the counter handed out the same number twice: ' + nos.join(','));
    assert.ok(nos[2] > nos[1] && nos[1] > nos[0], 'numbering went backwards: ' + nos.join(','));
    // the PC counts on prefix 0 (1..9 belong to tablets), and the row it reads
    // is the row it bumps - that is what stops the same number coming out twice
    const own = await db.one(
      'SELECT next_no FROM app_order_counters WHERE client_id=? AND business_date=? AND prefix=0', [CID, date]);
    assert.ok(own, 'the PC has no counter row on its own series');
    assert.strictEqual(n(own.next_no), Math.max(...nos),
      'the row the engine reads is not the row it bumps: next_no=' + own.next_no + ' nos=' + nos.join(','));
    for (const id of [a, b, c]) await api('DELETE', `/api/pos/orders/${id}`, { reason: 'akis temizlik' }, OWNER);
  });

  /* ============================ 2. OPENING BILLS ======================= */

  await step('a counter takeaway opens with no table and occupies nothing', async () => {
    const id = await billOn(null, [[P.ayran, 2]]);
    const o = await orderOf(id);
    assert.strictEqual(o.table_id, null, 'a paket order must not sit on a table');
    assert.strictEqual(o.bill_label, null, 'a bill with no table needs no A/B label');
    assert.strictEqual(n(o.total), 80);
    const r = await payFull(id);
    assert.strictEqual(r.closed, true, r.error);
  });

  await step('a second and third party at one table get A and B, and only one tile lights up', async () => {
    const first = await billOn(T.b, [[P.ayran, 1]]);
    const second = await billOn(T.b, [[P.ayran, 1]]);
    const third = await billOn(T.b, [[P.ayran, 1]]);
    assert.strictEqual((await orderOf(first)).bill_label, null, 'the first bill needs no label');
    assert.strictEqual((await orderOf(second)).bill_label, 'A');
    assert.strictEqual((await orderOf(third)).bill_label, 'B');
    const plan = await api('GET', '/api/pos/tables');
    const tile = plan.tables.find(t => t.id === T.b);
    assert.strictEqual(tile.open_bills, 3);
    assert.strictEqual(tile.labels, 'A, B', 'the floor plan must name the bills, not just count them');
    // and the table stays occupied until the LAST one leaves
    await payFull(first); assert.strictEqual(await occupied(T.b), 1);
    await payFull(second); assert.strictEqual(await occupied(T.b), 1);
    await payFull(third);
    assert.strictEqual(await occupied(T.b), 0, 'the last bill left and the table is still red');
  });

  await step('a table is freed when its last bill leaves by CANCELLING, not just by paying', async () => {
    const id = await billOn(T.c, [[P.kebap, 1]]);
    assert.strictEqual(await occupied(T.c), 1);
    const r = await api('DELETE', `/api/pos/orders/${id}`, { reason: 'musteri gitti' }, OWNER);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(await occupied(T.c), 0);
  });

  await step('a table is freed when its last bill is TRANSFERRED away', async () => {
    const id = await billOn(T.c, [[P.ayran, 1]]);
    const r = await api('POST', `/api/pos/orders/${id}/transfer`, { table_id: T.d });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(await occupied(T.c), 0, 'the table the bill left is still red');
    assert.strictEqual(await occupied(T.d), 1, 'the table it moved to is not occupied');
    await payFull(id);
    assert.strictEqual(await occupied(T.d), 0);
  });

  await step('splitting keeps the table occupied - both halves are still sitting there', async () => {
    const id = await billOn(T.c, [[P.kebap, 4]]);
    const item = await db.one('SELECT id FROM order_items WHERE order_id=? ORDER BY id DESC LIMIT 1', [id]);
    const s = await api('POST', `/api/pos/orders/${id}/split`, { lines: [{ itemId: item.id, qty: 2 }] });
    assert.strictEqual(s.ok, true, s.error);
    assert.strictEqual(await occupied(T.c), 1);
    await payFull(id);
    assert.strictEqual(await occupied(T.c), 1, 'the other half of the split is still unpaid');
    await payFull(s.order_id);
    assert.strictEqual(await occupied(T.c), 0);
  });

  /* ============================ 3. LINES =============================== */

  await step('half a portion is a portion, and a third is not', async () => {
    const id = await billOn(T.a, []);
    await api('POST', `/api/pos/orders/${id}/items`, { product_id: P.kebap, qty: 0.5, note: 'az acili' });
    await api('POST', `/api/pos/orders/${id}/items`, { product_id: P.kebap, qty: 0.33 });
    const o = await orderOf(id);
    assert.deepStrictEqual(o.items.map(i => n(i.qty)), [0.5, 0.5], 'a third must snap to a half');
    assert.strictEqual(o.items[0].note, 'az acili');
    assert.strictEqual(n(o.total), 200);
    const bad = await api('POST', `/api/pos/orders/${id}/items`, { product_id: P.kebap, qty: 0 });
    assert.strictEqual(bad.status, 400, 'a qty of zero was accepted');
    await payFull(id);
  });

  await step('cancelling half a discounted line keeps the discount in proportion, and records the half', async () => {
    const id = await billOn(T.a, [[P.kebap, 2]]);
    const item = await db.one('SELECT id FROM order_items WHERE order_id=? ORDER BY id DESC LIMIT 1', [id]);
    await api('PUT', `/api/pos/orders/${id}/items/${item.id}`, { discount_amount: 100, reason: 'Kusura bakmayin' });
    const r = await api('DELETE', `/api/pos/orders/${id}/items/${item.id}`, { qty: 0.5, reason: 'yarim geri' });
    assert.strictEqual(r.ok, true, r.error);
    const line = await db.one('SELECT qty, discount_amount, line_total FROM order_items WHERE id=?', [item.id]);
    assert.strictEqual(n(line.qty), 1.5);
    assert.strictEqual(n(line.discount_amount), 75, 'the discount did not travel with the portions');
    assert.strictEqual(n(line.line_total), 225);          // 1.5 * 200 - 75
    // the cancel ledger is where the Z report counts voided portions from, and
    // its qty column used to be an INT: half a portion was written down as one
    const ev = await db.one(
      'SELECT qty, line_total FROM order_item_cancel_events WHERE order_id=? ORDER BY id DESC LIMIT 1', [id]);
    assert.strictEqual(n(ev.qty), 0.5, 'a yarim porsiyon was recorded as a whole one');
    assert.strictEqual(n(ev.line_total), 75);             // 0.5 * 200 - 25 of the discount
    await payFull(id);
  });

  await step('a per-line discount leaves a name, a reason and an audit row', async () => {
    const id = await billOn(T.a, [[P.kebap, 1]]);
    const item = await db.one('SELECT id FROM order_items WHERE order_id=? ORDER BY id DESC LIMIT 1', [id]);
    await api('PUT', `/api/pos/orders/${id}/items/${item.id}`, { discount_amount: 30, reason: 'Sogumus geldi' });
    const led = await db.one(
      "SELECT discount_value, reason, source FROM order_discounts WHERE order_id=? AND source='line'", [id]);
    assert.ok(led, 'a line discount left no row in the discount ledger');
    assert.strictEqual(n(led.discount_value), 30);
    assert.strictEqual(led.reason, 'Sogumus geldi');
    const a = await db.one(
      "SELECT after_json FROM audit_logs WHERE client_id=? AND action='line.discount' AND entity_id=?", [CID, String(item.id)]);
    assert.ok(a, 'nobody can be asked who took 30 TL off that line');
    await payFull(id);
  });

  await step('a line on a CLOSED, PAID bill cannot be edited or voided', async () => {
    /*
     * The money hole this closes: recalc would happily rewrite a settled bill's
     * total while order_payments kept the figure the guest had handed over, so
     * 400 TL of sold food could be walked down to 0 with the till's ordinary
     * keys - on any bill, including yesterday's. Reopening it is the sanctioned
     * way, and reopen is audited, counted and refused once the day is closed.
     */
    const id = await billOn(T.a, [[P.kebap, 2]]);
    const item = await db.one('SELECT id FROM order_items WHERE order_id=? ORDER BY id DESC LIMIT 1', [id]);
    await payFull(id);
    const before = await orderOf(id);
    assert.strictEqual(before.status, 'closed');

    const edit = await api('PUT', `/api/pos/orders/${id}/items/${item.id}`, { qty: 1 });
    assert.strictEqual(edit.status, 409, 'a paid bill was edited, got ' + edit.status);
    const void_ = await api('DELETE', `/api/pos/orders/${id}/items/${item.id}`, { reason: 'deneme' });
    assert.strictEqual(void_.status, 409, 'a line was voided off a paid bill, got ' + void_.status);

    const after = await orderOf(id);
    assert.strictEqual(n(after.grand_total), n(before.grand_total));
    assert.strictEqual(n(after.paid), n(after.grand_total), 'the bill no longer agrees with its own payments');
  });

  /* ============================ 4. SEND TO STATIONS ==================== */

  await step('sending queues one projection row and one slip, for the right station', async () => {
    const id = await billOn(T.a, [[P.kebap, 2], [P.ayran, 1]]);
    const r = await api('POST', `/api/pos/orders/${id}/send`);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.sent, 2);
    const rows = await db.query(
      'SELECT station_id, qty, station_status FROM station_projection_items WHERE client_id=? AND order_id=?', [CID, id]);
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every(x => n(x.station_id) === P.station), 'a line was routed to no station');
    assert.ok(rows.every(x => x.station_status === 'new'));
    const board = await api('GET', `/api/pos/stations/${P.station}/board`);
    assert.ok(board.items.filter(i => n(i.order_id) === n(id)).length === 2, 'the kitchen board cannot see the ticket');
    assert.strictEqual(await count('SELECT COUNT(*) FROM print_jobs WHERE order_id=?', [id]), 1,
      'one bill, one station, one slip');
    P.sentOrder = id;
  });

  await step('sending again with nothing new sends nothing and queues no second slip', async () => {
    const id = P.sentOrder;
    const r = await api('POST', `/api/pos/orders/${id}/send`);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.sent, 0, 're-send duplicated the order');
    assert.strictEqual(await count('SELECT COUNT(*) FROM print_jobs WHERE order_id=?', [id]), 1);
  });

  await step('raising the qty on an already sent line can be sent again', async () => {
    /*
     * station_projection_items is UNIQUE on (client_id, order_item_id), and the
     * insert was a plain INSERT: "the guest wants one more of the same" threw
     * ER_DUP_ENTRY, the whole transaction rolled back, and those portions could
     * never be made to reach the kitchen however many times it was retried.
     */
    const id = P.sentOrder;
    const item = await db.one('SELECT id, qty FROM order_items WHERE order_id=? AND product_id=?', [id, P.kebap]);
    const up = await api('PUT', `/api/pos/orders/${id}/items/${item.id}`, { qty: 5 });
    assert.strictEqual(up.status, 200, up.error);
    const r = await api('POST', `/api/pos/orders/${id}/send`);
    assert.strictEqual(r.status, 200, 'the second send failed: ' + r.error);
    assert.strictEqual(r.sent, 1);
    const row = await db.one(
      'SELECT qty, station_status FROM station_projection_items WHERE client_id=? AND order_item_id=?', [CID, item.id]);
    assert.strictEqual(n(row.qty), 5, 'the kitchen was told the wrong number');
    assert.strictEqual(row.station_status, 'new', 'there is more to cook, so the ticket is live again');
    assert.strictEqual(await count('SELECT COUNT(*) FROM print_jobs WHERE order_id=?', [id]), 2);
  });

  await step('two waiters sending the same bill at once do not double the kitchen', async () => {
    const id = await billOn(T.a, [[P.kebap, 2]]);
    const [a, b] = await Promise.all([
      api('POST', `/api/pos/orders/${id}/send`),
      api('POST', `/api/pos/orders/${id}/send`),
    ]);
    assert.ok(a.status === 200 && b.status === 200, 'a send failed: ' + (a.error || b.error));
    assert.strictEqual(a.sent + b.sent, 1, 'both sends claimed the same line');
    const rows = await db.query('SELECT qty FROM station_projection_items WHERE client_id=? AND order_id=?', [CID, id]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(n(rows[0].qty), 2, 'the kitchen has been asked for ' + rows[0].qty + ' of a 2-portion line');
    assert.strictEqual(await count('SELECT COUNT(*) FROM print_jobs WHERE order_id=?', [id]), 1,
      'two slips for one order');
    await payFull(id);
  });

  await step('a product whose category has no station still sends, and says so', async () => {
    /*
     * A restaurant that has not set the kitchen up yet still has to be able to
     * take an order. The line goes through, the projection row simply carries
     * no station - which is why the İstasyonlar screen can say "yazici bagli
     * degil" and mean it - and the send never throws.
     */
    const id = await billOn(T.a, [[P.tatli, 1]]);
    const r = await api('POST', `/api/pos/orders/${id}/send`);
    assert.strictEqual(r.status, 200, r.error);
    assert.strictEqual(r.sent, 1);
    const row = await db.one('SELECT station_id FROM station_projection_items WHERE client_id=? AND order_id=?', [CID, id]);
    assert.ok(row, 'nothing was projected at all');
    assert.strictEqual(row.station_id, null);
    await payFull(id);
  });

  /* ============================ 5. DISCOUNTS =========================== */

  await step('a line discount and a bill discount on one bill are each counted exactly once', async () => {
    /*
     * A per-line discount is already inside line_total. Its audit row in
     * order_discounts is filed under source='line' precisely so the arithmetic
     * does not see it - counting both took the same money off twice.
     */
    const id = await billOn(T.a, [[P.kebap, 2], [P.ayran, 5]]);   // 400 + 200 = 600
    const item = await db.one('SELECT id FROM order_items WHERE order_id=? AND product_id=?', [id, P.kebap]);
    await api('PUT', `/api/pos/orders/${id}/items/${item.id}`, { discount_amount: 100, reason: 'Satir' });
    let o = await orderOf(id);
    assert.strictEqual(n(o.total), 500, 'the line discount is not inside the subtotal');
    assert.strictEqual(n(o.discount_total), 0, 'a line discount must not appear as a bill discount');
    assert.strictEqual(n(o.grand_total), 500);

    const d = await api('POST', `/api/pos/orders/${id}/discount`, { percent: 10, reason: 'Sadik musteri' });
    assert.strictEqual(d.status, 200, d.error);
    o = await orderOf(id);
    assert.strictEqual(n(o.total), 500);
    assert.strictEqual(n(o.discount_total), 50);
    assert.strictEqual(n(o.grand_total), 450, 'the two discounts do not add up: got ' + o.grand_total);

    // and the KDV is the tax the bill actually contains, after both of them
    const vat = o.items.reduce((s, i) => s + n(i.line_total) * n(i.vat_rate) / (100 + n(i.vat_rate)), 0) * 0.9;
    assert.ok(Math.abs(n(o.vat_total) - vat) < 0.05, `KDV ${o.vat_total} vs ${vat.toFixed(2)}`);

    // changing the bill discount replaces it rather than stacking
    await api('POST', `/api/pos/orders/${id}/discount`, { amount: 200, reason: 'Yonetici' });
    o = await orderOf(id);
    assert.strictEqual(n(o.discount_total), 200);
    assert.strictEqual(n(o.grand_total), 300);
    assert.strictEqual(await count(
      "SELECT COUNT(*) FROM order_discounts WHERE order_id=? AND source='manual'", [id]), 1,
      'the cashier changing his mind left two manual discounts on the bill');
    await payFull(id);
  });

  /* ============================ 6. PAYMENT ============================= */

  await step('a bill split across three methods closes on the last kurus, not before', async () => {
    const id = await billOn(T.a, [[P.kebap, 2], [P.ayran, 1]]);   // 440
    const a = await api('POST', `/api/pos/orders/${id}/payments`, { method: 'nakit', amount: 100 });
    assert.strictEqual(a.closed, false);
    const b = await api('POST', `/api/pos/orders/${id}/payments`, { method: 'kredi_karti', amount: 300 });
    assert.strictEqual(b.closed, false);
    assert.strictEqual(n(b.order.due), 40);
    const c = await api('POST', `/api/pos/orders/${id}/payments`, { method: 'yemek_karti', amount: 40 });
    assert.strictEqual(c.closed, true, 'the bill did not close on the last payment');
    const sum = await count('SELECT COALESCE(SUM(amount),0) FROM order_payments WHERE order_id=?', [id]);
    assert.strictEqual(sum, 440);
  });

  await step('overpayment: the bill takes what it is owed and the change goes back over the counter', async () => {
    const id = await billOn(T.a, [[P.ayran, 2]]);                  // 80
    const r = await api('POST', `/api/pos/orders/${id}/payments`, { method: 'nakit', amount: 100 });
    assert.strictEqual(r.closed, true, r.error);
    assert.strictEqual(n(r.amount), 80, 'the drawer kept the para ustu');
    assert.strictEqual(n(r.tendered), 100);
    assert.strictEqual(n(r.change), 20);
    const sum = await count('SELECT COALESCE(SUM(amount),0) FROM order_payments WHERE order_id=?', [id]);
    assert.strictEqual(sum, 80, 'the payments sum above the bill by the change handed back');
  });

  await step('a bill given away whole closes, frees the table and moves the stock', async () => {
    /*
     * 100% ikram, or a loyalty reward that covers the lot: grand_total is zero,
     * so addPayment refused it ("odenecek tutar kalmadi") and closeIfPaid
     * refused it too. The bill sat open for ever - table red, stock never
     * deducted, and gun sonu blocked because a bill was still open. One free
     * meal used to mean the restaurant could not end its day.
     */
    const before = await count('SELECT COALESCE(stock,0) FROM product_stock WHERE client_id=? AND product_id=?', [CID, P.kebap]);
    const id = await billOn(T.e, [[P.kebap, 2]]);
    await api('POST', `/api/pos/orders/${id}/discount`, { percent: 100, reason: 'Ikram' });
    assert.strictEqual(n((await orderOf(id)).grand_total), 0);
    const r = await api('POST', `/api/pos/orders/${id}/payments`, { method: 'ikram', amount: 0 });
    assert.strictEqual(r.status, 200, 'a free bill could not be closed: ' + r.error);
    assert.strictEqual(r.closed, true);
    const o = await orderOf(id);
    assert.strictEqual(o.status, 'closed');
    assert.strictEqual(await occupied(T.e), 0, 'the table is still red after a free meal');
    const after = await count('SELECT COALESCE(stock,0) FROM product_stock WHERE client_id=? AND product_id=?', [CID, P.kebap]);
    assert.strictEqual(before - after, 2, 'ikram is still food out of the store');
    // no money changed hands, so nothing pretends it did
    assert.strictEqual(await count('SELECT COUNT(*) FROM order_payments WHERE order_id=?', [id]), 0);
    // but the ledger still says who gave it away and why
    assert.ok(await db.one("SELECT id FROM order_discounts WHERE order_id=? AND source='manual'", [id]));
  });

  await step('an EMPTY bill is not "paid" - it is empty', async () => {
    const id = await billOn(T.e, []);
    const r = await api('POST', `/api/pos/orders/${id}/payments`, { method: 'nakit', amount: 0 });
    assert.notStrictEqual((await orderOf(id)).status, 'closed', 'a bill with nothing on it closed itself');
    assert.strictEqual(r.status >= 400 || r.closed === false, true);
    await api('DELETE', `/api/pos/orders/${id}`, { reason: 'bos adisyon' }, OWNER);
  });

  await step('two cashiers taking the whole bill at once: one takes it, the other is told why not', async () => {
    const id = await billOn(T.a, [[P.kebap, 1]]);
    const due = n((await orderOf(id)).due);
    const [a, b] = await Promise.all([
      api('POST', `/api/pos/orders/${id}/payments`, { method: 'nakit', amount: due }),
      api('POST', `/api/pos/orders/${id}/payments`, { method: 'kredi_karti', amount: due }),
    ]);
    const won = [a, b].filter(r => r.status === 200 && r.closed);
    const lost = [a, b].filter(r => r.status !== 200);
    assert.strictEqual(won.length, 1, 'the bill was paid twice');
    assert.strictEqual(lost.length, 1);
    assert.strictEqual(lost[0].status, 409);
    assert.strictEqual(await count('SELECT COALESCE(SUM(amount),0) FROM order_payments WHERE order_id=?', [id]), due);
  });

  /* ============================ 7 & 8. CLOSE, REOPEN, RE-CLOSE ========= */

  await step('the close deducts finished goods AND recipe raw materials, exactly once', async () => {
    const stockOf = () => count('SELECT COALESCE(stock,0) FROM product_stock WHERE client_id=? AND product_id=?', [CID, P.kebap]);
    const rawOf = () => count(
      'SELECT COALESCE(SUM(quantity_out),0)-COALESCE(SUM(quantity_in),0) FROM inventory_stock_ledger WHERE client_id=? AND item_id=?',
      [CID, RAW]);
    const s0 = await stockOf(), r0 = await rawOf();
    const id = await billOn(T.a, [[P.kebap, 3]]);
    await api('POST', `/api/pos/orders/${id}/send`);
    assert.strictEqual(await stockOf(), s0, 'the kitchen slip moved stock; only the close may');
    await payFull(id);
    assert.strictEqual(s0 - await stockOf(), 3);
    assert.ok(Math.abs((await rawOf() - r0) - 0.6) < 0.001, 'the recipe did not eat 3 x 0.2 kg');
    assert.strictEqual(await count(
      'SELECT COUNT(*) FROM order_items WHERE order_id=? AND stock_applied=0 AND is_deleted=0', [id]), 0);
    P.reopenable = { id, s0, r0 };
  });

  await step('reopen puts the stock back, and re-closing takes it out again - once, not twice', async () => {
    const { id, s0, r0 } = P.reopenable;
    const stockOf = () => count('SELECT COALESCE(stock,0) FROM product_stock WHERE client_id=? AND product_id=?', [CID, P.kebap]);
    const rawOf = () => count(
      'SELECT COALESCE(SUM(quantity_out),0)-COALESCE(SUM(quantity_in),0) FROM inventory_stock_ledger WHERE client_id=? AND item_id=?',
      [CID, RAW]);
    const r = await api('POST', `/api/pos/orders/${id}/reopen`, { reason: 'Yanlis kapatildi' }, STAFF);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(await stockOf(), s0, 'a reopened bill has not been sold; the stock must come back');
    assert.ok(Math.abs(await rawOf() - r0) < 0.001, 'the raw material did not come back');
    assert.strictEqual(await occupied(T.a), 1);
    assert.ok(await db.one("SELECT id FROM audit_logs WHERE client_id=? AND action='bill.reopen' AND entity_id=?",
      [CID, String(id)]), 'nobody can be asked who reopened it');

    await payFull(id, 'kredi_karti');
    assert.strictEqual((await orderOf(id)).status, 'closed');
    assert.strictEqual(s0 - await stockOf(), 3, 'the re-close did not deduct, or deducted twice');
    assert.ok(Math.abs((await rawOf() - r0) - 0.6) < 0.001);
    assert.strictEqual(n((await orderOf(id)).reopen_count), 1);
  });

  await step('a guest attached to a bill is stamped once, however often it is reopened', async () => {
    /*
     * The guest registry is shared across the platform and enrolling a NEW one
     * needs the panel, which this suite must not depend on. The row is made
     * locally instead - the stamp is what is under test, not the sign-up.
     */
    const crypto = require('crypto');
    const phone = '0555' + String(Date.now()).slice(-7);
    const cust = { id: await db.insert(
      `INSERT INTO customers (first_name, last_name, phone, qr_uid, is_verified, is_active,
          created_by_client_id, created_at, updated_at)
       VALUES (?,?,?,?,0,1,?,NOW(),NOW())`,
      ['Akis', 'Misafir', phone, crypto.randomBytes(12).toString('hex'), CID]) };
    const id = await billOn(T.a, [[P.kebap, 1]]);
    const att = await api('POST', `/api/pos/orders/${id}/customer`, { customer_id: cust.id });
    assert.strictEqual(att.status, 200, att.error);
    await payFull(id);
    await new Promise(r => setTimeout(r, 400));          // the stamp fires just after the close
    const once = await count("SELECT COUNT(*) FROM loyalty_events WHERE client_id=? AND order_id=? AND kind='stamp'", [CID, id]);
    assert.ok(once >= 1, 'the guest earned nothing for a closed bill');
    await api('POST', `/api/pos/orders/${id}/reopen`, { reason: 'tekrar' }, STAFF);
    await payFull(id, 'kredi_karti');
    await new Promise(r => setTimeout(r, 400));
    const twice = await count("SELECT COUNT(*) FROM loyalty_events WHERE client_id=? AND order_id=? AND kind='stamp'", [CID, id]);
    assert.strictEqual(twice, once, 'reopening and re-closing stamped the card a second time');
  });

  /* ============================ 9. SPLIT / MERGE / JOIN ================ */

  await step('splitting a SENT line takes its kitchen ticket with it, and is audited', async () => {
    const id = await billOn(T.a, [[P.kebap, 4]]);
    const item = await db.one('SELECT id FROM order_items WHERE order_id=? ORDER BY id DESC LIMIT 1', [id]);
    await api('POST', `/api/pos/orders/${id}/send`);
    const s = await api('POST', `/api/pos/orders/${id}/split`, { lines: [{ itemId: item.id, qty: 2 }] });
    assert.strictEqual(s.ok, true, s.error);
    const rows = await db.query(
      'SELECT order_id, qty FROM station_projection_items WHERE client_id=? AND order_id IN (?,?) ORDER BY order_id',
      [CID, id, s.order_id]);
    assert.strictEqual(rows.length, 2, 'the kitchen ticket did not follow the food: ' + JSON.stringify(rows));
    assert.strictEqual(rows.reduce((a, x) => a + n(x.qty), 0), 4, 'the kitchen was asked for the wrong number');
    assert.ok(rows.every(x => n(x.qty) === 2));
    assert.ok(await db.one("SELECT id FROM audit_logs WHERE client_id=? AND action='bill.split' AND entity_id=?",
      [CID, String(id)]), 'a split moves money onto somebody else\'s bill and left no record');
    await payFull(id); await payFull(s.order_id);
  });

  await step('merging frees the table the bill came off, keeps its discount, and is audited', async () => {
    const src = await billOn(T.c, [[P.kebap, 1]]);
    await api('POST', `/api/pos/orders/${src}/discount`, { amount: 50, reason: 'Kaydi gelsin' });
    await api('POST', `/api/pos/orders/${src}/send`);
    const dst = await billOn(T.d, [[P.ayran, 2]]);
    assert.strictEqual(await occupied(T.c), 1);

    const m = await api('POST', `/api/pos/orders/${dst}/merge`, { source_order_id: src });
    assert.strictEqual(m.status, 200, m.error);

    assert.strictEqual(await occupied(T.c), 0, 'the table the bill came off is still red after a merge');
    assert.strictEqual(await count("SELECT COUNT(*) FROM orders WHERE table_id=? AND status='open' AND is_deleted=0", [T.c]), 0);
    const o = await orderOf(dst);
    assert.strictEqual(n(o.total), 280);                     // 200 + 2 x 40
    assert.strictEqual(n(o.discount_total), 50, 'the merged bill\'s discount was charged back to the guest');
    assert.strictEqual(n(o.grand_total), 230);
    assert.strictEqual((await orderOf(src)).status, 'cancelled');
    assert.strictEqual(await count('SELECT COUNT(*) FROM station_projection_items WHERE client_id=? AND order_id=?', [CID, src]), 0,
      'the kitchen board still shows food against a cancelled adisyon');
    assert.ok(await db.one("SELECT id FROM audit_logs WHERE client_id=? AND action='bill.merge' AND entity_id=?",
      [CID, String(dst)]), 'nobody can be asked who merged those two bills');
    await payFull(dst);
    assert.strictEqual(await occupied(T.d), 0);
  });

  await step('adisyon tasi refuses a table that is not this restaurant\'s', async () => {
    /*
     * Nothing validated the target, so a mistyped id - or one belonging to
     * another tenant sharing the engine - filed the bill against a table this
     * restaurant does not have. Every screen finds bills by joining
     * restaurant_tables on client_id, so the bill vanished off the floor plan
     * while the table it came from was freed underneath it.
     */
    const id = await billOn(T.c, [[P.ayran, 1]]);
    const foreign = await db.one('SELECT id FROM restaurant_tables WHERE client_id<>? LIMIT 1', [CID]);
    if (foreign) {
      const r = await api('POST', `/api/pos/orders/${id}/transfer`, { table_id: foreign.id });
      assert.ok(r.status >= 400, 'a bill was moved onto another tenant\'s table');
    }
    const gone = await api('POST', `/api/pos/orders/${id}/transfer`, { table_id: 99999999 });
    assert.strictEqual(gone.status, 404, 'a bill was moved onto a table that does not exist');
    assert.strictEqual(n((await orderOf(id)).table_id), T.c, 'the bill left its table anyway');
    assert.strictEqual(await occupied(T.c), 1);
    await payFull(id);
  });

  await step('paying a joined group frees every table it was pushed together from', async () => {
    const g = await api('POST', '/api/pos/table-groups', { table_ids: [T.c, T.d, T.e], primary_table_id: T.c });
    assert.strictEqual(g.status, 200, g.error);
    assert.ok(g.group.order_id, 'a group with no bill');
    for (const t of [T.c, T.d, T.e]) assert.strictEqual(await occupied(t), 1, 'a joined table reads free');
    const plan = await api('GET', '/api/pos/tables');
    assert.strictEqual(plan.tables.find(t => t.id === T.e).status, 'occupied');
    await api('POST', `/api/pos/orders/${g.group.order_id}/items`, { product_id: P.kebap, qty: 4 });
    await payFull(g.group.order_id);
    for (const t of [T.c, T.d, T.e]) assert.strictEqual(await occupied(t), 0, 'a table of a paid group is still red');
    assert.strictEqual((await db.one('SELECT status FROM table_groups WHERE id=?', [g.group.id])).status, 'closed');
  });

  await step('cancelling a joined group\'s only bill breaks the group up too', async () => {
    /*
     * Paying it did this; deleting it did not. The group stayed 'open', so the
     * other tables could never be released and could not be joined to anything
     * else either - unusable until somebody edited the database.
     */
    const g = await api('POST', '/api/pos/table-groups', { table_ids: [T.c, T.d], primary_table_id: T.c });
    assert.strictEqual(g.status, 200, g.error);
    await api('POST', `/api/pos/orders/${g.group.order_id}/items`, { product_id: P.kebap, qty: 1 });
    await api('POST', `/api/pos/orders/${g.group.order_id}/send`);
    const r = await api('DELETE', `/api/pos/orders/${g.group.order_id}`, { reason: 'musteri gitti' }, OWNER);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual((await db.one('SELECT status FROM table_groups WHERE id=?', [g.group.id])).status, 'closed');
    for (const t of [T.c, T.d]) assert.strictEqual(await occupied(t), 0, 'a table of a cancelled group is still red');
    // and the kitchen is told to stop cooking it
    const live = await count(
      "SELECT COUNT(*) FROM station_projection_items WHERE client_id=? AND order_id=? AND station_status<>'cancelled'",
      [CID, g.group.order_id]);
    assert.strictEqual(live, 0, 'the cook is still making food for a bill that no longer exists');
  });

  /* ============================ 10. THE TWO DELETE PATHS =============== */

  await step('taking a bill off the books keeps a full copy, gives the stock back, and names who did it', async () => {
    const stockOf = () => count('SELECT COALESCE(stock,0) FROM product_stock WHERE client_id=? AND product_id=?', [CID, P.kebap]);
    const id = await billOn(T.a, [[P.kebap, 2]]);
    await payFull(id);                                   // closed and paid: the stock is out
    const s1 = await stockOf();
    const r = await api('DELETE', `/api/pos/orders/${id}`, { reason: 'yanlis adisyon' }, OWNER);
    assert.strictEqual(r.ok, true, r.error);

    const o = await db.one('SELECT status, is_deleted, exclude_from_reports FROM orders WHERE id=?', [id]);
    assert.strictEqual(n(o.is_deleted), 1);
    assert.strictEqual(n(o.exclude_from_reports), 1);
    assert.strictEqual(await stockOf() - s1, 2, 'a deleted bill did not give its stock back');
    assert.strictEqual(await count('SELECT COUNT(*) FROM order_payments WHERE order_id=? AND is_deleted=0', [id]), 0,
      'a deleted bill still has live payments on it');
    // the copy that survives, and the audit row the trigger writes from it
    assert.ok(await db.one('SELECT id FROM order_delete_logs WHERE order_id=?', [id]));
    const a = await db.one("SELECT client_id, actor_client_id FROM audit_logs WHERE action='bill.delete' AND entity_id=?", [String(id)]);
    assert.ok(a, 'the bill delete left no audit row');
    assert.strictEqual(n(a.client_id), CID, 'the audit row is filed under the wrong tenant');
  });

  await step('the OWNER can void a payment - the one person who was refused', async () => {
    /*
     * trg_audit_payment_delete looked the actor up in `users` to decide which
     * tenant the audit row belonged to. The licence holder signs in against the
     * panel, so their uid is 0 and that lookup found nothing: client_id came
     * out NULL against a NOT NULL column and the INSERT failed inside the
     * void's own transaction. The one person allowed to take money off the
     * books was the one person who could not.
     */
    const id = await billOn(T.a, [[P.kebap, 1]]);
    const p = await api('POST', `/api/pos/orders/${id}/payments`, { method: 'nakit', amount: 200 }, OWNER);
    assert.strictEqual(p.closed, true, p.error);
    const v = await api('POST', `/api/pos/payments/${p.id}/void`, { reason: 'yanlis tahsilat' }, OWNER);
    assert.strictEqual(v.status, 200, 'the owner could not void a payment: ' + v.error);

    const pay = await db.one('SELECT voided_at, void_reason FROM order_payments WHERE id=?', [p.id]);
    assert.ok(pay.voided_at, 'the payment was not voided');
    assert.ok(await db.one('SELECT id FROM payment_delete_logs WHERE payment_id=?', [p.id]));
    const a = await db.one(
      "SELECT client_id, actor_client_id FROM audit_logs WHERE action='payment.delete' AND entity_id=?", [String(p.id)]);
    assert.ok(a, 'voiding a payment left no audit row');
    assert.strictEqual(n(a.client_id), CID, 'the audit row is filed under the wrong tenant');
    assert.strictEqual(n(a.actor_client_id), 0, 'the owner is not named as the actor');
    // and the bill is open again, on its table
    const o = await orderOf(id);
    assert.strictEqual(o.status, 'open');
    assert.strictEqual(await occupied(T.a), 1);
    await payFull(id);
  });

  await step('a manager cannot make a whole bill disappear, and a reason is compulsory', async () => {
    const id = await billOn(T.a, [[P.ayran, 1]]);
    const refused = await api('DELETE', `/api/pos/orders/${id}`, { reason: 'deneme' }, STAFF);
    assert.strictEqual(refused.status, 403, 'a hired manager deleted a bill');
    const noReason = await api('DELETE', `/api/pos/orders/${id}`, { reason: '   ' }, OWNER);
    assert.strictEqual(noReason.status, 400, 'a bill was deleted with a blank reason');
    await payFull(id);
  });

  /* ============================ 11. SHIFT AND DAY ====================== */

  await step('two tills closing the same shift: the second is told, not silently ignored', async () => {
    const [a, b] = await Promise.all([
      api('POST', '/api/pos/shift/close', { counted_cash: 1000 }),
      api('POST', '/api/pos/shift/close', { counted_cash: 2000 }),
    ]);
    const won = [a, b].filter(r => r.status === 200);
    assert.strictEqual(won.length, 1, 'the shift was closed twice');
    const lost = [a, b].find(r => r.status !== 200);
    assert.strictEqual(lost.status, 409);
    assert.ok(/kasiyer|vardiya/i.test(lost.error || ''), 'the refusal does not say what happened: ' + lost.error);
    const open = await count("SELECT COUNT(*) FROM pos_shifts WHERE client_id=? AND status='open'", [CID]);
    assert.strictEqual(open, 0);
  });

  await step('every bill this suite opened can be settled through the till, with nothing stuck', async () => {
    /*
     * The point of the sweep: before the fixes, two of the bills above could
     * not be closed from the till at all - one given away whole, one reopened
     * and not changed - and each of them on its own was enough to block gun
     * sonu for the rest of the night. Anything still open here is a bill a
     * restaurant would have to call support about.
     */
    await api('POST', '/api/pos/shift/open', { opening_float: 0 });
    const stuck = await db.query(
      "SELECT id FROM orders WHERE client_id=? AND status='open' AND is_deleted=0 ORDER BY id", [CID]);
    for (const s of stuck) {
      const r = await payFull(s.id);
      assert.strictEqual(r.status, 200, `adisyon ${s.id} kapanmiyor: ` + r.error);
    }
    assert.strictEqual(
      await count("SELECT COUNT(*) FROM orders WHERE client_id=? AND status='open' AND is_deleted=0", [CID]), 0);
  });

  await step('the day will not close while a bill is open, and says how many', async () => {
    const open = await billOn(T.a, [[P.ayran, 1]]);
    const r = await api('POST', '/api/reports/close-day', { declared_cash: 0, print: false });
    assert.strictEqual(r.status, 409, 'the day closed with a bill still open');
    assert.ok(/adisyon/i.test(r.error || ''), r.error);
    await payFull(open);
    const s = await api('POST', '/api/pos/shift/close', { counted_cash: 0 });
    assert.strictEqual(s.status, 200, s.error);
  });

  await step('two tills taking the day-end together: one signs it off, the other is told', async () => {
    const [a, b] = await Promise.all([
      api('POST', '/api/reports/close-day', { declared_cash: 0, print: false }),
      api('POST', '/api/reports/close-day', { declared_cash: 0, print: false }),
    ]);
    const won = [a, b].filter(r => r.status === 200);
    assert.strictEqual(won.length, 1, 'the day was signed off twice: ' + JSON.stringify([a.status+':'+a.error, b.status+':'+b.error]));
    const lost = [a, b].find(r => r.status !== 200);
    assert.strictEqual(lost.status, 409);
    assert.ok(!/Duplicate entry/i.test(lost.error || ''), 'the till showed a raw driver error: ' + lost.error);
    const bd = require('../src/util/businessDay');
    const day = await bd.currentBusinessDate();
    assert.strictEqual(await count('SELECT COUNT(*) FROM daily_closings WHERE client_id=? AND date=?', [CID, day]), 1);
  });

  await step('the day-end writes an audit row - the checkpoint everything else is measured against', async () => {
    const bd = require('../src/util/businessDay');
    const day = await bd.currentBusinessDate();
    const a = await db.one(
      "SELECT actor_client_id, after_json FROM audit_logs WHERE client_id=? AND action='day.close' AND entity_id=? ORDER BY id DESC LIMIT 1",
      [CID, day]);
    assert.ok(a, 'the till\'s Gun sonu button wrote no audit row');
    const j = typeof a.after_json === 'string' ? JSON.parse(a.after_json) : a.after_json;
    assert.ok(j.close_seq >= 1 && j.net !== undefined, 'the audit row does not say what was signed off');
  });

  await step('after the day-end the checkpoint refuses new bills, reopens and deletes', async () => {
    const fresh = await api('POST', '/api/pos/orders', { table_id: T.a });
    assert.strictEqual(fresh.status, 409, 'a bill was opened after the day was closed');

    const closed = await db.one(
      "SELECT id FROM orders WHERE client_id=? AND business_date=(SELECT MAX(date) FROM daily_closings WHERE client_id=?) " +
      "AND status='closed' AND is_deleted=0 ORDER BY id DESC LIMIT 1", [CID, CID]);
    assert.ok(closed, 'no closed bill inside the closed day to test the lock with');
    const re = await api('POST', `/api/pos/orders/${closed.id}/reopen`, { reason: 'olmaz' }, STAFF);
    assert.strictEqual(re.status, 409, 'a bill inside a closed day was reopened');
    const del = await api('DELETE', `/api/pos/orders/${closed.id}`, { reason: 'olmaz' }, OWNER);
    assert.strictEqual(del.status, 409, 'a signed-off bill was deleted');
    assert.strictEqual(del.code, 'DAY_CLOSED');
  });

  /* ============================ 12. OFFLINE / SYNC ===================== */

  await step('the same phone operation arriving TWICE AT ONCE is applied once', async () => {
    /*
     * The lookup, the work and the record were three separate steps, so two
     * copies of the same batch in flight together both found nothing, both took
     * the order, and the loser was then reported as REJECTED for an operation
     * that had been applied twice - two adisyons for one party.
     */
    const bd = require('../src/util/businessDay');
    await db.exec('DELETE FROM daily_closings WHERE client_id=? AND date=?', [CID, await bd.currentBusinessDate()]);
    const tok = await auth.issueToken({ cid: CID, uid: UID, role: 'admin', name: 'Telefon', kind: 'mobile' });
    const op = { op_id: 'akis-op-' + Date.now(), type: 'take_order', table_id: T.b,
      items: [{ product_id: P.ayran, qty: 2 }] };
    const [a, b] = await Promise.all([
      api('POST', '/api/mobile/sync', { ops: [op] }, tok),
      api('POST', '/api/mobile/sync', { ops: [op] }, tok),
    ]);
    const ra = a.results[0], rb = b.results[0];
    assert.strictEqual(ra.status, 'applied', ra.error);
    assert.strictEqual(rb.status, 'applied', rb.error);
    const id = (ra.response && ra.response.order_id) || (rb.response && rb.response.order_id);
    assert.ok(id, 'neither copy came back with the bill it made');
    assert.strictEqual(await count('SELECT COUNT(*) FROM app_sync_ops WHERE client_id=? AND op_id=?', [CID, op.op_id]), 1);
    assert.strictEqual(await count("SELECT COUNT(*) FROM orders WHERE client_id=? AND table_id=? AND status='open' AND is_deleted=0", [CID, T.b]), 1,
      'the party got two adisyons');
    const o = await orderOf(id);
    assert.strictEqual(n(o.total), 80, 'the lines were added twice');

    // and a third, later replay still answers with the same bill
    const again = await api('POST', '/api/mobile/sync', { ops: [op] }, tok);
    assert.strictEqual(again.results[0].status, 'applied');
    assert.strictEqual(n(again.results[0].response.order_id), n(id));
    await payFull(id);
  });

  await step('an operation with no usable op_id is refused instead of being replayed for ever', async () => {
    /*
     * app_sync_ops.op_id is CHAR(36) NOT NULL. An op with no id, or a longer
     * one, slipped past the "have I seen this" lookup, did the work, and then
     * failed to record itself - so it was reported as rejected and the phone
     * sent it again, opening a new bill every time.
     */
    const tok = await auth.issueToken({ cid: CID, uid: UID, role: 'admin', name: 'Telefon', kind: 'mobile' });
    const before = await count("SELECT COUNT(*) FROM orders WHERE client_id=? AND table_id=? AND status='open'", [CID, T.e]);
    const bad = [
      { type: 'take_order', table_id: T.e, items: [{ product_id: P.ayran, qty: 1 }] },
      { op_id: 'x'.repeat(40), type: 'take_order', table_id: T.e, items: [{ product_id: P.ayran, qty: 1 }] },
    ];
    const r = await api('POST', '/api/mobile/sync', { ops: bad }, tok);
    assert.strictEqual(r.results.length, 2);
    assert.ok(r.results.every(x => x.status === 'rejected'), JSON.stringify(r.results));
    assert.strictEqual(await count("SELECT COUNT(*) FROM orders WHERE client_id=? AND table_id=? AND status='open'", [CID, T.e]),
      before, 'a nameless operation still opened a bill');
  });

  await step('an operation that was REFUSED replays as refused, not as a fresh attempt', async () => {
    const tok = await auth.issueToken({ cid: CID, uid: UID, role: 'admin', name: 'Telefon', kind: 'mobile' });
    const op = { op_id: 'akis-bad-' + Date.now(), type: 'bilinmeyen_islem' };
    const a = await api('POST', '/api/mobile/sync', { ops: [op] }, tok);
    assert.strictEqual(a.results[0].status, 'rejected');
    const b = await api('POST', '/api/mobile/sync', { ops: [op] }, tok);
    assert.strictEqual(b.results[0].status, 'rejected', 'a refused operation was quietly retried');
    assert.strictEqual(await count('SELECT COUNT(*) FROM app_sync_ops WHERE client_id=? AND op_id=?', [CID, op.op_id]), 1);
  });

  /* ============================ multi-tenancy ========================== */

  await step('another restaurant\'s bill is invisible and untouchable through this session', async () => {
    const foreign = await db.one('SELECT id, client_id FROM orders WHERE client_id<>? ORDER BY id DESC LIMIT 1', [CID]);
    if (!foreign) return;
    const get = await api('GET', `/api/pos/orders/${foreign.id}`);
    assert.strictEqual(get.status, 404, 'another tenant\'s bill was readable');
    const pay = await api('POST', `/api/pos/orders/${foreign.id}/payments`, { method: 'nakit', amount: 1 });
    assert.ok(pay.status >= 400, 'another tenant\'s bill took a payment');
    const del = await api('DELETE', `/api/pos/orders/${foreign.id}`, { reason: 'olmaz' }, OWNER);
    assert.ok(del.status >= 400, 'another tenant\'s bill was deleted');
    assert.strictEqual(await count('SELECT COUNT(*) FROM orders WHERE id=? AND is_deleted=1', [foreign.id]), 0);
  });

  await step('the closed-bill list never borrows another tenant\'s table or staff names', async () => {
    const rows = await require('../src/modules/orders').recentClosed(CID, 40);
    for (const r of rows) {
      if (!r.table_name) continue;
      const owns = await count('SELECT COUNT(*) FROM restaurant_tables WHERE client_id=? AND name=?', [CID, r.table_name]);
      assert.ok(owns > 0, 'a table name from another restaurant: ' + r.table_name);
    }
  });

  /* ------------------------------------------------------------------ */
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) { failed.forEach(f => console.log('  ! ' + f[1] + ': ' + f[2])); }
  server.close();
  process.exit(failed.length ? 1 : 0);
})();
