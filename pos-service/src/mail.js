'use strict';
/**
 * Mailing a bill.
 *
 * The restaurant's own SMTP account is used when they set one up; otherwise the
 * mail is handed to our panel, which sends it from noreply@noktapp.com. Either
 * way the PDF is produced here on the PC, so the bill leaves the building
 * already finished. Queued first, sent by a worker, so a dropped connection
 * never loses a customer's invoice.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const db = require('./db');
const config = require('./config');
const log = require('./logger');
const licence = require('./licence');
const document = require('./print/document');
const { _money } = require('./util/http');

let timer = null;

/* ------------------------------- PDF ------------------------------ */
/*
 * Every cell is drawn at an explicit x with lineBreak:false, and y is advanced
 * by hand.
 *
 * The previous version chained doc.text(..., {width, continued:true}) to make
 * columns. PDFKit treats a continued fragment as more text in the same
 * paragraph - `width` reflows it instead of placing it - so the four headers
 * came out stacked one per line and "1  pizza  650,00  650,00" ran together
 * into a single wrapped blob. That is exactly what the customer was e-mailed.
 */
const PAGE = { left: 48, right: 547 };
const COL = {
  qty:   { x: 48,  w: 34,  align: 'left'  },
  name:  { x: 86,  w: 250, align: 'left'  },
  vat:   { x: 340, w: 45,  align: 'right' },
  unit:  { x: 389, w: 75,  align: 'right' },
  total: { x: 468, w: 79,  align: 'right' },
};

function cell(doc, text, col, y) {
  doc.text(String(text), col.x, y, { width: col.w, align: col.align, lineBreak: false });
}

function rule(doc, y, color = '#ddd', width = 0.5) {
  doc.moveTo(PAGE.left, y).lineTo(PAGE.right, y)
     .strokeColor(color).lineWidth(width).stroke();
}

async function billPdf(clientId, order, prebuilt) {
  fs.mkdirSync(config.tmpDir, { recursive: true });
  // the caller usually has the document already; building it twice would run
  // the header repair twice and log the same warning twice
  const doc0 = prebuilt || await document.billDocument(clientId, order);
  const file = path.join(config.tmpDir, `adisyon-${doc0.meta.adisyonNo}-${Date.now()}.pdf`);
  const { tl, qtyText } = document;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const out = fs.createWriteStream(file);
    doc.pipe(out);

    const B = doc0.business, M = doc0.meta, T = doc0.totals;

    /* ---- business ---- */
    doc.fontSize(20).fillColor('#FF7A1A').text(B.name, PAGE.left, 48);
    doc.fontSize(9).fillColor('#666');
    const addr = [B.address, B.city].filter(Boolean).join(' ');
    if (addr) doc.text(addr, PAGE.left, doc.y);
    if (B.phone) doc.text('Tel: ' + B.phone, PAGE.left, doc.y);
    if (B.taxOffice || B.taxNumber) {
      doc.text(`${B.taxOffice ? B.taxOffice + ' V.D.' : ''}${B.taxNumber ? '  No: ' + B.taxNumber : ''}`.trim(),
               PAGE.left, doc.y);
    }
    if (B.header) doc.fillColor('#111').text(B.header, PAGE.left, doc.y + 4);

    /* ---- bill meta ---- */
    doc.moveDown(1);
    doc.fillColor('#111').fontSize(14).text('HESAP FISI', PAGE.left, doc.y);
    doc.fontSize(9).fillColor('#666');
    const bits = [`Adisyon No: ${M.adisyonNo}`];
    if (M.tableName) bits.push(`Masa: ${M.tableName}${M.billLabel ? ' / ' + M.billLabel : ''}`);
    if (M.waiter) bits.push(`Garson: ${M.waiter}`);
    doc.text(bits.join('   |   '), PAGE.left, doc.y);
    doc.text('Tarih: ' + new Date(M.closedAt || M.openedAt || Date.now()).toLocaleString('tr-TR'),
             PAGE.left, doc.y);

    /* ---- item table ---- */
    let y = doc.y + 14;
    rule(doc, y, '#FF7A1A', 1.5);
    y += 7;
    doc.fontSize(9).fillColor('#666');
    cell(doc, 'Adet', COL.qty, y);
    cell(doc, 'Urun', COL.name, y);
    cell(doc, 'KDV', COL.vat, y);
    cell(doc, 'Birim', COL.unit, y);
    cell(doc, 'Tutar', COL.total, y);
    y += 14;
    rule(doc, y);
    y += 6;

    for (const l of doc0.lines) {
      if (y > 720) { doc.addPage(); y = 60; }
      doc.fontSize(10).fillColor('#111');
      cell(doc, qtyText(l.qty), COL.qty, y);
      // truncate rather than wrap: a long name must not push the money sideways
      cell(doc, l.name.length > 38 ? l.name.slice(0, 37) + '\u2026' : l.name, COL.name, y);
      cell(doc, l.vatRate ? '%' + l.vatRate : '-', COL.vat, y);
      cell(doc, tl(l.unitPrice), COL.unit, y);
      cell(doc, tl(l.lineTotal), COL.total, y);
      y += 15;
      if (l.note) {
        doc.fontSize(8).fillColor('#888');
        cell(doc, l.note, { x: COL.name.x, w: COL.name.w, align: 'left' }, y);
        y += 12;
      }
    }
    if (!doc0.lines.length) {
      doc.fontSize(10).fillColor('#888').text('Urun yok.', PAGE.left, y);
      y += 16;
    }

    /* ---- totals ---- */
    y += 4;
    doc.moveTo(300, y).lineTo(PAGE.right, y).strokeColor('#ddd').lineWidth(0.5).stroke();
    y += 8;
    const row = (label, val, opts = {}) => {
      doc.fontSize(opts.big ? 12 : 10).fillColor(opts.big ? '#111' : '#555');
      doc.text(label, 300, y, { width: 160, align: 'left', lineBreak: false });
      doc.fillColor(opts.big ? '#FF7A1A' : '#333');
      doc.text(val, 460, y, { width: 87, align: 'right', lineBreak: false });
      y += opts.big ? 20 : 15;
    };
    row('Ara Toplam', tl(T.subtotal) + ' TL');
    if (T.discount > 0) row('Indirim', '-' + tl(T.discount) + ' TL');
    /*
     * KDV is informational: it is already inside Ara Toplam. Labelling it
     * "dahil" is the difference between a guest reading the bill correctly and
     * a guest thinking they were charged the tax twice.
     */
    for (const v of doc0.vat) row(`KDV %${v.rate} (dahil)`, tl(v.vat) + ' TL');
    row('GENEL TOPLAM', tl(T.grand) + ' TL', { big: true });

    /*
     * The döviz courtesy lines, under the total they convert. Grey and small
     * against the orange GENEL TOPLAM above them: the weight on the page is
     * the page saying which figure is owed. The conversion, the rate and its
     * age were all settled in print/document.js - nothing is recomputed here.
     */
    for (const f of doc0.fx) {
      doc.fontSize(10).fillColor('#555')
         .text(document.APPROX.text + ' ' + f.amountText, 300, y,
               { width: 247, align: 'right', lineBreak: false });
      y += 13;
      doc.fontSize(8).fillColor('#999')
         .text(f.sourceText, 300, y, { width: 247, align: 'right', lineBreak: false });
      y += 12;
    }
    if (doc0.fx.length) {
      doc.fontSize(8).fillColor('#999')
         .text(doc0.fxNote, 300, y, { width: 247, align: 'right', lineBreak: false });
      y += 14;
    }

    if (doc0.payments.length) {
      y += 4;
      doc.fontSize(9).fillColor('#666').text('Odemeler', 300, y, { lineBreak: false });
      y += 14;
      for (const p of doc0.payments) row(p.label, tl(p.amount) + ' TL');
      if (T.remaining > 0) row('KALAN', tl(T.remaining) + ' TL');
      if (T.change > 0) row('Para ustu', tl(T.change) + ' TL');
    }

    /* ---- karekod ---- */
    /*
     * The same square the thermal printer draws, as a PNG from
     * print/document.qrPng - PDFKit has no SVG renderer, and a QR drawn here
     * out of rectangles would be a second implementation of the one thing on
     * this page that has to be byte-exact to work at all. If it cannot be
     * encoded the address is printed instead, because a PDF is read on a
     * screen where a URL can still be typed out.
     */
    if (doc0.qr) {
      const png = document.qrPng(doc0.qr.data);
      /*
       * The square and its caption need about 130pt. Taking a new page when
       * that room is not there is deliberate: the first version pinned the QR
       * near the bottom of the sheet, which pushed the footer past the bottom
       * margin and PDFKit answered by starting a second page containing
       * nothing but "Bizi tercih ettiginiz icin tesekkur ederiz". A two-page
       * bill for three kebabs is a worse bug than a QR on page two.
       */
      if (y + 130 > 690) { doc.addPage(); y = 60; }
      const qy = y + 18;
      if (png) {
        doc.image(png, PAGE.left, qy, { width: 96 });
        doc.fontSize(8).fillColor('#888')
           .text(doc0.qr.caption || doc0.qr.data, PAGE.left, qy + 102, { width: 190, lineBreak: true });
      } else {
        doc.fontSize(9).fillColor('#666').text(doc0.qr.caption || '', PAGE.left, qy);
        doc.fontSize(9).fillColor('#FF7A1A').text(doc0.qr.data, PAGE.left, doc.y, { width: 300 });
      }
      y = qy + 118;
    }

    /* ---- footer ---- */
    y = Math.max(y + 30, 700);
    doc.fontSize(9).fillColor('#888')
       .text(B.footer, PAGE.left, y, { align: 'center', width: PAGE.right - PAGE.left });
    doc.fontSize(8).fillColor('#bbb')
       .text('NOKTApp POS', PAGE.left, doc.y + 2, { align: 'center', width: PAGE.right - PAGE.left });
    doc.end();
    out.on('finish', () => resolve(file));
    out.on('error', reject);
  });
}

/* ------------------------------ queue ----------------------------- */
/**
 * The bill as HTML, for the body of the mail.
 *
 * The PDF is attached as well, but plenty of people read mail on a phone and
 * never open an attachment, so the bill has to be legible in the message
 * itself. Inline styles only and a table for layout - mail clients strip
 * <style> blocks and do not do flexbox.
 */
function billHtml(d) {
  const { tl, qtyText } = document;
  const B = d.business, M = d.meta, T = d.totals;
  const esc = (x) => String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ORANGE = '#FF7A1A';

  const meta = [
    M.tableName ? `<b>Masa:</b> ${esc(M.tableName)}${M.billLabel ? ' / ' + esc(M.billLabel) : ''}` : '',
    M.waiter ? `<b>Garson:</b> ${esc(M.waiter)}` : '',
    `<b>Adisyon No:</b> ${esc(M.adisyonNo)}`,
    `<b>Tarih:</b> ${new Date(M.closedAt || M.openedAt || Date.now()).toLocaleString('tr-TR')}`,
  ].filter(Boolean).join('<br>');

  const lines = d.lines.length ? d.lines.map(l => `
    <tr>
      <td style="padding:9px 8px;border-bottom:1px solid #F0F0F2;vertical-align:top">
        ${esc(l.name)}
        ${l.note ? `<div style="font-size:11px;color:#8A8A93;margin-top:2px">${esc(l.note)}</div>` : ''}
      </td>
      <td style="padding:9px 8px;border-bottom:1px solid #F0F0F2;text-align:center;white-space:nowrap">${qtyText(l.qty)}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #F0F0F2;text-align:right;color:#6B6B73;white-space:nowrap">${l.vatRate ? '%' + l.vatRate : '-'}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #F0F0F2;text-align:right;white-space:nowrap">${tl(l.unitPrice)}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #F0F0F2;text-align:right;white-space:nowrap"><b>${tl(l.lineTotal)}</b></td>
    </tr>`).join('')
    : `<tr><td colspan="5" style="padding:14px;color:#8A8A93">Urun yok.</td></tr>`;

  const tot = (label, val, opts = {}) => `
    <tr>
      <td style="padding:${opts.big ? '10px 8px 4px' : '3px 8px'};text-align:right;color:${opts.big ? '#1B1B1F' : '#6B6B73'};font-size:${opts.big ? '17px' : '14px'};${opts.big ? 'font-weight:700' : ''}">${label}</td>
      <td style="padding:${opts.big ? '10px 8px 4px' : '3px 8px'};text-align:right;white-space:nowrap;font-size:${opts.big ? '17px' : '14px'};font-weight:700;color:${opts.big ? ORANGE : '#1B1B1F'}">${val}</td>
    </tr>`;

  /*
   * The döviz block, immediately under GENEL TOPLAM.
   *
   * It deliberately does NOT use tot(): those rows are bold and one of them is
   * orange, and a converted amount that looks like the other totals is an
   * invitation to pay it. This is small, grey, and carries the rate and - when
   * the rate is old - the day it was set, so the reader can judge it.
   */
  const fxRows = d.fx.map(f => `
    <tr>
      <td colspan="2" style="padding:2px 8px;text-align:right;color:#6B6B73;font-size:13px;white-space:nowrap">
        <span style="color:#1B1B1F">${document.APPROX.html} ${esc(f.amountText)}</span>
        <span style="color:#8A8A93;font-size:11px">&nbsp;·&nbsp;${esc(f.sourceText)}</span>
      </td>
    </tr>`).join('') + (d.fx.length ? `
    <tr><td colspan="2" style="padding:2px 8px 8px;text-align:right;color:#8A8A93;font-size:11px">
      ${esc(d.fxNote)}</td></tr>` : '');

  const totals = [
    tot('Ara Toplam', tl(T.subtotal) + ' TL'),
    T.discount > 0 ? tot('Indirim', '-' + tl(T.discount) + ' TL') : '',
    // already inside Ara Toplam - say so, or it reads as an extra charge
    ...d.vat.map(v => tot(`KDV %${v.rate} (dahil)`, tl(v.vat) + ' TL')),
    tot('GENEL TOPLAM', tl(T.grand) + ' TL', { big: true }),
    fxRows,
    ...d.payments.map(p => tot(p.label, tl(p.amount) + ' TL')),
    T.remaining > 0 ? tot('Kalan', tl(T.remaining) + ' TL') : '',
    T.change > 0 ? tot('Para ustu', tl(T.change) + ' TL') : '',
  ].join('');

  /*
   * The karekod, as an inline data: URI PNG.
   *
   * Not the SVG the rest of the till renders: Gmail, Outlook and the iOS mail
   * client all refuse to draw an <img> whose source is an SVG, so a scannable
   * square in a mail body has to be a raster one. The address is written under
   * it as well, which the thermal slip cannot do usefully but a mail can - if
   * the client blocks images the reader still has somewhere to go.
   */
  const qrUri = d.qr ? document.qrDataUri(d.qr.data) : null;
  const qrBlock = d.qr ? `
    <div style="padding:18px 24px 0;text-align:center">
      ${qrUri ? `<img src="${qrUri}" width="132" height="132" alt="Karekod"
             style="width:132px;height:132px;display:inline-block;border:1px solid #EDEDEF;border-radius:8px">` : ''}
      ${d.qr.caption ? `<div style="font-size:12px;color:#6B6B73;margin-top:8px">${esc(d.qr.caption)}</div>` : ''}
      ${/^https?:\/\//i.test(d.qr.data)
        // only a real address becomes a link; the free-text mode can hold a
        // wifi password, and href="..." on that is a link to nowhere
        ? `<div style="font-size:11px;margin-top:4px"><a href="${esc(d.qr.data)}"
             style="color:${ORANGE};text-decoration:none">${esc(d.qr.data)}</a></div>`
        : `<div style="font-size:11px;margin-top:4px;color:#8A8A93">${esc(d.qr.data)}</div>`}
    </div>` : '';

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F6F6F7;padding:24px 12px">
  <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #E8E8EC">
    <div style="padding:22px 24px 0">
      <div style="font-size:24px;font-weight:700;color:${ORANGE}">${esc(B.name)}</div>
      <div style="font-size:12px;color:#8A8A93;line-height:1.6;margin-top:4px">
        ${esc([B.address, B.city].filter(Boolean).join(' '))}${B.phone ? '<br>Tel: ' + esc(B.phone) : ''}
        ${(B.taxOffice || B.taxNumber) ? `<br>${esc(B.taxOffice)}${B.taxOffice ? ' V.D.' : ''} ${B.taxNumber ? 'No: ' + esc(B.taxNumber) : ''}` : ''}
      </div>
      ${B.header ? `<div style="font-size:13px;color:#1B1B1F;margin-top:10px">${esc(B.header)}</div>` : ''}
      <div style="height:1px;background:${ORANGE};margin:16px 0 14px"></div>
      <div style="font-size:13px;color:#1B1B1F;line-height:1.7">${meta}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px;color:#1B1B1F">
      <thead>
        <tr style="background:#FAFAFB">
          <th style="padding:8px;text-align:left;font-size:12px;color:#6B6B73;font-weight:600">Urun</th>
          <th style="padding:8px;text-align:center;font-size:12px;color:#6B6B73;font-weight:600">Adet</th>
          <th style="padding:8px;text-align:right;font-size:12px;color:#6B6B73;font-weight:600">KDV</th>
          <th style="padding:8px;text-align:right;font-size:12px;color:#6B6B73;font-weight:600">Birim</th>
          <th style="padding:8px;text-align:right;font-size:12px;color:#6B6B73;font-weight:600">Tutar</th>
        </tr>
      </thead>
      <tbody>${lines}</tbody>
    </table>
    <table style="width:100%;border-collapse:collapse;margin-top:6px;font-family:inherit">
      <tbody>${totals}</tbody>
    </table>
    ${qrBlock}
    <div style="padding:20px 24px 24px;color:#8A8A93;font-size:12px;line-height:1.7;border-top:1px solid #F0F0F2;margin-top:14px">
      ${esc(B.footer)}<br>
      Bu dijital fisi tercih ederek dogayi korumaya destek oluyorsunuz.<br>
      <span style="color:#B4B4BB">Bu e-posta otomatik gonderilmistir, lutfen yanitlamayin.</span>
    </div>
  </div>
</div>`;
}

async function queueBill(clientId, orderId, toEmail) {
  const orders = require('./modules/orders');
  const order = await orders.getOrder(clientId, orderId);
  if (!order) { const e = new Error('Adisyon bulunamadi'); e.status = 404; throw e; }
  const d = await document.billDocument(clientId, order);
  const pdf = await billPdf(clientId, order, d);
  const subject = `${d.business.name} - Adisyon ${d.meta.adisyonNo}`;
  const body = billHtml(d);
  const id = await db.insert(
    'INSERT INTO np_mail_queue (client_id, order_id, to_email, subject, body_html, pdf_path, status, created_at) VALUES (?,?,?,?,?,?,\'pending\',NOW())',
    [clientId, orderId, String(toEmail).trim(), subject, body, pdf]);
  drain().catch(() => {});
  return { id, pdf };
}

async function transporter() {
  const host = await db.getSetting('smtp_host');
  if (!host) return null;
  return nodemailer.createTransport({
    host,
    port: Number(await db.getSetting('smtp_port', 465)),
    secure: String(await db.getSetting('smtp_secure', '1')) === '1',
    auth: { user: await db.getSetting('smtp_user'), pass: await db.getSetting('smtp_pass') },
  });
}

async function sendViaPanel(row) {
  const url = (await licence.panelUrl()) + '/api/desktop/mail.php';
  // db.one returns null when there is no row, and a till without an activated
  // licence has none. Reading client_id straight off that null threw a
  // TypeError which the queue caught and logged as "Cannot read properties of
  // null (reading 'client_id')" - a sentence that tells the restaurant nothing
  // while the guest's bill silently never arrives. Say what is actually wrong.
  const lic = await db.one('SELECT client_id, licence_key FROM np_licence WHERE id=1');
  if (!lic || !lic.client_id || !lic.licence_key) {
    throw new Error('Lisans kaydi bulunamadi, e-posta panel uzerinden '
      + 'gonderilemiyor. Lisansi etkinlestirin ya da Ayarlar > E-posta '
      + 'bolumunden kendi SMTP sunucunuzu tanimlayin.');
  }
  const pdf = row.pdf_path && fs.existsSync(row.pdf_path)
    ? fs.readFileSync(row.pdf_path).toString('base64') : null;
  const res = await licence.post(url, {
    client_id: lic.client_id, licence_key: lic.licence_key,
    to: row.to_email, subject: row.subject, html: row.body_html,
    attachment: pdf ? { filename: 'adisyon.pdf', content: pdf } : null,
  }, 45000);
  if (res.status !== 200 || !res.body.ok) throw new Error((res.body && res.body.error) || 'Panel mail hatasi');
  return true;
}

async function drain() {
  const rows = await db.query("SELECT * FROM np_mail_queue WHERE status='pending' AND attempts < 6 ORDER BY id LIMIT 10");
  for (const row of rows) {
    try {
      const tr = await transporter();
      if (tr) {
        const from = await db.getSetting('smtp_from', 'noreply@noktapp.com');
        await tr.sendMail({
          from, to: row.to_email, subject: row.subject, html: row.body_html,
          attachments: row.pdf_path && fs.existsSync(row.pdf_path)
            ? [{ filename: 'adisyon.pdf', path: row.pdf_path }] : [],
        });
      } else {
        await sendViaPanel(row);
      }
      await db.exec("UPDATE np_mail_queue SET status='sent', sent_at=NOW() WHERE id=?", [row.id]);
      log.info('mail', 'Bill mailed', { to: row.to_email, order: row.order_id });
    } catch (e) {
      await db.exec('UPDATE np_mail_queue SET attempts=attempts+1, last_error=? WHERE id=?',
        [String(e.message).slice(0, 250), row.id]);
      log.warn('mail', 'Mail failed, will retry', e.message);
    }
  }
}

function start() { if (!timer) timer = setInterval(() => drain().catch(() => {}), 20000); }
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { billHtml, billPdf, queueBill, drain, start, stop };
