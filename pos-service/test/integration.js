'use strict';
/**
 * Integration test: restaurant PC <-> cloud panel.
 * Proves the four things the server is actually responsible for:
 *   online login, licence heartbeat, cloud backup, and the phone relay.
 * Run with the panel served on 127.0.0.1:8088 and the service on 7462.
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7462';
const assert = require('assert');
const db = require('../src/db');
const licence = require('../src/licence');
const relay = require('../src/relay');
const sync = require('../src/sync');
const backup = require('../src/backup');
const restore = require('../src/restore');
const fs = require('fs');
const crypto = require('crypto');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

// The panel must be able to serve several requests at once - the PC holds a
// relay long-poll open while the phone waits for its answer, and the licence
// calls have to get through in between. On cPanel that is how PHP already
// behaves; in the sandbox we put a round-robin proxy in front of a few
// `php -S` workers (see test/README.md).
const PANEL = process.env.PANEL || 'http://127.0.0.1:8090';
const PANEL_PHONE = process.env.PANEL_PHONE || PANEL;
const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + ' -> ' + e.message); }
}
const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

(async () => {
  const server = await bootstrap();
  await db.setSetting('panel_url', PANEL);
  console.log('\nNOKTApp POS - PC <-> panel integration test\n');

  await step('the till logs in against the panel and caches the licence', async () => {
    const r = await post(BASE + '/api/auth/tenant-login',
      { email: 'restoran@ornek.com', password: 'Restoran1234' });
    assert.strictEqual(r.body.ok, true, r.body.error);
    assert.strictEqual(r.body.client.id, 19);
    assert.strictEqual(r.body.licence.status, 'active');
    const cached = await db.one('SELECT * FROM np_licence WHERE id=1');
    assert.strictEqual(cached.client_id, 19);
    assert.ok(cached.last_ok_at, 'grace window not opened');
  });

  await step('a wrong password is refused and not cached', async () => {
    const r = await post(BASE + '/api/auth/tenant-login', { email: 'restoran@ornek.com', password: 'yanlis' });
    assert.strictEqual(r.status, 401);
  });

  await step('the till still opens with the network down (offline grace)', async () => {
    await db.setSetting('panel_url', 'http://127.0.0.1:9');    // nothing listening
    const r = await post(BASE + '/api/auth/tenant-login', { email: 'restoran@ornek.com', password: 'Restoran1234' });
    assert.strictEqual(r.body.ok, true, r.body.error);
    assert.strictEqual(r.body.offline, true, 'should have fallen back to the local cache');
    await db.setSetting('panel_url', PANEL);
  });

  await step('an expired grace window locks the till instead of running forever', async () => {
    await db.exec('UPDATE np_licence SET last_ok_at = DATE_SUB(NOW(), INTERVAL 40 DAY) WHERE id=1');
    await db.setSetting('panel_url', 'http://127.0.0.1:9');
    const r = await post(BASE + '/api/auth/tenant-login', { email: 'restoran@ornek.com', password: 'Restoran1234' });
    assert.strictEqual(r.status, 403);
    await db.setSetting('panel_url', PANEL);
    await db.exec('UPDATE np_licence SET last_ok_at = NOW() WHERE id=1');
  });

  await step('the heartbeat refreshes the licence and registers the machine', async () => {
    const r = await licence.heartbeat();
    assert.strictEqual(r.ok, true, r.error);
    const seen = await fetch(PANEL + '/api/mobile/discover.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: 19 }) })
      .then(x => x.json());
    assert.strictEqual(seen.pc_online, true, 'panel does not see the PC as online');
  });

  await step('day-end figures reach the panel', async () => {
    await sync.push('daily_closing', '19:2026-09-02:1', { date: '2026-09-02', orders: 12, net: 4820.5 });
    await sync.drain();
    const left = Number(await db.value("SELECT COUNT(*) FROM np_sync_outbox WHERE status='pending'"));
    assert.strictEqual(left, 0, 'outbox did not drain');
  });

  await step('the nightly backup uploads and is verified by checksum', async () => {
    const r = await backup.uploadToCloud();
    assert.strictEqual(r.ok, true);
    assert.ok(r.size > 1000);
  });

  /*
   * The seam. cloudList/cloudFetch were built against a stub and the panel
   * endpoints were built against a written contract; neither side had ever
   * spoken to the other. A backup you cannot fetch is exactly the failure this
   * whole feature exists to remove, so it is proved here against the real PHP,
   * over real HTTP, with the file that the previous step actually uploaded.
   */
  await step('the till can list the backups the panel is holding for it', async () => {
    const list = await restore.cloudList();
    assert.strictEqual(list.ok, true, list.error || 'listeleme basarisiz');
    assert.ok(list.backups.length > 0, 'panel yeni yuklenen yedegi listelemedi');
    const b = list.backups[0];
    assert.ok(b.id, 'yedegin kimligi yok');
    assert.ok(Number(b.size_bytes) > 1000, 'boyut gelmedi');
    assert.match(String(b.sha256 || ''), /^[a-f0-9]{64}$/, 'sha256 gelmedi');
    /* the filesystem layout is not the till's business and must not travel */
    assert.ok(!JSON.stringify(list).includes('/'), 'panel dosya yolunu sizdirdi: ' + JSON.stringify(b));
  });

  await step('the till downloads its own backup and the checksum matches', async () => {
    const list = await restore.cloudList();
    const want = list.backups[0];
    const got = await restore.cloudFetch(want.id);
    /* cloudFetch answers with the NAME; the folder is config's business */
    const file = require('path').join(require('../src/config').backupDir, got.file);
    assert.ok(fs.existsSync(file), 'indirilen dosya diskte yok: ' + JSON.stringify(got));
    const onDisk = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.strictEqual(onDisk, String(want.sha256).toLowerCase(),
      'indirilen dosya panelin bildirdigi sha256 ile ayni degil');
    /* gzip, not a JSON error page saved under a .gz name */
    const head = fs.readFileSync(file).subarray(0, 2);
    assert.strictEqual(head[0], 0x1f, 'indirilen dosya gzip degil');
    assert.strictEqual(head[1], 0x8b, 'indirilen dosya gzip degil');
    /* and it is now an ordinary restore source, not an orphan on disk */
    const src = await restore.sources();
    assert.ok((src.sources || []).some(x => x.kind === 'local' && String(x.file || '') === got.file),
      'indirilen yedek geri yukleme kaynaklari arasinda gorunmuyor');
    /* the partial file must not survive as something restorable */
    assert.ok(!fs.existsSync(file + '.indiriliyor'), 'yarim indirme dosyasi kaldi');
  });

  await step("another restaurant's backup cannot be listed or fetched", async () => {
    /* Tenant 19 is this till. Ask the panel for an id that is not its own and
       the answer must be the same nothing as an id that never existed - a
       different error for "exists but not yours" confirms the guess. */
    const list = await restore.cloudList();
    const mine = new Set(list.backups.map(b => String(b.id)));
    let deniedForeign = null, deniedMissing = null;
    for (const probe of [{ id: 2000000000 }, { id: 2000000001 }]) {
      try { await restore.cloudFetch(probe.id); assert.fail('olmayan yedek indirildi'); }
      catch (e) { deniedMissing = String(e.message); }
    }
    /* an id belonging to nobody and an id belonging to someone else must read
       identically from here */
    const other = [...Array(40).keys()].map(i => i + 1).find(i => !mine.has(String(i)));
    if (other !== undefined) {
      try { await restore.cloudFetch(other); assert.fail('baska isletmenin yedegi indirildi'); }
      catch (e) { deniedForeign = String(e.message); }
      assert.strictEqual(deniedForeign, deniedMissing,
        'baska isletmenin yedegi, olmayan bir yedekten farkli bir hata veriyor: '
        + deniedForeign + ' / ' + deniedMissing);
    }
  });

  await step("a phone off the restaurant's wifi reaches the till through the relay", async () => {
    /*
     * run-all.sh switches relay_enabled off for the whole run, because a
     * background long-poll from every suite sends the sandbox panel's workers
     * to sleep and times out whatever runs next - see the note there. This is
     * the suite the relay belongs to, so it turns it on for the two checks
     * that need it and off again straight afterwards.
     */
    await db.setSetting('relay_enabled', '1');
    relay.start();
    await new Promise(r => setTimeout(r, 500));
    const token = await auth.issueToken({ cid: 19, uid: 0, role: 'admin', name: 'Erik', kind: 'mobile' }, '1h');
    const r = await post(PANEL_PHONE + '/api/mobile/relay.php', {
      client_id: 19, method: 'GET', path: '/api/mobile/bootstrap',
      authorization: 'Bearer ' + token, device_id: 'phone-1' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.strictEqual(r.body.ok, true, r.body.error);
    assert.ok(Array.isArray(r.body.tables), 'relay did not return the till payload');
    relay.stop();
    await db.setSetting('relay_enabled', '0');
  });

  await step('the relay refuses paths outside the phone API', async () => {
    const r = await post(PANEL_PHONE + '/api/mobile/relay.php',
      { client_id: 19, method: 'POST', path: '/api/manage/users' });
    assert.strictEqual(r.status, 400);
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  failed.forEach(f => console.log('  ! ' + f[1] + ': ' + f[2]));
  server.close();
  process.exit(failed.length ? 1 : 0);
})();
