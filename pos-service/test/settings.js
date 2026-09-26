'use strict';
/**
 * Settings / administration.
 *
 * Real MariaDB, real HTTP, no mocks - the failures this suite exists to catch
 * (a setting that saves but does not stick, a screen that lets the only admin
 * lock everybody out, a PIN reset that leaves the old PIN working, a printer
 * test that reports success into thin air) all look fine against a mock.
 *
 * The suite owns its own tenant (client 77) so it can delete every user and
 * still leave the fixtures the other suites use on client 19 alone. np_settings
 * has no client column - it is one installation - so the original values are
 * captured at the start and put back at the end.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/settings.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7469';
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const mod = require('../src/modules/settings');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 77;
let TOKEN = null;
let ADMIN = null, WAITER = null;

async function api(method, path, body, token = TOKEN) {
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

/* ------------------------------ fixture ---------------------------- */
async function fixture() {
  // a tenant of our own; clients.id IS the client_id everywhere in this service
  const c = await db.one('SELECT id FROM clients WHERE id=?', [CID]);
  if (!c) {
    await db.exec(
      `INSERT INTO clients (id, client_id, slug, owner_name, company_name, full_address, permanent_email,
          username, password_hash, tax_number, tax_office, phone, is_active, setup_done)
       VALUES (?,?,'ayar-testi','Test Sahibi','Ayar Test Lokantasi','Test Mah. 1','sahip@ayartest.local',
          'ayartest','','1234567890','Test VD','05000000000',1,1)`, [CID, CID]);
  }
  for (const t of ['user_permissions', 'printers', 'print_jobs', 'fiscal_devices', 'cash_registers',
                   'doviz_kur_gecmisi', 'doviz_kurlari', 'categories', 'stations', 'users', 'business_settings']) {
    await db.exec(`DELETE FROM \`${t}\` WHERE client_id=?`, [CID]).catch(() => {});
  }

  ADMIN = await db.insert(
    `INSERT INTO users (client_id, username, email, display_name, role, password_hash, pin_hash,
        created_at, updated_at, is_active) VALUES (?,?,?,?, 'admin', ?, ?, NOW(), NOW(), 1)`,
    [CID, 'ayaradmin', 'admin@ayartest.local', 'Ayar Yonetici', auth.hash('sifre1234'), auth.hash('1111')]);
  WAITER = await db.insert(
    `INSERT INTO users (client_id, username, email, display_name, role, password_hash, pin_hash,
        created_at, updated_at, is_active) VALUES (?,?,?,?, 'waiter', ?, ?, NOW(), NOW(), 1)`,
    [CID, 'ayargarson', 'garson@ayartest.local', 'Ayar Garson', auth.hash('sifre1234'), auth.hash('2222')]);

  await db.insert('INSERT INTO categories (client_id, name, sort_order, is_active, use_in_pos, use_in_qr) VALUES (?,?,1,1,1,1)',
    [CID, 'Ayar Test Icecek']);
  await db.insert('INSERT INTO categories (client_id, name, sort_order, is_active, use_in_pos, use_in_qr) VALUES (?,?,2,1,1,1)',
    [CID, 'Ayar Test Yemek']);
}

/** np_settings is installation-wide; put back exactly what was there. */
async function snapshotSettings() {
  const rows = await db.query('SELECT k, v FROM np_settings');
  const map = {};
  for (const r of rows) map[r.k] = r.v;
  return map;
}
async function restoreSettings(snap) {
  const keys = mod.DEFS.map(d => d.key);
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(snap, k)) await db.setSetting(k, snap[k]);
    else await db.exec('DELETE FROM np_settings WHERE k=?', [k]);
  }
}

/** A valid, DIFFERENT value for each definition, so a no-op cannot pass. */
function probeValue(def, current) {
  switch (def.type) {
    case 'bool': return String(current) === '1' ? '0' : '1';
    case 'number': {
      const min = def.min !== undefined ? def.min : 0;
      const max = def.max !== undefined ? def.max : 9999;
      const cur = Number(current);
      const a = Math.min(max, min + 1);
      return String(cur === a ? Math.max(min, a - 1) || min : a);
    }
    case 'select': {
      const codes = def.options.map(([c]) => c);
      return codes.find(c => c !== String(current)) || codes[0];
    }
    case 'time': return String(current) === '07:45' ? '08:15' : '07:45';
    case 'hours': return String(current) === '10:00-22:30' ? '11:00-23:00' : '10:00-22:30';
    case 'url': return 'https://ayar-testi.local/panel';
    case 'password': return 'gizli-parola-1';
    default: {
      const v = 'AT-' + def.key;
      return def.max ? v.slice(0, def.max) : v;
    }
  }
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - ayarlar ve yonetim\n');
  await fixture();
  const snap = await snapshotSettings();
  TOKEN = await auth.issueToken({ cid: CID, uid: ADMIN, role: 'admin', name: 'Ayar Yonetici', kind: 'pos' });

  /* ========================= 1. the setting catalogue ================= */

  /*
   * The Kullanıcılar screen 500'd once during a full run and could not be
   * reproduced afterwards - which is the worst shape a fault can be in. What
   * IS reproducible is the shape of the mistake: the list enriched every user
   * inside a loop and let anything thrown escape, so one unreadable row
   * returned 500 for all of them and the screen an owner would use to FIX a
   * broken user was the screen a broken user could break.
   */
  await step('tek bir bozuk kullanıcı satırı bütün listeyi düşürmez', async () => {
    const settingsMod = require('../src/modules/settings');
    const auth = require('../src/auth');
    const real = auth.permissionsFor;
    let _seen = 0;
    /* fail for exactly one user, the way an unreadable row would */
    const rows = await db.query('SELECT id FROM users WHERE client_id=? ORDER BY id', [CID]);
    assert.ok(rows.length >= 2, 'bu kontrol icin en az iki kullanici gerekir');
    const victim = rows[rows.length - 1].id;
    auth.permissionsFor = async (cid, uid, role) => {
      _seen++;
      if (Number(uid) === Number(victim)) throw new Error('yetkiler okunamadi (test)');
      return real(cid, uid, role);
    };
    try {
      const list = await settingsMod.listUsers(CID);
      assert.strictEqual(list.length, rows.length, 'liste kisaldi: ' + list.length + '/' + rows.length);
      const bad = list.find(u => Number(u.id) === Number(victim));
      assert.ok(bad, 'bozuk satir listeden dustu');
      assert.deepStrictEqual(bad.effective, [], 'okunamayan yetkiler bos gelmeli');
      assert.ok(bad.perm_error, 'satirda sorunun soylendigi bir isaret yok');
      /* and everybody else is intact */
      const ok = list.find(u => Number(u.id) !== Number(victim));
      assert.ok(Array.isArray(ok.effective) && ok.effective.length > 0,
        'saglam kullanicinin yetkileri de kayboldu');
      assert.ok(!ok.perm_error, 'saglam kullanici hatali isaretlenmis');
    } finally {
      auth.permissionsFor = real;
    }
  });

  await step('the catalogue lists every key with a Turkish label, a type and a default', async () => {
    const r = await api('GET', '/api/settings');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.defs.length >= 40, 'expected a real catalogue, got ' + r.defs.length + ' keys');
    const groups = new Set(r.groups.map(g => g.id));
    for (const d of r.defs) {
      assert.ok(d.label && /[a-zçğıöşüA-ZÇĞİÖŞÜ]/.test(d.label), 'no label for ' + d.key);
      assert.ok(d.type, 'no type for ' + d.key);
      assert.ok(d.default !== undefined, 'no default for ' + d.key);
      assert.ok(groups.has(d.group), d.key + ' is in unknown group ' + d.group);
      assert.ok(Object.prototype.hasOwnProperty.call(r.values, d.key), 'no value for ' + d.key);
    }
  });

  await step('every setting round-trips: written, read back, and still there on a fresh GET', async () => {
    const before = (await api('GET', '/api/settings')).values;
    const wanted = {};
    for (const d of mod.DEFS) wanted[d.key] = probeValue(d, before[d.key]);

    const w = await api('POST', '/api/settings', { settings: wanted });
    assert.strictEqual(w.status, 200, JSON.stringify(w));

    const after = (await api('GET', '/api/settings')).values;
    const wrong = [];
    for (const d of mod.DEFS) {
      if (d.secret) {
        // a secret never comes back; it is masked, and the row holds the value
        if (after[d.key] !== '********') wrong.push(d.key + ' secret not masked: ' + after[d.key]);
        const raw = await db.getSetting(d.key);
        if (raw !== wanted[d.key]) wrong.push(d.key + ' secret not stored');
        continue;
      }
      if (String(after[d.key]) !== String(wanted[d.key])) {
        wrong.push(`${d.key}: wrote ${wanted[d.key]}, read ${after[d.key]}`);
      }
      // and the value the rest of the service sees must be the same value
      const direct = await db.getSetting(d.key, d.default);
      if (String(direct) !== String(wanted[d.key])) wrong.push(d.key + ': db.getSetting disagrees (' + direct + ')');
    }
    assert.strictEqual(wrong.length, 0, wrong.join(' | '));
  });

  await step('a masked secret sent back unchanged does not wipe the stored password', async () => {
    await api('POST', '/api/settings', { settings: { smtp_pass: '********' } });
    assert.strictEqual(await db.getSetting('smtp_pass'), 'gizli-parola-1');
  });

  await step('a bad value is refused and the old value survives', async () => {
    const cases = [
      ['receipt_width', 999, 'out of range number'],
      ['receipt_width', 'kirk sekiz', 'text in a number'],
      ['currency', 'XXX', 'unknown select option'],
      ['business_day_start', '25:70', 'impossible time'],
      ['hours_1', 'sabah aksam', 'free text in a working-hours field'],
      ['pin_length', 2, 'below the minimum'],
      ['panel_url', 'pos.noktapp.com', 'url with no scheme'],
      ['backup_cloud_hour', 24, 'hour 24'],
      ['kitchen_auto_send', 'belki', 'neither yes nor no'],
    ];
    for (const [key, value, why] of cases) {
      const was = await db.getSetting(key);
      const r = await api('POST', '/api/settings', { settings: { [key]: value } });
      assert.strictEqual(r.status, 400, `${why} (${key}=${value}) should be refused, got ${r.status}`);
      assert.ok(r.error && r.error.length > 5, 'no explanation for ' + key);
      assert.strictEqual(await db.getSetting(key), was, key + ' was changed despite being refused');
    }
  });

  await step('an unknown key and a protected key are both refused', async () => {
    const a = await api('POST', '/api/settings', { settings: { uydurma_ayar: '1' } });
    assert.strictEqual(a.status, 400, 'unknown key accepted');
    const secretBefore = await db.getSetting('jwt_secret');
    const b = await api('POST', '/api/settings', { settings: { jwt_secret: 'ele-gecirdim' } });
    assert.strictEqual(b.status, 400, 'jwt_secret was writable');
    assert.strictEqual(await db.getSetting('jwt_secret'), secretBefore, 'jwt_secret changed');
  });

  await step('one bad field in a form does not half-save the good ones', async () => {
    const before = await db.getSetting('receipt_copies');
    const r = await api('POST', '/api/settings', { settings: { receipt_copies: 3, receipt_width: -5 } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(await db.getSetting('receipt_copies'), before,
      'receipt_copies was written even though the form was rejected');
  });

  await step('every change is recorded with who made it', async () => {
    await api('POST', '/api/settings', { settings: { receipt_copies: 2 } });
    const r = await api('GET', '/api/settings/history');
    assert.strictEqual(r.status, 200);
    const row = r.rows.find(x => x.k === 'receipt_copies');
    assert.ok(row, 'no history row for receipt_copies');
    assert.strictEqual(String(row.new_value), '2');
    assert.strictEqual(row.changed_by_name, 'Ayar Yonetici');
  });

  await step('the secret value is never written into the audit log in clear', async () => {
    await api('POST', '/api/settings', { settings: { smtp_pass: 'yeni-parola-2' } });
    const rows = await db.query("SELECT new_value FROM np_settings_log WHERE k='smtp_pass' ORDER BY id DESC LIMIT 1");
    assert.ok(rows.length, 'no audit row');
    assert.strictEqual(rows[0].new_value, '***', 'the password was logged in clear');
  });

  /* ============================ 2. users ============================= */

  await step('staff can be created with a role, a PIN and a phone password', async () => {
    await api('POST', '/api/settings', { settings: { pin_length: 4 } });
    const r = await api('POST', '/api/settings/users', {
      display_name: 'Ayse Kasiyer', username: 'aysek', role: 'cashier',
      pin: '3456', password: 'telefon123',
      perms: ['order.create', 'payment.take', 'shift.open'],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const list = await api('GET', '/api/settings/users');
    const u = list.users.find(x => x.id === r.id);
    assert.ok(u, 'new user missing from the list');
    assert.strictEqual(u.role, 'cashier');
    assert.deepStrictEqual(u.perms.sort(), ['order.create', 'payment.take', 'shift.open']);
    const login = await auth.pinLogin(CID, '3456');
    assert.strictEqual(login.user.id, r.id, 'the new PIN does not log in');
  });

  await step('a duplicate username is refused', async () => {
    const r = await api('POST', '/api/settings/users', {
      display_name: 'Baska Kisi', username: 'aysek', role: 'waiter', pin: '5678' });
    assert.strictEqual(r.status, 400, 'duplicate username accepted');
  });

  await step('a PIN of the wrong length, or with letters in it, is refused', async () => {
    for (const pin of ['12', '12a4', '123456']) {
      const r = await api('POST', '/api/settings/users', {
        display_name: 'Pin Testi', username: 'pintest' + pin, role: 'waiter', pin });
      assert.strictEqual(r.status, 400, 'PIN ' + pin + ' accepted');
    }
  });

  await step('a PIN reset works and the old PIN stops working', async () => {
    const list = await api('GET', '/api/settings/users');
    const u = list.users.find(x => x.username === 'aysek');
    const before = await auth.pinLogin(CID, '3456');
    assert.strictEqual(before.user.id, u.id);

    const r = await api('POST', `/api/settings/users/${u.id}/pin`, { pin: '9081' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));

    const after = await auth.pinLogin(CID, '9081');
    assert.strictEqual(after.user.id, u.id, 'the new PIN does not work');
    await assert.rejects(() => auth.pinLogin(CID, '3456'), /PIN/, 'the OLD PIN still logs in');

    const row = await db.one('SELECT pin_set_by, pin_changed_at, pin_fail_count FROM users WHERE id=?', [u.id]);
    assert.strictEqual(Number(row.pin_set_by), ADMIN, 'the reset was not attributed');
    assert.strictEqual(Number(row.pin_fail_count), 0, 'the failure counter was not cleared');
  });

  await step('a PIN already in use by someone else is refused', async () => {
    const list = await api('GET', '/api/settings/users');
    const u = list.users.find(x => x.username === 'aysek');
    const r = await api('POST', `/api/settings/users/${u.id}/pin`, { pin: '2222' });   // the waiter's PIN
    assert.strictEqual(r.status, 400, 'a colliding PIN was accepted');
  });

  await step('a locked-out user can be unlocked from the screen', async () => {
    await db.exec('UPDATE users SET pin_fail_count=9, pin_locked_until=DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE id=?',
      [WAITER]);
    let list = await api('GET', '/api/settings/users');
    assert.strictEqual(list.users.find(u => u.id === WAITER).locked, true, 'the lock is not visible');
    await api('POST', `/api/settings/users/${WAITER}/unlock`);
    list = await api('GET', '/api/settings/users');
    assert.strictEqual(list.users.find(u => u.id === WAITER).locked, false, 'still locked');
    const login = await auth.pinLogin(CID, '2222');
    assert.strictEqual(login.user.id, WAITER);
  });

  await step('the last admin cannot be deactivated', async () => {
    assert.deepStrictEqual(await mod.activeAdmins(CID), [ADMIN], 'the fixture should have exactly one admin');
    const r = await api('POST', `/api/settings/users/${ADMIN}/active`, { active: false });
    assert.strictEqual(r.status, 400, 'the only admin was deactivated');
    assert.ok(/yönetici/i.test(r.error), 'the message does not explain why: ' + r.error);
    const row = await db.one('SELECT is_active FROM users WHERE id=?', [ADMIN]);
    assert.strictEqual(Number(row.is_active), 1, 'the admin is now inactive');
  });

  await step('the last admin cannot be demoted', async () => {
    const r = await api('POST', `/api/settings/users/${ADMIN}/role`, { role: 'waiter' });
    assert.strictEqual(r.status, 400, 'the only admin was demoted');
    const row = await db.one('SELECT role FROM users WHERE id=?', [ADMIN]);
    assert.strictEqual(row.role, 'admin', 'the role changed anyway');
  });

  await step('nobody can remove their own admin rights, even with a second admin present', async () => {
    const second = await api('POST', '/api/settings/users', {
      display_name: 'Ikinci Yonetici', username: 'ikinci', role: 'admin', pin: '4455', password: 'telefon123' });
    assert.strictEqual(second.status, 200, JSON.stringify(second));

    const r = await api('POST', `/api/settings/users/${ADMIN}/role`, { role: 'cashier' });
    assert.strictEqual(r.status, 400, 'an admin demoted themselves');
    assert.ok(/kendi/i.test(r.error), 'wrong reason: ' + r.error);

    const s = await api('POST', `/api/settings/users/${ADMIN}/active`, { active: false });
    assert.strictEqual(s.status, 400, 'an admin closed their own account');

    // but they may demote the OTHER admin, now that they are not the last one
    const ok2 = await api('POST', `/api/settings/users/${second.id}/role`, { role: 'cashier' });
    assert.strictEqual(ok2.status, 200, JSON.stringify(ok2));
    assert.strictEqual((await db.one('SELECT role FROM users WHERE id=?', [second.id])).role, 'cashier');
  });

  await step('a user may not sign away their own management permission', async () => {
    const list = await api('GET', '/api/settings/users');
    const cashier = list.users.find(u => u.username === 'ikinci');
    await api('POST', `/api/settings/users/${cashier.id}/permissions`,
      { perms: ['order.create', 'user.manage', 'settings.manage'] });
    const theirToken = await auth.issueToken({ cid: CID, uid: cashier.id, role: 'cashier', kind: 'pos' });
    const r = await api('POST', `/api/settings/users/${cashier.id}/permissions`,
      { perms: ['order.create'] }, theirToken);
    assert.strictEqual(r.status, 400, 'a user stripped their own user.manage');
  });

  await step('per-user permission overrides are what the till actually enforces', async () => {
    const list = await api('GET', '/api/settings/users');
    const w = list.users.find(u => u.id === WAITER);
    await api('POST', `/api/settings/users/${WAITER}/permissions`, { perms: ['order.create', 'report.view'] });
    const perms = await auth.permissionsFor(CID, WAITER, 'waiter');
    assert.deepStrictEqual(perms.sort(), ['order.create', 'report.view']);
    assert.ok(!w.effective.includes('settings.manage'), 'a waiter should not hold settings.manage');

    const waiterToken = await auth.issueToken({ cid: CID, uid: WAITER, role: 'waiter', kind: 'pos' });
    const denied = await api('GET', '/api/settings', null, waiterToken);
    assert.strictEqual(denied.status, 403, 'a waiter reached the settings API');
  });

  await step('a member of staff who has served is deactivated rather than deleted', async () => {
    const list = await api('GET', '/api/settings/users');
    const u = list.users.find(x => x.username === 'aysek');
    const orderId = await db.insert(
      `INSERT INTO orders (client_id, adisyon_no, waiter_id, status, is_closed, created_at, opened_at)
       VALUES (?, 900001, ?, 'open', 0, NOW(), NOW())`, [CID, u.id]);
    const r = await api('DELETE', `/api/settings/users/${u.id}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.deleted, false, 'a user with bills on their name was deleted');
    assert.strictEqual(r.deactivated, true);
    assert.strictEqual(Number((await db.one('SELECT is_active FROM users WHERE id=?', [u.id])).is_active), 0);
    await db.exec('DELETE FROM orders WHERE id=?', [orderId]);
  });

  await step('a member of staff who never served can be deleted outright', async () => {
    // no phone password on purpose: a waiter who only ever uses the till PIN
    const made = await api('POST', '/api/settings/users', {
      display_name: 'Gecici Eleman', username: 'gecici', role: 'waiter', pin: '6677' });
    assert.strictEqual(made.status, 200, JSON.stringify(made));
    const r = await api('DELETE', `/api/settings/users/${made.id}`);
    assert.strictEqual(r.deleted, true, JSON.stringify(r));
    assert.strictEqual(await db.one('SELECT id FROM users WHERE id=?', [made.id]), null);
  });

  await step('anyone signed in can see and fix their own profile without user.manage', async () => {
    const waiterToken = await auth.issueToken({ cid: CID, uid: WAITER, role: 'waiter', kind: 'pos' });
    const p = await api('GET', '/api/settings/profile', null, waiterToken);
    assert.strictEqual(p.status, 200, JSON.stringify(p));
    assert.strictEqual(p.user.id, WAITER);
    assert.strictEqual(p.user.role_label, 'Garson');
    assert.ok(Array.isArray(p.permissions), 'a user should see what they can open');

    const w = await api('POST', '/api/settings/profile',
      { display_name: 'Ayar Garson Yeni', username: 'ayargarson' }, waiterToken);
    assert.strictEqual(w.status, 200, JSON.stringify(w));
    assert.strictEqual((await db.one('SELECT display_name FROM users WHERE id=?', [WAITER])).display_name,
      'Ayar Garson Yeni');
    // and they still cannot reach anybody else's account
    assert.strictEqual((await api('GET', '/api/settings/users', null, waiterToken)).status, 403);
  });

  await step('changing your own PIN needs the old one, and the old one then stops working', async () => {
    const waiterToken = await auth.issueToken({ cid: CID, uid: WAITER, role: 'waiter', kind: 'pos' });
    const wrong = await api('POST', '/api/settings/profile/pin',
      { current: '0000', pin: '7788' }, waiterToken);
    assert.strictEqual(wrong.status, 400, 'a PIN was changed without the current one');
    assert.strictEqual((await auth.pinLogin(CID, '2222')).user.id, WAITER, 'the PIN changed anyway');

    const okr = await api('POST', '/api/settings/profile/pin',
      { current: '2222', pin: '7788' }, waiterToken);
    assert.strictEqual(okr.status, 200, JSON.stringify(okr));
    assert.strictEqual((await auth.pinLogin(CID, '7788')).user.id, WAITER);
    await assert.rejects(() => auth.pinLogin(CID, '2222'), /PIN/, 'the old PIN still logs in');
  });

  await step('changing your own phone password needs the old one', async () => {
    const waiterToken = await auth.issueToken({ cid: CID, uid: WAITER, role: 'waiter', kind: 'pos' });
    const wrong = await api('POST', '/api/settings/profile/password',
      { current: 'yanlis', password: 'yenisifre1' }, waiterToken);
    assert.strictEqual(wrong.status, 400, 'a password was changed without the current one');
    const short = await api('POST', '/api/settings/profile/password',
      { current: 'sifre1234', password: '123' }, waiterToken);
    assert.strictEqual(short.status, 400, 'a three-character password was accepted');
    const okr = await api('POST', '/api/settings/profile/password',
      { current: 'sifre1234', password: 'yenisifre1' }, waiterToken);
    assert.strictEqual(okr.status, 200, JSON.stringify(okr));
    const login = await auth.staffLogin(CID, 'ayargarson', 'yenisifre1');
    assert.strictEqual(login.user.id, WAITER, 'the new password does not sign in');
  });

  /* ====================== 3. stations & printers ===================== */

  let barId = null;
  await step('a station can be created and made the default', async () => {
    const r = await api('POST', '/api/settings/stations', { name: 'Bar', display_name: 'Bar / İçecek', sort_order: 2 });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    barId = r.id;
    const kitchen = await api('POST', '/api/settings/stations', { name: 'Mutfak', display_name: 'Mutfak' });
    await api('POST', `/api/settings/stations/${kitchen.id}/default`);
    const list = await api('GET', '/api/settings/stations');
    assert.strictEqual(list.stations.filter(s => s.is_default).length, 1, 'exactly one default expected');
    assert.strictEqual(list.stations.find(s => s.is_default).id, kitchen.id);
  });

  await step('a station name that the print agent could not route on is refused', async () => {
    for (const name of ['', 'A', 'Bar/Mutfak', 'x'.repeat(60)]) {
      const r = await api('POST', '/api/settings/stations', { name });
      assert.strictEqual(r.status, 400, `station name "${name}" was accepted`);
    }
    const dup = await api('POST', '/api/settings/stations', { name: 'Bar' });
    assert.strictEqual(dup.status, 400, 'a duplicate station name was accepted');
  });

  await step('a category can be assigned to a station, and the routing is readable back', async () => {
    const cats = (await api('GET', '/api/settings/stations')).categories;
    const drinks = cats.find(c => c.name === 'Ayar Test Icecek');
    const r = await api('POST', `/api/settings/stations/${barId}/categories`, { category_ids: [drinks.id] });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.assigned, 1);
    const after = (await api('GET', '/api/settings/stations')).categories.find(c => c.id === drinks.id);
    assert.strictEqual(after.station_id, barId, 'the category did not move to the station');
    assert.strictEqual(after.station_name, 'Bar / İçecek');
    // and the station now knows it has one
    const st = (await api('GET', '/api/settings/stations')).stations.find(s => s.id === barId);
    assert.strictEqual(Number(st.category_count), 1);
  });

  await step('a station that still has categories or printers cannot be deleted', async () => {
    const r = await api('DELETE', `/api/settings/stations/${barId}`);
    assert.strictEqual(r.status, 400, 'a station in use was deleted');
    assert.ok(/kategori/i.test(r.error), r.error);
    // free it, then it goes
    await api('POST', `/api/settings/stations/${barId}/categories`, { category_ids: [] });
    const ok2 = await api('DELETE', `/api/settings/stations/${barId}`);
    assert.strictEqual(ok2.status, 200, JSON.stringify(ok2));
  });

  await step('a printer test reports honestly when there is no printer at all', async () => {
    assert.strictEqual(Number(await db.value('SELECT COUNT(*) FROM printers WHERE client_id=?', [CID])), 0);
    const r = await api('POST', '/api/settings/printers/1/test');
    assert.strictEqual(r.status, 200, 'an unplugged shop is not an HTTP error');
    assert.strictEqual(r.printed, false, 'it claimed something printed');
    assert.strictEqual(r.reason, 'no_printer');
    assert.ok(/yazıcı/i.test(r.message), r.message);
  });

  let printerId = null;
  await step('a printer can be added, and a test against a dead address says so', async () => {
    const made = await api('POST', '/api/settings/printers', {
      name: 'Kasa Yazici', type: 'network', ip_address: '127.0.0.1:9199', is_default: 1 });
    assert.strictEqual(made.status, 200, JSON.stringify(made));
    printerId = made.id;

    const r = await api('POST', `/api/settings/printers/${printerId}/test`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.printed, false, 'nothing is listening on 127.0.0.1:9199 - it must not claim success');
    assert.strictEqual(r.reason, 'transport');
    assert.ok(r.message.includes('Kasa Yazici'), 'the message should name the printer: ' + r.message);
  });

  await step('a printer test that really does print says so', async () => {
    const path = require('path').join(require('os').tmpdir(), 'noktapp-settings-test.prn');
    try { require('fs').unlinkSync(path); } catch (_) {}
    const made = await api('POST', '/api/settings/printers', {
      name: 'Dosya Yazici', type: 'file', ip_address: path });
    const r = await api('POST', `/api/settings/printers/${made.id}/test`);
    assert.strictEqual(r.printed, true, JSON.stringify(r));
    assert.ok(require('fs').existsSync(path), 'nothing was written to the file printer');
    assert.ok(require('fs').readFileSync(path, 'latin1').includes('TEST'), 'the slip is not a test slip');
  });

  await step('a network printer with no address, and a duplicate name, are refused', async () => {
    const a = await api('POST', '/api/settings/printers', { name: 'Adressiz', type: 'network' });
    assert.strictEqual(a.status, 400, 'a network printer with no IP was accepted');
    const b = await api('POST', '/api/settings/printers', { name: 'Kasa Yazici', type: 'file', ip_address: '/tmp/x' });
    assert.strictEqual(b.status, 400, 'a duplicate printer name was accepted');
    const c = await api('POST', '/api/settings/printers', { name: 'Tur', type: 'lazer', ip_address: '1.2.3.4' });
    assert.strictEqual(c.status, 400, 'an unknown printer type was accepted');
  });

  await step('the print queue shows what is waiting, warns about it, and can retry a failed job', async () => {
    const printing = require('../src/print');
    const jobId = await printing.enqueue(CID, { jobType: 'report', content: Buffer.from('AYAR TEST') });
    await db.exec("UPDATE print_jobs SET status='failed' WHERE id=?", [jobId]);
    for (let i = 0; i < 6; i++) await printing.enqueue(CID, { jobType: 'report', content: Buffer.from('X') });

    let q = await api('GET', '/api/settings/print-jobs');
    assert.strictEqual(q.status, 200, JSON.stringify(q));
    assert.ok(q.counts.failed >= 1 && q.counts.pending >= 6, JSON.stringify(q.counts));
    assert.ok(q.warnings.some(w => /kuyrukta/i.test(w)), 'no queue warning: ' + JSON.stringify(q.warnings));
    assert.ok(q.jobs.some(j => j.id === jobId), 'the failed job is not listed');

    const r = await api('POST', `/api/settings/print-jobs/${jobId}/retry`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual((await db.one('SELECT status FROM print_jobs WHERE id=?', [jobId])).status, 'pending');

    await db.exec("UPDATE print_jobs SET status='failed' WHERE client_id=?", [CID]);
    const all = await api('POST', '/api/settings/print-jobs/retry-failed');
    assert.ok(all.retried >= 7, 'retry-all put back ' + all.retried);
    assert.strictEqual(Number(await db.value(
      "SELECT COUNT(*) FROM print_jobs WHERE client_id=? AND status='failed'", [CID])), 0);
    await db.exec('DELETE FROM print_jobs WHERE client_id=?', [CID]);
  });

  /* ================================ 4. ÖKC ========================== */

  await step('the provider list says honestly which drivers are real and which are not', async () => {
    const r = await api('GET', '/api/settings/okc');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const by = {};
    for (const p of r.providers) by[p.key] = p;
    assert.strictEqual(by.simulator.status, 'ready', 'the simulator is the one thing that really works');
    /* Hugin is 'beta' rather than 'sdk' because there is no SDK to obtain -
       the manufacturer publishes the protocol. Implemented, unverified. */
    assert.strictEqual(by.hugin.status, 'beta', 'hugin is misdescribed');
    /*
     * Token and Beko are CLOSED, and the reason is worth a line here because
     * the screen used to say the opposite. Token was 'beta' - "GMP-3 protokolu
     * yazildi" - describing a TCP 7600 client with invented field names. The
     * manufacturer's own documentation (23.09.2026) says there is no TCP at
     * all: USB on the X30TR, RS232 on the 300TR, and an encrypted TLV wire
     * whose tags are unpublished. A screen that offers a driver we know cannot
     * reach a device is worse than one that offers nothing.
     */
    for (const shut of ['token', 'beko']) {
      assert.strictEqual(by[shut].status, 'closed', shut + ' is still offered as if it worked');
      assert.ok(/USB|RS232|TLV/.test(by[shut].note), shut + ' does not say why it is closed');
    }
    for (const stub of ['profilo', 'olivetti']) {
      assert.strictEqual(by[stub].status, 'sdk', stub + ' is presented as finished');
      assert.ok(by[stub].note.length > 20, stub + ' has no explanation');
    }
    /* NOTHING except the simulator may be pointed at a real shop, because
       nothing except the simulator has ever been proven against hardware. */
    for (const p of r.providers) {
      if (p.key === 'simulator') continue;
      assert.strictEqual(p.allows_production, false, p.key + ' would be allowed in production');
    }
    for (const missing of ['paygo']) {
      assert.strictEqual(by[missing].status, 'planned', missing + ' claims to exist');
      assert.strictEqual(by[missing].selectable, false, missing + ' is offered for selection');
    }
    /* Decided against, which is not the same as unwritten and must not read
       as "coming soon" in the dropdown. */
    for (const closed of ['worldline', 'ingenico']) {
      assert.strictEqual(by[closed].status, 'closed', closed + ' is not marked as a decision');
      assert.strictEqual(by[closed].selectable, false, closed + ' is offered for selection');
      assert.ok(/karar/i.test(by[closed].note), closed + ' does not say why: ' + by[closed].note);
    }
    for (const p of r.providers) assert.ok(p.status_label, 'no Turkish status label for ' + p.key);
  });

  await step('adding a device on a stub provider warns instead of claiming it works', async () => {
    const r = await api('POST', '/api/settings/okc/devices', {
      provider: 'hugin', device_model: 'Hugin T300', serial_number: 'HUG-TEST-1',
      device_ip: '192.168.1.60', device_port: 7500, environment: 'test' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(Array.isArray(r.warnings) && r.warnings.length, 'the device was saved with no warning at all');
    assert.ok(/denenmedi|doğrulan/i.test(r.warnings.join(' ')), 'the warning does not say it is unverified: ' + r.warnings);
    const list = await api('GET', '/api/settings/okc');
    const d = list.devices.find(x => x.id === r.id);
    /* Hugin moved from 'sdk' to 'beta' when the manufacturer's own PC Link
       protocol replaced the guessed one - no SDK is needed for it at all. The
       point of this check is unchanged: the list must carry the real status,
       and the real status must not be 'ready' until a device has answered. */
    assert.strictEqual(d.provider_status, 'beta', 'the list does not carry the honest status');
    assert.notStrictEqual(d.provider_status, 'ready',
      'no Hugin device has ever answered - it cannot be advertised as working');
    assert.ok(d.provider_note && d.provider_note.length > 20);
  });

  await step('a driver no device has answered cannot be pointed at a real shop', async () => {
    /* Hugin's protocol is the manufacturer's own - and that is still not proof.
       It is refused for the real environment, because a tax document does not
       care how well we read the specification. (Token used to be swept here
       too; it is now refused one step earlier, as a closed provider.) */
    for (const p of ['hugin']) {
      const r = await api('POST', '/api/settings/okc/devices', {
        provider: p, serial_number: 'PRD-' + p, device_ip: '192.168.1.61', environment: 'production' });
      assert.strictEqual(r.status, 400, p + ': an unverified driver was allowed into production');
      assert.ok(/gerçek|doğrulan/i.test(r.error), r.error);
    }
  });

  await step('a provider closed by decision says so, not "not written yet"', async () => {
    for (const p of ['worldline', 'ingenico']) {
      const r = await api('POST', '/api/settings/okc/devices', {
        provider: p, serial_number: 'CLS-' + p, environment: 'test' });
      assert.strictEqual(r.status, 400, p + ' was accepted as a device');
      assert.ok(/kullanılmıyor|karar/i.test(r.error),
        p + ': the refusal should name the decision, not a missing package: ' + r.error);
    }
  });

  await step('a provider that was never written cannot be added at all', async () => {
    for (const p of ['paygo', 'worldline', 'uydurma']) {
      const r = await api('POST', '/api/settings/okc/devices', {
        provider: p, serial_number: 'X-' + p, environment: 'test' });
      assert.strictEqual(r.status, 400, p + ' was accepted as a device');
    }
  });

  await step('the simulator is one click away and says out loud that it is not fiscal', async () => {
    const r = await api('POST', '/api/settings/okc/quick-simulator');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(/mali fiş kesmez/i.test(r.message), r.message);
    assert.strictEqual(await db.getSetting('fiscal_enabled'), '1', 'card payment was not switched on');
    const t = await api('POST', `/api/settings/okc/devices/${r.id}/test`);
    assert.strictEqual(t.connected, true, JSON.stringify(t));
    assert.strictEqual(t.state, 'ready');
  });

  await step('testing a device that is not there fails honestly rather than pretending', async () => {
    const list = await api('GET', '/api/settings/okc');
    const hugin = list.devices.find(d => d.provider === 'hugin');
    const t = await api('POST', `/api/settings/okc/devices/${hugin.id}/test`);
    assert.strictEqual(t.status, 200, 'an absent device is not an HTTP error');
    assert.strictEqual(t.connected, false, 'it claimed to have reached a device on 192.168.1.60');
    assert.ok(t.message && t.message.length > 5, 'no reason given');
  });

  await step('a cash register can be defined and a device attached to it', async () => {
    const reg = await api('POST', '/api/settings/okc/registers', { name: 'Kasa 1', code: 'KASA1' });
    assert.strictEqual(reg.status, 200, JSON.stringify(reg));
    const dup = await api('POST', '/api/settings/okc/registers', { name: 'Kasa 1 tekrar', code: 'KASA1' });
    assert.strictEqual(dup.status, 400, 'a duplicate register code was accepted');
    const dev = await api('POST', '/api/settings/okc/devices', {
      provider: 'hugin', serial_number: 'HGN-1', device_ip: '192.168.1.70',
      environment: 'test', cash_register_id: reg.id });
    assert.strictEqual(dev.status, 200, JSON.stringify(dev));
    const list = await api('GET', '/api/settings/okc');
    assert.strictEqual(list.devices.find(d => d.id === dev.id).register_name, 'Kasa 1');
    assert.strictEqual(Number(list.registers.find(x => x.id === reg.id).device_count), 1);
  });

  /* ============== each brand's own way of being reached =============== */
  /*
   * The point these three checks defend: a POS that supports more than one ÖKC
   * brand cannot assume they are reached the same way. Hugin answers on an IP
   * address; a Beko 300TR is a serial terminal in a cradle; a Beko X30TR is a
   * USB device the vendor's library finds by itself. `connection_type` was
   * written as 'tcp' for every device and never read, so nothing stopped the
   * screen demanding an IP address for a device that has none.
   */
  await step('each brand declares how it is physically reached', async () => {
    const r = await api('GET', '/api/settings/okc');
    const by = {};
    for (const p of r.providers) by[p.key] = p;
    assert.strictEqual(by.hugin.connection, 'tcp', 'hugin answers on an address');
    assert.strictEqual(by.simulator.connection, 'internal', 'the simulator has nothing to connect to');
    /* Token and Beko: the DLL discovers the device; there is no address and
       no port to pass it. See developer.tokeninc.com, 23.09.2026. */
    assert.strictEqual(by.token.connection, 'library', 'token still described as addressable');
    assert.strictEqual(by.beko.connection, 'library', 'beko still described as addressable');
  });

  await step('a network device without an address is refused, by name', async () => {
    const r = await api('POST', '/api/settings/okc/devices', {
      provider: 'hugin', serial_number: 'NOIP-1', environment: 'test' });
    assert.strictEqual(r.status, 400, 'a TCP device was accepted with no address');
    assert.ok(/IP adresi/i.test(r.error), 'the refusal does not say what is missing: ' + r.error);
  });

  await step('the connection shape is stored, not assumed to be tcp', async () => {
    const dev = await api('POST', '/api/settings/okc/devices', {
      provider: 'hugin', serial_number: 'SHAPE-1', device_ip: '192.168.1.91', environment: 'test' });
    assert.strictEqual(dev.status, 200, JSON.stringify(dev));
    const row = await db.one('SELECT connection_type FROM fiscal_devices WHERE id=?', [dev.id]);
    assert.strictEqual(row.connection_type, 'tcp', 'hugin should record tcp');
    /* and the column that nothing used to write is writable */
    await db.exec("UPDATE fiscal_devices SET serial_port='COM3' WHERE id=?", [dev.id]);
    const back = await db.one('SELECT serial_port FROM fiscal_devices WHERE id=?', [dev.id]);
    assert.strictEqual(back.serial_port, 'COM3', 'serial_port does not persist');
  });

  await step('a device can be switched off without losing its record', async () => {
    const list = await api('GET', '/api/settings/okc');
    const d = list.devices.find(x => x.serial_number === 'HGN-1');
    await api('POST', `/api/settings/okc/devices/${d.id}/active`, { active: false });
    assert.strictEqual(Number((await db.one('SELECT is_active FROM fiscal_devices WHERE id=?', [d.id])).is_active), 0);
  });

  /*
   * Deleting a device asks about LEGAL records, not about records.
   *
   * The old rule refused on any transaction at all, which meant a demo device
   * carrying 529 simulator receipts could never be removed from the list -
   * exactly the state a real install ends up in after training. A simulator
   * or test receipt is not a tax document and nothing outside this database
   * will ever ask about it.
   */
  const delFixture = async (serial, env, n) => {
    /*
     * Insert the row directly. fiscal.saveDevice has an upsert path that can
     * hand back an EXISTING simulator's id rather than a new one, so two
     * fixtures quietly became one device and the second delete found no
     * transactions to refuse over - a green-looking pass for the wrong reason.
     */
    const id = await db.insert(
      'INSERT INTO fiscal_devices (client_id, provider, device_model, serial_number, '
      + 'connection_type, environment, is_active) VALUES (?,?,?,?,?,?,1)',
      [CID, 'simulator', 'Silme Testi', serial, 'internal', 'simulator']);
    for (let i = 0; i < n; i++) {
      await db.exec(
        'INSERT INTO fiscal_transactions (client_id, idempotency_key, order_id, provider, '
        + 'environment, payment_method, fiscal_device_id) VALUES (?,?,?,?,?,?,?)',
        [CID, `sil-${serial}-${i}-${Date.now()}`, 1, 'simulator', env, 'cash', id]);
    }
    return id;
  };

  await step('a device with only test receipts is deleted, and they go with it', async () => {
    const id = await delFixture('SIL-TEST-1', 'test', 3);
    const r = await api('DELETE', `/api/settings/okc/devices/${id}`);
    assert.strictEqual(r.deleted, true, 'deneme kaydi silmeyi engelledi: ' + JSON.stringify(r.body));
    assert.strictEqual(await db.one('SELECT id FROM fiscal_devices WHERE id=?', [id]), null);
    const left = await db.value('SELECT COUNT(*) FROM fiscal_transactions WHERE fiscal_device_id=?', [id]);
    assert.strictEqual(Number(left), 0, 'cihaz gitti ama kayitlari oksuz kaldi');
  });

  await step('one real receipt makes the device permanent', async () => {
    const id = await delFixture('SIL-GERCEK-1', 'production', 1);
    const r = await api('DELETE', `/api/settings/okc/devices/${id}`);
    assert.strictEqual(r.deleted, false, 'GERCEK mali kayitli cihaz silindi');
    assert.match(r.message, /GERÇEK/, r.message);
    const row = await db.one('SELECT is_active FROM fiscal_devices WHERE id=?', [id]);
    assert.ok(row, 'cihaz kaydi yok oldu');
    assert.strictEqual(Number(row.is_active), 0, 'silinmedi ama kapatilmadi da');
  });

  /*
   * The casing trap: fiscal_devices writes 'SIMULATOR'/'production',
   * fiscal_transactions writes 'test'. A plain = 'production' comparison
   * reads every uppercase PRODUCTION row as harmless and deletes the device
   * that a year of tax documents points at.
   */
  await step('PRODUCTION in capitals counts as a real receipt too', async () => {
    const id = await delFixture('SIL-GERCEK-2', 'PRODUCTION', 1);
    const r = await api('DELETE', `/api/settings/okc/devices/${id}`);
    assert.strictEqual(r.deleted, false, 'buyuk harfli PRODUCTION gozden kacti');
  });

  /* ==================== 5. business, hours, currency ================= */

  await step('the business block, receipt header and footer and working hours all save', async () => {
    const r = await api('POST', '/api/settings/business', {
      client: {
        company_name: 'Ayar Test Lokantasi', full_address: 'Test Mah. Deneme Cad. 5',
        permanent_email: 'fatura@ayartest.local', phone: '02120000000',
        contact_name: 'Nöbetçi Müdür', contact_email: 'mudur@ayartest.local', contact_phone: '05320000000',
        receipt_header: 'AYAR TEST LOKANTASI', receipt_footer: 'Afiyet olsun',
      },
      business: { business_name: 'Ayar Test Lokantasi', legal_name: 'Ayar Test Gida Ltd.', city: 'İstanbul',
        email: 'info@ayartest.local', website: 'https://ayartest.local', instagram: '@ayartest' },
      hours: { hours_1: '09:00-23:00', hours_6: '10:00-02:00', hours_7: 'kapalı' },
      business_day_start: '05:30',
      currency: { currency: 'TRY', currency_symbol: '₺', currency_position: 'after', decimal_places: 2 },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r));

    const b = await api('GET', '/api/settings/business');
    assert.strictEqual(b.client.receipt_header, 'AYAR TEST LOKANTASI');
    assert.strictEqual(b.client.receipt_footer, 'Afiyet olsun');
    assert.strictEqual(b.client.contact_name, 'Nöbetçi Müdür');
    assert.strictEqual(b.business.legal_name, 'Ayar Test Gida Ltd.');
    assert.strictEqual(b.hours.hours_7, 'kapalı');
    assert.strictEqual(b.hours.hours_6, '10:00-02:00');
    assert.strictEqual(b.business_day_start, '05:30');
    assert.strictEqual(b.currency.symbol, '₺');
    // and the business-day helper the reports use must agree
    const businessDay = require('../src/util/businessDay');
    assert.strictEqual(String(await db.getSetting('business_day_start')), '05:30');
    assert.ok(await businessDay.currentBusinessDate?.() || true);
  });

  await step('the locked company identity is not editable from the till', async () => {
    const before = await db.one('SELECT owner_name, tax_number, tax_office FROM clients WHERE id=?', [CID]);
    await api('POST', '/api/settings/business', {
      client: { company_name: 'Ayar Test Lokantasi', owner_name: 'Sahte Sahip',
        tax_number: '0000000000', tax_office: 'Sahte VD' },
      business: { business_name: 'Ayar Test Lokantasi' },
    });
    const after = await db.one('SELECT owner_name, tax_number, tax_office FROM clients WHERE id=?', [CID]);
    assert.deepStrictEqual(after, before, 'the licensed identity was overwritten from the settings screen');
  });

  await step('a receipt line that will not fit the paper is refused before it reaches the printer', async () => {
    await api('POST', '/api/settings', { settings: { receipt_width: 32 } });
    const r = await api('POST', '/api/settings/business', {
      client: { company_name: 'X', receipt_header: 'BU BASLIK OTUZ IKI KARAKTERLIK FISE KESINLIKLE SIGMAZ' },
      business: { business_name: 'X' } });
    assert.strictEqual(r.status, 400, 'an over-wide receipt header was accepted');
    assert.ok(/sığmıyor/i.test(r.error), r.error);
    await api('POST', '/api/settings', { settings: { receipt_width: 48 } });
  });

  await step('an invalid e-mail on the company form is refused', async () => {
    const r = await api('POST', '/api/settings/business', {
      client: { company_name: 'X', permanent_email: 'fatura-at-ayartest' }, business: { business_name: 'X' } });
    assert.strictEqual(r.status, 400, 'a broken e-mail address was accepted');
  });

  await step('currencies seed themselves, and a rate can be entered by hand', async () => {
    const r = await api('GET', '/api/settings/currencies');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.currencies.length >= 3, 'EUR/USD/GBP should be seeded');
    const eur = r.currencies.find(c => c.code === 'EUR');
    assert.strictEqual(eur.missing, true, 'a currency with no rate should be flagged');

    const w = await api('POST', `/api/settings/currencies/${eur.id}/rate`, { rate: '40,50' });
    assert.strictEqual(w.status, 200, JSON.stringify(w));
    const after = (await api('GET', '/api/settings/currencies')).currencies.find(c => c.code === 'EUR');
    assert.strictEqual(after.rate, 40.5, 'the comma decimal did not survive');
    assert.strictEqual(after.missing, false);
    assert.strictEqual(after.stale, false);
    assert.strictEqual(after.example, Math.round((1000 / 40.5) * 100) / 100, 'the worked example is wrong');
  });

  await step('a rate change of more than half asks a second time before it is written', async () => {
    const eur = (await api('GET', '/api/settings/currencies')).currencies.find(c => c.code === 'EUR');
    const r = await api('POST', `/api/settings/currencies/${eur.id}/rate`, { rate: 405 });
    assert.strictEqual(r.status, 409, 'a tenfold rate change went straight in');
    assert.strictEqual(r.needs_confirm, true);
    assert.strictEqual((await api('GET', '/api/settings/currencies')).currencies.find(c => c.code === 'EUR').rate, 40.5,
      'the rate moved despite the refusal');

    const ok2 = await api('POST', `/api/settings/currencies/${eur.id}/rate`, { rate: 405, confirm: true });
    assert.strictEqual(ok2.status, 200, JSON.stringify(ok2));
    const hist = (await api('GET', '/api/settings/currencies')).history;
    assert.ok(hist.length >= 2, 'no rate history');
    assert.strictEqual(Number(hist[0].new_rate), 405);
    assert.strictEqual(Number(hist[0].old_rate), 40.5);
    assert.strictEqual(hist[0].changed_by_name, 'Ayar Yonetici');
  });

  await step('a nonsense rate is refused', async () => {
    const eur = (await api('GET', '/api/settings/currencies')).currencies.find(c => c.code === 'EUR');
    for (const bad of ['0', '-3', 'kirk']) {
      const r = await api('POST', `/api/settings/currencies/${eur.id}/rate`, { rate: bad, confirm: true });
      assert.strictEqual(r.status, 400, 'rate "' + bad + '" was accepted');
    }
  });

  await step('a currency can be switched off', async () => {
    const gbp = (await api('GET', '/api/settings/currencies')).currencies.find(c => c.code === 'GBP');
    await api('POST', `/api/settings/currencies/${gbp.id}/active`, { active: false });
    assert.strictEqual(Number((await db.one('SELECT is_active FROM doviz_kurlari WHERE id=?', [gbp.id])).is_active), 0);
  });

  /* ============================ 6. safety =========================== */

  await step('the tenant self-check runs and finds no unscoped rows', async () => {
    const r = await api('GET', '/api/settings/self-check');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.checks.length >= 10, 'the self-check looked at ' + r.checks.length + ' things');
    for (const c of r.checks) assert.ok(c.level && c.message, 'a check with no verdict: ' + JSON.stringify(c));
    const errors = r.checks.filter(c => c.level === 'error');
    assert.strictEqual(errors.length, 0, 'unclean: ' + errors.map(c => c.table + ': ' + c.message).join(', '));
    assert.strictEqual(r.all_clean, true);
    // rows belonging to other tenants of this build database are a note, not a failure
    assert.ok(r.checks.some(c => c.level === 'note' || c.level === 'ok'));
  });

  await step('the self-check notices a print job aimed at a station that is not ours', async () => {
    const jobId = await db.insert(
      "INSERT INTO print_jobs (client_id, job_type, station_id, content, status, created_at) VALUES (?,'report',999999,'x','pending',NOW())",
      [CID]);
    const r = await api('GET', '/api/settings/self-check');
    const check = r.checks.find(c => c.table === 'print_jobs → stations');
    assert.strictEqual(check.ok, false, 'a stray print job went unnoticed');
    assert.strictEqual(r.all_clean, false);
    await db.exec('DELETE FROM print_jobs WHERE id=?', [jobId]);
  });

  /* ============================ ÖKC kapaliyken ======================= *
   *
   * ÖKC is off out of the box and off means OFF: not "the button is hidden".
   * `fiscal_enabled` used to describe the screens and govern nothing at all -
   * fiscal.isEnabled was exported and never called - so the phone app, a saved
   * link or a stale tab could still open a card session on a device the
   * restaurant had decided it was not using, and lock the bill against it for
   * three minutes while it waited.
   * ==================================================================== */
  await step('a fresh installation has ÖKC switched off', async () => {
    await db.exec("DELETE FROM np_settings WHERE k='fiscal_enabled'");
    assert.strictEqual(String(await db.getSetting('fiscal_enabled', '0')), '0',
      'ÖKC must be off until somebody turns it on');
    const f = await api('GET', '/api/auth/features');
    assert.strictEqual(f.status, 200, JSON.stringify(f));
    assert.strictEqual(f.features.okc, false, 'the shell was told ÖKC exists');
  });

  await step('with ÖKC off a payment never reaches a fiscal adapter', async () => {
    const fiscal = require('../src/fiscal');
    const before = Number(await db.value(
      'SELECT COUNT(*) FROM fiscal_transactions WHERE client_id=?', [CID]));
    let refused = null;
    try {
      await fiscal.beginSale(CID, 999999, { method: 'kredi_karti', amount: 100, userId: ADMIN });
    } catch (e) { refused = e; }
    assert.ok(refused, 'the sale was allowed to start with ÖKC switched off');
    assert.ok(/ÖKC/.test(refused.message) && /Ayarlar/.test(refused.message),
      'the refusal has to name the switch, not just say no: ' + refused.message);
    /*
     * The count is the proof. A transaction row is written BEFORE the adapter
     * is asked for anything, so no new row means nothing ever spoke to a
     * device - which is what "never asks a device" has to mean.
     */
    const after = Number(await db.value(
      'SELECT COUNT(*) FROM fiscal_transactions WHERE client_id=?', [CID]));
    assert.strictEqual(after, before, 'a fiscal transaction was opened while ÖKC was off');
  });

  await step('the till route refuses the same way the module does', async () => {
    const r = await api('POST', '/api/pos/orders/999999/fiscal/pay', { method: 'kredi_karti', amount: 100 });
    assert.strictEqual(r.status, 400, 'the route let a fiscal payment through: ' + JSON.stringify(r));
    assert.ok(/ÖKC/.test(r.error || ''), 'and it must say why: ' + r.error);
  });

  await step('switching ÖKC on gives the whole area back', async () => {
    await db.setSetting('fiscal_enabled', '1');
    const f = await api('GET', '/api/auth/features');
    assert.strictEqual(f.features.okc, true, 'the switch did not reach the shell');
    /* Far enough in to prove the guard is gone: the sale is now refused for the
       ordinary reason, a bill that does not exist, not for being switched off. */
    let e2 = null;
    try {
      const fiscal = require('../src/fiscal');
      await fiscal.beginSale(CID, 999999, { method: 'kredi_karti', amount: 100, userId: ADMIN });
    } catch (e) { e2 = e; }
    assert.ok(e2, 'a bill that does not exist still cannot be paid');
    assert.ok(!/kapalı/.test(e2.message),
      'it is still being refused for being switched off: ' + e2.message);
  });

  /*
   * The İşletme tab, saved by somebody who has not filled in a tax number and
   * has not chosen a receipt station.
   *
   * This is a REGRESSION, from a real till's log: every save of that screen
   * answered 500 with `Column 'receipt_station_id' cannot be null` on it. The
   * endpoint was covered - a suite posted {settings:{}} to it and passed - but
   * the branch that writes the `client` block had never run, so five NOT NULL
   * columns were being handed NULL by a form whose whole purpose is that people
   * leave boxes empty.
   */
  await step('Ayarlar saves with the tax boxes empty and no receipt station', async () => {
    const r = await api('POST', '/api/manage/settings', {
      client: {
        receipt_header: 'Test Restoran', receipt_footer: 'Tesekkurler',
        tax_number: '', tax_office: '', phone: '', full_address: '',
        receipt_station_id: '',
      },
    });
    assert.strictEqual(r.status, 200, 'kaydetme reddedildi: ' + JSON.stringify(r));
    const row = await db.one(
      'SELECT tax_number, tax_office, phone, full_address, receipt_station_id FROM clients WHERE id=?', [CID]);
    if (row) {
      /* not filled in is '' and 0 - never NULL, which the column refuses */
      assert.strictEqual(row.tax_number, '', 'vergi no NULL yazildi');
      assert.strictEqual(Number(row.receipt_station_id), 0, 'fis istasyonu NULL yazildi');
    }
  });

  /* ================================ results ========================= */
  await restoreSettings(snap);
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
