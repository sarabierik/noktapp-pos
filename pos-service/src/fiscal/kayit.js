'use strict';
/**
 * The GİB device registry, and how a real terminal is matched to it.
 *
 * WHAT THIS IS. The list of Yeni Nesil ÖKC models GİB publishes, seeded by
 * database/migrations/2026-09-22-okc-kayit-defteri.sql. A cashier commissioning
 * a device picks their actual model from this list instead of typing a name
 * into a box.
 *
 * WHAT THIS IS NOT. A compatibility list. A row here says the device exists in
 * the official register. It says nothing about whether NOKTApp can transact
 * with it. That question is answered by the capability profile and by
 * fiscal_devices.production_enabled, which starts at 0 for every device ever
 * commissioned.
 *
 * PREFIX MATCHING. The fiscal serial carries a registered prefix. Matching is
 * LONGEST PREFIX FIRST and never on the first character alone: BCA (Profilo
 * VeriFone) and BCM (Propay P1000) are different devices, and so are FV and
 * FS. An ambiguous or unknown prefix is refused at commissioning time rather
 * than resolved to whichever row happens to sort first.
 *
 * SAME HARDWARE, TWO OWNERS. Ingenico iWE280/iDE280 appear under PAVO (JH/JI)
 * and under Worldline (2A/2B). They are separate records on purpose. They must
 * not share credentials and must not automatically share an adapter.
 */
const db = require('../db');

/** Serial as the operator typed it -> the shape we match on. */
function normalizeSerial(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function all(clientId = null, { includeFuel = false } = {}) {   // eslint-disable-line no-unused-vars
  const rows = await db.query(
    `SELECT id, fiscal_owner, owner_key, brand_model, prefix, fiscal_class,
            device_os, category, evidence_kind, rollout_blocked, note
       FROM fiscal_registry_devices
      ${includeFuel ? '' : "WHERE category='retail'"}
      ORDER BY fiscal_owner, brand_model`);
  return rows;
}

/** One record by its id, or null. */
async function byId(id) {
  return db.one(
    `SELECT * FROM fiscal_registry_devices WHERE id=?`, [Number(id) || 0]);
}

/**
 * Match a fiscal serial to exactly one registry record.
 *
 * Returns { record, prefix } on a clean single match. Throws with a specific
 * code otherwise — the caller must never fall back to "probably this one".
 */
async function matchSerial(rawSerial) {
  const serial = normalizeSerial(rawSerial);
  if (serial.length < 3) {
    const e = new Error('Mali seri numarasi cok kisa'); e.status = 400; e.code = 'SERIAL_TOO_SHORT'; throw e;
  }
  // Longest registered prefix first. The registry's own prefixes are the only
  // candidates; we never invent one from the serial.
  const rows = await db.query(
    `SELECT id, prefix, brand_model, fiscal_owner, owner_key, category, rollout_blocked
       FROM fiscal_registry_devices
      WHERE ? LIKE CONCAT(prefix, '%')
      ORDER BY CHAR_LENGTH(prefix) DESC`, [serial]);

  if (!rows.length) {
    const e = new Error(`Bu mali seri hicbir kayitli cihaza uymuyor: ${serial}`);
    e.status = 400; e.code = 'PREFIX_UNKNOWN'; throw e;
  }
  // Two records with the SAME length prefix both matching is a genuine
  // ambiguity: refuse it rather than pick one.
  const top = rows[0];
  const tied = rows.filter(r => r.prefix.length === top.prefix.length);
  if (tied.length > 1) {
    const e = new Error(
      `Bu seri birden fazla kayitli cihaza uyuyor (${tied.map(t => t.prefix).join(', ')}). ` +
      'Cihazi listeden elle secin.');
    e.status = 409; e.code = 'PREFIX_AMBIGUOUS'; e.candidates = tied; throw e;
  }
  if (top.rollout_blocked) {
    const e = new Error(`${top.brand_model} akaryakit alanina ait; bu urunde kullanilamaz.`);
    e.status = 400; e.code = 'CATEGORY_BLOCKED'; throw e;
  }
  return { record: top, prefix: top.prefix, serial };
}

/**
 * Commission a device: bind a fiscal_devices row to a registry record.
 *
 * production_enabled is NOT set here. Commissioning establishes identity;
 * enabling financial execution is a separate, audited action that requires
 * capability evidence.
 */
async function commission(clientId, deviceId, rawSerial, { registryDeviceId = null } = {}) {
  let rec, prefix, serial;
  if (registryDeviceId) {
    rec = await byId(registryDeviceId);
    if (!rec) { const e = new Error('Kayitli cihaz bulunamadi'); e.status = 404; throw e; }
    serial = normalizeSerial(rawSerial);
    if (serial && !serial.startsWith(rec.prefix)) {
      const e = new Error(
        `Secilen cihazin prefixi ${rec.prefix}, girilen seri ise ${serial} ile basliyor. ` +
        'Seri numarasini veya cihaz secimini duzeltin.');
      e.status = 400; e.code = 'PREFIX_MISMATCH'; throw e;
    }
    prefix = rec.prefix;
  } else {
    ({ record: rec, prefix, serial } = await matchSerial(rawSerial));
  }

  await db.exec(
    `UPDATE fiscal_devices
        SET registry_device_id=?, fiscal_prefix=?, serial_raw=?, serial_number=?,
            provider=?, device_model=?, production_enabled=0, updated_at=NOW()
      WHERE id=? AND client_id=?`,
    [rec.id, prefix, String(rawSerial || ''), serial, rec.owner_key, rec.brand_model, deviceId, clientId]);

  await db.exec(
    `INSERT INTO fiscal_device_ownership (fiscal_device_id, client_id, fencing_sequence)
     VALUES (?,?,0) ON DUPLICATE KEY UPDATE client_id=VALUES(client_id)`, [deviceId, clientId]);

  return { registry: rec, prefix, serial, production_enabled: 0 };
}

module.exports = { all, byId, matchSerial, commission, normalizeSerial };
