/**
 * Screenshots of every panel screen, before and after.
 *
 * "before" is a copy of the pre-rework panel served on :8095 (see the report);
 * "after" is the live panel on :8090. Both read the same database, so the
 * pages differ only by the code that renders them.
 *
 *   node panel/tests/shots.js            both, if :8095 is up
 *   node panel/tests/shots.js after      just the current panel
 */
const { chromium } = require('playwright-core');
const path = require('path');

const OUT = path.join(__dirname, 'shots');
const ADMIN = process.env.PANEL_ADMIN || 'erik@noktapp.com';
const PASS = process.env.PANEL_ADMIN_PASS || 'ChainTest123';

// A chain customer and a single-shop customer, resolved at run time.
const screens = (ids) => [
  ['home',      '?p=home'],
  ['tenants',   '?p=tenants'],
  ['tenant',    `?p=tenant&id=${ids.chain}`],
  ['tenant-solo', `?p=tenant&id=${ids.solo}`],
  ['tenant-new', '?p=tenant&id=0'],
  ['devices',   '?p=devices'],
  ['backups',   '?p=backups'],
  ['versions',  '?p=versions'],
  ['relay',     '?p=relay'],
  ['audit',     '?p=audit'],
  ['liste-exp30',    '?p=liste&k=exp30'],
  ['liste-silent',   '?p=liste&k=silent'],
  ['liste-backup',   '?p=liste&k=backup'],
  ['liste-outdated', '?p=liste&k=outdated'],
  ['branches',  `?p=branches&id=${ids.chain}`],
  ['branches-solo', `?p=branches&id=${ids.solo}`],
  ['menu',      `?p=menu&id=${ids.chain}`],
  ['menuversions', `?p=menuversions&id=${ids.chain}`],
  ['exceptions', `?p=exceptions&id=${ids.chain}`],
  ['rapor',     `?p=rapor&id=${ids.chain}`],
];

async function shoot(browser, base, tag, ids, width = 1500) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  const p = await ctx.newPage();
  const B = `${base}/admin/index.php`;

  await p.goto(`${B}?p=login`);
  await p.fill('input[name="email"]', ADMIN);
  await p.fill('input[name="password"]', PASS);
  await p.screenshot({ path: `${OUT}/${tag}-login.png` });
  await p.locator('form button, form input[type=submit]').first().click();
  await p.waitForTimeout(900);

  for (const [name, qs] of screens(ids)) {
    try {
      await p.goto(B + qs, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(250);
      await p.screenshot({ path: `${OUT}/${tag}-${name}.png`, fullPage: true });
    } catch (e) { console.log(`  ! ${tag}-${name}: ${e.message}`); }
  }

  // Search only exists after the rework; it POSTs, so it is driven through the box.
  if (tag === 'after') {
    await p.goto(`${B}?p=home`);
    await p.fill('.side-search input[name=q]', 'Kaleiçi');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${OUT}/after-search.png`, fullPage: true });
  }
  await ctx.close();
  console.log(`  ${tag}: ${screens(ids).length + 1} ekran`);
}

(async () => {
  const only = process.argv[2];
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // find a chain tenant (>=2 branches) and a single-shop one
  const mysql = require('child_process').execSync(
    `mysql -h127.0.0.1 -P3399 -unoktapp -pnokpass -N -B nokpos_panel -e "` +
    `SELECT COALESCE((SELECT tenant_id FROM np_branches GROUP BY tenant_id HAVING COUNT(*)>=2 LIMIT 1),0), ` +
    `COALESCE((SELECT t.id FROM np_tenants t WHERE t.is_active=1 AND (SELECT COUNT(*) FROM np_branches b WHERE b.tenant_id=t.id)<2 ` +
    `AND EXISTS(SELECT 1 FROM np_devices d WHERE d.tenant_id=t.id) ORDER BY t.id LIMIT 1),0)"`,
    { encoding: 'utf8', stdio: ['pipe','pipe','ignore'] }).trim().split(/\s+/);
  const ids = { chain: +mysql[0], solo: +mysql[1] };
  console.log('tenants:', ids);

  if (only !== 'after') {
    try { await shoot(b, 'http://127.0.0.1:8095', 'before', ids); }
    catch (e) { console.log('before atlandı:', e.message); }
  }
  await shoot(b, 'http://127.0.0.1:8090', 'after', ids);

  // laptop + phone widths, current panel only
  for (const [w, tag] of [[1280, 'after-1280'], [960, 'after-960'], [430, 'after-430']]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
    const p = await ctx.newPage();
    const B = 'http://127.0.0.1:8090/admin/index.php';
    await p.goto(`${B}?p=login`);
    await p.screenshot({ path: `${OUT}/${tag}-login.png` });
    await p.fill('input[name="email"]', ADMIN);
    await p.fill('input[name="password"]', PASS);
    await p.locator('form button').first().click();
    await p.waitForTimeout(900);
    await p.screenshot({ path: `${OUT}/${tag}-home.png`, fullPage: true });
    await p.goto(`${B}?p=tenant&id=${ids.chain}`);
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${OUT}/${tag}-tenant.png`, fullPage: true });
    await ctx.close();
    console.log(`  ${tag}: 3 ekran`);
  }

  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
