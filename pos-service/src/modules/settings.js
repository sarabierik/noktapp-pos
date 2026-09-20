'use strict';
/**
 * Settings and administration.
 *
 * The PHP this replaces had no settings table at all: every switch was a column
 * on `clients`, a row in `stations`, or a constant somebody had edited in
 * config.php on the server. Adding one setting meant an ALTER TABLE, so in
 * practice nobody added one, and the answer to "can I turn that off?" was
 * always no. (See inv/05-stock-settings.md §2.0 - it lists the whole of the old
 * tenant configuration, and it is 20 columns and four tables.)
 *
 * Here every setting is a row in np_settings and, more importantly, a typed
 * DEFINITION in this file: key, Turkish label, type, default, help text, and
 * the rule that decides whether a value is acceptable. The screen is generated
 * from that list, the API validates against that list, and the printer/backup/
 * mail code keeps reading the same db.getSetting() it always did. Adding a
 * setting is one entry in DEFS and nothing else.
 *
 * Three things deliberately do NOT live in np_settings:
 *   - the receipt header/footer and the company details, because print/index.js
 *     already reads them off `clients` / `business_settings` and moving them
 *     would break the receipt for a cosmetic tidy-up;
 *   - exchange rates, which need a per-currency row and an audit history;
 *   - anything secret that is generated rather than chosen (jwt_secret,
 *     device_id) - PROTECTED below refuses to let the UI touch them.
 */
const db = require('../db');
const auth = require('../auth');
const log = require('../logger');
const catalog = require('./catalog');
const printing = require('../print');
const transport = require('../print/transport');
const fiscal = require('../fiscal');

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/* ==================================================================== *
 * 1. THE SETTING CATALOGUE                                             *
 * ==================================================================== */

/** Screens are grouped so a 60-key form is not one 60-row wall. */
const GROUPS = [
  { id: 'genel', label: 'Genel', help: 'Para birimi, iş günü ve dil.' },
  { id: 'calisma', label: 'Çalışma saatleri', help: 'Haftalık açılış ve kapanış. "kapalı" yazarsanız o gün kapalıdır.' },
  { id: 'fis', label: 'Fiş', help: 'Müşteri fişinin biçimi. Fiş başlığı ve altı İşletme sekmesindedir.' },
  { id: 'mutfak', label: 'Mutfak', help: 'Mutfak ve bar fişleri.' },
  { id: 'odeme', label: 'Ödeme', help: 'Ödeme alma, indirim sınırı, ÖKC.' },
  { id: 'paket', label: 'Paket servis', help: 'Kapıda hangi ödeme alınır, alt limit ne yapar.' },
  { id: 'guvenlik', label: 'Güvenlik', help: 'PIN kuralları ve yönetici onayı gereken işlemler.' },
  { id: 'yedekleme', label: 'Yedekleme', help: 'Yerel ve bulut yedeği.' },
  { id: 'eposta', label: 'E-posta (SMTP)', help: 'Fiş ve rapor gönderimi için giden posta sunucusu.' },
  { id: 'ag', label: 'Ağ', help: 'Telefonların ve panelin kasaya nasıl ulaştığı.' },
];

const DAYS = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];

/**
 * Every setting key the till has.
 *
 * type      text | textarea | number | bool | select | time | hours | password | url
 * default   what getSetting() falls back to - keep it identical to the default
 *           written at the call site, or the screen will lie about the value
 *           in use before the key is ever saved.
 */
const DEFS = [
  /* ------------------------------- genel ------------------------------- */
  { key: 'currency', group: 'genel', label: 'Para birimi', type: 'select', default: 'TRY',
    options: [['TRY', 'Türk Lirası (₺)'], ['USD', 'Dolar ($)'], ['EUR', 'Euro (€)'], ['GBP', 'Sterlin (£)']],
    help: 'Fişte ve ekranda kullanılan ana para birimi.' },
  { key: 'currency_symbol', group: 'genel', label: 'Para birimi simgesi', type: 'text', default: '₺', max: 4,
    help: 'Tutarların yanında görünen işaret.' },
  { key: 'currency_position', group: 'genel', label: 'Simgenin yeri', type: 'select', default: 'after',
    options: [['after', 'Tutardan sonra (120,00 ₺)'], ['before', 'Tutardan önce (₺ 120,00)']],
    help: 'Yalnızca görünümü değiştirir, hesaplamayı değil.' },
  { key: 'decimal_places', group: 'genel', label: 'Kuruş hanesi', type: 'number', default: 2, min: 0, max: 2,
    help: 'Ekranda gösterilen ondalık basamak sayısı.' },
  { key: 'business_day_start', group: 'genel', label: 'İş günü başlangıcı', type: 'time', default: '06:00',
    help: 'Gece 02:00\'de kesilen adisyon hangi güne yazılsın? Bu saatten öncesi bir önceki güne sayılır.' },
  { key: 'day_auto_close', group: 'genel', label: 'Gün sonunu otomatik kapat', type: 'bool', default: '0',
    help: 'İş günü bittiğinde Z raporu beklemeden günü kapatır.' },
  { key: 'table_service', group: 'genel', label: 'Masa servisi', type: 'bool', default: '1',
    help: 'Kapalıysa kasa doğrudan hızlı satış ekranıyla açılır.' },

  /* ----------------------------- çalışma ------------------------------- */
  ...DAYS.map((d, i) => ({
    key: 'hours_' + (i + 1), group: 'calisma', label: d, type: 'hours', default: '09:00-23:00',
    help: 'Örnek: 09:00-23:00 · kapalıysa "kapalı" yazın.',
  })),

  /* -------------------------------- fiş -------------------------------- */
  { key: 'receipt_width', group: 'fis', label: 'Fiş genişliği (karakter)', type: 'number', default: 48, min: 24, max: 96,
    help: '80 mm yazıcı 48, 58 mm yazıcı 32 karakterdir.' },
  { key: 'receipt_copies', group: 'fis', label: 'Fiş kopya sayısı', type: 'number', default: 1, min: 1, max: 3,
    help: 'Hesap fişinin kaç nüsha basılacağı.' },
  { key: 'receipt_auto_print', group: 'fis', label: 'Hesap kapanınca fiş bas', type: 'bool', default: '0',
    help: 'Adisyon kapandığı anda fiş kuyruğa girer.' },
  { key: 'receipt_show_vat', group: 'fis', label: 'KDV dökümünü yazdır', type: 'bool', default: '1',
    help: 'Fişin altında oranlara göre KDV dökümü.' },
  { key: 'receipt_show_waiter', group: 'fis', label: 'Garson adını yazdır', type: 'bool', default: '1' },
  { key: 'receipt_show_fx', group: 'fis', label: 'Döviz karşılığını yazdır', type: 'bool', default: '0',
    help: 'Döviz sekmesinde kuru girilmiş para birimleri fişin altına eklenir.' },
  { key: 'receipt_qr', group: 'fis', label: 'QR menü karekodu bas', type: 'bool', default: '0' },

  /* ------------------------------- mutfak ------------------------------ */
  { key: 'kitchen_auto_send', group: 'mutfak', label: 'Ürün eklenince mutfağa gönder', type: 'bool', default: '0',
    help: 'Kapalıyken garson "Mutfağa gönder" demeden fiş çıkmaz.' },
  { key: 'kitchen_show_prices', group: 'mutfak', label: 'Mutfak fişinde fiyat göster', type: 'bool', default: '0',
    help: 'Mutfağın fiyata ihtiyacı yoktur; açık bırakmak fişi uzatır.' },
  { key: 'kitchen_void_slip', group: 'mutfak', label: 'İptalde mutfağa fiş bas', type: 'bool', default: '1',
    help: 'Pişmekte olan bir ürün iptal edilince mutfak haber alsın.' },
  { key: 'kitchen_slip_per_course', group: 'mutfak', label: 'Servis sırasına göre ayrı fiş', type: 'bool', default: '0' },

  /* ------------------------------- ödeme ------------------------------- */
  { key: 'fiscal_enabled', group: 'odeme', label: 'ÖKC ile ödeme açık', type: 'bool', default: '0',
    help: 'Kapalıyken kasada "Kart / ÖKC" düğmesi görünmez.' },
  { key: 'allow_partial_payment', group: 'odeme', label: 'Parçalı ödemeye izin ver', type: 'bool', default: '1' },
  { key: 'max_discount_percent', group: 'odeme', label: 'En yüksek indirim (%)', type: 'number', default: 100, min: 0, max: 100,
    help: 'Bunun üstündeki indirim yönetici PIN\'i ister.' },
  { key: 'rounding_mode', group: 'odeme', label: 'Nakit yuvarlama', type: 'select', default: 'none',
    options: [['none', 'Yuvarlama yok'], ['5', 'En yakın 5 kuruşa'], ['10', 'En yakın 10 kuruşa'], ['100', 'En yakın liraya']],
    help: 'Yalnızca nakit ödemede uygulanır.' },
  { key: 'open_drawer_on_cash', group: 'odeme', label: 'Nakitte çekmeceyi aç', type: 'bool', default: '1' },
  { key: 'tip_enabled', group: 'odeme', label: 'Bahşiş alanı', type: 'bool', default: '0' },

  /* ---------------------------- paket servis --------------------------- */
  { key: 'delivery_door_methods', group: 'paket', label: 'Kapıda alınabilecek ödemeler',
    type: 'text', default: 'nakit,kredi_karti,yemek_karti',
    help: 'Kuryenin kapıda kabul edebileceği ödeme türleri, virgülle: nakit, kredi_karti, '
        + 'yemek_karti, havale. Listede olmayan bir tür teslim ekranında sunulmaz.' },
  { key: 'delivery_min_order_block', group: 'paket', label: 'Alt limitin altında sipariş',
    type: 'select', default: 'warn',
    options: [['warn', 'Uyar, kasiyer devam edebilsin'], ['block', 'Engelle']],
    help: 'Bölgeye yazılan alt sepet tutarının altındaki bir siparişte ne olsun.' },
  { key: 'delivery_default_minutes', group: 'paket', label: 'Varsayılan teslim süresi (dk)',
    type: 'number', default: 30, min: 5, max: 240,
    help: 'Bölgede süre yazılmadıysa kullanılır. Sipariş alırken tek tek değiştirilebilir.' },

  /* ----------------------------- güvenlik ------------------------------ */
  { key: 'pin_length', group: 'guvenlik', label: 'PIN uzunluğu', type: 'number', default: 4, min: 4, max: 8,
    help: 'Yeni PIN\'ler bu uzunlukta olmak zorundadır.' },
  { key: 'pin_max_fail', group: 'guvenlik', label: 'Hatalı PIN denemesi', type: 'number', default: 5, min: 3, max: 20,
    help: 'Bu kadar hatadan sonra hesap geçici olarak kilitlenir.' },
  { key: 'pin_lock_minutes', group: 'guvenlik', label: 'Kilit süresi (dakika)', type: 'number', default: 5, min: 1, max: 240 },
  { key: 'manager_pin_discount', group: 'guvenlik', label: 'İndirimde yönetici PIN\'i', type: 'bool', default: '0' },
  { key: 'manager_pin_void', group: 'guvenlik', label: 'Ürün iptalinde yönetici PIN\'i', type: 'bool', default: '1' },
  { key: 'manager_pin_delete_bill', group: 'guvenlik', label: 'Adisyon silmede yönetici PIN\'i', type: 'bool', default: '1' },
  { key: 'auto_lock_minutes', group: 'guvenlik', label: 'Ekranı kilitle (dakika)', type: 'number', default: 0, min: 0, max: 240,
    help: '0 = kilitleme. Kasa boşta kalınca PIN ekranına döner.' },

  /* ---------------------------- yedekleme ------------------------------ */
  { key: 'backup_local_every_min', group: 'yedekleme', label: 'Yerel yedek sıklığı (dakika)', type: 'number', default: 15, min: 5, max: 1440 },
  { key: 'backup_keep_days', group: 'yedekleme', label: 'Yedek saklama (gün)', type: 'number', default: 14, min: 1, max: 365 },
  { key: 'backup_cloud_enabled', group: 'yedekleme', label: 'Buluta yedekle', type: 'bool', default: '1',
    help: 'Gece bir kez panele şifreli kopya gönderir.' },
  { key: 'backup_cloud_hour', group: 'yedekleme', label: 'Bulut yedeği saati', type: 'number', default: 3, min: 0, max: 23,
    help: 'Kasanın açık olduğu ama kimsenin satış yapmadığı bir saat seçin.' },

  /* ------------------------------ e-posta ------------------------------ */
  { key: 'smtp_host', group: 'eposta', label: 'Sunucu', type: 'text', default: '', help: 'Örnek: smtp.yandex.com' },
  { key: 'smtp_port', group: 'eposta', label: 'Port', type: 'number', default: 465, min: 1, max: 65535 },
  { key: 'smtp_secure', group: 'eposta', label: 'SSL/TLS', type: 'bool', default: '1' },
  { key: 'smtp_user', group: 'eposta', label: 'Kullanıcı', type: 'text', default: '' },
  { key: 'smtp_pass', group: 'eposta', label: 'Şifre', type: 'password', default: '', secret: true,
    help: 'Kaydedildikten sonra bir daha gösterilmez; boş bırakırsanız değişmez.' },
  { key: 'smtp_from', group: 'eposta', label: 'Gönderen adresi', type: 'text', default: 'noreply@noktapp.com' },

  /* -------------------------------- ağ --------------------------------- */
  { key: 'lan_enabled', group: 'ag', label: 'Yerel ağ keşfi', type: 'bool', default: '1',
    help: 'Garson telefonları kasayı aynı ağda kendiliğinden bulur.' },
  { key: 'relay_enabled', group: 'ag', label: 'Uzaktan erişim (relay)', type: 'bool', default: '1',
    help: 'Kasa dışarıdan ulaşılabilir olsun; kapalıyken yalnızca yerel ağ çalışır.' },
  { key: 'service_port', group: 'ag', label: 'Servis portu', type: 'number', default: 7451, min: 1024, max: 65535,
    help: 'Değişiklik kasa yeniden başlatılınca geçerli olur.' },
  { key: 'panel_url', group: 'ag', label: 'Panel adresi', type: 'url', default: 'https://pos.noktapp.com',
    help: 'Lisans ve bulut yedeği bu adrese gider.' },
];

const BY_KEY = {};
for (const d of DEFS) BY_KEY[d.key] = d;

/*
 * Keys the UI must never write. jwt_secret would log everybody out and make
 * every issued token unverifiable; device_id is the licence identity; setup_done
 * is owned by the wizard and flipping it by hand strands the till on the
 * bootstrap screen.
 */
const PROTECTED = new Set(['jwt_secret', 'device_id', 'setup_done', 'fiscal_provider']);

/* --------------------------- validation ---------------------------- */
/**
 * Turn whatever the browser sent into the exact string that goes in the row,
 * or throw a message a restaurant owner can act on.
 *
 * The old system stored form input verbatim, so a typo in the receipt width
 * ("4 8") became NaN characters wide and the printer emitted one column of
 * letters until somebody pulled the plug. Everything is checked here.
 */
function coerce(def, raw) {
  const v = raw === null || raw === undefined ? '' : String(raw).trim();
  const L = def.label;

  if (def.type === 'bool') {
    if (v === '') return String(def.default);
    if (['1', 'true', 'on', 'evet', 'yes'].includes(v.toLowerCase())) return '1';
    if (['0', 'false', 'off', 'hayir', 'hayır', 'no'].includes(v.toLowerCase())) return '0';
    throw bad(`${L}: evet/hayır bekleniyor, "${v}" gönderildi`);
  }

  if (def.type === 'number') {
    if (v === '') return String(def.default);
    // "48,5" and "48 " are what a Turkish keyboard actually produces
    const n = Number(v.replace(',', '.'));
    if (!Number.isFinite(n)) throw bad(`${L}: sayı bekleniyor, "${v}" gönderildi`);
    if (def.min !== undefined && n < def.min) throw bad(`${L}: en az ${def.min} olmalı`);
    if (def.max !== undefined && n > def.max) throw bad(`${L}: en fazla ${def.max} olabilir`);
    return String(Number.isInteger(n) ? n : Math.round(n * 100) / 100);
  }

  if (def.type === 'select') {
    if (v === '') return String(def.default);
    if (!def.options.some(([code]) => code === v)) {
      throw bad(`${L}: geçersiz seçenek "${v}"`);
    }
    return v;
  }

  if (def.type === 'time') {
    if (v === '') return String(def.default);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad(`${L}: saat SS:DD biçiminde olmalı ("${v}")`);
    return v;
  }

  /*
   * Working hours are one text field per day on purpose. A pair of <input
   * type=time> boxes cannot say "kapalı", and the split shift a lokanta
   * actually runs (11:00-15:00 ve 18:00-23:00) needs free text anyway.
   */
  if (def.type === 'hours') {
    if (v === '') return String(def.default);
    if (/^(kapal[ıi]|kapali|closed)$/i.test(v)) return 'kapalı';
    const parts = v.split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) throw bad(`${L}: saat aralığı bekleniyor`);
    for (const p of parts) {
      const m = p.match(/^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/);
      if (!m) throw bad(`${L}: "SS:DD-SS:DD" biçiminde olmalı ("${p}")`);
    }
    return parts.join(', ');
  }

  if (def.type === 'url') {
    if (v === '') return String(def.default);
    if (!/^https?:\/\/[^\s]+$/i.test(v)) throw bad(`${L}: http:// veya https:// ile başlamalı`);
    return v;
  }

  // text / textarea / password
  if (def.max && v.length > def.max) throw bad(`${L}: en fazla ${def.max} karakter`);
  if (v.length > 4000) throw bad(`${L}: değer çok uzun`);
  return v;
}

/** The definition list, safe to hand to the browser (no values in it). */
function catalogue() {
  return { groups: GROUPS, defs: DEFS.map(d => ({ ...d, options: d.options || null })) };
}

/** Every key with its current value, defaults filled in, secrets masked. */
async function all() {
  const rows = await db.query('SELECT k, v FROM np_settings');
  const stored = {};
  for (const r of rows) stored[r.k] = r.v;
  const out = {};
  for (const d of DEFS) {
    if (d.secret) {
      // never send a password back to a screen; say only whether one is set
      out[d.key] = stored[d.key] ? '********' : '';
      continue;
    }
    out[d.key] = stored[d.key] === undefined || stored[d.key] === null
      ? String(d.default) : String(stored[d.key]);
  }
  return out;
}

/**
 * Write a patch. Every key is validated BEFORE anything is written, so a form
 * with one bad field does not half-save - the old settings.php wrote column by
 * column and left the tenant with a half-applied form when one field tripped.
 */
async function save(clientId, patch, actorId) {
  const clean = [];
  for (const [k, rawv] of Object.entries(patch || {})) {
    if (PROTECTED.has(k)) throw bad(`"${k}" bu ekrandan değiştirilemez`);
    const def = BY_KEY[k];
    if (!def) throw bad(`Bilinmeyen ayar: ${k}`);
    // a masked secret coming back unchanged means "leave it alone"
    if (def.secret && (rawv === '' || rawv === '********')) continue;
    clean.push([k, coerce(def, rawv)]);
  }
  for (const [k, v] of clean) {
    const old = await db.getSetting(k, null);
    if (String(old) === String(v)) continue;
    await db.setSetting(k, v);
    await logChange(clientId, k, old, def_isSecret(k) ? '***' : v, actorId);
  }
  return { saved: clean.length };
}

function def_isSecret(k) { return !!(BY_KEY[k] && BY_KEY[k].secret); }

/** Who changed which switch, and when. The old system could not answer this. */
async function logChange(clientId, k, oldV, newV, actorId) {
  await db.exec(
    'INSERT INTO np_settings_log (client_id, k, old_value, new_value, changed_by, created_at) VALUES (?,?,?,?,?,NOW())',
    [clientId || 0, k, oldV === null || oldV === undefined ? null : String(oldV).slice(0, 500),
     newV === null ? null : String(newV).slice(0, 500), actorId || null])
    .catch(e => log.warn('settings', 'change log not written: ' + e.message));
}

async function history(limit = 50) {
  return db.query(
    `SELECT l.id, l.k, l.old_value, l.new_value, l.created_at, u.display_name AS changed_by_name
       FROM np_settings_log l LEFT JOIN users u ON u.id=l.changed_by
      ORDER BY l.id DESC LIMIT ?`, [Number(limit) || 50]);
}

/* ==================================================================== *
 * 2. USERS, ROLES AND PERMISSIONS                                      *
 * ==================================================================== */

const ADMIN_ROLES = ['admin', 'superadmin'];

/** Turkish names for the permission catalogue that already lives in auth.js. */
const PERM_LABELS = {
  'order.create': 'Adisyon açma / ürün ekleme',
  'order.discount': 'İndirim uygulama',
  'order.item.cancel': 'Ürün iptali',
  'order.delete': 'Adisyon silme',
  'order.transfer': 'Masa / adisyon taşıma',
  'order.split': 'Adisyon bölme',
  'order.reopen': 'Kapalı adisyonu açma',
  'payment.take': 'Ödeme alma',
  'payment.void': 'Ödeme iptali',
  'shift.open': 'Vardiya açma',
  'shift.close': 'Vardiya kapatma',
  'day.close': 'Gün sonu (Z)',
  'day.reopen': 'Günü yeniden açma',
  'product.manage': 'Ürün ve kategori yönetimi',
  'stock.manage': 'Stok yönetimi',
  'price.manage': 'Fiyat değiştirme',
  'table.manage': 'Masa düzeni',
  'report.view': 'Raporları görme',
  'report.export': 'Rapor dışa aktarma',
  'customer.manage': 'Müşteri ve sadakat',
  'settings.manage': 'Ayarlar',
  'user.manage': 'Kullanıcı yönetimi',
  'fiscal.use': 'ÖKC ile ödeme',
  'printer.manage': 'Yazıcı yönetimi',
  'backup.run': 'Yedekleme',
  'integration.manage': 'Entegrasyon ayarları',
  'integration.order': 'Platform siparişi işlemleri',
  'delivery.manage': 'Paket servis ayarları (bölge, ücret, kurye)',
  'delivery.order': 'Paket servis panosu ve kurye kasası',
};

const PERM_GROUPS = [
  { id: 'adisyon', label: 'Adisyon', keys: ['order.create', 'order.discount', 'order.item.cancel', 'order.delete', 'order.transfer', 'order.split', 'order.reopen'] },
  { id: 'kasa', label: 'Kasa', keys: ['payment.take', 'payment.void', 'fiscal.use', 'shift.open', 'shift.close', 'day.close', 'day.reopen'] },
  { id: 'menu', label: 'Menü ve stok', keys: ['product.manage', 'price.manage', 'stock.manage', 'table.manage'] },
  { id: 'rapor', label: 'Rapor ve müşteri', keys: ['report.view', 'report.export', 'customer.manage'] },
  { id: 'yonetim', label: 'Yönetim', keys: ['settings.manage', 'user.manage', 'printer.manage', 'backup.run',
    'integration.manage', 'delivery.manage'] },
  { id: 'entegrasyon', label: 'Yemek platformları', keys: ['integration.order'] },
  { id: 'paket', label: 'Paket servis', keys: ['delivery.order'] },
];

/*
 * "Sistem yoneticisi" meant nothing to anyone at a till. This role is the
 * person who holds the licence, and it is the only one that may delete a
 * bill, take money off the books or reopen a closed day - so it says so.
 */
const ROLE_LABELS = { superadmin: 'İşletme sahibi', admin: 'Yönetici', cashier: 'Kasiyer', waiter: 'Garson' };

async function listUsers(clientId) {
  const users = await db.query(
    `SELECT u.id, u.username, u.email, u.display_name, u.role, u.is_active, u.created_at,
            u.pin_changed_at, u.pin_locked_until, u.pin_fail_count,
            (u.pin_hash IS NOT NULL) AS has_pin, (u.password_hash <> '') AS has_password
       FROM users u WHERE u.client_id=? ORDER BY FIELD(u.role,'superadmin','admin','cashier','waiter'), u.display_name`,
    [clientId]);
  const perms = await db.query(
    'SELECT user_id, perm_key FROM user_permissions WHERE client_id=? AND perm_key<>?',
    [clientId, auth.OVERRIDE_MARK]);
  for (const u of users) {
    u.perms = perms.filter(p => p.user_id === u.id).map(p => p.perm_key);
    /*
     * ONE BAD ROW MUST NOT TAKE THE SCREEN DOWN.
     *
     * This loop enriches every user, and it used to let anything thrown by the
     * enrichment out of the function - so a single row that could not be
     * resolved returned 500 for the whole list, and the Kullanıcılar screen
     * showed nothing at all. The one place an owner goes to FIX a broken user
     * is the screen a broken user was able to break.
     *
     * A row that cannot be enriched is still a row: it is listed, with no
     * effective permissions and a note saying so, which is both true and
     * actionable. The failure is logged with the id so it can be chased, not
     * swallowed.
     */
    try {
      u.effective = await auth.permissionsFor(clientId, u.id, u.role);
    } catch (e) {
      u.effective = [];
      u.perm_error = 'Yetkileri okunamadı';
      log.error('settings', 'kullanici yetkileri okunamadi', { user: u.id, role: u.role, error: e.message });
    }
    u.role_label = ROLE_LABELS[u.role] || u.role;
    u.locked = !!(u.pin_locked_until && new Date(u.pin_locked_until) > new Date());
  }
  return users;
}

async function activeAdmins(clientId, exceptId = null) {
  const rows = await db.query(
    `SELECT id FROM users WHERE client_id=? AND is_active=1 AND role IN ('admin','superadmin')
       ${exceptId ? 'AND id<>?' : ''}`, exceptId ? [clientId, exceptId] : [clientId]);
  return rows.map(r => r.id);
}

/**
 * The two rules that stop an installation locking itself out.
 *
 * The PHP had neither: users.php would happily set the only admin to "waiter"
 * (the checklist in inv/05 lists "son yöneticinin kendi rolünü düşürmesini
 * engelle" as a capability, but permissions.php only guarded the *self*
 * demotion case, not the last-admin case), and there was no deactivate at all -
 * you deleted the row, admin or not.
 */
async function guardUserChange(clientId, target, next, actorId) {
  const wasAdmin = ADMIN_ROLES.includes(target.role);
  const willBeAdmin = next.role === undefined ? wasAdmin : ADMIN_ROLES.includes(next.role);
  const willBeActive = next.is_active === undefined ? !!target.is_active : !!next.is_active;

  /*
   * Order matters. When the only admin is editing themselves BOTH rules fire,
   * and "son yönetici" is the one that explains the installation-wide
   * consequence - "kendi hesabınız" makes it sound like a second admin could
   * do it, which is exactly the wrong thing to tell someone at that moment.
   */
  if (wasAdmin && (!willBeAdmin || !willBeActive)) {
    const others = await activeAdmins(clientId, target.id);
    if (!others.length) {
      throw bad(!willBeActive
        ? 'Son yönetici hesabı kapatılamaz. Önce başka bir yönetici tanımlayın.'
        : 'Son yöneticinin rolü düşürülemez. Önce başka bir yönetici tanımlayın.');
    }
  }

  if (Number(actorId) === Number(target.id)) {
    if (wasAdmin && !willBeAdmin) throw bad('Kendi yönetici yetkinizi kaldıramazsınız. Başka bir yönetici yapabilir.');
    if (!willBeActive) throw bad('Kendi hesabınızı kapatamazsınız.');
  }
}

/** Permission overrides. An admin holds everything implicitly, so overrides
 *  only bite for cashiers and waiters - but a non-admin must still not be able
 *  to sign away their own user.manage and lock the screen behind them. */
async function setUserPerms(clientId, userId, perms, actorId) {
  const target = await db.one('SELECT * FROM users WHERE id=? AND client_id=?', [userId, clientId]);
  if (!target) throw bad('Kullanıcı bulunamadı', 404);
  const list = Array.isArray(perms) ? perms.filter(p => auth.PERMISSIONS.includes(p)) : [];
  if (Number(actorId) === Number(userId) && !ADMIN_ROLES.includes(target.role)) {
    for (const keep of ['user.manage', 'settings.manage']) {
      const had = (await auth.permissionsFor(clientId, userId, target.role)).includes(keep);
      if (had && !list.includes(keep)) throw bad('Kendi yönetim yetkinizi kaldıramazsınız.');
    }
  }
  await auth.setPermissions(clientId, userId, list, actorId);
  return list;
}

function checkPinFormat(pin, wantLength) {
  const p = String(pin || '').trim();
  if (!/^\d+$/.test(p)) throw bad('PIN yalnızca rakamlardan oluşmalı');
  if (p.length !== Number(wantLength)) throw bad(`PIN ${wantLength} haneli olmalı`);
  return p;
}

async function pinLength() { return Number(await db.getSetting('pin_length', 4)) || 4; }

/**
 * Create or update a member of staff.
 *
 * The row write itself is catalog.saveUser() - it already handles hashing, the
 * permission list and the PIN audit columns, and duplicating it here would mean
 * two places to get bcrypt wrong. What is added is the validation and the two
 * lockout guards, which catalog.saveUser deliberately has no opinion about.
 */
async function saveUser(clientId, data, actorId) {
  const name = String(data.display_name || '').trim();
  if (!name) throw bad('Ad soyad zorunlu');
  const role = String(data.role || 'waiter');
  if (!auth.ROLES.includes(role)) throw bad('Geçersiz rol: ' + role);

  if (data.username) {
    const dupe = await db.one('SELECT id FROM users WHERE client_id=? AND username=? AND id<>?',
      [clientId, String(data.username).trim(), data.id || 0]);
    if (dupe) throw bad('Bu kullanıcı adı zaten kullanılıyor');
  }
  if (data.email) {
    const dupe = await db.one('SELECT id FROM users WHERE client_id=? AND email=? AND id<>?',
      [clientId, String(data.email).trim().toLowerCase(), data.id || 0]);
    if (dupe) throw bad('Bu e-posta adresi zaten kayıtlı');
  }
  if (data.pin) checkPinFormat(data.pin, await pinLength());
  if (data.password && String(data.password).length < 6) throw bad('Telefon şifresi en az 6 karakter olmalı');

  if (data.id) {
    const target = await db.one('SELECT * FROM users WHERE id=? AND client_id=?', [data.id, clientId]);
    if (!target) throw bad('Kullanıcı bulunamadı', 404);
    await guardUserChange(clientId, target, { role, is_active: data.is_active }, actorId);
  } else if (!data.pin) {
    throw bad('Yeni kullanıcı için kasa PIN\'i zorunlu');
  }

  /*
   * users.password_hash is NOT NULL with no default and the server runs in
   * STRICT_TRANS_TABLES, so creating a PIN-only member of staff (a waiter who
   * never touches the phone app) inserts NULL and dies with a 500. Rather than
   * force everyone to invent a phone password, an unusable random one is set:
   * bcrypt will never match anything the person could type, so password login
   * stays closed until a real one is given. (manage.js has the same latent
   * bug - see inv/HANDOFF-settings.md.)
   */
  const payload = { ...data, display_name: name, role };
  if (!data.id && !data.password) payload.password = require('crypto').randomBytes(24).toString('hex');

  const id = await catalog.saveUser(clientId, payload, actorId);
  if (data.perms) await setUserPerms(clientId, id, data.perms, actorId);
  return id;
}

async function setUserActive(clientId, userId, active, actorId) {
  const target = await db.one('SELECT * FROM users WHERE id=? AND client_id=?', [userId, clientId]);
  if (!target) throw bad('Kullanıcı bulunamadı', 404);
  await guardUserChange(clientId, target, { is_active: !!active }, actorId);
  await db.exec('UPDATE users SET is_active=?, is_logged_in=0, updated_at=NOW() WHERE id=? AND client_id=?',
    [active ? 1 : 0, userId, clientId]);
  return true;
}

async function setUserRole(clientId, userId, role, actorId) {
  if (!auth.ROLES.includes(role)) throw bad('Geçersiz rol: ' + role);
  const target = await db.one('SELECT * FROM users WHERE id=? AND client_id=?', [userId, clientId]);
  if (!target) throw bad('Kullanıcı bulunamadı', 404);
  await guardUserChange(clientId, target, { role }, actorId);
  await db.exec('UPDATE users SET role=?, updated_at=NOW() WHERE id=? AND client_id=?', [role, userId, clientId]);
  return true;
}

/**
 * Reset somebody's till PIN. The fail counter and the lock are cleared with it,
 * otherwise the member of staff who was locked out at 20:00 is still locked out
 * after the manager has given them a new PIN - which is the exact moment they
 * need it.
 */
async function resetPin(clientId, userId, pin, actorId) {
  const target = await db.one('SELECT id, display_name FROM users WHERE id=? AND client_id=?', [userId, clientId]);
  if (!target) throw bad('Kullanıcı bulunamadı', 404);
  const clean = checkPinFormat(pin, await pinLength());

  // a PIN is the whole credential on the till, so it must not collide
  const others = await db.query(
    'SELECT id, pin_hash FROM users WHERE client_id=? AND id<>? AND pin_hash IS NOT NULL', [clientId, userId]);
  const bcrypt = require('bcryptjs');
  for (const o of others) {
    if (bcrypt.compareSync(clean, o.pin_hash)) throw bad('Bu PIN başka bir kullanıcıda kullanılıyor');
  }

  const actor = actorId ? await db.one('SELECT display_name FROM users WHERE id=?', [actorId]) : null;
  await db.exec(
    `UPDATE users SET pin_hash=?, pin_changed_at=NOW(), pin_set_by=?, pin_set_by_label=?,
        pin_fail_count=0, pin_locked_until=NULL, updated_at=NOW() WHERE id=? AND client_id=?`,
    [auth.hash(clean), actorId || null, actor ? actor.display_name : null, userId, clientId]);
  log.info('settings', 'PIN reset', { user: userId, by: actorId });
  return true;
}

async function unlockUser(clientId, userId) {
  await db.exec('UPDATE users SET pin_fail_count=0, pin_locked_until=NULL WHERE id=? AND client_id=?',
    [userId, clientId]);
  return true;
}

/**
 * Deleting staff is deliberately hard. A waiter's id is on every bill they ever
 * opened; removing the row makes those reports say "—" for ever. Anyone who has
 * touched an order is deactivated instead, and the caller is told why.
 */
async function deleteUser(clientId, userId, actorId) {
  const target = await db.one('SELECT * FROM users WHERE id=? AND client_id=?', [userId, clientId]);
  if (!target) throw bad('Kullanıcı bulunamadı', 404);
  if (Number(actorId) === Number(userId)) throw bad('Kendi hesabınızı silemezsiniz.');
  await guardUserChange(clientId, target, { is_active: false }, actorId);

  const used = await db.value(
    'SELECT COUNT(*) FROM orders WHERE client_id=? AND (waiter_id=? OR closed_by=?)',
    [clientId, userId, userId]).catch(() => 0);
  if (Number(used) > 0) {
    await db.exec('UPDATE users SET is_active=0, is_logged_in=0 WHERE id=? AND client_id=?', [userId, clientId]);
    return { deleted: false, deactivated: true,
      message: `${target.display_name} adına ${used} adisyon var. Hesap silinmedi, kapatıldı.` };
  }
  await db.exec('DELETE FROM user_permissions WHERE client_id=? AND user_id=?', [clientId, userId]);
  await db.exec('DELETE FROM users WHERE id=? AND client_id=?', [userId, clientId]);
  return { deleted: true, deactivated: false, message: 'Kullanıcı silindi.' };
}

function permissionCatalogue() {
  return {
    permissions: auth.PERMISSIONS.map(k => ({ key: k, label: PERM_LABELS[k] || k })),
    groups: PERM_GROUPS,
    roles: auth.ROLES.map(r => ({ key: r, label: ROLE_LABELS[r] || r })),
  };
}

/* ------------------------- my own profile -------------------------- */
/**
 * Self service.
 *
 * Everything above needs `user.manage`, which is right - one waiter must not be
 * able to rename another. But it left the four things a person needs to do to
 * their OWN account (see their role, fix a misspelt name, change their phone
 * password, change their till PIN) behind a permission they will never hold, so
 * in practice a cashier had to ask the owner to change their PIN. These four
 * take no permission at all beyond being signed in, and each one requires the
 * CURRENT credential: a till left unlocked for two minutes must not be enough
 * to take somebody's account.
 */
async function myProfile(clientId, userId) {
  const u = await db.one(
    `SELECT id, username, email, display_name, role, is_active, created_at, pin_changed_at,
            (pin_hash IS NOT NULL) AS has_pin, (password_hash <> '') AS has_password
       FROM users WHERE id=? AND client_id=?`, [userId, clientId]);
  if (!u) throw bad('Kullanıcı bulunamadı', 404);
  u.role_label = ROLE_LABELS[u.role] || u.role;
  return {
    user: u,
    permissions: (await auth.permissionsFor(clientId, userId, u.role))
      .map(k => ({ key: k, label: PERM_LABELS[k] || k })),
    pin_length: await pinLength(),
  };
}

async function updateMyProfile(clientId, userId, data) {
  const name = String(data.display_name || '').trim();
  if (!name) throw bad('Ad soyad boş olamaz');
  const username = String(data.username || '').trim();
  if (username) {
    const dupe = await db.one('SELECT id FROM users WHERE client_id=? AND username=? AND id<>?',
      [clientId, username, userId]);
    if (dupe) throw bad('Bu kullanıcı adı zaten kullanılıyor');
  }
  await db.exec('UPDATE users SET display_name=?, username=?, updated_at=NOW() WHERE id=? AND client_id=?',
    [name, username, userId, clientId]);
  return true;
}

async function changeMyPassword(clientId, userId, current, next) {
  const bcrypt = require('bcryptjs');
  const u = await db.one('SELECT password_hash FROM users WHERE id=? AND client_id=?', [userId, clientId]);
  if (!u) throw bad('Kullanıcı bulunamadı', 404);
  if (!u.password_hash || !bcrypt.compareSync(String(current || ''), u.password_hash)) {
    throw bad('Mevcut şifre doğrulanamadı');
  }
  if (String(next || '').length < 6) throw bad('Yeni şifre en az 6 karakter olmalı');
  await db.exec('UPDATE users SET password_hash=?, updated_at=NOW() WHERE id=? AND client_id=?',
    [auth.hash(next), userId, clientId]);
  return true;
}

async function changeMyPin(clientId, userId, current, next) {
  const bcrypt = require('bcryptjs');
  const u = await db.one('SELECT pin_hash FROM users WHERE id=? AND client_id=?', [userId, clientId]);
  if (!u) throw bad('Kullanıcı bulunamadı', 404);
  if (u.pin_hash && !bcrypt.compareSync(String(current || ''), u.pin_hash)) {
    throw bad('Mevcut PIN doğrulanamadı');
  }
  // resetPin does the collision check, the audit columns and the lock clear
  return resetPin(clientId, userId, next, userId);
}

/* ==================================================================== *
 * 3. STATIONS AND PRINTERS                                             *
 * ==================================================================== */

/**
 * Where a station's orders come out.
 *
 * The order matters to nothing but the form; the DEFAULT matters to everything.
 * 'screen' is first and is what a station is born as, because Ekranlar is this
 * product's output and a printer is the exception - see stationOverview.
 */
const OUTPUT_MODES = ['screen', 'printer', 'both'];
const OUTPUT_MODE_LABELS = {
  screen: 'Ekrana', printer: 'Yazıcıya', both: 'İkisine',
};

async function listStations(clientId) {
  return db.query(
    `SELECT s.*,
            (SELECT COUNT(*) FROM printers p WHERE p.client_id=s.client_id AND p.station_id=s.id) AS printer_count,
            (SELECT COUNT(*) FROM categories c WHERE c.client_id=s.client_id AND c.station_id=s.id) AS category_count
       FROM stations s WHERE s.client_id=? ORDER BY s.sort_order, s.id`, [clientId]);
}

/**
 * What a station has ever carried - the same shape pricing.usage() answers for
 * a product, and for the same reason: the delete button has to know whether it
 * is offering a delete or a lie.
 *
 * Three tables, because "sent to this station" is recorded in three places and
 * losing any one of them breaks a different screen. order_items.station_id is
 * what the kitchen board reads back (COALESCE(oi.station_id, c.station_id)),
 * station_projection_items is the board's own row, and print_jobs is the slip
 * that came out of the printer. A station whose id is still referenced by any
 * of them cannot be removed without turning yesterday's tickets into rows that
 * join to nothing - there are no foreign keys on this schema to stop it.
 */
async function stationUsage(clientId, stationId) {
  /* The same routing rule the kitchen board and sendToStations use: the
     category's station, with a per-line override if one was ever written. */
  const ROUTED = `FROM order_items oi
       LEFT JOIN products p ON p.id=oi.product_id AND p.client_id=oi.client_id
       LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
      WHERE oi.client_id=? AND COALESCE(oi.station_id, c.station_id)=? AND oi.sent_qty>0`;
  const items = Number(await db.value(`SELECT COUNT(*) ${ROUTED}`, [clientId, stationId]));
  const orders = Number(await db.value(
    `SELECT COUNT(DISTINCT oi.order_id) ${ROUTED}`, [clientId, stationId]));
  const tickets = Number(await db.value(
    'SELECT COUNT(*) FROM station_projection_items WHERE client_id=? AND station_id=?',
    [clientId, stationId]));
  const jobs = Number(await db.value(
    'SELECT COUNT(*) FROM print_jobs WHERE client_id=? AND station_id=?', [clientId, stationId]));
  const lastSent = await db.value(
    `SELECT MAX(oi.station_updated_at) ${ROUTED}`, [clientId, stationId]);
  return {
    items, orders, tickets, jobs, last_sent: lastSent,
    can_hard_delete: items === 0 && tickets === 0 && jobs === 0,
  };
}

/**
 * How long a board may go untouched, with orders on it, before the İstasyonlar
 * screen says nobody is working it.
 *
 * Deliberately far beyond service reality - the kitchen board's own "late" mark
 * is twenty minutes (floor.AGE_LATE). Two hours is not a slow kitchen, it is a
 * kitchen that is not there, and the number has to be one nobody argues with:
 * this warning only earns its place if it is never wrong.
 */
const BOARD_SILENT_MIN = 120;

/**
 * "Is anybody working this board" - per station, in one pass.
 *
 * There is NO record anywhere of a station board being opened. Ekranlar is a
 * read: floor.boardStations and floor.kitchenBoard select and return, and
 * nothing writes a heartbeat, a session or a last-seen. The one thing the board
 * DOES write is floor.setItemState - a ticket moved to hazırlanıyor / hazır /
 * verildi - so that is the signal used here, because inventing a column that
 * nothing on the board would ever write would give us a fault that fires on
 * every site forever, which is the exact mistake this whole change is undoing.
 *
 * `station_updated_at` alone will not do: orders.sendToStations stamps it at
 * SEND time with station_status 'new', so on its own it says "an order arrived",
 * not "somebody dealt with one". The state is what separates them - 'preparing',
 * 'ready' and 'served' are only ever set from the board.
 *
 * Bounded to a week so this stays an index range (idx_oi_station_touch) rather
 * than a walk over every order the restaurant has ever taken: everything the
 * answer turns on happened in the last few hours, and a bill left open for
 * eight days is a different problem with its own screen.
 */
async function stationBoardActivity(clientId) {
  const rows = await db.query(
    `SELECT COALESCE(oi.station_id, c.station_id) AS station_id,
            SUM(o.status='open' AND oi.is_deleted=0
                AND oi.station_status NOT IN ('served','cancelled')) AS waiting,
            MAX(CASE WHEN o.status='open' AND oi.is_deleted=0
                          AND oi.station_status NOT IN ('served','cancelled')
                     THEN TIMESTAMPDIFF(MINUTE, COALESCE(oi.station_updated_at, o.opened_at), NOW())
                END) AS waited_min,
            MAX(CASE WHEN oi.station_status IN ('preparing','ready','served')
                     THEN oi.station_updated_at END) AS last_touch
       FROM order_items oi
       JOIN products p ON p.id=oi.product_id AND p.client_id=oi.client_id
       LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
       JOIN orders o ON o.id=oi.order_id AND o.client_id=oi.client_id
      WHERE oi.client_id=? AND oi.sent_qty>0
        AND oi.station_updated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY COALESCE(oi.station_id, c.station_id)`, [clientId]);
  const by = new Map();
  for (const r of rows) {
    if (r.station_id === null) continue;
    by.set(Number(r.station_id), {
      waiting: Number(r.waiting) || 0,
      waited_min: Number(r.waited_min) || 0,
      last_touch: r.last_touch || null,
      touch_min: r.last_touch
        ? Math.max(0, Math.round((Date.now() - new Date(r.last_touch).getTime()) / 60000))
        : null,
    });
  }
  return by;
}

/**
 * The station list the İstasyonlar screen draws, with every way a station can
 * be silently broken named on the row.
 *
 * This is the whole point of the screen. Every fault here is invisible
 * everywhere else in the program and they all end the same way - the kitchen
 * never hears about an order - so none of them can be left to be inferred from
 * a count of zero:
 *
 *   no printer     the slips are queued and thrown away; the waiter sees a
 *                  successful "gönder" and the pass sees nothing
 *   no categories  nothing routes here at all, so the station is decoration
 *   board unwatched  orders are landing on a screen nobody is working
 *
 * WHAT CHANGED, AND WHY.
 *
 * `no_printer` used to fire on any station with no printer, full stop. That was
 * written when a printer was assumed to be how a station receives an order, and
 * it is backwards: this is a screen-first till, Ekranlar IS the output, and most
 * of the restaurants we are opening with will never own a kitchen printer. The
 * warning therefore fired on every correctly configured station at every site -
 * a screen of red that means nothing, which is how a person learns to stop
 * reading warnings and then misses the one that is true.
 *
 * So the station now SAYS where its orders go (`output_mode`, default 'screen')
 * and paper is only missing when paper was asked for. A 'screen' station with no
 * printer is not a fault, it is the product working as designed, and the row
 * reports it as correct.
 *
 * `board_unwatched` is the screen-first half of the same silence, and it is here
 * because removing the printer warning without it would leave the screen-only
 * station with no way at all to be found broken. Its evidence is weaker than the
 * others' by nature - see stationBoardActivity, nothing records a board being
 * opened - so it is deliberately slow to fire and needs orders actually waiting:
 * a closed restaurant at four in the morning must not be red.
 *
 * The kasa/fiş station is exempt from all of it: it prints bills, it does not
 * cook, and telling an owner his till station has no food on it would be the
 * screen crying wolf on the one row that is correct.
 */
async function stationOverview(clientId) {
  const rows = await listStations(clientId);
  const receiptStationId = Number(await db.value(
    'SELECT receipt_station_id FROM clients WHERE id=?', [clientId])) || 0;
  const printers = await db.query(
    `SELECT id, name, station_id, is_default FROM printers
      WHERE client_id=? ORDER BY is_default DESC, id`, [clientId]);
  const activeCount = rows.filter(s => Number(s.is_active) === 1).length;
  const activity = await stationBoardActivity(clientId);

  for (const s of rows) {
    s.printer_count = Number(s.printer_count);
    s.category_count = Number(s.category_count);
    s.is_active = Number(s.is_active);
    s.is_default = Number(s.is_default);
    s.sort_order = Number(s.sort_order);
    s.output_mode = OUTPUT_MODES.includes(String(s.output_mode)) ? String(s.output_mode) : 'screen';
    s.output_mode_label = OUTPUT_MODE_LABELS[s.output_mode];
    s.is_receipt_station = Number(s.id) === receiptStationId;
    s.printers = printers.filter(p => Number(p.station_id) === Number(s.id))
      .map(p => ({ id: p.id, name: p.name }));
    s.usage = await stationUsage(clientId, s.id);
    s.board = activity.get(Number(s.id))
      || { waiting: 0, waited_min: 0, last_touch: null, touch_min: null };
    s.can_hard_delete = s.usage.can_hard_delete && !s.printer_count && !s.category_count
      && !s.is_default && !s.is_receipt_station;

    /*
     * One Turkish sentence per fault, each of them saying the CONSEQUENCE and
     * not the condition. "Yazıcı yok" on its own reads as a setting somebody
     * has not got round to; "fişleri hiçbir yerden çıkmaz" is the reason it
     * matters at seven in the evening.
     */
    const problems = [];
    if (s.is_active && !s.is_receipt_station) {
      const wantsPaper = s.output_mode === 'printer' || s.output_mode === 'both';
      const wantsScreen = s.output_mode === 'screen' || s.output_mode === 'both';
      if (wantsPaper && !s.printer_count) {
        problems.push({
          kind: 'no_printer',
          text: 'Yazıcı bağlı değil — bu istasyona gönderilen fişler hiçbir yerden çıkmaz.',
          fix: 'Yazıcı bağla',
        });
      }
      if (!s.category_count) {
        problems.push({
          kind: 'no_category',
          text: 'Kategori bağlı değil — bu istasyona hiçbir sipariş düşmez.',
          fix: 'Kategori bağla',
        });
      }
      /* Both halves are required. Orders waiting proves there is something to
         look at; a board nobody has moved a ticket on for two hours proves
         nobody is looking. Either one alone is an ordinary quiet evening. */
      if (wantsScreen && s.board.waiting > 0 && s.board.waited_min >= BOARD_SILENT_MIN
          && (s.board.touch_min === null || s.board.touch_min >= BOARD_SILENT_MIN)) {
        problems.push({
          kind: 'board_unwatched',
          text: `Ekranlar panosunda ${s.board.waiting} sipariş bekliyor ve saatlerdir hiçbiri `
            + 'ilerletilmedi — bu istasyonun siparişleri kimsenin bakmadığı bir ekrana düşüyor.',
          fix: 'Ekranlar\'ı aç',
        });
      }
    }
    s.problems = problems;
    /* Deactivating the last working station stops the kitchen; the row says so
       before the button is pressed rather than after. */
    s.last_active_with_categories = s.is_active && activeCount <= 1 && s.category_count > 0;
  }

  const categories = await categoriesWithStation(clientId);
  return {
    stations: rows,
    categories,
    printers,
    receipt_station_id: receiptStationId,
    unassigned_categories: categories.filter(c => !c.station_id).length,
  };
}

async function saveStation(clientId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw bad('İstasyon adı zorunlu');
  /*
   * The station NAME is the key the print agent routes on - it is sent
   * verbatim - so it is restricted to what a printer queue name may contain.
   * display_name is the free-text label the screens show.
   */
  if (!/^[A-Za-z0-9ĞÜŞİÖÇğüşıöç _-]{2,50}$/.test(name)) {
    throw bad('İstasyon adı 2-50 karakter olmalı ve yalnızca harf, rakam, boşluk, - ve _ içerebilir');
  }
  const dupe = await db.one('SELECT id FROM stations WHERE client_id=? AND name=? AND id<>?',
    [clientId, name, data.id || 0]);
  if (dupe) throw bad('Bu adda bir istasyon zaten var');

  /*
   * An edit is merged over the stored row, never written from the form alone.
   *
   * catalog.saveStation writes all five columns on an UPDATE, with `is_active`
   * defaulting to 1, `is_default` to 0 and `sort_order` to 0. A screen that
   * renamed a station and sent only {id, name} therefore reactivated a retired
   * station, cleared the default flag off the kasa station and moved the row to
   * the top of the kitchen board - three changes nobody asked for. Renaming has
   * to be free, and free means it touches the name and nothing else.
   */
  let current = null;
  if (data.id) {
    current = await db.one('SELECT * FROM stations WHERE id=? AND client_id=?', [data.id, clientId]);
    if (!current) throw bad('İstasyon bulunamadı', 404);
  }
  const pick = (key, dflt) => (data[key] === undefined || data[key] === null || data[key] === ''
    ? (current ? current[key] : dflt) : data[key]);

  const payload = {
    id: data.id || null,
    name,
    display_name: String(pick('display_name', name) || name).trim() || name,
    is_active: pick('is_active', 1),
    is_default: pick('is_default', 0),
    sort_order: Number(pick('sort_order', await nextStationOrder(clientId))) || 0,
    /* A new station is born on the screen. Everything in this till that shows a
       station - the board, the İstasyonlar row, the category picker - works with
       nothing plugged in, so the mode that needs no hardware is the one an owner
       who has not thought about it should get. */
    output_mode: pick('output_mode', 'screen'),
  };
  if (String(payload.display_name).length > 60) throw bad('Görünen ad en fazla 60 karakter olabilir');
  if (!OUTPUT_MODES.includes(String(payload.output_mode))) {
    throw bad('Siparişin nereye gideceği "Ekrana", "Yazıcıya" ya da "İkisine" olabilir');
  }

  const id = await catalog.saveStation(clientId, payload);
  if (payload.is_default) await db.exec('UPDATE stations SET is_default=0 WHERE client_id=? AND id<>?', [clientId, id]);
  log.info('settings', data.id ? 'station updated' : 'station created', { clientId, id, name });
  return id;
}

/** A new station goes to the end of the kitchen board, not into position 0. */
async function nextStationOrder(clientId) {
  return Number(await db.value('SELECT COALESCE(MAX(sort_order),0)+1 FROM stations WHERE client_id=?',
    [clientId])) || 1;
}

/**
 * Hard delete only for a station no ticket has ever reached.
 *
 * The same rule as pricing.deleteProduct, written here for the same reason: the
 * kitchen board, the mutfak geçmişi and every printed slip resolve their
 * station by id, and a deleted id turns them into rows that join to nothing.
 * The refusal names the count so the answer is checkable ("hangi 34 satır")
 * rather than a flat no, and it names the alternative, because pasife almak is
 * what the owner actually wanted in every case we have seen.
 */
async function deleteStation(clientId, stationId) {
  const st = await db.one('SELECT * FROM stations WHERE id=? AND client_id=?', [stationId, clientId]);
  if (!st) throw bad('İstasyon bulunamadı', 404);
  const printers = await db.value('SELECT COUNT(*) FROM printers WHERE client_id=? AND station_id=?', [clientId, stationId]);
  const cats = await db.value('SELECT COUNT(*) FROM categories WHERE client_id=? AND station_id=?', [clientId, stationId]);
  if (Number(printers) || Number(cats)) {
    throw bad(`Bu istasyona ${printers} yazıcı ve ${cats} kategori bağlı. Önce başka bir istasyona taşıyın.`);
  }
  if (st.is_default) throw bad('Varsayılan istasyon silinemez. Önce başka bir istasyonu varsayılan yapın.');

  const use = await stationUsage(clientId, stationId);
  if (!use.can_hard_delete) {
    throw bad(`"${st.display_name || st.name}" istasyonuna daha önce sipariş gönderilmiş `
      + `(${use.items} satır, ${use.orders} adisyon, ${use.jobs} yazdırma işi). `
      + 'Kalıcı silinemez; yalnızca pasife alınabilir.', 409);
  }
  await db.exec('DELETE FROM stations WHERE id=? AND client_id=?', [stationId, clientId]);
  log.info('settings', 'station deleted', { clientId, stationId, name: st.name });
  return { mode: 'deleted', station_id: Number(stationId) };
}

/**
 * Retire a station, or put it back.
 *
 * The one thing this must not allow is the till going quiet. If the station
 * being switched off is the last active one and categories still point at it,
 * every order those categories carry stops reaching a board and stops printing
 * - and nothing anywhere says so, because "sent" is recorded on the item
 * whether or not a station was listening. So that case is refused, with the
 * number of categories that would have been stranded.
 */
async function setStationActive(clientId, stationId, active) {
  const st = await db.one('SELECT * FROM stations WHERE id=? AND client_id=?', [stationId, clientId]);
  if (!st) throw bad('İstasyon bulunamadı', 404);
  const on = active ? 1 : 0;
  if (Number(st.is_active) === on) return { station_id: Number(stationId), is_active: on };

  if (!on) {
    const cats = Number(await db.value(
      'SELECT COUNT(*) FROM categories WHERE client_id=? AND station_id=?', [clientId, stationId]));
    const othersActive = Number(await db.value(
      'SELECT COUNT(*) FROM stations WHERE client_id=? AND is_active=1 AND id<>?', [clientId, stationId]));
    if (!othersActive && cats > 0) {
      throw bad(`"${st.display_name || st.name}" son etkin istasyon ve ${cats} kategori hâlâ buraya bağlı. `
        + 'Pasife alınırsa mutfak sipariş almayı sessizce bırakır. '
        + 'Önce kategorileri başka bir istasyona taşıyın ya da yeni bir istasyon açın.', 409);
    }
    if (Number(st.is_default) && othersActive) {
      /* The default is what a category with no station falls back to; leaving
         it pointing at a retired row is the same silence by another route. */
      const heir = await db.one(
        'SELECT id FROM stations WHERE client_id=? AND is_active=1 AND id<>? ORDER BY sort_order, id LIMIT 1',
        [clientId, stationId]);
      if (heir) {
        await db.exec('UPDATE stations SET is_default=0 WHERE client_id=?', [clientId]);
        await db.exec('UPDATE stations SET is_default=1 WHERE id=? AND client_id=?', [heir.id, clientId]);
      }
    }
  }
  await db.exec('UPDATE stations SET is_active=? WHERE id=? AND client_id=?', [on, stationId, clientId]);
  log.info('settings', on ? 'station reactivated' : 'station deactivated', { clientId, stationId });
  return { station_id: Number(stationId), is_active: on };
}

/**
 * The order the kitchen board draws its chips in.
 *
 * Written as a whole list rather than one row at a time: the screen moves a
 * station up by handing back the order it wants, and a per-row +1/-1 leaves
 * two stations sharing a sort_order the first time anything is inserted.
 */
async function reorderStations(clientId, ids) {
  const wanted = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
  if (!wanted.length) throw bad('Sıralanacak istasyon listesi boş');
  const mine = await db.query('SELECT id FROM stations WHERE client_id=?', [clientId]);
  const known = new Set(mine.map(s => Number(s.id)));
  for (const id of wanted) if (!known.has(id)) throw bad('Bu istasyon size ait değil: ' + id, 404);
  await db.tx(async t => {
    let n = 1;
    for (const id of wanted) {
      await t.exec('UPDATE stations SET sort_order=? WHERE id=? AND client_id=?', [n++, id, clientId]);
    }
  });
  return wanted.length;
}

async function setDefaultStation(clientId, stationId) {
  const st = await db.one('SELECT id FROM stations WHERE id=? AND client_id=?', [stationId, clientId]);
  if (!st) throw bad('İstasyon bulunamadı', 404);
  await db.exec('UPDATE stations SET is_default=0 WHERE client_id=?', [clientId]);
  await db.exec('UPDATE stations SET is_default=1 WHERE id=? AND client_id=?', [stationId, clientId]);
  return true;
}

/**
 * Which categories print at this station. This is the single most-asked
 * question of a restaurant POS ("içecekler bara, yemekler mutfağa") and the old
 * settings screen could not answer it at all - station_id was only editable one
 * category at a time from the products screen.
 */
async function assignCategories(clientId, stationId, categoryIds) {
  const st = await db.one('SELECT id FROM stations WHERE id=? AND client_id=?', [stationId, clientId]);
  if (!st) throw bad('İstasyon bulunamadı', 404);
  const ids = (Array.isArray(categoryIds) ? categoryIds : []).map(Number).filter(Boolean);
  await db.tx(async t => {
    // clear the ones that moved away, then claim the listed ones
    await t.exec('UPDATE categories SET station_id=NULL WHERE client_id=? AND station_id=?', [clientId, stationId]);
    for (const cid of ids) {
      await t.exec('UPDATE categories SET station_id=? WHERE id=? AND client_id=?', [stationId, cid, clientId]);
    }
  });
  return ids.length;
}

async function categoriesWithStation(clientId) {
  return db.query(
    `SELECT c.id, c.name, c.station_id, c.is_active, s.display_name AS station_name
       FROM categories c LEFT JOIN stations s ON s.id=c.station_id AND s.client_id=c.client_id
      WHERE c.client_id=? ORDER BY c.sort_order, c.name`, [clientId]);
}

const PRINTER_TYPES = [
  ['network', 'Ağ yazıcısı (IP:9100)'],
  ['usb', 'Windows yazıcısı (USB)'],
  ['share', 'Paylaşılan Windows yazıcısı'],
  ['file', 'Dosyaya yaz (servis / test)'],
];

async function listPrinters(clientId) {
  const printers = await db.query(
    `SELECT p.*, s.display_name AS station_name FROM printers p
       LEFT JOIN stations s ON s.id=p.station_id AND s.client_id=p.client_id
      WHERE p.client_id=? ORDER BY p.is_default DESC, p.id`, [clientId]);
  let windows = [];
  try { windows = await transport.listWindowsPrinters(); } catch (_) { windows = []; }
  return { printers, windows_printers: windows, types: PRINTER_TYPES };
}

async function savePrinter(clientId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw bad('Yazıcı adı zorunlu');
  const type = String(data.type || 'network');
  if (!PRINTER_TYPES.some(([k]) => k === type)) throw bad('Bilinmeyen yazıcı türü: ' + type);
  const addr = String(data.ip_address || '').trim();
  if (type === 'network') {
    if (!addr) throw bad('Ağ yazıcısı için IP adresi zorunlu');
    const [host, port] = addr.split(':');
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host) && !/^[a-z0-9.-]+$/i.test(host)) {
      throw bad('IP adresi ya da makine adı geçersiz: ' + host);
    }
    if (port && !(Number(port) > 0 && Number(port) < 65536)) throw bad('Port 1-65535 arasında olmalı');
  } else if (type !== 'file' && !addr) {
    throw bad('Windows yazıcı adı zorunlu');
  }
  const dupe = await db.one('SELECT id FROM printers WHERE client_id=? AND name=? AND id<>?',
    [clientId, name, data.id || 0]);
  if (dupe) throw bad('Bu adda bir yazıcı zaten var');

  /*
   * printers.station_id is NOT NULL in the schema and the server runs in
   * STRICT_TRANS_TABLES, so "no station" has to be 0, not NULL. Writing NULL is
   * what makes the printer form in manage.js fail with a 500 (see
   * inv/HANDOFF-settings.md).
   */
  const stationId = Number(data.station_id) || 0;
  let id = Number(data.id) || 0;
  if (id) {
    const owned = await db.one('SELECT id FROM printers WHERE id=? AND client_id=?', [id, clientId]);
    if (!owned) throw bad('Yazıcı bulunamadı', 404);
    await db.exec(
      'UPDATE printers SET station_id=?, name=?, type=?, ip_address=?, is_default=? WHERE id=? AND client_id=?',
      [stationId, name, type, addr || null, data.is_default ? 1 : 0, id, clientId]);
  } else {
    id = await db.insert(
      'INSERT INTO printers (client_id, station_id, name, type, ip_address, is_default, created_at) VALUES (?,?,?,?,?,?,NOW())',
      [clientId, stationId, name, type, addr || null, data.is_default ? 1 : 0]);
  }
  if (data.is_default) await db.exec('UPDATE printers SET is_default=0 WHERE client_id=? AND id<>?', [clientId, id]);
  return id;
}

async function deletePrinter(clientId, printerId) {
  const p = await db.one('SELECT * FROM printers WHERE id=? AND client_id=?', [printerId, clientId]);
  if (!p) throw bad('Yazıcı bulunamadı', 404);
  await db.exec('DELETE FROM printers WHERE id=? AND client_id=?', [printerId, clientId]);
  return true;
}

/**
 * Test print - and say honestly what happened.
 *
 * This returns a RESULT rather than throwing, because "there is no printer at
 * this address" is the normal answer during setup, not an exception. The old
 * screen showed a green tick as soon as the job was queued, whether or not any
 * paper ever moved; here the bytes go to the device synchronously and the
 * failure text from the socket is passed straight back to the person holding
 * the cable.
 */
async function testPrinter(clientId, printerId) {
  const count = Number(await db.value('SELECT COUNT(*) FROM printers WHERE client_id=?', [clientId]));
  if (!count) {
    return { printed: false, reason: 'no_printer',
      message: 'Tanımlı yazıcı yok. Önce bir yazıcı ekleyin.' };
  }
  const p = await db.one('SELECT * FROM printers WHERE id=? AND client_id=?', [printerId, clientId]);
  if (!p) return { printed: false, reason: 'not_found', message: 'Yazıcı bulunamadı.' };
  try {
    await printing.testPrint(clientId, printerId);
    return { printed: true, reason: 'sent', printer: p.name,
      message: `Test fişi ${p.name} yazıcısına gönderildi. Kağıt çıkmadıysa bağlantıyı kontrol edin.` };
  } catch (e) {
    return { printed: false, reason: 'transport', printer: p.name,
      message: `${p.name} yanıt vermedi: ${e.message}` };
  }
}

/* ---------------------------- print queue --------------------------- */
/**
 * The queue view the old system did not have. When a printer is off, jobs pile
 * up as 'pending' and the restaurant finds out because the kitchen is quiet -
 * this is where you see it, and where you push them through again.
 */
async function printQueue(clientId, { status = '', limit = 100 } = {}) {
  const params = [clientId];
  let where = 'WHERE j.client_id=?';
  if (status) { where += ' AND j.status=?'; params.push(status); }
  params.push(Math.min(Number(limit) || 100, 500));
  const jobs = await db.query(
    `SELECT j.id, j.job_type, j.order_id, j.station_id, j.status, j.created_at, j.sent_at,
            s.display_name AS station_name, o.adisyon_no
       FROM print_jobs j
       LEFT JOIN stations s ON s.id=j.station_id AND s.client_id=j.client_id
       LEFT JOIN orders o ON o.id=j.order_id
       ${where} ORDER BY j.id DESC LIMIT ?`, params);
  const counts = await db.query(
    'SELECT status, COUNT(*) n FROM print_jobs WHERE client_id=? GROUP BY status', [clientId]);
  const by = { pending: 0, sent: 0, done: 0, failed: 0 };
  for (const c of counts) by[c.status] = Number(c.n);
  const last = await db.value(
    "SELECT MAX(sent_at) FROM print_jobs WHERE client_id=? AND status='done'", [clientId]);
  const warnings = [];
  // the old print_agent.php warned above five queued jobs; the number is a good one
  if (by.pending > 5) warnings.push(`${by.pending} iş kuyrukta bekliyor. Yazıcı kapalı olabilir.`);
  if (by.failed > 0) warnings.push(`${by.failed} iş başarısız. Yeniden deneyebilirsiniz.`);
  const printers = Number(await db.value('SELECT COUNT(*) FROM printers WHERE client_id=?', [clientId]));
  if (!printers) warnings.push('Hiç yazıcı tanımlı değil; kuyruktaki işler basılamaz.');
  return { jobs, counts: by, last_print_at: last, warnings };
}

async function retryJob(clientId, jobId) {
  const n = await db.exec("UPDATE print_jobs SET status='pending', sent_at=NULL WHERE id=? AND client_id=?",
    [jobId, clientId]);
  if (!n) throw bad('Yazdırma işi bulunamadı', 404);
  return true;
}

async function retryFailed(clientId) {
  return db.exec("UPDATE print_jobs SET status='pending', sent_at=NULL WHERE client_id=? AND status='failed'",
    [clientId]);
}

async function cancelJob(clientId, jobId) {
  const n = await db.exec("UPDATE print_jobs SET status='failed' WHERE id=? AND client_id=? AND status='pending'",
    [jobId, clientId]);
  if (!n) throw bad('Yalnızca bekleyen bir iş iptal edilebilir', 400);
  return true;
}

/* ==================================================================== *
 * 4. ÖKC (Yeni Nesil Yazarkasa)                                        *
 * ==================================================================== */

/**
 * The honest provider catalogue.
 *
 * inv/06-okc-providers.md counted the old PHP: 78 % of the fiscal code is the
 * mock and Token; Hugin, Paygo and Worldline are 293 lines of constants and
 * `throw`. The screen there still listed all of them in one dropdown with no
 * hint that picking one meant the card button would never work.
 *
 * So each provider carries a status, and the UI prints it:
 *   ready   - runs today, end to end, tested         (simulator)
 *   beta    - protocol implemented, needs the vendor's field names confirmed
 *             against a real terminal before you trust it in a shop  (token)
 *   sdk     - the generic GMP-3 client with guessed defaults; the manufacturer's
 *             integration document is needed to finish it
 *   planned - nothing is written; listed so nobody thinks it is hiding
 *
 * `production` is refused for anything below beta: a restaurant must not be
 * able to point a live till at an unfinished adapter and find out at dinner.
 */
const PROVIDERS = [
  { key: 'simulator', label: 'Simülatör (yazılım ÖKC)', status: 'ready',
    note: 'Donanım olmadan tüm ödeme akışını çalıştırır. Eğitim ve deneme için.',
    fields: [] },
  { key: 'token', label: 'Token / Verifone', status: 'beta',
    note: 'GMP-3 protokolü yazıldı. Cihazın firmware alan adları üreticinin entegrasyon dokümanıyla doğrulanmalı.',
    fields: ['device_ip', 'device_port', 'serial_number'], defaultPort: 7600 },
  { key: 'ingenico', label: 'Ingenico', status: 'sdk',
    note: 'Genel GMP-3 istemcisi bağlı; üreticinin entegrasyon dokümanı olmadan alan adları doğrulanmadı.',
    fields: ['device_ip', 'device_port', 'serial_number'], defaultPort: 7500 },
  { key: 'hugin', label: 'Hugin', status: 'sdk',
    note: 'Eski sistemde yalnızca iskeleti vardı. Burada genel GMP-3 istemcisine bağlandı, gerçek cihazda denenmedi.',
    fields: ['device_ip', 'device_port', 'serial_number'], defaultPort: 7500 },
  { key: 'profilo', label: 'Profilo', status: 'sdk',
    note: 'Hugin firmware\'i ile aynı; aynı doğrulama gerekiyor.',
    fields: ['device_ip', 'device_port', 'serial_number'], defaultPort: 7500 },
  { key: 'beko', label: 'Beko', status: 'sdk',
    note: 'Token firmware\'i ile aynı; aynı doğrulama gerekiyor.',
    fields: ['device_ip', 'device_port', 'serial_number'], defaultPort: 7600 },
  { key: 'olivetti', label: 'Olivetti', status: 'sdk',
    note: 'Genel GMP-3 istemcisi bağlı, gerçek cihazda denenmedi.',
    fields: ['device_ip', 'device_port', 'serial_number'], defaultPort: 7500 },
  { key: 'paygo', label: 'PayGo', status: 'planned',
    note: 'Henüz yazılmadı. Eski sistemde de yalnızca boş bir sınıftı; seçilemez.',
    fields: [] },
  { key: 'worldline', label: 'Worldline', status: 'planned',
    note: 'Henüz yazılmadı. Eski sistemde de yalnızca boş bir sınıftı; seçilemez.',
    fields: [] },
];

const STATUS_LABEL = {
  ready: 'Çalışıyor',
  beta: 'Deneme (doğrulanmalı)',
  sdk: 'SDK gerekli',
  planned: 'Planlandı',
};

function providerCatalogue() {
  return PROVIDERS.map(p => ({
    ...p,
    status_label: STATUS_LABEL[p.status],
    selectable: p.status !== 'planned',
    // an adapter class actually exists for these; 'planned' ones would fall
    // back to the simulator and silently pretend to work
    implemented: !!fiscal.ADAPTERS[p.key],
    allows_production: p.status === 'ready' || p.status === 'beta',
  }));
}

function providerByKey(key) { return PROVIDERS.find(p => p.key === String(key || '').toLowerCase()) || null; }

/**
 * The GİB register, for the "Cihaz ekle" dialog.
 *
 * PROVIDERS above is the list of DRIVERS we have written. This is the list of
 * DEVICES that legally exist. They are not the same list and conflating them is
 * what let a cashier pick "Hugin" for a Profilo: one fiscal owner can cover
 * several brands, and the same brand can sit under two owners.
 *
 * The dialog asks for the device; the driver follows from it.
 */
/*
 * Fiscal owner -> the driver we have written, where the two have different
 * names.
 *
 * This map exists because the obvious rule is wrong. The MOVE5000F's fiscal
 * owner is WORLDLINE; the hardware is Ingenico; the driver is called
 * `ingenico`. Matching on the name alone found nothing and silently left the
 * form on whatever was already selected.
 *
 * Every entry here is a SUGGESTION, never a claim. The specification is blunt
 * about it: one company can supply several protocol families, and the same
 * hardware maker appears under several fiscal owners, so the adapter belongs
 * to evidence-backed configuration rather than to a brand name. The screen
 * says so, and the capability profile still has to be proven per device.
 */
const OWNER_DRIVER_HINT = {
  token:     { driver: 'token',    basis: 'Token firmware - aynı mali sahip' },
  hugin:     { driver: 'hugin',    basis: 'Hugin firmware - aynı mali sahip' },
  worldline: { driver: 'ingenico', basis: 'Donanım Ingenico; sürücü Ingenico için yazıldı' },
  pavo:      { driver: 'ingenico', basis: 'Donanım Ingenico; sürücü Ingenico için yazıldı' },
  panaroma:  { driver: 'olivetti', basis: 'Olivetti cihazları; sürücü Olivetti için yazıldı' },
};

async function registryCatalogue() {
  const kayit = require('../fiscal/kayit');
  const rows = await kayit.all(null, { includeFuel: false });
  /*
   * A suggestion has to be a driver the dialog can actually select.
   * `worldline` exists in PROVIDERS with status 'planned', which means no
   * adapter was ever written and the dropdown filters it out - so naming it
   * set the select to a value that was not in the list, and the form quietly
   * stayed on whatever was already chosen. Selectability, not existence.
   */
  const usable = (key) => {
    const p = providerByKey(key);
    return p && p.status !== 'planned' ? key : null;
  };
  return rows.map(r => {
    const direct = usable(r.owner_key);
    const hint = OWNER_DRIVER_HINT[r.owner_key];
    const suggested = direct || (hint ? usable(hint.driver) : null);
    return {
      id: r.id, fiscal_owner: r.fiscal_owner, owner_key: r.owner_key,
      brand_model: r.brand_model, prefix: r.prefix, fiscal_class: r.fiscal_class,
      evidence_kind: r.evidence_kind, note: r.note,
      driver: suggested,
      driver_exact: !!direct,
      driver_basis: direct ? null : (hint ? hint.basis : null),
    };
  });
}

async function listDevices(clientId) {
  const devices = await db.query(
    `SELECT d.*, r.name AS register_name FROM fiscal_devices d
       LEFT JOIN cash_registers r ON r.id=d.cash_register_id AND r.client_id=d.client_id
      WHERE d.client_id=? ORDER BY d.id`, [clientId]);
  for (const d of devices) {
    const p = providerByKey(d.provider);
    d.provider_label = p ? p.label : d.provider;
    d.provider_status = p ? p.status : 'unknown';
    d.provider_status_label = p ? STATUS_LABEL[p.status] : 'Bilinmiyor';
    d.provider_note = p ? p.note : 'Bu sağlayıcı tanınmıyor.';
  }
  return devices;
}

/**
 * Save a device, and never let the save imply more than is true. A device on an
 * unfinished adapter is stored - you may well be developing against it - but
 * the answer carries a warning the screen has to show, and 'production' is
 * refused outright.
 */
async function saveDevice(clientId, data) {
  /*
   * If the dialog sent a register record, that record is the authority: it
   * decides the fiscal owner and the expected serial prefix. A Worldline
   * serial saved as a PAVO device is two different legal entities sharing one
   * row, and nothing downstream can untangle it afterwards.
   */
  let registryRec = null;
  if (data.registry_device_id) {
    const kayit = require('../fiscal/kayit');
    registryRec = await kayit.byId(data.registry_device_id);
    if (!registryRec) throw bad('Seçilen GİB kaydı bulunamadı.');
    if (registryRec.rollout_blocked) {
      throw bad(`${registryRec.brand_model} akaryakıt alanına ait; bu üründe kullanılamaz.`);
    }
    const ser = String(data.serial_number || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (ser && !ser.startsWith(registryRec.prefix)) {
      throw bad(`Seçilen cihazın mali prefixi ${registryRec.prefix}, girilen seri ${ser} ile başlıyor. `
        + 'Seri numarasını veya cihaz seçimini düzeltin.');
    }
    if (!data.provider) data.provider = registryRec.owner_key;
    if (!data.device_model) data.device_model = registryRec.brand_model;
  }

  const prov = providerByKey(data.provider);
  if (!prov) throw bad('Bilinmeyen ÖKC sağlayıcısı: ' + data.provider);
  if (prov.status === 'planned') {
    throw bad(`${prov.label} entegrasyonu henüz yazılmadı, cihaz eklenemez.`);
  }
  const env = String(data.environment || 'simulator').toLowerCase();
  if (!['production', 'test', 'simulator'].includes(env)) throw bad('Geçersiz ortam: ' + env);
  if (env === 'production' && !(prov.status === 'ready' || prov.status === 'beta')) {
    throw bad(`${prov.label} entegrasyonu tamamlanmadığı için "Gerçek" ortam seçilemez. Test ortamını kullanın.`);
  }
  if (prov.key === 'simulator' && env === 'production') {
    throw bad('Simülatör gerçek ortamda kullanılamaz; hiçbir mali fiş kesmez.');
  }
  if (prov.fields.includes('device_ip') && !String(data.device_ip || '').trim()) {
    throw bad(`${prov.label} için cihaz IP adresi zorunlu.`);
  }
  const serial = String(data.serial_number || '').trim();
  if (serial) {
    const dupe = await db.one('SELECT id FROM fiscal_devices WHERE client_id=? AND serial_number=? AND id<>?',
      [clientId, serial, data.id || 0]);
    if (dupe) throw bad('Bu seri numarası zaten kayıtlı');
  }

  const id = await fiscal.saveDevice(clientId, {
    ...data,
    registry_device_id: registryRec ? registryRec.id : (data.registry_device_id || null),
    fiscal_prefix: registryRec ? registryRec.prefix : null,
    provider: prov.key,
    environment: env,
    serial_number: serial,
    device_port: data.device_port ? Number(data.device_port) : prov.defaultPort || null,
    connection_type: data.connection_type || 'tcp',
  });

  const warnings = [];
  if (prov.status === 'sdk') {
    warnings.push(`${prov.label} sürücüsü gerçek cihazda denenmedi. Üreticinin entegrasyon dokümanı olmadan ` +
      'mali fiş kesileceğinin garantisi yoktur - satışa açmadan önce bir test cihazında doğrulayın.');
  }
  if (prov.status === 'beta') {
    warnings.push(`${prov.label} sürücüsü yazıldı ancak alan adları doğrulanmadı. ` +
      'İlk gerçek satıştan önce tek bir düşük tutarlı işlemle deneyin.');
  }
  if (prov.key === 'simulator') {
    warnings.push('Simülatör mali fiş kesmez ve GİB\'e hiçbir şey bildirmez. Yalnızca eğitim ve deneme içindir.');
  }
  if (!registryRec && prov.key !== 'simulator') {
    warnings.push('Cihaz GİB kayıt listesinden seçilmedi. Ayarlar › ÖKC kayıt defteri ekranından '
      + 'gerçek modeli seçerseniz mali seri prefixi de doğrulanır.');
  }
  if (registryRec && registryRec.evidence_kind === 'pdf_only') {
    warnings.push(`${registryRec.brand_model} canlı GİB listesinde görünmüyor, yalnızca resmî PDF'te var. `
      + 'Devreye almadan önce kaydı teyit edin.');
  }
  return { id, warnings, provider: { ...prov, status_label: STATUS_LABEL[prov.status] } };
}

async function setDeviceActive(clientId, deviceId, active) {
  const n = await db.exec('UPDATE fiscal_devices SET is_active=?, updated_at=NOW() WHERE id=? AND client_id=?',
    [active ? 1 : 0, deviceId, clientId]);
  if (!n) throw bad('Cihaz bulunamadı', 404);
  return true;
}

async function deleteDevice(clientId, deviceId) {
  const used = await db.value('SELECT COUNT(*) FROM fiscal_transactions WHERE client_id=? AND fiscal_device_id=?',
    [clientId, deviceId]).catch(() => 0);
  if (Number(used) > 0) {
    await setDeviceActive(clientId, deviceId, false);
    return { deleted: false, message: `Bu cihazla ${used} mali işlem yapılmış. Silinmedi, devre dışı bırakıldı.` };
  }
  await db.exec('DELETE FROM fiscal_devices WHERE id=? AND client_id=?', [deviceId, clientId]);
  return { deleted: true, message: 'Cihaz silindi.' };
}

/** Test a device connection, honestly - a stub adapter says it is a stub. */
async function testDevice(clientId, deviceId) {
  const d = await db.one('SELECT * FROM fiscal_devices WHERE id=? AND client_id=?', [deviceId, clientId]);
  if (!d) throw bad('Cihaz bulunamadı', 404);
  const prov = providerByKey(d.provider);
  try {
    const r = await fiscal.testDevice(clientId, deviceId);
    return {
      connected: true,
      state: r.status && r.status.state,
      device: r.connect && r.connect.device,
      provider_status: prov ? prov.status : 'unknown',
      message: prov && prov.status === 'ready'
        ? 'Cihaz yanıt verdi.'
        : `Cihaz yanıt verdi, ancak ${prov ? prov.label : d.provider} sürücüsü doğrulanmadı ` +
          '(bağlantı çalışıyor, mali fiş akışı garanti değil).',
    };
  } catch (e) {
    return { connected: false, state: 'error', provider_status: prov ? prov.status : 'unknown',
      message: e.message };
  }
}

/** One-click simulator so card payment works on a fresh installation. */
async function quickSimulator(clientId) {
  const existing = await db.one("SELECT id FROM fiscal_devices WHERE client_id=? AND provider='simulator'", [clientId]);
  let id = existing ? existing.id : null;
  if (!id) {
    id = await fiscal.saveDevice(clientId, {
      provider: 'simulator', device_model: 'NOKTApp Sanal ÖKC',
      serial_number: 'SIM-' + Date.now().toString().slice(-6),
      connection_type: 'internal', environment: 'simulator',
    });
  }
  await db.setSetting('fiscal_enabled', '1');
  return { id, message: 'Simülatör hazır. ÖKC ile ödeme açıldı - bu cihaz mali fiş kesmez.' };
}

/* ------------------------- cash registers -------------------------- */
async function listRegisters(clientId) {
  return db.query(
    `SELECT r.*,
            (SELECT COUNT(*) FROM fiscal_devices d WHERE d.client_id=r.client_id AND d.cash_register_id=r.id) AS device_count
       FROM cash_registers r WHERE r.client_id=? ORDER BY r.id`, [clientId]);
}

async function saveRegister(clientId, data) {
  const name = String(data.name || '').trim();
  const code = String(data.code || '').trim().toUpperCase();
  if (!name) throw bad('Kasa adı zorunlu');
  if (!/^[A-Z0-9_-]{1,32}$/.test(code)) throw bad('Kasa kodu yalnızca harf, rakam, - ve _ içerebilir');
  const dupe = await db.one('SELECT id FROM cash_registers WHERE client_id=? AND code=? AND id<>?',
    [clientId, code, data.id || 0]);
  if (dupe) throw bad('Bu kasa kodu zaten kullanılıyor');
  if (data.id) {
    await db.exec('UPDATE cash_registers SET name=?, code=?, is_active=?, updated_at=NOW() WHERE id=? AND client_id=?',
      [name, code, data.is_active === false ? 0 : 1, data.id, clientId]);
    return data.id;
  }
  return db.insert('INSERT INTO cash_registers (client_id, branch_id, name, code, is_active, created_at) VALUES (?,1,?,?,1,NOW())',
    [clientId, name, code]);
}

/* ==================================================================== *
 * 5. BUSINESS DETAILS, RECEIPT TEXT, WORKING HOURS                     *
 * ==================================================================== */

async function business(clientId) {
  const client = await db.one(
    `SELECT id, owner_name, company_name, full_address, permanent_email, phone, tax_number, tax_office,
            contact_name, contact_email, contact_phone, receipt_header, receipt_footer, receipt_station_id
       FROM clients WHERE id=?`, [clientId]);
  const biz = await db.one('SELECT * FROM business_settings WHERE client_id=? LIMIT 1', [clientId]);
  const stations = await db.query(
    'SELECT id, name, display_name FROM stations WHERE client_id=? AND is_active=1 ORDER BY sort_order, id', [clientId]);
  const hours = {};
  for (const d of DEFS.filter(x => x.group === 'calisma')) hours[d.key] = await db.getSetting(d.key, d.default);
  return {
    client: client || {},
    business: biz || {},
    stations,
    hours,
    days: DAYS,
    /* the fields the tenant may not edit locally - they are the ones on the
       licence and the invoice, and the panel owns them */
    locked: ['owner_name', 'tax_number', 'tax_office'],
    currency: {
      code: await db.getSetting('currency', 'TRY'),
      symbol: await db.getSetting('currency_symbol', '₺'),
      position: await db.getSetting('currency_position', 'after'),
      decimals: Number(await db.getSetting('decimal_places', 2)),
    },
    business_day_start: await db.getSetting('business_day_start', '06:00'),
  };
}

/**
 * Save the company block.
 *
 * owner_name / tax_number / tax_office are NOT written even if the browser
 * sends them: they come from the signed licence and letting the till edit them
 * would put a different VKN on the receipt from the one the tenant is
 * registered under. The PHP locked them in the markup only - a POST changed
 * them happily.
 */
async function saveBusiness(clientId, data, actorId) {
  const c = data.client || {};
  const b = data.business || {};
  const name = String(b.business_name || c.company_name || '').trim();
  if (!name) throw bad('İşletme adı zorunlu');
  if (c.permanent_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(c.permanent_email).trim())) {
    throw bad('Kalıcı e-posta adresi geçersiz');
  }
  if (c.contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(c.contact_email).trim())) {
    throw bad('İletişim e-postası geçersiz');
  }
  const width = Number(await db.getSetting('receipt_width', 48));
  for (const [field, label] of [['receipt_header', 'Fiş başlığı'], ['receipt_footer', 'Fiş altı yazısı']]) {
    const v = String(c[field] || '');
    if (v.length > 240) throw bad(`${label} en fazla 240 karakter olabilir`);
    for (const line of v.split('\n')) {
      if (line.length > width) {
        throw bad(`${label}: "${line.slice(0, 20)}…" satırı ${width} karakterlik fişe sığmıyor (${line.length} karakter)`);
      }
    }
  }
  if (c.receipt_station_id) {
    const st = await db.one('SELECT id FROM stations WHERE id=? AND client_id=?', [c.receipt_station_id, clientId]);
    if (!st) throw bad('Seçilen fiş istasyonu bulunamadı');
  }

  await db.exec(
    `UPDATE clients SET company_name=?, full_address=?, permanent_email=?, phone=?,
        contact_name=?, contact_email=?, contact_phone=?,
        receipt_header=?, receipt_footer=?, receipt_station_id=? WHERE id=?`,
    [name, c.full_address || null, String(c.permanent_email || '').trim(), String(c.phone || '').trim(),
     String(c.contact_name || '').trim(), String(c.contact_email || '').trim(), String(c.contact_phone || '').trim(),
     c.receipt_header || null, c.receipt_footer || null, Number(c.receipt_station_id) || 0, clientId]);

  const exists = await db.one('SELECT id FROM business_settings WHERE client_id=?', [clientId]);
  const vals = [name, b.legal_name || null, b.tax_number || null, b.tax_office || null,
    b.address_line1 || c.full_address || null, b.city || null, String(b.phone || c.phone || '').trim() || null,
    b.email || null, b.website || null, b.instagram || null];
  if (exists) {
    await db.exec(
      `UPDATE business_settings SET business_name=?, legal_name=?, tax_number=?, tax_office=?, address_line1=?,
          city=?, phone=?, email=?, website=?, instagram=?, updated_at=NOW() WHERE client_id=?`,
      [...vals, clientId]);
  } else {
    await db.exec(
      `INSERT INTO business_settings (client_id, business_name, legal_name, tax_number, tax_office, address_line1,
          city, phone, email, website, instagram, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`, [clientId, ...vals]);
  }

  // working hours and the business-day roll ride along on the same form
  const patch = {};
  for (const k of Object.keys(data.hours || {})) if (BY_KEY[k]) patch[k] = data.hours[k];
  if (data.business_day_start !== undefined) patch.business_day_start = data.business_day_start;
  if (data.currency) {
    for (const k of ['currency', 'currency_symbol', 'currency_position', 'decimal_places']) {
      if (data.currency[k] !== undefined) patch[k] = data.currency[k];
    }
  }
  if (Object.keys(patch).length) await save(clientId, patch, actorId);
  return true;
}

/* ==================================================================== *
 * 6. CURRENCIES (döviz)                                                *
 * ==================================================================== */

const SEED_CURRENCIES = [
  ['EUR', 'Euro', '€', 1], ['USD', 'Amerikan Doları', '$', 2], ['GBP', 'İngiliz Sterlini', '£', 3],
];

async function currencies(clientId) {
  let rows = await db.query('SELECT * FROM doviz_kurlari WHERE client_id=? ORDER BY sort_order, code', [clientId]);
  if (!rows.length) {
    for (const [code, name, symbol, sort] of SEED_CURRENCIES) {
      await db.exec(
        'INSERT IGNORE INTO doviz_kurlari (client_id, code, name, symbol, rate, is_active, sort_order, created_at) VALUES (?,?,?,?,0,1,?,NOW())',
        [clientId, code, name, symbol, sort]);
    }
    rows = await db.query('SELECT * FROM doviz_kurlari WHERE client_id=? ORDER BY sort_order, code', [clientId]);
  }
  const now = Date.now();
  for (const r of rows) {
    r.rate = Number(r.rate);
    r.missing = !r.rate_updated_at || r.rate <= 0;
    // a rate entered yesterday is not today's rate; the old screen showed it
    // with no hint of its age and cashiers quoted it all day
    r.stale = !r.missing && (now - new Date(r.rate_updated_at).getTime()) > 24 * 3600 * 1000;
    r.example = r.rate > 0 ? Math.round((1000 / r.rate) * 100) / 100 : null;
  }
  return rows;
}

async function saveRate(clientId, id, rate, actorId, confirm = false) {
  const cur = await db.one('SELECT * FROM doviz_kurlari WHERE id=? AND client_id=?', [id, clientId]);
  if (!cur) throw bad('Para birimi bulunamadı', 404);
  const n = Number(String(rate).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) throw bad('Kur sıfırdan büyük bir sayı olmalı');
  if (n > 100000) throw bad('Kur çok büyük görünüyor, kontrol edin');
  const old = Number(cur.rate);
  /* A fat-fingered rate (4.35 typed as 43.5) prints a wrong foreign total on
     every receipt until somebody notices, so a big jump asks a second time. */
  if (old > 0 && Math.abs(n - old) / old > 0.5 && !confirm) {
    const e = bad(`Kur ${old} değerinden ${n} değerine değişiyor (%${Math.round(Math.abs(n - old) / old * 100)}). ` +
      'Emin misiniz?');
    e.status = 409;
    e.needsConfirm = true;
    throw e;
  }
  await db.tx(async t => {
    await t.exec('UPDATE doviz_kurlari SET rate=?, rate_updated_at=NOW(), updated_by=? WHERE id=? AND client_id=?',
      [n, actorId || null, id, clientId]);
    await t.exec('INSERT INTO doviz_kur_gecmisi (client_id, doviz_id, old_rate, new_rate, changed_by, created_at) VALUES (?,?,?,?,?,NOW())',
      [clientId, id, old || null, n, actorId || null]);
  });
  return { code: cur.code, rate: n };
}

async function setCurrencyActive(clientId, id, active) {
  const n = await db.exec('UPDATE doviz_kurlari SET is_active=? WHERE id=? AND client_id=?',
    [active ? 1 : 0, id, clientId]);
  if (!n) throw bad('Para birimi bulunamadı', 404);
  return true;
}

async function rateHistory(clientId, limit = 20) {
  return db.query(
    `SELECT h.id, h.old_rate, h.new_rate, h.created_at, d.code, u.display_name AS changed_by_name
       FROM doviz_kur_gecmisi h
       JOIN doviz_kurlari d ON d.id=h.doviz_id
       LEFT JOIN users u ON u.id=h.changed_by
      WHERE h.client_id=? ORDER BY h.id DESC LIMIT ?`, [clientId, Number(limit) || 20]);
}

/* ==================================================================== *
 * 7. TENANT SAFETY SELF-CHECK                                          *
 * ==================================================================== */

/**
 * The old tenant_check.php asked: is any of my data leaking into, or out of,
 * another restaurant's? On a single-tenant till the answer should be trivially
 * yes, which is exactly why it is worth checking - an unscoped row is a bug
 * that only shows up when the file is restored onto a machine with a different
 * client_id.
 */
const SCOPED_TABLES = ['orders', 'order_items', 'products', 'categories', 'users', 'printers',
  'stations', 'print_jobs', 'fiscal_devices', 'restaurant_tables', 'table_zones'];

async function hasClientId(table) {
  const n = await db.value(
    `SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name=? AND column_name='client_id'`, [table]);
  return Number(n) > 0;
}

async function selfCheck(clientId) {
  const checks = [];
  const add = (table, level, message, extra = {}) =>
    checks.push({ table, level, ok: level !== 'error', message, ...extra });

  for (const t of SCOPED_TABLES) {
    try {
      if (!await hasClientId(t)) { add(t, 'skip', 'Bu tabloda işletme kimliği sütunu yok'); continue; }
      const orphan = Number(await db.value(`SELECT COUNT(*) FROM \`${t}\` WHERE client_id IS NULL OR client_id=0`));
      const foreign = Number(await db.value(`SELECT COUNT(*) FROM \`${t}\` WHERE client_id<>0 AND client_id<>?`, [clientId]));
      /*
       * An unscoped row (client_id NULL or 0) is always a bug: it belongs to
       * nobody, so every tenant sees it. Rows belonging to ANOTHER client_id
       * are only a note - a service machine and this build's own database do
       * legitimately hold more than one restaurant - but the owner should know
       * they are there before restoring a backup onto this till.
       */
      if (orphan) add(t, 'error', `${orphan} satırda işletme kimliği yok (her işletme bu satırları görür)`, { orphan, foreign });
      else if (foreign) add(t, 'note', `${foreign} satır başka bir işletmeye ait; sizin verinize karışmıyor`, { orphan, foreign });
      else add(t, 'ok', 'Temiz', { orphan: 0, foreign: 0 });
    } catch (e) {
      add(t, 'error', 'Kontrol edilemedi: ' + e.message);
    }
  }

  // print jobs must only ever target this tenant's own stations
  const strayJobs = Number(await db.value(
    `SELECT COUNT(*) FROM print_jobs j WHERE j.client_id=? AND j.station_id IS NOT NULL AND j.station_id<>0
       AND NOT EXISTS (SELECT 1 FROM stations s WHERE s.id=j.station_id AND s.client_id=j.client_id)`, [clientId]));
  add('print_jobs → stations', strayJobs ? 'error' : 'ok',
    strayJobs ? `${strayJobs} yazdırma işi tanınmayan bir istasyona gidiyor` : 'Temiz', { orphan: strayJobs });

  const licenceClient = await db.value('SELECT client_id FROM np_licence WHERE id=1').catch(() => null);
  if (!licenceClient) add('lisans kimliği', 'note', 'Lisans kaydı yok (kurulum tamamlanmamış olabilir)');
  else if (Number(licenceClient) === Number(clientId)) add('lisans kimliği', 'ok', 'Oturum ve lisans aynı işletmeyi gösteriyor');
  else add('lisans kimliği', 'note', `Lisans ${licenceClient}, oturum ${clientId} diyor - bu makinede birden fazla işletme kaydı var`);

  return {
    client_id: clientId,
    checks,
    errors: checks.filter(c => c.level === 'error').length,
    notes: checks.filter(c => c.level === 'note').length,
    all_clean: checks.every(c => c.level !== 'error'),
  };
}

module.exports = {
  registryCatalogue,
  // catalogue
  GROUPS, DEFS, BY_KEY, PROTECTED, coerce, catalogue, all, save, history,
  // users
  PERM_LABELS, PERM_GROUPS, ROLE_LABELS, listUsers, saveUser, setUserActive, setUserRole,
  setUserPerms, resetPin, unlockUser, deleteUser, permissionCatalogue, activeAdmins,
  myProfile, updateMyProfile, changeMyPassword, changeMyPin,
  // stations & printers
  OUTPUT_MODES, OUTPUT_MODE_LABELS, BOARD_SILENT_MIN,
  listStations, stationOverview, stationUsage, saveStation, deleteStation, setStationActive,
  reorderStations, setDefaultStation, assignCategories, categoriesWithStation,
  listPrinters, savePrinter, deletePrinter, testPrinter, PRINTER_TYPES,
  printQueue, retryJob, retryFailed, cancelJob,
  // okc
  PROVIDERS, STATUS_LABEL, providerCatalogue, providerByKey, listDevices, saveDevice,
  setDeviceActive, deleteDevice, testDevice, quickSimulator, listRegisters, saveRegister,
  // business & currency
  business, saveBusiness, currencies, saveRate, setCurrencyActive, rateHistory,
  // safety
  selfCheck,
};
