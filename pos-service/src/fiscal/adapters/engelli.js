'use strict';
/**
 * Blocked adapters — one per fiscal owner, and every one of them refuses.
 *
 * WHY THESE EXIST AT ALL. A restaurant with a PAYGO or an NCR must be able to
 * commission it, see its real name, and be told plainly that NOKTApp cannot
 * transact with it yet. The alternative — the device simply not appearing —
 * looks like a bug and invites somebody to pick a nearby brand instead, which
 * is how a till ends up sending Token commands to a Worldline terminal.
 *
 * WHAT THEY MUST NEVER DO. Return success. Emit a payment confirmation. Touch
 * the device. Create a fiscal document. An adapter with no obtained SDK
 * returns SDK_NOT_OBTAINED, before dispatch, with zero device-side effects.
 * Naming a class after a manufacturer is not an integration, and this file
 * exists so that nobody can mistake one for the other.
 *
 * HOW ONE BECOMES REAL. Obtain the versioned SDK or protocol package and the
 * contract, implement the real adapter, prove it against hardware, record the
 * capability evidence, then remove that owner from BLOCKED below. Not before.
 */
const { FiscalAdapter } = require('./base');

/** Every fiscal owner in the GİB retail register, and why it is blocked. */
const BLOCKED = {
  vera:       { name: 'VERA (MT Bilgi Teknolojileri)',  reason: 'SDK ve sözleşme alınmadı' },
  edata:      { name: 'E DATA / Profilo / Propay',       reason: 'SDK ve sözleşme alınmadı' },
  pavo:       { name: 'PAVO',                            reason: 'SDK ve sözleşme alınmadı' },
  mikrosaray: { name: 'Mikrosaray / inPOS',              reason: 'SDK ve sözleşme alınmadı' },
  infoteks:   { name: 'Infoteks / Fusions',              reason: 'SDK ve sözleşme alınmadı' },
  worldline:  { name: 'Worldline',                       reason: 'Harici satış SDK matrisi alınmadı' },
  panaroma:   { name: 'Panaroma / Olivetti',             reason: 'SDK ve sözleşme alınmadı' },
  enpos:      { name: 'EnPOS',                           reason: 'SDK ve sözleşme alınmadı' },
  ncr:        { name: 'NCR',                             reason: 'SDK ve sözleşme alınmadı' },
  toshiba:    { name: 'Toshiba Global Commerce',         reason: 'SDK ve sözleşme alınmadı' },
  payport:    { name: 'PayPort',                         reason: 'SDK ve sözleşme alınmadı' },
  paygo:      { name: 'PAYGO',                           reason: 'SDK alınmadı; V02 kayıt çakışması çözülmedi' },
  payera:     { name: 'Payera',                          reason: 'V12: portal sözleşmesi P10 mali akışını kapsıyor mu belirsiz' },
  // Fuel-pump owners: a different domain entirely, never offered here.
  turpak:     { name: 'Turpak',  reason: 'Akaryakıt alanı — ayrı şartname gerekir' },
  mepsan:     { name: 'Mepsan',  reason: 'Akaryakıt alanı — ayrı şartname gerekir' },
};

/**
 * Owners with a documented route that we have STARTED, but whose message layer
 * is still unproven. They are not in BLOCKED because the GMP-3 client exists;
 * they are gated by fiscal_devices.wire_verified instead (see gmp3.js).
 */
const IN_PROGRESS = ['token', 'hugin'];

function unavailable(ownerKey, op) {
  const info = BLOCKED[ownerKey] || { name: ownerKey, reason: 'Adaptör tanımlı değil' };
  const e = new Error(
    `${info.name}: ${op} yapılamaz. ${info.reason}. ` +
    'Üretici entegrasyon paketi alındığında bu cihaz açılır.');
  e.status = 501;
  e.code = 'SDK_NOT_OBTAINED';
  e.ownerKey = ownerKey;
  e.deviceEffects = 'none';
  return e;
}

class BlockedAdapter extends FiscalAdapter {
  constructor(device, ownerKey) {
    super(device);
    this.ownerKey = ownerKey || String(device.provider || '').toLowerCase();
  }
  get name() { return `blocked:${this.ownerKey}`; }

  /* ---- read-only, safe, never touches the device --------------------- */

  async describe() {
    const info = BLOCKED[this.ownerKey] || { name: this.ownerKey, reason: 'Adaptör tanımlı değil' };
    return {
      ownerKey: this.ownerKey,
      vendor: info.name,
      implementationState: 'design_only',
      productionEnabled: false,
      blockedReason: info.reason,
      capabilities: [],          // nothing is VERIFIED; the profile stays UNKNOWN
    };
  }

  async inspectDevice() {
    return { reachable: null, note: 'Bu adaptör cihaza bağlanmaz.', deviceEffects: 'none' };
  }

  /* ---- everything that could move money or paper -------------------- */

  async prepare()      { throw unavailable(this.ownerKey, 'İşlem hazırlama'); }
  async dispatch()     { throw unavailable(this.ownerKey, 'Mali işlem'); }
  async queryOutcome() { throw unavailable(this.ownerKey, 'Sonuç sorgulama'); }
  async resume()       { throw unavailable(this.ownerKey, 'İşlemi sürdürme'); }
  async cancel()       { throw unavailable(this.ownerKey, 'İptal'); }
  async startSale()    { throw unavailable(this.ownerKey, 'Satış'); }
  async pollSale()     { throw unavailable(this.ownerKey, 'Satış takibi'); }
  async refund()       { throw unavailable(this.ownerKey, 'İade'); }
  async zReport()      { throw unavailable(this.ownerKey, 'Z raporu'); }
}

/** Build the ADAPTERS entries so index.js does not list fifteen classes. */
function blockedAdapters() {
  const out = {};
  for (const key of Object.keys(BLOCKED)) {
    out[key] = class extends BlockedAdapter {
      constructor(device, o) { super(device, key, o); }
    };
  }
  return out;
}

module.exports = { BLOCKED, IN_PROGRESS, BlockedAdapter, blockedAdapters, unavailable };
