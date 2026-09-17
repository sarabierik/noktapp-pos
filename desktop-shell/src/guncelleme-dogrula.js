'use strict';
/*
 * UPDATE VERIFICATION - deliberately free of Electron, so it can be tested.
 *
 * Nothing here reaches the network or the filesystem on its own except to hash
 * a file it is handed. Everything it decides, it decides from bytes given to
 * it, which is what makes the tamper cases in test/guncelleme.js possible to
 * write at all.
 */
const crypto = require('crypto');
const fs = require('fs');

/**
 * The handful of top-level fields we need out of electron-builder's latest.yml.
 * A real YAML parser is not warranted: the file is machine-written, flat at the
 * level we care about, and every field we read is a plain scalar. Indented
 * lines are skipped on purpose - `sha512` appears under `files:` as well, and
 * the top-level one is the one that describes the installer we are told to run.
 */
function manifestOku(ymlText) {
  if (typeof ymlText !== 'string' || !ymlText.trim()) {
    throw new Error('latest.yml bos');
  }
  const out = {};
  for (const raw of ymlText.split(/\r?\n/)) {
    if (/^\s/.test(raw) || !raw.trim()) continue;          // nested or blank
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  if (!out.version) throw new Error('latest.yml icinde version yok');
  if (!out.path) throw new Error('latest.yml icinde path yok');
  if (!out.sha512) throw new Error('latest.yml icinde sha512 yok');
  return { version: out.version, path: out.path, sha512: out.sha512 };
}

/**
 * Ed25519 over the EXACT bytes of latest.yml. Not over a parse of it, not over
 * a re-serialisation: the bytes that were signed are the bytes that are checked,
 * so there is no gap between what the signer saw and what we verify.
 */
function imzaDogrula(ymlBytes, imzaB64, publicKeyPem) {
  if (!publicKeyPem) throw new Error('Guncelleme imza anahtari tanimli degil');
  if (!imzaB64) throw new Error('latest.yml.imza bulunamadi');
  let sig;
  try {
    sig = Buffer.from(String(imzaB64).trim(), 'base64');
  } catch { throw new Error('Imza base64 olarak okunamadi'); }
  if (!sig.length) throw new Error('Imza bos');

  let key;
  try {
    key = crypto.createPublicKey(publicKeyPem);
  } catch (e) { throw new Error('Imza anahtari gecersiz: ' + e.message); }

  const bytes = Buffer.isBuffer(ymlBytes) ? ymlBytes : Buffer.from(String(ymlBytes), 'utf8');
  let ok = false;
  try {
    ok = crypto.verify(null, bytes, key, sig);
  } catch (e) { throw new Error('Imza dogrulanamadi: ' + e.message); }
  if (!ok) throw new Error('latest.yml imzasi gecersiz - bu dosyayi biz yayinlamadik');
  return true;
}

/** electron-builder records installer digests as base64 sha512. */
function dosyaSha512(dosyaYolu) {
  const h = crypto.createHash('sha512');
  h.update(fs.readFileSync(dosyaYolu));
  return h.digest('base64');
}

/**
 * The downloaded installer, against the hash inside the manifest we have
 * already proved is ours. electron-updater does its own check against the
 * latest.yml IT fetched; this one is against the signed copy, which is the
 * only copy whose provenance we know.
 */
function kurulumDosyasiDogrula(dosyaYolu, manifest) {
  if (!fs.existsSync(dosyaYolu)) throw new Error('Indirilen dosya bulunamadi: ' + dosyaYolu);
  const bulunan = dosyaSha512(dosyaYolu);
  if (bulunan !== manifest.sha512) {
    throw new Error('Indirilen kurulum dosyasi imzali ozetle uyusmuyor');
  }
  return true;
}

/**
 * What electron-updater says it is about to fetch, against what the signed
 * manifest says exists. If the host serves one thing to us and another to the
 * updater, the two disagree here and nothing is downloaded.
 */
function surumEslesiyorMu(manifest, updaterInfo) {
  if (!updaterInfo || !updaterInfo.version) return false;
  return String(updaterInfo.version).trim() === String(manifest.version).trim();
}

module.exports = {
  manifestOku,
  imzaDogrula,
  dosyaSha512,
  kurulumDosyasiDogrula,
  surumEslesiyorMu,
};
