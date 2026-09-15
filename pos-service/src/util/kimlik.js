'use strict';
/**
 * Kimlik dosyası - the identity file.
 *
 * One small JSON file next to the data folder holding two things the till
 * needs to know when its own database cannot tell it anything: which licence
 * this installation belongs to, and the bcrypt hash of the owner's password.
 *
 * Both of those normally live in the database (`np_licence`, `np_login_cache`)
 * and that is still where they are read from first. The copy exists for one
 * situation, which is the entire reason restore exists: the database is empty,
 * half-loaded, or otherwise unable to answer. Without it, the ownership check
 * would have to refuse ("I cannot tell whose backup this is") and the password
 * check would have to refuse ("I cannot check your password") on precisely the
 * morning somebody is standing at a broken till with the backup in their hand.
 *
 * The hash is a bcrypt hash and it sits in the same folder as MariaDB's own
 * data files. Anybody who can read it can already read the table it was copied
 * from, so this moves no secret anywhere it was not already.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

function file() { return path.join(config.dataDir, 'kimlik.json'); }

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch (_) { return null; }
}

/** Merge and write. Never throws: a read-only data folder must not stop a restore. */
function write(patch) {
  const next = Object.assign({}, read() || {}, patch, { saved_at: new Date().toISOString() });
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next, null, 1));
  } catch (_) {}
  return next;
}

module.exports = { file, read, write };
