'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(config.logDir, { recursive: true });

function stamp() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function file() {
  return path.join(config.logDir, 'service-' + new Date().toISOString().slice(0, 10) + '.log');
}

function write(level, area, msg, detail) {
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${area.padEnd(10)} ${msg}` +
    (detail ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '');
  try { fs.appendFileSync(file(), line + '\n'); } catch (_) {}
  if (level === 'error') console.error(line); else console.log(line);
  // best-effort DB copy (never throws, DB may not be up yet)
  try {
    const db = require('./db');
    if (db.ready()) {
      db.query('INSERT INTO np_app_log (level, area, message, detail) VALUES (?,?,?,?)',
        [level, area, String(msg).slice(0, 500), detail ? JSON.stringify(detail).slice(0, 60000) : null])
        .catch(() => {});
    }
  } catch (_) {}
}

module.exports = {
  info: (area, m, d) => write('info', area, m, d),
  warn: (area, m, d) => write('warn', area, m, d),
  error: (area, m, d) => write('error', area, m, d),
  debug: (area, m, d) => { if (process.env.NOKTAPP_DEBUG) write('debug', area, m, d); },
};
