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
 * Owners we have started on. Not in BLOCKED, and not finished either.
 */
const IN_PROGRESS = ['token', 'hugin', 'profilo'];

/**
 * WHERE EACH STARTED PROTOCOL CAME FROM.
 *
 * "In progress" covers two states that must never be confused, and the day
 * Hugin's real documentation arrived is the day collapsing them became
 * dangerous:
 *
 *   vendor_documented — every endpoint, header and field is quoted from the
 *                       manufacturer's own published protocol. Hugin publishes
 *                       PC Link openly; adapters/hugin.js is written to it.
 *   designed_guess    — the framing and command names are MINE, written to a
 *                       plausible shape because no specification was in hand.
 *                       adapters/gmp3.js says so at the top of the file.
 *
 * Neither one means a device has ever answered. `deviceProven` is the separate
 * fact, and it is false for all of them: reading a specification correctly and
 * having a terminal print a legal receipt are different claims, and only the
 * second one is worth anything to a restaurant being audited.
 *
 * `contract` is the third, legal fact. GİB's GMP regulation requires a signed
 * integration agreement between the sales software and the manufacturer before
 * any of this may touch a production device, so a perfect adapter with no
 * contract is still not allowed to trade.
 */
const PROTOCOL_SOURCE = {
  hugin: {
    source: 'vendor_documented',
    ref: 'developer.hugin.com.tr — PC Link API v1 (okundu 2026-09-21)',
    transport: 'HTTPS REST :4443',
    deviceProven: false,
    contract: 'required_not_signed',
    note: 'Iptal / iade / X-Z uc noktalari Postman referansinda; henuz elimizde degil.',
  },
  token: {
    source: 'designed_guess',
    ref: null,
    transport: 'TCP :7600 (varsayim)',
    deviceProven: false,
    contract: 'required_not_signed',
    note: 'Cerceveleme ve komut adlari tasarim; uretici dokumani alinmadi.',
  },
  profilo: {
    source: 'designed_guess',
    ref: null,
    transport: 'TCP :7500 (varsayim)',
    deviceProven: false,
    contract: 'required_not_signed',
    note: 'Hugin firmware oldugu VARSAYILIYORDU; dogrulanmadi, PC Link iddia edilmiyor.',
  },
};

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

module.exports = { BLOCKED, IN_PROGRESS, PROTOCOL_SOURCE, BlockedAdapter, blockedAdapters, unavailable };
