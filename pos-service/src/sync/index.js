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

/**
 * Entities whose payload is the WHOLE current state of one thing, not a change
 * to it.
 *
 * For these, two pending rows with the same entity_id are not two facts - they
 * are the same fact written twice, and the older one is simply wrong. So a new
 * push replaces any pending row it supersedes instead of queueing behind it.
 *
 * This is not a tidiness measure. The drain sends fifty rows at a time, and
 * loyalty pushes three entities every time a cashier stamps a card. Without
 * collapsing, a busy hour puts the till's newest balances behind hundreds of
 * stale copies of themselves, and the guest's phone shows a number from
 * twenty minutes ago - which is the same complaint as showing nothing.
 *
 * qr_token_used is deliberately NOT here: each row is one code being spent at
 * one restaurant, and collapsing two of them would silently un-burn a code.
 * integration_order is per order, so its entity_id is already unique.
 */
const SNAPSHOT = new Set(['loyalty_cards', 'loyalty_programs', 'loyalty_events',
                          'daily_summary', 'qr_menu']);

async function push(entity, entityId, payload, op = 'upsert') {
  const clientId = await db.getClientId();
  if (!clientId) return null;
  if (SNAPSHOT.has(entity)) {
    /* Only PENDING rows. A row already sent is history and the panel has it;
       rewriting it would make the outbox lie about what was pushed and when. */
    await db.exec(
      "DELETE FROM np_sync_outbox WHERE client_id=? AND entity=? AND entity_id=? AND status='pending'",
      [clientId, entity, String(entityId)]);
  }
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
    const lic = await db.one('SELECT client_id, licence_key FROM np_licence WHERE id=1');
    if (!lic) return;
    const url = (await licence.panelUrl()) + '/api/desktop/sync.php';
    /*
     * Keep going until the outbox is empty.
     *
     * One batch per call was the old behaviour and it is wrong in both
     * directions. A caller that awaits drain() - the loyalty round trip does -
     * was told the work was done while its own row was still pending, because
     * the batch had filled up with rows written before it. And a till that has
     * been off the line for a day cleared fifty rows a minute, so the panel
     * stayed hours behind for no reason.
     *
     * Bounded, because unbounded is how a till spends its evening talking to
     * us instead of serving tables. Forty batches is two thousand rows per
     * call; the next minute's tick takes the rest.
     */
    for (let batch = 0; batch < 40; batch++) {
      const rows = await db.query(
        "SELECT * FROM np_sync_outbox WHERE status='pending' AND attempts < 10 ORDER BY id LIMIT 50");
      if (!rows.length) return;
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
        /* A panel that accepted nothing is not going to accept the same rows on
           the next turn round the loop either - stop rather than spin. */
        if (!okIds.length) return;
      } else {
        await bump(rows, (res.body && res.body.error) || 'panel rejected');
        return;
      }
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
