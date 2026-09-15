'use strict';
/**
 * DELTA SYNC for the handheld.
 *
 * The phone keeps its own copy of the menu, the floor and the open bills, so it
 * draws instantly and keeps working when the wifi dips. That copy is kept in
 * step by asking one question - "what changed since id N?" - against the change
 * log the database has been writing by trigger since the schema was written.
 *
 * WHY A CHANGE LOG AND NOT `updated_at`.
 * Rows that are DELETED have no updated_at to read, and a waiter's handset that
 * cannot learn about a deletion goes on showing a table the restaurant closed
 * and selling a product the menu no longer has. The log records the delete as
 * an event, which is the only place that information exists after the row is
 * gone.
 *
 * WHY THE TILL IS STILL THE ONLY WRITER.
 * The phone never replicates rows upward. What goes up is OPERATIONS - "add
 * two kebaps to bill 148", "cancel line 9" - through /api/mobile/sync, each
 * with an op_id. Two writers replicating rows into one another is how a POS
 * double-charges a table; operations merge, rows fight.
 */
const db = require('./../db');

/** Everything a handheld needs to draw its screens from nothing. */
async function snapshot(clientId) {
  const [zones, tables, categories, products, orders] = await Promise.all([
    db.query('SELECT id, name, sort_order, is_active FROM table_zones WHERE client_id=? AND is_active=1 ORDER BY sort_order, id',
      [clientId]),
    /*
     * is_occupied is DERIVED here rather than read from the column.
     *
     * The column is a flag kept up to date by hand in half a dozen places -
     * open a bill, close one, transfer a table, merge two - and the till's own
     * floor plan long ago stopped trusting it and counts open bills instead.
     * The phone was the last reader of the raw flag, which meant the one screen
     * that could disagree with the till was the one nobody is standing in front
     * of. Now both answer the same question the same way.
     */
    db.query('SELECT t.id, t.zone_id, t.name, t.seats, t.sort_order, t.is_active, ' +
      "(SELECT COUNT(*) FROM orders o WHERE o.table_id=t.id AND o.client_id=t.client_id AND o.status='open' AND o.is_deleted=0) > 0 AS is_occupied " +
      'FROM restaurant_tables t WHERE t.client_id=? AND t.is_active=1 ORDER BY t.sort_order, t.id',
      [clientId]),
    db.query('SELECT id, name, sort_order, station_id, is_active FROM categories ' +
      'WHERE client_id=? AND is_active=1 AND use_in_pos=1 ORDER BY sort_order, id', [clientId]),
    db.query('SELECT p.id, p.category_id, p.name, p.price, p.vat_rate, p.track_stock, p.is_active, ' +
      '       COALESCE(s.stock,0) AS stock ' +
      '  FROM products p LEFT JOIN product_stock s ON s.product_id=p.id AND s.client_id=p.client_id ' +
      ' WHERE p.client_id=? AND p.is_active=1 AND p.use_in_pos=1 ORDER BY p.sort_order, p.id', [clientId]),
    openOrders(clientId),
  ]);
  return { zones, tables, categories, products, orders };
}

/** The open bills, each with its lines - what the waiter is standing in front of. */
async function openOrders(clientId, ids = null) {
  const where = ids && ids.length
    ? `o.client_id=? AND o.id IN (${ids.map(() => '?').join(',')})`
    : "o.client_id=? AND o.status='open' AND o.is_deleted=0";
  const args = ids && ids.length ? [clientId, ...ids] : [clientId];
  const orders = await db.query(
    `SELECT o.id, o.adisyon_no, o.bill_label, o.table_id, o.status, o.is_closed, o.waiter_id,
            o.total, o.discount_total, o.vat_total, o.grand_total, o.notes, o.opened_at, o.updated_at
       FROM orders o WHERE ${where} ORDER BY o.id`, args);
  if (!orders.length) return [];
  const byId = new Map(orders.map(o => [Number(o.id), { ...o, items: [] }]));
  const lines = await db.query(
    `SELECT i.id, i.order_id, i.product_id, i.qty, i.sent_qty, i.unit_price, i.line_total,
            i.note, i.is_deleted, p.name AS product_name
       FROM order_items i
       LEFT JOIN products p ON p.id=i.product_id AND p.client_id=i.client_id
      WHERE i.client_id=? AND i.order_id IN (${orders.map(() => '?').join(',')})
      ORDER BY i.id`, [clientId, ...orders.map(o => o.id)]);
  for (const l of lines) {
    const o = byId.get(Number(l.order_id));
    if (o) o.items.push(l);
  }
  return [...byId.values()];
}

/**
 * What changed since `since`.
 *
 * Returns a FULL snapshot instead when the phone has never synced, or when its
 * cursor is older than the oldest row still in the log - a handset left in a
 * drawer for a month must not be handed a delta that silently misses the four
 * weeks the log has since discarded.
 */
async function delta(clientId, since) {
  const head = Number(await db.value('SELECT COALESCE(MAX(id),0) FROM app_change_log WHERE client_id=?', [clientId]));
  const from = Number(since) || 0;

  if (!from) return { full: true, cursor: head, ...(await snapshot(clientId)), removed: emptyRemoved() };

  const oldest = Number(await db.value('SELECT COALESCE(MIN(id),0) FROM app_change_log WHERE client_id=?', [clientId]));
  if (oldest && from < oldest - 1) {
    return { full: true, cursor: head, reason: 'cursor_too_old',
      ...(await snapshot(clientId)), removed: emptyRemoved() };
  }
  if (from >= head) {
    return { full: false, cursor: head, zones: [], tables: [], categories: [],
      products: [], orders: [], removed: emptyRemoved() };
  }

  const rows = await db.query(
    'SELECT entity, entity_id, order_id, op FROM app_change_log ' +
    'WHERE client_id=? AND id > ? AND id <= ? ORDER BY id', [clientId, from, head]);

  /* One row per entity id: the phone wants the CURRENT state of everything
     that moved, not a replay of every step it took to get there. */
  const touched = { zone: new Set(), table: new Set(), category: new Set(), product: new Set(), order: new Set() };
  const gone = { zone: new Set(), table: new Set(), category: new Set(), product: new Set() };
  for (const r of rows) {
    const id = Number(r.entity_id);
    if (r.entity === 'order' || r.entity === 'order_item' || r.entity === 'payment') {
      /* a line or a payment names its bill; the bill is what the phone stores */
      const oid = Number(r.order_id || (r.entity === 'order' ? id : 0));
      if (oid) touched.order.add(oid);
      continue;
    }
    if (!touched[r.entity]) continue;
    if (r.op === 'del') { gone[r.entity].add(id); touched[r.entity].delete(id); }
    else { touched[r.entity].add(id); gone[r.entity].delete(id); }
  }

  const pick = async (sql, set) => (set.size
    ? db.query(sql.replace('/*IDS*/', [...set].map(() => '?').join(',')), [clientId, ...set])
    : []);

  const [zones, tables, categories, products] = await Promise.all([
    pick('SELECT id, name, sort_order, is_active FROM table_zones WHERE client_id=? AND id IN (/*IDS*/)', touched.zone),
    pick('SELECT t.id, t.zone_id, t.name, t.seats, t.sort_order, t.is_active, ' +
      "(SELECT COUNT(*) FROM orders o WHERE o.table_id=t.id AND o.client_id=t.client_id AND o.status='open' AND o.is_deleted=0) > 0 AS is_occupied " +
      'FROM restaurant_tables t WHERE t.client_id=? AND t.id IN (/*IDS*/)', touched.table),
    pick('SELECT id, name, sort_order, station_id, is_active FROM categories WHERE client_id=? AND id IN (/*IDS*/)',
      touched.category),
    pick('SELECT p.id, p.category_id, p.name, p.price, p.vat_rate, p.track_stock, p.is_active, ' +
      '       COALESCE(s.stock,0) AS stock FROM products p ' +
      '  LEFT JOIN product_stock s ON s.product_id=p.id AND s.client_id=p.client_id ' +
      ' WHERE p.client_id=? AND p.id IN (/*IDS*/)', touched.product),
  ]);

  const orders = touched.order.size ? await openOrders(clientId, [...touched.order]) : [];

  /*
   * A row that has been deactivated is a removal as far as a handset is
   * concerned - it must leave the screen. Sending is_active and letting the
   * phone decide would work too, and is worse: every screen would then have to
   * remember to filter, and the one that forgets sells a product that is off.
   */
  for (const t of tables) if (!t.is_active) gone.table.add(Number(t.id));
  for (const c of categories) if (!c.is_active) gone.category.add(Number(c.id));
  for (const p of products) if (!p.is_active) gone.product.add(Number(p.id));
  for (const z of zones) if (!z.is_active) gone.zone.add(Number(z.id));

  return {
    full: false,
    cursor: head,
    zones: zones.filter(z => z.is_active),
    tables: tables.filter(t => t.is_active),
    categories: categories.filter(c => c.is_active),
    products: products.filter(p => p.is_active),
    orders,
    removed: {
      zones: [...gone.zone], tables: [...gone.table], categories: [...gone.category],
      products: [...gone.product],
      /* a bill that is no longer open leaves the handset's list, but it is
         sent in `orders` first with its closing state so the waiter sees it
         settle rather than watching it vanish */
      orders: orders.filter(o => o.status !== 'open' || o.is_deleted).map(o => Number(o.id)),
    },
  };
}

function emptyRemoved() {
  return { zones: [], tables: [], categories: [], products: [], orders: [] };
}

/** Where this handset has got to, for the Telefonlar screen. */
async function remember(clientId, deviceId, cursor, wasFull, rows) {
  if (!deviceId) return;
  await db.exec(
    `INSERT INTO app_sync_cursors (client_id, device_id, cursor_id, full_at, pulled_at, rows_sent)
     VALUES (?,?,?,?,NOW(),?)
     ON DUPLICATE KEY UPDATE cursor_id=VALUES(cursor_id), pulled_at=NOW(),
       rows_sent=VALUES(rows_sent), full_at=COALESCE(VALUES(full_at), full_at)`,
    [clientId, String(deviceId).slice(0, 64), cursor, wasFull ? new Date() : null, rows]);
}

/** How far behind every paired handset is. */
async function cursors(clientId) {
  const head = Number(await db.value('SELECT COALESCE(MAX(id),0) FROM app_change_log WHERE client_id=?', [clientId]));
  const rows = await db.query(
    'SELECT device_id, cursor_id, pulled_at, full_at, rows_sent FROM app_sync_cursors WHERE client_id=? ORDER BY pulled_at DESC',
    [clientId]);
  return { head, devices: rows.map(r => ({ ...r, behind: head - Number(r.cursor_id) })) };
}

module.exports = { snapshot, delta, openOrders, remember, cursors };
