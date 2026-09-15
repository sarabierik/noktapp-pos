'use strict';
/**
 * UI smoke test: drive the real till interface in a real browser.
 * Catches the class of mistake unit tests never see - a typo in a template,
 * a handler bound to an element that is not there yet, a screen that throws on
 * first paint.
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7471';
const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
let TOKEN = null;
async function api_post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
    body: JSON.stringify(body),
  });
  return res.json();
}
const SHOTS = path.join(__dirname, 'shots');
const results = [];
const errors = [];

async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + ' -> ' + e.message); }
}

(async () => {
  const server = await bootstrap();
  const CID = 19;
  db.setClientId(CID);
  // make sure there is a manager with a known PIN
  const catalog = require('../src/modules/catalog');
  const existing = await db.one('SELECT id FROM users WHERE client_id=? LIMIT 1', [CID]);
  if (!existing) await catalog.saveUser(CID, { display_name: 'Erik Yonetici', username: 'erik', role: 'admin', pin: '4321', password: 'Sifre1234' }, null);
  await db.setSetting('setup_done', '1');

  // put the sandbox into "mid-service" shape: day open, shift open, menu present
  const bd = require('../src/util/businessDay');
  const date = await bd.currentBusinessDate();
  await db.exec('DELETE FROM daily_closings WHERE client_id=? AND date=?', [CID, date]);
  if (!Number(await db.value('SELECT COUNT(*) FROM restaurant_tables WHERE client_id=?', [CID]))) {
    const zone = await catalog.saveZone(CID, { name: 'Salon' });
    await catalog.bulkTables(CID, { zoneId: zone, prefix: 'Masa', from: 1, to: 8 });
  }
  if (!Number(await db.value('SELECT COUNT(*) FROM products WHERE client_id=? AND is_active=1', [CID]))) {
    const st = await db.one("SELECT id FROM stations WHERE client_id=? AND name='Mutfak'", [CID]);
    const cat = await catalog.saveCategory(CID, { name: 'Ana Yemek', station_id: st && st.id, use_in_pos: 1 });
    await catalog.saveProduct(CID, { category_id: cat, name: 'Adana Kebap', price: 320, cost_price: 140, vat_rate: 10 });
    await catalog.saveProduct(CID, { category_id: cat, name: 'Ayran', price: 40, cost_price: 12, vat_rate: 20 });
    await catalog.saveProduct(CID, { category_id: cat, name: 'Kunefe', price: 180, cost_price: 60, vat_rate: 10 });
  }
  // start from an empty floor: a bill left open by an earlier run would still
  // have its guest attached and the sadakat strip would be in the wrong state
  await db.exec("UPDATE orders SET status='cancelled', is_closed=1, exclude_from_reports=1 WHERE client_id=? AND status='open'", [CID]);
  await db.exec('UPDATE restaurant_tables SET is_occupied=0 WHERE client_id=?', [CID]);

  const payments = require('../src/modules/payments');
  if (!await db.one("SELECT id FROM pos_shifts WHERE client_id=? AND status='open'", [CID])) {
    await payments.openShift(CID, { userId: null, userName: 'Test', openingFloat: 500 });
  }
  // a live loyalty programme and a guest the till already knows, so the
  // sadakat strip has something real to draw
  if (!await db.one('SELECT id FROM loyalty_programs WHERE client_id=? AND is_active=1', [CID])) {
    const p0 = await db.one('SELECT id FROM products WHERE client_id=? AND is_active=1 LIMIT 1', [CID]);
    await db.exec(
      "INSERT INTO loyalty_programs (client_id, product_id, title, target_count, reward_text, is_active, created_at) VALUES (?,?,?,?,?,1,NOW())",
      [CID, p0.id, '10 al 1 bizden', 10, 'Bir tane bizden']);
  }
  if (!await db.one("SELECT id FROM customers WHERE created_by_client_id=? AND phone<>''", [CID])) {
    await db.exec(
      `INSERT INTO customers (first_name, last_name, phone, qr_uid, is_verified, is_active,
          created_by_client_id, created_at, updated_at)
       VALUES ('Zeynep','Kaya','5551112233',?,1,1,?,NOW(),NOW())`,
      [require('crypto').randomBytes(16).toString('hex'), CID]);
  }

  const manager = await db.one('SELECT id FROM users WHERE client_id=? LIMIT 1', [CID]);
  const managerId = manager ? manager.id : 0;
  let orderId = null;

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  console.log('\nNOKTApp POS - interface smoke test\n');

  await step('the login screen renders with the split brand panel', async () => {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.login__brand h1');
    const title = await page.textContent('.login__pitch h1');
    if (!title.includes('kendi bilgisayar')) throw new Error('brand copy missing');
    await page.screenshot({ path: path.join(SHOTS, '01-login.png') });
  });

  await step('an already-activated machine goes straight to the PIN pad', async () => {
    await page.waitForSelector('.pinpad', { timeout: 8000 });
    await page.screenshot({ path: path.join(SHOTS, '02-pinpad.png') });
  });

  await step('the PIN pad signs the manager in and the shell appears', async () => {
    for (const d of ['4', '3', '2', '1']) await page.click(`.pinpad button[data-k="${d}"]`);
    await page.waitForSelector('.shell.is-on', { timeout: 8000 });
    await page.waitForSelector('#tableGrid .table-card', { timeout: 8000 });
    await page.screenshot({ path: path.join(SHOTS, '03-tables.png') });
  });

  await step('opening a table shows the order screen with the menu', async () => {
    TOKEN = await auth.issueToken({ cid: CID, uid: managerId || 0, role: 'admin', name: 'Test', kind: 'staff' });
    await page.click('#tableGrid .table-card:nth-child(2)');
    /*
     * The menu opens on the CATEGORY CARDS now, not on the first category's
     * products - a strip of sixteen categories could not be reached on a touch
     * screen without dragging it sideways during service. So the walk taps a
     * category first, exactly as a waiter does.
     */
    await page.waitForSelector('.order .cat-grid .cat-card', { timeout: 8000 });
    await page.screenshot({ path: path.join(SHOTS, '04a-categories.png') });
    await page.click('.cat-grid .cat-card:nth-child(1)');
    await page.waitForSelector('.order .prod-grid .prod', { timeout: 8000 });
    orderId = await page.evaluate(() => (typeof App !== 'undefined' ? App.data.orderId : null));
    await page.screenshot({ path: path.join(SHOTS, '04-order-empty.png') });
  });

  await step('tapping products fills the bill and the total adds up', async () => {
    await page.click('.prod-grid .prod:nth-child(1)');
    await page.waitForSelector('.bill__lines .line');
    await page.click('.prod-grid .prod:nth-child(1)');
    await page.click('.prod-grid .prod:nth-child(2)');
    await page.waitForTimeout(600);
    const total = await page.textContent('.total-row--grand span:last-child');
    if (!/\d/.test(total)) throw new Error('no total shown');
    await page.screenshot({ path: path.join(SHOTS, '05-order-filled.png') });
  });

  await step('the payment sheet opens with the amount due prefilled', async () => {
    await page.click('#bPay');
    await page.waitForSelector('#pyAmount', { timeout: 5000 });
    const v = await page.inputValue('#pyAmount');
    if (Number(v) <= 0) throw new Error('due not prefilled');
    await page.screenshot({ path: path.join(SHOTS, '06-payment.png') });
    await page.keyboard.press('Escape');
  });

  await step('the discount dialog shows the bill and can discount one line', async () => {
    /*
     * "indirim must be able to to by whole bill or by product" - and to choose
     * you have to see the bill. The dialog used to be two empty boxes that
     * silently meant "the whole adisyon", so taking 10% off one starter meant
     * working the lira out yourself.
     */
    await page.click('#bMore');
    await page.waitForSelector('[data-a="discount"]', { timeout: 6000 });
    await page.click('[data-a="discount"]');
    await page.waitForSelector('#dcPick', { timeout: 6000 });

    const opts = await page.locator('#dcPick .dc-opt').count();
    assert.ok(opts >= 3, 'the discount dialog listed ' + opts + ' choices - the bill is not there');
    const first = await page.textContent('#dcPick .dc-opt:first-child');
    assert.ok(/Tüm adisyon/.test(first), 'the whole bill is not the first choice: ' + first);

    // pick a LINE, take 10% off it, and check the dialog does the arithmetic
    await page.locator('#dcPick .dc-opt').nth(1).click();
    await page.fill('#dcPct', '10');
    await page.waitForTimeout(250);
    const sum = await page.textContent('#dcSum');
    assert.ok(/İndirim/.test(sum) && /Kalan/.test(sum), 'no preview of the discount: ' + sum);

    const before = Number(await page.evaluate(() => App.data.order.grand_total));
    await page.fill('#dcWhy', 'test indirimi');
    await page.click('#dcOk');
    await page.waitForTimeout(1200);
    const after = Number(await page.evaluate(() => App.data.order.grand_total));
    assert.ok(after < before, `the line discount did not reach the bill (${before} -> ${after})`);
    await page.screenshot({ path: path.join(SHOTS, '06b-discount.png') });
  });

  await step('a busy table offers a SECOND adisyon, not just the first one', async () => {
    /*
     * The till used to walk straight into the only open bill, so a second
     * party on the same table had nowhere to go - "still not multi table
     * adisiyon". A busy table always asks now.
     */
    await page.click('.nav__item[data-page="tables"]');
    await page.waitForSelector('#tableGrid .table-card', { timeout: 8000 });
    await page.locator('#tableGrid .table-card.is-busy').first().click();
    await page.waitForSelector('#newBill', { timeout: 6000 });
    const listed = await page.locator('#modal [data-o]').count();
    assert.ok(listed >= 1, 'the open bill was not listed');
    await page.screenshot({ path: path.join(SHOTS, '03b-multibill.png') });

    await page.click('#newBill');
    await page.waitForSelector('#billTabs .bill-tab', { timeout: 8000 });
    const tabs = await page.locator('#billTabs .bill-tab').count();
    assert.ok(tabs >= 3, 'expected two bills and a + button, got ' + tabs + ' tabs');
    await page.screenshot({ path: path.join(SHOTS, '03c-bill-tabs.png') });

    // back to the first bill, so the steps after this one work on it
    await page.locator('#billTabs [data-b]').first().click();
    await page.waitForTimeout(900);
  });

  await step('the sadakat strip offers to ask for a card', async () => {
    await page.waitForSelector('#loyAsk', { timeout: 6000 });
    await page.click('#loyAsk');
    await page.waitForSelector('#loyIn', { timeout: 5000 });
    await page.screenshot({ path: path.join(SHOTS, '06b-loyalty-scan.png') });
    await page.keyboard.press('Escape');
  });

  await step('scanning a known guest stamps the bill and shows their card', async () => {
    // a guest the till already knows, with a live programme
    const cust = await db.one("SELECT id, phone FROM customers WHERE phone IS NOT NULL AND phone<>'' LIMIT 1");
    const prog = await db.one('SELECT id FROM loyalty_programs WHERE client_id=? AND is_active=1 LIMIT 1', [CID]);
    if (!cust || !prog) return;                       // nothing seeded, nothing to prove
    const pid = await db.value('SELECT product_id FROM loyalty_programs WHERE id=?', [prog.id]);
    await api_post(`/api/pos/orders/${orderId}/items`, { product_id: pid, qty: 2 });
    await page.click('#loyAsk');
    await page.fill('#loyIn', cust.phone);
    await page.click('#loyGo');
    await page.waitForSelector('#loyalStrip .loyal__card, #loyAlert .alert', { timeout: 8000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, '06c-loyalty-card.png') });
    const strip = await page.textContent('#loyalStrip');
    if (/Sadakat kartı var mı/.test(strip)) throw new Error('guest was not attached: ' + strip.slice(0, 120));
  });

  await step('what the waiter sends reaches the one kitchen board', async () => {
    /*
     * There is one kitchen screen now - the station board in floor.js. The
     * older single-station one was deleted rather than hidden, so this walks
     * the nav entry a waiter actually sees and then checks that the item just
     * sent is ON the board. Rendering an empty board proves nothing: the bug
     * this replaces was a send that threw after the commit, which left a board
     * that painted perfectly and never showed the order.
     */
    await page.click('#bSend');
    await page.waitForTimeout(900);
    await page.click('.nav__item[data-page="mutfak"]');
    await page.waitForSelector('#mtBody', { timeout: 8000 });
    await page.waitForTimeout(900);
    const board = await page.textContent('#mtBody');
    assert.ok(!/Bekleyen sipariş yok/.test(board),
      'the board is empty after the waiter pressed Gönder');
    assert.ok(/\d/.test(board), 'the board shows no ticket');
    await page.screenshot({ path: path.join(SHOTS, '07-kitchen.png') });
  });

  await step('the reports page draws the Z figures', async () => {
    await page.click('.nav__item[data-page="reports"]');
    await page.waitForSelector('#rpZ table', { timeout: 8000 });
    await page.screenshot({ path: path.join(SHOTS, '08-reports.png') });
  });

  await step('the products page lists the menu with prices and VAT', async () => {
    // one product screen now: the list grouped by category, with margin
    await page.click('.nav__item[data-page="products"]');
    await page.waitForSelector('#ukBody table tbody tr', { timeout: 8000 });
    const body = await page.textContent('#ukBody');
    assert.ok(/₺/.test(body), 'no prices on the product list');
    assert.ok(/%/.test(body), 'no VAT rate on the product list');
    await page.screenshot({ path: path.join(SHOTS, '09-products.png') });
  });

  await step('Ayarlar opens on İşletme and the ÖKC screen is one tab away', async () => {
    /*
     * The sidebar entry is the GROUP - Ayarlar - and what it opens is İşletme,
     * the first screen in it. ÖKC is then a tab in the strip the router draws,
     * not a tab inside a screen called Yönetim inside a group called Ayarlar,
     * which is where it used to be and where nobody found it. Clicking through
     * both is the point: it checks the group head, the strip and the screen.
     */
    await page.click('.nav__item[data-page="isletme"]');
    await page.waitForSelector('#ayTabs', { timeout: 6000 });
    await page.click('#main .subnav__tab[data-sub="okc"]');
    await page.waitForSelector('#okNew', { timeout: 6000 });
    const body = await page.textContent('#okBody');
    assert.ok(/Desteklenen markalar/.test(body), 'the ÖKC screen did not list the drivers');
    await page.screenshot({ path: path.join(SHOTS, '10-settings-okc.png') });
  });

  await step('the bills screen offers the reopen button', async () => {
    await page.click('.nav__item[data-page="bills"]');
    await page.waitForSelector('#blOpen', { timeout: 6000 });
    await page.screenshot({ path: path.join(SHOTS, '11-bills.png') });
  });

  await step('the customer display renders on its own page', async () => {
    const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    p2.on('pageerror', e => errors.push('display pageerror: ' + e.message));
    await p2.goto(BASE + '/display.html', { waitUntil: 'networkidle' });
    await p2.waitForTimeout(1800);
    await p2.screenshot({ path: path.join(SHOTS, '12-customer-display.png') });
    await p2.close();
  });

  await step('no JavaScript errors were raised anywhere in that walk', async () => {
    const real = errors.filter(e => !e.includes('favicon') && !e.includes('ERR_'));
    if (real.length) throw new Error(real.slice(0, 4).join(' | '));
  });

  await browser.close();
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log('screenshots: ' + SHOTS + '\n');
  failed.forEach(f => console.log('  ! ' + f[1] + ': ' + f[2]));
  server.close();
  process.exit(failed.length ? 1 : 0);
})();
