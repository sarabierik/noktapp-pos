'use strict';
/**
 * /api/ebelge — invoices, e-Fatura / e-Arşiv, and the supplier mailbox.
 *
 * On permissions. Issuing an invoice for a guest who is standing at the
 * till is `fatura.kes` and a cashier has it. Everything with legal weight
 * and a deadline is `fatura.manage`: the QNB account and its passwords,
 * cancelling a document that already reached GİB, and answering a
 * supplier's TİCARİ invoice within the eight days GİB allows. Reading the
 * list is `report.view`, because an owner's phone should be able to look
 * without being able to send.
 *
 * On the PDF endpoints. They return QNB's own rendering, streamed
 * straight through: what the buyer must be given is the integrator's
 * document, not the till's A4 sheet. The till's own print stays available
 * as an information copy and says so on its face.
 */
const express = require('express');
const auth = require('../auth');
const db = require('../db');
const log = require('../logger');
const E = require('../ebelge');
const G = require('../ebelge/gelen');
const F = require('../ebelge/fatura');
const { ok, fail, wrap, id: needId } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);
const ctxOf = (req) => ({ clientId: req.clientId, userId: req.auth && req.auth.uid, role: req.auth && req.auth.role });

/* --------------------------------------------------------- ayarlar */

/**
 * Everything the settings screen needs, in one call — and NO password,
 * not even a masked one. `sifre_var` is the only thing the screen is
 * told: enough to render "•••••• (değiştirmek için yazın)" and to know
 * that leaving the field empty keeps what is stored.
 */
r.get('/ayarlar', auth.requirePerm('fatura.manage'), wrap(async (req, res) => {
  const c = await E.conf();
  const st = await E.isletme();
  ok(res, {
    ayar: {
      aktif: c.aktif, otomatik: c.otomatik, ortam: c.ortam, vkn: c.vkn,
      efatura_kullanici: c.efatura_kullanici, earsiv_kullanici: c.earsiv_kullanici,
      efatura_url: c.efatura_url, earsiv_url: c.earsiv_url,
      efatura_seri: c.efatura_seri, sube: c.sube, kasa: c.kasa,
      gonderen_etiket: c.gonderen_etiket, il: c.il, ilce: c.ilce,
      fatura_seri: await db.getSetting('ebelge.fatura_seri', 'FTR'),
      efatura_sifre_var: !!c.efatura_sifre, earsiv_sifre_var: !!c.earsiv_sifre,
      sifre_korumali: c.sifreKorumali, sifre_sarili: c.sifreSarili, sifre_yontemi: c.sifreYontemi,
    },
    isletme: st,
    varsayilan: E.VARSAYILAN,
    erp_kodu: E.ERP_KODU,
    kontor: await E.kontorOku(),
    kontor_az: E.KONTOR_AZ,
    /* The screen has to be able to say WHY nothing is going out. */
    kilit: E.kilitliMi(),
  });
}));

r.post('/ayarlar', auth.requirePerm('fatura.manage'), wrap(async (req, res) => {
  const b = req.body || {};
  const out = await E.kaydet(ctxOf(req), b);
  if (!out.ok) return fail(res, out.error, 400, 'EBELGE_AYAR');
  if (String(b.fatura_seri || '').trim()) {
    const s = String(b.fatura_seri).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    if (s.length === 3) await db.setSetting('ebelge.fatura_seri', s);
  }
  ok(res, { saved: true });
}));

/** The connection test. Creates no document — that is the whole point. */
r.post('/sina', auth.requirePerm('fatura.manage'), wrap(async (req, res) => {
  ok(res, { sonuc: await E.sina() });
}));

r.post('/kontor', auth.requirePerm('fatura.manage'), wrap(async (req, res) => {
  try { ok(res, { kontor: await E.kontor() }); }
  catch (e) { fail(res, 'Kontör sorgulanamadı: ' + e.message, 502, 'KONTOR'); }
}));

/** The QNB conversation log. No password is among its columns. */
r.get('/gunluk', auth.requirePerm('fatura.manage'), wrap(async (req, res) => {
  ok(res, { kayitlar: await E.sonKayitlar(req.query.n || 30) });
}));

/* --------------------------------------------------------- faturalar */

r.get('/faturalar', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const c = await E.conf();
  ok(res, {
    faturalar: await F.liste({ q: req.query.q || '', durum: req.query.durum || '', gun: req.query.gun || 60 }),
    ebelge: { aktif: c.aktif, ortam: c.ortam, otomatik: c.otomatik },
  });
}));

r.get('/faturalar/:id', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const f = await F.getir(needId(req.params.id, 'Fatura numarası gerekli.'));
  if (!f) return fail(res, 'Fatura bulunamadı.', 404, 'YOK');
  ok(res, { fatura: f });
}));

/**
 * What the invoice for this bill would be. Read-only, so the cashier can
 * show the guest the lines and the total before anything is issued.
 */
r.get('/adisyon/:orderId/onizle', auth.requirePerm('fatura.kes'), wrap(async (req, res) => {
  const itemIds = String(req.query.items || '').split(',').map(Number).filter(Boolean);
  ok(res, await F.onizle(req.clientId, needId(req.params.orderId, 'Adisyon numarası gerekli.'),
    { itemIds: itemIds.length ? itemIds : null, servis: req.query.servis || 0 }));
}));

r.post('/adisyon/:orderId/kes', auth.requirePerm('fatura.kes'), wrap(async (req, res) => {
  ok(res, await F.kes(ctxOf(req), needId(req.params.orderId, 'Adisyon numarası gerekli.'), req.body || {}));
}));

r.post('/faturalar/:id/gonder', auth.requirePerm('fatura.kes'), wrap(async (req, res) => {
  const out = await E.gonder(ctxOf(req), needId(req.params.id, 'Fatura numarası gerekli.'));
  if (!out.ok) return fail(res, out.error, out.belirsiz ? 502 : 400, { code: out.belirsiz ? 'EBELGE_BELIRSIZ' : 'EBELGE_HATA', belirsiz: !!out.belirsiz });
  ok(res, out);
}));

r.post('/faturalar/:id/durum', auth.requirePerm('fatura.kes'), wrap(async (req, res) => {
  const out = await E.durumSorgula(ctxOf(req), needId(req.params.id, 'Fatura numarası gerekli.'));
  /*
   * 502 means QNB failed us. "This invoice was never sent as an e-belge" is
   * not that - it is the caller asking about the wrong invoice, and answering
   * a bad gateway to it puts an upstream outage in the log for something that
   * never left the building.
   */
  if (!out.ok) {
    const bizim = /gönderilmemiş|bulunamadı/i.test(out.error || '');
    return fail(res, out.error, bizim ? 404 : 502, bizim ? 'EBELGE_YOK' : 'EBELGE_DURUM');
  }
  ok(res, out);
}));

r.post('/faturalar/:id/iade', auth.requirePerm('fatura.kes'), wrap(async (req, res) => {
  ok(res, await F.iade(ctxOf(req), needId(req.params.id, 'Fatura numarası gerekli.'), req.body || {}));
}));

r.post('/faturalar/:id/iptal', auth.requirePerm('fatura.manage'), wrap(async (req, res) => {
  const out = await F.iptal(ctxOf(req), needId(req.params.id, 'Fatura numarası gerekli.'), req.body || {});
  if (!out.ok) return fail(res, out.error, 400, 'EBELGE_IPTAL');
  ok(res, out);
}));

/** The legal document, as QNB rendered it. */
r.get('/faturalar/:id/pdf', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const fid = needId(req.params.id, 'Fatura numarası gerekli.');
  const out = await E.pdf(ctxOf(req), fid);
  if (!out.ok) return fail(res, out.error, 400, 'EBELGE_PDF');
  const f = await db.one('SELECT edoc_no FROM invoices WHERE id=?', [fid]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="' + String((f && f.edoc_no) || 'fatura').replace(/[^A-Za-z0-9]/g, '') + '.pdf"');
  res.end(out.pdf);
}));

/* --------------------------------------------------------- gelen */

r.get('/gelen', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const c = await E.conf();
  if (!c.aktif) return ok(res, { aktif: false, gelen: [], sayac: { toplam: 0, bekleyen: 0 } });
  ok(res, {
    aktif: true, ortam: c.ortam,
    gelen: await G.liste({ q: req.query.q || '', bekleyen: String(req.query.bekleyen || '') === '1' }),
    sayac: await G.sayac(),
    son_cekme: await db.getSetting('ebelge.gelen_son_' + c.ortam, null),
    yanit_gun: G.YANIT_GUN,
  });
}));

r.post('/gelen/cek', auth.requirePerm('fatura.manage'), wrap(async (req, res) => {
  const out = await G.cek(ctxOf(req));
  if (!out.ok) return fail(res, out.error, 502, 'GELEN_CEK');
  ok(res, out);
}));

r.get('/gelen/:id', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const gid = needId(req.params.id, 'Belge numarası gerekli.');
  const g = await G.getir(gid);
  if (!g) return fail(res, 'Fatura bulunamadı.', 404, 'YOK');
  const xml = g.xml || await G.xmlGetir(ctxOf(req), gid);
  delete g.xml;
  ok(res, { gelen: g, satirlar: G.satirlar(xml), yanitlanabilir: G.yanitlanabilir(g), yanit_gun: G.YANIT_GUN });
}));

r.post('/gelen/:id/yanit', auth.requirePerm('fatura.manage'), wrap(async (req, res) => {
  const out = await G.yanitVer(ctxOf(req), needId(req.params.id, 'Belge numarası gerekli.'), req.body || {});
  if (!out.ok) return fail(res, out.error, 400, 'GELEN_YANIT');
  ok(res, out);
}));

r.post('/gelen/:id/alis', auth.requirePerm('stock.manage'), wrap(async (req, res) => {
  const out = await G.alisaAktar(ctxOf(req), needId(req.params.id, 'Belge numarası gerekli.'));
  if (!out.ok) return fail(res, out.error, 400, 'GELEN_ALIS');
  ok(res, out);
}));

r.get('/gelen/:id/pdf', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const gid = needId(req.params.id, 'Belge numarası gerekli.');
  const out = await G.pdf(ctxOf(req), gid);
  if (!out.ok) return fail(res, out.error, 400, 'GELEN_PDF');
  const g = await G.getir(gid);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="' + String((g && g.belge_no) || 'gelen').replace(/[^A-Za-z0-9]/g, '') + '.pdf"');
  res.end(out.pdf);
}));

/* ------------------------------------------------------------------ */
/*  Background sweep of the e-Fatura queue                            */
/* ------------------------------------------------------------------ */
/*
 * An e-Fatura's outcome arrives minutes later and nobody is going to sit
 * on the invoice screen waiting for it. Without this, a queued invoice
 * stays "GİB kuyruğunda" until someone happens to press "Durumu sorgula",
 * and a refusal that needed fixing the same day is found next week.
 *
 * Five minutes, and only while the feature is on; kuyrukTara() takes at
 * most 20 invoices per pass and swallows its own errors so one bad row
 * cannot stop the sweep.
 */
let tarayici = null;
function taramaBaslat(ms = 5 * 60 * 1000) {
  if (tarayici) return tarayici;
  tarayici = setInterval(() => {
    E.kuyrukTara().catch((e) => log.warn('ebelge', 'kuyruk taranamadi', e.message));
  }, ms);
  if (tarayici.unref) tarayici.unref();
  return tarayici;
}
function taramaDur() { if (tarayici) { clearInterval(tarayici); tarayici = null; } }

module.exports = r;
module.exports.taramaBaslat = taramaBaslat;
module.exports.taramaDur = taramaDur;
