'use strict';
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7493';
const path = require('path');
const fs = require('fs');
const db = require('../src/db');
const fiscal = require('../src/fiscal');
const { bootstrap } = require('../src/index');
const { tarayiciAc } = require('./tarayici');
const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
const OUT = '/home/claude/okc-onizleme';

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  fs.mkdirSync(OUT, { recursive: true });

  /* a Hugin device to photograph the new buttons against */
  await db.exec("DELETE FROM fiscal_devices WHERE client_id=? AND serial_number IN ('FU1234567','FU7654321')", [CID]);
  const reg = await db.one("SELECT id, prefix FROM fiscal_registry_devices WHERE brand_model LIKE '%S1%' AND owner_key='hugin' LIMIT 1");
  await fiscal.saveDevice(CID, {
    provider: 'hugin', device_model: 'HUGIN S1', serial_number: 'FU1234567',
    connection_type: 'tcp', device_ip: '192.168.1.60', device_port: 4443,
    pclink_software_id: '', environment: 'test',
  });
  if (reg) await db.exec("UPDATE fiscal_devices SET registry_device_id=?, fiscal_prefix=? WHERE client_id=? AND serial_number='FU1234567'", [reg.id, reg.prefix, CID]);

  const browser = await tarayiciAc();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
  const shot = async (n) => { await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('  ' + n); };

  await page.goto(BASE + '/');
  await page.waitForSelector('.pinpad', { timeout: 20000 });
  for (const d of (process.env.DEMO_PIN || '4321').split('')) await page.click(`.pinpad button[data-k="${d}"]`);
  await page.waitForSelector('.nav__item', { timeout: 20000 });

  await page.evaluate(() => go('okc'));
  await page.waitForTimeout(1800);
  await shot('1-okc-listesi');

  /* the pairing dialog - the thing that did not exist */
  await page.evaluate(() => { const b = document.querySelector('[data-opair]'); if (b) b.click(); });
  await page.waitForTimeout(1200);
  await shot('2-eslestirme');
  await page.evaluate(() => { if (window.closeModal) closeModal(); });
  await page.waitForTimeout(500);

  /* the add-device dialog, with the VKN field now drawn */
  await page.evaluate(() => { const b = document.querySelector('#okNew'); if (b) b.click(); });
  await page.waitForTimeout(1000);
  await page.evaluate(() => { const s = document.querySelector('#dfProv');
    if (s) { s.value = 'hugin'; s.dispatchEvent(new Event('change')); } });
  await page.waitForTimeout(900);
  await shot('3-cihaz-ekle-vkn');

  try { server.close(); } catch (_) {}
  await browser.close();
  console.log('\nbitti -> ' + OUT + '\n');
  process.exit(0);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
