'use strict';
/**
 * MIGROS_YEMEK — Migros Yemek restaurant integration.
 *
 * WHAT COULD BE ESTABLISHED
 * -------------------------
 * Migros publishes no developer portal. restoran.migrosonline.com is a
 * single-page application ("Alacarte") with no documentation behind it, and
 * there is no public specification of any endpoint, host, header or payload.
 * What IS consistently described by the Turkish POS vendors who already ship
 * this integration is the CREDENTIAL SHAPE, and it matches the assignment:
 *
 *     Restoran API Key      created by the restaurant in the Migros Yemek panel
 *     Restoran Grup ID      the chain / group id, returned when the key validates
 *     Restoran ID           the store id, likewise
 *     Aktivasyon kodu       optional; some partner packs issue one, most do not
 *
 * That is why this adapter's credential form is real and its transport is not.
 * Every live operation is routed through `path(op)`, which is empty until an
 * operator pastes the partner's own value in, and answers AWAITING_PARTNER_SPEC
 * until then. Nothing here fabricates a Migros URL.
 *
 * The whole surface works in simulator mode, so mapping, printing, the state
 * machine and the screen can all be exercised and demonstrated today, and
 * switching to live is a matter of filling in the base address and the paths
 * from the partner pack - no code change.
 */
const { BaseAdapter, ok, fail, awaitingSpec } = require('./base');
const httpc = require('../http');
const rate = require('../ratelimit');
const sim = require('../simulator');
const crypto = require('crypto');

/** Migros' own vocabulary as the vendor documentation describes the panel. */
const DEFAULT_STATUS_MAP = {
  NEW: 'RECEIVED',
  CREATED: 'RECEIVED',
  APPROVED: 'ACCEPTED',
  VERIFIED: 'ACCEPTED',
  PREPARING: 'PREPARING',
  PREPARED: 'READY',
  HANDOVER: 'DISPATCHED',
  SHIPPED: 'DISPATCHED',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'DELIVERED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
};

class MigrosAdapter extends BaseAdapter {
  capabilities() {
    return {
      /* Migros is described by every integrator as a polling integration with
         an optional webhook; both are declared, and both refuse cleanly until
         a path is configured. */
      fetchOrders: true,
      receiveWebhook: true,
      verifyWebhook: true,
      getOrder: true,
      accept: true,
      reject: true,
      markPreparing: true,
      markReady: true,
      markDispatched: true,
      markDelivered: false,       // the platform's courier closes the order
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
    if (this.mode === 'production') return this.creds.productionBase || process.env.MIGROS_BASE || '';
    return this.creds.stageBase || process.env.MIGROS_STAGE_BASE || '';
  }

  path(op) { return (this.creds.paths || {})[op] || null; }

  /**
   * NOT ONE HEADER NAME IS ASSUMED.
   *
   * This used to send `X-Api-Key`, `X-Store-Id` and `X-Chain-Id`, with a
   * comment admitting the first was unverifiable. The other two carried no
   * such admission and were no better founded - three invented names, two of
   * them quietly hardening into fact every time somebody read the file.
   *
   * Now the DEFAULT is to send the key and nothing else, in whichever header
   * the partner pack names, and the store and group ids travel where that pack
   * says they travel: in the path (`{storeId}`), in the query string, or in
   * headers whose names the operator types in. `authScheme` covers the two
   * shapes a Turkish partner pack normally uses - a bare key, or
   * `Authorization: <scheme> <key>`.
   *
   * The cost of a wrong header name is a 401 that looks like a wrong key, and
   * a restaurant on the phone to Migros about a credential that was never the
   * problem. So we send what we were told and nothing more.
   */
  headers() {
    const h = {
      'User-Agent': 'NOKTApp POS/' + (process.env.NOKTAPP_VERSION || '2.1.1'),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const key = this.creds.apiKey || '';
    if (key) {
      const scheme = this.creds.authScheme || '';
      if (this.creds.apiKeyHeader) h[this.creds.apiKeyHeader] = scheme ? scheme + ' ' + key : key;
      else h.Authorization = (scheme || 'Bearer') + ' ' + key;
    }
    /* Extra headers, exactly as the partner pack lists them:
       {"X-Restaurant-Id": "{storeId}", "X-Group-Id": "{chainId}"} */
    for (const [name, tmpl] of Object.entries(this.creds.extraHeaders || {})) {
      if (!name) continue;
      h[name] = String(tmpl == null ? '' : tmpl)
        .replace('{storeId}', String(this.conn.provider_store_id || ''))
        .replace('{chainId}', String(this.conn.chain_id || ''))
        .replace('{apiKey}', key);
    }
    return h;
  }

  /**
   * Whether this connection can actually reach Migros yet.
   *
   * Two things are needed and only one of them is code. The partner pack gives
   * the base address and the paths; being listed in Migros' own "Pos Firması"
   * dropdown is what lets a restaurant generate a key for NOKTApp at all, and
   * that is an agreement, not a setting. The screen says which is missing
   * rather than letting a restaurant type a key that was never going to work.
   */
  readiness() {
    const paths = this.creds.paths || {};
    return {
      hasBase: !!this.base(),
      hasKey: !!this.creds.apiKey,
      hasStore: !!this.conn.provider_store_id,
      configuredOperations: Object.keys(paths).filter(k => paths[k]),
      missingOperations: ['fetchOrders', 'getOrder', 'accept', 'reject', 'markPreparing',
        'markReady', 'markDispatched', 'cancel', 'syncMenu', 'updateProductAvailability',
        'setRestaurantOpen'].filter(op => !paths[op]),
    };
  }

  async live(op, { method = 'GET', body = null, query = null, replace = {} } = {}) {
    const p = this.path(op);
    if (!p) {
      return { spec: awaitingSpec(op,
        'Migros Yemek için resmî uç nokta dokümanı yayımlanmıyor. Bu işlemin adresini ' +
        '"Uç noktalar" bölümüne iş ortağı paketinden girin; girilene kadar simülasyon kipinde çalışır.') };
    }
    const base = this.base();
    if (!base) return { spec: fail('NOT_CONFIGURED', 'Migros Yemek sunucu adresi tanımlı değil.') };
    let url = base + p;
    for (const [k, v] of Object.entries({ storeId: this.conn.provider_store_id, chainId: this.conn.chain_id, ...replace })) {
      url = url.replace('{' + k + '}', encodeURIComponent(String(v == null ? '' : v)));
    }
    if (query) {
      const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== null && v !== undefined && v !== ''));
      if (String(qs)) url += '?' + qs;
    }
    await rate.take('MIGROS:' + p, { limit: 50, windowMs: 10000 });
    const res = await httpc.request(url, { method, headers: this.headers(), body, timeout: 15000, area: 'entegrasyon' });
    return { res };
  }

  async fetchOrders({ since = null, storeIds = null } = {}) {
    if (this.simulated) {
      const rows = sim.packages(this.provider, { since, storeIds: storeIds || [String(this.conn.provider_store_id)] });
      return ok({ orders: rows.map(r => this.normalize(r)), raw: rows });
    }
    const { spec, res } = await this.live('fetchOrders', { query: { storeId: this.conn.provider_store_id, since } });
    if (spec) return spec;
    const list = Array.isArray(res.body) ? res.body : (res.body && (res.body.orders || res.body.content)) || [];
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

  verifyWebhook({ headers = {}, rawBody = '' }) {
    const secret = this.creds.webhookSecret;
    if (!secret) return ok({ method: 'none', warning: 'İmza doğrulaması yapılandırılmadı' });
    const sent = String(headers['x-signature'] || headers['x-migros-signature'] || '').replace(/^sha256=/, '');
    const mine = crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex');
    const a = Buffer.from(sent); const b = Buffer.from(mine);
    const good = a.length === b.length && crypto.timingSafeEqual(a, b);
    return good ? ok({ method: 'hmac' }) : fail('BAD_SIGNATURE', 'Webhook imzası doğrulanamadı');
  }

  receiveWebhook({ body }) { return ok({ order: this.normalize(body), raw: body }); }

  async simOrLive(op, args, bodyFn) {
    if (this.simulated) {
      const r = sim.action(this.provider, op, {
        orderId: args.externalOrderId, packageId: args.externalPackageId,
        prepMinutes: args.prepMinutes, reason: args.reason });
      return r.ok ? ok({ providerStatus: r.providerStatus }) : fail('NOT_FOUND', 'Sipariş bulunamadı');
    }
    const { spec, res } = await this.live(op, { method: 'POST',
      replace: { orderId: args.externalOrderId }, body: bodyFn ? bodyFn(args) : {} });
    if (spec) return spec;
    return ok({ response: res.body });
  }

  accept(a) { return this.simOrLive('accept', a, x => ({ preparationTime: x.prepMinutes || this.conn.default_prep_minutes })); }
  reject(a) { return this.simOrLive('reject', a, x => ({ reason: x.reason, reasonCode: x.reasonCode || null })); }
  markPreparing(a) { return this.simOrLive('markPreparing', a); }
  markReady(a) { return this.simOrLive('markReady', a); }
  markDispatched(a) { return this.simOrLive('markDispatched', a); }
  cancel(a) { return this.simOrLive('cancel', a, x => ({ reason: x.reason })); }

  async syncMenu({ catalogue }) {
    if (this.simulated) return ok(sim.submitMenu(this.provider, this.conn.provider_store_id, catalogue));
    const { spec, res } = await this.live('syncMenu', { method: 'POST', body: catalogue });
    if (spec) return spec;
    return ok({ response: res.body });
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
    const { spec, res } = await this.live('setRestaurantOpen', { method: 'POST', body: { open: !!open } });
    if (spec) return spec; return ok({ response: res.body });
  }
  async updatePrepTime({ minutes }) {
    if (this.simulated) return ok(sim.setPrep(this.provider, this.conn.provider_store_id, minutes));
    const { spec, res } = await this.live('updatePrepTime', { method: 'POST', body: { preparationTime: minutes } });
    if (spec) return spec; return ok({ response: res.body });
  }

  async testConnection() {
    if (this.simulated) {
      const probe = await this.fetchOrders({});
      if (!probe.ok) return probe;
      return ok({ mode: 'simulator', message: 'Simülasyon kipinde hazır.' });
    }
    if (!this.creds.apiKey) return fail('INVALID_CREDENTIALS', 'Restoran API anahtarı zorunludur.');
    if (!this.conn.provider_store_id) return fail('NOT_CONFIGURED', 'Restoran ID zorunludur.');
    if (!this.conn.chain_id) return fail('NOT_CONFIGURED', 'Restoran Grup ID zorunludur.');
    if (!this.path('fetchOrders') || !this.base()) {
      return awaitingSpec('testConnection',
        'Migros Yemek uç noktaları yayımlanmadığı için canlı bağlantı testi yapılamıyor. ' +
        'Kimlik bilgileri kaydedildi; iş ortağı paketindeki sunucu adresi ve uç noktalar girilince test edilebilir.');
    }
    const r = await this.fetchOrders({});
    return r.ok ? ok({ mode: this.mode, message: 'Sipariş listesi okundu.' }) : r;
  }

  async health() {
    return ok({
      mode: this.mode,
      credentialsPresent: !!(this.creds.apiKey && this.conn.provider_store_id && this.conn.chain_id),
      verifiedOperations: [],
      unverifiedOperations: Object.keys(this.capabilities())
        .filter(op => this.capabilities()[op] && !['testConnection', 'health', 'verifyWebhook', 'receiveWebhook'].includes(op))
        .filter(op => !this.path(op)),
      readiness: this.readiness(),
      note: 'Migros Yemek resmî geliştirici dokümanı yayımlamıyor; uç noktalar iş ortağı paketinden girilir. ' +
        'Ayrıca NOKTApp\'in Migros panelindeki "Pos Firması" listesinde yer alması gerekir - ' +
        'bu liste olmadan restoran anahtar üretemez.',
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
    const providerStatus = String(pick('providerStatus', 'status', 'orderStatus') || '');
    const lines = (pick('lines', 'items', 'orderItems') || []).map((l, i) => ({
      externalItemId: String(l.externalItemId || l.id || ('L' + (i + 1))),
      externalProductId: String(l.externalProductId || l.productId || l.code || ''),
      name: l.name || l.productName || 'Ürün',
      qty: Number(l.qty !== undefined ? l.qty : (l.quantity !== undefined ? l.quantity : 1)) || 1,
      unitPrice: Number(l.unitPrice !== undefined ? l.unitPrice : (l.price || 0)) || 0,
      cancelled: !!l.cancelled,
      note: l.note || null,
      modifiers: tgo.flattenModifiers(l.modifiers || l.options || l.extras || []),
    }));
    return {
      provider: this.provider,
      externalOrderId: String(pick('externalOrderId', 'orderId', 'id', 'orderNumber') || ''),
      externalPackageId: String(pick('externalPackageId', 'packageId') || ''),
      externalNo: pick('externalNo', 'orderNumber', 'confirmationId'),
      providerStoreId: String(pick('providerStoreId', 'storeId', 'restaurantId') || this.conn.provider_store_id || ''),
      sourceApplication: 'MigrosYemek',
      providerStatus,
      status: (this.creds.statusMap || {})[providerStatus] || DEFAULT_STATUS_MAP[providerStatus.toUpperCase()] || null,
      fulfillmentType: tgo.fulfilment(pick('fulfillmentType', 'deliveryType', 'shipmentType')),
      paymentType: pick('paymentType', 'paymentMethod'),
      isPrepaid: tgo.prepaid(pick('isPrepaid', 'paymentType', 'paymentMethod')),
      providerTotal: Number(pick('providerTotal', 'totalPrice', 'amount') || 0),
      deliveryCharge: Number(pick('deliveryCharge', 'deliveryFee') || 0),
      promotionTotal: Number(pick('promotionTotal', 'discountAmount') || 0),
      couponTotal: Number(pick('couponTotal', 'couponAmount') || 0),
      promotions: pick('promotions', 'discounts') || [],
      customer: {
        label: pick('customer.name', 'customerName'),
        phone: pick('customer.phone', 'customerPhone'),
        address: pick('customer.address', 'deliveryAddress', 'address.fullAddress'),
        note: pick('customer.note', 'orderNote', 'note'),
      },
      scheduledAt: pick('scheduledAt', 'deliveryDate'),
      providerCreatedAt: pick('createdAt', 'orderDate'),
      providerModifiedAt: pick('modifiedAt', 'updatedAt', 'createdAt'),
      lines,
      raw: p,
    };
  }
}

module.exports = { MigrosAdapter, DEFAULT_STATUS_MAP };
