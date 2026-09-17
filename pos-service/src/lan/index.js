'use strict';
/**
 * Local network discovery for the phone app.
 *
 * The waiter's phone should find the till by itself: no IP typing, no static
 * addresses, no MikroTik. The service advertises itself over Bonjour/mDNS as
 * _noktapp-pos._tcp, and the app also sweeps the phone's own subnet as a
 * fallback for networks where multicast is filtered.
 *
 * Pairing is a six digit code shown on the till - the phone sends it once and
 * receives a long lived token stored in app_device_tokens.
 */
const os = require('os');
const crypto = require('crypto');
const db = require('../db');
const log = require('../logger');
const config = require('../config');

let bonjour = null;
let published = null;

function localIps() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

async function start(port) {
  if (String(await db.getSetting('lan_enabled', '1')) !== '1') return;
  try {
    const { Bonjour } = require('bonjour-service');
    bonjour = new Bonjour();
    const lic = await db.one('SELECT client_id, company_name FROM np_licence WHERE id=1');
    published = bonjour.publish({
      name: 'NoktApp POS - ' + ((lic && lic.company_name) || os.hostname()),
      type: 'noktapp-pos',
      port: port || config.port,
      txt: { client: String(lic ? lic.client_id : ''), v: process.env.NOKTAPP_VERSION || '2.0.0' },
    });
    log.info('lan', 'Advertised on the local network', { ips: localIps(), port });
  } catch (e) {
    log.warn('lan', 'mDNS unavailable, phones will use the subnet sweep instead', e.message);
  }
}

function stop() {
  try { if (published) published.stop(); if (bonjour) bonjour.destroy(); } catch (_) {}
  published = null; bonjour = null;
}

/**
 * The address a phone should be given first.
 *
 * A restaurant PC often has more than one IPv4: the real LAN card, a docking
 * station's second card, VirtualBox/Hyper-V host adapters (192.168.56.x,
 * 172.2x.x.x) that lead nowhere. The QR can only carry one address, so the
 * private ranges a home/office router actually hands out are preferred, and
 * the well known virtual-adapter ranges are pushed to the back rather than
 * dropped - on a strange network they may be the only thing there is.
 */
function rankIp(ip) {
  if (/^192\.168\.56\./.test(ip)) return 9;            // VirtualBox host-only
  if (/^169\.254\./.test(ip)) return 9;                 // self assigned, no router
  if (/^192\.168\./.test(ip)) return 0;
  if (/^10\./.test(ip)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 5;
}

/** Every address this PC answers on, best first. */
function addresses() {
  return localIps().sort((a, b) => rankIp(a) - rankIp(b)).map(ip => `http://${ip}:${config.port}`);
}

/* ---------------------------- pairing ----------------------------- */

/**
 * A pairing code carries TWO secrets, on purpose.
 *
 *   pair_code  six digits, printed large on the till. Short enough to read
 *              across a room and therefore short enough to guess, so this
 *              path still demands the waiter's own username and password.
 *   qr_token   32 hex characters that exist only inside the QR symbol. A
 *              phone that presents it has physically stood in front of the
 *              till, so it may pair without a password - but only onto the
 *              member of staff the code was minted for.
 *
 * Both die together: one row, one `used_at`, ten minutes.
 */
async function createPairCode(clientId, userId = null, forUserId = null) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const qrToken = crypto.randomBytes(16).toString('hex');
  await db.exec('DELETE FROM np_mobile_pairings WHERE expires_at < NOW() OR client_id=? AND used_at IS NULL AND created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)', [clientId]);
  await db.exec(
    'INSERT INTO np_mobile_pairings (client_id, pair_code, qr_token, user_id, for_user_id, expires_at, created_at)' +
    ' VALUES (?,?,?,?,?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), NOW())',
    [clientId, code, qrToken, userId, forUserId || null]);
  return { code, qr_token: qrToken, for_user_id: forUserId || null, client_id: clientId,
    expires_in: 600, ips: localIps(), addresses: addresses(), port: config.port };
}

async function redeemPairCode(code, device) {
  return redeem('pair_code', String(code), device, 'kod');
}

/** The QR path. Same row, same single use, different column. */
async function redeemQrToken(token, device) {
  if (!/^[0-9a-f]{32}$/.test(String(token || ''))) {
    const e = new Error('Karekod okunamadi'); e.status = 400; throw e;
  }
  return redeem('qr_token', String(token), device, 'qr');
}

async function redeem(column, value, device, how) {
  const row = await db.one(
    `SELECT * FROM np_mobile_pairings WHERE ${column}=? AND used_at IS NULL AND expires_at > NOW()`, [value]);
  if (!row) { const e = new Error('Kod gecersiz veya suresi dolmus'); e.status = 400; throw e; }
  /*
   * Claim the row in the UPDATE, not after the SELECT. Two phones scanning the
   * same symbol in the same second both pass the SELECT; only the one whose
   * UPDATE still sees used_at IS NULL may continue.
   */
  const claimed = await db.exec(
    'UPDATE np_mobile_pairings SET used_at=NOW(), redeemed_by=?, device_id=?, device_name=?, platform=?' +
    ' WHERE id=? AND used_at IS NULL',
    [how, device.device_id, device.device_name, device.platform, row.id]);
  if (!claimed) { const e = new Error('Bu kod az once baska bir telefon tarafindan kullanildi'); e.status = 409; throw e; }
  return row;
}

/** Long lived token for a phone, stored in the schema's own app_device_tokens. */
async function issueDeviceToken(clientId, user, device) {
  const token = crypto.randomBytes(32).toString('hex');
  const refresh = crypto.randomBytes(32).toString('hex');
  const h = s => crypto.createHash('sha256').update(s).digest('hex');
  await db.exec(
    `INSERT INTO app_device_tokens (client_id, user_ref, is_client, role, device_id, device_name, platform,
        app_version, token_hash, refresh_hash, expires_at, refresh_expires_at, last_seen_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, DATE_ADD(NOW(), INTERVAL 30 DAY), DATE_ADD(NOW(), INTERVAL 180 DAY), NOW(), NOW())`,
    [clientId, user.id, 0, user.role, device.device_id, device.device_name, device.platform,
     device.app_version || null, h(token), h(refresh)]);
  return { token, refresh };
}

async function verifyDeviceToken(token) {
  const h = require('crypto').createHash('sha256').update(String(token)).digest('hex');
  const row = await db.one(
    'SELECT * FROM app_device_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at > NOW()', [h]);
  if (!row) return null;
  db.exec('UPDATE app_device_tokens SET last_seen_at=NOW() WHERE id=?', [row.id]).catch(() => {});
  return row;
}

async function listDevices(clientId) {
  return db.query(
    `SELECT d.id, d.device_name, d.platform, d.app_version, d.last_seen_at, d.revoked_at, u.display_name AS user_name
       FROM app_device_tokens d LEFT JOIN users u ON u.id=d.user_ref
      WHERE d.client_id=? ORDER BY d.last_seen_at DESC`, [clientId]);
}
async function revokeDevice(clientId, id) {
  return db.exec('UPDATE app_device_tokens SET revoked_at=NOW() WHERE id=? AND client_id=?', [id, clientId]);
}

module.exports = { start, stop, localIps, addresses, createPairCode, redeemPairCode, redeemQrToken,
  issueDeviceToken, verifyDeviceToken, listDevices, revokeDevice };
