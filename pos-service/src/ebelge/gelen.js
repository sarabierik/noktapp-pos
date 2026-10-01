'use strict';
/* =====================================================================
   INCOMING e-FATURAS (QNB eSolutions)             src/ebelge/gelen.js
   ---------------------------------------------------------------------
   The supplier's invoices to the restaurant land in its QNB mailbox.
   This pulls them in, keeps them, opens the official PDF, answers a
   TİCARİ invoice with KABUL / RED, and turns one into a draft stock
   entry document.

   QNB OPERATIONS (read from the test WSDL, 29.09.2026)
   * gelenBelgeleriListeleExt(parametreler: vergiTcKimlikNo, belgeTuru
     FATURA, gelisTarihiBaslangic/Bitis) -> return (belgev2): belgeNo,
     belgeTarihi, ettn, faturaSenaryo, gonderenVknTckn, gonderenIsim,
     gonderenEtiket, payableAmount, dovizCinsi, yanitDurumu, yanitDetayi,
     belgeXmlZipped.
   * gelenBelgeIndirExt(vergiTcKimlikNo, belgeEttn, belgeTuru,
     belgeFormati) -> the document as PDF or UBL.
   * The answer goes out through belgeGonderExt with belgeTuru
     UYGULAMA_YANITI_UBL, which takes the same parameters as FATURA_UBL.

   RULES
   * Only a TİCARİ invoice is answered, and the GİB deadline is 8 days
     from receipt. A TEMEL invoice gets no answer at all; there is no
     button for it, because pressing one would do nothing legally.
   * The answer's own ETTN is written down BEFORE the request leaves, so
     a retry reuses it and a second answer never reaches one invoice.
   * An incoming record is never deleted, not even after it has been
     turned into a stock document.

   WHAT DIFFERS FROM NOKTAPPERA. Noktappera opened an EMPTY draft
   purchase and left the operator to type the lines again from the PDF.
   The till already reads the UBL to show the lines, so the draft is
   created WITH them (unmatched, raw_name only) and the existing stock
   matching screen does what it was built for.
   ===================================================================== */
const crypto = require('crypto');
const db = require('../db');
const E = require('./index');
const envanter = require('../modules/inventory');

const YANIT_GUN = 8;

const gun = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const tarihYaz = (s) => {
  const t = String(s || '').replace(/\D/g, '');
  return t.length >= 8 ? t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8) : null;
};
const kurus = (s) => {
  const n = Number(String(s == null ? '' : s).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * Pull the mailbox.
 *
 * The window starts two days BEFORE the last pull, on purpose: QNB lists
 * by arrival date and a document that arrived while the previous pull was
 * running would otherwise never be seen again. Re-reading a document is
 * free (the ETTN is the key); missing one is not.
 */
async function cek(ctx, { gunSayisi = 30 } = {}) {
  const clientId = await db.getClientId();
  const c = await E.conf();
  if (!c.aktif) return { ok: false, error: 'e-Fatura / e-Arşiv kapalı (Ayarlar → e-Fatura / e-Arşiv).' };
  const bit = new Date(Date.now() + 86400000);
  const son = await db.getSetting('ebelge.gelen_son_' + c.ortam, '');
  const bas = son ? new Date(Date.parse(son) - 2 * 86400000) : new Date(Date.now() - gunSayisi * 86400000);
  const r = await E.cagir(null, 'efatura', 'gelenBelgeleriListeleExt',
    `<ser:gelenBelgeleriListeleExt><parametreler><belgeTuru>FATURA</belgeTuru>`
    + `<gelisTarihiBaslangic>${gun(bas)}</gelisTarihiBaslangic><gelisTarihiBitis>${gun(bit)}</gelisTarihiBitis>`
    + `<vergiTcKimlikNo>${E.xe(c.vkn)}</vergiTcKimlikNo></parametreler></ser:gelenBelgeleriListeleExt>`,
    { conf: c, zamanMs: 60000 });
  if (!r.ok) return { ok: false, error: r.error || ('QNB yanıt vermedi (HTTP ' + r.status + ').') };
  let yeni = 0, guncel = 0;
  for (const x of E.etiketler(r.text, 'return')) {
    const g = (a) => E.etiket(x, a);
    const uuid = String(g('ettn') || '').trim().toUpperCase();
    if (!uuid) continue;
    /* The content is the SUPPLIER's. A failed or oversized decompression
       must not lose the row; it just arrives without its lines. */
    let xml = null;
    const z = g('belgeXmlZipped') || g('belgeVerisi');
    if (z) {
      try {
        const b = E.coz(z);
        if (b.slice(0, 200).toString('utf8').includes('<')) xml = b.toString('utf8');
      } catch (e) { xml = null; }
    }
    const varOlan = await db.one('SELECT id FROM gelen_belge WHERE client_id=? AND ortam=? AND uuid=?',
      [clientId, c.ortam, uuid]);
    const alanlar = {
      belge_no: g('belgeNo'), belge_tarihi: tarihYaz(g('belgeTarihi')), senaryo: g('faturaSenaryo'),
      gonderen_vkn: g('gonderenVknTckn'), gonderen: g('gonderenIsim') || g('saticiUnvan'),
      gonderen_etiket: g('gonderenEtiket'),
      tutar_minor: kurus(g('payableAmount') || g('odenecekTutar')), doviz: g('dovizCinsi') || 'TRY',
      qnb_yanit: g('yanitDurumu') == null ? null : Number(g('yanitDurumu')),
      qnb_yanit_detay: g('yanitDetayi'),
    };
    if (varOlan) {
      /* Only the fields QNB actually sent are overwritten, and an XML we
         already hold is kept: a later listing often omits the content. */
      const k = Object.keys(alanlar).filter((a) => alanlar[a] != null);
      if (k.length || xml) {
        await db.exec(
          `UPDATE gelen_belge SET ${k.map((a) => a + ' = ?').join(', ')}${k.length && xml ? ',' : ''}${xml ? ' xml = COALESCE(xml, ?)' : ''} WHERE id = ?`,
          [...k.map((a) => alanlar[a]), ...(xml ? [xml] : []), varOlan.id]);
      }
      guncel++;
    } else {
      await db.insert(
        `INSERT INTO gelen_belge (client_id, ortam, uuid, gelis_tarihi, belge_no, belge_tarihi, senaryo,
            gonderen_vkn, gonderen, gonderen_etiket, tutar_minor, doviz, qnb_yanit, qnb_yanit_detay, xml)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [clientId, c.ortam, uuid, E.simdi().slice(0, 10), alanlar.belge_no, alanlar.belge_tarihi, alanlar.senaryo,
         alanlar.gonderen_vkn, alanlar.gonderen, alanlar.gonderen_etiket, alanlar.tutar_minor || 0,
         alanlar.doviz, alanlar.qnb_yanit || 0, alanlar.qnb_yanit_detay, xml]);
      yeni++;
    }
  }
  await db.setSetting('ebelge.gelen_son_' + c.ortam, new Date().toISOString());
  return { ok: true, yeni, guncel };
}

async function liste({ q = '', bekleyen = false } = {}) {
  const c = await E.conf();
  const w = ['client_id = ?', 'ortam = ?']; const p = [await db.getClientId(), c.ortam];
  if (q) {
    w.push('(belge_no LIKE ? OR gonderen LIKE ? OR gonderen_vkn LIKE ?)');
    p.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
  }
  if (bekleyen) w.push("senaryo = 'TICARIFATURA' AND yanit IS NULL");
  return db.query(
    `SELECT id, ortam, uuid, belge_no, belge_tarihi, gelis_tarihi, senaryo, gonderen_vkn, gonderen,
            tutar_minor, doviz, qnb_yanit, yanit, yanit_durum, yanit_hata, document_id
       FROM gelen_belge WHERE ${w.join(' AND ')}
      ORDER BY COALESCE(belge_tarihi, gelis_tarihi) DESC, id DESC LIMIT 500`, p);
}
async function getir(id) {
  return db.one('SELECT * FROM gelen_belge WHERE id = ? AND client_id = ?', [id, await db.getClientId()]);
}

/** Can this one be answered? { ok } or { ok:false, neden }. */
function yanitlanabilir(g, simdi = Date.now()) {
  if (!g) return { ok: false, neden: 'Fatura bulunamadı.' };
  if (g.senaryo !== 'TICARIFATURA') return { ok: false, neden: 'TEMEL faturaya kabul/red yanıtı verilmez.' };
  if (g.yanit) return { ok: false, neden: 'Bu faturaya zaten ' + g.yanit + ' yanıtı verildi.' };
  if (g.qnb_yanit != null && Number(g.qnb_yanit) > 0) return { ok: false, neden: 'QNB bu faturanın yanıtlandığını bildiriyor.' };
  const bas = Date.parse(g.gelis_tarihi || g.belge_tarihi || '');
  if (Number.isFinite(bas) && simdi - bas > YANIT_GUN * 86400000) {
    return { ok: false, neden: 'Yanıt süresi (8 gün) doldu; fatura kabul edilmiş sayılır.' };
  }
  return { ok: true };
}

/* UBL-TR 1.2 ApplicationResponse. */
function yanitXml({ uuid, karar, neden, g, c, tarih, saat }) {
  const faturaTarihi = String(g.belge_tarihi || tarih).slice(0, 10);
  const taraf = (vkn, unvan) =>
    `<cac:PartyIdentification><cbc:ID schemeID="${String(vkn).length === 11 ? 'TCKN' : 'VKN'}">${E.xe(vkn)}</cbc:ID></cac:PartyIdentification>`
    + `<cac:PartyName><cbc:Name>${E.xe(unvan || '-')}</cbc:Name></cac:PartyName>`
    + `<cac:PostalAddress><cbc:CitySubdivisionName>${E.xe(c.ilce || '-')}</cbc:CitySubdivisionName>`
    + `<cbc:CityName>${E.xe(c.il || '-')}</cbc:CityName><cac:Country><cbc:Name>Türkiye</cbc:Name></cac:Country></cac:PostalAddress>`;
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"'
    + ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"'
    + ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"'
    + ' xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">'
    + '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>'
    + '<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>TR1.2</cbc:CustomizationID><cbc:ProfileID>TICARIFATURA</cbc:ProfileID>'
    + `<cbc:ID>${uuid}</cbc:ID><cbc:UUID>${uuid}</cbc:UUID><cbc:IssueDate>${tarih}</cbc:IssueDate><cbc:IssueTime>${saat}</cbc:IssueTime>`
    + (neden ? `<cbc:Note>${E.xe(String(neden).slice(0, 500))}</cbc:Note>` : '')
    + `<cac:Signature><cbc:ID schemeID="VKN_TCKN">${E.xe(c.vkn)}</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID schemeID="${c.vkn.length === 11 ? 'TCKN' : 'VKN'}">${E.xe(c.vkn)}</cbc:ID></cac:PartyIdentification>`
    + `<cac:PostalAddress><cbc:CitySubdivisionName>${E.xe(c.ilce || '-')}</cbc:CitySubdivisionName><cbc:CityName>${E.xe(c.il || '-')}</cbc:CityName><cac:Country><cbc:Name>Türkiye</cbc:Name></cac:Country></cac:PostalAddress>`
    + '</cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#Signature</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>'
    + `<cac:SenderParty>${taraf(c.vkn, c.unvan)}</cac:SenderParty>`
    + `<cac:ReceiverParty>${taraf(g.gonderen_vkn, g.gonderen)}</cac:ReceiverParty>`
    + '<cac:DocumentResponse>'
    + `<cac:Response><cbc:ReferenceID>${E.xe(g.uuid)}</cbc:ReferenceID><cbc:ResponseCode>${karar}</cbc:ResponseCode>`
    + (neden ? `<cbc:Description>${E.xe(String(neden).slice(0, 500))}</cbc:Description>` : '') + '</cac:Response>'
    + `<cac:DocumentReference><cbc:ID>${E.xe(g.uuid)}</cbc:ID><cbc:IssueDate>${faturaTarihi}</cbc:IssueDate>`
    + '<cbc:DocumentTypeCode>FATURA</cbc:DocumentTypeCode><cbc:DocumentType>FATURA</cbc:DocumentType></cac:DocumentReference>'
    + '</cac:DocumentResponse></ApplicationResponse>';
}

const _kilit = new Set();
/**
 * Send KABUL / RED.
 *
 * The response ETTN is written to the row before the request goes out and
 * a retry reuses the stored one, so the supplier never receives two
 * different answers to the same invoice.
 */
async function yanitVer(ctx, id, { karar, neden = '' } = {}) {
  const clientId = await db.getClientId();
  karar = String(karar || '').toUpperCase();
  if (!['KABUL', 'RED'].includes(karar)) return { ok: false, error: 'Yanıt KABUL ya da RED olmalı.' };
  if (karar === 'RED' && String(neden || '').trim().length < 3) {
    return { ok: false, error: 'Red için sebep yazın (tedarikçi görür).' };
  }
  const k = clientId + ':' + id;
  if (_kilit.has(k)) return { ok: false, error: 'Yanıt şu anda gönderiliyor.' };
  _kilit.add(k);
  try {
    let g = await getir(id);
    const c = await E.conf();
    if (!g) return { ok: false, error: 'Fatura bulunamadı.' };
    if (g.ortam !== c.ortam) {
      return { ok: false, error: 'Bu fatura ' + (g.ortam === 'test' ? 'TEST' : 'CANLI') + ' ortamında geldi; şu an başka ortam seçili.' };
    }
    if (g.yanit_durum === 'hata' && g.yanit) {
      /* The previous attempt was refused by QNB: retry with the SAME
         identity rather than treating it as already answered. */
    } else {
      const y = yanitlanabilir(g);
      if (!y.ok) return { ok: false, error: y.neden };
    }
    const uuid = g.yanit_uuid || crypto.randomUUID().toUpperCase();
    const an = E.simdi();
    await db.exec(
      `UPDATE gelen_belge SET yanit=?, yanit_neden=?, yanit_uuid=?, yanit_durum='gonderiliyor', yanit_hata=NULL,
              yanit_at=?, yanit_by=? WHERE id=?`,
      [karar, String(neden || '').trim() || null, uuid, an, (ctx && ctx.userId) || null, id]);
    g = await getir(id);
    const xml = yanitXml({ uuid, karar, neden: String(neden || '').trim(), g, c,
      tarih: an.slice(0, 10), saat: an.slice(11, 19) || '00:00:00' });
    const bytes = Buffer.from(xml, 'utf8');
    const md5 = crypto.createHash('md5').update(bytes).digest('hex').toUpperCase();
    const r = await E.cagir(null, 'efatura', 'belgeGonderExt',
      `<ser:belgeGonderExt><parametreler><vergiTcKimlikNo>${E.xe(c.vkn)}</vergiTcKimlikNo><belgeTuru>UYGULAMA_YANITI_UBL</belgeTuru>`
      + `<belgeNo>${uuid}</belgeNo><veri>${bytes.toString('base64')}</veri><belgeHash>${md5}</belgeHash>`
      + `<mimeType>application/xml</mimeType><belgeVersiyon>1.0</belgeVersiyon><erpKodu>${E.ERP_KODU}</erpKodu>`
      + (g.gonderen_etiket ? `<alanEtiket>${E.xe(g.gonderen_etiket)}</alanEtiket>` : '')
      + (c.gonderen_etiket ? `<gonderenEtiket>${E.xe(c.gonderen_etiket)}</gonderenEtiket>` : '')
      + '</parametreler></ser:belgeGonderExt>', { conf: c, zamanMs: 60000 });
    if (r.ok && E.etiket(r.text, 'belgeOid')) {
      await db.exec("UPDATE gelen_belge SET yanit_durum='gonderildi', yanit_hata=NULL WHERE id=?", [id]);
      await E.audit(ctx, 'ebelge.gelen_yanit', 'gelen_belge', id, { karar, ettn: g.uuid, yanit_uuid: uuid });
      return { ok: true, karar };
    }
    const hata = r.error || r.fault || ('QNB yanıtı: HTTP ' + r.status);
    await db.exec("UPDATE gelen_belge SET yanit_durum='hata', yanit_hata=? WHERE id=?", [String(hata).slice(0, 500), id]);
    return { ok: false, error: 'Yanıt gönderilemedi: ' + hata };
  } finally { _kilit.delete(k); }
}

/** The official PDF, as QNB renders it. */
async function pdf(ctx, id) {
  const g = await getir(id);
  if (!g) return { ok: false, error: 'Fatura bulunamadı.' };
  const c = await E.conf();
  if (g.ortam !== c.ortam) return { ok: false, error: 'Bu fatura başka ortamda geldi.' };
  const r = await E.cagir(null, 'efatura', 'gelenBelgeIndirExt',
    `<ser:gelenBelgeIndirExt><vergiTcKimlikNo>${E.xe(c.vkn)}</vergiTcKimlikNo><belgeEttn>${E.xe(g.uuid)}</belgeEttn>`
    + '<belgeTuru>FATURA</belgeTuru><belgeFormati>PDF</belgeFormati></ser:gelenBelgeIndirExt>', { conf: c, zamanMs: 60000 });
  if (!r.ok) return { ok: false, error: r.error || ('HTTP ' + r.status) };
  const b64 = E.etiket(r.text, 'return') || E.etiket(r.text, 'belgeVerisi');
  if (!b64) return { ok: false, error: 'QNB PDF döndürmedi.' };
  let buf;
  try { buf = E.coz(b64); } catch (e) { return { ok: false, error: 'QNB\'nin döndürdüğü belge açılamadı (' + e.message + ').' }; }
  if (buf.slice(0, 4).toString() !== '%PDF') return { ok: false, error: 'QNB\'nin döndürdüğü belge PDF değil.' };
  return { ok: true, pdf: buf };
}

/** The UBL lines, for display and for the draft stock document. */
function satirlar(xml) {
  return E.etiketler(xml || '', 'InvoiceLine').map((l) => {
    const nm = E.etiket(l, 'Item'); const tax = E.etiket(l, 'TaxSubtotal');
    return {
      ad: E.etiket(nm || '', 'Name') || '',
      miktar: Number(E.etiket(l, 'InvoicedQuantity') || 0),
      birim: (/<(?:[a-z0-9]+:)?InvoicedQuantity[^>]*unitCode="([^"]+)"/i.exec(l) || [])[1] || 'C62',
      birimFiyat: kurus(E.etiket(E.etiket(l, 'Price') || '', 'PriceAmount')),
      tutar: kurus(E.etiket(l, 'LineExtensionAmount')),
      kdvOran: Number(E.etiket(tax || '', 'Percent') || 0),
      kdv: kurus(E.etiket(tax || '', 'TaxAmount')),
    };
  });
}

/** No UBL yet: download it from QNB and keep it. */
async function xmlGetir(ctx, id) {
  const g = await getir(id);
  if (!g) return null;
  if (g.xml) return g.xml;
  const c = await E.conf();
  if (g.ortam !== c.ortam) return null;
  const r = await E.cagir(null, 'efatura', 'gelenBelgeIndirExt',
    `<ser:gelenBelgeIndirExt><vergiTcKimlikNo>${E.xe(c.vkn)}</vergiTcKimlikNo><belgeEttn>${E.xe(g.uuid)}</belgeEttn>`
    + '<belgeTuru>FATURA</belgeTuru><belgeFormati>UBL</belgeFormati></ser:gelenBelgeIndirExt>', { conf: c, zamanMs: 60000 });
  if (!r.ok) return null;
  const b64 = E.etiket(r.text, 'return') || E.etiket(r.text, 'belgeVerisi');
  if (!b64) return null;
  try {
    const x = E.coz(b64).toString('utf8');
    if (!x.includes('Invoice')) return null;
    await db.exec('UPDATE gelen_belge SET xml=? WHERE id=?', [x, id]);
    return x;
  } catch (e) { return null; }
}

const UBL_BIRIM = { C62: 'adet', KGM: 'kg', GRM: 'gr', LTR: 'lt', MLT: 'ml', MTR: 'm', PA: 'paket', CT: 'koli', BX: 'kutu' };

/**
 * Turn an incoming invoice into a DRAFT stock entry document.
 *
 * Draft, never approved: nothing moves in stock until a person has
 * matched each line to an inventory item and approved it. The supplier
 * is found by tax number or opened once.
 */
async function alisaAktar(ctx, id) {
  const clientId = await db.getClientId();
  const g = await getir(id);
  if (!g) return { ok: false, error: 'Fatura bulunamadı.' };
  if (g.document_id) {
    const v = await db.one('SELECT id FROM inventory_documents WHERE id=? AND client_id=?', [g.document_id, clientId]);
    if (v) return { ok: true, documentId: g.document_id, zaten: true };
  }
  if (g.yanit === 'RED') return { ok: false, error: 'Reddedilen fatura alışa aktarılmaz.' };
  const xml = g.xml || await xmlGetir(ctx, id);
  const satir = satirlar(xml);
  const out = await db.tx(async (t) => {
    let sup = g.gonderen_vkn
      ? await t.one('SELECT id FROM suppliers WHERE client_id=? AND vkn=? AND is_active=1', [clientId, g.gonderen_vkn])
      : null;
    const supId = sup ? sup.id : await t.insert(
      'INSERT INTO suppliers (client_id, name, vkn, is_active, created_at) VALUES (?,?,?,1,NOW())',
      [clientId, g.gonderen || ('VKN ' + g.gonderen_vkn), g.gonderen_vkn || '']);
    const docId = await t.insert(
      `INSERT INTO inventory_documents (client_id, supplier_id, type, document_no, document_date,
          total_amount, status, source, note, created_by, created_at)
       VALUES (?,?,'purchase',?,?,?,'draft','api',?,?,NOW())`,
      [clientId, supId, g.belge_no || null, g.belge_tarihi || g.gelis_tarihi || E.simdi().slice(0, 10),
       (Number(g.tutar_minor) || 0) / 100, 'Gelen e-Fatura ETTN ' + g.uuid, (ctx && ctx.userId) || 0]);
    /*
     * WHAT THIS SUPPLIER CALLED IT LAST TIME.
     *
     * The lines are the supplier's own words, so the first invoice from a new
     * supplier arrives unmatched and a person decides what each line is. That
     * decision was written down when they approved it (see
     * inventory.approveDocument), so from the second invoice on the lines
     * arrive already pointing at the right material and the whole thing is one
     * Onayla.
     *
     * Matched is NOT approved. Nothing reaches the stock ledger until a person
     * presses the button - a remembered mapping is a good guess, and a good
     * guess is not a reason to move stock and restate costs by itself.
     */
    const hafiza = new Map();
    if (supId) {
      const rows = await t.query(
        'SELECT raw_key, item_id FROM alis_satir_eslesme WHERE client_id=? AND supplier_id=?',
        [clientId, supId]);
      for (const r of rows) hafiza.set(r.raw_key, r.item_id);
    }
    let tanindi = 0;
    for (const s of satir) {
      const adet = Number(s.miktar) || 0;
      if (adet <= 0) continue;
      const itemId = hafiza.get(envanter.satirAnahtari(s.ad)) || null;
      if (itemId) tanindi++;
      await t.insert(
        `INSERT INTO inventory_document_items (document_id, item_id, raw_name, quantity, unit,
            unit_price, total_price, vat_rate, vat_amount, matched_confidence, is_approved)
         VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
        [docId, itemId, String(s.ad || '-').slice(0, 255), adet, UBL_BIRIM[s.birim] || 'adet',
         (Number(s.birimFiyat) || 0) / 100, (Number(s.tutar) || 0) / 100,
         Number(s.kdvOran) || 0, (Number(s.kdv) || 0) / 100, itemId ? 100 : null]);
    }
    await t.exec('UPDATE gelen_belge SET document_id=?, supplier_id=? WHERE id=?', [docId, supId, id]);
    return { ok: true, documentId: docId, supplierId: supId, yeniTedarikci: !sup,
             satir: satir.length, tanindi };
  });
  await E.audit(ctx, 'ebelge.gelen_alis', 'gelen_belge', id,
    { document_id: out.documentId, satir: out.satir, tanindi: out.tanindi });
  return out;
}

async function sayac() {
  const c = await E.conf();
  const clientId = await db.getClientId();
  return {
    toplam: Number(await db.value('SELECT COUNT(*) FROM gelen_belge WHERE client_id=? AND ortam=?', [clientId, c.ortam]) || 0),
    bekleyen: Number(await db.value(
      "SELECT COUNT(*) FROM gelen_belge WHERE client_id=? AND ortam=? AND senaryo='TICARIFATURA' AND yanit IS NULL",
      [clientId, c.ortam]) || 0),
  };
}

module.exports = { YANIT_GUN, cek, liste, getir, yanitlanabilir, yanitXml, yanitVer, pdf, satirlar, xmlGetir, alisaAktar, sayac };
