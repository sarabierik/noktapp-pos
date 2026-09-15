'use strict';
/**
 * MASA KAREKOD KARTLARI - the A5 card that sits on the table.
 *
 * This is the physical end of the digital menu. Everything else in the guest
 * half can be changed on a Tuesday afternoon; this gets sent to a print shop,
 * comes back on 300gsm, and stays on the table until it is spilled on. So the
 * things it gets wrong are expensive, and all four of them are guarded here:
 *
 *  1. THE QUIET ZONE. A QR symbol is four modules of white on every side plus
 *     the pattern. A code drawn to the edge of its own frame is a code a phone
 *     hunts for and often refuses - it has already happened once in this
 *     product, on the customer display, which is why receipt.js renders with
 *     `padding: 4`. The same number is enforced here, in QUIET, and the frame
 *     around the code is drawn OUTSIDE it.
 *  2. THE SIZE. 62mm of symbol on a 148mm page. A guest reads this sitting
 *     down, with the card flat on the table, phone maybe 40cm away; below
 *     about 40mm that becomes a lean-forward, and a menu people lean forward
 *     for is a menu they ask the waiter for instead.
 *  3. THE ADDRESS. Whatever floor.js prints, so a card printed from this
 *     screen and a card printed from the floor plan open the same page. That
 *     rule lives in ONE place (floor.qrCards) and is called, not copied.
 *  4. THE HANDLES. The venue's Instagram/Facebook/TikTok as receipt.js
 *     normalises them - the same function, so the card and the customer
 *     display can never disagree about what the venue's Instagram is.
 *
 * PDFKit, the two traps this codebase has already fallen into (src/report/pdf.js
 * carries the long version):
 *   - `continued: true` reflows rather than columnising, so every string here
 *     is drawn at an absolute x with `lineBreak: false`;
 *   - the built-in fonts are WinAnsi and have no ğ ş ı İ Ğ Ş at all. Every
 *     string goes through report/pdf's `ascii()` - the same fold the hesap
 *     fişi has always used - rather than shipping a Unicode TTF with the
 *     installer.
 */
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode-svg');
const db = require('../db');
const floor = require('./floor');
const guest = require('./guest');
const receipt = require('./receipt');
const config = require('../config');
const lan = require('../lan');
const { ascii } = require('../report/pdf');
const SOCIAL = require('../../public/social-marks.js');

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/* ------------------------------------------------------------ geometry */
const MM = 2.834645669;                 // 1mm in PDF points
const A5 = { w: 148 * MM, h: 210 * MM }; // 419.53 x 595.28 pt
const QUIET = 4;                        // modules of white on every side. Not negotiable.

const ORANGE = '#FF7A1A';
const ORANGE_DARK = '#EA580C';
const INK = '#18181B';
const INK_2 = '#52525B';
const INK_3 = '#8E8E96';
const LINE = '#E4E4E7';

/* ------------------------------------------------------------- the QR */

/**
 * The symbol as a grid of booleans.
 *
 * qrcode-svg is asked for the matrix rather than its SVG string because the
 * card is not drawn in SVG - PDFKit has no SVG - and re-parsing the library's
 * own output would be a second implementation of the same thing. `padding: 0`
 * here on purpose: the quiet zone is added by the drawing code below, so the
 * frame can be put outside it rather than on top of it.
 */
function matrix(text) {
  const q = new QRCode({ content: String(text), padding: 0, width: 256, height: 256, ecl: 'M', join: true });
  const n = q.qrcode.moduleCount;
  const rows = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(!!q.qrcode.modules[r][c]);
    rows.push(row);
  }
  return { n, rows };
}

/**
 * Draw the symbol into a square box, quiet zone included.
 *
 * `box` is the FULL square the code is allowed - white paper and all - so the
 * caller never has to remember to leave the margin, which is exactly the
 * mistake that produced an unscannable card the first time.
 *
 * Runs of adjacent dark modules are merged into one rectangle. A 33-module
 * symbol is 1089 squares; on forty tables that is forty-three thousand
 * rectangles in a file somebody has to email to a print shop.
 */
function drawQr(doc, text, x, y, box) {
  const { n, rows } = matrix(text);
  const step = box / (n + QUIET * 2);
  const ox = x + step * QUIET;
  const oy = y + step * QUIET;

  doc.save().fillColor('#FFFFFF').rect(x, y, box, box).fill();
  doc.fillColor(INK);
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!rows[r][c]) { c++; continue; }
      let run = 1;
      while (c + run < n && rows[r][c + run]) run++;
      // +0.35 closes the hairline seam some renderers leave between two
      // touching rectangles, which reads as a white grid over the symbol
      doc.rect(ox + c * step, oy + r * step, run * step + 0.35, step + 0.35).fill();
      c += run;
    }
  }
  doc.restore();
  return { step, quiet: step * QUIET };
}

/* -------------------------------------------------------- social marks */

/**
 * One network's glyph, from the shared geometry in public/social-marks.js -
 * the same numbers the customer display strokes. `size` is the box in points;
 * the source grid is 24x24.
 */
function drawMark(doc, key, x, y, size, color) {
  const shapes = SOCIAL.MARKS[key] || [];
  const s = size / 24;
  doc.save().translate(x, y).scale(s)
    .lineWidth(1.9).strokeColor(color).fillColor(color);
  for (const sh of shapes) {
    if (sh.t === 'rect') doc.roundedRect(sh.x, sh.y, sh.w, sh.h, sh.r);
    else if (sh.t === 'circle') doc.circle(sh.cx, sh.cy, sh.r);
    else doc.path(sh.d);
    if (sh.fill) doc.fill(); else doc.stroke();
  }
  doc.restore();
}

/** The handles to print, in the display's own order, already normalised. */
async function socials() {
  const row = await db.one('SELECT * FROM np_display_settings WHERE id=1').catch(() => null);
  if (!row || !Number(row.social_enabled)) return [];
  const out = [];
  for (const key of SOCIAL.ORDER) {
    const h = receipt.socialHandle(row['social_' + key]);
    if (h) out.push({ key, handle: h, shown: SOCIAL.display(key, h) });
  }
  return out;
}

/* ------------------------------------------------------------ the data */

/**
 * Split a table name into the big glyph and the word above it.
 *
 * "Masa 7" wants a 7 the size of a fist and a small "MASA" over it: that is
 * what a guest picks out from across a table, and what a waiter picks out from
 * across the room when they are collecting the cards. A table called "Teras"
 * has no number, so the whole name becomes the big glyph and shrinks to fit -
 * a name is never truncated on a card that will be on the table for years.
 */
function split(name) {
  const s = String(name || '').trim();
  const m = s.match(/^(.*?)[\s-]*(\d{1,4})\s*$/);
  if (m && m[2]) return { label: (m[1] || 'MASA').trim().toUpperCase(), big: m[2] };
  return { label: '', big: s || '-' };
}

/**
 * Every table's card, ready to draw.
 *
 * The address comes from floor.qrCards and is not recomputed: a card printed
 * here and a card printed from the floor plan must open the same page, and two
 * copies of that rule is two answers by next year.
 *
 * The local fallback exists because a venue whose digital menu has no slug yet
 * would otherwise get a stack of blank squares. It is honest about what it is:
 * the address only resolves on the restaurant's own network, and the caller is
 * told so in `warnings` rather than finding out from a guest on 4G.
 */
async function cardData(clientId, { tableId = null } = {}) {
  const base = await floor.qrCards(clientId, { size: 1 });
  const set = await db.one('SELECT business_name, card_design FROM qr_menu_settings WHERE client_id=?',
    [clientId]).catch(() => null);

  let localBase = null;
  if (!base.slug) {
    const ips = lan.localIps();
    localBase = `http://${ips[0] || '127.0.0.1'}:${config.port}`;
  }

  const cards = base.cards
    .filter(c => (tableId ? Number(c.id) === Number(tableId) : true))
    .map(({ svg, ...c }) => {                       // eslint-disable-line no-unused-vars
      /* floor.qrCards renders a little SVG per table for ITS screen; this one
         draws the symbol into the PDF itself, so the SVG is dropped rather
         than shipped - forty unused sprites is a screen that loads slowly for
         no reason at all. */
      const url = c.url || (c.qr_token && localBase ? `${localBase}/menu.html?m=${c.qr_token}` : null);
      return { ...c, url, ...split(c.name) };
    });

  if (tableId && !cards.length) throw bad('Masa bulunamadı', 404);

  const warnings = base.warnings.slice();
  if (localBase) {
    warnings.push({
      code: 'local_only',
      text: 'Dijital menü adresi (slug) yok; kartlara bu bilgisayarın yerel adresi basılıyor. '
        + 'Bu adres yalnızca restoranın kendi ağından açılır.',
    });
  }

  return {
    brand: (set && set.business_name) || base.brand,
    design: guest.cardKey(set && set.card_design),
    designs: guest.CARD_DESIGNS,
    socials: await socials(),
    missing: cards.filter(c => !c.url).length,
    warnings,
    cards,
  };
}

/* ---------------------------------------------------------- the drawing */

/** Shrink a string until it fits `w`. Never truncates - a name is a name. */
function fitFont(doc, text, w, start, min = 8) {
  let size = start;
  while (size > min && doc.fontSize(size).widthOfString(ascii(text)) > w) size -= 1;
  return size;
}

function centred(doc, text, y, size, color, font = 'Helvetica') {
  doc.font(font).fontSize(size).fillColor(color)
    .text(ascii(text), 0, y, { width: A5.w, align: 'center', lineBreak: false });
}

/**
 * The social strip along the _foot of the card, drawn once for all three
 * designs. Glyph then handle, centred as a group - a row of marks that is
 * centred by its text alone drifts left as the handles get longer.
 */
function drawSocials(doc, list, y, color, labelColor) {
  if (!list.length) return y;
  const glyph = 11;
  const gapMark = 4;
  const gapItem = 16;
  doc.font('Helvetica').fontSize(9.5);
  const widths = list.map(s => glyph + gapMark + doc.widthOfString(ascii(s.shown)));
  const total = widths.reduce((a, b) => a + b, 0) + gapItem * (list.length - 1);
  let x = (A5.w - total) / 2;
  for (let i = 0; i < list.length; i++) {
    drawMark(doc, list[i].key, x, y, glyph, color);
    doc.font('Helvetica').fontSize(9.5).fillColor(labelColor)
      .text(ascii(list[i].shown), x + glyph + gapMark, y + 1.5, { lineBreak: false });
    x += widths[i] + gapItem;
  }
  return y + glyph + 6;
}

/* Each design is a function of (doc, card, ctx). They share the QR, the
   handles and the fold; what differs is furniture, and that is the whole
   point of offering three rather than one. */
const DESIGNS = {

  /**
   * KLASIK - an orange band across the head with the venue's name in it, the
   * table number under it as large as the page allows, then the code. The
   * loudest of the three across a room, and the default.
   */
  klasik(doc, card, ctx) {
    const band = 24 * MM;
    doc.rect(0, 0, A5.w, band).fill(ORANGE);
    const bs = fitFont(doc, ctx.brand, A5.w - 24 * MM, 20, 11);
    doc.font('Helvetica-Bold').fontSize(bs).fillColor('#FFFFFF')
      .text(ascii(ctx.brand), 12 * MM, band / 2 - bs * 0.62, { width: A5.w - 24 * MM, align: 'center', lineBreak: false });

    let y = band + 12 * MM;
    if (card.label) { centred(doc, card.label, y, 11, ORANGE_DARK, 'Helvetica-Bold'); y += 16; }
    const big = fitFont(doc, card.big, A5.w - 30 * MM, 72, 20);
    centred(doc, card.big, y, big, INK, 'Helvetica-Bold');
    y += big * 1.02 + 7 * MM;

    /* 76mm of symbol. The card is read sitting down with the phone about 40cm
       away; this is the largest square the page can give it once the number
       above it is still the thing seen from the next table. */
    const box = 76 * MM;
    const x = (A5.w - box) / 2;
    doc.roundedRect(x - 3 * MM, y - 3 * MM, box + 6 * MM, box + 6 * MM, 4).lineWidth(0.8).strokeColor(LINE).stroke();
    drawQr(doc, card.url, x, y, box);
    y += box + 6 * MM;

    centred(doc, 'Menu icin karekodu okutun', y, 12, INK_2, 'Helvetica-Bold');
    y += 18;
    if (card.zone_name) { centred(doc, card.zone_name, y, 9.5, INK_3); y += 14; }

    let _foot = A5.h - 26 * MM;
    _foot = drawSocials(doc, ctx.socials, _foot, ORANGE, INK_2);
    doc.moveTo(24 * MM, A5.h - 13 * MM).lineTo(A5.w - 24 * MM, A5.h - 13 * MM)
      .lineWidth(0.5).strokeColor(LINE).stroke();
    centred(doc, 'NOKTApp', A5.h - 10 * MM, 8, INK_3);
  },

  /**
   * CERCEVE - a hairline frame and nothing else. For a venue whose tables are
   * already busy: white card, thin rule, the number and the code. The quietest
   * of the three and the one that photographs best next to a table setting.
   */
  cerceve(doc, card, ctx) {
    const m = 9 * MM;
    doc.rect(m, m, A5.w - m * 2, A5.h - m * 2).lineWidth(0.8).strokeColor(INK).stroke();
    doc.rect(m + 2.2 * MM, m + 2.2 * MM, A5.w - (m + 2.2 * MM) * 2, A5.h - (m + 2.2 * MM) * 2)
      .lineWidth(0.4).strokeColor(LINE).stroke();

    let y = m + 11 * MM;
    const bs = fitFont(doc, ctx.brand, A5.w - 34 * MM, 15, 9);
    doc.font('Helvetica').fontSize(bs).fillColor(INK)
      .text(ascii(String(ctx.brand).toUpperCase()), 17 * MM, y,
        { width: A5.w - 34 * MM, align: 'center', characterSpacing: 2.2, lineBreak: false });
    y += bs + 4 * MM;
    doc.moveTo(A5.w / 2 - 12 * MM, y).lineTo(A5.w / 2 + 12 * MM, y).lineWidth(1).strokeColor(ORANGE).stroke();
    y += 6 * MM;

    if (card.label) { centred(doc, card.label, y, 9.5, INK_3, 'Helvetica'); y += 13; }
    const big = fitFont(doc, card.big, A5.w - 40 * MM, 64, 18);
    centred(doc, card.big, y, big, INK, 'Helvetica-Bold');
    y += big * 1.02 + 6 * MM;

    const box = 74 * MM;
    drawQr(doc, card.url, (A5.w - box) / 2, y, box);
    y += box + 5 * MM;
    centred(doc, 'Menu icin karekodu okutun', y, 11, INK_2, 'Helvetica-Bold');
    y += 15;
    if (card.zone_name) centred(doc, card.zone_name, y, 9, INK_3);

    drawSocials(doc, ctx.socials, A5.h - 27 * MM, INK, INK_2);
    centred(doc, 'NOKTApp', A5.h - 15 * MM, 7.5, INK_3);
  },

  /**
   * SERIT - a vertical orange stripe down the left edge carrying the table
   * number, and the code in the space that leaves. Reads from the side, which
   * is how a card on a table between two diners is usually seen.
   */
  serit(doc, card, ctx) {
    /*
     * The number is UPRIGHT in the stripe, not rotated along it. A spine of
     * sideways type looks well on a shelf of books; on a table it means the
     * one thing a waiter is trying to read across the room - which table this
     * is - has to be read with a tilted head.
     */
    const stripe = 36 * MM;
    doc.rect(0, 0, stripe, A5.h).fill(ORANGE);

    let sy = 22 * MM;
    if (card.label) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF')
        .text(ascii(card.label), 0, sy, { width: stripe, align: 'center', characterSpacing: 1.6, lineBreak: false });
      sy += 15;
    }
    const big = fitFont(doc, card.big, stripe - 8 * MM, 60, 14);
    doc.font('Helvetica-Bold').fontSize(big).fillColor('#FFFFFF')
      .text(ascii(card.big), 0, sy, { width: stripe, align: 'center', lineBreak: false });

    const cw = A5.w - stripe;
    let y = 20 * MM;
    const bs = fitFont(doc, ctx.brand, cw - 14 * MM, 17, 10);
    doc.font('Helvetica-Bold').fontSize(bs).fillColor(INK)
      .text(ascii(ctx.brand), stripe + 7 * MM, y, { width: cw - 14 * MM, align: 'center', lineBreak: false });
    y += bs + 4 * MM;
    if (card.zone_name) {
      doc.font('Helvetica').fontSize(9.5).fillColor(INK_3)
        .text(ascii(card.zone_name), stripe + 7 * MM, y, { width: cw - 14 * MM, align: 'center', lineBreak: false });
    }
    y += 12 * MM;

    const box = Math.min(cw - 14 * MM, 76 * MM);
    drawQr(doc, card.url, stripe + (cw - box) / 2, y, box);
    y += box + 6 * MM;
    doc.font('Helvetica-Bold').fontSize(11.5).fillColor(INK_2)
      .text(ascii('Menu icin karekodu okutun'), stripe + 7 * MM, y,
        { width: cw - 14 * MM, align: 'center', lineBreak: false });

    /* drawSocials centres on the whole page, which on this design would put
       the strip half under the stripe; here they are stacked in the panel. */
    if (ctx.socials.length) {
      let fy = A5.h - 34 * MM;
      for (const s of ctx.socials) {
        drawMark(doc, s.key, stripe + 7 * MM, fy, 10, ORANGE_DARK);
        doc.font('Helvetica').fontSize(9.5).fillColor(INK_2)
          .text(ascii(s.shown), stripe + 7 * MM + 14, fy + 1, { lineBreak: false });
        fy += 14;
      }
    }
    doc.font('Helvetica').fontSize(7.5).fillColor(INK_3)
      .text('NOKTApp', stripe + 7 * MM, A5.h - 11 * MM, { width: cw - 14 * MM, align: 'right', lineBreak: false });
  },
};

/**
 * A page for a table that has no code yet.
 *
 * Printed rather than skipped, on purpose. A stack of forty cards for
 * forty-two tables is a stack somebody deals onto the tables without counting,
 * and two tables end up with no card at all and nobody knows which. A page
 * that says so cannot be missed.
 */
function drawMissing(doc, card, ctx) {
  doc.rect(0, 0, A5.w, 24 * MM).fill(ORANGE);
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#FFFFFF')
    .text(ascii(ctx.brand), 12 * MM, 24 * MM / 2 - 10, { width: A5.w - 24 * MM, align: 'center', lineBreak: false });
  centred(doc, card.name, 60 * MM, 34, INK, 'Helvetica-Bold');
  centred(doc, 'Bu masanin karekodu yok', 92 * MM, 14, ORANGE_DARK, 'Helvetica-Bold');
  doc.font('Helvetica').fontSize(10.5).fillColor(INK_2)
    .text(ascii('Masa duzeni ekranindan "Eksik karekodlari uret" ile uretin, sonra bu karti yeniden basin.'),
      20 * MM, 102 * MM, { width: A5.w - 40 * MM, align: 'center' });
}

/* ---------------------------------------------------------------- api */

/**
 * Every card as one print-ready A5 PDF, one card per page.
 *
 * The page box is set on the document and never changed, so a print shop's
 * imposition software sees 148x210mm on every page and nothing to guess at.
 */
async function cardsPdf(clientId, { tableId = null, design = null } = {}) {
  const data = await cardData(clientId, { tableId });
  if (!data.cards.length) throw bad('Basılacak masa yok', 404);
  const key = design ? guest.cardKey(design, { strict: true }) : data.design;
  const draw = DESIGNS[key] || DESIGNS.klasik;
  const ctx = { brand: data.brand, socials: data.socials };

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [A5.w, A5.h], margin: 0, autoFirstPage: false });
    doc.info.Title = ascii(`${data.brand} - masa karekod kartlari`);
    doc.info.Author = ascii(data.brand);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      for (const card of data.cards) {
        doc.addPage({ size: [A5.w, A5.h], margin: 0 });
        if (card.url) draw(doc, card, ctx); else drawMissing(doc, card, ctx);
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

/** The filename the browser saves it under. Turkish folded - see ascii(). */
function pdfName(brand, one) {
  const stem = ascii(brand || 'masa').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'masa';
  return `${stem}-masa-kart${one ? '-' + ascii(one).toLowerCase().replace(/[^a-z0-9]+/g, '') : 'lari'}.pdf`;
}

module.exports = {
  cardData, cardsPdf, pdfName, DESIGNS, A5, MM, QUIET, matrix, split,
  /* drawQr is exported for the suite, which checks the quiet zone by handing
     it a recording stub instead of a document: the four modules of white are
     the difference between a card that scans and a card that is reprinted. */
  drawQr,
};
