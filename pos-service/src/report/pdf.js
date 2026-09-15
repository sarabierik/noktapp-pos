'use strict';
/**
 * One report PDF builder, for every report.
 *
 * The CSV is for the accountant's spreadsheet; this is for the accountant's
 * file. A file copy has to stand up on its own months later, in front of
 * somebody who was not in the restaurant and cannot ring anybody, so every
 * report PDF carries the same five things whatever it is a report of:
 *
 *   1. who the taxpayer is - unvan, VKN/TCKN, vergi dairesi, adres;
 *   2. what the report is and EXACTLY which days it covers, including the hour
 *      the business day rolls over, because a restaurant's Tuesday ends at
 *      06:00 on Wednesday and a report that does not say so is a report whose
 *      figures cannot be checked against anything;
 *   3. the KDV split PER RATE - matrah, KDV, brut - which adds up to the
 *      report's own total and is computed by util/vat, never here;
 *   4. what is NOT in the figures, said in words;
 *   5. when it was produced, by whom, and "Sayfa 1 / 3" so a missing page is
 *      visible.
 *
 * There is deliberately ONE builder. A layout per report is a guarantee that
 * six months from now two of them carry a different VKN block, or one of them
 * quietly stops printing the exclusion note.
 *
 * ---------------------------------------------------------------------------
 * PDFKit, the two things that have already bitten this codebase (see mail.js):
 *
 *   - `continued: true` does NOT make columns. PDFKit treats a continued
 *     fragment as more text in the same paragraph and `width` reflows it, so a
 *     row comes out as one wrapped blob. Every cell here is drawn at an
 *     absolute x with `lineBreak: false`, and y is advanced by hand.
 *   - the built-in fonts are WinAnsi. Helvetica has ç ö ü Ç Ö Ü but no ğ ş ı
 *     İ Ğ Ş at all, and asking for one writes its raw UTF-8 bytes onto the
 *     page as mojibake - the same trap that put `"H` on a bill where a `≈`
 *     was meant. Shipping a Unicode TTF would mean shipping a font with the
 *     installer, so instead every string on the page goes through `ascii()`.
 *     The text stays Turkish; it just loses its dots, exactly as the printed
 *     hesap fisi has always done.
 */
const PDFDocument = require('pdfkit');
const db = require('../db');
const sheet = require('./sheet');
const { money } = require('../util/http');

const { MONEY, INT, PCT, TXT, DATE, DT } = sheet;

/* --------------------------------------------------------------- text */
const FOLD = {
  ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O',
  ş: 's', Ş: 'S', ü: 'u', Ü: 'U', â: 'a', Â: 'A', î: 'i', û: 'u',
  '₺': 'TL', '≈': '~', '–': '-', '—': '-', '’': "'", '“': '"', '”': '"', '…': '...',
};
/** Every string that reaches the page. See the font note at the top. */
function ascii(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[^\x20-\x7E]/g, c => FOLD[c] || '');
}

/* ----------------------------------------------------------- identity */
/**
 * Who the taxpayer is, from the two places the app already keeps it.
 *
 * `business_settings` is the local block the Ayarlar screen writes;
 * `clients` is what the licence carries. business_settings wins where it has
 * an answer, and clients fills the gaps - the same precedence
 * print/document.js uses for the receipt, so the PDF and the fis can never
 * name two different companies.
 *
 * Unvan is the LEGAL name (legal_name) where one has been entered, not the
 * trading name over the door: "Yildiz Gida Turizm Ltd. Sti." is what belongs
 * on a document that goes to the vergi dairesi, and "Yildiz Restaurant" is
 * what belongs on the sign.
 */
async function identity(clientId) {
  const c = await db.one(
    `SELECT company_name, full_address, phone, tax_number, tax_office FROM clients WHERE id=?`,
    [clientId]).catch(() => null);
  const b = await db.one('SELECT * FROM business_settings WHERE client_id=? LIMIT 1', [clientId]).catch(() => null);
  const trade = (b && b.business_name) || (c && c.company_name) || '';
  const legal = (b && b.legal_name) || '';
  const address = [(b && b.address_line1) || (c && c.full_address) || '', (b && b.city) || '']
    .filter(Boolean).join(' ');
  return {
    unvan: legal || trade || 'NOKTApp',
    trade: trade && legal && trade !== legal ? trade : '',
    vkn: (b && b.tax_number) || (c && c.tax_number) || '',
    vd: (b && b.tax_office) || (c && c.tax_office) || '',
    address,
    phone: (b && b.phone) || (c && c.phone) || '',
    dayStart: String(await db.getSetting('business_day_start', '06:00')),
  };
}

/* ------------------------------------------------------------ drawing */
const ORANGE = '#FF7A1A';
const MARGIN = 36;

/**
 * Column widths that fit the paper.
 *
 * A weight per type rather than a measurement per row: a name column needs the
 * room, a count column does not, and a table whose widths shift with whichever
 * product happened to have the longest name is a table that looks different in
 * every month's file copy.
 */
const WEIGHT = { [TXT]: 2.4, [DT]: 2.1, [DATE]: 1.2, [MONEY]: 1.25, [PCT]: 0.85, [INT]: 0.8 };

function layoutCols(cols, width) {
  const w = cols.map(c => WEIGHT[c.t] || 1);
  const total = w.reduce((s, x) => s + x, 0);
  let x = MARGIN;
  return cols.map((c, i) => {
    const cw = Math.max(30, Math.floor(width * w[i] / total));
    const col = { ...c, x, w: cw - 4, align: sheet.isNumeric(c.t) ? 'right' : 'left' };
    x += cw;
    return col;
  });
}

class Sheetish {
  constructor(doc, size) {
    this.doc = doc;
    this.size = size;                 // { w, h } of the page box in points
    this.right = size.w - MARGIN;
    this.bottom = size.h - 54;        // the footer band is not ours to draw in
    this.y = MARGIN;
  }
  room(n) { return this.y + n <= this.bottom; }
  page() { this.doc.addPage(); this.y = MARGIN; }
  need(n) { if (!this.room(n)) this.page(); }

  rule(color = '#ddd', width = 0.5, from = MARGIN, to = null) {
    this.doc.moveTo(from, this.y).lineTo(to === null ? this.right : to, this.y)
      .strokeColor(color).lineWidth(width).stroke();
  }
  text(s, x, opts = {}) {
    this.doc.fontSize(opts.size || 9).fillColor(opts.color || '#111')
      .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
      .text(ascii(s), x, this.y, { width: opts.w || 300, align: opts.align || 'left', lineBreak: false });
  }
  /** A whole row of cells at absolute x. Never `continued`. */
  row(cols, get, opts = {}) {
    for (const c of cols) {
      this.doc.fontSize(opts.size || 7.5).fillColor(opts.color || '#111')
        .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica');
      let s = ascii(get(c));
      // truncate rather than wrap: a long product name must never push the
      // money column sideways and leave two rows that do not line up
      const max = c.w;
      while (s && this.doc.widthOfString(s) > max) s = s.slice(0, -2) + '.';
      this.doc.text(s, c.x, this.y, { width: c.w, align: c.align, lineBreak: false });
    }
  }
}

/* ------------------------------------------------------------ sections */

function drawTable(P, s, title) {
  const cols = layoutCols(s.cols, P.right - MARGIN);
  const headerHeight = 26;

  const header = () => {
    P.doc.fontSize(10).fillColor('#111').font('Helvetica-Bold')
      .text(ascii(title || s.name), MARGIN, P.y, { lineBreak: false });
    P.y += 15;
    P.rule(ORANGE, 1.2);
    P.y += 5;
    P.row(cols, c => c.tr, { bold: true, color: '#555' });
    P.y += 11;
    P.rule();
    P.y += 4;
  };

  // a table that starts three lines from the bottom of the page leaves one
  // orphan row under its header and carries the rest overleaf
  P.need(headerHeight + 14 + Math.min(3, Math.max(1, s.rows.length)) * 11);
  header();

  for (const r of s.rows) {
    if (!P.room(24)) { P.page(); header(); }
    P.row(cols, c => sheet.pdfCell(r[c.k], c.t));
    P.y += 11;
  }
  if (!s.rows.length) {
    P.text('Bu aralikta kayit yok.', MARGIN, { size: 8, color: '#888' });
    P.y += 12;
  }

  /*
   * The total row, always, and drawn as the last word on the table: a rule
   * above it, bold, in the accent colour. "An accountant must not have to add
   * a column up themselves" is the whole point of the exercise, and a figure
   * they add up by hand is a figure that can disagree with ours.
   */
  /* `noTotal` is for a table whose column does not add up to anything: the
     Özet sheet is a list of unlike figures - ciro, KDV, maliyet, kâr - and a
     footer under it would be a number with no meaning at all. */
  if (s.rows.length && !s.noTotal && s.cols.some(c => c.t === MONEY || c.t === INT)) {
    if (!P.room(28)) { P.page(); header(); }
    P.y += 2;
    P.rule('#999', 0.8);
    P.y += 4;
    // the word goes in the first column that has no figure of its own, so it
    // never lands on top of a number
    const labelCol = cols.find(c => sheet.columnTotal(s.rows, c) === null) || cols[0];
    P.row(cols, (c) => {
      if (c === labelCol) return 'TOPLAM';
      const t = sheet.columnTotal(s.rows, c);
      return t === null ? '' : sheet.pdfCell(t, c.t);
    }, { bold: true, color: ORANGE });
    P.y += 14;
  }
  P.y += 12;
}

/** A two-column key/value block - the summary panels, not a data table. */
function drawFacts(P, title, rows) {
  if (!rows.length) return;
  P.need(30 + rows.length * 12);
  P.doc.fontSize(10).fillColor('#111').font('Helvetica-Bold')
    .text(ascii(title), MARGIN, P.y, { lineBreak: false });
  P.y += 15;
  P.rule(ORANGE, 1.2);
  P.y += 6;
  const vx = Math.min(MARGIN + 300, P.right - 120);
  for (const [k, v, big] of rows) {
    if (!P.room(20)) P.page();
    P.doc.fontSize(big ? 10 : 8.5).font(big ? 'Helvetica-Bold' : 'Helvetica').fillColor(big ? '#111' : '#555')
      .text(ascii(k), MARGIN, P.y, { width: 260, lineBreak: false });
    P.doc.fillColor(big ? ORANGE : '#111').font('Helvetica-Bold')
      .text(ascii(v), vx, P.y, { width: P.right - vx, align: 'right', lineBreak: false });
    P.y += big ? 15 : 12;
  }
  P.y += 12;
}

/**
 * The KDV block: matrah, KDV and brut per rate, with the total underneath.
 *
 * `pack.vat` comes from util/vat, which works the tax out bill by bill in
 * kurus. Nothing is recomputed here - if this file did its own division the
 * page could show a breakdown that does not add up to the total printed a
 * centimetre above it, which is precisely the failure the shared engine
 * exists to prevent.
 */
function drawVat(P, vat, reportTotal) {
  const rows = (vat || []).map(v => ({
    oran: '%' + v.rate, matrah: v.base, kdv: v.vat, brut: v.gross,
  }));
  const s = {
    name: 'KDV dokumu (KDV dahil fiyatlardan)',
    cols: [
      { k: 'oran', tr: 'KDV Orani', t: TXT },
      { k: 'matrah', tr: 'Matrah (KDV haric)', t: MONEY },
      { k: 'kdv', tr: 'KDV', t: MONEY },
      { k: 'brut', tr: 'Brut (KDV dahil)', t: MONEY },
    ],
    rows,
  };
  drawTable(P, s);

  const gross = money(rows.reduce((a, r) => a + r.brut, 0));
  if (reportTotal !== null && reportTotal !== undefined && Math.abs(gross - money(reportTotal)) > 0.005) {
    /*
     * Printed, not swallowed. A breakdown that does not reconcile with the
     * report total means a bill's stored header has drifted from its lines,
     * and an accountant who is told about it can ask; an accountant handed a
     * silent 3,40 TL hole cannot.
     */
    P.text(`Uyari: KDV dokumu brut toplami (${sheet.tlText(gross)} TL) rapor toplamindan `
      + `${sheet.tlText(Math.abs(gross - money(reportTotal)))} TL farkli.`, MARGIN,
    { size: 8, color: '#B00', w: P.right - MARGIN });
    P.y += 16;
  }
}

/* --------------------------------------------------------------- page */

function drawLegalHeader(P, id, pack) {
  const D = P.doc;
  D.fontSize(15).fillColor(ORANGE).font('Helvetica-Bold')
    .text(ascii(id.unvan), MARGIN, P.y, { width: P.right - MARGIN - 170, lineBreak: false });
  P.y += 19;

  D.fontSize(8.5).fillColor('#444').font('Helvetica');
  const lines = [];
  if (id.trade) lines.push('Isletme adi: ' + id.trade);
  if (id.vd || id.vkn) lines.push(`${id.vd ? 'Vergi dairesi: ' + id.vd : ''}`
    + `${id.vd && id.vkn ? '   |   ' : ''}${id.vkn ? 'VKN/TCKN: ' + id.vkn : ''}`);
  if (id.address) lines.push('Adres: ' + id.address);
  if (id.phone) lines.push('Tel: ' + id.phone);
  for (const l of lines) {
    D.text(ascii(l), MARGIN, P.y, { width: P.right - MARGIN - 170, lineBreak: false });
    P.y += 11;
  }
  P.y += 6;
  P.rule('#111', 1);
  P.y += 10;

  D.fontSize(14).fillColor('#111').font('Helvetica-Bold')
    .text(ascii(pack.title), MARGIN, P.y, { lineBreak: false });
  P.y += 18;

  D.fontSize(9).fillColor('#111').font('Helvetica')
    .text(ascii(pack.periodText), MARGIN, P.y, { width: P.right - MARGIN, lineBreak: false });
  P.y += 12;
  D.fontSize(8).fillColor('#666')
    .text(ascii(pack.dayNote), MARGIN, P.y, { width: P.right - MARGIN, lineBreak: false });
  P.y += 11;
  D.text(ascii(pack.producedText), MARGIN, P.y, { width: P.right - MARGIN, lineBreak: false });
  P.y += 16;
}

/**
 * What is not in the figures, in words.
 *
 * Every report in this system counts bills that are on the books and nothing
 * else, and an accountant reading a total has to be told that rather than
 * having to infer it from a number that looks low.
 */
const EXCLUSION = 'Kapsam: Iptal edilen ve rapor disi birakilan adisyonlar bu raporda '
  + 'hicbir rakama dahil DEGILDIR - ne ciroya, ne KDV dokumune, ne odeme dagilimina. '
  + 'Silinen adisyonlarin kaydi ve sebebi sistemde durur ve ayrica raporlanabilir.';

function drawNotes(P, notes) {
  P.need(50);
  P.rule('#ddd');
  P.y += 8;
  P.doc.fontSize(8).fillColor('#555').font('Helvetica');
  for (const n of [EXCLUSION, ...(notes || [])]) {
    const h = P.doc.heightOfString(ascii(n), { width: P.right - MARGIN });
    if (!P.room(h + 6)) P.page();
    P.doc.fontSize(8).fillColor('#555').font('Helvetica')
      .text(ascii(n), MARGIN, P.y, { width: P.right - MARGIN });
    P.y += h + 5;
  }
}

/**
 * The footer band, stamped after the fact.
 *
 * Page numbers cannot be written while the pages are being filled - page 1 does
 * not know there will be three. So the document is built with `bufferPages`,
 * and only once the content is finished is every page revisited and given its
 * "Sayfa 1 / 3". Without the count an accountant cannot tell a two-page report
 * from a three-page report with a page missing.
 */
function stampFooters(doc, id, pack, size) {
  const range = doc.bufferedPageRange();
  const n = range.count;
  for (let i = 0; i < n; i++) {
    doc.switchToPage(range.start + i);
    const y = size.h - 40;
    doc.moveTo(MARGIN, y - 8).lineTo(size.w - MARGIN, y - 8).strokeColor('#ddd').lineWidth(0.5).stroke();
    doc.fontSize(7.5).fillColor('#888').font('Helvetica');
    const left = [id.unvan, id.vkn ? 'VKN/TCKN ' + id.vkn : '', pack.title, pack.periodShort]
      .filter(Boolean).join('  |  ');
    doc.text(ascii(left), MARGIN, y, { width: size.w - MARGIN * 2 - 90, lineBreak: false });
    doc.text(ascii(`Sayfa ${i + 1} / ${n}`), size.w - MARGIN - 90, y,
      { width: 90, align: 'right', lineBreak: false });
  }
}

/* ---------------------------------------------------------------- api */

/**
 * Render one report.
 *
 * `pack` is what modules/finance and modules/reports already build for the CSV
 * - the SAME sheets - plus the accountant's furniture:
 *
 *   { title, range:{from,to}, sheets:[{name,cols,rows}], facts:[[k,v,big]],
 *     vat:[{rate,base,vat,gross}], payments:[{label,count,total}],
 *     total:number|null, notes:[string], producedBy:string }
 *
 * Feeding the PDF from the same sheets as the CSV is not a shortcut: it is the
 * only way the two files an accountant is sent on the same day cannot show
 * different rows.
 */
async function reportPdf(clientId, pack) {
  const id = await identity(clientId);
  const widest = Math.max(3, ...(pack.sheets || []).map(s => s.cols.length));
  // a nine-column table on portrait A4 leaves 50pt a column and money that
  // collides with its neighbour; past six columns the paper turns sideways
  const landscape = widest > 6;
  const size = landscape ? { w: 842, h: 595 } : { w: 595, h: 842 };

  const from = sheet.dmy(pack.range && pack.range.from);
  const to = sheet.dmy(pack.range && pack.range.to);
  const periodShort = from === to ? from : `${from} - ${to}`;
  const meta = {
    ...pack,
    periodShort,
    periodText: from === to ? `Donem: ${from} (tek gun)` : `Donem: ${from} - ${to} (her iki tarih dahil)`,
    dayNote: `Is gunu ${id.dayStart}'da baslar: bu saatten once kesilen adisyon bir onceki is gunune yazilir.`,
    producedText: `Duzenleme: ${sheet.dmyTime(new Date())}  |  Duzenleyen: ${pack.producedBy || '-'}`
      + `  |  Para birimi: TL`,
  };

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [size.w, size.h], margin: MARGIN, bufferPages: true });
    doc.info.Title = ascii(`${pack.title} ${periodShort}`);
    doc.info.Author = ascii(id.unvan);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    try {
      const P = new Sheetish(doc, size);
      drawLegalHeader(P, id, meta);
      if (pack.facts && pack.facts.length) drawFacts(P, 'Ozet', pack.facts);
      drawVat(P, pack.vat, pack.total);
      if (pack.payments && pack.payments.length) {
        drawTable(P, {
          name: 'Odeme dagilimi',
          cols: [
            { k: 'label', tr: 'Yontem', t: TXT },
            { k: 'count', tr: 'Islem', t: INT },
            { k: 'total', tr: 'Tutar', t: MONEY },
          ],
          rows: pack.payments,
        });
      }
      for (const s of pack.sheets || []) drawTable(P, s);
      drawNotes(P, pack.notes);
      stampFooters(doc, id, meta, size);
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { reportPdf, identity, ascii, EXCLUSION };
