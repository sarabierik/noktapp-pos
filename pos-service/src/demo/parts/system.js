'use strict';
/**
 * SİSTEM TARAFI — the screens nobody opens until something has gone wrong.
 *
 * İşlem günlüğü, cihazlar ve adisyon ön ekleri, yazıcı kuyruğu, ÖKC, yedekleme,
 * ayar geçmişi, senkron kuyruğu, denetim. Not one of them is produced by the
 * seven years of trading, every one of them is blank on a fresh till, and they
 * are the first screens support asks the owner to read out over the phone.
 *
 * The decision worth writing down is HOW FAR BACK each of them goes, because
 * the honest answer is not "2020" and the seeder that assumes it is costs tens
 * of thousands of rows to make every one of these screens look THINNER than it
 * does now. Each of these screens has a default window and it is short:
 * modules/device.logs() counts its areas and levels over the last 30 days, the
 * print queue is read in the ten minutes after a slip failed to come out, and
 * the ÖKC tab is a card terminal's recent history. So the activity log is
 * recent-weighted - dense for sixty days, a trickle before that - the print
 * queue is six days long, the backup list is a month, and the fiscal history
 * is ninety days. The years before that get enough rows to prove the
 * installation is old, and no more.
 *
 * The second decision, and it is the one that keeps ninety days of ÖKC history
 * to a few hundred rows rather than two thousand: THE DEVICE DID NOT TAKE
 * EVERY CARD. A counter with an ÖKC and a bank terminal on it uses both, and
 * the till only writes a fiscal_transactions row for the sales that went
 * through the device. The payments that did are stamped back onto
 * order_payments (fiscal_transaction_id, payment_channel='okc') exactly as
 * fiscal/index.js stamps them, so the Ödemeler screen and the ÖKC screen agree
 * about which card was which instead of quietly describing two different days.
 *
 * Nothing in here is a credential. A device token is stored as the SHA-256 of
 * random bytes that are thrown away in the same expression - there is no
 * token, only a hash of something that never existed - the ÖKC serial is
 * visibly a demo serial, the adapter is left wire_verified = 0 because nobody
 * has proven its message layer against a real device, and
 * fiscal_device_secrets is deliberately not written at all.
 */
const crypto = require('crypto');
const path = require('path');
const { bulk, ymd, dt, addDays, atTime, minor } = require('../lib');
const config = require('../../config');
const fiscalBase = require('../../fiscal/adapters/base');
const { Receipt } = require('../../print/escpos');

/* This PC, as the rest of the demo describes it: catalogue.js puts the station
   printers on 192.168.1.20-23, so the till is on the same little network. */
const HOST_IP = '192.168.1.40';
const OKC_IP = '192.168.1.60';

/* How far back each screen is filled. See the note at the top of the file. */
const LOG_DENSE_DAYS = 60;       // the window the activity log opens on
const LOG_THIN_DAYS = 400;       // still one or two lines a day out here
const PRINT_DAYS = 6;            // the queue nobody keeps longer than a week
const BACKUP_DAYS = 30;
const FISCAL_DAYS = 90;
const FISCAL_TARGET = 520;       // sales routed through the ÖKC in that window

/**
 * Nothing in this part is stamped later than the minute the demo was built.
 *
 * trading.js spreads today's bills across the whole evening on purpose - they
 * are the tables sitting open on the floor - but these screens are RECORDS,
 * and the top line of the İşlem günlüğü reading 23:41 while the clock says
 * half past four is the first thing anybody notices. So today is cut off at
 * now: the shift is open, the log stops at this minute, the last slips are
 * still in the queue, and the gün sonu has not been taken. Which is exactly
 * what a till looks like in the middle of service.
 */
const nowMs = () => Date.now();

/** Tables this database actually has - later migrations bring some of these. */
async function tableSet(db) {
  const rows = await db.query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=DATABASE()');
  return new Set(rows.map(r => String(r.t)));
}

/**
 * A 64 character hash of bytes that are discarded on the same line.
 *
 * node:crypto is the ONE place randomness does not come from ctx.rand(): a
 * seeded generator would make every demo installation's token hashes
 * identical, and a column that is unique across the table is the wrong place
 * to be reproducible. Nothing business-visible is decided here.
 */
const hash64 = () => crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
const hex = (n) => crypto.randomBytes(n).toString('hex');

/* ------------------------------------------------------------------------ */
/* 1. np_app_log - İşlem günlüğü                                            */
/* ------------------------------------------------------------------------ */

/*
 * Every message below is quoted from the code that writes it. Grep
 * log.info(' / log.warn(' / log.error(' across src/ and this is what comes
 * back, areas included - a demo log full of lines the program cannot produce
 * teaches whoever reads it to search for the wrong string.
 *
 * The exceptions are marked where they appear: the till does not yet log a
 * shift opening, a shift closing or a gün sonu anywhere, and a system log with
 * no trace of the three things that happen every single day is not a system
 * log. Those go under 'orders', which is a real area, in the voice the rest of
 * the Turkish messages use.
 */

/** [level, area, message, detail(r, ctx, day)] - once on a trading morning. */
const BOOT_BLOCK = [
  ['info', 'boot', 'NOKTApp POS service starting',
    () => ({ dataDir: 'C:\\ProgramData\\NoktAppPOS', port: 7451 })],
  ['info', 'boot', 'Local database connected', () => ({ db: 'noktapp_pos' })],
  ['info', 'boot', `Service listening on http://${HOST_IP}:7451`, null],
  ['info', 'lan', 'Advertised on the local network', () => ({ ips: [HOST_IP], port: 7451 })],
  ['info', 'print', 'Print agent started (built in, no separate program)', null],
  ['info', 'backup', 'Backup scheduler started', null],
  ['info', 'sync', 'Cloud sync started', null],
  ['info', 'relay', 'Cloud relay poller started', null],
];

/**
 * The pool the busy part of a day is drawn from, with weights.
 * [weight, level, area, message, detail(r, ctx)]
 */
const NOISE = [
  [9, 'info', 'paket', 'delivery opened', (r, c) => ({ clientId: c.clientId,
    orderId: 0, deliveryId: 0, source: r() < 0.5 ? 'telefon' : 'kapida' })],
  [6, 'info', 'paket', 'courier settled', (r, c) => ({ clientId: c.clientId,
    courier: pickName(r, ['Serkan', 'Volkan', 'Onur']), cash: Math.round(r() * 4000) })],
  [7, 'info', 'floor', 'rezervasyon olusturuldu', (r) => ({ id: 1 + Math.floor(r() * 400),
    guest: pickName(r, ['Ayşe Kaya', 'Murat Demir', 'Elif Yılmaz', 'Cem Aslan']),
    tableId: 1 + Math.floor(r() * 28) })],
  [5, 'info', 'floor', 'rezervasyon masaya oturtuldu', (r) => ({ id: 1 + Math.floor(r() * 400),
    table: 'S' + (1 + Math.floor(r() * 12)) })],
  [4, 'info', 'floor', 'rezervasyon durumu degisti', (r) => ({ id: 1 + Math.floor(r() * 400),
    from: 'bekliyor', to: r() < 0.5 ? 'geldi' : 'iptal' })],
  [3, 'info', 'floor', 'kapali masa yeniden acildi', (r) => ({ id: 1 + Math.floor(r() * 28),
    name: 'B' + (1 + Math.floor(r() * 10)) })],
  [6, 'info', 'guest', 'elle damga verildi', (r) => ({ customer: 100 + Math.floor(r() * 900),
    program: 1, qty: 1, reason: 'Müdavim' })],
  [4, 'info', 'guest', 'elle odul kullanildi', (r) => ({ card: 1 + Math.floor(r() * 300),
    reason: 'Kasada kullanıldı', discount: 10 * (1 + Math.floor(r() * 12)) })],
  [3, 'warn', 'loyalty', (r) => 'award failed for order ' + (1000 + Math.floor(r() * 9000)),
    () => 'Kart bulunamadi'],
  [8, 'info', 'entegrasyon', 'Sipariş çekme başladı',
    (r) => ({ provider: r() < 0.5 ? 'yemeksepeti' : 'getir', since: null })],
  [4, 'warn', 'entegrasyon', 'poll hatasi',
    (r) => ({ provider: r() < 0.5 ? 'yemeksepeti' : 'getir', error: 'socket hang up' })],
  [3, 'info', 'pricing', 'batch run', (r, c) => ({ clientId: c.clientId,
    scanned: 40 + Math.floor(r() * 20), created: Math.floor(r() * 6), refreshed: Math.floor(r() * 4),
    by: c.users.nurcan.id })],
  [2, 'info', 'pricing', 'suggestion accepted', (r, c) => ({ clientId: c.clientId,
    id: 1 + Math.floor(r() * 200), product: 1 + Math.floor(r() * 50),
    old: 100 + Math.floor(r() * 400), price: 120 + Math.floor(r() * 400) })],
  [1, 'info', 'pricing', 'bulk price change', (r, c) => ({ clientId: c.clientId,
    categoryId: 1 + Math.floor(r() * 6), pct: 5 + Math.floor(r() * 15), step: 5,
    changed: 4 + Math.floor(r() * 12), by: c.users.erdal.id })],
  [5, 'info', 'mail', 'Bill mailed', (r) => ({ to: 'misafir@example.com',
    order: 1000 + Math.floor(r() * 9000) })],
  [2, 'warn', 'mail', 'Mail failed, will retry', () => 'Connection timeout'],
  [6, 'warn', 'auth', 'PIN rejected', (r, c) => ({ clientId: c.clientId })],
  [5, 'warn', 'http', 'POST /pos/order/pay -> 409', (r) => ({ ms: 20 + Math.floor(r() * 400) })],
  [4, 'warn', 'orders', 'station slip not queued', (r, c) => ({
    stationId: c.stations[Math.floor(r() * c.stations.length)].id, error: 'Yazici yanit vermedi' })],
  [3, 'info', 'settings', 'station updated', (r, c) => ({ clientId: c.clientId,
    id: c.stations[Math.floor(r() * c.stations.length)].id, name: 'Ocak' })],
  [2, 'info', 'settings', 'PIN reset', (r, c) => ({
    user: c.staff[Math.floor(r() * c.staff.length)].id, by: c.users.erdal.id })],
  [4, 'info', 'device', 'Elle senkron çalıştırıldı',
    (r) => ({ pushed: Math.floor(r() * 9), remaining: 0 })],
  [3, 'info', 'receipt', 'Fiş genişliği 48 karaktere alındı (Kasa yazıcı - 80 mm)', null],
  [2, 'info', 'print', 'network scan', (r) => ({ subnets: ['192.168.1'],
    found: 3 + Math.floor(r() * 2), ms: 800 + Math.floor(r() * 2200) })],
  [3, 'debug', 'sync', (r) => 'pushed ' + (1 + Math.floor(r() * 40)) + ' rows', null],
  [2, 'debug', 'licence', 'heartbeat failed', () => 'ETIMEDOUT'],
  [2, 'debug', 'teshis', 'diagnostics skipped', () => 'Cihaz mesgul'],
  [2, 'warn', 'catalog', 'price change log not written: Duplicate entry', null],
  [3, 'info', 'fiscal', 'Fiscal sale approved', (r) => ({ tx: 1 + Math.floor(r() * 600),
    order: 1000 + Math.floor(r() * 9000) })],
  [1, 'warn', 'fiscal', 'Fiscal sale not completed', (r) => ({ tx: 1 + Math.floor(r() * 600),
    state: 'declined', err: 'Kart reddedildi' })],
];

function pickName(r, list) { return list[Math.floor(r() * list.length)]; }

/**
 * The scripted incidents.
 *
 * A log made only of a weighted pool reads as weather rather than as history:
 * every line is plausible and nothing ever HAPPENED. These are the eight
 * evenings somebody would remember, written as the run of lines each of them
 * actually produces - a printer that fails four times and then prints, a
 * licence that could not be checked for three days running, six PIN attempts
 * in ninety seconds. They are what makes the "yalnızca sorunlar" filter worth
 * pressing.
 *
 * [daysAgo, [ [minuteOffset, level, area, message, detail], ... ] ]
 */
function incidents(ctx, r) {
  const st = ctx.stations[Math.floor(r() * ctx.stations.length)];
  return [
    /* the Ocak printer's cable, on a Saturday */
    [4, 20, [
      [0, 'error', 'print', 'Print failed, will retry',
        { job: 701, printer: 'Ocak yazıcı', error: 'connect ECONNREFUSED 192.168.1.20:9100' }],
      [1, 'error', 'print', 'Print failed, will retry',
        { job: 701, printer: 'Ocak yazıcı', error: 'connect ECONNREFUSED 192.168.1.20:9100' }],
      [2, 'warn', 'orders', 'station slip not queued', { stationId: st.id, error: 'Yazici yanit vermedi' }],
      [4, 'error', 'print', 'Print failed, will retry',
        { job: 701, printer: 'Ocak yazıcı', error: 'connect ECONNREFUSED 192.168.1.20:9100' }],
      [9, 'info', 'print', 'network scan', { subnets: ['192.168.1'], found: 4, ms: 1740 }],
      [11, 'info', 'print', 'Print agent started (built in, no separate program)', null],
    ]],
    /* three days with no line out of the building */
    [11, 3, [
      [0, 'warn', 'licence', 'Panel unreachable, trying offline login', 'getaddrinfo EAI_AGAIN pos.noktapp.com'],
      [60, 'debug', 'sync', 'push failed', 'ETIMEDOUT'],
      [180, 'warn', 'backup', 'cloud backup failed', 'ETIMEDOUT'],
      [600, 'debug', 'relay', 'poll failed', 'ETIMEDOUT'],
    ]],
    [10, 3, [
      [0, 'warn', 'licence', 'Panel unreachable, trying offline login', 'getaddrinfo EAI_AGAIN pos.noktapp.com'],
      [30, 'warn', 'backup', 'cloud backup failed', 'ETIMEDOUT'],
    ]],
    [9, 10, [
      [0, 'info', 'licence', 'Online login ok', { email: 'erdal@kaleiciocakbasi.com' }],
      [1, 'info', 'device', 'Takılan işlemler yeniden kuyruğa alındı', { count: 14 }],
      [2, 'info', 'device', 'Elle senkron çalıştırıldı', { pushed: 14, remaining: 0 }],
      [40, 'info', 'backup', 'Cloud backup uploaded', { size: 71_840_512 }],
    ]],
    /* somebody at the till who had forgotten their PIN */
    [17, 21, [
      [0, 'warn', 'auth', 'PIN rejected', { clientId: ctx.clientId }],
      [0, 'warn', 'auth', 'PIN rejected', { clientId: ctx.clientId }],
      [1, 'warn', 'auth', 'PIN rejected', { clientId: ctx.clientId }],
      [1, 'warn', 'auth', 'PIN rejected', { clientId: ctx.clientId }],
      [2, 'warn', 'auth', 'PIN rejected', { clientId: ctx.clientId }],
      [3, 'info', 'settings', 'PIN reset', { user: ctx.users.okan.id, by: ctx.users.erdal.id }],
    ]],
    /* the new phone */
    [22, 18, [
      [0, 'info', 'device', 'Eşleştirme kodu üretildi', { by: ctx.users.erdal.id, for: ctx.users.melis.id }],
      [2, 'info', 'device', 'Adisyon ön eki verildi', { device_id: 'dev-bahce-01', prefix: 3 }],
      [2, 'info', 'lan', 'Advertised on the local network', { ips: [HOST_IP], port: 7451 }],
    ]],
    /* the tablet that was retired */
    [6, 16, [
      [0, 'info', 'device', 'Cihaz erişimi kesildi', { device_id: 'dev-bahce-01', tokens: 1 }],
      [0, 'info', 'device', 'Adisyon ön eki serbest bırakıldı',
        { prefix: 4, device_id: 'dev-eski-01', by: 'Erdal Sarıkaya', numbers_seen: 0 }],
    ]],
    /* the evening the ÖKC was fitted */
    [FISCAL_DAYS, 15, [
      [0, 'info', 'settings', 'station updated', { clientId: ctx.clientId, id: st.id, name: 'Kasa' }],
      [20, 'warn', 'fiscal', 'Fiscal sale not completed', { tx: 1, state: 'error', err: 'OKC cihazi yanit vermedi' }],
      [26, 'info', 'fiscal', 'Fiscal sale approved', { tx: 2, order: 0 }],
    ]],
  ];
}

async function seedAppLog(ctx, have) {
  if (!have.has('np_app_log')) return 0;
  const { db, rand: r } = ctx;
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));
  const rows = [];
  const cutoff = nowMs();
  const push = (when, level, area, message, detail) => {
    if (when.getTime() > cutoff) return;      // see the note at the top
    const msg = typeof message === 'function' ? message(r, ctx) : message;
    let det = typeof detail === 'function' ? detail(r, ctx) : detail;
    if (det !== null && det !== undefined && typeof det !== 'string') det = JSON.stringify(det);
    rows.push({ level, area, message: String(msg).slice(0, 500), detail: det || null,
      created_at: dt(when) });
  };

  /* the weighted pool, expanded once */
  const pool = [];
  for (const e of NOISE) for (let i = 0; i < e[0]; i++) pool.push(e);

  const todayMs = ctx.today.getTime();
  const today = ymd(ctx.today);
  for (const d of ctx.dayIndex) {
    const day = new Date(d.date + 'T00:00:00');
    const isToday = d.date === today;
    const age = Math.round((todayMs - day.getTime()) / 86400000);

    if (age > LOG_THIN_DAYS) {
      /* the old years: enough to prove the till was running, nothing more */
      if (r() < 0.35) {
        const e = pool[Math.floor(r() * pool.length)];
        push(atTime(day, between(12, 23), between(0, 59), between(0, 59)), e[1], e[2], e[3], e[4]);
      }
      continue;
    }

    /* gün sonu and the night's upload happen on every trading day - except
       that today's has not happened yet. trading.js deliberately leaves the
       last day's shift open and writes it no daily_closing, and a log line
       announcing a gün sonu that the Kasa screen is still waiting for is the
       kind of contradiction somebody finds in the first five minutes. */
    if (!isToday) {
      push(atTime(day, 23, between(46, 59), between(0, 59)), 'info', 'orders', 'Gün sonu alındı',
        { date: d.date, orders: d.orders.length,
          total: Math.round((d.cash + d.card + d.other) * 100) / 100 });
    }
    push(atTime(day, 3, between(0, 9), between(0, 59)), 'info', 'backup', 'Cloud backup uploaded',
      { size: 52_000_000 + Math.floor(r() * 26_000_000) });

    if (age > LOG_DENSE_DAYS) {
      if (r() < 0.14) {
        const e = pool[Math.floor(r() * pool.length)];
        push(atTime(day, between(12, 23), between(0, 59), between(0, 59)), e[1], e[2], e[3], e[4]);
      }
      continue;
    }

    /* ---- the last two months, at the density the screen opens on ---- */
    /* the service is restarted every few days, not every morning: the till PC
       stays on, which is also why the 03:00 upload above has anybody to run */
    if (r() < 0.28) {
      let m = between(35, 55);
      for (const [level, area, message, detail] of BOOT_BLOCK) {
        push(atTime(day, 9, m, between(0, 59)), level, area, message, detail);
        m = Math.min(59, m + (r() < 0.5 ? 0 : 1));
      }
      if (r() < 0.5) {
        push(atTime(day, 9, between(30, 34), between(0, 59)), 'info', 'boot', 'Shutting down (SIGTERM)', null);
      }
    }
    push(atTime(day, 10, between(30, 55), between(0, 59)), 'info', 'orders', 'Vardiya açıldı',
      { shift: d.shift_id, by: ctx.users.sevim.name, float: 2500 });
    if (!isToday) {
      push(atTime(day, 23, between(40, 45), between(0, 59)), 'info', 'orders', 'Vardiya kapatıldı',
        { shift: d.shift_id, orders: d.orders.length,
          cash: Math.round(d.cash * 100) / 100, card: Math.round(d.card * 100) / 100 });
    }
    if (r() < 0.4) {
      push(atTime(day, between(11, 18), between(0, 59), between(0, 59)), 'info', 'licence',
        'Online login ok', { email: 'erdal@kaleiciocakbasi.com' });
    }

    const n = between(28, 50);
    for (let i = 0; i < n; i++) {
      const e = pool[Math.floor(r() * pool.length)];
      /* service hours: nothing interesting happens at four in the morning */
      const hour = r() < 0.18 ? between(10, 16) : between(17, 23);
      push(atTime(day, hour, between(0, 59), between(0, 59)), e[1], e[2], e[3], e[4]);
    }
  }

  /* the evenings somebody remembers */
  for (const [daysAgo, hour, lines] of incidents(ctx, r)) {
    const day = addDays(ctx.today, -daysAgo);
    const base = atTime(day, hour, 20, 0).getTime();
    for (const [off, level, area, message, detail] of lines) {
      push(new Date(base + off * 60000), level, area, message, detail);
    }
  }

  /*
   * Sorted before writing, because np_app_log has no ordering but its id and
   * modules/device.logs() reads `ORDER BY id DESC`. Rows written out of order
   * would put last March above this morning on the one screen whose whole
   * purpose is "what happened just now".
   */
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  await bulk(db, 'np_app_log', ['level', 'area', 'message', 'detail', 'created_at'], rows);
  return rows.length;
}

/* ------------------------------------------------------------------------ */
/* 2. print_jobs - Yazıcı kuyruğu                                           */
/* ------------------------------------------------------------------------ */

/*
 * The queue holds the BYTES that were sent to the printer, base64'd, and the
 * screen offers to send them again - so a demo whose content column is a
 * placeholder is a demo where "Yeniden dene" prints rubbish. These are built
 * with the same print/escpos Receipt the till builds them with.
 */
function stationSlip(order, stationName, waiterName, lines) {
  const r = new Receipt(48);
  r.align('center').bold(true).double(true).line(stationName).double(false);
  r.line(order.table_name ? 'MASA: ' + order.table_name : 'PAKET');
  r.bold(false).align('left').rule('=');
  r.cols('Adisyon #' + order.adisyon_no, order.stamp);
  if (waiterName) r.line('Garson: ' + waiterName);
  r.rule('-');
  for (const [qty, name] of lines) { r.double(true).line(`${qty} x ${name}`).double(false); }
  r.rule('=');
  return r.cut().build();
}

function billSlip(order, lines) {
  const r = new Receipt(48);
  r.align('center').bold(true).double(true).line('KALEİÇİ OCAKBAŞI').double(false);
  r.line('Barbaros Mah. Hıdırlık Sk. No:12');
  r.line('Kaleiçi / ANTALYA');
  r.bold(false).align('left').rule('=');
  r.cols('Adisyon #' + order.adisyon_no, order.stamp);
  if (order.table_name) r.cols('Masa', order.table_name);
  r.rule('-');
  for (const [qty, name, amount] of lines) r.item(qty, name, amount.toFixed(2));
  r.rule('-');
  r.bold(true).cols('TOPLAM', order.grand.toFixed(2)).bold(false);
  r.rule('=');
  r.center('Afiyet olsun - tekrar bekleriz');
  return r.cut().build();
}

function drawerPulse() { return new Receipt(48).drawer().build(); }

async function seedPrintJobs(ctx, have) {
  if (!have.has('print_jobs')) return 0;
  const { db, clientId, rand: r } = ctx;
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));

  const days = ctx.dayIndex.slice(-PRINT_DAYS);
  if (!days.length) return 0;
  const from = days[0].date;

  const orders = await db.query(
    `SELECT o.id, o.adisyon_no, o.business_date, o.closed_at, o.opened_at, o.grand_total,
            t.name AS table_name, u.display_name AS waiter_name
       FROM orders o
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
       LEFT JOIN users u ON u.id = o.waiter_id
      WHERE o.client_id=? AND o.business_date >= ? AND o.is_deleted=0
      ORDER BY o.id`, [clientId, from]);
  if (!orders.length) return 0;

  const byOrder = new Map();
  for (const chunk of chunks(orders.map(o => o.id), 400)) {
    const rows = await db.query(
      `SELECT i.order_id, i.qty, i.line_total, i.station_id, p.name
         FROM order_items i LEFT JOIN products p ON p.id=i.product_id
        WHERE i.client_id=? AND i.is_deleted=0 AND i.order_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY i.id`, [clientId, ...chunk]);
    for (const it of rows) {
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id).push(it);
    }
  }

  const today = ymd(ctx.today);
  const cutoff = nowMs();
  const jobs = [];
  for (const o of orders) {
    const items = byOrder.get(o.id) || [];
    if (!items.length) continue;
    const closed = o.closed_at ? new Date(o.closed_at) : new Date(o.opened_at);
    const opened = new Date(o.opened_at);
    const stamp = `${String(opened.getDate()).padStart(2, '0')}.` +
      `${String(opened.getMonth() + 1).padStart(2, '0')}.${opened.getFullYear()} ` +
      `${String(opened.getHours()).padStart(2, '0')}:${String(opened.getMinutes()).padStart(2, '0')}`;
    const head = { adisyon_no: o.adisyon_no, table_name: o.table_name, stamp,
      grand: Number(o.grand_total) };

    /* one slip per station that had a line on this bill */
    const byStation = new Map();
    for (const it of items) {
      const sid = it.station_id || (ctx.stations[0] && ctx.stations[0].id);
      if (!byStation.has(sid)) byStation.set(sid, []);
      byStation.get(sid).push([Number(it.qty), it.name || 'Ürün']);
    }
    for (const [sid, lines] of byStation) {
      const station = ctx.stations.find(s => s.id === sid);
      jobs.push({ job_type: 'order', order_id: o.id, station_id: sid,
        content: stationSlip(head, station ? station.name.toUpperCase() : 'MUTFAK',
          o.waiter_name, lines).toString('base64'),
        at: new Date(opened.getTime() + between(1, 4) * 60000) });
    }
    /* and the bill, on the bills that were actually closed */
    if (o.closed_at && r() < 0.75) {
      jobs.push({ job_type: 'receipt', order_id: o.id, station_id: null,
        content: billSlip(head, items.map(i => [Number(i.qty), i.name || 'Ürün', Number(i.line_total)]))
          .toString('base64'),
        at: closed });
    }
  }

  /* the things that have no bill behind them */
  for (const d of days) {
    const day = new Date(d.date + 'T00:00:00');
    for (let k = 0; k < between(1, 3); k++) {
      jobs.push({ job_type: 'drawer', order_id: null, station_id: null,
        content: drawerPulse().toString('base64'),
        at: atTime(day, between(12, 23), between(0, 59)) });
    }
    if (d.date !== today) {
      jobs.push({ job_type: 'report', order_id: null, station_id: null,
        content: new Receipt(48).center('GUN SONU (Z)').rule('=').cut().build().toString('base64'),
        at: atTime(day, 23, between(50, 58)) });
    }
  }

  const queued = jobs.filter(j => j.at.getTime() <= cutoff).sort((a, b) => a.at - b.at);

  /*
   * Status is decided by position, not at random. The queue tells one story:
   * everything printed, except the four minutes on the newest day when the
   * Ocak printer refused the socket - the failures - and the two slips that
   * were queued in the last minute and the worker has not reached yet.
   */
  const rows = [];
  const failAt = Math.max(0, queued.length - between(14, 20));
  for (let i = 0; i < queued.length; i++) {
    const j = queued[i];
    let status = 'done';
    let sent = new Date(j.at.getTime() + between(2, 20) * 1000);
    if (i >= queued.length - 2) { status = 'pending'; sent = null; }
    else if (i >= failAt && i < failAt + 2) { status = 'failed'; sent = null; }
    rows.push({ client_id: clientId, job_type: j.job_type, order_id: j.order_id,
      station_id: j.station_id, content: j.content, status,
      sent_at: sent ? dt(sent) : null, created_at: dt(j.at) });
  }
  await bulk(db, 'print_jobs',
    ['client_id', 'job_type', 'order_id', 'station_id', 'content', 'status', 'sent_at', 'created_at'],
    rows);
  return rows.length;
}

/* ------------------------------------------------------------------------ */
/* 3. the handhelds                                                         */
/* ------------------------------------------------------------------------ */

/*
 * Three devices, because that is what a thirty table kebap house carries: two
 * phones and the PDA that lives on the pass. One of them is revoked and still
 * holds its prefix, which is not an oversight - modules/device.revoke() leaves
 * the prefix alone on purpose ("a revoked device may still be holding unsynced
 * bills numbered on it"), and the screen that explains that rule is worth
 * having something on it.
 *
 * Erdal's phone carries TWO token rows. He re-paired it in August and
 * lan.issueDeviceToken always INSERTs, so the old row is still there and still
 * alive - which is the exact case modules/device.devices() groups by device_id
 * to hide. A demo with one token per device never exercises it.
 */
async function seedDevices(ctx, have) {
  const { db, clientId, rand: r } = ctx;
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));
  const out = { tokens: 0, numbers: 0, counters: 0, history: 0 };
  if (!have.has('app_device_tokens')) return out;

  const now = new Date();
  const ago = (days, h, m) => atTime(addDays(ctx.today, -days), h, m, between(0, 59));

  const devices = [
    { device_id: 'nokta-erdal-a52', name: "Erdal'ın telefonu", user: ctx.users.erdal,
      platform: 'android', version: '2.1.4', prefix: 1,
      /* re-paired 11 days ago; the June token is still outstanding */
      tokens: [{ created: ago(78, 14, 20), seen: ago(11, 13, 5), revoked: null },
               { created: ago(11, 13, 2), seen: new Date(now.getTime() - between(40, 260) * 1000),
                 revoked: null }],
      ip: HOST_IP.replace(/\.\d+$/, '.66'), next: 8 },
    { device_id: 'nokta-salon-pda', name: 'Salon PDA', user: ctx.users.sevim,
      platform: 'android', version: '2.0.9', prefix: 2,
      tokens: [{ created: ago(19, 11, 40), seen: new Date(now.getTime() - between(3, 7) * 3600000),
                 revoked: null }],
      ip: HOST_IP.replace(/\.\d+$/, '.71'), next: 5 },
    { device_id: 'nokta-bahce-01', name: 'Bahçe telefonu', user: ctx.users.melis,
      platform: 'android', version: '1.9.7', prefix: 3,
      tokens: [{ created: ago(22, 18, 25), seen: ago(7, 22, 40), revoked: ago(6, 16, 20) }],
      ip: HOST_IP.replace(/\.\d+$/, '.74'), next: 1 },
  ];

  const tokenRows = [];
  for (const d of devices) {
    for (const t of d.tokens) {
      tokenRows.push({
        client_id: clientId, user_ref: String(d.user.id), is_client: 0, role: d.user.role,
        device_id: d.device_id, device_name: d.name, platform: d.platform, app_version: d.version,
        token_hash: hash64(), refresh_hash: hash64(),
        expires_at: dt(new Date(t.created.getTime() + 30 * 86400000)),
        refresh_expires_at: dt(new Date(t.created.getTime() + 180 * 86400000)),
        last_seen_at: dt(t.seen), last_ip: d.ip,
        revoked_at: t.revoked ? dt(t.revoked) : null, created_at: dt(t.created),
      });
    }
  }
  await bulk(db, 'app_device_tokens', ['client_id', 'user_ref', 'is_client', 'role', 'device_id',
    'device_name', 'platform', 'app_version', 'token_hash', 'refresh_hash', 'expires_at',
    'refresh_expires_at', 'last_seen_at', 'last_ip', 'revoked_at', 'created_at'],
    tokenRows, { ignore: true });
  out.tokens = tokenRows.length;

  if (have.has('app_device_numbers')) {
    await bulk(db, 'app_device_numbers', ['client_id', 'device_id', 'prefix', 'created_at'],
      devices.map(d => ({ client_id: clientId, device_id: d.device_id, prefix: d.prefix,
        created_at: dt(d.tokens[0].created) })), { ignore: true });
    out.numbers = devices.length;
  }

  if (have.has('app_device_number_history')) {
    const hist = devices.map(d => ({
      client_id: clientId, device_id: d.device_id, device_name: d.name, prefix: d.prefix,
      allocated_at: dt(d.tokens[0].created), released_at: null, released_by: null, numbers_seen: 0,
    }));
    /* the tablet that was taken out of service - the only row the history tab
       shows, because it filters on released_at IS NOT NULL */
    hist.push({ client_id: clientId, device_id: 'nokta-eski-tablet',
      device_name: 'Eski salon tableti', prefix: 4,
      allocated_at: dt(ago(340, 12, 10)), released_at: dt(ago(6, 16, 21)),
      released_by: ctx.users.erdal.name, numbers_seen: 17 });
    await bulk(db, 'app_device_number_history', ['client_id', 'device_id', 'device_name', 'prefix',
      'allocated_at', 'released_at', 'released_by', 'numbers_seen'], hist);
    out.history = hist.length;
  }

  if (have.has('app_order_counters')) {
    /*
     * Today's counters are what the "Adisyon ön ekleri" tab draws its examples
     * from, and the server's own prefix 0 has to agree with what trading.js
     * left in order_counters - a phone showing 20007 next to a till showing 3
     * is the screen explaining itself wrongly.
     */
    const rows = [];
    const dates = ctx.dayIndex.slice(-4).map(d => d.date);
    for (const date of dates) {
      const isToday = date === ymd(ctx.today);
      const stamp = isToday ? dt(new Date()) : date + ' 23:30:00';
      rows.push({ client_id: clientId, business_date: date, prefix: 0,
        next_no: isToday ? 61 : between(40, 70), updated_at: stamp });
      for (const d of devices) {
        if (d.next <= 1 && !isToday) continue;
        rows.push({ client_id: clientId, business_date: date, prefix: d.prefix,
          next_no: isToday ? d.next : Math.max(1, d.next + between(-2, 4)),
          updated_at: stamp });
      }
    }
    await bulk(db, 'app_order_counters',
      ['client_id', 'business_date', 'prefix', 'next_no', 'updated_at'], rows, { ignore: true });
    out.counters = rows.length;
  }

  /* ---------------------------------------------------- pairing codes ---- */
  if (have.has('np_mobile_pairings')) {
    /*
     * All spent, none live. A pairing code left alive in a demo is a live
     * credential on a screen that is going to be projected: activePairCode()
     * would put it, and the QR that redeems it without a password, on the
     * Cihazlar tab the moment anybody opened it.
     */
    const rows = [];
    const seen = new Set();
    const code = () => { let c; do { c = String(100000 + Math.floor(r() * 900000)); } while (seen.has(c)); seen.add(c); return c; };
    const spent = [
      [78, ctx.users.erdal, devices[0], 'kod'],
      [22, ctx.users.erdal, devices[2], 'qr'],
      [19, ctx.users.nurcan, devices[1], 'kod'],
      [11, ctx.users.erdal, devices[0], 'qr'],
    ];
    for (const [daysAgo, by, dev, how] of spent) {
      const made = ago(daysAgo, between(11, 19), between(0, 59));
      rows.push({ client_id: clientId, pair_code: code(), qr_token: hex(16),
        device_id: dev.device_id, device_name: dev.name, platform: dev.platform,
        user_id: by.id, for_user_id: dev.user.id,
        expires_at: dt(new Date(made.getTime() + 600000)),
        used_at: dt(new Date(made.getTime() + between(30, 400) * 1000)),
        redeemed_by: how, created_at: dt(made) });
    }
    /* two that were minted and never used - they simply timed out */
    for (const daysAgo of [40, 9]) {
      const made = ago(daysAgo, between(12, 20), between(0, 59));
      rows.push({ client_id: clientId, pair_code: code(), qr_token: hex(16),
        device_id: null, device_name: null, platform: null,
        user_id: ctx.users.erdal.id, for_user_id: ctx.users.tugba.id,
        expires_at: dt(new Date(made.getTime() + 600000)),
        used_at: null, redeemed_by: null, created_at: dt(made) });
    }
    await bulk(db, 'np_mobile_pairings', ['client_id', 'pair_code', 'qr_token', 'device_id',
      'device_name', 'platform', 'user_id', 'for_user_id', 'expires_at', 'used_at',
      'redeemed_by', 'created_at'], rows, { ignore: true });
    out.pairings = rows.length;
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* 4. np_backups                                                            */
/* ------------------------------------------------------------------------ */

async function seedBackups(ctx, have) {
  if (!have.has('np_backups')) return 0;
  const { db, rand: r } = ctx;
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));
  const rows = [];

  /* the file name is exactly the one backup.run() writes, folder included -
     restore.sources() matches its folder listing against file_path, and a name
     in another shape is a row that can never be recognised again */
  const name = (when, kind) =>
    path.join(config.backupDir,
      'noktapp-pos-' + when.toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + kind + '.sql.gz');

  /* a dump that grows with the history it contains */
  const size = (daysAgo) => Math.round((78_000_000 - daysAgo * 26_000) * (0.97 + r() * 0.06));

  for (let d = BACKUP_DAYS; d >= 1; d--) {
    const at = atTime(addDays(ctx.today, -d), 3, between(0, 9), between(0, 59));
    /* one night in the month the line was down */
    const failed = d === 11;
    rows.push({ kind: 'cloud', file_path: name(at, 'cloud'), size_bytes: size(d),
      sha256: hex(32), status: failed ? 'failed' : 'ok',
      message: failed ? 'Yedek yuklenemedi: baglanti zaman asimina ugradi' : null,
      created_at: dt(at) });
  }
  /* the local snapshots only the last few days still have on disk */
  for (let d = 3; d >= 0; d--) {
    for (const h of [11, 15, 19, 23]) {
      if (d === 0 && h > new Date().getHours()) continue;
      const at = atTime(addDays(ctx.today, -d), h, between(0, 14), between(0, 59));
      rows.push({ kind: 'local', file_path: name(at, 'local'), size_bytes: size(d),
        sha256: hex(32), status: 'ok', message: null, created_at: dt(at) });
    }
  }
  /* the two the manager took by hand, and the one restore left behind */
  for (const [d, h, kind, msg] of [
    [124, 17, 'manual', null],
    [46, 10, 'manual', null],
    [46, 10, 'pre-restore', 'Geri yükleme öncesi otomatik yedek'],
    [318, 15, 'manual', null],
  ]) {
    const at = atTime(addDays(ctx.today, -d), h, between(0, 59), between(0, 59));
    rows.push({ kind, file_path: name(at, kind), size_bytes: size(d), sha256: hex(32),
      status: 'ok', message: msg, created_at: dt(at) });
  }

  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  await bulk(db, 'np_backups',
    ['kind', 'file_path', 'size_bytes', 'sha256', 'status', 'message', 'created_at'], rows);
  return rows.length;
}

/* ------------------------------------------------------------------------ */
/* 5. np_settings_log - Ayar geçmişi                                        */
/* ------------------------------------------------------------------------ */

/*
 * Every key below is a real one out of settings.DEFS. A history full of keys
 * the catalogue does not know would draw rows the screen cannot label.
 * smtp_pass is the one marked secret there, so its new value is '***' - which
 * is what settings.save() writes, and the reason this file can carry an SMTP
 * password change without carrying an SMTP password.
 *
 * [daysAgo, key, old, new, who]
 */
const SETTING_CHANGES = (ctx) => {
  const E = ctx.users.erdal.id, N = ctx.users.nurcan.id;
  return [
    [2380, 'business_day_start', '06:00', '05:00', E],
    [2376, 'receipt_width', '48', '42', E],
    [2375, 'receipt_copies', '1', '2', E],
    [2310, 'kitchen_void_slip', '0', '1', N],
    [2180, 'manager_pin_void', '0', '1', E],
    [2090, 'backup_keep_days', '14', '30', E],
    [1980, 'receipt_show_waiter', '0', '1', N],
    [1930, 'max_discount_percent', '100', '25', E],
    [1870, 'open_drawer_on_cash', '0', '1', N],
    [1760, 'smtp_host', '', 'smtp.yandex.com', E],
    [1760, 'smtp_port', '465', '465', E],
    [1760, 'smtp_user', '', 'bilgi@kaleiciocakbasi.com', E],
    [1760, 'smtp_pass', null, '***', E],
    [1759, 'smtp_from', 'noreply@noktapp.com', 'bilgi@kaleiciocakbasi.com', E],
    [1640, 'kitchen_auto_send', '0', '1', N],
    [1500, 'day_auto_close', '0', '1', E],
    [1440, 'pin_max_fail', '5', '4', E],
    [1390, 'auto_lock_minutes', '0', '10', N],
    [1250, 'delivery_default_minutes', '45', '40', N],
    [1180, 'receipt_auto_print', '0', '1', E],
    [1100, 'backup_cloud_hour', '3', '4', E],
    [1010, 'rounding_mode', 'none', 'nearest', E],
    [950, 'tip_enabled', '0', '1', N],
    [880, 'receipt_qr', '0', '1', E],
    [810, 'delivery_min_order_block', '0', '1', N],
    [740, 'hours_5', '09:00-23:00', '09:00-01:00', E],
    [740, 'hours_6', '09:00-23:00', '09:00-01:00', E],
    [690, 'max_discount_percent', '25', '20', E],
    [610, 'manager_pin_delete_bill', '0', '1', E],
    [540, 'kitchen_slip_per_course', '0', '1', N],
    [470, 'backup_cloud_enabled', '0', '1', E],
    [400, 'auto_lock_minutes', '10', '5', E],
    [330, 'relay_enabled', '0', '1', E],
    [270, 'receipt_show_fx', '0', '1', N],
    [210, 'delivery_default_minutes', '40', '35', N],
    [160, 'pin_lock_minutes', '5', '10', E],
    [120, 'receipt_copies', '2', '1', N],
    [FISCAL_DAYS, 'fiscal_enabled', '0', '1', E],
    [FISCAL_DAYS - 1, 'open_drawer_on_cash', '1', '0', E],
    [44, 'max_discount_percent', '20', '15', E],
    [21, 'kitchen_show_prices', '0', '1', N],
    [6, 'backup_keep_days', '30', '45', E],
  ];
};

async function seedSettingsLog(ctx, have) {
  if (!have.has('np_settings_log')) return 0;
  const { db, clientId, rand: r } = ctx;
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));
  const rows = [];
  for (const [daysAgo, k, oldV, newV, by] of SETTING_CHANGES(ctx)) {
    const at = atTime(addDays(ctx.today, -daysAgo), between(9, 18), between(0, 59), between(0, 59));
    if (at < ctx.start) continue;
    rows.push({ client_id: clientId, k, old_value: oldV, new_value: newV,
      changed_by: by, created_at: dt(at) });
  }
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  await bulk(db, 'np_settings_log',
    ['client_id', 'k', 'old_value', 'new_value', 'changed_by', 'created_at'], rows);
  return rows.length;
}

/* ------------------------------------------------------------------------ */
/* 6. np_sync_outbox + np_relay_state - Senkron durumu                      */
/* ------------------------------------------------------------------------ */

/*
 * The entity names are the three sync/index.js actually pushes: daily_closing
 * once a night, daily_summary on the hour, integration_order when a platform
 * order lands. The interesting rows are at the bottom of the list and they are
 * three different states that look identical to anyone who has not read
 * modules/device.syncStatus():
 *
 *   pending, attempts 0     the queue is simply moving
 *   pending, attempts 11    the drain filters on `attempts < 10`, so nothing
 *                           will ever pick this row up again. This is `stuck`,
 *                           and it is the number that screen exists to show.
 *   failed                  the panel refused it outright
 */
async function seedOutbox(ctx, have) {
  if (!have.has('np_sync_outbox')) return 0;
  const { db, clientId, rand: r } = ctx;
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));
  const rows = [];

  const today = ymd(ctx.today);
  const days = ctx.dayIndex.slice(-200);
  for (const d of days) {
    if (d.date === today) continue;          // nothing to push until it closes
    const day = new Date(d.date + 'T00:00:00');
    const at = atTime(day, 23, between(50, 58), between(0, 59));
    rows.push({ client_id: clientId, entity: 'daily_closing', entity_id: `${clientId}:${d.date}`,
      op: 'upsert',
      payload: JSON.stringify({ date: d.date, orders: d.orders.length,
        cash: Math.round(d.cash * 100) / 100, card: Math.round(d.card * 100) / 100 }),
      status: 'sent', attempts: 0, last_error: null, created_at: dt(at),
      sent_at: dt(new Date(at.getTime() + between(2, 90) * 1000)) });
  }
  /* the hourly summary, for the fortnight the screen can actually reach */
  for (const d of ctx.dayIndex.slice(-14)) {
    const day = new Date(d.date + 'T00:00:00');
    for (const h of [13, 17, 20, 22]) {
      const at = atTime(day, h, between(0, 9), between(0, 59));
      if (at.getTime() > nowMs()) continue;
      rows.push({ client_id: clientId, entity: 'daily_summary', entity_id: `${clientId}:${d.date}`,
        op: 'upsert', payload: JSON.stringify({ business_date: d.date, hour: h }),
        status: 'sent', attempts: 0, last_error: null, created_at: dt(at),
        sent_at: dt(new Date(at.getTime() + between(2, 40) * 1000)) });
    }
  }

  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));

  /* and the tail, which is the only part anybody looks at */
  const now = new Date();
  const mins = (m) => dt(new Date(now.getTime() - m * 60000));
  rows.push({ client_id: clientId, entity: 'integration_order', entity_id: 'yemeksepeti:8842190',
    op: 'upsert', payload: JSON.stringify({ provider: 'yemeksepeti', code: '8842190' }),
    status: 'pending', attempts: 0, last_error: null, created_at: mins(4), sent_at: null });
  rows.push({ client_id: clientId, entity: 'daily_summary', entity_id: `${clientId}:${ymd(ctx.today)}`,
    op: 'upsert', payload: JSON.stringify({ business_date: ymd(ctx.today), hour: now.getHours() }),
    status: 'pending', attempts: 0, last_error: null, created_at: mins(2), sent_at: null });
  rows.push({ client_id: clientId, entity: 'qr_menu', entity_id: String(clientId),
    op: 'upsert', payload: JSON.stringify({ slug: 'kaleici-ocakbasi', version: 41 }),
    status: 'pending', attempts: 11,
    last_error: 'panel rejected: menu surumu bu lisansta desteklenmiyor',
    created_at: mins(60 * 26), sent_at: null });
  rows.push({ client_id: clientId, entity: 'daily_closing',
    entity_id: `${clientId}:${ymd(addDays(ctx.today, -11))}`, op: 'upsert',
    payload: JSON.stringify({ date: ymd(addDays(ctx.today, -11)) }),
    status: 'failed', attempts: 3, last_error: 'panel rejected: licence_key eslesmedi',
    created_at: dt(atTime(addDays(ctx.today, -11), 23, 54)), sent_at: null });

  await bulk(db, 'np_sync_outbox', ['client_id', 'entity', 'entity_id', 'op', 'payload',
    'status', 'attempts', 'last_error', 'created_at', 'sent_at'], rows);
  return rows.length;
}

async function seedRelay(ctx, have) {
  if (!have.has('np_relay_state')) return 0;
  /* last_poll_at is NOW(): modules/device.connection() calls the relay
     connected only when a poll landed inside 90 seconds AND the error counter
     is zero, so a timestamp from the seed date would draw a red line on a demo
     that has just been installed. */
  await ctx.db.exec(
    `INSERT INTO np_relay_state (id, last_msg_id, last_poll_at, consecutive_errors)
     VALUES (1, ?, NOW(), 0)
     ON DUPLICATE KEY UPDATE last_msg_id=VALUES(last_msg_id), last_poll_at=NOW(), consecutive_errors=0`,
    [418_000 + Math.floor(ctx.rand() * 900)]);
  return 1;
}

/* ------------------------------------------------------------------------ */
/* 7. ÖKC                                                                   */
/* ------------------------------------------------------------------------ */

const BANKS = [
  ['Garanti BBVA', 'VISA'], ['İş Bankası', 'MASTERCARD'], ['Yapı Kredi', 'VISA'],
  ['Ziraat Bankası', 'TROY'], ['Akbank', 'MASTERCARD'], ['QNB Finansbank', 'VISA'],
  ['Vakıfbank', 'TROY'], ['Denizbank', 'MASTERCARD'],
];

/*
 * The department table the restaurant typed in. base.DEFAULT_DEPARTMENTS is
 * what the DEVICE ships with (KISIM1..KISIM12); these are the same twelve
 * slots with the names and VAT codes a kebap house would put in them, which is
 * what the ÖKC settings screen exists to do. The VAT codes are not free
 * choice: base.resolveDepartment() walks department -> vat_code -> rate, and
 * every line on this menu is 10 %, so at least one department has to carry the
 * code whose rate is 10 (that is code 2 in the device's own table).
 */
const DEPARTMENTS = [
  ['YIYECEK', 2], ['ICECEK', 2], ['TATLI', 2], ['PAKET SERVIS', 2],
  ['ALKOLLU ICECEK', 3], ['SIGARA', 3], ['KISIM7', 3], ['KISIM8', 3],
  ['KISIM9', 3], ['KISIM10', 3], ['KISIM11', 3], ['KISIM12', 3],
];

function* chunks(arr, n) { for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n); }

async function seedFiscal(ctx, have) {
  const { db, clientId, rand: r } = ctx;
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));
  const pick = (a) => a[Math.floor(r() * a.length)];
  const out = { devices: 0, transactions: 0, items: 0, events: 0, receipts: 0, reports: 0, refunds: 0 };
  if (!have.has('fiscal_devices') || !have.has('fiscal_transactions')) return out;

  const register = await db.one(
    'SELECT id FROM cash_registers WHERE client_id=? ORDER BY id LIMIT 1', [clientId]);

  /*
   * provider 'ingenico' with a MOVE 5000F is the device this product's tables
   * were read off (see adapters/base.js and the note at the top of gmp3.js).
   * Two fields are deliberately NOT what a real shop would have:
   *
   *   serial_number  obviously a demo string. A serial in the shape of a real
   *                  certified device's is a number somebody could quote at a
   *                  tax office.
   *   environment    'test', not 'production'. settings.saveDevice() refuses
   *                  production for any provider below 'beta' and Ingenico is
   *                  'sdk', so a production row here would be a row the
   *                  product's own save cannot produce.
   *
   * wire_verified stays 0 for the same reason gmp3.js refuses to drive an
   * unverified device: nobody has proven its message layer against the
   * manufacturer's document, and a seeded 1 would let the demo till put
   * invented commands on a real wire.
   */
  const deviceId = await db.insert(
    `INSERT INTO fiscal_devices (client_id, branch_id, cash_register_id, provider, device_model,
        serial_number, connection_type, device_ip, device_port, merchant_id, terminal_id,
        environment, status, status_detail, is_active, last_seen_at, created_at, updated_at,
        receipt_limit_minor, max_sale_lines, cashier_no, open_drawer, wire_verified)
     VALUES (?,1,?,'ingenico','MOVE 5000F',?,'tcp',?,4520,?,?,'test','ready',?,1,NOW(),?,NOW(),
        1200000, 40, 1, 0, 0)`,
    [clientId, register ? register.id : null, 'DEMO-OKC-0001', OKC_IP,
     'DEMO-MERCHANT', 'DEMO-TERM-01', 'Cihaz yanıt verdi (demo)',
     dt(atTime(addDays(ctx.today, -FISCAL_DAYS), 15, 10))]);
  out.devices = 1;

  if (have.has('fiscal_vat_codes')) {
    await bulk(db, 'fiscal_vat_codes', ['client_id', 'fiscal_device_id', 'vat_code', 'rate'],
      fiscalBase.DEFAULT_VAT_CODES.map(v => ({ client_id: clientId, fiscal_device_id: deviceId,
        vat_code: v.vat_code, rate: v.rate })), { ignore: true });
  }
  const depByCode = new Map();
  if (have.has('fiscal_departments')) {
    await bulk(db, 'fiscal_departments',
      ['client_id', 'fiscal_device_id', 'erp_index', 'okc_index', 'name', 'vat_code'],
      DEPARTMENTS.map(([name, vc], i) => ({ client_id: clientId, fiscal_device_id: deviceId,
        erp_index: i + 1, okc_index: i, name, vat_code: vc })), { ignore: true });
  }
  for (const [name, vc] of DEPARTMENTS) if (!depByCode.has(vc)) depByCode.set(vc, name);
  const rateToCode = new Map();
  for (const v of fiscalBase.DEFAULT_VAT_CODES) {
    if (!rateToCode.has(Number(v.rate))) rateToCode.set(Number(v.rate), v.vat_code);
  }
  const departmentFor = (rate) => depByCode.get(rateToCode.get(Number(rate) || 0)) || 'YIYECEK';

  /* ------------------------------------------------- which sales went through */
  const from = ymd(addDays(ctx.today, -FISCAL_DAYS));
  const cards = await db.query(
    `SELECT p.id AS payment_id, p.order_id, p.method, p.amount, p.created_at, p.created_by,
            o.adisyon_no, o.table_id, o.waiter_id, o.total, o.discount_total, o.vat_total,
            o.grand_total, o.business_date
       FROM order_payments p
       JOIN orders o ON o.id = p.order_id
      WHERE p.client_id=? AND o.business_date >= ? AND o.is_deleted=0 AND o.is_closed=1
        AND p.method IN ('kredi','banka')
      ORDER BY p.id`, [clientId, from]);
  if (!cards.length) return out;

  /* one transaction per BILL: the till snapshots the whole bill into the
     device sale, so a split paid with two cards would otherwise be sent to the
     ÖKC twice over with the same lines on it */
  const seenOrder = new Set();
  const rate = Math.min(1, FISCAL_TARGET / cards.length);
  const chosen = [];
  const cutoff = nowMs();
  for (const c of cards) {
    if (seenOrder.has(c.order_id)) continue;
    seenOrder.add(c.order_id);
    if (new Date(c.created_at).getTime() > cutoff) continue;   // still on the floor
    if (r() > rate) continue;
    chosen.push(c);
  }
  if (!chosen.length) return out;

  const itemsByOrder = new Map();
  for (const chunk of chunks(chosen.map(c => c.order_id), 400)) {
    const rows = await db.query(
      `SELECT i.id, i.order_id, i.product_id, i.qty, i.unit_price, i.vat_rate, i.vat_total,
              i.line_total, i.discount_amount, pr.name
         FROM order_items i LEFT JOIN products pr ON pr.id = i.product_id
        WHERE i.client_id=? AND i.is_deleted=0 AND i.order_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY i.id`, [clientId, ...chunk]);
    for (const it of rows) {
      if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
      itemsByOrder.get(it.order_id).push(it);
    }
  }

  let txId = Number(await db.value('SELECT COALESCE(MAX(id),0) FROM fiscal_transactions')) + 1;
  const txRows = [], itemRows = [], eventRows = [], receiptRows = [];
  const stamped = [];            // [payment_id, txId] - written back onto the bill
  const zByDate = new Map();     // business_date -> {z, no, total, last}
  let zNo = 412;                 // the counter the device was on when it arrived

  for (const c of chosen) {
    const items = itemsByOrder.get(c.order_id) || [];
    if (!items.length) continue;
    const started = new Date(c.created_at);
    const finished = new Date(started.getTime() + between(9, 42) * 1000);

    if (!zByDate.has(c.business_date)) {
      zByDate.set(c.business_date, { z: String(zNo++).padStart(4, '0'), no: 0, total: 0, last: finished });
    }
    const z = zByDate.get(c.business_date);

    /*
     * One card in forty does not go through: the guest's bank refuses it, the
     * cashier cancels a sale started on the wrong bill, or the device drops
     * the socket. All three are states fiscal/index.js writes, all three leave
     * the bill unpaid on the ÖKC side, and a demo where the card always works
     * cannot show the screen that says what to do when it does not.
     */
    const roll = r();
    const state = roll < 0.972 ? 'approved' : (roll < 0.984 ? 'declined' : (roll < 0.993 ? 'cancelled' : 'error'));
    const [bank, brand] = pick(BANKS);
    const amount = Number(c.amount);
    const amountMinor = minor(amount);
    const installments = r() < 0.08 ? pick([2, 3, 6]) : 0;
    const approved = state === 'approved';
    const id = txId++;

    if (approved) { z.no += 1; z.total += amountMinor; if (finished > z.last) z.last = finished; }

    txRows.push({
      id, client_id: clientId, branch_id: 1, idempotency_key: crypto.randomUUID(),
      order_id: c.order_id, order_no: c.adisyon_no, table_session_id: null, table_id: c.table_id,
      cash_register_id: register ? register.id : null, fiscal_device_id: deviceId,
      provider: 'ingenico', environment: 'test',
      cashier_id: c.created_by, waiter_id: c.waiter_id, currency: 'TRY',
      subtotal_minor: minor(c.total), discount_total_minor: minor(c.discount_total),
      service_charge_minor: 0, tax_total_minor: minor(c.vat_total),
      grand_total_minor: minor(c.grand_total), requested_amount_minor: amountMinor,
      approved_amount_minor: approved ? amountMinor : null,
      cash_received_minor: null, change_minor: null,
      payment_method: c.method,
      split_mode: amountMinor < minor(c.grand_total) ? 'partial' : 'full',
      paid_by_guest: null, state,
      provider_session_id: 'SES-' + String(id).padStart(8, '0'),
      provider_transaction_id: approved ? 'FR' + String(200000 + id * 7) : null,
      authorization_code: approved ? String(between(100000, 999999)) : null,
      bank: approved ? bank : null, card_brand: approved ? brand : null,
      card_masked: approved ? maskedCard(brand, r) : null,
      installments: approved ? installments : null,
      batch_no: approved ? String(between(1, 400)).padStart(4, '0') : null,
      stan: approved ? String(between(1, 999999)).padStart(6, '0') : null,
      error_code: approved ? null : errorCodeFor(state),
      error_message: approved ? null : errorMessageFor(state),
      /* a compact snapshot, not the whole bill: the real column holds
         JSON.stringify({order, amount}) and five hundred of those is fifteen
         megabytes of demo nobody reads */
      sale_snapshot: JSON.stringify({ order: { id: c.order_id, adisyon_no: c.adisyon_no,
        grand_total: Number(c.grand_total), lines: items.length }, amount }),
      attempt_count: 1, started_at: dt(started), state_changed_at: dt(finished),
      finished_at: dt(finished), created_by: c.created_by, created_at: dt(started),
      updated_at: dt(finished),
    });

    /* the three lines fiscal/index.js writes for every sale, plus the last one */
    eventRows.push(evt(clientId, id, c, deviceId, 'created', null, 'created', started, 0,
      { amount, method: c.method }));
    eventRows.push(evt(clientId, id, c, deviceId, 'waiting_device', 'created', 'waiting_device',
      started, 900, { sessionId: 'SES-' + String(id).padStart(8, '0') }));
    eventRows.push(evt(clientId, id, c, deviceId, state, 'waiting_device', state, finished, 0,
      approved ? { approvalCode: '******', zNo: z.z } : { error: errorMessageFor(state) }));

    if (approved) {
      const receiptNo = String(z.no).padStart(4, '0');
      for (const it of items) {
        itemRows.push({
          client_id: clientId, fiscal_transaction_id: id, order_item_id: it.id,
          product_id: it.product_id, product_name: it.name || 'Ürün', sku: null, barcode: null,
          fiscal_product_code: null, department: departmentFor(it.vat_rate),
          quantity: Number(it.qty), unit: fiscalBase.UNIT_CODES.ADET,
          unit_price_minor: minor(it.unit_price), modifier_total_minor: 0,
          discount_minor: minor(it.discount_amount), vat_rate: Number(it.vat_rate),
          vat_amount_minor: minor(it.vat_total), line_total_minor: minor(it.line_total),
          created_at: dt(finished),
        });
      }
      receiptRows.push({
        client_id: clientId, fiscal_transaction_id: id, order_id: c.order_id,
        fiscal_receipt_no: receiptNo, document_no: z.z + '-' + receiptNo, z_number: z.z,
        ekh_serial: 'DEMO-OKC-0001', fiscal_reference: 'FR' + String(200000 + id * 7),
        payment_reference: String(between(100000, 999999)),
        fiscal_timestamp: dt(finished),
        raw_response: JSON.stringify({ state: 'APPROVED', receiptNo, zNo: z.z, bank, brand }),
        created_at: dt(finished),
      });
      stamped.push([c.payment_id, id]);
    }
  }

  await bulk(db, 'fiscal_transactions', Object.keys(txRows[0] || { id: 1 }), txRows);
  out.transactions = txRows.length;
  if (have.has('fiscal_transaction_items') && itemRows.length) {
    await bulk(db, 'fiscal_transaction_items', Object.keys(itemRows[0]), itemRows);
    out.items = itemRows.length;
  }
  if (have.has('fiscal_transaction_events') && eventRows.length) {
    await bulk(db, 'fiscal_transaction_events', Object.keys(eventRows[0]), eventRows);
    out.events = eventRows.length;
  }
  if (have.has('fiscal_receipts') && receiptRows.length) {
    await bulk(db, 'fiscal_receipts', Object.keys(receiptRows[0]), receiptRows);
    out.receipts = receiptRows.length;
  }

  /* ---------------------------------------------------------- the Z reports */
  if (have.has('fiscal_device_reports')) {
    const reports = [];
    const today = ymd(ctx.today);
    for (const [date, z] of zByDate) {
      if (date === today || !z.no) continue;      // today's Z has not been taken yet
      const at = atTime(new Date(date + 'T00:00:00'), 23, between(50, 58), between(0, 59));
      reports.push({
        client_id: clientId, fiscal_device_id: deviceId, agent_id: null, report_type: 'Z',
        order_no: null, order_id: null, amount_minor: z.total, payment_method: 'CARD',
        provider_transaction_id: null, authorization_code: null, card_masked: null,
        card_brand: null, bank: null, batch_no: null, stan: null, fiscal_receipt_no: null,
        z_number: z.z, device_time: dt(at),
        /* uq_report_key is (client_id, report_key) and fiscal.deviceReport()
           does not set it, so every row it writes collides on the empty
           string. The seeder gives each report a key of its own rather than
           reproducing that. */
        report_key: 'Z-' + date + '-' + z.z,
        status: 'ok', fiscal_transaction_id: null,
        note: `Gün sonu: ${z.no} mali fiş`,
        raw: JSON.stringify({ zNo: z.z, receipts: z.no, totalMinor: z.total, date }),
        created_at: dt(at), processed_at: dt(at),
      });
    }
    if (reports.length) {
      await bulk(db, 'fiscal_device_reports', Object.keys(reports[0]), reports, { ignore: true });
      out.reports = reports.length;
    }
  }

  /* ------------------------------------------------------------- the refunds */
  if (have.has('fiscal_refunds') && receiptRows.length > 20) {
    const refunds = [], refundItems = [];
    for (const back of [3, 26]) {
      const src = receiptRows[receiptRows.length - back];
      if (!src) continue;
      const tx = txRows.find(t => t.id === src.fiscal_transaction_id);
      const lines = itemRows.filter(i => i.fiscal_transaction_id === src.fiscal_transaction_id).slice(0, 2);
      if (!tx || !lines.length) continue;
      const amount = lines.reduce((s, l) => s + Number(l.line_total_minor), 0);
      const at = new Date(new Date(tx.finished_at).getTime() + between(6, 40) * 60000);
      const rid = refunds.length + 1;
      refunds.push({
        client_id: clientId, idempotency_key: crypto.randomUUID(),
        original_fiscal_transaction_id: tx.id, order_id: tx.order_id, fiscal_device_id: deviceId,
        provider: 'ingenico', refund_type: 'partial', amount_minor: amount,
        reason: back === 3 ? 'Yanlış ürün ikram edildi' : 'Misafir şikayeti - ürün iade',
        state: 'approved', provider_refund_id: 'IADE-' + String(9000 + rid),
        error_code: null, error_message: null, restock: 0,
        requested_by: ctx.users.sevim.id, approved_by: ctx.users.erdal.id,
        created_at: dt(at), finished_at: dt(new Date(at.getTime() + 25000)),
      });
      for (const l of lines) {
        refundItems.push({ client_id: clientId, fiscal_refund_id: rid,
          fiscal_transaction_item_id: null, order_item_id: l.order_item_id,
          product_id: l.product_id, product_name: l.product_name,
          quantity: l.quantity, amount_minor: l.line_total_minor, created_at: dt(at) });
      }
    }
    if (refunds.length) {
      const firstId = Number(await db.value('SELECT COALESCE(MAX(id),0) FROM fiscal_refunds')) + 1;
      await bulk(db, 'fiscal_refunds', Object.keys(refunds[0]), refunds);
      if (have.has('fiscal_refund_items') && refundItems.length) {
        for (const it of refundItems) it.fiscal_refund_id = firstId + it.fiscal_refund_id - 1;
        await bulk(db, 'fiscal_refund_items', Object.keys(refundItems[0]), refundItems);
      }
      out.refunds = refunds.length;
    }
  }

  /* -------------------------------------- and back onto the bills they paid */
  /*
   * fiscal/index.js hands the approved sale to payments.addPayment with
   * channel 'okc' and the transaction id. The demo's payments were written by
   * trading.js before any of this existed, so they are stamped here - without
   * it the ÖKC screen and the Ödemeler screen describe two different days and
   * the first person to reconcile them finds it.
   */
  for (const group of chunks(stamped, 200)) {
    const cases = group.map(() => 'WHEN ? THEN ?').join(' ');
    const params = [];
    for (const [pid, tid] of group) params.push(pid, tid);
    await db.exec(
      `UPDATE order_payments SET fiscal_transaction_id = CASE id ${cases} END,
          payment_channel='okc'
        WHERE client_id=? AND id IN (${group.map(() => '?').join(',')})`,
      [...params, clientId, ...group.map(g => g[0])]).catch(() => {});
  }

  /* the device's own last-seen figures, from the history just written */
  const last = txRows.length ? txRows[txRows.length - 1] : null;
  if (last) {
    await db.exec('UPDATE fiscal_devices SET last_transaction_at=?, last_seen_at=? WHERE id=?',
      [last.finished_at, last.finished_at, deviceId]);
  }
  /* the ÖKC screens refuse to do anything while the switch is off */
  await db.setSetting('fiscal_enabled', '1');
  return out;
}

function maskedCard(brand, r) {
  const bin = brand === 'MASTERCARD' ? '5218' : (brand === 'TROY' ? '9792' : '4506');
  return `${bin} 88** **** ${String(1000 + Math.floor(r() * 9000))}`;
}
function errorCodeFor(state) {
  return state === 'declined' ? 'DECLINED' : (state === 'cancelled' ? 'USER_CANCEL' : 'TIMEOUT');
}
function errorMessageFor(state) {
  if (state === 'declined') return 'Kart reddedildi - bankanizla gorusun';
  if (state === 'cancelled') return 'Islem kasiyer tarafindan iptal edildi';
  return 'OKC cihazi yanit vermedi';
}
function evt(clientId, txId, c, deviceId, event, from, to, base, offsetMs, detail) {
  const at = new Date(base.getTime() + offsetMs);
  const p = (n) => String(n).padStart(2, '0');
  return {
    client_id: clientId, fiscal_transaction_id: txId, order_id: c.order_id, table_id: c.table_id,
    fiscal_device_id: deviceId, event, from_state: from, to_state: to,
    result: to === 'approved' ? 'ok' : (to === 'created' || to === 'waiting_device' ? null : 'fail'),
    amount_minor: minor(c.amount), actor_user_id: c.created_by, actor_role: 'cashier',
    actor_device: 'KASA-1', detail: JSON.stringify(detail || {}),
    created_at: `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ` +
      `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}.${String(at.getMilliseconds()).padStart(3, '0')}`,
  };
}

/* ------------------------------------------------------------------------ */
/* 8. audit_logs and deleted_activity_log - Denetim                         */
/* ------------------------------------------------------------------------ */

/*
 * Derived from the trading history rather than invented next to it. Every
 * order.delete row points at a bill that really was struck out, every
 * bill.discount at a discount that is really on a bill, and every day.close at
 * a daily_closings row - so "who deleted this adisyon" answers with the same
 * bill the Finans screen is showing rather than with a plausible number.
 *
 * ip and user_agent are ASCII on purpose: those two columns are latin1 in this
 * schema, and a Turkish character in either of them is stored as a question
 * mark.
 */
const AUDIT_IP = '192.168.1.40';
const AUDIT_UA = 'NOKTApp POS Kasa/2.0.0 (Windows)';

async function seedAudit(ctx, have) {
  const { db, clientId, rand: r } = ctx;
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));
  const pick = (a) => a[Math.floor(r() * a.length)];
  const out = { audit: 0, deleted: 0 };

  if (have.has('audit_logs')) {
    const rows = [];
    const add = (at, userId, role, action, type, id, before, after, meta) => rows.push({
      client_id: clientId, actor_client_id: userId, role, action, entity_type: type,
      entity_id: String(id),
      before_json: before ? JSON.stringify(before) : null,
      after_json: after ? JSON.stringify(after) : null,
      meta_json: meta ? JSON.stringify(meta) : null,
      ip: AUDIT_IP, user_agent: AUDIT_UA, created_at: dt(at), details: null,
    });

    /* gün sonu, for as far back as the Finans screen scrolls */
    for (const d of ctx.dayIndex.slice(-140)) {
      if (d.date === ymd(ctx.today)) continue;
      const at = atTime(new Date(d.date + 'T00:00:00'), 23, between(50, 58), between(0, 59));
      add(at, ctx.users.erdal.id, 'admin', 'day.close', 'day', d.date, null,
        { orders: d.orders.length, cash: Math.round(d.cash * 100) / 100,
          card: Math.round(d.card * 100) / 100 }, { source: 'kasa' });
    }
    /* the two mornings a day had to be opened again */
    for (const back of [37, 96]) {
      const d = ctx.dayIndex[ctx.dayIndex.length - back];
      if (!d) continue;
      const at = atTime(addDays(new Date(d.date + 'T00:00:00'), 1), 10, between(10, 40));
      add(at, ctx.users.erdal.id, 'admin', 'day.reopen', 'day', d.date,
        { orders: d.orders.length }, null, { reason: 'Eksik adisyon girildi' });
    }

    /* the bills that were struck out, as the trading part recorded them */
    const deletes = await db.query(
      `SELECT order_id, adisyon_no, deleted_at, deleted_by, reason, grand_total
         FROM order_delete_logs WHERE client_id=? ORDER BY id DESC LIMIT 120`, [clientId]);
    /* the same before/after/meta finance.deleteBill() writes. The
       'bill.delete' row next to each of these is not a duplicate and is not
       written here: trg_audit_bill_delete puts it in by itself the moment
       trading.js inserts the order_delete_logs row, and the real till ends up
       with both for one deletion. */
    for (const d of deletes) {
      add(new Date(d.deleted_at), d.deleted_by, 'admin', 'order.delete', 'order', d.order_id,
        { exclude_from_reports: 0 }, { exclude_from_reports: 1 },
        { grand_total: Number(d.grand_total), screen: 'finance/islemler', reason: d.reason });
    }

    /* the discounts somebody had to approve */
    const discounts = await db.query(
      `SELECT order_id, discount_value, reason, created_by, created_at
         FROM order_discounts WHERE client_id=? ORDER BY id DESC LIMIT 90`, [clientId]);
    for (const d of discounts) {
      add(new Date(d.created_at), d.created_by, 'cashier', 'bill.discount', 'bill', d.order_id,
        null, { amount: Number(d.discount_value), percent: null, reason: d.reason,
          approvedBy: ctx.users.erdal.id }, null);
    }

    /* the floor moves - one bill in a few hundred is carried somewhere else */
    const recent = await db.query(
      `SELECT id, table_id, waiter_id, closed_at FROM orders
        WHERE client_id=? AND is_deleted=0 AND closed_at IS NOT NULL
        ORDER BY id DESC LIMIT 600`, [clientId]);
    for (const o of recent) {
      const roll = r();
      if (roll > 0.09) continue;
      const at = new Date(new Date(o.closed_at).getTime() - between(5, 40) * 60000);
      const who = pick(ctx.cashiers);
      if (roll < 0.045) {
        add(at, who.id, 'cashier', 'bill.transfer', 'bill', o.id,
          { table_id: o.table_id }, { table_id: pick(ctx.tables).id }, null);
      } else if (roll < 0.065) {
        add(at, who.id, 'cashier', 'bill.merge', 'bill', o.id,
          { source_order_id: o.id - 1, source_table_id: o.table_id }, { target_order_id: o.id }, null);
      } else if (roll < 0.08) {
        add(at, who.id, 'cashier', 'bill.split', 'bill', o.id,
          { lines: between(1, 4) }, { new_order_id: o.id + 10000, table_id: o.table_id }, null);
      } else {
        add(at, who.id, 'cashier', 'bill.reopen', 'bill', o.id, null,
          { reason: pick(['Ödeme yanlış girildi', 'Ürün eklenecek', 'Fiş yeniden basılacak']) }, null);
      }
    }

    /* the afternoon a backup was put back */
    add(atTime(addDays(ctx.today, -46), 10, 22), ctx.users.erdal.id, 'admin', 'db.restore',
      'database', 'noktapp_pos', null,
      { file: 'noktapp-pos-restore.sql.gz', pre_restore_backup_id: 3 }, { by: 'Erdal Sarıkaya' });

    rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    await bulk(db, 'audit_logs', ['client_id', 'actor_client_id', 'role', 'action', 'entity_type',
      'entity_id', 'before_json', 'after_json', 'meta_json', 'ip', 'user_agent', 'created_at',
      'details'], rows);
    out.audit = rows.length;
  }

  if (have.has('deleted_activity_log')) {
    const rows = [];
    /* entity_id is an order_items id, not a product id - orders.cancelItem()
       logs the LINE that went back, and a product id in that column would send
       anybody following the trail to the wrong row of the wrong bill. The
       cancel events carry only the product, so the line is looked back up. */
    const cancels = await db.query(
      `SELECT c.order_id, c.product_id, c.qty, c.line_total, c.vat_rate, c.cancelled_at, p.name,
              (SELECT i.id FROM order_items i
                WHERE i.order_id = c.order_id AND i.product_id = c.product_id LIMIT 1) AS item_id
         FROM order_item_cancel_events c LEFT JOIN products p ON p.id = c.product_id
        WHERE c.client_id=? ORDER BY c.id DESC LIMIT 260`, [clientId]);
    for (const c of cancels) {
      if (!c.item_id) continue;
      rows.push({ client_id: clientId, user_id: pick(ctx.cashiers).id, entity_type: 'item',
        entity_id: c.item_id,
        json_data: JSON.stringify({ id: c.item_id, order_id: c.order_id, product_id: c.product_id,
          product_name: c.name, cancelQty: Number(c.qty), line_total: Number(c.line_total),
          vat_rate: Number(c.vat_rate) }),
        reason: pick(['Müşteri vazgeçti', 'Yanlış tuşlandı', 'Mutfak yetiştiremedi',
          'Ürün bitti', 'Yanlış masaya girildi']),
        created_at: dt(new Date(c.cancelled_at)) });
    }
    const deletes = await db.query(
      `SELECT order_id, adisyon_no, grand_total, deleted_at, deleted_by, reason
         FROM order_delete_logs WHERE client_id=? ORDER BY id DESC LIMIT 60`, [clientId]);
    for (const d of deletes) {
      rows.push({ client_id: clientId, user_id: d.deleted_by || 0, entity_type: 'order',
        entity_id: d.order_id,
        json_data: JSON.stringify({ adisyon_no: d.adisyon_no,
          grand_total: Number(d.grand_total) }),
        reason: d.reason, created_at: dt(new Date(d.deleted_at)) });
    }
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    await bulk(db, 'deleted_activity_log',
      ['client_id', 'user_id', 'entity_type', 'entity_id', 'json_data', 'reason', 'created_at'],
      rows);
    out.deleted = rows.length;
  }
  return out;
}

/* ------------------------------------------------------------------------ */

async function build(ctx) {
  const have = await tableSet(ctx.db);
  /* every section is hung on the trading history; without it there is nothing
     here worth writing and several of them would index into nothing */
  if (!ctx.dayIndex || !ctx.dayIndex.length) { ctx.log('sistem: ticaret yok, bölüm atlandı'); return; }

  const logs = await seedAppLog(ctx, have);
  ctx.log(`sistem: ${logs.toLocaleString('tr-TR')} günlük satırı`);

  const jobs = await seedPrintJobs(ctx, have);
  const dev = await seedDevices(ctx, have);
  ctx.log(`sistem: ${jobs} yazdırma işi, ${dev.tokens} cihaz oturumu, ` +
    `${dev.numbers} adisyon ön eki, ${dev.pairings || 0} eşleştirme kaydı`);

  const backups = await seedBackups(ctx, have);
  const settings = await seedSettingsLog(ctx, have);
  const outbox = await seedOutbox(ctx, have);
  await seedRelay(ctx, have);
  ctx.log(`sistem: ${backups} yedek, ${settings} ayar değişikliği, ${outbox} senkron kaydı`);

  const okc = await seedFiscal(ctx, have);
  if (okc.devices) {
    ctx.log(`ÖKC: ${okc.transactions.toLocaleString('tr-TR')} mali işlem, ` +
      `${okc.receipts.toLocaleString('tr-TR')} fiş, ${okc.reports} Z raporu, ${okc.refunds} iade`);
  } else {
    ctx.log('ÖKC: mali tablolar yok, bölüm atlandı');
  }

  const audit = await seedAudit(ctx, have);
  ctx.log(`sistem: ${audit.audit} denetim kaydı, ${audit.deleted} silinen işlem kaydı`);
}

module.exports = { build };
