'use strict';
/**
 * PAKET SERVİS — the restaurant's own delivery, seven years of it.
 *
 * Bölgeler, kuryeler, kurye vardiyaları, paket siparişleri ve durum geçmişi.
 * The bills already exist: trading.js closed every one of them and handed the
 * takeaway ones over in ctx.deliveryOrders. This part only writes the half a
 * delivery has that a table does not — where it went, who carried it, and how
 * much of the restaurant's cash was in that person's jacket at midnight.
 *
 * THE ONE DECISION WORTH EXPLAINING: where the cancellations come from.
 *
 * modules/delivery.js is explicit that cancelling a delivery REVERSES the
 * bill - the adisyon is struck out, the stock comes back, the payments stop
 * counting. So a seeded CANCELLED card sitting on top of a bill that is still
 * closed and still paid would be the exact bug that module's own comment
 * warns about: the screen says the money was reversed and the Z report says
 * it was taken. Rather than write that, the cancellations are attached to the
 * bills trading ALREADY struck out - the one-in-three-hundred deleted
 * takeaway adisyon, which has no payments and is excluded from the reports.
 * The İptal sebepleri table on the paket raporu then has rows in it and not a
 * lira moves anywhere it should not.
 *
 * Same reasoning, smaller: cash_collected_minor is never invented. It is read
 * back out of order_payments, so "kuryenin üzerindeki nakit" is the same money
 * the shift and the Z report are counting, which is the whole point of the
 * settlement screen.
 */
const { bulk, ymd, dt, addDays, atTime, money, minor } = require('../lib');
const { priceIndex } = require('../catalogue');
const D = require('../data');

/* What a zone costs beyond the customer-facing fee D.DELIVERY_ZONES carries:
   the basket minimum and what the courier is paid for the drop, both in 2026
   lira and both deflated per year exactly like the menu. */
const ZONE_EXTRA = {
  'Kaleiçi':   { min: 0,   courier: 20 },
  'Muratpaşa': { min: 250, courier: 30 },
  'Konyaaltı': { min: 400, courier: 45 },
  'Lara':      { min: 450, courier: 50 },
  'Kepez':     { min: 350, courier: 40 },
};

/* [hired, left, own per-drop rate] against D.COURIERS, in order. A courier
   list that is identical in 2020 and 2026 is the tell-tale of generated data,
   and "bu kurye ne zaman ayrıldı" is a question the screen has to answer. */
const COURIER_TENURE = [
  ['2020-01-01', null, null],          // Serkan, from the first day
  ['2021-06-14', '2024-05-31', null],  // Yasin, left - the inactive one
  ['2023-03-06', null, null],          // Ufuk
  ['2024-09-02', null, 35],            // Cihan works to his own rate
];

/* The codes modules/delivery.js groups the cancellation report by. Repeated
   here rather than required: pulling that module in would drag print, payments
   and the whole till into a seeder. */
const CANCEL_CODES = [
  ['MUSTERI_VAZGECTI', 'Müşteri telefonla vazgeçti'],
  ['MUSTERI_VAZGECTI', 'Sipariş yanlış alındı, müşteri iptal etti'],
  ['ADRES_BULUNAMADI', 'Adres bulunamadı, müşteriye ulaşılamadı'],
  ['ODEME_YOK', 'Kapıda ödeme yapılmadı'],
  ['MUTFAK', 'Mutfak yetiştiremedi'],
  ['KURYE_YOK', 'Kurye bulunamadı, yoğunluk'],
  ['SAHTE', 'Sahte sipariş, telefon kapalı'],
  ['DIGER', 'Yağmur nedeniyle teslimat yapılamadı'],
];

const DELIVERY_NOTES = ['Zile basmayın, bebek uyuyor', 'Çatal bıçak istemiyoruz',
  'Bol acılı olsun', 'Ayranları soğuk olsun', 'Fişi poşete koyun',
  'Kapıya bırakın, arayın', 'Para üstü hazır olsun', 'Sos ayrı gelsin'];

const SHIFT_NOTES = ['Kasa tamam', 'Bir sipariş nakit eksik geldi',
  'Akşam yoğunluğu, geç kapandı', 'Motor arızası, 1 saat duruldu', null, null, null];

const GSM = ['530', '532', '533', '535', '536', '538', '541', '542', '544', '545',
  '505', '506', '551', '553', '555'];

/** Tables this database actually has — later migrations bring some of these. */
async function tableSet(db) {
  const rows = await db.query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=DATABASE()');
  return new Set(rows.map(r => String(r.t)));
}

/**
 * What each bill was actually paid with, straight out of order_payments.
 *
 * Read in blocks rather than one bill at a time: five thousand single-row
 * SELECTs is a minute of a demo install doing nothing visible.
 */
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
      const cur = out.get(id) || { top: null, topAmount: 0, cash: 0 };
      const amount = Number(row.amount) || 0;
      if (amount > cur.topAmount) { cur.top = String(row.method); cur.topAmount = amount; }
      if (row.method === 'nakit') cur.cash += amount;
      out.set(id, cur);
    }
  }
  return out;
}

/* order_payments speaks the till's vocabulary; delivery_orders.payment_method
   speaks the door's (see delivery_door_methods in modules/delivery.js). */
function doorMethod(m) {
  if (m === 'nakit') return 'nakit';
  if (m === 'yemek_karti') return 'yemek_karti';
  if (m === 'havale') return 'havale';
  return 'kredi_karti';
}

async function build(ctx) {
  const { db, clientId, rand: r } = ctx;
  const pick = (a) => a[Math.floor(r() * a.length)];
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));

  const have = await tableSet(db);
  if (!have.has('delivery_orders') || !have.has('delivery_zones') || !have.has('couriers')) {
    ctx.log('paket servis: tablolar yok, bölüm atlandı');
    return;
  }

  const todayStr = ymd(ctx.today);
  const openedAt = dt(atTime(ctx.start, 9, 0));

  /* ------------------------------------------------------------- bölgeler */
  const zones = [];
  for (let i = 0; i < D.DELIVERY_ZONES.length; i++) {
    const [name, fee, minutes] = D.DELIVERY_ZONES[i];
    const extra = ZONE_EXTRA[name] || { min: 250, courier: 30 };
    const id = await db.insert(
      `INSERT INTO delivery_zones (client_id, name, fee, min_order, est_minutes, is_default,
          sort_order, is_active, created_at, courier_fee) VALUES (?,?,?,?,?,?,?,1,?,?)`,
      [clientId, name, money(fee), money(extra.min), minutes, fee === 0 ? 1 : 0, i,
       openedAt, money(extra.courier)]);
    zones.push({ id, name, fee, minutes, min: extra.min, courier: extra.courier });
  }
  const _zoneByName = new Map(zones.map(z => [z.name, z]));

  /* ------------------------------------------------------------- kuryeler */
  const couriers = [];
  for (let i = 0; i < D.COURIERS.length; i++) {
    const [name, phone] = D.COURIERS[i];
    const [from, to, own] = COURIER_TENURE[i] || ['2020-01-01', null, null];
    const id = await db.insert(
      `INSERT INTO couriers (client_id, user_id, name, phone, is_active, created_at, fee_per_delivery)
       VALUES (?,NULL,?,?,?,?,?)`,
      [clientId, name, phone, to ? 0 : 1, from + ' 09:30:00', own === null ? null : money(own)]);
    couriers.push({ id, name, from, to, own });
  }

  /* --------------------------------------------------- adreslerin bölgesi */
  /* guests.js writes the addresses before the zones exist, so every one of
     them lands with zone_id NULL. The district it picked is the zone name, so
     the join is a name match and five statements rather than 143. */
  let zoned = 0;
  if (have.has('customer_addresses')) {
    for (const z of zones) {
      zoned += Number(await db.exec(
        'UPDATE customer_addresses SET zone_id=? WHERE client_id=? AND district=? AND zone_id IS NULL',
        [z.id, clientId, z.name])) || 0;
    }
    /* Anything the guests part spelled differently still needs a bölge, or it
       is an address the paket ekranı cannot price. */
    await db.exec('UPDATE customer_addresses SET zone_id=? WHERE client_id=? AND zone_id IS NULL',
      [zones[0].id, clientId]);
  }

  const addresses = have.has('customer_addresses') ? await db.query(
    `SELECT a.id, a.customer_id, a.zone_id, a.address_text, a.directions,
            c.first_name, c.last_name, c.phone
       FROM customer_addresses a
       JOIN customers c ON c.id = a.customer_id
      WHERE a.client_id=? AND a.is_active=1`, [clientId]) : [];
  const zoneById = new Map(zones.map(z => [z.id, z]));

  /* --------------------------------------------------------- kara liste */
  /* A guest list with nobody flagged is a guest list whose "engellendi"
     warning nobody has ever seen work. */
  let flagged = 0;
  if (have.has('customer_flags') && addresses.length) {
    const already = Number(await db.value(
      'SELECT COUNT(*) FROM customer_flags WHERE client_id=?', [clientId])) || 0;
    if (!already) {
      const seen = new Set();
      const rows = [];
      for (let i = 0; i < 11 && i < addresses.length; i++) {
        const a = addresses[Math.floor(r() * addresses.length)];
        if (seen.has(a.customer_id)) continue;
        seen.add(a.customer_id);
        const block = r() < 0.35;
        const at = dt(addDays(ctx.today, -between(20, 900)));
        const cleared = !block && r() < 0.4;
        rows.push({
          client_id: clientId, customer_id: a.customer_id,
          level: block ? 'block' : 'watch',
          reason: block
            ? pick(['Üç kez kapıda ödeme yapmadı', 'Sahte sipariş geçmişi',
                    'Kuryeye hakaret etti', 'Sipariş verip teslim almadı'])
            : pick(['Sürekli adres değiştiriyor', 'İki kez kapıyı açmadı',
                    'Ödeme tartışması çıktı', 'Geç saatte tekrar tekrar arıyor']),
          created_by: ctx.users.nurcan.id, created_at: at,
          cleared_at: cleared ? dt(addDays(new Date(at.slice(0, 10) + 'T00:00:00'), between(5, 60))) : null,
          cleared_by: cleared ? ctx.users.erdal.id : null,
        });
      }
      await bulk(db, 'customer_flags', ['client_id', 'customer_id', 'level', 'reason',
        'created_by', 'created_at', 'cleared_at', 'cleared_by'], rows);
      flagged = rows.length;
    }
  }

  /* ------------------------------------------------------- the deliveries */
  const src = (ctx.deliveryOrders || []).slice();
  if (!src.length) {
    ctx.log(`paket servis: ${zones.length} bölge, ${couriers.length} kurye, sipariş yok`);
    return;
  }

  const paid = await paymentsByOrder(db, clientId, src.map(o => o.id));
  const posShiftByDate = new Map((ctx.dayIndex || []).map(d => [d.date, d.shift_id]));

  const byDate = new Map();
  for (const o of src) {
    if (!byDate.has(o.date)) byDate.set(o.date, []);
    byDate.get(o.date).push(o);
  }
  const dates = Array.from(byDate.keys()).sort();

  /* Auto-increment ids claimed up front: the events and the shifts both have
     to point at rows that have not been written yet, and reading each id back
     one insert at a time is ten thousand round trips. */
  let deliveryId = Number(await db.value('SELECT COALESCE(MAX(id),0) FROM delivery_orders')) + 1;
  let shiftId = Number(await db.value('SELECT COALESCE(MAX(id),0) FROM courier_shifts')) + 1;
  const firstShiftId = shiftId;

  /* The status trail is kept to the last eighteen months plus a thin slice of
     everything older: four events on every one of five thousand deliveries is
     twenty thousand rows nobody scrolls to, and the geçmiş panel only ever
     shows one order at a time. */
  const trailFrom = ymd(addDays(ctx.today, -548));

  const B = { orders: [], events: [], shifts: [] };
  const flush = async () => {
    await bulk(db, 'courier_shifts', ['id', 'client_id', 'courier_id', 'business_date', 'pos_shift_id',
      'opened_at', 'opened_by', 'closed_at', 'closed_by', 'cash_expected_minor', 'cash_taken_minor',
      'variance_minor', 'deliveries', 'note', 'earned_minor'], B.shifts);
    await bulk(db, 'delivery_orders', ['id', 'client_id', 'order_id', 'business_date', 'source',
      'int_order_id', 'customer_id', 'address_id', 'zone_id', 'customer_name', 'phone',
      'address_text', 'directions', 'delivery_fee', 'status', 'courier_id', 'courier_shift_id',
      'is_prepaid', 'payment_method', 'cash_collected_minor', 'promised_minutes', 'note',
      'created_by', 'created_at', 'assigned_at', 'dispatched_at', 'delivered_at', 'cancelled_at',
      'cancel_reason', 'updated_at', 'courier_fee', 'change_for_minor', 'scheduled_at',
      'cancel_code'], B.orders);
    await bulk(db, 'delivery_events', ['client_id', 'delivery_id', 'from_status', 'to_status',
      'courier_id', 'actor_id', 'actor_name', 'note', 'created_at'], B.events);
    B.orders = []; B.events = []; B.shifts = [];
  };

  let liveCards = 0;
  let openShifts = 0;

  for (const date of dates) {
    const day = new Date(date + 'T00:00:00');
    const year = day.getFullYear();
    const idx = priceIndex(year);
    const isToday = date === todayStr;
    const dayOrders = byDate.get(date).slice().sort((a, b) => a.closed_at < b.closed_at ? -1 : 1);

    const cashier = (ctx.cashiers.filter(u => u.from <= date && (!u.to || u.to >= date))[0])
      || ctx.users.erdal;

    /* Who was on a motorcycle that night. One courier covers about four drops
       before a second is worth calling in, which is why most of 2020 is one
       man and August 2026 is three. */
    const roster = couriers.filter(k => k.from <= date && (!k.to || k.to >= date));
    if (!roster.length) continue;
    const wanted = Math.max(1, Math.min(roster.length, Math.ceil(dayOrders.length / 4)));
    const pool = roster.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const onDuty = pool.slice(0, wanted).map(k => ({
      courier: k, shift: shiftId++, cash: 0, earned: 0, drops: 0,
    }));

    dayOrders.forEach((o, i) => {
      const duty = onDuty[i % onDuty.length];
      const k = duty.courier;

      /* where it went */
      const known = addresses.length && r() < 0.72 ? addresses[Math.floor(r() * addresses.length)] : null;
      const zone = known ? (zoneById.get(known.zone_id) || zones[0]) : pick(zones);
      const name = known ? [known.first_name, known.last_name].filter(Boolean).join(' ')
        : pick(D.FIRST) + ' ' + pick(D.LAST);
      const phone = known ? known.phone : '0' + pick(GSM) + String(between(1000000, 9999999));
      const address = known ? known.address_text
        : pick(D.STREETS) + ' No:' + between(1, 148) +
          (r() < 0.7 ? ' Daire:' + between(1, 22) : '') + ', ' + zone.name + ' / Antalya';

      /* The clock, worked BACKWARDS from the bill: the adisyon closed when the
         courier reported the money in, so that is teslim edildi and the
         kitchen and the road sit before it.
         The promise is the zone's drive time PLUS the kitchen, which is what a
         cashier says on the telephone and what the board's "geç kaldı" flag is
         measured against - promising the drive time alone would paint nine
         cards in ten orange and make the late count meaningless. */
      const delivered = new Date(o.closed_at.replace(' ', 'T'));
      const road = between(Math.max(5, zone.minutes - 6), zone.minutes + 8);
      const dispatched = new Date(delivered.getTime() - road * 60000);
      const assigned = new Date(dispatched.getTime() - between(1, 6) * 60000);
      let created = new Date(assigned.getTime() - between(3, 12) * 60000);
      const earliest = atTime(day, 11, 0);
      if (created < earliest) created = earliest;

      const money0 = paid.get(o.id) || { top: 'nakit', cash: 0 };
      const method = doorMethod(money0.top || 'nakit');
      /* Online ödeme, havale ve kredi kartıyla önden ödenenler kapıda para
         istenmeyecek siparişlerdir. */
      const prepaid = method === 'havale' || (method === 'kredi_karti' && r() < 0.35);

      /* Tonight's last few are still on the board. Never more than half the
         day, so the ekranın "bugün teslim edilen" özeti is not zero on a
         restaurant that has been delivering since noon. */
      const liveQuota = isToday ? Math.min(3, Math.max(1, Math.ceil(dayOrders.length / 2))) : 0;
      const live = isToday && liveCards < liveQuota && i >= dayOrders.length - liveQuota;
      let status = 'DELIVERED';
      if (live) { status = ['PREPARING', 'ON_ROUTE', 'NEW'][liveCards]; liveCards++; }

      const fee = money(Math.round(zone.fee * idx));
      const courierFee = money(Math.round((k.own === null ? zone.courier : k.own) * idx));
      const cashMinor = status === 'DELIVERED' && !prepaid ? minor(money0.cash) : 0;
      const id = deliveryId++;

      if (status === 'DELIVERED') {
        duty.cash += cashMinor;
        duty.earned += minor(courierFee);
        duty.drops++;
      }

      B.orders.push({
        id, client_id: clientId, order_id: o.id, business_date: date,
        source: r() < 0.82 ? 'PHONE' : 'COUNTER', int_order_id: null,
        customer_id: known ? known.customer_id : null,
        address_id: known ? known.id : null, zone_id: zone.id,
        customer_name: name, phone,
        address_text: address.slice(0, 400),
        directions: known ? known.directions : (r() < 0.3 ? 'Sokağın sonundaki apartman' : null),
        delivery_fee: o.grand > fee * 4 ? fee : 0,
        status,
        /* A card still in the Yeni lane has not been given to anybody yet -
           that is the whole meaning of the lane, and modules/delivery.js
           refuses "yolda" without a courier for the same reason. */
        courier_id: status === 'NEW' ? null : k.id,
        courier_shift_id: status === 'NEW' ? null : duty.shift,
        is_prepaid: prepaid || live ? 1 : 0,
        payment_method: status === 'DELIVERED' ? method : null,
        cash_collected_minor: cashMinor,
        promised_minutes: zone.minutes + 18 + between(-2, 6),
        note: r() < 0.14 ? pick(DELIVERY_NOTES) : null,
        created_by: cashier.id,
        created_at: dt(created),
        assigned_at: status === 'NEW' ? null : dt(assigned),
        dispatched_at: status === 'NEW' || status === 'PREPARING' ? null : dt(dispatched),
        delivered_at: status === 'DELIVERED' ? dt(delivered) : null,
        cancelled_at: null, cancel_reason: null, cancel_code: null,
        updated_at: dt(status === 'DELIVERED' ? delivered : created),
        courier_fee: status === 'NEW' ? 0 : courierFee,
        /* para üstü: only worth recording when the guest said a round number */
        change_for_minor: !prepaid && method === 'nakit' && r() < 0.22
          ? Math.ceil((o.grand + 50) / 50) * 5000 : 0,
        scheduled_at: null,
      });

      if (date >= trailFrom || r() < 0.12) {
        const trail = [[null, 'NEW', created], ['NEW', 'PREPARING', assigned],
          ['PREPARING', 'ON_ROUTE', dispatched], ['ON_ROUTE', 'DELIVERED', delivered]];
        const upto = { NEW: 1, PREPARING: 2, ON_ROUTE: 3, DELIVERED: 4 }[status];
        for (let s = 0; s < upto; s++) {
          const [from, to, at] = trail[s];
          B.events.push({
            client_id: clientId, delivery_id: id, from_status: from, to_status: to,
            courier_id: to === 'NEW' ? null : k.id, actor_id: cashier.id, actor_name: cashier.name,
            note: to === 'PREPARING' ? 'Kurye: ' + k.name : null, created_at: dt(at),
          });
        }
      }
    });

    /* -------------------------------------------------- kurye vardiyaları */
    for (const duty of onDuty) {
      const opened = atTime(day, between(11, 12), between(0, 55));
      const closed = atTime(day, 23, between(30, 58));
      /* One courier is still out tonight, so the paket ekranı has somebody on
         shift and the "kasaya teslim al" button has something to do. */
      const stayOpen = isToday && openShifts < 1;
      if (stayOpen) openShifts++;
      /* The jacket is rarely exactly right, and mostly it is. */
      const variance = r() < 0.72 ? 0 : (r() < 0.45 ? -1 : 1) * between(1, 40) * 100;
      B.shifts.push({
        id: duty.shift, client_id: clientId, courier_id: duty.courier.id, business_date: date,
        pos_shift_id: posShiftByDate.get(date) || null,
        opened_at: dt(opened), opened_by: cashier.id,
        closed_at: stayOpen ? null : dt(closed), closed_by: stayOpen ? null : cashier.id,
        cash_expected_minor: stayOpen ? 0 : duty.cash,
        cash_taken_minor: stayOpen ? 0 : duty.cash + variance,
        variance_minor: stayOpen ? 0 : variance,
        deliveries: stayOpen ? 0 : duty.drops,
        note: stayOpen ? null : (variance ? 'Kasa farkı var' : pick(SHIFT_NOTES)),
        earned_minor: stayOpen ? 0 : duty.earned,
      });
    }

    if (B.orders.length > 1500) await flush();
  }
  await flush();

  /* ------------------------------------------------------------- iptaller */
  /* The bills trading already struck out - see the note at the top of this
     file. They carry no payments and are excluded from the reports, so a
     cancelled delivery on top of one is a cancellation that cost nothing
     twice. */
  const voided = await db.query(
    `SELECT o.id, o.business_date, o.opened_at, o.closed_at
       FROM orders o
       LEFT JOIN delivery_orders d ON d.order_id = o.id AND d.client_id = o.client_id
      WHERE o.client_id=? AND o.is_deleted=1 AND o.table_id IS NULL AND d.id IS NULL
      ORDER BY o.business_date`, [clientId]);

  for (const v of voided) {
    const date = ymd(new Date(v.business_date));
    const year = Number(date.slice(0, 4));
    const idx = priceIndex(year);
    const zone = pick(zones);
    const cashier = (ctx.cashiers.filter(u => u.from <= date && (!u.to || u.to >= date))[0])
      || ctx.users.erdal;
    const roster = couriers.filter(k => k.from <= date && (!k.to || k.to >= date));
    const created = new Date(String(v.opened_at).replace(' ', 'T'));
    const cancelled = new Date(created.getTime() + between(6, 40) * 60000);
    const [code, reason] = pick(CANCEL_CODES);
    const id = deliveryId++;
    B.orders.push({
      id, client_id: clientId, order_id: v.id, business_date: date,
      source: r() < 0.8 ? 'PHONE' : 'COUNTER', int_order_id: null,
      customer_id: null, address_id: null, zone_id: zone.id,
      customer_name: pick(D.FIRST) + ' ' + pick(D.LAST),
      phone: '0' + pick(GSM) + String(between(1000000, 9999999)),
      address_text: (pick(D.STREETS) + ' No:' + between(1, 148) + ', ' + zone.name +
        ' / Antalya').slice(0, 400),
      directions: null,
      delivery_fee: money(Math.round(zone.fee * idx)),
      status: 'CANCELLED',
      courier_id: null, courier_shift_id: null,
      is_prepaid: 0, payment_method: null, cash_collected_minor: 0,
      promised_minutes: zone.minutes, note: null,
      created_by: cashier.id, created_at: dt(created),
      assigned_at: null, dispatched_at: null, delivered_at: null,
      cancelled_at: dt(cancelled), cancel_reason: reason, cancel_code: code,
      updated_at: dt(cancelled),
      courier_fee: 0, change_for_minor: 0, scheduled_at: null,
    });
    if (date >= trailFrom || r() < 0.3) {
      const who = roster.length ? pick(roster) : null;
      B.events.push({ client_id: clientId, delivery_id: id, from_status: null, to_status: 'NEW',
        courier_id: null, actor_id: cashier.id, actor_name: cashier.name, note: null,
        created_at: dt(created) });
      B.events.push({ client_id: clientId, delivery_id: id, from_status: 'NEW',
        to_status: 'CANCELLED', courier_id: who ? who.id : null, actor_id: cashier.id,
        actor_name: cashier.name, note: reason, created_at: dt(cancelled) });
    }
  }
  await flush();

  const deliveries = src.length + voided.length;
  ctx.log(`paket servis: ${zones.length} bölge, ${couriers.length} kurye, ` +
    `${(shiftId - firstShiftId).toLocaleString('tr-TR')} kurye vardiyası, ` +
    `${deliveries.toLocaleString('tr-TR')} paket sipariş ` +
    `(${voided.length} iptal), ${zoned} adres bölgelendi, ${flagged} müşteri işaretlendi`);
}

module.exports = { build };
