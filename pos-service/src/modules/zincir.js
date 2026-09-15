'use strict';
/**
 * ZİNCİR — the till's side of the multi-branch layer.
 *
 * Head office keeps the house menu in the panel and publishes versions of it.
 * The panel never pushes; this module pulls, on the back of the licence
 * heartbeat that already runs every half hour. That is not a limitation
 * dressed up: a branch behind a hotel NAT, or switched off since Friday, comes
 * back, notices it is behind, and catches up. Nothing here needs a port open
 * on the restaurant's router.
 *
 * THE RULE THAT OUTRANKS EVERYTHING ELSE HERE
 * -------------------------------------------
 * Thousands of installs are one shop and asked for none of this. So an
 * unbound till - one with no `branch_code` in its settings - makes NO request
 * from this file, ever. `pull()` returns `{ skipped:'no_branch' }` before it
 * has looked up a URL. The only thing that can bind a till is a person typing
 * the code head office read out to them. Until that happens the local menu is
 * exactly what the branch made it.
 *
 * THE MAPPING (contract §3)
 * -------------------------
 * Match on `master_code`, never on the name. `master_code IS NULL` is the
 * branch's own product and is never touched, renamed, repriced or
 * deactivated. A master row the branch has not seen is inserted. A master row
 * withdrawn at head office is deactivated, never deleted, because last year's
 * order lines still point at it.
 *
 * THE EXCEPTIONS (contract §4)
 * ----------------------------
 * Overrides arrive as the branch's FULL current set on every pull, not as a
 * diff, and they carry no version. So they are reconciled on every pull, even
 * one that returns an empty delta, and the effective values are recomputed
 * from the master shadow columns rather than patched in place:
 *
 *     price     = override price, only where master_price_locked = 0
 *                 otherwise the master price
 *     is_active = master_is_active AND NOT (override.available = 0)
 *
 * That is what makes a withdrawn exception put the house value back, and what
 * makes re-applying the same version a genuine no-op.
 *
 * ONE TRANSACTION
 * ---------------
 * Categories, products, withdrawals, overrides and the version stamp all go in
 * together. A crash halfway leaves the old menu intact and the recorded
 * version unchanged, so the next pull asks for the same delta again.
 */
const db = require('../db');
const log = require('../logger');
const licence = require('../licence');
const { money } = require('../util/http');

/** The settings this module owns. Nothing else writes them. */
const S_BRANCH_ID = 'branch_id';
const S_BRANCH_CODE = 'branch_code';
const S_BRANCH_NAME = 'branch_name';
const S_VERSION = 'menu_version';
const S_LAST_PULL = 'menu_last_pull_at';
const S_LAST_ERROR = 'menu_last_error';

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

/**
 * What the owner is shown, and what every caller here asks first.
 *
 * `bound` is the single gate. It is read from the settings row and not from
 * the panel, because deciding "is this a chain till" must not cost a request.
 */
async function state(clientId) {
  const code = (await db.getSetting(S_BRANCH_CODE, '')) || '';
  const bound = !!code;
  const last = bound ? await db.one(
    `SELECT * FROM np_menu_apply_log WHERE client_id=? ORDER BY id DESC LIMIT 1`, [clientId]) : null;
  const counts = bound ? await db.one(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN master_code IS NOT NULL THEN 1 ELSE 0 END) master,
            SUM(CASE WHEN master_code IS NULL THEN 1 ELSE 0 END) local,
            SUM(CASE WHEN master_code IS NOT NULL AND is_active=0 THEN 1 ELSE 0 END) master_off
       FROM products WHERE client_id=?`, [clientId]) : null;
  return {
    bound,
    branch_id: bound ? Number(await db.getSetting(S_BRANCH_ID, 0)) || null : null,
    branch_code: code || null,
    branch_name: bound ? await db.getSetting(S_BRANCH_NAME, null) : null,
    menu_version: Number(await db.getSetting(S_VERSION, 0)) || 0,
    last_pull_at: bound ? await db.getSetting(S_LAST_PULL, null) : null,
    last_error: bound ? await db.getSetting(S_LAST_ERROR, null) : null,
    last_apply: last ? {
      version: Number(last.version), applied_at: last.applied_at,
      inserted: Number(last.inserted), updated: Number(last.updated),
      deactivated: Number(last.deactivated), acked: !!last.acked, full: !!last.full_pull,
    } : null,
    products: counts ? {
      total: Number(counts.total) || 0,
      master: Number(counts.master) || 0,
      local: Number(counts.local) || 0,
      master_off: Number(counts.master_off) || 0,
    } : null,
  };
}

/** The apply history, newest first — a support call's first question. */
async function history(clientId, limit = 20) {
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  const rows = await db.query(
    `SELECT * FROM np_menu_apply_log WHERE client_id=? ORDER BY id DESC LIMIT ?`, [clientId, n]);
  return rows.map(r => ({
    id: r.id, version: Number(r.version), full: !!r.full_pull,
    inserted: Number(r.inserted), updated: Number(r.updated), deactivated: Number(r.deactivated),
    acked: !!r.acked, note: r.note, applied_at: r.applied_at,
  }));
}

/* ------------------------------------------------------------------ */
/* the wire                                                            */
/* ------------------------------------------------------------------ */

/**
 * Ask the panel for everything since `since`.
 *
 * Credentials go in the JSON body, never in the query string — the licence key
 * is a secret and a URL is written to every proxy log between here and the
 * panel. `since` is not a secret and rides in the query, which is how the
 * contract writes the endpoint.
 */
async function fetchMenu({ since, branchCode = null }) {
  const lic = await db.one('SELECT client_id, licence_key FROM np_licence WHERE id=1');
  if (!lic) throw bad('Bu bilgisayarda lisans kaydı yok. Önce internete bağlanıp giriş yapın.', 409);
  const url = (await licence.panelUrl()) + '/api/desktop/menu.php?since=' + encodeURIComponent(since);
  const body = {
    client_id: lic.client_id,
    licence_key: lic.licence_key,
    device_id: await licence.deviceId(),
    app_version: process.env.NOKTAPP_VERSION || '2.0.0',
    since,
  };
  /* Sending branch_code is what BINDS this device to that branch, so it is
     sent only on a deliberate bind and never on the heartbeat's pull. */
  if (branchCode) body.branch_code = branchCode;
  const res = await licence.post(url, body, 30000);
  if (res.status !== 200 || !res.body || !res.body.ok) {
    /*
     * `|| ''` is not a message. A panel that answers ok:false with an empty
     * error - a PHP notice swallowed, a worker recycled mid-request - left the
     * cashier looking at a blank red box on the Şube screen, with no way to
     * tell "head office does not know that code" from "head office did not
     * answer". Anything falsy becomes the status line instead.
     */
    const said = res.body && typeof res.body.error === 'string' ? res.body.error.trim() : '';
    throw bad(said || ('Merkeze ulaşılamadı (HTTP ' + res.status + '). Bağlantıyı kontrol edip tekrar deneyin.'), 502);
  }
  return res.body;
}

/** Tell head office which version this branch is on. Failure is not fatal. */
async function ack(clientId, version, counts, applyLogId) {
  const lic = await db.one('SELECT client_id, licence_key FROM np_licence WHERE id=1');
  if (!lic || !(version > 0)) return { recorded: false };
  try {
    const url = (await licence.panelUrl()) + '/api/desktop/menu-ack.php';
    const res = await licence.post(url, {
      client_id: lic.client_id,
      licence_key: lic.licence_key,
      device_id: await licence.deviceId(),
      app_version: process.env.NOKTAPP_VERSION || '2.0.0',
      version,
      applied_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      counts,
    }, 20000);
    const okAck = res.status === 200 && res.body && res.body.ok && res.body.recorded;
    if (okAck && applyLogId) {
      await db.exec('UPDATE np_menu_apply_log SET acked=1 WHERE id=?', [applyLogId]);
    }
    return { recorded: !!okAck, body: res.body };
  } catch (e) {
    /* Offline is normal. The next pull acks the same version again. */
    log.debug('zincir', 'ack failed', e.message);
    return { recorded: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* apply                                                               */
/* ------------------------------------------------------------------ */

const flag = (v, d = 1) => (v === undefined || v === null || v === '' ? d : (Number(v) ? 1 : 0));

/**
 * A name the local unique key will accept.
 *
 * `products` and `categories` both carry UNIQUE (client_id, name) from long
 * before any of this existed. A branch that already invented its own "Ayran"
 * would otherwise make the master "Ayran" fail to insert and take the whole
 * transaction — and the rest of the published menu — down with it. Neither row
 * may be deleted or adopted: the local one is the branch's, the master one is
 * head office's. So the master row lands under a suffixed name and both
 * survive; the master_code is what everything else matches on anyway, and the
 * next publish that renames it will clear the clash on its own.
 */
async function freeName(t, table, clientId, wanted, selfMasterCode) {
  const base = String(wanted || '').slice(0, 90) || 'Ürün';
  for (let i = 0; i < 40; i++) {
    const candidate = i === 0 ? base : `${base} (${i + 1})`;
    const clash = await t.one(
      `SELECT id FROM ${table} WHERE client_id=? AND name=?
        AND (master_code IS NULL OR master_code<>?) LIMIT 1`,
      [clientId, candidate, selfMasterCode]);
    if (!clash) return candidate;
  }
  return `${base} (${selfMasterCode})`;
}

/**
 * Write the effective price of a master product and leave a trail.
 *
 * Every price a push changes goes into the same two tables a hand-typed price
 * does — `product_price_history` for the dated series, `price_change_log` for
 * the audit — with source 'merkez', so a branch manager opening the history of
 * an item that moved overnight reads "Merkez menü" and not "Elle".
 */
async function setPrice(t, clientId, row, newPrice) {
  const old = money(row.price);
  const next = money(newPrice);
  if (old === next) return false;
  await t.exec('UPDATE products SET price=? WHERE id=? AND client_id=?', [next, row.id, clientId]);
  await t.exec(
    `INSERT INTO product_price_history (client_id, product_id, price, effective_date, created_at, created_by)
     VALUES (?,?,?,CURDATE(),NOW(),0)`, [clientId, row.id, next]);
  await t.exec(
    `INSERT INTO price_change_log (client_id, product_id, old_price, new_price, source, changed_by, changed_at)
     VALUES (?,?,?,?,'merkez',0,NOW())`, [clientId, row.id, old, next]);
  return true;
}

/**
 * Apply one published payload, whole, in one transaction.
 *
 * Returns { version, inserted, updated, deactivated, applied }. `applied:false`
 * with a reason is a normal answer, not an error: nothing published yet, or a
 * delta that carries no change.
 */
async function apply(clientId, payload) {
  const version = Number(payload.version) || 0;
  /* version 0 means head office has never pressed Yayınla. Applying an empty
     master menu would deactivate the branch's entire catalogue. */
  if (version <= 0) return { applied: false, reason: 'not_published', version: 0, inserted: 0, updated: 0, deactivated: 0 };

  const branch = payload.branch || null;
  const cats = Array.isArray(payload.categories) ? payload.categories : [];
  const prods = Array.isArray(payload.products) ? payload.products : [];
  const withdrawn = Array.isArray(payload.withdrawn) ? payload.withdrawn : [];
  const withdrawnCats = Array.isArray(payload.withdrawn_categories) ? payload.withdrawn_categories : [];
  const overrides = Array.isArray(payload.overrides) ? payload.overrides : [];

  const out = await db.tx(async (t) => {
    let inserted = 0; let updated = 0; let deactivated = 0;
    const prev = Number(await t.value('SELECT v FROM np_settings WHERE k=?', [S_VERSION])) || 0;

    /* ---------------------------------------------------------- kategoriler */
    for (const c of cats) {
      const code = String(c.master_code || '').trim();
      if (!code) continue;
      const active = flag(c.is_active);
      const row = await t.one(
        'SELECT * FROM categories WHERE client_id=? AND master_code=?', [clientId, code]);
      const name = await freeName(t, 'categories', clientId, c.name, code);
      if (row) {
        /* station_id is deliberately absent: which printer a category prints
           to is a fact about this building (contract §7). station_hint is
           advice, and advice does not overwrite a wiring decision. */
        const n = await t.exec(
          `UPDATE categories SET name=?, sort_order=?, use_in_pos=?, use_in_qr=?,
                  is_active=?, master_is_active=?
            WHERE id=? AND client_id=?`,
          [name, Number(c.sort_order) || 0, flag(c.use_in_pos), flag(c.use_in_qr),
           active, active, row.id, clientId]);
        if (n) updated++;
      } else {
        await t.insert(
          `INSERT INTO categories (client_id, name, station_id, sort_order, is_active,
              use_in_pos, use_in_qr, master_code, master_is_active)
           VALUES (?,?,NULL,?,?,?,?,?,?)`,
          [clientId, name, Number(c.sort_order) || 0, active,
           flag(c.use_in_pos), flag(c.use_in_qr), code, active]);
        inserted++;
      }
    }

    /* Withdrawn categories are deactivated, never deleted: products still
       point at them and so does every historical report. */
    for (const code of withdrawnCats) {
      const n = await t.exec(
        `UPDATE categories SET is_active=0, master_is_active=0
          WHERE client_id=? AND master_code=? AND is_active=1`, [clientId, String(code)]);
      if (n) deactivated++;
      /* Even when it was already off locally the master flag has to move, or
         the reconciliation pass below would switch it back on. */
      await t.exec('UPDATE categories SET master_is_active=0 WHERE client_id=? AND master_code=?',
        [clientId, String(code)]);
    }

    /* -------------------------------------------------------------- ürünler */
    for (const p of prods) {
      const code = String(p.master_code || '').trim();
      if (!code) continue;
      const catCode = String(p.category_code || '').trim();
      /* Read the category out of the database rather than the payload: on an
         incremental pull the product's category may not be in this delta, but
         it is certainly already local. */
      const cat = catCode
        ? await t.one('SELECT id FROM categories WHERE client_id=? AND master_code=?', [clientId, catCode])
        : null;
      const row = await t.one('SELECT * FROM products WHERE client_id=? AND master_code=?', [clientId, code]);
      if (!cat && !row) {
        /* Nowhere to hang it. Skipping is right: the next full pull carries
           the category and the product together. */
        log.warn('zincir', 'ürün atlandı, kategorisi yok', { code, catCode });
        continue;
      }
      const active = flag(p.is_active);
      const name = await freeName(t, 'products', clientId, p.name, code);
      /* A price on a currently-locked master row is stripped to null by the
         panel; keep whatever we last knew rather than writing 0.00. */
      const masterPrice = p.price === null || p.price === undefined
        ? (row ? row.master_price : null) : money(p.price);
      const locked = flag(p.price_locked, 1);

      if (row) {
        const n = await t.exec(
          `UPDATE products SET name=?, description=?, category_id=?, cost_price=?, vat_rate=?,
                  track_stock=?, use_in_pos=?, use_in_qr=?, image_url=?, sort_order=?,
                  master_price=?, master_is_active=?, master_price_locked=?
            WHERE id=? AND client_id=?`,
          [name, p.description === undefined ? row.description : (p.description || null),
           cat ? cat.id : row.category_id,
           p.cost_price === null || p.cost_price === undefined ? row.cost_price : money(p.cost_price),
           p.vat_rate === null || p.vat_rate === undefined ? row.vat_rate : money(p.vat_rate),
           flag(p.track_stock, 0), flag(p.use_in_pos), flag(p.use_in_qr),
           p.image_url === undefined ? row.image_url : (p.image_url || null),
           Number(p.sort_order) || 0,
           masterPrice, active, locked, row.id, clientId]);
        if (n) updated++;
      } else {
        await t.insert(
          `INSERT INTO products (client_id, category_id, name, price, cost_price, description,
              sort_order, is_active, use_in_pos, use_in_qr, vat_rate, track_stock, image_url,
              master_code, master_price, master_is_active, master_price_locked)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [clientId, cat.id, name, masterPrice === null ? 0 : masterPrice,
           money(p.cost_price || 0), p.description || null, Number(p.sort_order) || 0,
           active, flag(p.use_in_pos), flag(p.use_in_qr), money(p.vat_rate || 0),
           flag(p.track_stock, 0), p.image_url || null,
           code, masterPrice, active, locked]);
        inserted++;
      }
    }

    for (const code of withdrawn) {
      const n = await t.exec(
        `UPDATE products SET master_is_active=0, is_active=0
          WHERE client_id=? AND master_code=? AND is_active=1`, [clientId, String(code)]);
      if (n) deactivated++;
      /* Even when it was already off locally the master flag has to move, or
         the override pass below would switch it back on. */
      await t.exec(
        'UPDATE products SET master_is_active=0 WHERE client_id=? AND master_code=?',
        [clientId, String(code)]);
    }

    /* ------------------------------------------------------------ istisnalar */
    /*
     * The branch's full current exception set, reconciled — not patched. Every
     * master-owned row is recomputed from the master shadow columns and the
     * exceptions that are still in force, so an exception that has been
     * WITHDRAWN at head office puts the house price and the house availability
     * back on this pull rather than on some later publish.
     */
    const pOv = new Map(); const cOv = new Map();
    for (const o of overrides) {
      const code = String(o.master_code || '').trim();
      if (!code) continue;
      (o.entity === 'category' ? cOv : pOv).set(code, o);
    }

    const masterCats = await t.query(
      'SELECT id, master_code, is_active, master_is_active FROM categories WHERE client_id=? AND master_code IS NOT NULL',
      [clientId]);
    for (const c of masterCats) {
      const o = cOv.get(c.master_code);
      /* A category has no price, so only availability is honoured here. */
      const want = (c.master_is_active === null ? 1 : Number(c.master_is_active)) &&
        !(o && Number(o.available) === 0) ? 1 : 0;
      if (Number(c.is_active) !== want) {
        await t.exec('UPDATE categories SET is_active=? WHERE id=? AND client_id=?', [want, c.id, clientId]);
        if (want === 0) deactivated++; else updated++;
      }
    }

    const masterProds = await t.query(
      `SELECT id, master_code, price, is_active, master_price, master_is_active, master_price_locked
         FROM products WHERE client_id=? AND master_code IS NOT NULL`, [clientId]);
    for (const p of masterProds) {
      const o = pOv.get(p.master_code);
      const want = (p.master_is_active === null ? 1 : Number(p.master_is_active)) &&
        !(o && Number(o.available) === 0) ? 1 : 0;
      if (Number(p.is_active) !== want) {
        await t.exec('UPDATE products SET is_active=? WHERE id=? AND client_id=?', [want, p.id, clientId]);
        if (want === 0) deactivated++; else updated++;
      }
      /* price_locked=1 means the branch takes the master price, full stop. An
         override on a locked row is ignored here rather than refused: head
         office may lock a product that already had an exception, and the lock
         is the newer decision. */
      const canOverride = Number(p.master_price_locked) === 0;
      const target = canOverride && o && o.price !== null && o.price !== undefined
        ? money(o.price)
        : (p.master_price === null ? null : money(p.master_price));
      if (target !== null && await setPrice(t, clientId, p, target)) updated++;
    }

    /* ------------------------------------------------------------- kayıtlar */
    if (branch) {
      await t.exec('INSERT INTO np_settings (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)',
        [S_BRANCH_ID, String(branch.id)]);
      await t.exec('INSERT INTO np_settings (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)',
        [S_BRANCH_CODE, String(branch.code)]);
      await t.exec('INSERT INTO np_settings (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)',
        [S_BRANCH_NAME, String(branch.name || branch.code)]);
    }
    await t.exec('INSERT INTO np_settings (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)',
      [S_VERSION, String(version)]);

    /*
     * A row in the apply log only when something actually happened. The
     * heartbeat pulls every half hour and almost every one of those pulls is
     * "you are up to date"; a log that records those is a log nobody reads,
     * and it would bury the one night the menu really did change.
     */
    const moved = inserted || updated || deactivated || version !== prev;
    const logId = moved ? await t.insert(
      `INSERT INTO np_menu_apply_log (client_id, branch_id, version, full_pull, inserted, updated, deactivated, note)
       VALUES (?,?,?,?,?,?,?,?)`,
      [clientId, branch ? branch.id : null, version, payload.full ? 1 : 0,
       inserted, updated, deactivated, (payload.note || null)]) : null;
    return { applied: true, changed: !!moved, version, inserted, updated, deactivated, log_id: logId };
  });

  if (out.changed) {
    log.info('zincir', 'menü sürümü uygulandı', {
      version, inserted: out.inserted, updated: out.updated, deactivated: out.deactivated });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* pull                                                                */
/* ------------------------------------------------------------------ */

/**
 * The one entry point. `branchCode` is passed only by a deliberate bind.
 *
 * An unbound till returns before touching the network — that is the
 * single-shop guarantee, and it is why this check is the first line.
 */
async function pull(clientId, { branchCode = null } = {}) {
  const bound = !!(await db.getSetting(S_BRANCH_CODE, ''));
  if (!bound && !branchCode) return { ok: true, skipped: 'no_branch' };

  const since = Number(await db.getSetting(S_VERSION, 0)) || 0;
  let payload;
  try {
    payload = await fetchMenu({ since, branchCode });
  } catch (e) {
    /* Offline is normal, never an error. The till keeps trading on what it
       has; the reason is kept so the screen can say why it is behind. */
    await db.setSetting(S_LAST_ERROR, String(e.message).slice(0, 240));
    if (branchCode) throw e;                 // a person is waiting on this one
    log.debug('zincir', 'menü çekilemedi', e.message);
    return { ok: false, offline: true, error: e.message, version: since };
  }
  await db.setSetting(S_LAST_ERROR, '');
  await db.setSetting(S_LAST_PULL, new Date().toISOString().slice(0, 19).replace('T', ' '));

  /*
   * A code head office does not recognise binds nothing, and the panel then
   * answers with whatever branch this device was already on - which for a till
   * that is being MOVED looks exactly like success. So the answer is checked
   * against what was asked for, not merely for being non-empty; a typo has to
   * come back as a typo rather than as "connected to Merkez" on a screen where
   * somebody just typed KALEICI.
   */
  if (branchCode && (!payload.branch ||
      String(payload.branch.code || '').toUpperCase() !== branchCode)) {
    throw bad('Şube kodu tanınmadı. Merkezin verdiği kodu kontrol edin.', 404);
  }
  if (!payload.branch && !bound) return { ok: true, skipped: 'no_branch' };

  const res = await apply(clientId, payload);
  const counts = { inserted: res.inserted, updated: res.updated, deactivated: res.deactivated };
  /* Ack what moved. Telling head office the same "still on v3" every half hour
     costs a request per till per half hour and answers a question nobody
     asked; the heartbeat already proves the branch is alive. */
  const acked = res.applied && res.changed
    ? await ack(clientId, res.version, counts, res.log_id)
    : { recorded: false, skipped: true };
  return {
    ok: true, ...res, branch: payload.branch || null,
    full: !!payload.full, acked: !!acked.recorded,
  };
}

/**
 * Bind this device to a branch and take the whole menu for the first time.
 *
 * `since=0` is forced by the fact that a fresh till has menu_version 0; a till
 * moving between branches keeps its version but the override set it receives
 * is the new branch's, and the reconciliation pass above puts every price and
 * every availability right on that same pull.
 */
async function bind(clientId, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) throw bad('Şube kodu boş olamaz');
  if (!/^[A-Z0-9_-]{2,32}$/.test(c)) throw bad('Şube kodu yalnızca harf, rakam ve tire içerebilir');
  const out = await pull(clientId, { branchCode: c });
  log.info('zincir', 'şubeye bağlandı', { code: c, version: out.version });
  return { ...out, state: await state(clientId) };
}

/**
 * Called by the licence heartbeat. Never throws, never blocks the heartbeat,
 * and does nothing at all on a single-shop till.
 */
async function pullOnHeartbeat() {
  try {
    if (!(await db.getSetting(S_BRANCH_CODE, ''))) return { skipped: 'no_branch' };
    const clientId = await db.getClientId();
    if (!clientId) return { skipped: 'no_client' };
    return await pull(clientId);
  } catch (e) {
    log.debug('zincir', 'heartbeat pull failed', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { state, history, pull, bind, apply, ack, fetchMenu, pullOnHeartbeat };
