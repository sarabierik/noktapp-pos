#!/usr/bin/env node
'use strict';
/*
 * SIGN A RELEASE MANIFEST. Run after electron-builder, before uploading.
 *
 *   node desktop-shell/scripts/imzala.js dist/latest.yml
 *
 * Writes dist/latest.yml.imza beside it. Upload all three files together:
 *
 *   latest.yml        what version exists, and the installer's sha512
 *   latest.yml.imza   proof that YOU wrote that latest.yml
 *   NoktApp-POS-Setup-x.y.z.exe
 *
 * Upload the .imza with the .yml, every time. A till that finds a manifest
 * without a signature refuses it - which is correct, and which will look like
 * "updates are broken" if you forget this step.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ymlYolu = process.argv[2];
const anahtarYolu = process.argv[3] ||
  process.env.NOKTAPP_IMZA_ANAHTARI ||
  path.join(os.homedir(), '.noktapp', 'guncelleme-ozel-anahtar.pem');

if (!ymlYolu) {
  console.error('Usage: node desktop-shell/scripts/imzala.js <path-to-latest.yml> [private-key.pem]');
  process.exit(1);
}
if (!fs.existsSync(ymlYolu)) {
  console.error('No such file: ' + ymlYolu);
  process.exit(1);
}
if (!fs.existsSync(anahtarYolu)) {
  console.error('\nNo signing key at:\n  ' + anahtarYolu +
    '\n\nGenerate one first:  node desktop-shell/scripts/anahtar-uret.js\n');
  process.exit(1);
}

const bytes = fs.readFileSync(ymlYolu);
const key = crypto.createPrivateKey(fs.readFileSync(anahtarYolu));
const imza = crypto.sign(null, bytes, key).toString('base64');

const hedef = ymlYolu + '.imza';
fs.writeFileSync(hedef, imza + '\n');

/* Read it straight back, with the public half derived from the private key.
 * Signing and then shipping something that does not verify is the one failure
 * this script must never produce silently. */
const acik = crypto.createPublicKey(key);
if (!crypto.verify(null, bytes, acik, Buffer.from(imza, 'base64'))) {
  console.error('Signature did not verify after writing. Not shipping this.');
  process.exit(1);
}

console.log('Signed: ' + path.basename(ymlYolu));
console.log('Wrote:  ' + hedef);
console.log('\nUpload latest.yml, latest.yml.imza and the .exe together.');
