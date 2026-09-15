'use strict';
/**
 * YEMEK PLATFORMU ENTEGRASYONU — the failures that only appear at 20:30 on a
 * Friday, when the same order arrives three times and the printer is busy.
 *
 * Everything runs against a real MariaDB, the real HTTP service and the real
 * printing queue. The only thing that is not real is the platform, and it
 * cannot be: none of the four will issue credentials to a sandbox. So the
 * provider simulator stands in for it - and that is exactly why this file has
 * to be strict about the things a mock would hide: a package delivered twice,
 * an event that arrives out of order, a 429, a timeout, a cancellation after
 * the kitchen has already started cooking.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/entegrasyon.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7473';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
const OTHER = 77;                     // a second tenant, used only to prove isolation
let TOKEN = null;

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

/** The desktop shell replays every migration on boot; a test run has no shell. */
async function migrate() {
  const file = path.join(__dirname, '..', '..', 'database', 'migrations', '2026-09-06-entegrasyon.sql');
  const sql = fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await db.exec(stmt); } catch (_) { /* already applied */ }
  }
}

/**
 * A clean slate, and a menu to map against.
 *
 * The suites share one database, so every count below would otherwise be
 * measuring the leftovers of whoever ran before.
 */
async function fixture() {
  for (const t of ['np_int_order_items', 'np_int_orders', 'np_int_events', 'np_int_logs',
    'np_int_cursors', 'np_int_menu_map', 'np_int_connections']) {
    await db.exec(`DELETE FROM ${t} WHERE client_id IN (?,?)`, [CID, OTHER]).catch(() => {});
  }
  /*
   * run-all.sh rebuilds the database before every run, so in the pipeline this
   * is a no-op. Running the file on its own against yesterday's database is
   * not: the bills the last run opened are still there, and so are the
   * products it auto-created - and `products` is UNIQUE on (client_id, name),
   * which is exactly what "a product the till has never heard of" is testing.
   * A stale one makes the second run pass for the wrong reason.
   */
  const oldBills = await db.query(
    "SELECT id FROM orders WHERE client_id=? AND notes LIKE '%Sipariş no:%'", [CID]);
  for (const b of oldBills) {
    await db.exec('DELETE FROM order_payments WHERE order_id=?', [b.id]).catch(() => {});
    await db.exec('DELETE FROM order_discounts WHERE order_id=?', [b.id]).catch(() => {});
    await db.exec('DELETE FROM station_projection_items WHERE order_id=?', [b.id]).catch(() => {});
    await db.exec('DELETE FROM order_items WHERE order_id=?', [b.id]).catch(() => {});
    await db.exec('DELETE FROM print_jobs WHERE order_id=?', [b.id]).catch(() => {});
    await db.exec('DELETE FROM orders WHERE id=?', [b.id]).catch(() => {});
  }
  const intCat = await db.one("SELECT id FROM categories WHERE client_id=? AND name='Entegrasyon'", [CID]);
  if (intCat) {
    for (const p of await db.query('SELECT id FROM products WHERE client_id=? AND category_id=?', [CID, intCat.id])) {
      await db.exec('DELETE FROM product_stock WHERE product_id=?', [p.id]).catch(() => {});
      await db.exec('DELETE FROM product_recipes WHERE product_id=?', [p.id]).catch(() => {});
      await db.exec('DELETE FROM products WHERE id=?', [p.id]).catch(() => {});
    }
  }
  /*
   * And the day close, which is the one piece of leftover state that does not
   * look like leftover state. A checkpoint from a previous suite freezes the
   * business day, nextAdisyonNo refuses to issue a number, and every platform
   * order below fails with "no POS order was opened" - twenty red tests whose
   * real cause is one row in daily_closings written by whoever ran first. The
   * other suites all clear it; this one did not, so its result depended on the
   * order run-all.sh happened to use.
   */
  await db.exec('DELETE FROM daily_closings WHERE client_id IN (?,?)', [CID, OTHER]).catch(() => {});

  await db.setSetting('panel_url', 'http://127.0.0.1:9');   // never wait 30s on a real panel

  const catalog = require('../src/modules/catalog');
  await db.exec('DELETE FROM users WHERE client_id=? AND username=?', [CID, 'entegrator']);
  const uid = await catalog.saveUser(CID, {
    display_name: 'Entegrasyon Yöneticisi', username: 'entegrator', role: 'admin',
    pin: '7731', password: 'Entegre1234',
  }, null);

  /* A tiny menu whose names match the simulator's platform menu exactly, plus
     one that does not - automatic mapping has to be tested against a list that
     does NOT line up perfectly, because a real one never does. */
  let cat = await db.one("SELECT id FROM categories WHERE client_id=? AND name='Kebaplar' LIMIT 1", [CID]);
  if (!cat) {
    const id = await db.insert(
      'INSERT INTO categories (client_id, name, sort_order, is_active, use_in_pos, use_in_qr) VALUES (?,?,1,1,1,0)',
      [CID, 'Kebaplar']);
    cat = { id };
  }
  const prods = {};
  for (const [name, price] of [['Adana Kebap', 320], ['Kola 33cl', 45], ['Ayran', 25]]) {
    let p = await db.one('SELECT id FROM products WHERE client_id=? AND name=? LIMIT 1', [CID, name]);
    if (!p) {
      const id = await db.insert(
        `INSERT INTO products (client_id, category_id, name, price, cost_price, sort_order, is_active,
            use_in_pos, use_in_qr, vat_rate, track_stock) VALUES (?,?,?,?,0,1,1,1,0,10,0)`,
        [CID, cat.id, name, price]);
      p = { id };
    }
    prods[name] = p.id;
  }
  /* A printer, or every print job fails and "printed exactly once" would be
     vacuously true. */
  const printer = await db.one('SELECT id FROM printers WHERE client_id=? LIMIT 1', [CID]);
  if (!printer) {
    await db.exec(
      `INSERT INTO printers (client_id, name, type, ip_address, port, is_default, is_active)
       VALUES (?,?,?,?,?,1,1)`, [CID, 'Entegrasyon Test', 'network', '127.0.0.1', 9100]).catch(() => {});
  }
  return { uid, categoryId: cat.id, products: prods };
}

async function printJobsFor(orderId) {
  return db.query('SELECT * FROM print_jobs WHERE order_id=? ORDER BY id', [orderId]);
}

/**
 * Wait for the event queue to go quiet.
 *
 * A webhook answers as soon as it has STORED the event and kicks the worker on
 * the next tick - which is the behaviour being tested, and which means an
 * assertion written right after the POST is racing that worker. `drainEvents`
 * alone is not enough: if the background run has already claimed the row it is
 * 'processing', a second drain finds nothing to do and returns while the
 * adisyon is still half-built. So: drain, then wait until nothing is in
 * flight.
 */
let ingestRef = null;
async function settle(ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    await ingestRef.drainEvents(50);
    const busy = Number(await db.value(
      "SELECT COUNT(*) FROM np_int_events WHERE client_id=? AND status IN ('new','processing')", [CID]));
    if (!busy || Date.now() - t0 > ms) return;
    await new Promise(r => setTimeout(r, 40));
  }
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  await migrate();
  const fx = await fixture();
  TOKEN = await auth.issueToken({ cid: CID, uid: fx.uid, role: 'admin', name: 'Entegrasyon Yöneticisi', kind: 'pos' });

  const sim = require('../src/integrations/simulator');
  const mod = require('../src/modules/integrations');
  const svc = require('../src/integrations');
  const ingest = require('../src/integrations/ingest');
  ingestRef = ingest;
  const _poller = require('../src/integrations/poller');
  const statusMod = require('../src/integrations/status');
  const rate = require('../src/integrations/ratelimit');
  const cryptoMod = require('../src/integrations/crypto');

  /* The poller and the drain worker are stopped for the whole run: every test
     below drives them by hand, and a background sweep landing in the middle of
     an assertion is a flake nobody can reproduce. */
  svc.stop();
  sim.reset();

  console.log('\nNOKTApp POS - yemek platformu entegrasyonu\n');

  /* ===================== 1. KİMLİK BİLGİLERİ ========================= */

  await step('credentials are encrypted at rest and never come back out', async () => {
    const r = await api('POST', '/api/integrations/UBER_EATS_TGO/connection', {
      environment: 'simulator', supplier_id: 'SUP-1', provider_store_id: 'STORE-1',
      apiKey: 'AK-123456789', apiSecret: 'AS-987654321', acceptance_mode: 'PROVIDER_TABLET',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const row = await db.one('SELECT * FROM np_int_connections WHERE client_id=? AND provider=?', [CID, 'UBER_EATS_TGO']);
    assert.ok(row.credentials_enc.startsWith('v1.'), 'credentials are not in the v1 envelope');
    assert.ok(!row.credentials_enc.includes('AS-987654321'), 'the API secret is stored in clear text');
    assert.ok(row.cred_hint.includes('•'), 'the masked hint shows the raw value');
    assert.ok(!row.cred_hint.includes('AS-987654321'), 'the hint leaks the secret');

    const seen = await api('GET', '/api/integrations');
    const card = seen.providers.find(p => p.key === 'UBER_EATS_TGO');
    assert.ok(card.connected, 'the connection did not come back');
    const body = JSON.stringify(seen);
    assert.ok(!body.includes('AS-987654321') && !body.includes('AK-123456789'),
      'a secret was returned to the front end');
  });

  await step('an empty secret means "leave it alone", not "erase it"', async () => {
    await api('POST', '/api/integrations/UBER_EATS_TGO/connection', {
      environment: 'simulator', apiSecret: '', default_prep_minutes: 25 });
    const conn = await svc.connection(CID, 'UBER_EATS_TGO', 1);
    const creds = await svc.credentials(conn);
    assert.strictEqual(creds.apiSecret, 'AS-987654321', 'saving the form wiped the stored secret');
    assert.strictEqual(Number(conn.default_prep_minutes), 25);
  });

  await step('the envelope is authenticated: a tampered byte fails to open', async () => {
    const conn = await svc.connection(CID, 'UBER_EATS_TGO', 1);
    const parts = conn.credentials_enc.split('.');
    const cipher = Buffer.from(parts[3].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    cipher[0] ^= 0xff;
    const bad = [parts[0], parts[1], parts[2],
      cipher.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')].join('.');
    await assert.rejects(() => cryptoMod.decrypt(bad), /çözülemedi|okunamadı/i);
  });

  /* The nightly upload is a mysqldump and nothing else, so anything in
     np_settings leaves the building every night. The master key must not be
     one of those things, or every backup we hold ships the key beside the
     ciphertext it opens - which is the same as holding the secrets in clear. */
  await step('the master key lives in a file, never in the nightly dump', async () => {
    const keyFile = cryptoMod.keyFilePath();
    assert.ok(fs.existsSync(keyFile), 'no key file was written at ' + keyFile);
    assert.match(fs.readFileSync(keyFile, 'utf8').trim(), /^[0-9a-f]{64}$/,
      'the key file is not 32 bytes of hex');
    const inDb = await db.getSetting('integration_master_key');
    assert.strictEqual(inDb, null, 'the master key is still in np_settings and therefore in every backup');
    assert.strictEqual(cryptoMod.keySource(), 'file');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(keyFile).mode & 0o077, 0, 'the key file is readable by other users');
    }
  });

  /* An install made before the key file existed already has credentials
     encrypted with the row in np_settings. Moving the key must not orphan
     them: the same envelope has to keep opening afterwards. */
  await step('an existing install is migrated without losing its credentials', async () => {
    const keyFile = cryptoMod.keyFilePath();
    const saved = fs.readFileSync(keyFile, 'utf8').trim();
    const envelope = await cryptoMod.encrypt({ apiSecret: 'LEGACY-SECRET-1' });

    // roll the clock back: key in the database, no file, nothing cached
    fs.unlinkSync(keyFile);
    await db.setSetting('integration_master_key', saved);
    cryptoMod.reset();
    assert.strictEqual(cryptoMod.keySource(), 'db', 'keySource lied about where the key is');

    const back = await cryptoMod.decrypt(envelope);
    assert.strictEqual(back.apiSecret, 'LEGACY-SECRET-1', 'the migration could not open the old envelope');
    assert.ok(fs.existsSync(keyFile), 'the legacy key was not written out to a file');
    assert.strictEqual(fs.readFileSync(keyFile, 'utf8').trim(), saved, 'the migration changed the key');
    assert.strictEqual(await db.getSetting('integration_master_key'), null,
      'the legacy row survived the migration and still travels in backups');

    // and the connection saved at the top of this file still opens
    const conn = await svc.connection(CID, 'UBER_EATS_TGO', 1);
    const creds = await svc.credentials(conn);
    assert.strictEqual(creds.apiSecret, 'AS-987654321', 'a real connection was orphaned by the migration');
  });

  /* The banner this replaced fired on every healthy install because nobody
     sets a Windows environment variable on a restaurant PC. A warning that is
     always on is furniture. It may only appear when writing to disk failed. */
  await step('the screen warns about the key only when there is something wrong', async () => {
    const healthy = await api('GET', '/api/integrations');
    assert.strictEqual(healthy.master_key_source, 'file',
      'a healthy install would still show the encryption warning');
  });

  /* ======================= 2. TEK SİPARİŞ ============================ */

  let firstMirror = null;
  await step('a simulated Trendyol Go package becomes one ordinary paket adisyon', async () => {
    await mod.setEnabled(CID, 'UBER_EATS_TGO', true, fx.uid);
    sim.seedOrder('UBER_EATS_TGO', { externalOrderId: '2001', supplierId: 'SUP-1', providerStoreId: 'STORE-1' });
    const out = await mod.pollNow(CID, 'UBER_EATS_TGO');
    assert.ok(out.polled.length, 'nothing was polled');
    const rows = await db.query('SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id=?', [CID, '2001']);
    assert.strictEqual(rows.length, 1, 'expected one mirror row, got ' + rows.length);
    firstMirror = rows[0];
    assert.ok(firstMirror.order_id, 'no POS order was opened');
    const bill = await db.one('SELECT * FROM orders WHERE id=?', [firstMirror.order_id]);
    assert.strictEqual(bill.table_id, null, 'a delivery order must be a paket bill with no table');
    assert.ok(bill.adisyon_no > 0, 'the bill got no adisyon number from the existing counter');
    assert.ok(/Trendyol Go/.test(bill.notes), 'the bill does not say which platform it came from');
  });

  await step('nested modifiers, removals and their money land on the line', async () => {
    const items = await db.query(
      `SELECT i.*, p.name FROM order_items i JOIN products p ON p.id=i.product_id
        WHERE i.order_id=? AND i.is_deleted=0 ORDER BY i.id`, [firstMirror.order_id]);
    const adana = items.find(i => /Adana/.test(i.name));
    assert.ok(adana, 'the kebap line is missing');
    /* Ayran is not mapped yet, so it rides on the parent line as text AND as
       money: 320 + 25 = 345, and "Çıkar: Acısız" must be readable. */
    assert.strictEqual(Number(adana.unit_price), 345, 'the modifier price was lost, unit price ' + adana.unit_price);
    assert.ok(/Ayran/.test(adana.note), 'the modifier is not on the line note: ' + adana.note);
    assert.ok(/Çıkar: Acısız/.test(adana.note), 'a removed ingredient reads as an addition: ' + adana.note);
  });

  await step('the delivery charge is a line, so the bill equals the platform total', async () => {
    const items = await db.query(
      `SELECT i.*, p.name FROM order_items i JOIN products p ON p.id=i.product_id
        WHERE i.order_id=? AND i.is_deleted=0`, [firstMirror.order_id]);
    const fee = items.find(i => /Teslimat/.test(i.name));
    assert.ok(fee, 'no delivery charge line');
    assert.strictEqual(Number(fee.line_total), 24.9);
    const bill = await db.one('SELECT grand_total FROM orders WHERE id=?', [firstMirror.order_id]);
    // 345 (kebap incl. ayran) + 2x45 (kola) + 24.90 delivery
    assert.strictEqual(Number(bill.grand_total), 459.9, 'bill total ' + bill.grand_total);
    assert.strictEqual(Number(firstMirror.provider_total), 459.9, 'mirror total disagrees with the platform');
  });

  await step('a prepaid platform order is never asked to pay again', async () => {
    const pays = await db.query('SELECT * FROM order_payments WHERE order_id=? AND is_deleted=0', [firstMirror.order_id]);
    assert.strictEqual(pays.length, 1, 'expected exactly one payment row, got ' + pays.length);
    assert.strictEqual(pays[0].payment_channel, 'entegrasyon');
    assert.strictEqual(Number(pays[0].amount), 459.9);
    const bill = await db.one('SELECT status FROM orders WHERE id=?', [firstMirror.order_id]);
    assert.strictEqual(bill.status, 'closed', 'a fully prepaid bill is still open at the till');
  });

  await step('the tablet acceptance mode prints once, to the kitchen and to the counter', async () => {
    const m = await db.one('SELECT * FROM np_int_orders WHERE id=?', [firstMirror.id]);
    assert.strictEqual(m.status, 'ACCEPTED', 'a tablet-mode order should arrive accepted, got ' + m.status);
    assert.ok(m.accept_print_job_id, 'no print job was claimed');
    const jobs = await printJobsFor(m.order_id);
    assert.ok(jobs.length >= 1, 'nothing was queued to a printer');
    const receipts = jobs.filter(j => j.job_type === 'receipt');
    assert.strictEqual(receipts.length, 1, 'expected one paket fişi, got ' + receipts.length);
  });

  /* ================= 3. AYNI OLAY, DEFALARCA ========================= */

  await step('the same package polled five more times makes no second bill and no second slip', async () => {
    const before = (await printJobsFor(firstMirror.order_id)).length;
    for (let i = 0; i < 5; i++) await mod.pollNow(CID, 'UBER_EATS_TGO');
    const rows = await db.query('SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id=?', [CID, '2001']);
    assert.strictEqual(rows.length, 1, 'the same order opened ' + rows.length + ' mirrors');
    const bills = await db.value(
      `SELECT COUNT(DISTINCT o.id) FROM orders o
         JOIN np_int_orders m ON m.order_id=o.id AND m.client_id=o.client_id
        WHERE o.client_id=? AND m.external_order_id='2001'`, [CID]);
    assert.strictEqual(Number(bills), 1, 'the same order opened ' + bills + ' adisyons');
    const still = await db.one('SELECT order_id FROM np_int_orders WHERE id=?', [firstMirror.id]);
    assert.strictEqual(Number(still.order_id), Number(firstMirror.order_id),
      'a repeated event re-pointed the mirror at a different bill');
    assert.strictEqual((await printJobsFor(firstMirror.order_id)).length, before,
      'a repeated provider event printed again');
  });

  await step('printing is claimed, not merely checked: ten racing callers print once', async () => {
    const m = await db.one('SELECT * FROM np_int_orders WHERE id=?', [firstMirror.id]);
    const conn = await svc.connection(CID, 'UBER_EATS_TGO', 1);
    const before = (await printJobsFor(m.order_id)).length;
    await Promise.all(Array.from({ length: 10 }, () => ingest.printOnce(CID, conn, m, 'accept')));
    assert.strictEqual((await printJobsFor(m.order_id)).length, before, 'the print claim is not atomic');
  });

  await step('a webhook replayed byte for byte is a 200 that does nothing', async () => {
    await api('POST', '/api/integrations/YEMEKSEPETI/connection', {
      environment: 'simulator', provider_store_id: 'YS-1', username: 'plugin', password: 'plugin-pass',
      acceptance_mode: 'POS_DIRECT' });
    await mod.setEnabled(CID, 'YEMEKSEPETI', true, fx.uid);
    const pkg = sim.seedOrder('YEMEKSEPETI', {
      externalOrderId: '3001', providerStoreId: 'YS-1', providerStatus: 'created', isPrepaid: false,
      paymentType: 'CASH_ON_DELIVERY', deliveryCharge: 0 });
    const first = await api('POST', '/api/integrations/webhook/YEMEKSEPETI', pkg, null);
    assert.strictEqual(first.status, 200, JSON.stringify(first));
    assert.strictEqual(first.duplicate, false);
    const again = await api('POST', '/api/integrations/webhook/YEMEKSEPETI', pkg, null);
    assert.strictEqual(again.status, 200, 'a replay must not be an error');
    assert.strictEqual(again.duplicate, true, 'the replay was not recognised');
    await settle();
    const rows = await db.query('SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id=?', [CID, '3001']);
    assert.strictEqual(rows.length, 1, 'the replay opened a second order');
    const evs = await db.query("SELECT * FROM np_int_events WHERE client_id=? AND external_order_id='3001'", [CID]);
    assert.strictEqual(evs.length, 1, 'the replay was stored twice');
  });

  /* ================ 4. KABUL, RET, İPTAL ============================= */

  let ysMirror = null;
  await step('a direct-mode order waits for a person and is not paid or printed yet', async () => {
    ysMirror = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='3001'", [CID]);
    assert.ok(ysMirror.order_id, 'the webhook order never reached an adisyon');
    assert.strictEqual(ysMirror.status, 'RECEIVED', 'POS_DIRECT must not self-accept, got ' + ysMirror.status);
    assert.strictEqual(ysMirror.accept_print_job_id, null, 'an unaccepted order already printed');
    const pays = await db.query('SELECT * FROM order_payments WHERE order_id=? AND is_deleted=0', [ysMirror.order_id]);
    assert.strictEqual(pays.length, 0, 'a pay-at-door order was marked paid');
  });

  await step('accepting sends a prep time, prints once and leaves the money owing', async () => {
    const r = await api('POST', `/api/integrations/orders/${ysMirror.id}/accept`, { prep_minutes: 30 });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const m = await db.one('SELECT * FROM np_int_orders WHERE id=?', [ysMirror.id]);
    assert.strictEqual(m.status, 'ACCEPTED');
    assert.strictEqual(Number(m.prep_minutes), 30);
    assert.ok(m.accept_print_job_id, 'acceptance did not print');
    const accept = sim.calls('YEMEKSEPETI', 'accept');
    assert.strictEqual(accept.length, 1, 'the platform was told ' + accept.length + ' times');
    assert.strictEqual(accept[0].args.prepMinutes, 30, 'the prep time never reached the platform');
    const bill = await db.one('SELECT status, grand_total FROM orders WHERE id=?', [m.order_id]);
    assert.strictEqual(bill.status, 'open', 'a pay-at-door order was closed without money');
    assert.ok(Number(bill.grand_total) > 0);
  });

  await step('repeating a state does nothing; walking backwards is refused', async () => {
    /* Pressing Onayla twice is not an error - it is a person checking - and it
       must not print a second slip or take the money again. */
    const again = await api('POST', `/api/integrations/orders/${ysMirror.id}/accept`, {});
    assert.strictEqual(again.status, 200, JSON.stringify(again));
    assert.strictEqual(again.result.changed, false, 'accepting twice did the work twice');
    const jobs = await printJobsFor(ysMirror.order_id);
    assert.strictEqual(jobs.filter(j => j.job_type === 'receipt').length, 1,
      'accepting twice printed twice');

    assert.strictEqual(statusMod.canTransition('READY', 'ACCEPTED').ok, false);
    assert.strictEqual(statusMod.canTransition('DELIVERED', 'CANCELLED').ok, false,
      'a delivered order can still be cancelled');
    assert.strictEqual(statusMod.canTransition('ACCEPTED', 'ACCEPTED').noop, true,
      'a repeated state should be a no-op success');
    assert.strictEqual(statusMod.canTransition('RECEIVED', 'DELIVERED').ok, false,
      'an order jumped straight from new to delivered');
  });

  await step('ready then dispatched are allowed, and preparing after ready is not', async () => {
    assert.strictEqual((await api('POST', `/api/integrations/orders/${ysMirror.id}/ready`, {})).status, 200);
    const bad = await api('POST', `/api/integrations/orders/${ysMirror.id}/preparing`, {});
    assert.strictEqual(bad.status, 409, 'READY -> PREPARING was accepted');
    assert.strictEqual((await api('POST', `/api/integrations/orders/${ysMirror.id}/dispatched`, {})).status, 200);
  });

  await step('cancelling after acceptance reverses the bill the way the till does', async () => {
    const pkg = sim.seedOrder('UBER_EATS_TGO', {
      externalOrderId: '2002', supplierId: 'SUP-1', providerStoreId: 'STORE-1' });
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2002'", [CID]);
    assert.strictEqual(m.status, 'ACCEPTED');
    const beforeJobs = (await printJobsFor(m.order_id)).length;

    sim.setProviderStatus('UBER_EATS_TGO', '2002', pkg.externalPackageId, 'Cancelled');
    await mod.pollNow(CID, 'UBER_EATS_TGO');

    const after = await db.one('SELECT * FROM np_int_orders WHERE id=?', [m.id]);
    assert.strictEqual(after.status, 'CANCELLED', 'the cancellation was not applied, status ' + after.status);
    const bill = await db.one('SELECT * FROM orders WHERE id=?', [m.order_id]);
    assert.strictEqual(Number(bill.is_deleted), 1, 'the bill is still on the books');
    assert.strictEqual(bill.status, 'cancelled');
    const pays = await db.query('SELECT * FROM order_payments WHERE order_id=?', [m.order_id]);
    assert.ok(pays.every(p => Number(p.is_deleted) === 1), 'the prepaid money is still counted as takings');
    const logRow = await db.one(
      'SELECT * FROM order_delete_logs WHERE order_id=? ORDER BY id DESC LIMIT 1', [m.order_id]);
    assert.ok(logRow, 'no delete log - the cancellation left no audit trail');
    const tickets = await db.query(
      'SELECT * FROM station_projection_items WHERE client_id=? AND order_id=?', [CID, m.order_id]);
    assert.ok(tickets.every(t => t.station_status === 'cancelled'), 'the kitchen was not told to stop');
    const jobs = await printJobsFor(m.order_id);
    assert.strictEqual(jobs.length, beforeJobs + 1, 'expected exactly one cancellation notice');
    assert.ok(after.cancel_print_job_id, 'the cancellation print was not claimed');
    /*
     * And the notice has to say WHAT was cancelled. deleteBill marks every line
     * deleted and the receipt renderer (rightly) refuses to print a deleted
     * line, so a notice built after the withdrawal comes out with a header, a
     * zero and nothing else - which tells the kitchen nothing.
     */
    const notice = Buffer.from(jobs[jobs.length - 1].content, 'base64').toString('latin1');
    assert.ok(/IPTAL/i.test(notice), 'the cancellation notice is not headed as one');
    assert.ok(/Adana|Kola/i.test(notice),
      'the cancellation notice lists no products - the kitchen cannot tell what to stop');

    /* And a repeat of the cancellation prints nothing more. */
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    assert.strictEqual((await printJobsFor(m.order_id)).length, jobs.length,
      'a repeated cancellation printed a second notice');
  });

  await step('a rejection before acceptance never reaches the kitchen printer', async () => {
    sim.seedOrder('YEMEKSEPETI', { externalOrderId: '3002', providerStoreId: 'YS-1',
      providerStatus: 'created', isPrepaid: false, deliveryCharge: 0 });
    await api('POST', '/api/integrations/webhook/YEMEKSEPETI',
      sim.detail('YEMEKSEPETI', '3002', String(Number('3002') + 500000)), null);
    await settle();
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='3002'", [CID]);
    assert.strictEqual(m.status, 'RECEIVED');
    const r = await api('POST', `/api/integrations/orders/${m.id}/reject`,
      { reason: 'Mutfak çok yoğun', reason_code: 'KITCHEN_BUSY' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const after = await db.one('SELECT * FROM np_int_orders WHERE id=?', [m.id]);
    assert.strictEqual(after.status, 'REJECTED');
    assert.strictEqual(after.reject_reason, 'KITCHEN_BUSY');
    assert.strictEqual(after.cancel_print_job_id, null,
      'a rejected order printed a cancellation the kitchen never needed');
    const bill = await db.one('SELECT is_deleted FROM orders WHERE id=?', [after.order_id]);
    assert.strictEqual(Number(bill.is_deleted), 1, 'a rejected order is still an open bill');
  });

  await step('partial line cancellation uses the till\'s own void path', async () => {
    const _pkg = sim.seedOrder('UBER_EATS_TGO', { externalOrderId: '2003', supplierId: 'SUP-1', providerStoreId: 'STORE-1' });
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2003'", [CID]);
    const conn = await svc.connection(CID, 'UBER_EATS_TGO', 1);
    const before = Number((await db.one('SELECT grand_total FROM orders WHERE id=?', [m.order_id])).grand_total);
    await ingest.cancelLine(CID, conn, m, 'L2', { reason: 'Kolamız kalmadı', actor: 'test' });
    const after = Number((await db.one('SELECT grand_total FROM orders WHERE id=?', [m.order_id])).grand_total);
    assert.ok(after < before, 'the total did not fall: ' + before + ' -> ' + after);
    const ev = await db.one(
      'SELECT * FROM order_item_cancel_events WHERE order_id=? ORDER BY id DESC LIMIT 1', [m.order_id]);
    assert.ok(ev, 'the cancel ledger the Z report counts from was not written');
    const line = await db.one("SELECT * FROM np_int_order_items WHERE int_order_id=? AND external_item_id='L2'", [m.id]);
    assert.strictEqual(line.status, 'CANCELLED');
    /* It was a prepaid, closed bill: the money has to come back and go out
       again at the new figure, and both movements have to be visible. */
    const pays = await db.query('SELECT * FROM order_payments WHERE order_id=? ORDER BY id', [m.order_id]);
    assert.ok(pays.some(p => p.voided_at), 'the original prepayment was never reversed');
    const live = pays.filter(p => !p.voided_at && !Number(p.is_deleted));
    assert.strictEqual(live.length, 1, 'the bill should carry exactly one live payment');
    assert.strictEqual(Number(live[0].amount), after, 'the re-charge does not match the new total');
    const bill = await db.one('SELECT status FROM orders WHERE id=?', [m.order_id]);
    assert.strictEqual(bill.status, 'closed', 'the bill was left open after a partial cancellation');
  });

  /* ==================== 5. KAYNAK VE DURUM =========================== */

  await step('a Galaxy order is kept as Galaxy and not folded into Trendyol Go', async () => {
    sim.seedOrder('UBER_EATS_TGO', { externalOrderId: '2100', supplierId: 'SUP-1',
      providerStoreId: 'STORE-1', sourceApplication: 'Galaxy' });
    sim.seedOrder('UBER_EATS_TGO', { externalOrderId: '2101', supplierId: 'SUP-1',
      providerStoreId: 'STORE-1', sourceApplication: 'Trendyol' });
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const g = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2100'", [CID]);
    const t = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2101'", [CID]);
    assert.strictEqual(g.source_application, 'Galaxy', 'the GetirYemek source was lost');
    assert.strictEqual(t.source_application, 'Trendyol');
    const bill = await db.one('SELECT notes FROM orders WHERE id=?', [g.order_id]);
    assert.ok(/Galaxy/.test(bill.notes), 'the slip does not say the order came from GetirYemek');
  });

  await step('an unknown provider status changes nothing and says so', async () => {
    const pkg = sim.seedOrder('UBER_EATS_TGO', { externalOrderId: '2200', supplierId: 'SUP-1', providerStoreId: 'STORE-1' });
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const before = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2200'", [CID]);
    sim.setProviderStatus('UBER_EATS_TGO', '2200', pkg.externalPackageId, 'SomethingNewTheyAddedOnTuesday');
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const after = await db.one('SELECT * FROM np_int_orders WHERE id=?', [before.id]);
    assert.strictEqual(after.status, before.status, 'an unrecognised status moved the order');
    assert.strictEqual(after.provider_status, 'SomethingNewTheyAddedOnTuesday',
      'the platform word was not preserved');
    const warn = await db.one(
      "SELECT * FROM np_int_logs WHERE client_id=? AND message LIKE '%Bilinmeyen platform durumu%' ORDER BY id DESC LIMIT 1",
      [CID]);
    assert.ok(warn, 'nobody was told about a status we do not understand');
  });

  /*
   * THE REAL TRENDYOL GO CONTRACT, pinned.
   *
   * Everything asserted here was read from developers.tgoapps.com, section
   * "8. Uber Eats Trendyol Go - Yemek Entegrasyonu". It is pinned in a test
   * because the failure mode it guards against is silent: somebody edits an
   * endpoint or a field name to make a test pass, and the integration keeps
   * working perfectly against our own simulator while never having worked
   * against Trendyol at all. If the platform changes its contract this test
   * SHOULD fail, and the fix is to re-read the documentation - not to relax
   * the assertion.
   */
  await step('the Trendyol Go endpoints are the documented ones, not invented', async () => {
    const tgo = require('../src/integrations/adapters/tgo');
    const P = tgo.KNOWN_PATHS;
    const base = '/integrator/order/meal/suppliers/{supplierId}/packages';
    assert.strictEqual(P.fetchOrders, base);
    assert.strictEqual(P.getOrder, base + '/{packageId}');
    assert.strictEqual(P.accept, base + '/picked');
    assert.strictEqual(P.markReady, base + '/invoiced');
    assert.strictEqual(P.markDispatched, base + '/{packageId}/manual-shipped');
    assert.strictEqual(P.markDelivered, base + '/{packageId}/manual-delivered');
    assert.strictEqual(P.reject, base + '/unsupplied');
    assert.strictEqual(P.cancel, base + '/unsupplied');
  });

  await step('a request without a User-Agent is a 403, so one is always sent', async () => {
    const { TgoAdapter } = require('../src/integrations/adapters/tgo');
    const a = new TgoAdapter(
      { provider: 'UBER_EATS_TGO', environment: 'production', supplier_id: '107385' },
      { apiKey: 'k', apiSecret: 's', supplierId: '107385' });
    const h = a.headers();
    /* "{supplierId} - {integrator}", integrator alphanumeric and <= 30 */
    assert.ok(/^107385 - [A-Za-z0-9]{1,30}$/.test(h['User-Agent']),
      'User-Agent is not in the documented form: ' + h['User-Agent']);
    assert.ok(h['x-agentname'], 'x-agentname missing - the header table lists it as required');
    assert.ok(h['x-executor-user'], 'x-executor-user missing - it lands in their audit trail');
    assert.strictEqual(h.Authorization, 'Basic ' + Buffer.from('k:s').toString('base64'),
      'authorization is basic over apiKey:apiSecretKey');
  });

  await step('the package id is the 64 character `id`, not the order id', async () => {
    /*
     * Every action - picked, invoiced, manual-shipped, manual-delivered,
     * unsupplied - is addressed by the package id. Reading `orderId` into it
     * makes every status push 404 while the polling still looks healthy,
     * which is the worst shape a bug can have here.
     */
    const { TgoAdapter } = require('../src/integrations/adapters/tgo');
    const a = new TgoAdapter({ provider: 'UBER_EATS_TGO', environment: 'simulator' }, {});
    const n = a.normalize({
      id: '4dc2e9573983ce9fb97aa905df33f06fc3717b775a1d8391de1ca3750a9de6a4',
      orderId: '1001199521762', orderNumber: '1199521762', storeId: 153, supplierId: 107385,
      packageStatus: 'Created', deliveryType: 'STORE', storePickupSelected: false,
      totalPrice: 602.7, totalDeliveryPrice: 15.99,
      payment: { paymentType: 'PAY_WITH_ON_DELIVERY', mealCard: null, onDelivery: 'CASH' },
      customer: { firstName: 'Oms', lastName: 'M' },
      address: { address1: 'Gündoğdu Koleji Yanı', neighborhood: 'Caferağa', district: 'Kadıköy',
                 city: 'İstanbul', apartmentNumber: '9', floor: '2', doorNumber: '2',
                 phone: '5554443322', addressDescription: 'Kadıköy - ISA2', pinCode: '673985557' },
      customerNote: 'Servis İstiyorum',
      userInformation: { appName: 'Galaxy' },
      packageCreationDate: 1783520347138, packageModificationDate: 1783520347146,
      lines: [{
        price: 290, unitSellingPrice: 145, productId: 203695, name: 'Big King Menü',
        items: [{ packageItemId: '1000008723596', lineItemId: 1, isCancelled: false },
                { packageItemId: '1000008723597', lineItemId: 2, isCancelled: false }],
        modifierProducts: [{ name: 'Patates', price: 30, productId: 318489, modifierGroupId: 40826 }],
        extraIngredients: [], removedIngredients: ['Soğan'],
      }],
    });
    assert.strictEqual(n.externalPackageId,
      '4dc2e9573983ce9fb97aa905df33f06fc3717b775a1d8391de1ca3750a9de6a4');
    assert.strictEqual(n.externalOrderId, '1001199521762');
    /* quantity is the number of UNITS in the line, not 1 */
    assert.strictEqual(n.lines[0].qty, 2, 'a two-unit line was read as one');
    assert.strictEqual(n.lines[0].unitPrice, 145, 'the line price was used as the unit price');
    assert.deepStrictEqual(n.lines[0].packageItemIds, ['1000008723596', '1000008723597'],
      'the unit ids are lost, so a partial cancellation cannot be addressed');
    /* PAY_WITH_ON_DELIVERY means the courier collects */
    assert.strictEqual(n.isPrepaid, false, 'a pay-at-the-door order was read as prepaid');
    assert.strictEqual(n.paymentType, 'CASH');
    /* the address is built from eight fields, not found in one */
    assert.ok(/Gündoğdu/.test(n.customer.address) && /Kadıköy/.test(n.customer.address)
      && /D:2/.test(n.customer.address), 'the address was not assembled: ' + n.customer.address);
    assert.strictEqual(n.customer.phone, '5554443322', 'the guest phone is on the address object');
    assert.strictEqual(n.pinCode, '673985557');
    /* appName Galaxy is GetirYemek by Uber Eats, and must survive verbatim */
    assert.strictEqual(n.sourceApplication, 'Galaxy');
    assert.strictEqual(n.deliveryCharge, 15.99);
    assert.strictEqual(n.fulfillmentType, 'RESTAURANT_COURIER', 'deliveryType STORE is our own courier');
    /* removed ingredients reach the kitchen as "Çıkar: ..." */
    assert.ok(n.lines[0].modifiers.some(m => m.removed && m.name === 'Soğan'),
      'a removed ingredient did not survive normalisation');
    /* epoch milliseconds become a stored timestamp */
    assert.ok(/^\d{4}-\d{2}-\d{2} /.test(n.providerCreatedAt), 'epoch ms was not converted');
  });

  await step('a platform-courier order is never told WE shipped it', async () => {
    /*
     * manual-shipped and manual-delivered belong to a restaurant carrying its
     * own food. On a platform-courier order their courier is moving it and
     * their app is telling the guest so; sending those would be us claiming
     * a delivery we did not make, in the customer's own app.
     *
     * The adapter has always had this guard. For one release nothing passed
     * it `deliveryType`, so it never fired - which is the kind of bug that
     * only shows up as an angry e-mail from a platform.
     */
    const { TgoAdapter } = require('../src/integrations/adapters/tgo');
    const a = new TgoAdapter(
      { provider: 'UBER_EATS_TGO', environment: 'production', supplier_id: '1' },
      { apiKey: 'k', apiSecret: 's', supplierId: '1' });
    const go = await a.markDispatched({ externalPackageId: 'P1', deliveryType: 'GO' });
    assert.strictEqual(go.ok, true);
    assert.strictEqual(go.skipped, true, 'a platform-courier order was reported as shipped by us');
    const own = await a.markDelivered({ externalPackageId: 'P1', deliveryType: 'GO' });
    assert.strictEqual(own.skipped, true, 'a platform-courier order was reported as delivered by us');
  });

  await step('the till cancel reason becomes one the platform accepts', async () => {
    const { TgoAdapter, CANCEL_REASONS } = require('../src/integrations/adapters/tgo');
    const a = new TgoAdapter({ provider: 'UBER_EATS_TGO', environment: 'simulator' }, {});
    const seen = [];
    a.action = (op, args) => { seen.push(args.body); return Promise.resolve({ ok: true }); };

    a.unsupply({ externalPackageId: 'P1', reasonCode: 'MUTFAK', deliveryType: 'STORE' });
    assert.strictEqual(seen[0].reasonId, 623, 'kitchen delay did not map to 623');

    /* 624 and 626 are model 1 only - a restaurant on the platform's courier
       cannot claim "no courier" and the platform refuses it */
    a.unsupply({ externalPackageId: 'P1', reasonCode: 'KURYE_YOK', deliveryType: 'STORE' });
    assert.strictEqual(seen[1].reasonId, 624, 'own-courier "no courier" did not map to 624');
    a.unsupply({ externalPackageId: 'P1', reasonCode: 'KURYE_YOK', deliveryType: 'GO' });
    assert.notStrictEqual(seen[2].reasonId, 624,
      'a platform-courier order was allowed to claim it had no courier');
    assert.ok(CANCEL_REASONS[seen[2].reasonId], 'the fallback is not a reason the platform accepts');

    /* an unknown code must still be a VALID id, never passed through raw */
    a.unsupply({ externalPackageId: 'P1', reasonCode: 'BILINMEYEN_SEBEP' });
    assert.ok(CANCEL_REASONS[seen[3].reasonId], 'an unknown till reason leaked through as-is');
  });

  await step('a full cancellation names every package item, not none', async () => {
    /*
     * The platform expresses a full cancellation as every packageItemId in
     * itemIdList and a partial one as a subset. Sending an empty list is
     * asking it to cancel nothing.
     */
    sim.seedOrder('UBER_EATS_TGO', { externalOrderId: '2900', supplierId: 'SUP-1',
      providerStoreId: 'STORE-1', deliveryCharge: 0 });
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2900'", [CID]);
    const items = await db.query(
      "SELECT external_item_id FROM np_int_order_items WHERE client_id=? AND int_order_id=? AND role='item'",
      [CID, m.id]);
    assert.ok(items.length >= 1, 'the mirror kept no item ids to cancel with');

    const { TgoAdapter } = require('../src/integrations/adapters/tgo');
    const a = new TgoAdapter({ provider: 'UBER_EATS_TGO', environment: 'simulator' }, {});
    let body = null;
    a.action = (op, args) => { body = args.body; return Promise.resolve({ ok: true }); };
    a.unsupply({ externalPackageId: m.external_package_id,
      itemIdList: items.map(i => i.external_item_id), reasonCode: 'MUTFAK' });
    assert.ok(Array.isArray(body.itemIdList) && body.itemIdList.length === items.length,
      'the cancellation named ' + (body.itemIdList || []).length + ' of ' + items.length + ' items');
  });

  await step('only the restaurant cancel reasons the platform accepts are sent', async () => {
    const tgo = require('../src/integrations/adapters/tgo');
    /* 621-627 are ours to send. The 600s and 640s they send US - courier,
       fraud, address - are theirs, and quoting one back is refused. */
    for (const id of [621, 622, 623, 624, 626, 627]) {
      assert.ok(tgo.CANCEL_REASONS[id], 'restaurant reason ' + id + ' is missing');
    }
    for (const id of [601, 604, 642, 681]) {
      assert.ok(!tgo.CANCEL_REASONS[id], id + ' is a platform reason and must not be sendable');
    }
    assert.ok(tgo.CANCEL_REASONS[tgo.DEFAULT_CANCEL_REASON], 'the fallback reason is not a valid one');
  });

  await step('status mapping covers each platform vocabulary onto the same eight', async () => {
    /*
     * TGO's vocabulary is the REAL one now, read from developers.tgoapps.com:
     * Created, Picking, Invoiced, Shipped, Delivered, Cancelled, UnSupplied.
     * The names this used to assert - Picked, Prepared - were our reading of
     * the platform before the documentation could be read, and asserting them
     * would now be asserting the guess over the contract.
     *
     * Note what Picking and Invoiced mean: they are OUR acknowledgements, not
     * the kitchen's progress. Picking is "we accepted it", Invoiced is "we
     * finished it". There is no state for "cooking".
     */
    const tgo = require('../src/integrations/adapters/tgo');
    assert.strictEqual(tgo.DEFAULT_STATUS_MAP.Created, 'RECEIVED');
    assert.strictEqual(tgo.DEFAULT_STATUS_MAP.Picking, 'ACCEPTED');
    assert.strictEqual(tgo.DEFAULT_STATUS_MAP.Invoiced, 'READY');
    assert.strictEqual(tgo.DEFAULT_STATUS_MAP.Shipped, 'DISPATCHED');
    assert.strictEqual(tgo.DEFAULT_STATUS_MAP.Delivered, 'DELIVERED');
    assert.strictEqual(tgo.DEFAULT_STATUS_MAP.UnSupplied, 'REJECTED',
      'UnSupplied is the restaurant cancelling; Cancelled is somebody else');
    assert.strictEqual(tgo.DEFAULT_STATUS_MAP.Cancelled, 'CANCELLED');
    const ys = require('../src/integrations/adapters/yemeksepeti');
    assert.strictEqual(ys.DEFAULT_STATUS_MAP['picked up'], 'DISPATCHED');
    assert.strictEqual(ys.DEFAULT_STATUS_MAP.prepared, 'READY');
    const mg = require('../src/integrations/adapters/migros');
    assert.strictEqual(mg.DEFAULT_STATUS_MAP.HANDOVER, 'DISPATCHED');
    for (const s of statusMod.STATUSES) assert.ok(statusMod.LABELS[s], 'no Turkish label for ' + s);
  });

  /* ============== 6. KAMPANYA, KUPON, ÖDEME TÜRÜ ==================== */

  await step('coupons and promotions become one discount row the reports can see', async () => {
    sim.seedOrder('UBER_EATS_TGO', {
      externalOrderId: '2300', supplierId: 'SUP-1', providerStoreId: 'STORE-1',
      couponTotal: 50, promotionTotal: 30, deliveryCharge: 0,
      promotions: [{ name: 'Hoş geldin kuponu', amount: 50 }, { name: 'İkinci ürüne %30', amount: 30 }],
    });
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2300'", [CID]);
    assert.strictEqual(Number(m.coupon_total), 50);
    assert.strictEqual(Number(m.promotion_total), 30);
    const d = await db.one("SELECT * FROM order_discounts WHERE order_id=? AND source<>'line'", [m.order_id]);
    assert.ok(d, 'no discount row was written');
    assert.strictEqual(Number(d.discount_value), 80, 'the coupon and the promotion did not add up');
    assert.ok(/kupon/i.test(d.reason), 'the discount does not name the campaign: ' + d.reason);
    const bill = await db.one('SELECT total, discount_total, grand_total FROM orders WHERE id=?', [m.order_id]);
    assert.strictEqual(Number(bill.discount_total), 80);
    assert.strictEqual(Number(bill.grand_total), Number(bill.total) - 80, 'recalc did not apply the discount');
    const promos = JSON.parse(m.promotions_json);
    assert.strictEqual(promos.length, 2, 'the individual campaigns were thrown away');
  });

  await step('a meal-card order at the door is a yemek_karti payment, not a card one', async () => {
    assert.strictEqual(ingest.methodFor('MULTINET'), 'yemek_karti');
    assert.strictEqual(ingest.methodFor('SODEXO_MEAL'), 'yemek_karti');
    assert.strictEqual(ingest.methodFor('CASH_ON_DELIVERY'), 'nakit');
    assert.strictEqual(ingest.methodFor('ONLINE_CARD'), 'kredi_karti');
    const tgo = require('../src/integrations/adapters/tgo');
    assert.strictEqual(tgo.prepaid('CASH_ON_DELIVERY'), false, 'cash at the door read as prepaid');
    assert.strictEqual(tgo.prepaid('ONLINE_CARD'), true);
  });

  await step('pickup and courier types are told apart', async () => {
    const tgo = require('../src/integrations/adapters/tgo');
    assert.strictEqual(tgo.fulfilment('SELF_PICKUP'), 'PICKUP');
    assert.strictEqual(tgo.fulfilment('STORE_DELIVERY'), 'RESTAURANT_COURIER');
    assert.strictEqual(tgo.fulfilment('MARKETPLACE'), 'PLATFORM_COURIER');
    sim.seedOrder('UBER_EATS_TGO', { externalOrderId: '2400', supplierId: 'SUP-1', providerStoreId: 'STORE-1',
      fulfillmentType: 'SELF_PICKUP', deliveryCharge: 0 });
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2400'", [CID]);
    assert.strictEqual(m.fulfillment_type, 'PICKUP');
    const bill = await db.one('SELECT notes FROM orders WHERE id=?', [m.order_id]);
    assert.ok(/gel-al/i.test(bill.notes), 'the slip does not tell the counter it is a pickup');
  });

  /* ================ 7. KİŞİSEL VERİ (KVKK) ========================== */

  await step('customer data is stored masked', async () => {
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2001'", [CID]);
    assert.ok(!/K\.$/.test('') && m.customer_label, 'the customer label is empty');
    assert.ok(m.customer_phone.includes('•'), 'the phone number is stored in full: ' + m.customer_phone);
    assert.ok(!/\d{4}$/.test(m.customer_phone.replace(/[^0-9]/g, '').slice(0, -2)) || m.customer_phone.includes('•'),
      'the phone number is not masked');
    const bill = await db.one('SELECT notes FROM orders WHERE id=?', [m.order_id]);
    assert.ok(!/0532 \*\*\* \*\* 41/.test(bill.notes) || bill.notes.includes('•'),
      'the unmasked phone reached the bill');
  });

  await step('the log redacts personal data even when the payload carries it', async () => {
    const httpc = require('../src/integrations/http');
    const red = httpc.redactBody({ customerName: 'Ayşe Kaya', address: 'Bağdat Cad. 12/4', total: 100,
      lines: [{ name: 'Adana', phone: '05321234567' }] });
    assert.strictEqual(red.customerName, '***');
    assert.strictEqual(red.address, '***');
    assert.strictEqual(red.total, 100, 'redaction destroyed a figure support needs');
    assert.strictEqual(red.lines[0].phone, '***');
    const safe = httpc.safeHeaders({ Authorization: 'Basic abcdef', 'X-Api-Key': 'k', Accept: 'application/json' });
    assert.strictEqual(safe.Authorization, '***');
    assert.strictEqual(safe['X-Api-Key'], '***');
    assert.strictEqual(safe.Accept, 'application/json');
  });

  /* ================== 8. ÇEKME, İMLEÇ, HIZ ========================== */

  await step('the poller keeps a cursor and overlaps it by two minutes', async () => {
    const cur = await db.one("SELECT * FROM np_int_cursors WHERE client_id=? AND provider='UBER_EATS_TGO'", [CID]);
    assert.ok(cur, 'no cursor was stored');
    assert.ok(cur.last_modified_at, 'the cursor never advanced');
    assert.ok(cur.last_ok_at, 'a successful poll was not recorded');
    assert.strictEqual(Number(cur.consecutive_errors), 0);
    assert.strictEqual(require('../src/integrations/poller').OVERLAP_MS, 120000);
  });

  await step('an order modified inside the overlap window is fetched again, not missed', async () => {
    const pkg = sim.seedOrder('UBER_EATS_TGO', { externalOrderId: '2500', supplierId: 'SUP-1', providerStoreId: 'STORE-1' });
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    /* Wind the cursor forward past the package, the way a clock skew would.
       Without the overlap the next poll would never see the change. */
    await db.exec("UPDATE np_int_cursors SET last_modified_at=DATE_ADD(NOW(), INTERVAL 30 SECOND) WHERE client_id=? AND provider='UBER_EATS_TGO'", [CID]);
    sim.setProviderStatus('UBER_EATS_TGO', '2500', pkg.externalPackageId, 'Delivered');
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2500'", [CID]);
    assert.strictEqual(m.status, 'DELIVERED', 'the change inside the overlap window was lost');
  });

  await step('a crash between fetch and persist does not advance the cursor', async () => {
    const before = await db.one("SELECT * FROM np_int_cursors WHERE client_id=? AND provider='UBER_EATS_TGO'", [CID]);
    sim.injectFault('UBER_EATS_TGO', '5xx');
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const after = await db.one("SELECT * FROM np_int_cursors WHERE client_id=? AND provider='UBER_EATS_TGO'", [CID]);
    assert.strictEqual(String(after.last_modified_at), String(before.last_modified_at),
      'a failed poll moved the cursor and the orders behind it are gone');
    assert.ok(Number(after.consecutive_errors) > 0, 'the failure was not counted');
    assert.ok(after.backoff_until, 'no backoff was set after a 5xx');
    /* and recovery clears it */
    await db.exec('UPDATE np_int_cursors SET backoff_until=NULL WHERE id=?', [after.id]);
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const ok = await db.one('SELECT * FROM np_int_cursors WHERE id=?', [after.id]);
    assert.strictEqual(Number(ok.consecutive_errors), 0, 'a recovered poller still counts old errors');
    assert.strictEqual(ok.backoff_until, null);
  });

  await step('a 429 backs off with jitter and never retries a permanent 4xx into the ground', async () => {
    /* the bucket itself */
    rate.clear();
    for (let i = 0; i < 50; i++) await rate.take('TEST:endpoint', { limit: 50, windowMs: 10000 });
    assert.strictEqual(rate.remaining('TEST:endpoint', { limit: 50, windowMs: 10000 }), 0,
      'the 50-per-10-seconds bucket did not run out');
    assert.strictEqual(rate.remaining('TEST:other', { limit: 50, windowMs: 10000 }), 50,
      'the bucket is not per endpoint');
    rate.clear();

    /* full jitter: bounded, and not the same number twice */
    const samples = Array.from({ length: 40 }, (_, i) => rate.backoffMs(3));
    assert.ok(samples.every(s => s >= 0 && s <= 8000), 'attempt 3 should be inside 0..8s');
    assert.ok(new Set(samples).size > 5, 'the backoff has no jitter - every till will retry together');
    assert.ok(rate.backoffMs(30) <= 300000, 'the backoff is not capped');

    /* a rate-limited provider */
    sim.injectFault('UBER_EATS_TGO', 'rate_limit');
    const out = await mod.pollNow(CID, 'UBER_EATS_TGO');
    assert.ok(out.polled[0].backoffSec >= 0, 'a 429 produced no backoff');
    await db.exec("UPDATE np_int_cursors SET backoff_until=NULL, consecutive_errors=0 WHERE client_id=? AND provider='UBER_EATS_TGO'", [CID]);

    /* a permanent 4xx is flagged as such so nobody waits for it to heal */
    sim.injectFault('UBER_EATS_TGO', '4xx');
    const perm = await mod.pollNow(CID, 'UBER_EATS_TGO');
    assert.strictEqual(perm.polled[0].permanent, true, 'a permanent 4xx was treated as transient');
    await db.exec("UPDATE np_int_cursors SET backoff_until=NULL, consecutive_errors=0 WHERE client_id=? AND provider='UBER_EATS_TGO'", [CID]);
  });

  await step('a provider timeout is a structured, retryable refusal - not a hang', async () => {
    sim.injectFault('UBER_EATS_TGO', 'timeout');
    const a = await svc.adapterFor(CID, 'UBER_EATS_TGO', 1);
    const r = await a.call('fetchOrders', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'TIMEOUT');
    assert.strictEqual(r.retryable, true, 'a timeout must be retryable');
  });

  await step('invalid credentials answer INVALID_CREDENTIALS and stop retrying', async () => {
    sim.injectFault('UBER_EATS_TGO', 'auth');
    const a = await svc.adapterFor(CID, 'UBER_EATS_TGO', 1);
    const r = await a.call('fetchOrders', {});
    assert.strictEqual(r.code, 'INVALID_CREDENTIALS');
    assert.strictEqual(r.retryable, false, 'a wrong API key must not be retried for ever');
    sim.injectFault('UBER_EATS_TGO', 'auth');
    const t = await api('POST', '/api/integrations/UBER_EATS_TGO/test', {});
    assert.strictEqual(t.status, 200, 'a failed test should still be a rendered answer');
    assert.strictEqual(t.test.ok, false, 'the test button said yes to a rejected key');
    assert.strictEqual(t.test.code, 'INVALID_CREDENTIALS');
    const conn = await svc.connection(CID, 'UBER_EATS_TGO', 1);
    assert.strictEqual(conn.status, 'error', 'the card does not show the connection as broken');
    await db.exec("UPDATE np_int_connections SET status='connected', last_error=NULL WHERE id=?", [conn.id]);
  });

  await step('a provider being down does not stop the till selling', async () => {
    sim.injectFault('UBER_EATS_TGO', '5xx');
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const orders = require('../src/modules/orders');
    const id = await orders.openOrder(CID, { tableId: null, userId: fx.uid, label: 'Yerel' });
    await orders.addItem(CID, id, { productId: fx.products['Kola 33cl'], qty: 1, userId: fx.uid });
    const bill = await db.one('SELECT grand_total FROM orders WHERE id=?', [id]);
    assert.strictEqual(Number(bill.grand_total), 45, 'a dead platform blocked an ordinary sale');
    await db.exec("UPDATE np_int_cursors SET backoff_until=NULL, consecutive_errors=0 WHERE client_id=?", [CID]);
  });

  /* ================= 9. YETENEK VE DESTEKLENMEYEN ==================== */

  await step('an unsupported operation is a structured refusal, never a crash', async () => {
    const a = await svc.adapterFor(CID, 'YEMEKSEPETI', 1);
    const r = await a.call('markPreparing', { externalOrderId: '1' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'CAPABILITY_NOT_SUPPORTED');
    assert.ok(r.message && /desteklemiyor/.test(r.message), 'the refusal has no Turkish explanation');
    const bogus = await a.call('teleport', {});
    assert.strictEqual(bogus.code, 'UNKNOWN_OPERATION');
  });

  await step('a local state the platform has no call for still moves, and is logged', async () => {
    sim.seedOrder('YEMEKSEPETI', { externalOrderId: '3100', providerStoreId: 'YS-1',
      providerStatus: 'created', isPrepaid: false, deliveryCharge: 0 });
    await api('POST', '/api/integrations/webhook/YEMEKSEPETI',
      sim.detail('YEMEKSEPETI', '3100', String(3100 + 500000)), null);
    await settle();
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='3100'", [CID]);
    await api('POST', `/api/integrations/orders/${m.id}/accept`, {});
    const r = await api('POST', `/api/integrations/orders/${m.id}/preparing`, {});
    assert.strictEqual(r.status, 200, 'the kitchen could not be marked as started: ' + JSON.stringify(r));
    const after = await db.one('SELECT status FROM np_int_orders WHERE id=?', [m.id]);
    assert.strictEqual(after.status, 'PREPARING');
    const note = await db.one(
      "SELECT * FROM np_int_logs WHERE client_id=? AND message LIKE '%desteklemiyor%' ORDER BY id DESC LIMIT 1", [CID]);
    assert.ok(note, 'nothing recorded that the platform was not told');
  });

  /*
   * GETIR IS NOT A LEGACY CONNECTOR, and this step is the record of that
   * correction.
   *
   * It shipped as GETIR_LEGACY - off by default, badged "eski bağlantı" - on
   * the belief that Getir Yemek orders now arrive through Uber Eats Trendyol
   * Go with sourceApplication "Galaxy", so that a direct connector would only
   * double them up. That is not what Turkish restaurants see: Getir Yemek is
   * still its own platform with its own restaurant agreement, sold alongside
   * Trendyol Go and Yemeksepeti by every POS vendor in the market. A
   * restaurant asking for Getir is asking for THIS, and the old badge made
   * the product look like it had no Getir integration at all.
   *
   * What is still true is narrower and is a real limit rather than a policy:
   * Getir does not publish its endpoint addresses, so production is refused
   * until the integration pack's own addresses are entered. Inventing one
   * would fail silently on a restaurant's counter.
   */
  await step('Getir Yemek is a first-class platform, not a legacy connector', async () => {
    const card = (await api('GET', '/api/integrations')).providers.find(p => p.key === 'GETIR_YEMEK');
    assert.ok(card, 'Getir Yemek is not offered at all');
    assert.notStrictEqual(card.legacy, true, 'Getir Yemek is still badged as a legacy connection');
    assert.ok(!/eski/i.test(card.label), 'the label still calls it old: ' + card.label);
  });

  await step('Getir Yemek refuses to go live without its credentials and endpoints', async () => {
    /* The secrets are marked required in the registry, so the connection
       cannot even be SAVED without them - the screen says which field is
       missing instead of saving an empty connection and refusing later. */
    const save = await api('POST', '/api/integrations/GETIR_YEMEK/connection', {
      environment: 'production', provider_store_id: 'G-1' });
    assert.notStrictEqual(save.ok, true, 'a Getir connection saved with no secrets');
    const r = await api('POST', '/api/integrations/GETIR_YEMEK/enable', { enabled: true });
    assert.strictEqual(r.status, 409, 'Getir went live with nothing behind it');

    /* credentials in, endpoints still missing - the platform publishes none,
       so this second refusal is the honest one and must not be skipped */
    await api('POST', '/api/integrations/GETIR_YEMEK/connection', {
      environment: 'production', provider_store_id: 'G-1',
      appSecret: 'test-app-secret', restaurantSecretKey: 'test-restaurant-key' });
    const r2 = await api('POST', '/api/integrations/GETIR_YEMEK/enable', { enabled: true });
    assert.strictEqual(r2.status, 409, 'Getir went live with no endpoint addresses');
    assert.ok(/uç nokta/i.test(r2.error), 'the second refusal does not say endpoints: ' + r2.error);
  });

  await step('the simulator is always allowed, for every platform', async () => {
    await api('POST', '/api/integrations/GETIR_YEMEK/connection', {
      environment: 'simulator', provider_store_id: 'G-1' });
    const r = await api('POST', '/api/integrations/GETIR_YEMEK/enable', { enabled: true });
    assert.strictEqual(r.ok, true, 'the simulator was refused: ' + r.error);
    await api('POST', '/api/integrations/GETIR_YEMEK/enable', { enabled: false });
  });

  /* ==================== 10. EŞLEŞTİRME VE MENÜ ======================= */

  await step('a product the till has never heard of is created, priced and flagged', async () => {
    sim.seedOrder('UBER_EATS_TGO', {
      externalOrderId: '2700', supplierId: 'SUP-1', providerStoreId: 'STORE-1', deliveryCharge: 0,
      lines: [{ externalItemId: 'L1', externalProductId: 'P-BILINMEYEN', name: 'Platforma Özel Menü',
        qty: 1, unitPrice: 500, modifiers: [] }],
    });
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2700'", [CID]);
    assert.strictEqual(Number(m.unmapped_count), 1, 'the unknown product was not flagged');
    const auto = await db.one(
      `SELECT * FROM np_int_menu_map WHERE client_id=? AND provider='UBER_EATS_TGO'
         AND entity_type='product' AND external_id='P-BILINMEYEN'`, [CID]);
    assert.ok(auto, 'the auto-created product was not recorded in the map');
    assert.strictEqual(auto.mapped_by, 'auto');
    const p = await db.one('SELECT * FROM products WHERE id=?', [auto.local_id]);
    assert.strictEqual(Number(p.use_in_pos), 0, 'an auto-created product appeared on the till menu');
    assert.strictEqual(Number(p.track_stock), 0, 'an auto-created product with no recipe tracks stock');
    assert.strictEqual(p.name, 'Platforma Özel Menü', 'the kitchen slip would say "unmapped item"');
    /* And an exact name match is NOT unmapped: it is the product itself. */
    const known = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2001'", [CID]);
    assert.strictEqual(Number(known.unmapped_count), 0,
      'a platform product whose name matches the menu exactly was treated as unknown');
    const line = await db.one(
      `SELECT i.product_id FROM order_items i WHERE i.order_id=? AND i.product_id=? LIMIT 1`,
      [known.order_id, fx.products['Adana Kebap']]);
    assert.ok(line, 'the order used a placeholder instead of the restaurant\'s own Adana Kebap');

    /*
     * And the WARNING has to agree with that. An auto-match onto a real
     * product is not something anybody needs to act on; only a placeholder is.
     * Counting both put a permanent orange banner on a screen where nothing
     * was wrong, which is how people learn to ignore banners.
     */
    const warn = await mod.unmappedRows(CID, 'UBER_EATS_TGO', 1);
    const names = warn.map(w => w.external_name);
    assert.ok(names.includes('Platforma Özel Menü'), 'the placeholder is missing from the warning');
    assert.ok(!names.includes('Adana Kebap'),
      'a platform product auto-matched to the real menu is being reported as unmapped');
    const card = (await api('GET', '/api/integrations')).providers.find(p => p.key === 'UBER_EATS_TGO');
    assert.strictEqual(Number(card.unmapped_products), warn.length,
      'the card count and the mapping screen disagree about what is unmapped');
  });

  await step('automatic mapping matches exact names and refuses ambiguous ones', async () => {
    const r = await api('POST', '/api/integrations/UBER_EATS_TGO/mapping/auto', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.mapped >= 1, 'automatic mapping matched nothing');
    const map = await mod.mapping(CID, 'UBER_EATS_TGO', 1);
    const urfa = map.provider_menu.products.find(p => p.id === 'P-URFA');
    assert.strictEqual(urfa.local_id, null,
      'a platform product the restaurant does not sell was mapped to something anyway');
    assert.strictEqual(mod.fold('ADANA KEBAP '), mod.fold('adana kebap'));
    assert.strictEqual(mod.fold('Şiş Köfte'), 'sis kofte');
  });

  await step('a manual mapping wins, and a modifier mapped to a product becomes its own line', async () => {
    const set = await api('POST', '/api/integrations/UBER_EATS_TGO/mapping', {
      entity_type: 'modifier', external_id: 'M-AYRAN', local_id: fx.products.Ayran, external_name: 'Ayran' });
    assert.strictEqual(set.status, 200, JSON.stringify(set));
    sim.seedOrder('UBER_EATS_TGO', { externalOrderId: '2600', supplierId: 'SUP-1',
      providerStoreId: 'STORE-1', deliveryCharge: 0 });
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2600'", [CID]);
    const items = await db.query(
      `SELECT i.*, p.name FROM order_items i JOIN products p ON p.id=i.product_id
        WHERE i.order_id=? AND i.is_deleted=0`, [m.order_id]);
    const ayran = items.find(i => i.name === 'Ayran');
    assert.ok(ayran, 'a mapped modifier did not become its own line');
    assert.strictEqual(Number(ayran.unit_price), 25);
    const adana = items.find(i => /Adana/.test(i.name));
    assert.strictEqual(Number(adana.unit_price), 320,
      'the modifier price is being charged twice: once as a line and once folded in');
  });

  await step('a mapping cannot point at another tenant\'s product', async () => {
    const foreign = await db.insert(
      `INSERT INTO products (client_id, category_id, name, price, cost_price, sort_order, is_active,
          use_in_pos, use_in_qr, vat_rate, track_stock) VALUES (?,?,?,?,0,1,1,1,0,10,0)`,
      [OTHER, fx.categoryId, 'Başka İşletmenin Ürünü', 10]);
    const r = await api('POST', '/api/integrations/UBER_EATS_TGO/mapping', {
      entity_type: 'product', external_id: 'P-URFA', local_id: foreign });
    assert.strictEqual(r.status, 404, 'a mapping crossed the tenant boundary: ' + JSON.stringify(r));
    await db.exec('DELETE FROM products WHERE id=?', [foreign]);
  });

  await step('menu sync sends the whole mapped catalogue and records the result', async () => {
    const r = await api('POST', '/api/integrations/UBER_EATS_TGO/menu/sync', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.ok(r.result.counts.products >= 3, 'the catalogue went up nearly empty');
    const pushed = sim.lastMenu('UBER_EATS_TGO', 'STORE-1');
    assert.ok(pushed, 'the platform received no catalogue');
    const adana = pushed.catalogue.products.find(p => p.name === 'Adana Kebap');
    assert.ok(adana, 'a mapped product was left out of the catalogue');
    assert.strictEqual(adana.externalId, 'P-ADANA', 'the catalogue used our id instead of the platform\'s');
    const conn = await svc.connection(CID, 'UBER_EATS_TGO', 1);
    assert.ok(conn.last_sync_at, 'the last successful sync was not stamped');
  });

  await step('a connection can pin platform slips to its own printer', async () => {
    const station = await db.one('SELECT id FROM stations WHERE client_id=? ORDER BY id LIMIT 1', [CID]);
    assert.ok(station, 'the fixture has no station to route to');
    await api('POST', '/api/integrations/UBER_EATS_TGO/connection',
      { station_id: station.id, receipt_station_id: station.id });
    sim.seedOrder('UBER_EATS_TGO', { externalOrderId: '2800', supplierId: 'SUP-1',
      providerStoreId: 'STORE-1', deliveryCharge: 0 });
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2800'", [CID]);
    const jobs = await printJobsFor(m.order_id);
    const receipt = jobs.find(j => j.job_type === 'receipt');
    assert.ok(receipt, 'no paket fişi was queued');
    assert.strictEqual(Number(receipt.station_id), Number(station.id),
      'the paket fişi ignored the printer the connection was routed to');
    const lines = await db.query(
      'SELECT station_id FROM order_items WHERE order_id=? AND is_deleted=0', [m.order_id]);
    assert.ok(lines.every(l => Number(l.station_id) === Number(station.id)),
      'the kitchen lines were not pinned to the connection\'s station');
    await api('POST', '/api/integrations/UBER_EATS_TGO/connection',
      { station_id: 0, receipt_station_id: 0 });
  });

  await step('availability and the open/closed switch reach the platform', async () => {
    const a = await api('POST', `/api/integrations/UBER_EATS_TGO/product/${fx.products['Kola 33cl']}/availability`,
      { available: false });
    assert.strictEqual(a.status, 200, JSON.stringify(a));
    const close = await api('POST', '/api/integrations/UBER_EATS_TGO/restaurant-open', { open: false });
    assert.strictEqual(close.status, 200, JSON.stringify(close));
    assert.strictEqual(sim.isOpen('UBER_EATS_TGO', 'STORE-1'), false, 'the restaurant is still open on the platform');
    const conn = await svc.connection(CID, 'UBER_EATS_TGO', 1);
    assert.strictEqual(Number(conn.restaurant_open), 0);
    await api('POST', '/api/integrations/UBER_EATS_TGO/restaurant-open', { open: true });
  });

  /* ==================== 11. KUYRUK VE YETKİ ========================== */

  await step('a failed event is retried and then dead-lettered, not retried for ever', async () => {
    const id = await db.insert(
      `INSERT INTO np_int_events (client_id, provider, source, event_key, payload, status, created_at)
       VALUES (?,?,?,?,?, 'new', NOW())`,
      [CID, 'UBER_EATS_TGO', 'poll', 'broken-' + Date.now(), JSON.stringify({ nonsense: true })]);
    for (let i = 0; i < ingest.MAX_ATTEMPTS + 1; i++) await ingest.drainEvents(50);
    const ev = await db.one('SELECT * FROM np_int_events WHERE id=?', [id]);
    assert.strictEqual(ev.status, 'dead', 'a hopeless event is still being retried, status ' + ev.status);
    assert.ok(Number(ev.attempts) <= ingest.MAX_ATTEMPTS, 'attempts ran past the cap');
    assert.ok(ev.last_error, 'the dead letter says nothing about why');

    const listed = await api('GET', '/api/integrations/events?state=dead');
    assert.ok(listed.rows.some(r => r.id === id), 'the dead letter is invisible to the screen');
    const retried = await api('POST', `/api/integrations/events/${id}/retry`);
    assert.strictEqual(retried.status, 200, JSON.stringify(retried));
    await db.exec('DELETE FROM np_int_events WHERE id=?', [id]);
  });

  await step('another tenant\'s platform order cannot be read or acted on', async () => {
    const foreign = await db.insert(
      `INSERT INTO np_int_orders (client_id, branch_id, provider, provider_store_id, external_order_id,
          external_package_id, status, received_at)
       VALUES (?,1,'UBER_EATS_TGO','X','9999','9999','RECEIVED',NOW())`, [OTHER]);
    const seen = await api('GET', '/api/integrations/orders');
    assert.ok(!seen.rows.some(r => r.external_order_id === '9999'), 'another tenant\'s order is on our list');
    const read = await api('GET', `/api/integrations/orders/${foreign}`);
    assert.strictEqual(read.status, 404, 'another tenant\'s order could be read');
    const acted = await api('POST', `/api/integrations/orders/${foreign}/accept`, {});
    assert.strictEqual(acted.status, 404, 'another tenant\'s order could be accepted');
    await db.exec('DELETE FROM np_int_orders WHERE id=?', [foreign]);
  });

  await step('a branch only sees its own orders', async () => {
    await db.exec(
      `INSERT INTO np_int_orders (client_id, branch_id, provider, provider_store_id, external_order_id,
          external_package_id, status, received_at)
       VALUES (?,2,'UBER_EATS_TGO','SUBE2','8888','8888','RECEIVED',NOW())`, [CID]);
    const branch1 = await api('GET', '/api/integrations/orders?branch=1');
    assert.ok(!branch1.rows.some(r => r.external_order_id === '8888'), 'branch 2 leaked into branch 1');
    const branch2 = await api('GET', '/api/integrations/orders?branch=2');
    assert.ok(branch2.rows.some(r => r.external_order_id === '8888'), 'branch 2 cannot see its own order');
    await db.exec("DELETE FROM np_int_orders WHERE client_id=? AND external_order_id='8888'", [CID]);
  });

  await step('a waiter cannot connect a platform; a cashier can accept an order', async () => {
    const waiter = await auth.issueToken({ cid: CID, uid: 0, role: 'waiter', name: 'Garson', kind: 'pos' });
    const denied = await api('GET', '/api/integrations', null, waiter);
    assert.strictEqual(denied.status, 403, 'a waiter can see the API credentials screen');
    const denied2 = await api('POST', '/api/integrations/UBER_EATS_TGO/connection', { apiKey: 'x' }, waiter);
    assert.strictEqual(denied2.status, 403, 'a waiter can rewrite the platform credentials');
    const cashier = await auth.issueToken({ cid: CID, uid: 0, role: 'cashier', name: 'Kasiyer', kind: 'pos' });
    const list = await api('GET', '/api/integrations/orders', null, cashier);
    assert.strictEqual(list.status, 200, 'a cashier cannot see the orders they have to accept');
    const cfg = await api('GET', '/api/integrations', null, cashier);
    assert.strictEqual(cfg.status, 403, 'a cashier can read the platform credentials screen');
  });

  await step('the webhook endpoint is rate limited', async () => {
    let limited = false;
    for (let i = 0; i < 140; i++) {
      const res = await fetch(BASE + '/api/integrations/webhook/UBER_EATS_TGO', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.status === 429) { limited = true; break; }
    }
    assert.ok(limited, 'the public webhook endpoint accepts unlimited requests');
  });

  await step('connection changes, order actions and manual reprints are all audited', async () => {
    const saves = await db.query(
      "SELECT * FROM audit_logs WHERE client_id=? AND action LIKE 'integration.%' ORDER BY id DESC LIMIT 30", [CID]);
    assert.ok(saves.some(a => a.action === 'integration.save'), 'saving credentials left no audit row');
    assert.ok(saves.some(a => a.action === 'integration.enable'), 'enabling a platform left no audit row');
    assert.ok(saves.every(a => !String(a.after_json || '').includes('AS-987654321')),
      'the audit trail contains a plain-text secret');
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='2001'", [CID]);
    const before = (await printJobsFor(m.order_id)).length;
    const rp = await api('POST', `/api/integrations/orders/${m.id}/reprint`, {});
    assert.strictEqual(rp.status, 200, JSON.stringify(rp));
    assert.strictEqual((await printJobsFor(m.order_id)).length, before + 1, 'the reprint produced no copy');
    const after = await db.one('SELECT reprint_count FROM np_int_orders WHERE id=?', [m.id]);
    assert.strictEqual(Number(after.reprint_count), 1);
    const logged = await db.one(
      "SELECT * FROM np_int_logs WHERE client_id=? AND action='reprint' ORDER BY id DESC LIMIT 1", [CID]);
    assert.ok(logged, 'a manual reprint was not logged');
  });

  /* ================ 12. UÇTAN UCA SİMÜLASYON ======================== */

  await step('simulator end to end: order in, accepted, cooked, dispatched, delivered', async () => {
    sim.reset();
    await db.exec("UPDATE np_int_cursors SET last_modified_at=NULL, backoff_until=NULL, consecutive_errors=0 WHERE client_id=?", [CID]);
    const _pkg = sim.seedOrder('UBER_EATS_TGO', {
      externalOrderId: '7001', supplierId: 'SUP-1', providerStoreId: 'STORE-1',
      sourceApplication: 'Galaxy', customerNote: 'Zili çalmayın' });
    await mod.pollNow(CID, 'UBER_EATS_TGO');
    const m = await db.one("SELECT * FROM np_int_orders WHERE client_id=? AND external_order_id='7001'", [CID]);
    assert.ok(m, 'the order never arrived');
    assert.strictEqual(m.status, 'ACCEPTED');
    assert.strictEqual(m.source_application, 'Galaxy');

    for (const [action, want] of [['preparing', 'PREPARING'], ['ready', 'READY'],
      ['dispatched', 'DISPATCHED'], ['delivered', 'DELIVERED']]) {
      const r = await api('POST', `/api/integrations/orders/${m.id}/${action}`, {});
      assert.strictEqual(r.status, 200, action + ' failed: ' + JSON.stringify(r));
      const now = await db.one('SELECT status FROM np_int_orders WHERE id=?', [m.id]);
      assert.strictEqual(now.status, want);
    }
    assert.strictEqual(sim.calls('UBER_EATS_TGO', 'markDelivered').length, 1, 'the platform was never told');
    const detail = await api('GET', `/api/integrations/orders/${m.id}`);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.order.status, 'DELIVERED');
    assert.deepStrictEqual(detail.allowed, [], 'a delivered order still offers next steps');
    assert.ok(detail.items.length >= 2, 'the line mapping was not kept');
    assert.ok(detail.logs.length >= 3, 'the audit trail for this order is empty');
    assert.ok(detail.bill, 'the detail does not reach the real POS bill');
  });

  await step('the health card reports the mode, the queue and which operations are unverified', async () => {
    const r = await api('GET', '/api/integrations/health/UBER_EATS_TGO');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const h = r.health;
    assert.strictEqual(h.configured, true);
    assert.strictEqual(h.environment, 'simulator');
    assert.ok(h.cursor, 'the health card cannot say when the last poll worked');
    assert.ok(h.queue && typeof h.queue.pending === 'number');
    assert.ok(h.adapter && Array.isArray(h.adapter.unverifiedOperations),
      'the adapter does not declare which operations are unverified');
    assert.ok(h.adapter.verifiedOperations.includes('fetchOrders'),
      'the one documented TGO endpoint is not reported as verified');
  });

  /* ================================ sonuç ============================== */
  await db.setSetting('panel_url', process.env.PANEL || 'http://127.0.0.1:8090');
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
