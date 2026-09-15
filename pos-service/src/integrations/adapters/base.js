'use strict';
/**
 * The one interface every platform is reached through.
 *
 * Four providers, and only two of them have a published specification we could
 * read. That is the normal state of this work - a partner signs you up, sends a
 * PDF, and half of what the PDF describes is not enabled for your account - so
 * the interface is built around NOT KNOWING rather than around a happy path.
 *
 * Every operation returns a RESULT OBJECT, never a bare value and never an
 * exception for "this platform does not do that":
 *
 *      { ok: true,  data }
 *      { ok: false, code, message, retryable }
 *
 * and an operation the platform does not support returns
 *
 *      { ok: false, code: 'CAPABILITY_NOT_SUPPORTED', message: '…' }
 *
 * predictably, immediately, without a network call. The screen greys the button
 * out from `capabilities()` rather than finding out by pressing it, and the
 * order pipeline can ask "can this platform be told the order is ready?" and
 * skip the step instead of parking a failed operation in the retry queue for
 * ever.
 *
 * `mode` is the other half. An adapter runs in one of three modes:
 *   simulator   - talks to src/integrations/simulator.js, no network at all.
 *                 This is what the tests use and what a restaurant sees before
 *                 the partner has issued credentials.
 *   stage       - the platform's own test environment.
 *   production   - live.
 * An adapter whose live paths are not verifiable from published documentation
 * answers `testConnection()` with code AWAITING_PARTNER_SPEC in stage and
 * production, and says exactly which operation is unverified. It does not
 * guess a URL.
 */

const CAPABILITIES = [
  'fetchOrders', 'receiveWebhook', 'verifyWebhook', 'getOrder',
  'accept', 'reject', 'markPreparing', 'markReady', 'markDispatched', 'markDelivered', 'cancel',
  'syncMenu', 'updateProductPrice', 'updateProductAvailability', 'updateCategoryAvailability',
  'setRestaurantOpen', 'updatePrepTime', 'testConnection', 'health',
];

/** Turkish labels, for the capability matrix on the Entegrasyonlar screen. */
const CAPABILITY_LABELS = {
  fetchOrders: 'Sipariş çekme',
  receiveWebhook: 'Webhook alma',
  verifyWebhook: 'Webhook imza doğrulama',
  getOrder: 'Sipariş detayı',
  accept: 'Onaylama (hazırlama süresiyle)',
  reject: 'Reddetme (onaylı sebep ile)',
  markPreparing: 'Hazırlanıyor bildirimi',
  markReady: 'Hazır bildirimi',
  markDispatched: 'Yola çıktı bildirimi',
  markDelivered: 'Teslim edildi bildirimi',
  cancel: 'İptal',
  syncMenu: 'Menü gönderme',
  updateProductPrice: 'Ürün fiyatı güncelleme',
  updateProductAvailability: 'Ürün açma/kapama',
  updateCategoryAvailability: 'Kategori açma/kapama',
  setRestaurantOpen: 'Restoranı açma/kapama',
  updatePrepTime: 'Hazırlama/teslim süresi',
  testConnection: 'Bağlantı testi',
  health: 'Bağlantı sağlığı',
};

function ok(data = {}) { return { ok: true, ...data }; }
function fail(code, message, { retryable = false, detail = null } = {}) {
  return { ok: false, code, message, retryable, detail };
}
function unsupported(op, why) {
  return {
    ok: false,
    code: 'CAPABILITY_NOT_SUPPORTED',
    message: why || `Bu platform "${CAPABILITY_LABELS[op] || op}" işlemini desteklemiyor.`,
    retryable: false,
    operation: op,
  };
}
function awaitingSpec(op, what) {
  return {
    ok: false,
    code: 'AWAITING_PARTNER_SPEC',
    message: what || `"${CAPABILITY_LABELS[op] || op}" için resmî uç nokta tanımı elimizde yok. ` +
      'Simülasyon kipinde çalışır; canlıya almak için iş ortağından uç nokta dokümanı gerekir.',
    retryable: false,
    operation: op,
  };
}

class BaseAdapter {
  /**
   * @param {object} conn  the np_int_connections row
   * @param {object} creds decrypted credentials - NEVER logged, never returned
   */
  constructor(conn, creds) {
    this.conn = conn || {};
    this.creds = creds || {};
    this.provider = this.conn.provider;
    this.mode = this.conn.environment || 'simulator';
    this.branchId = this.conn.branch_id || 1;
  }

  get simulated() { return this.mode === 'simulator'; }

  /** Which of CAPABILITIES this provider implements. Overridden per adapter. */
  capabilities() { return {}; }

  supports(op) { return !!this.capabilities()[op]; }

  /**
   * Every call goes through here, so an unsupported operation can never reach
   * the network and can never throw something unpredictable at the caller.
   */
  async call(op, args = {}) {
    if (!CAPABILITIES.includes(op)) return fail('UNKNOWN_OPERATION', 'Bilinmeyen işlem: ' + op);
    if (!this.supports(op)) return unsupported(op);
    const fn = this[op];
    if (typeof fn !== 'function') return unsupported(op);
    try {
      const out = await fn.call(this, args);
      return out || ok();
    } catch (e) {
      if (e && e.name === 'ProviderError') {
        return fail(e.kind === 'auth' ? 'INVALID_CREDENTIALS' : e.kind.toUpperCase(),
          e.message, { retryable: e.retryable, detail: e.body });
      }
      return fail('ADAPTER_ERROR', e.message || String(e), { retryable: true });
    }
  }

  /* Defaults: everything is unsupported until an adapter says otherwise. The
     base class deliberately does not implement a single operation, so a new
     adapter that forgets one degrades to a structured refusal rather than to
     `undefined is not a function` in the middle of the order pipeline. */
}

module.exports = { BaseAdapter, CAPABILITIES, CAPABILITY_LABELS, ok, fail, unsupported, awaitingSpec };
