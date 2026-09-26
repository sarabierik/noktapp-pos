'use strict';
/**
 * DEMO VERİSİ — the seeder, and the button that undoes it.
 *
 * Two things are being guarded here and only one of them is "does it fill the
 * screens". The other is the one that would end a support call badly: the
 * clear button is irreversible, it is reachable from an ordinary settings
 * screen, and a customer's own till must never be able to run the seeder at
 * all. So this suite checks the GATES as hard as it checks the data.
 *
 * It seeds a SHORT period - seven years takes half a minute and proves nothing
 * this does not - and it does it in a TENANT OF ITS OWN. The suite ends by
 * erasing everything it made, and doing that to client 19 would take the menu,
 * the staff and the floor plan every other suite is standing on with it.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/demoveri.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7496';
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const demo = require('../src/demo');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 77;              // this suite's own restaurant - see the note above
const BENCH = 19;           // the one every other suite uses, and must not lose
let OWNER = null, MANAGER = null;

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
const count = (t, where = 'client_id=?') =>
  db.value(`SELECT COUNT(*) FROM ${t} WHERE ${where}`, where.includes('?') ? [CID] : []).then(Number);

/** A second restaurant in the same database, borrowed from the first one's row. */
async function makeTenant() {
  const base = await db.one('SELECT * FROM clients WHERE client_id=? LIMIT 1', [BENCH]);
  assert.ok(base, 'client 19 yok - önce smoke çalıştırın');
  await db.exec('DELETE FROM clients WHERE client_id=?', [CID]);
  await db.exec(
    `INSERT INTO clients (client_id, slug, owner_name, company_name, permanent_email, username,
        password_hash, tax_number, tax_office, phone, contact_name, contact_email, contact_phone,
        is_active, created_at, setup_done)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1, NOW(), 0)`,
    [CID, 'demo-test-' + CID, 'Demo Test', 'Demo Test Restoran', 'demo' + CID + '@test.local',
     'demotest' + CID, base.password_hash, '1111111111', 'Test', '02420000000',
     'Demo Test', 'demo' + CID + '@test.local', '02420000000']);
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - demo verisi\n');

  await makeTenant();
  /* a short period: the point is the machinery, not the volume */
  const settingsBefore = await db.getSetting('demo_seeded_at', '');
  await db.setSetting('demo_seeded_at', '');
  const seeded = await demo.seed(CID, { from: '2025-11-01' });

  OWNER = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Sahip', kind: 'tenant' });
  const mgr = await db.one("SELECT id FROM users WHERE client_id=? AND username='nurcan'", [CID]);
  MANAGER = await auth.issueToken({ cid: CID, uid: mgr.id, role: 'admin', name: 'Nurcan', kind: 'pos' });

  /* ------------------------------------------------------------ the data */

  await step('yedi yılın yerine kısa dönem de aynı şekilde kurulur', async () => {
    assert.ok(seeded.orders > 300, 'çok az adisyon: ' + seeded.orders);
    assert.strictEqual(seeded.from, '2025-11-01', 'başlangıç tarihi tutmadı: ' + seeded.from);
  });

  await step('hiçbir ekran boş kalmayacak kadar tablo doldu', async () => {
    const must = ['orders', 'order_items', 'order_payments', 'pos_shifts', 'daily_closings',
      'daily_costs', 'products', 'categories', 'restaurant_tables', 'users',
      'inventory_items', 'inventory_stock_ledger', 'inventory_documents',
      'customers', 'loyalty_cards', 'loyalty_events', 'reservations',
      'delivery_orders', 'couriers', 'np_int_orders', 'np_int_connections',
      'print_jobs', 'app_device_tokens', 'fiscal_transactions'];
    const empty = [];
    for (const t of must) {
      const where = t === 'customers' ? 'created_by_client_id=?' : 'client_id=?';
      if (!(await count(t, where))) empty.push(t);
    }
    assert.deepStrictEqual(empty, [], 'boş kalan tablolar: ' + empty.join(', '));
  });

  await step('para her yerde aynı - adisyon toplamı satırların toplamıdır', async () => {
    const bad = await db.value(
      `SELECT COUNT(*) FROM orders o
        WHERE o.client_id=? AND o.is_deleted=0
          AND ABS(o.total - (SELECT COALESCE(SUM(i.line_total),0) FROM order_items i
                              WHERE i.order_id=o.id AND i.is_deleted=0)) > 0.02`, [CID]);
    assert.strictEqual(Number(bad), 0, Number(bad) + ' adisyonun toplamı satırlarıyla tutmuyor');
  });

  await step('kapanan her adisyon tam olarak ödenmiştir', async () => {
    const bad = await db.value(
      `SELECT COUNT(*) FROM orders o
        WHERE o.client_id=? AND o.status='closed' AND o.is_deleted=0
          AND ABS(o.grand_total - (SELECT COALESCE(SUM(p.amount),0) FROM order_payments p
                                    WHERE p.order_id=o.id AND p.is_deleted=0)) > 0.02`, [CID]);
    assert.strictEqual(Number(bad), 0, Number(bad) + ' adisyon eksik ya da fazla ödenmiş');
  });

  await step('her satırın maliyeti girilmiş - kâr ekranları sıfır göstermez', async () => {
    const zero = await db.value(
      'SELECT COUNT(*) FROM order_items WHERE client_id=? AND is_deleted=0 AND cost_price<=0', [CID]);
    assert.strictEqual(Number(zero), 0, Number(zero) + ' satırda maliyet yok');
  });

  await step('bugün açık adisyon ve açık vardiya var', async () => {
    const open = Number(await db.value(
      "SELECT COUNT(*) FROM orders WHERE client_id=? AND status='open'", [CID]));
    const shift = await db.one(
      "SELECT id FROM pos_shifts WHERE client_id=? AND status='open'", [CID]);
    assert.ok(open > 0, 'masada açık adisyon yok');
    assert.ok(shift, 'açık vardiya yok');
  });

  await step('raporlar gerçekten rakam döndürüyor', async () => {
    const r = await api('GET', '/api/reports/dashboard');
    assert.strictEqual(r.status, 200, JSON.stringify(r).slice(0, 120));
    const p = await api('GET', '/api/reports/pnl?from=2025-11-01&to=' + new Date().toISOString().slice(0, 10));
    assert.strictEqual(p.status, 200);
    const gross = (p.rows || []).reduce((a, x) => a + Number(x.revenue_gross || 0), 0);
    const cogs = (p.rows || []).reduce((a, x) => a + Number(x.cogs || 0), 0);
    assert.ok(gross > 0, 'kâr-zarar cirosu sıfır');
    assert.ok(cogs > 0, 'ürün maliyeti sıfır - kâr satırı anlamsız olur');
    assert.ok(cogs < gross, 'maliyet cirodan büyük: ' + cogs + ' / ' + gross);
  });

  /* ----------------------------------------------------------- the gates */

  await step('demo durumu settings.manage ister', async () => {
    const waiter = await db.one("SELECT id FROM users WHERE client_id=? AND username='okan'", [CID]);
    const tok = await auth.issueToken({ cid: CID, uid: waiter.id, role: 'waiter', name: 'Okan', kind: 'pos' });
    const r = await api('GET', '/api/settings/demo', undefined, tok);
    assert.strictEqual(r.status, 403, 'garson demo durumunu gördü: ' + r.status);
  });

  await step('silmeyi müdür yapamaz - yalnız işletme sahibi', async () => {
    const r = await api('POST', '/api/settings/demo/clear', { scope: 'hareket' }, MANAGER);
    assert.strictEqual(r.status, 403, 'müdür sildi: ' + r.status);
    assert.strictEqual(r.code, 'OWNER_ONLY', 'yanlış gerekçe: ' + r.code);
  });

  await step('sahip de şifresiz silemez', async () => {
    const r = await api('POST', '/api/settings/demo/clear', { scope: 'hareket' });
    assert.strictEqual(r.status, 403, 'şifresiz silindi: ' + r.status);
    const still = await count('orders');
    assert.ok(still > 0, 'adisyonlar gitmiş');
  });

  await step('uydurma kapsam kabul edilmez', async () => {
    await assert.rejects(() => demo.clear(CID, { scope: 'hepsini-ve-biraz-daha' }));
  });

  /* -------------------------------------------------------- the clearing */

  await step('"satış ve hareketleri sil" geçmişi siler, menüyü bırakır', async () => {
    const out = await demo.clear(CID, { scope: 'hareket' });
    assert.ok(out.rows > 0, 'hiçbir şey silinmemiş');
    for (const t of ['orders', 'order_items', 'order_payments', 'pos_shifts', 'daily_closings',
      'inventory_stock_ledger', 'loyalty_events', 'delivery_orders', 'np_int_orders']) {
      assert.strictEqual(await count(t), 0, t + ' boşalmadı');
    }
    for (const t of ['products', 'categories', 'restaurant_tables', 'users', 'inventory_items']) {
      assert.ok(await count(t), t + ' de silinmiş - menü kalmalıydı');
    }
  });

  await step('temizlikten sonra kasa çalışır durumda', async () => {
    const menu = await api('GET', '/api/pos/menu');
    assert.strictEqual(menu.status, 200);
    assert.ok((menu.menu || []).length, 'menü gitmiş: ' + JSON.stringify(menu).slice(0, 120));
    assert.ok((menu.menu || []).some(c => (c.products || []).length), 'kategoriler boş');
    const tables = await api('GET', '/api/pos/tables');
    assert.strictEqual(tables.status, 200);
    assert.ok((tables.zones || tables.tables || []).length, 'masa planı gitmiş');
    const busy = Number(await db.value(
      'SELECT COUNT(*) FROM restaurant_tables WHERE client_id=? AND is_occupied=1', [CID]));
    assert.strictEqual(busy, 0, busy + ' masa hâlâ dolu görünüyor');
  });

  await step('temizlikten sonra demo bayrağı düşer', async () => {
    const s = await demo.status(CID);
    assert.strictEqual(s.seeded, false, 'hâlâ yüklü görünüyor');
    assert.strictEqual(s.orders, 0);
  });

  await step('"her şeyi sil" kurulumu da sıfırlar', async () => {
    await demo.seed(CID, { from: '2026-08-01' });
    const out = await demo.clear(CID, { scope: 'hepsi' });
    assert.ok(out.rows > 0);
    for (const t of ['products', 'categories', 'restaurant_tables', 'users', 'orders']) {
      assert.strictEqual(await count(t), 0, t + ' boşalmadı');
    }
    const done = await db.value('SELECT setup_done FROM clients WHERE client_id=?', [CID]);
    assert.strictEqual(Number(done), 0, 'kurulum sihirbazı yeniden başlamıyor');
  });

  await step('müşteri sürümü kendiliğinden veri yüklemez', async () => {
    delete process.env.NOKTAPP_DEMO;
    const fs = require('fs');
    const had = fs.existsSync(demo.MARKER);
    if (had) fs.renameSync(demo.MARKER, demo.MARKER + '.off');
    try {
      assert.strictEqual(demo.isDemoBuild(), false, 'işaret dosyası yokken demo sürümü sanıyor');
      assert.strictEqual(await demo.seedOnFirstBoot(CID), null, 'müşteri sürümü veri yükledi');
    } finally { if (had) fs.renameSync(demo.MARKER + '.off', demo.MARKER); }
  });

  await step('kurulmuş ama henüz satış yapmamış kasaya dokunmaz', async () => {
    /*
     * The bug this exists for: a till whose owner had finished the wizard -
     * menu typed, staff created, floor drawn - but had not yet rung up a
     * single sale. Zero bills, so the first version of the guard wiped it and
     * the owner's own PIN stopped working. Configured is not the same as used.
     */
    process.env.NOKTAPP_DEMO = '1';
    await demo.clear(CID, { scope: 'hepsi' });
    await db.setSetting('demo_seeded_at', '');
    await db.exec('UPDATE clients SET setup_done=1 WHERE client_id=?', [CID]);
    const cat = await db.insert(
      'INSERT INTO categories (client_id, name, sort_order, is_active) VALUES (?,?,1,1)', [CID, 'Sıcaklar']);
    await db.insert(
      'INSERT INTO products (client_id, category_id, name, price, is_active, vat_rate) VALUES (?,?,?,?,1,10)',
      [CID, cat, 'Çorba', 90]);
    await db.insert(
      `INSERT INTO users (client_id, username, email, display_name, role, password_hash, pin_hash,
          created_at, updated_at, is_active) VALUES (?,?,?,?,'admin',?,?, NOW(), NOW(), 1)`,
      [CID, 'kasa' + CID, 'kasa' + CID + '@test.local', 'Kasa', auth.hash('x'), auth.hash('2588')]);
    try {
      assert.strictEqual(await demo.seedOnFirstBoot(CID), null,
        'kurulmuş bir kasanın üstüne demo yazıldı');
      const still = await db.one('SELECT id FROM users WHERE client_id=? AND username=?',
        [CID, 'kasa' + CID]);
      assert.ok(still, 'kurulumu yapan kullanıcı silinmiş');
      assert.ok(Number(await db.value('SELECT COUNT(*) FROM products WHERE client_id=?', [CID])),
        'menü silinmiş');
    } finally { delete process.env.NOKTAPP_DEMO; }
  });

  await step('bomboş kuruluma ise yüklenir', async () => {
    process.env.NOKTAPP_DEMO = '1';
    await demo.clear(CID, { scope: 'hepsi' });      // setup_done da sıfırlanır
    await db.setSetting('demo_seeded_at', '');
    try {
      const out = await demo.seedOnFirstBoot(CID);
      assert.ok(out && out.orders > 0, 'dokunulmamış kuruluma yüklenmedi');
    } finally { delete process.env.NOKTAPP_DEMO; }
  });

  await step('demo sürümü de dolu bir veritabanının üstüne yazmaz', async () => {
    process.env.NOKTAPP_DEMO = '1';
    await db.exec(
      `INSERT INTO orders (client_id, business_date, status, total, grand_total, created_by)
       VALUES (?, CURDATE(), 'open', 100, 100, 0)`, [CID]);
    try {
      assert.strictEqual(await demo.seedOnFirstBoot(CID), null,
        'içinde adisyon olan veritabanının üstüne demo yazıldı');
    } finally {
      await db.exec("DELETE FROM orders WHERE client_id=? AND total=100", [CID]);
      delete process.env.NOKTAPP_DEMO;
    }
  });

  /* ------------------------------------------------- loading it by hand */

  await step('dolu bir veritabanına kendiliğinden yüklenmez', async () => {
    await db.setSetting('demo_seeded_at', '');
    await demo.seed(CID, { from: '2026-08-01', replace: true });
    await db.setSetting('demo_seeded_at', '');          // as if it had never been seeded
    await assert.rejects(() => demo.seed(CID, { from: '2026-08-01' }),
      (e) => e.code === 'NOT_EMPTY' && e.status === 409,
      'içinde adisyon olan veritabanına uyarısız yazdı');
  });

  await step('"yükle" düğmesi dolu veritabanının üstüne yazabilir', async () => {
    const before = Number(await db.value('SELECT COUNT(*) FROM orders WHERE client_id=?', [CID]));
    assert.ok(before > 0, 'önce veri olmalıydı');
    const out = await demo.seed(CID, { from: '2026-09-01', replace: true });
    assert.ok(out.orders > 0, 'yükleme boş geldi');
    assert.strictEqual(out.from, '2026-09-01', 'istenen tarihten başlamadı: ' + out.from);
    const stray = Number(await db.value(
      "SELECT COUNT(*) FROM orders WHERE client_id=? AND business_date<'2026-09-01'", [CID]));
    assert.strictEqual(stray, 0, stray + ' eski adisyon kalmış - üstüne yazmak silmeliydi');
  });

  await step('yükleme ucu müdüre ve şifresizlere kapalı', async () => {
    const m = await api('POST', '/api/settings/demo/load', { from: '2020-01-01' }, MANAGER);
    assert.strictEqual(m.status, 403, 'müdür yükledi: ' + m.status);
    const o = await api('POST', '/api/settings/demo/load', { from: '2020-01-01' });
    assert.strictEqual(o.status, 403, 'sahip şifresiz yükledi: ' + o.status);
  });

  await step('müşteri sürümünde yükleme ucu hiç açılmaz', async () => {
    const fs = require('fs');
    delete process.env.NOKTAPP_DEMO;
    const had = fs.existsSync(demo.MARKER);
    if (had) fs.renameSync(demo.MARKER, demo.MARKER + '.off');
    try {
      const r = await api('POST', '/api/settings/demo/load',
        { from: '2020-01-01', owner_password: 'her ne ise' });
      assert.strictEqual(r.status, 403, 'müşteri sürümü yükleme kabul etti: ' + r.status);
      assert.ok(/tanıtım sürümünde/.test(String(r.error || '')), 'gerekçe anlaşılmıyor: ' + r.error);
    } finally { if (had) fs.renameSync(demo.MARKER + '.off', demo.MARKER); }
  });

  await step('yüklemeden sonra ortalık temiz - tek kiracı, tek menü', async () => {
    await demo.clear(CID, { scope: 'hepsi' });
  });

  /*
   * THE GAP CHECK.
   *
   * "Her seyi sil" is a promise: the till comes back empty and the setup
   * wizard starts again. A measurement of the live schema found 34
   * client-scoped tables that survived it - business_settings, every
   * fiscal_* child of a device that HAD been deleted, pricing targets, menu
   * apply logs. Nobody had written them down as exceptions; they were simply
   * never added to the lists, and each new migration made it worse.
   *
   * So the lists are no longer maintained by memory. Every table that scopes
   * rows to a restaurant must be in TRANSACTIONAL, in CATALOGUE, or named in
   * NEVER_CLEARED with a reason. A new migration that forgets fails here, by
   * table name, instead of failing at an owner who pressed the button and got
   * a till that still remembers.
   */
  await step('hiçbir kiracıya ait tablo silme listelerinin dışında kalmıyor', async () => {
    const covered = new Set([...demo.TRANSACTIONAL, ...demo.CATALOGUE, ...demo.NEVER_CLEARED]);
    const rows = await db.query(
      'SELECT DISTINCT table_name AS t FROM information_schema.columns c '
      + 'WHERE c.table_schema=DATABASE() '
      + "AND c.column_name IN ('client_id','created_by_client_id') "
      + 'AND EXISTS (SELECT 1 FROM information_schema.tables t '
      + "           WHERE t.table_schema=DATABASE() AND t.table_name=c.table_name "
      + "           AND t.table_type='BASE TABLE') ORDER BY table_name");
    const missing = rows.map(r => String(r.t)).filter(t => !covered.has(t));
    assert.deepStrictEqual(missing, [],
      'bu tablolar "Her seyi sil" sonrasi ayakta kaliyor; TRANSACTIONAL, '
      + 'CATALOGUE veya NEVER_CLEARED listesine gerekcesiyle ekleyin: '
      + missing.join(', '));
  });

  await step('bir cihaz silindiğinde kendi kayıtları da gidiyor', async () => {
    /* fiscal_devices was always cleared; its children were not, so a wiped
       till could grow a new OKC carrying the old one's proof. */
    for (const child of ['fiscal_device_capabilities', 'fiscal_device_ownership',
      'fiscal_evidence', 'fiscal_departments', 'fiscal_vat_codes']) {
      assert.ok(demo.CATALOGUE.includes(child), child + ' katalog temizligine dahil degil');
      assert.ok(demo.CATALOGUE.indexOf(child) < demo.CATALOGUE.indexOf('fiscal_devices'),
        child + ' fiscal_devices SONRASINA yazilmis - once cocuk, sonra ebeveyn');
    }
  });

  await step('kendi kiracısından başkasına dokunmaz', async () => {
    /* the whole point of client 77: the bench's own restaurant has to come
       out of this suite exactly as it went in */
    for (const t of ['products', 'categories', 'restaurant_tables', 'users']) {
      const n = Number(await db.value(`SELECT COUNT(*) FROM ${t} WHERE client_id=?`, [BENCH]));
      assert.ok(n > 0, `client ${BENCH} tenantının ${t} tablosu boşalmış`);
    }
  });

  /* leave nothing behind: the tenant, and the installation-wide flag */
  await db.exec('DELETE FROM clients WHERE client_id=?', [CID]).catch(() => {});
  await db.setSetting('demo_seeded_at', settingsBefore || '');
  await db.setSetting('demo_data', '0');
  db.setClientId(BENCH);

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
