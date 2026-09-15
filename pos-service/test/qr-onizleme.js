'use strict';
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7497';
const fs = require('fs');
const db = require('../src/db');
const { bootstrap } = require('../src/index');
const { tarayiciAc } = require('./tarayici');
const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const OUT = '/home/claude/qr-onizleme';

(async () => {
  const server = await bootstrap();
  db.setClientId(19);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await tarayiciAc();
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 2 });
  page.on('console', m => { if (m.type() === 'error') console.log('  console: ' + m.text()); });

  await page.goto(BASE + '/');
  await page.waitForSelector('.pinpad', { timeout: 20000 });
  for (const d of ['4', '3', '2', '1']) await page.click(`.pinpad button[data-k="${d}"]`);
  await page.waitForSelector('.nav__item', { timeout: 20000 });

  await page.evaluate(() => go('cihazlar'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/1-telefonlar.png' });
  console.log('  1-telefonlar');

  await page.click('#devPair');
  await page.waitForTimeout(900);
  await page.screenshot({ path: OUT + '/2-personel-sec.png' });
  console.log('  2-personel-sec');

  await page.click('#devPairGo');
  await page.waitForSelector('.pair__qr svg', { timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + '/3-karekod.png' });
  console.log('  3-karekod');
  const payload = await page.evaluate(() => document.querySelector('.pair__qr svg') ? 'var' : 'yok');
  console.log('  qr: ' + payload);

  await browser.close();
  server.close();
  await db.close?.();
  process.exit(0);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
