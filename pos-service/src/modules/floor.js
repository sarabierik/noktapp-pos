'use strict';
/**
 * KAT PLANI - alanlar, masalar, rezervasyonlar, karekod kartlari, mutfak panosu.
 *
 * Why this module exists at all
 * ----------------------------
 * The floor was the one part of the old system you could only build once. Zones
 * and tables were created by the first-run wizard and then became unreachable:
 * `tables_manage.php` existed but nothing linked to it after setup, so a
 * restaurant that added a terrace in June had no way to say so. Reservations
 * were a single 900-line PHP file that could create and cancel and nothing
 * else - no edit, no range list, and no check that two parties had not been
 * promised the same table at eight o'clock. And the kitchen board showed a flat
 * list with no sense of time, which is the only thing a kitchen board is for.
 *
 * Everything here is written against the SAME tables the till already uses:
 * catalog.saveZone / saveTable / bulkTables stay the single writers of the
 * insert shapes, and orders.openOrder stays the single way a bill is born, so
 * seating a reservation produces a bill that is numbered, labelled and attached
 * to the open shift exactly like one a waiter opened by hand. Duplicating any
 * of that here is how the two paths drift apart.
 */
const db = require('../db');
const sheetfmt = require('../report/sheet');
const log = require('../logger');
const catalog = require('./catalog');
const orders = require('./orders');

/* A soft failure the screen can show next to a field, not a stack trace. */
function bad(message, status = 400, code = null) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

/* ------------------------------------------------------------------ */
/* alanlar (zones)                                                    */
/* ------------------------------------------------------------------ */

/**
 * Zones with the counts the management screen has to show before it can let
 * anyone press Sil: a zone is deletable only when nothing active is standing
 * in it, and the button has to know that before it is clicked, not after.
 */
async function zones(clientId, { includeInactive = false } = {}) {
  return db.query(
    `SELECT z.id, z.name, z.sort_order, z.is_active,
            (SELECT COUNT(*) FROM restaurant_tables t
               WHERE t.client_id=z.client_id AND t.zone_id=z.id AND t.is_active=1) AS table_count,
            (SELECT COUNT(*) FROM restaurant_tables t
               WHERE t.client_id=z.client_id AND t.zone_id=z.id AND t.is_active=0) AS inactive_count
       FROM table_zones z
      WHERE z.client_id=? ${includeInactive ? '' : 'AND z.is_active=1'}
      ORDER BY z.sort_order, z.id`, [clientId]);
}

async function saveZone(clientId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw bad('Alan adi bos olamaz');
  /*
   * There is no unique key on table_zones(client_id,name), so the database will
   * happily hold two "Teras" rows and the waiter will pick the wrong one for
   * the rest of the year. The check belongs here because it is a business rule,
   * not a storage one.
   */
  const clash = await db.one(
    'SELECT id FROM table_zones WHERE client_id=? AND name=? AND id<>? LIMIT 1',
    [clientId, name, data.id || 0]);
  if (clash) throw bad('Bu isimde bir alan zaten var: ' + name, 409, 'duplicate');
  return catalog.saveZone(clientId, { ...data, name });
}

/**
 * Deleting a zone is a SOFT delete, and only when it is empty.
 *
 * Hard-deleting would orphan `restaurant_tables.zone_id` and every closed order
 * that joined through it for its zone name on a report. Refusing while tables
 * stand in it is the rule the PHP had (its Sil button was simply disabled) -
 * except the PHP only disabled the button, so anyone who posted the form
 * directly deleted the zone anyway. The guard has to be on this side.
 */
async function deleteZone(clientId, zoneId) {
  const z = await db.one('SELECT id, name FROM table_zones WHERE id=? AND client_id=?', [zoneId, clientId]);
  if (!z) throw bad('Alan bulunamadi', 404);
  const live = await db.value(
    'SELECT COUNT(*) FROM restaurant_tables WHERE client_id=? AND zone_id=? AND is_active=1',
    [clientId, zoneId]);
  if (Number(live) > 0) {
    throw bad(`"${z.name}" alaninda ${live} aktif masa var. Once masalari baska alana tasiyin veya kapatin.`,
      409, 'zone_has_tables');
  }
  await db.exec('UPDATE table_zones SET is_active=0 WHERE id=? AND client_id=?', [zoneId, clientId]);
  return { id: Number(zoneId), deleted: true };
}

/** Drag-and-drop ordering: the screen sends the ids in the order it now shows. */
async function reorderZones(clientId, ids) {
  if (!Array.isArray(ids) || !ids.length) throw bad('Siralama bos');
  await db.tx(async t => {
    for (let i = 0; i < ids.length; i++) {
      await t.exec('UPDATE table_zones SET sort_order=? WHERE id=? AND client_id=?',
        [i + 1, Number(ids[i]), clientId]);
    }
  });
  return { ordered: ids.length };
}

/* ------------------------------------------------------------------ */
/* masalar (tables)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Every table with what the management screen needs on one row: its zone, its
 * capacity, whether a card has been printed for it, and - the one that decides
 * whether Kapat is allowed - how many bills are open on it right now.
 */
async function tables(clientId, { zoneId = null, includeInactive = true } = {}) {
  const where = ['t.client_id=?'];
  const args = [clientId];
  if (!includeInactive) where.push('t.is_active=1');
  if (zoneId === 0 || zoneId === '0') where.push('t.zone_id IS NULL');
  else if (zoneId) { where.push('t.zone_id=?'); args.push(Number(zoneId)); }
  const rows = await db.query(
    `SELECT t.id, t.zone_id, t.name, t.seats, t.sort_order, t.is_active, t.qr_token, t.qr_token_at,
            z.name AS zone_name,
            (SELECT COUNT(*) FROM orders o WHERE o.table_id=t.id AND o.client_id=t.client_id
               AND o.status='open' AND o.is_deleted=0) AS open_bills,
            (SELECT COUNT(*) FROM reservations r WHERE r.table_id=t.id AND r.client_id=t.client_id
               AND r.status='booked' AND r.starts_at >= NOW()) AS upcoming_reservations
       FROM restaurant_tables t
       LEFT JOIN table_zones z ON z.id=t.zone_id AND z.client_id=t.client_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.is_active DESC, t.sort_order, t.id`, args);
  for (const t of rows) {
    t.open_bills = Number(t.open_bills);
    t.upcoming_reservations = Number(t.upcoming_reservations);
    t.seats = t.seats === null ? null : Number(t.seats);
    t.has_qr = !!t.qr_token;
  }
  return rows;
}

/* The generator lives in util/token because catalog.js mints these too, and
   for a while the two files disagreed about how long a table token is. */
const newToken = require('../util/token').tableToken;

/**
 * Create or rename a table, move it between zones, set its capacity.
 *
 * `restaurant_tables` carries UNIQUE(client_id,name) and that key does NOT care
 * about is_active - so a table closed last winter still owns its name. Creating
 * "Masa 4" again would fail with a duplicate-key error that means nothing to
 * the person typing. When the colliding row is a closed one we bring it back
 * instead: that is what the user meant, and it keeps the old bills attached to
 * the table they were actually served on.
 */
async function saveTable(clientId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw bad('Masa adi bos olamaz');
  const seats = data.seats === '' || data.seats === null || data.seats === undefined
    ? null : Math.max(0, Math.min(99, Number(data.seats) || 0));
  const zoneId = data.zone_id ? Number(data.zone_id) : null;
  if (zoneId) {
    const z = await db.one('SELECT id FROM table_zones WHERE id=? AND client_id=? AND is_active=1',
      [zoneId, clientId]);
    if (!z) throw bad('Alan bulunamadi', 404);
  }

  const clash = await db.one(
    'SELECT id, is_active FROM restaurant_tables WHERE client_id=? AND name=? AND id<>? LIMIT 1',
    [clientId, name, data.id || 0]);
  if (clash && clash.is_active) throw bad('Bu isimde bir masa zaten var: ' + name, 409, 'duplicate');

  let id = data.id ? Number(data.id) : null;
  if (!id && clash) {
    id = clash.id;                                   // revive the closed namesake
    await db.exec('UPDATE restaurant_tables SET is_active=1 WHERE id=? AND client_id=?', [id, clientId]);
    log.info('floor', 'kapali masa yeniden acildi', { id, name });
  }

  if (id) {
    await catalog.saveTable(clientId, { ...data, id, name, zone_id: zoneId });
  } else {
    id = await catalog.saveTable(clientId, { ...data, name, zone_id: zoneId });
  }
  // seats is ours, not catalog's - written separately so catalog.saveTable
  // stays the one shape the wizard and the manage screen both use
  await db.exec('UPDATE restaurant_tables SET seats=? WHERE id=? AND client_id=?', [seats, id, clientId]);
  return id;
}

/**
 * "Salon 1..20" in one go. catalog.bulkTables does the inserting; what belongs
 * here is everything that makes it safe to press twice: the range is bounded,
 * the names are checked against what already exists, and a collision is
 * reported by name instead of surfacing as a duplicate-key error halfway
 * through - which is how the wizard used to leave you with eleven of twenty
 * tables and no way to tell which nine were missing.
 */
async function bulkCreate(clientId, { zone_id, prefix = 'Masa', from = 1, to = 10, seats = null }) {
  const f = Math.floor(Number(from));
  const t = Math.floor(Number(to));
  if (!Number.isFinite(f) || !Number.isFinite(t) || t < f) throw bad('Numara araligi hatali');
  if (t - f + 1 > 200) throw bad('Tek seferde en fazla 200 masa olusturulabilir');
  const clean = String(prefix || '').trim();
  const zoneId = zone_id ? Number(zone_id) : null;
  if (zoneId) {
    const z = await db.one('SELECT id FROM table_zones WHERE id=? AND client_id=? AND is_active=1',
      [zoneId, clientId]);
    if (!z) throw bad('Alan bulunamadi', 404);
  }

  const names = [];
  for (let i = f; i <= t; i++) names.push(clean ? `${clean} ${i}` : String(i));
  const existing = await db.query(
    `SELECT name, is_active FROM restaurant_tables WHERE client_id=? AND name IN (${names.map(() => '?').join(',')})`,
    [clientId, ...names]);
  const taken = existing.filter(e => e.is_active).map(e => e.name);
  if (taken.length) {
    throw bad('Bu isimler zaten kullaniliyor: ' + taken.slice(0, 8).join(', ')
      + (taken.length > 8 ? ` (+${taken.length - 8})` : ''), 409, 'duplicate');
  }
  const revive = existing.filter(e => !e.is_active).map(e => e.name);

  const made = [];
  for (let i = f; i <= t; i++) {
    const name = clean ? `${clean} ${i}` : String(i);
    if (revive.includes(name)) {
      const row = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? AND name=?', [clientId, name]);
      await db.exec('UPDATE restaurant_tables SET is_active=1, zone_id=?, sort_order=? WHERE id=? AND client_id=?',
        [zoneId, i, row.id, clientId]);
      made.push(row.id);
    } else {
      // one call per row rather than one bulkTables call for the range, because
      // bulkTables builds the name itself and we have already resolved which
      // names in this range are new
      const [id] = await catalog.bulkTables(clientId, { zoneId, prefix: clean, from: i, to: i });
      made.push(id);
    }
  }
  if (seats !== null && seats !== '' && made.length) {
    await db.exec(
      `UPDATE restaurant_tables SET seats=? WHERE client_id=? AND id IN (${made.map(() => '?').join(',')})`,
      [Math.max(0, Math.min(99, Number(seats) || 0)), clientId, ...made]);
  }
  log.info('floor', 'toplu masa olusturuldu', { count: made.length, prefix: clean, zoneId });
  return { ids: made, created: made.length, revived: revive.length, names };
}

/**
 * Close a table (soft), or reopen it.
 *
 * A table with money still on it must not disappear from the floor plan: the
 * bill would still exist, still be open, and there would be no tile left to
 * reach it from. That is the one guard the old screen never had - its
 * `table_delete` was an unconditional `is_active=0`.
 */
async function setTableActive(clientId, tableId, active) {
  const t = await db.one('SELECT id, name FROM restaurant_tables WHERE id=? AND client_id=?', [tableId, clientId]);
  if (!t) throw bad('Masa bulunamadi', 404);
  if (!active) {
    const open = await db.value(
      `SELECT COUNT(*) FROM orders WHERE client_id=? AND table_id=? AND status='open' AND is_deleted=0`,
      [clientId, tableId]);
    if (Number(open) > 0) {
      throw bad(`"${t.name}" masasinda ${open} acik adisyon var. Once adisyonu kapatin.`,
        409, 'table_has_open_bill');
    }
  }
  await db.exec('UPDATE restaurant_tables SET is_active=?, is_occupied=0 WHERE id=? AND client_id=?',
    [active ? 1 : 0, tableId, clientId]);
  return { id: Number(tableId), is_active: !!active };
}

/** Move one table to another zone (or to "Genel Alan" with zone_id null). */
async function moveTable(clientId, tableId, zoneId) {
  const t = await db.one('SELECT id FROM restaurant_tables WHERE id=? AND client_id=?', [tableId, clientId]);
  if (!t) throw bad('Masa bulunamadi', 404);
  const z = zoneId ? Number(zoneId) : null;
  if (z) {
    const zone = await db.one('SELECT id FROM table_zones WHERE id=? AND client_id=? AND is_active=1', [z, clientId]);
    if (!zone) throw bad('Alan bulunamadi', 404);
  }
  await db.exec('UPDATE restaurant_tables SET zone_id=? WHERE id=? AND client_id=?', [z, tableId, clientId]);
  return { id: Number(tableId), zone_id: z };
}

async function reorderTables(clientId, ids) {
  if (!Array.isArray(ids) || !ids.length) throw bad('Siralama bos');
  await db.tx(async t => {
    for (let i = 0; i < ids.length; i++) {
      await t.exec('UPDATE restaurant_tables SET sort_order=? WHERE id=? AND client_id=?',
        [i + 1, Number(ids[i]), clientId]);
    }
  });
  return { ordered: ids.length };
}

async function setSeats(clientId, tableId, seats) {
  const v = seats === null || seats === '' ? null : Math.max(0, Math.min(99, Number(seats) || 0));
  const n = await db.exec('UPDATE restaurant_tables SET seats=? WHERE id=? AND client_id=?', [v, tableId, clientId]);
  if (!n) throw bad('Masa bulunamadi', 404);
  return { id: Number(tableId), seats: v };
}

/* ------------------------------------------------------------------ */
/* karekod kartlari (QR)                                              */
/* ------------------------------------------------------------------ */

/**
 * Regenerate one table's token.
 *
 * This is destructive on purpose and the screen says so: every card already
 * printed for this table stops opening the menu the instant this returns. That
 * is the whole point - it is what you press when a card has been photographed
 * and is being used from outside the restaurant.
 */
async function regenerateToken(clientId, tableId) {
  const t = await db.one('SELECT id, name FROM restaurant_tables WHERE id=? AND client_id=?', [tableId, clientId]);
  if (!t) throw bad('Masa bulunamadi', 404);
  const token = newToken();
  await db.exec('UPDATE restaurant_tables SET qr_token=?, qr_token_at=NOW() WHERE id=? AND client_id=?',
    [token, tableId, clientId]);
  log.info('floor', 'masa karekodu yenilendi - eski kart gecersiz', { table: t.name });
  return { id: Number(tableId), qr_token: token };
}

/** Backfill: give a token to every table that has none. */
async function generateMissingTokens(clientId) {
  const rows = await db.query(
    "SELECT id FROM restaurant_tables WHERE client_id=? AND is_active=1 AND (qr_token IS NULL OR qr_token='')",
    [clientId]);
  for (const r of rows) {
    await db.exec('UPDATE restaurant_tables SET qr_token=?, qr_token_at=NOW() WHERE id=? AND client_id=?',
      [newToken(), r.id, clientId]);
  }
  return { generated: rows.length };
}

/**
 * Resolve a scanned card back to its table.
 *
 * A token that has been regenerated must resolve to NOTHING, not to the table
 * it used to belong to - otherwise the "the old card stops working" promise
 * above is decorative. Because the column carries UNIQUE(qr_token), an exact
 * match is the whole lookup.
 */
async function resolveToken(clientId, token) {
  const clean = String(token || '').trim();
  if (!clean) return null;
  return db.one(
    `SELECT t.id, t.name, t.seats, z.name AS zone_name
       FROM restaurant_tables t
       LEFT JOIN table_zones z ON z.id=t.zone_id AND z.client_id=t.client_id
      WHERE t.client_id=? AND t.qr_token=? AND t.is_active=1 LIMIT 1`, [clientId, clean]);
}

/**
 * The printable sheet of cards.
 *
 * The SVG is rendered here, on the restaurant's own machine, from a library in
 * package.json - never from an image service. A printed card outlives the
 * supplier of whatever CDN drew it, and a till that needs the internet to print
 * a table card is a till that cannot print table cards.
 */
async function qrCards(clientId, { size = 5 } = {}) {
  const QRCode = require('qrcode-svg');
  const licence = require('../licence');
  const settings = await db.one('SELECT slug, business_name, is_published FROM qr_menu_settings WHERE client_id=?',
    [clientId]).catch(() => null);
  const client = await db.one('SELECT company_name FROM clients WHERE id=?', [clientId]);
  const base = (await licence.panelUrl()).replace(/\/+$/, '');
  const rows = await db.query(
    `SELECT t.id, t.name, t.qr_token, t.seats, z.name AS zone_name
       FROM restaurant_tables t
       LEFT JOIN table_zones z ON z.id=t.zone_id AND z.client_id=t.client_id
      WHERE t.client_id=? AND t.is_active=1
      ORDER BY z.sort_order, z.name, t.sort_order, t.name`, [clientId]);

  const slug = settings && settings.slug ? settings.slug : null;
  const cards = rows.map(t => {
    /*
     * The address is deliberately a flat query string with no rewrite rule
     * behind it. A printed card's URL can never be changed, so it must not
     * depend on a web-server configuration somebody may edit in three years.
     */
    const url = slug && t.qr_token
      ? `${base}/q.php?i=${encodeURIComponent(slug)}&m=${encodeURIComponent(t.qr_token)}`
      : null;
    return {
      id: t.id,
      name: t.name,
      zone_name: t.zone_name || 'Genel Alan',
      seats: t.seats === null ? null : Number(t.seats),
      qr_token: t.qr_token || null,
      url,
      svg: url ? new QRCode({ content: url, padding: 2, width: 32 * size, height: 32 * size,
        color: '#18181B', background: '#ffffff', ecl: 'M', join: true }).svg() : null,
    };
  });

  /*
   * The warning ladder, in the order the person printing needs it: a card with
   * no token prints a blank square, a card with no slug points nowhere, and a
   * card for an unpublished menu scans fine and then shows an empty page. All
   * three are printable mistakes, so they are warnings, not errors.
   */
  const missing = cards.filter(c => !c.qr_token).length;
  const warnings = [];
  if (missing) warnings.push({ code: 'missing_token', text: `${missing} masanin karekodu yok. "Eksik karekodlari uret" ile tamamlayin.` });
  if (!slug) warnings.push({ code: 'no_slug', text: 'Dijital menu adresi (slug) tanimli degil. Kartlar basilabilir ama okutuldugunda menu acilmaz.' });
  else if (settings && Number(settings.is_published) !== 1) {
    warnings.push({ code: 'not_published', text: 'Dijital menu yayinda degil. Kartlar basilabilir ama okutuldugunda menu acilmaz.' });
  }
  return {
    brand: (settings && settings.business_name) || (client && client.company_name) || 'NOKTApp',
    slug, missing, warnings, cards,
  };
}

/* ------------------------------------------------------------------ */
/* rezervasyonlar                                                     */
/* ------------------------------------------------------------------ */

const RES_STATUS = {
  booked: 'Bekliyor',
  seated: 'Oturdu',
  done: 'Tamamlandi',
  cancelled: 'Iptal',
  noshow: 'Gelmedi',
};
/* Which moves are legal. A cancelled booking cannot quietly become a seated
   one three hours later; the till has to say no rather than rewrite history. */
const RES_MOVES = {
  booked: ['seated', 'done', 'cancelled', 'noshow'],
  seated: ['done', 'cancelled'],
  done: [],
  cancelled: ['booked'],
  noshow: ['booked'],
};

function pad2(n) { return String(n).padStart(2, '0'); }

/** "2026-09-03" + "19:30" -> "2026-09-03 19:30:00", refusing anything else. */
function normaliseWhen(date, time) {
  const d = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('Tarih gecersiz (YYYY-AA-GG)');
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(time || '').trim());
  if (!m) throw bad('Saat gecersiz (SS:DD)');
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw bad('Saat gecersiz (SS:DD)');
  return `${d} ${pad2(h)}:${pad2(mi)}:00`;
}

/** Accept either {date,time} or a whole {starts_at}. The phone sends one, the till the other. */
function startsAtFrom(data) {
  if (data.starts_at) {
    const s = String(data.starts_at).trim().replace('T', ' ');
    const m = /^(\d{4}-\d{2}-\d{2})[ ](\d{1,2}:\d{2})/.exec(s);
    if (!m) throw bad('Tarih/saat gecersiz');
    return normaliseWhen(m[1], m[2]);
  }
  return normaliseWhen(data.date, data.time || data.starts_time);
}

/**
 * Who else is promised this table in the same window.
 *
 * The old screen had no such check at all: two parties could be booked onto
 * masa 6 at 19:00 and 19:30 and nobody found out until the second one walked
 * in. Overlap is the standard half-open comparison - a booking that ENDS at
 * 19:00 does not collide with one that STARTS at 19:00, because the table is
 * genuinely free at that instant.
 *
 * Cancelled and no-show bookings are not conflicts: the table is free.
 */
async function conflicts(clientId, { tableId, startsAt, durationMin = 120, excludeId = null }) {
  if (!tableId) return [];                       // a booking with no table cannot double-book one
  return db.query(
    `SELECT r.id, r.guest_name, r.guest_phone, r.party_size, r.starts_at, r.duration_min, r.status,
            DATE_ADD(r.starts_at, INTERVAL r.duration_min MINUTE) AS ends_at
       FROM reservations r
      WHERE r.client_id=? AND r.table_id=? AND r.status IN ('booked','seated')
        AND r.id <> ?
        AND r.starts_at < DATE_ADD(?, INTERVAL ? MINUTE)
        AND DATE_ADD(r.starts_at, INTERVAL r.duration_min MINUTE) > ?
      ORDER BY r.starts_at`,
    [clientId, tableId, excludeId || 0, startsAt, Number(durationMin) || 120, startsAt]);
}

async function assertTableBookable(clientId, tableId) {
  if (!tableId) return null;
  const t = await db.one(
    'SELECT id, name, seats FROM restaurant_tables WHERE id=? AND client_id=? AND is_active=1',
    [tableId, clientId]);
  if (!t) throw bad('Masa bulunamadi veya kapali', 404);
  return t;
}

/**
 * Create a booking.
 *
 * A clash is REFUSED, not silently accepted, and the refusal carries the rows
 * it clashed with so the screen can say "Masa 6 saat 19:00'da Yilmaz ailesine
 * verilmis" instead of a bare error. `force` is how the manager overrules it
 * (two parties really are sharing a long table) - and when they do, the answer
 * still carries the warning so the record is not silently clean.
 */
async function createReservation(clientId, data, userId) {
  const guest = String(data.guest_name || '').trim();
  if (!guest) throw bad('Misafir adi zorunlu');
  const startsAt = startsAtFrom(data);
  const party = Math.max(1, Math.floor(Number(data.party_size) || 2));
  const duration = Math.max(15, Math.min(600, Math.floor(Number(data.duration_min) || 120)));
  const tableId = data.table_id ? Number(data.table_id) : null;
  const table = await assertTableBookable(clientId, tableId);

  const warnings = [];
  const clash = await conflicts(clientId, { tableId, startsAt, durationMin: duration });
  if (clash.length && !data.force) {
    const e = bad(`${table.name} bu saatte ${clash[0].guest_name} adina ayrilmis (${String(clash[0].starts_at).slice(11, 16)}).`,
      409, 'double_booking');
    e.conflicts = clash;
    throw e;
  }
  if (clash.length) {
    warnings.push({ code: 'double_booking',
      text: `${table.name} ayni saatte ${clash.length} baska rezervasyona daha ayrildi.` });
  }
  /* Capacity is advice, never a refusal: two tables get pushed together every
     night of the week and the till has no way to know that happened. */
  if (table && table.seats && party > Number(table.seats)) {
    warnings.push({ code: 'over_capacity',
      text: `${table.name} ${table.seats} kisilik, rezervasyon ${party} kisi.` });
  }

  const id = await db.insert(
    `INSERT INTO reservations (client_id, table_id, guest_name, guest_phone, party_size, starts_at,
        duration_min, status, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?, 'booked', ?, ?, NOW())`,
    [clientId, tableId, guest, String(data.guest_phone || '').trim() || null, party, startsAt,
     duration, String(data.note || '').trim() || null, userId || null]);
  log.info('floor', 'rezervasyon olusturuldu', { id, guest, startsAt, tableId });
  return { id, warnings, conflicts: clash };
}

/** Edit an existing booking. Same clash rule as creating one. */
async function updateReservation(clientId, id, data) {
  const row = await db.one('SELECT * FROM reservations WHERE id=? AND client_id=?', [id, clientId]);
  if (!row) throw bad('Rezervasyon bulunamadi', 404);
  if (row.status === 'seated') throw bad('Oturmus rezervasyon duzenlenemez, adisyondan devam edin', 409);

  const guest = data.guest_name === undefined ? row.guest_name : String(data.guest_name || '').trim();
  if (!guest) throw bad('Misafir adi zorunlu');
  const startsAt = (data.starts_at || data.date || data.time || data.starts_time)
    ? startsAtFrom({ ...data, date: data.date || String(row.starts_at).slice(0, 10),
        time: data.time || data.starts_time || String(row.starts_at).slice(11, 16) })
    : String(row.starts_at).replace('T', ' ').slice(0, 19);
  const party = data.party_size === undefined ? row.party_size : Math.max(1, Math.floor(Number(data.party_size) || 2));
  const duration = data.duration_min === undefined ? row.duration_min
    : Math.max(15, Math.min(600, Math.floor(Number(data.duration_min) || 120)));
  const tableId = data.table_id === undefined ? row.table_id : (data.table_id ? Number(data.table_id) : null);
  const table = await assertTableBookable(clientId, tableId);

  const warnings = [];
  const clash = await conflicts(clientId, { tableId, startsAt, durationMin: duration, excludeId: id });
  if (clash.length && !data.force) {
    const e = bad(`${table.name} bu saatte ${clash[0].guest_name} adina ayrilmis (${String(clash[0].starts_at).slice(11, 16)}).`,
      409, 'double_booking');
    e.conflicts = clash;
    throw e;
  }
  if (clash.length) warnings.push({ code: 'double_booking', text: 'Bu masa ayni saatte baska bir rezervasyona da ayrildi.' });
  if (table && table.seats && party > Number(table.seats)) {
    warnings.push({ code: 'over_capacity', text: `${table.name} ${table.seats} kisilik, rezervasyon ${party} kisi.` });
  }

  await db.exec(
    `UPDATE reservations SET table_id=?, guest_name=?, guest_phone=?, party_size=?, starts_at=?,
        duration_min=?, note=?, updated_at=NOW() WHERE id=? AND client_id=?`,
    [tableId, guest, data.guest_phone === undefined ? row.guest_phone : (String(data.guest_phone || '').trim() || null),
     party, startsAt, duration,
     data.note === undefined ? row.note : (String(data.note || '').trim() || null), id, clientId]);
  return { id: Number(id), warnings, conflicts: clash };
}

/**
 * Move a booking along its lifecycle: bekliyor -> geldi/oturdu -> tamamlandi,
 * plus iptal and gelmedi. Seating is NOT done here - it opens a bill, so it has
 * its own function below.
 */
async function setReservationStatus(clientId, id, status) {
  const row = await db.one('SELECT * FROM reservations WHERE id=? AND client_id=?', [id, clientId]);
  if (!row) throw bad('Rezervasyon bulunamadi', 404);
  if (!RES_STATUS[status]) throw bad('Gecersiz durum');
  if (status === 'seated') throw bad('Oturtmak icin "Masaya otur" kullanilmalidir', 400);
  /* the field is called reservation_status, not status: the HTTP envelope
     already owns "status", and a caller that flattens the two cannot tell a
     booking's state from the response code */
  if (row.status === status) return { id: Number(id), reservation_status: status };
  if (!(RES_MOVES[row.status] || []).includes(status)) {
    throw bad(`"${RES_STATUS[row.status]}" durumundan "${RES_STATUS[status]}" durumuna gecilemez`, 409);
  }
  await db.exec('UPDATE reservations SET status=?, updated_at=NOW() WHERE id=? AND client_id=?',
    [status, id, clientId]);
  log.info('floor', 'rezervasyon durumu degisti', { id, from: row.status, to: status });
  return { id: Number(id), reservation_status: status, previous: row.status };
}

/**
 * SEAT - the bridge the PHP had and the only reason reservations are in the
 * till at all: the booking stops being a note and becomes a bill on a table.
 *
 * The bill is opened through orders.openOrder so it is numbered from the same
 * per-day counter, labelled by the same A/B/C rule and attached to the open
 * shift. The PHP built its own INSERT here and its own 'A'.(count+1) label,
 * which is why a seated reservation's bill was labelled differently from every
 * other bill on the same table.
 */
async function seatReservation(clientId, id, { tableId = null, userId = null } = {}) {
  const row = await db.one('SELECT * FROM reservations WHERE id=? AND client_id=?', [id, clientId]);
  if (!row) throw bad('Rezervasyon bulunamadi', 404);
  if (row.status === 'seated' && row.order_id) {
    // pressing it twice takes you to the bill rather than opening a second one
    return { id: Number(id), order_id: row.order_id, table_id: row.table_id, already: true };
  }
  if (row.status !== 'booked') {
    throw bad(`"${RES_STATUS[row.status]}" durumundaki rezervasyon oturtulamaz`, 409);
  }
  const target = tableId ? Number(tableId) : row.table_id;
  if (!target) throw bad('Once bir masa secin', 400);
  await assertTableBookable(clientId, target);

  const orderId = await orders.openOrder(clientId, {
    tableId: target, waiterId: userId, userId,
    // the guest's name on the bill label is what the floor plan then shows, so
    // a waiter looking at the plan sees "Yilmaz" rather than "B"
    label: row.guest_name ? String(row.guest_name).slice(0, 20) : null,
  });
  await db.exec(
    `UPDATE reservations SET status='seated', table_id=?, order_id=?, seated_at=NOW(), seated_by=?,
        updated_at=NOW() WHERE id=? AND client_id=?`,
    [target, orderId, userId || null, id, clientId]);
  log.info('floor', 'rezervasyon masaya oturtuldu', { id, table: target, orderId });
  return { id: Number(id), order_id: orderId, table_id: target, reservation_status: 'seated' };
}

/**
 * List bookings over a range (a single day is from===to). The default is today,
 * which is what the screen opens on.
 */
async function reservations(clientId, { from = null, to = null, status = null, tableId = null } = {}) {
  const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  let f = d(from) || new Date().toISOString().slice(0, 10);
  let t = d(to) || f;
  if (f > t) { const s = f; f = t; t = s; }        // a range typed backwards is still a range

  const args = [clientId, f + ' 00:00:00', t + ' 23:59:59'];
  let where = 'r.client_id=? AND r.starts_at >= ? AND r.starts_at <= ?';
  if (status && RES_STATUS[status]) { where += ' AND r.status=?'; args.push(status); }
  if (tableId) { where += ' AND r.table_id=?'; args.push(Number(tableId)); }

  const rows = await db.query(
    `SELECT r.*, t.name AS table_name, z.name AS zone_name, u.display_name AS created_by_name,
            o.status AS order_status, o.grand_total AS order_total,
            DATE_ADD(r.starts_at, INTERVAL r.duration_min MINUTE) AS ends_at
       FROM reservations r
       LEFT JOIN restaurant_tables t ON t.id=r.table_id AND t.client_id=r.client_id
       LEFT JOIN table_zones z ON z.id=t.zone_id AND z.client_id=r.client_id
       LEFT JOIN users u ON u.id=r.created_by AND u.client_id=r.client_id
       LEFT JOIN orders o ON o.id=r.order_id AND o.client_id=r.client_id
      WHERE ${where}
      ORDER BY r.starts_at, r.id`, args);
  for (const r of rows) r.status_label = RES_STATUS[r.status] || r.status;

  /* The two numbers the screen puts above the list: how many parties are still
     expected, and how many covers that is. Only 'booked' counts - a cancelled
     booking is not a cover the kitchen has to cook for. */
  const waiting = rows.filter(r => r.status === 'booked');
  return {
    from: f, to: t, rows,
    summary: {
      total: rows.length,
      booked: waiting.length,
      guests: waiting.reduce((s, r) => s + Number(r.party_size || 0), 0),
      seated: rows.filter(r => r.status === 'seated').length,
      done: rows.filter(r => r.status === 'done').length,
      cancelled: rows.filter(r => r.status === 'cancelled').length,
      noshow: rows.filter(r => r.status === 'noshow').length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* rezervasyon listesi - dışa aktarma                                 */
/* ------------------------------------------------------------------ */

/*
 * The book, on paper.
 *
 * A restaurant's reservations are not only a screen. On a busy Saturday the
 * list goes to the host stand, and the host stand does not have the till: it
 * has a printout, next to the phone, that somebody writes on. That is why this
 * is a must rather than a nicety - the screen replaces the diary only if it
 * can produce what the diary was.
 *
 * Built off `reservations()`, the same function the screen draws from, so the
 * paper and the screen can never disagree about who is coming.
 */
const RES_COLS = [
  { k: 'gun', tr: 'Tarih', t: sheetfmt.DATE },
  { k: 'saat', tr: 'Saat', t: sheetfmt.TXT },
  { k: 'guest_name', tr: 'Misafir', t: sheetfmt.TXT },
  { k: 'guest_phone', tr: 'Telefon', t: sheetfmt.TXT },
  { k: 'party_size', tr: 'Kişi', t: sheetfmt.INT },
  { k: 'yer', tr: 'Masa', t: sheetfmt.TXT },
  { k: 'status_label', tr: 'Durum', t: sheetfmt.TXT },
  { k: 'sure', tr: 'Süre', t: sheetfmt.TXT },
  { k: 'note', tr: 'Not', t: sheetfmt.TXT },
];

async function reservationExport(clientId, q = {}) {
  const r = await reservations(clientId, q);
  const two = (n) => String(n).padStart(2, '0');

  const rows = r.rows.map(x => {
    const at = new Date(x.starts_at);
    return {
      ...x,
      gun: String(x.starts_at).slice(0, 10),
      saat: `${two(at.getHours())}:${two(at.getMinutes())}`,
      /* the zone matters as much as the table number: "12" means nothing to
         somebody standing in a restaurant with a terrace and a back room */
      yer: x.table_name
        ? (x.zone_name ? `${x.zone_name} · ${x.table_name}` : String(x.table_name))
        : 'Masasız',
      sure: x.duration_min ? `${x.duration_min} dk` : '',
      note: x.note || '',
    };
  });

  const s = r.summary;
  const title = r.from === r.to
    ? `Rezervasyonlar ${sheetfmt.dmy(r.from)}`
    : `Rezervasyonlar ${sheetfmt.dmy(r.from)} - ${sheetfmt.dmy(r.to)}`;

  return {
    name: r.from === r.to ? `rezervasyon-${r.from}` : `rezervasyon-${r.from}_${r.to}`,
    title,
    /* The counts the screen shows above the list travel with it: a printout
       that says "4 misafir bekleniyor" is answering the question the host
       actually has, and it saves counting rows by hand at the door. */
    facts: [
      ['Bekleyen', `${s.booked} rezervasyon · ${s.guests} misafir`],
      ['Oturdu', String(s.seated)],
      ['Tamamlandı', String(s.done)],
      ['Gelmedi / iptal', `${s.noshow} / ${s.cancelled}`],
      ['Toplam kayıt', String(s.total)],
    ],
    sheets: [{ name: 'Rezervasyonlar', cols: RES_COLS, rows }],
  };
}

/* ------------------------------------------------------------------ */
/* mutfak panosu (kitchen display)                                    */
/* ------------------------------------------------------------------ */

/*
 * Age thresholds in minutes. These are the numbers the old board used and the
 * kitchen is used to reading; they are named here so changing them is one edit
 * rather than three magic numbers scattered through a template.
 */
const AGE_WARN = 10;
const AGE_LATE = 20;
function ageLevel(minutes) {
  if (minutes >= AGE_LATE) return 'late';
  if (minutes >= AGE_WARN) return 'warn';
  return 'fresh';
}
function ageText(minutes) {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 1) return 'simdi';
  if (m < 60) return m + ' dk';
  return Math.floor(m / 60) + ' sa ' + (m % 60) + ' dk';
}

/*
 * Which station an item belongs to.
 *
 * order_items.station_id is written by nothing on the add path - the category's
 * station is the real routing rule and always has been (the PHP joined through
 * `categories.station_id` for exactly this reason). COALESCE keeps working if a
 * per-line override is ever set without making the board depend on one.
 */
const STATION_EXPR = 'COALESCE(oi.station_id, c.station_id)';

/*
 * WHEN IT WAS SENT.
 *
 * Not opened_at (the bill may have been open an hour before anyone ordered a
 * main), and not station_updated_at (that moves every time the kitchen touches
 * the ticket, so a ticket marked "hazirlaniyor" would reset to nought minutes
 * old - the one thing the board must never do). station_projection_items is
 * inserted exactly once, at the moment sendToStations runs, so its created_at
 * is the send time. The fallbacks only matter for rows that predate the
 * projection table.
 */
const SENT_AT_EXPR = `COALESCE(
    (SELECT MIN(spi.created_at) FROM station_projection_items spi
      WHERE spi.order_item_id=oi.id AND spi.client_id=oi.client_id),
    oi.station_updated_at, o.opened_at)`;

/**
 * The stations a kitchen board should offer, with the count waiting at each -
 * which is what makes the per-station filter usable rather than a guess.
 *
 * The cash/receipt station is excluded: it prints bills, it does not cook.
 */
async function boardStations(clientId) {
  const rows = await db.query(
    `SELECT s.id, s.name, s.display_name, s.sort_order
       FROM stations s
      WHERE s.client_id=? AND s.is_active=1
        AND s.id <> COALESCE((SELECT c.receipt_station_id FROM clients c WHERE c.id=?), 0)
      ORDER BY s.sort_order, s.name`, [clientId, clientId]);
  const counts = await db.query(
    `SELECT ${STATION_EXPR} AS station_id, COUNT(*) AS pending
       FROM order_items oi
       JOIN products p ON p.id=oi.product_id AND p.client_id=oi.client_id
       LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
       JOIN orders o ON o.id=oi.order_id AND o.client_id=oi.client_id
      WHERE oi.client_id=? AND oi.sent_qty>0 AND oi.is_deleted=0
        AND o.status='open' AND o.is_deleted=0
        AND oi.station_status NOT IN ('served','cancelled')
      GROUP BY ${STATION_EXPR}`, [clientId]);
  const by = new Map(counts.filter(c => c.station_id !== null).map(c => [Number(c.station_id), Number(c.pending)]));
  for (const s of rows) s.pending = by.get(Number(s.id)) || 0;
  /*
   * Items whose category points at no station at all would otherwise be
   * invisible - nobody would cook them and nobody would know. The board offers
   * them as one extra bucket rather than losing them.
   */
  const stray = counts.find(c => c.station_id === null);
  return { stations: rows, unassigned: stray ? Number(stray.pending) : 0 };
}

/**
 * The live board: one ticket per bill, oldest first, each carrying its age.
 *
 * Grouping by order is not cosmetic - a kitchen cooks a table, not a line, and
 * a board that lists items loose makes it impossible to see that four of them
 * belong together and must leave the pass at the same moment.
 */
async function kitchenBoard(clientId, { stationId = null } = {}) {
  const args = [clientId];
  let filter = '';
  if (stationId === 'unassigned') filter = `AND ${STATION_EXPR} IS NULL`;
  else if (stationId) { filter = `AND ${STATION_EXPR}=?`; args.push(Number(stationId)); }

  const rows = await db.query(
    `SELECT oi.id, oi.order_id, oi.qty, oi.sent_qty, oi.note, oi.station_status,
            oi.station_updated_at, p.name AS product_name,
            o.adisyon_no, o.bill_label, o.opened_at, rt.name AS table_name,
            ${STATION_EXPR} AS station_id, s.display_name AS station_name,
            ${SENT_AT_EXPR} AS sent_at,
            TIMESTAMPDIFF(SECOND, ${SENT_AT_EXPR}, NOW()) AS age_sec
       FROM order_items oi
       JOIN products p ON p.id=oi.product_id AND p.client_id=oi.client_id
       LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
       JOIN orders o ON o.id=oi.order_id AND o.client_id=oi.client_id
       LEFT JOIN restaurant_tables rt ON rt.id=o.table_id AND rt.client_id=o.client_id
       LEFT JOIN stations s ON s.id=${STATION_EXPR} AND s.client_id=oi.client_id
      WHERE oi.client_id=? AND oi.sent_qty>0 AND oi.is_deleted=0
        AND o.status='open' AND o.is_deleted=0
        AND oi.station_status NOT IN ('served','cancelled')
        ${filter}
      ORDER BY sent_at, oi.order_id, oi.id`, args);

  const tickets = new Map();
  for (const r of rows) {
    const mins = Math.max(0, Math.floor(Number(r.age_sec || 0) / 60));
    const item = {
      id: r.id,
      product_name: r.product_name,
      qty: Number(r.sent_qty),           // what was SENT, not what is on the bill
      note: r.note || null,
      station_status: r.station_status,
      station_id: r.station_id === null ? null : Number(r.station_id),
      station_name: r.station_name || null,
      sent_at: r.sent_at,
      age_min: mins,
      age_text: ageText(mins),
      age_level: ageLevel(mins),
    };
    if (!tickets.has(r.order_id)) {
      tickets.set(r.order_id, {
        order_id: r.order_id,
        adisyon_no: r.adisyon_no,
        bill_label: r.bill_label || null,
        table_name: r.table_name || (r.bill_label ? '#' + r.bill_label : 'Paket'),
        opened_at: r.opened_at,
        sent_at: r.sent_at,
        age_min: mins,
        items: [],
      });
    }
    const tk = tickets.get(r.order_id);
    // the ticket is as old as its OLDEST line: one plate has been waiting
    // twenty minutes even if a coffee was added to the same bill just now
    if (mins > tk.age_min) { tk.age_min = mins; tk.sent_at = r.sent_at; }
    tk.items.push(item);
  }
  const list = Array.from(tickets.values()).map(t => ({
    ...t, age_text: ageText(t.age_min), age_level: ageLevel(t.age_min),
  })).sort((a, b) => b.age_min - a.age_min);

  return {
    tickets: list,
    counts: {
      tickets: list.length,
      items: rows.length,
      late: list.filter(t => t.age_level === 'late').length,
      warn: list.filter(t => t.age_level === 'warn').length,
      new: rows.filter(r => r.station_status === 'new').length,
    },
    thresholds: { warn: AGE_WARN, late: AGE_LATE },
  };
}

/**
 * Geçmiş - what this station actually put out on a given day.
 *
 * Served AND cancelled rows are included on purpose: the question this view
 * answers is "did that go out, and if not what happened to it", and a screen
 * that hides the cancellations cannot answer the second half.
 */
async function kitchenHistory(clientId, { stationId = null, date = null } = {}) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : new Date().toISOString().slice(0, 10);
  const args = [clientId, d + ' 00:00:00', d + ' 23:59:59'];
  let filter = '';
  if (stationId === 'unassigned') filter = `AND ${STATION_EXPR} IS NULL`;
  else if (stationId) { filter = `AND ${STATION_EXPR}=?`; args.push(Number(stationId)); }

  const rows = await db.query(
    `SELECT oi.id, oi.order_id, oi.sent_qty, oi.note, oi.station_status, oi.station_updated_at,
            oi.is_deleted, p.name AS product_name, o.adisyon_no, o.bill_label, o.status AS order_status,
            rt.name AS table_name, ${STATION_EXPR} AS station_id,
            ${SENT_AT_EXPR} AS sent_at,
            TIMESTAMPDIFF(SECOND, ${SENT_AT_EXPR}, COALESCE(oi.station_updated_at, NOW())) AS took_sec
       FROM order_items oi
       JOIN products p ON p.id=oi.product_id AND p.client_id=oi.client_id
       LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
       JOIN orders o ON o.id=oi.order_id AND o.client_id=oi.client_id
       LEFT JOIN restaurant_tables rt ON rt.id=o.table_id AND rt.client_id=o.client_id
      WHERE oi.client_id=? AND oi.sent_qty>0
        AND ${SENT_AT_EXPR} >= ? AND ${SENT_AT_EXPR} <= ?
        ${filter}
      ORDER BY sent_at DESC, oi.id DESC
      LIMIT 400`, args);

  const out = rows.map(r => {
    const took = Math.max(0, Math.floor(Number(r.took_sec || 0) / 60));
    return {
      id: r.id, order_id: r.order_id, adisyon_no: r.adisyon_no,
      table_name: r.table_name || (r.bill_label ? '#' + r.bill_label : 'Paket'),
      product_name: r.product_name, qty: Number(r.sent_qty), note: r.note || null,
      // a line taken off the bill is a cancellation whatever the station last said
      status: Number(r.is_deleted) ? 'cancelled' : r.station_status,
      sent_at: r.sent_at, done_at: r.station_updated_at,
      took_min: took, took_text: ageText(took),
    };
  });
  const n = (f) => out.filter(f).reduce((s, r) => s + r.qty, 0);
  return {
    date: d,
    rows: out,
    summary: {
      total: out.reduce((s, r) => s + r.qty, 0),
      served: n(r => r.status === 'served'),
      cancelled: n(r => r.status === 'cancelled'),
      open: n(r => r.status !== 'served' && r.status !== 'cancelled'),
      // the number a head chef actually wants: how long a plate took, on average
      avg_min: out.length ? Math.round(out.reduce((s, r) => s + r.took_min, 0) / out.length) : 0,
    },
  };
}

/**
 * Move one line along the station state machine.
 *
 * `cancelled` is deliberately not settable from the board: taking an item off a
 * bill is a till decision with money attached (orders.cancelItem), and letting
 * the kitchen tablet do it would delete a line nobody authorised.
 */
const ITEM_STATES = ['new', 'preparing', 'ready', 'served'];
async function setItemState(clientId, itemId, state) {
  if (!ITEM_STATES.includes(state)) throw bad('Gecersiz durum');
  const n = await db.exec(
    'UPDATE order_items SET station_status=?, station_updated_at=NOW() WHERE id=? AND client_id=? AND is_deleted=0',
    [state, itemId, clientId]);
  if (!n) throw bad('Satir bulunamadi', 404);
  /* keep the projection the till's own board reads in step, so the two screens
     never disagree about whether a plate has gone out */
  await db.exec(
    "UPDATE station_projection_items SET station_status=?, updated_at=NOW() WHERE order_item_id=? AND client_id=?",
    [state === 'served' ? 'done' : state, itemId, clientId]).catch(() => {});
  return { id: Number(itemId), station_status: state };
}

module.exports = {
  RES_STATUS, RES_MOVES, AGE_WARN, AGE_LATE, ageLevel, ageText,
  zones, saveZone, deleteZone, reorderZones,
  tables, saveTable, bulkCreate, setTableActive, moveTable, reorderTables, setSeats,
  regenerateToken, generateMissingTokens, resolveToken, qrCards,
  conflicts, createReservation, updateReservation, setReservationStatus, seatReservation, reservations,
  reservationExport,
  boardStations, kitchenBoard, kitchenHistory, setItemState,
};
