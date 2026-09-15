'use strict';
/**
 * İSTASYONLAR - the screen that did not exist, and the guards behind it.
 *
 * Mutfak, Bar, Pide and Tatlı were referenced by every part of the till and
 * editable by none of it: the `stations` table was written by the seed and
 * never again. Every check here is one of the consequences, not a line of code
 * that happens to exist:
 *
 *   - a restaurant that added a pide oven after opening day had nowhere to say
 *     so, and no way to retire a station it had stopped using
 *   - a station with no printer looked exactly like one that worked. Its slips
 *     were queued against no machine and thrown away, the waiter saw a
 *     successful "gönder", and "garson istasyona gönderemiyor" was the
 *     complaint that reached us weeks later
 *   - a station with no categories was decoration: nothing could ever route to
 *     it, and nothing anywhere said so
 *   - sendToStations grouped by `order_items.station_id`, a column NOTHING on
 *     the add path writes. Every line resolved to station 0 and every slip was
 *     queued with stationId=null, so the kitchen printer never saw a bill even
 *     when the station and the printer were both set up correctly
 *   - deleting a station that tickets already pointed at would have turned
 *     yesterday's mutfak geçmişi into rows that join to nothing; there are no
 *     foreign keys on this schema to stop it
 *   - deactivating the last station that categories still route to stops the
 *     kitchen receiving orders, silently, with the till still reporting "sent"
 *
 * Real MariaDB, real HTTP, no mocks: the routing bug above is only visible when
 * the database is doing the COALESCE, and the delete guard is only meaningful
 * against rows a real send actually wrote.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/station.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7491';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');
const { tarayiciAc } = require('./tarayici');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 41;                        // a tenant of our own, so no other suite's stations move
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
 * The migration is applied here rather than assumed - the same thing the
 * desktop shell does on every start. It only adds indexes, so a suite that
 * skipped it would pass and a slow settings screen would ship anyway; running
 * it here is what proves the file is syntactically good and idempotent.
 */
const MIGRATIONS = ['2026-09-05-stations.sql', '2026-09-11-station-output.sql'];
async function migrate() {
  for (const name of MIGRATIONS) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'migrations', name), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
      try { await db.exec(stmt); } catch (e) { /* already applied */ }
    }
  }
}

/**
 * Run the migrations again the way a restart does, and put every OTHER tenant
 * back exactly as it was.
 *
 * The backfill is a whole-table statement - it has to be, it is repairing an
 * install - and this suite shares its database with every other one. Without
 * this, proving our own two stations were backfilled correctly would quietly
 * rewrite the stations that test/floor.js and test/settings.js are standing on.
 */
async function replayMigrations() {
  const before = await db.query('SELECT id, client_id, output_mode FROM stations');
  await migrate();
  for (const r of before) {
    if (Number(r.client_id) === CID) continue;
    await db.exec('UPDATE stations SET output_mode=? WHERE id=?', [r.output_mode, r.id]);
  }
}

/** A restaurant we control completely, so every count below is checkable by hand. */
async function fixture() {
  await db.exec('DELETE FROM station_projection_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM print_jobs WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM order_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM order_payments WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM orders WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM restaurant_tables WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM table_zones WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM products WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM categories WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM printers WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM stations WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM clients WHERE id=?', [CID]).catch(() => {});
  await db.exec(
    'INSERT INTO clients (id, company_name, is_active) VALUES (?,?,1)',
    [CID, 'İstasyon Test Restoran']).catch(async () => {
    await db.exec('UPDATE clients SET receipt_station_id=NULL WHERE id=?', [CID]);
  });

  const mutfak = await db.insert(
    'INSERT INTO stations (client_id,name,display_name,is_default,is_active,sort_order) VALUES (?,?,?,1,1,1)',
    [CID, 'Mutfak-' + CID, 'Mutfak']);
  const bar = await db.insert(
    'INSERT INTO stations (client_id,name,display_name,is_default,is_active,sort_order) VALUES (?,?,?,0,1,2)',
    [CID, 'Bar-' + CID, 'Bar']);

  // routing is the CATEGORY's station - the rule the board and the printer
  // both use, so the fixture has to set it
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

  // one printer, on Mutfak only: Bar is deliberately left printerless, because
  // "a station with no printer" is the fault this screen exists to name
  const prn = await db.insert(
    `INSERT INTO printers (client_id, station_id, name, type, ip_address, is_default, paper_width, created_at)
     VALUES (?,?,?,'file',?,0,80,NOW())`,
    [CID, mutfak, 'Mutfak Yazıcı', '/tmp/nokdata/station-test.txt']);

  const zone = await db.insert(
    'INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']);
  const masa = await db.insert(
    `INSERT INTO restaurant_tables (client_id,zone_id,name,status,sort_order,is_occupied,is_active)
     VALUES (?,?,?,'free',1,0,1)`, [CID, zone, 'Masa 1']);

  return {
    mutfak, bar, yemek, icecek, prn, masa,
    kebap: await mk(yemek, 'Adana Kebap', 420),
    ayran: await mk(icecek, 'Ayran', 40),
  };
}

const stOf = (list, id) => list.find(x => Number(x.id) === Number(id));
const hasProblem = (st, kind) => st.problems.some(p => p.kind === kind);

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  await migrate();
  console.log('\nNOKTApp POS - istasyonlar\n');

  const catalog = require('../src/modules/catalog');
  await db.exec('DELETE FROM users WHERE client_id=? AND username=?', [CID, 'isttest']);
  const uid = await catalog.saveUser(CID, {
    display_name: 'İstasyon Test', username: 'isttest', role: 'admin', pin: '9371', password: 'ist12345',
  }, null);
  TOKEN = await auth.issueToken({ cid: CID, uid, role: 'admin', name: 'İstasyon Test', kind: 'pos' });
  const P = await fixture();

  let pide = null;

  /* ========================= listeyi okumak ============================ */
  await step('istasyon listesi kategori sayisini ve yaziciyi birlikte verir', async () => {
    const r = await api('GET', '/api/receipt/stations');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.stations.length, 2, 'iki istasyon bekleniyordu');
    const m = stOf(r.stations, P.mutfak);
    assert.strictEqual(m.category_count, 1, 'Mutfak bir kategori tasiyor');
    assert.strictEqual(m.printer_count, 1, 'Mutfak bir yaziciya bagli');
    assert.strictEqual(m.printers[0].id, P.prn, 'satir yazicinin kendisini vermeli, sadece sayisini degil');
    assert.strictEqual(m.printers[0].name, 'Mutfak Yazıcı');
  });

  /* ================ sessiz yanlis kurulumlar ========================== *
   *
   * The printer fault used to fire on ANY station with no printer, which was
   * the program insisting on a piece of hardware it does not need: this is a
   * screen-first till, Ekranlar is the output, and the pilot sites have no
   * kitchen printers at all. Every correctly configured station at every site
   * would have opened this screen red - and a person who has learned to ignore
   * red misses the row that means it. The station now says where its orders go
   * and paper is only missing when paper was asked for.
   * ==================================================================== */
  await step('ekrana calisan yazicisiz istasyon dogru kurulmus sayilir', async () => {
    const r = await api('GET', '/api/receipt/stations');
    const bar = stOf(r.stations, P.bar);
    assert.strictEqual(bar.printer_count, 0);
    assert.strictEqual(bar.output_mode, 'screen', 'istasyonun dogdugu hal ekran olmali');
    assert.ok(!hasProblem(bar, 'no_printer'),
      'ekrana calisan istasyon yazicisi yok diye uyari almamali: ' + JSON.stringify(bar.problems));
  });

  await step('yaziciya gonderdigini soyleyip yazicisi olmayan istasyon uyari tasir', async () => {
    for (const mode of ['printer', 'both']) {
      const up = await api('POST', '/api/receipt/stations',
        { id: P.bar, name: 'Bar-' + CID, output_mode: mode });
      assert.strictEqual(up.status, 200, JSON.stringify(up));
      const bar = stOf((await api('GET', '/api/receipt/stations')).stations, P.bar);
      assert.strictEqual(bar.output_mode, mode, 'secilen cikis geri okunmali');
      assert.ok(hasProblem(bar, 'no_printer'),
        mode + ' modunda yazicisizlik uyari olmali: ' + JSON.stringify(bar.problems));
      const text = bar.problems.find(p => p.kind === 'no_printer').text;
      assert.ok(/Yazıcı/.test(text) && /çıkmaz/.test(text),
        'uyari sonucu soylemeli ("fisler hicbir yerden cikmaz"), gelen: ' + text);
    }
    // and the one that HAS a printer must never be flagged, or the screen cries wolf
    await api('POST', '/api/receipt/stations',
      { id: P.mutfak, name: 'Mutfak-' + CID, output_mode: 'printer' });
    assert.ok(!hasProblem(stOf((await api('GET', '/api/receipt/stations')).stations, P.mutfak), 'no_printer'),
      'yazicisi olan istasyon uyari almamali');
    // back to the screen-first default the rest of the suite reads
    for (const id of [P.bar, P.mutfak]) {
      await api('POST', '/api/receipt/stations',
        { id, name: id === P.bar ? 'Bar-' + CID : 'Mutfak-' + CID, output_mode: 'screen' });
    }
  });

  await step('gecersiz cikis reddedilir', async () => {
    const r = await api('POST', '/api/receipt/stations',
      { id: P.bar, name: 'Bar-' + CID, output_mode: 'faks' });
    assert.strictEqual(r.status, 400, 'bilinmeyen cikis kabul edilmemeli: ' + JSON.stringify(r));
    const bar = stOf((await api('GET', '/api/receipt/stations')).stations, P.bar);
    assert.strictEqual(bar.output_mode, 'screen', 'reddedilen kayit satiri bozmamali');
  });

  await step('kategorisi olmayan istasyon satirda boyle yaziyor', async () => {
    const mk = await api('POST', '/api/receipt/stations', { name: 'Tatli-' + CID, display_name: 'Tatlı' });
    assert.strictEqual(mk.status, 200, JSON.stringify(mk));
    const r = await api('GET', '/api/receipt/stations');
    const tatli = stOf(r.stations, mk.id);
    assert.strictEqual(tatli.category_count, 0);
    assert.ok(hasProblem(tatli, 'no_category'),
      'kategorisiz istasyon uyari tasimali: ' + JSON.stringify(tatli.problems));
    const text = tatli.problems.find(p => p.kind === 'no_category').text;
    assert.ok(/sipariş düşmez/.test(text), 'uyari sonucu soylemeli, gelen: ' + text);
    assert.strictEqual(tatli.output_mode, 'screen', 'yeni istasyon ekrana calisir');
    assert.ok(!hasProblem(tatli, 'no_printer'),
      'yeni istasyonun yazicisizligi kusur degil, urunun kendisi budur: ' + JSON.stringify(tatli.problems));
    await api('DELETE', '/api/receipt/stations/' + mk.id);
  });

  /* ============================ gecis ================================== *
   * The one thing the migration must not do is walk into a restaurant that
   * already prints and tell it its printer is decoration - and the one thing it
   * must not do TWICE is undo a choice the owner made afterwards, because it is
   * replayed on every start of the till.
   * ==================================================================== */
  await step('gecis, yazicisi olan mevcut istasyonu kagida birakir', async () => {
    await db.exec("DELETE FROM np_settings WHERE k='station_output_backfilled'");
    await db.exec('UPDATE stations SET output_mode=? WHERE client_id=?', ['screen', CID]);
    await replayMigrations();
    const rows = await db.query('SELECT id, output_mode FROM stations WHERE client_id=?', [CID]);
    const modeOf = (id) => (rows.find(x => Number(x.id) === Number(id)) || {}).output_mode;
    assert.strictEqual(modeOf(P.mutfak), 'printer',
      'yazicisi olan istasyon kagitta kalmali: ' + JSON.stringify(rows));
    assert.strictEqual(modeOf(P.bar), 'screen',
      'yazicisi olmayan istasyon ekrana gecmeli: ' + JSON.stringify(rows));
    // the screen agrees, and neither of them is a fault
    const list = (await api('GET', '/api/receipt/stations')).stations;
    assert.ok(!hasProblem(stOf(list, P.mutfak), 'no_printer'));
    assert.ok(!hasProblem(stOf(list, P.bar), 'no_printer'));
  });

  await step('gecis ikinci kez calistiginda sahibinin secimini geri almaz', async () => {
    const up = await api('POST', '/api/receipt/stations',
      { id: P.mutfak, name: 'Mutfak-' + CID, output_mode: 'screen' });
    assert.strictEqual(up.status, 200, JSON.stringify(up));
    await replayMigrations();                       // the till is restarted
    const raw = await db.one('SELECT output_mode FROM stations WHERE id=?', [P.mutfak]);
    assert.strictEqual(raw.output_mode, 'screen',
      'yeniden calisan gecis, sonradan yapilan secimi silmemeli');
  });

  /* =========================== olusturma =============================== */
  await step('yeni istasyon olusturulur ve panonun sonuna eklenir', async () => {
    const r = await api('POST', '/api/receipt/stations', { name: 'Pide-' + CID, display_name: 'Pide Fırını' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    pide = r.id;
    const list = (await api('GET', '/api/receipt/stations')).stations;
    const p = stOf(list, pide);
    assert.strictEqual(p.display_name, 'Pide Fırını', 'gorunen ad ic addan ayri tutulmali');
    assert.strictEqual(p.name, 'Pide-' + CID);
    assert.strictEqual(p.is_active, 1, 'yeni istasyon etkin acilir');
    assert.strictEqual(Number(list[list.length - 1].id), Number(pide),
      'yeni istasyon panonun sonuna eklenmeli, basina degil');
  });

  await step('ayni isimde ikinci istasyon reddedilir', async () => {
    const r = await api('POST', '/api/receipt/stations', { name: 'Pide-' + CID });
    assert.strictEqual(r.status, 400, JSON.stringify(r));
    assert.ok(/zaten var/.test(r.error), r.error);
  });

  await step('yaziciya gidecek ada gecersiz karakter konamaz', async () => {
    const r = await api('POST', '/api/receipt/stations', { name: 'Mut/fak?' });
    assert.strictEqual(r.status, 400, JSON.stringify(r));
    assert.ok(/karakter/.test(r.error), r.error);
  });

  /* ============================ siralama =============================== */
  await step('istasyonlar panoda yeniden siralanir', async () => {
    const before = (await api('GET', '/api/receipt/stations')).stations.map(x => Number(x.id));
    const ids = before.slice().reverse();
    const r = await api('POST', '/api/receipt/stations/order', { ids });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const after = (await api('GET', '/api/receipt/stations')).stations.map(x => Number(x.id));
    assert.deepStrictEqual(after, ids, 'liste gonderilen sirada donmeli');
    // put it back, so the rest of the suite reads the order it expects
    await api('POST', '/api/receipt/stations/order', { ids: before });
  });

  await step('baskasinin istasyonu siralamaya sokulamaz', async () => {
    const other = await db.one('SELECT id FROM stations WHERE client_id<>? LIMIT 1', [CID]);
    if (!other) return;
    const r = await api('POST', '/api/receipt/stations/order', { ids: [P.mutfak, other.id] });
    assert.strictEqual(r.status, 404, 'baska tenantin istasyonu kabul edilmemeli: ' + JSON.stringify(r));
  });

  /* ===================== siparis gonderme (yonlendirme) ================= */
  let bill = null;
  await step('gonderilen satirlar kategorisinin istasyonuna yonlendirilir', async () => {
    const o = await api('POST', '/api/pos/orders', { table_id: P.masa });
    assert.strictEqual(o.status, 200, JSON.stringify(o));
    bill = o.order_id;
    await api('POST', `/api/pos/orders/${bill}/items`, { product_id: P.kebap, qty: 2 });
    await api('POST', `/api/pos/orders/${bill}/items`, { product_id: P.ayran, qty: 1 });
    const s = await api('POST', `/api/pos/orders/${bill}/send`);
    assert.strictEqual(s.status, 200, JSON.stringify(s));
    assert.strictEqual(s.sent, 2, 'iki satir gonderilmeliydi');
    assert.strictEqual(s.stations, 2, 'kebap Mutfaga, ayran Bara - iki ayri istasyon: ' + JSON.stringify(s));

    /*
     * The bug this replaces: order_items.station_id is written by nothing, so
     * grouping on it put both lines in one bucket and queued the slip against
     * no printer at all. The projection row is where that is visible.
     */
    const rows = await db.query(
      'SELECT station_id, COUNT(*) n FROM station_projection_items WHERE client_id=? GROUP BY station_id',
      [CID]);
    const byStation = new Map(rows.map(x => [Number(x.station_id), Number(x.n)]));
    assert.strictEqual(byStation.get(Number(P.mutfak)), 1, 'kebap Mutfak fisine dusmeli: ' + JSON.stringify(rows));
    assert.strictEqual(byStation.get(Number(P.bar)), 1, 'ayran Bar fisine dusmeli: ' + JSON.stringify(rows));
    assert.ok(!byStation.has(0) && !rows.some(x => x.station_id === null),
      'istasyonsuz fis kalmamali: ' + JSON.stringify(rows));
  });

  await step('yazdirma isi de dogru istasyona kuyruklanir', async () => {
    const jobs = await db.query(
      "SELECT station_id FROM print_jobs WHERE client_id=? AND job_type='order'", [CID]);
    const ids = jobs.map(j => Number(j.station_id)).sort();
    assert.ok(ids.includes(Number(P.mutfak)),
      'mutfak fisi mutfak istasyonuna kuyruklanmali: ' + JSON.stringify(jobs));
    assert.ok(!ids.includes(0), 'istasyonsuz yazdirma isi kalmamali: ' + JSON.stringify(jobs));
  });

  /* ============================ ad degistirme ========================== */
  await step('ad degistirmek acik adisyonun gonderilmis satirlarini bozmaz', async () => {
    const before = await db.query(
      'SELECT order_item_id, station_id, station_status FROM station_projection_items WHERE client_id=? ORDER BY id',
      [CID]);
    const r = await api('POST', '/api/receipt/stations',
      { id: P.mutfak, name: 'UstKatMutfak-' + CID, display_name: 'Üst Kat Mutfak' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));

    const after = await db.query(
      'SELECT order_item_id, station_id, station_status FROM station_projection_items WHERE client_id=? ORDER BY id',
      [CID]);
    assert.deepStrictEqual(after, before, 'gonderilmis satirlar ada degil numaraya bagli olmali');

    const o = await api('GET', '/api/pos/orders/' + bill);
    assert.strictEqual(o.status, 200, JSON.stringify(o));
    assert.strictEqual(o.order.status, 'open', 'adisyon acik kalmali');
    assert.strictEqual(o.order.items.length, 2, 'satirlar yerinde kalmali');
  });

  await step('ad degisince mutfak panosu yeni adi gosterir, ayni istasyonu', async () => {
    const b = await api('GET', '/api/floor/kitchen/stations');
    assert.strictEqual(b.status, 200, JSON.stringify(b));
    const m = b.stations.find(x => Number(x.id) === Number(P.mutfak));
    assert.ok(m, 'istasyon panodan dusmemeli');
    assert.strictEqual(m.display_name, 'Üst Kat Mutfak', 'pano yeni adi gostermeli');
    assert.strictEqual(m.pending, 1, 'bekleyen fis sayisi degismemeli: ' + JSON.stringify(m));

    const board = await api('GET', '/api/floor/kitchen/board?station_id=' + P.mutfak);
    const items = board.tickets.flatMap(t => t.items);
    assert.strictEqual(items.length, 1, 'pano hala bu istasyonun tek satirini gostermeli');
    assert.strictEqual(items[0].station_name, 'Üst Kat Mutfak');
  });

  await step('ad degistirmek digerlerini kendiliginden degistirmez', async () => {
    /* catalog.saveStation writes all five columns; a rename that sent only
       {id,name} used to reactivate, un-default and re-sort the row. */
    const raw = await db.one('SELECT * FROM stations WHERE id=?', [P.mutfak]);
    assert.strictEqual(Number(raw.is_default), 1, 'varsayilan bayragi ad degisiminde dusmemeli');
    assert.strictEqual(Number(raw.sort_order), 1, 'siralama ad degisiminde sifirlanmamali');
    assert.strictEqual(Number(raw.is_active), 1);
    assert.strictEqual(raw.output_mode, 'screen',
      'siparisin nereye gittigi ad degisiminde sifirlanmamali');
  });

  /* ================= kimsenin bakmadigi pano =========================== *
   * The screen-first half of the same silence the printer warning used to
   * name. There is no record anywhere of a board being OPENED - Ekranlar only
   * reads - so this is built on the one thing the board writes: a ticket moved
   * along. Orders waiting for hours with nothing touched is a station whose
   * orders are landing where nobody is looking.
   * ==================================================================== */
  await step('saatlerdir kimsenin dokunmadigi pano satirda yaziyor', async () => {
    await db.exec('UPDATE order_items SET station_updated_at=DATE_SUB(NOW(), INTERVAL 3 HOUR) WHERE client_id=?', [CID]);
    await db.exec('UPDATE orders SET opened_at=DATE_SUB(NOW(), INTERVAL 3 HOUR) WHERE client_id=? AND id=?', [CID, bill]);
    const m = stOf((await api('GET', '/api/receipt/stations')).stations, P.mutfak);
    assert.ok(hasProblem(m, 'board_unwatched'),
      'bekleyen siparis var ve pano hic ilerlemedi, satir bunu soylemeli: ' + JSON.stringify(m.problems));
    const text = m.problems.find(p => p.kind === 'board_unwatched').text;
    assert.ok(/Ekranlar/.test(text) && /kimsenin bakmadığı/.test(text),
      'uyari sonucu soylemeli, gelen: ' + text);
  });

  await step('panoda bir fis ilerletilince uyari duser', async () => {
    const row = await db.one(
      `SELECT oi.id FROM order_items oi
         JOIN products p ON p.id=oi.product_id AND p.client_id=oi.client_id
         LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
        WHERE oi.client_id=? AND COALESCE(oi.station_id, c.station_id)=? LIMIT 1`, [CID, P.mutfak]);
    assert.ok(row, 'mutfaga dusen bir satir olmaliydi');
    const r = await api('POST', `/api/floor/kitchen/items/${row.id}/state`, { state: 'preparing' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const m = stOf((await api('GET', '/api/receipt/stations')).stations, P.mutfak);
    assert.ok(!hasProblem(m, 'board_unwatched'),
      'panoda calisildigi belli olan istasyon uyari almamali: ' + JSON.stringify(m.problems));
  });

  await step('bekleyen siparis yokken pano uyarisi cikmaz', async () => {
    /* A closed restaurant at four in the morning has an untouched board at
       every station, and none of them is broken. Both halves are required. */
    await db.exec(
      "UPDATE order_items SET station_status='served', station_updated_at=DATE_SUB(NOW(), INTERVAL 3 HOUR) WHERE client_id=?",
      [CID]);
    const list = (await api('GET', '/api/receipt/stations')).stations;
    assert.ok(!list.some(x => hasProblem(x, 'board_unwatched')),
      'bekleyen siparis yokken hicbir istasyon bu uyariyi almamali: '
      + JSON.stringify(list.map(x => [x.name, x.problems.map(p => p.kind)])));
  });

  /* ========================= kalici silme guvenligi ==================== */
  await step('siparis gonderilmis istasyon kalici silinemez ve sayiyi soyler', async () => {
    const r = await api('DELETE', '/api/receipt/stations/' + P.bar);
    assert.strictEqual(r.status, 400, 'once kategori/yazici engeli calismali: ' + JSON.stringify(r));

    // clear the category so the ONLY thing left standing in the way is history
    await api('POST', `/api/receipt/stations/${P.bar}/categories`, { category_ids: [] });
    const r2 = await api('DELETE', '/api/receipt/stations/' + P.bar);
    assert.strictEqual(r2.status, 409, 'gecmisi olan istasyon silinmemeli: ' + JSON.stringify(r2));
    assert.ok(/\d+/.test(r2.error), 'red, kac kaydin engel oldugunu saymali: ' + r2.error);
    assert.ok(/pasife/.test(r2.error), 'red, yapilabilecek olani soylemeli: ' + r2.error);

    const still = await db.one('SELECT id FROM stations WHERE id=?', [P.bar]);
    assert.ok(still, 'reddedilen silme satiri birakmali');
    // and the count the message named is real
    const n = Number(await db.value(
      'SELECT COUNT(*) FROM station_projection_items WHERE client_id=? AND station_id=?', [CID, P.bar]));
    assert.ok(n >= 1, 'gercekten bu istasyona gonderilmis bir fis olmali');
    // put the category back, the rest of the suite expects it
    await api('POST', `/api/receipt/stations/${P.bar}/categories`, { category_ids: [P.icecek] });
  });

  await step('hic kullanilmamis istasyon kalici silinebilir', async () => {
    const mk = await api('POST', '/api/receipt/stations', { name: 'Yanlis-' + CID, display_name: 'Yanlış' });
    assert.strictEqual(mk.status, 200, JSON.stringify(mk));
    const r = await api('DELETE', '/api/receipt/stations/' + mk.id);
    assert.strictEqual(r.status, 200, 'hic kullanilmamis istasyon silinebilmeli: ' + JSON.stringify(r));
    assert.ok(!(await db.one('SELECT id FROM stations WHERE id=?', [mk.id])), 'satir gitmeli');
  });

  /* ============================ pasife alma =========================== */
  await step('istasyon pasife alinir ve mutfak panosundan duser', async () => {
    const r = await api('POST', `/api/receipt/stations/${pide}/active`, { active: false });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const list = (await api('GET', '/api/receipt/stations')).stations;
    assert.strictEqual(stOf(list, pide).is_active, 0);
    const board = await api('GET', '/api/floor/kitchen/stations');
    assert.ok(!board.stations.some(x => Number(x.id) === Number(pide)),
      'pasif istasyon mutfak panosunda gorunmemeli');
  });

  await step('pasif istasyon icin eksik kurulum uyarisi yazilmaz', async () => {
    const p = stOf((await api('GET', '/api/receipt/stations')).stations, pide);
    assert.strictEqual(p.problems.length, 0,
      'pasif istasyon zaten sipariş almiyor, uyarilari gurultu olur: ' + JSON.stringify(p.problems));
  });

  await step('pasif istasyon geri acilir', async () => {
    const r = await api('POST', `/api/receipt/stations/${pide}/active`, { active: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const p = stOf((await api('GET', '/api/receipt/stations')).stations, pide);
    assert.strictEqual(p.is_active, 1);
    const board = await api('GET', '/api/floor/kitchen/stations');
    assert.ok(board.stations.some(x => Number(x.id) === Number(pide)), 'geri acilan istasyon panoya donmeli');
  });

  /* ============== son etkin istasyon pasife alinamaz =================== */
  await step('kategorisi duran son etkin istasyon pasife alinamaz', async () => {
    // retire everything except Mutfak, which still carries Yemekler
    for (const id of [P.bar, pide]) {
      await api('POST', `/api/receipt/stations/${id}/categories`, { category_ids: [] });
      const off = await api('POST', `/api/receipt/stations/${id}/active`, { active: false });
      assert.strictEqual(off.status, 200, JSON.stringify(off));
    }
    const active = (await api('GET', '/api/receipt/stations')).stations.filter(x => x.is_active);
    assert.strictEqual(active.length, 1, 'tek etkin istasyon kalmaliydi: ' + JSON.stringify(active.map(x => x.name)));
    assert.strictEqual(Number(active[0].id), Number(P.mutfak));
    assert.ok(active[0].category_count > 0, 've hala kategori tasimali');

    const r = await api('POST', `/api/receipt/stations/${P.mutfak}/active`, { active: false });
    assert.strictEqual(r.status, 409, 'son etkin istasyon pasife alinmamali: ' + JSON.stringify(r));
    assert.ok(/kategori/.test(r.error), 'red, kac kategorinin ortada kalacagini soylemeli: ' + r.error);
    const raw = await db.one('SELECT is_active FROM stations WHERE id=?', [P.mutfak]);
    assert.strictEqual(Number(raw.is_active), 1, 'reddedilen islem istasyonu kapatmis olmamali');
    assert.ok(stOf((await api('GET', '/api/receipt/stations')).stations, P.mutfak).last_active_with_categories,
      'satir bunu dugmeye basilmadan once soylemeli');
  });

  await step('kategorisi olmayan son etkin istasyon pasife alinabilir', async () => {
    await api('POST', `/api/receipt/stations/${P.mutfak}/categories`, { category_ids: [] });
    const r = await api('POST', `/api/receipt/stations/${P.mutfak}/active`, { active: false });
    assert.strictEqual(r.status, 200, 'kategorisiz istasyonu kapatmak kimseyi sessize almaz: ' + JSON.stringify(r));
    // and back, with its categories, for the checks below
    await api('POST', `/api/receipt/stations/${P.mutfak}/active`, { active: true });
    await api('POST', `/api/receipt/stations/${P.mutfak}/categories`, { category_ids: [P.yemek] });
    await api('POST', `/api/receipt/stations/${P.bar}/active`, { active: true });
    await api('POST', `/api/receipt/stations/${P.bar}/categories`, { category_ids: [P.icecek] });
  });

  /* ====================== kategori dagitimi ============================ */
  await step('kategori baska istasyona tasininca eskisinden duser', async () => {
    const r = await api('POST', `/api/receipt/stations/${pide}/categories`, { category_ids: [P.yemek] });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.assigned, 1);
    const list = (await api('GET', '/api/receipt/stations')).stations;
    assert.strictEqual(stOf(list, pide).category_count, 1);
    assert.strictEqual(stOf(list, P.mutfak).category_count, 0, 'bir kategori tek istasyona bagli olabilir');
    assert.ok(hasProblem(stOf(list, P.mutfak), 'no_category'),
      'kategorisi alinan istasyon artik uyari tasimali');
    // back where it belongs
    await api('POST', `/api/receipt/stations/${P.mutfak}/categories`, { category_ids: [P.yemek] });
  });

  /* ============================ yetki ================================== */
  await step('yetkisiz kullanici istasyon acamaz', async () => {
    const waiterId = await catalog.saveUser(CID, {
      display_name: 'Garson', username: 'istgarson', role: 'waiter', pin: '5511', password: 'garson123',
    }, null);
    const wtok = await auth.issueToken({ cid: CID, uid: waiterId, role: 'waiter', name: 'Garson', kind: 'pos' });
    const r = await api('POST', '/api/receipt/stations', { name: 'Kacak-' + CID }, wtok);
    assert.strictEqual(r.status, 403, 'garson istasyon acamamali: ' + JSON.stringify(r));
  });

  await step('iki ekran ayni izni ister', async () => {
    /* /api/settings/stations and /api/receipt/stations write the same rows.
       The screens were merged into one - Yazıcı ve fiş - but both endpoints are
       still there and the phone app uses the older one, so one of them
       answering 403 where the other answers 200 is still how a manager
       concludes the program is broken. */
    const a = await api('POST', `/api/settings/stations/${pide}/active`, { active: true });
    const b = await api('POST', `/api/receipt/stations/${pide}/active`, { active: true });
    assert.strictEqual(a.status, b.status, 'iki yol ayni cevabi vermeli: ' + a.status + ' / ' + b.status);
    assert.strictEqual(a.status, 200, JSON.stringify(a));
  });

  /* ============================== ekran ================================ *
   * The tab in a real browser, signed in as this suite's own manager - so the
   * page it paints is this fixture: a Mutfak with a printer and a Bar without
   * one. An endpoint that answers correctly and a tab nobody can open is the
   * same as no screen at all, which is what the owner had.
   * ==================================================================== */
  /* The screen check below wants both faults on the page at once, and a
     screen-first till no longer produces the printer one by accident: a station
     has to have ASKED for paper. Pide asks, and has nothing attached. */
  await api('POST', '/api/receipt/stations',
    { id: pide, name: 'Pide-' + CID, output_mode: 'printer' });

  const SHOTS = path.join(__dirname, 'shots');
  fs.mkdirSync(SHOTS, { recursive: true });
  await db.setSetting('setup_done', '1');
  const bd = require('../src/util/businessDay');
  await db.exec('DELETE FROM daily_closings WHERE client_id=? AND date=?',
    [CID, await bd.currentBusinessDate()]).catch(() => {});

  const browser = await tarayiciAc();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/i.test(m.text())) jsErrors.push(m.text().slice(0, 160));
  });

  await step('yonetici giris yapar ve Fis ve yazici ekrani acilir', async () => {
    await page.goto(BASE + '/');
    await page.waitForSelector('.pinpad', { timeout: 15000 });
    for (const d of ['9', '3', '7', '1']) await page.click(`.pinpad button[data-k="${d}"]`);
    await page.waitForSelector('.nav__item', { timeout: 15000 });
    await page.evaluate(() => go('fis'));
    await page.waitForSelector('#fisTabs [data-t="istasyon"]', { timeout: 8000 });
  });

  await step('Istasyonlar sekmesi acilir ve dolu boyanir', async () => {
    const before = jsErrors.length;
    await page.click('#fisTabs [data-t="istasyon"]');
    await page.waitForSelector('#stAdd', { timeout: 8000 });
    await page.waitForTimeout(400);

    const seen = await page.evaluate(() => {
      const b = document.getElementById('fisBody');
      return { text: b.innerText, rows: b.querySelectorAll('.fis-st-name').length };
    });
    assert.ok(seen.rows >= 3, 'her istasyon icin bir satir bekleniyordu, gelen: ' + seen.rows);
    assert.ok(!/\bundefined\b/.test(seen.text), 'ekranda "undefined" yaziyor');
    assert.ok(!/\bNaN\b/.test(seen.text), 'ekranda NaN yaziyor');
    assert.ok(!/\[object Object\]/.test(seen.text), 'ekranda [object Object] yaziyor');
    assert.strictEqual(jsErrors.length, before, 'sekme hata firlatti: ' + jsErrors.slice(before).join(' | '));
    await page.screenshot({ path: path.join(SHOTS, '13-stations.png'), fullPage: true });
  });

  await step('eksik kurulum uyarilari ekranda Turkce ve satirin uzerinde yaziyor', async () => {
    const warns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.fis-st-warn')).map(x => x.textContent.trim()));
    assert.ok(warns.some(w => /Yazıcı bağlı değil/.test(w)),
      'yaziciya calistigi soylenip yazicisi olmayan istasyonun uyarisi ekranda olmali: '
      + JSON.stringify(warns));
    assert.ok(warns.some(w => /Kategori bağlı değil/.test(w)),
      'kategorisiz istasyon uyarisi ekranda olmali: ' + JSON.stringify(warns));
  });

  await step('istasyondan yaziciya atlanir', async () => {
    const before = jsErrors.length;
    await page.click('[data-sprn]');
    await page.waitForSelector('#fpName', { timeout: 8000 });
    const name = await page.inputValue('#fpName');
    assert.ok(/Yazıcı/.test(name), 'istasyona basan yazicinin formu acilmaliydi, gelen: ' + name);
    await page.screenshot({ path: path.join(SHOTS, '13b-station-printer.png') });
    await page.evaluate(() => closeModal());
    assert.strictEqual(jsErrors.length, before, 'atlama hata firlatti: ' + jsErrors.slice(before).join(' | '));
  });

  await step('satir siparisin nereye gittigini yaziyor', async () => {
    await page.evaluate(() => Screens.page_fis('istasyon'));
    await page.waitForSelector('#stAdd', { timeout: 8000 });
    await page.waitForTimeout(300);
    const text = await page.evaluate(() => document.getElementById('fisBody').innerText);
    assert.ok(/Ekrana/.test(text), 'ekrana calisan istasyon satirinda yazmali: ' + text.slice(0, 300));
    assert.ok(/Yazıcıya/.test(text), 'yaziciya calisan istasyon satirinda yazmali');
  });

  await step('istasyon formunda siparisin nereye gidecegi secilebilir', async () => {
    const before = jsErrors.length;
    await page.click('#stAdd');
    await page.waitForSelector('#sfOut', { timeout: 8000 });
    const opts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#sfOut option')).map(o => [o.value, o.textContent.trim()]));
    assert.deepStrictEqual(opts, [['screen', 'Ekrana'], ['printer', 'Yazıcıya'], ['both', 'İkisine']],
      'ucu de restoranin kelimeleriyle olmali: ' + JSON.stringify(opts));
    const chosen = await page.inputValue('#sfOut');
    assert.strictEqual(chosen, 'screen', 'yeni istasyon ekrana calisir olarak acilmali');
    await page.screenshot({ path: path.join(SHOTS, '13d-station-output.png') });
    await page.evaluate(() => closeModal());
    assert.strictEqual(jsErrors.length, before, 'form hata firlatti: ' + jsErrors.slice(before).join(' | '));
  });

  await step('istasyon duzenleme formu iki adi ayri gosterir', async () => {
    await page.evaluate(() => Screens.page_fis('istasyon'));
    await page.waitForSelector('[data-sedit]', { timeout: 8000 });
    await page.click('[data-sedit]');
    await page.waitForSelector('#sfName', { timeout: 8000 });
    const label = await page.inputValue('#sfLabel');
    const key = await page.inputValue('#sfName');
    assert.ok(label && key, 'iki ad da dolu gelmeliydi');
    assert.notStrictEqual(label, key, 'gorunen ad ile yazici anahtari ayri alanlar');
    await page.screenshot({ path: path.join(SHOTS, '13c-station-form.png') });
    await page.evaluate(() => closeModal());
  });

  await step('ekranin tamaminda javascript hatasi yok', async () => {
    assert.strictEqual(jsErrors.length, 0, jsErrors.slice(0, 6).join('\n      '));
  });

  await browser.close();
  console.log('screenshots: ' + SHOTS);

  /* ================================ results ============================ */
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
