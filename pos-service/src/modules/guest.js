'use strict';
/**
 * MISAFIR TARAFI - the half of the product the guest actually touches.
 *
 * Four things live here, and they are together because they are all one
 * question - "who is the person at the table, and what do we show them?":
 *
 *   1. DIJITAL MENU. The card on the table is scanned by a phone that has
 *      never heard of this restaurant, has no app and no login. That page is
 *      served by THIS service from THIS machine (public/menu.html), so a menu
 *      keeps working when the panel is down - the till and the menu are the
 *      same database, so a price changed at 11:00 is on the table at 11:00
 *      with nothing to publish. The old system pushed a copy up to
 *      pos.noktapp.com and served it from `qr_categories`/`qr_products`,
 *      which is why every venue's QR menu was months behind its till.
 *      routes/qr.js still does that push, and it still works; this is the
 *      local road, not a replacement for it.
 *
 *   2. MUSTERILER. customers.js already knew how to search, save and list a
 *      guest's bills. What was missing was the arithmetic anybody actually
 *      asks for - how often, how much, when last - and the one action that
 *      makes the record worth keeping: attaching the guest to an open bill,
 *      which is what makes loyalty award itself when the bill closes.
 *
 *   3. SADAKAT YONETIMI. modules/loyalty.js is the engine and is not touched
 *      here: stamping, rollover and redemption all belong to it. What it has
 *      no opinion about is the management around it - creating a programme,
 *      editing one, seeing every card, and the number no screen in the old
 *      system could produce: the ACIK YUKUMLULUK. Rewards a guest has earned
 *      and not yet taken are food the restaurant owes and has already been
 *      paid for. It is a balance-sheet item, and until it is on a screen the
 *      owner is running a liability they cannot see.
 *
 *   4. KURULUM EKSIKLERI. The first-run wizard asks four questions and then
 *      leaves the restaurant with no KDV rates, no business-day roll hour, no
 *      currency and an empty menu. The fourth is the expensive one: typing 300
 *      products into a till is a day of somebody's life, and the price list
 *      already exists as a spreadsheet. modules/portage.js can read that
 *      spreadsheet, so the wizard should ask for it.
 *
 * Nothing here re-implements loyalty, customers, catalog or portage. Where a
 * behaviour already exists it is called; what is added is the part that was
 * missing around it.
 */
const db = require('../db');
const log = require('../logger');
const customers = require('./customers');
const loyalty = require('./loyalty');
const portage = require('./portage');
const { money } = require('../util/http');

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/* ==================================================================== *
 * SABLONLAR                                                            *
 * ==================================================================== */

/**
 * The twelve designs the guest menu can wear.
 *
 * Keys, not stylesheets. The CSS lives in public/menu-templates.css as twelve
 * blocks over ONE page (public/menu.html), and this list is the contract
 * between the two: the picker offers these, the column stores one of these,
 * and the page sets <html data-tpl> to it. Storing CSS in a column instead
 * would mean a stylesheet nobody reviews, injected into the one page in the
 * product that is served without a login.
 *
 * A key that is not in this list is refused rather than defaulted quietly - a
 * typo that silently reverts the design of every table card in the building is
 * worse than an error message.
 *
 * `dark` is here so the picker can warn about the two designs that ignore the
 * light/dark switch, and `photo` so it can say which one wants photographs.
 */
const MENU_TEMPLATES = [
  { key: 'noktapp',       name: 'NOKTApp',        note: 'Ev tarzı: açık zemin, turuncu vurgu, ince çizgiler.' },
  { key: 'noktapp-kart',  name: 'NOKTApp Kart',   note: 'Her ürün kendi kartında. Uzun açıklamalar için.' },
  { key: 'noktapp-serit', name: 'NOKTApp Şerit',  note: 'Kategori başlıkları turuncu şerit. Çok kategorili menü için.' },
  { key: 'luks',          name: 'Lüks',           dark: true,
    note: 'Koyu zemin, serif yazı, geniş boşluk, sıcak pirinç tonu.' },
  { key: 'modern',        name: 'Modern',         note: 'Serin gri, geometrik, keskin. Kahve barları için.' },
  { key: 'sicak',         name: 'Sıcak',          note: 'Krem zemin, yuvarlak hatlar, samimi. Kahvaltı ve köftecilere.' },
  { key: 'sade',          name: 'Sade',           note: 'Çerçeve yok, kutu yok - sadece yazı.' },
  { key: 'gece',          name: 'Gece',           dark: true, note: 'Koyu mod, turuncu vurgu. Bar ve geç mutfak.' },
  { key: 'iri',           name: 'İri Punto',      note: 'Büyük punto, siyah-beyaz. Gözlüğü yanında olmayan misafir için.' },
  { key: 'fotograf',      name: 'Fotoğraflı',     photo: true,
    note: 'Ürün fotoğrafı solda. Fotoğrafı olmayan ürün baş harfiyle çıkar.' },
  { key: 'lokanta',       name: 'Lokanta',        note: 'Klasik esnaf lokantası tabelası: krem, çift çizgi, noktalı dizgi.' },
  { key: 'bistro',        name: 'Bistro',         dark: true,
    note: 'Karatahta bistro: koyu zemin, sıcak pirinç çizgiler.' },
];
const TEMPLATE_KEYS = new Set(MENU_TEMPLATES.map(t => t.key));
const DEFAULT_TEMPLATE = 'noktapp';

/**
 * The A5 table-card designs. Three, all in the house style - a card is printed
 * once and lives on the table for years, so this is not the place for a range.
 */
const CARD_DESIGNS = [
  { key: 'klasik',  name: 'Klasik',  note: 'Üstte turuncu bant, ortada büyük masa numarası ve karekod.' },
  { key: 'cerceve', name: 'Çerçeve', note: 'İnce çerçeve, masa numarası üstte, karekod ortada. En sade.' },
  { key: 'serit',   name: 'Şerit',   note: 'Solda dikey turuncu şerit, masa numarası şeridin üzerinde.' },
];
const CARD_KEYS = new Set(CARD_DESIGNS.map(d => d.key));
const DEFAULT_CARD = 'klasik';

/** Normalise a stored or submitted template key. Unknown keys are refused. */
function templateKey(v, { strict = false } = {}) {
  const k = String(v || '').trim();
  if (TEMPLATE_KEYS.has(k)) return k;
  if (strict && k) throw bad('Bilinmeyen menü şablonu: ' + k);
  return DEFAULT_TEMPLATE;
}
function cardKey(v, { strict = false } = {}) {
  const k = String(v || '').trim();
  if (CARD_KEYS.has(k)) return k;
  if (strict && k) throw bad('Bilinmeyen kart tasarımı: ' + k);
  return DEFAULT_CARD;
}

/* ==================================================================== *
 * 1. DIJITAL MENU                                                      *
 * ==================================================================== */

/**
 * Turn a business name into an address fragment.
 *
 * Turkish letters are folded rather than dropped: "Çiğköfteci Ömer" has to
 * become "cigkofteci-omer", not "ikfteci-mer". A slug is printed on cards and
 * cannot be changed afterwards, so this runs once and has to be right.
 */
function slugify(s) {
  const map = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', İ: 'i', Ö: 'o', Ş: 's', Ü: 'u' };
  return String(s || '')
    .replace(/[çğıöşüÇĞİÖŞÜ]/g, ch => map[ch])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'menu';
}

/**
 * The categories and products a guest is allowed to see.
 *
 * This is deliberately NOT catalog.menu({forQr:true}): that helper selects
 * cost-adjacent columns (track_stock, stock) because the till needs them, and
 * the till's menu object has a habit of growing. A page served without a login
 * must be built from a column list written out by hand, so that a column added
 * to `products` next year cannot leak onto a stranger's phone by accident.
 *
 * What the guest gets: name, price, description. Nothing else exists here.
 */
async function guestCatalog(clientId, { withPrices = true } = {}) {
  const cats = await db.query(
    `SELECT id, name FROM categories
      WHERE client_id=? AND COALESCE(is_active,1)=1 AND use_in_qr=1
      ORDER BY sort_order, name`, [clientId]);
  if (!cats.length) return [];
  const prods = await db.query(
    `SELECT id, category_id, name, price, description, image_url FROM products
      WHERE client_id=? AND COALESCE(is_active,1)=1 AND use_in_qr=1
      ORDER BY sort_order, name`, [clientId]);

  const byCat = new Map(cats.map(c => [c.id, { id: c.id, name: c.name, products: [] }]));
  for (const p of prods) {
    const c = byCat.get(p.category_id);
    if (!c) continue;
    c.products.push({
      id: p.id,
      name: p.name,
      price: withPrices ? money(p.price) : null,
      description: p.description || null,
      /* the photo-led template needs somewhere to read a picture from, and it
         is still name/price/description/photo - nothing cost-adjacent joins
         this list because it is written out by hand, see the note above */
      image: p.image_url || null,
    });
  }
  /*
   * An empty category is dropped rather than shown. Tapping "Tatlılar" and
   * getting a blank page reads as a broken menu, and the guest has no way to
   * know it means the kitchen has none today.
   */
  return Array.from(byCat.values()).filter(c => c.products.length);
}

/** The venue header the menu is wrapped in. Falls back to the licence's name. */
async function venue(clientId) {
  const s = await db.one('SELECT * FROM qr_menu_settings WHERE client_id=?', [clientId]);
  const c = await db.one('SELECT company_name, full_address, phone FROM clients WHERE id=?', [clientId]);
  return {
    settings: s,
    business: {
      name: (s && s.business_name) || (c && c.company_name) || 'Menü',
      welcome: (s && s.welcome_text) || null,
      about: (s && s.about) || null,
      logo: (s && s.logo_url) || null,
      theme: (s && s.theme === 'dark') ? 'dark' : 'light',
      template: templateKey(s && s.template),
      phone: (s && s.phone) || (c && c.phone) || null,
      address: (c && c.full_address) || null,
      instagram: (s && s.instagram_url) || null,
      google: (s && s.google_url) || null,
      website: (s && s.website_url) || null,
      show_prices: !s || Number(s.show_prices) !== 0,
    },
  };
}

/**
 * Resolve a scanned card into a menu. THE PUBLIC ENTRY POINT - no session, no
 * token of ours, nothing but what is printed on the table.
 *
 * The table token is floor.js's (`restaurant_tables.qr_token`), not a second
 * scheme of our own: a card is printed once and lives for years, so there can
 * only ever be one thing printed on it. Regenerating a table's token there
 * kills its cards here too, which is exactly what that button promises.
 *
 * The table is resolved together with the licensed tenant, so a token that
 * belongs to some other venue's data sitting in this database resolves to
 * nothing rather than to somebody else's menu.
 */
async function publicMenu(token, tplOverride = null) {
  const clean = String(token || '').trim();
  if (!/^[A-Za-z0-9]{8,64}$/.test(clean)) throw bad('Karekod okunamadı', 404);

  const clientId = await db.getClientId();
  if (!clientId) throw bad('Menü bulunamadı', 404);

  const table = await db.one(
    `SELECT t.id, t.name, z.name AS zone_name
       FROM restaurant_tables t
       LEFT JOIN table_zones z ON z.id=t.zone_id AND z.client_id=t.client_id
      WHERE t.client_id=? AND t.qr_token=? AND t.is_active=1 LIMIT 1`, [clientId, clean]);
  if (!table) {
    /*
     * Deliberately the same 404 as a malformed code. Telling a stranger
     * "that token exists but the table is closed" is telling them something
     * about the restaurant they did not scan a card to learn.
     */
    throw bad('Bu karekod tanımlı bir masaya ait değil. Lütfen garsona bildirin.', 404);
  }

  const v = await venue(clientId);
  if (v.settings && Number(v.settings.is_published) === 0) {
    // why it is closed is the venue's business, so the guest is not told
    throw bad('Dijital menü şu anda kullanılamıyor. Siparişiniz için garsonu çağırabilirsiniz.', 403);
  }

  return {
    /*
     * `tplOverride` is the picker's live preview and nothing else: the QR menü
     * screen loads THIS page in a frame with ?tpl= so the manager sees a real
     * menu in the design they are hovering over, before saving it. It can only
     * ever swap one stylesheet key for another from a fixed list, which is why
     * it is safe on a route with no session.
     */
    business: { ...v.business, template: tplOverride ? templateKey(tplOverride) : v.business.template },
    table: { name: table.name, zone: table.zone_name || null },
    categories: await guestCatalog(clientId, { withPrices: v.business.show_prices }),
  };
}

/** The same page the guest sees, but reached from the management screen. */
async function previewMenu(clientId, tplOverride = null) {
  const v = await venue(clientId);
  return {
    business: { ...v.business, template: tplOverride ? templateKey(tplOverride) : v.business.template },
    table: { name: 'Önizleme', zone: null },
    categories: await guestCatalog(clientId, { withPrices: v.business.show_prices }),
    published: !v.settings || Number(v.settings.is_published) === 1,
  };
}

/** Everything the QR-menu management screen needs in one round trip. */
async function qrSettings(clientId) {
  const s = await db.one('SELECT * FROM qr_menu_settings WHERE client_id=?', [clientId]);
  const counts = await db.one(
    `SELECT (SELECT COUNT(*) FROM categories WHERE client_id=? AND COALESCE(is_active,1)=1 AND use_in_qr=1) AS qr_categories,
            (SELECT COUNT(*) FROM categories WHERE client_id=? AND COALESCE(is_active,1)=1) AS categories,
            (SELECT COUNT(*) FROM products  WHERE client_id=? AND COALESCE(is_active,1)=1 AND use_in_qr=1) AS qr_products,
            (SELECT COUNT(*) FROM products  WHERE client_id=? AND COALESCE(is_active,1)=1) AS products,
            (SELECT COUNT(*) FROM restaurant_tables WHERE client_id=? AND is_active=1 AND qr_token IS NOT NULL AND qr_token<>'') AS carded,
            (SELECT COUNT(*) FROM restaurant_tables WHERE client_id=? AND is_active=1) AS tables`,
    [clientId, clientId, clientId, clientId, clientId, clientId]);
  const tables = await db.query(
    `SELECT id, name, qr_token FROM restaurant_tables
      WHERE client_id=? AND is_active=1 ORDER BY sort_order, name`, [clientId]);

  /*
   * The warnings a person about to print cards needs, in the order the mistake
   * costs money: cards that point at a menu with nothing on it, and cards for
   * tables that have no token at all. Both are printable mistakes, so they are
   * warnings and not errors.
   */
  const warnings = [];
  if (!Number(counts.qr_categories) || !Number(counts.qr_products)) {
    warnings.push('Menüde misafire açık ürün yok. Aşağıdan kategori ve ürünleri açın, yoksa karekod boş bir sayfa gösterir.');
  }
  const missing = Number(counts.tables) - Number(counts.carded);
  if (missing > 0) warnings.push(`${missing} masanın karekodu yok. Masa düzeni ekranından üretebilirsiniz.`);
  if (s && Number(s.is_published) === 0) warnings.push('Dijital menü kapalı. Karekodu okutan misafir menüyü göremez.');

  return {
    settings: s,
    counts,
    tables,
    warnings,
    templates: MENU_TEMPLATES,
    card_designs: CARD_DESIGNS,
    template: templateKey(s && s.template),
    card_design: cardKey(s && s.card_design),
  };
}

/**
 * Save the menu's own settings.
 *
 * Note this writes the same row routes/qr.js writes - there is one digital
 * menu, so there is one row. What is different is that the slug is derived
 * rather than demanded: a restaurant filling this in for the first time should
 * not have to invent a URL fragment, and once one exists it is never silently
 * changed, because it is printed on cards that cannot be recalled.
 */
async function saveQrSettings(clientId, b = {}) {
  const name = String(b.business_name || '').trim();
  if (!name) throw bad('İşletme adı zorunlu');

  const existing = await db.one('SELECT * FROM qr_menu_settings WHERE client_id=?', [clientId]);
  let slug = existing && existing.slug ? existing.slug : slugify(b.slug || name);
  if (!existing) {
    // slug is UNIQUE across the table; suffix until it is free
    let n = 1;
    let candidate = slug;
    while (await db.one('SELECT client_id FROM qr_menu_settings WHERE slug=?', [candidate])) {
      candidate = `${slug}-${++n}`;
      if (n > 50) throw bad('Menü adresi üretilemedi');
    }
    slug = candidate;
  }

  const vals = {
    business_name: name.slice(0, 120),
    welcome_text: (b.welcome_text || '').trim().slice(0, 400) || null,
    about: (b.about || '').trim().slice(0, 2000) || null,
    logo_url: (b.logo_url || '').trim().slice(0, 255) || null,
    theme: b.theme === 'dark' ? 'dark' : 'light',
    phone: (b.phone || '').trim().slice(0, 50) || null,
    instagram_url: (b.instagram_url || '').trim().slice(0, 255) || null,
    google_url: (b.google_url || '').trim().slice(0, 255) || null,
    website_url: (b.website_url || '').trim().slice(0, 255) || null,
    show_prices: b.show_prices === false || b.show_prices === 0 || b.show_prices === '0' ? 0 : 1,
    is_published: b.is_published === false || b.is_published === 0 || b.is_published === '0' ? 0 : 1,
    /* strict: a mistyped key would silently redesign every table in the
       building, and the manager would find out from a guest */
    template: b.template === undefined ? templateKey(existing && existing.template) : templateKey(b.template, { strict: true }),
    card_design: b.card_design === undefined ? cardKey(existing && existing.card_design) : cardKey(b.card_design, { strict: true }),
  };

  if (existing) {
    await db.exec(
      `UPDATE qr_menu_settings SET business_name=?, welcome_text=?, about=?, logo_url=?, theme=?,
          phone=?, instagram_url=?, google_url=?, website_url=?, show_prices=?, is_published=?,
          template=?, card_design=?, updated_at=NOW() WHERE client_id=?`,
      [vals.business_name, vals.welcome_text, vals.about, vals.logo_url, vals.theme, vals.phone,
       vals.instagram_url, vals.google_url, vals.website_url, vals.show_prices, vals.is_published,
       vals.template, vals.card_design, clientId]);
  } else {
    await db.exec(
      `INSERT INTO qr_menu_settings (client_id, slug, business_name, welcome_text, about, logo_url,
          theme, phone, instagram_url, google_url, website_url, currency, show_prices, is_published,
          template, card_design, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'TRY', ?,?,?,?, NOW())`,
      [clientId, slug, vals.business_name, vals.welcome_text, vals.about, vals.logo_url, vals.theme,
       vals.phone, vals.instagram_url, vals.google_url, vals.website_url, vals.show_prices, vals.is_published,
       vals.template, vals.card_design]);
  }
  log.info('guest', 'dijital menu ayarlari kaydedildi', { slug, template: vals.template });
  return { slug, template: vals.template, card_design: vals.card_design };
}

/**
 * Pick a design - the menu's, the card's, or both.
 *
 * Its own writer rather than a trip through saveQrSettings, for the reason
 * setQrFlag has one: that function takes the whole settings object and would
 * blank every column the picker does not send, so choosing a template from a
 * screen that does not know the welcome text would erase the welcome text.
 * One choice writes one column.
 *
 * It also has to work before the venue has filled anything in - saveQrSettings
 * insists on a business name, and a manager should be able to look through the
 * twelve designs on the first afternoon.
 */
async function saveDesign(clientId, b = {}) {
  const sets = [];
  const params = [];
  if (b.template !== undefined) { sets.push('template=?'); params.push(templateKey(b.template, { strict: true })); }
  if (b.card_design !== undefined) { sets.push('card_design=?'); params.push(cardKey(b.card_design, { strict: true })); }
  if (!sets.length) throw bad('Seçilecek bir tasarım gönderilmedi');

  const existing = await db.one('SELECT client_id FROM qr_menu_settings WHERE client_id=?', [clientId]);
  if (!existing) {
    /* No settings row yet. One is created with a derived slug rather than
       refusing: the design is a real choice and it should not be hostage to
       a screen the manager has not opened yet. */
    const c = await db.one('SELECT company_name FROM clients WHERE id=?', [clientId]);
    let slug = slugify((c && c.company_name) || 'menu');
    let n = 1;
    while (await db.one('SELECT client_id FROM qr_menu_settings WHERE slug=?', [slug])) {
      slug = `${slugify((c && c.company_name) || 'menu')}-${++n}`;
      if (n > 50) throw bad('Menü adresi üretilemedi');
    }
    await db.exec(
      `INSERT INTO qr_menu_settings (client_id, slug, business_name, currency, show_prices, is_published, updated_at)
       VALUES (?,?,?, 'TRY', 1, 1, NOW())`,
      [clientId, slug, (c && c.company_name) || 'Menu']);
  }
  await db.exec(`UPDATE qr_menu_settings SET ${sets.join(', ')}, updated_at=NOW() WHERE client_id=?`,
    [...params, clientId]);

  const row = await db.one('SELECT template, card_design FROM qr_menu_settings WHERE client_id=?', [clientId]);
  log.info('guest', 'dijital menu tasarimi secildi',
    { template: row.template, card_design: row.card_design });
  return { template: templateKey(row.template), card_design: cardKey(row.card_design) };
}

/** Everything with a QR on/off switch, in menu order, for the flag screen. */
async function qrFlags(clientId) {
  const cats = await db.query(
    `SELECT id, name, use_in_qr, sort_order FROM categories
      WHERE client_id=? AND COALESCE(is_active,1)=1 ORDER BY sort_order, name`, [clientId]);
  const prods = await db.query(
    `SELECT id, category_id, name, price, use_in_qr FROM products
      WHERE client_id=? AND COALESCE(is_active,1)=1 ORDER BY sort_order, name`, [clientId]);
  const byCat = new Map(cats.map(c => [c.id, { ...c, use_in_qr: Number(c.use_in_qr), products: [] }]));
  for (const p of prods) {
    const c = byCat.get(p.category_id);
    if (c) c.products.push({ ...p, price: money(p.price), use_in_qr: Number(p.use_in_qr) });
  }
  return Array.from(byCat.values());
}

/**
 * Flip one item's QR visibility.
 *
 * A direct UPDATE and not catalog.saveProduct(): that helper takes the whole
 * product and would blank every column this screen does not send. One switch
 * should write one column.
 */
async function setQrFlag(clientId, kind, id, on) {
  const table = kind === 'category' ? 'categories' : kind === 'product' ? 'products' : null;
  if (!table) throw bad('Bilinmeyen tür: ' + kind);
  const n = await db.exec(`UPDATE ${table} SET use_in_qr=? WHERE id=? AND client_id=?`,
    [on ? 1 : 0, Number(id) || 0, clientId]);
  if (!n) throw bad('Kayıt bulunamadı', 404);
  await db.exec('UPDATE qr_menu_settings SET updated_at=NOW() WHERE client_id=?', [clientId]);
  return { id: Number(id), use_in_qr: on ? 1 : 0 };
}

/** Turn a whole category (and everything in it) on or off in one tap. */
async function setCategoryQrBulk(clientId, categoryId, on) {
  await setQrFlag(clientId, 'category', categoryId, on);
  const n = await db.exec('UPDATE products SET use_in_qr=? WHERE client_id=? AND category_id=?',
    [on ? 1 : 0, clientId, Number(categoryId) || 0]);
  return { products: n };
}

/* ==================================================================== *
 * 2. MUSTERILER                                                        *
 * ==================================================================== */

async function searchCustomers(clientId, q, limit = 50) {
  /*
   * A phone number is what the cashier has, and it is stored in half a dozen
   * historical shapes (0532…, +90532…, 532 123 45 67). loyalty.js already owns
   * that problem; asking it first means "0532 123 45 67" finds the guest whose
   * row says "5321234567", which a LIKE never would.
   */
  const raw = String(q || '').trim();
  if (/^\+?[\d\s\-()]{7,20}$/.test(raw)) {
    const hit = await loyalty.findByPhone(raw);
    if (hit) return [hit];
  }
  return customers.search(clientId, raw, limit);
}

async function saveCustomer(clientId, data) {
  const first = String(data.first_name || '').trim();
  if (!first) throw bad('Ad zorunlu');

  const phone = loyalty.trPhone(data.phone);
  if (data.phone && !loyalty.trPhoneOk(phone)) {
    throw bad('Telefon 5 ile başlayan 10 hane olmalı (örnek: 5321234567)');
  }
  if (phone) {
    /*
     * `customers.phone` is UNIQUE platform-wide, so a duplicate is a 1062 from
     * the driver - a message no cashier can act on. Checked here so the answer
     * is the guest who already owns the number.
     */
    const dupe = await loyalty.findByPhone(phone);
    if (dupe && Number(dupe.id) !== Number(data.id || 0)) {
      /* A guest registered from a QR menu or a phone order often has no name
         on file yet, and the message used to end on a bare colon. */
      const whose = `${dupe.first_name || ''} ${dupe.last_name || ''}`.trim();
      throw bad(whose ? `Bu numara zaten kayıtlı: ${whose}` : 'Bu numara zaten başka bir müşteriye kayıtlı', 409);
    }
  }
  const id = await customers.save(clientId, { ...data, first_name: first, phone: phone || null });
  return { id: Number(id) };
}

/**
 * One guest, everything about them.
 *
 * The spend figures count CLOSED, non-excluded bills only. An open bill is not
 * money the guest has spent, and a cancelled one never was; counting either
 * would make "en çok harcayan misafir" a list of people who walked out.
 */
async function customerDetail(clientId, customerId) {
  const c = await db.one('SELECT * FROM customers WHERE id=?', [Number(customerId) || 0]);
  if (!c) throw bad('Müşteri bulunamadı', 404);

  const stats = await db.one(
    `SELECT COUNT(*) AS visits, COALESCE(SUM(grand_total),0) AS spend,
            MAX(closed_at) AS last_visit, MIN(closed_at) AS first_visit
       FROM orders
      WHERE client_id=? AND customer_id=? AND is_deleted=0 AND is_closed=1
        AND exclude_from_reports=0`, [clientId, c.id]);

  const visits = Number(stats.visits);
  return {
    customer: c,
    stats: {
      visits,
      spend: money(stats.spend),
      average: visits ? money(Number(stats.spend) / visits) : 0,
      last_visit: stats.last_visit,
      first_visit: stats.first_visit,
    },
    history: await customers.history(clientId, c.id),
    cards: await loyalty.cardsFor(clientId, c.id),
  };
}

/**
 * Attach a guest to an open bill.
 *
 * This is the action the whole customer record exists for: a bill that knows
 * who is sitting there stamps their loyalty card by itself when it closes
 * (loyalty.awardForOrder), and it is what puts the visit into the history
 * above. Attaching is therefore refused on a closed bill - the award has
 * already been decided, and a customer added afterwards would be a visit with
 * no stamps, which reads as the system having lost them.
 */
async function attachToOrder(clientId, orderId, customerId) {
  const order = await db.one('SELECT id, is_closed, status FROM orders WHERE id=? AND client_id=? AND is_deleted=0',
    [Number(orderId) || 0, clientId]);
  if (!order) throw bad('Adisyon bulunamadı', 404);
  if (Number(order.is_closed) === 1 || order.status !== 'open') {
    throw bad('Kapalı adisyona müşteri bağlanamaz. Adisyonu yeniden açın.', 409);
  }
  const cid = customerId === null || customerId === '' ? null : Number(customerId);
  if (cid) {
    const c = await db.one('SELECT id FROM customers WHERE id=? AND COALESCE(is_active,1)=1', [cid]);
    if (!c) throw bad('Müşteri bulunamadı', 404);
  }
  await db.exec('UPDATE orders SET customer_id=? WHERE id=? AND client_id=?', [cid, order.id, clientId]);
  return { order_id: order.id, customer_id: cid, cards: cid ? await loyalty.cardsFor(clientId, cid) : [] };
}

/** Who spends the most, over a window. The old system could not answer this. */
async function topCustomers(clientId, from, to, limit = 20) {
  // a missing range means "the last month", not an SQL error with an
  // undefined parameter in it
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  if (!to) to = day(Date.now());
  if (!from) from = day(Date.now() - 29 * 86400000);
  return db.query(
    `SELECT c.id, c.first_name, c.last_name, c.phone,
            COUNT(o.id) AS visits, COALESCE(SUM(o.grand_total),0) AS spend,
            MAX(o.closed_at) AS last_visit
       FROM orders o JOIN customers c ON c.id=o.customer_id
      WHERE o.client_id=? AND o.is_deleted=0 AND o.is_closed=1 AND o.exclude_from_reports=0
        AND DATE(o.closed_at) BETWEEN ? AND ?
      GROUP BY c.id ORDER BY spend DESC LIMIT ?`,
    [clientId, from, to, Number(limit) || 20]);
}

/* ==================================================================== *
 * 3. SADAKAT YONETIMI                                                  *
 * ==================================================================== */

/** Programmes including the paused ones - this is the editing list. */
async function programList(clientId) {
  const rows = await customers.programs(clientId);
  return rows.map(r => ({
    ...r,
    target_count: Number(r.target_count),
    is_active: Number(r.is_active),
  }));
}

/**
 * Create or edit a programme.
 *
 * customers.saveProgram() does the writing; what is added here is the
 * validation it has none of. A programme with a target of 0 divides by zero in
 * the stamp rollover, and a product id from a form is still a value from the
 * request - untenanted, it would let one venue's card be filled by another
 * venue's product.
 */
async function saveProgram(clientId, data = {}) {
  const title = String(data.title || '').trim();
  if (!title) throw bad('Program adı zorunlu');
  const reward = String(data.reward_text || '').trim();
  if (!reward) throw bad('Ödül açıklaması zorunlu - müşteri ne kazanıyor?');

  const target = Math.round(Number(data.target_count) || 0);
  if (!Number.isFinite(target) || target < 1) throw bad('Hedef en az 1 olmalı');
  if (target > 999) throw bad('Hedef en fazla 999 olabilir');

  let productId = data.product_id ? Number(data.product_id) : null;
  if (productId) {
    const p = await db.one('SELECT id FROM products WHERE id=? AND client_id=?', [productId, clientId]);
    if (!p) throw bad('Ürün bu işletmeye ait değil', 400);
  } else {
    productId = null;    // "Her ziyaret" - one stamp per bill, whatever is on it
  }

  if (data.id) {
    const own = await db.one('SELECT id, target_count FROM loyalty_programs WHERE id=? AND client_id=?',
      [Number(data.id), clientId]);
    if (!own) throw bad('Program bulunamadı', 404);
    /*
     * Changing the target does NOT touch the cards already in progress.
     * Rewriting somebody's 7/10 into 7/5 would hand out rewards nobody earned;
     * leaving it means the next stamp is evaluated against the new target,
     * which is the only reading a guest would accept.
     */
    if (Number(own.target_count) !== target) {
      log.info('guest', 'sadakat hedefi degisti - mevcut kartlar korunuyor',
        { program: Number(data.id), from: Number(own.target_count), to: target });
    }
  }

  const id = await customers.saveProgram(clientId, {
    id: data.id ? Number(data.id) : null,
    product_id: productId,
    title: title.slice(0, 190),
    target_count: target,
    reward_text: reward.slice(0, 190),
    is_active: data.is_active === false || data.is_active === 0 ? false : true,
  });
  return { id: Number(id) };
}

/** Pause or resume. Paused programmes stop stamping but keep their cards. */
async function toggleProgram(clientId, id) {
  const n = await db.exec('UPDATE loyalty_programs SET is_active = 1 - is_active WHERE id=? AND client_id=?',
    [Number(id) || 0, clientId]);
  if (!n) throw bad('Program bulunamadı', 404);
  const p = await db.one('SELECT is_active FROM loyalty_programs WHERE id=?', [Number(id)]);
  return { id: Number(id), is_active: Number(p.is_active) };
}

/**
 * Every card, with its balance.
 *
 * Sorted by "has a reward waiting" first: a card sitting on an unclaimed
 * reward is the only row on this screen anybody needs to act on.
 */
async function cardList(clientId, { q = '', ready = false, limit = 200 } = {}) {
  const where = [];
  const params = [clientId];
  if (q) {
    const like = '%' + String(q).trim() + '%';
    where.push('(c.first_name LIKE ? OR c.last_name LIKE ? OR c.phone LIKE ? OR lp.title LIKE ?)');
    params.push(like, like, like, like);
  }
  if (ready) where.push('lc.rewards_available > 0');
  params.push(Number(limit) || 200);
  const rows = await db.query(
    `SELECT lc.id AS card_id, lc.customer_id, lc.program_id, lc.progress_count,
            lc.rewards_available, lc.rewards_used, lc.updated_at,
            lp.title, lp.target_count, lp.reward_text, lp.is_active AS program_active,
            c.first_name, c.last_name, c.phone,
            pr.name AS product_name, COALESCE(pr.price,0) AS unit_price
       FROM loyalty_cards lc
       JOIN loyalty_programs lp ON lp.id=lc.program_id AND lp.client_id=lc.client_id
       LEFT JOIN customers c ON c.id=lc.customer_id
       LEFT JOIN products pr ON pr.id=lp.product_id AND pr.client_id=lp.client_id
      WHERE lc.client_id=? ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ORDER BY (lc.rewards_available > 0) DESC, lc.updated_at DESC LIMIT ?`, params);
  return rows.map(r => ({
    ...r,
    progress_count: Number(r.progress_count),
    target_count: Math.max(1, Number(r.target_count)),
    rewards_available: Number(r.rewards_available),
    rewards_used: Number(r.rewards_used || 0),
    unit_price: money(r.unit_price),
    open_value: money(Number(r.rewards_available) * Number(r.unit_price)),
  }));
}

/**
 * ACIK YUKUMLULUK - the number this whole module exists to put on a screen.
 *
 * Every reward a card has ever earned is in exactly one of two places: still
 * available, or already used. So
 *
 *     earned = rewards_available + rewards_used
 *     open   = earned - used     = rewards_available
 *
 * and the open figure is an identity on the card table rather than a
 * derivation from the event log. That distinction matters: the PHP computed
 * `earned = stamps / target` from `loyalty_events`, and because that log
 * double-counted scanned bills (see inv/W3 §3.3) the liability it printed was
 * inflated by every scan. Cards cannot drift the same way - the same UPDATE
 * that hands out a reward is the one that moves the balance.
 *
 * The event figures (stamps issued, rewards taken in the window) come from
 * loyalty.programReport(), which already computes them; nothing is recomputed
 * here that the engine already knows.
 */
async function loyaltyReport(clientId, from = null, to = null) {
  /*
   * The lifetime event figures come from the engine, which already computes
   * them. Its DATED branch is NOT used: loyalty.programReport() binds one
   * parameter too many when a range is given, so the tenant id lands in the
   * date filter and the query returns nothing (see HANDOFF-guest.md - the fix
   * is one line in a file this build must not edit). The window is therefore
   * computed here, with the same two figures and the same rules, and this
   * whole block goes away the moment that binding is corrected.
   */
  const events = await loyalty.programReport(clientId);
  const byId = new Map(events.map(e => [Number(e.id), e]));

  const dated = !!(from && to);
  const windowed = await db.query(
    `SELECT program_id,
            COALESCE(SUM(CASE WHEN kind='stamp'  THEN qty END),0) AS stamps,
            COALESCE(SUM(CASE WHEN kind='reward' THEN 1   END),0) AS redeemed
       FROM loyalty_events
      WHERE client_id=? ${dated ? 'AND DATE(created_at) BETWEEN ? AND ?' : ''}
      GROUP BY program_id`, dated ? [clientId, from, to] : [clientId]);
  const inWindow = new Map(windowed.map(w => [Number(w.program_id), w]));

  const balances = await db.query(
    `SELECT lp.id, lp.title, lp.target_count, lp.reward_text, lp.is_active, lp.product_id,
            pr.name AS product_name, COALESCE(pr.price,0) AS unit_price,
            COUNT(lc.id) AS cards,
            COALESCE(SUM(lc.rewards_available),0) AS open_rewards,
            COALESCE(SUM(lc.rewards_used),0) AS used_rewards,
            COALESCE(SUM(lc.rewards_available) + SUM(lc.rewards_used),0) AS earned_rewards,
            COALESCE(SUM(lc.progress_count),0) AS progress
       FROM loyalty_programs lp
       LEFT JOIN products pr ON pr.id=lp.product_id AND pr.client_id=lp.client_id
       LEFT JOIN loyalty_cards lc ON lc.program_id=lp.id AND lc.client_id=lp.client_id
      WHERE lp.client_id=?
      GROUP BY lp.id ORDER BY lp.id`, [clientId]);

  const programs = balances.map(b => {
    const ev = byId.get(Number(b.id)) || {};
    const win = inWindow.get(Number(b.id)) || {};
    const earned = Number(b.earned_rewards);
    const used = Number(b.used_rewards);
    const open = Number(b.open_rewards);
    const unit = money(b.unit_price);
    return {
      id: Number(b.id),
      title: b.title,
      product_name: b.product_name || 'Her ziyaret',
      target_count: Math.max(1, Number(b.target_count)),
      reward_text: b.reward_text,
      is_active: Number(b.is_active),
      unit_price: unit,
      cards: Number(b.cards),
      progress: Number(b.progress),
      stamps: Number(win.stamps || 0),         // in the window
      redeemed: Number(win.redeemed || 0),     // in the window
      stamps_total: Number(ev.stamps || 0),    // lifetime, from the engine
      earned_rewards: earned,                  // lifetime, from the cards
      used_rewards: used,
      open_rewards: open,
      /* claim rate is lifetime on both sides, so it cannot compare a windowed
         numerator against a lifetime denominator the way the PHP's did */
      claim_rate: earned ? Math.round((used / earned) * 100) : 0,
      /* what the unclaimed rewards would cost to honour, at today's price */
      liability: money(open * unit),
    };
  });

  const sum = (k) => programs.reduce((s, p) => s + Number(p[k]), 0);
  const totals = {
    programs: programs.length,
    active: programs.filter(p => p.is_active).length,
    cards: sum('cards'),
    stamps: sum('stamps'),
    stamps_total: sum('stamps_total'),
    earned_rewards: sum('earned_rewards'),
    used_rewards: sum('used_rewards'),
    open_rewards: sum('open_rewards'),
    liability: money(programs.reduce((s, p) => s + p.liability, 0)),
  };
  totals.claim_rate = totals.earned_rewards
    ? Math.round((totals.used_rewards / totals.earned_rewards) * 100) : 0;

  const window = from && to
    ? await loyalty.redemptions(clientId, from, to)
    : [];
  return { totals, programs, redemptions: window, from, to };
}

/**
 * Mirror a card's balance to the guest's phone app.
 *
 * loyalty.js does this on every till path, through the sync outbox, but it does
 * not export the function - so a stamp given at the counter cannot reach the
 * app yet. Guarded rather than left out: the day `pushStamps` is added to that
 * module's exports (HANDOFF-guest.md §7) this starts working with no edit here,
 * and until then a failure to mirror must never fail the stamp itself.
 */
function mirrorToApp(clientId, customerId) {
  if (typeof loyalty.pushStamps !== 'function') return;
  Promise.resolve(loyalty.pushStamps(clientId, customerId, null))
    .catch(e => log.debug('guest', 'kart aynasi gonderilemedi: ' + e.message));
}

/**
 * A stamp given by hand, and why.
 *
 * Every other stamp in the system is evidenced by a bill: the guest bought the
 * thing, the order line proves it. This one is not, so it has to carry a
 * reason or it is indistinguishable from a card being filled for a friend.
 * The reason is mandatory for exactly that purpose, and it is written onto the
 * event, not into a log file, so the person auditing the card can see it.
 *
 * The stamping itself is loyalty.addStampIn() - the same rollover the till
 * uses, inside the same kind of transaction. Nothing about how a card advances
 * is re-decided here.
 */
async function manualStamp(clientId, { customerId, programId, qty = 1, reason, userId = null }) {
  const note = String(reason || '').trim();
  if (!note) throw bad('Gerekçe zorunlu - elle verilen damganın adisyon karşılığı yok');
  const n = Math.round(Number(qty) || 1);
  if (!(n >= 1 && n <= 50)) throw bad('Adet 1 ile 50 arasında olmalı');

  const customer = await db.one('SELECT id, first_name, last_name FROM customers WHERE id=? AND COALESCE(is_active,1)=1',
    [Number(customerId) || 0]);
  if (!customer) throw bad('Müşteri bulunamadı', 404);
  const program = await db.one('SELECT * FROM loyalty_programs WHERE id=? AND client_id=?',
    [Number(programId) || 0, clientId]);
  if (!program) throw bad('Program bulunamadı', 404);
  if (!Number(program.is_active)) throw bad('Durdurulmuş programa damga verilemez', 409);

  const out = await db.tx(async t => {
    const r = await loyalty.addStampIn(t, clientId, customer.id, program, n, 'manual', null, userId);
    /*
     * addStampIn() has just INSERTed the event on this connection, so
     * LAST_INSERT_ID() is that event. The UPDATE re-states what the row must
     * be (this tenant, this card, a stamp) so that if the engine ever grows
     * another INSERT the reason is simply not written rather than landing on
     * somebody else's row.
     */
    const eventId = Number(await t.value('SELECT LAST_INSERT_ID()'));
    const wrote = await t.exec(
      "UPDATE loyalty_events SET note=? WHERE id=? AND client_id=? AND card_id=? AND kind='stamp'",
      [note.slice(0, 190), eventId, clientId, r.card_id]);
    if (!wrote) throw bad('Damga gerekçesi yazılamadı', 500);
    return { ...r, event_id: eventId };
  });

  log.info('guest', 'elle damga verildi', { customer: customer.id, program: program.id, qty: n, reason: note });
  mirrorToApp(clientId, customer.id);
  return {
    ...out, reason: note, qty: n,
    customer: { id: customer.id, first_name: customer.first_name, last_name: customer.last_name },
    cards: await loyalty.cardsFor(clientId, customer.id),
  };
}

/**
 * A reward taken by hand, and why.
 *
 * loyalty.redeem() is the atomic one - the UPDATE is the check, so two people
 * tapping at once spend it once. Called and not reimplemented, precisely
 * because the old system had a second, racy redemption path behind the admin
 * screen (inv/05 §4.2) and that is how a reward got spent twice.
 *
 * When an order id is given the free item comes off that bill through the
 * discount ledger, exactly as it does at the till.
 */
async function manualRedeem(clientId, { customerId, cardId, orderId = null, reason, userId = null }) {
  const note = String(reason || '').trim();
  if (!note) throw bad('Gerekçe zorunlu');

  const out = await loyalty.redeem(clientId, {
    customerId: Number(customerId) || 0,
    cardId: Number(cardId) || 0,
    orderId: orderId ? Number(orderId) : null,
    userId,
  });

  /*
   * The engine writes the event; the reason is annotated afterwards rather
   * than by changing the engine's signature. `note IS NULL` keeps this from
   * relabelling an older redemption if the UPDATE ever matched more loosely.
   */
  await db.exec(
    `UPDATE loyalty_events SET note=?
      WHERE client_id=? AND card_id=? AND kind='reward' AND note IS NULL
      ORDER BY id DESC LIMIT 1`,
    [note.slice(0, 190), clientId, Number(cardId) || 0]);

  // no mirrorToApp() here: loyalty.redeem() already pushed the new balance
  log.info('guest', 'elle odul kullanildi', { card: cardId, reason: note, discount: out.discount });
  return { ...out, reason: note, cards: await loyalty.cardsFor(clientId, Number(customerId) || 0) };
}

/** The card's own history - what happened to it, in order, with reasons. */
async function cardHistory(clientId, cardId) {
  return db.query(
    `SELECT le.id, le.kind, le.qty, le.source, le.note, le.order_id, le.created_at,
            u.display_name AS user_name
       FROM loyalty_events le
       LEFT JOIN users u ON u.id=le.user_id AND u.client_id=le.client_id
      WHERE le.client_id=? AND le.card_id=? ORDER BY le.id DESC LIMIT 100`,
    [clientId, Number(cardId) || 0]);
}

/* ==================================================================== *
 * 4. KURULUM EKSIKLERI                                                 *
 * ==================================================================== */

/*
 * The KDV rates a Turkish restaurant actually uses. These are not a free text
 * box: a typo in a rate is a tax return that does not reconcile, and the four
 * legal rates are the four legal rates.
 */
const VAT_RATES = [
  { rate: 1, label: '%1 - temel gıda' },
  { rate: 10, label: '%10 - yiyecek ve içecek' },
  { rate: 20, label: '%20 - genel oran' },
  { rate: 0, label: '%0 - muaf' },
];

/** np_settings keys this module owns. See HANDOFF: settings.js should adopt them. */
const VAT_LIST_KEY = 'vat_rates';
const VAT_DEFAULT_KEY = 'vat_default_rate';

/**
 * Where the restaurant actually is in its setup, counted rather than assumed.
 *
 * The old wizard's index page did the same four COUNT(*) probes and it is the
 * single most useful thing it did: a half-finished setup is normal (the tables
 * arrive on Monday, the menu on Tuesday), and the only unhelpful answer is a
 * wizard that starts again from step one every time.
 */
async function setupState(clientId) {
  const counts = await db.one(
    `SELECT (SELECT COUNT(*) FROM restaurant_tables WHERE client_id=? AND COALESCE(is_active,1)=1) AS tables,
            (SELECT COUNT(*) FROM categories WHERE client_id=? AND COALESCE(is_active,1)=1) AS categories,
            (SELECT COUNT(*) FROM products WHERE client_id=? AND COALESCE(is_active,1)=1) AS products,
            (SELECT COUNT(*) FROM users WHERE client_id=? AND role IN ('cashier','waiter')) AS staff,
            (SELECT COUNT(*) FROM stations WHERE client_id=? AND COALESCE(is_active,1)=1) AS stations,
            (SELECT COUNT(*) FROM printers WHERE client_id=?) AS printers,
            (SELECT COUNT(*) FROM loyalty_programs WHERE client_id=?) AS programs`,
    [clientId, clientId, clientId, clientId, clientId, clientId, clientId]);

  const rates = String(await db.getSetting(VAT_LIST_KEY, '1,10,20') || '')
    .split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));

  const steps = [
    { id: 'kdv', label: 'KDV oranları', done: !!(await db.getSetting(VAT_LIST_KEY, null)),
      help: 'Ürünlere önerilecek oranlar ve varsayılan.' },
    { id: 'gun', label: 'İş günü ve para birimi', done: !!(await db.getSetting('business_day_start_set', null)),
      help: 'Gece yarısından sonra kesilen adisyon hangi güne yazılsın.' },
    { id: 'istasyon', label: 'İstasyonlar', done: Number(counts.stations) > 0,
      help: 'Mutfak ve bar fişlerinin çıkacağı yerler.' },
    { id: 'kategori', label: 'Menü kategorileri', done: Number(counts.categories) > 0,
      help: 'Menü başlıkları. Hazır şablonlardan başlayabilirsiniz.' },
    { id: 'urun', label: 'Ürünler', done: Number(counts.products) > 0,
      help: 'Elle ekleyin veya mevcut fiyat listenizi içe aktarın.' },
    { id: 'masa', label: 'Masalar', done: Number(counts.tables) > 0, help: 'Salondaki masalar.' },
    { id: 'personel', label: 'Personel', done: Number(counts.staff) > 0, help: 'Kasiyer ve garson hesapları.' },
    { id: 'yazici', label: 'Yazıcı', done: Number(counts.printers) > 0, help: 'Fiş yazıcısı.' },
    { id: 'qr', label: 'Dijital menü', done: !!(await db.one('SELECT client_id FROM qr_menu_settings WHERE client_id=?', [clientId])),
      help: 'Masadaki karekodun açtığı menü.' },
    { id: 'sadakat', label: 'Sadakat programı', done: Number(counts.programs) > 0,
      help: 'İsteğe bağlı - kaç alana bir bedava.' },
  ];

  return {
    counts,
    steps,
    done: steps.filter(s => s.done).length,
    total: steps.length,
    setup_done: String(await db.getSetting('setup_done', '0')) === '1',
    vat: {
      rates,
      default_rate: Number(await db.getSetting(VAT_DEFAULT_KEY, 10)),
      catalogue: VAT_RATES,
    },
    general: {
      currency: await db.getSetting('currency', 'TRY'),
      currency_symbol: await db.getSetting('currency_symbol', '₺'),
      business_day_start: await db.getSetting('business_day_start', '06:00'),
    },
  };
}

/**
 * KDV rates.
 *
 * Stored as settings rather than as a table: a rate is a number the product
 * form offers, not an entity anything points at. `vat_rate` on the product is
 * and stays the source of truth for what a line is actually taxed at, so
 * changing this list never silently re-taxes anything already sold.
 */
async function saveVat(clientId, { rates, default_rate }) {
  const legal = VAT_RATES.map(v => v.rate);
  const list = (Array.isArray(rates) ? rates : String(rates || '').split(','))
    .map(v => Number(String(v).trim()))
    .filter(n => Number.isFinite(n));
  if (!list.length) throw bad('En az bir KDV oranı seçin');
  for (const n of list) {
    if (!legal.includes(n)) throw bad(`%${n} geçerli bir KDV oranı değil (${legal.join(', ')})`);
  }
  const def = Number(default_rate);
  if (!list.includes(def)) throw bad('Varsayılan oran, seçilen oranlar arasında olmalı');

  await db.setSetting(VAT_LIST_KEY, Array.from(new Set(list)).sort((a, b) => a - b).join(','));
  await db.setSetting(VAT_DEFAULT_KEY, String(def));
  log.info('guest', 'KDV oranlari kaydedildi', { rates: list, default: def });
  return { rates: list, default_rate: def };
}

/**
 * Currency and the business-day roll hour.
 *
 * Written through settings.save() rather than db.setSetting() so the keys are
 * validated by the same catalogue the Ayarlar screen uses and the change lands
 * in np_settings_log. A wizard that wrote settings by a private back door is
 * how two screens end up disagreeing about what the currency is.
 */
async function saveGeneral(clientId, body = {}, userId = null) {
  const settings = require('./settings');
  const patch = {};
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.currency_symbol !== undefined) patch.currency_symbol = body.currency_symbol;
  if (body.business_day_start !== undefined) patch.business_day_start = body.business_day_start;
  if (!Object.keys(patch).length) throw bad('Kaydedilecek bir şey yok');
  const out = await settings.save(clientId, patch, userId);
  // a separate marker, because "06:00" is also the default - without it the
  // checklist could never tell "chosen" from "never asked"
  if (patch.business_day_start !== undefined) await db.setSetting('business_day_start_set', '1');
  return out;
}

/**
 * The menu-import step: read a spreadsheet, say what it would do.
 *
 * All of the actual work is portage.js - the same reader, the same plan, the
 * same apply the Ürünler screen uses. This exists so the wizard can offer it
 * at the moment it matters (before anybody has typed a single product) rather
 * than after they have typed three hundred.
 */
async function importMenuPreview(clientId, { filename, content_base64, kind = 'products' }) {
  if (!content_base64) throw bad('Dosya gönderilmedi');
  if (!['products', 'categories'].includes(kind)) throw bad('Bilinmeyen dosya türü');
  const buf = Buffer.from(String(content_base64), 'base64');
  if (!buf.length) throw bad('Dosya boş');
  const rows = await portage.readFile(kind, buf, filename || '');
  const { plan, summary } = await portage.planImport(clientId, kind, rows);
  return { plan, summary, rows: rows.length, kind };
}

async function importMenuApply(clientId, { filename, content_base64, kind = 'products' }, userId) {
  const { plan, summary } = await importMenuPreview(clientId, { filename, content_base64, kind });
  const result = await portage.applyImport(clientId, kind, plan, userId);
  log.info('guest', 'kurulum sihirbazi menuyu ice aktardi',
    { kind, created: result.created, updated: result.updated });
  return { ...result, summary };
}

/**
 * Category templates.
 *
 * The old wizard's three presets, kept because they are the difference between
 * a screen a new owner can finish in ten seconds and a blank form. They ADD;
 * nothing is deleted, so pressing one twice is untidy rather than destructive.
 */
const CATEGORY_PRESETS = {
  kafe: ['Sıcak İçecek', 'Soğuk İçecek', 'Tatlı', 'Atıştırmalık', 'Kahvaltı'],
  restoran: ['Başlangıç', 'Çorba', 'Ana Yemek', 'Izgara', 'Salata', 'Tatlı', 'İçecek'],
  bar: ['Kokteyl', 'Bira', 'Şarap', 'Yüksek Alkol', 'Meze', 'Alkolsüz'],
};

async function applyCategoryPreset(clientId, set) {
  const names = CATEGORY_PRESETS[String(set || '').toLowerCase()];
  if (!names) throw bad('Bilinmeyen şablon: ' + set);
  const have = await db.query('SELECT name FROM categories WHERE client_id=?', [clientId]);
  const seen = new Set(have.map(c => portage.normaliseHeader(c.name)));
  let base = Number(await db.value('SELECT COALESCE(MAX(sort_order),0) FROM categories WHERE client_id=?', [clientId]));
  let created = 0;
  for (const name of names) {
    if (seen.has(portage.normaliseHeader(name))) continue;   // adding twice is a no-op
    await db.exec(
      'INSERT INTO categories (client_id, name, sort_order, is_active, use_in_pos, use_in_qr) VALUES (?,?,?,1,1,1)',
      [clientId, name, ++base]);
    created++;
  }
  return { created, skipped: names.length - created };
}

module.exports = {
  // dijital menu
  publicMenu, previewMenu, qrSettings, saveQrSettings, qrFlags, setQrFlag, setCategoryQrBulk,
  guestCatalog, slugify, saveDesign,
  // sablonlar - the card printer and the picker both read this list
  MENU_TEMPLATES, CARD_DESIGNS, templateKey, cardKey, DEFAULT_TEMPLATE, DEFAULT_CARD,
  // musteriler
  searchCustomers, saveCustomer, customerDetail, attachToOrder, topCustomers,
  // sadakat
  programList, saveProgram, toggleProgram, cardList, loyaltyReport,
  manualStamp, manualRedeem, cardHistory,
  // kurulum
  setupState, saveVat, saveGeneral, importMenuPreview, importMenuApply,
  applyCategoryPreset, VAT_RATES, CATEGORY_PRESETS,
};
