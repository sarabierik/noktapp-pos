'use strict';
/**
 * Two different identities exist in this product:
 *
 *  1. The TENANT (the restaurant) - logs in online once with the e-mail and
 *     password issued from the panel. That unlocks the installation.
 *  2. The STAFF (cashier/waiter/manager) - created by the tenant inside the
 *     app, and they sign in on the till with a PIN, or on the phone with a
 *     username + password. Staff never touch the cloud.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const log = require('./logger');
const kimlik = require('./util/kimlik');

const ROLES = ['superadmin', 'admin', 'cashier', 'waiter'];

// Every permission the UI can gate on. Admin/superadmin implicitly hold all.
const PERMISSIONS = [
  'order.create', 'order.discount', 'order.item.cancel', 'order.delete',
  'order.transfer', 'order.split', 'order.reopen',
  'payment.take', 'payment.void', 'shift.open', 'shift.close', 'day.close', 'day.reopen',
  'product.manage', 'stock.manage', 'price.manage', 'table.manage',
  'report.view', 'report.export', 'customer.manage', 'settings.manage',
  'user.manage', 'fiscal.use', 'printer.manage', 'backup.run',
  /*
   * Yemek platformu entegrasyonu. Two keys and not one, because they are
   * two different people: `integration.manage` connects Trendyol Go and
   * holds its API secret (an owner's job, done once), while
   * `integration.order` accepts the order that just came in (whoever is at
   * the till at 20:30). Gating the second on the first is how a restaurant
   * ends up with unaccepted orders and a platform penalty.
   */
  'integration.manage', 'integration.order',
  /*
   * Paket servis. Split for exactly the same reason as the pair above, and
   * the split is not cosmetic: `delivery.manage` holds the delivery FEE and
   * the courier list (an owner's job, done once), while `delivery.order` is
   * the board - taking the phone order, moving the card, taking the courier's
   * cash in. A cashier who could edit the fee could set it to zero.
   */
  'delivery.manage', 'delivery.order',
];

let secret = null;
async function jwtSecret() {
  if (secret) return secret;
  let s = await db.getSetting('jwt_secret');
  if (!s) { s = crypto.randomBytes(48).toString('hex'); await db.setSetting('jwt_secret', s); }
  secret = s;
  return s;
}

async function issueToken(payload, ttl = '12h') {
  return jwt.sign(payload, await jwtSecret(), { expiresIn: ttl });
}
async function verifyToken(token) {
  try { return jwt.verify(token, await jwtSecret()); } catch (_) { return null; }
}

/* ------------------------------------------------------------------ */
/* Brute force                                                         */
/* ------------------------------------------------------------------ */
/**
 * A four digit PIN is 10,000 guesses, and this service listens on the LAN so
 * that the phones and the customer display can reach it. That means the guest
 * wifi can reach it too. Without a limiter, a cashier PIN - which carries
 * payment.take, discounts and line cancellation - falls in minutes.
 *
 * The columns to stop it have existed since the first schema: users
 * .pin_fail_count and .pin_locked_until were read here and reset in three
 * other places, and NOTHING EVER INCREMENTED THEM. A lock that never locks is
 * worse than no lock, because everyone who reads the code believes it is
 * handled. app_login_attempts had the same shape of problem: a table with no
 * writer.
 *
 * Two independent limits, because they catch different attacks:
 *
 *   per account   five wrong PINs locks that user for fifteen minutes. Stops
 *                 somebody working through one person's PIN.
 *   per address   twenty wrong attempts from one IP in fifteen minutes blocks
 *                 that address. Stops somebody working through every PIN,
 *                 which is the attack the per-account limit cannot see - each
 *                 individual account only ever sees one wrong guess.
 *
 * The till itself is exempt from neither. A cashier who mistypes five times
 * waits, and that is the correct trade: the alternative is that the drawer is
 * open to anyone who can see the wifi password taped to the wall.
 */
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MINUTES = 15;
const IP_MAX_FAILS = 20;
const IP_WINDOW_MINUTES = 15;

/** Record one attempt. Never throws: an auth path must not fail on its log. */
async function noteAttempt(ip, identifier, ok) {
  try {
    await db.exec(
      'INSERT INTO app_login_attempts (ip, identifier, ok, created_at) VALUES (?,?,?, NOW())',
      [String(ip || '?').slice(0, 45), identifier ? String(identifier).slice(0, 190) : null, ok ? 1 : 0]);
    /* keep the table from growing forever - this is a till, not an audit log */
    if (Math.random() < 0.02) {
      await db.exec('DELETE FROM app_login_attempts WHERE created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)');
    }
  } catch (_) { /* the limiter is best effort; the login is not */ }
}

/**
 * Has this address failed too often lately?
 *
 * Throws 429 rather than 401 on purpose: an attacker learns nothing from it
 * (it is the same answer whatever they guessed) and a real cashier locked out
 * by a colleague's fat fingers gets a message that explains itself.
 */
async function guardAddress(ip) {
  if (!ip) return;
  let n = 0;
  try {
    n = Number(await db.value(
      'SELECT COUNT(*) FROM app_login_attempts WHERE ip=? AND ok=0 AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)',
      [String(ip).slice(0, 45), IP_WINDOW_MINUTES]) || 0);
  } catch (_) { return; }
  if (n >= IP_MAX_FAILS) {
    log.warn('auth', 'Cok fazla basarisiz giris - adres engellendi', { ip, fails: n });
    const e = new Error(`Cok fazla hatali deneme. ${IP_WINDOW_MINUTES} dakika sonra tekrar deneyin.`);
    e.status = 429; e.code = 'TOO_MANY_ATTEMPTS'; throw e;
  }
}

/** Staff PIN login on the till. */
async function pinLogin(clientId, pin, ip = null) {
  await guardAddress(ip);

  const users = await db.query(
    'SELECT id, username, display_name, role, pin_hash, pin_fail_count, pin_locked_until, is_active ' +
    'FROM users WHERE client_id=? AND is_active=1 AND pin_hash IS NOT NULL', [clientId]);

  /* A locked account is skipped rather than matched, so a locked user's own
     correct PIN does not let them in either - that is what the lock is. */
  let lockedOutMatch = null;
  for (const u of users) {
    const locked = u.pin_locked_until && new Date(u.pin_locked_until) > new Date();
    if (!bcrypt.compareSync(String(pin), u.pin_hash)) continue;
    if (locked) { lockedOutMatch = u; continue; }

    await db.exec('UPDATE users SET pin_fail_count=0, pin_locked_until=NULL, is_logged_in=1 WHERE id=?', [u.id]);
    await noteAttempt(ip, u.username, true);
    const perms = await permissionsFor(clientId, u.id, u.role);
    const token = await issueToken({ cid: clientId, uid: u.id, role: u.role, name: u.display_name, kind: 'staff' });
    return { user: { id: u.id, display_name: u.display_name, role: u.role, username: u.username }, perms, token };
  }

  await noteAttempt(ip, lockedOutMatch ? lockedOutMatch.username : null, false);

  if (lockedOutMatch) {
    const mins = Math.max(1, Math.ceil(
      (new Date(lockedOutMatch.pin_locked_until) - new Date()) / 60000));
    const e = new Error(`${lockedOutMatch.display_name} gecici olarak kilitli. ${mins} dakika sonra tekrar deneyin.`);
    e.status = 429; e.code = 'PIN_LOCKED'; throw e;
  }

  /*
   * NOTHING is counted against an account here, and that is deliberate.
   *
   * The first version of this incremented every unlocked account on a wrong
   * guess, on the reasoning that the pad takes no username so there is nobody
   * to blame. The test bench caught what that actually means: five wrong PINs
   * from the car park lock out the entire restaurant. That is a denial of
   * service on the business, delivered by exactly the person the limiter was
   * meant to stop, and it is worse than the attack.
   *
   * So the two controls are split by what they can actually see:
   *
   *   the address limit   guards the anonymous pad. It is the only control
   *                       that can distinguish "one guesser" from "a busy
   *                       Saturday", because it counts attempts, not victims.
   *   the account lock    guards the paths where a username IS given - the
   *                       phone password - where a wrong attempt names the
   *                       account it is attacking.
   *
   * A locked account is still refused here, so a lock earned on the phone path
   * holds at the till too.
   */
  log.warn('auth', 'PIN rejected', { clientId, ip });
  const e = new Error('PIN hatali'); e.status = 401; throw e;
}

/** Staff password login (used by the phone app). */
async function staffLogin(clientId, username, password, ip = null) {
  await guardAddress(ip);
  const u = await db.one(
    'SELECT * FROM users WHERE client_id=? AND (username=? OR email=?) AND is_active=1 LIMIT 1',
    [clientId, String(username).trim(), String(username).trim().toLowerCase()]);
  /*
   * "No password set" and "wrong password" are different problems and used to
   * give the same answer. Waiters are created PIN-only by design - the phone
   * password is optional - so a manager handing a waiter a phone was told
   * "Kullanıcı adı veya şifre hatalı", regenerated the pairing code, tried
   * again, and got the same lie. A real till's log shows six of those in
   * twenty minutes, with an attempt to fix it by setting a PIN in between,
   * which is a different credential and could never have helped.
   *
   * The user's existence is not a secret worth protecting here: this endpoint
   * is reached only after a pairing code issued at the till has been redeemed,
   * so the caller is already standing in the restaurant.
   */
  if (u && !u.password_hash) {
    const e = new Error(`${u.display_name} icin telefon sifresi tanimli degil. `
      + 'Kasada Ayarlar > Kullanicilar ekranindan bu kisiye bir telefon sifresi verin, '
      + 'sonra tekrar deneyin. (Kasa PIN kodu telefon icin kullanilmaz.)');
    e.status = 409;
    e.code = 'NO_PHONE_PASSWORD';
    throw e;
  }
  if (!u || !bcrypt.compareSync(String(password), u.password_hash)) {
    await noteAttempt(ip, username, false);
    /* a named login names its victim, so this one CAN be counted per account */
    if (u) {
      await db.exec(
        `UPDATE users SET pin_fail_count = pin_fail_count + 1,
            pin_locked_until = IF(pin_fail_count + 1 >= ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), pin_locked_until)
          WHERE id=?`, [PIN_MAX_FAILS, PIN_LOCK_MINUTES, u.id]);
    }
    const e = new Error('Kullanici adi veya sifre hatali'); e.status = 401; throw e;
  }
  if (u.pin_locked_until && new Date(u.pin_locked_until) > new Date()) {
    const e = new Error('Bu hesap gecici olarak kilitli. Birazdan tekrar deneyin.');
    e.status = 429; e.code = 'ACCOUNT_LOCKED'; throw e;
  }
  await db.exec('UPDATE users SET pin_fail_count=0, pin_locked_until=NULL WHERE id=?', [u.id]);
  await noteAttempt(ip, username, true);
  const perms = await permissionsFor(clientId, u.id, u.role);
  return { user: { id: u.id, display_name: u.display_name, role: u.role, username: u.username }, perms };
}

/**
 * The same session staffLogin returns, without a password.
 *
 * Only ever reached after a QR pairing token has been redeemed. That token
 * lives inside a symbol on the till's own screen, is 32 hex characters, dies
 * in ten minutes and is single use, and the member of staff it belongs to was
 * chosen at the till by somebody holding user.manage. The phone proves it was
 * standing in front of the till; the till already said who it is for.
 *
 * This is also the only way to hand a phone to a waiter who has no phone
 * password at all - which, since waiters are created PIN-only by design, is
 * most of them on the first day.
 */
async function staffSession(clientId, userId) {
  const u = await db.one(
    'SELECT * FROM users WHERE client_id=? AND id=? AND is_active=1 LIMIT 1', [clientId, userId]);
  if (!u) { const e = new Error('Bu personel artik tanimli degil'); e.status = 404; throw e; }
  const perms = await permissionsFor(clientId, u.id, u.role);
  return { user: { id: u.id, display_name: u.display_name, role: u.role, username: u.username }, perms };
}

/*
 * The marker row.
 *
 * `user_permissions` held only the keys a user HAD, so an empty table meant
 * two different things that must never be confused: "the owner has never
 * opened this user's permission screen" and "the owner opened it and unticked
 * every box". Both looked identical, and the second one therefore fell through
 * to the role defaults - an owner who deliberately stripped a cashier down to
 * nothing, to stop them working while a till count was investigated, got a
 * cashier who could still discount, take money and open the drawer, and a
 * screen that told them otherwise.
 *
 * One reserved row, written whenever the screen saves, separates the two. It
 * is not a permission and is never handed out; it only says "a choice was
 * made here". Rows written before this existed carry no marker and keep
 * working exactly as they did, because any row at all still counts as a
 * choice.
 */
const OVERRIDE_MARK = '__set__';

async function permissionsFor(clientId, userId, role) {
  if (role === 'admin' || role === 'superadmin') return PERMISSIONS.slice();
  const rows = await db.query('SELECT perm_key FROM user_permissions WHERE client_id=? AND user_id=?',
    [clientId, userId]);
  if (rows.length) return rows.map(r => r.perm_key).filter(k => k !== OVERRIDE_MARK);
  // no choice has ever been saved for this user: sensible defaults so a
  // freshly created user can still work
  if (role === 'cashier') {
    return ['order.create', 'order.discount', 'order.item.cancel', 'order.transfer', 'order.split',
      'payment.take', 'shift.open', 'shift.close', 'report.view', 'customer.manage', 'fiscal.use',
      'integration.order', 'delivery.order'];
  }
  return ['order.create', 'order.item.cancel', 'customer.manage'];
}

async function setPermissions(clientId, userId, perms, grantedBy) {
  const clean = perms.filter(p => PERMISSIONS.includes(p));
  await db.tx(async t => {
    await t.exec('DELETE FROM user_permissions WHERE client_id=? AND user_id=?', [clientId, userId]);
    await t.exec('INSERT INTO user_permissions (client_id,user_id,perm_key,granted_by,created_at) VALUES (?,?,?,?,NOW())',
      [clientId, userId, OVERRIDE_MARK, grantedBy || null]);
    for (const p of clean) {
      await t.exec('INSERT INTO user_permissions (client_id,user_id,perm_key,granted_by,created_at) VALUES (?,?,?,?,NOW())',
        [clientId, userId, p, grantedBy || null]);
    }
  });
  return clean;
}

/**
 * Express middleware.
 *
 * The header, and only the header. `?token=` used to be accepted as well, for
 * the one thing that could not send a header: an export opened with
 * window.open. That put a live session token into the address bar, the browser
 * history and every access log between the till and here - a token anyone
 * reading that history could replay for its whole 12 hours. The till now
 * downloads with an authorised fetch and saves the Blob itself, so nothing
 * needs the query string and it is no longer honoured.
 */
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Oturum yok' });
  verifyToken(token).then(p => {
    if (!p) return res.status(401).json({ ok: false, error: 'Oturum suresi doldu' });
    req.auth = p;
    req.clientId = p.cid;
    next();
  });
}

function requirePerm(perm) {
  /*
   * The middleware carries the key it enforces. Nothing in the running service
   * reads it - test/yetki.js does, so that the sweep of "every gated endpoint,
   * as every role" is taken from the routes THEMSELVES rather than from a list
   * kept by hand beside them. A list kept by hand is a list that goes stale on
   * the first new endpoint, and the endpoint it misses is the one nobody
   * checked.
   */
  const mw = async (req, res, next) => {
    if (!req.auth) return res.status(401).json({ ok: false, error: 'Oturum yok' });
    if (req.auth.role === 'admin' || req.auth.role === 'superadmin') return next();
    const perms = await permissionsFor(req.auth.cid, req.auth.uid, req.auth.role);
    if (!perms.includes(perm)) return res.status(403).json({ ok: false, error: 'Bu islem icin yetkiniz yok' });
    next();
  };
  mw.perm = perm;
  return mw;
}

/**
 * Who counts as the owner.
 *
 * The rule was written for /api/finance and lives here now because a second
 * screen needs it: restore erases everything since a snapshot, which is the
 * same kind of act as taking last month's takings off the books. Two copies of
 * a security predicate drift, and the copy that drifts is the one nobody
 * re-reads.
 *
 * The tenant login (`kind:'tenant'`) is the e-mail and password issued from
 * the panel - the owner. `superadmin` is that same person's staff identity on
 * the till. `admin` deliberately does not pass: an admin is a manager the
 * owner created, and a manager should not be able to erase a month of trade.
 */
function isOwner(a) {
  return !!a && (a.kind === 'tenant' || a.role === 'superadmin');
}
function requireOwner(req, res, next) {
  if (!isOwner(req.auth)) {
    return res.status(403).json({ ok: false, error: 'Bu işlemi sadece işletme sahibi yapabilir.', code: 'OWNER_ONLY' });
  }
  next();
}
/* read by test/yetki.js, like requirePerm's .perm above */
requireOwner.ownerOnly = true;

/**
 * The owner's password, typed again, for the one or two actions where being
 * logged in is not enough.
 *
 * It is the offline half of the login check and not an online one on purpose:
 * the moment this matters most is the moment the restaurant's database is
 * broken, and asking pos.noktapp.com for permission to repair a till that is
 * standing in front of you is how a dead internet line turns a bad morning
 * into a closed restaurant. `np_login_cache` holds the bcrypt hash the last
 * successful login left behind, which is exactly what offlineLogin compares
 * against.
 *
 * A `superadmin` signing in as staff has no row there - their password lives
 * on the user record - so both are accepted, and only for the account making
 * the request.
 */
async function verifyOwnerPassword(clientId, password, userId = null) {
  const pw = String(password || '');
  /* 403 and not 400 even when the box was left empty: "you have not proved
     you may do this" is one answer, and splitting it in two tells a caller
     which half of the check they failed. */
  if (!pw) { const e = new Error('Devam etmek için şifrenizi girin'); e.status = 403; throw e; }
  const rows = [];
  try {
    rows.push(...await db.query('SELECT password_hash FROM np_login_cache WHERE client_id=?', [clientId]));
    if (userId) {
      const u = await db.one('SELECT password_hash FROM users WHERE client_id=? AND id=? AND is_active=1',
        [clientId, userId]);
      if (u && u.password_hash) rows.push(u);
    }
  } catch (_) { /* the database is the thing being repaired - see below */ }
  if (!rows.length) {
    /*
     * The one caller of this is the restore button, and the state a restore
     * has to be usable in is the state where the database cannot answer
     * anything - including "what is the owner's password hash". Refusing here
     * would mean the check is enforced on every ordinary day and absent on the
     * only day it is used. The hash is the same one, copied out of
     * np_login_cache while the database could still be read.
     */
    const cached = kimlik.read();
    for (const h of (cached && cached.owner_hashes) || []) rows.push({ password_hash: h });
  }
  if (!rows.length) {
    const e = new Error('Bu bilgisayarda kayıtlı işletme şifresi yok. Önce işletme girişi yapın.');
    e.status = 403; throw e;
  }
  for (const r of rows) {
    try { if (r.password_hash && bcrypt.compareSync(pw, r.password_hash)) return true; } catch (_) {}
  }
  log.warn('auth', 'Owner password re-entry rejected', { clientId });
  const e = new Error('Şifre hatalı'); e.status = 403; throw e;
}

/** Manager override: a supervisor types their PIN to authorise one action. */
async function overridePin(clientId, pin, perm, ip = null) {
  /*
   * The same limiter as the PIN pad, and for a sharper reason: this endpoint
   * is reached by somebody who is ALREADY signed in. A waiter with a quiet
   * afternoon and the supervisor screen in front of them is a better placed
   * attacker than anyone on the guest wifi.
   */
  await guardAddress(ip);
  const users = await db.query(
    "SELECT id, display_name, role, pin_hash FROM users WHERE client_id=? AND is_active=1 " +
    "AND pin_hash IS NOT NULL AND role IN ('admin','superadmin','cashier')", [clientId]);
  for (const u of users) {
    if (bcrypt.compareSync(String(pin), u.pin_hash)) {
      const perms = await permissionsFor(clientId, u.id, u.role);
      if (!perm || perms.includes(perm)) {
        await noteAttempt(ip, u.display_name, true);
        return { id: u.id, name: u.display_name, role: u.role };
      }
    }
  }
  await noteAttempt(ip, 'override', false);
  const e = new Error('Yetkili PIN dogrulanamadi'); e.status = 403; throw e;
}

module.exports = { ROLES, PERMISSIONS, OVERRIDE_MARK, issueToken, verifyToken, pinLogin, staffLogin, staffSession,
  noteAttempt, guardAddress, PIN_MAX_FAILS, PIN_LOCK_MINUTES, IP_MAX_FAILS, IP_WINDOW_MINUTES,
  permissionsFor, setPermissions, requireAuth, requirePerm, isOwner, requireOwner, verifyOwnerPassword,
  overridePin, hash: (s) => bcrypt.hashSync(String(s), 10) };
