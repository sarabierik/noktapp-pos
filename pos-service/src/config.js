'use strict';
/**
 * Runtime configuration.
 * Values come from (in order): environment, config.json next to the app data
 * folder, then the built-in defaults. The installer writes config.json.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR =
  process.env.NOKTAPP_DATA_DIR ||
  path.join(process.env.PROGRAMDATA || os.homedir(), 'NoktAppPOS');

function readFileConfig() {
  try {
    const p = path.join(DATA_DIR, 'config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { /* ignore, fall back to defaults */ }
  return {};
}

const file = readFileConfig();

const config = {
  dataDir: DATA_DIR,
  logDir: path.join(DATA_DIR, 'logs'),
  backupDir: path.join(DATA_DIR, 'backups'),
  mediaDir: path.join(DATA_DIR, 'media'),
  tmpDir: path.join(DATA_DIR, 'tmp'),

  port: Number(process.env.NOKTAPP_PORT || file.port || 7451),
  bindHost: process.env.NOKTAPP_HOST || file.bindHost || '0.0.0.0',

  db: {
    host: process.env.DB_HOST || file.dbHost || '127.0.0.1',
    port: Number(process.env.DB_PORT || file.dbPort || 3399),
    user: process.env.DB_USER || file.dbUser || 'noktapp',
    password: process.env.DB_PASS || file.dbPass || '',
    database: process.env.DB_NAME || file.dbName || 'noktapp_pos',
    connectionLimit: 12,
    socketPath: process.env.DB_SOCKET || file.dbSocket || undefined,
  },

  panelUrl: process.env.PANEL_URL || file.panelUrl || 'https://pos.noktapp.com',
  jwtSecret: file.jwtSecret || process.env.JWT_SECRET || null, // generated on first run
  deviceId: file.deviceId || null,                            // generated on first run

  // how long the till keeps working with no answer from the licence server
  licenceGraceDays: Number(file.licenceGraceDays || 7),

  isPackaged: !!process.env.NOKTAPP_PACKAGED,
};

module.exports = config;
