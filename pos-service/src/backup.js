'use strict';
/**
 * Backups.
 *  - a local snapshot every 15 minutes, kept for two weeks on the PC
 *  - one upload a night to our server, which is the only copy that leaves the
 *    building
 *  - a "Yedekle" button in the app for the manager who is about to do something
 *    they are not sure about
 *
 * The dump is produced with the mariadb-dump that ships inside the installer,
 * so nothing has to be installed or configured by the customer.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');
const db = require('./db');
const config = require('./config');
const log = require('./logger');
const licence = require('./licence');

/**
 * Where a MariaDB command line tool is.
 *
 * The customer installs nothing: the engine and its tools ship inside the
 * installer, so the copy next to the app is the one that is guaranteed to
 * match the server we are talking to. PATH is only the fallback, for a
 * developer machine and for an install where the resources folder moved.
 *
 * Restore resolves `mariadb` through this same function, and that is the
 * point of it being a function: a dump written by the bundled mariadb-dump
 * and read back by whatever `mysql` happened to be first on PATH is how you
 * get a restore that half works on one PC and not on another.
 */
/**
 * Find one of MariaDB's command line tools.
 *
 * THE ORDER MATTERS, and it is not the obvious one. The engine is not shipped
 * inside the installer - `resources/mariadb` goes out empty and is filled on
 * the restaurant's own PC at first start - and the service runs as a child
 * process with ELECTRON_RUN_AS_NODE, where `process.resourcesPath` is not the
 * reliable thing it looks like. Dumping got away with never noticing, because
 * main.js hands it NOKTAPP_DUMP_BIN outright.
 *
 * Restore did notice. On a real till the first preview died with
 * `spawn mariadb.exe ENOENT`: the resolution had fallen all the way through to
 * the bare name, and there is no MariaDB on a restaurant PC's PATH. The
 * backups had been fine the whole time, which is exactly why nobody had found
 * it - the one code path that guessed was the one nobody ran.
 *
 * So the second thing tried is the folder the DUMP binary is in. That path is
 * handed to us by the shell, it is proven every fifteen minutes by a backup
 * that works, and every tool in this set lives in that one `bin` folder. A
 * guess that has been verified by another process beats a guess about where
 * the guessing code is installed.
 */
function toolPath(tool, override) {
  if (override) return override;
  const exe = process.platform === 'win32' ? tool + '.exe' : tool;
  const tries = [];

  const dump = process.env.NOKTAPP_DUMP_BIN;
  if (dump) tries.push(path.join(path.dirname(dump), exe));
  if (process.resourcesPath) tries.push(path.join(process.resourcesPath, 'mariadb', 'bin', exe));
  tries.push(path.join(__dirname, '..', '..', 'mariadb', 'bin', exe));
  tries.push(path.join(__dirname, '..', '..', '..', 'mariadb', 'bin', exe));

  for (const p of tries) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* keep looking */ }
  }
  /* Nothing found. The bare name still works on a developer machine and on the
     test box; on a till it produces ENOENT, and the caller says so in Turkish
     rather than letting a raw spawn error reach the screen. */
  return exe;
}

function dumpBinary() { return toolPath('mariadb-dump', process.env.NOKTAPP_DUMP_BIN); }

function run(kind = 'local') {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(config.backupDir, { recursive: true });
    const name = `noktapp-pos-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${kind}.sql.gz`;
    const target = path.join(config.backupDir, name);
    const args = [
      '--host=' + config.db.host, '--port=' + config.db.port,
      '--user=' + config.db.user, '--password=' + config.db.password,
      '--single-transaction', '--routines', '--triggers', '--events',
      '--default-character-set=utf8mb4', config.db.database,
    ];
    /*
     * `encoding: 'buffer'` and not the default, which is where every Turkish
     * character in every backup this program has ever taken went.
     *
     * The default decodes the dump as UTF-8 into a JS string; the code below
     * then wrote that string back out. Re-encoding it as latin1 turned every
     * character above U+00FF into the low byte of its code point: "Kıymalı
     * Pide" was stored in the backup as "K1ymal1 Pide", and the bullet the
     * integration screen masks secrets with became a double quote, which then
     * broke the JSON in audit_logs and made the whole dump refuse to load.
     * A dump is bytes. It stays bytes from here to the file.
     */
    const child = execFile(dumpBinary(), args,
      { maxBuffer: 1024 * 1024 * 512, windowsHide: true, encoding: 'buffer' },
      async (err, stdout) => {
        if (err) return reject(new Error('Yedek alinamadi: ' + err.message));
        /*
         * One line of our own on top of MariaDB's header. A dump has to say
         * which version of the PROGRAM wrote it, not just which engine: restore
         * refuses a dump from a newer version than the till is running, and
         * without this line the only place that answer lives is inside the
         * np_settings table - which is no help for a dump taken before that
         * setting existed, or one whose settings table did not survive.
         */
        const header = `-- NOKTApp POS app_version: ${process.env.NOKTAPP_VERSION || '2.0.0'}\n`
          + `-- alindi: ${new Date().toISOString()} (${kind})\n`;
        const gz = zlib.gzipSync(Buffer.concat([Buffer.from(header, 'utf8'), Buffer.from(stdout)]));
        fs.writeFileSync(target, gz);
        const sha = crypto.createHash('sha256').update(gz).digest('hex');
        /*
         * The id comes back to the caller now. A scheduled snapshot has no use
         * for it, but the pre-restore snapshot does: the restore has to name
         * that row in its audit entry, and it cannot name a row whose insert
         * was still in flight. The insert is still allowed to fail quietly -
         * a backup that exists on disk but not in the table is a bookkeeping
         * problem, and refusing to hand over the file over it would turn it
         * into a lost backup.
         */
        const id = await db.insert(
          'INSERT INTO np_backups (kind, file_path, size_bytes, sha256, status, created_at) VALUES (?,?,?,?,?,NOW())',
          [kind, target, gz.length, sha, 'ok']).catch(() => null);
        resolve({ id, kind, file: target, size: gz.length, sha256: sha });
      });
    child.on('error', reject);
  });
}

async function prune() {
  const keep = Number(await db.getSetting('backup_keep_days', 14));
  const cutoff = Date.now() - keep * 86400000;
  /*
   * One kind of backup is never deleted by age: the snapshot taken in the
   * seconds before a restore overwrote the database. It is the only copy of
   * everything that restore erased, and the day somebody needs it is the day
   * they realise - two weeks later - that they restored the wrong file. Two
   * weeks is exactly the window this loop would have thrown it away in.
   *
   * The list is read from the table rather than guessed from the file name,
   * because a name is something a person can rename and a kind is not.
   */
  let spared = new Set();
  try {
    const rows = await db.query("SELECT file_path FROM np_backups WHERE kind='pre-restore' AND file_path IS NOT NULL");
    spared = new Set(rows.map(r => path.resolve(r.file_path)));
  } catch (_) { /* no table yet: keep the old behaviour rather than keeping nothing */ }
  try {
    for (const f of fs.readdirSync(config.backupDir)) {
      const p = path.join(config.backupDir, f);
      if (spared.has(path.resolve(p))) continue;
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch (_) {}
}

/** Upload the newest snapshot to the panel. */
async function uploadToCloud() {
  const snap = await run('cloud');
  const lic = await db.one('SELECT client_id, licence_key FROM np_licence WHERE id=1');
  if (!lic) return { skipped: 'no licence' };
  const data = fs.readFileSync(snap.file).toString('base64');
  const url = (await licence.panelUrl()) + '/api/desktop/backup.php';
  const res = await licence.post(url, {
    client_id: lic.client_id, licence_key: lic.licence_key,
    device_id: await licence.deviceId(),
    app_version: process.env.NOKTAPP_VERSION || '2.0.0',
    filename: path.basename(snap.file), sha256: snap.sha256, size: snap.size, data,
  }, 180000);
  if (res.status !== 200 || !res.body.ok) {
    await db.exec("UPDATE np_backups SET status='failed', message=? WHERE file_path=?",
      [String((res.body && res.body.error) || 'upload failed').slice(0, 250), snap.file]);
    throw new Error((res.body && res.body.error) || 'Yedek yuklenemedi');
  }
  log.info('backup', 'Cloud backup uploaded', { size: snap.size });
  return { ok: true, ...snap };
}

let localTimer = null, cloudTimer = null;

function start() {
  const tick = async () => {
    try {
      const every = Number(await db.getSetting('backup_local_every_min', 15));
      const last = await db.one("SELECT created_at FROM np_backups WHERE kind='local' ORDER BY id DESC LIMIT 1");
      if (!last || Date.now() - new Date(last.created_at).getTime() > every * 60000) {
        await run('local');
        await prune();
      }
    } catch (e) { log.warn('backup', 'local snapshot failed', e.message); }
  };
  localTimer = setInterval(tick, 60000);
  setTimeout(tick, 30000);

  cloudTimer = setInterval(async () => {
    try {
      const hour = Number(await db.getSetting('backup_cloud_hour', 3));
      const now = new Date();
      if (now.getHours() !== hour) return;
      const last = await db.one("SELECT created_at FROM np_backups WHERE kind='cloud' AND status='ok' ORDER BY id DESC LIMIT 1");
      if (last && Date.now() - new Date(last.created_at).getTime() < 20 * 3600000) return;
      await uploadToCloud();
    } catch (e) { log.warn('backup', 'cloud backup failed', e.message); }
  }, 10 * 60000);
  log.info('backup', 'Backup scheduler started');
}
function stop() { if (localTimer) clearInterval(localTimer); if (cloudTimer) clearInterval(cloudTimer); }

module.exports = { run, uploadToCloud, prune, start, stop, toolPath };
