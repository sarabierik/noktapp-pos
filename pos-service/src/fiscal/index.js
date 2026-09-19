'use strict';
/**
 * ÖKC orchestration.
 *
 * Flow of one fiscal payment:
 *   1. the cashier presses "Öde"      -> beginSale() writes a fiscal_transactions
 *                                        row in state 'created' and locks the bill
 *   2. the adapter is asked to start  -> state 'waiting_device', the customer
 *                                        taps the card on the ÖKC
 *   3. a poller follows the device    -> 'approved' | 'declined' | 'cancelled'
 *   4. on approval the fiscal receipt is stored and the payment is written onto
 *      the bill, which then closes itself if nothing is left to pay.
 *
 * The bill lock (order_payment_locks) is what stops two cashiers, or a cashier
 * and a waiter's phone, from starting two device sales for the same bill.
 */
const crypto = require('crypto');
const db = require('../db');
const log = require('../logger');
const payments = require('../modules/payments');
const { minor, money } = require('../util/http');
const { SimulatorAdapter } = require('./adapters/simulator');
const brands = require('./adapters/brands');
const engelli = require('./adapters/engelli');
const yetenek = require('./yetenek');

/*
 * Every fiscal owner in the GİB register resolves to SOMETHING.
 *
 * The blocked adapters come first so that a fiscal owner we have not
 * integrated cannot silently fall through to SimulatorAdapter and report a
 * successful sale that never happened. The named routes below deliberately
 * overwrite their blocked entries — they are the ones with a started
 * implementation, still gated by fiscal_devices.wire_verified in gmp3.js.
 */
const ADAPTERS = {
  ...engelli.blockedAdapters(),
  simulator: SimulatorAdapter,
  ingenico: brands.IngenicoAdapter,
  hugin: brands.HuginAdapter,
  profilo: brands.ProfiloAdapter,
  token: brands.TokenAdapter,
  beko: brands.BekoAdapter,
  olivetti: brands.OlivettiAdapter,
};

/**
 * Everything that must be true before a device may be asked for money.
 *
 * Checked BEFORE the transaction row is written, so a refusal leaves no
 * half-open sale behind and no lock to clean up. Each failure names the exact
 * reason; "cihaz hazir degil" on its own is a support call nobody can answer.
 */
async function assertDispatchAllowed(clientId, device, { workflow = 'SALE', tenderKinds = [] } = {}) {
  if (String(device.environment || '').toLowerCase() === 'simulator'
      || String(device.provider || '').toLowerCase() === 'simulator') {
    return;                     // the simulator is allowed, and says so on every receipt
  }
  if (device.quarantine_reason) {
    const e = new Error(
      `Bu OKC karantinada: ${device.quarantine_reason}. Cozulmemis bir islem var; `
      + 'once Ayarlar > OKC ekranindan mutabakati tamamlayin.');
    e.status = 409; e.code = 'DEVICE_QUARANTINED'; throw e;
  }
  if (!device.production_enabled) {
    const e = new Error(
      'Bu OKC uretim icin acilmadi. Cihaz tanimli, fakat mali islem yapabilmesi icin '
      + 'yetenek kaniti girilip Ayarlar > OKC ekranindan uretime acilmasi gerekiyor.');
    e.status = 409; e.code = 'PRODUCTION_NOT_ENABLED'; throw e;
  }
  await yetenek.assertAllowed(clientId, device.id, { workflow, tenderKinds });
}

function adapterFor(device) {
  const Klass = ADAPTERS[String(device.provider || 'simulator').toLowerCase()] || SimulatorAdapter;
  return new Klass(device);
}

async function activeDevice(clientId, cashRegisterId = null) {
  let d = null;
  if (cashRegisterId) {
    d = await db.one('SELECT * FROM fiscal_devices WHERE client_id=? AND cash_register_id=? AND is_active=1 LIMIT 1',
      [clientId, cashRegisterId]);
  }
  if (!d) d = await db.one('SELECT * FROM fiscal_devices WHERE client_id=? AND is_active=1 ORDER BY id LIMIT 1', [clientId]);
  return d;
}

async function isEnabled(clientId) {
  return String(await db.getSetting('fiscal_enabled', '0')) === '1';
}

/**
 * Nothing in here touches a device while ÖKC is switched off.
 *
 * `isEnabled` existed and was exported and NOTHING ever called it, so
 * `fiscal_enabled` was a setting that described the screens and governed
 * nothing: a till with the switch off, one leftover row in fiscal_devices and
 * any caller of /fiscal/pay - the phone app, a saved link, a stale tab - would
 * still have opened a card session on a machine the restaurant had decided it
 * was not using, locked the bill against it for three minutes and waited.
 *
 * A refusal rather than a silent no-op: a payment that quietly does not happen
 * is how a table walks out unpaid. The wording is the one the owner can act on,
 * because "kapalı" with no address is a support call.
 */
async function requireEnabled(clientId) {
  if (await isEnabled(clientId)) return;
  const e = new Error('ÖKC ile ödeme kapalı. Ayarlar → İşletme → Genel ayarlar\'dan açabilirsiniz.');
  e.status = 400;
  throw e;
}

/* ----------------------------- devices ---------------------------- */
async function listDevices(clientId) {
  return db.query('SELECT * FROM fiscal_devices WHERE client_id=? ORDER BY id', [clientId]);
}

async function saveDevice(clientId, data) {
  if (data.id) {
    await db.exec(
      `UPDATE fiscal_devices SET cash_register_id=?, provider=?, device_model=?, serial_number=?,
          connection_type=?, device_ip=?, device_port=?, merchant_id=?, terminal_id=?,
          environment=?, is_active=?, updated_at=NOW() WHERE id=? AND client_id=?`,
      [data.cash_register_id || null, data.provider, data.device_model || null, data.serial_number || '',
       data.connection_type || 'tcp', data.device_ip || null, data.device_port || null,
       data.merchant_id || null, data.terminal_id || null, data.environment || 'production',
       data.is_active === false ? 0 : 1, data.id, clientId]);
    return data.id;
  }
  return db.insert(
    `INSERT INTO fiscal_devices (client_id, branch_id, cash_register_id, provider, device_model, serial_number,
        connection_type, device_ip, device_port, merchant_id, terminal_id, environment, status, is_active, created_at, updated_at)
     VALUES (?,1,?,?,?,?,?,?,?,?,?,?, 'unknown', 1, NOW(), NOW())`,
    [clientId, data.cash_register_id || null, data.provider, data.device_model || null, data.serial_number || '',
     data.connection_type || 'tcp', data.device_ip || null, data.device_port || null,
     data.merchant_id || null, data.terminal_id || null, data.environment || 'production']);
}

/**
 * The VAT and department tables THIS device holds.
 *
 * Seeded once from the manufacturer defaults, then owned by the customer -
 * the ÖKC settings screen edits these rows and pushes them to the device. The
 * till reads them here rather than guessing a department from a rate, which is
 * what it used to do and what put lines in the wrong tax band.
 */
async function deviceTables(clientId, device) {
  const base = require('./adapters/base');
  let vatCodes = await db.query(
    'SELECT vat_code, rate FROM fiscal_vat_codes WHERE fiscal_device_id=? ORDER BY vat_code', [device.id]);
  if (!vatCodes.length) {
    for (const v of base.DEFAULT_VAT_CODES) {
      await db.exec(
        'INSERT IGNORE INTO fiscal_vat_codes (client_id, fiscal_device_id, vat_code, rate) VALUES (?,?,?,?)',
        [clientId, device.id, v.vat_code, v.rate]);
    }
    vatCodes = base.DEFAULT_VAT_CODES.slice();
  }
  let departments = await db.query(
    'SELECT erp_index, okc_index, name, vat_code FROM fiscal_departments WHERE fiscal_device_id=? ORDER BY erp_index',
    [device.id]);
  if (!departments.length) {
    for (const d of base.DEFAULT_DEPARTMENTS) {
      await db.exec(
        `INSERT IGNORE INTO fiscal_departments (client_id, fiscal_device_id, erp_index, okc_index, name, vat_code)
         VALUES (?,?,?,?,?,?)`,
        [clientId, device.id, d.erp_index, d.okc_index, d.name, d.vat_code]);
    }
    departments = base.DEFAULT_DEPARTMENTS.slice();
  }
  return { vatCodes, departments };
}

async function testDevice(clientId, deviceId) {
  const d = await db.one('SELECT * FROM fiscal_devices WHERE id=? AND client_id=?', [deviceId, clientId]);
  if (!d) { const e = new Error('Cihaz bulunamadi'); e.status = 404; throw e; }
  const a = adapterFor(d);
  const conn = await a.connect();
  const st = await a.status();
  await db.exec('UPDATE fiscal_devices SET status=?, status_detail=?, last_seen_at=NOW() WHERE id=?',
    [st.state, JSON.stringify(conn.device || {}).slice(0, 250), deviceId]);
  return { connect: conn, status: st };
}

/* ------------------------------ locks ----------------------------- */
async function acquireLock(clientId, orderId, userId, deviceId, reason = 'fiscal') {
  const token = crypto.randomUUID();
  // scoped: this used to sweep every tenant's expired locks off the table
  await db.exec('DELETE FROM order_payment_locks WHERE client_id=? AND expires_at < NOW()', [clientId]);
  const existing = await db.one('SELECT * FROM order_payment_locks WHERE client_id=? AND order_id=?', [clientId, orderId]);
  if (existing) { const e = new Error('Bu adisyon icin baska bir odeme islemi devam ediyor'); e.status = 409; throw e; }
  /*
   * The check above is not the guard - uq_lock_order is. Two cashiers pressing
   * "Ode" on the same bill in the same second both saw no lock, and the loser
   * got a raw "Duplicate entry" out of the driver instead of the sentence that
   * explains what is happening. Same refusal, either way in.
   */
  try {
    await db.exec(
      `INSERT INTO order_payment_locks (client_id, order_id, lock_token, reason, locked_by_user_id, locked_by_device, acquired_at, expires_at)
       VALUES (?,?,?,?,?,?,NOW(), DATE_ADD(NOW(), INTERVAL 3 MINUTE))`,
      [clientId, orderId, token, reason, userId || null, deviceId || null]);
  } catch (err) {
    if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
      const e = new Error('Bu adisyon icin baska bir odeme islemi devam ediyor'); e.status = 409; throw e;
    }
    throw err;
  }
  return token;
}
async function releaseLock(clientId, orderId) {
  await db.exec('DELETE FROM order_payment_locks WHERE client_id=? AND order_id=?', [clientId, orderId]);
}

/* ------------------------------ sale ------------------------------ */
async function beginSale(clientId, orderId, { method, amount, installments = 0, userId, cashRegisterId = null, deviceId = null }) {
  await requireEnabled(clientId);
  const orders = require('../modules/orders');
  const order = await orders.getOrder(clientId, orderId);
  if (!order) { const e = new Error('Adisyon bulunamadi'); e.status = 404; throw e; }
  const device = await activeDevice(clientId, cashRegisterId);
  if (!device) { const e = new Error('Tanimli OKC cihazi yok'); e.status = 400; throw e; }
  /*
   * Refuse here, before any row is written and before the bill is locked. A
   * device that is not production-enabled, is quarantined, or has no verified
   * capability for this tender must never reach the point of having an open
   * transaction attached to it.
   */
  await assertDispatchAllowed(clientId, device, {
    workflow: 'SALE',
    tenderKinds: [String(method || '').toUpperCase() === 'CASH' ? 'CASH' : 'CARD'],
  });

  const amt = money(amount || order.due);
  const idem = crypto.createHash('sha256')
    .update(`${clientId}:${orderId}:${amt}:${method}:${Date.now()}`).digest('hex').slice(0, 36);
  const lock = await acquireLock(clientId, orderId, userId, deviceId);

  const txId = await db.insert(
    `INSERT INTO fiscal_transactions (client_id, branch_id, idempotency_key, order_id, order_no, table_id,
        cash_register_id, fiscal_device_id, provider, environment, cashier_id, waiter_id, currency,
        subtotal_minor, discount_total_minor, tax_total_minor, grand_total_minor, requested_amount_minor,
        payment_method, split_mode, state, sale_snapshot, attempt_count, started_at, state_changed_at, created_by, created_at, updated_at)
     VALUES (?,1,?,?,?,?,?,?,?,?,?,?,'TRY',?,?,?,?,?,?,?, 'created', ?, 0, NOW(), NOW(), ?, NOW(), NOW())`,
    [clientId, idem, orderId, order.adisyon_no, order.table_id, device.cash_register_id, device.id,
     device.provider, device.environment || 'production', userId || null, order.waiter_id,
     minor(order.total), minor(order.discount_total), minor(order.vat_total), minor(order.grand_total),
     minor(amt), method, amt < order.due ? 'partial' : 'full',
     JSON.stringify({ order, amount: amt }), userId || null]);
  await event(clientId, txId, 'created', { amount: amt, method });

  try {
    const adapter = adapterFor(device);
    const tables = await deviceTables(clientId, device);
    const base = require('./adapters/base');
    const sale = {
      externalId: String(txId),
      items: order.items.map(i => {
        const dep = base.resolveDepartment(i.vat_rate, tables);
        return {
          name: i.product_name, qty: Number(i.qty),
          unitPriceMinor: minor(i.unit_price), vatRate: Number(i.vat_rate || 0),
          /* the index the DEVICE counts from, and the unit it knows */
          department: dep.okc_index, departmentName: dep.name, vatCode: dep.vat_code,
          unit: base.unitFor(i.unit),
        };
      }),
      totalMinor: minor(amt),
      discountMinor: minor(order.discount_total),
      payment: { method, amountMinor: minor(amt), installments },
    };
    /*
     * The device's own limits, checked here rather than discovered by the
     * device refusing mid-sale with the guest standing at the counter. Both
     * numbers come off the ÖKC settings screen and are per-device.
     */
    if (sale.items.length > Number(device.max_sale_lines || 40)) {
      const e = new Error(`OKC tek fiste en fazla ${device.max_sale_lines || 40} satir kabul ediyor `
        + `(bu adisyonda ${sale.items.length} satir var). Adisyonu bolun.`);
      e.status = 400; throw e;
    }
    if (Number(sale.totalMinor) > Number(device.receipt_limit_minor || 1200000)) {
      const e = new Error('Tutar OKC fis limitinin ustunde ('
        + (Number(device.receipt_limit_minor || 1200000) / 100).toFixed(2) + ' TL). Odemeyi bolun.');
      e.status = 400; throw e;
    }
    const started = await adapter.startSale(sale);
    await db.exec(
      "UPDATE fiscal_transactions SET state='waiting_device', provider_session_id=?, state_changed_at=NOW(), attempt_count=attempt_count+1 WHERE id=?",
      [started.providerSessionId, txId]);
    await event(clientId, txId, 'waiting_device', started.raw || {});
    poll(clientId, txId).catch(e => log.error('fiscal', 'poll crashed', e.message));
    return { transactionId: txId, state: 'waiting_device', lock };
  } catch (err) {
    await db.exec("UPDATE fiscal_transactions SET state='error', error_code=?, error_message=?, finished_at=NOW(), state_changed_at=NOW() WHERE id=?",
      [err.code || 'START_FAILED', String(err.message).slice(0, 250), txId]);
    await event(clientId, txId, 'error', { message: err.message });
    await releaseLock(clientId, orderId);
    throw err;
  }
}

async function event(clientId, txId, toState, detail, fromState = null) {
  try {
    await db.exec(
      `INSERT INTO fiscal_transaction_events (client_id, fiscal_transaction_id, event, from_state, to_state, detail, created_at)
       VALUES (?,?,?,?,?,?,NOW())`,
      [clientId, txId, toState, fromState, toState, JSON.stringify(detail || {}).slice(0, 60000)]);
  } catch (e) { log.debug('fiscal', 'event insert failed', e.message); }
}

/** Follow the device until it answers, then finish the payment. */
async function poll(clientId, txId) {
  const tx = await db.one('SELECT * FROM fiscal_transactions WHERE id=? AND client_id=?', [txId, clientId]);
  if (!tx) return;
  const device = await db.one('SELECT * FROM fiscal_devices WHERE id=?', [tx.fiscal_device_id]);
  const adapter = adapterFor(device);
  const deadline = Date.now() + 180000;   // three minutes at the card terminal
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1200));
    let res;
    try { res = await adapter.pollSale(tx.provider_session_id); }
    catch (e) { log.warn('fiscal', 'poll error', e.message); continue; }
    if (res.state === 'waiting_device') continue;
    if (res.state === 'approved') return approve(clientId, tx, res);
    return refuse(clientId, tx, res);
  }
  return refuse(clientId, tx, { state: 'error', error: { code: 'TIMEOUT', message: 'Cihaz zaman asimi' } });
}

async function approve(clientId, tx, res) {
  const r = res.receipt || {};
  await db.tx(async t => {
    await t.exec(
      `UPDATE fiscal_transactions SET state='approved', approved_amount_minor=requested_amount_minor,
          authorization_code=?, bank=?, card_brand=?, card_masked=?, installments=?, batch_no=?, stan=?,
          provider_transaction_id=?, finished_at=NOW(), state_changed_at=NOW(), updated_at=NOW() WHERE id=?`,
      [r.approvalCode || null, r.bank || null, r.cardBrand || null, r.cardMasked || null,
       r.installments || 0, r.batchNo || null, r.stan || null, r.fiscalReference || null, tx.id]);
    await t.insert(
      `INSERT INTO fiscal_receipts (client_id, fiscal_transaction_id, order_id, fiscal_receipt_no, z_number,
          ekh_serial, fiscal_reference, payment_reference, fiscal_timestamp, raw_response, created_at)
       VALUES (?,?,?,?,?,?,?,?,NOW(),?,NOW())`,
      [clientId, tx.id, tx.order_id, r.fiscalReceiptNo || null, r.zNumber || null, r.ekhSerial || null,
       r.fiscalReference || null, r.approvalCode || null, JSON.stringify(res.raw || res).slice(0, 60000)]);
    for (const it of JSON.parse(tx.sale_snapshot || '{}').order?.items || []) {
      await t.exec(
        `INSERT INTO fiscal_transaction_items (client_id, fiscal_transaction_id, order_item_id, product_id,
            product_name, department, quantity, unit_price_minor, vat_rate, vat_amount_minor, line_total_minor, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())`,
        [clientId, tx.id, it.id, it.product_id, it.product_name,
         it.okc_department === undefined ? null : it.okc_department, it.qty,
         minor(it.unit_price), it.vat_rate, minor(it.vat_total), minor(it.line_total)]).catch(() => {});
    }
  });
  await event(clientId, tx.id, 'approved', res.raw || {});
  /*
   * The device has taken the money and printed a fiscal receipt. Posting it
   * onto the bill happens in a SECOND transaction, so there is a moment where
   * the ÖKC and the till can disagree - see the note in the report; closing
   * that window properly needs an addPayment that joins the caller's
   * transaction. What must not happen meanwhile is that the disagreement is
   * SILENT, or that the bill is left locked so nobody can even try again.
   *
   * `poll` is fire-and-forget, so a throw here used to vanish into a log line
   * and take the lock release with it: the guest had paid, the bill was still
   * open, and every further attempt to pay it answered "baska bir odeme
   * islemi devam ediyor" until the three-minute lock expired.
   */
  try {
    await payments.addPayment(clientId, tx.order_id, {
      method: tx.payment_method, amount: Number(tx.requested_amount_minor) / 100,
      userId: tx.cashier_id, channel: 'okc', fiscalTxId: tx.id,
    });
  } catch (e) {
    log.error('fiscal', 'OKC approved but the payment could not be posted', {
      tx: tx.id, order: tx.order_id, error: e.message });
    await event(clientId, tx.id, 'payment_post_failed', { error: e.message });
    // an owner reading audit_logs has to be able to find the money the device
    // took and the bill never saw; this is the only row that says so
    await db.exec(
      `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id, after_json, created_at)
       VALUES (?,?,?,?,?,?,?,NOW())`,
      [clientId, tx.cashier_id || null, 'cashier', 'fiscal.payment_post_failed', 'bill', String(tx.order_id),
       JSON.stringify({ fiscal_transaction_id: tx.id, amount_minor: tx.requested_amount_minor, error: e.message })]
    ).catch(() => {});
    await releaseLock(clientId, tx.order_id);
    throw e;
  }
  await releaseLock(clientId, tx.order_id);
  log.info('fiscal', 'Fiscal sale approved', { tx: tx.id, order: tx.order_id });
  return { state: 'approved', receipt: r };
}

async function refuse(clientId, tx, res) {
  const err = res.error || {};
  await db.exec(
    "UPDATE fiscal_transactions SET state=?, error_code=?, error_message=?, finished_at=NOW(), state_changed_at=NOW() WHERE id=?",
    [res.state, err.code || null, String(err.message || '').slice(0, 250), tx.id]);
  await event(clientId, tx.id, res.state, res.raw || err);
  await releaseLock(clientId, tx.order_id);
  log.warn('fiscal', 'Fiscal sale not completed', { tx: tx.id, state: res.state, err: err.message });
  return { state: res.state, error: err };
}

async function getTransaction(clientId, txId) {
  const tx = await db.one('SELECT * FROM fiscal_transactions WHERE id=? AND client_id=?', [txId, clientId]);
  if (!tx) return null;
  tx.receipt = await db.one('SELECT * FROM fiscal_receipts WHERE fiscal_transaction_id=?', [txId]);
  return tx;
}

async function cancel(clientId, txId) {
  const tx = await db.one('SELECT * FROM fiscal_transactions WHERE id=? AND client_id=?', [txId, clientId]);
  if (!tx) { const e = new Error('Islem bulunamadi'); e.status = 404; throw e; }
  const device = await db.one('SELECT * FROM fiscal_devices WHERE id=?', [tx.fiscal_device_id]);
  try { await adapterFor(device).cancelSale(tx.provider_session_id); } catch (_) {}
  await db.exec("UPDATE fiscal_transactions SET state='cancelled', finished_at=NOW(), state_changed_at=NOW() WHERE id=?", [txId]);
  await releaseLock(clientId, tx.order_id);
  return true;
}

/* ----------------------------- refunds ---------------------------- */
async function refund(clientId, { orderId, txId, items, reason, userId }) {
  await requireEnabled(clientId);
  const tx = await db.one('SELECT * FROM fiscal_transactions WHERE id=? AND client_id=?', [txId, clientId]);
  if (!tx) { const e = new Error('Islem bulunamadi'); e.status = 404; throw e; }
  const rec = await db.one('SELECT * FROM fiscal_receipts WHERE fiscal_transaction_id=?', [txId]);
  const device = await db.one('SELECT * FROM fiscal_devices WHERE id=?', [tx.fiscal_device_id]);
  const total = items.reduce((s, i) => s + minor(i.unit_price) * Number(i.qty), 0);
  const refundId = await db.insert(
    `INSERT INTO fiscal_refunds (client_id, idempotency_key, original_fiscal_transaction_id, order_id,
        fiscal_device_id, provider, refund_type, amount_minor, reason, state, requested_by, created_at)
     VALUES (?,?,?,?,?,?,'partial',?,?,'created',?,NOW())`,
    [clientId, crypto.randomUUID(), txId, orderId, tx.fiscal_device_id, tx.provider,
     total, reason || null, userId || null]).catch(() => null);
  const res = await adapterFor(device).refund({
    externalId: String(refundId || txId),
    originalReceiptNo: rec && rec.fiscal_receipt_no,
    originalZNo: rec && rec.z_number,
    items: items.map(i => ({ name: i.name, qty: i.qty, unitPriceMinor: minor(i.unit_price), vatRate: i.vat_rate })),
    totalMinor: total,
  });
  if (refundId) await db.exec("UPDATE fiscal_refunds SET state='approved', provider_refund_id=?, finished_at=NOW() WHERE id=?",
    [res.receiptNo || null, refundId]).catch(() => {});
  return res;
}

async function deviceReport(clientId, kind = 'X') {
  await requireEnabled(clientId);
  const d = await activeDevice(clientId);
  if (!d) { const e = new Error('Tanimli OKC cihazi yok'); e.status = 400; throw e; }
  const out = await adapterFor(d).report(kind);
  await db.exec(
    'INSERT INTO fiscal_device_reports (client_id, fiscal_device_id, report_type, raw, status, created_at) VALUES (?,?,?,?,?,NOW())',
    [clientId, d.id, kind, JSON.stringify(out.raw || {}).slice(0, 60000), 'ok']).catch(() => {});
  return out;
}

module.exports = {
  assertDispatchAllowed, ADAPTERS, adapterFor, deviceTables, listDevices, saveDevice, testDevice, beginSale, poll,
  getTransaction, cancel, refund, deviceReport, isEnabled, requireEnabled, activeDevice,
  acquireLock, releaseLock };
