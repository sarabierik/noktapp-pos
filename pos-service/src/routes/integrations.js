'use strict';
/**
 * /api/integrations — the Entegrasyonlar screen's API, and the webhook the
 * platforms call.
 *
 * Two halves with very different rules, which is why the webhook router is
 * declared BEFORE `r.use(auth.requireAuth)` and everything else after it. A
 * platform cannot hold one of our staff tokens, so its endpoint is
 * unauthenticated by necessity - and therefore is the one endpoint here that
 * is verified by signature, rate limited hard, and answers in a fixed shape no
 * matter what happens behind it.
 *
 * PERMISSIONS
 *   integration.manage  connecting a platform, credentials, mapping, menu
 *                       sync, opening and closing the restaurant. An owner's
 *                       permission, next to settings.manage.
 *   integration.order   accepting, rejecting, marking ready, reprinting. A
 *                       CASHIER's permission, because at 20:30 the person who
 *                       has to press Onayla is whoever is at the till, and
 *                       gating that on the owner's password is how a
 *                       restaurant ends up leaving orders unaccepted.
 *   report.view         the sync and audit logs.
 *
 * TENANT SCOPE
 * Every handler uses `req.clientId` from the token and never a client id from
 * the body or the path, and every query in modules/integrations carries it. A
 * branch id from the query is bounded to what this tenant actually has.
 */
const express = require('express');
const auth = require('../auth');
const db = require('../db');
const log = require('../logger');
const { ok, fail, wrap } = require('../util/http');
const mod = require('../modules/integrations');
const svc = require('../integrations');
const registry = require('../integrations/registry');

const r = express.Router();

/* ------------------------------------------------------------ limits */
/**
 * A fixed-window limiter, in memory.
 *
 * It protects two different things and so has two settings. The webhook is
 * open to the internet by way of the platform, and an unbounded stream of
 * bodies would fill np_int_events on a restaurant PC's disk. The
 * administrative API is behind a token, so its limit exists to stop a stuck
 * screen re-polling in a loop rather than to stop an attacker.
 */
const windows = new Map();
function limiter(name, limit, windowMs) {
  return (req, res, next) => {
    const key = name + '|' + (req.ip || 'x') + '|' + (req.params.provider || '');
    const now = Date.now();
    let w = windows.get(key);
    if (!w || now - w.start >= windowMs) { w = { start: now, n: 0 }; windows.set(key, w); }
    w.n++;
    if (w.n > limit) {
      res.set('Retry-After', String(Math.ceil((w.start + windowMs - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'Çok fazla istek', code: 'RATE_LIMITED' });
    }
    next();
  };
}
/* Housekeeping so a long-running till does not grow a map entry per address. */
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of windows) if (now - w.start > 600000) windows.delete(k);
}, 300000).unref();

/* =================================================================== *
 * WEBHOOK — unauthenticated by necessity, verified by signature        *
 * =================================================================== */
/**
 * Answer fast, process later.
 *
 * The handler verifies, stores and returns. Everything else - normalising,
 * opening the adisyon, printing - happens on the worker, so the platform's
 * timeout is never our database's problem. A replay is a 200 with
 * `duplicate: true`, because a provider retrying a delivery it already made is
 * behaving correctly and answering it with an error only makes it retry more.
 */
r.post('/webhook/:provider', limiter('webhook', 120, 60000), wrap(async (req, res) => {
  const provider = String(req.params.provider || '').toUpperCase();
  if (!registry.def(provider)) return fail(res, 'Bilinmeyen platform', 404, 'UNKNOWN_PROVIDER');
  const clientId = await db.getClientId();
  if (!clientId) return fail(res, 'Kurulum tamamlanmamış', 503, 'NOT_SET_UP');
  const branchId = Number(req.query.branch || 1) || 1;
  try {
    const out = await svc.receiveWebhook(clientId, provider, {
      headers: req.headers,
      rawBody: req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}),
      body: req.body, branchId,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    /* The body is never echoed back and the error text is ours, not the
       exception's stack: this endpoint answers the public internet. */
    log.warn('entegrasyon', 'webhook reddedildi', { provider, status: e.status || 500, error: e.message });
    res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code || null });
  }
}));

/* =================================================================== *
 * everything below needs a session                                    *
 * =================================================================== */
r.use(auth.requireAuth);
r.use(limiter('api', 600, 60000));

const canManage = auth.requirePerm('integration.manage');
const canOrder = auth.requirePerm('integration.order');
const canRead = auth.requirePerm('report.view');

/** Business errors answer in Turkish with their own status; bugs still 500. */
function guard(handler) {
  return wrap(async (req, res) => {
    try { await handler(req, res); }
    catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ ok: false, error: e.message, code: e.code || null });
    }
  });
}

/** The branch a request is about. Single-install tills only ever have one. */
function branchOf(req) { return Number(req.query.branch || req.body.branch_id || 1) || 1; }

/* ---------------------------------------------------------- overview */

r.get('/', canManage, guard(async (req, res) => ok(res, await mod.overview(req.clientId, branchOf(req)))));

/** The provider catalogue alone - the form shape, with no values in it. */
r.get('/providers', canManage, guard(async (req, res) => ok(res, { providers: registry.catalogue() })));

/* Wrapped in `health` rather than spread: the payload has its own `status`
   field (the connection's), and spreading it would put that word where a
   caller expects an HTTP code. The same reason the order actions answer
   `{ result }`. */
r.get('/health/:provider', canManage, guard(async (req, res) =>
  ok(res, { health: await svc.health(req.clientId, String(req.params.provider).toUpperCase(), branchOf(req)) })));

/* -------------------------------------------------------- connection */

r.post('/:provider/connection', canManage, guard(async (req, res) =>
  ok(res, await mod.saveConnection(req.clientId, String(req.params.provider).toUpperCase(),
    req.body || {}, req.auth.uid, branchOf(req)))));

r.post('/:provider/enable', canManage, guard(async (req, res) =>
  ok(res, await mod.setEnabled(req.clientId, String(req.params.provider).toUpperCase(),
    !!(req.body && req.body.enabled), req.auth.uid, branchOf(req)))));

r.post('/:provider/test', canManage, guard(async (req, res) => {
  const out = await mod.testConnection(req.clientId, String(req.params.provider).toUpperCase(),
    branchOf(req), req.auth.uid);
  /* A failed test is a 200 with ok:false inside: the screen wants to render
     the reason, not a red box with no text. */
  res.json({ ok: true, test: out });
}));

r.post('/:provider/restaurant-open', canManage, guard(async (req, res) =>
  ok(res, { result: await mod.setRestaurantOpen(req.clientId, String(req.params.provider).toUpperCase(),
    !!(req.body && req.body.open), req.auth.uid, branchOf(req)) })));

r.post('/:provider/prep-time', canManage, guard(async (req, res) =>
  ok(res, await mod.setPrepTime(req.clientId, String(req.params.provider).toUpperCase(),
    req.body && req.body.minutes, req.auth.uid, branchOf(req)))));

/* ------------------------------------------------------------ mapping */

r.get('/:provider/mapping', canManage, guard(async (req, res) =>
  ok(res, await mod.mapping(req.clientId, String(req.params.provider).toUpperCase(), branchOf(req)))));

r.post('/:provider/mapping/auto', canManage, guard(async (req, res) =>
  ok(res, await mod.autoMap(req.clientId, String(req.params.provider).toUpperCase(), branchOf(req), req.auth.uid))));

r.post('/:provider/mapping', canManage, guard(async (req, res) => {
  const b = req.body || {};
  ok(res, await mod.setMapping(req.clientId, String(req.params.provider).toUpperCase(),
    b.entity_type, b.external_id, b.local_id || null,
    { externalName: b.external_name || null, price: b.price === undefined ? null : b.price,
      branchId: branchOf(req), actorId: req.auth.uid, by: 'manual' }));
}));

/* --------------------------------------------------------------- menu */

r.post('/:provider/menu/sync', canManage, guard(async (req, res) =>
  ok(res, { result: await mod.syncMenu(req.clientId, String(req.params.provider).toUpperCase(),
    branchOf(req), req.auth.uid) })));

r.get('/:provider/menu/preview', canManage, guard(async (req, res) =>
  ok(res, { catalogue: await mod.buildCatalogue(req.clientId, String(req.params.provider).toUpperCase(), branchOf(req)) })));

r.post('/:provider/product/:id/availability', canManage, guard(async (req, res) =>
  ok(res, { result: await mod.setProductAvailability(req.clientId, String(req.params.provider).toUpperCase(),
    Number(req.params.id), !!(req.body && req.body.available), req.auth.uid, branchOf(req)) })));

r.post('/:provider/category/:id/availability', canManage, guard(async (req, res) =>
  ok(res, { result: await mod.setCategoryAvailability(req.clientId, String(req.params.provider).toUpperCase(),
    Number(req.params.id), !!(req.body && req.body.available), req.auth.uid, branchOf(req)) })));

r.post('/:provider/product/:id/price', canManage, guard(async (req, res) =>
  ok(res, { result: await mod.updatePrice(req.clientId, String(req.params.provider).toUpperCase(),
    Number(req.params.id), req.body && req.body.price, req.auth.uid, branchOf(req)) })));

/* ------------------------------------------------------------- orders */

r.get('/orders', canOrder, guard(async (req, res) => ok(res, await mod.orderList(req.clientId, {
  provider: req.query.provider ? String(req.query.provider).toUpperCase() : null,
  state: req.query.state || null, limit: req.query.limit, offset: req.query.offset, branchId: branchOf(req),
}))));

r.get('/orders/:id', canOrder, guard(async (req, res) =>
  ok(res, await mod.orderDetail(req.clientId, Number(req.params.id)))));

/**
 * One action on one order. The action is in the path so the audit trail reads
 * as itself, and the transition is checked in the module before anything is
 * sent anywhere.
 */
r.post('/orders/:id/:action', canOrder, guard(async (req, res) => {
  const action = String(req.params.action);
  if (action === 'reprint') return ok(res, await mod.reprint(req.clientId, Number(req.params.id), req.auth.name));
  if (!svc.ACTIONS[action]) return fail(res, 'Bilinmeyen işlem: ' + action, 400, 'UNKNOWN_ACTION');
  const b = req.body || {};
  ok(res, { result: await svc.orderAction(req.clientId, Number(req.params.id), action, {
    prepMinutes: b.prep_minutes, reason: b.reason || null, reasonCode: b.reason_code || null,
    actor: req.auth.name || String(req.auth.uid),
  }) });
}));

/* ------------------------------------------------------- log & retry */

r.get('/logs', canRead, guard(async (req, res) => ok(res, await mod.logList(req.clientId, {
  provider: req.query.provider ? String(req.query.provider).toUpperCase() : null,
  level: req.query.level || null, action: req.query.action || null,
  limit: req.query.limit, offset: req.query.offset,
}))));

r.get('/events', canManage, guard(async (req, res) => ok(res, await mod.eventList(req.clientId, {
  state: req.query.state || null,
  provider: req.query.provider ? String(req.query.provider).toUpperCase() : null,
  limit: req.query.limit,
}))));

/* Declared before the :id route so "retry-all" is never read as an id, the
   same way /api/device does it. */
r.post('/events/retry-all', canManage, guard(async (req, res) =>
  ok(res, await mod.retryAllFailed(req.clientId, req.auth.uid))));

r.post('/events/:id/retry', canManage, guard(async (req, res) =>
  ok(res, await mod.retryEvent(req.clientId, Number(req.params.id), req.auth.uid))));

/* A demonstration order, simulator connections only - see modules/integrations. */
r.post('/:provider/demo-order', canManage, guard(async (req, res) =>
  ok(res, await mod.demoOrder(req.clientId, req.params.provider, branchOf(req)))));

r.post('/poll', canManage, guard(async (req, res) =>
  ok(res, await mod.pollNow(req.clientId,
    req.body && req.body.provider ? String(req.body.provider).toUpperCase() : null))));

module.exports = r;
