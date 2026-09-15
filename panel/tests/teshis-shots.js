/**
 * The two new support screens, walked in a real browser.
 *
 * tests/shell.js already walks every entry the sidebar offers, which covers
 * ?p=teshis and ?p=uyarilar. It cannot cover what it does not know the address
 * of: the per-customer till list and the single-till page, both of which take
 * a tenant and a device in the query string. Those are the screens somebody is
 * actually reading while a customer is on the phone, so they get the same four
 * assertions at the same three widths:
 *
 *   1. the page rendered (no PHP fatal, no panel error box, no 404),
 *   2. no JavaScript error,
 *   3. the document does not scroll sideways,
 *   4. no control is drawn outside the box that owns it.
 *
 * (4) is a measurement rather than a glance: the cron line is a 130-character
 * unbroken string and the till page carries a ten-column table, and both are
 * exactly the shape that quietly hangs over the edge of a card at 430px.
 *
 * A demonstration document is stored against a real till first, because a
 * screen photographed with nothing in it proves nothing about the screen.
 *
 *   node panel/tests/teshis-shots.js
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

/* The same probe shell.js uses, so the two walkers agree on what "outside its
   container" means. */
const OVERFLOW_PROBE = () => {
  const CONTROLS = 'a, button, input, select, textarea, .btn, .pill, .meter, .keyline, code';
  const BOXES = '.card, .stat, table.grid, table.tbl, .rail, .page-head, .side, .side-me, .empty, .flash, .alert, .page-w, .key';
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(CONTROLS)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    if (cs.position === 'fixed') continue;
    const box = el.parentElement && el.parentElement.closest(BOXES);
    if (!box) continue;
    const bcs = getComputedStyle(box);
    if (bcs.overflowX === 'auto' || bcs.overflowX === 'scroll') continue;
    if (box.closest('.scroll-x')) continue;
    const b = box.getBoundingClientRect();
    const over = Math.max(b.left - r.left, r.right - b.right);
    if (over > 1) {
      const key = el.tagName + '|' + (el.className || '') + '|' + Math.round(over);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ el: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''),
                 box: box.tagName.toLowerCase() + (box.className ? '.' + String(box.className).trim().split(/\s+/).join('.') : ''),
                 over: Math.round(over), text: (el.textContent || '').trim().slice(0, 40) });
    }
  }
  return out;
};

const ERROR_MARKS = ['Panel bir hata ile karsilasti', 'Panel durdu', 'Fatal error', 'Parse error',
                     'Warning:', 'Notice:', 'Deprecated:'];

/**
 * Put a believable document (and a short history) on a real till.
 *
 * Through lib/teshis.php rather than straight SQL, so the screens are
 * photographed showing exactly what the receiving code would have stored -
 * whitelisted, scrubbed and trimmed.
 */
function seed() {
  const php = `
    foreach (['NP_DB_HOST'=>'127.0.0.1','NP_DB_PORT'=>'3399','NP_DB_NAME'=>'nokpos_panel',
              'NP_DB_USER'=>'noktapp','NP_DB_PASS'=>'nokpass'] as $k=>$v)
        if (getenv($k) === false) putenv("$k=$v");
    require '${path.join(__dirname, '..', 'lib', 'teshis.php')}';
    $d = one('SELECT tenant_id, device_id FROM np_devices ORDER BY last_seen_at IS NULL, last_seen_at DESC LIMIT 1');
    if (!$d) { echo "0 0"; exit; }
    for ($i = 6; $i >= 0; $i--) {
        teshis_store((int)$d['tenant_id'], $d['device_id'], [
          'at' => date('c'), 'app_version' => '2.1.1', 'engine' => '10.11.6-MariaDB',
          'os' => 'Windows_NT 10.0.19045 x64', 'node' => '22.11.0', 'uptime_h' => 51 + $i,
          'disk_free_mb' => 1200 + $i * 3400, 'disk_total_mb' => 476000,
          'db_size_mb' => 318 + $i, 'stations' => 3,
          'print_pending' => $i === 0 ? 7 : 0, 'print_failed' => $i === 0 ? 2 : 0,
          'open_bills' => 4, 'last_close' => date('Y-m-d', strtotime('-1 day')), 'last_close_seq' => 1,
          'okc' => 1, 'okc_provider' => 'hugin', 'okc_status' => 'READY', 'okc_devices' => 1,
          'errors_24h' => $i === 0 ? 9 : 1,
          'backup_at' => date('c', strtotime('-8 hours')), 'backup_mb' => 96,
          'printers' => [
            ['name'=>'Kasa Yazıcı','type'=>'thermal','target'=>'192.168.1.50','station'=>'Kasa',
             'last'=>'done','last_at'=>date('Y-m-d H:i:s')],
            ['name'=>'Mutfak Yazıcı','type'=>'thermal','target'=>'192.168.1.51','station'=>'Mutfak',
             'last'=> $i === 0 ? 'failed' : 'done','last_at'=>date('Y-m-d H:i:s')],
            ['name'=>'Bar Yazıcı','type'=>'usb','target'=>'USB001','station'=>'Bar',
             'last'=>'yok','last_at'=>null],
          ],
          'log' => $i === 0 ? [
            date('Y-m-d H:i:s') . ' print Yazici cevap vermiyor: 192.168.1.51:9100',
            date('Y-m-d H:i:s') . ' sync Panel yanit vermedi, yeniden denenecek',
            date('Y-m-d H:i:s') . ' fiscal ÖKC mesgul, islem kuyruga alindi',
          ] : [],
        ]);
    }
    echo $d['tenant_id'] . ' ' . $d['device_id'];
  `;
  /* Through a temp file rather than php -r: the snippet is multi-line and a
     shell would have to be trusted to keep the newlines. */
  const tmp = path.join(require('os').tmpdir(), 'nokseed-' + process.pid + '.php');
  fs.writeFileSync(tmp, '<?php\n' + php);
  let outp;
  try { outp = execSync(`php ${tmp}`, { encoding: 'utf8' }).trim(); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  const [tenant, device] = outp.split(/\s+/);
  return { tenant, device };
}

(async () => {
  const { tenant, device } = seed();
  if (!tenant || tenant === '0') { console.log('  ! panelde hiç kasa yok, ekran çekilemedi'); process.exit(1); }
  console.log('till:', tenant, device);

  const screens = [
    ['teshis', `?p=teshis`],
    ['teshis-tenant', `?p=teshis&tenant=${tenant}`],
    ['teshis-kasa', `?p=teshis&tenant=${tenant}&device=${encodeURIComponent(device)}`],
    ['teshis-yok', `?p=teshis&tenant=${tenant}&device=olmayan-kasa`],
    ['uyarilar', `?p=uyarilar`],
  ];

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
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
      await page.locator('form button').first().click();
      await page.waitForURL(/p=home/, { timeout: 10000 });

      for (const [name, qs] of screens) {
        jsErrors = [];
        const label = `${width}px ${name}`;
        const resp = await page.goto(B + qs, { waitUntil: 'networkidle' });
        check(`${label} HTTP 200`, resp && resp.status() === 200, resp && String(resp.status()));

        const body = await page.content();
        const bad = ERROR_MARKS.find(m => body.includes(m));
        check(`${label} PHP hatasız`, !bad, bad);
        check(`${label} 404 değil`, !body.includes('Sayfa bulunamadı'), '404 ekranı geldi');
        check(`${label} JS hatasız`, jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));

        const sideways = await page.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(`${label} yatay kaydırma yok`, sideways <= 1, `${sideways}px taşma`);

        const over = await page.evaluate(OVERFLOW_PROBE);
        check(`${label} kutu taşması yok`, over.length === 0,
          over.slice(0, 3).map(o => `${o.el} ${o.over}px dışarıda (${o.box}) "${o.text}"`).join(' ; '));

        await page.screenshot({ path: `${OUT}/${width}-${name}.png`, fullPage: true });
      }
      await ctx.close();
      console.log(`  ${width}px bitti`);
    }
  } finally { await browser.close(); }

  console.log(`\n  ${pass} geçti, ${fail} kaldı`);
  if (fail) { console.log('\nKALANLAR:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
