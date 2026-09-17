'use strict';
/*
 * THE PUBLIC HALF OF THE UPDATE SIGNING KEY.
 *
 * Whoever controls pos.noktapp.com can replace latest.yml and the installer
 * beside it. The sha512 inside latest.yml does not help: it lives in the same
 * folder as the file it describes, so an attacker writes both. That checksum
 * proves the download was not corrupted in transit. It proves nothing about
 * who produced it.
 *
 * So the manifest is signed, on the machine that builds the release, with a
 * private key that never touches the web server. This file carries the public
 * half. A till verifies latest.yml against it before downloading anything, and
 * verifies the downloaded installer against the hash inside that now-trusted
 * manifest before offering to install. A web server with no private key can
 * serve whatever it likes; no till will run it.
 *
 * TO SET THIS UP, ONCE:
 *   node desktop-shell/scripts/anahtar-uret.js
 * It writes the private key somewhere OUTSIDE this repository and prints the
 * public key to paste below. The private key is backed up offline and never
 * committed, never uploaded, never emailed.
 *
 * While PUBLIC_KEY is empty, automatic updates are DISABLED rather than
 * unverified. An update nobody checked is worse than no update.
 */
const PUBLIC_KEY = '';

module.exports = { PUBLIC_KEY };
