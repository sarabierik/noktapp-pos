'use strict';
/**
 * KAT PLANI - alanlar, masalar, rezervasyonlar, karekodlar, mutfak panosu.
 *
 * Every check here corresponds to something the old system got wrong, not to a
 * line of code that happens to exist:
 *
 *   - zones and tables could only be made in the first-run wizard; after that
 *     the manage screen existed but nothing linked to it
 *   - the zone "Sil" button was merely DISABLED when tables stood in the zone,
 *     so posting the form directly deleted it and orphaned every table
 *   - `table_delete` was an unconditional is_active=0: a table with an open
 *     bill vanished from the floor plan while the bill stayed open, and there
 *     was no tile left to reach it from
 *   - two parties could be booked onto the same table at the same hour and
 *     nobody found out until the second one walked in
 *   - regenerating a QR token was advertised as killing the old card; nothing
 *     ever proved the old token stopped resolving
 *   - the kitchen board had no sense of time at all, which is the only thing a
 *     kitchen board is for - and the one clock it could have used
 *     (station_updated_at) resets every time the kitchen touches the ticket
 *
 * Real MariaDB, real HTTP, no mocks: a floor plan bug only appears when the
 * database is enforcing the unique key and the clock is the database's own.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/floor.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7467';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 23;                        // a tenant of our own, so no other suite's floor moves
let TOKEN = null;

async function api(method, path_, body, token = TOKEN) {
  const res = await fetch(BASE + path_, {
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
 * The migration is applied here rather than assumed.
 *
 * The desktop shell re-runs every file in database/migrations on each start; a
 * test run has no shell, and a suite that fails with "Unknown column 'seats'"
 * tells the next person nothing about the floor plan. The file is written to be
 * idempotent, so this is the same thing the shell does.
 */
async function migrate() {
  const file = path.join(__dirname, '..', '..', 'database', 'migrations', '2026-09-03-floor.sql');
  const sql = fs.readFileSync(file, 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await db.exec(stmt); } catch (e) { /* already applied */ }
  }
}

/** A restaurant we control completely, so every count below is checkable by hand. */
async function fixture() {
  // orders first: the table rows below are referenced by them
  await db.exec('DELETE FROM station_projection_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM order_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM order_payments WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM reservations WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM orders WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM restaurant_tables WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM table_zones WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM products WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM categories WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM stations WHERE client_id=?', [CID]);

  const mutfak = await db.insert(
    'INSERT INTO stations (client_id,name,display_name,is_default,is_active,sort_order) VALUES (?,?,?,1,1,1)',
    [CID, 'Mutfak-' + CID, 'Mutfak']);
  const bar = await db.insert(
    'INSERT INTO stations (client_id,name,display_name,is_default,is_active,sort_order) VALUES (?,?,?,0,1,2)',
    [CID, 'Bar-' + CID, 'Bar']);

  // the station a product routes to is its CATEGORY's station - that is the
  // rule the till has always used, so the fixture has to set it
  const yemek = await db.insert(
    'INSERT INTO categories (client_id,name,station_id,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,?,1,1,1,1)',
    [CID, 'Yemekler', mutfak]);
  const icecek = await db.insert(
    'INSERT INTO categories (client_id,name,station_id,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,?,2,1,1,1)',
    [CID, 'İçecekler', bar]);
  const mk = (c, n, price) => db.insert(
    `INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,sort_order,
        is_active,use_in_pos,use_in_qr,track_stock) VALUES (?,?,?,?,0,10,0,1,1,1,0)`,
    [CID, c, n, price]);

  return {
    mutfak, bar,
    kebap: await mk(yemek, 'Adana Kebap', 420),
    pide: await mk(yemek, 'Kıymalı Pide', 220),
    ayran: await mk(icecek, 'Ayran', 40),
  };
}

const iso = (d) => d.toISOString().slice(0, 10);
const TODAY = iso(new Date());
const TOMORROW = iso(new Date(Date.now() + 86400000));

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  await migrate();
  console.log('\nNOKTApp POS - kat plani, rezervasyon, karekod, mutfak\n');

  /*
   * A real staff login, not a bare tenant token: seating a reservation records
   * WHO seated it, and a bill opened with uid 0 walks a path no till ever does.
   */
  const catalog = require('../src/modules/catalog');
  await db.exec('DELETE FROM users WHERE client_id=? AND username=?', [CID, 'kattest']);
  const uid = await catalog.saveUser(CID, {
    display_name: 'Kat Test', username: 'kattest', role: 'admin', pin: '9182', password: 'kat12345',
  }, null);
  TOKEN = await auth.issueToken({ cid: CID, uid, role: 'admin', name: 'Kat Test', kind: 'pos' });
  const P = await fixture();

  let salon = null; let teras = null;

  /* =========================== alanlar (zones) ========================== */
  await step('bir alan olusturulabilir ve yeniden adlandirilabilir', async () => {
    const a = await api('POST', '/api/floor/zones', { name: 'Salonn' });
    assert.strictEqual(a.status, 200, JSON.stringify(a));
    salon = a.id;
    const b = await api('POST', '/api/floor/zones', { id: salon, name: 'Salon' });
    assert.strictEqual(b.status, 200, JSON.stringify(b));
    const z = (await api('GET', '/api/floor/zones')).zones.find(x => x.id === salon);
    assert.strictEqual(z.name, 'Salon');
  });

  await step('ayni isimde ikinci bir alan reddedilir', async () => {
    const r = await api('POST', '/api/floor/zones', { name: 'Salon' });
    assert.strictEqual(r.status, 409, JSON.stringify(r));
    assert.strictEqual(r.code, 'duplicate');
  });

  await step('ikinci alan (Teras) olusturulur', async () => {
    const r = await api('POST', '/api/floor/zones', { name: 'Teras' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    teras = r.id;
  });

  /* ===================== toplu masa olusturma =========================== */
  await step('toplu masa olusturma dogru sayida ve dogru isimde masa yapar', async () => {
    const r = await api('POST', '/api/floor/tables/bulk',
      { zone_id: salon, prefix: 'Masa', from: 1, to: 12, seats: 4 });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.created, 12, '12 masa beklendi, ' + r.created + ' olustu');
    const tables = (await api('GET', '/api/floor/tables?zone_id=' + salon)).tables;
    assert.strictEqual(tables.length, 12);
    const names = tables.map(t => t.name).sort((a, b) => a.localeCompare(b, 'tr'));
    assert.ok(names.includes('Masa 1') && names.includes('Masa 12'),
      'isimler "Masa 1".."Masa 12" olmali, gelen: ' + names.join(', '));
    assert.ok(!names.includes('Masa 0') && !names.includes('Masa 13'), 'aralik disina tasti');
    assert.ok(tables.every(t => t.seats === 4), 'toplu olusturmada kisi sayisi yazilmali');
  });

  await step('ayni araligi ikinci kez olusturmak isimleri sayarak reddedilir', async () => {
    const r = await api('POST', '/api/floor/tables/bulk',
      { zone_id: salon, prefix: 'Masa', from: 1, to: 3 });
    assert.strictEqual(r.status, 409, JSON.stringify(r));
    assert.ok(/Masa 1/.test(r.error), 'hata hangi isimlerin cakistigini soylemeli: ' + r.error);
    const n = (await api('GET', '/api/floor/tables?zone_id=' + salon)).tables.length;
    assert.strictEqual(n, 12, 'reddedilen toplu islem yarim masa birakmamali');
  });

  /* ============================ masa duzeni ============================= */
  let masa1 = null;
  await step('bir masa yeniden adlandirilir, alani ve kisi sayisi degistirilir', async () => {
    const tables = (await api('GET', '/api/floor/tables')).tables;
    masa1 = tables.find(t => t.name === 'Masa 1').id;
    const r = await api('POST', '/api/floor/tables', { id: masa1, name: 'Pencere Kenari', zone_id: teras, seats: 6 });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const t = (await api('GET', '/api/floor/tables')).tables.find(x => x.id === masa1);
    assert.strictEqual(t.name, 'Pencere Kenari');
    assert.strictEqual(t.zone_id, teras, 'masa Teras alanina tasinmali');
    assert.strictEqual(t.seats, 6);
  });

  await step('masa alanlar arasinda tasinabilir', async () => {
    const r = await api('POST', `/api/floor/tables/${masa1}/move`, { zone_id: salon });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const t = (await api('GET', '/api/floor/tables')).tables.find(x => x.id === masa1);
    assert.strictEqual(t.zone_id, salon);
  });

  await step('masalar yeniden siralanabilir', async () => {
    const tables = (await api('GET', '/api/floor/tables?zone_id=' + salon)).tables;
    const ids = tables.map(t => t.id).reverse();
    const r = await api('POST', '/api/floor/tables/reorder', { ids });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const after = (await api('GET', '/api/floor/tables?zone_id=' + salon)).tables;
    assert.strictEqual(after[0].id, ids[0], 'ilk sirada gonderilen masa olmali');
  });

  /* ==================== alan silme guvenligi =========================== */
  await step('aktif masasi olan alan silinemez', async () => {
    const r = await api('DELETE', '/api/floor/zones/' + salon);
    assert.strictEqual(r.status, 409, 'dolu alan silinmemeli: ' + JSON.stringify(r));
    assert.strictEqual(r.code, 'zone_has_tables');
    assert.ok(/aktif masa/.test(r.error), 'hata kac masa oldugunu soylemeli: ' + r.error);
    const z = (await api('GET', '/api/floor/zones')).zones.find(x => x.id === salon);
    assert.ok(z, 'alan hala duruyor olmali');
  });

  await step('bos alan silinebilir ve listeden dusler', async () => {
    const r = await api('DELETE', '/api/floor/zones/' + teras);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const z = (await api('GET', '/api/floor/zones')).zones.find(x => x.id === teras);
    assert.ok(!z, 'silinen alan listede gorunmemeli');
    // soft delete: the row survives so old bills can still name their zone
    const raw = await db.one('SELECT is_active FROM table_zones WHERE id=?', [teras]);
    assert.strictEqual(Number(raw.is_active), 0, 'silme yumusak olmali, satir durmali');
  });

  /* ================= acik adisyonu olan masa kapatilamaz =============== */
  let masa2 = null; let _openBill = null;
  await step('acik adisyonu olan masa kapatilamaz', async () => {
    masa2 = (await api('GET', '/api/floor/tables')).tables.find(t => t.name === 'Masa 2').id;
    const o = await api('POST', '/api/pos/orders', { table_id: masa2 });
    assert.strictEqual(o.status, 200, JSON.stringify(o));
    _openBill = o.order_id;
    const r = await api('POST', `/api/floor/tables/${masa2}/active`, { active: false });
    assert.strictEqual(r.status, 409, 'adisyonlu masa kapatilmamali: ' + JSON.stringify(r));
    assert.strictEqual(r.code, 'table_has_open_bill');
    const t = (await api('GET', '/api/floor/tables')).tables.find(x => x.id === masa2);
    assert.strictEqual(Number(t.is_active), 1, 'masa aktif kalmali');
  });

  await step('adisyonu olmayan masa kapatilir ve kat planindan dusler', async () => {
    const masa9 = (await api('GET', '/api/floor/tables')).tables.find(t => t.name === 'Masa 9').id;
    const r = await api('POST', `/api/floor/tables/${masa9}/active`, { active: false });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const plan = await api('GET', '/api/pos/tables');
    assert.ok(!plan.tables.some(t => t.id === masa9), 'kapali masa kat planinda olmamali');
    // and it comes back, because closing is not deleting
    const back = await api('POST', `/api/floor/tables/${masa9}/active`, { active: true });
    assert.strictEqual(back.status, 200);
    assert.ok((await api('GET', '/api/pos/tables')).tables.some(t => t.id === masa9));
  });

  /* ============================ karekodlar ============================= */
  let oldToken = null;
  await step('eksik karekodlar toplu uretilir', async () => {
    await db.exec('UPDATE restaurant_tables SET qr_token=NULL WHERE client_id=? AND name=?', [CID, 'Masa 3']);
    const r = await api('POST', '/api/floor/qr/missing');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.generated >= 1, 'en az bir masaya karekod uretilmeliydi');
    const t = await db.one('SELECT qr_token FROM restaurant_tables WHERE client_id=? AND name=?', [CID, 'Masa 3']);
    assert.ok(t.qr_token, 'Masa 3 hala karekodsuz');
  });

  await step('karekod yenilenince eski jeton artik cozulmez', async () => {
    const t = (await api('GET', '/api/floor/tables')).tables.find(x => x.name === 'Masa 4');
    oldToken = t.qr_token;
    assert.ok(oldToken, 'once bir jeton olmali');
    const before = await api('GET', '/api/floor/qr/resolve/' + oldToken);
    assert.strictEqual(before.status, 200, 'eski jeton once cozulebilmeli: ' + JSON.stringify(before));
    assert.strictEqual(before.table.id, t.id);

    const r = await api('POST', `/api/floor/tables/${t.id}/qr`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.notStrictEqual(r.qr_token, oldToken, 'yeni jeton eskisiyle ayni olamaz');

    const after = await api('GET', '/api/floor/qr/resolve/' + oldToken);
    assert.strictEqual(after.status, 404, 'eski kart hala calisiyor - yenileme ise yaramamis');
    const fresh = await api('GET', '/api/floor/qr/resolve/' + r.qr_token);
    assert.strictEqual(fresh.status, 200, 'yeni kart calismali');
    assert.strictEqual(fresh.table.id, t.id);
  });

  await step('basilabilir karekod kartlari masa adiyla birlikte SVG uretir', async () => {
    // a slug is what turns a token into an address; without one the cards are
    // deliberately blank and the page says so
    await db.exec('DELETE FROM qr_menu_settings WHERE client_id=?', [CID]).catch(() => {});
    await db.exec(
      'INSERT INTO qr_menu_settings (client_id, slug, business_name, is_published) VALUES (?,?,?,1)',
      [CID, 'kat-test-' + CID, 'Kat Test Restoran']);
    const r = await api('GET', '/api/floor/qr/cards');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.cards.length >= 12, 'her aktif masa icin bir kart: ' + r.cards.length);
    const card = r.cards.find(c => c.name === 'Masa 5');
    assert.ok(card, 'Masa 5 karti yok');
    assert.ok(card.svg && card.svg.startsWith('<?xml') || /^<svg/.test(String(card.svg).trim()),
      'kart bir SVG tasimali');
    assert.ok(card.svg.includes('<rect'), 'SVG icinde karekod modulleri olmali');
    assert.ok(card.url.includes(card.qr_token), 'adres masanin kendi jetonunu tasimali');
    assert.ok(!/https?:\/\/(chart|api)\./.test(card.svg), 'karekod disaridan cekilmemeli');
    assert.strictEqual(r.missing, 0, 'yayina hazir kartlarda eksik jeton kalmamali');
  });

  await step('karekod menusu yayinda degilse kart basimi uyarir', async () => {
    await db.exec('UPDATE qr_menu_settings SET is_published=0 WHERE client_id=?', [CID]);
    const r = await api('GET', '/api/floor/qr/cards');
    assert.ok(r.warnings.some(w => w.code === 'not_published'), JSON.stringify(r.warnings));
    await db.exec('UPDATE qr_menu_settings SET is_published=1 WHERE client_id=?', [CID]);
  });

  /* =========================== rezervasyonlar ========================== */
  let res1 = null; let res2 = null;
  await step('rezervasyon olusturulur (isim, telefon, kisi, masa, tarih/saat, not)', async () => {
    const r = await api('POST', '/api/floor/reservations', {
      guest_name: 'Yılmaz Ailesi', guest_phone: '0532 111 22 33', party_size: 4,
      table_id: masa2, date: TOMORROW, time: '19:00', note: 'Pencere kenari olsun' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    res1 = r.id;
    const row = (await api('GET', `/api/floor/reservations/day/${TOMORROW}`)).rows.find(x => x.id === res1);
    assert.ok(row, 'rezervasyon gunun listesinde olmali');
    assert.strictEqual(row.guest_name, 'Yılmaz Ailesi');
    assert.strictEqual(Number(row.party_size), 4);
    assert.strictEqual(String(row.starts_at).slice(11, 16), '19:00');
    assert.strictEqual(row.status, 'booked');
    assert.strictEqual(row.status_label, 'Bekliyor');
    assert.strictEqual(row.note, 'Pencere kenari olsun');
  });

  await step('ayni masaya cakisan saatte ikinci rezervasyon uyarir, sessizce kabul etmez', async () => {
    const r = await api('POST', '/api/floor/reservations', {
      guest_name: 'Demir Ailesi', party_size: 2,
      table_id: masa2, date: TOMORROW, time: '20:00' });     // 19:00 + 120 dk ile cakisir
    assert.strictEqual(r.status, 409, 'cakisma reddedilmeliydi: ' + JSON.stringify(r));
    assert.strictEqual(r.code, 'double_booking');
    assert.ok(Array.isArray(r.conflicts) && r.conflicts.length, 'uyari cakisan kaydi tasimali');
    assert.strictEqual(r.conflicts[0].id, res1);
    assert.ok(/Yılmaz/.test(r.error), 'uyari kiminle cakistigini soylemeli: ' + r.error);
    const day = await api('GET', `/api/floor/reservations/day/${TOMORROW}`);
    assert.strictEqual(day.rows.length, 1, 'reddedilen rezervasyon kaydedilmemeli');
  });

  await step('cakismayan saatte ayni masaya rezervasyon serbesttir', async () => {
    const r = await api('POST', '/api/floor/reservations', {
      guest_name: 'Kaya Ailesi', party_size: 2, table_id: masa2, date: TOMORROW, time: '21:00' });
    assert.strictEqual(r.status, 200, '21:00 rezervasyonu 19:00+120dk ile cakismaz: ' + JSON.stringify(r));
    assert.strictEqual(r.warnings.length, 0);
    res2 = r.id;
  });

  await step('yonetici cakismayi bilerek gecebilir ama kayit uyari ile doner', async () => {
    const r = await api('POST', '/api/floor/reservations', {
      guest_name: 'Birlesik Masa', party_size: 2, table_id: masa2,
      date: TOMORROW, time: '19:30', force: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.warnings.some(w => w.code === 'double_booking'), 'zorlanan kayit sessiz kalmamali');
    await api('POST', `/api/floor/reservations/${r.id}/status`, { status: 'cancelled' });
  });

  await step('masa kapasitesinin ustunde rezervasyon uyarilir ama engellenmez', async () => {
    const r = await api('POST', '/api/floor/reservations', {
      guest_name: 'Kalabalik', party_size: 20, table_id: masa2, date: TOMORROW, time: '23:30' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.warnings.some(w => w.code === 'over_capacity'), JSON.stringify(r.warnings));
    await api('POST', `/api/floor/reservations/${r.id}/status`, { status: 'cancelled' });
  });

  await step('rezervasyon duzenlenebilir', async () => {
    const r = await api('PUT', '/api/floor/reservations/' + res2, { party_size: 5, time: '21:30' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const row = (await api('GET', `/api/floor/reservations/day/${TOMORROW}`)).rows.find(x => x.id === res2);
    assert.strictEqual(Number(row.party_size), 5);
    assert.strictEqual(String(row.starts_at).slice(11, 16), '21:30');
  });

  await step('rezervasyonlar gune ve tarih araligina gore listelenir', async () => {
    const today = await api('GET', `/api/floor/reservations/day/${TODAY}`);
    assert.strictEqual(today.rows.length, 0, 'bugun icin rezervasyon yok');
    const range = await api('GET', `/api/floor/reservations?from=${TODAY}&to=${TOMORROW}`);
    assert.ok(range.rows.length >= 2, 'aralik yarini da kapsamali: ' + range.rows.length);
    assert.strictEqual(range.summary.booked, range.rows.filter(r => r.status === 'booked').length);
    assert.strictEqual(range.summary.guests,
      range.rows.filter(r => r.status === 'booked').reduce((s, r) => s + Number(r.party_size), 0),
      'misafir sayisi sadece bekleyen rezervasyonlari saymali');
    // a range typed backwards is still a range
    const back = await api('GET', `/api/floor/reservations?from=${TOMORROW}&to=${TODAY}`);
    assert.strictEqual(back.rows.length, range.rows.length);
  });

  /*
   * The list on paper.
   *
   * On a full Saturday the reservations live at the host stand, next to the
   * telephone, and the host stand is not where the till is. The screen only
   * replaces the diary if it can still produce the page somebody writes on -
   * so this is checked as a real download, not as a function that returns rows.
   */
  await step('rezervasyon listesi PDF olarak inip ekrandaki satirlari tasiyor', async () => {
    const url = `${BASE}/api/floor/reservations/export?from=${TODAY}&to=${TOMORROW}&format=pdf`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    assert.strictEqual(res.status, 200, 'PDF inmedi');
    assert.match(String(res.headers.get('content-type')), /application\/pdf/, 'PDF degil');
    assert.match(String(res.headers.get('content-disposition')), /attachment; filename="rezervasyon-/,
      'tarayicida acilan bir sey indi, kaydedilen bir dosya degil');

    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.subarray(0, 4).toString('latin1'), '%PDF', 'dosya PDF degil');
    assert.ok(buf.length > 1500, 'PDF bos gorunuyor: ' + buf.length + ' bayt');
  });

  await step('PDF ekranda ne varsa onu tasir - filtre disarida kalmaz', async () => {
    /* The pack the PDF is drawn from, checked as data. Whatever the screen is
       filtered to is what comes out; a printout that quietly holds MORE than
       the screen is how a cancelled table ends up being kept for somebody. */
    const floorMod = require('../src/modules/floor');
    const all = await floorMod.reservationExport(CID, { from: TODAY, to: TOMORROW });
    const shown = await api('GET', `/api/floor/reservations?from=${TODAY}&to=${TOMORROW}`);
    assert.strictEqual(all.sheets[0].rows.length, shown.rows.length,
      'kagit ile ekran ayni satirlari gostermiyor');
    assert.ok(all.title.includes('Rezervasyon'), 'basligi yok: ' + all.title);

    const one = all.sheets[0].rows.find(r => r.guest_name === 'Yılmaz Ailesi');
    assert.ok(one, 'misafir listede yok');
    assert.strictEqual(one.saat, '19:00', 'saat yanlis yazilmis: ' + one.saat);
    assert.strictEqual(Number(one.party_size), 4);
    assert.ok(one.yer && one.yer !== 'Masasız', 'masa adi tasinmamis: ' + one.yer);
    assert.strictEqual(one.note, 'Pencere kenari olsun', 'not tasinmamis');

    /* filtering by status must narrow the paper too */
    const booked = await floorMod.reservationExport(CID, { from: TODAY, to: TOMORROW, status: 'booked' });
    assert.ok(booked.sheets[0].rows.length <= all.sheets[0].rows.length,
      'durum filtresi kagida gecmiyor');
    assert.ok(booked.sheets[0].rows.every(r => r.status === 'booked'),
      'booked filtresiyle baska durumlar da inmis');

    /* the counts the host actually reads at the door */
    const facts = Object.fromEntries(all.facts);
    assert.ok(facts['Bekleyen'], 'bekleyen sayisi kagitta yok');
    assert.ok(facts['Toplam kayit'] || facts['Toplam kayıt'], 'toplam kayit yok');
  });

  await step('gelmedi (no-show) kaydedilir', async () => {
    const r = await api('POST', `/api/floor/reservations/${res2}/status`, { status: 'noshow' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.reservation_status, 'noshow');
    const row = (await api('GET', `/api/floor/reservations/day/${TOMORROW}`)).rows.find(x => x.id === res2);
    assert.strictEqual(row.status, 'noshow');
    assert.strictEqual(row.status_label, 'Gelmedi');
    const day = await api('GET', `/api/floor/reservations/day/${TOMORROW}`);
    assert.strictEqual(day.summary.noshow, 1, 'gelmedi ozette sayilmali');
    // and a no-show frees the table: it is no longer a conflict
    const c = await api('GET',
      `/api/floor/reservations/conflicts?table_id=${masa2}&starts_at=${TOMORROW} 21:30:00&duration_min=120`);
    assert.ok(!c.conflicts.some(x => x.id === res2), 'gelmeyen misafir masayi tutmaya devam edemez');
  });

  await step('iptal edilmis rezervasyon geriye dogru "oturdu" yapilamaz', async () => {
    const r = await api('POST', '/api/floor/reservations', {
      guest_name: 'Iptal Testi', party_size: 2, date: TOMORROW, time: '12:00' });
    await api('POST', `/api/floor/reservations/${r.id}/status`, { status: 'cancelled' });
    const bad = await api('POST', `/api/floor/reservations/${r.id}/status`, { status: 'seated' });
    assert.strictEqual(bad.status, 400, JSON.stringify(bad));
    const done = await api('POST', `/api/floor/reservations/${r.id}/status`, { status: 'done' });
    assert.strictEqual(done.status, 409, 'iptalden tamamlandiya gecilememeli: ' + JSON.stringify(done));
  });

  /* ====================== rezervasyonu masaya oturt ==================== */
  let masa7 = null;
  await step('rezervasyon masaya oturtulunca o masada acik adisyon dogar', async () => {
    masa7 = (await api('GET', '/api/floor/tables')).tables.find(t => t.name === 'Masa 7').id;
    const mk = await api('POST', '/api/floor/reservations', {
      guest_name: 'Oturan Aile', guest_phone: '0555', party_size: 3,
      table_id: masa7, date: TODAY, time: '18:00' });
    assert.strictEqual(mk.status, 200, JSON.stringify(mk));

    const before = (await api('GET', '/api/pos/tables')).tables.find(t => t.id === masa7);
    assert.strictEqual(before.open_bills, 0, 'masa once bos olmali');

    const r = await api('POST', `/api/floor/reservations/${mk.id}/seat`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.order_id, 'oturtmak bir adisyon numarasi dondurmeli');
    assert.strictEqual(r.table_id, masa7);

    const after = (await api('GET', '/api/pos/tables')).tables.find(t => t.id === masa7);
    assert.strictEqual(after.open_bills, 1, 'masada acik adisyon gorunmeli');

    const o = (await api('GET', '/api/pos/orders/' + r.order_id)).order;
    assert.strictEqual(o.status, 'open');
    assert.strictEqual(Number(o.table_id), masa7);
    assert.ok(o.adisyon_no > 0, 'adisyon gunluk sayacindan numara almali');
    assert.strictEqual(o.bill_label, 'Oturan Aile', 'adisyon misafirin adiyla etiketlenmeli');
    assert.strictEqual(Number(o.waiter_id), uid, 'oturtan personel adisyona yazilmali');

    const row = (await api('GET', `/api/floor/reservations/day/${TODAY}`)).rows.find(x => x.id === mk.id);
    assert.strictEqual(row.status, 'seated', 'rezervasyon durumu oturdu olmali');
    assert.strictEqual(Number(row.order_id), r.order_id, 'rezervasyon adisyonuna baglanmali');
    assert.ok(row.seated_at, 'oturtma ani kaydedilmeli');
    assert.strictEqual(Number(row.seated_by), uid, 'oturtan personel kaydedilmeli');

    // pressing it twice must not open a second bill on the same table
    const again = await api('POST', `/api/floor/reservations/${mk.id}/seat`);
    assert.strictEqual(again.status, 200, JSON.stringify(again));
    assert.strictEqual(again.order_id, r.order_id, 'ikinci basis ikinci adisyon acmamali');
    const still = (await api('GET', '/api/pos/tables')).tables.find(t => t.id === masa7);
    assert.strictEqual(still.open_bills, 1);
  });

  /* ============================== mutfak =============================== */
  let sentItems = null;
  await step('mutfak panosu istasyona gore filtrelenir', async () => {
    const o = await api('POST', '/api/pos/orders', { table_id: masa2 });
    await api('POST', `/api/pos/orders/${o.order_id}/items`, { product_id: P.kebap, qty: 2, note: 'az acili' });
    await api('POST', `/api/pos/orders/${o.order_id}/items`, { product_id: P.ayran, qty: 3 });
    const s = await api('POST', `/api/pos/orders/${o.order_id}/send`);
    assert.strictEqual(s.status, 200, JSON.stringify(s));
    sentItems = o.order_id;

    const all = await api('GET', '/api/floor/kitchen/board');
    assert.ok(all.counts.items >= 2, 'panoda gonderilen satirlar olmali: ' + JSON.stringify(all.counts));

    const kitchen = await api('GET', '/api/floor/kitchen/board?station_id=' + P.mutfak);
    const bar = await api('GET', '/api/floor/kitchen/board?station_id=' + P.bar);
    const names = (b) => b.tickets.flatMap(t => t.items.map(i => i.product_name));
    assert.ok(names(kitchen).includes('Adana Kebap'), 'kebap mutfakta olmali');
    assert.ok(!names(kitchen).includes('Ayran'), 'ayran mutfak panosunda gorunmemeli');
    assert.ok(names(bar).includes('Ayran'), 'ayran barda olmali');
    assert.ok(!names(bar).includes('Adana Kebap'), 'kebap bar panosunda gorunmemeli');

    const st = await api('GET', '/api/floor/kitchen/stations');
    const m = st.stations.find(x => x.id === P.mutfak);
    assert.ok(m && m.pending >= 1, 'istasyon listesi bekleyen sayisini tasimali: ' + JSON.stringify(st.stations));
  });

  await step('siparis satirlari adisyon basina tek bilet halinde gruplanir', async () => {
    const b = await api('GET', '/api/floor/kitchen/board');
    const tk = b.tickets.find(t => t.order_id === sentItems);
    assert.ok(tk, 'gonderilen adisyon icin bilet yok');
    assert.strictEqual(tk.items.length, 2, 'bir adisyonun iki satiri tek bilette olmali');
    assert.strictEqual(tk.table_name, 'Masa 2');
    assert.strictEqual(tk.items.find(i => i.product_name === 'Adana Kebap').qty, 2,
      'panoda gosterilen adet GONDERILEN adet olmali');
    assert.strictEqual(tk.items.find(i => i.product_name === 'Adana Kebap').note, 'az acili');
  });

  await step('bilet yasi gonderildigi andan hesaplanir', async () => {
    const fresh = await api('GET', '/api/floor/kitchen/board');
    const t0 = fresh.tickets.find(t => t.order_id === sentItems);
    assert.strictEqual(t0.age_min, 0, 'yeni gonderilen bilet sifir dakikalik olmali');
    assert.strictEqual(t0.age_level, 'fresh');
    assert.strictEqual(t0.age_text, 'simdi');

    /*
     * Push the SEND time back 25 minutes - not station_updated_at, which is
     * what the naive implementation used and which resets every time the
     * kitchen touches the ticket. If the age came from that column the
     * "hazirlaniyor" press below would reset the clock to zero.
     */
    await db.exec(
      'UPDATE station_projection_items SET created_at=DATE_SUB(NOW(), INTERVAL 25 MINUTE) WHERE client_id=? AND order_id=?',
      [CID, sentItems]);
    const late = await api('GET', '/api/floor/kitchen/board');
    const t1 = late.tickets.find(t => t.order_id === sentItems);
    assert.ok(t1.age_min >= 24 && t1.age_min <= 26, '25 dakika beklendi, ' + t1.age_min + ' geldi');
    assert.strictEqual(t1.age_level, 'late', '20 dakikayi gecen bilet gec sayilmali');
    assert.strictEqual(t1.age_text, '25 dk');
    assert.ok(late.counts.late >= 1, 'gec bilet sayaci artmali');
    assert.deepStrictEqual(late.thresholds, { warn: 10, late: 20 });

    // a ticket the kitchen has picked up is still 25 minutes old
    const item = t1.items[0];
    const ack = await api('POST', `/api/floor/kitchen/items/${item.id}/state`, { state: 'preparing' });
    assert.strictEqual(ack.status, 200, JSON.stringify(ack));
    const after = await api('GET', '/api/floor/kitchen/board');
    const t2 = after.tickets.find(t => t.order_id === sentItems);
    assert.ok(t2.age_min >= 24, 'durum degisince yas sifirlanmamali, ' + t2.age_min + ' geldi');
    assert.ok(t2.items.some(i => i.station_status === 'preparing'), 'durum panoya yansimali');
  });

  await step('12 dakikalik bilet uyari seviyesinde, gec degil', async () => {
    await db.exec(
      'UPDATE station_projection_items SET created_at=DATE_SUB(NOW(), INTERVAL 12 MINUTE) WHERE client_id=? AND order_id=?',
      [CID, sentItems]);
    const b = await api('GET', '/api/floor/kitchen/board');
    const t = b.tickets.find(x => x.order_id === sentItems);
    assert.strictEqual(t.age_level, 'warn', JSON.stringify({ age: t.age_min, level: t.age_level }));
  });

  await step('servis edilen satir panodan duser ve gecmise gecer', async () => {
    const b = await api('GET', '/api/floor/kitchen/board?station_id=' + P.bar);
    const ayran = b.tickets.flatMap(t => t.items).find(i => i.product_name === 'Ayran');
    assert.ok(ayran, 'ayran panoda olmali');
    const r = await api('POST', `/api/floor/kitchen/items/${ayran.id}/state`, { state: 'served' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const after = await api('GET', '/api/floor/kitchen/board?station_id=' + P.bar);
    assert.ok(!after.tickets.flatMap(t => t.items).some(i => i.id === ayran.id),
      'servis edilen satir aktif panoda kalmamali');

    const h = await api('GET', `/api/floor/kitchen/history?date=${TODAY}&station_id=${P.bar}`);
    assert.strictEqual(h.status, 200, JSON.stringify(h));
    const row = h.rows.find(x => x.id === ayran.id);
    assert.ok(row, 'servis edilen satir gecmiste olmali');
    assert.strictEqual(row.status, 'served');
    assert.strictEqual(row.qty, 3);
    assert.ok(h.summary.served >= 3, 'ozet servis edilen adedi saymali: ' + JSON.stringify(h.summary));
  });

  await step('gecmis iptal edilen satirlari da gosterir', async () => {
    const o = (await api('GET', '/api/pos/orders/' + sentItems)).order;
    const kebap = o.items.find(i => i.product_id === P.kebap);
    const del = await api('DELETE', `/api/pos/orders/${sentItems}/items/${kebap.id}`, { reason: 'Musteri vazgecti' });
    assert.strictEqual(del.status, 200, JSON.stringify(del));
    const h = await api('GET', `/api/floor/kitchen/history?date=${TODAY}&station_id=${P.mutfak}`);
    const row = h.rows.find(x => x.id === kebap.id);
    assert.ok(row, 'iptal edilen satir gecmiste gorunmeli - "o tabak cikti mi" sorusu bunu gerektirir');
    assert.strictEqual(row.status, 'cancelled');
    assert.ok(h.summary.cancelled >= 1, JSON.stringify(h.summary));
  });

  await step('mutfak durum makinesi bilinmeyen durumu reddeder', async () => {
    const b = await api('GET', '/api/floor/kitchen/board');
    const any = b.tickets.flatMap(t => t.items)[0];
    if (!any) return;                       // nothing left on the board is fine
    const r = await api('POST', `/api/floor/kitchen/items/${any.id}/state`, { state: 'cancelled' });
    assert.strictEqual(r.status, 400, 'pano bir satiri iptal edemez, o kasanin isi: ' + JSON.stringify(r));
  });

  /* ================================ results ============================ */
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
