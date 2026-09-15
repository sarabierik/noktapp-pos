'use strict';
/**
 * GETIR_YEMEK — the direct Getir Yemek connector.
 *
 * THIS FILE USED TO BE WRONG ABOUT THE MARKET, and the correction is worth
 * writing down. It shipped as "GETIR_LEGACY", off by default, on the belief
 * that Getir Yemek orders now arrive through Uber Eats Trendyol Go with
 * sourceApplication "Galaxy" and that a direct connector would only double
 * them up. That is not what Turkish restaurants see: Getir Yemek is still its
 * own platform with its own restaurant agreement, and every POS vendor in the
 * market sells a Getir Yemek integration next to Trendyol Go and Yemeksepeti,
 * not instead of one. A restaurant asking for Getir is asking for THIS.
 *
 * What is still true is narrower, and it is a real limit rather than a policy:
 * Getir does not publish its endpoint addresses. developers.getir.com is a
 * JavaScript application that serves nothing to a reader without a browser, so
 * no path in this adapter is guessed - the base address and the per-operation
 * paths come from the integration pack Getir gives a signed partner, and
 * `enableGuard()` refuses production until they are entered. Inventing an
 * endpoint would fail silently on a restaurant's counter, which is worse than
 * refusing to start.
 */
const { BaseAdapter, ok, fail, awaitingSpec } = require('./base');
const httpc = require('../http');
const rate = require('../ratelimit');
const sim = require('../simulator');

const DEFAULT_STATUS_MAP = {
  400: 'RECEIVED', 200: 'RECEIVED',
  325: 'ACCEPTED', 350: 'PREPARING', 360: 'READY',
  550: 'DISPATCHED', 900: 'DELIVERED', 1600: 'CANCELLED', 1400: 'REJECTED',
  NEW: 'RECEIVED', ACCEPTED: 'ACCEPTED', PREPARING: 'PREPARING', PREPARED: 'READY',
  HANDOVER: 'DISPATCHED', DELIVERED: 'DELIVERED', CANCELLED: 'CANCELLED', REJECTED: 'REJECTED',
};

/**
 * The reason a connection may not be enabled, or null when it may.
 * Called by modules/integrations before flipping `enabled`.
 */
function enableGuard(conn, creds) {
  if ((conn.environment || 'simulator') === 'simulator') return null;   // sandboxing is always allowed
  if (!creds || !creds.appSecret || !creds.restaurantSecretKey) {
    return 'Getir Yemek bağlantısı için app secret ve restaurant secret key gerekir. ' +
      'Bu bilgiler Getir iş ortağı paketinizde yer alır.';
  }
  if (!creds.paths || !creds.paths.fetchOrders) {
    return 'Getir uç nokta adreslerini yayımlamadığı için canlıya almadan önce ' +
      'entegrasyon dokümanınızdaki adresleri "Uç noktalar" bölümüne girin.';
  }
  return null;
}

class GetirAdapter extends BaseAdapter {
  capabilities() {
    return {
      fetchOrders: true, receiveWebhook: true, verifyWebhook: false, getOrder: true,
      accept: true, reject: true, markPreparing: true, markReady: true,
      markDispatched: true, markDelivered: false, cancel: true,
      syncMenu: true, updateProductPrice: true, updateProductAvailability: true,
      updateCategoryAvailability: true, setRestaurantOpen: true, updatePrepTime: false,
      testConnection: true, health: true,
    };
  }

  base() { return this.creds.base || process.env.GETIR_BASE || ''; }
  path(op) { return (this.creds.paths || {})[op] || null; }

  async live(op, { method = 'GET', body = null, replace = {} } = {}) {
    const p = this.path(op);
    if (!p) return { spec: awaitingSpec(op, 'Getir uç noktaları entegrasyon dokümanınızdan girilmelidir.') };
    const base = this.base();
    if (!base) return { spec: fail('NOT_CONFIGURED', 'Getir sunucu adresi tanımlı değil.') };
    let url = base + p;
    for (const [k, v] of Object.entries({ restaurantId: this.conn.provider_store_id, ...replace })) {
      url = url.replace('{' + k + '}', encodeURIComponent(String(v == null ? '' : v)));
    }
    await rate.take('GETIR:' + p, { limit: 50, windowMs: 10000 });
    const res = await httpc.request(url, {
      method,
      headers: { Authorization: this._token || '', 'Content-Type': 'application/json' },
      body, timeout: 15000, area: 'entegrasyon',
    });
    return { res };
  }

  async fetchOrders({ since = null } = {}) {
    if (this.simulated) {
      const rows = sim.packages(this.provider, { since, storeIds: [String(this.conn.provider_store_id)] });
      return ok({ orders: rows.map(r => this.normalize(r)), raw: rows });
    }
    const { spec, res } = await this.live('fetchOrders');
    if (spec) return spec;
    const list = Array.isArray(res.body) ? res.body : (res.body && res.body.orders) || [];
    return ok({ orders: list.map(r => this.normalize(r)), raw: list });
  }

  async getOrder({ externalOrderId, externalPackageId }) {
    if (this.simulated) {
      const rec = sim.detail(this.provider, externalOrderId, externalPackageId);
      return rec ? ok({ order: this.normalize(rec), raw: rec }) : fail('NOT_FOUND', 'Sipariş bulunamadı');
    }
    const { spec, res } = await this.live('getOrder', { replace: { orderId: externalOrderId } });
    if (spec) return spec;
    return ok({ order: this.normalize(res.body), raw: res.body });
  }

  receiveWebhook({ body }) { return ok({ order: this.normalize(body), raw: body }); }

  async simOrLive(op, args, bodyFn) {
    if (this.simulated) {
      const r = sim.action(this.provider, op, {
        orderId: args.externalOrderId, packageId: args.externalPackageId,
        prepMinutes: args.prepMinutes, reason: args.reason });
      return r.ok ? ok({ providerStatus: r.providerStatus }) : fail('NOT_FOUND', 'Sipariş bulunamadı');
    }
    const { spec, res } = await this.live(op, { method: 'POST', replace: { orderId: args.externalOrderId },
      body: bodyFn ? bodyFn(args) : {} });
    if (spec) return spec;
    return ok({ response: res.body });
  }

  accept(a) { return this.simOrLive('accept', a); }
  reject(a) { return this.simOrLive('reject', a, x => ({ reason: x.reason })); }
  markPreparing(a) { return this.simOrLive('markPreparing', a); }
  markReady(a) { return this.simOrLive('markReady', a); }
  markDispatched(a) { return this.simOrLive('markDispatched', a); }
  cancel(a) { return this.simOrLive('cancel', a, x => ({ reason: x.reason })); }

  async syncMenu({ catalogue }) {
    if (this.simulated) return ok(sim.submitMenu(this.provider, this.conn.provider_store_id, catalogue));
    const { spec, res } = await this.live('syncMenu', { method: 'POST', body: catalogue });
    if (spec) return spec; return ok({ response: res.body });
  }
  async updateProductPrice({ items }) {
    if (this.simulated) return ok({ updated: items.length });
    const { spec, res } = await this.live('updateProductPrice', { method: 'POST', body: { items } });
    if (spec) return spec; return ok({ response: res.body });
  }
  async updateProductAvailability({ items }) {
    if (this.simulated) return ok({ updated: items.length });
    const { spec, res } = await this.live('updateProductAvailability', { method: 'POST', body: { items } });
    if (spec) return spec; return ok({ response: res.body });
  }
  async updateCategoryAvailability({ items }) {
    if (this.simulated) return ok({ updated: items.length });
    const { spec, res } = await this.live('updateCategoryAvailability', { method: 'POST', body: { items } });
    if (spec) return spec; return ok({ response: res.body });
  }
  async setRestaurantOpen({ open }) {
    if (this.simulated) return ok(sim.setOpen(this.provider, this.conn.provider_store_id, open));
    const { spec, res } = await this.live('setRestaurantOpen', { method: 'POST', body: { status: open ? 100 : 200 } });
    if (spec) return spec; return ok({ response: res.body });
  }

  async testConnection() {
    if (this.simulated) {
      const probe = await this.fetchOrders({});
      if (!probe.ok) return probe;
      return ok({ mode: 'simulator', message: 'Simülasyon kipinde hazır.' });
    }
    const why = enableGuard(this.conn, this.creds);
    if (why) return fail('LEGACY_DISABLED', why);
    const r = await this.fetchOrders({});
    return r.ok ? ok({ mode: this.mode, message: 'Sipariş listesi okundu.' }) : r;
  }

  async health() {
    return ok({
      mode: this.mode,
      legacy: true,
      note: 'Yeni Getir siparişleri Uber Eats Trendyol Go üzerinden "Galaxy" kaynağıyla gelir. ' +
        'Bu bağlantı yalnızca elinizde eski Getir kimlik bilgileri varsa kullanılır.',
      blockedReason: enableGuard(this.conn, this.creds),
    });
  }

  normalize(p) {
    if (!p) return null;
    const tgo = require('./tgo');
    const pick = (...names) => {
      for (const n of names) {
        const v = n.split('.').reduce((o, k) => (o == null ? o : o[k]), p);
        if (v !== undefined && v !== null && v !== '') return v;
      }
      return null;
    };
    const providerStatus = String(pick('providerStatus', 'status') || '');
    const lines = (pick('lines', 'products', 'items') || []).map((l, i) => ({
      externalItemId: String(l.externalItemId || l.id || ('L' + (i + 1))),
      externalProductId: String(l.externalProductId || l.product || l.id || ''),
      name: l.name || (l.name && l.name.tr) || 'Ürün',
      qty: Number(l.qty !== undefined ? l.qty : (l.count !== undefined ? l.count : 1)) || 1,
      unitPrice: Number(l.unitPrice !== undefined ? l.unitPrice : (l.price || 0)) || 0,
      cancelled: !!l.cancelled,
      note: l.note || null,
      modifiers: tgo.flattenModifiers(l.modifiers || l.optionCategories || l.options || []),
    }));
    return {
      provider: this.provider,
      externalOrderId: String(pick('externalOrderId', 'id', '_id', 'orderId') || ''),
      externalPackageId: String(pick('externalPackageId', 'packageId') || ''),
      externalNo: pick('externalNo', 'confirmationId', 'orderNumber'),
      providerStoreId: String(pick('providerStoreId', 'restaurantId', 'restaurant') || this.conn.provider_store_id || ''),
      sourceApplication: 'GetirYemek',
      providerStatus,
      status: (this.creds.statusMap || {})[providerStatus] || DEFAULT_STATUS_MAP[providerStatus]
        || DEFAULT_STATUS_MAP[String(providerStatus).toUpperCase()] || null,
      fulfillmentType: tgo.fulfilment(pick('deliveryType', 'fulfillmentType')),
      paymentType: pick('paymentMethod', 'paymentType'),
      isPrepaid: tgo.prepaid(pick('isPrepaid', 'paymentMethod', 'paymentType')),
      providerTotal: Number(pick('providerTotal', 'totalPrice') || 0),
      deliveryCharge: Number(pick('deliveryCharge', 'deliveryFee') || 0),
      promotionTotal: Number(pick('promotionTotal') || 0),
      couponTotal: Number(pick('couponTotal') || 0),
      promotions: pick('promotions') || [],
      customer: {
        label: pick('customer.name', 'client.name'),
        phone: pick('customer.phone', 'client.contactPhoneNumber'),
        address: pick('customer.address', 'client.deliveryAddress.address'),
        note: pick('customer.note', 'clientNote', 'note'),
      },
      scheduledAt: pick('scheduledDate', 'scheduledAt'),
      providerCreatedAt: pick('createdAt', 'checkoutDate'),
      providerModifiedAt: pick('modifiedAt', 'updatedAt', 'createdAt'),
      lines,
      raw: p,
    };
  }
}

module.exports = { GetirAdapter, DEFAULT_STATUS_MAP, enableGuard };
