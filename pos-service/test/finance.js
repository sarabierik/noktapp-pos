'use strict';
/**
 * Finans: İşlemler, Gün sonu, Finans raporu.
 *
 * The things that actually go wrong with a restaurant's books, proved against a
 * real MariaDB and the real HTTP service with nothing mocked:
 *
 *   - a bill that was signed off in a day-end can still be deleted, so last
 *     month's takings change after the accountant has seen them;
 *   - "Geri al" does not put the money back, it reopens the table;
 *   - the closing record stores zeros, so nobody can tell that a bill was
 *     edited after the day was closed;
 *   - a bulk delete reaches outside the range or the method it was given;
 *   - a CSV shows different rows from the screen it came off.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/finance.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7464';
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
let OWNER = null;   // the tenant login - the only session allowed to delete
let STAFF = null;   // role admin, but staff: everything except the destructive buttons

async function api(method, path, body, token = OWNER) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}
async function raw(path, token = OWNER) {
  const res = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token } });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

const tlTest = (n) => (Math.round(Number(n || 0) * 100) / 100)
  .toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayOf = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const D1 = dayOf(5), D2 = dayOf(4), D3 = dayOf(3), TODAY = dayOf(0);

/* ------------------------------------------------------------ fixture */
let P = {}, TABLE = null, UID = null;

async function fixture() {
  for (const sql of [
    'DELETE FROM loyalty_events WHERE client_id=?',
    'DELETE FROM order_discounts WHERE client_id=?',
    'DELETE FROM order_item_cancel_events WHERE client_id=?',
    'DELETE FROM order_items WHERE client_id=?',
    'DELETE FROM order_payments WHERE client_id=?',
    'DELETE FROM payment_delete_logs WHERE client_id=?',
    'DELETE FROM order_delete_logs WHERE client_id=?',
    'DELETE FROM orders WHERE client_id=?',
    'DELETE FROM products WHERE client_id=?',
    'DELETE FROM categories WHERE client_id=?',
    'DELETE FROM daily_costs WHERE client_id=?',
    'DELETE FROM daily_closings WHERE client_id=?',
    'DELETE FROM finance_daily_snapshots WHERE client_id=?',
    'DELETE FROM audit_logs WHERE client_id=?',
    'DELETE FROM np_mail_queue WHERE client_id=?',
  ]) await db.exec(sql, [CID]).catch(() => {});

  const cat = await db.insert(
    'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,1,1,1,1)',
    [CID, 'Yemekler']);
  const drinks = await db.insert(
    'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,2,1,1,1)',
    [CID, 'İçecekler']);
  const mk = (c, n, price, cost, vat) => db.insert(
    `INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,sort_order,
        is_active,use_in_pos,use_in_qr,track_stock) VALUES (?,?,?,?,?,?,0,1,1,1,0)`,
    [CID, c, n, price, cost, vat]);
  P = {
    kebap: await mk(cat, 'Adana Kebap', 420, 160, 10),
    pide: await mk(cat, 'Kıymalı Pide', 220, 70, 10),
    bira: await mk(drinks, 'Efes Pilsen', 180, 70, 20),
    su: await mk(drinks, 'Su', 30, 10, 10),
  };

  const NAME = 'Finans Test Masasi';
  const existing = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? AND name=?', [CID, NAME]);
  if (existing) TABLE = existing.id;
  else {
    let zone = await db.one('SELECT id FROM table_zones WHERE client_id=? LIMIT 1', [CID]);
    const zoneId = zone ? zone.id : await db.insert(
      'INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']);
    TABLE = await db.insert(
      'INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active) VALUES (?,?,?,98,1)',
      [CID, zoneId, NAME]);
  }
}

/** A bill rung up through the real till API, paid in full, then dated. */
async function bill(date, method, lines) {
  const o = await api('POST', '/api/pos/orders', { table_id: TABLE });
  if (!o.order_id) throw new Error('adisyon acilamadi: ' + JSON.stringify(o));
  for (const [product, qty] of lines) {
    const a = await api('POST', `/api/pos/orders/${o.order_id}/items`, { product_id: product, qty });
    if (a.status !== 200) throw new Error('kalem eklenemedi: ' + JSON.stringify(a));
  }
  const full = (await api('GET', `/api/pos/orders/${o.order_id}`)).order;
  const p = await api('POST', `/api/pos/orders/${o.order_id}/payments`,
    { method, amount: Number(full.grand_total) });
  if (p.status !== 200) throw new Error('odeme alinamadi: ' + JSON.stringify(p));
  if (date !== TODAY) {
    // place it in the past: business_date is the reporting basis, closed_at the lock basis
    await db.exec('UPDATE orders SET business_date=?, closed_at=CONCAT(?, \' 20:00:00\') WHERE id=?',
      [date, date, o.order_id]);
    await db.exec('UPDATE order_payments SET created_at=CONCAT(?, \' 20:00:00\') WHERE order_id=?',
      [date, o.order_id]);
  }
  return { id: o.order_id, total: Number(full.grand_total) };
}


/* ---------------------------------------------------------- the screen */
/*
 * There is no browser in this environment, so the screen file is mounted
 * against a minimal DOM stub and pointed at the REAL service. It catches the
 * class of bug that only shows up when a template literal reads a field the API
 * does not send - a blank panel on the till, which nobody notices until an
 * owner rings up about a missing number.
 */
function mountScreens() {
  const fs = require('fs');
  const vm = require('vm');
  const nodes = new Map();
  const el = (sel) => {
    if (!nodes.has(sel)) {
      nodes.set(sel, {
        sel, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
        dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
        onclick: null, onchange: null, addEventListener() {}, focus() {}, remove() {},
      });
    }
    return nodes.get(sel);
  };
  const Screens = {
    add(o) { Object.assign(Screens, o); },
    download() {}, render() {},
  };
  const captured = { modal: '' };
  const ctx = {
    registerIcon() {}, registerPage() {}, Screens,
    $: el, $$: () => [],
    esc: (s) => String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    tl: (n) => (Math.round(Number(n || 0) * 100) / 100)
      .toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    label: (m) => m,
    api: async (method, path, body) => {
      const r = await api(method, path, body);
      if (r.ok === false) throw new Error(r.error || 'hata');
      return r;
    },
    modal: (html) => { captured.modal = html; },
    closeModal() {}, toast() {}, err() {}, go() {},
    confirmBox: async () => true,
    App: { token: OWNER, perms: [], user: { role: 'admin' } },
    can: () => true,
    window: { print() {}, open() {} },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../public/screens/finance.js', 'utf8'), ctx,
    { filename: 'screens/finance.js' });
  return { Screens, el, captured };
}

const liveDay = async (d) => {
  const pnl = require('../src/modules/pnl');
  return (await pnl.profitAndLoss(CID, d, d)).totals;
};

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - finans: islemler, gun sonu, rapor\n');

  const catalog = require('../src/modules/catalog');
  await db.exec('DELETE FROM users WHERE client_id=? AND username=?', [CID, 'finansci']);
  UID = await catalog.saveUser(CID, {
    display_name: 'Finans Testçi', username: 'finansci', role: 'admin', pin: '9182', password: 'test1234',
  }, null);
  OWNER = await auth.issueToken({ cid: CID, uid: UID, role: 'admin', name: 'Sahip', kind: 'tenant' });
  STAFF = await auth.issueToken({ cid: CID, uid: UID, role: 'admin', name: 'Müdür', kind: 'staff' });

  await fixture();
  const b1 = await bill(D1, 'nakit', [[P.kebap, 1]]);          // 420
  const b2 = await bill(D1, 'kredi_karti', [[P.pide, 2]]);     // 440
  const b3 = await bill(D2, 'nakit', [[P.bira, 1]]);           // 180
  const b4 = await bill(D2, 'kredi_karti', [[P.kebap, 1]]);    // 420
  const b5 = await bill(D3, 'nakit', [[P.su, 2]]);             // 60
  await db.exec('INSERT INTO daily_costs (client_id,date,category,description,amount,created_by,created_at) VALUES (?,?,?,?,?,?,NOW())',
    [CID, D2, 'Personel', 'Test gideri', 250, UID]);

  /* ===================== A. list, detail, search ===================== */
  await step('kapalı adisyonlar tarih aralığıyla listeleniyor', async () => {
    const r = await api('GET', `/api/finance/transactions?from=${D1}&to=${D3}`);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.rows.length, 5, 'beş adisyon bekleniyordu, gelen: ' + r.rows.length);
    assert.strictEqual(r.totals.counted, 420 + 440 + 180 + 420 + 60);
    assert.ok(r.rows.every(x => x.locked === false), 'kapanış yokken hiçbir adisyon kilitli olamaz');
  });

  await step('ödeme rozeti tek yöntemde yöntemi, karışıkta karışığı gösteriyor', async () => {
    const r = await api('GET', `/api/finance/transactions?from=${D1}&to=${D1}`);
    const cash = r.rows.find(x => x.id === b1.id);
    assert.deepStrictEqual(cash.methods, ['nakit']);
    assert.strictEqual(cash.method_count, 1);
  });

  await step('adisyon detayında satırlar adisyonun kendi toplamına eşit', async () => {
    const r = await api('GET', `/api/finance/transactions/${b2.id}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.items.length, 1);
    // the PHP read oi.price and rebuilt qty*price; nothing writes that column,
    // so every line showed 0,00. These come from unit_price / line_total.
    assert.ok(r.items[0].unit_price > 0, 'birim fiyat sıfır geldi: ' + r.items[0].unit_price);
    assert.strictEqual(r.totals.grand, r.order.grand_total,
      'satırlar ' + r.totals.grand + ' diyor, adisyon ' + r.order.grand_total);
    assert.strictEqual(r.totals.paid, r.order.grand_total, 'ödeme toplamı adisyonu karşılamıyor');
  });

  await step('durum filtresi ve arama çalışıyor', async () => {
    const all = await api('GET', `/api/finance/transactions?from=${D1}&to=${D3}&status=paid`);
    assert.strictEqual(all.rows.length, 5);
    const one = await db.one('SELECT adisyon_no FROM orders WHERE id=?', [b4.id]);
    const found = await api('GET', `/api/finance/transactions?from=${D1}&to=${D3}&q=${one.adisyon_no}`);
    assert.strictEqual(found.rows.length, 1, 'adisyon no ile arama tek satır döndürmeli');
    assert.strictEqual(found.rows[0].id, b4.id);
  });

  /* ===================== B. owner gate ============================== */
  await step('personel hesabı adisyon silemiyor (düğmeyi gizlemek yetki değildir)', async () => {
    const r = await api('POST', `/api/finance/transactions/${b3.id}/delete`, {}, STAFF);
    assert.strictEqual(r.status, 403, JSON.stringify(r));
    assert.strictEqual(r.code, 'OWNER_ONLY');
    const still = await db.one('SELECT exclude_from_reports FROM orders WHERE id=?', [b3.id]);
    assert.strictEqual(Number(still.exclude_from_reports), 0, 'reddedilen istek yine de sildi');
  });

  await step('personel hesabı toplu silme ve geri alma da yapamıyor', async () => {
    for (const [path, body] of [
      ['/api/finance/transactions/delete', { ids: [b3.id] }],
      ['/api/finance/transactions/bulk-delete', { method: 'nakit', from: D1, to: D3 }],
      [`/api/finance/transactions/${b3.id}/restore`, {}],
    ]) {
      const r = await api('POST', path, body, STAFF);
      assert.strictEqual(r.status, 403, path + ' -> ' + JSON.stringify(r));
    }
  });

  /* ===================== C. delete / restore ======================== */
  await step('adisyon silinince raporlardan düşüyor ve kütüğe yazılıyor', async () => {
    const before = await liveDay(D2);
    const r = await api('POST', `/api/finance/transactions/${b3.id}/delete`, { reason: 'test' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const after = await liveDay(D2);
    assert.strictEqual(after.revenue_gross, Math.round((before.revenue_gross - b3.total) * 100) / 100,
      'ciro tam adisyon kadar düşmeliydi');
    const log = await db.one('SELECT * FROM order_delete_logs WHERE client_id=? AND order_id=?', [CID, b3.id]);
    assert.ok(log, 'order_delete_logs satırı yazılmadı (PHP hiç yazmıyordu)');
    assert.strictEqual(Number(log.grand_total), b3.total);
    const pay = await db.one('SELECT is_deleted FROM order_payments WHERE order_id=?', [b3.id]);
    assert.strictEqual(Number(pay.is_deleted), 1, 'ödemeler de silinmiş olmalı');
    const a = await db.one("SELECT * FROM audit_logs WHERE client_id=? AND action='order.delete' AND entity_id=?",
      [CID, String(b3.id)]);
    assert.ok(a, 'denetim kaydı yazılmadı');
  });

  await step('silinen adisyon "Silindi" filtresinde görünüyor', async () => {
    const r = await api('GET', `/api/finance/transactions?from=${D1}&to=${D3}&status=deleted`);
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0].id, b3.id);
    assert.strictEqual(r.rows[0].excluded, true);
  });

  await step('geri al adisyonu raporlara döndürüyor (masayı yeniden açmıyor)', async () => {
    const before = await liveDay(D2);
    const r = await api('POST', `/api/finance/transactions/${b3.id}/restore`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const after = await liveDay(D2);
    assert.strictEqual(after.revenue_gross, Math.round((before.revenue_gross + b3.total) * 100) / 100,
      'geri alınan adisyon ciroya dönmeli');
    const o = await db.one('SELECT status, closed_at, exclude_from_reports FROM orders WHERE id=?', [b3.id]);
    assert.strictEqual(o.status, 'closed', 'PHP burada adisyonu masaya geri açıyordu; kapalı kalmalı');
    assert.ok(o.closed_at, 'kapanış zamanı silinmemeli');
    const log = await db.one('SELECT * FROM order_delete_logs WHERE client_id=? AND order_id=?', [CID, b3.id]);
    assert.ok(!log, 'geri alınan adisyonun silme kütüğü kalmamalı, yoksa iki kez raporlanır');
    const a = await db.one("SELECT * FROM audit_logs WHERE client_id=? AND action='order.restore' AND entity_id=?",
      [CID, String(b3.id)]);
    assert.ok(a, 'geri alma denetim kaydı yazılmadı');
  });

  /* ===================== D. bulk by method ========================== */
  await step('yöntem bazlı toplu silme sadece o aralığa ve o yönteme dokunuyor', async () => {
    const r = await api('POST', '/api/finance/transactions/bulk-delete',
      { method: 'nakit', from: D1, to: D1 });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.deleted, 1, 'sadece D1 nakit adisyonu silinmeliydi, silinen: ' + r.deleted);
    const state = async (id) => Number((await db.one('SELECT exclude_from_reports e FROM orders WHERE id=?', [id])).e);
    assert.strictEqual(await state(b1.id), 1, 'D1 nakit silinmedi');
    assert.strictEqual(await state(b2.id), 0, 'D1 kart adisyonu silinmemeliydi (yöntem dışı)');
    assert.strictEqual(await state(b3.id), 0, 'D2 nakit adisyonu silinmemeliydi (aralık dışı)');
    assert.strictEqual(await state(b5.id), 0, 'D3 nakit adisyonu silinmemeliydi (aralık dışı)');
    const back = await api('POST', `/api/finance/transactions/${b1.id}/restore`, {});
    assert.strictEqual(back.status, 200, 'toplu silinen adisyon geri alınabilmeli: ' + JSON.stringify(back));
    assert.strictEqual(await state(b1.id), 0);
  });

  await step('500 üstü seçim reddediliyor', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    const r = await api('POST', '/api/finance/transactions/delete', { ids });
    assert.strictEqual(r.status, 400, JSON.stringify(r));
    assert.ok(/500/.test(r.error), 'hata mesajı sınırı söylemeli: ' + r.error);
  });

  /* ===================== E. day close ============================== */
  let closing = null;
  await step('gün kapanışı günün gerçek rakamlarını yazıyor (sıfır değil)', async () => {
    await api('POST', `/api/finance/transactions/${b5.id}/delete`, {});  // locked-restore fixture
    const live = await liveDay(D2);
    const r = await api('POST', `/api/finance/days/${D2}/close`, { declared_cash: 200, declared_card: 400 });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    closing = await db.one('SELECT * FROM daily_closings WHERE client_id=? AND date=? ORDER BY id DESC LIMIT 1',
      [CID, D2]);
    assert.ok(closing, 'kapanış kaydı yok');
    assert.ok(Number(closing.expected_sales) > 0, 'PHP burada 0.00 yazıyordu');
    assert.strictEqual(Number(closing.expected_sales), live.revenue_gross);
    assert.strictEqual(Number(closing.order_count), live.orders);
    assert.strictEqual(Number(closing.expected_cost), Math.round((live.cogs + live.expenses) * 100) / 100);
    assert.strictEqual(Number(closing.expected_net), live.net_profit);
    assert.strictEqual(Number(closing.expected_cash), live.cash);
    assert.strictEqual(Number(closing.expected_card), Math.round((live.card + live.other) * 100) / 100);
    assert.strictEqual(Number(closing.cash_difference), Math.round((200 - live.cash) * 100) / 100);
    const snap = await db.one('SELECT * FROM finance_daily_snapshots WHERE client_id=? AND date=?', [CID, D2]);
    assert.ok(snap && Number(snap.gross_sales) > 0, 'snapshot da gerçek rakamı taşımalı');
  });

  await step('kapanış rakamları sonradan değişen bir adisyondan etkilenmiyor', async () => {
    const beforeStored = Number(closing.expected_sales);
    await db.exec('UPDATE orders SET grand_total=grand_total+1000, total=total+1000 WHERE id=?', [b4.id]);
    const again = await db.one('SELECT * FROM daily_closings WHERE id=?', [closing.id]);
    assert.strictEqual(Number(again.expected_sales), beforeStored,
      'kapanışta yazılan ciro sonradan değişmiş - tarih sessizce yeniden yazılıyor');
    const list = await api('GET', `/api/finance/days?from=${D2}&to=${D2}`);
    const row = list.rows[0];
    assert.ok(row.stored, 'gün listesi kapanışta yazılan rakamları da göstermeli');
    assert.strictEqual(row.stored.sales, beforeStored);
    assert.notStrictEqual(row.net_sales, row.stored.sales,
      'canlı ile kapanış rakamı artık farklı olmalı ve ekran ikisini de göstermeli');
  });

  await step('aynı gün ikinci kez kapatılamıyor', async () => {
    const r = await api('POST', `/api/finance/days/${D2}/close`, {});
    assert.strictEqual(r.status, 409, JSON.stringify(r));
    assert.strictEqual(r.code, 'ALREADY_CLOSED');
    const n = Number(await db.value('SELECT COUNT(*) FROM daily_closings WHERE client_id=? AND date=?', [CID, D2]));
    assert.strictEqual(n, 1, 'mükerrer kapanış satırı yazıldı');
  });

  /* ===================== F. the checkpoint ========================== */
  await step('checkpoint öncesi kapanan adisyon silinemiyor', async () => {
    const r = await api('POST', `/api/finance/transactions/${b2.id}/delete`, {});
    assert.strictEqual(r.status, 409, JSON.stringify(r));
    assert.strictEqual(r.code, 'DAY_CLOSED');
    assert.ok(/kapatılmış/.test(r.error), 'hata Türkçe ve açık olmalı: ' + r.error);
    const o = await db.one('SELECT exclude_from_reports e FROM orders WHERE id=?', [b2.id]);
    assert.strictEqual(Number(o.e), 0, 'kilitli adisyon yine de silinmiş');
  });

  await step('checkpoint öncesi kapanan adisyon geri de alınamıyor', async () => {
    const r = await api('POST', `/api/finance/transactions/${b5.id}/restore`, {});
    assert.strictEqual(r.status, 409, JSON.stringify(r));
    assert.strictEqual(r.code, 'DAY_CLOSED');
    const o = await db.one('SELECT exclude_from_reports e FROM orders WHERE id=?', [b5.id]);
    assert.strictEqual(Number(o.e), 1, 'kilitli adisyon geri alınmış');
  });

  await step('liste kilitli satırları işaretliyor', async () => {
    const r = await api('GET', `/api/finance/transactions?from=${D1}&to=${D3}`);
    assert.ok(r.checkpoint, 'checkpoint dönmeli');
    assert.ok(r.rows.every(x => x.locked), 'checkpoint öncesi kapanan her satır kilitli olmalı');
  });

  let b6 = null;
  await step('checkpoint sonrası kapanan adisyon silinebiliyor', async () => {
    b6 = await bill(TODAY, 'nakit', [[P.su, 1]]);
    /*
     * The checkpoint is a timestamp, not a date, and the comparison is <= - a
     * bill closed in the same second as the sign-off counts as inside it, which
     * is the safe direction. The test therefore has to put this bill clearly
     * after the close rather than in the same second.
     */
    await db.exec('UPDATE orders SET closed_at=DATE_ADD(NOW(), INTERVAL 2 MINUTE) WHERE id=?', [b6.id]);
    const r = await api('POST', `/api/finance/transactions/${b6.id}/delete`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const o = await db.one('SELECT exclude_from_reports e FROM orders WHERE id=?', [b6.id]);
    assert.strictEqual(Number(o.e), 1);
    const back = await api('POST', `/api/finance/transactions/${b6.id}/restore`, {});
    assert.strictEqual(back.status, 200, 'aynı adisyon geri de alınabilmeli: ' + JSON.stringify(back));
  });

  await step('kilitli adisyon içeren aralıkta toplu silme yapılmıyor', async () => {
    const r = await api('POST', '/api/finance/transactions/bulk-delete', { method: 'nakit', from: D1, to: D3 });
    assert.strictEqual(r.status, 409, JSON.stringify(r));
    assert.strictEqual(r.code, 'DAY_CLOSED');
    assert.ok(/\d+ adisyon/.test(r.error), 'kaç adisyonun kilitli olduğunu söylemeli: ' + r.error);
  });

  await step('toplu seçimde kilitli olanlar atlanıp sayılıyor', async () => {
    const fresh = await bill(TODAY, 'nakit', [[P.su, 1]]);
    await db.exec('UPDATE orders SET closed_at=DATE_ADD(NOW(), INTERVAL 2 MINUTE) WHERE id=?', [fresh.id]);
    const r = await api('POST', '/api/finance/transactions/delete', { ids: [b2.id, fresh.id] });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.deleted, 1, 'sadece kilitsiz olan silinmeliydi');
    assert.strictEqual(r.locked, 1, 'kilitli olanın sayısı bildirilmeli');
    await api('POST', `/api/finance/transactions/${fresh.id}/restore`, {});
  });

  /* ===================== G. reopen ================================= */
  await step('gün yeniden açmayı personel yapamıyor', async () => {
    const r = await api('POST', `/api/finance/days/${D2}/reopen`, {}, STAFF);
    assert.strictEqual(r.status, 403, JSON.stringify(r));
  });

  await step('gün yeniden açılınca kilitlediği adisyonlar serbest kalıyor', async () => {
    const r = await api('POST', `/api/finance/days/${D2}/reopen`, { reason: 'düzeltme' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.checkpoint, null, 'başka kapanış yokken checkpoint kalkmalı');
    const del = await api('POST', `/api/finance/transactions/${b2.id}/delete`, {});
    assert.strictEqual(del.status, 200, 'kilit kalkmadı: ' + JSON.stringify(del));
    const res = await api('POST', `/api/finance/transactions/${b5.id}/restore`, {});
    assert.strictEqual(res.status, 200, 'geri alma da serbest kalmalı: ' + JSON.stringify(res));
    await api('POST', `/api/finance/transactions/${b2.id}/restore`, {});
  });

  await step('yeniden açma denetim kaydı yazıyor ve kapanış geçmişi silinmiyor', async () => {
    const a = await db.one(
      "SELECT * FROM audit_logs WHERE client_id=? AND action='day.reopen' AND entity_id=? ORDER BY id DESC LIMIT 1",
      [CID, D2]);
    assert.ok(a, 'day.reopen denetim kaydı yok');
    // mysql2 hands these columns back already parsed on MariaDB
    const before = typeof a.before_json === 'string' ? JSON.parse(a.before_json || '{}') : (a.before_json || {});
    assert.ok(Number(before.sales) > 0, 'denetim kaydı kapanış rakamlarını taşımalı');
    const row = await db.one('SELECT * FROM daily_closings WHERE id=?', [closing.id]);
    assert.ok(row, 'PHP kapanış satırını siliyordu; kim kapattı bilgisi kaybolmamalı');
    assert.strictEqual(Number(row.is_reopened), 1);
    assert.ok(row.reopened_at, 'yeniden açılma zamanı yazılmalı');
    assert.strictEqual(Number(row.expected_sales), Number(closing.expected_sales),
      'yeniden açma kapanış rakamlarını da silmemeli');
  });

  await step('yeniden açılan gün tekrar kapatılabiliyor ve sıra numarası ilerliyor', async () => {
    const r = await api('POST', `/api/finance/days/${D2}/close`, { declared_cash: 0, declared_card: 0 });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.closing.close_seq, 2, 'ikinci kapanış close_seq=2 olmalı');
    const list = await api('GET', `/api/finance/days?from=${D2}&to=${D2}`);
    assert.strictEqual(list.rows[0].is_closed, true);
    // and unlock again so the report checks below are not fighting the checkpoint
    await api('POST', `/api/finance/days/${D2}/reopen`, {});
  });

  /* ===================== H. day list / detail ====================== */
  await step('gün listesi her günü rakamlarıyla ve durumuyla veriyor', async () => {
    const r = await api('GET', `/api/finance/days?from=${D1}&to=${TODAY}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const d2 = r.rows.find(x => x.date === D2);
    assert.ok(d2, 'D2 listede yok');
    assert.strictEqual(d2.weekday.length > 0, true, 'Türkçe gün adı bekleniyordu');
    assert.strictEqual(d2.expenses, 250, 'günün gideri gün satırına girmeli');
    assert.strictEqual(d2.total_cost, Math.round((d2.cogs + d2.expenses) * 100) / 100);
    assert.strictEqual(r.totals.days, r.rows.length);
    const sum = Math.round(r.rows.reduce((s, x) => s + x.net_sales, 0) * 100) / 100;
    assert.strictEqual(sum, r.totals.net_sales, 'TOPLAM satırı günlerin toplamı olmalı');
  });

  await step('sadece kapatılan günler filtresi çalışıyor', async () => {
    await api('POST', `/api/finance/days/${D1}/close`, {});
    const r = await api('GET', `/api/finance/days?from=${D1}&to=${TODAY}&only_closed=1`);
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0].date, D1);
    await api('POST', `/api/finance/days/${D1}/reopen`, {});
  });

  await step('gün detayı adisyon, ürün, garson, gider ve iptalleri veriyor', async () => {
    const r = await api('GET', `/api/finance/days/${D2}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.date, D2);
    assert.ok(r.orders.length >= 2, 'günün adisyonları listelenmeli');
    assert.ok(r.products.length >= 1, 'ürün kırılımı boş');
    assert.ok(r.waiters.length >= 1, 'garson performansı boş');
    assert.strictEqual(r.costs_total, 250);
    assert.ok(r.prev < r.date && r.next > r.date, 'önceki/sonraki gün gezinmesi');
    assert.ok(Array.isArray(r.payments), 'ödeme dağılımı');
  });

  /* ===================== I. finance report ========================= */
  await step('finans raporu KPI, alım, ödeme ve kâr panellerini tek çağrıda veriyor', async () => {
    const r = await api('GET', `/api/finance/report?from=${D1}&to=${TODAY}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const pnl = require('../src/modules/pnl');
    const T = (await pnl.profitAndLoss(CID, D1, TODAY)).totals;
    assert.strictEqual(r.totals.revenue_gross, T.revenue_gross, 'rapor pnl ile aynı ciroyu vermeli');
    assert.strictEqual(r.totals.net_profit, T.net_profit, 'kâr tek motordan gelmeli');
    assert.ok(r.kpi && typeof r.kpi.last30_sales === 'number');
    assert.ok(r.purchases && typeof r.purchases.total === 'number');
    assert.ok(r.products.length && r.categories.length, 'ürün ve kategori tabloları');
    assert.ok(r.payments.length, 'ödeme dağılımı boş');
    const share = Math.round(r.payments.reduce((s, p) => s + p.share, 0));
    assert.ok(Math.abs(share - 100) <= 1, 'ödeme payları %100 etmeli, eden: ' + share);
    const paid = Math.round(r.payments.reduce((s, p) => s + p.total, 0) * 100) / 100;
    assert.strictEqual(paid, r.payments_total);
  });

  await step('indirim raporu indirimli adisyonları ve kim yaptığını veriyor', async () => {
    await db.exec('UPDATE orders SET discount_total=50, grand_total=grand_total-50 WHERE id=?', [b1.id]);
    const r = await api('GET', `/api/finance/discounts?from=${D1}&to=${TODAY}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.rows.some(x => x.id === b1.id), 'indirimli adisyon listede yok');
    assert.strictEqual(r.total, 50);
    assert.ok(r.by_waiter.length >= 1, 'personel kırılımı');
  });

  await step('iptal raporu iptalleri, silinenleri ve iptal ürünleri ayrı gösteriyor', async () => {
    await api('POST', `/api/finance/transactions/${b6.id}/delete`, {});
    const r = await api('GET', `/api/finance/cancellations?from=${D1}&to=${TODAY}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.orders.some(x => x.id === b6.id), 'rapor dışı bırakılan adisyon görünmeli');
    assert.ok(r.deleted.some(x => x.order_id === b6.id), 'silme kütüğünden de okunmalı');
    assert.ok(r.orders_total > 0);
  });

  /* ===================== J. X raporu =============================== */
  await step('X raporu masadaki açık adisyonları da gösteriyor ve günü kapatmıyor', async () => {
    const o = await api('POST', '/api/pos/orders', { table_id: TABLE });
    await api('POST', `/api/pos/orders/${o.order_id}/items`, { product_id: P.kebap, qty: 1 });
    const r = await api('GET', `/api/finance/x-report?date=${TODAY}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.report.kind, 'X');
    assert.ok(r.report.open_bills.some(b => b.id === o.order_id), 'açık adisyon X raporunda olmalı');
    assert.ok(r.report.open_total > 0, 'masadaki tutar');
    assert.strictEqual(r.report.day_closed, false);
    const n = Number(await db.value('SELECT COUNT(*) FROM daily_closings WHERE client_id=? AND date=?', [CID, TODAY]));
    assert.strictEqual(n, 0, 'X raporu günü kapatmamalı');
    await db.exec('UPDATE orders SET status=?, is_deleted=1 WHERE id=?', ['cancelled', o.order_id]);
  });

  /* ===================== K. gün sonu e-postası ===================== */
  await step('gün sonu özeti e-posta kuyruğuna giriyor', async () => {
    const r = await api('POST', `/api/finance/days/${D2}/mail`, { to: 'sahip@ornek.com' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const row = await db.one('SELECT * FROM np_mail_queue WHERE client_id=? ORDER BY id DESC LIMIT 1', [CID]);
    assert.ok(row, 'kuyruk satırı yok');
    assert.strictEqual(row.to_email, 'sahip@ornek.com');
    assert.ok(row.subject.includes(D2), 'konuda tarih olmalı: ' + row.subject);
    assert.ok(/Net kâr/.test(row.body_html), 'özet gövdesi eksik');
    const bad = await api('POST', `/api/finance/days/${D2}/mail`, { to: 'yanlis' });
    assert.strictEqual(bad.status, 400, 'geçersiz adres reddedilmeli');
  });

  /* ===================== L. exports ================================ */
  await step('her tablo CSV olarak iniyor ve ekrandaki satırları taşıyor', async () => {
    const q = `from=${D1}&to=${TODAY}&token=${encodeURIComponent(OWNER)}`;
    const kinds = ['transactions', 'days', 'products', 'categories', 'payments',
      'discounts', 'cancellations', 'daily', 'report'];
    for (const k of kinds) {
      const res = await raw(`/api/finance/export/${k}?${q}`);
      assert.strictEqual(res.status, 200, k + ' -> ' + res.status);
      assert.ok(String(res.headers.get('content-disposition')).includes('attachment'), k + ': indirme başlığı yok');
      const text = res.buf.toString('utf8');
      assert.ok(text.startsWith('﻿'), k + ': BOM yok, Excel Türkçeyi bozar');
      assert.ok(text.includes(';'), k + ': noktalı virgül yok');
      assert.ok(text.trim().split('\r\n').length >= 2, k + ': sadece başlık geldi');
    }
    // and the rows really are the rows on screen
    const screen = await api('GET', `/api/finance/transactions?from=${D1}&to=${TODAY}`);
    const csv = (await raw(`/api/finance/export/transactions?${q}`)).buf.toString('utf8');
    const lines = csv.trim().split('\r\n').filter(Boolean);
    assert.strictEqual(lines.length - 1, screen.rows.length,
      'CSV satır sayısı ekrandakiyle aynı olmalı: ' + (lines.length - 1) + ' / ' + screen.rows.length);
    const one = screen.rows[0];
    assert.ok(csv.includes(one.grand_total.toFixed(2).replace('.', ',')),
      'ekrandaki tutar CSV içinde yok');
  });

  await step('gün detayı CSV olarak iniyor', async () => {
    const res = await raw(`/api/finance/export/day?date=${D2}&token=${encodeURIComponent(OWNER)}`);
    assert.strictEqual(res.status, 200);
    const text = res.buf.toString('utf8');
    assert.ok(text.includes('Adisyonlar') && text.includes('Ürünler') && text.includes('Giderler'),
      'gün CSV üç bölümü de taşımalı');
    assert.ok(text.includes('250,00'), 'günün gideri CSV içinde yok');
  });

  await step('finans raporu XLSX olarak iniyor ve altı sayfa taşıyor', async () => {
    const res = await raw(`/api/finance/export/report?from=${D1}&to=${TODAY}&format=xlsx&token=${encodeURIComponent(OWNER)}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.buf.slice(0, 2).toString(), 'PK', 'zip değil, yani xlsx değil');
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buf);
    const names = wb.worksheets.map(w => w.name);
    for (const n of ['Özet', 'Günlük', 'Ürünler', 'Kategoriler', 'Ödemeler', 'İndirimler']) {
      assert.ok(names.includes(n), 'eksik sayfa: ' + n + ' (gelen: ' + names.join(', ') + ')');
    }
    const products = wb.getWorksheet('Ürünler');
    assert.ok(products.rowCount > 1, 'ürün sayfası boş');
    const screen = await api('GET', `/api/finance/report?from=${D1}&to=${TODAY}`);
    assert.strictEqual(products.rowCount - 1, screen.products.length,
      'xlsx ürün satırları ekrandakiyle aynı olmalı');
  });

  await step('işlemler XLSX olarak da iniyor', async () => {
    const res = await raw(`/api/finance/export/transactions?from=${D1}&to=${TODAY}&format=xlsx&token=${encodeURIComponent(OWNER)}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.buf.slice(0, 2).toString(), 'PK');
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buf);
    const ws = wb.getWorksheet('İşlemler');
    const screen = await api('GET', `/api/finance/transactions?from=${D1}&to=${TODAY}`);
    assert.strictEqual(ws.rowCount - 1, screen.rows.length);
  });

  await step('bilinmeyen rapor 404 dönüyor', async () => {
    const res = await raw(`/api/finance/export/olmayan?token=${encodeURIComponent(OWNER)}`);
    assert.strictEqual(res.status, 404);
  });

  /* ===================== M. context ================================= */
  await step('ekran açılışında sahiplik ve checkpoint bilgisi geliyor', async () => {
    const o = await api('GET', '/api/finance/context');
    assert.strictEqual(o.is_owner, true);
    const s = await api('GET', '/api/finance/context', null, STAFF);
    assert.strictEqual(s.is_owner, false, 'personel sahip görünmemeli');
  });


  /* ===================== N. the screen itself ====================== */
  await step('finans raporu ekranı canlı veriyle çiziliyor', async () => {
    const { Screens, el } = mountScreens();
    Screens._finFrom = D1; Screens._finTo = TODAY;
    await Screens.page_finans();
    const html = el('#fnBody').innerHTML;
    assert.ok(html.length > 500, 'gövde çizilmedi');
    for (const t of ['Dönem özeti', 'Alımlar', 'Ödeme yöntemleri', 'Ürün satışları',
      'İndirimler', 'İptaller ve silinenler', 'Günlük kırılım']) {
      assert.ok(html.includes(t), 'panel eksik: ' + t);
    }
    assert.ok(!/undefined|NaN/.test(html), 'ekranda undefined/NaN var');
    const rep = await api('GET', `/api/finance/report?from=${D1}&to=${TODAY}`);
    assert.ok(html.includes(tlTest(rep.totals.revenue_gross)), 'ciro ekranda görünmüyor');
  });

  await step('gün sonu listesi ve gün detayı ekranı çiziliyor', async () => {
    const { Screens, el } = mountScreens();
    Screens._daysFrom = D1; Screens._daysTo = TODAY;
    await Screens.page_gunsonu();
    const list = el('#dyBody').innerHTML;
    assert.ok(list.includes('TOPLAM'), 'TOPLAM satırı yok');
    assert.ok(list.includes(D2), 'gün listede yok');
    assert.ok(!/undefined|NaN/.test(list), 'gün listesinde undefined/NaN var');
    await Screens.finDayDetail(D2);
    const detail = el('#ddBody').innerHTML;
    for (const t of ['Adisyonlar', 'Ürün kırılımı', 'Garson performansı', 'Gün giderleri',
      'İptal edilen ürünler']) {
      assert.ok(detail.includes(t), 'gün detayında eksik panel: ' + t);
    }
    assert.ok(!/undefined|NaN/.test(detail), 'gün detayında undefined/NaN var');
  });

  await step('işlemler ekranı ve adisyon detay modalı çiziliyor', async () => {
    const { Screens, el, captured } = mountScreens();
    Screens._txFrom = D1; Screens._txTo = TODAY;
    await Screens.page_islemler();
    const html = el('#txBody').innerHTML;
    assert.ok(html.includes('Kapanış') && html.includes('Tahsilat'), 'tablo başlıkları yok');
    assert.ok(html.includes('Kilitli') || html.includes('Geçerli'), 'durum rozetleri yok');
    assert.ok(!/undefined|NaN/.test(html), 'işlemler ekranında undefined/NaN var');
    await Screens.finOrderModal(b4.id);
    assert.ok(captured.modal.includes('Adisyon detayı'));
    const body = el('#odBody').innerHTML;
    assert.ok(body.includes('Ara toplam') && body.includes('Genel toplam'), 'toplamlar yok');
    assert.ok(body.includes('Ödemeler'), 'ödeme bölümü yok');
    assert.ok(!/undefined|NaN/.test(body), 'adisyon detayında undefined/NaN var');
  });

  await step('X raporu ekranı açık adisyonları gösteriyor', async () => {
    const { Screens, el } = mountScreens();
    await Screens.finXReport();
    const html = el('#xrBody').innerHTML;
    assert.ok(html.includes('Masadaki açık adisyonlar'), 'açık adisyon bölümü yok');
    assert.ok(!/undefined|NaN/.test(html), 'X raporunda undefined/NaN var');
  });

  /* ================================= results ============================ */
  /* =================================================================
     KALICI SILME - the bill stops existing
     =================================================================

     `deleteOne` CANCELS: off the books, record kept, reversible. This is the
     other act - the sale is struck out of the system. Owner only, reason
     mandatory, never inside a closed day, and what survives is the delete log,
     because a set of books that cannot show a sale was removed is not a set of
     books. */

  await step('kalıcı silme yalnızca işletme sahibine açık', async () => {
    const b = await bill(TODAY, 'nakit', [[P.kebap, 1]]);
    const manager = await auth.issueToken({ cid: CID, uid: UID, role: 'admin', name: 'Mudur', kind: 'staff' });
    const r = await api('POST', '/api/finance/transactions/purge',
      { ids: [b.id], reason: 'deneme' }, manager);
    assert.strictEqual(r.status, 403, 'a manager permanently deleted a bill');
    assert.ok(await db.one('SELECT id FROM orders WHERE id=?', [b.id]), 'the bill went anyway');
  });

  await step('sebep yazılmadan kalıcı silinemez', async () => {
    const b = await bill(TODAY, 'nakit', [[P.kebap, 1]]);
    const r = await api('POST', '/api/finance/transactions/purge', { ids: [b.id] });
    assert.strictEqual(r.status, 400, 'a bill was purged with no reason');
    assert.ok(await db.one('SELECT id FROM orders WHERE id=?', [b.id]));
  });

  await step('kalıcı silinen adisyon ve bütün satırları gerçekten gider', async () => {
    const b = await bill(TODAY, 'nakit', [[P.kebap, 2], [P.pide, 1]]);
    assert.ok(Number(await db.value('SELECT COUNT(*) FROM order_items WHERE order_id=?', [b.id])) > 0);
    const r = await api('POST', '/api/finance/transactions/purge',
      { ids: [b.id], reason: 'test adisyonu' });
    assert.strictEqual(r.purged, 1, r.error);
    assert.strictEqual(await db.one('SELECT id FROM orders WHERE id=?', [b.id]), null,
      'the order row survived');
    for (const t of ['order_items', 'order_payments', 'order_discounts', 'station_projection_items']) {
      assert.strictEqual(Number(await db.value(`SELECT COUNT(*) FROM ${t} WHERE order_id=?`, [b.id])), 0,
        t + ' left orphan rows behind');
    }
  });

  await step('kalıcı silinen adisyonun izi işlem günlüğünde kalır', async () => {
    const b = await bill(TODAY, 'nakit', [[P.kebap, 1]]);
    await api('POST', '/api/finance/transactions/purge', { ids: [b.id], reason: 'yanlis giris' });
    const log = await db.one(
      'SELECT reason, grand_total, original_data FROM order_delete_logs WHERE order_id=? ORDER BY id DESC LIMIT 1',
      [b.id]);
    assert.ok(log, 'nothing was written to order_delete_logs');
    assert.ok(/yanlis giris/.test(log.reason), 'the reason was not kept: ' + log.reason);
    const snap = typeof log.original_data === 'string' ? JSON.parse(log.original_data) : log.original_data;
    assert.ok(snap.order && snap.items && snap.items.length, 'the snapshot kept no lines');
    const row = await db.one(
      "SELECT action FROM audit_logs WHERE entity_type='order' AND entity_id=? AND action='order.purge'",
      [String(b.id)]);
    assert.ok(row, 'no audit row for the purge');
  });

  await step('kalıcı silinen adisyon hiçbir rakama girmez', async () => {
    const b = await bill(TODAY, 'nakit', [[P.kebap, 1]]);
    const finance = require('../src/modules/finance');
    const before = await finance.transactions(CID, { from: TODAY, to: TODAY });
    await api('POST', '/api/finance/transactions/purge', { ids: [b.id], reason: 'temizlik' });
    const after = await finance.transactions(CID, { from: TODAY, to: TODAY });
    assert.strictEqual(after.totals.count, before.totals.count - 1, 'the row is still listed');
    assert.ok(after.rows.every(r => r.id !== b.id), 'the purged bill is still in the list');
    assert.ok(Math.abs(after.totals.paid - (before.totals.paid - b.total)) < 0.01,
      'the purged bill is still in the takings');
  });

  await step('kapanmış güne ait adisyon kalıcı silinemez', async () => {
    /*
     * A bill a signed Z report counted cannot be made never to have happened.
     * The day is reopened first, deliberately, and that reopening is itself on
     * the record.
     */
    const b = await bill(D3, 'nakit', [[P.kebap, 1]]);
    // this suite reopens days as it goes, so the checkpoint is set explicitly
    // here rather than inherited from whichever test ran last
    await db.exec(
      `INSERT INTO daily_closings (client_id, date, closed_at, close_seq)
       VALUES (?, ?, CONCAT(?, ' 23:30:00'), 990)`, [CID, D3, D3]);
    const r = await api('POST', '/api/finance/transactions/purge', { ids: [b.id], reason: 'olmaz' });
    assert.strictEqual(r.locked, 1, 'a bill inside a closed day was purged: ' + JSON.stringify(r));
    assert.ok(await db.one('SELECT id FROM orders WHERE id=?', [b.id]), 'the frozen bill went anyway');
    await db.exec('DELETE FROM daily_closings WHERE client_id=? AND close_seq=990', [CID]);
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
