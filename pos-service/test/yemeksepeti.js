'use strict';
/**
 * YEMEKSEPETİ — the adapter against the published contract, with no credentials.
 *
 * test/entegrasyon.js proves the ORDER PIPELINE: a platform order becomes a
 * bill, prints once, is accepted, is paid. It proves that with the simulator,
 * which is the right tool for a pipeline and the wrong one for a protocol -
 * the simulator answers whatever we ask it, so it can never tell us that we
 * are asking the wrong thing.
 *
 * This suite asks the wrong thing on purpose. It stands a STUB MIDDLEWARE in
 * front of the adapter that implements the Delivery Hero Integration
 * Middleware v2 specification and nothing else: it checks the path, the verb,
 * the bearer token, the body, and it VALIDATES the catalogue the way the real
 * importer does - every reference must resolve, there must be at least one
 * category, every product must belong to one. Anything the adapter invents,
 * misspells or nests wrongly is a 4xx here rather than an empty menu on a
 * restaurant's Yemeksepeti listing.
 *
 * No credentials are needed and none are used. The username and password below
 * are the stub's own; a restaurant types its real pair into the Entegrasyonlar
 * screen and the same code paths run against the real host.
 *
 * WHAT THIS CANNOT PROVE: that Delivery Hero's production host behaves like
 * its published specification. Nothing short of partner credentials can. What
 * it does prove is that if the specification is right, we are right.
 *
 * Run:  node test/yemeksepeti.js
 */
const assert = require('assert');
const http = require('http');
const { YemeksepetiAdapter, _PATHS, dhCatalog, AVAILABILITY_STATES } = require('../src/integrations/adapters/yemeksepeti');

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

const CHAIN = 'CHAIN-1';
const VENDOR = 'VENDOR-1';
const USER = 'nokuser';
const PASS = 'nokpass';
const TOKEN = 'stub-access-token';

/* ------------------------------------------------------------------ *
 * The stub middleware                                                 *
 * ------------------------------------------------------------------ */
const seen = [];                 // every request it received, in order
let nextStatus = null;           // force the next order-status answer

/** The importer's own validation rules, as the specification states them. */
function validateCatalog(body) {
  if (!body || !body.catalog || !body.catalog.items) return 'catalog.items yok';
  if (!Array.isArray(body.vendors) || !body.vendors.length) return 'vendors yok';
  const items = body.catalog.items;
  const types = {};
  for (const [k, it] of Object.entries(items)) {
    if (!it.id) return k + ': id yok';
    if (String(it.id) !== String(k)) return k + ': anahtar ve id farklı';
    if (!it.type) return k + ': type yok';
    if (!it.title || typeof it.title.default !== 'string') return k + ': title.default yok';
    types[it.type] = (types[it.type] || 0) + 1;
    if (it.type === 'Product') {
      if (typeof it.price !== 'string') return k + ': price bir string olmalı';
      if (!/^\d+\.\d{2}$/.test(it.price)) return k + ': price biçimi hatalı (' + it.price + ')';
      if (typeof it.active !== 'boolean') return k + ': active boolean olmalı';
    }
    if (it.type === 'Topping') {
      if (!it.quantity || typeof it.quantity.minimum !== 'number' || typeof it.quantity.maximum !== 'number') {
        return k + ': quantity.minimum/maximum yok';
      }
      if (!it.products || !Object.keys(it.products).length) return k + ': topping ürünsüz';
    }
    if (it.type === 'Menu' && !it.menuType) return k + ': menuType yok';
    /* every reference must resolve to a full item in the same map */
    for (const field of ['products', 'toppings']) {
      for (const [rk, rv] of Object.entries(it[field] || {})) {
        if (!items[rk]) return k + '.' + field + ': çözümlenemeyen referans ' + rk;
        if (!rv || !rv.id || !rv.type) return k + '.' + field + '.' + rk + ': referansta id/type yok';
        if (items[rk].type !== rv.type) return k + '.' + field + '.' + rk + ': referans tipi uyuşmuyor';
      }
    }
  }
  if (!types.Category) return 'en az bir kategori gerekli';
  if (!types.Menu) return 'menü yok';
  /* every product must belong to a category (toppings' own products excepted) */
  const inCategory = new Set();
  const inTopping = new Set();
  for (const it of Object.values(items)) {
    if (it.type === 'Category') for (const k of Object.keys(it.products || {})) inCategory.add(k);
    if (it.type === 'Topping') for (const k of Object.keys(it.products || {})) inTopping.add(k);
  }
  for (const [k, it] of Object.entries(items)) {
    if (it.type !== 'Product') continue;
    if (!inCategory.has(k) && !inTopping.has(k)) return k + ': hiçbir kategoriye ait değil';
  }
  return null;
}

function stub() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = { unparsable: raw }; }
      seen.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body,
        auth: req.headers.authorization || '' });

      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      };

      /* --- login: the only unauthenticated door --------------------- */
      if (req.method === 'POST' && path === '/v2/login') {
        if (!body || body.grant_type !== 'client_credentials') {
          return send(400, { error: 'grant_type client_credentials olmalı' });
        }
        if (body.username !== USER || body.password !== PASS) return send(401, { error: 'bad credentials' });
        return send(200, { access_token: TOKEN, expires_in: 1800, token_type: 'bearer' });
      }
      if ((req.headers.authorization || '') !== 'Bearer ' + TOKEN) return send(401, { error: 'unauthorized' });

      /* --- orders --------------------------------------------------- */
      let m = path.match(/^\/v2\/order\/status\/([^/]+)$/);
      if (req.method === 'POST' && m) {
        if (!body || !['order_accepted', 'order_rejected', 'order_picked_up'].includes(body.status)) {
          return send(400, { error: 'geçersiz status' });
        }
        if (!body.acceptanceTime || Number.isNaN(Date.parse(body.acceptanceTime))) {
          return send(400, { error: 'acceptanceTime ISO olmalı' });
        }
        if (nextStatus) { const n = nextStatus; nextStatus = null; return send(n.code, n.body); }
        return send(200, { code: 'OK' });
      }
      m = path.match(/^\/v2\/orders\/([^/]+)\/preparation-completed$/);
      if (req.method === 'POST' && m) return send(200, { code: 'OK' });

      m = path.match(/^\/v2\/chains\/([^/]+)\/orders\/ids$/);
      if (req.method === 'GET' && m) {
        if (m[1] !== CHAIN) return send(404, { error: 'chain yok' });
        const h = Number(url.searchParams.get('pastNumberOfHours'));
        if (!(h >= 1 && h <= 24)) return send(400, { error: 'pastNumberOfHours 1-24 olmalı' });
        return send(200, { orderIdentifiers: [{ orderId: 'ORD-1' }, { orderId: 'ORD-2' }], count: 2 });
      }
      m = path.match(/^\/v2\/chains\/([^/]+)\/orders\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        if (m[2] === 'MISSING') return send(404, { error: 'order yok' });
        return send(200, sampleOrder(m[2]));
      }

      /* --- catalogue ------------------------------------------------ */
      m = path.match(/^\/v2\/chains\/([^/]+)\/catalog$/);
      if (req.method === 'POST' && m) {
        if (m[1] !== CHAIN) return send(404, { error: 'chain yok' });
        const bad = validateCatalog(body);
        if (bad) return send(400, { error: 'katalog reddedildi: ' + bad });
        return send(200, { catalogImportId: 'IMP-1', status: 'QUEUED' });
      }
      m = path.match(/^\/v2\/chains\/([^/]+)\/vendors\/([^/]+)\/catalog\/items\/availability$/);
      if (req.method === 'PUT' && m) {
        if (!body || !body.globalEntityId) return send(400, { error: 'globalEntityId gerekli' });
        if (!Array.isArray(body.items) || !body.items.length) return send(400, { error: 'items gerekli' });
        if (!['ITEM', 'TOPPING'].includes(body.type)) return send(400, { error: 'type ITEM/TOPPING olmalı' });
        if (typeof body.isAvailable !== 'boolean') return send(400, { error: 'isAvailable boolean olmalı' });
        return send(204);
      }

      /* --- vendors and availability --------------------------------- */
      m = path.match(/^\/v2\/chains\/([^/]+)\/vendors\/([^/]+)\/platform-vendors$/);
      if (req.method === 'GET' && m) {
        return send(200, [
          { platformVendorId: 'YS-9001', globalEntityId: 'YS_TR', posVendorId: VENDOR, platformKey: 'YS' },
          { platformVendorId: 'FP-4002', globalEntityId: 'FP_TR', posVendorId: VENDOR, platformKey: 'FP' },
        ]);
      }
      m = path.match(/^\/v2\/chains\/([^/]+)\/remoteVendors\/([^/]+)\/availability$/);
      if (m && req.method === 'GET') {
        return send(200, [{ availabilityState: 'OPEN', changeable: true, platformKey: 'YS', platformRestaurantId: 'YS-9001' }]);
      }
      if (m && req.method === 'PUT') {
        if (!body || !AVAILABILITY_STATES.includes(body.availabilityState)) {
          return send(400, { error: 'availabilityState geçersiz' });
        }
        if (!body.platformKey || !body.platformRestaurantId) {
          return send(400, { error: 'platformKey ve platformRestaurantId gerekli' });
        }
        return send(200, { code: 'OK' });
      }

      return send(404, { error: 'bilinmeyen uç nokta: ' + req.method + ' ' + path });
    });
  });
}

/** A Delivery Hero order, in the published shape. */
function sampleOrder(token) {
  return {
    token, code: 'YS-' + token, shortCode: 'AB12',
    createdAt: '2026-09-12T18:40:00Z',
    test: true, preOrder: false,
    expeditionType: 'delivery',
    platformRestaurant: { id: VENDOR },
    customer: { firstName: 'Ayşe', lastName: 'Kaya', mobilePhone: '5551112233',
      mobilePhoneCountryCode: '+90', email: 'a@example.invalid', flags: [] },
    delivery: { address: { postcode: '34710', city: 'İstanbul', street: 'Moda Cad.', number: '9' },
      expectedDeliveryTime: '2026-09-12T19:15:00Z', expressDelivery: false, riderPickupTime: '2026-09-12T19:00:00Z' },
    comments: { customerComment: 'Zili çalmayın', vendorComment: 'Acısız olsun' },
    products: [
      { id: 'L1', remoteCode: 'P-ADANA', name: 'Adana Kebap', quantity: 3, paidPrice: '960.00',
        selectedToppings: [{ id: 'T1', remoteCode: 'M-AYRAN', name: 'Ayran', quantity: 1, paidPrice: '25.00' }] },
      { id: 'L2', remoteCode: 'P-KOLA', name: 'Kola', quantity: 2, paidPrice: '90.00', selectedToppings: [] },
    ],
    price: { grandTotal: '1099.90', subTotal: '1075.00', vatTotal: '99.99', payRestaurant: '1075.00',
      deliveryFee: '24.90', serviceFeeTotal: '0.00', discountAmountTotal: '0.00',
      deliveryFees: [{ name: 'Teslimat', value: '24.90' }] },
    payment: { status: 'paid', type: 'online', remoteCode: 'CC' },
    discounts: [],
  };
}

/* ------------------------------------------------------------------ */
(async () => {
  const server = stub();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  console.log('\nNOKTApp POS - Yemeksepeti sözleşmesi\n');

  const make = (over = {}) => new YemeksepetiAdapter(
    { provider: 'YEMEKSEPETI', environment: 'stage', acceptance_mode: 'POS_DIRECT',
      provider_store_id: VENDOR, chain_id: CHAIN, default_prep_minutes: 25, branch_id: 1, ...over.conn },
    { username: USER, password: PASS, stageBase: BASE, ...over.creds });

  const last = (method, re) => [...seen].reverse().find(s => s.method === method && re.test(s.path));

  /* =============================================== 1. authentication */

  await step('oturum: /v2/login, client_credentials, ve jeton expires_in kadar saklanır', async () => {
    seen.length = 0;
    const a = make();
    const t1 = await a.token();
    assert.strictEqual(t1, TOKEN, 'jeton alınamadı');
    const login = seen.filter(s => s.path === '/v2/login');
    assert.strictEqual(login.length, 1, 'login bir kez çağrılmalıydı, ' + login.length + ' kez çağrıldı');
    assert.strictEqual(login[0].body.grant_type, 'client_credentials', 'grant_type gönderilmedi');
    await a.token();
    assert.strictEqual(seen.filter(s => s.path === '/v2/login').length, 1, 'jeton önbelleğe alınmadı');
    /* retired a minute early, from the answer and not from a guess */
    assert.ok(a._tokenExp - Date.now() <= 1740 * 1000, 'jeton süresi cevaptan alınmadı');
    assert.ok(a._tokenExp - Date.now() > 1700 * 1000, 'jeton gereğinden erken atıldı');
  });

  await step('yanlış şifre kimlik hatası olarak döner, başka bir şey olarak değil', async () => {
    const a = make({ creds: { password: 'yanlis' } });
    const r = await a.call('testConnection', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'INVALID_CREDENTIALS', 'kod: ' + r.code);
  });

  await step('zincir kodu ya da restoran kodu boşsa canlıya hiç çıkılmaz', async () => {
    seen.length = 0;
    const a = make({ conn: { chain_id: '' } });
    const r = await a.call('testConnection', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NOT_CONFIGURED', 'kod: ' + r.code);
    assert.strictEqual(seen.length, 0, 'eksik yapılandırmayla ağa çıkıldı');
  });

  /* ==================================================== 2. the order */

  await step('sipariş detayı yayımlanmış yoldan okunur', async () => {
    const a = make();
    const r = await a.call('getOrder', { externalOrderId: 'ORD-7' });
    assert.ok(r.ok, JSON.stringify(r));
    const hit = last('GET', /orders/);
    assert.strictEqual(hit.path, `/v2/chains/${CHAIN}/orders/ORD-7`, 'yol: ' + hit.path);
  });

  await step('olmayan bir sipariş NOT_FOUND olur, sonsuza kadar denenen bir hata değil', async () => {
    const a = make();
    const r = await a.call('getOrder', { externalOrderId: 'MISSING' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NOT_FOUND', 'kod: ' + r.code);
    assert.strictEqual(r.retryable, false, '404 yeniden denenebilir işaretlendi');
  });

  await step('sipariş okunurken satır birim fiyatı paidPrice/adet olur - üçe katlanmaz', async () => {
    const a = make();
    const r = await a.call('getOrder', { externalOrderId: 'ORD-7' });
    const o = r.order;
    const adana = o.lines.find(l => l.externalProductId === 'P-ADANA');
    assert.strictEqual(adana.qty, 3, 'adet okunamadı');
    assert.strictEqual(adana.unitPrice, 320, 'birim fiyat ' + adana.unitPrice + ' (960/3 = 320 olmalı)');
    const kola = o.lines.find(l => l.externalProductId === 'P-KOLA');
    assert.strictEqual(kola.unitPrice, 45, 'birim fiyat ' + kola.unitPrice);
    assert.strictEqual(adana.modifiers.length, 1, 'selectedToppings okunmadı');
    assert.strictEqual(adana.modifiers[0].name, 'Ayran');
  });

  await step('para ve adres alanları yayımlanmış adlarıyla okunur', async () => {
    const a = make();
    const { order: o } = await a.call('getOrder', { externalOrderId: 'ORD-7' });
    assert.strictEqual(o.providerTotal, 1099.9, 'grandTotal');
    assert.strictEqual(o.subTotal, 1075, 'subTotal');
    assert.strictEqual(o.vatTotal, 99.99, 'vatTotal');
    assert.strictEqual(o.deliveryCharge, 24.9, 'deliveryFee');
    assert.strictEqual(o.externalOrderId, 'ORD-7', 'token');
    assert.strictEqual(o.externalNo, 'YS-ORD-7', 'code');
    assert.strictEqual(o.externalPackageId, 'AB12', 'shortCode');
    assert.strictEqual(o.fulfillmentType, 'PLATFORM_COURIER', 'expeditionType');
    assert.strictEqual(o.isPrepaid, true, 'payment.status okunmadı');
    assert.strictEqual(o.isTest, true, 'test siparişi işaretlenmedi');
    assert.strictEqual(o.customer.label, 'Ayşe Kaya', 'müşteri adı: ' + o.customer.label);
    assert.ok(/Moda Cad\. 9/.test(o.customer.address), 'adres: ' + o.customer.address);
    assert.strictEqual(o.customer.note, 'Zili çalmayın', 'müşteri notu');
    assert.strictEqual(o.vendorNote, 'Acısız olsun', 'restoran notu');
  });

  await step('teslimat ücreti yalnızca dizi olarak geldiğinde de toplanır', async () => {
    const a = make();
    const raw = sampleOrder('X');
    delete raw.price.deliveryFee;
    raw.price.deliveryFees = [{ name: 'Teslimat', value: '15.00' }, { name: 'Küçük sepet', value: '9.90' }];
    const o = a.normalize(raw);
    assert.strictEqual(o.deliveryCharge, 24.9, 'dizi toplanmadı: ' + o.deliveryCharge);
  });

  await step('gel-al siparişi kurye siparişiyle karıştırılmaz', async () => {
    const a = make();
    const raw = sampleOrder('X'); raw.expeditionType = 'pickup';
    assert.strictEqual(a.normalize(raw).fulfillmentType, 'PICKUP');
  });

  /* ============================================ 3. the status calls */

  await step('onay: POST /v2/order/status/{token}, order_accepted, ISO acceptanceTime', async () => {
    seen.length = 0;
    const a = make();
    const r = await a.call('accept', { externalOrderId: 'ORD-7', prepMinutes: 30, remoteOrderId: '4021' });
    assert.ok(r.ok, JSON.stringify(r));
    const hit = last('POST', /order\/status/);
    assert.strictEqual(hit.path, '/v2/order/status/ORD-7', 'yol: ' + hit.path);
    assert.strictEqual(hit.body.status, 'order_accepted');
    assert.strictEqual(hit.body.remoteOrderId, '4021', 'kasanın adisyon numarası gönderilmedi');
    const at = Date.parse(hit.body.acceptanceTime);
    assert.ok(!Number.isNaN(at), 'acceptanceTime ISO değil');
    const mins = Math.round((at - Date.now()) / 60000);
    assert.ok(mins >= 29 && mins <= 31, 'hazırlama süresi taşınmadı: ' + mins + ' dk');
  });

  await step('ret: onaylı sebep listesi dışında bir kod ağa hiç çıkmaz', async () => {
    seen.length = 0;
    const a = make();
    const bad = await a.call('reject', { externalOrderId: 'ORD-7', reasonCode: 'UYDURMA' });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.code, 'INVALID_REJECT_REASON');
    assert.strictEqual(seen.filter(s => /order\/status/.test(s.path)).length, 0, 'geçersiz kod gönderildi');
    const good = await a.call('reject', { externalOrderId: 'ORD-7', reasonCode: 'KITCHEN_BUSY', reason: 'Çok yoğun' });
    assert.ok(good.ok, JSON.stringify(good));
    const hit = last('POST', /order\/status/);
    assert.strictEqual(hit.body.status, 'order_rejected');
    assert.strictEqual(hit.body.reason, 'KITCHEN_BUSY');
  });

  await step('hazır ve yola çıktı, her biri kendi uç noktasından', async () => {
    seen.length = 0;
    const a = make();
    assert.ok((await a.call('markReady', { externalOrderId: 'ORD-7' })).ok, 'hazır bildirimi');
    assert.strictEqual(last('POST', /preparation-completed/).path,
      '/v2/orders/ORD-7/preparation-completed', 'hazır yolu');
    assert.ok((await a.call('markDispatched', { externalOrderId: 'ORD-7' })).ok, 'yola çıktı bildirimi');
    assert.strictEqual(last('POST', /order\/status/).body.status, 'order_picked_up');
  });

  await step('409: sipariş tablette kabul edilmişse durum okunur, sonsuza dek denenmez', async () => {
    const a = make();
    nextStatus = { code: 409, body: { currentState: 'accepted' } };
    const r = await a.call('accept', { externalOrderId: 'ORD-7' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'ALREADY_IN_STATE', 'kod: ' + r.code);
    assert.ok(/accepted/.test(r.message), 'mevcut durum kullanıcıya söylenmedi: ' + r.message);
    assert.strictEqual(r.retryable, false, '409 yeniden denenebilir işaretlendi');
  });

  await step('tablet kipinde onay/ret düğmeleri hiç açılmaz', async () => {
    const a = make({ conn: { acceptance_mode: 'PROVIDER_TABLET' } });
    const caps = a.capabilities();
    assert.strictEqual(caps.accept, false, 'tablet kipinde onay açık');
    assert.strictEqual(caps.reject, false, 'tablet kipinde ret açık');
    const r = await a.call('accept', { externalOrderId: 'ORD-7' });
    assert.strictEqual(r.code, 'CAPABILITY_NOT_SUPPORTED', 'kod: ' + r.code);
  });

  /* ================================================= 4. the catalogue */

  const menu = {
    categories: [
      { externalId: 'C-KEBAP', name: 'Kebaplar', sortOrder: 1 },
      { externalId: 'C-ICECEK', name: 'İçecekler', sortOrder: 2 },
      { externalId: 'C-BOS', name: 'Boş Kategori', sortOrder: 3 },
    ],
    products: [
      { externalId: 'P-ADANA', categoryId: 'C-KEBAP', name: 'Adana Kebap', price: 320, vatRate: 10, available: true },
      { externalId: 'P-URFA', categoryId: 'C-KEBAP', name: 'Urfa Kebap', price: 310, vatRate: 10, available: false },
      { externalId: 'P-KOLA', categoryId: 'C-ICECEK', name: 'Kola', price: 45, vatRate: 10, available: true },
    ],
    modifierGroups: [
      { externalId: 'G-YAN', name: 'Yanına', min: 0, max: 2, productIds: ['P-ADANA'],
        options: [{ externalId: 'M-AYRAN', name: 'Ayran', price: 25 },
                  { externalId: 'M-SALATA', name: 'Salata', price: 40 }] },
    ],
  };

  await step('menü, içe aktarıcının kabul ettiği tek düz haritaya çevrilir', async () => {
    seen.length = 0;
    const a = make();
    const r = await a.call('syncMenu', { catalogue: menu });
    assert.ok(r.ok, 'katalog reddedildi: ' + JSON.stringify(r));
    assert.strictEqual(r.catalogImportId, 'IMP-1', 'içe aktarma kimliği okunmadı');
    const hit = last('POST', /\/catalog$/);
    assert.strictEqual(hit.path, `/v2/chains/${CHAIN}/catalog`, 'yol: ' + hit.path);
    assert.deepStrictEqual(hit.body.vendors, [VENDOR], 'vendors');
    const items = hit.body.catalog.items;
    assert.ok(items['NOK-MENU-DELIVERY'], 'menü öğesi yok');
    assert.strictEqual(items['NOK-MENU-DELIVERY'].menuType, 'DELIVERY');
    assert.strictEqual(items['P-ADANA'].price, '320.00', 'fiyat iki hanelik metin değil: ' + items['P-ADANA'].price);
    assert.strictEqual(items['P-URFA'].active, false, 'kapalı ürün açık gönderildi');
    assert.ok(items['G-YAN'], 'topping grubu yok');
    assert.deepStrictEqual(items['G-YAN'].quantity, { minimum: 0, maximum: 2 }, 'adet sınırı');
    assert.ok(items['P-ADANA'].toppings && items['P-ADANA'].toppings['G-YAN'], 'ürün toppingine bağlanmadı');
  });

  await step('ürünsüz kategori gönderilmez - boş başlık müşteriye görünmez', async () => {
    const hit = last('POST', /\/catalog$/);
    assert.ok(!hit.body.catalog.items['C-BOS'], 'boş kategori gönderildi');
    assert.ok(hit.body.catalog.items['C-KEBAP'], 'dolu kategori gitmedi');
  });

  await step('bozuk bir menü stub tarafından reddedilir - doğrulayıcı gerçekten çalışıyor', async () => {
    const orphan = { categories: [], products: [{ externalId: 'P-YETIM', categoryId: 'C-YOK', name: 'Yetim', price: 10 }],
      modifierGroups: [] };
    const cat = dhCatalog(orphan);
    assert.ok(!Object.values(cat.items).some(i => i.type === 'Category'), 'kategori beklenmiyordu');
    const a = make();
    const r = await a.call('syncMenu', { catalogue: orphan });
    assert.strictEqual(r.ok, false, 'kategorisiz katalog kabul edildi');
  });

  await step('fiyat değişikliği katalog içe aktarımıdır, ayrı bir uç nokta değil', async () => {
    seen.length = 0;
    const a = make();
    const r = await a.call('updateProductPrice', { catalogue: menu });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(last('POST', /\/catalog$/), 'katalog gönderilmedi');
  });

  /* =========================================== 5. availability */

  await step('ürün açma/kapama globalEntityId ile gider ve o kimlik eşleşmeden okunur', async () => {
    seen.length = 0;
    const a = make();
    const r = await a.call('updateProductAvailability', { items: ['P-ADANA'], available: false });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(last('GET', /platform-vendors/), 'platform eşleşmesi okunmadı');
    const hit = last('PUT', /items\/availability/);
    assert.strictEqual(hit.path, `/v2/chains/${CHAIN}/vendors/${VENDOR}/catalog/items/availability`, 'yol: ' + hit.path);
    assert.strictEqual(hit.body.globalEntityId, 'YS_TR', 'globalEntityId: ' + hit.body.globalEntityId);
    assert.deepStrictEqual(hit.body.items, ['P-ADANA']);
    assert.strictEqual(hit.body.type, 'ITEM');
    assert.strictEqual(hit.body.isAvailable, false);
  });

  await step('restoranı kapatmak, listelendiği HER platformda tek tek yapılır', async () => {
    seen.length = 0;
    const a = make();
    const r = await a.call('setRestaurantOpen', { open: false });
    assert.ok(r.ok, JSON.stringify(r));
    const puts = seen.filter(s => s.method === 'PUT' && /remoteVendors/.test(s.path));
    assert.strictEqual(puts.length, 2, 'iki platform bekleniyordu, ' + puts.length + ' istek gitti');
    assert.strictEqual(puts[0].body.availabilityState, 'CLOSED');
    assert.deepStrictEqual(puts.map(p => p.body.platformRestaurantId).sort(), ['FP-4002', 'YS-9001']);
    assert.strictEqual(r.updated, 2, 'güncellenen sayısı: ' + r.updated);
  });

  await step('platform eşleşmesi on dakika saklanır - kapat/aç her seferinde üç istek değildir', async () => {
    seen.length = 0;
    const a = make();
    await a.call('setRestaurantOpen', { open: false });
    await a.call('setRestaurantOpen', { open: true });
    assert.strictEqual(seen.filter(s => /platform-vendors/.test(s.path)).length, 1,
      'eşleşme her çağrıda yeniden okundu');
  });

  /* ============================================ 6. reconciliation */

  await step('kaçan webhook, sipariş kimlikleri üzerinden telafi edilir', async () => {
    seen.length = 0;
    const a = make();
    const r = await a.call('fetchOrders', { sinceHours: 6 });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.orders.length, 2, 'iki sipariş bekleniyordu');
    const ids = seen.find(s => /orders\/ids/.test(s.path));
    assert.strictEqual(ids.query.pastNumberOfHours, '6', 'pencere taşınmadı');
    assert.strictEqual(ids.query.vendorId, VENDOR, 'restoran kodu gönderilmedi');
    assert.strictEqual(ids.query.status, 'accepted', 'durum süzgeci gönderilmedi');
    assert.ok(r.orders.every(o => o.externalOrderId), 'siparişler çözümlenmedi');
  });

  await step('pencere 24 saatle sınırlanır - platformun kabul ettiği aralık', async () => {
    seen.length = 0;
    const a = make();
    const r = await a.call('fetchOrders', { sinceHours: 999 });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(seen.find(s => /orders\/ids/.test(s.path)).query.pastNumberOfHours, '24');
  });

  /* ================================================ 7. health */

  await step('bağlantı testi oturum açar ve restoran durumunu okur', async () => {
    const a = make();
    const r = await a.call('testConnection', {});
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(last('GET', /remoteVendors/), 'durum okunmadı');
  });

  await step('sağlık kaydı hangi işlemin yayımlanmış olduğunu dürüstçe söyler', async () => {
    const a = make();
    const r = await a.call('health', {});
    assert.ok(r.verifiedOperations.includes('orderStatus'), 'doğrulanmış işlemler eksik');
    assert.deepStrictEqual(r.unverifiedOperations, ['cancel'],
      'doğrulanmamış işlem listesi: ' + JSON.stringify(r.unverifiedOperations));
    assert.strictEqual(r.chainCode, CHAIN);
  });

  await step('iptal hâlâ uydurulmuyor: yol verilmediyse açıkça reddedilir', async () => {
    seen.length = 0;
    const a = make();
    const r = await a.call('cancel', { externalOrderId: 'ORD-7', reason: 'x' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'AWAITING_PARTNER_SPEC', 'kod: ' + r.code);
    assert.strictEqual(seen.length, 0, 'uydurma bir adrese istek gitti');
  });

  await step('hiçbir istek jetonsuz gitmedi', async () => {
    const naked = seen.filter(s => s.path !== '/v2/login' && !s.auth.startsWith('Bearer '));
    assert.strictEqual(naked.length, 0, 'jetonsuz istek: ' + naked.map(n => n.path).join(', '));
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
