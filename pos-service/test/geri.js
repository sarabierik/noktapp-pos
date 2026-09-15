'use strict';
/**
 * Geri yükleme - restore.
 *
 * Against the real MariaDB, the real HTTP service and real dumps taken by the
 * real backup code. Nothing here is mocked, because every bug this feature can
 * have is a bug in what actually happens to a database:
 *
 *   - a restore that does not bring the data back;
 *   - a backup from ANOTHER restaurant loading into this till, which is worse
 *     than any data loss restore repairs;
 *   - a half a dump breaking the live database on its way to being rejected;
 *   - an old dump restored and left on an old schema, so the till boots into
 *     a column that is not there;
 *   - the pre-restore snapshot - the only copy of what was just erased -
 *     quietly deleted by the two-week prune;
 *   - a waiter, or an owner who did not type their password, reaching any of
 *     it;
 *   - the print agent and the pollers left stopped afterwards, so the
 *     restaurant prints nothing and nobody connects it to the restore.
 *
 * This suite drops and reloads the live database several times, so it runs
 * LAST in test/run-all.sh. It leaves the database as the last restore left it,
 * which is the state the run started in.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/geri.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7484';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { execFileSync } = require('child_process');
const db = require('../src/db');
const auth = require('../src/auth');
const config = require('../src/config');
const backup = require('../src/backup');
const restore = require('../src/restore');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
const PW = 'Sahip1234';                 // the owner password this suite types back
const DIR = config.backupDir;
let OWNER = null;   // tenant login - the only session a restore is offered to
let WAITER = null;  // staff, role waiter - must not reach any of it
let MANAGER = null; // staff, role admin - a manager, and still not the owner

async function api(method, p, body, token = OWNER) {
  const res = await fetch(BASE + p, {
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const base = (p) => path.basename(p);

/* --------------------------------------------------------- the client */
/*
 * The suite talks to MariaDB directly as well as through the service, to build
 * the dumps a restaurant would never produce on purpose: one from a different
 * licence, one from an older schema, one cut in half.
 */
const CONN = ['--host=' + config.db.host, '--port=' + config.db.port, '--user=' + config.db.user,
  '--password=' + config.db.password, '--default-character-set=utf8mb4'];
const my = (args, opts = {}) =>
  execFileSync('mariadb', CONN.concat(args), { maxBuffer: 512 * 1024 * 1024, ...opts });
const myDump = (name) => execFileSync('mariadb-dump',
  CONN.concat(['--single-transaction', '--routines', '--triggers', '--events', name]),
  { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' });

/** Build a doctored dump: load a snapshot into a scratch database, change it, dump it back. */
async function doctoredDump(scratch, sql, outName) {
  const snap = await backup.run('manual');
  my(['--execute=DROP DATABASE IF EXISTS `' + scratch + '`; CREATE DATABASE `' + scratch + '` CHARACTER SET utf8mb4']);
  my([scratch], { input: zlib.gunzipSync(fs.readFileSync(snap.file)) });
  my([scratch, '--execute=' + sql]);
  const out = path.join(DIR, outName);
  fs.writeFileSync(out, zlib.gzipSync(myDump(scratch)));
  my(['--execute=DROP DATABASE `' + scratch + '`']);
  return outName;
}

const dbExists = (name) => Number(execFileSync('mariadb', CONN.concat([
  '--batch', '--skip-column-names',
  '--execute=SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name=\'' + name + '\'',
])).toString().trim());

/** The row counts a refused restore must not have changed. */
async function counts() {
  return {
    orders: Number(await db.value('SELECT COUNT(*) FROM orders')),
    categories: Number(await db.value('SELECT COUNT(*) FROM categories')),
    users: Number(await db.value('SELECT COUNT(*) FROM users')),
    licence: await db.value('SELECT client_id FROM np_licence WHERE id=1'),
    marker: await db.getSetting('geri_test_marker', null),
  };
}

/**
 * The migration is applied here rather than assumed - the desktop shell re-runs
 * every file in database/migrations on each start and a test run has no shell.
 * The file is written to be idempotent, so this is exactly what the shell does.
 */
async function migrate() {
  const file = path.join(__dirname, '..', '..', 'database', 'migrations', '2026-09-10-geri.sql');
  const sql = fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await db.exec(stmt); } catch (_) { /* already applied */ }
  }
}

/**
 * Is the print agent actually running?
 *
 * Not by asking the module - a stopped interval is not visible from outside -
 * but by putting work in its queue and watching the queue move. A job for a
 * client with no printer is marked 'failed' by the worker, which is a real
 * observation of a timer that is really ticking, and it is the cheapest one
 * the print agent offers.
 */
async function printAgentAlive(waitMs = 9000) {
  await db.exec("UPDATE print_jobs SET status='failed' WHERE status='pending'");
  const id = await db.insert(
    `INSERT INTO print_jobs (client_id, job_type, order_id, content, status, created_at)
     VALUES (?,?,?,?, 'pending', NOW())`, [990019, 'receipt', 0, Buffer.from('geri testi').toString('base64')]);
  for (let i = 0; i < waitMs / 250; i++) {
    await sleep(250);
    const st = await db.value('SELECT status FROM print_jobs WHERE id=?', [id]);
    if (st && st !== 'pending') return true;
  }
  return false;
}

/* ------------------------------------------------------------ fixture */
async function fixture() {
  const lic = await db.one('SELECT client_id FROM np_licence WHERE id=1');
  if (!lic) {
    await db.exec(
      `INSERT INTO np_licence (id, client_id, company_name, licence_key, status, seats, grace_days,
          last_ok_at, last_check_at)
       VALUES (1,?,?,?,'active',3,7,NOW(),NOW())`, [CID, 'Geri Testi Restoran', 'GERI-KEY']);
  } else if (Number(lic.client_id) !== CID) {
    await db.exec('UPDATE np_licence SET client_id=? WHERE id=1', [CID]);
  }
  /* The owner's password, cached the way a successful online login caches it -
     which is the hash the restore endpoint compares against. */
  await db.exec('DELETE FROM np_login_cache WHERE client_id=?', [CID]);
  await db.exec(
    `INSERT INTO np_login_cache (client_id, email, password_hash, display_name, role, cached_at)
     VALUES (?,?,?,?,?,NOW())`, [CID, 'sahip@geritesti.com', bcrypt.hashSync(PW, 10), 'Sahip', 'admin']);

  const catalog = require('../src/modules/catalog');
  await db.exec('DELETE FROM users WHERE client_id=? AND username IN (?,?)', [CID, 'geriservis', 'gerisahip']);
  const waiterId = await catalog.saveUser(CID, {
    display_name: 'Geri Garson', username: 'geriservis', role: 'waiter', pin: '7731', password: 'garson1234',
  }, null);
  const ownerId = await catalog.saveUser(CID, {
    display_name: 'Geri Sahip', username: 'gerisahip', role: 'admin', pin: '7732', password: PW,
  }, null);

  OWNER = await auth.issueToken({ cid: CID, uid: ownerId, role: 'admin', name: 'Sahip', kind: 'tenant' });
  WAITER = await auth.issueToken({ cid: CID, uid: waiterId, role: 'waiter', name: 'Garson', kind: 'staff' });
  MANAGER = await auth.issueToken({ cid: CID, uid: ownerId, role: 'admin', name: 'Müdür', kind: 'staff' });

  await db.setSetting('app_version', '2.0.0');
  await db.setSetting('backup_keep_days', 14);
  await db.setSetting('geri_test_marker', 'YEDEKTEKI_DEGER');
  /* Turkish on purpose: a dump that mangles ı, ş and ğ is a dump that has
     silently rewritten every product name in the menu. */
  await db.exec('DELETE FROM categories WHERE client_id=? AND name LIKE ?', [CID, 'Geri Testi%']);
  for (const n of ['Geri Testi Çorbalar', 'Geri Testi Kızartmalar', 'Geri Testi İçecekler']) {
    await db.insert('INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,90,1,1,1)',
      [CID, n]);
  }
  await restore.rememberIdentity();
}

/* --------------------------------------------------------------- run */
(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  await migrate();
  await fixture();
  console.log('\nNOKTApp POS - geri yükleme\n');

  /* Kept across the checks: the good dump everything else is measured against. */
  const good = base((await backup.run('manual')).file);
  const beforeAll = await counts();

  /*
   * The bug a real till found and this suite could not: everything here runs
   * with mariadb on the PATH, so the resolution never had to work. On a
   * customer's PC there is no MariaDB on the PATH - the engine is downloaded
   * into the program folder after the installer has run - and the first
   * preview ever attempted died with `spawn mariadb.exe ENOENT`. Backups had
   * been fine for months, because main.js hands the DUMP binary over by name
   * and only the restore path had to guess.
   */
  await step('veritabani araci, calistigi bilinen dokum aracinin yanindan bulunur', async () => {
    const backupMod = require('../src/backup');
    const fake = path.join(DIR, 'sahte-bin');
    fs.mkdirSync(fake, { recursive: true });
    const exe = process.platform === 'win32' ? 'mariadb.exe' : 'mariadb';
    const dumpExe = process.platform === 'win32' ? 'mariadb-dump.exe' : 'mariadb-dump';
    fs.writeFileSync(path.join(fake, exe), '');
    fs.writeFileSync(path.join(fake, dumpExe), '');

    const keepDump = process.env.NOKTAPP_DUMP_BIN;
    const keepClient = process.env.NOKTAPP_CLIENT_BIN;
    try {
      delete process.env.NOKTAPP_CLIENT_BIN;
      process.env.NOKTAPP_DUMP_BIN = path.join(fake, dumpExe);
      assert.strictEqual(backupMod.toolPath('mariadb'), path.join(fake, exe),
        'istemci, dokum aracinin yanindan bulunamadi');

      /* and an explicit override still wins over everything */
      process.env.NOKTAPP_CLIENT_BIN = '/bin/true';
      assert.strictEqual(backupMod.toolPath('mariadb', process.env.NOKTAPP_CLIENT_BIN), '/bin/true',
        'acikca verilen yol yok sayildi');
    } finally {
      if (keepDump === undefined) delete process.env.NOKTAPP_DUMP_BIN; else process.env.NOKTAPP_DUMP_BIN = keepDump;
      if (keepClient === undefined) delete process.env.NOKTAPP_CLIENT_BIN; else process.env.NOKTAPP_CLIENT_BIN = keepClient;
    }
  });

  await step('araci bulunamayan bir yedek "yedek bozuk" diye suclanmaz', async () => {
    const keep = process.env.NOKTAPP_CLIENT_BIN;
    process.env.NOKTAPP_CLIENT_BIN = path.join(DIR, 'boyle-bir-sey-yok-mariadb');
    try {
      const p = (await api('POST', '/api/manage/restore/preview', { file: good })).preview;
      assert.strictEqual(p.usable, false, 'araci olmadan yedek kullanilabilir sayildi');
      const said = p.problems.join(' ');
      assert.ok(!/ENOENT|spawn/i.test(said), 'ham Node hatasi kullaniciya gosteriliyor: ' + said);
      assert.ok(said.includes('Yedeğinizde bir sorun yok'),
        'kullaniciya yedeginin saglam oldugu soylenmiyor: ' + said);
    } finally {
      if (keep === undefined) delete process.env.NOKTAPP_CLIENT_BIN; else process.env.NOKTAPP_CLIENT_BIN = keep;
    }
  });

  await step('yedek listesi yerel dosyaları ve kullanılabilirliğini gösterir', async () => {
    const r = await api('GET', '/api/manage/restore/sources');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const row = r.sources.find(s => s.file === good);
    assert.ok(row, 'the snapshot just taken is not in the list');
    assert.strictEqual(row.kind, 'local');
    assert.ok(row.size_bytes > 1000, 'no size on the listed backup');
    assert.ok(row.created_at, 'no date on the listed backup');
    assert.strictEqual(row.usable, true, 'a good snapshot is listed as unusable');
  });

  await step('önizleme yedeğin içini söyler ve canlı veritabanına dokunmaz', async () => {
    const r = await api('POST', '/api/manage/restore/preview', { file: good });
    const p = r.preview;
    assert.strictEqual(p.usable, true, 'a fresh snapshot did not verify: ' + JSON.stringify(p.problems));
    assert.strictEqual(Number(p.client_id), CID, 'preview read the wrong licence');
    assert.strictEqual(p.app_version, '2.0.0', 'the dump does not carry the app version');
    assert.ok(p.counts.orders >= 0 && p.counts.users > 0, 'preview counted nothing: ' + JSON.stringify(p.counts));
    assert.strictEqual(dbExists(config.db.database + '_geri'), 0, 'the temporary database was left behind');
    assert.deepStrictEqual(await counts(), beforeAll, 'a preview changed the live database');
  });

  await step('gidiş dönüş: veri bozulur, geri yüklenir, geri gelir', async () => {
    /*
     * The whole feature in one check. The data is changed the way a bad day
     * changes it - rows deleted, a value overwritten - and the restore has to
     * put back exactly what was there when the snapshot was taken.
     */
    await db.exec('DELETE FROM categories WHERE client_id=? AND name LIKE ?', [CID, 'Geri Testi%']);
    await db.setSetting('geri_test_marker', 'FELAKET');
    const oid = await db.value('SELECT MAX(id) FROM orders');
    /* A bill has rows hanging off it in half a dozen tables; if this install's
       newest one will not come out cleanly, the categories and the marker are
       enough to prove the round trip. */
    try {
      await db.exec('DELETE FROM order_items WHERE order_id=?', [oid]);
      await db.exec('DELETE FROM orders WHERE id=?', [oid]);
    } catch (_) {}
    const broken = await counts();
    assert.notDeepStrictEqual(broken, beforeAll, 'the fixture did not manage to break anything');

    const r = await api('POST', '/api/manage/restore/run', { file: good, password: PW, reason: 'test' });
    assert.strictEqual(r.status, 200, 'restore refused: ' + JSON.stringify(r));
    assert.ok(r.pre_restore && r.pre_restore.file, 'no pre-restore snapshot reported');

    assert.deepStrictEqual(await counts(), beforeAll, 'the data did not come back');
    const cat = await db.one('SELECT name FROM categories WHERE client_id=? AND name LIKE ? ORDER BY id LIMIT 1',
      [CID, 'Geri Testi%']);
    assert.strictEqual(cat && cat.name, 'Geri Testi Çorbalar',
      'Turkish characters did not survive the round trip: ' + JSON.stringify(cat));
  });

  /*
   * A COUNT is a weak witness. Rows deleted and rows returned prove the INSERTs
   * ran; they say nothing about a value that was OVERWRITTEN, because an
   * overwritten row is still exactly one row before and after. A restore that
   * only re-inserted what was missing would pass every check above and leave a
   * renamed product renamed - which is the first thing anybody notices, because
   * renaming something is how a person tests a restore.
   *
   * So: change a name, restore, and demand the OLD name back.
   */
  await step('üzerine yazılan bir ad geri yüklemede eski haline döner', async () => {
    const before = await db.one(
      'SELECT id, name FROM products WHERE client_id=? ORDER BY id LIMIT 1', [CID]);
    assert.ok(before, 'testte ürün yok');
    const snap = base((await backup.run('manual')).file);

    await db.exec('UPDATE products SET name=? WHERE id=?', ['TEST SIL', before.id]);
    const changed = await db.one('SELECT name FROM products WHERE id=?', [before.id]);
    assert.strictEqual(changed.name, 'TEST SIL', 'the rename did not take');

    const r = await api('POST', '/api/manage/restore/run', { file: snap, password: PW });
    assert.strictEqual(r.status, 200, 'restore refused: ' + JSON.stringify(r));

    const after = await db.one('SELECT name FROM products WHERE id=?', [before.id]);
    assert.strictEqual(after && after.name, before.name,
      'geri yüklemeden sonra ad hâlâ degismis: ' + JSON.stringify(after));
  });

  /*
   * And the other half of the same confusion: restoring a snapshot taken AFTER
   * the change cannot undo it, and must not pretend to. What the product owes
   * the person here is not magic but a straight answer about which moment they
   * are going back to.
   */
  await step('degisiklikten SONRA alinan yedek o degisikligi geri almaz', async () => {
    const row = await db.one('SELECT id, name FROM products WHERE client_id=? ORDER BY id LIMIT 1', [CID]);
    await db.exec('UPDATE products SET name=? WHERE id=?', ['SONRAKI AD', row.id]);
    const snapAfter = base((await backup.run('manual')).file);

    const r = await api('POST', '/api/manage/restore/run', { file: snapAfter, password: PW });
    assert.strictEqual(r.status, 200, JSON.stringify(r));

    const after = await db.one('SELECT name FROM products WHERE id=?', [row.id]);
    assert.strictEqual(after.name, 'SONRAKI AD',
      'sonraki yedek beklenmedik bir sekilde eski adi getirdi');

    /* put the fixture back so later checks measure what they think they do */
    await db.exec('UPDATE products SET name=? WHERE id=?', [row.name, row.id]);
  });

  await step('geri yükleme denetim kaydına yazılır', async () => {
    /* The newest row is whichever restore ran last, and several run in this
       suite. What is being checked is that the restore of `good` left a
       complete record, so find THAT one rather than assuming it is on top. */
    const rows = await db.query("SELECT * FROM audit_logs WHERE action='db.restore' ORDER BY id DESC LIMIT 20");
    assert.ok(rows.length, 'the restore left no audit row');
    const parsed = rows.map(r => ({
      row: r, meta: typeof r.meta_json === 'string' ? JSON.parse(r.meta_json) : r.meta_json }));
    const hit = parsed.find(p => p.meta && p.meta.file === good);
    assert.ok(hit, 'no audit row names the restored file; saw '
      + JSON.stringify(parsed.map(p => p.meta && p.meta.file)));
    const row = hit.row, meta = hit.meta;
    assert.ok(/^[a-f0-9]{64}$/.test(meta.sha256), 'no sha256 in the audit row');
    assert.ok(meta.pre_restore_file, 'the audit row does not name the pre-restore snapshot');
    assert.ok(meta.pre_restore_backup_id, 'the audit row does not name the pre-restore np_backups row');
    assert.ok(row.created_at, 'no timestamp');
  });

  await step('başarılı geri yüklemeden sonra yazan servisler çalışıyor', async () => {
    assert.strictEqual(restore.status().writers_running, true, 'the writers were left stopped');
    assert.strictEqual(await printAgentAlive(), true, 'the print agent did not pick up a job after the restore');
  });

  await step('başka bir işletmenin yedeği reddedilir, canlı veri el değmeden kalır', async () => {
    /*
     * The check that matters most. A dump from another licence loading here
     * would put one restaurant's customers, staff and takings inside another's
     * till - and unlike lost data, nobody would notice for weeks.
     */
    const foreign = await doctoredDump('noktapp_pos_baska',
      "UPDATE np_licence SET client_id=98765, company_name='Komşu Restoran' WHERE id=1",
      'komsu-restoran-yedek.sql.gz');
    const before = await counts();

    const p = (await api('POST', '/api/manage/restore/preview', { file: foreign })).preview;
    assert.strictEqual(p.usable, false, 'a foreign backup verified as usable');
    assert.ok(p.problems.join(' ').includes('başka bir işletmeye'),
      'the refusal does not say whose backup it is: ' + JSON.stringify(p.problems));
    assert.strictEqual(Number(p.client_id), 98765, 'preview did not read the foreign licence');

    const r = await api('POST', '/api/manage/restore/run', { file: foreign, password: PW });
    assert.strictEqual(r.ok, false, 'a foreign backup was RESTORED');
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(await counts(), before, 'the live database changed while refusing a foreign backup');
    assert.strictEqual(Number(await db.value('SELECT client_id FROM np_licence WHERE id=1')), CID,
      'the licence row is no longer ours');
  });

  await step('yarım / bozuk yedek geçici veritabanında reddedilir', async () => {
    const whole = fs.readFileSync(path.join(DIR, good));
    const half = path.join(DIR, 'yarim-yedek.sql.gz');
    fs.writeFileSync(half, whole.subarray(0, Math.floor(whole.length * 0.55)));
    const before = await counts();

    const p = (await api('POST', '/api/manage/restore/preview', { file: base(half) })).preview;
    assert.strictEqual(p.usable, false, 'a truncated dump verified as usable');
    assert.ok(p.problems.join(' ').includes('okunamadı veya yarım'),
      'the refusal does not say the file is broken: ' + JSON.stringify(p.problems));

    const r = await api('POST', '/api/manage/restore/run', { file: base(half), password: PW });
    assert.strictEqual(r.ok, false, 'a truncated dump was restored');
    assert.deepStrictEqual(await counts(), before, 'a truncated dump reached the live database');
    assert.strictEqual(dbExists(config.db.database + '_geri'), 0,
      'the temporary database was left behind after a failed verification');
  });

  await step('bu kasadan daha yeni sürümün yedeği reddedilir', async () => {
    const newer = await doctoredDump('noktapp_pos_yeni',
      "UPDATE np_settings SET v='9.9.0' WHERE k='app_version'", 'yeni-surum-yedek.sql.gz');
    const before = await counts();
    const p = (await api('POST', '/api/manage/restore/preview', { file: newer })).preview;
    assert.strictEqual(p.usable, false, 'a dump from a newer version verified as usable');
    assert.ok(p.problems.join(' ').includes('daha yeni'),
      'the refusal does not mention the version: ' + JSON.stringify(p.problems));
    const r = await api('POST', '/api/manage/restore/run', { file: newer, password: PW });
    assert.strictEqual(r.ok, false, 'a newer dump was restored under older code');
    assert.deepStrictEqual(await counts(), before, 'the live database changed');
  });

  await step('eski şemalı yedek yüklenir ve göçler onu güncele taşır', async () => {
    /*
     * A dump from before a migration is missing the columns that migration
     * added. Restoring it and stopping there would leave the till running
     * against a schema its own code no longer matches - so the migrations run
     * afterwards, exactly as they do on every start of the program.
     */
    const old = await doctoredDump('noktapp_pos_eski',
      'ALTER TABLE np_display_settings DROP COLUMN social_instagram, DROP COLUMN social_facebook, '
      + "DROP COLUMN social_tiktok; UPDATE np_settings SET v='1.9.0' WHERE k='app_version'",
      'eski-surum-yedek.sql.gz');

    const p = (await api('POST', '/api/manage/restore/preview', { file: old })).preview;
    assert.strictEqual(p.usable, true, 'an older dump was refused: ' + JSON.stringify(p.problems));
    assert.strictEqual(p.app_version, '1.9.0', 'the older dump did not report its version');

    const r = await api('POST', '/api/manage/restore/run', { file: old, password: PW });
    assert.strictEqual(r.status, 200, 'an older dump would not restore: ' + JSON.stringify(r));
    const col = await db.value(
      `SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema=? AND table_name='np_display_settings' AND column_name='social_instagram'`,
      [config.db.database]);
    assert.strictEqual(Number(col), 1, 'the migrations did not bring the restored schema forward');
    assert.ok(r.migrations.applied > 0, 'no migrations were run after the load');
    /* and the data itself is the old dump's, not a leftover of the live one */
    assert.deepStrictEqual(await counts(), beforeAll, 'the older dump did not carry the data');
  });

  await step('geri yükleme öncesi yedek durur ve prune onu silmez', async () => {
    const row = await db.one("SELECT * FROM np_backups WHERE kind='pre-restore' ORDER BY id DESC LIMIT 1");
    assert.ok(row, 'no pre-restore row survived into the restored database');
    assert.ok(fs.existsSync(row.file_path), 'the pre-restore snapshot file is gone: ' + row.file_path);

    /*
     * Aged past the keep window along with an ordinary snapshot, and pruned.
     * The ordinary one is expected to go; the one taken seconds before somebody
     * overwrote the database is the one that must not, and two weeks later is
     * exactly when they will come looking for it.
     */
    const decoy = path.join(DIR, 'eski-normal-yedek.sql.gz');
    fs.copyFileSync(path.join(DIR, good), decoy);
    const old = new Date(Date.now() - 40 * 86400000);
    fs.utimesSync(decoy, old, old);
    fs.utimesSync(row.file_path, old, old);

    await db.setSetting('backup_keep_days', 7);
    await backup.prune();
    await db.setSetting('backup_keep_days', 14);

    assert.strictEqual(fs.existsSync(decoy), false, 'prune kept an ordinary snapshot past its date');
    assert.strictEqual(fs.existsSync(row.file_path), true,
      'prune deleted the pre-restore snapshot - the only copy of what the restore erased');
  });

  await step('garson hiçbir geri yükleme uç noktasına erişemez', async () => {
    const calls = [
      ['GET', '/api/manage/restore/sources', null],
      ['POST', '/api/manage/restore/preview', { file: good }],
      ['POST', '/api/manage/restore/run', { file: good, password: PW }],
      ['POST', '/api/manage/restore/cloud-fetch', { id: 1 }],
    ];
    for (const who of [WAITER, MANAGER]) {
      for (const [m, p, b] of calls) {
        const r = await api(m, p, b, who);
        assert.strictEqual(r.status, 403, m + ' ' + p + ' answered ' + r.status + ' to a non-owner');
        assert.strictEqual(r.code, 'OWNER_ONLY', m + ' ' + p + ' refused for the wrong reason');
      }
    }
  });

  await step('şifresiz veya yanlış şifreli sahip de geri yükleyemez', async () => {
    const before = await counts();
    const snaps = () => db.value("SELECT COUNT(*) FROM np_backups WHERE kind='pre-restore'");
    const snapsBefore = Number(await snaps());

    for (const body of [{ file: good }, { file: good, password: '' }, { file: good, password: 'yanlis' }]) {
      const r = await api('POST', '/api/manage/restore/run', body);
      assert.strictEqual(r.ok, false, 'a restore ran without the right password: ' + JSON.stringify(body));
      assert.strictEqual(r.status, 403, 'wrong status for a bad password: ' + r.status);
      assert.strictEqual(r.code, 'PASSWORD_REQUIRED', 'wrong code: ' + r.code);
    }
    assert.deepStrictEqual(await counts(), before, 'the database moved while refusing a password');
    /* and nothing was even started: the password is checked before the snapshot */
    assert.strictEqual(Number(await snaps()), snapsBefore, 'a refused restore still took a snapshot');
  });

  await step('geri yükleme sürerken kasa yazma isteklerini Türkçe reddeder', async () => {
    /*
     * The window is a couple of seconds wide and it is the whole point of the
     * maintenance state: a waiter who takes a payment while the database is
     * being replaced must get a sentence, not a 500 and a payment they cannot
     * account for.
     */
    const running = api('POST', '/api/manage/restore/run', { file: good, password: PW });
    let seen = null;
    for (let i = 0; i < 400 && !seen; i++) {
      if (restore.status().busy) {
        seen = await api('POST', '/api/pos/orders', { table_id: 1 }, MANAGER);
        break;
      }
      await sleep(10);
    }
    const done = await running;
    assert.strictEqual(done.status, 200, 'the restore itself failed: ' + JSON.stringify(done));
    assert.ok(seen, 'the restore never reported itself busy');
    assert.strictEqual(seen.status, 503, 'a write during a restore answered ' + seen.status);
    assert.strictEqual(seen.code, 'BAKIM');
    assert.ok(/geri yükleniyor/i.test(seen.error || ''), 'the refusal is not the Turkish maintenance message');
  });

  await step('uygulama aşaması çökerse yüksek sesle bildirilir ve yol geri gösterilir', async () => {
    /*
     * The load itself failing is the case the whole safety order exists for.
     * It is forced here with a client that refuses to open the live database
     * and works everywhere else, which is what a disk filling up in the middle
     * of a load looks like from here.
     */
    const fake = path.join(os.tmpdir(), 'geri-bozuk-mariadb.sh');
    fs.writeFileSync(fake,
      '#!/bin/sh\n'
      + '# fails only for the live database, so verification in the temp one still passes\n'
      + 'for a in "$@"; do [ "$a" = "' + config.db.database + '" ] && { echo "ERROR 1114: disk dolu" >&2; exit 1; }; done\n'
      + 'exec mariadb "$@"\n', { mode: 0o755 });
    process.env.NOKTAPP_CLIENT_BIN = fake;
    let failed;
    try {
      failed = await api('POST', '/api/manage/restore/run', { file: good, password: PW });
    } finally {
      delete process.env.NOKTAPP_CLIENT_BIN;
    }
    assert.strictEqual(failed.ok, false, 'a broken load reported success');
    assert.ok(/GERİ YÜKLEME BAŞARISIZ/.test(failed.error), 'the failure is not loud: ' + failed.error);
    assert.ok(failed.pre_restore && failed.pre_restore.includes('pre-restore'),
      'the failure does not name the pre-restore snapshot: ' + JSON.stringify(failed));
    assert.ok(failed.error.includes(failed.pre_restore),
      'the message a person reads does not name the way back');

    /* the writers are running again even though the restore blew up */
    assert.strictEqual(restore.status().writers_running, true, 'the writers were left stopped after a failure');

    /* and the way back is real: the named snapshot restores the till */
    const back = await api('POST', '/api/manage/restore/run', { file: failed.pre_restore, password: PW });
    assert.strictEqual(back.status, 200, 'the pre-restore snapshot would not restore: ' + JSON.stringify(back));
    assert.deepStrictEqual(await counts(), beforeAll, 'the way back did not bring the data back');
    assert.strictEqual(await printAgentAlive(), true, 'the print agent is not running after the recovery');
  });

  /* ------------------------------------------------------------ bulut */
  /*
   * The panel half is exercised against a stub inside this file. The real
   * endpoints live in the panel and are not this suite's to start; what has to
   * be proved here is what the till does with the answers - and, just as
   * important, what it does when there is no answer at all.
   */
  let stub = null, stubPort = 0, stubMode = 'ok';
  const cloudFile = fs.readFileSync(path.join(DIR, good));
  const cloudSha = crypto.createHash('sha256').update(cloudFile).digest('hex');

  await step('bulut listesi ve indirme paneldeki dosyayı yerel klasöre getirir', async () => {
    stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const inp = JSON.parse(body || '{}');
        if (req.url.startsWith('/api/desktop/backup_list.php')) {
          assert.strictEqual(Number(inp.client_id), CID, 'the till asked for the wrong licence');
          assert.ok(inp.device_id, 'the till did not identify its device');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, backups: [{
            id: 77, filename: 'gece-yedegi.sql.gz', size_bytes: cloudFile.length,
            sha256: stubMode === 'bad-sha' ? 'f'.repeat(64) : cloudSha,
            created_at: '2026-09-01 03:00:00',
          }] }));
        }
        if (req.url.startsWith('/api/desktop/backup_get.php')) {
          res.writeHead(200, { 'Content-Type': 'application/gzip', 'X-Sha256': cloudSha });
          return res.end(cloudFile);
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'yok' }));
      });
    });
    await new Promise(r => stub.listen(0, '127.0.0.1', r));
    stubPort = stub.address().port;
    await db.setSetting('panel_url', 'http://127.0.0.1:' + stubPort);

    const list = await api('GET', '/api/manage/restore/sources');
    const c = list.sources.find(s => s.kind === 'cloud');
    assert.ok(c, 'the cloud backup is not in the source list: ' + JSON.stringify(list.cloud_error));
    assert.strictEqual(c.file, 'gece-yedegi.sql.gz');
    assert.strictEqual(Number(c.size_bytes), cloudFile.length);

    const got = await api('POST', '/api/manage/restore/cloud-fetch', { id: 77 });
    assert.strictEqual(got.status, 200, 'the download failed: ' + JSON.stringify(got));
    const landed = path.join(DIR, got.file);
    assert.ok(fs.existsSync(landed), 'the downloaded file is not in the backups folder');
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(landed)).digest('hex'), cloudSha,
      'the downloaded file is not the file the panel served');
    /* and what came down is restorable, which is the only reason to download it */
    const p = (await api('POST', '/api/manage/restore/preview', { file: got.file })).preview;
    assert.strictEqual(p.usable, true, 'the downloaded backup does not verify: ' + JSON.stringify(p.problems));
  });

  await step('sha256 tutmayan indirme kabul edilmez ve yarım dosya bırakmaz', async () => {
    stubMode = 'bad-sha';
    const r = await api('POST', '/api/manage/restore/cloud-fetch', { id: 77 });
    stubMode = 'ok';
    assert.strictEqual(r.ok, false, 'a corrupt download was accepted');
    assert.ok(/sha256/i.test(r.error), 'the refusal does not say why: ' + r.error);
    assert.ok(!fs.readdirSync(DIR).some(f => f.endsWith('.indiriliyor')), 'a half download was left behind');
    /* the copy that was already there is untouched: a bad download must not
       overwrite the good file it shares a name with */
    const kept = path.join(DIR, 'bulut-gece-yedegi.sql.gz');
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(kept)).digest('hex'), cloudSha,
      'a refused download overwrote the good copy');
  });

  await step('panele ulaşılamadığında ekran Türkçe uyarır, çökmez', async () => {
    await new Promise(r => stub.close(r));
    stub = null;
    const r = await api('GET', '/api/manage/restore/sources');
    assert.strictEqual(r.status, 200, 'a dead panel broke the whole screen');
    assert.strictEqual(r.cloud_ok, false);
    assert.ok(/Sunucuya ulaşılamadı/.test(r.cloud_error || ''),
      'the message is not the polite Turkish one: ' + r.cloud_error);
    assert.ok(r.sources.some(s => s.kind === 'local'), 'the local backups vanished with the internet');
    /* cloudFetch has nothing to fetch from and must say so rather than throw */
    const f = await api('POST', '/api/manage/restore/cloud-fetch', { id: 77 });
    assert.strictEqual(f.ok, false);
    assert.ok((f.error || '').length > 10, 'no message on a failed download');
  });

  /* ---------------------------------------------------------- tidy up */
  await db.setSetting('panel_url', config.panelUrl);
  for (const f of ['komsu-restoran-yedek.sql.gz', 'yarim-yedek.sql.gz', 'yeni-surum-yedek.sql.gz',
    'eski-surum-yedek.sql.gz']) {
    try { fs.unlinkSync(path.join(DIR, f)); } catch (_) {}
  }
  for (const d of ['noktapp_pos_baska', 'noktapp_pos_yeni', 'noktapp_pos_eski', config.db.database + '_geri']) {
    try { my(['--execute=DROP DATABASE IF EXISTS `' + d + '`']); } catch (_) {}
  }
  if (stub) await new Promise(r => stub.close(r));

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
