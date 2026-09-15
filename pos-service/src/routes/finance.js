'use strict';
/**
 * /api/finance - the back office: İşlemler, Gün sonu, Finans raporu.
 *
 * Two gates, and they are not the same gate:
 *
 *   requirePerm('report.view')  - reading. A cashier can be given this.
 *   requireOwner                - anything that moves money off the books.
 *
 * The owner gate is the important one. The PHP hid the delete buttons from
 * non-owners in the template and then checked again in the handler, with the
 * comment "hiding a button is not a permission" - it was right, and the same
 * check is here, on the server, on every destructive route.
 */
const express = require('express');
const auth = require('../auth');
const finance = require('../modules/finance');
const printing = require('../print');
const report = require('../report');
const { ok, fail, wrap } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);

/**
 * Who counts as the owner.
 *
 * The PHP's `is_owner()` was literally the tenant login (`user.id === 'client'`)
 * - staff never passed it, not even staff with role `admin`, because an admin
 * account is a manager the owner created and a manager should not be able to
 * erase last month's takings unnoticed. The same login here issues a token with
 * `kind:'tenant'`. `superadmin` is the tenant's own staff identity on the till,
 * so it passes too; `admin` deliberately does not.
 */
/*
 * The check itself now lives in auth.js, unchanged, because the restore screen
 * needs the same one and a security rule that exists in two files is a rule
 * that will one day be true in one of them.
 */
const isOwner = auth.isOwner;
const requireOwner = auth.requireOwner;

/** Who did it, for the audit rows. */
function actor(req) {
  return {
    userId: req.auth.uid || null,
    role: req.auth.role || null,
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().slice(0, 45),
    userAgent: req.headers['user-agent'] || '',
    reason: (req.body && req.body.reason) || '',
  };
}

const range = (req) => ({ from: req.query.from, to: req.query.to });

/* --------------------------------------------------------- context ---- */
/*
 * The screen needs to know two things before it draws a single button: is this
 * session the owner, and where is the checkpoint. Asking once beats every
 * screen guessing.
 */
r.get('/context', wrap(async (req, res) => ok(res, {
  is_owner: isOwner(req.auth),
  checkpoint: await finance.checkpoint(req.clientId),
  can_close: req.auth.role === 'admin' || req.auth.role === 'superadmin'
    || (await auth.permissionsFor(req.clientId, req.auth.uid, req.auth.role)).includes('day.close'),
})));

/* ------------------------------------------------------ işlemler ------ */
r.get('/transactions', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const out = await finance.transactions(req.clientId, {
    from: req.query.from, to: req.query.to, status: req.query.status,
    q: req.query.q, limit: req.query.limit,
  });
  ok(res, { ...out, is_owner: isOwner(req.auth) });
}));

r.get('/transactions/:id(\\d+)', auth.requirePerm('report.view'), wrap(async (req, res) => {
  try { ok(res, await finance.orderDetail(req.clientId, Number(req.params.id))); }
  catch (e) { fail(res, e.message, e.status || 400, e.code); }
}));

r.post('/transactions/delete', requireOwner, wrap(async (req, res) => {
  try { ok(res, await finance.deleteSelected(req.clientId, req.body.ids, actor(req))); }
  catch (e) { fail(res, e.message, e.status || 400, e.code); }
}));

/*
 * Kalici silme - the bill stops existing.
 *
 * A separate route from /delete on purpose. "Take it off the books" and
 * "remove it from the system" are different decisions with different
 * consequences, and a single endpoint with a `hard: true` flag is how one of
 * them gets sent by accident. Owner only, reason mandatory, and the module
 * refuses anything inside a closed day.
 */
r.post('/transactions/purge', requireOwner, wrap(async (req, res) => {
  try { ok(res, await finance.purgeSelected(req.clientId, req.body.ids, actor(req))); }
  catch (e) { fail(res, e.message, e.status || 400, e.code); }
}));

r.post('/transactions/bulk-delete', requireOwner, wrap(async (req, res) => {
  const method = String(req.body.method || '');
  if (!method) return fail(res, 'Ödeme yöntemi gerekli');
  try {
    ok(res, await finance.deleteByMethod(req.clientId, method, req.body.from, req.body.to, actor(req)));
  } catch (e) { fail(res, e.message, e.status || 400, e.code); }
}));

r.post('/transactions/:id(\\d+)/delete', requireOwner, wrap(async (req, res) => {
  try {
    const out = await finance.deleteSelected(req.clientId, [Number(req.params.id)], actor(req));
    if (out.locked) return fail(res, finance.LOCK_MESSAGE, 409, 'DAY_CLOSED');
    if (out.missing) return fail(res, 'Adisyon bulunamadı', 404);
    if (out.already) return fail(res, 'Bu adisyon zaten raporlardan çıkarılmış', 409);
    ok(res, out);
  } catch (e) { fail(res, e.message, e.status || 400, e.code); }
}));

r.post('/transactions/:id(\\d+)/restore', requireOwner, wrap(async (req, res) => {
  try { ok(res, await finance.restore(req.clientId, Number(req.params.id), actor(req))); }
  catch (e) { fail(res, e.message, e.status || 400, e.code); }
}));

/* ------------------------------------------------------- gün sonu ----- */
r.get('/days', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const { from, to } = range(req);
  ok(res, await finance.dayList(req.clientId, from, to, String(req.query.only_closed || '') === '1'));
}));

r.get('/days/:date', auth.requirePerm('report.view'), wrap(async (req, res) =>
  ok(res, await finance.dayDetail(req.clientId, req.params.date))));

r.post('/days/:date/close', auth.requirePerm('day.close'), wrap(async (req, res) => {
  try {
    const out = await finance.closeDay(req.clientId, {
      date: req.params.date, userId: req.auth.uid || null, role: req.auth.role,
      declaredCash: req.body.declared_cash, declaredCard: req.body.declared_card,
      ip: actor(req).ip, userAgent: actor(req).userAgent, reason: req.body.reason,
    });
    if (req.body.print) {
      // the paper Z, from the same figures that were just signed off
      const z = await require('../modules/reports').zReport(req.clientId, out.date);
      await printing.queueReport(req.clientId, z, 'Z').catch(() => {});
    }
    ok(res, { closing: out });
  } catch (e) { fail(res, e.message, e.status || 400, e.code); }
}));

/*
 * Reopening is destructive in the way that matters: it unfreezes bills that
 * were signed off. Owner only, and it needs the day.reopen permission as well.
 */
r.post('/days/:date/reopen', requireOwner, auth.requirePerm('day.reopen'), wrap(async (req, res) => {
  try { ok(res, await finance.reopenDay(req.clientId, req.params.date, actor(req))); }
  catch (e) { fail(res, e.message, e.status || 400, e.code); }
}));

r.post('/days/:date/mail', auth.requirePerm('report.view'), wrap(async (req, res) => {
  try { ok(res, await finance.mailDaySummary(req.clientId, req.params.date, req.body.to)); }
  catch (e) { fail(res, e.message, e.status || 400, e.code); }
}));

/* --------------------------------------------------- finans raporu ---- */
r.get('/report', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const { from, to } = range(req);
  ok(res, await finance.financeReport(req.clientId, from, to));
}));

r.get('/payments', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const { from, to } = range(req);
  ok(res, await finance.paymentSplit(req.clientId, from, to));
}));

r.get('/discounts', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const { from, to } = range(req);
  ok(res, await finance.discountReport(req.clientId, from, to));
}));

r.get('/cancellations', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const { from, to } = range(req);
  ok(res, await finance.cancellationReport(req.clientId, from, to));
}));

/* ------------------------------------------------------- X raporu ----- */
r.get('/x-report', auth.requirePerm('report.view'), wrap(async (req, res) =>
  ok(res, { report: await finance.xReport(req.clientId, req.query.date) })));

r.post('/x-report/print', auth.requirePerm('report.view'), wrap(async (req, res) => {
  const x = await finance.xReport(req.clientId, req.body.date);
  await printing.queueReport(req.clientId, x, 'X');
  ok(res);
}));

/* -------------------------------------------------------- exports ----- */
/*
 * CSV, Excel and PDF off one pack, and the PDF is not an afterthought: the
 * accountant files the PDF and works in the spreadsheet, and they have to be
 * the same report. Both come from finance.exportPack, so they cannot be.
 *
 * No `?token=` any more. The till fetches these with the Authorization header
 * the rest of the app already uses and saves the Blob itself, so a session
 * token no longer lands in the browser history or in an access log.
 */
r.get('/export/:kind', auth.requirePerm('report.export'), wrap(async (req, res) => {
  try {
    const pack = await finance.exportPack(req.clientId, req.params.kind, {
      from: req.query.from, to: req.query.to, date: req.query.date,
      status: req.query.status, q: req.query.q,
      only_closed: String(req.query.only_closed || '') === '1',
      limit: 100000,
    });
    await report.deliver(res, req.clientId, pack, {
      format: req.query.format,
      producedBy: req.auth.name || req.auth.role || '-',
    });
  } catch (e) { fail(res, e.message, e.status || 400, e.code); }
}));

module.exports = r;
