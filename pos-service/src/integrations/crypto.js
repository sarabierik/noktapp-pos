'use strict';
/**
 * Authenticated encryption for provider credentials.
 *
 * The till had no secret store. `jwt_secret` and `device_id` are generated into
 * np_settings and modules/settings refuses to let the UI read them back, which
 * is the right shape for a value nobody ever needs to see - but a platform API
 * secret is different: it is somebody ELSE's secret, it is worth money, and it
 * sits on a restaurant PC that is backed up nightly to our cloud. Storing it in
 * a settings row would put Trendyol's API secret in plain text inside every
 * backup we hold.
 *
 * So: AES-256-GCM. Authenticated, not just encrypted - a backup that has been
 * tampered with fails to open rather than decrypting to something attacker
 * chosen. The envelope is `v1.<iv>.<tag>.<ciphertext>`, all base64url, so the
 * format can be changed later without guessing what an old row was.
 *
 * WHERE THE KEY COMES FROM, in order:
 *
 *   1. NOKTAPP_MASTER_KEY   - 32 bytes as hex or base64, or any passphrase
 *                             (scrypt-stretched with a per-install salt). For
 *                             the operator who wants to hold the key himself.
 *   2. secrets/integration.key in the data folder - generated once at first
 *                             use, 0600 plus a locked-down Windows ACL.
 *   3. np_settings.integration_master_key - legacy only, migrated to (2) the
 *                             first time this runs on an existing install.
 *
 * (2) is the one nearly every install uses, and it is the reason the earlier
 * version of this file was wrong. It told the owner of a restaurant PC to set
 * a Windows environment variable, which nobody was ever going to do, and then
 * showed him a red banner for the rest of the product's life for not doing it.
 * A warning that fires on every install is not a warning, it is furniture.
 *
 * The threat it named was real though: our nightly upload is a mysqldump, so a
 * key in np_settings travels to our server inside every backup, sitting beside
 * the ciphertext it opens. A key in a FILE does not - backup.js dumps the
 * database and nothing else. That fixes the actual problem without asking the
 * customer to do anything, so the file is written and the settings row is
 * deleted.
 *
 * The cost, stated plainly because it is real: restoring a database onto a
 * different PC no longer carries the platform credentials with it. The owner
 * re-enters them once from "Bağlan". That is the correct trade - the whole
 * point is that the backup cannot open them.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const db = require('../db');
const config = require('../config');
const log = require('../logger');

const ALGO = 'aes-256-gcm';
const KEY_DIR = path.join(config.dataDir, 'secrets');
const KEY_FILE = path.join(KEY_DIR, 'integration.key');
let cached = null;
let warned = false;

function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function unb64u(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

/**
 * Take the file out of inheritance and grant it to SYSTEM, the local
 * Administrators group and the account the service runs as - nobody else.
 *
 * By SID, not by name: this ships to Turkish Windows, where the group is
 * called "Yöneticiler", and an icacls line that names "Administrators" there
 * fails silently and leaves the file readable by every user of the PC.
 *
 * Best effort by design. A key file with default permissions is still an
 * enormous improvement on a key inside the nightly upload, so a machine where
 * icacls will not run gets the file anyway rather than no protection at all.
 */
function lockDown(file) {
  if (process.platform !== 'win32') return;
  const args = [file, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '/grant:r', '*S-1-5-32-544:F'];
  if (process.env.USERNAME) args.push('/grant:r', process.env.USERNAME + ':F');
  try {
    execFile('icacls', args, { windowsHide: true }, (err) => {
      if (err) log.warn('entegrasyon', 'Anahtar dosyasi izinleri daraltilamadi: ' + err.message);
    });
  } catch (_) { /* the key file matters, the ACL is a bonus */ }
}

function readKeyFile() {
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    log.warn('entegrasyon', 'Anahtar dosyasi bozuk gorunuyor: ' + KEY_FILE);
  } catch (_) { /* not there yet */ }
  return null;
}

/** Returns true only if the key is genuinely on disk afterwards. */
function writeKeyFile(hex) {
  try {
    fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, hex + '\n', { mode: 0o600 });
    try { fs.chmodSync(KEY_FILE, 0o600); } catch (_) {}
    lockDown(KEY_FILE);
    return true;
  } catch (e) {
    log.warn('entegrasyon', 'Anahtar dosyasi yazilamadi (' + KEY_FILE + '): ' + e.message);
    return false;
  }
}

/** A 32 byte key from whatever this installation has. */
async function masterKey() {
  if (cached) return cached;

  const env = process.env.NOKTAPP_MASTER_KEY;
  if (env && env.trim()) {
    const raw = env.trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) { cached = Buffer.from(raw, 'hex'); return cached; }
    const asB64 = Buffer.from(raw, 'base64');
    if (asB64.length === 32) { cached = asB64; return cached; }
    // a passphrase: stretch it, salted with something that is per installation
    // so the same passphrase on two tills is not the same key
    let salt = await db.getSetting('integration_key_salt');
    if (!salt) { salt = crypto.randomBytes(16).toString('hex'); await db.setSetting('integration_key_salt', salt); }
    cached = crypto.scryptSync(raw, Buffer.from(salt, 'hex'), 32);
    return cached;
  }

  const fromFile = readKeyFile();
  if (fromFile) { cached = fromFile; return cached; }

  // An install from before the key file existed. Move the key out of the
  // database - write first, delete only once the file is proven readable,
  // because losing this key means losing every stored credential.
  const legacy = await db.getSetting('integration_master_key');
  if (legacy && /^[0-9a-fA-F]{64}$/.test(legacy)) {
    if (writeKeyFile(legacy) && readKeyFile()) {
      await db.exec("DELETE FROM np_settings WHERE k='integration_master_key'").catch(() => {});
      log.info('entegrasyon', 'Ana sifreleme anahtari veritabanindan dosyaya tasindi; yedekler artik anahtari tasimiyor.');
    } else if (!warned) {
      warned = true;
      log.warn('entegrasyon', 'Ana anahtar veritabaninda kaldi; anahtar dosyasi yazilamadi.');
    }
    cached = Buffer.from(legacy, 'hex');
    return cached;
  }

  // First use on this PC.
  const fresh = crypto.randomBytes(32).toString('hex');
  if (writeKeyFile(fresh)) {
    cached = Buffer.from(fresh, 'hex');
    return cached;
  }
  // Could not write to disk at all (a locked-down data folder). Still better to
  // encrypt with a database key than to store the secrets in the clear.
  await db.setSetting('integration_master_key', fresh);
  if (!warned) {
    warned = true;
    log.warn('entegrasyon', 'Anahtar dosyasi yazilamadigi icin ana anahtar veritabaninda tutuluyor.');
  }
  cached = Buffer.from(fresh, 'hex');
  return cached;
}

/** Forget the cached key - only the tests and a re-key need this. */
function reset() { cached = null; warned = false; }

/** True when the key came from the environment rather than anywhere else. */
function keyFromEnvironment() { return !!(process.env.NOKTAPP_MASTER_KEY && process.env.NOKTAPP_MASTER_KEY.trim()); }

/**
 * Where the key lives, for the screen. Sync on purpose: it is called while
 * building a payload and it is two cheap checks.
 *
 * 'db' is the only one the UI has anything to say about, and it means writing
 * to the data folder failed - which is a real fault worth showing, unlike the
 * old banner that fired on every healthy install.
 */
function keySource() {
  if (keyFromEnvironment()) return 'env';
  try { if (fs.existsSync(KEY_FILE)) return 'file'; } catch (_) {}
  return 'db';
}

function keyFilePath() { return KEY_FILE; }

async function encrypt(plainObject) {
  const key = await masterKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(plainObject), 'utf8')), c.final()]);
  return ['v1', b64u(iv), b64u(c.getAuthTag()), b64u(data)].join('.');
}

async function decrypt(envelope) {
  if (!envelope) return null;
  const parts = String(envelope).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Sağlayıcı bilgileri okunamadı (biçim hatası)');
  const key = await masterKey();
  const d = crypto.createDecipheriv(ALGO, key, unb64u(parts[1]));
  d.setAuthTag(unb64u(parts[2]));
  let out;
  try { out = Buffer.concat([d.update(unb64u(parts[3])), d.final()]); }
  catch (_) {
    // GCM said the ciphertext does not match the key or has been altered. The
    // ordinary cause is a database restored onto a PC that does not have the
    // key file - the credentials are simply re-entered once.
    throw new Error('Sağlayıcı bilgileri çözülemedi. Bu bilgisayarın anahtarı ile şifrelenmemişler; ' +
      'platform anahtarlarını "Bağlan" ile yeniden girin.');
  }
  return JSON.parse(out.toString('utf8'));
}

/**
 * What the screen is allowed to see.
 *
 * Never the value. Four leading characters at most and only when the value is
 * long enough for that to mean anything - "ab…" from a six character secret is
 * a quarter of it.
 */
function mask(v) {
  const s = String(v == null ? '' : v);
  if (!s) return '';
  if (s.length <= 6) return '•'.repeat(s.length);
  return s.slice(0, 3) + '•'.repeat(Math.min(8, s.length - 6)) + s.slice(-2);
}

/** A one line masked summary of a credential set, for np_int_connections.cred_hint. */
function hint(creds) {
  const keys = Object.keys(creds || {}).filter(k => creds[k] !== '' && creds[k] !== null && creds[k] !== undefined);
  return keys.map(k => `${k}=${mask(creds[k])}`).join(' · ').slice(0, 250);
}

module.exports = { encrypt, decrypt, mask, hint, reset, keyFromEnvironment, keySource, keyFilePath, masterKey };
