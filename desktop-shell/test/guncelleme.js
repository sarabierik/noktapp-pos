/*
 * THE UPDATE CHANNEL - the one path where being wrong means administrator code
 * on every till we have sold.
 *
 * These are the cases that matter, and they are all the same case seen from
 * different angles: someone who owns the web server, and does not own the
 * signing key, must not be able to make a till run their installer.
 *
 * Run:  node desktop-shell/test/guncelleme.js
 */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = require('../src/guncelleme-dogrula');

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { fails.push(name + ' -> ' + e.message); }
}

/* ---- a real release, signed with a real key ------------------------- */
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const ACIK = publicKey.export({ type: 'spki', format: 'pem' });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nokguncelleme-'));
const kurulum = path.join(tmp, 'NoktApp-POS-Setup-3.8.0.exe');
fs.writeFileSync(kurulum, crypto.randomBytes(4096));
const GERCEK_SHA = D.dosyaSha512(kurulum);

const YML = [
  'version: 3.8.0',
  'files:',
  '  - url: NoktApp-POS-Setup-3.8.0.exe',
  '    sha512: ' + GERCEK_SHA,
  '    size: 4096',
  'path: NoktApp-POS-Setup-3.8.0.exe',
  'sha512: ' + GERCEK_SHA,
  "releaseDate: '2026-09-16T00:00:00.000Z'",
  '',
].join('\n');

const imzala = (metin, key = privateKey) =>
  crypto.sign(null, Buffer.from(metin, 'utf8'), key).toString('base64');

const IMZA = imzala(YML);

/* ---- reading the manifest ------------------------------------------- */
check('the manifest yields version, path and sha512', () => {
  const m = D.manifestOku(YML);
  assert.strictEqual(m.version, '3.8.0');
  assert.strictEqual(m.path, 'NoktApp-POS-Setup-3.8.0.exe');
  assert.strictEqual(m.sha512, GERCEK_SHA);
});

check('the top-level sha512 is taken, not the one nested under files', () => {
  /* Both exist in every real latest.yml. Reading the nested one would mean
   * verifying the installer against a line an attacker can vary independently
   * of the one electron-updater acts on. */
  const sahte = GERCEK_SHA.slice(0, -4) + 'AAAA';
  const yml = YML.replace('    sha512: ' + GERCEK_SHA, '    sha512: ' + sahte);
  assert.strictEqual(D.manifestOku(yml).sha512, GERCEK_SHA);
});

check('an empty manifest is refused', () => {
  assert.throws(() => D.manifestOku(''), /bos/);
});

check('a manifest with no sha512 is refused', () => {
  const yml = YML.split('\n').filter(l => !/^sha512:/.test(l)).join('\n');
  assert.throws(() => D.manifestOku(yml), /sha512/);
});

/* ---- the signature -------------------------------------------------- */
check('our own signed manifest verifies', () => {
  assert.strictEqual(D.imzaDogrula(Buffer.from(YML, 'utf8'), IMZA, ACIK), true);
});

check('ONE BYTE changed in the manifest breaks it', () => {
  const kurcalanmis = YML.replace('version: 3.8.0', 'version: 3.8.1');
  assert.throws(() => D.imzaDogrula(Buffer.from(kurcalanmis, 'utf8'), IMZA, ACIK),
    /gecersiz/);
});

check('a manifest signed with SOMEONE ELSE\'S key is refused', () => {
  /* The whole point. An attacker owning pos.noktapp.com can write any
   * latest.yml and any signature beside it - with their own key, because they
   * do not have ours. */
  const { privateKey: baskasi } = crypto.generateKeyPairSync('ed25519');
  const sahteYml = YML.replace(GERCEK_SHA, GERCEK_SHA.slice(0, -4) + 'BBBB');
  const sahteImza = imzala(sahteYml, baskasi);
  assert.throws(() => D.imzaDogrula(Buffer.from(sahteYml, 'utf8'), sahteImza, ACIK),
    /gecersiz/);
});

check('a missing signature file is refused, not ignored', () => {
  assert.throws(() => D.imzaDogrula(Buffer.from(YML, 'utf8'), '', ACIK), /imza/i);
});

check('no configured public key means refuse, never "allow"', () => {
  assert.throws(() => D.imzaDogrula(Buffer.from(YML, 'utf8'), IMZA, ''),
    /anahtari tanimli degil/);
});

check('a signature that is not base64 is refused', () => {
  assert.throws(() => D.imzaDogrula(Buffer.from(YML, 'utf8'), '!!!!', ACIK));
});

/* ---- the downloaded file -------------------------------------------- */
check('the real installer matches the signed hash', () => {
  assert.strictEqual(D.kurulumDosyasiDogrula(kurulum, D.manifestOku(YML)), true);
});

check('an installer swapped after signing is refused', () => {
  /* The manifest is genuine and signed; the .exe beside it is not the one it
   * describes. This is the case electron-updater would also catch - but only
   * against a latest.yml it fetched itself, which is the file we do not trust. */
  const degistirilmis = path.join(tmp, 'sahte.exe');
  fs.writeFileSync(degistirilmis, crypto.randomBytes(4096));
  assert.throws(() => D.kurulumDosyasiDogrula(degistirilmis, D.manifestOku(YML)),
    /uyusmuyor/);
});

check('a missing download is refused', () => {
  assert.throws(() => D.kurulumDosyasiDogrula(path.join(tmp, 'yok.exe'), D.manifestOku(YML)),
    /bulunamadi/);
});

/* ---- the two answers have to agree ---------------------------------- */
check('the signed version and the updater version must agree', () => {
  assert.strictEqual(D.surumEslesiyorMu({ version: '3.8.0' }, { version: '3.8.0' }), true);
  assert.strictEqual(D.surumEslesiyorMu({ version: '3.8.0' }, { version: '3.9.0' }), false);
  assert.strictEqual(D.surumEslesiyorMu({ version: '3.8.0' }, null), false);
  assert.strictEqual(D.surumEslesiyorMu({ version: '3.8.0' }, {}), false);
});

/* ---- the shell is actually wired this way --------------------------- */
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

check('autoDownload is off - nothing is fetched before the signature is checked', () => {
  assert.ok(/autoUpdater\.autoDownload\s*=\s*false/.test(main),
    'autoDownload must be false');
  assert.ok(!/autoUpdater\.autoDownload\s*=\s*true/.test(main),
    'autoDownload is set to true somewhere');
});

check('no signing key configured means setupUpdates gives up', () => {
  assert.ok(/if \(!PUBLIC_KEY\)/.test(main) && /updater: DISABLED/.test(main),
    'an unconfigured key must disable updates, not skip verification');
});

check('the downloaded file is verified before the install dialog', () => {
  const dogrulaAt = main.indexOf('kurulumDosyasiDogrula');
  const dialogAt = main.indexOf('Guncelleme hazir');
  assert.ok(dogrulaAt > 0 && dialogAt > 0 && dogrulaAt < dialogAt,
    'the hash check must come before we offer to install');
});

check('the private key is not in the repository', () => {
  const kok = path.join(__dirname, '..', '..');
  const suphe = [];
  (function walk(dir, depth) {
    if (depth > 3) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.pem$|ozel-anahtar|private.*key/i.test(e.name)) suphe.push(p);
    }
  })(kok, 0);
  assert.deepStrictEqual(suphe, [], 'key-shaped files found: ' + suphe.join(', '));
});

fs.rmSync(tmp, { recursive: true, force: true });

const total = pass + fails.length;
if (fails.length) {
  for (const f of fails) console.log('  ! ' + f);
  console.log(pass + '/' + total + ' checks passed');
  process.exit(1);
}
console.log(pass + '/' + total + ' checks passed');
