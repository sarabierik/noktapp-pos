'use strict';
/**
 * /api/guest - the guest-facing side and the screens that manage it.
 *
 * The shape of this file is unusual and deliberate: the FIRST route has no
 * authentication at all, and every route after it requires a session. That
 * order is the whole security model of the digital menu.
 *
 *   * `/api/guest/menu` is reached by a stranger's phone, from the street,
 *     with nothing but what is printed on a table card. It is read-only, it
 *     returns name/price/description and nothing else, and the token is the
 *     only credential there can ever be.
 *   * everything below `r.use(auth.requireAuth)` is a member of staff.
 *
 * Anything added later therefore lands in the authenticated half by default,
 * which is the right way round for a mistake to fall.
 */
const express = require('express');
const auth = require('../auth');
const guest = require('../modules/guest');
const qrcard = require('../modules/qrcard');
const { ok, fail, wrap } = require('../util/http');

const r = express.Router();

/* ==================================================================== *
 * PUBLIC - no session, no cookie, read only                            *
 * ==================================================================== */

/**
 * The menu a scanned card opens. `m` is the table's qr_token, the same one
 * floor.js prints on the card.
 *
 * No-store rather than a cache window: a price changed at 11:00 has to be on
 * the table at 11:00, and a stale menu is an argument at the counter.
 */
r.get('/menu', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.set('X-Robots-Tag', 'noindex, nofollow');   // a table's menu is not a web page to be found
  try {
    ok(res, await guest.publicMenu(req.query.m || req.query.token, req.query.tpl || null));
  } catch (e) {
    fail(res, e.message, e.status || 404);
  }
}));

/* ==================================================================== *
 * STAFF                                                                *
 * ==================================================================== */
r.use(auth.requireAuth);

const canSettings = auth.requirePerm('settings.manage');
const canCustomer = auth.requirePerm('customer.manage');
const canProducts = auth.requirePerm('product.manage');

/* ------------------------------- dijital menü ----------------------- */
r.get('/qr/settings', wrap(async (req, res) => ok(res, await guest.qrSettings(req.clientId))));

r.post('/qr/settings', canSettings, wrap(async (req, res) =>
  ok(res, await guest.saveQrSettings(req.clientId, req.body))));

/** One choice, one column - see guest.saveDesign. */
r.post('/qr/design', canSettings, wrap(async (req, res) =>
  ok(res, await guest.saveDesign(req.clientId, req.body))));

r.get('/qr/flags', wrap(async (req, res) => ok(res, { categories: await guest.qrFlags(req.clientId) })));

r.post('/qr/flags', canProducts, wrap(async (req, res) => {
  const on = !!req.body.on;
  if (req.body.kind === 'category' && req.body.cascade) {
    return ok(res, await guest.setCategoryQrBulk(req.clientId, req.body.id, on));
  }
  ok(res, await guest.setQrFlag(req.clientId, req.body.kind, req.body.id, on));
}));

r.get('/qr/preview', wrap(async (req, res) =>
  ok(res, await guest.previewMenu(req.clientId, req.query.tpl || null))));

/* ------------------------------ masa kartlari ----------------------- */
/** What would be printed, without printing it: designs, handles, warnings. */
r.get('/qr/cards', wrap(async (req, res) =>
  ok(res, await qrcard.cardData(req.clientId, { tableId: req.query.table || null }))));

/**
 * The print-ready A5 file. `?table=` narrows it to one card - a table whose
 * card was spilled on does not need a reprint of the other thirty-nine.
 *
 * Sent as a download rather than rendered: this file's whole purpose is to be
 * forwarded to a print shop, and a PDF that opens in a viewer tab is a PDF the
 * user then has to work out how to save.
 */
r.get('/qr/cards.pdf', wrap(async (req, res) => {
  const one = req.query.table || null;
  const data = await qrcard.cardData(req.clientId, { tableId: one });
  const buf = await qrcard.cardsPdf(req.clientId, { tableId: one, design: req.query.design || null });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="${qrcard.pdfName(data.brand, one ? data.cards[0].name : null)}"`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}));

/* -------------------------------- müşteriler ------------------------ */
r.get('/customers', wrap(async (req, res) =>
  ok(res, { customers: await guest.searchCustomers(req.clientId, req.query.q, req.query.limit) })));

r.post('/customers', canCustomer, wrap(async (req, res) =>
  ok(res, await guest.saveCustomer(req.clientId, req.body))));

r.get('/customers/top', wrap(async (req, res) =>
  ok(res, { customers: await guest.topCustomers(req.clientId, req.query.from, req.query.to) })));

r.get('/customers/:id', wrap(async (req, res) =>
  ok(res, await guest.customerDetail(req.clientId, req.params.id))));

/** Attach (or detach, with a null id) a guest to an open bill. */
r.post('/orders/:id/customer', canCustomer, wrap(async (req, res) =>
  ok(res, await guest.attachToOrder(req.clientId, req.params.id, req.body.customer_id))));

/* --------------------------------- sadakat -------------------------- */
r.get('/loyalty/programs', wrap(async (req, res) =>
  ok(res, { programs: await guest.programList(req.clientId) })));

r.post('/loyalty/programs', canSettings, wrap(async (req, res) =>
  ok(res, await guest.saveProgram(req.clientId, req.body))));

r.post('/loyalty/programs/:id/toggle', canSettings, wrap(async (req, res) =>
  ok(res, await guest.toggleProgram(req.clientId, req.params.id))));

r.get('/loyalty/cards', wrap(async (req, res) => ok(res, {
  cards: await guest.cardList(req.clientId, { q: req.query.q, ready: req.query.ready === '1' }),
})));

r.get('/loyalty/cards/:id/history', wrap(async (req, res) =>
  ok(res, { events: await guest.cardHistory(req.clientId, req.params.id) })));

r.get('/loyalty/report', auth.requirePerm('report.view'), wrap(async (req, res) =>
  ok(res, await guest.loyaltyReport(req.clientId, req.query.from || null, req.query.to || null))));

r.post('/loyalty/stamp', canCustomer, wrap(async (req, res) => ok(res, await guest.manualStamp(req.clientId, {
  customerId: req.body.customer_id, programId: req.body.program_id,
  qty: req.body.qty, reason: req.body.reason, userId: req.auth.uid,
}))));

r.post('/loyalty/redeem', canCustomer, wrap(async (req, res) => ok(res, await guest.manualRedeem(req.clientId, {
  customerId: req.body.customer_id, cardId: req.body.card_id,
  orderId: req.body.order_id || null, reason: req.body.reason, userId: req.auth.uid,
}))));

/* --------------------------------- kurulum -------------------------- */
r.get('/setup/state', wrap(async (req, res) => ok(res, await guest.setupState(req.clientId))));

r.post('/setup/vat', canSettings, wrap(async (req, res) =>
  ok(res, await guest.saveVat(req.clientId, req.body))));

r.post('/setup/general', canSettings, wrap(async (req, res) =>
  ok(res, await guest.saveGeneral(req.clientId, req.body, req.auth.uid))));

r.post('/setup/categories/preset', canProducts, wrap(async (req, res) =>
  ok(res, await guest.applyCategoryPreset(req.clientId, req.body.set))));

r.post('/setup/menu/preview', canProducts, wrap(async (req, res) =>
  ok(res, await guest.importMenuPreview(req.clientId, req.body))));

r.post('/setup/menu/apply', canProducts, wrap(async (req, res) =>
  ok(res, await guest.importMenuApply(req.clientId, req.body, req.auth.uid))));

module.exports = r;
