'use strict';
/**
 * UÇLAR — every endpoint, called at least once.
 *
 * WHAT THIS IS AND, MORE IMPORTANTLY, WHAT IT IS NOT.
 *
 * The other suites test BEHAVIOUR: that the VAT is inclusive, that a courier's
 * cash reconciles, that a day cannot close twice. This one tests only that an
 * endpoint EXISTS, authorises, and answers without falling over. It is the
 * floor, not the ceiling.
 *
 * It exists because test/kapsam.js measured the run and found 136 of 442
 * endpoints had never been called by anything - not once, in any suite. An
 * endpoint nobody has ever called is not "probably fine": it is code whose
 * first execution will be on a restaurant's counter. Half of the bugs found
 * in this product so far were of exactly that shape - a screen that pointed
 * at a page id nobody had opened, a setting nothing read, a guard nothing
 * passed a value to.
 *
 * So: a 500 here is a failure. A 400, 403, 404 or 409 is a PASS, because the
 * endpoint was reached, the auth ran and the handler made a decision. So is a
 * 502 or a 503: this container has no OKC on the counter and no panel behind
 * every call, and "the other end did not answer" is a decision too. And so is a
 * 501 - the OKC message layer refusing to drive a real device until it has been
 * verified against the manufacturer's document is the most deliberate decision
 * in this product. What is
 * being proven is that the wire is live, not that the answer is right - and
 * saying so plainly matters, because a suite like this can otherwise be
 * mistaken for the thing it is not.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/uclar.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7492';
const _assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
let TOKEN = null;

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, ...json };
}

const results = [];
function note(ok, name, detail) {
  results.push([ok ? 'PASS' : 'FAIL', name, detail]);
  if (!ok) console.log('  FAIL  ' + name + '  -> ' + detail);
}

/**
 * One call. A server error is the only failure; a refusal is the handler
 * doing its job.
 */
async function hit(method, path, body) {
  const label = method + ' ' + path;
  try {
    const r = await api(method, path, body);
    /* 501 = deliberately not implemented yet; 502/503 = the other end, not us */
    const upstream = r.status === 501 || r.status === 502 || r.status === 503;
    if (r.status >= 500 && !upstream) {
      note(false, label, 'HTTP ' + r.status + ' ' + (r.error || '')); return r;
    }
    note(true, label);
    return r;
  } catch (e) {
    note(false, label, e.message);
    return { status: 0 };
  }
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - uçlar (every endpoint answers)\n');
  TOKEN = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Test', kind: 'tenant' });

  /* ------------------------------------------------------- fixtures */
  /* Real ids, so a :id route is exercised with something that exists rather
     than answering 404 for a reason that has nothing to do with the code. */
  const one = async (sql) => (await db.one(sql, [CID])) || {};
  const product = await one("SELECT id FROM products WHERE client_id=? AND is_active=1 ORDER BY id LIMIT 1");
  const category = await one('SELECT id FROM categories WHERE client_id=? ORDER BY id LIMIT 1');
  const table = await one('SELECT id, zone_id FROM restaurant_tables WHERE client_id=? ORDER BY id LIMIT 1');
  const order = await one("SELECT id FROM orders WHERE client_id=? AND is_deleted=0 ORDER BY id DESC LIMIT 1");
  const item = await one('SELECT id FROM order_items WHERE client_id=? ORDER BY id DESC LIMIT 1');
  const customer = await db.one('SELECT id FROM customers ORDER BY id LIMIT 1') || {};
  const station = await one('SELECT id FROM stations WHERE client_id=? ORDER BY id LIMIT 1');
  const _user = await one('SELECT id FROM users WHERE client_id=? ORDER BY id LIMIT 1');
  const courier = await one('SELECT id FROM couriers WHERE client_id=? ORDER BY id LIMIT 1');
  const delivery = await one('SELECT id FROM delivery_orders WHERE client_id=? ORDER BY id DESC LIMIT 1');
  const _zone = await one('SELECT id FROM delivery_zones WHERE client_id=? ORDER BY id LIMIT 1');
  const jobRow = await one('SELECT id FROM print_jobs WHERE client_id=? ORDER BY id DESC LIMIT 1');
  const invItem = await one('SELECT id FROM inventory_items WHERE client_id=? ORDER BY id LIMIT 1');
  const ID = (x) => (x && x.id) || 0;

  /* ============================ READS ============================== */
  /* Every GET the run was not touching. A read cannot damage anything, so
     they are driven wholesale. */
  const reads = [
    '/api/health',
    '/api/auth/devices', '/api/auth/permissions', '/api/auth/features',
    '/api/manage/settings', '/api/manage/users', '/api/manage/tables', '/api/manage/zones',
    '/api/manage/printers', '/api/manage/suppliers', '/api/manage/tasks', '/api/manage/costs',
    '/api/manage/print-jobs', '/api/manage/fiscal/devices', '/api/manage/loyalty/programs',
    '/api/manage/loyalty/redemptions', '/api/manage/inventory/items', '/api/manage/inventory/documents',
    `/api/manage/customers/${ID(customer)}/history`,
    '/api/settings/printers',
    '/api/receipt/queue', '/api/receipt/preview',
    '/api/reports/products', '/api/reports/waiters', '/api/reports/cancellations',
    '/api/reports/pnl/products', '/api/reports/pnl/categories',
    '/api/finance/payments',
    '/api/till/denominations',
    '/api/inventory/units', '/api/inventory/categories', '/api/inventory/waste/reasons',
    `/api/inventory/levels/${ID(invItem)}/ledger`,
    '/api/guest/customers/top',
    '/api/qr/settings',
    '/api/device/branch', '/api/device/branch/history',
    '/api/mobile/ping', '/api/mobile/tables',
    `/api/mobile/tables/${ID(table)}/order`, `/api/mobile/orders/${ID(order)}`,
    '/api/integrations/providers', '/api/integrations/UBER_EATS_TGO/menu/preview',
    '/api/integrations/UBER_EATS_TGO/mapping',
    '/api/manage/products/template?format=csv', '/api/manage/categories/template?format=csv',
    '/api/delivery/cancel-codes', `/api/delivery/orders/${ID(delivery)}`,
    `/api/delivery/addresses?customer_id=${ID(customer)}`,
    `/api/delivery/customers/${ID(customer)}/flag`,
    '/api/display',
  ];
  for (const p of reads) await hit('GET', p);

  /* A create whose id the next call needs. A refusal is still a pass for the
     create itself - the follow-up simply does not run. */
  const mkRow = (method, path, body) => hit(method, path, body);

  /* ============================ WRITES ============================= */
  /* Safe writes against the fixtures: each one is either idempotent, or
     creates a row this suite then leaves behind on a test database. */
  await hit('POST', '/api/manage/settings', { settings: {} });
  await hit('POST', '/api/manage/customers', { first_name: 'Uc', last_name: 'Testi', phone: '0500 111 00 ' + String(Date.now()).slice(-2) });
  await hit('POST', '/api/manage/zones', { name: 'Uç Testi Alan' });
  await hit('POST', '/api/manage/tables', { zone_id: table.zone_id, name: 'UçMasa' + String(Date.now()).slice(-4) });
  await hit('POST', '/api/manage/tables/bulk', { prefix: 'UT' + String(Date.now()).slice(-5), from: 1, to: 2 });
  await hit('POST', '/api/manage/stations', { name: 'Uç İstasyon' + String(Date.now()).slice(-3) });
  await hit('POST', '/api/manage/suppliers', { name: 'Uç Tedarikçi', phone: '02120000000' });
  await hit('POST', '/api/manage/tasks', { title: 'Uç görevi', due_on: '2030-01-01', kind: 'genel' });
  await hit('POST', '/api/manage/users', { display_name: 'Uç Kullanıcı', username: 'uc' + String(Date.now()).slice(-5), role: 'waiter', pin: '9911' });
  await hit('POST', '/api/manage/printers', { name: 'Uç Yazıcı', type: 'usb', ip_address: 'NUL' });
  await hit('POST', `/api/manage/products/${ID(product)}/active`, { active: true });
  await hit('POST', '/api/manage/loyalty/programs', { title: 'Uç Program', target_count: 5,
    reward_text: 'Bir kahve ikram', product_id: ID(product) });
  await hit('POST', '/api/manage/reservations', { guest_name: 'Uç Misafir', guest_phone: '05000000000',
    starts_at: '2030-01-01 20:00:00', party_size: 2, table_id: ID(table) });
  await hit('POST', '/api/manage/inventory/items', { name: 'Uç Malzeme', unit: 'kg' });
  await hit('POST', '/api/inventory/units', { name: 'uçbirim', short_name: 'ub' });
  await hit('POST', '/api/inventory/categories', { name: 'Uç Kategori' });
  await hit('POST', `/api/pos/stock/${ID(product)}`, { quantity: 5 });
  await hit('POST', '/api/pos/drawer', {});
  await hit('POST', '/api/pos/loyalty/lookup', { phone: '05000000000' });
  await hit('POST', '/api/pos/shift/movement', { kind: 'in', amount: 1, note: 'uç testi' });
  await hit('POST', `/api/pos/stations/items/${ID(item)}/state`, { state: 'hazir' });
  await hit('POST', '/api/receipt/printers/scan', {});
  await hit('POST', '/api/receipt/queue/retry-failed', {});
  await hit('POST', '/api/receipt/display', { text: 'uç' });
  await hit('POST', `/api/receipt/stations/${ID(station)}/default`, {});
  await hit('POST', '/api/settings/printers/scan', {});
  await hit('POST', '/api/settings/stations/order', { order: [ID(station)] });
  await hit('POST', '/api/floor/zones/reorder', { order: [table.zone_id] });
  await hit('POST', `/api/floor/tables/${ID(table)}/seats`, { seats: 4 });
  await hit('POST', '/api/qr/settings', { business_name: 'Uç Restoran', theme: 'orange', is_published: 0 });
  await hit('POST', '/api/qr/publish', {});
  await hit('POST', '/api/integrations/poll', { provider: 'UBER_EATS_TGO' });
  await hit('POST', '/api/integrations/events/retry-all', {});
  await hit('POST', '/api/integrations/UBER_EATS_TGO/prep-time', { minutes: 25 });
  await hit('POST', `/api/integrations/UBER_EATS_TGO/product/${ID(product)}/price`, { price: 100 });
  await hit('POST', `/api/integrations/UBER_EATS_TGO/category/${ID(category)}/availability`, { available: true });
  await hit('POST', `/api/delivery/couriers/${ID(courier)}/shift`, {});
  await hit('POST', '/api/device/connection/check', {});
  await hit('POST', '/api/auth/override', { pin: '0000', perm: 'order.delete' });
  await hit('POST', '/api/setup/business', { business_name: 'Test Restoran', phone: '02120000000' });
  await hit('POST', '/api/setup/seed', {});

  /*
   * The rest of the surface. Where a call would change something a later suite
   * reads, it is made against an id that does not exist: the route, its auth
   * and its handler still run, and nothing in the database moves. Where it is
   * safe, the real thing is done.
   */
  await hit('POST', '/api/receipt', { settings: {} });
  await hit('POST', '/api/setup/finish', {});
  await hit('POST', '/api/manage/backups/upload', {});
  await hit('POST', '/api/device/branch/bind', { code: 'YOK-0000' });
  await hit('POST', '/api/device/branch/pull', {});
  await hit('POST', '/api/auth/devices/999999/revoke', {});
  await hit('POST', '/api/inventory/counts/999999/cancel', {});
  await hit('POST', '/api/reports/reopen-day', { date: '2020-01-01' });
  await hit('POST', '/api/pos/fiscal/report', { kind: 'X' });
  await hit('POST', '/api/pos/fiscal/transactions/999999/cancel', {});
  await hit('POST', '/api/pos/loyalty/enrol', {
    first_name: 'Uc', last_name: 'Sadakat', phone: '0533 000 ' + String(Date.now()).slice(-4) });
  await hit('POST', '/api/pos/loyalty/redeem', { customer_id: ID(customer), card_id: 999999 });
  await hit('POST', '/api/manage/loyalty/stamp', { program_id: 999999, customer_id: ID(customer) });
  await hit('POST', `/api/pos/orders/${ID(order)}/mail`, { email: 'uc@ornek.com' });
  await hit('DELETE', `/api/mobile/orders/${ID(order)}/items/999999`, {});
  await hit('POST', '/api/manage/inventory/documents/999999/approve', {});
  await hit('DELETE', '/api/settings/okc/devices/999999');

  /* A whole document, because "the stock paperwork saves" is worth one row. */
  const _doc = await mkRow('POST', '/api/manage/inventory/documents', {
    type: 'purchase', document_no: 'UC-' + String(Date.now()).slice(-6),
    document_date: '2030-01-01', total_amount: 100,
    items: [{ item_id: ID(invItem) || null, raw_name: 'Uç kalemi', quantity: 1, unit: 'kg',
              unit_price: 100, vat_rate: 10 }] });

  /* The printer routes need a printer that really exists; a windows printer
     with a device name is the one kind this container can create. */
  const p1 = await mkRow('POST', '/api/receipt/printers',
    { name: 'Uç Fiş Yazıcı ' + String(Date.now()).slice(-4), type: 'usb', ip_address: 'NUL' });
  if (p1.id) {
    await hit('POST', `/api/receipt/printers/${p1.id}/receipt`, {});
    await hit('POST', `/api/receipt/printers/${p1.id}/test`, {});
    await hit('DELETE', `/api/receipt/printers/${p1.id}`);
  }
  const p2 = await mkRow('POST', '/api/settings/printers',
    { name: 'Uç Ayar Yazıcı ' + String(Date.now()).slice(-4), type: 'usb', ip_address: 'NUL' });
  if (p2.id) await hit('DELETE', `/api/settings/printers/${p2.id}`);

  /* The reservation is seated for real: it opens a bill, which is the whole
     point of the endpoint, and the table it uses is released again below. */
  const resv = await mkRow('POST', '/api/manage/reservations', {
    guest_name: 'Uç Oturtma', guest_phone: '05000000001',
    starts_at: '2030-01-02 20:00:00', party_size: 2, table_id: ID(table) });
  if (resv.id) {
    const seated = await hit('POST', `/api/manage/reservations/${resv.id}/seat`, {});
    /* and the bill it opened is removed again, so the table it used is free
       for whatever runs after this suite */
    if (seated.order_id) await hit('DELETE', `/api/pos/orders/${seated.order_id}`,
      { reason: 'uç testi' });
  }

  const task = await mkRow('POST', '/api/manage/tasks',
    { title: 'Uç kapanacak görev', due_on: '2030-01-01' });
  if (task.id) await hit('POST', `/api/manage/tasks/${task.id}/done`, {});

  /* Printing and reports write paper, which on Linux fails at the spooler and
     is the point: the ENDPOINT is what is being exercised, and a queued job
     that cannot print is not a 500. */
  await hit('POST', `/api/pos/orders/${ID(order)}/print`, {});
  await hit('POST', `/api/mobile/orders/${ID(order)}/print`, {});
  await hit('POST', '/api/reports/z/print', {});
  await hit('POST', '/api/finance/x-report/print', {});
  await hit('POST', `/api/manage/printers/${ID(jobRow)}/test`, {});
  if (ID(jobRow)) {
    await hit('POST', `/api/manage/print-jobs/${ID(jobRow)}/retry`, {});
    await hit('POST', `/api/settings/print-jobs/${ID(jobRow)}/cancel`, {});
    await hit('POST', `/api/receipt/queue/${ID(jobRow)}/retry`, {});
    await hit('POST', `/api/receipt/queue/${ID(jobRow)}/cancel`, {});
  }

  /* ============================ DELETES ============================ */
  /* Each against a row this suite made, so nothing a person cares about is
     touched even when the suite is pointed at a real database by mistake. */
  const mk = mkRow;
  const supplier = await mk('POST', '/api/manage/suppliers', { name: 'Silinecek Tedarikçi' });
  if (supplier.id) await hit('DELETE', `/api/inventory/suppliers/${supplier.id}`);
  const unit = await mk('POST', '/api/inventory/units', { name: 'silinecek', short_name: 'sb' });
  if (unit.id) await hit('DELETE', `/api/inventory/units/${unit.id}`);
  const zoneDel = await mk('POST', '/api/delivery/zones', { name: 'Silinecek Bölge', fee: 1 });
  if (zoneDel.id) await hit('DELETE', `/api/delivery/zones/${zoneDel.id}`);
  const addr = await mk('POST', '/api/delivery/addresses', {
    customer_id: ID(customer), address_text: 'Silinecek Adres Sokak No:1' });
  if (addr.id) await hit('DELETE', `/api/delivery/addresses/${addr.id}`);
  const cost = await mk('POST', '/api/manage/costs',
    { date: '2030-01-01', category: 'genel', description: 'Silinecek Gider', amount: 1 });
  if (cost.id) await hit('DELETE', `/api/manage/costs/${cost.id}`);

  await hit('POST', '/api/auth/logout', {});

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server && server.close && server.close();
  process.exit(failed.length ? 1 : 0);
})();
