'use strict';
/*
 * Screenshots of the three new e-belge screens, taken against real rows.
 *
 * The point is not that a page renders: it is that the numbers on the invoice
 * screen are the SAME numbers as the bill's, that an ikram line shows at 0,00
 * instead of vanishing, and that a document whose outcome is unknown says so
 * in words a cashier can act on. None of that survives a mock, so the fixtures
 * here are a real closed bill, a real ÖKC receipt, and a fake QNB that answers
 * the way QNB's test environment answered on 29.09.2026.
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7494';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const E = require('../src/ebelge');
const F = require('../src/ebelge/fatura');
const { bootstrap } = require('../src/index');
const { tarayiciAc } = require('./tarayici');
const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
const OUT = process.env.SHOT_OUT || '/home/claude/fatura-onizleme';
const CTX = { clientId: CID, userId: 1, role: 'admin' };

const zarf = (g) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"'
  + ' xmlns:ns2="http://service.connector.uut.cs.com.tr/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
  + '<soapenv:Body>' + g + '</soapenv:Body></soapenv:Envelope>';
const zip = (buf, ad) => {
  const zlib = require('zlib');
  const ham = zlib.deflateRawSync(buf);
  let c = ~0; for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  const crc = ~c >>> 0;
  const n = Buffer.from(ad, 'utf8'); const y = Buffer.alloc(30);
  y.writeUInt32LE(0x04034b50, 0); y.writeUInt16LE(20, 4); y.writeUInt16LE(8, 8);
  y.writeUInt32LE(crc, 14); y.writeUInt32LE(ham.length, 18); y.writeUInt32LE(buf.length, 22);
  y.writeUInt16LE(n.length, 26);
  return Buffer.concat([y, n, ham]);
};
const GELEN_UBL = '<Invoice><cac:InvoiceLine><cbc:InvoicedQuantity unitCode="KGM">25</cbc:InvoicedQuantity>'
  + '<cbc:LineExtensionAmount currencyID="TRY">1250.00</cbc:LineExtensionAmount>'
  + '<cac:TaxSubtotal><cbc:TaxAmount currencyID="TRY">250.00</cbc:TaxAmount><cbc:Percent>20</cbc:Percent></cac:TaxSubtotal>'
  + '<cac:Item><cbc:Name>Ayçiçek yağı 18 lt</cbc:Name></cac:Item>'
  + '<cac:Price><cbc:PriceAmount currencyID="TRY">50.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine>'
  + '<cac:InvoiceLine><cbc:InvoicedQuantity unitCode="KGM">50</cbc:InvoicedQuantity>'
  + '<cbc:LineExtensionAmount currencyID="TRY">900.00</cbc:LineExtensionAmount>'
  + '<cac:TaxSubtotal><cbc:TaxAmount currencyID="TRY">180.00</cbc:TaxAmount><cbc:Percent>20</cbc:Percent></cac:TaxSubtotal>'
  + '<cac:Item><cbc:Name>Un 25 kg (çuval)</cbc:Name></cac:Item>'
  + '<cac:Price><cbc:PriceAmount currencyID="TRY">18.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine></Invoice>';

let sayac = 0;
const belgeler = new Map();
const GELENLER = [
  { no: 'ATL2026000004411', tarih: '20260926', ettn: '7C3A1F20-1111-4E2A-9C31-A1B2C3D4E5F6', senaryo: 'TICARIFATURA', kim: 'Atlas Gıda Toptan Ltd. Şti.', vkn: '4780216355', tutar: '2580.00' },
  { no: 'MRT2026000000912', tarih: '20260924', ettn: '9D4B2E31-2222-4F3B-8D42-B2C3D4E5F607', senaryo: 'TEMELFATURA', kim: 'Meriç Et ve Süt Ürünleri A.Ş.', vkn: '3120584799', tutar: '4160.00' },
];

function qnb() {
  return http.createServer((req, res) => {
    const p = []; req.on('data', (c) => p.push(c));
    req.on('end', () => {
      const govde = Buffer.concat(p).toString('utf8');
      const op = (/<soapenv:Body><ser:([a-zA-Z]+)/.exec(govde) || [])[1] || '?';
      let inp = {}; const im = /<input>([\s\S]*?)<\/input>/.exec(govde);
      if (im) { try { inp = JSON.parse(im[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch (e) { inp = {}; } }
      const ver = (g) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(g); };
      if (op === 'efaturaKullaniciBilgisi') {
        const vkn = (/<vergiTcKimlikNo>(\d+)</.exec(govde) || [])[1];
        if (vkn !== '4780216355') return ver(zarf('<ns2:r/>'));
        return ver(zarf('<ns2:r><return><etiket>urn:mail:defaultpk@atlasgida.com.tr</etiket>'
          + '<kayitZamani>20190301</kayitZamani><unvan>Atlas Gıda Toptan Ltd. Şti.</unvan></return></ns2:r>'));
      }
      if (op === 'efaturaKullanicisi') return ver(zarf('<ns2:r><return>false</return></ns2:r>'));
      if (op === 'faturaOlusturExt') {
        let b = belgeler.get(inp.islemId);
        if (!b) { b = { no: 'EAA2026' + String(++sayac).padStart(9, '0'), uuid: inp.islemId }; belgeler.set(inp.islemId, b); }
        return ver(zarf('<ns2:r><return><resultCode>AE00000</resultCode><resultText>İşlem başarılı.</resultText>'
          + '<resultExtra><entry><key>faturaNo</key><value>' + b.no + '</value></entry>'
          + '<entry><key>uuid</key><value>' + b.uuid + '</value></entry>'
          + '<entry><key>faturaURL</key><value>https://earsivtest.qnbesolutions.com.tr/goruntule.jsp?uuid=' + b.uuid + '</value></entry>'
          + '</resultExtra></return></ns2:r>'));
      }
      if (op === 'belgeGonderExt') return ver(zarf('<ns2:r><return><belgeOid>0vmugxg41u15si</belgeOid></return></ns2:r>'));
      if (op === 'gidenBelgeDurumSorgulaExt') {
        return ver(zarf('<ns2:r><return><durum>3</durum><gonderimCevabiKodu>1300</gonderimCevabiKodu>'
          + '<gonderimCevabiDetayi>1300 (TPS_BASARIYLA_ISLENDI)</gonderimCevabiDetayi><ulastiMi>true</ulastiMi>'
          + '<yerelBelgeOid>0vmugxg41u15si</yerelBelgeOid></return></ns2:r>'));
      }
      if (op === 'kontorBilgisiGetir') {
        const tip = (/<kontorTipi>([^<]*)</.exec(govde) || [])[1];
        return ver(zarf('<ns2:r><return><kalan>' + (tip === 'FATURA' ? 38 : 940) + '</kalan>'
          + '<toplamAlinan>1000</toplamAlinan><bitisTarihi>20271231</bitisTarihi></return></ns2:r>'));
      }
      if (op === 'gelenBelgeleriListeleExt') {
        return ver(zarf('<ns2:r>' + GELENLER.map((g) => '<return xsi:type="ns2:belgev2">'
          + '<belgeNo>' + g.no + '</belgeNo><belgeTarihi>' + g.tarih + '</belgeTarihi><ettn>' + g.ettn + '</ettn>'
          + '<faturaSenaryo>' + g.senaryo + '</faturaSenaryo><gonderenIsim>' + g.kim + '</gonderenIsim>'
          + '<gonderenVknTckn>' + g.vkn + '</gonderenVknTckn>'
          + '<gonderenEtiket>urn:mail:defaultgb@' + (g.vkn === '4780216355' ? 'atlasgida' : 'mericet') + '.com.tr</gonderenEtiket>'
          + '<payableAmount>' + g.tutar + '</payableAmount><dovizCinsi>TRY</dovizCinsi><yanitDurumu>0</yanitDurumu>'
          + '<belgeXmlZipped>' + zip(Buffer.from(GELEN_UBL, 'utf8'), 'f.xml').toString('base64') + '</belgeXmlZipped>'
          + '</return>').join('') + '</ns2:r>'));
      }
      if (op === 'gelenBelgeIndirExt') {
        return ver(zarf('<ns2:r><return>' + zip(Buffer.from(GELEN_UBL, 'utf8'), 'g.xml').toString('base64') + '</return></ns2:r>'));
      }
      res.writeHead(200); res.end(zarf('<ns2:r/>'));
    });
  });
}

async function urun(ad, fiyat, kdv) {
  const v = await db.one('SELECT id FROM products WHERE client_id=? AND name=?', [CID, ad]);
  if (v) return v.id;
  const kat = await db.value('SELECT id FROM categories WHERE client_id=? LIMIT 1', [CID]);
  return db.insert('INSERT INTO products (client_id, category_id, name, price, vat_rate, is_active) VALUES (?,?,?,?,?,1)',
    [CID, kat, ad, fiyat, kdv]);
}

/** A real closed bill with a fiscal receipt behind it. */
async function adisyon(satirlar, fisNo) {
  const oid = await db.insert(
    `INSERT INTO orders (client_id, adisyon_no, business_date, table_id, waiter_id, status, is_closed,
        opened_at, closed_at, total, vat_total, grand_total)
     VALUES (?,?,CURDATE(),?,1,'closed',1,NOW(),NOW(),0,0,0)`,
    [CID, 4100 + Math.floor(Math.random() * 800), 1]);
  let brut = 0;
  for (const s of satirlar) {
    const pid = await urun(s.ad, s.fiyat, s.kdv);
    const tam = s.adet * s.fiyat;
    const ind = s.ikram ? tam : 0;
    const lt = tam - ind;
    brut += lt;
    await db.insert(
      `INSERT INTO order_items (client_id, order_id, product_id, qty, price, unit_price, total, line_total,
          discount_amount, vat_rate, vat_total, station_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'served')`,
      [CID, oid, pid, s.adet, s.fiyat, s.fiyat, tam, lt, ind, s.kdv,
       Math.round(lt * s.kdv / (100 + s.kdv) * 100) / 100]);
  }
  await db.exec('UPDATE orders SET total=?, grand_total=? WHERE id=?', [brut, brut, oid]);
  await db.insert('INSERT INTO order_payments (client_id, order_id, method, amount) VALUES (?,?,?,?)',
    [CID, oid, 'kredi_karti', brut]);
  const tx = await db.insert(
    `INSERT INTO fiscal_transactions (client_id, idempotency_key, order_id, provider, environment, state,
        payment_method, grand_total_minor, requested_amount_minor, created_at)
     VALUES (?,?,?,'hugin','PROD','approved','kredi_karti',?,?,NOW())`,
    [CID, crypto.randomUUID(), oid, Math.round(brut * 100), Math.round(brut * 100)]);
  await db.insert(
    `INSERT INTO fiscal_receipts (client_id, fiscal_transaction_id, order_id, fiscal_receipt_no, fiscal_timestamp)
     VALUES (?,?,?,?,NOW())`, [CID, tx, oid, fisNo]);
  return oid;
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  fs.mkdirSync(OUT, { recursive: true });
  const q = qnb();
  await new Promise((z) => q.listen(0, '127.0.0.1', z));
  const port = q.address().port;

  /* --- fixtures ---------------------------------------------------- */
  await db.exec('DELETE FROM invoice_charges WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM invoice_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM invoices WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM ebelge_log WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM gelen_belge WHERE client_id=?', [CID]);
  await E.kaydet(CTX, {
    aktif: 1, otomatik: 0, ortam: 'test', vkn: '3890125539',
    efatura_kullanici: '3890125539', efatura_sifre: 'onizleme',
    earsiv_kullanici: '3890125539.portaltest', earsiv_sifre: 'onizleme',
    efatura_url: 'http://127.0.0.1:' + port + '/efatura',
    earsiv_url: 'http://127.0.0.1:' + port + '/earsiv',
    efatura_seri: 'NKT', sube: 'DFLT', kasa: 'DFLT', il: 'Antalya', ilce: 'Alanya',
  });

  /* one invoice that went out as an e-Fatura and completed */
  const o1 = await adisyon([
    { ad: 'Kuzu Şiş', adet: 4, fiyat: 340, kdv: 10 },
    { ad: 'Karışık Meze Tabağı', adet: 2, fiyat: 180, kdv: 10 },
    { ad: 'Ayran', adet: 4, fiyat: 45, kdv: 10 },
  ], '000148');
  const f1 = await F.kes(CTX, o1, { cust_title: 'Atlas Gıda Toptan Ltd. Şti.', cust_tax_no: '4780216355',
    cust_tax_office: 'Alanya', cust_address: 'Saray Mah. Atatürk Cad. 112, Alanya/Antalya',
    cust_email: 'muhasebe@atlasgida.com.tr', servis: 80 });
  await E.gonder(CTX, f1.id);
  await E.durumSorgula(CTX, f1.id);

  /* one e-Arşiv to a private person, with an ikram line at 0,00 */
  const o2 = await adisyon([
    { ad: 'Izgara Levrek', adet: 2, fiyat: 420, kdv: 10 },
    { ad: 'Mevsim Salata', adet: 2, fiyat: 120, kdv: 10 },
    { ad: 'Künefe', adet: 2, fiyat: 150, kdv: 10, ikram: 1 },
  ], '000151');
  const f2 = await F.kes(CTX, o2, { cust_title: 'Elif Demirtaş', cust_tax_no: '17492058316',
    cust_tax_office: '-', cust_address: 'Cikcilli Mah. Barbaros Cad. 7/3, Alanya/Antalya' });
  await E.gonder(CTX, f2.id);

  /* one whose outcome is genuinely unknown - the state the screen exists for */
  const o3 = await adisyon([{ ad: 'Adana Kebap', adet: 6, fiyat: 310, kdv: 10 }], '000155');
  const f3 = await F.kes(CTX, o3, { cust_title: 'Deniz Turizm ve Otelcilik A.Ş.', cust_tax_no: '6210394877',
    cust_tax_office: 'Alanya', cust_address: 'Oba Mah. Sahil Cad. 44, Alanya/Antalya' });
  await E.durumYaz(f3.id, { edoc_type: 'EARSIV', edoc_uuid: crypto.randomUUID().toUpperCase(),
    edoc_state: 'belirsiz', edoc_env: 'test', edoc_sent_at: E.simdi(),
    edoc_error: 'Servis 60 sn içinde yanıt vermedi.' });

  /* one bill left unfactured, to photograph the issuing dialog against */
  const o4 = await adisyon([
    { ad: 'Kaburga Tandır', adet: 3, fiyat: 480, kdv: 10 },
    { ad: 'Şakşuka', adet: 3, fiyat: 110, kdv: 10 },
    { ad: 'Baklava', adet: 3, fiyat: 140, kdv: 10, ikram: 1 },
    { ad: 'Türk Kahvesi', adet: 3, fiyat: 60, kdv: 20 },
  ], '000162');

  const G = require('../src/ebelge/gelen');
  await G.cek(CTX);
  await E.kontor();

  /* --- the photographs -------------------------------------------- */
  const browser = await tarayiciAc();
  const page = await browser.newPage({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 2 });
  const shot = async (n) => {
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });
    console.log('  ' + n);
  };
  await page.goto(BASE + '/');
  await page.waitForSelector('.pinpad', { timeout: 20000 });
  for (const d of (process.env.DEMO_PIN || '4321').split('')) await page.click(`.pinpad button[data-k="${d}"]`);
  await page.waitForSelector('.nav__item', { timeout: 20000 });

  await page.evaluate(() => go('faturalar'));
  await shot('1-faturalar');

  await page.evaluate((id) => Screens.faturaDialog(id), f1.id);
  await shot('2-fatura-efatura-tamam');
  await page.evaluate(() => closeModal());

  await page.evaluate((id) => Screens.faturaDialog(id), f3.id);
  await shot('3-fatura-sonuc-bilinmiyor');
  await page.evaluate(() => closeModal());

  await page.evaluate((id) => Screens.faturaKesDialog(id), o4);
  await page.waitForTimeout(1400);
  await shot('4-adisyondan-fatura-kes');
  await page.evaluate(() => closeModal());

  await page.evaluate(() => go('gelenfatura'));
  await shot('5-gelen-faturalar');

  const gid = await page.evaluate(async () => {
    const r = await api('GET', '/api/ebelge/gelen');
    return (r.gelen.find((g) => g.senaryo === 'TICARIFATURA') || {}).id;
  });
  if (gid) {
    await page.evaluate((id) => Screens.gelenDialog(id), gid);
    await shot('6-gelen-fatura-kabul-red');
    await page.evaluate(() => closeModal());
  }

  await page.evaluate(() => go('efatura'));
  await page.waitForTimeout(1400);
  await shot('7-efatura-ayarlari');

  try { server.close(); } catch (_) {}
  q.close();
  await browser.close();
  console.log('\nbitti -> ' + OUT + '\n');
  process.exit(0);
})().catch((e) => { console.error('SHOT FAILURE:', e.stack || e.message); process.exit(1); });
