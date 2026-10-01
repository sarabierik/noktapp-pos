'use strict';
/**
 * e-FATURA / e-ARŞİV — against a fake QNB that behaves like the real one.
 *
 * The shapes below are not invented. They reproduce what QNB eSolutions'
 * test environment actually returned on 29.09.2026 (AE00000, the
 * resultExtra entries, belgeOid, durum 3 with gönderim code 1200/1300,
 * AE00002, AE00313, username.pwd.mismatch, "ERP kayıt listesinde
 * bulunamadı"), plus the rules QNB stated in writing on 30.09.2026.
 *
 * What is worth testing here is not "does the XML have a tag". It is the
 * handful of things that, when wrong, produce a SECOND legal invoice for
 * one meal, a VAT figure that disagrees with the fiscal receipt the guest
 * already holds, a password in a log file, or a QNB account blocked in
 * the middle of a Saturday service. Each of those has its own check.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/ebelge.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7496';
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const db = require('../src/db');
const E = require('../src/ebelge');
const G = require('../src/ebelge/gelen');
const F = require('../src/ebelge/fatura');
const S = require('../src/ebelge/sirla');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const CID = 19;
const CTX = { clientId: CID, userId: 1, role: 'admin' };
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

/* ================================================================== */
/*  The fake QNB                                                      */
/* ================================================================== */
const Q = {
  istekler: [],
  kayitli: new Set(['3890125540']),   /* who is an e-Fatura taxpayer */
  earsiv: 'ok',                       /* ok | sessiz | sonra-sessiz */
  efatura: 'ok',                      /* ok | sessiz */
  erpYok: false,
  sifreYanlis: false,
  durum: '3', kod: null, ulasti: null,
  belgeler: new Map(),                /* islemId -> {no, uuid, iptal} */
  sayac: 0,
  gonderilen: new Map(),              /* belgeNo -> body */
  yutulan: new Set(),                 /* belgeNo whose answer was dropped */
  gelen: [],
  yanitHata: false,
};
const zarf = (govde) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"'
  + ' xmlns:ns2="http://service.connector.uut.cs.com.tr/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
  + '<soapenv:Body>' + govde + '</soapenv:Body></soapenv:Envelope>';
const fault = (m) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">'
  + '<soapenv:Body><soapenv:Fault><faultcode>soapenv:Server</faultcode><faultstring>' + m + '</faultstring>'
  + '</soapenv:Fault></soapenv:Body></soapenv:Envelope>';
const cikar = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const ziple = (buf, ad) => {
  const ham = zlib.deflateRawSync(buf);
  const crc = (() => { let c = ~0; for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; })();
  const n = Buffer.from(ad, 'utf8');
  const yerel = Buffer.alloc(30);
  yerel.writeUInt32LE(0x04034b50, 0); yerel.writeUInt16LE(20, 4); yerel.writeUInt16LE(8, 8);
  yerel.writeUInt32LE(crc, 14); yerel.writeUInt32LE(ham.length, 18); yerel.writeUInt32LE(buf.length, 22);
  yerel.writeUInt16LE(n.length, 26);
  return Buffer.concat([yerel, n, ham]);
};

function qnbSunucu() {
  return http.createServer((req, res) => {
    const p = [];
    req.on('data', (c) => p.push(c));
    req.on('end', () => {
      const govde = Buffer.concat(p).toString('utf8');
      const op = (/<soapenv:Body><ser:([a-zA-Z]+)/.exec(govde) || [])[1] || '?';
      let inp = {};
      const im = /<input>([\s\S]*?)<\/input>/.exec(govde);
      if (im) { try { inp = JSON.parse(cikar(im[1])); } catch (e) { inp = {}; } }
      Q.istekler.push({ url: req.url, op, inp, govde });
      const ver = (kod, g) => { res.writeHead(kod, { 'Content-Type': 'text/xml' }); res.end(g); };

      if (Q.sifreYanlis) return ver(500, fault('MessageCode:username.pwd.mismatch'));

      if (op === 'efaturaKullaniciBilgisi') {
        const vkn = (/<vergiTcKimlikNo>(\d+)</.exec(govde) || [])[1];
        if (!Q.kayitli.has(String(vkn))) return ver(200, zarf('<ns2:efaturaKullaniciBilgisiResponse/>'));
        return ver(200, zarf('<ns2:efaturaKullaniciBilgisiResponse><return><etiket>urn:mail:defaultpk@alici.com.tr</etiket>'
          + '<kamuKurulusu>false</kamuKurulusu><kayitZamani>20200101</kayitZamani><unvan>Alıcı A.Ş.</unvan>'
          + '<vergiTcKimlikNo>' + vkn + '</vergiTcKimlikNo></return></ns2:efaturaKullaniciBilgisiResponse>'));
      }
      if (op === 'efaturaKullanicisi') return ver(200, zarf('<ns2:efaturaKullanicisiResponse><return>false</return></ns2:efaturaKullanicisiResponse>'));

      if (op === 'faturaOlusturExt') {
        if (Q.earsiv === 'sessiz') return;                      /* no answer at all */
        if (inp.erpKodu && Q.erpYok) {
          return ver(200, zarf('<ns2:faturaOlusturExtResponse><return><resultCode>AE00001</resultCode>'
            + '<resultText>erpKodu, ERP kayıt listesinde bulunamadı : ' + inp.erpKodu + '</resultText></return></ns2:faturaOlusturExtResponse>'));
        }
        const ubl = Buffer.from((/<belgeIcerigi>([\s\S]*?)<\/belgeIcerigi>/.exec(govde) || [])[1] || '', 'base64').toString('utf8');
        if (!/<cbc:Note>Gönderim Şekli: (KAGIT|ELEKTRONIK)<\/cbc:Note>/.test(ubl)) {
          return ver(200, zarf('<ns2:faturaOlusturExtResponse><return><resultCode>AE00003</resultCode>'
            + '<resultText>Gönderim Şekli bilgisi bulunamadı.</resultText></return></ns2:faturaOlusturExtResponse>'));
        }
        if (/<cbc:FirstName>Nihai<\/cbc:FirstName>/.test(ubl)) {
          return ver(200, zarf('<ns2:faturaOlusturExtResponse><return><resultCode>AE00313</resultCode>'
            + '<resultText>Alıcı bilgisi Nihai/Muhtelif Tüketici olamaz.</resultText></return></ns2:faturaOlusturExtResponse>'));
        }
        let b = Q.belgeler.get(inp.islemId);
        if (!b) { b = { no: 'EAA2026' + String(++Q.sayac).padStart(9, '0'), uuid: inp.islemId, ubl }; Q.belgeler.set(inp.islemId, b); }
        if (Q.earsiv === 'sonra-sessiz') { Q.earsiv = 'ok'; return; }  /* created, answer dropped */
        return ver(200, zarf('<ns2:faturaOlusturExtResponse><return><resultCode>AE00000</resultCode>'
          + '<resultText>İşlem başarılı.</resultText>'
          + '<resultExtra><entry><key>islemID</key><value>' + inp.islemId + '</value></entry>'
          + '<entry><key>faturaURL</key><value>https://earsivtest/goruntule.jsp?uuid=' + b.uuid + '</value></entry>'
          + '<entry><key>uuid</key><value>' + b.uuid + '</value></entry>'
          + '<entry><key>faturaNo</key><value>' + b.no + '</value></entry></resultExtra>'
          + '</return></ns2:faturaOlusturExtResponse>'));
      }
      if (op === 'faturaSorgula') {
        const b = Q.belgeler.get(inp.faturaUuid);
        if (!b) {
          return ver(200, zarf('<ns2:faturaSorgulaResponse><return><resultCode>AE00002</resultCode>'
            + '<resultText>' + inp.vkn + ' VKN\'ye ait ' + inp.faturaUuid + ' UUID\'li fatura sistemde kayıtlı değildir!</resultText>'
            + '</return></ns2:faturaSorgulaResponse>'));
        }
        const pdfKismi = inp.donenBelgeFormati === 3
          ? '<output><belgeFormati>PDF</belgeFormati><belgeIcerigi>'
            + zlib.gzipSync(Buffer.from('%PDF-1.4 earsiv')).toString('base64') + '</belgeIcerigi></output>' : '';
        return ver(200, zarf('<ns2:faturaSorgulaResponse><return><resultCode>AE00000</resultCode><resultText>İşlem başarılı.</resultText>'
          + '<resultExtra><entry><key>faturaNo</key><value>' + b.no + '</value></entry>'
          + '<entry><key>faturaURL</key><value>https://earsivtest/goruntule.jsp?uuid=' + b.uuid + '</value></entry>'
          + (b.iptal ? '<entry><key>iptalTarihi</key><value>2026-09-29</value></entry>' : '')
          + '</resultExtra>' + pdfKismi + '</return></ns2:faturaSorgulaResponse>'));
      }
      if (op === 'faturaIptalEt') {
        const b = Q.belgeler.get(inp.faturaUuid);
        if (b) b.iptal = true;
        return ver(200, zarf('<ns2:faturaIptalEtResponse><return><resultCode>AE00000</resultCode></return></ns2:faturaIptalEtResponse>'));
      }
      if (op === 'belgeGonderExt') {
        const no = (/<belgeNo>([^<]*)</.exec(govde) || [])[1];
        Q.gonderilen.set(no, govde);
        if (Q.yanitHata) return ver(500, fault('Şema hatası: ApplicationResponse'));
        if (Q.efatura === 'sessiz') { Q.yutulan.add(no); return; }
        return ver(200, zarf('<ns2:belgeGonderExtResponse><return><belgeOid>0vmugxg41u15si</belgeOid></return></ns2:belgeGonderExtResponse>'));
      }
      if (op === 'gidenBelgeDurumSorgulaExt') {
        const no = (/<belgeNo>([^<]*)</.exec(govde) || [])[1];
        const tipi = (/<belgeNoTipi>([^<]*)</.exec(govde) || [])[1];
        if (tipi === 'YEREL' && Q.yutulan.has(no)) return ver(500, fault('Belge bulunamadı'));
        const kod = Q.kod == null ? (Q.durum === '3' ? 1300 : 1100) : Q.kod;
        const ulasti = Q.ulasti == null ? (Q.durum === '3' && kod === 1300) : Q.ulasti;
        return ver(200, zarf('<ns2:gidenBelgeDurumSorgulaExtResponse><return><belgeNo>' + no + '</belgeNo>'
          + '<durum>' + Q.durum + '</durum><ettn>x</ettn>'
          + '<gonderimCevabiDetayi>' + (kod === 1300 ? '1300 (TPS_BASARIYLA_ISLENDI)' : kod + ' (detay)') + '</gonderimCevabiDetayi>'
          + '<gonderimCevabiKodu>' + kod + '</gonderimCevabiKodu>'
          + '<ulastiMi>' + (ulasti ? 'true' : 'false') + '</ulastiMi>'
          + '<yenidenGonderilebilirMi>true</yenidenGonderilebilirMi>'
          + '<yerelBelgeOid>0vmugxg41u15si</yerelBelgeOid></return></ns2:gidenBelgeDurumSorgulaExtResponse>'));
      }
      if (op === 'kontorBilgisiGetir') {
        const tip = (/<kontorTipi>([^<]*)</.exec(govde) || [])[1];
        return ver(200, zarf('<ns2:kontorBilgisiGetirResponse><return><bitisTarihi>20271231</bitisTarihi>'
          + '<kalan>' + (tip === 'FATURA' ? 42 : 1200) + '</kalan><kontorBirimi>ADET</kontorBirimi>'
          + '<toplamAlinan>500</toplamAlinan></return></ns2:kontorBilgisiGetirResponse>'));
      }
      if (op === 'gidenBelgeleriIndir') {
        return ver(200, zarf('<ns2:gidenBelgeleriIndirResponse><return>'
          + ziple(Buffer.from('%PDF-1.4 efatura'), 'f.pdf').toString('base64') + '</return></ns2:gidenBelgeleriIndirResponse>'));
      }
      if (op === 'gelenBelgeleriListeleExt') {
        return ver(200, zarf('<ns2:gelenBelgeleriListeleExtResponse>'
          + Q.gelen.map((g) => '<return xsi:type="ns2:belgev2"><belgeNo>' + g.no + '</belgeNo>'
            + '<belgeTarihi>' + g.tarih + '</belgeTarihi><belgeTuru>FATURA</belgeTuru><ettn>' + g.ettn + '</ettn>'
            + '<faturaSenaryo>' + g.senaryo + '</faturaSenaryo>'
            + '<gonderenEtiket>urn:mail:defaultgb@tedarik.com.tr</gonderenEtiket><gonderenIsim>Tedarik A.Ş.</gonderenIsim>'
            + '<gonderenVknTckn>1234567890</gonderenVknTckn><payableAmount>360.00</payableAmount><dovizCinsi>TRY</dovizCinsi>'
            + '<yanitDurumu>' + (g.yanitDurumu || 0) + '</yanitDurumu>'
            + (g.zip === false ? '' : '<belgeXmlZipped>' + ziple(Buffer.from(GELEN_UBL, 'utf8'), 'f.xml').toString('base64') + '</belgeXmlZipped>')
            + '</return>').join('')
          + '</ns2:gelenBelgeleriListeleExtResponse>'));
      }
      if (op === 'gelenBelgeIndirExt') {
        const bicim = (/<belgeFormati>([^<]*)</.exec(govde) || [])[1];
        const icerik = bicim === 'PDF' ? Buffer.from('%PDF-1.4 gelen') : Buffer.from(GELEN_UBL, 'utf8');
        return ver(200, zarf('<ns2:gelenBelgeIndirExtResponse><return>'
          + ziple(icerik, 'g.bin').toString('base64') + '</return></ns2:gelenBelgeIndirExtResponse>'));
      }
      return ver(500, fault('bilinmeyen ' + op));
    });
  });
}

const GELEN_UBL = '<Invoice><cac:InvoiceLine><cbc:ID>1</cbc:ID>'
  + '<cbc:InvoicedQuantity unitCode="KGM">3</cbc:InvoicedQuantity>'
  + '<cbc:LineExtensionAmount currencyID="TRY">300.00</cbc:LineExtensionAmount>'
  + '<cac:TaxSubtotal><cbc:TaxAmount currencyID="TRY">60.00</cbc:TaxAmount><cbc:Percent>20</cbc:Percent></cac:TaxSubtotal>'
  + '<cac:Item><cbc:Name>Un 25kg</cbc:Name></cac:Item>'
  + '<cac:Price><cbc:PriceAmount currencyID="TRY">100.00</cbc:PriceAmount></cac:Price>'
  + '</cac:InvoiceLine></Invoice>';

/* ================================================================== */
/*  Fixtures                                                          */
/* ================================================================== */
const SIFRE = 'test-parolasi-9x';
async function ayarla(port, over = {}) {
  const r = await E.kaydet(CTX, Object.assign({
    aktif: 1, otomatik: 0, ortam: 'test', vkn: '3890125539',
    efatura_kullanici: '3890125539', efatura_sifre: SIFRE,
    earsiv_kullanici: '3890125539.portaltest', earsiv_sifre: SIFRE,
    efatura_url: 'http://127.0.0.1:' + port + '/efatura',
    earsiv_url: 'http://127.0.0.1:' + port + '/earsiv',
    efatura_seri: 'NKT', sube: 'DFLT', kasa: 'DFLT', il: 'Antalya', ilce: 'Alanya',
  }, over));
  if (!r.ok) throw new Error('ayar kaydedilemedi: ' + r.error);
  E._mukellefCache.clear();
}

let urunId = null, masaId = 1;
async function urun() {
  if (urunId) return urunId;
  const v = await db.one("SELECT id FROM products WHERE client_id=? AND name='e-Belge Testi Kebap'", [CID]);
  if (v) { urunId = v.id; return urunId; }
  const kat = await db.value('SELECT id FROM categories WHERE client_id=? LIMIT 1', [CID]);
  urunId = await db.insert(
    'INSERT INTO products (client_id, category_id, name, price, vat_rate, is_active) VALUES (?,?,?,?,?,1)',
    [CID, kat, 'e-Belge Testi Kebap', 120, 10]);
  return urunId;
}

/** A closed bill with an ÖKC receipt behind it, as a real fatura needs. */
async function adisyon({ satirlar = [{ qty: 1, price: 120, vat: 10 }], ikram = 0, indirim = 0, fis = '000148' } = {}) {
  const pid = await urun();
  const oid = await db.insert(
    `INSERT INTO orders (client_id, adisyon_no, business_date, table_id, waiter_id, status, is_closed,
        opened_at, closed_at, total, vat_total, grand_total)
     VALUES (?,?,CURDATE(),?,1,'closed',1,NOW(),NOW(),0,0,0)`,
    [CID, Math.floor(Math.random() * 90000) + 1000, masaId]);
  let brut = 0;
  for (const s of satirlar) {
    /* `s.ikram` is the per-line give-away the till records as a full line
       discount: qty * price comes off and line_total lands on zero. */
    const tam = s.qty * s.price;
    const ind = s.ikram ? tam : 0;
    const lt = tam - ind;
    brut += lt;
    await db.insert(
      `INSERT INTO order_items (client_id, order_id, product_id, qty, price, unit_price, total, line_total,
          discount_amount, vat_rate, vat_total, station_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'served')`,
      [CID, oid, pid, s.qty, s.price, s.price, tam, lt, ind, s.vat,
       Math.round(lt * s.vat / (100 + s.vat) * 100) / 100]);
  }
  await db.exec('UPDATE orders SET total=?, grand_total=? WHERE id=?', [brut, brut - indirim - ikram, oid]);
  if (indirim) {
    await db.insert('INSERT INTO order_discounts (client_id, order_id, discount_value, reason) VALUES (?,?,?,?)',
      [CID, oid, indirim, 'Test indirimi']);
  }
  if (ikram) {
    await db.insert('INSERT INTO order_payments (client_id, order_id, method, amount) VALUES (?,?,?,?)',
      [CID, oid, 'ikram', ikram]);
  }
  await db.insert('INSERT INTO order_payments (client_id, order_id, method, amount) VALUES (?,?,?,?)',
    [CID, oid, 'nakit', brut - indirim - ikram]);
  if (fis) {
    const tx = await db.insert(
      `INSERT INTO fiscal_transactions (client_id, idempotency_key, order_id, provider, environment, state,
          payment_method, grand_total_minor, requested_amount_minor, created_at)
       VALUES (?,?,?,'simulator','SIMULATOR','approved','nakit',?,?,NOW())`,
      [CID, crypto.randomUUID(), oid, Math.round((brut - indirim - ikram) * 100), Math.round((brut - indirim - ikram) * 100)]);
    await db.insert(
      `INSERT INTO fiscal_receipts (client_id, fiscal_transaction_id, order_id, fiscal_receipt_no, fiscal_timestamp)
       VALUES (?,?,?,?,NOW())`, [CID, tx, oid, fis]);
  }
  return oid;
}

const ALICI = { cust_title: 'Alıcı A.Ş.', cust_tax_no: '3890125540', cust_tax_office: 'Alanya',
                cust_address: 'Saray Mah. 3, Alanya/Antalya' };
const ALICI_EARSIV = { cust_title: 'Ayşe Yılmaz', cust_tax_no: '11111111111', cust_tax_office: '-',
                       cust_address: 'Cikcilli Mah. 5, Alanya/Antalya' };

async function fatura(alici = ALICI, o = {}) {
  const oid = o.orderId || await adisyon(o.adisyon || {});
  const r = await F.kes(CTX, oid, Object.assign({}, alici, o.body || {}));
  return { id: r.id, full_no: r.full_no, orderId: oid, ebelge: r.ebelge };
}
const oku = (id) => db.one('SELECT * FROM invoices WHERE id=?', [id]);

/* ================================================================== */
(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  const qnb = qnbSunucu();
  await new Promise((z) => qnb.listen(0, '127.0.0.1', z));
  const port = qnb.address().port;
  console.log('\nNOKTApp POS - e-Fatura / e-Arşiv (QNB eSolutions)\n');

  /* a clean slate: this suite asserts on numbering, which is cumulative */
  await db.exec('DELETE FROM invoice_charges WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM invoice_items WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM invoices WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM ebelge_log WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM gelen_belge WHERE client_id=?', [CID]);
  await db.exec("DELETE FROM np_settings WHERE k LIKE 'ebelge.%'");
  E.kilitAc();
  await ayarla(port);

  /* ---------------------------------------------------------------- */
  await step('ayarlar: parola sarili yazilir, QNB disi adres reddedilir, seri 3 harf', async () => {
    const ham = await db.getSetting('ebelge.efatura_sifre');
    assert.ok(ham && ham !== SIFRE, 'parola duz yazilmis');
    assert.ok(/^(dpapi|duz):/.test(ham), 'parola sarmalanmamis: ' + String(ham).slice(0, 12));
    assert.strictEqual(S.ac(ham), SIFRE, 'parola geri okunamiyor');

    const kotu = await E.kaydet(CTX, { ortam: 'test', efatura_url: 'https://qnbesolutions.com.tr.saldirgan.net/x/', efatura_seri: 'NKT' });
    assert.ok(!kotu.ok && /QNB/.test(kotu.error), 'benzer alan adi kabul edildi');
    const seri = await E.kaydet(CTX, { ortam: 'test', efatura_seri: 'NK' });
    assert.ok(!seri.ok, '2 harfli seri kabul edildi');
    /* a refused save must not have written its other fields */
    assert.strictEqual((await E.conf()).efatura_seri, 'NKT', 'reddedilen kayit yarim yazilmis');

    /* an empty password field keeps the stored one */
    await E.kaydet(CTX, { aktif: 1, ortam: 'test', vkn: '3890125539', efatura_kullanici: '3890125539',
      efatura_sifre: '', earsiv_kullanici: '3890125539.portaltest', earsiv_sifre: '',
      efatura_url: 'http://127.0.0.1:' + port + '/efatura', earsiv_url: 'http://127.0.0.1:' + port + '/earsiv',
      efatura_seri: 'NKT', il: 'Antalya', ilce: 'Alanya' });
    assert.strictEqual((await E.conf()).efatura_sifre, SIFRE, 'bos parola alani kayitli parolayi silmis');
  });

  /* ---------------------------------------------------------------- */
  await step('UBL: cbc:Percent YUZDE olarak yazilir (10.00 -> 10, 0.1 DEGIL)', async () => {
    const f = { id: 1, kind: 'sale', issue_date: '2026-09-29', full_no: 'FTR2026000001',
                cust_tax_no: '3890125540', cust_title: 'Alıcı A.Ş.', cust_address: 'Saray Mah. 3, Alanya/Antalya' };
    const x = E.ubl(f, [{ name: 'Kebap', qty: 1000, unit: 'porsiyon', base_amount: 10909, vat_rate: '10.00', vat_amount: 1091 }],
      { tip: 'EARSIV', no: 'X', uuid: 'U', c: await E.conf() });
    assert.ok(/<cbc:Percent>10<\/cbc:Percent>/.test(x),
      'KDV orani yuzde olarak yazilmiyor - Noktappera 2000 baz puani tutuyordu, POS 10.00 tutuyor');
    assert.ok(!/<cbc:Percent>0\.1</.test(x), 'oran 100e bolunmus: yasal belgede %0,1 yazar');
  });

  await step('UBL: matrah + KDV = TaxInclusiveAmount = PayableAmount; %0 satira 351 duser', async () => {
    const c = await E.conf();
    const f = { id: 1, kind: 'sale', issue_date: '2026-09-29', full_no: 'FTR2026000002',
                cust_tax_no: '3890125540', cust_title: 'Alıcı A.Ş.', cust_address: 'Saray Mah. 3, Alanya/Antalya' };
    const kalem = [
      { name: 'Kebap', qty: 2000, unit: 'porsiyon', base_amount: 21818, vat_rate: '10.00', vat_amount: 2182 },
      { name: 'Su', qty: 1000, unit: 'adet', base_amount: 1000, vat_rate: '0.00', vat_amount: 0 },
    ];
    const x = E.ubl(f, kalem, { tip: 'EARSIV', no: 'X', uuid: 'U', c });
    assert.ok(/<cbc:TaxInclusiveAmount currencyID="TRY">250\.00<\/cbc:TaxInclusiveAmount>/.test(x), 'toplam tutmuyor');
    assert.ok(/<cbc:PayableAmount currencyID="TRY">250\.00<\/cbc:PayableAmount>/.test(x), 'odenecek tutmuyor');
    assert.ok(/<cbc:LineCountNumeric>2<\/cbc:LineCountNumeric>/.test(x), 'satir sayisi yok');
    assert.ok(/<cbc:TaxExemptionReasonCode>351</.test(x), '%0 satirda istisna kodu yok');
  });

  await step('UBL: TCKN alici Person olur, adres ilce/il ayri alanlara gider', async () => {
    const c = await E.conf();
    const f = { id: 1, kind: 'sale', issue_date: '2026-09-29', full_no: 'FTR2026000003',
                cust_tax_no: '11111111111', cust_title: 'Ayşe Yılmaz', cust_address: 'Cikcilli Mah. 5, Alanya/Antalya' };
    const x = E.ubl(f, [{ name: 'Kebap', qty: 1000, unit: 'porsiyon', base_amount: 10909, vat_rate: '10.00', vat_amount: 1091 }],
      { tip: 'EARSIV', no: 'X', uuid: 'U', c });
    assert.ok(/<cbc:FirstName>Ayşe<\/cbc:FirstName><cbc:FamilyName>Yılmaz<\/cbc:FamilyName>/.test(x), 'kisi adi ayrilmadi');
    assert.ok(/schemeID="TCKN">11111111111</.test(x), 'TCKN semasi yok');
    assert.ok(/<cbc:StreetName>Cikcilli Mah\. 5<\/cbc:StreetName>/.test(x), 'sokak ayrilmadi: PDFte ilce iki kez basilir');
    assert.ok(/<cbc:CitySubdivisionName>Alanya<\/cbc:CitySubdivisionName><cbc:CityName>Antalya</.test(x), 'ilce/il ayrilmadi');
  });

  /* ---------------------------------------------------------------- */
  await step('FATURA adisyondan kesilir: OKC fisine istinaden notu duser, kalemler baglanir', async () => {
    const f = await fatura(ALICI, { adisyon: { satirlar: [{ qty: 2, price: 120, vat: 10 }] } });
    const r = await oku(f.id);
    assert.ok(/ÖKC fişine istinaden düzenlenmiştir/.test(r.note), 'fis istinat notu yok: ayni yemek iki kez beyan edilir');
    assert.ok(/000148/.test(r.note), 'fis numarasi notta yok');
    assert.strictEqual(r.fis_no, '000148');
    assert.strictEqual(Number(r.total_minor), 24000, 'fatura toplami adisyonla ayni degil');
    const k = await db.query('SELECT * FROM invoice_items WHERE invoice_id=?', [f.id]);
    assert.strictEqual(k.length, 1);
    assert.ok(k[0].order_item_id, 'kalem adisyon satirina baglanmamis');
    assert.strictEqual(Number(k[0].base_amount) + Number(k[0].vat_amount), 24000, 'matrah+KDV satir tutarini vermiyor');
  });

  await step('BOLUNMUS HESAP: ayni adisyon satiri iki faturaya GIREMEZ (veritabani reddeder)', async () => {
    const oid = await adisyon({ satirlar: [{ qty: 1, price: 100, vat: 10 }, { qty: 1, price: 50, vat: 10 }] });
    const items = await db.query('SELECT id FROM order_items WHERE order_id=? ORDER BY id', [oid]);
    const a = await F.kes(CTX, oid, Object.assign({ item_ids: [items[0].id] }, ALICI));
    assert.ok(a.id, 'ilk pay faturalanamadi');
    const b = await F.kes(CTX, oid, Object.assign({ item_ids: [items[1].id] }, ALICI_EARSIV));
    assert.ok(b.id, 'ikinci pay faturalanamadi');
    /* now try to invoice the first line a second time */
    let hata = null;
    try { await F.kes(CTX, oid, Object.assign({ item_ids: [items[0].id] }, ALICI)); }
    catch (e) { hata = e.message; }
    assert.ok(hata && /zaten faturaland/i.test(hata), 'ayni satir ikinci kez faturalandi: ' + hata);
    const say = await db.value('SELECT COUNT(*) FROM invoice_items WHERE client_id=? AND order_item_id=?', [CID, items[0].id]);
    assert.strictEqual(Number(say), 1, 'bir adisyon satiri iki fatura kaleminde duruyor');
  });

  await step('IKRAM edilen satir faturada 0,00 GORUNUR - gizlenmez', async () => {
    /* The bill is a 100 TL main and a 50 TL dessert given away. The till
       records the give-away as a full line discount, so line_total is 0. */
    const oid = await adisyon({ satirlar: [{ qty: 1, price: 100, vat: 10 }, { qty: 1, price: 50, vat: 10, ikram: 1 }] });
    const on = await F.onizle(CID, oid);
    assert.strictEqual(on.satirlar.length, 2, 'ikram satiri faturadan dusurulmus: fatura masaya gelenle uyusmaz');
    const sifir = on.satirlar.filter((s) => s.base_amount === 0 && s.vat_amount === 0);
    assert.strictEqual(sifir.length, 1, 'ikram edilen satir 0,00 gorunmuyor');
    assert.strictEqual(sifir[0].is_gift, 1, 'ikram isaretlenmemis');
    assert.ok(sifir[0].qty > 0 && sifir[0].name, 'ikram satirinin adi ve miktari kaybolmus');
    assert.strictEqual(on.total_minor, 10000, 'ikram tutari faturaya girmis: alinmayan paranin KDVsi beyan edilir');
  });

  await step('IKRAM odemesi (hesap geneli) satirlara oranli dagilir', async () => {
    /* A bill-level ikram payment carries no line information at all - the
       till only knows 50 TL was not taken. It comes off the lines in
       proportion, exactly as a bill discount does, so the invoice's KDV
       still matches the fiscal receipt's. */
    const oid = await adisyon({ satirlar: [{ qty: 1, price: 100, vat: 10 }, { qty: 1, price: 50, vat: 10 }], ikram: 50 });
    const on = await F.onizle(CID, oid);
    assert.strictEqual(on.total_minor, 10000, 'ikram odemesi faturadan dusurulmemis');
    assert.strictEqual(on.ikram_minor, 5000);
    assert.strictEqual(Math.round(on.adisyon_kdv.vatTotal * 100), on.vat_minor,
      'faturanin KDVsi adisyonun KDVsinden farkli');
  });

  await step('SERVIS UCRETI AllowanceCharge olur, sahte urun satiri OLMAZ', async () => {
    const f = await fatura(ALICI, { adisyon: { satirlar: [{ qty: 1, price: 100, vat: 10 }] }, body: { servis: 10 } });
    const ekler = await db.query('SELECT * FROM invoice_charges WHERE invoice_id=?', [f.id]);
    assert.strictEqual(ekler.length, 1, 'servis ucreti kaydedilmemis');
    assert.strictEqual(Number(ekler[0].is_charge), 1);
    const kalem = await db.query('SELECT name FROM invoice_items WHERE invoice_id=?', [f.id]);
    assert.ok(!kalem.some((k) => /servis/i.test(k.name)), 'servis ucreti urun satiri olarak yazilmis');
    const r = await oku(f.id);
    const x = E.ubl(r, kalem.length ? await db.query('SELECT * FROM invoice_items WHERE invoice_id=?', [f.id]) : [],
      { tip: 'EARSIV', no: 'X', uuid: 'U', c: await E.conf(), ekler });
    assert.ok(/<cac:AllowanceCharge><cbc:ChargeIndicator>true<\/cbc:ChargeIndicator>/.test(x), 'AllowanceCharge yok');
    /* ChargeTotalAmount is tax EXCLUSIVE: 10,00 gross at %10 is 9,09 + 0,91. */
    assert.ok(/<cbc:ChargeTotalAmount currencyID="TRY">9\.09</.test(x), 'ilave toplami yazilmamis: ' + (/<cbc:ChargeTotalAmount[^>]*>([^<]*)/.exec(x) || [])[1]);
    assert.ok(/<cbc:TaxInclusiveAmount currencyID="TRY">110\.00</.test(x), 'servis ucreti genel toplama girmemis');
    assert.strictEqual(Number(r.total_minor), 11000, 'servis ucreti toplama girmemis');
  });

  await step('INDIRIM satirlara yayilir (OKC fisiyle ayni KDV), AllowanceCharge YAPILMAZ', async () => {
    const oid = await adisyon({ satirlar: [{ qty: 1, price: 100, vat: 10 }, { qty: 1, price: 100, vat: 20 }], indirim: 40 });
    const on = await F.onizle(CID, oid);
    const ekler = on.ekler.filter((e) => !e.is_charge);
    assert.strictEqual(ekler.length, 0, 'indirim belge duzeyinde indirim olarak yazilmis: OKC fisinden farkli KDV beyan edilir');
    assert.strictEqual(on.total_minor, 16000, 'indirimli toplam yanlis');
    /* and the till's own arithmetic for the same bill agrees, to the kurus */
    assert.strictEqual(Math.round(on.adisyon_kdv.vatTotal * 100), on.vat_minor,
      'faturanin KDVsi adisyonun KDVsinden farkli');
  });

  /* ---------------------------------------------------------------- */
  await step('e-ARSIV: mukellef degilse e-Arsiv; ETTN GONDERMEDEN ONCE yazilir; numara ve baglanti saklanir', async () => {
    Q.istekler.length = 0;
    const f = await fatura(ALICI_EARSIV);
    const r = await E.gonder(CTX, f.id);
    assert.ok(r.ok, 'gonderilemedi: ' + r.error);
    const inv = await oku(f.id);
    assert.strictEqual(inv.edoc_type, 'EARSIV');
    assert.strictEqual(inv.edoc_state, 'tamam');
    assert.ok(/^EAA2026\d{9}$/.test(inv.edoc_no), 'QNB numarasi saklanmamis: ' + inv.edoc_no);
    assert.ok(/goruntule\.jsp/.test(inv.edoc_url || ''), 'goruntuleme baglantisi saklanmamis');
    assert.strictEqual(inv.edoc_env, 'test');
    const olustur = Q.istekler.filter((i) => i.op === 'faturaOlusturExt');
    assert.strictEqual(olustur.length, 1, 'bir fatura icin ' + olustur.length + ' olusturma istegi');
    assert.strictEqual(olustur[0].inp.islemId, inv.edoc_uuid, 'islemId faturaya yazilan ETTN degil');
    assert.strictEqual(olustur[0].inp.erpKodu, 'BAG31527');
    assert.strictEqual(olustur[0].inp.sube, 'DFLT');
    assert.strictEqual(olustur[0].inp.numaraVerilsinMi, 1);
  });

  await step('PAROLA ILETISIM KAYDINA yazilmaz; SOAP basliginda gider', async () => {
    const kayitlar = await E.sonKayitlar(200);
    assert.ok(kayitlar.length, 'hic kayit yazilmamis');
    const hepsi = JSON.stringify(kayitlar);
    assert.ok(!hepsi.includes(SIFRE), 'PAROLA ILETISIM KAYDINDA duruyor');
    assert.ok(Q.istekler.some((i) => i.govde.includes('<wsse:Password>' + SIFRE + '</wsse:Password>')),
      'parola SOAP basliginda gitmiyor - kimlik dogrulama calismaz');
  });

  await step('"Nihai Tuketici" adina fatura KESILMEZ - QNBye hic gidilmez (GIB AE00313)', async () => {
    Q.istekler.length = 0;
    let hata = null;
    try { await fatura({ cust_title: 'Nihai Tüketici', cust_tax_no: '11111111111', cust_address: 'x, Alanya/Antalya' }); }
    catch (e) { hata = e.message; }
    assert.ok(hata && /Nihai/.test(hata), 'Nihai Tuketici adina fatura kesildi');
    assert.strictEqual(Q.istekler.length, 0, 'reddedilecek fatura icin QNBye istek gitmis');
  });

  /* ---------------------------------------------------------------- */
  await step('e-FATURA: mukellef alici -> NKT2026000000001, alici etiketi, MD5; kuyruk -> 1300 = tamam', async () => {
    Q.istekler.length = 0; Q.durum = '3'; Q.kod = null; Q.ulasti = null;
    const f = await fatura(ALICI);
    const r = await E.gonder(CTX, f.id);
    assert.ok(r.ok, 'gonderilemedi: ' + r.error);
    let inv = await oku(f.id);
    assert.strictEqual(inv.edoc_type, 'EFATURA');
    assert.strictEqual(inv.edoc_no, 'NKT2026000000001', 'numara yanlis: ' + inv.edoc_no);
    assert.strictEqual(inv.edoc_state, 'kuyrukta');
    assert.strictEqual(inv.edoc_label, 'urn:mail:defaultpk@alici.com.tr', 'alici posta kutusu saklanmamis');
    const g = Q.istekler.find((i) => i.op === 'belgeGonderExt');
    const veri = Buffer.from((/<veri>([\s\S]*?)<\/veri>/.exec(g.govde) || [])[1], 'base64');
    const md5 = crypto.createHash('md5').update(veri).digest('hex').toUpperCase();
    assert.ok(g.govde.includes('<belgeHash>' + md5 + '</belgeHash>'), 'belgeHash gonderilen baytlarin MD5i degil');
    assert.ok(g.govde.includes('<belgeTuru>FATURA_UBL</belgeTuru>'));
    assert.ok(veri.toString('utf8').includes('<cbc:ProfileID>TEMELFATURA</cbc:ProfileID>'), 'e-Faturada profil TEMELFATURA olmali');
    assert.ok(!veri.toString('utf8').includes('Gönderim Şekli'), 'e-Faturaya e-Arsiv notu girmis');
    const n = await E.kuyrukTara();
    assert.ok(n >= 1, 'kuyruk taranmadi');
    inv = await oku(f.id);
    assert.strictEqual(inv.edoc_state, 'tamam', 'durum 3 + 1300 tamama cevrilmedi');
  });

  await step('"durum 3" TEK BASINA basari degil: 1172 ulasmadi = hata, 1200 ulasmadi = kuyrukta', async () => {
    assert.strictEqual(E.gibKodu(1300, false), 'tamam');
    assert.strictEqual(E.gibKodu(1200, false), 'bekliyor');
    assert.strictEqual(E.gibKodu(1220, false), 'bekliyor');
    assert.strictEqual(E.gibKodu(1000, false), 'bekliyor');
    assert.strictEqual(E.gibKodu(1172, false), 'hata', 'posta kutusu yetkisi yok "tamam" sayiliyor');
    assert.strictEqual(E.gibKodu(1215, false), 'hata');
    assert.strictEqual(E.gibKodu(1160, false), 'hata');
    assert.strictEqual(E.gibKodu(1172, true), 'tamam', 'ulastiMi true her seye baskin');

    Q.durum = '3'; Q.kod = 1172; Q.ulasti = false;
    const f = await fatura(ALICI);
    await E.gonder(CTX, f.id);
    await E.durumSorgula(CTX, f.id);
    const inv = await oku(f.id);
    assert.strictEqual(inv.edoc_state, 'hata', 'GIB iletmedigi faturayi tamam saymis');
    assert.ok(/GİB fatura iletmedi/.test(inv.edoc_error || ''), 'sebep yazilmamis');
    Q.kod = null; Q.ulasti = null;
  });

  /* ---------------------------------------------------------------- */
  await step('YANIT KAYBOLDU (e-Arsiv): belirsiz; yeniden gondermede ONCE sorgulanir, IKINCI fatura OLUSMAZ', async () => {
    Q.istekler.length = 0;
    Q.earsiv = 'sonra-sessiz';           /* the document IS created, the answer is dropped */
    const f = await fatura(ALICI_EARSIV);
    const bir = await E.gonder(CTX, f.id, { zamanMs: 1200 });
    assert.ok(!bir.ok && bir.belirsiz, 'cevapsiz gonderim belirsiz sayilmadi');
    let inv = await oku(f.id);
    assert.strictEqual(inv.edoc_state, 'belirsiz');
    const ettn = inv.edoc_uuid;
    assert.ok(ettn, 'ETTN gonderimden once yazilmamis - kurtarma imkansiz');

    const iki = await E.gonder(CTX, f.id);
    inv = await oku(f.id);
    assert.strictEqual(inv.edoc_uuid, ettn, 'yeniden gonderimde YENI ETTN uretilmis: cift fatura');
    assert.strictEqual(inv.edoc_state, 'tamam', 'var olan belge sahiplenilmedi: ' + JSON.stringify(iki));
    const olustur = Q.istekler.filter((i) => i.op === 'faturaOlusturExt');
    assert.strictEqual(olustur.length, 1, 'ikinci olusturma istegi gitti: QNBde iki fatura olusabilirdi');
    assert.ok(Q.istekler.some((i) => i.op === 'faturaSorgula'), 'once sorgulanmadi');
    assert.strictEqual(Q.belgeler.size, [...Q.belgeler.keys()].length);
  });

  await step('HIC OLUSMAMISSA (AE00002) AYNI ETTN ile yeniden gonderilir', async () => {
    Q.istekler.length = 0;
    Q.earsiv = 'sessiz';
    const f = await fatura(ALICI_EARSIV);
    await E.gonder(CTX, f.id, { zamanMs: 1000 });
    let inv = await oku(f.id);
    const ettn = inv.edoc_uuid;
    assert.strictEqual(inv.edoc_state, 'belirsiz');
    Q.earsiv = 'ok';
    const r = await E.gonder(CTX, f.id);
    inv = await oku(f.id);
    assert.ok(r.ok || inv.edoc_state === 'tamam', 'hic olusmamis fatura yeniden gonderilemedi');
    assert.strictEqual(inv.edoc_uuid, ettn, 'olusmamis fatura icin yeni ETTN uretilmis');
    assert.strictEqual(inv.edoc_state, 'tamam');
  });

  await step('YANIT KAYBOLDU (e-Fatura): YEREL numarayla sorgulanir, numara DEGISMEZ', async () => {
    Q.istekler.length = 0;
    Q.efatura = 'sessiz';
    const f = await fatura(ALICI);
    await E.gonder(CTX, f.id, { zamanMs: 1000 });
    let inv = await oku(f.id);
    const no = inv.edoc_no;
    assert.ok(/^NKT2026\d{9}$/.test(no), 'numara gonderimden once yazilmamis');
    assert.strictEqual(inv.edoc_state, 'belirsiz');
    Q.efatura = 'ok';
    await E.gonder(CTX, f.id);
    inv = await oku(f.id);
    assert.strictEqual(inv.edoc_no, no, 'yeniden gonderimde YENI numara verilmis');
    const sorgu = Q.istekler.find((i) => i.op === 'gidenBelgeDurumSorgulaExt');
    assert.ok(sorgu && /<belgeNoTipi>YEREL</.test(sorgu.govde), 'OID yokken yerel numarayla sorulmadi');
  });

  /* ---------------------------------------------------------------- */
  await step('RESMI PDF: e-Arsiv gzipten, e-Fatura zipten cozulur', async () => {
    const a = await fatura(ALICI_EARSIV);
    await E.gonder(CTX, a.id);
    const pa = await E.pdf(CTX, a.id);
    assert.ok(pa.ok, pa.error);
    assert.strictEqual(pa.pdf.slice(0, 4).toString(), '%PDF', 'e-Arsiv PDFi gzipten cozulmedi');

    Q.durum = '3'; Q.kod = null; Q.ulasti = null;
    const b = await fatura(ALICI);
    await E.gonder(CTX, b.id);
    await E.durumSorgula(CTX, b.id);
    const pb = await E.pdf(CTX, b.id);
    assert.ok(pb.ok, pb.error);
    assert.strictEqual(pb.pdf.slice(0, 4).toString(), '%PDF', 'e-Fatura PDFi zipten cozulmedi');
  });

  await step('IPTAL: e-Arsiv once QNBde iptal edilir; e-Fatura programdan EDILEMEZ', async () => {
    const a = await fatura(ALICI_EARSIV);
    await E.gonder(CTX, a.id);
    const r = await F.iptal(CTX, a.id, { reason: 'musteri vazgecti' });
    assert.ok(r.ok, 'e-Arsiv iptal edilemedi: ' + r.error);
    const inv = await oku(a.id);
    assert.strictEqual(inv.edoc_state, 'iptal');
    assert.strictEqual(inv.status, 'cancelled');
    /* the bill's lines are released so the guest can be re-invoiced */
    const bagli = await db.value('SELECT COUNT(*) FROM invoice_items WHERE invoice_id=? AND order_item_id IS NOT NULL', [a.id]);
    assert.strictEqual(Number(bagli), 0, 'iptalde adisyon satirlari serbest birakilmadi');
    const yeni = await F.kes(CTX, a.orderId, ALICI_EARSIV);
    assert.ok(yeni.id, 'iptalden sonra yeniden faturalanamadi');

    const b = await fatura(ALICI);
    await E.gonder(CTX, b.id);
    await E.durumSorgula(CTX, b.id);
    const rb = await F.iptal(CTX, b.id, {});
    assert.ok(!rb.ok && /iptal edilemez/.test(rb.error), 'e-Fatura programdan iptal edildi');
    assert.strictEqual((await oku(b.id)).status, 'issued', 'iptal edilemeyen fatura yerelde iptal olmus');
  });

  await step('IADE: IADE tipi + asil faturaya BillingReference', async () => {
    const a = await fatura(ALICI);
    await E.gonder(CTX, a.id);
    await E.durumSorgula(CTX, a.id);
    const r = await F.iade(CTX, a.id, { reason: 'yemek geri gonderildi' });
    assert.ok(r.id, 'iade kesilemedi');
    const iade = await oku(r.id);
    assert.strictEqual(iade.kind, 'return');
    assert.strictEqual(Number(iade.parent_id), Number(a.id));
    const kalem = await db.query('SELECT * FROM invoice_items WHERE invoice_id=?', [r.id]);
    assert.ok(kalem.every((k) => k.order_item_id === null),
      'iade kalemleri adisyon satirina baglanmis: asil fatura ile catisir');
    const ana = await oku(a.id);
    const x = E.ubl(iade, kalem, { tip: 'EFATURA', no: 'NKT2026000000099', uuid: 'U', c: await E.conf(), ana });
    assert.ok(/<cbc:InvoiceTypeCode>IADE<\/cbc:InvoiceTypeCode>/.test(x), 'iade tipi yazilmamis');
    assert.ok(x.includes('<cac:BillingReference>') && x.includes(ana.edoc_no), 'asil faturaya referans yok');
    /* and a second return for the same invoice is refused */
    let ikinci = null;
    try { await F.iade(CTX, a.id, {}); } catch (e) { ikinci = e.message; }
    assert.ok(ikinci && /zaten/.test(ikinci), 'ayni faturaya iki iade kesildi');
  });

  /* ---------------------------------------------------------------- */
  await step('YANLIS PAROLA: anlasilir mesaj, fatura "hata" (belirsiz degil)', async () => {
    E.kilitAc();
    Q.sifreYanlis = true;
    const f = await fatura(ALICI_EARSIV);
    const r = await E.gonder(CTX, f.id);
    assert.ok(!r.ok, 'yanlis parolayla gonderim basarili gorundu');
    assert.ok(/parola/i.test(r.error), 'mesaj parolayi soylemiyor: ' + r.error);
    const inv = await oku(f.id);
    assert.strictEqual(inv.edoc_state, 'hata', 'yanlis parola "belirsiz" sayilmis: sonsuz kurtarma denemesi');
  });

  await step('YANLIS PAROLA gonderimi DURDURUR (QNB kullaniciyi bloke etmesin) - kayit acinca acilir', async () => {
    /* QNB, 30.09.2026: the portal password changes every three months and a
       service that keeps presenting the old one gets the user BLOCKED. */
    assert.ok(E.kilitliMi(), 'yanlis paroladan sonra gonderim kilitlenmedi');
    Q.istekler.length = 0;
    const f = await fatura(ALICI_EARSIV);
    const r = await E.gonder(CTX, f.id);
    assert.ok(!r.ok, 'kilitliyken gonderim denendi');
    assert.strictEqual(Q.istekler.length, 0, 'kilitliyken QNBye istek gitti: hesap bloke olur');
    assert.strictEqual(await E.kuyrukTara(), 0, 'kilitliyken kuyruk taramasi QNBye gitti');
    /* saving the settings is the only moment a new password can arrive */
    Q.sifreYanlis = false;
    await ayarla(port);
    assert.ok(!E.kilitliMi(), 'yeni parola kaydedilince kilit acilmadi');
    const r2 = await E.gonder(CTX, f.id);
    assert.ok(r2.ok || (await oku(f.id)).edoc_state === 'tamam', 'kilit acildiktan sonra gonderilemedi: ' + r2.error);
  });

  await step('BAGLANTI SINAMASI belge OLUSTURMAZ', async () => {
    Q.istekler.length = 0;
    const s = await E.sina();
    assert.ok(s.efatura.ok, 'e-Fatura sinanamadi: ' + JSON.stringify(s.efatura));
    assert.ok(s.earsiv.ok, 'e-Arsiv sinanamadi');
    assert.ok(!Q.istekler.some((i) => /faturaOlustur|belgeGonder/.test(i.op)), 'sinama belge olusturdu');
  });

  await step('KONTOR: kalan/alinan/bitis okunur ve saklanir; 50 alti uyarilir', async () => {
    const k = await E.kontor();
    assert.strictEqual(k.efatura.kalan, 42);
    assert.strictEqual(k.efatura.toplam, 500);
    assert.strictEqual(k.efatura.bitis, '20271231');
    assert.strictEqual(k.earsiv.kalan, 1200);
    const saklanan = await E.kontorOku();
    assert.strictEqual(saklanan.efatura.kalan, 42, 'kontor ayarlara yazilmadi');
    assert.ok(42 < E.KONTOR_AZ, 'az kontor esigi 50 olmali');
  });

  /* ---------------------------------------------------------------- */
  await step('ORTAM: test parolasi CANLIya tasinmaz, numara sirasi ortam basina sayilir', async () => {
    const st = await db.one('SELECT id, tax_number FROM business_settings WHERE client_id=? LIMIT 1', [CID]);
    const eski = st ? st.tax_number : null;
    await db.exec('UPDATE business_settings SET tax_number=? WHERE client_id=?', ['3890125539', CID]);
    const r = await E.kaydet(CTX, { aktif: 1, ortam: 'canli', efatura_kullanici: 'x', earsiv_kullanici: 'x', efatura_seri: 'NKT' });
    assert.ok(r.ok, 'canliya gecilemedi: ' + r.error);
    const c = await E.conf();
    assert.strictEqual(c.ortam, 'canli');
    assert.strictEqual(c.efatura_sifre, '', 'TEST PAROLASI CANLIYA TASINDI');
    assert.strictEqual(c.earsiv_sifre, '', 'TEST PAROLASI CANLIYA TASINDI');
    assert.ok(/qnbesolutions\.com\.tr/.test(c.efatura_url) && !/test/.test(c.efatura_url),
      'canlida test adresi kullaniliyor: ' + c.efatura_url);

    /* a different VKN is refused outright in live */
    const baska = await E.kaydet(CTX, { aktif: 1, ortam: 'canli', vkn: '1111111111', efatura_seri: 'NKT' });
    assert.ok(!baska.ok && /kendi VKN/.test(baska.error), 'canlida baska firmanin VKNsi kabul edildi');

    /* numbering restarts per environment: test spent NKT2026000000001.. */
    await db.tx(async (t) => {
      const no = await E.sonrakiEfaturaNo(t, 'NKT', '2026', 'canli');
      assert.strictEqual(no, 'NKT2026000000001', 'testte harcanan numaralar canli sirayi kaydirmis: ' + no);
    });
    if (eski !== null) await db.exec('UPDATE business_settings SET tax_number=? WHERE client_id=?', [eski, CID]);
    await ayarla(port);
  });

  await step('TESTTE olusmus belge CANLIya tasinmaz', async () => {
    const f = await fatura(ALICI_EARSIV);
    await E.gonder(CTX, f.id);
    assert.strictEqual((await oku(f.id)).edoc_state, 'tamam');
    await db.exec("UPDATE np_settings SET v='canli' WHERE k='ebelge.ortam'");
    const r = await E.gonder(CTX, f.id);
    assert.ok(!r.ok && /taşınamaz/.test(r.error), 'test belgesi canliya tasindi: ' + JSON.stringify(r));
    await ayarla(port);
  });

  await step('MUKELLEF sorgusu ortam basina onbelleklenir', async () => {
    E._mukellefCache.clear();
    Q.istekler.length = 0;
    await E.mukellef('3890125540');
    await E.mukellef('3890125540');
    assert.strictEqual(Q.istekler.filter((i) => i.op === 'efaturaKullaniciBilgisi').length, 1, 'onbellek calismiyor');
    const c = await E.conf();
    const anahtarlar = [...E._mukellefCache.keys()];
    assert.ok(anahtarlar.every((k) => k.startsWith(c.ortam + '|')), 'onbellek anahtarinda ortam yok: test sicili canli karari verir');
  });

  await step('GUVENLIK: parola duz http ile gitmez, zip bombasi bellegi sismez', async () => {
    const r = await E.soap('http://qnbesolutions.com.tr/x', 'k', 'p', 'ns', '<a/>', { zamanMs: 500 });
    assert.ok(!r.ok && /https/.test(r.error), 'parola sifresiz baglantiyla gonderilebiliyor');
    const bomba = zlib.gzipSync(Buffer.alloc(64 * 1048576, 0x41));
    assert.throws(() => E.coz(bomba.toString('base64')), 'zip bombasi acildi');
  });

  /* ================================================================ */
  /*  GELEN                                                           */
  /* ================================================================ */
  await step('GELEN: QNB listesi kaydedilir, ikinci cekme kopya yapmaz, kalemler UBLden okunur', async () => {
    Q.gelen = [
      { no: 'TDR2026000000001', tarih: '20260925', ettn: 'aaaaaaaa-1111-2222-3333-444444444444', senaryo: 'TICARIFATURA' },
      { no: 'TDR2026000000002', tarih: '20260926', ettn: 'bbbbbbbb-1111-2222-3333-444444444444', senaryo: 'TEMELFATURA' },
    ];
    const bir = await G.cek(CTX);
    assert.ok(bir.ok, bir.error);
    assert.strictEqual(bir.yeni, 2);
    const iki = await G.cek(CTX);
    assert.strictEqual(iki.yeni, 0, 'ikinci cekme kopya olusturdu');
    const say = await G.sayac();
    assert.strictEqual(say.toplam, 2);
    assert.strictEqual(say.bekleyen, 1, 'yalnizca TICARI fatura yanit bekler');
    const liste = await G.liste({});
    const g = liste.find((x) => x.belge_no === 'TDR2026000000001');
    assert.strictEqual(Number(g.tutar_minor), 36000, 'tutar kurusa cevrilmemis');
    assert.strictEqual(String(g.belge_tarihi).slice(0, 10), '2026-09-25');
    const tam = await G.getir(g.id);
    const s = G.satirlar(tam.xml)[0];
    assert.deepStrictEqual(
      { ad: s.ad, miktar: s.miktar, birimFiyat: s.birimFiyat, tutar: s.tutar, kdvOran: s.kdvOran, kdv: s.kdv },
      { ad: 'Un 25kg', miktar: 3, birimFiyat: 10000, tutar: 30000, kdvOran: 20, kdv: 6000 });
    const istek = Q.istekler.filter((i) => i.op === 'gelenBelgeleriListeleExt').pop();
    assert.ok(/<gelisTarihiBaslangic>\d{8}</.test(istek.govde), 'tarih araligi 8 haneli degil');
  });

  await step('GELEN: TEMEL faturaya yanit verilmez, RED sebepsiz gitmez, 8 GUN kurali', async () => {
    const liste = await G.liste({});
    const temel = liste.find((x) => x.senaryo === 'TEMELFATURA');
    const r = await G.yanitVer(CTX, temel.id, { karar: 'KABUL' });
    assert.ok(!r.ok && /TEMEL/.test(r.error), 'TEMEL faturaya yanit verildi');
    const ticari = liste.find((x) => x.senaryo === 'TICARIFATURA');
    const red = await G.yanitVer(CTX, ticari.id, { karar: 'RED', neden: '' });
    assert.ok(!red.ok && /sebep/.test(red.error), 'sebepsiz RED gitti');
    assert.strictEqual((await G.getir(ticari.id)).yanit, null, 'reddedilen denemede yanit yazilmis');

    const g = { senaryo: 'TICARIFATURA', gelis_tarihi: '2026-09-20', qnb_yanit: 0 };
    const gun = (n) => Date.parse('2026-09-20') + n * 86400000;
    assert.strictEqual(G.yanitlanabilir(g, gun(7)).ok, true, '7. gunde yanit verilemiyor');
    assert.strictEqual(G.yanitlanabilir(g, gun(9)).ok, false, '9. gunde hala yanit verilebiliyor');
    assert.ok(/8 gün/.test(G.yanitlanabilir(g, gun(9)).neden));
    assert.strictEqual(G.yanitlanabilir({ senaryo: 'TICARIFATURA', qnb_yanit: 1 }).ok, false, 'QNB yanitlandi dedigi fatura yanitlanabiliyor');
  });

  await step('GELEN KABUL: UYGULAMA_YANITI_UBL, tedarikcinin posta kutusu, ikinci yanit gitmez', async () => {
    Q.istekler.length = 0;
    const ticari = (await G.liste({})).find((x) => x.senaryo === 'TICARIFATURA');
    const r = await G.yanitVer(CTX, ticari.id, { karar: 'KABUL' });
    assert.ok(r.ok, 'kabul gonderilemedi: ' + r.error);
    const g = await G.getir(ticari.id);
    assert.strictEqual(g.yanit, 'KABUL');
    assert.strictEqual(g.yanit_durum, 'gonderildi');
    assert.ok(g.yanit_uuid, 'yanit ETTNsi yazilmamis');
    const i = Q.istekler.find((x) => x.op === 'belgeGonderExt');
    assert.ok(/<belgeTuru>UYGULAMA_YANITI_UBL</.test(i.govde), 'yanit belge turu yanlis');
    assert.ok(/<alanEtiket>urn:mail:defaultgb@tedarik\.com\.tr</.test(i.govde), 'yanit tedarikcinin kutusuna gitmiyor');
    assert.ok(/<erpKodu>BAG31527</.test(i.govde));
    const xml = Buffer.from((/<veri>([\s\S]*?)<\/veri>/.exec(i.govde) || [])[1], 'base64').toString('utf8');
    assert.ok(/<cbc:ResponseCode>KABUL<\/cbc:ResponseCode>/.test(xml));
    assert.ok(xml.includes('<cbc:ReferenceID>' + g.uuid.toUpperCase() + '</cbc:ReferenceID>'), 'yanit faturanin ETTNsine baglanmamis');
    const ikinci = await G.yanitVer(CTX, ticari.id, { karar: 'RED', neden: 'fikrimi degistirdim' });
    assert.ok(!ikinci.ok && /zaten/.test(ikinci.error), 'ayni faturaya ikinci yanit gitti');
    assert.strictEqual((await G.sayac()).bekleyen, 0);
  });

  await step('GELEN: QNB yaniti reddederse AYNI yanit kimligiyle yeniden gonderilir', async () => {
    Q.gelen = [{ no: 'TDR2026000000003', tarih: '20260928', ettn: 'cccccccc-1111-2222-3333-444444444444', senaryo: 'TICARIFATURA' }];
    await G.cek(CTX);
    const g0 = (await G.liste({})).find((x) => x.belge_no === 'TDR2026000000003');
    Q.yanitHata = true;
    const bir = await G.yanitVer(CTX, g0.id, { karar: 'RED', neden: 'mal eksik geldi' });
    assert.ok(!bir.ok, 'QNB reddettigi halde basarili gorundu');
    let g = await G.getir(g0.id);
    assert.strictEqual(g.yanit_durum, 'hata');
    const kimlik = g.yanit_uuid;
    assert.ok(kimlik, 'yanit ETTNsi gonderimden once yazilmamis');
    Q.yanitHata = false; Q.istekler.length = 0;
    const iki = await G.yanitVer(CTX, g0.id, { karar: 'RED', neden: 'mal eksik geldi' });
    assert.ok(iki.ok, 'yeniden gonderilemedi: ' + iki.error);
    g = await G.getir(g0.id);
    assert.strictEqual(g.yanit_uuid, kimlik, 'yeniden denemede YENI yanit kimligi uretilmis: tedarikciye iki yanit');
    assert.strictEqual(g.yanit_durum, 'gonderildi');
  });

  await step('GELEN: RESMI PDF cozulur; alisa aktarim tedarikciyi bir kez acar, satirlari tasir', async () => {
    const g0 = (await G.liste({})).find((x) => x.belge_no === 'TDR2026000000001');
    const p = await G.pdf(CTX, g0.id);
    assert.ok(p.ok, p.error);
    assert.strictEqual(p.pdf.slice(0, 4).toString(), '%PDF');

    await db.exec("DELETE FROM suppliers WHERE client_id=? AND vkn='1234567890'", [CID]);
    const a = await G.alisaAktar(CTX, g0.id);
    assert.ok(a.ok, a.error);
    assert.ok(a.yeniTedarikci, 'tedarikci acilmadi');
    assert.strictEqual(a.satir, 1, 'UBL satirlari taslak alisa tasinmadi');
    const doc = await db.one('SELECT * FROM inventory_documents WHERE id=?', [a.documentId]);
    assert.strictEqual(doc.status, 'draft', 'gelen fatura dogrudan onaylanmis: stok kendiliginden hareket eder');
    assert.strictEqual(doc.document_no, 'TDR2026000000001');
    const satir = await db.query('SELECT * FROM inventory_document_items WHERE document_id=?', [a.documentId]);
    assert.strictEqual(satir[0].raw_name, 'Un 25kg');
    assert.strictEqual(satir[0].item_id, null, 'urun eslestirilmis gibi yazilmis');
    const tekrar = await G.alisaAktar(CTX, g0.id);
    assert.ok(tekrar.zaten, 'ikinci aktarim ikinci alis belgesi acti');
    assert.strictEqual(Number(await db.value("SELECT COUNT(*) FROM suppliers WHERE client_id=? AND vkn='1234567890'", [CID])), 1);

    const red = (await G.liste({})).find((x) => x.yanit === 'RED');
    if (red) {
      const r = await G.alisaAktar(CTX, red.id);
      assert.ok(!r.ok && /Reddedilen/.test(r.error), 'reddedilen fatura alisa aktarildi');
    }
  });

  await step('GELEN: ortam anahtarin parcasi - ayni ETTN test ve canlida AYRI satir', async () => {
    /* Every row pulled so far arrived in test; none of them may be visible,
       or answerable, once live is selected. */
    await db.exec("UPDATE gelen_belge SET ortam='test' WHERE client_id=?", [CID]);
    await db.exec("UPDATE np_settings SET v='canli' WHERE k='ebelge.ortam'");
    const testtekiler = await G.liste({});
    assert.strictEqual(testtekiler.length, 0, 'test gelenleri canli listede gorunuyor');
    await ayarla(port);
    assert.ok((await G.liste({})).length >= 3, 'test gelenleri kayboldu');
    const satir = await db.query('SELECT ortam FROM gelen_belge WHERE client_id=? AND uuid=?',
      [CID, 'AAAAAAAA-1111-2222-3333-444444444444']);
    assert.ok(satir.length <= 1 && (satir.length === 0 || satir[0].ortam === 'test'));
  });

  /* ---------------------------------------------------------------- */
  await step('BULUT YEDEGI QNB kullanici adi ve parolasini TASIMAZ', async () => {
    /* One backup a night leaves the building. The settings screen promises the
       QNB credentials stay on this PC, so the cloud dump has to be missing
       them - not merely encrypted in them. */
    const backup = require('../src/backup');
    const disi = backup.BULUTA_GITMEZ;
    assert.ok(Array.isArray(disi) && disi.length, 'buluta gitmeyecek anahtar listesi yok');
    for (const k of ['ebelge.efatura_sifre', 'ebelge.earsiv_sifre', 'ebelge.efatura_kullanici', 'ebelge.earsiv_kullanici']) {
      assert.ok(disi.includes(k), k + ' bulut yedegine giriyor');
    }
    assert.ok(!disi.includes('ebelge.ortam'), 'ortam ayari da bulut yedeginden cikarilmis');

    /* and the dump really is filtered, not just the list */
    const yedek = await backup.run('cloud');
    const metin = zlib.gunzipSync(require('fs').readFileSync(yedek.file)).toString('utf8');
    assert.ok(metin.includes('np_settings'), 'ayarlar tablosu bulut yedeginde hic yok');
    assert.ok(!metin.includes(SIFRE), 'PAROLA BULUT YEDEGINDE');
    assert.ok(!metin.includes('3890125539.portaltest'), 'QNB KULLANICI ADI BULUT YEDEGINDE');
    assert.ok(metin.includes("'ebelge.ortam'"), 'ortam ayari yedekten dusmus: geri yukleme eksik kalir');
    require('fs').unlinkSync(yedek.file);
  });

  /* ================================================================ */
  /*  HTTP: the endpoints as the screens call them                     */
  /* ================================================================ */
  /*
   * The checks above drive the modules directly, which is where the rules
   * live. These drive the ROUTER, because a rule enforced in a module that
   * no endpoint reaches is not enforced, and because the permission split
   * between "issue an invoice for the guest at the till" and "hold the QNB
   * account" is only real if the gates say so.
   */
  await step('HTTP: uclar calisiyor ve yetki ayrimi gercek', async () => {
    const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
    const admin = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Sahip', kind: 'pos' });
    const al = async (method, yol, govde) => {
      const res = await fetch(BASE + yol, {
        method,
        headers: Object.assign({ Authorization: 'Bearer ' + admin }, govde ? { 'Content-Type': 'application/json' } : {}),
        body: govde ? JSON.stringify(govde) : undefined,
      });
      const ct = res.headers.get('content-type') || '';
      return { status: res.status, body: ct.includes('json') ? await res.json() : await res.arrayBuffer() };
    };

    const ayar = await al('GET', '/api/ebelge/ayarlar');
    assert.strictEqual(ayar.status, 200);
    assert.ok(ayar.body.ayar.efatura_sifre_var, 'parola var bilgisi gelmiyor');
    /* the screen is told a password EXISTS and never what it is */
    assert.ok(!JSON.stringify(ayar.body).includes(SIFRE), 'PAROLA AYAR UCUNDAN DONUYOR');

    assert.strictEqual((await al('POST', '/api/ebelge/ayarlar', {
      aktif: 1, otomatik: 0, ortam: 'test', vkn: '3890125539',
      efatura_kullanici: '3890125539', earsiv_kullanici: '3890125539.portaltest',
      efatura_url: 'http://127.0.0.1:' + port + '/efatura', earsiv_url: 'http://127.0.0.1:' + port + '/earsiv',
      efatura_seri: 'NKT', fatura_seri: 'FTR', il: 'Antalya', ilce: 'Alanya',
    })).status, 200, 'ayar kaydedilemedi');
    assert.strictEqual((await al('POST', '/api/ebelge/sina')).status, 200);
    assert.strictEqual((await al('POST', '/api/ebelge/kontor')).status, 200);
    assert.strictEqual((await al('GET', '/api/ebelge/gunluk?n=5')).status, 200);
    assert.strictEqual((await al('GET', '/api/ebelge/faturalar?gun=180')).status, 200);

    const oid = await adisyon({ satirlar: [{ qty: 1, price: 200, vat: 10 }] });
    const on = await al('GET', `/api/ebelge/adisyon/${oid}/onizle`);
    assert.strictEqual(on.status, 200);
    assert.ok(on.body.not && /ÖKC/.test(on.body.not), 'onizlemede fis notu yok');
    const kes = await al('POST', `/api/ebelge/adisyon/${oid}/kes`, ALICI_EARSIV);
    assert.strictEqual(kes.status, 200, JSON.stringify(kes.body));
    const fid = kes.body.id;
    assert.strictEqual((await al('GET', `/api/ebelge/faturalar/${fid}`)).status, 200);
    assert.strictEqual((await al('POST', `/api/ebelge/faturalar/${fid}/gonder`)).status, 200);
    assert.strictEqual((await al('POST', `/api/ebelge/faturalar/${fid}/durum`)).status, 200);
    const pdf = await al('GET', `/api/ebelge/faturalar/${fid}/pdf`);
    assert.strictEqual(pdf.status, 200);
    assert.strictEqual(Buffer.from(pdf.body).slice(0, 4).toString(), '%PDF', 'uc PDF dondurmedi');
    const iade = await al('POST', `/api/ebelge/faturalar/${fid}/iade`, { reason: 'deneme' });
    assert.strictEqual(iade.status, 200, JSON.stringify(iade.body));
    assert.strictEqual((await al('POST', `/api/ebelge/faturalar/${fid}/iptal`, { reason: 'deneme' })).status, 200);

    assert.strictEqual((await al('GET', '/api/ebelge/gelen')).status, 200);
    assert.strictEqual((await al('POST', '/api/ebelge/gelen/cek')).status, 200);
    const gliste = (await al('GET', '/api/ebelge/gelen')).body.gelen;
    const bir = gliste[0];
    assert.strictEqual((await al('GET', `/api/ebelge/gelen/${bir.id}`)).status, 200);
    const gpdf = await al('GET', `/api/ebelge/gelen/${bir.id}/pdf`);
    assert.strictEqual(gpdf.status, 200);
    const bekleyen = gliste.find((g) => g.senaryo === 'TICARIFATURA' && !g.yanit);
    if (bekleyen) assert.strictEqual((await al('POST', `/api/ebelge/gelen/${bekleyen.id}/yanit`, { karar: 'KABUL' })).status, 200);
    const aktarilacak = gliste.find((g) => !g.document_id && g.yanit !== 'RED');
    if (aktarilacak) assert.strictEqual((await al('POST', `/api/ebelge/gelen/${aktarilacak.id}/alis`)).status, 200);

    /* --- the permission split --- */
    const kasiyer = await auth.issueToken({ cid: CID, uid: 9911, role: 'cashier', name: 'Kasiyer', kind: 'pos' });
    const garson = await auth.issueToken({ cid: CID, uid: 9912, role: 'waiter', name: 'Garson', kind: 'pos' });
    const kim = async (t, method, yol) => (await fetch(BASE + yol, { method, headers: { Authorization: 'Bearer ' + t } })).status;
    assert.notStrictEqual(await kim(kasiyer, 'GET', `/api/ebelge/adisyon/${oid}/onizle`), 403,
      'kasiyer fatura kesemiyor - misafiri bekleten sey tam olarak bu');
    assert.strictEqual(await kim(kasiyer, 'GET', '/api/ebelge/ayarlar'), 403,
      'kasiyer QNB hesabini gorebiliyor');
    assert.strictEqual(await kim(kasiyer, 'POST', '/api/ebelge/gelen/cek'), 403,
      'kasiyer tedarikci faturasi cekebiliyor');
    assert.strictEqual(await kim(garson, 'GET', `/api/ebelge/adisyon/${oid}/onizle`), 403,
      'garson fatura kesebiliyor');
  });

  /* ----------------------------------------------------------------
     Put the catalogue back.

     This suite writes real bills, and a bill needs a real product. Left
     behind, that product and those tables are counted by every suite that
     runs after this one and reports a failure about something it never
     touched. The invoices themselves are cleared at the top of the run,
     where they can still be looked at after a failure. */
  const benimSiparisler = await db.query(
    'SELECT id FROM orders WHERE client_id=? AND table_id=? AND adisyon_no >= 1000', [CID, masaId]);
  for (const o of benimSiparisler) {
    await db.exec('DELETE FROM fiscal_receipts WHERE order_id=? AND client_id=?', [o.id, CID]);
    await db.exec('DELETE FROM fiscal_transactions WHERE order_id=? AND client_id=?', [o.id, CID]);
    await db.exec('DELETE FROM order_payments WHERE order_id=? AND client_id=?', [o.id, CID]);
    await db.exec('DELETE FROM order_discounts WHERE order_id=? AND client_id=?', [o.id, CID]);
    await db.exec('DELETE FROM order_items WHERE order_id=? AND client_id=?', [o.id, CID]);
    await db.exec('DELETE FROM orders WHERE id=? AND client_id=?', [o.id, CID]);
  }
  if (urunId) await db.exec('DELETE FROM products WHERE id=? AND client_id=?', [urunId, CID]);

  /* ---------------------------------------------------------------- */
  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  qnb.close();
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
