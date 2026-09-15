'use strict';
/**
 * The provider simulator.
 *
 * Not a mock in the test-double sense: it is a small in-process stand-in for
 * the four platforms, holding packages, statuses and menus, and it is the ONLY
 * way any of this can be demonstrated. Three of the four providers publish no
 * machine-readable specification that is reachable without a partner account,
 * and none of them will issue credentials to a sandbox - so "run the pipeline
 * end to end" has to mean "against this".
 *
 * WHICH SHAPES ARE REAL, AND WHICH ARE OURS.
 *
 * Uber Eats Trendyol Go publishes its meal integration in full at
 * developers.tgoapps.com, so `tgoPayload()` below renders THAT - the real
 * field names, the real package statuses, quantity as the length of an
 * `items` array, the address spread over eight fields. A TGO order through
 * this simulator exercises the adapter against the same JSON a real supplier
 * receives, and a mistake in our reading of the contract fails here rather
 * than on a restaurant's counter.
 *
 * The other three - Yemeksepeti, Migros Yemek, Getir - publish nothing a
 * reader can reach without a signed partner agreement, so their shapes are
 * still OURS: modelled on the vocabulary each uses in public, and not to be
 * taken as their contract. Each adapter keeps field access in ONE function,
 * `normalize`, so replacing a guessed shape with the real one when the
 * partner pack arrives is a change to that function and nothing else. That is
 * exactly how the TGO adapter was corrected.
 *
 * The simulator also does the things that are hard to provoke live and that the
 * pipeline has to survive: the same package delivered twice, an event that
 * arrives out of order, a 429, a timeout, and a cancellation after acceptance.
 */

const state = {
  packages: new Map(),   // key: provider|externalOrderId|externalPackageId
  menus: new Map(),      // key: provider|storeId -> last catalogue we sent
  open: new Map(),       // key: provider|storeId -> boolean
  prep: new Map(),
  seq: 1000,
  faults: {},            // provider -> 'timeout' | 'rate_limit' | 'auth' | '5xx' | null
  calls: [],             // every adapter call, so tests can assert on traffic
};

function key(provider, orderId, packageId) { return `${provider}|${orderId}|${packageId || ''}`; }
function now() { return new Date(); }
function iso(d) { return new Date(d).toISOString().replace('T', ' ').slice(0, 19); }

function reset() {
  state.packages.clear(); state.menus.clear(); state.open.clear(); state.prep.clear();
  state.seq = 1000; state.faults = {}; state.calls = [];
}

/** Make the next call to `provider` fail in a particular way, once. */
function injectFault(provider, kind) { state.faults[provider] = kind; }
function clearFaults() { state.faults = {}; }

function takeFault(provider) {
  const f = state.faults[provider];
  if (!f) return null;
  delete state.faults[provider];
  return f;
}

function record(provider, op, args) { state.calls.push({ provider, op, at: Date.now(), args }); }
function calls(provider, op) {
  return state.calls.filter(c => (!provider || c.provider === provider) && (!op || c.op === op));
}

/* ------------------------------------------------------------------ */
/* seeding                                                            */
/* ------------------------------------------------------------------ */
/**
 * Put an order into the platform, as if a guest had just placed it.
 *
 * The caller gives the interesting parts; everything else has a default that
 * makes a plausible Turkish delivery order - two lines, a modifier, a delivery
 * charge, a coupon and a masked customer.
 */
function seedOrder(provider, opts = {}) {
  const id = opts.externalOrderId || String(++state.seq);
  const pkg = opts.externalPackageId || String(Number(id) + 500000);
  const rec = {
    provider,
    externalOrderId: id,
    externalPackageId: pkg,
    externalNo: opts.externalNo || ('TY' + id),
    providerStoreId: String(opts.providerStoreId || 'STORE-1'),
    supplierId: String(opts.supplierId || 'SUP-1'),
    sourceApplication: opts.sourceApplication || (provider === 'UBER_EATS_TGO' ? 'TrendyolGo' : null),
    providerStatus: opts.providerStatus || 'Created',
    fulfillmentType: opts.fulfillmentType || 'PLATFORM_COURIER',
    paymentType: opts.paymentType || 'ONLINE_CARD',
    isPrepaid: opts.isPrepaid === undefined ? true : !!opts.isPrepaid,
    deliveryCharge: opts.deliveryCharge === undefined ? 24.9 : Number(opts.deliveryCharge),
    couponTotal: opts.couponTotal === undefined ? 0 : Number(opts.couponTotal),
    promotionTotal: opts.promotionTotal === undefined ? 0 : Number(opts.promotionTotal),
    promotions: opts.promotions || [],
    scheduledAt: opts.scheduledAt || null,
    customer: opts.customer || {
      name: 'Ayşe K.', phone: '0532 *** ** 41',
      address: 'Kadıköy / İstanbul — adres platformda',
      note: opts.customerNote || null,
    },
    lines: opts.lines || [
      {
        externalItemId: 'L1', externalProductId: 'P-ADANA', name: 'Adana Kebap', qty: 1,
        unitPrice: 320, modifiers: [
          { externalItemId: 'L1M1', externalId: 'M-AYRAN', name: 'Ayran', qty: 1, unitPrice: 25 },
          { externalItemId: 'L1M2', externalId: 'M-ACISIZ', name: 'Acısız', qty: 1, unitPrice: 0, removed: true },
        ],
      },
      { externalItemId: 'L2', externalProductId: 'P-KOLA', name: 'Kola 33cl', qty: 2, unitPrice: 45, modifiers: [] },
    ],
    createdAt: opts.createdAt || iso(now()),
    modifiedAt: opts.modifiedAt || iso(now()),
    events: [],
  };
  rec.providerTotal = opts.providerTotal !== undefined ? Number(opts.providerTotal) : lineSum(rec) + rec.deliveryCharge
    - rec.couponTotal - rec.promotionTotal;
  state.packages.set(key(provider, id, pkg), rec);
  return rec;
}

function lineSum(rec) {
  let s = 0;
  for (const l of rec.lines) {
    s += Number(l.qty) * Number(l.unitPrice);
    for (const m of l.modifiers || []) if (!m.removed) s += Number(m.qty || 1) * Number(m.unitPrice || 0);
  }
  return Math.round(s * 100) / 100;
}

/** Move a seeded order on, the way the platform would. */
function setProviderStatus(provider, orderId, packageId, providerStatus, extra = {}) {
  const rec = state.packages.get(key(provider, orderId, packageId));
  if (!rec) return null;
  rec.providerStatus = providerStatus;
  rec.modifiedAt = iso(now());
  Object.assign(rec, extra);
  rec.events.push({ at: rec.modifiedAt, providerStatus });
  return rec;
}

/** Cancel one line of an order - the partial cancellation some platforms allow. */
function cancelLine(provider, orderId, packageId, externalItemId) {
  const rec = state.packages.get(key(provider, orderId, packageId));
  if (!rec) return null;
  const line = rec.lines.find(l => l.externalItemId === externalItemId);
  if (!line) return null;
  line.cancelled = true;
  rec.modifiedAt = iso(now());
  rec.providerTotal = Math.round((lineSum(rec) + rec.deliveryCharge - rec.couponTotal - rec.promotionTotal) * 100) / 100;
  return rec;
}

/* ------------------------------------------------------------------ */
/* what an adapter calls                                              */
/* ------------------------------------------------------------------ */
function guard(provider) {
  const f = takeFault(provider);
  if (!f) return;
  const { ProviderError } = require('./http');
  if (f === 'timeout') throw new ProviderError('Simülasyon: zaman aşımı', { kind: 'timeout' });
  if (f === 'rate_limit') throw new ProviderError('Simülasyon: 429', { status: 429, kind: 'rate_limited' });
  if (f === 'auth') throw new ProviderError('Simülasyon: 401 - kimlik bilgileri geçersiz', { status: 401, kind: 'auth' });
  if (f === '5xx') throw new ProviderError('Simülasyon: 503', { status: 503, kind: 'transient' });
  if (f === '4xx') throw new ProviderError('Simülasyon: 400', { status: 400, kind: 'permanent' });
}

/**
 * Supplier-wide package list, incremental by modification time.
 *
 * `since` is inclusive, which is what makes the two minute overlap window in
 * the poller safe rather than lossy: a package modified in the same second as
 * the cursor is returned again and deduplicated downstream, instead of being
 * dropped because it was not strictly newer.
 */
/*
 * TGO's REAL payload shape.
 *
 * The other three providers are still served in the simulator's own generic
 * shape, because their contracts are not published. Uber Eats Trendyol Go's
 * is - developers.tgoapps.com, "Sipariş Paketlerini Çekme" - so the simulator
 * renders THAT, field for field, and the adapter's normalize() is exercised
 * against the same JSON a real supplier would receive.
 *
 * This is the difference between a test that proves the pipeline moves an
 * order and a test that proves we can read Trendyol's order. Anything the
 * simulator gets wrong here is a bug we will otherwise meet on a restaurant's
 * counter, so the shape is kept honest even where our normalizer is forgiving.
 */
function tgoPayload(rec) {
  const ms = (d) => new Date(d).getTime();
  const onDelivery = rec.paymentType && rec.paymentType !== 'ONLINE_CARD' ? rec.paymentType : null;
  return {
    id: rec.externalPackageId,                 // 64-char package id
    supplierId: Number(rec.supplierId) || rec.supplierId,
    storeId: rec.providerStoreId,
    orderCode: rec.externalNo,
    /* Any of the pickup spellings a caller might seed, folded to the one
       boolean the platform actually sends. */
    storePickupSelected: /PICK|TAKE|SELF|GEL_?AL/i.test(String(rec.fulfillmentType || '')),
    deliveryType: /STORE|RESTAURANT|MERCHANT|VENDOR|PICK|SELF/i.test(String(rec.fulfillmentType || ''))
      ? 'STORE' : 'GO',
    packageCreationDate: ms(rec.createdAt),
    packageModificationDate: ms(rec.modifiedAt),
    preparationTime: rec.preparationTime || 0,
    orderId: rec.externalOrderId,
    orderNumber: String(rec.externalNo || '').replace(/\D/g, '') || rec.externalOrderId,
    /* The platform's own total: lines, modifiers, delivery, less discounts.
       The simulator already computes it, so the wire shape must not recompute
       a different one - that is precisely the kind of drift this exists to
       catch. */
    totalPrice: Number(rec.providerTotal),
    callCenterPhone: '0212 000 00 00',
    customer: {
      id: 1, firstName: (rec.customer.name || '').split(' ')[0] || 'Musteri',
      lastName: (rec.customer.name || '').split(' ').slice(1).join(' ') || 'K',
      email: 'sim@example.invalid',
    },
    payment: {
      paymentType: rec.isPrepaid ? 'PAY_WITH_CARD' : 'PAY_WITH_ON_DELIVERY',
      mealCard: null,
      onDelivery: rec.isPrepaid ? null : (onDelivery || 'CASH'),
    },
    address: {
      firstName: (rec.customer.name || '').split(' ')[0] || 'Musteri',
      lastName: 'K', company: 'TRENDYOL',
      address1: rec.customer.address || 'Simulasyon Mah.',
      address2: '', city: 'İstanbul', cityCode: 34, district: 'Kadıköy',
      neighborhood: 'Caferağa', apartmentNumber: '9', floor: '2', doorNumber: '2',
      addressDescription: rec.customer.note || '', postalCode: '34710', countryCode: 'TR',
      phone: (rec.customer.phone || '').replace(/\D/g, '') || '5550000000',
      pinCode: '673985557',
    },
    packageStatus: rec.providerStatus,
    lines: rec.lines.map((l, i) => ({
      price: Number(l.unitPrice) * Number(l.qty || 1),
      unitSellingPrice: Number(l.unitPrice),
      /* one entry per UNIT, which is where quantity really lives */
      /*
       * One entry per unit, and the FIRST one keeps the id the caller seeded.
       *
       * The real platform issues its own opaque packageItemIds; the simulator
       * keeps the seeded one on unit zero so that a test which cancels
       * "L1" and the mirror row that stores the same id still agree. The
       * SHAPE is what this is proving - a line whose quantity lives in an
       * array - not the id format.
       */
      items: Array.from({ length: Number(l.qty) || 1 }, (_, u) => ({
        packageItemId: u === 0 && l.externalItemId ? String(l.externalItemId)
          : String(1000000000 + i * 10 + u),
        lineItemId: 2000000000 + i * 10 + u,
        isCancelled: !!l.cancelled,
        coupon: null, promotions: [],
      })),
      /* The real field is `productId` and the real value is a number; the
         simulator passes the seeded id through so a test can still map
         "P-ADANA" onto a till product. normalize() stringifies either. */
      productId: l.externalProductId !== undefined && l.externalProductId !== null
        ? l.externalProductId : (300000 + i),
      name: l.name,
      description: l.note || '',
      isClaimRateExceeded: false,
      /* A modifier is named by productId in the real payload - the same id
         space as a line product, which is what makes "map this modifier onto
         a real product and sell it as its own line" possible at all. The
         seeded id passes through for the same reason it does on lines. */
      modifierProducts: (l.modifiers || []).filter(m => !m.removed).map((m, mi) => ({
        name: m.name, price: Number(m.unitPrice) || 0,
        productId: m.externalId !== undefined && m.externalId !== null ? m.externalId : (400000 + i * 10 + mi),
        modifierGroupId: 500000 + i,
        modifierProducts: [], extraIngredients: [], removedIngredients: [], isClaimRateExceeded: false,
      })),
      extraIngredients: [],
      removedIngredients: (l.modifiers || []).filter(m => m.removed).map(m => m.name),
    })),
    customerNote: rec.customer.note || '',
    lastModifiedDate: ms(rec.modifiedAt),
    isCourierNearby: false,
    cancelInfo: null,
    eta: '15 - 36 dk',
    testPackage: true,
    pickupEtaState: '',
    estimatedPickupTimeMin: 0,
    estimatedPickupTimeMax: 0,
    /*
     * Coupon and promotions are SEPARATE money on the real payload, and the
     * simulator holds them as separate totals with one combined list of
     * names. Rendering the whole list under `promotions` would double-count
     * the coupon - which is exactly the bug this shape is here to catch - so
     * each side is rendered from its own total and borrows a name.
     */
    coupon: rec.couponTotal
      ? { name: (rec.promotions[0] && rec.promotions[0].name) || 'Kupon',
          amount: { sellerCoveredAmount: Number(rec.couponTotal) } }
      : null,
    promotions: rec.promotionTotal
      ? [{ name: (rec.promotions[rec.promotions.length - 1] || {}).name || 'Kampanya',
           amount: { sellerCoveredAmount: Number(rec.promotionTotal) } }]
      : [],
    userInformation: { appName: rec.sourceApplication || 'TrendyolGo' },
    totalDeliveryPrice: rec.deliveryCharge || null,
  };
}

/** The wire shape for a provider: TGO's real one, the generic one otherwise. */
/*
 * YEMEKSEPETI's REAL payload shape — the Delivery Hero Integration Middleware
 * order, field for field as the specification publishes it.
 *
 * Same reasoning as tgoPayload above, and the same value: without it the
 * Yemeksepeti normaliser was only ever exercised against the simulator's own
 * generic record, so it proved that the pipeline moves an order and not that
 * we can read Yemeksepeti's order. The two differ in the places that cost
 * money — `paidPrice` is the whole LINE and not one unit, the delivery fee has
 * a single-value form and a breakdown form, and the toppings live under
 * `selectedToppings`.
 */
function dhPayload(rec) {
  const st = String(rec.providerStatus || '').toLowerCase();
  const names = String(rec.customer.name || '').trim().split(/\s+/);
  const money = (v) => (Math.round(Number(v || 0) * 100) / 100).toFixed(2);
  return {
    token: rec.externalOrderId,
    code: rec.externalNo,
    shortCode: rec.externalPackageId,
    createdAt: rec.createdAt,
    test: true,
    preOrder: !!rec.scheduledAt,
    status: st === 'created' ? '' : st,
    expeditionType: /PICK|TAKE|SELF|GEL_?AL/i.test(String(rec.fulfillmentType || '')) ? 'pickup' : 'delivery',
    platformRestaurant: { id: rec.providerStoreId },
    customer: {
      id: '1', code: 'C1',
      firstName: names[0] || 'Musteri',
      lastName: names.slice(1).join(' ') || 'K',
      email: 'sim@example.invalid',
      mobilePhone: (rec.customer.phone || '').replace(/\D/g, '') || '5550000000',
      mobilePhoneCountryCode: '+90',
      flags: [],
    },
    delivery: {
      address: { postcode: '34710', city: 'İstanbul', street: rec.customer.address || 'Simulasyon Mah.', number: '9' },
      expectedDeliveryTime: rec.scheduledAt || rec.modifiedAt,
      expressDelivery: false,
      riderPickupTime: rec.modifiedAt,
    },
    comments: { customerComment: rec.customer.note || '', vendorComment: '' },
    products: rec.lines.map((l, i) => ({
      id: String(l.externalItemId || ('L' + (i + 1))),
      remoteCode: String(l.externalProductId || ''),
      name: l.name,
      quantity: Number(l.qty) || 1,
      /* the LINE total, which is the trap this shape exists to spring */
      paidPrice: money(Number(l.unitPrice) * (Number(l.qty) || 1)),
      selectedToppings: (l.modifiers || []).filter(m => !m.removed).map(m => ({
        id: String(m.externalId || m.externalItemId || ''),
        remoteCode: String(m.externalId || ''),
        name: m.name,
        quantity: Number(m.qty) || 1,
        paidPrice: money(Number(m.unitPrice) || 0),
      })),
    })),
    price: {
      grandTotal: money(rec.providerTotal),
      subTotal: money(lineSum(rec)),
      vatTotal: money(Number(rec.providerTotal) - Number(rec.providerTotal) / 1.1),
      payRestaurant: money(Number(rec.providerTotal) - Number(rec.deliveryCharge || 0)),
      deliveryFee: money(rec.deliveryCharge || 0),
      serviceFeeTotal: '0.00',
      discountAmountTotal: money(rec.couponTotal || 0),
      deliveryFees: [{ name: 'Teslimat', value: money(rec.deliveryCharge || 0) }],
    },
    payment: {
      status: rec.isPrepaid ? 'paid' : 'pending',
      type: rec.isPrepaid ? 'online' : 'cash',
      remoteCode: rec.paymentType || null,
    },
    discounts: rec.promotions || [],
    localInfo: { countryCode: 'tr', currencySymbol: '₺', platform: 'Yemeksepeti' },
  };
}

function wire(rec) {
  if (rec.provider === 'UBER_EATS_TGO') return tgoPayload(rec);
  if (rec.provider === 'YEMEKSEPETI') return dhPayload(rec);
  return rec;
}

function packages(provider, { supplierId = null, since = null, storeIds = null, statuses = null } = {}) {
  guard(provider);
  record(provider, 'packages', { supplierId, since });
  const out = [];
  for (const rec of state.packages.values()) {
    if (rec.provider !== provider) continue;
    if (supplierId && rec.supplierId !== String(supplierId)) continue;
    if (storeIds && storeIds.length && !storeIds.includes(rec.providerStoreId)) continue;
    if (statuses && statuses.length && !statuses.includes(rec.providerStatus)) continue;
    if (since && new Date(rec.modifiedAt) < new Date(since)) continue;
    out.push(wire(JSON.parse(JSON.stringify(rec))));
  }
  out.sort((a, b) => new Date(a.modifiedAt) - new Date(b.modifiedAt));
  return out;
}

function detail(provider, orderId, packageId) {
  guard(provider);
  record(provider, 'detail', { orderId, packageId });
  const rec = state.packages.get(key(provider, orderId, packageId));
  return rec ? wire(JSON.parse(JSON.stringify(rec))) : null;
}

function action(provider, op, { orderId, packageId, ...rest } = {}) {
  guard(provider);
  record(provider, op, { orderId, packageId, ...rest });
  const rec = state.packages.get(key(provider, orderId, packageId));
  if (!rec) return { ok: false, error: 'not found' };
  const map = {
    accept: 'Accepted', reject: 'Rejected', markPreparing: 'Preparing', markReady: 'Prepared',
    markDispatched: 'Picked', markDelivered: 'Delivered', cancel: 'Cancelled',
  };
  if (map[op]) { rec.providerStatus = map[op]; rec.modifiedAt = iso(now()); }
  if (op === 'accept' && rest.prepMinutes) rec.prepMinutes = rest.prepMinutes;
  if (op === 'reject' && rest.reason) rec.rejectReason = rest.reason;
  return { ok: true, providerStatus: rec.providerStatus };
}

function submitMenu(provider, storeId, catalogue) {
  guard(provider);
  record(provider, 'submitMenu', { storeId, items: (catalogue && catalogue.products || []).length });
  state.menus.set(provider + '|' + storeId, { catalogue, at: iso(now()) });
  return { ok: true, accepted: (catalogue && catalogue.products || []).length };
}
function lastMenu(provider, storeId) { return state.menus.get(provider + '|' + storeId) || null; }

function setOpen(provider, storeId, isOpen) {
  guard(provider);
  record(provider, 'setOpen', { storeId, isOpen });
  state.open.set(provider + '|' + storeId, !!isOpen);
  return { ok: true, open: !!isOpen };
}
function isOpen(provider, storeId) {
  const v = state.open.get(provider + '|' + storeId);
  return v === undefined ? true : v;
}

function setPrep(provider, storeId, minutes) {
  guard(provider);
  record(provider, 'setPrep', { storeId, minutes });
  state.prep.set(provider + '|' + storeId, Number(minutes));
  return { ok: true, minutes: Number(minutes) };
}
function prepTime(provider, storeId) { return state.prep.get(provider + '|' + storeId) || null; }

/** The menu the platform believes it has, for a mapping screen with no live API. */
function providerCatalogue(provider, storeId) {
  const saved = lastMenu(provider, storeId);
  if (saved) {
    return {
      categories: (saved.catalogue.categories || []).map(c => ({ id: c.externalId || c.id, name: c.name })),
      products: (saved.catalogue.products || []).map(p => ({
        id: p.externalId || p.id, name: p.name, price: p.price, categoryId: p.categoryId, available: p.available !== false,
      })),
      modifierGroups: saved.catalogue.modifierGroups || [],
    };
  }
  /* Before anything has been pushed the platform still has a menu - the one
     the restaurant typed into the platform's own panel years ago. This is that
     menu, and it deliberately does NOT match the POS menu exactly: automatic
     mapping that only ever sees a perfect list has never been tested. */
  return {
    categories: [{ id: 'C-KEBAP', name: 'Kebaplar' }, { id: 'C-ICECEK', name: 'İçecekler' }],
    products: [
      { id: 'P-ADANA', name: 'Adana Kebap', price: 320, categoryId: 'C-KEBAP', available: true },
      { id: 'P-URFA', name: 'Urfa Kebap', price: 320, categoryId: 'C-KEBAP', available: true },
      { id: 'P-KOLA', name: 'Kola 33cl', price: 45, categoryId: 'C-ICECEK', available: true },
      { id: 'P-BILINMEYEN', name: 'Platforma Özel Menü', price: 500, categoryId: 'C-KEBAP', available: true },
    ],
    modifierGroups: [
      { id: 'G-ICECEK', name: 'İçecek seçimi', modifiers: [
        { id: 'M-AYRAN', name: 'Ayran', price: 25 }, { id: 'M-SODA', name: 'Soda', price: 20 }] },
      { id: 'G-EKSTRA', name: 'Ekstralar', modifiers: [
        { id: 'M-ACISIZ', name: 'Acısız', price: 0 }, { id: 'M-EKSTRAPEYNIR', name: 'Ekstra peynir', price: 35 }] },
    ],
  };
}

module.exports = {
  reset, seedOrder, setProviderStatus, cancelLine, packages, detail, action,
  submitMenu, lastMenu, setOpen, isOpen, setPrep, prepTime, providerCatalogue,
  injectFault, clearFaults, calls, state,
};
