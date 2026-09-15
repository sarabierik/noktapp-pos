'use strict';
/** Menu, tables and stations - everything the manager maintains. */
const db = require('../db');
const log = require('../logger');
const { money } = require('../util/http');
/* One table-token generator for the whole product - see util/token. */
const { tableToken } = require('../util/token');

/* ------------------------------- menu ----------------------------- */
/**
 * Read a boolean flag the way every caller actually sends it.
 *
 * `x === false ? 0 : 1` only recognises a literal false. A row read back out of
 * MariaDB carries 0, and 0 is not false, so any caller that spread a database
 * row back in - the import, the settings screen, the pricing screen - silently
 * turned every deactivated product active again and un-hid everything hidden
 * from the till. Undefined still means "not sent", which stays 1.
 */
function flag(v, dflt = 1) {
  if (v === undefined || v === null || v === '') return dflt;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  return 1;
}


async function menu(clientId, { forQr = false } = {}) {
  const cats = await db.query(
    `SELECT id, name, sort_order, station_id, use_in_pos, use_in_qr FROM categories
      WHERE client_id=? AND is_active=1 ${forQr ? 'AND use_in_qr=1' : 'AND use_in_pos=1'}
      ORDER BY sort_order, id`, [clientId]);
  const prods = await db.query(
    `SELECT p.id, p.category_id, p.name, p.price, p.vat_rate, p.description, p.sort_order,
            p.track_stock, COALESCE(s.stock,0) AS stock
       FROM products p
       LEFT JOIN product_stock s ON s.product_id=p.id AND s.client_id=p.client_id
      WHERE p.client_id=? AND p.is_active=1 ${forQr ? 'AND p.use_in_qr=1' : 'AND p.use_in_pos=1'}
      ORDER BY p.sort_order, p.name`, [clientId]);
  const byCat = new Map(cats.map(c => [c.id, { ...c, products: [] }]));
  for (const p of prods) if (byCat.has(p.category_id)) byCat.get(p.category_id).products.push(p);
  return Array.from(byCat.values());
}

async function saveCategory(clientId, data) {
  if (data.id) {
    await db.exec(
      'UPDATE categories SET name=?, station_id=?, sort_order=?, is_active=?, use_in_pos=?, use_in_qr=? WHERE id=? AND client_id=?',
      [data.name, data.station_id || null, data.sort_order || 0, data.is_active ? 1 : 0,
       data.use_in_pos ? 1 : 0, flag(data.use_in_qr, 0), data.id, clientId]);
    return data.id;
  }
  return db.insert(
    'INSERT INTO categories (client_id, name, station_id, sort_order, is_active, use_in_pos, use_in_qr) VALUES (?,?,?,?,?,?,?)',
    [clientId, data.name, data.station_id || null, data.sort_order || 0, 1,
     flag(data.use_in_pos), flag(data.use_in_qr, 0)]);
}

async function saveProduct(clientId, data, userId) {
  if (data.id) {
    const old = await db.one('SELECT price, image_url FROM products WHERE id=? AND client_id=?', [data.id, clientId]);
    await db.exec(
      `UPDATE products SET category_id=?, name=?, price=?, cost_price=?, description=?, sort_order=?,
          is_active=?, use_in_pos=?, use_in_qr=?, vat_rate=?, track_stock=?, image_url=?
        WHERE id=? AND client_id=?`,
      [data.category_id, data.name, money(data.price), money(data.cost_price || 0), data.description || null,
       data.sort_order || 0, flag(data.is_active), flag(data.use_in_pos),
       flag(data.use_in_qr, 0), Number(data.vat_rate || 0), flag(data.track_stock, 0),
       data.image_url === undefined ? (old ? old.image_url : null) : (data.image_url || null),
       data.id, clientId]);
    if (old && money(old.price) !== money(data.price)) {
      /*
       * product_price_history records the price a product HAD from a date -
       * it is a history, not a diff. This used to insert old_price, new_price,
       * changed_by and changed_at: four columns that do not exist on this
       * table. Every insert threw, the .catch swallowed it, and the price
       * history has been silently empty since the first day.
       */
      await db.exec(
        'INSERT INTO product_price_history (client_id, product_id, price, effective_date, created_at, created_by) VALUES (?,?,?,CURDATE(),NOW(),?)',
        [clientId, data.id, money(data.price), userId || 0]).catch(e =>
          log.warn('catalog', 'price history not written: ' + e.message));
      await db.exec(
        "INSERT INTO price_change_log (client_id, product_id, old_price, new_price, source, changed_by, changed_at) VALUES (?,?,?,?,'manual',?,NOW())",
        [clientId, data.id, old.price, money(data.price), userId || 0]).catch(e =>
          log.warn('catalog', 'price change log not written: ' + e.message));
    }
    return data.id;
  }
  return db.insert(
    `INSERT INTO products (client_id, category_id, name, price, cost_price, description, sort_order,
        is_active, use_in_pos, use_in_qr, vat_rate, track_stock, image_url)
     VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?)`,
    [clientId, data.category_id, data.name, money(data.price), money(data.cost_price || 0),
     data.description || null, data.sort_order || 0, flag(data.use_in_pos),
     flag(data.use_in_qr, 0), Number(data.vat_rate || 0), flag(data.track_stock, 0),
     data.image_url || null]);
}

async function setProductActive(clientId, id, active) {
  return db.exec('UPDATE products SET is_active=? WHERE id=? AND client_id=?', [active ? 1 : 0, id, clientId]);
}

/* ------------------------------ tables ---------------------------- */
async function saveZone(clientId, data) {
  if (data.id) {
    await db.exec('UPDATE table_zones SET name=?, sort_order=?, is_active=? WHERE id=? AND client_id=?',
      [data.name, data.sort_order || 0, flag(data.is_active), data.id, clientId]);
    return data.id;
  }
  return db.insert('INSERT INTO table_zones (client_id, name, sort_order, is_active) VALUES (?,?,?,1)',
    [clientId, data.name, data.sort_order || 0]);
}

async function saveTable(clientId, data) {
  if (data.id) {
    await db.exec('UPDATE restaurant_tables SET zone_id=?, name=?, sort_order=?, is_active=? WHERE id=? AND client_id=?',
      [data.zone_id || null, data.name, data.sort_order || 0, flag(data.is_active), data.id, clientId]);
    return data.id;
  }
  return db.insert(
    'INSERT INTO restaurant_tables (client_id, zone_id, name, status, sort_order, is_occupied, is_active, qr_token) VALUES (?,?,?,?,?,0,1,?)',
    [clientId, data.zone_id || null, data.name, 'free', data.sort_order || 0, tableToken()]);
}

/** Bulk create - "Salon 1..20" in one go, which every new customer needs. */
async function bulkTables(clientId, { zoneId, prefix = 'Masa', from = 1, to = 10 }) {
  const made = [];
  for (let i = Number(from); i <= Number(to); i++) {
    made.push(await db.insert(
      'INSERT INTO restaurant_tables (client_id, zone_id, name, status, sort_order, is_occupied, is_active, qr_token) VALUES (?,?,?,?,?,0,1,?)',
      [clientId, zoneId || null, `${prefix} ${i}`, 'free', i, tableToken()]));
  }
  return made;
}

/* ----------------------------- stations --------------------------- */
async function stations(clientId) {
  return db.query('SELECT * FROM stations WHERE client_id=? ORDER BY sort_order, id', [clientId]);
}
/* An omitted `output_mode` becomes 'screen' rather than keeping whatever is in
   the row: this function writes every column it names, so a caller that did not
   send a mode has no mode, and the product's answer to that is the board. The
   screens never come in here directly - settings.saveStation merges the stored
   row first, so an edit that touched only the name keeps the mode it had. */
async function saveStation(clientId, data) {
  const mode = ['screen', 'printer', 'both'].includes(String(data.output_mode))
    ? String(data.output_mode) : 'screen';
  if (data.id) {
    await db.exec(
      `UPDATE stations SET name=?, display_name=?, is_active=?, sort_order=?, is_default=?, output_mode=?
        WHERE id=? AND client_id=?`,
      [data.name, data.display_name || data.name, flag(data.is_active),
       data.sort_order || 0, data.is_default ? 1 : 0, mode, data.id, clientId]);
    return data.id;
  }
  return db.insert(
    `INSERT INTO stations (client_id, name, display_name, is_default, is_active, sort_order, output_mode)
     VALUES (?,?,?,?,1,?,?)`,
    [clientId, data.name, data.display_name || data.name, data.is_default ? 1 : 0,
     data.sort_order || 0, mode]);
}

/* ------------------------------ users ----------------------------- */
async function users(clientId) {
  return db.query(
    /* has_phone_password, because a staff member without one cannot pair a
       phone and the screen should say so before somebody spends twenty minutes
       retyping a pairing code that was never the problem. */
    `SELECT u.id, u.username, u.email, u.display_name, u.role, u.is_active, u.created_at,
            (u.password_hash IS NOT NULL AND u.password_hash <> '') AS has_phone_password,
            (SELECT GROUP_CONCAT(perm_key) FROM user_permissions
               WHERE user_id=u.id AND perm_key<>'__set__') AS perms
       FROM users u WHERE u.client_id=? ORDER BY u.id`, [clientId]);
}

async function saveUser(clientId, data, actorId) {
  const auth = require('../auth');
  if (data.id) {
    const sets = ['display_name=?', 'role=?', 'is_active=?', 'updated_at=NOW()'];
    const vals = [data.display_name, data.role, flag(data.is_active)];
    if (data.username) { sets.push('username=?'); vals.push(data.username); }
    if (data.email) { sets.push('email=?'); vals.push(String(data.email).toLowerCase()); }
    if (data.password) { sets.push('password_hash=?'); vals.push(auth.hash(data.password)); }
    if (data.pin) {
      sets.push('pin_hash=?', 'pin_changed_at=NOW()', 'pin_set_by=?', 'pin_fail_count=0', 'pin_locked_until=NULL');
      vals.push(auth.hash(data.pin), actorId || null);
    }
    vals.push(data.id, clientId);
    await db.exec(`UPDATE users SET ${sets.join(', ')} WHERE id=? AND client_id=?`, vals);
    if (data.perms) await auth.setPermissions(clientId, data.id, data.perms, actorId);
    return data.id;
  }
  if (!data.pin) { const e = new Error('Yeni kullanici icin PIN zorunlu'); e.status = 400; throw e; }
  const id = await db.insert(
    `INSERT INTO users (client_id, username, email, display_name, role, password_hash, pin_hash,
        created_at, updated_at, is_active, invited_by_user_id, pin_changed_at, pin_set_by)
     VALUES (?,?,?,?,?,?,?,NOW(),NOW(),1,?,NOW(),?)`,
    [clientId, data.username || '', data.email ? String(data.email).toLowerCase() : null,
     data.display_name, data.role || 'waiter',
     // a PIN-only waiter has no phone-app password; '' is "none", not null
     data.password ? auth.hash(data.password) : '', auth.hash(data.pin), actorId || null, actorId || null]);
  if (data.perms) await auth.setPermissions(clientId, id, data.perms, actorId);
  return id;
}

module.exports = { menu, saveCategory, saveProduct, setProductActive, saveZone, saveTable,
  bulkTables, stations, saveStation, users, saveUser };
