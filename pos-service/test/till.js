'use strict';
/**
 * KASA - vardiya, cekmece, kasa sayimi, X raporu.
 *
 * Every check runs against a real MariaDB and the real HTTP service, in the
 * order a cashier walks: open the drawer with a float, sell, pay money in and
 * out of it, count it, close it against the count and read the variance.
 * Nothing is mocked, because the bugs this suite exists to catch - card money
 * inflating the drawer, a cash-out with no note, a closed shift quietly
 * restating itself when a late payment syncs in - are exactly the kind a mock
 * hides.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/till.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7468';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
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

/** Money comparison. Two figures that agree to the kurus are the same figure. */
const near = (a, b, what) => assert.ok(Math.abs(Number(a) - Number(b)) < 0.005,
  `${what}: ${a} != ${b}`);

/**
 * The migration is applied here rather than assumed.
 *
 * The desktop shell re-runs every file in database/migrations on each start; a
 * test run has no shell, and a suite that dies with "Table pos_drawer_events
 * doesn't exist" tells the next person nothing about the drawer. The file is
 * written to be idempotent, so this is the same thing the shell does.
 */
async function migrate() {
  const file = path.join(__dirname, '..', '..', 'database', 'migrations', '2026-09-03-till.sql');
  const sql = fs.readFileSync(file, 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await db.exec(stmt); } catch (_) { /* already applied */ }
  }
}

/**
 * A till we control completely, so every figure below is checkable by hand.
 * The shift tables are emptied for this tenant only - the suites share one
 * database and the previous one left a drawer open more often than not.
 */
async function fixture() {
  await db.exec('DELETE FROM pos_drawer_events WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM pos_cash_counts WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM pos_shift_movements WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM loyalty_events WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM order_discounts WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM order_payments WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM station_projection_items WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM order_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM orders WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM pos_shifts WHERE client_id=?', [CID]);
  // a day closed by an earlier suite refuses every new bill, and this one needs bills
  await db.exec('DELETE FROM daily_closings WHERE client_id=?', [CID]);

  let cat = await db.one('SELECT id FROM categories WHERE client_id=? LIMIT 1', [CID]);
  if (!cat) {
    cat = { id: await db.insert(
      'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,1,1,1,1)',
      [CID, 'Kasa Testi']) };
  }
  /* Reuse the dish if a previous run left it: products survive this fixture on
     purpose - the bills that referenced them are gone, the menu row is not. */
  const URUN = 'Kasa Testi Tabagi';
  let urunRow = await db.one('SELECT id FROM products WHERE client_id=? AND name=?', [CID, URUN]);
  if (!urunRow) {
    urunRow = { id: await db.insert(
      `INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,sort_order,
          is_active,use_in_pos,use_in_qr,track_stock) VALUES (?,?,?,?,?,?,0,1,1,1,0)`,
      [CID, cat.id, URUN, 100, 40, 10]) };
  }
  const urun = urunRow.id;

  const NAME = 'Kasa Test Masasi';
  let table = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? AND name=?', [CID, NAME]);
  if (!table) {
    let zone = await db.one('SELECT id FROM table_zones WHERE client_id=? LIMIT 1', [CID]);
    const zoneId = zone ? zone.id : await db.insert(
      'INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']);
    table = { id: await db.insert(
      'INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active) VALUES (?,?,?,98,1)',
      [CID, zoneId, NAME]) };
  }
  return { urun, table: table.id };
}

/** Ring up one bill and pay it with one payment. Returns the order id. */
async function sell(P, qty, method, amount) {
  const o = await api('POST', '/api/pos/orders', { table_id: P.table });
  assert.ok(o.order_id, 'adisyon acilamadi: ' + JSON.stringify(o));
  const it = await api('POST', `/api/pos/orders/${o.order_id}/items`, { product_id: P.urun, qty });
  assert.strictEqual(it.status, 200, JSON.stringify(it));
  const pay = await api('POST', `/api/pos/orders/${o.order_id}/payments`, { method, amount });
  assert.strictEqual(pay.status, 200, JSON.stringify(pay));
  return o.order_id;
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  await migrate();
  console.log('\nNOKTApp POS - kasa / vardiya\n');

  const catalog = require('../src/modules/catalog');
  await db.exec('DELETE FROM users WHERE client_id=? AND username=?', [CID, 'kasaci']);
  const uid = await catalog.saveUser(CID, {
    display_name: 'Test Kasiyer', username: 'kasaci', role: 'admin', pin: '5678', password: 'kasa1234',
  }, null);
  TOKEN = await auth.issueToken({ cid: CID, uid, role: 'admin', name: 'Test Kasiyer', kind: 'pos' });
  const P = await fixture();

  /* ============================ vardiya acilisi ======================== */
  await step('kasa kapaliyken durum bos doner ve acilis bekler', async () => {
    const r = await api('GET', '/api/till/state');
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.shift, null, 'acik vardiya olmamaliydi');
    assert.strictEqual(r.denominations.length, 9, 'kupur listesi eksik');
  });

  await step('eksi acilis kasasi reddedilir', async () => {
    const r = await api('POST', '/api/till/shift/open', { opening_float: -50 });
    assert.strictEqual(r.status, 400, JSON.stringify(r));
    assert.ok(/eksi/i.test(r.error), r.error);
  });

  let shiftA = null;
  await step('vardiya acilis kasasi ile acilir', async () => {
    const r = await api('POST', '/api/till/shift/open', { opening_float: 500, note: 'sabah vardiyasi' });
    assert.strictEqual(r.ok, true, r.error);
    shiftA = r.shift.shift.id;
    near(r.shift.opening_float, 500, 'acilis kasasi');
    near(r.shift.expected_cash, 500, 'satis yokken kasada acilis kadari olmali');
    assert.strictEqual(r.shift.shift.status, 'open');
    assert.strictEqual(r.shift.shift.note, 'sabah vardiyasi');
  });

  await step('ikinci kez vardiya acmak reddedilir', async () => {
    const r = await api('POST', '/api/till/shift/open', { opening_float: 100 });
    assert.strictEqual(r.status, 409, JSON.stringify(r));
    const n = Number(await db.value("SELECT COUNT(*) FROM pos_shifts WHERE client_id=? AND status='open'", [CID]));
    assert.strictEqual(n, 1, 'ikinci vardiya acilmis: ' + n);
  });

  /* ============================== nakit satis ========================== */
  await step('vardiya icinde alinan nakit kasada olmasi gerekene eklenir', async () => {
    await sell(P, 3, 'nakit', 300);          // 3 x 100
    const s = (await api('GET', '/api/till/state')).shift;
    near(s.cash_sales, 300, 'nakit satis');
    near(s.expected_cash, 800, 'acilis 500 + nakit 300');
    assert.strictEqual(s.order_count, 1, 'adisyon sayisi');
  });

  await step('kart satisi kasadaki nakdi sismez', async () => {
    await sell(P, 2, 'kredi_karti', 200);
    const s = (await api('GET', '/api/till/state')).shift;
    near(s.card_sales, 200, 'kart satis');
    near(s.expected_cash, 800, 'kart parasi cekmecede degil');
    assert.strictEqual(s.order_count, 2);
  });

  /* ============================ kasa hareketi ========================== */
  await step('kasaya para girisi kasada olmasi gerekeni artirir', async () => {
    const r = await api('POST', '/api/till/movements', { direction: 'in', amount: 250, reason: 'bozukluk takviyesi' });
    assert.strictEqual(r.ok, true, r.error);
    const s = (await api('GET', '/api/till/state')).shift;
    near(s.paid_in, 250, 'kasaya giren');
    near(s.expected_cash, 1050, '500 + 300 + 250');
  });

  await step('aciklamasiz para cikisi reddedilir', async () => {
    const r = await api('POST', '/api/till/movements', { direction: 'out', amount: 100 });
    assert.strictEqual(r.status, 400, JSON.stringify(r));
    assert.strictEqual(r.code, 'reason_required', 'kod: ' + r.code);
    const s = (await api('GET', '/api/till/state')).shift;
    near(s.paid_out, 0, 'reddedilen cikis defterе yazilmamali');
    near(s.expected_cash, 1050, 'reddedilen cikis kasayi degistirmemeli');
  });

  await step('sadece bosluktan olusan aciklama da reddedilir', async () => {
    const r = await api('POST', '/api/till/movements', { direction: 'out', amount: 100, reason: '   ' });
    assert.strictEqual(r.status, 400, JSON.stringify(r));
    assert.strictEqual(r.code, 'reason_required');
  });

  await step('aciklamali gider odemesi kasadan dusulur', async () => {
    const r = await api('POST', '/api/till/movements',
      { direction: 'out', amount: 150, reason: 'Tedarikci odemesi - manav' });
    assert.strictEqual(r.ok, true, r.error);
    const s = (await api('GET', '/api/till/state')).shift;
    near(s.paid_out, 150, 'kasadan cikan');
    near(s.expected_cash, 900, '500 + 300 + 250 - 150');
  });

  await step('sifir tutarli hareket reddedilir', async () => {
    const r = await api('POST', '/api/till/movements', { direction: 'in', amount: 0 });
    assert.strictEqual(r.status, 400, JSON.stringify(r));
  });

  await step('her hareket kimin ve ne zaman oldugunu yazar', async () => {
    const r = await api('GET', '/api/till/movements');
    assert.strictEqual(r.movements.length, 2, 'iki hareket bekleniyordu');
    for (const m of r.movements) {
      assert.strictEqual(m.user_name, 'Test Kasiyer', 'hareketi kimin yaptigi kayitli degil');
      assert.ok(m.created_at, 'hareket zamani yok');
    }
    const out = r.movements.find(m => m.direction === 'out');
    assert.strictEqual(out.reason, 'Tedarikci odemesi - manav');
  });

  /* ============================== kasa sayimi ========================== */
  await step('kupur sayaci toplami parcalarinin toplamina esittir', async () => {
    // 400 + 300 + 50 + 80 + 10 + 10 kagit = 850,00; 3,00 + 0,50 + 0,50 madeni = 854,00
    const counts = { 20000: 2, 10000: 3, 5000: 1, 2000: 4, 1000: 1, 500: 2, 100: 3, 50: 1, 25: 2 };
    const r = await api('POST', '/api/till/count/total', { counts });
    assert.strictEqual(r.ok, true, r.error);
    const byHand = Object.entries(counts).reduce((a, [m, n]) => a + Number(m) * n, 0);
    assert.strictEqual(r.total_minor, byHand, `${r.total_minor} != ${byHand}`);
    near(r.total, 854, 'sayim toplami');
    // and every line has to add up on its own, not just the grand total
    for (const l of r.lines) assert.strictEqual(l.total_minor, l.minor * l.count, 'satir: ' + l.label);
  });

  await step('bos sayaç sifir doner, eksi adet reddedilir', async () => {
    const zero = await api('POST', '/api/till/count/total', { counts: {} });
    assert.strictEqual(zero.total_minor, 0);
    const neg = await api('POST', '/api/till/count/total', { counts: { 10000: -1 } });
    assert.strictEqual(neg.status, 400, JSON.stringify(neg));
  });

  await step('ara sayim beklenen ile farki kaydeder', async () => {
    // kasada olmasi gereken 900; 9x100 sayarsak fark sifir
    const r = await api('POST', '/api/till/count', { counts: { 10000: 9 }, note: 'ara kontrol' });
    assert.strictEqual(r.ok, true, r.error);
    near(r.count.total, 900, 'sayilan');
    near(r.count.expected, 900, 'beklenen');
    near(r.count.variance, 0, 'fark');
    const saved = await db.one('SELECT * FROM pos_cash_counts WHERE client_id=? ORDER BY id DESC LIMIT 1', [CID]);
    assert.strictEqual(saved.kind, 'ara');
    assert.strictEqual(saved.counted_by_name, 'Test Kasiyer');
    assert.deepStrictEqual(JSON.parse(saved.breakdown_json), [{ minor: 10000, count: 9 }]);
  });

  /* =============================== X raporu ============================ */
  await step('X raporu vardiya durumu ile birebir ayni', async () => {
    const s = (await api('GET', '/api/till/state')).shift;
    const x = (await api('GET', '/api/till/x-report')).report;
    assert.strictEqual(x.shift.id, s.shift.id);
    near(x.expected_cash, s.expected_cash, 'kasada olmasi gereken');
    near(x.cash_sales, s.cash_sales, 'nakit');
    near(x.card_sales, s.card_sales, 'kart');
    near(x.paid_in, s.paid_in, 'giren');
    near(x.paid_out, s.paid_out, 'cikan');
    near(x.opening_float, s.opening_float, 'acilis');
    assert.strictEqual(x.bill_count, s.order_count, 'adisyon sayisi');
  });

  await step('X raporu tahsilati ve ortalama adisyonu dogru hesaplar', async () => {
    const x = (await api('GET', '/api/till/x-report')).report;
    near(x.takings, 500, 'nakit 300 + kart 200');
    assert.strictEqual(x.bill_count, 2);
    near(x.average_bill, 250, 'ortalama adisyon');
    const byMethod = Object.fromEntries(x.breakdown.map(b => [b.method, b.total]));
    near(byMethod.nakit, 300, 'nakit dokum');
    near(byMethod.kredi_karti, 200, 'kart dokum');
  });

  await step('X raporu vardiyayi kapatmaz ve sifirlamaz', async () => {
    await api('POST', '/api/till/x-report/print');
    const s = (await api('GET', '/api/till/state')).shift;
    assert.strictEqual(s.shift.status, 'open', 'X raporu vardiyayi kapatmis');
    near(s.expected_cash, 900, 'X raporu rakamlari sifirlamis');
    const job = await db.one("SELECT * FROM print_jobs WHERE client_id=? AND job_type='report' ORDER BY id DESC LIMIT 1", [CID]);
    assert.ok(job, 'X raporu yaziciya kuyruklanmadi');
  });

  /* ================================ cekmece ============================ */
  await step('cekmece acmak denetim satiri yazar', async () => {
    const before = Number(await db.value('SELECT COUNT(*) FROM pos_drawer_events WHERE client_id=?', [CID]));
    const r = await api('POST', '/api/till/drawer', { reason: 'Bozuk para almak icin' });
    assert.strictEqual(r.ok, true, r.error);
    const row = await db.one('SELECT * FROM pos_drawer_events WHERE client_id=? ORDER BY id DESC LIMIT 1', [CID]);
    assert.strictEqual(Number(await db.value('SELECT COUNT(*) FROM pos_drawer_events WHERE client_id=?', [CID])), before + 1);
    assert.strictEqual(row.user_name, 'Test Kasiyer', 'kim actigi yazilmamis');
    assert.strictEqual(row.reason, 'Bozuk para almak icin');
    assert.strictEqual(row.order_id, null, 'satissiz acilis satis gibi kaydedilmis');
    assert.strictEqual(row.source, 'manual');
    assert.strictEqual(String(row.shift_id), String(shiftA), 'acilis vardiyaya baglanmamis');
    assert.ok(row.created_at, 'ne zaman acildigi yok');
  });

  await step('satissiz cekmece acilislari kayitta ayirt edilir', async () => {
    const order = await sell(P, 1, 'nakit', 100);
    await api('POST', '/api/till/drawer', { reason: 'Para ustu', order_id: order });
    const log = await api('GET', '/api/till/drawer/log');
    assert.strictEqual(log.events.length, 2, 'iki acilis bekleniyordu');
    const noSale = (await api('GET', '/api/till/drawer/log?no_sale=1')).events;
    assert.strictEqual(noSale.length, 1, 'satissiz acilis sayisi');
    assert.strictEqual(noSale[0].reason, 'Bozuk para almak icin');
    const me = log.by_user.find(u => u.name === 'Test Kasiyer');
    assert.strictEqual(me.total, 2);
    assert.strictEqual(me.no_sale, 1);
  });

  /* ============================= vardiya kapanisi ====================== */
  await step('kasa sayilmadan kapatma reddedilir', async () => {
    const r = await api('POST', '/api/till/shift/close', {});
    assert.strictEqual(r.status, 400, JSON.stringify(r));
  });

  let closedA = null;
  await step('eksik kasa ile kapanis farki eksi yazar', async () => {
    // beklenen 1000 (900 + son satisin 100 nakdi); sayilan 940 -> 60 eksik
    const before = (await api('GET', '/api/till/state')).shift;
    near(before.expected_cash, 1000, 'kapanis oncesi beklenen');
    const r = await api('POST', '/api/till/shift/close',
      { counts: { 10000: 9, 2000: 2 }, note: 'aksam devri' });   // 900 + 40 = 940
    assert.strictEqual(r.ok, true, r.error);
    closedA = r.shift.shift.id;
    near(r.shift.counted_cash, 940, 'sayilan');
    near(r.shift.expected_cash, 1000, 'beklenen');
    near(r.shift.variance, -60, 'fark eksi olmali');
    assert.strictEqual(r.shift.shift.status, 'closed');
    const row = await db.one('SELECT * FROM pos_shifts WHERE id=?', [closedA]);
    assert.strictEqual(Number(row.variance_minor), -6000, 'kurus cinsinden fark');
    assert.strictEqual(Number(row.counted_cash_minor), 94000);
  });

  await step('kapanis sayimi kupur dokumu ile saklanir', async () => {
    const c = await db.one("SELECT * FROM pos_cash_counts WHERE client_id=? AND kind='close' ORDER BY id DESC LIMIT 1", [CID]);
    assert.ok(c, 'kapanis sayimi kaydedilmemis');
    assert.strictEqual(Number(c.total_minor), 94000);
    assert.strictEqual(Number(c.variance_minor), -6000);
    assert.deepStrictEqual(JSON.parse(c.breakdown_json), [{ minor: 10000, count: 9 }, { minor: 2000, count: 2 }]);
  });

  await step('kapali vardiyada kasa hareketi yapilamaz', async () => {
    const r = await api('POST', '/api/till/movements', { direction: 'in', amount: 10, reason: 'olmaz' });
    assert.strictEqual(r.status, 409, JSON.stringify(r));
  });

  await step('kapali vardiya ozeti okunmaya devam eder', async () => {
    const r = await api('GET', '/api/till/shifts/' + closedA);
    assert.strictEqual(r.ok, true, r.error);
    near(r.shift.counted_cash, 940, 'sayilan');
    near(r.shift.variance, -60, 'fark');
    assert.strictEqual(r.movements.length, 2, 'hareketleri de gorunur kalmali');
    assert.ok(r.counts.length >= 2, 'sayimlari gorunur kalmali');
    const state = await api('GET', '/api/till/state');
    assert.strictEqual(state.shift, null, 'acik vardiya kalmamali');
    near(state.last_closed.variance, -60, 'son kapanan vardiya ekranda kalmali');
  });

  await step('kapandiktan sonra gelen odeme kapali vardiyanin rakamlarini degistirmez', async () => {
    /*
     * The scenario is real: a phone or a second till that was offline syncs a
     * payment in an hour after the drawer was counted and signed off. The
     * ledger gets the row - it is money that was taken - but the closed shift
     * is a record and must read back exactly as it was closed.
     */
    const beforeRow = await api('GET', '/api/till/shifts/' + closedA);
    const order = await db.one('SELECT id FROM orders WHERE client_id=? ORDER BY id DESC LIMIT 1', [CID]);
    await db.insert(
      `INSERT INTO order_payments (client_id, order_id, method, amount, payment_channel, created_at,
          created_by, is_deleted, shift_id) VALUES (?,?,'nakit',?, 'pos', NOW(), ?, 0, ?)`,
      [CID, order.id, 777, uid, closedA]);
    const after = await api('GET', '/api/till/shifts/' + closedA);
    near(after.shift.expected_cash, beforeRow.shift.expected_cash, 'beklenen degismis');
    near(after.shift.cash_sales, beforeRow.shift.cash_sales, 'nakit satis degismis');
    near(after.shift.variance, -60, 'kapali vardiyanin farki degismis');
    await db.exec('DELETE FROM order_payments WHERE client_id=? AND amount=777', [CID]);
  });

  /* ======================= ikinci vardiya: fazla kasa =================== */
  let shiftB = null;
  await step('kapanistan sonra yeni vardiya acilabilir', async () => {
    const r = await api('POST', '/api/till/shift/open', { opening_float: 200 });
    assert.strictEqual(r.ok, true, r.error);
    shiftB = r.shift.shift.id;
    assert.notStrictEqual(shiftB, closedA);
    assert.strictEqual(r.shift.shift.shift_no, 2, 'gun icindeki ikinci vardiya');
  });

  await step('yeni vardiya onceki vardiyanin satislarini devralmaz', async () => {
    const s = (await api('GET', '/api/till/state')).shift;
    near(s.cash_sales, 0, 'yeni vardiyada satis olmamali');
    near(s.expected_cash, 200, 'sadece acilis kasasi');
    assert.strictEqual(s.order_count, 0);
  });

  await step('fazla kasa ile kapanis farki arti yazar', async () => {
    await sell(P, 1, 'nakit', 100);
    const r = await api('POST', '/api/till/shift/close', { counted_cash: 325 });   // beklenen 300
    assert.strictEqual(r.ok, true, r.error);
    near(r.shift.expected_cash, 300, 'beklenen');
    near(r.shift.counted_cash, 325, 'sayilan');
    near(r.shift.variance, 25, 'fark arti olmali');
  });

  /* ============================ vardiya gecmisi ======================== */
  await step('vardiya gecmisi kapanan kasalari farklariyla listeler', async () => {
    const r = await api('GET', '/api/till/shifts');
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(r.shifts.length >= 2, 'iki kapanmis vardiya bekleniyordu');
    const a = r.shifts.find(s => s.id === closedA);
    const b = r.shifts.find(s => s.id === shiftB);
    near(a.variance, -60, 'ilk vardiyanin farki');
    near(b.variance, 25, 'ikinci vardiyanin farki');
    assert.strictEqual(a.closed_by_name, 'Test Kasiyer');
  });

  await step('surekli eksik veren kasiyer gecmiste gorunur', async () => {
    const r = await api('GET', '/api/till/shifts');
    const me = r.by_user.find(u => u.name === 'Test Kasiyer');
    assert.ok(me, 'kasiyer ozeti yok');
    assert.strictEqual(me.shifts, 2);
    assert.strictEqual(me.short, 1, 'eksik kapanan vardiya sayisi');
    assert.strictEqual(me.over, 1, 'fazla kapanan vardiya sayisi');
    near(me.net, -35, 'net fark: -60 + 25');
  });

  await step('acik vardiya yokken X raporu istenmez', async () => {
    const r = await api('GET', '/api/till/x-report');
    assert.strictEqual(r.status, 409, JSON.stringify(r));
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) failed.forEach(f => console.log('  ! ' + f[1] + ': ' + f[2]));
  server.close();
  process.exit(failed.length ? 1 : 0);
})();
