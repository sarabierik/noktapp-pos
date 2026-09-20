'use strict';
/**
 * SADAKAT — the loyalty engine, ported from pos.noktapp.com/pos/loyalty/lib.php
 * (which itself absorbed the old pass.noktapp.com app) and re-fitted to the
 * local-first desktop.
 *
 * What is kept exactly as it works today:
 *   - one stamp PER ITEM bought, not one per scan
 *   - stamps roll over: buying 3 on a 10-stamp card moves you 3 forward and
 *     mints a reward as soon as the target is crossed
 *   - a bill is never stamped twice, whichever route the stamp came from
 *   - redemption is atomic — the UPDATE is the check, so two tills tapping at
 *     once cannot spend the same reward twice
 *   - a redeemed reward takes real money off the bill, through the discount
 *     ledger, so the next item change does not silently put it back
 *
 * What is different on the desktop, and has to be:
 *   customers are GLOBAL to the platform (one person, one QR, any restaurant)
 *   but this database belongs to one restaurant. So an unknown QR or phone is
 *   resolved against the panel once and then cached locally; from then on the
 *   till recognises that guest with the internet unplugged. Stamps are always
 *   written here first and pushed up afterwards — the guest's card must never
 *   depend on our server being reachable at the counter.
 */
const _crypto = require('crypto');
const db = require('../db');
const log = require('../logger');
const { money } = require('../util/http');

/* ------------------------------------------------------------------ */
/* Turkish mobile numbers                                             */
/* ------------------------------------------------------------------ */

/** One canonical shape: 10 digits starting with 5. */
function trPhone(raw) {
  let d = String(raw || '').replace(/\D+/g, '');
  if (d.length === 12 && d.startsWith('90')) d = d.slice(2);
  if (d.length === 11 && d[0] === '0') d = d.slice(1);
  return d;
}
function trPhoneOk(p) { return /^5\d{9}$/.test(String(p)); }

/** Every shape the same number might already be stored as. */
function trPhoneVariants(raw) {
  const p = trPhone(raw);
  if (!p) return [];
  const out = new Set([p, '0' + p, '90' + p, '+90' + p, '0090' + p]);
  if (trPhoneOk(p)) {
    out.add(`${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6, 8)} ${p.slice(8)}`);
    out.add(`0${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6, 8)} ${p.slice(8)}`);
  }
  return Array.from(out);
}

/* ------------------------------------------------------------------ */
/* finding the guest                                                  */
/* ------------------------------------------------------------------ */
async function findByPhone(raw) {
  const v = trPhoneVariants(raw);
  if (!v.length) return null;
  return db.one(
    `SELECT * FROM customers WHERE phone IN (${v.map(() => '?').join(',')})
       AND COALESCE(is_active,1)=1 LIMIT 1`, v);
}

/** Store a customer the panel told us about, so the till knows them offline. */
async function cacheCustomer(c) {
  if (!c || !c.id) return null;
  await db.exec(
    `INSERT INTO customers (id, first_name, last_name, phone, email, birth_date, qr_uid,
        is_verified, is_active, created_by_client_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,?,NOW(),NOW())
     ON DUPLICATE KEY UPDATE first_name=VALUES(first_name), last_name=VALUES(last_name),
        phone=VALUES(phone), email=VALUES(email), qr_uid=VALUES(qr_uid), updated_at=NOW()`,
    [c.id, c.first_name || '', c.last_name || null, trPhone(c.phone) || null, c.email || null,
     c.birth_date || null, c.qr_uid || null, c.is_verified ? 1 : 0, await db.getClientId()]);
  return db.one('SELECT * FROM customers WHERE id=?', [c.id]);
}

/**
 * Ask the panel who this QR belongs to. Only reached when the guest is not
 * already known here — a regular is resolved locally and instantly.
 */
async function resolveViaPanel(token) {
  const licence = require('../licence');
  const lic = await db.one('SELECT client_id, licence_key FROM np_licence WHERE id=1');
  if (!lic) return null;
  try {
    const res = await licence.post((await licence.panelUrl()) + '/api/desktop/loyalty_resolve.php', {
      client_id: lic.client_id, licence_key: lic.licence_key, token: String(token),
    }, 8000);
    if (res.status === 200 && res.body && res.body.ok && res.body.customer) {
      return cacheCustomer(res.body.customer);
    }
  } catch (e) {
    log.debug('loyalty', 'panel resolve failed', e.message);
  }
  return null;
}

/**
 * Turn whatever the cashier scanned or typed into a guest.
 * Accepts: a one-time QR token (64 hex), a printed card's permanent qr_uid,
 * or a phone number. An unknown phone is NOT enrolled silently — a typo would
 * quietly create a junk account.
 */
async function resolve(token, { allowPanel = true } = {}) {
  const raw = String(token || '').trim();
  if (!raw) return { error: 'EMPTY' };

  // 1) one-time QR token
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    const t = await db.one(
      'SELECT * FROM loyalty_qr_tokens WHERE token=? LIMIT 1', [raw.toLowerCase()]);
    if (t) {
      if (t.used_at) return { error: 'TOKEN_USED' };
      if (new Date(t.expires_at).getTime() <= Date.now()) return { error: 'TOKEN_EXPIRED' };
      const c = await db.one('SELECT * FROM customers WHERE id=? AND is_active=1', [t.customer_id]);
      if (c) return { customer: c, oneTime: raw.toLowerCase() };
    }
    if (allowPanel) {
      const c = await resolveViaPanel(raw);
      if (c) return { customer: c, oneTime: raw.toLowerCase(), fromPanel: true };
    }
    return { error: 'TOKEN_INVALID' };
  }

  // 2) a phone number
  if (/^\+?\d[\d\s\-()]{6,19}$/.test(raw)) {
    const hit = await findByPhone(raw);
    if (hit) return { customer: hit };
    if (allowPanel) {
      const c = await resolveViaPanel(trPhone(raw));
      if (c) return { customer: c, fromPanel: true };
    }
    return { error: 'PHONE_UNKNOWN' };
  }

  // 3) a printed card carrying the permanent uid
  const c = await db.one('SELECT * FROM customers WHERE qr_uid=? AND is_active=1 LIMIT 1', [raw]);
  if (c) return { customer: c };
  if (allowPanel) {
    const p = await resolveViaPanel(raw);
    if (p) return { customer: p, fromPanel: true };
  }
  return { error: 'TOKEN_INVALID' };
}

/**
 * Enrol someone at the counter.
 *
 * The guest account is global - one person, one QR, every NOKTApp restaurant -
 * so only the server can mint the identity. A local id would collide with the
 * registry the Pass app writes to, and two different people would end up
 * sharing a card. So enrolment asks the panel, and says so plainly when the
 * line is down rather than creating something that has to be untangled later.
 *
 * Nothing else about loyalty needs the internet: a guest who already exists is
 * recognised, stamped and rewarded entirely on this machine.
 */
async function enrol(clientId, { firstName, lastName, phone, email }) {
  const p = trPhone(phone);
  if (!trPhoneOk(p)) { const e = new Error('Telefon 5 ile baslayan 10 hane olmali'); e.status = 400; throw e; }
  if (!String(firstName || '').trim()) { const e = new Error('Ad zorunlu'); e.status = 400; throw e; }

  const existing = await findByPhone(p);
  if (existing) return existing;

  const licence = require('../licence');
  const lic = await db.one('SELECT client_id, licence_key FROM np_licence WHERE id=1');
  let res;
  try {
    res = await licence.post((await licence.panelUrl()) + '/api/desktop/loyalty_enrol.php', {
      client_id: lic.client_id, licence_key: lic.licence_key,
      first_name: String(firstName).trim(), last_name: lastName || null,
      phone: p, email: email || null,
    }, 12000);
  } catch (err) {
    const e = new Error('Yeni musteri kaydi icin internet gerekli. Su an baglanti yok - musteri kayitliysa telefon numarasiyla aratabilirsiniz.');
    e.status = 503;
    throw e;
  }
  if (res.status !== 200 || !res.body || !res.body.ok || !res.body.customer) {
    const e = new Error((res.body && res.body.error) || 'Musteri kaydedilemedi');
    e.status = 400;
    throw e;
  }
  return cacheCustomer(res.body.customer);
}

/* ------------------------------------------------------------------ */
/* programmes and cards                                               */
/* ------------------------------------------------------------------ */
async function programs(clientId) {
  return db.query(
    `SELECT lp.*, p.name AS product_name, p.price AS product_price
       FROM loyalty_programs lp
       LEFT JOIN products p ON p.id=lp.product_id AND p.client_id=lp.client_id
      WHERE lp.client_id=? AND lp.is_active=1 ORDER BY lp.id`, [clientId]);
}

async function cardIn(t, clientId, customerId, programId) {
  let c = await t.one('SELECT * FROM loyalty_cards WHERE client_id=? AND customer_id=? AND program_id=? LIMIT 1',
    [clientId, customerId, programId]);
  if (c) return c;
  await t.exec(
    `INSERT INTO loyalty_cards (client_id, customer_id, program_id, progress_count,
        rewards_available, rewards_used, created_at, updated_at)
     VALUES (?,?,?,0,0,0,NOW(),NOW())
     ON DUPLICATE KEY UPDATE updated_at=NOW()`, [clientId, customerId, programId]);
  c = await t.one('SELECT * FROM loyalty_cards WHERE client_id=? AND customer_id=? AND program_id=? LIMIT 1',
    [clientId, customerId, programId]);
  return c;
}

/**
 * Add stamps to one card. Rolls over into rewards when the target is hit, so
 * buying 3 at once on a 10-stamp card behaves correctly.
 */
async function addStampIn(t, clientId, customerId, program, qty = 1, source = 'scan', orderId = null, userId = null) {
  const n = Math.max(1, Math.round(Number(qty) || 1));
  const card = await cardIn(t, clientId, customerId, program.id);
  const target = Math.max(1, Number(program.target_count) || 1);

  const raw = Number(card.progress_count) + n;
  const earned = Math.floor(raw / target);
  const progress = raw % target;

  await t.exec(
    `UPDATE loyalty_cards SET progress_count=?, rewards_available=rewards_available+?, updated_at=NOW()
      WHERE id=? AND client_id=?`, [progress, earned, card.id, clientId]);
  await t.exec(
    `INSERT INTO loyalty_events (client_id, customer_id, program_id, card_id, product_id,
        order_id, user_id, kind, qty, source, created_at)
     VALUES (?,?,?,?,?,?,?, 'stamp', ?, ?, NOW())`,
    [clientId, customerId, program.id, card.id, program.product_id || null,
     orderId, userId, n, source]);

  const now = await t.one('SELECT progress_count, rewards_available FROM loyalty_cards WHERE id=?', [card.id]);
  return { card_id: card.id, progress: Number(now.progress_count), rewards: Number(now.rewards_available), earned };
}

/** Every card this guest holds here, in the order the cashier needs them. */
async function cardsFor(clientId, customerId) {
  const rows = await db.query(
    `SELECT lc.id AS card_id, lc.program_id, lc.progress_count, lc.rewards_available, lc.rewards_used,
            lp.title, lp.target_count, lp.reward_text, lp.product_id,
            p.name AS product_name, p.price AS product_price
       FROM loyalty_cards lc
       JOIN loyalty_programs lp ON lp.id=lc.program_id AND lp.client_id=lc.client_id
       LEFT JOIN products p ON p.id=lp.product_id AND p.client_id=lp.client_id
      WHERE lc.client_id=? AND lc.customer_id=? AND lp.is_active=1
      ORDER BY (lc.rewards_available > 0) DESC, lp.id`, [clientId, customerId]);
  return rows.map(r => ({
    ...r,
    target_count: Math.max(1, Number(r.target_count)),
    progress_count: Number(r.progress_count),
    rewards_available: Number(r.rewards_available),
    rewards_used: Number(r.rewards_used || 0),
    remaining: Math.max(0, Math.max(1, Number(r.target_count)) - Number(r.progress_count)),
    product_price: r.product_price === null ? null : Number(r.product_price),
  }));
}

/* ------------------------------------------------------------------ */
/* the till flow                                                      */
/* ------------------------------------------------------------------ */

/**
 * "Sadakat kartınız var mı?" -> scan -> stamps for what they actually bought.
 * Attaches the guest to the bill and stamps every programme their basket
 * matches. One stamp per item.
 */
async function applyToOrder(clientId, token, orderId, userId = null) {
  const found = await resolve(token);
  if (found.error) return { ok: false, error: found.error, message: errorText(found.error) };
  const customer = found.customer;

  const out = await db.tx(async t => {
    const order = await t.one('SELECT id FROM orders WHERE id=? AND client_id=? FOR UPDATE', [orderId, clientId]);
    if (!order) throw Object.assign(new Error('ORDER_NOT_FOUND'), { code: 'ORDER_NOT_FOUND' });

    const already = await t.one(
      "SELECT 1 x FROM loyalty_events WHERE client_id=? AND order_id=? AND kind='stamp' LIMIT 1",
      [clientId, orderId]);
    if (already) throw Object.assign(new Error('ALREADY_AWARDED'), { code: 'ALREADY_AWARDED' });

    const items = await t.query(
      `SELECT product_id, SUM(qty) q FROM order_items
        WHERE order_id=? AND client_id=? AND COALESCE(is_deleted,0)=0 GROUP BY product_id`,
      [orderId, clientId]);
    if (!items.length) throw Object.assign(new Error('EMPTY_ORDER'), { code: 'EMPTY_ORDER' });
    const byProduct = new Map(items.map(i => [i.product_id, Number(i.q)]));

    const progs = await t.query(
      `SELECT lp.*, p.name AS product_name FROM loyalty_programs lp
         LEFT JOIN products p ON p.id=lp.product_id AND p.client_id=lp.client_id
        WHERE lp.client_id=? AND lp.is_active=1 FOR UPDATE`, [clientId]);
    if (!progs.length) throw Object.assign(new Error('NO_PROGRAM'), { code: 'NO_PROGRAM' });

    const lines = [];
    for (const prog of progs) {
      const qty = prog.product_id ? (byProduct.get(prog.product_id) || 0) : 1;  // no product = 1 per visit
      if (qty < 1) continue;
      const r = await addStampIn(t, clientId, customer.id, prog, qty, 'scan', orderId, userId);
      lines.push({
        title: prog.title, product: prog.product_name || 'Her ziyaret',
        added: qty, progress: r.progress, target: Number(prog.target_count),
        earned: r.earned, rewards: r.rewards, reward_text: prog.reward_text, card_id: r.card_id,
      });
    }
    if (!lines.length) throw Object.assign(new Error('NO_MATCH'), { code: 'NO_MATCH' });

    if (found.oneTime) {
      // A code the guest's app generated lives on the server, not here, so the
      // first time this till sees it there is no local row to burn. Write one,
      // then burn it - the same UPDATE then guards against a second scan on
      // this machine, and the panel is told separately.
      if (found.fromPanel) {
        await t.exec(
          `INSERT INTO loyalty_qr_tokens (token, customer_id, expires_at, expires_ts, created_at)
           VALUES (?,?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), ?, NOW())
           ON DUPLICATE KEY UPDATE customer_id=VALUES(customer_id)`,
          [found.oneTime, customer.id, Math.floor(Date.now() / 1000) + 600]);
      }
      const n = await t.exec(
        'UPDATE loyalty_qr_tokens SET used_at=NOW(), used_by_client_id=? WHERE token=? AND used_at IS NULL',
        [clientId, found.oneTime]);
      if (n !== 1) throw Object.assign(new Error('TOKEN_RACE'), { code: 'TOKEN_RACE' });
    }
    await t.exec('UPDATE orders SET customer_id=? WHERE id=? AND client_id=?', [customer.id, orderId, clientId]);
    return { lines };
  }).catch(e => ({ error: e.code || 'ERROR', message: e.message }));

  if (out.error) return { ok: false, error: out.error, message: errorText(out.error) };

  pushStamps(clientId, customer.id, orderId).catch(() => {});
  if (found.oneTime) {
    /*
     * Tell the server the code is spent, so it cannot be used at another shop.
     *
     * AWAITED, unlike the stamp mirror above. This is only a local INSERT into
     * the outbox - the network send happens later - but until that row exists
     * the intent to burn the code is nowhere. Returning ok:true before it lands
     * means a crash in that window loses the burn and the same one-time QR can
     * be spent again somewhere else. A failure still cannot fail the sale.
     */
    try {
      await require('../sync').push('qr_token_used', found.oneTime,
        { token: found.oneTime, customer_id: customer.id });
    } catch (e) {
      log.warn('loyalty', 'one-time code burn not queued: ' + e.message);
    }
  }
  return {
    ok: true,
    customer: { id: customer.id, first_name: customer.first_name, last_name: customer.last_name, phone: customer.phone },
    lines: out.lines,
    cards: await cardsFor(clientId, customer.id),
  };
}

/**
 * Automatic award when a bill closes with a guest attached.
 * Idempotent, and it never throws: a loyalty problem must not stop a bill.
 */
async function awardForOrder(clientId, orderId, userId = null) {
  try {
    const o = await db.one('SELECT customer_id FROM orders WHERE id=? AND client_id=?', [orderId, clientId]);
    if (!o || !o.customer_id) return 0;

    const done = await db.one(
      "SELECT 1 x FROM loyalty_events WHERE client_id=? AND order_id=? AND kind='stamp' LIMIT 1",
      [clientId, orderId]);
    if (done) return 0;

    const progs = await programs(clientId);
    if (!progs.length) return 0;

    const items = await db.query(
      `SELECT product_id, SUM(qty) q FROM order_items
        WHERE order_id=? AND client_id=? AND COALESCE(is_deleted,0)=0 GROUP BY product_id`,
      [orderId, clientId]);
    if (!items.length) return 0;
    const byProduct = new Map(items.map(i => [i.product_id, Number(i.q)]));

    let awarded = 0;
    await db.tx(async t => {
      for (const p of progs) {
        const qty = p.product_id ? (byProduct.get(p.product_id) || 0) : 1;
        if (qty < 1) continue;
        await addStampIn(t, clientId, o.customer_id, p, qty, 'order', orderId, userId);
        awarded += qty;
      }
    });
    if (awarded) pushStamps(clientId, o.customer_id, orderId).catch(() => {});
    return awarded;
  } catch (e) {
    log.warn('loyalty', 'award failed for order ' + orderId, e.message);
    return 0;      // closing a bill must never fail because of loyalty
  }
}

/**
 * Spend one reward — atomically. The UPDATE is the check: if it changes no
 * row there was nothing to spend, and nothing is logged.
 * A free item is worth money, so the bill is discounted by that product's
 * price through the ledger, capped so it can never go below zero.
 */
async function redeem(clientId, { customerId, cardId, orderId = null, userId = null }) {
  return db.tx(async t => {
    const card = await t.one(
      `SELECT lc.*, lp.title, lp.reward_text, lp.product_id, p.price AS product_price
         FROM loyalty_cards lc
         JOIN loyalty_programs lp ON lp.id=lc.program_id AND lp.client_id=lc.client_id
         LEFT JOIN products p ON p.id=lp.product_id AND p.client_id=lp.client_id
        WHERE lc.id=? AND lc.client_id=? AND lc.customer_id=? LIMIT 1 FOR UPDATE`,
      [cardId, clientId, customerId]);
    if (!card) { const e = new Error(errorText('CARD_NOT_FOUND')); e.status = 404; throw e; }

    const n = await t.exec(
      `UPDATE loyalty_cards
          SET rewards_available = rewards_available - 1,
              rewards_used = COALESCE(rewards_used,0) + 1,
              updated_at = NOW()
        WHERE id=? AND client_id=? AND rewards_available > 0`, [cardId, clientId]);
    if (n === 0) { const e = new Error(errorText('NO_REWARD')); e.status = 409; throw e; }

    await t.exec(
      `INSERT INTO loyalty_events (client_id, customer_id, program_id, card_id, product_id,
          order_id, user_id, kind, qty, source, created_at)
       VALUES (?,?,?,?,?,?,?, 'reward', 1, 'manual', NOW())`,
      [clientId, customerId, card.program_id, cardId, card.product_id || null, orderId, userId]);

    let discount = 0;
    if (orderId && card.product_price !== null && Number(card.product_price) > 0) {
      const order = await t.one('SELECT id, total FROM orders WHERE id=? AND client_id=? LIMIT 1 FOR UPDATE',
        [orderId, clientId]);
      if (order) {
        const already = Number(await t.value(
          'SELECT COALESCE(SUM(discount_value),0) FROM order_discounts WHERE order_id=? AND client_id=?',
          [orderId, clientId]));
        discount = money(Math.min(Number(card.product_price), Math.max(0, Number(order.total) - already)));
        if (discount > 0) {
          await t.exec(
            `INSERT INTO order_discounts (client_id, order_id, discount_value, reason, source, ref_id, created_by, created_at)
             VALUES (?,?,?,?, 'loyalty', ?, ?, NOW())`,
            [clientId, orderId, discount, ('Odul: ' + (card.title || '')).slice(0, 190), cardId, userId]);
          await require('./orders').recalc(t, clientId, orderId);
        }
      }
    }
    pushStamps(clientId, customerId, orderId).catch(() => {});
    return { ok: true, card, discount, title: card.title, reward_text: card.reward_text };
  });
}

/**
 * Push the CAMPAIGN DEFINITIONS up, not just the balances.
 *
 * This is the fix for a bug that threw away real work. The till pushed
 * loyalty_cards faithfully - progress_count, rewards_available, every stamp -
 * but never pushed loyalty_programs. So the cloud knew "customer 412 has 4 of
 * something at restaurant 88" and had no idea what the something was. The
 * guest's app joins cards to programmes, found no programme, dropped the row,
 * and showed "Henüz kartın yok" to somebody who had four stamps.
 *
 * Programmes are small and change rarely, so the whole set goes up together
 * rather than one row at a time; the panel upserts by (tenant, program_id).
 */
async function pushPrograms(clientId) {
  const programs = await db.query(
    `SELECT lp.id, lp.product_id, lp.title, lp.target_count, lp.reward_text, lp.is_active,
            p.name AS product_name, p.price AS product_price
       FROM loyalty_programs lp
       LEFT JOIN products p ON p.id = lp.product_id AND p.client_id = lp.client_id
      WHERE lp.client_id=?`, [clientId]);
  return require('../sync').push('loyalty_programs', String(clientId), { programs });
}

/** Let the guest's phone app see the same numbers the till just wrote. */
async function pushStamps(clientId, customerId, orderId) {
  const cards = await cardsFor(clientId, customerId);
  /*
   * Programmes ride along with every stamp push. A restaurant that set its
   * campaign up months ago and never touched it again would otherwise never
   * send one, and its guests would keep seeing an empty list.
   */
  await pushPrograms(clientId).catch(() => {});
  return require('../sync').push('loyalty_cards', `${clientId}:${customerId}`,
    { customer_id: customerId, order_id: orderId, cards });
}

/* ------------------------------------------------------------------ */
/* reporting                                                          */
/* ------------------------------------------------------------------ */

/**
 * Per-programme performance. A stamp scheme is only worth running if the
 * rewards are actually claimed: rewards earned but never collected are a
 * liability sitting on the books, and a programme nobody completes is a
 * target set too high.
 */
async function programReport(clientId, from = null, to = null) {
  const dated = !!(from && to);
  const win = dated ? 'AND DATE(le.created_at) BETWEEN ? AND ?' : '';
  /*
   * The parameters have to arrive in the order the placeholders appear in the
   * SQL: the date window sits in the LEFT JOIN, so it comes BEFORE the
   * client_id in the WHERE. This carried a spare leading clientId in both
   * branches, which shifted every value by one - the dated report came back
   * empty and the undated one only worked by accident of the extra argument
   * being ignored.
   */
  const params = dated ? [from, to, clientId] : [clientId];
  return db.query(
    `SELECT lp.id, lp.title, lp.target_count, lp.reward_text, lp.is_active,
            pr.name AS product_name, COALESCE(pr.price,0) AS unit_price,
            COALESCE(SUM(CASE WHEN le.kind='stamp'  THEN le.qty END),0) AS stamps,
            COALESCE(SUM(CASE WHEN le.kind='reward' THEN 1 END),0)      AS redeemed,
            (SELECT COUNT(*) FROM loyalty_cards c
              WHERE c.program_id=lp.id AND c.client_id=lp.client_id) AS customers,
            (SELECT COALESCE(SUM(c.rewards_available),0) FROM loyalty_cards c
              WHERE c.program_id=lp.id AND c.client_id=lp.client_id) AS available,
            (SELECT COALESCE(SUM(c.progress_count),0) FROM loyalty_cards c
              WHERE c.program_id=lp.id AND c.client_id=lp.client_id) AS progress
       FROM loyalty_programs lp
       LEFT JOIN products pr ON pr.id=lp.product_id AND pr.client_id=lp.client_id
       LEFT JOIN loyalty_events le
              ON le.program_id=lp.id AND le.client_id=lp.client_id ${win}
      WHERE lp.client_id=?
      GROUP BY lp.id ORDER BY lp.id`, params);
}

async function totals(clientId, from = null, to = null) {
  const win = from && to ? 'AND DATE(created_at) BETWEEN ? AND ?' : '';
  const a = from && to ? [clientId, from, to] : [clientId];
  const ev = await db.one(
    `SELECT COALESCE(SUM(CASE WHEN kind='stamp' THEN qty END),0) stamps,
            COALESCE(SUM(CASE WHEN kind='reward' THEN 1 END),0) redeemed,
            COUNT(DISTINCT customer_id) customers
       FROM loyalty_events WHERE client_id=? ${win}`, a);
  const liability = await db.one(
    `SELECT COALESCE(SUM(c.rewards_available),0) open_rewards,
            COALESCE(SUM(c.rewards_available * COALESCE(p.price,0)),0) open_value
       FROM loyalty_cards c
       JOIN loyalty_programs lp ON lp.id=c.program_id
       LEFT JOIN products p ON p.id=lp.product_id
      WHERE c.client_id=?`, [clientId]);
  return {
    stamps: Number(ev.stamps), redeemed: Number(ev.redeemed), customers: Number(ev.customers),
    open_rewards: Number(liability.open_rewards), open_value: money(liability.open_value),
  };
}

async function redemptions(clientId, from, to) {
  return db.query(
    `SELECT le.created_at, le.order_id, lp.title, c.first_name, c.last_name, c.phone,
            COALESCE(d.discount_value,0) AS discount
       FROM loyalty_events le
       JOIN loyalty_programs lp ON lp.id=le.program_id
       LEFT JOIN customers c ON c.id=le.customer_id
       LEFT JOIN order_discounts d ON d.ref_id=le.card_id AND d.order_id=le.order_id AND d.source='loyalty'
      WHERE le.client_id=? AND le.kind='reward' AND DATE(le.created_at) BETWEEN ? AND ?
      ORDER BY le.created_at DESC`, [clientId, from, to]);
}

function errorText(code) {
  return ({
    EMPTY: 'Kod okunamadi',
    TOKEN_INVALID: 'Bu kod tanimli degil',
    TOKEN_USED: 'Bu kod daha once kullanilmis',
    TOKEN_EXPIRED: 'Kodun suresi dolmus, musteri uygulamadan yenilesin',
    TOKEN_RACE: 'Kod ayni anda baska bir kasada kullanildi',
    PHONE_UNKNOWN: 'Bu numara sadakat sisteminde kayitli degil',
    ORDER_NOT_FOUND: 'Adisyon bulunamadi',
    ALREADY_AWARDED: 'Bu adisyona zaten damga verilmis',
    EMPTY_ORDER: 'Adisyonda urun yok',
    NO_PROGRAM: 'Tanimli sadakat programi yok',
    NO_MATCH: 'Adisyondaki urunler hicbir programa uymuyor',
    CARD_NOT_FOUND: 'Kart bulunamadi',
    NO_REWARD: 'Kullanilabilir odul yok',
  })[code] || 'Islem tamamlanamadi';
}

module.exports = {
  pushPrograms,
  trPhone, trPhoneOk, trPhoneVariants, findByPhone, resolve, enrol, cacheCustomer,
  programs, cardsFor, applyToOrder, awardForOrder, redeem, addStampIn,
  programReport, totals, redemptions, errorText,
};
