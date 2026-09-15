'use strict';
/**
 * KİLİT — the brute force limiter.
 *
 * This suite exists because the controls it tests looked finished for a year
 * and were not: users.pin_fail_count and .pin_locked_until were read by the
 * PIN pad and reset in three other places, and nothing in the codebase ever
 * incremented them. app_login_attempts was a table with no writer. A lock that
 * never locks is worse than no lock, because everybody who reads the code
 * believes the problem is handled.
 *
 * So the checks here are deliberately about the WIRING, not the policy: does a
 * wrong PIN actually count, does the count actually lock, does the lock
 * actually expire, and does a correct PIN actually clear it.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/kilit.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7493';
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
let U = {};

async function api(method, path, body, ip = null) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}) },
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

const clear = () => Promise.all([
  db.exec('UPDATE users SET pin_fail_count=0, pin_locked_until=NULL WHERE client_id=?', [CID]),
  db.exec('DELETE FROM app_login_attempts'),
]);
const failCount = (id) => db.value('SELECT pin_fail_count FROM users WHERE id=?', [id]).then(Number);
const lockedAt = (id) => db.one('SELECT pin_locked_until FROM users WHERE id=?', [id]).then(r => r.pin_locked_until);

async function fixture() {
  const mk = async (username, name, pin) => {
    const e = await db.one('SELECT id FROM users WHERE client_id=? AND username=?', [CID, username]);
    const id = e ? e.id : await db.insert(
      `INSERT INTO users (client_id, username, email, display_name, role, password_hash, pin_hash,
          created_at, updated_at, is_active) VALUES (?,?,?,?,'cashier',?,?, NOW(), NOW(), 1)`,
      [CID, username, username + '@kilit.local', name, auth.hash('Sifre1234'), auth.hash(pin)]);
    await db.exec('UPDATE users SET pin_hash=?, is_active=1 WHERE id=?', [auth.hash(pin), id]);
    return id;
  };
  U.a = await mk('kilit_a', 'Kilit Kasiyer', '7711');
  U.b = await mk('kilit_b', 'Kilit Garson', '7722');
  await clear();
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - kaba kuvvet kilidi\n');
  await fixture();

  await step('doğru PIN girişi kabul eder', async () => {
    const r = await api('POST', '/api/auth/pin', { pin: '7711' }, '10.9.0.1');
    assert.strictEqual(r.status, 200, JSON.stringify(r).slice(0, 120));
    assert.strictEqual(r.user.username, 'kilit_a');
  });

  await step('yanlış PIN artık kayda geçiyor - eskiden hiçbir yere yazılmıyordu', async () => {
    /* the pad cannot know whose PIN was guessed, so the record is per ADDRESS.
       Before this change nothing was written anywhere and nothing ever counted. */
    await clear();
    const r = await api('POST', '/api/auth/pin', { pin: '0000' }, '10.9.0.2');
    assert.strictEqual(r.status, 401, 'yanlış PIN kabul edildi');
    const n = Number(await db.value(
      "SELECT COUNT(*) FROM app_login_attempts WHERE ip='10.9.0.2' AND ok=0"));
    assert.strictEqual(n, 1, `deneme kaydedilmedi: ${n}`);
  });

  await step('PIN pad yanlış denemede KİMSEYİ kilitlemez - hizmet reddi olurdu', async () => {
    /*
     * The first version of this limiter locked every account on a wrong guess,
     * because the pad takes no username. Five wrong PINs from the car park
     * would then have shut the whole restaurant out mid-service. The pad is
     * guarded by the address limit instead; this check is here so nobody
     * reintroduces the other behaviour.
     */
    await clear();
    for (let i = 0; i < auth.PIN_MAX_FAILS + 2; i++) {
      await api('POST', '/api/auth/pin', { pin: String(1000 + i) }, '10.9.0.3');
    }
    assert.strictEqual(await failCount(U.a), 0, 'pad yanlış denemesi hesaba yazıldı');
    assert.strictEqual(await lockedAt(U.a), null, 'pad yanlış denemesi hesabı kilitledi');
    const still = await api('POST', '/api/auth/pin', { pin: '7711' }, '10.9.0.31');
    assert.strictEqual(still.status, 200, 'gerçek kasiyer içeri giremiyor: ' + still.status);
  });

  await step('adı verilen giriş yolu hesabı kilitler', async () => {
    await clear();
    for (let i = 0; i < auth.PIN_MAX_FAILS; i++) {
      await auth.staffLogin(CID, 'kilit_a', 'yanlis' + i, '10.9.0.35').catch(() => {});
    }
    const until = await lockedAt(U.a);
    assert.ok(until && new Date(until) > new Date(), 'hesap kilitlenmedi: ' + until);
  });

  await step('kilitliyken DOĞRU şifre bile girmez - kilit gerçekten kilit', async () => {
    await assert.rejects(
      () => auth.staffLogin(CID, 'kilit_a', 'Sifre1234', '10.9.0.36'),
      (e) => e.status === 429 && e.code === 'ACCOUNT_LOCKED',
      'kilitli hesap doğru şifre ile girdi');
  });

  await step('kilitli hesap PIN pad’den de giremez', async () => {
    const r = await api('POST', '/api/auth/pin', { pin: '7711' }, '10.9.0.37');
    assert.strictEqual(r.status, 429, 'kilit sadece bir kapıda tutuyor: ' + r.status);
    assert.strictEqual(r.code || '', 'PIN_LOCKED', JSON.stringify(r).slice(0, 120));
  });

  await step('kilit süresi dolunca kendiliğinden açılır', async () => {
    await db.exec('UPDATE users SET pin_locked_until=DATE_SUB(NOW(), INTERVAL 1 MINUTE), pin_fail_count=4 WHERE id=?', [U.a]);
    await db.exec('DELETE FROM app_login_attempts');
    const r = await api('POST', '/api/auth/pin', { pin: '7711' }, '10.9.0.4');
    assert.strictEqual(r.status, 200, 'süresi dolmuş kilit hâlâ tutuyor: ' + JSON.stringify(r).slice(0, 120));
  });

  await step('doğru giriş sayacı sıfırlar', async () => {
    assert.strictEqual(await failCount(U.a), 0, 'sayaç sıfırlanmadı');
    assert.strictEqual(await lockedAt(U.a), null, 'kilit kalktı ama alan dolu');
  });

  await step('adres bazlı sınır: çok deneyen IP engellenir', async () => {
    await clear();
    let blocked = 0;
    for (let i = 0; i < auth.IP_MAX_FAILS + 2; i++) {
      const r = await api('POST', '/api/auth/pin', { pin: '000' + (i % 10) }, '10.9.9.9');
      if (r.status === 429 && r.code === 'TOO_MANY_ATTEMPTS') blocked++;
    }
    assert.ok(blocked > 0, 'adres hiç engellenmedi');
  });

  await step('engellenen adres başkasını kilitlemez - başka IP çalışır', async () => {
    await db.exec('UPDATE users SET pin_fail_count=0, pin_locked_until=NULL WHERE client_id=?', [CID]);
    const r = await api('POST', '/api/auth/pin', { pin: '7722' }, '10.9.0.50');
    assert.strictEqual(r.status, 200, 'temiz adres de engellendi: ' + JSON.stringify(r).slice(0, 120));
  });

  await step('denemeler kayda geçiyor - tablonun artık bir yazarı var', async () => {
    const n = Number(await db.value('SELECT COUNT(*) FROM app_login_attempts'));
    assert.ok(n > 0, 'app_login_attempts hâlâ boş');
    const bad = Number(await db.value('SELECT COUNT(*) FROM app_login_attempts WHERE ok=0'));
    assert.ok(bad > 0, 'başarısız denemeler kaydedilmemiş');
  });

  await step('telefon şifresi yolu da sayılıyor', async () => {
    await clear();
    const before = Number(await db.value('SELECT COUNT(*) FROM app_login_attempts WHERE ok=0'));
    await assert.rejects(() => auth.staffLogin(CID, 'kilit_a', 'yanlis-sifre', '10.9.0.77'));
    const after = Number(await db.value('SELECT COUNT(*) FROM app_login_attempts WHERE ok=0'));
    assert.strictEqual(after, before + 1, 'telefon girişi kaydedilmedi');
  });

  await step('yetkili PIN (override) da sınırlı', async () => {
    await clear();
    await assert.rejects(() => auth.overridePin(CID, '0000', null, '10.9.0.88'));
    const n = Number(await db.value(
      "SELECT COUNT(*) FROM app_login_attempts WHERE ip='10.9.0.88' AND ok=0"));
    assert.ok(n > 0, 'override denemesi kaydedilmedi');
  });

  await step('güvenlik başlıkları her cevapta', async () => {
    const res = await fetch(BASE + '/api/health');
    for (const h of ['x-content-type-options', 'x-frame-options', 'content-security-policy']) {
      assert.ok(res.headers.get(h), h + ' başlığı yok');
    }
    assert.strictEqual(res.headers.get('x-powered-by'), null, 'x-powered-by hâlâ açık');
  });

  await step('CORS artık her köken yansıtmıyor', async () => {
    const res = await fetch(BASE + '/api/health', { headers: { Origin: 'https://kotu-site.example' } });
    const allow = res.headers.get('access-control-allow-origin');
    assert.notStrictEqual(allow, 'https://kotu-site.example', 'yabancı köken yansıtıldı');
  });

  await clear();
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
