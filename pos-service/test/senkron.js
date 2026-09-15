'use strict';
/**
 * SENKRON — the handheld's own copy, and how it stays in step.
 *
 * The phone is no longer a remote control. It keeps its own database of the
 * menu, the floor and the open bills, so it draws instantly and keeps working
 * when the wifi dips in the garden. This suite is about the one question that
 * model lives or dies on: after a change on the till, does the next pull carry
 * exactly that change - no more, and above all no less.
 *
 * The failures it exists to catch are the quiet ones. A deleted table that the
 * phone never hears about, so a waiter seats a party at a table the restaurant
 * closed. A price change that reaches the till and not the handset, so two
 * guests are charged differently for the same kebap. A cursor that goes
 * backwards, so a handset re-downloads the menu every twenty seconds on a
 * restaurant's wifi.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/senkron.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7493';
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
let PHONE = null, OWNER = null;
let U = 0, P = {}, T = {};

async function api(method, path, body, token = PHONE) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'senkron-test',
      ...(token ? { Authorization: 'Bearer ' + token } : {}) },
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

/** The phone: pull, apply, remember the cursor. A tiny local database. */
class Handset {
  constructor() {
    this.cursor = 0;
    this.products = new Map();
    this.categories = new Map();
    this.tables = new Map();
    this.zones = new Map();
    this.orders = new Map();
    this.fullPulls = 0;
    this.lastRows = 0;
  }
  async pull() {
    const r = await api('GET', '/api/mobile/pull?since=' + this.cursor);
    if (r.status !== 200) throw new Error('pull ' + r.status + ' ' + JSON.stringify(r));
    if (r.full) {
      this.fullPulls++;
      this.products.clear(); this.categories.clear();
      this.tables.clear(); this.zones.clear(); this.orders.clear();
    }
    const put = (map, rows) => { for (const x of rows || []) map.set(Number(x.id), x); };
    put(this.products, r.products); put(this.categories, r.categories);
    put(this.tables, r.tables); put(this.zones, r.zones); put(this.orders, r.orders);
    const rm = r.removed || {};
    for (const id of rm.products || []) this.products.delete(Number(id));
    for (const id of rm.categories || []) this.categories.delete(Number(id));
    for (const id of rm.tables || []) this.tables.delete(Number(id));
    for (const id of rm.zones || []) this.zones.delete(Number(id));
    for (const id of rm.orders || []) this.orders.delete(Number(id));
    this.lastRows = (r.products || []).length + (r.categories || []).length +
      (r.tables || []).length + (r.zones || []).length + (r.orders || []).length;
    this.cursor = r.cursor;
    return r;
  }
}

async function fixture() {
  await db.exec('DELETE FROM daily_closings WHERE client_id=?', [CID]);
  await db.exec("UPDATE orders SET status='cancelled', is_closed=1, exclude_from_reports=1 " +
    "WHERE client_id=? AND status='open'", [CID]);
  await db.exec('UPDATE restaurant_tables SET is_occupied=0 WHERE client_id=?', [CID]);

  const e = await db.one('SELECT id FROM users WHERE client_id=? AND username=?', [CID, 'senkron_garson']);
  U = e ? e.id : await db.insert(
    `INSERT INTO users (client_id, username, email, display_name, role, password_hash, pin_hash,
        created_at, updated_at, is_active) VALUES (?,?,?,?, 'waiter', ?, ?, NOW(), NOW(), 1)`,
    [CID, 'senkron_garson', 'senkron@pda.local', 'Senkron Garson', auth.hash('Sifre1234'), auth.hash('8333')]);
  await db.exec('DELETE FROM user_permissions WHERE client_id=? AND user_id=?', [CID, U]);
  await auth.setPermissions(CID, U, ['order.create', 'order.item.cancel', 'order.transfer'], null);

  const zone = await db.one('SELECT id FROM table_zones WHERE client_id=? AND is_active=1 ORDER BY id LIMIT 1', [CID])
    || { id: await db.insert('INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']) };
  const table = async (name) => {
    const ex = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? AND name=?', [CID, name]);
    if (ex) { await db.exec('UPDATE restaurant_tables SET is_active=1, is_occupied=0, zone_id=? WHERE id=?', [zone.id, ex.id]); return ex.id; }
    return db.insert('INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active,is_occupied) VALUES (?,?,?,98,1,0)',
      [CID, zone.id, name]);
  };
  T = { a: await table('SNK 1'), b: await table('SNK 2'), doomed: await table('SNK 3') };

  const cat = await db.one('SELECT id FROM categories WHERE client_id=? AND is_active=1 ORDER BY id LIMIT 1', [CID]);
  const product = async (name, price) => {
    const ex = await db.one('SELECT id FROM products WHERE client_id=? AND name=?', [CID, name]);
    if (ex) { await db.exec('UPDATE products SET price=?, is_active=1, use_in_pos=1, category_id=? WHERE id=?', [price, cat.id, ex.id]); return ex.id; }
    return db.insert('INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,is_active,use_in_pos,use_in_qr) ' +
      'VALUES (?,?,?,?,0,10,1,1,1)', [CID, cat.id, name, price]);
  };
  P.kebap = await product('SNK Kebap', 400);
  P.ayran = await product('SNK Ayran', 60);
  P.doomed = await product('SNK Kaldirilacak', 90);
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - el terminali senkronu\n');
  await fixture();
  OWNER = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Sahip', kind: 'tenant' });
  PHONE = await auth.issueToken({ cid: CID, uid: U, role: 'waiter', name: 'Senkron Garson', kind: 'mobile' });

  const phone = new Handset();

  await step('ilk açılış tam kopya indirir ve imleci alır', async () => {
    const r = await phone.pull();
    assert.strictEqual(r.full, true, 'ilk çekim tam kopya değil');
    assert.ok(phone.cursor > 0, 'imleç gelmedi');
    assert.ok(phone.products.size > 0, 'menü inmedi');
    assert.ok(phone.tables.size > 0, 'masa planı inmedi');
    assert.ok(phone.products.has(P.kebap), 'ürün eksik');
  });

  await step('hiçbir şey değişmediyse çekim boş döner - menü tekrar inmez', async () => {
    const before = phone.cursor;
    const r = await phone.pull();
    assert.strictEqual(r.full, false, 'sessiz dakikada tam kopya indi');
    assert.strictEqual(phone.lastRows, 0, phone.lastRows + ' satır boşuna indi');
    assert.strictEqual(phone.cursor, before, 'imleç sebepsiz ilerledi');
  });

  await step('fiyat değişince yalnızca o ürün iner', async () => {
    await db.exec('UPDATE products SET price=455 WHERE id=?', [P.kebap]);
    const r = await phone.pull();
    assert.strictEqual(r.full, false, 'tek fiyat için tam kopya indi');
    assert.strictEqual(n(phone.products.get(P.kebap).price), 455, 'yeni fiyat gelmedi');
    assert.strictEqual(phone.lastRows, 1, phone.lastRows + ' satır indi, 1 bekleniyordu');
  });

  await step('kapatılan ürün telefondan düşer - satılmaya devam etmez', async () => {
    assert.ok(phone.products.has(P.doomed), 'ürün başta yoktu');
    await db.exec('UPDATE products SET is_active=0 WHERE id=?', [P.doomed]);
    await phone.pull();
    assert.ok(!phone.products.has(P.doomed), 'kapatılan ürün telefonda kaldı');
  });

  await step('silinen masa telefondan düşer - oraya misafir oturtulmaz', async () => {
    assert.ok(phone.tables.has(T.doomed), 'masa başta yoktu');
    await db.exec('DELETE FROM restaurant_tables WHERE id=? AND client_id=?', [T.doomed, CID]);
    await phone.pull();
    assert.ok(!phone.tables.has(T.doomed), 'silinen masa telefonda kaldı');
  });

  await step('yeni ürün ve yeni kategori kendiliğinden gelir', async () => {
    const cat = await db.insert(
      'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,60,1,1,1)',
      [CID, 'SNK Yeni Kategori']);
    const prod = await db.insert(
      'INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,is_active,use_in_pos,use_in_qr) ' +
      'VALUES (?,?,?,?,0,10,1,1,1)', [CID, cat, 'SNK Yeni Urun', 175]);
    await phone.pull();
    assert.ok(phone.categories.has(cat), 'yeni kategori gelmedi');
    assert.ok(phone.products.has(prod), 'yeni ürün gelmedi');
    assert.strictEqual(n(phone.products.get(prod).price), 175, 'fiyat yanlış');
  });

  /* ------------------------------------------------- the bills themselves */

  let bill = null;
  await step('kasada açılan adisyon telefona satırlarıyla iner', async () => {
    bill = (await api('POST', '/api/pos/orders', { table_id: T.a }, OWNER)).order_id;
    await api('POST', `/api/pos/orders/${bill}/items`, { product_id: P.kebap, qty: 2 }, OWNER);
    await phone.pull();
    const o = phone.orders.get(bill);
    assert.ok(o, 'adisyon telefona inmedi');
    assert.strictEqual(o.items.filter(i => !i.is_deleted).length, 1, 'satırlar inmedi');
    assert.strictEqual(n(o.grand_total), 910, 'toplam: ' + o.grand_total);
  });

  await step('kasadaki her satır değişikliği bir sonraki çekimde telefonda', async () => {
    await api('POST', `/api/pos/orders/${bill}/items`, { product_id: P.ayran, qty: 3 }, OWNER);
    await phone.pull();
    const o = phone.orders.get(bill);
    assert.strictEqual(o.items.filter(i => !i.is_deleted).length, 2, 'ikinci satır inmedi');
    assert.strictEqual(n(o.grand_total), 1090, 'toplam: ' + o.grand_total);
  });

  await step('telefondan eklenen satır kasada, kasadaki değişiklik telefonda', async () => {
    await api('POST', '/api/mobile/orders/take',
      { order_id: bill, items: [{ product_id: P.kebap, qty: 1 }], send: false });
    const onTill = (await api('GET', `/api/pos/orders/${bill}`, undefined, OWNER)).order;
    assert.strictEqual(n(onTill.grand_total), 1545, 'kasadaki toplam: ' + onTill.grand_total);
    await phone.pull();
    assert.strictEqual(n(phone.orders.get(bill).grand_total), 1545, 'telefon kendi yazdığını geri okumadı');
  });

  await step('ödenen adisyon telefonun listesinden çıkar', async () => {
    const due = n(phone.orders.get(bill).grand_total);
    await api('POST', `/api/pos/orders/${bill}/payments`, { method: 'nakit', amount: due }, OWNER);
    await phone.pull();
    assert.ok(!phone.orders.has(bill), 'kapanan adisyon telefonda açık kaldı');
  });

  /* ------------------------------------------------------ the hard cases */

  await step('bir çekimi kaçıran telefon, sonrakinde ikisini birden alır', async () => {
    const stale = phone.cursor;
    await db.exec('UPDATE products SET price=480 WHERE id=?', [P.kebap]);
    await db.exec('UPDATE products SET price=70 WHERE id=?', [P.ayran]);
    /* the phone was in a basement and missed the first change entirely */
    phone.cursor = stale;
    await phone.pull();
    assert.strictEqual(n(phone.products.get(P.kebap).price), 480, 'birinci değişiklik kayboldu');
    assert.strictEqual(n(phone.products.get(P.ayran).price), 70, 'ikinci değişiklik kayboldu');
  });

  await step('çok eski imleç tam kopyaya düşer, sessizce eksik veri almaz', async () => {
    const oldest = n(await db.value('SELECT COALESCE(MIN(id),0) FROM app_change_log WHERE client_id=?', [CID]));
    const before = phone.fullPulls;
    phone.cursor = Math.max(0, oldest - 500);
    const r = await phone.pull();
    assert.strictEqual(r.full, true, 'çok eski imleçle delta verildi');
    assert.strictEqual(r.reason, 'cursor_too_old', 'sebep: ' + r.reason);
    assert.strictEqual(phone.fullPulls, before + 1, 'tam kopya sayılmadı');
    assert.ok(phone.products.has(P.kebap), 'tam kopyada menü yok');
  });

  await step('imleç hiçbir zaman geriye gitmez', async () => {
    const a = phone.cursor;
    await phone.pull();
    const b = phone.cursor;
    await db.exec('UPDATE products SET price=485 WHERE id=?', [P.kebap]);
    await phone.pull();
    assert.ok(b >= a, `imleç geriye gitti: ${a} -> ${b}`);
    assert.ok(phone.cursor > b, 'değişiklikten sonra imleç ilerlemedi');
  });

  await step('iki terminal birbirinin imlecini bozmaz', async () => {
    const second = new Handset();
    await second.pull();
    assert.strictEqual(second.fullPulls, 1, 'ikinci terminal tam kopya almadı');
    const mine = phone.cursor;
    await db.exec('UPDATE products SET price=490 WHERE id=?', [P.kebap]);
    await second.pull();
    assert.strictEqual(phone.cursor, mine, 'ikinci terminalin çekimi birincinin imlecini oynattı');
    await phone.pull();
    assert.strictEqual(n(phone.products.get(P.kebap).price), 490, 'birinci terminal değişikliği almadı');
  });

  await step('kasa her terminalin ne kadar geride olduğunu bilir', async () => {
    /* the till's own question, asked with the till's own key - a waiter's
       handset is refused this one, and the check below proves it */
    const r = await api('GET', '/api/mobile/cursors', undefined, OWNER);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.head > 0, 'baş imleç yok');
    const me = (r.devices || []).find(d => d.device_id === 'senkron-test');
    assert.ok(me, 'bu terminal kayıtlı değil');
    assert.ok(me.behind >= 0, 'geride kalma negatif: ' + me.behind);
  });

  await step('terminal listesi garsonun işi değil', async () => {
    const r = await api('GET', '/api/mobile/cursors');
    assert.strictEqual(r.status, 403, 'garson bütün telefonların durumunu gördü: ' + r.status);
  });

  await step('senkron kapısı da yetki ister - jetonsuz çekim yok', async () => {
    const r = await api('GET', '/api/mobile/pull?since=0', undefined, null);
    assert.strictEqual(r.status, 401, 'jetonsuz çekim: ' + r.status);
  });

  await step('bir terminal başka restoranın değişikliklerini görmez', async () => {
    const other = await db.one('SELECT client_id FROM app_change_log WHERE client_id<>? LIMIT 1', [CID]);
    if (other) {
      const r = await api('GET', '/api/mobile/pull?since=0');
      const ids = [...(r.products || []).map(p => p.id)];
      const foreign = await db.query(
        `SELECT id FROM products WHERE client_id=? AND id IN (${ids.length ? ids.map(() => '?').join(',') : '0'})`,
        [other.client_id, ...ids]);
      assert.strictEqual(foreign.length, 0, 'başka tenantın ürünü indi');
    }
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
