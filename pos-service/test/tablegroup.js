'use strict';
/**
 * MASA BIRLESTIRME - birden fazla masa, tek adisyon.
 *
 * The owner's complaint, in full: "still not multi table adisyon". A party of
 * twelve arrives, the staff push masa 4, 5 and 6 together, and from that
 * moment those three tables are ONE table - one order, one kitchen slip, one
 * hesap, one payment - while all three tiles stay busy on the floor plan.
 *
 * The product had two features that look like this and are not:
 *   - bill_label A/B/C puts several bills on ONE table: the mirror image
 *   - transferTable MOVES a bill, leaving the other table reading "bos" with
 *     four people sitting at it
 * so every check below is written against the join itself, not against those.
 *
 * Real MariaDB, real HTTP, real ESC/POS bytes, no mocks: the failures this
 * suite exists to catch - a member table that never frees after payment, a
 * kitchen slip that says "Masa 4" for food that belongs on masa 6, a table
 * quietly pulled out of one group into another - only appear when the
 * database is enforcing the keys and the printer is rendering the paper.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/tablegroup.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7475';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const auth = require('../src/auth');
const { decode } = require('../src/print/escpos');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 27;                       // a restaurant of our own, so no other suite's floor moves
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
 * The migration is applied here rather than assumed - the desktop shell
 * re-runs every file in database/migrations on each start and a test run has
 * no shell. The file is idempotent, so this is the same thing the shell does.
 */
async function migrate() {
  const file = path.join(__dirname, '..', '..', 'database', 'migrations', '2026-09-03-tablegroup.sql');
  const sql = fs.readFileSync(file, 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await db.exec(stmt); } catch (e) { /* already applied */ }
  }
}

/** Six tables in a row and a menu we can price by hand. */
async function fixture() {
  await db.exec('DELETE FROM station_projection_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM print_jobs WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM order_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM order_payments WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM order_discounts WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM loyalty_events WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM reservations WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM table_group_members WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM table_groups WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM orders WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM restaurant_tables WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM table_zones WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM products WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM categories WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM stations WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM daily_closings WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM pos_shifts WHERE client_id=?', [CID]).catch(() => {});

  const mutfak = await db.insert(
    'INSERT INTO stations (client_id,name,display_name,is_default,is_active,sort_order) VALUES (?,?,?,1,1,1)',
    [CID, 'Mutfak-' + CID, 'Mutfak']);
  const zone = await db.insert(
    'INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']);
  const tables = {};
  for (let i = 1; i <= 6; i++) {
    tables[i] = await db.insert(
      'INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active,seats) VALUES (?,?,?,?,1,4)',
      [CID, zone, 'Masa ' + i, i]);
  }
  // the station a product routes to is its CATEGORY's station
  const cat = await db.insert(
    'INSERT INTO categories (client_id,name,station_id,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,?,1,1,1,1)',
    [CID, 'Yemekler', mutfak]);
  const kebap = await db.insert(
    `INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,sort_order,
        is_active,use_in_pos,use_in_qr,track_stock) VALUES (?,?,?,?,?,?,0,1,1,1,0)`,
    [CID, cat, 'Adana Kebap', 400, 150, 10]);
  return { zone, tables, cat, kebap, mutfak };
}

const planOf = async () => (await api('GET', '/api/pos/tables')).tables;
const tile = (plan, id) => plan.find(t => Number(t.id) === Number(id));

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  await migrate();
  console.log('\nNOKTApp POS - masa birlestirme\n');

  const catalog = require('../src/modules/catalog');
  await db.exec('DELETE FROM users WHERE client_id=? AND username=?', [CID, 'birlesticitest']);
  const uid = await catalog.saveUser(CID, {
    display_name: 'Birlestirme Garsonu', username: 'birlesticitest', role: 'admin',
    pin: '9182', password: 'test1234',
  }, null);
  TOKEN = await auth.issueToken({ cid: CID, uid, role: 'admin', name: 'Birlestirme Garsonu', kind: 'pos' });

  const F = await fixture();
  const T = F.tables;
  const tablegroup = require('../src/modules/tablegroup');

  /* ========================== 1. THE NAME ============================= */
  await step('the group is named the way a waiter says it out loud', async () => {
    assert.strictEqual(tablegroup.groupName(['Masa 4', 'Masa 5', 'Masa 6']), 'Masa 4+5+6',
      'a waiter carrying food says "dort bes alti", not "Masa 4+Masa 5+Masa 6"');
    assert.strictEqual(tablegroup.groupName(['Masa 4']), 'Masa 4');
    // a table whose name is not "<something> <number>" keeps it in full, or
    // nobody could find it on the floor
    assert.strictEqual(tablegroup.groupName(['Masa 4', 'Bahce']), 'Masa 4+Bahce');
    assert.strictEqual(tablegroup.groupName(['Bahce', 'Teras']), 'Bahce+Teras');
  });

  /* ===================== 2. JOINING TWO FREE TABLES =================== */
  let groupId = null;
  let orderId = null;

  await step('two free tables are joined into one group with one bill', async () => {
    const r = await api('POST', '/api/pos/table-groups', {
      table_ids: [T[1], T[2]], primary_table_id: T[1] });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    groupId = r.group.id;
    orderId = r.group.order_id;
    assert.ok(orderId, 'birlestirme tek bir adisyon acmali');
    assert.strictEqual(r.group.name, 'Masa 1+2');
    assert.strictEqual(r.group.table_ids.length, 2);
    assert.strictEqual(Number(r.group.primary_table_id), T[1]);
    const open = (await api('GET', '/api/pos/orders/open')).orders;
    assert.strictEqual(open.length, 1, 'iki masa icin tek adisyon olmali, ' + open.length + ' var');
  });

  await step('opening either table lands on the same one bill', async () => {
    for (const t of [T[1], T[2]]) {
      const g = await api('GET', `/api/pos/tables/${t}/group`);
      assert.strictEqual(g.status, 200, JSON.stringify(g));
      assert.ok(g.group, 'masa ' + t + ' bir gruba bagli olmali');
      assert.strictEqual(g.group.order_id, orderId,
        'her iki masadan da ayni adisyon acilmali - ayri adisyon acan masa hesabi boler');
    }
  });

  await step('the floor plan shows both tables busy and names the group', async () => {
    const plan = await planOf();
    for (const t of [T[1], T[2]]) {
      const c = tile(plan, t);
      assert.strictEqual(c.status, 'occupied', 'Masa ' + t + ' bos gorunuyor - insanlar oturuyor');
      assert.strictEqual(c.open_bills, 1, 'grubun masasinda bir adisyon gorunmeli');
      assert.strictEqual(c.group_name, 'Masa 1+2', 'kat plani grubu adiyla gostermeli');
      assert.strictEqual(c.group_id, groupId);
      assert.strictEqual(c.group_order_id, orderId);
    }
    assert.strictEqual(Number(tile(plan, T[1]).group_primary), 1, 'ana masa isaretli olmali');
    assert.ok(!tile(plan, T[2]).group_primary, 'ikinci masa ana masa degil');
    // and the database says so too, not just the JSON
    for (const t of [T[1], T[2]]) {
      const occ = await db.value('SELECT is_occupied FROM restaurant_tables WHERE id=?', [t]);
      assert.strictEqual(Number(occ), 1, 'Masa ' + t + ' veritabaninda dolu isaretlenmeli');
    }
  });

  await step('a table outside the group is untouched by it', async () => {
    const c = tile(await planOf(), T[5]);
    assert.strictEqual(c.status, 'free');
    assert.ok(!c.group_id, 'gruba girmeyen masada grup rozeti olmamali');
  });

  /* ===================== 3. THE GUARDS ================================ */
  let ownBillNo = null;
  await step('a table with its own open bill is refused, and the refusal names that bill', async () => {
    const own = await api('POST', '/api/pos/orders', { table_id: T[5] });
    assert.strictEqual(own.status, 200, JSON.stringify(own));
    ownBillNo = own.order.adisyon_no;

    const r = await api('POST', '/api/pos/table-groups', {
      table_ids: [T[4], T[5]], primary_table_id: T[4] });
    assert.strictEqual(r.status, 409, 'kendi adisyonu olan masa sessizce birlestirilmemeli');
    assert.strictEqual(r.code, 'TABLE_HAS_BILL');
    assert.ok(r.error.includes('Masa 5'), 'hangi masa oldugu yazmali: ' + r.error);
    assert.ok(r.error.includes('#' + ownBillNo),
      'hangi adisyonun engel oldugu yazmali - "birlestirilemez" garsona hicbir sey anlatmaz: ' + r.error);
    // and nothing was created behind the refusal
    assert.strictEqual((await api('GET', '/api/pos/table-groups')).groups.length, 1,
      'reddedilen birlestirme yarim bir grup birakmamali');
    assert.strictEqual(tile(await planOf(), T[4]).status, 'free', 'Masa 4 bos kalmali');
  });

  await step('a table already in a group cannot be pulled into a second one', async () => {
    const r = await api('POST', '/api/pos/table-groups', {
      table_ids: [T[3], T[2]], primary_table_id: T[3] });
    assert.strictEqual(r.status, 409, JSON.stringify(r));
    assert.strictEqual(r.code, 'IN_OTHER_GROUP');
    assert.ok(r.error.includes('Masa 1+2'), 'hangi grupta oldugu yazmali: ' + r.error);
    const g = await api('GET', `/api/pos/table-groups/${groupId}`);
    assert.strictEqual(g.group.table_ids.length, 2, 'ilk grup bozulmamali');
  });

  await step('one table is not a group', async () => {
    const r = await api('POST', '/api/pos/table-groups', { table_ids: [T[4]] });
    assert.strictEqual(r.status, 400, JSON.stringify(r));
  });

  /* =============== 4. GROWING AND SHRINKING A LIVE GROUP ============== */
  await step('an order taken on the group belongs to the whole group', async () => {
    const a = await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: F.kebap, qty: 2 });
    assert.strictEqual(a.status, 200, JSON.stringify(a));
    assert.strictEqual(Number(a.order.grand_total), 800);
  });

  await step('a third table joins while the bill is open and the bill survives', async () => {
    const r = await api('POST', `/api/pos/table-groups/${groupId}/tables`, { table_id: T[3] });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.group.name, 'Masa 1+2+3');
    assert.strictEqual(r.group.order_id, orderId, 'masa eklemek yeni adisyon acmamali');
    const o = (await api('GET', `/api/pos/orders/${orderId}`)).order;
    assert.strictEqual(Number(o.grand_total), 800, 'hesap oldugu gibi kalmali');
    assert.strictEqual(tile(await planOf(), T[3]).status, 'occupied');
    assert.strictEqual(tile(await planOf(), T[3]).group_name, 'Masa 1+2+3');
  });

  await step('a table leaves the group while the bill stays open, and goes free', async () => {
    const r = await api('DELETE', `/api/pos/table-groups/${groupId}/tables/${T[3]}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.group.name, 'Masa 1+2');
    assert.strictEqual(r.group.order_id, orderId, 'masa cikarmak hesabi kapatmamali');
    const plan = await planOf();
    assert.strictEqual(tile(plan, T[3]).status, 'free', 'cikan masa bosalmali');
    assert.ok(!tile(plan, T[3]).group_id, 'cikan masada grup rozeti kalmamali');
    assert.strictEqual(Number(await db.value('SELECT is_occupied FROM restaurant_tables WHERE id=?', [T[3]])), 0);
    // the row is kept, not deleted: who put masa 3 in and when it came out
    const row = await db.one(
      'SELECT * FROM table_group_members WHERE client_id=? AND group_id=? AND table_id=?',
      [CID, groupId, T[3]]);
    assert.ok(row && row.left_at, 'ayrilan masanin kaydi silinmemeli, cikis saati yazilmali');
    assert.strictEqual(Number(await api('GET', `/api/pos/orders/${orderId}`).then(x => x.order.grand_total)), 800);
  });

  await step('the primary table cannot be taken out from under its own bill', async () => {
    const r = await api('DELETE', `/api/pos/table-groups/${groupId}/tables/${T[1]}`);
    assert.strictEqual(r.status, 409, JSON.stringify(r));
    assert.strictEqual(r.code, 'PRIMARY_TABLE');
    assert.ok(r.error.includes('Masa 1'), r.error);
    assert.strictEqual((await api('GET', `/api/pos/table-groups/${groupId}`)).group.table_ids.length, 2);
  });

  /* ================= 5. THE PAPER THE WAITER CARRIES ================== */
  await step('the bill document names the group, not just the primary table', async () => {
    const orders = require('../src/modules/orders');
    const docs = require('../src/print/document');
    const order = await orders.getOrder(CID, orderId);
    assert.strictEqual(order.table_name, 'Masa 1+2',
      'adisyon basligi grubu soylemeli - "Masa 1" yazan hesap yanlis masaya gider');
    assert.strictEqual(order.table_group_name, 'Masa 1+2');
    assert.strictEqual(order.table_own_name, 'Masa 1', 'ana masanin kendi adi da kaybolmamali');
    const doc = await docs.billDocument(CID, order);
    assert.strictEqual(doc.meta.tableName, 'Masa 1+2');
  });

  await step('the printed hesap fisi carries the group name', async () => {
    const printing = require('../src/print');
    const orders = require('../src/modules/orders');
    const text = decode(await printing.buildBill(CID, await orders.getOrder(CID, orderId)))
      .map(l => l.text).join('\n');
    assert.ok(text.includes('Masa 1+2'), 'kagitta grup adi yok:\n' + text);
  });

  await step('the kitchen slip carries the group name', async () => {
    await db.exec('DELETE FROM print_jobs WHERE client_id=?', [CID]);
    const send = await api('POST', `/api/pos/orders/${orderId}/send`);
    assert.strictEqual(send.status, 200, JSON.stringify(send));
    const job = await db.one(
      "SELECT content FROM print_jobs WHERE client_id=? AND job_type='order' ORDER BY id DESC LIMIT 1", [CID]);
    assert.ok(job, 'mutfaga fis gitmedi');
    const text = decode(Buffer.from(job.content, 'base64')).map(l => l.text).join('\n');
    assert.ok(text.includes('MASA: Masa 1+2'),
      'mutfak fisinde grup adi yok - yemegi tasiyan garson 1+2 oldugunu bilmeli:\n' + text);
  });

  /* ================== 6. DAGIT - BREAKING THE GROUP =================== */
  let dagitGroup = null;
  let dagitOrder = null;
  await step('dagit leaves the bill open on the primary table and frees the others', async () => {
    const mk = await api('POST', '/api/pos/table-groups', {
      table_ids: [T[4], T[6]], primary_table_id: T[4] });
    assert.strictEqual(mk.status, 200, JSON.stringify(mk));
    dagitGroup = mk.group.id;
    dagitOrder = mk.group.order_id;
    await api('POST', `/api/pos/orders/${dagitOrder}/items`, { product_id: F.kebap, qty: 1 });

    const r = await api('POST', `/api/pos/table-groups/${dagitGroup}/ungroup`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.group.status, 'closed');
    assert.strictEqual(r.group.closed_reason, 'dagitildi');

    // the bill is NOT deleted and NOT closed: it stays on the primary table
    const o = (await api('GET', `/api/pos/orders/${dagitOrder}`)).order;
    assert.strictEqual(o.status, 'open', 'dagitmak hesabi kapatmamali');
    assert.strictEqual(Number(o.table_id), T[4], 'hesap ana masada kalmali');
    assert.strictEqual(Number(o.grand_total), 400, 'satirlar yerinde kalmali');
    assert.strictEqual(o.table_name, 'Masa 4', 'grup bittiginde ad tekrar masanin kendi adi olmali');

    const plan = await planOf();
    assert.strictEqual(tile(plan, T[4]).status, 'occupied', 'ana masa hesabiyla dolu kalmali');
    assert.strictEqual(tile(plan, T[6]).status, 'free', 'digeri bosalmali');
    assert.ok(!tile(plan, T[4]).group_id, 'dagitilan grubun rozeti kalmamali');
    assert.strictEqual(Number(await db.value('SELECT is_occupied FROM restaurant_tables WHERE id=?', [T[6]])), 0);
  });

  await step('removing the last other table dissolves the group by itself', async () => {
    const mk = await api('POST', '/api/pos/table-groups', {
      table_ids: [T[3], T[6]], primary_table_id: T[3] });
    assert.strictEqual(mk.status, 200, JSON.stringify(mk));
    const r = await api('DELETE', `/api/pos/table-groups/${mk.group.id}/tables/${T[6]}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.dissolved, true, 'tek masa kalan grup grup degildir');
    assert.strictEqual(r.group.status, 'closed');
    assert.strictEqual(r.group.closed_reason, 'son_masa');
    const o = (await api('GET', `/api/pos/orders/${mk.group.order_id}`)).order;
    assert.strictEqual(o.status, 'open', 'hesap ana masada acik kalmali');
    assert.strictEqual(tile(await planOf(), T[3]).status, 'occupied');
    assert.strictEqual(tile(await planOf(), T[6]).status, 'free');
    // tidy up so the closing checks below start from a known floor
    await db.exec("UPDATE orders SET status='cancelled', is_closed=1, is_deleted=1, exclude_from_reports=1 WHERE id=?",
      [mk.group.order_id]);
    await db.exec("UPDATE orders SET status='cancelled', is_closed=1, is_deleted=1, exclude_from_reports=1 WHERE id=?",
      [dagitOrder]);
    await db.exec('UPDATE restaurant_tables SET is_occupied=0 WHERE client_id=? AND id IN (?,?)', [CID, T[3], T[4]]);
  });

  /* ============ 7. PAYING THE GROUP FREES EVERY TABLE ================= */
  await step('paying the group closes it and frees every table in it', async () => {
    // grow it back to three so the release has more than a pair to do
    await api('POST', `/api/pos/table-groups/${groupId}/tables`, { table_id: T[3] });
    const g = (await api('GET', `/api/pos/table-groups/${groupId}`)).group;
    assert.strictEqual(g.name, 'Masa 1+2+3');
    const due = Number((await api('GET', `/api/pos/orders/${orderId}`)).order.grand_total);

    const pay = await api('POST', `/api/pos/orders/${orderId}/payments`, { method: 'nakit', amount: due });
    assert.strictEqual(pay.status, 200, JSON.stringify(pay));
    assert.strictEqual(pay.order.status, 'closed', 'odenen hesap kapanmali');

    const plan = await planOf();
    for (const t of [T[1], T[2], T[3]]) {
      assert.strictEqual(tile(plan, t).status, 'free',
        'Masa ' + t + ' hesap odendigi halde dolu gorunuyor - garsonun "masalar bosalmiyor" dedigi hata');
      assert.strictEqual(Number(await db.value('SELECT is_occupied FROM restaurant_tables WHERE id=?', [t])), 0,
        'Masa ' + t + ' veritabaninda hala dolu');
    }
    const row = await db.one('SELECT * FROM table_groups WHERE id=?', [groupId]);
    assert.strictEqual(row.status, 'closed');
    assert.strictEqual(row.closed_reason, 'hesap_kapandi');
    assert.strictEqual((await api('GET', '/api/pos/table-groups')).groups.length, 0,
      'kapanan grup acik gruplar arasinda kalmamali');
  });

  /* ==================== 8. THE DAY-CLOSE CHECKPOINT =================== */
  await step('joining is refused once the day has been closed', async () => {
    const bd = require('../src/util/businessDay');
    const date = await bd.currentBusinessDate();
    await db.exec(
      'INSERT INTO daily_closings (client_id,date,closed_at,closed_by) VALUES (?,?,NOW(),?)', [CID, date, uid]);
    try {
      const r = await api('POST', '/api/pos/table-groups', {
        table_ids: [T[5], T[6]], primary_table_id: T[6] });
      assert.strictEqual(r.status, 409, 'gun sonu alinmisken masa birlestirilememeli: ' + JSON.stringify(r));
      assert.strictEqual(r.code, 'DAY_CLOSED');
      assert.strictEqual((await api('GET', '/api/pos/table-groups')).groups.length, 0,
        'reddedilen birlestirme grup birakmamali');
    } finally {
      await db.exec('DELETE FROM daily_closings WHERE client_id=? AND date=?', [CID, date]);
    }
  });

  /* ================= 9. NOTHING ELSE MOVED ============================ */
  await step('a plain table with no group behaves exactly as before', async () => {
    const o = await api('POST', '/api/pos/orders', { table_id: T[6] });
    assert.strictEqual(o.status, 200, JSON.stringify(o));
    const order = (await api('GET', `/api/pos/orders/${o.order_id}`)).order;
    assert.strictEqual(order.table_name, 'Masa 6', 'grupsuz adisyonun basligi degismemeli');
    assert.strictEqual(order.table_group, undefined, 'grupsuz adisyonda grup alani olmamali');
    const c = tile(await planOf(), T[6]);
    assert.strictEqual(c.open_bills, 1);
    assert.ok(!c.group_id);
  });

  /* ================================ results =========================== */
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
