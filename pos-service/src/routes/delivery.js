'use strict';
/**
 * PAKET SERVİS API - /api/delivery
 *
 * PERMISSIONS, and why there are two.
 *
 *   delivery.order   taking a phone order, moving a card along the board,
 *                    assigning a courier, taking the cash in. A CASHIER's
 *                    permission, for the same reason integration.order is:
 *                    at 20:30 the person who has to press "Yolda" is whoever
 *                    is at the till, and gating that on the owner's password
 *                    is how a restaurant ends up with a board nobody moves.
 *
 *   delivery.manage  zones, fees and couriers. Set up once, by the owner.
 *                    A cashier who could edit the delivery fee could also
 *                    quietly set it to zero.
 *
 * Every handler takes its tenant from `req.clientId` (the token) and never
 * from the body or the path.
 */
const express = require('express');
const auth = require('../auth');
const del = require('../modules/delivery');
const { ok, fail, wrap, id } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);

const canOrder = auth.requirePerm('delivery.order');
const canManage = auth.requirePerm('delivery.manage');

/*
 * A refusal the screen shows next to a button - "Önce kurye seçin", "Kuryenin
 * üzerinde 2 teslim edilmemiş sipariş var" - is an ordinary answer, not a
 * crash. Letting it reach the global handler would print a stack trace for
 * every one of them and bury the faults that matter. Anything without a
 * status is still a bug and still goes upstairs.
 */
function guard(fn) {
  return wrap(async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e) {
      if (e && e.status) return fail(res, e.message, e.status, e.code || null);
      throw e;
    }
  });
}

const uid = (req) => req.user?.uid || 0;
const uname = (req) => req.user?.name || null;

/* ------------------------------------------------------------- pano */
r.get('/board', canOrder, guard(async (req, res) =>
  ok(res, await del.board(req.clientId, { date: req.query.date || null }))));

r.get('/orders/:id', canOrder, guard(async (req, res) =>
  ok(res, await del.detail(req.clientId, Number(req.params.id)))));

/* Yeni paket siparişi. Returns the adisyon id so the screen can hand straight
   over to the order screen - the cashier never sees a second product picker. */
r.post('/orders', canOrder, guard(async (req, res) =>
  ok(res, await del.createOrder(req.clientId, {
    customerId: req.body.customer_id || null,
    addressId: req.body.address_id || null,
    note: req.body.note || null,
    paymentMethod: req.body.payment_method || null,
    promisedMinutes: req.body.promised_minutes || null,
    scheduledAt: req.body.scheduled_at || null,
    changeForMinor: req.body.change_for_minor || 0,
    repeatFromOrderId: req.body.repeat_order_id || null,
    /* An override of the blacklist is a decision, so it is a separate field
       the screen only sends after showing who wrote the flag and why. */
    force: req.body.force === true,
    source: req.body.source === 'COUNTER' ? 'COUNTER' : 'PHONE',
    userId: uid(req),
  }))));

r.post('/orders/:id/status', canOrder, guard(async (req, res) =>
  ok(res, await del.setStatus(req.clientId, Number(req.params.id), String(req.body.status || ''), {
    userId: uid(req), actorName: uname(req),
    reason: req.body.reason || null,
    cancelCode: req.body.cancel_code || null,
    force: req.body.force === true,
    payment: req.body.payment || null,
  }))));

r.post('/orders/:id/courier', canOrder, guard(async (req, res) =>
  ok(res, await del.assignCourier(req.clientId, id(req.params.id, 'Paket sipariş seçilmedi'),
    id(req.body.courier_id, 'Kurye seçilmedi'), uid(req)))));

/* A second copy for the bag, or the first one after a jam. */
r.post('/orders/:id/slip', canOrder, guard(async (req, res) =>
  ok(res, await del.reprintCourierSlip(req.clientId, Number(req.params.id)))));

/* ---------------------------------------------------------- müşteri */
r.get('/lookup', canOrder, guard(async (req, res) =>
  ok(res, await del.lookup(req.clientId, req.query.phone || ''))));

r.get('/addresses', canOrder, guard(async (req, res) => {
  if (req.query.q) return ok(res, { rows: await del.searchAddresses(req.clientId, req.query.q) });
  return ok(res, { rows: await del.addressList(req.clientId, id(req.query.customer_id, 'Müşteri seçilmedi')) });
}));

r.post('/addresses', canOrder, guard(async (req, res) =>
  ok(res, { id: await del.saveAddress(req.clientId, req.body || {}) })));

r.delete('/addresses/:id', canOrder, guard(async (req, res) =>
  ok(res, { deleted: await del.deleteAddress(req.clientId, id(req.params.id, 'Adres seçilmedi')) })));

/* ------------------------------------------------------- kara liste */
/*
 * Flagging is `canManage`, not `canOrder`. Writing somebody's name onto a
 * blacklist is not a till operation - it decides whether a person can be
 * served, and it should be the owner's signature on it.
 */
r.get('/customers/:id/flag', canOrder, guard(async (req, res) =>
  ok(res, {
    flag: await del.flagOf(req.clientId, Number(req.params.id)),
    history: await del.flagHistory(req.clientId, Number(req.params.id)),
    levels: del.FLAG_LEVELS,
  })));

r.post('/customers/:id/flag', canManage, guard(async (req, res) =>
  ok(res, await del.flagCustomer(req.clientId, Number(req.params.id), {
    level: req.body.level || 'watch', reason: req.body.reason || '', userId: uid(req),
  }))));

r.delete('/customers/:id/flag', canManage, guard(async (req, res) =>
  ok(res, await del.clearFlag(req.clientId, Number(req.params.id), uid(req)))));

/* The codes the screen offers, so the two lists cannot drift apart. */
r.get('/cancel-codes', canOrder, guard(async (req, res) =>
  ok(res, { codes: del.CANCEL_CODES.map(c => ({ code: c, label: del.CANCEL_LABEL[c] })) })));

/* ---------------------------------------------------------- kurye */
r.get('/couriers', canOrder, guard(async (req, res) =>
  ok(res, { rows: await del.courierList(req.clientId, { includeInactive: req.query.all === '1' }) })));

r.get('/couriers/:id', canOrder, guard(async (req, res) =>
  ok(res, await del.courierDetail(req.clientId, Number(req.params.id)))));

r.post('/couriers', canManage, guard(async (req, res) =>
  ok(res, { id: await del.saveCourier(req.clientId, req.body || {}) })));

r.post('/couriers/:id/shift', canOrder, guard(async (req, res) =>
  ok(res, await del.openCourierShift(req.clientId, Number(req.params.id), uid(req)))));

/* Taking the cash in. Not `canManage`: the cashier counts it, and making the
   owner sign in for every hand-over is how the cash stays on the bike. */
r.post('/couriers/:id/settle', canOrder, guard(async (req, res) =>
  ok(res, await del.settleCourier(req.clientId, Number(req.params.id), {
    takenMinor: req.body.taken_minor === undefined || req.body.taken_minor === null
      ? null : Math.round(Number(req.body.taken_minor)),
    note: req.body.note || null, userId: uid(req),
  }))));

/* ---------------------------------------------------------- bölge */
r.get('/zones', canOrder, guard(async (req, res) =>
  ok(res, { rows: await del.zones(req.clientId, { includeInactive: req.query.all === '1' }) })));

r.post('/zones', canManage, guard(async (req, res) =>
  ok(res, { id: await del.saveZone(req.clientId, req.body || {}) })));

r.delete('/zones/:id', canManage, guard(async (req, res) =>
  ok(res, { deleted: await del.deleteZone(req.clientId, Number(req.params.id)) })));

/* ---------------------------------------------------------- rapor */
r.get('/report', auth.requirePerm('report.view'), guard(async (req, res) =>
  ok(res, await del.report(req.clientId, { from: req.query.from || null, to: req.query.to || null }))));

module.exports = r;
