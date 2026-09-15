'use strict';
/**
 * MASA BIRLESTIRME - several tables, one adisyon.
 *
 * A party of twelve walks in and the staff push masa 4, 5 and 6 together. From
 * that moment the three tables are ONE table as far as service is concerned:
 * the order is taken once, it goes to the kitchen once, it prints once and it
 * is paid once - while all three tiles on the floor plan have to look busy,
 * because all three have people sitting at them.
 *
 * What the product had before, and why neither of them is this:
 *
 *   - `bill_label` (A / B / C) puts SEVERAL bills on ONE table. That is the
 *     mirror image of the problem: two parties sharing a table, not one party
 *     spread over several.
 *   - `transferTable` MOVES a bill from one table to another. The furniture
 *     stays where the staff pushed it; moving the bill to masa 5 only makes
 *     masa 4 read "bos" while four people eat at it.
 *
 * The model
 *   table_groups          one row per join, open until the bill is paid or the
 *                         group is broken up by hand
 *   table_group_members   one row per table per group, kept with `left_at` set
 *                         when a table leaves - a group's history is never
 *                         thrown away
 *   orders.table_session_id  the bill's group. The column has existed unused
 *                         since the PHP days and is exactly the right shape.
 *
 * The bill lives on the group's PRIMARY table (`orders.table_id`), so every
 * report, every foreign key and every screen that has never heard of groups
 * still sees a bill on a real table. The group only ever ADDS to that: the
 * name, and the other tables' occupancy.
 */
const db = require('../db');

/* A soft failure the till can show as a sentence, not a stack trace. */
function bad(message, status = 400, code = null) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

/* ------------------------------------------------------------------ */
/* the name                                                           */
/* ------------------------------------------------------------------ */
/**
 * "Masa 4+5+6", not "Masa 4+Masa 5+Masa 6".
 *
 * The name is read out loud by a waiter holding four plates and it is printed
 * on an 80 mm slip, so it has to be short. Tables in a Turkish restaurant are
 * almost always "<something> <number>", so the shared prefix is written once
 * and the rest are numbers. Anything that does not fit the pattern - "Bahce",
 * "Teras Kose" - keeps its whole name, because shortening it would produce
 * something nobody could find on the floor.
 */
function groupName(names) {
  const list = (names || []).map(n => String(n == null ? '' : n).trim()).filter(Boolean);
  if (!list.length) return '';
  const head = list[0].match(/^(.*?)(\d+)\s*$/);
  const prefix = head ? head[1] : null;
  const out = [list[0]];
  for (const n of list.slice(1)) {
    const m = prefix === null ? null : n.match(/^(.*?)(\d+)\s*$/);
    out.push(m && m[1] === prefix ? m[2] : n);
  }
  return out.join('+');
}

/* ------------------------------------------------------------------ */
/* reading                                                            */
/* ------------------------------------------------------------------ */
/** Tables still in the group, in floor-plan order - the order of the name. */
async function membersOf(q, clientId, groupId) {
  return q.query(
    `SELECT m.table_id, t.name, t.zone_id, t.sort_order
       FROM table_group_members m
       JOIN restaurant_tables t ON t.id=m.table_id AND t.client_id=m.client_id
      WHERE m.client_id=? AND m.group_id=? AND m.left_at IS NULL
      ORDER BY t.sort_order, t.id`, [clientId, groupId]);
}

/** The one open bill of a group, if it still has one. */
async function billOf(q, clientId, groupId) {
  return q.one(
    `SELECT id, adisyon_no, bill_label, grand_total, table_id, opened_at
       FROM orders
      WHERE client_id=? AND table_session_id=? AND status='open' AND is_deleted=0
      ORDER BY id LIMIT 1`, [clientId, groupId]);
}

/** The open group a table belongs to right now, or null. */
async function groupOfTable(q, clientId, tableId) {
  return q.one(
    `SELECT g.* FROM table_group_members m
       JOIN table_groups g ON g.id=m.group_id AND g.client_id=m.client_id
      WHERE m.client_id=? AND m.table_id=? AND m.left_at IS NULL AND g.status='open'
      ORDER BY g.id DESC LIMIT 1`, [clientId, tableId]);
}

/** Everything a screen needs about one group. */
async function get(clientId, groupId, q = db) {
  const g = await q.one('SELECT * FROM table_groups WHERE id=? AND client_id=?', [groupId, clientId]);
  if (!g) return null;
  const tables = await membersOf(q, clientId, groupId);
  const bill = await billOf(q, clientId, groupId);
  return {
    id: g.id,
    name: groupName(tables.map(t => t.name)),
    status: g.status,
    primary_table_id: g.primary_table_id,
    business_date: g.business_date,
    opened_at: g.opened_at,
    closed_at: g.closed_at,
    closed_reason: g.closed_reason,
    tables,
    table_ids: tables.map(t => Number(t.table_id)),
    order_id: bill ? bill.id : null,
    order: bill || null,
  };
}

/** Every open group, for the floor plan. */
async function list(clientId) {
  const rows = await db.query(
    "SELECT id FROM table_groups WHERE client_id=? AND status='open' ORDER BY id", [clientId]);
  const out = [];
  for (const r of rows) {
    const g = await get(clientId, r.id);
    // a group whose last table has gone is not a group any more; it should not
    // exist, but the floor plan is not the place to find that out
    if (g && g.tables.length) out.push(g);
  }
  return out;
}

/** The group name for a bill, or '' - used by the printers and the till. */
async function nameForOrder(clientId, order) {
  if (!order || !order.table_session_id) return '';
  const tables = await membersOf(db, clientId, order.table_session_id);
  return groupName(tables.map(t => t.name));
}

/* ------------------------------------------------------------------ */
/* guards                                                             */
/* ------------------------------------------------------------------ */
/**
 * May this table be pulled into a group?
 *
 * Two refusals, and both of them name the thing that is in the way. "Masa 5
 * birlestirilemez" is the message the old system would have written and it is
 * useless: the waiter's next question is always "why", and the answer is
 * either a bill or another group, both of which we are holding in our hand.
 */
async function assertJoinable(t, clientId, tableId, groupId = null) {
  const table = await t.one(
    'SELECT id, name, is_active FROM restaurant_tables WHERE id=? AND client_id=?', [tableId, clientId]);
  if (!table) throw bad('Masa bulunamadi', 404);
  if (!Number(table.is_active)) throw bad(`"${table.name}" kapali bir masa.`, 409);

  const other = await groupOfTable(t, clientId, tableId);
  if (other && Number(other.id) !== Number(groupId)) {
    const tables = await membersOf(t, clientId, other.id);
    throw bad(`"${table.name}" zaten "${groupName(tables.map(x => x.name))}" grubunda. `
      + 'Bir masa ayni anda tek grupta olabilir.', 409, 'IN_OTHER_GROUP');
  }

  const own = await t.query(
    `SELECT id, adisyon_no, bill_label, grand_total FROM orders
      WHERE client_id=? AND table_id=? AND status='open' AND is_deleted=0
        AND (table_session_id IS NULL OR table_session_id<>?)
      ORDER BY id`, [clientId, tableId, groupId || 0]);
  if (own.length) {
    const b = own[0];
    const which = `Adisyon #${b.adisyon_no}` + (b.bill_label ? ` (${b.bill_label})` : '');
    throw bad(`"${table.name}" uzerinde kendi acik adisyonu var: ${which}. `
      + 'Once o adisyonu kapatin veya baska masaya tasiyin.', 409, 'TABLE_HAS_BILL');
  }
  return table;
}

async function assertDayOpen(clientId) {
  const bd = require('../util/businessDay');
  const date = await bd.currentBusinessDate();
  if (await bd.isDayClosed(clientId, date)) {
    throw bad('Gun sonu alinmis. Masa birlestirilemez.', 409, 'DAY_CLOSED');
  }
  return date;
}

/* ------------------------------------------------------------------ */
/* joining                                                            */
/* ------------------------------------------------------------------ */
/**
 * Push tables together and give the party one bill.
 *
 * The primary table is where the bill sits. It is the ONE table allowed to
 * arrive with a bill already open - the ordinary flow is that masa 4 has been
 * eating for half an hour when the rest of the family turns up and masa 5 is
 * dragged over, and refusing that would send the waiter to "adisyon tasi" and
 * straight back to the problem the owner is complaining about. Every other
 * table has to be genuinely free, and is refused by name if it is not.
 */
async function create(clientId, { tableIds, primaryTableId = null, waiterId = null, userId = null, note = null }) {
  const ids = [...new Set((tableIds || []).map(Number).filter(Boolean))];
  if (ids.length < 2) throw bad('Birlestirmek icin en az iki masa secin.', 400);
  const primary = Number(primaryTableId) || ids[0];
  if (!ids.includes(primary)) throw bad('Ana masa secilen masalar arasinda olmali.', 400);
  const date = await assertDayOpen(clientId);

  const orders = require('./orders');
  const groupId = await db.tx(async t => {
    // the primary first, so its own bill (if any) is the one we adopt
    const primaryBills = await t.query(
      `SELECT id, adisyon_no, bill_label FROM orders
        WHERE client_id=? AND table_id=? AND status='open' AND is_deleted=0 ORDER BY id`,
      [clientId, primary]);
    if (primaryBills.length > 1) {
      throw bad(`Ana masada ${primaryBills.length} acik adisyon var. `
        + 'Once hangisinin grubun hesabi olacagini birlestirin veya kapatin.', 409, 'PRIMARY_MANY_BILLS');
    }
    const inOther = await groupOfTable(t, clientId, primary);
    if (inOther) {
      const tabs = await membersOf(t, clientId, inOther.id);
      throw bad(`Ana masa zaten "${groupName(tabs.map(x => x.name))}" grubunda.`, 409, 'IN_OTHER_GROUP');
    }
    for (const id of ids) if (id !== primary) await assertJoinable(t, clientId, id, null);

    const gid = await t.insert(
      `INSERT INTO table_groups (client_id, primary_table_id, business_date, status, note,
          opened_at, opened_by)
       VALUES (?,?,?, 'open', ?, NOW(), ?)`,
      [clientId, primary, date, note ? String(note).slice(0, 190) : null, userId]);
    for (const id of ids) {
      await t.exec(
        `INSERT INTO table_group_members (client_id, group_id, table_id, joined_at, joined_by)
         VALUES (?,?,?,NOW(),?)
         ON DUPLICATE KEY UPDATE left_at=NULL, left_by=NULL, joined_at=NOW(), joined_by=VALUES(joined_by)`,
        [clientId, gid, id, userId]);
      await t.exec('UPDATE restaurant_tables SET is_occupied=1 WHERE id=? AND client_id=?', [id, clientId]);
    }
    if (primaryBills.length === 1) {
      await t.exec('UPDATE orders SET table_session_id=?, updated_at=NOW() WHERE id=? AND client_id=?',
        [gid, primaryBills[0].id, clientId]);
    }
    await audit(t, clientId, userId, 'tablegroup.create', gid, { tables: ids, primary });
    return gid;
  });

  // The bill is opened OUTSIDE the join transaction and through openOrder, so
  // it gets its adisyon number, its shift and its day-close check from the one
  // place that knows how to do that. A group with no bill yet is a valid state
  // for the seconds in between - the floor plan shows it as busy either way.
  let g = await get(clientId, groupId);
  if (!g.order_id) {
    const orderId = await orders.openOrder(clientId, { tableId: primary, waiterId, userId });
    await db.exec('UPDATE orders SET table_session_id=?, updated_at=NOW() WHERE id=? AND client_id=?',
      [groupId, orderId, clientId]);
    g = await get(clientId, groupId);
  }
  return g;
}

/** Bring one more table into an open group while the bill stays open. */
async function addTable(clientId, groupId, tableId, userId = null) {
  await assertDayOpen(clientId);
  await db.tx(async t => {
    const g = await t.one("SELECT * FROM table_groups WHERE id=? AND client_id=? AND status='open' FOR UPDATE",
      [groupId, clientId]);
    if (!g) throw bad('Grup acik degil', 409);
    const already = await t.one(
      'SELECT id FROM table_group_members WHERE client_id=? AND group_id=? AND table_id=? AND left_at IS NULL',
      [clientId, groupId, tableId]);
    if (already) return;
    await assertJoinable(t, clientId, tableId, groupId);
    await t.exec(
      `INSERT INTO table_group_members (client_id, group_id, table_id, joined_at, joined_by)
       VALUES (?,?,?,NOW(),?)
       ON DUPLICATE KEY UPDATE left_at=NULL, left_by=NULL, joined_at=NOW(), joined_by=VALUES(joined_by)`,
      [clientId, groupId, tableId, userId]);
    await t.exec('UPDATE restaurant_tables SET is_occupied=1 WHERE id=? AND client_id=?', [tableId, clientId]);
    await audit(t, clientId, userId, 'tablegroup.add', groupId, { table_id: Number(tableId) });
  });
  return get(clientId, groupId);
}

/**
 * Send one table back to its own place. The bill is not touched.
 *
 * The primary table cannot leave: it is where the bill physically is, and a
 * bill on a table that is no longer part of the group is exactly the orphan
 * this whole module exists to prevent. Move the bill first (adisyon tasi) if
 * that is really what is wanted.
 */
async function removeTable(clientId, groupId, tableId, userId = null) {
  const out = await db.tx(async t => {
    const g = await t.one("SELECT * FROM table_groups WHERE id=? AND client_id=? AND status='open' FOR UPDATE",
      [groupId, clientId]);
    if (!g) throw bad('Grup acik degil', 409);
    const member = await t.one(
      `SELECT m.*, t.name FROM table_group_members m
         JOIN restaurant_tables t ON t.id=m.table_id
        WHERE m.client_id=? AND m.group_id=? AND m.table_id=? AND m.left_at IS NULL`,
      [clientId, groupId, tableId]);
    if (!member) throw bad('Masa bu grupta degil', 404);
    if (Number(g.primary_table_id) === Number(tableId)) {
      throw bad(`"${member.name}" grubun ana masasi - hesap orada duruyor. `
        + 'Once adisyonu baska masaya tasiyin veya grubu dagitin.', 409, 'PRIMARY_TABLE');
    }
    await t.exec('UPDATE table_group_members SET left_at=NOW(), left_by=? WHERE id=?', [userId, member.id]);
    await freeIfIdle(t, clientId, tableId);
    await audit(t, clientId, userId, 'tablegroup.remove', groupId, { table_id: Number(tableId) });

    // one table left is not a group. It closes itself rather than lingering as
    // a "group" of one that the floor plan would keep drawing a badge on.
    const left = await membersOf(t, clientId, groupId);
    if (left.length <= 1) {
      await closeGroupIn(t, clientId, groupId, userId, 'son_masa', { keepPrimary: true });
      return { dissolved: true };
    }
    return { dissolved: false };
  });
  const g = await get(clientId, groupId);
  return { ...out, group: g };
}

/**
 * Dagit - break the group up.
 *
 * WHAT HAPPENS TO THE BILL: it stays where it has been all along, on the
 * primary table, open, with every line and every payment on it. Nothing is
 * deleted and nothing is closed. The other tables are released - they only
 * looked busy because the group said so - and the bill's name goes back to
 * being the primary table's own name.
 */
async function ungroup(clientId, groupId, userId = null) {
  await db.tx(async t => {
    const g = await t.one("SELECT * FROM table_groups WHERE id=? AND client_id=? AND status='open' FOR UPDATE",
      [groupId, clientId]);
    if (!g) throw bad('Grup acik degil', 409);
    await closeGroupIn(t, clientId, groupId, userId, 'dagitildi', { keepPrimary: true });
  });
  return get(clientId, groupId);
}

/* ------------------------------------------------------------------ */
/* closing                                                            */
/* ------------------------------------------------------------------ */
/** Release a table if nothing open is standing on it any more. */
async function freeIfIdle(t, clientId, tableId) {
  const left = await t.value(
    "SELECT COUNT(*) FROM orders WHERE table_id=? AND client_id=? AND status='open' AND is_deleted=0",
    [tableId, clientId]);
  const stillGrouped = await t.one(
    `SELECT m.id FROM table_group_members m
       JOIN table_groups g ON g.id=m.group_id
      WHERE m.client_id=? AND m.table_id=? AND m.left_at IS NULL AND g.status='open' LIMIT 1`,
    [clientId, tableId]);
  if (!Number(left) && !stillGrouped) {
    await t.exec('UPDATE restaurant_tables SET is_occupied=0 WHERE id=? AND client_id=?', [tableId, clientId]);
  }
}

/**
 * Close the group row, stamp every member as having left, and free the tables.
 *
 * `keepPrimary` is what separates "dagit" from "hesap kapandi": breaking a
 * group up leaves a live bill on the primary table, so that table must stay
 * occupied; a paid bill leaves nothing behind and every table goes free.
 */
async function closeGroupIn(t, clientId, groupId, userId, reason, { keepPrimary = false } = {}) {
  const g = await t.one('SELECT * FROM table_groups WHERE id=? AND client_id=?', [groupId, clientId]);
  if (!g || g.status !== 'open') return false;
  const members = await membersOf(t, clientId, groupId);
  await t.exec(
    'UPDATE table_group_members SET left_at=NOW(), left_by=? WHERE client_id=? AND group_id=? AND left_at IS NULL',
    [userId, clientId, groupId]);
  await t.exec(
    "UPDATE table_groups SET status='closed', closed_at=NOW(), closed_by=?, closed_reason=? WHERE id=?",
    [userId, reason, groupId]);
  for (const m of members) {
    if (keepPrimary && Number(m.table_id) === Number(g.primary_table_id)) continue;
    await freeIfIdle(t, clientId, m.table_id);
  }
  if (!keepPrimary) await freeIfIdle(t, clientId, g.primary_table_id);
  await audit(t, clientId, userId, 'tablegroup.close', groupId,
    { reason, tables: members.map(m => Number(m.table_id)) });
  return true;
}

/**
 * The close-path hook. Called from orders.closeIfPaid inside the SAME
 * transaction as the close, because a paid group whose masa 5 and masa 6 stay
 * red is the bug the waiter reports as "the tables never free up".
 */
async function releaseOnCloseIn(t, clientId, orderId, userId = null) {
  const o = await t.one('SELECT table_session_id FROM orders WHERE id=? AND client_id=?', [orderId, clientId]);
  if (!o || !o.table_session_id) return false;
  const stillOpen = await t.value(
    `SELECT COUNT(*) FROM orders WHERE client_id=? AND table_session_id=? AND status='open' AND is_deleted=0`,
    [clientId, o.table_session_id]);
  if (Number(stillOpen)) return false;          // a split half is still unpaid
  return closeGroupIn(t, clientId, o.table_session_id, userId, 'hesap_kapandi');
}

/* ------------------------------------------------------------------ */
/* what the rest of the app sees                                      */
/* ------------------------------------------------------------------ */
/**
 * Stamp the group onto a bill.
 *
 * `table_name` is overwritten on purpose: it is what the kitchen slip, the
 * hesap fisi and the till header all print, and a waiter carrying six plates
 * needs to read "Masa 4+5+6". The original stays on `table_own_name` for
 * anything that genuinely means the one table the bill is filed against.
 */
async function decorateOrder(clientId, order) {
  if (!order || !order.table_session_id) return order;
  const g = await get(clientId, order.table_session_id);
  if (!g || !g.tables.length) return order;
  order.table_own_name = order.table_name || '';
  order.table_group = { id: g.id, name: g.name, table_ids: g.table_ids, primary_table_id: g.primary_table_id };
  order.table_group_name = g.name;
  order.table_name = g.name;
  return order;
}

/**
 * Overlay the open groups onto a floor plan.
 *
 * Only the primary table carries the bill row, so without this every other
 * table in the group reads "bos" on the busiest screen in the product while
 * four people sit at it. Each member gets the group's badge, the group's
 * total and the busy state - the group is one party, so its money is shown
 * once per tile rather than divided into fictions.
 */
async function overlayPlan(clientId, plan) {
  const groups = await list(clientId);
  plan.groups = groups;
  if (!groups.length) return plan;                 // nothing joined: untouched
  const byTable = new Map();
  for (const g of groups) for (const id of g.table_ids) byTable.set(Number(id), g);
  for (const t of plan.tables || []) {
    const g = byTable.get(Number(t.id));
    if (!g) continue;
    t.group_id = g.id;
    t.group_name = g.name;
    t.group_primary = Number(g.primary_table_id) === Number(t.id);
    t.group_order_id = g.order_id;
    t.group_size = g.table_ids.length;
    if (!t.open_bills) {                           // a member with no bill of its own
      t.open_bills = g.order_id ? 1 : 0;
      t.open_total = g.order && g.order.grand_total !== undefined ? Number(g.order.grand_total) : 0;
      t.opened_at = t.opened_at || (g.order ? g.order.opened_at : g.opened_at);
    }
    t.status = 'occupied';
  }
  return plan;
}

/** Which bill should opening this table land on - the group's, if any. */
async function orderIdForTable(clientId, tableId) {
  const g = await groupOfTable(db, clientId, tableId);
  if (!g) return null;
  const bill = await billOf(db, clientId, g.id);
  return bill ? bill.id : null;
}

/* ------------------------------------------------------------------ */
async function audit(t, clientId, userId, action, groupId, data) {
  await t.exec(
    `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id, after_json, created_at)
     VALUES (?,?,?,?,?,?,?,NOW())`,
    [clientId, userId || null, 'cashier', action, 'table_group', String(groupId), JSON.stringify(data)]
  ).catch(() => {});
}

module.exports = {
  groupName, get, list, create, addTable, removeTable, ungroup,
  groupOfTable, billOf, membersOf, nameForOrder, orderIdForTable,
  releaseOnCloseIn, decorateOrder, overlayPlan, closeGroupIn, freeIfIdle,
};
