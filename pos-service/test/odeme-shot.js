'use strict';
/* Preview: the payment dialog with an armed OKC bound, and without one. */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7496';
const path = require('path');
const fs = require('fs');
const db = require('../src/db');
const fiscal = require('../src/fiscal');
const { bootstrap } = require('../src/index');
const { tarayiciAc } = require('./tarayici');
const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
const OUT = '/home/claude/odeme-onizleme';

const openPay = async (page) => {
  await page.evaluate(() => go('tables'));
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('.table-card.is-busy')]
      .find(x => /1 adisyon/.test(x.innerText)) || document.querySelector('.table-card.is-busy');
    if (c) c.click();
  });
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.modal button, .modal .row, .modal [data-o]')]
      .find(x => /Adisyon\s*#/.test(x.innerText || ''));
    if (row) row.click();
  });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { const b = document.getElementById('bPay'); if (b) b.click(); });
  await page.waitForTimeout(1600);
};

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await tarayiciAc();
  const page = await browser.newPage({ viewport: { width: 1400, height: 980 }, deviceScaleFactor: 2 });
  await page.goto(BASE + '/');
  await page.waitForSelector('.pinpad', { timeout: 20000 });
  for (const d of (process.env.DEMO_PIN || '1234').split('')) await page.click(`.pinpad button[data-k="${d}"]`);
  await page.waitForSelector('.nav__item', { timeout: 20000 });

  /* --- 1: no OKC armed --- */
  await db.exec('UPDATE fiscal_devices SET production_enabled=0 WHERE client_id=?', [CID]);
  await openPay(page);
  await page.screenshot({ path: path.join(OUT, '1-okc-yok.png') });
  console.log('  1-okc-yok');
  await page.evaluate(() => closeModal());

  /* --- 2: an armed Hugin, exactly like the one on his desk --- */
  await db.exec("DELETE FROM fiscal_devices WHERE client_id=? AND serial_number='FU00032768'", [CID]);
  const id = await fiscal.saveDevice(CID, {
    provider: 'hugin', device_model: 'HUGIN S1', serial_number: 'FU00032768',
    connection_type: 'tcp', device_ip: '192.168.1.6', device_port: 4443,
    pclink_software_id: '9217033991', environment: 'test',
  });
  await db.exec('UPDATE fiscal_devices SET production_enabled=1, is_active=1, quarantine_reason=NULL WHERE id=?', [id]);
  await page.reload();
  await page.waitForSelector('.pinpad', { timeout: 20000 });
  for (const d of (process.env.DEMO_PIN || '1234').split('')) await page.click(`.pinpad button[data-k="${d}"]`);
  await page.waitForSelector('.nav__item', { timeout: 20000 });
  await openPay(page);
  await page.screenshot({ path: path.join(OUT, '2-okc-acik.png') });
  console.log('  2-okc-acik');

  /* --- 3: havale refused while the device is live --- */
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#modal [data-m]')].find(x => x.dataset.m === 'havale');
    if (b) b.click();
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, '3-havale-reddedildi.png') });
  console.log('  3-havale-reddedildi');

  await browser.close(); server.close();
  console.log('\n-> ' + OUT + '\n');
  process.exit(0);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
