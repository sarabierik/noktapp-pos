'use strict';
/**
 * The print agent lives INSIDE this service - there is no second program to
 * install and no separate window to keep open. Jobs are written to print_jobs
 * (the same table the web POS used) and a worker drains the queue, so a printer
 * that is switched off simply delays the slip instead of losing it.
 */
const db = require('../db');
const log = require('../logger');
const { Receipt } = require('./escpos');
const transport = require('./transport');
const { money } = require('../util/http');
const document = require('./document');

let timer = null;
let running = false;

/* --------------------------- job builders -------------------------- */
/*
 * The paper width and the receipt options come from modules/receipt now (the
 * Fiş ayarları screen), which resolves them from np_settings exactly as this
 * did - so a till that has never opened that screen prints what it printed
 * before. The require is late because modules/receipt reads this file back for
 * its preview.
 */
async function width() { return require('../modules/receipt').charWidth(); }
async function receiptOptions(clientId) { return require('../modules/receipt').options(clientId); }

/**
 * The top of every slip.
 *
 * Each line is now a switch on the Fiş ayarları screen: an antetli roll needs
 * no business name, a shop with no VKN should not print an empty "V.D.", and
 * the header block may be several lines because that is what people type into
 * it. Every default is "print it", which is what this did before.
 */
async function header(r, clientId, title, opt) {
  const o = opt || await receiptOptions(clientId);
  const c = await db.one('SELECT company_name, receipt_header, full_address, phone, tax_number, tax_office FROM clients WHERE id=?', [clientId]);
  const b = await db.one('SELECT * FROM business_settings WHERE client_id=? LIMIT 1', [clientId]);
  r.align('center');
  if (o.showBusinessName) {
    r.bold(true).double(true);
    r.line((b && b.business_name) || (c && c.company_name) || 'NOKTApp');
    r.double(false).bold(false);
  }
  r.bold(true);
  // the header block is free text and may be several lines
  const headerText = o.headerText !== undefined ? o.headerText : (c && c.receipt_header) || '';
  for (const l of String(headerText || '').split('\n')) if (l.trim()) r.line(l.trim());
  if (o.showAddress && b && b.address_line1) r.line(b.address_line1);
  if (o.showPhone && b && b.phone) r.line('Tel: ' + b.phone);
  if (o.showTax && b && b.tax_office) r.line(`${b.tax_office} V.D. ${b.tax_number || (c && c.tax_number) || ''}`.trim());
  else if (o.showTax && c && c.tax_office) r.line(`${c.tax_office} V.D. ${c.tax_number || ''}`);
  r.bold(false).align('left').rule('=');
  if (title) { r.align('center').bold(true).line(title).bold(false).align('left').rule('-'); }
  return r;
}

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Kitchen / bar slip - big, short, no prices. */
async function buildStationSlip(clientId, order, station, items, userName) {
  const r = new Receipt(await width());
  r.align('center').bold(true).double(true).line(station ? station.name : 'MUTFAK').double(false);
  r.line(order.table_name ? 'MASA: ' + order.table_name : 'PAKET');
  r.bold(false).align('left').rule('=');
  r.cols('Adisyon #' + order.adisyon_no, stamp());
  if (userName) r.line('Garson: ' + userName);
  /*
   * THE NOTES, ABOVE THE FOOD.
   *
   * Both of them, and above the lines rather than under them: a cook reads
   * the top of a slip and starts, and a note about the whole order - an
   * allergy, "cocuk icin once ciksin" - is useless once he has already begun.
   * `notes` is the guest's own note and prints here as well as on the bill;
   * `kitchen_note` prints ONLY here.
   */
  if (order.notes) { r.rule('-'); r.bold(true).line('NOT: ' + order.notes).bold(false); }
  if (order.kitchen_note) { if (!order.notes) r.rule('-'); r.bold(true).line('MUTFAK: ' + order.kitchen_note).bold(false); }
  r.rule('-');
  for (const it of items) {
    r.double(true).line(`${Number(it.send_qty || it.qty)} x ${it.product_name}`).double(false);
    if (it.note) r.line('   >> ' + it.note);
  }
  r.rule('=');
  return r.cut().build();
}

/** Void slip so the kitchen stops cooking something that was cancelled. */
async function buildVoidSlip(clientId, order, item, qty, reason) {
  const r = new Receipt(await width());
  r.align('center').bold(true).double(true).line('** IPTAL **').double(false).bold(false).align('left');
  r.rule('=');
  r.cols('Adisyon #' + order.adisyon_no, stamp());
  if (order.table_name) r.line('Masa: ' + order.table_name);
  r.rule('-');
  r.double(true).line(`${qty} x ${item.product_name || ''}`).double(false);
  if (reason) r.line('Sebep: ' + reason);
  r.rule('=');
  return r.cut().build();
}

/**
 * KURYE FISI - the piece of paper that goes in the bag with the food.
 *
 * This is the answer to "how does the courier know where to go", and until it
 * existed the answer was "the cashier reads it out loud". It is deliberately
 * NOT the customer's bill: a courier standing at a door in the rain needs
 * four things, large enough to read at arm's length under a streetlight -
 *
 *   where          the address, and the door note, which is the line that
 *                  decides whether they get in or phone from the pavement;
 *   who to call    the number, printed big, because that is the fallback for
 *                  everything the address does not say;
 *   what to take   how much to collect and in what form, or, just as
 *                  important, that it is ALREADY PAID and they must not ask;
 *   what is in it  the items, briefly, so a wrong bag is caught at the door
 *                  and not at the counter twenty minutes later.
 *
 * Prices per line are left off on purpose. The courier is not settling a bill
 * at the door; they are collecting one number, and printing thirteen others
 * next to it is how the wrong one gets asked for.
 */
async function buildCourierSlip(clientId, order, d, items) {
  const r = new Receipt(await width());
  const opt = await receiptOptions(clientId);
  r.align('center').bold(true).double(true).line('KURYE FISI').double(false);
  r.bold(false).line((opt && opt.business_name) || '').align('left').rule('=');
  r.cols('Adisyon #' + (order.adisyon_no || order.id), stamp());
  if (d.courier_name) r.line('Kurye: ' + d.courier_name);
  if (d.source && d.source !== 'PHONE' && d.source !== 'COUNTER') {
    r.line('Kaynak: ' + (SOURCE_LABEL[d.source] || d.source));
  }
  r.rule('-');

  /* The name and the number, big. Everything below can be squinted at; these
     two are what gets used while walking. */
  r.bold(true).line(d.customer_name || 'Musteri').bold(false);
  if (d.phone) r.double(true).line(d.phone).double(false);
  r.rule('-');
  for (const line of wrap(d.address_text || '-', await width())) r.line(line);
  if (d.directions) {
    r.line('');
    r.bold(true);
    for (const line of wrap('NOT: ' + d.directions, await width())) r.line(line);
    r.bold(false);
  }
  r.rule('-');

  for (const it of items || []) {
    r.line(`${slipQty(Number(it.qty))} x ${it.product_name || it.name || ''}`);
    if (it.note) r.line('   >> ' + it.note);
  }
  r.rule('=');

  /*
   * The money, last and loudest, because it is the thing a courier is asked
   * about at the door. A prepaid platform order says so in as many words:
   * "collect nothing" has to be as unmissable as a figure, or somebody asks
   * a guest to pay twice for a Yemeksepeti order.
   */
  if (d.is_prepaid) {
    r.align('center').bold(true).double(true).line('ODENDI').double(false);
    r.line('TAHSILAT YOK').bold(false).align('left');
  } else {
    r.align('center').bold(true).line('TAHSIL EDILECEK').double(true)
      .line(slipMoney(order.grand_total)).double(false);
    r.line(d.payment_method ? methodLabel(d.payment_method) : 'Kapida odeme');
    /*
     * PARA USTU. "He said he'd pay with a five hundred" is something the
     * cashier hears on the phone and the courier finds out at the door with
     * no change in his pocket. Printed as an instruction rather than a sum to
     * work out, because it is read one-handed in a stairwell.
     */
    const paidWith = Number(d.change_for_minor || 0) / 100;
    if (paidWith > 0) {
      const back = paidWith - Number(order.grand_total || 0);
      r.line('');
      r.line(slipMoney(paidWith) + ' ile odeyecek');
      if (back > 0) r.double(true).line('PARA USTU ' + slipMoney(back)).double(false);
      else if (back < 0) r.line('DIKKAT: verilen tutar yetmiyor');
    }
    r.bold(false).align('left');
  }
  r.rule('=');
  return r.cut().build();
}

/** Fold a long address onto the paper instead of letting the printer cut it. */
function wrap(text, cols) {
  const out = [];
  for (const para of String(text).split(/\n+/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line.length) { line = word; continue; }
      if ((line + ' ' + word).length <= cols) { line += ' ' + word; continue; }
      out.push(line); line = word;
    }
    if (line.length) out.push(line);
  }
  return out.length ? out : ['-'];
}

const SOURCE_LABEL = {
  UBER_EATS_TGO: 'Trendyol Go', YEMEKSEPETI: 'Yemeksepeti',
  MIGROS_YEMEK: 'Migros Yemek', GETIR_YEMEK: 'Getir Yemek',
};

/* Local to the courier slip. `money` from util/http returns a NUMBER for
   arithmetic; paper needs the Turkish written form, and shadowing the import
   to get it would quietly change every other total in this file. */
function slipQty(q) { return Number.isInteger(q) ? String(q) : String(q).replace('.', ','); }
function slipMoney(v) {
  return (Math.round(Number(v || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' TL';
}

/**
 * The customer's bill (adisyon / hesap fisi). Not a fiscal receipt.
 *
 * Rendered from the shared bill document, so the paper, the PDF and the e-mail
 * can never disagree about what the guest owes - and cancelled lines are gone
 * from the paper as well as from the total, which in the old system they were
 * not.
 */
async function buildBill(clientId, order,
  { title = 'HESAP FISI', showPayments = true, width: paperChars = null, receiptOptions: pre = null } = {}) {
  /* `receiptOptions` is passed by the Fiş ayarları preview so the owner sees
     what he has TYPED, rendered by this builder, before he saves it. It is
     resolved BEFORE the document because the document needs it: the döviz line
     and the karekod are decided in there, once, for all three renderers. */
  const o = pre || await receiptOptions(clientId);
  const d = await document.billDocument(clientId, order, { receiptOptions: o });
  const { tl, qtyText } = document;
  /* `width` is passed only by the preview, which renders 58 mm and 80 mm side
     by side without changing what the till is set to. */
  const r = new Receipt(paperChars || await width());

  /* The two callers that pass a title pass the old hard-coded default, so that
     value means "not chosen" and the configured başlık wins. Anything else is
     a deliberate override (an e-mailed copy, a reprint) and is left alone. */
  await header(r, clientId, title === 'HESAP FISI' ? o.title : title, o);
  r.cols('Adisyon: ' + d.meta.adisyonNo,
         o.showDateTime ? stamp(d.meta.openedAt ? new Date(d.meta.openedAt) : new Date()) : '');
  if (d.meta.tableName && o.showTable) {
    r.cols('Masa: ' + d.meta.tableName + (d.meta.billLabel ? ' / ' + d.meta.billLabel : ''),
           d.meta.waiter && o.showWaiter ? 'Garson: ' + d.meta.waiter : '');
  } else if (d.meta.waiter && o.showWaiter) {
    r.line('Garson: ' + d.meta.waiter);
  }
  r.rule('-');

  /*
   * The party's own note, on the paper they are handed. `kitchen_note` is
   * deliberately NOT here: "acele" and "cocuk icin once ciksin" are
   * instructions to the kitchen, and a guest reading them on his bill learns
   * something about the restaurant that nobody meant to tell him.
   */
  if (order.notes) { r.line('Not: ' + order.notes); r.rule('-'); }

  for (const l of d.lines) {
    r.item(qtyText(l.qty), l.name, tl(l.lineTotal));
    if (l.note) r.line('    ' + l.note);
  }
  if (!d.lines.length) r.line('Urun yok.');

  r.rule('-');
  r.cols('Ara Toplam', tl(d.totals.subtotal));
  if (d.totals.discount > 0) r.cols('Indirim', '-' + tl(d.totals.discount));
  r.bold(true).double(true).cols('TOPLAM', tl(d.totals.grand)).double(false).bold(false);

  /*
   * The döviz courtesy line, directly under the figure it converts - which is
   * where a guest looks for it, and far enough from the payment lines below
   * that it can never read as an amount that was taken.
   *
   * Neither bold nor double width: TOPLAM is, and the difference in weight is
   * the paper saying which number is the real one. The approximation sign is
   * document.APPROX.text and not "≈" - see the comment on it; code page 857
   * has no such glyph.
   */
  for (const f of d.fx) {
    r.cols('', document.APPROX.text + ' ' + f.amountText);
    r.cols('', f.sourceText);
  }
  if (d.fx.length) r.cols('', d.fxNote);

  if (d.vat.length && o.showVat) {
    r.rule('-');
    // "dahil" because the tax is already inside TOPLAM
    for (const v of d.vat) r.cols(`KDV %${v.rate} (dahil)`, tl(v.vat));
  }

  if (showPayments && d.payments.length) {
    r.rule('-');
    for (const p of d.payments) r.cols(p.label, tl(p.amount));
    if (d.totals.remaining > 0) r.bold(true).cols('KALAN', tl(d.totals.remaining)).bold(false);
    else if (d.totals.change > 0) r.cols('PARA USTU', tl(d.totals.change));
  }

  r.rule('=');
  r.align('center');
  // the footer is free text and may be several lines, like the header
  const footerText = (o.footerText !== undefined && o.footerText !== null && String(o.footerText).trim())
    ? o.footerText : d.business.footer;
  if (footerText) for (const l of String(footerText).split('\n')) if (l.trim()) r.line(l.trim());
  if (o.showThanks && o.thanks) r.bold(true).line(o.thanks).bold(false);
  /*
   * The karekod, as a NATIVE ESC/POS symbol (GS ( k), not a bitmap.
   *
   * The printer draws it, so it comes out at the printer's own resolution and
   * the job stays a few hundred bytes instead of the tens of kilobytes a
   * raster image of the same square would cost over a serial line. Every 80 mm
   * thermal printer we support implements GS ( k model 2.
   *
   * There is no fallback to a printed URL, and that is a decision rather than
   * an omission: print/transport.js writes down a one-way socket and never
   * hears back, so nothing here can discover that a printer ignored the
   * command. Printing the address as well "just in case" would put a raw URL
   * on every bill from every printer that DOES draw the square. The caption
   * line under it is the owner's own answer to that - it is where he writes
   * "Menü için okutun" or the address itself if his printer turns out to be
   * one of the old ones.
   */
  if (d.qr) {
    r.feed(1).qr(d.qr.data);
    if (d.qr.caption) r.line(d.qr.caption);
  }
  if (o.showBrand) r.line('NOKTApp POS');
  r.align('left');
  return r.cut().build();
}

function methodLabel(m) {
  return ({ nakit: 'Nakit', kredi_karti: 'Kredi Karti', yemek_karti: 'Yemek Karti',
    havale: 'Havale/EFT', ikram: 'Ikram', acik_hesap: 'Acik Hesap' })[m] || m;
}

/** X / Z report slip. */
async function buildReportSlip(clientId, z, kind = 'Z') {
  const r = new Receipt(await width());
  await header(r, clientId, kind + ' RAPORU');
  r.cols('Tarih', z.date);
  r.cols('Adisyon', String(z.orders));
  r.rule('-');
  r.cols('Brut Satis', money(z.gross).toFixed(2));
  r.cols('Indirim', money(z.discount).toFixed(2));
  r.bold(true).cols('NET SATIS', money(z.net).toFixed(2)).bold(false);
  r.rule('-');
  r.line('KDV DOKUMU');
  for (const v of z.vat_breakdown) r.cols(`  %${v.rate} (matrah ${v.base.toFixed(2)})`, v.vat.toFixed(2));
  r.cols('KDV TOPLAM', money(z.vat_total).toFixed(2));
  r.rule('-');
  r.line('ODEMELER');
  for (const p of z.payments) r.cols('  ' + methodLabel(p.method) + ` (${p.count})`, p.total.toFixed(2));
  r.rule('-');
  r.cols('Iptal edilen satir', `${z.cancelled_items.count} / ${z.cancelled_items.total.toFixed(2)}`);
  r.cols('Silinen adisyon', `${z.deleted_bills.count} / ${z.deleted_bills.total.toFixed(2)}`);
  r.rule('-');
  r.cols('Maliyet', money(z.cost_of_goods).toFixed(2));
  r.cols('Diger gider', money(z.extra_costs).toFixed(2));
  r.bold(true).cols('KAR', money(z.profit).toFixed(2)).bold(false);
  r.cols('Marj', money(z.margin).toFixed(2) + ' %');
  r.rule('=');
  r.align('center').line(stamp()).align('left');
  return r.cut().build();
}

/* ----------------------------- queueing ---------------------------- */
async function enqueue(clientId, { jobType = 'order', orderId = null, stationId = null, content }) {
  return db.insert(
    'INSERT INTO print_jobs (client_id, job_type, order_id, station_id, content, status, created_at) VALUES (?,?,?,?,?,\'pending\',NOW())',
    [clientId, jobType, orderId, stationId, content.toString('base64')]);
}

async function queueStationSlip(clientId, orderId, stationId, items, userId) {
  const orders = require('../modules/orders');
  const order = await orders.getOrder(clientId, orderId);
  const station = stationId ? await db.one('SELECT * FROM stations WHERE id=? AND client_id=?', [stationId, clientId]) : null;
  const user = userId ? await db.one('SELECT display_name FROM users WHERE id=?', [userId]) : null;
  const data = await buildStationSlip(clientId, order, station, items, user && user.display_name);
  return enqueue(clientId, { jobType: 'order', orderId, stationId, content: data });
}

/**
 * Queue the courier slip.
 *
 * Goes to the same printer the delivery slips already use - the connection's
 * paket printer if the restaurant set one, otherwise the till's receipt
 * printer - because a courier slip coming out at the pass with the kitchen
 * tickets is a courier slip nobody hands over.
 */
async function queueCourierSlip(clientId, orderId) {
  const orders = require('../modules/orders');
  const db2 = require('../db');
  const order = await orders.getOrder(clientId, orderId);
  if (!order) return null;
  const d = await db2.one(
    `SELECT d.*, k.name AS courier_name FROM delivery_orders d
       LEFT JOIN couriers k ON k.id = d.courier_id AND k.client_id = d.client_id
      WHERE d.client_id=? AND d.order_id=?`, [clientId, orderId]);
  if (!d) return null;
  const items = await db2.query(
    `SELECT oi.qty, oi.note, p.name AS product_name FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id=? AND oi.client_id=? AND oi.is_deleted=0
      ORDER BY oi.id`, [orderId, clientId]);
  const data = await buildCourierSlip(clientId, order, d, items);
  return enqueue(clientId, { jobType: 'receipt', orderId, content: data });
}

async function queueVoidSlip(clientId, orderId, item, qty, reason) {
  const orders = require('../modules/orders');
  const order = await orders.getOrder(clientId, orderId);
  const prod = await db.one('SELECT name FROM products WHERE id=?', [item.product_id]);
  const data = await buildVoidSlip(clientId, order, { ...item, product_name: prod && prod.name }, qty, reason);
  return enqueue(clientId, { jobType: 'order', orderId, stationId: item.station_id, content: data });
}

async function queueBill(clientId, orderId, opts = {}) {
  const orders = require('../modules/orders');
  const order = await orders.getOrder(clientId, orderId);
  if (!order) { const e = new Error('Adisyon bulunamadi'); e.status = 404; throw e; }
  const data = await buildBill(clientId, order, opts);
  const stationId = Number(await db.value('SELECT receipt_station_id FROM clients WHERE id=?', [clientId])) || null;
  return enqueue(clientId, { jobType: 'receipt', orderId, stationId, content: data });
}

/*
 * A report, a drawer pulse and a printer test have no order and never did.
 * They used to be queued as job_type 'receipt' with a null order_id, against
 * a column that was NOT NULL - so the till answered "Column 'order_id' cannot
 * be null" and the Z report simply never printed. Each now says what it is.
 */
async function queueReport(clientId, z, kind = 'Z') {
  const data = await buildReportSlip(clientId, z, kind);
  return enqueue(clientId, { jobType: 'report', content: data });
}

async function openDrawer(clientId) {
  const r = new Receipt(await width());
  return enqueue(clientId, { jobType: 'drawer', content: r.drawer().build() });
}

/* ------------------------------ worker ----------------------------- */
async function printerFor(clientId, stationId, jobType) {
  let p = null;
  if (stationId) p = await db.one('SELECT * FROM printers WHERE client_id=? AND station_id=? LIMIT 1', [clientId, stationId]);
  if (!p) p = await db.one('SELECT * FROM printers WHERE client_id=? AND is_default=1 LIMIT 1', [clientId]);
  if (!p) p = await db.one('SELECT * FROM printers WHERE client_id=? LIMIT 1', [clientId]);
  return p;
}

async function drain() {
  if (running) return;
  running = true;
  try {
    const jobs = await db.query("SELECT * FROM print_jobs WHERE status='pending' ORDER BY id LIMIT 20");
    for (const j of jobs) {
      const printer = await printerFor(j.client_id, j.station_id, j.job_type);
      if (!printer) {
        await db.exec("UPDATE print_jobs SET status='failed' WHERE id=?", [j.id]);
        log.warn('print', 'No printer configured for job ' + j.id);
        continue;
      }
      try {
        await transport.send(printer, Buffer.from(j.content, 'base64'));
        await db.exec("UPDATE print_jobs SET status='done', sent_at=NOW() WHERE id=?", [j.id]);
      } catch (err) {
        await db.exec("UPDATE print_jobs SET status='pending' WHERE id=?", [j.id]);
        log.error('print', 'Print failed, will retry', { job: j.id, printer: printer.name, error: err.message });
        break; // printer is down; stop hammering it
      }
    }
  } catch (e) {
    log.error('print', 'queue error', e.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(drain, 2500);
  log.info('print', 'Print agent started (built in, no separate program)');
}
function stop() { if (timer) clearInterval(timer); timer = null; }

async function testPrint(clientId, printerId) {
  const p = await db.one('SELECT * FROM printers WHERE id=? AND client_id=?', [printerId, clientId]);
  if (!p) { const e = new Error('Yazici bulunamadi'); e.status = 404; throw e; }
  const r = new Receipt(await width());
  await header(r, clientId, 'TEST FISI');
  r.line('Yazici: ' + p.name);
  r.line('Tur: ' + p.type);
  r.line('Adres: ' + (p.ip_address || '-'));
  r.line('Tarih: ' + stamp());
  r.rule('=');
  r.center('Turkce test: cCgGiIoOsSuU');
  await transport.send(p, r.cut().build());
  return true;
}

/**
 * A SECOND copy of a kitchen slip, for a jam or a ticket somebody lost.
 *
 * Deliberately not "send again": sendToStations only moves lines that have not
 * gone yet, which is right for sending and useless for reprinting - the whole
 * point here is the lines that HAVE gone. So this rebuilds the slip from the
 * sent quantities and queues it, and touches neither sent_qty nor the kitchen
 * board. The cook gets paper; nothing is ordered twice.
 */
async function reprintStationSlip(clientId, orderId, stationId = null) {
  const rows = await db.query(
    `SELECT i.*, COALESCE(i.station_id, c.station_id) AS route_station_id,
            p.name AS product_name, s.name AS station_name
       FROM order_items i
       LEFT JOIN products p ON p.id=i.product_id AND p.client_id=i.client_id
       LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
       LEFT JOIN stations s ON s.id=COALESCE(i.station_id, c.station_id) AND s.client_id=i.client_id
      WHERE i.order_id=? AND i.client_id=? AND i.is_deleted=0 AND i.sent_qty > 0`,
    [orderId, clientId]);
  if (!rows.length) {
    const e = new Error('Bu adisyonda mutfağa gitmiş satır yok.');
    e.status = 409; throw e;
  }
  const byStation = new Map();
  for (const it of rows) {
    const key = Number(it.route_station_id || 0);
    if (stationId && key !== Number(stationId)) continue;
    if (!byStation.has(key)) byStation.set(key, []);
    byStation.get(key).push({ ...it, send_qty: Number(it.sent_qty) });
  }
  if (!byStation.size) {
    const e = new Error('Bu istasyona gitmiş satır yok.');
    e.status = 409; throw e;
  }
  let queued = 0;
  for (const [sid, items] of byStation) {
    await queueStationSlip(clientId, orderId, sid || null, items, null);
    queued++;
  }
  return { reprinted: queued };
}

/** Put a failed job back in the queue. The drain picks it up on its next pass. */
async function retry(clientId, jobId) {
  const j = await db.one('SELECT id FROM print_jobs WHERE id=? AND client_id=?', [jobId, clientId]);
  if (!j) { const e = new Error('Yazdırma işi bulunamadı'); e.status = 404; throw e; }
  await db.exec("UPDATE print_jobs SET status='pending' WHERE id=?", [jobId]);
  return { queued: true };
}

module.exports = { start, stop, drain, enqueue, queueStationSlip, queueVoidSlip, queueBill,
  reprintStationSlip, retry,
  queueReport, queueCourierSlip, openDrawer, testPrint, buildBill, buildReportSlip,
  buildCourierSlip, methodLabel };
