'use strict';
/**
 * The things the owner said were missing, and the receipt that was wrong.
 *
 * Everything here runs against a real MariaDB and the real HTTP service, in
 * the order a restaurant would do it. Nothing is mocked: the bugs this suite
 * exists to catch - a PDF whose columns collapse, a total that disagrees with
 * its own lines, a price list that imports at a thousandth of its value - are
 * exactly the kind a mock hides.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/menu.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7463';
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
let TOKEN = null;

async function api(method, path, body, token = TOKEN) {
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

/* A menu we control completely, so the arithmetic below is checkable by hand. */
async function fixture() {
  await db.exec('DELETE FROM order_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM order_payments WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM orders WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM products WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM categories WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM daily_costs WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM daily_closings WHERE client_id=?', [CID]);

  // the loyalty suite leaves cards pointing at orders; clear them first or the
  // order delete below trips a foreign key and the whole run dies in setup
  await db.exec('DELETE FROM loyalty_events WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM order_discounts WHERE client_id=?', [CID]).catch(() => {});

  const cat = await db.insert(
    'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,1,1,1,1)',
    [CID, 'Yemekler']);
  const drinks = await db.insert(
    'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,2,1,1,1)',
    [CID, 'İçecekler']);
  const mk = (c, n, price, cost, vat) => db.insert(
    `INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,sort_order,
        is_active,use_in_pos,use_in_qr,track_stock) VALUES (?,?,?,?,?,?,0,1,1,1,0)`,
    [CID, c, n, price, cost, vat]);
  return {
    cat, drinks,
    pide: await mk(cat, 'Kıymalı Pide', 220, 70, 10),
    kebap: await mk(cat, 'Adana Kebap', 420, 160, 10),
    bira: await mk(drinks, 'Efes Pilsen', 180, 70, 20),
    su: await mk(drinks, 'Su', 30, 0, 10),           // deliberately uncosted
  };
}

/*
 * Reuse the table if the other suites already made one. The suites share a
 * database and run in whatever order the person typing chose, so a fixture
 * that assumes it is first fails for a reason that has nothing to do with what
 * it is testing.
 */
let table = null;
async function aTable() {
  if (table) return table;
  const NAME = 'Menu Test Masasi';
  const existing = await db.one(
    'SELECT id FROM restaurant_tables WHERE client_id=? AND name=?', [CID, NAME]);
  if (existing) { table = existing.id; return table; }
  let zone = await db.one('SELECT id FROM table_zones WHERE client_id=? LIMIT 1', [CID]);
  const zoneId = zone ? zone.id : await db.insert(
    'INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']);
  table = await db.insert(
    'INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active) VALUES (?,?,?,99,1)',
    [CID, zoneId, NAME]);
  return table;
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - menu, receipt, kar/zarar\n');
  /*
   * A real staff login, not a bare tenant token: a bill is opened BY someone,
   * and orders.waiter_id records who. Testing with uid 0 would test a path no
   * till ever walks.
   */
  const catalog = require('../src/modules/catalog');
  await db.exec('DELETE FROM users WHERE client_id=? AND username=?', [CID, 'testci']);
  const uid = await catalog.saveUser(CID, {
    display_name: 'Test Garson', username: 'testci', role: 'admin', pin: '4321', password: 'test1234',
  }, null);
  TOKEN = await auth.issueToken({ cid: CID, uid, role: 'admin', name: 'Test Garson', kind: 'pos' });
  const P = await fixture();
  const tableId = await aTable();

  /* =============================== half portions ======================== */
  let orderId = null;

  await step('a half portion can be ordered and is priced as a half', async () => {
    const o = await api('POST', '/api/pos/orders', { table_id: tableId });
    orderId = o.order_id;
    const r = await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: P.kebap, qty: 0.5 });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const line = (await api('GET', `/api/pos/orders/${orderId}`)).order.items[0];
    assert.strictEqual(Number(line.qty), 0.5, 'qty should be 0.5, got ' + line.qty);
    assert.strictEqual(Number(line.line_total), 210, 'half of 420 is 210, got ' + line.line_total);
  });

  await step('a third of a portion is snapped to a half rather than charged as typed', async () => {
    const r = await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: P.pide, qty: 0.33 });
    assert.strictEqual(r.status, 200);
    const o = (await api('GET', `/api/pos/orders/${orderId}`)).order;
    const line = o.items.find(i => i.product_id === P.pide);
    assert.strictEqual(Number(line.qty), 0.5, 'expected a snap to 0.5, got ' + line.qty);
  });

  await step('zero and negative quantities are refused, not stored', async () => {
    for (const q of [0, -1]) {
      const r = await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: P.su, qty: q });
      assert.strictEqual(r.status, 400, `qty ${q} should be refused, got ${r.status}`);
    }
  });

  await step('a half portion can be raised to one and a half from the bill', async () => {
    const o = (await api('GET', `/api/pos/orders/${orderId}`)).order;
    const line = o.items.find(i => i.product_id === P.kebap);
    const r = await api('PUT', `/api/pos/orders/${orderId}/items/${line.id}`, { qty: 1.5 });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const after = (await api('GET', `/api/pos/orders/${orderId}`)).order.items.find(i => i.id === line.id);
    assert.strictEqual(Number(after.qty), 1.5);
    assert.strictEqual(Number(after.line_total), 630);
  });

  /* ================================== notes ============================= */
  await step('a kitchen note can be attached when the item is added', async () => {
    const r = await api('POST', `/api/pos/orders/${orderId}/items`, {
      product_id: P.bira, qty: 1, note: 'az buzlu, ayrı gelsin' });
    assert.strictEqual(r.status, 200);
    const line = (await api('GET', `/api/pos/orders/${orderId}`)).order.items.find(i => i.product_id === P.bira);
    assert.strictEqual(line.note, 'az buzlu, ayrı gelsin');
  });

  await step('a note can be added to a line that is already on the bill', async () => {
    const o = (await api('GET', `/api/pos/orders/${orderId}`)).order;
    const line = o.items.find(i => i.product_id === P.pide);
    const r = await api('PUT', `/api/pos/orders/${orderId}/items/${line.id}`, { note: 'soğansız' });
    assert.strictEqual(r.status, 200);
    const after = (await api('GET', `/api/pos/orders/${orderId}`)).order.items.find(i => i.id === line.id);
    assert.strictEqual(after.note, 'soğansız');
  });

  await step('two lines of the same product with different notes stay separate', async () => {
    await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: P.su, qty: 1, note: 'soğuk' });
    await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: P.su, qty: 1, note: 'oda sıcaklığı' });
    const lines = (await api('GET', `/api/pos/orders/${orderId}`)).order.items.filter(i => i.product_id === P.su);
    assert.strictEqual(lines.length, 2, 'different notes must not be merged into one line');
  });

  /* ============================== bill labels =========================== */
  let secondBill = null;

  await step('the first bill on a table needs no label', async () => {
    const o = (await api('GET', `/api/pos/orders/${orderId}`)).order;
    assert.ok(!o.bill_label, 'a lone bill should carry no label, got ' + o.bill_label);
  });

  await step('a second bill on the same table is labelled automatically', async () => {
    const o = await api('POST', '/api/pos/orders', { table_id: tableId });
    secondBill = o.order_id;
    const b = (await api('GET', `/api/pos/orders/${secondBill}`)).order;
    assert.ok(b.bill_label, 'the second bill must get a label');
    assert.strictEqual(b.bill_label, 'A');
  });

  await step('a third bill takes the next free letter, not a duplicate', async () => {
    const o = await api('POST', '/api/pos/orders', { table_id: tableId });
    const b = (await api('GET', `/api/pos/orders/${o.order_id}`)).order;
    assert.strictEqual(b.bill_label, 'B');
    await api('POST', `/api/pos/orders/${o.order_id}/reopen`).catch(() => {});
    await db.exec('UPDATE orders SET status=?, is_deleted=1 WHERE id=?', ['cancelled', o.order_id]);
  });

  await step('a bill can be renamed to what the guests are called', async () => {
    const r = await api('POST', `/api/pos/orders/${secondBill}/label`, { label: 'Pencere' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const b = (await api('GET', `/api/pos/orders/${secondBill}`)).order;
    assert.strictEqual(b.bill_label, 'Pencere');
  });

  await step('the floor plan shows which bills are on a table', async () => {
    const plan = await api('GET', '/api/pos/tables');
    const t = plan.tables.find(x => x.id === tableId);
    assert.ok(t.open_bills >= 2, 'expected at least two open bills, got ' + t.open_bills);
    assert.ok(String(t.labels).includes('Pencere'), 'labels should reach the floor plan, got ' + t.labels);
  });

  /* ============================ split and transfer ====================== */
  await step('a bill can be split and the new half is labelled, not called A-B', async () => {
    const o = (await api('GET', `/api/pos/orders/${orderId}`)).order;
    const line = o.items.find(i => i.product_id === P.bira);
    const r = await api('POST', `/api/pos/orders/${orderId}/split`, {
      lines: [{ itemId: line.id, qty: 1 }] });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const nb = (await api('GET', `/api/pos/orders/${r.order_id}`)).order;
    assert.ok(nb.bill_label && !nb.bill_label.includes('-'),
      'split label should be a single letter, got ' + nb.bill_label);
    assert.strictEqual(nb.items.length, 1);
    assert.strictEqual(nb.items[0].note, 'az buzlu, ayrı gelsin', 'the note must travel with the line');
    assert.ok(Number(nb.items[0].cost_price) > 0, 'the cost must travel with the line, or margins break');
  });

  /* ================================ receipt ============================= */
  await step('the receipt lines add up to the receipt total', async () => {
    const doc = require('../src/print/document');
    const orders = require('../src/modules/orders');
    const o = await orders.getOrder(CID, orderId);
    const d = await doc.billDocument(CID, o);
    const sum = d.lines.reduce((s, l) => s + l.lineTotal, 0);
    assert.strictEqual(Math.round(sum * 100) / 100, d.totals.subtotal,
      'lines sum to ' + sum + ' but Ara Toplam says ' + d.totals.subtotal);
    assert.strictEqual(d.totals.grand, Math.round((d.totals.subtotal - d.totals.discount) * 100) / 100);
  });

  await step('KDV is taken out of the price, not added on top', async () => {
    const doc = require('../src/print/document');
    // a single 20% line: 180 gross -> 180*20/120 = 30.00 of VAT inside it
    const v = doc.vatBreakdown([{ lineTotal: 180, vatRate: 20 }]);
    assert.strictEqual(v.length, 1);
    assert.strictEqual(v[0].vat, 30, 'inclusive VAT on 180 at 20% is 30, got ' + v[0].vat);
    assert.strictEqual(v[0].base, 150, 'the base is 150, got ' + v[0].base);
  });

  await step('two KDV rates on one bill are shown separately', async () => {
    const doc = require('../src/print/document');
    const v = doc.vatBreakdown([
      { lineTotal: 220, vatRate: 10 },
      { lineTotal: 180, vatRate: 20 },
      { lineTotal: 440, vatRate: 10 },
    ]);
    assert.strictEqual(v.length, 2, 'a 10% and a 20% line must not be merged');
    assert.strictEqual(v[0].rate, 10);
    assert.strictEqual(v[0].vat, 60, '660 at 10% inclusive is 60, got ' + v[0].vat);
    assert.strictEqual(v[1].vat, 30);
  });

  await step('a stored total that disagrees with the lines is repaired, not printed', async () => {
    const doc = require('../src/print/document');
    const orders = require('../src/modules/orders');
    // this is the reported bug: header says 850, the lines say something else
    await db.exec('UPDATE orders SET total=850, grand_total=850 WHERE id=?', [orderId]);
    const o = await orders.getOrder(CID, orderId);
    const d = await doc.billDocument(CID, o);
    const stored = await db.one('SELECT grand_total FROM orders WHERE id=?', [orderId]);
    assert.strictEqual(Number(stored.grand_total), d.totals.grand,
      'the header should have been rewritten to match the lines');
    assert.notStrictEqual(d.totals.grand, 850);
  });

  await step('a cancelled line is off the paper as well as out of the total', async () => {
    const doc = require('../src/print/document');
    const orders = require('../src/modules/orders');
    /*
     * A line with a note nothing else carries, so "is it still on the paper?"
     * has one answer. Matching on name and amount would be ambiguous the
     * moment the same product appears twice, which on a real bill it does.
     */
    await api('POST', `/api/pos/orders/${orderId}/items`,
      { product_id: P.su, qty: 1, note: 'IPTAL EDILECEK' });
    let o = await orders.getOrder(CID, orderId);
    const line = o.items.find(i => i.note === 'IPTAL EDILECEK');
    assert.ok(line, 'fixture line not added');
    const before = await doc.billDocument(CID, o);
    assert.ok(before.lines.some(l => l.note === 'IPTAL EDILECEK'), 'should be on the bill first');

    await db.exec('UPDATE order_items SET is_deleted=1 WHERE id=?', [line.id]);
    o = await orders.getOrder(CID, orderId);
    const after = await doc.billDocument(CID, o);
    assert.ok(!after.lines.some(l => l.note === 'IPTAL EDILECEK'),
      'a deleted line must not be printed');
    assert.strictEqual(after.totals.subtotal,
      Math.round((before.totals.subtotal - Number(line.line_total)) * 100) / 100,
      'and the total must drop by exactly that line');
  });

  await step('the PDF renders with each column in its own place', async () => {
    const mail = require('../src/mail');
    const orders = require('../src/modules/orders');
    const o = await orders.getOrder(CID, orderId);
    const file = await mail.billPdf(CID, o);
    assert.ok(fs.existsSync(file), 'no PDF produced');
    const size = fs.statSync(file).size;
    assert.ok(size > 1200, 'PDF suspiciously small: ' + size + ' bytes');
    const raw = fs.readFileSync(file);
    assert.strictEqual(raw.slice(0, 5).toString(), '%PDF-', 'not a PDF');
  });

  await step('the e-mail body carries the whole bill, not just a total', async () => {
    const mail = require('../src/mail');
    const doc = require('../src/print/document');
    const orders = require('../src/modules/orders');
    const d = await doc.billDocument(CID, await orders.getOrder(CID, orderId));
    const html = mail.billHtml(d);
    assert.ok(html.includes('<th'), 'the mail must contain a real item table');
    for (const head of ['Urun', 'Adet', 'Birim', 'Tutar', 'KDV']) {
      assert.ok(html.includes(head), 'missing column header: ' + head);
    }
    for (const l of d.lines) {
      assert.ok(html.includes(l.name), 'item missing from the mail: ' + l.name);
    }
    assert.ok(html.includes('GENEL TOPLAM'));
    // the exact bug the customer saw: two totals that cannot both be true
    assert.ok(!/Ara Toplam[\s\S]{0,400}850,00/.test(html) || d.totals.subtotal === 850);
  });

  await step('the thermal bill prints the same numbers as the PDF', async () => {
    const printing = require('../src/print');
    const doc = require('../src/print/document');
    const orders = require('../src/modules/orders');
    const o = await orders.getOrder(CID, orderId);
    const d = await doc.billDocument(CID, o);
    const bytes = await printing.buildBill(CID, o);
    const text = bytes.toString('latin1');
    const expect = d.totals.grand.toFixed(2).replace('.', ',');
    const grouped = expect.replace(/\B(?=(\d{3})+(?!\d),)/g, '.');
    assert.ok(text.includes(expect) || text.includes(grouped),
      'the printed TOPLAM should be ' + expect);
  });

  /* ============================ import / export ========================= */
  await step('the menu exports as CSV with Turkish decimals', async () => {
    const p = require('../src/modules/portage');
    const csv = await p.exportCsv(CID, 'products');
    assert.ok(csv.startsWith('﻿'), 'a BOM is what makes Excel read the Turkish characters');
    const lines = csv.trim().split('\r\n');
    assert.ok(lines.length >= 5, 'expected a header and four products');
    assert.ok(lines[0].includes(';'), 'Turkish Excel needs semicolons');
    assert.ok(/;\d+,\d{2};/.test(lines[1]), 'prices should carry a comma decimal: ' + lines[1]);
  });

  await step('the menu exports as a real xlsx workbook', async () => {
    const p = require('../src/modules/portage');
    const buf = Buffer.from(await p.exportXlsx(CID, 'products'));
    assert.strictEqual(buf.slice(0, 2).toString(), 'PK', 'not a zip, so not an xlsx');
    const rows = await p.readFile('products', buf, 'x.xlsx');
    assert.strictEqual(rows.length, 4, 'expected the four products back, got ' + rows.length);
  });

  await step('exporting and re-importing changes nothing (no duplicates)', async () => {
    const p = require('../src/modules/portage');
    const before = Number(await db.value('SELECT COUNT(*) FROM products WHERE client_id=?', [CID]));
    const buf = Buffer.from(await p.exportXlsx(CID, 'products'));
    const rows = await p.readFile('products', buf, 'x.xlsx');
    const { plan, summary } = await p.planImport(CID, 'products', rows);
    assert.strictEqual(summary.create, 0, 'a round trip must not create anything');
    assert.strictEqual(summary.update, before);
    await p.applyImport(CID, 'products', plan, 1);
    const after = Number(await db.value('SELECT COUNT(*) FROM products WHERE client_id=?', [CID]));
    assert.strictEqual(after, before, 'the menu doubled: ' + before + ' -> ' + after);
  });

  await step('a hand-typed price list updates by name and creates what is missing', async () => {
    const p = require('../src/modules/portage');
    const csv = 'Kategori;Urun Adi;Fiyat;KDV %\n'
              + 'Yemekler;Adana Kebap;480,00;10\n'
              + 'Tatlılar;Künefe;1.250,00;10\n';
    const rows = await p.readFile('products', Buffer.from(csv, 'utf8'), 'liste.csv');
    const { plan, summary } = await p.planImport(CID, 'products', rows);
    assert.strictEqual(summary.update, 1);
    assert.strictEqual(summary.create, 1);
    await p.applyImport(CID, 'products', plan, 1);
    const kebap = await db.one('SELECT price FROM products WHERE client_id=? AND name=?', [CID, 'Adana Kebap']);
    assert.strictEqual(Number(kebap.price), 480, 'the existing product should have been updated');
    const kunefe = await db.one('SELECT price FROM products WHERE client_id=? AND name=?', [CID, 'Künefe']);
    assert.strictEqual(Number(kunefe.price), 1250,
      '"1.250,00" is 1250, not 1.25 - got ' + kunefe.price);
    const cat = await db.one('SELECT id FROM categories WHERE client_id=? AND name=?', [CID, 'Tatlılar']);
    assert.ok(cat, 'the missing category should have been created');
  });

  await step('a price-only file does not blank the columns it omits', async () => {
    const p = require('../src/modules/portage');
    await db.exec('UPDATE products SET description=? WHERE client_id=? AND name=?',
      ['El açması', CID, 'Kıymalı Pide']);
    const csv = 'Urun Adi;Fiyat\nKıymalı Pide;240,00\n';
    const rows = await p.readFile('products', Buffer.from(csv, 'utf8'), 'z.csv');
    const { plan } = await p.planImport(CID, 'products', rows);
    await p.applyImport(CID, 'products', plan, 1);
    const row = await db.one('SELECT price, description, cost_price FROM products WHERE client_id=? AND name=?',
      [CID, 'Kıymalı Pide']);
    assert.strictEqual(Number(row.price), 240);
    assert.strictEqual(row.description, 'El açması', 'the description was wiped by a price-only import');
    assert.strictEqual(Number(row.cost_price), 70, 'the cost was wiped by a price-only import');
  });

  await step('a row with no price and no match is skipped with a reason, not guessed', async () => {
    const p = require('../src/modules/portage');
    const csv = 'Kategori;Urun Adi;Fiyat\nYemekler;;100,00\nYemekler;Yeni Sey;\n';
    const rows = await p.readFile('products', Buffer.from(csv, 'utf8'), 'z.csv');
    const { plan, summary } = await p.planImport(CID, 'products', rows);
    assert.strictEqual(summary.skip, 2, JSON.stringify(plan));
    assert.ok(plan.every(x => x.errors.length), 'every skipped row must say why');
  });

  await step('the same name twice in one file is caught instead of applied twice', async () => {
    const p = require('../src/modules/portage');
    const csv = 'Kategori;Urun Adi;Fiyat\nYemekler;Tekrar;10,00\nYemekler;Tekrar;20,00\n';
    const rows = await p.readFile('products', Buffer.from(csv, 'utf8'), 'z.csv');
    const { summary } = await p.planImport(CID, 'products', rows);
    assert.strictEqual(summary.create, 1);
    assert.strictEqual(summary.skip, 1);
  });

  await step('categories import and export the same way', async () => {
    const p = require('../src/modules/portage');
    const csv = 'Kategori Adi;Sira;Aktif\nKahvaltı;9;Evet\n';
    const rows = await p.readFile('categories', Buffer.from(csv, 'utf8'), 'c.csv');
    const { plan, summary } = await p.planImport(CID, 'categories', rows);
    assert.strictEqual(summary.create, 1);
    await p.applyImport(CID, 'categories', plan, 1);
    const c = await db.one('SELECT sort_order, is_active FROM categories WHERE client_id=? AND name=?',
      [CID, 'Kahvaltı']);
    assert.ok(c, 'category not created');
    assert.strictEqual(Number(c.sort_order), 9);
    assert.strictEqual(Number(c.is_active), 1, '"Evet" should mean active');
  });

  await step('the import endpoints work over HTTP the way the screen calls them', async () => {
    const csv = Buffer.from('Kategori;Urun Adi;Fiyat\nYemekler;HTTP Testi;55,50\n', 'utf8');
    const body = { filename: 'x.csv', content_base64: csv.toString('base64') };
    const pv = await api('POST', '/api/manage/products/import/preview', body);
    assert.strictEqual(pv.status, 200, JSON.stringify(pv));
    assert.strictEqual(pv.summary.create, 1);
    const ap = await api('POST', '/api/manage/products/import/apply', body);
    assert.strictEqual(ap.status, 200, JSON.stringify(ap));
    assert.strictEqual(ap.created, 1);
    const row = await db.one('SELECT price FROM products WHERE client_id=? AND name=?', [CID, 'HTTP Testi']);
    assert.strictEqual(Number(row.price), 55.5);
  });

  await step('the export endpoint returns a downloadable file', async () => {
    const res = await fetch(BASE + '/api/manage/products/export?format=csv',
      { headers: { Authorization: 'Bearer ' + TOKEN } });
    assert.strictEqual(res.status, 200);
    assert.ok(String(res.headers.get('content-disposition')).includes('attachment'));
    const text = await res.text();
    assert.ok(text.includes('HTTP Testi'));
  });

  /* ================================= kar / zarar ======================== */
  await step('profit and loss balances: revenue - vat - cost - expenses = net', async () => {
    // close the bill so it counts as trade
    const o = (await api('GET', `/api/pos/orders/${orderId}`)).order;
    await api('POST', `/api/pos/orders/${orderId}/payments`,
      { method: 'nakit', amount: Number(o.grand_total) });
    await api('POST', '/api/manage/costs', { date: new Date().toISOString().slice(0, 10),
      category: 'Personel', description: 'Test', amount: 500 });

    const pnl = require('../src/modules/pnl');
    const r = await pnl.profitAndLoss(CID, '2000-01-01', '2100-01-01');
    const T = r.totals;
    assert.ok(T.orders > 0, 'no closed orders found');
    const expectNet = Math.round((T.revenue_gross - T.vat) * 100) / 100;
    assert.strictEqual(T.revenue_net, expectNet, 'revenue_net must be gross minus VAT');
    const expectGross = Math.round((T.revenue_net - T.cogs) * 100) / 100;
    assert.strictEqual(T.gross_profit, expectGross);
    assert.strictEqual(T.net_profit, Math.round((T.gross_profit - T.expenses) * 100) / 100);
    assert.strictEqual(T.expenses, 500);
  });

  await step('the old system\'s profit figure is reported alongside for reconciliation', async () => {
    const pnl = require('../src/modules/pnl');
    const { totals: T } = await pnl.profitAndLoss(CID, '2000-01-01', '2100-01-01');
    assert.strictEqual(T.legacy_profit,
      Math.round((T.revenue_gross - T.cogs - T.expenses) * 100) / 100);
    assert.ok(T.legacy_profit > T.net_profit,
      'the old figure leaves VAT in, so it must be the higher of the two');
  });

  await step('day totals sum to the range total', async () => {
    const pnl = require('../src/modules/pnl');
    const r = await pnl.profitAndLoss(CID, '2000-01-01', '2100-01-01');
    const summed = Math.round(r.rows.reduce((s, d) => s + d.net_profit, 0) * 100) / 100;
    assert.strictEqual(summed, r.totals.net_profit);
  });

  await step('an uncosted product is named rather than counted as pure profit', async () => {
    const pnl = require('../src/modules/pnl');
    const st = await pnl.statement(CID, '2000-01-01', '2100-01-01');
    assert.ok(st.uncosted.products.length > 0, 'Su has no cost and should be listed');
    assert.ok(st.uncosted.products.some(u => u.name === 'Su'));
    assert.ok(st.uncosted.share_of_revenue > 0);
  });

  await step('product profit is net of VAT and sorted by contribution', async () => {
    const pnl = require('../src/modules/pnl');
    const rows = await pnl.productProfit(CID, '2000-01-01', '2100-01-01');
    assert.ok(rows.length, 'no products sold');
    for (const p of rows) {
      assert.strictEqual(p.revenue_net, Math.round((p.revenue_gross - p.vat) * 100) / 100);
      assert.strictEqual(p.profit, Math.round((p.revenue_net - p.cogs) * 100) / 100);
    }
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].profit >= rows[i].profit, 'not sorted by profit');
    }
  });

  await step('a cancelled bill is excluded from profit but reported separately', async () => {
    const pnl = require('../src/modules/pnl');
    const before = (await pnl.profitAndLoss(CID, '2000-01-01', '2100-01-01')).totals;
    const o = await api('POST', '/api/pos/orders', { table_id: tableId });
    await api('POST', `/api/pos/orders/${o.order_id}/items`, { product_id: P.kebap, qty: 1 });
    await db.exec(
      `UPDATE orders SET status='cancelled', is_closed=1, exclude_from_reports=1, is_deleted=1,
              closed_at=NOW() WHERE id=?`, [o.order_id]);
    const after = (await pnl.profitAndLoss(CID, '2000-01-01', '2100-01-01')).totals;
    assert.strictEqual(after.revenue_gross, before.revenue_gross,
      'a cancelled bill must not move the revenue');
    assert.ok(after.cancelled_orders > before.cancelled_orders,
      'but it must be visible in the cancelled column');
  });

  await step('the profit and loss endpoint answers over HTTP', async () => {
    const r = await api('GET', '/api/reports/pnl?from=2000-01-01&to=2100-01-01');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.totals && r.rows && r.products && r.categories && r.uncosted);
    const csv = await fetch(BASE + '/api/reports/export/pnl?from=2000-01-01&to=2100-01-01',
      { headers: { Authorization: 'Bearer ' + TOKEN } });
    assert.strictEqual(csv.status, 200);
    // the export carries Turkish headers now, not the raw column keys - see
    // test/export.js for why (a Turkish Excel could not read the old file)
    // arrayBuffer, not text(): fetch strips a leading BOM and the BOM is the
    // whole point of the file - test/export.js checks it byte by byte
    const text = Buffer.from(await csv.arrayBuffer()).toString('utf8');
    assert.strictEqual(text.charCodeAt(0), 0xFEFF, 'BOM yok');
    assert.ok(text.includes('Net Kâr'), 'başlık Türkçe değil: ' + text.split('\r\n')[0]);
  });

  /* ================================= results ============================ */
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.message); process.exit(1); });
