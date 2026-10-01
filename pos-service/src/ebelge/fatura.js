'use strict';
/* =====================================================================
   FATURA — building an invoice out of a restaurant bill
                                                   src/ebelge/fatura.js
   ---------------------------------------------------------------------
   This is the part Noktappera could not lend us. Noktappera is a retail
   program: it had invoices, and the QNB module simply read them. The till
   had no invoice at all. Its legal document was the ÖKC receipt, and that
   is still how an ordinary sale goes: the guest eats, pays, the device
   prints a fiscal receipt, and nothing here runs.

   A fatura happens when the guest ASKS for one. The bill is already
   closed and the receipt already printed, so the invoice is issued
   AGAINST that receipt and says so on its face:

     "Bu fatura 29.09.2026 tarihli 000148 no'lu ÖKC fişine istinaden
      düzenlenmiştir."

   Without that sentence the same meal is declared twice - once by the
   device's Z report and once by the invoice.

   THE FOUR RESTAURANT RULES

   1. SPLIT BILLS. A split bill is its own order in the till, so one
      invoice per order is the normal case. A guest may also want an
      invoice for SOME lines of one bill, so `itemIds` narrows it. What
      makes that safe is not this code: it is uq_ii_once in the database,
      which refuses to write an adisyon line into a second invoice. The
      screen cannot be careful enough on its own, and two waiters on two
      stations are exactly the case where it wouldn't be.

   2. İKRAM AT 0,00. A comped item stays ON the invoice, with its name
      and its quantity, at 0,00 - it is not silently dropped. Dropping it
      makes the invoice disagree with what the table was served, which is
      the first thing anyone checks.

   3. A SERVICE CHARGE IS A cac:AllowanceCharge, not a line. Inventing a
      product called "Servis ücreti" puts something nobody sold into the
      sales report and into stock.

      A DISCOUNT IS NOT. This looks inconsistent and is deliberate: the
      till already spreads a bill-wide discount across the lines, in
      kuruş by largest remainder (util/vat.js), and the ÖKC receipt was
      printed from that breakdown. An invoice that instead carried the
      discount as one document-level AllowanceCharge would be tidier UBL
      and would declare a different VAT split than the fiscal device
      already declared for the same meal. The receipt wins.

   4. NUMBERING COMES FROM ONE PLACE. Every station talks to this one
      service, and the number is allocated inside a transaction that
      locks its own row. Two cashiers pressing "Fatura" in the same
      second get consecutive numbers, not the same one, and the unique
      key on (client_id, full_no) is the backstop.
   ===================================================================== */
const db = require('../db');
const E = require('./index');
const { billVat, allocate } = require('../util/vat');
const { minor, bad } = require('../util/http');

/** A bill with everything an invoice needs, or a 400 saying what is missing. */
async function adisyon(clientId, orderId) {
  const o = await db.one(
    `SELECT o.*, f.fiscal_receipt_no, f.document_no, f.fiscal_timestamp, f.id AS fiscal_receipt_id
       FROM orders o
       LEFT JOIN fiscal_receipts f ON f.order_id = o.id AND f.client_id = o.client_id
      WHERE o.id = ? AND o.client_id = ? AND o.is_deleted = 0
      ORDER BY f.id DESC LIMIT 1`, [orderId, clientId]);
  if (!o) throw bad('Adisyon bulunamadı.', 404);
  const kalemler = await db.query(
    /* products has no unit column: a restaurant sells portions, and UBL's
       C62 ("adet") is what birimKodu maps that to. */
    `SELECT oi.*, p.name AS urun_adi
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id AND p.client_id = oi.client_id
      WHERE oi.order_id = ? AND oi.client_id = ? AND oi.is_deleted = 0
        AND oi.station_status <> 'cancelled'
      ORDER BY oi.id`, [orderId, clientId]);
  const indirimler = await db.query(
    'SELECT discount_value, reason, source FROM order_discounts WHERE order_id = ? AND client_id = ?',
    [orderId, clientId]);
  const odemeler = await db.query(
    `SELECT method, amount FROM order_payments
      WHERE order_id = ? AND client_id = ? AND is_deleted = 0 AND voided_at IS NULL`,
    [orderId, clientId]);
  return { o, kalemler, indirimler, odemeler };
}

/** Which lines of this bill have already been invoiced, and where. */
async function faturalanmis(clientId, orderId) {
  const rows = await db.query(
    `SELECT ii.order_item_id, ii.invoice_id, i.full_no, i.status
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE ii.client_id = ? AND ii.order_item_id IS NOT NULL
        AND ii.order_item_id IN (SELECT id FROM order_items WHERE order_id = ? AND client_id = ?)`,
    [clientId, orderId, clientId]);
  return rows;
}

/**
 * What the invoice for this bill would look like, without writing
 * anything. The screen shows this before the cashier commits, and the
 * same function produces the rows that are then stored - so what is
 * previewed and what is issued cannot drift.
 */
async function onizle(clientId, orderId, { itemIds = null, servis = 0 } = {}) {
  const { o, kalemler, indirimler, odemeler } = await adisyon(clientId, orderId);
  const alinmis = new Set((await faturalanmis(clientId, orderId))
    .filter(r => r.status !== 'cancelled').map(r => Number(r.order_item_id)));
  const sec = itemIds && itemIds.length ? new Set(itemIds.map(Number)) : null;

  const secili = kalemler.filter(k => (!sec || sec.has(Number(k.id))));
  const zatenVar = secili.filter(k => alinmis.has(Number(k.id)));
  const alinacak = secili.filter(k => !alinmis.has(Number(k.id)));

  /* İkram is a PAYMENT METHOD in the till, not a line flag: money the
     restaurant chose not to take. For the invoice it behaves exactly like
     a bill-wide discount, and for the same reason - there is no VAT on
     money that never arrived. */
  const ikram = odemeler.filter(p => p.method === 'ikram').reduce((s, p) => s + minor(p.amount), 0);
  const indirim = indirimler.reduce((s, d) => s + minor(d.discount_value), 0);

  /* The discount belongs to the WHOLE bill, so when only part of it is
     being invoiced only that part's share comes off - by the same
     largest-remainder split the till and the fiscal receipt used. */
  const hepsi = kalemler.map(k => minor(k.line_total));
  const toplamBrut = hepsi.reduce((s, v) => s + v, 0);
  const dusulecek = Math.max(0, Math.min(indirim + ikram, toplamBrut));
  const pay = allocate(dusulecek, hepsi);
  const payOf = new Map(kalemler.map((k, i) => [Number(k.id), pay[i]]));

  const satirlar = alinacak.map((k) => {
    const brut = minor(k.line_total) - (payOf.get(Number(k.id)) || 0);
    const oran = Number(k.vat_rate) || 0;
    const kdv = oran > 0 ? Math.round(brut * oran / (100 + oran)) : 0;
    return {
      order_item_id: Number(k.id),
      name: String(k.urun_adi || k.note || 'Ürün').slice(0, 250),
      qty: Math.round((Number(k.qty) || 1) * 1000),
      unit: 'adet',
      base_amount: brut - kdv,
      vat_rate: oran,
      vat_amount: kdv,
      /* Rule 2: a line that ends at nothing is an ikram. It keeps its
         name and quantity and prints 0,00. */
      is_gift: brut === 0 ? 1 : 0,
    };
  });

  /* Rule 3: the service charge, if any, as a document-level charge. Its
     rate follows the bill's highest line rate, because that is the rate
     the service on those items carries. */
  const ekler = [];
  const servisMinor = Math.max(0, minor(servis));
  if (servisMinor > 0) {
    const oran = satirlar.reduce((m, s) => Math.max(m, s.vat_rate), 0);
    const kdv = oran > 0 ? Math.round(servisMinor * oran / (100 + oran)) : 0;
    ekler.push({ is_charge: 1, reason: 'Servis ücreti', base_amount: servisMinor - kdv, vat_rate: oran, vat_amount: kdv });
  }

  const matrah = satirlar.reduce((s, x) => s + x.base_amount, 0) + ekler.reduce((s, x) => s + (x.is_charge ? x.base_amount : -x.base_amount), 0);
  const kdvT = satirlar.reduce((s, x) => s + x.vat_amount, 0) + ekler.reduce((s, x) => s + (x.is_charge ? x.vat_amount : -x.vat_amount), 0);

  /* The note the whole arrangement rests on. */
  const fisNo = o.fiscal_receipt_no || o.document_no || null;
  const fisTarih = o.fiscal_timestamp || o.closed_at || null;
  const not = fisNo
    ? 'Bu fatura ' + trTarih(fisTarih) + ' tarihli ' + fisNo + ' no\'lu ÖKC fişine istinaden düzenlenmiştir.'
    : null;

  return {
    order: {
      id: o.id, adisyon_no: o.adisyon_no, bill_label: o.bill_label, status: o.status,
      closed_at: o.closed_at, grand_total: o.grand_total,
    },
    fis: fisNo ? { no: fisNo, tarih: fisTarih, id: o.fiscal_receipt_id } : null,
    not,
    satirlar, ekler,
    zaten_faturalanmis: zatenVar.map(k => ({ id: Number(k.id), name: k.urun_adi })),
    indirim_minor: indirim, ikram_minor: ikram,
    subtotal_minor: matrah, vat_minor: kdvT, total_minor: matrah + kdvT,
    /* The till's own arithmetic for the same bill, so the screen can show
       that the two agree instead of asking anyone to trust it. */
    adisyon_kdv: billVat(kalemler.map(k => ({ lineTotal: k.line_total, vatRate: k.vat_rate })), (indirim + ikram) / 100),
  };
}

function trTarih(d) {
  const s = String(d || '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
}

/**
 * The next local invoice number, for this series and year.
 *
 * Allocated inside the caller's transaction with the row locked, so two
 * stations cannot read the same maximum. See rule 4 in the header.
 */
async function sonrakiNo(t, clientId, seri, yil) {
  const on = seri + yil;
  const en = await t.value(
    `SELECT MAX(full_no) FROM invoices WHERE client_id = ? AND full_no LIKE ? FOR UPDATE`,
    [clientId, on + '%']);
  const sira = en ? Number(String(en).slice(on.length)) + 1 : 1;
  return on + String(sira).padStart(6, '0');
}

const gerek = (v, m) => { const t = String(v == null ? '' : v).trim(); if (!t) throw bad(m); return t; };

/**
 * Issue the invoice.
 *
 * Everything happens in one transaction: the header, the lines, the
 * charges. If a line was invoiced a moment ago on another station,
 * uq_ii_once rejects the write and the whole invoice is rolled back -
 * there is no half-issued fatura, and the cashier is told which line.
 */
async function kes(ctx, orderId, b = {}) {
  const clientId = await db.getClientId();
  const alici = {
    cust_title: gerek(b.cust_title, 'Fatura ünvanı ya da alıcının adı gerekli.').slice(0, 200),
    cust_tax_no: gerek(b.cust_tax_no, 'Alıcının VKN ya da TCKN\'si gerekli.').replace(/\D/g, ''),
    cust_tax_office: String(b.cust_tax_office || '').trim().slice(0, 120) || null,
    cust_address: String(b.cust_address || '').trim().slice(0, 400) || null,
    cust_email: String(b.cust_email || '').trim().slice(0, 190) || null,
    cust_phone: String(b.cust_phone || '').trim().slice(0, 50) || null,
  };
  if (!/^\d{10,11}$/.test(alici.cust_tax_no)) throw bad('VKN 10, TCKN 11 haneli olmalı.');
  /* A "Nihai Tüketici" invoice is refused by GİB with AE00313, and it is
     refused HERE so the cashier finds out before the guest leaves rather
     than from a failed send afterwards. */
  if (/nihai|muhtelif/i.test(alici.cust_title)) {
    throw bad('Alıcı adı "Nihai/Muhtelif Tüketici" olamaz (GİB). Müşterinin gerçek adını ve soyadını ya da firma ünvanını yazın.');
  }

  const on = await onizle(clientId, orderId, { itemIds: b.item_ids || null, servis: b.servis || 0 });
  if (!on.satirlar.length) {
    throw bad(on.zaten_faturalanmis.length
      ? 'Bu satırlar zaten faturalandı.'
      : 'Faturaya girecek satır yok.');
  }
  const seri = ((await db.getSetting('ebelge.fatura_seri', 'FTR')) || 'FTR').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'FTR';
  const tarih = E.simdi().slice(0, 10);
  const yil = tarih.slice(0, 4);
  const notlar = [on.not, String(b.note || '').trim() || null].filter(Boolean).join(' ');

  let id = null, fullNo = null;
  try {
    await db.tx(async (t) => {
      fullNo = await sonrakiNo(t, clientId, seri, yil);
      id = await t.insert(
        `INSERT INTO invoices (client_id, order_id, kind, split_key, issue_date, full_no, note,
            cust_title, cust_tax_no, cust_tax_office, cust_address, cust_email, cust_phone, customer_id,
            subtotal_minor, vat_minor, total_minor, fis_no, fis_date, fiscal_receipt_id,
            status, created_by, created_at)
         VALUES (?,?,'sale',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'issued',?,NOW())`,
        [clientId, orderId, b.split_key || (on.order.bill_label || null), tarih, fullNo, notlar.slice(0, 500) || null,
         alici.cust_title, alici.cust_tax_no, alici.cust_tax_office, alici.cust_address, alici.cust_email, alici.cust_phone,
         b.customer_id || null, on.subtotal_minor, on.vat_minor, on.total_minor,
         on.fis ? on.fis.no : null, on.fis ? on.fis.tarih : null, on.fis ? on.fis.id : null,
         (ctx && ctx.userId) || null]);
      for (const s of on.satirlar) {
        await t.insert(
          `INSERT INTO invoice_items (client_id, invoice_id, order_item_id, name, qty, unit,
              base_amount, vat_rate, vat_amount, is_gift) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [clientId, id, s.order_item_id, s.name, s.qty, s.unit, s.base_amount, s.vat_rate, s.vat_amount, s.is_gift]);
      }
      for (const e of on.ekler) {
        await t.insert(
          `INSERT INTO invoice_charges (client_id, invoice_id, is_charge, reason, base_amount, vat_rate, vat_amount)
           VALUES (?,?,?,?,?,?,?)`,
          [clientId, id, e.is_charge, e.reason, e.base_amount, e.vat_rate, e.vat_amount]);
      }
    });
  } catch (e) {
    if (e && (e.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(e.message || ''))) {
      if (/uq_ii_once/.test(e.message || '')) {
        throw bad('Bu adisyon satırlarından biri bu arada başka bir faturaya girdi. Ekranı yenileyip kalanlarla devam edin.', 409);
      }
      throw bad('Aynı fatura numarası aynı anda verildi; yeniden deneyin.', 409);
    }
    throw e;
  }
  await E.audit(ctx, 'fatura.kes', 'invoice', id, { order_id: orderId, no: fullNo, total_minor: on.total_minor });

  /* Rule: "hemen gönder" is a setting, not a guess. If it is off the
     invoice exists and waits; the send button lives on its own card. */
  const c = await E.conf();
  let ebelge = null;
  if (c.aktif && c.otomatik) ebelge = await E.gonder(ctx, id);
  return { ok: true, id, full_no: fullNo, ebelge };
}

/**
 * A return invoice (IADE) against an existing one.
 *
 * The lines are copied from the parent, not from the bill: the bill may
 * have moved on, and what is being returned is what was invoiced. The
 * copies carry NO order_item_id, because those lines are already spoken
 * for by the original invoice and uq_ii_once would - correctly - refuse.
 */
async function iade(ctx, invoiceId, b = {}) {
  const clientId = await db.getClientId();
  const ana = await db.one('SELECT * FROM invoices WHERE id=? AND client_id=?', [invoiceId, clientId]);
  if (!ana) throw bad('Fatura bulunamadı.', 404);
  if (ana.kind === 'return') throw bad('İade faturasının iadesi kesilmez.');
  if (ana.status === 'cancelled') throw bad('İptal edilmiş faturanın iadesi kesilmez.');
  const varOlan = await db.one("SELECT id, full_no FROM invoices WHERE client_id=? AND parent_id=? AND status<>'cancelled'",
    [clientId, invoiceId]);
  if (varOlan) throw bad('Bu faturanın iadesi zaten kesilmiş: ' + varOlan.full_no, 409);
  const kalemler = await db.query('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id', [invoiceId]);
  const ekler = await db.query('SELECT * FROM invoice_charges WHERE invoice_id=? ORDER BY id', [invoiceId]);
  if (!kalemler.length) throw bad('Asıl faturada kalem yok.');

  const seri = ((await db.getSetting('ebelge.fatura_seri', 'FTR')) || 'FTR').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'FTR';
  const tarih = E.simdi().slice(0, 10);
  const sebep = String(b.reason || '').trim().slice(0, 300);
  const not = ('İade faturası. Asıl fatura: ' + (ana.edoc_no || ana.full_no) + '.' + (sebep ? ' ' + sebep : '')).slice(0, 500);

  let id = null, fullNo = null;
  await db.tx(async (t) => {
    fullNo = await sonrakiNo(t, clientId, seri, tarih.slice(0, 4));
    id = await t.insert(
      `INSERT INTO invoices (client_id, order_id, kind, parent_id, split_key, issue_date, full_no, note,
          cust_title, cust_tax_no, cust_tax_office, cust_address, cust_email, cust_phone, customer_id,
          subtotal_minor, vat_minor, total_minor, status, created_by, created_at)
       VALUES (?,?,'return',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'issued',?,NOW())`,
      [clientId, ana.order_id, invoiceId, ana.split_key, tarih, fullNo, not,
       ana.cust_title, ana.cust_tax_no, ana.cust_tax_office, ana.cust_address, ana.cust_email, ana.cust_phone,
       ana.customer_id, ana.subtotal_minor, ana.vat_minor, ana.total_minor, (ctx && ctx.userId) || null]);
    for (const k of kalemler) {
      await t.insert(
        `INSERT INTO invoice_items (client_id, invoice_id, order_item_id, name, qty, unit,
            base_amount, vat_rate, vat_amount, is_gift) VALUES (?,?,NULL,?,?,?,?,?,?,?)`,
        [clientId, id, k.name, k.qty, k.unit, k.base_amount, k.vat_rate, k.vat_amount, k.is_gift]);
    }
    for (const e of ekler) {
      await t.insert(
        `INSERT INTO invoice_charges (client_id, invoice_id, is_charge, reason, base_amount, vat_rate, vat_amount)
         VALUES (?,?,?,?,?,?,?)`, [clientId, id, e.is_charge, e.reason, e.base_amount, e.vat_rate, e.vat_amount]);
    }
  });
  await E.audit(ctx, 'fatura.iade', 'invoice', id, { parent_id: invoiceId, no: fullNo });
  /* A return that stays on this PC is a return nobody declared: it is
     sent on the same setting as a sale, not by hand. */
  const c = await E.conf();
  let ebelge = null;
  if (c.aktif && c.otomatik) ebelge = await E.gonder(ctx, id);
  return { ok: true, id, full_no: fullNo, ebelge };
}

/**
 * Cancel an invoice.
 *
 * The e-belge side goes first (iptalOnKosul): an e-Arşiv document is
 * cancelled at QNB before the local record changes, and an e-Fatura
 * cannot be cancelled from here at all - it needs a return invoice. Only
 * after QNB has agreed is the row marked, and the adisyon lines are
 * released so they can be invoiced again.
 */
async function iptal(ctx, invoiceId, b = {}) {
  const clientId = await db.getClientId();
  const f = await db.one('SELECT * FROM invoices WHERE id=? AND client_id=?', [invoiceId, clientId]);
  if (!f) throw bad('Fatura bulunamadı.', 404);
  if (f.status === 'cancelled') return { ok: true, zaten: true };
  const on = await E.iptalOnKosul(ctx, invoiceId);
  if (!on.ok) return { ok: false, error: on.error };
  await db.tx(async (t) => {
    await t.exec("UPDATE invoices SET status='cancelled', note=CONCAT(COALESCE(note,''),?) WHERE id=?",
      [' [İptal: ' + (String(b.reason || '').trim().slice(0, 150) || 'sebep yazılmadı') + ']', invoiceId]);
    /* Release the bill's lines. See uq_ii_once in the migration: the
       amounts and names stay, only the claim on the adisyon line goes. */
    await t.exec('UPDATE invoice_items SET order_item_id=NULL WHERE invoice_id=?', [invoiceId]);
  });
  await E.audit(ctx, 'fatura.iptal', 'invoice', invoiceId, { no: f.full_no, yerel: !!on.yerel, reason: b.reason || null });
  return { ok: true, yerel: !!on.yerel };
}

async function getir(invoiceId) {
  const clientId = await db.getClientId();
  const f = await db.one('SELECT * FROM invoices WHERE id=? AND client_id=?', [invoiceId, clientId]);
  if (!f) return null;
  f.kalemler = await db.query('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id', [invoiceId]);
  f.ekler = await db.query('SELECT * FROM invoice_charges WHERE invoice_id=? ORDER BY id', [invoiceId]);
  f.iadeler = await db.query('SELECT id, full_no, issue_date, edoc_state FROM invoices WHERE client_id=? AND parent_id=?',
    [clientId, invoiceId]);
  return f;
}

async function liste({ q = '', durum = '', gun = 60, limit = 200 } = {}) {
  const clientId = await db.getClientId();
  const w = ['client_id = ?']; const p = [clientId];
  if (q) {
    w.push('(full_no LIKE ? OR cust_title LIKE ? OR cust_tax_no LIKE ? OR edoc_no LIKE ?)');
    p.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%');
  }
  if (durum === 'bekleyen') w.push("(edoc_state IS NULL OR edoc_state IN ('hata','belirsiz','kuyrukta','gonderiliyor'))");
  else if (durum) { w.push('edoc_state = ?'); p.push(durum); }
  w.push('issue_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)');
  p.push(Math.max(1, Math.min(3650, Number(gun) || 60)));
  p.push(Math.max(1, Math.min(1000, Number(limit) || 200)));
  return db.query(
    `SELECT id, order_id, kind, issue_date, full_no, cust_title, cust_tax_no, total_minor, status,
            edoc_type, edoc_no, edoc_state, edoc_error, edoc_uuid, edoc_env, edoc_url, fis_no
       FROM invoices WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT ?`, p);
}

module.exports = { adisyon, faturalanmis, onizle, kes, iade, iptal, getir, liste, sonrakiNo, trTarih };
