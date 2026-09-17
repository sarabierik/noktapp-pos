'use strict';
/**
 * /api/settings - the administration API.
 *
 * Everything the Ayarlar screens do lands here - İşletme, Kullanıcılar, ÖKC,
 * Güvenlik denetimi, and Para's rate table. It deliberately does not replace
 * /api/manage/settings: that endpoint is what the setup wizard and the phone
 * app call, and it keeps working. This one is the
 * typed, validated, audited path - it knows what every key IS, so it can
 * refuse a bad value instead of storing it and finding out at the printer.
 *
 * Failures are answered, not thrown. A settings screen that shows a red 500
 * with no text is the same as no answer at all, so every handler that can fail
 * for a reason the owner can fix converts it to `fail(res, message, status)`
 * with a Turkish sentence.
 */
const express = require('express');
const auth = require('../auth');
const settings = require('../modules/settings');
const { ok, fail, wrap } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);

/** Same shape everywhere: business errors carry .status, anything else is a 500. */
function guard(handler) {
  return wrap(async (req, res) => {
    try { await handler(req, res); }
    catch (e) {
      if (!e.status) throw e;                      // real bug -> the error middleware logs it
      res.status(e.status).json({ ok: false, error: e.message, needs_confirm: !!e.needsConfirm });
    }
  });
}

const canSettings = auth.requirePerm('settings.manage');
const canUsers = auth.requirePerm('user.manage');
const canPrinters = auth.requirePerm('printer.manage');

/* ========================= the setting catalogue ==================== */

/** Definitions + current values in one call: the screen renders from this. */
r.get('/', canSettings, guard(async (req, res) => {
  const cat = settings.catalogue();
  ok(res, { ...cat, values: await settings.all() });
}));

r.post('/', canSettings, guard(async (req, res) => {
  const patch = req.body && req.body.settings ? req.body.settings : req.body;
  ok(res, await settings.save(req.clientId, patch, req.auth.uid));
}));

/** Who changed what. */
r.get('/history', canSettings, guard(async (req, res) =>
  ok(res, { rows: await settings.history(req.query.limit) })));

/* =============================== users ============================== */

/*
 * Only the licence holder may hand out the licence holder's own role.
 *
 * `settings.manage` is a manager's permission, and a manager who could set
 * their own role to "Isletme sahibi" would be one click away from deleting
 * last month's takings. So the role itself is gated on already being the
 * owner - a tenant token, or a `superadmin` staff account.
 */
function ownerOnlyRole(req, res, next) {
  const wanted = String((req.body && req.body.role) || '');
  if (wanted !== 'superadmin') return next();
  const a = req.auth;
  if (a && (a.kind === 'tenant' || a.role === 'superadmin')) return next();
  return fail(res, 'İşletme sahibi rolünü yalnızca işletme sahibi verebilir.', 403, 'OWNER_ONLY');
}


r.get('/users', canUsers, guard(async (req, res) => ok(res, {
  users: await settings.listUsers(req.clientId),
  ...settings.permissionCatalogue(),
  me: req.auth.uid,
  pin_length: Number(await require('../db').getSetting('pin_length', 4)),
})));

r.post('/users', canUsers, ownerOnlyRole, guard(async (req, res) =>
  ok(res, { id: await settings.saveUser(req.clientId, req.body, req.auth.uid) })));

r.post('/users/:id/role', canUsers, ownerOnlyRole, guard(async (req, res) => {
  await settings.setUserRole(req.clientId, Number(req.params.id), req.body.role, req.auth.uid);
  ok(res);
}));

r.post('/users/:id/active', canUsers, guard(async (req, res) => {
  await settings.setUserActive(req.clientId, Number(req.params.id), !!req.body.active, req.auth.uid);
  ok(res);
}));

r.post('/users/:id/permissions', canUsers, guard(async (req, res) =>
  ok(res, { perms: await settings.setUserPerms(req.clientId, Number(req.params.id), req.body.perms, req.auth.uid) })));

/*
 * A PIN reset is its own endpoint rather than a field on the user form, so it
 * is one auditable action: the till PIN is the whole credential and the manager
 * needs to be able to do it in one tap when somebody is locked out mid-service.
 */
r.post('/users/:id/pin', canUsers, guard(async (req, res) => {
  await settings.resetPin(req.clientId, Number(req.params.id), req.body.pin, req.auth.uid);
  ok(res, { message: 'PIN güncellendi. Eski PIN artık çalışmaz.' });
}));

r.post('/users/:id/unlock', canUsers, guard(async (req, res) => {
  await settings.unlockUser(req.clientId, Number(req.params.id));
  ok(res);
}));

r.delete('/users/:id', canUsers, guard(async (req, res) =>
  ok(res, await settings.deleteUser(req.clientId, Number(req.params.id), req.auth.uid))));

/* ---------------------------- my profile --------------------------- */
/*
 * These four carry NO permission check beyond requireAuth on purpose: they act
 * on req.auth.uid and nothing else, so the worst a caller can do is change
 * their own name - and each credential change is gated on the current one.
 */
r.get('/profile', guard(async (req, res) => ok(res, await settings.myProfile(req.clientId, req.auth.uid))));

r.post('/profile', guard(async (req, res) => {
  await settings.updateMyProfile(req.clientId, req.auth.uid, req.body);
  ok(res);
}));

r.post('/profile/password', guard(async (req, res) => {
  await settings.changeMyPassword(req.clientId, req.auth.uid, req.body.current, req.body.password);
  ok(res, { message: 'Telefon şifreniz değişti.' });
}));

r.post('/profile/pin', guard(async (req, res) => {
  await settings.changeMyPin(req.clientId, req.auth.uid, req.body.current, req.body.pin);
  ok(res, { message: 'PIN değişti. Eski PIN artık çalışmaz.' });
}));

/* ========================= stations & printers ====================== */

r.get('/stations', canSettings, guard(async (req, res) => ok(res, {
  stations: await settings.listStations(req.clientId),
  categories: await settings.categoriesWithStation(req.clientId),
})));

/*
 * The same two writes the İstasyonlar tab on Yazıcı ve fiş uses, mirrored here
 * so a caller on this older path is not left able only to delete. A station
 * with history refuses the delete; without these it would refuse and offer
 * nothing.
 */
r.post('/stations/:id/active', canSettings, guard(async (req, res) =>
  ok(res, await settings.setStationActive(req.clientId, Number(req.params.id), !!(req.body || {}).active))));

r.post('/stations/order', canSettings, guard(async (req, res) =>
  ok(res, { ordered: await settings.reorderStations(req.clientId, (req.body || {}).ids) })));

r.post('/stations', canSettings, guard(async (req, res) =>
  ok(res, { id: await settings.saveStation(req.clientId, req.body) })));

r.delete('/stations/:id', canSettings, guard(async (req, res) => {
  await settings.deleteStation(req.clientId, Number(req.params.id));
  ok(res);
}));

r.post('/stations/:id/default', canSettings, guard(async (req, res) => {
  await settings.setDefaultStation(req.clientId, Number(req.params.id));
  ok(res);
}));

r.post('/stations/:id/categories', canSettings, guard(async (req, res) =>
  ok(res, { assigned: await settings.assignCategories(req.clientId, Number(req.params.id), req.body.category_ids) })));

r.get('/printers', canSettings, guard(async (req, res) => ok(res, {
  ...(await settings.listPrinters(req.clientId)),
  stations: await settings.listStations(req.clientId),
})));

r.post('/printers', canPrinters, guard(async (req, res) =>
  ok(res, { id: await settings.savePrinter(req.clientId, req.body) })));

r.delete('/printers/:id', canPrinters, guard(async (req, res) => {
  await settings.deletePrinter(req.clientId, Number(req.params.id));
  ok(res);
}));

/*
 * The test always answers 200, with {printed:false, reason, message} when
 * nothing came out. It is not an HTTP error for a printer to be unplugged, and
 * turning it into one meant the screen showed "İşlem tamamlanamadı" instead of
 * the socket's actual complaint.
 */
/*
 * Find the printers on the network instead of asking for an IP address.
 *
 * Nobody at a counter knows the address of the box under the till, so the
 * field stayed empty and the printer never got added. This sweeps the /24 the
 * PC is on for port 9100 and hands back what answered. It is a slow endpoint
 * by nature - a few seconds - so it is a POST the user asks for by pressing a
 * button, never something a screen does on load.
 */
r.post('/printers/scan', canPrinters, guard(async (req, res) => {
  const discover = require('../print/discover');
  /*
   * The blocks the saved printers live in go into the sweep beside the one
   * this PC is on. A till that has moved network - a new router, a move to
   * the office, a hotel that renumbered - otherwise reports "yazici
   * bulunamadi" about a printer that is sitting there switched on, because
   * nobody thought to tell it to look at 192.168.1.x any more.
   */
  let extra = [];
  try {
    const saved = await require('../modules/settings').listPrinters(req.clientId);
    extra = (saved.printers || []).map(p => p.ip_address).filter(Boolean);
  } catch (_) { extra = []; }
  const out = await discover.scan({
    subnet: req.body && req.body.subnet ? String(req.body.subnet) : null,
    timeoutMs: Math.min(Math.max(Number((req.body || {}).timeout_ms) || 900, 120), 2500),
    extra,
  });
  ok(res, out);
}));

r.post('/printers/:id/test', canPrinters, guard(async (req, res) =>
  ok(res, await settings.testPrinter(req.clientId, Number(req.params.id)))));

r.get('/print-jobs', canSettings, guard(async (req, res) =>
  ok(res, await settings.printQueue(req.clientId, { status: req.query.status, limit: req.query.limit }))));

r.post('/print-jobs/retry-failed', canPrinters, guard(async (req, res) =>
  ok(res, { retried: await settings.retryFailed(req.clientId) })));

r.post('/print-jobs/:id/retry', canPrinters, guard(async (req, res) => {
  await settings.retryJob(req.clientId, Number(req.params.id));
  ok(res);
}));

r.post('/print-jobs/:id/cancel', canPrinters, guard(async (req, res) => {
  await settings.cancelJob(req.clientId, Number(req.params.id));
  ok(res);
}));

/* ================================ ÖKC =============================== */

r.get('/okc', canSettings, guard(async (req, res) => ok(res, {
  devices: await settings.listDevices(req.clientId),
  providers: settings.providerCatalogue(),
  registers: await settings.listRegisters(req.clientId),
  fiscal_enabled: String(await require('../db').getSetting('fiscal_enabled', '0')) === '1',
})));

/** The answer carries `warnings`; the screen is required to show them. */
r.post('/okc/devices', canSettings, guard(async (req, res) =>
  ok(res, await settings.saveDevice(req.clientId, req.body))));

r.post('/okc/devices/:id/test', canSettings, guard(async (req, res) =>
  ok(res, await settings.testDevice(req.clientId, Number(req.params.id)))));

r.post('/okc/devices/:id/active', canSettings, guard(async (req, res) => {
  await settings.setDeviceActive(req.clientId, Number(req.params.id), !!req.body.active);
  ok(res);
}));

r.delete('/okc/devices/:id', canSettings, guard(async (req, res) =>
  ok(res, await settings.deleteDevice(req.clientId, Number(req.params.id)))));

r.post('/okc/quick-simulator', canSettings, guard(async (req, res) =>
  ok(res, await settings.quickSimulator(req.clientId))));

r.post('/okc/registers', canSettings, guard(async (req, res) =>
  ok(res, { id: await settings.saveRegister(req.clientId, req.body) })));

/* ===================== business details & receipt =================== */

r.get('/business', canSettings, guard(async (req, res) => ok(res, await settings.business(req.clientId))));

r.post('/business', canSettings, guard(async (req, res) => {
  await settings.saveBusiness(req.clientId, req.body, req.auth.uid);
  ok(res);
}));

/* ============================= currencies =========================== */

r.get('/currencies', canSettings, guard(async (req, res) => ok(res, {
  currencies: await settings.currencies(req.clientId),
  history: await settings.rateHistory(req.clientId, 20),
  show_on_receipt: String(await require('../db').getSetting('receipt_show_fx', '0')) === '1',
})));

r.post('/currencies/:id/rate', canSettings, guard(async (req, res) =>
  ok(res, await settings.saveRate(req.clientId, Number(req.params.id), req.body.rate, req.auth.uid, !!req.body.confirm))));

r.post('/currencies/:id/active', canSettings, guard(async (req, res) => {
  await settings.setCurrencyActive(req.clientId, Number(req.params.id), !!req.body.active);
  ok(res);
}));

/* ============================ demo verisi =========================== */
/*
 * Reading the state is a settings matter; ERASING it is an owner matter.
 *
 * "Demo verisini sil" deletes seven years of bills in one press and cannot be
 * undone by anything short of a restore. A manager who can change the VAT rate
 * should not also be able to empty the books by misreading a button, so the
 * destructive half asks for the owner's own password the way every other
 * irreversible act in this product does.
 */
r.get('/demo', canSettings, guard(async (req, res) =>
  ok(res, await require('../demo').status(req.clientId))));

r.post('/demo/clear', auth.requireOwner, guard(async (req, res) => {
  const scope = (req.body && req.body.scope) || 'hareket';
  await auth.verifyOwnerPassword(req.clientId, req.body && req.body.owner_password, req.auth.uid);
  const out = await require('../demo').clear(req.clientId, { scope, actor: req.auth.name || req.auth.uid });
  ok(res, out);
}));

/**
 * Load the demo data onto a till that already has something on it.
 *
 * The automatic seed at first boot refuses a database with even one bill in
 * it, on purpose: a demo machine somebody has been using for a week must not
 * be rewritten by a restart. That guard leaves one legitimate case with no way
 * through - a demo build installed over an existing installation - and this is
 * it, with the guard replaced by a person: owner only, owner's password, and
 * the word typed out on the screen.
 *
 * It is refused outright on a customer build. There is no flag, no header and
 * no body field that turns it on: the build either carries the marker file or
 * it does not.
 */
r.post('/demo/load', auth.requireOwner, guard(async (req, res) => {
  const demo = require('../demo');
  if (!demo.isDemoBuild()) {
    return fail(res, 'Bu sürüm demo verisi yükleyemez. Demo verisi yalnızca tanıtım ' +
      'sürümünde bulunur.', 403);
  }
  await auth.verifyOwnerPassword(req.clientId, req.body && req.body.owner_password, req.auth.uid);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body && req.body.from)) ? req.body.from : '2020-01-01';
  const out = await demo.seed(req.clientId, { from, replace: true });
  ok(res, out);
}));

/* ============================ self-check ============================ */

r.get('/self-check', canSettings, guard(async (req, res) => ok(res, await settings.selfCheck(req.clientId))));

module.exports = r;
