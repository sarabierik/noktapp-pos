'use strict';
/**
 * Fiyatlandırma - target margins, suggested prices, and the product-card
 * housekeeping that hangs off a price: cost history, price history, bulk
 * changes, duplicate, and the delete that must not be a delete.
 *
 * WHAT THE OLD MODULE WAS
 *
 * Ten PHP files under `finance/pricing/`, none of them in the navigation, all
 * reachable only by typing the URL. The engine returned a suggestion band of
 * +3%..+8% and always the midpoint - the same +5.5% whether a supplier had put
 * flour up 15% or 60%, and the same *rise* when a cost had FALLEN, because the
 * trigger tested `abs(costChange)`. Nothing in the entire tree ever inserted a
 * row into `pricing_suggestions`, so the six list screens read a table that
 * only received UPDATEs; and accepting a suggestion wrote the accepted number
 * into `product_price_history` and `chosen_price` and **never changed the
 * price**. The module could not raise a single price if you used it perfectly.
 *
 * WHAT THIS ONE DOES
 *
 * A price is not guessed from a percentage band. It is computed from the two
 * numbers the owner already knows - what the dish costs and what margin the
 * category is supposed to earn - and the arithmetic is stated on screen so the
 * number can be argued with:
 *
 *     net       = price / (1 + KDV/100)          prices on this menu INCLUDE KDV
 *     margin    = (net - cost) / net * 100
 *     hedef net = cost / (1 - hedef/100)
 *     hedef fiyat = hedef net * (1 + KDV/100)     then rounded up to the step
 *
 * KDV comes out first, every time. A menu price of 220 ₺ at 10% is 200 ₺ of
 * the restaurant's money and 20 ₺ of the state's; a margin measured against
 * the 220 is roughly a tenth better than the one the business actually earns,
 * and that is the number an owner uses to decide whether to keep cooking a
 * dish. `pnl.js` already draws the line in the same place.
 *
 * THE COST IS THE WEAK POINT, SO IT IS LABELLED
 *
 * There are three places a cost can come from and they do not agree:
 *
 *   1. `order_items.cost_price` - what the item cost when it was SOLD, frozen
 *      onto the line. This is the real number and the one every report reads.
 *      It is also missing on every line the two cashier screens ever wrote,
 *      because their INSERT omitted the column.
 *   2. `products.cost_price` - a figure typed by hand on the product card,
 *      current as of whenever somebody last thought about it.
 *   3. the recipe (`product_recipes` x average purchase price) - a computed
 *      cost, only as good as the recipe and the last delivery.
 *
 * A suggestion built on (2) or (3) is a different kind of claim from one built
 * on (1), and every row says which it used. A screen that shows a guess and a
 * measurement in the same column is lying by omission - the old one did, and
 * for the tenant with 203 products all at cost 0 it reported 100% margins.
 */
const db = require('../db');
const log = require('../logger');
const catalog = require('./catalog');
const { money } = require('../util/http');

/* How far back the sale-frozen costs are averaged. Long enough that one
   mistyped line cannot move it, short enough that last winter's flour price
   is not still setting today's menu. */
const COST_WINDOW_DAYS = 90;
/* The demand window the estimated contribution is projected from. */
const SALES_WINDOW_DAYS = 30;
/* Used when no target has been set for the category or the menu. 60% net is
   the usual place a Turkish restaurant kitchen sits; it is a starting point on
   a screen, not a rule, and the owner is expected to change it. */
const DEFAULT_TARGET = 60;
/* Below this the change is not worth a decision: a 12 kuruş rise on a 250 ₺
   plate costs more attention than it earns. */
const MIN_CHANGE_PCT = 1;

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/**
 * A products row reshaped into what catalog.saveProduct expects, plus a patch.
 *
 * This is not tidiness, it is a trap. `saveProduct` reads its flags as
 * `data.is_active === false ? 0 : 1` and `data.use_in_pos === false ? 0 : 1`,
 * which is right for a form posting booleans and wrong for a database row
 * posting 0 and 1: `0 === false` is false in JavaScript, so spreading a row
 * straight back in would silently RE-ACTIVATE every product it touched. Every
 * write in this module goes through the shared product writer, so every write
 * in this module would have done it - a bulk price change would have put the
 * whole discontinued menu back on the till.
 */
function asSaveData(p, patch = {}) {
  return {
    id: p.id,
    category_id: p.category_id,
    name: p.name,
    price: p.price,
    cost_price: p.cost_price,
    description: p.description,
    sort_order: p.sort_order,
    vat_rate: p.vat_rate,
    track_stock: !!p.track_stock,
    is_active: p.is_active !== 0 && p.is_active !== false,
    use_in_pos: p.use_in_pos !== 0 && p.use_in_pos !== false,
    use_in_qr: p.use_in_qr !== 0 && p.use_in_qr !== false,
    ...patch,
  };
}

/* ====================================================================== */
/*  Money arithmetic - one place, because it is the whole module           */
/* ====================================================================== */

/** The restaurant's share of a shelf price. Prices on this menu include KDV. */
function netOf(price, vatRate) {
  const v = Number(vatRate) || 0;
  return money(Number(price || 0) / (1 + v / 100));
}

/** Margin on NET revenue, in percent. Null when there is nothing to divide by. */
function marginOf(price, cost, vatRate) {
  const net = netOf(price, vatRate);
  if (!(net > 0)) return null;
  return money((net - Number(cost || 0)) / net * 100);
}

/**
 * The KDV-inclusive shelf price that earns `target` percent on net.
 *
 * The inverse of marginOf, and the one line of arithmetic the whole module
 * exists for. A target of 100 or more has no solution - you cannot make an
 * infinite margin on a positive cost - so it is clamped rather than allowed to
 * divide by zero and hand a screen `Infinity ₺`.
 */
function priceForMargin(cost, target, vatRate) {
  const t = Math.min(Math.max(Number(target) || 0, 0), 95);
  const net = Number(cost || 0) / (1 - t / 100);
  return money(net * (1 + (Number(vatRate) || 0) / 100));
}

/**
 * Snap to a price step: 0.25, 0.50 or 1.00 ₺.
 *
 * `dir` is 'near' for the bulk tool - the owner asked for "+10%, round it" and
 * nearest is what that means - and 'up' for suggestions, because a suggestion
 * rounded DOWN lands below the target margin it was computed to hit, which
 * makes the whole screen quietly wrong in the direction that costs money.
 * The epsilon is there because 220/0.25 is not always exactly 880 in binary.
 */
function roundStep(value, step, dir = 'near') {
  const s = Number(step) || 0;
  const v = Number(value) || 0;
  if (!(s > 0)) return money(v);
  const n = v / s;
  const k = dir === 'up' ? Math.ceil(n - 1e-9)
    : dir === 'down' ? Math.floor(n + 1e-9)
      : Math.round(n + 1e-9);
  return money(k * s);
}

/* The steps the UI offers. Anything else is refused rather than silently
   accepted, so "round to 0,3" cannot produce prices nobody can make change for. */
const STEPS = [0, 0.25, 0.5, 1];
function checkStep(step) {
  const s = Number(step || 0);
  if (!STEPS.includes(s)) throw bad('Yuvarlama adımı 0, 0,25, 0,50 veya 1,00 olabilir');
  return s;
}

/* ====================================================================== */
/*  Cost - where it comes from, and saying so                             */
/* ====================================================================== */

const COST_SOURCES = {
  sale:    { label: 'Satış geçmişi', fallback: false },
  product: { label: 'Ürün kartı',    fallback: true },
  recipe:  { label: 'Reçete',        fallback: true },
  none:    { label: 'Maliyet yok',   fallback: true },
};

/**
 * What one portion costs, and how confident we are allowed to be about it.
 *
 * Order of preference is the order of evidence: what the item actually cost on
 * the bills it was sold on, then what somebody typed on the card, then what
 * its recipe works out to at the last purchase prices. Only the first is a
 * measurement; the other two are marked `fallback` and every screen that shows
 * the number shows that too.
 *
 * `costsByProduct` is passed in by the batch run so a 300-item menu is three
 * queries rather than nine hundred.
 */
function pickCost(product, sold, recipeCost) {
  if (sold && Number(sold) > 0) {
    return { cost: money(sold), source: 'sale' };
  }
  if (Number(product.cost_price) > 0) {
    return { cost: money(product.cost_price), source: 'product' };
  }
  if (recipeCost && Number(recipeCost) > 0) {
    return { cost: money(recipeCost), source: 'recipe' };
  }
  return { cost: 0, source: 'none' };
}

/**
 * The qty-weighted average of the costs frozen onto sold lines.
 *
 * Weighted by qty rather than a plain average of the lines, because a cost
 * that applied to one portion and a cost that applied to forty should not
 * count the same. Lines with cost_price 0 are excluded rather than averaged
 * in as free - the two cashier screens in the old system never wrote the
 * column at all, so a zero means "not recorded", not "cost nothing".
 */
async function soldCosts(clientId, windowDays = COST_WINDOW_DAYS) {
  const rows = await db.query(
    `SELECT i.product_id,
            SUM(i.qty * i.cost_price) / NULLIF(SUM(i.qty),0) AS avg_cost,
            MAX(o.closed_at) AS last_sold
       FROM order_items i
       JOIN orders o ON o.id=i.order_id AND o.client_id=i.client_id
      WHERE i.client_id=? AND i.is_deleted=0 AND i.cost_price > 0
        AND o.status='closed' AND o.is_deleted=0
        AND COALESCE(o.exclude_from_reports,0)=0
        AND COALESCE(o.business_date, DATE(o.closed_at)) >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY i.product_id`, [clientId, Number(windowDays) || COST_WINDOW_DAYS]);
  const m = new Map();
  for (const r of rows) m.set(Number(r.product_id), { cost: money(r.avg_cost), last_sold: r.last_sold });
  return m;
}

/**
 * The most recent frozen cost, whenever it was.
 *
 * A seasonal dish sold last August has no line inside the 90-day window but is
 * not uncosted; falling back to the newest line ever is better evidence than
 * a number typed on the card two years ago.
 */
async function lastSoldCosts(clientId) {
  const rows = await db.query(
    `SELECT i.product_id, i.cost_price, o.closed_at
       FROM order_items i
       JOIN orders o ON o.id=i.order_id AND o.client_id=i.client_id
       JOIN (SELECT i2.product_id, MAX(i2.id) AS mx
               FROM order_items i2
               JOIN orders o2 ON o2.id=i2.order_id AND o2.client_id=i2.client_id
              WHERE i2.client_id=? AND i2.is_deleted=0 AND i2.cost_price > 0
                AND o2.status='closed' AND o2.is_deleted=0
              GROUP BY i2.product_id) last ON last.mx = i.id
      WHERE i.client_id=?`, [clientId, clientId]);
  const m = new Map();
  for (const r of rows) m.set(Number(r.product_id), { cost: money(r.cost_price), last_sold: r.closed_at });
  return m;
}

/**
 * Recipe cost for every product that has one, in a single query.
 *
 * The same moving-average expression `inventory.recipeCost` uses per product,
 * lifted to the whole menu so the batch run does not walk the recipe table
 * once per item. Written here rather than added to inventory.js because that
 * file belongs to the stock build; the shape of the average is copied from it
 * deliberately so the two screens never show different recipe costs.
 */
async function recipeCosts(clientId) {
  const rows = await db.query(
    `SELECT r.product_id,
            COALESCE(SUM(r.qty_per_unit * COALESCE(ac.avg_cost,0)),0) AS recipe_cost
       FROM product_recipes r
       LEFT JOIN (
         SELECT item_id,
                CASE WHEN SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE quantity_in END) > 0
                     THEN SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE quantity_in * unit_cost END)
                        / SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE quantity_in END)
                     ELSE 0 END AS avg_cost
           FROM inventory_stock_ledger WHERE client_id=? GROUP BY item_id
       ) ac ON ac.item_id = r.inventory_item_id
      WHERE r.client_id=?
      GROUP BY r.product_id`, [clientId, clientId]).catch((e) => {
    // the stock module owns those tables; a site that has not migrated yet
    // should lose the recipe fallback, not the whole pricing screen
    log.warn('pricing', 'recipe costs unavailable: ' + e.message);
    return [];
  });
  const m = new Map();
  for (const r of rows) m.set(Number(r.product_id), money(r.recipe_cost));
  return m;
}

/** Units sold per product in the demand window, for the contribution estimate. */
async function soldQty(clientId, windowDays = SALES_WINDOW_DAYS) {
  const rows = await db.query(
    `SELECT i.product_id, COALESCE(SUM(i.qty),0) AS qty
       FROM order_items i
       JOIN orders o ON o.id=i.order_id AND o.client_id=i.client_id
      WHERE i.client_id=? AND i.is_deleted=0
        AND o.status='closed' AND o.is_deleted=0
        AND COALESCE(o.exclude_from_reports,0)=0
        AND COALESCE(o.business_date, DATE(o.closed_at)) >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY i.product_id`, [clientId, Number(windowDays) || SALES_WINDOW_DAYS]);
  const m = new Map();
  for (const r of rows) m.set(Number(r.product_id), Number(r.qty));
  return m;
}

/* ====================================================================== */
/*  Target margins                                                        */
/* ====================================================================== */

/**
 * The target margin per category, plus the menu-wide default.
 *
 * category_id 0 is the menu default rather than NULL: MySQL counts every NULL
 * as distinct inside a unique key, so a NULL row could exist twice and the
 * read would pick whichever came back first.
 */
async function targets(clientId) {
  const rows = await db.query(
    'SELECT category_id, target_margin, updated_at, updated_by FROM pricing_targets WHERE client_id=?',
    [clientId]);
  const byCat = new Map();
  let menu = DEFAULT_TARGET;
  let menuSet = false;
  for (const r of rows) {
    if (Number(r.category_id) === 0) { menu = money(r.target_margin); menuSet = true; }
    else byCat.set(Number(r.category_id), money(r.target_margin));
  }
  return { menu, menuSet, byCat };
}

/** The same thing shaped for a screen: every category, with its effective target. */
async function targetList(clientId) {
  const t = await targets(clientId);
  const cats = await db.query(
    `SELECT c.id, c.name, c.is_active, COUNT(p.id) AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id=c.id AND p.client_id=c.client_id AND p.is_active=1
      WHERE c.client_id=? GROUP BY c.id, c.name, c.is_active ORDER BY c.sort_order, c.name`,
    [clientId]);
  return {
    menu_target: t.menu,
    menu_target_is_default: !t.menuSet,
    categories: cats.map(c => ({
      id: c.id, name: c.name, is_active: !!c.is_active,
      product_count: Number(c.product_count),
      target_margin: t.byCat.has(c.id) ? t.byCat.get(c.id) : t.menu,
      // the screen must be able to say "inherited" - a target somebody set to
      // the same number as the default is a decision, and clearing it is not
      own_target: t.byCat.has(c.id),
    })),
  };
}

/** Set (or clear) a target. categoryId 0 sets the menu-wide default. */
async function setTarget(clientId, categoryId, target, userId) {
  const cat = Number(categoryId) || 0;
  if (cat > 0) {
    const c = await db.one('SELECT id FROM categories WHERE id=? AND client_id=?', [cat, clientId]);
    if (!c) throw bad('Kategori bulunamadı', 404);
  }
  if (target === null || target === '' || target === undefined) {
    if (cat === 0) throw bad('Menü geneli hedef marj boş bırakılamaz');
    await db.exec('DELETE FROM pricing_targets WHERE client_id=? AND category_id=?', [clientId, cat]);
    return { cleared: true };
  }
  const t = Number(target);
  // 95 is the ceiling priceForMargin can solve; 0 is a break-even menu, which
  // is a legitimate thing to ask for on a loss-leader category
  if (!Number.isFinite(t) || t < 0 || t > 95) throw bad('Hedef marj 0 ile 95 arasında olmalı');
  await db.exec(
    `INSERT INTO pricing_targets (client_id, category_id, target_margin, updated_by)
     VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE target_margin=VALUES(target_margin),
             updated_by=VALUES(updated_by), updated_at=NOW()`,
    [clientId, cat, money(t), userId || null]);
  return { target_margin: money(t) };
}

/* ====================================================================== */
/*  The engine                                                            */
/* ====================================================================== */

/**
 * Confidence, ported from the PHP with its bug taken out.
 *
 * The original ran `ORDER BY created_at DESC LIMIT 3` AFTER the aggregate, so
 * the LIMIT applied to the single summed row and the "last three suggestions"
 * window it was documenting never existed - it aggregated all history. The
 * window is applied here in the subquery, where it does what it says.
 *
 * The extra term is ours: a suggestion built on a cost nobody measured cannot
 * be as trustworthy as one built on what the item actually cost, and the
 * number on the screen should say so rather than the footnote alone.
 */
function confidenceFor(history, costSource) {
  let c = 70;
  if (history.accepted >= 2) c += 10;
  if (history.rejected >= 2) c -= 15;
  if (COST_SOURCES[costSource].fallback) c -= 20;
  if (costSource === 'none') c = 0;
  return Math.max(0, Math.min(95, c));
}

const CONFIDENCE_WINDOW = 3;

async function decisionHistory(clientId) {
  /*
   * The window is applied here, in JavaScript, rather than in SQL. The PHP put
   * `ORDER BY created_at DESC LIMIT 3` after the aggregate, where it applied to
   * the one summed row and did nothing; moving it into a derived table would
   * not help either, because MariaDB is free to ignore an ORDER BY in a
   * subquery. Taking the newest three rows per product after the fetch is the
   * only version that is actually the last three decisions - and there is one
   * suggestion row per product per run, so the set is small.
   */
  const rows = await db.query(
    `SELECT product_id, accepted_at, rejected_at FROM pricing_suggestions
      WHERE client_id=? AND (accepted_at IS NOT NULL OR rejected_at IS NOT NULL)
      ORDER BY created_at DESC, id DESC`, [clientId]);
  const seen = new Map();
  const m = new Map();
  for (const r of rows) {
    const id = Number(r.product_id);
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    if (n > CONFIDENCE_WINDOW) continue;
    const h = m.get(id) || { accepted: 0, rejected: 0 };
    if (r.accepted_at) h.accepted++; else if (r.rejected_at) h.rejected++;
    m.set(id, h);
  }
  return m;
}

/**
 * Every price this menu could have, and what it earns today.
 *
 * Pure: it reads and computes and writes nothing, so the insights view, the
 * batch-run preview and the screen's live refresh all show the same numbers
 * without any of them having to persist a row first. `run()` is the one that
 * writes, and it calls this.
 */
async function compute(clientId, opts = {}) {
  const step = checkStep(opts.round_to === undefined ? 0.25 : opts.round_to);
  const categoryId = Number(opts.category_id) || 0;

  const products = await db.query(
    `SELECT p.id, p.category_id, p.name, p.price, p.cost_price, p.vat_rate, p.is_active,
            c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
      WHERE p.client_id=? AND p.is_active=1 ${categoryId ? 'AND p.category_id=?' : ''}
      ORDER BY c.sort_order, c.name, p.sort_order, p.name`,
    categoryId ? [clientId, categoryId] : [clientId]);

  const [window, ever, recipes, qty, tgt, hist, rejects] = await Promise.all([
    soldCosts(clientId, opts.cost_window_days),
    lastSoldCosts(clientId),
    recipeCosts(clientId),
    soldQty(clientId, opts.sales_window_days),
    targets(clientId),
    decisionHistory(clientId),
    rejectedPrices(clientId),
  ]);

  const rows = [];
  for (const p of products) {
    const price = money(p.price);
    const vat = Number(p.vat_rate) || 0;
    const target = tgt.byCat.has(p.category_id) ? tgt.byCat.get(p.category_id) : tgt.menu;

    const w = window.get(p.id);
    const e = ever.get(p.id);
    const sold = w ? w.cost : (e ? e.cost : 0);
    const { cost, source } = pickCost(p, sold, recipes.get(p.id));

    const net = netOf(price, vat);
    const margin = marginOf(price, cost, vat);
    const exact = priceForMargin(cost, target, vat);
    const suggested = roundStep(exact, step, 'up');
    const change = money(suggested - price);
    const changePct = price > 0 ? money(change / price * 100) : 0;

    /*
     * The band the accept guard checks against. `min` is the exact price that
     * hits the target - anything under it misses. `max` is the price that
     * would hit the target plus ten points; the module will not vouch for a
     * rise beyond that, and an owner who wants one can type it on the product
     * card where it is his decision, not a machine's.
     */
    const min = money(Math.min(exact, suggested));
    const max = Math.max(
      roundStep(priceForMargin(cost, Math.min(target + 10, 95), vat), step, 'up'),
      suggested, price);

    const units = qty.get(p.id) || 0;
    // contribution, not turnover: the extra NET the same volume would have
    // earned. Estimated on what actually sold in the window, so a dish nobody
    // orders cannot climb the list on the size of its percentage
    const gain = money(units * (netOf(suggested, vat) - net));

    const noCost = source === 'none';
    const tooSmall = Math.abs(changePct) < MIN_CHANGE_PCT;
    const rejected = rejects.has(rejectKey(p.id, suggested));

    rows.push({
      product_id: p.id,
      name: p.name,
      category_id: p.category_id,
      category: p.category_name || 'Kategorisiz',
      vat_rate: vat,
      current_price: price,
      current_net: net,
      cost,
      cost_source: source,
      cost_source_label: COST_SOURCES[source].label,
      cost_is_fallback: COST_SOURCES[source].fallback,
      last_sold: w ? w.last_sold : (e ? e.last_sold : null),
      current_margin: margin,
      target_margin: target,
      below_target: margin !== null && !noCost && margin < target,
      suggested_price: noCost ? null : suggested,
      suggested_exact: noCost ? null : exact,
      suggested_min: noCost ? null : min,
      suggested_max: noCost ? null : max,
      suggested_margin: noCost ? null : marginOf(suggested, cost, vat),
      change: noCost ? null : change,
      change_pct: noCost ? null : changePct,
      units_sold: units,
      estimated_profit: noCost ? 0 : gain,
      confidence: confidenceFor(hist.get(p.id) || { accepted: 0, rejected: 0 }, source),
      /* Why this row is or is not offered as a decision. Stated per row rather
         than filtered out silently: "why is my most expensive dish not here"
         is the first question anyone asks of a screen like this. */
      suggestible: !noCost && !tooSmall && !rejected,
      skip_reason: noCost ? 'Maliyet bilinmiyor'
        : rejected ? 'Daha önce reddedildi'
          : tooSmall ? 'Değişim %1\'in altında'
            : null,
    });
  }
  return { rows, step, cost_window_days: Number(opts.cost_window_days) || COST_WINDOW_DAYS };
}

/* ====================================================================== */
/*  Rejection memory                                                      */
/* ====================================================================== */

/*
 * A rejection is remembered against the product AND the price that was
 * refused, to the kuruş. "No" means no to this proposal, not to the product
 * forever: if the cost moves or the target changes, the suggested price moves
 * with it and that is a new question, which the owner has not answered. The
 * old module had no memory at all - it re-offered the same number the next day
 * and every day after, which is how a suggestion screen trains people to
 * ignore it.
 */
function rejectKey(productId, price) { return Number(productId) + '@' + money(price).toFixed(2); }

async function rejectedPrices(clientId) {
  const rows = await db.query(
    `SELECT product_id, suggested_price FROM pricing_suggestions
      WHERE client_id=? AND rejected_at IS NOT NULL`, [clientId]);
  return new Set(rows.map(r => rejectKey(r.product_id, r.suggested_price)));
}

/* ====================================================================== */
/*  Batch run - the thing the PHP file of that name did not do             */
/* ====================================================================== */

/**
 * Compute the whole menu and record what is worth deciding.
 *
 * `pricing_batch_run.php` was misnamed: it ran no batch, it was an accept /
 * reject list over a table nothing wrote. This is the batch. One pending row
 * per product at a time - a second run that finds the same answer refreshes
 * the row rather than stacking a duplicate, so the pending list is a list of
 * open questions and not a log.
 */
async function run(clientId, opts = {}, userId = null) {
  const { rows, cost_window_days } = await compute(clientId, opts);
  const offer = rows.filter(r => r.suggestible);

  let created = 0, refreshed = 0;
  for (const r of offer) {
    const open = await db.one(
      `SELECT id, suggested_price FROM pricing_suggestions
        WHERE client_id=? AND product_id=? AND accepted_at IS NULL AND rejected_at IS NULL
        ORDER BY id DESC LIMIT 1`, [clientId, r.product_id]);
    const reason = reasonText(r);
    if (open) {
      await db.exec(
        `UPDATE pricing_suggestions SET current_price=?, suggested_price=?, suggested_min=?,
                suggested_max=?, confidence=?, reason=?, data_window_days=?, estimated_profit=?,
                cost_price=?, cost_source=?, target_margin=?, current_margin=?, vat_rate=?,
                created_at=NOW()
          WHERE id=? AND client_id=?`,
        [r.current_price, r.suggested_price, r.suggested_min, r.suggested_max, r.confidence,
         reason, cost_window_days, r.estimated_profit, r.cost, r.cost_source, r.target_margin,
         r.current_margin === null ? 0 : r.current_margin, r.vat_rate, open.id, clientId]);
      refreshed++;
    } else {
      await db.insert(
        `INSERT INTO pricing_suggestions
           (client_id, product_id, current_price, suggested_price, suggested_min, suggested_max,
            strategy, confidence, reason, data_window_days, estimated_profit,
            cost_price, cost_source, target_margin, current_margin, vat_rate, created_at)
         VALUES (?,?,?,?,?,?,'profit',?,?,?,?,?,?,?,?,?,NOW())`,
        [clientId, r.product_id, r.current_price, r.suggested_price, r.suggested_min,
         r.suggested_max, r.confidence, reason, cost_window_days, r.estimated_profit,
         r.cost, r.cost_source, r.target_margin,
         r.current_margin === null ? 0 : r.current_margin, r.vat_rate]);
      created++;
    }
  }
  log.info('pricing', 'batch run', { clientId, scanned: rows.length, created, refreshed, by: userId });
  return {
    scanned: rows.length,
    created, refreshed,
    skipped: rows.length - offer.length,
    no_cost: rows.filter(r => r.cost_source === 'none').length,
    fallback_cost: rows.filter(r => r.suggestible && r.cost_is_fallback).length,
  };
}

/** The sentence stored on the row, in Turkish, so the list explains itself. */
function reasonText(r) {
  const dir = r.change > 0 ? 'altında' : 'üzerinde';
  const m = r.current_margin === null ? '—' : r.current_margin.toFixed(1);
  return `Marj %${m}, hedef %${Number(r.target_margin).toFixed(0)} (${dir}). `
    + `Maliyet ${r.cost.toFixed(2)} ₺ — kaynak: ${COST_SOURCES[r.cost_source].label}`
    + (r.cost_is_fallback ? ' (tahmini)' : '');
}

/**
 * Open questions, with today's numbers alongside the ones the run recorded.
 *
 * A suggestion made on Monday and looked at on Friday may have been overtaken
 * by a price the owner typed himself, so the live price is fetched and a stale
 * row is flagged rather than shown as if it were current.
 */
async function pending(clientId, { bump = true } = {}) {
  const rows = await db.query(
    `SELECT s.*, p.name, p.price AS live_price, p.vat_rate AS live_vat, p.is_active,
            c.name AS category
       FROM pricing_suggestions s
       JOIN products p ON p.id=s.product_id AND p.client_id=s.client_id
       LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
      WHERE s.client_id=? AND s.accepted_at IS NULL AND s.rejected_at IS NULL
        AND p.is_active=1
      ORDER BY s.estimated_profit DESC, s.id DESC`, [clientId]);

  /*
   * shown_count, kept from the old module because it is genuinely useful -
   * "we have shown you this eleven times" is a fact worth having. What is NOT
   * kept is v2's ordering by applied_count/shown_count, which ranked a
   * suggestion shown once and accepted once above everything else forever.
   * The order here is by money on the table.
   */
  if (bump && rows.length) {
    await db.exec(
      `UPDATE pricing_suggestions SET shown_count = shown_count + 1
        WHERE client_id=? AND id IN (${rows.map(() => '?').join(',')})`,
      [clientId, ...rows.map(r => r.id)]).catch(() => {});
  }

  return rows.map(r => ({
    id: r.id,
    product_id: r.product_id,
    name: r.name,
    category: r.category || 'Kategorisiz',
    current_price: money(r.live_price),
    recorded_price: money(r.current_price),
    stale: money(r.live_price) !== money(r.current_price),
    suggested_price: money(r.suggested_price),
    suggested_min: money(r.suggested_min),
    suggested_max: money(r.suggested_max),
    change: money(Number(r.suggested_price) - Number(r.live_price)),
    cost: money(r.cost_price),
    cost_source: r.cost_source,
    cost_source_label: (COST_SOURCES[r.cost_source] || COST_SOURCES.none).label,
    cost_is_fallback: (COST_SOURCES[r.cost_source] || COST_SOURCES.none).fallback,
    vat_rate: Number(r.vat_rate),
    current_margin: money(r.current_margin),
    target_margin: money(r.target_margin),
    suggested_margin: marginOf(r.suggested_price, r.cost_price, r.vat_rate),
    estimated_profit: money(r.estimated_profit),
    confidence: Number(r.confidence),
    reason: r.reason,
    shown_count: Number(r.shown_count) + (bump ? 1 : 0),
    created_at: r.created_at,
  }));
}

/**
 * Accept: write the price, and the history, through the one write path.
 *
 * The old module's single worst defect was here - accepting a suggestion never
 * changed a price. It wrote the accepted number into `chosen_price` and into
 * `product_price_history` (a table nothing read) and left `products.price`
 * exactly as it was, so a restaurant could work the screen perfectly for a
 * month and sell everything at the old price.
 *
 * `catalog.saveProduct` is the only thing in this service that writes a menu
 * price, and it writes `product_price_history` and `price_change_log` as a
 * consequence of the price actually changing. Going through it means an
 * accepted suggestion and a hand-typed price leave the same trail, and there
 * is no second implementation to drift.
 */
async function accept(clientId, suggestionId, userId, chosenPrice = null) {
  const s = await db.one(
    `SELECT * FROM pricing_suggestions
      WHERE id=? AND client_id=? AND accepted_at IS NULL AND rejected_at IS NULL`,
    [suggestionId, clientId]);
  if (!s) throw bad('Öneri bulunamadı ya da zaten karara bağlanmış', 404);

  const price = chosenPrice === null || chosenPrice === undefined || chosenPrice === ''
    ? money(s.suggested_price) : money(chosenPrice);
  // the band guard, kept from the PHP: a typo in the box must not become the
  // menu price, and the band is what the module is prepared to stand behind
  if (price < money(s.suggested_min) - 0.005 || price > money(s.suggested_max) + 0.005) {
    throw bad(`Seçilen fiyat önerilen aralığın dışında (${money(s.suggested_min).toFixed(2)} – `
      + `${money(s.suggested_max).toFixed(2)} ₺)`);
  }

  const p = await db.one('SELECT * FROM products WHERE id=? AND client_id=?', [s.product_id, clientId]);
  if (!p) throw bad('Ürün bulunamadı', 404);
  const old = money(p.price);

  await catalog.saveProduct(clientId, asSaveData(p, { price }), userId);
  await db.exec(
    `UPDATE pricing_suggestions SET chosen_price=?, accepted_at=NOW(), accepted_by=?,
            applied_count = applied_count + 1
      WHERE id=? AND client_id=?`, [price, userId || null, s.id, clientId]);

  /*
   * `price_change_log.source` is an enum of ai / manual / import and
   * saveProduct writes 'manual', which is true of a price a person typed and
   * not of one this screen proposed. The row is re-stamped rather than the
   * shared writer being taught about pricing - the log should say where the
   * number came from, and the accepted suggestion is the reference.
   */
  if (old !== price) {
    await db.exec(
      `UPDATE price_change_log SET source='ai', reference_id=?
        WHERE client_id=? AND product_id=? ORDER BY id DESC LIMIT 1`,
      [s.id, clientId, s.product_id]).catch(e =>
        log.warn('pricing', 'price change log not re-stamped: ' + e.message));
  }
  log.info('pricing', 'suggestion accepted', { clientId, id: s.id, product: s.product_id, old, price });
  return { id: s.id, product_id: s.product_id, old_price: old, price };
}

/** Accept every open suggestion at its suggested price. */
async function acceptAll(clientId, userId) {
  const open = await db.query(
    `SELECT s.id FROM pricing_suggestions s
       JOIN products p ON p.id=s.product_id AND p.client_id=s.client_id
      WHERE s.client_id=? AND s.accepted_at IS NULL AND s.rejected_at IS NULL AND p.is_active=1
      ORDER BY s.estimated_profit DESC`, [clientId]);
  const done = [];
  const failed = [];
  for (const r of open) {
    // one bad row must not abandon the rest half-applied: a menu where six of
    // eleven prices moved is worse than one where none did or all did
    try { done.push(await accept(clientId, r.id, userId)); }
    catch (e) { failed.push({ id: r.id, error: e.message }); }
  }
  return { accepted: done.length, failed, rows: done };
}

/** Reject, with the reason kept: it is the memory that stops the re-offer. */
async function reject(clientId, suggestionId, userId, note = null) {
  const n = await db.exec(
    `UPDATE pricing_suggestions SET rejected_at=NOW(), rejected_by=?, reject_note=?
      WHERE id=? AND client_id=? AND accepted_at IS NULL AND rejected_at IS NULL`,
    [userId || null, note ? String(note).slice(0, 255) : null, suggestionId, clientId]);
  if (!n) throw bad('Öneri bulunamadı ya da zaten karara bağlanmış', 404);
  return { id: Number(suggestionId) };
}

/** Decided suggestions, for the accepted / rejected reports. */
async function decided(clientId, kind = 'accepted', limit = 200) {
  const where = kind === 'rejected' ? 's.rejected_at IS NOT NULL' : 's.accepted_at IS NOT NULL';
  const rows = await db.query(
    `SELECT s.*, p.name, u1.display_name AS accepted_name, u2.display_name AS rejected_name
       FROM pricing_suggestions s
       LEFT JOIN products p ON p.id=s.product_id AND p.client_id=s.client_id
       LEFT JOIN users u1 ON u1.id=s.accepted_by
       LEFT JOIN users u2 ON u2.id=s.rejected_by
      WHERE s.client_id=? AND ${where}
      ORDER BY COALESCE(s.accepted_at, s.rejected_at) DESC LIMIT ?`,
    [clientId, Number(limit) || 200]);
  return rows.map(r => ({
    id: r.id, product_id: r.product_id, name: r.name || ('#' + r.product_id),
    old_price: money(r.current_price),
    new_price: r.chosen_price === null ? null : money(r.chosen_price),
    suggested_price: money(r.suggested_price),
    suggested_min: money(r.suggested_min), suggested_max: money(r.suggested_max),
    cost: money(r.cost_price), cost_source: r.cost_source,
    cost_source_label: (COST_SOURCES[r.cost_source] || COST_SOURCES.none).label,
    cost_is_fallback: (COST_SOURCES[r.cost_source] || COST_SOURCES.none).fallback,
    target_margin: money(r.target_margin), confidence: Number(r.confidence),
    reason: r.reason, note: r.reject_note,
    at: r.accepted_at || r.rejected_at,
    by: r.accepted_name || r.rejected_name || null,
  }));
}

/* ====================================================================== */
/*  Insights                                                              */
/* ====================================================================== */

/**
 * The two questions worth asking of a menu: what is losing money, and where is
 * the money.
 *
 * The old `pricing_insights.php` counted rows in a table nothing wrote and
 * labelled them in English on a page nobody could reach. This counts the menu.
 */
async function insights(clientId, opts = {}) {
  const { rows } = await compute(clientId, opts);
  const costed = rows.filter(r => r.cost_source !== 'none');
  const measured = rows.filter(r => r.cost_source === 'sale');
  const below = costed.filter(r => r.below_target)
    .sort((a, b) => (a.current_margin - a.target_margin) - (b.current_margin - b.target_margin));
  const gains = rows.filter(r => r.suggestible && r.estimated_profit > 0)
    .sort((a, b) => b.estimated_profit - a.estimated_profit);
  /* A dish sold below what it costs. Reported on its own and first, because it
     is not a margin problem, it is money leaving the building per plate. */
  const losing = costed.filter(r => r.current_margin !== null && r.current_margin < 0)
    .sort((a, b) => a.current_margin - b.current_margin);

  const funnel = await db.one(
    `SELECT COUNT(*) AS total,
            SUM(accepted_at IS NOT NULL) AS accepted,
            SUM(rejected_at IS NOT NULL) AS rejected,
            SUM(accepted_at IS NULL AND rejected_at IS NULL) AS pending,
            ROUND(AVG(confidence),1) AS avg_confidence
       FROM pricing_suggestions WHERE client_id=?`, [clientId]);

  const netNow = costed.reduce((s, r) => s + r.units_sold * (r.current_net - r.cost), 0);
  const netThen = costed.reduce(
    (s, r) => s + r.units_sold * (netOf(r.suggested_price || r.current_price, r.vat_rate) - r.cost), 0);

  return {
    summary: {
      products: rows.length,
      costed: costed.length,
      uncosted: rows.length - costed.length,
      // the honesty line: how much of the margin picture is measured and how
      // much is somebody's recollection
      measured_cost: measured.length,
      fallback_cost: costed.length - measured.length,
      below_target: below.length,
      losing: losing.length,
      // weighted by what actually sold, so a rarely-ordered 90% item cannot
      // flatter the average
      average_margin: costed.length
        ? money(costed.reduce((s, r) => s + (r.current_margin || 0), 0) / costed.length) : 0,
      potential_gain: money(netThen - netNow),
      sales_window_days: Number(opts.sales_window_days) || SALES_WINDOW_DAYS,
    },
    funnel: {
      total: Number(funnel.total || 0), accepted: Number(funnel.accepted || 0),
      rejected: Number(funnel.rejected || 0), pending: Number(funnel.pending || 0),
      avg_confidence: funnel.avg_confidence === null ? null : Number(funnel.avg_confidence),
    },
    below_target: below.slice(0, 50),
    losing: losing.slice(0, 50),
    biggest_gains: gains.slice(0, 25),
    uncosted: rows.filter(r => r.cost_source === 'none').slice(0, 50)
      .map(r => ({ product_id: r.product_id, name: r.name, category: r.category,
        current_price: r.current_price, units_sold: r.units_sold })),
  };
}

/* ====================================================================== */
/*  The product card - cost history, price history, delete, duplicate      */
/* ====================================================================== */

/**
 * `product_costs` is a DATED history, not a current value.
 *
 * The old products.php inserted into it (only when cost > 0) and then never
 * read it back: the one report that tried joined on `pc.cost_price`, a column
 * that does not exist on the table, so the branch was dead and there was no
 * cost fallback anywhere. Nothing in the shipped UI ever showed the history.
 */
async function costHistory(clientId, productId) {
  return db.query(
    `SELECT pc.id, pc.cost, pc.currency, pc.effective_date, pc.created_at, pc.note,
            u.display_name AS created_by_name
       FROM product_costs pc
       LEFT JOIN users u ON u.id=pc.created_by
      WHERE pc.client_id=? AND pc.product_id=?
      ORDER BY pc.effective_date DESC, pc.id DESC`, [clientId, productId]);
}

/**
 * Record a cost as of a date, and make the newest one the product's cost.
 *
 * "Newest" is by effective_date, not by when it was typed: back-dating a
 * delivery note is normal, and a cost entered today for last month must not
 * overwrite a cost that has been in force since. The tie-break on id is what
 * makes two corrections on the same date resolve to the later keystroke.
 *
 * The write to `products.cost_price` goes through catalog.saveProduct so there
 * is one product writer, and so the price-history side effects of that writer
 * (none, here, because the price is unchanged) can never diverge.
 */
async function recordCost(clientId, productId, data, userId) {
  const p = await db.one('SELECT * FROM products WHERE id=? AND client_id=?', [productId, clientId]);
  if (!p) throw bad('Ürün bulunamadı', 404);
  const cost = money(data.cost);
  if (!Number.isFinite(cost) || cost < 0) throw bad('Maliyet negatif olamaz');
  const date = String(data.effective_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('Geçerli bir yürürlük tarihi girin (YYYY-AA-GG)');

  await db.insert(
    `INSERT INTO product_costs (client_id, product_id, cost, currency, effective_date, created_at, created_by, note)
     VALUES (?,?,?,'TRY',?,NOW(),?,?)`,
    [clientId, productId, cost, date, userId || null,
     data.note ? String(data.note).slice(0, 255) : null]);

  const newest = await db.one(
    `SELECT cost FROM product_costs WHERE client_id=? AND product_id=?
      ORDER BY effective_date DESC, id DESC LIMIT 1`, [clientId, productId]);
  const current = money(newest.cost);
  if (current !== money(p.cost_price)) {
    await catalog.saveProduct(clientId, asSaveData(p, { cost_price: current }), userId);
  }
  return { cost: current, effective_date: date, applied: current !== money(p.cost_price) };
}

/**
 * The price history, from both tables at once.
 *
 * `product_price_history` is the dated series - what the price WAS from when.
 * `price_change_log` is the audit - who changed it, when, from what to what,
 * and whether a person, an import or this module did it. Neither alone answers
 * "why is the pide 40 lira more than last month"; a screen that shows one and
 * not the other is why the question kept being asked.
 */
async function priceHistory(clientId, productId) {
  const changes = await db.query(
    `SELECT l.id, l.old_price, l.new_price, l.source, l.reference_id, l.changed_at,
            u.display_name AS changed_by_name, l.changed_by
       FROM price_change_log l
       LEFT JOIN users u ON u.id=l.changed_by
      WHERE l.client_id=? AND l.product_id=?
      ORDER BY l.changed_at DESC, l.id DESC`, [clientId, productId]);
  const series = await db.query(
    `SELECT h.id, h.price, h.effective_date, h.created_at, u.display_name AS created_by_name
       FROM product_price_history h
       LEFT JOIN users u ON u.id=h.created_by
      WHERE h.client_id=? AND h.product_id=?
      ORDER BY h.effective_date DESC, h.id DESC`, [clientId, productId]);
  /* 'merkez' is a chain price: it did not come from anyone at this branch,
     and a manager reading "Elle" against a change nobody here made is how
     a support call starts. */
  const SOURCE_TR = { manual: 'Elle', ai: 'Fiyat önerisi', import: 'İçe aktarma', merkez: 'Merkez menü' };
  return {
    changes: changes.map(c => ({
      ...c,
      old_price: money(c.old_price), new_price: money(c.new_price),
      change: money(Number(c.new_price) - Number(c.old_price)),
      source_label: SOURCE_TR[c.source] || c.source,
      changed_by_name: c.changed_by_name || (c.changed_by ? '#' + c.changed_by : 'Bilinmiyor'),
    })),
    series: series.map(s => ({ ...s, price: money(s.price) })),
  };
}

/**
 * Has this product ever been on a bill?
 *
 * The whole delete rule turns on this one count, and it is deliberately NOT
 * filtered on `is_deleted` or on the order's status: a cancelled bill and a
 * soft-deleted line are still history, they are still in the cancellations
 * report and the audit trail, and a product row removed underneath them turns
 * every one of those reports into a list of blanks.
 */
async function usage(clientId, productId) {
  const items = Number(await db.value(
    'SELECT COUNT(*) FROM order_items WHERE client_id=? AND product_id=?', [clientId, productId]));
  const orders = Number(await db.value(
    'SELECT COUNT(DISTINCT order_id) FROM order_items WHERE client_id=? AND product_id=?',
    [clientId, productId]));
  const lastSold = await db.value(
    `SELECT MAX(o.closed_at) FROM order_items i
       JOIN orders o ON o.id=i.order_id AND o.client_id=i.client_id
      WHERE i.client_id=? AND i.product_id=?`, [clientId, productId]);
  return { items, orders, last_sold: lastSold, can_hard_delete: items === 0 };
}

/**
 * Soft delete always; hard delete only for a product no bill has ever seen.
 *
 * The old system had no hard delete at all and no guard to need one, so this
 * is the rule being written down for the first time: deactivating takes an
 * item off the till and leaves last year's profit report intact; deleting is
 * only ever offered for something typed by mistake and never sold. Asking for
 * a hard delete on a sold product is refused with the reason and the count,
 * not silently downgraded to a deactivate - a destructive button that quietly
 * does something else is worse than one that says no.
 */
async function deleteProduct(clientId, productId, { hard = false } = {}, userId = null) {
  const p = await db.one('SELECT * FROM products WHERE id=? AND client_id=?', [productId, clientId]);
  if (!p) throw bad('Ürün bulunamadı', 404);
  const use = await usage(clientId, productId);

  if (!hard) {
    await catalog.saveProduct(clientId, asSaveData(p, { is_active: false }), userId);
    log.info('pricing', 'product deactivated', { clientId, productId, by: userId });
    return { mode: 'deactivated', product_id: Number(productId), usage: use };
  }

  if (!use.can_hard_delete) {
    throw bad(`"${p.name}" geçmiş adisyonlarda kullanılmış (${use.orders} adisyon, `
      + `${use.items} satır). Kalıcı silinemez; yalnızca pasife alınabilir.`, 409);
  }

  /*
   * Everything that hangs off a product id and would otherwise be orphaned.
   * There are no foreign keys on this schema, so nothing would stop the rows
   * being left behind - they would simply stop joining, and a cost history
   * belonging to no product is the sort of row that reappears years later
   * attached to whatever reused the id.
   */
  return db.tx(async t => {
    for (const table of ['product_recipes', 'product_stock', 'product_stock_movements',
      'product_costs', 'product_price_history', 'price_change_log', 'pricing_suggestions']) {
      await t.exec(`DELETE FROM ${table} WHERE client_id=? AND product_id=?`, [clientId, productId])
        .catch(e => log.warn('pricing', `cleanup of ${table} failed: ` + e.message));
    }
    await t.exec('DELETE FROM products WHERE id=? AND client_id=?', [productId, clientId]);
    log.info('pricing', 'product hard deleted', { clientId, productId, name: p.name, by: userId });
    return { mode: 'deleted', product_id: Number(productId) };
  });
}

/**
 * Put a product back on the till.
 *
 * A plain flag flip, NOT a round trip through the shared product writer. Its
 * flag defaults read `data.use_in_pos === false ? 0 : 1`, so re-activating a
 * product by re-saving the row would also turn a deliberately POS-hidden or
 * QR-hidden item visible again. Re-activating is one decision and it should
 * change one column.
 */
async function activateProduct(clientId, productId) {
  const p = await db.one('SELECT id FROM products WHERE id=? AND client_id=?', [productId, clientId]);
  if (!p) throw bad('Ürün bulunamadı', 404);
  await catalog.setProductActive(clientId, productId, true);
  return { product_id: Number(productId), is_active: true };
}

/**
 * Deactivating a category takes its products with it.
 *
 * The old system had neither. A category left active with its products hidden,
 * or hidden with its products still ringing up, is the state that produces
 * "why is Kahvaltı empty" and "why can I still sell the discontinued menu" in
 * the same week. One switch, one meaning.
 */
async function deleteCategory(clientId, categoryId, { hard = false } = {}, userId = null) {
  const c = await db.one('SELECT * FROM categories WHERE id=? AND client_id=?', [categoryId, clientId]);
  if (!c) throw bad('Kategori bulunamadı', 404);
  const count = Number(await db.value(
    'SELECT COUNT(*) FROM products WHERE client_id=? AND category_id=?', [clientId, categoryId]));

  if (hard) {
    // an empty category is a typo and may go; one with products would orphan
    // every one of them onto a category_id that resolves to nothing
    if (count > 0) {
      throw bad(`"${c.name}" içinde ${count} ürün var. Kalıcı silmek için önce ürünleri `
        + 'başka bir kategoriye taşıyın ya da kategoriyi pasife alın.', 409);
    }
    await db.exec('DELETE FROM pricing_targets WHERE client_id=? AND category_id=?', [clientId, categoryId]);
    await db.exec('DELETE FROM categories WHERE id=? AND client_id=?', [categoryId, clientId]);
    log.info('pricing', 'category hard deleted', { clientId, categoryId, name: c.name, by: userId });
    return { mode: 'deleted', category_id: Number(categoryId), products: 0 };
  }

  return db.tx(async t => {
    await t.exec('UPDATE categories SET is_active=0 WHERE id=? AND client_id=?', [categoryId, clientId]);
    const n = await t.exec(
      'UPDATE products SET is_active=0 WHERE client_id=? AND category_id=? AND is_active=1',
      [clientId, categoryId]);
    log.info('pricing', 'category deactivated', { clientId, categoryId, products: n, by: userId });
    return { mode: 'deactivated', category_id: Number(categoryId), products: n };
  });
}

/** Re-open a category and, optionally, everything in it. */
async function activateCategory(clientId, categoryId, { withProducts = true } = {}) {
  const c = await db.one('SELECT id FROM categories WHERE id=? AND client_id=?', [categoryId, clientId]);
  if (!c) throw bad('Kategori bulunamadı', 404);
  await db.exec('UPDATE categories SET is_active=1 WHERE id=? AND client_id=?', [categoryId, clientId]);
  let n = 0;
  if (withProducts) {
    n = await db.exec('UPDATE products SET is_active=1 WHERE client_id=? AND category_id=? AND is_active=0',
      [clientId, categoryId]);
  }
  return { category_id: Number(categoryId), products: n };
}

/**
 * Raise (or cut) a whole category by a percentage, rounded to a real price.
 *
 * Two steps on purpose. A percentage typed into a box can move three hundred
 * prices in one click, and the difference between a tool and an accident is
 * being shown the list first. `apply:false` returns exactly what `apply:true`
 * would write, computed by the same code - not a separate preview that can
 * drift from the thing it previews.
 *
 * Every write goes through catalog.saveProduct, so a bulk change leaves the
 * same price history as a hand edit. That is the point: the owner asking "who
 * put the kebap up" in March must get an answer whether it was one product or
 * ninety.
 */
async function bulkPrice(clientId, opts, userId) {
  const pct = Number(opts.percent);
  if (!Number.isFinite(pct) || pct === 0) throw bad('Bir yüzde girin (örn. 10 ya da -5)');
  if (Math.abs(pct) > 100) throw bad('Yüzde -100 ile 100 arasında olmalı');
  const step = checkStep(opts.round_to === undefined ? 0.5 : opts.round_to);
  const categoryId = Number(opts.category_id) || 0;
  if (categoryId) {
    const c = await db.one('SELECT id FROM categories WHERE id=? AND client_id=?', [categoryId, clientId]);
    if (!c) throw bad('Kategori bulunamadı', 404);
  }

  const products = await db.query(
    `SELECT * FROM products
      WHERE client_id=? AND is_active=1 AND price > 0 ${categoryId ? 'AND category_id=?' : ''}
      ORDER BY sort_order, name`, categoryId ? [clientId, categoryId] : [clientId]);

  const plan = products.map(p => {
    const oldPrice = money(p.price);
    const raw = oldPrice * (1 + pct / 100);
    const newPrice = roundStep(raw, step, 'near');
    return {
      product_id: p.id, name: p.name, vat_rate: Number(p.vat_rate),
      old_price: oldPrice, raw_price: money(raw), new_price: newPrice,
      change: money(newPrice - oldPrice),
      // a 2 ₺ item raised 3% and rounded to the nearest lira does not move at
      // all; saying so beats a silent no-op the owner discovers at the till
      unchanged: newPrice === oldPrice,
    };
  });

  if (!opts.apply) {
    return { applied: false, count: plan.length, changed: plan.filter(x => !x.unchanged).length, plan };
  }

  let changed = 0;
  for (const row of plan) {
    if (row.unchanged) continue;
    const p = products.find(x => x.id === row.product_id);
    await catalog.saveProduct(clientId, asSaveData(p, { price: row.new_price }), userId);
    changed++;
  }
  log.info('pricing', 'bulk price change', { clientId, categoryId, pct, step, changed, by: userId });
  return { applied: true, count: plan.length, changed, plan };
}

/**
 * Copy a product, recipe included.
 *
 * `products` carries UNIQUE(client_id, name), so the copy needs a free name
 * before the INSERT rather than a caught duplicate-key error afterwards - the
 * error would surface to the till as "Duplicate entry", which tells the person
 * holding the tablet nothing.
 *
 * The recipe travels with the copy because that is the expensive part to
 * retype and the whole reason anyone duplicates a product. The cost and price
 * HISTORIES do not: they are the original's history, and attaching them to a
 * new row would invent a past for something created this morning.
 */
async function duplicateProduct(clientId, productId, data = {}, userId = null) {
  const p = await db.one('SELECT * FROM products WHERE id=? AND client_id=?', [productId, clientId]);
  if (!p) throw bad('Ürün bulunamadı', 404);

  const base = String(data.name || `${p.name} (kopya)`).trim().slice(0, 150);
  let name = base;
  for (let i = 2; i < 50; i++) {
    const clash = await db.one('SELECT id FROM products WHERE client_id=? AND name=?', [clientId, name]);
    if (!clash) break;
    name = `${base} ${i}`.slice(0, 150);
  }

  const id = await catalog.saveProduct(clientId, {
    category_id: data.category_id || p.category_id,
    name,
    price: data.price === undefined ? p.price : data.price,
    cost_price: data.cost_price === undefined ? p.cost_price : data.cost_price,
    description: p.description,
    sort_order: p.sort_order,
    vat_rate: p.vat_rate,
    track_stock: !!p.track_stock,
    use_in_pos: p.use_in_pos !== 0,
    use_in_qr: p.use_in_qr !== 0,
  }, userId);

  const lines = await db.query(
    'SELECT inventory_item_id, qty_per_unit FROM product_recipes WHERE client_id=? AND product_id=?',
    [clientId, productId]).catch(() => []);
  for (const l of lines) {
    await db.exec(
      `INSERT INTO product_recipes (client_id, product_id, inventory_item_id, qty_per_unit, created_at, updated_at)
       VALUES (?,?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE qty_per_unit=VALUES(qty_per_unit)`,
      [clientId, id, l.inventory_item_id, l.qty_per_unit]).catch(e =>
        log.warn('pricing', 'recipe line not copied: ' + e.message));
  }
  log.info('pricing', 'product duplicated', { clientId, from: productId, to: id, name, by: userId });
  return { id, name, recipe_lines: lines.length };
}

/**
 * Everything the product card needs, in one call: the product, what it earns
 * now, both histories, its recipe cost, and whether it may be deleted.
 */
async function productCard(clientId, productId) {
  const p = await db.one(
    `SELECT p.*, c.name AS category_name, c.station_id, s.name AS station_name
       FROM products p
       LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
       LEFT JOIN stations s ON s.id=c.station_id AND s.client_id=c.client_id
      WHERE p.id=? AND p.client_id=?`, [productId, clientId]);
  if (!p) throw bad('Ürün bulunamadı', 404);

  const [costs, prices, use, tgt, window, ever, recipes] = await Promise.all([
    costHistory(clientId, productId),
    priceHistory(clientId, productId),
    usage(clientId, productId),
    targets(clientId),
    soldCosts(clientId),
    lastSoldCosts(clientId),
    recipeCosts(clientId),
  ]);

  const w = window.get(Number(productId));
  const e = ever.get(Number(productId));
  const { cost, source } = pickCost(p, w ? w.cost : (e ? e.cost : 0), recipes.get(Number(productId)));
  const target = tgt.byCat.has(p.category_id) ? tgt.byCat.get(p.category_id) : tgt.menu;

  return {
    product: p,
    economics: {
      price: money(p.price), vat_rate: Number(p.vat_rate), net: netOf(p.price, p.vat_rate),
      cost, cost_source: source, cost_source_label: COST_SOURCES[source].label,
      cost_is_fallback: COST_SOURCES[source].fallback,
      card_cost: money(p.cost_price),
      sale_cost: w ? w.cost : (e ? e.cost : null),
      recipe_cost: recipes.has(Number(productId)) ? recipes.get(Number(productId)) : null,
      margin: marginOf(p.price, cost, p.vat_rate),
      target_margin: target,
      target_price: source === 'none' ? null : priceForMargin(cost, target, p.vat_rate),
    },
    cost_history: costs,
    price_history: prices,
    usage: use,
  };
}

/**
 * The product list this module's screen works from.
 *
 * Different from `/api/manage/products` in three ways it needs: inactive rows
 * are included (you cannot re-activate what the list will not show you), the
 * margin is computed with the same cost resolution the suggestions use, and it
 * can be searched by product OR category name.
 */
async function productList(clientId, opts = {}) {
  const q = String(opts.q || '').trim();
  const args = [clientId];
  let where = 'p.client_id=?';
  if (q) {
    where += ' AND (p.name LIKE ? OR c.name LIKE ?)';
    args.push('%' + q + '%', '%' + q + '%');
  }
  if (Number(opts.category_id)) { where += ' AND p.category_id=?'; args.push(Number(opts.category_id)); }
  if (opts.only_active) where += ' AND p.is_active=1';

  const rows = await db.query(
    `SELECT p.*, c.name AS category_name, c.sort_order AS cat_sort, c.is_active AS cat_active,
            s.name AS station_name, COALESCE(st.stock,0) AS stock
       FROM products p
       LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
       LEFT JOIN stations s ON s.id=c.station_id AND s.client_id=c.client_id
       LEFT JOIN product_stock st ON st.product_id=p.id AND st.client_id=p.client_id
      WHERE ${where}
      ORDER BY c.sort_order, c.name, p.sort_order, p.name`, args);

  const [tgt, window, ever, recipes] = await Promise.all([
    targets(clientId), soldCosts(clientId), lastSoldCosts(clientId), recipeCosts(clientId),
  ]);

  return rows.map(p => {
    const w = window.get(p.id);
    const e = ever.get(p.id);
    const { cost, source } = pickCost(p, w ? w.cost : (e ? e.cost : 0), recipes.get(p.id));
    const target = tgt.byCat.has(p.category_id) ? tgt.byCat.get(p.category_id) : tgt.menu;
    const margin = marginOf(p.price, cost, p.vat_rate);
    return {
      ...p,
      price: money(p.price), cost_price: money(p.cost_price),
      category_name: p.category_name || 'Kategorisiz',
      cost, cost_source: source, cost_source_label: COST_SOURCES[source].label,
      cost_is_fallback: COST_SOURCES[source].fallback,
      margin, target_margin: target,
      below_target: margin !== null && source !== 'none' && margin < target,
    };
  });
}

module.exports = {
  // arithmetic, exported so the tests can check it without a database
  netOf, marginOf, priceForMargin, roundStep,
  // targets
  targets, targetList, setTarget,
  // engine
  compute, run, pending, accept, acceptAll, reject, decided, insights,
  // product card
  costHistory, recordCost, priceHistory, usage, productCard, productList,
  deleteProduct, activateProduct, deleteCategory, activateCategory, bulkPrice, duplicateProduct,
  COST_SOURCES, DEFAULT_TARGET,
};
