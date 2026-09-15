'use strict';
/**
 * First-run wizard. Four steps, and the customer is selling:
 *   1. online login with the e-mail/password we issued
 *   2. business details for the receipt
 *   3. the first manager PIN
 *   4. tables and printer
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const auth = require('../auth');
const catalog = require('../modules/catalog');
const _config = require('../config');
const log = require('../logger');
const { ok, fail, wrap, need } = require('../util/http');

const floor = require('../modules/floor');

const r = express.Router();

/**
 * THE WIZARD CLOSES WHEN SETUP IS DONE.
 *
 * Every step below used to ask for `requireAuth` and nothing else, and
 * `requireAuth` is satisfied by any staff token - a waiter's included. The
 * wizard is not a one-time screen to the server: it stays reachable for the
 * life of the installation. So a waiter's phone, on the restaurant's own wifi,
 * could POST to /api/setup/business and rewrite the company name, the tax
 * number and the tax office that print on every fiscal receipt, or POST to
 * /api/setup/tables and invent a floor.
 *
 * While setup is still running there are no staff at all - the only token that
 * can exist is the tenant's, from the online licence login - so nothing is
 * lost by letting it through. The moment setup_done is set, these become what
 * they always were in meaning: settings, behind `settings.manage`.
 */
const settingsPerm = auth.requirePerm('settings.manage');
function wizardOrSettings(req, res, next) {
  db.getSetting('setup_done', '0')
    .then(v => (String(v) === '1' ? settingsPerm(req, res, next) : next()))
    .catch(next);
}

r.get('/state', wrap(async (req, res) => {
  const clientId = await db.getClientId();
  ok(res, {
    activated: !!clientId,
    setup_done: String(await db.getSetting('setup_done', '0')) === '1',
    has_staff: clientId ? Number(await db.value('SELECT COUNT(*) FROM users WHERE client_id=?', [clientId])) > 0 : false,
    has_tables: clientId ? Number(await db.value('SELECT COUNT(*) FROM restaurant_tables WHERE client_id=?', [clientId])) > 0 : false,
    has_printer: clientId ? Number(await db.value('SELECT COUNT(*) FROM printers WHERE client_id=?', [clientId])) > 0 : false,
  });
}));

/** Seed the empty database once the licence is known. */
r.post('/seed', auth.requireAuth, wizardOrSettings, wrap(async (req, res) => {
  const clientId = req.clientId;
  const already = Number(await db.value('SELECT COUNT(*) FROM stations WHERE client_id=?', [clientId]));
  if (already) return ok(res, { skipped: true });
  const file = path.join(__dirname, '..', '..', '..', 'database', '03_seed.sql');
  let sql = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (sql) {
    sql = sql.replace(/:client_id/g, String(clientId));
    for (const stmt of sql.split(/;\s*\n/).map(s => s.trim()).filter(s => s && !s.startsWith('--'))) {
      await db.exec(stmt).catch(e => log.warn('setup', 'seed statement failed', e.message));
    }
  }
  ok(res, { seeded: true });
}));

r.post('/business', auth.requireAuth, wizardOrSettings, wrap(async (req, res) => {
  const b = req.body;
  /* The name goes on every receipt, so setup cannot finish without it. */
  const businessName = need(b.business_name || b.name, 'Isletme adi gerekli');
  /* clients.tax_number, tax_office, phone and full_address are all NOT NULL:
     a setup that skipped the tax office wrote NULL and came back as a 500 with
     the column name in it. Not filled in is '', which is what it means. */
  const text = v => (v === undefined || v === null ? '' : String(v));
  await db.exec(
    'UPDATE clients SET company_name=?, tax_number=?, tax_office=?, phone=?, full_address=?, receipt_header=?, receipt_footer=? WHERE id=?',
    [businessName, text(b.tax_number), text(b.tax_office), text(b.phone), text(b.address),
     b.receipt_header || null, b.receipt_footer || 'Bizi tercih ettiginiz icin tesekkurler', req.clientId]);
  const exists = await db.one('SELECT id FROM business_settings WHERE client_id=?', [req.clientId]);
  if (!exists) {
    await db.exec(
      'INSERT INTO business_settings (client_id, business_name, tax_number, tax_office, address_line1, city, phone, email, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())',
      [req.clientId, businessName, b.tax_number || null, b.tax_office || null, b.address || null,
       b.city || null, b.phone || null, b.email || null]);
  } else {
    await db.exec(
      'UPDATE business_settings SET business_name=?, tax_number=?, tax_office=?, address_line1=?, city=?, phone=?, email=?, updated_at=NOW() WHERE client_id=?',
      [businessName, b.tax_number || null, b.tax_office || null, b.address || null,
       b.city || null, b.phone || null, b.email || null, req.clientId]);
  }
  ok(res);
}));

/** The very first staff member is always a manager. */
r.post('/first-user', auth.requireAuth, wrap(async (req, res) => {
  const has = Number(await db.value('SELECT COUNT(*) FROM users WHERE client_id=?', [req.clientId]));
  if (has) return fail(res, 'Kullanicilar zaten olusturulmus', 409);
  try {
    /*
     * The FIRST user is the licence holder, so the role is `superadmin`.
     *
     * It used to be `admin`, and that one word cost the owner his own
     * authority: deleting a bill, reopening a closed day and taking money off
     * the books are all guarded by "is this the owner", which passes for a
     * tenant token or `superadmin` and deliberately not for `admin` - an admin
     * is a manager the owner hired. But the owner does not work the till on a
     * tenant token; he signs in with a PIN like everyone else. So the screen
     * told the person who bought the licence that only the business owner may
     * do this. Whoever runs the setup wizard IS that person.
     */
    const id = await catalog.saveUser(req.clientId, {
      display_name: req.body.display_name, username: req.body.username || 'yonetici',
      email: req.body.email || null, role: 'superadmin',
      pin: req.body.pin, password: req.body.password || null,
    }, null);
    ok(res, { id });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

/*
 * Delegated to floor.bulkCreate, which is the one the Masalar screen uses.
 * catalog.bulkTables was a second copy with none of its guards: it looped from
 * `from` to `to` with no range check and no ceiling, so `to: 100000` was a
 * hundred thousand INSERTs and a till that never came back, and a repeated
 * step made a second "Masa 1" beside the first. floor.bulkCreate validates the
 * range, caps a single call at 200, and refuses names that are already taken.
 */
r.post('/tables', auth.requireAuth, wizardOrSettings, wrap(async (req, res) => {
  try {
    const zoneId = req.body.zone_id || await catalog.saveZone(req.clientId, { name: req.body.zone_name || 'Salon' });
    const out = await floor.bulkCreate(req.clientId, {
      zone_id: zoneId, prefix: req.body.prefix || 'Masa',
      from: req.body.from || 1, to: req.body.to || 10 });
    /* `tables` is the count the wizard's screen has always read. */
    ok(res, { zone_id: zoneId, tables: out.created, revived: out.revived, ids: out.ids });
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

r.post('/finish', auth.requireAuth, wizardOrSettings, wrap(async (req, res) => {
  await db.setSetting('setup_done', '1');
  await db.exec('UPDATE clients SET setup_done=1 WHERE id=?', [req.clientId]);
  log.info('setup', 'Setup wizard completed');
  ok(res);
}));

module.exports = r;
