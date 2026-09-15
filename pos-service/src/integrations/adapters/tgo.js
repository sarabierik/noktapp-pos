'use strict';
/**
 * UBER_EATS_TGO — Uber Eats Trendyol Go, yemek (meal) integration.
 *
 * This is the busiest of the four in a Turkish restaurant, and since the Uber
 * Eats transition it also carries GetirYemek-origin orders. Three source
 * applications arrive down the same pipe and they are NOT interchangeable:
 *
 *     Trendyol      classic Trendyol Yemek
 *     TrendyolGo    the Go app
 *     Galaxy        GetirYemek, now served by Uber Eats
 *
 * The kitchen slip, the report and the mirror row all keep the value verbatim,
 * because "why is this order commission-free" and "which platform do I ring
 * about the missing courier" are both answered by that one string. It is never
 * folded into "TGO".
 *
 * WHAT IS VERIFIED AND WHAT IS NOT
 * --------------------------------
 * developers.tgoapps.com serves a client-rendered documentation site; from this
 * environment every /docs/ path returns the landing shell, so no field name,
 * status value or header could be read from the source. What is implemented
 * here as REAL is therefore only:
 *
 *   - the polling endpoint, which is specified for this work:
 *       GET https://api.tgoapis.com/integrator/order/meal/suppliers/{supplierId}/packages
 *   - the transport rules that ARE specified: Basic auth, supplier id, API key
 *     and secret, a required User-Agent, separate stage and production
 *     configuration, 50 requests / 10 seconds / endpoint, incremental polling
 *     by modification time with an overlap window.
 *
 * Every other operation (accept, reject, status pushes, menu, availability) is
 * declared as a capability and routed through `path(op)`. A path that has not
 * been supplied - by the partner pack, through `creds.paths` - makes the
 * operation answer AWAITING_PARTNER_SPEC instead of guessing a URL. In
 * simulator mode all of them work end to end.
 */
const { BaseAdapter, ok, fail, awaitingSpec } = require('./base');
const httpc = require('../http');
const rate = require('../ratelimit');
const sim = require('../simulator');

const PRODUCTION_BASE = 'https://api.tgoapis.com';

/**
 * Only one path is known. The others are named so an operator can paste the
 * partner's value straight in (Entegrasyonlar > uç noktalar), and are empty
 * until they do.
 */
/*
 * The real endpoints, read from developers.tgoapps.com (8. Yemek Entegrasyonu
 * > Sipariş Entegrasyonu). Every one of these is published; none is guessed.
 *
 * Two of them - manual-shipped and manual-delivered - are for restaurants
 * delivering with their OWN couriers (deliveryType STORE, "model 1"). A
 * restaurant on the platform's courier (deliveryType GO, "model 2") must not
 * call them: the platform is moving the order and telling it otherwise is a
 * lie that shows up in the customer's app. `deliveryType` on the package is
 * what decides, and `action()` below checks it.
 */
const KNOWN_PATHS = {
  fetchOrders: '/integrator/order/meal/suppliers/{supplierId}/packages',
  getOrder: '/integrator/order/meal/suppliers/{supplierId}/packages/{packageId}',
  accept: '/integrator/order/meal/suppliers/{supplierId}/packages/picked',
  markReady: '/integrator/order/meal/suppliers/{supplierId}/packages/invoiced',
  markDispatched: '/integrator/order/meal/suppliers/{supplierId}/packages/{packageId}/manual-shipped',
  markDelivered: '/integrator/order/meal/suppliers/{supplierId}/packages/{packageId}/manual-delivered',
  reject: '/integrator/order/meal/suppliers/{supplierId}/packages/unsupplied',
  cancel: '/integrator/order/meal/suppliers/{supplierId}/packages/unsupplied',
};

/**
 * TGO's own package statuses, mapped onto the till's eight.
 *
 * The left-hand side is a best reading of the vocabulary the platform uses in
 * public and is CONFIGURABLE (`creds.statusMap`) precisely because it could not
 * be read from the specification. An unrecognised status is never guessed at:
 * it is stored verbatim in provider_status, the normalised status is left where
 * it was, and the sync log gets a warning naming the value - which is how the
 * restaurant finds out about a status the platform added last week.
 */
const DEFAULT_STATUS_MAP = {
  /* The seven the platform actually publishes. */
  Created: 'RECEIVED',
  Picking: 'ACCEPTED',       // we told them we accepted it
  Invoiced: 'READY',         // we told them it is prepared
  Shipped: 'DISPATCHED',     // on its way, by their courier or ours
  Delivered: 'DELIVERED',
  Cancelled: 'CANCELLED',    // cancelled by somebody other than the restaurant
  UnSupplied: 'REJECTED',    // cancelled BY the restaurant
};

/*
 * Restaurant-side cancellation reasons, from "Paket Modelleri".
 *
 * These are the only ids the unsupplied service accepts from us; the much
 * longer list of platform- and courier-side reasons is what they send BACK and
 * must never be quoted at them. 624 and 626 are model 1 only - a restaurant
 * delivering with the platform's courier cannot claim "no courier".
 */
const CANCEL_REASONS = {
  621: 'Tedarik problemi',
  622: 'Mağaza kapalı',
  623: 'Mağaza siparişi hazırlayamıyor',
  624: 'Yüksek yoğunluk / kurye yok (yalnızca kendi kuryesi olan restoran)',
  627: 'Sipariş karışıklığı',
  626: 'Alan dışı (yalnızca kendi kuryesi olan restoran)',
};
const DEFAULT_CANCEL_REASON = 623;

const SOURCE_APPLICATIONS = ['Trendyol', 'TrendyolGo', 'Galaxy'];

class TgoAdapter extends BaseAdapter {
  capabilities() {
    return {
      fetchOrders: true,
      receiveWebhook: false,        // TGO meal integration is polled, not pushed
      verifyWebhook: false,
      getOrder: true,
      accept: true,
      reject: true,
      markPreparing: true,
      markReady: true,
      markDispatched: true,
      markDelivered: true,
      cancel: true,
      syncMenu: true,
      updateProductPrice: true,
      updateProductAvailability: true,
      updateCategoryAvailability: true,
      setRestaurantOpen: true,
      updatePrepTime: true,
      testConnection: true,
      health: true,
    };
  }

  base() {
    if (this.mode === 'production') return this.creds.productionBase || PRODUCTION_BASE;
    return this.creds.stageBase || process.env.TGO_STAGE_BASE || '';
  }

  /** The configured path for an operation, or null when nobody has told us. */
  path(op) {
    const overrides = this.creds.paths || {};
    return overrides[op] || KNOWN_PATHS[op] || null;
  }

  statusMap() { return Object.assign({}, DEFAULT_STATUS_MAP, this.creds.statusMap || {}); }

  /**
   * The headers TGO requires. Basic auth over `apiKey:apiSecret`, the supplier
   * id, and a User-Agent the platform can identify us by - integrations that
   * send a default Node user agent are the ones that get blocked first.
   */
  /**
   * The headers TGO requires, all four of them, per developers.tgoapps.com
   * "2. Authorization" and the per-endpoint header tables.
   *
   *   Authorization    Basic over apiKey:apiSecretKey. Wrong or missing gives
   *                    401 ClientApiAuthenticationException.
   *   User-Agent       "{supplierId} - {integrator}" or "{supplierId} -
   *                    SelfIntegration". THIS IS NOT OPTIONAL: a request with
   *                    no User-Agent is refused with 403, which is a
   *                    particularly nasty failure to debug because it looks
   *                    like a permissions problem with the account. The
   *                    integrator name is alphanumeric, max 30 characters.
   *   x-agentname      the integrator's name.
   *   x-executor-user  the e-mail of the person the action is on behalf of.
   *                    It ends up in the platform's own audit trail, so it is
   *                    the restaurant's address and not ours.
   */
  headers() {
    const key = this.creds.apiKey || '';
    const secret = this.creds.apiSecret || '';
    const supplier = this.creds.supplierId || this.conn.supplier_id || '';
    /* Alphanumeric, 30 max - the platform rejects anything else. "NOKTApp POS"
       would fail on the space, so it is folded out here rather than left for
       a restaurant to discover at 20:30. */
    const agent = String(this.creds.integratorName || 'NOKTAppPOS')
      .replace(/[^A-Za-z0-9]/g, '').slice(0, 30) || 'NOKTAppPOS';
    return {
      Authorization: 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64'),
      'User-Agent': `${supplier} - ${agent}`,
      'x-agentname': agent,
      'x-executor-user': this.creds.executorUser || 'destek@noktapp.com',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async live(op, { method = 'GET', query = null, body = null, replace = {} } = {}) {
    const p = this.path(op);
    if (!p) return { spec: awaitingSpec(op) };
    const base = this.base();
    if (!base) {
      return { spec: fail('NOT_CONFIGURED',
        this.mode === 'stage'
          ? 'TGO test ortamı adresi tanımlı değil. İş ortağından aldığınız stage adresini girin.'
          : 'TGO adresi tanımlı değil.') };
    }
    let url = base + p;
    for (const [k, v] of Object.entries({ supplierId: this.creds.supplierId || this.conn.supplier_id,
      storeId: this.conn.provider_store_id, ...replace })) {
      url = url.replace('{' + k + '}', encodeURIComponent(String(v == null ? '' : v)));
    }
    if (query) {
      const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== null && v !== undefined && v !== ''));
      if (String(qs)) url += '?' + qs;
    }
    // the documented limit is per endpoint, so the bucket is keyed by the path
    // template and not by the provider
    await rate.take('TGO:' + p, { limit: 50, windowMs: 10000 });
    const res = await httpc.request(url, { method, headers: this.headers(), body, timeout: 15000, area: 'entegrasyon' });
    return { res };
  }

  /* ----------------------------------------------------------- orders */

  /**
   * Supplier-wide, incremental by modification time.
   *
   * `since` comes from np_int_cursors with the overlap already subtracted, so
   * this function has no memory of its own and a restart cannot skip a window.
   */
  async fetchOrders({ since = null, storeIds = null, statuses = null, size = 200 } = {}) {
    if (this.simulated) {
      const rows = sim.packages(this.provider, {
        supplierId: this.creds.supplierId || this.conn.supplier_id, since, storeIds, statuses });
      return ok({ orders: rows.map(r => this.normalize(r)), raw: rows });
    }
    /*
     * The documented query, and its limits. `size` is capped at 50 by the
     * platform - asking for 200 is not "more per page", it is a 400 - and the
     * dates are epoch MILLISECONDS, not ISO strings. `storeId` is optional
     * and omitted so one poll covers every branch under the supplier, which
     * is the whole reason this integration is supplier-wide.
     */
    const { spec, res } = await this.live('fetchOrders', {
      query: {
        storeId: (storeIds && storeIds.length === 1) ? storeIds[0] : undefined,
        packageStatuses: statuses && statuses.length ? statuses.join(',') : undefined,
        packageModificationStartDate: since ? toEpochMs(since) : undefined,
        size: Math.min(50, Number(size) || 50),
      },
      replace: { supplierId: this.creds.supplierId || this.conn.supplier_id },
    });
    if (spec) return spec;
    const list = Array.isArray(res.body) ? res.body
      : (res.body && (res.body.content || res.body.packages || res.body.data)) || [];
    return ok({ orders: list.map(r => this.normalize(r)), raw: list });
  }

  async getOrder({ externalOrderId, externalPackageId }) {
    if (this.simulated) {
      const rec = sim.detail(this.provider, externalOrderId, externalPackageId);
      return rec ? ok({ order: this.normalize(rec), raw: rec })
        : fail('NOT_FOUND', 'Sipariş platformda bulunamadı');
    }
    const { spec, res } = await this.live('getOrder', { replace: { orderId: externalOrderId, packageId: externalPackageId } });
    if (spec) return spec;
    return ok({ order: this.normalize(res.body), raw: res.body });
  }

  async action(op, args) {
    if (this.simulated) {
      const r = sim.action(this.provider, op, {
        orderId: args.externalOrderId, packageId: args.externalPackageId,
        prepMinutes: args.prepMinutes, reason: args.reason });
      return r.ok ? ok({ providerStatus: r.providerStatus }) : fail('NOT_FOUND', 'Sipariş platformda bulunamadı');
    }
    /*
     * "Yola çıktı" and "teslim edildi" belong to the restaurant only when the
     * restaurant is carrying it. On a model 2 order the platform's own courier
     * is moving the food and its app is telling the guest so; sending
     * manual-shipped there would be us claiming to have done something we did
     * not, in the customer's app. So it is refused here rather than by them.
     */
    if (args.ownCourierOnly && String(args.deliveryType || '').toUpperCase() === 'GO') {
      return ok({ skipped: true,
        reason: 'Bu sipariş platform kuryesiyle taşınıyor; taşıma durumunu platform bildirir.' });
    }
    const { spec, res } = await this.live(op, {
      method: args.method || 'PUT',
      replace: {
        orderId: args.externalOrderId,
        packageId: args.externalPackageId,
        supplierId: this.creds.supplierId || this.conn.supplier_id,
      },
      body: args.body || {},
    });
    if (spec) return spec;
    return ok({ response: res.body });
  }

/** ISO or Date to the epoch milliseconds the platform's date filters want. */


  /*
   * The bodies the platform documents. Every one is addressed by packageId,
   * and the three that carry `actualDate` want epoch milliseconds.
   *
   * There is NO "preparing" endpoint: the platform has Created → Picking →
   * Invoiced → Shipped → Delivered, and "we have started cooking" is not one
   * of them. markPreparing is therefore a local no-op rather than a call that
   * would 404 - the board still moves, the platform simply is not told
   * something it has no state for.
   */
  accept(a) {
    return this.action('accept', { ...a, method: 'PUT', body: {
      packageId: a.externalPackageId,
      preparationTime: Number(a.prepMinutes || this.conn.default_prep_minutes || 20),
    } });
  }
  markReady(a) {
    return this.action('markReady', { ...a, method: 'PUT', body: {
      packageId: a.externalPackageId, actualDate: Date.now(),
    } });
  }
  markDispatched(a) {
    return this.action('markDispatched', { ...a, method: 'PUT', ownCourierOnly: true,
      body: { actualDate: Date.now() } });
  }
  markDelivered(a) {
    return this.action('markDelivered', { ...a, method: 'PUT', ownCourierOnly: true,
      body: { actualDate: Date.now() } });
  }
  async markPreparing(a) {
    if (this.simulated) return this.action('markPreparing', a);
    return ok({ skipped: true,
      reason: 'Uber Eats Trendyol Go bu ara durumu tutmuyor; sipariş kabul edildi olarak kalır.' });
  }
  reject(a) { return this.unsupply(a); }
  cancel(a) { return this.unsupply(a); }

  /**
   * Cancellation, ours. One endpoint for both, because the platform has one.
   *
   * `itemIdList` decides whether it is the whole order or part of it: every
   * packageItemId means a full cancellation, a subset means the rest is still
   * coming. `reasonId` must be one the RESTAURANT is allowed to use - the long
   * list of courier and platform reasons is what they send us, and quoting one
   * of those back is rejected.
   */
  unsupply(a = {}) {
    /*
     * Our reason, mapped onto one of THEIRS.
     *
     * The till's own cancel codes are words a Turkish cashier picks from a
     * list; the platform accepts six numbers and rejects anything else,
     * including the much longer list of reasons IT sends US. Sending the
     * fallback for everything - which is what happened before this map
     * existed - reported every cancellation as "the kitchen could not
     * prepare it", which is both untrue and the one reason a platform
     * penalises a restaurant for.
     *
     * 624 and 626 are model 1 only: a restaurant on the platform's courier
     * cannot claim "no courier" or "out of area", so those fall back rather
     * than being refused at the door.
     */
    const ownCourier = String(a.deliveryType || '').toUpperCase() === 'STORE'
      || a.fulfillmentType === 'RESTAURANT_COURIER';
    const FROM_TILL = {
      MUTFAK: 623,             // mutfak yetiştiremedi -> mağaza hazırlayamıyor
      ODEME_YOK: 627,          // müşteri ödemedi      -> sipariş karışıklığı
      SAHTE: 627,
      MUSTERI_VAZGECTI: 627,
      ADRES_BULUNAMADI: ownCourier ? 626 : 623,
      KURYE_YOK: ownCourier ? 624 : 623,
      KAPALI: 622,
      STOK: 621,
    };
    let reasonId = Number(a.reasonId || 0);
    if (!reasonId && a.reasonCode) reasonId = FROM_TILL[String(a.reasonCode).toUpperCase()] || 0;
    if (!reasonId && /^\d+$/.test(String(a.reasonCode || ''))) reasonId = Number(a.reasonCode);
    if (!CANCEL_REASONS[reasonId]) reasonId = DEFAULT_CANCEL_REASON;
    /* a model 2 restaurant may not use the model 1 reasons */
    if (!ownCourier && (reasonId === 624 || reasonId === 626)) reasonId = DEFAULT_CANCEL_REASON;
    return this.action('reject', { ...a, method: 'PUT', body: {
      packageId: a.externalPackageId,
      itemIdList: Array.isArray(a.itemIdList) && a.itemIdList.length ? a.itemIdList.map(String) : undefined,
      reasonId,
    } });
  }

  /* ------------------------------------------------------------ menu */

  async syncMenu({ catalogue }) {
    if (this.simulated) return ok(sim.submitMenu(this.provider, this.conn.provider_store_id, catalogue));
    const { spec, res } = await this.live('syncMenu', { method: 'POST', body: catalogue });
    if (spec) return spec;
    return ok({ response: res.body });
  }

  async updateProductPrice({ items }) {
    if (this.simulated) { sim.calls(this.provider); return ok({ updated: items.length }); }
    const { spec, res } = await this.live('updateProductPrice', { method: 'POST', body: { items } });
    if (spec) return spec;
    return ok({ response: res.body });
  }

  async updateProductAvailability({ items }) {
    if (this.simulated) return ok({ updated: items.length });
    const { spec, res } = await this.live('updateProductAvailability', { method: 'POST', body: { items } });
    if (spec) return spec;
    return ok({ response: res.body });
  }

  async updateCategoryAvailability({ items }) {
    if (this.simulated) return ok({ updated: items.length });
    const { spec, res } = await this.live('updateCategoryAvailability', { method: 'POST', body: { items } });
    if (spec) return spec;
    return ok({ response: res.body });
  }

  async setRestaurantOpen({ open }) {
    if (this.simulated) return ok(sim.setOpen(this.provider, this.conn.provider_store_id, open));
    const { spec, res } = await this.live('setRestaurantOpen', { method: 'POST', body: { status: open ? 'OPEN' : 'CLOSED' } });
    if (spec) return spec;
    return ok({ response: res.body });
  }

  async updatePrepTime({ minutes }) {
    if (this.simulated) return ok(sim.setPrep(this.provider, this.conn.provider_store_id, minutes));
    const { spec, res } = await this.live('updatePrepTime', { method: 'POST', body: { preparationTime: minutes } });
    if (spec) return spec;
    return ok({ response: res.body });
  }

  /* ---------------------------------------------------------- health */

  async testConnection() {
    /*
     * Even in simulation the test button has to TEST something. Returning a
     * cheerful "hazır" without touching the adapter meant the one button whose
     * whole job is to say whether this works answered yes unconditionally.
     */
    if (this.simulated) {
      const probe = await this.fetchOrders({ size: 1 });
      if (!probe.ok) return probe;
      return ok({ mode: 'simulator',
        message: 'Simülasyon kipinde bağlantı hazır. Canlı için tedarikçi kimliği ve API anahtarı gerekir.' });
    }
    if (!this.creds.apiKey || !this.creds.apiSecret || !(this.creds.supplierId || this.conn.supplier_id)) {
      return fail('INVALID_CREDENTIALS', 'Tedarikçi kimliği, API anahtarı ve API gizli anahtarı zorunludur.');
    }
    const r = await this.fetchOrders({ size: 1 });
    if (!r.ok) return r;
    return ok({ mode: this.mode, message: 'Paket listesi okundu.' });
  }

  async health() {
    return ok({
      mode: this.mode,
      rateRemaining: rate.remaining('TGO:' + KNOWN_PATHS.fetchOrders),
      verifiedOperations: Object.keys(KNOWN_PATHS),
      unverifiedOperations: Object.keys(this.capabilities())
        .filter(op => this.capabilities()[op] && !this.path(op) && !['testConnection', 'health', 'receiveWebhook', 'verifyWebhook'].includes(op)),
    });
  }

  /* ------------------------------------------------------- normalise */
  /**
   * The ONE place that knows the platform's field names - and now it knows
   * the real ones.
   *
   * Written against the published payload on developers.tgoapps.com
   * (Sipariş Paketlerini Çekme). The alternative spellings are kept underneath
   * as a safety net for a field the platform renames, but the first candidate
   * in each list is the documented name.
   *
   * THREE THINGS THIS GETS RIGHT THAT A GUESS DOES NOT:
   *
   * 1. `id` IS THE PACKAGE ID. Every action endpoint - picked, invoiced,
   *    manual-shipped, manual-delivered, unsupplied - is addressed by it, and
   *    it is a 64 character string, not the order id. Reading `orderId` into
   *    it would make every status push 404.
   *
   * 2. QUANTITY IS THE LENGTH OF `items`. A line is one PRODUCT, and each
   *    entry in its `items` array is one unit of it, carrying its own
   *    packageItemId. Two Big King menus are one line with two items, and
   *    reading qty as 1 would under-charge and under-cook every multiple
   *    order. The packageItemIds are kept because partial cancellation is
   *    addressed by them.
   *
   * 3. THE ADDRESS IS BUILT, NOT FOUND. There is no "fullAddress" field: the
   *    guest's door is spread across address1, neighbourhood, district,
   *    apartment, floor, door number and a free-text description, and the
   *    courier needs all of it in one line.
   */
  normalize(p) {
    if (!p) return null;
    const pick = (...names) => {
      for (const n of names) {
        const v = n.split('.').reduce((o, k) => (o == null ? o : o[k]), p);
        if (v !== undefined && v !== null && v !== '') return v;
      }
      return null;
    };
    const providerStatus = String(pick('packageStatus', 'providerStatus', 'status') || '');
    const src = pick('userInformation.appName', 'sourceApplication', 'appName');

    /* One line per product, quantity from the units inside it. */
    const lines = (pick('lines', 'items', 'orderLines') || []).map((l, i) => {
      const units = Array.isArray(l.items) ? l.items.filter(u => !u.isCancelled) : [];
      const allUnits = Array.isArray(l.items) ? l.items : [];
      const qty = units.length || Number(l.qty || l.quantity || 1) || 1;
      return {
        /* The FIRST unit's id addresses the line; the whole list is carried
           because unsupplied takes an itemIdList and a partial cancellation
           names the units being dropped. */
        externalItemId: String((allUnits[0] && (allUnits[0].packageItemId || allUnits[0].lineItemId))
          || l.externalItemId || l.lineId || l.id || ('L' + (i + 1))),
        packageItemIds: allUnits.map(u => String(u.packageItemId || u.lineItemId)).filter(Boolean),
        externalProductId: String(l.productId || l.externalProductId || l.productCode || l.barcode || ''),
        name: l.name || l.productName || 'Ürün',
        qty,
        /* unitSellingPrice is what one of them cost; `price` is the line. */
        unitPrice: Number(l.unitSellingPrice !== undefined ? l.unitSellingPrice
          : (l.unitPrice !== undefined ? l.unitPrice : (l.price || 0))) || 0,
        cancelled: allUnits.length > 0 && units.length === 0,
        note: l.description || l.note || null,
        modifiers: flattenModifiers(l.modifierProducts || l.modifiers || l.toppings || []),
        /* Removed ingredients are a modifier with `removed` set, so the slip
           says "Çıkar: soğan" instead of silently dropping it. */
        removed: (l.removedIngredients || []).map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean),
        extras: (l.extraIngredients || []).map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean),
      };
    });
    for (const l of lines) {
      for (const name of l.removed) {
        l.modifiers.push({ externalItemId: null, externalId: null, name, qty: 1, unitPrice: 0, removed: true });
      }
      for (const name of l.extras) {
        l.modifiers.push({ externalItemId: null, externalId: null, name, qty: 1, unitPrice: 0 });
      }
    }

    const a = p.address || {};
    const addressLine = [
      [a.address1, a.address2].filter(Boolean).join(' '),
      [a.apartmentNumber ? 'No:' + a.apartmentNumber : null,
       a.floor ? 'Kat:' + a.floor : null,
       a.doorNumber ? 'D:' + a.doorNumber : null].filter(Boolean).join(' '),
      [a.neighborhood, a.district, a.city].filter(Boolean).join(' / '),
      a.addressDescription || null,
    ].filter(x => x && String(x).trim()).join(' — ') || null;

    /* PAY_WITH_ON_DELIVERY means the courier collects; anything else the
       platform already took. `onDelivery` names the instrument - cash, card,
       or one of a dozen meal-card schemes - and the courier slip needs it. */
    const payType = pick('payment.paymentType', 'paymentType', 'paymentMethod');
    const onDelivery = pick('payment.onDelivery');
    const mealCard = pick('payment.mealCard');

    return {
      provider: this.provider,
      externalOrderId: String(pick('orderId', 'externalOrderId') || ''),
      /* the 64 character package id - what every action is addressed by */
      externalPackageId: String(pick('id', 'externalPackageId', 'packageId') || ''),
      externalNo: pick('orderNumber', 'orderCode', 'externalNo'),
      providerStoreId: String(pick('storeId', 'providerStoreId', 'restaurantId') || ''),
      supplierId: String(pick('supplierId') || this.creds.supplierId || this.conn.supplier_id || ''),
      sourceApplication: SOURCE_APPLICATIONS.includes(src) ? src : (src || null),
      providerStatus,
      status: this.statusMap()[providerStatus] || null,
      /* storePickupSelected wins: a gel-al order is a gel-al order whatever
         the delivery model says, and TGO explicitly reports those as STORE. */
      fulfillmentType: p.storePickupSelected === true ? 'PICKUP'
        : fulfilment(pick('deliveryType', 'fulfillmentType', 'shipmentType')),
      deliveryType: pick('deliveryType') || null,
      paymentType: onDelivery || mealCard || payType || null,
      isPrepaid: String(payType || '') !== 'PAY_WITH_ON_DELIVERY',
      providerTotal: Number(pick('totalPrice', 'providerTotal', 'grandTotal') || 0),
      deliveryCharge: Number(pick('totalDeliveryPrice', 'deliveryCharge', 'deliveryFee') || 0),
      promotionTotal: sumAmounts(pick('promotions')),
      couponTotal: sumAmounts(pick('coupon')),
      promotions: [].concat(pick('promotions') || [], pick('coupon') || []),
      customer: {
        label: [pick('customer.firstName'), pick('customer.lastName')].filter(Boolean).join(' ')
          || [a.firstName, a.lastName].filter(Boolean).join(' ') || null,
        /* the guest's own number is on the ADDRESS; callCenterPhone is the
           platform's masking line and is not the same thing */
        phone: a.phone || pick('customer.phone') || null,
        address: addressLine,
        note: pick('customerNote', 'customer.note', 'orderNote'),
      },
      /* the courier's door code, where the platform issues one */
      pinCode: a.pinCode || null,
      eta: pick('eta') || null,
      preparationTime: Number(pick('preparationTime') || 0) || null,
      isTest: p.testPackage === true,
      scheduledAt: pick('scheduledAt', 'deliveryDate'),
      providerCreatedAt: msToDate(pick('packageCreationDate', 'createdAt')),
      providerModifiedAt: msToDate(pick('packageModificationDate', 'lastModifiedDate', 'modifiedAt')),
      lines,
      raw: p,
    };
  }
}

/** ISO or Date to the epoch milliseconds the platform's date filters want. */
function toEpochMs(v) {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return v;
  const t = Date.parse(String(v).replace(' ', 'T'));
  return Number.isFinite(t) ? t : undefined;
}

/** Epoch milliseconds to something the rest of the pipeline can store. */
function msToDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return v;
  return new Date(n).toISOString().replace('T', ' ').slice(0, 19);
}

/** Coupons and promotions both carry their money under `amount`. */
function sumAmounts(v) {
  if (!v) return 0;
  const list = Array.isArray(v) ? v : [v];
  return list.reduce((s, x) => {
    if (!x) return s;
    const amt = x.amount && typeof x.amount === 'object'
      ? Number(x.amount.sellerCoveredAmount || x.amount.totalAmount || x.amount.amount || 0)
      : Number(x.amount || 0);
    return s + (Number.isFinite(amt) ? amt : 0);
  }, 0);
}

/**
 * Nested modifier groups, flattened to a list that still knows its parentage.
 *
 * A platform can nest three deep - "Menü > İçecek > Boy > Büyük" - and the till
 * has no modifier tables at all, so the tree has to become something a line and
 * a note can carry. The path is kept ("İçecek / Boy / Büyük") because the cook
 * needs the whole phrase, and each node keeps its own id so a modifier that has
 * been MAPPED to a real product becomes its own priced line instead.
 */
function flattenModifiers(list, parentPath = [], depth = 0, out = []) {
  if (depth > 6) return out;
  for (const m of list || []) {
    const name = m.name || m.modifierName || m.optionName || '';
    const path = parentPath.concat(name ? [name] : []);
    out.push({
      externalItemId: String(m.externalItemId || m.lineId || m.id || (path.join('/') || 'MOD')),
      /* TGO names a modifier by `productId` - the same id space as a line's
         product, which is why a modifier CAN be mapped onto a real till
         product and sold as its own line. `modifierGroupId` is the group it
         came from, not the thing itself. */
      externalId: String(m.productId || m.externalId || m.productCode || m.modifierId || m.id || ''),
      name,
      path: path.join(' / '),
      group: parentPath.length ? parentPath[parentPath.length - 1] : (m.groupName || m.group || null),
      qty: Number(m.qty !== undefined ? m.qty : (m.quantity !== undefined ? m.quantity : 1)) || 1,
      unitPrice: Number(m.unitPrice !== undefined ? m.unitPrice : (m.price || 0)) || 0,
      removed: !!(m.removed || m.isRemoved || m.excluded),
      depth,
    });
    const kids = m.modifierProducts || m.modifiers || m.children || m.options || m.subModifiers;
    if (kids && kids.length) flattenModifiers(kids, path, depth + 1, out);
  }
  return out;
}

function fulfilment(v) {
  const s = String(v || '').toUpperCase();
  if (!s) return 'PLATFORM_COURIER';
  if (/PICK|TAKE|SELF|GEL_AL|GELAL/.test(s)) return 'PICKUP';
  if (/STORE|RESTAURANT|MERCHANT|VENDOR/.test(s)) return 'RESTAURANT_COURIER';
  return 'PLATFORM_COURIER';
}

/**
 * Prepaid or not - and when in doubt, NOT.
 *
 * Getting this wrong in the safe direction means a cashier is asked for money
 * that has already been paid, which they will notice. Getting it wrong the
 * other way means a cash-on-delivery order is closed as paid and the money is
 * never counted, which nobody notices until the shift is short.
 */
function prepaid(v) {
  if (v === true || v === 1 || v === '1') return true;
  const s = String(v || '').toUpperCase();
  if (!s) return false;
  if (/CASH|NAKIT|DOOR|KAPIDA|ONDELIVERY|POS_AT_DOOR/.test(s)) return false;
  return /ONLINE|CARD|CREDIT|PREPAID|PAID|WALLET|KREDI/.test(s);
}

module.exports = { TgoAdapter, DEFAULT_STATUS_MAP, SOURCE_APPLICATIONS, KNOWN_PATHS,
  CANCEL_REASONS, DEFAULT_CANCEL_REASON, flattenModifiers, fulfilment, prepaid };
