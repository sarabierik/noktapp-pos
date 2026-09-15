'use strict';
/**
 * Fiyatlandırma - the money the menu is supposed to make, and the product-card
 * housekeeping that decides it.
 *
 * Every check here runs against a real MariaDB and the real HTTP service. The
 * defects this suite exists to catch are the ones a mock hides by definition:
 * an accepted suggestion that changes nothing (the shipped PHP did exactly
 * that for its whole life), a margin computed on a KDV-inclusive price as if
 * the tax were the restaurant's money, a product row deleted out from under
 * last year's profit report, a bulk raise that leaks into the category next to
 * it, and a "suggestion" built on a cost nobody ever measured but presented as
 * if it had been.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/pricing.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7466';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
let TOKEN = null;
let UID = null;

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
 * The migration is applied here rather than assumed. The desktop shell re-runs
 * every file in database/migrations on each start; a test run has no shell, and
 * a suite that dies with "Table 'pricing_targets' doesn't exist" tells the next
 * person nothing about pricing. The file is idempotent, so this is the same
 * thing the shell does.
 */
async function migrate() {
  const file = path.join(__dirname, '..', '..', 'database', 'migrations', '2026-09-03-pricing.sql');
  const sql = fs.readFileSync(file, 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await db.exec(stmt); } catch (e) { /* already applied */ }
  }
}

/*
 * A menu whose arithmetic is checkable by hand.
 *
 * Every price below includes KDV, because every price in this system does.
 * "Kıymalı Pide" is the worked example the whole suite leans on: 220,00 ₺ at
 * 10% KDV is 200,00 ₺ net, and a 70,00 ₺ cost is a 65% net margin exactly. A
 * 65% target therefore has to give the price back unchanged, and any other
 * answer means somebody is measuring the margin against the tax.
 */
async function fixture() {
  await db.exec('DELETE FROM order_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM order_payments WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM loyalty_events WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM order_discounts WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM orders WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM pricing_suggestions WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM pricing_targets WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM product_costs WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM product_price_history WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM price_change_log WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM product_recipes WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM product_stock WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM products WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM categories WHERE client_id=?', [CID]);

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
    pide: await mk(cat, 'Kıymalı Pide', 220, 70, 10),      // 200 net, 70 cost -> exactly 65%
    kebap: await mk(cat, 'Adana Kebap', 420, 160, 10),
    lahmacun: await mk(cat, 'Lahmacun', 100, 55, 10),      // thin: 90,91 net -> 39,5%
    bira: await mk(drinks, 'Efes Pilsen', 180, 70, 20),
    su: await mk(drinks, 'Su', 30, 0, 10),                 // deliberately uncosted
  };
}

let billNo = 900000;
/** A closed bill, so the sale-frozen cost history has something in it. */
async function soldBill(productId, qty, unitPrice, costPrice, vat) {
  const orderId = await db.insert(
    `INSERT INTO orders (client_id, adisyon_no, business_date, status, opened_at, closed_at,
        total, grand_total, vat_total, is_closed, is_deleted, exclude_from_reports)
     VALUES (?,?,CURDATE(),'closed',NOW(),NOW(),?,?,?,1,0,0)`,
    // adisyon_no is an int on this schema, not a string: a text bill number
    // is rejected outright under STRICT_TRANS_TABLES rather than truncated
    [CID, ++billNo, unitPrice * qty, unitPrice * qty, 0]);
  await db.insert(
    `INSERT INTO order_items (client_id, order_id, product_id, qty, unit_price, price, cost_price,
        line_total, total, vat_rate, vat_total, is_deleted)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`,
    [CID, orderId, productId, qty, unitPrice, unitPrice, costPrice, unitPrice * qty,
     unitPrice * qty, vat, 0]);
  return orderId;
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  await migrate();
  console.log('\nNOKTApp POS - fiyatlandırma, maliyet ve fiyat geçmişi\n');

  const catalog = require('../src/modules/catalog');
  const pricing = require('../src/modules/pricing');
  await db.exec('DELETE FROM users WHERE client_id=? AND username=?', [CID, 'fiyatci']);
  UID = await catalog.saveUser(CID, {
    display_name: 'Fiyat Yöneticisi', username: 'fiyatci', role: 'admin',
    pin: '5321', password: 'test1234',
  }, null);
  TOKEN = await auth.issueToken({ cid: CID, uid: UID, role: 'admin', name: 'Fiyat Yöneticisi', kind: 'pos' });
  const P = await fixture();

  /* ====================== the arithmetic, on its own ==================== */

  await step('KDV comes out of the price before the margin is measured', async () => {
    // 220,00 at 10% is 200,00 of the restaurant's money
    assert.strictEqual(pricing.netOf(220, 10), 200, 'net of 220 at 10% is 200');
    assert.strictEqual(pricing.netOf(180, 20), 150, 'net of 180 at 20% is 150');
    // and the margin is against the 200, not the 220
    assert.strictEqual(pricing.marginOf(220, 70, 10), 65,
      '70 cost on 200 net is a 65% margin, got ' + pricing.marginOf(220, 70, 10));
    assert.notStrictEqual(pricing.marginOf(220, 70, 10), pricing.marginOf(220, 70, 0),
      'a VAT-inclusive price must not be measured as if it were VAT-free');
  });

  await step('the target price is the inverse of the margin, KDV added back on', async () => {
    // 70 cost at a 65% target -> 200 net -> 220 shelf price at 10% KDV
    assert.strictEqual(pricing.priceForMargin(70, 65, 10), 220);
    // 70 cost at a 65% target on a 20% product -> 200 net -> 240
    assert.strictEqual(pricing.priceForMargin(70, 65, 20), 240);
    // and it round-trips
    assert.strictEqual(pricing.marginOf(pricing.priceForMargin(55, 72, 10), 55, 10), 72);
  });

  await step('the rounding step snaps to 0,25 / 0,50 / 1,00 and nothing else', async () => {
    assert.strictEqual(pricing.roundStep(220.13, 0.25, 'near'), 220.25);
    assert.strictEqual(pricing.roundStep(220.13, 0.5, 'near'), 220);
    assert.strictEqual(pricing.roundStep(220.13, 1, 'near'), 220);
    assert.strictEqual(pricing.roundStep(220.01, 0.25, 'up'), 220.25,
      'a suggestion rounds UP or it lands under the target it was computed for');
    assert.strictEqual(pricing.roundStep(220, 0.25, 'up'), 220, 'an exact multiple must not creep up');
  });

  /* ========================== cost history ============================= */

  await step('a cost is recorded with an effective date and shows in the history', async () => {
    const r = await api('POST', `/api/pricing/products/${P.kebap}/costs`,
      { cost: 150, effective_date: '2026-01-10', note: 'Ocak alımı' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const h = await api('GET', `/api/pricing/products/${P.kebap}/costs`);
    assert.strictEqual(h.costs.length, 1, 'the cost history should hold one row');
    assert.strictEqual(Number(h.costs[0].cost), 150);
    assert.strictEqual(String(h.costs[0].effective_date).slice(0, 10), '2026-01-10');
    assert.strictEqual(h.costs[0].note, 'Ocak alımı');
    assert.strictEqual(h.costs[0].created_by_name, 'Fiyat Yöneticisi',
      'the history must say who recorded it');
  });

  await step('the newest cost by effective date becomes the product cost', async () => {
    await api('POST', `/api/pricing/products/${P.kebap}/costs`,
      { cost: 190, effective_date: '2026-03-01' });
    const p = await db.one('SELECT cost_price FROM products WHERE id=?', [P.kebap]);
    assert.strictEqual(Number(p.cost_price), 190, 'the March cost should now be the card cost');
  });

  await step('a back-dated cost is kept but does not overwrite the newer one', async () => {
    // a delivery note typed up late: it belongs in the history, it is not today's cost
    await api('POST', `/api/pricing/products/${P.kebap}/costs`,
      { cost: 120, effective_date: '2025-11-05' });
    const p = await db.one('SELECT cost_price FROM products WHERE id=?', [P.kebap]);
    assert.strictEqual(Number(p.cost_price), 190,
      'a back-dated cost must not become the current one, got ' + p.cost_price);
    const h = await api('GET', `/api/pricing/products/${P.kebap}/costs`);
    assert.strictEqual(h.costs.length, 3, 'all three costs stay in the history');
    assert.strictEqual(Number(h.costs[0].cost), 190, 'the history is newest first');
    assert.strictEqual(Number(h.costs[2].cost), 120, 'and the back-dated one is last');
  });

  await step('a cost with no date or a negative amount is refused', async () => {
    const a = await api('POST', `/api/pricing/products/${P.kebap}/costs`, { cost: 10 });
    assert.strictEqual(a.status, 400, 'a cost with no effective date must be refused');
    const b = await api('POST', `/api/pricing/products/${P.kebap}/costs`,
      { cost: -5, effective_date: '2026-02-02' });
    assert.strictEqual(b.status, 400, 'a negative cost must be refused');
  });

  /* ========================== price history ============================ */

  await step('a price change writes the history with the old and the new value', async () => {
    const before = await db.one('SELECT price FROM products WHERE id=?', [P.lahmacun]);
    const p = await db.one('SELECT * FROM products WHERE id=?', [P.lahmacun]);
    await catalog.saveProduct(CID, { ...p, is_active: true, price: 125 }, UID);

    const h = await api('GET', `/api/pricing/products/${P.lahmacun}/prices`);
    assert.strictEqual(h.status, 200, JSON.stringify(h));
    assert.ok(h.changes.length >= 1, 'the change log must have a row');
    const c = h.changes[0];
    assert.strictEqual(c.old_price, Number(before.price), 'the old price must be recorded');
    assert.strictEqual(c.new_price, 125, 'and the new one');
    assert.strictEqual(c.change, 25);
    assert.strictEqual(c.changed_by_name, 'Fiyat Yöneticisi', 'and who did it');
    assert.ok(c.changed_at, 'and when');
    assert.ok(h.series.length >= 1, 'the dated price series must have a row too');
    assert.strictEqual(h.series[0].price, 125);
  });

  /* ======================= soft vs hard delete ========================= */

  await step('a product on a past bill cannot be hard-deleted', async () => {
    await soldBill(P.pide, 2, 220, 70, 10);
    const use = await api('GET', `/api/pricing/products/${P.pide}/usage`);
    assert.ok(use.usage.items > 0, 'the fixture bill did not stick');
    assert.strictEqual(use.usage.can_hard_delete, false);

    const r = await api('DELETE', `/api/pricing/products/${P.pide}?hard=1`);
    assert.strictEqual(r.status, 409, 'a sold product must be refused, got ' + r.status);
    assert.ok(/adisyon/i.test(r.error), 'the refusal must say why: ' + r.error);
    const still = await db.one('SELECT id FROM products WHERE id=?', [P.pide]);
    assert.ok(still, 'and the product must still be there');
  });

  await step('the same product can be deactivated, and the bill still resolves', async () => {
    const r = await api('DELETE', `/api/pricing/products/${P.pide}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.result.mode, 'deactivated');
    const p = await db.one('SELECT is_active FROM products WHERE id=?', [P.pide]);
    assert.strictEqual(Number(p.is_active), 0);
    // the whole point of the soft delete: last month's profit report still works
    const pnl = require('../src/modules/pnl');
    const rows = await pnl.productProfit(CID, '2000-01-01', '2100-01-01');
    assert.ok(rows.some(x => x.name === 'Kıymalı Pide'),
      'a deactivated product must still resolve on a past bill');
    // put it back for the tests below
    await db.exec('UPDATE products SET is_active=1 WHERE id=?', [P.pide]);
  });

  await step('a product never sold can be hard-deleted, histories and all', async () => {
    const dup = await api('POST', `/api/pricing/products/${P.lahmacun}/duplicate`,
      { name: 'Silinecek Ürün' });
    assert.strictEqual(dup.status, 200, JSON.stringify(dup));
    const id = dup.result.id;
    await api('POST', `/api/pricing/products/${id}/costs`, { cost: 12, effective_date: '2026-02-01' });

    const r = await api('DELETE', `/api/pricing/products/${id}?hard=1`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.result.mode, 'deleted');
    assert.strictEqual(await db.one('SELECT id FROM products WHERE id=?', [id]), null);
    const orphans = Number(await db.value(
      'SELECT COUNT(*) FROM product_costs WHERE client_id=? AND product_id=?', [CID, id]));
    assert.strictEqual(orphans, 0, 'the cost history must go with it, not be orphaned');
  });

  await step('re-activating a product does not un-hide what was hidden on purpose', async () => {
    // a product deliberately kept off the till but still on the QR menu: going
    // back through catalog.saveProduct would read use_in_pos=0 as "not false"
    // and turn it visible again, which is the flag trap this module avoids
    await db.exec('UPDATE products SET is_active=0, use_in_pos=0, use_in_qr=1 WHERE id=?', [P.bira]);
    const r = await api('POST', `/api/pricing/products/${P.bira}/activate`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const p = await db.one('SELECT is_active, use_in_pos, use_in_qr FROM products WHERE id=?', [P.bira]);
    assert.strictEqual(Number(p.is_active), 1, 'it should be back on');
    assert.strictEqual(Number(p.use_in_pos), 0, 'but still hidden from the till');
    assert.strictEqual(Number(p.use_in_qr), 1);
    await db.exec('UPDATE products SET use_in_pos=1 WHERE id=?', [P.bira]);
  });

  await step('a price change on an inactive product does not silently re-activate it', async () => {
    await db.exec('UPDATE products SET is_active=0 WHERE id=?', [P.su]);
    await api('POST', '/api/pricing/bulk/apply', { category_id: P.drinks, percent: 5, round_to: 0.25 });
    const p = await db.one('SELECT is_active FROM products WHERE id=?', [P.su]);
    assert.strictEqual(Number(p.is_active), 0, 'a bulk change must not resurrect a retired product');
    await db.exec('UPDATE products SET is_active=1, price=30 WHERE id=?', [P.su]);
  });

  /* ==================== category soft delete cascade ==================== */

  await step('deactivating a category deactivates its products and nothing else', async () => {
    const beforeDrinks = Number(await db.value(
      'SELECT COUNT(*) FROM products WHERE client_id=? AND category_id=? AND is_active=1',
      [CID, P.drinks]));
    const r = await api('DELETE', `/api/pricing/categories/${P.cat}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.result.mode, 'deactivated');
    assert.ok(r.result.products >= 3, 'expected the Yemekler products, got ' + r.result.products);

    const live = Number(await db.value(
      'SELECT COUNT(*) FROM products WHERE client_id=? AND category_id=? AND is_active=1',
      [CID, P.cat]));
    assert.strictEqual(live, 0, 'every product in the category must be off');
    const c = await db.one('SELECT is_active FROM categories WHERE id=?', [P.cat]);
    assert.strictEqual(Number(c.is_active), 0, 'and the category itself');
    const afterDrinks = Number(await db.value(
      'SELECT COUNT(*) FROM products WHERE client_id=? AND category_id=? AND is_active=1',
      [CID, P.drinks]));
    assert.strictEqual(afterDrinks, beforeDrinks, 'the other category must not be touched');
  });

  await step('re-activating the category brings its products back', async () => {
    const r = await api('POST', `/api/pricing/categories/${P.cat}/activate`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const live = Number(await db.value(
      'SELECT COUNT(*) FROM products WHERE client_id=? AND category_id=? AND is_active=1',
      [CID, P.cat]));
    assert.ok(live >= 3, 'expected the products back on, got ' + live);
  });

  await step('a category with products in it cannot be hard-deleted', async () => {
    const r = await api('DELETE', `/api/pricing/categories/${P.cat}?hard=1`);
    assert.strictEqual(r.status, 409, 'got ' + r.status + ' ' + r.error);
    assert.ok(await db.one('SELECT id FROM categories WHERE id=?', [P.cat]));
  });

  /* ========================== bulk price change ======================== */

  await step('a bulk raise applies the percentage and the rounding to one category only', async () => {
    const before = await db.query(
      'SELECT id, category_id, price FROM products WHERE client_id=? AND is_active=1', [CID]);
    const mine = before.filter(p => p.category_id === P.cat);
    const others = before.filter(p => p.category_id !== P.cat);
    assert.ok(mine.length >= 3 && others.length >= 1, 'fixture too small to prove containment');

    const prev = await api('POST', '/api/pricing/bulk',
      { category_id: P.cat, percent: 10, round_to: 0.5 });
    assert.strictEqual(prev.status, 200, JSON.stringify(prev));
    assert.strictEqual(prev.applied, false, 'the preview must not write');
    assert.strictEqual(prev.count, mine.length, 'the preview must cover exactly the category');

    const r = await api('POST', '/api/pricing/bulk/apply',
      { category_id: P.cat, percent: 10, round_to: 0.5 });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.applied, true);

    for (const p of mine) {
      const now = await db.one('SELECT price FROM products WHERE id=?', [p.id]);
      const raw = Number(p.price) * 1.1;
      const want = Math.round(Math.round(raw / 0.5) * 0.5 * 100) / 100;
      assert.strictEqual(Number(now.price), want,
        `product ${p.id}: ${p.price} +10% rounded to 0,50 is ${want}, got ${now.price}`);
    }
    for (const p of others) {
      const now = await db.one('SELECT price FROM products WHERE id=?', [p.id]);
      assert.strictEqual(Number(now.price), Number(p.price),
        'a product outside the category was moved: ' + p.id);
    }
  });

  await step('a bulk change leaves the same price history as a hand edit', async () => {
    const h = await api('GET', `/api/pricing/products/${P.kebap}/prices`);
    assert.ok(h.changes.length >= 1, 'the bulk raise must be in the change log');
    assert.ok(h.changes[0].new_price > h.changes[0].old_price);
    assert.strictEqual(h.changes[0].changed_by_name, 'Fiyat Yöneticisi');
  });

  await step('a rounding step nobody can make change for is refused', async () => {
    const r = await api('POST', '/api/pricing/bulk', { category_id: P.cat, percent: 5, round_to: 0.3 });
    assert.strictEqual(r.status, 400, 'got ' + r.status);
  });

  /* ============================ duplicate ============================== */

  await step('a product can be duplicated, with a free name and its recipe', async () => {
    const r = await api('POST', `/api/pricing/products/${P.bira}/duplicate`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.result.name, 'Efes Pilsen (kopya)');
    const copy = await db.one('SELECT * FROM products WHERE id=?', [r.result.id]);
    const orig = await db.one('SELECT * FROM products WHERE id=?', [P.bira]);
    assert.strictEqual(Number(copy.price), Number(orig.price));
    assert.strictEqual(Number(copy.vat_rate), Number(orig.vat_rate));
    assert.strictEqual(copy.category_id, orig.category_id);
    // and a second copy must not collide with the unique (client_id, name) key
    const again = await api('POST', `/api/pricing/products/${P.bira}/duplicate`, {});
    assert.strictEqual(again.status, 200, JSON.stringify(again));
    assert.strictEqual(again.result.name, 'Efes Pilsen (kopya) 2');
    await api('DELETE', `/api/pricing/products/${r.result.id}?hard=1`);
    await api('DELETE', `/api/pricing/products/${again.result.id}?hard=1`);
  });

  /* ============================ target margin ========================== */

  await step('a target margin can be set per category, and inherits when it is not', async () => {
    const set = await api('POST', '/api/pricing/targets', { category_id: P.cat, target_margin: 65 });
    assert.strictEqual(set.status, 200, JSON.stringify(set));
    await api('POST', '/api/pricing/targets', { category_id: 0, target_margin: 55 });

    const t = await api('GET', '/api/pricing/targets');
    assert.strictEqual(t.menu_target, 55);
    const yem = t.categories.find(c => c.id === P.cat);
    const ice = t.categories.find(c => c.id === P.drinks);
    assert.strictEqual(yem.target_margin, 65);
    assert.strictEqual(yem.own_target, true);
    assert.strictEqual(ice.target_margin, 55, 'a category with no target inherits the menu default');
    assert.strictEqual(ice.own_target, false);
  });

  await step('an impossible target is refused rather than dividing by zero', async () => {
    const r = await api('POST', '/api/pricing/targets', { category_id: P.cat, target_margin: 120 });
    assert.strictEqual(r.status, 400, 'got ' + r.status);
  });

  /* ============================= suggestions =========================== */

  await step('a suggestion hits the target margin from a KDV-inclusive price', async () => {
    // reset the pide to the worked example: 220 shelf, 10% KDV, 70 cost
    await db.exec('UPDATE products SET price=220, cost_price=70 WHERE id=?', [P.pide]);
    await api('POST', '/api/pricing/targets', { category_id: P.cat, target_margin: 75 });

    const r = await api('GET', `/api/pricing/preview?category_id=${P.cat}&round_to=0`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const row = r.rows.find(x => x.product_id === P.pide);
    assert.ok(row, 'the pide should be in the preview');
    assert.strictEqual(row.current_price, 220);
    assert.strictEqual(row.current_margin, 65, 'today it earns 65%, got ' + row.current_margin);
    // 70 cost at a 75% target -> 280 net -> 308,00 with 10% KDV back on
    assert.strictEqual(row.suggested_price, 308,
      '70 at a 75% target on a 10% product is 308,00 ₺, got ' + row.suggested_price);
    assert.strictEqual(row.suggested_margin, 75, 'and the suggestion must actually hit the target');
    assert.strictEqual(row.change, 88);
  });

  await step('a target below the current margin suggests a cut, not a rise', async () => {
    await api('POST', '/api/pricing/targets', { category_id: P.cat, target_margin: 50 });
    const r = await api('GET', `/api/pricing/preview?category_id=${P.cat}&round_to=0`);
    const row = r.rows.find(x => x.product_id === P.pide);
    // 70 at 50% -> 140 net -> 154,00 shelf
    assert.strictEqual(row.suggested_price, 154, 'got ' + row.suggested_price);
    assert.ok(row.change < 0, 'the old engine raised the price whichever way the number moved');
    await api('POST', '/api/pricing/targets', { category_id: P.cat, target_margin: 75 });
  });

  await step('a suggestion built on a fallback cost says so', async () => {
    // the pide has never been sold at a recorded cost outside the fixture bill,
    // but the lahmacun has no sale history at all - its cost is the card figure
    const r = await api('GET', `/api/pricing/preview?category_id=${P.cat}`);
    const lah = r.rows.find(x => x.product_id === P.lahmacun);
    assert.strictEqual(lah.cost_source, 'product', 'got ' + lah.cost_source);
    assert.strictEqual(lah.cost_is_fallback, true, 'a hand-typed cost is not a measurement');
    assert.strictEqual(lah.cost_source_label, 'Ürün kartı');
    assert.ok(lah.confidence <= 55,
      'a guessed cost must cost confidence, got ' + lah.confidence);

    // the pide WAS sold with a cost frozen onto the line: that is measured
    const pide = r.rows.find(x => x.product_id === P.pide);
    assert.strictEqual(pide.cost_source, 'sale', 'got ' + pide.cost_source);
    assert.strictEqual(pide.cost_is_fallback, false);
    assert.strictEqual(pide.cost, 70, 'the cost frozen on the sold line, got ' + pide.cost);
  });

  await step('a product with no cost anywhere is named, not given a 100% margin', async () => {
    const r = await api('GET', '/api/pricing/preview');
    const su = r.rows.find(x => x.product_id === P.su);
    assert.strictEqual(su.cost_source, 'none');
    assert.strictEqual(su.suggested_price, null, 'there is no honest suggestion without a cost');
    assert.strictEqual(su.suggestible, false);
    assert.strictEqual(su.skip_reason, 'Maliyet bilinmiyor');
    assert.strictEqual(su.confidence, 0);
  });

  await step('the batch run records one pending row per product, not one per run', async () => {
    const a = await api('POST', '/api/pricing/run', { round_to: 0.25 });
    assert.strictEqual(a.status, 200, JSON.stringify(a));
    assert.ok(a.result.created > 0, 'the batch created nothing: ' + JSON.stringify(a.result));
    const firstCount = Number(await db.value(
      'SELECT COUNT(*) FROM pricing_suggestions WHERE client_id=?', [CID]));

    const b = await api('POST', '/api/pricing/run', { round_to: 0.25 });
    assert.strictEqual(b.result.created, 0, 'a second run must refresh, not stack duplicates');
    assert.ok(b.result.refreshed > 0);
    const secondCount = Number(await db.value(
      'SELECT COUNT(*) FROM pricing_suggestions WHERE client_id=?', [CID]));
    assert.strictEqual(secondCount, firstCount, 'the pending list doubled');
  });

  await step('the pending list carries the cost source through to the screen', async () => {
    const r = await api('GET', '/api/pricing/suggestions');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.suggestions.length, 'nothing pending');
    for (const s of r.suggestions) {
      assert.ok(s.cost_source_label, 'every row must name its cost source');
      assert.strictEqual(typeof s.cost_is_fallback, 'boolean');
      assert.ok(/kaynak/.test(s.reason), 'the stored reason must state it too: ' + s.reason);
    }
    const guessed = r.suggestions.find(s => s.cost_is_fallback);
    assert.ok(guessed, 'the lahmacun suggestion is built on a card cost and must be flagged');
  });

  await step('accepting a suggestion changes the price and writes the history', async () => {
    const list = await api('GET', '/api/pricing/suggestions');
    const s = list.suggestions.find(x => x.product_id === P.pide);
    assert.ok(s, 'no pending suggestion for the pide');
    const before = Number((await db.one('SELECT price FROM products WHERE id=?', [P.pide])).price);

    const r = await api('POST', `/api/pricing/suggestions/${s.id}/accept`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r));

    const after = Number((await db.one('SELECT price FROM products WHERE id=?', [P.pide])).price);
    assert.strictEqual(after, s.suggested_price,
      'THE bug in the old module: accepting never changed the price');
    assert.notStrictEqual(after, before);

    const h = await api('GET', `/api/pricing/products/${P.pide}/prices`);
    assert.strictEqual(h.changes[0].old_price, before, 'the log must carry the old price');
    assert.strictEqual(h.changes[0].new_price, after, 'and the new one');
    assert.strictEqual(h.changes[0].source, 'ai', 'and say the suggestion did it, not a person');
    assert.strictEqual(h.changes[0].reference_id, s.id, 'and which suggestion');
    assert.strictEqual(h.series[0].price, after, 'the dated series must move too');

    const row = await db.one('SELECT * FROM pricing_suggestions WHERE id=?', [s.id]);
    assert.ok(row.accepted_at, 'the suggestion must be closed');
    assert.strictEqual(Number(row.chosen_price), after);
    assert.strictEqual(Number(row.accepted_by), UID);
  });

  await step('a chosen price outside the suggested band is refused', async () => {
    const list = await api('GET', '/api/pricing/suggestions');
    const s = list.suggestions[0];
    assert.ok(s, 'nothing pending to test the band with');
    const r = await api('POST', `/api/pricing/suggestions/${s.id}/accept`,
      { price: Math.round(s.suggested_max * 10) });
    assert.strictEqual(r.status, 400, 'got ' + r.status);
    assert.ok(/aral\u0131\u011f/i.test(r.error), r.error);
  });

  await step('a rejected suggestion is not offered again', async () => {
    const list = await api('GET', '/api/pricing/suggestions');
    const s = list.suggestions.find(x => x.product_id === P.lahmacun) || list.suggestions[0];
    const price = Number((await db.one('SELECT price FROM products WHERE id=?', [s.product_id])).price);

    const r = await api('POST', `/api/pricing/suggestions/${s.id}/reject`, { note: 'Menü basıldı' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));

    const after = await api('GET', '/api/pricing/suggestions');
    assert.ok(!after.suggestions.some(x => x.id === s.id), 'a rejected row must leave the list');

    // and the batch must not re-offer the same number tomorrow
    await api('POST', '/api/pricing/run', { round_to: 0.25 });
    const again = await api('GET', '/api/pricing/suggestions');
    assert.ok(!again.suggestions.some(x => x.product_id === s.product_id),
      'the rejected product was offered again at the same price');

    const preview = await api('GET', '/api/pricing/preview?round_to=0.25');
    const row = preview.rows.find(x => x.product_id === s.product_id);
    assert.strictEqual(row.suggestible, false);
    assert.strictEqual(row.skip_reason, 'Daha önce reddedildi');
    // the price must not have moved a kurus
    assert.strictEqual(
      Number((await db.one('SELECT price FROM products WHERE id=?', [s.product_id])).price), price);
    // and the rejection must be attributed to the rejecter, not the accepter -
    // the PHP wrote both into the same accepted_by column
    const row2 = await db.one('SELECT * FROM pricing_suggestions WHERE id=?', [s.id]);
    assert.strictEqual(Number(row2.rejected_by), UID);
    assert.strictEqual(row2.accepted_by, null);
    assert.strictEqual(row2.reject_note, 'Menü basıldı');
  });

  await step('a rejection is against that price, not against the product forever', async () => {
    const s = await db.one(
      'SELECT * FROM pricing_suggestions WHERE client_id=? AND rejected_at IS NOT NULL ORDER BY id DESC LIMIT 1',
      [CID]);
    // the cost moves: a new cost means a new suggested price, which is a
    // question the owner has not yet answered
    await api('POST', `/api/pricing/products/${s.product_id}/costs`,
      { cost: Number(s.cost_price) * 2 + 7, effective_date: '2026-06-01' });
    await api('POST', '/api/pricing/run', { round_to: 0.25 });
    const again = await api('GET', '/api/pricing/suggestions');
    assert.ok(again.suggestions.some(x => x.product_id === s.product_id),
      'a materially different price is a new proposal and must be offered');
  });

  await step('accept all applies every open suggestion through the same path', async () => {
    const open = (await api('GET', '/api/pricing/suggestions')).suggestions;
    assert.ok(open.length, 'nothing pending for accept-all');
    const want = new Map(open.map(s => [s.product_id, s.suggested_price]));

    const r = await api('POST', '/api/pricing/suggestions/accept-all', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.result.accepted, open.length, JSON.stringify(r.result.failed));

    for (const [pid, price] of want) {
      const now = Number((await db.one('SELECT price FROM products WHERE id=?', [pid])).price);
      assert.strictEqual(now, price, 'product ' + pid + ' was not repriced');
      const log = await db.one(
        'SELECT source FROM price_change_log WHERE client_id=? AND product_id=? ORDER BY id DESC LIMIT 1',
        [CID, pid]);
      assert.strictEqual(log.source, 'ai', 'every accept must leave the same trail');
    }
    assert.strictEqual((await api('GET', '/api/pricing/suggestions')).suggestions.length, 0);
  });

  /* ============================== insights ============================= */

  await step('insights names what is below target and where the money is', async () => {
    // knock one price down so there is something to find
    await db.exec('UPDATE products SET price=90, cost_price=55 WHERE id=?', [P.lahmacun]);
    const r = await api('GET', '/api/pricing/insights');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.summary.products > 0);
    assert.strictEqual(r.summary.costed + r.summary.uncosted, r.summary.products);
    assert.strictEqual(r.summary.measured_cost + r.summary.fallback_cost, r.summary.costed,
      'every costed product is either measured or a fallback, never both or neither');
    assert.ok(r.below_target.some(x => x.product_id === P.lahmacun),
      'the 90 ₺ lahmacun on a 55 ₺ cost is well under a 75% target');
    assert.ok(r.uncosted.some(x => x.product_id === P.su), 'Su has no cost and must be named');
    assert.ok(r.funnel.total > 0 && r.funnel.accepted > 0 && r.funnel.rejected > 0,
      'the funnel must count the decisions made above: ' + JSON.stringify(r.funnel));
  });

  await step('the biggest gain is ranked by money, not by percentage', async () => {
    // a product that sells: the gain has to be worth more than a bigger
    // percentage on something nobody orders
    await db.exec('UPDATE products SET price=100, cost_price=60 WHERE id=?', [P.kebap]);
    for (let i = 0; i < 5; i++) await soldBill(P.kebap, 20, 100, 60, 10);
    await db.exec('UPDATE products SET price=100, cost_price=60 WHERE id=?', [P.lahmacun]);

    const r = await api('GET', '/api/pricing/insights');
    const kebap = r.biggest_gains.find(x => x.product_id === P.kebap);
    const lah = r.biggest_gains.find(x => x.product_id === P.lahmacun);
    assert.ok(kebap, 'the busy product must be in the gains list');
    assert.ok(!lah || kebap.estimated_profit > lah.estimated_profit,
      'the item that actually sells must outrank the identical one that does not');
    assert.ok(r.summary.potential_gain > 0);
  });

  await step('the accepted and rejected reports show who decided what', async () => {
    const acc = await api('GET', '/api/pricing/decided?kind=accepted');
    assert.strictEqual(acc.status, 200, JSON.stringify(acc));
    assert.ok(acc.rows.length, 'nothing in the accepted report');
    assert.ok(acc.rows[0].by, 'the accepted report must name the person');
    assert.ok(acc.rows[0].new_price !== null, 'and the price that was chosen');
    const rej = await api('GET', '/api/pricing/decided?kind=rejected');
    assert.ok(rej.rows.length, 'nothing in the rejected report');
    assert.ok(rej.rows[0].by, 'the rejected report must name the rejecter');
    assert.strictEqual(rej.rows[0].note, 'Menü basıldı');
  });

  /* ============================ product list =========================== */

  await step('the product list can be searched by product or category name', async () => {
    const byProduct = await api('GET', '/api/pricing/products?q=Kebap');
    assert.ok(byProduct.products.length >= 1);
    assert.ok(byProduct.products.every(p => /kebap/i.test(p.name)));
    const byCat = await api('GET', '/api/pricing/products?q=İçecek');
    assert.ok(byCat.products.length >= 1, 'searching a category name must find its products');
    assert.ok(byCat.products.every(p => p.category_name === 'İçecekler'));
  });

  await step('the product card shows the cost, its source and whether it may be deleted', async () => {
    const r = await api('GET', `/api/pricing/products/${P.pide}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.product.id, P.pide);
    assert.ok(r.economics.cost_source_label);
    assert.strictEqual(r.economics.net, Math.round(r.economics.price / 1.1 * 100) / 100);
    assert.strictEqual(r.usage.can_hard_delete, false, 'it is on a bill');
    assert.ok(Array.isArray(r.cost_history));
    assert.ok(r.price_history.changes.length > 0);
  });

  /* ============================== results ============================== */
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
