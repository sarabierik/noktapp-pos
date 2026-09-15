'use strict';
/**
 * Cloud relay.
 *
 * When the waiter's phone is not on the restaurant's Wi-Fi - they stepped
 * outside, the guest network is separate, the router blocks multicast - the app
 * posts the same request to pos.noktapp.com instead. The panel only parks the
 * message in a queue; this PC short-polls that queue, runs the request against
 * the local database exactly as if it had arrived over the LAN, and writes the
 * answer back.
 *
 * Nothing is opened on the restaurant's router and the restaurant needs no
 * static IP - the connection is always outbound from this PC.
 */
const db = require('./db');
const log = require('./logger');
const licence = require('./licence');

let timer = null;
let stopped = false;
let handler = null;   // set by index.js: (req) => Promise<{status, body}>

function setHandler(fn) { handler = fn; }

async function poll() {
  if (stopped) return;
  if (String(await db.getSetting('relay_enabled', '1')) !== '1') return;
  const lic = await db.one('SELECT client_id, licence_key FROM np_licence WHERE id=1');
  if (!lic) return;
  const st = await db.one('SELECT * FROM np_relay_state WHERE id=1');
  const url = (await licence.panelUrl()) + '/api/desktop/relay_poll.php';
  try {
    const res = await licence.post(url, {
      client_id: lic.client_id,
      licence_key: lic.licence_key,
      device_id: await licence.deviceId(),
      /* Every call that identifies the device may as well say which build is
         speaking. Without it the panel's device row has to wait for the next
         half-hourly heartbeat to learn the version after an update. */
      app_version: process.env.NOKTAPP_VERSION || '2.0.0',
      after_id: st ? st.last_msg_id : 0,
      wait: 20,                       // the panel long-polls for up to 20s
    }, 30000);
    await db.exec('UPDATE np_relay_state SET last_poll_at=NOW(), consecutive_errors=0 WHERE id=1');
    if (res.status !== 200 || !res.body.ok) return;
    const msgs = res.body.messages || [];
    for (const m of msgs) {
      let answer = { status: 500, body: { ok: false, error: 'handler yok' } };
      try {
        if (handler) answer = await handler(m);
      } catch (e) {
        answer = { status: 500, body: { ok: false, error: e.message } };
      }
      await licence.post((await licence.panelUrl()) + '/api/desktop/relay_answer.php', {
        client_id: lic.client_id, licence_key: lic.licence_key,
        message_id: m.id, status: answer.status, body: answer.body,
      }, 20000).catch(e => log.warn('relay', 'answer failed', e.message));
      await db.exec('UPDATE np_relay_state SET last_msg_id=GREATEST(last_msg_id, ?) WHERE id=1', [m.id]);
    }
  } catch (e) {
    await db.exec('UPDATE np_relay_state SET consecutive_errors=consecutive_errors+1, last_poll_at=NOW() WHERE id=1').catch(() => {});
    log.debug('relay', 'poll failed', e.message);
  }
}

function start() {
  stopped = false;
  const loop = async () => {
    await poll();
    if (!stopped) timer = setTimeout(loop, 1500);
  };
  loop();
  log.info('relay', 'Cloud relay poller started');
}
function stop() { stopped = true; if (timer) clearTimeout(timer); }

module.exports = { start, stop, setHandler, poll };
