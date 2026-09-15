'use strict';
/**
 * Entegrasyonlar — everything the screen asks for.
 *
 * The engine (src/integrations/) owns adapters, the pipeline and the workers.
 * This module owns the OWNER'S view of them: connect a platform, map the menu,
 * push the menu up, open and close the restaurant, look at what happened and
 * retry what failed.
 *
 * Two rules run through the whole file.
 *
 *  1. A SECRET NEVER COMES BACK. Credentials go in, are encrypted, and from
 *     then on the screen sees `cred_hint` - "apiKey=abc•••••••xy" - and
 *     nothing else. There is no endpoint that returns a stored secret, not
 *     even to an administrator, because the only reason to read one back is to
 *     copy it somewhere else and the owner already has it.
 *  2. EVERY WRITE IS AUDITED, into the same audit_logs the rest of the till
 *     uses, with the secrets stripped out of the before/after pictures.
 */
const db = require('../db');
const log = require('../logger');
const { money } = require('../util/http');
const registry = require('../integrations/registry');
const crypto = require('../integrations/crypto');
const svc = require('../integrations');
const ingest = require('../integrations/ingest');
const poller = require('../integrations/poller');
const status = require('../integrations/status');
const catalog = require('./catalog');

function bad(msg, code = null, s = 400) { const e = new Error(msg); e.status = s; e.code = code; return e; }

/**
 * What "eşleşmemiş" actually means, in one place.
 *
 * The first version counted every row whose `mapped_by` was 'auto', which is
 * wrong and misleading in the direction that matters: a platform product whose
 * name matches the menu exactly is auto-mapped to the REAL product, sells the
 * real thing and moves the real stock. Calling that unmapped put a permanent
 * orange warning on a screen where nothing was wrong, and the way people deal
 * with a warning that is always on is to stop reading it.
 *
 * A product is unmapped when it has no local counterpart at all, or when its
 * counterpart is one of the placeholders ingest.js creates in the hidden
 * "Entegrasyon" category - which is exactly the case where stock and reçete do
 * not work and somebody does need to act.
 */
async function unmappedRows(clientId, provider, branchId) {
  return db.query(
    `SELECT m.* FROM np_int_menu_map m
       LEFT JOIN products p ON p.id=m.local_id AND p.client_id=m.client_id
       LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
      WHERE m.client_id=? AND m.provider=? AND m.branch_id=? AND m.entity_type='product'
        AND (m.local_id IS NULL OR c.name='Entegrasyon')
      ORDER BY m.external_name`, [clientId, provider, branchId]);
}

async function audit(clientId, actorId, action, entityId, before, after) {
  try {
    await db.exec(
      `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id,
          before_json, after_json, created_at) VALUES (?,?,?,?,?,?,?,?,NOW())`,
      [clientId, actorId || 0, 'admin', action, 'integration', String(entityId),
       before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
  } catch (e) { log.warn('entegrasyon', 'audit yazilamadi', e.message); }
}

/* ==================================================================== *
 * 1. CONNECTIONS                                                       *
 * ==================================================================== */

/** Rows for every provider, connected or not, with nothing secret in them. */
async function overview(clientId, branchId = 1) {
  const rows = await db.query('SELECT * FROM np_int_connections WHERE client_id=? AND branch_id=?', [clientId, branchId]);
  const byProvider = Object.fromEntries(rows.map(r => [r.provider, r]));
  const cards = [];
  for (const d of registry.catalogue()) {
    const c = byProvider[d.key] || null;
    const h = c ? await svc.health(clientId, d.key, branchId).catch(e => ({ error: e.message })) : null;
    const unmapped = c ? (await unmappedRows(clientId, d.key, branchId)).length : 0;
    cards.push({
      ...d,
      connected: !!c,
      id: c ? c.id : null,
      enabled: c ? !!c.enabled : false,
      environment: c ? c.environment : d.defaultEnvironment,
      state: c ? (c.enabled ? c.status : 'disconnected') : 'disconnected',
      provider_store_id: c ? c.provider_store_id : '',
      supplier_id: c ? c.supplier_id : '',
      chain_id: c ? c.chain_id : '',
      acceptance_mode: c ? c.acceptance_mode : 'PROVIDER_TABLET',
      auto_accept: c ? !!c.auto_accept : false,
      default_prep_minutes: c ? c.default_prep_minutes : 20,
      delivery_minutes: c ? c.delivery_minutes : 40,
      poll_interval_sec: c ? c.poll_interval_sec : 7,
      station_id: c ? c.station_id : null,
      receipt_station_id: c ? c.receipt_station_id : null,
      restaurant_open: c ? !!c.restaurant_open : true,
      cred_hint: c ? c.cred_hint : null,
      last_ok_at: c ? c.last_ok_at : null,
      last_sync_at: c ? c.last_sync_at : null,
      last_error: c ? c.last_error : null,
      last_error_at: c ? c.last_error_at : null,
      unmapped_products: unmapped,
      health: h,
    });
  }
  const queue = await db.one(
    `SELECT SUM(status IN ('new','failed')) pending, SUM(status='dead') dead FROM np_int_events WHERE client_id=?`,
    [clientId]);
  return {
    branch_id: branchId,
    providers: cards,
    queue: { pending: Number((queue && queue.pending) || 0), dead: Number((queue && queue.dead) || 0) },
    master_key_from_environment: crypto.keyFromEnvironment(),
    master_key_source: crypto.keySource(),
    statuses: status.STATUSES.map(s => ({ key: s, label: status.LABELS[s] })),
  };
}

/**
 * Save a connection.
 *
 * Secrets are merged, not replaced: a form posted with an empty "API gizli
 * anahtarı" means "leave it alone", because the screen cannot show the current
 * value and therefore cannot re-post it. Clearing a secret is an explicit
 * empty-string with `clear_<key>` set, so it is never an accident.
 */
async function saveConnection(clientId, provider, data = {}, actorId = null, branchId = 1) {
  const d = registry.def(provider);
  if (!d) throw bad('Bilinmeyen platform: ' + provider);
  const existing = await svc.connection(clientId, provider, branchId);
  const current = existing ? await svc.credentials(existing).catch(() => ({})) : {};

  const creds = { ...current };
  for (const f of d.fields.filter(x => x.secret)) {
    const v = data[f.key];
    if (data['clear_' + f.key]) { delete creds[f.key]; continue; }
    if (v !== undefined && String(v).trim() !== '') creds[f.key] = String(v);
  }
  /* Non-secret credential extras - base addresses, the endpoint table, a
     status map override - are replaced wholesale when they are sent. */
  for (const f of d.fields.filter(x => !x.secret && !x.column)) {
    if (data[f.key] !== undefined) creds[f.key] = data[f.key] === '' ? undefined : String(data[f.key]);
  }
  if (data.paths !== undefined) creds.paths = data.paths || {};
  if (data.statusMap !== undefined) creds.statusMap = data.statusMap || {};
  if (data.rejectReasons !== undefined) creds.rejectReasons = data.rejectReasons || undefined;
  for (const k of Object.keys(creds)) if (creds[k] === undefined) delete creds[k];

  const env = data.environment && d.environments.includes(data.environment) ? data.environment
    : (existing ? existing.environment : d.defaultEnvironment);
  const accept = ['PROVIDER_TABLET', 'POS_DIRECT'].includes(data.acceptance_mode)
    ? data.acceptance_mode : (existing ? existing.acceptance_mode : 'PROVIDER_TABLET');

  const cols = {
    provider_store_id: pickCol(data, existing, 'provider_store_id'),
    supplier_id: pickCol(data, existing, 'supplier_id'),
    chain_id: pickCol(data, existing, 'chain_id'),
    environment: env,
    acceptance_mode: accept,
    auto_accept: bool(data.auto_accept, existing ? existing.auto_accept : 0),
    default_prep_minutes: clamp(data.default_prep_minutes, existing ? existing.default_prep_minutes : 20, 1, 240),
    delivery_minutes: clamp(data.delivery_minutes, existing ? existing.delivery_minutes : 40, 1, 240),
    poll_interval_sec: poller.clampInterval(data.poll_interval_sec !== undefined
      ? data.poll_interval_sec : (existing ? existing.poll_interval_sec : 7)),
    station_id: numOrNull(data.station_id, existing ? existing.station_id : null),
    receipt_station_id: numOrNull(data.receipt_station_id, existing ? existing.receipt_station_id : null),
  };

  /* Required fields are checked only when the connection is being taken out of
     simulation - a restaurant is allowed to save a half-filled form and come
     back to it, and refusing that is how a settings screen becomes a wall. */
  if (env !== 'simulator') {
    for (const f of d.fields.filter(x => x.required)) {
      const v = f.column ? cols[f.column] : creds[f.key];
      if (!v || !String(v).trim()) throw bad(`"${f.label}" zorunludur.`, 'MISSING_FIELD');
    }
  }

  const enc = await crypto.encrypt(creds);
  const hint = crypto.hint(Object.fromEntries(Object.entries(creds)
    .filter(([k, v]) => typeof v === 'string' && d.fields.find(f => f.key === k && f.secret))));

  let id;
  if (existing) {
    await db.exec(
      `UPDATE np_int_connections SET credentials_enc=?, cred_hint=?, provider_store_id=?, supplier_id=?,
          chain_id=?, environment=?, acceptance_mode=?, auto_accept=?, default_prep_minutes=?,
          delivery_minutes=?, poll_interval_sec=?, station_id=?, receipt_station_id=?, updated_at=NOW()
        WHERE id=? AND client_id=?`,
      [enc, hint, cols.provider_store_id, cols.supplier_id, cols.chain_id, cols.environment,
       cols.acceptance_mode, cols.auto_accept, cols.default_prep_minutes, cols.delivery_minutes,
       cols.poll_interval_sec, cols.station_id, cols.receipt_station_id, existing.id, clientId]);
    id = existing.id;
  } else {
    id = await db.insert(
      `INSERT INTO np_int_connections (client_id, branch_id, provider, credentials_enc, cred_hint,
          provider_store_id, supplier_id, chain_id, environment, acceptance_mode, auto_accept,
          default_prep_minutes, delivery_minutes, poll_interval_sec, station_id, receipt_station_id,
          enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NOW(),NOW())`,
      [clientId, branchId, provider, enc, hint, cols.provider_store_id, cols.supplier_id, cols.chain_id,
       cols.environment, cols.acceptance_mode, cols.auto_accept, cols.default_prep_minutes,
       cols.delivery_minutes, cols.poll_interval_sec, cols.station_id, cols.receipt_station_id]);
  }
  await audit(clientId, actorId, 'integration.save', provider,
    existing ? safeRow(existing) : null, safeRow(await svc.connectionById(clientId, id)));
  await ingest.logLine(clientId, { provider, branchId, action: 'connection',
    message: (existing ? 'Bağlantı güncellendi' : 'Bağlantı oluşturuldu') + ' · ortam: ' + env });
  return { id, saved: true };
}

function pickCol(data, existing, col) {
  if (data[col] !== undefined) return String(data[col] || '').slice(0, 64);
  return existing ? existing[col] : '';
}
function bool(v, dflt) { if (v === undefined) return dflt ? 1 : 0; return (v === true || v === 1 || v === '1') ? 1 : 0; }
function clamp(v, dflt, lo, hi) { const n = Number(v); if (!Number.isFinite(n)) return dflt; return Math.min(hi, Math.max(lo, Math.round(n))); }
function numOrNull(v, dflt) { if (v === undefined) return dflt; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

/** A connection row with the encrypted blob taken out, safe to audit or return. */
function safeRow(c) {
  if (!c) return null;
  const { _credentials_enc, ...rest } = c;      // eslint-disable-line camelcase
  return rest;
}

async function setEnabled(clientId, provider, enabled, actorId = null, branchId = 1) {
  const conn = await svc.connection(clientId, provider, branchId);
  if (!conn) throw bad('Önce bağlantı bilgilerini kaydedin', 'NOT_CONFIGURED', 409);
  const d = registry.def(provider);
  if (enabled && d.guard) {
    const why = d.guard(conn, await svc.credentials(conn).catch(() => ({})));
    if (why) throw bad(why, 'LEGACY_DISABLED', 409);
  }
  await db.exec('UPDATE np_int_connections SET enabled=?, status=?, updated_at=NOW() WHERE id=?',
    [enabled ? 1 : 0, enabled ? 'connected' : 'disconnected', conn.id]);
  await audit(clientId, actorId, enabled ? 'integration.enable' : 'integration.disable', provider,
    { enabled: !!conn.enabled }, { enabled: !!enabled });
  await ingest.logLine(clientId, { provider, branchId, action: 'connection',
    message: enabled ? 'Bağlantı açıldı' : 'Bağlantı kapatıldı' });
  return { enabled: !!enabled };
}

async function testConnection(clientId, provider, branchId = 1, actorId = null) {
  const a = await svc.adapterFor(clientId, provider, branchId);
  const r = await a.call('testConnection', {});
  const conn = await svc.connection(clientId, provider, branchId);
  await db.exec(
    `UPDATE np_int_connections SET status=?, last_ok_at=IF(?,NOW(),last_ok_at), last_error=?, last_error_at=IF(?,NULL,NOW())
      WHERE id=?`,
    [r.ok ? 'connected' : 'error', r.ok ? 1 : 0, r.ok ? null : String(r.message).slice(0, 500), r.ok ? 1 : 0, conn.id]);
  await ingest.logLine(clientId, { provider, branchId, level: r.ok ? 'info' : 'error', action: 'test',
    message: r.ok ? ('Bağlantı testi başarılı: ' + (r.message || '')) : ('Bağlantı testi başarısız: ' + r.message) });
  await audit(clientId, actorId, 'integration.test', provider, null, { ok: r.ok, code: r.code || null });
  return r;
}

async function setRestaurantOpen(clientId, provider, open, actorId = null, branchId = 1) {
  const a = await svc.adapterFor(clientId, provider, branchId);
  const r = await a.call('setRestaurantOpen', { open: !!open });
  if (r.ok || r.code === 'CAPABILITY_NOT_SUPPORTED') {
    await db.exec('UPDATE np_int_connections SET restaurant_open=?, updated_at=NOW() WHERE client_id=? AND provider=? AND branch_id=?',
      [open ? 1 : 0, clientId, provider, branchId]);
  }
  await audit(clientId, actorId, 'integration.restaurant_open', provider, null, { open: !!open, ok: r.ok });
  await ingest.logLine(clientId, { provider, branchId, level: r.ok ? 'info' : 'warn', action: 'open',
    message: (open ? 'Restoran açıldı' : 'Restoran kapatıldı') + (r.ok ? '' : ' (platforma bildirilemedi: ' + r.message + ')') });
  return r;
}

async function setPrepTime(clientId, provider, minutes, actorId = null, branchId = 1) {
  const m = clamp(minutes, 20, 1, 240);
  const a = await svc.adapterFor(clientId, provider, branchId);
  const r = await a.call('updatePrepTime', { minutes: m });
  await db.exec('UPDATE np_int_connections SET default_prep_minutes=?, updated_at=NOW() WHERE client_id=? AND provider=? AND branch_id=?',
    [m, clientId, provider, branchId]);
  await audit(clientId, actorId, 'integration.prep_time', provider, null, { minutes: m, ok: r.ok });
  return { minutes: m, remote: r };
}

/* ==================================================================== *
 * 2. MENU MAPPING                                                      *
 * ==================================================================== */

/**
 * The mapping screen's whole data set: what we sell, what the platform sells,
 * and which of them are the same thing.
 *
 * The provider side comes from the adapter when the platform can be asked and
 * from the simulator otherwise, so the screen is usable long before anybody
 * has issued a key - which is the point, because mapping 300 products is the
 * slow part of going live and it should not have to wait for credentials.
 */
async function mapping(clientId, provider, branchId = 1) {
  const conn = await svc.connection(clientId, provider, branchId);
  if (!conn) throw bad('Önce bağlantı bilgilerini kaydedin', 'NOT_CONFIGURED', 409);
  const posMenu = await catalog.menu(clientId);
  const products = [];
  for (const c of posMenu) for (const p of c.products) products.push({ ...p, category_name: c.name });
  const rows = await db.query(
    'SELECT * FROM np_int_menu_map WHERE client_id=? AND provider=? AND branch_id=? ORDER BY entity_type, external_name',
    [clientId, provider, branchId]);

  let providerMenu = { categories: [], products: [], modifierGroups: [] };
  try {
    const sim = require('../integrations/simulator');
    providerMenu = sim.providerCatalogue(provider, conn.provider_store_id);
  } catch (_) { /* the simulator is the only catalogue source we have offline */ }

  const byExternal = Object.fromEntries(rows.map(r => [r.entity_type + '|' + r.external_id, r]));
  const decorate = (list, type) => list.map(x => {
    const m = byExternal[type + '|' + x.id];
    return { ...x, local_id: m ? m.local_id : null, mapped_by: m ? m.mapped_by : null,
      local_name: m && m.local_id ? (products.find(p => p.id === m.local_id) || {}).name || null : null };
  });

  const modifiers = [];
  for (const g of providerMenu.modifierGroups || []) {
    for (const m of g.modifiers || []) modifiers.push({ ...m, groupId: g.id, groupName: g.name });
  }

  return {
    provider, branch_id: branchId,
    connection: safeRow(conn),
    pos: { categories: posMenu.map(c => ({ id: c.id, name: c.name })), products },
    provider_menu: {
      categories: decorate(providerMenu.categories || [], 'category'),
      products: decorate(providerMenu.products || [], 'product'),
      modifier_groups: (providerMenu.modifierGroups || []).map(g => ({ ...g,
        ...(byExternal['modifier_group|' + g.id] ? { local_id: byExternal['modifier_group|' + g.id].local_id } : {}) })),
      modifiers: decorate(modifiers, 'modifier'),
    },
    /* Only the ones that genuinely have no counterpart, or whose counterpart is
       a placeholder - see unmappedRows. */
    unmapped: (await unmappedRows(clientId, provider, branchId))
      .map(r => ({ external_id: r.external_id, external_name: r.external_name,
        local_id: r.local_id, provider_price: r.provider_price })),
    map: rows,
  };
}

/** Normalise a name so "Adana Kebap" and "ADANA KEBAP " match. */
function fold(s) {
  return String(s || '').toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Automatic mapping, by name, and only where it is unambiguous.
 *
 * A fuzzy match that is nearly right is worse than no match at all: it sells
 * the wrong thing at the wrong price and nobody notices until the stock count.
 * So: exact folded name only, and a name that matches TWO products is left
 * unmapped for a person to decide.
 */
async function autoMap(clientId, provider, branchId = 1, actorId = null) {
  const data = await mapping(clientId, provider, branchId);
  const byName = new Map();
  for (const p of data.pos.products) {
    const k = fold(p.name);
    byName.set(k, byName.has(k) ? null : p);       // null marks "ambiguous"
  }
  let mapped = 0; let ambiguous = 0; let missed = 0;
  for (const ext of data.provider_menu.products) {
    if (ext.local_id) continue;
    const hit = byName.get(fold(ext.name));
    if (hit === null) { ambiguous++; continue; }
    if (!hit) { missed++; continue; }
    await setMapping(clientId, provider, 'product', ext.id, hit.id,
      { externalName: ext.name, price: ext.price, branchId, actorId, by: 'auto' });
    mapped++;
  }
  /* Modifiers too - "Ayran" as a modifier and "Ayran" as a product are the
     same thing to a kitchen and to the stock ledger. */
  for (const ext of data.provider_menu.modifiers) {
    if (ext.local_id) continue;
    const hit = byName.get(fold(ext.name));
    if (!hit) continue;
    await setMapping(clientId, provider, 'modifier', ext.id, hit.id,
      { externalName: ext.name, price: ext.price, branchId, actorId, by: 'auto' });
    mapped++;
  }
  await ingest.logLine(clientId, { provider, branchId, action: 'map',
    message: `Otomatik eşleştirme: ${mapped} eşleşti, ${ambiguous} belirsiz, ${missed} karşılıksız` });
  return { mapped, ambiguous, missed };
}

async function setMapping(clientId, provider, entityType, externalId, localId,
  { externalName = null, price = null, branchId = 1, actorId = null, by = 'manual' } = {}) {
  if (!['branch', 'category', 'product', 'modifier_group', 'modifier'].includes(entityType)) {
    throw bad('Bilinmeyen eşleştirme türü: ' + entityType);
  }
  if (localId) {
    const table = entityType === 'category' ? 'categories' : 'products';
    if (entityType === 'product' || entityType === 'modifier' || entityType === 'category') {
      const found = await db.one(`SELECT id FROM ${table} WHERE id=? AND client_id=?`, [localId, clientId]);
      if (!found) throw bad('Kayıt bulunamadı ya da bu işletmeye ait değil', 'NOT_FOUND', 404);
    }
  }
  await db.exec(
    `INSERT INTO np_int_menu_map (client_id, branch_id, provider, entity_type, external_id, external_name,
        local_id, provider_price, mapped_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,NOW(),NOW())
     ON DUPLICATE KEY UPDATE local_id=VALUES(local_id), external_name=COALESCE(VALUES(external_name), external_name),
        provider_price=COALESCE(VALUES(provider_price), provider_price), mapped_by=VALUES(mapped_by), updated_at=NOW()`,
    [clientId, branchId, provider, entityType, String(externalId), externalName,
     localId || null, price === null ? null : money(price), by]);
  if (by === 'manual') {
    await audit(clientId, actorId, 'integration.map', provider, null,
      { entityType, externalId, localId, branchId });
    await ingest.logLine(clientId, { provider, branchId, action: 'map',
      message: `Eşleştirildi: ${entityType} ${externalName || externalId} → #${localId || '-'}` });
  }
  return { mapped: true };
}

/* ==================================================================== *
 * 3. MENU SYNC AND AVAILABILITY                                        *
 * ==================================================================== */

/** The catalogue we send up: the till's menu, expressed in the mapping. */
async function buildCatalogue(clientId, provider, branchId = 1) {
  const menu = await catalog.menu(clientId);
  const maps = await db.query(
    'SELECT * FROM np_int_menu_map WHERE client_id=? AND provider=? AND branch_id=?', [clientId, provider, branchId]);
  const extOf = (type, localId) => {
    const m = maps.find(x => x.entity_type === type && x.local_id === localId);
    return m ? m.external_id : null;
  };
  const categories = [];
  const products = [];
  for (const c of menu) {
    /* A category with no external id is still sent - the platform's catalogue
       import creates what it does not have, and refusing to send an unmapped
       category is how half a menu goes up. The local id is the fallback
       external key, which also makes the round trip stable. */
    categories.push({ externalId: extOf('category', c.id) || ('NOK-C-' + c.id), name: c.name, sortOrder: c.sort_order });
    for (const p of c.products) {
      products.push({
        externalId: extOf('product', p.id) || ('NOK-P-' + p.id),
        categoryId: extOf('category', c.id) || ('NOK-C-' + c.id),
        name: p.name, price: money(p.price), vatRate: Number(p.vat_rate),
        description: p.description || null,
        available: p.track_stock ? Number(p.stock) > 0 : true,
      });
    }
  }
  /*
   * A provider nobody has connected - or a provider that does not exist,
   * because the name comes off the address bar - has no connection row, and
   * this used to read provider_store_id straight off null: HTTP 500 and
   * "Cannot read properties of null" on the screen where the owner is trying
   * to work out why the platform is not connected. It is a 404 with a
   * sentence in it instead.
   */
  const conn = await svc.connection(clientId, provider, branchId);
  if (!conn) {
    const e = new Error(`${provider} bu şube için bağlı değil. Önce Entegrasyonlar ekranından bağlayın.`);
    e.status = 404; e.code = 'NOT_CONNECTED'; throw e;
  }
  return { branchId, storeId: conn.provider_store_id, categories, products, modifierGroups: [] };
}

async function syncMenu(clientId, provider, branchId = 1, actorId = null) {
  const a = await svc.adapterFor(clientId, provider, branchId);
  const catalogue = await buildCatalogue(clientId, provider, branchId);
  const r = await a.call('syncMenu', { catalogue });
  await db.exec('UPDATE np_int_connections SET last_sync_at=NOW() WHERE client_id=? AND provider=? AND branch_id=?',
    [clientId, provider, branchId]);
  await audit(clientId, actorId, 'integration.menu_sync', provider, null,
    { categories: catalogue.categories.length, products: catalogue.products.length, ok: r.ok });
  await ingest.logLine(clientId, { provider, branchId, level: r.ok ? 'info' : 'error', action: 'menu',
    message: r.ok ? `Menü gönderildi: ${catalogue.products.length} ürün, ${catalogue.categories.length} kategori`
      : 'Menü gönderilemedi: ' + r.message });
  return { ...r, counts: { categories: catalogue.categories.length, products: catalogue.products.length } };
}

async function setProductAvailability(clientId, provider, productId, available, actorId = null, branchId = 1) {
  const m = await db.one(
    `SELECT * FROM np_int_menu_map WHERE client_id=? AND provider=? AND branch_id=? AND entity_type='product' AND local_id=?`,
    [clientId, provider, branchId, productId]);
  const externalId = m ? m.external_id : 'NOK-P-' + productId;
  const a = await svc.adapterFor(clientId, provider, branchId);
  const r = await a.call('updateProductAvailability', { items: [{ externalId, available: !!available }] });
  if (m) {
    await db.exec('UPDATE np_int_menu_map SET is_available=?, updated_at=NOW() WHERE id=?', [available ? 1 : 0, m.id]);
  }
  await audit(clientId, actorId, 'integration.availability', provider, null, { productId, available: !!available, ok: r.ok });
  await ingest.logLine(clientId, { provider, branchId, level: r.ok ? 'info' : 'warn', action: 'availability',
    message: `Ürün #${productId} ${available ? 'açıldı' : 'kapatıldı'}` + (r.ok ? '' : ' (platform: ' + r.message + ')') });
  return r;
}

async function setCategoryAvailability(clientId, provider, categoryId, available, actorId = null, branchId = 1) {
  const m = await db.one(
    `SELECT * FROM np_int_menu_map WHERE client_id=? AND provider=? AND branch_id=? AND entity_type='category' AND local_id=?`,
    [clientId, provider, branchId, categoryId]);
  const externalId = m ? m.external_id : 'NOK-C-' + categoryId;
  const a = await svc.adapterFor(clientId, provider, branchId);
  const r = await a.call('updateCategoryAvailability', { items: [{ externalId, available: !!available }] });
  await audit(clientId, actorId, 'integration.availability', provider, null, { categoryId, available: !!available, ok: r.ok });
  return r;
}

async function updatePrice(clientId, provider, productId, price, actorId = null, branchId = 1) {
  const m = await db.one(
    `SELECT * FROM np_int_menu_map WHERE client_id=? AND provider=? AND branch_id=? AND entity_type='product' AND local_id=?`,
    [clientId, provider, branchId, productId]);
  const externalId = m ? m.external_id : 'NOK-P-' + productId;
  const a = await svc.adapterFor(clientId, provider, branchId);
  const r = await a.call('updateProductPrice', {
    items: [{ externalId, price: money(price) }],
    catalogue: await buildCatalogue(clientId, provider, branchId),
  });
  if (m) await db.exec('UPDATE np_int_menu_map SET provider_price=?, updated_at=NOW() WHERE id=?', [money(price), m.id]);
  await audit(clientId, actorId, 'integration.price', provider, null, { productId, price: money(price), ok: r.ok });
  return r;
}

/* ==================================================================== *
 * 4. ORDERS, LOGS, RETRIES                                             *
 * ==================================================================== */

async function orderList(clientId, { provider = null, state = null, limit = 60, offset = 0, branchId = 1 } = {}) {
  const where = ['o.client_id=?', 'o.branch_id=?'];
  const args = [clientId, branchId];
  if (provider) { where.push('o.provider=?'); args.push(provider); }
  if (state) { where.push('o.status=?'); args.push(state); }
  const rows = await db.query(
    `SELECT o.id, o.provider, o.provider_store_id, o.external_order_id, o.external_no, o.source_application,
            o.status, o.provider_status, o.acceptance_mode, o.fulfillment_type, o.payment_type, o.is_prepaid,
            o.provider_total, o.delivery_charge, o.promotion_total, o.coupon_total, o.customer_label,
            o.customer_phone, o.address_label, o.customer_note, o.scheduled_at, o.prep_minutes,
            o.unmapped_count, o.accept_print_job_id, o.cancel_print_job_id, o.reprint_count,
            o.received_at, o.accepted_at, o.closed_at, o.order_id,
            b.adisyon_no, b.grand_total, b.status AS bill_status, b.is_deleted AS bill_deleted
       FROM np_int_orders o
       LEFT JOIN orders b ON b.id=o.order_id AND b.client_id=o.client_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.id DESC LIMIT ? OFFSET ?`, [...args, Number(limit) || 60, Number(offset) || 0]);
  const total = Number(await db.value(
    `SELECT COUNT(*) FROM np_int_orders o WHERE ${where.join(' AND ')}`, args));
  return { rows: rows.map(r => ({ ...r, status_label: status.LABELS[r.status] || r.status })), total, limit: Number(limit) || 60, offset: Number(offset) || 0 };
}

async function orderDetail(clientId, mirrorId) {
  const m = await svc.mirror(clientId, mirrorId);
  const items = await db.query('SELECT * FROM np_int_order_items WHERE int_order_id=? ORDER BY id', [m.id]);
  const events = await db.query(
    `SELECT id, source, event_type, status, attempts, last_error, created_at, processed_at
       FROM np_int_events WHERE client_id=? AND provider=? AND external_order_id=? ORDER BY id DESC LIMIT 30`,
    [clientId, m.provider, m.external_order_id]);
  const logs = await db.query(
    `SELECT id, level, action, message, actor, created_at FROM np_int_logs
      WHERE client_id=? AND external_order_id=? ORDER BY id DESC LIMIT 50`, [clientId, m.external_order_id]);
  let bill = null;
  if (m.order_id) {
    const orders = require('./orders');
    bill = await orders.getOrder(clientId, m.order_id).catch(() => null);
  }
  /* raw_json is the platform's own body and it can contain the guest's real
     address. It is returned only on the DETAIL call, which is permissioned,
     and never in the list. */
  return { order: { ...m, status_label: status.LABELS[m.status] || m.status },
    items, events, logs, bill,
    allowed: status.NEXT[m.status] || [] };
}

async function logList(clientId, { provider = null, level = null, action = null, limit = 100, offset = 0 } = {}) {
  const where = ['client_id=?']; const args = [clientId];
  if (provider) { where.push('provider=?'); args.push(provider); }
  if (level) { where.push('level=?'); args.push(level); }
  if (action) { where.push('action=?'); args.push(action); }
  const rows = await db.query(
    `SELECT * FROM np_int_logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...args, Number(limit) || 100, Number(offset) || 0]);
  const total = Number(await db.value(`SELECT COUNT(*) FROM np_int_logs WHERE ${where.join(' AND ')}`, args));
  return { rows, total, limit: Number(limit) || 100, offset: Number(offset) || 0 };
}

/** The dead-letter shelf and everything still waiting. */
async function eventList(clientId, { state = null, provider = null, limit = 60 } = {}) {
  const where = ['client_id=?']; const args = [clientId];
  if (state) { where.push('status=?'); args.push(state); }
  if (provider) { where.push('provider=?'); args.push(provider); }
  const rows = await db.query(
    `SELECT id, provider, source, event_type, external_order_id, external_package_id, status, attempts,
            signature_ok, last_error, created_at, processed_at
       FROM np_int_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
    [...args, Number(limit) || 60]);
  return { rows };
}

async function retryEvent(clientId, eventId, actorId = null) {
  const out = await ingest.retryEvent(clientId, eventId);
  await audit(clientId, actorId, 'integration.retry', eventId, null, out);
  await ingest.logLine(clientId, { action: 'retry', message: 'Olay elle yeniden denendi: #' + eventId });
  return out;
}

async function retryAllFailed(clientId, actorId = null) {
  const n = await db.exec(
    "UPDATE np_int_events SET status='new', attempts=0, last_error=NULL WHERE client_id=? AND status IN ('failed','dead')",
    [clientId]);
  const out = await ingest.drainEvents(100);
  await audit(clientId, actorId, 'integration.retry_all', 'events', null, { requeued: n, ...out });
  await ingest.logLine(clientId, { action: 'retry', message: `${n} başarısız olay yeniden kuyruğa alındı` });
  return { requeued: n, ...out };
}

async function reprint(clientId, mirrorId, actor = null) {
  const m = await svc.mirror(clientId, mirrorId);
  return ingest.reprint(clientId, m, actor);
}

/** Force one poll now, so "Şimdi çek" means something on the screen. */
/**
 * Put a demonstration order into the simulator and pull it straight in.
 *
 * WHY THIS EXISTS, and why it is not a cheat.
 *
 * Three of the four platforms will not issue credentials to anyone without a
 * signed restaurant agreement, and none of them runs a public sandbox. So
 * until a restaurant's own partner pack arrives, the integration is a screen
 * with nothing behind it and there is no honest way to show that it works -
 * which is indistinguishable, to the person looking at it, from a product
 * that has no integration at all.
 *
 * This routes a real order through the REAL pipeline: the same normalise, the
 * same idempotency keys, the same adisyon, the same kitchen slip, the same
 * Paket Servis board. Only the counterparty is stood in for.
 *
 * IT REFUSES TO RUN ON A LIVE CONNECTION. `environment` must be `simulator`.
 * A demonstration order landing in a real restaurant's takings - and, worse,
 * being acknowledged back to a real platform - is exactly the kind of thing
 * that gets a POS vendor's integration revoked.
 */
async function demoOrder(clientId, provider, branchId = 1) {
  const d = registry.def(provider);
  if (!d) { const e = new Error('Bilinmeyen platform: ' + provider); e.status = 400; throw e; }
  const conn = await db.one(
    'SELECT * FROM np_int_connections WHERE client_id=? AND provider=? AND branch_id=?',
    [clientId, provider, branchId]);
  if (!conn) {
    const e = new Error('Önce bu platform için bir bağlantı oluşturun.'); e.status = 409; throw e;
  }
  if ((conn.environment || 'simulator') !== 'simulator') {
    const e = new Error('Deneme siparişi yalnızca simülatör ortamında oluşturulabilir. '
      + 'Canlı bağlantıya deneme siparişi düşürülemez.');
    e.status = 409; throw e;
  }
  const sim = require('../integrations/simulator');
  const seq = Date.now().toString().slice(-6);
  sim.seedOrder(provider, {
    externalOrderId: 'DEMO' + seq,
    providerStoreId: conn.provider_store_id || 'STORE-1',
    supplierId: conn.supplier_id || 'SUP-1',
    customer: {
      name: 'Deneme Müşterisi', phone: '0500 000 00 00',
      address: 'Deneme Mah. Numune Sk. No:1 D:2',
      note: 'Bu bir deneme siparişidir',
    },
  });
  const r = await pollNow(clientId, provider);
  return { ok: true, provider, polled: r };
}

async function pollNow(clientId, provider = null) {
  const gs = (await poller.groups()).filter(g => g.clientId === clientId && (!provider || g.provider === provider));
  const out = [];
  for (const g of gs) out.push({ provider: g.provider, scope: g.scope, ...(await poller.pollGroup(g, { force: true })) });
  const drained = await ingest.drainEvents(100);
  return { polled: out, drained };
}

module.exports = {
  overview, saveConnection, setEnabled, testConnection, setRestaurantOpen, setPrepTime,
  mapping, autoMap, setMapping, buildCatalogue, syncMenu, setProductAvailability, unmappedRows,
  setCategoryAvailability, updatePrice, orderList, orderDetail, logList, eventList,
  retryEvent, retryAllFailed, reprint, pollNow, demoOrder, safeRow, fold,
};
