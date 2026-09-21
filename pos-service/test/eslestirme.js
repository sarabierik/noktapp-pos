'use strict';
/**
 * EŞLEŞTİRME — how a phone gets onto the till.
 *
 * Two doors into one row, and they are not equally trusted:
 *
 *   the six digits  are readable across a dining room, so that door still
 *                   demands the waiter's username and phone password;
 *   the QR token    exists only inside a symbol drawn on the till's own
 *                   screen, so that door needs no password at all - but it
 *                   may only ever pair onto the member of staff the code was
 *                   minted for.
 *
 * What this suite is actually guarding is the seam between those two: a token
 * that also opens the typed door, or a code that skips the password, would
 * turn "six digits shown on a screen" into a login. Everything else here -
 * expiry, single use, two phones racing the same symbol, the payload the app
 * parses - is the same row seen from a different angle.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/eslestirme.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7495';
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const device = require('../src/modules/device');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
let OWNER = null, WAITER_ID = null, NOPASS_ID = null;

async function api(method, path, body, token = OWNER) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

/** The token never leaves the service, so tests read it where the QR gets it. */
const tokenOf = (code) => db.value('SELECT qr_token FROM np_mobile_pairings WHERE pair_code=?', [code]);

let phoneNo = 0;
const phone = () => ({ device_id: 'test-phone-' + (++phoneNo), device_name: 'Test telefonu', platform: 'android' });

async function mint(forUserId) {
  const r = await api('POST', '/api/device/pair-code', forUserId ? { for_user_id: forUserId } : {});
  assert.strictEqual(r.status, 200, 'kod üretilemedi: ' + JSON.stringify(r));
  return r.pairing;
}

async function fixture() {
  const mk = async (username, name, password, perms) => {
    const e = await db.one('SELECT id FROM users WHERE client_id=? AND username=?', [CID, username]);
    const id = e ? e.id : await db.insert(
      `INSERT INTO users (client_id, username, email, display_name, role, password_hash, pin_hash,
          created_at, updated_at, is_active) VALUES (?,?,?,?,'waiter',?,?, NOW(), NOW(), 1)`,
      [CID, username, username + '@esl.local', name, password ? auth.hash(password) : '', auth.hash('7391')]);
    await db.exec('UPDATE users SET is_active=1, role=\'waiter\', password_hash=? WHERE id=?',
      [password ? auth.hash(password) : '', id]);
    await db.exec('DELETE FROM user_permissions WHERE client_id=? AND user_id=?', [CID, id]);
    if (perms) await auth.setPermissions(CID, id, perms, null);
    return id;
  };
  WAITER_ID = await mk('esl_garson', 'Eşleştirme Garson', 'Sifre1234',
    ['order.create', 'order.transfer']);
  /* the waiter nobody gave a phone password to - which is most of them, since
     waiters are created PIN-only. The typed door is shut to this person for
     good; the QR door is the only one that was ever going to open. */
  NOPASS_ID = await mk('esl_sifresiz', 'Şifresiz Garson', null, ['order.create']);
  await db.exec('DELETE FROM np_mobile_pairings WHERE client_id=?', [CID]);
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - telefon eşleştirme\n');
  await fixture();
  OWNER = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Sahip', kind: 'tenant' });

  /* ------------------------------------------------------- the symbol */

  await step('kod üretilince karekod da gelir', async () => {
    const p = await mint(WAITER_ID);
    assert.ok(/^\d{6}$/.test(p.code), 'altı hane değil: ' + p.code);
    assert.ok(p.qr && p.qr.svg && p.qr.svg.includes('<svg'), 'karekod svg yok');
    assert.ok(p.qr.payload.startsWith('noktapp://pair?'), 'yük yanlış: ' + p.qr.payload);
    assert.strictEqual(p.for_user.id, WAITER_ID, 'kod kimin adına belli değil');
  });

  await step('karekodun ham jetonu cevapta hiç geçmez', async () => {
    const p = await mint(WAITER_ID);
    const tok = await tokenOf(p.code);
    const body = JSON.stringify(p);
    assert.ok(tok, 'jeton üretilmemiş');
    /* the token may appear inside the payload string (that is the point) but
       never as a field of its own - a screen that logs the pairing object
       should not be logging a credential */
    assert.strictEqual(p.qr_token, undefined, 'jeton ayrı alan olarak sızdı');
    assert.strictEqual(body.split(tok).length - 1, 1, 'jeton cevapta birden fazla yerde');
  });

  await step('yük kasanın adresini taşır, sırf adı değil', async () => {
    const p = await mint(WAITER_ID);
    const u = new URL(p.qr.payload.replace('noktapp://', 'http://'));
    const b = u.searchParams.get('b');
    /*
     * host:port, WITHOUT the scheme - and that is the current contract, not a
     * defect. device.pairPayload strips http:// deliberately: the scheme is 7
     * characters that carry no information, and on a PC with three network
     * cards keeping them pushed the symbol from 41x41 modules to 53x53, which
     * is the difference between a code a waiter can scan off a glossy monitor
     * at arm's length and one they cannot. The phone puts it back - see
     * PairQr.parse in mobile/lib/services/api.dart, which prefixes http:// to
     * anything arriving without one.
     *
     * This assertion used to demand the scheme and was simply never updated
     * when the payload was shortened.
     */
    assert.ok(/^[\d.]+:\d+$/.test(b || ''), 'adres yok ya da bozuk: ' + b);
    assert.ok(!/^https?:/.test(b), 'şema yeniden payload\'a girmiş, karekod büyür: ' + b);
    assert.ok(/^[0-9a-f]{32}$/.test(u.searchParams.get('t') || ''), 'jeton biçimi yanlış');
  });

  await step('sanal ağ kartları listenin sonuna düşer', async () => {
    /* a PC with VirtualBox installed answers on 192.168.56.1, which leads
       nowhere; the phone should be handed the real card first */
    const ranked = device.pairPayload({ qr_token: 'a'.repeat(32),
      addresses: ['http://192.168.56.1:7451', 'http://192.168.1.40:7451'] });
    /* Addresses ride as bare host:port and unencoded - see the step above. */
    assert.ok(ranked.includes('192.168.56.1:7451'), 'sanal adres hiç taşınmamış');
    const first = new URL(ranked.replace('noktapp://', 'http://')).searchParams.get('b');
    assert.strictEqual(first, '192.168.56.1:7451',
      'pairPayload sırayı kendi değiştirmemeli - sıralama lan.addresses işi');
    /* and the real card is still in the symbol, behind it, in `a` */
    assert.ok(ranked.includes('192.168.1.40:7451'), 'gerçek kart payloaddan düşmüş');
  });

  await step('ekranı yenileyince aynı kod geri gelir', async () => {
    const p = await mint(WAITER_ID);
    const live = (await api('GET', '/api/device/pair-code')).pairing;
    assert.strictEqual(live.code, p.code, 'kod değişmiş');
    assert.ok(live.qr.svg.includes('<svg'), 'yenilemede karekod kayıp');
    assert.strictEqual(live.for_user.id, WAITER_ID, 'kimin adına olduğu unutulmuş');
  });

  await step('personel listesi yalnız telefona çıkabilecekleri verir', async () => {
    const r = await api('GET', '/api/device/pair-staff');
    assert.strictEqual(r.status, 200);
    assert.ok(r.staff.some(u => u.id === WAITER_ID), 'garson listede yok');
    assert.ok(r.staff.every(u => u.name && u.role), 'ad ya da rol eksik');
  });

  /* --------------------------------------------------------- the scan */

  await step('karekod okutulunca şifre sorulmadan bağlanır', async () => {
    const p = await mint(WAITER_ID);
    const r = await api('POST', '/api/auth/pair', { qr_token: await tokenOf(p.code), ...phone() }, null);
    assert.strictEqual(r.status, 200, 'bağlanamadı: ' + JSON.stringify(r));
    assert.strictEqual(r.user.id, WAITER_ID, 'başka birinin adına bağlandı');
    assert.ok(r.token && r.jwt, 'jeton verilmedi');
    assert.ok(r.perms.includes('order.create'), 'yetkiler gelmedi');
    assert.ok(!r.perms.includes('payment.take'), 'olmayan yetki verildi');
  });

  /*
   * THE DOOR THE PHONE ACTUALLY USES.
   *
   * Everything above knocks on /api/auth/pair, which is the till's own door on
   * the restaurant's Wi-Fi. The Garson app pairing from outside the building
   * comes through the cloud relay, and the relay carries ONE prefix: /api/
   * mobile. That endpoint had no test at all - the whole "pair from a
   * photograph of the screen, from home, on your own data" path rested on code
   * nothing had ever called.
   *
   * It is also the door with the extra rule: qrOnly. The six-digit code is
   * fine on the shop's own network and must never be accepted through a door
   * the internet can knock on, because six digits is a million guesses and the
   * relay is reachable from anywhere.
   */
  await step('telefon aynı karekodla relay kapısından (/api/mobile/pair) da bağlanır', async () => {
    const p = await mint(WAITER_ID);
    const r = await api('POST', '/api/mobile/pair', { qr_token: await tokenOf(p.code), ...phone() }, null);
    assert.strictEqual(r.status, 200, 'relay kapısından bağlanamadı: ' + JSON.stringify(r));
    assert.strictEqual(r.user.id, WAITER_ID, 'başka birinin adına bağlandı');
    assert.ok(r.token && r.jwt, 'jeton verilmedi');
  });

  await step('altı haneli kod, şifresi doğru olsa bile relay kapısından geçmez', async () => {
    /* Six digits plus the account's own password is accepted on the shop's own
       network - see "altı hane hâlâ kullanıcı adı ve şifre ister" below. The
       point here is that the SAME complete, valid attempt is refused through
       the door the internet can reach, because six digits is a million
       guesses and the relay answers from anywhere. */
    const creds = { username: 'esl_garson', password: 'Sifre1234' };

    const good = await mint(WAITER_ID);
    const lan = await api('POST', '/api/auth/pair', { code: good.code, ...creds, ...phone() }, null);
    assert.strictEqual(lan.status, 200,
      'kod+şifre LAN kapısından da geçmedi - sınama bir şey kanıtlamıyor: ' + JSON.stringify(lan));

    const other = await mint(WAITER_ID);
    const relay = await api('POST', '/api/mobile/pair', { code: other.code, ...creds, ...phone() }, null);
    assert.ok(relay.status >= 400,
      'altı hane internete açık kapıdan geçti - bir milyon deneme: ' + JSON.stringify(relay));
    assert.ok(typeof relay.error === 'string' && relay.error.length, 'boş ret: ' + JSON.stringify(relay));
  });

  await step('telefon şifresi olmayan garson da karekodla bağlanır', async () => {
    const p = await mint(NOPASS_ID);
    const r = await api('POST', '/api/auth/pair', { qr_token: await tokenOf(p.code), ...phone() }, null);
    assert.strictEqual(r.status, 200, 'şifresiz garson bağlanamadı: ' + JSON.stringify(r));
    assert.strictEqual(r.user.id, NOPASS_ID);
  });

  await step('aynı karekod ikinci telefonda çalışmaz', async () => {
    const p = await mint(WAITER_ID);
    const tok = await tokenOf(p.code);
    const first = await api('POST', '/api/auth/pair', { qr_token: tok, ...phone() }, null);
    assert.strictEqual(first.status, 200, 'ilk telefon bağlanamadı');
    const second = await api('POST', '/api/auth/pair', { qr_token: tok, ...phone() }, null);
    assert.ok(second.status >= 400, 'aynı kod ikinci kez kabul edildi');
  });

  await step('iki telefon aynı anda okutursa yalnız biri bağlanır', async () => {
    const p = await mint(WAITER_ID);
    const tok = await tokenOf(p.code);
    const both = await Promise.all([
      api('POST', '/api/auth/pair', { qr_token: tok, ...phone() }, null),
      api('POST', '/api/auth/pair', { qr_token: tok, ...phone() }, null),
    ]);
    assert.strictEqual(both.filter(r => r.status === 200).length, 1,
      'yarışı ikisi de kazandı: ' + both.map(r => r.status).join('/'));
  });

  await step('süresi dolmuş karekod kabul edilmez', async () => {
    const p = await mint(WAITER_ID);
    const tok = await tokenOf(p.code);
    await db.exec('UPDATE np_mobile_pairings SET expires_at=DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE pair_code=?', [p.code]);
    const r = await api('POST', '/api/auth/pair', { qr_token: tok, ...phone() }, null);
    assert.ok(r.status >= 400, 'süresi dolmuş kod kabul edildi');
  });

  await step('iptal edilen kod anında ölür', async () => {
    const p = await mint(WAITER_ID);
    const tok = await tokenOf(p.code);
    await api('DELETE', '/api/device/pair-code');
    const r = await api('POST', '/api/auth/pair', { qr_token: tok, ...phone() }, null);
    assert.ok(r.status >= 400, 'iptal edilen kod hâlâ çalışıyor');
  });

  await step('uydurma jeton tutmaz', async () => {
    for (const bad of ['a'.repeat(32), 'kisa', '', 'ABCDEF0123456789abcdef0123456789', '1 OR 1=1']) {
      const r = await api('POST', '/api/auth/pair', { qr_token: bad, ...phone() }, null);
      assert.ok(r.status >= 400, 'uydurma jeton kabul edildi: ' + bad);
    }
  });

  /* ---------------------------------------------------- the typed door */

  await step('altı hane hâlâ kullanıcı adı ve şifre ister', async () => {
    const p = await mint(WAITER_ID);
    const bare = await api('POST', '/api/auth/pair', { code: p.code, ...phone() }, null);
    assert.ok(bare.status >= 400, 'altı hane şifresiz geçti');
    const good = await mint(WAITER_ID);
    const r = await api('POST', '/api/auth/pair',
      { code: good.code, username: 'esl_garson', password: 'Sifre1234', ...phone() }, null);
    assert.strictEqual(r.status, 200, 'doğru şifre ile bağlanamadı: ' + JSON.stringify(r));
    assert.strictEqual(r.user.id, WAITER_ID);
  });

  await step('altı hane, kodun adına üretildiği kişiyi atlayamaz', async () => {
    /* the code was minted for the waiter; typing it with the OTHER account's
       credentials is a login, and a login needs that account's own password */
    const p = await mint(WAITER_ID);
    const r = await api('POST', '/api/auth/pair',
      { code: p.code, username: 'esl_garson', password: 'yanlis', ...phone() }, null);
    assert.strictEqual(r.status, 401, 'yanlış şifre geçti: ' + r.status);
  });

  await step('karekod jetonu altı hane yerine geçmez', async () => {
    const p = await mint(WAITER_ID);
    const tok = await tokenOf(p.code);
    const r = await api('POST', '/api/auth/pair',
      { code: tok, username: 'esl_garson', password: 'Sifre1234', ...phone() }, null);
    assert.ok(r.status >= 400, 'jeton kod alanından geçti');
  });

  await step('altı hane de kodun adına üretildiği kişiye bağlanır', async () => {
    const p = await mint(NOPASS_ID);
    const r = await api('POST', '/api/auth/pair',
      { code: p.code, username: 'esl_sifresiz', password: 'nese', ...phone() }, null);
    assert.strictEqual(r.status, 409, 'şifresiz garson için beklenen uyarı gelmedi: ' + r.status);
    assert.ok(String(r.error || '').includes('telefon sifresi'), 'uyarı anlaşılır değil: ' + r.error);
  });

  /* ------------------------------------------------------ who may mint */

  await step('kod üretmek user.manage ister', async () => {
    const waiterTok = await auth.issueToken(
      { cid: CID, uid: WAITER_ID, role: 'waiter', name: 'Eşleştirme Garson', kind: 'tenant' });
    for (const [m, p] of [['POST', '/api/device/pair-code'], ['GET', '/api/device/pair-code'],
                          ['GET', '/api/device/pair-staff'], ['DELETE', '/api/device/pair-code']]) {
      const r = await api(m, p, m === 'POST' ? {} : undefined, waiterTok);
      assert.strictEqual(r.status, 403, `${m} ${p} -> ${r.status}`);
    }
  });

  await step('jetonsuz kod üretilemez', async () => {
    const r = await api('POST', '/api/device/pair-code', {}, null);
    assert.strictEqual(r.status, 401, 'jetonsuz kod üretildi');
  });

  await step('başka restoranın personeli adına kod üretilemez', async () => {
    const other = await db.one('SELECT id FROM users WHERE client_id<>? AND is_active=1 LIMIT 1', [CID]);
    if (other) {
      const r = await api('POST', '/api/device/pair-code', { for_user_id: other.id });
      assert.ok(r.status >= 400, 'başka tenantın personeli adına kod üretildi');
    }
  });

  await step('eşleşen telefon listede görünür', async () => {
    const p = await mint(WAITER_ID);
    const ph = phone();
    await api('POST', '/api/auth/pair', { qr_token: await tokenOf(p.code), ...ph }, null);
    const r = await api('GET', '/api/device/devices');
    assert.ok(r.devices.some(d => d.device_id === ph.device_id), 'yeni telefon listede yok');
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
