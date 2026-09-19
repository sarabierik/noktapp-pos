'use strict';
/**
 * /api/okc — the fiscal device registry, its evidence, and production enabling.
 *
 * This router is ADDITIVE. The existing /api/manage/fiscal/* endpoints that
 * create and test a device are untouched and keep working exactly as they did;
 * what lives here is the layer the integration specification asks for and the
 * product did not have: which real GİB-registered device this is, what has
 * actually been proven about it, and the explicit, audited act of allowing it
 * to take money.
 *
 * On permissions. Everything is behind `settings.manage`, because every route
 * here changes what the till is allowed to do with a legal fiscal device.
 * Enabling production is additionally gated on an explicit confirmation field
 * — not because a checkbox is security, but because a one-character typo in a
 * REST client should not silently arm a terminal.
 */
const express = require('express');
const auth = require('../auth');
const db = require('../db');
const log = require('../logger');
const kayit = require('../fiscal/kayit');
const yetenek = require('../fiscal/yetenek');
const engelli = require('../fiscal/adapters/engelli');
const fiscal = require('../fiscal');
const { ok, fail, wrap } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);
r.use(auth.requirePerm('settings.manage'));

/* ---------------------------------------------------------------- registry */

/** The catalogue a cashier picks from. Fuel-pump records only on request. */
r.get('/registry', wrap(async (req, res) => {
  const includeFuel = String(req.query.fuel || '') === '1';
  const devices = await kayit.all(req.clientId, { includeFuel });
  ok(res, {
    devices,
    blocked_owners: engelli.BLOCKED,
    in_progress_owners: engelli.IN_PROGRESS,
    note: 'Bu liste GİB kaydıdır, uyumluluk listesi değildir. Bir cihazın burada '
        + 'olması NOKTApp ile çalıştığı anlamına gelmez.',
  });
}));

/** What would this serial match? Read-only; commissions nothing. */
r.get('/registry/match', wrap(async (req, res) => {
  try {
    const m = await kayit.matchSerial(req.query.serial || '');
    ok(res, { match: m.record, prefix: m.prefix, serial: m.serial });
  } catch (e) {
    fail(res, e.message, e.status || 400, { code: e.code, candidates: e.candidates || null });
  }
}));

/* ---------------------------------------------------------------- devices  */

/** Commissioned devices, each with its three evidence dimensions spelled out. */
r.get('/devices', wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT d.*, g.brand_model, g.fiscal_owner, g.owner_key, g.fiscal_class,
            g.evidence_kind, g.note AS registry_note
       FROM fiscal_devices d
       LEFT JOIN fiscal_registry_devices g ON g.id = d.registry_device_id
      WHERE d.client_id=? ORDER BY d.id`, [req.clientId]);
  const devices = [];
  for (const d of rows) {
    const caps = await yetenek.profile(req.clientId, d.id);
    devices.push({
      id: d.id, serial: d.serial_number, serial_raw: d.serial_raw,
      provider: d.provider, prefix: d.fiscal_prefix,
      registry: d.registry_device_id ? {
        brand_model: d.brand_model, fiscal_owner: d.fiscal_owner,
        fiscal_class: d.fiscal_class, evidence_kind: d.evidence_kind, note: d.registry_note,
      } : null,
      evidence: {
        registry_observation: d.evidence_kind || (d.registry_device_id ? 'live_register' : 'not_commissioned'),
        documentation_access: engelli.BLOCKED[d.provider] ? 'not_obtained'
                              : engelli.IN_PROGRESS.includes(d.provider) ? 'partial' : 'unknown',
        implementation_state: d.wire_verified ? 'laboratory_tested' : 'design_only',
      },
      production_enabled: !!d.production_enabled,
      production_enabled_at: d.production_enabled_at,
      wire_verified: !!d.wire_verified,
      quarantine_reason: d.quarantine_reason || null,
      environment: d.environment,
      capabilities: caps,
      verified_count: caps.filter(c => c.state === 'VERIFIED').length,
      capability_total: caps.length,
    });
  }
  ok(res, { devices });
}));

/** Bind a device to its real registry record. Does NOT enable production. */
r.post('/devices/:id/commission', wrap(async (req, res) => {
  try {
    const out = await kayit.commission(
      req.clientId, Number(req.params.id), req.body && req.body.serial,
      { registryDeviceId: req.body && req.body.registry_device_id });
    log.info('okc', 'Cihaz devreye alındı', {
      device: Number(req.params.id), prefix: out.prefix,
      model: out.registry.brand_model, by: req.auth && req.auth.uid });
    ok(res, out);
  } catch (e) {
    fail(res, e.message, e.status || 400, { code: e.code, candidates: e.candidates || null });
  }
}));

/* ------------------------------------------------------------ capabilities */

r.get('/devices/:id/capabilities', wrap(async (req, res) => {
  ok(res, { capabilities: await yetenek.profile(req.clientId, Number(req.params.id)) });
}));

/** Record what a test or a vendor letter established. VERIFIED needs evidence. */
r.post('/devices/:id/capabilities', wrap(async (req, res) => {
  const b = req.body || {};
  try {
    const out = await yetenek.record(req.clientId, Number(req.params.id), b.capability, b.state, b);
    log.info('okc', 'Yetenek kaydı', {
      device: Number(req.params.id), capability: b.capability, state: b.state,
      evidence: b.evidence_ref || null, by: req.auth && req.auth.uid });
    ok(res, out);
  } catch (e) { fail(res, e.message, e.status || 400, { code: e.code }); }
}));

/* -------------------------------------------------------------- production */

/**
 * Arm or disarm a device for real fiscal transactions.
 *
 * Enabling requires the caller to echo the device's own serial. That is not
 * security theatre — it is the same discipline the rest of this module uses:
 * an irreversible-feeling action should not be possible without naming the
 * thing it applies to.
 */
r.post('/devices/:id/production', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const enable = !!(req.body && req.body.enabled);
  const d = await db.one('SELECT * FROM fiscal_devices WHERE id=? AND client_id=?', [id, req.clientId]);
  if (!d) return fail(res, 'Cihaz bulunamadı', 404);

  if (enable) {
    if (!d.registry_device_id) {
      return fail(res, 'Önce cihazı GİB listesinden seçip devreye alın.', 409, { code: 'NOT_COMMISSIONED' });
    }
    if (String(req.body.confirm_serial || '').toUpperCase() !== String(d.serial_number || '').toUpperCase()) {
      return fail(res, 'Onay için cihazın seri numarasını yazın.', 400, { code: 'CONFIRMATION_REQUIRED' });
    }
    const caps = await yetenek.profile(req.clientId, id);
    const sale = caps.find(c => c.capability === 'basketSale');
    if (!sale || sale.state !== 'VERIFIED') {
      return fail(res,
        'basketSale yeteneği doğrulanmadan üretime açılamaz. Önce üretici kanıtını girin.',
        409, { code: 'CAPABILITY_UNAVAILABLE' });
    }
  }
  await db.exec(
    `UPDATE fiscal_devices SET production_enabled=?, production_enabled_at=?, production_enabled_by=?
      WHERE id=? AND client_id=?`,
    [enable ? 1 : 0, enable ? new Date() : null, enable ? (req.auth && req.auth.uid) || null : null,
     id, req.clientId]);
  log.info('okc', enable ? 'Cihaz üretime açıldı' : 'Cihaz üretimden alındı', {
    device: id, serial: d.serial_number, by: req.auth && req.auth.uid });
  ok(res, { id, production_enabled: enable });
}));

/** Quarantine: a device with an unresolved operation must not take more money. */
r.post('/devices/:id/quarantine', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const reason = (req.body && req.body.reason) ? String(req.body.reason).slice(0, 190) : null;
  await db.exec('UPDATE fiscal_devices SET quarantine_reason=? WHERE id=? AND client_id=?',
    [reason, id, req.clientId]);
  log.info('okc', reason ? 'Cihaz karantinaya alındı' : 'Karantina kaldırıldı',
    { device: id, reason, by: req.auth && req.auth.uid });
  ok(res, { id, quarantine_reason: reason });
}));

/* ------------------------------------------------------------ diagnostics  */

/**
 * Non-financial checks only, and each one says whether it touches the device.
 *
 * Anything with a device-side effect is listed explicitly rather than run
 * quietly, because "run diagnostics" must never be a way to accidentally print
 * on a legal fiscal printer.
 */
r.post('/devices/:id/diagnostics', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const d = await db.one('SELECT * FROM fiscal_devices WHERE id=? AND client_id=?', [id, req.clientId]);
  if (!d) return fail(res, 'Cihaz bulunamadı', 404);

  const checks = [];
  checks.push({ name: 'Kayıt defteri kimliği', device_effect: false,
    pass: !!d.registry_device_id,
    detail: d.registry_device_id ? `Prefix ${d.fiscal_prefix}` : 'Cihaz GİB listesinden seçilmemiş' });
  checks.push({ name: 'Mesaj katmanı doğrulandı', device_effect: false,
    pass: !!d.wire_verified,
    detail: d.wire_verified ? 'wire_verified = 1'
      : 'Üretici ECR/GMP-3 dokümanı ile doğrulanmadı; simülatör dışında çalışmaz' });
  const caps = await yetenek.profile(req.clientId, id);
  checks.push({ name: 'Yetenek kanıtı', device_effect: false,
    pass: caps.some(c => c.state === 'VERIFIED'),
    detail: `${caps.filter(c => c.state === 'VERIFIED').length}/${caps.length} doğrulandı, `
          + `${caps.filter(c => c.state === 'UNKNOWN').length} bilinmiyor` });
  checks.push({ name: 'Karantina', device_effect: false,
    pass: !d.quarantine_reason, detail: d.quarantine_reason || 'Temiz' });
  checks.push({ name: 'Üretim izni', device_effect: false,
    pass: !!d.production_enabled,
    detail: d.production_enabled ? 'Açık' : 'Kapalı — mali işlem yapılamaz' });

  let adapter = null;
  try {
    const a = fiscal.adapterFor ? fiscal.adapterFor(d) : null;
    adapter = a && a.describe ? await a.describe() : null;
  } catch (e) { adapter = { error: e.code || e.message }; }

  ok(res, {
    device: { id, serial: d.serial_number, provider: d.provider },
    checks, adapter,
    ran_device_side_commands: false,
  });
}));

module.exports = r;
