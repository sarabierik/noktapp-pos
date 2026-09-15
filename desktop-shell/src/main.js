'use strict';
/**
 * NOKTApp POS - Windows shell.
 *
 * The shell has three jobs and no more:
 *   1. start the bundled MariaDB engine and the local service,
 *   2. show the till in a frameless window (and the customer display on the
 *      second monitor if there is one),
 *   3. keep the program up to date from pos.noktapp.com.
 *
 * There is no separate print agent to install and no console window: the
 * customer sees one icon on the desktop, and that is the whole product.
 */
const { app, BrowserWindow, screen, dialog, shell, ipcMain, Menu } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');

const isDev = !app.isPackaged;
const ROOT = isDev ? path.join(__dirname, '..', '..') : process.resourcesPath;
const DATA_DIR = path.join(process.env.PROGRAMDATA || app.getPath('userData'), 'NoktAppPOS');
const DB_DATA = path.join(DATA_DIR, 'mysql-data');

/*
 * WHERE THE DATABASE ENGINE IS.
 *
 * Two places, and it took a dead till to learn that this had to be a question
 * rather than a constant.
 *
 * The installer can carry the engine inside itself (MOTOR-HAZIRLA.ps1 fills
 * vendor\mariadb before the build) and then it lives under resources\mariadb.
 * When the build machine has no copy - which is every build made anywhere but
 * a prepared Windows box - `vendor/mariadb` ships EMPTY, and the engine is
 * supposed to be fetched onto the customer's PC at first start and kept at
 * ProgramData\NoktAppPOS\mariadb, so that program updates never re-download
 * ninety megabytes.
 *
 * That second half was written down in vendor/mariadb/BENIOKU.txt and never
 * implemented. It did not show for months because the very first install a
 * machine ever got had been built on Windows WITH the engine, and NSIS leaves
 * files it did not install alone - so every later upgrade shipped an empty
 * folder, added nothing, removed nothing, and the original engine kept
 * running. Until an install cleaned the folder out, and the till came up with
 *
 *     spawn ...\resources\mariadb\bin\mariadbd.exe ENOENT
 *
 * on a restaurant's counter, with every byte of its data still safe in
 * mysql-data and nothing to open it with.
 *
 * So: look in both, in that order, and if the engine is in neither, fetch it
 * before anything else runs. MYSQL_DIR is resolved once at startup.
 */
const BUNDLED_MYSQL = path.join(ROOT, 'mariadb');
const DATA_MYSQL = path.join(DATA_DIR, 'mariadb');
const MARIADB_VERSION = '10.11.9';
let MYSQL_DIR = BUNDLED_MYSQL;

function hasEngine(dir) {
  try { return fs.existsSync(path.join(dir, 'bin', 'mariadbd.exe')); } catch (_) { return false; }
}
const SERVICE_DIR = path.join(ROOT, 'pos-service');
const LOG = path.join(DATA_DIR, 'logs', 'shell.log');

let mainWin = null, displayWin = null, dbProc = null, svcProc = null, quitting = false;
const PORT = 7451, DB_PORT = 7452;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line); } catch (_) {}
  if (isDev) console.log(msg.trim());
}

function waitForPort(port, timeoutMs = 90000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() - started > timeoutMs) return reject(new Error('Servis baslatilamadi (port ' + port + ')'));
        setTimeout(tryOnce, 600);
      });
    };
    tryOnce();
  });
}

/* ------------------------- bundled MariaDB ------------------------- */
function ensureConfigFile(password) {
  // the engine writes its error log into logs\ before the service ever runs,
  // so every folder has to exist up front, not just DATA_DIR
  for (const d of [DATA_DIR, path.join(DATA_DIR, 'logs'), path.join(DATA_DIR, 'backups'),
                   path.join(DATA_DIR, 'media'), path.join(DATA_DIR, 'tmp'), DB_DATA]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const p = path.join(DATA_DIR, 'config.json');
  let cfg = {};
  if (fs.existsSync(p)) { try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {} }
  cfg = Object.assign({
    port: PORT, dbHost: '127.0.0.1', dbPort: DB_PORT, dbUser: 'noktapp',
    dbName: 'noktapp_pos', panelUrl: 'https://pos.noktapp.com',
  }, cfg);
  if (password) cfg.dbPass = password;
  if (!cfg.dbPass) cfg.dbPass = require('crypto').randomBytes(18).toString('base64url');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return cfg;
}

/**
 * Put an engine on this machine if there is not one already.
 *
 * Only ever called when both locations came up empty, which on a healthy
 * install is once in the life of the PC. Everything lands in ProgramData, not
 * in Program Files, precisely so the next update cannot take it away again -
 * that is the failure this function exists because of.
 *
 * Downloaded and unpacked with what Windows already has: Node's own https for
 * the file, PowerShell's Expand-Archive for the zip. No new dependency travels
 * inside the installer for a step that runs once.
 */
function downloadTo(url, target, onProgress) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const go = (u, depth) => {
      if (depth > 5) return reject(new Error('Cok fazla yonlendirme'));
      https.get(u, { headers: { 'User-Agent': 'NoktAppPOS' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, u).toString(), depth + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('Motor indirilemedi (HTTP ' + res.statusCode + ')'));
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const ws = fs.createWriteStream(target);
        res.on('data', (c) => {
          got += c.length;
          if (onProgress && total) onProgress(Math.round((got / total) * 100));
        });
        res.on('error', (e) => { ws.destroy(); reject(e); });
        ws.on('error', reject);
        res.pipe(ws);
        ws.on('close', () => (got > 40 * 1024 * 1024
          ? resolve(got)
          : reject(new Error('Motor dosyasi eksik indi (' + got + ' bayt)'))));
      }).on('error', reject);
    };
    go(url, 0);
  });
}

function powershell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024 * 32 },
      (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout));
  });
}

async function ensureEngine(say) {
  if (hasEngine(BUNDLED_MYSQL)) { MYSQL_DIR = BUNDLED_MYSQL; return false; }
  if (hasEngine(DATA_MYSQL)) { MYSQL_DIR = DATA_MYSQL; return false; }

  MYSQL_DIR = DATA_MYSQL;
  log('No database engine found in either location; fetching one');
  if (say) say('Veritabanı motoru indiriliyor (bir kez, yaklaşık 90 MB)…');

  const tmp = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, 'mariadb-' + MARIADB_VERSION + '-winx64.zip');

  /*
   * Four places to ask, because this is the one step that needs the outside
   * world and it happens on somebody's opening morning. archive.mariadb.org
   * is the source of truth but it is a single European host and Turkish
   * connections to it are not always good; the rest are the project's own
   * public mirrors carrying byte-identical files. First one that answers wins.
   */
  const path_ = 'mariadb-' + MARIADB_VERSION + '/winx64-packages/mariadb-'
              + MARIADB_VERSION + '-winx64.zip';
  const mirrors = [
    'https://archive.mariadb.org/' + path_,
    'https://mirror.rackspace.com/mariadb/' + path_,
    'https://ftp.nluug.nl/db/mariadb/' + path_,
    'https://mirrors.aliyun.com/mariadb/' + path_,
  ];

  let got = false, lastErr = null;
  for (let i = 0; i < mirrors.length && !got; i++) {
    try { if (fs.existsSync(zip)) fs.unlinkSync(zip); } catch (_) {}
    try {
      log('Fetching engine from ' + mirrors[i]);
      await downloadTo(mirrors[i], zip,
        (pct) => { if (say) say('Veritabanı motoru indiriliyor… %' + pct); });
      got = true;
    } catch (e) {
      lastErr = e;
      log('Mirror ' + (i + 1) + ' failed: ' + e.message);
      if (say && i + 1 < mirrors.length) say('Yedek sunucu deneniyor…');
    }
  }
  if (!got) {
    throw new Error('Veritabani motoru indirilemedi. Internet baglantisini kontrol edin. '
      + '(' + (lastErr && lastErr.message) + ')');
  }

  if (say) say('Veritabanı motoru açılıyor…');
  const stage = path.join(tmp, 'motor');
  await powershell(
    '$ErrorActionPreference="Stop";' +
    'if (Test-Path "' + stage + '") { Remove-Item "' + stage + '" -Recurse -Force };' +
    'Expand-Archive -Path "' + zip + '" -DestinationPath "' + stage + '" -Force;' +
    '$src = (Get-ChildItem "' + stage + '" -Directory | Select-Object -First 1).FullName;' +
    'if (Test-Path "' + DATA_MYSQL + '") { Remove-Item "' + DATA_MYSQL + '" -Recurse -Force };' +
    'Move-Item $src "' + DATA_MYSQL + '"'
  );

  try { fs.unlinkSync(zip); } catch (_) {}
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}

  if (!hasEngine(DATA_MYSQL)) throw new Error('Motor kuruldu ama mariadbd.exe bulunamadi.');
  log('Database engine installed at ' + DATA_MYSQL);
  return true;
}

function runTool(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(path.join(MYSQL_DIR, 'bin', bin), args,
      { windowsHide: true, maxBuffer: 1024 * 1024 * 64, ...opts },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        /* These tools put the useful half of the story on stdout and the
           other half on stderr; err.message alone is usually just an exit
           code. Keep all three or the log tells us nothing. */
        const detail = [stderr, stdout].map(x => String(x || '').trim())
          .filter(Boolean).join('\n') || err.message;
        reject(new Error(detail));
      });
  });
}

/**
 * Lay down a fresh data directory.
 *
 * WHY THERE IS NO --basedir HERE.
 *
 * The Windows mariadb-install-db.exe is not the Unix mysql_install_db shell
 * script and does not take the same switches. It has no --basedir at all: it
 * works out where the engine lives from its own location on disk, which is
 * always right, and my_getopt rejects anything it does not know:
 *
 *     mariadb-install-db.exe: unknown variable 'basedir=C:\ProgramData\...'
 *
 * That killed the first launch on every PC that had to fetch its own engine -
 * which is every PC except the one the installer was built on. The comment
 * that used to sit on that line ("without this it cannot find share\*.sql")
 * was simply wrong.
 *
 * The retry below is not politeness. This runs once, unattended, on a
 * stranger's computer, and the engine it runs against is whatever version
 * archive.mariadb.org served that day. If a future build drops or renames one
 * of the optional switches we lose a restaurant's opening morning, so a
 * failure falls back to the one switch the tool cannot do without and tries
 * again on a clean directory.
 */
async function initDatabase(cfg) {
  if (fs.existsSync(path.join(DB_DATA, 'mysql'))) return false;   // already installed
  log('Initialising the database engine at ' + DB_DATA);

  const wipe = () => {
    // install-db refuses a directory that is not empty, so a half-written
    // attempt has to go before the next one can start
    try { fs.rmSync(DB_DATA, { recursive: true, force: true }); } catch (_) {}
    fs.mkdirSync(DB_DATA, { recursive: true });
  };

  const attempts = [
    ['--datadir=' + DB_DATA, '--port=' + DB_PORT, '--default-user'],
    ['--datadir=' + DB_DATA],
  ];

  let last = null;
  for (let i = 0; i < attempts.length; i++) {
    wipe();
    try {
      const out = await runTool('mariadb-install-db.exe', attempts[i]);
      log('install-db ok' + (i ? ' (fallback arguments)' : '') + ': '
          + String(out || '').trim().split('\n').slice(-1)[0]);
      if (!fs.existsSync(path.join(DB_DATA, 'mysql'))) {
        throw new Error('install-db bitti ama mysql klasoru olusmadi.');
      }
      return true;
    } catch (e) {
      last = e;
      log('install-db attempt ' + (i + 1) + ' failed: ' + e.message);
    }
  }
  throw new Error('Veritabani olusturulamadi: ' + (last && last.message));
}

function startDatabase(cfg) {
  const bin = path.join(MYSQL_DIR, 'bin', 'mariadbd.exe');
  dbProc = spawn(bin, [
    '--datadir=' + DB_DATA,
    '--port=' + DB_PORT,
    '--bind-address=127.0.0.1',
    '--skip-name-resolve',
    '--innodb-buffer-pool-size=256M',
    '--max-connections=64',
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_general_ci',
    '--log-error=' + path.join(DATA_DIR, 'logs', 'mariadb.err'),
    '--pid-file=' + path.join(DATA_DIR, 'mariadb.pid'),   // never inherit a system default that may not exist
  ], { windowsHide: true, detached: false, stdio: 'ignore' });
  dbProc.on('exit', (code) => { log('Database engine exited: ' + code); if (!quitting) fatal('Veritabani motoru kapandi.'); });
  return waitForPort(DB_PORT, 60000);
}

/**
 * Feed a .sql file to the client on its standard input.
 * The client has no "run this file" switch, and execFile cannot write to a
 * child's stdin, so the file is piped in and the exit code is checked - a
 * schema that fails to load must stop the launch, not be shrugged off.
 */
/*
 * `keepGoing` adds --force, and it is only ever set for the migrations.
 *
 * The file is piped in on one stdin, so without it the client stops dead at the
 * first statement that errors and every statement BELOW it is skipped - not
 * retried on the next boot either, because the next boot fails at the same
 * line. A real till ran for seven days replaying a migration that died on line
 * 29, so line 30 had never run and nothing on screen ever said so.
 *
 * The schema load keeps the old behaviour: a broken 01_schema_core.sql must
 * stop the install, not half-build a database and open the till on it.
 */
function loadSqlFile(dbName, file, { fatalOnError = true, keepGoing = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(MYSQL_DIR, 'bin', 'mariadb.exe'),
      ['--host=127.0.0.1', '--port=' + DB_PORT, '--user=root',
       '--default-character-set=utf8mb4', ...(keepGoing ? ['--force'] : []), dbName],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(true);
      const msg = path.basename(file) + ' yuklenemedi: ' + stderr.trim().slice(0, 400);
      log('SQL LOAD FAILED: ' + msg);
      return fatalOnError ? reject(new Error(msg)) : resolve(false);
    });
    fs.createReadStream(file).pipe(child.stdin);
  });
}

/** Create the database, the service user and load the schema the first time. */
async function provisionDatabase(cfg, fresh) {
  const sqlDir = path.join(ROOT, 'database');
  const client = (sql) => runTool('mariadb.exe',
    ['--host=127.0.0.1', '--port=' + DB_PORT, '--user=root', '--execute=' + sql]);

  if (fresh) {
    log('Creating the database and the service account');
    /*
     * The service account used to be granted ALL PRIVILEGES ON *.* WITH GRANT
     * OPTION - MariaDB root in all but name, held by an HTTP server that
     * listens on the LAN. Any injection or slip in the service was therefore
     * full administration of the whole instance, including the right to hand
     * that out to new accounts.
     *
     * It does not need any of that. Schema loading and the boot migrations are
     * run by THIS process as root (see loadSqlFile), so the service never
     * performs DDL on the live database. What it genuinely needs is:
     *
     *   its own database          everything, for ordinary work, and for the
     *                             triggers and events the schema installs
     *   <db>_geri                 the same, because a restore rebuilds and
     *                             verifies the dump in that scratch database
     *                             before the live one is touched
     *   RELOAD, PROCESS, LOCK     mysqldump needs these instance-wide; they
     *                             read state, they do not change data
     *
     * and nothing else. No *.* and no GRANT OPTION.
     */
    await client(
      `CREATE DATABASE IF NOT EXISTS \`${cfg.dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;` +
      `CREATE USER IF NOT EXISTS '${cfg.dbUser}'@'127.0.0.1' IDENTIFIED BY '${cfg.dbPass}';` +
      `GRANT ALL PRIVILEGES ON \`${cfg.dbName}\`.* TO '${cfg.dbUser}'@'127.0.0.1';` +
      `GRANT ALL PRIVILEGES ON \`${cfg.dbName}_geri\`.* TO '${cfg.dbUser}'@'127.0.0.1';` +
      `GRANT RELOAD, PROCESS, LOCK TABLES, SHOW DATABASES ON *.* TO '${cfg.dbUser}'@'127.0.0.1';` +
      `FLUSH PRIVILEGES;`);

    for (const f of ['01_schema_core.sql', '02_schema_local.sql', '04_local_tweaks.sql', '05_loyalty.sql']) {
      const file = path.join(sqlDir, f);
      if (!fs.existsSync(file)) throw new Error('Kurulum dosyasi eksik: ' + f);
      log('Loading ' + f);
      await loadSqlFile(cfg.dbName, file);
    }
    // prove the schema is really there before we let the till open on it
    const tables = await client(
      `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${cfg.dbName}'`);
    const n = parseInt(String(tables).split(/\s+/).filter(Boolean).pop(), 10);
    if (!(n > 80)) throw new Error('Veritabani semasi eksik yuklendi (' + n + ' tablo).');
    log('Schema loaded: ' + n + ' tables');
  }

  /*
   * Existing installations were provisioned with the old ALL ON *.* WITH GRANT
   * OPTION. Narrowing it has to happen on upgrade too, or the fix only ever
   * reaches machines installed after today. REVOKE is harmless on an account
   * that never had it, so this runs unconditionally and ignores failure.
   */
  try {
    await client(
      `REVOKE ALL PRIVILEGES, GRANT OPTION ON *.* FROM '${cfg.dbUser}'@'127.0.0.1';` +
      `GRANT ALL PRIVILEGES ON \`${cfg.dbName}\`.* TO '${cfg.dbUser}'@'127.0.0.1';` +
      `GRANT ALL PRIVILEGES ON \`${cfg.dbName}_geri\`.* TO '${cfg.dbUser}'@'127.0.0.1';` +
      `GRANT RELOAD, PROCESS, LOCK TABLES, SHOW DATABASES ON *.* TO '${cfg.dbUser}'@'127.0.0.1';` +
      `FLUSH PRIVILEGES;`);
    log('Service account privileges narrowed to its own databases');
  } catch (e) { log('Privilege narrowing skipped: ' + e.message); }

  // migrations are re-run on every start; each file is written to be idempotent,
  // so one that has already been applied is expected to complain and is ignored
  const migDir = path.join(sqlDir, 'migrations');
  if (fs.existsSync(migDir)) {
    for (const f of fs.readdirSync(migDir).filter(x => x.endsWith('.sql')).sort()) {
      await loadSqlFile(cfg.dbName, path.join(migDir, f), { fatalOnError: false, keepGoing: true });
    }
  }
}

/* --------------------------- local service -------------------------- */
function startService(cfg) {
  const nodeBin = process.execPath;                 // Electron doubles as the node runtime
  svcProc = spawn(nodeBin, [path.join(SERVICE_DIR, 'src', 'index.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NOKTAPP_DATA_DIR: DATA_DIR,
      NOKTAPP_PORT: String(cfg.port),
      NOKTAPP_PACKAGED: '1',
      NOKTAPP_VERSION: app.getVersion(),
      NOKTAPP_DUMP_BIN: path.join(MYSQL_DIR, 'bin', 'mariadb-dump.exe'),
      /* The client, for restore. Same folder, said out loud rather than left
         to the service to work out: the engine is downloaded onto the
         customer's PC after the installer has run, so nothing under
         resources/ can be assumed to exist at build time. */
      NOKTAPP_CLIENT_BIN: path.join(MYSQL_DIR, 'bin', 'mariadb.exe'),
      DB_HOST: '127.0.0.1', DB_PORT: String(cfg.dbPort),
      DB_USER: cfg.dbUser, DB_PASS: cfg.dbPass, DB_NAME: cfg.dbName,
    },
    stdio: 'ignore',
  });
  svcProc.on('exit', (code) => {
    log('Service exited: ' + code);
    if (!quitting) { setTimeout(() => startService(cfg), 2000); }   // keep the till alive
  });
  return waitForPort(cfg.port, 60000);
}

/* ------------------------------ windows ----------------------------- */
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWin = new BrowserWindow({
    width: Math.min(1440, width), height: Math.min(900, height),
    minWidth: 1100, minHeight: 700,
    backgroundColor: '#F6F6F7',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  });
  Menu.setApplicationMenu(null);
  mainWin.loadURL('http://127.0.0.1:' + PORT + '/');
  mainWin.once('ready-to-show', () => { mainWin.show(); mainWin.maximize(); });
  mainWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    dialog.showMessageBox(mainWin, {
      type: 'question', buttons: ['Vazgec', 'Kapat'], defaultId: 0,
      title: 'NoktApp POS', message: 'Kasa uygulamasi kapatilsin mi?',
      detail: 'Kapatirsaniz garson telefonlari ve yazicilar calismaz.',
    }).then(r => { if (r.response === 1) { quitting = true; app.quit(); } });
  });
  openCustomerDisplay();
}

/** Second monitor: the customer sees what is being rung up. */
function openCustomerDisplay() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const second = displays.find(d => d.id !== primary.id);
  if (!second) return;
  displayWin = new BrowserWindow({
    x: second.bounds.x, y: second.bounds.y,
    width: second.bounds.width, height: second.bounds.height,
    frame: false, fullscreen: true, backgroundColor: '#111114',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  displayWin.loadURL('http://127.0.0.1:' + PORT + '/display.html');
  displayWin.on('closed', () => { displayWin = null; });
}

function fatal(message, detail) {
  dialog.showErrorBox('NoktApp POS', message + (detail ? '\n\n' + detail : ''));
  quitting = true;
  app.quit();
}

/* ------------------------------ updates ----------------------------- */
function setupUpdates() {
  if (isDev) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    /*
     * PUBLISHING THE PREVIOUS VERSION IS THE ROLLBACK LEVER, AND IT HAS TO WORK.
     *
     * electron-updater refuses to move a machine backwards unless this is set.
     * Left off, our only answer to a release that breaks the till is to find the
     * bug, fix it, build, sign and publish - with every till in the country on
     * the broken build for however long that takes. Marking the last good
     * version as güncel does nothing at all: the updater compares, sees a lower
     * number, and stays where it is. There is no second mechanism; nobody is
     * driving to a restaurant with a USB stick.
     *
     * The risk it buys back - a downgrade that lands on a schema newer than the
     * code - is the one we can survive: the migrations are replayed on every
     * start and are additive, so the old build boots on the newer schema. The
     * risk of NOT setting it is a service the vendor cannot stop breaking.
     * This has to be right on the worst day, not the best one.
     */
    autoUpdater.allowDowngrade = true;
    autoUpdater.on('update-downloaded', async () => {
      const r = await dialog.showMessageBox(mainWin, {
        type: 'info', buttons: ['Sonra', 'Simdi guncelle'], defaultId: 1,
        title: 'Guncelleme hazir', message: 'Yeni bir NoktApp POS surumu indirildi.',
        detail: 'Gun sonu aldiktan sonra guncellemeniz onerilir.',
      });
      if (r.response === 1) { quitting = true; autoUpdater.quitAndInstall(); }
    });
    autoUpdater.on('error', e => log('updater: ' + e.message));
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 20000);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600000);
  } catch (e) { log('updater unavailable: ' + e.message); }
}

/* ------------------------------- boot ------------------------------- */
const single = app.requestSingleInstanceLock();
if (!single) { app.quit(); } else {
  app.on('second-instance', () => { if (mainWin) { mainWin.show(); mainWin.focus(); } });

  app.whenReady().then(async () => {
    /*
     * A one-off engine download takes minutes on a restaurant's connection,
     * and a program that shows nothing for minutes is a program the owner
     * force-quits halfway through. So the splash goes up FIRST and says what
     * is happening and how far along it is.
     */
    let splash = null;
    const say = (text) => {
      log(text);
      try {
        if (!splash) {
          splash = new BrowserWindow({ width: 460, height: 170, frame: false, resizable: false,
            center: true, alwaysOnTop: true, backgroundColor: '#12100e', show: true });
        }
        splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
          '<body style="margin:0;height:100vh;display:flex;flex-direction:column;gap:14px;'
          + 'align-items:center;justify-content:center;background:#12100e;color:#f6f1ea;'
          + 'font:15px system-ui,Segoe UI,sans-serif">'
          + '<div style="font-weight:650;letter-spacing:.2px">NOKTApp POS</div>'
          + '<div style="opacity:.85;text-align:center;padding:0 26px">' + text + '</div>'
          + '<div style="width:220px;height:3px;border-radius:2px;background:#2a2521;overflow:hidden">'
          + '<div style="width:40%;height:100%;background:#FF7A1A"></div></div>'
          + '<div style="opacity:.5;font-size:12px">Bu adım yalnızca bir kez yapılır.</div></body>'));
      } catch (_) { /* the splash is a courtesy; never let it stop the boot */ }
    };

    try {
      const cfg = ensureConfigFile();
      /* Before anything that needs a database: make sure there IS an engine. */
      await ensureEngine(say);
      const fresh = await initDatabase(cfg);
      await startDatabase(cfg);
      await provisionDatabase(cfg, fresh || !fs.existsSync(path.join(DATA_DIR, '.provisioned')));
      fs.writeFileSync(path.join(DATA_DIR, '.provisioned'), new Date().toISOString());
      await startService(cfg);
      createWindow();
      setupUpdates();
      try { if (splash) { splash.destroy(); splash = null; } } catch (_) {}
      log('Started, version ' + app.getVersion() + ', engine at ' + MYSQL_DIR);
    } catch (e) {
      try { if (splash) { splash.destroy(); splash = null; } } catch (_) {}
      log('BOOT FAILED: ' + (e.stack || e.message));
      /*
       * The engine failing to arrive is its own message. "Uygulama
       * baslatilamadi" in front of a restaurant owner whose data is sitting
       * safe in mysql-data tells him he has lost everything, and he has not.
       */
      const raw = String(e.message || e);
      if (/mariadbd\.exe|Motor|motor indirilemedi/i.test(raw)) {
        fatal('Veritabanı motoru bulunamadı ve indirilemedi.',
          'Verileriniz yerinde duruyor; eksik olan yalnızca motor programı.\n\n'
          + 'Bilgisayarın internete bağlı olduğundan emin olup programı yeniden açın.\n\n'
          + raw + '\n\nKayıt dosyası: ' + LOG);
      } else {
        fatal('Uygulama baslatilamadi.', raw + '\n\nKayit dosyasi: ' + LOG);
      }
    }
  });

  app.on('window-all-closed', () => { quitting = true; app.quit(); });
  app.on('before-quit', () => {
    quitting = true;
    try { if (svcProc) svcProc.kill(); } catch (_) {}
    try { if (dbProc) dbProc.kill(); } catch (_) {}
  });
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:openLogs', () => shell.openPath(path.join(DATA_DIR, 'logs')));
ipcMain.handle('app:display', () => { if (!displayWin) openCustomerDisplay(); else displayWin.close(); });
