'use strict';
/**
 * Geri yükleme - restore.
 *
 * The mirror of backup.js, and the dangerous half. backup.js writes a file
 * nobody reads until the worst day of a restaurant's year; this reads it back,
 * and on the way it destroys the database it is replacing. Every rule below
 * exists because the thing being protected is not the dump - it is the trade
 * that has happened since the dump, and the OTHER restaurant whose backup must
 * never end up inside this one.
 *
 * The order is the feature:
 *
 *   1. take a snapshot of what is about to be erased, always, first;
 *   2. prove the dump is loadable and is OURS, in a throwaway database;
 *   3. stop everything that writes, and refuse writes over HTTP;
 *   4. only then drop the live database and load the dump into it, then bring
 *      the schema forward with the migrations;
 *   5. write down who did it - into the restored database, because the row
 *      would otherwise be inside the thing that was just overwritten.
 *
 * There is no restore that the panel can start. The panel serves the file; the
 * person standing at the till decides. A vendor with a button that overwrites
 * a live restaurant's database from a browser is a different feature and a
 * much worse idea than this one.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const db = require('./db');
const config = require('./config');
const log = require('./logger');
const licence = require('./licence');
const backup = require('./backup');
const kimlik = require('./util/kimlik');

/*
 * The five tables that mean "this is a NOKTApp POS database and not some other
 * gzipped SQL that happened to be in the folder". Not an exhaustive list - the
 * migrations bring the rest forward - but a dump missing any of these is not a
 * till database and there is nothing to be gained by finding that out halfway
 * through loading it over the live one.
 */
const CORE_TABLES = ['orders', 'order_items', 'products', 'np_licence', 'users'];

/** The version this till is running, as it is stamped into every dump. */
function appVersion() {
  return process.env.NOKTAPP_VERSION || '2.0.0';
}

/* ===================================================================== */
/* the bundled client                                                    */
/* ===================================================================== */

/*
 * Same resolution as the dump binary, from the same function, on purpose: a
 * dump written by the MariaDB that ships with the installer and read back by
 * whatever `mysql` was first on the PATH is how a restore comes to work on the
 * developer's machine and not on the customer's.
 */
function clientBinary() {
  return backup.toolPath('mariadb', process.env.NOKTAPP_CLIENT_BIN);
}

function connArgs() {
  const a = ['--host=' + config.db.host, '--port=' + config.db.port, '--user=' + config.db.user];
  /*
   * An empty --password= is not "no password" to the client, but it is also
   * not a prompt, which is what matters: a tool that stops to ask for a
   * password has no terminal here and would hang the restore forever.
   */
  if (config.db.password) a.push('--password=' + config.db.password);
  if (config.db.socketPath) a.push('--socket=' + config.db.socketPath);
  a.push('--default-character-set=utf8mb4');
  return a;
}

/**
 * Run the bundled client. `stdin` is a stream (a dump being gunzipped, or a
 * migration file); anything else goes in as arguments.
 */
function client(args, { stdin = null, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
    const child = spawn(clientBinary(), connArgs().concat(args), { windowsHide: true });
    let out = '', errText = '';
    const killer = setTimeout(() => {
      child.kill();
      finish(reject, new Error('Veritabanı komutu zaman aşımına uğradı'));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d.toString(); if (out.length > 1e6) out = out.slice(-1e6); });
    child.stderr.on('data', d => { errText += d.toString(); });
    child.on('error', e => { clearTimeout(killer); finish(reject, e); });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) return finish(resolve, out);
      finish(reject, new Error(errText.trim().split('\n').pop() || ('mariadb ' + code + ' ile çıktı')));
    });
    /*
     * The client exits the moment a statement fails, and it exits while we are
     * still pushing a 30 MB dump at its stdin. That is an EPIPE on a stream
     * with no error handler, which in Node is not an exception - it is the
     * whole service going down, during a restore, with the database dropped.
     */
    child.stdin.on('error', () => {});
    if (stdin) {
      stdin.on('error', (e) => { child.kill(); finish(reject, e); });
      stdin.pipe(child.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/** A gzipped dump as a stream of SQL, with the read error carried through. */
function sqlStream(file) {
  const gz = zlib.createGunzip();
  const rd = fs.createReadStream(file);
  rd.on('error', e => gz.destroy(e));
  rd.pipe(gz);
  return gz;
}

/*
 * Database names cannot be bound as parameters, so they are pasted into SQL,
 * so they are checked here and nowhere else. config.db.database comes from a
 * file the installer writes; this is the one place that would turn a typo -
 * or a malicious config.json - into arbitrary SQL run as the database owner.
 */
function safeName(name) {
  if (!/^[A-Za-z0-9_$]{1,60}$/.test(String(name))) throw new Error('Geçersiz veritabanı adı: ' + name);
  return String(name);
}
const liveDb = () => safeName(config.db.database);
const tempDb = () => safeName(config.db.database + '_geri');

async function dropDatabase(name) {
  await client(['--execute=DROP DATABASE IF EXISTS `' + safeName(name) + '`'], { timeoutMs: 120000 });
}
async function createDatabase(name) {
  await client(['--execute=CREATE DATABASE `' + safeName(name) +
    '` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci'], { timeoutMs: 120000 });
}
async function loadInto(name, file) {
  await client([safeName(name)], { stdin: sqlStream(file) });
}

/* ===================================================================== */
/* the source file                                                       */
/* ===================================================================== */

/*
 * Every restore source is a file in the backups folder, by base name. Not a
 * path: a path arriving in a JSON body from the till screen is a path that can
 * be `../../../etc/passwd`, and the answer to "the owner wants to restore from
 * a USB stick" is that they copy the file into the backups folder first, where
 * the screen can then see it and where it will be kept with the others.
 */
function resolveSource(source) {
  const raw = typeof source === 'string' ? source : (source && (source.file || source.name)) || '';
  const name = path.basename(String(raw).trim());
  if (!name || name === '.' || name === '..') { const e = new Error('Yedek dosyası seçilmedi'); e.status = 400; throw e; }
  const file = path.join(config.backupDir, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const e = new Error('Yedek dosyası bulunamadı: ' + name); e.status = 404; throw e;
  }
  return file;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rd = fs.createReadStream(file);
    rd.on('data', c => h.update(c));
    rd.on('error', reject);
    rd.on('end', () => resolve(h.digest('hex')));
  });
}

/** The first bytes of a gzip file, so a truncated one is caught before anything else. */
function looksGzipped(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(2);
    const n = fs.readSync(fd, b, 0, 2, 0);
    fs.closeSync(fd);
    return n === 2 && b[0] === 0x1f && b[1] === 0x8b;
  } catch (_) { return false; }
}

/**
 * The first few kilobytes of the dump, uncompressed, for the header comment.
 * Read as a stream and abandoned: the version marker is in the first lines and
 * there is no reason to inflate 30 MB to find it.
 */
function readHeader(file, bytes = 8192) {
  return new Promise((resolve) => {
    let buf = '';
    const gz = sqlStream(file);
    gz.on('data', (c) => {
      buf += c.toString('utf8');
      if (buf.length >= bytes) { gz.destroy(); resolve(buf.slice(0, bytes)); }
    });
    gz.on('error', () => resolve(buf));
    gz.on('end', () => resolve(buf));
    gz.on('close', () => resolve(buf));
  });
}

/* ===================================================================== */
/* versions                                                              */
/* ===================================================================== */

/**
 * Compare two dotted versions. Missing parts count as zero, so 2.1 < 2.1.1.
 * Anything unparseable sorts as equal, which is the safe answer here: an
 * unknown version must not be treated as newer and block a restore that is
 * probably fine, and must not be treated as older either.
 */
function cmpVersion(a, b) {
  const parts = (v) => String(v || '').trim().split(/[^0-9]+/).filter(s => s !== '').map(Number);
  const A = parts(a), B = parts(b);
  if (!A.length || !B.length) return 0;
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/*
 * The version the dump was taken under. np_settings.app_version is written on
 * every boot, so every dump this till has ever produced carries it. Dumps from
 * before that setting existed fall back to the header comment, and a dump that
 * says nothing at all is treated as older - which is the safe direction: older
 * loads and is then brought forward by the migrations.
 */
function versionFromHeader(header) {
  const m = String(header || '').match(/--\s*NOKTApp POS app_version:\s*([0-9][0-9.]*)/i);
  return m ? m[1] : null;
}

/* ===================================================================== */
/* who this till belongs to                                              */
/* ===================================================================== */

/**
 * Copy the licence identity - and the owner's password hash - into the
 * identity file, while the database is still able to say what they are.
 *
 * Called on every boot and before every verification, so the file is always
 * the last good answer rather than a guess. See util/kimlik.js for why the
 * copy exists at all.
 */
async function rememberIdentity() {
  let lic = null;
  try { lic = await db.one('SELECT client_id, company_name FROM np_licence WHERE id=1'); } catch (_) {}
  if (!lic || !lic.client_id) return null;
  let hashes = [];
  try {
    const rows = await db.query('SELECT password_hash FROM np_login_cache WHERE client_id=?', [lic.client_id]);
    hashes = rows.map(r => r.password_hash).filter(Boolean);
  } catch (_) {}
  kimlik.write({
    client_id: Number(lic.client_id),
    company_name: lic.company_name || null,
    ...(hashes.length ? { owner_hashes: hashes } : {}),
  });
  return lic;
}

async function myIdentity() {
  const fresh = await rememberIdentity();
  if (fresh) return { client_id: Number(fresh.client_id), company_name: fresh.company_name, source: 'db' };
  const j = kimlik.read();
  if (j && j.client_id) return { client_id: Number(j.client_id), company_name: j.company_name, source: 'file' };
  return null;
}

/* ===================================================================== */
/* 2. verification, in a database that is not the live one               */
/* ===================================================================== */

/**
 * What is inside a dump, without applying it.
 *
 * The dump is loaded into `<dbname>_geri` and questioned there. Nothing about
 * this touches the live database, and the temporary one is dropped on every
 * path out - including the one where the dump was so broken that loading it
 * threw. A verification that leaves half a database behind is a verification
 * that fails differently the second time it is run.
 */
async function preview(source) {
  const file = resolveSource(source);
  const st = fs.statSync(file);
  const out = {
    file: path.basename(file),
    size_bytes: st.size,
    file_date: new Date(st.mtimeMs).toISOString().slice(0, 19).replace('T', ' '),
    sha256: await sha256File(file),
    usable: false,
    problems: [],
    client_id: null,
    company_name: null,
    app_version: null,
    counts: {},
    last_order_at: null,
  };
  const problem = (m) => { out.problems.push(m); };

  if (!st.size) { problem('Yedek dosyası boş.'); return out; }
  if (!looksGzipped(file)) { problem('Yedek dosyası tanınmadı: bu bir NOKTApp yedeği (.sql.gz) değil.'); return out; }

  const mine = await myIdentity();
  const tmp = tempDb();
  try {
    await dropDatabase(tmp);
    await createDatabase(tmp);
    try {
      await loadInto(tmp, file);
    } catch (e) {
      /*
       * A gzip that ends in the middle, a dump that was cut off while it was
       * being copied, a file that is not SQL at all: they all arrive here, and
       * they all arrive here rather than in the middle of the live database.
       */
      problem('Yedek dosyası okunamadı veya yarım: ' + String(e.message || e).slice(0, 200));
      return out;
    }

    const tables = await db.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=?', [tmp]);
    const have = new Set(tables.map(r => String(r.t || r.TABLE_NAME).toLowerCase()));
    const missing = CORE_TABLES.filter(t => !have.has(t));
    if (missing.length) problem('Yedekte olması gereken tablolar yok: ' + missing.join(', '));

    if (have.has('orders')) {
      try {
        out.counts.orders = Number(await db.value('SELECT COUNT(*) FROM `' + tmp + '`.`orders`'));
        out.last_order_at = await db.value('SELECT MAX(created_at) FROM `' + tmp + '`.`orders`');
      } catch (e) { problem('Yedekteki adisyon tablosu okunamıyor: ' + String(e.message || e).slice(0, 160)); }
    }
    for (const [key, table] of [['products', 'products'], ['users', 'users'], ['order_items', 'order_items']]) {
      if (!have.has(table)) continue;
      try { out.counts[key] = Number(await db.value('SELECT COUNT(*) FROM `' + tmp + '`.`' + table + '`')); }
      catch (_) { /* the missing-table problem above already says it */ }
    }

    /*
     * THE check. Everything else on this list is about a restore that fails;
     * this one is about a restore that succeeds and puts another restaurant's
     * customers, staff, prices and takings inside this till. There is no
     * "are you sure" for that, because there is no legitimate reason to do it:
     * a backup belongs to exactly one licence and it goes back to that one.
     */
    if (have.has('np_licence')) {
      const lic = await db.one('SELECT client_id, company_name FROM `' + tmp + '`.`np_licence` ORDER BY id LIMIT 1');
      out.client_id = lic ? Number(lic.client_id) : null;
      out.company_name = lic ? lic.company_name : null;
      if (!mine || !mine.client_id) {
        problem('Bu kasanın hangi işletmeye ait olduğu belirlenemedi, yedeğin doğruluğu kontrol edilemiyor. Önce işletme girişi yapın.');
      } else if (!lic || !lic.client_id) {
        problem('Yedekte lisans kaydı yok, hangi işletmeye ait olduğu belli değil.');
      } else if (Number(lic.client_id) !== Number(mine.client_id)) {
        problem('Bu yedek başka bir işletmeye ait (' + (lic.company_name || ('müşteri no ' + lic.client_id))
          + '). Başka bir işletmenin yedeği bu kasaya yüklenemez.');
      }
    }

    if (have.has('np_settings')) {
      out.app_version = await db.value('SELECT v FROM `' + tmp + '`.`np_settings` WHERE k=?', ['app_version']);
    }
    if (!out.app_version) out.app_version = versionFromHeader(await readHeader(file));
    if (cmpVersion(out.app_version, appVersion()) > 0) {
      /*
       * Older is fine: the migrations run afterwards and bring it forward.
       * Newer is not, and it is not a warning either - a database written by a
       * later version of the program, read by this one, is a column this code
       * does not know about and a value it will quietly write wrong.
       */
      problem('Bu yedek programın daha yeni bir sürümünden (' + out.app_version + '), bu kasa ise '
        + appVersion() + ' sürümünü çalıştırıyor. Önce programı güncelleyin.');
    }
  } catch (e) {
    /*
     * A missing engine is not a bad backup, and telling a restaurant owner
     * "spawn mariadb.exe ENOENT" tells him his data is gone when it is not.
     * The backup on the screen is fine; the program cannot find the tool that
     * reads it, which is our problem and not his file.
     */
    const raw = String((e && e.message) || e);
    if (/ENOENT/.test(raw) && /mariadb/i.test(raw)) {
      problem('Veritabanı aracı bulunamadı, bu yüzden yedek incelenemedi. Yedeğinizde bir sorun yok. '
        + 'Programı kapatıp yeniden açın; sorun sürerse programı güncelleyin.');
      log.error('geri', 'mariadb istemcisi bulunamadi', {
        client: clientBinary(), dump_env: process.env.NOKTAPP_DUMP_BIN || null,
        client_env: process.env.NOKTAPP_CLIENT_BIN || null, resources: process.resourcesPath || null,
      });
    } else {
      problem('Yedek incelenemedi: ' + raw.slice(0, 200));
    }
  } finally {
    /* Whatever happened, the scratch database goes. */
    await dropDatabase(tmp).catch(e => log.warn('geri', 'gecici veritabani silinemedi', e.message));
  }
  out.usable = out.problems.length === 0;
  return out;
}

/* ===================================================================== */
/* 3. the writers                                                        */
/* ===================================================================== */

/*
 * Everything in this service that writes to the database on a timer. They are
 * stopped before the drop and started again afterwards on EVERY path, which is
 * why the resume lives in a finally and not at the end of the happy path: a
 * restore that failed and left the print agent stopped is a restaurant that
 * prints nothing until somebody restarts the program, and nobody connects the
 * two events.
 *
 * `running` is this module's own record rather than something read back out of
 * the timers, because a stopped interval is not observable from outside the
 * module that owns it and none of those modules is being reshaped for this
 * feature. It is honest as long as this is the only thing that stops them,
 * which it is. test/geri.js does not take its word for it: it puts a job in
 * the print queue afterwards and watches the queue move.
 *
 * sync.stop() only stops the outbox drain; the summary and heartbeat timers
 * beside it run every 15 and 30 minutes and each wraps its own work in a
 * catch, so the most a restore can cost them is one beat that found no
 * database. That is cheaper than reshaping sync for this.
 */
const WRITERS = [
  { key: 'print', label: 'Yazıcı ajanı', mod: () => require('./print') },
  { key: 'sync', label: 'Bulut eşitleme', mod: () => require('./sync') },
  { key: 'relay', label: 'Uzaktan bağlantı', mod: () => require('./relay') },
  { key: 'backup', label: 'Yedekleme zamanlayıcısı', mod: () => require('./backup') },
  { key: 'integrations', label: 'Platform sipariş çekici', mod: () => require('./integrations') },
];

const state = {
  busy: false,
  phase: null,
  since: null,
  writers_running: true,
  last: null,
};

async function stopWriters() {
  for (const w of WRITERS) {
    try { await w.mod().stop(); } catch (e) { log.warn('geri', w.key + ' durdurulamadi', e.message); }
  }
  state.writers_running = false;
  log.info('geri', 'Yazan servisler durduruldu');
}

async function startWriters() {
  for (const w of WRITERS) {
    try { await w.mod().start(); } catch (e) { log.warn('geri', w.key + ' baslatilamadi', e.message); }
  }
  state.writers_running = true;
  log.info('geri', 'Yazan servisler yeniden başlatıldı');
}

/**
 * The HTTP maintenance state, read by the middleware in index.js.
 * Returns the Turkish sentence to answer with, or null when the till is open.
 */
function maintenance() {
  return state.busy
    ? 'Veritabanı geri yükleniyor. Bu işlem birkaç dakika sürebilir; lütfen bekleyin ve kasayı kapatmayın.'
    : null;
}

function status() {
  return { busy: state.busy, phase: state.phase, since: state.since,
    writers_running: state.writers_running, last: state.last };
}

/* ===================================================================== */
/* 4-5. the restore itself                                               */
/* ===================================================================== */

function sqlDir() {
  return process.env.NOKTAPP_SQL_DIR || path.join(__dirname, '..', '..', 'database');
}

/**
 * Every migration, in name order, over the freshly loaded dump.
 *
 * A dump is a photograph of the schema on the day it was taken; a dump from
 * March restored in September is missing every column added since. The desktop
 * shell runs these on every start for exactly the same reason, ignoring the
 * complaints of the ones that were already applied - which is most of them,
 * every time. Failures are collected rather than thrown for the same reason:
 * "duplicate column name" is the expected answer, not an emergency. They are
 * written into the audit row so that a genuine failure is still findable.
 */
async function runMigrations(name) {
  const dir = path.join(sqlDir(), 'migrations');
  const out = { applied: 0, complained: [] };
  if (!fs.existsSync(dir)) {
    log.warn('geri', 'migrations klasoru bulunamadi', dir);
    return out;
  }
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    try {
      await client([safeName(name)], { stdin: fs.createReadStream(path.join(dir, f)), timeoutMs: 180000 });
      out.applied++;
    } catch (e) {
      out.complained.push(f + ': ' + String(e.message || e).slice(0, 160));
    }
  }
  return out;
}

/**
 * Perform a restore.
 *
 * opts: { file, actor: { userId, role, ip, userAgent }, reason }
 */
async function run(opts = {}) {
  if (state.busy) { const e = new Error('Zaten bir geri yükleme sürüyor.'); e.status = 409; throw e; }
  const file = resolveSource(opts.file);
  const actor = opts.actor || {};
  const started = new Date();

  state.busy = true;
  state.since = started.toISOString();
  state.phase = 'snapshot';
  log.info('geri', 'Geri yükleme başladı', { file: path.basename(file) });

  let snap = null;
  try {
    /*
     * 1. The snapshot, before anything - before even reading the dump. It is
     *    taken even for a restore that is about to be refused, because the
     *    cost is one file and the alternative is discovering that the only
     *    moment we could still have saved this database was the moment we
     *    decided not to bother.
     */
    snap = await backup.run('pre-restore');
    log.info('geri', 'Geri yükleme öncesi yedek alındı', { file: path.basename(snap.file), size: snap.size });

    /* 2. Verify in a temporary database. Refusals stop here, live untouched. */
    state.phase = 'verify';
    const info = await preview(file);
    if (!info.usable) {
      const e = new Error('Yedek geri yüklenemez: ' + info.problems.join(' '));
      e.status = 400;
      e.preview = info;
      throw e;
    }

    /* 3. Quiesce. From here to the finally, nothing else may write. */
    state.phase = 'quiesce';
    await stopWriters();

    /* 4. Apply. */
    let migrations = null;
    try {
      state.phase = 'apply';
      const live = liveDb();
      await dropDatabase(live);
      await createDatabase(live);
      await loadInto(live, file);
      state.phase = 'migrate';
      migrations = await runMigrations(live);
    } catch (e) {
      /*
       * The schema was dropped and built again under the same name before the
       * load died, so the pooled connections are as stale as they are after a
       * restore that worked. Reconnect even here: the till has to stay able to
       * answer, if only to show the failure.
       */
      await db.reinit().catch(() => {});
      /*
       * Then loud, in Turkish, and naming the way back. No automatic rollback:
       * the engine has just refused to load one dump, and the useful thing at
       * that moment is a person who knows the pre-restore snapshot exists and
       * what it is called - not a second unattended load on top of the
       * wreckage of the first.
       */
      const msg = 'GERİ YÜKLEME BAŞARISIZ. Veritabanı şu anda eksik olabilir. '
        + 'İşlem öncesinde alınan yedek duruyor: ' + path.basename(snap.file)
        + ' — Yedekleme ekranından bu dosyayı seçip geri yükleyerek eski duruma dönebilirsiniz. '
        + 'Hata: ' + String(e.message || e).slice(0, 300);
      log.error('geri', 'Geri yükleme uygulanamadı', { error: String(e.message || e), pre_restore: snap.file });
      const err = new Error(msg);
      err.status = 500;
      err.pre_restore = path.basename(snap.file);
      throw err;
    }

    /*
     * The pool's connections are bound to a schema that was dropped and built
     * again under the same name while they were idle. Throw them away before
     * anything reads through them.
     */
    state.phase = 'reconnect';
    await db.reinit();
    const clientId = await db.getClientId();

    /*
     * 5. The record. Both rows are written AFTER the load, into the restored
     *    database, because anything written before it was inside the database
     *    that has just been replaced - including the np_backups row for the
     *    pre-restore snapshot itself. That row is the one that stops prune()
     *    deleting the only copy of what was erased, so losing it would quietly
     *    put the snapshot on a two-week timer.
     */
    state.phase = 'record';
    const snapId = await db.insert(
      `INSERT INTO np_backups (kind, file_path, size_bytes, sha256, status, message, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      ['pre-restore', snap.file, snap.size, snap.sha256, 'ok',
       'Geri yükleme öncesi alındı', started.toISOString().slice(0, 19).replace('T', ' ')]).catch(() => null);

    const fileSha = await sha256File(file);
    const meta = {
      file: path.basename(file), sha256: fileSha,
      pre_restore_file: path.basename(snap.file), pre_restore_backup_id: snapId,
      migrations_applied: migrations ? migrations.applied : 0,
      migrations_complained: migrations ? migrations.complained.length : 0,
      dump_app_version: info.app_version, app_version: appVersion(),
      orders_in_dump: info.counts.orders || 0,
      reason: opts.reason || '',
    };
    await db.exec(
      `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id,
          before_json, after_json, meta_json, ip, user_agent, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [clientId || info.client_id, actor.userId || null, actor.role || null, 'db.restore', 'database',
       path.basename(file), null, null, JSON.stringify(meta), actor.ip || null,
       (actor.userAgent || '').slice(0, 255) || null]).catch(e =>
        log.warn('geri', 'denetim kaydi yazilamadi', e.message));

    log.info('geri', 'Geri yükleme tamamlandı', meta);
    state.last = { ok: true, at: new Date().toISOString(), file: path.basename(file),
      pre_restore: path.basename(snap.file) };
    return {
      ok: true,
      file: path.basename(file),
      sha256: fileSha,
      pre_restore: { id: snapId, file: path.basename(snap.file), size: snap.size, sha256: snap.sha256 },
      preview: info,
      migrations,
    };
  } catch (e) {
    state.last = { ok: false, at: new Date().toISOString(), file: path.basename(file),
      error: String(e.message || e), pre_restore: snap ? path.basename(snap.file) : null };
    throw e;
  } finally {
    /*
     * Both of these run on the failure paths too. The maintenance flag is
     * cleared first: a till that refuses every write with "geri yükleniyor"
     * long after the restore gave up is worse than the failed restore.
     */
    state.busy = false;
    state.phase = null;
    if (!state.writers_running) await startWriters();
  }
}

/* ===================================================================== */
/* the panel's copies                                                    */
/* ===================================================================== */

/**
 * What the panel is holding for this licence.
 *
 * Never throws. The list is drawn on a screen the owner opened to look at
 * their local snapshots, and a restaurant with a dead internet line still has
 * those; turning a failed HTTP call into a broken screen would take away the
 * backups they can reach because of the ones they cannot.
 */
async function cloudList() {
  const lic = await db.one('SELECT client_id, licence_key FROM np_licence WHERE id=1');
  if (!lic) return { ok: false, backups: [], error: 'Bu bilgisayarda lisans kaydı yok. Önce işletme girişi yapın.' };
  try {
    const url = (await licence.panelUrl()) + '/api/desktop/backup_list.php';
    const res = await licence.post(url, {
      client_id: lic.client_id, licence_key: lic.licence_key, device_id: await licence.deviceId(),
    }, 25000);
    if (res.status !== 200 || !res.body || !res.body.ok) {
      return { ok: false, backups: [],
        error: (res.body && res.body.error) || 'Sunucudaki yedekler listelenemedi.' };
    }
    return { ok: true, backups: (res.body.backups || []).map(b => ({
      id: b.id, filename: b.filename, size_bytes: Number(b.size_bytes || 0),
      sha256: b.sha256 || null, created_at: b.created_at || null,
    })) };
  } catch (e) {
    log.debug('geri', 'bulut yedek listesi alinamadi', e.message);
    return { ok: false, backups: [],
      error: 'Sunucuya ulaşılamadı, buluttaki yedekler listelenemedi. İnternet bağlantınızı kontrol edin.' };
  }
}

/** POST a JSON body and stream the answer into `target`, hashing as it lands. */
function download(url, body, target) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'NoktAppPOS/' + appVersion(),
      },
      timeout: 300000,
    }, (res) => {
      /*
       * A backup is tens of megabytes and this runs on a restaurant's PC while
       * the till is serving, so it goes to disk as it arrives rather than into
       * a string. The failure answer, though, is a small JSON body - so the
       * content type decides which of the two this is before a single byte is
       * written into the backups folder.
       */
      const type = String(res.headers['content-type'] || '');
      if (res.statusCode !== 200 || type.includes('json')) {
        let buf = '';
        res.on('data', c => { buf += c; if (buf.length > 8192) buf = buf.slice(0, 8192); });
        res.on('end', () => {
          let msg = 'Yedek indirilemedi (HTTP ' + res.statusCode + ')';
          try { const j = JSON.parse(buf); if (j && j.error) msg = j.error; } catch (_) {}
          reject(new Error(msg));
        });
        return;
      }
      /* Whatever the panel calls the header, as long as it says sha256. */
      let remoteSha = null;
      for (const [k, v] of Object.entries(res.headers)) {
        if (/sha-?256/i.test(k) && typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v.trim())) remoteSha = v.trim().toLowerCase();
      }
      const h = crypto.createHash('sha256');
      let bytes = 0;
      const ws = fs.createWriteStream(target);
      res.on('data', c => { h.update(c); bytes += c.length; });
      res.on('error', e => { ws.destroy(); reject(e); });
      ws.on('error', reject);
      res.pipe(ws);
      ws.on('close', () => resolve({ bytes, sha256: h.digest('hex'), remoteSha }));
    });
    req.on('timeout', () => req.destroy(new Error('Sunucu yanıt vermedi (zaman aşımı)')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Pull one of the panel's backups into the local backups folder, where it
 * becomes an ordinary restore source. Downloading is not restoring: the file
 * lands, is checked against the sha256 the panel sent, and then sits there
 * until somebody at the till chooses it.
 */
async function cloudFetch(id) {
  const lic = await db.one('SELECT client_id, licence_key FROM np_licence WHERE id=1');
  if (!lic) { const e = new Error('Bu bilgisayarda lisans kaydı yok. Önce işletme girişi yapın.'); e.status = 400; throw e; }
  if (!id && id !== 0) { const e = new Error('Yedek seçilmedi'); e.status = 400; throw e; }

  const list = await cloudList();
  const row = (list.backups || []).find(b => String(b.id) === String(id));
  if (!list.ok) { const e = new Error(list.error); e.status = 502; throw e; }
  if (!row) { const e = new Error('Sunucuda böyle bir yedek yok.'); e.status = 404; throw e; }

  fs.mkdirSync(config.backupDir, { recursive: true });
  const safe = path.basename(String(row.filename || ('bulut-' + id + '.sql.gz'))).replace(/[^A-Za-z0-9._-]/g, '');
  const name = 'bulut-' + (safe || (id + '.sql.gz'));
  const target = path.join(config.backupDir, name);
  /*
   * Written beside the target and moved into place, so a download cut off
   * halfway never appears in the backups folder as a restore source. A half a
   * dump with the right name is the one file on that screen that must not
   * exist.
   */
  const partial = target + '.indiriliyor';
  let got;
  try {
    got = await download((await licence.panelUrl()) + '/api/desktop/backup_get.php', {
      client_id: lic.client_id, licence_key: lic.licence_key,
      device_id: await licence.deviceId(), id: row.id,
    }, partial);
  } catch (e) {
    try { fs.unlinkSync(partial); } catch (_) {}
    const err = new Error('Yedek indirilemedi: ' + String(e.message || e).slice(0, 200));
    err.status = 502;
    throw err;
  }

  const expect = (row.sha256 || got.remoteSha || '').toLowerCase();
  if (expect && expect !== got.sha256) {
    try { fs.unlinkSync(partial); } catch (_) {}
    const err = new Error('İndirilen yedek bozuk (sha256 uyuşmadı). Tekrar deneyin.');
    err.status = 502;
    throw err;
  }
  fs.renameSync(partial, target);

  await db.exec(
    `INSERT INTO np_backups (kind, file_path, size_bytes, sha256, status, message, created_at)
     VALUES (?,?,?,?,?,?,NOW())`,
    ['cloud-fetch', target, got.bytes, got.sha256, 'ok',
     'Buluttan indirildi' + (row.created_at ? ' (' + String(row.created_at).slice(0, 16) + ')' : '')])
    .catch(e => log.warn('geri', 'indirilen yedek kaydedilemedi', e.message));

  log.info('geri', 'Bulut yedeği indirildi', { file: name, size: got.bytes });
  return { ok: true, file: name, size_bytes: got.bytes, sha256: got.sha256 };
}

/* ===================================================================== */
/* the list the screen draws                                             */
/* ===================================================================== */

/**
 * Local snapshots and cloud backups in one list.
 *
 * The local half is taken from the FOLDER and then decorated from np_backups,
 * not the other way round. A row whose file somebody deleted is not a restore
 * source, and a file whose row was lost - an install that predates the table,
 * a database that was itself restored - very much is.
 */
async function sources() {
  fs.mkdirSync(config.backupDir, { recursive: true });
  let rows = [];
  try {
    rows = await db.query('SELECT id, kind, file_path, size_bytes, sha256, created_at FROM np_backups ORDER BY id DESC');
  } catch (_) { rows = []; }
  const byPath = new Map(rows.map(r => [path.resolve(String(r.file_path || '')), r]));

  const local = [];
  for (const f of fs.readdirSync(config.backupDir)) {
    if (!f.endsWith('.gz')) continue;
    const full = path.join(config.backupDir, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.isFile()) continue;
    const row = byPath.get(path.resolve(full));
    const gz = looksGzipped(full);
    local.push({
      kind: 'local',
      backup_kind: row ? row.kind : (f.includes('-pre-restore') ? 'pre-restore' : 'local'),
      file: f,
      size_bytes: st.size,
      created_at: (row && row.created_at) || new Date(st.mtimeMs).toISOString().slice(0, 19).replace('T', ' '),
      sha256: row ? row.sha256 : null,
      /* "usable" here is only what can be answered without loading it: the
         real answer costs a temporary database and comes from preview(). */
      usable: st.size > 0 && gz,
      note: st.size === 0 ? 'Dosya boş' : (gz ? null : 'Tanınmayan dosya'),
    });
  }
  local.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const cloud = await cloudList();
  return {
    sources: local.concat((cloud.backups || []).map(b => ({
      kind: 'cloud',
      backup_kind: 'cloud',
      id: b.id,
      file: b.filename,
      size_bytes: b.size_bytes,
      created_at: b.created_at,
      sha256: b.sha256,
      /* A cloud backup is usable once it is here; the screen offers "indir". */
      usable: false,
      note: 'Önce indirilmeli',
    }))),
    cloud_ok: !!cloud.ok,
    cloud_error: cloud.ok ? null : cloud.error,
    /* not `status`: the screen and the tests read the HTTP status out of the
       same object, and a body field by that name silently replaces it. */
    restore_state: status(),
  };
}

module.exports = { preview, run, cloudList, cloudFetch, sources, maintenance, status, cmpVersion,
  rememberIdentity };
