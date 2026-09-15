'use strict';
/**
 * Cloud sync.
 *
 * The restaurant's data lives on their PC. What goes up to pos.noktapp.com is
 * only what the owner wants to see from outside and what we need to keep them
 * safe: end-of-day figures, a rolling summary, the licence heartbeat and the
 * nightly backup. Orders themselves are pushed as summaries, not as raw rows,
 * so a slow line never blocks the till.
 */
const db = require('../db');
const log = require('../logger');
const licence = require('../licence');

let timer = null;
let busy = false;
let inFlight = null;

async function push(entity, entityId, payload, op = 'upsert') {
  const clientId = await db.getClientId();
  if (!clientId) return null;
  return db.insert(
    'INSERT INTO np_sync_outbox (client_id, entity, entity_id, op, payload, status, created_at) VALUES (?,?,?,?,?,\'pending\',NOW())',
    [clientId, entity, String(entityId), op, JSON.stringify(payload)]);
}

/**
 * Push the outbox.
 *
 * A caller that awaits this has to be able to trust that when it returns, the
 * work is done. The old guard just returned when a drain was already running,
 * so an awaited call could come back before anything had been sent - the
 * caller then read a value the server had not been told about yet. Concurrent
 * callers now wait for the run that is already in progress instead.
 */
async function drain() {
  /*
   * Waiting for the run that is already going is not enough: it selected its
   * batch before this caller's row existed, so that row would still be
   * sitting in the outbox when the wait ends. Wait for it, then run again.
   */
  if (busy) {
    const running = inFlight;
    await running;
    if (busy) return inFlight;          // a third caller started one meanwhile
    return drain();
  }
  busy = true;
  inFlight = (async () => {
  try {
    const rows = await db.query("SELECT * FROM np_sync_outbox WHERE status='pending' AND attempts < 10 ORDER BY id LIMIT 50");
    if (!rows.length) return;
    const lic = await db.one('SELECT client_id, licence_key FROM np_licence WHERE id=1');
    if (!lic) return;
    const url = (await licence.panelUrl()) + '/api/desktop/sync.php';
    const res = await licence.post(url, {
      client_id: lic.client_id,
      licence_key: lic.licence_key,
      device_id: await licence.deviceId(),
      items: rows.map(r => ({ id: r.id, entity: r.entity, entity_id: r.entity_id, op: r.op, payload: safe(r.payload) })),
    }, 30000);
    if (res.status === 200 && res.body && res.body.ok) {
      const okIds = res.body.accepted || rows.map(r => r.id);
      if (okIds.length) {
        await db.exec(`UPDATE np_sync_outbox SET status='sent', sent_at=NOW() WHERE id IN (${okIds.map(() => '?').join(',')})`, okIds);
      }
      log.debug('sync', 'pushed ' + okIds.length + ' rows');
    } else {
      await bump(rows, (res.body && res.body.error) || 'panel rejected');
    }
  } catch (e) {
    log.debug('sync', 'push failed', e.message);
  } finally {
    busy = false;
    inFlight = null;
  }
  })();
  return inFlight;
}

async function bump(rows, err) {
  for (const r of rows) {
    await db.exec('UPDATE np_sync_outbox SET attempts=attempts+1, last_error=? WHERE id=?', [String(err).slice(0, 250), r.id]);
  }
}
function safe(s) { try { return JSON.parse(s); } catch (_) { return null; } }

/** Hourly summary so the owner's phone/panel shows today's numbers. */
async function pushSummary() {
  const clientId = await db.getClientId();
  if (!clientId) return;
  const reports = require('../modules/reports');
  try {
    const d = await reports.dashboard(clientId);
    await push('daily_summary', `${clientId}:${d.business_date}`, d);
  } catch (e) { log.debug('sync', 'summary failed', e.message); }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { drain().catch(() => {}); }, 60000);
  setInterval(() => { pushSummary().catch(() => {}); }, 15 * 60000);
  setInterval(() => { licence.heartbeat().catch(() => {}); }, 30 * 60000);
  log.info('sync', 'Cloud sync started');
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { push, drain, pushSummary, start, stop };
