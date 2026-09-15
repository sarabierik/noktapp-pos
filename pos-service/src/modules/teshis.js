'use strict';
/**
 * KASA TEŞHİS — the till's own health, in one small document.
 *
 * When a restaurant rings, the owner should not have to ask them to describe
 * their own setup down the phone. The till already knows which version it
 * runs, which printer failed last, how much disk is left and when the day was
 * last closed; it just never said so. This module is the saying.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT RIDES, AND WHY IT HAS NO TIMER
 * ---------------------------------------------------------------------------
 * It goes out on the licence heartbeat (src/licence.js) and nowhere else. The
 * heartbeat has already proved the panel is reachable and is already paying
 * for a round trip; a second poller would double the traffic to a restaurant's
 * ADSL line to say something that is not urgent by nature. The gate below
 * keeps it to at most once an hour, so on the half-hourly heartbeat the
 * document rides every other beat.
 *
 * ---------------------------------------------------------------------------
 * IT MUST NEVER COST THE TILL ANYTHING
 * ---------------------------------------------------------------------------
 * A till that cannot reach the panel is a restaurant that must go on serving.
 * Three rules follow, and all three are enforced here rather than trusted to
 * the caller:
 *
 *   1. Nothing throws. Every field is read inside its own guard and a field
 *      that cannot be read is simply absent. A missing table on an older
 *      install costs one line of the document, not the licence check.
 *   2. Nothing waits. The whole build races a short timer (BUILD_MS); if the
 *      database is busy the heartbeat goes out with no document rather than
 *      late. A licence check that arrives late is a till that locks its staff
 *      out at the grace boundary.
 *   3. Nothing is remembered until it lands. The "sent" stamp is written by
 *      the caller AFTER the panel has answered, so an unreachable panel does
 *      not consume the hour's slot and the next heartbeat tries again.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT IN IT
 * ---------------------------------------------------------------------------
 * No guest, no customer, no staff member, no table, no bill, no order line, no
 * amount of money, no e-mail address, no telephone number. Not one of them is
 * needed to answer "why is this till not printing", and all of them would turn
 * a support document into a data export sitting on a server in another city.
 * KVKK is the reason it matters legally; the size of what we would then have
 * to protect is the reason it matters anyway.
 *
 * Everything here is therefore a COUNT, a VERSION, a DATE or a MACHINE FACT.
 * The one field that carries free text — the log lines — is written by
 * arbitrary code and so is scrubbed of anything shaped like an address, a
 * phone number, an IBAN or an identity number before it leaves the building,
 * and truncated. The panel scrubs it a second time (panel/lib/teshis.php),
 * because the panel must not depend on every till in the field being current.
 *
 * The document is capped at CAP_BYTES. Over that, the log lines go first and
 * then the printer list is trimmed: a document that grows without limit is a
 * bill somebody pays, on a line the restaurant is also trying to work on.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const log = require('../logger');

/** At most one document an hour, however often the heartbeat runs. */
const EVERY_MS = 60 * 60 * 1000;

/** The build gives up rather than delaying a licence check. */
const BUILD_MS = 3000;

/** Hard ceiling on the serialised document. */
const CAP_BYTES = 8192;

const MAX_LOG_LINES = 12;
const MAX_LOG_CHARS = 220;
const MAX_PRINTERS = 20;

const SETTING_SENT = 'diag_last_sent_at';

/* ------------------------------------------------------------------ *
 * Scrubbing
 * ------------------------------------------------------------------ */
/**
 * Remove anything shaped like it identifies a person.
 *
 * Patterns and not a word list: the things that could reach a log line are an
 * e-mail address quoted by a failed send, a courier's phone number echoed by
 * an integration, an IBAN in a payment error, a TCKN typed into the wrong box.
 * A marker is left behind rather than a hole so the line still reads as a
 * sentence to whoever is debugging it.
 */
function scrub(s) {
  return String(s)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[e-posta]')
    .replace(/\bTR\d{2} ?[0-9 ]{16,30}\b/g, '[iban]')
    /*
     * Ten or more digits in a row, allowing the spaces, dashes and brackets a
     * telephone number is written with. One rule catches a phone, a TCKN, a
     * card and an account number, and no count in this document is ten digits
     * long. The date at the front of every log line is ten digits and
     * identifies nobody, so it is let through by name - otherwise every line
     * arrives as "[numara]:22:17" and the support screen loses the only field
     * that says when.
     */
    .replace(/\b\d[\d \-()]{8,}\d\b/g, (m) =>
      (/^\d{4}-\d{2}-\d{2}/.test(m) || m.replace(/\D/g, '').length < 10) ? m : '[numara]');
}

/** Run one read; a failure costs that field and nothing else. */
async function tryOne(fn, fallback = null) {
  try { return await fn(); } catch (e) { return fallback; }
}

function mb(bytes) {
  if (bytes === null || bytes === undefined || !isFinite(bytes)) return null;
  return Math.round(Number(bytes) / 1048576);
}

/* ------------------------------------------------------------------ *
 * The pieces
 * ------------------------------------------------------------------ */

/**
 * Free space on the drive the data actually lives on.
 *
 * config.dataDir and not the system drive: on a restaurant PC the database and
 * the backups are frequently moved to a second disk, and reporting C: while D:
 * fills up is worse than reporting nothing.
 */
async function disk() {
  try {
    const st = await fs.promises.statfs(config.dataDir);
    return {
      free: mb(st.bavail * st.bsize),
      total: mb(st.blocks * st.bsize),
    };
  } catch (_) { return { free: null, total: null }; }
}

/** Size of the local database, as the engine itself reports it. */
async function dbSize() {
  const v = await db.value(
    `SELECT SUM(data_length + index_length) FROM information_schema.tables
      WHERE table_schema = DATABASE()`);
  return mb(v);
}

/**
 * Every printer, with what happened to the last thing sent to it.
 *
 * There is no last_result column on `printers` and this does not add one:
 * writing it would mean editing the print worker, and the print path is the
 * one thing on this machine that must not change to make a support screen
 * nicer. The answer is already in print_jobs — the newest job for that
 * printer's station — so it is read rather than recorded. The default printer
 * also owns the jobs that carry no station at all, which is what a receipt or
 * a drawer pulse looks like.
 */
async function printers(clientId) {
  const rows = await db.query(
    `SELECT p.id, p.name, p.type, p.ip_address, p.is_default, p.station_id, s.name AS station_name
       FROM printers p LEFT JOIN stations s ON s.id = p.station_id AND s.client_id = p.client_id
      WHERE p.client_id=? ORDER BY p.is_default DESC, p.id`, [clientId]);

  const out = [];
  for (const p of rows.slice(0, MAX_PRINTERS)) {
    let job = await tryOne(() => db.one(
      `SELECT status, sent_at, created_at FROM print_jobs
        WHERE client_id=? AND station_id=? ORDER BY id DESC LIMIT 1`, [clientId, p.station_id]));
    if (!job && p.is_default) {
      job = await tryOne(() => db.one(
        `SELECT status, sent_at, created_at FROM print_jobs
          WHERE client_id=? AND station_id IS NULL ORDER BY id DESC LIMIT 1`, [clientId]));
    }
    out.push({
      name: String(p.name || '').slice(0, 60),
      type: String(p.type || '').slice(0, 32),
      /* The LAN address of a device on the restaurant's own switch. Not a
         person, and the single most useful field when a printer is dead. */
      target: String(p.ip_address || '').slice(0, 60) || null,
      station: String(p.station_name || '').slice(0, 60) || null,
      last: job ? String(job.status) : 'yok',
      last_at: job ? (job.sent_at || job.created_at || null) : null,
    });
  }
  return out;
}

/** Is a fiscal device (ÖKC) set up on this till, and what does it say. */
async function okc(clientId) {
  const enabled = String(await tryOne(() => db.getSetting('fiscal_enabled', '0'), '0')) === '1';
  const rows = await tryOne(() => db.query(
    `SELECT provider, environment, status, is_active FROM fiscal_devices
      WHERE client_id=? ORDER BY is_active DESC, id`, [clientId]), []) || [];
  const live = rows.filter(r => r.is_active);
  return {
    /* "Configured" is both halves: a device row nobody switched on is not a
       working ÖKC, and a switch with no device behind it is not one either. */
    okc: enabled && live.length > 0 ? 1 : 0,
    okc_provider: live.length ? String(live[0].provider || '').slice(0, 32) : null,
    okc_status: live.length ? String(live[0].status || '').slice(0, 32) : null,
    okc_devices: live.length,
    /* The serial number is deliberately NOT sent. It identifies a registered
       fiscal device belonging to a taxpayer and answers no support question
       that the provider and the status do not already answer. */
  };
}

/** The newest backup file the till holds on its own disk. */
async function localBackup() {
  try {
    const dir = config.backupDir;
    const names = await fs.promises.readdir(dir);
    let best = null;
    for (const n of names) {
      if (!/\.(sql|zip|gz)$/i.test(n)) continue;
      const st = await fs.promises.stat(path.join(dir, n));
      if (!best || st.mtimeMs > best.mtimeMs) best = st;
    }
    if (!best) return { backup_at: null, backup_mb: null };
    return { backup_at: new Date(best.mtimeMs).toISOString(), backup_mb: mb(best.size) };
  } catch (_) { return { backup_at: null, backup_mb: null }; }
}

/**
 * The last error lines.
 *
 * Only the message and the area, never the `detail` column: detail is a JSON
 * blob written by whichever module logged the error and is exactly where a
 * guest's e-mail address or a bill's contents would be. The message is a
 * sentence somebody wrote on purpose, and it is scrubbed anyway.
 */
async function logLines() {
  const rows = await db.query(
    `SELECT created_at, area, message FROM np_app_log
      WHERE level='error' AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
      ORDER BY id DESC LIMIT ?`, [MAX_LOG_LINES]);
  return rows.map(r => scrub(
    `${String(r.created_at).slice(0, 19)} ${r.area} ${r.message}`).slice(0, MAX_LOG_CHARS));
}

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */

/**
 * Build the health document. Never throws; missing pieces are simply absent.
 */
async function build(clientId) {
  const cid = clientId || (await tryOne(() => db.getClientId()));
  const d = { at: new Date().toISOString() };

  d.app_version = process.env.NOKTAPP_VERSION || require('../../package.json').version || '2.0.0';
  d.node = process.versions.node;
  d.os = `${os.type()} ${os.release()} ${os.arch()}`.slice(0, 120);
  d.uptime_h = Math.round(os.uptime() / 3600);

  d.engine = await tryOne(() => db.value('SELECT VERSION()'));
  d.db_size_mb = await tryOne(dbSize);

  const dsk = await disk();
  d.disk_free_mb = dsk.free;
  d.disk_total_mb = dsk.total;

  d.stations = await tryOne(() => db.value(
    'SELECT COUNT(*) FROM stations WHERE client_id=?', [cid]));
  d.print_pending = await tryOne(() => db.value(
    "SELECT COUNT(*) FROM print_jobs WHERE client_id=? AND status='pending'", [cid]));
  d.print_failed = await tryOne(() => db.value(
    "SELECT COUNT(*) FROM print_jobs WHERE client_id=? AND status='failed'", [cid]));

  /* A COUNT of open bills, never the bills. How many tables are still open is
     a health signal (fifty of them means nobody is closing anything); what is
     on them is the restaurant's business and stays on the restaurant's PC. */
  d.open_bills = await tryOne(() => db.value(
    "SELECT COUNT(*) FROM orders WHERE client_id=? AND status='open' AND is_deleted=0", [cid]));

  const close = await tryOne(() => db.one(
    'SELECT `date`, close_seq FROM daily_closings WHERE client_id=? ORDER BY `date` DESC, close_seq DESC LIMIT 1',
    [cid]));
  d.last_close = close ? String(close.date).slice(0, 10) : null;
  d.last_close_seq = close ? Number(close.close_seq) : null;

  Object.assign(d, await okc(cid));
  Object.assign(d, await localBackup());

  d.errors_24h = await tryOne(() => db.value(
    "SELECT COUNT(*) FROM np_app_log WHERE level='error' AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)"));

  d.printers = await tryOne(() => printers(cid), []) || [];
  d.log = await tryOne(logLines, []) || [];

  return cap(d);
}

/**
 * Keep the document under CAP_BYTES.
 *
 * The order is not arbitrary: the log lines are the longest and the least
 * structured, so they go first; the printer list is the thing a support call
 * is usually about, so it is trimmed rather than dropped; the counts and the
 * versions are a few hundred bytes and always survive. A truncation is
 * ANNOUNCED in the document (`capped`) rather than done silently, because a
 * printer list that is short because it was cut looks exactly like a printer
 * list that is short because the shop has one printer.
 */
function cap(d) {
  const size = (x) => Buffer.byteLength(JSON.stringify(x), 'utf8');
  if (size(d) <= CAP_BYTES) return d;

  while (d.log.length && size(d) > CAP_BYTES) { d.log.pop(); d.capped = 'log'; }
  while (d.printers.length > 1 && size(d) > CAP_BYTES) { d.printers.pop(); d.capped = 'printers'; }
  if (size(d) > CAP_BYTES) {
    /* Nothing left to give but the structured lists. Whatever is still too big
       is a single oversized string somewhere, so the lists go entirely and the
       counts - which is what the panel indexes anyway - get through. */
    d.log = []; d.printers = []; d.capped = 'all';
  }
  return d;
}

/* ------------------------------------------------------------------ *
 * The hourly gate
 * ------------------------------------------------------------------ */

/** Has an hour passed since the last document the panel actually accepted? */
async function due(now = Date.now()) {
  const last = await tryOne(() => db.getSetting(SETTING_SENT, null), null);
  if (!last) return true;
  const t = Date.parse(last);
  if (!isFinite(t)) return true;
  /* A clock that has gone backwards (a PC that had no RTC battery and has just
     been corrected) must not silence the till for a year. */
  if (t > now) return true;
  return (now - t) >= EVERY_MS;
}

/** Remember that the panel took it. Called only after the panel has answered. */
async function markSent(now = Date.now()) {
  await tryOne(() => db.setSetting(SETTING_SENT, new Date(now).toISOString()));
}

/**
 * What the heartbeat should attach, or null.
 *
 * The one function src/licence.js calls. It returns null far more often than
 * it returns a document, and it returns null rather than throwing for every
 * reason there is: not due yet, no licence, no database, a build that took too
 * long. The heartbeat's job is the licence, and this must never be able to
 * change that job's outcome.
 */
async function forHeartbeat(clientId) {
  try {
    if (!db.ready()) return null;
    if (!(await due())) return null;
    /* Races a timer rather than waiting: see rule 2 in the header. */
    const doc = await Promise.race([
      build(clientId),
      new Promise(resolve => setTimeout(() => resolve(null), BUILD_MS)),
    ]);
    return doc || null;
  } catch (e) {
    log.debug('teshis', 'diagnostics skipped', e.message);
    return null;
  }
}

module.exports = {
  build, cap, due, markSent, forHeartbeat, scrub,
  EVERY_MS, CAP_BYTES, MAX_LOG_LINES, MAX_PRINTERS, SETTING_SENT,
};
