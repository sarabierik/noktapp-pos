'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const licence = require('../licence');
const lan = require('../lan');
const { ok, fail, wrap } = require('../util/http');

const r = express.Router();

/** Step 1 - the online login page. Unlocks the installation. */
r.post('/tenant-login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 'E-posta ve sifre gerekli');
  try {
    const out = await licence.login(email, password);
    const token = await auth.issueToken({ cid: out.client.id, uid: 0, role: 'admin', name: out.client.company_name, kind: 'tenant' }, '12h');
    ok(res, { token, client: out.client, licence: out.licence, offline: !!out.offline });
  } catch (e) {
    fail(res, e.message, e.needsOnline || e.graceExpired ? 403 : 401);
  }
}));

/** Step 2 - the staff PIN pad on the till. */
r.post('/pin', wrap(async (req, res) => {
  const clientId = await db.getClientId();
  if (!clientId) return fail(res, 'Once isletme girisi yapin', 403);
  try {
    const out = await auth.pinLogin(clientId, req.body.pin, req.ip);
    ok(res, out);
  } catch (e) {
    /* the code matters here: the PIN pad draws a different screen for "wrong
       PIN" than for "locked, wait N minutes", and without it both look the
       same to the till */
    fail(res, e.message, e.status || 401, e.code || null);
  }
}));

/** A supervisor authorising a single action. */
r.post('/override', auth.requireAuth, wrap(async (req, res) => {
  try {
    const who = await auth.overridePin(req.clientId, req.body.pin, req.body.perm, req.ip);
    ok(res, { approved_by: who });
  } catch (e) { fail(res, e.message, e.status || 403); }
}));

r.get('/state', wrap(async (req, res) => {
  const st = await licence.status();
  const clientId = await db.getClientId();
  const setupDone = String(await db.getSetting('setup_done', '0')) === '1';
  const staff = clientId ? Number(await db.value('SELECT COUNT(*) FROM users WHERE client_id=? AND is_active=1', [clientId])) : 0;
  ok(res, { licence: st, setup_done: setupDone, staff_count: staff, device_id: await licence.deviceId() });
}));

r.post('/logout', auth.requireAuth, wrap(async (req, res) => {
  if (req.auth.uid) await db.exec('UPDATE users SET is_logged_in=0 WHERE id=?', [req.auth.uid]);
  ok(res);
}));

r.get('/permissions', auth.requireAuth, wrap(async (req, res) => {
  ok(res, { all: auth.PERMISSIONS, mine: await auth.permissionsFor(req.clientId, req.auth.uid, req.auth.role) });
}));

/**
 * Which whole AREAS of the program this installation is using.
 *
 * Beside the permissions on purpose, and read by everybody who can sign in
 * rather than by managers only: this is what the client draws its navigation
 * from, and a waiter's sidebar has to be able to leave ÖKC out just as much as
 * the owner's does. It is not a permission - a feature that is off is off for
 * the person who owns the restaurant too.
 *
 * A feature living behind `settings.manage` would have meant every cashier's
 * shell asking a 403 whether ÖKC exists and quietly deciding it did not, which
 * is the right answer by accident and the wrong one the day it changes.
 */
r.get('/features', auth.requireAuth, wrap(async (req, res) => {
  ok(res, {
    features: {
      okc: String(await db.getSetting('fiscal_enabled', '0')) === '1',
    },
  });
}));

/* ------------------------- phone pairing -------------------------- */
r.post('/pair-code', auth.requireAuth, auth.requirePerm('user.manage'), wrap(async (req, res) => {
  ok(res, await lan.createPairCode(req.clientId, req.auth.uid));
}));

/**
 * Two ways in, one row.
 *
 *   qr_token  - the phone scanned the symbol on the till. No password: the
 *               token is unguessable, single use, ten minutes old at most, and
 *               the till already chose which member of staff it is for.
 *   code      - the six digits were typed. Short enough to guess across a
 *               lunch service, so this path still demands username + password.
 *
 * A code minted without a member of staff attached (the old flow, and what the
 * "genel kod" button still produces) always asks for the password, whichever
 * way it arrives.
 */
r.post('/pair', wrap(async (req, res) => {
  try {
    ok(res, await require('../eslestirme').pair(req.body || {}, { ip: req.ip }));
  } catch (e) { fail(res, e.message, e.status || 400); }
}));

r.get('/devices', auth.requireAuth, wrap(async (req, res) => ok(res, { devices: await lan.listDevices(req.clientId) })));
r.post('/devices/:id/revoke', auth.requireAuth, auth.requirePerm('user.manage'), wrap(async (req, res) => {
  await lan.revokeDevice(req.clientId, req.params.id);
  ok(res);
}));

module.exports = r;
