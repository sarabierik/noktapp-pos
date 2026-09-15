'use strict';
/**
 * The restaurant itself: who works there, what it sells, where the tables are.
 *
 * Everything in here is what a real installation would have typed in during
 * setup. It is written BEFORE a single bill exists, and it is what the trading
 * history is then hung on.
 *
 * The one thing that is not obvious: prices are walked BACKWARDS. A menu whose
 * Adana Kebap costs 420 TL in 2020 as well as 2026 makes every year-on-year
 * report meaningless and every 2020 receipt absurd. So the 2026 price is the
 * anchor and each earlier year is divided by that year's inflation, which is
 * also what fills the price history screens with something worth reading.
 */
const bcrypt = require('bcryptjs');
const auth = require('../auth');
const { bulk, _ymd, menuRound, money } = require('./lib');
const D = require('./data');

/* Turkish food inflation, year by year, as the restaurant lived it. */
const INFLATION = { 2021: 1.25, 2022: 1.80, 2023: 1.65, 2024: 1.45, 2025: 1.30, 2026: 1.22 };

/** Multiply a 2026 price by this to get that year's price. */
function priceIndex(year) {
  let f = 1;
  for (let y = year + 1; y <= 2026; y++) f *= (INFLATION[y] || 1.2);
  return 1 / f;
}

async function build(ctx) {
  const { db, clientId } = ctx;

  /* ------------------------------------------------------------ the client */
  await db.exec(
    `UPDATE clients SET company_name=?, owner_name=?, full_address=?, phone=?, tax_number=?,
        tax_office=?, contact_name=?, contact_phone=?, setup_done=1,
        receipt_header=?, receipt_footer=? WHERE client_id=?`,
    ['Kaleiçi Ocakbaşı', 'Erdal Sarıkaya',
     'Barbaros Mah. Hıdırlık Sokak No:12, Kaleiçi, Muratpaşa / ANTALYA',
     '02421234567', '4560123789', 'Antalya Kurumlar', 'Erdal Sarıkaya', '5321234567',
     'KALEİÇİ OCAKBAŞI\nBarbaros Mah. Hıdırlık Sk. No:12\nKaleiçi / ANTALYA',
     'Afiyet olsun - tekrar bekleriz\nwww.kaleiciocakbasi.com', clientId]);

  await db.exec(
    `INSERT INTO business_settings (client_id, business_name, legal_name, tax_number, tax_office,
        address_line1, city, phone, email, website, instagram, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE business_name=VALUES(business_name), legal_name=VALUES(legal_name),
        tax_number=VALUES(tax_number), tax_office=VALUES(tax_office),
        address_line1=VALUES(address_line1), city=VALUES(city), phone=VALUES(phone),
        email=VALUES(email), website=VALUES(website), instagram=VALUES(instagram)`,
    [clientId, 'Kaleiçi Ocakbaşı', 'Sarıkaya Gıda Turizm Ltd. Şti.', '4560123789',
     'Antalya Kurumlar', 'Barbaros Mah. Hıdırlık Sokak No:12, Kaleiçi', 'Antalya',
     '02421234567', 'bilgi@kaleiciocakbasi.com', 'www.kaleiciocakbasi.com', 'kaleiciocakbasi']);

  /* ------------------------------------------------------------- the staff */
  ctx.users = {};
  ctx.staff = [];
  for (const [username, name, role, pin, pass, perms] of D.STAFF) {
    const id = await db.insert(
      `INSERT INTO users (client_id, username, email, display_name, role, password_hash, pin_hash,
          created_at, updated_at, is_active)
       VALUES (?,?,?,?,?,?,?,?, NOW(), 1)`,
      [clientId, username, username + '@kaleiciocakbasi.com', name, role,
       bcrypt.hashSync(pass, 10), bcrypt.hashSync(pin, 10),
       (D.STAFF_TENURE[username] || ['2020-01-01'])[0] + ' 09:00:00']);
    if (perms) await auth.setPermissions(clientId, id, perms, null);
    const [from, to] = D.STAFF_TENURE[username] || ['2020-01-01', null];
    const u = { id, username, name, role, from, to, pin };
    ctx.users[username] = u;
    ctx.staff.push(u);
  }
  /* the ones who carry a handheld and take orders */
  ctx.waiters = ctx.staff.filter(u => u.role === 'waiter' || u.role === 'cashier');
  ctx.cashiers = ctx.staff.filter(u => u.role === 'cashier' || u.role === 'admin');

  /* ----------------------------------------------------------- the kitchen */
  ctx.stations = [];
  for (let i = 0; i < D.STATIONS.length; i++) {
    const name = D.STATIONS[i];
    const id = await db.insert(
      'INSERT INTO stations (client_id, name, display_name, is_default, is_active, sort_order, output_mode) ' +
      'VALUES (?,?,?,?,1,?,?)',
      [clientId, name, name, i === 0 ? 1 : 0, i + 1, name === 'Bar' ? 'printer' : 'both']);
    ctx.stations.push({ id, name });
    await db.exec(
      'INSERT INTO printers (client_id, station_id, name, type, ip_address, is_default, created_at, paper_width) ' +
      'VALUES (?,?,?,?,?,?, NOW(), 80)',
      [clientId, id, name + ' yazıcı', 'network', '192.168.1.' + (20 + i), i === 0 ? 1 : 0]);
  }
  const stationId = (n) => (ctx.stations.find(s => s.name === n) || ctx.stations[0]).id;

  /* ------------------------------------------------------------- the floor */
  ctx.zones = [];
  ctx.tables = [];
  let zoneSort = 1;
  for (const [zname, prefix, count, seats] of D.ZONES) {
    const zid = await db.insert(
      'INSERT INTO table_zones (client_id, name, sort_order, is_active) VALUES (?,?,?,1)',
      [clientId, zname, zoneSort++]);
    ctx.zones.push({ id: zid, name: zname });
    for (let i = 1; i <= count; i++) {
      const tid = await db.insert(
        'INSERT INTO restaurant_tables (client_id, zone_id, name, status, sort_order, is_occupied, is_active, seats) ' +
        "VALUES (?,?,?,'empty',?,0,1,?)",
        [clientId, zid, prefix + i, i, seats[i - 1] || 4]);
      ctx.tables.push({ id: tid, zone: zname, name: prefix + i, seats: seats[i - 1] || 4 });
    }
  }

  /* -------------------------------------------------------------- the menu */
  ctx.cats = [];
  ctx.products = [];
  let csort = 1;
  for (const [cname, station, items] of D.MENU) {
    const cid = await db.insert(
      'INSERT INTO categories (client_id, station_id, name, sort_order, is_active, use_in_pos, use_in_qr) ' +
      'VALUES (?,?,?,?,1,1,1)',
      [clientId, stationId(station), cname, csort++]);
    ctx.cats.push({ id: cid, name: cname, station_id: stationId(station) });
    let psort = 1;
    for (const [name, price, cost, vat] of items) {
      const pid = await db.insert(
        `INSERT INTO products (client_id, category_id, name, price, cost_price, sort_order,
            is_active, use_in_pos, use_in_qr, vat_rate, track_stock)
         VALUES (?,?,?,?,?,?,1,1,1,?,?)`,
        [clientId, cid, name, price, cost, psort++, vat, cname === 'İçecekler' ? 1 : 0]);
      ctx.products.push({
        id: pid, name, price, cost, vat, category_id: cid, catName: cname,
        station_id: stationId(station), weight: D.CATEGORY_WEIGHT[cname] || 10,
      });
    }
  }

  /* --------------------------------------------- seven years of price rises */
  /*
   * One row per product per year, on the day the owner actually re-priced:
   * the first working day of January, plus a mid-year correction in the two
   * years when the lira moved fastest. This is what the Ürün kartı price
   * history and the "fiyat değişimi" log read.
   */
  const RAISE_DAYS = [];
  for (let y = 2020; y <= 2026; y++) {
    RAISE_DAYS.push([y, `${y}-01-06`]);
    if (y === 2022 || y === 2023) RAISE_DAYS.push([y + 0.5, `${y}-07-04`]);
  }
  const hist = [], log = [], costs = [];
  const owner = ctx.users.erdal.id;
  for (const p of ctx.products) {
    let prev = null;
    for (const [yKey, day] of RAISE_DAYS) {
      const year = Math.floor(yKey);
      /* a mid-year correction is half of that year's rise, already applied */
      const half = yKey % 1 !== 0;
      const idx = priceIndex(year) * (half ? Math.sqrt(INFLATION[year + 1] || 1.2) : 1);
      const price = menuRound(p.price * idx);
      const cost = money(p.cost * idx);
      if (prev !== null && price !== prev) {
        log.push({ client_id: clientId, product_id: p.id, old_price: prev, new_price: price,
          source: 'manual', changed_by: owner, changed_at: day + ' 09:20:00' });
      }
      hist.push({ client_id: clientId, product_id: p.id, price,
        effective_date: day, created_at: day + ' 09:20:00', created_by: owner });
      costs.push({ client_id: clientId, product_id: p.id, cost, currency: 'TRY',
        effective_date: day, created_at: day + ' 09:20:00', created_by: owner,
        note: half ? 'Yıl ortası maliyet güncellemesi' : 'Yıllık maliyet güncellemesi' });
      prev = price;
    }
    p.priceByYear = {};
    p.costByYear = {};
    for (let y = 2020; y <= 2026; y++) {
      p.priceByYear[y] = menuRound(p.price * priceIndex(y));
      p.costByYear[y] = money(p.cost * priceIndex(y));
    }
  }
  await bulk(db, 'product_price_history', ['client_id', 'product_id', 'price', 'effective_date', 'created_at', 'created_by'], hist);
  await bulk(db, 'price_change_log', ['client_id', 'product_id', 'old_price', 'new_price', 'source', 'changed_by', 'changed_at'], log);
  await bulk(db, 'product_costs', ['client_id', 'product_id', 'cost', 'currency', 'effective_date', 'created_at', 'created_by', 'note'], costs);

  /* --------------------------------------------------- drink stock on hand */
  const stock = ctx.products.filter(p => p.catName === 'İçecekler').map(p => ({
    client_id: clientId, product_id: p.id,
    quantity: 40 + Math.floor(ctx.rand() * 160), stock: 40 + Math.floor(ctx.rand() * 160),
  }));
  await bulk(db, 'product_stock', ['client_id', 'product_id', 'quantity', 'stock'], stock);

  /* ---------------------------------------------------------- the settings */
  const S = {
    setup_done: '1', business_name: 'Kaleiçi Ocakbaşı', currency: 'TRY',
    service_charge: '0', kdv_dahil: '1', day_start_hour: '6',
    receipt_footer: 'Afiyet olsun - tekrar bekleriz',
    lan_enabled: '1', qr_menu_enabled: '1', loyalty_enabled: '1',
    delivery_enabled: '1', inventory_enabled: '1', pricing_enabled: '1',
    fiscal_enabled: '0', demo_data: '1',
  };
  for (const [k, v] of Object.entries(S)) await db.setSetting(k, v);

  await db.exec(
    `INSERT INTO qr_menu_settings (client_id, slug, business_name, about, phone, instagram_url,
        website_url, currency, theme, is_published, show_prices, welcome_text, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,1,?, NOW())
     ON DUPLICATE KEY UPDATE is_published=1, business_name=VALUES(business_name)`,
    [clientId, 'kaleici-ocakbasi', 'Kaleiçi Ocakbaşı',
     '1998’den beri Kaleiçi’nde odun ateşinde kebap. Etlerimiz günlük, ekmeğimiz taş fırından.',
     '02421234567', 'kaleiciocakbasi', 'www.kaleiciocakbasi.com', 'TRY', 'dark',
     'Hoş geldiniz - menümüzü inceleyin, siparişinizi garsonumuza iletin.']);

  await db.exec(
    `INSERT INTO np_display_settings (id, template, headline, subline, show_logo, enabled,
        foot_note, qr_enabled, qr_caption, social_enabled, social_instagram)
     VALUES (1,'klasik','Hoş geldiniz','Kaleiçi Ocakbaşı',1,1,'Afiyet olsun',1,'Menü için okutun',1,'kaleiciocakbasi')
     ON DUPLICATE KEY UPDATE enabled=1, headline=VALUES(headline), subline=VALUES(subline)`);

  const RATES = [['USD', 'Amerikan Doları', '$', 47.2150], ['EUR', 'Euro', '€', 55.4080],
                 ['GBP', 'İngiliz Sterlini', '£', 63.1200], ['RUB', 'Rus Rublesi', '₽', 0.5140]];
  for (let i = 0; i < RATES.length; i++) {
    const [code, name, sym, rate] = RATES[i];
    await db.exec(
      'INSERT INTO doviz_kurlari (client_id, code, name, symbol, rate, is_active, sort_order, ' +
      'rate_updated_at, updated_by, created_at) VALUES (?,?,?,?,?,1,?, NOW(), ?, NOW()) ' +
      'ON DUPLICATE KEY UPDATE rate=VALUES(rate), rate_updated_at=NOW()',
      [clientId, code, name, sym, rate, i + 1, owner]);
  }

  await db.exec(
    'INSERT INTO cash_registers (client_id, branch_id, name, code, is_active, created_at, updated_at) ' +
    "VALUES (?,1,'Ana Kasa','KASA1',1, NOW(), NOW())", [clientId]);

  ctx.log(`katalog: ${ctx.staff.length} personel, ${ctx.zones.length} bölge, ` +
    `${ctx.tables.length} masa, ${ctx.cats.length} kategori, ${ctx.products.length} ürün`);
}

module.exports = { build, priceIndex, INFLATION };
