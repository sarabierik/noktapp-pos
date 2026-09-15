'use strict';
/**
 * PDA — the handheld, and what it is allowed to do.
 *
 * The phone API used to prove WHO was holding the handset and then let them do
 * everything the router offered. A waiter with no `order.item.cancel` could
 * still cancel a line from the handset; a waiter with no `order.discount` only
 * lacked the button. The till has gated these keys since it was written, so
 * the same person doing the same act through a different door now meets the
 * same answer.
 *
 * This suite walks a real handheld shift — open a table, open a SECOND bill on
 * it, add lines one at a time, fire the kitchen, reprint a lost slip, print the
 * bill, move the party to another table — and then tries every one of those as
 * somebody who may not.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/pda.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7492';
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
let _OWNER = null, PHONE = null, LIMITED = null;
let U = {}, P = {}, T = {};

async function api(method, path, body, token = PHONE) {
  const res = await fetch(BASE + path, {
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
const n = (v) => Number(v);
const val = (sql, p) => db.value(sql, p).then(Number);

async function fixture() {
  /* a handheld shift needs an OPEN day: the seeded database may have been left
     with the day closed by whichever suite ran last, and "gun sonu alinmis"
     then refuses every bill this suite tries to open */
  await db.exec('DELETE FROM daily_closings WHERE client_id=?', [CID]);
  await db.exec("UPDATE orders SET status='cancelled', is_closed=1, exclude_from_reports=1 " +
    "WHERE client_id=? AND status='open'", [CID]);
  await db.exec('UPDATE restaurant_tables SET is_occupied=0 WHERE client_id=?', [CID]);

  const mk = async (username, name, role, perms) => {
    const e = await db.one('SELECT id FROM users WHERE client_id=? AND username=?', [CID, username]);
    const id = e ? e.id : await db.insert(
      `INSERT INTO users (client_id, username, email, display_name, role, password_hash, pin_hash,
          created_at, updated_at, is_active) VALUES (?,?,?,?,?,?,?, NOW(), NOW(), 1)`,
      [CID, username, username + '@pda.local', name, role, auth.hash('Sifre1234'), auth.hash(
        username === 'pda_garson' ? '8111' : '8222')]);
    await db.exec('UPDATE users SET role=?, is_active=1 WHERE id=?', [role, id]);
    await db.exec('DELETE FROM user_permissions WHERE client_id=? AND user_id=?', [CID, id]);
    if (perms) await auth.setPermissions(CID, id, perms, null);
    return id;
  };
  /* a full handheld waiter: may take orders, cancel a line, move a table and
     discount - the four the app draws buttons for */
  U.waiter = await mk('pda_garson', 'PDA Garson', 'waiter',
    ['order.create', 'order.item.cancel', 'order.transfer', 'order.discount', 'customer.manage']);
  /* and a trainee: may take an order and nothing else */
  U.trainee = await mk('pda_cirak', 'PDA Çırak', 'waiter', ['order.create']);

  const zone = await db.one('SELECT id FROM table_zones WHERE client_id=? AND is_active=1 ORDER BY id LIMIT 1', [CID])
    || { id: await db.insert('INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']) };
  const table = async (name) => {
    const e = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? AND name=?', [CID, name]);
    if (e) { await db.exec('UPDATE restaurant_tables SET is_occupied=0, is_active=1, zone_id=? WHERE id=?', [zone.id, e.id]); return e.id; }
    return db.insert('INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active,is_occupied) VALUES (?,?,?,97,1,0)',
      [CID, zone.id, name]);
  };
  T = { a: await table('PDA 1'), b: await table('PDA 2') };

  const cat = await db.one(
    'SELECT c.id, c.station_id FROM categories c WHERE c.client_id=? AND c.is_active=1 AND c.station_id IS NOT NULL ORDER BY c.id LIMIT 1', [CID])
    || await db.one('SELECT id, station_id FROM categories WHERE client_id=? AND is_active=1 ORDER BY id LIMIT 1', [CID]);
  const product = async (name, price) => {
    const e = await db.one('SELECT id FROM products WHERE client_id=? AND name=?', [CID, name]);
    if (e) { await db.exec('UPDATE products SET price=?, is_active=1, category_id=? WHERE id=?', [price, cat.id, e.id]); return e.id; }
    return db.insert('INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,is_active,use_in_pos,use_in_qr) ' +
      'VALUES (?,?,?,?,0,10,1,1,1)', [CID, cat.id, name, price]);
  };
  P.kebap = await product('PDA Kebap', 400);
  P.ayran = await product('PDA Ayran', 60);
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - el terminali\n');
  await fixture();

  _OWNER = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Sahip', kind: 'tenant' });
  PHONE = await auth.issueToken({ cid: CID, uid: U.waiter, role: 'waiter', name: 'PDA Garson', kind: 'mobile' });
  LIMITED = await auth.issueToken({ cid: CID, uid: U.trainee, role: 'waiter', name: 'PDA Çırak', kind: 'mobile' });

  let billA = null, billB = null;

  /* ====================================================== what the app draws */

  await step('açılışta el terminali ne yapabileceğini öğrenir', async () => {
    const b = await api('GET', '/api/mobile/bootstrap');
    assert.strictEqual(b.status, 200, JSON.stringify(b));
    assert.ok(Array.isArray(b.perms), 'yetki listesi gelmedi');
    assert.ok(b.perms.includes('order.create'), 'sipariş yetkisi görünmüyor');
    assert.ok(Array.isArray(b.stations) && b.stations.length > 0, 'istasyon listesi gelmedi');
    assert.ok(Array.isArray(b.menu) && b.menu.length > 0, 'menü gelmedi');
    assert.ok(Array.isArray(b.tables) && b.tables.length > 0, 'masa planı gelmedi');
    assert.strictEqual(b.me.id, U.waiter, 'kim olduğumuz yanlış');
  });

  await step('istasyon listesi ayrıca da okunur - gönder sayfası için', async () => {
    const r = await api('GET', '/api/mobile/stations');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(Array.isArray(r.stations) && r.stations.length > 0, 'istasyon gelmedi');
    assert.ok('name' in r.stations[0], 'istasyonun adı yok');
  });

  await step('çırağın listesi kısadır ve sunucu da aynı listeye bakar', async () => {
    const b = await api('GET', '/api/mobile/bootstrap', undefined, LIMITED);
    assert.deepStrictEqual(b.perms, ['order.create'], 'çırağın yetkileri: ' + JSON.stringify(b.perms));
  });

  /* ============================================== çok adisyon / multi table */

  await step('masaya adisyon açılır, sipariş satır satır eklenir', async () => {
    const r = await api('POST', '/api/mobile/orders', { table_id: T.a });
    assert.strictEqual(r.status, 200, 'adisyon açılamadı: ' + JSON.stringify(r));
    billA = r.order_id;
    const add = await api('POST', '/api/mobile/orders/take',
      { order_id: billA, items: [{ product_id: P.kebap, qty: 2 }], send: false });
    assert.strictEqual(add.status, 200, 'satır eklenemedi: ' + JSON.stringify(add));
    const o = (await api('GET', `/api/mobile/orders/${billA}`)).order;
    assert.strictEqual(o.items.filter(i => !i.is_deleted).length, 1, 'satır adisyona işlemedi');
  });

  await step('aynı masaya İKİNCİ adisyon açılır ve ikisi karışmaz', async () => {
    const r = await api('POST', '/api/mobile/orders', { table_id: T.a, force_new: true });
    assert.strictEqual(r.status, 200, 'ikinci adisyon açılamadı: ' + JSON.stringify(r));
    billB = r.order_id;
    assert.notStrictEqual(billB, billA, 'ikinci adisyon birincinin üstüne açıldı');

    await api('POST', '/api/mobile/orders/take',
      { order_id: billB, items: [{ product_id: P.ayran, qty: 3 }], send: false });

    const list = await api('GET', `/api/mobile/tables/${T.a}/order`);
    assert.strictEqual(list.orders.length, 2, 'masada ' + list.orders.length + ' adisyon görünüyor');
    const a = (await api('GET', `/api/mobile/orders/${billA}`)).order;
    const b = (await api('GET', `/api/mobile/orders/${billB}`)).order;
    assert.strictEqual(n(a.grand_total), 800, 'A adisyonu: ' + a.grand_total);
    assert.strictEqual(n(b.grand_total), 180, 'B adisyonu: ' + b.grand_total);
  });

  await step('adisyonlar kendi etiketini alır - A ve B', async () => {
    const r = await api('POST', `/api/mobile/orders/${billB}/label`, { label: 'B' });
    assert.strictEqual(r.status, 200, 'etiket verilemedi: ' + JSON.stringify(r));
    const row = await db.one('SELECT bill_label FROM orders WHERE id=?', [billB]);
    assert.strictEqual(String(row.bill_label), 'B', 'etiket saklanmadı');
  });

  /* ============================================ istasyona gönder / print job */

  await step('el terminalinden mutfağa gönderilir', async () => {
    const before = await val('SELECT COUNT(*) FROM station_projection_items WHERE client_id=? AND order_id=?', [CID, billA]);
    const r = await api('POST', `/api/mobile/orders/${billA}/send`);
    assert.strictEqual(r.status, 200, 'gönderilemedi: ' + JSON.stringify(r));
    const after = await val('SELECT COUNT(*) FROM station_projection_items WHERE client_id=? AND order_id=?', [CID, billA]);
    assert.ok(after > before, 'mutfak panosuna hiçbir şey düşmedi');
    const sent = await val('SELECT COALESCE(SUM(sent_qty),0) FROM order_items WHERE order_id=? AND is_deleted=0', [billA]);
    assert.strictEqual(sent, 2, 'gönderilen adet: ' + sent);
  });

  await step('iki kez göndermek mutfağa iki kez sipariş vermez', async () => {
    const r = await api('POST', `/api/mobile/orders/${billA}/send`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const sent = await val('SELECT COALESCE(SUM(sent_qty),0) FROM order_items WHERE order_id=? AND is_deleted=0', [billA]);
    assert.strictEqual(sent, 2, 'ikinci gönderim adedi artırdı: ' + sent);
  });

  await step('kaybolan mutfak fişi yeniden yazdırılır - sipariş tekrarlanmadan', async () => {
    const jobsBefore = await val('SELECT COUNT(*) FROM print_jobs WHERE client_id=?', [CID]);
    const r = await api('POST', `/api/mobile/orders/${billA}/print/station`, {});
    assert.strictEqual(r.status, 200, 'fiş tekrarı başarısız: ' + JSON.stringify(r));
    const jobsAfter = await val('SELECT COUNT(*) FROM print_jobs WHERE client_id=?', [CID]);
    assert.ok(jobsAfter > jobsBefore, 'yazdırma kuyruğuna iş eklenmedi');
    const sent = await val('SELECT COALESCE(SUM(sent_qty),0) FROM order_items WHERE order_id=? AND is_deleted=0', [billA]);
    assert.strictEqual(sent, 2, 'fiş tekrarı siparişi tekrarladı: ' + sent);
  });

  await step('hiç gönderilmemiş adisyonun fişi tekrarlanamaz, sebebiyle söylenir', async () => {
    const r = await api('POST', `/api/mobile/orders/${billB}/print/station`, {});
    assert.strictEqual(r.status, 409, 'durum: ' + r.status);
    assert.ok(/mutfağa gitmiş/i.test(r.error || ''), 'sebep: ' + r.error);
  });

  await step('hesap yazdırılır ve yazdırma kuyruğu el terminalinden görünür', async () => {
    const p = await api('POST', `/api/mobile/orders/${billA}/print`, {});
    assert.strictEqual(p.status, 200, 'hesap yazdırılamadı: ' + JSON.stringify(p));
    const list = await api('GET', '/api/mobile/print-jobs');
    assert.strictEqual(list.status, 200, JSON.stringify(list));
    assert.ok(list.jobs.length > 0, 'kuyruk boş görünüyor');
    assert.ok('status' in list.jobs[0] && 'job_type' in list.jobs[0], 'iş kaydında durum yok');
  });

  await step('başarısız bir yazdırma işi terminalden tekrar kuyruğa alınır', async () => {
    const job = await db.one('SELECT id FROM print_jobs WHERE client_id=? ORDER BY id DESC LIMIT 1', [CID]);
    await db.exec("UPDATE print_jobs SET status='failed' WHERE id=?", [job.id]);
    const r = await api('POST', `/api/mobile/print-jobs/${job.id}/retry`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const row = await db.one('SELECT status FROM print_jobs WHERE id=?', [job.id]);
    assert.strictEqual(row.status, 'pending', 'iş kuyruğa dönmedi: ' + row.status);
  });

  /* ================================================ masa taşıma ve indirim */

  await step('masa taşıma el terminalinden yapılır', async () => {
    const r = await api('POST', `/api/mobile/orders/${billB}/transfer`, { table_id: T.b });
    assert.strictEqual(r.status, 200, 'taşınamadı: ' + JSON.stringify(r));
    const row = await db.one('SELECT table_id FROM orders WHERE id=?', [billB]);
    assert.strictEqual(n(row.table_id), T.b, 'adisyon taşınmadı');
  });

  await step('indirim el terminalinden yapılır ve toplam gerçekten düşer', async () => {
    const before = n((await api('GET', `/api/mobile/orders/${billA}`)).order.grand_total);
    const r = await api('POST', `/api/mobile/orders/${billA}/discount`,
      { percent: 10, reason: 'Sadık müşteri' });
    assert.strictEqual(r.status, 200, 'indirim yapılamadı: ' + JSON.stringify(r));
    const after = n((await api('GET', `/api/mobile/orders/${billA}`)).order.grand_total);
    assert.ok(after < before, `indirim işlemedi: ${before} -> ${after}`);
  });

  await step('satır iptali el terminalinden yapılır ve kim yaptığı yazılır', async () => {
    const o = (await api('GET', `/api/mobile/orders/${billA}`)).order;
    const line = o.items.find(i => !i.is_deleted);
    const r = await api('DELETE', `/api/mobile/orders/${billA}/items/${line.id}`,
      { qty: 1, reason: 'Misafir vazgeçti' });
    assert.strictEqual(r.status, 200, 'iptal edilemedi: ' + JSON.stringify(r));
    const who = await db.one(
      "SELECT user_id FROM deleted_activity_log WHERE client_id=? AND entity_type='item' ORDER BY id DESC LIMIT 1", [CID]);
    assert.strictEqual(n(who.user_id), U.waiter, 'iptal başkasının üstüne yazıldı');
  });

  /* =========================================== ve yapamayacakları */

  await step('çırak sipariş alır ama başka hiçbir şey yapamaz', async () => {
    const open = await api('POST', '/api/mobile/orders', { table_id: T.a }, LIMITED);
    assert.strictEqual(open.status, 200, 'çırak sipariş bile alamadı: ' + JSON.stringify(open));

    const refused = [
      ['DELETE', `/api/mobile/orders/${billA}/items/1`, { qty: 1, reason: 'x' }],
      ['POST', `/api/mobile/orders/${billA}/discount`, { percent: 50, reason: 'x' }],
      ['POST', `/api/mobile/orders/${billA}/transfer`, { table_id: T.b }],
    ];
    const holes = [];
    for (const [m, p, b] of refused) {
      const r = await api(m, p, b, LIMITED);
      if (r.status !== 403) holes.push(`${m} ${p} -> ${r.status}`);
    }
    assert.strictEqual(holes.length, 0, 'çırak geçti: ' + holes.join(', '));
  });

  await step('yetkisi alınan garson, elindeki terminalde de anında kaybeder', async () => {
    await auth.setPermissions(CID, U.waiter, ['order.create'], null);
    const r = await api('POST', `/api/mobile/orders/${billA}/discount`, { percent: 5, reason: 'x' });
    assert.strictEqual(r.status, 403, 'yetki alındıktan sonra hâlâ indirim yapıldı: ' + r.status);
    await auth.setPermissions(CID, U.waiter,
      ['order.create', 'order.item.cancel', 'order.transfer', 'order.discount', 'customer.manage'], null);
    const back = await api('POST', `/api/mobile/orders/${billA}/discount`, { percent: 5, reason: 'x' });
    assert.strictEqual(back.status, 200, 'yetki geri verilince çalışmadı: ' + JSON.stringify(back));
  });

  await step('jetonsuz hiçbir uç nokta cevap vermez', async () => {
    for (const [m, p] of [['GET', '/api/mobile/bootstrap'], ['POST', '/api/mobile/orders'],
                          ['GET', '/api/mobile/print-jobs'], ['GET', '/api/mobile/stations']]) {
      const r = await api(m, p, m === 'GET' ? undefined : {}, null);
      assert.strictEqual(r.status, 401, `${m} ${p} -> ${r.status}`);
    }
  });

  await step('el terminali başka bir restoranın adisyonunu göremez', async () => {
    const other = await db.one("SELECT id FROM orders WHERE client_id<>? ORDER BY id DESC LIMIT 1", [CID]);
    if (other) {
      const r = await api('GET', `/api/mobile/orders/${other.id}`);
      assert.strictEqual(r.status, 404, 'başka tenantın adisyonu görüldü: ' + r.status);
    }
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
