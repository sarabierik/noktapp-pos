'use strict';
const express = require('express');
const auth = require('../auth');
const reports = require('../modules/reports');
const pnl = require('../modules/pnl');
const printing = require('../print');
const report = require('../report');
const { ok, fail, wrap } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);

/*
 * `report.view`, like every other figure on this router.
 *
 * It was the one report with no permission on it, and it is the richest: the
 * day's takings, the discount total, the VAT, the split by payment method, the
 * hourly curve and the top sellers. The Raporlar page that draws it has been
 * behind `report.view` in the client since it was written, so nothing a waiter
 * can open ever asked for it - but the endpoint answered anybody with a valid
 * session, and a waiter's session is a valid session. The gate now says out
 * loud what the navigation already assumed.
 */
r.get('/dashboard', auth.requirePerm('report.view'), wrap(async (req, res) => ok(res, await reports.dashboard(req.clientId))));

r.get('/z', auth.requirePerm('report.view'), wrap(async (req, res) =>
  ok(res, { report: await reports.zReport(req.clientId, req.query.date) })));

r.post('/z/print', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const z = await reports.zReport(req.clientId, req.body.date);
  await printing.queueReport(req.clientId, z, req.body.kind || 'Z');
  ok(res);
}));

r.post('/close-day', auth.requirePerm('day.close'), wrap(async (req, res) => {
  try {
    const z = await reports.closeDay(req.clientId, {
      userId: req.auth.uid, declaredCash: req.body.declared_cash || 0, declaredCard: req.body.declared_card || 0,
    });
    if (req.body.print !== false) await printing.queueReport(req.clientId, z, 'Z');
    ok(res, { report: z });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

r.post('/reopen-day', auth.requirePerm('day.reopen'), wrap(async (req, res) => {
  try { await reports.reopenDay(req.clientId, req.body.date, req.auth.uid); ok(res); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

r.get('/sales', auth.requirePerm('report.view'), wrap(async (req, res) =>
  ok(res, { rows: await reports.salesRange(req.clientId, req.query.from, req.query.to) })));

r.get('/products', auth.requirePerm('report.view'), wrap(async (req, res) =>
  ok(res, { rows: await reports.productSales(req.clientId, req.query.from, req.query.to) })));

r.get('/waiters', auth.requirePerm('report.view'), wrap(async (req, res) =>
  ok(res, { rows: await reports.waiterPerformance(req.clientId, req.query.from, req.query.to) })));

r.get('/cancellations', auth.requirePerm('report.view'), wrap(async (req, res) =>
  ok(res, await reports.cancelReport(req.clientId, req.query.from, req.query.to))));

/* ------------------------- profit and loss ------------------------- */
/*
 * One range, everything about it. The screen needs the daily series, the
 * expense split, the product and category tables and the uncosted warning at
 * once; five round trips would be five chances to show an owner two panels
 * computed from different data.
 */
function range(req) {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || to;
  return { from, to };
}

r.get('/pnl', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const { from, to } = range(req);
  ok(res, await pnl.statement(req.clientId, from, to));
}));

r.get('/pnl/products', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const { from, to } = range(req);
  ok(res, { rows: await pnl.productProfit(req.clientId, from, to, Number(req.query.limit) || 200) });
}));

r.get('/pnl/categories', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const { from, to } = range(req);
  ok(res, { rows: await pnl.categoryProfit(req.clientId, from, to) });
}));

/*
 * Everything is exportable, in all three formats.
 *
 * This route used to hand reports.toCsv() a bag of raw MySQL rows: every cell
 * quoted, "1234.56" for money, "2026-09-01" for a date. In a Turkish Excel
 * that opens as a single column of text - the accountant can neither sum it
 * nor sort it. It now goes through the same typed sheets as the Finans
 * exports, and gains the PDF an accountant actually files.
 *
 * And no `?token=`: the till sends the Authorization header like every other
 * call, so the session token is no longer written into the browser history.
 */
r.get('/export/:kind', auth.requirePerm('report.export'), wrap(async (req, res) => {
  try {
    const pack = await reports.exportSheets(req.clientId, req.params.kind,
      { from: req.query.from, to: req.query.to });
    await report.deliver(res, req.clientId, pack, {
      format: req.query.format,
      producedBy: req.auth.name || req.auth.role || '-',
    });
  } catch (e) { fail(res, e.message, e.status || 404); }
}));

module.exports = r;
