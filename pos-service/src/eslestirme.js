'use strict';
/**
 * Telefon esletirme - bir uygulama, iki kapi.
 *
 * WHY THIS IS ITS OWN FILE NOW.
 *
 * Pairing lived inside POST /api/auth/pair, and /api/auth is a LAN-only door:
 * the cloud relay refuses every path that is not /api/mobile/*. That single
 * line of policy is what made the whole product feel broken to an owner
 * standing in his own restaurant. The phone could talk to the till from
 * anywhere in the world once it was paired - but it could only BE paired while
 * it sat on the same Wi-Fi, so every new waiter's phone, every reinstall and
 * every replaced handset needed somebody to be physically inside the building
 * with the right network. "Bütün müşteriler benim ofisimde değil ki."
 *
 * So the implementation moved here and both doors call it:
 *
 *   /api/auth/pair    - over the LAN. Both ways in: the six digit code with a
 *                       username and password, or the QR token.
 *   /api/mobile/pair  - relayable, and therefore reachable from the internet,
 *                       so it takes THE QR TOKEN ONLY. The six digits are a
 *                       number somebody can guess in an afternoon if they are
 *                       allowed to guess from Jakarta; the token is 128 bits,
 *                       single use, and dies in ten minutes. That asymmetry is
 *                       the entire security argument for opening this door.
 */
const auth = require('./auth');
const lan = require('./lan');
const log = require('./logger');

/**
 * @param {object} body  the phone's JSON
 * @param {object} opts  { ip, qrOnly } - qrOnly is set by the relayable door
 */
async function pair(body = {}, opts = {}) {
  const { code, qr_token, device_id, device_name, platform, app_version, username, password } = body;
  const byQr = !!qr_token;

  if (opts.qrOnly && !byQr) {
    const e = new Error('Bu kapidan yalnizca karekod okutarak baglanilabilir. '
      + 'Alti haneli kod icin telefonun kasayla ayni agda olmasi gerekir.');
    e.status = 400; throw e;
  }

  const pairing = byQr
    ? await lan.redeemQrToken(qr_token, { device_id, device_name, platform })
    : await lan.redeemPairCode(code, { device_id, device_name, platform });

  /*
   * A code minted FOR a member of staff carries the answer to "who is this
   * phone" already, and the till's owner is the one who chose it. A general
   * code does not, so that path still asks for a username and password -
   * whichever door it came through.
   */
  const staff = (byQr && pairing.for_user_id)
    ? await auth.staffSession(pairing.client_id, pairing.for_user_id)
    : await auth.staffLogin(pairing.client_id, username, password, opts.ip || null);

  const device = { device_id, device_name, platform, app_version };
  const tokens = await lan.issueDeviceToken(pairing.client_id, staff.user, device);
  const jwtToken = await auth.issueToken({
    cid: pairing.client_id, uid: staff.user.id, role: staff.user.role,
    name: staff.user.display_name, kind: 'mobile',
  }, '30d');

  log.info('device', 'Telefon eslestirildi', {
    user: staff.user.id, how: byQr ? 'qr' : 'kod', via: opts.qrOnly ? 'relay' : 'lan',
    device: device_name || device_id,
  });

  return { ...tokens, jwt: jwtToken, user: staff.user, perms: staff.perms,
    client_id: pairing.client_id, addresses: lan.addresses() };
}

module.exports = { pair };
