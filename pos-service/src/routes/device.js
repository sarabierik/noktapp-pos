'use strict';
/**
 * /api/device — cihazlar, adisyon ön ekleri, senkron, bağlantı, günlük.
 *
 * Everything the "Cihazlar" screen needs, and nothing the phone needs: the
 * phone API is /api/mobile and pairing is /api/auth/pair, both of which stay
 * exactly where they were. This router is the till's own view of them.
 *
 * On permissions. Reading is gated on `settings.manage` because the whole
 * screen is an owner's screen, but the WRITES split further:
 *   user.manage      — pairing a phone, cutting one off, renaming one. That is
 *                      the same permission /api/auth/pair-code already asks
 *                      for, and it must stay the same one: a cashier who can
 *                      mint a pairing code can pair their own phone.
 *   settings.manage  — releasing a number prefix, retrying the outbox,
 *                      forcing a licence check.
 * Reading the activity log is `report.view`: a manager should be able to
 * answer "what happened at 19:40" without holding the settings permission.
 */
const express = require('express');
const auth = require('../auth');
const device = require('../modules/device');
const zincir = require('../modules/zincir');
const { ok, fail, wrap } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);

/* ------------------------------------------------------------ cihazlar */

r.get('/devices', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  ok(res, { devices: await device.devices(req.clientId) });
}));

/**
 * The pairing code and the countdown behind it.
 *
 * GET returns the code that is already live rather than minting one, so that
 * switching tabs while the waiter walks over with the phone does not silently
 * invalidate the six digits they are about to type.
 */
r.get('/pair-code', auth.requirePerm('user.manage'), wrap(async (req, res) => {
  ok(res, { pairing: await device.activePairCode(req.clientId) });
}));

r.post('/pair-code', auth.requirePerm('user.manage'), wrap(async (req, res) => {
  try {
    ok(res, { pairing: await device.createPairCode(
      req.clientId, req.auth.uid, req.body && req.body.for_user_id) });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

/** Who a code may be minted for - the picker above the QR. */
r.get('/pair-staff', auth.requirePerm('user.manage'), wrap(async (req, res) => {
  ok(res, { staff: await device.pairableStaff(req.clientId) });
}));

r.delete('/pair-code', auth.requirePerm('user.manage'), wrap(async (req, res) => {
  ok(res, await device.cancelPairCodes(req.clientId));
}));

r.post('/devices/:id/rename', auth.requirePerm('user.manage'), wrap(async (req, res) => {
  try { ok(res, await device.rename(req.clientId, req.params.id, req.body.name)); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

r.post('/devices/:id/revoke', auth.requirePerm('user.manage'), wrap(async (req, res) => {
  try { ok(res, await device.revoke(req.clientId, req.params.id)); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

/** Retire = cut access AND give the number prefix back. */
r.post('/devices/:id/retire', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  try { ok(res, await device.retire(req.clientId, req.params.id, req.auth.name || null)); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

/* -------------------------------------------------------- adisyon ön eki */

r.get('/prefixes', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  ok(res, await device.prefixState(req.clientId));
}));

/**
 * A device asking for its prefix.
 *
 * Idempotent by construction: a device that asks a second time gets the same
 * number back with allocated=false. `online_only: true` is a successful
 * answer, not an error - all nine prefixes are held, and the device is being
 * told it can still trade, just not while the network is down.
 */
r.post('/prefixes/allocate', wrap(async (req, res) => {
  const { device_id, device_name } = req.body || {};
  try { ok(res, await device.allocatePrefix(req.clientId, device_id, device_name || null)); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

r.post('/prefixes/:prefix/release', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  try { ok(res, await device.releasePrefix(req.clientId, req.params.prefix, req.auth.name || null)); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

/* ---------------------------------------------------------------- senkron */

r.get('/sync', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  ok(res, { sync: await device.syncStatus(req.clientId) });
}));

r.get('/sync/failed', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  ok(res, { ops: await device.failedOps(req.clientId, req.query.limit) });
}));

r.post('/sync/push', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  ok(res, { sync: await device.pushNow(req.clientId) });
}));

r.post('/sync/failed/retry-all', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  const out = await device.retryAll(req.clientId);
  ok(res, { ...out, sync: await device.pushNow(req.clientId) });
}));

/* The :id route is declared after retry-all so "retry-all" is never read as an id. */
r.post('/sync/failed/:id/retry', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  try {
    const out = await device.retryOp(req.clientId, req.params.id);
    ok(res, { ...out, sync: await device.pushNow(req.clientId) });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

/* -------------------------------------------------------------- bağlantı */

r.get('/connection', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  ok(res, await device.connection(req.clientId));
}));

/** "Şimdi doğrula" - a heartbeat on demand rather than waiting 30 minutes. */
r.post('/connection/check', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  ok(res, await device.checkNow(req.clientId));
}));

/* ----------------------------------------------------------------- şube */
/*
 * The chain endpoints. They live on this router because "which restaurant is
 * this till" is the same question as "which machine is this", and Cihazlar is
 * where the owner already goes to answer it.
 *
 * GET /branch is the only one a single-shop till ever calls, and on that till
 * it answers `bound:false` after reading ONE settings row - no request leaves
 * the building and the screen draws nothing extra. Binding and pulling are
 * `settings.manage`: joining a branch replaces the menu.
 */
r.get('/branch', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  ok(res, { branch: await zincir.state(req.clientId) });
}));

r.post('/branch/bind', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  try { ok(res, await zincir.bind(req.clientId, (req.body || {}).code)); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

/** "Şimdi güncelle" - the same pull the heartbeat makes, without the wait. */
r.post('/branch/pull', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  const out = await zincir.pull(req.clientId);
  ok(res, { ...out, branch: await zincir.state(req.clientId) });
}));

r.get('/branch/history', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  ok(res, { rows: await zincir.history(req.clientId, req.query.limit) });
}));

/* ---------------------------------------------------------------- günlük */

r.get('/log', auth.requirePerm('report.view'), wrap(async (req, res) => {
  ok(res, await device.logs(req.query));
}));

module.exports = r;
