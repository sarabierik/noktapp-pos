'use strict';
/**
 * Licence + online login.
 *
 * The customer's copy of the program lives entirely on their own PC. The only
 * thing our server does is (a) say whether the licence is valid and (b) hold
 * the nightly backup. The login page is therefore online: the e-mail/password
 * are checked against pos.noktapp.com, and the answer is cached locally so a
 * dead router never locks the till out (grace period).
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');
const log = require('./logger');
const teshis = require('./modules/teshis');

function post(url, body, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'NoktAppPOS/' + (process.env.npm_package_version || '2.0.0'),
      },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); }
        catch (e) { reject(new Error('Bad response from panel: ' + buf.slice(0, 200))); }
      });
    });
    /*
     * This message reaches a cashier's screen whenever somebody is waiting on
     * the call - binding a branch, for one - so it says what happened and what
     * to do, in Turkish, instead of the single English word "timeout".
     */
    req.on('timeout', () => {
      const e = new Error(`Merkeze ${Math.round(timeoutMs / 1000)} saniyede ulaşılamadı. Bağlantıyı kontrol edip tekrar deneyin.`);
      e.code = 'TIMEOUT';
      req.destroy(e);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function deviceId() {
  let id = await db.getSetting('device_id');
  if (!id) {
    id = crypto.randomUUID();
    await db.setSetting('device_id', id);
  }
  return id;
}

async function panelUrl() {
  return (await db.getSetting('panel_url', config.panelUrl)) || config.panelUrl;
}

/**
 * Online login. On success the licence + the user are cached locally.
 * Returns { client, user, licence }.
 */
async function onlineLogin(email, password) {
  const url = (await panelUrl()) + '/api/desktop/login.php';
  const res = await post(url, {
    email: String(email || '').trim().toLowerCase(),
    password: String(password || ''),
    device_id: await deviceId(),
    device_name: require('os').hostname(),
    product: 'pos',
    app_version: process.env.NOKTAPP_VERSION || '2.0.0',
  });
  if (res.status !== 200 || !res.body || !res.body.ok) {
    const msg = (res.body && res.body.error) || 'Giris basarisiz';
    const err = new Error(msg);
    err.remote = true;
    throw err;
  }
  const b = res.body;
  await cacheLicence(b);
  await cacheCredentials(b.client.id, email, password, b.user);
  return b;
}

async function cacheLicence(b) {
  const lic = b.licence || {};
  await db.exec(
    `INSERT INTO np_licence (id, client_id, company_name, licence_key, plan_name, status, seats,
        features, expires_at, grace_days, last_check_at, last_ok_at, signature)
     VALUES (1,?,?,?,?,?,?,?,?,?,NOW(),NOW(),?)
     ON DUPLICATE KEY UPDATE client_id=VALUES(client_id), company_name=VALUES(company_name),
        licence_key=VALUES(licence_key), plan_name=VALUES(plan_name), status=VALUES(status),
        seats=VALUES(seats), features=VALUES(features), expires_at=VALUES(expires_at),
        grace_days=VALUES(grace_days), last_check_at=NOW(), last_ok_at=NOW(), signature=VALUES(signature)`,
    [b.client.id, b.client.company_name || null, lic.key || '', lic.plan || null,
     lic.status || 'active', lic.seats || 1, JSON.stringify(lic.features || {}),
     lic.expires_at || null, lic.grace_days || 7, lic.signature || null]);
  db.setClientId(b.client.id);
  // keep the local clients row in step with what the panel knows
  await db.exec(
    `INSERT INTO clients (id, client_id, slug, company_name, owner_name, email, phone, tax_number, tax_office,
        full_address, is_active, created_at, role, username, password_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,NOW(),'admin',?, '')
     ON DUPLICATE KEY UPDATE company_name=VALUES(company_name), owner_name=VALUES(owner_name),
        email=VALUES(email), phone=VALUES(phone), tax_number=VALUES(tax_number),
        tax_office=VALUES(tax_office), full_address=VALUES(full_address), is_active=1`,
    [b.client.id, b.client.id, b.client.slug || ('musteri-' + b.client.id),
     b.client.company_name || '', b.client.owner_name || '',
     b.client.email || '', b.client.phone || '', b.client.tax_number || '',
     b.client.tax_office || '', b.client.address || '', b.client.email || '']);
}

async function cacheCredentials(clientId, email, password, user) {
  const hash = bcrypt.hashSync(String(password), 10);
  await db.exec(
    `INSERT INTO np_login_cache (client_id, email, password_hash, display_name, role, user_ref, cached_at)
     VALUES (?,?,?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), display_name=VALUES(display_name),
        role=VALUES(role), user_ref=VALUES(user_ref), cached_at=NOW()`,
    [clientId, String(email).toLowerCase(), hash, (user && user.display_name) || null,
     (user && user.role) || 'admin', (user && user.id) || null]);
}

/** Offline fallback used when the panel cannot be reached. */
async function offlineLogin(email, password) {
  const lic = await db.one('SELECT * FROM np_licence WHERE id=1');
  if (!lic) { const e = new Error('Bu bilgisayarda kayitli lisans yok. Ilk giris internet gerektirir.'); e.needsOnline = true; throw e; }
  const graceMs = (lic.grace_days || 7) * 86400000;
  const lastOk = lic.last_ok_at ? new Date(lic.last_ok_at).getTime() : 0;
  if (!lastOk || Date.now() - lastOk > graceMs) {
    const e = new Error('Lisans dogrulanamadi ve cevrimdisi kullanim suresi doldu. Lutfen internete baglanin.');
    e.graceExpired = true;
    throw e;
  }
  const row = await db.one('SELECT * FROM np_login_cache WHERE client_id=? AND email=?',
    [lic.client_id, String(email).trim().toLowerCase()]);
  if (!row) {
    // Never say "wrong password" when the truth is that we could not ask the
    // server and have never seen this address on this machine.
    const e = new Error('Sunucuya ulasilamadi ve bu e-posta bu bilgisayarda daha once kullanilmadi. Internet baglantinizi kontrol edin.');
    e.needsOnline = true;
    throw e;
  }
  if (!bcrypt.compareSync(String(password), row.password_hash)) {
    throw new Error('E-posta veya sifre hatali');
  }
  db.setClientId(lic.client_id);
  return {
    ok: true, offline: true,
    client: { id: lic.client_id, company_name: lic.company_name },
    user: { id: row.user_ref, display_name: row.display_name, role: row.role, email: row.email },
    licence: { key: lic.licence_key, status: lic.status, plan: lic.plan_name,
               expires_at: lic.expires_at, features: safeParse(lic.features) },
  };
}

function safeParse(s) { try { return JSON.parse(s || '{}'); } catch (_) { return {}; } }

/** Login used by the UI: try online first, fall back to the cache. */
async function login(email, password) {
  try {
    const r = await onlineLogin(email, password);
    log.info('licence', 'Online login ok', { email });
    return r;
  } catch (err) {
    if (err.remote) throw err;               // the panel answered "no" - do not fall back
    log.warn('licence', 'Panel unreachable, trying offline login', err.message);
    return offlineLogin(email, password);
  }
}

/** Background heartbeat: refresh licence state, extend the grace window. */
async function heartbeat() {
  const lic = await db.one('SELECT * FROM np_licence WHERE id=1');
  if (!lic) return { skipped: true };
  try {
    const url = (await panelUrl()) + '/api/desktop/heartbeat.php';
    /*
     * The diagnostics document rides here rather than on a timer of its own.
     * We are already paying for a round trip to the panel and have already
     * proved it is reachable, which is exactly the moment to say how this
     * machine is doing; a second poller would double the traffic on a
     * restaurant's line to carry something nobody is waiting for.
     *
     * forHeartbeat() returns null far more often than it returns a document -
     * at most one an hour - and it never throws and never blocks: it races a
     * short timer internally, so a busy database costs this beat's document
     * and not the licence check. A till that cannot reach us is unaffected in
     * every direction: nothing here is written until the panel has answered.
     */
    const diag = await teshis.forHeartbeat(lic.client_id);
    const res = await post(url, {
      client_id: lic.client_id,
      licence_key: lic.licence_key,
      device_id: await deviceId(),
      app_version: process.env.NOKTAPP_VERSION || '2.0.0',
      stats: await quickStats(lic.client_id),
      ...(diag ? { diag } : {}),
    });
    if (res.status === 200 && res.body && res.body.ok) {
      await db.exec(
        `UPDATE np_licence SET status=?, plan_name=?, seats=?, features=?, expires_at=?,
            grace_days=?, last_check_at=NOW(), last_ok_at=NOW() WHERE id=1`,
        [res.body.licence.status, res.body.licence.plan || lic.plan_name,
         res.body.licence.seats || lic.seats, JSON.stringify(res.body.licence.features || {}),
         res.body.licence.expires_at || null, res.body.licence.grace_days || lic.grace_days]);
      /*
       * The chain menu rides here rather than on a timer of its own. We have
       * just proved the panel is reachable and the licence is good, which is
       * exactly the moment to ask whether head office has published anything;
       * a second poller would double the traffic to say the same thing twice.
       * On a single-shop till this returns before touching the network - it
       * reads one settings row, sees no branch, and stops. It is awaited but
       * never allowed to throw, because a menu that could not be fetched must
       * not turn a good licence check into a failed one.
       */
      const menu = await require('./modules/zincir').pullOnHeartbeat();
      /* The hour's slot is spent only once the panel has actually taken the
         document. A failed beat must not buy silence until the next hour. */
      if (diag) await teshis.markSent();
      return { ok: true, status: res.body.licence.status, menu, diag: !!diag };
    }
    await db.exec('UPDATE np_licence SET last_check_at=NOW() WHERE id=1');
    return { ok: false };
  } catch (e) {
    await db.exec('UPDATE np_licence SET last_check_at=NOW() WHERE id=1');
    log.debug('licence', 'heartbeat failed', e.message);
    return { ok: false, error: e.message };
  }
}

async function quickStats(clientId) {
  try {
    const r = await db.one(
      `SELECT COUNT(*) c, COALESCE(SUM(grand_total),0) t FROM orders
        WHERE client_id=? AND business_date=CURDATE() AND is_deleted=0`, [clientId]);
    return { orders_today: r.c, sales_today: Number(r.t) };
  } catch (_) { return {}; }
}

/** Is the licence good enough to open the app right now? */
async function status() {
  const lic = await db.one('SELECT * FROM np_licence WHERE id=1');
  if (!lic) return { licensed: false, reason: 'not_activated' };
  const expired = lic.expires_at && new Date(lic.expires_at).getTime() < Date.now();
  const lastOk = lic.last_ok_at ? new Date(lic.last_ok_at).getTime() : 0;
  const graceLeftMs = (lastOk + (lic.grace_days || 7) * 86400000) - Date.now();
  return {
    licensed: lic.status === 'active' && !expired && graceLeftMs > 0,
    status: lic.status,
    plan: lic.plan_name,
    company: lic.company_name,
    expires_at: lic.expires_at,
    offline_days_left: Math.max(0, Math.floor(graceLeftMs / 86400000)),
    features: safeParse(lic.features),
  };
}

module.exports = { login, onlineLogin, offlineLogin, heartbeat, status, deviceId, panelUrl, post };
