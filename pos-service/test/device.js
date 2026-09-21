'use strict';
/**
 * CİHAZ / ÇEVRİMDIŞI / SENKRON — the things that only go wrong when nobody is
 * looking.
 *
 * Every check runs against a real MariaDB and the real HTTP service, in the
 * order a restaurant would hit them: pair a phone, cut it off, watch the queue
 * back up, hand out a number prefix, take it back, let the licence age. None of
 * it is mocked, because the failures this suite exists to catch - a pairing
 * code that can be used twice, a revoked tablet that keeps taking orders, an
 * outbox that has been dead for three days and looks busy, two tills minting
 * the same adisyon number - are exactly the ones a mock hides.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/device.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7469';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
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

/**
 * The migration is applied here rather than assumed.
 *
 * The desktop shell re-runs every file in database/migrations on each start; a
 * test run has no shell, and a suite that dies with "Table
 * app_device_number_history doesn't exist" tells the next person nothing about
 * device prefixes. The file is written to be idempotent, so this is exactly
 * what the shell does.
 */
async function migrate() {
  const file = path.join(__dirname, '..', '..', 'database', 'migrations', '2026-09-03-device.sql');
  const sql = fs.readFileSync(file, 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await db.exec(stmt); } catch (_) { /* already applied */ }
  }
}

/**
 * A clean set of devices and an empty queue.
 *
 * The suites share one database and the ones before this leave both behind, so
 * every count below would otherwise be measuring somebody else's leftovers.
 */
async function fixture() {
  await db.exec('DELETE FROM app_device_numbers WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM app_device_number_history WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM app_device_tokens WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM np_mobile_pairings WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM np_sync_outbox WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM app_order_counters WHERE client_id=?', [CID]);
  await db.exec("DELETE FROM np_app_log WHERE area IN ('cihaztest','cihaztest2')");

  /*
   * The panel is deliberately pointed at a closed port for the whole run. Every
   * manual push in this file calls the real sync.drain(), and a drain against
   * the production URL would sit on a 30 second timeout per assertion.
   */
  await db.setSetting('panel_url', 'http://127.0.0.1:9');

  const catalog = require('../src/modules/catalog');
  await db.exec('DELETE FROM users WHERE client_id=? AND username=?', [CID, 'cihazci']);
  const uid = await catalog.saveUser(CID, {
    display_name: 'Cihaz Yöneticisi', username: 'cihazci', role: 'admin',
    pin: '9182', password: 'Cihaz1234',
  }, null);
  return uid;
}

/** Pair a phone the way the phone does it, and hand back its device token. */
async function pairPhone(deviceId, name, platform = 'android', version = '2.1.0') {
  const made = await api('POST', '/api/device/pair-code');
  assert.strictEqual(made.status, 200, JSON.stringify(made));
  const r = await api('POST', '/api/auth/pair', {
    code: made.pairing.code, device_id: deviceId, device_name: name,
    platform, app_version: version, username: 'cihazci', password: 'Cihaz1234',
  }, null);
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  return { token: r.token, code: made.pairing.code, pairing: made.pairing };
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  await migrate();
  const uid = await fixture();
  TOKEN = await auth.issueToken({ cid: CID, uid, role: 'admin', name: 'Cihaz Yöneticisi', kind: 'pos' });
  const device = require('../src/modules/device');
  const config = require('../src/config');

  console.log('\nNOKTApp POS - cihazlar, çevrimdışı numaralar, senkron, bağlantı\n');

  /* ========================== 1. EŞLEŞTİRME ============================= */

  await step('a pairing code is minted with a countdown and can be read back', async () => {
    const made = await api('POST', '/api/device/pair-code');
    assert.strictEqual(made.status, 200, JSON.stringify(made));
    assert.ok(/^\d{6}$/.test(made.pairing.code), 'expected six digits, got ' + made.pairing.code);
    assert.ok(made.pairing.seconds_left > 540 && made.pairing.seconds_left <= 600,
      'countdown should start near ten minutes, got ' + made.pairing.seconds_left);
    assert.ok(Array.isArray(made.pairing.addresses), 'the phone needs an address to type');

    // reopening the tab must show the SAME code, not mint a new one
    const seen = await api('GET', '/api/device/pair-code');
    assert.strictEqual(seen.pairing.code, made.pairing.code);
    await api('DELETE', '/api/device/pair-code');
    assert.strictEqual((await api('GET', '/api/device/pair-code')).pairing, null,
      'a cancelled code must not still be live');
  });

  await step('a pairing code works exactly once', async () => {
    const made = await api('POST', '/api/device/pair-code');
    const body = {
      code: made.pairing.code, device_id: 'tek-kullanim', device_name: 'Tek Kullanım',
      platform: 'android', app_version: '2.1.0', username: 'cihazci', password: 'Cihaz1234',
    };
    const first = await api('POST', '/api/auth/pair', body, null);
    assert.strictEqual(first.status, 200, JSON.stringify(first));
    const second = await api('POST', '/api/auth/pair', body, null);
    assert.strictEqual(second.status, 400, 'the same code was accepted twice');
    assert.ok(/gecersiz|geçersiz/i.test(second.error || ''), 'unhelpful message: ' + second.error);
  });

  await step('a pairing code expires', async () => {
    const made = await api('POST', '/api/device/pair-code');
    await db.exec('UPDATE np_mobile_pairings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE pair_code=?',
      [made.pairing.code]);
    const r = await api('POST', '/api/auth/pair', {
      code: made.pairing.code, device_id: 'gec-kalan', device_name: 'Geç Kalan',
      platform: 'ios', username: 'cihazci', password: 'Cihaz1234',
    }, null);
    assert.strictEqual(r.status, 400, 'an expired code still paired a device');
    assert.strictEqual((await api('GET', '/api/device/pair-code')).pairing, null,
      'an expired code must not be offered as live');
  });

  /* ============================ 2. CİHAZLAR ============================= */

  let phone = null;
  await step('a paired phone is listed with its name, platform, version and last seen', async () => {
    phone = await pairPhone('cihaz-telefon-1', 'Garson Telefonu', 'android', '2.1.0');
    const r = await api('GET', '/api/device/devices');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const d = r.devices.find(x => x.device_id === 'cihaz-telefon-1');
    assert.ok(d, 'the phone we just paired is not in the list');
    assert.strictEqual(d.name, 'Garson Telefonu');
    assert.strictEqual(d.platform, 'android');
    assert.strictEqual(d.app_version, '2.1.0');
    assert.ok(d.last_seen_at, 'a device with no last-seen is useless in this list');
    assert.strictEqual(d.state, 'online', 'just paired, so it should read as online');
    assert.strictEqual(d.user_name, 'Cihaz Yöneticisi', 'who is signed in on it is the point');
  });

  await step('a device can be renamed', async () => {
    const list = await api('GET', '/api/device/devices');
    const d = list.devices.find(x => x.device_id === 'cihaz-telefon-1');
    const r = await api('POST', `/api/device/devices/${d.id}/rename`, { name: 'Salon Tableti' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const after = (await api('GET', '/api/device/devices')).devices.find(x => x.device_id === 'cihaz-telefon-1');
    assert.strictEqual(after.name, 'Salon Tableti');
    const empty = await api('POST', `/api/device/devices/${d.id}/rename`, { name: '  ' });
    assert.strictEqual(empty.status, 400, 'a blank name would leave the list unreadable');
  });

  await step('a device token works until the device is revoked, then stops', async () => {
    const before = await fetch(BASE + '/api/mobile/bootstrap',
      { headers: { Authorization: 'Bearer ' + phone.token } });
    assert.strictEqual(before.status, 200, 'a freshly paired phone could not read the menu');

    const d = (await api('GET', '/api/device/devices')).devices.find(x => x.device_id === 'cihaz-telefon-1');
    const rev = await api('POST', `/api/device/devices/${d.id}/revoke`);
    assert.strictEqual(rev.status, 200, JSON.stringify(rev));

    const after = await fetch(BASE + '/api/mobile/bootstrap',
      { headers: { Authorization: 'Bearer ' + phone.token } });
    assert.strictEqual(after.status, 401, 'a revoked device is still taking orders');
    const row = (await api('GET', '/api/device/devices')).devices.find(x => x.device_id === 'cihaz-telefon-1');
    assert.strictEqual(row.state, 'revoked');
  });

  await step('revoking cuts every session on that device, not just the newest', async () => {
    // re-pairing does not replace the old row (lan.issueDeviceToken always
    // INSERTs), so a device can hold three live tokens at once. Revoking one of
    // them would look identical in the list and change nothing on the phone.
    const a = await pairPhone('cok-oturum', 'Çok Oturumlu', 'ios', '2.1.0');
    const b = await pairPhone('cok-oturum', 'Çok Oturumlu', 'ios', '2.1.0');
    const list = await api('GET', '/api/device/devices');
    const d = list.devices.find(x => x.device_id === 'cok-oturum');
    assert.strictEqual(d.sessions, 2, 'expected two live tokens, saw ' + d.sessions);
    const rev = await api('POST', `/api/device/devices/${d.id}/revoke`);
    assert.strictEqual(rev.revoked, 2, 'only ' + rev.revoked + ' of 2 tokens were cut');
    for (const t of [a.token, b.token]) {
      const res = await fetch(BASE + '/api/mobile/bootstrap', { headers: { Authorization: 'Bearer ' + t } });
      assert.strictEqual(res.status, 401, 'one of the older tokens still works');
    }
  });

  /* ====================== 3. ADİSYON ÖN EKLERİ ========================= */

  await step('an adisyon number is composed and decomposed by prefix', async () => {
    assert.strictEqual(device.compose(0, 7), 7, 'this PC counts 1,2,3');
    assert.strictEqual(device.compose(3, 1), 30001);
    assert.strictEqual(device.compose(9, 9999), 99999);
    assert.strictEqual(device.compose(1, 10000), null, 'a series past 9999 has no number, not a wrong one');
    assert.strictEqual(device.compose(10, 1), null);
    assert.deepStrictEqual(device.decompose(30001), [3, 1]);
    assert.deepStrictEqual(device.decompose(42), [0, 42]);
  });

  await step('a prefix is allocated once and then reserved for that device', async () => {
    const first = await api('POST', '/api/device/prefixes/allocate',
      { device_id: 'onek-cihaz-1', device_name: 'Ön Ek Cihazı' });
    assert.strictEqual(first.status, 200, JSON.stringify(first));
    assert.strictEqual(first.prefix, 1, 'the first device should get prefix 1');
    assert.strictEqual(first.allocated, true);

    const again = await api('POST', '/api/device/prefixes/allocate', { device_id: 'onek-cihaz-1' });
    assert.strictEqual(again.prefix, 1, 'asking twice must give the same prefix');
    assert.strictEqual(again.allocated, false, 'the second call must not claim a new one');

    const other = await api('POST', '/api/device/prefixes/allocate', { device_id: 'onek-cihaz-2' });
    assert.strictEqual(other.prefix, 2, 'a second device must not share prefix 1');

    const state = await api('GET', '/api/device/prefixes');
    const held = state.prefixes.find(p => p.prefix === 1);
    assert.strictEqual(held.device_id, 'onek-cihaz-1');
    assert.strictEqual(held.example, 10001, 'prefix 1 mints 10001');
    assert.deepStrictEqual(state.free, [3, 4, 5, 6, 7, 8, 9]);
    assert.strictEqual(state.all_taken, false);
    assert.strictEqual(state.server.prefix, 0);
  });

  await step('two devices asking at the same instant never share a prefix', async () => {
    const ids = ['yaris-1', 'yaris-2', 'yaris-3'];
    const out = await Promise.all(ids.map(id =>
      api('POST', '/api/device/prefixes/allocate', { device_id: id })));
    const got = out.map(o => o.prefix).sort();
    assert.strictEqual(new Set(got).size, 3, 'a prefix was handed out twice: ' + got.join(','));
    const rows = await db.query('SELECT prefix FROM app_device_numbers WHERE client_id=?', [CID]);
    assert.strictEqual(new Set(rows.map(r => r.prefix)).size, rows.length, 'duplicate prefix rows in the table');
  });

  await step('the tenth device is told it can only work online', async () => {
    for (let i = 1; i <= 9; i++) {
      await api('POST', '/api/device/prefixes/allocate', { device_id: 'dolu-' + i });
    }
    const state = await api('GET', '/api/device/prefixes');
    assert.strictEqual(state.prefixes.length, 9, 'expected all nine prefixes held');
    assert.strictEqual(state.all_taken, true);
    assert.deepStrictEqual(state.free, []);

    const tenth = await api('POST', '/api/device/prefixes/allocate', { device_id: 'onuncu-cihaz' });
    assert.strictEqual(tenth.status, 200, 'being tenth is not an error - it still trades online');
    assert.strictEqual(tenth.prefix, null);
    assert.strictEqual(tenth.online_only, true);
  });

  await step('a prefix is released when the device is retired, and can be re-issued', async () => {
    const state = await api('GET', '/api/device/prefixes');
    const victim = state.prefixes[0];
    const r = await api('POST', `/api/device/prefixes/${victim.prefix}/release`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.prefix, victim.prefix);

    const after = await api('GET', '/api/device/prefixes');
    assert.ok(after.free.includes(victim.prefix), 'the released prefix is not back in circulation');
    assert.strictEqual(after.all_taken, false);
    const hist = after.history.find(h => h.device_id === victim.device_id);
    assert.ok(hist && hist.released_at, 'releasing a prefix left no trace for support');

    // and the freed prefix is the one the next device gets
    const next = await api('POST', '/api/device/prefixes/allocate', { device_id: 'yeni-cihaz' });
    assert.strictEqual(next.prefix, victim.prefix);
    assert.strictEqual((await api('POST', `/api/device/prefixes/${victim.prefix}/release`)).status, 200);
    const twice = await api('POST', `/api/device/prefixes/${victim.prefix}/release`);
    assert.strictEqual(twice.status, 404, 'releasing an already free prefix should say so');
  });

  await step('retiring a device cuts its access and gives its prefix back in one action', async () => {
    const p = await pairPhone('emekli-cihaz', 'Emekli Tablet', 'android', '2.0.9');
    await db.exec('DELETE FROM app_device_numbers WHERE client_id=? AND prefix=9', [CID]);
    await api('POST', '/api/device/prefixes/allocate', { device_id: 'emekli-cihaz', device_name: 'Emekli Tablet' });
    const d = (await api('GET', '/api/device/devices')).devices.find(x => x.device_id === 'emekli-cihaz');
    assert.ok(d.prefix, 'the retired device should have held a prefix');

    const r = await api('POST', `/api/device/devices/${d.id}/retire`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.released_prefix, d.prefix);
    const res = await fetch(BASE + '/api/mobile/bootstrap', { headers: { Authorization: 'Bearer ' + p.token } });
    assert.strictEqual(res.status, 401, 'a retired device still has access');
    const free = (await api('GET', '/api/device/prefixes')).free;
    assert.ok(free.includes(d.prefix), 'the retired device kept its prefix');
  });

  await step('an offline number teaches this PC\'s counter, and never moves it backwards', async () => {
    const bd = require('../src/util/businessDay');
    const date = await bd.currentBusinessDate();
    await db.exec('DELETE FROM app_order_counters WHERE client_id=? AND prefix=4', [CID]);
    await device.observeNumber(CID, date, 4, 30);       // the tablet minted 40030
    let next = Number(await db.value(
      'SELECT next_no FROM app_order_counters WHERE client_id=? AND business_date=? AND prefix=4', [CID, date]));
    assert.strictEqual(next, 31, 'the counter did not learn the offline number');
    await device.observeNumber(CID, date, 4, 10);       // an op replayed out of order
    next = Number(await db.value(
      'SELECT next_no FROM app_order_counters WHERE client_id=? AND business_date=? AND prefix=4', [CID, date]));
    assert.strictEqual(next, 31, 'an out-of-order op pulled the counter back');
  });

  /* ========================= 4. SENKRON DURUMU ========================== */

  await step('the outbox count and the last successful push are reported accurately', async () => {
    await db.exec('DELETE FROM np_sync_outbox WHERE client_id=?', [CID]);
    await db.exec(
      `INSERT INTO np_sync_outbox (client_id, entity, entity_id, op, payload, status, sent_at, created_at)
       VALUES (?, 'daily_summary', '19:2026-09-01', 'upsert', '{}', 'sent',
               '2026-09-01 23:10:00', '2026-09-01 23:09:00')`, [CID]);
    for (let i = 0; i < 4; i++) {
      await db.exec(
        `INSERT INTO np_sync_outbox (client_id, entity, entity_id, op, payload, status, created_at)
         VALUES (?, 'daily_closing', ?, 'upsert', '{}', 'pending', DATE_SUB(NOW(), INTERVAL 45 MINUTE))`,
        [CID, '19:test:' + i]);
    }
    const r = await api('GET', '/api/device/sync');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.sync.pending, 4, 'pending count is wrong: ' + r.sync.pending);
    assert.strictEqual(r.sync.sent, 1);
    assert.ok(String(r.sync.last_sent_at).startsWith('2026-09-01 23:10'),
      'last push time is wrong: ' + r.sync.last_sent_at);
    assert.ok(r.sync.queue_age_min >= 44, 'the age of the oldest waiting row is wrong: ' + r.sync.queue_age_min);
    assert.strictEqual(r.sync.by_entity[0].entity, 'daily_closing');
  });

  await step('the last error is reported with the operation it belongs to', async () => {
    await db.exec(
      `UPDATE np_sync_outbox SET attempts=3, last_error='panel rejected: LICENCE_SUSPENDED'
        WHERE client_id=? AND entity_id=? `, [CID, '19:test:2']);
    const r = await api('GET', '/api/device/sync');
    assert.ok(r.sync.last_error, 'a failing queue reported no error at all');
    assert.strictEqual(r.sync.last_error.message, 'panel rejected: LICENCE_SUSPENDED');
    assert.strictEqual(r.sync.last_error.entity_id, '19:test:2');
    assert.strictEqual(r.sync.last_error.attempts, 3);
  });

  await step('an operation the queue has given up on is listed as blocked, with its reason', async () => {
    await db.exec(
      `INSERT INTO np_sync_outbox (client_id, entity, entity_id, op, payload, status, attempts, last_error, created_at)
       VALUES (?, 'daily_closing', '19:takili', 'upsert', '{"net":100}', 'pending', 10,
               'panel rejected: BAD_SIGNATURE', DATE_SUB(NOW(), INTERVAL 2 DAY))`, [CID]);
    const r = await api('GET', '/api/device/sync/failed');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const stuck = r.ops.find(o => o.entity_id === '19:takili');
    assert.ok(stuck, 'the dead row is not in the failed list');
    assert.strictEqual(stuck.blocked, true, 'ten attempts means the drain skips it - that is the point');
    assert.strictEqual(stuck.reason, 'panel rejected: BAD_SIGNATURE');
    assert.strictEqual(r.ops[0].entity_id, '19:takili', 'blocked rows must be listed first');

    const st = await api('GET', '/api/device/sync');
    assert.strictEqual(st.sync.stuck, 1, 'a blocked row must not be counted as merely pending');
  });

  await step('a failed operation can be retried and re-enters the queue', async () => {
    const list = await api('GET', '/api/device/sync/failed');
    const stuck = list.ops.find(o => o.entity_id === '19:takili');
    const r = await api('POST', `/api/device/sync/failed/${stuck.id}/retry`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const row = await db.one('SELECT status, attempts FROM np_sync_outbox WHERE id=?', [stuck.id]);
    assert.strictEqual(row.status, 'pending');
    assert.ok(row.attempts < 10, 'the attempt counter was not reset, so nothing will ever pick it up again');
    const after = await api('GET', '/api/device/sync');
    assert.strictEqual(after.sync.stuck, 0, 'the row is still counted as given up on');
  });

  await step('"şimdi gönder" runs the real drain and reports what is left', async () => {
    // the panel is a closed port for this run, so nothing can leave; the honest
    // answer is "nothing sent, four still waiting" - not a silent success
    const r = await api('POST', '/api/device/sync/push');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.sync.pushed, 0, 'a push to a dead panel claimed to have sent something');
    assert.ok(r.sync.waiting >= 4, 'the queue emptied itself without a panel');
  });

  await step('retry-all releases every blocked row at once', async () => {
    await db.exec(
      `UPDATE np_sync_outbox SET status='failed', attempts=10, last_error='panel rejected'
        WHERE client_id=? AND status='pending'`, [CID]);
    let st = await api('GET', '/api/device/sync');
    assert.ok(st.sync.failed >= 4, 'setup: expected failed rows');
    const r = await api('POST', '/api/device/sync/failed/retry-all');
    assert.ok(r.retried >= 4, 'retry-all moved ' + r.retried + ' rows');
    st = await api('GET', '/api/device/sync');
    assert.strictEqual(st.sync.failed, 0, 'rows are still marked failed after a retry-all');
  });

  /* ========================= 5. BAĞLANTI DURUMU ======================== */

  await step('offline grace is counted from the last successful licence check', async () => {
    await db.exec('UPDATE np_licence SET grace_days=7, last_ok_at=DATE_SUB(NOW(), INTERVAL 3 DAY), last_check_at=NOW() WHERE id=1');
    let r = await api('GET', '/api/device/connection');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.grace.days_left, 4, '3 days into a 7 day window leaves 4, got ' + r.grace.days_left);
    assert.strictEqual(r.grace.expired, false);

    await db.exec('UPDATE np_licence SET last_ok_at=DATE_SUB(NOW(), INTERVAL 6 DAY) WHERE id=1');
    r = await api('GET', '/api/device/connection');
    assert.strictEqual(r.grace.days_left, 1, 'the last day of the window must still read as a day');
    assert.ok(r.warnings.some(w => w.level === 'warn' && /nternetsiz|evrimdışı/.test(w.text)),
      'the last day of the offline window was not called out');

    await db.exec('UPDATE np_licence SET last_ok_at=DATE_SUB(NOW(), INTERVAL 9 DAY) WHERE id=1');
    r = await api('GET', '/api/device/connection');
    assert.strictEqual(r.grace.days_left, 0);
    assert.strictEqual(r.grace.expired, true);
    assert.ok(r.warnings.some(w => w.level === 'error'), 'an expired grace window is not a warning, it is an error');

    await db.exec('UPDATE np_licence SET last_ok_at=NOW(), last_check_at=NOW() WHERE id=1');
  });

  await step('an expiring licence is visible before it expires, not after', async () => {
    await db.exec('UPDATE np_licence SET expires_at=DATE_ADD(NOW(), INTERVAL 10 DAY) WHERE id=1');
    let r = await api('GET', '/api/device/connection');
    assert.strictEqual(r.licence.days_to_expiry, 10);
    const warn = r.warnings.find(w => /Lisans 10 gün sonra bitiyor/.test(w.text));
    assert.ok(warn, 'ten days out and nothing was said: ' + JSON.stringify(r.warnings));
    assert.strictEqual(warn.level, 'warn', 'not an error yet - there is still time to act');

    await db.exec('UPDATE np_licence SET expires_at=DATE_ADD(NOW(), INTERVAL 60 DAY) WHERE id=1');
    r = await api('GET', '/api/device/connection');
    assert.ok(!r.warnings.some(w => /bitiyor/.test(w.text)), 'two months out is not worth shouting about');

    await db.exec('UPDATE np_licence SET expires_at=DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id=1');
    r = await api('GET', '/api/device/connection');
    assert.ok(r.warnings.some(w => w.level === 'error' && /süresi doldu/.test(w.text)));
    await db.exec('UPDATE np_licence SET expires_at=DATE_ADD(NOW(), INTERVAL 365 DAY) WHERE id=1');
  });

  await step('the connection screen shows the address the phones should use', async () => {
    const r = await api('GET', '/api/device/connection');
    assert.strictEqual(r.lan.port, config.port);
    assert.ok(Array.isArray(r.lan.addresses));
    assert.ok(r.lan.addresses.every(a => a.endsWith(':' + config.port)),
      'an address without the port is not typeable: ' + JSON.stringify(r.lan.addresses));
    assert.ok(r.device_id, 'this PC has no identity to quote to support');
    assert.ok(r.panel_url);
    assert.ok(r.outbox, 'connection state must carry the queue - it is the same question');
  });

  await step('a relay that has not polled recently is not reported as connected', async () => {
    /*
     * The whole question here is what the connection screen says about the
     * relay, and it says nothing at all when the feature is switched off -
     * correctly, since there is no connection to report. run-all.sh turns
     * relay_enabled off for the run (a background long-poll from every suite
     * puts the sandbox panel's workers to sleep; see the note there), so this
     * check turns it back on for its own three questions.
     */
    await db.setSetting('relay_enabled', '1');
    await db.exec('UPDATE np_relay_state SET last_poll_at=DATE_SUB(NOW(), INTERVAL 10 MINUTE), consecutive_errors=0 WHERE id=1');
    let r = await api('GET', '/api/device/connection');
    assert.strictEqual(r.relay.connected, false, 'a ten minute old poll is not a live connection');

    // and a poller that is failing every 1.5s keeps last_poll_at fresh - so
    // freshness alone must not be enough to call it healthy
    await db.exec('UPDATE np_relay_state SET last_poll_at=NOW(), consecutive_errors=7 WHERE id=1');
    r = await api('GET', '/api/device/connection');
    assert.strictEqual(r.relay.connected, false, 'a failing poller was reported as connected');
    assert.strictEqual(r.relay.consecutive_errors, 7);
    assert.ok(r.warnings.some(w => /uzaktan bağlantı/i.test(w.text)), 'a dead relay was not mentioned');

    await db.exec('UPDATE np_relay_state SET last_poll_at=NOW(), consecutive_errors=0 WHERE id=1');
    r = await api('GET', '/api/device/connection');
    assert.strictEqual(r.relay.connected, true);
    await db.setSetting('relay_enabled', '0');
  });

  /* ========================= 6. İŞLEM GÜNLÜĞÜ ========================== */

  await step('the activity log filters by area, level, text and date', async () => {
    await db.exec("DELETE FROM np_app_log WHERE area IN ('cihaztest','cihaztest2')");
    await db.exec(
      `INSERT INTO np_app_log (level, area, message, detail, created_at) VALUES
       ('error','cihaztest','Yazici bulunamadi','{"ip":"192.168.1.50"}', NOW()),
       ('warn','cihaztest','Kuyruk birikti','{"pending":41}', NOW()),
       ('info','cihaztest','Cihaz eslendi','{"device_id":"abc"}', NOW()),
       ('info','cihaztest2','Baska alan','{}', NOW()),
       ('error','cihaztest','Eski hata','{}', DATE_SUB(NOW(), INTERVAL 20 DAY))`);

    const all = await api('GET', '/api/device/log?area=cihaztest&limit=50');
    assert.strictEqual(all.status, 200, JSON.stringify(all));
    assert.strictEqual(all.total, 4, 'area filter is wrong: ' + all.total);
    assert.ok(all.rows.every(r => r.area === 'cihaztest'));

    const errs = await api('GET', '/api/device/log?area=cihaztest&level=error');
    assert.strictEqual(errs.total, 2, 'level filter is wrong: ' + errs.total);

    const problems = await api('GET', '/api/device/log?area=cihaztest&only_problems=1');
    assert.strictEqual(problems.total, 3, 'error+warn filter is wrong: ' + problems.total);

    const search = await api('GET', '/api/device/log?q=Yazici');
    assert.ok(search.rows.some(r => r.message === 'Yazici bulunamadi'), 'message search missed');
    const inDetail = await api('GET', '/api/device/log?q=192.168.1.50');
    assert.ok(inDetail.rows.some(r => r.message === 'Yazici bulunamadi'),
      'the useful string is usually in the detail, and it was not searched');

    const today = new Date().toISOString().slice(0, 10);
    const recent = await api('GET', `/api/device/log?area=cihaztest&from=${today}`);
    assert.strictEqual(recent.total, 3, 'the twenty day old row was not excluded by the date filter');
    assert.ok(recent.areas.some(a => a.area === 'cihaztest'), 'the area list the filter draws from is empty');
  });

  await step('the log pages rather than returning everything at once', async () => {
    const first = await api('GET', '/api/device/log?area=cihaztest&limit=2');
    assert.strictEqual(first.rows.length, 2);
    assert.strictEqual(first.limit, 2);
    const second = await api('GET', '/api/device/log?area=cihaztest&limit=2&offset=2');
    assert.strictEqual(second.offset, 2);
    assert.notStrictEqual(first.rows[0].id, second.rows[0].id, 'paging returned the same page twice');
  });

  await step('the device actions themselves are written to the log', async () => {
    const r = await api('GET', '/api/device/log?area=device&limit=20');
    assert.ok(r.rows.some(x => /ön eki/i.test(x.message)),
      'handing out a bill-number prefix left no trace for support');
  });

  /* ============================ 7. YETKİ ============================== */

  await step('a waiter cannot see the device list but a manager can read the log', async () => {
    const waiter = await auth.issueToken({ cid: CID, uid: 0, role: 'waiter', name: 'Garson', kind: 'pos' });
    const denied = await api('GET', '/api/device/devices', null, waiter);
    assert.strictEqual(denied.status, 403, 'a waiter can list and revoke devices');
    const cashier = await auth.issueToken({ cid: CID, uid: 0, role: 'cashier', name: 'Kasiyer', kind: 'pos' });
    const log = await api('GET', '/api/device/log?limit=1', null, cashier);
    assert.strictEqual(log.status, 200, 'a cashier with report.view cannot answer "what happened at 19:40"');
  });

  /* ================================ sonuç ============================== */
  await db.setSetting('panel_url', process.env.PANEL || 'http://127.0.0.1:8090');
  /*
   * Pairing, and the one message that cost a real manager twenty minutes.
   *
   * A waiter created PIN-only has no phone password by design. Pairing used to
   * answer that with "Kullanıcı adı veya şifre hatalı" - the same words as a
   * mistyped password - so the log shows six pairing codes generated and burned
   * in twenty minutes, and an attempt to fix it by setting a PIN, which is a
   * different credential entirely.
   */
  await step('pairing tells a PIN-only waiter that he has no phone password', async () => {
    const auth2 = require('../src/auth');
    const uname = 'pinonly' + String(Date.now()).slice(-6);
    const uid = await require('../src/modules/catalog').saveUser(CID,
      { display_name: 'Pinli Garson', username: uname, role: 'waiter', pin: '4417' }, null);
    await db.exec("UPDATE users SET password_hash='' WHERE id=?", [uid]);
    try {
      await auth2.staffLogin(CID, uname, 'herhangibirsey');
      assert.fail('sifresiz personel giris yapabildi');
    } catch (e) {
      assert.strictEqual(e.code, 'NO_PHONE_PASSWORD', 'yanlis hata: ' + e.message);
      assert.match(e.message, /telefon sifresi tanimli degil/i);
      assert.ok(!/Kullanici adi veya sifre hatali/i.test(e.message),
        'hala "sifre hatali" diyor - duzeltilen sey buydu');
    }
    /* and with a password set, the ordinary wrong-password answer comes back */
    await require('../src/modules/catalog').saveUser(CID, { id: uid, display_name: 'Pinli Garson',
      role: 'waiter', is_active: 1, password: 'telefon1234' }, null);
    await assert.rejects(() => auth2.staffLogin(CID, uname, 'yanlis'), /Kullanici adi veya sifre hatali/i);
    await db.exec('DELETE FROM users WHERE id=?', [uid]);
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
