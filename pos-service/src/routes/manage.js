'use strict';
/** Manager screens: menu, tables, users, printers, settings, customers, costs. */
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const catalog = require('../modules/catalog');
const floor = require('../modules/floor');
const settingsMod = require('../modules/settings');
const customers = require('../modules/customers');
const guest = require('../modules/guest');
const expenses = require('../modules/expenses');
const printing = require('../print');
const transport = require('../print/transport');
const fiscal = require('../fiscal');
const loyalty = require('../modules/loyalty');
const backup = require('../backup');
const restore = require('../restore');
const portage = require('../modules/portage');
const { ok, fail, wrap, need } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);

/* --------------------------- menu import/export -------------------- */
/*
 * The file arrives base64 in JSON rather than as multipart: the till talks to
 * this service over one JSON API and adding a multipart parser for one screen
 * is a dependency and a second body path to get wrong. A menu is a few hundred
 * rows - well inside the 12 MB body limit.
 *
 * Import is two calls on purpose. /import/preview says what would happen and
 * changes nothing; /import/apply does it. The owner sees the price changes
 * before the menu the restaurant runs on is overwritten.
 */
function kindOf(req) {
  const k = String(req.params.kind || '').toLowerCase();
  if (k !== 'products' && k !== 'categories') {
    const e = new Error('Bilinmeyen liste: ' + k); e.status = 400; throw e;
  }
  return k;
}

r.get('/:kind/export', auth.requirePerm('product.manage'), wrap(async (req, res) => {
  const kind = kindOf(req);
  const fmt = String(req.query.format || 'xlsx').toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);
  const base = (kind === 'categories' ? 'kategoriler' : 'urunler') + '-' + stamp;
  if (fmt === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(await portage.exportCsv(req.clientId, kind));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
  res.send(Buffer.from(await portage.exportXlsx(req.clientId, kind)));
}));

r.get('/:kind/template', auth.requirePerm('product.manage'), wrap(async (req, res) => {
  const kind = kindOf(req);
  const fmt = String(req.query.format || 'xlsx').toLowerCase();
  const base = (kind === 'categories' ? 'kategori' : 'urun') + '-sablon';
  const body = await portage.template(kind, fmt);
  if (fmt === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(body);
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
  res.send(Buffer.from(body));
}));

r.post('/:kind/import/preview', auth.requirePerm('product.manage'), wrap(async (req, res) => {
  const kind = kindOf(req);
  const { filename = '', content_base64: b64 } = req.body || {};
  if (!b64) return fail(res, 'Dosya gonderilmedi', 400);
  const buf = Buffer.from(String(b64), 'base64');
  if (!buf.length) return fail(res, 'Dosya bos', 400);
  const rows = await portage.readFile(kind, buf, filename);
  const { plan, summary } = await portage.planImport(req.clientId, kind, rows);
  ok(res, { plan, summary });
}));

r.post('/:kind/import/apply', auth.requirePerm('product.manage'), wrap(async (req, res) => {
  const kind = kindOf(req);
  const { filename = '', content_base64: b64 } = req.body || {};
  if (!b64) return fail(res, 'Dosya gonderilmedi', 400);
  const rows = await portage.readFile(kind, Buffer.from(String(b64), 'base64'), filename);
  /*
   * The plan is recomputed here rather than trusted from the preview call.
   * A client that posted an edited plan could otherwise write any row it liked
   * into the menu, and the preview may in any case be minutes stale.
   */
  const { plan } = await portage.planImport(req.clientId, kind, rows);
  ok(res, await portage.applyImport(req.clientId, kind, plan, req.auth.uid));
}));

/* ------------------------------ menu ------------------------------ */
r.get('/categories', wrap(async (req, res) => ok(res, {
  categories: await db.query('SELECT * FROM categories WHERE client_id=? ORDER BY sort_order, id', [req.clientId]) })));
r.post('/categories', auth.requirePerm('product.manage'), wrap(async (req, res) =>
  ok(res, { id: await catalog.saveCategory(req.clientId, req.body) })));

r.get('/products', wrap(async (req, res) => ok(res, {
  products: await db.query(
    `SELECT p.*, c.name category_name, COALESCE(s.stock,0) stock FROM products p
       LEFT JOIN categories c ON c.id=p.category_id
       LEFT JOIN product_stock s ON s.product_id=p.id AND s.client_id=p.client_id
      WHERE p.client_id=? ORDER BY c.sort_order, p.sort_order, p.name`, [req.clientId]) })));
r.post('/products', auth.requirePerm('product.manage'), wrap(async (req, res) =>
  ok(res, { id: await catalog.saveProduct(req.clientId, req.body, req.auth.uid) })));
r.post('/products/:id/active', auth.requirePerm('product.manage'), wrap(async (req, res) => {
  await catalog.setProductActive(req.clientId, req.params.id, req.body.active);
  ok(res);
}));

/* ------------------------------ tables ---------------------------- */
r.get('/zones', wrap(async (req, res) => ok(res, {
  zones: await db.query('SELECT * FROM table_zones WHERE client_id=? ORDER BY sort_order, id', [req.clientId]) })));
r.post('/zones', auth.requirePerm('table.manage'), wrap(async (req, res) =>
  ok(res, { id: await catalog.saveZone(req.clientId, req.body) })));
r.get('/tables', wrap(async (req, res) => ok(res, {
  tables: await db.query('SELECT * FROM restaurant_tables WHERE client_id=? ORDER BY sort_order, id', [req.clientId]) })));
r.post('/tables', auth.requirePerm('table.manage'), wrap(async (req, res) =>
  ok(res, { id: await catalog.saveTable(req.clientId, req.body) })));
/*
 * The same range creation the floor plan screen uses, and deliberately the same
 * implementation: this route used to insert blindly and answer a duplicate name
 * with a 500 carrying the index name. floor.bulkCreate checks the names first,
 * revives deactivated ones and answers 409 with the names that clash.
 */
r.post('/tables/bulk', auth.requirePerm('table.manage'), wrap(async (req, res) => {
  const out = await floor.bulkCreate(req.clientId, req.body);
  ok(res, { ids: out.ids || [], created: out.created, revived: out.revived });
}));

/* ----------------------------- stations --------------------------- */
r.post('/stations', auth.requirePerm('settings.manage'), wrap(async (req, res) =>
  ok(res, { id: await catalog.saveStation(req.clientId, req.body) })));

/* ------------------------------ users ----------------------------- */
r.get('/users', auth.requirePerm('user.manage'), wrap(async (req, res) =>
  ok(res, { users: await catalog.users(req.clientId), permissions: auth.PERMISSIONS })));
r.post('/users', auth.requirePerm('user.manage'), wrap(async (req, res) => {
  try { ok(res, { id: await catalog.saveUser(req.clientId, req.body, req.auth.uid) }); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

/* ---------------------------- printers ---------------------------- */
r.get('/printers', wrap(async (req, res) => ok(res, {
  printers: await db.query('SELECT * FROM printers WHERE client_id=? ORDER BY id', [req.clientId]),
  windows_printers: await transport.listWindowsPrinters() })));

/*
 * Delegated to settings.savePrinter on purpose. This handler used to insert
 * straight into `printers`: it wrote NULL into the NOT NULL station_id, it did
 * not check the type or the address, and a second printer with the same name
 * came back as a 500 carrying the index name `uniq_printer`. There is one
 * printer writer in the product and this is it.
 */
r.post('/printers', auth.requirePerm('printer.manage'), wrap(async (req, res) => {
  const d = req.body || {};
  need(d.name, 'Yazici adi gerekli');
  need(d.type || d.kind, 'Yazici turu gerekli (windows / network / usb / file)');
  try {
    const id = await settingsMod.savePrinter(req.clientId, { ...d, type: d.type || d.kind });
    ok(res, { id });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

r.post('/printers/:id/test', auth.requirePerm('printer.manage'), wrap(async (req, res) => {
  try { await printing.testPrint(req.clientId, req.params.id); ok(res); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

r.get('/print-jobs', wrap(async (req, res) => ok(res, {
  jobs: await db.query('SELECT id, job_type, order_id, station_id, status, created_at, sent_at FROM print_jobs ORDER BY id DESC LIMIT 100') })));
r.post('/print-jobs/:id/retry', wrap(async (req, res) => {
  await db.exec("UPDATE print_jobs SET status='pending' WHERE id=?", [req.params.id]);
  ok(res);
}));

/* ------------------------------- ÖKC ------------------------------ */
r.get('/fiscal/devices', wrap(async (req, res) => ok(res, {
  devices: await fiscal.listDevices(req.clientId), providers: Object.keys(fiscal.ADAPTERS) })));
r.post('/fiscal/devices', auth.requirePerm('settings.manage'), wrap(async (req, res) =>
  ok(res, { id: await fiscal.saveDevice(req.clientId, req.body) })));
r.post('/fiscal/devices/:id/test', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  try { ok(res, await fiscal.testDevice(req.clientId, req.params.id)); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

/* ---------------------------- customers --------------------------- */
r.get('/customers', wrap(async (req, res) => ok(res, { customers: await customers.search(req.clientId, req.query.q) })));
/*
 * Delegated to guest.saveCustomer, and not a second implementation, because
 * `customers.phone` is UNIQUE across the whole platform: writing straight to
 * customers.save meant the till's own customer screen answered a repeat
 * number with a driver error - HTTP 500, the index name on the screen, and no
 * hint that the number belongs to a guest who is already on file. The guest
 * module already knew how to say that; this route simply did not ask it.
 *
 * `name` is what this older screen sends, `first_name` what the guest module
 * reads, so the two are reconciled here rather than in either module.
 */
r.post('/customers', auth.requirePerm('customer.manage'), wrap(async (req, res) => {
  const b = req.body || {};
  const whole = String(b.name || '').trim();
  const body = { ...b };
  if (!body.first_name && whole) {
    const parts = whole.split(/\s+/);
    body.last_name = body.last_name || (parts.length > 1 ? parts.slice(1).join(' ') : null);
    body.first_name = parts[0];
  }
  try {
    ok(res, await guest.saveCustomer(req.clientId, body));
  } catch (e) { fail(res, e.message, e.status || 400, e.code || null); }
}));
r.get('/customers/:id/history', wrap(async (req, res) => ok(res, {
  orders: await customers.history(req.clientId, req.params.id), cards: await customers.cards(req.clientId, req.params.id) })));

r.get('/loyalty/programs', wrap(async (req, res) => ok(res, {
  programs: await customers.programs(req.clientId),
  report: await loyalty.programReport(req.clientId),
  totals: await loyalty.totals(req.clientId) })));
r.post('/loyalty/programs', auth.requirePerm('settings.manage'), wrap(async (req, res) =>
  ok(res, { id: await customers.saveProgram(req.clientId, req.body) })));
/** Manual stamp, for the case the till missed one. */
r.post('/loyalty/stamp', auth.requirePerm('customer.manage'), wrap(async (req, res) => {
  const prog = (await loyalty.programs(req.clientId)).find(p => p.id === Number(req.body.program_id));
  if (!prog) return fail(res, 'Sadakat programi bulunamadi', 404);
  const out = await db.tx(t => loyalty.addStampIn(t, req.clientId, req.body.customer_id, prog,
    req.body.qty || 1, 'manual', req.body.order_id || null, req.auth.uid));
  ok(res, out);
}));
r.get('/loyalty/redemptions', auth.requirePerm('report.view'), wrap(async (req, res) =>
  ok(res, { rows: await loyalty.redemptions(req.clientId, req.query.from, req.query.to) })));

/* -------------------------- reservations -------------------------- */
r.get('/reservations', wrap(async (req, res) => ok(res, {
  reservations: await customers.reservations(req.clientId, req.query.date || new Date().toISOString().slice(0, 10)) })));
r.post('/reservations', auth.requirePerm('customer.manage'), wrap(async (req, res) =>
  ok(res, { id: await customers.saveReservation(req.clientId, req.body, req.auth.uid) })));
r.post('/reservations/:id/seat', auth.requirePerm('order.create'), wrap(async (req, res) =>
  ok(res, { order_id: await customers.seat(req.clientId, req.params.id, req.auth.uid) })));

/* ------------------------- costs & suppliers ---------------------- */
r.get('/costs', wrap(async (req, res) => ok(res, {
  costs: await expenses.dailyCosts(req.clientId, req.query.from, req.query.to) })));
r.post('/costs', auth.requirePerm('report.view'), wrap(async (req, res) =>
  ok(res, { id: await expenses.addCost(req.clientId, req.body, req.auth.uid) })));
r.delete('/costs/:id', auth.requirePerm('report.view'), wrap(async (req, res) => {
  await expenses.deleteCost(req.clientId, req.params.id); ok(res);
}));

r.get('/suppliers', wrap(async (req, res) => ok(res, { suppliers: await expenses.suppliers(req.clientId) })));
r.post('/suppliers', auth.requirePerm('stock.manage'), wrap(async (req, res) =>
  ok(res, { id: await expenses.saveSupplier(req.clientId, req.body) })));

r.get('/tasks', wrap(async (req, res) => ok(res, { tasks: await expenses.tasks(req.clientId) })));
r.post('/tasks', wrap(async (req, res) => ok(res, { id: await expenses.saveTask(req.clientId, req.body, req.auth.uid) })));
r.post('/tasks/:id/done', wrap(async (req, res) => { await expenses.completeTask(req.clientId, req.params.id, req.auth.uid); ok(res); }));

/* --------------------------- inventory ---------------------------- */
r.get('/inventory/items', wrap(async (req, res) => ok(res, { items: await expenses.inventoryItems(req.clientId) })));
r.post('/inventory/items', auth.requirePerm('stock.manage'), wrap(async (req, res) =>
  ok(res, { id: await expenses.saveInventoryItem(req.clientId, req.body) })));
r.get('/inventory/documents', wrap(async (req, res) => ok(res, {
  documents: await db.query(
    `SELECT d.*, s.name supplier_name FROM inventory_documents d LEFT JOIN suppliers s ON s.id=d.supplier_id
      WHERE d.client_id=? ORDER BY d.id DESC LIMIT 200`, [req.clientId]) })));
r.post('/inventory/documents', auth.requirePerm('stock.manage'), wrap(async (req, res) =>
  ok(res, { id: await expenses.saveDocument(req.clientId, req.body, req.auth.uid) })));
r.post('/inventory/documents/:id/approve', auth.requirePerm('stock.manage'), wrap(async (req, res) => {
  try { await expenses.approveDocument(req.clientId, req.params.id, req.auth.uid); ok(res); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

/* ---------------------------- settings ---------------------------- */
r.get('/settings', wrap(async (req, res) => {
  const rows = await db.query('SELECT k, v FROM np_settings');
  const map = {};
  for (const row of rows) if (!['jwt_secret', 'smtp_pass'].includes(row.k)) map[row.k] = row.v;
  const client = await db.one('SELECT company_name, receipt_header, receipt_footer, tax_number, tax_office, phone, full_address, receipt_station_id FROM clients WHERE id=?', [req.clientId]);
  const business = await db.one('SELECT * FROM business_settings WHERE client_id=? LIMIT 1', [req.clientId]);
  ok(res, { settings: map, client, business });
}));

r.post('/settings', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  for (const [k, v] of Object.entries(req.body.settings || {})) {
    if (k === 'jwt_secret') continue;
    await db.setSetting(k, v);
  }
  if (req.body.client) {
    const c = req.body.client;
    /*
     * tax_number, tax_office, phone and full_address are NOT NULL on `clients`,
     * and receipt_station_id is NOT NULL DEFAULT 0 - "no station chosen" is 0,
     * not NULL. Writing NULL into any of them answered 500 with the column name
     * on it, which is what a real till did every time Ayarlar was saved without
     * a receipt station picked. Not filled in is '' / 0.
     */
    const text = v => (v === undefined || v === null ? '' : String(v));
    await db.exec(
      'UPDATE clients SET receipt_header=?, receipt_footer=?, tax_number=?, tax_office=?, phone=?, full_address=?, receipt_station_id=? WHERE id=?',
      [c.receipt_header || null, c.receipt_footer || null, text(c.tax_number), text(c.tax_office),
       text(c.phone), text(c.full_address), Number(c.receipt_station_id) || 0, req.clientId]);
  }
  if (req.body.business) {
    const b = req.body.business;
    const exists = await db.one('SELECT id FROM business_settings WHERE client_id=?', [req.clientId]);
    if (exists) {
      await db.exec(
        'UPDATE business_settings SET business_name=?, legal_name=?, tax_number=?, tax_office=?, address_line1=?, city=?, phone=?, email=?, website=?, instagram=?, updated_at=NOW() WHERE client_id=?',
        [b.business_name, b.legal_name, b.tax_number, b.tax_office, b.address_line1, b.city, b.phone, b.email, b.website, b.instagram, req.clientId]);
    } else {
      await db.exec(
        'INSERT INTO business_settings (client_id, business_name, legal_name, tax_number, tax_office, address_line1, city, phone, email, website, instagram, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())',
        [req.clientId, b.business_name, b.legal_name, b.tax_number, b.tax_office, b.address_line1, b.city, b.phone, b.email, b.website, b.instagram]);
    }
  }
  ok(res);
}));

/* ----------------------------- backups ---------------------------- */
r.get('/backups', wrap(async (req, res) => ok(res, {
  backups: await db.query('SELECT id, kind, file_path, size_bytes, status, created_at FROM np_backups ORDER BY id DESC LIMIT 50') })));
r.post('/backups/run', auth.requirePerm('backup.run'), wrap(async (req, res) => {
  try { ok(res, await backup.run('manual')); } catch (e) { fail(res, e.message, 500); }
}));
/* The upload can only fail because of the other end - the licence could not be
   verified, or the panel did not answer - so it is a 502 and not a 500. The
   till is fine; the cloud is not, and the screen should say so. */
r.post('/backups/upload', auth.requirePerm('backup.run'), wrap(async (req, res) => {
  try { ok(res, await backup.uploadToCloud()); } catch (e) { fail(res, e.message, e.status || 502); }
}));

/* ------------------------- geri yükleme --------------------------- */
/*
 * Restore. Four endpoints and two different gates.
 *
 * All four are owner-only - the same `requireOwner` that stops a manager
 * taking last month's takings off the books in /api/finance. Restore is worse
 * than that: it erases everything since the snapshot, and unlike a deleted
 * bill there is no "Geri al" for the trade that never got written down.
 *
 * `/run` asks for the owner's password on top of the session, because being
 * logged in is what a till is, all day, on a counter a waiter walks past. The
 * password is the difference between "the owner decided this" and "somebody
 * was standing at an unlocked till".
 *
 * There is no endpoint here that the panel can call. `/cloud-fetch` pulls a
 * file down; the decision to load it is a separate call, made from this room.
 */
function restoreActor(req) {
  return {
    userId: req.auth.uid || null,
    role: req.auth.role || null,
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().slice(0, 45),
    userAgent: req.headers['user-agent'] || '',
  };
}

r.get('/restore/sources', auth.requireOwner, wrap(async (req, res) => ok(res, await restore.sources())));

r.post('/restore/preview', auth.requireOwner, wrap(async (req, res) => {
  try { ok(res, { preview: await restore.preview(req.body || {}) }); }
  catch (e) { fail(res, e.message, e.status || 400); }
}));

r.post('/restore/cloud-fetch', auth.requireOwner, wrap(async (req, res) => {
  try { ok(res, await restore.cloudFetch((req.body || {}).id)); }
  catch (e) { fail(res, e.message, e.status || 502); }
}));

r.post('/restore/run', auth.requireOwner, wrap(async (req, res) => {
  const body = req.body || {};
  try {
    await auth.verifyOwnerPassword(req.clientId, body.password, req.auth.uid);
  } catch (e) {
    return fail(res, e.message, e.status || 403, 'PASSWORD_REQUIRED');
  }
  try {
    ok(res, await restore.run({ file: body.file, reason: body.reason, actor: restoreActor(req) }));
  } catch (e) {
    /*
     * The pre-restore snapshot is named in the body as well as in the message,
     * so the screen can offer it as the way back without parsing a sentence.
     */
    res.status(e.status || 500).json({
      ok: false, error: e.message, code: 'RESTORE_FAILED',
      pre_restore: e.pre_restore || null, preview: e.preview || null,
    });
  }
}));

module.exports = r;
