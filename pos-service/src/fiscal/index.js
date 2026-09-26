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
/*
 * Two different minor() functions exist in this codebase and they are not
 * interchangeable. util/http.minor is Math.round(Number(v) * 100) - a float
 * multiply - and it returns a NUMBER. fiscal/tutar.js is BigInt throughout and
 * speaks in minor-unit STRINGS, because a till that adds a few hundred lines a
 * night will otherwise eventually disagree with the fiscal device by a kurus.
 *
 * The sale object handed to an adapter is a fiscal boundary, so it uses the
 * exact one. Building it with the float helper is what made a real HUGIN S1
 * refuse the first basket it was ever sent:
 *   "line.unitPrice: minor-unit integer string bekleniyor, gelen: 32000"
 * - the value was right, the type was not.
 */
const para = require('./tutar');
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
  /* ingenico: KASITLI OLARAK YOK. engelli.js'teki BLOCKED kaydi devreye girer;
     sinif brands.IngenicoAdapter olarak duruyor ama gonderim icin secilemez. */
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
      `Bu ÖKC karantinada: ${device.quarantine_reason}. Çözülmemiş bir işlem var; `
      + 'önce Ayarlar › ÖKC ekranından mutabakatı tamamlayın.');
    e.status = 409; e.code = 'DEVICE_QUARANTINED'; throw e;
  }
  if (!device.production_enabled) {
    const e = new Error(
      'Bu ÖKC üretim için açılmadı. Cihaz tanımlı, fakat mali işlem yapabilmesi için '
      + 'yetenek kanıtı girilip Ayarlar › ÖKC kayıt defteri ekranından üretime açılması gerekiyor.');
    e.status = 409; e.code = 'PRODUCTION_NOT_ENABLED'; throw e;
  }
  await yetenek.assertAllowed(clientId, device.id, { workflow, tenderKinds });
}

/**
 * Every conversation with a fiscal device, written down.
 *
 * fiscal_provider_logs has been in the schema since the first migration and
 * NOTHING HAS EVER WRITTEN A ROW TO IT. That was invisible until a real HUGIN
 * refused a real X report with "Gonderilen veri formati veya yapisi beklenen
 * ile uyumsuz" and the only trace left anywhere was a red line on a screen
 * that a person had to read out loud. A device that talks to us in error codes
 * and a till that keeps none of them is a till that can only be debugged by
 * standing next to it.
 *
 * Failures matter more than successes here, so both are written and a failure
 * carries the device's own code and description.
 *
 * WHAT IS NOT WRITTEN: card numbers. The masking below is deliberately
 * whole-value, not clever - any key whose name looks like a pan, a track, a
 * CVV or a cardholder's name is replaced entirely rather than partially
 * redacted. A masking rule that keeps "the last four" is a rule that will one
 * day keep the first twelve because a vendor renamed a field.
 */
const SECRET_KEY = /(pan|cardno|cardnumber|track|cvv|cvc|pin|password|secret|token|expiry|expdate|holder|cardholder)/i;

function maskPayload(v, depth = 0) {
  if (v === null || v === undefined || depth > 6) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => maskPayload(x, depth + 1));
  if (typeof v !== 'object') return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = SECRET_KEY.test(k) ? '***' : maskPayload(val, depth + 1);
  }
  return out;
}

async function writeProviderLog(clientId, device, entry) {
  try {
    await db.exec(
      `INSERT INTO fiscal_provider_logs
         (client_id, fiscal_device_id, fiscal_transaction_id, provider, direction,
          operation, payload_masked, http_status, duration_ms, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW(3))`,
      [clientId, device.id || null, entry.txId || null, device.provider || 'unknown',
       entry.direction, String(entry.operation || '').slice(0, 48),
       JSON.stringify(maskPayload(entry.payload)).slice(0, 60000),
       entry.httpStatus || null, entry.durationMs || null]);
  } catch (e) {
    /* Logging must never break a sale. But it must not fail silently either -
       that is the whole reason this table was empty for a month. */
    log.warn('fiscal', 'cihaz gunlugu yazilamadi', { error: e.message });
  }
}

/**
 * Attach the same logging to an adapter somebody else built.
 *
 * The pairing route constructs its own HuginPcLinkAdapter - it has to, because
 * pairing is the one call that goes out before the device row knows its own
 * serial - so it cannot go through adapterFor. It is also the single most
 * interesting exchange to have a record of, because it is where the device
 * tells us what it is.
 */
function attachLog(adapter, clientId, device) {
  if (!adapter || !clientId) return adapter;
  adapter.onExchange = (entry) => { writeProviderLog(clientId, device || {}, entry); };
  return adapter;
}

function adapterFor(device, { clientId = null, txId = null } = {}) {
  const Klass = ADAPTERS[String(device.provider || 'simulator').toLowerCase()] || SimulatorAdapter;
  const a = new Klass(device);
  /* The adapter stays a pure protocol object: it announces what it did and
     this layer decides where that goes. */
  if (clientId) a.onExchange = (entry) => { writeProviderLog(clientId, device, { ...entry, txId }); };
  return a;
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
          connection_type=?, device_ip=?, device_port=?, serial_port=?, merchant_id=?, terminal_id=?,
          pclink_software_id=COALESCE(NULLIF(?, ''), pclink_software_id),
          environment=?, is_active=?, updated_at=NOW() WHERE id=? AND client_id=?`,
      [data.cash_register_id || null, data.provider, data.device_model || null, data.serial_number || '',
       data.connection_type || 'tcp', data.device_ip || null, data.device_port || null,
       data.serial_port || null,
       data.merchant_id || null, data.terminal_id || null,
       /* COALESCE above: an empty box on the edit form must not wipe a VKN the
          pairing step already recorded. */
       data.pclink_software_id || '',
       data.environment || 'production',
       data.is_active === false ? 0 : 1, data.id, clientId]);
    return data.id;
  }
  return db.insert(
    /* serial_port has existed as a column since the Ingenico migration and was
       never written by anything, because every adapter spoke TCP. A serial
       terminal that cannot record its COM port is a device nobody can reach. */
    `INSERT INTO fiscal_devices (client_id, branch_id, cash_register_id, provider, device_model, serial_number,
        connection_type, device_ip, device_port, serial_port, merchant_id, terminal_id,
        pclink_software_id, environment, status, is_active, created_at, updated_at)
     VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?, 'unknown', 1, NOW(), NOW())`,
    [clientId, data.cash_register_id || null, data.provider, data.device_model || null, data.serial_number || '',
     data.connection_type || 'tcp', data.device_ip || null, data.device_port || null, data.serial_port || null,
     data.merchant_id || null, data.terminal_id || null,
     data.pclink_software_id || null, data.environment || 'production']);
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
  const a = adapterFor(d, { clientId });
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

/**
 * How many lines this device accepts on one receipt, or null for "nobody knows".
 *
 * Two sources only, and neither of them is a constant in this file:
 *
 *   1. the number an operator typed on the device card. An explicit answer from
 *      the person holding the ÖKC manual beats everything else.
 *   2. what the adapter documents for its own protocol. GMP-3 states 40; the
 *      PC Link reference does not state a figure, so its adapter declares null.
 *
 * null means no pre-flight refusal. That is deliberate: the alternative was
 * applying Ingenico's 40 to a HUGIN and refusing a 45-line Saturday bill the
 * device might have printed. A basket the device does refuse now cancels its own
 * open document, so being wrong in this direction costs one clear error message
 * instead of a stuck till.
 *
 * What is NOT done here: reading a limit out of the device's settings snapshot
 * by guessing which key holds it. The snapshot is stored verbatim and shown to
 * the operator; a cap read from a property we matched by name could silently be
 * the wrong number, and a wrong cap refuses real sales.
 */
function lineLimit(device, adapter) {
  const stored = device.max_sale_lines === null || device.max_sale_lines === undefined
    || device.max_sale_lines === '' ? null : Number(device.max_sale_lines);
  if (stored > 0) return stored;
  const declared = adapter && Number(adapter.maxSaleLines);
  return declared > 0 ? declared : null;
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
    const adapter = adapterFor(device, { clientId, txId });
    const tables = await deviceTables(clientId, device);
    const base = require('./adapters/base');
    const sale = {
      externalId: String(txId),
      items: order.items.map(i => {
        const dep = base.resolveDepartment(i.vat_rate, tables);
        return {
          name: i.product_name,
          /* a decimal STRING, so 1.50 kg stays 1.50 and never becomes 1.5e0 */
          qty: para.isDecimal(String(i.qty)) ? String(i.qty) : String(Number(i.qty)),
          unitPriceMinor: para.minorFromDecimal(i.unit_price, 'item.unitPrice'),
          vatRate: Number(i.vat_rate || 0),
          /* the index the DEVICE counts from, and the unit it knows */
          department: dep.okc_index, departmentName: dep.name, vatCode: dep.vat_code,
          unit: base.unitFor(i.unit),
        };
      }),
      totalMinor: para.minorFromDecimal(amt, 'sale.total'),
      discountMinor: para.minorFromDecimal(order.discount_total || 0, 'sale.discount'),
      payment: { method, amountMinor: para.minorFromDecimal(amt, 'payment.amount'), installments },
    };
    /*
     * The device's own limits, checked here rather than discovered by the
     * device refusing mid-sale with the guest standing at the counter. Both
     * numbers come off the ÖKC settings screen and are per-device.
     *
     * WHERE THE LINE LIMIT COMES FROM, and why it is not a constant.
     *
     * 40 was the Ingenico GMP-3 figure and it was applied to every brand,
     * including HUGIN PC Link, whose reference does not state that number. So a
     * 45-line bill - one big table on a Saturday - was refused by the till for
     * a device that may well have accepted it, and the cashier was told to
     * split a bill that did not need splitting.
     *
     * The order of trust is: what the operator entered on the device card, then
     * what the device itself reported in its settings snapshot, then what the
     * adapter documents for its own protocol. If none of the three knows, no
     * cap is imposed here - the device answers for itself and a failed basket
     * now cancels its own document. An invented limit that refuses valid sales
     * is worse than no limit at all.
     */
    const lineCap = lineLimit(device, adapter);
    if (lineCap && sale.items.length > lineCap) {
      const e = new Error(`OKC tek fiste en fazla ${lineCap} satir kabul ediyor `
        + `(bu adisyonda ${sale.items.length} satir var). Adisyonu bolun.`);
      e.status = 400; throw e;
    }
    if (Number(sale.totalMinor) > Number(device.receipt_limit_minor || 1200000)) {
      const e = new Error('Tutar OKC fis limitinin ustunde ('
        + (Number(device.receipt_limit_minor || 1200000) / 100).toFixed(2) + ' TL). Odemeyi bolun.');
      e.status = 400; throw e;
    }
    /*
     * BUILD THE PAYLOAD BEFORE OPENING ANYTHING ON THE DEVICE.
     *
     * startSale opens a document on the OKC. If the basket then fails to
     * build - a bad price, a name the device will not take - the document is
     * already open and we have no way to close it: cancelSale throws
     * ENDPOINT_UNDOCUMENTED, because Hugin's cancel endpoint is in the Postman
     * reference behind the integration agreement. The device then refuses
     * every later sale with "uygun durumda degil" until somebody restarts it.
     * In an office that is an annoyance; in a restaurant it is a dead till
     * with a queue at the counter.
     *
     * Building the payload costs nothing and needs no device, so it happens
     * first. A basket that cannot be built now fails before the OKC has been
     * touched at all.
     */
    if (typeof adapter.buildSalePayload === 'function') {
      adapter.buildSalePayload(sale);
    }

    const started = await adapter.startSale(sale);
    await db.exec(
      "UPDATE fiscal_transactions SET state='waiting_device', provider_session_id=?, state_changed_at=NOW(), attempt_count=attempt_count+1 WHERE id=?",
      [started.providerSessionId, txId]);
    await event(clientId, txId, 'waiting_device', started.raw || {});

    /*
     * WHICH SHAPE IS THIS DEVICE'S SALE?
     *
     * Two genuinely different conversations hide behind one startSale():
     *
     *   poll              start the sale and the TERMINAL runs it - the guest
     *                     taps, the terminal decides - so we ask it, over and
     *                     over, whether it has finished. Ingenico / GMP-3.
     *
     *   request_response  we send the basket and the payment in one call and
     *                     that call returns the result. Hugin PC Link.
     *
     * The orchestrator only ever knew the first one. Against a real HUGIN S1
     * that meant: the document opened, the poll loop started, pollSale threw
     * POLL_NOT_APPLICABLE (correctly - PC Link has no poll), the catch below
     * swallowed it and `continue`d, and the till span for three minutes while
     * finishSale - the call that actually carries the basket - was never made
     * by anything. The device sat holding an empty open document.
     *
     * Only hardware could show this: the simulator answers polls, so every
     * suite was green on a path the Hugin adapter does not use.
     */
    const shape = adapter.saleShape || 'poll';
    if (shape === 'request_response') {
      finishNow(clientId, txId, sale)
        .catch(e => log.error('fiscal', 'finish crashed', e.message));
    } else {
      poll(clientId, txId).catch(e => log.error('fiscal', 'poll crashed', e.message));
    }
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

/**
 * The request/response sale: one call carries the basket and the payment, and
 * its answer IS the result. Run detached so the HTTP request that started the
 * sale returns straight away - the till's dialog already follows the
 * transaction row, and a cashier holding a spinner for three minutes with no
 * cancel button is worse than one watching a device.
 */
async function finishNow(clientId, txId, sale) {
  const tx = await db.one('SELECT * FROM fiscal_transactions WHERE id=? AND client_id=?', [txId, clientId]);
  if (!tx) return;
  const device = await db.one('SELECT * FROM fiscal_devices WHERE id=?', [tx.fiscal_device_id]);
  const adapter = adapterFor(device, { clientId, txId });
  let res;
  try {
    res = await adapter.finishSale(tx.provider_session_id, sale);
  } catch (e) {
    /*
     * A thrown finishSale is the sale failing, and it is reported as such.
     * The old poll loop logged its errors and carried on, which is how a
     * dead conversation looked like a slow one for three minutes.
     *
     * AND THEN CLEAN UP AFTER OURSELVES. startSale left a document OPEN on
     * the device; if it stays open the OKC refuses every later sale with
     * ERR_INVALID_STATE and the only cure was a restart - a dead till with a
     * queue at the counter. Now that the cancel endpoint is wired, a failed
     * sale closes its own document.
     *
     * Best effort on purpose: if the cancel itself fails the sale is still
     * reported as failed, with the cancel's own reason attached so the
     * cashier is told the device needs attention rather than silently
     * inheriting a stuck one.
     */
    let cleanup = null;
    if (typeof adapter.cancelSale === 'function' && tx.provider_session_id) {
      try {
        await adapter.cancelSale(tx.provider_session_id);
        cleanup = 'belge iptal edildi';
      } catch (ce) {
        cleanup = `belge iptal EDILEMEDI (${ce.code || 'HATA'}) - cihazi kontrol edin`;
        log.warn('fiscal', 'open document could not be cancelled',
          { tx: tx.id, doc: tx.provider_session_id, err: ce.message });
      }
    }
    return refuse(clientId, tx, {
      state: 'error',
      error: {
        code: e.code || 'FINISH_FAILED',
        message: cleanup ? `${e.message} [${cleanup}]` : e.message,
      },
    });
  }
  if (res.state === 'approved') return approve(clientId, tx, res);
  if (res.state === 'waiting_device') {
    /* The device answered but is not done - the only honest thing we can do
       without a poll endpoint is say so rather than hang. */
    return refuse(clientId, tx, { state: 'error', raw: res.raw, error: {
      code: 'DEVICE_NOT_FINISHED',
      message: 'Cihaz islemi tamamlamadi ve PC Link yoklama ucu yok. '
             + 'Cihaz ekranini kontrol edin.' } });
  }
  return refuse(clientId, tx, res);
}

/** Follow the device until it answers, then finish the payment. */
async function poll(clientId, txId) {
  const tx = await db.one('SELECT * FROM fiscal_transactions WHERE id=? AND client_id=?', [txId, clientId]);
  if (!tx) return;
  const device = await db.one('SELECT * FROM fiscal_devices WHERE id=?', [tx.fiscal_device_id]);
  const adapter = adapterFor(device, { clientId, txId });
  const deadline = Date.now() + 180000;   // three minutes at the card terminal
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1200));
    let res;
    try { res = await adapter.pollSale(tx.provider_session_id); }
    catch (e) {
      /*
       * An adapter saying "I do not poll" is not a transient error to retry
       * 150 times - it is a wiring mistake, and retrying hides it behind a
       * three-minute timeout. Stop and say which adapter and why.
       */
      if (e.code === 'POLL_NOT_APPLICABLE') {
        return refuse(clientId, tx, { state: 'error', error: { code: e.code,
          message: `${device.provider}: ${e.message}` } });
      }
      log.warn('fiscal', 'poll error', e.message);
      continue;
    }
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
      /*
       * bank_id, bank_reference_no and pos_transaction_id are written HERE or
       * never. PC Link returns them once, in the detailed response to the
       * sale, and there is no endpoint that hands them out again; a refund
       * without them is refused by the device. They used to survive only
       * inside fiscal_receipts.raw_response, which is a JSON blob nobody can
       * index and any field-name change silently empties.
       */
      `UPDATE fiscal_transactions SET state='approved', approved_amount_minor=requested_amount_minor,
          authorization_code=?, bank=?, card_brand=?, card_masked=?, installments=?, batch_no=?, stan=?,
          provider_transaction_id=?, bank_id=?, bank_reference_no=?, pos_transaction_id=?,
          finished_at=NOW(), state_changed_at=NOW(), updated_at=NOW() WHERE id=?`,
      [r.approvalCode || null, r.bank || null, r.cardBrand || null, r.cardMasked || null,
       r.installments || 0, r.batchNo || null, r.stan || null, r.fiscalReference || null,
       r.bankId === undefined || r.bankId === null ? null : String(r.bankId),
       r.bankReferenceNo ? String(r.bankReferenceNo) : null,
       r.posTransactionId ? String(r.posTransactionId) : null, tx.id]);
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
  try { await adapterFor(device, { clientId, txId }).cancelSale(tx.provider_session_id); } catch (_) {}
  await db.exec("UPDATE fiscal_transactions SET state='cancelled', finished_at=NOW(), state_changed_at=NOW() WHERE id=?", [txId]);
  await releaseLock(clientId, tx.order_id);
  return true;
}

/* ----------------------------- refunds ---------------------------- */
/**
 * Give money back.
 *
 * There are TWO different financial events here and the device decides which
 * one applies, not us:
 *
 *   iptal (void)   the card transaction has not been financialised yet - the
 *                  day-end has not run. The original is reversed and no refund
 *                  receipt exists.
 *   iade (refund)  the day-end has run. A separate refund receipt is printed.
 *
 * PC Link is asked for the refund; if the transaction turns out still to be
 * voidable it redirects to a void by itself and answers 206. That is reported
 * back as `voided`, never flattened into "refunded" - the two produce
 * different paperwork and an owner reconciling a bank statement has to be able
 * to tell them apart.
 *
 * The two adapter families need different inputs and neither is a superset of
 * the other:
 *
 *   GMP-3 / Ingenico   the original receipt number and Z number, plus the
 *                      lines being given back
 *   HUGIN PC Link      bankId + bankReferenceNo from the original sale's
 *                      detailed response
 *
 * So the whole union is handed over and each adapter takes what it documents.
 * Sending one shape and hoping is how this method spent three weeks unable to
 * refund anything: it passed the receipt-based payload to an adapter that
 * wanted bank references and got REFUND_REFERENCE_MISSING every time.
 */
async function refund(clientId, { orderId, txId, items, reason, userId, amountMinor }) {
  await requireEnabled(clientId);
  const tx = await db.one('SELECT * FROM fiscal_transactions WHERE id=? AND client_id=?', [txId, clientId]);
  if (!tx) { const e = new Error('Islem bulunamadi'); e.status = 404; throw e; }
  if (String(tx.state) !== 'approved') {
    const e = new Error(`Bu islem "${tx.state}" durumunda; yalnizca onaylanmis bir satis iade edilebilir.`);
    e.status = 409; e.code = 'REFUND_NOT_APPROVED'; throw e;
  }
  const rec = await db.one('SELECT * FROM fiscal_receipts WHERE fiscal_transaction_id=?', [txId]);
  const device = await db.one('SELECT * FROM fiscal_devices WHERE id=?', [tx.fiscal_device_id]);
  if (!device) { const e = new Error('Islemi alan OKC cihazi kayitli degil'); e.status = 409; throw e; }

  /*
   * The amount, exactly. The old line was
   *   items.reduce((s, i) => s + minor(i.unit_price) * Number(i.qty), 0)
   * which is float arithmetic on money in the one place where the wire format
   * is a decimal string: 3 x 16.65 came out as 4994.999999999999 and the
   * exact converter would - correctly - refuse it. Quantities and prices go
   * through the BigInt layer instead, the same as a sale does.
   */
  const lines = Array.isArray(items) ? items : [];
  let total;
  if (amountMinor !== undefined && amountMinor !== null) {
    total = para.minor(amountMinor, 'refund.amount').toString();
  } else if (lines.length) {
    total = para.add(...lines.map((i, n) => para.mulDecimal(
      String(i.qty === undefined || i.qty === null ? 1 : i.qty),
      para.minorFromDecimal(i.unit_price, `refund.line[${n}].unitPrice`),
      `refund.line[${n}]`)));
  } else {
    total = String(tx.approved_amount_minor || tx.requested_amount_minor || 0);
  }
  if (para.isZero(total) || para.isNegative(total)) {
    const e = new Error('Iade tutari sifir veya negatif olamaz.');
    e.status = 400; e.code = 'REFUND_AMOUNT_INVALID'; throw e;
  }

  const refundId = await db.insert(
    `INSERT INTO fiscal_refunds (client_id, idempotency_key, original_fiscal_transaction_id, order_id,
        fiscal_device_id, provider, refund_type, amount_minor, reason, state, requested_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,'created',?,NOW())`,
    [clientId, crypto.randomUUID(), txId, orderId || tx.order_id, tx.fiscal_device_id, tx.provider,
     para.cmp(total, String(tx.approved_amount_minor || tx.requested_amount_minor || 0)) === 0 ? 'full' : 'partial',
     total, reason || null, userId || null]).catch(() => null);

  let res;
  try {
    res = await adapterFor(device, { clientId, txId }).refund({
      externalId: String(refundId || txId),
      /* receipt-based brands */
      originalReceiptNo: rec && rec.fiscal_receipt_no,
      originalZNo: rec && rec.z_number,
      items: lines.map(i => ({
        name: i.name, qty: i.qty,
        unitPriceMinor: para.minorFromDecimal(i.unit_price, 'refund.unitPrice'),
        vatRate: i.vat_rate })),
      total,
      totalMinor: total,
      /* PC Link */
      amountMinor: total,
      bankId: tx.bank_id || null,
      bankReferenceNo: tx.bank_reference_no || null,
      posTransactionId: tx.pos_transaction_id || null,
    });
  } catch (e) {
    if (refundId) {
      await db.exec("UPDATE fiscal_refunds SET state='error', error_code=?, error_message=?, finished_at=NOW() WHERE id=?",
        [e.code || 'REFUND_FAILED', String(e.message).slice(0, 250), refundId]).catch(() => {});
    }
    throw e;
  }

  /* A device that redirected to a void did something else than was asked, and
     the row has to say which of the two happened. */
  const state = res.state === 'voided' ? 'voided' : 'approved';
  if (refundId) {
    await db.exec(
      "UPDATE fiscal_refunds SET state=?, refund_type=?, provider_refund_id=?, finished_at=NOW() WHERE id=?",
      [state, res.state === 'voided' ? 'void' : (para.cmp(total,
        String(tx.approved_amount_minor || tx.requested_amount_minor || 0)) === 0 ? 'full' : 'partial'),
       res.receiptNo || res.transactionId || null, refundId]).catch(() => {});
  }
  log.info('fiscal', 'Iade tamamlandi', {
    tx: txId, refund: refundId, state: res.state, redirected: !!res.redirectedToVoid });
  return { ...res, refundId, amountMinor: total };
}

/**
 * Reverse a card transaction BEFORE the fiscal day is closed.
 *
 * This is the other half of the pair above and it is not interchangeable with
 * it: a void leaves no refund receipt, which is why the till must not offer
 * "iade" for a sale taken today and "iptal" for one taken last week - the
 * device decides, and this is the path for when the caller already knows the
 * day has not closed.
 */
async function voidTransaction(clientId, txId, { userId, reason } = {}) {
  await requireEnabled(clientId);
  const tx = await db.one('SELECT * FROM fiscal_transactions WHERE id=? AND client_id=?', [txId, clientId]);
  if (!tx) { const e = new Error('Islem bulunamadi'); e.status = 404; throw e; }
  const device = await db.one('SELECT * FROM fiscal_devices WHERE id=?', [tx.fiscal_device_id]);
  if (!device) { const e = new Error('Islemi alan OKC cihazi kayitli degil'); e.status = 409; throw e; }
  const adapter = adapterFor(device, { clientId, txId });
  if (typeof adapter.voidTransaction !== 'function') {
    const e = new Error('Bu cihaz icin gun sonu oncesi iptal tanimli degil.');
    e.status = 400; e.code = 'VOID_UNSUPPORTED'; throw e;
  }
  const res = await adapter.voidTransaction(tx.pos_transaction_id);
  await db.exec(
    `INSERT INTO fiscal_refunds (client_id, idempotency_key, original_fiscal_transaction_id, order_id,
        fiscal_device_id, provider, refund_type, amount_minor, reason, state, provider_refund_id,
        requested_by, created_at, finished_at)
     VALUES (?,?,?,?,?,?,'void',?,?,'voided',?,?,NOW(),NOW())`,
    [clientId, crypto.randomUUID(), txId, tx.order_id, tx.fiscal_device_id, tx.provider,
     tx.approved_amount_minor || tx.requested_amount_minor || 0, reason || null,
     res.transactionId || null, userId || null]).catch(() => {});
  log.info('fiscal', 'Banka islemi iptal edildi', { tx: txId, ref: res.transactionId });
  return res;
}

/**
 * The fiscal sales a cashier could still give back.
 *
 * Deliberately NOT filtered down to the ones that will work. A card payment
 * taken before the bank references were being recorded is unrefundable through
 * PC Link and there is nothing to be done about that sale - but it must still
 * appear, with the reason attached, because the alternative is a cashier
 * searching for a payment he watched the device take and being shown an empty
 * list.
 */
async function refundable(clientId, { orderId = null, days = 7 } = {}) {
  const args = [clientId];
  let where = "t.client_id=? AND t.state='approved'";
  if (orderId) { where += ' AND t.order_id=?'; args.push(Number(orderId)); }
  else { where += ' AND t.finished_at >= (NOW() - INTERVAL ? DAY)'; args.push(Math.max(1, Math.min(90, Number(days) || 7))); }
  const rows = await db.query(
    `SELECT t.id, t.order_id, t.order_no, t.payment_method, t.approved_amount_minor, t.requested_amount_minor,
            t.bank, t.card_brand, t.card_masked, t.bank_id, t.bank_reference_no, t.pos_transaction_id,
            t.finished_at, t.provider, r.fiscal_receipt_no, r.z_number
       FROM fiscal_transactions t
       LEFT JOIN fiscal_receipts r ON r.fiscal_transaction_id = t.id
      WHERE ${where}
      ORDER BY t.finished_at DESC
      LIMIT 200`, args);
  const given = await db.query(
    `SELECT original_fiscal_transaction_id AS tx, COALESCE(SUM(amount_minor),0) AS given
       FROM fiscal_refunds
      WHERE client_id=? AND state IN ('approved','voided')
      GROUP BY original_fiscal_transaction_id`, [clientId]);
  const back = new Map(given.map(g => [Number(g.tx), String(g.given)]));
  return rows.map(t => {
    const paid = String(t.approved_amount_minor || t.requested_amount_minor || 0);
    const already = back.get(Number(t.id)) || '0';
    const left = para.sub(paid, already);
    let why = null;
    if (t.payment_method === 'nakit') why = 'Nakit satis - iade cihaz uzerinden degil kasadan yapilir.';
    else if (!t.bank_reference_no || !t.bank_id) {
      why = 'Bu satisin banka referanslari kaydedilmemis; cihaz uzerinden iade edilemez. '
          + 'Referanslar yalnizca satis aninda gelir ve sonradan sorgulanamaz.';
    } else if (para.isZero(left) || para.isNegative(left)) why = 'Tamami zaten geri verilmis.';
    return { ...t, paid_minor: paid, refunded_minor: already, refundable_minor: left,
      refundable: !why, reason: why };
  });
}

/**
 * Is there a device whose fiscal day a Z report would actually close?
 *
 * Day-end has to ask this before it refuses to close: a till with no OKC, or
 * one still on the simulator, or one never armed, has no fiscal day to end
 * and must not be blocked by a device that was never trading.
 */
async function armedDevice(clientId) {
  if (!await isEnabled(clientId)) return null;
  const d = await activeDevice(clientId);
  if (!d) return null;
  if (d.provider === 'simulator') return null;
  if (!Number(d.production_enabled)) return null;
  if (d.quarantine_reason) return null;
  return d;
}

/**
 * What a HUGIN S1 actually answers a report request with.
 *
 * Captured from FU00032768 on 26.09.2026, not from documentation:
 *
 *   "reportHeader": { "deviceId": "FU00032768", "receiptNo": "0003",
 *                     "receiptDate": "26-09-2026 16:59", "ejNo": 1 }
 *   "cumulativeTotal": "3270.75", "cumulativeVat": "264.02"
 *   "counters": { "total": 2, "sales": 0, "canceled": 1, ... }
 *   plus one object per tender: cash, eftPos, voucher, wire, openAccount,
 *   check, noCharge, loyalty, gift, mobile, vpos, eMoney, ...
 *
 * THERE IS NO FIELD CALLED zNo. The first version of this function looked for
 * `zNo`, `zNumber` and `ZNo`, found none of them, and wrote a Z row with an
 * empty Z number - the one field on that row that matters. Three guessed
 * spellings are not a protocol; this reads the header the device sends.
 *
 * `receiptNo` is read as the Z counter because that is what it counts on a Z
 * report ("0003" was this device's third). It is NOT asserted to mean the same
 * thing on an X, so an X keeps it as `device_receipt_no` in the raw record and
 * leaves z_number null rather than filing a number that is not a Z number.
 */
function reportHeader(raw) {
  const h = (raw && raw.reportHeader) || {};
  return {
    deviceId: h.deviceId || null,
    receiptNo: h.receiptNo === undefined || h.receiptNo === null ? null : String(h.receiptNo),
    ejNo: h.ejNo === undefined || h.ejNo === null ? null : String(h.ejNo),
    deviceTime: deviceDate(h.receiptDate),
    rawDate: h.receiptDate || null,
  };
}

/**
 * "26-09-2026 16:59" -> "2026-09-26 16:59:00".
 *
 * The device writes day first. The previous parser demanded an ISO prefix and
 * therefore stored nothing at all, which was the right failure: a date read in
 * the wrong order is worse than a blank, because 03-09 and 09-03 are both
 * plausible and only one is true. Now the real format is handled, and anything
 * that is not exactly it still stores nothing.
 */
function deviceDate(v) {
  const m = /^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(v || '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss || '00'}`;
}

/**
 * The figures an owner reconciles against, pulled out of the envelope.
 *
 * cumulativeTotal and cumulativeVat are the device's own running fiscal-memory
 * totals - the number that has to agree with the books - and they were going
 * straight into a JSON blob nobody reads.
 */
function reportTotals(raw) {
  const r = raw || {};
  const money = (v) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? v : null);
  const tenders = {};
  for (const k of ['cash', 'eftPos', 'voucher', 'wire', 'openAccount', 'check',
                   'noCharge', 'loyalty', 'gift', 'mobile', 'vpos', 'eMoney',
                   'charity', 'transportCard', 'coPay', 'dutyFree']) {
    const t = r[k];
    if (t && typeof t === 'object' && (t.total !== undefined || t.count !== undefined)) {
      tenders[k] = { total: money(t.total), count: Number(t.count || 0) };
    }
  }
  return {
    gross: money(r.grossSales && r.grossSales.total),
    net: money(r.netSales && r.netSales.total),
    discount: money(r.discount && r.discount.total),
    voidTotal: money(r.void && r.void.total),
    paymentsTotal: money(r.paymentsTotal),
    cumulativeTotal: money(r.cumulativeTotal),
    cumulativeVat: money(r.cumulativeVat),
    counters: r.counters && typeof r.counters === 'object' ? r.counters : null,
    tenders,
  };
}

/**
 * Take an X or a Z on the device and KEEP THE RECORD.
 *
 * The record-keeping here was broken in the quietest possible way.
 * fiscal_device_reports.report_key is NOT NULL and (client_id, report_key) is
 * UNIQUE; this INSERT never supplied the column and the whole statement was
 * wrapped in `.catch(() => {})`. So the first X failed on the missing column,
 * every later one would have collided anyway, and the failure was swallowed:
 * the device printed the report, the owner saw it come out, and the till had
 * no row for a single X or Z it had ever taken. A Z is the one irreversible
 * thing a till asks a fiscal device to do - not recording it is not a cosmetic
 * gap.
 *
 * The key is built from the device's own header when it gives one, so a retry
 * of the same report collides instead of duplicating. An X, whose receiptNo we
 * have not established the meaning of, falls back to a UUID: two X reports a
 * minute apart are two genuine events and must not be merged on a guess.
 */
async function deviceReport(clientId, kind = 'X') {
  await requireEnabled(clientId);
  const d = await activeDevice(clientId);
  if (!d) { const e = new Error('Tanimli OKC cihazi yok'); e.status = 400; throw e; }
  const out = await adapterFor(d, { clientId }).report(kind);
  const raw = out.raw || out.data || {};
  const k = String(out.kind || kind || 'X').toUpperCase();
  const head = reportHeader(raw);
  const totals = reportTotals(raw);

  const zNo = k === 'Z' ? head.receiptNo : null;
  const reportKey = (k === 'Z' && head.receiptNo
    ? `${d.id}:Z:${head.deviceId || d.serial_number || 'dev'}:${head.receiptNo}`
    : `${d.id}:${k}:${crypto.randomUUID()}`).slice(0, 96);

  try {
    await db.exec(
      `INSERT INTO fiscal_device_reports
         (client_id, fiscal_device_id, report_type, report_key, z_number, device_time,
          amount_minor, payment_method, note, raw, status, created_at, processed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [clientId, d.id, k, reportKey, zNo ? String(zNo).slice(0, 24) : null, head.deviceTime,
       0, 'NONE',
       /* the two numbers an owner reconciles against, readable without opening the blob */
       [totals.cumulativeTotal ? 'Kumulatif: ' + totals.cumulativeTotal : null,
        totals.cumulativeVat ? 'KDV: ' + totals.cumulativeVat : null,
        head.ejNo ? 'EKU: ' + head.ejNo : null].filter(Boolean).join(' | ').slice(0, 255) || null,
       JSON.stringify(raw).slice(0, 60000), 'ok']);
  } catch (e) {
    /* Loud, not silent. The report itself happened on the device; if we could
       not write it down the operator has to be told, because the paper in his
       hand is now the only copy. */
    log.error('fiscal', 'OKC raporu alindi ama kaydedilemedi', {
      device: d.id, kind: k, error: e.message });
    out.recorded = false;
    out.recordError = e.message;
    return out;
  }
  out.recorded = true;
  out.reportKey = reportKey;
  out.zNumber = zNo;
  out.header = head;
  out.totals = totals;
  log.info('fiscal', 'OKC raporu alindi', {
    device: d.id, kind: k, z: zNo, kumulatif: totals.cumulativeTotal });
  return out;
}

module.exports = {
  assertDispatchAllowed, ADAPTERS, adapterFor, attachLog, maskPayload, deviceTables, listDevices, saveDevice, testDevice, beginSale, poll,
  getTransaction, cancel, refund, voidTransaction, refundable, deviceReport, reportHeader, reportTotals, deviceDate, armedDevice, isEnabled, requireEnabled, activeDevice,
  acquireLock, releaseLock };
