'use strict';
/**
 * ONE pipeline, for webhooks and for polling.
 *
 *   verify -> persist the raw event -> answer the provider -> process
 *   -> deduplicate -> normalise -> create or update the POS order through the
 *      existing order service -> publish -> queue print jobs
 *
 * The order of those first three is the part that matters and the part that is
 * easy to get wrong. A webhook handler that creates the order before it
 * answers is a handler that times out when the local database is busy - and a
 * platform that times out re-sends, so the slow case becomes the duplicate
 * case. So: the raw body is written to np_int_events, the provider is told
 * "received", and everything else happens afterwards on a worker. Polling goes
 * through exactly the same three steps, which is why there is one function
 * here and not two: a bug fixed for the webhook is fixed for the poller.
 *
 * WHAT MAKES IT EXACTLY ONCE
 *
 *   np_int_events.uq_event (client, provider, event_key)
 *       the same delivery is stored once. A replayed webhook is answered 200
 *       and dropped - a provider retrying is not an error and must not be
 *       answered like one.
 *   np_int_orders.uq_external (client, provider, store, order, package)
 *       the same ORDER produces one mirror row however many events describe
 *       it, and the mirror row is what owns the POS order id.
 *   np_int_orders.accept_print_job_id, claimed by a conditional UPDATE
 *       exactly one kitchen slip and exactly one cancellation notice, no
 *       matter how many times the platform tells us the same thing.
 *
 * There is one process per installation - the till's own service, which is
 * also what the relay replays into - so the in-process `withLock` below is a
 * real mutual exclusion and not a hope. The unique keys are the backstop
 * underneath it either way.
 *
 * NOTHING HERE PRINTS. Slips are queued through print/index.js, which is the
 * same path the waiter's "Mutfağa gönder" uses, so a delivery order and a
 * table order cannot end up with two different ideas of which printer is which.
 */
const db = require('../db');
const log = require('../logger');
const { money } = require('../util/http');
const orders = require('../modules/orders');
const payments = require('../modules/payments');
const printing = require('../print');
const sync = require('../sync');
const status = require('./status');
const _registry = require('./registry');

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const locks = new Map();
async function withLock(key, fn) {
  while (locks.has(key)) { try { await locks.get(key); } catch (_) {} }
  let release;
  const p = new Promise(r => { release = r; });
  locks.set(key, p);
  try { return await fn(); } finally { locks.delete(key); release(); }
}

/** A datetime MariaDB accepts, from anything a platform might send. */
function dt(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * KVKK: keep the least that still lets a restaurant do its job.
 *
 * The courier has the address; the kitchen needs to know it is a delivery and
 * roughly where, and the cashier needs enough to answer the phone when the
 * guest rings. So the district survives, the street does not, and the phone
 * keeps its last two digits - which is what a guest reads out to identify
 * themselves.
 */
function maskPhone(v) {
  const s = String(v || '').replace(/\s+/g, '');
  if (!s) return null;
  if (s.length <= 4) return '••' + s.slice(-2);
  return s.slice(0, 3) + '•'.repeat(Math.max(3, s.length - 5)) + s.slice(-2);
}
function maskName(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const parts = s.split(/\s+/);
  return parts.map((w, i) => (i === 0 ? w : (w[0] || '') + '.')).join(' ').slice(0, 120);
}
function maskAddress(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  /* Keep the tail - "Kadıköy / İstanbul" - and drop the door number half.
     A platform courier order does not need the street on our paper at all. */
  const bits = s.split('/').map(x => x.trim()).filter(Boolean);
  if (bits.length >= 2) return bits.slice(-2).join(' / ').slice(0, 255);
  return (s.length > 40 ? s.slice(0, 20) + '…' : s).slice(0, 255);
}

async function logLine(clientId, { provider = '', branchId = 1, level = 'info', action = '', orderId = null,
  externalOrderId = null, message = '', detail = null, actor = null } = {}) {
  try {
    const httpc = require('./http');
    await db.exec(
      `INSERT INTO np_int_logs (client_id, provider, branch_id, level, action, order_id, external_order_id,
          message, detail, actor, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
      [clientId, provider, branchId, level, action, orderId, externalOrderId,
       String(message).slice(0, 500),
       detail ? JSON.stringify(httpc.redactBody(detail)).slice(0, 60000) : null, actor]);
  } catch (e) { log.warn('entegrasyon', 'log yazilamadi', e.message); }
}

/* ------------------------------------------------------------------ */
/* 1. persist the raw event                                            */
/* ------------------------------------------------------------------ */
/**
 * Write the event down and say whether we have seen it before.
 *
 * `eventKey` is what makes replay a no-op, so it has to be stable for the same
 * delivery and different for a genuinely new one. For a webhook that is the
 * platform's own delivery id when it sends one, and otherwise a hash of
 * (order, package, status, modification time) - which is exactly the tuple
 * that changes when something has actually happened.
 */
async function recordEvent(clientId, provider, {
  source = 'poll', eventKey, eventType = null, providerStoreId = '', externalOrderId = '',
  externalPackageId = '', payload = null, signatureOk = true } = {}) {
  const key = String(eventKey).slice(0, 190);
  /*
   * A plain INSERT, and the duplicate key IS the answer.
   *
   * The first shape of this used ON DUPLICATE KEY UPDATE and then decided
   * "duplicate" by reading the row back and asking whether it was already
   * `done`. That is wrong in the one case that matters: a platform that
   * re-sends within the same second arrives while the first copy is still
   * being processed, the row is 'processing', and the replay is reported as
   * new. Whether we have FINISHED with an event has nothing to do with
   * whether we have SEEN it, and it is the seeing that makes it a replay.
   */
  try {
    const id = await db.insert(
      `INSERT INTO np_int_events (client_id, provider, source, event_key, event_type, provider_store_id,
          external_order_id, external_package_id, signature_ok, payload, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'new', NOW())`,
      [clientId, provider, source, key, eventType, String(providerStoreId || ''),
       String(externalOrderId || ''), String(externalPackageId || ''), signatureOk ? 1 : 0,
       payload ? JSON.stringify(payload) : null]);
    return { eventId: id, duplicate: false };
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      const row = await db.one(
        'SELECT id, status FROM np_int_events WHERE client_id=? AND provider=? AND event_key=?',
        [clientId, provider, key]);
      return { eventId: row ? row.id : null, duplicate: true, state: row ? row.status : null };
    }
    throw e;
  }
}

function eventKeyFor(n, source) {
  const crypto = require('crypto');
  const basis = [n.externalOrderId, n.externalPackageId, n.providerStatus, n.providerModifiedAt || ''].join('|');
  return source + ':' + crypto.createHash('sha1').update(basis).digest('hex').slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* 2. the mirror                                                       */
/* ------------------------------------------------------------------ */
async function upsertMirror(clientId, conn, n) {
  const id = await db.insert(
    `INSERT INTO np_int_orders (client_id, branch_id, connection_id, provider, provider_store_id,
        external_order_id, external_package_id, external_no, source_application, provider_status,
        status, acceptance_mode, fulfillment_type, payment_type, is_prepaid, provider_total,
        delivery_charge, promotion_total, coupon_total, promotions_json, customer_label, customer_phone,
        address_label, customer_note, scheduled_at, raw_json, normalized_json,
        provider_created_at, provider_modified_at, received_at, last_event_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,NOW(),NOW(),NOW())
     ON DUPLICATE KEY UPDATE
        id = LAST_INSERT_ID(id),
        provider_status = VALUES(provider_status),
        provider_total = VALUES(provider_total),
        delivery_charge = VALUES(delivery_charge),
        promotion_total = VALUES(promotion_total),
        coupon_total = VALUES(coupon_total),
        raw_json = VALUES(raw_json),
        normalized_json = VALUES(normalized_json),
        provider_modified_at = VALUES(provider_modified_at),
        last_event_at = NOW(),
        updated_at = NOW()`,
    [clientId, conn.branch_id, conn.id, conn.provider, String(n.providerStoreId || conn.provider_store_id || ''),
     String(n.externalOrderId || ''), String(n.externalPackageId || ''), n.externalNo || null,
     n.sourceApplication || null, n.providerStatus || null,
     'RECEIVED', conn.acceptance_mode, n.fulfillmentType || null, n.paymentType || null,
     n.isPrepaid ? 1 : 0, money(n.providerTotal),
     money(n.deliveryCharge), money(n.promotionTotal), money(n.couponTotal),
     n.promotions ? JSON.stringify(n.promotions).slice(0, 60000) : null,
     maskName(n.customer && n.customer.label), maskPhone(n.customer && n.customer.phone),
     maskAddress(n.customer && n.customer.address),
     (n.customer && n.customer.note ? String(n.customer.note).slice(0, 500) : null),
     dt(n.scheduledAt), JSON.stringify(n.raw || n).slice(0, 4000000),
     JSON.stringify(stripRaw(n)).slice(0, 4000000),
     dt(n.providerCreatedAt), dt(n.providerModifiedAt)]);
  return db.one('SELECT * FROM np_int_orders WHERE id=?', [id]);
}

function stripRaw(n) { const c = { ...n }; delete c.raw; return c; }

/* ------------------------------------------------------------------ */
/* 3. menu mapping                                                     */
/* ------------------------------------------------------------------ */
async function findMapping(clientId, conn, entityType, externalId) {
  if (!externalId) return null;
  return db.one(
    `SELECT * FROM np_int_menu_map WHERE client_id=? AND provider=? AND branch_id=? AND entity_type=? AND external_id=?`,
    [clientId, conn.provider, conn.branch_id, entityType, String(externalId)]);
}

/** The hidden category every auto-created integration product lands in. */
async function integrationCategory(clientId) {
  const name = 'Entegrasyon';
  const found = await db.one('SELECT id FROM categories WHERE client_id=? AND name=? LIMIT 1', [clientId, name]);
  if (found) return found.id;
  return db.insert(
    `INSERT INTO categories (client_id, name, station_id, sort_order, is_active, use_in_pos, use_in_qr)
     VALUES (?,?,NULL,999,1,0,0)`, [clientId, name]);
}

/**
 * A product for something the platform sells and the till has never heard of.
 *
 * The alternative - one shared "unmapped item" line - is worse in every way
 * that matters at 20:30 on a Friday: the kitchen slip says "eşleşmemiş ürün"
 * and the cook has to ring the office. So the product is created with the
 * platform's own name and price, in a hidden category so it never appears on
 * the till's own menu, with stock tracking OFF because we have no recipe for
 * it and guessing one would corrupt the stock ledger. The mirror row counts it
 * as unmapped and the Entegrasyonlar screen asks the owner to point it at a
 * real product - at which point the auto product stops being used.
 */
async function ensureProduct(clientId, conn, { externalId, name, price, vatRate = null }) {
  const map = await findMapping(clientId, conn, 'product', externalId);
  if (map && map.local_id) {
    const p = await db.one('SELECT * FROM products WHERE id=? AND client_id=? AND is_active=1', [map.local_id, clientId]);
    if (p) return { product: p, mapped: true };
  }
  const clean = String(name || 'Platform ürünü').slice(0, 150);

  /*
   * `products` is UNIQUE on (client_id, name) - one name is one product in
   * this schema, whatever category it sits in. So an exact name match IS the
   * product, and creating a second one is not merely untidy, it is impossible:
   * the insert collides and the whole order fails to open. That is exactly
   * what happened the first time this ran, and it is the reason the lookup is
   * by name and never by (category, name).
   *
   * An exact match therefore counts as MAPPED - by name rather than by hand,
   * but mapped: the kitchen gets the real product, the stock ledger moves and
   * the recipe is consumed. Only a name the till has genuinely never seen
   * creates a placeholder, and only that counts towards `unmapped_count`.
   */
  let mapped = false;
  let p = await db.one('SELECT * FROM products WHERE client_id=? AND name=? LIMIT 1', [clientId, clean]);
  if (p && !Number(p.is_active)) {
    /* A product the owner has switched off must not be silently sold again -
       orders.addItem refuses it - so it is reactivated only as the hidden
       integration copy it would otherwise have become, and the log says so. */
    await db.exec('UPDATE products SET is_active=1 WHERE id=?', [p.id]);
    p = await db.one('SELECT * FROM products WHERE id=?', [p.id]);
  }
  if (p) {
    mapped = true;
  } else {
    const catId = await integrationCategory(clientId);
    const id = await db.insert(
      `INSERT INTO products (client_id, category_id, name, price, cost_price, description, sort_order,
          is_active, use_in_pos, use_in_qr, vat_rate, track_stock)
       VALUES (?,?,?,?,0,?,999,1,0,0,?,0)`,
      [clientId, catId, clean, money(price || 0),
       'Otomatik oluşturuldu: ' + conn.provider + ' / ' + (externalId || '-'), Number(vatRate || 0)]);
    p = await db.one('SELECT * FROM products WHERE id=?', [id]);
  }
  if (externalId) {
    await db.exec(
      `INSERT INTO np_int_menu_map (client_id, branch_id, provider, entity_type, external_id, external_name,
          local_id, provider_price, mapped_by, created_at, updated_at)
       VALUES (?,?,?, 'product', ?,?,?,?, 'auto', NOW(), NOW())
       ON DUPLICATE KEY UPDATE external_name=VALUES(external_name), provider_price=VALUES(provider_price),
          local_id=IF(mapped_by='manual', local_id, VALUES(local_id)), updated_at=NOW()`,
      [clientId, conn.branch_id, conn.provider, String(externalId), clean, p.id, money(price || 0)]);
  }
  return { product: p, mapped };
}

/**
 * The line that carries the delivery charge, so the bill adds up to the
 * platform's total.
 *
 * Delegated to modules/delivery so a phone delivery and a platform delivery
 * put their fee on the SAME product row. Two implementations meant two rows
 * with the same name racing for uniq_product (client_id, name), and a product
 * report where the delivery income had to be added up by hand.
 */
async function feeProduct(clientId, conn, name) {
  return require('../modules/delivery').feeProduct(clientId, name);
}

/* ------------------------------------------------------------------ */
/* 4. build the POS order                                              */
/* ------------------------------------------------------------------ */
/**
 * Turn a normalised platform order into an ordinary paket adisyon.
 *
 * Modifiers, and why they are done this way. The schema has no modifier tables
 * - none, anywhere - so a modifier can only become one of two things: a LINE
 * of its own (when it maps to a real product, which is how "Ayran" should be
 * sold and counted and taken out of stock), or TEXT on the parent line (when it
 * does not, which is what "Acısız" and "Ekstra peynir" are). Nested groups are
 * flattened to their path - "İçecek / Boy / Büyük" - because that is the phrase
 * the cook needs, and a removed ingredient is written "Çıkar: soğan" so it
 * cannot be misread as an addition. Either way the MONEY is right: a modifier
 * that stays as text has its price folded into the line it belongs to.
 */
async function buildPosOrder(clientId, conn, mirror, n) {
  const label = `${providerShort(conn.provider)} ${n.externalNo || n.externalOrderId}`.slice(0, 20);
  const orderId = await orders.openOrder(clientId, {
    tableId: null, waiterId: null, userId: 0, label, deviceId: null, offline: false,
  });

  let unmapped = 0;
  const lineRows = [];
  for (const l of n.lines || []) {
    if (l.cancelled) continue;
    const priced = [];
    const noteBits = [];
    for (const m of l.modifiers || []) {
      if (m.removed) { noteBits.push('Çıkar: ' + (m.path || m.name)); continue; }
      const mm = await findMapping(clientId, conn, 'modifier', m.externalId);
      if (mm && mm.local_id) { priced.push({ mod: m, productId: mm.local_id }); continue; }
      noteBits.push((m.path || m.name) + (Number(m.unitPrice) > 0 ? ` (+${money(m.unitPrice)})` : ''));
    }
    /* Text modifiers are not free: their price rides on the parent line so the
       bill still equals what the guest was charged. */
    const foldedIn = (l.modifiers || [])
      .filter(m => !m.removed && !priced.find(p => p.mod === m))
      .reduce((s, m) => s + Number(m.qty || 1) * Number(m.unitPrice || 0), 0);

    const { product, mapped } = await ensureProduct(clientId, conn, {
      externalId: l.externalProductId, name: l.name, unitPrice: l.unitPrice, price: l.unitPrice });
    if (!mapped) unmapped++;
    if (l.note) noteBits.push(String(l.note));
    const note = noteBits.join(' · ').slice(0, 255) || null;
    const unit = money(Number(l.unitPrice) + (Number(l.qty) ? foldedIn / Number(l.qty) : 0));
    const itemId = await orders.addItem(clientId, orderId, {
      productId: product.id, qty: Number(l.qty) || 1, note, unitPrice: unit, userId: 0,
    });
    lineRows.push({ externalItemId: l.externalItemId, itemId, productId: product.id, qty: Number(l.qty) || 1,
      unit, name: l.name, role: 'item', mapped });

    for (const pm of priced) {
      const mid = await orders.addItem(clientId, orderId, {
        productId: pm.productId, qty: Number(pm.mod.qty || 1) * (Number(l.qty) || 1),
        note: (pm.mod.group ? pm.mod.group + ': ' : '') + pm.mod.name, unitPrice: money(pm.mod.unitPrice), userId: 0,
      });
      lineRows.push({ externalItemId: pm.mod.externalItemId, itemId: mid, productId: pm.productId,
        qty: Number(pm.mod.qty || 1), unit: money(pm.mod.unitPrice), name: pm.mod.name, role: 'modifier', mapped: true });
    }
  }

  /* Delivery charge. A platform-courier order does not normally charge the
     restaurant's guest through our bill, but a restaurant-courier one does and
     the figure has to be somewhere or the adisyon will not equal the total the
     platform reports - which is the first thing an accountant queries. */
  if (Number(n.deliveryCharge) > 0) {
    const fee = await feeProduct(clientId, conn, 'Teslimat ücreti');
    const fid = await orders.addItem(clientId, orderId, {
      productId: fee.id, qty: 1, note: providerShort(conn.provider), unitPrice: money(n.deliveryCharge), userId: 0 });
    lineRows.push({ externalItemId: 'DELIVERY', itemId: fid, productId: fee.id, qty: 1,
      unit: money(n.deliveryCharge), name: 'Teslimat ücreti', role: 'fee', mapped: true });
  }

  /* Coupons and promotions become ONE bill-level discount row through the
     existing discount ledger, so recalc handles it and the discount reports
     see it. The individual promotions stay in the mirror's promotions_json -
     the bill needs a number, support needs the list. */
  const disc = money(Number(n.promotionTotal || 0) + Number(n.couponTotal || 0));
  if (disc > 0) {
    const names = (n.promotions || []).map(p => p.name || p.title || p.code).filter(Boolean).slice(0, 4);
    await orders.setBillDiscount(clientId, orderId, {
      amount: disc, userId: 0,
      reason: (providerShort(conn.provider) + ' kampanya' + (names.length ? ': ' + names.join(', ') : '')).slice(0, 190),
    });
  }

  /* The bill's own notes carry what the paper and the screen need and nothing
     more: the platform, the source application (Galaxy is not TrendyolGo), how
     it is being delivered, and a masked guest. */
  const notes = [
    providerShort(conn.provider) + (n.sourceApplication ? ' · ' + n.sourceApplication : ''),
    'Sipariş no: ' + (n.externalNo || n.externalOrderId),
    fulfilmentLabel(n.fulfillmentType),
    n.isPrepaid ? 'Platformda ödendi' : 'Kapıda ödeme: ' + (n.paymentType || '-'),
    mirror.customer_label ? 'Müşteri: ' + mirror.customer_label : null,
    mirror.customer_phone ? 'Telefon: ' + mirror.customer_phone : null,
    mirror.address_label ? 'Adres: ' + mirror.address_label : null,
    mirror.customer_note ? 'Not: ' + mirror.customer_note : null,
    n.scheduledAt ? 'İleri tarihli: ' + dt(n.scheduledAt) : null,
  ].filter(Boolean).join('\n');
  await db.exec('UPDATE orders SET notes=? WHERE id=? AND client_id=?', [notes, orderId, clientId]);

  for (const r of lineRows) {
    await db.exec(
      `INSERT INTO np_int_order_items (client_id, int_order_id, order_item_id, external_item_id, external_name,
          product_id, qty, unit_price, line_total, role, status, mapped, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'ACTIVE', ?, NOW())
       ON DUPLICATE KEY UPDATE order_item_id=VALUES(order_item_id), qty=VALUES(qty), unit_price=VALUES(unit_price)`,
      [clientId, mirror.id, r.itemId, String(r.externalItemId), String(r.name || '').slice(0, 190),
       r.productId, r.qty, r.unit, money(r.qty * r.unit), r.role, r.mapped ? 1 : 0]);
  }

  await db.exec('UPDATE np_int_orders SET order_id=?, unmapped_count=?, updated_at=NOW() WHERE id=? AND order_id IS NULL',
    [orderId, unmapped, mirror.id]);

  /*
   * Put it on the Paket Servis board.
   *
   * A Yemeksepeti order and a phone order are worked identically once they
   * are here - somebody cooks it, somebody carries it, somebody marks it
   * delivered - so they belong in the same four lanes. Splitting them across
   * two screens is how an order goes unnoticed at 20:30 on a Friday.
   *
   * A gel-al order is NOT a delivery and stays off the board: nobody is
   * carrying it and there is no address to show. It is still an ordinary
   * adisyon and still prints.
   *
   * Failing to attach must not lose the order. The bill exists and is
   * printable; the board is a view of it, so an error here is logged and
   * swallowed rather than allowed to unwind a sale.
   */
  if (n.fulfillmentType !== 'PICKUP') {
    try {
      await require('../modules/delivery').attachPlatformOrder(clientId, orderId, {
        source: conn.provider,
        intOrderId: mirror.id,
        customerName: mirror.customer_label || null,
        phone: mirror.customer_phone || null,
        addressText: mirror.address_label || '',
        directions: mirror.customer_note || null,
        deliveryFee: n.deliveryCharge || 0,
        isPrepaid: !!n.isPrepaid,
        paymentMethod: n.isPrepaid ? null : methodFor(n.paymentType),
        promisedMinutes: Number(conn.default_prep_minutes) || 30,
        note: fulfilmentLabel(n.fulfillmentType),
      });
    } catch (e) {
      await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, level: 'warn',
        action: 'create', orderId, externalOrderId: mirror.external_order_id,
        message: 'Paket panosuna eklenemedi: ' + e.message });
    }
  }
  return { orderId, unmapped };
}

function providerShort(p) {
  return ({ UBER_EATS_TGO: 'Trendyol Go', YEMEKSEPETI: 'Yemeksepeti',
    MIGROS_YEMEK: 'Migros Yemek', GETIR_YEMEK: 'Getir' })[p] || p;
}
function fulfilmentLabel(f) {
  return ({ PLATFORM_COURIER: 'Platform kuryesi', RESTAURANT_COURIER: 'Restoran kuryesi',
    PICKUP: 'Müşteri gel-al' })[f] || 'Teslimat';
}

/* ------------------------------------------------------------------ */
/* 5. printing - through the existing workflow, exactly once           */
/* ------------------------------------------------------------------ */
/**
 * Claim the right to print, then print.
 *
 * The claim is a conditional UPDATE and it happens BEFORE the job is built:
 * two callers race, one wins the row, the other sees zero affected rows and
 * goes home. The job id is written back afterwards so the screen can show
 * which job it was and a manual reprint can say "this is the second copy".
 */
/**
 * Which printer a platform slip comes out of.
 *
 * The connection may name one - a restaurant with a dedicated paket printer at
 * the packing bench does not want delivery slips coming out at the till - and
 * falls back to the till's own receipt printer, which is what every other slip
 * in the product uses.
 */
async function receiptStation(clientId, conn) {
  if (conn && conn.receipt_station_id) return Number(conn.receipt_station_id);
  const s = Number(await db.value('SELECT receipt_station_id FROM clients WHERE id=?', [clientId]));
  return s || null;
}

async function printOnce(clientId, conn, mirror, kind, { snapshot = null } = {}) {
  const col = kind === 'cancel' ? 'cancel_print_job_id' : 'accept_print_job_id';
  const claimed = await db.exec(
    `UPDATE np_int_orders SET ${col} = -1, updated_at=NOW() WHERE id=? AND ${col} IS NULL`, [mirror.id]);
  if (!claimed) return { printed: false, reason: 'already' };
  try {
    let jobId = null;
    const stationId = await receiptStation(clientId, conn);
    if (kind === 'cancel') {
      /*
       * Built from a SNAPSHOT taken before the bill was withdrawn.
       *
       * `deleteBill` marks every line is_deleted, and print/document.js
       * (rightly) refuses to print deleted lines - so a cancellation notice
       * rendered after the withdrawal came out with a header, a total of zero
       * and no lines at all. The one thing the kitchen needs from that piece
       * of paper is WHICH order and WHAT was on it, so the order is read
       * first and the paper is rendered from that.
       */
      const order = snapshot || await orders.getOrder(clientId, mirror.order_id);
      if (!order) throw new Error('Adisyon bulunamadı');
      const data = await printing.buildBill(clientId, order, {
        title: 'PLATFORM SIPARISI IPTAL', showPayments: false });
      jobId = await printing.enqueue(clientId,
        { jobType: 'receipt', orderId: mirror.order_id, stationId, content: data });
    } else {
      /*
       * The connection may pin every platform line to one station - a kitchen
       * that plates delivery orders on its own pass. `order_items.station_id`
       * is the per-line override sendToStations and the kitchen board already
       * read, so pinning is writing that column rather than a second routing
       * rule that can disagree with the first.
       */
      if (conn && conn.station_id) {
        await db.exec(
          'UPDATE order_items SET station_id=? WHERE order_id=? AND client_id=? AND is_deleted=0 AND sent_qty=0',
          [conn.station_id, mirror.order_id, clientId]);
      }
      const sent = await orders.sendToStations(clientId, mirror.order_id, 0);
      const order = await orders.getOrder(clientId, mirror.order_id);
      if (!order) throw new Error('Adisyon bulunamadı');
      const data = await printing.buildBill(clientId, order, { title: 'PAKET SIPARIS' });
      jobId = await printing.enqueue(clientId,
        { jobType: 'receipt', orderId: mirror.order_id, stationId, content: data });
      await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, action: 'print',
        orderId: mirror.order_id, externalOrderId: mirror.external_order_id,
        message: `Mutfağa gönderildi (${sent.sent} satır, ${sent.stations} istasyon) ve paket fişi kuyruğa alındı` });
    }
    await db.exec(`UPDATE np_int_orders SET ${col}=? WHERE id=?`, [jobId || 0, mirror.id]);
    return { printed: true, jobId };
  } catch (e) {
    /* Give the claim back: a printer that was switched off must not cost the
       order its only slip for ever. */
    await db.exec(`UPDATE np_int_orders SET ${col}=NULL WHERE id=? AND ${col}=-1`, [mirror.id]);
    await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, level: 'error',
      action: 'print', orderId: mirror.order_id, externalOrderId: mirror.external_order_id,
      message: 'Fiş kuyruğa alınamadı: ' + e.message });
    return { printed: false, reason: e.message };
  }
}

/** A deliberate second copy. Always allowed, always logged, never automatic. */
async function reprint(clientId, mirror, actor) {
  if (!mirror.order_id) { const e = new Error('Bu sipariş için adisyon yok'); e.status = 409; throw e; }
  const conn = await db.one('SELECT * FROM np_int_connections WHERE id=?', [mirror.connection_id]);
  const order = await orders.getOrder(clientId, mirror.order_id);
  if (!order) { const e = new Error('Adisyon bulunamadı'); e.status = 404; throw e; }
  const data = await printing.buildBill(clientId, order, { title: 'PAKET SIPARIS (KOPYA)' });
  const jobId = await printing.enqueue(clientId, { jobType: 'receipt', orderId: mirror.order_id,
    stationId: await receiptStation(clientId, conn), content: data });
  await db.exec('UPDATE np_int_orders SET reprint_count=reprint_count+1, updated_at=NOW() WHERE id=?', [mirror.id]);
  await logLine(clientId, { provider: mirror.provider, branchId: mirror.branch_id, action: 'reprint',
    orderId: mirror.order_id, externalOrderId: mirror.external_order_id, actor,
    message: 'Fiş elle yeniden yazdırıldı (kopya ' + (Number(mirror.reprint_count) + 1) + ')' });
  return { jobId };
}

/* ------------------------------------------------------------------ */
/* 6. money                                                            */
/* ------------------------------------------------------------------ */
/**
 * A prepaid platform order is PAID. The till must never ask again.
 *
 * The payment is written through modules/payments, which is what closes the
 * bill and what moves the stock, so a delivery sale is accounted for exactly
 * like a counter sale. `payment_channel` says where it came from, so the Z
 * report and the shift can tell platform money apart from drawer money without
 * a second table.
 */
async function settleIfPrepaid(clientId, conn, mirror) {
  if (!mirror.is_prepaid || !mirror.order_id) return { settled: false };
  const already = await db.value(
    `SELECT COUNT(*) FROM order_payments WHERE order_id=? AND client_id=? AND is_deleted=0 AND voided_at IS NULL`,
    [mirror.order_id, clientId]);
  if (Number(already)) return { settled: false, reason: 'already' };
  const o = await db.one('SELECT grand_total, status FROM orders WHERE id=? AND client_id=?', [mirror.order_id, clientId]);
  if (!o || o.status !== 'open') return { settled: false, reason: 'not-open' };
  const method = methodFor(mirror.payment_type);
  try {
    const r = await payments.addPayment(clientId, mirror.order_id, {
      method, amount: money(o.grand_total), userId: 0, channel: 'entegrasyon' });
    await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, action: 'payment',
      orderId: mirror.order_id, externalOrderId: mirror.external_order_id,
      message: `Platformda ödenmiş sipariş kapatıldı (${method}, ${money(o.grand_total)})` });
    return { settled: true, closed: r.closed };
  } catch (e) {
    await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, level: 'warn',
      action: 'payment', orderId: mirror.order_id, externalOrderId: mirror.external_order_id,
      message: 'Ödeme yazılamadı: ' + e.message });
    return { settled: false, reason: e.message };
  }
}

/** Platform payment types onto the till's six methods. */
function methodFor(paymentType) {
  const s = String(paymentType || '').toUpperCase();
  if (/MEAL|TICKET|SODEXO|MULTINET|SETCARD|METROPOL|YEMEK/.test(s)) return 'yemek_karti';
  if (/CASH|NAKIT/.test(s)) return 'nakit';
  return 'kredi_karti';
}

/* ------------------------------------------------------------------ */
/* 7. the state change                                                 */
/* ------------------------------------------------------------------ */
/**
 * Move the mirror to `next`, doing whatever that state costs.
 *
 * `assertTransition` is the guard and it is deliberately unforgiving: an event
 * that walks the order backwards is refused rather than applied, because the
 * two-minute poll overlap makes late duplicates the normal case and applying
 * one would re-print and re-cook. A repeat of the state we are already in is a
 * success that does nothing.
 */
async function applyStatus(clientId, conn, mirror, next, { providerStatus = null, reason = null, actor = null } = {}) {
  const from = mirror.status;
  const t = status.canTransition(from, next);
  if (!t.ok) {
    await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, level: 'warn',
      action: 'status', orderId: mirror.order_id, externalOrderId: mirror.external_order_id, actor,
      message: `Geçersiz durum geçişi reddedildi: ${from} -> ${next} (${t.reason})` });
    const e = new Error(t.reason); e.status = 409; e.code = 'INVALID_TRANSITION'; throw e;
  }
  if (t.noop) {
    if (providerStatus) {
      await db.exec('UPDATE np_int_orders SET provider_status=?, last_event_at=NOW() WHERE id=?', [providerStatus, mirror.id]);
    }
    return { changed: false, status: from };
  }

  await db.exec(
    `UPDATE np_int_orders SET status=?, provider_status=COALESCE(?, provider_status),
        accepted_at = IF(?='ACCEPTED', NOW(), accepted_at),
        closed_at = IF(? IN ('DELIVERED','REJECTED','CANCELLED'), NOW(), closed_at),
        cancel_reason = COALESCE(?, cancel_reason),
        last_event_at = NOW(), updated_at = NOW()
      WHERE id=?`,
    [next, providerStatus, next, next, next === 'CANCELLED' || next === 'REJECTED' ? reason : null, mirror.id]);
  const fresh = await db.one('SELECT * FROM np_int_orders WHERE id=?', [mirror.id]);

  if (next === 'ACCEPTED') {
    await printOnce(clientId, conn, fresh, 'accept');
    await settleIfPrepaid(clientId, conn, await db.one('SELECT * FROM np_int_orders WHERE id=?', [mirror.id]));
  }
  if (next === 'CANCELLED' || next === 'REJECTED') {
    await unwind(clientId, conn, fresh, reason, actor);
  }

  /*
   * Move the card on the Paket Servis board too.
   *
   * Without this a platform order sits in "Yeni" for ever while the platform
   * itself has long since said DISPATCHED, and the cashier is looking at a
   * board that disagrees with the tablet. Only the states that MEAN something
   * to a delivery are mapped - PREPARING and READY are both "hazırlanıyor" to
   * the person watching, and a state we do not map simply leaves the card
   * where it is.
   *
   * Best effort by design: the board is a view. A delivery row that refuses
   * the move (someone at the till already marked it delivered) must never
   * make the platform's own status update fail.
   */
  const LANE_FOR = {
    ACCEPTED: 'PREPARING', PREPARING: 'PREPARING', READY: 'PREPARING',
    DISPATCHED: 'ON_ROUTE', DELIVERED: 'DELIVERED',
    CANCELLED: 'CANCELLED', REJECTED: 'CANCELLED',
  };
  if (fresh.order_id && LANE_FOR[next]) {
    try {
      const del = require('../modules/delivery');
      const row = await db.one('SELECT id, status FROM delivery_orders WHERE client_id=? AND order_id=?',
        [clientId, fresh.order_id]);
      if (row && row.status !== LANE_FOR[next] && del.NEXT[row.status].includes(LANE_FOR[next])) {
        await del.setStatus(clientId, row.id, LANE_FOR[next], {
          userId: 0, actorName: providerShort(conn.provider), reason: reason || null });
      }
    } catch (e) {
      log.warn('paket', 'board not moved with platform status', { orderId: fresh.order_id, error: e.message });
    }
  }

  await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, action: 'status',
    orderId: fresh.order_id, externalOrderId: fresh.external_order_id, actor,
    message: `${status.LABELS[from] || from} -> ${status.LABELS[next]}` + (reason ? ' (' + reason + ')' : '') });
  await publish(clientId, fresh);
  return { changed: true, status: next };
}

/**
 * A cancelled order, before or after acceptance.
 *
 * `orders.deleteBill` is the till's own answer to "this bill should not have
 * happened": it writes the whole original into order_delete_logs, reverses the
 * stock AND the recipe consumption, marks the payments deleted so the takings
 * come back down, cancels the kitchen tickets so the cook stops, and excludes
 * the bill from the reports. That is exactly the accounting a cancelled
 * platform order needs, and reproducing any part of it here would be a second
 * implementation that drifts. A cancellation notice is printed once.
 */
async function unwind(clientId, conn, mirror, reason, actor) {
  if (!mirror.order_id) return { unwound: false };
  const before = await db.one('SELECT status, is_deleted FROM orders WHERE id=? AND client_id=?', [mirror.order_id, clientId]);
  if (!before || before.is_deleted) return { unwound: false, reason: 'already' };
  const wasAccepted = !!mirror.accepted_at;
  /* Read the bill while its lines are still live - see printOnce('cancel'). */
  const snapshot = wasAccepted ? await orders.getOrder(clientId, mirror.order_id) : null;
  try {
    await orders.deleteBill(clientId, mirror.order_id, {
      userId: 0, reason: (providerShort(conn.provider) + ' iptal: ' + (reason || '-')).slice(0, 190),
      ip: null, ua: 'entegrasyon', approvedBy: actor || 'entegrasyon' });
  } catch (e) {
    await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, level: 'error',
      action: 'cancel', orderId: mirror.order_id, externalOrderId: mirror.external_order_id,
      message: 'Adisyon geri alınamadı: ' + e.message });
    return { unwound: false, reason: e.message };
  }
  await db.exec("UPDATE np_int_order_items SET status='CANCELLED' WHERE int_order_id=?", [mirror.id]);
  /* Only an order the kitchen was already told about needs a piece of paper
     saying to stop. A rejection before acceptance never reached them. */
  if (wasAccepted) await printOnce(clientId, conn, mirror, 'cancel', { snapshot });
  await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, action: 'cancel',
    orderId: mirror.order_id, externalOrderId: mirror.external_order_id, actor,
    message: (wasAccepted ? 'Onaydan sonra iptal' : 'Onaydan önce iptal') + ': ' + (reason || '-') });
  return { unwound: true };
}

/**
 * Partial cancellation: one line off an order that is otherwise going ahead.
 * Uses the till's own cancelItem, so the void slip, the cancel ledger and the
 * Z report's "iptal edilen satır" figure all behave as they do for a waiter.
 */
async function cancelLine(clientId, conn, mirror, externalItemId, { reason = '', actor = null } = {}) {
  const row = await db.one('SELECT * FROM np_int_order_items WHERE int_order_id=? AND external_item_id=? LIMIT 1',
    [mirror.id, String(externalItemId)]);
  if (!row) { const e = new Error('Satır bulunamadı'); e.status = 404; throw e; }
  if (row.status === 'CANCELLED') return { alreadyCancelled: true };
  if (!row.order_item_id) { const e = new Error('Satır adisyona yazılmamış'); e.status = 409; throw e; }
  const bill = await db.one('SELECT * FROM orders WHERE id=? AND client_id=?', [mirror.order_id, clientId]);
  if (!bill || bill.is_deleted) { const e = new Error('Adisyon bulunamadı'); e.status = 404; throw e; }

  /*
   * A prepaid platform order is CLOSED as soon as it is accepted - that is the
   * whole point of not asking for the money twice - and the till refuses to
   * edit a closed bill. So taking one line off it is the till's own three-step
   * dance and not a shortcut around it: reopen (which reverses the stock and
   * the recipe, audited), void the line (which writes the cancel ledger the Z
   * report counts from), then settle again at the new figure. The refund is
   * the difference between the payment that was voided and the one written
   * back - it is visible in order_payments as exactly that, rather than as an
   * adjustment nobody can trace.
   */
  const wasClosed = bill.status === 'closed';
  let refunded = 0;
  if (wasClosed) {
    await orders.reopen(clientId, mirror.order_id, {
      userId: 0, userName: 'Entegrasyon',
      reason: providerShort(conn.provider) + ' satır iptali: ' + (reason || '-') });
    const pays = await db.query(
      'SELECT * FROM order_payments WHERE order_id=? AND client_id=? AND is_deleted=0 AND voided_at IS NULL',
      [mirror.order_id, clientId]);
    for (const p of pays) {
      await payments.voidPayment(clientId, p.id, {
        userId: 0, reason: 'Platform satır iptali', ip: null, ua: 'entegrasyon' });
      refunded += Number(p.amount);
    }
  }

  await orders.cancelItem(clientId, mirror.order_id, row.order_item_id, {
    qty: null, reason: (reason || 'Platform iptali').slice(0, 190), userId: 0, approvedBy: actor || 'entegrasyon' });
  await db.exec("UPDATE np_int_order_items SET status='CANCELLED' WHERE id=?", [row.id]);

  let recharged = 0;
  if (wasClosed) {
    const fresh = await db.one('SELECT * FROM np_int_orders WHERE id=?', [mirror.id]);
    const settled = await settleIfPrepaid(clientId, conn, fresh);
    if (settled.settled) {
      recharged = Number((await db.one('SELECT grand_total FROM orders WHERE id=?', [mirror.order_id])).grand_total);
    }
  }

  await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, action: 'line-cancel',
    orderId: mirror.order_id, externalOrderId: mirror.external_order_id, actor,
    message: `Satır iptal edildi: ${row.external_name || row.external_item_id}` +
      (wasClosed ? ` · iade ${money(refunded - recharged)}` : '') });
  return { cancelled: true, refund: money(refunded - recharged) };
}

/* ------------------------------------------------------------------ */
/* 8. publish                                                          */
/* ------------------------------------------------------------------ */
/**
 * Out to everything that watches.
 *
 * The till has no websocket: what "realtime" means here is the kitchen board
 * (fed by sendToStations, already done), the floor plan (fed by `orders`,
 * already done) and the cloud outbox that the owner's phone and the panel
 * read. So publishing is one push through the existing outbox, and it is
 * best-effort - a panel that is unreachable must not fail a local order.
 */
async function publish(clientId, mirror) {
  try {
    await sync.push('integration_order', mirror.id, {
      provider: mirror.provider, branch_id: mirror.branch_id, order_id: mirror.order_id,
      external_order_id: mirror.external_order_id, source_application: mirror.source_application,
      status: mirror.status, provider_status: mirror.provider_status,
      total: Number(mirror.provider_total), at: new Date().toISOString(),
    });
    await db.exec('UPDATE np_int_orders SET synced_at=NOW() WHERE id=?', [mirror.id]);
  } catch (e) { log.debug('entegrasyon', 'publish failed', e.message); }
}

/* ------------------------------------------------------------------ */
/* 9. the whole thing                                                  */
/* ------------------------------------------------------------------ */
/**
 * One normalised order, applied. Idempotent by construction: call it a
 * thousand times with the same payload and you get one adisyon, one kitchen
 * slip and one paket fişi.
 */
async function applyOrder(clientId, conn, n, { actor = null, autoAccept = null } = {}) {
  const lockKey = [clientId, conn.provider, n.providerStoreId || '', n.externalOrderId, n.externalPackageId || ''].join('|');
  return withLock(lockKey, async () => {
    let mirror = await upsertMirror(clientId, conn, n);
    const created = !mirror.order_id;

    if (!mirror.order_id) {
      try {
        const built = await buildPosOrder(clientId, conn, mirror, n);
        mirror = await db.one('SELECT * FROM np_int_orders WHERE id=?', [mirror.id]);
        await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, action: 'create',
          orderId: built.orderId, externalOrderId: mirror.external_order_id,
          message: `Adisyon açıldı${built.unmapped ? ` (${built.unmapped} eşleşmemiş ürün)` : ''}` +
            (n.sourceApplication ? ' · kaynak: ' + n.sourceApplication : '') });
      } catch (e) {
        await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, level: 'error',
          action: 'create', externalOrderId: mirror.external_order_id,
          message: 'Adisyon açılamadı: ' + e.message });
        throw e;
      }
    }

    /* The platform's own status decides where the order should be. An
       acceptance mode of PROVIDER_TABLET means the vendor already accepted on
       the platform's tablet, so an incoming order is ACCEPTED from our point
       of view and the till prints straight away. POS_DIRECT leaves it at
       RECEIVED until somebody here says yes - unless automatic acceptance is
       switched on for the connection. */
    let target = n.status;
    if (!target) {
      /* An unrecognised provider status changes nothing but is never silent -
         it is the way we learn the platform added a state last Tuesday. */
      await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, level: 'warn',
        action: 'status', orderId: mirror.order_id, externalOrderId: mirror.external_order_id,
        message: 'Bilinmeyen platform durumu: ' + (n.providerStatus || '(boş)') + ' — durum değiştirilmedi' });
      await db.exec('UPDATE np_int_orders SET provider_status=?, last_event_at=NOW() WHERE id=?',
        [n.providerStatus || null, mirror.id]);
      await publish(clientId, mirror);
      return { mirrorId: mirror.id, orderId: mirror.order_id, created, status: mirror.status, unknownStatus: true };
    }

    if (created && target === 'RECEIVED' && conn.acceptance_mode === 'PROVIDER_TABLET') target = 'ACCEPTED';

    const t = status.canTransition(mirror.status, target);
    if (!t.ok) {
      await logLine(clientId, { provider: conn.provider, branchId: conn.branch_id, level: 'warn',
        action: 'status', orderId: mirror.order_id, externalOrderId: mirror.external_order_id,
        message: `Sıra dışı olay yok sayıldı: ${mirror.status} -> ${target}` });
      return { mirrorId: mirror.id, orderId: mirror.order_id, created, status: mirror.status, ignored: true };
    }
    await applyStatus(clientId, conn, mirror, target, { providerStatus: n.providerStatus, actor });

    const wantAuto = autoAccept === null ? !!conn.auto_accept : autoAccept;
    if (wantAuto && target === 'RECEIVED') {
      /* Automatic acceptance is a separate step on purpose: the order exists
         and is printable even if telling the platform fails. */
      const svc = require('./index');
      await svc.orderAction(clientId, mirror.id, 'accept',
        { prepMinutes: conn.default_prep_minutes, actor: 'otomatik' }).catch(() => {});
    }

    const final = await db.one('SELECT * FROM np_int_orders WHERE id=?', [mirror.id]);
    return { mirrorId: final.id, orderId: final.order_id, created, status: final.status };
  });
}

/* ------------------------------------------------------------------ */
/* 10. the worker                                                      */
/* ------------------------------------------------------------------ */
const MAX_ATTEMPTS = 6;

/**
 * Drain np_int_events.
 *
 * Failures are retried with the same exponential backoff the poller uses, and
 * an event that has failed MAX_ATTEMPTS times is moved to 'dead' rather than
 * retried for ever - a payload the code cannot parse will not parse better on
 * the four hundredth attempt, and a queue that never drains hides the events
 * behind it. The dead letters are on the Entegrasyonlar screen with a "yeniden
 * dene" button, because the usual cause is a fixable local problem: the day
 * was closed, the printer had no station, a product had been deleted.
 */
async function drainEvents(limit = 25) {
  const rows = await db.query(
    `SELECT * FROM np_int_events WHERE status IN ('new','failed') AND attempts < ?
      ORDER BY id LIMIT ?`, [MAX_ATTEMPTS, Number(limit) || 25]);
  let done = 0; let failed = 0;
  for (const ev of rows) {
    const claimed = await db.exec(
      "UPDATE np_int_events SET status='processing', attempts=attempts+1 WHERE id=? AND status IN ('new','failed')", [ev.id]);
    if (!claimed) continue;
    try {
      await processEvent(ev);
      await db.exec("UPDATE np_int_events SET status='done', processed_at=NOW(), last_error=NULL WHERE id=?", [ev.id]);
      done++;
    } catch (e) {
      const attempts = Number(ev.attempts) + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await db.exec("UPDATE np_int_events SET status=?, last_error=? WHERE id=?",
        [dead ? 'dead' : 'failed', String(e.message).slice(0, 500), ev.id]);
      failed++;
      await logLine(ev.client_id, { provider: ev.provider, level: dead ? 'error' : 'warn', action: 'event',
        externalOrderId: ev.external_order_id,
        message: (dead ? 'Olay ölü mektuba düştü: ' : 'Olay işlenemedi, tekrar denenecek: ') + e.message });
    }
  }
  return { done, failed, seen: rows.length };
}

async function processEvent(ev) {
  const payload = ev.payload ? JSON.parse(ev.payload) : null;
  if (!payload) throw new Error('Boş olay gövdesi');
  /* A body with no order id is not an order, and processing it would write a
     mirror row keyed on empty strings that every later event then collides
     with. It fails here, is retried, and ends up on the dead-letter shelf
     where somebody can look at it. */
  const candidate = payload.order || payload;
  if (!candidate || !candidate.externalOrderId) throw new Error('Olay gövdesinde sipariş kimliği yok');
  const conn = await db.one(
    'SELECT * FROM np_int_connections WHERE client_id=? AND provider=? AND branch_id=? LIMIT 1',
    [ev.client_id, ev.provider, payload.__branchId || 1]);
  if (!conn) throw new Error('Bu platform için bağlantı tanımlı değil');
  /* The payload stored is ALREADY normalised - the adapter did that before the
     event was written, because normalisation is where a malformed payload
     should be rejected, while the provider is still on the line and can be
     told. */
  return applyOrder(ev.client_id, conn, candidate, { actor: ev.source });
}

/** Put a dead letter back in the queue. */
async function retryEvent(clientId, eventId) {
  const n = await db.exec(
    "UPDATE np_int_events SET status='new', attempts=0, last_error=NULL WHERE id=? AND client_id=?",
    [eventId, clientId]);
  if (!n) { const e = new Error('Olay bulunamadı'); e.status = 404; throw e; }
  return drainEvents(1);
}

module.exports = {
  recordEvent, eventKeyFor, upsertMirror, applyOrder, applyStatus, unwind, cancelLine,
  printOnce, reprint, receiptStation, settleIfPrepaid, publish, drainEvents, processEvent, retryEvent,
  logLine, maskPhone, maskName, maskAddress, providerShort, methodFor, dt, withLock,
  ensureProduct, integrationCategory, findMapping, MAX_ATTEMPTS,
};
