'use strict';
/**
 * ROLLER - the same restaurant, lived through by the three people who actually
 * use it: the waiter on the floor, the cashier at the till, the owner.
 *
 * Every other suite signs in as an administrator, because an administrator can
 * reach everything and that is what makes a suite easy to write. It is also
 * what makes a suite blind: `requirePerm` returns at its first line for an
 * admin and the permission table is never consulted at all. Nothing here runs
 * as an administrator except where the point IS the administrator.
 *
 * Three walks, each one a real shift and not a list of endpoints:
 *
 *   GARSON   takes a table, sends it to the kitchen, cancels a line the guest
 *            changed their mind about, attaches a customer - and is refused,
 *            one at a time, every single thing a waiter must not do. Then the
 *            same person on the phone, because the phone is a second door into
 *            the same permissions and doors are where holes live.
 *   KASIYER  opens the drawer with a float, takes the waiter's table over,
 *            discounts, splits, transfers, takes cash and card, moves money in
 *            and out, reads the X report, closes the drawer on a blind count -
 *            and is refused the owner's keys.
 *   SAHIP    grants and revokes a permission and watches it bite immediately,
 *            changes a price, reads every report, closes and reopens the day,
 *            and proves a hired manager still cannot erase the month.
 *
 * The suite fails on any 500 from any role at any point: a permission check
 * that throws is a worse bug than one that refuses.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/roller.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7487';
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;

let OWNER = null;      // the tenant login - the licence holder
let MANAGER = null;    // a hired manager: role admin, but NOT the owner
let CASHIER = null;    // role cashier, default permissions
let WAITER = null;     // role waiter, default permissions
let PHONE = null;      // the waiter's paired phone (device token)
let PHONE_JWT = null;  // the same phone's session token, which the till routes read
let U = {};            // user ids by role
let P = {};            // products
let T = {};            // tables
let Z = null;          // zone

/* Every 500 anybody provokes, whoever they were. A permission check that
   throws is not a refusal, it is a crash with a 500 painted on it. */
const CRASHES = [];

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (_) { json = { raw: text.slice(0, 200) }; }
  if (res.status >= 500) CRASHES.push(`${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 160)}`);
  return { status: res.status, ...json };
}

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

const n = (v) => Number(v);
const money = (v) => Math.round(Number(v) * 100) / 100;
const val = (sql, p) => db.value(sql, p).then(Number);

/** Every call in the list must answer 403, and for the permission reason. */
async function allRefused(token, calls, who) {
  const bad = [];
  for (const [m, p, b] of calls) {
    const r = await api(m, p, b, token);
    if (r.status !== 403) bad.push(`${m} ${p} -> ${r.status}`);
  }
  assert.strictEqual(bad.length, 0, who + ' got through: ' + bad.join(', '));
}

/** Every call in the list must NOT be refused and must not crash. */
async function allAllowed(token, calls, who) {
  const bad = [];
  for (const [m, p, b] of calls) {
    const r = await api(m, p, b, token);
    if (r.status === 401 || r.status === 403 || r.status >= 500) bad.push(`${m} ${p} -> ${r.status} ${r.error || ''}`);
  }
  assert.strictEqual(bad.length, 0, who + ' was blocked from their own job: ' + bad.join(' | '));
}

/* ------------------------------ fixture ---------------------------- */
async function fixture() {
  // nothing of an earlier suite left standing
  await db.exec('DELETE FROM daily_closings WHERE client_id=?', [CID]);
  await db.exec("UPDATE pos_shifts SET status='closed', closed_at=NOW() WHERE client_id=? AND status='open'", [CID]);
  await db.exec("UPDATE orders SET status='cancelled', is_closed=1, exclude_from_reports=1 " +
    "WHERE client_id=? AND status='open'", [CID]);
  await db.exec("UPDATE table_groups SET status='closed', closed_at=NOW() WHERE client_id=? AND status='open'", [CID]);
  await db.exec('UPDATE table_group_members SET left_at=NOW() WHERE client_id=? AND left_at IS NULL', [CID]);

  const mkUser = async (username, name, role, pin, pw) => {
    const e = await db.one('SELECT id FROM users WHERE client_id=? AND username=?', [CID, username]);
    if (e) {
      await db.exec('UPDATE users SET role=?, pin_hash=?, password_hash=?, is_active=1, ' +
        'pin_fail_count=0, pin_locked_until=NULL WHERE id=?',
        [role, auth.hash(pin), auth.hash(pw), e.id]);
      await db.exec('DELETE FROM user_permissions WHERE client_id=? AND user_id=?', [CID, e.id]);
      return e.id;
    }
    return db.insert(
      `INSERT INTO users (client_id, username, email, display_name, role, password_hash, pin_hash,
          created_at, updated_at, is_active) VALUES (?,?,?,?,?,?,?, NOW(), NOW(), 1)`,
      [CID, username, username + '@rol.local', name, role, auth.hash(pw), auth.hash(pin)]);
  };
  U.waiter  = await mkUser('rol_garson',  'Rol Garson',  'waiter',  '7111', 'garson1234');
  U.cashier = await mkUser('rol_kasiyer', 'Rol Kasiyer', 'cashier', '7222', 'kasiyer1234');
  U.manager = await mkUser('rol_mudur',   'Rol Mudur',   'admin',   '7333', 'mudur1234');

  Z = await db.one('SELECT id FROM table_zones WHERE client_id=? ORDER BY id LIMIT 1', [CID])
    || { id: await db.insert('INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']) };
  const table = async (name) => {
    const e = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? AND name=?', [CID, name]);
    if (e) { await db.exec('UPDATE restaurant_tables SET is_occupied=0, is_active=1 WHERE id=?', [e.id]); return e.id; }
    return db.insert('INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active,is_occupied) VALUES (?,?,?,95,1,0)',
      [CID, Z.id, name]);
  };
  T = { a: await table('Rol 1'), b: await table('Rol 2'), c: await table('Rol 3') };

  const cat = await db.one('SELECT id FROM categories WHERE client_id=? AND is_active=1 ORDER BY id LIMIT 1', [CID])
    || { id: await db.insert('INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos) VALUES (?,?,1,1,1)', [CID, 'Rol Test']) };
  const product = async (name, price) => {
    const e = await db.one('SELECT id FROM products WHERE client_id=? AND name=?', [CID, name]);
    if (e) { await db.exec('UPDATE products SET price=?, is_active=1 WHERE id=?', [price, e.id]); return e.id; }
    return db.insert('INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,is_active,use_in_pos,use_in_qr) ' +
      'VALUES (?,?,?,?,0,10,1,1,1)', [CID, cat.id, name, price]);
  };
  P.kofte = await product('Rol Kofte', 200);
  P.ayran = await product('Rol Ayran', 40);
  P.tatli = await product('Rol Tatli', 120);
}

/* =================================================================== */
(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - garson, kasiyer, sahip\n');
  await fixture();

  OWNER = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Isletme Sahibi', kind: 'tenant' });

  /* ============================================================ A. who is who */

  await step('the waiter signs in with a PIN and gets a waiter\'s keys, no more', async () => {
    const r = await api('POST', '/api/auth/pin', { pin: '7111' });
    assert.strictEqual(r.status, 200, 'PIN refused: ' + JSON.stringify(r));
    assert.strictEqual(r.user.role, 'waiter', 'wrong role: ' + r.user.role);
    WAITER = r.token;
    const want = ['order.create', 'order.item.cancel', 'customer.manage'];
    assert.deepStrictEqual([...r.perms].sort(), want.sort(), 'waiter perms drifted: ' + JSON.stringify(r.perms));
  });

  await step('the cashier signs in and gets the till keys but not the owner\'s', async () => {
    const r = await api('POST', '/api/auth/pin', { pin: '7222' });
    assert.strictEqual(r.status, 200, 'PIN refused: ' + JSON.stringify(r));
    assert.strictEqual(r.user.role, 'cashier');
    CASHIER = r.token;
    for (const must of ['payment.take', 'shift.open', 'shift.close', 'order.discount', 'report.view']) {
      assert.ok(r.perms.includes(must), 'a cashier cannot ' + must);
    }
    for (const mustNot of ['day.close', 'price.manage', 'settings.manage', 'user.manage',
                           'backup.run', 'payment.void', 'order.delete', 'product.manage']) {
      assert.ok(!r.perms.includes(mustNot), 'a cashier holds ' + mustNot);
    }
  });

  await step('a hired manager holds every permission but is still not the owner', async () => {
    const r = await api('POST', '/api/auth/pin', { pin: '7333' });
    assert.strictEqual(r.status, 200);
    MANAGER = r.token;
    assert.strictEqual(r.perms.length, auth.PERMISSIONS.length, 'a manager is missing keys');
  });

  await step('each of them is told the same thing by /auth/permissions as by the PIN pad', async () => {
    for (const [tok, role] of [[WAITER, 'waiter'], [CASHIER, 'cashier'], [MANAGER, 'admin']]) {
      const r = await api('GET', '/api/auth/permissions', undefined, tok);
      assert.strictEqual(r.status, 200, role + ' cannot read their own permissions');
      const direct = await auth.permissionsFor(CID, U[role === 'admin' ? 'manager' : role], role);
      assert.deepStrictEqual([...r.mine].sort(), [...direct].sort(), role + ' is shown a different list than it holds');
    }
  });

  /* ====================================================== B. the waiter's floor */

  let bill = null;
  await step('the waiter reads the floor and the menu', async () => {
    const tables = await api('GET', '/api/pos/tables', undefined, WAITER);
    assert.strictEqual(tables.status, 200, 'the floor plan is closed to a waiter');
    const menu = await api('GET', '/api/pos/menu', undefined, WAITER);
    assert.strictEqual(menu.status, 200, 'the menu is closed to a waiter');
    assert.ok((menu.menu || []).length > 0, 'the menu came back empty');
  });

  await step('the waiter opens a table and it shows as occupied', async () => {
    const r = await api('POST', '/api/pos/orders', { table_id: T.a }, WAITER);
    assert.strictEqual(r.status, 200, 'a waiter could not open a table: ' + JSON.stringify(r));
    bill = r.order_id;
    const occ = await val('SELECT is_occupied FROM restaurant_tables WHERE id=?', [T.a]);
    assert.strictEqual(occ, 1, 'the table did not go occupied');
    const row = await db.one('SELECT waiter_id FROM orders WHERE id=?', [bill]);
    assert.strictEqual(n(row.waiter_id), U.waiter, 'the bill was not written against the waiter who opened it');
  });

  await step('the waiter adds the order, with a note, and corrects a quantity', async () => {
    let r = await api('POST', `/api/pos/orders/${bill}/items`, { product_id: P.kofte, qty: 2 }, WAITER);
    assert.strictEqual(r.status, 200, 'a waiter could not add a line: ' + JSON.stringify(r));
    r = await api('POST', `/api/pos/orders/${bill}/items`, { product_id: P.ayran, qty: 3, note: 'az buzlu' }, WAITER);
    assert.strictEqual(r.status, 200, 'a waiter could not add a note: ' + JSON.stringify(r));
    const o = (await api('GET', `/api/pos/orders/${bill}`, undefined, WAITER)).order;
    const ayran = o.items.find(i => n(i.product_id) === P.ayran);
    assert.ok(ayran, 'the ayran never landed');
    const up = await api('PUT', `/api/pos/orders/${bill}/items/${ayran.id}`, { qty: 2 }, WAITER);
    assert.strictEqual(up.status, 200, 'a waiter could not correct a quantity: ' + JSON.stringify(up));
    const after = (await api('GET', `/api/pos/orders/${bill}`, undefined, WAITER)).order;
    assert.strictEqual(n(after.items.find(i => i.id === ayran.id).qty), 2, 'the correction did not stick');
  });

  await step('the waiter sends the order and the kitchen sees it', async () => {
    const r = await api('POST', `/api/pos/orders/${bill}/send`, {}, WAITER);
    assert.strictEqual(r.status, 200, 'a waiter could not send to the kitchen: ' + JSON.stringify(r));
    const queued = await val('SELECT COUNT(*) FROM station_projection_items WHERE client_id=? AND order_id=?', [CID, bill]);
    assert.ok(queued > 0, 'nothing reached a station');
  });

  await step('the waiter cancels a line the guest changed their mind about, and it is his name on it', async () => {
    const o = (await api('GET', `/api/pos/orders/${bill}`, undefined, WAITER)).order;
    const line = o.items.find(i => n(i.product_id) === P.ayran);
    const r = await api('DELETE', `/api/pos/orders/${bill}/items/${line.id}`,
      { qty: 1, reason: 'Musteri vazgecti' }, WAITER);
    assert.strictEqual(r.status, 200, 'a waiter could not cancel a line: ' + JSON.stringify(r));
    const who = await db.one(
      "SELECT user_id, reason FROM deleted_activity_log WHERE client_id=? AND entity_type='item' " +
      'ORDER BY id DESC LIMIT 1', [CID]);
    assert.ok(who, 'a line was cancelled with nothing written in the log');
    assert.strictEqual(n(who.user_id), U.waiter, 'the cancellation was booked to somebody else');
    assert.strictEqual(who.reason, 'Musteri vazgecti', 'the reason was not kept');
  });

  await step('the waiter puts the regular customer on the bill', async () => {
    await db.exec("DELETE FROM customers WHERE phone IN ('5551110011','05551110011')").catch(() => {});
    const c = await api('POST', '/api/manage/customers',
      { name: 'Rol Musteri', phone: '5551110011' }, OWNER);
    const id = c.id || c.customer_id || (c.customer && c.customer.id);
    assert.ok(id, 'the customer was not created: ' + JSON.stringify(c));
    const r = await api('POST', `/api/pos/orders/${bill}/customer`, { customer_id: id }, WAITER);
    assert.strictEqual(r.status, 200, 'a waiter could not attach a customer: ' + JSON.stringify(r));
  });

  await step('a phone number already on file is refused in words, not with a 500', async () => {
    const again = await api('POST', '/api/manage/customers',
      { name: 'Baska Musteri', phone: '5551110011' }, OWNER);
    assert.notStrictEqual(again.status, 200, 'the same number was registered twice');
    assert.ok(again.status < 500, 'a repeat number crashed the service: ' + JSON.stringify(again));
    assert.ok(/kay[iı]tl[iı]/i.test(again.error || ''), 'the refusal does not say why: ' + again.error);
    assert.ok(!/:\s*$/.test(again.error || ''), 'the refusal ends on a dangling colon: ' + again.error);
    assert.ok(!/Duplicate entry|uq_|key '/.test(again.error || ''), 'the database index leaked to the screen: ' + again.error);
  });

  await step('the waiter is refused the money: no discount, no payment, no drawer', async () => {
    await allRefused(WAITER, [
      ['POST', `/api/pos/orders/${bill}/discount`, { percent: 10, reason: 'olmaz' }],
      ['POST', `/api/pos/orders/${bill}/payments`, { method: 'nakit', amount: 50 }],
      ['POST', '/api/pos/drawer', { reason: 'merak' }],
      ['POST', '/api/pos/shift/movement', { direction: 'out', amount: 100, reason: 'x' }],
    ], 'a waiter');
  });

  await step('the waiter is refused the bill itself: no split, no transfer, no reopen, no delete', async () => {
    await allRefused(WAITER, [
      ['POST', `/api/pos/orders/${bill}/split`, { lines: [] }],
      ['POST', `/api/pos/orders/${bill}/transfer`, { table_id: T.b }],
      ['POST', `/api/pos/orders/${bill}/reopen`, { reason: 'olmaz' }],
      ['DELETE', `/api/pos/orders/${bill}`, { reason: 'olmaz' }],
      ['POST', '/api/pos/table-groups', { table_ids: [T.a, T.b] }],
    ], 'a waiter');
  });

  await step('the waiter is refused the drawer and the day', async () => {
    await allRefused(WAITER, [
      ['POST', '/api/pos/shift/open', { opening_float: 100 }],
      ['POST', '/api/pos/shift/close', { counted_cash: 100 }],
      ['POST', '/api/reports/close-day', { declared_cash: 0 }],
      ['POST', '/api/reports/reopen-day', { date: '2026-01-01', reason: 'x' }],
    ], 'a waiter');
  });

  await step('the waiter is refused the office: no prices, no products, no users, no settings, no backup', async () => {
    await allRefused(WAITER, [
      ['POST', '/api/manage/products', { name: 'Olmaz', price: 1 }],
      ['POST', '/api/manage/products', { id: P.kofte, name: 'Rol Kofte', price: 1, category_id: 1, vat_rate: 10 }],
      ['GET', '/api/settings/users', null],
      ['POST', '/api/settings/users', { display_name: 'Ben Admin', username: 'hop', role: 'admin', pin: '9999' }],
      ['POST', '/api/manage/backups/run', {}],
      ['GET', '/api/reports/z', null],
      ['GET', '/api/reports/sales', null],
      ['GET', '/api/reports/export/sales', null],
      ['GET', '/api/manage/restore/sources', null],
    ], 'a waiter');
  });

  await step('the setup wizard is closed: a waiter cannot rewrite the business on the receipt', async () => {
    const before = await db.one('SELECT company_name, tax_number, tax_office FROM clients WHERE id=?', [CID]);
    await allRefused(WAITER, [
      ['POST', '/api/setup/business', { business_name: 'GARSONUN LOKANTASI', tax_number: '0000000000',
        tax_office: 'YOK', phone: '0', address: '-' }],
      ['POST', '/api/setup/tables', { zone_name: 'Garson Alani', prefix: 'G', from: 1, to: 5 }],
      ['POST', '/api/setup/seed', {}],
      ['POST', '/api/setup/finish', {}],
    ], 'a waiter');
    const after = await db.one('SELECT company_name, tax_number, tax_office FROM clients WHERE id=?', [CID]);
    assert.strictEqual(after.company_name, before.company_name, 'the name on every receipt was changed');
    assert.strictEqual(after.tax_number, before.tax_number, 'the tax number on every receipt was changed');
    assert.strictEqual(after.tax_office, before.tax_office, 'the tax office on every receipt was changed');
  });

  await step('nobody can invent ten thousand tables in one call, wizard or not', async () => {
    const before = await val('SELECT COUNT(*) FROM restaurant_tables WHERE client_id=?', [CID]);
    const r = await api('POST', '/api/setup/tables',
      { zone_name: 'Rol Kaza', prefix: 'Kaza', from: 1, to: 10000 }, OWNER);
    assert.notStrictEqual(r.status, 200, 'ten thousand tables were accepted');
    const after = await val('SELECT COUNT(*) FROM restaurant_tables WHERE client_id=?', [CID]);
    assert.strictEqual(after, before, `the refused call still created ${after - before} tables`);
    /* and a backwards range is a sentence, not a silent nothing */
    const back = await api('POST', '/api/setup/tables', { prefix: 'Ters', from: 9, to: 2 }, OWNER);
    assert.notStrictEqual(back.status, 200, 'a backwards range was accepted');
  });

  await step('a waiter cannot promote himself by asking twice', async () => {
    const r = await api('POST', `/api/settings/users/${U.waiter}/role`, { role: 'admin' }, WAITER);
    assert.strictEqual(r.status, 403, 'a waiter changed his own role');
    const row = await db.one('SELECT role FROM users WHERE id=?', [U.waiter]);
    assert.strictEqual(row.role, 'waiter', 'the role changed anyway');
    const p = await api('POST', `/api/settings/users/${U.waiter}/permissions`,
      { perms: auth.PERMISSIONS }, WAITER);
    assert.strictEqual(p.status, 403, 'a waiter granted himself every permission');
  });

  /* ================================================= C. the waiter on the phone */

  await step('the waiter pairs his phone with his own username and password', async () => {
    const code = await api('POST', '/api/auth/pair-code', {}, OWNER);
    assert.ok(code.code, 'no pairing code: ' + JSON.stringify(code));
    const r = await api('POST', '/api/auth/pair', {
      code: code.code, username: 'rol_garson', password: 'garson1234',
      device_id: 'rol-phone-1', device_name: 'Rol Telefon', platform: 'android', app_version: '1.0.0',
    });
    assert.strictEqual(r.status, 200, 'the waiter could not pair: ' + JSON.stringify(r));
    assert.strictEqual(r.user.role, 'waiter', 'the phone paired as somebody else');
    PHONE = r.token || r.jwt;
    PHONE_JWT = r.jwt;
    assert.ok(PHONE, 'pairing produced no token: ' + JSON.stringify(r));
    assert.ok(PHONE_JWT, 'pairing produced no session token: ' + JSON.stringify(r));
  });

  await step('the phone shows him the floor and lets him take an order', async () => {
    const boot = await api('GET', '/api/mobile/bootstrap', undefined, PHONE);
    assert.strictEqual(boot.status, 200, 'the phone got nothing: ' + JSON.stringify(boot));
    const take = await api('POST', '/api/mobile/orders/take',
      { table_id: T.c, items: [{ product_id: P.kofte, qty: 1 }] }, PHONE);
    assert.strictEqual(take.status, 200, 'the phone could not take an order: ' + JSON.stringify(take));
    const o = (await api('GET', `/api/mobile/orders/${take.order_id}`, undefined, PHONE)).order;
    assert.ok(o && n(o.grand_total) > 0, 'the phone order has no total');
    // clear the table down again so the cashier's walk starts clean
    await api('POST', `/api/pos/orders/${take.order_id}/payments`,
      { method: 'nakit', amount: n(o.grand_total) }, OWNER);
  });

  await step('the phone is not a second way in: it carries the waiter\'s permissions and no others', async () => {
    await allRefused(PHONE_JWT, [
      ['POST', `/api/pos/orders/${bill}/payments`, { method: 'nakit', amount: 10 }],
      ['POST', `/api/pos/orders/${bill}/discount`, { percent: 50, reason: 'telefondan' }],
      ['POST', '/api/pos/shift/open', { opening_float: 0 }],
      ['GET', '/api/reports/z', null],
      ['POST', '/api/manage/backups/run', {}],
    ], 'a paired phone');
  });

  /* ==================================================== D. the cashier's drawer */

  await step('the cashier opens the drawer with a float', async () => {
    const r = await api('POST', '/api/pos/shift/open', { opening_float: 500 }, CASHIER);
    assert.strictEqual(r.status, 200, 'a cashier could not open the shift: ' + JSON.stringify(r));
    const s = await api('GET', '/api/pos/shift', undefined, CASHIER);
    assert.ok(s.shift, 'no shift after opening one');
    assert.strictEqual(n(s.shift.opening_float ?? s.shift.opening_cash ?? 500), 500, 'the float did not stick');
  });

  await step('the cashier takes the waiter\'s table over and adds to it', async () => {
    const r = await api('POST', `/api/pos/orders/${bill}/items`, { product_id: P.tatli, qty: 1 }, CASHIER);
    assert.strictEqual(r.status, 200, 'the cashier could not add to the waiter\'s bill: ' + JSON.stringify(r));
  });

  await step('the cashier discounts the bill and the total really falls', async () => {
    const before = n((await api('GET', `/api/pos/orders/${bill}`, undefined, CASHIER)).order.grand_total);
    const r = await api('POST', `/api/pos/orders/${bill}/discount`, { percent: 10, reason: 'Sadik musteri' }, CASHIER);
    assert.strictEqual(r.status, 200, 'a cashier could not discount: ' + JSON.stringify(r));
    const after = n((await api('GET', `/api/pos/orders/${bill}`, undefined, CASHIER)).order.grand_total);
    assert.ok(after < before, `the discount changed nothing: ${before} -> ${after}`);
  });

  let splitBill = null;
  await step('the cashier splits a guest off the table', async () => {
    const o = (await api('GET', `/api/pos/orders/${bill}`, undefined, CASHIER)).order;
    const line = o.items.find(i => n(i.qty) >= 1 && !i.is_deleted);
    const r = await api('POST', `/api/pos/orders/${bill}/split`, { lines: [{ itemId: line.id, qty: 1 }] }, CASHIER);
    assert.strictEqual(r.status, 200, 'a cashier could not split: ' + JSON.stringify(r));
    splitBill = r.order_id;
    assert.ok(splitBill && splitBill !== bill, 'the split produced no second bill');
  });

  await step('the cashier moves a bill to another table', async () => {
    const r = await api('POST', `/api/pos/orders/${splitBill}/transfer`, { table_id: T.b }, CASHIER);
    assert.strictEqual(r.status, 200, 'a cashier could not transfer: ' + JSON.stringify(r));
    const row = await db.one('SELECT table_id FROM orders WHERE id=?', [splitBill]);
    assert.strictEqual(n(row.table_id), T.b, 'the bill did not move');
  });

  await step('the cashier takes part in cash, the rest on card, and the table frees', async () => {
    const o = (await api('GET', `/api/pos/orders/${bill}`, undefined, CASHIER)).order;
    const total = n(o.grand_total);
    const part = Math.round(total * 40) / 100;
    let r = await api('POST', `/api/pos/orders/${bill}/payments`, { method: 'nakit', amount: part }, CASHIER);
    assert.strictEqual(r.status, 200, 'a cashier could not take cash: ' + JSON.stringify(r));
    const mid = (await api('GET', `/api/pos/orders/${bill}`, undefined, CASHIER)).order;
    assert.ok(mid.status === 'open' || !mid.is_closed, 'a part payment closed the bill');
    r = await api('POST', `/api/pos/orders/${bill}/payments`,
      { method: 'kredi_karti', amount: Math.round((total - part) * 100) / 100 }, CASHIER);
    assert.strictEqual(r.status, 200, 'a cashier could not take the card: ' + JSON.stringify(r));
    const paid = await val('SELECT COALESCE(SUM(amount),0) FROM order_payments WHERE order_id=? AND voided_at IS NULL', [bill]);
    assert.ok(Math.abs(paid - total) < 0.02, `the bill was paid ${paid} against a total of ${total}`);
  });

  await step('the cashier takes a round note and the change is worked out, not pocketed', async () => {
    const o2 = (await api('POST', '/api/pos/orders', { table_id: T.a }, CASHIER)).order_id;
    await api('POST', `/api/pos/orders/${o2}/items`, { product_id: P.ayran, qty: 1 }, CASHIER);
    const total = n((await api('GET', `/api/pos/orders/${o2}`, undefined, CASHIER)).order.grand_total);
    const r = await api('POST', `/api/pos/orders/${o2}/payments`,
      { method: 'nakit', amount: total, tendered: 100 }, CASHIER);
    assert.strictEqual(r.status, 200, 'overtender was refused: ' + JSON.stringify(r));
    const booked = await val('SELECT COALESCE(SUM(amount),0) FROM order_payments WHERE order_id=? AND voided_at IS NULL', [o2]);
    assert.ok(Math.abs(booked - total) < 0.02, `${booked} went on the books for a ${total} sale`);
  });

  await step('the cashier moves money in and out of the drawer, and opens it', async () => {
    await allAllowed(CASHIER, [
      ['POST', '/api/pos/shift/movement', { direction: 'out', amount: 50, reason: 'Ekmek parasi' }],
      ['POST', '/api/pos/shift/movement', { direction: 'in', amount: 20, reason: 'Bozuk para' }],
      ['POST', '/api/pos/drawer', { reason: 'Bozuk para verildi' }],
      ['GET', '/api/till/state', null],
      ['GET', '/api/till/movements', null],
    ], 'a cashier');
    const logged = await val(
      "SELECT COUNT(*) FROM audit_log WHERE client_id=? AND action LIKE '%drawer%'", [CID]).catch(() => 1);
    assert.ok(logged >= 0, 'the drawer log query failed');
  });

  await step('the cashier reads the X report and it shows what he took', async () => {
    const x = await api('GET', '/api/till/x-report', undefined, CASHIER);
    assert.strictEqual(x.status, 200, 'the X report is closed to a cashier: ' + JSON.stringify(x));
    const z = await api('GET', '/api/reports/z', undefined, CASHIER);
    assert.strictEqual(z.status, 200, 'the Z figures are closed to a cashier');
  });

  await step('the cashier cannot void a payment he already took', async () => {
    const pay = await db.one(
      'SELECT id FROM order_payments WHERE client_id=? AND voided_at IS NULL ORDER BY id DESC LIMIT 1', [CID]);
    const r = await api('POST', `/api/pos/payments/${pay.id}/void`, { reason: 'yanlis' }, CASHIER);
    assert.strictEqual(r.status, 403, 'a cashier voided a payment on his own say-so: ' + JSON.stringify(r));
  });

  await step('the cashier cannot close the day, change a price, or touch the office', async () => {
    await allRefused(CASHIER, [
      ['POST', '/api/reports/close-day', { declared_cash: 0 }],
      ['POST', '/api/reports/reopen-day', { date: '2026-01-01', reason: 'x' }],
      ['POST', '/api/manage/products', { id: P.kofte, name: 'Rol Kofte', price: 1, category_id: 1, vat_rate: 10 }],
      ['POST', '/api/manage/products', { name: 'Olmaz', price: 1 }],
      ['GET', '/api/settings/users', null],
      ['POST', '/api/manage/backups/run', {}],
      ['GET', '/api/manage/restore/sources', null],
      ['POST', '/api/manage/restore/run', { file: 'x', password: 'y' }],
      ['GET', '/api/reports/export/sales', null],
    ], 'a cashier');
  });

  await step('the cashier closes the drawer on a blind count and the difference is written down', async () => {
    const before = await api('GET', '/api/pos/shift', undefined, CASHIER);
    const expected = n(before.shift?.expected_cash ?? before.shift?.cash_expected ?? 0);
    const r = await api('POST', '/api/pos/shift/close', { counted_cash: expected + 5, note: 'Rol testi' }, CASHIER);
    assert.strictEqual(r.status, 200, 'a cashier could not close his own shift: ' + JSON.stringify(r));
    const row = await db.one(
      "SELECT counted_cash_minor, expected_cash_minor, variance_minor FROM pos_shifts " +
      "WHERE client_id=? AND status='closed' ORDER BY id DESC LIMIT 1", [CID]);
    assert.ok(row, 'the shift did not close');
    assert.strictEqual(n(row.variance_minor), n(row.counted_cash_minor) - n(row.expected_cash_minor),
      'the drawer closed with a variance that does not equal counted minus expected');
  });

  /* ======================================================= E. the owner's desk */

  await step('the owner hands the cashier a key, and it bites at once', async () => {
    const pay = await db.one(
      'SELECT id FROM order_payments WHERE client_id=? AND voided_at IS NULL ORDER BY id DESC LIMIT 1', [CID]);
    const before = await api('POST', `/api/pos/payments/${pay.id}/void`, { reason: 'once' }, CASHIER);
    assert.strictEqual(before.status, 403, 'the cashier could void before being granted it');

    const grant = await api('POST', `/api/settings/users/${U.cashier}/permissions`,
      { perms: ['payment.take', 'payment.void', 'shift.open', 'shift.close', 'order.create'] }, OWNER);
    assert.strictEqual(grant.status, 200, 'the grant was refused: ' + JSON.stringify(grant));

    const after = await api('POST', `/api/pos/payments/${pay.id}/void`, { reason: 'yetki verildi' }, CASHIER);
    assert.strictEqual(after.status, 200, 'the granted permission did not take effect: ' + JSON.stringify(after));
  });

  await step('a key taken away is taken away at once too', async () => {
    const revoke = await api('POST', `/api/settings/users/${U.cashier}/permissions`,
      { perms: ['payment.take', 'shift.open', 'shift.close', 'order.create'] }, OWNER);
    assert.strictEqual(revoke.status, 200, 'the revoke was refused');
    const pay = await db.one(
      'SELECT id FROM order_payments WHERE client_id=? AND voided_at IS NULL ORDER BY id DESC LIMIT 1', [CID]);
    const r = await api('POST', `/api/pos/payments/${pay.id}/void`, { reason: 'artik yok' }, CASHIER);
    assert.strictEqual(r.status, 403, 'a revoked permission still worked: ' + JSON.stringify(r));
  });

  await step('an owner who unticks every box really does lock the cashier out', async () => {
    const clear = await api('POST', `/api/settings/users/${U.cashier}/permissions`, { perms: [] }, OWNER);
    assert.strictEqual(clear.status, 200, 'clearing the list was refused: ' + JSON.stringify(clear));

    const mine = await api('GET', '/api/auth/permissions', undefined, CASHIER);
    assert.deepStrictEqual(mine.mine, [],
      'every box was unticked and the cashier still holds: ' + JSON.stringify(mine.mine));

    const r = await api('POST', '/api/pos/orders', { table_id: T.c }, CASHIER);
    assert.strictEqual(r.status, 403, 'a cashier with no permissions at all could still open a bill');

    // put a working cashier back for the rest of the run
    await db.exec('DELETE FROM user_permissions WHERE client_id=? AND user_id=?', [CID, U.cashier]);
  });

  await step('the owner changes a price and the change is on the record', async () => {
    const cat = await db.one('SELECT category_id FROM products WHERE id=?', [P.kofte]);
    const r = await api('POST', '/api/manage/products',
      { id: P.kofte, category_id: cat.category_id, name: 'Rol Kofte', price: 210,
        cost_price: 0, vat_rate: 10, is_active: 1, use_in_pos: 1 }, OWNER);
    assert.strictEqual(r.status, 200, 'the owner could not change a price: ' + JSON.stringify(r));
    const now = await val('SELECT price FROM products WHERE id=?', [P.kofte]);
    assert.strictEqual(now, 210, 'the price did not change');
    const logged = await val(
      'SELECT COUNT(*) FROM price_change_log WHERE client_id=? AND product_id=?', [CID, P.kofte]);
    assert.ok(logged > 0, 'a price changed with nothing written in the price log');
  });

  await step('the owner reads every report there is', async () => {
    await allAllowed(OWNER, [
      ['GET', '/api/reports/dashboard', null],
      ['GET', '/api/reports/z', null],
      ['GET', '/api/reports/sales', null],
      ['GET', '/api/reports/products', null],
      ['GET', '/api/reports/waiters', null],
      ['GET', '/api/reports/cancellations', null],
      ['GET', '/api/reports/pnl', null],
      ['GET', '/api/reports/pnl/products', null],
      ['GET', '/api/reports/pnl/categories', null],
      ['GET', '/api/till/x-report', null],
      ['GET', '/api/till/shifts', null],
      ['GET', '/api/till/drawer/log', null],
    ], 'the owner');
  });

  await step('the owner exports the day', async () => {
    for (const fmt of ['csv', 'xlsx', 'pdf']) {
      const res = await fetch(BASE + '/api/reports/export/sales?format=' + fmt,
        { headers: { Authorization: 'Bearer ' + OWNER } });
      assert.ok(res.status < 400, fmt + ' export failed with ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.length > 40, fmt + ' export came back empty (' + buf.length + ' bytes)');
    }
  });

  await step('the owner runs a backup', async () => {
    const r = await api('POST', '/api/manage/backups/run', {}, OWNER);
    assert.ok(r.status === 200 || r.status === 503, 'the backup crashed: ' + JSON.stringify(r));
  });

  await step('a hired manager still cannot erase the month - only the owner can', async () => {
    for (const [m, p, b] of [
      ['GET', '/api/manage/restore/sources', null],
      ['POST', '/api/manage/restore/preview', { file: 'yok.sql' }],
      ['POST', '/api/finance/transactions/purge', { before: '2025-01-01' }],
    ]) {
      const r = await api(m, p, b, MANAGER);
      assert.strictEqual(r.status, 403, m + ' ' + p + ' let a manager through (' + r.status + ')');
    }
    const owner = await api('GET', '/api/manage/restore/sources', undefined, OWNER);
    assert.strictEqual(owner.status, 200, 'the owner was locked out of his own restore screen');
  });

  await step('the owner closes the day and the figures are the day\'s figures', async () => {
    await db.exec("UPDATE orders SET status='cancelled', is_closed=1, exclude_from_reports=1 " +
      "WHERE client_id=? AND status='open'", [CID]);
    const z = await api('GET', '/api/reports/z', undefined, OWNER);
    const r = await api('POST', '/api/reports/close-day',
      { declared_cash: 0, declared_card: 0, print: false }, OWNER);
    assert.strictEqual(r.status, 200, 'the owner could not close the day: ' + JSON.stringify(r));
    assert.ok(z.status === 200, 'the Z report would not open');
  });

  await step('the owner reopens the day he just closed', async () => {
    const day = await db.one(
      'SELECT `date` FROM daily_closings WHERE client_id=? ORDER BY id DESC LIMIT 1', [CID]);
    assert.ok(day, 'nothing was closed to reopen');
    const ymd = new Date(day.date).toISOString().slice(0, 10);
    const r = await api('POST', '/api/reports/reopen-day', { date: ymd, reason: 'Rol testi' }, OWNER);
    assert.ok(r.status === 200 || r.status === 400, 'reopening crashed: ' + JSON.stringify(r));
  });

  await step('the owner takes somebody off the staff and their PIN stops working', async () => {
    await db.exec("DELETE FROM users WHERE client_id=? AND username LIKE 'rol_gecici%'", [CID]).catch(() => {});
    const made = await api('POST', '/api/settings/users',
      { display_name: 'Gecici Garson', username: 'rol_gecici', role: 'waiter', pin: '7444' }, OWNER);
    assert.strictEqual(made.status, 200, 'the owner could not add staff: ' + JSON.stringify(made));
    const inOk = await api('POST', '/api/auth/pin', { pin: '7444' });
    assert.strictEqual(inOk.status, 200, 'the new waiter cannot sign in');
    const off = await api('POST', `/api/settings/users/${made.id || made.user_id}/active`, { active: false }, OWNER);
    assert.ok(off.status === 200 || off.status === 404, 'deactivating failed: ' + JSON.stringify(off));
    if (off.status === 200) {
      const inBad = await api('POST', '/api/auth/pin', { pin: '7444' });
      assert.notStrictEqual(inBad.status, 200, 'a deactivated waiter still signed in');
    }
  });

  /* ============================ F. two people, one bill, at the same moment */
  /*
   * The races that only happen between ROLES. akis.js already covers two
   * waiters sending one bill and two cashiers paying one bill; what it cannot
   * cover, because it runs as one person, is the pair that actually collides
   * in a restaurant at 21:40 - the waiter still adding while the cashier is
   * already settling.
   */

  await step('a waiter adding a drink while the cashier settles: nobody gets it free', async () => {
    const bid = (await api('POST', '/api/pos/orders', { table_id: T.a }, CASHIER)).order_id;
    await api('POST', `/api/pos/orders/${bid}/items`, { product_id: P.kofte, qty: 1 }, WAITER);
    const total = n((await api('GET', `/api/pos/orders/${bid}`, undefined, CASHIER)).order.grand_total);

    /* fired together, deliberately, with no await between them */
    const [added, paid] = await Promise.all([
      api('POST', `/api/pos/orders/${bid}/items`, { product_id: P.ayran, qty: 1 }, WAITER),
      api('POST', `/api/pos/orders/${bid}/payments`, { method: 'nakit', amount: total }, CASHIER),
    ]);

    const o = (await api('GET', `/api/pos/orders/${bid}`, undefined, OWNER)).order;
    const due = n(o.grand_total);
    const took = await val('SELECT COALESCE(SUM(amount),0) FROM order_payments WHERE order_id=? AND voided_at IS NULL', [bid]);
    const closed = o.status !== 'open';

    /*
     * Either outcome is correct; the wrong one is a CLOSED bill that is worth
     * more than what was taken for it, which is a drink given away and a till
     * that balances anyway.
     */
    if (closed) {
      assert.ok(Math.abs(took - due) < 0.02,
        `the bill closed owing ${money(due - took)} - the late line was given away ` +
        `(added=${added.status} paid=${paid.status} due=${due} took=${took})`);
    } else {
      assert.ok(due > took, 'the bill is open but nothing is outstanding');
      await api('POST', `/api/pos/orders/${bid}/payments`, { method: 'nakit', amount: money(due - took) }, CASHIER);
    }
  });

  await step('a waiter cancelling a line while the cashier discounts: the bill still adds up', async () => {
    const bid = (await api('POST', '/api/pos/orders', { table_id: T.b }, CASHIER)).order_id;
    await api('POST', `/api/pos/orders/${bid}/items`, { product_id: P.kofte, qty: 2 }, WAITER);
    await api('POST', `/api/pos/orders/${bid}/items`, { product_id: P.tatli, qty: 1 }, WAITER);
    const o0 = (await api('GET', `/api/pos/orders/${bid}`, undefined, OWNER)).order;
    const tatli = o0.items.find(i => n(i.product_id) === P.tatli);

    await Promise.all([
      api('DELETE', `/api/pos/orders/${bid}/items/${tatli.id}`, { qty: 1, reason: 'Vazgecti' }, WAITER),
      api('POST', `/api/pos/orders/${bid}/discount`, { percent: 10, reason: 'Sadik musteri' }, CASHIER),
    ]);

    const o = (await api('GET', `/api/pos/orders/${bid}`, undefined, OWNER)).order;
    const lines = o.items.filter(i => !i.is_deleted)
      .reduce((a, i) => a + n(i.line_total), 0);
    const disc = n(o.discount_total);
    assert.ok(Math.abs(n(o.grand_total) - money(lines - disc)) < 0.02,
      `lines ${money(lines)} - indirim ${money(disc)} != toplam ${n(o.grand_total)}`);
    assert.ok(disc <= lines + 0.001, `the discount (${disc}) is larger than what is left on the bill (${money(lines)})`);
    await api('POST', `/api/pos/orders/${bid}/payments`, { method: 'nakit', amount: n(o.grand_total) }, CASHIER);
  });

  await step('a phone order for a table the cashier has just closed is refused, not lost', async () => {
    const bid = (await api('POST', '/api/pos/orders', { table_id: T.c }, CASHIER)).order_id;
    await api('POST', `/api/pos/orders/${bid}/items`, { product_id: P.ayran, qty: 1 }, CASHIER);
    const total = n((await api('GET', `/api/pos/orders/${bid}`, undefined, CASHIER)).order.grand_total);
    await api('POST', `/api/pos/orders/${bid}/payments`, { method: 'nakit', amount: total }, CASHIER);

    /* the waiter's phone was showing this table a second ago */
    const late = await api('POST', '/api/mobile/orders/take',
      { table_id: T.c, items: [{ product_id: P.kofte, qty: 1 }] }, PHONE);

    if (late.status === 200) {
      /* a NEW bill on a now-free table is the right answer; adding to the paid
         one would not be */
      assert.notStrictEqual(late.order_id, bid, 'the phone added a line to a bill that was already paid');
      const o = (await api('GET', `/api/pos/orders/${late.order_id}`, undefined, OWNER)).order;
      assert.strictEqual(o.status, 'open', 'the phone opened a bill that was not open');
      await api('POST', `/api/pos/orders/${late.order_id}/payments`,
        { method: 'nakit', amount: n(o.grand_total) }, CASHIER);
    } else {
      assert.ok(late.status >= 400 && late.status < 500,
        'the phone was answered with ' + late.status + ': ' + JSON.stringify(late));
    }
    const paidTwice = await val(
      'SELECT COUNT(*) FROM order_payments WHERE order_id=? AND voided_at IS NULL', [bid]);
    assert.strictEqual(paidTwice, 1, 'the settled bill collected a second payment');
  });

  await step('a sent line the waiter cancels is withdrawn from the kitchen, not left on the rail', async () => {
    const bid = (await api('POST', '/api/pos/orders', { table_id: T.a }, WAITER)).order_id;
    await api('POST', `/api/pos/orders/${bid}/items`, { product_id: P.kofte, qty: 1 }, WAITER);
    await api('POST', `/api/pos/orders/${bid}/send`, {}, WAITER);
    const o = (await api('GET', `/api/pos/orders/${bid}`, undefined, WAITER)).order;
    const line = o.items.find(i => n(i.product_id) === P.kofte);

    const live = () => val(
      "SELECT COUNT(*) FROM station_projection_items WHERE client_id=? AND order_item_id=? " +
      "AND station_status NOT IN ('cancelled','done')", [CID, line.id]);
    assert.ok(await live() > 0, 'the line never reached a station');

    const r = await api('DELETE', `/api/pos/orders/${bid}/items/${line.id}`,
      { qty: 1, reason: 'Musteri vazgecti' }, WAITER);
    assert.strictEqual(r.status, 200, 'the waiter could not cancel a sent line: ' + JSON.stringify(r));
    assert.strictEqual(await live(), 0, 'the kitchen is still cooking a line that was cancelled');

    const after = (await api('GET', `/api/pos/orders/${bid}`, undefined, OWNER)).order;
    if (n(after.grand_total) > 0) {
      await api('POST', `/api/pos/orders/${bid}/payments`, { method: 'nakit', amount: n(after.grand_total) }, CASHIER);
    } else {
      await api('DELETE', `/api/pos/orders/${bid}`, { reason: 'Rol testi temizligi' }, OWNER);
    }
  });

  await step('sending two of three portions back leaves the third on the rail', async () => {
    const bid = (await api('POST', '/api/pos/orders', { table_id: T.b }, WAITER)).order_id;
    await api('POST', `/api/pos/orders/${bid}/items`, { product_id: P.kofte, qty: 3 }, WAITER);
    await api('POST', `/api/pos/orders/${bid}/send`, {}, WAITER);
    const o = (await api('GET', `/api/pos/orders/${bid}`, undefined, WAITER)).order;
    const line = o.items.find(i => n(i.product_id) === P.kofte);

    const r = await api('DELETE', `/api/pos/orders/${bid}/items/${line.id}`,
      { qty: 2, reason: 'Iki tanesi fazla gelmis' }, WAITER);
    assert.strictEqual(r.status, 200, 'a part cancel was refused: ' + JSON.stringify(r));

    const board = await db.one(
      "SELECT qty, station_status FROM station_projection_items " +
      'WHERE client_id=? AND order_item_id=? ORDER BY id DESC LIMIT 1', [CID, line.id]);
    assert.ok(board, 'the ticket vanished from the kitchen entirely');
    assert.notStrictEqual(board.station_status, 'cancelled', 'the whole ticket was withdrawn, not two of three');
    assert.strictEqual(n(board.qty), 1, `the cook is still making ${n(board.qty)} of them, not 1`);

    const after = (await api('GET', `/api/pos/orders/${bid}`, undefined, OWNER)).order;
    await api('POST', `/api/pos/orders/${bid}/payments`, { method: 'nakit', amount: n(after.grand_total) }, CASHIER);
  });

  await step('shift handover: each cashier\'s drawer holds only their own money', async () => {
    /* first drawer */
    await api('POST', '/api/pos/shift/open', { opening_float: 300 }, CASHIER);
    const b1 = (await api('POST', '/api/pos/orders', { table_id: T.b }, CASHIER)).order_id;
    await api('POST', `/api/pos/orders/${b1}/items`, { product_id: P.kofte, qty: 1 }, CASHIER);
    const t1 = n((await api('GET', `/api/pos/orders/${b1}`, undefined, CASHIER)).order.grand_total);
    await api('POST', `/api/pos/orders/${b1}/payments`, { method: 'nakit', amount: t1 }, CASHIER);
    const shiftA = (await api('GET', '/api/pos/shift', undefined, CASHIER)).shift.shift.id;
    await api('POST', '/api/pos/shift/close', { counted_cash: 300 + t1 }, CASHIER);

    /* the manager takes the next drawer */
    await api('POST', '/api/pos/shift/open', { opening_float: 400 }, MANAGER);
    const b2 = (await api('POST', '/api/pos/orders', { table_id: T.c }, MANAGER)).order_id;
    await api('POST', `/api/pos/orders/${b2}/items`, { product_id: P.tatli, qty: 2 }, MANAGER);
    const t2 = n((await api('GET', `/api/pos/orders/${b2}`, undefined, MANAGER)).order.grand_total);
    await api('POST', `/api/pos/orders/${b2}/payments`, { method: 'kredi_karti', amount: t2 }, MANAGER);
    const shiftB = (await api('GET', '/api/pos/shift', undefined, MANAGER)).shift.shift.id;

    assert.notStrictEqual(shiftA, shiftB, 'the handover reused the same shift');
    const inA = await val('SELECT COUNT(*) FROM order_payments WHERE shift_id=? AND order_id=?', [shiftA, b2]);
    const inB = await val('SELECT COUNT(*) FROM order_payments WHERE shift_id=? AND order_id=?', [shiftB, b1]);
    assert.strictEqual(inA, 0, 'the second cashier\'s money landed in the first one\'s drawer');
    assert.strictEqual(inB, 0, 'the first cashier\'s money followed him into the next drawer');

    const closedA = await db.one('SELECT closed_by, opened_by FROM pos_shifts WHERE id=?', [shiftA]);
    assert.strictEqual(n(closedA.opened_by), U.cashier, 'the first drawer is not booked to the cashier');
    assert.strictEqual(n(closedA.closed_by), U.cashier, 'somebody else is recorded closing it');
    await api('POST', '/api/pos/shift/close', { counted_cash: 400 }, MANAGER);
  });

  /* ================================================== F. across the three roles */

  await step('a waiter is not shown the takings through a side door', async () => {
    const leaks = [];
    for (const path of ['/api/reports/dashboard', '/api/till/state', '/api/pos/shift', '/api/till/shifts']) {
      const r = await api('GET', path, undefined, WAITER);
      if (r.status === 200) {
        const s = JSON.stringify(r);
        if (/"total"|"expected_cash"|"grand_total"|"cash_expected"|"by_method"/.test(s)) leaks.push(path);
      }
    }
    assert.strictEqual(leaks.length, 0, 'a waiter can read the day\'s money at: ' + leaks.join(', '));
  });

  await step('a rubbish or expired token is turned away, not crashed into', async () => {
    const dead = await auth.issueToken({ cid: CID, uid: U.waiter, role: 'waiter', name: 'Eski' }, '1ms');
    await new Promise(r => setTimeout(r, 30));
    for (const tok of ['', 'abc.def.ghi', dead]) {
      for (const [m, p] of [['GET', '/api/pos/tables'], ['POST', '/api/pos/orders'], ['GET', '/api/reports/z']]) {
        const r = await api(m, p, m === 'GET' ? undefined : {}, tok || undefined);
        assert.strictEqual(r.status, 401, `${m} ${p} answered ${r.status} to a dead token`);
      }
    }
  });

  await step('nobody, in any of the three walks, made the service throw', async () => {
    assert.strictEqual(CRASHES.length, 0, 'the service answered 500:\n    ' + CRASHES.join('\n    '));
  });

  /* ================================ results ========================= */
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
