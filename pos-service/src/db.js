'use strict';
/**
 * MariaDB access layer for the local database.
 * Everything in the service goes through here so that transactions,
 * tenant scoping and retries are handled in exactly one place.
 */
const mysql = require('mysql2/promise');
const config = require('./config');

let pool = null;
let clientId = null;

async function init() {
  const opts = {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: config.db.connectionLimit,
    charset: 'utf8mb4_general_ci',
    dateStrings: true,
    multipleStatements: false,
    timezone: 'local',
  };
  if (config.db.socketPath) opts.socketPath = config.db.socketPath;
  pool = mysql.createPool(opts);
  // wait for the bundled engine to accept connections (it may still be starting)
  let lastErr;
  for (let i = 0; i < 30; i++) {
    try { const c = await pool.getConnection(); c.release(); return pool; }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1000)); }
  }
  throw lastErr;
}

function ready() { return !!pool; }

/**
 * Throw the pool away and build a new one.
 *
 * Only restore needs this, and it needs it badly. Every connection in the pool
 * is bound to a default schema by NAME; a restore drops that schema and
 * creates a new one under the same name, and the connections that were idle
 * across the drop are then pointing at something that no longer exists in the
 * way they remember it. The symptom is not a clean error either - it is one
 * "Unknown database" per pooled connection, appearing at random for as long as
 * those connections live, on a till that has just been told the restore
 * worked.
 *
 * The old pool is given three seconds to close politely. It is not given the
 * right to hold up the restart: a connection still stuck on a query against
 * the dropped schema would otherwise wait forever, and the till would come
 * back up with no database at all rather than with a slightly untidy socket.
 */
async function reinit() {
  const old = pool;
  pool = null;
  clientId = null;
  if (old) {
    await Promise.race([
      old.end().catch(() => {}),
      new Promise(r => setTimeout(r, 3000)),
    ]);
  }
  return init();
}

async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}
async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}
async function value(sql, params = []) {
  const row = await one(sql, params);
  if (!row) return null;
  return row[Object.keys(row)[0]];
}
async function insert(sql, params = []) {
  const [res] = await pool.query(sql, params);
  return res.insertId;
}
async function exec(sql, params = []) {
  const [res] = await pool.query(sql, params);
  return res.affectedRows;
}

/** Run fn inside a transaction; rolls back on any throw. */
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const api = {
      query: async (s, p = []) => (await conn.query(s, p))[0],
      one: async (s, p = []) => { const r = (await conn.query(s, p))[0]; return r.length ? r[0] : null; },
      value: async (s, p = []) => { const r = (await conn.query(s, p))[0]; if (!r.length) return null; return r[0][Object.keys(r[0])[0]]; },
      insert: async (s, p = []) => (await conn.query(s, p))[0].insertId,
      exec: async (s, p = []) => (await conn.query(s, p))[0].affectedRows,
      conn,
    };
    const out = await fn(api);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    throw err;
  } finally {
    conn.release();
  }
}

/** Simple key/value settings helpers (np_settings). */
async function getSetting(key, def = null) {
  const v = await value('SELECT v FROM np_settings WHERE k=?', [key]);
  return v === null || v === undefined ? def : v;
}
async function setSetting(key, val) {
  await exec('INSERT INTO np_settings (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)',
    [key, val === null || val === undefined ? null : String(val)]);
}

/** The single tenant that owns this installation. */
async function getClientId() {
  if (clientId) return clientId;
  const v = await value('SELECT client_id FROM np_licence WHERE id=1');
  clientId = v || null;
  return clientId;
}
function setClientId(id) { clientId = id; }

module.exports = { init, reinit, ready, query, one, value, insert, exec, tx, getSetting, setSetting, getClientId, setClientId,
  get pool() { return pool; } };
