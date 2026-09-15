'use strict';
/**
 * KASA TEŞHİS — the health document the till puts on its heartbeat.
 *
 * Four things have to be true of it and each one is a way it could quietly
 * hurt somebody:
 *
 *   1. It says something useful. A document that is all nulls is a support
 *      screen that answers no question, so this suite builds a till with
 *      printers, stations, a failed print job, an open bill, a day-end, an
 *      ÖKC and errors in the log, and insists every one of them comes out.
 *
 *   2. It carries NOTHING about a person. The database here is deliberately
 *      full of guests, their e-mail addresses, their telephone numbers and
 *      their bills, and log lines that quote them - which is exactly what a
 *      real restaurant's database looks like. Not one of those strings may
 *      appear in the document. This is the check that matters: KVKK does not
 *      care that we only meant to look at it during a support call.
 *
 *   3. It is capped. A log line can be any length and a shop can own fifty
 *      printers. The document is bounded whatever the database contains.
 *
 *   4. It costs the till nothing. It goes out at most once an hour, and a
 *      panel that cannot be reached leaves the till exactly as it was - no
 *      throw, no slot consumed, no state written.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/teshis.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7473';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { bootstrap } = require('../src/index');

const CID = 19;

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

/**
 * The migration is applied here rather than assumed - the desktop shell re-runs
 * every file in database/migrations on each start and a test run has no shell.
 * The file is written to be idempotent, so this is exactly what the shell does.
 */
async function migrate() {
  const file = path.join(__dirname, '..', '..', 'database', 'migrations', '2026-09-08-teshis.sql');
  const sql = fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await db.exec(stmt); } catch (_) { /* already applied */ }
  }
}

/*
 * The personal data this suite plants and then hunts for.
 *
 * Real shapes, not placeholders: a Turkish name with its diacritics, an
 * address, a mobile number written the way a waiter types it, and an identity
 * number. If any of these survives into the document, the document is a data
 * export and this suite has done its job.
 */
const GUESTS = [
  { first: 'Ayşegül', last: 'Karadeniz', email: 'aysegul.karadeniz@ornek.com', phone: '05321234567' },
  { first: 'Mehmet',  last: 'Yılmazoğlu', email: 'mehmet@yilmazoglu.com.tr',  phone: '0533 987 65 43' },
  { first: 'Elif',    last: 'Şahin',      email: 'elif.sahin@gmail.com',       phone: '(0542) 111 22 33' },
];
const TCKN = '12345678901';
const IBAN = 'TR33 0006 1005 1978 6457 8413 26';

/* The suites share one database and this one runs last, so the till already has
   whatever the earlier ones left open. The bill counts below are therefore
   measured against a baseline rather than against zero. */
let openBefore = 0;

async function fixture() {
  /* The panel is pointed at a closed port for the whole run. Every heartbeat
     below is meant to fail; against the real URL each one would sit on a
     25 second timeout. */
  await db.setSetting('panel_url', 'http://127.0.0.1:9');
  await db.exec('DELETE FROM np_settings WHERE k=?', ['diag_last_sent_at']);

  await db.exec("DELETE FROM np_app_log WHERE area IN ('teshistest','teshismail')");
  await db.exec('DELETE FROM print_jobs WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM printers WHERE client_id=?', [CID]);

  /* Guests, with everything a guest has. Upserted rather than inserted so the
     suite can be run twice over the same database without tripping the
     registry's unique phone number. */
  for (const g of GUESTS) {
    await db.exec(
      `INSERT INTO customers (first_name, last_name, phone, email, is_active, created_by_client_id)
       VALUES (?,?,?,?,1,?)
       ON DUPLICATE KEY UPDATE first_name=VALUES(first_name), last_name=VALUES(last_name),
          email=VALUES(email), created_by_client_id=VALUES(created_by_client_id)`,
      [g.first, g.last, g.phone, g.email, CID]);
  }

  openBefore = Number(await db.value(
    "SELECT COUNT(*) FROM orders WHERE client_id=? AND status='open' AND is_deleted=0", [CID]));

  /* An open bill with a guest attached and a note that names them. */
  const cust = await db.value('SELECT id FROM customers WHERE created_by_client_id=? ORDER BY id DESC LIMIT 1', [CID]);
  await db.exec(
    `INSERT INTO orders (client_id, business_date, table_id, waiter_id, customer_id, status,
        total, grand_total, notes, is_deleted)
     VALUES (?, CURDATE(), 1, 0, ?, 'open', 480.00, 480.00, ?, 0)`,
    [CID, cust, GUESTS[0].first + ' ' + GUESTS[0].last + ' · ' + GUESTS[0].phone]);

  /* A station, two printers, and a print job on each - one that failed. */
  let stationId = await db.value("SELECT id FROM stations WHERE client_id=? ORDER BY id LIMIT 1", [CID]);
  if (!stationId) {
    stationId = await db.insert("INSERT INTO stations (client_id, name, is_default) VALUES (?,'Mutfak',1)", [CID]);
  }
  await db.exec(
    `INSERT INTO printers (client_id, station_id, name, type, ip_address, is_default)
     VALUES (?,?,'Kasa Yazıcı','thermal','192.168.1.50',1), (?,?,'Mutfak Yazıcı','thermal','192.168.1.51',0)`,
    [CID, stationId, CID, stationId]);
  await db.exec(
    `INSERT INTO print_jobs (client_id, job_type, order_id, station_id, content, status, created_at)
     VALUES (?, 'receipt', 0, ?, 'x', 'failed', NOW()), (?, 'order', 0, NULL, 'x', 'pending', NOW())`,
    [CID, stationId, CID]);

  /* A day-end. */
  await db.exec('DELETE FROM daily_closings WHERE client_id=?', [CID]);
  await db.exec(
    `INSERT INTO daily_closings (client_id, \`date\`, close_seq, closed_at) VALUES (?, CURDATE(), 1, NOW())`, [CID]);

  /* An ÖKC that is configured and switched on. */
  await db.exec('DELETE FROM fiscal_devices WHERE client_id=?', [CID]);
  await db.exec(
    `INSERT INTO fiscal_devices (client_id, provider, device_model, serial_number, environment, status, is_active)
     VALUES (?, 'hugin', 'H-100', 'SERI-TESHIS-9931', 'SIMULATOR', 'READY', 1)`, [CID]);
  await db.setSetting('fiscal_enabled', '1');

  /* Errors in the log, quoting a guest the way a real failure does. */
  await db.exec(
    `INSERT INTO np_app_log (level, area, message, detail) VALUES
      ('error','teshismail',?,?),
      ('error','teshistest',?,?),
      ('error','teshistest',?,NULL)`,
    ['Adisyon e-postasi gonderilemedi: ' + GUESTS[1].email, JSON.stringify({ to: GUESTS[1].email }),
     'Sadakat sorgusu basarisiz: tel ' + GUESTS[2].phone + ' tckn ' + TCKN, JSON.stringify({ iban: IBAN }),
     'Yazici cevap vermiyor: 192.168.1.51:9100']);

  /* A licence row, so heartbeat() has something to work with. */
  await db.exec(
    `INSERT INTO np_licence (id, client_id, company_name, licence_key, plan_name, status, seats,
        features, expires_at, grace_days, last_check_at, last_ok_at)
     VALUES (1,?,?,'TESHIS-KEY','standart','active',3,'{}', DATE_ADD(NOW(), INTERVAL 300 DAY), 7, NOW(), NOW())
     ON DUPLICATE KEY UPDATE client_id=VALUES(client_id), licence_key=VALUES(licence_key),
        status='active', last_ok_at=NOW()`,
    [CID, 'Teşhis Test Restoran']);
}

/** Every string in the document, flattened, so one search covers all of it. */
function flat(doc) { return JSON.stringify(doc); }

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  await migrate();
  await fixture();

  const teshis = require('../src/modules/teshis');
  const licence = require('../src/licence');

  console.log('\nNOKTApp POS - kasa teşhis belgesi\n');

  let doc = null;

  /* ====================== 1. THE DOCUMENT IS BUILT ====================== */

  await step('the document is built and carries the machine facts', async () => {
    doc = await teshis.build(CID);
    assert.ok(doc, 'no document at all');
    assert.ok(doc.app_version, 'no app version');
    assert.ok(doc.engine && /\d/.test(doc.engine), 'no database engine version: ' + doc.engine);
    assert.ok(doc.os && doc.os.length > 3, 'no operating system');
    assert.ok(typeof doc.disk_free_mb === 'number' && doc.disk_free_mb > 0,
      'free disk not reported: ' + doc.disk_free_mb);
    assert.ok(typeof doc.db_size_mb === 'number', 'database size not reported');
    assert.ok(doc.at && !isNaN(Date.parse(doc.at)), 'no timestamp');
  });

  await step('it carries the printers with their type and last result', async () => {
    assert.strictEqual(doc.printers.length, 2, 'expected two printers, got ' + doc.printers.length);
    const kasa = doc.printers.find(p => p.name === 'Kasa Yazıcı');
    assert.ok(kasa, 'the default printer is missing');
    assert.strictEqual(kasa.type, 'thermal', 'printer type missing');
    assert.strictEqual(kasa.target, '192.168.1.50', 'printer address missing');
    assert.ok(doc.printers.some(p => p.last === 'failed'),
      'a printer whose last job failed is reported as healthy: ' + JSON.stringify(doc.printers));
  });

  await step('it carries the counts a support call actually asks for', async () => {
    assert.ok(doc.stations >= 1, 'station count missing');
    assert.strictEqual(Number(doc.print_pending), 1, 'pending print jobs wrong: ' + doc.print_pending);
    assert.strictEqual(Number(doc.open_bills), openBefore + 1,
      'open bill count wrong: ' + doc.open_bills + ' (beklenen ' + (openBefore + 1) + ')');
    assert.strictEqual(doc.last_close, new Date().toISOString().slice(0, 10),
      'last day close wrong: ' + doc.last_close);
    assert.strictEqual(doc.okc, 1, 'a configured ÖKC is reported as absent');
    assert.strictEqual(doc.okc_provider, 'hugin', 'ÖKC provider missing');
    assert.ok(Number(doc.errors_24h) >= 3, '24h error count wrong: ' + doc.errors_24h);
    assert.ok(doc.log.length >= 3, 'no log lines: ' + JSON.stringify(doc.log));
  });

  /* ==================== 2. NOTHING IDENTIFYING GETS OUT ================= */

  await step('no guest name, e-mail or telephone number is in the document', async () => {
    const s = flat(doc);
    for (const g of GUESTS) {
      assert.ok(!s.includes(g.email), 'a guest e-mail address is in the document: ' + g.email);
      assert.ok(!s.includes(g.phone), 'a guest telephone number is in the document: ' + g.phone);
      assert.ok(!s.includes(g.phone.replace(/\D/g, '')), 'a guest telephone number leaked in digits');
      assert.ok(!s.includes(g.last), 'a guest surname is in the document: ' + g.last);
    }
    assert.ok(!s.includes(TCKN), 'a national identity number is in the document');
    assert.ok(!s.includes(IBAN.replace(/ /g, '')) && !s.includes(IBAN),
      'an IBAN is in the document');
  });

  await step('no bill contents, no amounts and no table are in the document', async () => {
    const s = flat(doc);
    assert.ok(!s.includes('480.00') && !s.includes('480,00'), 'a bill total is in the document');
    assert.ok(!/"(notes|bill_label|items|orders|customers)"/.test(s),
      'a bill-shaped field is in the document: ' + s.slice(0, 300));
    /* Open bills must be a COUNT and only a count. */
    assert.strictEqual(typeof doc.open_bills, 'number', 'open_bills is not a plain count');
  });

  await step('the ÖKC serial number stays on the till', async () => {
    assert.ok(!flat(doc).includes('SERI-TESHIS-9931'),
      'the fiscal device serial number was sent to the panel');
  });

  await step('the scrubber survives a log line that is nothing but personal data', async () => {
    const line = teshis.scrub(`giris ${GUESTS[0].email} tel ${GUESTS[0].phone} tckn ${TCKN} iban ${IBAN}`);
    assert.ok(!line.includes(GUESTS[0].email), 'e-mail survived the scrubber');
    assert.ok(!line.includes(TCKN), 'identity number survived the scrubber');
    assert.ok(!line.includes('0532'), 'telephone number survived the scrubber');
    assert.ok(line.includes('[e-posta]') && line.includes('[numara]'),
      'the scrubber deleted the line instead of marking it: ' + line);

    /* And it leaves alone the two things in a log line that are digits and are
       not a person: the timestamp and an IP address. Without this the whole
       document reads "[numara]:22:17 print [numara]" and answers nothing. */
    const kept = teshis.scrub('2026-09-08 17:22:17 print Yazici cevap vermiyor: 192.168.1.51:9100');
    assert.ok(kept.startsWith('2026-09-08 17:22:17'), 'the timestamp was scrubbed: ' + kept);
    assert.ok(kept.includes('192.168.1.51:9100'), 'the printer address was scrubbed: ' + kept);
  });

  await step('the log detail column - where the personal data really lives - is never read', async () => {
    /* The message is written on purpose by a developer; `detail` is a JSON blob
       written by whichever module failed, and that is where a guest ends up. */
    const s = flat(doc);
    assert.ok(!s.includes('"to"') && !s.includes('"iban"'),
      'the log detail column reached the document: ' + s.slice(0, 300));
  });

  /* ============================ 3. IT IS CAPPED ========================= */

  await step('a database full of noise still produces a small document', async () => {
    const huge = 'X'.repeat(4000) + ' ' + GUESTS[0].email;
    for (let i = 0; i < 40; i++) {
      await db.exec("INSERT INTO np_app_log (level, area, message) VALUES ('error','teshistest',?)",
        [huge.slice(0, 500)]);
    }
    for (let i = 0; i < 40; i++) {
      await db.exec(
        `INSERT INTO printers (client_id, station_id, name, type, ip_address, is_default)
         VALUES (?, ?, ?, 'thermal', '10.0.0.', 0)`,
        [CID, await db.value('SELECT id FROM stations WHERE client_id=? LIMIT 1', [CID]),
         ('Yazıcı ' + i + ' ' + 'A'.repeat(200)).slice(0, 90)]);
    }
    const big = await teshis.build(CID);
    const bytes = Buffer.byteLength(JSON.stringify(big), 'utf8');
    assert.ok(bytes <= teshis.CAP_BYTES,
      'the document is ' + bytes + ' bytes, over the ' + teshis.CAP_BYTES + ' cap');
    assert.ok(big.printers.length <= teshis.MAX_PRINTERS,
      'printer list not bounded: ' + big.printers.length);
    assert.ok(big.log.length <= teshis.MAX_LOG_LINES, 'log lines not bounded: ' + big.log.length);
    assert.ok(!JSON.stringify(big).includes(GUESTS[0].email),
      'the oversized log lines carried an e-mail address through the cap');
    /* Even when everything else was dropped, the counts survive - they are what
       the panel indexes and what the list screen reads. */
    assert.ok(typeof big.open_bills === 'number' && big.app_version,
      'the cap threw away the fields the panel actually needs');
  });

  /* ========================= 4. AT MOST ONCE AN HOUR ==================== */

  await step('a till that has never sent one sends immediately', async () => {
    await db.exec('DELETE FROM np_settings WHERE k=?', [teshis.SETTING_SENT]);
    assert.strictEqual(await teshis.due(), true, 'a till with no history refused to send');
    assert.ok(await teshis.forHeartbeat(CID), 'nothing was offered to the heartbeat');
  });

  await step('a second heartbeat within the hour attaches nothing', async () => {
    await teshis.markSent();
    assert.strictEqual(await teshis.due(), false, 'the hourly gate did not close');
    assert.strictEqual(await teshis.forHeartbeat(CID), null,
      'a document was offered twice inside the hour');
  });

  await step('an hour later it sends again', async () => {
    await db.setSetting(teshis.SETTING_SENT, new Date(Date.now() - 61 * 60000).toISOString());
    assert.strictEqual(await teshis.due(), true, 'the gate did not reopen after an hour');
    assert.ok(await teshis.forHeartbeat(CID), 'nothing was offered after the hour passed');
  });

  await step('a clock that has jumped backwards does not silence the till', async () => {
    /* A PC with a dead RTC battery comes back with a date in the future, then
       gets corrected. Without this, the till would say nothing until that
       future date arrived. */
    await db.setSetting(teshis.SETTING_SENT, new Date(Date.now() + 400 * 86400000).toISOString());
    assert.strictEqual(await teshis.due(), true, 'a future timestamp silenced the till');
  });

  /* ===================== 5. A DEAD PANEL CHANGES NOTHING ================ */

  await step('a heartbeat to a dead panel does not throw', async () => {
    await db.exec('DELETE FROM np_settings WHERE k=?', [teshis.SETTING_SENT]);
    const before = await db.one('SELECT * FROM np_licence WHERE id=1');
    const r = await licence.heartbeat();
    assert.strictEqual(r.ok, false, 'the panel answered from a closed port');
    const after = await db.one('SELECT * FROM np_licence WHERE id=1');
    assert.strictEqual(after.status, before.status, 'a dead panel changed the licence status');
    assert.strictEqual(after.licence_key, before.licence_key, 'a dead panel changed the licence key');
    assert.ok(after.last_ok_at === before.last_ok_at,
      'a dead panel extended the offline grace window');
  });

  await step('an unreachable panel does not consume the hour', async () => {
    const stamp = await db.getSetting(teshis.SETTING_SENT, null);
    assert.strictEqual(stamp, null,
      'the till marked the document as delivered to a panel that never answered');
    assert.strictEqual(await teshis.due(), true, 'the next heartbeat would have stayed silent');
  });

  await step('the till goes on working with the panel dead', async () => {
    /* The whole point: diagnostics are best effort. Orders, printing and the
       local database must be exactly where they were. */
    const bills = await db.value("SELECT COUNT(*) FROM orders WHERE client_id=? AND status='open' AND is_deleted=0", [CID]);
    assert.strictEqual(Number(bills), openBefore + 1, 'the open bill was disturbed by a failed heartbeat');
    const jobs = await db.value("SELECT COUNT(*) FROM print_jobs WHERE client_id=?", [CID]);
    assert.ok(Number(jobs) >= 2, 'the print queue was disturbed by a failed heartbeat');
    const again = await teshis.build(CID);
    assert.ok(again && again.app_version, 'the document cannot be built after a failed heartbeat');
  });

  await step('a broken database costs the document, not the heartbeat', async () => {
    /* Every field is read inside its own guard. Proved by asking for a client
       that owns nothing at all: the document still comes back, with zeroes. */
    const empty = await teshis.build(999999);
    assert.ok(empty && empty.app_version, 'a client with no data produced no document');
    assert.strictEqual(empty.printers.length, 0, 'printers appeared for a client with none');
    assert.strictEqual(empty.last_close, null, 'a day close appeared for a client with none');
    assert.strictEqual(empty.okc, 0, 'an ÖKC appeared for a client with none');
  });

  /* ================================ sonuç ============================== */
  await db.setSetting('panel_url', process.env.PANEL || 'http://127.0.0.1:8090');
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
