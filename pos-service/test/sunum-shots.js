'use strict';
/**
 * SUNUM SHOTS — every screen of the demo restaurant, at presentation size.
 *
 * Run test/demo.js first: this photographs whatever is in the database, and a
 * photograph of an empty fixture is what these decks exist to avoid.
 *
 *   NOKTAPP_DATA_DIR=/tmp/nokdata node test/demo.js
 *   NOKTAPP_DATA_DIR=/tmp/nokdata node test/sunum-shots.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7491';
const path = require('path');
const fs = require('fs');
const db = require('../src/db');
const { bootstrap } = require('../src/index');
const { tarayiciAc } = require('./tarayici');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
const OUT = '/home/claude/sunum/img';

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  fs.mkdirSync(OUT, { recursive: true });
  console.log('\nNOKTApp POS - sunum ekran görüntüleri\n');

  const browser = await tarayiciAc();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

  const shot = async (name) => {
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('  ' + name);
  };

  await page.goto(BASE + '/');
  await page.waitForSelector('.pinpad', { timeout: 20000 });
  await shot('00-pinpad');

  /* Which PIN opens the till depends on which fixture is loaded: the bench's
   * own manager is 4321, the seven-year demo restaurant's owner is 1234.
   * Hard-coding one of them means this script only ever photographs one of
   * the two, and fails at the pad on the other. */
  const PIN = process.env.DEMO_PIN || '4321';
  for (const d of PIN.split('')) await page.click(`.pinpad button[data-k="${d}"]`);
  await page.waitForSelector('.nav__item', { timeout: 20000 });

  const pages = await page.evaluate(() => PAGES.filter(p => !p.hidden).map(p => p.id));
  for (const id of pages) {
    try {
      await page.evaluate((x) => go(x), id);
      await page.waitForTimeout(1400);
      await shot(id);
    } catch (e) { console.log('  ! ' + id + ': ' + e.message); }
  }

  /* --- the screens that only exist once you are standing on a table --- */
  try {
    await page.evaluate(() => go('tables'));
    await page.waitForTimeout(1400);
    /* a table with exactly ONE bill on it, so the click lands on the order
       screen rather than on the "which bill?" picker */
    const opened = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.table-card.is-busy')];
      const one = cards.find(c => /1 adisyon/.test(c.innerText)) || cards[0];
      if (!one) return false; one.click(); return true;
    });
    if (opened) {
      await page.waitForTimeout(1400);
      /* the table opens a picker even for one bill - step through it */
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('.modal button, .modal .row, .modal [data-o]')]
          .find(x => /Adisyon\s*#/.test(x.innerText || ''));
        if (row) row.click();
      });
      await page.waitForTimeout(2200);
      /* the menu now opens on the category cards - photograph that first */
      await page.waitForTimeout(700);
      await shot('90-adisyon');
      /* then a category opened, so the deck can show both halves of the flow */
      await page.evaluate(() => {
        const c = [...document.querySelectorAll('.cat-card')].find(x => /Ocakbaşı/.test(x.innerText || ''))
          || document.querySelector('.cat-card');
        if (c) c.click();
      });
      await page.waitForTimeout(900);
      await shot('95-kategori-acik');
      const paid = await page.evaluate(() => {
        const b = document.getElementById('bPay');
        if (!b) return false; b.click(); return true;
      });
      if (paid) { await page.waitForTimeout(1400); await shot('91-odeme'); await page.evaluate(() => closeModal()); }
    }
  } catch (e) { console.log('  ! adisyon: ' + e.message); }

  /* the two-parties-on-one-table picker is worth a frame of its own */
  try {
    await page.evaluate(() => go('tables'));
    await page.waitForTimeout(1400);
    const multi = await page.evaluate(() => {
      const c = [...document.querySelectorAll('.table-card.is-busy')].find(x => /2 adisyon/.test(x.innerText));
      if (!c) return false; c.click(); return true;
    });
    if (multi) { await page.waitForTimeout(1400); await shot('94-cok-adisyon'); await page.evaluate(() => closeModal()); }
  } catch (e) { console.log('  ! cok adisyon: ' + e.message); }

  /* --- the guest's side of the glass --- */
  /* the display draws the most recently touched OPEN bill; make that one a
     bill with food on it rather than whichever empty one was last created */
  try {
    const live = await db.one(
      "SELECT o.id FROM orders o JOIN order_items i ON i.order_id=o.id " +
      "WHERE o.client_id=? AND o.status='open' AND o.is_deleted=0 AND i.is_deleted=0 " +
      'GROUP BY o.id HAVING COUNT(*) >= 3 ORDER BY o.id DESC LIMIT 1', [CID]);
    if (live) await db.exec('UPDATE orders SET updated_at=NOW() WHERE id=?', [live.id]);
  } catch (_) {}
  try {
    const t = await db.one(
      'SELECT rt.qr_token FROM restaurant_tables rt WHERE rt.client_id=? AND rt.qr_token IS NOT NULL ' +
      'AND rt.is_active=1 ORDER BY rt.id LIMIT 1', [CID]);
    if (t) {
      const g = await browser.newPage({ viewport: { width: 430, height: 1000 }, deviceScaleFactor: 2 });
      await g.goto(BASE + '/menu.html?m=' + t.qr_token);
      await g.waitForTimeout(2200);
      await g.screenshot({ path: path.join(OUT, '92-qrmenu-telefon.png') });
      console.log('  92-qrmenu-telefon');
      await g.close();
    }
  } catch (e) { console.log('  ! qr: ' + e.message); }

  try {
    const d2 = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await d2.goto(BASE + '/display.html');
    await d2.waitForTimeout(2000);
    await d2.screenshot({ path: path.join(OUT, '93-musteri-ekrani.png') });
    console.log('  93-musteri-ekrani');
    await d2.close();
  } catch (e) { console.log('  ! ekran: ' + e.message); }

  await browser.close();
  server.close();
  await db.close?.();
  console.log('\n  ' + fs.readdirSync(OUT).length + ' görüntü -> ' + OUT);
  process.exit(0);
})().catch((e) => { console.error('SHOTS FAILED:', e.stack || e.message); process.exit(1); });
