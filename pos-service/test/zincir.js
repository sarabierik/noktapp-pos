'use strict';
/**
 * ZİNCİR — the till's half of the multi-branch layer, against the real panel
 * and the real database.
 *
 * Nothing here is mocked, because the failures this suite exists to catch are
 * exactly the ones a mock hides: a published menu that matches on the NAME and
 * so duplicates every product the day head office renames one; a pull that
 * deletes a withdrawn item and takes last year's order lines with it; a branch
 * exception that leaks to the branch next door; a price that moves underneath
 * an open bill; and - the one that matters most - a single-shop customer who
 * never asked for any of this suddenly finding their menu managed by somebody
 * else.
 *
 * Two tenants are used on purpose:
 *   19  tek işletme  - must be byte-identical before and after everything here
 *   22  Zincir Demo  - MERKEZ ve KALEICI, menu published, KOFTE fiyat kilitli
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/zincir.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7473';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const mysql = require('mysql2/promise');
const db = require('../src/db');
const auth = require('../src/auth');
const config = require('../src/config');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const PANEL = process.env.PANEL || 'http://127.0.0.1:8090';
const CID = 19;                     // tek işletme - the control group
const CHAIN = 22;                   // Zincir Demo - MERKEZ
const OTHER = 23;                   // the KALEICI till, in the same local db
const KEY = '13104EA0EEB3F4CBB703BEE8';
const TILL_DEVICE = 'zincir-test-merkez';
const OTHER_DEVICE = 'zincir-test-kaleici';
let TOKEN = null;
let panel = null;                   // a second connection, to the panel's db

async function api(method, pathname, body, token = TOKEN) {
  const res = await fetch(BASE + pathname, {
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
 * The migration is applied here rather than assumed - the desktop shell
 * re-runs every file in database/migrations on each start and a test run has
 * no shell. The file is written to be idempotent, so this is what the shell
 * does.
 */
async function migrate() {
  const file = path.join(__dirname, '..', '..', 'database', 'migrations', '2026-09-07-zincir.sql');
  const sql = fs.readFileSync(file, 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await db.exec(stmt); } catch (_) { /* already applied */ }
  }
}

/* ------------------------------------------------------------------ */
/* head office, driven straight against the panel's database           */
/* ------------------------------------------------------------------ */
/*
 * Publishing is a panel-side action with a panel-side screen, and this suite
 * is the till's half. Rather than drive a browser, the two writes head office
 * makes - edit the master row, press Yayınla - are made here in SQL, in
 * exactly the shape lib/chain.php mints them: only ACTIVE rows are frozen into
 * the version, the payload key order is fixed, and row_hash is the sha1 of
 * that payload. The hash is what the panel diffs one version against the next,
 * so getting the shape wrong would show up immediately as a full pull where an
 * incremental one was expected - which is itself one of the checks below.
 */
const catPayload = r => ({
  master_code: String(r.master_code), name: String(r.name),
  station_hint: r.station_hint === null ? null : String(r.station_hint),
  sort_order: Number(r.sort_order), is_active: Number(r.is_active),
  use_in_pos: Number(r.use_in_pos), use_in_qr: Number(r.use_in_qr),
  price_locked: Number(r.price_locked),
});
const dec2 = v => (v === null || v === undefined ? null : Number(v).toFixed(2));
const prodPayload = r => ({
  master_code: String(r.master_code),
  category_code: r.category_code === null ? null : String(r.category_code),
  name: String(r.name), description: r.description === null ? null : String(r.description),
  price: dec2(r.price), cost_price: dec2(r.cost_price), vat_rate: dec2(r.vat_rate),
  track_stock: Number(r.track_stock), use_in_pos: Number(r.use_in_pos),
  use_in_qr: Number(r.use_in_qr), image_url: r.image_url === null ? null : String(r.image_url),
  sort_order: Number(r.sort_order), is_active: Number(r.is_active),
  price_locked: Number(r.price_locked),
});
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

async function pq(sql, params = []) { const [rows] = await panel.query(sql, params); return rows; }

/** Yayınla: mint the next version and freeze today's active master menu into it. */
async function publish(note) {
  const [[v]] = await panel.query(
    'SELECT COALESCE(MAX(version),0) n FROM np_menu_versions WHERE tenant_id=?', [CHAIN]);
  const next = Number(v.n) + 1;
  const cats = await pq(
    'SELECT * FROM np_menu_categories WHERE tenant_id=? AND is_active=1 ORDER BY sort_order, id', [CHAIN]);
  const prods = await pq(
    `SELECT p.*, c.master_code AS category_code FROM np_menu_products p
       LEFT JOIN np_menu_categories c ON c.id=p.category_id AND c.tenant_id=p.tenant_id
      WHERE p.tenant_id=? AND p.is_active=1 ORDER BY p.sort_order, p.id`, [CHAIN]);
  const [res] = await panel.query(
    `INSERT INTO np_menu_versions (tenant_id, version, note, published_by, product_count, category_count)
     VALUES (?,?,?,?,?,?)`, [CHAIN, next, note, 'zincir-test', prods.length, cats.length]);
  const vid = res.insertId;
  for (const r of cats) {
    const j = JSON.stringify(catPayload(r));
    await panel.query(
      `INSERT INTO np_menu_version_items (tenant_id, version_id, version, entity, master_code, payload, row_hash)
       VALUES (?,?,?,'category',?,?,?)`, [CHAIN, vid, next, r.master_code, j, sha1(j)]);
  }
  for (const r of prods) {
    const j = JSON.stringify(prodPayload(r));
    await panel.query(
      `INSERT INTO np_menu_version_items (tenant_id, version_id, version, entity, master_code, payload, row_hash)
       VALUES (?,?,?,'product',?,?,?)`, [CHAIN, vid, next, r.master_code, j, sha1(j)]);
  }
  return next;
}

/** Head office adding or editing one master product. */
async function master(code, fields) {
  const cat = await pq('SELECT id FROM np_menu_categories WHERE tenant_id=? AND master_code=?',
    [CHAIN, fields.category_code || 'YEMEKLER']);
  const f = {
    name: fields.name, price: fields.price, vat_rate: fields.vat_rate || 10,
    sort_order: fields.sort_order || 9, is_active: fields.is_active === undefined ? 1 : fields.is_active,
    price_locked: fields.price_locked === undefined ? 1 : fields.price_locked,
  };
  await panel.query(
    `INSERT INTO np_menu_products (tenant_id, master_code, category_id, name, price, vat_rate,
        sort_order, is_active, price_locked)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE category_id=VALUES(category_id), name=VALUES(name), price=VALUES(price),
        vat_rate=VALUES(vat_rate), sort_order=VALUES(sort_order), is_active=VALUES(is_active),
        price_locked=VALUES(price_locked)`,
    [CHAIN, code, cat[0].id, f.name, f.price, f.vat_rate, f.sort_order, f.is_active, f.price_locked]);
}

/* ------------------------------------------------------------------ */
/* local fixture                                                       */
/* ------------------------------------------------------------------ */

const SETTING_KEYS = ['branch_id', 'branch_code', 'branch_name', 'menu_version',
  'menu_last_pull_at', 'menu_last_error', 'device_id', 'panel_url'];
const saved = {};

async function snapshotSettings() {
  for (const k of SETTING_KEYS) saved[k] = await db.getSetting(k, null);
}
async function restoreSettings() {
  for (const k of SETTING_KEYS) {
    if (saved[k] === null || saved[k] === undefined) await db.exec('DELETE FROM np_settings WHERE k=?', [k]);
    else await db.setSetting(k, saved[k]);
  }
}
async function clearBranch() {
  for (const k of ['branch_id', 'branch_code', 'branch_name', 'menu_version', 'menu_last_pull_at', 'menu_last_error']) {
    await db.exec('DELETE FROM np_settings WHERE k=?', [k]);
  }
}

/** Everything the two chain tenants own locally, wiped back to nothing. */
async function fixture() {
  panel = await mysql.createConnection({
    host: config.db.host, port: config.db.port, user: config.db.user,
    password: config.db.password, database: 'nokpos_panel', dateStrings: true,
  });

  await snapshotSettings();
  for (const c of [CHAIN, OTHER]) {
    await db.exec('DELETE FROM order_items WHERE client_id=?', [c]);
    await db.exec('DELETE FROM order_payments WHERE client_id=?', [c]).catch(() => {});
    await db.exec('DELETE FROM orders WHERE client_id=?', [c]);
    await db.exec('DELETE FROM price_change_log WHERE client_id=?', [c]).catch(() => {});
    await db.exec('DELETE FROM product_price_history WHERE client_id=?', [c]).catch(() => {});
    await db.exec('DELETE FROM products WHERE client_id=?', [c]);
    await db.exec('DELETE FROM categories WHERE client_id=?', [c]);
    await db.exec('DELETE FROM np_menu_apply_log WHERE client_id=?', [c]).catch(() => {});
    await db.exec(
      `INSERT INTO clients (id, client_id, slug, company_name, owner_name, email, phone,
          tax_number, tax_office, full_address, is_active, created_at, role, username, password_hash)
       VALUES (?,?,?,?,'','','','','','',1,NOW(),'admin','','')
       ON DUPLICATE KEY UPDATE is_active=1`,
      [c, c, 'zincir-' + c, c === CHAIN ? 'Zincir Demo' : 'Zincir Demo Kaleici']);
  }
  await clearBranch();

  /*
   * np_licence is a single row - it is the identity of THIS installation. The
   * suite borrows it for tenant 22 and puts 19 back at the end, because every
   * other suite in the run is tenant 19 and would otherwise authenticate as
   * somebody else's restaurant.
   */
  const lic = await db.one('SELECT * FROM np_licence WHERE id=1');
  saved._lic = lic ? { client_id: lic.client_id, licence_key: lic.licence_key, company_name: lic.company_name } : null;
  await db.exec(
    `INSERT INTO np_licence (id, client_id, company_name, licence_key, status, seats, grace_days, last_ok_at, last_check_at)
     VALUES (1,?,?,?,'active',5,7,NOW(),NOW())
     ON DUPLICATE KEY UPDATE client_id=VALUES(client_id), company_name=VALUES(company_name),
        licence_key=VALUES(licence_key), status='active', last_ok_at=NOW()`,
    [CHAIN, 'Zincir Demo', KEY]);
  await db.setSetting('device_id', TILL_DEVICE);
  await db.setSetting('panel_url', PANEL);
  db.setClientId(CHAIN);

  await resetHeadOffice();
}

/**
 * Head office, put back the way the seed left it.
 *
 * The suite publishes real versions and edits real master rows, and the panel
 * database is NOT rebuilt between runs the way the local one is. Without this
 * the second run would start from the first run's ending menu - Çay at 24.00,
 * a stray 99.00 exception, a withdrawn pide - and every price assertion below
 * would be measuring the last run rather than the code. Versions themselves
 * are left to accumulate: that is what a real panel does, and a till that
 * joins at version 40 must behave exactly like one that joined at version 1.
 */
async function resetHeadOffice() {
  await panel.query(
    `UPDATE np_menu_products SET name='Kofte', price=180.00, vat_rate=10.00, sort_order=1,
        is_active=1, price_locked=1 WHERE tenant_id=? AND master_code='KOFTE'`, [CHAIN]);
  await panel.query(
    `UPDATE np_menu_products SET name='Cay', price=20.00, vat_rate=10.00, sort_order=2,
        is_active=1, price_locked=0 WHERE tenant_id=? AND master_code='CAY'`, [CHAIN]);
  await panel.query('DELETE FROM np_menu_products WHERE tenant_id=? AND master_code LIKE ?', [CHAIN, 'ZT\\_%']);
  await panel.query('UPDATE np_menu_categories SET is_active=1 WHERE tenant_id=?', [CHAIN]);

  // the two exceptions the demo tenant is documented as having, and no others
  await panel.query('DELETE FROM np_branch_overrides WHERE tenant_id=?', [CHAIN]);
  const b = await pq("SELECT id FROM np_branches WHERE tenant_id=? AND code='MERKEZ'", [CHAIN]);
  await panel.query(
    `INSERT INTO np_branch_overrides (tenant_id, branch_id, entity, master_code, available, price, updated_by)
     VALUES (?,?,'product','CAY',NULL,25.00,'seed'), (?,?,'product','KOFTE',0,NULL,'seed')`,
    [CHAIN, b[0].id, CHAIN, b[0].id]);

  await publish('zincir sinamasi baslangic');
}

/** What the single-shop tenant looks like, so it can be compared afterwards. */
async function fingerprint(clientId) {
  const rows = await db.query(
    `SELECT id, name, price, is_active, master_code FROM products WHERE client_id=? ORDER BY id`, [clientId]);
  const cats = await db.query(
    `SELECT id, name, is_active, master_code FROM categories WHERE client_id=? ORDER BY id`, [clientId]);
  return JSON.stringify({ rows, cats });
}

const prodByCode = (clientId, code) =>
  db.one('SELECT * FROM products WHERE client_id=? AND master_code=?', [clientId, code]);

(async () => {
  const server = await bootstrap();
  await migrate();
  await fixture();
  TOKEN = await auth.issueToken({ cid: CHAIN, uid: 0, role: 'admin', name: 'Zincir Sahibi', kind: 'pos' });
  const zincir = require('../src/modules/zincir');
  const _licence = require('../src/licence');
  const orders = require('../src/modules/orders');

  console.log('\nNOKTApp POS - zincir: şube kimliği, merkez menüsü, istisnalar\n');

  /* ================== 1. TEK İŞLETME HİÇBİR ŞEY GÖRMEZ ================== */
  /*
   * This is the check the whole feature is judged on, so it runs first and
   * again last. A till with no branch code must not send a single byte to the
   * panel from this module - not "and then ignore the answer", not at all.
   */
  const soloBefore = await fingerprint(CID);

  await step('bir şubesi olmayan kasa panele hiçbir istek göndermez', async () => {
    let hits = 0;
    const stub = http.createServer((req, res) => { hits++; res.end('{"ok":false}'); });
    await new Promise(r => stub.listen(0, '127.0.0.1', r));
    const was = await db.getSetting('panel_url');
    await db.setSetting('panel_url', 'http://127.0.0.1:' + stub.address().port);
    await clearBranch();
    try {
      const out = await zincir.pullOnHeartbeat();
      assert.strictEqual(out.skipped, 'no_branch', 'şubesiz kasa menü çekmeye kalktı');
      const direct = await zincir.pull(CID);
      assert.strictEqual(direct.skipped, 'no_branch');
      assert.strictEqual(hits, 0, 'şubesiz kasa panele ' + hits + ' istek gönderdi');
    } finally {
      await db.setSetting('panel_url', was);
      stub.close();
    }
  });

  await step('şubesiz kasada menü sürümü ve şube ayarları hiç yazılmaz', async () => {
    const st = await zincir.state(CID);
    assert.strictEqual(st.bound, false);
    assert.strictEqual(st.branch_code, null);
    assert.strictEqual(st.menu_version, 0);
    assert.strictEqual(st.products, null, 'şubesiz kasaya merkez sayaçları çizilmiş');
  });

  /* ========================= 2. ŞUBEYE BAĞLANMA ========================= */

  let v0 = 0;
  await step('kasa merkezin verdiği kodla şubeye bağlanır', async () => {
    const r = await zincir.bind(CHAIN, 'merkez');       // küçük harf de kabul edilmeli
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.branch && r.branch.code === 'MERKEZ', 'şube dönmedi: ' + JSON.stringify(r.branch));
    assert.strictEqual(r.state.branch_code, 'MERKEZ');
    assert.strictEqual(r.state.branch_name, 'Merkez');
    assert.ok(Number(r.state.branch_id) > 0);
    v0 = r.version;
    assert.ok(v0 > 0, 'yayınlanmış sürüm gelmedi');
    // and the panel now knows which restaurant this machine sits in
    const d = await pq('SELECT branch_id FROM np_devices WHERE tenant_id=? AND device_id=?', [CHAIN, TILL_DEVICE]);
    assert.ok(d.length && Number(d[0].branch_id) === Number(r.state.branch_id), 'cihaz panelde şubeye bağlanmadı');
  });

  await step('tanınmayan bir şube kodu reddedilir ve kasa bağsız kalır', async () => {
    const before = await zincir.state(CHAIN);
    /* Caught rather than handed to assert.rejects so that a failure says what
       head office actually answered. A blank refusal used to read "the input
       did not match ... Input:" and named neither the message nor its status. */
    let thrown = null;
    try { await zincir.bind(CHAIN, 'YOKBOYLESUBE'); }
    catch (e) { thrown = e; }
    assert.ok(thrown, 'geçersiz şube kodu kabul edildi');
    assert.ok(/tanınmadı/i.test(thrown.message || ''),
      `beklenen ret gelmedi -> status=${thrown.status} code=${thrown.code} message=${JSON.stringify(thrown.message)}`);
    const after = await zincir.state(CHAIN);
    assert.strictEqual(after.branch_code, before.branch_code, 'geçersiz kod mevcut bağı bozdu');
  });

  /* ====================== 3. İLK ÇEKİM: MERKEZ MENÜSÜ ==================== */

  await step('ilk çekim merkez menüsünü yerel veritabanına kurar', async () => {
    const cats = await db.query('SELECT * FROM categories WHERE client_id=? AND master_code IS NOT NULL', [CHAIN]);
    assert.ok(cats.some(c => c.master_code === 'YEMEKLER'), 'kategori gelmedi');
    const kofte = await prodByCode(CHAIN, 'KOFTE');
    const cay = await prodByCode(CHAIN, 'CAY');
    assert.ok(kofte && cay, 'ürünler gelmedi');
    assert.strictEqual(Number(kofte.master_price), 180, 'merkez fiyatı saklanmadı');
    assert.strictEqual(Number(kofte.master_price_locked), 1, 'fiyat kilidi saklanmadı');
    assert.strictEqual(Number(cay.master_price_locked), 0);
    // the category the products hang off is the local row, matched by code
    const yem = cats.find(c => c.master_code === 'YEMEKLER');
    assert.strictEqual(Number(kofte.category_id), Number(yem.id));
    // istasyon binaya aittir: merkez ona dokunmaz
    assert.strictEqual(yem.station_id, null, 'merkez yerel istasyon bağlantısını ezdi');
  });

  await step('merkezden gelen fiyat, fiyat geçmişine kendi kaynağıyla yazılır', async () => {
    const cay = await prodByCode(CHAIN, 'CAY');
    const rows = await db.query(
      "SELECT * FROM price_change_log WHERE client_id=? AND product_id=? AND source='merkez'",
      [CHAIN, cay.id]);
    assert.ok(rows.length >= 1, 'merkez fiyatı için price_change_log satırı yok');
    const pricing = require('../src/modules/pricing');
    const h = await pricing.priceHistory(CHAIN, cay.id);
    assert.ok(h.changes.some(c => c.source_label === 'Merkez menü'),
      'fiyat geçmişi merkezden geleni "Elle" gösteriyor');
  });

  /* ============================ 4. İSTİSNALAR =========================== */

  await step('kilitli olmayan fiyat istisnası uygulanır', async () => {
    const cay = await prodByCode(CHAIN, 'CAY');
    assert.strictEqual(Number(cay.price), 25, 'MERKEZ için 25.00 istisnası uygulanmadı');
    assert.strictEqual(Number(cay.master_price), 20, 'merkez fiyatı istisna ile ezilmiş');
  });

  await step('satışa kapatma istisnası ürünü yerelde kapatır', async () => {
    const kofte = await prodByCode(CHAIN, 'KOFTE');
    assert.strictEqual(Number(kofte.is_active), 0, 'available=0 istisnası ürünü kapatmadı');
    assert.strictEqual(Number(kofte.master_is_active), 1, 'merkezdeki durum yanlış yazılmış');
  });

  await step('kilitli bir fiyat şube istisnasıyla ezilemez', async () => {
    /* Head office writes the exception straight into the table, bypassing its
       own form. The panel strips it on the way out (the price is locked), and
       even if it did not, the till must ignore it - both halves are checked. */
    await panel.query(
      `INSERT INTO np_branch_overrides (tenant_id, branch_id, entity, master_code, available, price, updated_by)
       VALUES (?,(SELECT id FROM np_branches WHERE tenant_id=? AND code='MERKEZ'),'product','KOFTE',0,99.00,'test')
       ON DUPLICATE KEY UPDATE price=99.00`, [CHAIN, CHAIN]);
    const payload = await zincir.fetchMenu({ since: 0 });
    const o = payload.overrides.find(x => x.master_code === 'KOFTE');
    assert.ok(o, 'KOFTE istisnası hiç gelmedi');
    assert.strictEqual(o.price, null, 'panel kilitli fiyatı temizlemeden gönderdi');

    /* And the till's own guard, fed a payload that carries the price anyway.
       The rest of the branch's exception set has to ride along: overrides are
       sent whole and the till reconciles against the whole set, so handing it
       one row would correctly - and confusingly - withdraw the others. */
    await zincir.apply(CHAIN, {
      ...payload,
      overrides: payload.overrides.map(x => (x.master_code === 'KOFTE' ? { ...x, price: '99.00' } : x)),
    });
    const kofte = await prodByCode(CHAIN, 'KOFTE');
    assert.strictEqual(Number(kofte.price), 180, 'kilitli fiyat yerelde ezildi');
  });

  await step('bir şubenin istisnası diğer şubeyi etkilemez', async () => {
    /* The KALEICI till is the same code against a second local client_id. It
       binds with its own device id, so the panel hands it its own - empty -
       exception set. */
    const keep = { id: await db.getSetting('branch_id'), code: await db.getSetting('branch_code'),
      name: await db.getSetting('branch_name'), ver: await db.getSetting('menu_version') };
    await db.setSetting('device_id', OTHER_DEVICE);
    try {
      const payload = await zincir.fetchMenu({ since: 0, branchCode: 'KALEICI' });
      assert.strictEqual(payload.branch.code, 'KALEICI');
      assert.strictEqual(payload.overrides.length, 0, 'MERKEZ istisnaları KALEICI\'ye sızdı');
      await zincir.apply(OTHER, payload);
      const there = await prodByCode(OTHER, 'KOFTE');
      const here = await prodByCode(CHAIN, 'KOFTE');
      assert.strictEqual(Number(there.is_active), 1, 'KALEICI\'de de kapanmış');
      assert.strictEqual(Number(there.price), 180, 'KALEICI merkez fiyatını almadı');
      assert.strictEqual(Number(here.is_active), 0, 'MERKEZ\'deki kapatma kaybolmuş');
      const cayThere = await prodByCode(OTHER, 'CAY');
      assert.strictEqual(Number(cayThere.price), 20, 'MERKEZ fiyat istisnası KALEICI\'ye sızdı');
    } finally {
      await db.setSetting('device_id', TILL_DEVICE);
      await db.setSetting('branch_id', keep.id); await db.setSetting('branch_code', keep.code);
      await db.setSetting('branch_name', keep.name); await db.setSetting('menu_version', keep.ver);
    }
  });

  /* ===================== 5. AYNI SÜRÜMÜ TEKRAR UYGULAMA ================= */

  await step('aynı sürümün ikinci çekimi hiçbir şeyi değiştirmez', async () => {
    const before = await fingerprint(CHAIN);
    const logsBefore = await db.query('SELECT COUNT(*) n FROM np_menu_apply_log WHERE client_id=?', [CHAIN]);
    const r = await zincir.pull(CHAIN);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.version, v0);
    assert.strictEqual(r.inserted, 0); assert.strictEqual(r.updated, 0); assert.strictEqual(r.deactivated, 0);
    assert.strictEqual(r.changed, false, 'değişmeyen bir çekim "değişti" dedi');
    assert.strictEqual(await fingerprint(CHAIN), before, 'menü kendiliğinden değişti');
    const logsAfter = await db.query('SELECT COUNT(*) n FROM np_menu_apply_log WHERE client_id=?', [CHAIN]);
    assert.strictEqual(Number(logsAfter[0].n), Number(logsBefore[0].n),
      'değişmeyen çekim de defterine satır yazmış');
  });

  /* ==================== 6. ŞUBENİN KENDİ ÜRÜNÜ =========================== */

  let localId = 0;
  await step('şubenin kendi ürünü eklenir', async () => {
    const cat = await db.one('SELECT id FROM categories WHERE client_id=? AND master_code=?', [CHAIN, 'YEMEKLER']);
    localId = await db.insert(
      `INSERT INTO products (client_id, category_id, name, price, cost_price, sort_order,
          is_active, use_in_pos, use_in_qr, vat_rate, track_stock)
       VALUES (?,?,?,?,0,50,1,1,1,10,0)`, [CHAIN, cat.id, 'Şubeye özel tatlı', 45.00]);
    const p = await db.one('SELECT * FROM products WHERE id=?', [localId]);
    assert.strictEqual(p.master_code, null, 'yerel ürüne master_code yazılmış');
  });

  /* ================== 7. ARTIMLI ÇEKİM: YERİNDE GÜNCELLEME ============== */

  let pideLocalId = 0; let v1 = 0;
  await step('artımlı çekim ürünü yerinde günceller, yerel id değişmez', async () => {
    const cayBefore = await prodByCode(CHAIN, 'CAY');
    await master('ZT_PIDE', { name: 'Kusbasili Pide', price: 190.00, price_locked: 1, sort_order: 3 });
    await panel.query('UPDATE np_menu_products SET name=?, price=? WHERE tenant_id=? AND master_code=?',
      ['Cay (buyuk)', 24.00, CHAIN, 'CAY']);
    v1 = await publish('ikinci surum');

    const r = await zincir.pull(CHAIN);
    assert.strictEqual(r.version, v1, JSON.stringify(r));
    assert.strictEqual(r.full, false, 'artımlı çekim beklenirken tam menü geldi');
    assert.strictEqual(r.inserted, 1, 'yalnızca yeni ürün eklenmeliydi: ' + JSON.stringify(r));

    const cayAfter = await prodByCode(CHAIN, 'CAY');
    assert.strictEqual(Number(cayAfter.id), Number(cayBefore.id), 'ürün yeniden yaratılmış - eski adisyonlar öksüz');
    assert.strictEqual(cayAfter.name, 'Cay (buyuk)', 'ad güncellenmedi');
    assert.strictEqual(Number(cayAfter.master_price), 24, 'merkez fiyatı güncellenmedi');
    assert.strictEqual(Number(cayAfter.price), 25, 'şube istisnası merkez güncellemesiyle silinmiş');

    const pide = await prodByCode(CHAIN, 'ZT_PIDE');
    assert.ok(pide, 'yeni merkez ürünü gelmedi');
    assert.strictEqual(Number(pide.price), 190);
    pideLocalId = pide.id;
  });

  await step('şubenin kendi ürünü her çekimden sağ çıkar', async () => {
    const p = await db.one('SELECT * FROM products WHERE id=?', [localId]);
    assert.ok(p, 'yerel ürün silinmiş');
    assert.strictEqual(p.name, 'Şubeye özel tatlı');
    assert.strictEqual(Number(p.price), 45);
    assert.strictEqual(Number(p.is_active), 1, 'yerel ürün merkez çekiminde kapatılmış');
    assert.strictEqual(p.master_code, null);
  });

  /* ====================== 8. AÇIK ADİSYONA DOKUNULMAZ =================== */

  await step('açık adisyonun toplamları merkez güncellemesiyle değişmez', async () => {
    const orderId = await orders.openOrder(CHAIN, { userId: 0, label: 'ZINCIR-1' });
    await orders.addItem(CHAIN, orderId, { productId: pideLocalId, qty: 2, userId: 0 });
    const before = await db.one('SELECT total, vat_total, grand_total FROM orders WHERE id=?', [orderId]);
    const lineBefore = await db.one('SELECT unit_price, line_total FROM order_items WHERE order_id=?', [orderId]);
    assert.strictEqual(Number(lineBefore.unit_price), 190);

    await panel.query('UPDATE np_menu_products SET price=? WHERE tenant_id=? AND master_code=?',
      [230.00, CHAIN, 'ZT_PIDE']);
    const v2 = await publish('pide zammi');
    const r = await zincir.pull(CHAIN);
    assert.strictEqual(r.version, v2);

    const pide = await db.one('SELECT * FROM products WHERE id=?', [pideLocalId]);
    assert.strictEqual(Number(pide.price), 230, 'yeni fiyat menüye inmemiş');

    const after = await db.one('SELECT total, vat_total, grand_total FROM orders WHERE id=?', [orderId]);
    assert.strictEqual(Number(after.total), Number(before.total), 'açık adisyonun ara toplamı değişti');
    assert.strictEqual(Number(after.vat_total), Number(before.vat_total), 'açık adisyonun KDV\'si değişti');
    assert.strictEqual(Number(after.grand_total), Number(before.grand_total), 'açık adisyonun toplamı değişti');
    const lineAfter = await db.one('SELECT unit_price, line_total FROM order_items WHERE order_id=?', [orderId]);
    assert.strictEqual(Number(lineAfter.unit_price), 190, 'satırdaki birim fiyat dondurulmamış');
    assert.strictEqual(Number(lineAfter.line_total), Number(lineBefore.line_total));
  });

  /* ================== 9. MERKEZDEN KALDIRILAN ÜRÜN ====================== */

  await step('merkezden kaldırılan ürün kapatılır, silinmez; eski satırları çözülür', async () => {
    const itemsBefore = await db.query(
      'SELECT id FROM order_items WHERE client_id=? AND product_id=?', [CHAIN, pideLocalId]);
    assert.ok(itemsBefore.length > 0, 'sınamanın dayandığı adisyon satırı yok');

    await panel.query('UPDATE np_menu_products SET is_active=0 WHERE tenant_id=? AND master_code=?',
      [CHAIN, 'ZT_PIDE']);
    const v3 = await publish('pide kaldirildi');
    const r = await zincir.pull(CHAIN);
    assert.strictEqual(r.version, v3);
    assert.ok(r.deactivated >= 1, 'kaldırılan ürün sayılmadı: ' + JSON.stringify(r));

    const pide = await db.one('SELECT * FROM products WHERE id=?', [pideLocalId]);
    assert.ok(pide, 'merkezden kaldırılan ürün YERELDEN SİLİNMİŞ - adisyon satırları öksüz kaldı');
    assert.strictEqual(Number(pide.is_active), 0, 'kaldırılan ürün hâlâ satışta');

    // the whole reason it is deactivated and not deleted: this join must work
    const resolved = await db.query(
      `SELECT i.id, p.name FROM order_items i JOIN products p ON p.id=i.product_id AND p.client_id=i.client_id
        WHERE i.client_id=? AND i.product_id=?`, [CHAIN, pideLocalId]);
    assert.strictEqual(resolved.length, itemsBefore.length, 'eski adisyon satırları ürüne bağlanamıyor');
    assert.ok(resolved[0].name, 'satırın ürün adı okunamıyor');

    // and it is off the till's menu, which is what deactivating is FOR
    const catalog = require('../src/modules/catalog');
    const menu = await catalog.menu(CHAIN);
    const onMenu = menu.some(c => c.products.some(p => Number(p.id) === Number(pideLocalId)));
    assert.strictEqual(onMenu, false, 'kaldırılan ürün hâlâ kasa menüsünde');
  });

  /* =========================== 10. MERKEZE BİLDİRİM ===================== */

  await step('uygulanan sürüm merkeze bildirilir', async () => {
    const st = await zincir.state(CHAIN);
    assert.ok(st.last_apply, 'uygulama defteri boş');
    assert.strictEqual(st.last_apply.acked, true, 'merkeze bildirilmedi');
    const b = await pq('SELECT menu_version, menu_counts FROM np_branches WHERE tenant_id=? AND code=?',
      [CHAIN, 'MERKEZ']);
    assert.strictEqual(Number(b[0].menu_version), st.menu_version,
      'merkez şubeyi hâlâ eski sürümde sanıyor');
  });

  await step('uygulama defteri ne olduğunu satır satır anlatır', async () => {
    const rows = await zincir.history(CHAIN);
    assert.ok(rows.length >= 3, 'defterde sürümler yok: ' + rows.length);
    assert.ok(rows[0].version > rows[rows.length - 1].version, 'defter en yeniden eskiye sıralı değil');
    assert.ok(rows.some(r => r.deactivated > 0), 'kapatma hiç kaydedilmemiş');
  });

  /* ====================== 11. UÇ DURUMLAR =============================== */

  await step('hiç yayın yapılmamışsa (version 0) hiçbir şey uygulanmaz', async () => {
    const before = await fingerprint(CHAIN);
    const r = await zincir.apply(CHAIN, {
      version: 0, full: true, categories: [], products: [], overrides: [],
      withdrawn: [], withdrawn_categories: [], branch: { id: 5, code: 'MERKEZ', name: 'Merkez' },
    });
    assert.strictEqual(r.applied, false);
    assert.strictEqual(r.reason, 'not_published');
    assert.strictEqual(await fingerprint(CHAIN), before, 'boş bir yayın menüyü sildi');
  });

  await step('merkeze ulaşılamaması hata değildir; kasa mevcut menüyle devam eder', async () => {
    const was = await db.getSetting('panel_url');
    const before = await fingerprint(CHAIN);
    const version = (await zincir.state(CHAIN)).menu_version;
    await db.setSetting('panel_url', 'http://127.0.0.1:9');
    try {
      const r = await zincir.pull(CHAIN);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.offline, true, 'çevrimdışılık hata olarak fırlatıldı');
      assert.strictEqual(r.version, version, 'çevrimdışıyken sürüm geri alınmış');
      assert.strictEqual(await fingerprint(CHAIN), before, 'çevrimdışı çekim menüyü bozdu');
      const st = await zincir.state(CHAIN);
      assert.ok(st.last_error, 'sebep ekrana yazılmak üzere saklanmadı');
    } finally { await db.setSetting('panel_url', was); }
  });

  /* ====================== 12. HTTP UÇLARI VE KALP ATIŞI ================= */

  await step('menü çekimi lisans kalp atışının üstünde gider, ayrı bir zamanlayıcı yoktur', async () => {
    const beat = await require('../src/licence').heartbeat();
    assert.strictEqual(beat.ok, true, JSON.stringify(beat));
    assert.ok(beat.menu, 'kalp atışı menüyü hiç sormadı');
    assert.strictEqual(beat.menu.skipped, undefined, 'bağlı kasada menü çekimi atlandı');
    assert.strictEqual(beat.menu.version, (await zincir.state(CHAIN)).menu_version);
  });

  await step('şube durumu ve "şimdi güncelle" ekrandan çalışır', async () => {
    const r = await api('GET', '/api/device/branch');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.branch.bound, true);
    assert.strictEqual(r.branch.branch_code, 'MERKEZ');
    assert.ok(r.branch.products.local >= 1, 'şubenin kendi ürün sayısı görünmüyor');
    const p = await api('POST', '/api/device/branch/pull');
    assert.strictEqual(p.status, 200, JSON.stringify(p));
    assert.strictEqual(p.changed, false, 'güncel menü yeniden uygulandı');
    const c = await api('GET', '/api/device/connection');
    assert.ok(c.branch && c.branch.bound, 'bağlantı ekranı şubeyi göstermiyor');
  });

  await step('bir garson şubeyi değiştiremez', async () => {
    const waiter = await auth.issueToken({ cid: CHAIN, uid: 0, role: 'waiter', name: 'Garson', kind: 'pos' });
    const denied = await api('POST', '/api/device/branch/bind', { code: 'KALEICI' }, waiter);
    assert.strictEqual(denied.status, 403, 'garson kasayı başka şubeye taşıyabiliyor');
    const st = await zincir.state(CHAIN);
    assert.strictEqual(st.branch_code, 'MERKEZ');
  });

  /* =============== 13. TEK İŞLETME, HER ŞEYDEN SONRA ==================== */

  await step('tek işletmeli müşterinin menüsü baştan sona değişmedi', async () => {
    assert.strictEqual(await fingerprint(CID), soloBefore,
      'zincir katmanı tek işletmeli müşterinin menüsüne dokundu');
    const withMaster = await db.query(
      'SELECT COUNT(*) n FROM products WHERE client_id=? AND master_code IS NOT NULL', [CID]);
    assert.strictEqual(Number(withMaster[0].n), 0, 'tek işletmeli müşteriye merkez ürünü yazılmış');
  });

  await step('şube bağı çözülünce kasa yine tek işletme gibi davranır', async () => {
    await clearBranch();
    const st = await zincir.state(CID);
    assert.strictEqual(st.bound, false);
    assert.strictEqual(await zincir.pullOnHeartbeat().then(r => r.skipped), 'no_branch');
  });

  /* ================================ sonuç =============================== */
  await restoreSettings();
  if (saved._lic) {
    await db.exec('UPDATE np_licence SET client_id=?, licence_key=?, company_name=? WHERE id=1',
      [saved._lic.client_id, saved._lic.licence_key, saved._lic.company_name]);
  }
  db.setClientId(saved._lic ? saved._lic.client_id : CID);
  await panel.end();

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
