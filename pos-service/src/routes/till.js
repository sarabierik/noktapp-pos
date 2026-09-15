'use strict';
/**
 * KASA API - /api/till
 *
 * The shift lifecycle already had endpoints on /api/pos (shift, shift/open,
 * shift/close, shift/movement, drawer) and no screen at all, so the only sign
 * of a drawer anywhere in the product was a chip in the header. Those routes
 * stay exactly where they are - the phone app and the relay call them - and
 * these sit beside them for the things a till screen needs and they never had:
 * a single state read, a refused cash-out, a denomination count, an X report
 * and an audited drawer kick.
 *
 * Nothing here reimplements the ledger. Every write goes through
 * modules/till.js, which goes through modules/payments.js.
 */
const express = require('express');
const auth = require('../auth');
const till = require('../modules/till');
const { ok, fail, wrap } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);

/*
 * A refusal is an answer, not a crash. "Kasadan para çıkışı için açıklama
 * zorunlu" is a message next to a field; letting it reach the global error
 * handler would print a stack trace into the service log every time a cashier
 * forgets a note, which is how a real fault gets lost in the noise. Anything
 * without a status is still a bug and still goes to the handler.
 */
function safe(fn) {
  return wrap(async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e) {
      if (e && e.status) return fail(res, e.message, e.status, e.code || null);
      throw e;
    }
  });
}

const who = (req) => ({ userId: req.auth.uid, userName: req.auth.name });

/* ------------------------------- durum ----------------------------- */
/** Everything the kasa screen draws, in one round trip. */
/*
 * `payment.take` - the same key the Kasa page itself is registered under in
 * the client, and for the same reason: this is the whole cash position of the
 * drawer (float, expected cash, every movement in and out, every count) and
 * a waiter has no business reading it. Not `report.view`: the cashier who has
 * to work the drawer must be able to see it even where the owner has taken
 * the reports away from them.
 */
r.get('/state', auth.requirePerm('payment.take'), safe(async (req, res) => ok(res, await till.state(req.clientId))));

/** The denomination list on its own, for a screen that only wants the counter. */
r.get('/denominations', safe(async (req, res) => ok(res, { denominations: till.DENOMS })));

/* ------------------------------ vardiya ---------------------------- */
r.post('/shift/open', auth.requirePerm('shift.open'), safe(async (req, res) =>
  ok(res, { shift: await till.openShift(req.clientId, {
    ...who(req), openingFloat: req.body.opening_float || 0, note: req.body.note || null }) })));

/**
 * Closing takes either a denomination count or a typed total. When both
 * arrive the count wins - see modules/till.js: the server adds up the notes so
 * the variance is never built on the cashier's arithmetic.
 */
r.post('/shift/close', auth.requirePerm('shift.close'), safe(async (req, res) =>
  ok(res, { shift: await till.closeShift(req.clientId, {
    ...who(req), counts: req.body.counts, countedCash: req.body.counted_cash, note: req.body.note }) })));

/** Past drawers with their variances, plus who keeps coming up short. */
r.get('/shifts', auth.requirePerm('report.view'), safe(async (req, res) =>
  ok(res, await till.history(req.clientId, {
    limit: req.query.limit, from: req.query.from, to: req.query.to }))));

/**
 * One shift, open or closed. A closed one answers with the figures it was
 * closed on, which is the point: the summary stays viewable and stays put.
 */
r.get('/shifts/:id', safe(async (req, res) => {
  const s = await till.position(req.clientId, req.params.id);
  if (!s) return fail(res, 'Vardiya bulunamadı', 404, 'not_found');
  ok(res, {
    shift: s,
    movements: await till.movements(req.clientId, s.shift.id),
    counts: await till.counts(req.clientId, s.shift.id),
    drawer: (await till.drawerLog(req.clientId, { shiftId: s.shift.id })).events,
  });
}));

/* ---------------------------- hareketler --------------------------- */
r.get('/movements', safe(async (req, res) => {
  const s = await till.position(req.clientId, req.query.shift_id || null);
  if (!s) return ok(res, { movements: [] });
  ok(res, { movements: await till.movements(req.clientId, s.shift.id) });
}));

r.post('/movements', auth.requirePerm('payment.take'), safe(async (req, res) =>
  ok(res, await till.movement(req.clientId, {
    direction: req.body.direction, amount: req.body.amount, reason: req.body.reason, userId: req.auth.uid }))));

/* ---------------------------- kasa sayimi -------------------------- */
/**
 * Add up a count without filing it. The screen calls this as the cashier
 * types so the total on screen is the total the close will use - there is no
 * second adder in the browser to disagree with this one.
 */
r.post('/count/total', safe(async (req, res) => ok(res, till.countTotal(req.body.counts || {}))));

/** A mid-shift count, filed against the open drawer. */
r.post('/count', auth.requirePerm('payment.take'), safe(async (req, res) =>
  ok(res, { count: await till.countDrawer(req.clientId, {
    ...who(req), counts: req.body.counts, note: req.body.note }) })));

/* ----------------------------- X raporu ---------------------------- */
r.get('/x-report', auth.requirePerm('report.view'), safe(async (req, res) =>
  ok(res, { report: await till.xReport(req.clientId) })));

r.post('/x-report/print', auth.requirePerm('report.view'), safe(async (req, res) => {
  const report = await till.xReport(req.clientId);
  await till.printXReport(req.clientId, report);
  ok(res, { report, queued: true });
}));

/* ----------------------------- cekmece ----------------------------- */
/**
 * Opening the drawer is a permitted action with a name on it. /api/pos/drawer
 * fires the same pulse and writes nothing; this one writes the row first and
 * treats the pulse as best effort.
 */
r.post('/drawer', auth.requirePerm('payment.take'), safe(async (req, res) =>
  ok(res, await till.openDrawer(req.clientId, {
    ...who(req), reason: req.body.reason || null, orderId: req.body.order_id || null,
    ip: req.ip }))));

r.get('/drawer/log', auth.requirePerm('report.view'), safe(async (req, res) =>
  ok(res, await till.drawerLog(req.clientId, {
    limit: req.query.limit, shiftId: req.query.shift_id || null, noSaleOnly: req.query.no_sale === '1' }))));

module.exports = r;
