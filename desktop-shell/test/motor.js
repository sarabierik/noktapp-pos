/*
 * WHERE THE DATABASE ENGINE IS - checked as source, because it cannot be
 * checked any other way here.
 *
 * main.js only runs inside Electron on Windows, so none of the till suites
 * ever touched it, and that is exactly how a hardcoded MYSQL_DIR reached a
 * restaurant's counter and left the till showing
 *
 *     spawn ...\resources\mariadb\bin\mariadbd.exe ENOENT
 *
 * with every byte of its data safe in mysql-data and nothing to open it with.
 * The engine had been on that machine the whole time, in ProgramData, in the
 * folder vendor/mariadb/BENIOKU.txt had promised for months - and nothing in
 * the shell had ever been taught to look there.
 *
 * These checks are structural rather than behavioural, which is a weaker
 * thing, and they are here because a weaker check that runs on every build
 * beats a stronger one that needs a Windows box nobody has.
 *
 * Run:  node desktop-shell/test/motor.js
 */
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

for (const needle of [
  "const BUNDLED_MYSQL = path.join(ROOT, 'mariadb');",
  "const DATA_MYSQL = path.join(DATA_DIR, 'mariadb');",
  "if (hasEngine(BUNDLED_MYSQL)) { MYSQL_DIR = BUNDLED_MYSQL; return false; }",
  "if (hasEngine(DATA_MYSQL)) { MYSQL_DIR = DATA_MYSQL; return false; }",
  "MYSQL_DIR = DATA_MYSQL;",
  "await ensureEngine(say);",
]) assert.ok(src.includes(needle), 'missing: ' + needle);

/* ensureEngine must run BEFORE anything that needs the database */
const iEnsure = src.indexOf('await ensureEngine(say);');
for (const after of ['await initDatabase(cfg)', 'await startDatabase(cfg)', 'await startService(cfg)']) {
  assert.ok(src.indexOf(after) > iEnsure, after + ' runs before the engine is resolved');
}

/* the env vars the service reads must be built from the RESOLVED dir */
assert.ok(src.includes("NOKTAPP_DUMP_BIN: path.join(MYSQL_DIR, 'bin', 'mariadb-dump.exe')"));
assert.ok(src.includes("NOKTAPP_CLIENT_BIN: path.join(MYSQL_DIR, 'bin', 'mariadb.exe')"));
/* (startService is DEFINED above the boot block; what matters is that it is
   CALLED after ensureEngine, which is asserted above.) */

/* MYSQL_DIR must be reassignable, or the resolution cannot take effect */
assert.ok(/let MYSQL_DIR = BUNDLED_MYSQL;/.test(src), 'MYSQL_DIR is not reassignable');
assert.ok(!/const MYSQL_DIR/.test(src), 'MYSQL_DIR is still a const somewhere');

/* the download lands in ProgramData, never in Program Files - that is the
   whole point: an update must not be able to remove it again */
const ens = src.slice(src.indexOf('async function ensureEngine'), src.indexOf('function runTool'));
assert.ok(ens.includes('DATA_MYSQL'), 'the download does not target ProgramData');
assert.ok(!ens.includes('BUNDLED_MYSQL = '), 'the download writes into the program folder');

/* a failure must not be reported as "your program is broken" */
assert.ok(src.includes('Verileriniz yerinde duruyor'), 'no reassuring message on engine failure');

console.log('engine resolution: 9/9 checks passed');
