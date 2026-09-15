'use strict';
/**
 * MISAFIR TARAFI - dijital menü, müşteriler, sadakat yönetimi, kurulum.
 *
 * Everything runs against a real MariaDB and the real HTTP service, in the
 * order a restaurant would actually do it. Nothing is mocked, because the
 * failures this suite exists to catch cannot be seen through a mock:
 *
 *   - a guest menu that leaks a cost price is a leak in the JSON, not in a
 *     function's return value, so the JSON is what gets inspected;
 *   - a QR token that resolves when it should not is a query bug;
 *   - the open liability is an identity across two tables, and the only way to
 *     know it holds is to earn rewards, spend one, and add up what is left.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/guest.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7472';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 31;                       // a tenant of our own, so no other suite's menu moves
const PHONE = '5330001122';           // customers are global: this number is the fixture's own
const PHONE2 = '5330003344';
let TOKEN = null;

async function api(method, p, body, token = TOKEN) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

/**
 * The migration is applied here rather than assumed. The desktop shell replays
 * every file in database/migrations on each start; a test run has no shell,
 * and a suite that dies with "Unknown column 'welcome_text'" tells the next
 * person nothing about the digital menu. The file is written to be idempotent,
 * so this is exactly what the shell does.
 */
async function migrate() {
  const file = path.join(__dirname, '..', '..', 'database', 'migrations', '2026-09-03-guest.sql');
  const sql = fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await db.exec(stmt); } catch (e) { /* already applied */ }
  }
}

/** A restaurant we control completely, so every figure below is checkable by hand. */
async function fixture() {
  await db.exec('DELETE FROM loyalty_events WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM loyalty_cards WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM loyalty_programs WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM order_discounts WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM station_projection_items WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM order_payments WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM order_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM orders WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM products WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM categories WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM restaurant_tables WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM table_zones WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM qr_menu_settings WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM users WHERE client_id=?', [CID]);
  // customers are global (no client_id), so the fixture cleans by provenance
  // AND by the numbers it is about to reuse - the phone column is UNIQUE
  await db.exec('DELETE FROM customers WHERE created_by_client_id=?', [CID]);
  await db.exec('DELETE FROM customers WHERE phone IN (?,?)', [PHONE, PHONE2]);
  await db.exec(
    `INSERT INTO clients (id, company_name, setup_done) VALUES (?, 'Misafir Test Lokantasi', 1)
     ON DUPLICATE KEY UPDATE company_name=VALUES(company_name)`, [CID]).catch(() => {});

  const zone = await db.insert('INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)',
    [CID, 'Salon']);
  const table = await db.insert(
    'INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active,qr_token,qr_token_at) VALUES (?,?,?,1,1,?,NOW())',
    [CID, zone, 'Masa 1', 'guesttest0000000000000000000001']);
  const table2 = await db.insert(
    'INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active,qr_token,qr_token_at) VALUES (?,?,?,2,1,?,NOW())',
    [CID, zone, 'Masa 2', 'guesttest0000000000000000000002']);

  const cat = (name, sort, qr) => db.insert(
    'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,?,1,1,?)',
    [CID, name, sort, qr]);
  const yemek = await cat('Yemekler', 1, 1);
  const icecek = await cat('İçecekler', 2, 1);
  const personel = await cat('Personel Yemeği', 3, 0);   // never on a guest's phone
  const bos = await cat('Tatlılar', 4, 1);               // flagged on, but has nothing in it

  const mk = (c, n, price, cost, qr) => db.insert(
    `INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,description,
        sort_order,is_active,use_in_pos,use_in_qr,track_stock) VALUES (?,?,?,?,?,10,?,0,1,1,?,1)`,
    [CID, c, n, price, cost, n === 'Adana Kebap' ? 'Acılı, közde' : null, qr]);

  return {
    zone, table, table2, yemek, icecek, personel, bos,
    kebap: await mk(yemek, 'Adana Kebap', 420, 160, 1),
    pide: await mk(yemek, 'Kıymalı Pide', 220, 70, 1),
    mutfak: await mk(yemek, 'Mutfak Tabağı', 90, 40, 0),    // flagged off inside a visible category
    kahve: await mk(icecek, 'Filtre Kahve', 100, 25, 1),
    corba: await mk(personel, 'Personel Çorba', 0, 0, 1),   // its category is off, so it is off
  };
}

(async () => {
  const server = await bootstrap();
  await migrate();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - misafir tarafi (QR menü, müşteriler, sadakat, kurulum)\n');

  const P = await fixture();
  const catalog = require('../src/modules/catalog');
  const uid = await catalog.saveUser(CID, {
    display_name: 'Misafir Testçi', username: 'misafirtest', role: 'admin', pin: '5150', password: 'test1234',
  }, null);
  TOKEN = await auth.issueToken({ cid: CID, uid, role: 'admin', name: 'Misafir Testçi', kind: 'pos' });

  const CARD = 'guesttest0000000000000000000001';

  /* ================================================================== */
  /* 1. DIJITAL MENU                                                     */
  /* ================================================================== */

  await step('a table\'s karekod opens that table\'s menu, with no session at all', async () => {
    // no Authorization header on purpose: this is a stranger's phone
    const res = await fetch(BASE + '/api/guest/menu?m=' + CARD);
    assert.strictEqual(res.status, 200, 'the public menu must not need a login');
    const j = await res.json();
    assert.strictEqual(j.ok, true, JSON.stringify(j));
    assert.strictEqual(j.table.name, 'Masa 1', 'the menu must know which table it was scanned from');
    assert.strictEqual(j.table.zone, 'Salon');
    assert.ok(j.categories.length, 'no categories came back');
  });

  await step('only the categories and products flagged for the QR menu are shown', async () => {
    const j = await api('GET', '/api/guest/menu?m=' + CARD, null, null);
    const names = j.categories.map(c => c.name);
    assert.ok(names.includes('Yemekler') && names.includes('İçecekler'));
    assert.ok(!names.includes('Personel Yemeği'), 'a category flagged off reached the guest');
    const items = j.categories.flatMap(c => c.products.map(p => p.name));
    assert.ok(items.includes('Adana Kebap') && items.includes('Filtre Kahve'));
    assert.ok(!items.includes('Mutfak Tabağı'), 'a product flagged off reached the guest');
    assert.ok(!items.includes('Personel Çorba'), 'a product in a hidden category reached the guest');
  });

  await step('a category with nothing in it is not offered as an empty page', async () => {
    const j = await api('GET', '/api/guest/menu?m=' + CARD, null, null);
    assert.ok(!j.categories.some(c => c.name === 'Tatlılar'),
      'an empty category reads as a broken menu and must be dropped');
  });

  await step('the guest page carries name, price and description - and nothing else', async () => {
    const j = await api('GET', '/api/guest/menu?m=' + CARD, null, null);
    const banned = ['cost', 'cost_price', 'stock', 'track_stock', 'vat', 'vat_rate', 'maliyet', 'category_id'];
    const walk = (node, at) => {
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, at + '[' + i + ']'));
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          assert.ok(!banned.includes(k), 'the guest menu exposes "' + k + '" at ' + at);
          walk(v, at + '.' + k);
        }
      }
    };
    walk(j, '$');
    const item = j.categories[0].products[0];
    /* `image` joined the list when the photo-led template was added. It is a
       product photograph, which is exactly the kind of thing a guest menu is
       for; the check stays an EXACT key list rather than a "must not contain"
       so that the next column added to `products` still cannot arrive here by
       accident. */
    assert.deepStrictEqual(Object.keys(item).sort(), ['description', 'id', 'image', 'name', 'price']);
    const kebap = j.categories.flatMap(c => c.products).find(p => p.name === 'Adana Kebap');
    assert.strictEqual(kebap.price, 420, 'the price the guest sees must be the price on the till');
    assert.strictEqual(kebap.description, 'Acılı, közde');
  });

  await step('a karekod that is not ours is refused, not answered with somebody\'s menu', async () => {
    for (const bogus of ['deadbeefdeadbeefdeadbeefdeadbeef', 'x', '']) {
      const r = await api('GET', '/api/guest/menu?m=' + encodeURIComponent(bogus), null, null);
      assert.strictEqual(r.status, 404, `token "${bogus}" should be refused, got ${r.status}`);
      assert.strictEqual(r.ok, false);
    }
    // a live token belonging to another tenant in the same database
    const other = await db.one('SELECT qr_token FROM restaurant_tables WHERE client_id<>? AND qr_token IS NOT NULL LIMIT 1', [CID]);
    if (other) {
      const r = await api('GET', '/api/guest/menu?m=' + other.qr_token, null, null);
      assert.strictEqual(r.status, 404, 'another venue\'s token must not open this venue\'s menu');
    }
  });

  await step('the venue can name, dress and switch off its own menu', async () => {
    const save = await api('POST', '/api/guest/qr/settings', {
      business_name: 'Çiğköfteci Ömer', welcome_text: 'Hoş geldiniz, afiyet olsun.',
      about: 'Her gün 09:00 - 23:00', theme: 'dark', phone: '5330001122',
      instagram_url: 'https://instagram.com/test', logo_url: '/media/logo.png', is_published: 1,
    });
    assert.strictEqual(save.status, 200, JSON.stringify(save));
    assert.strictEqual(save.slug, 'cigkofteci-omer', 'Turkish letters must fold, not vanish: ' + save.slug);

    const j = await api('GET', '/api/guest/menu?m=' + CARD, null, null);
    assert.strictEqual(j.business.name, 'Çiğköfteci Ömer');
    assert.strictEqual(j.business.welcome, 'Hoş geldiniz, afiyet olsun.');
    assert.strictEqual(j.business.theme, 'dark');
    assert.strictEqual(j.business.logo, '/media/logo.png');

    // switched off: the guest is told the menu is closed, not why
    await api('POST', '/api/guest/qr/settings', { business_name: 'Çiğköfteci Ömer', is_published: 0 });
    const off = await api('GET', '/api/guest/menu?m=' + CARD, null, null);
    assert.strictEqual(off.status, 403, 'an unpublished menu must not be served');
    assert.ok(!/yayın|publish/i.test(String(off.error)), 'the reason is the venue\'s business');

    await api('POST', '/api/guest/qr/settings', { business_name: 'Çiğköfteci Ömer', is_published: 1 });
    const back = await api('GET', '/api/guest/menu?m=' + CARD, null, null);
    assert.strictEqual(back.status, 200);
    const s = await db.one('SELECT slug FROM qr_menu_settings WHERE client_id=?', [CID]);
    assert.strictEqual(s.slug, 'cigkofteci-omer', 'the slug is printed on cards and must never move');
  });

  await step('turning a category off in the management screen empties it on the phone', async () => {
    const off = await api('POST', '/api/guest/qr/flags', { kind: 'category', id: P.icecek, on: false, cascade: true });
    assert.strictEqual(off.status, 200, JSON.stringify(off));
    let j = await api('GET', '/api/guest/menu?m=' + CARD, null, null);
    assert.ok(!j.categories.some(c => c.name === 'İçecekler'), 'the category is still on the guest page');

    await api('POST', '/api/guest/qr/flags', { kind: 'category', id: P.icecek, on: true, cascade: true });
    j = await api('GET', '/api/guest/menu?m=' + CARD, null, null);
    assert.ok(j.categories.some(c => c.name === 'İçecekler'), 'turning it back on did not restore it');

    const flags = await api('GET', '/api/guest/qr/flags');
    const cat = flags.categories.find(c => c.id === P.yemek);
    assert.ok(cat.products.some(p => p.name === 'Mutfak Tabağı' && p.use_in_qr === 0),
      'the management screen must show what is hidden, not hide it too');
  });

  await step('the preview the manager sees is the page the guest gets', async () => {
    const prev = await api('GET', '/api/guest/qr/preview');
    const live = await api('GET', '/api/guest/menu?m=' + CARD, null, null);
    assert.strictEqual(prev.status, 200);
    assert.deepStrictEqual(prev.categories, live.categories, 'preview and reality disagree');
  });

  /* ================================================================== */
  /* 2. MUSTERILER                                                       */
  /* ================================================================== */
  let customerId = null;
  let orderId = null;

  await step('a customer can be added at the counter', async () => {
    const r = await api('POST', '/api/guest/customers', {
      first_name: 'Ayşe', last_name: 'Yılmaz', phone: '0533 000 11 22', email: 'ayse@example.com' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    customerId = r.id;
    const row = await db.one('SELECT phone FROM customers WHERE id=?', [customerId]);
    assert.strictEqual(row.phone, PHONE, 'the number must be stored in one canonical shape');
  });

  await step('the same number cannot be registered twice under two names', async () => {
    const r = await api('POST', '/api/guest/customers', { first_name: 'Başkası', phone: '+90 533 000 11 22' });
    assert.strictEqual(r.status, 409, 'a duplicate phone must be refused with a name, got ' + r.status);
    assert.ok(String(r.error).includes('Ayşe'), 'the message should say who already owns it: ' + r.error);
  });

  await step('a bad phone number is refused rather than stored as typed', async () => {
    const r = await api('POST', '/api/guest/customers', { first_name: 'Hatalı', phone: '12345' });
    assert.strictEqual(r.status, 400);
  });

  await step('the guest is found by the number however the cashier types it', async () => {
    for (const q of ['0533 000 11 22', '+905330001122', '5330001122', 'Ayşe']) {
      const r = await api('GET', '/api/guest/customers?q=' + encodeURIComponent(q));
      assert.strictEqual(r.status, 200);
      assert.ok(r.customers.some(c => Number(c.id) === Number(customerId)),
        'not found by "' + q + '"');
    }
  });

  await step('a customer can be attached to an open bill', async () => {
    const o = await api('POST', '/api/pos/orders', { table_id: P.table });
    orderId = o.order_id;
    await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: P.kebap, qty: 1 });
    await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: P.kahve, qty: 2 });
    const r = await api('POST', `/api/guest/orders/${orderId}/customer`, { customer_id: customerId });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const row = await db.one('SELECT customer_id FROM orders WHERE id=?', [orderId]);
    assert.strictEqual(Number(row.customer_id), Number(customerId));
  });

  await step('their history and spend reflect the bill once it is paid', async () => {
    const before = await api('GET', '/api/guest/customers/' + customerId);
    assert.strictEqual(before.stats.visits, 0, 'an open bill is not money spent');

    const o = (await api('GET', `/api/pos/orders/${orderId}`)).order;
    const grand = Number(o.grand_total);
    assert.strictEqual(grand, 620, '420 + 2x100 = 620, got ' + grand);
    const pay = await api('POST', `/api/pos/orders/${orderId}/payments`, { method: 'nakit', amount: grand });
    assert.strictEqual(pay.status, 200, JSON.stringify(pay));

    const after = await api('GET', '/api/guest/customers/' + customerId);
    assert.strictEqual(after.stats.visits, 1, 'the closed bill is missing from the history');
    assert.strictEqual(after.stats.spend, 620);
    assert.strictEqual(after.stats.average, 620);
    assert.ok(after.history.some(h => Number(h.id) === Number(orderId)), 'the bill is not in the list');
  });

  await step('a closed bill will not take a customer after the fact', async () => {
    const r = await api('POST', `/api/guest/orders/${orderId}/customer`, { customer_id: customerId });
    assert.strictEqual(r.status, 409, 'attaching to a closed bill must be refused, got ' + r.status);
  });

  /* ================================================================== */
  /* 3. SADAKAT YONETIMI                                                 */
  /* ================================================================== */
  let programId = null;

  await step('a loyalty programme can be created', async () => {
    const r = await api('POST', '/api/guest/loyalty/programs', {
      title: '10 kahve 1 bedava', product_id: P.kahve, target_count: 10,
      reward_text: 'Bir filtre kahve bizden' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    programId = r.id;
    const list = await api('GET', '/api/guest/loyalty/programs');
    const p = list.programs.find(x => x.id === programId);
    assert.strictEqual(p.target_count, 10);
    assert.strictEqual(p.product_name, 'Filtre Kahve');
  });

  await step('a programme nobody could earn is refused', async () => {
    const bad = [
      [{ title: '', reward_text: 'x', target_count: 5 }, 'ad'],
      [{ title: 'Adsız ödül', reward_text: '', target_count: 5 }, 'ödül'],
      [{ title: 'Sıfır hedef', reward_text: 'x', target_count: 0 }, 'hedef'],
      [{ title: 'Yabancı ürün', reward_text: 'x', target_count: 5, product_id: 999999 }, 'ürün'],
    ];
    for (const [body, what] of bad) {
      const r = await api('POST', '/api/guest/loyalty/programs', body);
      assert.strictEqual(r.status, 400, what + ': expected a refusal, got ' + r.status);
    }
  });

  await step('a programme can be edited, and cards in progress are left alone', async () => {
    const r = await api('POST', '/api/guest/loyalty/programs', {
      id: programId, title: '3 kahve 1 bedava', product_id: P.kahve, target_count: 3,
      reward_text: 'Bir filtre kahve bizden' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const p = (await api('GET', '/api/guest/loyalty/programs')).programs.find(x => x.id === programId);
    assert.strictEqual(p.target_count, 3);
    assert.strictEqual(p.title, '3 kahve 1 bedava');
  });

  await step('a programme can be paused and resumed', async () => {
    const off = await api('POST', `/api/guest/loyalty/programs/${programId}/toggle`);
    assert.strictEqual(off.is_active, 0);
    const on = await api('POST', `/api/guest/loyalty/programs/${programId}/toggle`);
    assert.strictEqual(on.is_active, 1);
  });

  await step('a stamp given by hand without a reason is refused', async () => {
    const r = await api('POST', '/api/guest/loyalty/stamp', {
      customer_id: customerId, program_id: programId, qty: 1 });
    assert.strictEqual(r.status, 400, 'a manual stamp with no reason must be refused, got ' + r.status);
    const n = Number(await db.value("SELECT COUNT(*) FROM loyalty_events WHERE client_id=? AND source='manual'", [CID]));
    assert.strictEqual(n, 0, 'the refused stamp was written anyway');
  });

  await step('a stamp given by hand is recorded with its reason', async () => {
    const r = await api('POST', '/api/guest/loyalty/stamp', {
      customer_id: customerId, program_id: programId, qty: 7,
      reason: 'Kart evde kalmış, fiş gösterildi' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    // 7 stamps on a 3-stamp card: two rewards and one left over
    assert.strictEqual(r.earned, 2, 'rollover is wrong: ' + JSON.stringify(r));
    assert.strictEqual(r.progress, 1);
    assert.strictEqual(r.rewards, 2);

    const ev = await db.one(
      "SELECT note, qty, source FROM loyalty_events WHERE client_id=? AND kind='stamp' ORDER BY id DESC LIMIT 1", [CID]);
    assert.strictEqual(ev.note, 'Kart evde kalmış, fiş gösterildi', 'the reason was not stored on the event');
    assert.strictEqual(Number(ev.qty), 7);
    assert.strictEqual(ev.source, 'manual');

    const cardId = r.card_id;
    const h = await api('GET', `/api/guest/loyalty/cards/${cardId}/history`);
    assert.ok(h.events.some(e => e.note === 'Kart evde kalmış, fiş gösterildi'),
      'the card\'s own history must show why');
  });

  await step('the card list shows the balance, and the ones with a reward waiting first', async () => {
    const r = await api('GET', '/api/guest/loyalty/cards');
    assert.strictEqual(r.status, 200);
    const card = r.cards.find(c => Number(c.customer_id) === Number(customerId));
    assert.ok(card, 'the card is missing from the list');
    assert.strictEqual(card.rewards_available, 2);
    assert.strictEqual(card.progress_count, 1);
    assert.strictEqual(card.target_count, 3);
    assert.strictEqual(card.open_value, 200, '2 unclaimed coffees at 100 ₺ is 200 ₺, got ' + card.open_value);
    const ready = await api('GET', '/api/guest/loyalty/cards?ready=1');
    assert.ok(ready.cards.every(c => c.rewards_available > 0));
  });

  await step('a reward taken by hand needs a reason too, and spends exactly one', async () => {
    const card = (await api('GET', '/api/guest/loyalty/cards')).cards
      .find(c => Number(c.customer_id) === Number(customerId));

    const noReason = await api('POST', '/api/guest/loyalty/redeem', {
      customer_id: customerId, card_id: card.card_id });
    assert.strictEqual(noReason.status, 400, 'a manual redemption with no reason must be refused');

    const r = await api('POST', '/api/guest/loyalty/redeem', {
      customer_id: customerId, card_id: card.card_id, reason: 'Müşteriye ikram edildi' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));

    const after = await db.one('SELECT rewards_available, rewards_used FROM loyalty_cards WHERE id=?', [card.card_id]);
    assert.strictEqual(Number(after.rewards_available), 1);
    assert.strictEqual(Number(after.rewards_used), 1);
    const ev = await db.one(
      "SELECT note FROM loyalty_events WHERE client_id=? AND kind='reward' ORDER BY id DESC LIMIT 1", [CID]);
    assert.strictEqual(ev.note, 'Müşteriye ikram edildi');
  });

  await step('the open liability is exactly the rewards earned minus the rewards used', async () => {
    const r = await api('GET', '/api/guest/loyalty/report');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const p = r.programs.find(x => x.id === programId);

    assert.strictEqual(p.earned_rewards, 2, 'seven stamps on a three-stamp card earn two rewards');
    assert.strictEqual(p.used_rewards, 1);
    assert.strictEqual(p.open_rewards, p.earned_rewards - p.used_rewards,
      'the open figure must be earned minus used');
    assert.strictEqual(p.open_rewards, 1);
    assert.strictEqual(p.liability, 100, 'one unclaimed coffee at 100 ₺ is a 100 ₺ liability');
    assert.strictEqual(p.claim_rate, 50);

    assert.strictEqual(r.totals.open_rewards, r.totals.earned_rewards - r.totals.used_rewards,
      'the total liability must balance the same way');
    assert.strictEqual(r.totals.liability, 100);
    assert.strictEqual(r.totals.cards, 1);
  });

  await step('a second reward earned moves the liability, and spending it moves it back', async () => {
    const before = (await api('GET', '/api/guest/loyalty/report')).totals;
    await api('POST', '/api/guest/loyalty/stamp', {
      customer_id: customerId, program_id: programId, qty: 3, reason: 'Doğum günü ikramı' });
    const mid = (await api('GET', '/api/guest/loyalty/report')).totals;
    assert.strictEqual(mid.open_rewards, before.open_rewards + 1);
    assert.strictEqual(mid.liability, before.liability + 100);
    assert.strictEqual(mid.open_rewards, mid.earned_rewards - mid.used_rewards);

    const card = (await api('GET', '/api/guest/loyalty/cards?ready=1')).cards
      .find(c => Number(c.customer_id) === Number(customerId));
    await api('POST', '/api/guest/loyalty/redeem', {
      customer_id: customerId, card_id: card.card_id, reason: 'Ödül kullanıldı' });
    const after = (await api('GET', '/api/guest/loyalty/report')).totals;
    assert.strictEqual(after.open_rewards, mid.open_rewards - 1);
    assert.strictEqual(after.used_rewards, mid.used_rewards + 1);
    assert.strictEqual(after.open_rewards, after.earned_rewards - after.used_rewards);
  });

  await step('a date range narrows the stamps without moving the liability', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const now = await api('GET', `/api/guest/loyalty/report?from=${today}&to=${today}`);
    assert.ok(now.totals.stamps > 0, 'today\'s stamps must appear in today\'s window: ' + now.totals.stamps);
    assert.ok(now.redemptions.length, 'the redemption log should list what was used today');

    const past = await api('GET', '/api/guest/loyalty/report?from=2020-01-01&to=2020-01-31');
    assert.strictEqual(past.totals.stamps, 0, 'a window before the restaurant existed has no stamps');
    assert.strictEqual(past.totals.liability, now.totals.liability,
      'the liability is a balance, not a window - it must not move with the dates');
    assert.strictEqual(past.totals.open_rewards, past.totals.earned_rewards - past.totals.used_rewards);
  });

  /* ================================================================== */
  /* 4. KURULUM EKSIKLERI                                                */
  /* ================================================================== */

  await step('the setup screen counts what is actually there', async () => {
    const r = await api('GET', '/api/guest/setup/state');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.steps.length >= 10, 'the wizard gained too few steps: ' + r.steps.length);
    assert.strictEqual(Number(r.counts.categories), 4);
    assert.ok(Number(r.counts.tables) >= 2);
    assert.ok(r.steps.find(s => s.id === 'kategori').done, 'categories exist but the step says otherwise');
    assert.ok(r.steps.find(s => s.id === 'qr').done, 'the QR menu was configured above');
  });

  await step('KDV rates are chosen from the legal ones, and a typo is refused', async () => {
    const bad = await api('POST', '/api/guest/setup/vat', { rates: [10, 18], default_rate: 10 });
    assert.strictEqual(bad.status, 400, '%18 has not existed since 2023 and must be refused');
    const noDefault = await api('POST', '/api/guest/setup/vat', { rates: [1, 10], default_rate: 20 });
    assert.strictEqual(noDefault.status, 400, 'the default must be one of the chosen rates');

    const r = await api('POST', '/api/guest/setup/vat', { rates: [1, 10, 20], default_rate: 10 });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(await db.getSetting('vat_rates'), '1,10,20');
    assert.strictEqual(String(await db.getSetting('vat_default_rate')), '10');
    const st = await api('GET', '/api/guest/setup/state');
    assert.deepStrictEqual(st.vat.rates, [1, 10, 20]);
    assert.strictEqual(st.vat.default_rate, 10);
    assert.ok(st.steps.find(s => s.id === 'kdv').done);
  });

  await step('the business day roll hour and the currency are saved through the settings catalogue', async () => {
    const r = await api('POST', '/api/guest/setup/general', {
      currency: 'TRY', currency_symbol: '₺', business_day_start: '07:00' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(await db.getSetting('business_day_start'), '07:00');
    const logged = await db.one(
      'SELECT new_value FROM np_settings_log WHERE k=? ORDER BY id DESC LIMIT 1', ['business_day_start']);
    assert.ok(logged, 'a wizard write must land in the settings log like any other');

    const junk = await api('POST', '/api/guest/setup/general', { currency: 'XXX' });
    assert.strictEqual(junk.status, 400, 'an unknown currency must be refused by the catalogue');

    // put it back so no later suite inherits a shifted business day
    await api('POST', '/api/guest/setup/general', { business_day_start: '06:00' });
  });

  await step('a category template fills an empty menu, and pressing it twice does nothing', async () => {
    const first = await api('POST', '/api/guest/setup/categories/preset', { set: 'kafe' });
    assert.strictEqual(first.status, 200, JSON.stringify(first));
    assert.strictEqual(first.created, 5);
    const again = await api('POST', '/api/guest/setup/categories/preset', { set: 'kafe' });
    assert.strictEqual(again.created, 0, 'the template added its categories a second time');
    assert.strictEqual(again.skipped, 5);
    const bad = await api('POST', '/api/guest/setup/categories/preset', { set: 'yok' });
    assert.strictEqual(bad.status, 400);
  });

  await step('the wizard\'s import step really creates the menu from a spreadsheet', async () => {
    const csv = 'Kategori;Urun Adi;Fiyat;KDV %;Aciklama\n'
              + 'Tatlılar;Künefe;1.250,00;10;Antep fıstıklı\n'
              + 'Tatlılar;Sütlaç;180,50;10;\n'
              + 'Yemekler;Adana Kebap;480,00;10;\n';
    const body = { filename: 'fiyat-listesi.csv',
      content_base64: Buffer.from(csv, 'utf8').toString('base64') };

    const pv = await api('POST', '/api/guest/setup/menu/preview', body);
    assert.strictEqual(pv.status, 200, JSON.stringify(pv));
    assert.strictEqual(pv.summary.create, 2, 'two new sweets should be created');
    assert.strictEqual(pv.summary.update, 1, 'the kebap already exists and should be updated');
    const stillMissing = await db.one('SELECT id FROM products WHERE client_id=? AND name=?', [CID, 'Künefe']);
    assert.strictEqual(stillMissing, null, 'a preview must not write anything');

    const ap = await api('POST', '/api/guest/setup/menu/apply', body);
    assert.strictEqual(ap.status, 200, JSON.stringify(ap));
    assert.strictEqual(ap.created, 2);
    assert.strictEqual(ap.updated, 1);

    const kunefe = await db.one('SELECT price, description, category_id FROM products WHERE client_id=? AND name=?',
      [CID, 'Künefe']);
    assert.ok(kunefe, 'the import created nothing');
    assert.strictEqual(Number(kunefe.price), 1250, '"1.250,00" is 1250, not 1.25 - got ' + kunefe.price);
    assert.strictEqual(kunefe.description, 'Antep fıstıklı');
    assert.strictEqual(Number(kunefe.category_id), P.bos, 'it belongs in the existing Tatlılar category');
    const kebap = await db.one('SELECT price FROM products WHERE client_id=? AND name=?', [CID, 'Adana Kebap']);
    assert.strictEqual(Number(kebap.price), 480, 'the existing product should have been repriced');
  });

  await step('a spreadsheet with no product column is refused with a usable message', async () => {
    const csv = 'Bir;Iki;Uc\n1;2;3\n';
    const r = await api('POST', '/api/guest/setup/menu/preview',
      { filename: 'x.csv', content_base64: Buffer.from(csv, 'utf8').toString('base64') });
    assert.strictEqual(r.status, 400);
    assert.ok(/sutun|sütun/i.test(String(r.error)), 'the message should name the missing column: ' + r.error);
  });

  await step('imported products reach the guest menu once they are flagged for it', async () => {
    // portage creates products with use_in_qr from the file; the fixture's file
    // carried no QR column, so this is the manager doing it from the screen
    const kunefe = await db.one('SELECT id FROM products WHERE client_id=? AND name=?', [CID, 'Künefe']);
    await api('POST', '/api/guest/qr/flags', { kind: 'product', id: kunefe.id, on: true });
    const j = await api('GET', '/api/guest/menu?m=' + CARD, null, null);
    const sweets = j.categories.find(c => c.name === 'Tatlılar');
    assert.ok(sweets, 'the category should now have something in it');
    assert.ok(sweets.products.some(p => p.name === 'Künefe'));
    assert.ok(sweets.products.every(p => p.price !== undefined && p.cost_price === undefined));
  });

  /* ================================= results ======================== */
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
