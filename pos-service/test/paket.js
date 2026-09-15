'use strict';
/**
 * PAKET SERVİS - the board, the couriers, and the money.
 *
 * Against the real MariaDB and the real HTTP service. The things this suite
 * exists to stop are the ones that are invisible until a month later:
 *
 *   - a delivery counted TWICE in the day's takings, because the courier
 *     hand-over was written as income instead of as custody. This is the
 *     single most expensive bug this feature can have and it is checked
 *     against the Z report's own numbers, not against our own arithmetic;
 *   - a card going "yolda" with nobody carrying it, so its cash belongs to
 *     no shift and cannot be asked for;
 *   - a courier's shift closed while orders are still out;
 *   - two cashiers opening two shifts for one courier and the cash splitting
 *     between them;
 *   - the delivery fee silently not making it onto the bill;
 *   - a waiter reaching the board, or a cashier editing the delivery fee.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/paket.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7489';
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const del = require('../src/modules/delivery');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
let OWNER = null, CASHIER = null, WAITER = null;

async function api(method, p, body, token = OWNER) {
  const res = await fetch(BASE + p, {
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

/** The day's cash takings, as the finance side of the product computes them. */
async function cashTakings() {
  return Number(await db.value(
    `SELECT COALESCE(SUM(p.amount),0) FROM order_payments p
       JOIN orders o ON o.id = p.order_id AND o.client_id = p.client_id
      WHERE p.client_id=? AND p.method='nakit' AND p.is_deleted=0 AND p.voided_at IS NULL
        AND o.is_deleted=0 AND o.exclude_from_reports=0`, [CID]));
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - paket servis\n');

  OWNER = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Test Restoran', kind: 'tenant' });

  /* A clean board. The suite shares its database with the others, so it takes
     away only its own rows and never the menu or the staff. */
  await db.exec('DELETE FROM delivery_events WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM delivery_orders WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM courier_shifts WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM couriers WHERE client_id=?', [CID]);
  /*
   * The day, reopened. Whoever ran before this suite may have closed it -
   * smoke.js does, on purpose - and a closed day refuses every new bill, so
   * without this the whole suite fails on "Gun sonu alinmis" and says nothing
   * about paket servis. Same reason entegrasyon.js clears it.
   */
  await db.exec('DELETE FROM daily_closings WHERE client_id=?', [CID]).catch(() => {});
  await db.exec("UPDATE pos_shifts SET status='closed' WHERE client_id=? AND status='open'", [CID]);
  await api('POST', '/api/pos/shift/open', { opening_float: 500 });

  let productId, customerId, addressId, zoneId, courierId, slipOrder, _minOrderDelivery;

  await step('a product to sell exists', async () => {
    const p = await db.one(
      "SELECT id FROM products WHERE client_id=? AND is_active=1 AND use_in_pos=1 ORDER BY id LIMIT 1", [CID]);
    assert.ok(p, 'no sellable product - run test/smoke.js first');
    productId = p.id;
  });

  /* ------------------------------------------------------------ bölge */
  await step('every tenant has exactly one default zone, created on demand', async () => {
    await db.exec('DELETE FROM delivery_zones WHERE client_id=?', [CID]);
    const z = await del.ensureDefaultZone(CID);
    assert.ok(z && z.is_default, 'no default zone was created');
    const again = await del.ensureDefaultZone(CID);
    assert.strictEqual(again.id, z.id, 'a second default zone was created');
    zoneId = z.id;
  });

  await step('the delivery fee is editable and only one zone can be the default', async () => {
    await api('POST', '/api/delivery/zones', { id: zoneId, name: 'Merkez', fee: 25, est_minutes: 25, is_default: true });
    const far = await api('POST', '/api/delivery/zones', { name: 'Uzak semt', fee: 60, est_minutes: 45, is_default: true });
    assert.strictEqual(far.ok, true, far.error);
    const defs = await db.query('SELECT id FROM delivery_zones WHERE client_id=? AND is_default=1', [CID]);
    assert.strictEqual(defs.length, 1, 'more than one default zone');
    assert.strictEqual(defs[0].id, far.id, 'the new zone did not become the default');
    /* put the near zone back in charge, so the rest of the suite is priced at 25 */
    await api('POST', '/api/delivery/zones', { id: zoneId, name: 'Merkez', fee: 25, est_minutes: 25, is_default: true });
  });

  await step('the default zone cannot be deleted', async () => {
    const r = await api('DELETE', '/api/delivery/zones/' + zoneId);
    assert.strictEqual(r.status, 409, 'the default zone was deletable');
  });

  /* --------------------------------------------------------- müşteri */
  await step('an unknown number returns no customer rather than an error', async () => {
    const r = await api('GET', '/api/delivery/lookup?phone=05009998877');
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.customer, null);
  });

  await step('a customer and an address are saved and found by phone', async () => {
    /*
     * Find or create. `customers.phone` is UNIQUE - one person, one number -
     * so a suite that always inserts passes once and then fails for ever on
     * the same database. Re-runnability is not a nicety here: this suite is
     * run against whatever state the previous one left.
     */
    const existing = await db.one(
      "SELECT id FROM customers WHERE phone='0532 118 44 09' LIMIT 1");
    customerId = existing ? existing.id : (await api('POST', '/api/manage/customers',
      { first_name: 'Murat', last_name: 'Şen', phone: '0532 118 44 09' })).id;
    assert.ok(customerId, 'the customer was neither found nor created');
    /* a fresh address, so the snapshot check below is not looking at one an
       earlier run already edited */
    await db.exec('DELETE FROM customer_addresses WHERE client_id=? AND customer_id=?', [CID, customerId]);
    const a = await api('POST', '/api/delivery/addresses', {
      customer_id: customerId, tag: 'EV', zone_id: zoneId, district: 'Bahçelievler',
      address_text: 'Bahçelievler Mah. 7. Sk. No:12 D:4',
      directions: 'Kapıda zil çalışmıyor, arayın',
    });
    addressId = a.id;
    /* typed a different way - the match is on the digits, not the text */
    const r = await api('GET', '/api/delivery/lookup?phone=05321184409');
    assert.strictEqual(r.customer.id, customerId, 'the same number in another format missed');
    assert.strictEqual(r.addresses.length, 1);
    assert.strictEqual(r.addresses[0].is_default, 1, 'the first address is not the default');
    assert.ok(/zil/.test(r.addresses[0].directions), 'the door note was lost');
  });

  /* ---------------------------------------------------------- sipariş */
  let delId, orderId;
  await step('a phone order opens a bill with the zone fee already on it', async () => {
    const r = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    assert.strictEqual(r.ok, true, r.error);
    delId = r.deliveryId; orderId = r.orderId;
    assert.strictEqual(Number(r.fee), 25, 'the zone fee was not applied');
    const bill = await db.one('SELECT * FROM orders WHERE id=? AND client_id=?', [orderId, CID]);
    assert.strictEqual(bill.table_id, null, 'a delivery was given a table');
    assert.strictEqual(Number(bill.grand_total), 25, 'the fee is not on the bill');
  });

  await step('the address is SNAPSHOT, so editing it later does not rewrite history', async () => {
    await api('POST', '/api/delivery/addresses', {
      id: addressId, customer_id: customerId, zone_id: zoneId,
      address_text: 'TAŞINDI: Yeni Mah. 3. Sk. No:1', directions: null,
    });
    const d = await db.one('SELECT address_text FROM delivery_orders WHERE id=?', [delId]);
    assert.ok(/Bahçelievler/.test(d.address_text), 'the past order followed the edited address');
  });

  await step('the same bill cannot be put on the board twice', async () => {
    let threw = false;
    try {
      await db.exec(
        `INSERT INTO delivery_orders (client_id, order_id, business_date, source, address_text)
         VALUES (?,?,CURDATE(),'PHONE','')`, [CID, orderId]);
    } catch (_) { threw = true; }
    assert.ok(threw, 'a second companion row was accepted for one bill');
  });

  /* ----------------------------------------------------------- durum */
  await step('an illegal move is refused with the two states named', async () => {
    const r = await api('POST', `/api/delivery/orders/${delId}/status`, { status: 'DELIVERED' });
    assert.strictEqual(r.status, 409, 'NEW -> DELIVERED was allowed');
    assert.ok(/Yeni/.test(r.error) && /Teslim/.test(r.error), 'the refusal does not say what it refused: ' + r.error);
  });

  await step('nothing goes on the road without a courier', async () => {
    await api('POST', `/api/delivery/orders/${delId}/status`, { status: 'PREPARING' });
    const r = await api('POST', `/api/delivery/orders/${delId}/status`, { status: 'ON_ROUTE' });
    assert.strictEqual(r.status, 409, 'a delivery went out with no courier');
  });

  await step('assigning a courier opens their shift by itself', async () => {
    const k = await api('POST', '/api/delivery/couriers', { name: 'Emre Yıldız', phone: '0500 000 00 01' });
    courierId = k.id;
    const before = await db.value('SELECT COUNT(*) FROM courier_shifts WHERE client_id=? AND courier_id=?',
      [CID, courierId]);
    assert.strictEqual(Number(before), 0);
    const r = await api('POST', `/api/delivery/orders/${delId}/courier`, { courier_id: courierId });
    assert.strictEqual(r.ok, true, r.error);
    const open = await db.query(
      'SELECT * FROM courier_shifts WHERE client_id=? AND courier_id=? AND closed_at IS NULL', [CID, courierId]);
    assert.strictEqual(open.length, 1, 'assignment did not open exactly one shift');
  });

  await step('two cashiers assigning at once still make ONE shift', async () => {
    /* The generated column + unique key is the real guard; this proves the
       module survives losing the race rather than throwing at the till. */
    const other = await api('POST', '/api/delivery/couriers', { name: 'Kadir Aslan' });
    const both = await Promise.all([
      del.openCourierShift(CID, other.id, 0),
      del.openCourierShift(CID, other.id, 0),
    ]);
    assert.strictEqual(both[0].id, both[1].id, 'two open shifts for one courier');
    const n = await db.value(
      'SELECT COUNT(*) FROM courier_shifts WHERE client_id=? AND courier_id=? AND closed_at IS NULL',
      [CID, other.id]);
    assert.strictEqual(Number(n), 1);
  });

  /* ------------------------------------------------------------ para */
  let takingsBefore = 0;
  await step('marking delivered records the payment ONCE, on the bill', async () => {
    await api('POST', `/api/delivery/orders/${delId}/status`, { status: 'ON_ROUTE' });
    takingsBefore = await cashTakings();
    const r = await api('POST', `/api/delivery/orders/${delId}/status`, {
      status: 'DELIVERED', payment: { method: 'nakit', amount: 25 },
    });
    assert.strictEqual(r.ok, true, r.error);
    const after = await cashTakings();
    assert.strictEqual(Number((after - takingsBefore).toFixed(2)), 25, 'the delivery did not reach the takings');
    const pays = await db.query(
      'SELECT * FROM order_payments WHERE order_id=? AND client_id=? AND is_deleted=0', [orderId, CID]);
    assert.strictEqual(pays.length, 1, 'the payment was written ' + pays.length + ' times');
  });

  await step('the courier is shown holding exactly that cash', async () => {
    const d = await api('GET', '/api/delivery/couriers/' + courierId);
    assert.strictEqual(Number(d.cash), 25, 'the cash in the courier pocket is wrong: ' + d.cash);
  });

  await step('THE HAND-OVER IS NOT INCOME: settling adds nothing to the takings', async () => {
    const before = await cashTakings();
    const r = await api('POST', `/api/delivery/couriers/${courierId}/settle`, { taken_minor: 2500 });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(Number(r.expected), 25);
    assert.strictEqual(Number(r.variance), 0);
    const after = await cashTakings();
    assert.strictEqual(after, before, 'the courier hand-over was counted as a second sale');
  });

  await step('a short courier is recorded as a difference, not silently accepted', async () => {
    const r2 = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    await api('POST', `/api/delivery/orders/${r2.deliveryId}/status`, { status: 'PREPARING' });
    await api('POST', `/api/delivery/orders/${r2.deliveryId}/courier`, { courier_id: courierId });
    await api('POST', `/api/delivery/orders/${r2.deliveryId}/status`, { status: 'ON_ROUTE' });
    await api('POST', `/api/delivery/orders/${r2.deliveryId}/status`, {
      status: 'DELIVERED', payment: { method: 'nakit', amount: 25 } });
    const r = await api('POST', `/api/delivery/couriers/${courierId}/settle`, { taken_minor: 2000 });
    assert.strictEqual(Number(r.expected), 25);
    assert.strictEqual(Number(r.taken), 20);
    assert.strictEqual(Number(r.variance), -5, 'the shortfall was not recorded');
    const s = await db.one(
      'SELECT * FROM courier_shifts WHERE client_id=? AND courier_id=? ORDER BY id DESC LIMIT 1',
      [CID, courierId]);
    assert.strictEqual(Number(s.variance_minor), -500);
  });

  await step('a settled shift cannot be settled again', async () => {
    const r = await api('POST', `/api/delivery/couriers/${courierId}/settle`, {});
    assert.strictEqual(r.status, 409, 'a closed shift was settled twice');
  });

  await step('a courier still carrying orders cannot be cashed off', async () => {
    const r3 = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    await api('POST', `/api/delivery/orders/${r3.deliveryId}/status`, { status: 'PREPARING' });
    await api('POST', `/api/delivery/orders/${r3.deliveryId}/courier`, { courier_id: courierId });
    const r = await api('POST', `/api/delivery/couriers/${courierId}/settle`, {});
    assert.strictEqual(r.status, 409, 'the shift closed with an order still out');
    assert.ok(/teslim edilmemiş/.test(r.error), 'the refusal does not say why: ' + r.error);
  });

  /* ------------------------------------------------------------ pano */
  await step('the board lists the lanes and counts what is late', async () => {
    const r = await api('GET', '/api/delivery/board');
    assert.strictEqual(r.ok, true, r.error);
    for (const lane of ['NEW', 'PREPARING', 'ON_ROUTE', 'DELIVERED']) {
      assert.ok(Array.isArray(r.lanes[lane]), 'lane missing: ' + lane);
    }
    assert.ok(r.summary.delivered >= 2, 'the day count is wrong');
    assert.ok(r.lanes.PREPARING.length >= 1);
  });

  await step('lateness is measured against the promise, not one number for the restaurant', async () => {
    const row = (await api('GET', '/api/delivery/board')).lanes.PREPARING[0];
    await db.exec('UPDATE delivery_orders SET created_at = DATE_SUB(NOW(), INTERVAL 40 MINUTE), promised_minutes=60 WHERE id=?',
      [row.id]);
    let b = await api('GET', '/api/delivery/board');
    assert.strictEqual(b.lanes.PREPARING.find(x => x.id === row.id).late, false, '40 dk of a 60 dk promise read as late');
    await db.exec('UPDATE delivery_orders SET promised_minutes=30 WHERE id=?', [row.id]);
    b = await api('GET', '/api/delivery/board');
    assert.strictEqual(b.lanes.PREPARING.find(x => x.id === row.id).late, true, '40 dk of a 30 dk promise is late');
  });

  await step('an order still out does not vanish when the business day rolls', async () => {
    const row = (await api('GET', '/api/delivery/board')).lanes.PREPARING[0];
    await db.exec("UPDATE delivery_orders SET business_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY) WHERE id=?", [row.id]);
    const b = await api('GET', '/api/delivery/board');
    assert.ok(b.lanes.PREPARING.find(x => x.id === row.id), 'yesterday\'s open delivery fell off the board');
    await db.exec('UPDATE delivery_orders SET business_date = CURDATE() WHERE id=?', [row.id]);
  });

  /* ------------------------------------------------------------- izin */
  await step('a waiter cannot reach the board', async () => {
    const u = await db.one("SELECT id FROM users WHERE client_id=? AND role='waiter' LIMIT 1", [CID]);
    if (!u) return;   // the suite that creates one has not run; not this suite's business
    WAITER = await auth.issueToken({ cid: CID, uid: u.id, role: 'waiter', name: 'Garson', kind: 'staff' });
    const r = await api('GET', '/api/delivery/board', null, WAITER);
    assert.strictEqual(r.status, 403, 'a waiter reached the delivery board');
  });

  await step('a cashier works the board but cannot edit the delivery fee', async () => {
    const u = await db.one("SELECT id FROM users WHERE client_id=? AND role='cashier' LIMIT 1", [CID]);
    const uid = u ? u.id : (await db.insert(
      `INSERT INTO users (client_id, username, display_name, role, is_active, created_at)
       VALUES (?,?,?,'cashier',1,NOW())`, [CID, 'kasiyer_paket', 'Kasiyer']));
    CASHIER = await auth.issueToken({ cid: CID, uid, role: 'cashier', name: 'Kasiyer', kind: 'staff' });
    const board = await api('GET', '/api/delivery/board', null, CASHIER);
    assert.strictEqual(board.ok, true, 'the cashier cannot see the board: ' + board.error);
    const zone = await api('POST', '/api/delivery/zones', { id: zoneId, name: 'Bedava', fee: 0 }, CASHIER);
    assert.strictEqual(zone.status, 403, 'a cashier edited the delivery fee');
  });

  /* --------------------------------------------------------- platform */
  await step('a platform order lands on the same board', async () => {
    const oid = await require('../src/modules/orders').openOrder(CID, {
      tableId: null, waiterId: null, userId: 0, label: 'YS 9001', deviceId: null, offline: false });
    const id = await del.attachPlatformOrder(CID, oid, {
      source: 'YEMEKSEPETI', customerName: 'Elif Aydın', phone: '0505 000 00 00',
      addressText: 'Cumhuriyet Mah. Gül Sk. No:3 D:9', isPrepaid: true, deliveryFee: 0,
    });
    assert.ok(id);
    const again = await del.attachPlatformOrder(CID, oid, { source: 'YEMEKSEPETI' });
    assert.strictEqual(again, id, 'a replayed platform event made a second card');
    const b = await api('GET', '/api/delivery/board');
    const card = b.lanes.NEW.find(x => x.id === id);
    assert.ok(card, 'the platform order is not on the board');
    assert.strictEqual(card.source, 'YEMEKSEPETI');
    assert.strictEqual(card.is_prepaid, true);
  });

  await step('a prepaid delivery takes no money at the door', async () => {
    const b = await api('GET', '/api/delivery/board');
    const card = b.lanes.NEW.find(x => x.is_prepaid);
    await api('POST', `/api/delivery/orders/${card.id}/status`, { status: 'PREPARING' });
    await api('POST', `/api/delivery/orders/${card.id}/courier`, { courier_id: courierId });
    await api('POST', `/api/delivery/orders/${card.id}/status`, { status: 'ON_ROUTE' });
    const before = await cashTakings();
    await api('POST', `/api/delivery/orders/${card.id}/status`, { status: 'DELIVERED' });
    assert.strictEqual(await cashTakings(), before, 'a prepaid delivery added cash to the drawer');
  });

  /* ------------------------------------------------------- kurye fişi */
  await step('assigning a courier puts a slip on the printer with the address on it', async () => {
    /* Its own address, with a door note, rather than the shared fixture the
       snapshot check above deliberately edits out from under everything. */
    const aid = await api('POST', '/api/delivery/addresses', {
      customer_id: customerId, tag: 'IS', zone_id: zoneId,
      address_text: 'Kurye Testi Mah. Fis Sk. No:7 D:3',
      directions: 'Zil bozuk, kapiyi calin',
    });
    const r = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: aid.id });
    slipOrder = r.deliveryId;
    await api('POST', `/api/delivery/orders/${r.deliveryId}/status`, { status: 'PREPARING' });
    const before = Number(await db.value('SELECT COUNT(*) FROM print_jobs WHERE client_id=?', [CID]));
    await api('POST', `/api/delivery/orders/${r.deliveryId}/courier`, { courier_id: courierId });
    const after = Number(await db.value('SELECT COUNT(*) FROM print_jobs WHERE client_id=?', [CID]));
    assert.ok(after > before, 'no slip was queued when the courier was assigned');

    const job = await db.one(
      'SELECT content FROM print_jobs WHERE client_id=? ORDER BY id DESC LIMIT 1', [CID]);
    const text = Buffer.from(job.content, 'base64').toString('latin1');
    assert.ok(/KURYE FISI/.test(text), 'the slip is not a courier slip');
    /* The address and the door note are the whole point of the paper. */
    assert.ok(/Kurye Testi Mah/.test(text), 'the address is not on the slip');
    assert.ok(/Zil bozuk/.test(text), 'the door note is not on the slip');
    assert.ok(/TAHSIL EDILECEK/.test(text), 'the slip does not say what to collect');
  });

  await step('a prepaid delivery prints "collect nothing", not an amount', async () => {
    const oid = await require('../src/modules/orders').openOrder(CID, {
      tableId: null, waiterId: null, userId: 0, label: 'YS PRE', deviceId: null, offline: false });
    const id = await del.attachPlatformOrder(CID, oid, {
      source: 'YEMEKSEPETI', customerName: 'Ön Ödemeli', phone: '0500 111 22 33',
      addressText: 'Deneme Mah. 1. Sk. No:1', isPrepaid: true });
    await api('POST', `/api/delivery/orders/${id}/status`, { status: 'PREPARING' });
    await api('POST', `/api/delivery/orders/${id}/courier`, { courier_id: courierId });
    const job = await db.one(
      'SELECT content FROM print_jobs WHERE client_id=? ORDER BY id DESC LIMIT 1', [CID]);
    const text = Buffer.from(job.content, 'base64').toString('latin1');
    assert.ok(/ODENDI/.test(text) && /TAHSILAT YOK/.test(text),
      'a prepaid slip does not say the money is already taken');
    assert.ok(!/TAHSIL EDILECEK/.test(text), 'a prepaid slip still asks for money');
  });

  await step('the slip can be reprinted after a jam', async () => {
    const before = Number(await db.value('SELECT COUNT(*) FROM print_jobs WHERE client_id=?', [CID]));
    const r = await api('POST', `/api/delivery/orders/${slipOrder}/slip`, {});
    assert.strictEqual(r.ok, true, r.error);
    const after = Number(await db.value('SELECT COUNT(*) FROM print_jobs WHERE client_id=?', [CID]));
    assert.strictEqual(after, before + 1, 'the reprint produced ' + (after - before) + ' slips');
  });

  /* -------------------------------------------------- deneme siparişi */
  await step('a demo order is refused on a live connection and works on a simulator one', async () => {
    await api('POST', '/api/integrations/YEMEKSEPETI/connection', {
      environment: 'simulator', provider_store_id: 'V-1', username: 'u', password: 'p' });
    const ok1 = await api('POST', '/api/integrations/YEMEKSEPETI/demo-order', {});
    assert.strictEqual(ok1.ok, true, 'the simulator refused a demo order: ' + ok1.error);

    /* the same call against a production connection must not go through - a
       demonstration order in a real restaurant's takings is unrecoverable */
    await db.exec("UPDATE np_int_connections SET environment='production' WHERE client_id=? AND provider='YEMEKSEPETI'", [CID]);
    const r = await api('POST', '/api/integrations/YEMEKSEPETI/demo-order', {});
    assert.strictEqual(r.status, 409, 'a demo order was allowed on a live connection');
    assert.ok(/simülatör/i.test(r.error), 'the refusal does not say why: ' + r.error);
    await db.exec("UPDATE np_int_connections SET environment='simulator' WHERE client_id=? AND provider='YEMEKSEPETI'", [CID]);
  });

  /* ------------------------------------------------- alt sepet limiti */
  await step('THE ZONE MINIMUM IS ENFORCED - it used to be a number nobody read', async () => {
    await api('POST', '/api/delivery/zones', {
      id: zoneId, name: 'Merkez', fee: 25, min_order: 500, est_minutes: 25, is_default: true });
    const r = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    /* the bill holds only the 25 TL delivery fee, so the basket is 0 */
    const go1 = await api('POST', `/api/delivery/orders/${r.deliveryId}/status`, { status: 'PREPARING' });
    assert.strictEqual(go1.status, 409, 'an order under the zone minimum walked into the kitchen');
    assert.ok(/alt limitinin altında/.test(go1.error), 'the refusal does not explain: ' + go1.error);

    /* the guest says yes to the difference - the till must not be a wall */
    const go2 = await api('POST', `/api/delivery/orders/${r.deliveryId}/status`,
      { status: 'PREPARING', force: true });
    assert.strictEqual(go2.ok, true, 'an explicit override was refused: ' + go2.error);
    _minOrderDelivery = r.deliveryId;
  });

  await step('the delivery fee does not count towards the minimum basket', async () => {
    /* A 500 TL minimum means 500 TL of FOOD. Counting the 25 TL charge
       towards it would quietly lower the limit the owner set. */
    const r = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    await api('POST', '/api/pos/order/' + r.orderId + '/item',
      { product_id: productId, qty: 1 }).catch(() => {});
    const bill = await db.one('SELECT grand_total FROM orders WHERE id=?', [r.orderId]);
    const refused = await api('POST', `/api/delivery/orders/${r.deliveryId}/status`, { status: 'PREPARING' });
    if (Number(bill.grand_total) - 25 < 500) {
      assert.strictEqual(refused.status, 409, 'the fee was counted towards the basket');
    }
    await api('POST', '/api/delivery/zones', {
      id: zoneId, name: 'Merkez', fee: 25, min_order: 0, est_minutes: 25, is_default: true });
  });

  /* ------------------------------------------------- kurye hakedişi */
  await step('the courier rate comes from the zone and is frozen onto the delivery', async () => {
    await api('POST', '/api/delivery/zones', {
      id: zoneId, name: 'Merkez', fee: 25, courier_fee: 30, est_minutes: 25, is_default: true });
    const r = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    await api('POST', `/api/delivery/orders/${r.deliveryId}/status`, { status: 'PREPARING' });
    await api('POST', `/api/delivery/orders/${r.deliveryId}/courier`, { courier_id: courierId });
    const d1 = await db.one('SELECT courier_fee FROM delivery_orders WHERE id=?', [r.deliveryId]);
    assert.strictEqual(Number(d1.courier_fee), 30, 'the zone rate did not reach the delivery');

    /* raising the rate must not rewrite what last night owed */
    await api('POST', '/api/delivery/zones', {
      id: zoneId, name: 'Merkez', fee: 25, courier_fee: 45, est_minutes: 25, is_default: true });
    const d2 = await db.one('SELECT courier_fee FROM delivery_orders WHERE id=?', [r.deliveryId]);
    assert.strictEqual(Number(d2.courier_fee), 30, 'a rate change rewrote an assigned delivery');
  });

  await step("a courier's own rate overrides the zone, and zero is not the same as blank", async () => {
    await api('POST', '/api/delivery/couriers', { id: courierId, name: 'Emre Yıldız', fee_per_delivery: 12 });
    const r = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    await api('POST', `/api/delivery/orders/${r.deliveryId}/status`, { status: 'PREPARING' });
    await api('POST', `/api/delivery/orders/${r.deliveryId}/courier`, { courier_id: courierId });
    const d = await db.one('SELECT courier_fee FROM delivery_orders WHERE id=?', [r.deliveryId]);
    assert.strictEqual(Number(d.courier_fee), 12, "the courier's own rate was ignored");

    await api('POST', '/api/delivery/couriers', { id: courierId, name: 'Emre Yıldız', fee_per_delivery: 0 });
    const zero = await db.one('SELECT fee_per_delivery FROM couriers WHERE id=?', [courierId]);
    assert.strictEqual(Number(zero.fee_per_delivery), 0, 'zero was stored as blank');
    await api('POST', '/api/delivery/couriers', { id: courierId, name: 'Emre Yıldız', fee_per_delivery: null });
    const blank = await db.one('SELECT fee_per_delivery FROM couriers WHERE id=?', [courierId]);
    assert.strictEqual(blank.fee_per_delivery, null, 'blank was stored as zero');
  });

  /* ------------------------------------------------------- para üstü */
  await step('the slip tells the courier what change to take', async () => {
    const r = await api('POST', '/api/delivery/orders', {
      customer_id: customerId, address_id: addressId, change_for_minor: 50000 });
    await api('POST', `/api/delivery/orders/${r.deliveryId}/status`, { status: 'PREPARING' });
    await api('POST', `/api/delivery/orders/${r.deliveryId}/courier`, { courier_id: courierId });
    const job = await db.one('SELECT content FROM print_jobs WHERE client_id=? ORDER BY id DESC LIMIT 1', [CID]);
    const text = Buffer.from(job.content, 'base64').toString('latin1');
    assert.ok(/PARA USTU/.test(text), 'the slip does not tell the courier to take change');
    assert.ok(/500,00/.test(text), 'the slip does not say what the guest is paying with');
  });

  /* -------------------------------------------------- ileri tarihli */
  await step('an order taken now for tonight is not late all afternoon', async () => {
    const at = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const r = await api('POST', '/api/delivery/orders', {
      customer_id: customerId, address_id: addressId, scheduled_at: at });
    /* age it well past the promise: an ordinary order would be screaming */
    await db.exec('UPDATE delivery_orders SET created_at=DATE_SUB(NOW(), INTERVAL 90 MINUTE) WHERE id=?',
      [r.deliveryId]);
    const b = await api('GET', '/api/delivery/board');
    const card = b.lanes.NEW.find(x => x.id === r.deliveryId);
    assert.ok(card, 'the scheduled order is not on the board');
    assert.strictEqual(card.is_scheduled, true);
    assert.strictEqual(card.late, false, 'a scheduled order read as late four hours before it is due');
    assert.ok(b.summary.scheduled >= 1, 'the board does not count scheduled orders');
  });

  /* ------------------------------------------- aynı siparişi tekrarla */
  await step('repeating an order copies the items at TODAY\'s prices', async () => {
    const src = await db.one(
      `SELECT o.id FROM orders o JOIN order_items oi ON oi.order_id=o.id
        WHERE o.client_id=? AND o.is_deleted=0 GROUP BY o.id HAVING COUNT(*) >= 1
        ORDER BY o.id DESC LIMIT 1`, [CID]);
    const before = await db.query(
      'SELECT product_id, qty FROM order_items WHERE order_id=? AND is_deleted=0', [src.id]);
    const r = await api('POST', '/api/delivery/orders', {
      customer_id: customerId, address_id: addressId, repeat_order_id: src.id });
    assert.strictEqual(r.ok, true, r.error);
    const after = await db.query(
      'SELECT product_id, qty, unit_price FROM order_items WHERE order_id=? AND is_deleted=0', [r.orderId]);
    /* the fee line rides along too, so the copy is at least as long */
    assert.ok(after.length >= before.length, 'the repeat produced fewer lines than the original');
    for (const l of after) {
      if (!l.product_id) continue;
      const now = await db.one('SELECT price FROM products WHERE id=?', [l.product_id]);
      if (now) assert.ok(Number(l.unit_price) === Number(now.price) || Number(l.unit_price) > 0,
        'a repeated line did not take a current price');
    }
  });

  /* ---------------------------------------------------- kara liste */
  await step('a watched customer is announced but still served', async () => {
    await api('POST', `/api/delivery/customers/${customerId}/flag`,
      { level: 'watch', reason: 'Iki kez kapiyi acmadi' });
    const look = await api('GET', '/api/delivery/lookup?phone=05321184409');
    assert.ok(look.flag && look.flag.level === 'watch', 'the flag is not returned on lookup');
    const r = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    assert.strictEqual(r.ok, true, 'a watched customer was refused: ' + r.error);
  });

  await step('a blocked customer is refused, and the override is a deliberate act', async () => {
    await api('POST', `/api/delivery/customers/${customerId}/flag`,
      { level: 'block', reason: 'Uc kez sahte siparis' });
    const no = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    assert.strictEqual(no.status, 409, 'a blocked customer was served');
    assert.ok(/engellenmiş/.test(no.error), 'the refusal does not say why: ' + no.error);

    const yes = await api('POST', '/api/delivery/orders',
      { customer_id: customerId, address_id: addressId, force: true });
    assert.strictEqual(yes.ok, true, 'the override did not work: ' + yes.error);

    /* one standing flag per customer, however many were raised */
    const live = await db.query(
      'SELECT id FROM customer_flags WHERE client_id=? AND customer_id=? AND cleared_at IS NULL',
      [CID, customerId]);
    assert.strictEqual(live.length, 1, live.length + ' flags are in force at once');
    const all = await db.value(
      'SELECT COUNT(*) FROM customer_flags WHERE client_id=? AND customer_id=?', [CID, customerId]);
    assert.ok(Number(all) >= 2, 'the earlier flag was deleted instead of being kept as history');

    await api('DELETE', `/api/delivery/customers/${customerId}/flag`);
    const clear = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    assert.strictEqual(clear.ok, true, 'clearing the flag did not free the customer');
  });

  await step('a cashier cannot blacklist a customer; a manager can', async () => {
    const r = await api('POST', `/api/delivery/customers/${customerId}/flag`,
      { level: 'block', reason: 'kasiyer denemesi' }, CASHIER);
    assert.strictEqual(r.status, 403, 'a cashier wrote somebody onto the blacklist');
  });

  /* ------------------------------------------------- iptal sebebi */
  await step('CANCELLING REVERSES THE BILL - the takings come back down', async () => {
    /*
     * The screen promises "adisyon silinir, ciro ve stok geri alınır" on the
     * way in. For one release it did none of that: the card said İptal and
     * the money stayed in the day. This asserts the promise, not the status.
     */
    const r = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    await api('POST', '/api/pos/order/' + r.orderId + '/item', { product_id: productId, qty: 2 }).catch(() => {});
    const before = Number(await db.value(
      `SELECT COALESCE(SUM(grand_total),0) FROM orders
        WHERE client_id=? AND is_deleted=0 AND exclude_from_reports=0`, [CID]));
    const bill = Number(await db.value('SELECT grand_total FROM orders WHERE id=?', [r.orderId]));
    assert.ok(bill > 0, 'the fixture bill is empty, so this proves nothing');

    const out = await api('POST', `/api/delivery/orders/${r.deliveryId}/status`,
      { status: 'CANCELLED', cancel_code: 'MUSTERI_VAZGECTI', reason: 'vazgeçti' });
    assert.strictEqual(out.ok, true, out.error);
    assert.strictEqual(out.billReversed, true, 'the cancellation did not reverse the bill');

    const after = Number(await db.value(
      `SELECT COALESCE(SUM(grand_total),0) FROM orders
        WHERE client_id=? AND is_deleted=0 AND exclude_from_reports=0`, [CID]));
    assert.strictEqual(Number((before - after).toFixed(2)), Number(bill.toFixed(2)),
      'the cancelled bill is still in the takings');
    const o = await db.one('SELECT is_deleted, exclude_from_reports FROM orders WHERE id=?', [r.orderId]);
    assert.ok(o.is_deleted === 1 || o.exclude_from_reports === 1,
      'the bill is neither deleted nor excluded from the reports');
    const logged = await db.value(
      'SELECT COUNT(*) FROM order_delete_logs WHERE client_id=? AND order_id=?', [CID, r.orderId]);
    assert.ok(Number(logged) >= 1, 'nothing was written to order_delete_logs');
  });

  await step('cancelling asks why, and the report can count the answers', async () => {
    const r = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    const bare = await api('POST', `/api/delivery/orders/${r.deliveryId}/status`, { status: 'CANCELLED' });
    assert.strictEqual(bare.status, 409, 'an order was cancelled with no reason');
    const done = await api('POST', `/api/delivery/orders/${r.deliveryId}/status`,
      { status: 'CANCELLED', cancel_code: 'MUTFAK', reason: 'ocak bozuldu' });
    assert.strictEqual(done.ok, true, done.error);
    const rep = await api('GET', '/api/delivery/report');
    const row = (rep.cancels || []).find(c => c.code === 'MUTFAK');
    assert.ok(row && row.orders >= 1, 'the report does not group cancellations by reason');
    assert.strictEqual(row.label, 'Mutfak yetiştiremedi', 'the code has no readable label');
  });

  /* --------------------------------------------- kapıda ödeme türü */
  await step('a courier cannot take a payment type the restaurant does not allow', async () => {
    await api('POST', '/api/settings', { settings: { delivery_door_methods: 'nakit' } });
    const r = await api('POST', '/api/delivery/orders', { customer_id: customerId, address_id: addressId });
    await api('POST', `/api/delivery/orders/${r.deliveryId}/status`, { status: 'PREPARING' });
    await api('POST', `/api/delivery/orders/${r.deliveryId}/courier`, { courier_id: courierId });
    await api('POST', `/api/delivery/orders/${r.deliveryId}/status`, { status: 'ON_ROUTE' });
    const no = await api('POST', `/api/delivery/orders/${r.deliveryId}/status`, {
      status: 'DELIVERED', payment: { method: 'kredi_karti', amount: 25 } });
    assert.strictEqual(no.status, 409, 'a card was taken at the door when only cash is allowed');
    await api('POST', '/api/settings', { settings: { delivery_door_methods: 'nakit,kredi_karti,yemek_karti' } });
  });

  /* ----------------------------------------------------------- rapor */
  await step('the report splits the day by where the order came from', async () => {
    const r = await api('GET', '/api/delivery/report');
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(r.totals.orders >= 3, 'the report missed orders');
    const phone = r.by_source.find(x => x.source === 'PHONE');
    const ys = r.by_source.find(x => x.source === 'YEMEKSEPETI');
    assert.ok(phone && ys, 'the channels are not separated');
  });

  await step('the courier report answers is he quick, is he late, does his till add up', async () => {
    const r = await api('GET', '/api/delivery/report');
    const k = r.by_courier.find(x => x.name === 'Emre Yıldız');
    assert.ok(k, 'the courier is missing from the report');
    for (const col of ['orders', 'avg_minutes', 'max_minutes', 'late', 'on_time_pct',
                       'cash', 'shifts', 'variance', 'settled']) {
      assert.ok(col in k, 'the report has no "' + col + '" column');
    }
    assert.ok(k.on_time_pct >= 0 && k.on_time_pct <= 100, 'on_time_pct out of range: ' + k.on_time_pct);
    /*
     * The till difference comes from the SHIFTS and must not be multiplied by
     * the number of deliveries in them - the classic join bug in a report
     * like this. Two settled shifts were made above, one square and one five
     * lira short, so the total is exactly -5 however many orders they held.
     */
    assert.strictEqual(Number(k.variance), -5,
      'the courier cash difference is ' + k.variance + ', expected -5 (a join is multiplying it)');
  });

  await step('the lane labels the screen prints match the ones the server sends', async () => {
    /* Two small maps, one on each side of the wire. They are allowed to be
       duplicated - they are not allowed to disagree, which is what a cashier
       would see as a card that says one thing on the board and another in the
       courier table. */
    const fs = require('fs');
    const path = require('path');
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'screens', 'paket.js'), 'utf8');
    for (const [k, v] of Object.entries(del.LANE_LABEL)) {
      assert.ok(js.includes(`${k}: '${v}'`), `the screen does not label ${k} as "${v}"`);
    }
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) { for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]); }
  server && server.close && server.close();
  process.exit(failed.length ? 1 : 0);
})();
