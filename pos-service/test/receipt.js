'use strict';
/**
 * Fiş ayarları, yazıcı ayarları, müşteri ekranı.
 *
 * The owner said three things had no place in the program: the text that goes
 * on the thermal slip, the printer setup, and the customer display. This suite
 * runs the three of them against a real MariaDB, the real HTTP service and the
 * real ESC/POS builder, and then opens the actual customer-display page in a
 * real browser - because every failure worth catching here is one a mock hides:
 *
 *   - a setting that saves and does not stick;
 *   - a "preview" that is a second renderer and quietly disagrees with the
 *     printer, which is the only thing the owner will ever check it against;
 *   - a 58 mm printer that is still sent 48 characters per line, so every line
 *     of the bill is cut in half and nobody can say why;
 *   - a test print that reports success into thin air;
 *   - a display page that gains a QR and loses its bill;
 *   - a "döviz karşılığı" printed off a rate nobody has touched in a week,
 *     with nothing on the paper to say so;
 *   - a karekod that is on one renderer and missing from the other two;
 *   - and, above all, a receipt that CHANGED for the restaurants that asked
 *     for none of this. The last check in this file compares the bytes with
 *     both features off against bytes captured from the builder before the
 *     döviz line and the karekod existed at all.
 *
 * The suite owns tenant 83 so it can delete every printer and every job without
 * touching the fixtures the other suites use. np_settings has no client column
 * - it is one installation - so the keys this suite writes are captured at the
 * start and put back at the end.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/receipt.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7471';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const auth = require('../src/auth');
const mod = require('../src/modules/receipt');
const { decode } = require('../src/print/escpos');
const { bootstrap } = require('../src/index');
const { tarayiciAc } = require('./tarayici');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 83;
let TOKEN = null, WAITER_TOKEN = null;

async function api(method, p, body, token = TOKEN) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

/**
 * The migration is applied here rather than assumed. The desktop shell replays
 * every file in database/migrations on each start; a test run has no shell, and
 * a suite that dies with "Unknown column 'paper_width'" says nothing about the
 * paper. The file is idempotent, so this is the same thing the shell does.
 */
async function migrate() {
  for (const name of ['2026-09-03-receipt.sql', '2026-09-03-receipt-fx-qr.sql']) {
    const file = path.join(__dirname, '..', '..', 'database', 'migrations', name);
    const sql = fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
      try { await db.exec(stmt); } catch (_) { /* already applied */ }
    }
  }
}

/**
 * The words on a PDF page.
 *
 * PDFKit compresses each content stream and writes the glyphs as hex inside
 * [<...>] TJ, so "the PDF says 92,50 EUR" cannot be asserted by grepping the
 * file - which is precisely why the PDF is the renderer most likely to quietly
 * lose a line. The streams are inflated and the hex runs decoded back into
 * text, so these checks read the page the way a person opening it would.
 */
function pdfText(file) {
  const zlib = require('zlib');
  const s = fs.readFileSync(file).toString('latin1');
  let out = '';
  for (let i = 0; ;) {
    const at = s.indexOf('stream', i);
    if (at < 0) break;
    i = at + 6;
    if (s.slice(at - 3, at) === 'end') continue;                 // "endstream"
    /* The stream's own /Length, read backwards out of the dictionary that
       introduces it. Scanning FORWARD from a /Length to the next "stream"
       silently pairs one object's length with another object's data, which
       truncates the page and loses whatever was drawn last - the döviz block
       and the karekod caption, as it happens. */
    const head = s.slice(Math.max(0, at - 400), at);
    const lens = [...head.matchAll(/\/Length (\d+)/g)];
    if (!lens.length) continue;
    let start = at + 6;
    if (s[start] === '\r') start++;
    if (s[start] === '\n') start++;
    let body;
    try { body = zlib.inflateSync(Buffer.from(s.slice(start, start + Number(lens[lens.length - 1][1])), 'latin1')).toString('latin1'); }
    catch (_) { continue; }
    if (!/\bTf\b/.test(body)) continue;                          // an image, not text
    /* PDFKit kerns, so one line of text is written as [<run> 50 <run> 0] TJ -
       several hex runs with the kerning numbers BETWEEN them. Decoding the
       runs where they stand leaves those numbers in the middle of the words
       ("1 EUR = 42,15  50 TL"), so each TJ array is collapsed to its runs and
       the spacing values are dropped, which is what a reader sees. */
    out += body.replace(/\[([^\]]*)\]\s*TJ/g, (_, arr) =>
      [...arr.matchAll(/<([0-9A-Fa-f]+)>/g)]
        .map(h => Buffer.from(h[1], 'hex').toString('latin1')).join('')) + '\n';
  }
  return out;
}

/** How many pages the bill came out as. One, for a bill this size. */
function pdfPages(file) {
  return (fs.readFileSync(file).toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;
}

/** Does the PDF carry an embedded picture at all? The karekod is the only one. */
function pdfHasImage(file) {
  return fs.readFileSync(file).toString('latin1').includes('/Subtype /Image');
}

/* Every np_settings key this suite touches, so the other suites find the
   installation as they left it. */
const TOUCHED = [
  ...mod.DEFS.map(d => d.key), ...mod.BORROWED_KEYS,
];
async function snapshot() {
  const snap = {};
  for (const k of TOUCHED) snap[k] = await db.getSetting(k, null);
  const c = await db.one('SELECT receipt_header, receipt_footer FROM clients WHERE id=?', [CID]);
  snap.__client = c || {};
  snap.__display = await db.one('SELECT * FROM np_display_settings WHERE id=1');
  snap.__rates = await db.query('SELECT * FROM doviz_kurlari WHERE client_id=?', [CID]);
  snap.__qrmenu = await db.one('SELECT * FROM qr_menu_settings WHERE client_id=?', [CID]);
  return snap;
}

/**
 * Three rates in the three states that decide what is printed:
 *
 *   EUR - entered just now. Prints the amount and the rate.
 *   USD - entered 200 hours ago, well past the 24 the suite configures. Prints
 *         the amount, the rate AND the day the rate was set.
 *   GBP - never entered. A rate of zero is not a rate; nothing is printed, and
 *         the screen is expected to say why rather than the paper.
 */
const FX = { EUR: 42.15, USD: 39.5, STALE_HOURS: 200 };
async function fxFixture() {
  const put = (code, name, sym, sort, rate, when) => db.exec(
    `INSERT INTO doviz_kurlari (client_id, code, name, symbol, rate, is_active, sort_order, rate_updated_at, created_at)
     VALUES (?,?,?,?,?,1,?,${when},NOW())
     ON DUPLICATE KEY UPDATE rate=VALUES(rate), is_active=1, sort_order=VALUES(sort_order),
                             rate_updated_at=VALUES(rate_updated_at)`,
    [CID, code, name, sym, rate, sort]);
  await put('EUR', 'Euro', '\u20ac', 1, FX.EUR, 'NOW()');
  await put('USD', 'Amerikan Dolari', '$', 2, FX.USD, `DATE_SUB(NOW(), INTERVAL ${FX.STALE_HOURS} HOUR)`);
  await put('GBP', 'Ingiliz Sterlini', '\u00a3', 3, 0, 'NULL');
}
async function restore(snap) {
  for (const k of TOUCHED) {
    if (snap[k] === null || snap[k] === undefined) await db.exec('DELETE FROM np_settings WHERE k=?', [k]);
    else await db.setSetting(k, snap[k]);
  }
  for (const r of snap.__rates || []) {
    await db.exec(
      'UPDATE doviz_kurlari SET rate=?, is_active=?, rate_updated_at=? WHERE id=? AND client_id=?',
      [r.rate, r.is_active, r.rate_updated_at, r.id, CID]).catch(() => {});
  }
  if (!snap.__qrmenu) await db.exec('DELETE FROM qr_menu_settings WHERE client_id=?', [CID]).catch(() => {});
  const d = snap.__display;
  if (d) {
    await db.exec(`UPDATE np_display_settings SET headline=?, subline=?, foot_note=?, enabled=?, qr_enabled=?,
        qr_data=?, qr_caption=?, qr_svg=?, image_enabled=?, image_data=?, image_caption=?, media_size=? WHERE id=1`,
      [d.headline, d.subline, d.foot_note || null, d.enabled, d.qr_enabled || 0, d.qr_data || null,
       d.qr_caption || null, d.qr_svg || null, d.image_enabled || 0, d.image_data || null,
       d.image_caption || null, d.media_size || 'kucuk']);
  }
}

/* ------------------------------ fixture ---------------------------- */
async function fixture() {
  const c = await db.one('SELECT id FROM clients WHERE id=?', [CID]);
  if (!c) {
    await db.exec(
      `INSERT INTO clients (id, client_id, slug, owner_name, company_name, full_address, permanent_email,
          username, password_hash, tax_number, tax_office, phone, is_active, setup_done)
       VALUES (?,?,'fis-testi','Fis Sahibi','Fis Test Lokantasi','Fis Mah. 3','sahip@fistest.local',
          'fistest','','9876543210','Fis VD','05310000000',1,1)`, [CID, CID]);
  }
  await db.exec(
    `INSERT INTO business_settings (client_id, business_name, tax_number, tax_office, address_line1, city, phone,
        created_at, updated_at)
     VALUES (?,'Fis Test Lokantasi','9876543210','Fis VD','Fis Mah. 3','Istanbul','05310000000',NOW(),NOW())
     ON DUPLICATE KEY UPDATE business_name=VALUES(business_name)`, [CID]).catch(() => {});

  for (const t of ['print_jobs', 'printers', 'order_payments', 'order_items', 'orders',
                   'products', 'categories', 'restaurant_tables', 'table_zones', 'stations', 'users']) {
    await db.exec(`DELETE FROM \`${t}\` WHERE client_id=?`, [CID]).catch(() => {});
  }

  const catalog = require('../src/modules/catalog');
  const uid = await catalog.saveUser(CID, {
    display_name: 'Fis Yonetici', username: 'fisadmin', role: 'admin', pin: '4321', password: 'Sifre1234',
  }, null);
  const wid = await catalog.saveUser(CID, {
    display_name: 'Fis Garson', username: 'fisgarson', role: 'waiter', pin: '1122', password: 'Sifre1234',
  }, null);
  TOKEN = await auth.issueToken({ cid: CID, uid, role: 'admin', name: 'Fis Yonetici', kind: 'pos' });
  WAITER_TOKEN = await auth.issueToken({ cid: CID, uid: wid, role: 'waiter', name: 'Fis Garson', kind: 'pos' });

  await db.insert('INSERT INTO stations (client_id,name,display_name,is_default,is_active,sort_order) VALUES (?,?,?,1,1,1)',
    [CID, 'Kasa', 'Kasa / Adisyon']);
  const cat = await db.insert(
    'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,1,1,1,1)',
    [CID, 'Yemekler']);
  const mk = (n, price, vat) => db.insert(
    `INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,sort_order,
        is_active,use_in_pos,use_in_qr,track_stock) VALUES (?,?,?,?,?,?,0,1,1,1,0)`,
    [CID, cat, n, price, 0, vat]);
  const zone = await db.insert('INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)',
    [CID, 'Salon']);
  const table = await db.insert(
    'INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active) VALUES (?,?,?,1,1)',
    [CID, zone, 'Fis Masa 1']);
  return { kebap: await mk('Adana Kebap', 420, 10), ayran: await mk('Ayran', 45, 10), table };
}

/** The settings this suite writes, and expects back exactly as written. */
const PATCH = {
  receipt_title: 'ADISYON',
  receipt_thanks: 'Yine bekleriz',
  receipt_show_thanks: '1',
  receipt_show_business_name: '1',
  receipt_show_address: '0',
  receipt_show_phone: '0',
  receipt_show_tax: '0',
  receipt_show_table: '1',
  receipt_show_datetime: '1',
  receipt_show_brand: '0',
  receipt_paper: '80',
  receipt_qr_text: 'https://ornek.local/menu',
  receipt_qr_caption: 'Menu icin okutun',
  receipt_show_vat: '1',
  receipt_show_waiter: '1',
  receipt_show_fx: '0',
  receipt_copies: '2',
  receipt_auto_print: '1',
  receipt_qr: '1',
  receipt_header: 'Ornek Lokanta\nBagdat Cad. No 12',
  receipt_footer: 'Instagram: @ornektest',
};

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  await migrate();
  console.log('\nNOKTApp POS - fis, yazici, musteri ekrani\n');
  const P = await fixture();
  const snap = await snapshot();


  /* ===================== 1. FİŞ AYARLARI ============================ */

  await step('the receipt screen answers with its catalogue, its values and the width in force', async () => {
    const r = await api('GET', '/api/receipt');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.groups.length >= 3, 'expected the three groups');
    const keys = [].concat(...r.groups.map(g => g.defs.map(d => d.key)));
    for (const k of ['receipt_title', 'receipt_thanks', 'receipt_paper', 'receipt_show_vat', 'receipt_copies']) {
      assert.ok(keys.includes(k), 'missing from the catalogue: ' + k);
    }
    for (const g of r.groups) for (const d of g.defs) {
      assert.ok(d.label && d.type, 'a definition with no label or type: ' + JSON.stringify(d));
    }
    assert.strictEqual(typeof r.width, 'number');
    assert.ok([48, 32].includes(r.width), 'the width in force should be a real paper width: ' + r.width);
  });

  await step('every receipt setting round-trips: saved, read back, identical', async () => {
    const w = await api('POST', '/api/receipt', { settings: PATCH });
    assert.strictEqual(w.status, 200, JSON.stringify(w));
    const r = await api('GET', '/api/receipt');
    for (const [k, v] of Object.entries(PATCH)) {
      assert.strictEqual(String(r.values[k]), String(v), `${k}: saved "${v}", read back "${r.values[k]}"`);
    }
  });

  await step('the paper carries the character count with it - 80 mm is 48', async () => {
    const r = await api('GET', '/api/receipt');
    assert.strictEqual(String(r.values.receipt_width), '48', 'receipt_width should follow the paper');
    assert.strictEqual(r.paper, 80);
    assert.strictEqual(await mod.charWidth(), 48);
  });

  await step('the borrowed keys really go through the settings module, not around it', async () => {
    // receipt_copies belongs to modules/settings; the other screen must see it
    const s = await api('GET', '/api/settings');
    assert.strictEqual(String(s.values.receipt_copies), '2');
    assert.strictEqual(String(s.values.receipt_qr), '1');
    const logged = await db.one(
      'SELECT k FROM np_settings_log WHERE k=? ORDER BY id DESC LIMIT 1', ['receipt_copies']);
    assert.ok(logged, 'a borrowed key was written without an audit row');
  });

  await step('the receipt text lands where the bill builder already reads it', async () => {
    const c = await db.one('SELECT receipt_header, receipt_footer FROM clients WHERE id=?', [CID]);
    assert.strictEqual(c.receipt_header, PATCH.receipt_header);
    assert.strictEqual(c.receipt_footer, PATCH.receipt_footer);
  });

  await step('a header line wider than the paper is refused, and the message says which line', async () => {
    const long = 'BU SATIR KIRK SEKIZ KARAKTERDEN COK DAHA UZUNDUR VE SIGMAZ';
    const r = await api('POST', '/api/receipt', { settings: { receipt_header: long } });
    assert.strictEqual(r.status, 400, 'a line that cannot fit was accepted: ' + JSON.stringify(r));
    assert.ok(/sığmıyor/.test(r.error), 'unhelpful message: ' + r.error);
    assert.ok(/\d+ karakter/.test(r.error), 'the message should count the characters: ' + r.error);
    // and nothing was written
    const c = await db.one('SELECT receipt_header FROM clients WHERE id=?', [CID]);
    assert.strictEqual(c.receipt_header, PATCH.receipt_header, 'a refused save still changed the row');
  });

  await step('an unknown key and an out-of-range number are refused', async () => {
    const a = await api('POST', '/api/receipt', { settings: { receipt_renk: 'mavi' } });
    assert.strictEqual(a.status, 400, 'an unknown receipt setting was stored');
    const b = await api('POST', '/api/receipt', { settings: { receipt_copies: 99 } });
    assert.strictEqual(b.status, 400, 'a copy count of 99 was accepted');
    const c = await api('POST', '/api/receipt', { settings: { receipt_paper: '70' } });
    assert.strictEqual(c.status, 400, 'there is no 70 mm paper');
  });

  /* ======================== 2. ÖNİZLEME ============================= */

  await step('the 80 mm preview is exactly 48 characters wide, on every single line', async () => {
    const r = await api('GET', '/api/receipt/preview?paper=80');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.width, 48);
    assert.ok(r.lines.length > 8, 'a bill of ' + r.lines.length + ' lines is not a bill');
    for (const l of r.lines) {
      assert.strictEqual(l.cells, 48, `a line ${l.cells} cells wide: "${l.text}"`);
      assert.strictEqual(l.text.length, l.dw ? 24 : 48,
        `double-width lines carry half the characters: "${l.text}" (${l.text.length})`);
    }
  });

  await step('the 58 mm preview is exactly 32, and the same bill is re-laid out for it', async () => {
    const r = await api('GET', '/api/receipt/preview?paper=58');
    assert.strictEqual(r.width, 32);
    for (const l of r.lines) {
      assert.strictEqual(l.cells, 32, `a line ${l.cells} cells wide: "${l.text}"`);
      assert.strictEqual(l.text.length, l.dw ? 16 : 32);
    }
    const wide = await api('GET', '/api/receipt/preview?paper=80');
    assert.ok(r.lines.length >= wide.lines.length,
      'narrow paper wraps, so it cannot need fewer lines than wide paper');
  });

  await step('the preview is the printer\'s own bytes, not a second renderer', async () => {
    const printing = require('../src/print');
    const bytes = await printing.buildBill(CID, mod.sampleOrder(), { width: 48 });
    const mine = mod.layout(decode(bytes), 48).map(l => l.text).join('\n');
    const r = await api('GET', '/api/receipt/preview?paper=80');
    assert.strictEqual(r.lines.map(l => l.text).join('\n'), mine,
      'the preview and the ESC/POS builder disagree about the same bill');
  });

  await step('the preview shows what has been TYPED, before anything is saved', async () => {
    const draft = { ...PATCH, receipt_footer: 'DENEME ALT YAZI', receipt_title: 'DENEME BASLIK' };
    const r = await api('POST', '/api/receipt/preview', { paper: 80, draft });
    const text = r.lines.map(l => l.text).join('\n');
    assert.ok(text.includes('DENEME ALT YAZI'), 'the unsaved footer is not in the preview');
    assert.ok(text.includes('DENEME BASLIK'), 'the unsaved title is not in the preview');
    // ...and it really was not saved
    const after = await api('GET', '/api/receipt');
    assert.strictEqual(after.values.receipt_footer, PATCH.receipt_footer, 'the preview wrote to the database');
  });

  await step('a setting that is switched off disappears from the paper', async () => {
    const on = await api('POST', '/api/receipt/preview', { paper: 80, draft: { ...PATCH, receipt_show_vat: '1' } });
    const off = await api('POST', '/api/receipt/preview', { paper: 80, draft: { ...PATCH, receipt_show_vat: '0' } });
    assert.ok(on.lines.some(l => l.text.includes('KDV')), 'the KDV breakdown never appeared');
    assert.ok(!off.lines.some(l => l.text.includes('KDV')), 'the KDV breakdown printed while switched off');
  });

  /* ==================== 3. GERÇEK BİR ADİSYON ======================= */

  let orderId = null;
  await step('a real bill is opened, and the settings reach its ESC/POS bytes', async () => {
    const o = await api('POST', '/api/pos/orders', { table_id: P.table });
    assert.strictEqual(o.status, 200, JSON.stringify(o));
    orderId = o.order_id;
    await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: P.kebap, qty: 2 });
    await api('POST', `/api/pos/orders/${orderId}/items`, { product_id: P.ayran, qty: 1 });
    const printing = require('../src/print');
    const orders = require('../src/modules/orders');
    const bytes = await printing.buildBill(CID, await orders.getOrder(CID, orderId));
    const text = decode(bytes).map(l => l.text).join('\n');
    assert.ok(text.includes('Instagram: @ornektest'), 'the configured footer is not on the bill');
    assert.ok(text.includes('ADISYON'), 'the configured title is not on the bill');
    assert.ok(text.includes('Yine bekleriz'), 'the thank-you line is not on the bill');
    assert.ok(!text.includes('NOKTApp POS'), 'the brand line was switched off and still printed');
  });

  await step('changing the footer changes what the builder emits for that same bill', async () => {
    const printing = require('../src/print');
    const orders = require('../src/modules/orders');
    const order = await orders.getOrder(CID, orderId);
    const before = decode(await printing.buildBill(CID, order)).map(l => l.text).join('\n');

    const w = await api('POST', '/api/receipt', { settings: { receipt_footer: 'Afiyet olsun, yine bekleriz' } });
    assert.strictEqual(w.status, 200, JSON.stringify(w));
    const after = decode(await printing.buildBill(CID, order)).map(l => l.text).join('\n');

    assert.notStrictEqual(before, after, 'the footer changed and the printed bytes did not');
    assert.ok(after.includes('Afiyet olsun, yine bekleriz'), 'the new footer is not on the paper');
    assert.ok(!after.includes('Instagram: @ornektest'), 'the old footer is still on the paper');
  });

  await step('the KDV breakdown switch reaches a real queued bill, not just the preview', async () => {
    const printing = require('../src/print');
    await api('POST', '/api/receipt', { settings: { receipt_show_vat: '0' } });
    await db.exec('DELETE FROM print_jobs WHERE client_id=?', [CID]);
    await printing.queueBill(CID, orderId);
    const job = await db.one('SELECT content FROM print_jobs WHERE client_id=? ORDER BY id DESC LIMIT 1', [CID]);
    assert.ok(job, 'nothing was queued');
    const text = decode(Buffer.from(job.content, 'base64')).map(l => l.text).join('\n');
    assert.ok(!/KDV %\d/.test(text), 'the queued bill still carries the KDV breakdown');
    await api('POST', '/api/receipt', { settings: { receipt_show_vat: '1' } });
  });

  /* ====================== 4. YAZICI AYARLARI ======================== */

  await step('a printer test reports honestly when there is no printer at all', async () => {
    assert.strictEqual(Number(await db.value('SELECT COUNT(*) FROM printers WHERE client_id=?', [CID])), 0);
    const r = await api('POST', '/api/receipt/printers/1/test');
    assert.strictEqual(r.status, 200, 'an unplugged printer is not an HTTP error');
    assert.strictEqual(r.printed, false, 'it claimed to have printed with no printer defined');
    assert.strictEqual(r.reason, 'no_printer');
    assert.ok(/yazıcı/i.test(r.message), 'the message should say so in Turkish: ' + r.message);
  });

  let printerId = null;
  await step('a printer can be added with a paper width and marked as the receipt printer', async () => {
    const made = await api('POST', '/api/receipt/printers', {
      name: 'Kasa Yazici', type: 'network', ip_address: '127.0.0.1:9199',
      paper_width: 80, is_receipt: true });
    assert.strictEqual(made.status, 200, JSON.stringify(made));
    printerId = made.id;
    assert.strictEqual(made.paper_width, 80);
    assert.strictEqual(made.chars, 48);
    const list = await api('GET', '/api/receipt/printers');
    const p = list.printers.find(x => x.id === printerId);
    assert.ok(p, 'the printer is not in the list');
    assert.strictEqual(p.paper_width, 80);
    assert.strictEqual(p.chars, 48);
    assert.strictEqual(p.is_receipt, true, 'it was not marked as the receipt printer');
    assert.strictEqual(Number(await db.value('SELECT is_default FROM printers WHERE id=?', [printerId])), 1,
      'is_receipt must be the same column the print queue falls back to');
  });

  await step('a 58 mm receipt printer really makes the bill 32 characters wide', async () => {
    const made = await api('POST', '/api/receipt/printers', {
      name: 'Dar Yazici', type: 'network', ip_address: '127.0.0.1:9198', paper_width: 58, is_receipt: true });
    assert.strictEqual(made.status, 200, JSON.stringify(made));
    assert.strictEqual(made.chars, 32);
    assert.strictEqual(await mod.charWidth(), 32, 'the receipt width did not follow the paper');

    const printing = require('../src/print');
    const orders = require('../src/modules/orders');
    const lines = decode(await printing.buildBill(CID, await orders.getOrder(CID, orderId)));
    const rule = lines.find(l => /^=+$/.test(l.text));
    assert.ok(rule, 'no rule line on the bill');
    assert.strictEqual(rule.text.length, 32, 'the bill is still being printed at the old width');

    // and the old receipt printer gave the designation up rather than sharing it
    const still = Number(await db.value('SELECT is_default FROM printers WHERE id=?', [printerId]));
    assert.strictEqual(still, 0, 'two printers both claim to be the kasa printer');
  });

  await step('the receipt printer can be moved back, and the width follows it back', async () => {
    const r = await api('POST', `/api/receipt/printers/${printerId}/receipt`);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.chars, 48);
    assert.strictEqual(await mod.charWidth(), 48);
    const list = await api('GET', '/api/receipt/printers');
    assert.strictEqual(list.printers.filter(p => p.is_receipt).length, 1, 'exactly one kasa printer, always');
  });

  await step('the printer rules are the ones the other screen already enforces', async () => {
    const a = await api('POST', '/api/receipt/printers', { name: 'Adressiz', type: 'network', paper_width: 80 });
    assert.strictEqual(a.status, 400, 'a network printer with no address was accepted');
    const b = await api('POST', '/api/receipt/printers', { name: 'Kasa Yazici', type: 'file', ip_address: '/tmp/x' });
    assert.strictEqual(b.status, 400, 'a duplicate printer name was accepted');
    const c = await api('POST', '/api/receipt/printers', { name: 'Lazer', type: 'lazer', ip_address: '1.2.3.4' });
    assert.strictEqual(c.status, 400, 'an unknown printer type was accepted');
  });

  await step('a test print against a dead address says what went wrong, in the answer', async () => {
    const r = await api('POST', `/api/receipt/printers/${printerId}/test`);
    assert.strictEqual(r.status, 200, 'a dead printer is not an HTTP error');
    assert.strictEqual(r.printed, false, 'nothing is listening on 9199 and it claimed to have printed');
    assert.strictEqual(r.reason, 'transport');
    assert.ok(r.message.includes('Kasa Yazici'), 'the message should name the printer: ' + r.message);
  });

  await step('a test print that really does print says so, and the paper exists', async () => {
    const out = path.join(process.env.NOKTAPP_DATA_DIR || '/tmp/nokdata', 'fis-test-' + Date.now() + '.txt');
    const made = await api('POST', '/api/receipt/printers', {
      name: 'Dosya Yazici', type: 'file', ip_address: out, paper_width: 80 });
    const r = await api('POST', `/api/receipt/printers/${made.id}/test`);
    assert.strictEqual(r.printed, true, JSON.stringify(r));
    assert.ok(fs.existsSync(out), 'nothing was written to the file printer');
    assert.ok(fs.readFileSync(out, 'latin1').includes('Dosya Yazici'), 'the slip does not name the printer');
  });

  await step('a failed job can be retried from this screen, and the queue counts it', async () => {
    await db.insert(
      "INSERT INTO print_jobs (client_id, job_type, content, status, created_at) VALUES (?,'report','eA==','failed',NOW())",
      [CID]);
    const before = await api('GET', '/api/receipt/queue');
    assert.ok(before.counts.failed >= 1, 'the failed job is not counted');
    assert.ok(before.warnings.some(w => /başarısız/i.test(w)), 'a failed job raised no warning');
    const r = await api('POST', '/api/receipt/queue/retry-failed');
    assert.ok(r.retried >= 1, 'nothing was retried');
    const after = await api('GET', '/api/receipt/queue');
    assert.strictEqual(after.counts.failed, 0, 'a retried job is still marked failed');
  });

  await step('a pending job can be cancelled, and a cancelled one cannot be cancelled twice', async () => {
    const id = await db.insert(
      "INSERT INTO print_jobs (client_id, job_type, content, status, created_at) VALUES (?,'report','eA==','pending',NOW())",
      [CID]);
    const a = await api('POST', `/api/receipt/queue/${id}/cancel`);
    assert.strictEqual(a.status, 200, JSON.stringify(a));
    const b = await api('POST', `/api/receipt/queue/${id}/cancel`);
    assert.strictEqual(b.status, 400, 'a job was cancelled twice');
  });

  /* ====================== 5. MÜŞTERİ EKRANI ========================= */

  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  await step('the customer display settings round-trip, and the QR is drawn when it is saved', async () => {
    const r = await api('POST', '/api/receipt/display', {
      enabled: true,
      headline: 'Hoş geldiniz, Örnek Lokanta',
      subline: 'Siparişiniz hazırlanıyor',
      foot_note: 'Wifi: ORNEK-MISAFIR',
      qr_enabled: true, qr_data: 'https://ornek.local/menu', qr_caption: 'Menü için okutun',
      image_enabled: true, image_data: PNG, image_caption: 'Bu ay: 2 al 1 öde',
      media_size: 'orta',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const s = r.settings;
    assert.strictEqual(s.headline, 'Hoş geldiniz, Örnek Lokanta');
    assert.strictEqual(s.subline, 'Siparişiniz hazırlanıyor');
    assert.strictEqual(s.foot_note, 'Wifi: ORNEK-MISAFIR');
    assert.strictEqual(s.qr_caption, 'Menü için okutun');
    assert.strictEqual(s.image_caption, 'Bu ay: 2 al 1 öde');
    assert.strictEqual(s.media_size, 'orta');
    assert.ok(/^<\?xml|^<svg/.test(String(s.qr_svg).trim()), 'the QR was not rendered to SVG at save time');
    assert.ok(String(s.qr_svg).includes('<rect'), 'the SVG has no modules in it');
    const back = await api('GET', '/api/receipt/display');
    assert.strictEqual(back.settings.qr_data, 'https://ornek.local/menu');
    assert.strictEqual(back.settings.image_data, PNG);
  });

  await step('a QR with nothing in it, a broken image and an oversized one are refused', async () => {
    const a = await api('POST', '/api/receipt/display', { qr_enabled: true, qr_data: '' });
    assert.strictEqual(a.status, 400, 'an empty QR was accepted');
    const b = await api('POST', '/api/receipt/display', { image_data: 'javascript:alert(1)' });
    assert.strictEqual(b.status, 400, 'a non-image was accepted as the display image');
    const big = 'data:image/png;base64,' + 'A'.repeat(mod.IMAGE_MAX);
    const c = await api('POST', '/api/receipt/display', { image_data: big });
    assert.strictEqual(c.status, 400, 'an oversized image was accepted');
    assert.ok(/KB/.test(c.error), 'the refusal should say how big it may be: ' + c.error);
    // the good settings from the previous step survived all three refusals
    const back = await api('GET', '/api/receipt/display');
    assert.strictEqual(back.settings.headline, 'Hoş geldiniz, Örnek Lokanta');
  });

  await step('the display feed carries the text, the QR and the image to the second screen', async () => {
    const res = await fetch(BASE + '/api/display');
    const r = await res.json();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.settings.headline, 'Hoş geldiniz, Örnek Lokanta');
    assert.strictEqual(r.settings.foot_note, 'Wifi: ORNEK-MISAFIR');
    assert.strictEqual(Number(r.settings.qr_enabled), 1);
    assert.ok(String(r.settings.qr_svg).includes('<svg'), 'the feed carries no drawn QR');
    assert.strictEqual(r.settings.image_data, PNG);
    // the feed still does its original job
    assert.ok(r.order && r.order.items.length, 'the open bill fell out of the display feed');
  });

  await step('the display page draws the new text, QR and image without losing its layout', async () => {
    const browser = await tarayiciAc();
    const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(BASE + '/display.html');
      await page.waitForSelector('#extras svg', { timeout: 10000 });

      // the additions
      assert.strictEqual(await page.textContent('#headline'), 'Hoş geldiniz, Örnek Lokanta');
      assert.strictEqual(await page.textContent('#footNote'), 'Wifi: ORNEK-MISAFIR');
      assert.strictEqual(await page.locator('#extras svg').count(), 1, 'the QR did not draw');
      assert.strictEqual(await page.locator('#extras img').count(), 1, 'the image did not draw');
      assert.ok((await page.textContent('#extras')).includes('Menü için okutun'), 'the QR caption is missing');

      // the layout that was already there, untouched
      for (const sel of ['.stage', '.brand', '.msg', '.rail', '.rail__head', '#lines', '#sum']) {
        assert.strictEqual(await page.locator(sel).count(), 1, 'the existing layout lost ' + sel);
      }
      assert.ok(await page.locator('.ln').count() > 0, 'the bill lines are gone from the rail');
      assert.ok((await page.textContent('#sum')).includes('Toplam'), 'the total is gone from the rail');

      // and it still fits: the additions sit inside the column they were added
      // to, above the foot note and clear of the bill, on the screen
      const g = await page.evaluate(() => {
        const r = s => { const b = document.querySelector(s).getBoundingClientRect();
          return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width }; };
        return { brand: r('.brand'), ex: r('#extras'), foot: r('.foot'), rail: r('.rail'),
                 ih: window.innerHeight, sw: document.body.scrollWidth, iw: window.innerWidth };
      });
      assert.ok(g.rail.width > 400 && g.rail.width < 440, 'the rail changed width: ' + g.rail.width);
      assert.ok(g.ex.right <= g.rail.left, 'the additions run under the bill');
      assert.ok(g.ex.top >= g.brand.bottom, 'the additions climbed over the logo');
      assert.ok(g.ex.bottom <= g.foot.top, 'the additions sit on top of the foot note');
      assert.ok(g.foot.bottom <= g.ih, 'the foot note was pushed off the bottom of the screen');
      assert.strictEqual(g.sw, g.iw, 'the additions widened the page');
      assert.deepStrictEqual(errors, [], 'the display page raised JavaScript errors');
    } finally { await browser.close(); }
  });

  await step('turning the QR and the image off empties the block instead of leaving a hole', async () => {
    await api('POST', '/api/receipt/display', {
      enabled: true, headline: 'Hoş geldiniz', subline: 'Afiyet olsun', foot_note: '',
      qr_enabled: false, qr_data: '', image_enabled: false, image_data: '', media_size: 'kucuk' });
    const browser = await tarayiciAc();
    const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
    try {
      await page.goto(BASE + '/display.html');
      await page.waitForSelector('.rail__head');
      await page.waitForFunction(() => document.querySelector('#extras').children.length === 0, null, { timeout: 8000 });
      assert.strictEqual(await page.textContent('#footNote'), 'NOKTApp POS', 'the default foot note is gone');
      const h = await page.evaluate(() => document.querySelector('#extras').getBoundingClientRect().height);
      assert.strictEqual(h, 0, 'an empty extras block still takes up ' + h + 'px');
    } finally { await browser.close(); }
  });

  /* ================= 7. DÖVİZ KARŞILIĞI VE KAREKOD =================== */
  /*
   * The owner of a tourist-area restaurant said the bill was missing two
   * things: the foreign-currency equivalent, and a QR. Both are decided ONCE,
   * in print/document.js, and every check below renders the SAME order through
   * all three renderers and asserts on all three - because "it works on the
   * thermal" is exactly how the PDF and the mail body drifted apart the last
   * time, and a customer was e-mailed a bill with two different totals on it.
   */

  const mailer = require('../src/mail');
  const docs = require('../src/print/document');
  const licence = require('../src/licence');
  const { tl } = docs;

  /** One order, rendered by the printer, the PDF and the mail body. */
  async function renderAll() {
    const printing = require('../src/print');
    const orders = require('../src/modules/orders');
    const order = await orders.getOrder(CID, orderId);
    const doc = await docs.billDocument(CID, order);
    const pdfFile = await mailer.billPdf(CID, order, doc);
    return {
      doc,
      thermal: decode(await printing.buildBill(CID, order)).map(l => l.text).join('\n'),
      pdf: pdfText(pdfFile),
      pdfFile,
      html: mailer.billHtml(doc),
    };
  }
  const setFis = (settings) => api('POST', '/api/receipt', { settings });

  await fxFixture();

  await step('with no currency chosen there is no döviz line on any of the three', async () => {
    const w = await setFis({ receipt_fx_currencies: '', receipt_qr_mode: 'kapali' });
    assert.strictEqual(w.status, 200, JSON.stringify(w));
    const r = await renderAll();
    assert.deepStrictEqual(r.doc.fx, [], 'the document built a döviz block nobody asked for');
    for (const [where, text] of [['fişte', r.thermal], ['PDF\'de', r.pdf], ['e-postada', r.html]]) {
      assert.ok(!/\bEUR\b/.test(text), 'döviz kapalıyken ' + where + ' EUR var');
      assert.ok(!text.includes(docs.FX_NOTE), 'döviz kapalıyken ' + where + ' bilgi satırı var');
    }
    // and the old on/off switch was carried with it, so the other screen agrees
    const s = await api('GET', '/api/settings');
    assert.strictEqual(String(s.values.receipt_show_fx), '0',
      'no currency is chosen but Ayarlar still shows "Döviz karşılığını yazdır" ticked');
  });

  await step('choosing EUR puts the same döviz line on the fiş, the PDF and the e-posta', async () => {
    const w = await setFis({ receipt_fx_currencies: 'EUR', receipt_fx_max_age_hours: '24' });
    assert.strictEqual(w.status, 200, JSON.stringify(w));
    const r = await renderAll();
    assert.strictEqual(r.doc.fx.length, 1, 'expected exactly one currency: ' + JSON.stringify(r.doc.fx));
    const f = r.doc.fx[0];
    assert.strictEqual(f.code, 'EUR');
    assert.ok(!f.stale, 'a rate entered a moment ago was called stale');

    assert.ok(r.thermal.includes('~ ' + f.amountText), 'fişte döviz satırı yok:\n' + r.thermal);
    assert.ok(r.thermal.includes(f.sourceText), 'fişte kur satırı yok');
    assert.ok(r.pdf.includes(f.amountText), 'PDF\'de döviz satırı yok');
    assert.ok(r.pdf.includes(f.sourceText), 'PDF\'de kur satırı yok');
    assert.ok(r.html.includes(f.amountText), 'e-postada döviz satırı yok');
    assert.ok(r.html.includes(f.sourceText), 'e-postada kur satırı yok');

    // the guest has to be able to tell which number is owed
    for (const [where, text] of [['fiş', r.thermal], ['PDF', r.pdf], ['e-posta', r.html]]) {
      assert.ok(text.includes(docs.FX_NOTE), where + ': döviz var ama "bilgi içindir" satırı yok');
    }
    // ...and it says so in Ayarlar too, without anybody ticking a second box
    const s = await api('GET', '/api/settings');
    assert.strictEqual(String(s.values.receipt_show_fx), '1');
  });

  await step('the printed foreign amount is the total divided by the rate, to the kurus', async () => {
    const r = await renderAll();
    const f = r.doc.fx[0];
    const expected = Math.round((r.doc.totals.grand / FX.EUR) * 100) / 100;
    assert.strictEqual(f.rate, FX.EUR, 'the bill used a rate that is not the one in doviz_kurlari');
    assert.strictEqual(f.amount, expected,
      `${r.doc.totals.grand} / ${FX.EUR} should be ${expected}, the bill says ${f.amount}`);
    assert.strictEqual(f.amountText, tl(expected) + ' EUR');
    // and the arithmetic on the paper is the arithmetic in the document
    assert.ok(r.thermal.includes(tl(expected) + ' EUR'), 'the paper rounded differently to the document');
    assert.ok(r.html.includes(tl(expected) + ' EUR'), 'the e-mail rounded differently to the document');
  });

  /*
   * The date used to be printed beside an old rate - "1 USD = 50 TL
   * (03.09.2026 kuru)". It was meant as honesty and it is the restaurant's
   * housekeeping on a guest's receipt: the guest cannot act on it and it reads
   * as an excuse. The staleness still matters, so it moved to the screen where
   * somebody can fix it, and the paper carries the rate alone.
   */
  await step('eski kur da fişe basılır ama misafirin fişinde tarih yer almaz', async () => {
    await setFis({ receipt_fx_currencies: 'EUR,USD', receipt_fx_max_age_hours: '24' });
    const r = await renderAll();
    const eur = r.doc.fx.find(f => f.code === 'EUR');
    const usd = r.doc.fx.find(f => f.code === 'USD');
    assert.ok(usd, 'the 200-hour-old rate vanished instead of being printed');
    assert.strictEqual(usd.stale, true, 'a 200-hour-old rate was treated as current');
    assert.strictEqual(eur.stale, false);

    /* the document still KNOWS how old it is - the screens use it */
    assert.ok(usd.dateText, 'the document lost the rate date entirely');
    assert.ok(usd.ageHours > 24, 'the age is no longer computed');

    for (const [where, text] of [['fiş', r.thermal], ['PDF', r.pdf], ['e-posta', r.html]]) {
      assert.ok(text.includes(usd.sourceText), where + ': eski kurun satırı yok');
      assert.ok(!/\(\d\d\.\d\d\.\d{4} kuru\)/.test(text),
        where + ': misafirin fişinde hâlâ kur tarihi yazıyor');
      assert.ok(!text.includes(docs.dayText(usd.updatedAt) + ' kuru'),
        where + ': kur tarihi başka bir biçimde sızmış');
    }
    assert.strictEqual(usd.sourceText, '1 USD = ' + docs.rateText(usd.rate) + ' TL',
      'the rate line is not just the rate: "' + usd.sourceText + '"');
  });

  await step('how old is "old" is the owner\'s setting, and moving it moves the label', async () => {
    await setFis({ receipt_fx_max_age_hours: '500' });
    const wide = await renderAll();
    const usdWide = wide.doc.fx.find(f => f.code === 'USD');
    assert.strictEqual(usdWide.stale, false, '200 hours is not stale when the limit is 500');
    assert.ok(!wide.thermal.includes('kuru)'), 'a rate printed its date');

    await setFis({ receipt_fx_max_age_hours: '1' });
    const tight = await renderAll();
    assert.strictEqual(tight.doc.fx.find(f => f.code === 'EUR').stale, false,
      'a rate set seconds ago cannot be over an hour old');
    assert.strictEqual(tight.doc.fx.find(f => f.code === 'USD').stale, true);
    await setFis({ receipt_fx_max_age_hours: '24' });
  });

  await step('a currency whose rate was never entered prints nothing, and the screen says why', async () => {
    const w = await setFis({ receipt_fx_currencies: 'EUR,GBP' });
    assert.strictEqual(w.status, 200, JSON.stringify(w));
    const r = await renderAll();
    assert.ok(!r.doc.fx.some(f => f.code === 'GBP'), 'a rate of zero was printed as a rate');
    for (const [where, text] of [['fiş', r.thermal], ['PDF', r.pdf], ['e-posta', r.html]]) {
      assert.ok(!/\bGBP\b/.test(text), where + ': kuru girilmemiş para birimi basıldı');
    }
    const g = await api('GET', '/api/receipt');
    assert.ok((g.fx_warnings || []).some(x => /GBP/.test(x)),
      'nothing on the screen says why GBP is not printing: ' + JSON.stringify(g.fx_warnings));
    // a code that does not exist at all is refused outright, not stored and ignored
    const bad = await setFis({ receipt_fx_currencies: 'EUR,XXX' });
    assert.strictEqual(bad.status, 400, 'an unknown currency code was accepted');
    assert.ok(/XXX/.test(bad.error), 'the refusal should name the code: ' + bad.error);
  });

  await step('the döviz line is informational: it cannot move the total or add a payment', async () => {
    const paymentsBefore = Number(await db.value(
      'SELECT COUNT(*) FROM order_payments WHERE order_id=?', [orderId]));

    await setFis({ receipt_fx_currencies: '' });
    const off = await renderAll();
    await setFis({ receipt_fx_currencies: 'EUR,USD' });
    const on = await renderAll();

    assert.deepStrictEqual(on.doc.totals, off.doc.totals,
      'turning the döviz line on changed what the guest owes');
    assert.deepStrictEqual(on.doc.payments, off.doc.payments, 'the döviz line invented a payment');
    assert.strictEqual(Number(await db.value(
      'SELECT COUNT(*) FROM order_payments WHERE order_id=?', [orderId])), paymentsBefore,
      'rendering a döviz line wrote a payment row');
    assert.strictEqual(Number(await db.value(
      'SELECT grand_total FROM orders WHERE id=?', [orderId])), on.doc.totals.grand,
      'the stored total moved');
    // the TL total is still the loud one on the paper
    assert.ok(on.thermal.includes('TOPLAM'), 'the TL total left the bill');
  });

  await step('the live preview follows an unsaved döviz choice, not the one on disk', async () => {
    /*
     * The döviz list and the karekod mode each carry an old boolean that save()
     * writes for them, and the screen draws no control for those booleans. So a
     * DRAFT names the currency and says nothing about receipt_show_fx - and if
     * options() ANDed the draft against the boolean still in the database, the
     * preview would answer with the last SAVED state while the owner watches
     * the control he just changed do nothing.
     */
    await setFis({ receipt_fx_currencies: '', receipt_qr_mode: 'kapali' });
    const saved = await api('GET', '/api/settings');
    assert.strictEqual(String(saved.values.receipt_show_fx), '0');
    assert.strictEqual(String(saved.values.receipt_qr), '0');

    const draft = { ...PATCH, receipt_fx_currencies: 'EUR', receipt_qr_mode: 'serbest',
      receipt_qr_text: 'https://ornek.local/onizleme', receipt_qr: '0', receipt_show_fx: '0' };
    const p = await api('POST', '/api/receipt/preview', { paper: 80, draft });
    assert.strictEqual(p.status, 200, JSON.stringify(p));
    const text = p.lines.map(l => l.text).join('\n');
    assert.ok(/~ [\d.,]+ EUR/.test(text), 'the unsaved döviz choice is not in the preview:\n' + text);
    assert.ok(text.includes('[karekod] https://ornek.local/onizleme'),
      'the unsaved karekod choice is not in the preview');

    // ...and nothing was written by looking at it
    const after = await api('GET', '/api/settings');
    assert.strictEqual(String(after.values.receipt_show_fx), '0', 'the preview saved the draft');
    assert.strictEqual(String(after.values.receipt_qr), '0', 'the preview saved the draft');
  });

  /* ----------------------------- karekod ---------------------------- */

  await step('a free-text karekod reaches the fiş, the PDF and the e-posta', async () => {
    const url = 'https://ornek.local/menu';
    const w = await setFis({ receipt_qr_mode: 'serbest', receipt_qr_text: url,
      receipt_qr_caption: 'Menu icin okutun' });
    assert.strictEqual(w.status, 200, JSON.stringify(w));
    const r = await renderAll();
    assert.ok(r.doc.qr, 'the document has no karekod');
    assert.strictEqual(r.doc.qr.data, url);

    // thermal: the printer draws it natively, so what is on the wire is the
    // GS ( k command - decoded back out here rather than assumed
    assert.ok(r.thermal.includes('[karekod] ' + url),
      'the ESC/POS bytes carry no QR command:\n' + r.thermal);
    assert.ok(r.thermal.includes('Menu icin okutun'), 'the caption is not under the square');

    assert.ok(pdfHasImage(r.pdfFile), 'the PDF carries no embedded karekod image');
    assert.ok(r.pdf.includes('Menu icin okutun'), 'the PDF lost the caption');
    /* the square must fit on the bill, not start a second sheet: the first
       version pinned it low enough to push the footer onto a page of its own */
    assert.strictEqual(pdfPages(r.pdfFile), 1,
      'adding the karekod turned a one-page bill into ' + pdfPages(r.pdfFile) + ' pages');

    assert.ok(r.html.includes('data:image/png;base64,'), 'the e-mail has no inline karekod image');
    assert.ok(r.html.includes(url), 'the e-mail does not carry the address the QR scans to');
    assert.ok(r.html.includes('Menu icin okutun'), 'the e-mail lost the caption');
  });

  await step('what the karekod carries follows the mode that was chosen', async () => {
    // ---- dijital menü: the same address the table cards use
    await db.exec(
      `INSERT INTO qr_menu_settings (client_id, slug, business_name, currency, theme, is_published)
       VALUES (?,?,?,?,?,1) ON DUPLICATE KEY UPDATE slug=VALUES(slug), is_published=1`,
      [CID, 'fis-testi-menu', 'Fis Test Lokantasi', 'TRY', 'orange']);
    await setFis({ receipt_qr_mode: 'menu' });
    const menu = await renderAll();
    const base = (await licence.panelUrl()).replace(/\/+$/, '');
    assert.strictEqual(menu.doc.qr.data, `${base}/qr/?s=fis-testi-menu`,
      'the menü karekod does not point at the published menu');
    assert.ok(menu.thermal.includes('[karekod] ' + menu.doc.qr.data));
    assert.ok(menu.html.includes(menu.doc.qr.data));

    // ---- sadakat: the address the owner entered, and nothing derived
    await setFis({ receipt_qr_mode: 'sadakat', receipt_qr_loyalty_url: 'https://ornek.local/sadakat' });
    const loy = await renderAll();
    assert.strictEqual(loy.doc.qr.data, 'https://ornek.local/sadakat');
    assert.ok(loy.thermal.includes('[karekod] https://ornek.local/sadakat'));
    assert.ok(!loy.thermal.includes('fis-testi-menu'), 'the menü address leaked into the sadakat karekod');

    // ---- serbest: the free text, even when the other two are filled in
    await setFis({ receipt_qr_mode: 'serbest', receipt_qr_text: 'WIFI:ORNEK;PASS:12345' });
    const free = await renderAll();
    assert.strictEqual(free.doc.qr.data, 'WIFI:ORNEK;PASS:12345');
    // free text is not an address, so the mail must not turn it into a link
    assert.ok(!free.html.includes('href="WIFI:'), 'free text was rendered as a hyperlink');
  });

  await step('a karekod mode with no address prints no square at all, and the screen says so', async () => {
    await setFis({ receipt_qr_mode: 'sadakat', receipt_qr_loyalty_url: '' });
    const r = await renderAll();
    assert.strictEqual(r.doc.qr, null, 'a karekod was built with nothing to point at');
    assert.ok(!r.thermal.includes('[karekod]'), 'an empty QR command went to the printer');
    assert.ok(!pdfHasImage(r.pdfFile), 'the PDF drew a QR of nothing');
    assert.ok(!r.html.includes('data:image/png'), 'the e-mail drew a QR of nothing');
    const g = await api('GET', '/api/receipt');
    assert.ok(g.qr_warning && /sadakat/i.test(g.qr_warning),
      'nothing on the screen says the karekod will not print: ' + g.qr_warning);
  });

  await step('turning the karekod off removes it from all three at once', async () => {
    await setFis({ receipt_qr_mode: 'kapali' });
    const r = await renderAll();
    assert.strictEqual(r.doc.qr, null);
    assert.ok(!r.thermal.includes('[karekod]'));
    assert.ok(!pdfHasImage(r.pdfFile));
    assert.ok(!r.html.includes('data:image/png'));
    const s = await api('GET', '/api/settings');
    assert.strictEqual(String(s.values.receipt_qr), '0', 'the old QR switch was left on');
  });

  await step('the karekod image really is a PNG, and it is small enough to sit in a mail', async () => {
    const png = docs.qrPng('https://ornek.local/menu');
    assert.ok(Buffer.isBuffer(png), 'no image was produced');
    assert.strictEqual(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'that is not a PNG');
    // width and height out of the IHDR, so a broken encoder cannot pass by
    // producing a valid header over a zero-sized picture
    assert.strictEqual(png.readUInt32BE(16), png.readUInt32BE(20), 'a QR is square');
    assert.ok(png.readUInt32BE(16) > 100, 'the square came out ' + png.readUInt32BE(16) + 'px');
    assert.ok(png.length < 20000, 'a ' + png.length + '-byte image is too big to inline in a mail');
    assert.strictEqual(docs.qrPng('https://ornek.local/menu'), png, 'the same square was encoded twice');
  });

  /* ============ THE ONE THAT MATTERS: NOTHING ELSE MOVED ============ */

  /*
   * Bytes captured from buildBill BEFORE the döviz line and the karekod
   * existed, for the sample bill at 80 mm with a fixed date, rendered through
   * the settings below.
   *
   * A restaurant that wants neither of these features must get the receipt it
   * got yesterday - not one that is "basically the same". Every other check in
   * this section proves the two features work; this one proves they cost
   * nothing to the tills that never switch them on, and it is a byte compare
   * because a line compare would not catch a changed ESC/POS attribute, a lost
   * bold, or an extra line feed.
   */
  const GOLDEN_B64 =
    'G0AbdA0bYQEbRQEdIRFGaXMgVGVzdCBMb2thbnRhc2kKHSEAG0UAG0UBT3JuZWsgTG9rYW50YQpCYWdkYXQgQ2Fk' +
    'LiBObyAxMgobRQAbYQA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KG2EB' +
    'G0UBQURJU1lPTgobRQAbYQAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0K' +
    'QWRpc3lvbjogT1JORUsgICAgICAgICAgICAgICAgICAxNS4wMS4yMDI2IDE5OjMwCk1hc2E6IE1hc2EgNSAgICAg' +
    'ICAgICAgICAgICAgICAgICAgR2Fyc29uOiBBaG1ldAotLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
    'LS0tLS0tLS0tLS0tLS0KMiAgIEFkYW5hIEtlYmFwICAgICAgICAgICAgICAgICAgICAgICAgICAgODQwLDAwCjEg' +
    'ICBBeXJhbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA0NSwwMAoxICAgRWZlcyBQaWxzZW4gICAg' +
    'ICAgICAgICAgICAgICAgICAgICAgICAxODAsMDAKICAgIHNvpnVrCi0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
    'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLQpBcmEgVG9wbGFtICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgMS4w' +
    'NjUsMDAKG0UBHSERVE9QTEFNICAgICAgICAgIDEuMDY1LDAwCh0hABtFAC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
    'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLQpLRFYgJTEwIChkYWhpbCkgICAgICAgICAgICAgICAgICAgICAgICAg' +
    'ICAgODAsNDUKS0RWICUyMCAoZGFoaWwpICAgICAgICAgICAgICAgICAgICAgICAgICAgIDMwLDAwCj09PT09PT09' +
    'PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQobYQFJbnN0YWdyYW06IEBvcm5la3Rlc3QK' +
    'G0UBWWluZSBiZWtsZXJpegobRQAbYQAbZAQdVkIA';

  await step('with both switched off the receipt is byte-for-byte the one printed before this change', async () => {
    const printing = require('../src/print');
    /* the same draft the golden was captured through - PATCH with the QR off,
       plus the two new keys explicitly off. The new keys did not exist when
       the golden was taken and were ignored then; they are honoured now, and
       the bytes have to come out the same either way. */
    const GOLD = { ...PATCH, receipt_qr: '0', receipt_show_fx: '0',
      receipt_qr_mode: 'kapali', receipt_fx_currencies: '' };
    const order = { ...mod.sampleOrder(), opened_at: '2026-01-15 19:30:00' };
    const bytes = await printing.buildBill(CID, order,
      { width: 48, showPayments: false, receiptOptions: await mod.options(CID, GOLD) });
    const before = Buffer.from(GOLDEN_B64, 'base64');
    if (!bytes.equals(before)) {
      // say WHERE it diverged; "buffers differ" is not a bug report
      const a = decode(before).map(l => l.text), b = decode(bytes).map(l => l.text);
      const i = a.findIndex((l, n) => l !== b[n]);
      throw new Error(`the receipt changed with both features off. First difference at line ${i}:\n` +
        `  before: ${JSON.stringify(a[i])}\n  now:    ${JSON.stringify(b[i])}\n` +
        `  (${before.length} bytes before, ${bytes.length} now)`);
    }
    assert.ok(bytes.equals(before));
  });

  /* ========================= 6. YETKİ ================================ */

  await step('a waiter cannot open or change the receipt settings', async () => {
    const a = await api('GET', '/api/receipt', null, WAITER_TOKEN);
    assert.strictEqual(a.status, 403, 'a waiter read the receipt settings');
    const b = await api('POST', '/api/receipt', { settings: { receipt_title: 'HACK' } }, WAITER_TOKEN);
    assert.strictEqual(b.status, 403, 'a waiter changed the receipt settings');
    const c = await api('GET', '/api/receipt/display', null, null);
    assert.strictEqual(c.status, 401, 'the display settings are readable with no token at all');
  });

  /* ================================ results ========================= */
  await restore(snap);
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
