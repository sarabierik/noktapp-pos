'use strict';
/**
 * CİHAZ / ÇEVRİMDIŞI / SENKRON — everything about the machines around the till
 * and the queue between them and the cloud.
 *
 * Four things live here, and they are in one module because in a restaurant
 * they are one question. When the owner rings support the sentence is never
 * "my outbox has 41 pending rows", it is "the phones stopped working"; the
 * answer is somewhere in: is this device still paired, is the queue moving, is
 * the licence still good, what happened at 19:40. Splitting that across four
 * modules would mean four round trips to answer one question.
 *
 *   1. PAIRED DEVICES   — reads app_device_tokens. Pairing itself already
 *      exists in src/lan/index.js and is NOT reimplemented here; this adds the
 *      parts that were missing: one row per physical device instead of one per
 *      token, renaming, and a retire that also takes the number prefix back.
 *
 *   2. NUMBER PREFIXES  — the offline numbering scheme from W2 §2.4. The whole
 *      design in one sentence: uniqueness of an adisyon number comes from the
 *      NAMESPACE, not from a reservation, so a device that has been off the
 *      network since Friday can still mint numbers on Sunday. This PC is
 *      prefix 0 and counts 1, 2, 3; a device holding prefix 3 counts 30001,
 *      30002. Nine prefixes exist and no more, because 10000*prefix + 9999 has
 *      to stay inside one adisyon number.
 *
 *   3. SYNC QUEUE       — reads np_sync_outbox, which src/sync/index.js writes
 *      and drains. Nothing here re-implements the drain; it calls it. What was
 *      missing was that a stuck queue was completely invisible: sync.drain()
 *      swallows its own failure at debug level, so an outbox that has been
 *      refused by the panel for three days looks exactly like an idle one.
 *
 *   4. CONNECTION       — licence, grace window, relay, LAN address. The rule
 *      that shapes it: an expiring licence must be visible BEFORE it expires.
 *      The PHP product told the restaurant on the morning it stopped working,
 *      which is the one morning nothing can be done about it.
 *
 * A note on tenancy: this installation serves exactly one client_id (it is
 * read from np_licence), so np_app_log carries no client_id column and the
 * activity log is not filtered by one. Everything else is scoped explicitly.
 */
const QRCode = require('qrcode-svg');
const db = require('../db');
const log = require('../logger');
const config = require('../config');
const lan = require('../lan');
const licence = require('../licence');
const sync = require('../sync');
const bd = require('../util/businessDay');

/* W2 §2.4: `const ADISYON_SERIES_MAX = 9999; const ADISYON_MAX_PREFIX = 9;` */
const SERIES_MAX = 9999;
const MAX_PREFIX = 9;

/** A device that has spoken to us this recently is treated as being on. */
const ONLINE_SECONDS = 300;
/** The relay long-polls every 1.5s; three missed rounds and it is not up. */
const RELAY_STALE_SECONDS = 90;
/** np_sync_outbox rows the drain will no longer pick up (attempts < 10). */
const MAX_ATTEMPTS = 10;

const dup = (e) => e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062);

/* ------------------------------------------------------------------ */
/* numbering                                                          */
/* ------------------------------------------------------------------ */

/**
 * prefix + sequence -> adisyon number, or null.
 *
 * Returning null rather than a wrong number when the series is exhausted is
 * deliberate and quoted from the original: "A bill with no number is a
 * nuisance; two bills with the same number take money from the wrong guest."
 */
function compose(prefix, n) {
  const p = Number(prefix);
  const s = Number(n);
  if (!Number.isInteger(s) || s < 1 || s > SERIES_MAX) return null;
  if (!Number.isInteger(p) || p < 0 || p > MAX_PREFIX) return null;
  return p === 0 ? s : (p * 10000) + s;
}

/** adisyon number -> [prefix, sequence]. Numbers <= 9999 are this PC's. */
function decompose(no) {
  const v = Number(no) || 0;
  return v > SERIES_MAX ? [Math.floor(v / 10000), v % 10000] : [0, v];
}

/**
 * Give a device its permanent prefix, or tell it there is none.
 *
 * First come, first served, and scarce on purpose. The loop is correct only
 * because of the two unique keys: uq_device makes a device that asks twice get
 * the same answer, uq_prefix makes two devices asking at the same instant get
 * different ones. On a duplicate we re-read (we raced ourselves) or step to the
 * next prefix (somebody else holds it) rather than trusting the SELECT we did
 * a moment ago.
 *
 * All nine taken -> { prefix: null }. That is NOT an error: the device still
 * works perfectly well online on this PC's own series. It just cannot mint
 * numbers while the network is down, and it has to be told so plainly.
 */
async function allocatePrefix(clientId, deviceId, deviceName = null) {
  const id = String(deviceId || '').trim();
  if (!id || id.length > 64) { const e = new Error('Cihaz kimliği gerekli'); e.status = 400; throw e; }

  for (let attempt = 0; attempt < MAX_PREFIX + 2; attempt++) {
    const own = await db.one(
      'SELECT prefix FROM app_device_numbers WHERE client_id=? AND device_id=?', [clientId, id]);
    if (own) return { prefix: own.prefix, allocated: false, online_only: false };

    const taken = (await db.query(
      'SELECT prefix FROM app_device_numbers WHERE client_id=?', [clientId])).map(r => Number(r.prefix));
    const free = [];
    for (let p = 1; p <= MAX_PREFIX; p++) if (!taken.includes(p)) free.push(p);
    if (!free.length) {
      log.warn('device', 'Tüm adisyon ön ekleri dolu, cihaz yalnızca çevrimiçi çalışacak', { device_id: id });
      return { prefix: null, allocated: false, online_only: true };
    }

    try {
      await db.exec(
        'INSERT INTO app_device_numbers (client_id, device_id, prefix, created_at) VALUES (?,?,?,NOW())',
        [clientId, id, free[0]]);
      await db.exec(
        `INSERT INTO app_device_number_history (client_id, device_id, device_name, prefix, allocated_at)
         VALUES (?,?,?,?,NOW())`, [clientId, id, deviceName, free[0]]).catch(() => {});
      log.info('device', 'Adisyon ön eki verildi', { device_id: id, prefix: free[0] });
      return { prefix: free[0], allocated: true, online_only: false };
    } catch (e) {
      if (!dup(e)) throw e;      // a real error, not the race we planned for
    }
  }
  return { prefix: null, allocated: false, online_only: true };
}

/**
 * Take a prefix back when a device is retired.
 *
 * The delete is the point - uq_prefix is the allocation mechanism, so a row
 * left behind in any "released" state would keep the prefix out of circulation
 * for ever. What the caller gets back includes `numbers_seen`: how far today's
 * counter for that prefix had already run. A prefix handed to a new tablet
 * while the old one still has unsynced bills on it produces two bills with the
 * same number, so the screen warns with this figure rather than silently
 * re-issuing.
 */
async function releasePrefix(clientId, prefix, releasedBy = null) {
  const p = Number(prefix);
  if (!Number.isInteger(p) || p < 1 || p > MAX_PREFIX) {
    const e = new Error('Ön ek 1 ile 9 arasında olmalı'); e.status = 400; throw e;
  }
  const row = await db.one(
    'SELECT * FROM app_device_numbers WHERE client_id=? AND prefix=?', [clientId, p]);
  if (!row) { const e = new Error('Bu ön ek zaten boşta'); e.status = 404; throw e; }

  const date = await bd.currentBusinessDate();
  const seen = Number(await db.value(
    'SELECT next_no FROM app_order_counters WHERE client_id=? AND business_date=? AND prefix=?',
    [clientId, date, p])) || 0;

  await db.exec('DELETE FROM app_device_numbers WHERE client_id=? AND prefix=?', [clientId, p]);
  await db.exec(
    `UPDATE app_device_number_history SET released_at=NOW(), released_by=?, numbers_seen=?
      WHERE client_id=? AND device_id=? AND prefix=? AND released_at IS NULL`,
    [releasedBy, seen, clientId, row.device_id, p]).catch(() => {});
  log.info('device', 'Adisyon ön eki serbest bırakıldı',
    { prefix: p, device_id: row.device_id, by: releasedBy, numbers_seen: seen });
  return { prefix: p, device_id: row.device_id, numbers_seen: seen, business_date: date };
}

/**
 * Teach this PC's counter about a number a device minted while offline.
 *
 * GREATEST is what makes it order-independent: ops replayed out of sequence
 * still leave the counter monotonic, so the same number is never handed out
 * twice once the device reconnects.
 */
async function observeNumber(clientId, businessDate, prefix, n) {
  const p = Number(prefix);
  const next = Number(n) + 1;
  if (!Number.isInteger(p) || p < 0 || p > MAX_PREFIX) return false;
  if (!Number.isInteger(next) || next < 2 || next > SERIES_MAX + 1) return false;
  const hit = await db.exec(
    `UPDATE app_order_counters SET next_no = GREATEST(next_no, ?)
      WHERE client_id=? AND business_date=? AND prefix=?`, [next, clientId, businessDate, p]);
  if (hit) return true;
  try {
    await db.exec(
      'INSERT INTO app_order_counters (client_id, business_date, prefix, next_no) VALUES (?,?,?,?)',
      [clientId, businessDate, p, next]);
    return true;
  } catch (e) {
    if (!dup(e)) throw e;
    await db.exec(
      `UPDATE app_order_counters SET next_no = GREATEST(next_no, ?)
        WHERE client_id=? AND business_date=? AND prefix=?`, [next, clientId, businessDate, p]);
    return true;
  }
}

/** Everything the "Adisyon ön ekleri" tab draws. */
async function prefixState(clientId) {
  const date = await bd.currentBusinessDate();
  const rows = await db.query(
    `SELECT n.prefix, n.device_id, n.created_at,
            t.device_name, t.platform, t.app_version, t.last_seen_at, t.revoked_at,
            c.next_no
       FROM app_device_numbers n
       LEFT JOIN (
            SELECT d.device_id, d.device_name, d.platform, d.app_version, d.last_seen_at, d.revoked_at
              FROM app_device_tokens d
              JOIN (SELECT device_id, MAX(id) id FROM app_device_tokens WHERE client_id=? GROUP BY device_id) m
                ON m.id = d.id
       ) t ON t.device_id COLLATE utf8mb4_unicode_ci = n.device_id
       LEFT JOIN app_order_counters c
              ON c.client_id = n.client_id AND c.business_date = ? AND c.prefix = n.prefix
      WHERE n.client_id = ?
      ORDER BY n.prefix`, [clientId, date, clientId]);

  const held = rows.map(r => Number(r.prefix));
  const free = [];
  for (let p = 1; p <= MAX_PREFIX; p++) if (!held.includes(p)) free.push(p);

  const serverNext = Number(await db.value(
    'SELECT next_no FROM app_order_counters WHERE client_id=? AND business_date=? AND prefix=0',
    [clientId, date])) || 1;

  return {
    business_date: date,
    max_prefix: MAX_PREFIX,
    series_max: SERIES_MAX,
    server: { prefix: 0, next_no: serverNext, example: compose(0, serverNext) },
    free,
    all_taken: free.length === 0,
    prefixes: rows.map(r => ({
      prefix: Number(r.prefix),
      device_id: r.device_id,
      device_name: r.device_name || null,
      platform: r.platform || null,
      app_version: r.app_version || null,
      last_seen_at: r.last_seen_at || null,
      revoked: !!r.revoked_at,
      allocated_at: r.created_at,
      next_no: Number(r.next_no) || 1,
      used_today: Number(r.next_no || 1) > 1,
      example: compose(Number(r.prefix), Number(r.next_no) || 1),
    })),
    history: await db.query(
      `SELECT prefix, device_id, device_name, allocated_at, released_at, released_by, numbers_seen
         FROM app_device_number_history
        WHERE client_id=? AND released_at IS NOT NULL
        ORDER BY released_at DESC LIMIT 20`, [clientId]).catch(() => []),
  };
}

/* ------------------------------------------------------------------ */
/* paired devices                                                     */
/* ------------------------------------------------------------------ */

/**
 * One row per physical device, not one per token.
 *
 * lan.issueDeviceToken always INSERTs, so re-pairing the same phone leaves the
 * old row (and the old token) behind and alive. Listing raw token rows would
 * therefore show the same tablet three times and, worse, "Erişimi kes" on the
 * top one would leave two working tokens on the device. So rows are grouped by
 * device_id, the newest token represents the device, and `sessions` says how
 * many are actually outstanding. Revoking follows the same rule - see revoke().
 */
async function devices(clientId) {
  const rows = await db.query(
    `SELECT d.id, d.device_id, d.device_name, d.platform, d.app_version, d.role,
            d.last_seen_at, d.last_ip, d.created_at, d.expires_at, d.revoked_at, d.user_ref,
            u.display_name AS user_name,
            n.prefix,
            (SELECT COUNT(*) FROM app_device_tokens x
              WHERE x.client_id=d.client_id AND x.device_id=d.device_id AND x.revoked_at IS NULL) AS sessions
       FROM app_device_tokens d
       JOIN (SELECT device_id, MAX(id) id FROM app_device_tokens WHERE client_id=? GROUP BY device_id) m
         ON m.id = d.id
       LEFT JOIN users u ON u.id = d.user_ref AND u.client_id = d.client_id
       LEFT JOIN app_device_numbers n ON n.client_id = d.client_id
                                     AND n.device_id COLLATE utf8mb4_unicode_ci = d.device_id
      WHERE d.client_id = ?
      ORDER BY (d.revoked_at IS NOT NULL), d.last_seen_at DESC, d.id DESC`, [clientId, clientId]);

  const now = Date.now();
  return rows.map((r) => {
    const seen = r.last_seen_at ? new Date(r.last_seen_at).getTime() : 0;
    const expired = r.expires_at && new Date(r.expires_at).getTime() < now;
    let state = 'idle';
    if (r.revoked_at) state = 'revoked';
    else if (expired) state = 'expired';
    else if (seen && now - seen < ONLINE_SECONDS * 1000) state = 'online';
    return {
      id: r.id,
      device_id: r.device_id,
      name: r.device_name || r.device_id,
      platform: r.platform || null,
      app_version: r.app_version || null,
      role: r.role,
      user_name: r.user_name || null,
      last_seen_at: r.last_seen_at,
      last_ip: r.last_ip,
      paired_at: r.created_at,
      expires_at: r.expires_at,
      revoked_at: r.revoked_at,
      sessions: Number(r.sessions) || 0,
      prefix: r.prefix === null || r.prefix === undefined ? null : Number(r.prefix),
      state,
      seconds_since_seen: seen ? Math.floor((now - seen) / 1000) : null,
    };
  });
}

async function deviceRow(clientId, id) {
  const row = await db.one('SELECT * FROM app_device_tokens WHERE id=? AND client_id=?', [id, clientId]);
  if (!row) { const e = new Error('Cihaz bulunamadı'); e.status = 404; throw e; }
  return row;
}

/** Rename: the name is on every token row of the device, so all of them move. */
async function rename(clientId, id, name) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) { const e = new Error('Cihaz adı boş olamaz'); e.status = 400; throw e; }
  const row = await deviceRow(clientId, id);
  await db.exec('UPDATE app_device_tokens SET device_name=? WHERE client_id=? AND device_id=?',
    [clean, clientId, row.device_id]);
  await db.exec('UPDATE app_device_number_history SET device_name=? WHERE client_id=? AND device_id=?',
    [clean, clientId, row.device_id]).catch(() => {});
  log.info('device', 'Cihaz yeniden adlandırıldı', { device_id: row.device_id, name: clean });
  return { device_id: row.device_id, name: clean };
}

/**
 * Cut a device off.
 *
 * Every token row of that device_id is revoked, not just the one whose id was
 * clicked. "Erişimi kes" has to mean the device stops working; revoking one of
 * three outstanding tokens looks identical in the list and changes nothing on
 * the phone.
 *
 * The prefix is deliberately left alone - a revoked device may still be
 * holding unsynced bills numbered on it, and handing that prefix straight to
 * the next tablet is how two bills end up with the same number. Retiring
 * (below) is the explicit action that also gives the prefix back.
 */
async function revoke(clientId, id) {
  const row = await deviceRow(clientId, id);
  const n = await db.exec(
    'UPDATE app_device_tokens SET revoked_at=NOW() WHERE client_id=? AND device_id=? AND revoked_at IS NULL',
    [clientId, row.device_id]);
  log.info('device', 'Cihaz erişimi kesildi', { device_id: row.device_id, tokens: n });
  return { device_id: row.device_id, revoked: n };
}

/** Un-revoke is not offered: the phone holds a hashed token we cannot re-issue. */
async function retire(clientId, id, byName = null) {
  const row = await deviceRow(clientId, id);
  const out = await revoke(clientId, id);
  let released = null;
  const own = await db.one(
    'SELECT prefix FROM app_device_numbers WHERE client_id=? AND device_id=?', [clientId, row.device_id]);
  if (own) released = await releasePrefix(clientId, own.prefix, byName);
  // the token rows themselves are kept: they are the only record of which
  // device pushed which op, and app_sync_ops.device_id points at them
  return { ...out, released_prefix: released ? released.prefix : null, released };
}

/* ------------------------------------------------------------------ */
/* pairing codes                                                      */
/* ------------------------------------------------------------------ */

/**
 * A pairing code, with the retry lan.createPairCode does not have.
 *
 * np_mobile_pairings has UNIQUE uq_code on the six digits alone (not per
 * tenant, not per day), so a random collision with a code that is still alive
 * throws instead of picking another one. One in nine hundred thousand is rare
 * and it is also a Tuesday-evening support call, so we simply try again.
 */
async function createPairCode(clientId, userId, forUserId = null) {
  let staff = null;
  if (forUserId) {
    staff = await db.one(
      'SELECT id, display_name, role FROM users WHERE id=? AND client_id=? AND is_active=1', [forUserId, clientId]);
    if (!staff) { const e = new Error('Bu personel bulunamadı'); e.status = 404; throw e; }
  }
  let last = null;
  for (let i = 0; i < 6; i++) {
    try {
      const out = await lan.createPairCode(clientId, userId, staff ? staff.id : null);
      const row = await db.one(
        'SELECT pair_code, expires_at, TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS secs FROM np_mobile_pairings WHERE pair_code=?',
        [out.code]);
      log.info('device', 'Eşleştirme kodu üretildi', { by: userId, for: staff ? staff.id : null });
      return decorate({ ...out, expires_at: row ? row.expires_at : null,
        seconds_left: row ? Math.max(0, Number(row.secs)) : out.expires_in,
        for_user: staff ? { id: staff.id, name: staff.display_name, role: staff.role } : null });
    } catch (e) { last = e; if (!dup(e)) throw e; }
  }
  throw last;
}

/* ------------------------------------------------------------------ */
/* the QR symbol                                                      */
/* ------------------------------------------------------------------ */

/**
 * What the phone actually scans.
 *
 * Deliberately NOT an http:// URL. An address the phone could open in a
 * browser would put the pairing token into the till's own access log, into
 * whatever the phone's camera app keeps, and one careless screenshot away from
 * a chat group. A private scheme is read by the NOKTApp Garson app and by
 * nothing else, which is the whole audience this symbol has.
 *
 *   noktapp://pair?b=192.168.1.40:7327&t=<32 hex>&a=<other addresses>&c=<tenant>
 *
 * The addresses carry no scheme - see the note inside pairPayload for why,
 * and PairQr.parse in the Garson app, which puts http:// back on.
 *
 * `b` saves the phone the discovery sweep entirely: it knows the till's
 * address before it has sent a single packet. `a` carries the other addresses
 * this PC answers on, so a phone on the second network card still lands.
 */
function pairPayload(p) {
  const addrs = (p.addresses && p.addresses.length ? p.addresses : addresses())
    /*
     * SHORT, BECAUSE EVERY CHARACTER IS MODULES ON A SCREEN.
     *
     * The addresses used to go in percent-encoded and whole -
     * b=http%3A%2F%2F192.168.2.136%3A7451 - which is 37 characters to say
     * nineteen. On a PC with an ethernet card, a wifi card and a hypervisor
     * adapter the payload reached 190 characters, and 190 characters at error
     * correction L is a 53x53 symbol. Drawn 240 pixels wide that is four
     * pixels per module, off a glossy monitor, held by somebody in the middle
     * of service. It decodes on a bench and it is miserable in a restaurant.
     *
     * The scheme and the encoding carry no information here: the phone puts
     * http:// back on anything that arrives without it. Dropping them takes
     * the same symbol to 41x41 - a third fewer rows, half again the module
     * size - and the phone reads it at arm's length.
     */
    .map(a => String(a).replace(/^https?:\/\//, ''));
  const q = ['b=' + (addrs[0] || ''), 't=' + p.qr_token];
  if (addrs.length > 1) q.push('a=' + addrs.slice(1, 3).join(','));
  /*
   * `c` IS THE ONE THAT MAKES THIS WORK OUTSIDE THE BUILDING.
   *
   * With only `b` and `a` the symbol is a list of private addresses, and a
   * phone that is not on that Wi-Fi can do nothing with any of them - which
   * meant a waiter could only ever be paired standing next to the till, on the
   * right network, with a laptop-shaped problem in the middle of service. With
   * the tenant number in the symbol the phone can hand the token to the cloud
   * relay instead and be paired from anywhere; the LAN addresses stay first
   * because they are faster and need no internet, and become an optimisation
   * rather than a requirement.
   */
  if (p.client_id) q.push('c=' + encodeURIComponent(String(p.client_id)));
  return 'noktapp://pair?' + q.join('&');
}

/**
 * The symbol as an <svg> string the till can drop straight into the page.
 *
 * Error correction is L, not the M the table card uses: this code is read off
 * a bright screen from 30cm away, never off a printed card that has been in a
 * pocket, and L keeps the module count (and therefore the printed module size)
 * lower for the same physical square.
 */
function qrSvg(payload, size = 300) {
  const svg = new QRCode({ content: String(payload), padding: 2, width: size, height: size,
    color: '#18181B', background: '#FFFFFF', ecl: 'L', join: true }).svg();
  /*
   * THE viewBox, AND WHY PAIRING NEVER WORKED.
   *
   * qrcode-svg emits <svg width="300" height="300"> and NO viewBox. The
   * screen's CSS then says `.pair__qr svg { width:100%; height:100% }` into a
   * box that is 212 pixels inside its padding. Without a viewBox those two
   * facts do not combine the way they look like they do: the element is
   * displayed at 212 while its contents keep drawing at 300 user units, so the
   * symbol is not scaled down - it is CROPPED. The right hand column and the
   * bottom row of modules, including the bottom-left finder pattern, were
   * simply not on the screen.
   *
   * A QR code with two of its three finder patterns is not a damaged QR code
   * that a good camera might still manage. It is not a QR code. Every phone
   * that has ever been held up to this screen was looking at something no
   * decoder on earth would accept, which is why "karekod okutun" has never
   * worked for anybody, on any build, on any network - while the six digit
   * code underneath it worked perfectly and hid the fault for months.
   *
   * One attribute fixes it: with a viewBox the drawing scales to whatever box
   * the page gives it, at any size, on any screen.
   */
  return svg.replace(/<svg([^>]*)>/, (m, attrs) =>
    /viewBox=/.test(attrs) ? m : `<svg${attrs} viewBox="0 0 ${size} ${size}" preserveAspectRatio="xMidYMid meet">`);
}

/** Attach the parts the screen needs and strip the raw token out of the reply. */
function decorate(p) {
  if (!p) return null;
  const payload = pairPayload(p);
  const { qr_token, ips, ...rest } = p;              // eslint-disable-line no-unused-vars
  return { ...rest, addresses: p.addresses && p.addresses.length ? p.addresses : addresses(),
    qr: { payload, svg: qrSvg(payload) } };
}

/**
 * Who a code may be minted for.
 *
 * Everyone active except the machine accounts: a pairing code minted for
 * "Kasa" would hand a phone the till's own role. Ordering is the order the
 * owner thinks in - waiters first, because that is who carries a phone.
 */
const HANDHELD_ROLES = ['waiter', 'cashier', 'manager', 'admin'];
async function pairableStaff(clientId) {
  const rows = await db.query(
    `SELECT id, display_name, role, username FROM users
      WHERE client_id=? AND is_active=1 AND role IN (${HANDHELD_ROLES.map(() => '?').join(',')})
      ORDER BY FIELD(role, ${HANDHELD_ROLES.map(() => '?').join(',')}), display_name`,
    [clientId, ...HANDHELD_ROLES, ...HANDHELD_ROLES]);
  return rows.map(u => ({ id: u.id, name: u.display_name || u.username, role: u.role }));
}

/** The code still on screen, so reopening the tab does not invalidate it. */
async function activePairCode(clientId) {
  const row = await db.one(
    `SELECT pair_code, qr_token, for_user_id, expires_at, TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS secs
       FROM np_mobile_pairings
      WHERE client_id=? AND used_at IS NULL AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1`, [clientId]);
  if (!row) return null;
  const staff = row.for_user_id
    ? await db.one('SELECT id, display_name, role FROM users WHERE id=? AND client_id=?', [row.for_user_id, clientId])
    : null;
  return decorate({ code: row.pair_code, qr_token: row.qr_token, expires_at: row.expires_at,
    client_id: clientId,
    seconds_left: Math.max(0, Number(row.secs)), addresses: addresses(),
    for_user: staff ? { id: staff.id, name: staff.display_name, role: staff.role } : null });
}

/** Expire every unused code now - the owner closed the dialog, the code dies. */
async function cancelPairCodes(clientId) {
  const n = await db.exec(
    'UPDATE np_mobile_pairings SET expires_at=NOW() WHERE client_id=? AND used_at IS NULL AND expires_at > NOW()',
    [clientId]);
  return { cancelled: n };
}

function addresses() {
  return lan.addresses();
}

/* ------------------------------------------------------------------ */
/* the outbox                                                         */
/* ------------------------------------------------------------------ */

/**
 * What the queue is doing, in the terms the person asking actually uses.
 *
 * `stuck` is the number that matters and it is not the same as `pending`:
 * sync.drain() selects `attempts < 10`, so a row that has been refused ten
 * times is not retried again by anything, ever. It is not marked failed
 * either - it just sits there, and the outbox looks merely "busy" for the rest
 * of the installation's life. Counting those separately is the whole reason
 * this screen exists.
 */
async function syncStatus(clientId) {
  const c = await db.one(
    `SELECT
        SUM(status='pending' AND attempts < ?)                AS pending,
        SUM(status='pending' AND attempts >= ?)               AS stuck,
        SUM(status='failed')                                  AS failed,
        SUM(status='sent')                                    AS sent,
        MAX(CASE WHEN status='sent' THEN sent_at END)         AS last_sent_at,
        MIN(CASE WHEN status='pending' THEN created_at END)   AS oldest_pending_at
       FROM np_sync_outbox WHERE client_id=?`, [MAX_ATTEMPTS, MAX_ATTEMPTS, clientId]);

  const lastError = await db.one(
    `SELECT id, entity, entity_id, op, attempts, last_error, created_at
       FROM np_sync_outbox
      WHERE client_id=? AND last_error IS NOT NULL AND last_error <> ''
      ORDER BY id DESC LIMIT 1`, [clientId]);

  const byEntity = await db.query(
    `SELECT entity, COUNT(*) n, MIN(created_at) oldest
       FROM np_sync_outbox WHERE client_id=? AND status='pending'
      GROUP BY entity ORDER BY n DESC`, [clientId]);

  const pending = Number(c && c.pending) || 0;
  const stuck = Number(c && c.stuck) || 0;
  const oldest = c && c.oldest_pending_at ? new Date(c.oldest_pending_at).getTime() : 0;

  return {
    pending,
    stuck,
    failed: Number(c && c.failed) || 0,
    sent: Number(c && c.sent) || 0,
    waiting: pending + stuck,
    last_sent_at: (c && c.last_sent_at) || null,
    oldest_pending_at: (c && c.oldest_pending_at) || null,
    /* how long the oldest thing in the queue has been waiting, in minutes */
    queue_age_min: oldest ? Math.floor((Date.now() - oldest) / 60000) : 0,
    max_attempts: MAX_ATTEMPTS,
    last_error: lastError ? {
      id: lastError.id, entity: lastError.entity, entity_id: lastError.entity_id,
      op: lastError.op, attempts: Number(lastError.attempts),
      message: lastError.last_error, at: lastError.created_at,
    } : null,
    by_entity: byEntity.map(r => ({ entity: r.entity, n: Number(r.n), oldest: r.oldest })),
  };
}

/**
 * The operations that went wrong, with the reason.
 *
 * Anything that has ever errored is listed, not only the ten-attempt dead
 * rows: a row on attempt three is still failing and the owner can see the
 * panel's own words for why. `blocked` marks the ones the drain has given up
 * on, because those are the ones that will never move without this screen.
 */
async function failedOps(clientId, limit = 100) {
  const rows = await db.query(
    `SELECT id, entity, entity_id, op, status, attempts, last_error, created_at, sent_at,
            LEFT(COALESCE(payload,''), 400) AS payload_head
       FROM np_sync_outbox
      WHERE client_id=? AND (status='failed' OR (attempts > 0 AND status <> 'sent'))
      ORDER BY (attempts >= ?) DESC, id DESC
      LIMIT ?`, [clientId, MAX_ATTEMPTS, Math.min(Number(limit) || 100, 500)]);
  return rows.map(r => ({
    id: r.id, entity: r.entity, entity_id: r.entity_id, op: r.op, status: r.status,
    attempts: Number(r.attempts), reason: r.last_error || 'Bilinmeyen hata',
    created_at: r.created_at, sent_at: r.sent_at,
    blocked: Number(r.attempts) >= MAX_ATTEMPTS,
    payload_head: r.payload_head,
  }));
}

/**
 * Put a row back in the queue.
 *
 * Resetting `attempts` is the operative part: the drain filters on it, so a
 * blocked row that keeps its counter is retried by nothing even after the
 * reason has been fixed. The old error text is cleared with it so the screen
 * does not keep reporting a failure that has since been repaired.
 */
async function retryOp(clientId, id) {
  const n = await db.exec(
    `UPDATE np_sync_outbox SET status='pending', attempts=0, last_error=NULL, sent_at=NULL
      WHERE id=? AND client_id=? AND status <> 'sent'`, [id, clientId]);
  if (!n) { const e = new Error('İşlem bulunamadı veya zaten gönderilmiş'); e.status = 404; throw e; }
  log.info('device', 'Bekleyen işlem yeniden kuyruğa alındı', { outbox_id: id });
  return { retried: n };
}

async function retryAll(clientId) {
  const n = await db.exec(
    `UPDATE np_sync_outbox SET status='pending', attempts=0, last_error=NULL
      WHERE client_id=? AND (status='failed' OR (attempts >= ? AND status='pending'))`,
    [clientId, MAX_ATTEMPTS]);
  log.info('device', 'Takılan işlemler yeniden kuyruğa alındı', { count: n });
  return { retried: n };
}

/**
 * "Şimdi gönder".
 *
 * sync.drain() never throws - it logs at debug and returns - so the button
 * cannot report a failure by catching one. What it reports instead is the
 * difference the run made and whatever error the rows are now carrying, which
 * is the honest answer either way.
 */
async function pushNow(clientId) {
  const before = await syncStatus(clientId);
  await sync.drain();
  const after = await syncStatus(clientId);
  const moved = Math.max(0, before.waiting - after.waiting);
  log.info('device', 'Elle senkron çalıştırıldı', { pushed: moved, remaining: after.waiting });
  /* `pushed` and not `sent`: syncStatus already uses `sent` for the lifetime
     count of delivered rows, and one number quietly overwriting the other is
     how a button that did nothing reports success. */
  return { ...after, pushed: moved };
}

/* ------------------------------------------------------------------ */
/* connection                                                         */
/* ------------------------------------------------------------------ */

/**
 * How much of the offline window is left.
 *
 * Rounded UP on purpose. The window closes `grace_days` after the last
 * successful check, so eleven hours before it shuts there is genuinely still
 * most of a day of trading left; floor() would put "0 gün" on a screen that is
 * still working perfectly, and the cashier who reads it either panics or -
 * worse - learns to ignore the number.
 */
function graceOf(lic, now = Date.now()) {
  const graceDays = Number(lic && lic.grace_days) || 7;
  const lastOk = lic && lic.last_ok_at ? new Date(lic.last_ok_at).getTime() : 0;
  if (!lastOk) {
    return { grace_days: graceDays, last_ok_at: null, ends_at: null,
      days_left: 0, hours_left: 0, expired: true };
  }
  const endsAt = lastOk + graceDays * 86400000;
  const msLeft = endsAt - now;
  return {
    grace_days: graceDays,
    last_ok_at: lic.last_ok_at,
    ends_at: new Date(endsAt).toISOString(),
    days_left: Math.max(0, Math.ceil(msLeft / 86400000)),
    hours_left: Math.max(0, Math.ceil(msLeft / 3600000)),
    expired: msLeft <= 0,
  };
}

/** Days until the licence itself runs out. Null when it never does. */
function daysToExpiry(expiresAt, now = Date.now()) {
  if (!expiresAt) return null;
  return Math.ceil((new Date(expiresAt).getTime() - now) / 86400000);
}

/**
 * Licence, grace, relay and the address the phones need - in one read.
 *
 * The warnings array is the reason this is not four separate endpoints: an
 * expiring licence has to be seen BEFORE it expires, and something has to
 * decide, in one place, that fourteen days is when to start saying so.
 */
async function connection(clientId) {
  const lic = await db.one('SELECT * FROM np_licence WHERE id=1');
  const st = await licence.status();
  const grace = graceOf(lic);
  const toExpiry = lic ? daysToExpiry(lic.expires_at) : null;

  const relayRow = await db.one('SELECT * FROM np_relay_state WHERE id=1');
  const relayEnabled = String(await db.getSetting('relay_enabled', '1')) === '1';
  const lastPoll = relayRow && relayRow.last_poll_at ? new Date(relayRow.last_poll_at).getTime() : 0;
  const relay = {
    enabled: relayEnabled,
    last_poll_at: relayRow ? relayRow.last_poll_at : null,
    consecutive_errors: relayRow ? Number(relayRow.consecutive_errors) : 0,
    last_msg_id: relayRow ? Number(relayRow.last_msg_id) : 0,
    /* "connected" means a poll landed inside the last minute and a half AND it
       was not an error - a poller that is failing every 1.5s also updates
       last_poll_at, so freshness alone would call a dead line healthy. */
    connected: relayEnabled && !!lastPoll &&
      (Date.now() - lastPoll) < RELAY_STALE_SECONDS * 1000 &&
      (relayRow ? Number(relayRow.consecutive_errors) : 1) === 0,
  };

  const lanEnabled = String(await db.getSetting('lan_enabled', '1')) === '1';
  const warnings = [];
  if (!lic) {
    warnings.push({ level: 'error', text: 'Bu bilgisayarda lisans kaydı yok. İnternete bağlanıp giriş yapın.' });
  } else {
    if (lic.status !== 'active') {
      warnings.push({ level: 'error', text: 'Lisans durumu: ' + lic.status + '. Destek ile görüşün.' });
    }
    if (toExpiry !== null && toExpiry <= 0) {
      warnings.push({ level: 'error', text: 'Lisans süresi doldu.' });
    } else if (toExpiry !== null && toExpiry <= 14) {
      warnings.push({ level: 'warn', text: `Lisans ${toExpiry} gün sonra bitiyor. Yenilemek için destek ile görüşün.` });
    }
    if (grace.expired) {
      warnings.push({ level: 'error', text: 'Çevrimdışı kullanım süresi doldu. Lisans doğrulanana kadar kasa açılmaz.' });
    } else if (grace.days_left <= 2) {
      warnings.push({ level: 'warn', text: `İnternetsiz çalışma süresi ${grace.days_left} gün sonra doluyor.` });
    }
    if (!relay.connected && relayEnabled) {
      warnings.push({ level: 'warn', text: 'Uzaktan bağlantı (bulut aktarımı) şu an kapalı. Dışarıdaki telefonlar kasaya ulaşamaz.' });
    }
  }

  return {
    licence: {
      licensed: !!st.licensed,
      status: lic ? lic.status : null,
      plan: lic ? lic.plan_name : null,
      company: lic ? lic.company_name : null,
      seats: lic ? Number(lic.seats) : null,
      key_tail: lic && lic.licence_key ? String(lic.licence_key).slice(-6) : null,
      expires_at: lic ? lic.expires_at : null,
      days_to_expiry: toExpiry,
      last_check_at: lic ? lic.last_check_at : null,
      last_ok_at: lic ? lic.last_ok_at : null,
      /* the check ran but the panel said no / was unreachable */
      last_check_failed: !!(lic && lic.last_check_at && lic.last_ok_at &&
        new Date(lic.last_check_at).getTime() - new Date(lic.last_ok_at).getTime() > 60000),
    },
    grace,
    relay,
    lan: {
      enabled: lanEnabled,
      port: config.port,
      ips: lan.localIps(),
      addresses: addresses(),
      hostname: require('os').hostname(),
    },
    panel_url: await licence.panelUrl(),
    device_id: await licence.deviceId(),
    outbox: await syncStatus(clientId),
    /*
     * The branch, for the one row the connection card draws. On a single-shop
     * till this is `{bound:false, ...}` read out of one settings row - no
     * request, and the screen draws nothing for it.
     */
    branch: await require('./zincir').state(clientId),
    warnings,
  };
}

/** "Şimdi doğrula" - one heartbeat, then the fresh picture. */
async function checkNow(clientId) {
  const beat = await licence.heartbeat();
  const out = await connection(clientId);
  return { ...out, check: beat };
}

/* ------------------------------------------------------------------ */
/* activity log                                                       */
/* ------------------------------------------------------------------ */

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

/**
 * np_app_log, readable.
 *
 * Every filter is optional and they combine, because a support call starts
 * with a time ("saat yedi civarı") and narrows from there - not with a level.
 * `q` searches the message and the detail together: the useful string is
 * nearly always inside the detail JSON (an order id, a printer address), and a
 * person searching for it does not know which column it lives in.
 */
async function logs(filter = {}) {
  const where = [];
  const args = [];
  const level = String(filter.level || '').trim();
  if (level && LOG_LEVELS.includes(level)) { where.push('level = ?'); args.push(level); }
  const area = String(filter.area || '').trim();
  if (area) { where.push('area = ?'); args.push(area); }
  if (String(filter.only_problems || '') === '1') where.push("level IN ('error','warn')");
  const q = String(filter.q || '').trim();
  if (q) {
    where.push('(message LIKE ? OR detail LIKE ?)');
    args.push('%' + q + '%', '%' + q + '%');
  }
  if (filter.from) { where.push('created_at >= ?'); args.push(String(filter.from).slice(0, 10) + ' 00:00:00'); }
  if (filter.to) { where.push('created_at <= ?'); args.push(String(filter.to).slice(0, 10) + ' 23:59:59'); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const limit = Math.min(Math.max(Number(filter.limit) || 100, 1), 500);
  const offset = Math.max(Number(filter.offset) || 0, 0);

  const rows = await db.query(
    `SELECT id, level, area, message, LEFT(COALESCE(detail,''), 2000) AS detail, created_at
       FROM np_app_log${sql} ORDER BY id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const total = Number(await db.value(`SELECT COUNT(*) FROM np_app_log${sql}`, args)) || 0;

  return {
    rows,
    total,
    limit,
    offset,
    areas: await db.query(
      `SELECT area, COUNT(*) n FROM np_app_log
        WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY area ORDER BY area`),
    levels: await db.query(
      `SELECT level, COUNT(*) n FROM np_app_log
        WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY level`),
  };
}

module.exports = {
  SERIES_MAX, MAX_PREFIX, MAX_ATTEMPTS,
  compose, decompose, allocatePrefix, releasePrefix, observeNumber, prefixState,
  devices, rename, revoke, retire,
  createPairCode, activePairCode, cancelPairCodes, pairableStaff, pairPayload, qrSvg,
  syncStatus, failedOps, retryOp, retryAll, pushNow,
  connection, checkNow, graceOf, daysToExpiry,
  logs,
};
