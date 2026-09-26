/* =====================================================================
   NOKTApp POS - till client core
   Plain JavaScript on purpose: the till has to start in under a second on
   a five year old mini PC, and there is no build step to go wrong on a
   customer's machine.
   ===================================================================== */
'use strict';

const App = {
  token: null,
  tenantToken: null,
  user: null,
  perms: [],
  client: null,
  licence: null,
  page: 'tables',
  data: { menu: [], tables: [], zones: [], order: null, zone: null, category: null },
  poll: null,
};

/* ------------------------------------------------------------------ api */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(App.token ? { Authorization: 'Bearer ' + App.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch (_) {}
  if (res.status === 401) { lock(); throw fault(json, res, 'Oturum sona erdi'); }
  if (!res.ok || json.ok === false) throw fault(json, res, 'İşlem tamamlanamadı');
  return json;
}

/**
 * Turn a failed response into an Error that still carries WHY it failed.
 *
 * This threw `new Error(json.error)` and nothing else, which quietly discarded
 * every machine-readable `code` the server sends - and the server sends them
 * precisely so a screen can tell one refusal from another. The day-end needs
 * to know that a close was refused by FISCAL_Z_FAILED (offer the audited
 * skip) rather than by a locked shift (do not), and it could not: both
 * arrived as a bare message string. Any screen matching on e.code was
 * comparing against undefined and silently taking the else branch.
 *
 * The status and the whole body ride along too, so a caller can read extra
 * fields the server attached without a second request.
 */
function fault(json, res, fallback) {
  const e = new Error((json && json.error) || fallback);
  e.code = (json && json.code) || null;
  e.status = res ? res.status : 0;
  e.body = json || {};
  return e;
}

/* --------------------------------------------------------------- helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tl = (n) => (Math.round(Number(n || 0) * 100) / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Human labels for the codes stored in the database. */
const METHOD_LABEL = {
  nakit: 'Nakit', kredi_karti: 'Kredi kartı', yemek_karti: 'Yemek kartı',
  havale: 'Havale / EFT', ikram: 'İkram', acik_hesap: 'Açık hesap',
};
const COLUMN_LABEL = {
  d: 'Tarih', date: 'Tarih', orders: 'Adisyon', total: 'Ciro', revenue: 'Ciro',
  discount: 'İndirim', vat: 'KDV', qty: 'Adet', cost: 'Maliyet', profit: 'Kâr',
  name: 'Ürün', category: 'Kategori', id: '#', display_name: 'Garson',
  avg_ticket: 'Ortalama adisyon',
};
const label = (m) => METHOD_LABEL[m] || m;
const can = (p) => App.perms.includes(p) || App.user?.role === 'admin' || App.user?.role === 'superadmin';

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' toast--' + kind : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}
const err = (e) => toast(e && e.message ? e.message : String(e), 'error');

function modal(html, opts = {}) {
  $('#modal').className = 'modal' + (opts.wide ? ' modal--wide' : '');
  $('#modal').innerHTML = html;
  $('#modalBack').classList.add('is-on');
  const first = $('#modal input, #modal select, #modal textarea');
  if (first) setTimeout(() => first.focus(), 60);
}
function closeModal() { $('#modalBack').classList.remove('is-on'); $('#modal').innerHTML = ''; }
$('#modalBack').addEventListener('mousedown', (e) => { if (e.target.id === 'modalBack') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/*
 * Dismiss buttons, delegated - and the reason is worth writing down.
 *
 * Every one of these used to be onclick="closeModal()" written straight into
 * the markup, 125 of them across 13 files. They had not worked since the day
 * the Content-Security-Policy header went in: script-src 'self' forbids inline
 * event handlers, so the browser refused each one silently, logging
 * "Refused to execute inline event handler" to a console nobody reads. Every
 * Vazgeç, every close X, every Anladım in the program did nothing, and the
 * suites never caught it because they call the handlers directly instead of
 * clicking like a person does.
 *
 * Delegated from document on purpose: modals are rebuilt with innerHTML all
 * the time, and a listener bound to a button dies with the button. This one
 * outlives every redraw and covers markup that does not exist yet.
 */
document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) { closeModal(); return; }
  const goTo = e.target.closest('[data-go]');
  if (goTo) { closeModal(); go(goTo.dataset.go); }
});

/** Ask a supervisor for their PIN before a sensitive action. */
function askOverride(perm, label) {
  return new Promise((resolve) => {
    modal(`
      <div class="modal__head"><h3>Yetkili onayı</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">${esc(label || 'Bu işlem için yetkili PIN gerekli.')}</p>
        <div class="field"><label>Yetkili PIN</label>
          <input class="input" id="ovPin" type="password" inputmode="numeric" autocomplete="off"></div>
        <div id="ovAlert"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="ovOk">Onayla</button>
      </div>`);
    $('#ovOk').onclick = async () => {
      try {
        const r = await api('POST', '/api/auth/override', { pin: $('#ovPin').value, perm });
        closeModal(); resolve(r.approved_by);
      } catch (e) { $('#ovAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
    $('#ovPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#ovOk').click(); });
  });
}

function confirmBox(title, text, danger = false) {
  return new Promise((resolve) => {
    modal(`
      <div class="modal__head"><h3>${esc(title)}</h3></div>
      <div class="modal__body"><p style="margin:0">${esc(text)}</p></div>
      <div class="modal__foot">
        <button class="btn btn--ghost" id="cbNo">Vazgeç</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" id="cbYes">Evet</button>
      </div>`);
    $('#cbNo').onclick = () => { closeModal(); resolve(false); };
    $('#cbYes').onclick = () => { closeModal(); resolve(true); };
  });
}

/* ------------------------------------------------------------ navigation */
const ICONS = {
  tables: '<path d="M3 10h18M5 10V6a2 2 0 012-2h10a2 2 0 012 2v4M7 10v10M17 10v10"/>',
  order: '<path d="M8 3h8l1 4H7l1-4zM5 7h14l-1.2 13.2a1 1 0 01-1 .8H7.2a1 1 0 01-1-.8L5 7z"/>',
  kitchen: '<path d="M4 4h16v6H4zM7 10v10M17 10v10M4 14h16"/>',
  bills: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  pnl: '<path d="M3 17l5-5 4 3 8-8"/><path d="M20 7h-5M20 7v5"/><path d="M3 21h18"/>',
  products: '<path d="M20 7l-8-4-8 4 8 4 8-4zM4 7v10l8 4 8-4V7"/>',
  guests: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0112 0M17 11a3 3 0 100-6M18 20a6 6 0 00-2-4.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 007 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 15H3a2 2 0 010-4h.1A1.6 1.6 0 004.6 7l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 009 4.6V3a2 2 0 014 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1A1.6 1.6 0 0021 11h.1a2 2 0 010 4H21z"/>',
};
/*
 * `groupLabel`: a sidebar group whose name is not the name of its first screen.
 *
 * A group is identified by its HEAD page, and until now the head's own label
 * was also the group's name in the sidebar. That works while the head is the
 * obvious front door - "Masalar" heads the table screens - and falls apart the
 * moment the group is a subject rather than a screen. "Ayarlar" is a drawer of
 * eleven screens and is not itself one; the drawer used to have a screen of its
 * own that duplicated most of them, which is exactly the mess this replaces.
 * So the head names the group with `groupLabel` and keeps its own label for its
 * own tab: the sidebar says Ayarlar, the first tab under it says İşletme.
 */
const PAGES = [
  { id: 'tables',   label: 'Masalar',  icon: 'tables' },
  { id: 'order',    label: 'Adisyon',  icon: 'order', hidden: true },
  /* The kitchen board lives in screens/floor.js now - one screen, driven by
     the stations the restaurant actually configured, instead of two entries
     called "Mutfak" and "Mutfak panosu" showing overlapping halves. */
  { id: 'kitchen',  label: 'Mutfak',   icon: 'kitchen', hidden: true },
  { id: 'bills',    label: 'Adisyonlar', icon: 'bills' },
  { id: 'reports',  label: 'Raporlar', icon: 'reports', perm: 'report.view' },
  { id: 'pnl',      label: 'Kâr / Zarar', icon: 'pnl', perm: 'report.view', group: 'reports' },
  { id: 'products', label: 'Ürünler',  icon: 'products', perm: 'product.manage' },
  { id: 'guests',   label: 'Müşteri',  icon: 'guests' },
  /*
   * `settings` is an ADDRESS now, not a screen.
   *
   * It used to be a group head that also rendered a page of its own, and that
   * page carried a second copy of the printers, the ÖKC, the users and the
   * business details that the screens beneath it already owned. It is kept as a
   * hidden member of the group so that go('settings'), a bookmarked ?p=settings
   * and every phone that learned the name still land on İşletme instead of a
   * blank #main - see Screens.page_settings.
   */
  { id: 'settings', label: 'Ayarlar', icon: 'settings', perm: 'settings.manage',
    hidden: true, group: 'isletme' },
];

/*
 * Screens register their own nav entry, so adding an area does not mean
 * editing this array and hoping nobody else edited it at the same time.
 * `after` places the entry; an unknown `after` puts it at the end.
 */
function registerPage(page, after) {
  if (PAGES.some(p => p.id === page.id)) return;
  const at = after ? PAGES.findIndex(p => p.id === after) : -1;
  if (at >= 0) PAGES.splice(at + 1, 0, page); else PAGES.push(page);
}

function registerIcon(name, path) {
  if (!ICONS[name]) ICONS[name] = path;
}

/* =====================================================================
   ÖZELLİKLER - the parts of the program this installation is actually using
   =====================================================================

   ÖKC is the first of these and the reason the mechanism exists. Almost no
   restaurant we are opening with is legally obliged to cut a mali fiş, and for
   the rest of them a sidebar entry called ÖKC, two rows in search and a page in
   F1 are four separate invitations to configure a device they do not own and
   cannot buy. So the whole area is switched OFF by default and disappears.

   It DISAPPEARS, it is not deleted. The adapters, the GMP3 work and its tests
   are all still in the tree, and a customer who is later required to run one
   gets it back by turning `fiscal_enabled` on - not by us rebuilding it.

   The gate is applied where things are DRAWN, never to the declarations
   themselves. PAGES, SEARCH and HELP stay whole and stay consistent with each
   other - every screen still has a help entry and no entry points at a screen
   that does not exist - because those two indexes are walked by test/yardim.js
   and pruning them at registration time would break that coverage the moment a
   feature is off. What a person is offered is a question about this till; what
   the program contains is not. */
const FEATURES = { okc: false };

/** True only for a feature this installation has switched on. */
function featureOn(name) { return FEATURES[name] === true; }

/**
 * Is this screen on offer right now?
 *
 * Answers both halves of "screen not loaded": a page id nobody registered, and
 * a page that belongs to a feature that is off. Search rows, sidebar entries,
 * tab strips and help entries all ask this one question, so they cannot end up
 * disagreeing about whether an area exists.
 */
function pageOffered(id) {
  const p = PAGES.find(x => x.id === id);
  if (!p) return false;
  return !p.feature || featureOn(p.feature);
}

/**
 * Read the switches, before the first thing is drawn.
 *
 * A failure leaves every feature off rather than on: showing an area that turns
 * out not to work is worse than hiding one somebody can switch back on, and the
 * only way this request fails is a till that is not answering anyway.
 */
async function loadFeatures() {
  try {
    const r = await api('GET', '/api/auth/features');
    for (const k of Object.keys(FEATURES)) FEATURES[k] = (r.features || {})[k] === true;
  } catch (_) { for (const k of Object.keys(FEATURES)) FEATURES[k] = false; }
}

/** Re-read after a settings save, so switching ÖKC on does not need a re-login. */
async function refreshFeatures() {
  const before = JSON.stringify(FEATURES);
  await loadFeatures();
  if (JSON.stringify(FEATURES) !== before) drawNav();
}

/*
 * Grouping.
 *
 * Ten areas were built as separate screens and the sidebar grew to 27 entries,
 * which is not a navigation, it is a list. A page may now name a `group`: the
 * sidebar shows only the group HEAD, and the members appear as a tab strip
 * across the top of whichever member is open. Nothing inside a screen changes -
 * the strip is drawn by the router, not by the screen.
 */
function groupOf(id) {
  const p = PAGES.find(x => x.id === id);
  return p ? (p.group || p.id) : id;
}
function groupMembers(head) {
  return PAGES.filter(p => !p.hidden && (p.group === head || p.id === head)
                            && (!p.perm || can(p.perm)) && pageOffered(p.id))
    /* Sorted by NAV_ORDER, not by which <script> tag loaded first. The tab
       strip is navigation, and Ayarlar now has eleven tabs registered from six
       different files - left to load order they came out in the order the
       files happened to be listed in index.html, which is not an order anybody
       can read. A member NAV_ORDER does not name keeps its registered place. */
    .slice().sort((a, b) => navRank(a.id) - navRank(b.id));
}

/** The tab strip for the group the given page belongs to, or '' if it is alone. */
function subnavHtml(page) {
  const head = groupOf(page);
  const members = groupMembers(head);
  if (members.length < 2) return '';
  return `<div class="subnav">` + members.map(m =>
    `<button class="subnav__tab${m.id === page ? ' is-active' : ''}" data-sub="${m.id}">${m.label}</button>`
  ).join('') + `</div>`;
}

/*
 * The order of the sidebar, decided here rather than by which screen file
 * happened to load first.
 *
 * Every screen registers its own nav entry, which is right - adding an area
 * should not mean editing a list somebody else is also editing - but it left
 * the ORDER of the sidebar as an accident of the <script> tags. It reads
 * top-to-bottom the way a shift runs: seat them, take the bill, take the
 * money, watch the screens; then the menu behind it; then who came in; then
 * the numbers; then the settings you touch twice a year.
 *
 * A page not named here goes to the end, so a new screen still appears.
 *
 * The list runs past the sidebar and names the members of a group too, because
 * groupMembers() orders the tab strip by the same ranking. Para comes before
 * Ayarlar on purpose: setting the euro a restaurant accepts today is a routine
 * act somebody does before service, not an administrative one, and it used to
 * sit three clicks inside a screen called Yönetim where nobody found it.
 */
const NAV_ORDER = ['tables', 'bills', 'kasa', 'mutfak',
                   /* Paket Servis sits after the service run - seat them,
                      take the bill, take the money, watch the screens - and
                      before the menu admin. It is worked all evening, so it
                      stays above the screens nobody opens twice a year, but
                      the floor is still the front door of the till. */
                   'paket', 'kurye', 'adresler', 'platformlar', 'paketrapor',
                   'products', 'stock',
                   'guests', 'reports',
                   /* Para */
                   'doviz', 'para',
                   /* Ayarlar */
                   'isletme', 'kullanici', 'fis', 'cihazlar', 'okc', 'yedek',
                   'entegrasyon', 'gunluk', 'denetim', 'kurulum', 'profil'];
function navRank(id) {
  const at = NAV_ORDER.indexOf(id);
  return at < 0 ? NAV_ORDER.length : at;
}

function drawNav() {
  $('#nav').innerHTML = PAGES.filter(p => !p.hidden && !p.group && (!p.perm || can(p.perm))
                                        && pageOffered(p.id))
    .slice().sort((a, b) => navRank(a.id) - navRank(b.id)).map(p => `
    <button class="nav__item${groupOf(App.page) === p.id ? ' is-active' : ''}" data-page="${p.id}">
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#52525B" stroke-width="1.7"
           stroke-linecap="round" stroke-linejoin="round">${ICONS[p.icon]}</svg>
      <span>${p.groupLabel || p.label}</span>
      <span class="nav__badge" data-badge="${p.id}" hidden></span>
    </button>`).join('');
  $$('#nav .nav__item').forEach(b => b.onclick = () => go(b.dataset.page));
}

/* =====================================================================
   ARAMA - one box that knows where everything is
   =====================================================================

   Twenty-odd screens, most of them tabbed, and no way to find anything by
   name. Somebody who wants to change a KDV rate has to already know it lives
   under Ayarlar - and it lives under three other places besides. So: type what
   you are looking for, get every place it is.

   The index is declared (see search-index.js) rather than scraped off the DOM,
   because a tab's label only exists once its screen has been drawn, and the
   thing you cannot find is by definition the thing you have not opened.
   ===================================================================== */
const SEARCH = [];

/** A screen adds its own entries. Unknown pages are dropped when drawn. */
function registerSearch(entries) {
  for (const e of entries || []) SEARCH.push(e);
}

/* =====================================================================
   YARDIM - what every screen is for
   =====================================================================

   The other declared index, and declared for the same reason as the one above:
   the screen somebody needs explained is the screen they have not got working,
   so its help may not depend on that screen having been drawn. The content is
   in help-index.js; the panel that shows it is in screens/yardim.js. Only the
   array lives here, so that help-index.js can be loaded as early as any other
   index and does not have to wait for a screen file.
   ===================================================================== */
const HELP = [];

/** One entry per screen (and per tab where the tabs are different jobs). */
function registerHelp(entries) { for (const e of entries || []) HELP.push(e); }

/*
 * Turkish folding, in BOTH directions.
 *
 * "KDV" must match a user typing "kdv"; "İşlemler" must match "islemler"; and
 * "sipariş" must match "siparis", because nobody reaches for ş on a keyboard
 * they are in a hurry with. JavaScript's toLowerCase() turns I into i and
 * leaves İ alone, which is exactly backwards for Turkish, so the letters are
 * mapped by hand before the accents are stripped.
 */
const TR_FOLD = { 'İ': 'i', 'I': 'i', 'ı': 'i', 'Ş': 's', 'ş': 's', 'Ğ': 'g', 'ğ': 'g',
                  'Ü': 'u', 'ü': 'u', 'Ö': 'o', 'ö': 'o', 'Ç': 'c', 'ç': 'c' };
function fold(v) {
  return String(v == null ? '' : v)
    .replace(/[İIıŞşĞğÜüÖöÇç]/g, c => TR_FOLD[c])
    .toLowerCase().trim();
}

/**
 * Rank matters more than it looks: a cashier types three letters and takes
 * whatever is first. A hit on the entry's own name beats a hit on a keyword,
 * and a match at the START of a word beats one in the middle - "kas" should
 * offer Kasa before Ödeme kaydı.
 */
function searchHits(query, limit = 9) {
  const q = fold(query);
  if (q.length < 2) return [];
  const out = [];
  for (const e of SEARCH) {
    if (e.perm && !can(e.perm)) continue;
    if (!pageOffered(e.page)) continue;   // screen not loaded, or its feature is off
    const name = fold(e.label);
    const area = fold(e.area || '');
    const keys = (e.keywords || []).map(fold);
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (keys.some(k => k === q)) score = 55;
    else if (keys.some(k => k.startsWith(q))) score = 40;
    else if (keys.some(k => k.includes(q))) score = 25;
    else if (area.includes(q)) score = 15;
    if (score) out.push({ e, score });
  }
  out.sort((a, b) => b.score - a.score || a.e.label.localeCompare(b.e.label, 'tr'));
  return out.slice(0, limit).map(x => x.e);
}

let SEARCH_OPEN = [];
function drawSearch(query) {
  const box = $('#searchDrop');
  if (!box) return;
  SEARCH_OPEN = searchHits(query);
  if (!SEARCH_OPEN.length) {
    box.innerHTML = fold(query).length >= 2
      ? '<div class="search__empty">Eşleşen bir şey yok.</div>' : '';
    box.classList.toggle('is-on', fold(query).length >= 2);
    return;
  }
  box.innerHTML = SEARCH_OPEN.map((e, i) => `
    <button class="search__hit${i === 0 ? ' is-active' : ''}" data-i="${i}">
      <span class="search__label">${esc(e.label)}</span>
      <span class="search__area">${esc(e.area || '')}</span>
    </button>`).join('');
  box.classList.add('is-on');
  box.querySelectorAll('[data-i]').forEach(b =>
    b.onclick = () => openHit(SEARCH_OPEN[Number(b.dataset.i)]));
}

function openHit(e) {
  if (!e) return;
  closeSearch();
  go(e.page, e.arg);
  /*
   * A tab inside a screen is reached by clicking it, because every screen owns
   * its own tab state and there is no shared way to ask for one. The screen is
   * drawn asynchronously, so this looks for the tab a few times and then gives
   * up - landing on the right screen is already most of the answer.
   */
  if (!e.tab) return;
  let tries = 0;
  const hunt = () => {
    const el = document.querySelector(`#main [data-tab="${e.tab}"], #main [data-t="${e.tab}"], `
      + `#main [data-st="${e.tab}"], #main [data-k="${e.tab}"]`);
    if (el) return el.click();
    if (++tries < 12) setTimeout(hunt, 90);
  };
  setTimeout(hunt, 120);
}

function closeSearch() {
  const box = $('#searchDrop');
  if (box) { box.classList.remove('is-on'); box.innerHTML = ''; }
  SEARCH_OPEN = [];
  const inp = $('#searchIn');
  if (inp) inp.value = '';
}

function wireSearch() {
  const inp = $('#searchIn');
  if (!inp) return;
  let t = null;
  inp.oninput = () => { clearTimeout(t); t = setTimeout(() => drawSearch(inp.value), 90); };
  inp.onfocus = () => { if (inp.value) drawSearch(inp.value); };
  inp.onkeydown = (ev) => {
    const hits = $('#searchDrop').querySelectorAll('.search__hit');
    if (ev.key === 'Escape') return closeSearch();
    if (!hits.length) return;
    const at = Array.from(hits).findIndex(h => h.classList.contains('is-active'));
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const next = ev.key === 'ArrowDown'
        ? Math.min(at + 1, hits.length - 1) : Math.max(at - 1, 0);
      hits.forEach(h => h.classList.remove('is-active'));
      hits[next].classList.add('is-active');
      return;
    }
    if (ev.key === 'Enter') { ev.preventDefault(); openHit(SEARCH_OPEN[Math.max(at, 0)]); }
  };
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.search')) closeSearch();
  });
  /* Ctrl+F / Ctrl+K land here rather than in the browser's own find bar. */
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'f' || ev.key === 'k')) {
      ev.preventDefault(); inp.focus(); inp.select();
    }
  });
}

function go(page, arg) {
  App.page = page;
  drawNav();
  // a hit that was clicked has done its job; a stale list over a new screen
  // is just something else to dismiss
  if (typeof SEARCH_OPEN !== 'undefined' && SEARCH_OPEN.length) closeSearch();
  const meta = PAGES.find(p => p.id === page);
  const head = PAGES.find(p => p.id === groupOf(page));
  // the title names the AREA, the tab strip says which part of it
  $('#pageTitle').textContent = head ? (head.groupLabel || head.label)
    : (meta ? meta.label : '');
  Screens.render(page, arg);
  /*
   * Drawn after the screen, because a screen replaces #main wholesale. Screens
   * that render asynchronously get it again on the next tick - cheaper than
   * asking twenty screen files to call something at the right moment.
   */
  const paint = () => {
    const strip = subnavHtml(page);
    if (!strip) return;
    const main = $('#main');
    if (!main || main.querySelector('.subnav')) return;
    const host = main.firstElementChild || main;
    host.insertAdjacentHTML('afterbegin', strip);
    $$('#main .subnav__tab').forEach(b => b.onclick = () => go(b.dataset.sub));
  };
  paint();
  setTimeout(paint, 60);
  setTimeout(paint, 400);
}

function setBadge(page, n) {
  const el = $(`[data-badge="${page}"]`);
  if (!el) return;
  if (n > 0) { el.textContent = n; el.hidden = false; } else el.hidden = true;
}

/* ---------------------------------------------------------------- login */
async function boot() {
  try {
    const st = await api('GET', '/api/auth/state');
    $('#lgDevice').textContent = (st.device_id || '').slice(0, 8);
    if (st.licence && st.licence.licensed) {
      // the machine is already activated - go straight to the PIN pad
      showPinPad(st);
    }
  } catch (e) { /* first run, no licence yet */ }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#lgBtn');
  btn.disabled = true; btn.textContent = 'Kontrol ediliyor...';
  $('#loginAlert').innerHTML = '';
  try {
    const r = await api('POST', '/api/auth/tenant-login', { email: $('#lgEmail').value, password: $('#lgPass').value });
    App.tenantToken = r.token; App.token = r.token; App.client = r.client; App.licence = r.licence;
    if (r.offline) toast('Çevrimdışı giriş yapıldı - lisans bilgisi bu bilgisayardan okundu');
    const setup = await api('GET', '/api/setup/state');
    if (!setup.setup_done) return Screens.wizard(setup);
    showPinPad();
  } catch (e2) {
    $('#loginAlert').innerHTML = `<div class="alert alert--error">${esc(e2.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = 'Giriş yap'; }
});

function showPinPad(state) {
  let pin = '';
  const draw = () => {
    $('#loginForm').style.display = 'none';
    const dev = $('#lgDevice');
    if (dev && dev.parentElement) dev.parentElement.style.display = 'none';
    $('.login__box h2').textContent = 'Personel girişi';
    $('.login__box .sub').textContent = 'PIN kodunuzu girin.';
    let pad = $('#padWrap');
    if (!pad) {
      pad = document.createElement('div');
      pad.id = 'padWrap';
      $('.login__box').appendChild(pad);
    }
    pad.innerHTML = `
      <div class="pindots">${[0, 1, 2, 3].map(i => `<div class="pindot${i < pin.length ? ' is-on' : ''}"></div>`).join('')}</div>
      <div class="pinpad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-k="${n}">${n}</button>`).join('')}
        <button data-k="c">C</button><button data-k="0">0</button><button data-k="ok">→</button>
      </div>
      <p class="muted" style="text-align:center;margin-top:18px;font-size:12.5px">
        ${esc((App.client && App.client.company_name) || (state && state.licence && state.licence.company) || '')}
      </p>`;
    $$('#padWrap .pinpad button').forEach(b => b.onclick = () => key(b.dataset.k));
  };
  const key = async (k) => {
    if (k === 'c') pin = '';
    else if (k === 'ok') return submit();
    else if (pin.length < 8) pin += k;
    draw();
    if (pin.length >= 4) setTimeout(() => { if (pin.length >= 4) submit(); }, 120);
  };
  const submit = async () => {
    if (!pin) return;
    const attempt = pin; pin = ''; draw();
    try {
      const r = await api('POST', '/api/auth/pin', { pin: attempt });
      App.token = r.token; App.user = r.user; App.perms = r.perms;
      await enterApp();
    } catch (e) { toast(e.message, 'error'); }
  };
  draw();
  document.onkeydown = (e) => {
    if ($('#shell').classList.contains('is-on')) return;
    if (/^[0-9]$/.test(e.key)) key(e.key);
    else if (e.key === 'Enter') key('ok');
    else if (e.key === 'Backspace') key('c');
  };
}

async function enterApp() {
  $('#login').style.display = 'none';
  $('#shell').classList.add('is-on');
  document.onkeydown = null;
  $('#userName').textContent = App.user.display_name || '';
  $('#btnLock').onclick = lock;
  wireSearch();
  wireHelp();
  /* Before the first paint of the navigation, not after: a sidebar that shows
     ÖKC for half a second and then loses it looks like a bug in front of the
     customer, and a person who clicked it in that half second is on a screen
     the till has just decided it does not have. */
  await loadFeatures();
  drawNav();
  await refreshHeader();
  await Screens.loadMenu();
  go('tables');
  /*
   * After the first screen, not before it: ?yardim=kasa has to open OVER a
   * drawn till, and a support call that ends with "open this link" means the
   * person still has to put their PIN in first - the session is in memory, so
   * the link cannot skip the pad.
   */
  helpDeepLink();
  App.poll = setInterval(tick, 8000);
}

function lock() {
  clearInterval(App.poll);
  /*
   * The help panel is fixed over everything and would otherwise sit on top of
   * the PIN pad, unclosable by anybody who is not already signed in.
   *
   * Guarded because lock() can fire from a 401 on boot()'s very first request,
   * and the browser may run that response between two <script> tags - before
   * screens/yardim.js has been parsed. A ReferenceError there would take the
   * login screen down over a panel that was never open.
   */
  if (typeof closeHelp === 'function') closeHelp();
  App.token = App.tenantToken;
  App.user = null; App.perms = [];
  $('#shell').classList.remove('is-on');
  $('#login').style.display = 'grid';
  showPinPad();
}

async function refreshHeader() {
  try {
    const d = await api('GET', '/api/pos/business-date');
    $('#bizDate').textContent = d.business_date.split('-').reverse().join('.') + (d.closed ? ' (kapalı)' : '');
    const s = await api('GET', '/api/pos/shift');
    $('#shiftState').textContent = s.shift ? ('#' + s.shift.shift.shift_no + ' açık') : 'kapalı';
    $('#chipShift').className = 'chip' + (s.shift ? ' chip--live' : ' chip--warn');
  } catch (_) {}
}

async function tick() {
  try {
    if (App.page === 'tables') Screens.render('tables');
    if (App.page === 'mutfak') Screens.render('mutfak');
    const open = await api('GET', '/api/pos/orders/open');
    setBadge('tables', open.orders.length);
  } catch (_) {}
}

boot();
