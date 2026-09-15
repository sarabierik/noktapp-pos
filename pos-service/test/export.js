'use strict';
/**
 * Rapor dışa aktarma: CSV, Excel, PDF.
 *
 * The two things an owner reported, proved against a real MariaDB and the real
 * HTTP service with nothing mocked:
 *
 *   - "CSV is not loading properly". It did not download at all - the till
 *     opened a window at the export URL and the browser rendered the text - and
 *     it carried the session token on the QUERY STRING, so a live bearer token
 *     went into the browser history and into every access log. Half the
 *     exports were also unreadable in a Turkish Excel: quoted cells, "1234.56"
 *     for money and "2026-09-01" for a date all open as one column of text.
 *   - "make sure the report has PDF export as well, and it's Muhasebe safe".
 *     A PDF an accountant can file has to name the taxpayer, say exactly which
 *     days it covers, break the KDV down PER RATE in figures that add up to the
 *     report's own total, say what is left out, and number its pages.
 *
 * So this suite proves, against real bills: the token is gone and the header
 * works; the CSV opens in a Turkish Excel; the PDF is a real PDF carrying the
 * VKN, the date range and the KDV split; matrah + KDV = brüt = the report
 * total, to the kuruş; and a cancelled bill is in neither file.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/export.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7473';
const zlib = require('zlib');
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
const VKN = '9876543210';
const UNVAN = 'Yıldız Gıda Turizm Ltd. Şti.';
const VD = 'Alanya Vergi Dairesi';
let OWNER = null;

async function api(method, path, body, token = OWNER) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}
/** A download exactly as the till now does it: the header, never the URL. */
async function grab(path, token = OWNER) {
  const res = await fetch(BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

const dayOf = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const D1 = dayOf(5), D2 = dayOf(4), D3 = dayOf(3), TODAY = dayOf(0);
const dmy = (iso) => iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);
/** 1234,56 - a CSV cell: comma decimals, no grouping, because Excel groups. */
const csvMoney = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2).replace('.', ',');
/** 1.234,56 - the same money printed on a page, where a human reads it. */
const pdfMoney = (n) => {
  const [a, b] = csvMoney(n).split(',');
  return a.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + b;
};

/* ------------------------------------------------------- pdf as text */
/*
 * Enough of a PDF reader to check what is on the page.
 *
 * PDFKit compresses each page's content stream with Flate and writes the text
 * as hex strings inside a TJ array - `[<59696c64...> 100 <54>] TJ` - so the
 * words are not visible in the raw bytes and grepping the file proves nothing.
 * Inflating the stream and decoding the hex is 20 lines and needs no external
 * binary, which matters: this suite has to run on a machine with no pdftotext.
 */
function pdfText(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;
    let c;
    try { c = zlib.inflateSync(Buffer.from(s.slice(start, end), 'latin1')).toString('latin1'); }
    catch (_) { continue; }                       // not a compressed content stream
    if (!c.includes('BT')) continue;
    for (const t of c.match(/\[[^\]]*\]\s*TJ|\([^)]*\)\s*Tj/g) || []) {
      let piece = '';
      for (const h of t.match(/<([0-9A-Fa-f]+)>/g) || []) {
        piece += Buffer.from(h.slice(1, -1), 'hex').toString('latin1');
      }
      for (const l of t.match(/\(([^)]*)\)/g) || []) piece += l.slice(1, -1);
      out.push(piece);
    }
  }
  return out.join('\n');
}

/* ------------------------------------------------------------ fixture */
let P = {}, TABLE = null, UID = null;

async function fixture() {
  for (const sql of [
    'DELETE FROM order_discounts WHERE client_id=?',
    'DELETE FROM order_item_cancel_events WHERE client_id=?',
    'DELETE FROM order_items WHERE client_id=?',
    'DELETE FROM order_payments WHERE client_id=?',
    'DELETE FROM payment_delete_logs WHERE client_id=?',
    'DELETE FROM order_delete_logs WHERE client_id=?',
    'DELETE FROM orders WHERE client_id=?',
    'DELETE FROM products WHERE client_id=?',
    'DELETE FROM categories WHERE client_id=?',
    'DELETE FROM daily_costs WHERE client_id=?',
    'DELETE FROM daily_closings WHERE client_id=?',
    'DELETE FROM finance_daily_snapshots WHERE client_id=?',
  ]) await db.exec(sql, [CID]).catch(() => {});

  // the legal identity every report PDF has to carry
  await db.exec('DELETE FROM business_settings WHERE client_id=?', [CID]);
  await db.exec(
    `INSERT INTO business_settings (client_id, business_name, legal_name, tax_number, tax_office,
        address_line1, city, phone, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())`,
    [CID, 'Yıldız Restaurant', UNVAN, VKN, VD, 'Şekerhane Mah. Atatürk Cad. No:12', 'Alanya', '0242 000 00 00']);

  const cat = await db.insert(
    'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,1,1,1,1)',
    [CID, 'Yemekler']);
  const drinks = await db.insert(
    'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,2,1,1,1)',
    [CID, 'İçecekler']);
  const mk = (c, n, price, cost, vat) => db.insert(
    `INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,sort_order,
        is_active,use_in_pos,use_in_qr,track_stock) VALUES (?,?,?,?,?,?,0,1,1,1,0)`,
    [CID, c, n, price, cost, vat]);
  P = {
    kebap: await mk(cat, 'Adana Kebap', 400, 150, 10),      // %10
    bira: await mk(drinks, 'Efes Pilsen', 180, 70, 20),     // %20
    // priced so its bill total appears nowhere else: if 777,77 shows up in an
    // export, the cancelled bill leaked into it
    hayalet: await mk(cat, 'İptal Testi', 777.77, 100, 10),
  };

  const NAME = 'Export Test Masasi';
  const existing = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? AND name=?', [CID, NAME]);
  if (existing) TABLE = existing.id;
  else {
    const zone = await db.one('SELECT id FROM table_zones WHERE client_id=? LIMIT 1', [CID]);
    const zoneId = zone ? zone.id : await db.insert(
      'INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']);
    TABLE = await db.insert(
      'INSERT INTO restaurant_tables (client_id,zone_id,name,sort_order,is_active) VALUES (?,?,?,97,1)',
      [CID, zoneId, NAME]);
  }
}

/** A bill rung up through the real till API, paid in full, then dated. */
async function bill(date, method, lines, discount = 0) {
  const o = await api('POST', '/api/pos/orders', { table_id: TABLE });
  if (!o.order_id) throw new Error('adisyon acilamadi: ' + JSON.stringify(o));
  for (const [product, qty] of lines) {
    const a = await api('POST', `/api/pos/orders/${o.order_id}/items`, { product_id: product, qty });
    if (a.status !== 200) throw new Error('kalem eklenemedi: ' + JSON.stringify(a));
  }
  if (discount > 0) {
    await api('POST', `/api/pos/orders/${o.order_id}/discount`, { type: 'amount', value: discount });
  }
  const full = (await api('GET', `/api/pos/orders/${o.order_id}`)).order;
  const p = await api('POST', `/api/pos/orders/${o.order_id}/payments`,
    { method, amount: Number(full.grand_total) });
  if (p.status !== 200) throw new Error('odeme alinamadi: ' + JSON.stringify(p));
  if (date !== TODAY) {
    await db.exec("UPDATE orders SET business_date=?, closed_at=CONCAT(?, ' 20:00:00') WHERE id=?",
      [date, date, o.order_id]);
    await db.exec("UPDATE order_payments SET created_at=CONCAT(?, ' 20:00:00') WHERE order_id=?",
      [date, o.order_id]);
  }
  return { id: o.order_id, total: Number(full.grand_total) };
}

/* Every report that can be exported, on both routes. */
const FINANCE_KINDS = ['transactions', 'days', 'products', 'categories', 'payments',
  'discounts', 'cancellations', 'daily', 'report'];
const REPORT_KINDS = ['sales', 'products', 'waiters', 'pnl', 'pnl-products', 'pnl-categories'];

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - rapor disa aktarma: CSV, Excel, PDF\n');

  const catalog = require('../src/modules/catalog');
  await db.exec('DELETE FROM users WHERE client_id=? AND username=?', [CID, 'raporcu']);
  UID = await catalog.saveUser(CID, {
    display_name: 'Rapor Testçi', username: 'raporcu', role: 'admin', pin: '4471', password: 'test1234',
  }, null);
  OWNER = await auth.issueToken({ cid: CID, uid: UID, role: 'admin', name: 'Ayşe Yıldız', kind: 'tenant' });

  await fixture();
  const b1 = await bill(D1, 'nakit', [[P.kebap, 1]]);                    // 400 @ %10
  const b2 = await bill(D1, 'kredi_karti', [[P.bira, 2]]);               // 360 @ %20
  const b3 = await bill(D2, 'nakit', [[P.kebap, 2], [P.bira, 1]], 80);   // karışık, 80 indirimli
  const b4 = await bill(D3, 'kredi_karti', [[P.kebap, 1]]);              // 400 @ %10
  const dead = await bill(D2, 'nakit', [[P.hayalet, 1]]);                // 777,77 - iptal edilecek
  const del = await api('POST', '/api/finance/transactions/delete', { ids: [dead.id], reason: 'test' });
  if (del.status !== 200) throw new Error('iptal edilemedi: ' + JSON.stringify(del));

  const RANGE = `from=${D1}&to=${TODAY}`;
  const pnl = require('../src/modules/pnl');
  const reportsMod = require('../src/modules/reports');

  /* ===================== A. the token is off the URL ================= */
  await step('dışa aktarma yetkisiz erişimi reddediyor', async () => {
    const res = await fetch(`${BASE}/api/reports/export/sales?${RANGE}`);
    assert.strictEqual(res.status, 401, 'token yokken 401 bekleniyordu, gelen: ' + res.status);
  });

  await step('sorgu dizisindeki token artık kabul edilmiyor', async () => {
    // this is what the browser used to open, and what put a live bearer token
    // into the address bar, the history and every log on the way
    const res = await fetch(
      `${BASE}/api/reports/export/sales?${RANGE}&token=${encodeURIComponent(OWNER)}`);
    assert.strictEqual(res.status, 401, '?token= hâlâ çalışıyor: ' + res.status);
    const res2 = await fetch(
      `${BASE}/api/finance/export/daily?${RANGE}&token=${encodeURIComponent(OWNER)}`);
    assert.strictEqual(res2.status, 401, 'finans tarafında ?token= hâlâ çalışıyor: ' + res2.status);
  });

  await step('Authorization başlığıyla indirme çalışıyor ve dosya olarak iniyor', async () => {
    for (const k of REPORT_KINDS) {
      const r = await grab(`/api/reports/export/${k}?${RANGE}`);
      assert.strictEqual(r.status, 200, k + ' -> ' + r.status);
      const cd = String(r.headers.get('content-disposition') || '');
      assert.ok(cd.includes('attachment'), k + ': attachment yok, tarayıcı dosyayı kaydetmez');
      assert.ok(/filename="[^"]+\.csv"/.test(cd), k + ': dosya adı yok -> ' + cd);
      assert.ok(String(r.headers.get('content-type')).startsWith('text/csv'), k + ': tip yanlış');
    }
  });

  /* ===================== B. the CSV a Turkish Excel can open ========= */
  await step('CSV BOM, noktalı virgül ve virgüllü ondalık taşıyor', async () => {
    for (const k of [...REPORT_KINDS.map(x => '/api/reports/export/' + x),
      ...FINANCE_KINDS.map(x => '/api/finance/export/' + x)]) {
      const r = await grab(`${k}?${RANGE}`);
      assert.strictEqual(r.status, 200, k + ' -> ' + r.status);
      const text = r.buf.toString('utf8');
      assert.strictEqual(text.charCodeAt(0), 0xFEFF, k + ': BOM yok, Excel ç/ğ/ş/ı harflerini bozar');
      assert.ok(text.includes(';'), k + ': ayraç noktalı virgül değil');
      assert.ok(!/\d+\.\d{2}(;|\r|$)/m.test(text),
        k + ': ondalık ayraç nokta kalmış, Türkçe Excel bunu metin okur');
    }
  });

  await step('CSV para virgüllü, tarih GG.AA.YYYY yazıyor', async () => {
    const text = (await grab(`/api/reports/export/sales?${RANGE}`)).buf.toString('utf8');
    assert.ok(text.includes(dmy(D1)), 'tarih GG.AA.YYYY değil, ISO kalmış: ' + text.split('\r\n')[1]);
    assert.ok(!text.includes(D1), 'ISO tarih hâlâ CSV içinde: ' + D1);
    assert.ok(text.includes(csvMoney(400)), '400,00 CSV içinde yok');
    const fin = (await grab(`/api/finance/export/transactions?${RANGE}`)).buf.toString('utf8');
    assert.ok(new RegExp('\\d{2}\\.\\d{2}\\.\\d{4} \\d{2}:\\d{2}').test(fin),
      'kapanış saati GG.AA.YYYY SS:DD değil');
  });

  await step('CSV Türkçe başlıkları bozulmadan taşıyor', async () => {
    const text = (await grab(`/api/reports/export/products?${RANGE}`)).buf.toString('utf8');
    assert.ok(text.includes('Ürün') && text.includes('Ciro (KDV dahil)'), 'başlıklar bozulmuş');
    assert.ok(text.includes('Adana Kebap'), 'ürün adı yok');
  });

  /* ===================== C. the PDF exists and is a PDF ============== */
  await step('her rapor PDF olarak da iniyor ve gerçek bir PDF', async () => {
    for (const k of [...REPORT_KINDS.map(x => '/api/reports/export/' + x),
      ...FINANCE_KINDS.map(x => '/api/finance/export/' + x)]) {
      const r = await grab(`${k}?${RANGE}&format=pdf`);
      assert.strictEqual(r.status, 200, k + ' -> ' + r.status);
      assert.strictEqual(r.buf.slice(0, 4).toString(), '%PDF', k + ': PDF değil');
      assert.ok(r.buf.length > 3000, k + ': PDF çok küçük (' + r.buf.length + " bayt) - boş sayfa olabilir");
      const cd = String(r.headers.get('content-disposition') || '');
      assert.ok(cd.includes('attachment') && cd.includes('.pdf'), k + ': indirme başlığı yanlış -> ' + cd);
      assert.strictEqual(r.headers.get('content-type'), 'application/pdf', k + ': tip yanlış');
    }
  });

  await step('gün raporu tek tarih için de PDF veriyor', async () => {
    const r = await grab(`/api/finance/export/day?date=${D2}&format=pdf`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.buf.slice(0, 4).toString(), '%PDF');
    const t = pdfText(r.buf);
    assert.ok(t.includes(dmy(D2)), 'gün raporunda tarih yok');
  });

  /* ===================== D. muhasebe safe =========================== */
  await step('PDF işletmenin kimliğini taşıyor: unvan, VKN, vergi dairesi, adres', async () => {
    const t = pdfText((await grab(`/api/reports/export/pnl?${RANGE}&format=pdf`)).buf);
    assert.ok(t.includes(VKN), 'VKN/TCKN sayfada yok');
    assert.ok(t.includes('Yildiz Gida Turizm'), 'unvan sayfada yok');
    assert.ok(t.includes('Alanya Vergi Dairesi'), 'vergi dairesi sayfada yok');
    assert.ok(t.includes('Sekerhane'), 'adres sayfada yok');
  });

  await step('PDF ne olduğunu, hangi günleri kapsadığını ve iş günü kuralını yazıyor', async () => {
    const t = pdfText((await grab(`/api/reports/export/pnl?${RANGE}&format=pdf`)).buf);
    assert.ok(t.includes('Kar / Zarar raporu'), 'rapor adı yok');
    assert.ok(t.includes(dmy(D1)) && t.includes(dmy(TODAY)),
      'tarih aralığı yok: ' + dmy(D1) + ' - ' + dmy(TODAY));
    assert.ok(/Is gunu \d{2}:\d{2}/.test(t), 'iş günü kuralı yazılmamış');
    assert.ok(/Duzenleme: \d{2}\.\d{2}\.\d{4}/.test(t), 'düzenleme tarihi yok');
    assert.ok(t.includes('Ayse Yildiz'), 'düzenleyen yazılmamış');
  });

  await step('PDF neyin dışarıda bırakıldığını Türkçe olarak söylüyor', async () => {
    const t = pdfText((await grab(`/api/finance/export/daily?${RANGE}&format=pdf`)).buf);
    assert.ok(t.includes('Iptal edilen') && t.includes('dahil DEGILDIR'),
      'iptal/rapor dışı açıklaması yok');
  });

  await step('PDF sayfa numaralarını taşıyor', async () => {
    const t = pdfText((await grab(`/api/finance/export/transactions?${RANGE}&format=pdf`)).buf);
    const m = t.match(/Sayfa (\d+) \/ (\d+)/);
    assert.ok(m, '"Sayfa 1 / N" yok');
    assert.strictEqual(m[1], '1', 'ilk sayfa 1 değil');
    assert.ok(Number(m[2]) >= 1, 'toplam sayfa sayısı yok');
  });

  await step('PDF ödeme dağılımını taşıyor', async () => {
    const t = pdfText((await grab(`/api/finance/export/report?${RANGE}&format=pdf`)).buf);
    assert.ok(t.includes('Odeme dagilimi'), 'ödeme bölümü yok');
    assert.ok(t.includes('Nakit') && t.includes('Kredi karti'), 'ödeme yöntemleri yok');
  });

  await step('PDF her tablonun altında TOPLAM satırı veriyor', async () => {
    const t = pdfText((await grab(`/api/reports/export/sales?${RANGE}&format=pdf`)).buf);
    assert.ok(t.includes('TOPLAM'), 'toplam satırı yok - muhasebeci sütunu kendi toplayamamalı');
  });

  /* ===================== E. the arithmetic ========================== */
  await step('KDV dökümü orana göre: matrah + KDV = brüt, kuruşu kuruşuna', async () => {
    const v = await reportsMod.vatRange(CID, D1, TODAY);
    assert.ok(v.rows.length >= 2, 'iki KDV oranı bekleniyordu, gelen: ' + v.rows.length);
    for (const r of v.rows) {
      assert.strictEqual(Math.round((r.base + r.vat) * 100), Math.round(r.gross * 100),
        `%${r.rate}: matrah ${r.base} + KDV ${r.vat} != brüt ${r.gross}`);
      // Türk KDV'si fiyata DAHİLDİR: vat = brüt * oran / (100 + oran)
      const want = Math.round(r.gross * r.rate / (100 + r.rate) * 100);
      assert.ok(Math.abs(want - Math.round(r.vat * 100)) <= r.rate,
        `%${r.rate}: KDV ${r.vat}, dahil hesapla ${want / 100} olmalıydı`);
    }
  });

  await step('KDV dökümünün brüt toplamı rapor toplamına eşit', async () => {
    const v = await reportsMod.vatRange(CID, D1, TODAY);
    const T = (await pnl.profitAndLoss(CID, D1, TODAY)).totals;
    assert.strictEqual(Math.round(v.gross * 100), Math.round(T.revenue_gross * 100),
      `KDV dökümü ${v.gross}, rapor cirosu ${T.revenue_gross}`);
    assert.strictEqual(Math.round(v.rows.reduce((s, r) => s + r.vat, 0) * 100),
      Math.round(v.total * 100), 'oran bazlı KDV toplamı genel KDV ile uyuşmuyor');
  });

  await step('PDF üzerindeki KDV rakamları hesaplananın aynısı', async () => {
    const v = await reportsMod.vatRange(CID, D1, TODAY);
    const t = pdfText((await grab(`/api/reports/export/pnl?${RANGE}&format=pdf`)).buf);
    assert.ok(t.includes('KDV dokumu'), 'KDV bölümü yok');
    for (const r of v.rows) {
      assert.ok(t.includes('%' + r.rate), 'oran satırı yok: %' + r.rate);
      assert.ok(t.includes(pdfMoney(r.base)), `%${r.rate} matrahı sayfada yok: ${pdfMoney(r.base)}`);
      assert.ok(t.includes(pdfMoney(r.vat)), `%${r.rate} KDV'si sayfada yok: ${pdfMoney(r.vat)}`);
      assert.ok(t.includes(pdfMoney(r.gross)), `%${r.rate} brütü sayfada yok: ${pdfMoney(r.gross)}`);
    }
    assert.ok(t.includes(pdfMoney(v.gross)), 'KDV brüt toplamı sayfada yok: ' + pdfMoney(v.gross));
  });

  await step('indirim KDV\'yi de düşürüyor - matrah indirimden sonra', async () => {
    // b3 is 80 TL off a mixed-rate bill; the tax has to come off with it, or
    // the restaurant declares tax on money it never took
    const v = await reportsMod.vatRange(CID, D2, D2);
    const T = (await pnl.profitAndLoss(CID, D2, D2)).totals;
    assert.strictEqual(Math.round(v.gross * 100), Math.round(T.revenue_gross * 100),
      'indirimli günde KDV dökümü ciroyla uyuşmuyor');
    assert.ok(v.total < 980 * 0.2, 'KDV indirim öncesi tutardan hesaplanmış görünüyor');
  });

  /* ===================== F. what must not be in there =============== */
  await step('iptal edilen adisyon hiçbir tabloya ve hiçbir toplama girmiyor', async () => {
    const ghost = csvMoney(dead.total);                      // 777,77
    for (const k of ['/api/reports/export/sales', '/api/reports/export/pnl',
      '/api/finance/export/daily', '/api/finance/export/report']) {
      const csv = (await grab(`${k}?${RANGE}`)).buf.toString('utf8');
      assert.ok(!csv.includes('İptal Testi'), k + ' CSV iptal edilen ürünü taşıyor');
      for (const line of csv.split('\r\n')) {
        if (!line.includes(ghost)) continue;
        assert.ok(/İptal/.test(line), k + ' CSV iptal edilen adisyonu bir rakama katmış: ' + line);
      }
      const t = pdfText((await grab(`${k}?${RANGE}&format=pdf`)).buf);
      assert.ok(!t.includes('Iptal Testi'), k + ' PDF iptal edilen ürünü taşıyor');
      /*
       * The figure may appear on the page exactly once, on the line that says
       * it is EXCLUDED - an accountant is entitled to know how much was
       * voided. Anywhere else and it has leaked into the report.
       */
      const lines = t.split('\n');
      lines.forEach((line, i) => {
        if (!line.includes(pdfMoney(dead.total))) return;
        assert.ok(i > 0 && /Iptal/.test(lines[i - 1]),
          k + ' PDF iptal edilen adisyonu rakamlarına katmış: ' + line);
      });
    }
  });

  await step('PDF iptal edilen tutarı ayrıca ve hariç olduğunu söyleyerek gösteriyor', async () => {
    const t = pdfText((await grab(`/api/finance/export/report?${RANGE}&format=pdf`)).buf);
    assert.ok(t.includes('Iptal / rapor disi'), 'iptal satırı özet bloğunda yok');
    assert.ok(t.includes(pdfMoney(dead.total)), 'iptal tutarı yazılmamış');
  });

  await step('iptal edilen adisyon ciroya ve KDV\'ye de girmiyor', async () => {
    const T = (await pnl.profitAndLoss(CID, D1, TODAY)).totals;
    const expect = b1.total + b2.total + b3.total + b4.total;
    assert.strictEqual(Math.round(T.revenue_gross * 100), Math.round(expect * 100),
      'ciro ' + T.revenue_gross + ', iptal hariç beklenen ' + expect);
    const v = await reportsMod.vatRange(CID, D1, TODAY);
    assert.strictEqual(Math.round(v.gross * 100), Math.round(expect * 100),
      'KDV dökümü iptal edilen adisyonu içeriyor');
  });

  await step('iptal raporu ise onu göstermeye devam ediyor', async () => {
    // the one report that is ABOUT the cancellations still lists it, otherwise
    // an owner cannot see what was voided
    const csv = (await grab(`/api/finance/export/cancellations?${RANGE}`)).buf.toString('utf8');
    assert.ok(csv.includes(csvMoney(dead.total)), 'iptal raporunda iptal edilen adisyon yok');
  });

  /* ===================== G. the till's own download helper ========== */
  /*
   * The real helper out of public/screens.js, run against the real service.
   * The bug the owner reported was on this side of the wire - window.open
   * rendered the CSV instead of saving it - so a server that answers correctly
   * proves only half of it.
   */
  await step('indirme yardımcısı başlıkla çekiyor, dosyayı kaydediyor, düğmeyi kilitliyor', async () => {
    const fs = require('fs');
    const vm = require('vm');
    const saved = [];
    const revoked = [];
    const btn = { nodeType: 1, disabled: false, textContent: 'CSV' };
    const anchor = { click() { saved.push({ href: this.href, name: this.download }); }, remove() {} };
    const ctx = {
      App: { token: OWNER }, $: () => ({}), $$: () => [],
      registerIcon() {}, registerPage() {}, toast() {}, err(e) { throw e; },
      lock() { throw new Error('kilitlendi'); },
      fetch: (path, opt) => fetch(BASE + path, opt),
      URL: {
        createObjectURL: () => 'blob:sahte-' + saved.length,
        revokeObjectURL: (u) => revoked.push(u),
      },
      document: { createElement: () => anchor, body: { appendChild() {} }, addEventListener() {} },
      setTimeout, clearTimeout, console,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    /* Only the helper is lifted out: the rest of screens.js touches a DOM that
       does not exist here, and this check is about the download, not the page. */
    const src = fs.readFileSync(__dirname + '/../public/screens.js', 'utf8');
    const from = src.indexOf('  downloadName(res, path) {');
    const to = src.indexOf('\n  },', src.indexOf('finally { if (el)', from)) + 4;
    assert.ok(from > 0 && to > from, 'indirme yardımcısı screens.js içinde bulunamadı');
    vm.runInContext('var Screens = {\n' + src.slice(from, to) + '\n};', ctx, { filename: 'screens.js' });

    await ctx.Screens.download(`/api/finance/export/days?${RANGE}`, btn);
    assert.strictEqual(saved.length, 1, 'dosya kaydedilmedi');
    assert.ok(saved[0].href.startsWith('blob:'), 'blob yerine adres açılmış: ' + saved[0].href);
    assert.ok(/^gun-sonu-.*\.csv$/.test(saved[0].name), 'dosya adı yanlış: ' + saved[0].name);
    assert.strictEqual(btn.disabled, false, 'düğme açık bırakılmadı');
    assert.strictEqual(btn.textContent, 'CSV', 'düğme yazısı geri gelmedi');

    await ctx.Screens.download(`/api/finance/export/days?${RANGE}&format=pdf`, btn);
    assert.strictEqual(saved.length, 2, 'PDF kaydedilmedi');
    assert.ok(/\.pdf$/.test(saved[1].name), 'PDF dosya adı yanlış: ' + saved[1].name);

    // a hung export must not be firable twice by a double tap
    btn.disabled = true;
    await ctx.Screens.download(`/api/finance/export/days?${RANGE}`, btn);
    assert.strictEqual(saved.length, 2, 'kilitli düğme ikinci indirmeyi başlattı');
    btn.disabled = false;

    /* The object URL is freed on a timer, not in the same tick: the click only
       STARTS the save and the browser reads the blob afterwards, so revoking
       straight away cancels the download. */
    assert.strictEqual(revoked.length, 0, 'blob adresi hemen serbest bırakılmış, indirme iptal olur');
  });

  await step('indirme başarısız olunca sunucunun mesajı gösteriliyor', async () => {
    const fs = require('fs');
    const vm = require('vm');
    let toasted = null;
    const ctx = {
      App: { token: OWNER }, $: () => ({}), $$: () => [],
      registerIcon() {}, registerPage() {}, toast() {},
      err(e) { toasted = e.message; },
      lock() {}, fetch: (path, opt) => fetch(BASE + path, opt),
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } },
      setTimeout, clearTimeout, console,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    const src = fs.readFileSync(__dirname + '/../public/screens.js', 'utf8');
    const from = src.indexOf('  downloadName(res, path) {');
    const to = src.indexOf('\n  },', src.indexOf('finally { if (el)', from)) + 4;
    vm.runInContext('var Screens = {\n' + src.slice(from, to) + '\n};', ctx, { filename: 'screens.js' });
    await ctx.Screens.download('/api/finance/export/olmayan?' + RANGE, null);
    assert.ok(toasted && /rapor/i.test(toasted),
      'boş pencere yerine sunucunun hatası gösterilmeli, gelen: ' + toasted);
  });

  /* ===================== H. Excel still works ======================= */
  await step('Excel çıktısı hâlâ çalışıyor ve sayfalarını taşıyor', async () => {
    const r = await grab(`/api/finance/export/report?${RANGE}&format=xlsx`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.buf.slice(0, 2).toString(), 'PK', 'zip değil, yani xlsx değil');
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buf);
    assert.ok(wb.worksheets.map(w => w.name).includes('Özet'), 'Özet sayfası yok');
  });

  await step('bilinmeyen rapor PDF olarak da 404 dönüyor', async () => {
    const a = await grab(`/api/reports/export/olmayan?${RANGE}&format=pdf`);
    assert.strictEqual(a.status, 404, 'gelen: ' + a.status);
    const b = await grab(`/api/finance/export/olmayan?${RANGE}&format=pdf`);
    assert.strictEqual(b.status, 404, 'gelen: ' + b.status);
  });

  /* ================================= results ============================ */
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
