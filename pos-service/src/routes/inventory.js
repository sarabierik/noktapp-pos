'use strict';
/**
 * Stok / depo API.
 *
 * One router for the whole module: raw materials, suppliers, purchase
 * documents, levels, sayim, zayi, transfers and recipes. The old system spread
 * the same job over nine PHP files with a different security check in each
 * (`item_delete.php` was a GET with no CSRF token at all); here everything sits
 * behind one `requireAuth` and the writes behind `stock.manage`.
 */
const express = require('express');
const auth = require('../auth');
const inv = require('../modules/inventory');
const { ok, fail, wrap } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);

const canWrite = auth.requirePerm('stock.manage');
/*
 * Reading stock is gated too, on the same key the Stok screen is registered
 * under in the client. It was open to anybody with a session, and what it
 * shows is not the sold-out marks a waiter needs - that is /api/pos/stock,
 * which stays open - but purchase prices, supplier prices, recipe yields and
 * what every dish costs to make. A waiter had all of it for the asking.
 */
const canRead = auth.requirePerm('stock.manage');
r.use(canRead);

/*
 * A validation failure here is an ordinary answer, not a crash: "zayi nedeni
 * secilmeli" is something the screen shows next to the field. Letting it reach
 * the global handler would print a stack trace into the service log for every
 * mistyped form, which is how a real fault gets lost in the noise. Anything
 * without a status is still a bug and still goes to the handler.
 */
function safe(fn) {
  return wrap(async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e) {
      if (e && e.status) return fail(res, e.message, e.status);
      throw e;
    }
  });
}

/* --------------------------- dashboard ---------------------------- */
r.get('/summary', safe(async (req, res) => ok(res, { summary: await inv.summary(req.clientId) })));

/* ---------------------------- reference --------------------------- */
r.get('/units', safe(async (req, res) => ok(res, {
  units: inv.units(), custom: await inv.customUnits(req.clientId) })));
r.post('/units', canWrite, safe(async (req, res) =>
  ok(res, { id: await inv.saveCustomUnit(req.clientId, req.body.name) })));
r.delete('/units/:id', canWrite, safe(async (req, res) => {
  await inv.deleteCustomUnit(req.clientId, req.params.id); ok(res);
}));

r.get('/categories', safe(async (req, res) => ok(res, { categories: await inv.categories(req.clientId) })));
r.post('/categories', canWrite, safe(async (req, res) =>
  ok(res, { id: await inv.saveCategory(req.clientId, req.body.name) })));

r.get('/locations', safe(async (req, res) => ok(res, { locations: await inv.locations(req.clientId) })));
r.post('/locations', canWrite, safe(async (req, res) =>
  ok(res, { id: await inv.saveLocation(req.clientId, req.body) })));
/** Creates the default depot if there is none, so the transfer screen always has two ends. */
r.post('/locations/default', canWrite, safe(async (req, res) =>
  ok(res, { id: await inv.defaultLocation(req.clientId) })));

/* ------------------------------ items ----------------------------- */
r.get('/items', safe(async (req, res) => ok(res, {
  items: await inv.items(req.clientId, { q: req.query.q || '', onlyActive: req.query.all !== '1' }) })));
r.get('/items/:id', safe(async (req, res) => {
  const item = await inv.getItem(req.clientId, req.params.id);
  if (!item) return fail(res, 'Malzeme bulunamadı', 404);
  ok(res, { item, level: await inv.levelFor(req.clientId, req.params.id),
    ledger: await inv.ledger(req.clientId, req.params.id),
    by_location: await inv.levelsByLocation(req.clientId, req.params.id) });
}));
r.post('/items', canWrite, safe(async (req, res) =>
  ok(res, { id: await inv.saveItem(req.clientId, req.body) })));
r.delete('/items/:id', canWrite, safe(async (req, res) =>
  ok(res, await inv.deleteItem(req.clientId, req.params.id))));

/* ---------------------------- suppliers --------------------------- */
r.get('/suppliers', safe(async (req, res) => ok(res, {
  suppliers: await inv.suppliers(req.clientId, { onlyActive: req.query.active === '1' }) })));
r.post('/suppliers', canWrite, safe(async (req, res) =>
  ok(res, { id: await inv.saveSupplier(req.clientId, req.body) })));
r.delete('/suppliers/:id', canWrite, safe(async (req, res) =>
  ok(res, await inv.deleteSupplier(req.clientId, req.params.id))));

/* ------------------------ purchase documents ---------------------- */
r.get('/documents', safe(async (req, res) => ok(res, {
  documents: await inv.documents(req.clientId, {
    status: req.query.status || null, from: req.query.from || null, to: req.query.to || null }) })));
r.get('/documents/:id', safe(async (req, res) => {
  const doc = await inv.getDocument(req.clientId, req.params.id);
  if (!doc) return fail(res, 'Belge bulunamadı', 404);
  ok(res, { document: doc });
}));
r.post('/documents', canWrite, safe(async (req, res) =>
  ok(res, { id: await inv.saveDocument(req.clientId, req.body, req.auth.uid) })));
/** Approval is the event that moves the stock. A draft has moved nothing. */
r.post('/documents/:id/approve', canWrite, safe(async (req, res) =>
  ok(res, await inv.approveDocument(req.clientId, req.params.id, req.auth.uid))));
r.post('/documents/:id/cancel', canWrite, safe(async (req, res) =>
  ok(res, await inv.cancelDocument(req.clientId, req.params.id, req.auth.uid))));

/* ----------------------------- levels ----------------------------- */
r.get('/levels', safe(async (req, res) => ok(res, {
  levels: await inv.levels(req.clientId, {
    q: req.query.q || '',
    onlyActive: req.query.all !== '1',
    criticalOnly: req.query.critical === '1' }) })));
r.get('/levels/:id/ledger', safe(async (req, res) => ok(res, {
  ledger: await inv.ledger(req.clientId, req.params.id) })));
/** Ledger rows whose item was deleted by the old system - visible at last. */
r.get('/orphans', safe(async (req, res) => ok(res, { orphans: await inv.orphanLedger(req.clientId) })));

/* ---------------------------- recipes ----------------------------- */
r.get('/recipes', safe(async (req, res) => ok(res, { products: await inv.recipeProducts(req.clientId) })));
r.get('/recipes/:productId', safe(async (req, res) => ok(res, {
  recipe: await inv.recipeFor(req.clientId, req.params.productId),
  costing: await inv.recipeCost(req.clientId, req.params.productId) })));
r.post('/recipes/:productId', canWrite, safe(async (req, res) =>
  ok(res, await inv.saveRecipe(req.clientId, req.params.productId, req.body.lines || []))));

/* ------------------------- sayim (counts) ------------------------- */
r.get('/counts', safe(async (req, res) => ok(res, { counts: await inv.counts(req.clientId) })));
r.get('/counts/:id', safe(async (req, res) => {
  const c = await inv.getCount(req.clientId, req.params.id);
  if (!c) return fail(res, 'Sayım bulunamadı', 404);
  ok(res, { count: c });
}));
r.post('/counts', canWrite, safe(async (req, res) =>
  ok(res, { id: await inv.openCount(req.clientId, req.body, req.auth.uid) })));
r.post('/counts/:id/lines', canWrite, safe(async (req, res) => {
  await inv.saveCountLines(req.clientId, req.params.id, req.body.lines || []); ok(res);
}));
r.post('/counts/:id/approve', canWrite, safe(async (req, res) =>
  ok(res, await inv.approveCount(req.clientId, req.params.id, req.auth.uid))));
r.post('/counts/:id/cancel', canWrite, safe(async (req, res) => {
  await inv.cancelCount(req.clientId, req.params.id); ok(res);
}));

/* --------------------------- zayi (waste) ------------------------- */
r.get('/waste/reasons', safe(async (req, res) => ok(res, { reasons: inv.wasteReasons() })));
r.get('/waste', safe(async (req, res) => ok(res, {
  waste: await inv.wasteList(req.clientId, { from: req.query.from, to: req.query.to }) })));
r.post('/waste', canWrite, safe(async (req, res) =>
  ok(res, await inv.recordWaste(req.clientId, req.body, req.auth.uid))));

/* --------------------------- transfers ---------------------------- */
r.get('/transfers', safe(async (req, res) => ok(res, { transfers: await inv.transfers(req.clientId) })));
r.post('/transfers', canWrite, safe(async (req, res) =>
  ok(res, await inv.transfer(req.clientId, req.body, req.auth.uid))));

/* ---------------------- the sale <-> stock link ------------------- */
/*
 * These two exist so that every close path - the cashier's button, the OKC
 * callback, the phone app, a replayed offline bill - can reach the SAME
 * function over the same door. The old system had four copies of the deduction
 * and the OKC path had none, so a card payment banked the money and left the
 * stock alone.
 */
r.post('/orders/:orderId/apply', safe(async (req, res) =>
  ok(res, await inv.applyStockForOrder(req.clientId, req.params.orderId, req.auth.uid))));
r.post('/orders/:orderId/reverse', safe(async (req, res) =>
  ok(res, await inv.reverseStockForOrder(req.clientId, req.params.orderId, req.auth.uid))));
r.get('/orders/:orderId/consumption', safe(async (req, res) => ok(res, {
  consumption: await inv.consumptionForOrder(req.clientId, req.params.orderId) })));

module.exports = r;
