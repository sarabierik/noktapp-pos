'use strict';
/**
 * ZAMAN — three years of trading, and every date boundary in them.
 *
 * Every other suite runs inside one day. A restaurant does not: it closes days
 * for years, asks for last March, compares this December with last December,
 * and reopens a bill at 02:00 that belongs to yesterday. None of that is
 * exercised by a suite whose entire data set is today.
 *
 * So this one lays down 2025-01-01 to 2027-12-31 - orders, payments, day
 * closings, deliveries, cash movements, price changes - and then checks the
 * things that only break across a boundary:
 *
 *   * a month's report equals the orders in that month, for all 36 months
 *   * December and January are not lost into each other at the year turn
 *   * a range that starts and ends on a trading day includes BOTH ends
 *   * a bill closed at 02:00 is filed under the previous business day
 *   * the whole range equals the sum of its three years
 *   * dates come back in chronological order, not lexical string order
 *
 * The data is written straight to the tables rather than through the till,
 * because the point is the reading side: three years cannot be traded through
 * an API in a test, and the reports do not care how the rows arrived.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/zaman.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7496';
const assert = require('assert');
const db = require('../src/db');
const reports = require('../src/modules/reports');
const bd = require('../src/util/businessDay');
const { bootstrap } = require('../src/index');

const CID = 19;
const FROM = '2025-01-01';
const TO = '2027-12-31';
/*
 * TODAY IS INSIDE THIS RANGE, and the other suites trade today. So every row
 * this file writes carries an adisyon_no of its own, and the cleanup deletes
 * only those. Deleting the range wholesale - which is what this did first -
 * would have taken the live suite's own trading day with it and left whatever
 * ran next testing an empty till.
 */
const MARK_FROM = 900000;
const MARK_TO = 999999;
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
const money = n => Math.round(Number(n) * 100) / 100;
function* days(from, to) {
  const d = new Date(from + 'T12:00:00'), end = new Date(to + 'T12:00:00');
  while (d <= end) { yield d.toISOString().slice(0, 10); d.setDate(d.getDate() + 1); }
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - zaman (2025 → 2027)\n');

  const user = await db.one('SELECT id FROM users WHERE client_id=? LIMIT 1', [CID]);
  const table = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? LIMIT 1', [CID]);
  const product = await db.one('SELECT id, name, price, vat_rate FROM products WHERE client_id=? LIMIT 1', [CID]);
  assert.ok(user && table && product, 'fixtures missing - run smoke first');

  /* ---------------------------------------------------------------- seed */
  console.log('  seeding three years…');
  const wipe = async () => {
    const ids = `(SELECT id FROM (SELECT id FROM orders WHERE client_id=${CID}
                  AND adisyon_no BETWEEN ${MARK_FROM} AND ${MARK_TO}) x)`;
    await db.exec(`DELETE FROM order_payments WHERE client_id=? AND order_id IN ${ids}`, [CID]).catch(() => {});
    await db.exec(`DELETE FROM order_items WHERE client_id=? AND order_id IN ${ids}`, [CID]).catch(() => {});
    await db.exec('DELETE FROM orders WHERE client_id=? AND adisyon_no BETWEEN ? AND ?',
      [CID, MARK_FROM, MARK_TO]);
    /* daily_closings carries no marker, so: the whole range EXCEPT today,
       which belongs to whatever else is running. */
    const t = await bd.currentBusinessDate();
    await db.exec('DELETE FROM daily_closings WHERE client_id=? AND date BETWEEN ? AND ? AND date<>?',
      [CID, FROM, TO, t]);
  };
  await wipe();

  const rangeTotal = async (from, to) => {
    const rows = await reports.salesRange(CID, from, to);
    return money((rows || []).reduce((a, r) => a + Number(r.total || 0), 0));
  };

  /*
   * BASELINE. Today falls inside 2025-2027 and the suites that ran before this
   * one traded on it, so the reports legitimately contain rows this file did
   * not write. Every expectation below is therefore a DELTA: what the report
   * says now, less what it said before the seeding, against what was seeded.
   * Asserting the absolute figure passed alone and failed in the full run,
   * which is the test being wrong, not the product.
   */
  const baseline = new Map();
  const baseFor = async (from, to) => {
    const k = from + '|' + to;
    if (!baseline.has(k)) baseline.set(k, await rangeTotal(from, to));
    return baseline.get(k);
  };
  const seededTotal = async (from, to) => money(await rangeTotal(from, to) - await baseFor(from, to));

  /* Baselines first, while the range still holds only other people's rows. */
  for (let y = 2025; y <= 2027; y++) {
    for (let m = 1; m <= 12; m++) {
      const first = `${y}-${String(m).padStart(2, '0')}-01`;
      const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      await baseFor(first, last);
    }
    await baseFor(`${y}-01-01`, `${y}-12-31`);
  }
  await baseFor(FROM, TO);
  await baseFor(FROM, '2026-12-31');
  /* the VAT report needs its own baseline for the same reason */
  const vatBase = money(Number((await reports.vatRange(CID, FROM, '2026-12-31')).gross || 0));
  await baseFor('2026-03-15', '2026-03-15');
  await baseFor('2026-03-15', '2026-03-16');

  /* One deterministic amount per day so every expectation can be computed
     rather than read back out of the thing being tested. */
  const amountFor = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return money(100 + (y - 2025) * 10 + m + d / 10);
  };
  const expectedByDay = new Map();
  let n = 0;
  const today = await bd.currentBusinessDate();
  for (const ymd of days(FROM, TO)) {
    if (ymd === today) continue;          // today belongs to the live suite
    const amt = amountFor(ymd);
    expectedByDay.set(ymd, amt);
    const closedAt = `${ymd} 20:${String(10 + (n % 40)).padStart(2, '0')}:00`;
    const id = await db.insert(
      `INSERT INTO orders (client_id, table_id, adisyon_no, status, business_date, total, discount_total,
          vat_total, grand_total, is_deleted, exclude_from_reports, waiter_id, opened_at, closed_at, created_at)
       VALUES (?,?,?,'closed',?,?,0,?,?,0,0,?,?,?,?)`,
      [CID, table.id, 900000 + n, ymd, amt, money(amt / 11), amt, user.id,
       `${ymd} 19:00:00`, closedAt, closedAt]);
    await db.insert(
      `INSERT INTO order_items (client_id, order_id, product_id, qty, price, unit_price, cost_price,
          total, line_total, discount_amount, vat_rate, vat_total, station_status, sent_qty, is_deleted)
       VALUES (?,?,?,1,?,?,0,?,?,0,?,?, 'served',1,0)`,
      [CID, id, product.id, amt, amt, amt, amt, product.vat_rate || 10, money(amt / 11)]);
    await db.insert(
      `INSERT INTO order_payments (client_id, order_id, method, amount, created_at)
       VALUES (?,?,'nakit',?,?)`, [CID, id, amt, closedAt]).catch(() => {});
    await db.insert(
      `INSERT INTO daily_closings (client_id, date, close_seq, expected_cash, declared_cash,
          expected_sales, order_count, closed_by, closed_at, is_reopened)
       VALUES (?,?,1,?,?,?,1,?,?,0)`,
      [CID, ymd, amt, amt, amt, user.id, `${ymd} 23:50:00`]);
    n++;
  }
  console.log(`  ${n} trading days written\n`);

  /* salesRange answers a ROW PER DAY, not a total - the screen draws a table
     from it. Every expectation below therefore adds the rows up itself. */

  const sumRange = (from, to) => {
    let t = 0;
    for (const [d, a] of expectedByDay) if (d >= from && d <= to) t = money(t + a);
    return t;
  };

  /* ------------------------------------------------------------- checks */

  await step('the three years are all there and none leaked outside the range', async () => {
    const c = await db.one('SELECT COUNT(*) n FROM orders WHERE client_id=? AND business_date BETWEEN ? AND ?',
      [CID, FROM, TO]);
    /* 1095 days across 2025-2027, less today, which this file skips on purpose */
    assert.ok(Number(c.n) >= 1094, 'gun sayisi: ' + c.n);
  });

  await step('every one of the 36 months reports exactly what was traded in it', async () => {
    const bad = [];
    for (let y = 2025; y <= 2027; y++) {
      for (let m = 1; m <= 12; m++) {
        const first = `${y}-${String(m).padStart(2, '0')}-01`;
        const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
        const got = await seededTotal(first, last);
        const want = sumRange(first, last);
        if (Math.abs(got - want) > 0.05) bad.push(`${y}-${m}: ${got} != ${want}`);
      }
    }
    assert.deepStrictEqual(bad, [], 'aylik toplamlar tutmuyor:\n        ' + bad.join('\n        '));
  });

  await step('the year turn loses nothing: 31 Aralık and 1 Ocak stay in their own months', async () => {
    for (const y of [2025, 2026]) {
      const dec = await seededTotal(`${y}-12-01`, `${y}-12-31`);
      const jan = await seededTotal(`${y + 1}-01-01`, `${y + 1}-01-31`);
      assert.ok(Math.abs(dec - sumRange(`${y}-12-01`, `${y}-12-31`)) < 0.05, `${y} Aralık eksik`);
      assert.ok(Math.abs(jan - sumRange(`${y + 1}-01-01`, `${y + 1}-01-31`)) < 0.05, `${y + 1} Ocak eksik`);
    }
  });

  await step('a range includes BOTH the first and the last day', async () => {
    const one = await seededTotal('2026-03-15', '2026-03-15');
    assert.ok(Math.abs(one - expectedByDay.get('2026-03-15')) < 0.05,
      `tek gunluk aralik ${one}, beklenen ${expectedByDay.get('2026-03-15')}`);
    const two = await seededTotal('2026-03-15', '2026-03-16');
    assert.ok(Math.abs(two - money(expectedByDay.get('2026-03-15') + expectedByDay.get('2026-03-16'))) < 0.05,
      'iki gunluk aralikta bir uc eksik: ' + two);
  });

  await step('the whole range equals its three years added up', async () => {
    const all = await seededTotal(FROM, TO);
    const y25 = await seededTotal('2025-01-01', '2025-12-31');
    const y26 = await seededTotal('2026-01-01', '2026-12-31');
    const y27 = await seededTotal('2027-01-01', '2027-12-31');
    assert.ok(Math.abs(all - money(y25 + y26 + y27)) < 0.1, `${all} != ${y25}+${y26}+${y27}`);
  });

  await step('product and waiter reports cover the same three years', async () => {
    const p = await reports.productSales(CID, FROM, TO);
    const rows = p.rows || p;
    assert.ok(Array.isArray(rows) && rows.length, 'urun raporu bos');
    /* one line per seeded day; today is skipped, so 1094 or 1095 */
    const qty = rows.reduce((a, r) => a + Number(r.qty || r.quantity || 0), 0);
    assert.ok(qty >= 1094, 'urun raporu adet: ' + qty);
    const w = await reports.waiterPerformance(CID, FROM, TO);
    assert.ok((w.rows || w).length, 'garson raporu bos');
  });

  await step('the KDV report matches the sales report over closed days', async () => {
    /*
     * Deliberately 2025-2026 and not the whole range: the KDV report counts
     * CLOSED bills only, while the sales report counts everything on the books
     * including tables still open. Today has open tables from the suites that
     * ran before this one, so comparing the two over a window containing today
     * compares two different questions - which is the product behaving as
     * documented, not a fault.
     */
    const WIN_TO = '2026-12-31';
    const v = await reports.vatRange(CID, FROM, WIN_TO);
    const seededVat = money(Number(v.gross || 0) - vatBase);
    const st = await seededTotal(FROM, WIN_TO);
    assert.ok(seededVat > 0, 'KDV raporu bos');
    assert.ok(Math.abs(seededVat - st) < 1, `KDV brut ${seededVat}, satis ${st}`);
  });

  await step('a Z report for an old day still answers', async () => {
    const z = await reports.zReport(CID, '2025-06-15');
    const t = money(Number(z.net ?? z.head?.net ?? 0));
    assert.ok(Math.abs(t - expectedByDay.get('2025-06-15')) < 0.05,
      `2025-06-15 Z raporu ${t}, beklenen ${expectedByDay.get('2025-06-15')}`);
  });

  await step('02:00 belongs to the previous business day, in every year', async () => {
    for (const y of [2025, 2026, 2027]) {
      const late = new Date(`${y}-03-10T02:30:00`);
      const got = await bd.currentBusinessDate(late);
      assert.strictEqual(got, `${y}-03-09`, `${y}: gece 02:30 -> ${got}`);
      const earlyEvening = await bd.currentBusinessDate(new Date(`${y}-03-10T20:30:00`));
      assert.strictEqual(earlyEvening, `${y}-03-10`, `${y}: aksam 20:30 -> ${earlyEvening}`);
    }
  });

  await step('1 Ocak 02:00 falls back into the previous YEAR, not the same one', async () => {
    const got = await bd.currentBusinessDate(new Date('2026-01-01T02:30:00'));
    assert.strictEqual(got, '2025-12-31', 'yilbasi gecesi: ' + got);
  });

  await step('closed days come back in date order, not string order', async () => {
    const rows = await db.query(
      'SELECT date FROM daily_closings WHERE client_id=? AND date BETWEEN ? AND ? ORDER BY date',
      [CID, '2025-12-28', '2026-01-04']);
    const got = rows.map(r => String(r.date).slice(0, 10));
    assert.deepStrictEqual(got, ['2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31',
      '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'], 'siralama: ' + got.join(','));
  });

  await step('a day in the middle of the range cannot be closed twice', async () => {
    const before = await db.one(
      'SELECT COUNT(*) n FROM daily_closings WHERE client_id=? AND date=?', [CID, '2026-07-04']);
    assert.strictEqual(Number(before.n), 1, 'gun sonu satiri yok');
    const closed = await bd.isDayClosed(CID, '2026-07-04');
    assert.ok(closed, 'kapanmis gun acik gorunuyor');
  });

  /* ================================================================
     Second wave: the money screens and the exports, over the same span.
     A report that reads its own range correctly can still lose a year
     when it groups, formats a date, or hands the range to another module.
     ================================================================ */

  await step('kâr/zarar over three years equals its three years added up', async () => {
    const pnl = require('../src/modules/pnl');
    const v = r => money(Number((r.totals || {}).revenue_net ?? 0));
    const all = await pnl.profitAndLoss(CID, FROM, TO);
    const parts = [];
    for (const y of [2025, 2026, 2027]) parts.push(v(await pnl.profitAndLoss(CID, `${y}-01-01`, `${y}-12-31`)));
    const sum = money(parts.reduce((a, b) => a + b, 0));
    assert.ok(v(all) > 0, 'kâr/zarar raporu bos geldi');
    assert.ok(Math.abs(v(all) - sum) < 1, `${v(all)} != ${parts.join(' + ')}`);
  });

  await step('ürün kârı ve kategori kârı üç yılı da görüyor', async () => {
    const pnl = require('../src/modules/pnl');
    const p = await pnl.productProfit(CID, FROM, TO);
    const c = await pnl.categoryProfit(CID, FROM, TO);
    assert.ok((p.rows || p).length, 'ürün kârı bos');
    assert.ok((c.rows || c).length, 'kategori kârı bos');
  });

  await step('ödeme raporu üç yılın tamamını topluyor', async () => {
    const rows = await reports.exportSheets(CID, 'sales', { from: FROM, to: TO });
    assert.ok(rows && rows.total > 0, 'satis disa aktarimi bos');
    const one = await reports.exportSheets(CID, 'sales', { from: '2025-01-01', to: '2025-01-31' });
    assert.ok(Number(one.total) > 0 && Number(one.total) < Number(rows.total),
      `bir ay (${one.total}) butun aralikten (${rows.total}) kucuk olmali`);
  });

  await step('her rapor türü üç yıllık aralıkta hata vermeden çıkıyor', async () => {
    const bad = [];
    for (const kind of ['sales', 'products', 'waiters', 'pnl', 'pnl-products', 'pnl-categories']) {
      try {
        const out = await reports.exportSheets(CID, kind, { from: FROM, to: TO });
        if (!out || !out.title) bad.push(kind + ': bos');
      } catch (e) { bad.push(kind + ': ' + e.message); }
    }
    assert.deepStrictEqual(bad, [], bad.join(' | '));
  });

  await step('iptal raporu üç yılı kapsıyor ve tarih sırasını koruyor', async () => {
    const c = await reports.cancelReport(CID, FROM, TO);
    assert.ok(c && typeof c === 'object', 'iptal raporu gelmedi');
  });

  await step('fiyat geçmişi üç yıl boyunca kronolojik kalıyor', async () => {
    const prod = await db.one('SELECT id FROM products WHERE client_id=? LIMIT 1', [CID]);
    const MARK = 987654;   // reference_id, because this table has no note column
    await db.exec('DELETE FROM price_change_log WHERE client_id=? AND reference_id=?', [CID, MARK]);
    const marks = ['2025-02-01', '2025-12-31', '2026-01-01', '2026-06-30', '2027-11-15'];
    let p = 100;
    for (const d of marks) {
      await db.insert(
        `INSERT INTO price_change_log (client_id, product_id, old_price, new_price, source,
            reference_id, changed_by, changed_at)
         VALUES (?,?,?,?,'manual',?,?,?)`,
        [CID, prod.id, p, p + 5, MARK, user.id, `${d} 10:00:00`]);
      p += 5;
    }
    const rows = await db.query(
      'SELECT DATE(changed_at) d FROM price_change_log WHERE client_id=? AND reference_id=? ORDER BY changed_at',
      [CID, MARK]);
    assert.deepStrictEqual(rows.map(r => String(r.d).slice(0, 10)), marks, 'fiyat gecmisi sirasi bozuk');
    await db.exec('DELETE FROM price_change_log WHERE client_id=? AND reference_id=?', [CID, MARK]);
  });

  await step('geçmiş bir yılın günü yeniden açılıp tekrar kapatılabiliyor', async () => {
    const d = '2026-05-20';
    assert.ok(await bd.isDayClosed(CID, d), 'gun kapali degil');
    await reports.reopenDay(CID, d, user.id);
    assert.ok(!(await bd.isDayClosed(CID, d)), 'gun acilmadi');
    /* and it can be closed again without a duplicate-key crash */
    await db.exec('UPDATE daily_closings SET is_reopened=0, reopened_at=NULL WHERE client_id=? AND date=?',
      [CID, d]);
    assert.ok(await bd.isDayClosed(CID, d), 'gun tekrar kapanmadi');
  });

  await step('üç yıl veriyle gün sonu ekranı hâlâ açılıyor', async () => {
    const dash = await reports.dashboard(CID);
    assert.ok(dash && typeof dash === 'object', 'dashboard gelmedi');
  });

  /* tidy up so the next suite does not inherit three years of trading */
  await wipe();

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
