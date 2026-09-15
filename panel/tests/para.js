/**
 * The money screens and the reseller door, walked in a real browser.
 *
 * tests/shell.js already walks every entry the sidebar offers, which covers
 * Bayiler, Faturalar, Ödemeler and Gelir as list screens. What it cannot cover
 * is what has no sidebar entry: the detail and form screens behind those lists
 * (a reseller, an invoice, the new-invoice form, a payment) and the whole of
 * /bayi/, which is a SEPARATE DOOR with its own login and therefore its own
 * session - shell.js signs in as the administrator and could never reach it.
 *
 * Same four assertions as shell.js, deliberately: the page rendered, no
 * JavaScript error, the document does not scroll sideways, and no control is
 * drawn outside the box that owns it. The last one has to be a measurement
 * rather than a glance - a button two pixels past the edge of its card is
 * invisible in a screenshot at 1440 and obvious to the man using the panel.
 *
 *   NODE_PATH=/opt/node-tools/node_modules node panel/tests/para.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { tarayiciAc } = require('../../pos-service/test/tarayici');

const BASE = process.env.PANEL || 'http://127.0.0.1:8090';
const ADMIN = process.env.PANEL_ADMIN || 'erik@noktapp.com';
const PASS = process.env.PANEL_ADMIN_PASS || 'ChainTest123';
const BAYI_PASS = process.env.BAYI_PASS || 'BayiTest123';
const OUT = path.join(__dirname, 'shots', 'v2');
const WIDTHS = [1440, 1100, 430];

fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; }
  else { fail++; failures.push(`${name}${detail ? ' -> ' + detail : ''}`); console.log(`  FAIL  ${name}  -> ${detail || ''}`); }
}

/* The same probe shell.js uses, kept identical on purpose so a failure here
   and a failure there mean exactly the same thing. */
const OVERFLOW_PROBE = () => {
  const CONTROLS = 'a, button, input, select, textarea, .btn, .pill, .meter, .keyline, code';
  const BOXES = '.card, .stat, table.grid, table.tbl, .rail, .page-head, .side, .side-me, .empty, .flash, .alert, .page-w';
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

const ERROR_MARKS = ['Panel bir hata ile karsilasti', 'Panel durdu', 'Bayi paneli durdu',
                     'Bayi paneli bir hata ile karsilasti', 'Fatal error', 'Parse error',
                     'Warning:', 'Notice:', 'Deprecated:'];

async function visit(page, label, url, opts = {}) {
  let jsErrors = [];
  const onErr = e => jsErrors.push(e.message);
  const onCon = m => { if (m.type() === 'error') jsErrors.push('console: ' + m.text()); };
  page.on('pageerror', onErr);
  page.on('console', onCon);

  const resp = await page.goto(url, { waitUntil: 'networkidle' });
  check(`${label} HTTP 200`, resp && resp.status() === 200, resp && String(resp.status()));

  const body = await page.content();
  const bad = ERROR_MARKS.find(m => body.includes(m));
  check(`${label} PHP hatasız`, !bad, bad);
  check(`${label} 404 değil`, !body.includes('Sayfa bulunamadı'), '404 ekranı geldi');
  if (opts.needle) {
    check(`${label} içerik`, body.includes(opts.needle), `"${opts.needle}" yok`);
  }
  check(`${label} JS hatasız`, jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));

  const sideways = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${label} yatay kaydırma yok`, sideways <= 1, `${sideways}px taşma`);

  const over = await page.evaluate(OVERFLOW_PROBE);
  check(`${label} kutu taşması yok`, over.length === 0,
    over.slice(0, 3).map(o => `${o.el} ${o.over}px dışarıda (${o.box}) "${o.text}"`).join(' ; '));

  page.off('pageerror', onErr);
  page.off('console', onCon);
  return body;
}

(async () => {
  const sql = `SELECT
      COALESCE((SELECT id FROM np_resellers ORDER BY id LIMIT 1),0),
      COALESCE((SELECT email FROM np_resellers WHERE is_active=1 ORDER BY id LIMIT 1),''),
      COALESCE((SELECT i.id FROM np_invoices i WHERE i.status='overdue' ORDER BY i.id LIMIT 1),
               (SELECT id FROM np_invoices ORDER BY id LIMIT 1),0),
      COALESCE((SELECT id FROM np_payments ORDER BY id DESC LIMIT 1),0),
      COALESCE((SELECT t.id FROM np_tenants t WHERE t.reseller_id IS NOT NULL
                 AND EXISTS(SELECT 1 FROM np_invoices i WHERE i.tenant_id=t.id) ORDER BY t.id LIMIT 1),0)`;
  const row = execSync(
    `mysql -h127.0.0.1 -P3399 -unoktapp -pnokpass -N -B nokpos_panel -e "${sql.replace(/\s+/g, ' ')}"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split(/\t/);
  const ids = { reseller: +row[0], bayiEmail: row[1], invoice: +row[2], payment: +row[3], tenant: +row[4] };
  console.log('fixture:', ids);
  if (!ids.reseller || !ids.invoice) {
    console.error('Demo verisi yok — önce: php panel/tests/seed_demo.php && php panel/tests/seed_para.php');
    process.exit(1);
  }

  const b = await tarayiciAc();
  try {
    for (const width of WIDTHS) {
      const ctx = await b.newContext({ viewport: { width, height: 950 } });
      const page = await ctx.newPage();

      /* ---------------- the admin's money screens ---------------- */
      const A = `${BASE}/admin/index.php`;
      await page.goto(`${A}?p=login`);
      await page.fill('input[name="email"]', ADMIN);
      await page.fill('input[name="password"]', PASS);
      await page.locator('form button').first().click();
      await page.waitForURL(/p=home/, { timeout: 10000 });

      const adminScreens = [
        ['para-bayi', `?p=bayi&id=${ids.reseller}`, 'Bayi kaydı'],
        ['para-fatura', `?p=fatura&id=${ids.invoice}`, 'Fatura dökümü'],
        ['para-fatura-yeni', `?p=fatura&id=0&tenant=${ids.tenant}`, 'Yeni fatura'],
        ['para-fatura-yeni-bos', '?p=fatura&id=0', 'Ön dolgu'],
        ['para-odeme-yeni', '?p=odeme', 'Ödeme kaydet'],
        ['para-odeme', `?p=odeme&id=${ids.payment}`, 'Tahsilat'],
        ['para-faturalar-gecikmis', '?p=faturalar&s=overdue', 'Yaşlandırma'],
        ['para-faturalar-musteri', `?p=faturalar&tenant=${ids.tenant}`, 'Fatura listesi'],
        ['para-tenant', `?p=tenant&id=${ids.tenant}`, 'Faturalar'],
      ];
      for (const [name, qs, needle] of adminScreens) {
        await visit(page, `${width}px ${name}`, A + qs, { needle });
        await page.screenshot({ path: `${OUT}/${width}-${name}.png`, fullPage: true });
      }

      /* The KDV preview on the new-invoice form is the one piece of script in
         this area, and what it must never do is disagree with the server. It
         is checked as behaviour: type a gross figure, read the line. */
      await page.goto(`${A}?p=fatura&id=0&tenant=${ids.tenant}`, { waitUntil: 'networkidle' });
      await page.check('#bGross');
      await page.fill('#fAmount', '1234.57');
      await page.fill('#fRate', '20');
      await page.waitForTimeout(120);
      const gross = await page.textContent('#fPreview');
      check(`${width}px KDV önizleme (dahil)`,
        /1\.028,81/.test(gross) && /205,76/.test(gross) && /1\.234,57/.test(gross), gross);
      await page.check('#bNet');
      await page.waitForTimeout(120);
      const net = await page.textContent('#fPreview');
      check(`${width}px KDV önizleme (hariç)`,
        /1\.234,57/.test(net) && /246,91/.test(net) && /1\.481,48/.test(net), net);
      await page.screenshot({ path: `${OUT}/${width}-para-kdv-onizleme.png`, fullPage: true });

      await ctx.close();

      /* ---------------- the reseller's own door ---------------- */
      const bctx = await b.newContext({ viewport: { width, height: 950 } });
      const bp = await bctx.newPage();
      const D = `${BASE}/bayi/index.php`;

      await bp.goto(`${D}?p=login`);
      await bp.fill('input[name="email"]', ids.bayiEmail);
      await bp.fill('input[name="password"]', BAYI_PASS);
      await bp.screenshot({ path: `${OUT}/${width}-bayi-login.png` });
      await bp.locator('form button').first().click();
      await bp.waitForURL(/p=home/, { timeout: 10000 });

      const mine = execSync(
        `mysql -h127.0.0.1 -P3399 -unoktapp -pnokpass -N -B nokpos_panel -e "` +
        `SELECT COALESCE((SELECT t.id FROM np_tenants t JOIN np_resellers r ON r.id=t.reseller_id ` +
        `WHERE r.email='${ids.bayiEmail}' ORDER BY t.id LIMIT 1),0), ` +
        `COALESCE((SELECT i.id FROM np_invoices i JOIN np_tenants t ON t.id=i.tenant_id ` +
        `JOIN np_resellers r ON r.id=t.reseller_id WHERE r.email='${ids.bayiEmail}' ORDER BY i.id LIMIT 1),0)"`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split(/\s+/);

      const bayiScreens = [
        ['bayi-home', '?p=home', 'Komisyonum nasıl hesaplanıyor'],
        ['bayi-musteriler', '?p=musteriler', 'Müşterilerim'],
        ['bayi-musteri', `?p=musteri&id=${+mine[0]}`, 'Hesap'],
        ['bayi-faturalar', '?p=faturalar', 'Faturalar'],
        ['bayi-fatura', `?p=fatura&id=${+mine[1]}`, 'Fatura dökümü'],
        ['bayi-odemeler', '?p=odemeler', 'Tahsilatlar'],
        ['bayi-komisyon', '?p=komisyon', 'Ay ay komisyon'],
      ];
      for (const [name, qs, needle] of bayiScreens) {
        await visit(bp, `${width}px ${name}`, D + qs, { needle });
        const state = await bp.evaluate(() => ({
          on: document.querySelectorAll('.side-nav a.on').length,
          cur: !!document.querySelector('.side-nav a[aria-current="page"]'),
        }));
        check(`${width}px ${name} tek aktif menü`, state.on === 1 && state.cur, JSON.stringify(state));
        await bp.screenshot({ path: `${OUT}/${width}-${name}.png`, fullPage: true });
      }

      /* The drawer, which the reseller's shell inherits from the same CSS. */
      if (width < 1000) {
        await bp.goto(`${D}?p=musteriler`);
        const closed = await bp.evaluate(() => document.querySelector('.side').getBoundingClientRect().right);
        check(`${width}px bayi çekmecesi kapalı başlıyor`, closed <= 1, `sağ kenar ${closed}`);
        await bp.locator('.nav-toggle').click();
        await bp.waitForTimeout(350);
        const open = await bp.evaluate(() => document.querySelector('.side').getBoundingClientRect().right);
        check(`${width}px bayi hamburgeri çekmeceyi açıyor`, open > 100, `sağ kenar ${open}`);
        await bp.screenshot({ path: `${OUT}/${width}-bayi-drawer.png` });
      } else {
        const vis = await bp.evaluate(() => {
          const s = document.querySelector('.side').getBoundingClientRect();
          const m = document.querySelector('main').getBoundingClientRect();
          return { sideLeft: s.left, sideRight: s.right, mainLeft: m.left };
        });
        check(`${width}px bayi kenar çubuğu sabit`, vis.sideLeft === 0 && vis.sideRight > 180, JSON.stringify(vis));
        check(`${width}px bayi içeriği çubuğun sağında`, vis.mainLeft >= vis.sideRight - 1, JSON.stringify(vis));
      }

      await bctx.close();
      console.log(`  ${width}px bitti`);
    }
  } finally { await b.close(); }

  console.log(`\n  ${pass} geçti, ${fail} kaldı`);
  if (fail) { console.log('\nKALANLAR:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
