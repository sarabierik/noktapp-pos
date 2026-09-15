'use strict';
/**
 * STOK ve FİYATLANDIRMA - the depot behind the kitchen, and the pricing desk.
 *
 * Seven years of buying, counting, wasting and consuming raw materials, plus
 * the recipes that tie a plate of Adana to the lamb it is made of, plus a
 * pricing inbox with something in it.
 *
 * The one decision worth explaining is how the ledger is balanced. Stock level
 * is not a stored number anywhere - `inventory.levels` derives it, every time,
 * as SUM(quantity_in) - SUM(quantity_out) over the whole ledger. So the seeder
 * cannot "set" today's stock; it has to ARRIVE at it, and it has to arrive
 * without the running balance passing through zero on the way, because a depot
 * holding minus four hundred bottles of water in August 2023 is not a history
 * anybody can be shown.
 *
 * The obvious way to arrive at it is to scale consumption: work out what the
 * kitchen must have used for the arithmetic to end where you want it, and
 * spread that over seven years. It does not work, and the reason is worth
 * writing down, because it is not obvious and it cost a day. Consumption
 * scaled to the closing figure is consumption defined by how much was BOUGHT -
 * so every extra kilo delivered is immediately matched by a kitchen that is
 * said to have eaten faster. No delivery, however early or however large, ever
 * builds a buffer; the level between two deliveries is the same whatever you
 * do, and it is under zero.
 *
 * So the rate is fixed independently instead. The kitchen uses a set fraction
 * of each ingredient's typical holding per week of actual service, deliveries
 * are sized against that same rate a month ahead of it, and the difference
 * between where seven years of that lands and the figure today's screen should
 * show - a couple of weeks' worth, no more - is worked off across the closing
 * season. The closing figure is near the typical holding for most ingredients
 * and deliberately under the critical level for five perishables, so the
 * "kritik stok" screen has rows on it rather than a congratulatory blank.
 *
 * Two smaller ones:
 *
 *  - Consumption is posted twice a week in one row per ingredient, not one row
 *    per sold line. A row per line would be a quarter of a million ledger rows
 *    to say what six thousand say just as well, and the ledger screen is read
 *    by a chef scrolling a month, not by an auditor.
 *
 *  - The restaurant existed before 2020. Every ingredient opens with a
 *    'Açılış devri' adjustment on day one; without it the first fortnight of
 *    the ledger runs at or below zero, which is not what a going concern
 *    looks like.
 */
const { bulk, ymd, dt, addDays, atTime, eachDay, money } = require('../lib');
const D = require('../data');
const { priceIndex } = require('../catalogue');

/* ------------------------------------------------------------ the depot */

/* database/03_seed.sql already writes the first six at install, in this
   spelling. Repeating them here rather than assuming they are there keeps the
   demo self-contained, and INSERT IGNORE means the installed rows win. */
const INV_UNITS = ['Adet', 'Kilogram', 'Gram', 'Litre', 'Mililitre', 'Paket', 'Bağ', 'Kutu'];
const INV_CATS = ['Et', 'Sebze', 'Bakliyat', 'Süt', 'İçecek', 'Sarf'];
const LOCATIONS = ['Ana Depo', 'Mutfak', 'Bar'];

/* `inventory_items.unit` is a fixed ENUM the till arithmetic understands; the
   Turkish words in `inventory_units` are only what the dropdown prints. "bağ"
   and "kutu" have no enum of their own, so they land on the nearest countable
   one rather than inventing a value the module would reject. */
const UNIT_ENUM = { kg: 'kg', lt: 'lt', adet: 'pcs', paket: 'pack', 'bağ': 'pcs', kutu: 'pack' };

/* Who sells what, how often they call, and a tax number each - `suppliers`
   carries UNIQUE(client_id, vkn) and the column defaults to '', so five
   suppliers with no tax number would collide down to one.
   `share` is how often that supplier gets one of the two weekly deliveries. It
   tracks the SIZE of his catalogue, not how interesting his goods are: a man
   with ten lines to rotate through has to call more often than one with four
   for each of his lines to arrive as regularly, and an ingredient that only
   turns up every six weeks runs out between deliveries however much of it
   arrives on the day. */
const SUPPLIER_META = [
  { cats: ['Et', 'Süt'], share: 0.27, vkn: '3450012901', mail: 'siparis@antalyaetsut.com.tr' },
  { cats: ['Sebze'], share: 0.23, vkn: '8720034512', mail: 'hal@torossebze.com' },
  { cats: ['İçecek'], share: 0.18, vkn: '1190087734', mail: 'bayi@akdenizicecek.com.tr' },
  { cats: ['Bakliyat'], share: 0.16, vkn: '6031129045', mail: 'satis@guneyun.com' },
  { cats: ['Sarf'], share: 0.16, vkn: '2408871163', mail: 'info@kaleicitemizlik.com' },
];

/* A week of service uses about a third of the typical holding, so the depot
   turns over roughly every three weeks - which is what D.INGREDIENTS' typical
   and critical levels imply when you divide one by the other. LEAD_DAYS is how
   far ahead each delivery is bought; it has to exceed the interval between two
   deliveries of the same line or the item runs dry waiting for the lorry. */
const WEEKLY_USE = 0.32;
const LEAD_DAYS = 42;
const MIN_LEAD_WEEKS = 3;
const OPENING_STOCK = 1.0;

/* How many of the best sellers get a costed recipe. */
const TOP_SELLERS_COSTED = 22;

/* Cleaning and packaging carry the full rate; food does not. */
const PURCHASE_VAT = { 'Sarf': 20, 'İçecek': 10 };

/* The five that are allowed to run out. Perishables and a consumable nobody
   remembers to order - picked by name rather than at random so the kritik
   list is the same list every time the demo is shown. */
const RUNS_LOW = ['Kuzu ciğer', 'Roka', 'Tereyağı', 'Maydanoz', 'Poşet'];

/* `inventory.recordWaste` validates the reason against a fixed code list and
   prints its own Turkish label, so the code goes in `reason` and the human
   sentence in `note` - a Turkish string in `reason` would be rejected by the
   screen that writes the next one. */
const WASTE_REASONS = [
  ['spoiled', 'Soğuk hava deposunda bozulma'],
  ['spoiled', 'Son kullanma tarihi geçti'],
  ['broken', 'Kırılma - kasa düşürüldü'],
  ['broken', 'Nakliyede döküldü'],
  ['kitchen', 'Yanlış hazırlama'],
  ['kitchen', 'Ocakta yandı'],
  ['staff', 'Personel yemeği'],
  ['other', 'Servis firesi'],
];

/* --------------------------------------------------------- the recipes */
/* Per portion, in the ingredient's own unit. Charcoal is on the grill dishes
   because it is the cost a kebap house actually watches and the one an owner
   asks about when he sees the stock screen for the first time. */
const RECIPES = {
  'Adana Kebap': [['Kuzu kıyma', 0.18], ['Soğan', 0.05], ['Sivri biber', 0.04], ['Un', 0.06], ['Kömür', 0.30]],
  'Urfa Kebap': [['Kuzu kıyma', 0.18], ['Soğan', 0.06], ['Sivri biber', 0.02], ['Un', 0.06], ['Kömür', 0.30]],
  'Kuzu Şiş': [['Kuzu but', 0.22], ['Soğan', 0.04], ['Sivri biber', 0.03], ['Kömür', 0.32]],
  'Tavuk Şiş': [['Tavuk göğüs', 0.22], ['Soğan', 0.04], ['Sivri biber', 0.03], ['Kömür', 0.28]],
  'Kaburga': [['Kuzu but', 0.28], ['Soğan', 0.04], ['Kömür', 0.35]],
  'Ciğer Şiş': [['Kuzu ciğer', 0.20], ['Soğan', 0.05], ['Maydanoz', 0.05], ['Kömür', 0.28]],
  'Beyti Sarma': [['Kuzu kıyma', 0.18], ['Un', 0.09], ['Yoğurt', 0.08], ['Tereyağı', 0.02], ['Kömür', 0.30]],
  'Karışık Izgara': [['Kuzu kıyma', 0.12], ['Kuzu but', 0.12], ['Tavuk göğüs', 0.10], ['Kuzu ciğer', 0.06], ['Kömür', 0.45]],
  'Patlıcan Kebap': [['Kuzu kıyma', 0.14], ['Patlıcan', 0.25], ['Domates', 0.05], ['Kömür', 0.30]],
  'Kanat (8 adet)': [['Tavuk kanat', 0.45], ['Sivri biber', 0.03], ['Kömür', 0.25]],
  'Köfte (6 adet)': [['Kuzu kıyma', 0.20], ['Soğan', 0.05], ['Un', 0.02], ['Kömür', 0.28]],
  'Antrikot (250 gr)': [['Dana kuşbaşı', 0.26], ['Tereyağı', 0.02], ['Kömür', 0.30]],
  'Kıymalı Pide': [['Un', 0.18], ['Kuzu kıyma', 0.09], ['Domates', 0.04], ['Sivri biber', 0.02]],
  'Kaşarlı Pide': [['Un', 0.18], ['Kaşar peyniri', 0.10], ['Tereyağı', 0.01]],
  'Kuşbaşılı Kaşarlı Pide': [['Un', 0.18], ['Dana kuşbaşı', 0.10], ['Kaşar peyniri', 0.07]],
  'Lahmacun': [['Un', 0.08], ['Kuzu kıyma', 0.04], ['Domates', 0.03], ['Maydanoz', 0.03]],
  'Etli Ekmek': [['Un', 0.20], ['Kuzu kıyma', 0.09], ['Sivri biber', 0.02]],
  'Sucuklu Yumurtalı Pide': [['Un', 0.18], ['Kaşar peyniri', 0.05], ['Domates', 0.03]],
  'Mercimek Çorbası': [['Kırmızı mercimek', 0.09], ['Soğan', 0.03], ['Un', 0.01], ['Tereyağı', 0.01]],
  'Ezogelin Çorbası': [['Kırmızı mercimek', 0.07], ['Bulgur', 0.03], ['Soğan', 0.03], ['Tereyağı', 0.01]],
  'Haydari': [['Yoğurt', 0.18], ['Maydanoz', 0.03]],
  'Acılı Ezme': [['Domates', 0.12], ['Sivri biber', 0.06], ['Soğan', 0.04], ['Maydanoz', 0.02]],
  'Muhammara': [['Sivri biber', 0.10], ['Un', 0.03]],
  'Sigara Böreği (6 adet)': [['Un', 0.10], ['Kaşar peyniri', 0.07], ['Maydanoz', 0.02]],
  'Zeytinyağlı Yaprak Sarma': [['Pirinç', 0.08], ['Soğan', 0.03], ['Limon', 0.02]],
  'Patlıcan Söğürme': [['Patlıcan', 0.30], ['Domates', 0.05], ['Sivri biber', 0.03]],
  'Çoban Salata': [['Domates', 0.12], ['Salatalık', 0.10], ['Soğan', 0.04], ['Sivri biber', 0.03]],
  'Gavurdağı Salata': [['Domates', 0.14], ['Soğan', 0.05], ['Maydanoz', 0.03]],
  'Roka Salata': [['Roka', 0.09], ['Domates', 0.06], ['Limon', 0.03]],
  'Mevsim Salata': [['Domates', 0.10], ['Salatalık', 0.08], ['Roka', 0.04]],
  'Söğüş Tabağı': [['Domates', 0.08], ['Salatalık', 0.08], ['Sivri biber', 0.04]],
  'Ayran (30 cl)': [['Ayran (30 cl)', 1]],
  'Şalgam': [['Şalgam', 1]],
  'Kola (33 cl)': [['Kola (33 cl)', 1]],
  'Soda': [['Soda', 1]],
  'Su (50 cl)': [['Su (50 cl)', 1]],
  'Çay': [['Çay', 0.004]],
  'Limonata': [['Limon', 0.15]],
  'Künefe': [['Kaşar peyniri', 0.10], ['Tereyağı', 0.04], ['Un', 0.05]],
  'Sütlaç': [['Süt', 0.25], ['Pirinç', 0.04]],
  'Kazandibi': [['Süt', 0.25], ['Un', 0.03]],
  'Dondurma (2 top)': [['Süt', 0.10]],
  'Kadayıf': [['Un', 0.08], ['Tereyağı', 0.05]],
  'Fıstıklı Baklava (4 dilim)': [['Un', 0.08], ['Tereyağı', 0.06]],
};

/* Target margin by menu category. Drinks and starters carry the house; a
   mixed grill at 720 TL cannot, and pretending otherwise makes the pricing
   screen suggest a 900 TL kebap. */
const MARGIN_TARGET = {
  'Başlangıçlar': 70, 'Ocakbaşı': 58, 'Pide ve Lahmacun': 64,
  'Salata ve Meze': 72, 'İçecekler': 66, 'Tatlılar': 65,
};

const SUGGESTION_REASONS = [
  'Son 90 günde maliyet %12 arttı, satış adedi sabit kaldı.',
  'Hedef marjın 6 puan altında; küçük bir zam talebi düşürmez.',
  'Bu üründe marj hedefin üzerinde, fiyat düşürülerek adet artırılabilir.',
  'Aynı kategorideki diğer ürünlere göre marj düşük kalıyor.',
  'Malzeme maliyeti son alış faturalarında yükseldi.',
  'Satış adedi yüksek, küçük bir fiyat artışı cirodaki etkisi büyük.',
  'Porsiyon maliyeti reçeteden hesaplandı, mevcut fiyat maliyeti zor karşılıyor.',
  'Sezon sonu: talep düşerken fiyatın sabit kalması adedi kırıyor.',
];

const REJECT_NOTES = [
  'Müşteri tepkisi olur, şimdilik beklesin.',
  'Menü baskısı yenilenince topluca yapılacak.',
  'Rakip fiyatı aynı seviyede, şimdi zam yapmayalım.',
  'Bu ürün müdavimlerin ürünü, dokunmuyoruz.',
];

/* ------------------------------------------------------------- helpers */

const q3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

/** Tables this schema actually has - some of them arrive with later migrations. */
async function presentTables(db) {
  const rows = await db.query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=DATABASE()');
  return new Set(rows.map(x => String(x.t)));
}

/** Next free auto-increment, claimed up front so children can be linked before insert. */
async function nextId(db, table) {
  return Number(await db.value('SELECT COALESCE(MAX(id),0) FROM `' + table + '`')) + 1;
}

/* ==================================================================== */

async function build(ctx) {
  const { db, clientId, rand: r } = ctx;
  const pick = (a) => a[Math.floor(r() * a.length)];
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));
  const jitter = (lo, hi) => lo + r() * (hi - lo);

  const have = await presentTables(db);
  if (!have.has('inventory_items') || !have.has('inventory_stock_ledger')) {
    ctx.log('stok: bu sürümde stok tabloları yok, atlandı');
    return;
  }

  const skipped = [];
  const opened = ymd(ctx.start) + ' 08:00:00';
  const owner = ctx.users.erdal.id;
  const manager = ctx.users.nurcan.id;
  /* the depot is the manager's job, the counts get the owner's signature */
  const storeKeepers = [manager, ctx.users.sevim.id, owner];

  /* ----------------------------------------------------- units, categories */
  if (have.has('inventory_units')) {
    await bulk(db, 'inventory_units', ['client_id', 'name', 'created_at'],
      INV_UNITS.map(name => ({ client_id: clientId, name, created_at: opened })), { ignore: true });
  } else skipped.push('inventory_units');

  const catId = new Map();
  if (have.has('inventory_categories')) {
    for (const name of INV_CATS) {
      catId.set(name, await db.insert(
        'INSERT INTO inventory_categories (client_id, name, created_at) VALUES (?,?,?)',
        [clientId, name, opened]));
    }
  } else skipped.push('inventory_categories');

  const locId = new Map();
  if (have.has('inventory_locations')) {
    for (const name of LOCATIONS) {
      locId.set(name, await db.insert(
        'INSERT INTO inventory_locations (client_id, name, is_default, is_active, created_at) VALUES (?,?,?,1,?)',
        [clientId, name, name === 'Ana Depo' ? 1 : 0, opened]));
    }
  } else skipped.push('inventory_locations');
  const mainDepot = locId.get('Ana Depo') || null;

  /* --------------------------------------------------------- the suppliers */
  const suppliers = [];
  for (let i = 0; i < D.SUPPLIERS.length; i++) {
    const [name, contact, phone, address] = D.SUPPLIERS[i];
    const meta = SUPPLIER_META[i] || SUPPLIER_META[SUPPLIER_META.length - 1];
    /* the schema has no contact column, and a buyer who rings "Cengiz Bey"
       rather than the switchboard is worth keeping, so he goes on the address */
    const id = await db.insert(
      `INSERT INTO suppliers (client_id, name, vkn, vergi_dairesi, phone, email, address,
          is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,1,?,?)`,
      [clientId, name, meta.vkn, 'Antalya Kurumlar', phone, meta.mail,
       address + '\nYetkili: ' + contact, opened, opened]);
    suppliers.push({ id, name, cats: meta.cats, share: meta.share });
  }

  /* -------------------------------------------------------- the ingredients */
  const items = [];
  for (let i = 0; i < D.INGREDIENTS.length; i++) {
    const [name, unit, cat, costToday, typical, critical] = D.INGREDIENTS[i];
    const id = await db.insert(
      `INSERT INTO inventory_items (client_id, name, sku, barcode, unit, category_id,
          min_qty, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,1,?,?)`,
      [clientId, name, 'MLZ-' + String(i + 1).padStart(3, '0'), null,
       UNIT_ENUM[unit] || 'pcs', catId.get(cat) || null, critical, opened, opened]);
    items.push({
      id, name, unit, cat, costToday, typical, critical,
      /* countable things are never bought or issued by the gram */
      whole: unit === 'adet' || unit === 'paket' || unit === 'kutu' || unit === 'bağ',
    });
  }
  const itemByName = new Map(items.map(it => [it.name, it]));
  const costOn = (it, day) => money(it.costToday * priceIndex(day.getFullYear()));
  const roundQty = (it, v) => (it.whole ? Math.max(1, Math.round(v)) : Math.max(0.1, q3(v)));

  /* ---------------------------------------------------- how busy each day was */
  /*
   * Consumption follows covers, not the calendar. ctx.dayIndex already carries
   * the 2020 lockdowns as days with no bills on them, so a depot that issues
   * nothing through April 2020 falls out of the trading data rather than
   * needing a second copy of the closure dates here.
   */
  const days = eachDay(ctx.start, ctx.today);
  const billsOn = new Map();
  for (const d of (ctx.dayIndex || [])) {
    const n = Array.isArray(d.orders) ? d.orders.length : (Number(d.orders) || 0);
    billsOn.set(d.date, n);
  }
  let totalBills = days.reduce((s, d) => s + (billsOn.get(ymd(d)) || 0), 0);
  /* Run without the trading stage - a part being tested on its own - and every
     day counts the same. One fallback here spares every reader below a guard. */
  if (!totalBills) { for (const d of days) billsOn.set(ymd(d), 1); totalBills = days.length; }

  /* Covers in the week STARTING on `day`. Looking forward rather than back is
     what lets the lorries turn up in the last days of a lockdown instead of a
     week after the doors reopen - which is when the depot needs them, and
     which is the difference between a believable June 2020 and a negative one. */
  const weekAhead = (day) => {
    let n = 0;
    for (let k = 0; k < 7; k++) n += billsOn.get(ymd(addDays(day, k))) || 0;
    return n;
  };
  /** What share of the whole history's covers had been served by the end of `day`. */
  const servedBy = new Map();
  let served = 0;
  for (const d of days) { served += billsOn.get(ymd(d)) || 0; servedBy.set(ymd(d), served / totalBills); }
  /** Same figure, tolerant of a date past the end of the history. */
  const coverBy = (day) => (day >= ctx.today ? 1 : (servedBy.get(ymd(day)) || 0));
  const weeks = days.length / 7;

  /* Stock is issued to the kitchen twice a week. Weighted by that period's
     covers so the shape of the year survives into the stock report. */
  const periods = [];
  let acc = 0;
  for (const day of days) {
    acc += billsOn.get(ymd(day)) || 0;
    if (day.getDay() === 1 || day.getDay() === 4) { periods.push({ day, weight: acc }); acc = 0; }
  }
  if (!periods.length) periods.push({ day: ctx.today, weight: 1 });
  periods[periods.length - 1].weight += acc;
  let periodTotal = periods.reduce((s, p) => s + p.weight, 0);
  if (!periodTotal) { for (const p of periods) p.weight = 1; periodTotal = periods.length; }

  /* ============================================================ purchases */
  /*
   * Two deliveries a week, each from one supplier who only sells what he
   * sells, each line sized in COVERS rather than in days. A fortnight in
   * February and a fortnight in August are the same length and are not the
   * same order, and the month the restaurant was shut is neither: it buys
   * nothing because it serves nobody, which falls out of the trading history
   * instead of needing the lockdown dates copied in here.
   */
  const docBase = await nextId(db, 'inventory_documents');
  const docRows = [], docLineRows = [];
  const inByItem = new Map(items.map(it => [it.id, 0]));
  const lastBuy = new Map();
  const coveredTo = new Map();
  const docSeq = new Map();
  let docId = docBase;

  /*
   * Whose turn it is, decided by a running claim rather than a weighted coin.
   * A coin with p=0.16 on it leaves the dry-goods man uncalled for four months
   * somewhere in seven years - rare per throw, certain over six hundred - and
   * every line he carries goes to nothing in that hole. This gives each
   * supplier exactly his share of the delivery days, evenly spread.
   */
  const claim = new Map(suppliers.map(s => [s.id, r() * s.share]));
  const supplierOn = () => {
    for (const s of suppliers) claim.set(s.id, claim.get(s.id) + s.share);
    const due = suppliers.reduce((a, b) => (claim.get(b.id) > claim.get(a.id) ? b : a));
    claim.set(due.id, claim.get(due.id) - 1);
    return due;
  };

  for (const day of days) {
    if (day.getDay() !== 2 && day.getDay() !== 5) continue;
    /* nothing is delivered to a restaurant that has been shut all week */
    if (!weekAhead(day)) continue;

    const sup = supplierOn();
    const pool = items.filter(it => sup.cats.includes(it.cat));
    if (!pool.length) continue;

    /* The buyer orders what is lowest, not what a dice says: taking the
       longest-unordered lines puts every ingredient on a steady cycle, where
       drawing them at random leaves month-long holes no sane amount of opening
       stock can cover. The count scales with the catalogue for the same
       reason - a ten-line supplier's list has to come round as fast as a
       four-line one's or half of it waits three visits for its turn. */
    const lines = Math.max(3, Math.min(8, pool.length, Math.round(pool.length * 0.55) + between(-1, 1)));
    const chosen = pool.slice()
      .sort((a, b) => (lastBuy.get(a.id) || 0) - (lastBuy.get(b.id) || 0))
      .slice(0, lines);

    const year = day.getFullYear();
    const seq = (docSeq.get(year) || 0) + 1;
    docSeq.set(year, seq);
    const id = docId++;
    const booked = [];
    const servedNow = servedBy.get(ymd(day)) || 0;
    let total = 0;

    for (const it of chosen) {
      /*
       * Buy forward, by the covers the next month will actually bring: enough
       * to carry the item past the next delivery rather than only to replace
       * what has already gone. Three things this is not, each of which was
       * tried and each of which put the ledger under water:
       *   - sized off the LAST gap. Entering the season the last gap is a
       *     quiet one, and a quiet fortnight's worth of mince does not get an
       *     Antalya kitchen through August.
       *   - allowed to move backwards. Coverage that falls when a short gap
       *     follows a long one makes the next delivery re-buy ground already
       *     paid for, and seven years of that drifts badly.
       *   - a cover window alone. On the eve of a lockdown there are no covers
       *     on the far side to buy for, so nothing is ordered and the kitchen
       *     reopens in June on March's leftovers. Hence the floor: three
       *     average weeks are held whatever the window says.
       */
      const wasCovered = coveredTo.get(it.id) || 0;
      const nowCovered = Math.max(wasCovered,
        coverBy(addDays(day, LEAD_DAYS)), servedNow + MIN_LEAD_WEEKS / weeks);
      lastBuy.set(it.id, servedNow);
      coveredTo.set(it.id, nowCovered);
      /* A delivery is never a token amount: when coverage has almost caught up
         the buyer takes a small case anyway rather than 700 grams of mince. */
      const qty = roundQty(it, Math.max(
        it.typical * WEEKLY_USE * weeks * (nowCovered - wasCovered) * jitter(0.92, 1.1),
        it.typical * 0.1));
      const unitPrice = money(costOn(it, day) * jitter(0.94, 1.09));
      const lineTotal = money(qty * unitPrice);
      const vat = PURCHASE_VAT[it.cat] || 10;
      total += lineTotal;
      inByItem.set(it.id, inByItem.get(it.id) + qty);
      docLineRows.push({
        document_id: id, item_id: it.id, raw_name: it.name, quantity: qty, unit: it.unit,
        unit_price: unitPrice, total_price: lineTotal, vat_rate: vat,
        vat_amount: money(lineTotal * vat / (100 + vat)),
        matched_confidence: 100, is_approved: 1,
      });
      /* carried into the timeline below so the ledger row lands in date order */
      booked.push({ item: it, qty, unitPrice });
    }

    docRows.push({
      id, client_id: clientId, supplier_id: sup.id, location_id: mainDepot, type: 'purchase',
      document_no: 'ALS-' + year + '-' + String(seq).padStart(4, '0'),
      document_date: ymd(day), total_amount: money(total), status: 'approved', source: 'manual',
      file_path: null, note: sup.name + ' irsaliyesi', created_by: manager,
      approved_by: manager, approved_at: dt(atTime(day, 9, 10)),
      created_at: dt(atTime(day, 8, 40)),
      /* the ledger needs these back in date order, so they ride on the document */
      _lines: booked,
    });
  }

  /* ================================================================ zayi */
  const wasteBase = have.has('inventory_waste') ? await nextId(db, 'inventory_waste') : 0;
  const wasteRows = [];
  const outByItem = new Map(items.map(it => [it.id, 0]));
  let wasteId = wasteBase;
  if (have.has('inventory_waste')) {
    for (const day of days) {
      /* a handful a month, and only on days the kitchen was actually open */
      if (!billsOn.get(ymd(day))) continue;
      if (r() > 0.17) continue;
      const it = pick(items);
      const [code, note] = pick(WASTE_REASONS);
      const qty = roundQty(it, it.typical * jitter(0.01, 0.05));
      outByItem.set(it.id, outByItem.get(it.id) + qty);
      wasteRows.push({
        id: wasteId++, client_id: clientId, item_id: it.id, location_id: mainDepot,
        quantity: qty, reason: code, note, unit_cost: costOn(it, day),
        created_by: pick(storeKeepers), created_at: dt(atTime(day, between(15, 19), between(0, 59))),
      });
    }
  } else skipped.push('inventory_waste');

  /* ============================================================ transfers */
  /* Two ledger rows that net to zero across the business: the stock has not
     changed, only which cupboard it is in. */
  const transferRows = [];
  if (have.has('inventory_transfers') && locId.size > 1) {
    const kitchen = locId.get('Mutfak'), bar = locId.get('Bar');
    const trBase = await nextId(db, 'inventory_transfers');
    const barItems = items.filter(it => it.cat === 'İçecek');
    const kitchenItems = items.filter(it => it.cat !== 'İçecek' && it.cat !== 'Sarf');
    for (let i = 0; i < 60; i++) {
      const day = days[Math.floor(r() * days.length)];
      if (!billsOn.get(ymd(day))) continue;
      const toBar = r() < 0.4 && bar;
      const it = toBar ? pick(barItems) : pick(kitchenItems);
      if (!it) continue;
      transferRows.push({
        id: 0, client_id: clientId, item_id: it.id,
        from_location_id: mainDepot, to_location_id: toBar ? bar : kitchen,
        quantity: roundQty(it, it.typical * jitter(0.08, 0.25)),
        note: toBar ? 'Bar ikmali' : 'Mutfak ikmali',
        created_by: pick(storeKeepers),
        created_at: dt(atTime(day, between(9, 12), between(0, 59))),
        _day: day, _item: it, _to: toBar ? bar : kitchen,
      });
    }
    /* ids run in date order, because a transfer list sorted by id and one
       sorted by date showing different orders is a bug report waiting to be */
    transferRows.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    transferRows.forEach((t, i) => { t.id = trBase + i; });
  } else if (!have.has('inventory_transfers')) skipped.push('inventory_transfers');

  /* =============================================================== counts */
  /*
   * A full stocktake every three months. Most lines match - a depot where
   * every single line is out by something is a depot nobody counts twice -
   * and the handful that do not are biased short, because shrinkage is.
   */
  const countPlan = [];
  if (have.has('inventory_counts') && have.has('inventory_count_items')) {
    let countId = await nextId(db, 'inventory_counts');
    for (let day = addDays(ctx.start, 85); day <= ctx.today; day = addDays(day, between(84, 95))) {
      const off = new Set();
      const n = between(3, 6);
      while (off.size < n) off.add(items[Math.floor(r() * items.length)].id);
      const varianceOf = new Map();
      for (const id of off) {
        const it = items.find(x => x.id === id);
        const v = roundQty(it, it.typical * jitter(0.01, 0.06)) * (r() < 0.75 ? -1 : 1);
        varianceOf.set(id, q3(v));
      }
      countPlan.push({ id: countId++, day: new Date(day.getTime()), varianceOf });
    }
  } else skipped.push('inventory_counts');

  const countNet = new Map(items.map(it => [it.id, 0]));
  for (const c of countPlan) for (const [id, v] of c.varianceOf) countNet.set(id, countNet.get(id) + v);

  /* ====================================================== the balancing act */
  /*
   * What each ingredient opened with, what it should read today, and how fast
   * the kitchen got from one to the other.
   */
  const opening = new Map();
  const target = new Map();
  const needOut = new Map();
  for (const it of items) {
    opening.set(it.id, roundQty(it, it.typical * OPENING_STOCK));
    target.set(it.id, RUNS_LOW.includes(it.name)
      ? roundQty(it, it.critical * jitter(0.35, 0.8))
      : roundQty(it, it.typical * jitter(0.8, 1.25)));
    /*
     * The kitchen uses what the kitchen uses: the rate is the same one the
     * deliveries were sized against, NOT whatever it takes to hit today's
     * figure. Scaling consumption to land on the target is the obvious move
     * and it is the wrong one - it feeds every extra kilo bought straight back
     * into how fast the kitchen is said to have eaten, so no amount of stock
     * ever builds a buffer and the ledger dips under zero between deliveries.
     * The difference is settled in the closing weeks instead, below.
     */
    needOut.set(it.id, q3(it.typical * WEEKLY_USE * weeks));
  }

  /* ========================================================== the ledger */
  const ledger = [];
  const balance = new Map();
  const push = (row) => ledger.push({
    client_id: clientId, location_id: null, order_id: null,
    quantity_in: 0, quantity_out: 0, unit_cost: null, note: null, created_by: null, ...row,
  });

  for (const it of items) {
    const qty = opening.get(it.id);
    balance.set(it.id, qty);
    push({
      item_id: it.id, source_type: 'adjustment', source_id: 0, location_id: mainDepot,
      quantity_in: qty, unit_cost: costOn(it, ctx.start),
      note: 'Açılış devri', created_by: owner, created_at: opened,
    });
  }

  /* One timeline, so the running balance a count reports is the balance that
     was actually there on the morning somebody walked round with a clipboard. */
  const events = [];
  for (const doc of docRows) events.push({ at: doc.created_at, rank: 0, doc });
  for (const tr of transferRows) events.push({ at: tr.created_at, rank: 1, tr });
  for (const w of wasteRows) events.push({ at: w.created_at, rank: 2, w });
  for (const p of periods) {
    events.push({ at: dt(atTime(p.day, 23, 30)), rank: 3, period: p });
  }
  for (const c of countPlan) events.push({ at: dt(atTime(c.day, 23, 50)), rank: 4, count: c });
  events.sort((a, b) => (a.at === b.at ? a.rank - b.rank : (a.at < b.at ? -1 : 1)));

  const countItemRows = [], countRows = [];
  for (const ev of events) {
    if (ev.doc) {
      for (const l of ev.doc._lines) {
        balance.set(l.item.id, q3(balance.get(l.item.id) + l.qty));
        push({
          item_id: l.item.id, source_type: 'document', source_id: ev.doc.id,
          location_id: mainDepot, quantity_in: l.qty, unit_cost: l.unitPrice,
          note: 'Alış: ' + ev.doc.document_no, created_by: manager, created_at: ev.doc.created_at,
        });
      }
    } else if (ev.tr) {
      const cost = costOn(ev.tr._item, ev.tr._day);
      push({
        item_id: ev.tr.item_id, source_type: 'transfer', source_id: ev.tr.id,
        location_id: mainDepot, quantity_out: ev.tr.quantity, unit_cost: cost,
        note: 'Depo çıkışı #' + ev.tr.id, created_by: ev.tr.created_by, created_at: ev.tr.created_at,
      });
      push({
        item_id: ev.tr.item_id, source_type: 'transfer', source_id: ev.tr.id,
        location_id: ev.tr._to, quantity_in: ev.tr.quantity, unit_cost: cost,
        note: 'Depo girişi #' + ev.tr.id, created_by: ev.tr.created_by, created_at: ev.tr.created_at,
      });
    } else if (ev.w) {
      balance.set(ev.w.item_id, q3(balance.get(ev.w.item_id) - ev.w.quantity));
      push({
        item_id: ev.w.item_id, source_type: 'waste', source_id: ev.w.id, location_id: mainDepot,
        quantity_out: ev.w.quantity, unit_cost: ev.w.unit_cost,
        note: 'Zayi: ' + ev.w.note, created_by: ev.w.created_by, created_at: ev.w.created_at,
      });
    } else if (ev.period) {
      const share = ev.period.weight / periodTotal;
      if (!(share > 0)) continue;
      for (const it of items) {
        const qty = it.whole ? Math.round(needOut.get(it.id) * share) : q3(needOut.get(it.id) * share);
        if (!(qty > 0)) continue;
        balance.set(it.id, q3(balance.get(it.id) - qty));
        push({
          item_id: it.id, source_type: 'sale', source_id: 0, location_id: mainDepot,
          quantity_out: qty, unit_cost: costOn(it, ev.period.day),
          note: 'Mutfak sarfiyatı', created_by: manager, created_at: ev.at,
        });
      }
    } else if (ev.count) {
      const c = ev.count;
      countRows.push({
        id: c.id, client_id: clientId, location_id: mainDepot, count_date: ymd(c.day),
        status: 'approved', note: 'Dönemsel depo sayımı', created_by: manager,
        created_at: ev.at, approved_by: owner, approved_at: dt(atTime(addDays(c.day, 1), 9, 30)),
      });
      for (const it of items) {
        const expected = q3(balance.get(it.id));
        const v = c.varianceOf.get(it.id) || 0;
        countItemRows.push({
          count_id: c.id, item_id: it.id, expected_qty: expected,
          counted_qty: q3(expected + v), variance: v, unit_cost: costOn(it, c.day),
        });
        if (!v) continue;
        balance.set(it.id, q3(expected + v));
        push({
          item_id: it.id, source_type: 'count', source_id: c.id, location_id: mainDepot,
          quantity_in: v > 0 ? v : 0, quantity_out: v < 0 ? -v : 0, unit_cost: costOn(it, c.day),
          note: 'Sayım farkı #' + c.id, created_by: owner, created_at: ev.at,
        });
      }
    }
  }

  /*
   * Settle up. Whatever the difference is between where seven years of honest
   * arithmetic left each ingredient and the figure today's screen should show,
   * it is worked off across the closing weeks - spread over a season's issues
   * rather than dropped on one row, so nothing ends the history with a freak
   * withdrawal on it, and nothing before that window is touched.
   */
  const TRIM_ROWS = 80;
  for (const it of items) {
    const tail = [];
    for (let i = ledger.length - 1; i >= 0 && tail.length < TRIM_ROWS; i--) {
      if (ledger[i].item_id === it.id && ledger[i].source_type === 'sale') tail.push(ledger[i]);
    }
    if (!tail.length) continue;
    let drift = q3(balance.get(it.id) - target.get(it.id));
    for (let pass = 0; pass < 3 && drift; pass++) {
      const each = drift / tail.length;
      for (const row of tail) {
        if (!drift) break;
        /* Countable things move a packet at a time. Rounding a share that is
           under half a packet gives zero on every row of the tail, and the
           difference then never gets worked off at all. */
        const take = it.whole
          ? (Math.abs(each) >= 1 ? Math.round(each) : Math.sign(drift))
          : q3(each);
        const adjusted = q3(row.quantity_out + (Math.abs(take) > Math.abs(drift) ? drift : take));
        if (adjusted < 0) continue;
        drift = q3(drift - (adjusted - row.quantity_out));
        row.quantity_out = adjusted;
      }
      if (!tail.some(row => row.quantity_out > 0)) break;
    }
    balance.set(it.id, q3(target.get(it.id) + drift));
  }

  /* ------------------------------------------------------------ write it */
  /* bulk() writes only the columns it is given, so the `_` scratch fields the
     timeline needed never reach the database. */
  await bulk(db, 'inventory_documents', ['id', 'client_id', 'supplier_id', 'location_id', 'type',
    'document_no', 'document_date', 'total_amount', 'status', 'source', 'file_path', 'note',
    'created_by', 'approved_by', 'approved_at', 'created_at'], docRows);
  await bulk(db, 'inventory_document_items', ['document_id', 'item_id', 'raw_name', 'quantity',
    'unit', 'unit_price', 'total_price', 'vat_rate', 'vat_amount', 'matched_confidence',
    'is_approved'], docLineRows);
  if (have.has('inventory_waste')) {
    await bulk(db, 'inventory_waste', ['id', 'client_id', 'item_id', 'location_id', 'quantity',
      'reason', 'note', 'unit_cost', 'created_by', 'created_at'], wasteRows);
  }
  if (have.has('inventory_transfers')) {
    await bulk(db, 'inventory_transfers', ['id', 'client_id', 'item_id', 'from_location_id',
      'to_location_id', 'quantity', 'note', 'created_by', 'created_at'], transferRows);
  }
  if (countRows.length) {
    await bulk(db, 'inventory_counts', ['id', 'client_id', 'location_id', 'count_date', 'status',
      'note', 'created_by', 'created_at', 'approved_by', 'approved_at'], countRows);
    await bulk(db, 'inventory_count_items', ['count_id', 'item_id', 'expected_qty', 'counted_qty',
      'variance', 'unit_cost'], countItemRows);
  }
  await bulk(db, 'inventory_stock_ledger', ['client_id', 'item_id', 'source_type', 'source_id',
    'location_id', 'order_id', 'quantity_in', 'quantity_out', 'unit_cost', 'note', 'created_by',
    'created_at'], ledger);

  /* =============================================================== reçete */
  let recipeLines = 0;
  if (have.has('product_recipes')) {
    const sold = ctx.soldByProduct || new Map();
    const ranked = ctx.products.slice().sort((a, b) =>
      (sold.get(b.id) || b.weight || 0) - (sold.get(a.id) || a.weight || 0));
    const rows = [];
    let costed = 0;
    for (const p of ranked) {
      /* The best sellers earn a recipe. Costing the whole menu would be nicer
         and is a day's work for the chef, not something a demo should pretend
         has already been done. */
      if (costed >= TOP_SELLERS_COSTED) break;
      const def = RECIPES[p.name];
      if (!def) continue;
      costed++;
      for (const [ing, qty] of def.slice(0, 5)) {
        const it = itemByName.get(ing);
        if (!it) continue;
        rows.push({ client_id: clientId, product_id: p.id, inventory_item_id: it.id,
          qty_per_unit: qty, created_at: opened, updated_at: opened });
      }
    }
    recipeLines = await bulk(db, 'product_recipes',
      ['client_id', 'product_id', 'inventory_item_id', 'qty_per_unit', 'created_at', 'updated_at'],
      rows, { ignore: true });
  } else skipped.push('product_recipes');

  /* ========================================================== fiyatlandırma */
  if (have.has('pricing_targets')) {
    const rows = [{ client_id: clientId, category_id: 0, target_margin: 62,
      updated_at: dt(addDays(ctx.today, -40)), updated_by: owner }];
    for (const c of ctx.cats) {
      if (MARGIN_TARGET[c.name] === undefined) continue;
      rows.push({ client_id: clientId, category_id: c.id, target_margin: MARGIN_TARGET[c.name],
        updated_at: dt(addDays(ctx.today, -between(10, 120))), updated_by: owner });
    }
    await bulk(db, 'pricing_targets',
      ['client_id', 'category_id', 'target_margin', 'updated_at', 'updated_by'], rows, { ignore: true });
  } else skipped.push('pricing_targets');

  let suggestions = 0;
  if (have.has('pricing_suggestions')) {
    const rows = [];
    const bag = ctx.products.slice();
    for (let i = 0; i < 25 && bag.length; i++) {
      const p = bag.splice(Math.floor(r() * bag.length), 1)[0];
      const vat = Number(p.vat) || 10;
      const net = p.price / (1 + vat / 100);
      const cost = p.cost;
      const curMargin = net > 0 ? ((net - cost) / net) * 100 : 0;
      const tgt = MARGIN_TARGET[p.catName] || 62;
      /* below target asks for more, comfortably above it asks for volume */
      const strategy = curMargin < tgt ? 'profit' : 'volume';
      const factor = strategy === 'profit' ? jitter(1.05, 1.18) : jitter(0.88, 0.97);
      const suggested = Math.round(p.price * factor / 5) * 5;
      const created = addDays(ctx.today, -between(3, 175));
      const source = r() < 0.55 ? 'sale' : (r() < 0.6 ? 'product' : 'recipe');
      const confidence = source === 'sale' ? between(70, 95) : between(45, 70);
      const outcome = i < 10 ? 'pending' : (i < 19 ? 'accepted' : 'rejected');
      const decided = addDays(created, between(1, 9));
      rows.push({
        client_id: clientId, product_id: p.id, current_price: p.price,
        suggested_price: suggested,
        chosen_price: outcome === 'accepted' ? suggested : null,
        suggested_min: Math.round(suggested * 0.94 / 5) * 5,
        suggested_max: Math.round(suggested * 1.08 / 5) * 5,
        strategy, confidence, reason: pick(SUGGESTION_REASONS),
        data_window_days: pick([30, 60, 90]),
        created_at: dt(atTime(created, 6, 15)),
        accepted_at: outcome === 'accepted' ? dt(atTime(decided, 10, 20)) : null,
        rejected_at: outcome === 'rejected' ? dt(atTime(decided, 10, 25)) : null,
        accepted_by: outcome === 'accepted' ? owner : null,
        rejected_by: outcome === 'rejected' ? owner : null,
        reject_note: outcome === 'rejected' ? pick(REJECT_NOTES) : null,
        shown_count: between(1, 6), applied_count: outcome === 'accepted' ? 1 : 0,
        estimated_profit: money(Math.abs(suggested - p.price) * between(20, 180)),
        cost_price: cost, cost_source: source,
        target_margin: tgt, current_margin: money(curMargin), vat_rate: vat,
      });
    }
    suggestions = await bulk(db, 'pricing_suggestions', ['client_id', 'product_id', 'current_price',
      'suggested_price', 'chosen_price', 'suggested_min', 'suggested_max', 'strategy', 'confidence',
      'reason', 'data_window_days', 'created_at', 'accepted_at', 'rejected_at', 'accepted_by',
      'rejected_by', 'reject_note', 'shown_count', 'applied_count', 'estimated_profit',
      'cost_price', 'cost_source', 'target_margin', 'current_margin', 'vat_rate'], rows);
  } else skipped.push('pricing_suggestions');

  /* ------------------------------------------- the finished-goods counter */
  /*
   * A sample, not a row per sold bottle. This counter is the one number in the
   * system nothing reads back for a level - the stock screen derives from the
   * ledger - so the point of these rows is that the "ürün stok hareketleri"
   * list has a believable week in it, and a quarter of a million rows would
   * buy nothing extra.
   */
  let moves = 0;
  if (have.has('product_stock_movements')) {
    const drinks = ctx.products.filter(p => p.catName === 'İçecekler');
    const rows = [];
    if (drinks.length) {
      for (const day of days) {
        if (!billsOn.get(ymd(day))) continue;
        for (let k = 0; k < 2; k++) {
          const p = pick(drinks);
          rows.push({ client_id: clientId, product_id: p.id, qty: -between(1, 6),
            reason: 'sale', order_item_id: null,
            created_at: dt(atTime(day, between(12, 23), between(0, 59))) });
        }
      }
    }
    moves = await bulk(db, 'product_stock_movements',
      ['client_id', 'product_id', 'qty', 'reason', 'order_item_id', 'created_at'], rows);
  } else skipped.push('product_stock_movements');

  const critical = items.filter(it => target.get(it.id) <= it.critical).length;
  ctx.log(`stok: ${items.length} malzeme, ${docRows.length} alış faturası, ` +
    `${ledger.length} stok hareketi, ${countRows.length} sayım, ${wasteRows.length} zayi, ` +
    `${critical} kritik seviyede`);
  ctx.log(`fiyatlandırma: ${recipeLines} reçete satırı, ${suggestions} öneri, ` +
    `${moves} ürün stok hareketi` + (skipped.length ? ` (atlanan tablo: ${skipped.join(', ')})` : ''));
}

module.exports = { build };
