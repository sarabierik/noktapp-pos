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
    /* Where each started protocol came from, and what is still unproven about
       it. "Started" is not one state - see PROTOCOL_SOURCE in engelli.js. */
    protocol_source: engelli.PROTOCOL_SOURCE,
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

/*
 * :id IS A DATABASE KEY, AND A PATH SEGMENT IS NOT.
 *
 * Every route below takes a device id, and each of them used to do
 * Number(req.params.id) and hand the result to a query. `/devices/abc/pair`
 * therefore reached MariaDB as NaN, which it reads as an identifier, and the
 * answer that came back to the caller was
 *
 *     500  Unknown column 'NaN' in 'WHERE'
 *
 * That is wrong three times over: a 500 says the till broke when the caller
 * simply asked for a device that cannot exist; the shape of our query leaks to
 * anybody who can sign in; and it reaches a cashier's screen as a red box of
 * English SQL. One guard on the parameter rather than seven repairs in seven
 * handlers, so the routes not written yet inherit it too.
 */
r.param('id', (req, res, next, raw) => {
  if (!/^[1-9]\d{0,17}$/.test(String(raw))) return fail(res, 'Cihaz bulunamadı', 404);
  next();
});

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
      /*
       * Three INDEPENDENT facts, never collapsed into one badge. A device can
       * be in GİB's register (observation), have a published protocol we have
       * implemented (documentation + implementation), and still have never
       * printed a receipt for us (proof). Only the last one entitles anybody
       * to take money with it.
       */
      evidence: (() => {
        const src = engelli.PROTOCOL_SOURCE[d.provider] || null;
        return {
          registry_observation: d.evidence_kind || (d.registry_device_id ? 'live_register' : 'not_commissioned'),
          documentation_access: engelli.BLOCKED[d.provider] ? 'not_obtained'
                                : src ? (src.source === 'vendor_documented' ? 'vendor_published' : 'none_designed')
                                : 'unknown',
          protocol_ref: src ? src.ref : null,
          contract: src ? src.contract : 'unknown',
          implementation_state: d.wire_verified ? 'laboratory_tested'
                                : src && src.source === 'vendor_documented' ? 'written_to_vendor_doc'
                                : 'design_only',
          device_proven: !!d.wire_verified,
        };
      })(),
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

/* ---------------------------------------------------------------- pairing */

/**
 * HUGIN PC Link pairing — the "hello world" that teaches the till the serial.
 *
 * Two things happen on the device first, and neither can be done from here:
 * the cashier opens Uygulama Merkezi → Entegrasyon → PC Link, and types the
 * VKN from the Hugin integration contract. The device then shows its address
 * and waits. This endpoint is the other half of that handshake.
 *
 * What it records, and why each one:
 *   serial_number        the device's mali sicil no, which it tells us
 *   pclink_sfa_version   which firmware answered, so capability evidence can
 *                        say what it was evidence OF
 *   pclink_cert_sha256   the certificate to demand from now on
 *
 * Re-pairing an already-paired device requires confirm_serial, the same way
 * opening production does. A silent re-pair would let a till be moved onto a
 * different terminal - or an impostor - with one click and no trace.
 */
r.post('/devices/:id/pair', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const d = await db.one('SELECT * FROM fiscal_devices WHERE id=? AND client_id=?', [id, req.clientId]);
  if (!d) return fail(res, 'Cihaz bulunamadı', 404);
  if (String(d.provider || '').toLowerCase() !== 'hugin') {
    return fail(res, 'Eşleşme yalnızca Hugin PC Link cihazları içindir.', 400,
      { code: 'PAIR_NOT_SUPPORTED' });
  }

  const softwareId = String((req.body && req.body.software_id) || d.pclink_software_id || '').trim();
  if (!/^\d{10,11}$/.test(softwareId)) {
    return fail(res, 'Hugin entegrasyon sözleşmenizdeki VKN gerekli (10-11 hane).', 400,
      { code: 'SOFTWARE_ID_REQUIRED' });
  }
  const hardwareId = String((req.body && req.body.hardware_id) || d.pclink_hardware_id
    || require('../fiscal/adapters/hugin').primaryMac() || '').trim();
  if (!hardwareId) {
    return fail(res, 'Bu bilgisayarın MAC adresi okunamadı; Donanım kimliğini elle girin.', 400,
      { code: 'HARDWARE_ID_REQUIRED' });
  }

  /* An already-paired device is a deliberate, confirmed change. */
  if (d.pclink_cert_sha256 && String(req.body.confirm_serial || '').toUpperCase()
        !== String(d.serial_number || '').toUpperCase()) {
    return fail(res, 'Bu cihaz zaten eşleşmiş. Yeniden eşleştirmek için seri numarasını yazın.',
      409, { code: 'CONFIRMATION_REQUIRED' });
  }

  const { HuginPcLinkAdapter } = require('../fiscal/adapters/hugin');
  const adapter = new HuginPcLinkAdapter({
    ...d,
    device_ip: (req.body && req.body.device_ip) || d.device_ip,
    device_port: (req.body && req.body.device_port) || d.device_port || 4443,
    pclink_software_id: softwareId,
    pclink_hardware_id: hardwareId,
    pclink_cert_sha256: null,          // pairing is where the pin is LEARNED
    serial_number: null,
  });

  /* Pairing is the exchange most worth having a record of: it is where the
     device tells us its serial, its firmware and its certificate. */
  if (fiscal.attachLog) fiscal.attachLog(adapter, req.clientId, d);

  let paired;
  try { paired = await adapter.pair(); }
  catch (e) {
    log.warn('okc', 'Hugin eşleşmesi başarısız', { device: id, code: e.code, message: e.message });
    return fail(res, e.message, e.status || 502, { code: e.code || 'PAIR_FAILED' });
  }

  /*
   * The device's own settings are kept, verbatim.
   *
   * `adapter.pair()` has always returned them - GET /v1/settings is the
   * pairing call - and this route threw them away. They are the only place the
   * till ever learns what the device itself says about its limits, its fiscal
   * licence period and its configured VAT and department tables, and they
   * cannot be re-read once the device is in normal service without another
   * round trip.
   *
   * Stored as the raw JSON the device sent, with no invented column schema on
   * top. We do not know every key HUGIN puts in there and guessing one would
   * produce a field labelled "Lisans bitişi" containing whatever happened to
   * be in a similarly-named property. The kayıt defteri screen renders whatever
   * is actually there and names it as the device named it.
   */
  let settingsJson = null;
  try {
    settingsJson = paired.settings ? JSON.stringify(paired.settings).slice(0, 60000) : null;
  } catch (_) { settingsJson = null; }

  await db.exec(
    `UPDATE fiscal_devices
        SET serial_number=?, serial_raw=?, pclink_software_id=?, pclink_hardware_id=?,
            pclink_cert_sha256=?, pclink_cert_subject=?, pclink_sfa_version=?,
            pclink_settings_json=?, pclink_settings_at=NOW(),
            pclink_paired_at=NOW(), device_ip=?, device_port=?
      WHERE id=? AND client_id=?`,
    [paired.serialNo, paired.serialNo, softwareId, hardwareId,
     paired.certSha256, paired.certSubject, paired.sfaVersion, settingsJson,
     adapter.host, adapter.port, id, req.clientId]);

  log.info('okc', 'Hugin cihazı eşleşti', {
    device: id, serial: paired.serialNo, sfa: paired.sfaVersion,
    by: req.auth && req.auth.uid });

  /*
   * Pairing is NOT permission to trade. production_enabled and the capability
   * profile are untouched here on purpose: the device now answers us, which is
   * a different and much smaller claim than "this device may print a legal
   * receipt for money".
   */
  ok(res, {
    id,
    serial_number: paired.serialNo,
    sfa_version: paired.sfaVersion,
    cert_sha256: paired.certSha256,
    cert_subject: paired.certSubject,
    production_enabled: !!d.production_enabled,
    note: 'Eşleşme tamamlandı. Üretime açmak ayrı bir adımdır ve yetenek kanıtı ister.',
  });
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
  /*
   * wire_verified is a GMP-3 gate, not a universal one. gmp3.js refuses to put
   * a message on the wire without it; hugin.js never reads it, because PC Link
   * is a documented HTTPS API and its own certificate pin is the check that
   * matters there.
   *
   * Reporting one sentence for both brands was actively misleading: a paired,
   * answering HUGIN S1 was told "simülatör dışında çalışmaz", which is false
   * and sends somebody hunting for a switch that does not gate their device.
   * So the check now says what the flag does FOR THIS BRAND.
   */
  const WIRE_GATED = ['ingenico', 'worldline', 'pavo', 'profilo', 'propay'];
  const wireGates = WIRE_GATED.includes(String(d.provider || '').toLowerCase());
  checks.push({ name: 'Mesaj katmanı doğrulandı', device_effect: false,
    pass: !!d.wire_verified || !wireGates,
    detail: d.wire_verified ? 'wire_verified = 1'
      : wireGates
        ? 'Üretici ECR/GMP-3 dokümanı ile doğrulanmadı; simülatör dışında çalışmaz'
        : `${d.provider} bu bayrağı kullanmaz — mesaj katmanı sürücünün kendi `
          + 'sözleşmesiyle belirlenir (PC Link: sertifika sabitleme). Satışı engellemez.' });
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
    const a = fiscal.adapterFor ? fiscal.adapterFor(d, { clientId: req.clientId }) : null;
    adapter = a && a.describe ? await a.describe() : null;
  } catch (e) { adapter = { error: e.code || e.message }; }

  ok(res, {
    device: { id, serial: d.serial_number, provider: d.provider },
    checks, adapter,
    ran_device_side_commands: false,
  });
}));

module.exports = r;
