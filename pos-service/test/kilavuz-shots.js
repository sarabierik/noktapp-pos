'use strict';
/**
 * Screenshots for the end-user manual.
 *
 * test/ui-all.js photographs every SCREEN. A manual needs the things a person
 * actually does, which are mostly DIALOGS - taking cash out of the drawer,
 * counting it at the end of a shift, adding a member of staff, applying a
 * discount. None of those are a screen you can navigate to, so none of them
 * were ever photographed.
 *
 * This script signs in as the demo manager and opens each one, saving into
 * test/shots/kilavuz/. Nothing here asserts anything - it is a camera, not a
 * test - so a shot that cannot be taken is reported and the rest continue.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/kilavuz-shots.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7488';
const path = require('path');
const fs = require('fs');
const db = require('../src/db');
const catalog = require('../src/modules/catalog');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
const SHOTS = path.join(__dirname, 'shots', 'kilavuz');
const taken = [];
const failed = [];

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('\nNOKTApp POS - kilavuz ekran goruntuleri\n');

  await db.setSetting('setup_done', '1');
  const existing = await db.one('SELECT id FROM users WHERE client_id=? AND pin_hash IS NOT NULL LIMIT 1', [CID]);
  if (!existing) {
    await catalog.saveUser(CID, { display_name: 'Erik Yonetici', username: 'erik',
      role: 'admin', pin: '4321', password: 'Sifre1234' }, null);
  }
  const bd = require('../src/util/businessDay');
const { tarayiciAc } = require('./tarayici');
  await db.exec('DELETE FROM daily_closings WHERE client_id=? AND date=?', [CID, await bd.currentBusinessDate()]);

  const browser = await tarayiciAc();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', () => {});

  await page.goto(BASE + '/');
  await page.waitForSelector('.pinpad', { timeout: 15000 });
  /* 4321 is the user this script creates when the fixture has none. Load the
   * seven-year demo restaurant instead and it already HAS staff, so nothing
   * is created and 4321 opens nothing. DEMO_PIN says which one is loaded. */
  const PIN = process.env.DEMO_PIN || '4321';
  for (const d of PIN.split('')) await page.click(`.pinpad button[data-k="${d}"]`);
  await page.waitForSelector('.nav__item', { timeout: 15000 });

  /** One shot. `open` does whatever is needed to get the thing on screen. */
  async function shot(name, open, { wait = 900 } = {}) {
    try {
      await open();
      await page.waitForTimeout(wait);
      await page.screenshot({ path: path.join(SHOTS, name + '.png') });
      taken.push(name);
      console.log('  ✓ ' + name);
    } catch (e) {
      failed.push(name + ': ' + String(e.message).split('\n')[0].slice(0, 110));
      console.log('  ✗ ' + name + '  -> ' + String(e.message).split('\n')[0].slice(0, 110));
      /* leave no dialog open to poison the next shot */
      try { await page.evaluate(() => typeof closeModal === 'function' && closeModal()); } catch (_) {}
    }
  }
  const go = (id) => page.evaluate((x) => window.go(x), id);
  const clickText = async (text, tag = 'button') => {
    const el = page.locator(`${tag}:has-text("${text}")`).first();
    await el.waitFor({ state: 'visible', timeout: 6000 });
    await el.click();
  };

  /* ------------------------------- kasa ---------------------------- */
  /* by id, not by label: the first shot runs before the page has settled and a
     text locator then races the render */
  await shot('kasa-para-giris', async () => { await go('kasa'); await page.waitForTimeout(1600); await page.click('#tkIn'); });
  await shot('kasa-para-cikis', async () => { await page.evaluate(() => closeModal()); await go('kasa'); await page.waitForTimeout(700); await page.click('#tkOut'); });
  await shot('kasa-sayim', async () => { await page.evaluate(() => closeModal()); await go('kasa'); await page.waitForTimeout(700); await page.click('#tkCount'); });

  /* ------------------------------ masalar -------------------------- */
  await shot('masa-hizli-satis', async () => { await page.evaluate(() => closeModal()); await go('tables'); await page.waitForTimeout(900); await clickText('Hızlı satış'); });

  /* ------------------------------ musteri -------------------------- */
  await shot('musteri-ekle', async () => { await page.evaluate(() => closeModal()); await go('guests'); await page.waitForTimeout(900); await clickText('Müşteri ekle'); });

  /* ------------------------------ personel ------------------------- */
  await shot('personel-ekle', async () => { await page.evaluate(() => closeModal()); await go('kullanici'); await page.waitForTimeout(1400); await clickText('Personel ekle'); });

  /* ------------------------------ urunler -------------------------- */
  await shot('kategori-ekle', async () => { await page.evaluate(() => closeModal()); await go('products'); await page.waitForTimeout(900); await clickText('Kategori ekle'); });
  await shot('urun-ekle', async () => { await page.evaluate(() => closeModal()); await go('products'); await page.waitForTimeout(700); await clickText('Ürün ekle'); });

  /* ---------------------------- paket servis ----------------------- */
  await shot('paket-yeni-siparis', async () => { await page.evaluate(() => closeModal()); await go('paket'); await page.waitForTimeout(1000); await clickText('Yeni paket siparişi'); });
  await shot('kurye-ekle', async () => { await page.evaluate(() => closeModal()); await go('kurye'); await page.waitForTimeout(900); await clickText('Kurye ekle'); });

  /* ------------------------------ yardim --------------------------- */
  await shot('yardim-paneli', async () => {
    await page.evaluate(() => closeModal());
    await page.keyboard.press('F1');
  });

  /* ------------------------------ kilit ---------------------------- */
  await shot('kilit-ekrani', async () => {
    await page.evaluate(() => closeModal());
    await page.click('#btnLock');
  }, { wait: 1500 });

  console.log(`\n  ${taken.length} alindi, ${failed.length} alinamadi`);
  for (const f of failed) console.log('    ! ' + f);
  console.log('  klasor: ' + SHOTS + '\n');
  await browser.close();
  server.close();
  process.exit(0);
})().catch(e => { console.error('FAILURE:', e.stack || e.message); process.exit(1); });
