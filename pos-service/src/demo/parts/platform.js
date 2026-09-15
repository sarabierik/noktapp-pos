'use strict';
/**
 * ENTEGRASYON — Yemeksepeti, Getir Yemek, Migros Yemek ve Trendyol/Uber Eats.
 *
 * Dört bağlantı, yedi yıllık platform siparişi, sipariş satırları, olay
 * kuyruğu ve işlem günlüğü. The bills themselves already exist: trading.js
 * closed them and handed the takeaway ones over in ctx.platformOrders. What
 * this part writes is the MIRROR — what the platform said about each of those
 * bills — plus the pipeline's own paper trail.
 *
 * THE ONE DECISION WORTH EXPLAINING: rejected orders have no adisyon.
 *
 * It is tempting to mark a slice of the seeded bills REDDEDİLDİ so the status
 * filter has something in every position. It would also be a lie the screen
 * can catch: src/integrations/ingest.js opens the adisyon only AFTER an order
 * is accepted, and rejecting one unwinds the bill through orders.deleteBill.
 * A REJECTED mirror pointing at a closed, paid adisyon is a platform order the
 * restaurant refused and charged for. So the rejections and the pre-acceptance
 * cancellations are EXTRA mirror rows with order_id NULL — which is exactly
 * what the pipeline leaves behind when the answer was hayır — and every row
 * that does carry an order_id is one the restaurant really cooked.
 *
 * Two smaller ones. The provider codes are registry.js's own keys and nothing
 * else: a connection row whose provider the registry cannot resolve is a card
 * the Entegrasyonlar screen will not draw. And `credentials_enc` is left NULL
 * on every row - a demo must never ship something shaped like a live API key,
 * so the connections run in `simulator` and the screen says so.
 */
const { bulk, ymd, dt, addDays, atTime, money } = require('../lib');
const D = require('../data');

/*
 * The four providers, keyed exactly as src/integrations/registry.js keys them.
 *
 * UBER_EATS_TGO is the one whose name surprises people: Trendyol Yemek,
 * Trendyol Go and "Getir Yemek by Uber Eats" all arrive through that single
 * supplier connection, which is why there is no TRENDYOL_YEMEK key and why
 * GETIR_YEMEK next to it is the older direct integration.
 *
 *   from      when the restaurant signed up - the order mix walks with it
 *   store     the platform's own id for this branch. Not a secret.
 *   status    provider vocabulary, in the order of STATUSES in status.js:
 *             RECEIVED, ACCEPTED, PREPARING, READY, DISPATCHED, DELIVERED,
 *             REJECTED, CANCELLED. Taken from each adapter's DEFAULT_STATUS_MAP.
 */
const PROVIDERS = [
  {
    key: 'YEMEKSEPETI', label: 'Yemeksepeti', from: '2020-03-01',
    store: '724193', chain: 'KALEICI', supplier: '', source: 'Yemeksepeti',
    transport: 'webhook', acceptance: 'POS_DIRECT', autoAccept: 0, prep: 25, delivery: 45,
    status: ['incoming', 'accepted', 'preparing', 'prepared', 'picked', 'delivered',
             'order_rejected', 'cancelled'],
    pay: ['ONLINE', 'CASH_ON_DELIVERY', 'CREDIT_CARD_ON_DELIVERY', 'MEAL_TICKET'],
  },
  {
    key: 'GETIR_YEMEK', label: 'Getir Yemek', from: '2021-05-10',
    store: '61b4f0a2c91d4a7f3e8b2d16', chain: '', supplier: '', source: 'GetirYemek',
    transport: 'polling', acceptance: 'PROVIDER_TABLET', autoAccept: 0, prep: 20, delivery: 40,
    status: ['400', '325', '350', '360', '550', '900', '1400', '1600'],
    pay: ['ONLINE', 'CASH', 'CREDIT_CARD_ON_DELIVERY', 'MEAL_TICKET'],
  },
  {
    key: 'MIGROS_YEMEK', label: 'Migros Yemek', from: '2022-04-18',
    store: '19233', chain: '4471', supplier: '', source: 'MigrosYemek',
    transport: 'polling', acceptance: 'PROVIDER_TABLET', autoAccept: 0, prep: 25, delivery: 45,
    status: ['NEW', 'APPROVED', 'PREPARING', 'PREPARED', 'HANDOVER', 'DELIVERED',
             'REJECTED', 'CANCELLED'],
    pay: ['ONLINE', 'CASH_ON_DELIVERY', 'CREDIT_CARD_ON_DELIVERY'],
  },
  {
    key: 'UBER_EATS_TGO', label: 'Uber Eats Trendyol Go', from: '2023-02-06',
    store: '551477', chain: '', supplier: '108422', source: 'TrendyolGo',
    transport: 'polling', acceptance: 'PROVIDER_TABLET', autoAccept: 1, prep: 20, delivery: 35,
    status: ['Created', 'Picking', 'Picking', 'Invoiced', 'Shipped', 'Delivered',
             'UnSupplied', 'Cancelled'],
    pay: ['PAY_WITH_CARD', 'PAY_WITH_ON_DELIVERY', 'PAY_WITH_ON_DELIVERY_CARD'],
  },
];
const RANK = ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY', 'DISPATCHED', 'DELIVERED',
  'REJECTED', 'CANCELLED'];

/* How the platform business split, year by year. The restaurant joined them
   one at a time and the newcomer takes share from Yemeksepeti, which is what
   actually happened to every kebap house in Antalya. */
const MIX = {
  2020: { YEMEKSEPETI: 100 },
  2021: { YEMEKSEPETI: 78, GETIR_YEMEK: 22 },
  2022: { YEMEKSEPETI: 60, GETIR_YEMEK: 25, MIGROS_YEMEK: 15 },
  2023: { YEMEKSEPETI: 46, GETIR_YEMEK: 24, MIGROS_YEMEK: 16, UBER_EATS_TGO: 14 },
  2024: { YEMEKSEPETI: 40, GETIR_YEMEK: 22, MIGROS_YEMEK: 16, UBER_EATS_TGO: 22 },
  2025: { YEMEKSEPETI: 36, GETIR_YEMEK: 20, MIGROS_YEMEK: 16, UBER_EATS_TGO: 28 },
  2026: { YEMEKSEPETI: 34, GETIR_YEMEK: 20, MIGROS_YEMEK: 12, UBER_EATS_TGO: 34 },
};

/* Reject reasons the Yemeksepeti adapter publishes, plus the numeric ones the
   TGO "Paket Modelleri" document lists for a restaurant-side cancellation. */
const REJECTS = [
  ['ITEM_OUT_OF_STOCK', 'Üründe stok yok'],
  ['KITCHEN_BUSY', 'Mutfak çok yoğun'],
  ['CLOSING_SOON', 'Kapanış saati'],
  ['TECHNICAL_PROBLEM', 'Teknik sorun'],
  ['DELIVERY_AREA', 'Teslimat bölgesi dışında'],
  ['621', 'Tedarik problemi'],
  ['623', 'Mağaza siparişi hazırlayamıyor'],
];
const CANCELS = ['Müşteri uygulamadan iptal etti', 'Kurye bulunamadı',
  'Platform iptali: adres hatalı', 'Müşteri kapıyı açmadı', 'Ödeme alınamadı'];

const CUSTOMER_NOTES = ['Zile basmayın', 'Acısız olsun lütfen', 'Çatal bıçak istemiyorum',
  'Kapıya bırakın', 'Ayran soğuk olsun', 'Sos ayrı paketlensin', 'Fişi poşete koyun'];

const DISTRICTS = ['Muratpaşa', 'Konyaaltı', 'Kepez', 'Lara', 'Kaleiçi'];

/** Tables this database actually has — later migrations bring some of these. */
async function tableSet(db) {
  const rows = await db.query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=DATABASE()');
  return new Set(rows.map(r => String(r.t)));
}

/** What each bill was actually paid with, so the mirror does not disagree. */
async function paymentsByOrder(db, clientId, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 800) {
    const slice = ids.slice(i, i + 800);
    const rows = await db.query(
      'SELECT order_id, method, SUM(amount) AS amount FROM order_payments ' +
      'WHERE client_id=? AND order_id IN (' + slice.map(() => '?').join(',') + ') ' +
      'GROUP BY order_id, method', [clientId, ...slice]);
    for (const row of rows) {
      const id = Number(row.order_id);
      const cur = out.get(id) || { top: null, topAmount: 0 };
      const amount = Number(row.amount) || 0;
      if (amount > cur.topAmount) { cur.top = String(row.method); cur.topAmount = amount; }
      out.set(id, cur);
    }
  }
  return out;
}

async function build(ctx) {
  const { db, clientId, rand: r } = ctx;
  const pick = (a) => a[Math.floor(r() * a.length)];
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));
  const hex = (n) => { let s = ''; while (s.length < n) s += Math.floor(r() * 16).toString(16); return s; };
  const digits = (n) => { let s = ''; while (s.length < n) s += between(0, 9); return s; };

  const have = await tableSet(db);
  if (!have.has('np_int_connections') || !have.has('np_int_orders')) {
    ctx.log('entegrasyon: tablolar yok, bölüm atlandı');
    return;
  }
  const haveItems = have.has('np_int_order_items');
  const haveEvents = have.has('np_int_events');
  const haveLogs = have.has('np_int_logs');

  const todayStr = ymd(ctx.today);
  /* Migros' key expired a week and a half ago and nobody has re-entered it -
     the Entegrasyonlar screen exists to make exactly that visible, and a demo
     where all four cards are green never shows the red one. */
  const migrosDied = ymd(addDays(ctx.today, -9));

  /* ----------------------------------------------------------- bağlantılar */
  const conns = new Map();
  for (const p of PROVIDERS) {
    const dead = p.key === 'MIGROS_YEMEK';
    const lastOk = dead ? migrosDied + ' 13:42:11'
      : dt(new Date(ctx.today.getTime() + between(9, 14) * 3600000 + between(0, 59) * 60000));
    const id = await db.insert(
      `INSERT INTO np_int_connections (client_id, branch_id, provider, environment, enabled,
          credentials_enc, cred_hint, provider_store_id, supplier_id, chain_id, acceptance_mode,
          auto_accept, default_prep_minutes, delivery_minutes, poll_interval_sec, station_id,
          receipt_station_id, restaurant_open, status, last_ok_at, last_sync_at, last_error,
          last_error_at, created_at, updated_at)
       VALUES (?,1,?, 'simulator', ?, NULL, NULL, ?,?,?,?, ?,?,?,?, NULL, NULL, 1, ?,?,?,?,?,?,?)`,
      [clientId, p.key, dead ? 0 : 1, p.store, p.supplier, p.chain, p.acceptance,
       p.autoAccept, p.prep, p.delivery, p.transport === 'polling' ? 7 : 10,
       dead ? 'error' : 'connected', lastOk, lastOk,
       dead ? 'Restoran API anahtarı reddedildi (401). İş ortağı paketindeki anahtarı yeniden girin.' : null,
       dead ? migrosDied + ' 13:44:02' : null,
       p.from + ' 10:00:00', lastOk]);
    conns.set(p.key, { ...p, id, dead });
  }

  const src = (ctx.platformOrders || []).slice();
  if (!src.length) {
    ctx.log(`entegrasyon: ${PROVIDERS.length} bağlantı, platform siparişi yok`);
    return;
  }

  const paid = await paymentsByOrder(db, clientId, src.map(o => o.id));

  /* ----------------------------------------------------------- siparişler */
  let mirrorId = Number(await db.value('SELECT COALESCE(MAX(id),0) FROM np_int_orders')) + 1;
  const mirrors = [];            // in order, for the items/events pass
  const byOrderId = new Map();   // local adisyon -> mirror, for the items pass

  /**
   * Which platform this order came through.
   *
   * The year's mix is narrowed to the platforms the restaurant had SIGNED UP
   * to by that date, and to the ones still working - Migros stops appearing
   * the day its key was refused. Without the first filter a March 2021 order
   * can be drawn as Getir two months before the contract was signed, which is
   * the kind of thing the year-on-year platform report makes obvious.
   */
  const providerFor = (year, date) => {
    const mix = MIX[year] || MIX[2026];
    const live = Object.entries(mix).filter(([k]) => {
      const c = conns.get(k);
      if (!c || date < c.from) return false;
      return k !== 'MIGROS_YEMEK' || date < migrosDied;
    });
    if (!live.length) return null;
    const total = live.reduce((a, [, w]) => a + w, 0);
    let x = r() * total;
    for (const [k, w] of live) { x -= w; if (x <= 0) return conns.get(k); }
    return conns.get(live[0][0]);
  };

  const ids = (p) => {
    if (p.key === 'YEMEKSEPETI') {
      return { order: hex(24), pack: hex(6).toUpperCase(), no: 'q' + digits(8) };
    }
    if (p.key === 'GETIR_YEMEK') return { order: hex(24), pack: '', no: digits(9) };
    if (p.key === 'MIGROS_YEMEK') return { order: digits(10), pack: '', no: 'MY' + digits(8) };
    return { order: digits(9), pack: digits(12), no: digits(10) };
  };

  /* The four payment vocabularies, anchored to what the bill was REALLY paid
     with, so "ONLINE" on the platform card and "nakit" on the adisyon can
     never contradict each other. */
  const payFor = (p, method) => {
    if (method === 'nakit') {
      return p.key === 'UBER_EATS_TGO' ? 'PAY_WITH_ON_DELIVERY'
        : (p.key === 'GETIR_YEMEK' ? 'CASH' : 'CASH_ON_DELIVERY');
    }
    if (method === 'yemek_karti') {
      return p.key === 'UBER_EATS_TGO' ? 'PAY_WITH_ON_DELIVERY_CARD' : 'MEAL_TICKET';
    }
    if (method === 'havale') return p.key === 'UBER_EATS_TGO' ? 'PAY_WITH_CARD' : 'ONLINE';
    /* kredi / banka: at the door on some platforms, online on others */
    if (r() < 0.6) return p.key === 'UBER_EATS_TGO' ? 'PAY_WITH_CARD' : 'ONLINE';
    return p.key === 'UBER_EATS_TGO' ? 'PAY_WITH_ON_DELIVERY_CARD' : 'CREDIT_CARD_ON_DELIVERY';
  };
  const isPrepaid = (t) => /ONLINE|PAY_WITH_CARD|MEAL_TICKET/.test(t) ? 1 : 0;

  /** Mask exactly as ingest.js masks: the mirror never holds a full address. */
  const maskPhone = (s) => s.slice(0, 3) + '•'.repeat(Math.max(3, s.length - 5)) + s.slice(-2);
  const maskName = (f, l) => f + ' ' + (l[0] || '') + '.';

  /** A small, provider-shaped body — the field names each adapter reads. */
  const rawFor = (p, m, lines) => {
    if (p.key === 'UBER_EATS_TGO') {
      return { id: m.external_package_id, supplierId: Number(p.supplier), storeId: p.store,
        orderId: m.external_order_id, orderCode: m.external_no,
        packageStatus: m.provider_status, deliveryType: m.fulfillment_type === 'PICKUP' ? 'STORE' : 'GO',
        storePickupSelected: m.fulfillment_type === 'PICKUP',
        totalPrice: Number(m.provider_total),
        payment: { paymentType: m.payment_type, onDelivery: m.is_prepaid ? null : 'CASH' },
        lines: lines.map((l, i) => ({ productId: 300000 + i, name: l.name,
          unitSellingPrice: l.unit, price: l.total,
          items: Array.from({ length: l.qty }, () => ({ packageItemId: digits(10) })) })),
        userInformation: { appName: m.source_application },
        packageCreationDate: Date.parse(m.provider_created_at.replace(' ', 'T')),
        lastModifiedDate: Date.parse(m.provider_modified_at.replace(' ', 'T')) };
    }
    if (p.key === 'YEMEKSEPETI') {
      return { token: m.external_order_id, code: m.external_no, shortCode: m.external_package_id,
        status: m.provider_status, createdAt: m.provider_created_at,
        expeditionType: m.fulfillment_type === 'PICKUP' ? 'pickup' : 'delivery',
        platformRestaurant: { id: p.store },
        payment: { type: m.payment_type, status: m.is_prepaid ? 'paid' : 'pending' },
        price: { grandTotal: String(m.provider_total), deliveryFees: [{ value: String(m.delivery_charge) }] },
        products: lines.map((l, i) => ({ id: 'P' + (1000 + i), name: l.name,
          quantity: String(l.qty), unitPrice: String(l.unit), paidPrice: String(l.total),
          selectedToppings: [] })),
        comments: { customerComment: m.customer_note || '' } };
    }
    if (p.key === 'GETIR_YEMEK') {
      return { id: m.external_order_id, confirmationId: m.external_no, status: Number(m.provider_status),
        restaurant: { id: p.store }, deliveryType: m.fulfillment_type === 'PICKUP' ? 'SELF' : 'GETIR',
        paymentMethod: m.payment_type, isScheduled: false,
        totalPrice: Number(m.provider_total), deliveryFee: Number(m.delivery_charge),
        products: lines.map((l, i) => ({ id: hex(24), name: l.name, count: l.qty,
          price: l.unit, totalPrice: l.total, optionCategories: [] })),
        clientNote: m.customer_note || '' };
    }
    return { orderId: m.external_order_id, orderNumber: m.external_no, status: m.provider_status,
      restaurantId: p.store, restaurantGroupId: p.chain,
      fulfillmentType: m.fulfillment_type, paymentType: m.payment_type,
      totalPrice: Number(m.provider_total), deliveryCharge: Number(m.delivery_charge),
      items: lines.map((l, i) => ({ itemId: 'MI' + digits(8), name: l.name, quantity: l.qty,
        unitPrice: l.unit, totalPrice: l.total, options: [] })),
      customerNote: m.customer_note || '' };
  };

  /* Two of tonight's are still working so the Canlı sekmesi has rows, but
     never more than half of the day - a demo whose every platform order of the
     day is still "Hazırlanıyor" is a demo of a kitchen that has stopped. */
  const todayTotal = src.filter(o => o.date === todayStr).length;
  const liveQuota = Math.min(2, Math.max(1, Math.floor(todayTotal / 2)));
  let todaySeen = 0;
  let live = 0;
  for (const o of src) {
    const p = providerFor(o.year, o.date);
    if (!p) continue;               // January 2020: not listed anywhere yet
    const isToday = o.date === todayStr;
    if (isToday) todaySeen++;
    const closed = new Date(o.closed_at.replace(' ', 'T'));
    const received = new Date(closed.getTime() - between(35, 75) * 60000);
    const accepted = new Date(received.getTime() + between(1, 5) * 60000);

    let state = 'DELIVERED';
    if (isToday && live < liveQuota && todaySeen > todayTotal - liveQuota) {
      state = ['PREPARING', 'RECEIVED'][live]; live++;
    }

    const method = (paid.get(o.id) || {}).top || 'nakit';
    const payType = payFor(p, method);
    const prepaid = isPrepaid(payType);
    const fulfillment = r() < 0.07 ? 'PICKUP'
      : (p.key === 'UBER_EATS_TGO' && r() < 0.12 ? 'RESTAURANT_COURIER' : 'PLATFORM_COURIER');
    const x = ids(p);
    const first = pick(D.FIRST), last = pick(D.LAST);
    const id = mirrorId++;

    const m = {
      id, client_id: clientId, branch_id: 1, connection_id: p.id, order_id: o.id,
      provider: p.key, provider_store_id: p.store,
      external_order_id: x.order, external_package_id: x.pack, external_no: x.no,
      source_application: p.key === 'UBER_EATS_TGO'
        ? pick(['Trendyol', 'TrendyolGo', 'Galaxy']) : p.source,
      provider_status: p.status[RANK.indexOf(state)],
      status: state, acceptance_mode: p.acceptance,
      fulfillment_type: fulfillment, payment_type: payType, is_prepaid: prepaid,
      provider_total: money(o.grand),
      /* The platform's courier is paid by the platform; only a pickup or a
         restaurant-courier order carries a fee we would ever see. */
      delivery_charge: fulfillment === 'RESTAURANT_COURIER' ? money(between(2, 8) * 5) : 0,
      promotion_total: r() < 0.12 ? money(between(2, 12) * 5) : 0,
      coupon_total: r() < 0.06 ? money(between(2, 10) * 5) : 0,
      promotions_json: null,
      customer_label: maskName(first, last),
      customer_phone: maskPhone('0' + pick(['530', '532', '535', '541', '544', '505', '555']) +
        digits(7)),
      address_label: pick(DISTRICTS) + ' / Antalya',
      customer_note: r() < 0.22 ? pick(CUSTOMER_NOTES) : null,
      scheduled_at: null,
      prep_minutes: p.prep + between(-5, 10),
      reject_reason: null, cancel_reason: null,
      raw_json: null, normalized_json: null,
      unmapped_count: 0,
      accept_print_job_id: null, cancel_print_job_id: null,
      reprint_count: r() < 0.03 ? 1 : 0,
      provider_created_at: dt(received), provider_modified_at: dt(closed),
      received_at: dt(received),
      accepted_at: state === 'RECEIVED' ? null : dt(accepted),
      closed_at: state === 'DELIVERED' ? dt(closed) : null,
      last_event_at: dt(state === 'DELIVERED' ? closed : accepted),
      synced_at: p.transport === 'polling' ? dt(closed) : null,
      updated_at: dt(state === 'DELIVERED' ? closed : accepted),
    };
    if (Number(m.promotion_total)) {
      m.promotions_json = JSON.stringify([{ name: pick(['Yeni üye indirimi',
        'Kampanya: 2. üründe %20', 'Sepette 50 TL indirim']), amount: Number(m.promotion_total) }]);
    }
    mirrors.push({ m, p, lines: null });
    byOrderId.set(o.id, mirrors[mirrors.length - 1]);
  }

  /* --------------------------------------------- reddedilen ve iptaller */
  /* No adisyon on any of these - see the note at the top of this file. */
  const refused = [];
  const refusedCount = Math.round(mirrors.length * 0.045);
  for (let i = 0; i < refusedCount; i++) {
    const base = mirrors[Math.floor(r() * mirrors.length)];
    if (!base) break;
    const p = base.p;
    const received = new Date(base.m.received_at.replace(' ', 'T'));
    const ended = new Date(received.getTime() + between(2, 14) * 60000);
    const rejected = r() < 0.55;
    const [code, label] = pick(REJECTS);
    const x = ids(p);
    const state = rejected ? 'REJECTED' : 'CANCELLED';
    refused.push({
      m: {
        id: mirrorId++, client_id: clientId, branch_id: 1, connection_id: p.id, order_id: null,
        provider: p.key, provider_store_id: p.store,
        external_order_id: x.order, external_package_id: x.pack, external_no: x.no,
        source_application: base.m.source_application,
        provider_status: p.status[RANK.indexOf(state)],
        status: state, acceptance_mode: p.acceptance,
        fulfillment_type: 'PLATFORM_COURIER', payment_type: pick(p.pay),
        is_prepaid: 0, provider_total: money(between(18, 90) * 10),
        delivery_charge: 0, promotion_total: 0, coupon_total: 0, promotions_json: null,
        customer_label: maskName(pick(D.FIRST), pick(D.LAST)),
        customer_phone: maskPhone('0532' + digits(7)),
        address_label: pick(DISTRICTS) + ' / Antalya', customer_note: null,
        scheduled_at: null, prep_minutes: null,
        reject_reason: rejected ? code : null,
        cancel_reason: rejected ? label : pick(CANCELS),
        raw_json: null, normalized_json: null, unmapped_count: 0,
        accept_print_job_id: null, cancel_print_job_id: null, reprint_count: 0,
        provider_created_at: dt(received), provider_modified_at: dt(ended),
        received_at: dt(received), accepted_at: null, closed_at: dt(ended),
        last_event_at: dt(ended), synced_at: p.transport === 'polling' ? dt(ended) : null,
        updated_at: dt(ended),
      },
      p, lines: [],
    });
  }

  /* ------------------------------------------------- satırlar, aynadan */
  /* The mirror lines are the BILL's lines: the platform sold what the kitchen
     cooked, and a demo where the two lists differ is a demo where the
     "eşleşmemiş ürün" warning means nothing. Read in blocks of five hundred
     adisyon - one query per block rather than one per order. */
  const itemRows = [];
  if (haveItems) {
    const orderIds = Array.from(byOrderId.keys());
    for (let i = 0; i < orderIds.length; i += 500) {
      const slice = orderIds.slice(i, i + 500);
      const rows = await db.query(
        `SELECT oi.id, oi.order_id, oi.product_id, oi.qty, oi.unit_price, oi.line_total, p.name
           FROM order_items oi
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE oi.client_id=? AND oi.is_deleted=0 AND oi.order_id IN (` +
        slice.map(() => '?').join(',') + ') ORDER BY oi.id', [clientId, ...slice]);
      for (const row of rows) {
        const entry = byOrderId.get(Number(row.order_id));
        if (!entry) continue;
        if (!entry.lines) entry.lines = [];
        const qty = Math.max(1, Math.round(Number(row.qty)));
        const unit = money(row.unit_price);
        const line = { name: row.name || 'Ürün', qty, unit, total: money(row.line_total) };
        entry.lines.push(line);
        itemRows.push({
          client_id: clientId, int_order_id: entry.m.id, order_item_id: row.id,
          external_item_id: entry.p.key === 'UBER_EATS_TGO' ? digits(10) : 'P' + row.id,
          external_name: line.name, product_id: row.product_id,
          qty, unit_price: unit, line_total: line.total,
          role: 'item', status: 'ACTIVE', mapped: 1, created_at: entry.m.received_at,
        });
      }
    }
    /* A restaurant-courier order carries the delivery charge as its own line,
       exactly as ingest.js writes it. */
    for (const entry of mirrors) {
      if (!Number(entry.m.delivery_charge)) continue;
      itemRows.push({
        client_id: clientId, int_order_id: entry.m.id, order_item_id: null,
        external_item_id: 'FEE', external_name: 'Teslimat ücreti', product_id: null,
        qty: 1, unit_price: entry.m.delivery_charge, line_total: entry.m.delivery_charge,
        role: 'fee', status: 'ACTIVE', mapped: 1, created_at: entry.m.received_at,
      });
    }
  }

  /* raw_json / normalized_json can only be built once the lines are known. */
  for (const entry of mirrors.concat(refused)) {
    const lines = entry.lines && entry.lines.length ? entry.lines
      : [{ name: 'Adana Kebap', qty: 1, unit: money(entry.m.provider_total), total: money(entry.m.provider_total) }];
    const raw = rawFor(entry.p, entry.m, lines);
    entry.m.raw_json = JSON.stringify(raw);
    entry.m.normalized_json = JSON.stringify({
      provider: entry.p.key, externalOrderId: entry.m.external_order_id,
      externalPackageId: entry.m.external_package_id, externalNo: entry.m.external_no,
      providerStoreId: entry.p.store, sourceApplication: entry.m.source_application,
      providerStatus: entry.m.provider_status, status: entry.m.status,
      fulfillmentType: entry.m.fulfillment_type, paymentType: entry.m.payment_type,
      isPrepaid: !!entry.m.is_prepaid, providerTotal: Number(entry.m.provider_total),
      deliveryCharge: Number(entry.m.delivery_charge),
      promotionTotal: Number(entry.m.promotion_total), couponTotal: Number(entry.m.coupon_total),
      customer: { label: entry.m.customer_label, phone: entry.m.customer_phone,
        address: entry.m.address_label, note: entry.m.customer_note },
      lines: lines.map(l => ({ name: l.name, qty: l.qty, unitPrice: l.unit })),
      providerCreatedAt: entry.m.provider_created_at,
      providerModifiedAt: entry.m.provider_modified_at,
    });
  }

  const all = mirrors.concat(refused);
  await bulk(db, 'np_int_orders', ['id', 'client_id', 'branch_id', 'connection_id', 'order_id',
    'provider', 'provider_store_id', 'external_order_id', 'external_package_id', 'external_no',
    'source_application', 'provider_status', 'status', 'acceptance_mode', 'fulfillment_type',
    'payment_type', 'is_prepaid', 'provider_total', 'delivery_charge', 'promotion_total',
    'coupon_total', 'promotions_json', 'customer_label', 'customer_phone', 'address_label',
    'customer_note', 'scheduled_at', 'prep_minutes', 'reject_reason', 'cancel_reason', 'raw_json',
    'normalized_json', 'unmapped_count', 'accept_print_job_id', 'cancel_print_job_id',
    'reprint_count', 'provider_created_at', 'provider_modified_at', 'received_at', 'accepted_at',
    'closed_at', 'last_event_at', 'synced_at', 'updated_at'], all.map(e => e.m), { ignore: true });
  await bulk(db, 'np_int_order_items', ['client_id', 'int_order_id', 'order_item_id',
    'external_item_id', 'external_name', 'product_id', 'qty', 'unit_price', 'line_total',
    'role', 'status', 'mapped', 'created_at'], itemRows);

  /* ---------------------------------------------------------- olay kuyruğu */
  /*
   * The event queue is a WORKING queue, not an archive: poller.js drains it
   * within the second and nothing prunes it, so a believable one holds the
   * last few weeks and not seven years. Older orders keep their mirror and
   * their log line; only the raw envelopes are gone.
   */
  let events = 0, logs = 0;
  const eventRows = [];
  const logRows = [];
  let seq = 0;
  const recent = all.filter(e => e.m.received_at >= ymd(addDays(ctx.today, -180)));
  for (const entry of recent) {
    const p = entry.p;
    const trail = entry.m.status === 'DELIVERED'
      ? ['RECEIVED', 'ACCEPTED', 'PREPARING', 'DISPATCHED', 'DELIVERED']
      : (entry.m.status === 'RECEIVED' ? ['RECEIVED'] : ['RECEIVED', entry.m.status]);
    const start = new Date(entry.m.received_at.replace(' ', 'T'));
    trail.forEach((s, i) => {
      const at = new Date(start.getTime() + i * between(4, 12) * 60000);
      /* One envelope in forty is still stuck, which is what the ölü mektup
         shelf on the Olaylar sekmesi is for. */
      const stuck = r() < 0.025;
      eventRows.push({
        client_id: clientId, provider: p.key,
        source: p.transport === 'webhook' ? 'webhook' : 'poll',
        event_key: (p.transport === 'webhook' ? 'webhook:' : 'poll:') + hex(24) + (seq++).toString(16),
        event_type: p.status[RANK.indexOf(s)],
        provider_store_id: p.store, external_order_id: entry.m.external_order_id,
        external_package_id: entry.m.external_package_id,
        signature_ok: 1,
        payload: JSON.stringify({ order: { externalOrderId: entry.m.external_order_id,
          externalPackageId: entry.m.external_package_id, providerStatus: p.status[RANK.indexOf(s)],
          providerModifiedAt: dt(at) }, __branchId: 1 }),
        status: stuck ? (r() < 0.4 ? 'dead' : 'failed') : 'done',
        attempts: stuck ? between(3, 6) : 1,
        last_error: stuck ? pick(['Adisyon açılamadı: ürün eşleşmedi',
          'Zaman aşımı: platform yanıt vermedi', 'Geçersiz durum geçişi']) : null,
        created_at: dt(at),
        processed_at: stuck ? null : dt(new Date(at.getTime() + between(1, 4) * 1000)),
      });
      events++;
    });
  }

  /* ------------------------------------------------------------- günlükler */
  /* The log is what support reads, so it is weighted the way support reads it:
     everything for the last fortnight, a thinning sample going back. */
  const logFrom = ymd(addDays(ctx.today, -700));
  for (const entry of all) {
    if (entry.m.received_at < logFrom) continue;
    const days = Math.round((ctx.today - new Date(entry.m.received_at.slice(0, 10) + 'T00:00:00')) / 86400000);
    const keep = days <= 30 ? 1 : (days <= 180 ? 0.5 : 0.18);
    if (r() > keep) continue;
    const p = entry.p;
    const at = entry.m.received_at;
    const short = p.label;
    logRows.push({ client_id: clientId, provider: p.key, branch_id: 1, level: 'info',
      action: 'create', order_id: entry.m.order_id, external_order_id: entry.m.external_order_id,
      message: `${short} siparişi alındı · ${entry.m.external_no}`,
      detail: null, actor: 'entegrasyon', created_at: at });
    if (entry.m.status === 'REJECTED') {
      logRows.push({ client_id: clientId, provider: p.key, branch_id: 1, level: 'warn',
        action: 'cancel', order_id: null, external_order_id: entry.m.external_order_id,
        message: 'Onaydan önce reddedildi: ' + (entry.m.cancel_reason || '-'),
        detail: null, actor: 'kasa', created_at: entry.m.closed_at });
    } else if (entry.m.status === 'CANCELLED') {
      logRows.push({ client_id: clientId, provider: p.key, branch_id: 1, level: 'warn',
        action: 'cancel', order_id: null, external_order_id: entry.m.external_order_id,
        message: 'Platform iptali: ' + (entry.m.cancel_reason || '-'),
        detail: null, actor: 'platform', created_at: entry.m.closed_at });
    } else {
      logRows.push({ client_id: clientId, provider: p.key, branch_id: 1, level: 'info',
        action: 'accept', order_id: entry.m.order_id, external_order_id: entry.m.external_order_id,
        message: p.acceptance === 'PROVIDER_TABLET'
          ? 'Tablette onaylandı, kasada açıldı'
          : `Kasadan onaylandı · hazırlama ${entry.m.prep_minutes} dk`,
        detail: null, actor: 'kasa', created_at: entry.m.accepted_at || at });
      if (r() < 0.5) {
        logRows.push({ client_id: clientId, provider: p.key, branch_id: 1, level: 'info',
          action: 'print', order_id: entry.m.order_id, external_order_id: entry.m.external_order_id,
          message: 'Mutfak fişi kuyruğa alındı', detail: null, actor: 'entegrasyon',
          created_at: entry.m.accepted_at || at });
      }
      if (entry.m.is_prepaid) {
        logRows.push({ client_id: clientId, provider: p.key, branch_id: 1, level: 'info',
          action: 'payment', order_id: entry.m.order_id, external_order_id: entry.m.external_order_id,
          message: 'Önden ödenmiş sipariş, adisyon kapatıldı',
          detail: null, actor: 'entegrasyon', created_at: entry.m.closed_at || at });
      }
    }
  }

  /* The lines that are about the CONNECTION rather than an order: the poll
     that found nothing, the key that stopped working, the menu that went up. */
  for (const p of PROVIDERS) {
    const c = conns.get(p.key);
    logRows.push({ client_id: clientId, provider: p.key, branch_id: 1, level: 'info',
      action: 'connection', order_id: null, external_order_id: null,
      message: 'Bağlantı oluşturuldu · ortam: simulator', detail: null,
      actor: 'Erdal Sarıkaya', created_at: p.from + ' 10:00:00' });
    logRows.push({ client_id: clientId, provider: p.key, branch_id: 1, level: 'info',
      action: 'menu', order_id: null, external_order_id: null,
      message: 'Menü platforma gönderildi · ' + ctx.products.length + ' ürün',
      detail: null, actor: 'Nurcan Aydın', created_at: p.from + ' 11:20:00' });
    for (let i = 0; i < 26; i++) {
      const at = addDays(ctx.today, -between(0, 30));
      const day = ymd(at);
      if (day < p.from) continue;
      logRows.push({ client_id: clientId, provider: p.key, branch_id: 1, level: 'info',
        action: 'poll', order_id: null, external_order_id: null,
        message: `Sorgu tamam · ${between(0, 4)} yeni paket`, detail: null, actor: null,
        created_at: dt(atTime(at, between(11, 23), between(0, 59))) });
    }
    if (c.dead) {
      logRows.push({ client_id: clientId, provider: p.key, branch_id: 1, level: 'error',
        action: 'test', order_id: null, external_order_id: null,
        message: 'Bağlantı testi başarısız: Restoran API anahtarı reddedildi (401)',
        detail: null, actor: 'Erdal Sarıkaya', created_at: migrosDied + ' 13:44:02' });
      logRows.push({ client_id: clientId, provider: p.key, branch_id: 1, level: 'warn',
        action: 'connection', order_id: null, external_order_id: null,
        message: 'Bağlantı kapatıldı', detail: null, actor: 'Erdal Sarıkaya',
        created_at: migrosDied + ' 13:45:10' });
    } else {
      logRows.push({ client_id: clientId, provider: p.key, branch_id: 1, level: 'info',
        action: 'test', order_id: null, external_order_id: null,
        message: 'Bağlantı testi başarılı: simülasyon kipinde çalışıyor',
        detail: null, actor: 'Erdal Sarıkaya', created_at: c.dead ? migrosDied : todayStr + ' 09:12:00' });
    }
  }
  logs = logRows.length;

  if (haveEvents) {
    await bulk(db, 'np_int_events', ['client_id', 'provider', 'source', 'event_key', 'event_type',
      'provider_store_id', 'external_order_id', 'external_package_id', 'signature_ok', 'payload',
      'status', 'attempts', 'last_error', 'created_at', 'processed_at'], eventRows, { ignore: true });
  } else { events = 0; }
  if (haveLogs) {
    await bulk(db, 'np_int_logs', ['client_id', 'provider', 'branch_id', 'level', 'action',
      'order_id', 'external_order_id', 'message', 'detail', 'actor', 'created_at'], logRows);
  } else { logs = 0; }

  ctx.log(`entegrasyon: ${PROVIDERS.length} bağlantı, ` +
    `${all.length.toLocaleString('tr-TR')} platform siparişi ` +
    `(${refused.length} red/iptal), ${itemRows.length.toLocaleString('tr-TR')} satır, ` +
    `${events.toLocaleString('tr-TR')} olay, ${logs.toLocaleString('tr-TR')} günlük satırı`);
}

module.exports = { build };
