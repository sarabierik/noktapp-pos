#!/usr/bin/env node
'use strict';
/*
 * RUN THIS ONCE, ON THE MACHINE THAT BUILDS RELEASES.
 *
 *   node desktop-shell/scripts/anahtar-uret.js
 *
 * It writes the private key OUTSIDE this repository and prints the public half
 * to paste into src/guncelleme-anahtar.js.
 *
 * The private key is the only thing standing between your web host and every
 * till you have sold. Back it up offline. Do not commit it, do not upload it,
 * do not email it to yourself. If it is lost you can generate a new pair and
 * ship it in the next build - tills on the old key simply stop auto-updating
 * until they are updated by hand, which is annoying but survivable. If it is
 * STOLEN, an attacker can sign releases as you, and that is not survivable
 * quietly: generate a new pair, ship it, and tell your customers.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hedef = process.argv[2] || path.join(os.homedir(), '.noktapp', 'guncelleme-ozel-anahtar.pem');

if (fs.existsSync(hedef)) {
  console.error('\nA key already exists at:\n  ' + hedef +
    '\n\nRefusing to overwrite it. Every till running a build made with the\n' +
    'matching public key would stop accepting updates. Move the old key aside\n' +
    'deliberately if you really mean to replace it.\n');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const ozel = privateKey.export({ type: 'pkcs8', format: 'pem' });
const acik = publicKey.export({ type: 'spki', format: 'pem' });

fs.mkdirSync(path.dirname(hedef), { recursive: true });
fs.writeFileSync(hedef, ozel, { mode: 0o600 });
try { fs.chmodSync(hedef, 0o600); } catch { /* Windows */ }

console.log('\nPrivate key written to:\n  ' + hedef);
console.log('\n  → Back this file up offline. It is not in the repository and it must never be.\n');
console.log('Now paste this into desktop-shell/src/guncelleme-anahtar.js:\n');
console.log("const PUBLIC_KEY = `" + acik.trim() + "`;\n");
