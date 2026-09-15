'use strict';
/**
 * PAKET SERVİS - the restaurant's own delivery.
 *
 * A delivery is an ORDINARY adisyon. It is opened through modules/orders, it
 * is priced by recalc, it prints through print/index.js, its stock moves in
 * closeIfPaid, and it is in the Z report because it is in `orders`. This
 * module owns only the half a table order has no use for: where it goes, who
 * is carrying it, and how much of the restaurant's money is in that person's
 * pocket right now.
 *
 * ------------------------------------------------------------------
 * THE MONEY, BECAUSE THIS IS THE PART THAT IS EASY TO GET WRONG.
 *
 * There is exactly ONE money ledger and this module does not add a second.
 * When a delivery is marked teslim edildi the payment is written against the
 * BILL, through payments.addPayment, exactly as if the guest had paid at the
 * counter - so the shift, the Z report and the day close all see it once and
 * see it immediately.
 *
 * What the courier settlement tracks is CUSTODY, not revenue: the cash exists
 * and is already counted, it is simply in a jacket on a motorcycle rather than
 * in the drawer. `cash_expected_minor` is therefore RECOMPUTED from the bills
 * at settlement time and never accumulated, and "Kasaya teslim al" writes no
 * payment row. Getting this backwards - treating the hand-over as income -
 * would double every cash delivery in the day's takings, and nobody would
 * notice until the accountant did.
 * ------------------------------------------------------------------
 */
const db = require('../db');
const bd = require('../util/businessDay');
const orders = require('./orders');
const payments = require('./payments');
const printing = require('../print');
const log = require('../logger');
const { money } = require('../util/http');

/*
 * The lanes, and the only moves allowed between them.
 *
 * Declared rather than checked ad hoc at each call site, because the screen,
 * the API and the waiter app all ask the same question and must not answer it
 * differently. CANCELLED is reachable from anywhere that is not already
 * finished; DELIVERED is the end.
 */
const STATUSES = ['NEW', 'PREPARING', 'ON_ROUTE', 'DELIVERED', 'CANCELLED'];
const NEXT = {
  NEW:       ['PREPARING', 'CANCELLED'],
  PREPARING: ['ON_ROUTE', 'NEW', 'CANCELLED'],
  ON_ROUTE:  ['DELIVERED', 'PREPARING', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};
/*
 * Why a delivery was cancelled, as a CODE and not only free text.
 *
 * Free text cannot be counted, and "the kitchen is throwing away four orders
 * a night" is exactly the sentence a report has to be able to produce. The
 * text box stays for the detail; this is what the totals group by.
 */
const CANCEL_CODES = ['MUSTERI_VAZGECTI', 'ADRES_BULUNAMADI', 'ODEME_YOK',
                      'MUTFAK', 'KURYE_YOK', 'SAHTE', 'DIGER'];
const CANCEL_LABEL = {
  MUSTERI_VAZGECTI: 'Müşteri vazgeçti',
  ADRES_BULUNAMADI: 'Adres bulunamadı',
  ODEME_YOK: 'Müşteri ödemedi',
  MUTFAK: 'Mutfak yetiştiremedi',
  KURYE_YOK: 'Kurye yok',
  SAHTE: 'Sahte sipariş',
  DIGER: 'Diğer',
};
const LANE_LABEL = {
  NEW: 'Yeni', PREPARING: 'Hazırlanıyor', ON_ROUTE: 'Yolda',
  DELIVERED: 'Teslim edildi', CANCELLED: 'İptal',
};

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/* ==================================================================== */
/* bölgeler                                                             */
/* ==================================================================== */

/**
 * The default zone, created on demand.
 *
 * This is the guarantee the migration deliberately does not try to be. On a
 * new machine the migrations run before setup has created a tenant, so there
 * is no client_id to seed; here there always is one, because somebody is
 * taking an order. A restaurant that wants a single flat fee never opens the
 * Bölgeler tab at all - it edits this one row's fee and is done.
 */
async function ensureDefaultZone(clientId) {
  const z = await db.one(
    'SELECT * FROM delivery_zones WHERE client_id=? AND is_default=1 AND is_active=1 LIMIT 1', [clientId]);
  if (z) return z;
  const id = await db.insert(
    `INSERT INTO delivery_zones (client_id, name, fee, min_order, est_minutes, is_default, sort_order, is_active)
     VALUES (?,?,0,0,30,1,0,1)`, [clientId, 'Standart bölge']);
  return db.one('SELECT * FROM delivery_zones WHERE id=?', [id]);
}

async function zones(clientId, { includeInactive = false } = {}) {
  await ensureDefaultZone(clientId);
  return db.query(
    `SELECT * FROM delivery_zones WHERE client_id=? ${includeInactive ? '' : 'AND is_active=1'}
      ORDER BY is_default DESC, sort_order, name`, [clientId]);
}

async function saveZone(clientId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw bad('Bölge adı gerekli');
  const fee = money(data.fee);
  const min = money(data.min_order);
  const kfee = money(data.courier_fee);
  const est = Math.max(1, Math.min(240, Number(data.est_minutes) || 30));
  if (fee < 0 || min < 0 || kfee < 0) throw bad('Ücret eksi olamaz');

  return db.tx(async t => {
    /* At most one default, and always at least one. Flipping a zone to
       default demotes the previous one in the same transaction, so there is
       no moment where an address has nowhere to fall back to. */
    if (data.is_default) {
      await t.exec('UPDATE delivery_zones SET is_default=0 WHERE client_id=?', [clientId]);
    }
    if (data.id) {
      const cur = await t.one('SELECT * FROM delivery_zones WHERE id=? AND client_id=?', [data.id, clientId]);
      if (!cur) throw bad('Bölge bulunamadı', 404);
      if (cur.is_default && data.is_active === false) throw bad('Varsayılan bölge kapatılamaz', 409);
      await t.exec(
        `UPDATE delivery_zones SET name=?, fee=?, min_order=?, courier_fee=?, est_minutes=?, is_default=?,
            sort_order=?, is_active=?, updated_at=NOW() WHERE id=? AND client_id=?`,
        [name, fee, min, kfee, est, data.is_default ? 1 : (cur.is_default && !data.is_default ? 0 : cur.is_default),
         Number(data.sort_order) || 0, data.is_active === false ? 0 : 1, data.id, clientId]);
      return data.id;
    }
    return t.insert(
      `INSERT INTO delivery_zones (client_id, name, fee, min_order, courier_fee, est_minutes,
          is_default, sort_order, is_active)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      [clientId, name, fee, min, kfee, est, data.is_default ? 1 : 0, Number(data.sort_order) || 0]);
  });
}

async function deleteZone(clientId, id) {
  const z = await db.one('SELECT * FROM delivery_zones WHERE id=? AND client_id=?', [id, clientId]);
  if (!z) throw bad('Bölge bulunamadı', 404);
  if (z.is_default) throw bad('Varsayılan bölge silinemez. Önce başka bir bölgeyi varsayılan yapın.', 409);
  /* Soft, because past orders name the zone and a delete would orphan them. */
  await db.exec('UPDATE delivery_zones SET is_active=0, updated_at=NOW() WHERE id=? AND client_id=?', [id, clientId]);
  await db.exec('UPDATE customer_addresses SET zone_id=NULL WHERE client_id=? AND zone_id=?', [clientId, id]);
  return true;
}

/* ==================================================================== */
/* müşteri ve adres                                                     */
/* ==================================================================== */

/** Digits only, so "0532 118 44 09" and "05321184409" are the same person. */
function digits(v) { return String(v || '').replace(/\D+/g, ''); }

/**
 * Who is on the phone.
 *
 * Matched on the digits rather than the text, because a number is typed a
 * different way every time and a customer with four spellings has four
 * addresses in four places. Customers are global across tenants (the loyalty
 * app owns that table), so the lookup is by phone and the ADDRESSES are what
 * is scoped to this restaurant.
 */
async function lookup(clientId, phone) {
  const d = digits(phone);
  if (d.length < 7) throw bad('Telefon numarası eksik');
  /*
   * OUR customer first, then anyone's.
   *
   * `customers` is global across tenants - the loyalty app owns it and one
   * person carries one QR into any restaurant - so a number can legitimately
   * match a row another restaurant created. Taking the lowest id would hand
   * the cashier a stranger's name for a regular of theirs, so this prefers
   * the row this restaurant made and only then falls back.
   */
  const c = await db.one(
    `SELECT id, first_name, last_name, phone, email FROM customers
      WHERE REPLACE(REPLACE(REPLACE(COALESCE(phone,''),' ',''),'-',''),'(','') LIKE ?
      ORDER BY (created_by_client_id = ?) DESC, id LIMIT 1`, ['%' + d.slice(-10) + '%', clientId]);
  if (!c) return { customer: null, addresses: [], stats: null };

  const [addresses, stats, flag, recent] = await Promise.all([
    addressList(clientId, c.id),
    db.one(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(grand_total),0) AS total, MAX(business_date) AS last_date
         FROM orders WHERE client_id=? AND customer_id=? AND is_deleted=0 AND status='closed'`,
      [clientId, c.id]),
    flagOf(clientId, c.id),
    /*
     * The last five orders, WITH what was in them.
     *
     * "The usual" is how a regular orders on the phone, and a cashier cannot
     * answer it from a list of dates and totals. The item text is built in
     * SQL rather than by five more round trips, because this runs while
     * somebody is holding a handset.
     */
    db.query(
      `SELECT o.id, o.business_date, o.grand_total,
              /* "2x Adana", not "2.00x Adana". An IF() with a decimal in one
                 branch coerces the other to decimal too, so the trailing
                 zeros are trimmed from the text instead. */
              (SELECT GROUP_CONCAT(CONCAT(
                        TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM oi.qty)), 'x ', p.name)
                      ORDER BY oi.id SEPARATOR ', ')
                 FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
                WHERE oi.order_id = o.id AND oi.is_deleted = 0) AS items
         FROM orders o
        WHERE o.client_id=? AND o.customer_id=? AND o.is_deleted=0 AND o.status='closed'
        ORDER BY o.id DESC LIMIT 5`, [clientId, c.id]),
  ]);
  return {
    customer: c,
    addresses,
    flag: flag ? { level: flag.level, reason: flag.reason, by: flag.by_name || null,
                   at: flag.created_at } : null,
    recent: recent.map(r => ({
      order_id: r.id, date: r.business_date, total: money(r.grand_total),
      items: r.items || '',
    })),
    stats: {
      orders: Number(stats?.orders || 0),
      total: money(stats?.total),
      avg: Number(stats?.orders) ? money(Number(stats.total) / Number(stats.orders)) : 0,
      last_date: stats?.last_date || null,
    },
  };
}

async function addressList(clientId, customerId) {
  return db.query(
    `SELECT a.*, z.name AS zone_name, z.fee AS zone_fee, z.est_minutes
       FROM customer_addresses a
       LEFT JOIN delivery_zones z ON z.id = a.zone_id AND z.client_id = a.client_id
      WHERE a.client_id=? AND a.customer_id=? AND a.is_active=1
      ORDER BY a.is_default DESC, a.id`, [clientId, customerId]);
}

async function saveAddress(clientId, data) {
  const customerId = Number(data.customer_id);
  if (!customerId) throw bad('Müşteri seçilmedi');
  const text = String(data.address_text || '').trim();
  if (text.length < 8) throw bad('Adres çok kısa');
  const tag = String(data.tag || 'EV').trim().slice(0, 16).toUpperCase() || 'EV';

  return db.tx(async t => {
    if (data.is_default) {
      await t.exec('UPDATE customer_addresses SET is_default=0 WHERE client_id=? AND customer_id=?',
        [clientId, customerId]);
    }
    const params = [tag, data.zone_id || null, data.district || null, text.slice(0, 400),
      (data.directions || '').slice(0, 255) || null, data.lat || null, data.lng || null,
      data.is_default ? 1 : 0];
    if (data.id) {
      await t.exec(
        `UPDATE customer_addresses SET tag=?, zone_id=?, district=?, address_text=?, directions=?,
            lat=?, lng=?, is_default=?, updated_at=NOW() WHERE id=? AND client_id=?`,
        [...params, data.id, clientId]);
      return data.id;
    }
    /* The first address a customer has is their default whatever the caller
       said, so "kayıtlı adresler" is never a list with nothing preselected. */
    const has = await t.value(
      'SELECT COUNT(*) FROM customer_addresses WHERE client_id=? AND customer_id=? AND is_active=1',
      [clientId, customerId]);
    const isDef = data.is_default || Number(has) === 0 ? 1 : 0;
    return t.insert(
      `INSERT INTO customer_addresses (client_id, customer_id, tag, zone_id, district, address_text,
          directions, lat, lng, is_default, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
      [clientId, customerId, tag, data.zone_id || null, data.district || null, text.slice(0, 400),
       (data.directions || '').slice(0, 255) || null, data.lat || null, data.lng || null, isDef]);
  });
}

async function deleteAddress(clientId, id) {
  await db.exec('UPDATE customer_addresses SET is_active=0, updated_at=NOW() WHERE id=? AND client_id=?',
    [id, clientId]);
  return true;
}

/** Free-text address search, for "who was that in Bahçelievler". */
async function searchAddresses(clientId, q, limit = 40) {
  const like = '%' + String(q || '').trim() + '%';
  return db.query(
    `SELECT a.id, a.address_text, a.directions, a.tag, a.district,
            c.id AS customer_id, c.first_name, c.last_name, c.phone, z.name AS zone_name
       FROM customer_addresses a
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN delivery_zones z ON z.id = a.zone_id AND z.client_id = a.client_id
      WHERE a.client_id=? AND a.is_active=1
        AND (a.address_text LIKE ? OR a.district LIKE ? OR c.phone LIKE ?
             OR CONCAT(COALESCE(c.first_name,''),' ',COALESCE(c.last_name,'')) LIKE ?)
      ORDER BY a.id DESC LIMIT ?`,
    [clientId, like, like, like, like, Number(limit)]);
}

/* ==================================================================== */
/* kara liste                                                           */
/* ==================================================================== */

/**
 * A flag on a customer, scoped to THIS restaurant.
 *
 * `customers` is shared across tenants - the loyalty app owns it and one
 * person carries one QR into any restaurant - so a flag must never be global.
 * One restaurant's experience of a guest is not another restaurant's
 * judgement to inherit, and a shared blacklist would be both wrong and, with
 * one person's name on it across strangers' tills, indefensible.
 *
 * Two levels, because "never serve this number again" and "be careful" are
 * different instructions:
 *   watch  the cashier is told, and carries on.
 *   block  the order is refused unless somebody deliberately overrides it.
 *
 * Cleared flags are KEPT. A customer blocked twice and forgiven twice is a
 * thing worth seeing; only one flag can be in force at a time, which the
 * unique index over the generated column enforces.
 */
const FLAG_LEVELS = ['watch', 'block'];

async function flagCustomer(clientId, customerId, { level = 'watch', reason = '', userId = 0 } = {}) {
  if (!FLAG_LEVELS.includes(level)) throw bad('Geçersiz işaret');
  const why = String(reason || '').trim();
  if (why.length < 3) throw bad('Sebep yazın - ileride bu satırı okuyacak kişi siz olmayabilirsiniz');
  const c = await db.one('SELECT id FROM customers WHERE id=?', [customerId]);
  if (!c) throw bad('Müşteri bulunamadı', 404);
  await db.tx(async t => {
    await t.exec(
      'UPDATE customer_flags SET cleared_at=NOW(), cleared_by=? WHERE client_id=? AND customer_id=? AND cleared_at IS NULL',
      [userId, clientId, customerId]);
    await t.exec(
      'INSERT INTO customer_flags (client_id, customer_id, level, reason, created_by) VALUES (?,?,?,?,?)',
      [clientId, customerId, level, why.slice(0, 255), userId]);
  });
  log.info('paket', 'customer flagged', { clientId, customerId, level });
  return { ok: true, level };
}

async function clearFlag(clientId, customerId, userId = 0) {
  await db.exec(
    'UPDATE customer_flags SET cleared_at=NOW(), cleared_by=? WHERE client_id=? AND customer_id=? AND cleared_at IS NULL',
    [userId, clientId, customerId]);
  return { ok: true };
}

async function flagOf(clientId, customerId) {
  if (!customerId) return null;
  return db.one(
    `SELECT f.*, u.display_name AS by_name FROM customer_flags f
       LEFT JOIN users u ON u.id=f.created_by AND u.client_id=f.client_id
      WHERE f.client_id=? AND f.customer_id=? AND f.cleared_at IS NULL LIMIT 1`,
    [clientId, customerId]);
}

async function flagHistory(clientId, customerId) {
  return db.query(
    `SELECT f.*, u.display_name AS by_name FROM customer_flags f
       LEFT JOIN users u ON u.id=f.created_by AND u.client_id=f.client_id
      WHERE f.client_id=? AND f.customer_id=? ORDER BY f.id DESC LIMIT 20`,
    [clientId, customerId]);
}

/* ==================================================================== */
/* teslimat ücreti                                                      */
/* ==================================================================== */

/**
 * The product the delivery charge is sold as.
 *
 * Found by NAME, and the same row the platform ingest uses, so a phone
 * delivery and a Yemeksepeti delivery put their fee on the same line in the
 * product report instead of on two lines that have to be added together by
 * hand. Hidden from the till's own menu and from the QR menu, and with stock
 * tracking off - it is a charge, not a thing on a shelf.
 */
const FEE_PRODUCT_NAME = 'Teslimat ücreti';
async function feeProduct(clientId, name = FEE_PRODUCT_NAME) {
  const clean = String(name).slice(0, 150);
  let p = await db.one('SELECT * FROM products WHERE client_id=? AND name=? LIMIT 1', [clientId, clean]);
  if (p) return p;
  /* Its own hidden category. It used to be created inside "Entegrasyon",
     which was true when only a platform order could carry a delivery charge
     and became a lie the moment a restaurant took a phone order. Looked up by
     PRODUCT name either way, so an install that already has the row keeps
     using it wherever it sits. */
  let catId = await db.value('SELECT id FROM categories WHERE client_id=? AND name=? LIMIT 1',
    [clientId, 'Paket servis']);
  if (!catId) {
    catId = await db.insert(
      `INSERT INTO categories (client_id, name, station_id, sort_order, is_active, use_in_pos, use_in_qr)
       VALUES (?,?,NULL,999,1,0,0)`, [clientId, 'Paket servis']);
  }
  const id = await db.insert(
    `INSERT INTO products (client_id, category_id, name, price, cost_price, description, sort_order,
        is_active, use_in_pos, use_in_qr, vat_rate, track_stock)
     VALUES (?,?,?,0,0,?,998,1,0,0,0,0)`,
    [clientId, catId, clean, 'Paket servis hizmet kalemi']);
  return db.one('SELECT * FROM products WHERE id=?', [id]);
}

/* ==================================================================== */
/* sipariş açma                                                         */
/* ==================================================================== */

/**
 * A phone or counter delivery.
 *
 * The adisyon is opened by modules/orders like any other, with no table -
 * `table_id` has been nullable since 2026-09-03-orders-nullable.sql and a
 * delivery is the reason. The companion row is written in the SAME
 * transaction as nothing else: openOrder has its own, and if the insert below
 * failed we would have a bill on no board and no way to find it, so the
 * delivery row is written immediately after and its unique key on
 * (client_id, order_id) is what stops a double tap producing two.
 */
async function createOrder(clientId, opts = {}) {
  const {
    customerId = null, addressId = null, userId = 0, note = null,
    source = 'PHONE', paymentMethod = null, promisedMinutes = null,
    scheduledAt = null, changeForMinor = 0, repeatFromOrderId = null, force = false,
  } = opts;

  /*
   * The blacklist, checked before anything is written.
   *
   * `watch` is information and does not stop anyone. `block` refuses unless
   * the caller passes `force`, which the screen only sends after showing the
   * reason and who wrote it - so somebody made a decision rather than clicked
   * past a dialog.
   */
  const flag = await flagOf(clientId, customerId);
  if (flag && flag.level === 'block' && !force) {
    const e = new Error('Bu müşteri engellenmiş: ' + flag.reason);
    e.status = 409; e.code = 'CUSTOMER_BLOCKED'; e.flag = { level: flag.level, reason: flag.reason };
    throw e;
  }

  let addr = null;
  if (addressId) {
    addr = await db.one(
      `SELECT a.*, z.id AS zid, z.name AS zone_name, z.fee AS zone_fee, z.min_order, z.est_minutes
         FROM customer_addresses a
         LEFT JOIN delivery_zones z ON z.id = a.zone_id AND z.client_id = a.client_id
        WHERE a.id=? AND a.client_id=? AND a.is_active=1`, [addressId, clientId]);
    if (!addr) throw bad('Adres bulunamadı', 404);
  }
  /* No zone on the address - a customer added before the restaurant drew its
     zones, or a one-off address - falls back to the default rather than
     failing. A delivery must never be blocked by a fee table. */
  const zone = addr && addr.zid
    ? { id: addr.zid, name: addr.zone_name, fee: addr.zone_fee, est_minutes: addr.est_minutes }
    : await ensureDefaultZone(clientId);

  const cust = customerId
    ? await db.one('SELECT id, first_name, last_name, phone FROM customers WHERE id=?', [customerId])
    : null;

  const label = 'PKT ' + (cust ? String(cust.first_name || '').slice(0, 12) : 'Paket');
  const orderId = await orders.openOrder(clientId, {
    tableId: null, waiterId: null, userId, label, deviceId: null, offline: false,
  });
  if (customerId) {
    await db.exec('UPDATE orders SET customer_id=? WHERE id=? AND client_id=?', [customerId, orderId, clientId]);
  }

  const fee = money(zone.fee);
  if (fee > 0) {
    const p = await feeProduct(clientId);
    await orders.addItem(clientId, orderId, {
      productId: p.id, qty: 1, note: zone.name || null, unitPrice: fee, userId,
    });
  }

  /*
   * "Aynı siparişi tekrarla".
   *
   * Copied from the OLD BILL's lines rather than from a saved basket, because
   * the old bill is the only record of what the guest actually got - and the
   * price comes from the product TODAY, not from what it cost in March. A
   * product that has since been deleted or taken off the till is skipped and
   * counted, so the cashier is told rather than quietly given a short order.
   */
  let repeated = 0, skipped = 0;
  if (repeatFromOrderId) {
    const src = await db.one(
      'SELECT id FROM orders WHERE id=? AND client_id=? AND is_deleted=0', [repeatFromOrderId, clientId]);
    if (!src) throw bad('Tekrarlanacak adisyon bulunamadı', 404);
    const lines = await db.query(
      `SELECT oi.product_id, oi.qty, oi.note, p.is_active, p.use_in_pos
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id=? AND oi.client_id=? AND oi.is_deleted=0 ORDER BY oi.id`,
      [repeatFromOrderId, clientId]);
    for (const l of lines) {
      if (!l.product_id || !l.is_active) { skipped++; continue; }
      await orders.addItem(clientId, orderId, {
        productId: l.product_id, qty: Number(l.qty) || 1, note: l.note || null, userId });
      repeated++;
    }
  }

  const date = await bd.currentBusinessDate();
  const name = cust ? [cust.first_name, cust.last_name].filter(Boolean).join(' ') : null;
  const defaultMin = Number(await db.getSetting('delivery_default_minutes', 30)) || 30;
  const id = await db.insert(
    `INSERT INTO delivery_orders (client_id, order_id, business_date, source, customer_id, address_id,
        zone_id, customer_name, phone, address_text, directions, delivery_fee, status,
        payment_method, promised_minutes, note, created_by, scheduled_at, change_for_minor)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'NEW', ?,?,?,?,?,?)`,
    [clientId, orderId, date, source, customerId, addressId, zone.id || null,
     name, cust ? cust.phone : null,
     addr ? addr.address_text : '', addr ? addr.directions : null, fee,
     paymentMethod,
     Math.max(5, Math.min(240, Number(promisedMinutes) || Number(zone.est_minutes) || defaultMin)),
     note ? String(note).slice(0, 255) : null, userId,
     scheduledAt || null, Math.max(0, Math.round(Number(changeForMinor) || 0))]);

  await event(clientId, id, { to: 'NEW', actorId: userId,
    note: scheduledAt ? 'İleri tarihli: ' + String(scheduledAt).slice(0, 16) : null });
  log.info('paket', 'delivery opened', { clientId, orderId, deliveryId: id, source });
  return { deliveryId: id, orderId, fee, zone: zone.name,
    repeated, skipped, flag: flag ? flag.level : null };
}

/**
 * Put a platform order on the board.
 *
 * Called by the integration ingest AFTER it has built the adisyon, so a
 * Yemeksepeti order sits in the same lanes as a phone order and the cashier
 * works one screen instead of two. Idempotent by the unique key: the ingest
 * pipeline can replay an event and this returns the row it already made.
 */
async function attachPlatformOrder(clientId, orderId, info = {}) {
  const existing = await db.one(
    'SELECT * FROM delivery_orders WHERE client_id=? AND order_id=?', [clientId, orderId]);
  if (existing) return existing.id;

  const date = await bd.currentBusinessDate();
  const id = await db.insert(
    `INSERT INTO delivery_orders (client_id, order_id, business_date, source, int_order_id,
        customer_name, phone, address_text, directions, delivery_fee, status, is_prepaid,
        payment_method, promised_minutes, note, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'NEW', ?,?,?,?,0)`,
    [clientId, orderId, date, String(info.source || 'PLATFORM').slice(0, 24), info.intOrderId || null,
     (info.customerName || '').slice(0, 160) || null, (info.phone || '').slice(0, 40) || null,
     (info.addressText || '').slice(0, 400), (info.directions || '').slice(0, 255) || null,
     money(info.deliveryFee), info.isPrepaid ? 1 : 0,
     info.paymentMethod || null, Math.max(5, Math.min(240, Number(info.promisedMinutes) || 30)),
     (info.note || '').slice(0, 255) || null]);
  await event(clientId, id, { to: 'NEW', actorId: 0, note: 'Platform siparişi' });
  return id;
}

async function event(clientId, deliveryId, { from = null, to, courierId = null, actorId = 0, actorName = null, note = null }) {
  await db.exec(
    `INSERT INTO delivery_events (client_id, delivery_id, from_status, to_status, courier_id,
        actor_id, actor_name, note) VALUES (?,?,?,?,?,?,?,?)`,
    [clientId, deliveryId, from, to, courierId, actorId || 0, actorName, note ? String(note).slice(0, 255) : null]);
}

/* ==================================================================== */
/* pano                                                                 */
/* ==================================================================== */

/**
 * The board. Four lanes plus the day's finished ones.
 *
 * Everything still moving is returned whatever day it was opened on - an
 * order taken at 23:50 is still out at 00:10 and must not vanish from the
 * screen because the business day rolled. Only the DELIVERED lane is limited
 * to today, and only so the lane does not grow to a thousand cards.
 */
async function board(clientId, { date = null, limitDone = 25 } = {}) {
  const day = date || await bd.currentBusinessDate();
  const rows = await db.query(
    `SELECT d.*, o.adisyon_no, o.grand_total, o.status AS order_status,
            k.name AS courier_name,
            TIMESTAMPDIFF(MINUTE, d.created_at, NOW()) AS age_min,
            TIMESTAMPDIFF(MINUTE, NOW(), d.scheduled_at) AS due_in_min
       FROM delivery_orders d
       JOIN orders o ON o.id = d.order_id AND o.client_id = d.client_id
       LEFT JOIN couriers k ON k.id = d.courier_id AND k.client_id = d.client_id
      WHERE d.client_id=? AND o.is_deleted=0
        AND (d.status IN ('NEW','PREPARING','ON_ROUTE')
             OR (d.status='DELIVERED' AND d.business_date=?))
      ORDER BY d.created_at`, [clientId, day]);

  const lanes = { NEW: [], PREPARING: [], ON_ROUTE: [], DELIVERED: [] };
  for (const r of rows) {
    const promised = Number(r.promised_minutes) || 30;
    /*
     * An order taken at 15:00 for 20:30 is not late at 15:40.
     *
     * Its clock starts when it is DUE, not when it was written down, so
     * `age_min` is measured from the scheduled time once that has passed and
     * is negative (counting down) before it. Without this every scheduled
     * order turns orange within the hour and the late count - the one number
     * on this screen that is supposed to mean something - becomes noise.
     */
    const scheduled = !!r.scheduled_at;
    const dueIn = scheduled ? Number(r.due_in_min) : null;
    const age = scheduled ? (dueIn > 0 ? 0 : Math.abs(dueIn)) : Number(r.age_min) || 0;
    lanes[r.status] && lanes[r.status].push({
      id: r.id, order_id: r.order_id, adisyon_no: r.adisyon_no, source: r.source,
      customer_name: r.customer_name, phone: r.phone,
      address_text: r.address_text, directions: r.directions,
      total: money(r.grand_total), fee: money(r.delivery_fee),
      courier_id: r.courier_id, courier_name: r.courier_name,
      is_prepaid: !!r.is_prepaid, payment_method: r.payment_method,
      age_min: age,
      /* "Late" is measured against the time this order was PROMISED, not
         against one number for the whole restaurant: a 6 km delivery is not
         late at 25 minutes and a 1 km one is. */
      late: r.status !== 'DELIVERED' && age > promised,
      promised_minutes: promised, status: r.status, note: r.note,
      scheduled_at: r.scheduled_at, due_in_min: dueIn, is_scheduled: scheduled,
      change_for: money(Number(r.change_for_minor || 0) / 100),
      courier_fee: money(r.courier_fee),
      cancel_code: r.cancel_code,
    });
  }
  lanes.DELIVERED = lanes.DELIVERED.slice(-Number(limitDone));

  const onShift = Number(await db.value(
    'SELECT COUNT(*) FROM courier_shifts WHERE client_id=? AND closed_at IS NULL', [clientId]));
  const done = await db.one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(o.grand_total),0) AS total,
            COALESCE(AVG(TIMESTAMPDIFF(MINUTE, d.created_at, d.delivered_at)),0) AS avg_min
       FROM delivery_orders d JOIN orders o ON o.id=d.order_id AND o.client_id=d.client_id
      WHERE d.client_id=? AND d.business_date=? AND d.status='DELIVERED' AND o.is_deleted=0`,
    [clientId, day]);

  return {
    date: day, lanes,
    summary: {
      couriers_on_shift: onShift,
      delivered: Number(done?.n || 0),
      revenue: money(done?.total),
      avg_minutes: Math.round(Number(done?.avg_min || 0)),
      late: Object.values(lanes).flat().filter(x => x.late).length,
      scheduled: Object.values(lanes).flat().filter(x => x.is_scheduled && x.status !== 'DELIVERED').length,
    },
  };
}

async function detail(clientId, id) {
  const d = await db.one(
    `SELECT d.*, o.adisyon_no, o.grand_total, o.status AS order_status, k.name AS courier_name
       FROM delivery_orders d
       JOIN orders o ON o.id=d.order_id AND o.client_id=d.client_id
       LEFT JOIN couriers k ON k.id=d.courier_id AND k.client_id=d.client_id
      WHERE d.id=? AND d.client_id=?`, [id, clientId]);
  if (!d) throw bad('Paket sipariş bulunamadı', 404);
  const [order, events] = await Promise.all([
    orders.getOrder(clientId, d.order_id),
    db.query(
      `SELECT e.*, u.display_name FROM delivery_events e
         LEFT JOIN users u ON u.id = e.actor_id AND u.client_id = e.client_id
        WHERE e.client_id=? AND e.delivery_id=? ORDER BY e.id`, [clientId, id]),
  ]);
  return { delivery: d, order, events };
}

/* ==================================================================== */
/* durum değişimi                                                       */
/* ==================================================================== */

/**
 * Move a delivery along the board.
 *
 * The transition table is consulted first and the row is locked FOR UPDATE,
 * so two cashiers pressing "Teslim edildi" on the same card produce one
 * change and one payment rather than two. The rules that are not in the table:
 *
 *   ON_ROUTE needs a courier. Nobody is "yolda" without somebody carrying it,
 *   and letting it through would leave a delivery whose cash belongs to no
 *   shift - which is exactly the money that goes missing.
 *
 *   DELIVERED may carry a payment, and that payment goes on the BILL through
 *   the ordinary payments module. See the note at the top of this file: this
 *   is the only place a delivery touches the money ledger, and it touches it
 *   once.
 */
async function setStatus(clientId, id, next, opts = {}) {
  const { userId = 0, actorName = null, reason = null, payment = null } = opts;
  if (!STATUSES.includes(next)) throw bad('Geçersiz durum');

  /*
   * THE ZONE MINIMUM, which until now was a number nobody read.
   *
   * Checked here, on the way INTO the kitchen, because that is the last
   * moment the basket is still the cashier's to change and the first moment
   * it is complete. Checking it at order creation would be useless - no items
   * have been added yet - and checking it at dispatch would mean throwing
   * away food.
   *
   * Whether it stops the order or only says so is the restaurant's decision,
   * not ours: `delivery_min_order_block`. Even on `block` an explicit
   * `force` gets through, because the person on the phone sometimes says yes
   * to the difference and a till that cannot take that order is a till that
   * gets worked around.
   */
  if (next === 'PREPARING' && !opts.force) {
    const row = await db.one(
      `SELECT d.zone_id, d.delivery_fee, o.grand_total, z.min_order, z.name AS zone_name
         FROM delivery_orders d
         JOIN orders o ON o.id=d.order_id AND o.client_id=d.client_id
         LEFT JOIN delivery_zones z ON z.id=d.zone_id AND z.client_id=d.client_id
        WHERE d.id=? AND d.client_id=?`, [id, clientId]);
    const min = Number(row && row.min_order) || 0;
    /* The fee is not part of the basket: a 150 TL minimum means 150 TL of
       food, and counting the delivery charge towards it would quietly lower
       the limit the owner set. */
    const basket = money(Number(row && row.grand_total || 0) - Number(row && row.delivery_fee || 0));
    if (min > 0 && basket < min) {
      const mode = String(await db.getSetting('delivery_min_order_block', 'warn'));
      const e = new Error(`Sepet tutarı ${(row.zone_name || 'bölge')} alt limitinin altında: `
        + `${basket.toFixed(2)} < ${min.toFixed(2)}`);
      e.status = 409;
      e.code = mode === 'block' ? 'MIN_ORDER_BLOCK' : 'MIN_ORDER_WARN';
      e.min_order = min; e.basket = basket;
      throw e;
    }
  }

  const done = await db.tx(async t => {
    const d = await t.one('SELECT * FROM delivery_orders WHERE id=? AND client_id=? FOR UPDATE', [id, clientId]);
    if (!d) throw bad('Paket sipariş bulunamadı', 404);
    if (d.status === next) return { delivery: d, changed: false };
    if (!NEXT[d.status].includes(next)) {
      throw bad(`"${LANE_LABEL[d.status]}" durumundan "${LANE_LABEL[next]}" durumuna geçilemez`, 409);
    }
    if (next === 'ON_ROUTE' && !d.courier_id) throw bad('Önce kurye seçin', 409);
    if (next === 'CANCELLED' && !opts.cancelCode) {
      throw bad('İptal sebebi seçin', 409);
    }

    const stamp = {
      PREPARING: 'assigned_at', ON_ROUTE: 'dispatched_at',
      DELIVERED: 'delivered_at', CANCELLED: 'cancelled_at',
    }[next];
    await t.exec(
      `UPDATE delivery_orders SET status=?, ${stamp ? stamp + '=NOW(),' : ''}
          cancel_reason=?, cancel_code=?, updated_at=NOW() WHERE id=? AND client_id=?`,
      [next, next === 'CANCELLED' ? (reason || '').slice(0, 190) || null : d.cancel_reason,
       next === 'CANCELLED' ? String(opts.cancelCode).slice(0, 24) : d.cancel_code, id, clientId]);
    return { delivery: d, changed: true };
  });

  if (!done.changed) return { ok: true, changed: false };
  await event(clientId, id, {
    from: done.delivery.status, to: next, courierId: done.delivery.courier_id,
    actorId: userId, actorName, note: reason,
  });

  /*
   * CANCELLING HAS TO REVERSE THE BILL, and until this block existed it did
   * not.
   *
   * The card turned to İptal and nothing else happened: the adisyon stayed
   * open, the stock stayed consumed, and the money stayed in the day's
   * takings - while the dialog on the way in promised the exact opposite.
   * That is the worst shape a bug can have, because the screen tells the
   * cashier the accounting was done and the Z report quietly disagrees at the
   * end of the night.
   *
   * `orders.deleteBill` is the till's own answer to "this should not have
   * happened": it writes the whole original into order_delete_logs, reverses
   * the stock and the recipe consumption, marks the payments deleted so the
   * takings come back down, cancels the kitchen tickets and excludes the bill
   * from the reports. Reproducing any part of that here would be a second
   * implementation that drifts, which is why the platform ingest calls the
   * same function.
   *
   * A PLATFORM order is cancelled through the integration service instead, so
   * that Yemeksepeti or Trendyol is actually told - `orderAction` unwinds the
   * bill itself on the way. Cancelling one of their orders in silence leaves
   * the platform waiting for food nobody is cooking.
   */
  if (next === 'CANCELLED') {
    const d = done.delivery;
    const platform = d.source !== 'PHONE' && d.source !== 'COUNTER' && d.int_order_id;
    try {
      if (platform) {
        await require('../integrations').orderAction(clientId, d.int_order_id, 'cancel', {
          reason: reason || LANE_LABEL.CANCELLED,
          reasonCode: opts.cancelCode || null,
          actor: actorName || 'kasa',
        });
      } else {
        await orders.deleteBill(clientId, d.order_id, {
          userId, reason: 'Paket iptal: ' + (CANCEL_LABEL[opts.cancelCode] || opts.cancelCode || '')
            + (reason ? ' — ' + reason : ''),
        });
      }
    } catch (e) {
      /*
       * The status is already committed, so the worst case is a cancelled
       * card whose bill is still open - visible, fixable from Adisyonlar, and
       * loudly logged. Rolling the status back instead would leave a card
       * that says "on its way" for food nobody is making.
       */
      log.error('paket', 'cancel did not reverse the bill', {
        clientId, deliveryId: id, orderId: d.order_id, platform: !!platform, error: e.message });
      return { ok: true, changed: true, status: next, billReversed: false, error: e.message };
    }
    return { ok: true, changed: true, status: next, billReversed: true };
  }

  /*
   * The payment, OUTSIDE the transaction above on purpose: addPayment opens
   * its own and locks the order row, and nesting the two is how a till
   * deadlocks itself on a busy Friday. The status is already committed, so
   * the worst case is a delivered order whose payment failed - visible,
   * fixable from the bill, and not a lost row.
   */
  if (next === 'DELIVERED' && payment && payment.method && Number(payment.amount) > 0) {
    /* Only what the restaurant said a courier may take at the door. The screen
       offers the same list, but a list the server does not check is a list. */
    const allowed = String(await db.getSetting('delivery_door_methods', 'nakit,kredi_karti,yemek_karti'))
      .split(',').map(x => x.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(payment.method)) {
      throw bad('Bu ödeme türü kapıda kabul edilmiyor: ' + payment.method, 409);
    }
    await payments.addPayment(clientId, done.delivery.order_id, {
      method: payment.method, amount: money(payment.amount), userId, channel: 'paket',
    });
    if (payment.method === 'nakit') {
      await db.exec(
        'UPDATE delivery_orders SET cash_collected_minor=?, payment_method=? WHERE id=? AND client_id=?',
        [Math.round(money(payment.amount) * 100), payment.method, id, clientId]);
    } else {
      await db.exec('UPDATE delivery_orders SET payment_method=? WHERE id=? AND client_id=?',
        [payment.method, id, clientId]);
    }
  }
  return { ok: true, changed: true, status: next };
}

/* ==================================================================== */
/* kuryeler                                                             */
/* ==================================================================== */

async function courierList(clientId, { includeInactive = false } = {}) {
  const rows = await db.query(
    `SELECT k.*,
            s.id AS shift_id, s.opened_at AS shift_opened_at,
            (SELECT COUNT(*) FROM delivery_orders d
              WHERE d.client_id=k.client_id AND d.courier_id=k.id
                AND d.status IN ('PREPARING','ON_ROUTE')) AS carrying,
            (SELECT COUNT(*) FROM delivery_orders d
              WHERE d.client_id=k.client_id AND d.courier_id=k.id
                AND d.status='DELIVERED' AND d.business_date=CURDATE()) AS delivered_today,
            (SELECT COALESCE(SUM(d.cash_collected_minor),0) FROM delivery_orders d
              WHERE d.client_id=k.client_id AND d.courier_id=k.id
                AND d.courier_shift_id = s.id AND d.status='DELIVERED') AS cash_minor,
            (SELECT COALESCE(AVG(TIMESTAMPDIFF(MINUTE, d.dispatched_at, d.delivered_at)),0)
               FROM delivery_orders d
              WHERE d.client_id=k.client_id AND d.courier_id=k.id AND d.status='DELIVERED'
                AND d.business_date=CURDATE() AND d.dispatched_at IS NOT NULL) AS avg_min
       FROM couriers k
       LEFT JOIN courier_shifts s ON s.client_id=k.client_id AND s.courier_id=k.id AND s.closed_at IS NULL
      WHERE k.client_id=? ${includeInactive ? '' : 'AND k.is_active=1'}
      ORDER BY (s.id IS NULL), k.name`, [clientId]);
  return rows.map(r => ({
    id: r.id, name: r.name, phone: r.phone, is_active: !!r.is_active, user_id: r.user_id,
    on_shift: !!r.shift_id, shift_id: r.shift_id, shift_opened_at: r.shift_opened_at,
    carrying: Number(r.carrying || 0),
    delivered_today: Number(r.delivered_today || 0),
    cash: money(Number(r.cash_minor || 0) / 100),
    avg_minutes: Math.round(Number(r.avg_min || 0)),
  }));
}

async function saveCourier(clientId, data) {
  const name = String(data.name || '').trim();
  if (name.length < 2) throw bad('Kurye adı gerekli');
  /* An empty box means "use the zone rate", which is not the same as zero -
     zero is a courier who is paid nothing per drop, and somebody has to be
     able to say that. So blank becomes NULL and 0 stays 0. */
  const own = (data.fee_per_delivery === '' || data.fee_per_delivery === null
               || data.fee_per_delivery === undefined) ? null : money(data.fee_per_delivery);
  if (own !== null && own < 0) throw bad('Kurye hakedişi eksi olamaz');
  if (data.id) {
    await db.exec(
      `UPDATE couriers SET name=?, phone=?, user_id=?, fee_per_delivery=?, is_active=?, updated_at=NOW()
        WHERE id=? AND client_id=?`,
      [name, data.phone || null, data.user_id || null, own,
       data.is_active === false ? 0 : 1, data.id, clientId]);
    return data.id;
  }
  return db.insert(
    'INSERT INTO couriers (client_id, user_id, name, phone, fee_per_delivery, is_active) VALUES (?,?,?,?,?,1)',
    [clientId, data.user_id || null, name, data.phone || null, own]);
}

/**
 * Open a courier's shift, or hand back the one already open.
 *
 * Called by hand from the screen and automatically when a delivery is
 * assigned. Automatic on purpose: a cashier assigning an order at 19:00 is
 * telling us the courier is working, and making them press a second button
 * first is how orders end up assigned to nobody. The unique key on
 * (client_id, open_courier_id) means two simultaneous assigns still produce
 * one shift.
 */
async function openCourierShift(clientId, courierId, userId = 0) {
  const open = await db.one(
    'SELECT * FROM courier_shifts WHERE client_id=? AND courier_id=? AND closed_at IS NULL', [clientId, courierId]);
  if (open) return open;
  const date = await bd.currentBusinessDate();
  const posShift = await db.one(
    "SELECT id FROM pos_shifts WHERE client_id=? AND status='open' ORDER BY id DESC LIMIT 1", [clientId]);
  try {
    const id = await db.insert(
      `INSERT INTO courier_shifts (client_id, courier_id, business_date, pos_shift_id, opened_by)
       VALUES (?,?,?,?,?)`, [clientId, courierId, date, posShift ? posShift.id : null, userId]);
    return db.one('SELECT * FROM courier_shifts WHERE id=?', [id]);
  } catch (e) {
    /* Lost the race against another cashier - the unique key did its job. */
    const again = await db.one(
      'SELECT * FROM courier_shifts WHERE client_id=? AND courier_id=? AND closed_at IS NULL', [clientId, courierId]);
    if (again) return again;
    throw e;
  }
}

async function assignCourier(clientId, id, courierId, userId = 0) {
  const k = await db.one('SELECT * FROM couriers WHERE id=? AND client_id=? AND is_active=1', [courierId, clientId]);
  if (!k) throw bad('Kurye bulunamadı', 404);
  const shift = await openCourierShift(clientId, courierId, userId);

  const d = await db.one('SELECT * FROM delivery_orders WHERE id=? AND client_id=?', [id, clientId]);
  if (!d) throw bad('Paket sipariş bulunamadı', 404);
  if (d.status === 'DELIVERED' || d.status === 'CANCELLED') {
    throw bad('Tamamlanmış siparişin kuryesi değiştirilemez', 409);
  }
  /*
   * What this drop costs the restaurant, SNAPSHOT now.
   *
   * The courier's own rate wins when one is set, otherwise the zone's. It is
   * frozen onto the delivery at assignment for the same reason the address
   * is: raising the rate next month must not rewrite what last month's
   * shifts owed, and a courier reading his own total has to see the number he
   * was working to on the night.
   */
  const zoneFee = d.zone_id
    ? Number(await db.value('SELECT courier_fee FROM delivery_zones WHERE id=? AND client_id=?',
        [d.zone_id, clientId]) || 0)
    : 0;
  const pay = money(k.fee_per_delivery === null || k.fee_per_delivery === undefined
    ? zoneFee : k.fee_per_delivery);

  await db.exec(
    `UPDATE delivery_orders SET courier_id=?, courier_shift_id=?, courier_fee=?,
        assigned_at=COALESCE(assigned_at, NOW()), updated_at=NOW() WHERE id=? AND client_id=?`,
    [courierId, shift.id, pay, id, clientId]);
  await event(clientId, id, { from: d.status, to: d.status, courierId, actorId: userId,
    note: 'Kurye: ' + k.name });

  /*
   * The slip goes in the bag NOW, not when the courier walks out.
   *
   * Printing at dispatch sounds tidier and is worse: by then the bag is tied
   * and somebody is holding the door. Printing at assignment puts the paper
   * next to the food while it is still being packed, which is the moment a
   * kitchen can act on it.
   *
   * Failure to print must never fail the assignment - the order is on the
   * board, the address is on the screen, and a jammed printer is not a reason
   * to leave a delivery with no courier. It is logged and the cashier can
   * reprint from the card.
   */
  try { await printing.queueCourierSlip(clientId, d.order_id); }
  catch (e) { log.warn('paket', 'courier slip not queued', { orderId: d.order_id, error: e.message }); }

  return { ok: true, courier: k.name, shift_id: shift.id };
}

/** Reprint on demand - a slip that jammed, or a second copy for the bag. */
async function reprintCourierSlip(clientId, id) {
  const d = await db.one('SELECT order_id FROM delivery_orders WHERE id=? AND client_id=?', [id, clientId]);
  if (!d) throw bad('Paket sipariş bulunamadı', 404);
  const job = await printing.queueCourierSlip(clientId, d.order_id);
  return { ok: true, job };
}

/**
 * What this courier is holding, recomputed from the bills.
 *
 * Never read from a running total. The figure a cashier is about to count
 * against a person's pocket has to come from the same rows the Z report comes
 * from, or the two disagree and the courier is the one accused.
 */
async function courierDetail(clientId, courierId) {
  const k = await db.one('SELECT * FROM couriers WHERE id=? AND client_id=?', [courierId, clientId]);
  if (!k) throw bad('Kurye bulunamadı', 404);
  const shift = await db.one(
    'SELECT * FROM courier_shifts WHERE client_id=? AND courier_id=? AND closed_at IS NULL', [clientId, courierId]);

  const rows = await db.query(
    `SELECT d.id, d.order_id, d.status, d.address_text, d.customer_name, d.payment_method,
            d.is_prepaid, d.cash_collected_minor, d.courier_fee, d.dispatched_at, d.delivered_at,
            o.adisyon_no, o.grand_total,
            TIMESTAMPDIFF(MINUTE, d.created_at, NOW()) AS age_min
       FROM delivery_orders d
       JOIN orders o ON o.id=d.order_id AND o.client_id=d.client_id
      WHERE d.client_id=? AND d.courier_id=? AND o.is_deleted=0
        AND (d.status IN ('PREPARING','ON_ROUTE') OR d.courier_shift_id = ?)
      ORDER BY d.created_at`, [clientId, courierId, shift ? shift.id : 0]);

  const cashMinor = rows
    .filter(r => r.status === 'DELIVERED' && shift)
    .reduce((s, r) => s + Number(r.cash_collected_minor || 0), 0);
  /* What the restaurant owes HIM for this shift, from the rates frozen onto
     each delivery when it was assigned. */
  const earnedMinor = rows
    .filter(r => r.status === 'DELIVERED' && shift)
    .reduce((s, r) => s + Math.round(Number(r.courier_fee || 0) * 100), 0);
  const uncollected = rows.filter(r => r.status === 'DELIVERED' && !r.is_prepaid
    && Number(r.cash_collected_minor || 0) === 0 && r.payment_method !== 'kredi_karti').length;

  return {
    courier: { id: k.id, name: k.name, phone: k.phone, is_active: !!k.is_active },
    shift: shift || null,
    orders: rows.map(r => ({
      id: r.id, order_id: r.order_id, adisyon_no: r.adisyon_no, status: r.status,
      customer_name: r.customer_name, address_text: r.address_text,
      payment_method: r.payment_method, is_prepaid: !!r.is_prepaid,
      total: money(r.grand_total), age_min: Number(r.age_min || 0),
      courier_fee: money(r.courier_fee),
    })),
    cash: money(cashMinor / 100),
    cash_minor: cashMinor,
    earned: money(earnedMinor / 100),
    earned_minor: earnedMinor,
    uncollected,
  };
}

/**
 * Take the cash in and close the shift.
 *
 * WRITES NO PAYMENT. Every lira here was already recorded against its bill
 * when the delivery was marked teslim edildi, so a payment row now would be
 * the same money twice. What is recorded is custody and any difference, which
 * is what a cashier and a courier actually need to sign off on.
 *
 * The shift is closed rather than emptied: if the courier keeps working, the
 * next assignment opens a fresh one. That is how a mid-shift cash drop works
 * on paper too, and it means the settled deliveries stay attached to the
 * shift they were settled in and can never be counted a second time.
 */
async function settleCourier(clientId, courierId, { takenMinor = null, userId = 0, note = null } = {}) {
  const d = await courierDetail(clientId, courierId);
  if (!d.shift) throw bad('Bu kuryenin açık vardiyası yok', 409);
  const still = d.orders.filter(o => o.status === 'PREPARING' || o.status === 'ON_ROUTE');
  if (still.length) {
    throw bad(`Kuryenin üzerinde ${still.length} teslim edilmemiş sipariş var. Önce onları kapatın.`, 409);
  }
  const expected = d.cash_minor;
  const taken = takenMinor === null ? expected : Math.round(Number(takenMinor));
  const delivered = d.orders.filter(o => o.status === 'DELIVERED').length;

  await db.exec(
    `UPDATE courier_shifts SET closed_at=NOW(), closed_by=?, cash_expected_minor=?, cash_taken_minor=?,
        variance_minor=?, deliveries=?, earned_minor=?, note=? WHERE id=? AND client_id=?`,
    [userId, expected, taken, taken - expected, delivered, d.earned_minor,
     note ? String(note).slice(0, 255) : null, d.shift.id, clientId]);
  log.info('paket', 'courier settled',
    { clientId, courierId, expected, taken, delivered, earned: d.earned_minor });
  return {
    ok: true, expected: money(expected / 100), taken: money(taken / 100),
    variance: money((taken - expected) / 100), deliveries: delivered,
    /* What he is OWED is reported next to what he handed in, but they are not
       netted off here. Paying a courier out of the drawer he just filled is a
       decision with a payroll consequence, and a till that does it silently
       is a till whose Z report nobody can reconcile. */
    earned: money(d.earned_minor / 100),
  };
}

async function closeCourierShift(clientId, courierId, opts = {}) {
  return settleCourier(clientId, courierId, opts);
}

/* ==================================================================== */
/* rapor                                                                */
/* ==================================================================== */

async function report(clientId, { from = null, to = null } = {}) {
  const day = await bd.currentBusinessDate();
  const a = from || day, b = to || day;
  const [totals, bySource, byCourier] = await Promise.all([
    db.one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(o.grand_total),0) AS total,
              COALESCE(SUM(d.delivery_fee),0) AS fees,
              COALESCE(AVG(TIMESTAMPDIFF(MINUTE, d.created_at, d.delivered_at)),0) AS avg_min,
              SUM(d.status='CANCELLED') AS cancelled
         FROM delivery_orders d JOIN orders o ON o.id=d.order_id AND o.client_id=d.client_id
        WHERE d.client_id=? AND d.business_date BETWEEN ? AND ? AND o.is_deleted=0`, [clientId, a, b]),
    db.query(
      `SELECT d.source, COUNT(*) AS n, COALESCE(SUM(o.grand_total),0) AS total
         FROM delivery_orders d JOIN orders o ON o.id=d.order_id AND o.client_id=d.client_id
        WHERE d.client_id=? AND d.business_date BETWEEN ? AND ? AND o.is_deleted=0 AND d.status<>'CANCELLED'
        GROUP BY d.source ORDER BY n DESC`, [clientId, a, b]),
    /*
     * PER-COURIER PERFORMANCE, and the columns are chosen to answer the
     * questions an owner actually asks about a courier:
     *
     *   is he quick        average and slowest minutes ON THE ROAD - measured
     *                      from dispatch, not from when the order was taken,
     *                      because a courier cannot be blamed for a kitchen;
     *   is he late         counted against each order's OWN promise, so a
     *                      round of long-distance drops does not read as a
     *                      slow courier;
     *   how much did he    the takings he carried, and the cash specifically;
     *   does his till add  the sum of the differences from his settled
     *                      shifts. This is the column that matters and the
     *                      one nobody can produce by hand: a courier who is
     *                      five lira short every night is a pattern, and a
     *                      pattern is not visible one evening at a time.
     */
    db.query(
      `SELECT k.id, k.name,
              COUNT(*) AS n,
              COALESCE(SUM(o.grand_total),0) AS total,
              COALESCE(SUM(d.cash_collected_minor),0) AS cash_minor,
              COALESCE(SUM(d.courier_fee),0) AS pay_total,
              COALESCE(AVG(TIMESTAMPDIFF(MINUTE, d.dispatched_at, d.delivered_at)),0) AS avg_min,
              COALESCE(MAX(TIMESTAMPDIFF(MINUTE, d.dispatched_at, d.delivered_at)),0) AS max_min,
              SUM(TIMESTAMPDIFF(MINUTE, d.created_at, d.delivered_at) > d.promised_minutes) AS late_n
         FROM delivery_orders d
         JOIN orders o ON o.id=d.order_id AND o.client_id=d.client_id
         JOIN couriers k ON k.id=d.courier_id AND k.client_id=d.client_id
        WHERE d.client_id=? AND d.business_date BETWEEN ? AND ? AND d.status='DELIVERED' AND o.is_deleted=0
        GROUP BY k.id, k.name ORDER BY n DESC`, [clientId, a, b]),
  ]);

  /* The till differences come from the SHIFTS, not from the orders, and are
     fetched separately rather than joined: joining a per-shift sum onto a
     per-order group multiplies it by the number of deliveries in the shift,
     which is the classic way a report like this quietly lies. */
  const variances = await db.query(
    `SELECT courier_id, COUNT(*) AS shifts, COALESCE(SUM(variance_minor),0) AS var_minor,
            COALESCE(SUM(cash_taken_minor),0) AS taken_minor
       FROM courier_shifts
      WHERE client_id=? AND business_date BETWEEN ? AND ? AND closed_at IS NOT NULL
      GROUP BY courier_id`, [clientId, a, b]);
  const varBy = Object.fromEntries(variances.map(v => [v.courier_id, v]));

  /* WHY orders were cancelled, which is the difference between a kitchen
     problem, a courier problem and a customer problem - three things an owner
     fixes in three different ways and cannot tell apart from one total. */
  const cancels = await db.query(
    `SELECT COALESCE(NULLIF(d.cancel_code,''), 'DIGER') AS code, COUNT(*) AS n,
            COALESCE(SUM(o.grand_total),0) AS total
       FROM delivery_orders d JOIN orders o ON o.id=d.order_id AND o.client_id=d.client_id
      WHERE d.client_id=? AND d.business_date BETWEEN ? AND ? AND d.status='CANCELLED'
      GROUP BY code ORDER BY n DESC`, [clientId, a, b]);
  return {
    from: a, to: b,
    totals: {
      orders: Number(totals?.n || 0), revenue: money(totals?.total), fees: money(totals?.fees),
      avg_minutes: Math.round(Number(totals?.avg_min || 0)), cancelled: Number(totals?.cancelled || 0),
    },
    by_source: bySource.map(r => ({ source: r.source, orders: Number(r.n), revenue: money(r.total) })),
    cancels: cancels.map(r => ({ code: r.code, label: CANCEL_LABEL[r.code] || r.code,
      orders: Number(r.n), revenue: money(r.total) })),
    by_courier: byCourier.map(r => {
      const v = varBy[r.id] || {};
      const n = Number(r.n) || 0;
      const late = Number(r.late_n || 0);
      return {
        id: r.id, name: r.name, orders: n,
        revenue: money(r.total),
        cash: money(Number(r.cash_minor || 0) / 100),
        avg_minutes: Math.round(Number(r.avg_min || 0)),
        max_minutes: Math.round(Number(r.max_min || 0)),
        pay: money(r.pay_total),
        late: late,
        on_time_pct: n ? Math.round(((n - late) / n) * 100) : 100,
        shifts: Number(v.shifts || 0),
        variance: money(Number(v.var_minor || 0) / 100),
        settled: money(Number(v.taken_minor || 0) / 100),
      };
    }),
  };
}

module.exports = {
  STATUSES, NEXT, LANE_LABEL, FEE_PRODUCT_NAME, CANCEL_CODES, CANCEL_LABEL, FLAG_LEVELS,
  flagCustomer, clearFlag, flagOf, flagHistory,
  ensureDefaultZone, zones, saveZone, deleteZone,
  lookup, addressList, saveAddress, deleteAddress, searchAddresses,
  feeProduct,
  createOrder, attachPlatformOrder, board, detail, setStatus,
  courierList, saveCourier, openCourierShift, assignCourier, courierDetail, reprintCourierSlip,
  settleCourier, closeCourierShift, report,
};
