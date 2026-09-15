'use strict';
/**
 * /api/receipt - fiş ayarları, yazıcı ayarları, müşteri ekranı.
 *
 * GET / carries more than the values now: the live doviz_kurlari rows (so the
 * screen can say where the rate on the paper comes from and how old it is,
 * rather than naming a source and leaving the owner to trust it) and the
 * warnings for a choice that cannot be honoured - a currency with no rate, a
 * karekod mode with no address. Both are computed in modules/receipt, because
 * the renderers answer those cases by printing NOTHING, and this endpoint is
 * the only place that silence can be explained.
 *
 * The three things the owner said had "no place". Everything here needs
 * settings.manage, except the printer writes, which need printer.manage the
 * same way /api/settings/printers does - the two screens must not disagree
 * about who is allowed to touch a printer.
 *
 * Failures are answered, not thrown: a settings screen showing a bare 500 tells
 * the owner nothing he can act on. A test print that fails is a 200 with
 * printed:false and the socket's own complaint, because an unplugged printer is
 * the normal answer during setup, not an exception.
 */
const express = require('express');
const auth = require('../auth');
const receipt = require('../modules/receipt');
const { ok, wrap } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);

function guard(handler) {
  return wrap(async (req, res) => {
    try { await handler(req, res); }
    catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ ok: false, error: e.message });
    }
  });
}

const canSettings = auth.requirePerm('settings.manage');
const canPrinters = auth.requirePerm('printer.manage');

/* ============================ fiş ayarları ========================== */

r.get('/', canSettings, guard(async (req, res) => ok(res, await receipt.get(req.clientId))));

r.post('/', canSettings, guard(async (req, res) => {
  const patch = req.body && req.body.settings ? req.body.settings : req.body;
  ok(res, await receipt.save(req.clientId, patch, req.auth.uid));
}));

/**
 * The preview. `paper` renders 58 or 80 without changing what the till is set
 * to, so the owner can see what a change would cost him before he makes it.
 */
r.get('/preview', canSettings, guard(async (req, res) => ok(res,
  await receipt.preview(req.clientId, { paper: req.query.paper, orderId: req.query.order_id }))));

/**
 * The same preview, over the UNSAVED form. This is what makes the preview live:
 * the screen posts what has been typed, the real ESC/POS builder renders it,
 * and nothing is written until Kaydet.
 */
r.post('/preview', canSettings, guard(async (req, res) => {
  const b = req.body || {};
  ok(res, await receipt.preview(req.clientId,
    { paper: b.paper, orderId: b.order_id, draft: b.draft || b.settings || null }));
}));

/* =========================== yazıcı ayarları ======================== */

r.get('/printers', canSettings, guard(async (req, res) => ok(res, {
  ...(await receipt.listPrinters(req.clientId)),
  queue: await receipt.queue(req.clientId, { limit: req.query.jobs || 40 }),
})));

r.post('/printers', canPrinters, guard(async (req, res) =>
  ok(res, await receipt.savePrinter(req.clientId, req.body, req.auth.uid))));

r.delete('/printers/:id', canPrinters, guard(async (req, res) => {
  await receipt.deletePrinter(req.clientId, Number(req.params.id));
  ok(res);
}));

/** Which machine the hesap fişi comes out of - and the paper follows it. */
r.post('/printers/:id/receipt', canPrinters, guard(async (req, res) =>
  ok(res, await receipt.setReceiptPrinter(req.clientId, Number(req.params.id), req.auth.uid))));

/*
 * Find the printers on the network instead of asking for an IP address.
 *
 * Nobody at a counter knows the address of the box under the till, so the
 * field stayed empty and the printer never got added. This sweeps the /24 the
 * PC is on for port 9100 and hands back what answered. It is a slow endpoint
 * by nature - a few seconds - so it is a POST the user asks for by pressing a
 * button, never something a screen does on load.
 */
r.post('/printers/scan', canPrinters, guard(async (req, res) => {
  const discover = require('../print/discover');
  const out = await discover.scan({
    subnet: req.body && req.body.subnet ? String(req.body.subnet) : null,
    timeoutMs: Math.min(Math.max(Number((req.body || {}).timeout_ms) || 500, 120), 2000),
  });
  ok(res, out);
}));

r.post('/printers/:id/test', canPrinters, guard(async (req, res) =>
  ok(res, await receipt.testPrinter(req.clientId, Number(req.params.id)))));

/* ============================ istasyonlar =========================== */

/*
 * The station endpoints the İstasyonlar tab uses, beside the printer ones
 * because that is the pair the screen edits together.
 *
 * Permission is settings.manage, NOT printer.manage - deliberately the same as
 * /api/settings/stations, the older path the phone app still calls. Adding a
 * station is a decision about how the menu is routed, not about a machine, and
 * two callers writing the same rows under two different permissions is how a
 * manager gets a 403 from one place and a 200 from the other for the same
 * edit.
 */
r.get('/stations', canSettings, guard(async (req, res) =>
  ok(res, await receipt.stationOverview(req.clientId))));

r.post('/stations', canSettings, guard(async (req, res) =>
  ok(res, { id: await receipt.saveStation(req.clientId, req.body) })));

/** Hard delete. Refused with the count when anything was ever sent here. */
r.delete('/stations/:id', canSettings, guard(async (req, res) =>
  ok(res, await receipt.deleteStation(req.clientId, Number(req.params.id)))));

/** Pasife al / geri aç - the answer to a station that cannot be deleted. */
r.post('/stations/:id/active', canSettings, guard(async (req, res) =>
  ok(res, await receipt.setStationActive(req.clientId, Number(req.params.id), !!(req.body || {}).active))));

r.post('/stations/order', canSettings, guard(async (req, res) =>
  ok(res, { ordered: await receipt.reorderStations(req.clientId, (req.body || {}).ids) })));

r.post('/stations/:id/default', canSettings, guard(async (req, res) => {
  await receipt.setDefaultStation(req.clientId, Number(req.params.id));
  ok(res);
}));

r.post('/stations/:id/categories', canSettings, guard(async (req, res) =>
  ok(res, { assigned: await receipt.assignCategories(req.clientId, Number(req.params.id), (req.body || {}).category_ids) })));

/* ============================== kuyruk ============================== */

r.get('/queue', canSettings, guard(async (req, res) =>
  ok(res, await receipt.queue(req.clientId, { status: req.query.status, limit: req.query.limit }))));

r.post('/queue/retry-failed', canPrinters, guard(async (req, res) =>
  ok(res, { retried: await receipt.retryFailed(req.clientId) })));

r.post('/queue/:id/retry', canPrinters, guard(async (req, res) => {
  await receipt.retryJob(req.clientId, Number(req.params.id));
  ok(res);
}));

r.post('/queue/:id/cancel', canPrinters, guard(async (req, res) => {
  await receipt.cancelJob(req.clientId, Number(req.params.id));
  ok(res);
}));

/* =========================== müşteri ekranı ========================= */

r.get('/display', canSettings, guard(async (req, res) => ok(res, await receipt.displaySettings())));

r.post('/display', canSettings, guard(async (req, res) => ok(res, await receipt.saveDisplay(req.body))));

module.exports = r;
