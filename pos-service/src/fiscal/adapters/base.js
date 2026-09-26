'use strict';
/**
 * Every ÖKC (Yeni Nesil Ödeme Kaydedici Cihaz) adapter implements this contract.
 * The till never talks to a device directly - it always goes through the fiscal
 * module, which picks the adapter configured for the cash register.
 */
class FiscalAdapter {
  constructor(device, options = {}) {
    this.device = device;          // row from fiscal_devices
    this.options = options;
  }
  get name() { return 'base'; }

  /** Open a session with the device (pair / handshake). */
  async connect() { throw new Error('connect() not implemented'); }
  async disconnect() { return true; }

  /** Ask the device for its state: ready / busy / z_needed / offline. */
  async status() { throw new Error('status() not implemented'); }

  /**
   * Start a fiscal sale.
   * @param {object} sale {externalId, items[{name, qty, unitPriceMinor, vatRate, departmentNo}],
   *                       totalMinor, discountMinor, payment{method, amountMinor, installments}}
   * @returns {object} {providerSessionId, state}
   */
  async startSale(sale) { throw new Error('startSale() not implemented'); }

  /** Poll a running sale. Returns {state, receipt?, error?}. */
  async pollSale(providerSessionId) { throw new Error('pollSale() not implemented'); }

  /** Cancel a sale that has not been finalised on the device yet. */
  async cancelSale(providerSessionId) { throw new Error('cancelSale() not implemented'); }

  /** Refund / iade against a previous fiscal receipt. */
  async refund(refund) { throw new Error('refund() not implemented'); }

  /** Ask the device to take its X or Z report. */
  async report(kind) { throw new Error('report() not implemented'); }

  /**
   * Lines this protocol accepts on one receipt, or null if it does not say.
   *
   * null is a real answer and not a missing one: it means the orchestrator must
   * NOT refuse a basket up front on a number nobody published. Returning a
   * plausible figure here would put a made-up limit in front of real sales.
   */
  get maxSaleLines() { return null; }
}

/*
 * DEPARTMENTS AND VAT CODES ARE THE DEVICE'S, NOT OURS.
 *
 * This file used to carry `VAT_DEPARTMENTS = {0:1, 1:2, 8:3, 10:3, 18:4, 20:4}`
 * and map a rate to a department number in code. That was wrong twice over, and
 * on a fiscal device being wrong about the department is being wrong about the
 * VAT printed on a legal receipt:
 *
 *   1. A sale line does not carry a rate. It carries a DEPARTMENT index, and
 *      the department carries a VAT CODE, and the VAT code indexes the device's
 *      own VAT table. Three levels, all of them held on the device.
 *   2. Both tables are configurable per device and the POS pushes them down -
 *      the Ingenico settings screen says so in as many words: "Cihaz üzerinde
 *      bulunan kısım tanımları buradaki tanımlar ile güncellenir."
 *
 * So the tables live in `fiscal_vat_codes` and `fiscal_departments`, one set
 * per device, and this file only carries the DEFAULTS a device ships with -
 * read off a real Ingenico MOVE 5000F - and the resolver that walks them.
 */

/** What an Ingenico MOVE 5000F holds out of the box: code -> rate. */
const DEFAULT_VAT_CODES = [
  { vat_code: 0, rate: 0 },
  { vat_code: 1, rate: 1 },
  { vat_code: 2, rate: 10 },
  { vat_code: 3, rate: 20 },
  { vat_code: 4, rate: 20 },
  { vat_code: 5, rate: 20 },
  { vat_code: 6, rate: 20 },
  { vat_code: 7, rate: 20 },
];

/*
 * And its department table. Note erp_index is 1-based and okc_index is 0-based:
 * the device counts from zero and the ERP screen counts from one, so both are
 * written down rather than left to a +1 somebody will forget.
 */
const DEFAULT_DEPARTMENTS = Array.from({ length: 12 }, (_, i) => ({
  erp_index: i + 1,
  okc_index: i,
  name: 'KISIM' + (i + 1),
  vat_code: i <= 7 ? i : 3,
}));

/**
 * The department a line belongs in, from the tables THIS device holds.
 * Falls back to the department whose VAT code carries the same rate, because a
 * line whose rate has no department is a line that would be taxed wrongly, and
 * that must be an error the cashier sees rather than a silent default.
 */
function resolveDepartment(vatRate, { departments, vatCodes }) {
  const rate = Number(vatRate) || 0;
  const codes = (vatCodes || []).filter(c => Number(c.rate) === rate).map(c => Number(c.vat_code));
  const dep = (departments || []).find(d => codes.includes(Number(d.vat_code)));
  if (!dep) {
    const e = new Error(`%${rate} KDV icin OKC'de tanimli bir kisim yok - `
      + 'Ayarlar > OKC > Kisim Bilgileri ekranindan tanimlayin');
    e.status = 400;
    throw e;
  }
  return dep;
}

/*
 * Payment codes as the device numbers them. Read from a working installation's
 * payment mapping screen; they are not a bitmask despite 2048 looking like one.
 */
const PAYMENT_CODES = { CASH: 1, CARD: 4, TRANSFER: 2048 };

/*
 * Units the device knows. Anything the till cannot map travels as Adet, which
 * is the device's own documented fallback ("Eşleştirilmeyen birimler adet
 * olarak gönderilir") and not a guess of ours.
 */
const UNIT_CODES = { ADET: 'Adet', KG: 'Kilogram', GR: 'Gram', LT: 'Litre' };
function unitFor(name) {
  const n = String(name || '').trim().toLowerCase();
  if (['kg', 'kilo', 'kilogram'].includes(n)) return UNIT_CODES.KG;
  if (['g', 'gr', 'gram'].includes(n)) return UNIT_CODES.GR;
  if (['l', 'lt', 'litre', 'liter'].includes(n)) return UNIT_CODES.LT;
  return UNIT_CODES.ADET;
}

module.exports = { FiscalAdapter, resolveDepartment, unitFor,
  DEFAULT_VAT_CODES, DEFAULT_DEPARTMENTS, PAYMENT_CODES, UNIT_CODES };
