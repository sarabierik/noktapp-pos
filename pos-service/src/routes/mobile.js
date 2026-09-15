'use strict';
/**
 * The phone API.
 *
 * It reaches this router either directly over the restaurant's Wi-Fi or through
 * the cloud relay - the code path is identical, which is why there is only one
 * implementation to keep correct.
 *
 * PERMISSIONS, and why they arrived late.
 * --------------------------------------
 * This router used to carry none. `mobileAuth` proved WHO was holding the
 * phone and then let them do everything the router offered, so a waiter with
 * no `order.item.cancel` could still cancel a line from the handset, and a
 * waiter with no `order.discount` only lacked the button rather than the
 * ability. The till has gated these keys since it was written; the phone is
 * the same restaurant and the same person, so it gates them the same way.
 *
 * `mobileAuth` fills req.auth exactly as requireAuth does - the same cid, uid
 * and role - which is what lets auth.requirePerm work here unchanged. Anything
 * added below therefore inherits the same model by default, and the ONE place
 * a permission is decided stays src/auth.js.
 */
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const lan = require('../lan');
const orders = require('../modules/orders');
const catalog = require('../modules/catalog');
const msync = require('../modules/mobilesync');
const printing = require('../print');
const mail = require('../mail');
const { ok, fail, wrap } = require('../util/http');

const r = express.Router();

/** Device token OR jwt - both are accepted. */
async function mobileAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return fail(res, 'Oturum yok', 401);
  const dev = await lan.verifyDeviceToken(token);
  if (dev) {
    const u = await db.one('SELECT id, display_name, role FROM users WHERE id=? AND client_id=? AND is_active=1',
      [dev.user_ref, dev.client_id]);
    if (!u) return fail(res, 'Kullanici pasif', 401);
    req.clientId = dev.client_id;
    req.auth = { cid: dev.client_id, uid: u.id, role: u.role, name: u.display_name, kind: 'mobile' };
    return next();
  }
  const p = await auth.verifyToken(token);
  if (!p) return fail(res, 'Oturum suresi doldu', 401);
  req.auth = p; req.clientId = p.cid;
  next();
}

r.get('/ping', wrap(async (req, res) => {
  const lic = await db.one('SELECT client_id, company_name FROM np_licence WHERE id=1');
  ok(res, { product: 'noktapp-pos', version: process.env.NOKTAPP_VERSION || '2.0.0',
    client_id: lic ? lic.client_id : null, name: lic ? lic.company_name : null });
}));

r.use(mobileAuth);

/* the same keys, the same names, the same source as the till */
const can = (perm) => auth.requirePerm(perm);

r.get('/bootstrap', wrap(async (req, res) => {
  const plan = await orders.tablePlan(req.clientId);
  ok(res, {
    me: { id: req.auth.uid, name: req.auth.name, role: req.auth.role },
    menu: await catalog.menu(req.clientId),
    zones: plan.zones, tables: plan.tables,
    /*
     * The app draws its buttons from this, and the server refuses on the same
     * list - so a greyed-out button and a refused request can never disagree.
     */
    perms: await auth.permissionsFor(req.clientId, req.auth.uid, req.auth.role),
    stations: await catalog.stations(req.clientId),
    settings: { currency: '₺' },
  });
}));

/**
 * DELTA PULL - the handheld's own copy, kept in step.
 *
 * `since` is the cursor the phone stored last time. 0 (or a cursor older than
 * the log still reaches) answers with a full snapshot and says so, and the
 * phone replaces its local database wholesale rather than merging into a state
 * it can no longer reason about.
 *
 * Everything else is only what moved: the products whose price changed, the
 * table that was taken out of service, the bills that gained a line. A quiet
 * minute costs one small request; the phone is not re-downloading the menu
 * every twenty seconds to find out nothing happened.
 */
r.get('/pull', wrap(async (req, res) => {
  const since = Number(req.query.since || 0) || 0;
  const out = await msync.delta(req.clientId, since);
  const rows = (out.products || []).length + (out.tables || []).length +
    (out.categories || []).length + (out.orders || []).length + (out.zones || []).length;
  await msync.remember(req.clientId, req.headers['x-device-id'], out.cursor, out.full, rows)
    .catch(() => {});
  ok(res, out);
}));

/**
 * How far behind each paired handset is - drawn on the till's Telefonlar
 * screen, and gated like the rest of that screen.
 *
 * It names every device in the restaurant and when each was last seen. That is
 * a manager's answer to "whose phone stopped writing", not something a waiter's
 * own handset has any reason to ask, so it asks for the same key the device
 * list does rather than riding in on a device token.
 */
r.get('/cursors', can('settings.manage'), wrap(async (req, res) => ok(res, await msync.cursors(req.clientId))));

/** Which kitchens and bars exist, for the "gönder" sheet. */
r.get('/stations', wrap(async (req, res) => ok(res, { stations: await catalog.stations(req.clientId) })));

r.get('/tables', wrap(async (req, res) => ok(res, await orders.tablePlan(req.clientId))));

r.get('/orders/:id', wrap(async (req, res) => {
  const o = await orders.getOrder(req.clientId, req.params.id);
  if (!o) return fail(res, 'Adisyon bulunamadi', 404);
  ok(res, { order: o });
}));

r.get('/tables/:id/order', wrap(async (req, res) => {
  const rows = await orders.openOrdersForTable(req.clientId, req.params.id);
  ok(res, { orders: rows });
}));

/**
 * One call takes the whole round: open the bill if needed, add every line the
 * waiter typed, then fire the kitchen and bar slips. A phone on a bad signal
 * gets one request to retry, not eight.
 */
/**
 * Open a bill and nothing else.
 *
 * `orders/take` opens a bill AND fills it AND sends it, which is the right
 * shape for a waiter who has already taken the round. A handheld needs the
 * other shape too: stand at the table, open the bill, then add lines one at a
 * time as the guests decide. `force_new` opens a SECOND bill on a table that
 * already has one - two couples on a six-top, each paying for themselves.
 */
r.post('/orders', can('order.create'), wrap(async (req, res) => {
  try {
    const id = await orders.openOrGetOrder(req.clientId, {
      orderId: req.body.order_id, tableId: req.body.table_id,
      userId: req.auth.uid, waiterId: req.auth.uid,
      deviceId: req.headers['x-device-id'] || null,
      forceNew: !!req.body.force_new,
    });
    ok(res, { order_id: id, order: await orders.getOrder(req.clientId, id) });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

r.post('/orders/take', can('order.create'), wrap(async (req, res) => {
  const { table_id, order_id, items = [], note, send = true, app_local_id, force_new } = req.body || {};
  try {
    /*
     * `force_new` is how a phone opens a SECOND bill on a table that already
     * has one - two couples sharing a six-top, each paying for themselves.
     * openOrGetOrder has always understood it; this route simply never passed
     * it on, so the phone's only option was to add to whatever bill happened
     * to come back first. On a table with two parties that puts one guest's
     * round on the other guest's tab, and nobody finds out until the bill is
     * asked for.
     */
    const id = await orders.openOrGetOrder(req.clientId, {
      orderId: order_id, tableId: table_id, userId: req.auth.uid, waiterId: req.auth.uid,
      deviceId: req.headers['x-device-id'] || null,
      forceNew: !!force_new,
    });
    for (const it of items) {
      await orders.addItem(req.clientId, id, {
        productId: it.product_id, qty: it.qty || 1, note: it.note || null,
        userId: req.auth.uid, appLocalId: it.app_local_id || app_local_id || null,
      });
    }
    if (note) await db.exec('UPDATE orders SET notes=? WHERE id=? AND client_id=?', [note, id, req.clientId]);
    let sent = null;
    if (send) sent = await orders.sendToStations(req.clientId, id, req.auth.uid);
    ok(res, { order_id: id, sent, order: await orders.getOrder(req.clientId, id) });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

/**
 * Send to the kitchen, as its own act.
 *
 * It used to ride on `orders/take` only, so a bill that was opened and filled
 * line by line could not be fired from the handset at all - the waiter had to
 * walk to the till. Sending twice is safe: only what has not gone yet goes.
 */
r.post('/orders/:id/send', can('order.create'), wrap(async (req, res) => {
  try { ok(res, await orders.sendToStations(req.clientId, req.params.id, req.auth.uid)); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

r.post('/orders/:id/transfer', can('order.transfer'), wrap(async (req, res) => {
  try {
    await orders.transferTable(req.clientId, req.params.id, req.body.table_id, req.auth.uid);
    ok(res, { order: await orders.getOrder(req.clientId, req.params.id) });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

r.post('/orders/:id/discount', can('order.discount'), wrap(async (req, res) => {
  try {
    const total = await orders.setBillDiscount(req.clientId, req.params.id, {
      amount: req.body.amount ?? null, percent: req.body.percent ?? null,
      userId: req.auth.uid, approvedBy: req.body.approved_by, reason: req.body.reason,
    });
    ok(res, { grand_total: total, order: await orders.getOrder(req.clientId, req.params.id) });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

/** A, B, C - which party on the table this bill belongs to. */
r.post('/orders/:id/label', can('order.create'), wrap(async (req, res) => {
  try { ok(res, { label: await orders.renameBill(req.clientId, Number(req.params.id), req.body.label) }); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

r.delete('/orders/:id/items/:itemId', can('order.item.cancel'), wrap(async (req, res) => {
  try {
    await orders.cancelItem(req.clientId, req.params.id, req.params.itemId, {
      qty: req.body.qty ?? null, reason: req.body.reason || 'Telefondan iptal', userId: req.auth.uid });
    ok(res, { order: await orders.getOrder(req.clientId, req.params.id) });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

/**
 * Print the bill on the till's printer.
 *
 * Deliberately NOT behind payment.take: asking for the bill is the waiter's
 * job and taking the money is the cashier's, and on a handheld those are two
 * different people walking in opposite directions.
 */
r.post('/orders/:id/print', wrap(async (req, res) => {
  try { await printing.queueBill(req.clientId, req.params.id); ok(res); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

/** A second kitchen slip, for a jam or a lost ticket. */
r.post('/orders/:id/print/station', can('order.create'), wrap(async (req, res) => {
  try {
    const out = await printing.reprintStationSlip(req.clientId, req.params.id,
      req.body.station_id ? Number(req.body.station_id) : null);
    ok(res, out || {});
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

/** What the handset printed and whether it came out. */
r.get('/print-jobs', wrap(async (req, res) => ok(res, {
  jobs: await db.query(
    `SELECT j.id, j.status, j.job_type, j.order_id, j.created_at, j.sent_at,
            s.name AS station_name
       FROM print_jobs j LEFT JOIN stations s ON s.id=j.station_id AND s.client_id=j.client_id
      WHERE j.client_id=? ORDER BY j.id DESC LIMIT 40`, [req.clientId]),
})));

r.post('/print-jobs/:id/retry', wrap(async (req, res) => {
  try { ok(res, await printing.retry(req.clientId, Number(req.params.id))); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

/** Mail the bill to the guest. */
r.post('/orders/:id/mail', wrap(async (req, res) => {
  if (!req.body.email) return fail(res, 'E-posta adresi gerekli');
  try { ok(res, await mail.queueBill(req.clientId, req.params.id, req.body.email)); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

/**
 * Offline queue drain. The phone stores what it could not send and replays it
 * here; op_id makes every operation safe to send twice.
 */
r.post('/sync', wrap(async (req, res) => {
  const results = [];
  for (const op of req.body.ops || []) {
    /*
     * op_id is what makes replay safe, so it has to BE one: the column is
     * CHAR(36) NOT NULL, and an op with no id (or a longer one) sailed past
     * the "have I seen this" lookup, did the work, and then failed to record
     * itself - so it was reported as rejected and the phone replayed it, for
     * ever, opening a new bill each time.
     */
    const opId = String(op.op_id == null ? '' : op.op_id);
    if (!opId || opId.length > 36) {
      results.push({ op_id: op.op_id || null, status: 'rejected', error: 'Gecersiz op_id' });
      continue;
    }
    // the recorded OUTCOME comes back, whichever it was - a replay of an op
    // that was refused must be refused again, not quietly retried
    const seen = await db.one('SELECT status, response, error_code FROM app_sync_ops WHERE client_id=? AND op_id=?',
      [req.clientId, opId]);
    if (seen) { results.push(replayOf(opId, seen)); continue; }
    /*
     * CLAIM the op_id before doing the work, not after.
     *
     * The lookup above is only a fast path. A phone on a flaky line sends the
     * same batch twice and both requests are in flight at once: both found
     * nothing, both took the order, and only then did one of them lose the
     * unique key - so the guest had two adisyons and the phone was told the
     * second one was "rejected". Writing the row first makes uq_op the
     * gatekeeper: the loser never does the work, and answers with what the
     * winner did.
     */
    try {
      await db.exec(
        "INSERT INTO app_sync_ops (client_id, op_id, device_id, op_type, status, created_at) VALUES (?,?,?,?, 'applied', NOW())",
        [req.clientId, opId, deviceIdOf(req, op), String(op.type || '').slice(0, 48)]);
    } catch (e) {
      if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) {
        const row = await db.one('SELECT status, response, error_code FROM app_sync_ops WHERE client_id=? AND op_id=?',
          [req.clientId, opId]);
        results.push(replayOf(opId, row));
        continue;
      }
      results.push({ op_id: opId, status: 'rejected', error: e.message });
      continue;
    }
    try {
      let out = null;
      if (op.type === 'take_order') {
        /*
         * force_new travels through the queue for the same reason order_id
         * does. A round typed for a SECOND party while the phone was out of
         * signal carries it; without it the replay fell through to "find this
         * table's first open bill" and wrote the round on the other party's
         * tab - the live /orders/take bug, only discovered a shift later when
         * the queue drained and nobody was standing at the table any more.
         */
        const id = await orders.openOrGetOrder(req.clientId, {
          orderId: op.order_id, tableId: op.table_id, userId: req.auth.uid,
          waiterId: req.auth.uid, offline: true, deviceId: op.device_id,
          forceNew: !!op.force_new });
        for (const it of op.items || []) {
          await orders.addItem(req.clientId, id, { productId: it.product_id, qty: it.qty,
            note: it.note || null, userId: req.auth.uid, appLocalId: it.app_local_id });
        }
        if (op.send !== false) await orders.sendToStations(req.clientId, id, req.auth.uid);
        out = { order_id: id };
      } else if (op.type === 'cancel_item') {
        await orders.cancelItem(req.clientId, op.order_id, op.item_id,
          { qty: op.qty ?? null, reason: op.reason || '', userId: req.auth.uid });
        out = { ok: true };
      } else {
        throw new Error('Bilinmeyen islem: ' + op.type);
      }
      await db.exec("UPDATE app_sync_ops SET response=? WHERE client_id=? AND op_id=?",
        [JSON.stringify(out), req.clientId, opId]);
      results.push({ op_id: opId, status: 'applied', response: out });
    } catch (e) {
      /*
       * The claim row stays and is flipped to 'rejected' rather than deleted:
       * a replay of an op that could not be applied must come back with the
       * same answer, not be tried again from the top - "the table already has
       * a bill" does not become true on the second attempt, and half of it may
       * already have happened.
       */
      await db.exec(
        "UPDATE app_sync_ops SET status='rejected', error_code=? WHERE client_id=? AND op_id=?",
        [String(e.message).slice(0, 48), req.clientId, opId]).catch(() => {});
      results.push({ op_id: opId, status: 'rejected', error: e.message });
    }
  }
  ok(res, { results });
}));

/* What a replayed op_id answers with: exactly what it answered the first time. */
function replayOf(opId, row) {
  if (!row) return { op_id: opId, status: 'applied', response: null };
  return row.status === 'rejected'
    ? { op_id: opId, status: 'rejected', error: row.error_code || 'Daha once reddedildi' }
    : { op_id: opId, status: 'applied', response: safe(row.response) };
}

function deviceIdOf(req, op) { return op.device_id || req.headers['x-device-id'] || 'unknown'; }
function safe(s) { try { return JSON.parse(s); } catch (_) { return null; } }

module.exports = r;
