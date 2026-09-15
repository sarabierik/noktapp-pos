/**
 * The v2 shell, walked in a real browser.
 *
 * Every screen the sidebar offers, at the three widths that matter - a desk
 * monitor, a laptop, and a phone - checked for four things and photographed at
 * each one:
 *
 *   1. the page rendered (no PHP fatal, no panel error box, no 404 where a
 *      nav entry points),
 *   2. no JavaScript error and no failed request,
 *   3. the document does not scroll sideways,
 *   4. no control is drawn outside the box that owns it.
 *
 * (4) is the one that has to be a measurement rather than a glance: a button
 * sitting two pixels past the right edge of its card is invisible in a
 * screenshot at 1440 and obvious to the man using the panel.
 *
 *   node panel/tests/shell.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { tarayiciAc } = require('../../pos-service/test/tarayici');

const BASE = process.env.PANEL || 'http://127.0.0.1:8090';
const ADMIN = process.env.PANEL_ADMIN || 'erik@noktapp.com';
const PASS = process.env.PANEL_ADMIN_PASS || 'ChainTest123';
const OUT = path.join(__dirname, 'shots', 'v2');
const WIDTHS = [1440, 1100, 430];

fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; }
  else { fail++; failures.push(`${name}${detail ? ' -> ' + detail : ''}`); console.log(`  FAIL  ${name}  -> ${detail || ''}`); }
}

/* ------------------------------------------------------------------ *
 * The overflow assertion, run inside the page.
 *
 * For every control, find the nearest ancestor that is a real container in
 * this design system and compare the two rectangles. One pixel of tolerance,
 * because a hairline border rounds.
 * ------------------------------------------------------------------ */
const OVERFLOW_PROBE = () => {
  const CONTROLS = 'a, button, input, select, textarea, .btn, .pill, .meter, .keyline, code';
  const BOXES = '.card, .stat, table.grid, table.tbl, .rail, .page-head, .side, .side-me, .empty, .flash, .alert, .page-w';
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(CONTROLS)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;              // hidden
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    if (cs.position === 'fixed') continue;                       // the drawer furniture
    const box = el.parentElement && el.parentElement.closest(BOXES);
    if (!box) continue;
    const bcs = getComputedStyle(box);
    // A box that scrolls its own overflow is allowed to hold something wider.
    if (bcs.overflowX === 'auto' || bcs.overflowX === 'scroll') continue;
    if (box.closest('.scroll-x')) continue;
    const b = box.getBoundingClientRect();
    const over = Math.max(b.left - r.left, r.right - b.right);
    if (over > 1) {
      const key = el.tagName + '|' + (el.className || '') + '|' + Math.round(over);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        el: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''),
        box: box.tagName.toLowerCase() + (box.className ? '.' + String(box.className).trim().split(/\s+/).join('.') : ''),
        over: Math.round(over),
        text: (el.textContent || '').trim().slice(0, 40),
      });
    }
  }
  return out;
};

const ERROR_MARKS = ['Panel bir hata ile karsilasti', 'Panel durdu', 'Fatal error', 'Parse error',
                     'Warning:', 'Notice:', 'Deprecated:'];

async function walk(browser, ids) {
  const screens = [
    ['home', '?p=home', 'home'],
    ['tenants', '?p=tenants', 'tenants'],
    ['tenant', `?p=tenant&id=${ids.chain}`, 'tenants'],
    ['tenant-solo', `?p=tenant&id=${ids.solo}`, 'tenants'],
    ['tenant-new', '?p=tenant&id=0', 'tenants'],
    ['devices', '?p=devices', 'devices'],
    ['bayiler', '?p=bayiler', 'bayiler'],
    ['faturalar', '?p=faturalar', 'faturalar'],
    ['odemeler', '?p=odemeler', 'odemeler'],
    ['gelir', '?p=gelir', 'gelir'],
    ['teshis', '?p=teshis', 'teshis'],
    ['backups', '?p=backups', 'backups'],
    ['relay', '?p=relay', 'relay'],
    ['versions', '?p=versions', 'versions'],
    ['uyarilar', '?p=uyarilar', 'uyarilar'],
    ['audit', '?p=audit', 'audit'],
    ['liste-exp30', '?p=liste&k=exp30', 'tenants'],
    ['liste-silent', '?p=liste&k=silent', 'tenants'],
    ['liste-backup', '?p=liste&k=backup', 'tenants'],
    ['liste-outdated', '?p=liste&k=outdated', 'tenants'],
    ['branches', `?p=branches&id=${ids.chain}`, 'tenants'],
    ['menu', `?p=menu&id=${ids.chain}`, 'tenants'],
    ['menuversions', `?p=menuversions&id=${ids.chain}`, 'tenants'],
    ['exceptions', `?p=exceptions&id=${ids.chain}`, 'tenants'],
    ['rapor', `?p=rapor&id=${ids.chain}`, 'tenants'],
    ['notfound', '?p=boyle-bir-sayfa-yok', null],
  ];

  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 950 } });
    const page = await ctx.newPage();
    let jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') jsErrors.push('console: ' + m.text()); });

    const B = `${BASE}/admin/index.php`;
    await page.goto(`${B}?p=login`);
    await page.fill('input[name="email"]', ADMIN);
    await page.fill('input[name="password"]', PASS);
    await page.screenshot({ path: `${OUT}/${width}-login.png` });
    await page.locator('form button').first().click();
    await page.waitForURL(/p=home/, { timeout: 10000 });

    const all = screens.concat([['guncelle', null, 'guncelle']]);
    for (const [name, qs, activeKey] of all) {
      const url = qs === null ? `${BASE}/admin/guncelle.php` : B + qs;
      jsErrors = [];
      const label = `${width}px ${name}`;
      const resp = await page.goto(url, { waitUntil: 'networkidle' });
      check(`${label} HTTP 200`, resp && resp.status() === 200, resp && String(resp.status()));

      const body = await page.content();
      const bad = ERROR_MARKS.find(m => body.includes(m));
      check(`${label} PHP hatasız`, !bad, bad);

      // A nav entry must never land on the 404 screen.
      if (activeKey) {
        check(`${label} 404 değil`, !body.includes('Sayfa bulunamadı'), '404 ekranı geldi');
      }

      check(`${label} JS hatasız`, jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));

      const sideways = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${label} yatay kaydırma yok`, sideways <= 1, `${sideways}px taşma`);

      const over = await page.evaluate(OVERFLOW_PROBE);
      check(`${label} kutu taşması yok`, over.length === 0,
        over.slice(0, 3).map(o => `${o.el} ${o.over}px dışarıda (${o.box}) "${o.text}"`).join(' ; '));

      // The sidebar marks where you are, and marks its group as the open one.
      if (activeKey) {
        const state = await page.evaluate((k) => {
          const on = document.querySelectorAll('.side-nav a.on');
          const cur = document.querySelector('.side-nav a[aria-current="page"]');
          const grp = document.querySelector('.nav-group.on');
          const href = cur ? cur.getAttribute('href') : '';
          return { count: on.length, href, group: !!grp,
                   inGroup: !!(cur && grp && grp.contains(cur)) };
        }, activeKey);
        check(`${label} tek aktif menü`, state.count === 1, `${state.count} adet`);
        const want = activeKey === 'guncelle' ? 'guncelle.php' : `p=${activeKey}`;
        check(`${label} doğru menü işaretli`, (state.href || '').includes(want),
          `işaretli: ${state.href}, beklenen: ${want}`);
        check(`${label} açık grup işaretli`, state.group && state.inGroup, JSON.stringify(state));
      }

      await page.screenshot({ path: `${OUT}/${width}-${name}.png`, fullPage: true });
    }

    // Search, which POSTs from the sidebar.
    await page.goto(`${B}?p=home`);
    if (width < 1000) await page.locator('.nav-toggle').click();
    await page.fill('.side-search input[name=q]', 'Kaleiçi');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    check(`${width}px arama çalıştı`, (await page.content()).includes('page-head'), 'arama sonucu gelmedi');
    await page.screenshot({ path: `${OUT}/${width}-search.png`, fullPage: true });

    // The drawer, where there is one.
    if (width < 1000) {
      await page.goto(`${B}?p=tenants`);
      const closed = await page.evaluate(() => document.querySelector('.side').getBoundingClientRect().right);
      check(`${width}px çekmece kapalı başlıyor`, closed <= 1, `sağ kenar ${closed}`);
      await page.locator('.nav-toggle').click();
      await page.waitForTimeout(350);
      const open = await page.evaluate(() => document.querySelector('.side').getBoundingClientRect().right);
      check(`${width}px hamburger çekmeceyi açıyor`, open > 100, `sağ kenar ${open}`);
      await page.screenshot({ path: `${OUT}/${width}-drawer.png` });
      // Press the scrim clear of the drawer, the way a thumb reaches for it.
      await page.mouse.click(width - 20, 300);
      await page.waitForTimeout(350);
      const shut = await page.evaluate(() => document.querySelector('.side').getBoundingClientRect().right);
      check(`${width}px perde çekmeceyi kapatıyor`, shut <= 1, `sağ kenar ${shut}`);
    } else {
      const vis = await page.evaluate(() => {
        const s = document.querySelector('.side').getBoundingClientRect();
        const m = document.querySelector('main').getBoundingClientRect();
        return { sideLeft: s.left, sideRight: s.right, mainLeft: m.left };
      });
      check(`${width}px kenar çubuğu sabit`, vis.sideLeft === 0 && vis.sideRight > 180, JSON.stringify(vis));
      check(`${width}px içerik çubuğun sağında`, vis.mainLeft >= vis.sideRight - 1, JSON.stringify(vis));
    }

    await ctx.close();
    console.log(`  ${width}px bitti`);
  }
}

(async () => {
  const row = execSync(
    `mysql -h127.0.0.1 -P3399 -unoktapp -pnokpass -N -B nokpos_panel -e "` +
    `SELECT COALESCE((SELECT tenant_id FROM np_branches GROUP BY tenant_id HAVING COUNT(*)>=2 LIMIT 1),0), ` +
    `COALESCE((SELECT t.id FROM np_tenants t WHERE t.is_active=1 AND (SELECT COUNT(*) FROM np_branches b WHERE b.tenant_id=t.id)<2 ` +
    `AND EXISTS(SELECT 1 FROM np_devices d WHERE d.tenant_id=t.id) ORDER BY t.id LIMIT 1),0)"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split(/\s+/);
  const ids = { chain: +row[0], solo: +row[1] };
  console.log('tenants:', ids);

  const b = await tarayiciAc();
  try { await walk(b, ids); } finally { await b.close(); }

  console.log(`\n  ${pass} geçti, ${fail} kaldı`);
  if (fail) { console.log('\nKALANLAR:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
