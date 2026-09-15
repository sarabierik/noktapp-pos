'use strict';
/**
 * MİSAFİR, SADAKAT, REZERVASYON.
 *
 * The three screens a restaurant owner opens second - after the money - and
 * the three that are blank on a fresh till: the guest list, the stamp cards,
 * and the reservation book. This part fills all of them, and links a slice of
 * the seven years of bills to the guests who ate them so that "bu müşteri ne
 * kadar harcadı" answers with something.
 *
 * The one non-obvious decision: a card's counters are DERIVED from its events,
 * never invented. modules/loyalty.js keeps progress_count strictly below the
 * target and pushes the overflow into rewards_available, so a seeded card
 * sitting at 14 on a 10-stamp programme is a card the cashier can never make
 * sense of - the next stamp scanned against it jumps to a number nobody can
 * explain. The stamps are generated first and the card is the sum of them.
 * Same reason the birthday programme has a target of 1: the schema counts
 * stamps and nothing else, so a birthday ikram is one stamp and one reward on
 * the same evening rather than a points scheme this database cannot store.
 */
const crypto = require('crypto');
const { bulk, ymd, dt, addDays, atTime, eachDay } = require('../lib');
const { SEASON, WEEKDAY, covidFactor } = require('../trading');
const D = require('../data');

/* Antalya, and the districts a Kaleiçi kebap house actually delivers to. */
const DISTRICTS = ['Kaleiçi', 'Muratpaşa', 'Konyaaltı', 'Lara', 'Kepez'];
const CENTRE = [36.8841, 30.7056];

/* Real Turkish mobile prefixes - the phone field is what the cashier searches
   on, and 0555 is the only thing anyone types from memory. */
const GSM = ['530', '531', '532', '533', '535', '536', '537', '538', '539',
  '541', '542', '543', '544', '545', '546', '505', '506', '507', '551', '552', '553', '555'];

const MAIL = ['gmail.com', 'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com'];

const RES_NOTES = ['Doğum günü', 'Pencere kenarı', 'Tekerlekli sandalye',
  'Bebek sandalyesi gerekli', 'Sessiz köşe rica edildi', 'Yıldönümü - pasta getirilecek',
  'Bahçe tarafı olsun', 'Vejetaryen misafir var', 'Fatura kesilecek', 'Çocuklu aile',
  'Ocakbaşı önü istendi', 'Geç gelebilirler'];

const RES_CANCEL = ['Misafir iptal etti', 'Hava yağmurlu', 'Uçuş gecikti', 'Tarih değişti'];

/* Turkish letters an e-mail address cannot carry. */
const FOLD = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
const slug = (s) => String(s).toLocaleLowerCase('tr-TR').replace(/[^a-z0-9]/g, (c) => FOLD[c] || '');

/** Tables this database actually has - later migrations bring some of these. */
async function tableSet(db) {
  const rows = await db.query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=DATABASE()');
  return new Set(rows.map(r => String(r.t)));
}

async function build(ctx) {
  const { db, clientId, rand: r } = ctx;
  const pick = (a) => a[Math.floor(r() * a.length)];
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));

  const have = await tableSet(db);
  if (!have.has('customers')) { ctx.log('misafir: customers tablosu yok, bölüm atlandı'); return; }

  const startStr = ymd(ctx.start);
  const todayStr = ymd(ctx.today);
  const span = Math.round((ctx.today - ctx.start) / 86400000);
  const onDuty = (date) => {
    const s = ctx.staff.filter(u => u.from <= date && (!u.to || u.to >= date));
    return s.length ? s : ctx.staff;
  };

  /* ------------------------------------------------------------ misafirler */

  /* Names are drawn from every first/last pairing once, shuffled, so 340
     guests are 340 different people rather than nine Ayşe Kaya. */
  const combos = [];
  for (const f of D.FIRST) for (const l of D.LAST) combos.push([f, l]);
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = combos[i]; combos[i] = combos[j]; combos[j] = t;
  }

  const GUESTS = 340;
  let cid = Number(await db.value('SELECT COALESCE(MAX(id),0) FROM customers')) + 1;
  const firstId = cid;
  const guests = [];
  const custRows = [];
  for (let i = 0; i < GUESTS && i < combos.length; i++) {
    const [first, last] = combos[i];
    /* the sign-up curve leans on the recent years: a guest list that is flat
       across seven years looks generated, and the newest guests are the ones
       the owner is asked about */
    const joined = addDays(ctx.start, Math.min(span, Math.floor(span * Math.pow(r(), 0.62))));
    const joinedAt = atTime(joined, between(11, 23), between(0, 59));
    const hasMail = r() < 0.46;
    const hasBirth = r() < 0.72;
    /* the last seven digits are a counter, so the UNIQUE phone index can
       never be the thing that kills a demo install */
    const phone = '0' + pick(GSM) + String(2100000 + i * 2131);
    const g = {
      id: cid++, first, last, phone,
      joined: ymd(joined),
      joinedAt: dt(joinedAt),
      birth: hasBirth ? (between(1955, 2005) + '-' + String(between(1, 12)).padStart(2, '0') +
        '-' + String(between(1, 28)).padStart(2, '0')) : null,
      tier: 'rare', orders: [],
    };
    guests.push(g);
    custRows.push({
      id: g.id, first_name: first, last_name: last, phone,
      email: hasMail ? slug(first) + '.' + slug(last) + between(0, 99) + '@' + pick(MAIL) : null,
      birth_date: g.birth, password_hash: null,
      qr_uid: crypto.randomBytes(12).toString('hex'),
      is_verified: r() < 0.42 ? 1 : 0,
      is_active: r() < 0.975 ? 1 : 0,
      created_by_client_id: clientId,
      created_at: g.joinedAt, updated_at: g.joinedAt,
    });
  }
  await bulk(db, 'customers', ['id', 'first_name', 'last_name', 'phone', 'email', 'birth_date',
    'password_hash', 'qr_uid', 'is_verified', 'is_active', 'created_by_client_id',
    'created_at', 'updated_at'], custRows, { ignore: true });

  /* INSERT IGNORE can drop a row on a phone this database already holds, and a
     card hanging off a customer id that was never written is a broken screen.
     Carry on with the ids that actually landed. */
  const landed = new Set((await db.query(
    'SELECT id FROM customers WHERE id BETWEEN ? AND ?', [firstId, cid - 1])).map(x => Number(x.id)));
  const roll = guests.filter(g => landed.has(g.id));
  if (!roll.length) { ctx.log('misafir: müşteri yazılamadı, bölüm atlandı'); return; }

  /* --------------------------------------------------- who eats here often */

  /* A restaurant's guest list is Pareto: a handful of müdavim carry it. The
     regulars are drawn from the guests who have been on the books a while,
     because somebody who registered last month cannot be a regular of 2021. */
  roll.sort((a, b) => (a.joined < b.joined ? -1 : a.joined > b.joined ? 1 : a.id - b.id));
  const old = roll.filter(g => g.joined <= '2024-06-30');
  const step = Math.max(1, Math.floor(old.length / 40));
  for (let i = 0, n = 0; i < old.length && n < 40; i += step, n++) old[i].tier = 'regular';
  for (const g of roll) if (g.tier === 'rare' && r() < 0.36) g.tier = 'occasional';

  const WEIGHT = { regular: 14, occasional: 4, rare: 1 };
  const pool = [];
  let gi = 0;
  let linked = 0;
  for (const day of ctx.dayIndex) {
    while (gi < roll.length && roll[gi].joined <= day.date) {
      for (let k = 0; k < WEIGHT[roll[gi].tier]; k++) pool.push(roll[gi]);
      gi++;
    }
    if (!pool.length) continue;
    for (const oid of day.orders) {
      if (r() >= 0.18) continue;                 // the rest paid and left anonymous
      const g = pool[Math.floor(r() * pool.length)];
      g.orders.push({ id: oid, date: day.date });
      linked++;
    }
  }

  /* One statement per guest rather than per bill - 18.000 single-row UPDATEs
     is four minutes of a demo install doing nothing visible. */
  for (const g of roll) {
    for (let i = 0; i < g.orders.length; i += 400) {
      const ids = g.orders.slice(i, i + 400).map(o => o.id);
      await db.exec('UPDATE orders SET customer_id=? WHERE client_id=? AND id IN (' +
        ids.map(() => '?').join(',') + ')', [g.id, clientId, ...ids]);
    }
  }

  /* ------------------------------------------------------------- adresler */
  let addrCount = 0;
  if (have.has('customer_addresses')) {
    const rows = [];
    for (const g of roll) {
      if (r() >= 0.36) continue;                 // ~120 guests ever gave an address
      const n = r() < 0.28 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        rows.push({
          client_id: clientId, customer_id: g.id,
          tag: k === 0 ? 'EV' : (r() < 0.7 ? 'IS' : 'DIGER'),
          zone_id: null,                         // delivery zones are seeded after this part
          district: pick(DISTRICTS),
          address_text: pick(D.STREETS) + ' No:' + between(1, 148) +
            (r() < 0.75 ? ' Daire:' + between(1, 22) : '') + ', Antalya',
          directions: r() < 0.45 ? pick(['Zil çalışmıyor, arayın', 'Market yanı, 3. kat',
            'Apartmanın arka girişi', 'Sokağın sonu, sarı bina', 'Otopark tarafından girilir',
            'Kapıda güvenlik var']) : null,
          lat: (CENTRE[0] + (r() - 0.5) * 0.09).toFixed(7),
          lng: (CENTRE[1] + (r() - 0.5) * 0.12).toFixed(7),
          is_default: k === 0 ? 1 : 0, is_active: r() < 0.94 ? 1 : 0,
          created_at: g.joinedAt, updated_at: g.joinedAt,
        });
      }
    }
    await bulk(db, 'customer_addresses', ['client_id', 'customer_id', 'tag', 'zone_id', 'district',
      'address_text', 'directions', 'lat', 'lng', 'is_default', 'is_active',
      'created_at', 'updated_at'], rows);
    addrCount = rows.length;
  }

  /* ------------------------------------------------------------- sadakat */
  let cardCount = 0, eventCount = 0, rewardCount = 0;
  if (have.has('loyalty_programs') && have.has('loyalty_cards') && have.has('loyalty_events')) {
    const byName = (n) => (ctx.products.find(p => p.name === n) || null);
    const kebap = byName('Adana Kebap');
    const kunefe = byName('Künefe');
    const kahve = byName('Türk Kahvesi');

    const programs = [];
    for (const [product, title, target, reward, from] of [
      [kebap, '10 kebap alana 1 bedava', 10, 'Bir adet Adana Kebap ikram', '2020-02-01'],
      [kunefe, 'Doğum günü ikramı', 1, 'Doğum gününde künefe ikram', '2021-03-01'],
      [kahve, 'Ocakbaşı kahve kartı', 12, 'Bir fincan Türk Kahvesi ikram', '2023-05-01'],
    ]) {
      const id = await db.insert(
        'INSERT INTO loyalty_programs (client_id, product_id, title, target_count, reward_text, ' +
        'is_active, created_at) VALUES (?,?,?,?,?,1,?)',
        [clientId, product ? product.id : null, title, target, reward, from + ' 09:00:00']);
      programs.push({ id, product_id: product ? product.id : null, title, target, from });
    }

    /* the guests who come often enough to carry a card */
    const ranked = roll.slice().sort((a, b) => b.orders.length - a.orders.length);
    const holders = ranked.filter(g => g.orders.length >= 3).slice(0, 110);
    const cards = [];
    const events = [];
    let cardId = Number(await db.value('SELECT COALESCE(MAX(id),0) FROM loyalty_cards')) + 1;

    /** Stamp dates: real visits where the guest has them, walk-ins otherwise. */
    const visitDates = (g, n, notBefore) => {
      const own = g.orders.filter(o => o.date >= notBefore);
      const out = [];
      if (own.length) {
        /* keep the visits in order and thin them out - nobody hands the card
           over every single time */
        const keep = Math.min(n, own.length);
        const skip = own.length / keep;
        for (let i = 0; i < keep; i++) out.push(own[Math.min(own.length - 1, Math.floor(i * skip))]);
      }
      while (out.length < n) {
        const lo = notBefore > g.joined ? notBefore : g.joined;
        const loD = new Date(lo + 'T00:00:00');
        const days = Math.max(1, Math.round((ctx.today - loD) / 86400000));
        out.push({ id: null, date: ymd(addDays(loD, Math.floor(r() * days))) });
      }
      out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      return out;
    };

    /** Write one card and the events that add up to it. */
    const issue = (g, prog, stamps) => {
      if (!stamps.length) return;
      const id = cardId++;
      let total = 0, earned = 0, used = 0;
      const first = stamps[0].date;
      let last = first;
      for (const s of stamps) {
        const staff = onDuty(s.date);
        const qty = r() < 0.12 ? 2 : 1;
        const before = total;
        total += qty;
        events.push({
          client_id: clientId, customer_id: g.id, program_id: prog.id, card_id: id,
          product_id: prog.product_id, order_id: s.id, user_id: pick(staff).id,
          kind: 'stamp', qty, source: s.id ? 'order' : (r() < 0.7 ? 'scan' : 'manual'),
          note: null, created_at: s.date + ' ' + String(between(12, 22)).padStart(2, '0') +
            ':' + String(between(0, 59)).padStart(2, '0') + ':00',
        });
        last = s.date;
        /* every time the counter rolls over the target the guest is owed one,
           and about half of those get spent */
        const crossed = Math.floor(total / prog.target) - Math.floor(before / prog.target);
        for (let k = 0; k < crossed; k++) {
          earned++;
          if (r() >= (prog.target === 1 ? 0.95 : 0.55)) continue;
          const when = ymd(addDays(new Date(s.date + 'T00:00:00'),
            prog.target === 1 ? 0 : between(0, 45)));
          if (when > todayStr) continue;
          used++;
          if (when > last) last = when;
          events.push({
            client_id: clientId, customer_id: g.id, program_id: prog.id, card_id: id,
            product_id: prog.product_id, order_id: null, user_id: pick(onDuty(when)).id,
            kind: 'reward', qty: 1, source: 'manual', note: 'Kart doldu, ikram verildi',
            created_at: when + ' ' + String(between(13, 22)).padStart(2, '0') +
              ':' + String(between(0, 59)).padStart(2, '0') + ':00',
          });
        }
      }
      cards.push({
        id, client_id: clientId, customer_id: g.id, program_id: prog.id,
        progress_count: total % prog.target,
        rewards_available: earned - used, rewards_used: used,
        created_at: first + ' 12:00:00', updated_at: last + ' 21:30:00',
      });
    };

    const [stampProg, birthProg, coffeeProg] = programs;

    for (const g of holders) {
      const n = Math.min(70, Math.max(2, Math.round(g.orders.length * (0.24 + r() * 0.18))));
      issue(g, stampProg, visitDates(g, n, stampProg.from));
      if (r() < 0.34) {
        const c = Math.min(28, Math.max(2, Math.round(g.orders.length * (0.06 + r() * 0.08))));
        issue(g, coffeeProg, visitDates(g, c, coffeeProg.from));
      }
    }
    /* and a few guests who only ever picked up the card, never filled it */
    for (const g of ranked.slice(110)) {
      if (r() >= 0.08) continue;
      issue(g, stampProg, visitDates(g, between(1, 6), stampProg.from));
    }

    /* the birthday card: one stamp and one ikram per birthday celebrated here */
    for (const g of holders) {
      if (!g.birth || r() >= 0.30) continue;
      const md = g.birth.slice(5);
      const years = [];
      for (let y = 2021; y <= ctx.today.getFullYear(); y++) {
        const d = y + '-' + md;
        if (d >= birthProg.from && d >= g.joined && d <= todayStr && covidFactor(new Date(d + 'T00:00:00'))) {
          if (r() < 0.55) years.push({ id: null, date: d });
        }
      }
      issue(g, birthProg, years);
    }

    await bulk(db, 'loyalty_cards', ['id', 'client_id', 'customer_id', 'program_id',
      'progress_count', 'rewards_available', 'rewards_used', 'created_at', 'updated_at'],
      cards, { ignore: true });
    await bulk(db, 'loyalty_events', ['client_id', 'customer_id', 'program_id', 'card_id',
      'product_id', 'order_id', 'user_id', 'kind', 'qty', 'source', 'note', 'created_at'], events);
    cardCount = cards.length;
    eventCount = events.length;
    rewardCount = events.filter(e => e.kind === 'reward').length;

    /* the QR the guest shows at the till: short-lived by design, so only a
       couple are still alive and the rest are spent history */
    if (have.has('loyalty_qr_tokens')) {
      const toks = [];
      for (let i = 0; i < 12; i++) {
        const g = pick(holders.length ? holders : roll);
        const live = i < 3;
        const made = live
          ? new Date(Date.now() - between(10, 200) * 1000)
          : atTime(addDays(ctx.today, -between(1, 400)), between(12, 22), between(0, 59));
        const exp = new Date(made.getTime() + 5 * 60000);
        toks.push({
          token: crypto.randomBytes(32).toString('hex'), customer_id: g.id,
          expires_at: dt(exp), expires_ts: Math.floor(exp.getTime() / 1000),
          used_at: live ? null : dt(new Date(made.getTime() + between(20, 200) * 1000)),
          used_by_client_id: live ? null : clientId, created_at: dt(made),
        });
      }
      await bulk(db, 'loyalty_qr_tokens', ['token', 'customer_id', 'expires_at', 'expires_ts',
        'used_at', 'used_by_client_id', 'created_at'], toks, { ignore: true });
    }
  }

  /* --------------------------------------------------------- rezervasyon */
  let resCount = 0;
  if (have.has('reservations') && ctx.tables.length) {
    const ordersByDate = new Map();
    for (const d of ctx.dayIndex) if (d.orders.length) ordersByDate.set(d.date, d.orders);

    /* The book runs three months past today on purpose: the owner wants to see
       next week's bookings, and a reservation screen that ends at today is a
       reservation screen nobody believes. */
    const horizon = addDays(ctx.today, 92);
    const candidates = eachDay(ctx.start, horizon).filter(d => covidFactor(d) > 0);
    const busy = new Map();                      // 'tableId|date' -> [[startMs,endMs]]
    const rows = [];

    const bookOne = (day, forceFuture) => {
      const date = ymd(day);
      const hour = r() < 0.22 ? pick([12, 13]) : pick([19, 19, 20, 20, 20, 21, 21, 22]);
      const starts = atTime(day, hour, pick([0, 0, 30]));
      const dur = pick([90, 120, 120, 150]);
      const future = date > todayStr || (date === todayStr && starts.getHours() >= 21);

      /* a party is put on a table it fits - the floor screen refuses anything
         else, and a booking for nine on a two-top is the kind of demo data
         that gets pointed at */
      let table = null, party = between(2, 8);
      for (let t = 0; t < 8; t++) {
        const c = pick(ctx.tables);
        const key = c.id + '|' + date;
        const list = busy.get(key) || [];
        const s = starts.getTime(), e = s + dur * 60000;
        if (list.some(([a, b]) => s < b && e > a)) continue;
        if (c.seats < 2) continue;
        table = c; busy.set(key, list.concat([[s, e]]));
        party = between(Math.max(1, c.seats - 2), c.seats);
        break;
      }

      const eligible = roll.filter(g => g.joined <= date);
      const known = eligible.length && r() < 0.68 ? pick(eligible) : null;
      const name = known ? known.first + ' ' + known.last
        : pick(D.FIRST) + ' ' + pick(D.LAST);
      const phone = known ? known.phone : '0' + pick(GSM) + String(between(1000000, 9999999));

      let status, seatedAt = null, seatedBy = null, orderId = null;
      if (future || forceFuture) {
        status = r() < 0.93 ? 'booked' : 'cancelled';
      } else if (date === todayStr) {
        status = r() < 0.5 ? 'seated' : 'done';
      } else {
        const x = r();
        status = x < 0.82 ? 'done' : x < 0.92 ? 'cancelled' : 'noshow';
      }
      if (status === 'done' || status === 'seated') {
        const staff = onDuty(date);
        seatedAt = dt(new Date(starts.getTime() + between(-5, 25) * 60000));
        seatedBy = pick(staff).id;
        const dayOrders = ordersByDate.get(date);
        if (status === 'done' && dayOrders && r() < 0.35) orderId = pick(dayOrders);
      }

      /* booked a few days ahead, and never before the restaurant existed */
      let madeOn = addDays(day, -between(1, 21));
      if (ymd(madeOn) < startStr) madeOn = new Date(ctx.start.getTime());
      const made = atTime(madeOn, between(10, 21), between(0, 59));

      rows.push({
        client_id: clientId, table_id: table ? table.id : null, guest_name: name,
        guest_phone: phone, party_size: party, starts_at: dt(starts), duration_min: dur,
        status, note: r() < 0.34 ? (status === 'cancelled' ? pick(RES_CANCEL) : pick(RES_NOTES)) : null,
        order_id: orderId, created_by: pick(onDuty(ymd(made))).id, created_at: dt(made),
        updated_at: dt(made), seated_at: seatedAt, seated_by: seatedBy,
      });
    };

    /* the season decides when people book, exactly as it decides when they
       walk in - August is full and February is not */
    const peak = Math.max(...SEASON) * Math.max(...WEEKDAY);
    let guard = 0;
    while (rows.length < 800 && guard < 40000) {
      guard++;
      const day = pick(candidates);
      if (r() > SEASON[day.getMonth()] * WEEKDAY[day.getDay()] / peak) continue;
      bookOne(day, false);
    }
    /* The next three months get a deliberate top-up rather than whatever the
       season weighting happens to leave there. The forward book is the whole
       point of the screen, and September to December is Antalya's quiet half
       - left to the weighting, the demo opens on an empty week. */
    for (let i = 0; i < 70; i++) bookOne(addDays(ctx.today, between(1, 92)), true);
    /* and the handful somebody booked a long way out - a wedding, a new year */
    for (let i = 0; i < 30; i++) bookOne(addDays(ctx.today, between(100, 480)), true);

    await bulk(db, 'reservations', ['client_id', 'table_id', 'guest_name', 'guest_phone',
      'party_size', 'starts_at', 'duration_min', 'status', 'note', 'order_id', 'created_by',
      'created_at', 'updated_at', 'seated_at', 'seated_by'], rows);
    resCount = rows.length;
  }

  /* ------------------------------------------------------------ crm görev */
  if (have.has('crm_tasks')) {
    const nurcan = ctx.users.nurcan, erdal = ctx.users.erdal;
    const sevim = ctx.users.sevim || nurcan;
    const TASKS = [
      ['Müdavim listesini gözden geçir', 'Son 3 ayda hiç gelmeyen sadakat kartı sahiplerini ara.', -26, 'followup', nurcan, 1],
      ['Doğum günü mesajları', 'Bu ay doğum günü olan misafirlere kutlama mesajı gönderilecek.', -12, 'kutlama', sevim, 1],
      ['Bayram rezervasyon planı', 'Bayram akşamı için salon ve bahçe kapasitesi ayrılacak.', -8, 'genel', erdal, 1],
      ['Kaybolan kart şikayeti', 'Kart numarası okunmayan misafire yeni QR çıkarılacak.', -5, 'followup', sevim, 1],
      ['Google yorumlarına cevap', 'Son 20 yoruma cevap yazılacak.', -3, 'genel', nurcan, 1],
      ['Kurumsal müşteri teklifi', 'Yandaki otel için grup menüsü fiyatı hazırlanacak.', -2, 'teklif', erdal, 1],
      ['Sadakat kartı afişi', 'Girişe ve masalara yeni kart afişi asılacak.', 1, 'genel', sevim, 0],
      ['Yıldönümü rezervasyonu teyidi', 'Cumartesi 20:00 rezervasyonu için pasta siparişi teyit edilecek.', 2, 'followup', nurcan, 0],
      ['Gelmeyen misafirleri ara', 'Geçen hafta gelmeyen 4 rezervasyon aranacak.', 3, 'arama', sevim, 0],
      ['Menü fiyat güncellemesi', 'Et fiyatları arttı, ocakbaşı grubu yeniden fiyatlanacak.', 5, 'genel', erdal, 0],
      ['Toplu SMS izni', 'İzinli müşteri listesi güncellenecek, izinsizler çıkarılacak.', 7, 'genel', nurcan, 0],
      ['Kart doldu bildirimi', 'Ödülü bekleyen 18 misafire haber verilecek.', 9, 'followup', sevim, 0],
      ['Personel eğitimi - rezervasyon', 'Yeni garsonlara rezervasyon ekranı anlatılacak.', 12, 'egitim', erdal, 0],
      ['Yılbaşı menüsü duyurusu', 'Sadakat kartı sahiplerine önce duyurulacak.', 21, 'kutlama', nurcan, 0],
    ];
    const rows = TASKS.map(([title, detail, offset, kind, who, done]) => {
      const due = addDays(ctx.today, offset);
      const made = addDays(due, -between(3, 18));
      return {
        client_id: clientId, title, detail, due_on: ymd(due),
        assigned_to: who.name, kind,
        done_at: done ? dt(atTime(addDays(due, -between(0, 2)), between(11, 19), between(0, 59))) : null,
        done_by: done ? who.name : null,
        created_by: erdal.name, created_at: dt(atTime(made, between(9, 18), between(0, 59))),
      };
    });
    await bulk(db, 'crm_tasks', ['client_id', 'title', 'detail', 'due_on', 'assigned_to', 'kind',
      'done_at', 'done_by', 'created_by', 'created_at'], rows);
  }

  ctx.log(`misafir: ${roll.length} müşteri, ${linked.toLocaleString('tr-TR')} adisyon eşleşti, ` +
    `${addrCount} adres, ${cardCount} sadakat kartı, ` +
    `${eventCount.toLocaleString('tr-TR')} sadakat hareketi (${rewardCount} ikram), ` +
    `${resCount} rezervasyon`);
}

module.exports = { build };
