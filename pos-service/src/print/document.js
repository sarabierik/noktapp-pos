'use strict';
/**
 * The bill document.
 *
 * There used to be three of these: the thermal printer built its own totals,
 * the PDF built its own, and the mail body built a third. They drifted, and a
 * customer was e-mailed a bill reading "Ara Toplam 850,00 / GENEL TOPLAM
 * 650,00" - two numbers that cannot both be true. The old PHP system had the
 * same disease in five places (recalcTotals, recalc_order_total x2,
 * loy_recalc_order, api_recalc_order) and its own comments admit they disagree.
 *
 * So: the arithmetic happens exactly once, here, and the printer, the PDF and
 * the e-mail are renderers over the result. Where the lines and the stored
 * header disagree, the lines win and the header is repaired on the way past.
 *
 * KDV is INCLUSIVE, as Turkish retail prices always are:
 *
 *     vat = gross * rate / (100 + rate)
 *
 * So "Ara Toplam" already contains the KDV, "Genel Toplam" = Ara Toplam -
 * Indirim, and the KDV lines are informational - adding them would double
 * count. This matches pos/core/fiscal/OrderTotals.php, which is the one engine
 * in the old system that got it right.
 */
const zlib = require('zlib');
const db = require('../db');
const { money } = require('../util/http');
const kdv = require('../util/vat');

/** Turkish money: 1.234,56 */
function tl(n) {
  const v = money(n);
  const [a, b] = Math.abs(v).toFixed(2).split('.');
  const grouped = a.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (v < 0 ? '-' : '') + grouped + ',' + b;
}

/** Quantity: 1, 2, 0,5 - never "0.50" and never "1.0". */
function qtyText(q) {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}

/*
 * The keys are the values modules/payments.METHODS actually writes. They are
 * Turkish, and an English map here would have printed the raw column value
 * ("kredi_karti") on the guest's bill.
 */
const METHOD_LABEL = {
  nakit: 'Nakit', kredi_karti: 'Kredi Karti', yemek_karti: 'Yemek Karti',
  havale: 'Havale/EFT', ikram: 'Ikram', acik_hesap: 'Acik Hesap',
};
function methodLabel(m) { return METHOD_LABEL[m] || String(m || '').replace(/_/g, ' '); }

/**
 * Group the KDV by rate, the way a Turkish bill has to show it.
 *
 * A 10% kebab and a 20% beer on one adisyon is normal, not exceptional, so
 * this is a breakdown and never a single number. The base (matrah) is the
 * VAT-exclusive part, because that is what the rate applies to.
 */
function vatBreakdown(lines, billDiscount = 0) {
  /*
   * The bill discount is real money off the sale, so it takes its share of the
   * tax with it. Working the KDV out on the undiscounted lines printed a
   * matrah + KDV that added up to the Ara Toplam and not to the TOPLAM the
   * guest was actually paying - the bill visibly did not add up, and the
   * over-declared tax was the restaurant's to hand over.
   */
  return kdv.billVat(lines, billDiscount).breakdown
    .filter(v => v.rate > 0);            // a %0 line has no KDV row to print
}

/* ==================================================================== *
 * DÖVİZ - the foreign-currency courtesy line                           *
 * ==================================================================== */

/**
 * The rate, written the way it was entered.
 *
 * doviz_kurlari.rate is decimal(12,4), so 42.15 comes back as "42.1500". A
 * guest checking the bill against the board in the window is comparing against
 * what the owner typed, not against four decimal places of padding, so the
 * zeros are trimmed - but a rate that genuinely has four decimals still prints
 * all four rather than being rounded into disagreement with the arithmetic
 * below it.
 */
function rateText(rate) {
  const s = Number(rate).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  const [a, b] = s.split('.');
  const grouped = a.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return b ? grouped + ',' + b : grouped;
}

/** dd.mm.yyyy - the date a rate was last touched, for a rate that is old. */
function dayText(d) {
  const t = new Date(d);
  const p = n => String(n).padStart(2, '0');
  return `${p(t.getDate())}.${p(t.getMonth() + 1)}.${t.getFullYear()}`;
}

/*
 * Said once, on every renderer, in the guest's own interest.
 *
 * Alanya is a tourist town: the guest pays in TL and wants to know roughly what
 * that is in euros. "Roughly" is the whole point - the line is a courtesy, the
 * till never charges it, no payment is ever recorded in it, and the TL figure
 * above it is the one that is owed. A receipt that shows two totals without
 * saying which one counts is a receipt that will be argued over.
 */
const FX_NOTE = 'Bilgi icindir. Odeme TL olarak alinir.';

/*
 * "≈" only exists where a real Unicode font does, and two of the three
 * renderers have no such thing:
 *
 *   - the thermal printer speaks code page 857, which has no approximation
 *     sign at all, so escpos.encode() would put a "?" in front of the euros;
 *   - the PDF is drawn in PDFKit's built-in Helvetica, which is WinAnsi. Ask
 *     it for "≈" and it writes the two bytes of U+2248 straight out, which
 *     renders on the page as the mojibake `"H`.
 *
 * Both were tried. So the paper renderers get an ASCII tilde - which every
 * guest already reads as "about" - and only the HTML mail body, where the
 * character genuinely exists, gets the real sign.
 */
const APPROX = { text: '~', html: '&asymp;' };

/**
 * The grand total in the currencies the owner chose to show.
 *
 * The rates come from doviz_kurlari - the table the Döviz screen already writes
 * with a confirmation on a big jump and a row in doviz_kur_gecmisi for every
 * change. There is deliberately no second rate store here: a bill printed from
 * one set of numbers while the Döviz screen shows another is exactly the kind
 * of disagreement the top of this file exists to prevent.
 *
 * `rate` is "how many TL one unit is worth", which is what the column comment
 * says and what the Döviz screen asks for, so the conversion is a division.
 *
 * A rate that was never entered (rate_updated_at NULL, or rate 0) is not a
 * rate and prints nothing at all. A rate older than the configured age still
 * prints, but carries the date it was set: the honest failure here is a guest
 * reading "92,50 EUR" off a rate from last week and believing it is today's,
 * so the number never appears without a way to judge its age.
 */
async function foreignAmounts(clientId, grand, o) {
  if (!o || !o.fx || !clientId || money(grand) <= 0) return [];
  const rows = await db.query(
    `SELECT code, name, symbol, rate, rate_updated_at
       FROM doviz_kurlari
      WHERE client_id=? AND is_active=1 AND rate>0 AND rate_updated_at IS NOT NULL
      ORDER BY sort_order, code`, [clientId]).catch(() => []);

  const now = Date.now();
  const maxAge = Number(o.fxMaxAgeHours) > 0 ? Number(o.fxMaxAgeHours) : 24;
  const out = [];
  for (const r of rows) {
    // an empty list means "every currency that has a rate", which is what the
    // old receipt_show_fx switch has promised in its help text all along
    if (o.fxCodes.length && !o.fxCodes.includes(r.code)) continue;
    const rate = Number(r.rate);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const ageHours = (now - new Date(r.rate_updated_at).getTime()) / 3600000;
    const stale = ageHours > maxAge;
    const amount = money(money(grand) / rate);
    out.push({
      code: r.code,
      name: r.name,
      symbol: r.symbol || '',
      rate,
      amount,
      /* No approximation sign baked in: the renderers prefix their own from
         APPROX above, because two of the three cannot draw the real one. */
      amountText: `${tl(amount)} ${r.code}`,
      rateText: `1 ${r.code} = ${rateText(rate)} TL`,
      updatedAt: r.rate_updated_at,
      dateText: dayText(r.rate_updated_at),
      ageHours: Math.round(ageHours * 10) / 10,
      stale,
      /*
       * What goes under the amount: the rate, and only the rate.
       *
       * It used to print the date too once the rate was old - "1 EUR = 57 TL
       * (03.09.2026 kuru)". The intention was honesty, but the thing it
       * actually does is print the restaurant's housekeeping on a guest's
       * receipt. The guest cannot act on it, and it reads as an excuse. The
       * line beneath already says what matters to them, and it is true at any
       * age: this figure is for information, the payment is in TL.
       *
       * The staleness is not swallowed - it is moved to where somebody can do
       * something about it. The Fiş ve yazıcı screen warns about every old
       * rate, with the date, and links to where it is fixed.
       */
      sourceText: `1 ${r.code} = ${rateText(rate)} TL`,
    });
  }
  return out;
}

/* ==================================================================== *
 * KAREKOD - what the QR on the bill points at                          *
 * ==================================================================== */

/**
 * Resolve the QR once, here, for all three renderers.
 *
 * The mode is the owner's choice; the address is derived from the data that
 * already exists for that choice, so the digital-menu QR cannot point at a
 * different menu than the table cards do (modules/floor builds those from the
 * same slug and the same panel address).
 *
 * If the chosen mode has nothing to point at - no published slug, no loyalty
 * address entered - this returns null and NOTHING is printed. A QR square that
 * scans to a 404 is worse than no square: the guest blames the restaurant.
 */
async function receiptQr(clientId, o) {
  if (!o || !o.qrMode || o.qrMode === 'kapali') return null;
  let data = null;
  if (o.qrMode === 'serbest') {
    data = o.qrText;
  } else if (o.qrMode === 'sadakat') {
    data = o.qrLoyaltyUrl;
  } else if (o.qrMode === 'menu') {
    const s = await db.one(
      'SELECT slug, is_published FROM qr_menu_settings WHERE client_id=?', [clientId]).catch(() => null);
    if (s && s.slug) {
      const base = (await require('../licence').panelUrl()).replace(/\/+$/, '');
      // the same address routes/qr.js hands the QR-menu screen as base_url
      data = `${base}/qr/?s=${encodeURIComponent(s.slug)}`;
    }
  }
  data = String(data || '').trim();
  if (!data) return null;
  return { mode: o.qrMode, data, caption: (o.qrCaption || '').trim() };
}

/* ------------------------- QR as a picture ------------------------- */
/*
 * The thermal printer draws its own QR (ESC/POS GS ( k); see print/escpos.js).
 * The PDF and the e-mail cannot, so the square is rendered here - once - into a
 * PNG that both of them embed.
 *
 * PNG rather than the SVG qrcode-svg produces, because the e-mail is the reason
 * this exists and Gmail, Outlook and the iOS mail client all refuse to render
 * an <img> whose source is an SVG. A data: URI PNG renders everywhere, and
 * PDFKit embeds the same buffer directly, so there is one picture and not two.
 *
 * It is a 1-bit image in an 8-bit greyscale wrapper: the rows are long runs of
 * one value, so deflate takes a ~27 KB bitmap down to under a kilobyte - small
 * enough to sit inline in a mail body without an attachment.
 */
let CRC = null;
function crc32(buf) {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/* One square is drawn per bill and the same bill is rendered twice (PDF, then
   mail body), so the last one is kept rather than encoded again. */
let lastQr = { key: null, png: null };

/**
 * A QR as a PNG buffer, or null if the content cannot be encoded.
 *
 * Returning null rather than throwing is deliberate: a QR is decoration on a
 * bill, and a string too long for the largest QR version must not be the reason
 * a guest does not get their receipt. The renderers fall back to printing the
 * address as text.
 */
function qrPng(content, { scale = 4, quiet = 4 } = {}) {
  const text = String(content || '');
  if (!text) return null;
  const key = `${text}|${scale}|${quiet}`;
  if (lastQr.key === key) return lastQr.png;
  let png = null;
  try {
    const QRCode = require('qrcode-svg');
    const q = new QRCode({ content: text, padding: 0, width: 128, height: 128, ecl: 'M' });
    const n = q.qrcode.moduleCount;
    const size = (n + quiet * 2) * scale;
    const stride = size + 1;                       // one filter byte per row
    const raw = Buffer.alloc(stride * size, 0xff); // white
    for (let y = 0; y < size; y++) raw[y * stride] = 0; // filter type 0 (none)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!q.qrcode.isDark(r, c)) continue;
        for (let dy = 0; dy < scale; dy++) {
          const at = ((r + quiet) * scale + dy) * stride + 1 + (c + quiet) * scale;
          raw.fill(0x00, at, at + scale);
        }
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 0;   // colour type 0 - greyscale
    png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  } catch (e) {
    require('../logger').warn('receipt', 'karekod cizilemedi: ' + e.message);
    png = null;
  }
  lastQr = { key, png };
  return png;
}

function qrDataUri(content, opts) {
  const png = qrPng(content, opts);
  return png ? 'data:image/png;base64,' + png.toString('base64') : null;
}

/**
 * Build the document for one order.
 *
 * `order` is what modules/orders.getOrder returns. Everything the renderers
 * need is resolved here so none of them touches the database or does sums.
 *
 * `receiptOptions` is the resolved Fiş ayarları. The thermal builder passes its
 * own - it has already resolved them, and the live preview resolves an UNSAVED
 * draft through it - and everyone else lets this function resolve them. Either
 * way the döviz line and the karekod are decided once, here, and not once per
 * renderer.
 */
async function billDocument(clientId, order, { receiptOptions = null } = {}) {
  const c = await db.one(
    `SELECT company_name, receipt_header, receipt_footer, full_address, phone,
            tax_number, tax_office
       FROM clients WHERE id=?`, [clientId]);
  const b = await db.one('SELECT * FROM business_settings WHERE client_id=? LIMIT 1', [clientId]);

  const business = {
    name: (b && b.business_name) || (c && c.company_name) || 'NOKTApp',
    address: (b && b.address_line1) || (c && c.full_address) || '',
    city: (b && b.city) || '',
    phone: (b && b.phone) || (c && c.phone) || '',
    taxNumber: (b && b.tax_number) || (c && c.tax_number) || '',
    taxOffice: (b && b.tax_office) || (c && c.tax_office) || '',
    header: ((c && c.receipt_header) || '').trim(),
    footer: ((c && c.receipt_footer) || 'Bizi tercih ettiginiz icin tesekkur ederiz.').trim(),
  };

  /*
   * Deleted lines are excluded here, exactly as the totals engine excludes
   * them. The old system's printed receipt forgot this filter, so a cancelled
   * line still printed while the printed Ara Toplam did not include it - the
   * lines visibly did not add up to the total, on paper, in front of the guest.
   */
  const lines = (order.items || [])
    .filter(i => !Number(i.is_deleted))
    .map(i => ({
      qty: Number(i.qty),
      name: i.product_name || '',
      note: i.note || '',
      unitPrice: money(i.unit_price),
      lineTotal: money(i.line_total),
      vatRate: Number(i.vat_rate || 0),
      sentQty: Number(i.sent_qty || 0),
    }));

  const subtotal = money(lines.reduce((s, l) => s + l.lineTotal, 0));
  const discount = money(Math.min(Number(order.discount_total || 0), subtotal));
  const grand = money(Math.max(0, subtotal - discount));
  const vat = vatBreakdown(lines, discount);
  // the total is the tax on every line INCLUDING the %0 ones the rows above
  // leave out, so it is taken from the engine rather than from what prints
  const vatTotal = kdv.billVat(lines, discount).vatTotal;

  const payments = (order.payments || [])
    .filter(p => !Number(p.is_deleted))
    .map(p => ({ method: p.method, label: methodLabel(p.method), amount: money(p.amount) }));
  const paid = money(payments.reduce((s, p) => s + p.amount, 0));
  const remaining = money(Math.max(0, grand - paid));
  const change = money(Math.max(0, paid - grand));

  /*
   * The receipt options decide two INFORMATIONAL blocks and nothing else: the
   * döviz line and the karekod. Neither one may touch `totals` - the TL figure
   * is what the guest owes, and a courtesy conversion that could move it would
   * be a fault, not a feature. They are resolved after the arithmetic is
   * finished, from a copy of the grand total, for exactly that reason.
   */
  const o = receiptOptions || await require('../modules/receipt').options(clientId);
  const fx = await foreignAmounts(clientId, grand, o);
  const qr = await receiptQr(clientId, o);

  const doc = {
    business,
    meta: {
      adisyonNo: order.adisyon_no || order.id,
      orderId: order.id,
      tableName: order.table_name || '',
      billLabel: order.bill_label || '',
      waiter: order.waiter_name || '',
      openedAt: order.opened_at || null,
      closedAt: order.closed_at || null,
      status: order.status,
    },
    lines,
    vat,
    totals: { subtotal, discount, grand, vatTotal, paid, remaining, change },
    payments,
    fx,
    fxNote: fx.length ? FX_NOTE : '',
    qr,
  };

  await repairDriftedHeader(clientId, doc, order);
  return doc;
}

/**
 * The lines are the truth; the header is a cache of them.
 *
 * When the two disagree the guest still gets a correct bill - refusing to
 * print mid-service would be a worse answer than any number on the paper. But
 * the stored header is then wrong for the reports too, so it is repaired on
 * the way past instead of being left to poison the day's takings.
 *
 * The tolerance is a kurus per line: each line rounds to two decimals on its
 * own, so a long bill can legitimately differ from the stored sum by that much
 * without anything being broken.
 */
async function repairDriftedHeader(clientId, doc, order) {
  const t = doc.totals;
  const stored = money(order.grand_total || 0);
  const tolerance = Math.max(0.02, doc.lines.length * 0.01);
  if (Math.abs(stored - t.grand) <= tolerance) return false;

  require('../logger').warn('receipt',
    `Adisyon ${doc.meta.adisyonNo}: stored grand ${stored} vs lines ${t.grand} - repairing`);
  try {
    await db.exec(
      `UPDATE orders SET total=?, discount_total=?, vat_total=?, grand_total=?, updated_at=NOW()
        WHERE id=? AND client_id=?`,
      [t.subtotal, t.discount, t.vatTotal, t.grand, order.id, clientId]);
    order.total = t.subtotal;
    order.discount_total = t.discount;
    order.grand_total = t.grand;
  } catch (e) {
    // a read-only replica or a locked row must not stop the guest's bill
    require('../logger').warn('receipt', 'header repair failed: ' + e.message);
  }
  return true;
}

module.exports = {
  billDocument, vatBreakdown, tl, qtyText, methodLabel, repairDriftedHeader,
  foreignAmounts, receiptQr, qrPng, qrDataUri, rateText, dayText, FX_NOTE, APPROX,
};
