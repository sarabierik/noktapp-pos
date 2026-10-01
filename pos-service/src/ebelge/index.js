'use strict';
/* =====================================================================
   e-FATURA / e-ARŞİV — QNB eSolutions (SOAP)      src/ebelge/index.js
   ---------------------------------------------------------------------
   This is Noktappera's server/ebelge.js, moved into the till. The
   protocol is not re-derived here and nothing about it was "improved":
   the SOAP envelope, the UBL-TR 1.2 document, the taxpayer lookup, the
   numbering, and the recovery discipline are the ones that were measured
   against QNB's real test environment on 29.09.2026. What changed is the
   database underneath (synchronous SQLite -> async MariaDB) and the fact
   that a restaurant bill, not a retail invoice, is what feeds it.

   MEASURED AGAINST THE REAL TEST ENVIRONMENT (29.09.2026)
   * Authentication is WS-Security UsernameToken. The password travels in
     the SOAP header and is NEVER written to the log table.
   * e-ARŞİV (EarsivWebService) is SYNCHRONOUS: faturaOlusturExt returns
     the number, the ETTN and the viewing link in one call.
       - the input JSON must be XML-ESCAPED text; CDATA is not read
         ("No content to map").
       - resending the same islemId/ETTN returns the SAME invoice, so a
         retry after a timeout is safe.
       - the "Gönderim Şekli" note is mandatory (AE00003).
       - the buyer's name may not be "Nihai Tüketici" (AE00313).
   * e-FATURA (connectorService) is QUEUED: belgeGonderExt returns a
     belgeOid and the outcome is followed with gidenBelgeDurumSorgulaExt.
   * ERP code BAG31527 is accepted on the e-Fatura side. On the e-Arşiv
     TEST service QNB had not registered it, so in TEST ONLY and on that
     one error it is retried once without the ERP code. Never live. QNB
     registered it on 30.09.2026 and the retry should stop firing; it is
     kept because a fallback that never runs costs nothing and the day it
     runs again we find out from a warning instead of a failed invoice.

   QNB SUPPORT, 30.09.2026 (ticket 02047654)
   * The live addresses are the same for every customer, and they are the
     ones in VARSAYILAN.canli below.
   * BAG31527 has to be registered ONCE for live, by us, not per
     restaurant: after that every customer arriving with that code is
     registered automatically.
   * THE PORTAL FORCES A PASSWORD CHANGE on first login and every three
     months. QNB's own words: if the new password is not also written into
     the web service settings, the service keeps logging in with the old
     one AND THE USER IS BLOCKED. That is why a wrong password stops this
     module dead (see `kimlikKilidi`) instead of being retried, and why
     the settings screen tells the restaurant to open a SEPARATE web
     service user.
   * Rate limit: 180 requests per minute (see `agKova`).
   * We number our own e-Faturas (series + year + sequence); QNB says that
     is preferable to their faturaNoUret.
   * QNB applies the fiscal seal - we send unsigned UBL, which is correct.
   * e-Arşiv mail to the buyer is sent by QNB, driven by the "Gönderim
     Şekli" note this module writes: ELEKTRONIK when the invoice carries
     an e-mail address, KAGIT when it does not.
   * UYGULAMA_YANITI_UBL through belgeGonderExt is the right way to answer
     a TİCARİ invoice.

   THE TWO RULES THAT KEEP A SECOND INVOICE FROM EXISTING
   1. The ETTN, and the e-Fatura number, are written to the database
      BEFORE the request leaves. If no answer comes back, no new identity
      is minted: the document is queried first and then resent with the
      same one.
   2. Passwords are wrapped by sirla.js (Windows DPAPI) and never leave
      the customer's PC.

   ONE ADAPTATION WORTH KNOWING ABOUT. Noktappera stores a VAT rate in
   basis points (2000 = 20%); the till stores a percentage
   (invoice_items.vat_rate DECIMAL(5,2) = 20.00). So the divide-by-100
   that produced cbc:Percent there would have printed 0.2% on a legal
   document here. It is gone, and a test holds it down.
   ===================================================================== */
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const db = require('../db');
const log = require('../logger');
const S = require('./sirla');

const ERP_KODU = 'BAG31527';
/* Memory guards. An incoming document's content comes from the SUPPLIER
   and may be a zip bomb; QNB's own answer is bounded but not by us. */
const YANIT_SINIR = 64 * 1048576;
const ACMA_SINIR = 32 * 1048576;

const VARSAYILAN = {
  test: { efatura: 'https://erpefaturatest1.qnbesolutions.com.tr/efatura/ws/connectorService',
          earsiv: 'https://earsivtest.qnbesolutions.com.tr/earsiv/ws/EarsivWebService' },
  /* QNB, 30.09.2026: the live addresses are the same for everyone. */
  canli: { efatura: 'https://efaturaconnector.qnbesolutions.com.tr/connector/ws/connectorService',
           earsiv: 'https://earsivconnector.qnbesolutions.com.tr/earsiv/ws/EarsivWebService' },
};
const NS_CONN = 'http://service.connector.uut.cs.com.tr/';
const NS_EARSIV = 'http://service.earsiv.uut.cs.com.tr/';

/* QNB's own domains: the new one and the two eFinans-era ones. Anything
   else is refused, so a lookalike host can never be handed a password. */
const QNB_ADRES = /^https:\/\/[a-z0-9.-]+\.(qnbesolutions\.com\.tr|efinans\.com\.tr|cs\.com\.tr)(:\d+)?\//i;

/* ------------------------------------------------------------------ */
/*  Settings                                                          */
/* ------------------------------------------------------------------ */
const A = async (k, d = '') => {
  const v = await db.getSetting('ebelge.' + k, null);
  return v === null || v === undefined ? d : String(v);
};
const set = (k, v) => db.setSetting('ebelge.' + k, v);

/** The business's own identity, from the till's own settings. */
async function isletme() {
  const b = await db.one('SELECT * FROM business_settings WHERE client_id=? ORDER BY id LIMIT 1',
    [await db.getClientId()]) || {};
  const adres = [b.address_line1, b.address_line2].filter(Boolean).join(' ');
  return {
    unvan: b.legal_name || b.business_name || '',
    vergi_no: String(b.tax_number || '').replace(/\D/g, ''),
    vergi_dairesi: b.tax_office || '',
    adres, il: b.city || '', eposta: b.email || '', telefon: b.phone || '',
  };
}

async function conf() {
  const st = await isletme();
  const ortam = (await A('ortam', 'test')) === 'canli' ? 'canli' : 'test';
  let ef = '', ea = '';
  const efSar = await A('efatura_sifre'), eaSar = await A('earsiv_sifre');
  try { ef = S.ac(efSar); } catch (e) { ef = ''; }
  try { ea = S.ac(eaSar); } catch (e) { ea = ''; }
  const vknAyar = await A('vkn');
  return {
    aktif: (await A('aktif', '0')) === '1',
    ortam,
    /* Live means the business's OWN QNB account, so the VKN is the tax
       number in Ayarlar and nothing else. In test the field may be set
       by hand, because the test account is not the restaurant's. */
    vkn: (ortam === 'canli' ? st.vergi_no : (vknAyar || st.vergi_no)).replace(/\D/g, ''),
    efatura_kullanici: await A('efatura_kullanici'), efatura_sifre: ef,
    earsiv_kullanici: await A('earsiv_kullanici'), earsiv_sifre: ea,
    efatura_url: (await A('efatura_url')) || VARSAYILAN[ortam].efatura,
    earsiv_url: (await A('earsiv_url')) || VARSAYILAN[ortam].earsiv,
    efatura_seri: ((await A('efatura_seri', 'NKT')).toUpperCase().replace(/[^A-Z]/g, '') + 'NKT').slice(0, 3),
    sube: (await A('sube', 'DFLT')) || 'DFLT',
    kasa: (await A('kasa', 'DFLT')) || 'DFLT',
    gonderen_etiket: await A('gonderen_etiket'),
    il: (await A('il')) || st.il, ilce: await A('ilce'),
    otomatik: (await A('otomatik', '1')) === '1',
    unvan: st.unvan, vergi_dairesi: st.vergi_dairesi, adres: st.adres,
    eposta: st.eposta, telefon: st.telefon,
    sifreKorumali: S.sifreliMi(efSar) || S.sifreliMi(eaSar),
    sifreYontemi: S.yontem(),
  };
}

/**
 * Save the settings screen. EVERYTHING is validated before anything is
 * written: a refused save must not leave half the form stored.
 */
async function kaydet(ctx, b) {
  const vkn = String(b.vkn || '').replace(/\D/g, '');
  if (vkn && !/^\d{10,11}$/.test(vkn)) return { ok: false, error: 'VKN 10, TCKN 11 haneli olmalı.' };
  const url = {};
  for (const k of ['efatura_url', 'earsiv_url']) {
    const u = String(b[k] || '').trim();
    if (u && !QNB_ADRES.test(u) && !/^https?:\/\/127\.0\.0\.1(:\d+)?\//.test(u)) {
      return { ok: false, error: 'Servis adresi QNB\'nin adresi olmalı (https://…qnbesolutions.com.tr/… ya da https://…efinans.com.tr/…). QNB\'nin size e-postayla verdiği adresi yapıştırın.' };
    }
    url[k] = u;
  }
  const seri = String(b.efatura_seri || 'NKT').toUpperCase().replace(/[^A-Z]/g, '');
  if (seri.length !== 3) return { ok: false, error: 'e-Fatura seri kodu 3 büyük harf olmalı (ör. NKT).' };
  /* LIVE = the business's OWN QNB account. No document may be issued
     under another company's VKN, and a test address is never carried
     into live. */
  if (b.ortam === 'canli') {
    const st = await isletme();
    if (!st.vergi_no) return { ok: false, error: 'Canlı için önce Ayarlar\'da işletmenin vergi numarasını girin.' };
    if (vkn && vkn !== st.vergi_no) {
      return { ok: false, error: 'Canlıda yalnızca işletmenin kendi VKN\'siyle (' + st.vergi_no + ') belge kesilir. Girilen: ' + vkn + '.' };
    }
    for (const k of ['efatura_url', 'earsiv_url']) if (/test/i.test(url[k] || '')) url[k] = '';
  }
  /* The environment changed, so this is a DIFFERENT account: the old
     environment's password is not carried over. Without this, the shared
     test account could issue a live document. */
  const eskiOrtam = (await A('ortam', 'test')) === 'canli' ? 'canli' : 'test';
  const yeniOrtam = b.ortam === 'canli' ? 'canli' : 'test';
  if (eskiOrtam !== yeniOrtam) {
    if (!String(b.efatura_sifre || '')) await set('efatura_sifre', '');
    if (!String(b.earsiv_sifre || '')) await set('earsiv_sifre', '');
  }
  await set('aktif', b.aktif ? '1' : '0');
  await set('ortam', yeniOrtam);
  await set('vkn', vkn);
  for (const k of ['efatura_kullanici', 'earsiv_kullanici', 'gonderen_etiket', 'il', 'ilce']) {
    await set(k, String(b[k] || '').trim().slice(0, 120));
  }
  for (const k of Object.keys(url)) await set(k, url[k]);
  await set('efatura_seri', seri);
  await set('sube', String(b.sube || 'DFLT').trim().slice(0, 20) || 'DFLT');
  await set('kasa', String(b.kasa || 'DFLT').trim().slice(0, 20) || 'DFLT');
  await set('otomatik', b.otomatik ? '1' : '0');
  /* An empty password field KEEPS the stored password. */
  if (String(b.efatura_sifre || '')) await set('efatura_sifre', S.sar(String(b.efatura_sifre)));
  if (String(b.earsiv_sifre || '')) await set('earsiv_sifre', S.sar(String(b.earsiv_sifre)));
  _mukellef.clear();   /* the account or environment may have changed */
  /* Saving the settings is the only moment a new password can have
     arrived, so it is the only thing that lifts the credential lock. */
  kilitAc();
  await audit(ctx, 'ebelge.config', 'ebelge', 0, { aktif: !!b.aktif, ortam: yeniOrtam });
  return { ok: true };
}

async function audit(ctx, action, entity, entityId, meta) {
  try {
    await db.exec(
      `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id,
          after_json, created_at) VALUES (?,?,?,?,?,?,?,NOW())`,
      [(ctx && ctx.clientId) || await db.getClientId(), (ctx && ctx.userId) || 0, 'admin',
       action, entity, String(entityId), meta ? JSON.stringify(meta) : null]);
  } catch (e) { log.warn('ebelge', 'audit yazilamadi', e.message); }
}

/* ------------------------------------------------------------------ */
/*  XML helpers                                                       */
/* ------------------------------------------------------------------ */
const xe = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xd = (s) => String(s == null ? '' : s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function etiket(xml, ad) {
  const m = new RegExp('<(?:[a-zA-Z0-9]+:)?' + ad + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?' + ad + '>').exec(xml || '');
  return m ? xd(m[1]) : null;
}
function etiketler(xml, ad) {
  const re = new RegExp('<(?:[a-zA-Z0-9]+:)?' + ad + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?' + ad + '>', 'g');
  const o = []; let m;
  while ((m = re.exec(xml || ''))) o.push(m[1]);
  return o;
}
function ekstra(xml) {
  const o = {};
  for (const e of etiketler(xml, 'entry')) { const k = etiket(e, 'key'); if (k) o[k] = etiket(e, 'value'); }
  return o;
}

/* ------------------------------------------------------------------ */
/*  SOAP                                                              */
/* ------------------------------------------------------------------ */
function soap(url, kullanici, sifre, ns, govde, { zamanMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, baglanmadi: true, error: 'Servis adresi geçersiz: ' + url }); }
    /* A password never travels over plain http. The only exception is
       the local fake server the tests run. */
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === '127.0.0.1')) {
      return resolve({ ok: false, baglanmadi: true, error: 'Servis adresi https:// olmalı; parola şifresiz bağlantıyla gönderilmez.' });
    }
    const zarf = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="${ns}">`
      + `<soapenv:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">`
      + `<wsse:UsernameToken><wsse:Username>${xe(kullanici)}</wsse:Username><wsse:Password>${xe(sifre)}</wsse:Password></wsse:UsernameToken>`
      + `</wsse:Security></soapenv:Header><soapenv:Body>${govde}</soapenv:Body></soapenv:Envelope>`;
    const veri = Buffer.from(zarf, 'utf8');
    const mod = u.protocol === 'http:' ? http : https;
    let bitti = false;
    const son = (r) => { if (!bitti) { bitti = true; resolve(r); } };
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'POST', timeout: zamanMs,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""', 'Content-Length': veri.length },
    }, (res) => {
      const p = []; let boy = 0;
      res.on('data', (c) => {
        boy += c.length;
        if (boy > YANIT_SINIR) {
          req.destroy();
          son({ ok: false, error: 'QNB yanıtı çok büyük (' + Math.round(boy / 1048576) + ' MB); kısa tarih aralığıyla deneyin.' });
          return;
        }
        p.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(p).toString('utf8');
        const fault = etiket(text, 'faultstring');
        son({ ok: res.statusCode === 200 && !fault, status: res.statusCode, text, fault: fault || null });
      });
    });
    req.on('timeout', () => { req.destroy(); son({ ok: false, timeout: true, error: 'Servis ' + Math.round(zamanMs / 1000) + ' sn içinde yanıt vermedi.' }); });
    req.on('error', (e) => son({ ok: false, error: e.message,
      baglanmadi: ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(e.code) }));
    req.write(veri); req.end();
  });
}

/* ------------------------------------------------------------------ */
/*  Two guards QNB asked for by describing their own behaviour        */
/* ------------------------------------------------------------------ */
/*
 * THE CREDENTIAL LOCK.
 *
 * QNB's portal demands a new password every three months, and QNB told us
 * plainly what happens next: a service that goes on presenting the old
 * one gets the USER BLOCKED. A blocked user cannot issue an invoice at
 * all, so the automatic retry that looks like resilience is the thing
 * that takes the restaurant off the air - and the queue sweep below runs
 * every five minutes without anyone watching.
 *
 * So the first username.pwd.mismatch stops everything. Nothing is sent
 * again until the settings are saved, which is the only moment a new
 * password can have arrived. A cashier who presses "Gönder" is told to go
 * and update it; the sweep just stays quiet.
 */
let kimlikKilidi = null;
function kilitAc() { kimlikKilidi = null; }
function kilitliMi() { return kimlikKilidi; }
function kilitle(servis, metin) {
  kimlikKilidi = {
    t: Date.now(), servis,
    error: 'QNB parolası yanlış; hesabın kilitlenmemesi için gönderim durduruldu. '
      + 'QNB portalinde parola üç ayda bir değişir ve eski parolayla denemeye devam eden program kullanıcıyı bloke ettirir. '
      + 'Yeni parolayı Ayarlar → e-Fatura / e-Arşiv ekranına yazıp kaydedin.',
    ham: String(metin || '').slice(0, 200),
  };
  log.error('ebelge', 'parola yanlis - gonderim durduruldu', servis);
}

/*
 * THE RATE LIMIT. QNB allows 180 requests a minute. Nothing here comes
 * close on an ordinary evening, but a queue sweep landing on a hundred
 * stuck invoices at the same moment as a mailbox pull could, and being
 * throttled by the integrator during a service is not a thing to find out
 * about from a guest. A plain token bucket: 180 per rolling minute, and a
 * caller that would exceed it waits rather than being refused.
 */
const agKova = { pencere: [], sinir: 180 };
async function kovaBekle() {
  for (;;) {
    const simdi = Date.now();
    agKova.pencere = agKova.pencere.filter((t) => simdi - t < 60000);
    if (agKova.pencere.length < agKova.sinir) { agKova.pencere.push(simdi); return; }
    const bekle = 60000 - (simdi - agKova.pencere[0]) + 50;
    await new Promise((z) => setTimeout(z, Math.min(bekle, 60000)));
  }
}

function faultAcikla(f) {
  if (/username\.pwd\.mismatch/i.test(f || '')) {
    return 'Kullanıcı adı ya da parola yanlış (QNB: username.pwd.mismatch). QNB\'de portal ve web servis kullanıcısı aynıdır: portalde parola değiştirdiyseniz yenisini buraya da yazın.';
  }
  if (/locked|bloke|kilit/i.test(f || '')) return 'QNB kullanıcısı kilitlenmiş görünüyor (' + f + '). Portalden açın.';
  return 'QNB hatası: ' + f;
}

/**
 * One line per conversation with QNB. The password is not among the
 * columns, by design: the ÖKC side went a month with no writer at all on
 * its log table and a refusal had to be read out over the phone.
 */
async function kayit(clientId, invoiceId, servis, islem, r, ms, kod, metin) {
  try {
    await db.exec(
      `INSERT INTO ebelge_log (client_id, invoice_id, servis, islem, http_status, sonuc_kodu, sonuc_metni, duration_ms)
       VALUES (?,?,?,?,?,?,?,?)`,
      [clientId, invoiceId || null, servis, islem, r.status || null,
       kod || (r.fault ? 'FAULT' : r.timeout ? 'ZAMAN_ASIMI' : r.baglanmadi ? 'BAGLANTI_YOK' : r.ok ? null : 'HATA'),
       String(metin || r.fault || r.error || '').slice(0, 500), ms]);
  } catch (e) { /* logging never stops the operation */ }
}

async function cagir(invoiceId, servis, islem, govde, opts = {}) {
  const c = opts.conf || await conf();
  const clientId = await db.getClientId();
  const url = servis === 'efatura' ? c.efatura_url : c.earsiv_url;
  const kul = servis === 'efatura' ? c.efatura_kullanici : c.earsiv_kullanici;
  const sif = servis === 'efatura' ? c.efatura_sifre : c.earsiv_sifre;
  const ad = servis === 'efatura' ? 'e-Fatura' : 'e-Arşiv';
  if (!url) return { ok: false, baglanmadi: true, error: ad + ' servis adresi tanımlı değil. QNB\'nin size verdiği adresi Ayarlar → e-Fatura / e-Arşiv ekranına girin.' };
  if (!kul || !sif) return { ok: false, baglanmadi: true, error: ad + ' kullanıcı adı / parolası girilmemiş.' };
  /* A wrong password is not retried. See kimlikKilidi above: retrying is
     what gets the QNB user blocked, and a blocked user cannot invoice. */
  const kilit = kilitliMi();
  if (kilit) return { ok: false, baglanmadi: true, kilitli: true, error: kilit.error };
  await kovaBekle();
  const t0 = Date.now();
  const r = await soap(url, kul, sif, servis === 'efatura' ? NS_CONN : NS_EARSIV, govde, { zamanMs: opts.zamanMs || 60000 });
  const kod = etiket(r.text, 'resultCode') || etiket(r.text, 'durum');
  await kayit(clientId, invoiceId, servis, islem, r, Date.now() - t0, kod,
    etiket(r.text, 'resultText') || etiket(r.text, 'gonderimCevabiDetayi'));
  if (r.fault) {
    r.error = faultAcikla(r.fault);
    if (/username\.pwd\.mismatch/i.test(r.fault)) { kilitle(servis, r.fault); r.kilitli = true; }
  }
  return r;
}

/* ------------------------------------------------------------------ */
/*  UBL-TR 1.2                                                        */
/* ------------------------------------------------------------------ */
const tutar = (kurus) => {
  const n = Math.round(Number(kurus) || 0);
  const s = String(Math.abs(n)).padStart(3, '0');
  return (n < 0 ? '-' : '') + s.slice(0, -2) + '.' + s.slice(-2);
};
const miktar = (binde) => { const n = Number(binde) || 0; return (n / 1000).toFixed(3).replace(/\.?0+$/, '') || '0'; };
const BIRIM = { adet: 'C62', ad: 'C62', kg: 'KGM', kilogram: 'KGM', gr: 'GRM', gram: 'GRM', lt: 'LTR', litre: 'LTR', l: 'LTR',
                ml: 'MLT', m: 'MTR', metre: 'MTR', paket: 'PA', koli: 'CT', kutu: 'BX', 'düzine': 'DZN', porsiyon: 'C62',
                saat: 'HUR', 'gün': 'DAY' };
const birimKodu = (b) => BIRIM[String(b || '').toLocaleLowerCase('tr').trim()] || 'C62';

/** "..., Alanya/Antalya" -> {ilce:'Alanya', il:'Antalya'} */
function ilIlce(adres, c) {
  const m = /([A-Za-zÇĞİÖŞÜçğıöşü .-]+)\s*\/\s*([A-Za-zÇĞİÖŞÜçğıöşü .-]+)\s*$/.exec(String(adres || '').trim());
  if (m) return { ilce: m[1].trim().split(/\s+/).slice(-2).join(' '), il: m[2].trim() };
  return { ilce: (c && c.ilce) || (c && c.il) || '-', il: (c && c.il) || '-' };
}
function adSoyad(unvan) {
  const p = String(unvan || '').trim().split(/\s+/);
  if (p.length < 2) return { ad: p[0] || '', soyad: '' };
  return { ad: p.slice(0, -1).join(' '), soyad: p[p.length - 1] };
}
/* "Saray Mah. 3, Alanya/Antalya" -> street "Saray Mah. 3"; the district
   and city go in their own fields, or QNB's PDF prints them twice. */
function sokak(adres) {
  const a = String(adres || '').trim();
  const k = a.replace(/[,\s]*[A-Za-zÇĞİÖŞÜçğıöşü .-]+\s*\/\s*[A-Za-zÇĞİÖŞÜçğıöşü .-]+\s*$/, '').replace(/[,\s]+$/, '');
  return k || a;
}
function adresXml(adres, c) {
  const y = ilIlce(adres, c);
  return `<cac:PostalAddress><cbc:StreetName>${xe(sokak(adres).slice(0, 250))}</cbc:StreetName>`
    + `<cbc:CitySubdivisionName>${xe(y.ilce)}</cbc:CitySubdivisionName><cbc:CityName>${xe(y.il)}</cbc:CityName>`
    + `<cac:Country><cbc:Name>Türkiye</cbc:Name></cac:Country></cac:PostalAddress>`;
}
function tarafXml({ no, unvan, vd, adres, eposta, telefon }, c) {
  const tckn = String(no).length === 11;
  const kisi = tckn ? adSoyad(unvan) : null;
  return `<cac:Party><cac:PartyIdentification><cbc:ID schemeID="${tckn ? 'TCKN' : 'VKN'}">${xe(no)}</cbc:ID></cac:PartyIdentification>`
    + (tckn ? '' : `<cac:PartyName><cbc:Name>${xe(unvan)}</cbc:Name></cac:PartyName>`)
    + adresXml(adres, c)
    + `<cac:PartyTaxScheme><cac:TaxScheme><cbc:Name>${xe(vd || '')}</cbc:Name></cac:TaxScheme></cac:PartyTaxScheme>`
    + (eposta || telefon ? `<cac:Contact>${telefon ? `<cbc:Telephone>${xe(telefon)}</cbc:Telephone>` : ''}${eposta ? `<cbc:ElectronicMail>${xe(eposta)}</cbc:ElectronicMail>` : ''}</cac:Contact>` : '')
    + (tckn ? `<cac:Person><cbc:FirstName>${xe(kisi.ad)}</cbc:FirstName><cbc:FamilyName>${xe(kisi.soyad)}</cbc:FamilyName></cac:Person>` : '')
    + `</cac:Party>`;
}
/*
 * cbc:Percent is the PERCENTAGE, so 20.00 prints as 20. Noktappera kept
 * the rate in basis points and divided by 100 here; the till's column is
 * already a percentage, and carrying that divide across would have
 * issued legal documents reading "0.2%".
 */
function vergiXml(oranlar) {
  let toplam = 0; let alt = '';
  for (const [oran, v] of Object.entries(oranlar)) {
    toplam += v.kdv;
    const yuzde = Number(oran);
    alt += `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="TRY">${tutar(v.matrah)}</cbc:TaxableAmount>`
      + `<cbc:TaxAmount currencyID="TRY">${tutar(v.kdv)}</cbc:TaxAmount><cbc:Percent>${yuzde}</cbc:Percent><cac:TaxCategory>`
      + (yuzde === 0 ? '<cbc:TaxExemptionReasonCode>351</cbc:TaxExemptionReasonCode><cbc:TaxExemptionReason>KDV - İstisna Olmayan Diğer</cbc:TaxExemptionReason>' : '')
      + `<cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
  }
  return `<cac:TaxTotal><cbc:TaxAmount currencyID="TRY">${tutar(toplam)}</cbc:TaxAmount>${alt}</cac:TaxTotal>`;
}
/*
 * A service charge or a whole-bill discount is a UBL AllowanceCharge, not
 * a line. Inventing a product called "Servis ücreti" would put a thing
 * that was never sold into the sales report and into stock, and a
 * discount invented as a negative product breaks the VAT breakdown.
 */
function eklerXml(ekler) {
  return ekler.map((e) => `<cac:AllowanceCharge><cbc:ChargeIndicator>${e.is_charge ? 'true' : 'false'}</cbc:ChargeIndicator>`
    + `<cbc:AllowanceChargeReason>${xe(String(e.reason || '').slice(0, 120))}</cbc:AllowanceChargeReason>`
    + `<cbc:Amount currencyID="TRY">${tutar(Math.abs(Number(e.base_amount)))}</cbc:Amount></cac:AllowanceCharge>`).join('');
}

/**
 * invoices row + invoice_items -> UBL-TR 1.2.
 * tip: 'EFATURA' (TEMELFATURA) | 'EARSIV' (EARSIVFATURA)
 */
function ubl(f, kalemler, { tip, no, uuid, c, ekler = [], ana = null }) {
  const iade = f.kind === 'return';
  const oranlar = {};
  let matrah = 0;
  const satirlar = kalemler.map((k, i) => {
    const o = oranlar[k.vat_rate] || (oranlar[k.vat_rate] = { matrah: 0, kdv: 0 });
    const km = Math.abs(Number(k.base_amount)), kk = Math.abs(Number(k.vat_amount));
    o.matrah += km; o.kdv += kk; matrah += km;
    const q = Math.abs(Number(k.qty)) || 1000;
    const birimFiyat = (km / 100) * 1000 / q;
    return `<cac:InvoiceLine><cbc:ID>${i + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="${birimKodu(k.unit)}">${miktar(q)}</cbc:InvoicedQuantity>`
      + `<cbc:LineExtensionAmount currencyID="TRY">${tutar(km)}</cbc:LineExtensionAmount>`
      + vergiXml({ [k.vat_rate]: { matrah: km, kdv: kk } })
      + `<cac:Item><cbc:Name>${xe(String(k.name).slice(0, 250))}</cbc:Name></cac:Item>`
      + `<cac:Price><cbc:PriceAmount currencyID="TRY">${Number(birimFiyat.toFixed(8))}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`;
  });
  /* Document level charges and discounts fold into the same VAT buckets
     the lines use, so matrah + KDV still equals the payable amount. */
  let ilave = 0, indirim = 0;
  for (const e of ekler) {
    const km = Math.abs(Number(e.base_amount)), kk = Math.abs(Number(e.vat_amount));
    const o = oranlar[e.vat_rate] || (oranlar[e.vat_rate] = { matrah: 0, kdv: 0 });
    if (e.is_charge) { ilave += km; o.matrah += km; o.kdv += kk; }
    else { indirim += km; o.matrah -= km; o.kdv -= kk; }
  }
  let kdv = 0;
  for (const v of Object.values(oranlar)) kdv += v.kdv;
  const haric = matrah + ilave - indirim;
  const genel = haric + kdv;
  const tarih = String(f.issue_date).slice(0, 10);
  const saat = new Date().toTimeString().slice(0, 8);
  const eposta = f.cust_email || '';
  /* QNB sends the buyer's copy by mail itself, and this note is what
     tells it to (QNB support, 30.09.2026). An address on the invoice
     means ELEKTRONIK; no address means KAGIT and no mail. */
  const gonderim = eposta ? 'ELEKTRONIK' : 'KAGIT';
  const satici = { no: c.vkn, unvan: c.unvan, vd: c.vergi_dairesi, adres: c.adres, eposta: c.eposta, telefon: c.telefon };
  const alici = { no: String(f.cust_tax_no), unvan: f.cust_title, vd: f.cust_tax_office, adres: f.cust_address, eposta, telefon: f.cust_phone };
  const sy = ilIlce(c.adres, c);
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">`
    + `<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>`
    + `<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>TR1.2</cbc:CustomizationID>`
    + `<cbc:ProfileID>${tip === 'EARSIV' ? 'EARSIVFATURA' : 'TEMELFATURA'}</cbc:ProfileID>`
    + `<cbc:ID>${xe(no)}</cbc:ID><cbc:CopyIndicator>false</cbc:CopyIndicator><cbc:UUID>${uuid}</cbc:UUID>`
    + `<cbc:IssueDate>${tarih}</cbc:IssueDate><cbc:IssueTime>${saat}</cbc:IssueTime>`
    + `<cbc:InvoiceTypeCode>${iade ? 'IADE' : 'SATIS'}</cbc:InvoiceTypeCode>`
    + (tip === 'EARSIV' ? `<cbc:Note>Gönderim Şekli: ${gonderim}</cbc:Note>` : '')
    + (f.note ? `<cbc:Note>${xe(String(f.note).slice(0, 500))}</cbc:Note>` : '')
    + `<cbc:Note>NOKTApp fatura no: ${xe(f.full_no)}</cbc:Note>`
    + `<cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode><cbc:LineCountNumeric>${kalemler.length}</cbc:LineCountNumeric>`
    + (iade && ana ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${xe(ana.edoc_no || ana.full_no)}</cbc:ID><cbc:IssueDate>${String(ana.issue_date).slice(0, 10)}</cbc:IssueDate><cbc:DocumentTypeCode>IADE</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference>` : '')
    + (tip === 'EARSIV' ? `<cac:AdditionalDocumentReference><cbc:ID>${gonderim}</cbc:ID><cbc:IssueDate>${tarih}</cbc:IssueDate><cbc:DocumentTypeCode>SendingType</cbc:DocumentTypeCode></cac:AdditionalDocumentReference>` : '')
    + `<cac:Signature><cbc:ID schemeID="VKN_TCKN">${xe(c.vkn)}</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID schemeID="${c.vkn.length === 11 ? 'TCKN' : 'VKN'}">${xe(c.vkn)}</cbc:ID></cac:PartyIdentification>`
    + `<cac:PostalAddress><cbc:CitySubdivisionName>${xe(sy.ilce)}</cbc:CitySubdivisionName><cbc:CityName>${xe(sy.il)}</cbc:CityName><cac:Country><cbc:Name>Türkiye</cbc:Name></cac:Country></cac:PostalAddress>`
    + `</cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#Signature</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>`
    + `<cac:AccountingSupplierParty>${tarafXml(satici, c)}</cac:AccountingSupplierParty>`
    + `<cac:AccountingCustomerParty>${tarafXml(alici, c)}</cac:AccountingCustomerParty>`
    + eklerXml(ekler)
    + vergiXml(oranlar)
    + `<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="TRY">${tutar(matrah)}</cbc:LineExtensionAmount>`
    + `<cbc:TaxExclusiveAmount currencyID="TRY">${tutar(haric)}</cbc:TaxExclusiveAmount>`
    + `<cbc:TaxInclusiveAmount currencyID="TRY">${tutar(genel)}</cbc:TaxInclusiveAmount>`
    + (indirim ? `<cbc:AllowanceTotalAmount currencyID="TRY">${tutar(indirim)}</cbc:AllowanceTotalAmount>` : '')
    + (ilave ? `<cbc:ChargeTotalAmount currencyID="TRY">${tutar(ilave)}</cbc:ChargeTotalAmount>` : '')
    + `<cbc:PayableAmount currencyID="TRY">${tutar(genel)}</cbc:PayableAmount></cac:LegalMonetaryTotal>`
    + satirlar.join('') + `</Invoice>`;
}

/* ------------------------------------------------------------------ */
/*  Taxpayer lookup: e-Fatura or e-Arşiv?                             */
/* ------------------------------------------------------------------ */
const _mukellef = new Map();
async function mukellef(vkn, { conf: c, invoiceId } = {}) {
  const cc = c || await conf();
  /* The test registry is NOT the live registry, so the cache key carries
     the environment, the URL and the user as well as the VKN. */
  const k = [cc.ortam, cc.efatura_url, cc.efatura_kullanici, vkn].join('|');
  const onb = _mukellef.get(k);
  if (onb && Date.now() - onb.t < 4 * 3600 * 1000) return onb.v;
  const r = await cagir(invoiceId, 'efatura', 'efaturaKullaniciBilgisi',
    `<ser:efaturaKullaniciBilgisi><vergiTcKimlikNo>${xe(vkn)}</vergiTcKimlikNo></ser:efaturaKullaniciBilgisi>`,
    { conf: cc, zamanMs: 20000 });
  if (!r.ok) return { ok: false, error: r.error || r.fault || ('HTTP ' + r.status) };
  const kayitlar = etiketler(r.text, 'return')
    .map(x => ({ etiket: etiket(x, 'etiket'), kayitZamani: etiket(x, 'kayitZamani'), unvan: etiket(x, 'unvan') }))
    .filter(x => x.etiket);
  const v = { ok: true, kayitli: kayitlar.length > 0, etiketler: kayitlar.map(x => x.etiket),
              kayitZamani: kayitlar.length ? kayitlar.map(x => x.kayitZamani).sort()[0] : null,
              unvan: kayitlar[0] ? kayitlar[0].unvan : null };
  _mukellef.set(k, { t: Date.now(), v });
  return v;
}

/* ------------------------------------------------------------------ */
/*  SEND                                                              */
/* ------------------------------------------------------------------ */
const _kilit = new Set();
const ortamAd = (o) => (o === 'canli' ? 'CANLI' : 'TEST');
const simdi = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/* A query, a PDF or a cancellation goes to the server the document was
   CREATED on. Looking for a test document on the live service would come
   back "not found" and wrongly push the invoice into 'hata'. */
function ortamUyar(f, c) {
  if (f.edoc_env && f.edoc_env !== c.ortam) {
    return 'Bu belge ' + ortamAd(f.edoc_env) + ' ortamında gönderildi; şu an ' + ortamAd(c.ortam) + ' ortamı seçili. '
      + (f.edoc_env === 'test' ? 'Test belgesinin yasal geçerliliği yoktur.' : 'Sorgu için ayarlarda canlı ortamı seçin.');
  }
  return null;
}
async function durumYaz(id, alanlar, t = db) {
  const k = Object.keys(alanlar);
  await t.exec(`UPDATE invoices SET ${k.map(x => x + ' = ?').join(', ')} WHERE id = ?`,
    k.map(x => alanlar[x]).concat([id]));
}

/**
 * The next e-Fatura number for this series, year and ENVIRONMENT.
 *
 * Counted per environment: numbers spent in test must not shift the live
 * sequence, which starts at 000000001 on the year's first live invoice.
 * The read is locked (FOR UPDATE) because the till is one service that
 * several stations talk to at once, and two cashiers pressing "Gönder"
 * in the same second would otherwise both see the same maximum.
 */
async function sonrakiEfaturaNo(t, seri, yil, ortam = 'canli') {
  const on = seri + yil;
  const enB = await t.value(
    `SELECT MAX(edoc_no) FROM invoices
      WHERE client_id = ? AND edoc_type = 'EFATURA' AND edoc_no LIKE ? AND COALESCE(edoc_env,'canli') = ?
      FOR UPDATE`,
    [await db.getClientId(), on + '%', ortam]);
  const sira = enB ? Number(String(enB).slice(7)) + 1 : 1;
  return on + String(sira).padStart(9, '0');
}

async function gonder(ctx, invoiceId, { zamanMs } = {}) {
  const clientId = await db.getClientId();
  const c = await conf();
  if (!c.aktif) return { ok: false, error: 'e-Fatura / e-Arşiv kapalı (Ayarlar → e-Fatura / e-Arşiv).' };
  if (!/^\d{10,11}$/.test(c.vkn)) return { ok: false, error: 'e-Belge ayarlarında işletmenin VKN/TCKN\'si eksik.' };
  const kilitK = clientId + ':' + invoiceId;
  if (_kilit.has(kilitK)) return { ok: false, error: 'Bu fatura şu anda gönderiliyor.' };
  _kilit.add(kilitK);
  try {
    let f = await db.one('SELECT * FROM invoices WHERE id = ? AND client_id = ?', [invoiceId, clientId]);
    if (!f) return { ok: false, error: 'Fatura bulunamadı.' };
    if (f.status === 'cancelled') return { ok: false, error: 'İptal edilmiş fatura e-belge olarak gönderilemez.' };
    if (f.edoc_env && f.edoc_env !== c.ortam) {
      /* Tried in another environment. A test document that DID come into
         existence is not migrated; one that never existed has its
         identities cleared and is sent fresh in this environment. */
      if (['tamam', 'kuyrukta', 'iptal'].includes(f.edoc_state)) {
        return { ok: false, error: 'Bu fatura ' + ortamAd(f.edoc_env) + ' ortamında belge olarak oluştu; ' + ortamAd(c.ortam) + ' ortamına taşınamaz. Gerekirse faturayı iptal edip yeniden kesin.' };
      }
      await durumYaz(invoiceId, { edoc_type: null, edoc_uuid: null, edoc_no: null, edoc_oid: null, edoc_label: null,
                                  edoc_url: null, edoc_state: null, edoc_error: null, edoc_env: null, edoc_sent_at: null });
      f = await db.one('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    }
    if (['tamam', 'kuyrukta'].includes(f.edoc_state)) return { ok: true, zaten: true, durum: f.edoc_state };
    if (f.edoc_state === 'belirsiz' || f.edoc_state === 'gonderiliyor') {
      /* Ask first: did it actually come into existence? */
      const d = await durumSorgula(ctx, invoiceId);
      f = await db.one('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
      if (d.ok && ['tamam', 'kuyrukta'].includes(f.edoc_state)) return Object.assign({ kurtarildi: true }, d);
      if (!d.bulunamadi) {
        return { ok: false, error: 'Önceki gönderimin sonucu hâlâ bilinmiyor: ' + (d.error || '') + ' Biraz sonra yeniden deneyin.' };
      }
    }
    const kalemler = await db.query('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', [invoiceId]);
    if (!kalemler.length) return { ok: false, error: 'Faturada kalem yok.' };
    const ekler = await db.query('SELECT * FROM invoice_charges WHERE invoice_id = ? ORDER BY id', [invoiceId]);
    const ana = f.parent_id ? await db.one('SELECT * FROM invoices WHERE id = ?', [f.parent_id]) : null;

    /* --- Type: is the buyer registered for e-Fatura? Fixed on the first
           send, so a later registry change cannot move an existing
           document from one rail to the other. --- */
    let tip = f.edoc_type;
    let alanEtiket = f.edoc_label || null;
    if (!tip) {
      const alici = String(f.cust_tax_no || '');
      if (/^\d{10,11}$/.test(alici) && alici !== '11111111111' && alici !== '22222222222') {
        const m = await mukellef(alici, { conf: c, invoiceId });
        if (!m.ok) return { ok: false, error: 'Alıcının e-Fatura kaydı sorgulanamadı: ' + m.error + ' Fatura gönderilmedi.' };
        const kz = m.kayitZamani ? m.kayitZamani.slice(0, 4) + '-' + m.kayitZamani.slice(4, 6) + '-' + m.kayitZamani.slice(6, 8) : null;
        if (m.kayitli && (!kz || String(f.issue_date).slice(0, 10) >= kz)) { tip = 'EFATURA'; alanEtiket = m.etiketler[0]; }
        else tip = 'EARSIV';
      } else tip = 'EARSIV';
    }
    if (tip === 'EARSIV' && /nihai|muhtelif/i.test(String(f.cust_title || ''))) {
      return { ok: false, error: 'e-Arşiv faturasında alıcı adı "Nihai/Muhtelif Tüketici" olamaz (GİB). Müşterinin gerçek adını ve soyadını yazıp yeni fatura kesin.' };
    }

    /* --- The identities are written BEFORE the request leaves --- */
    const uuid = f.edoc_uuid || crypto.randomUUID().toUpperCase();
    let no = f.edoc_no;
    await db.tx(async (t) => {
      if (tip === 'EFATURA' && !no) no = await sonrakiEfaturaNo(t, c.efatura_seri, String(f.issue_date).slice(0, 4), c.ortam);
      await durumYaz(invoiceId, { edoc_type: tip, edoc_uuid: uuid, edoc_no: no || null, edoc_label: alanEtiket,
                                  edoc_state: 'gonderiliyor', edoc_error: null, edoc_env: c.ortam, edoc_sent_at: simdi() }, t);
    });
    f = await db.one('SELECT * FROM invoices WHERE id = ?', [invoiceId]);

    const xml = ubl(f, kalemler, { tip, no: no || ('NKT' + String(f.issue_date).slice(0, 4) + '000000000'), uuid, c, ekler, ana });
    const bytes = Buffer.from(xml, 'utf8');

    if (tip === 'EARSIV') {
      const govde = (erp) => `<ser:faturaOlusturExt><input>${xe(JSON.stringify(Object.assign(
        { islemId: uuid, vkn: c.vkn, sube: c.sube, kasa: c.kasa, donenBelgeFormati: 9, numaraVerilsinMi: 1 },
        erp ? { erpKodu: ERP_KODU } : {})))}</input>`
        + `<fatura><belgeFormati>UBL</belgeFormati><belgeIcerigi>${bytes.toString('base64')}</belgeIcerigi></fatura></ser:faturaOlusturExt>`;
      let r = await cagir(invoiceId, 'earsiv', 'faturaOlusturExt', govde(true), { conf: c, zamanMs });
      let erpUyari = null;
      if (c.ortam === 'test' && r.ok && /ERP kayıt listesinde bulunamadı/i.test(etiket(r.text, 'resultText') || '')) {
        erpUyari = 'e-Arşiv TEST ortamında ERP kodu tanımlı değil; ERP kodsuz gönderildi (yalnızca testte).';
        r = await cagir(invoiceId, 'earsiv', 'faturaOlusturExt', govde(false), { conf: c, zamanMs });
      }
      return earsivSonuc(invoiceId, r, erpUyari);
    }

    /* e-FATURA */
    const md5 = crypto.createHash('md5').update(bytes).digest('hex').toUpperCase();
    const r = await cagir(invoiceId, 'efatura', 'belgeGonderExt',
      `<ser:belgeGonderExt><parametreler><vergiTcKimlikNo>${xe(c.vkn)}</vergiTcKimlikNo><belgeTuru>FATURA_UBL</belgeTuru>`
      + `<belgeNo>${xe(no)}</belgeNo><veri>${bytes.toString('base64')}</veri><belgeHash>${md5}</belgeHash>`
      + `<mimeType>application/xml</mimeType><belgeVersiyon>1.0</belgeVersiyon><erpKodu>${ERP_KODU}</erpKodu>`
      + (alanEtiket ? `<alanEtiket>${xe(alanEtiket)}</alanEtiket>` : '')
      + (c.gonderen_etiket ? `<gonderenEtiket>${xe(c.gonderen_etiket)}</gonderenEtiket>` : '')
      + `</parametreler></ser:belgeGonderExt>`, { conf: c, zamanMs });
    if (!r.ok) {
      if (r.baglanmadi) {
        await durumYaz(invoiceId, { edoc_state: 'hata', edoc_error: r.error });
        return { ok: false, error: r.error + ' e-Fatura gönderilmedi.' };
      }
      if (r.fault) {
        const e = r.error + erpIpucu(r.fault);
        await durumYaz(invoiceId, { edoc_state: 'hata', edoc_error: e });
        return { ok: false, error: e };
      }
      await durumYaz(invoiceId, { edoc_state: 'belirsiz', edoc_error: r.error || ('HTTP ' + r.status) });
      return { ok: false, belirsiz: true, error: 'QNB yanıt vermedi (' + (r.error || r.status) + '). e-Fatura alınmış OLABİLİR; "Durumu sorgula" deyin, yeni fatura KESMEYİN.' };
    }
    const oid = etiket(r.text, 'belgeOid');
    if (!oid) {
      await durumYaz(invoiceId, { edoc_state: 'belirsiz', edoc_error: 'belgeOid dönmedi' });
      return { ok: false, belirsiz: true, error: 'QNB yanıtında belge numarası yok; "Durumu sorgula" deyin.' };
    }
    await durumYaz(invoiceId, { edoc_oid: oid, edoc_state: 'kuyrukta', edoc_error: null });
    await audit(ctx, 'ebelge.gonder', 'invoice', invoiceId, { tip, no, ettn: uuid, ortam: c.ortam });
    return { ok: true, tip, no, uuid, durum: 'kuyrukta' };
  } finally { _kilit.delete(kilitK); }
}

/* If NOKTApp's ERP code is not registered on the customer's own QNB
   account, QNB refuses. The fix is on QNB's side, not the restaurant's. */
function erpIpucu(metin) {
  return /erp/i.test(String(metin || ''))
    ? ' → NOKTApp ERP kodu (' + ERP_KODU + ') QNB\'de bu ortam için tanımlı görünmüyor; NOKTApp desteğe bildirin (işletmenin yapacağı bir şey yok).'
    : '';
}

async function earsivSonuc(invoiceId, r, erpUyari) {
  if (!r.ok) {
    if (r.baglanmadi || r.fault) {
      await durumYaz(invoiceId, { edoc_state: 'hata', edoc_error: r.error });
      return { ok: false, error: r.error + ' e-Arşiv faturası oluşmadı.' };
    }
    await durumYaz(invoiceId, { edoc_state: 'belirsiz', edoc_error: r.error || ('HTTP ' + r.status) });
    return { ok: false, belirsiz: true, error: 'QNB yanıt vermedi (' + (r.error || r.status) + '). Fatura oluşmuş OLABİLİR; "Durumu sorgula" deyin. Aynı ETTN ile yeniden göndermek çift fatura üretmez.' };
  }
  const kod = etiket(r.text, 'resultCode'); const metin = etiket(r.text, 'resultText');
  if (kod !== 'AE00000') {
    const ipucu = erpIpucu(metin);
    await durumYaz(invoiceId, { edoc_state: 'hata', edoc_error: ((kod || '') + ' ' + (metin || '') + ipucu).slice(0, 500) });
    return { ok: false, error: 'QNB e-Arşiv faturasını kabul etmedi: ' + (metin || kod) + ' (' + kod + ')' + ipucu };
  }
  const ex = ekstra(r.text);
  await durumYaz(invoiceId, { edoc_state: 'tamam', edoc_no: ex.faturaNo || null, edoc_url: ex.faturaURL || null,
                              edoc_error: erpUyari });
  return { ok: true, tip: 'EARSIV', no: ex.faturaNo, uuid: ex.uuid, url: ex.faturaURL, durum: 'tamam', uyari: erpUyari };
}

/* ------------------------------------------------------------------ */
/*  STATUS                                                            */
/* ------------------------------------------------------------------ */
async function durumSorgula(ctx, invoiceId) {
  const clientId = await db.getClientId();
  const f = await db.one('SELECT * FROM invoices WHERE id = ? AND client_id = ?', [invoiceId, clientId]);
  if (!f || !f.edoc_type) return { ok: false, error: 'Bu fatura e-belge olarak gönderilmemiş.' };
  const c = await conf();
  const uy = ortamUyar(f, c); if (uy) return { ok: false, error: uy };
  if (f.edoc_type === 'EARSIV') {
    const r = await cagir(invoiceId, 'earsiv', 'faturaSorgula',
      `<ser:faturaSorgula><input>${xe(JSON.stringify({ vkn: c.vkn, faturaUuid: f.edoc_uuid, donenBelgeFormati: 9 }))}</input></ser:faturaSorgula>`,
      { conf: c, zamanMs: 30000 });
    if (!r.ok) return { ok: false, error: r.error || ('HTTP ' + r.status) };
    const kod = etiket(r.text, 'resultCode');
    if (kod === 'AE00002') {
      /* Genuinely absent. The SAME ETTN may be used again - that is the
         whole point of writing it down before sending. */
      if (f.edoc_state !== 'tamam') {
        await durumYaz(invoiceId, { edoc_state: 'hata', edoc_error: 'QNB\'de bu ETTN ile fatura yok (oluşmamış). Yeniden gönderilebilir.' });
      }
      return { ok: true, bulunamadi: true };
    }
    if (kod !== 'AE00000') return { ok: false, error: etiket(r.text, 'resultText') || kod };
    const ex = ekstra(r.text);
    await durumYaz(invoiceId, { edoc_state: ex.iptalTarihi ? 'iptal' : 'tamam', edoc_no: ex.faturaNo || f.edoc_no,
                                edoc_url: ex.faturaURL || f.edoc_url });
    return { ok: true, durum: ex.iptalTarihi ? 'iptal' : 'tamam', no: ex.faturaNo };
  }
  /* e-Fatura: by OID when we have one, otherwise by our own number. */
  const [no, tipi] = f.edoc_oid ? [f.edoc_oid, 'OID'] : [f.edoc_no, 'YEREL'];
  const r = await cagir(invoiceId, 'efatura', 'gidenBelgeDurumSorgulaExt',
    `<ser:gidenBelgeDurumSorgulaExt><vergiTcKimlikNo>${xe(c.vkn)}</vergiTcKimlikNo><parametreler><belgeNo>${xe(no)}</belgeNo>`
    + `<belgeNoTipi>${tipi}</belgeNoTipi><belgeTuru>FATURA</belgeTuru><donusTipiVersiyon>6.0</donusTipiVersiyon></parametreler></ser:gidenBelgeDurumSorgulaExt>`,
    { conf: c, zamanMs: 30000 });
  if (!r.ok) {
    if (r.fault && /bulunamad|kayıt yok|not found/i.test(r.fault)) {
      await durumYaz(invoiceId, { edoc_state: 'hata', edoc_error: 'QNB\'de bu numarayla e-Fatura yok (alınmamış). Yeniden gönderilebilir.' });
      return { ok: true, bulunamadi: true };
    }
    return { ok: false, error: r.error || ('HTTP ' + r.status) };
  }
  const durum = etiket(r.text, 'durum');
  const oid = etiket(r.text, 'yerelBelgeOid') || f.edoc_oid;
  const detay = etiket(r.text, 'gonderimCevabiDetayi') || etiket(r.text, 'aciklama') || '';
  if (durum === '3') {
    /* "İşlendi" means QNB finished ITS work, not that the invoice reached
       the buyer. The decision belongs to the GİB envelope response code:
       in the live test, durum 3 + 1172 TPS_POSTA_KUTUSU_YETKISI_YOK with
       ulastiMi false meant the invoice had NOT gone. */
    const kod = Number(etiket(r.text, 'gonderimCevabiKodu') || 0);
    const ulasti = etiket(r.text, 'ulastiMi') === 'true';
    const sinif = gibKodu(kod, ulasti);
    if (sinif === 'tamam') {
      await durumYaz(invoiceId, { edoc_state: 'tamam', edoc_oid: oid, edoc_error: null });
      return { ok: true, durum: 'tamam', detay };
    }
    if (sinif === 'hata') {
      const tekrar = etiket(r.text, 'yenidenGonderilebilirMi') === 'true';
      await durumYaz(invoiceId, { edoc_state: 'hata', edoc_oid: oid,
        edoc_error: ('GİB fatura iletmedi: ' + detay + (tekrar ? ' (düzeltip yeniden gönderilebilir)' : '')).slice(0, 500) });
      return { ok: true, durum: 'hata', detay };
    }
    await durumYaz(invoiceId, { edoc_state: 'kuyrukta', edoc_oid: oid, edoc_error: detay ? ('GİB\'de işleniyor: ' + detay).slice(0, 500) : null });
    return { ok: true, durum: 'kuyrukta', detay };
  }
  if (durum === '2') {
    await durumYaz(invoiceId, { edoc_state: 'hata', edoc_oid: oid, edoc_error: ('İşleme hatası: ' + detay).slice(0, 500) });
    return { ok: true, durum: 'hata', detay };
  }
  await durumYaz(invoiceId, { edoc_state: 'kuyrukta', edoc_oid: oid });
  return { ok: true, durum: 'kuyrukta' };
}

/* GİB envelope response codes (e-Fatura packaging guide):
   1000/1100 queued-processing · 1110-1195 envelope/schema/authorisation
   errors · 1200 GİB processed it · 1210/1215/1230 could not be delivered
   to the buyer · 1220 waiting for the buyer's answer · 1300 completed. */
function gibKodu(kod, ulasti) {
  if (ulasti || kod === 1300) return 'tamam';
  if (!kod || kod === 1000 || kod === 1100 || kod === 1200 || kod === 1220) return 'bekliyor';
  return 'hata';
}

/** Background: asks for the outcome of the queued e-Faturas. */
async function kuyrukTara() {
  const c = await conf();
  if (!c.aktif) return 0;
  /* Locked out on a wrong password: a sweep here would be 20 more
     attempts every five minutes, which is precisely how QNB blocks the
     account. Nothing happens until somebody saves the new password. */
  if (kilitliMi()) return 0;
  const bekleyen = await db.query(
    `SELECT id FROM invoices WHERE client_id = ? AND edoc_state = 'kuyrukta' AND COALESCE(edoc_env,'test') = ?
      ORDER BY id LIMIT 20`, [await db.getClientId(), c.ortam]);
  for (const b of bekleyen) {
    try { await durumSorgula({}, b.id); } catch (e) { /* next round */ }
  }
  return bekleyen.length;
}

/* ------------------------------------------------------------------ */
/*  PDF                                                               */
/* ------------------------------------------------------------------ */
function zipIlk(buf) {
  /* Single-entry zip: reads the first local header, which is all a PDF
     or an XML needs. */
  if (buf.readUInt32LE(0) !== 0x04034b50) return buf;
  const yontem = buf.readUInt16LE(8); const boyut = buf.readUInt32LE(18);
  const bas = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  const ham = buf.subarray(bas, boyut ? bas + boyut : undefined);
  return yontem === 0 ? ham : zlib.inflateRawSync(ham, { maxOutputLength: ACMA_SINIR });
}
function coz(b64) {
  let b = Buffer.from(String(b64 || '').replace(/\s+/g, ''), 'base64');
  if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b, { maxOutputLength: ACMA_SINIR });
  if (b.length > 4 && b.readUInt32LE(0) === 0x04034b50) b = zipIlk(b);
  return b;
}
async function pdf(ctx, invoiceId) {
  const f = await db.one('SELECT * FROM invoices WHERE id = ? AND client_id = ?', [invoiceId, await db.getClientId()]);
  if (!f || !['tamam', 'iptal'].includes(f.edoc_state)) return { ok: false, error: 'e-Belge henüz oluşmadı.' };
  const c = await conf();
  const uy = ortamUyar(f, c); if (uy) return { ok: false, error: uy };
  if (f.edoc_type === 'EARSIV') {
    const r = await cagir(invoiceId, 'earsiv', 'faturaSorgula',
      `<ser:faturaSorgula><input>${xe(JSON.stringify({ vkn: c.vkn, faturaUuid: f.edoc_uuid, donenBelgeFormati: 3 }))}</input></ser:faturaSorgula>`,
      { conf: c, zamanMs: 60000 });
    if (!r.ok || etiket(r.text, 'resultCode') !== 'AE00000') {
      return { ok: false, error: r.error || etiket(r.text, 'resultText') || 'PDF alınamadı.' };
    }
    try { return { ok: true, pdf: coz(etiket(r.text, 'belgeIcerigi')) }; } catch (e) { return { ok: false, error: 'PDF açılamadı: ' + e.message }; }
  }
  const r = await cagir(invoiceId, 'efatura', 'gidenBelgeleriIndir',
    `<ser:gidenBelgeleriIndir><vergiTcKimlikNo>${xe(c.vkn)}</vergiTcKimlikNo><belgeOidListesi>${xe(f.edoc_oid)}</belgeOidListesi>`
    + `<belgeTuru>FATURA</belgeTuru><belgeFormati>PDF</belgeFormati></ser:gidenBelgeleriIndir>`, { conf: c, zamanMs: 60000 });
  if (!r.ok) return { ok: false, error: r.error || 'PDF alınamadı.' };
  try { return { ok: true, pdf: coz(etiket(r.text, 'return')) }; } catch (e) { return { ok: false, error: 'PDF açılamadı: ' + e.message }; }
}

/* ------------------------------------------------------------------ */
/*  CANCEL (e-Arşiv only; an e-Fatura is cancelled through GİB)        */
/* ------------------------------------------------------------------ */
async function iptalOnKosul(ctx, invoiceId) {
  const f = await db.one('SELECT * FROM invoices WHERE id = ? AND client_id = ?', [invoiceId, await db.getClientId()]);
  if (!f || !f.edoc_type || !f.edoc_state || f.edoc_state === 'hata') return { ok: true, yerel: true };
  if (f.edoc_state === 'iptal') return { ok: true, yerel: true };
  const c = await conf();
  /* A test document has no legal counterpart: if the environment has
     moved on to live, the invoice is cancelled locally and QNB is not
     contacted at all. */
  if (f.edoc_env === 'test' && c.ortam !== 'test') return { ok: true, yerel: true };
  const uy = ortamUyar(f, c); if (uy) return { ok: false, error: uy };
  if (f.edoc_type === 'EFATURA') {
    return { ok: false, error: 'Bu fatura e-Fatura olarak GİB\'e iletildi; programdan iptal edilemez. İade faturası kesin ya da alıcıyla GİB portalı üzerinden iptal süreci yürütün.' };
  }
  if (f.edoc_state !== 'tamam') return { ok: false, error: 'e-Arşiv faturasının durumu netleşmeden iptal edilemez. Önce "Durumu sorgula".' };
  const r = await cagir(invoiceId, 'earsiv', 'faturaIptalEt',
    `<ser:faturaIptalEt><input>${xe(JSON.stringify({ vkn: c.vkn, faturaUuid: f.edoc_uuid }))}</input></ser:faturaIptalEt>`,
    { conf: c, zamanMs: 30000 });
  if (!r.ok || etiket(r.text, 'resultCode') !== 'AE00000') {
    return { ok: false, error: 'QNB e-Arşiv iptalini kabul etmedi: ' + (r.error || etiket(r.text, 'resultText') || '') + ' Fatura iptal EDİLMEDİ.' };
  }
  await durumYaz(invoiceId, { edoc_state: 'iptal' });
  await audit(ctx, 'ebelge.earsiv_iptal', 'invoice', invoiceId, { ettn: f.edoc_uuid, no: f.edoc_no });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/*  CONNECTION TEST (creates no document)                             */
/* ------------------------------------------------------------------ */
async function sina() {
  const c = await conf();
  const out = {};
  const ef = await cagir(null, 'efatura', 'efaturaKullaniciBilgisi',
    `<ser:efaturaKullaniciBilgisi><vergiTcKimlikNo>${xe(c.vkn)}</vergiTcKimlikNo></ser:efaturaKullaniciBilgisi>`,
    { conf: c, zamanMs: 20000 });
  out.efatura = ef.ok
    ? { ok: true, etiket: etiket(ef.text, 'etiket'), unvan: etiket(ef.text, 'unvan') }
    : { ok: false, error: ef.error || ('HTTP ' + ef.status) };
  const ea = await cagir(null, 'earsiv', 'efaturaKullanicisi',
    `<ser:efaturaKullanicisi><vergiTcKimlikNo>${xe(c.vkn)}</vergiTcKimlikNo></ser:efaturaKullanicisi>`,
    { conf: c, zamanMs: 20000 });
  out.earsiv = ea.ok ? { ok: true } : { ok: false, error: ea.error || ('HTTP ' + ea.status) };
  try { out.kontor = await kontor(); } catch (e) { /* a kontör failure does not fail the test */ }
  return out;
}

/** Remaining kontör (QNB: kontorBilgisiGetir). Cached in the settings. */
async function kontor() {
  const c = await conf();
  const out = { t: new Date().toISOString(), ortam: c.ortam };
  for (const [k, tip] of [['efatura', 'FATURA'], ['earsiv', 'ARSIV']]) {
    const r = await cagir(null, 'efatura', 'kontorBilgisiGetir',
      `<ser:kontorBilgisiGetir><vknTckn>${xe(c.vkn)}</vknTckn><kontorTipi>${tip}</kontorTipi><kontorBirimi>ADET</kontorBirimi></ser:kontorBilgisiGetir>`,
      { conf: c, zamanMs: 20000 });
    if (!r.ok) { out[k] = { ok: false, error: r.error || ('HTTP ' + r.status) }; continue; }
    const kalan = etiket(r.text, 'kalan');
    out[k] = kalan == null
      ? { ok: true, yok: true }
      : { ok: true, kalan: Number(kalan), toplam: Number(etiket(r.text, 'toplamAlinan') || 0), bitis: etiket(r.text, 'bitisTarihi') };
  }
  await set('kontor_json', JSON.stringify(out));
  return out;
}
const KONTOR_AZ = 50;
async function kontorOku() {
  try { return JSON.parse(await A('kontor_json', '') || 'null'); } catch (e) { return null; }
}

async function sonKayitlar(n = 30) {
  return db.query('SELECT * FROM ebelge_log WHERE client_id = ? ORDER BY id DESC LIMIT ?',
    [await db.getClientId(), Math.max(1, Math.min(200, Number(n) || 30))]);
}

module.exports = {
  ERP_KODU, VARSAYILAN, QNB_ADRES, KONTOR_AZ,
  conf, kaydet, isletme, audit,
  soap, cagir, ubl, tarafXml, adresXml, vergiXml, eklerXml,
  xe, etiket, etiketler, ekstra, tutar, miktar, birimKodu, ilIlce, sokak, adSoyad, simdi,
  mukellef, gonder, durumSorgula, gibKodu, kuyrukTara, pdf, coz, iptalOnKosul,
  sina, kontor, kontorOku, sonKayitlar, sonrakiEfaturaNo, durumYaz, ortamUyar, ortamAd,
  kilitliMi, kilitAc,
  _mukellefCache: _mukellef,
};
