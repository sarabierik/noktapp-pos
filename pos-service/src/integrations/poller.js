'use strict';
/**
 * Polling, done once per SUPPLIER rather than once per branch.
 *
 * The naive shape - a timer per connected restaurant - is what turns a chain of
 * twelve branches into twelve times the request rate against an endpoint that
 * allows fifty requests per ten seconds, and it is why integrations get their
 * keys suspended. TGO's package endpoint is addressed by supplier id and
 * returns every store under it, so ONE poll per supplier is both correct and
 * cheap: the packages come back, and each is routed to the connection whose
 * provider_store_id matches. A store nobody has connected is skipped and said
 * so in the log, which is how a restaurant discovers a branch was never mapped.
 *
 * Incremental, with an overlap. The cursor is the modification timestamp of the
 * newest package we have successfully consumed; the next poll asks for
 * everything modified since (cursor - overlap), where overlap is two minutes.
 * That window is not caution for its own sake - a platform's modification
 * timestamps are written on its own clocks, and the moment ours differ by a few
 * seconds a strictly-greater-than cursor starts dropping orders silently. The
 * duplicates the overlap creates cost nothing, because np_int_events and
 * np_int_orders both refuse them.
 *
 * The cursor advances ONLY after the batch has been persisted. A crash halfway
 * through leaves the cursor where it was and the next run does the work again;
 * a cursor advanced first would lose the tail of the batch for ever.
 */
const db = require('../db');
const log = require('../logger');
const rate = require('./ratelimit');
const registry = require('./registry');
const ingest = require('./ingest');

const OVERLAP_MS = 120000;          // two minutes
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 10;

let timer = null;
let running = false;
let stopped = true;

function clampInterval(s) {
  const n = Number(s) || 7;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, n));
}

function sqlDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Every polling connection, grouped into one poll per supplier. */
async function groups() {
  const rows = await db.query(
    `SELECT * FROM np_int_connections WHERE enabled=1 ORDER BY client_id, provider, branch_id`);
  const out = new Map();
  for (const c of rows) {
    const d = registry.def(c.provider);
    if (!d || d.transport !== 'polling') continue;
    const scope = String(c.supplier_id || c.provider_store_id || c.branch_id);
    const key = `${c.client_id}|${c.provider}|${scope}`;
    if (!out.has(key)) out.set(key, { clientId: c.client_id, provider: c.provider, scope, connections: [] });
    out.get(key).connections.push(c);
  }
  return Array.from(out.values());
}

async function cursor(clientId, provider, scope) {
  await db.exec(
    `INSERT INTO np_int_cursors (client_id, provider, scope) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE client_id=VALUES(client_id)`, [clientId, provider, scope]);
  return db.one('SELECT * FROM np_int_cursors WHERE client_id=? AND provider=? AND scope=?', [clientId, provider, scope]);
}

/**
 * One supplier, one poll.
 *
 * Returns a small report rather than throwing: a provider that is down is a
 * normal condition for this function and the till must go on working, so the
 * failure is recorded on the cursor row (which is where the backoff lives) and
 * the loop carries on with the next supplier.
 */
async function pollGroup(g, { force = false } = {}) {
  const cur = await cursor(g.clientId, g.provider, g.scope);
  if (!force && cur.backoff_until && new Date(cur.backoff_until) > new Date()) {
    return { skipped: 'backoff', until: cur.backoff_until };
  }
  const lead = g.connections[0];
  const svc = require('./index');
  let adapter;
  try { adapter = await svc.adapterFor(g.clientId, lead); }
  catch (e) { return { skipped: 'no-adapter', error: e.message }; }

  const since = cur.last_modified_at
    ? sqlDate(new Date(new Date(cur.last_modified_at).getTime() - OVERLAP_MS))
    : sqlDate(new Date(Date.now() - 30 * 60000));   // a cold start looks back half an hour, not for ever

  const storeIds = g.connections.map(c => String(c.provider_store_id)).filter(Boolean);
  await db.exec('UPDATE np_int_cursors SET last_run_at=NOW() WHERE id=?', [cur.id]);

  const res = await adapter.call('fetchOrders', { since, storeIds });
  if (!res.ok) {
    if (res.code === 'CAPABILITY_NOT_SUPPORTED') return { skipped: 'not-supported' };
    const attempts = Number(cur.consecutive_errors) + 1;
    const wait = rate.backoffMs(attempts);
    await db.exec(
      `UPDATE np_int_cursors SET consecutive_errors=?, backoff_until=DATE_ADD(NOW(), INTERVAL ? SECOND),
          last_error=? WHERE id=?`,
      [attempts, Math.ceil(wait / 1000), String(res.message).slice(0, 500), cur.id]);
    /* A permanent 4xx is not retried into the ground: the backoff still
       applies but the connection is marked in error so somebody looks at it,
       because no amount of waiting fixes a wrong API key. */
    const permanent = res.code === 'INVALID_CREDENTIALS' || res.code === 'PERMANENT';
    for (const c of g.connections) {
      await db.exec("UPDATE np_int_connections SET status='error', last_error=?, last_error_at=NOW() WHERE id=?",
        [String(res.message).slice(0, 500), c.id]);
    }
    await ingest.logLine(g.clientId, { provider: g.provider, level: permanent ? 'error' : 'warn',
      action: 'poll', message: 'Sipariş çekilemedi: ' + res.message +
        (permanent ? ' (kalıcı hata, otomatik tekrar denenmeyecek)' : ` (${Math.round(wait / 1000)} sn sonra tekrar)`) });
    return { error: res.message, permanent, backoffSec: Math.round(wait / 1000) };
  }

  const list = res.orders || [];
  let applied = 0; let unrouted = 0; let newest = cur.last_modified_at ? new Date(cur.last_modified_at) : null;
  for (const n of list) {
    const conn = g.connections.find(c => String(c.provider_store_id) === String(n.providerStoreId))
      || (g.connections.length === 1 ? g.connections[0] : null);
    if (!conn) {
      unrouted++;
      await ingest.logLine(g.clientId, { provider: g.provider, level: 'warn', action: 'poll',
        externalOrderId: n.externalOrderId,
        message: 'Bu mağaza kimliği hiçbir şubeye bağlı değil: ' + n.providerStoreId });
      continue;
    }
    try {
      const ev = await ingest.recordEvent(g.clientId, g.provider, {
        source: 'poll', eventKey: ingest.eventKeyFor(n, 'poll'),
        eventType: n.providerStatus, providerStoreId: n.providerStoreId,
        externalOrderId: n.externalOrderId, externalPackageId: n.externalPackageId,
        payload: { order: n, __branchId: conn.branch_id },
      });
      if (!ev.duplicate) applied++;
    } catch (e) {
      log.warn('entegrasyon', 'olay yazilamadi', e.message);
    }
    const mod = n.providerModifiedAt ? new Date(n.providerModifiedAt) : null;
    if (mod && !isNaN(mod.getTime()) && (!newest || mod > newest)) newest = mod;
  }

  /* Persisted first, cursor afterwards. */
  await db.exec(
    `UPDATE np_int_cursors SET last_modified_at=?, last_ok_at=NOW(), consecutive_errors=0,
        backoff_until=NULL, last_error=NULL WHERE id=?`,
    [newest ? sqlDate(newest) : cur.last_modified_at, cur.id]);
  for (const c of g.connections) {
    await db.exec("UPDATE np_int_connections SET status='connected', last_ok_at=NOW(), last_sync_at=NOW(), last_error=NULL WHERE id=?", [c.id]);
  }
  return { fetched: list.length, queued: applied, unrouted, since, cursor: newest ? sqlDate(newest) : null };
}

/**
 * One sweep over every supplier, then drain whatever the sweep queued.
 *
 * Returns whether there was anything to do, which is what decides how soon the
 * next sweep runs - see `schedule`.
 */
async function tick() {
  if (running || stopped) return false;
  running = true;
  let busy = false;
  try {
    const gs = await groups();
    busy = gs.length > 0;
    for (const g of gs) {
      try { await pollGroup(g); }
      catch (e) { log.warn('entegrasyon', 'poll hatasi', { provider: g.provider, error: e.message }); }
    }
    const drained = await ingest.drainEvents(50);
    if (drained.seen) busy = true;
  } catch (e) {
    log.error('entegrasyon', 'poller dongusu hata verdi', e.message);
  } finally {
    running = false;
  }
  return busy;
}

async function interval() {
  const row = await db.one('SELECT MIN(poll_interval_sec) v FROM np_int_connections WHERE enabled=1').catch(() => null);
  return clampInterval(row && row.v) * 1000;
}

/*
 * A till with no platform connected is the common case, and it must not pay
 * for this feature.
 *
 * The first version ran two fixed timers - a poll every 5-10 seconds and a
 * drain every 3 - which is twenty-five database round trips a minute, for ever,
 * on a restaurant PC that has never opened the Entegrasyonlar screen. Worse,
 * they are round trips against the same pool the till uses to take money, and
 * a till under load does not need our idle housekeeping competing for a
 * connection.
 *
 * So: ONE self-rescheduling timer. When there is work - an enabled connection,
 * or an event in the queue - it runs at the configured 5-10 seconds. When
 * there is not, it drops to IDLE_MS and costs one cheap SELECT every half
 * minute. A webhook does not wait for either: it kicks the drain itself on the
 * next tick of the event loop.
 */
const IDLE_MS = 30000;

function schedule(ms) {
  if (stopped) return;
  timer = setTimeout(async () => {
    let busy = false;
    try { busy = await tick(); } catch (_) { /* tick already logged it */ }
    schedule(busy ? await interval().catch(() => IDLE_MS) : IDLE_MS);
  }, ms);
  if (timer.unref) timer.unref();
}

async function start() {
  if (timer) return;
  stopped = false;
  const ms = await interval();
  schedule(ms);
  log.info('entegrasyon', 'Sipariş çekme başladı',
    { intervalSec: ms / 1000, idleSec: IDLE_MS / 1000, overlapSec: OVERLAP_MS / 1000 });
}
function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }

module.exports = { start, stop, tick, pollGroup, groups, cursor, OVERLAP_MS, IDLE_MS, MIN_INTERVAL, MAX_INTERVAL, clampInterval };
