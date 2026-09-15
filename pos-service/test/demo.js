'use strict';
/**
 * DEMO — a restaurant that looks like a restaurant.
 *
 * The suites seed the smallest fixture each check needs, which is right for a
 * test and wrong for a photograph: six tables, one of them busy, and half a
 * screen of white underneath. Every screenshot taken from that database says
 * "empty demo" to anybody being sold the product.
 *
 * This fills one evening's service at a real-sized ocakbaşı — three rooms,
 * twenty-six tables, a menu of forty-one items, four people on shift, an hour
 * of open bills at different stages, a day of closed ones behind them, the
 * kitchen mid-service, couriers out, platform orders arriving, regulars with
 * stamps on their cards, and stock that is running down.
 *
 * It is NOT part of the test bench. Nothing asserts; it is a fixture for
 * screenshots and for showing the product to somebody.
 *
 *   NOKTAPP_DATA_DIR=/tmp/nokdata node test/demo.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7490';
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
let T = null;

async function api(method, path, body, token = T) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}
const say = (s) => console.log('  ' + s);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const between = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

/* ------------------------------------------------------------ the menu */
const MENU = [
  ['Başlangıçlar', [
    ['Mercimek Çorbası', 95], ['Humus', 140], ['Haydari', 120], ['Acılı Ezme', 120],
    ['Muhammara', 150], ['Sigara Böreği (6 adet)', 165], ['Zeytinyağlı Yaprak Sarma', 155],
  ]],
  ['Ocakbaşı', [
    ['Adana Kebap', 420], ['Urfa Kebap', 420], ['Kuzu Şiş', 520], ['Tavuk Şiş', 360],
    ['Kaburga', 560], ['Ciğer Şiş', 390], ['Beyti Sarma', 540], ['Karışık Izgara', 720],
    ['Patlıcan Kebap', 480], ['Kanat (8 adet)', 340],
  ]],
  ['Pide ve Lahmacun', [
    ['Kıymalı Pide', 260], ['Kaşarlı Pide', 250], ['Kuşbaşılı Kaşarlı Pide', 320],
    ['Lahmacun', 110], ['Etli Ekmek', 280],
  ]],
  ['Salata ve Meze', [
    ['Çoban Salata', 150], ['Gavurdağı Salata', 180], ['Roka Salata', 140], ['Mevsim Salata', 150],
  ]],
  ['İçecekler', [
    ['Ayran (30 cl)', 60], ['Şalgam', 65], ['Kola (33 cl)', 75], ['Soda', 45],
    ['Su (50 cl)', 30], ['Çay', 35], ['Türk Kahvesi', 90], ['Limonata', 85],
    ['Taze Sıkma Portakal', 120],
  ]],
  ['Tatlılar', [
    ['Künefe', 260], ['Fıstıklı Baklava (4 dilim)', 290], ['Sütlaç', 160],
    ['Kazandibi', 170], ['Dondurma (2 top)', 120], ['Kadayıf', 250],
  ]],
];

const ZONES = [
  ['Salon', 'S', 1, 12],
  ['Bahçe', 'B', 1, 8],
  ['Teras', 'T', 1, 6],
];

const GUESTS = [
  ['Ayşe', 'Kaya', '5321110011'], ['Mehmet', 'Demir', '5322220022'],
  ['Zeynep', 'Yılmaz', '5323330033'], ['Ali', 'Çelik', '5324440044'],
  ['Fatma', 'Şahin', '5325550055'], ['Emre', 'Aydın', '5326660066'],
  ['Selin', 'Koç', '5327770077'], ['Burak', 'Arslan', '5328880088'],
];

const STREETS = ['Barbaros Cd.', 'Atatürk Bul.', 'Karanfil Sk.', 'Zambak Sk.',
  'İstiklal Cd.', 'Gül Sk.', 'Menekşe Sk.', 'Cumhuriyet Cd.'];

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - demo restoranı kuruluyor\n');

  T = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'İşletme Sahibi', kind: 'tenant' });

  /* ------------------------------------------------------- clean slate */
  say('önceki demo temizleniyor…');
  await db.exec('DELETE FROM daily_closings WHERE client_id=?', [CID]);
  await db.exec("UPDATE pos_shifts SET status='closed', closed_at=NOW() WHERE client_id=? AND status='open'", [CID]);
  await db.exec("UPDATE orders SET status='cancelled', is_closed=1, exclude_from_reports=1 WHERE client_id=? AND status='open'", [CID]);
  await db.exec("UPDATE table_groups SET status='closed', closed_at=NOW() WHERE client_id=? AND status='open'", [CID]);
  await db.exec('UPDATE table_group_members SET left_at=NOW() WHERE client_id=? AND left_at IS NULL', [CID]);
  await db.exec('UPDATE restaurant_tables SET is_occupied=0 WHERE client_id=?', [CID]);
  await db.setSetting('setup_done', '1');
  await db.exec("UPDATE clients SET company_name='Kaleiçi Ocakbaşı', receipt_header='KALEİÇİ OCAKBAŞI', " +
    "receipt_footer='Afiyet olsun — yine bekleriz', phone='0242 247 10 10', " +
    "full_address='Kaleiçi Mah. Uzun Çarşı Sk. No:14, Muratpaşa / Antalya', " +
    "tax_office='Muratpaşa', tax_number='4830261597' WHERE id=?", [CID]);

  /* ------------------------------------------------------------- staff */
  say('personel…');
  const staff = [
    ['erik', 'Erik Yönetici', 'admin', '4321'],
    ['mehmet', 'Mehmet Kasiyer', 'cashier', '1234'],
    ['ayse', 'Ayşe Garson', 'waiter', '2345'],
    ['can', 'Can Garson', 'waiter', '3456'],
    ['derya', 'Derya Garson', 'waiter', '4567'],
  ];
  const UID = {};
  for (const [u, name, role, pin] of staff) {
    const e = await db.one('SELECT id FROM users WHERE client_id=? AND username=?', [CID, u]);
    if (e) {
      await db.exec('UPDATE users SET display_name=?, role=?, pin_hash=?, password_hash=?, is_active=1, ' +
        'pin_fail_count=0, pin_locked_until=NULL WHERE id=?',
        [name, role, auth.hash(pin), auth.hash('Sifre1234'), e.id]);
      UID[u] = e.id;
    } else {
      UID[u] = await db.insert(
        `INSERT INTO users (client_id, username, email, display_name, role, password_hash, pin_hash,
            created_at, updated_at, is_active) VALUES (?,?,?,?,?,?,?, NOW(), NOW(), 1)`,
        [CID, u, u + '@kaleici.local', name, role, auth.hash('Sifre1234'), auth.hash(pin)]);
    }
  }

  /* ------------------------------------------------------------- floor */
  say('salon, bahçe, teras…');
  await db.exec('UPDATE restaurant_tables SET is_active=0 WHERE client_id=?', [CID]);
  /* The suites leave their own zones behind - "Rol Kaza", a second and third
     "Salon" - and every one of them draws a tab on the floor screen, most of
     them empty. A demo restaurant has three rooms and three tabs. */
  await db.exec('UPDATE table_zones SET is_active=0 WHERE client_id=?', [CID]);
  const TABLES = [];
  let zsort = 0;
  for (const [zname, prefix, from, to] of ZONES) {
    zsort++;
    let z = await db.one('SELECT id FROM table_zones WHERE client_id=? AND name=? ORDER BY id LIMIT 1', [CID, zname]);
    if (!z) z = { id: await db.insert('INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,?,1)',
      [CID, zname, zsort]) };
    await db.exec('UPDATE table_zones SET is_active=1, sort_order=? WHERE id=?', [zsort, z.id]);
    for (let i = from; i <= to; i++) {
      const name = `${prefix}${i}`;
      const ex = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? AND name=?', [CID, name]);
      const id = ex ? ex.id : await db.insert(
        'INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active,is_occupied,seats,qr_token) ' +
        'VALUES (?,?,?,?,1,0,?,?)', [CID, z.id, name, i, between(2, 6), require('crypto').randomBytes(9).toString('hex')]);
      await db.exec('UPDATE restaurant_tables SET zone_id=?, is_active=1, is_occupied=0, seats=? WHERE id=?',
        [z.id, between(2, 6), id]);
      TABLES.push({ id, name, zone: zname });
    }
  }
  say(`  ${TABLES.length} masa`);

  /* -------------------------------------------------------------- menu */
  say('menü…');
  await db.exec('UPDATE products SET is_active=0 WHERE client_id=?', [CID]);
  await db.exec('UPDATE categories SET is_active=0 WHERE client_id=?', [CID]);
  const stations = await db.query('SELECT id, name FROM stations WHERE client_id=?', [CID]);
  const kitchen = stations.find(s => /mutfak|kitchen|ocak/i.test(s.name)) || stations[0];
  const bar = stations.find(s => /bar|icecek/i.test(s.name)) || kitchen;
  const P = [];
  let csort = 0;
  for (const [cname, items] of MENU) {
    csort++;
    const st = /İçecek/.test(cname) ? bar : kitchen;
    let c = await db.one('SELECT id FROM categories WHERE client_id=? AND name=?', [CID, cname]);
    if (!c) c = { id: await db.insert(
      'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr,station_id) VALUES (?,?,?,1,1,1,?)',
      [CID, cname, csort, st ? st.id : null]) };
    await db.exec('UPDATE categories SET is_active=1, use_in_pos=1, use_in_qr=1, sort_order=?, station_id=? WHERE id=?',
      [csort, st ? st.id : null, c.id]);
    let psort = 0;
    for (const [pname, price] of items) {
      psort++;
      const cost = Math.round(price * (0.30 + Math.random() * 0.12) * 100) / 100;
      const ex = await db.one('SELECT id FROM products WHERE client_id=? AND name=?', [CID, pname]);
      const id = ex ? ex.id : await db.insert(
        'INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,is_active,use_in_pos,use_in_qr,sort_order) ' +
        'VALUES (?,?,?,?,?,10,1,1,1,?)', [CID, c.id, pname, price, cost, psort]);
      await db.exec('UPDATE products SET category_id=?, price=?, cost_price=?, vat_rate=10, is_active=1, ' +
        'use_in_pos=1, use_in_qr=1, sort_order=? WHERE id=?', [c.id, price, cost, psort, id]);
      P.push({ id, name: pname, price, cat: cname });
    }
  }
  say(`  ${P.length} ürün, ${MENU.length} kategori`);
  const food = P.filter(p => !/İçecek/.test(p.cat));
  const drink = P.filter(p => /İçecek/.test(p.cat));
  const sweet = P.filter(p => /Tatlı/.test(p.cat));

  /* ------------------------------------------------------------ guests */
  say('müşteriler ve sadakat kartları…');
  for (const [first, last, phone] of GUESTS) {
    const ex = await db.one('SELECT id FROM customers WHERE phone=?', [phone]);
    if (!ex) {
      await db.insert(
        `INSERT INTO customers (first_name,last_name,phone,email,qr_uid,is_verified,is_active,
            created_by_client_id,created_at,updated_at)
         VALUES (?,?,?,?,?,1,1,?,NOW(),NOW())`,
        [first, last, phone, null, require('crypto').randomBytes(12).toString('hex'), CID]);
    }
  }

  const bd = require('../src/util/businessDay');
  const today = await bd.currentBusinessDate();

  /* ------------------------------------------------------------- shift */
  say('vardiya açılıyor…');
  await api('POST', '/api/pos/shift/open', { opening_float: 2500 });

  /* --------------------------------------------- the day already traded */
  say('gün içi kapanmış adisyonlar…');
  let closed = 0;
  for (let i = 0; i < 38; i++) {
    const t = pick(TABLES);
    const r = await api('POST', '/api/pos/orders', { table_id: t.id });
    if (!r.order_id) continue;
    const n = between(2, 5);
    for (let k = 0; k < n; k++) {
      const p = pick(k === 0 ? food : (Math.random() < 0.5 ? drink : P));
      await api('POST', `/api/pos/orders/${r.order_id}/items`, { product_id: p.id, qty: between(1, 3) });
    }
    if (Math.random() < 0.25) await api('POST', `/api/pos/orders/${r.order_id}/items`, { product_id: pick(sweet).id, qty: 1 });
    await api('POST', `/api/pos/orders/${r.order_id}/send`);
    if (Math.random() < 0.18) {
      await api('POST', `/api/pos/orders/${r.order_id}/discount`,
        { percent: pick([5, 10, 15]), reason: pick(['Sadık müşteri', 'Personel indirimi', 'İkram']) });
    }
    const o = (await api('GET', `/api/pos/orders/${r.order_id}`)).order;
    const total = Number(o.grand_total);
    const method = Math.random() < 0.42 ? 'nakit' : (Math.random() < 0.9 ? 'kredi_karti' : 'yemek_karti');
    await api('POST', `/api/pos/orders/${r.order_id}/payments`, { method, amount: total });
    /* spread the evening out so the hourly curve is a curve */
    const hour = between(12, 22);
    const min = between(0, 59);
    await db.exec(
      'UPDATE orders SET opened_at=CONCAT(?," ",LPAD(?,2,"0"),":",LPAD(?,2,"0"),":00"), ' +
      'closed_at=DATE_ADD(CONCAT(?," ",LPAD(?,2,"0"),":",LPAD(?,2,"0"),":00"), INTERVAL ? MINUTE) WHERE id=?',
      [today, hour, min, today, hour, min, between(25, 70), r.order_id]);
    closed++;
  }
  say(`  ${closed} adisyon kapandı`);

  /* -------------------------------------------------- service, right now */
  say('şu an açık masalar…');
  const busy = TABLES.filter(() => Math.random() < 0.42).slice(0, 11);
  const openBills = [];
  for (const t of busy) {
    const r = await api('POST', '/api/pos/orders', { table_id: t.id });
    if (!r.order_id) continue;
    for (let k = 0; k < between(2, 6); k++) {
      const p = pick(k === 0 ? food : P);
      await api('POST', `/api/pos/orders/${r.order_id}/items`,
        { product_id: p.id, qty: between(1, 3), note: Math.random() < 0.2 ? pick(['az acılı', 'acısız', 'buzsuz', 'iyi pişmiş']) : undefined });
    }
    /* most are already with the kitchen; a couple are still being taken */
    if (Math.random() < 0.78) await api('POST', `/api/pos/orders/${r.order_id}/send`);
    openBills.push(r.order_id);
  }
  say(`  ${openBills.length} açık adisyon`);

  /* a second party on one table, and two tables pushed together */
  if (busy.length > 3) {
    const second = await api('POST', '/api/pos/orders', { table_id: busy[0].id });
    if (second.order_id) {
      await api('POST', `/api/pos/orders/${second.order_id}/items`, { product_id: pick(food).id, qty: 2 });
      await api('POST', `/api/pos/orders/${second.order_id}/send`);
    }
    await api('POST', '/api/pos/table-groups', { table_ids: [busy[1].id, busy[2].id], name: 'Doğum günü' });
  }

  /* the kitchen mid-service: some tickets started, one plated */
  const tickets = await db.query(
    "SELECT id FROM station_projection_items WHERE client_id=? AND station_status='new' ORDER BY id LIMIT 40", [CID]);
  for (let i = 0; i < tickets.length; i++) {
    if (i % 3 === 0) await db.exec("UPDATE station_projection_items SET station_status='preparing' WHERE id=?", [tickets[i].id]);
    else if (i % 7 === 0) await db.exec("UPDATE station_projection_items SET station_status='ready' WHERE id=?", [tickets[i].id]);
  }

  /* ------------------------------------------------------ paket servis */
  say('paket servis, kuryeler…');
  const couriers = ['Hasan Kurye', 'Okan Kurye', 'Serkan Kurye'];
  for (const name of couriers) {
    await api('POST', '/api/delivery/couriers', { name, phone: '05' + between(300000000, 399999999) })
      .catch(() => {});
  }
  await api('POST', '/api/delivery/zones', { name: 'Kaleiçi', fee: 0, minutes: 25 }).catch(() => {});
  await api('POST', '/api/delivery/zones', { name: 'Lara', fee: 49.9, minutes: 40 }).catch(() => {});
  await api('POST', '/api/delivery/zones', { name: 'Konyaaltı', fee: 69.9, minutes: 50 }).catch(() => {});
  for (let i = 0; i < 7; i++) {
    const g = pick(GUESTS);
    const body = {
      customer: { name: g[0] + ' ' + g[1], phone: g[2] },
      address_text: `${pick(STREETS)} No:${between(2, 90)} D:${between(1, 12)}`,
      items: Array.from({ length: between(1, 3) }, () => ({ product_id: pick(food).id, qty: between(1, 2) })),
      note: Math.random() < 0.3 ? 'Zili çalmayın' : undefined,
    };
    await api('POST', '/api/delivery/orders', body).catch(() => {});
  }

  /* ------------------------------------------------------------- stock */
  say('stok…');
  const levels = await db.query('SELECT id FROM products WHERE client_id=? AND is_active=1 ORDER BY RAND() LIMIT 14', [CID]);
  for (const p of levels) {
    await api('POST', '/api/pos/stock/' + p.id, { quantity: between(2, 60) }).catch(() => {});
  }

  /* ----------------------------------------------------------- sadakat */
  say('sadakat programı ve kartlar…');
  const kunefe = P.find(x => /Künefe/.test(x.name));
  const cay = P.find(x => /Çay/.test(x.name));
  for (const [title, product, target, reward] of [
    ['Çay kartı', cay, 10, '11. çay bizden'],
    ['Tatlı kartı', kunefe, 8, '9. künefe ikram'],
  ]) {
    await api('POST', '/api/manage/loyalty/programs',
      { title, product_id: product ? product.id : null, target_count: target, reward_text: reward, is_active: 1 })
      .catch(() => {});
  }
  /* a few regulars part-way through a card */
  const progs = (await api('GET', '/api/manage/loyalty/programs')).programs || [];
  for (const g of GUESTS.slice(0, 6)) {
    const cust = await db.one('SELECT id FROM customers WHERE phone=?', [g[2]]);
    if (!cust) continue;
    for (const pr of progs) {
      const have = await db.one('SELECT id FROM loyalty_cards WHERE client_id=? AND customer_id=? AND program_id=?',
        [CID, cust.id, pr.id]).catch(() => null);
      if (have) continue;
      await db.insert(
        'INSERT INTO loyalty_cards (client_id,customer_id,program_id,stamps,is_complete,created_at,updated_at) ' +
        'VALUES (?,?,?,?,0,NOW(),NOW())', [CID, cust.id, pr.id, between(1, pr.target_count - 1)]).catch(() => {});
    }
  }

  /* --------------------------------------------------------- QR menü */
  say('QR menü yayınlanıyor…');
  await api('POST', '/api/qr/settings', {
    slug: 'kaleici-ocakbasi', business_name: 'Kaleiçi Ocakbaşı',
    about: 'Kaleiçi\'nde ocakbaşı. Her gün 12:00 - 24:00.',
    phone: '0242 247 10 10', website_url: 'https://noktapp.com',
    instagram_url: 'https://instagram.com/kaleiciocakbasi',
    currency: 'TRY', theme: 'orange', is_published: 1 }).catch(() => {});
  await api('POST', '/api/qr/publish', {}).catch(() => {});

  /* ------------------------------------------------------ rezervasyon */
  say('rezervasyonlar…');
  for (const [name, phone, people, hh] of [
    ['Kaya Ailesi', '5321110011', 6, '19:30'], ['Demir', '5322220022', 2, '20:00'],
    ['Yılmaz', '5323330033', 4, '20:30'], ['Şirket yemeği', '5324440044', 12, '21:00'],
  ]) {
    await api('POST', '/api/floor/reservations', {
      name, phone, people, date: today, time: hh,
      table_id: pick(TABLES).id, note: people > 8 ? 'Masa birleştirilecek' : undefined,
    }).catch(() => {});
  }

  /* ---------------------------------------------------------- expenses */
  say('giderler…');
  for (const [name, amount] of [['Et alımı', 18400], ['Sebze / manav', 4250], ['Elektrik', 6800],
    ['Personel avansı', 5000], ['Ekmek', 1750], ['Temizlik malzemesi', 2100]]) {
    await api('POST', '/api/manage/expenses', { title: name, amount, category: 'İşletme' }).catch(() => {});
  }

  const dash = await api('GET', '/api/reports/dashboard');
  console.log('\n  Kaleiçi Ocakbaşı hazır.');
  console.log(`  iş günü ${dash.business_date} · ${dash.orders} adisyon · ciro ${dash.total} ₺ · açık ${dash.open_bills}`);
  server.close();
  await db.close?.();
  process.exit(0);
})().catch((e) => { console.error('DEMO FAILED:', e.stack || e.message); process.exit(1); });
