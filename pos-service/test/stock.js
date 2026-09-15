'use strict';
/**
 * STOK / DEPO - the hole the old system left, and the five bugs in what it did have.
 *
 * Every check here corresponds to something that was wrong in production, not
 * to a line of code that happens to exist:
 *
 *   - a "draft" purchase already raised stock, so approval was decorative
 *   - selling a pide never consumed a gram of flour, because nothing said a
 *     pide contains flour
 *   - stock was deducted on one close path and not on the OKC one, so paying
 *     by card banked the money and left the stock alone
 *   - the flag that made deduction idempotent was set on every row of the
 *     order and never reset on cancel, so re-closing deducted nothing
 *   - the quantity was written to three tables and read from none
 *
 * Real MariaDB, real HTTP, no mocks: the failures this suite exists to catch -
 * a level that reads back as a different number than the ledger holds, a
 * second close that halves the flour - only appear when the database is doing
 * the arithmetic.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/stock.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7465';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 21;                       // a tenant of our own, so nothing else's stock is disturbed
let TOKEN = null;

async function api(method, path_, body, token = TOKEN) {
  const res = await fetch(BASE + path_, {
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

/**
 * The migration is applied here rather than assumed.
 *
 * The desktop shell re-runs every file in database/migrations on each start;
 * a test run has no shell, and a suite that fails with "Table
 * 'product_recipes' doesn't exist" tells the next person nothing about stock.
 * The file is written to be idempotent, so this is the same thing the shell does.
 */
async function migrate() {
  const file = path.join(__dirname, '..', '..', 'database', 'migrations', '2026-09-03-inventory.sql');
  const sql = fs.readFileSync(file, 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await db.exec(stmt); } catch (e) { /* already applied */ }
  }
}

/** A kitchen we control completely, so every quantity below is checkable by hand. */
async function fixture() {
  // stock first: the order rows below carry foreign keys into these
  await db.exec('DELETE FROM inventory_stock_ledger WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM inventory_count_items WHERE count_id IN (SELECT id FROM inventory_counts WHERE client_id=?)', [CID]);
  await db.exec('DELETE FROM inventory_counts WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM inventory_waste WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM inventory_transfers WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM inventory_document_items WHERE document_id IN (SELECT id FROM inventory_documents WHERE client_id=?)', [CID]);
  await db.exec('DELETE FROM inventory_documents WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM inventory_locations WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM product_recipes WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM suppliers WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM inventory_items WHERE client_id=?', [CID]);

  await db.exec('DELETE FROM order_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM order_payments WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM orders WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM product_stock WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM product_stock_movements WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM products WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM categories WHERE client_id=?', [CID]);

  const cat = await db.insert(
    'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,1,1,1,1)',
    [CID, 'Fırın']);
  const mk = (n, price, track) => db.insert(
    `INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,sort_order,
        is_active,use_in_pos,use_in_qr,track_stock) VALUES (?,?,?,?,0,10,0,1,1,1,?)`,
    [CID, cat, n, price, track ? 1 : 0]);
  return {
    cat,
    pide: await mk('Kıymalı Pide', 220, 0),        // made of flour and mince - a recipe product
    lahmacun: await mk('Lahmacun', 90, 0),         // shares the flour, so one purchase feeds both
    kola: await mk('Kola', 60, 1),                 // bought and sold as itself - track_stock
  };
}

let tableId = null;
async function aTable() {
  if (tableId) return tableId;
  const NAME = 'Stok Test Masasi';
  const existing = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? AND name=?', [CID, NAME]);
  if (existing) { tableId = existing.id; return tableId; }
  let zone = await db.one('SELECT id FROM table_zones WHERE client_id=? LIMIT 1', [CID]);
  const zoneId = zone ? zone.id : await db.insert(
    'INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']);
  tableId = await db.insert(
    'INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active) VALUES (?,?,?,98,1)',
    [CID, zoneId, NAME]);
  return tableId;
}

/** What the module says is on the shelf - the number the screen shows. */
async function levelOf(itemId) {
  const r = await api('GET', '/api/inventory/levels?all=1');
  const row = r.levels.find(x => x.id === itemId);
  return row ? Number(row.qty) : null;
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  await migrate();
  console.log('\nNOKTApp POS - stok / depo\n');

  const catalog = require('../src/modules/catalog');
  const inv = require('../src/modules/inventory');
  await db.exec('DELETE FROM users WHERE client_id=? AND username=?', [CID, 'stokcu']);
  const uid = await catalog.saveUser(CID, {
    display_name: 'Test Depocu', username: 'stokcu', role: 'admin', pin: '5566', password: 'test1234',
  }, null);
  TOKEN = await auth.issueToken({ cid: CID, uid, role: 'admin', name: 'Test Depocu', kind: 'pos' });

  const P = await fixture();
  const table = await aTable();
  const ITEM = {};       // un, kiyma, kola
  let supplierId = null;

  /* ============================ malzeme & tedarikçi ==================== */

  await step('bir hammadde ve tedarikçi açılabilir', async () => {
    const s = await api('POST', '/api/inventory/suppliers', { name: 'Anadolu Un Ticaret', phone: '0212 000 00 00' });
    assert.strictEqual(s.status, 200, JSON.stringify(s));
    supplierId = s.id;
    for (const [key, name, unit, min] of [
      ['un', 'Un', 'kg', 20], ['kiyma', 'Kıyma', 'kg', 5], ['kola', 'Kola Kutu', 'pcs', 24]]) {
      const r = await api('POST', '/api/inventory/items', { name, unit, min_qty: min });
      assert.strictEqual(r.status, 200, JSON.stringify(r));
      ITEM[key] = r.id;
    }
    const list = await api('GET', '/api/inventory/items');
    assert.strictEqual(list.items.length, 3, 'üç malzeme bekleniyordu, ' + list.items.length + ' geldi');
  });

  await step('iki tedarikçi vergi numarası olmadan da kaydedilebilir', async () => {
    // suppliers carries UNIQUE(client_id, vkn) and the column defaults to '';
    // the old detector collided on the empty string and refused the second one
    const a = await api('POST', '/api/inventory/suppliers', { name: 'Pazarcı Ahmet' });
    const b = await api('POST', '/api/inventory/suppliers', { name: 'Pazarcı Mehmet' });
    assert.strictEqual(a.status, 200, JSON.stringify(a));
    assert.strictEqual(b.status, 200, JSON.stringify(b));
    assert.notStrictEqual(a.id, b.id);
  });

  /* ============================ alış: taslak vs onay =================== */

  let docId = null;

  await step('taslak alış faturası stoğu YÜKSELTMEZ', async () => {
    const r = await api('POST', '/api/inventory/documents', {
      supplier_id: supplierId,
      document_no: 'FTR-001',
      document_date: new Date().toISOString().slice(0, 10),
      items: [
        { item_id: ITEM.un, raw_name: 'Un 50 kg', quantity: 100, unit: 'kg', unit_price: 20, vat_rate: 1 },
        { item_id: ITEM.kiyma, raw_name: 'Kıyma', quantity: 20, unit: 'kg', unit_price: 400, vat_rate: 1 },
      ],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    docId = r.id;
    const doc = (await api('GET', `/api/inventory/documents/${docId}`)).document;
    assert.strictEqual(doc.status, 'draft');
    // the whole defect: the PHP wrote the ledger inside the save, whatever the status said
    const moves = Number(await db.value(
      "SELECT COUNT(*) FROM inventory_stock_ledger WHERE client_id=? AND source_type='document'", [CID]));
    assert.strictEqual(moves, 0, 'taslak belge muhasebe defterine yazmamalı, ' + moves + ' satır yazılmış');
    assert.strictEqual(await levelOf(ITEM.un), 0, 'taslak fatura ile un stoğu artmış');
  });

  await step('fatura toplamı satırlardan hesaplanır, gönderilen tutardan değil', async () => {
    const doc = (await api('GET', `/api/inventory/documents/${docId}`)).document;
    // 100 * 20 + 20 * 400 = 10.000
    assert.strictEqual(Number(doc.total_amount), 10000, 'toplam 10000 olmalı, ' + doc.total_amount);
    const un = doc.items.find(i => i.item_id === ITEM.un);
    // KDV Türkiye'de fiyatın içindedir: 2000 * 1 / 101
    assert.strictEqual(Number(un.vat_amount), 19.8, 'KDV içeriden alınmalı, ' + un.vat_amount);
  });

  await step('onay stoğu yükseltir — onay artık gerçek işlemdir', async () => {
    const r = await api('POST', `/api/inventory/documents/${docId}/approve`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(await levelOf(ITEM.un), 100, 'onaydan sonra 100 kg un olmalı');
    assert.strictEqual(await levelOf(ITEM.kiyma), 20);
    const doc = (await api('GET', `/api/inventory/documents/${docId}`)).document;
    assert.strictEqual(doc.status, 'approved');
    assert.ok(doc.approved_at, 'onay zamanı yazılmalı');
  });

  await step('aynı fatura iki kez onaylanamaz', async () => {
    const r = await api('POST', `/api/inventory/documents/${docId}/approve`);
    assert.strictEqual(r.status, 409, 'ikinci onay reddedilmeli, ' + r.status);
    assert.strictEqual(await levelOf(ITEM.un), 100, 'stok ikiye katlanmış');
  });

  await step('onaylı fatura düzenlenemez, önce iptal edilir', async () => {
    const r = await api('POST', '/api/inventory/documents', {
      id: docId, document_date: new Date().toISOString().slice(0, 10),
      items: [{ item_id: ITEM.un, raw_name: 'Un', quantity: 999, unit: 'kg', unit_price: 20 }] });
    assert.strictEqual(r.status, 409, JSON.stringify(r));
    assert.strictEqual(await levelOf(ITEM.un), 100);
  });

  await step('malzemeye bağlanmamış satır onaylanmaz', async () => {
    const d = await api('POST', '/api/inventory/documents', {
      supplier_id: supplierId, document_date: new Date().toISOString().slice(0, 10),
      items: [{ raw_name: 'OKUNAMAYAN SATIR', quantity: 5, unit: 'kg', unit_price: 10 }] });
    const r = await api('POST', `/api/inventory/documents/${d.id}/approve`);
    assert.strictEqual(r.status, 400, 'eşleşmeyen satır onaylanmamalı');
    assert.ok(String(r.error).includes('OKUNAMAYAN'), 'hata hangi satır olduğunu söylemeli: ' + r.error);
    await api('POST', `/api/inventory/documents/${d.id}/cancel`);
  });

  /* ============================== kola: hazır ürün ===================== */

  await step('takipli ürün için de alış girilebilir', async () => {
    const d = await api('POST', '/api/inventory/documents', {
      supplier_id: supplierId, document_date: new Date().toISOString().slice(0, 10),
      items: [{ item_id: ITEM.kola, raw_name: 'Kola 24lü', quantity: 48, unit: 'pcs', unit_price: 15, vat_rate: 20 }] });
    await api('POST', `/api/inventory/documents/${d.id}/approve`);
    assert.strictEqual(await levelOf(ITEM.kola), 48);
  });

  /* ================================ reçete ============================= */

  await step('bir ürüne reçete tanımlanabilir — eksik olan bağ', async () => {
    const r = await api('POST', `/api/inventory/recipes/${P.pide}`, {
      lines: [
        { inventory_item_id: ITEM.un, qty_per_unit: 0.3 },
        { inventory_item_id: ITEM.kiyma, qty_per_unit: 0.15 },
      ] });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    await api('POST', `/api/inventory/recipes/${P.lahmacun}`, {
      lines: [{ inventory_item_id: ITEM.un, qty_per_unit: 0.1 }] });
    const got = await api('GET', `/api/inventory/recipes/${P.pide}`);
    assert.strictEqual(got.recipe.length, 2);
    // 0.3 kg * 20 TL + 0.15 kg * 400 TL = 66 TL
    assert.strictEqual(got.costing.cost, 66, 'porsiyon maliyeti 66 TL olmalı, ' + got.costing.cost);
  });

  await step('reçete maliyeti ürünün elle girilen maliyetini EZMEZ', async () => {
    // overwriting a hand-typed cost would silently rewrite every historic margin
    const p = await db.one('SELECT cost_price FROM products WHERE id=?', [P.pide]);
    assert.strictEqual(Number(p.cost_price), 0, 'reçete products.cost_price sütununa yazmamalı');
  });

  /* ======================= satış hammaddeyi tüketir ==================== */

  let orderId = null;

  await step('adisyon açılır ve pide ile kola eklenir', async () => {
    const o = await api('POST', '/api/pos/orders', { table_id: table });
    assert.strictEqual(o.status, 200, JSON.stringify(o));
    orderId = o.order_id;
    assert.strictEqual((await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: P.pide, qty: 2 })).status, 200);
    assert.strictEqual((await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: P.kola, qty: 3 })).status, 200);
    assert.strictEqual((await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: P.lahmacun, qty: 4 })).status, 200);
  });

  await step('adisyon açıkken hiçbir hammadde düşmemiştir', async () => {
    assert.strictEqual(await levelOf(ITEM.un), 100, 'sipariş girilmesi stok düşürmemeli');
    assert.strictEqual(await levelOf(ITEM.kiyma), 20);
  });

  await step('adisyon kapanınca reçeteli ürün hammaddeyi tüketir', async () => {
    const r = await api('POST', `/api/inventory/orders/${orderId}/apply`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    // 2 pide * 0.3 + 4 lahmacun * 0.1 = 1.0 kg un;  2 * 0.15 = 0.3 kg kıyma
    assert.strictEqual(await levelOf(ITEM.un), 99, 'un 100 -> 99 olmalı, ' + await levelOf(ITEM.un));
    assert.strictEqual(await levelOf(ITEM.kiyma), 19.7, 'kıyma 20 -> 19.7 olmalı');
  });

  await step('takipli ürünün kendi stoğu da düşer ve okunabilir', async () => {
    const s = await db.one('SELECT stock FROM product_stock WHERE client_id=? AND product_id=?', [CID, P.kola]);
    assert.ok(s, 'product_stock satırı yok — eski kod satırı olmayan ürüne UPDATE atıyordu, sessizce');
    assert.strictEqual(Number(s.stock), -3, 'üç kola satıldı');
    // and it has to be READABLE: the old table was written by five files and read by none
    const lvl = await api('GET', '/api/pos/stock');
    const row = lvl.stock.find(x => x.id === P.kola);
    assert.ok(row, 'satılan takipli ürün stok listesinde görünmeli');
    assert.strictEqual(Number(row.stock), -3);
  });

  await step('aynı adisyonu ikinci kez kapatmak stoğu ikinci kez düşürmez', async () => {
    // this is the OKC path closing a bill the cashier already closed
    const r = await api('POST', `/api/inventory/orders/${orderId}/apply`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.applied, 0, 'ikinci kapanışta uygulanacak satır kalmamalı');
    assert.strictEqual(await levelOf(ITEM.un), 99, 'un ikinci kez düşmüş');
    assert.strictEqual(await levelOf(ITEM.kiyma), 19.7);
  });

  await step('adisyonun ne tükettiği geri okunabilir', async () => {
    const r = await api('GET', `/api/inventory/orders/${orderId}/consumption`);
    const un = r.consumption.find(x => x.item_id === ITEM.un);
    assert.ok(un, 'un tüketimi görünmeli');
    assert.strictEqual(Number(un.qty), 1);
    assert.strictEqual(Number(un.cost), 20, '1 kg un 20 TL — hareket kendi maliyetini taşımalı');
  });

  await step('iptal edilen adisyon hammaddeyi geri verir ve bayrağı sıfırlar', async () => {
    const r = await api('POST', `/api/inventory/orders/${orderId}/reverse`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(await levelOf(ITEM.un), 100, 'iptalde un geri gelmeli');
    assert.strictEqual(await levelOf(ITEM.kiyma), 20);
    const flags = await db.query('SELECT stock_applied FROM order_items WHERE order_id=?', [orderId]);
    assert.ok(flags.every(f => Number(f.stock_applied) === 0),
      'eski sistem bayrağı 1 bırakıyordu, tekrar kapatınca hiç düşmüyordu');
    const kola = await db.one('SELECT stock FROM product_stock WHERE client_id=? AND product_id=?', [CID, P.kola]);
    assert.strictEqual(Number(kola.stock), 0, 'kola stoğu da geri gelmeli');
  });

  await step('iptal sonrası tekrar kapatmak stoğu yeniden düşürür', async () => {
    const r = await api('POST', `/api/inventory/orders/${orderId}/apply`);
    assert.strictEqual(r.applied, 3, 'üç satır yeniden uygulanmalı, ' + r.applied);
    assert.strictEqual(await levelOf(ITEM.un), 99);
  });

  await step('silinmiş satır ne düşer ne bayraklanır', async () => {
    const o = await api('POST', '/api/pos/orders', { table_id: table });
    await api('POST', `/api/pos/orders/${o.order_id}/items`, { product_id: P.pide, qty: 1 });
    const line = (await api('GET', `/api/pos/orders/${o.order_id}`)).order.items[0];
    await db.exec('UPDATE order_items SET is_deleted=1 WHERE id=?', [line.id]);
    const before = await levelOf(ITEM.un);
    const r = await api('POST', `/api/inventory/orders/${o.order_id}/apply`);
    assert.strictEqual(r.applied, 0, 'silinmiş satır uygulanmamalı');
    assert.strictEqual(await levelOf(ITEM.un), before);
    const f = await db.one('SELECT stock_applied FROM order_items WHERE id=?', [line.id]);
    assert.strictEqual(Number(f.stock_applied), 0,
      'eski kod adisyonun HER satırını bayraklıyordu, silinmişler dahil');
  });

  /* ================================ sayım ============================== */

  let countId = null;

  await step('sayım açılır ve beklenen miktarı defterden dondurur', async () => {
    const r = await api('POST', '/api/inventory/counts', { note: 'Hafta sonu sayımı' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    countId = r.id;
    const c = (await api(`GET`, `/api/inventory/counts/${countId}`)).count;
    const un = c.items.find(i => i.item_id === ITEM.un);
    assert.strictEqual(Number(un.expected_qty), 99, 'beklenen miktar defterden gelmeli');
    assert.strictEqual(Number(un.variance), 0, 'sayılmadan fark olmamalı');
  });

  await step('taslak sayım stoğu değiştirmez', async () => {
    await api('POST', `/api/inventory/counts/${countId}/lines`, {
      lines: [{ item_id: ITEM.un, counted_qty: 96.5 }] });
    assert.strictEqual(await levelOf(ITEM.un), 99, 'kapanmamış sayım stoğu oynatmamalı');
  });

  await step('fark sunucuda hesaplanır, istemciden gelmez', async () => {
    const c = (await api('GET', `/api/inventory/counts/${countId}`)).count;
    const un = c.items.find(i => i.item_id === ITEM.un);
    assert.strictEqual(Number(un.counted_qty), 96.5);
    assert.strictEqual(Number(un.variance), -2.5, 'fark 96.5 - 99 = -2.5 olmalı, ' + un.variance);
  });

  await step('sayım onaylanınca stok sayılan değere gelir', async () => {
    const r = await api('POST', `/api/inventory/counts/${countId}/approve`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.adjusted, 1, 'sadece farkı olan satır defterle yazılmalı');
    assert.strictEqual(await levelOf(ITEM.un), 96.5,
      'sayımdan sonra stok sayılan miktar olmalı — bu, eski sistemin hiç yapamadığı şey');
    const c = (await api('GET', `/api/inventory/counts/${countId}`)).count;
    assert.strictEqual(c.status, 'approved');
    assert.strictEqual(Number(c.variance_value), -50, '2.5 kg * 20 TL = 50 TL kayıp');
  });

  await step('onaylı sayım tekrar onaylanamaz', async () => {
    const r = await api('POST', `/api/inventory/counts/${countId}/approve`);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(await levelOf(ITEM.un), 96.5);
  });

  /* ================================= zayi ============================== */

  await step('zayi stoğu düşürür ve nedenini saklar', async () => {
    const r = await api('POST', '/api/inventory/waste', {
      item_id: ITEM.kiyma, quantity: 1.5, reason: 'spoiled', note: 'Buzdolabı bozuldu' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(await levelOf(ITEM.kiyma), 18.2, 'kıyma 19.7 -> 18.2 olmalı');
    const list = await api('GET', '/api/inventory/waste');
    assert.strictEqual(list.waste.length, 1);
    assert.strictEqual(list.waste[0].reason, 'spoiled');
    assert.strictEqual(list.waste[0].reason_label, 'Bozuldu / son kullanma');
    assert.strictEqual(Number(list.waste[0].cost), 600, '1.5 kg * 400 TL = 600 TL zayi');
  });

  await step('nedensiz zayi kabul edilmez', async () => {
    const before = await levelOf(ITEM.kiyma);
    for (const body of [
      { item_id: ITEM.kiyma, quantity: 1 },
      { item_id: ITEM.kiyma, quantity: 1, reason: 'canim istedi' },
      { item_id: ITEM.kiyma, quantity: 0, reason: 'spoiled' },
    ]) {
      const r = await api('POST', '/api/inventory/waste', body);
      assert.strictEqual(r.status, 400, 'reddedilmeliydi: ' + JSON.stringify(body));
    }
    assert.strictEqual(await levelOf(ITEM.kiyma), before, 'reddedilen zayi stoğu oynatmamalı');
  });

  /* =============================== transfer ============================ */

  await step('depolar arası transfer toplam stoğu değiştirmez, yerini değiştirir', async () => {
    const main = (await api('POST', '/api/inventory/locations/default')).id;
    const bar = (await api('POST', '/api/inventory/locations', { name: 'Bar Dolabı' })).id;
    const before = await levelOf(ITEM.kola);
    const r = await api('POST', '/api/inventory/transfers', {
      item_id: ITEM.kola, from_location_id: main, to_location_id: bar, quantity: 12 });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(await levelOf(ITEM.kola), before, 'transfer toplam stoğu değiştirmemeli');
    const byLoc = (await api('GET', `/api/inventory/items/${ITEM.kola}`)).by_location;
    const barRow = byLoc.find(x => Number(x.location_id) === Number(bar));
    assert.ok(barRow && Number(barRow.qty) === 12, 'bar dolabında 12 kutu görünmeli');
  });

  await step('aynı depoya transfer reddedilir', async () => {
    const main = (await api('POST', '/api/inventory/locations/default')).id;
    const r = await api('POST', '/api/inventory/transfers', {
      item_id: ITEM.kola, from_location_id: main, to_location_id: main, quantity: 1 });
    assert.strictEqual(r.status, 400);
  });

  /* =========================== seviyeler & özet ======================== */

  await step('seviyeler defterden okunur ve ham toplamla birebir aynıdır', async () => {
    const raw = await db.query(
      `SELECT item_id, SUM(quantity_in)-SUM(quantity_out) AS qty
         FROM inventory_stock_ledger WHERE client_id=? GROUP BY item_id`, [CID]);
    const levels = (await api('GET', '/api/inventory/levels?all=1')).levels;
    for (const r of raw) {
      const row = levels.find(x => x.id === r.item_id);
      assert.ok(row, 'defterde hareketi olan malzeme listede yok: ' + r.item_id);
      assert.strictEqual(Number(row.qty), Number(r.qty),
        'liste ' + row.qty + ' diyor, defter ' + r.qty + ' diyor');
    }
  });

  await step('kritik seviye altına düşen malzeme işaretlenir', async () => {
    // Kıyma has min_qty 5 and sits at 18.2 - drop it under the line on purpose
    await api('POST', '/api/inventory/waste', {
      item_id: ITEM.kiyma, quantity: 14, reason: 'kitchen', note: 'Test' });
    const crit = (await api('GET', '/api/inventory/levels?critical=1')).levels;
    assert.ok(crit.some(x => x.id === ITEM.kiyma), 'kıyma kritik listede olmalı');
    const all = (await api('GET', '/api/inventory/levels')).levels;
    assert.strictEqual(all.find(x => x.id === ITEM.kiyma).is_critical, true);
  });

  await step('özet kutuları stok değerini defterden hesaplar', async () => {
    const s = (await api('GET', '/api/inventory/summary')).summary;
    const levels = (await api('GET', '/api/inventory/levels')).levels;
    const expect = Math.round(levels.reduce((a, r) => a + r.stock_value, 0) * 100) / 100;
    assert.strictEqual(s.total_value, expect, 'özet ile liste aynı sayıyı vermeli');
    assert.ok(s.critical_count >= 1);
    assert.strictEqual(s.item_count, 3);
  });

  /* ============================ veri bütünlüğü ========================= */

  await step('hareketi olan malzeme silinmez, pasife alınır', async () => {
    // item_delete.php was one unguarded DELETE and orphaned 210 units of live stock
    const r = await api('DELETE', `/api/inventory/items/${ITEM.un}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.deactivated, true, 'geçmişi olan malzeme silinmemeli');
    const row = await db.one('SELECT is_active FROM inventory_items WHERE id=?', [ITEM.un]);
    assert.strictEqual(Number(row.is_active), 0);
    const orphans = (await api('GET', '/api/inventory/orphans')).orphans;
    assert.strictEqual(orphans.length, 0, 'öksüz defter satırı kalmamalı');
    await api('POST', '/api/inventory/items', { id: ITEM.un, name: 'Un', unit: 'kg', min_qty: 20, is_active: true });
  });

  await step('hiç hareketi olmayan malzeme silinebilir', async () => {
    const c = await api('POST', '/api/inventory/items', { name: 'Deneme Maydanoz', unit: 'kg' });
    const r = await api('DELETE', `/api/inventory/items/${c.id}`);
    assert.strictEqual(r.deleted, true);
    assert.strictEqual(await db.one('SELECT id FROM inventory_items WHERE id=?', [c.id]), null);
  });

  await step('onaylı fatura iptali stoğu geri alır ama geçmişi silmez', async () => {
    const before = await levelOf(ITEM.kiyma);
    const rowsBefore = Number(await db.value(
      'SELECT COUNT(*) FROM inventory_stock_ledger WHERE client_id=? AND source_id=?', [CID, docId]));
    const r = await api('POST', `/api/inventory/documents/${docId}/cancel`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(await levelOf(ITEM.kiyma), Math.round((before - 20) * 1000) / 1000,
      'iptal, faturanın getirdiği 20 kg kıymayı geri almalı');
    const rowsAfter = Number(await db.value(
      'SELECT COUNT(*) FROM inventory_stock_ledger WHERE client_id=? AND source_id=?', [CID, docId]));
    assert.ok(rowsAfter > rowsBefore, 'iptal ters kayıt yazmalı, eski satırları silmemeli');
  });

  await step('kapanışın kendi transaction\'ı içinden de çağrılabilir', async () => {
    /*
     * This is how orders.closeIfPaid is meant to call it: inside the
     * transaction that closes the bill, so the money and the stock can never
     * end up on opposite sides of a crash. Opening a second connection from
     * inside that transaction would deadlock on a busy Friday.
     */
    const o = await api('POST', '/api/pos/orders', { table_id: table });
    await api('POST', `/api/pos/orders/${o.order_id}/items`, { product_id: P.lahmacun, qty: 5 });
    const before = await levelOf(ITEM.un);
    const out = await db.tx(t => inv.applyStockForOrderIn(t, CID, o.order_id, uid));
    assert.strictEqual(out.applied, 1);
    assert.strictEqual(await levelOf(ITEM.un), Math.round((before - 0.5) * 1000) / 1000,
      '5 lahmacun 0.5 kg un yemeli');
    // and reversing a single line gives back only that part
    const line = (await api('GET', `/api/pos/orders/${o.order_id}`)).order.items[0];
    await db.tx(t => inv.reverseLineIn(t, CID, line.id, 2, uid));
    assert.strictEqual(await levelOf(ITEM.un), Math.round((before - 0.3) * 1000) / 1000,
      'iki lahmacun iptali 0.2 kg un geri vermeli');
  });

  await step('modül fonksiyonları HTTP olmadan da aynı sonucu verir', async () => {
    // every close path reaches the same function; the router is only one door
    const lvl = await inv.levelFor(CID, ITEM.kola);
    const viaHttp = (await api('GET', '/api/inventory/levels?all=1')).levels.find(x => x.id === ITEM.kola);
    assert.strictEqual(Number(lvl.qty), Number(viaHttp.qty));
  });

  /* ================================= sonuç ============================= */
  const failed = results.filter(x => x[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' kontrol geçti');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
