'use strict';
/**
 * NOKTApp POS - local service.
 *
 * Everything the restaurant does runs here, on their own computer:
 * the database, the till API, the printers, the ÖKC, the phone API.
 * Our server is only asked two things - "is this licence still valid" and
 * "please keep this backup" - so a dead internet line never stops service.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');

const config = require('./config');
const log = require('./logger');
const db = require('./db');
const printing = require('./print');
const mail = require('./mail');
const sync = require('./sync');
const backup = require('./backup');
const restore = require('./restore');
const lan = require('./lan');
const relay = require('./relay');
const integrations = require('./integrations');

const app = express();
app.disable('x-powered-by');

/*
 * The client's real address, for the login limiter.
 *
 * The till talks to 127.0.0.1 and the phones come straight off the LAN, so
 * there is normally no proxy in front of this - but a restaurant that puts one
 * there would otherwise make every request look like it came from the proxy,
 * and one waiter's fat fingers would lock out the building. `loopback` trusts
 * only a local hop, which is the only one that can legitimately exist here.
 */
app.set('trust proxy', 'loopback');

/*
 * Security headers, written out rather than pulled from helmet: this service
 * has eleven dependencies and the whole of what helmet would give a LAN till
 * is these five lines. The CSP is deliberately strict - the front end has no
 * bundler, no CDN and no inline event handlers, so nothing legitimate needs
 * 'unsafe-inline' for scripts. Styles keep it because the screens set colours
 * inline on elements.
 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; " +
    "form-action 'self'; object-src 'none'");
  next();
});

/*
 * CORS used to reflect any origin. Nothing needs that: the till UI is served
 * by this same service, the phone app is not a browser and sends no Origin,
 * and the customer display is a local page. So allow same-origin and
 * origin-less callers, and refuse the rest rather than echoing whatever asked.
 */
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                    // the phone app, curl, the shell
    try {
      const h = new URL(origin).hostname;
      const local = h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
        /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
      return cb(null, local);
    } catch (_) { return cb(null, false); }
  },
}));
/*
 * The raw body is kept for ONE path: the platform webhook, whose signature is
 * an HMAC over the exact bytes that were sent. Re-serialising the parsed object
 * gives different bytes (key order, spacing, number formatting) and the
 * signature never matches. Nothing else sees `rawBody`, so this costs one
 * string on a handful of requests a minute.
 */
app.use(express.json({
  limit: '12mb',
  verify: (req, res, buf) => {
    if (req.url && req.url.startsWith('/api/integrations/webhook/')) req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (res.statusCode >= 400) log.warn('http', `${req.method} ${req.path} -> ${res.statusCode}`, { ms: Date.now() - t });
    else log.debug('http', `${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - t}ms)`);
  });
  next();
});

/**
 * Bakım kapısı - the maintenance gate.
 *
 * For the half minute a restore is dropping and reloading the database, there
 * is no database to answer with. Without this, a waiter who taps "Ödeme al" in
 * that window gets a 500 and an English stack trace in the log, and - worse -
 * has no idea whether the payment was taken. Everything that would write is
 * turned away here with one plain sentence, before it reaches a handler.
 *
 * Reads are turned away too, and deliberately: a screen refreshing against a
 * schema that is mid-load does not fail politely, it fails with whatever the
 * engine says about a half-created table. `/api/health` still answers, because
 * the desktop shell watches it to decide whether the service is alive and must
 * not restart it in the middle of a restore, and the restore endpoints answer
 * because they are the ones running this.
 */
app.use((req, res, next) => {
  const msg = restore.maintenance();
  if (!msg) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health' || req.path.startsWith('/api/manage/restore')) return next();
  res.status(503).json({ ok: false, error: msg, code: 'BAKIM' });
});

/*
 * ROUTE TRACING, for the test run only.
 *
 * Switched on by NOKTAPP_TRACE_ROUTES and off in every other circumstance, so
 * a till never writes this file. It records the route TEMPLATE that matched -
 * "POST /api/delivery/orders/:id/status", not the url with an id in it - so
 * test/kapsam.js can hold the list of every endpoint the service declares
 * against the list of endpoints the suites actually exercised.
 *
 * The point is the gap. A test run that is green while a quarter of the API
 * has never been called is not a tested system, it is a tested quarter, and
 * the only way to know which quarter is to write it down.
 *
 * It sits HERE, above every route including /api/health, because a middleware
 * added after a route never sees that route at all.
 */
if (process.env.NOKTAPP_TRACE_ROUTES) {
  const traceFile = process.env.NOKTAPP_TRACE_ROUTES;
  app.use((req, res, next) => {
    /*
     * The template is captured in res.end rather than in the 'finish' event.
     * Express restores req.baseUrl as the router stack unwinds, so by 'finish'
     * it is '' and every mounted route was being written down without its
     * mount - "POST /shift/movement" instead of "POST /api/pos/shift/movement",
     * which then read as an endpoint no suite had ever called. res.end still
     * runs inside the handler, where baseUrl is still the mount path.
     */
    const end = res.end;
    res.end = function (...args) {
      if (req.route && !res.locals.__traceTmpl) {
        const path = req.route.path === '/' ? '' : req.route.path;
        /* An error answered by the app-level handler unwinds first, so fall
           back to the mount every router in this service uses: /api/<name>. */
        const base = req.baseUrl
          || (path.startsWith('/api/') ? '' : (String(req.originalUrl || '').split('?')[0]
              .split('/').slice(0, 3).join('/')));
        res.locals.__traceTmpl = base + path;
      }
      return end.apply(this, args);
    };
    res.on('finish', () => {
      const tmpl = res.locals.__traceTmpl;   // 404s and static files are not endpoints
      if (!tmpl) return;
      try {
        require('fs').appendFileSync(traceFile,
          `${req.method} ${tmpl} ${res.statusCode}\n`);
      } catch (_) { /* tracing must never break a request */ }
    });
    next();
  });
}

app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try { await db.value('SELECT 1'); dbOk = true; } catch (_) {}
  res.json({ ok: true, service: 'noktapp-pos', version: process.env.NOKTAPP_VERSION || '2.0.0',
    db: dbOk, ips: lan.localIps(), port: config.port, time: new Date().toISOString() });
});

/**
 * Customer display feed. No token: it only ever leaves 127.0.0.1 and it only
 * shows what the guest is already watching the cashier ring up.
 */
app.get('/api/display', async (req, res) => {
  try {
    const clientId = await db.getClientId();
    const cfg = await db.one('SELECT * FROM np_display_settings WHERE id=1');
    const client = clientId ? await db.one('SELECT company_name FROM clients WHERE id=?', [clientId]) : null;
    const active = await db.one(
      `SELECT o.id FROM orders o WHERE o.client_id=? AND o.status='open' AND o.is_deleted=0
        ORDER BY o.updated_at DESC LIMIT 1`, [clientId]);
    let order = null;
    if (active) {
      const orders = require('./modules/orders');
      order = await orders.getOrder(clientId, active.id);
    }
    res.json({ ok: true, settings: cfg, business: client, order });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/*
 * Every router gets the numeric-parameter guard (see util/http.js). `auth` and
 * `device` keep `id` out of it: theirs is a hardware device id, a varchar.
 */
const { numericParams } = require('./util/http');
const mount = (path, router, except = []) => app.use(path, numericParams(router, except));

mount('/api/auth', require('./routes/auth'), ['id']);
mount('/api/setup', require('./routes/setup'));
mount('/api/pos', require('./routes/pos'));
mount('/api/manage', require('./routes/manage'));
mount('/api/reports', require('./routes/reports'));
mount('/api/inventory', require('./routes/inventory'));
mount('/api/settings', require('./routes/settings'));
mount('/api/receipt', require('./routes/receipt'));
mount('/api/floor', require('./routes/floor'));
mount('/api/finance', require('./routes/finance'));
mount('/api/till', require('./routes/till'));
mount('/api/pricing', require('./routes/pricing'));
mount('/api/guest', require('./routes/guest'));
mount('/api/device', require('./routes/device'), ['id', 'deviceId']);
mount('/api/okc', require('./routes/okc'), ['id']);
mount('/api/qr', require('./routes/qr'));
mount('/api/mobile', require('./routes/mobile'));
mount('/api/integrations', require('./routes/integrations'));
mount('/api/delivery', require('./routes/delivery'));

// the till UI is served from here so the Electron shell only has to point a
// window at http://127.0.0.1:<port>/
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {          // eslint-disable-line no-unused-vars
  log.error('http', 'Unhandled error on ' + req.path, err.stack || err.message);
  res.status(err.status || 500).json({ ok: false, error: err.message || 'Sunucu hatasi' });
});

/**
 * The cloud relay hands us a request that came from a phone outside the
 * restaurant. We replay it against our own HTTP server so there is exactly one
 * implementation of every endpoint.
 */
relay.setHandler((msg) => new Promise((resolve) => {
  const body = msg.body ? JSON.stringify(msg.body) : null;
  const req = http.request({
    host: '127.0.0.1', port: config.port, path: msg.path, method: msg.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body ? Buffer.byteLength(body) : 0,
      Authorization: msg.authorization || '',
      'X-Device-Id': msg.device_id || '',
      'X-Via-Relay': '1',
    },
  }, (r) => {
    let buf = '';
    r.on('data', c => { buf += c; });
    r.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(buf); } catch (_) { parsed = { raw: buf.slice(0, 2000) }; }
      resolve({ status: r.statusCode, body: parsed });
    });
  });
  req.on('error', e => resolve({ status: 502, body: { ok: false, error: e.message } }));
  if (body) req.write(body);
  req.end();
}));

async function bootstrap() {
  for (const d of [config.dataDir, config.logDir, config.backupDir, config.mediaDir, config.tmpDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  log.info('boot', 'NOKTApp POS service starting', { dataDir: config.dataDir, port: config.port });

  await db.init();
  log.info('boot', 'Local database connected', { db: config.db.database });
  await db.getClientId();
  /*
   * The running version, written into the database itself so that every dump
   * taken from here carries it. Restore reads it back out of the dump to
   * refuse one written by a newer program than this - which it can only do if
   * the answer is inside the dump, and the dump is only the database.
   */
  await db.setSetting('app_version', process.env.NOKTAPP_VERSION || '2.0.0').catch(() => {});
  /* And who this till belongs to, in a file, while the database can still say.
     Restore checks a backup against this identity, and the day it has to do
     that is the day the database is the thing that is broken. */
  await restore.rememberIdentity();

  const server = app.listen(config.port, config.bindHost, () => {
    log.info('boot', `Service listening on http://${config.bindHost}:${config.port}`);
  });
  server.keepAliveTimeout = 65000;

  printing.start();
  mail.start();
  sync.start();
  backup.start();
  await lan.start(config.port);
  relay.start();
  /* Never awaited into the boot path: a platform that is unreachable, or a
     credential that will not decrypt, must not stop the till from opening. */
  integrations.start().catch(e => log.warn('entegrasyon', 'baslatilamadi', e.message));

  /*
   * The DEMO build fills itself on its first open, and only then.
   *
   * Three conditions guard it and the third is the one that matters: a build
   * marker the customer installer does not carry, a database that has never
   * been seeded, and NOT ONE BILL in the orders table. The last means a demo
   * till somebody has been playing with all week is never silently rewritten
   * by a restart, and a customer's real till could not be seeded even if the
   * wrong installer somehow reached it.
   *
   * Deliberately after listen(): seven years of inserts take a minute or two
   * and the screen has to be up saying so, not black.
   */
  require('./demo').seedOnFirstBoot(await db.getClientId())
    .catch(e => log.warn('demo', 'Demo verisi yuklenemedi: ' + e.message));

  const shutdown = async (sig) => {
    log.info('boot', 'Shutting down (' + sig + ')');
    printing.stop(); mail.stop(); sync.stop(); backup.stop(); lan.stop(); relay.stop(); integrations.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('boot', 'unhandled rejection', e && e.stack));
  return server;
}

if (require.main === module) {
  bootstrap().catch(e => { log.error('boot', 'Startup failed', e.stack || e.message); process.exit(1); });
}

module.exports = { app, bootstrap };
