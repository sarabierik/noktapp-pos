'use strict';
/** Everything the till screen does. */
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const orders = require('../modules/orders');
const catalog = require('../modules/catalog');
const payments = require('../modules/payments');
const stock = require('../modules/stock');
const printing = require('../print');
const mail = require('../mail');
const fiscal = require('../fiscal');
const loyalty = require('../modules/loyalty');
const bd = require('../util/businessDay');
const { ok, fail, wrap } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);

/* ------------------------------ menu ------------------------------ */
r.get('/menu', wrap(async (req, res) => ok(res, { menu: await catalog.menu(req.clientId) })));
r.get('/tables', wrap(async (req, res) => ok(res, await orders.tablePlan(req.clientId))));
r.get('/stations', wrap(async (req, res) => ok(res, { stations: await catalog.stations(req.clientId) })));

/* ----------------------------- orders ----------------------------- */
r.get('/orders/open', wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT o.id, o.adisyon_no, o.bill_label, o.grand_total, o.opened_at, o.table_id,
            t.name table_name, u.display_name waiter_name
       FROM orders o LEFT JOIN restaurant_tables t ON t.id=o.table_id
       LEFT JOIN users u ON u.id=o.waiter_id
      WHERE o.client_id=? AND o.status='open' AND o.is_deleted=0 ORDER BY o.opened_at`, [req.clientId]);
  ok(res, { orders: rows });
}));

r.get('/orders/recent-closed', wrap(async (req, res) =>
  ok(res, { orders: await orders.recentClosed(
    req.clientId, Number(req.query.limit) || 60, req.query.date || null) })));

r.get('/orders/:id', wrap(async (req, res) => {
  const o = await orders.getOrder(req.clientId, req.params.id);
  if (!o) return fail(res, 'Adisyon bulunamadi', 404);
  ok(res, { order: o });
}));

r.post('/orders', auth.requirePerm('order.create'), wrap(async (req, res) => {
  const id = await orders.openOrder(req.clientId, {
    tableId: req.body.table_id, waiterId: req.body.waiter_id || req.auth.uid,
    userId: req.auth.uid, label: req.body.label,
  });
  ok(res, { order_id: id, order: await orders.getOrder(req.clientId, id) });
}));

r.post('/orders/:id/items', auth.requirePerm('order.create'), wrap(async (req, res) => {
  /*
   * An ABSENT qty means one. A qty that is present and nonsense - 0, -1, "abc"
   * - is an error and is refused by the module. `req.body.qty || 1` turned all
   * three into a silent 1, so a till bug that sent 0 charged the guest for a
   * portion nobody ordered and nothing anywhere said so.
   */
  const qty = req.body.qty === undefined || req.body.qty === null || req.body.qty === ''
    ? 1 : req.body.qty;
  await orders.addItem(req.clientId, req.params.id, {
    productId: req.body.product_id, qty, note: req.body.note || null,
    unitPrice: req.body.unit_price, userId: req.auth.uid, appLocalId: req.body.app_local_id,
  });
  ok(res, { order: await orders.getOrder(req.clientId, req.params.id) });
}));

r.put('/orders/:id/items/:itemId', auth.requirePerm('order.create'), wrap(async (req, res) => {
  /*
   * The screen sends snake_case; the module takes camelCase. Spreading the body
   * straight through meant `discount_amount` never reached `discountAmount`,
   * so a per-line discount was accepted by the form and silently dropped.
   */
  const b = req.body || {};
  await orders.updateItem(req.clientId, req.params.id, req.params.itemId, {
    qty: b.qty, note: b.note,
    unitPrice: b.unit_price !== undefined ? b.unit_price : b.unitPrice,
    discountAmount: b.discount_amount !== undefined ? b.discount_amount : b.discountAmount,
    // why the line was discounted, so order_discounts can answer it later
    reason: b.reason || null,
    userId: req.auth.uid,
  });
  ok(res, { order: await orders.getOrder(req.clientId, req.params.id) });
}));

r.delete('/orders/:id/items/:itemId', auth.requirePerm('order.item.cancel'), wrap(async (req, res) => {
  await orders.cancelItem(req.clientId, req.params.id, req.params.itemId, {
    qty: req.body.qty ?? null, reason: req.body.reason || '', userId: req.auth.uid,
    approvedBy: req.body.approved_by || null,
  });
  ok(res, { order: await orders.getOrder(req.clientId, req.params.id) });
}));

r.post('/orders/:id/send', auth.requirePerm('order.create'), wrap(async (req, res) =>
  ok(res, await orders.sendToStations(req.clientId, req.params.id, req.auth.uid))));

r.post('/orders/:id/discount', auth.requirePerm('order.discount'), wrap(async (req, res) => {
  const total = await orders.setBillDiscount(req.clientId, req.params.id, {
    amount: req.body.amount ?? null, percent: req.body.percent ?? null,
    userId: req.auth.uid, approvedBy: req.body.approved_by, reason: req.body.reason,
  });
  ok(res, { grand_total: total, order: await orders.getOrder(req.clientId, req.params.id) });
}));

r.post('/orders/:id/label', auth.requirePerm('order.create'), wrap(async (req, res) =>
  ok(res, { label: await orders.renameBill(req.clientId, Number(req.params.id), req.body.label) })));

r.post('/orders/:id/transfer', auth.requirePerm('order.transfer'), wrap(async (req, res) => {
  await orders.transferTable(req.clientId, req.params.id, req.body.table_id, req.auth.uid);
  ok(res);
}));

r.post('/orders/:id/split', auth.requirePerm('order.split'), wrap(async (req, res) => {
  const newId = await orders.splitBill(req.clientId, req.params.id, req.body.lines || [], req.auth.uid);
  ok(res, { order_id: newId });
}));

r.post('/orders/:id/merge', auth.requirePerm('order.split'), wrap(async (req, res) => {
  await orders.mergeBills(req.clientId, req.params.id, req.body.source_order_id, req.auth.uid);
  ok(res, { order: await orders.getOrder(req.clientId, req.params.id) });
}));

/* ------------------------ masa birlestirme ------------------------ */
/**
 * Joined tables. One party, several tables, ONE adisyon.
 *
 * These sit on `order.transfer` - the same key as "masa / adisyon tasima",
 * because it is the same authority: deciding which table a bill belongs to.
 * Every failure the module raises is a sentence naming what is in the way (a
 * bill, another group), so it is passed through rather than flattened.
 */
const tablegroup = require('../modules/tablegroup');
const groupFail = (res, e) => fail(res, e.message, e.status || 400, e.code || null);

r.get('/table-groups', wrap(async (req, res) =>
  ok(res, { groups: await tablegroup.list(req.clientId) })));

r.get('/table-groups/:id', wrap(async (req, res) => {
  const g = await tablegroup.get(req.clientId, Number(req.params.id));
  if (!g) return fail(res, 'Grup bulunamadi', 404);
  ok(res, { group: g });
}));

/** Which group - and which bill - does this table belong to right now? */
r.get('/tables/:id/group', wrap(async (req, res) => {
  const g = await tablegroup.groupOfTable(db, req.clientId, Number(req.params.id));
  ok(res, { group: g ? await tablegroup.get(req.clientId, g.id) : null });
}));

r.post('/table-groups', auth.requirePerm('order.transfer'), wrap(async (req, res) => {
  try {
    ok(res, { group: await tablegroup.create(req.clientId, {
      tableIds: req.body.table_ids || [],
      primaryTableId: req.body.primary_table_id || null,
      waiterId: req.body.waiter_id || req.auth.uid,
      userId: req.auth.uid, note: req.body.note || null,
    }) });
  } catch (e) { groupFail(res, e); }
}));

r.post('/table-groups/:id/tables', auth.requirePerm('order.transfer'), wrap(async (req, res) => {
  try {
    ok(res, { group: await tablegroup.addTable(
      req.clientId, Number(req.params.id), Number(req.body.table_id), req.auth.uid) });
  } catch (e) { groupFail(res, e); }
}));

r.delete('/table-groups/:id/tables/:tableId', auth.requirePerm('order.transfer'), wrap(async (req, res) => {
  try {
    ok(res, await tablegroup.removeTable(
      req.clientId, Number(req.params.id), Number(req.params.tableId), req.auth.uid));
  } catch (e) { groupFail(res, e); }
}));

/** Dagit. The bill stays open on the primary table; the others go free. */
r.post('/table-groups/:id/ungroup', auth.requirePerm('order.transfer'), wrap(async (req, res) => {
  try {
    ok(res, { group: await tablegroup.ungroup(req.clientId, Number(req.params.id), req.auth.uid) });
  } catch (e) { groupFail(res, e); }
}));

/** Reopen a bill closed by mistake - the thing the old system could not do. */
r.post('/orders/:id/reopen', auth.requirePerm('order.reopen'), wrap(async (req, res) => {
  try {
    const out = await orders.reopen(req.clientId, req.params.id, {
      userId: req.auth.uid, userName: req.auth.name, reason: req.body.reason || '',
    });
    ok(res, { ...out, order: await orders.getOrder(req.clientId, req.params.id) });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

/**
 * Delete a bill. THE OWNER ONLY, and never one the day has closed over.
 *
 * This used to sit on the `order.delete` permission, which meant a manager - or
 * anyone the owner had granted that key to - could erase takings from this
 * door, while the same action through the finance screen was owner-only and
 * refused to touch a bill inside a closed day. Two doors, two rules, and the
 * weaker one was the one nobody was watching.
 */
r.delete('/orders/:id', wrap(async (req, res) => {
  const a = req.auth;
  const isOwner = !!a && (a.kind === 'tenant' || a.role === 'superadmin');
  if (!isOwner) return fail(res, 'Adisyon silme yetkisi yalnizca isletme sahibindedir.', 403);

  // the day-close checkpoint: a bill inside a closed day is a signed record
  const finance = require('../modules/finance');
  if (await finance.orderIsLocked(req.clientId, Number(req.params.id))) {
    return fail(res, finance.LOCK_MESSAGE, 409, 'DAY_CLOSED');
  }
  const reason = String(req.body.reason || '').trim();
  if (!reason) return fail(res, 'Silme sebebi zorunlu.', 400);

  await orders.deleteBill(req.clientId, req.params.id, {
    userId: req.auth.uid, reason,
    ip: req.ip, ua: req.headers['user-agent'], approvedBy: req.body.approved_by,
  });
  ok(res);
}));

/* ---------------------------- payments ---------------------------- */
r.post('/orders/:id/payments', auth.requirePerm('payment.take'), wrap(async (req, res) => {
  try {
    const out = await payments.addPayment(req.clientId, req.params.id, {
      method: req.body.method, amount: req.body.amount, userId: req.auth.uid,
      channel: req.body.channel || 'pos', guest: req.body.guest || null,
    });
    if (req.body.print_bill) await printing.queueBill(req.clientId, req.params.id);
    if (req.body.open_drawer && req.body.method === 'nakit') await printing.openDrawer(req.clientId);
    ok(res, { ...out, order: await orders.getOrder(req.clientId, req.params.id) });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

r.post('/payments/:id/void', auth.requirePerm('payment.void'), wrap(async (req, res) => {
  await payments.voidPayment(req.clientId, req.params.id, {
    userId: req.auth.uid, reason: req.body.reason, ip: req.ip, ua: req.headers['user-agent'],
  });
  ok(res);
}));

/* ------------------------------ ÖKC ------------------------------- */
r.post('/orders/:id/fiscal/pay', auth.requirePerm('fiscal.use'), wrap(async (req, res) => {
  try {
    const out = await fiscal.beginSale(req.clientId, req.params.id, {
      method: req.body.method || 'kredi_karti', amount: req.body.amount,
      installments: req.body.installments || 0, userId: req.auth.uid,
      cashRegisterId: req.body.cash_register_id || null,
    });
    ok(res, out);
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

r.get('/fiscal/transactions/:id', wrap(async (req, res) => {
  const tx = await fiscal.getTransaction(req.clientId, req.params.id);
  if (!tx) return fail(res, 'Islem bulunamadi', 404);
  ok(res, { transaction: tx });
}));

r.post('/fiscal/transactions/:id/cancel', auth.requirePerm('fiscal.use'), wrap(async (req, res) => {
  await fiscal.cancel(req.clientId, req.params.id);
  ok(res);
}));

/* An OKC that does not answer is a device that is off or unplugged, not a
   fault in the till: 502, with the adapter's own message, so the cashier reads
   "baglanti hatasi" instead of "Sunucu hatasi". */
r.post('/fiscal/report', auth.requirePerm('day.close'), wrap(async (req, res) => {
  try { ok(res, await fiscal.deviceReport(req.clientId, req.body.kind || 'X')); }
  catch (e) { fail(res, e.message, e.status || 502); }
}));

/* ---------------------------- sadakat ------------------------------ */
/**
 * "Sadakat kartiniz var mi?" - the cashier scans the guest's QR, or types
 * their phone. One call attaches the guest to the bill and stamps every
 * programme their basket matches.
 */
r.post('/orders/:id/loyalty/scan', auth.requirePerm('customer.manage'), wrap(async (req, res) => {
  const out = await loyalty.applyToOrder(req.clientId, req.body.token || req.body.phone, req.params.id, req.auth.uid);
  if (!out.ok) return fail(res, out.message, out.error === 'PHONE_UNKNOWN' ? 404 : 409, out.error);
  ok(res, { ...out, order: await orders.getOrder(req.clientId, req.params.id) });
}));

/** Look a guest up without touching the bill - used by the search box. */
r.post('/loyalty/lookup', auth.requirePerm('customer.manage'), wrap(async (req, res) => {
  const found = await loyalty.resolve(req.body.token || req.body.phone);
  if (found.error) return fail(res, loyalty.errorText(found.error), 404, found.error);
  ok(res, { customer: found.customer, cards: await loyalty.cardsFor(req.clientId, found.customer.id) });
}));

/** Enrol someone at the counter - always an explicit action, never silent. */
r.post('/loyalty/enrol', auth.requirePerm('customer.manage'), wrap(async (req, res) => {
  try {
    const c = await loyalty.enrol(req.clientId, {
      firstName: req.body.first_name, lastName: req.body.last_name,
      phone: req.body.phone, email: req.body.email });
    ok(res, { customer: c, cards: await loyalty.cardsFor(req.clientId, c.id) });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

r.get('/loyalty/customers/:id/cards', wrap(async (req, res) =>
  ok(res, { cards: await loyalty.cardsFor(req.clientId, req.params.id) })));

/** Spend a reward. Takes the free item's price off the open bill. */
r.post('/loyalty/redeem', auth.requirePerm('customer.manage'), wrap(async (req, res) => {
  try {
    const out = await loyalty.redeem(req.clientId, {
      customerId: req.body.customer_id, cardId: req.body.card_id,
      orderId: req.body.order_id || null, userId: req.auth.uid });
    ok(res, {
      ...out,
      cards: await loyalty.cardsFor(req.clientId, req.body.customer_id),
      order: req.body.order_id ? await orders.getOrder(req.clientId, req.body.order_id) : null,
    });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

/** Attach a guest to a bill without stamping (they will be stamped on close). */
r.post('/orders/:id/customer', auth.requirePerm('customer.manage'), wrap(async (req, res) => {
  /*
   * Delegated rather than a blind UPDATE: this used to attach a guest to a
   * CLOSED bill, which records a visit that can never earn a stamp, because
   * stamping happens at close and that moment has passed.
   */
  await require('../modules/guest').attachToOrder(
    req.clientId, Number(req.params.id), req.body.customer_id || null);
  ok(res, { order: await orders.getOrder(req.clientId, req.params.id) });
}));

/* --------------------------- print / mail -------------------------- */
r.post('/orders/:id/print', wrap(async (req, res) => {
  await printing.queueBill(req.clientId, req.params.id, { title: req.body.title || 'HESAP FISI' });
  ok(res);
}));

r.post('/orders/:id/mail', wrap(async (req, res) => {
  if (!req.body.email) return fail(res, 'E-posta adresi gerekli');
  ok(res, await mail.queueBill(req.clientId, req.params.id, req.body.email));
}));

r.post('/drawer', auth.requirePerm('payment.take'), wrap(async (req, res) => {
  /*
   * Audited. A drawer opened with no sale behind it is the classic theft
   * signal, and it was the one thing this route did not record - so the Kasa
   * screen's "satissiz cekmece" list could never see the two places that
   * actually kick the drawer.
   */
  ok(res, await require('../modules/till').openDrawer(req.clientId, {
    userId: req.auth.uid, userName: req.auth.name,
    orderId: req.body.order_id || null, reason: req.body.reason || null,
  }));
}));

/* ----------------------------- shifts ------------------------------ */
/*
 * Open to everybody who can sign in, because the shell's header asks for it on
 * every screen - a waiter's included - to draw "vardiya #3 açık". But the
 * summary itself is the drawer: the float, the expected cash, the split by
 * method, the movements in and out. A waiter got all of it for the sake of a
 * two-word chip.
 *
 * So the answer is cut to what the asker is entitled to: the whole summary for
 * anyone who works the till or reads the reports, and the shift's number,
 * state and opening time for everybody else. The header looks identical; the
 * money is not in the response at all.
 */
r.get('/shift', wrap(async (req, res) => {
  const full = await payments.shiftSummary(req.clientId);
  if (!full) return ok(res, { shift: null });
  const perms = await auth.permissionsFor(req.clientId, req.auth.uid, req.auth.role);
  if (perms.includes('payment.take') || perms.includes('report.view')) return ok(res, { shift: full });
  const s = full.shift || {};
  ok(res, { shift: { shift: { id: s.id, shift_no: s.shift_no, status: s.status, opened_at: s.opened_at,
    opened_by_name: s.opened_by_name } } });
}));
r.post('/shift/open', auth.requirePerm('shift.open'), wrap(async (req, res) => {
  try {
    ok(res, await payments.openShift(req.clientId, {
      userId: req.auth.uid, userName: req.auth.name, openingFloat: req.body.opening_float || 0,
    }));
  } catch (e) { fail(res, e.message, e.status || 400); }
}));
r.post('/shift/close', auth.requirePerm('shift.close'), wrap(async (req, res) => {
  try {
    ok(res, await payments.closeShift(req.clientId, {
      countedCash: req.body.counted_cash, note: req.body.note,
      userId: req.auth.uid, userName: req.auth.name,
    }));
  } catch (e) { fail(res, e.message, e.status || 400); }
}));
r.post('/shift/movement', auth.requirePerm('payment.take'), wrap(async (req, res) =>
  ok(res, { id: await payments.shiftMovement(req.clientId, { ...req.body, userId: req.auth.uid }) })));

/* --------------------------- station board -------------------------- */
r.get('/stations/:id/board', wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT s.*, p.name product_name, o.adisyon_no, t.name table_name
       FROM station_projection_items s
       LEFT JOIN products p ON p.id=s.product_id
       LEFT JOIN orders o ON o.id=s.order_id
       LEFT JOIN restaurant_tables t ON t.id=o.table_id
      WHERE s.client_id=? AND s.station_id=? AND s.station_status IN ('new','preparing','ready')
      ORDER BY s.created_at`, [req.clientId, req.params.id]);
  ok(res, { items: rows });
}));

r.post('/stations/items/:id/state', wrap(async (req, res) => {
  await db.exec('UPDATE station_projection_items SET station_status=?, updated_at=NOW() WHERE id=? AND client_id=?',
    [req.body.state, req.params.id, req.clientId]);
  await db.exec(
    `UPDATE order_items SET station_status=?, station_updated_at=NOW()
      WHERE id=(SELECT order_item_id FROM station_projection_items WHERE id=?)`,
    [req.body.state === 'done' ? 'served' : req.body.state, req.params.id]).catch(() => {});
  ok(res);
}));

/* ------------------------------ stock ------------------------------ */
r.get('/stock', wrap(async (req, res) => ok(res, { stock: await stock.levels(req.clientId) })));
r.post('/stock/:productId', auth.requirePerm('stock.manage'), wrap(async (req, res) =>
  ok(res, { stock: await stock.adjust(req.clientId, req.params.productId, req.body.quantity, req.auth.uid) })));

r.get('/business-date', wrap(async (req, res) => {
  const date = await bd.currentBusinessDate();
  ok(res, { business_date: date, closed: await bd.isDayClosed(req.clientId, date) });
}));

module.exports = r;
