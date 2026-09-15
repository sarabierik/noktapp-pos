/* =====================================================================
   NOKTApp POS - Ayarlar: İşletme, Kullanıcılar, ÖKC, Yedekleme, Denetim
   =====================================================================
   This file used to be one screen called "Yönetim" with seven tabs, and it
   sat inside a sidebar group called "Ayarlar" whose HEAD rendered an eighth
   screen of its own. The two of them owned the same things: printers were on
   three screens, ÖKC on two, users on two, the business details on two, and
   whichever screen was saved last won while the other went on showing the
   value it had loaded. Nobody could say where a setting lived, because the
   honest answer was "two places, and they disagree".

   Yönetim is gone as a screen. Each of its tabs is now a screen in the
   Ayarlar group, reachable from the sidebar rather than from a tab strip
   inside a screen you had to know the name of:

     İşletme           - the company block, the working hours, the business
                         day, and the generated settings form. The form draws
                         whatever the server declares MINUS the keys another
                         screen owns; see ayNotHere().
     Kullanıcılar      - staff, roles, permissions, PIN resets.
     ÖKC               - fiscal devices, cash registers, the honest driver list.
     Yedekleme         - backups AND restore. It was on the deleted screen,
                         reachable only by clicking a group head, which for the
                         one screen that can put a lost month back is not a
                         place to keep it.
     Güvenlik denetimi - the data-ownership self check.
     Profilim          - your own name and your own PIN. No permission needed.

   Döviz kurları and Para ve KDV left this file entirely: they are their own
   sidebar group now (screens/para.js). Yazıcılar and İstasyonlar left too -
   screens/fis.js already owned them properly, with the paper preview and the
   print queue beside them, and this file's copy was the third.

   `admin` and `settings` survive as ADDRESSES, not screens: page_admin and
   page_settings redirect, so an old link, an old ?p= and a phone that learned
   the name land on the screen that took the job over.

   Same visual language as the rest of the till: .card, .tbl, .stat, .field,
   .badge, .alert. One accent (orange). Nothing is green - a passing check and
   a failing one are told apart by the words, not by a colour.
   ===================================================================== */
'use strict';

registerIcon('kullanici',
  '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0112 0"/>' +
  '<path d="M17 11.5a3 3 0 100-6"/><path d="M18.5 20a6.5 6.5 0 00-2.2-4.8"/>');
registerIcon('okc',
  '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h4"/>');
/** 2026-09-13 -> 13.09.2026. The screen shows days, never times. */
function demoDay(s) {
  if (!s) return '—';
  const d = String(s).slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]}` : String(s);
}

registerIcon('yedek',
  '<path d="M12 3v10"/><path d="M8 9l4 4 4-4"/><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3"/>');
registerIcon('denetim',
  '<path d="M12 3l7 3v6c0 4.4-3 7.9-7 9-4-1.1-7-4.6-7-9V6z"/><path d="M9.5 12l1.8 1.8 3.4-3.6"/>');
registerIcon('admin',
  '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>');

/* İşletme heads the group and carries its name: the sidebar says Ayarlar, this
   screen's own tab says İşletme. See PAGES in app.js. */
registerPage({ id: 'isletme', label: 'İşletme', icon: 'settings', groupLabel: 'Ayarlar',
  perm: 'settings.manage' }, 'para');
/* user.manage, not settings.manage: it is the permission /api/settings/users
   is guarded with, and a nav entry that opens a 403 is worse than no entry. */
registerPage({ id: 'kullanici', label: 'Kullanıcılar', icon: 'kullanici',
  perm: 'user.manage', group: 'isletme' }, 'isletme');
/*
 * `feature: 'okc'` - registered always, offered only when the restaurant has
 * switched ÖKC on (Ayarlar -> İşletme -> Genel ayarlar).
 *
 * Almost none of these restaurants is legally obliged to cut a mali fiş, and a
 * sidebar entry for a device the owner does not own is a support call waiting
 * to happen. It is a switch and not a deletion because the one customer who
 * later IS obliged must get the whole thing back by ticking a box - the
 * adapters and the GMP3 protocol work never left the tree. See app.js FEATURES.
 */
registerPage({ id: 'okc', label: 'ÖKC', icon: 'okc', feature: 'okc',
  perm: 'settings.manage', group: 'isletme' }, 'kullanici');
registerPage({ id: 'yedek', label: 'Yedekleme', icon: 'yedek',
  perm: 'settings.manage', group: 'isletme' }, 'okc');
registerPage({ id: 'denetim', label: 'Güvenlik denetimi', icon: 'denetim',
  perm: 'settings.manage', group: 'isletme' }, 'yedek');

/* No `perm`: everybody who can sign in can change their own name and their own
   PIN. Until now that needed user.manage, so a cashier had to ask the owner to
   change a PIN their colleague had watched them type. */
registerIcon('profil', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>');
registerPage({ id: 'profil', label: 'Profilim', icon: 'profil', group: 'isletme' }, 'denetim');

/* Hidden, because it is an address and not a screen. It stays in PAGES so that
   go('admin') still resolves to a group, keeps the sidebar highlighted and
   titles the page "Ayarlar" on its way through page_admin's redirect. */
registerPage({ id: 'admin', label: 'Yönetim', icon: 'admin', perm: 'settings.manage',
  hidden: true, group: 'isletme' }, 'isletme');

/* The three states a driver or a check can be in, in the till's own words.
   'ready' is deliberately NOT a green tick: see the ÖKC screen. */
const ADM_STATUS_BADGE = {
  ready: 'badge--closed', beta: 'badge--open', sdk: 'badge--open', planned: 'badge--gray',
  ok: 'badge--closed', note: 'badge--gray', error: 'badge--open', skip: 'badge--gray',
};

/*
 * Where the settings this screen does NOT draw went.
 *
 * The generated form renders whatever /api/settings declares, which is right -
 * a new setting should appear the day it is added, without anybody editing
 * this file. It is also how the fiş genişliği ended up with two controls (here
 * and on Yazıcı ve fiş, which borrows the same key from the same catalogue),
 * the para birimi with two, and the çalışma saatleri with two on this very
 * screen - one in the İşletme form above, one in the generated list below.
 *
 * So the form skips the keys another screen owns, and says out loud where each
 * of them went. Told, not hidden: a setting that silently vanishes from the
 * place somebody last saw it is a support call.
 *
 * Built at draw time rather than at load time because PARA_KEYS belongs to
 * screens/para.js, and a const in another file is not readable until that file
 * has been evaluated.
 */
function ayNotHere() {
  const out = {
    groups: {
      fis: 'Yazıcı ve fiş → Fiş ayarları',
      calisma: 'yukarıdaki İşletme sekmesi',
      yedekleme: 'Yedekleme ekranı',
    },
    keys: { business_day_start: 'yukarıdaki İşletme sekmesi' },
  };
  for (const k of PARA_KEYS) out.keys[k] = 'Para ve KDV ekranı';
  return out;
}

/* Every old tab key of the deleted Yönetim screen, and the screen that took
   the job over. Search rows, saved links and the fiş screen's own "kurlar
   nerede" button all used to name these. */
const ADMIN_MOVED = {
  ayar: 'isletme', isletme: 'isletme', kullanici: 'kullanici',
  yazici: 'fis', okc: 'okc', doviz: 'doviz', denetim: 'denetim',
};

Screens.add({

  /* =================================================================== *
   * İŞLETME - the group head: the company block and the settings form    *
   * =================================================================== */

  _ayTab: 'bilgi',

  async page_isletme(tab) {
    if (tab) this._ayTab = tab;
    const TABS = [['bilgi', 'İşletme bilgileri'], ['genel', 'Genel ayarlar']];
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">İşletme</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">Fişte ve raporlarda görünen işletme bilgileri</span>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px" id="ayTabs">
        ${TABS.map(([id, label]) => `<button class="zone-tab${this._ayTab === id ? ' is-active' : ''}"
          data-t="${id}">${label}</button>`).join('')}
      </div>
      <div id="ayBody"><div class="empty">Yükleniyor…</div></div></div>`;
    const wireTabs = () =>
      $$('#ayTabs [data-t]').forEach(b => b.onclick = () => this.page_isletme(b.dataset.t));
    wireTabs();

    /*
     * The demo tab is added AFTER the page is on screen, never before.
     *
     * Everything above this line has to be synchronous: the router draws its
     * own tab strip into #main around this call, and an `await` before the
     * innerHTML below meant the screen was written over the strip the router
     * had just put there - the ÖKC tab vanished, which is a screen nobody
     * could then reach.
     *
     * The tab itself only exists on a till that HAS demo data. On a customer's
     * machine the word "demo" next to a button that deletes everything is at
     * best confusing and at worst what they press while looking for the
     * backup screen.
     */
    let demo = null;
    try { demo = await api('GET', '/api/settings/demo'); } catch (_) {}
    const showDemo = demo && (demo.seeded || demo.demo_build);
    if (showDemo && $('#ayTabs') && !$('#ayTabs [data-t="demo"]')) {
      $('#ayTabs').insertAdjacentHTML('beforeend',
        `<button class="zone-tab${this._ayTab === 'demo' ? ' is-active' : ''}" data-t="demo">Demo verisi</button>`);
      wireTabs();
    }
    if (this._ayTab === 'demo' && !showDemo) this._ayTab = 'bilgi';

    const draw = { bilgi: () => this.isletmeInfo(), genel: () => this.isletmeGeneral(),
                   demo: () => this.isletmeDemo(demo) };
    try { await draw[this._ayTab](); } catch (e) { err(e); }
  },

  /** Redraw the tab you are on, after a write. */
  ayReload() { return this.page_isletme(this._ayTab); },

  /* ------------------------------------------------------------- demo */
  /**
   * What is in the database, and the button that takes it out again.
   *
   * Two scopes, because after a demonstration people want two different
   * things and only one of them is "start again from nothing":
   *
   *   Hareketler  the seven years of trading go, the menu and the floor plan
   *               and the staff stay. The till is usable the moment it
   *               finishes - this is what somebody handing the machine to a
   *               real restaurant actually wants.
   *   Her şey     back to a blank installation, setup wizard and all.
   *
   * Neither is undoable, so both go past the owner's own password, and the
   * confirmation names the scope rather than asking "are you sure?".
   */
  async isletmeDemo(demo) {
    const d = demo || await api('GET', '/api/settings/demo');
    const span = d.from && d.to ? `${demoDay(d.from)} — ${demoDay(d.to)}` : '—';

    $('#ayBody').innerHTML = `
      <div class="card">
        <div class="card__head"><h3>Demo verisi</h3><div class="spacer"></div>
          ${d.seeded ? '<span class="badge badge--gray">yüklü</span>'
                     : '<span class="badge badge--gray">yok</span>'}</div>
        <div class="card__body">
          ${d.seeded ? `
            <div class="split-3" style="margin-bottom:16px">
              <div class="stat"><div class="stat__label">Adisyon</div>
                <div class="stat__value">${Number(d.orders || 0).toLocaleString('tr-TR')}</div>
                <div class="stat__sub">örnek satış kaydı</div></div>
              <div class="stat"><div class="stat__label">Dönem</div>
                <div class="stat__value" style="font-size:19px">${esc(span)}</div>
                <div class="stat__sub">ilk ve son iş günü</div></div>
              <div class="stat"><div class="stat__label">Yüklenme</div>
                <div class="stat__value" style="font-size:19px">${esc(demoDay(d.seeded_at))}</div>
                <div class="stat__sub">kurulumdaki ilk açılış</div></div>
            </div>
            <p class="muted" style="margin-top:0">
              Bu kurulumdaki satışlar, stok hareketleri, müşteriler ve raporlar
              <b>örnek veridir</b> — gerçek bir restoranın kayıtları değildir.
              Ürünü gösterdikten sonra buradan temizleyin.</p>
            <div class="alert alert--warn" style="margin:14px 0">
              Silme işlemi <b>geri alınamaz</b>. Yedeğiniz varsa yalnızca geri yükleme ile dönebilirsiniz.
            </div>
            <div class="row" style="gap:10px;flex-wrap:wrap">
              <button class="btn btn--danger" data-demo="hareket">Satış ve hareketleri sil</button>
              <button class="btn btn--ghost" data-demo="hepsi">Her şeyi sil (boş kuruluma dön)</button>
            </div>
            <p class="muted" style="font-size:13px;margin-bottom:0;margin-top:12px">
              <b>Satış ve hareketleri sil:</b> adisyonlar, ödemeler, vardiyalar, gün sonları,
              stok hareketleri, sadakat geçmişi ve günlükler silinir; menü, masa düzeni,
              kullanıcılar ve ayarlar kalır — kasa hemen kullanılabilir.<br>
              <b>Her şeyi sil:</b> menü, masalar ve kullanıcılar dahil her şey silinir,
              kurulum sihirbazı yeniden başlar.</p>`
          : `
            <p class="muted" style="margin-top:0">
              Bu kurulumda demo verisi yok. Tanıtım sürümü normalde <b>ilk açılışta</b>
              kendini doldurur; içinde zaten kayıt olan bir veritabanının üstüne yazmaz.
              Bu kasada kayıt olduğu için yükleme yapılmamış.</p>
            <div class="alert alert--error" style="margin:14px 0">
              <b>Demo verisini yüklemek bu kasadaki her şeyi siler:</b> mevcut adisyonlar,
              menü, masalar, kullanıcılar ve ayarlar gider, yerine Kaleiçi Ocakbaşı'nın
              2020–bugün verisi gelir. <b>Geri alınamaz.</b>
            </div>
            <button class="btn btn--primary" id="demoLoad">Demo verisini yükle</button>
            <p class="muted" style="font-size:13px;margin-bottom:0;margin-top:12px">
              Yükleme 1–2 dakika sürer ve bu sırada kasa kullanılamaz.
              Gerçek bir restoranın kasasında <b>kullanmayın</b>.</p>`}
        </div>
      </div>`;

    $$('#ayBody [data-demo]').forEach(b => b.onclick = () => this.demoClear(b.dataset.demo));
    if ($('#demoLoad')) $('#demoLoad').onclick = () => this.demoLoad();
  },

  /**
   * The other direction: put the demo data IN.
   *
   * Same ceremony as deleting it, because it IS deleting it - seeding starts
   * by emptying the tenant, so on a till with anything on it this button
   * destroys exactly as much as the clear button does.
   */
  demoLoad() {
    modal(`
      <div class="modal__head"><h3>Demo verisini yükle</h3></div>
      <div class="modal__body">
        <div class="alert alert--error" style="margin-top:0">
          Bu kasadaki <b>bütün kayıtlar silinecek</b> — adisyonlar, menü, masalar,
          kullanıcılar ve ayarlar dahil. Yerine 2020'den bugüne örnek bir restoranın
          verisi yüklenecek.<br><b>Bu işlem geri alınamaz.</b>
        </div>
        <div class="field"><label>Veriler hangi tarihten başlasın?</label>
          <select class="input" id="demoFrom">
            <option value="2020-01-01">01.01.2020 — yedi yıl (~99.000 adisyon, 1–2 dk)</option>
            <option value="2023-01-01">01.01.2023 — dört yıl (~60.000 adisyon)</option>
            <option value="2025-01-01">01.01.2025 — iki yıl (~30.000 adisyon)</option>
          </select></div>
        <div class="field"><label>Onaylamak için <b>YUKLE</b> yazın</label>
          <input class="input" id="demoWord" autocomplete="off" placeholder="YUKLE"></div>
        <div class="field"><label>Sahip şifresi</label>
          <input class="input" id="demoPass" type="password" autocomplete="off"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="demoGo">Yükle</button>
      </div>`);

    $('#demoGo').onclick = async () => {
      if (($('#demoWord').value || '').trim().toLocaleUpperCase('tr') !== 'YUKLE') {
        return toast('Onaylamak için YUKLE yazın');
      }
      const btn = $('#demoGo');
      btn.disabled = true;
      /* The seed is one long request and the window looks frozen without
         this: a clock is the difference between "working" and "crashed". */
      let secs = 0;
      const tick = setInterval(() => {
        secs++;
        btn.textContent = 'Yükleniyor… ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
      }, 1000);
      btn.textContent = 'Yükleniyor… 0:00';
      try {
        const r = await api('POST', '/api/settings/demo/load',
          { from: $('#demoFrom').value, owner_password: $('#demoPass').value });
        clearInterval(tick);
        closeModal();
        toast(`${Number(r.orders || 0).toLocaleString('tr-TR')} adisyon yüklendi`);
        /* the menu, the staff and the whole session belong to a different
           restaurant now - anything short of a reload is a lie on screen */
        setTimeout(() => location.reload(), 900);
      } catch (e) {
        clearInterval(tick);
        btn.disabled = false; btn.textContent = 'Yükle';
        err(e);
      }
    };
  },

  demoClear(scope) {
    const hepsi = scope === 'hepsi';
    modal(`
      <div class="modal__head"><h3>${hepsi ? 'Her şeyi sil' : 'Satış ve hareketleri sil'}</h3></div>
      <div class="modal__body">
        <div class="alert alert--danger" style="margin-top:0">
          ${hepsi
            ? 'Menü, masalar, kullanıcılar ve bütün satış geçmişi silinecek. Kasa boş bir kuruluma döner ve kurulum sihirbazı yeniden başlar.'
            : 'Bütün adisyonlar, ödemeler, vardiyalar, gün sonları, stok hareketleri ve sadakat geçmişi silinecek. Menü, masa düzeni ve kullanıcılar kalır.'}
          <br><b>Bu işlem geri alınamaz.</b>
        </div>
        <div class="field"><label>Onaylamak için <b>SIL</b> yazın</label>
          <input class="input" id="demoWord" autocomplete="off" placeholder="SIL"></div>
        <div class="field"><label>Sahip şifresi</label>
          <input class="input" id="demoPass" type="password" autocomplete="off"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--danger" id="demoGo">Sil</button>
      </div>`);

    $('#demoGo').onclick = async () => {
      if (($('#demoWord').value || '').trim().toLocaleUpperCase('tr') !== 'SIL') {
        return toast('Onaylamak için SIL yazın');
      }
      const btn = $('#demoGo');
      btn.disabled = true; btn.textContent = 'Siliniyor…';
      try {
        const r = await api('POST', '/api/settings/demo/clear',
          { scope, owner_password: $('#demoPass').value });
        closeModal();
        toast(`${Number(r.rows || 0).toLocaleString('tr-TR')} kayıt silindi`);
        if (hepsi) return setTimeout(() => location.reload(), 700);
        this.ayReload();
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Sil';
        err(e);
      }
    };
  },

  /* =================================================================== *
   * THE OLD ADDRESSES                                                    *
   * =================================================================== *
   *
   * Neither of these draws anything of its own any more, and neither may be
   * quietly deleted: `settings` is in every ?p= a customer ever bookmarked and
   * in the phone app's idea of where the settings are, and `admin` is what
   * seven rows of the search index and one button on the fiş screen named for
   * a whole release. A redirect costs two lines; a blank #main costs a phone
   * call from a restaurant in the middle of service.
   */
  async page_settings() { return go('isletme'); },
  async page_admin(tab) { return go(ADMIN_MOVED[tab] || 'isletme'); },

  /* =================================================================== *
   * DECLARED FIELDS - shared by every screen here that draws one          *
   * =================================================================== */

  /**
   * One field, rendered from its definition. Nothing here knows what
   * `receipt_width` means; it knows it is a number between 24 and 96 because
   * the server said so, which is the same rule the server will validate with.
   */
  ayField(def, value) {
    const id = 'st_' + def.key;
    const help = def.help ? `<div class="muted" style="font-size:12px;margin-top:5px">${esc(def.help)}</div>` : '';

    if (def.type === 'bool') {
      return `<div class="field" data-field="${def.key}">
        <label class="row" style="cursor:pointer;margin:0">
          <input type="checkbox" id="${id}" data-k="${def.key}" data-type="bool" ${String(value) === '1' ? 'checked' : ''}>
          <span style="font-weight:500;color:var(--ink)">${esc(def.label)}</span>
        </label>${help}</div>`;
    }
    if (def.type === 'select') {
      return `<div class="field" data-field="${def.key}"><label>${esc(def.label)}</label>
        <select class="input" id="${id}" data-k="${def.key}" data-type="select">
          ${def.options.map(([code, lbl]) =>
            `<option value="${esc(code)}"${String(value) === String(code) ? ' selected' : ''}>${esc(lbl)}</option>`).join('')}
        </select>${help}</div>`;
    }
    if (def.type === 'password') {
      return `<div class="field" data-field="${def.key}"><label>${esc(def.label)}</label>
        <input class="input" type="password" id="${id}" data-k="${def.key}" data-type="password"
               placeholder="${value ? 'Kayıtlı - değiştirmek için yazın' : 'Tanımlı değil'}">${help}</div>`;
    }
    const type = def.type === 'number' ? 'number' : (def.type === 'time' ? 'time' : 'text');
    const range = def.type === 'number'
      ? `${def.min !== undefined ? ` min="${def.min}"` : ''}${def.max !== undefined ? ` max="${def.max}"` : ''}` : '';
    const ph = def.type === 'hours' ? ' placeholder="09:00-23:00 · kapalı"' : '';
    return `<div class="field" data-field="${def.key}"><label>${esc(def.label)}</label>
      <input class="input" type="${type}"${range}${ph} id="${id}" data-k="${def.key}"
             data-type="${def.type}" value="${esc(value)}">${help}</div>`;
  },

  /** Read every rendered field back out, in the shape the API wants. */
  ayCollect(root = document) {
    const out = {};
    $$('[data-k]', root).forEach(el => {
      const t = el.dataset.type;
      if (t === 'bool') out[el.dataset.k] = el.checked ? '1' : '0';
      else if (t === 'password') { if (el.value) out[el.dataset.k] = el.value; }
      else out[el.dataset.k] = el.value;
    });
    return out;
  },

  /* =================================================================== *
   * İŞLETME BİLGİLERİ                                                    *
   * =================================================================== */

  async isletmeInfo() {
    const b = await api('GET', '/api/settings/business');
    const c = b.client || {}, biz = b.business || {};
    /*
     * The fiş başlığı and fiş altı are NOT on this screen any more - they are
     * on Yazıcı ve fiş, next to the preview rendered at the real paper width,
     * which is the only place a person can tell whether a line will fit. They
     * are still carried in and back out of the save untouched, because
     * saveBusiness writes the whole clients row: a field this form stops
     * sending is a field the server clears, and the first anybody would learn
     * of it is a night of blank-headed receipts.
     */
    this._ayCarry = { receipt_header: c.receipt_header || '', receipt_footer: c.receipt_footer || '' };

    /* The locked fields come off the signed licence. They are shown - the owner
       needs to check them against the receipt - but greyed and disabled, and
       the server ignores them even if the browser sends them anyway. */
    const lock = (f) => b.locked.includes(f)
      ? ' disabled style="background:var(--surface-2);color:var(--ink-3)"' : '';
    const lockNote = (f) => b.locked.includes(f)
      ? '<div class="muted" style="font-size:12px;margin-top:5px">Lisans bilgisidir, buradan değiştirilemez.</div>' : '';

    $('#ayBody').innerHTML = `
      <div id="ayAlert"></div>
      <div class="grid">
        <div class="card"><div class="card__head"><h3>İşletme bilgileri</h3></div><div class="card__body">
          <div class="split-2">
            <div class="field"><label>Firma sahibi</label>
              <input class="input" id="bOwner" value="${esc(c.owner_name || '')}"${lock('owner_name')}>${lockNote('owner_name')}</div>
            <div class="field"><label>İşletme adı</label>
              <input class="input" id="bName" value="${esc(biz.business_name || c.company_name || '')}"></div>
            <div class="field"><label>Ticari unvan</label>
              <input class="input" id="bLegal" value="${esc(biz.legal_name || '')}"></div>
            <div class="field"><label>Telefon</label>
              <input class="input" id="bPhone" value="${esc(c.phone || '')}"></div>
            <div class="field"><label>Vergi numarası</label>
              <input class="input" id="bTax" value="${esc(c.tax_number || '')}"${lock('tax_number')}>${lockNote('tax_number')}</div>
            <div class="field"><label>Vergi dairesi</label>
              <input class="input" id="bOffice" value="${esc(c.tax_office || '')}"${lock('tax_office')}>${lockNote('tax_office')}</div>
          </div>
          <div class="field"><label>Adres</label>
            <input class="input" id="bAddr" value="${esc(c.full_address || '')}"></div>
          <div class="split-3">
            <div class="field"><label>Şehir</label><input class="input" id="bCity" value="${esc(biz.city || '')}"></div>
            <div class="field"><label>Kalıcı e-posta (fatura ve güvenlik)</label>
              <input class="input" id="bPermMail" value="${esc(c.permanent_email || '')}"></div>
            <div class="field"><label>Web sitesi</label><input class="input" id="bWeb" value="${esc(biz.website || '')}"></div>
          </div>
        </div></div>

        <div class="card"><div class="card__head"><h3>İletişim kişisi</h3>
          <div class="spacer"></div><span class="muted" style="font-size:12.5px">Bir sorun olduğunda aranacak kişi</span></div>
          <div class="card__body"><div class="split-3">
            <div class="field"><label>Ad soyad</label><input class="input" id="bcName" value="${esc(c.contact_name || '')}"></div>
            <div class="field"><label>E-posta</label><input class="input" id="bcMail" value="${esc(c.contact_email || '')}"></div>
            <div class="field"><label>Telefon</label><input class="input" id="bcPhone" value="${esc(c.contact_phone || '')}"></div>
          </div></div></div>

        <div class="card"><div class="card__head"><h3>Fiş çıkışı</h3>
          <div class="spacer"></div><span class="muted" style="font-size:12.5px">Hesap fişi hangi istasyondan basılsın</span></div>
          <div class="card__body">
            <div class="field" style="max-width:340px"><label>Fiş istasyonu</label>
              <select class="input" id="bStation">
                <option value="0">Varsayılan fiş yazıcısı</option>
                ${b.stations.map(s => `<option value="${s.id}"${Number(c.receipt_station_id) === s.id ? ' selected' : ''}>
                  ${esc(s.display_name || s.name)}</option>`).join('')}
              </select></div>
            <p class="muted" style="margin:0;font-size:13px">Bu, fişin hangi istasyona düşeceğidir - kağıda ne
              yazacağı değil. Fiş başlığı, fiş altı yazısı, kağıt genişliği ve karekod
              <button class="btn btn--ghost btn--sm" id="bToFis">Yazıcı ve fiş</button> ekranında,
              gerçek genişlikte önizlemenin yanında durur.</p>
          </div></div>

        <div class="card"><div class="card__head"><h3>Çalışma saatleri ve iş günü</h3></div><div class="card__body">
          <p class="muted" style="margin-top:0">Gece yarısını geçen adisyon hangi güne yazılsın? İş günü başlangıcından
            önceki satışlar bir önceki güne sayılır - gece 01:00'de kesilen hesap dünün cirosudur.</p>
          <div class="split-2" style="max-width:520px">
            <div class="field"><label>İş günü başlangıcı</label>
              <input class="input" type="time" id="bDay" value="${esc(b.business_day_start)}"></div>
          </div>
          <table class="tbl" style="max-width:520px">
            <thead><tr><th>Gün</th><th>Saatler</th></tr></thead>
            <tbody>${b.days.map((d, i) => `<tr>
              <td style="width:120px">${esc(d)}</td>
              <td><input class="input" data-h="hours_${i + 1}" value="${esc(b.hours['hours_' + (i + 1)] || '')}"
                     placeholder="09:00-23:00 · kapalı"></td></tr>`).join('')}
            </tbody></table>
        </div></div>

        <div class="card"><div class="card__head"><h3>Para birimi</h3></div><div class="card__body">
          <p class="muted" style="margin:0;font-size:13px">Para birimi, simgesi, kuruş hanesi ve nakit yuvarlama
            <button class="btn btn--ghost btn--sm" id="bToPara">Para ve KDV</button> ekranındadır, döviz kurlarının
            yanında. İkinci bir kutu buraya konsaydı ikisi de "kaydedildi" derdi ve biri kaybolurdu.</p>
        </div></div>

        <div class="row"><div class="spacer"></div>
          <button class="btn btn--primary" id="bSave">Kaydet</button></div>
      </div>`;

    $('#bToFis').onclick = () => go('fis');
    $('#bToPara').onclick = () => go('para');

    $('#bSave').onclick = async () => {
      $('#ayAlert').innerHTML = '';
      const hours = {};
      $$('[data-h]').forEach(i => { hours[i.dataset.h] = i.value; });
      try {
        await api('POST', '/api/settings/business', {
          client: {
            company_name: $('#bName').value, full_address: $('#bAddr').value,
            permanent_email: $('#bPermMail').value, phone: $('#bPhone').value,
            contact_name: $('#bcName').value, contact_email: $('#bcMail').value, contact_phone: $('#bcPhone').value,
            receipt_header: this._ayCarry.receipt_header, receipt_footer: this._ayCarry.receipt_footer,
            receipt_station_id: Number($('#bStation').value) || 0,
          },
          business: {
            business_name: $('#bName').value, legal_name: $('#bLegal').value, city: $('#bCity').value,
            website: $('#bWeb').value, phone: $('#bPhone').value, address_line1: $('#bAddr').value,
          },
          hours,
          business_day_start: $('#bDay').value,
        });
        toast('Kaydedildi', 'ok');
        this.isletmeInfo();
      } catch (e) {
        $('#ayAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`;
      }
    };
  },

  /* =================================================================== *
   * GENEL AYARLAR - generated from the server's definition list          *
   * =================================================================== */

  async isletmeGeneral() {
    const r = await api('GET', '/api/settings');
    const away = ayNotHere();
    const byGroup = {};
    for (const d of r.defs) {
      if (away.groups[d.group] || away.keys[d.key]) continue;
      (byGroup[d.group] = byGroup[d.group] || []).push(d);
    }
    /* Named, not silently dropped: somebody who used to change the fiş
       genişliği here has to be told it moved, and to where. */
    const moved = Array.from(new Set([...Object.values(away.groups), ...Object.values(away.keys)]));

    $('#ayBody').innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <input class="input" id="ayFilter" placeholder="Ayar ara…" style="max-width:280px">
        <div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="ayHist">Değişiklik geçmişi</button>
        <button class="btn btn--primary btn--sm" id="aySave">Tümünü kaydet</button>
      </div>
      <div id="ayAlert"></div>
      <div class="grid" id="ayGroups">
        ${r.groups.filter(g => (byGroup[g.id] || []).length).map(g => `
          <div class="card" data-group="${g.id}">
            <div class="card__head"><h3>${esc(g.label)}</h3>
              <div class="spacer"></div>
              <span class="muted" style="font-size:12.5px">${esc(g.help || '')}</span></div>
            <div class="card__body">
              <div class="split-2">${byGroup[g.id].map(d => this.ayField(d, r.values[d.key])).join('')}</div>
            </div>
          </div>`).join('')}
      </div>
      <p class="muted" style="margin-top:14px;font-size:12.5px">
        Burada olmayan ayarlar kendi ekranlarında durur: ${esc(moved.join(' · '))}.
        Her ayar tek bir ekrandan yazılır; iki ekranda iki kutu olsaydı en son kaydedilen kazanırdı.</p>`;

    /* A search box rather than a second level of navigation: 50 settings is
       too many to scroll and too few to bury in sub-pages. */
    $('#ayFilter').oninput = () => {
      const q = $('#ayFilter').value.trim().toLowerCase();
      $$('#ayGroups [data-field]').forEach(f => {
        const txt = f.textContent.toLowerCase() + ' ' + f.dataset.field;
        f.hidden = !!q && !txt.includes(q);
      });
      $$('#ayGroups [data-group]').forEach(c => {
        c.hidden = !!q && !$$('[data-field]', c).some(f => !f.hidden);
      });
    };

    $('#aySave').onclick = async () => {
      $('#ayAlert').innerHTML = '';
      try {
        await api('POST', '/api/settings', { settings: this.ayCollect($('#ayGroups')) });
        toast('Ayarlar kaydedildi', 'ok');
        /* One of these switches whole areas of the program on and off. Without
           this, an owner who has just ticked "ÖKC ile ödeme açık" sits looking
           at a sidebar that still has no ÖKC in it and rings us. */
        await refreshFeatures();
        this.isletmeGeneral();
      } catch (e) {
        // the server names the offending field in Turkish; show it, do not swallow it
        $('#ayAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`;
      }
    };

    $('#ayHist').onclick = async () => {
      const h = await api('GET', '/api/settings/history?limit=60');
      modal(`<div class="modal__head"><h3>Ayar değişiklikleri</h3>
          <div class="spacer"></div><button class="close-x" onclick="closeModal()">✕</button></div>
        <div class="modal__body">
          ${h.rows.length ? `<table class="tbl">
            <thead><tr><th>Ayar</th><th>Eski</th><th>Yeni</th><th>Kim</th><th>Ne zaman</th></tr></thead>
            <tbody>${h.rows.map(x => `<tr>
              <td class="mono" style="font-size:12.5px">${esc(x.k)}</td>
              <td class="muted">${esc(x.old_value === null ? '—' : x.old_value)}</td>
              <td><b>${esc(x.new_value)}</b></td>
              <td>${esc(x.changed_by_name || '—')}</td>
              <td class="muted">${esc(String(x.created_at).slice(0, 16))}</td></tr>`).join('')}
            </tbody></table>` : '<div class="empty">Henüz değişiklik yok.</div>'}
        </div>`, { wide: true });
    };
  },

  /* =================================================================== *
   * KULLANICILAR                                                         *
   * =================================================================== *
   *
   * Its own screen now. It was a tab of Yönetim AND a tab of the deleted
   * Ayarlar screen, and the two lists were not the same list: the old one
   * offered three hard-coded roles and a wall of raw permission strings, this
   * one asks the server what the roles and the permission groups are. Two user
   * editors over one set of users is how a PIN gets reset twice and locked once.
   */

  async page_kullanici() {
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Kullanıcılar</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">Personel, roller, yetkiler ve kasa PIN'leri</span>
      </div>
      <div id="kuBody"><div class="empty">Yükleniyor…</div></div></div>`;
    try { await this.userList(); } catch (e) { err(e); }
  },

  async userList() {
    const r = await api('GET', '/api/settings/users');
    this._kuPerms = r;

    $('#kuBody').innerHTML = `
      <div class="card">
        <div class="card__head"><h3>Personel</h3>
          <div class="spacer"></div>
          <span class="muted" style="font-size:12.5px">PIN ${r.pin_length} hanelidir</span>
          <button class="btn btn--primary btn--sm" id="uNew">Personel ekle</button></div>
        <table class="tbl">
          <thead><tr><th>Ad soyad</th><th>Kullanıcı adı</th><th>Rol</th><th>Yetki</th><th>Durum</th><th></th></tr></thead>
          <tbody>${r.users.map(u => `<tr>
            <td><b>${esc(u.display_name)}</b>${Number(u.id) === Number(r.me)
              ? ' <span class="badge badge--open">siz</span>' : ''}</td>
            <td class="muted">${esc(u.username || '—')}${u.has_password ? ''
              : ' <span class="badge badge--gray" title="Bu kişi telefon uygulamasına giriş yapamaz. Düzenle ekranından telefon şifresi verin.">telefon şifresi yok</span>'}</td>
            <td>${esc(u.role_label)}</td>
            <td class="muted" style="font-size:12.5px">${u.role === 'admin' || u.role === 'superadmin'
              ? 'Tüm yetkiler' : (u.perms.length ? u.perms.length + ' özel yetki' : 'Rol varsayılanı')}</td>
            <td>${u.is_active
              ? (u.locked ? '<span class="badge badge--open">kilitli</span>'
                          : '<span class="badge badge--closed">aktif</span>')
              : '<span class="badge badge--gray">kapalı</span>'}</td>
            <td class="right" style="white-space:nowrap">
              <button class="btn btn--ghost btn--sm" data-edit="${u.id}">Düzenle</button>
              <button class="btn btn--ghost btn--sm" data-pin="${u.id}">PIN</button>
              <button class="btn btn--ghost btn--sm" data-perm="${u.id}">Yetkiler</button>
              ${u.locked ? `<button class="btn btn--ghost btn--sm" data-unlock="${u.id}">Kilidi aç</button>` : ''}
              <button class="btn btn--ghost btn--sm" data-active="${u.id}" data-to="${u.is_active ? 0 : 1}">
                ${u.is_active ? 'Kapat' : 'Aç'}</button>
              <button class="btn btn--danger btn--sm" data-del="${u.id}">Sil</button>
            </td></tr>`).join('')}
          </tbody></table>
      </div>
      <p class="muted" style="margin-top:12px;font-size:13px">
        Son yönetici hesabı kapatılamaz ve rolü düşürülemez; kimse kendi yönetici yetkisini kaldıramaz.
        Adisyonu olan personel silinmez, kapatılır - eski raporlarda adı görünmeye devam eder.<br>
        Personel hesabı burada anında açılır: kasa buluta bağlı olmadan da çalıştığı için
        e-posta ile aktivasyon adımı yoktur. Herkes kendi adını ve PIN'ini Profilim ekranından değiştirebilir.</p>`;

    const find = (id) => r.users.find(u => Number(u.id) === Number(id));
    $('#uNew').onclick = () => this.userForm({});
    $$('[data-edit]').forEach(b => b.onclick = () => this.userForm(find(b.dataset.edit)));
    $$('[data-pin]').forEach(b => b.onclick = () => this.userPinForm(find(b.dataset.pin), r.pin_length));
    $$('[data-perm]').forEach(b => b.onclick = () => this.userPermForm(find(b.dataset.perm)));
    $$('[data-unlock]').forEach(b => b.onclick = async () => {
      try { await api('POST', `/api/settings/users/${b.dataset.unlock}/unlock`); toast('Kilit açıldı', 'ok'); this.userList(); }
      catch (e) { err(e); }
    });
    $$('[data-active]').forEach(b => b.onclick = async () => {
      try {
        await api('POST', `/api/settings/users/${b.dataset.active}/active`, { active: b.dataset.to === '1' });
        toast('Güncellendi', 'ok'); this.userList();
      } catch (e) { err(e); }     // "son yönetici..." lands here, in the owner's own words
    });
    $$('[data-del]').forEach(b => b.onclick = async () => {
      const u = find(b.dataset.del);
      if (!await confirmBox(`${u.display_name} silinsin mi?`,
        'Adisyonu olan personel silinmez, hesabı kapatılır.')) return;
      try {
        const out = await api('DELETE', `/api/settings/users/${u.id}`);
        toast(out.message, 'ok'); this.userList();
      } catch (e) { err(e); }
    });
  },

  userForm(u) {
    const R = this._kuPerms;
    modal(`<div class="modal__head"><h3>${u.id ? esc(u.display_name) : 'Yeni personel'}</h3>
        <div class="spacer"></div><button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div id="ufAlert"></div>
        <div class="split-2">
          <div class="field"><label>Ad soyad</label><input class="input" id="ufName" value="${esc(u.display_name || '')}"></div>
          <div class="field"><label>Kullanıcı adı</label><input class="input" id="ufUser" value="${esc(u.username || '')}"></div>
          <div class="field"><label>E-posta</label><input class="input" id="ufMail" value="${esc(u.email || '')}"></div>
          <div class="field"><label>Rol</label><select class="input" id="ufRole">
            ${R.roles.filter(x => x.key !== 'superadmin' || u.role === 'superadmin')
              .map(x => `<option value="${x.key}"${u.role === x.key ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
          </select></div>
          <div class="field"><label>Kasa PIN${u.id ? ' (boş = değişmez)' : ` (${R.pin_length} hane)`}</label>
            <input class="input" id="ufPin" type="password" inputmode="numeric" autocomplete="new-password"></div>
          <div class="field"><label>Telefon şifresi${u.id ? ' (boş = değişmez)' : ' (isteğe bağlı)'}</label>
            <input class="input" id="ufPw" type="password" autocomplete="new-password"></div>
        </div>
        <p class="muted" style="font-size:12.5px;margin-bottom:0">Yönetici rolü tüm yetkileri kapsar.
          Kasiyer ve garsonun yetkileri "Yetkiler" düğmesinden ayrıca ayarlanır.</p>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="ufOk">Kaydet</button></div>`);
    $('#ufOk').onclick = async () => {
      try {
        await api('POST', '/api/settings/users', {
          id: u.id, display_name: $('#ufName').value, username: $('#ufUser').value,
          email: $('#ufMail').value || undefined, role: $('#ufRole').value,
          pin: $('#ufPin').value || undefined, password: $('#ufPw').value || undefined,
        });
        closeModal(); toast('Kaydedildi', 'ok'); this.userList();
      } catch (e) { $('#ufAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /** A PIN reset is its own small dialog: it is the one thing a manager does
   *  in a hurry, in the middle of service, for somebody standing next to them. */
  userPinForm(u, len) {
    modal(`<div class="modal__head"><h3>${esc(u.display_name)} - kasa PIN'i</h3></div>
      <div class="modal__body">
        <div id="pnAlert"></div>
        <p class="muted" style="margin-top:0">Yeni PIN kaydedilir kaydedilmez eski PIN çalışmaz.
          Hatalı deneme sayacı ve kilit de sıfırlanır.</p>
        <div class="field" style="max-width:220px"><label>Yeni PIN (${len} hane)</label>
          <input class="input" id="pnVal" type="password" inputmode="numeric" maxlength="${len}"
                 autocomplete="new-password" style="letter-spacing:6px;font-size:20px;text-align:center"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="pnOk">PIN'i değiştir</button></div>`);
    $('#pnVal').focus();
    $('#pnOk').onclick = async () => {
      try {
        const out = await api('POST', `/api/settings/users/${u.id}/pin`, { pin: $('#pnVal').value });
        closeModal(); toast(out.message, 'ok'); this.userList();
      } catch (e) { $('#pnAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
    $('#pnVal').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pnOk').click(); });
  },

  userPermForm(u) {
    const R = this._kuPerms;
    const isAdmin = u.role === 'admin' || u.role === 'superadmin';
    const held = new Set(u.perms.length ? u.perms : u.effective);
    modal(`<div class="modal__head"><h3>${esc(u.display_name)} - yetkiler</h3>
        <div class="spacer"></div><span class="badge badge--gray">${esc(u.role_label)}</span></div>
      <div class="modal__body">
        <div id="pfAlert"></div>
        ${isAdmin ? `<div class="alert alert--info">Yönetici rolü zaten tüm yetkileri kapsar.
          Yetki kısıtlamak için önce rolü Kasiyer veya Garson yapın.</div>` : ''}
        ${R.groups.map(g => `
          <div style="margin-bottom:16px">
            <div class="row" style="margin-bottom:8px">
              <b style="font-size:13px">${esc(g.label)}</b><div class="spacer"></div>
              <button class="btn btn--ghost btn--sm" data-all="${g.id}">Tümü</button>
              <button class="btn btn--ghost btn--sm" data-none="${g.id}">Hiçbiri</button></div>
            <div data-g="${g.id}" style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px">
              ${g.keys.map(k => `<label class="row" style="font-size:13px;cursor:pointer">
                <input type="checkbox" data-p="${k}" ${held.has(k) ? 'checked' : ''} ${isAdmin ? 'disabled' : ''}>
                <span>${esc((R.permissions.find(p => p.key === k) || {}).label || k)}</span></label>`).join('')}
            </div></div>`).join('')}
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="pfOk"${isAdmin ? ' disabled' : ''}>Kaydet</button></div>`, { wide: true });

    $$('[data-all]').forEach(b => b.onclick = () =>
      $$(`[data-g="${b.dataset.all}"] [data-p]`).forEach(c => { if (!c.disabled) c.checked = true; }));
    $$('[data-none]').forEach(b => b.onclick = () =>
      $$(`[data-g="${b.dataset.none}"] [data-p]`).forEach(c => { if (!c.disabled) c.checked = false; }));

    $('#pfOk').onclick = async () => {
      try {
        await api('POST', `/api/settings/users/${u.id}/permissions`,
          { perms: $$('#modal [data-p]').filter(c => c.checked).map(c => c.dataset.p) });
        closeModal(); toast('Yetkiler kaydedildi', 'ok'); this.userList();
      } catch (e) { $('#pfAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /* =================================================================== *
   * ÖKC                                                                  *
   * =================================================================== */

  /**
   * The honest ÖKC screen.
   *
   * Only the simulator really works end to end, and Token is written but has
   * never been confirmed against a terminal; the rest are the shared GMP-3
   * client with default field names, and two providers do not exist at all.
   * The old screen listed them all identically in one dropdown. This one
   * prints the status next to every name, refuses "Gerçek" for anything
   * unfinished, and repeats the warning the API sends back after a save -
   * a restaurant should never discover the difference at the till.
   */
  async page_okc() {
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">ÖKC</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">Yeni Nesil yazarkasa cihazları ve kasalar</span>
      </div>
      <div id="okBody"><div class="empty">Yükleniyor…</div></div></div>`;
    try { await this.okcDraw(); } catch (e) { err(e); }
  },

  async okcDraw() {
    const r = await api('GET', '/api/settings/okc');
    this._okc = r;
    const label = (p) => `<span class="badge ${ADM_STATUS_BADGE[p.status] || 'badge--gray'}">${esc(p.status_label)}</span>`;

    $('#okBody').innerHTML = `
      <div class="grid">
        ${r.devices.length ? '' : `<div class="alert alert--info">Tanımlı ÖKC yok. Gerçek cihazınız yoksa
          simülatörle tüm ödeme akışını deneyebilirsiniz - simülatör mali fiş kesmez.</div>`}

        <div class="card">
          <div class="card__head"><h3>Cihazlar</h3>
            <div class="spacer"></div>
            <span class="muted" style="font-size:12.5px">ÖKC ile ödeme: ${r.fiscal_enabled ? 'açık' : 'kapalı'}</span>
            <button class="btn btn--ghost btn--sm" id="okSim">Simülatör kur</button>
            <button class="btn btn--primary btn--sm" id="okNew">Cihaz ekle</button></div>
          <table class="tbl">
            <thead><tr><th>Marka</th><th>Model / seri</th><th>Adres</th><th>Kasa</th><th>Ortam</th>
              <th>Sürücü</th><th>Durum</th><th></th></tr></thead>
            <tbody>${r.devices.map(d => `<tr>
              <td><b>${esc(d.provider_label)}</b>${d.is_active ? '' : ' <span class="badge badge--gray">kapalı</span>'}</td>
              <td>${esc(d.device_model || '—')}<div class="muted mono" style="font-size:12px">${esc(d.serial_number || '')}</div></td>
              <td class="mono">${esc((d.device_ip || '—') + (d.device_port ? ':' + d.device_port : ''))}</td>
              <td>${esc(d.register_name || '—')}</td>
              <td>${esc({ production: 'Gerçek', test: 'Test', simulator: 'Simülatör' }[d.environment] || d.environment)}</td>
              <td><span class="badge ${ADM_STATUS_BADGE[d.provider_status] || 'badge--gray'}">${esc(d.provider_status_label)}</span></td>
              <td>${esc(d.status || 'bilinmiyor')}<div class="muted" style="font-size:12px">${
                esc(d.last_seen_at ? String(d.last_seen_at).slice(5, 16) : 'hiç bağlanılmadı')}</div></td>
              <td class="right" style="white-space:nowrap">
                <button class="btn btn--ghost btn--sm" data-otest="${d.id}">Bağlantıyı dene</button>
                <button class="btn btn--ghost btn--sm" data-oedit="${d.id}">Düzenle</button>
                <button class="btn btn--ghost btn--sm" data-oact="${d.id}" data-to="${d.is_active ? 0 : 1}">
                  ${d.is_active ? 'Kapat' : 'Aç'}</button>
                <button class="btn btn--danger btn--sm" data-odel="${d.id}">Sil</button>
              </td></tr>`).join('') || '<tr><td colspan="8" class="muted">Cihaz yok.</td></tr>'}
            </tbody></table>
          ${r.devices.some(d => d.provider_status !== 'ready') ? `<div class="card__body">
            <div class="alert alert--warn" style="margin:0">Listede sürücüsü doğrulanmamış cihaz var.
              Bağlantı testi geçse bile mali fiş akışının çalışacağı garanti değildir; satışa açmadan önce
              tek bir düşük tutarlı işlemle deneyin.</div></div>` : ''}
        </div>

        <div class="card">
          <div class="card__head"><h3>Kasalar</h3><div class="spacer"></div>
            <button class="btn btn--ghost btn--sm" id="okReg">Kasa ekle</button></div>
          <table class="tbl"><thead><tr><th>Ad</th><th>Kod</th><th>Cihaz</th><th>Durum</th></tr></thead>
            <tbody>${r.registers.map(x => `<tr><td><b>${esc(x.name)}</b></td>
              <td class="mono">${esc(x.code)}</td><td>${x.device_count || 0}</td>
              <td>${x.is_active ? '<span class="badge badge--closed">aktif</span>'
                : '<span class="badge badge--gray">kapalı</span>'}</td></tr>`).join('')
              || '<tr><td colspan="4" class="muted">Kasa tanımlanmamış. Tek kasalı işletmede gerekmez.</td></tr>'}
            </tbody></table>
        </div>

        <div class="card">
          <div class="card__head"><h3>Desteklenen markalar</h3>
            <div class="spacer"></div>
            <span class="muted" style="font-size:12.5px">Ne çalışıyor, ne çalışmıyor - olduğu gibi</span></div>
          <table class="tbl"><thead><tr><th>Marka</th><th>Sürücü durumu</th><th>Açıklama</th><th>Gerçek ortam</th></tr></thead>
            <tbody>${r.providers.map(p => `<tr>
              <td><b>${esc(p.label)}</b></td>
              <td>${label(p)}</td>
              <td class="muted" style="font-size:13px">${esc(p.note)}</td>
              <td>${p.allows_production ? 'Seçilebilir' : '<span class="muted">Hayır</span>'}</td>
            </tr>`).join('')}
            </tbody></table>
          <div class="card__body"><p class="muted" style="margin:0;font-size:13px">
            <b>Çalışıyor</b>: uçtan uca denendi. <b>Deneme</b>: protokol yazıldı, üreticinin alan adları
            gerçek cihazda doğrulanmadı. <b>SDK gerekli</b>: genel GMP-3 istemcisi bağlı, üreticinin
            entegrasyon dokümanı olmadan tamamlanamaz. <b>Planlandı</b>: henüz yazılmadı, seçilemez.</p></div>
        </div>
      </div>`;

    $('#okSim').onclick = async () => {
      try { const o = await api('POST', '/api/settings/okc/quick-simulator');
        toast(o.message, 'ok'); this.okcDraw(); } catch (e) { err(e); }
    };
    $('#okNew').onclick = () => this.okcDeviceForm({}, r);
    $$('[data-oedit]').forEach(b => b.onclick = () =>
      this.okcDeviceForm(r.devices.find(d => Number(d.id) === Number(b.dataset.oedit)), r));
    $$('[data-oact]').forEach(b => b.onclick = async () => {
      try { await api('POST', `/api/settings/okc/devices/${b.dataset.oact}/active`, { active: b.dataset.to === '1' });
        this.okcDraw(); } catch (e) { err(e); }
    });
    $$('[data-odel]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('Cihaz silinsin mi?', 'Bu cihazla işlem yapıldıysa silinmez, kapatılır.')) return;
      try { const o = await api('DELETE', `/api/settings/okc/devices/${b.dataset.odel}`);
        toast(o.message, 'ok'); this.okcDraw(); } catch (e) { err(e); }
    });
    $$('[data-otest]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Deneniyor…';
      try {
        const out = await api('POST', `/api/settings/okc/devices/${b.dataset.otest}/test`);
        modal(`<div class="modal__head"><h3>${out.connected ? 'Cihaz yanıt verdi' : 'Cihaza ulaşılamadı'}</h3></div>
          <div class="modal__body">
            <div class="alert ${out.connected ? 'alert--info' : 'alert--error'}">${esc(out.message)}</div>
            ${out.state ? `<p class="muted">Cihaz durumu: <b>${esc(out.state)}</b></p>` : ''}
            ${out.device ? `<pre class="mono muted" style="font-size:12px;white-space:pre-wrap">${
              esc(JSON.stringify(out.device))}</pre>` : ''}
          </div>
          <div class="modal__foot"><button class="btn btn--primary" onclick="closeModal()">Tamam</button></div>`);
        this.okcDraw();
      } catch (e) { err(e); }
      finally { b.disabled = false; b.textContent = 'Bağlantıyı dene'; }
    });
    $('#okReg').onclick = () => {
      modal(`<div class="modal__head"><h3>Kasa ekle</h3></div>
        <div class="modal__body"><div id="rgAlert"></div><div class="split-2">
          <div class="field"><label>Ad</label><input class="input" id="rgName" value="Kasa 1"></div>
          <div class="field"><label>Kod</label><input class="input mono" id="rgCode" value="KASA1"></div>
        </div></div>
        <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
          <button class="btn btn--primary" id="rgOk">Kaydet</button></div>`);
      $('#rgOk').onclick = async () => {
        try { await api('POST', '/api/settings/okc/registers', { name: $('#rgName').value, code: $('#rgCode').value });
          closeModal(); this.okcDraw(); }
        catch (e) { $('#rgAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
      };
    };
  },

  okcDeviceForm(d, ctx) {
    d = d || {};
    const selectable = ctx.providers.filter(p => p.selectable);
    modal(`<div class="modal__head"><h3>${d.id ? 'ÖKC cihazı' : 'ÖKC cihazı ekle'}</h3></div>
      <div class="modal__body">
        <div id="dfAlert"></div>
        <div class="split-2">
          <div class="field"><label>Marka</label><select class="input" id="dfProv">
            ${selectable.map(p => `<option value="${p.key}"${d.provider === p.key ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
          </select></div>
          <div class="field"><label>Ortam</label><select class="input" id="dfEnv">
            <option value="simulator"${d.environment === 'simulator' ? ' selected' : ''}>Simülatör</option>
            <option value="test"${d.environment === 'test' ? ' selected' : ''}>Test</option>
            <option value="production"${d.environment === 'production' ? ' selected' : ''}>Gerçek</option>
          </select></div>
          <div class="field"><label>Model</label><input class="input" id="dfModel" value="${esc(d.device_model || '')}"></div>
          <div class="field"><label>Seri no</label><input class="input mono" id="dfSerial" value="${esc(d.serial_number || '')}"></div>
          <div class="field"><label>Cihaz IP</label><input class="input mono" id="dfIp" value="${esc(d.device_ip || '')}" placeholder="192.168.1.60"></div>
          <div class="field"><label>Port</label><input class="input" type="number" id="dfPort" value="${esc(d.device_port || '')}"></div>
          <div class="field"><label>Üye işyeri no</label><input class="input" id="dfMerchant" value="${esc(d.merchant_id || '')}"></div>
          <div class="field"><label>Terminal no</label><input class="input" id="dfTerm" value="${esc(d.terminal_id || '')}"></div>
          <div class="field"><label>Kasa</label><select class="input" id="dfReg">
            <option value="">—</option>
            ${ctx.registers.map(x => `<option value="${x.id}"${Number(d.cash_register_id) === x.id ? ' selected' : ''}>
              ${esc(x.name)}</option>`).join('')}
          </select></div>
        </div>
        <div id="dfNote"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="dfOk">Kaydet</button></div>`, { wide: true });

    /* The note under the form changes with the brand, so the honest status is
       in front of the person at the moment they choose - not in a table they
       already scrolled past. */
    const note = () => {
      const p = ctx.providers.find(x => x.key === $('#dfProv').value) || {};
      const kind = p.status === 'ready' ? 'alert--info' : 'alert--warn';
      $('#dfNote').innerHTML = `<div class="alert ${kind}"><b>${esc(p.status_label || '')}</b> — ${esc(p.note || '')}</div>`;
      const env = $('#dfEnv');
      // "Gerçek" is disabled rather than hidden: the reason has to be visible
      Array.from(env.options).forEach(o => {
        o.disabled = (o.value === 'production' && !p.allows_production) ||
                     (o.value === 'production' && p.key === 'simulator');
      });
      if (env.selectedOptions[0] && env.selectedOptions[0].disabled) env.value = 'test';
      if (p.defaultPort && !$('#dfPort').value) $('#dfPort').value = p.defaultPort;
    };
    $('#dfProv').onchange = note; note();

    $('#dfOk').onclick = async () => {
      try {
        const out = await api('POST', '/api/settings/okc/devices', {
          id: d.id, provider: $('#dfProv').value, environment: $('#dfEnv').value,
          device_model: $('#dfModel').value, serial_number: $('#dfSerial').value,
          device_ip: $('#dfIp').value, device_port: $('#dfPort').value ? Number($('#dfPort').value) : null,
          merchant_id: $('#dfMerchant').value, terminal_id: $('#dfTerm').value,
          cash_register_id: $('#dfReg').value ? Number($('#dfReg').value) : null,
        });
        closeModal();
        /* Saved is not the same as working. Every warning the API returned is
           put in front of the owner before the screen redraws. */
        if (out.warnings && out.warnings.length) {
          modal(`<div class="modal__head"><h3>Cihaz kaydedildi - dikkat</h3></div>
            <div class="modal__body">${out.warnings.map(w => `<div class="alert alert--warn">${esc(w)}</div>`).join('')}</div>
            <div class="modal__foot"><button class="btn btn--primary" onclick="closeModal()">Anladım</button></div>`);
        } else toast('Cihaz kaydedildi', 'ok');
        this.okcDraw();
      } catch (e) { $('#dfAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /* =================================================================== *
   * YEDEKLEME VE GERİ YÜKLEME                                            *
   * =================================================================== *
   *
   * This was the last tab of the deleted screen, which means it was reachable
   * only by clicking a sidebar group head - and geri yükleme, the one action
   * in the whole program that can put a lost month back or destroy a good one,
   * has no business living somewhere you have to already know about. It is a
   * screen in the sidebar now, and it carries its own settings too: the person
   * asking "how often is this backed up" is standing in front of the list of
   * backups, not hunting through a generated form two screens away.
   */

  async page_yedek() {
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Yedekleme</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">Yedek alma, buluta yükleme ve geri yükleme</span>
      </div>
      <div id="ykBody"><div class="empty">Yükleniyor…</div></div></div>`;
    try { await this.yedekDraw(); } catch (e) { err(e); }
  },

  async yedekDraw() {
    const r = await api('GET', '/api/manage/backups');
    const st = await api('GET', '/api/settings');
    /*
     * The restore half is fetched separately and is allowed to fail.
     * It is owner-only, and this screen is also opened by a manager who may
     * take a backup and must never be offered the button that erases the
     * month - so a 403 here is a normal answer, not a broken screen.
     */
    let gz = null, gzErr = null;
    try { gz = await api('GET', '/api/manage/restore/sources'); }
    catch (e) { gzErr = e.message; }
    const srcs = (gz && gz.sources) || [];
    const localByFile = new Map(srcs.filter(s => s.kind === 'local').map(s => [s.file, s]));
    const cloud = srcs.filter(s => s.kind === 'cloud');
    const baseName = (p) => String(p || '').split(/[\\/]/).pop();
    const mb = (n) => (Number(n || 0) / 1048576).toFixed(1) + ' MB';
    const defs = st.defs.filter(d => d.group === 'yedekleme');

    $('#ykBody').innerHTML = `
      <div id="ykAlert"></div>
      <div class="grid">
        <div class="card">
          <div class="card__head"><h3>Yedekler</h3><div class="spacer"></div>
            <button class="btn btn--ghost btn--sm" id="bkNow">Şimdi yedekle</button>
            <button class="btn btn--primary btn--sm" id="bkUp">Buluta yükle</button></div>
          <div class="card__body" style="padding-bottom:0">
            <p class="muted" style="margin-top:0">Bu bilgisayara düzenli olarak, her gece de sunucumuza
              yedek alınır. Sıklığı ve kaç gün saklanacağı aşağıdadır.</p></div>
          <table class="tbl"><thead><tr><th>Tür</th><th>Boyut</th><th>Durum</th><th>Tarih</th><th></th></tr></thead>
            <tbody>${r.backups.map(b => {
              const f = baseName(b.file_path);
              const s = localByFile.get(f);
              const cell = !gz ? ''
                : (s && s.usable ? `<button class="btn btn--ghost btn--sm" data-gz="${esc(f)}">Geri yükle</button>`
                  : `<span class="muted" style="font-size:12px">${esc(s ? (s.note || 'kullanılamaz') : 'dosya yok')}</span>`);
              return `<tr><td>${esc(b.kind)}</td>
              <td class="mono">${mb(b.size_bytes)}</td>
              <td><span class="badge ${b.status === 'ok' ? 'badge--closed' : 'badge--gray'}">${esc(b.status)}</span></td>
              <td class="muted">${esc((b.created_at || '').slice(0, 16))}</td>
              <td class="right">${cell}</td></tr>`;
            }).join('') || '<tr><td colspan="5" class="muted">Henüz yedek alınmamış.</td></tr>'}
            </tbody></table>
        </div>

        <div class="card">
          <div class="card__head"><h3>Buluttan geri yükle</h3></div>
          <div class="card__body">
            <p class="muted" style="margin-top:0">Sunucumuzdaki gece yedekleri. Önce bu bilgisayara indirilir,
              sonra yukarıdaki listeden geri yüklenir. Bilgisayarınız değiştiyse veya diskiniz bozulduysa
              verinizin buradaki kopyası durur.</p>
            ${gzErr ? `<div class="alert alert--warn">${esc(gzErr)}</div>` : ''}
            ${gz && !gz.cloud_ok ? `<div class="alert alert--warn">${esc(gz.cloud_error || 'Sunucudaki yedekler listelenemedi.')}</div>` : ''}
            ${cloud.length ? `<table class="tbl"><thead><tr><th>Dosya</th><th>Boyut</th><th>Tarih</th><th></th></tr></thead>
              <tbody>${cloud.map(c => `<tr>
                <td class="mono" style="font-size:12px">${esc(c.file || '')}</td>
                <td class="mono">${mb(c.size_bytes)}</td>
                <td class="muted">${esc(String(c.created_at || '').slice(0, 16))}</td>
                <td class="right"><button class="btn btn--ghost btn--sm" data-gzdl="${esc(String(c.id))}">İndir</button></td>
              </tr>`).join('')}</tbody></table>`
              : (gz && gz.cloud_ok ? '<p class="muted">Sunucuda bu kasaya ait yedek yok.</p>' : '')}
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Yedekleme ayarları</h3><div class="spacer"></div>
            <button class="btn btn--primary btn--sm" id="ykSave">Kaydet</button></div>
          <div class="card__body">
            <div class="split-2">${defs.map(d => this.ayField(d, st.values[d.key])).join('')}</div>
          </div>
        </div>
      </div>`;

    $('#bkNow').onclick = async () => {
      try { await api('POST', '/api/manage/backups/run'); toast('Yedek alındı', 'ok'); this.yedekDraw(); }
      catch (e) { err(e); }
    };
    $('#bkUp').onclick = async () => {
      try { await api('POST', '/api/manage/backups/upload'); toast('Buluta yüklendi', 'ok'); this.yedekDraw(); }
      catch (e) { err(e); }
    };
    $('#ykSave').onclick = async () => {
      $('#ykAlert').innerHTML = '';
      try {
        await api('POST', '/api/settings', { settings: this.ayCollect($('#ykBody')) });
        toast('Ayarlar kaydedildi', 'ok'); this.yedekDraw();
      } catch (e) { $('#ykAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };

    $$('[data-gzdl]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'İndiriliyor…';
      try { const d = await api('POST', '/api/manage/restore/cloud-fetch', { id: b.dataset.gzdl });
        toast(d.file + ' indirildi', 'ok'); this.yedekDraw();
      } catch (e) { b.disabled = false; b.textContent = 'İndir'; err(e); }
    });

    /*
     * The confirm dialog is two steps in one window, and the order is the
     * point: the dump is opened and read FIRST, and what it turned out to
     * contain is on the screen before the button that destroys the current
     * database can be pressed. Somebody about to overwrite a month of trade
     * should see which restaurant, which day and how many bills they are about
     * to get - not only what they are about to lose.
     */
    $$('[data-gz]').forEach(b => b.onclick = async () => {
      const file = b.dataset.gz;
      modal(`<div class="modal__head"><h3>Geri yükle</h3></div>
        <div class="modal__body"><p class="muted" id="gzBody">Yedek inceleniyor, veriler okunuyor…</p></div>
        <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button></div>`);
      let p;
      try { p = (await api('POST', '/api/manage/restore/preview', { file })).preview; }
      catch (e) { $('#gzBody').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; return; }

      const rows = [
        ['İşletme', (p.company_name || '-') + (p.client_id ? ' (müşteri no ' + p.client_id + ')' : '')],
        ['Yedeğin tarihi', p.file_date || '-'],
        ['Yedekteki son adisyon', p.last_order_at || '-'],
        ['Adisyon', String(p.counts.orders != null ? p.counts.orders : '-')],
        ['Ürün', String(p.counts.products != null ? p.counts.products : '-')],
        ['Kullanıcı', String(p.counts.users != null ? p.counts.users : '-')],
        ['Program sürümü', p.app_version || 'belirtilmemiş'],
        ['Dosya', file],
      ];
      modal(`<div class="modal__head"><h3>Geri yükle</h3></div>
        <div class="modal__body">
          <div class="alert alert--error"><b>Bu işlem geri alınamaz.</b><br>
            ${esc(p.file_date || '')} tarihli yedeğe dönülür. <b>O tarihten sonra girilen her şey silinir:</b>
            adisyonlar, ödemeler, gün sonu kayıtları, ürün ve fiyat değişiklikleri, kullanıcılar ve yetkiler.
            İşlem başlamadan önce bugünkü verinin yedeği otomatik alınır ve saklanır; gerekirse ondan dönebilirsiniz.</div>
          <table class="tbl"><tbody>${rows.map(([k, v]) =>
            `<tr><td class="muted" style="width:45%">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</tbody></table>
          ${p.usable ? '' : `<div class="alert alert--error" style="margin-top:14px">
            ${p.problems.map(x => esc(x)).join('<br>')}</div>`}
          ${p.usable ? `<div class="field" style="margin-top:14px">
            <label>Devam etmek için işletme sahibi şifrenizi girin</label>
            <input class="input" id="gzPw" type="password" autocomplete="off"></div>` : ''}
          <div id="gzAlert"></div>
        </div>
        <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
          ${p.usable ? '<button class="btn btn--danger" id="gzGo" disabled>Geri yükle</button>' : ''}</div>`);
      if (!p.usable) return;
      /* The button stays dead until the password box has something in it: the
         dialog is one click from a screen a manager may already be standing on. */
      const pw = $('#gzPw'), run = $('#gzGo');
      pw.addEventListener('input', () => { run.disabled = !pw.value; });
      run.onclick = async () => {
        run.disabled = true; run.textContent = 'Geri yükleniyor…';
        try {
          await api('POST', '/api/manage/restore/run', { file, password: pw.value });
          closeModal();
          toast('Geri yükleme tamamlandı', 'ok');
          setTimeout(() => location.reload(), 1500);
        } catch (e) {
          run.disabled = false; run.textContent = 'Geri yükle';
          $('#gzAlert').innerHTML = `<div class="alert alert--error" style="margin-top:14px">${esc(e.message)}</div>`;
        }
      };
    });
  },

  /* =================================================================== *
   * GÜVENLİK DENETİMİ                                                    *
   * =================================================================== */

  async page_denetim() {
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Güvenlik denetimi</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">Her satır hangi işletmeye ait, kontrol edilir</span>
      </div>
      <div id="dnBody"><div class="empty">Yükleniyor…</div></div></div>`;
    try { await this.denetimDraw(); } catch (e) { err(e); }
  },

  async denetimDraw() {
    const r = await api('GET', '/api/settings/self-check');
    const badge = (lvl) => ({ ok: ['badge--closed', 'temiz'], note: ['badge--gray', 'bilgi'],
      error: ['badge--open', 'sorun'], skip: ['badge--gray', 'atlandı'] })[lvl] || ['badge--gray', lvl];

    $('#dnBody').innerHTML = `
      <div class="grid">
        <div class="${r.all_clean ? 'alert alert--ok' : 'alert alert--error'}">
          ${r.all_clean
            ? `Bu kurulumda sahipsiz veri bulunmadı. İşletme kimliği: ${esc(r.client_id)}.`
            : `${r.errors} kontrol sorun buldu. Aşağıdaki satırlar düzeltilmeden yedek alınmamalı.`}
        </div>
        <div class="card">
          <div class="card__head"><h3>Veri sahipliği kontrolü</h3>
            <div class="spacer"></div>
            <button class="btn btn--ghost btn--sm" id="ckAgain">Yeniden çalıştır</button></div>
          <div class="card__body" style="padding-bottom:0"><p class="muted" style="margin-top:0">
            Her satırın hangi işletmeye ait olduğu kontrol edilir. İşletme kimliği boş olan satır
            bir hatadır - her işletme onu görür. Başka bir işletmeye ait satırlar yalnızca bilgidir;
            sizin verinize karışmazlar.</p></div>
          <table class="tbl">
            <thead><tr><th>Tablo</th><th>Sonuç</th><th>Açıklama</th></tr></thead>
            <tbody>${r.checks.map(c => {
              const [cls, txt] = badge(c.level);
              return `<tr><td class="mono">${esc(c.table)}</td>
                <td><span class="badge ${cls}">${txt}</span></td>
                <td class="muted">${esc(c.message)}</td></tr>`;
            }).join('')}
            </tbody></table>
        </div>
      </div>`;
    $('#ckAgain').onclick = () => this.denetimDraw();
  },

  /* =================================================================== *
   * PROFİLİM - the only page here that needs no permission               *
   * =================================================================== */

  /**
   * Your own account. Three small forms, each asking for the credential it is
   * about to replace, because the till stands unlocked on a counter and a PIN
   * change nobody authorised is a PIN change nobody can undo.
   */
  async page_profil() {
    $('#main').innerHTML = `<div class="page is-on">
      <h2 class="page-title">Profilim</h2>
      <div id="prBody"><div class="empty">Yükleniyor…</div></div></div>`;
    try { await this.profilDraw(); } catch (e) { err(e); }
  },

  async profilDraw() {
    const r = await api('GET', '/api/settings/profile');
    const u = r.user;
    $('#prBody').innerHTML = `
      <div class="grid" style="max-width:840px">
        <div class="card"><div class="card__head"><h3>Hesabım</h3>
          <div class="spacer"></div><span class="badge badge--gray">${esc(u.role_label)}</span></div>
          <div class="card__body">
            <div id="prAlert"></div>
            <div class="split-2">
              <div class="field"><label>Ad soyad</label>
                <input class="input" id="prName" value="${esc(u.display_name || '')}"></div>
              <div class="field"><label>Kullanıcı adı</label>
                <input class="input" id="prUser" value="${esc(u.username || '')}"></div>
            </div>
            <div class="row"><span class="muted" style="font-size:13px">
              ${u.has_pin ? 'Kasa PIN\'i tanımlı' : 'Kasa PIN\'i yok'} ·
              ${u.has_password ? 'telefon şifresi tanımlı' : 'telefon şifresi yok'}
              ${u.pin_changed_at ? ' · PIN son değişiklik ' + esc(String(u.pin_changed_at).slice(0, 10)) : ''}
            </span><div class="spacer"></div>
            <button class="btn btn--primary btn--sm" id="prSave">Kaydet</button></div>
          </div></div>

        <div class="split-2">
          <div class="card"><div class="card__head"><h3>Kasa PIN'i</h3></div><div class="card__body">
            <div id="prPinAlert"></div>
            <div class="field"><label>Mevcut PIN</label>
              <input class="input" id="prPinOld" type="password" inputmode="numeric" autocomplete="current-password"></div>
            <div class="field"><label>Yeni PIN (${r.pin_length} hane)</label>
              <input class="input" id="prPinNew" type="password" inputmode="numeric" maxlength="${r.pin_length}"
                     autocomplete="new-password"></div>
            <button class="btn btn--primary btn--wide" id="prPinOk">PIN'i değiştir</button>
          </div></div>

          <div class="card"><div class="card__head"><h3>Telefon şifresi</h3></div><div class="card__body">
            <div id="prPwAlert"></div>
            <div class="field"><label>Mevcut şifre</label>
              <input class="input" id="prPwOld" type="password" autocomplete="current-password"></div>
            <div class="field"><label>Yeni şifre (en az 6 karakter)</label>
              <input class="input" id="prPwNew" type="password" autocomplete="new-password"></div>
            <button class="btn btn--primary btn--wide" id="prPwOk">Şifreyi değiştir</button>
          </div></div>
        </div>

        <div class="card"><div class="card__head"><h3>Açabildiğim ekranlar</h3>
          <div class="spacer"></div><span class="muted" style="font-size:12.5px">Değiştirmek için yöneticinize başvurun</span></div>
          <div class="card__body">
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
              ${r.permissions.map(p => `<span class="badge badge--gray" style="justify-content:flex-start">${esc(p.label)}</span>`).join('')
                || '<span class="muted">Tanımlı yetki yok.</span>'}
            </div></div></div>
      </div>`;

    $('#prSave').onclick = async () => {
      try {
        await api('POST', '/api/settings/profile', { display_name: $('#prName').value, username: $('#prUser').value });
        toast('Kaydedildi', 'ok'); this.profilDraw();
      } catch (e) { $('#prAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
    $('#prPinOk').onclick = async () => {
      try {
        const o = await api('POST', '/api/settings/profile/pin',
          { current: $('#prPinOld').value, pin: $('#prPinNew').value });
        toast(o.message, 'ok'); this.profilDraw();
      } catch (e) { $('#prPinAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
    $('#prPwOk').onclick = async () => {
      try {
        const o = await api('POST', '/api/settings/profile/password',
          { current: $('#prPwOld').value, password: $('#prPwNew').value });
        toast(o.message, 'ok'); this.profilDraw();
      } catch (e) { $('#prPwAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

});
