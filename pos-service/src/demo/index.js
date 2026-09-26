'use strict';
/**
 * DEMO VERİSİ — fill a fresh installation with a restaurant that has been
 * trading since 2020, and take it all out again on one button.
 *
 * Why this exists: an empty till demonstrates nothing. Every screen worth
 * showing - the year-on-year report, the waiter league, the stock ledger, the
 * kâr-zarar - is a blank page until somebody has traded through it, and no
 * amount of talking makes a blank page convincing.
 *
 * Two safety rules, and they are not negotiable:
 *
 *   1. This NEVER runs by itself unless the build says it may. The demo
 *      installer ships a marker file; the customer installer does not. A
 *      restaurant whose books opened with seven years of invented revenue
 *      would be a catastrophe, not a bug.
 *
 *   2. Whatever it wrote, it can take back. `clear()` is the reason the
 *      seeder tracks nothing clever: the demo is the WHOLE tenant, so
 *      clearing it is a defined list of tables emptied in foreign-key order,
 *      not a hunt for rows with a flag on them.
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const log = require('../logger');
const { rng, ymd, _addDays } = require('./lib');
const catalogue = require('./catalogue');
const trading = require('./trading');

const PARTS = ['inventory', 'guests', 'delivery', 'platform', 'system', 'bugun'];

/** The demo build carries this file; the customer build does not. */
const MARKER = path.join(__dirname, '..', '..', 'DEMO-BUILD');
function isDemoBuild() {
  return process.env.NOKTAPP_DEMO === '1' || fs.existsSync(MARKER);
}

/* ------------------------------------------------------------------ state */

/**
 * Is there demo data in this database, and how much?
 *
 * The flag is a settings row rather than a count, because "no orders" is also
 * true of a demo that has been cleared, and the Ayarlar screen has to be able
 * to tell "cleared" from "never seeded" - one of them offers a button.
 */
async function status(clientId) {
  const seededAt = await db.getSetting('demo_seeded_at', null);
  const orders = Number(await db.value(
    'SELECT COUNT(*) FROM orders WHERE client_id=?', [clientId]) || 0);
  const from = await db.value('SELECT MIN(business_date) FROM orders WHERE client_id=?', [clientId]);
  const to = await db.value('SELECT MAX(business_date) FROM orders WHERE client_id=?', [clientId]);
  return {
    demo_build: isDemoBuild(),
    seeded: !!seededAt,
    seeded_at: seededAt,
    orders,
    from: from ? ymd(new Date(from)) : null,
    to: to ? ymd(new Date(to)) : null,
  };
}

/* ------------------------------------------------------------------- seed */

/**
 * The change-log triggers are dropped for the duration.
 *
 * app_change_log is the handheld's replication cursor: every order, line and
 * payment written to this database appends a row to it. Seven years of
 * trading would append half a million rows that describe changes no phone was
 * ever going to pull, take several minutes to write, and leave the sync
 * cursor pointing at a history that is not worth replaying - a phone pairing
 * afterwards asks for a full snapshot anyway.
 */
const LOG_TRIGGERS = [
  ['trg_orders_ai', 'orders', 'AFTER INSERT'], ['trg_orders_au', 'orders', 'AFTER UPDATE'],
  ['trg_items_ai', 'order_items', 'AFTER INSERT'], ['trg_items_au', 'order_items', 'AFTER UPDATE'],
  ['trg_items_ad', 'order_items', 'AFTER DELETE'],
  ['trg_pay_ai', 'order_payments', 'AFTER INSERT'], ['trg_pay_au', 'order_payments', 'AFTER UPDATE'],
  ['trg_pay_ad', 'order_payments', 'AFTER DELETE'],
];

async function withoutChangeLog(fn) {
  const saved = [];
  for (const [name] of LOG_TRIGGERS) {
    const row = await db.one(
      'SELECT action_statement, action_timing, event_manipulation, event_object_table ' +
      'FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name=?', [name]);
    if (row) { saved.push([name, row]); await db.exec('DROP TRIGGER IF EXISTS `' + name + '`'); }
  }
  try {
    return await fn();
  } finally {
    for (const [name, row] of saved) {
      try {
        await db.exec(`CREATE TRIGGER \`${name}\` ${row.action_timing} ${row.event_manipulation} ` +
          `ON \`${row.event_object_table}\` FOR EACH ROW ${row.action_statement}`);
      } catch (e) { log.warn('demo', 'Tetikleyici geri konulamadı: ' + name, e.message); }
    }
  }
}

/**
 * Fill the database.
 *
 * `onProgress(step, text)` is called as each stage finishes so the installer
 * can say something other than a frozen window: seven years is a minute or
 * two of inserts and silence reads as a hang.
 */
async function seed(clientId, { onProgress = null, from = '2020-01-01', to = null,
                                replace = false } = {}) {
  const already = await db.getSetting('demo_seeded_at', null);
  if (already && !replace) { const e = new Error('Demo verisi zaten yüklü'); e.status = 409; throw e; }

  /*
   * Seeding always begins by emptying the tenant (see wipe() below), so on a
   * till that already has bills this is a DESTRUCTIVE act, not an additive
   * one. `replace` is the caller saying it knows that. Nothing sets it except
   * the button on the Demo verisi screen, which asks for the owner's password
   * and makes them type the word first.
   */
  /*
   * A seed onto a till that has anything on it is a deletion, and a deletion
   * with no way back is how somebody loses an afternoon of typing a menu in.
   * The snapshot costs seconds and is the only thing standing between a
   * mis-click and "we set it all up again".
   */
  if (replace) {
    try {
      const snap = await require('../backup').run('demo-oncesi');
      log.warn('demo', 'Demo yüklemesi öncesi yedek alındı', { file: snap && snap.file });
    } catch (e) {
      log.warn('demo', 'Demo öncesi yedek alınamadı, yükleme sürüyor: ' + e.message);
    }
  }

  if (!replace) {
    const bills = Number(await db.value('SELECT COUNT(*) FROM orders WHERE client_id=?', [clientId]) || 0);
    if (bills) {
      const e = new Error('Bu veritabanında zaten ' + bills + ' adisyon var. ' +
        'Demo verisi yüklemek mevcut kayıtları siler.');
      e.status = 409; e.code = 'NOT_EMPTY'; throw e;
    }
  }

  const started = Date.now();
  const today = to ? new Date(to + 'T00:00:00') : new Date();
  today.setHours(0, 0, 0, 0);

  const steps = [];
  const ctx = {
    db, clientId,
    start: new Date(from + 'T00:00:00'),
    today,
    rand: rng(20200101),
    log: (msg) => { steps.push(msg); log.info('demo', msg); if (onProgress) onProgress(steps.length, msg); },
  };

  log.info('demo', 'Demo verisi yükleniyor', { from, to: ymd(today) });

  /*
   * A fresh install is not empty: 03_seed.sql leaves a default station, a
   * category and a table behind so the setup wizard has something to show.
   * Seeding on top of them collides on the unique keys, and keeping them
   * would put a stray "Mutfak" next to the demo's own. So the tenant is
   * emptied first - the same list `clear()` uses, which is also what makes
   * seeding repeatable while this is being developed.
   */
  await wipe(clientId, 'hepsi');

  await catalogue.build(ctx);
  await withoutChangeLog(() => trading.build(ctx));

  for (const name of PARTS) {
    let part = null;
    try { part = require('./parts/' + name); } catch (_) { continue; }
    try { await part.build(ctx); }
    catch (e) { log.warn('demo', `Demo bölümü atlandı: ${name} - ${e.message}`); }
  }

  const secs = Math.round((Date.now() - started) / 1000);
  await db.setSetting('demo_seeded_at', new Date().toISOString());
  await db.setSetting('demo_data', '1');
  ctx.log(`tamam - ${secs} saniye`);
  log.info('demo', 'Demo verisi yüklendi', { seconds: secs, orders: ctx.totals && ctx.totals.orders });

  return { ok: true, seconds: secs, steps, ...(await status(clientId)) };
}

/* ------------------------------------------------------------------ clear */

/**
 * Tables emptied by `scope`.
 *
 *   'hareket'  the trading: bills, money, stock movement, logs. The menu, the
 *              floor plan and the staff stay, so the till is immediately
 *              usable - this is what somebody wants after a demonstration.
 *   'hepsi'    everything the seeder wrote, back to a blank installation that
 *              has to go through setup again.
 *
 * Order matters: children before parents, because the foreign keys are real.
 */
const TRANSACTIONAL = [
  'station_projection_items', 'print_jobs',
  'order_item_cancel_events', 'order_delete_logs', 'payment_delete_logs',
  'order_payment_locks', 'order_payments', 'order_discounts', 'order_items',
  'delivery_events', 'delivery_orders', 'courier_shifts',
  'np_int_order_items', 'np_int_orders', 'np_int_events', 'np_int_logs', 'np_int_cursors',
  'fiscal_transaction_events', 'fiscal_transaction_items', 'fiscal_refund_items',
  'fiscal_refunds', 'fiscal_receipts', 'fiscal_transactions', 'fiscal_device_reports',
  'loyalty_events', 'loyalty_qr_tokens', 'loyalty_cards',
  'reservations', 'crm_tasks',
  'inventory_stock_ledger', 'inventory_document_items', 'inventory_documents',
  'inventory_count_items', 'inventory_counts', 'inventory_waste', 'inventory_transfers',
  'product_stock_movements',
  'pos_cash_counts', 'pos_drawer_events', 'pos_shift_movements', 'pos_shifts',
  'daily_closings', 'finance_daily_snapshots', 'daily_costs',
  'app_change_log', 'app_sync_cursors', 'app_sync_ops', 'np_sync_outbox',
  'app_order_counters', 'order_counters',
  'orders',
  'audit_logs', 'deleted_activity_log', 'np_app_log', 'np_mail_queue',
  /*
   * Added after a measurement rather than a hunch: a count of every
   * client-scoped table against these two lists found 34 of them surviving
   * "Her seyi sil". The owner presses it expecting an empty till and gets one
   * that still remembers.
   */
  /*
   * v_waiter_performance is named like a view and is a BASE TABLE - a
   * materialised per-order report. It holds one row per closed bill, so it
   * belongs with the bills, not with the menu.
   */
  'v_waiter_performance',
  'app_device_number_history', 'station_logins',
  'costs', 'crm_messages', 'daily_finance_snapshots',
  'inventory_stock_cache', 'pricing_notifications',
  'np_menu_apply_log', 'np_settings_log',
  'fiscal_attempts', 'fiscal_device_commands', 'fiscal_operations',
  'fiscal_outbox', 'fiscal_provider_logs',
];

const CATALOGUE = [
  'price_change_log', 'product_price_history', 'product_costs', 'pricing_suggestions',
  'product_recipes', 'product_stock',
  'qr_products', 'qr_categories', 'products', 'categories',
  'table_group_members', 'table_groups', 'restaurant_tables', 'table_zones',
  'printers', 'stations',
  'inventory_items', 'inventory_categories', 'inventory_units', 'inventory_locations',
  'suppliers', 'delivery_zones', 'couriers', 'customer_addresses', 'customer_flags',
  'loyalty_programs', 'customers',
  'user_permissions', 'app_device_tokens', 'app_device_numbers', 'np_mobile_pairings',
  'users',
  /*
   * The device's OWN state, and it has to go before fiscal_devices does.
   * Deleting the device row while leaving its departments, VAT codes,
   * capabilities, ownership and evidence behind is how a till wiped clean
   * grows a new OKC that is already armed with somebody else's proof.
   */
  'fiscal_evidence', 'fiscal_device_capabilities', 'fiscal_device_secrets',
  'fiscal_device_ownership', 'fiscal_departments', 'fiscal_vat_codes',
  'fiscal_agent_pairings', 'fiscal_agents',
  'doviz_kur_gecmisi', 'doviz_kurlari', 'cash_registers', 'fiscal_devices',
  'np_int_menu_map', 'np_int_connections',
  /* credentials belong to the users they authenticate */
  'app_passkeys', 'app_remember_tokens',
  'pricing_targets', 'pricing_strategy',
  'qr_menu_assets', 'qr_menu_settings',
  /* "hepsi" promises the setup wizard starts again; it cannot if the
     business it already configured is still on file */
  'business_settings',
];

/*
 * NEVER DELETED, whatever the scope, and each for its own reason:
 *
 *   clients          the restaurant itself. Deleting it does not reset the
 *                    till, it unmakes it.
 *   np_licence       the licence this installation runs on. Wiping demo data
 *                    must never cost somebody their licence.
 *   np_login_cache   what lets the owner sign in when the internet is down -
 *                    the worst possible moment to discover it was cleared.
 *
 * Anything else that is client-scoped and NOT in one of the two lists above
 * is a gap, and test/demoveri.js fails on it by name rather than waiting for
 * an owner to notice.
 */
const NEVER_CLEARED = ['clients', 'np_licence', 'np_login_cache'];

/** The column that scopes a row to this restaurant, or null if there is none. */
async function ownerColumn(table) {
  const rows = await db.query(
    'SELECT column_name AS c FROM information_schema.columns ' +
    "WHERE table_schema=DATABASE() AND table_name=? AND column_name IN ('client_id','created_by_client_id')",
    [table]);
  const names = rows.map(r => String(r.c));
  if (names.includes('client_id')) return 'client_id';
  if (names.includes('created_by_client_id')) return 'created_by_client_id';
  return null;
}

/** Tables this database does not have (they arrive with later migrations). */
async function existing(names) {
  /*
   * BASE TABLE only. information_schema.tables also lists views, and this
   * database has them (v_valid_orders, v_waiter_performance). A DELETE aimed
   * at a view either fails or, worse, succeeds against whatever it is built
   * on.
   */
  const rows = await db.query(
    'SELECT table_name AS t FROM information_schema.tables '
    + "WHERE table_schema=DATABASE() AND table_type='BASE TABLE'");
  const have = new Set(rows.map(r => String(r.t)));
  return names.filter(n => have.has(n) && !NEVER_CLEARED.includes(n));
}

/** The delete itself, without the settings bookkeeping around it. */
async function wipe(clientId, scope) {
  const tables = await existing(
    scope === 'hepsi' ? [...TRANSACTIONAL, ...CATALOGUE] : TRANSACTIONAL);
  let removed = 0;
  await db.exec('SET FOREIGN_KEY_CHECKS=0');
  try {
    for (const t of tables) {
      /*
       * Which column says "mine" is not the same on every table. `customers`
       * is the SHARED guest registry - it has no client_id, and deleting it
       * unfiltered would take out guests another restaurant on the same
       * registry put there. np_app_log and np_display_settings genuinely are
       * per-installation and this installation is one restaurant, so those
       * are the only ones cleared whole.
       */
      const col = await ownerColumn(t);
      const n = col
        ? await db.exec('DELETE FROM `' + t + '` WHERE `' + col + '`=?', [clientId])
        : await db.exec('DELETE FROM `' + t + '`');
      removed += Number(n) || 0;
    }
    await db.exec("UPDATE restaurant_tables SET is_occupied=0, status='empty' WHERE client_id=?", [clientId])
      .catch(() => {});
  } finally {
    await db.exec('SET FOREIGN_KEY_CHECKS=1');
  }
  return { tables: tables.length, rows: removed };
}

async function clear(clientId, { scope = 'hareket', actor = null } = {}) {
  if (!['hareket', 'hepsi'].includes(scope)) {
    const e = new Error('Geçersiz temizleme kapsamı'); e.status = 400; throw e;
  }
  const started = Date.now();
  log.warn('demo', 'Demo verisi siliniyor', { scope, by: actor });

  const { tables, rows: removed } = await wipe(clientId, scope);

  await db.setSetting('demo_seeded_at', '');
  await db.setSetting('demo_data', '0');
  if (scope === 'hepsi') {
    await db.exec('UPDATE clients SET setup_done=0 WHERE client_id=?', [clientId]).catch(() => {});
    await db.setSetting('setup_done', '0');
  }

  const secs = Math.round((Date.now() - started) / 1000);
  log.warn('demo', 'Demo verisi silindi', { scope, rows: removed, seconds: secs });
  return { ok: true, scope, tables, rows: removed, seconds: secs };
}

/**
 * Called once at boot by src/index.js.
 *
 * Seeds only into an installation NOBODY HAS TOUCHED YET, which is a stricter
 * test than it first appears and had to be made stricter once already.
 *
 * The first version asked only "are there any bills". That is wrong, and it
 * cost somebody their setup: a till where the owner had already been through
 * the wizard - named the business, typed the menu, drawn the floor plan,
 * created the staff - but had not yet rung up a single sale has zero bills,
 * and the seeder happily deleted all of it. Their own PIN stopped working,
 * which is how they found out.
 *
 * So the question is not "has it sold anything" but "has a person configured
 * this". `setup_done` is the wizard's own answer to that, and any product or
 * user beyond what the installer ships is a second opinion.
 */
async function seedOnFirstBoot(clientId) {
  if (!isDemoBuild()) return null;
  const s = await status(clientId);
  if (s.seeded || s.orders > 0) return null;

  const setupDone = Number(await db.value(
    'SELECT setup_done FROM clients WHERE client_id=?', [clientId]) || 0)
    || String(await db.getSetting('setup_done', '0')) === '1';
  const products = Number(await db.value(
    'SELECT COUNT(*) FROM products WHERE client_id=?', [clientId]) || 0);
  const staff = Number(await db.value(
    'SELECT COUNT(*) FROM users WHERE client_id=?', [clientId]) || 0);

  if (setupDone || products > 0 || staff > 1) {
    log.info('demo', 'Demo kurulumu: kurulmuş bir kasa bulundu, veri yüklenmedi', {
      setup_done: !!setupDone, products, staff });
    return null;
  }
  log.info('demo', 'Demo kurulumu: veri ilk açılışta yükleniyor');
  return seed(clientId, {});
}

module.exports = { status, seed, clear, wipe, seedOnFirstBoot, isDemoBuild, MARKER,
  TRANSACTIONAL, CATALOGUE, NEVER_CLEARED };
