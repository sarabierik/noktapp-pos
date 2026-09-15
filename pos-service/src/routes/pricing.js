'use strict';
/**
 * Fiyatlandırma API.
 *
 * One router for the pricing engine and for the product-card operations that
 * hang off a price - cost history, price history, delete, duplicate, bulk
 * change. The old system spread the same job over ten PHP files, every one of
 * them reachable only by typing its URL and none of them in the navigation.
 *
 * Two permissions, deliberately not one:
 *   `price.manage`   - anything that moves a price or decides a suggestion.
 *   `product.manage` - anything that changes what the menu IS: costs, deletes,
 *                      duplicates, category deactivation.
 * A manager who may re-price the drinks list is not necessarily the person who
 * may delete a product out of the menu, and the two grants already exist.
 */
const express = require('express');
const auth = require('../auth');
const pricing = require('../modules/pricing');
const { ok, fail, wrap } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);

/*
 * The whole router needs `price.manage` to READ, which is what the client has
 * always assumed: Fiyatlandırma is registered under that key and nothing else
 * calls these endpoints. Costs, margins, the suggested prices and the reasons
 * behind them are the owner's figures, and they were readable by every waiter
 * who could sign in.
 */
const canPrice = auth.requirePerm('price.manage');
r.use(canPrice);
const canProduct = auth.requirePerm('product.manage');

/*
 * A validation failure is an ordinary answer, not a crash. "Bu ürün geçmiş
 * adisyonlarda kullanılmış" is a sentence the screen puts next to a button;
 * letting it reach the global handler would log a stack trace for every
 * correctly-refused delete and bury the faults that matter. Anything without a
 * status is still a bug and still goes to the handler.
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

/* --------------------------- hedef marj --------------------------- */
r.get('/targets', safe(async (req, res) => ok(res, await pricing.targetList(req.clientId))));

r.post('/targets', canPrice, safe(async (req, res) => ok(res,
  await pricing.setTarget(req.clientId, req.body.category_id, req.body.target_margin, req.auth.uid))));

/* --------------------------- öneriler ----------------------------- */

/** The live calculation, written nowhere: the preview the batch run applies. */
r.get('/preview', safe(async (req, res) => ok(res, await pricing.compute(req.clientId, {
  category_id: req.query.category_id,
  round_to: req.query.round_to,
  cost_window_days: req.query.cost_window_days,
  sales_window_days: req.query.sales_window_days,
}))));

/** The batch the PHP file called `pricing_batch_run.php` never ran. */
r.post('/run', canPrice, safe(async (req, res) => ok(res, {
  result: await pricing.run(req.clientId, req.body || {}, req.auth.uid) })));

r.get('/suggestions', safe(async (req, res) => ok(res, {
  suggestions: await pricing.pending(req.clientId, { bump: req.query.count !== '0' }) })));

r.post('/suggestions/:id/accept', canPrice, safe(async (req, res) => ok(res, {
  result: await pricing.accept(req.clientId, req.params.id, req.auth.uid,
    req.body ? req.body.price : null) })));

r.post('/suggestions/accept-all', canPrice, safe(async (req, res) => ok(res, {
  result: await pricing.acceptAll(req.clientId, req.auth.uid) })));

r.post('/suggestions/:id/reject', canPrice, safe(async (req, res) => ok(res, {
  result: await pricing.reject(req.clientId, req.params.id, req.auth.uid,
    req.body ? req.body.note : null) })));

r.get('/decided', safe(async (req, res) => ok(res, {
  rows: await pricing.decided(req.clientId, req.query.kind, req.query.limit) })));

r.get('/insights', safe(async (req, res) => ok(res,
  await pricing.insights(req.clientId, { sales_window_days: req.query.sales_window_days }))));

/* --------------------------- toplu fiyat -------------------------- */

/*
 * Preview and apply are the same endpoint with a flag, not two handlers. A
 * preview computed by different code from the thing it previews is a preview
 * of nothing, and this one can change three hundred prices.
 */
r.post('/bulk', canPrice, safe(async (req, res) => ok(res,
  await pricing.bulkPrice(req.clientId, { ...(req.body || {}), apply: false }, req.auth.uid))));

r.post('/bulk/apply', canPrice, safe(async (req, res) => ok(res,
  await pricing.bulkPrice(req.clientId, { ...(req.body || {}), apply: true }, req.auth.uid))));

/* --------------------------- ürün kartı --------------------------- */
r.get('/products', safe(async (req, res) => ok(res, {
  products: await pricing.productList(req.clientId, {
    q: req.query.q, category_id: req.query.category_id, only_active: req.query.only_active === '1',
  }) })));

r.get('/products/:id', safe(async (req, res) => ok(res, await pricing.productCard(req.clientId, req.params.id))));

r.get('/products/:id/costs', safe(async (req, res) => ok(res, {
  costs: await pricing.costHistory(req.clientId, req.params.id) })));

r.post('/products/:id/costs', canProduct, safe(async (req, res) => ok(res, {
  result: await pricing.recordCost(req.clientId, req.params.id, req.body || {}, req.auth.uid) })));

r.get('/products/:id/prices', safe(async (req, res) => ok(res,
  await pricing.priceHistory(req.clientId, req.params.id))));

r.get('/products/:id/usage', safe(async (req, res) => ok(res, {
  usage: await pricing.usage(req.clientId, req.params.id) })));

r.post('/products/:id/duplicate', canProduct, safe(async (req, res) => ok(res, {
  result: await pricing.duplicateProduct(req.clientId, req.params.id, req.body || {}, req.auth.uid) })));

/*
 * DELETE with ?hard=1 rather than a separate /purge route: the guard lives in
 * the module and answers 409 with the count of bills the product appears on,
 * so the destructive request and the safe one cannot end up behind different
 * checks. A hard delete of a sold product is refused, never downgraded.
 */
r.delete('/products/:id', canProduct, safe(async (req, res) => ok(res, {
  result: await pricing.deleteProduct(req.clientId, req.params.id,
    { hard: req.query.hard === '1' }, req.auth.uid) })));

r.post('/products/:id/activate', canProduct, safe(async (req, res) => ok(res, {
  result: await pricing.activateProduct(req.clientId, req.params.id) })));

/* --------------------------- kategoriler -------------------------- */
r.delete('/categories/:id', canProduct, safe(async (req, res) => ok(res, {
  result: await pricing.deleteCategory(req.clientId, req.params.id,
    { hard: req.query.hard === '1' }, req.auth.uid) })));

r.post('/categories/:id/activate', canProduct, safe(async (req, res) => ok(res, {
  result: await pricing.activateCategory(req.clientId, req.params.id,
    { withProducts: (req.body || {}).with_products !== false }) })));

module.exports = r;
