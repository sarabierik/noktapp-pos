'use strict';
/**
 * GÖÇLER — the migrations, replayed the way a real till replays them.
 *
 * WHY THIS EXISTS.
 *
 * Every other suite runs against a database built once, cleanly, from
 * 01…05 plus the migrations. A customer's machine is not that. It boots,
 * and the shell pipes EVERY migration file into the client again - on every
 * single start, for the life of the installation.
 *
 * Which means a statement that is not re-runnable does not fail once. It fails
 * for ever. And because the file goes in on one stdin, the client stops at that
 * statement and every statement BELOW it is skipped - on that boot and on every
 * boot after, because the next one dies at the same line. The migration is half
 * applied and nothing on the screen says so.
 *
 * That is not hypothetical. A till ran for seven days replaying
 * 2026-09-03-nullable-optional.sql, which died on line 29 (`DROP INDEX
 * uq_station_item`, already dropped), so line 30 - the unique key the kitchen
 * board's UPSERT depends on - had never run on that machine. The suites were
 * green the whole time, because a fresh database applies each migration exactly
 * once and never sees the second pass.
 *
 * So this suite is the second pass. It builds the schema, applies every
 * migration, and then applies every migration AGAIN, statement by statement,
 * and fails on any error that is not a genuine no-op. The rule it enforces is
 * simply: a migration must be safe to run twice.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/gocler.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const DB = process.env.DB_NAME || 'noktapp_pos';
const PORT = process.env.DB_PORT || '3399';
const USER = process.env.DB_USER || 'noktapp';
const PASS = process.env.DB_PASS || 'nokpass';
const MIG = path.join(__dirname, '..', '..', 'database', 'migrations');

const results = [];
function step(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

/*
 * The whole FILE, through the real client, with --force - which is exactly what
 * desktop-shell/src/main.js does on a customer's machine. Not statement by
 * statement: a splitter would have to understand quoting well enough to know
 * that the ';' inside COMMENT 'NULL = use the zone; ...' is not a statement
 * boundary, and a suite that has to trust its own SQL parser is testing the
 * parser. The client already knows. Its stderr is the answer.
 */
function applyFile(file) {
  const args = [`--port=${PORT}`, '--protocol=tcp', `-u${USER}`, `-p${PASS}`,
                '--default-character-set=utf8mb4', '--force', DB];
  const out = spawnSync('mysql', args, { input: fs.readFileSync(file), encoding: 'utf8' });
  return String(out.stderr || '')
    .split('\n')
    .filter(l => /^ERROR \d+/.test(l.trim()))
    .map(l => l.trim());
}

function query(statement) {
  return execFileSync('mysql',
    [`--port=${PORT}`, '--protocol=tcp', `-u${USER}`, `-p${PASS}`, DB, '-N', '-B', '-e', statement],
    { encoding: 'utf8' });
}

/*
 * The database saying "already done" is what a correct re-run looks like. Any
 * other error is a statement that cannot be replayed - and before --force, one
 * of those took every statement below it down too.
 */
const BENIGN = /Duplicate column name|Duplicate key name|already exists|Duplicate entry|check that column\/key exists/i;

(async () => {
  console.log('\nNOKTApp POS - göçler (every migration survives a second boot)\n');

  const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
  assert.ok(files.length, 'no migrations found at ' + MIG);
  console.log(`  ${files.length} migration file(s), each replayed onto the schema they already built\n`);

  /* First pass, to put the database in the state a running till is in. */
  for (const f of files) applyFile(path.join(MIG, f));

  /* Second pass: this is the boot a customer's machine does every morning. */
  for (const f of files) {
    step(f + ' survives a second boot', () => {
      const errs = applyFile(path.join(MIG, f)).filter(e => !BENIGN.test(e));
      assert.deepStrictEqual(errs, [],
        'not re-runnable:\n        ' + errs.join('\n        '));
    });
  }

  /* The specific damage the seven-day failure did, asserted by name so that a
     future edit cannot quietly drop the index the kitchen board depends on. */
  step('the kitchen board still has the key its UPSERT fires on', () => {
    const idx = query("SHOW INDEX FROM station_projection_items WHERE Key_name='uq_client_item'");
    assert.ok(idx.trim(), 'uq_client_item is missing - every re-send will duplicate the ticket');
  });

  step('the index it replaced is really gone', () => {
    const idx = query("SHOW INDEX FROM station_projection_items WHERE Key_name='uq_station_item'");
    assert.strictEqual(idx.trim(), '', 'uq_station_item survived; the migration did not run');
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  process.exit(failed.length ? 1 : 0);
})();
