'use strict';
/**
 * FİŞ, YAZICI VE MÜŞTERİ EKRANI
 *
 * Three areas the owner said did not exist:
 *
 *   1. Fiş ayarları  - what is PRINTED on the 80 mm thermal slip: the header
 *      lines, the footer lines, which business details appear, the KDV
 *      breakdown, the waiter, the table, the thank-you line. With a preview
 *      that is rendered at the true paper width, because "48 characters" means
 *      nothing to anybody and a wrapped line is only discovered on paper.
 *   2. Yazıcı ayarları - the printers screen already existed (the old Yönetim →
 *      Yazıcılar) and is NOT duplicated here. What was missing is the paper
 *      width, the explicit "this one is the kasa printer", and a queue you can
 *      retry from the same screen you set the paper on. Those are added; the
 *      add/edit/delete/test rules are reused from modules/settings so there is
 *      exactly one implementation of "is this a valid printer".
 *   3. Müşteri ekranı - the welcome text, plus a small QR and a small image
 *      INSIDE the layout public/display.html already has. Not a redesign: two
 *      optional blocks in the template that is already there.
 *
 * WHERE THE VALUES LIVE
 *
 * The receipt TEXT is on `clients`: receipt_header and receipt_footer are what
 * print/document.js already reads, and inventing a second copy in np_settings
 * would mean the bill and this screen could disagree. Everything else is a row
 * in np_settings with a typed definition below, in the same shape as
 * modules/settings.DEFS - and the keys that ALREADY exist there (receipt_width,
 * receipt_copies, receipt_show_vat, receipt_show_waiter, receipt_qr,
 * receipt_show_fx, receipt_auto_print) are borrowed rather than redefined: this
 * screen renders them, and saving them goes back through settings.save() so the
 * validation and the change log stay in one place. Two of the borrowed keys -
 * receipt_qr and receipt_show_fx - are written but NOT drawn; see DERIVED_KEYS
 * for why one fact may not have two controls.
 *
 * The preview is DECODED from the bytes the printer will be sent
 * (print/escpos.decode), not built by a second renderer. A preview that is
 * written twice is a preview that will eventually lie.
 *
 * DÖVİZ AND KAREKOD
 *
 * Two things the owner said were missing from the printed and e-mailed bill: a
 * foreign-currency line, and a QR. Both are CHOSEN here and RESOLVED in
 * print/document.js, which is the one place the bill is built - so the thermal
 * slip, the PDF and the e-mail body carry the same conversion off the same
 * rate and the same QR pointing at the same address. Neither may move a
 * number: the döviz line is a courtesy for a tourist table and the TL total
 * above it remains the figure that is owed.
 *
 * The rates are NOT stored here. They are doviz_kurlari, which the Ayarlar →
 * Döviz screen already owns, complete with a confirmation on a suspicious jump
 * and a doviz_kur_gecmisi row for every change. A second rate store would mean
 * the bill and that screen could show different euros.
 */
const db = require('../db');
const log = require('../logger');
const settings = require('./settings');
const { decode } = require('../print/escpos');

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/* ==================================================================== *
 * 1. THE CATALOGUE                                                     *
 * ==================================================================== */

const GROUPS = [
  { id: 'metin', label: 'Fiş metni',
    help: 'Fişin en üstünde ve en altında yazan satırlar. Sağdaki önizleme gerçek kağıt genişliğindedir.' },
  { id: 'icerik', label: 'Fişte görünenler',
    help: 'Hangi bilginin fişe basılacağı. Kapattığınız satır kağıda hiç çıkmaz.' },
  { id: 'kagit', label: 'Kağıt ve baskı',
    help: 'Kağıt genişliği ve kopya sayısı.' },
  { id: 'doviz', label: 'Döviz karşılığı',
    help: 'Toplamın altına yabancı para karşılığı. Sadece bilgi içindir: kasa TL tahsil eder, ' +
          'fişteki TL tutarı geçerli olandır. Kurlar Para → Döviz kurları ekranından girilir.' },
  { id: 'karekod', label: 'Karekod (QR)',
    help: 'Fişin altına basılan karekod ve altındaki yazı.' },
];

/** Our own keys. Same shape as modules/settings.DEFS, validated with its coerce(). */
const DEFS = [
  /* ------------------------------- metin ------------------------------- */
  { key: 'receipt_title', group: 'metin', label: 'Fiş başlığı', type: 'text', default: 'HESAP FISI', max: 40,
    help: 'Ürünlerin üstünde yazan başlık. Mali fiş değildir, bunu ÖKC keser.' },
  { key: 'receipt_thanks', group: 'metin', label: 'Teşekkür satırı', type: 'text', default: '', max: 120,
    help: 'Fişin en altına ortalanmış olarak basılır. Boş bırakırsanız basılmaz.' },
  { key: 'receipt_show_thanks', group: 'metin', label: 'Teşekkür satırını yazdır', type: 'bool', default: '1' },

  /* ------------------------------ içerik ------------------------------- */
  { key: 'receipt_show_business_name', group: 'icerik', label: 'İşletme adını yazdır', type: 'bool', default: '1',
    help: 'Kapatırsanız yalnızca fiş başlığı kalır - antetli kağıt kullananlar için.' },
  { key: 'receipt_show_address', group: 'icerik', label: 'Adresi yazdır', type: 'bool', default: '1' },
  { key: 'receipt_show_phone', group: 'icerik', label: 'Telefonu yazdır', type: 'bool', default: '1' },
  { key: 'receipt_show_tax', group: 'icerik', label: 'Vergi dairesi ve numarasını yazdır', type: 'bool', default: '1' },
  { key: 'receipt_show_table', group: 'icerik', label: 'Masa adını yazdır', type: 'bool', default: '1' },
  { key: 'receipt_show_datetime', group: 'icerik', label: 'Tarih ve saati yazdır', type: 'bool', default: '1' },
  { key: 'receipt_show_brand', group: 'icerik', label: 'Alta "NOKTApp POS" yaz', type: 'bool', default: '1',
    help: 'Kapatırsanız fişin altında yalnızca sizin yazınız kalır.' },

  /* ------------------------------- kağıt ------------------------------- */
  { key: 'receipt_paper', group: 'kagit', label: 'Kağıt genişliği', type: 'select', default: '80',
    options: [['80', '80 mm - 48 karakter'], ['58', '58 mm - 32 karakter']],
    help: 'Yazıcınızdaki rulonun genişliği. Kaydedince karakter sayısı da buna göre ayarlanır.' },

  /* ------------------------------- döviz ------------------------------- */
  /*
   * Which currencies, not "döviz on/off": a tourist restaurant in Alanya shows
   * EUR, one on the border shows nothing but USD, and one that has typed no
   * rate at all must show neither. The list IS the switch - an empty list
   * prints nothing - and receipt_show_fx is kept in step with it in save() so
   * the older Ayarlar → Fiş checkbox cannot say something different.
   */
  { key: 'receipt_fx_currencies', group: 'doviz', label: 'Fişe eklenecek para birimleri',
    type: 'multi', default: '', max: 60,
    help: 'Hiçbirini seçmezseniz fişe döviz satırı basılmaz. Yalnızca Döviz ekranında kuru girilmiş ' +
          've açık olan para birimleri basılabilir.' },
  { key: 'receipt_fx_source', group: 'doviz', label: 'Kur nereden geliyor', type: 'select', default: 'elle',
    options: [['elle', 'Döviz ekranında elle girilen kur']],
    help: 'Şu an tek kaynak budur: Ayarlar → Döviz ekranına yazdığınız kur. Otomatik (TCMB) kur çekme ' +
          'panel tarafında yapılacak iş; bağlandığında bu listeye eklenecek.' },
  { key: 'receipt_fx_max_age_hours', group: 'doviz', label: 'Kur kaç saat sonra "eski" sayılsın',
    type: 'number', default: 24, min: 1, max: 720,
    help: 'Bu süreden eski bir kur yine basılır ama yanında girildiği tarih yazar, böylece misafir ' +
          'kurun bugünün kuru olmadığını görür.' },

  /* ------------------------------ karekod ------------------------------ */
  { key: 'receipt_qr_mode', group: 'karekod', label: 'Karekod ne göstersin', type: 'select', default: 'kapali',
    options: [
      ['kapali', 'Karekod basılmasın'],
      ['menu', 'Dijital menü adresi'],
      ['sadakat', 'Sadakat kayıt adresi'],
      ['serbest', 'Serbest adres / yazı'],
    ],
    help: 'Dijital menü seçeneği QR menü ayarlarındaki adresi kullanır - masa kartlarıyla aynı adres. ' +
          'Adresi olmayan bir seçenekte karekod hiç basılmaz; boş bir kare basmaktansa hiç basmamak doğrudur.' },
  { key: 'receipt_qr_loyalty_url', group: 'karekod', label: 'Sadakat kayıt adresi', type: 'url', default: '', max: 200,
    help: 'Sadakat kaydı için misafiri gönderdiğiniz adres. Panelde hazır bir kayıt sayfası henüz yok, ' +
          'bu yüzden adresi siz giriyorsunuz (kendi formunuz, Instagram, WhatsApp).' },
  { key: 'receipt_qr_text', group: 'karekod', label: 'Serbest karekod içeriği', type: 'text', default: '', max: 200,
    help: 'Fişin altına basılacak karekodun içi: internet adresi, wifi şifresi ya da düz yazı.' },
  { key: 'receipt_qr_caption', group: 'karekod', label: 'Karekod altı yazısı', type: 'text', default: '', max: 60 },
];

/**
 * Keys this screen shows but modules/settings owns. They are read from the same
 * catalogue so the label, the help text and the limits cannot drift, and they
 * are written back through settings.save() so the audit log still sees them.
 */
const BORROWED = {
  icerik: ['receipt_show_vat', 'receipt_show_waiter'],
  kagit: ['receipt_copies', 'receipt_auto_print', 'receipt_width'],
  doviz: ['receipt_show_fx'],
  karekod: ['receipt_qr'],
};
const BORROWED_KEYS = [].concat(...Object.values(BORROWED));

/**
 * Borrowed keys this screen WRITES but does not draw a control for.
 *
 * receipt_show_fx and receipt_qr are older on/off switches that still live on
 * Ayarlar → Fiş and are still read by print/document.js. Drawing them here as
 * well would put two controls on one fact - tick "Döviz karşılığını yazdır"
 * but choose no currency and the screen would be arguing with itself about
 * what the paper does. So the list and the mode are the controls, and save()
 * keeps the two old booleans in step with them, exactly the way receipt_paper
 * carries receipt_width.
 *
 * They stay in BORROWED_KEYS because this module writes them: anything that
 * captures "the keys this screen touches" has to see them.
 */
const DERIVED_KEYS = ['receipt_show_fx', 'receipt_qr'];

const BY_KEY = {};
for (const d of DEFS) BY_KEY[d.key] = d;

/** 80 mm is 48 characters at font A, 58 mm is 32. Nothing else is guessed. */
function charsForPaper(mm) { return Number(mm) === 58 ? 32 : 48; }
function paperForChars(chars) { return Number(chars) <= 40 ? 58 : 80; }

/** "EUR,USD" -> ['EUR','USD']. Order, case and stray spaces are not the caller's problem. */
function parseCodes(v) {
  return String(v === null || v === undefined ? '' : v)
    .split(/[,;\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
    .filter((c, i, a) => a.indexOf(c) === i);
}

/**
 * The QR mode, resolved once so the screen and the printer cannot disagree.
 *
 * receipt_qr_mode did not exist before this screen did, and a till that has
 * been printing a QR from the old receipt_qr + receipt_qr_text pair must keep
 * printing exactly that until somebody chooses otherwise. So: no stored mode
 * means the old pair decides, and the moment a mode IS stored it is the truth
 * and save() writes receipt_qr to match it.
 *
 * receipt_qr is still ANDed in below, so the old checkbox on Ayarlar → Fiş is
 * still an off switch for a till that has never opened this screen.
 */
async function resolveQrMode(override) {
  const o = override || {};
  const pick = async (k, def) => (o[k] !== undefined && o[k] !== null
    ? String(o[k]) : await db.getSetting(k, def));

  /*
   * An UNSAVED draft carries the mode on its own - receipt_qr is derived by
   * save() and the Fiş screen draws no control for it - so a draft mode is
   * taken at face value. ANDing it against the receipt_qr still sitting in the
   * database would make the live preview answer with the LAST SAVED state: the
   * owner picks "Dijital menü", the preview shows no karekod, and the one
   * screen whose job is to show what the paper will look like is lying to him.
   */
  if (o.receipt_qr_mode !== undefined && o.receipt_qr_mode !== null) {
    return String(o.receipt_qr_mode).trim() || 'kapali';
  }

  const stored = String((await db.getSetting('receipt_qr_mode', null)) || '').trim();
  const legacyOn = ['1', 'true', 'on'].includes(String((await pick('receipt_qr', '0')) || '').toLowerCase());
  if (!stored) {
    const legacyText = String((await pick('receipt_qr_text', '')) || '').trim();
    return legacyOn && legacyText ? 'serbest' : 'kapali';
  }
  return legacyOn ? stored : 'kapali';
}

/**
 * Is the döviz block on, and which currencies - resolved together for the same
 * reason resolveQrMode() is: the list is the control, receipt_show_fx is
 * derived from it by save(), and a draft that names currencies must preview as
 * "on" even though the boolean in the database still says otherwise.
 */
async function resolveFx(override) {
  const o = override || {};
  if (o.receipt_fx_currencies !== undefined && o.receipt_fx_currencies !== null) {
    const codes = parseCodes(o.receipt_fx_currencies);
    return { on: codes.length > 0, codes };
  }
  const codes = parseCodes(await db.getSetting('receipt_fx_currencies', ''));
  const raw = String((o.receipt_show_fx !== undefined && o.receipt_show_fx !== null
    ? o.receipt_show_fx : await db.getSetting('receipt_show_fx', '0')) || '').toLowerCase();
  return { on: ['1', 'true', 'on'].includes(raw), codes };
}

/**
 * Definitions in screen order: ours and the borrowed ones, in one list.
 *
 * `currencies` is the live doviz_kurlari rows: the para birimi list is not a
 * fixed EUR/USD/GBP - it is whatever the Döviz screen holds - and an option
 * for a currency that has no rate would be an option that prints nothing.
 */
function catalogue(currencies) {
  const fxOptions = (currencies || []).map(c => [
    c.code,
    `${c.code} - ${c.name}` +
      (c.missing ? ' (kur girilmemiş)' : c.stale ? ' (kur eski)' : '') +
      (Number(c.is_active) ? '' : ' (Döviz ekranında kapalı)'),
  ]);
  const out = [];
  for (const g of GROUPS) {
    const mine = DEFS.filter(d => d.group === g.id).map(d => ({
      ...d,
      owner: 'receipt',
      options: d.key === 'receipt_fx_currencies' ? fxOptions : (d.options || null),
    }));
    const borrowed = (BORROWED[g.id] || [])
      .filter(k => !DERIVED_KEYS.includes(k))
      .map(k => settings.BY_KEY[k])
      .filter(Boolean)
      .map(d => ({ ...d, group: g.id, owner: 'settings', options: d.options || null }));
    out.push({ ...g, defs: [...mine, ...borrowed] });
  }
  return { groups: out };
}

/* ==================================================================== *
 * 2. READING AND WRITING                                               *
 * ==================================================================== */

/** Every key with its current value, plus the two text blocks off `clients`. */
async function values(clientId) {
  const out = {};
  for (const d of DEFS) out[d.key] = String(await db.getSetting(d.key, d.default));
  for (const k of BORROWED_KEYS) {
    const d = settings.BY_KEY[k];
    if (d) out[k] = String(await db.getSetting(k, d.default));
  }
  const c = clientId ? await db.one('SELECT receipt_header, receipt_footer FROM clients WHERE id=?', [clientId]) : null;
  return {
    ...out,
    /* the screen must show the mode the PRINTER will use, not the raw row - an
       install still running on the old receipt_qr pair has no row at all */
    receipt_qr_mode: await resolveQrMode(null),
    receipt_header: (c && c.receipt_header) || '',
    receipt_footer: (c && c.receipt_footer) || '',
  };
}

/**
 * The whole screen in one call.
 *
 * `width` is the character count in force RIGHT NOW, resolved the same way the
 * print agent resolves it, so the number on the screen and the number on the
 * paper are the same number.
 */
async function get(clientId) {
  const v = await values(clientId);
  const rates = clientId ? await settings.currencies(clientId).catch(() => []) : [];
  return {
    ...catalogue(rates),
    values: v,
    width: await charWidth(),
    paper: Number(v.receipt_paper) || paperForChars(v.receipt_width),
    receipt_printer: await receiptPrinter(clientId),
    /* the rates themselves, so the screen can say where the number on the paper
       comes from and how old it is instead of just naming the source */
    currencies: rates.map(c => ({
      code: c.code, name: c.name, symbol: c.symbol,
      rate: Number(c.rate), rate_updated_at: c.rate_updated_at,
      is_active: Number(c.is_active) ? 1 : 0, missing: !!c.missing, stale: !!c.stale,
    })),
    fx_warnings: await fxWarnings(clientId, v, rates),
    qr_warning: await qrWarning(clientId, v),
  };
}

/**
 * What the owner has chosen but cannot get, said before he prints a service's
 * worth of bills and finds out.
 *
 * Every one of these is a silent nothing on the paper - the renderers refuse to
 * print a rate that does not exist or a QR that points nowhere - so the only
 * place the mistake can surface is here.
 */
async function fxWarnings(clientId, v, rates) {
  const codes = parseCodes(v.receipt_fx_currencies);
  if (!codes.length) return [];
  const out = [];
  for (const code of codes) {
    const r = (rates || []).find(x => x.code === code);
    if (!r) { out.push(`${code} Döviz ekranında tanımlı değil, fişe basılmaz.`); continue; }
    if (r.missing) out.push(`${code} seçili ama kuru hiç girilmemiş - fişe basılmaz. Para → Döviz kurları ekranından kuru yazın.`);
    else if (!Number(r.is_active)) out.push(`${code} seçili ama Döviz ekranında kapalı - fişe basılmaz.`);
    else if (r.stale) out.push(`${code} kuru ${r.rate_updated_at ? String(r.rate_updated_at).slice(0, 10) : '?'} tarihinden kalma. Fişe bu kurla basılır; güncelleyin.`);
  }
  return out;
}

/** The same, for a karekod mode whose address does not exist. */
async function qrWarning(clientId, v) {
  const mode = v.receipt_qr_mode;
  if (!mode || mode === 'kapali') return null;
  if (mode === 'serbest' && !String(v.receipt_qr_text || '').trim()) {
    return 'Karekod "serbest" seçili ama içerik boş - fişe karekod basılmaz.';
  }
  if (mode === 'sadakat' && !String(v.receipt_qr_loyalty_url || '').trim()) {
    return 'Karekod "sadakat" seçili ama kayıt adresi boş - fişe karekod basılmaz.';
  }
  if (mode === 'menu') {
    const s = clientId
      ? await db.one('SELECT slug, is_published FROM qr_menu_settings WHERE client_id=?', [clientId]).catch(() => null)
      : null;
    if (!s || !s.slug) return 'Karekod "dijital menü" seçili ama QR menü adresi (slug) tanımlı değil - fişe karekod basılmaz.';
    if (Number(s.is_published) !== 1) return 'QR menü henüz yayınlanmamış. Karekod basılır ama okutulduğunda menü görünmez.';
  }
  return null;
}

/**
 * A header or footer line that is wider than the paper does not print wider -
 * it wraps, and the guest gets a bill whose top line is broken in half. It is
 * refused here for the same reason modules/settings refuses it on the İşletme
 * tab, with the same message.
 */
function checkBlock(text, label, width) {
  const v = String(text || '');
  if (v.length > 240) throw bad(`${label} en fazla 240 karakter olabilir`);
  for (const line of v.split('\n')) {
    if (line.length > width) {
      throw bad(`${label}: "${line.slice(0, 20)}…" satırı ${width} karakterlik fişe sığmıyor (${line.length} karakter)`);
    }
  }
  return v.trim() ? v : null;
}

/**
 * The chosen currencies, checked against the ones that actually exist.
 *
 * A code that is not in doviz_kurlari is refused rather than stored and
 * silently ignored: "I ticked EUR and nothing prints" is a support call, and
 * the only moment we can tell the owner why is while he is on the screen. A
 * currency that exists but has no rate yet is ALLOWED through - it is a
 * legitimate "I will type the rate in a minute" - and comes back as a warning
 * from get() instead of an error here.
 */
async function checkCurrencies(clientId, raw) {
  const codes = parseCodes(raw);
  if (!codes.length) return [];
  if (codes.length > 6) throw bad('En fazla 6 para birimi seçebilirsiniz - fiş kağıdı buna yeter.');
  const rows = clientId
    ? await db.query('SELECT code FROM doviz_kurlari WHERE client_id=?', [clientId]).catch(() => [])
    : [];
  const known = rows.map(r => r.code);
  for (const c of codes) {
    if (!/^[A-Z]{3}$/.test(c)) throw bad(`Geçersiz para birimi kodu: "${c}"`);
    if (known.length && !known.includes(c)) {
      throw bad(`${c} Döviz ekranında tanımlı değil. Önce Para → Döviz kurları ekranından ekleyin.`);
    }
  }
  return codes;
}

/**
 * Save a patch.
 *
 * Everything is validated before anything is written, so one bad field does not
 * leave the receipt half-configured. Keys split three ways: the text blocks go
 * to `clients`, the borrowed keys go through settings.save(), ours are coerced
 * with the same validator and written here.
 */
async function save(clientId, patch, actorId) {
  const p = patch || {};
  const mine = [];
  const shared = {};

  /* the paper is the owner-facing control; receipt_width is what the printer
     code reads, so the two are set together and can never disagree */
  if (p.receipt_paper !== undefined) {
    const def = BY_KEY.receipt_paper;
    const paper = settings.coerce(def, p.receipt_paper);
    mine.push(['receipt_paper', paper]);
    shared.receipt_width = String(charsForPaper(paper));
  }

  /*
   * The döviz list and the karekod mode each carry an older on/off switch with
   * them, the way receipt_paper carries receipt_width. Choosing no currency IS
   * "do not print döviz", and receipt_show_fx has to say the same thing or the
   * Ayarlar screen will show a tick for a line that never prints.
   */
  if (p.receipt_fx_currencies !== undefined) {
    const codes = await checkCurrencies(clientId, p.receipt_fx_currencies);
    mine.push(['receipt_fx_currencies', codes.join(',')]);
    shared.receipt_show_fx = codes.length ? '1' : '0';
  }
  if (p.receipt_qr_mode !== undefined) {
    const mode = settings.coerce(BY_KEY.receipt_qr_mode, p.receipt_qr_mode);
    mine.push(['receipt_qr_mode', mode]);
    shared.receipt_qr = mode === 'kapali' ? '0' : '1';
  }

  for (const [k, raw] of Object.entries(p)) {
    if (k === 'receipt_paper' || k === 'receipt_header' || k === 'receipt_footer') continue;
    if (k === 'receipt_fx_currencies' || k === 'receipt_qr_mode') continue;   // handled above
    if (BY_KEY[k]) { mine.push([k, settings.coerce(BY_KEY[k], raw)]); continue; }
    if (BORROWED_KEYS.includes(k)) {
      // receipt_width follows the paper; letting both through would let the
      // form send a width that contradicts the paper it also sent. The two
      // derived booleans follow the list and the mode for the same reason.
      if (k === 'receipt_width' && shared.receipt_width !== undefined) continue;
      if (DERIVED_KEYS.includes(k) && shared[k] !== undefined) continue;
      shared[k] = raw;
      continue;
    }
    throw bad(`Bilinmeyen fiş ayarı: ${k}`);
  }

  const width = shared.receipt_width !== undefined
    ? Number(shared.receipt_width) : await charWidth();
  const header = p.receipt_header !== undefined ? checkBlock(p.receipt_header, 'Fiş başlığı', width) : undefined;
  const footer = p.receipt_footer !== undefined ? checkBlock(p.receipt_footer, 'Fiş altı yazısı', width) : undefined;

  for (const [k, v] of mine) {
    const old = await db.getSetting(k, null);
    if (String(old) === String(v)) continue;
    await db.setSetting(k, v);
    await db.exec(
      'INSERT INTO np_settings_log (client_id, k, old_value, new_value, changed_by, created_at) VALUES (?,?,?,?,?,NOW())',
      [clientId || 0, k, old === null ? null : String(old).slice(0, 500), String(v).slice(0, 500), actorId || null])
      .catch(e => log.warn('receipt', 'change log not written: ' + e.message));
  }
  if (Object.keys(shared).length) await settings.save(clientId, shared, actorId);

  if (header !== undefined || footer !== undefined) {
    const c = await db.one('SELECT receipt_header, receipt_footer FROM clients WHERE id=?', [clientId]);
    if (!c) throw bad('İşletme kaydı bulunamadı', 404);
    await db.exec('UPDATE clients SET receipt_header=?, receipt_footer=? WHERE id=?',
      [header !== undefined ? header : c.receipt_header,
       footer !== undefined ? footer : c.receipt_footer, clientId]);
  }
  return { saved: mine.length + Object.keys(shared).length + (header !== undefined ? 1 : 0) + (footer !== undefined ? 1 : 0) };
}

/* ==================================================================== *
 * 3. WHAT THE PRINT AGENT ASKS FOR                                     *
 * ==================================================================== */

/** The character width in force. print/index.js calls this instead of guessing 48. */
async function charWidth() {
  const n = Number(await db.getSetting('receipt_width', 48));
  return Number.isFinite(n) && n >= 24 && n <= 96 ? Math.round(n) : 48;
}

/**
 * Resolved receipt options, in one object, for print/index.js.
 *
 * Defaults are identical to the values the builder used before this module
 * existed, so a till that has never opened the Fiş ekranı prints exactly the
 * bill it printed yesterday.
 *
 * `override` is the UNSAVED form, and it is why the preview is live: the screen
 * sends what the owner has typed, the same builder renders it, and nothing is
 * written until he presses Kaydet. Without it the preview could only show the
 * last save, which is the one thing he already knows.
 */
async function options(clientId, override) {
  const o = override || {};
  const raw = async (k, def) => (o[k] !== undefined && o[k] !== null
    ? String(o[k]) : String(await db.getSetting(k, def)));
  const on = async (k, def) => {
    const v = (await raw(k, def)).toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
  };
  const c = clientId ? await db.one('SELECT receipt_header, receipt_footer FROM clients WHERE id=?', [clientId]) : null;
  const text = (k, col) => (o[k] !== undefined && o[k] !== null
    ? String(o[k]) : String((c && c[col]) || ''));
  /* both resolved once, from the draft when there is one - see the comments on
     resolveQrMode/resolveFx for why a draft must not be ANDed with the saved
     booleans it is about to overwrite */
  const qrMode = await resolveQrMode(override || null);
  const fx = await resolveFx(override || null);
  return {
    title: (await raw('receipt_title', 'HESAP FISI')).trim() || 'HESAP FISI',
    thanks: (await raw('receipt_thanks', '')).trim(),
    headerText: text('receipt_header', 'receipt_header'),
    footerText: text('receipt_footer', 'receipt_footer'),
    showThanks: await on('receipt_show_thanks', '1'),
    showBusinessName: await on('receipt_show_business_name', '1'),
    showAddress: await on('receipt_show_address', '1'),
    showPhone: await on('receipt_show_phone', '1'),
    showTax: await on('receipt_show_tax', '1'),
    showTable: await on('receipt_show_table', '1'),
    showDateTime: await on('receipt_show_datetime', '1'),
    showBrand: await on('receipt_show_brand', '1'),
    showVat: await on('receipt_show_vat', '1'),
    showWaiter: await on('receipt_show_waiter', '1'),

    /* ------------------------------ döviz ------------------------------ *
     * `fx` is the master yes/no and `fxCodes` is which; an empty fxCodes with
     * fx on means "every currency that has a rate", which is what the older
     * receipt_show_fx checkbox has promised in its help text since before this
     * screen existed. print/document.js does the arithmetic - none of it
     * happens here, and none of it can reach `totals`.                     */
    fx: fx.on,
    fxCodes: fx.codes,
    fxSource: (await raw('receipt_fx_source', 'elle')).trim() || 'elle',
    fxMaxAgeHours: Number(await raw('receipt_fx_max_age_hours', '24')) || 24,

    /* ----------------------------- karekod ----------------------------- */
    qrMode,
    qrText: (await raw('receipt_qr_text', '')).trim(),
    qrLoyaltyUrl: (await raw('receipt_qr_loyalty_url', '')).trim(),
    qrCaption: (await raw('receipt_qr_caption', '')).trim(),
    /* kept for anything still asking "is there a QR at all" - it is now the
       consequence of the mode, never a second opinion about it */
    qr: qrMode !== 'kapali',
  };
}

/* ==================================================================== *
 * 4. THE PREVIEW                                                       *
 * ==================================================================== */

/** A bill whose arithmetic is checkable by eye: 2x420 + 45 + 180 = 1.065,00. */
function sampleOrder() {
  const items = [
    { qty: 2, product_name: 'Adana Kebap', unit_price: 420, line_total: 840, vat_rate: 10, sent_qty: 2 },
    { qty: 1, product_name: 'Ayran', unit_price: 45, line_total: 45, vat_rate: 10, sent_qty: 1 },
    { qty: 1, product_name: 'Efes Pilsen', unit_price: 180, line_total: 180, vat_rate: 20, sent_qty: 1, note: 'soğuk' },
  ];
  const total = items.reduce((s, i) => s + i.line_total, 0);
  return {
    id: 0, adisyon_no: 'ORNEK', table_name: 'Masa 5', bill_label: '', waiter_name: 'Ahmet',
    opened_at: null, closed_at: null, status: 'open',
    /* the stored header must agree with the lines or document.js will
       (correctly) try to repair a row that does not exist */
    total, discount_total: 0, vat_total: 0, grand_total: total, paid: 0, due: total,
    items, payments: [],
  };
}

/**
 * What will come out of the printer, as lines.
 *
 * Every returned line is exactly as wide as the paper: `text` is padded to the
 * character count, and a double-width line carries dw:true and half the
 * characters, because that is what a double-width line is - the same amount of
 * paper, in bigger letters. A screen that renders dw at 2ch per character shows
 * the true slip.
 */
async function preview(clientId, { paper, orderId, draft } = {}) {
  const printing = require('../print');            // late: print/index.js requires us back
  const width = paper ? charsForPaper(paper) : await charWidth();
  let order = sampleOrder();
  let sample = true;
  if (orderId) {
    const orders = require('./orders');
    const real = await orders.getOrder(clientId, Number(orderId));
    if (!real) throw bad('Adisyon bulunamadı', 404);
    order = real; sample = false;
  }
  const opts = await options(clientId, draft || null);
  const bytes = await printing.buildBill(clientId, order,
    { width, showPayments: !sample, receiptOptions: opts });
  return {
    width, paper: paper ? Number(paper) : paperForChars(width), sample,
    lines: layout(decode(bytes), width),
    bytes: bytes.length,
  };
}

/**
 * Turn decoded lines into paper.
 *
 * The printer wraps anything longer than the paper and pads nothing, so the
 * preview does the same: long lines are broken at the character the printer
 * breaks them at, centred lines are centred in the real width, and every chunk
 * comes back exactly as wide as the paper. `cells` is what the line costs in
 * paper columns and is always the full width - that is the honesty check.
 */
function layout(lines, width) {
  const out = [];
  for (const l of lines) {
    const w = l.dw ? Math.floor(width / 2) : width;
    const text = String(l.text);
    const chunks = [];
    if (!text.length) chunks.push('');
    for (let i = 0; i < text.length; i += w) chunks.push(text.slice(i, i + w));
    for (const c of chunks) {
      let s = c;
      if (l.align === 'center') {
        const left = Math.floor((w - c.length) / 2);
        s = ' '.repeat(Math.max(0, left)) + c;
      } else if (l.align === 'right') {
        s = ' '.repeat(Math.max(0, w - c.length)) + c;
      }
      s = s.length > w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
      out.push({ text: s, bold: !!l.bold, dw: !!l.dw, align: l.align, cells: l.dw ? s.length * 2 : s.length });
    }
  }
  return out;
}

/* ==================================================================== *
 * 5. PRINTERS - paper width, the kasa printer, the queue                *
 * ==================================================================== */

/*
 * `is_default` IS the receipt printer: print/index.printerFor() falls back to
 * it for every job that names no station, which is exactly what a bill is. It
 * is exposed as `is_receipt` because "varsayılan" told the owner nothing about
 * which machine his hesap fişi comes out of - but it is the same column, not a
 * second flag that could disagree with the one the queue reads.
 */
async function receiptPrinter(clientId) {
  if (!clientId) return null;
  return db.one('SELECT * FROM printers WHERE client_id=? AND is_default=1 LIMIT 1', [clientId]);
}

async function listPrinters(clientId) {
  const base = await settings.listPrinters(clientId);
  const printers = base.printers.map(p => ({
    ...p,
    paper_width: Number(p.paper_width) || 80,
    chars: charsForPaper(p.paper_width),
    is_receipt: !!Number(p.is_default),
  }));
  return {
    ...base,
    printers,
    stations: await settings.listStations(clientId),
    papers: [[80, '80 mm (48 karakter)'], [58, '58 mm (32 karakter)']],
    receipt_width: await charWidth(),
  };
}

/**
 * Add or edit a printer.
 *
 * The name / type / address / duplicate rules are settings.savePrinter's - they
 * are already right and already tested, and a second copy of them here is a
 * second copy to get wrong. What this adds is the paper, and the one
 * consequence the old screen never drew: if this machine is the kasa printer,
 * the receipt width follows its paper. Setting 58 mm on the kasa printer and
 * still printing 48 characters is the bug the owner would have found on paper.
 */
async function savePrinter(clientId, data, actorId) {
  const paper = Number(data.paper_width || 80) === 58 ? 58 : 80;
  const isReceipt = data.is_receipt !== undefined ? !!data.is_receipt : !!data.is_default;
  const id = await settings.savePrinter(clientId, { ...data, is_default: isReceipt ? 1 : 0 });
  await db.exec('UPDATE printers SET paper_width=? WHERE id=? AND client_id=?', [paper, id, clientId]);
  if (isReceipt) await syncWidthToReceiptPrinter(clientId, actorId);
  return { id, paper_width: paper, chars: charsForPaper(paper) };
}

/** The kasa printer's paper decides the receipt width. One place, on purpose. */
async function syncWidthToReceiptPrinter(clientId, actorId) {
  const p = await receiptPrinter(clientId);
  if (!p) return null;
  const chars = charsForPaper(p.paper_width);
  if (Number(await db.getSetting('receipt_width', 48)) === chars) return chars;
  await settings.save(clientId, { receipt_width: String(chars) }, actorId);
  await db.setSetting('receipt_paper', String(Number(p.paper_width) === 58 ? 58 : 80));
  log.info('receipt', `Fiş genişliği ${chars} karaktere alındı (${p.name} - ${p.paper_width} mm)`);
  return chars;
}

async function setReceiptPrinter(clientId, printerId, actorId) {
  const p = await db.one('SELECT * FROM printers WHERE id=? AND client_id=?', [printerId, clientId]);
  if (!p) throw bad('Yazıcı bulunamadı', 404);
  await db.exec('UPDATE printers SET is_default=0 WHERE client_id=?', [clientId]);
  await db.exec('UPDATE printers SET is_default=1 WHERE id=? AND client_id=?', [printerId, clientId]);
  return { chars: await syncWidthToReceiptPrinter(clientId, actorId) };
}

const deletePrinter = (clientId, id) => settings.deletePrinter(clientId, id);
const testPrinter = (clientId, id) => settings.testPrinter(clientId, id);
const queue = (clientId, opts) => settings.printQueue(clientId, opts);
const retryJob = (clientId, id) => settings.retryJob(clientId, id);
const retryFailed = (clientId) => settings.retryFailed(clientId);
const cancelJob = (clientId, id) => settings.cancelJob(clientId, id);

/* ------------------------------ istasyonlar ------------------------- *
 * The İstasyonlar tab sits next to Yazıcılar on this screen because that is
 * where its relationships are - a station is a printer's destination and a
 * category's route, and both of those are edited two tabs away. The rules
 * themselves are NOT re-implemented here: they belong to modules/settings,
 * which has owned station CRUD since before this screen existed and is what
 * /api/settings/stations still offers. Two copies of "can this station be deleted"
 * is two answers to that question, and the destructive one would eventually be
 * the one that was never updated.
 * -------------------------------------------------------------------- */
const stationOverview = (clientId) => settings.stationOverview(clientId);
const saveStation = (clientId, data) => settings.saveStation(clientId, data);
const deleteStation = (clientId, id) => settings.deleteStation(clientId, id);
const setStationActive = (clientId, id, on) => settings.setStationActive(clientId, id, on);
const reorderStations = (clientId, ids) => settings.reorderStations(clientId, ids);
const setDefaultStation = (clientId, id) => settings.setDefaultStation(clientId, id);
const assignCategories = (clientId, id, ids) => settings.assignCategories(clientId, id, ids);

/* ==================================================================== *
 * 6. MÜŞTERİ EKRANI                                                     *
 * ==================================================================== */

/* Three, because the second monitor is usually a television and "Orta" on a
   55" screen across a counter is still a stamp. */
const MEDIA_SIZES = [['kucuk', 'Küçük'], ['orta', 'Orta'], ['buyuk', 'Büyük']];
/* A data: URI is stored in the row rather than a file on disk: display.html is
   served to a second monitor that may be a browser on another machine, and a
   path only that machine can read is a broken image on every other one. Capped
   so the 1.5 s poll never has to carry a photograph. */
const IMAGE_MAX = 400 * 1024;

/* The three the restaurants asked for. Ordered as they are drawn. */
const SOCIALS = [
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['tiktok', 'TikTok'],
];

/*
 * A handle, however the owner typed it.
 *
 * They will paste "@bellaalanya", "bellaalanya", or the whole
 * "https://instagram.com/bellaalanya/" out of the address bar - all three mean
 * the same account, and the screen should show one thing. Strip the address,
 * strip the @, strip the trailing slash; the display puts the @ back itself.
 */
function handle(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  s = s.replace(/^(?:instagram\.com|facebook\.com|fb\.com|tiktok\.com|vm\.tiktok\.com)\/?/i, '');
  s = s.split(/[?#]/)[0].replace(/\/+$/, '');
  s = s.replace(/^@+/, '').trim();
  return s ? s.slice(0, 80) : null;
}

async function displaySettings() {
  const row = await db.one('SELECT * FROM np_display_settings WHERE id=1');
  return {
    settings: row || {},
    sizes: MEDIA_SIZES,
    socials: SOCIALS,
    image_max_kb: Math.round(IMAGE_MAX / 1024),
    defaults: { headline: 'Hoş geldiniz', subline: 'Afiyet olsun', foot_note: 'NOKTApp POS' },
  };
}

/**
 * Save the second screen.
 *
 * The QR is rendered to SVG HERE, not when the display asks: /api/display is
 * polled every 1.5 seconds by a screen with nothing else to do, and it must not
 * be doing barcode arithmetic on every poll. It is also the only way the
 * unauthenticated display page can show a QR without a drawing library of its
 * own.
 */
async function saveDisplay(data) {
  const d = data || {};
  const text = (v, max, label) => {
    const s = String(v === null || v === undefined ? '' : v).trim();
    if (s.length > max) throw bad(`${label} en fazla ${max} karakter olabilir`);
    return s || null;
  };
  const headline = text(d.headline, 120, 'Karşılama yazısı');
  const subline = text(d.subline, 200, 'Alt yazı');
  const footNote = text(d.foot_note, 120, 'Alt köşe yazısı');
  const qrData = text(d.qr_data, 500, 'Karekod içeriği');
  const qrCaption = text(d.qr_caption, 120, 'Karekod altı yazısı');
  const imageCaption = text(d.image_caption, 120, 'Görsel altı yazısı');
  const size = MEDIA_SIZES.some(([k]) => k === d.media_size) ? d.media_size : 'kucuk';
  const social = {};
  for (const [key] of SOCIALS) social[key] = handle(d['social_' + key]);
  const socialOn = !!d.social_enabled;
  if (socialOn && !SOCIALS.some(([k]) => social[k])) {
    throw bad('Sosyal medyayı açtınız ama hiçbir hesap adı girilmedi.');
  }

  const qrOn = !!d.qr_enabled;
  if (qrOn && !qrData) throw bad('Karekodu açtınız ama içeriği boş. Adres ya da yazı girin.');

  let image = d.image_data === undefined ? undefined : String(d.image_data || '').trim();
  if (image) {
    const okShape = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(image)
      || /^https?:\/\//i.test(image) || image.startsWith('/');
    if (!okShape) throw bad('Görsel bir resim dosyası (data: URI) ya da bir adres olmalı');
    if (image.length > IMAGE_MAX) {
      throw bad(`Görsel çok büyük (${Math.round(image.length / 1024)} KB). En fazla ${Math.round(IMAGE_MAX / 1024)} KB olabilir.`);
    }
  }
  if (d.image_enabled && !image) {
    const cur = await db.value('SELECT image_data FROM np_display_settings WHERE id=1');
    if (!cur) throw bad('Görseli açtınız ama henüz bir görsel yüklenmedi.');
  }

  let svg = null;
  if (qrOn && qrData) {
    try {
      const QRCode = require('qrcode-svg');
      /*
       * padding 4, not 1.
       *
       * The quiet zone is part of the symbol: the standard asks for four
       * modules of white on every side, and a reader that cannot find it
       * either refuses the code or hunts for it. At padding 1 the dark modules
       * sat against the edge of their own white square, which is why the
       * karekod on the customer display looked wedged into its frame - and why
       * a phone held at arm's length would not take it.
       */
      svg = new QRCode({ content: qrData, padding: 4, width: 240, height: 240,
        color: '#18181B', background: '#ffffff', ecl: 'M', join: true }).svg();
    } catch (e) {
      throw bad('Karekod üretilemedi: ' + e.message);
    }
  }

  const sql = `UPDATE np_display_settings SET headline=?, subline=?, foot_note=?, enabled=?,
      qr_enabled=?, qr_data=?, qr_caption=?, qr_svg=?, image_enabled=?, image_caption=?, media_size=?,
      social_enabled=?, social_instagram=?, social_facebook=?, social_tiktok=?
      ${image === undefined ? '' : ', image_data=?'} WHERE id=1`;
  const params = [headline, subline, footNote, d.enabled ? 1 : 0,
    qrOn ? 1 : 0, qrData, qrCaption, svg, d.image_enabled ? 1 : 0, imageCaption, size,
    socialOn ? 1 : 0, social.instagram, social.facebook, social.tiktok];
  if (image !== undefined) params.push(image || null);
  const n = await db.exec(sql, params);
  if (!n) {
    await db.exec('INSERT INTO np_display_settings (id, template, headline, subline, enabled) VALUES (1,?,?,?,?)',
      ['marka', headline, subline, d.enabled ? 1 : 0]);
    await db.exec(sql, params);
  }
  return displaySettings();
}

module.exports = {
  GROUPS, DEFS, BY_KEY, BORROWED_KEYS, DERIVED_KEYS, catalogue, values, get, save,
  charsForPaper, paperForChars, charWidth, options,
  parseCodes, resolveQrMode, resolveFx, checkCurrencies, fxWarnings, qrWarning,
  preview, layout, sampleOrder,
  listPrinters, savePrinter, deletePrinter, testPrinter, setReceiptPrinter, receiptPrinter,
  syncWidthToReceiptPrinter, queue, retryJob, retryFailed, cancelJob,
  stationOverview, saveStation, deleteStation, setStationActive, reorderStations,
  setDefaultStation, assignCategories,
  displaySettings, saveDisplay, MEDIA_SIZES, IMAGE_MAX,
  /* exported for the A5 table cards: they print the same three handles this
     file normalises for the customer display, and a second normaliser would
     mean the card and the screen disagree about what the venue's Instagram is
     the first time somebody pastes a full URL */
  socialHandle: handle, SOCIALS,
};
