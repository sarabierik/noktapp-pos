'use strict';
/**
 * YEMEKSEPETİ — the restaurant POS integration, NOT the Local Shops API.
 *
 * Yemeksepeti is a Delivery Hero brand and its restaurant POS integration is
 * the group's shared **Integration Middleware** — the same product, the same
 * v2 paths and the same vocabulary that Talabat and foodpanda document
 * publicly, with Turkey sitting in the "Middle East + Turkey" ingress block.
 *
 * Every path, body and enum in this file was READ from the published
 * specification, not inferred:
 *
 *   POST /v2/login
 *        { username, password, grant_type: "client_credentials" }
 *        -> { access_token, expires_in: 1800, token_type: "bearer" }
 *
 *   POST /v2/order/status/{orderToken}
 *        { status, acceptanceTime, remoteOrderId?, modifications? }
 *        status ∈ order_accepted | order_rejected | order_picked_up
 *        409 carries `currentState` when the order has moved on already.
 *
 *   POST /v2/orders/{orderToken}/preparation-completed     -> { code: "OK" }
 *
 *   POST /v2/chains/{chainCode}/catalog
 *        { callbackUrl?, catalog: { items: { <key>: Item } }, vendors: [posVendorId] }
 *        Item.type ∈ Menu | Product | Category | Topping | Image | ScheduleEntry
 *
 *   PUT  /v2/chains/{chainCode}/vendors/{posVendorId}/catalog/items/availability
 *        { globalEntityId, items: [id], type: "ITEM"|"TOPPING", isAvailable }
 *
 *   GET  /v2/chains/{chainCode}/vendors/{posVendorId}/catalog/items/unavailable
 *   GET  /v2/chains/{chainCode}/vendors/{posVendorId}/menu-import-logs
 *   GET  /v2/chains/{chainCode}/vendors/{posVendorId}/platform-vendors
 *        -> [{ platformVendorId, globalEntityId, posVendorId }]
 *
 *   GET  /v2/chains/{chainCode}/remoteVendors/{posVendorId}/availability
 *   PUT  /v2/chains/{chainCode}/remoteVendors/{posVendorId}/availability
 *        { availabilityState, platformKey, platformRestaurantId }
 *        availabilityState ∈ OPEN | CLOSED | CLOSED_UNTIL | CLOSED_TODAY | INACTIVE | UNKNOWN
 *        204 means "acknowledged, result pending" — retry, do not treat as failure.
 *
 *   GET  /v2/chains/{chainCode}/orders/ids?status=&pastNumberOfHours=&vendorId=
 *   GET  /v2/chains/{chainCode}/orders/{orderId}
 *
 * WHAT IS STILL NOT PUBLISHED, and is therefore configuration rather than a
 * constant: the approved reject REASON codes (the status enum is published,
 * the reason list is not), and a dedicated post-acceptance cancellation path.
 * Neither is guessed; a reason code the platform does not know comes back as a
 * 4xx, which this pipeline treats as permanent and shows to the user.
 *
 * TWO ACCEPTANCE MODES, and they change what the till may do:
 *   PROVIDER_TABLET  (Delivery Hero "indirect flow") — the vendor accepts on
 *                    the platform's own tablet and we only ever see orders
 *                    that are already accepted. The till must NOT try to
 *                    accept them again.
 *   POS_DIRECT       ("direct flow") — every order arrives here first and this
 *                    POS is responsible for accepting, rejecting and handling
 *                    cancellation. There is no tablet to fall back on, so a
 *                    plugin that does not answer gets the order cancelled.
 */
const { BaseAdapter, ok, fail, awaitingSpec } = require('./base');
const httpc = require('../http');
const rate = require('../ratelimit');
const sim = require('../simulator');
const crypto = require('crypto');

const STAGE_BASE = 'https://integration-middleware.stg.restaurant-partners.com';

/* Read from the published specification. Nothing here is a guess; the two
   operations that ARE unpublished live in `creds.paths` instead. */
const PATHS = {
  login: '/v2/login',
  orderStatus: '/v2/order/status/{orderToken}',
  preparationCompleted: '/v2/orders/{orderToken}/preparation-completed',
  catalogImport: '/v2/chains/{chainCode}/catalog',
  menuImportLogs: '/v2/chains/{chainCode}/vendors/{posVendorId}/menu-import-logs',
  itemAvailability: '/v2/chains/{chainCode}/vendors/{posVendorId}/catalog/items/availability',
  unavailableItems: '/v2/chains/{chainCode}/vendors/{posVendorId}/catalog/items/unavailable',
  vendorAvailability: '/v2/chains/{chainCode}/remoteVendors/{posVendorId}/availability',
  orderIds: '/v2/chains/{chainCode}/orders/ids',
  orderDetail: '/v2/chains/{chainCode}/orders/{orderId}',
  platformVendors: '/v2/chains/{chainCode}/vendors/{posVendorId}/platform-vendors',
};

/** The three the middleware accepts on POST /v2/order/status/{orderToken}. */
const STATUS_ACCEPTED = 'order_accepted';
const STATUS_REJECTED = 'order_rejected';
const STATUS_PICKED_UP = 'order_picked_up';

/** availabilityState, verbatim from the availability schema. */
const AVAILABILITY_STATES = ['OPEN', 'CLOSED', 'CLOSED_UNTIL', 'CLOSED_TODAY', 'INACTIVE', 'UNKNOWN'];

/**
 * Provider status -> our canonical status.
 *
 * Delivery Hero sends order lifecycle changes to the plugin rather than
 * putting a status on the dispatch payload, so most orders arrive with no
 * status at all and RECEIVED is the right reading. The rest of the map is the
 * vocabulary the middleware and the plugin webhook use between them.
 */
const DEFAULT_STATUS_MAP = {
  '': 'RECEIVED',
  incoming: 'RECEIVED', new: 'RECEIVED', created: 'RECEIVED', received: 'RECEIVED',
  accepted: 'ACCEPTED', order_accepted: 'ACCEPTED',
  preparing: 'PREPARING',
  prepared: 'READY', 'ready for pick up': 'READY', ready_for_pickup: 'READY',
  picked: 'DISPATCHED', picked_up: 'DISPATCHED', 'picked up': 'DISPATCHED',
  order_picked_up: 'DISPATCHED', dispatched: 'DISPATCHED',
  delivered: 'DELIVERED',
  order_rejected: 'REJECTED', rejected: 'REJECTED',
  cancelled: 'CANCELLED', canceled: 'CANCELLED',
};

/**
 * Reject reasons.
 *
 * The STATUS enum is published; the approved reason codes are not. These are
 * the six a Turkish restaurant actually uses, in Turkish, with the code left
 * settable per connection - so a restaurant is never blocked by a code we
 * invented, and a code the platform does not know comes back as a 4xx the
 * pipeline treats as permanent and shows on the screen.
 */
const DEFAULT_REJECT_REASONS = [
  { code: 'ITEM_OUT_OF_STOCK', label: 'Üründe stok yok' },
  { code: 'KITCHEN_BUSY', label: 'Mutfak çok yoğun' },
  { code: 'CLOSING_SOON', label: 'Kapanış saati' },
  { code: 'TECHNICAL_PROBLEM', label: 'Teknik sorun' },
  { code: 'DELIVERY_AREA', label: 'Teslimat bölgesi dışında' },
  { code: 'OTHER', label: 'Diğer' },
];

/* ------------------------------------------------------------------ *
 * The catalogue translator                                            *
 * ------------------------------------------------------------------ */
/**
 * NOKTApp's menu -> the middleware's catalogue.
 *
 * The middleware does not take a list of categories and a list of products. It
 * takes ONE flat map keyed by item id, in which every entry carries its own
 * `type`, and parents point at children by repeating `{ id, type }` and
 * nothing else. So a product appears twice: once in full, and once as a bare
 * reference inside its category and inside the menu.
 *
 * Getting this wrong is not a soft failure. The importer validates that every
 * reference resolves, that there is at least one category, and that every
 * product belongs to one - so a menu that is merely *nearly* right is rejected
 * whole, and the restaurant sees an empty listing on Yemeksepeti.
 */
function dhCatalog(catalogue, { menuTitle = 'Menü', menuType = 'DELIVERY' } = {}) {
  const items = {};
  const ref = (id, type) => ({ id: String(id), type });
  const money = (v) => (Math.round(Number(v || 0) * 100) / 100).toFixed(2);
  const title = (t) => ({ default: String(t == null ? '' : t) });

  const products = (catalogue.products || []).filter(p => p && p.externalId != null);
  const categories = (catalogue.categories || []).filter(c => c && c.externalId != null);

  /* toppings first: a product references them, so they must exist to resolve */
  const toppingRefsFor = {};
  for (const g of catalogue.modifierGroups || []) {
    const gid = String(g.externalId != null ? g.externalId : g.id);
    if (!gid) continue;
    const optRefs = {};
    for (const o of g.options || g.products || []) {
      const oid = String(o.externalId != null ? o.externalId : o.id);
      if (!oid) continue;
      items[oid] = {
        id: oid, type: 'Product', title: title(o.name), price: money(o.price),
        active: o.available === false ? false : true,
        isPrepackedItem: false, isExpressItem: false, excludeDishInformation: false,
      };
      optRefs[oid] = ref(oid, 'Product');
    }
    items[gid] = {
      id: gid, type: 'Topping', title: title(g.name),
      quantity: {
        minimum: Number.isFinite(Number(g.min)) ? Number(g.min) : 0,
        maximum: Number.isFinite(Number(g.max)) ? Number(g.max) : Math.max(1, Object.keys(optRefs).length),
      },
      products: optRefs,
    };
    for (const pid of g.productIds || []) {
      (toppingRefsFor[String(pid)] = toppingRefsFor[String(pid)] || {})[gid] = ref(gid, 'Topping');
    }
  }

  for (const p of products) {
    const id = String(p.externalId);
    items[id] = {
      id, type: 'Product', title: title(p.name), price: money(p.price),
      active: p.available === false ? false : true,
      isPrepackedItem: false, isExpressItem: false, excludeDishInformation: false,
    };
    if (toppingRefsFor[id]) items[id].toppings = toppingRefsFor[id];
  }

  /* A category with no products is dropped rather than sent empty: the
     importer accepts it and the platform then shows the guest a heading with
     nothing under it. */
  const menuProducts = {};
  for (const c of categories) {
    const cid = String(c.externalId);
    const own = {};
    for (const p of products) {
      if (String(p.categoryId) !== cid) continue;
      own[String(p.externalId)] = ref(p.externalId, 'Product');
      menuProducts[String(p.externalId)] = ref(p.externalId, 'Product');
    }
    if (!Object.keys(own).length) continue;
    items[cid] = { id: cid, type: 'Category', title: title(c.name), products: own };
  }

  const menuId = 'NOK-MENU-' + menuType;
  items[menuId] = { id: menuId, type: 'Menu', menuType, title: title(menuTitle), products: menuProducts };
  return { items };
}

class YemeksepetiAdapter extends BaseAdapter {
  constructor(conn, creds) {
    super(conn, creds);
    this._token = null; this._tokenExp = 0;
    this._vendors = null; this._vendorsAt = 0;
  }

  capabilities() {
    const direct = this.conn.acceptance_mode === 'POS_DIRECT';
    return {
      /* The middleware pushes orders to the plugin; `orders/ids` is a
         RECONCILIATION door, not a feed, so the poller may use it to find what
         a missed webhook dropped. */
      fetchOrders: true,
      receiveWebhook: true,
      verifyWebhook: true,
      getOrder: true,
      /* In indirect flow the vendor accepts on the platform's own tablet.
         Offering an Accept button the platform will refuse is worse than not
         offering one, so the capability itself is off. */
      accept: direct,
      reject: direct,
      markPreparing: false,        // no such call in the middleware API
      markReady: true,             // preparation-completed
      markDispatched: true,        // order_picked_up
      markDelivered: false,        // the platform owns delivery confirmation
      cancel: direct,
      syncMenu: true,
      updateProductPrice: true,    // a price change is a catalogue import
      updateProductAvailability: true,
      updateCategoryAvailability: false,
      setRestaurantOpen: true,
      updatePrepTime: false,       // prep time rides on the acceptance
      testConnection: true,
      health: true,
    };
  }

  base() {
    if (this.mode === 'stage') return this.creds.stageBase || STAGE_BASE;
    return this.creds.productionBase || process.env.YEMEKSEPETI_BASE || '';
  }

  /** chainCode and posVendorId, the two ids every v2 path is built from. */
  chain() { return String(this.creds.chainCode || this.conn.chain_id || this.conn.supplier_id || ''); }
  vendor() { return String(this.conn.provider_store_id || ''); }

  rejectReasons() { return this.creds.rejectReasons || DEFAULT_REJECT_REASONS; }

  /**
   * `expires_in` is 1800 seconds and the token is used from a poller that can
   * sit idle for minutes, so the expiry is taken from the ANSWER rather than
   * assumed, and retired a minute early - a token that expires between the
   * check and the request is a 401 on a live order.
   */
  async token() {
    if (this._token && Date.now() < this._tokenExp) return this._token;
    const base = this.base();
    if (!base) throw Object.assign(new Error('Yemeksepeti adresi tanımlı değil'), { name: 'ProviderError', kind: 'permanent' });
    await rate.take('YS:' + PATHS.login, { limit: 50, windowMs: 10000 });
    const res = await httpc.request(base + PATHS.login, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { username: this.creds.username, password: this.creds.password, grant_type: 'client_credentials' },
      timeout: 15000, area: 'entegrasyon',
    });
    const b = res.body || {};
    const t = b.access_token || b.token || b.accessToken;
    if (!t) throw Object.assign(new Error('Yemeksepeti oturum anahtarı alınamadı'), { name: 'ProviderError', kind: 'auth' });
    const ttl = Number(b.expires_in) > 0 ? Number(b.expires_in) : 1800;
    this._token = t;
    this._tokenExp = Date.now() + Math.max(30, ttl - 60) * 1000;
    return t;
  }

  /**
   * `allow` is the whole reason this wrapper exists twice over.
   *
   * integrations/http.js THROWS on any non-2xx, which is right for a transport
   * - a 500 from a platform is not an answer. But two of the middleware's
   * statuses ARE answers: 409 carries `currentState` and means "somebody
   * accepted this on the tablet while you were printing", and 404 on an order
   * means the order is not ours. Both were being converted into a generic
   * adapter error and retried for ever. Listing them here hands the status
   * back to the caller to read.
   */
  async live(path, { method = 'POST', body = null, replace = {}, query = null, allow = [] } = {}) {
    const base = this.base();
    if (!base) {
      return { spec: fail('NOT_CONFIGURED', this.mode === 'production'
        ? 'Yemeksepeti canlı adresi tanımlı değil. İş ortağı paketindeki middleware adresini girin.'
        : 'Yemeksepeti test adresi tanımlı değil.') };
    }
    const fill = { chainCode: this.chain(), posVendorId: this.vendor(), ...replace };
    let url = base + path;
    for (const [k, v] of Object.entries(fill)) {
      url = url.replace('{' + k + '}', encodeURIComponent(String(v == null ? '' : v)));
    }
    if (/\{[A-Za-z]+\}/.test(url)) {
      return { spec: fail('NOT_CONFIGURED',
        'Zincir kodu (chain code) ya da restoran kodu boş. Entegrasyon ekranından ikisini de girin.') };
    }
    if (query) {
      const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    await rate.take('YS:' + path, { limit: 50, windowMs: 10000 });
    try {
      const res = await httpc.request(url, {
        method,
        headers: { Authorization: 'Bearer ' + (await this.token()), 'Content-Type': 'application/json' },
        body, timeout: 15000, area: 'entegrasyon',
      });
      return { res };
    } catch (e) {
      if (e && e.name === 'ProviderError' && allow.includes(e.status)) {
        return { res: { status: e.status, body: e.body || null, headers: {} } };
      }
      throw e;
    }
  }

  /**
   * The platform vendors behind one POS vendor id.
   *
   * Yemeksepeti, and every other Delivery Hero brand this restaurant is listed
   * on, each have their own platformVendorId and globalEntityId - and the
   * availability and item-availability calls need them. Asking once and
   * keeping the answer for ten minutes is the difference between "close the
   * restaurant" being one request and being three.
   */
  async platformVendors() {
    if (this._vendors && Date.now() - this._vendorsAt < 10 * 60000) return this._vendors;
    const { spec, res } = await this.live(PATHS.platformVendors, { method: 'GET' });
    if (spec) return [];
    const rows = Array.isArray(res.body) ? res.body : (res.body && res.body.vendors) || [];
    this._vendors = rows; this._vendorsAt = Date.now();
    return rows;
  }

  /** globalEntityId: from the connection if the partner pack named one, else asked for. */
  async entity() {
    if (this.creds.globalEntityId) return this.creds.globalEntityId;
    const rows = await this.platformVendors();
    return (rows[0] && rows[0].globalEntityId) || null;
  }

  /* ------------------------------------------------------- webhooks */

  /**
   * Delivery Hero does not publish a signature header for the plugin webhook;
   * the documented protection is the secret configured in Partner Portal, sent
   * as HTTP Basic credentials on the plugin endpoint, plus a per-region IP
   * allowlist. So this verifies, in order:
   *   1. an HMAC over the raw body when a shared secret has been configured
   *      (some integration packs do issue one),
   *   2. otherwise the plugin username/password we were given,
   * and reports WHICH of the two was used, so the screen can say "imza
   * doğrulanmadı, yalnızca kimlik doğrulandı" rather than implying more
   * security than there is.
   */
  verifyWebhook({ headers = {}, rawBody = '' }) {
    const secret = this.creds.webhookSecret;
    if (secret) {
      const sent = headers['x-signature'] || headers['x-hub-signature-256'] || headers['x-dh-signature'] || '';
      const mine = crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex');
      const a = Buffer.from(String(sent).replace(/^sha256=/, ''));
      const b = Buffer.from(mine);
      const good = a.length === b.length && crypto.timingSafeEqual(a, b);
      return good ? ok({ method: 'hmac' }) : fail('BAD_SIGNATURE', 'Webhook imzası doğrulanamadı');
    }
    const authz = headers.authorization || '';
    if (this.creds.pluginUsername && authz.startsWith('Basic ')) {
      const [u, p] = Buffer.from(authz.slice(6), 'base64').toString('utf8').split(':');
      if (u === this.creds.pluginUsername && p === this.creds.pluginPassword) return ok({ method: 'basic' });
      return fail('BAD_SIGNATURE', 'Webhook kimlik bilgileri hatalı');
    }
    return ok({ method: 'none', warning: 'İmza doğrulaması yapılandırılmadı' });
  }

  receiveWebhook({ body }) { return ok({ order: this.normalize(body), raw: body }); }

  /* --------------------------------------------------------- orders */

  /**
   * Reconciliation, not a feed.
   *
   * `orders/ids` answers with the identifiers of orders accepted or cancelled
   * in the last N hours (1-24), which is exactly the question to ask after the
   * till has been offline: "what did I miss". It is never the primary path -
   * the webhook is - so it asks for a window and then fetches each detail.
   */
  async fetchOrders({ sinceHours = 2, statuses = null } = {}) {
    if (this.simulated) {
      return ok({ orders: sim.packages(this.provider, { storeIds: [this.vendor()] }).map(r => this.normalize(r)) });
    }
    const want = (statuses && statuses.length ? statuses : ['accepted']);
    const seen = new Set();
    const out = [];
    for (const st of want) {
      const { spec, res } = await this.live(PATHS.orderIds, {
        method: 'GET',
        query: { status: st, pastNumberOfHours: Math.min(24, Math.max(1, Number(sinceHours) || 2)), vendorId: this.vendor() },
      });
      if (spec) return spec;
      for (const id of (res.body && res.body.orderIdentifiers) || []) {
        const key = String(id && id.orderId !== undefined ? id.orderId : id);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const d = await this.live(PATHS.orderDetail, { method: 'GET', replace: { orderId: key } });
        if (d.spec) continue;
        out.push(this.normalize(d.res.body));
      }
    }
    return ok({ orders: out });
  }

  async getOrder({ externalOrderId, externalPackageId }) {
    if (this.simulated) {
      const rec = sim.detail(this.provider, externalOrderId, externalPackageId);
      return rec ? ok({ order: this.normalize(rec), raw: rec }) : fail('NOT_FOUND', 'Sipariş bulunamadı');
    }
    const { spec, res } = await this.live(PATHS.orderDetail, {
      method: 'GET', replace: { orderId: externalOrderId }, allow: [404] });
    if (spec) return spec;
    if (res.status === 404) return fail('NOT_FOUND', 'Sipariş bulunamadı');
    return ok({ order: this.normalize(res.body), raw: res.body });
  }

  /**
   * One door for all three published statuses.
   *
   * 409 is its own answer and not a failure to retry: the middleware returns
   * it with `currentState` when the order has already moved on - somebody
   * accepted it on the tablet, or the platform cancelled it while the slip was
   * printing. Retrying that forever is how an order queue fills up with work
   * that can never succeed.
   */
  async setStatus(orderToken, body) {
    const { spec, res } = await this.live(PATHS.orderStatus, {
      replace: { orderToken }, body, allow: [409] });
    if (spec) return spec;
    if (res.status === 409) {
      const cur = (res.body && (res.body.currentState || res.body.current_state)) || null;
      return fail('ALREADY_IN_STATE',
        cur ? `Sipariş zaten "${cur}" durumunda; bu değişiklik uygulanamaz.` : 'Sipariş bu duruma geçirilemez.',
        { detail: res.body });
    }
    return ok({ response: res.body });
  }

  async accept({ externalOrderId, externalPackageId, prepMinutes, remoteOrderId }) {
    if (this.simulated) return simAction(this, 'accept', { externalOrderId, externalPackageId, prepMinutes });
    const body = {
      status: STATUS_ACCEPTED,
      /* Delivery Hero's post-production checklist calls out datetime
         formatting on acceptances specifically, so this is an ISO instant. */
      acceptanceTime: new Date(
        Date.now() + Number(prepMinutes || this.conn.default_prep_minutes || 20) * 60000).toISOString(),
    };
    if (remoteOrderId) body.remoteOrderId = String(remoteOrderId);
    return this.setStatus(externalOrderId, body);
  }

  async reject({ externalOrderId, externalPackageId, reason, reasonCode }) {
    if (this.simulated) return simAction(this, 'reject', { externalOrderId, externalPackageId, reason });
    const codes = this.rejectReasons().map(r => r.code);
    if (reasonCode && !codes.includes(reasonCode)) {
      return fail('INVALID_REJECT_REASON',
        'Bu sebep kodu onaylı listede yok: ' + reasonCode + '. Geçerli olanlar: ' + codes.join(', '));
    }
    /* `status` and `acceptanceTime` are published; the field the reason
       travels in is not, so its NAME is configurable and its default is the
       one the vocabulary uses. */
    const field = this.creds.rejectReasonField || 'reason';
    const body = { status: STATUS_REJECTED, acceptanceTime: new Date().toISOString() };
    body[field] = reasonCode || 'OTHER';
    if (reason) body.message = reason;
    return this.setStatus(externalOrderId, body);
  }

  async markReady({ externalOrderId, externalPackageId }) {
    if (this.simulated) return simAction(this, 'markReady', { externalOrderId, externalPackageId });
    const { spec, res } = await this.live(PATHS.preparationCompleted, { replace: { orderToken: externalOrderId } });
    if (spec) return spec;
    return ok({ response: res.body });
  }

  async markDispatched({ externalOrderId, externalPackageId }) {
    if (this.simulated) return simAction(this, 'markDispatched', { externalOrderId, externalPackageId });
    return this.setStatus(externalOrderId, { status: STATUS_PICKED_UP, acceptanceTime: new Date().toISOString() });
  }

  /**
   * Cancelling an order this POS has already accepted.
   *
   * The published status enum has no `order_cancelled`, and no dedicated
   * cancellation path appears in the specification - Delivery Hero's own
   * onboarding asks the POS vendor for "the endpoint used for cancellations"
   * as part of going live, which says plainly that it is issued per partner.
   * So it stays configurable and refuses in words rather than posting a
   * cancellation at a URL we made up.
   */
  async cancel({ externalOrderId, externalPackageId, reason }) {
    if (this.simulated) return simAction(this, 'cancel', { externalOrderId, externalPackageId, reason });
    const p = (this.creds.paths || {}).cancel;
    if (!p) return awaitingSpec('cancel', 'Onay sonrası iptal uç noktası iş ortağı paketinden girilmelidir.');
    const { spec, res } = await this.live(p, { replace: { orderToken: externalOrderId }, body: { reason } });
    if (spec) return spec;
    return ok({ response: res.body });
  }

  /* ----------------------------------------------------------- menu */

  async syncMenu({ catalogue }) {
    if (this.simulated) return ok(sim.submitMenu(this.provider, this.vendor(), catalogue));
    const body = {
      catalog: dhCatalog(catalogue || {}, { menuTitle: this.creds.menuTitle || 'Menü' }),
      vendors: [this.vendor()],
    };
    if (this.creds.callbackUrl) body.callbackUrl = this.creds.callbackUrl;
    const { spec, res } = await this.live(PATHS.catalogImport, { method: 'POST', body });
    if (spec) return spec;
    const id = res.body && (res.body.catalogImportId || res.body.job_id || res.body.id);
    return ok({ response: res.body, catalogImportId: id || null,
      counts: { items: Object.keys(body.catalog.items).length } });
  }

  /** There is no price-only call: a price change is a catalogue import. */
  async updateProductPrice({ catalogue }) { return this.syncMenu({ catalogue }); }

  async updateProductAvailability({ items, available = false, type = 'ITEM' }) {
    if (this.simulated) return ok({ updated: (items || []).length });
    const globalEntityId = await this.entity();
    if (!globalEntityId) {
      return fail('NOT_CONFIGURED',
        'globalEntityId bulunamadı. Platform restoran eşleşmesi okunamadı; iş ortağı paketindeki değeri girin.');
    }
    const { spec, res } = await this.live(PATHS.itemAvailability, {
      method: 'PUT',
      body: { globalEntityId, items: (items || []).map(String), type, isAvailable: !!available },
    });
    if (spec) return spec;
    return ok({ response: res.body, updated: (items || []).length });
  }

  /**
   * Open or close the restaurant on every Delivery Hero brand it is listed on.
   *
   * The call is per PLATFORM vendor, not per POS vendor, so one restaurant
   * that sells on Yemeksepeti and on another brand of the group needs one
   * request each. A partial failure is reported as a partial failure - closing
   * on one platform and staying open on the other is worse than either.
   */
  async setRestaurantOpen({ open }) {
    if (this.simulated) return ok(sim.setOpen(this.provider, this.vendor(), open));
    const state = open ? 'OPEN' : 'CLOSED';
    if (!AVAILABILITY_STATES.includes(state)) return fail('BAD_STATE', 'Geçersiz durum: ' + state);
    let targets = (await this.platformVendors()).map(v => ({
      platformKey: v.platformKey || v.globalEntityId, platformRestaurantId: v.platformVendorId }));
    if (!targets.length && this.creds.platformKey && this.creds.platformRestaurantId) {
      targets = [{ platformKey: this.creds.platformKey, platformRestaurantId: this.creds.platformRestaurantId }];
    }
    if (!targets.length) {
      return fail('NOT_CONFIGURED', 'Platform restoran eşleşmesi okunamadı; platformKey ve platformRestaurantId gerekli.');
    }
    const done = [], failed = [];
    for (const t of targets) {
      /* One platform refusing must not stop the others: a restaurant that is
         shut on Yemeksepeti and still taking orders on a sister brand is worse
         than either answer on its own, so each is attempted and the whole
         result is reported. */
      try {
        const { spec, res } = await this.live(PATHS.vendorAvailability, {
          method: 'PUT', body: { availabilityState: state, ...t } });
        if (spec) return spec;
        /* 204: acknowledged, result pending. Reported as pending, not success -
           the screen must not say "kapatıldı" before the platform agrees. */
        if (res.status === 204) failed.push({ ...t, pending: true });
        else done.push(t);
      } catch (e) {
        failed.push({ ...t, status: e.status || null, error: e.message });
      }
    }
    if (failed.length && !done.length) {
      return fail('AVAILABILITY_PENDING',
        'Durum değişikliği platformda henüz onaylanmadı; birkaç saniye sonra tekrar deneyin.',
        { retryable: true, detail: failed });
    }
    return ok({ state, updated: done.length, pending: failed });
  }

  async testConnection() {
    if (this.simulated) {
      const probe = await this.getOrder({ externalOrderId: '__probe__', externalPackageId: '' });
      if (!probe.ok && probe.code !== 'NOT_FOUND') return probe;
      return ok({ mode: 'simulator', message: 'Simülasyon kipinde hazır.' });
    }
    if (!this.creds.username || !this.creds.password) {
      return fail('INVALID_CREDENTIALS', 'Middleware kullanıcı adı ve şifresi zorunludur.');
    }
    if (!this.vendor()) return fail('NOT_CONFIGURED', 'Restoran kodu (POS vendor id) zorunludur.');
    if (!this.chain()) return fail('NOT_CONFIGURED', 'Zincir kodu (chain code) zorunludur.');
    try { await this.token(); } catch (e) { return fail('INVALID_CREDENTIALS', e.message); }
    const { spec, res } = await this.live(PATHS.vendorAvailability, { method: 'GET' });
    if (spec) return spec;
    if (res.status >= 400) {
      return fail('PROVIDER_ERROR', 'Oturum açıldı ama restoran durumu okunamadı (HTTP ' + res.status + '). ' +
        'Zincir kodu ve restoran kodunu kontrol edin.', { detail: res.body });
    }
    return ok({ mode: this.mode, message: 'Oturum açıldı, restoran durumu okundu.', vendor: res.body });
  }

  async health() {
    return ok({
      mode: this.mode,
      acceptanceMode: this.conn.acceptance_mode,
      hasToken: !!this._token,
      tokenExpiresAt: this._tokenExp ? new Date(this._tokenExp).toISOString() : null,
      chainCode: this.chain() || null,
      posVendorId: this.vendor() || null,
      verifiedOperations: Object.keys(PATHS),
      unverifiedOperations: ['cancel'].filter(op => !((this.creds.paths || {})[op])),
      ingressAllowList: ['63.32.225.161', '18.202.96.85', '52.208.41.152'],
    });
  }

  /**
   * The Delivery Hero order, as published.
   *
   *   token          the id every API call is made with       -> externalOrderId
   *   code           the rider's reference                    -> externalNo
   *   shortCode      what the guest reads out on the phone    -> externalPackageId
   *   expeditionType "delivery" | "pickup"
   *   price          grandTotal, subTotal, vatTotal, payRestaurant, deliveryFee,
   *                  serviceFeeTotal, discountAmountTotal, deliveryFees[]
   *   products[]     id, name, quantity, paidPrice, remoteCode, selectedToppings[]
   *
   * `paidPrice` is the money for the WHOLE line, not one unit - the till
   * stores a unit price, so it is divided by the quantity here. Getting that
   * wrong does not throw; it silently triples a bill.
   *
   * Fields are read by their published names first and by the tolerant
   * fallbacks second, because the same normaliser handles both the dispatch
   * webhook and the order-detail response, and those two have differed before.
   */
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
    const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

    const providerStatus = String(pick('status', 'orderStatus', 'providerStatus') || '');
    const expedition = String(pick('expeditionType', 'fulfillmentType') || '');
    const isPickup = /pickup|takeaway|self/i.test(expedition);

    /* deliveryFee is a single string; deliveryFees is a breakdown that must be
       summed rather than read as a number - Number([{...}]) is NaN, which then
       arrives on the bill as 0 and loses the fee. */
    const feeList = pick('price.deliveryFees');
    const deliveryFee = num(pick('price.deliveryFee', 'deliveryFee')) ||
      (Array.isArray(feeList) ? feeList.reduce((a, f) => a + num(f && (f.value !== undefined ? f.value : f.amount)), 0) : 0);

    const lines = (pick('products', 'lines', 'items') || []).map((l, i) => {
      const qty = num(l.quantity !== undefined ? l.quantity : l.qty) || 1;
      /* paidPrice is the line, unitPrice is the unit. Whichever the payload
         carries, the till is handed a unit price. */
      const unit = l.unitPrice !== undefined ? num(l.unitPrice)
        : (l.paidPrice !== undefined ? Math.round((num(l.paidPrice) / qty) * 100) / 100 : num(l.price));
      return {
        externalItemId: String(l.id || l.externalItemId || l.remoteCode || ('L' + (i + 1))),
        externalProductId: String(l.remoteCode || l.externalProductId || l.vendorProductId || l.id || ''),
        name: l.name || l.productName || 'Ürün',
        qty,
        unitPrice: unit,
        cancelled: !!l.cancelled,
        note: l.comment || l.note || null,
        modifiers: tgo.flattenModifiers(l.selectedToppings || l.toppings || l.modifiers || []),
      };
    });

    const statusKey = providerStatus.toLowerCase();
    const map = this.creds.statusMap || DEFAULT_STATUS_MAP;
    return {
      provider: this.provider,
      externalOrderId: String(pick('token', 'orderToken', 'externalOrderId', 'id') || ''),
      externalPackageId: String(pick('shortCode', 'externalPackageId', 'packageId') || ''),
      externalNo: pick('code', 'externalNo', 'shortCode'),
      providerStoreId: String(pick('platformRestaurant.id', 'providerStoreId', 'vendorCode', 'vendor.id') || ''),
      sourceApplication: pick('sourceApplication', 'platform') || 'Yemeksepeti',
      providerStatus,
      status: map[statusKey] !== undefined ? map[statusKey] : (DEFAULT_STATUS_MAP[statusKey] || null),
      fulfillmentType: isPickup ? 'PICKUP' : 'PLATFORM_COURIER',
      paymentType: pick('payment.type', 'paymentType', 'payment.method'),
      isPrepaid: tgo.prepaid(pick('payment.status', 'payment.type', 'paymentStatus', 'paymentType')),
      providerTotal: num(pick('price.grandTotal', 'providerTotal', 'totalPrice')),
      subTotal: num(pick('price.subTotal')),
      vatTotal: num(pick('price.vatTotal')),
      payRestaurant: num(pick('price.payRestaurant')),
      deliveryCharge: deliveryFee,
      serviceFee: num(pick('price.serviceFeeTotal')),
      promotionTotal: num(pick('price.vendorPromotion', 'promotionTotal')),
      couponTotal: num(pick('price.discountAmountTotal', 'couponTotal')),
      promotions: pick('discounts', 'promotions') || [],
      /* A test order must never be banked. The platform marks its own. */
      isTest: !!pick('test', 'testOrder'),
      isPreOrder: !!pick('preOrder'),
      customer: {
        label: [pick('customer.firstName'), pick('customer.lastName')].filter(Boolean).join(' ')
          || pick('customer.name', 'customerName'),
        phone: pick('customer.mobilePhone', 'customer.phone'),
        address: [pick('delivery.address.street'), pick('delivery.address.number'),
                  pick('delivery.address.postcode'), pick('delivery.address.city')]
          .filter(Boolean).join(' ') || pick('customer.address', 'deliveryAddress'),
        note: pick('comments.customerComment', 'customer.note', 'comment'),
      },
      vendorNote: pick('comments.vendorComment'),
      scheduledAt: pick('delivery.expectedDeliveryTime', 'expectedDeliveryTime'),
      riderPickupTime: pick('delivery.riderPickupTime'),
      providerCreatedAt: pick('createdAt', 'placedAt'),
      providerModifiedAt: pick('modifiedAt', 'updatedAt', 'createdAt'),
      lines,
      raw: p,
    };
  }
}

/** The simulator speaks the canonical shape, so the sim path is identical for every adapter. */
function simAction(adapter, op, args) {
  const r = sim.action(adapter.provider, op, {
    orderId: args.externalOrderId, packageId: args.externalPackageId,
    prepMinutes: args.prepMinutes, reason: args.reason });
  return r.ok ? ok({ providerStatus: r.providerStatus }) : fail('NOT_FOUND', 'Sipariş bulunamadı');
}

module.exports = { YemeksepetiAdapter, PATHS, DEFAULT_STATUS_MAP, DEFAULT_REJECT_REASONS,
  STAGE_BASE, AVAILABILITY_STATES, dhCatalog,
  STATUS_ACCEPTED, STATUS_REJECTED, STATUS_PICKED_UP };
