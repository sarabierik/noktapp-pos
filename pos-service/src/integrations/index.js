'use strict';
/**
 * The integration engine: adapters, order actions, and the two background
 * workers (poll, drain). Everything the SCREEN needs lives in
 * src/modules/integrations.js; everything the ORDER needs lives here.
 *
 * The rule this file exists to enforce: a platform being down is a local
 * non-event. `start()` never throws, the workers swallow their own failures
 * into the log and the connection's `last_error`, and nothing in the till's
 * own paths awaits anything on the network. A restaurant whose Trendyol key
 * expired at lunchtime goes on selling all afternoon and finds out from the
 * red card on the Entegrasyonlar screen.
 */
const db = require('../db');
const log = require('../logger');
const registry = require('./registry');
const crypto = require('./crypto');
const ingest = require('./ingest');
const poller = require('./poller');
const status = require('./status');


/* ------------------------------------------------------------------ */
/* connections + adapters                                              */
/* ------------------------------------------------------------------ */

async function connection(clientId, provider, branchId = 1) {
  return db.one('SELECT * FROM np_int_connections WHERE client_id=? AND provider=? AND branch_id=?',
    [clientId, provider, branchId]);
}

async function connectionById(clientId, id) {
  return db.one('SELECT * FROM np_int_connections WHERE id=? AND client_id=?', [id, clientId]);
}

/** Decrypted credentials. Never leaves this module or an adapter. */
async function credentials(conn) {
  if (!conn || !conn.credentials_enc) return {};
  try { return await crypto.decrypt(conn.credentials_enc); }
  catch (e) {
    log.error('entegrasyon', 'kimlik bilgileri cozulemedi', { provider: conn.provider, error: e.message });
    const err = new Error(e.message); err.status = 409; err.code = 'CREDENTIALS_UNREADABLE'; throw err;
  }
}

async function adapterFor(clientId, connOrProvider, branchId = 1) {
  const conn = typeof connOrProvider === 'object' ? connOrProvider
    : await connection(clientId, connOrProvider, branchId);
  if (!conn) { const e = new Error('Bu platform için bağlantı tanımlı değil'); e.status = 404; throw e; }
  if (conn.client_id !== clientId) { const e = new Error('Yetkisiz'); e.status = 403; throw e; }
  return registry.adapterFor(conn, await credentials(conn));
}

/* ------------------------------------------------------------------ */
/* order actions                                                       */
/* ------------------------------------------------------------------ */

/**
 * What each action means locally, and what it asks the platform for.
 *
 * The LOCAL change is applied only after the platform has agreed - except for
 * the one case where the platform cannot be asked. Doing it the other way
 * round (change locally, tell the platform, hope) is how a POS ends up showing
 * an order as accepted that the platform rejected minutes ago and gave to
 * somebody else.
 */
const ACTIONS = {
  accept: { to: 'ACCEPTED', op: 'accept' },
  reject: { to: 'REJECTED', op: 'reject' },
  preparing: { to: 'PREPARING', op: 'markPreparing' },
  ready: { to: 'READY', op: 'markReady' },
  dispatched: { to: 'DISPATCHED', op: 'markDispatched' },
  delivered: { to: 'DELIVERED', op: 'markDelivered' },
  cancel: { to: 'CANCELLED', op: 'cancel' },
};

async function mirror(clientId, mirrorId) {
  const m = await db.one('SELECT * FROM np_int_orders WHERE id=? AND client_id=?', [mirrorId, clientId]);
  if (!m) { const e = new Error('Platform siparişi bulunamadı'); e.status = 404; throw e; }
  return m;
}

/**
 * Do one thing to one platform order.
 *
 * Order of operations:
 *   1. is the transition legal here? (fail fast, no network)
 *   2. does the platform support being told? (structured refusal, no network)
 *   3. tell the platform
 *   4. only then move our own state, print, take the money, unwind
 *
 * Step 2 is why `CAPABILITY_NOT_SUPPORTED` matters so much: several of these
 * states exist on our side and not on the platform's. "Hazırlanıyor" is real
 * in the kitchen whether or not Yemeksepeti has a call for it, so an
 * unsupported push is not an error - the local state moves and the log says
 * the platform was not told.
 */
async function orderAction(clientId, mirrorId, action, { prepMinutes = null, reason = null, reasonCode = null,
  actor = null, force = false } = {}) {
  const a = ACTIONS[action];
  if (!a) { const e = new Error('Bilinmeyen işlem: ' + action); e.status = 400; throw e; }
  const m = await mirror(clientId, mirrorId);
  const conn = await connectionById(clientId, m.connection_id) || await connection(clientId, m.provider, m.branch_id);
  if (!conn) { const e = new Error('Bağlantı tanımlı değil'); e.status = 409; throw e; }

  /*
   * The mirror row is written the moment the event is normalised; the adisyon
   * is opened a fraction of a second later. Between those two moments the
   * order is on the screen with no bill behind it, and accepting it would tell
   * the platform yes and then fail to print - which is the worst of both. The
   * refusal is a 409 the screen can retry, not a silent half-success.
   */
  if (!m.order_id) {
    const e = new Error('Adisyon henüz oluşturulmadı, birkaç saniye sonra tekrar deneyin');
    e.status = 409; e.code = 'ORDER_NOT_READY'; throw e;
  }

  status.assertTransition(m.status, a.to);

  /* PROVIDER_TABLET: the vendor accepts on the platform's own tablet. Pressing
     Onayla here would send an acceptance the platform has already recorded and
     will refuse. The local state still moves - the kitchen has to be told. */
  const tabletMode = conn.acceptance_mode === 'PROVIDER_TABLET' && (action === 'accept' || action === 'reject');

  let adapter = null;
  let remote = { ok: true, skipped: true, reason: 'local-only' };
  if (!tabletMode) {
    try { adapter = await adapterFor(clientId, conn); }
    catch (e) { if (!force) throw e; }
    if (adapter) {
      /*
       * WHAT THE ADAPTER NEEDS THAT THE MIRROR ROW ALREADY KNOWS.
       *
       * These three were missing, and each one was silently wrong rather
       * than loudly broken:
       *
       *   fulfillmentType  decides whether "yola çıktı" is ours to report at
       *                    all. On a platform-courier order it is THEIR
       *                    courier moving the food and their app telling the
       *                    guest so; sending manual-shipped there is us
       *                    claiming to have done something we did not. The
       *                    adapter has always had the guard - it just never
       *                    got the field to test.
       *   itemIdList       a full cancellation is expressed as every package
       *                    item id, not as an empty list. Without it the
       *                    platform is being asked to cancel nothing.
       *   reasonCode       cancellations were all going up as the adapter's
       *                    fallback reason, so every one of them read as
       *                    "the kitchen could not prepare it" whatever had
       *                    actually happened.
       */
      const itemIds = (a.op === 'reject' || a.op === 'cancel')
        ? (await db.query(
            'SELECT external_item_id FROM np_int_order_items WHERE client_id=? AND int_order_id=? AND role=?',
            [clientId, m.id, 'item'])).map(r => r.external_item_id).filter(Boolean)
        : null;
      remote = await adapter.call(a.op, {
        externalOrderId: m.external_order_id, externalPackageId: m.external_package_id,
        prepMinutes: prepMinutes || m.prep_minutes || conn.default_prep_minutes,
        fulfillmentType: m.fulfillment_type,
        deliveryType: m.fulfillment_type === 'RESTAURANT_COURIER' ? 'STORE' : 'GO',
        itemIdList: itemIds && itemIds.length ? itemIds : null,
        reason, reasonCode,
      });
    }
  }

  const softFail = remote.ok || remote.code === 'CAPABILITY_NOT_SUPPORTED' || remote.code === 'AWAITING_PARTNER_SPEC';
  if (!softFail && !force) {
    await ingest.logLine(clientId, { provider: m.provider, branchId: m.branch_id, level: 'error',
      action, orderId: m.order_id, externalOrderId: m.external_order_id, actor,
      message: 'Platforma bildirilemedi: ' + remote.message, detail: remote.detail });
    const e = new Error(remote.message); e.status = 502; e.code = remote.code; e.retryable = !!remote.retryable; throw e;
  }
  if (!remote.ok) {
    await ingest.logLine(clientId, { provider: m.provider, branchId: m.branch_id, level: 'warn',
      action, orderId: m.order_id, externalOrderId: m.external_order_id, actor,
      message: 'Platform bu işlemi desteklemiyor, yalnızca kasada uygulandı (' + remote.code + ')' });
  }

  if (action === 'accept' && prepMinutes) {
    await db.exec('UPDATE np_int_orders SET prep_minutes=? WHERE id=?', [Number(prepMinutes), m.id]);
  }
  if (action === 'reject') {
    await db.exec('UPDATE np_int_orders SET reject_reason=? WHERE id=?', [String(reasonCode || reason || '').slice(0, 120), m.id]);
  }
  const fresh = await mirror(clientId, mirrorId);
  const out = await ingest.applyStatus(clientId, conn, fresh, a.to,
    { providerStatus: remote.providerStatus || null, reason, actor });
  return { ...out, remote: { ok: remote.ok, code: remote.code || null, skipped: !!remote.skipped } };
}

/* ------------------------------------------------------------------ */
/* incoming: the webhook side of the same pipeline                     */
/* ------------------------------------------------------------------ */
/**
 * A webhook, from the moment the body lands to the moment we answer.
 *
 * Verify, write it down, answer. Nothing else happens on this call stack -
 * `drainEvents` picks it up within the second. The provider is told "accepted"
 * for a payload we have STORED, which is a promise we can keep; telling it
 * "processed" for something we have not finished would not be.
 */
async function receiveWebhook(clientId, provider, { headers = {}, rawBody = '', body = null, branchId = 1 } = {}) {
  const conn = await connection(clientId, provider, branchId);
  if (!conn) { const e = new Error('Bu platform için bağlantı tanımlı değil'); e.status = 404; throw e; }
  if (!conn.enabled) { const e = new Error('Bağlantı kapalı'); e.status = 409; throw e; }
  const adapter = await adapterFor(clientId, conn);

  let signatureOk = true;
  let method = 'none';
  if (adapter.supports('verifyWebhook')) {
    const v = await adapter.call('verifyWebhook', { headers, rawBody });
    if (!v.ok) {
      await ingest.logLine(clientId, { provider, branchId, level: 'error', action: 'webhook',
        message: 'İmza doğrulanamadı, olay reddedildi' });
      const e = new Error(v.message || 'İmza doğrulanamadı'); e.status = 401; throw e;
    }
    signatureOk = v.method !== 'none';
    method = v.method;
  }

  const parsed = await adapter.call('receiveWebhook', { body });
  if (!parsed.ok) { const e = new Error(parsed.message); e.status = 400; throw e; }
  const n = parsed.order;
  if (!n || !n.externalOrderId) { const e = new Error('Sipariş kimliği okunamadı'); e.status = 400; throw e; }

  const ev = await ingest.recordEvent(clientId, provider, {
    source: 'webhook',
    /* The platform's own delivery id when there is one; otherwise the same
       content hash the poller uses, so a webhook and a poll describing the
       same change are recognised as the same change. */
    eventKey: headers['x-request-id'] || headers['x-event-id'] || ingest.eventKeyFor(n, 'webhook'),
    eventType: n.providerStatus, providerStoreId: n.providerStoreId,
    externalOrderId: n.externalOrderId, externalPackageId: n.externalPackageId,
    payload: { order: n, __branchId: branchId }, signatureOk,
  });
  /* Kick the worker, but do not wait for it - the answer goes back now. */
  setImmediate(() => ingest.drainEvents(10).catch(() => {}));
  return { received: true, duplicate: ev.duplicate, eventId: ev.eventId, verification: method };
}

/* ------------------------------------------------------------------ */
/* health                                                              */
/* ------------------------------------------------------------------ */
async function health(clientId, provider, branchId = 1) {
  const conn = await connection(clientId, provider, branchId);
  if (!conn) return { provider, configured: false };
  let adapterHealth = null;
  try {
    const a = await adapterFor(clientId, conn);
    const r = await a.call('health', {});
    adapterHealth = r.ok ? r : { error: r.message, code: r.code };
  } catch (e) { adapterHealth = { error: e.message }; }
  const cur = await db.one('SELECT * FROM np_int_cursors WHERE client_id=? AND provider=? ORDER BY id LIMIT 1',
    [clientId, provider]);
  const queue = await db.one(
    `SELECT SUM(status IN ('new','failed')) AS pending, SUM(status='dead') AS dead, SUM(status='done') AS done
       FROM np_int_events WHERE client_id=? AND provider=?`, [clientId, provider]);
  return {
    provider, configured: true, enabled: !!conn.enabled, environment: conn.environment,
    status: conn.status, last_ok_at: conn.last_ok_at, last_sync_at: conn.last_sync_at,
    last_error: conn.last_error, last_error_at: conn.last_error_at,
    acceptance_mode: conn.acceptance_mode, restaurant_open: !!conn.restaurant_open,
    cursor: cur ? { last_modified_at: cur.last_modified_at, last_ok_at: cur.last_ok_at,
      consecutive_errors: cur.consecutive_errors, backoff_until: cur.backoff_until, last_error: cur.last_error } : null,
    queue: { pending: Number((queue && queue.pending) || 0), dead: Number((queue && queue.dead) || 0),
      done: Number((queue && queue.done) || 0) },
    adapter: adapterHealth,
    master_key_from_environment: crypto.keyFromEnvironment(),
    master_key_source: crypto.keySource(),
  };
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */
async function start() {
  try {
    const any = await db.value("SELECT COUNT(*) FROM np_int_connections WHERE enabled=1").catch(() => 0);
    /* One worker, not two: poller.tick polls AND drains, and backs off to a
       single cheap query every thirty seconds when there is nothing connected.
       A webhook still kicks the drain immediately - see receiveWebhook. */
    await poller.start();
    log.info('entegrasyon', 'Entegrasyon servisi başladı', { enabledConnections: Number(any) || 0 });
  } catch (e) {
    /* Never fatal. The till boots with or without this. */
    log.warn('entegrasyon', 'Entegrasyon servisi başlatılamadı, kasa etkilenmez', e.message);
  }
}
function stop() { poller.stop(); }

module.exports = {
  start, stop, connection, connectionById, credentials, adapterFor, orderAction,
  receiveWebhook, health, mirror, ACTIONS,
};
