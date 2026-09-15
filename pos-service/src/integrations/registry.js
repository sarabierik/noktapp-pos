'use strict';
/**
 * The four providers, described once.
 *
 * The screen renders its credential form from `fields` here, the API validates
 * against the same list, and the encryption layer learns which of them are
 * secret from `secret: true`. Adding a fifth platform is an entry in this file
 * and an adapter class - nothing else in the product needs to know.
 */
const { TgoAdapter } = require('./adapters/tgo');
const { YemeksepetiAdapter, DEFAULT_REJECT_REASONS } = require('./adapters/yemeksepeti');
const { MigrosAdapter } = require('./adapters/migros');
const { GetirAdapter, enableGuard: getirGuard } = require('./adapters/getir');

const PROVIDERS = [
  {
    key: 'UBER_EATS_TGO',
    label: 'Uber Eats Trendyol Go',
    note: 'Trendyol Yemek, Trendyol Go ve GetirYemek by Uber Eats ("Galaxy") siparişleri bu ' +
      'bağlantıdan gelir. Uç noktalar ve alan adları developers.tgoapps.com dokümanına göre ' +
      'yazılmıştır. Sipariş çekme yöntemi: tedarikçi genelinde periyodik sorgu (sayfa başına en fazla 50).',
    transport: 'polling',
    environments: ['simulator', 'stage', 'production'],
    defaultEnvironment: 'simulator',
    adapter: TgoAdapter,
    /* `store` fields live on the connection row, `secret` fields inside the
       encrypted envelope. Nothing marked secret is ever sent back to a
       browser - the screen sees `cred_hint` and nothing else. */
    fields: [
      { key: 'supplierId', label: 'Tedarikçi (supplier) kimliği', column: 'supplier_id', required: true },
      { key: 'provider_store_id', label: 'Restoran / mağaza kimliği', column: 'provider_store_id', required: true },
      { key: 'apiKey', label: 'API anahtarı', secret: true, required: true },
      { key: 'apiSecret', label: 'API gizli anahtarı', secret: true, required: true },
      /* Required by the platform on EVERY request, not optional metadata:
         a missing or malformed User-Agent is answered 403, and x-executor-user
         lands in the platform's own audit trail so it has to be the
         restaurant's address rather than ours. */
      { key: 'integratorName', label: 'Entegratör adı (User-Agent)', placeholder: 'NOKTAppPOS' },
      { key: 'executorUser', label: 'İşlem yapan e-posta', placeholder: 'restoran@ornek.com' },
      { key: 'stageBase', label: 'Test ortamı adresi', placeholder: 'https://stageapi.tgoapis.com' },
      { key: 'productionBase', label: 'Canlı adres', placeholder: 'https://api.tgoapis.com' },
    ],
    /* `sourceApplication` still carries Galaxy: TGO's own payload uses it and
       an order that arrives with it must not be dropped. It is a field we
       READ, not a claim that Getir Yemek comes through here - Getir has its
       own connection, see GETIR_YEMEK below. */
    sourceApplications: ['Trendyol', 'TrendyolGo', 'Galaxy'],
  },
  {
    key: 'YEMEKSEPETI',
    label: 'Yemeksepeti',
    note: 'Restoran POS entegrasyonu (Local Shops API değil). Siparişler platformdan bu kasaya ' +
      'gönderilir; kabul yöntemi tablet ya da doğrudan kasa olabilir.',
    transport: 'webhook',
    environments: ['simulator', 'stage', 'production'],
    defaultEnvironment: 'simulator',
    adapter: YemeksepetiAdapter,
    acceptanceModes: ['PROVIDER_TABLET', 'POS_DIRECT'],
    rejectReasons: DEFAULT_REJECT_REASONS,
    /*
     * chainCode and posVendorId are the two ids EVERY v2 path is built from -
     * /v2/chains/{chainCode}/vendors/{posVendorId}/... - so both are required
     * and the adapter refuses to leave the machine without them rather than
     * posting to a URL with a hole in it.
     *
     * Everything below `globalEntityId` is optional because the middleware
     * hands it to us: platform-vendors answers with the entity and platform
     * ids for every Delivery Hero brand this restaurant is listed on. They are
     * here so that a partner pack which names them can override what we read.
     */
    fields: [
      { key: 'provider_store_id', label: 'POS vendor id (restoran kodu)', column: 'provider_store_id', required: true },
      { key: 'chain_id', label: 'Chain code (zincir kodu)', column: 'chain_id', required: true },
      { key: 'username', label: 'Middleware kullanıcı adı', secret: true, required: true },
      { key: 'password', label: 'Middleware şifresi', secret: true, required: true },
      { key: 'pluginUsername', label: 'Webhook kullanıcı adı', secret: true },
      { key: 'pluginPassword', label: 'Webhook şifresi', secret: true },
      { key: 'webhookSecret', label: 'Webhook imza anahtarı', secret: true },
      { key: 'productionBase', label: 'Canlı middleware adresi' },
      { key: 'globalEntityId', label: 'globalEntityId (boşsa platformdan okunur)' },
      { key: 'callbackUrl', label: 'Menü içe aktarma sonuç adresi (callbackUrl)' },
      { key: 'menuTitle', label: 'Platformda görünecek menü adı' },
    ],
  },
  {
    key: 'MIGROS_YEMEK',
    label: 'Migros Yemek',
    note: 'Kimlik bilgileri şube başınadır: restoran API anahtarı, restoran kimliği ve restoran grup ' +
      'kimliği. Uç noktalar Migros tarafından herkese açık yayımlanmadığı için iş ortağı paketinden girilir.',
    transport: 'polling',
    environments: ['simulator', 'stage', 'production'],
    defaultEnvironment: 'simulator',
    adapter: MigrosAdapter,
    fields: [
      { key: 'provider_store_id', label: 'Restoran kimliği (Restoran ID)', column: 'provider_store_id', required: true },
      { key: 'chain_id', label: 'Restoran grup kimliği (Grup ID)', column: 'chain_id', required: true },
      { key: 'apiKey', label: 'Restoran API anahtarı', secret: true, required: true },
      { key: 'activationCode', label: 'Aktivasyon kodu (varsa)', secret: true },
      /*
       * Everything below comes off the partner pack, so that a pack landing on
       * a Tuesday is a form filled in on Tuesday rather than a release.
       * `apiKeyHeader` and `authScheme` decide HOW the key travels, `paths`
       * decides WHERE each operation goes, `extraHeaders` carries anything
       * else the pack lists. None of it is guessed and none of it has a
       * default that pretends to be knowledge.
       */
      { key: 'productionBase', label: 'Canlı sunucu adresi (iş ortağı paketinden)' },
      { key: 'stageBase', label: 'Test sunucu adresi' },
      { key: 'apiKeyHeader', label: 'Anahtarın gittiği başlık adı (boşsa Authorization)' },
      { key: 'authScheme', label: 'Yetki şeması (Bearer, ApiKey, boş)' },
      { key: 'extraHeaders', label: 'Ek başlıklar (JSON)', json: true },
      { key: 'paths', label: 'Uç noktalar (JSON)', json: true },
      { key: 'webhookSecret', label: 'Webhook imza anahtarı', secret: true },
    ],
  },
  {
    key: 'GETIR_YEMEK',
    label: 'Getir Yemek',
    note: 'Getir Yemek iş ortağı paketindeki restoran kimliği, app secret ve restaurant secret key ' +
      'ile bağlanır. Getir uç nokta adreslerini herkese açık yayımlamadığı için sunucu adresi ve ' +
      'uç noktalar entegrasyon dokümanınızdan girilir.',
    transport: 'polling',
    environments: ['simulator', 'production'],
    defaultEnvironment: 'simulator',
    adapter: GetirAdapter,
    guard: getirGuard,
    fields: [
      { key: 'provider_store_id', label: 'Restoran kimliği', column: 'provider_store_id', required: true },
      { key: 'appSecret', label: 'App secret', secret: true, required: true },
      { key: 'restaurantSecretKey', label: 'Restaurant secret key', secret: true, required: true },
      { key: 'base', label: 'Sunucu adresi' },
    ],
  },
];

const BY_KEY = Object.fromEntries(PROVIDERS.map(p => [p.key, p]));

function def(provider) { return BY_KEY[provider] || null; }
function keys() { return PROVIDERS.map(p => p.key); }

/** Build the adapter for a connection row plus its decrypted credentials. */
function adapterFor(conn, creds) {
  const d = def(conn.provider);
  if (!d) { const e = new Error('Bilinmeyen platform: ' + conn.provider); e.status = 400; throw e; }
  return new d.adapter(conn, creds || {});
}

/** Which credential keys are secret, for the encryption split. */
function secretKeys(provider) {
  const d = def(provider);
  return d ? d.fields.filter(f => f.secret).map(f => f.key) : [];
}

/** The keys that live in a column on np_int_connections rather than in the envelope. */
function columnFields(provider) {
  const d = def(provider);
  return d ? d.fields.filter(f => f.column) : [];
}

/**
 * The catalogue the screen renders. Never contains a value - only the shape.
 */
function catalogue() {
  return PROVIDERS.map(p => ({
    key: p.key, label: p.label, note: p.note, transport: p.transport,
    environments: p.environments, defaultEnvironment: p.defaultEnvironment,
    legacy: !!p.legacy, acceptanceModes: p.acceptanceModes || ['PROVIDER_TABLET', 'POS_DIRECT'],
    rejectReasons: p.rejectReasons || null,
    sourceApplications: p.sourceApplications || null,
    fields: p.fields.map(f => ({ key: f.key, label: f.label, secret: !!f.secret,
      required: !!f.required, placeholder: f.placeholder || null, column: f.column || null })),
  }));
}

module.exports = { PROVIDERS, BY_KEY, def, keys, adapterFor, secretKeys, columnFields, catalogue };
