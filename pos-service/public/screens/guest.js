/* =====================================================================
   NOKTApp POS - Misafir tarafı: QR menü, Müşteri kartı, Sadakat, Kurulum
   =====================================================================
   Four screens for the half of the product the guest actually touches, and
   which the old system either could not show or could not finish:

   * QR MENÜ - the menu lived on pos.noktapp.com and had to be "published"
     from here, so every venue's digital menu was months behind its own till.
     It is now served from this machine, off this database, which means there
     is nothing to publish: a price changed at 11:00 is on the table at 11:00.
     This screen dresses it (name, logo, welcome line, theme), decides what
     the guest may see, and shows the real page in a phone frame - not a
     drawing of it, the page itself, so the preview cannot lie.
   * MÜŞTERİ KARTI - customers.js could always search and save. What nobody
     could see was the answer to "who is this and are they a regular": how
     often they come, what they spend, what they are holding. And the one
     action that makes the record earn its keep - putting the guest on the
     open bill, which is what stamps their card when it closes.
   * SADAKAT - the engine (modules/loyalty.js) was never the problem. The
     management around it was: you could not edit a programme, could not see
     the cards, and the number that matters most had no screen at all - the
     AÇIK YÜKÜMLÜLÜK, the rewards guests have earned and not yet taken. That
     is food already paid for and still owed, and it belongs on a screen.
   * KURULUM - the first-run wizard asks four questions and leaves the
     restaurant with no KDV rates, no business-day roll hour, no currency and
     an empty menu. This is where the rest of it lives, permanently, so it can
     be finished on Tuesday rather than abandoned on Monday.

   Same visual language as the rest of the till: .card, .tbl, .stat, .field,
   .badge, .zone-tab, .stamps, one accent (orange). Nothing is green - the one
   colour that carries meaning here is the amber of an open liability, and a
   second hue would take the eye off it.
   ===================================================================== */
'use strict';

registerIcon('qrmenu',
  '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>'
  + '<rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14v3M17 20h4"/>');
registerIcon('musteri',
  '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><circle cx="8.5" cy="11.5" r="2.3"/>'
  + '<path d="M5 16.4a3.8 3.8 0 017 0M14 10h4M14 14h3"/>');
registerIcon('sadakat',
  '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5l1.4 2.9 3.1.4-2.3 2.2.6 3.1-2.8-1.5-2.8 1.5.6-3.1-2.3-2.2 3.1-.4z"/>');
registerIcon('kurulum',
  '<path d="M4 6.5l2 2 3.5-3.5M4 13l2 2 3.5-3.5M4 19.5l2 2 3.5-3.5M13 7h7M13 13.5h7M13 20h7"/>');

registerPage({ id: 'qrmenu', label: 'QR menü', icon: 'qrmenu', perm: 'settings.manage' , group: 'guests' }, 'guests');
registerPage({ id: 'musteri', label: 'Müşteri kartı', icon: 'musteri', perm: 'customer.manage' , group: 'guests' }, 'qrmenu');
registerPage({ id: 'sadakat', label: 'Sadakat', icon: 'sadakat' , group: 'guests' }, 'musteri');
registerPage({ id: 'kurulum', label: 'Kurulum', icon: 'kurulum', perm: 'settings.manage' , group: 'isletme' }, 'sadakat');

/*
 * The handful of classes these four screens need that app.css does not already
 * have. Injected from here rather than added to the shared stylesheet: they
 * are only ever used here, and a rule nobody else can inherit is a rule nobody
 * else can accidentally break.
 */
(function guestCss() {
  if (document.getElementById('gsCss')) return;
  const s = document.createElement('style');
  s.id = 'gsCss';
  s.textContent = `
    /* the preview. A real iframe of the real guest page, at the width of a
       phone, because a preview that is a re-drawing of the page is a preview
       that can disagree with it. */
    .gs-phone{width:340px;max-width:100%;height:620px;border-radius:26px;border:8px solid var(--ink);
      background:var(--ink);overflow:hidden;margin:0 auto;box-shadow:0 1px 0 var(--line)}
    .gs-phone iframe{width:100%;height:100%;border:0;border-radius:18px;background:#fff;display:block}
    .gs-phone__none{height:100%;display:grid;place-items:center;color:#A1A1AA;font-size:13px;
      text-align:center;padding:24px;background:var(--surface)}
    /* on/off switch. A button, not a checkbox: the whole row is a touch target
       on a 15" screen and a 14px checkbox is not. */
    .gs-sw{width:46px;height:26px;border-radius:13px;background:var(--line-strong);position:relative;
      flex:none;transition:background .12s;border:0;padding:0}
    .gs-sw::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;
      background:#fff;transition:transform .12s}
    .gs-sw.is-on{background:var(--orange)}
    .gs-sw.is-on::after{transform:translateX(20px)}
    .gs-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line)}
    .gs-row:last-child{border-bottom:0}
    .gs-row--head{background:var(--surface-2);font-weight:600}
    .gs-row--child{padding-left:34px}
    .gs-row.is-off{color:var(--ink-3)}
    .gs-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    /* the liability banner. Amber, and the only coloured block on the report -
       it is the number the owner has to act on. */
    .gs-liab{display:flex;align-items:center;gap:16px;padding:16px 18px;border-radius:var(--radius-lg);
      background:var(--orange-soft);border:1px solid #FFD5B0;color:var(--orange-dark);margin-bottom:14px}
    .gs-liab__big{font-size:30px;font-weight:700;letter-spacing:-.6px;font-variant-numeric:tabular-nums}
    .gs-liab__txt{font-size:13.5px;line-height:1.5}
    .gs-mono{font-variant-numeric:tabular-nums}
    .gs-pick{display:flex;align-items:center;gap:12px;width:100%;padding:11px 12px;border-radius:10px;
      border:1px solid var(--line);background:var(--surface);text-align:left;margin-bottom:8px}
    .gs-pick:hover{border-color:var(--orange);background:var(--orange-soft)}
    .gs-pick.is-active{border-color:var(--orange);background:var(--orange-soft)}
    .gs-step{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}
    .gs-step:last-child{border-bottom:0}
    .gs-tick{width:24px;height:24px;border-radius:50%;flex:none;display:grid;place-items:center;
      font-size:12px;font-weight:700;border:1.5px solid var(--line-strong);color:var(--ink-3)}
    .gs-tick.is-done{background:var(--ink);border-color:var(--ink);color:#fff}
    .gs-addr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--ink-2);
      word-break:break-all}
    .gs-drop{border:1px dashed var(--line-strong);border-radius:var(--radius);padding:22px;text-align:center;
      color:var(--ink-3);font-size:13.5px}
    .gs-drop.is-on{border-color:var(--orange);background:var(--orange-soft);color:var(--orange-dark)}
    /* a stopped programme is still shown - its cards and its liability are
       real - but it is faded, because it is not a thing to act on today */
    .gs-off{opacity:.55}

    /* the design pickers - menu templates and card designs. One list, because
       they are the same gesture: a swatch, a name, a sentence saying who it is
       for, and the live preview does the rest. */
    .gs-tpl{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
    .gs-tpl__i{display:flex;align-items:center;gap:11px;padding:11px 12px;border-radius:10px;
      border:1px solid var(--line);background:var(--surface);text-align:left;width:100%}
    .gs-tpl__i:hover{border-color:var(--orange)}
    .gs-tpl__i.is-active{border-color:var(--orange);background:var(--orange-soft)}
    .gs-tpl__txt{min-width:0;display:block}
    .gs-tpl__txt b{display:block;font-size:14px;margin-bottom:3px}
    .gs-tpl__txt .muted{display:block;font-size:12px;line-height:1.45}
    /* the swatch is paper over accent, in the template's own two colours -
       enough to tell dark from light and warm from cool at a glance, and it
       cannot lie about anything else because the frame beside it is the page */
    .gs-tpl__sw{width:34px;height:44px;border-radius:6px;flex:none;border:1px solid var(--line-strong);
      background:linear-gradient(180deg,#FBFAF8 0 62%,#FF7A1A 62% 100%)}
    .gs-tpl__sw--noktapp-kart{background:linear-gradient(180deg,#F7F6F4 0 62%,#EA580C 62% 100%)}
    .gs-tpl__sw--noktapp-serit{background:linear-gradient(180deg,#FFFFFF 0 40%,#FF7A1A 40% 58%,#FFFFFF 58% 100%)}
    .gs-tpl__sw--luks{background:linear-gradient(180deg,#101012 0 62%,#C9A44C 62% 100%)}
    .gs-tpl__sw--modern{background:linear-gradient(180deg,#F4F5F7 0 62%,#0F1115 62% 100%)}
    .gs-tpl__sw--sicak{background:linear-gradient(180deg,#FDF6EC 0 62%,#E2662A 62% 100%)}
    .gs-tpl__sw--sade{background:linear-gradient(180deg,#FFFFFF 0 62%,#111111 62% 100%)}
    .gs-tpl__sw--gece{background:linear-gradient(180deg,#0E0E11 0 62%,#FF9A4D 62% 100%)}
    .gs-tpl__sw--iri{background:linear-gradient(180deg,#FFFFFF 0 62%,#D34700 62% 100%)}
    .gs-tpl__sw--fotograf{background:linear-gradient(180deg,#F7F7F5 0 62%,#EA580C 62% 100%)}
    .gs-tpl__sw--lokanta{background:linear-gradient(180deg,#FBF6EA 0 62%,#8E2A2A 62% 100%)}
    .gs-tpl__sw--bistro{background:linear-gradient(180deg,#22211F 0 62%,#E08A3C 62% 100%)}`;
  document.head.appendChild(s);
})();

Screens.add({

  /* remembered between visits, so a half-finished job is one tap away */
  _gsTab: 'ayar',
  _qmTpl: undefined,            // the design being tried on, not yet saved
  _gsLoyTab: 'programlar',
  _gsCustomer: null,
  _gsRange: null,
  _gsImport: null,

  /* ------------------------------------------------------------------ */
  /* shared bits                                                        */
  /* ------------------------------------------------------------------ */

  /** Date range for the loyalty report: last 30 days unless asked otherwise. */
  gsRange() {
    if (!this._gsRange) {
      const to = new Date();
      const from = new Date(Date.now() - 29 * 86400000);
      this._gsRange = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
    }
    return this._gsRange;
  },

  gsTabs(id, tabs, current) {
    return `<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px" id="${id}">
      ${tabs.map(([k, label]) => `<button class="zone-tab${current === k ? ' is-active' : ''}"
        data-t="${k}">${label}</button>`).join('')}</div>`;
  },

  /** "Ad Soyad" with neither half producing a stray space when it is missing. */
  gsName(c) {
    return [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Misafir';
  },

  /** A card's dots. Above ~24 the strip stops being readable, so it counts. */
  gsStamps(progress, target) {
    if (target > 24) return `<span class="muted gs-mono">${progress} / ${target}</span>`;
    let out = '<div class="stamps">';
    for (let i = 0; i < target; i++) out += `<span class="stamp${i < progress ? ' is-on' : ''}"></span>`;
    return out + '</div>';
  },

  /**
   * Ask for a reason, and refuse to proceed without one.
   *
   * Every manual movement of a loyalty balance goes through here. A stamp the
   * till awards is evidenced by the bill; one given by hand is evidenced by
   * nothing, so the reason IS the evidence. The API refuses an empty one too -
   * this is the polite half of that rule, not the whole of it.
   */
  gsAskReason(title, help) {
    return new Promise((resolve) => {
      modal(`
        <div class="modal__head"><h3>${esc(title)}</h3><div class="spacer"></div>
          <button class="close-x" data-close="1">✕</button></div>
        <div class="modal__body">
          <p class="muted" style="margin-top:0">${esc(help)}</p>
          <div class="field"><label>Gerekçe</label>
            <input class="input" id="gsReason" placeholder="Örnek: kart evde kalmış, fiş gösterildi"></div>
          <div id="gsReasonAlert"></div>
        </div>
        <div class="modal__foot">
          <button class="btn btn--ghost" data-close="1">Vazgeç</button>
          <button class="btn btn--primary" id="gsReasonOk">Onayla</button>
        </div>`);
      const ok = () => {
        const v = $('#gsReason').value.trim();
        if (!v) {
          $('#gsReasonAlert').innerHTML = '<div class="alert alert--error">Gerekçe zorunlu.</div>';
          return;
        }
        closeModal(); resolve(v);
      };
      $('#gsReasonOk').onclick = ok;
      $('#gsReason').addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    });
  },

  /* ================================================================== */
  /* QR MENÜ                                                            */
  /* ================================================================== */
  async page_qrmenu(tab) {
    if (tab) this._gsTab = tab;
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">QR menü</h2><div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="qmCards">Karekod kartları</button>
      </div>
      <div id="qmWarn"></div>
      ${this.gsTabs('qmTabs', [['ayar', 'Görünüm'], ['tasarim', 'Tasarım'], ['urun', 'Menüde ne var'],
        ['kart', 'Masa kartları'], ['adres', 'Masa adresleri']], this._gsTab)}
      <div id="qmBody"><div class="empty">Yükleniyor…</div></div></div>`;

    $$('#qmTabs [data-t]').forEach(b => b.onclick = () => this.page_qrmenu(b.dataset.t));
    $('#qmCards').onclick = () => this.page_qrmenu('kart');

    try {
      const s = await api('GET', '/api/guest/qr/settings');
      this._qm = s;
      $('#qmWarn').innerHTML = s.warnings.map(w =>
        `<div class="alert alert--warn">${esc(w)}</div>`).join('');
      if (this._gsTab === 'ayar') this.qmSettings();
      else if (this._gsTab === 'tasarim') this.qmTemplates();
      else if (this._gsTab === 'urun') this.qmFlags();
      else if (this._gsTab === 'kart') this.qmCards();
      else this.qmAddresses();
    } catch (e) { err(e); }
  },

  qmSettings() {
    const s = this._qm.settings || {};
    const on = (v, def = 1) => (v === undefined || v === null ? def : Number(v)) ? 'checked' : '';
    $('#qmBody').innerHTML = `<div class="split-2" style="align-items:start">
      <div class="card"><div class="card__head"><h3>Misafirin gördüğü menü</h3></div>
        <div class="card__body">
          <div class="field"><label>İşletme adı</label>
            <input class="input" id="qmName" value="${esc(s.business_name || '')}" placeholder="Örnek Restoran"></div>
          <div class="field"><label>Karşılama yazısı</label>
            <input class="input" id="qmWelcome" value="${esc(s.welcome_text || '')}"
              placeholder="Hoş geldiniz, afiyet olsun."></div>
          <div class="field"><label>Logo adresi</label>
            <input class="input" id="qmLogo" value="${esc(s.logo_url || '')}" placeholder="/media/logo.png">
            <div class="muted" style="font-size:12px;margin-top:6px">Bu bilgisayardaki bir dosya yolu.
              Menü misafirin telefonunda açılır; uzaktaki bir adres zayıf çekimde yüklenmez.</div></div>
          <div class="split-2">
            <div class="field"><label>Tema</label>
              <select class="input" id="qmTheme">
                <option value="light"${s.theme !== 'dark' ? ' selected' : ''}>Açık (aydınlık salon)</option>
                <option value="dark"${s.theme === 'dark' ? ' selected' : ''}>Koyu (loş salon)</option>
              </select></div>
            <div class="field"><label>Telefon</label>
              <input class="input" id="qmPhone" value="${esc(s.phone || '')}"></div>
          </div>
          <div class="field"><label>Alt yazı / açıklama</label>
            <textarea class="input" id="qmAbout" placeholder="Her gün 09:00 - 23:00">${esc(s.about || '')}</textarea></div>
          <div class="split-2">
            <div class="field"><label>Instagram</label>
              <input class="input" id="qmIg" value="${esc(s.instagram_url || '')}"></div>
            <div class="field"><label>Yol tarifi (Google)</label>
              <input class="input" id="qmGo" value="${esc(s.google_url || '')}"></div>
          </div>
          <div class="field"><label>Web sitesi</label>
            <input class="input" id="qmWeb" value="${esc(s.website_url || '')}"></div>
          <label class="row" style="gap:9px;margin-bottom:10px">
            <input type="checkbox" id="qmPrices" ${on(s.show_prices)}> <span>Fiyatları göster</span></label>
          <label class="row" style="gap:9px;margin-bottom:16px">
            <input type="checkbox" id="qmPub" ${on(s.is_published)}> <span>Dijital menü açık</span></label>
          <div class="row"><div class="spacer"></div>
            <button class="btn btn--primary" id="qmSave">Kaydet</button></div>
        </div></div>

      <div class="card"><div class="card__head"><h3>Önizleme</h3><div class="spacer"></div>
        <span class="badge ${Number(s.is_published) === 0 ? 'badge--gray' : 'badge--open'}">
          ${Number(s.is_published) === 0 ? 'kapalı' : 'açık'}</span></div>
        <div class="card__body" id="qmPreview"></div></div>
    </div>`;

    this.qmDrawPreview();
    $('#qmSave').onclick = async () => {
      try {
        await api('POST', '/api/guest/qr/settings', {
          business_name: $('#qmName').value, welcome_text: $('#qmWelcome').value,
          logo_url: $('#qmLogo').value, theme: $('#qmTheme').value, phone: $('#qmPhone').value,
          about: $('#qmAbout').value, instagram_url: $('#qmIg').value, google_url: $('#qmGo').value,
          website_url: $('#qmWeb').value,
          show_prices: $('#qmPrices').checked, is_published: $('#qmPub').checked,
        });
        toast('Dijital menü kaydedildi', 'ok');
        this.page_qrmenu();
      } catch (e) { err(e); }
    };
  },

  /**
   * The preview is the guest page itself, loaded through the first table's own
   * card address. Nothing is re-drawn here: if the guest page is broken, this
   * frame is broken too, which is the only useful kind of preview.
   */
  qmDrawPreview() {
    const withToken = (this._qm.tables || []).find(t => t.qr_token);
    const box = $('#qmPreview');
    if (!box) return;
    box.innerHTML = withToken
      ? `<div class="gs-phone"><iframe id="qmFrame" src="/menu.html?m=${encodeURIComponent(withToken.qr_token)}"
           title="Menü önizleme"></iframe></div>
         <div class="muted" style="font-size:12px;text-align:center;margin-top:10px">
           ${esc(withToken.name)} masasının karekodu okutulduğunda görünen sayfa.</div>`
      : `<div class="gs-phone"><div class="gs-phone__none">Hiçbir masanın karekodu yok.<br>
           Masa düzeni ekranından üretin, önizleme burada açılsın.</div></div>`;
  },

  /**
   * What the guest may see, one switch per line.
   *
   * A category switch cascades onto its products on purpose: "İçecekler menüde
   * görünmesin" means the drinks too, and a category that is off with its
   * products still flagged on is a trap for whoever turns it back on later.
   */
  async qmFlags() {
    $('#qmBody').innerHTML = '<div class="empty">Yükleniyor…</div>';
    try {
      const r = await api('GET', '/api/guest/qr/flags');
      if (!r.categories.length) {
        $('#qmBody').innerHTML = `<div class="empty">Henüz kategori yok.
          <div style="margin-top:12px"><button class="btn btn--primary btn--sm" data-go="kurulum">Kuruluma git</button></div></div>`;
        return;
      }
      $('#qmBody').innerHTML = `<div class="card"><div class="card__head">
          <h3>Menüde görünenler</h3><div class="spacer"></div>
          <span class="muted" style="font-size:12.5px">Kapatılan ürün kasada satılmaya devam eder.</span></div>
        <div>${r.categories.map(c => `
          <div class="gs-row gs-row--head${c.use_in_qr ? '' : ' is-off'}">
            <button class="gs-sw${c.use_in_qr ? ' is-on' : ''}" data-cat="${c.id}"
              data-on="${c.use_in_qr ? 0 : 1}" title="Kategoriyi ve içindekileri aç/kapat"></button>
            <div class="gs-name">${esc(c.name)}</div>
            <span class="muted gs-mono" style="font-size:12.5px">${c.products.length} ürün</span>
          </div>
          ${c.products.map(p => `
            <div class="gs-row gs-row--child${p.use_in_qr && c.use_in_qr ? '' : ' is-off'}">
              <button class="gs-sw${p.use_in_qr ? ' is-on' : ''}" data-prod="${p.id}"
                data-on="${p.use_in_qr ? 0 : 1}"></button>
              <div class="gs-name">${esc(p.name)}</div>
              <span class="gs-mono">${tl(p.price)} ₺</span>
            </div>`).join('')}`).join('')}</div></div>`;

      $$('#qmBody [data-cat]').forEach(b => b.onclick = async () => {
        try {
          await api('POST', '/api/guest/qr/flags',
            { kind: 'category', id: Number(b.dataset.cat), on: b.dataset.on === '1', cascade: true });
          this.qmFlags();
        } catch (e) { err(e); }
      });
      $$('#qmBody [data-prod]').forEach(b => b.onclick = async () => {
        try {
          await api('POST', '/api/guest/qr/flags',
            { kind: 'product', id: Number(b.dataset.prod), on: b.dataset.on === '1' });
          this.qmFlags();
        } catch (e) { err(e); }
      });
    } catch (e) { err(e); }
  },

  /* ------------------------------------------------------------------ */
  /* TASARIM - the twelve menu designs                                   */
  /* ------------------------------------------------------------------ */

  /**
   * The template picker.
   *
   * The preview on the right is the GUEST PAGE, in a phone-shaped frame,
   * loaded through a real table's own card address with ?tpl= on it. Nothing
   * here is a drawing of the design: a picker that renders its own idea of a
   * template is a picker that can disagree with the page a guest opens, and
   * the manager finds out from a customer.
   *
   * Choosing writes nothing. `Bu tasarımı kaydet` writes one column, through
   * /qr/design - so trying nine designs on a Tuesday cannot lose the welcome
   * text somebody typed on Monday.
   */
  qmTemplates() {
    const list = this._qm.templates || [];
    const saved = this._qm.template || 'noktapp';
    if (this._qmTpl === undefined || !list.some(t => t.key === this._qmTpl)) this._qmTpl = saved;

    $('#qmBody').innerHTML = `<div class="split-2" style="align-items:start;grid-template-columns:1fr 380px">
      <div class="card"><div class="card__head"><h3>Menü tasarımı</h3><div class="spacer"></div>
        <span class="muted" style="font-size:12.5px">${list.length} tasarım</span></div>
        <div class="card__body">
          <div class="muted" style="font-size:13px;margin-bottom:12px;line-height:1.55">
            Hepsi aynı menü sayfasının farklı giysisi. Seçtiğiniz tasarım, masadaki karekodu
            okutan misafirin gördüğü sayfadır. Hepsi telefonda okunur, uzun ürün adını taşır
            ve güneşte okunacak kadar kontrastlıdır.</div>
          <div class="gs-tpl">${list.map(t => `
            <button class="gs-tpl__i${t.key === this._qmTpl ? ' is-active' : ''}" data-tpl="${esc(t.key)}">
              <span class="gs-tpl__sw gs-tpl__sw--${esc(t.key)}"></span>
              <span class="gs-tpl__txt">
                <b>${esc(t.name)}${t.key === saved ? ' <span class="badge badge--open">seçili</span>' : ''}</b>
                <span class="muted">${esc(t.note)}</span></span>
            </button>`).join('')}</div>
        </div></div>

      <div class="card"><div class="card__head"><h3>Önizleme</h3><div class="spacer"></div>
        <span class="badge badge--gray" id="qmTplName"></span></div>
        <div class="card__body">
          <div id="qmTplFrame"></div>
          <div class="row" style="margin-top:12px">
            <div class="spacer"></div>
            <button class="btn btn--primary btn--sm" id="qmTplSave">Bu tasarımı kaydet</button>
          </div>
        </div></div>
    </div>`;

    const paint = () => {
      const t = list.find(x => x.key === this._qmTpl) || {};
      $('#qmTplName').textContent = t.name || '';
      const withToken = (this._qm.tables || []).find(x => x.qr_token);
      $('#qmTplFrame').innerHTML = withToken
        ? `<div class="gs-phone"><iframe src="/menu.html?m=${encodeURIComponent(withToken.qr_token)}&tpl=${
            encodeURIComponent(this._qmTpl)}" title="Menü önizleme"></iframe></div>`
        : `<div class="gs-phone"><div class="gs-phone__none">Hiçbir masanın karekodu yok.<br>
             Masa düzeni ekranından üretin, önizleme burada açılsın.</div></div>`;
      $$('#qmBody [data-tpl]').forEach(b =>
        b.classList.toggle('is-active', b.dataset.tpl === this._qmTpl));
    };

    $$('#qmBody [data-tpl]').forEach(b => b.onclick = () => { this._qmTpl = b.dataset.tpl; paint(); });
    $('#qmTplSave').onclick = async () => {
      try {
        await api('POST', '/api/guest/qr/design', { template: this._qmTpl });
        toast('Menü tasarımı kaydedildi', 'ok');
        this.page_qrmenu('tasarim');
      } catch (e) { err(e); }
    };
    paint();
  },

  /* ------------------------------------------------------------------ */
  /* MASA KARTLARI - the A5 print                                        */
  /* ------------------------------------------------------------------ */

  /**
   * The printable A5 cards.
   *
   * The file is the deliverable here, not the screen: this is what gets
   * forwarded to a print shop, so the screen's job is to say what will be in
   * it - which design, which handles, which tables have no code - and then
   * produce it in one press. A card per page, A5, nothing to trim.
   */
  async qmCards() {
    $('#qmBody').innerHTML = '<div class="empty">Yükleniyor…</div>';
    try {
      const r = await api('GET', '/api/guest/qr/cards');
      const socials = r.socials.length
        ? r.socials.map(s => `<span class="badge badge--gray">${esc(s.shown)}</span>`).join(' ')
        : '<span class="muted">Kapalı. Müşteri ekranı ayarlarından açın; kartlara da oradan basılır.</span>';

      $('#qmBody').innerHTML = `
        ${r.warnings.map(w => `<div class="alert alert--warn">${esc(w.text)}</div>`).join('')}
        <div class="card" style="margin-bottom:14px"><div class="card__body row" style="flex-wrap:wrap;gap:12px">
          <div><div class="strong">${r.cards.length} masa kartı</div>
            <div class="muted" style="font-size:12.5px">A5 (148 × 210 mm), her sayfada bir kart.</div></div>
          <div class="spacer"></div>
          <div class="muted" style="font-size:12.5px">Sosyal medya: ${socials}</div>
          <button class="btn btn--primary btn--sm" id="qcAll">Tüm kartları PDF indir</button>
        </div></div>

        <div class="card" style="margin-bottom:14px">
          <div class="card__head"><h3>Kart tasarımı</h3></div>
          <div class="card__body"><div class="gs-tpl">${r.designs.map(d => `
            <button class="gs-tpl__i${d.key === r.design ? ' is-active' : ''}" data-cd="${esc(d.key)}">
              <span class="gs-tpl__txt"><b>${esc(d.name)}${
                d.key === r.design ? ' <span class="badge badge--open">seçili</span>' : ''}</b>
                <span class="muted">${esc(d.note)}</span></span></button>`).join('')}</div>
            <div class="muted" style="font-size:12.5px;margin-top:10px">
              Bir tasarıma basmak onu kaydeder. Nasıl göründüğünü görmek için bir masanın
              “Kartı” düğmesiyle tek sayfalık PDF alın.</div>
          </div></div>

        <div class="card"><div class="card__head"><h3>Masalar</h3></div>
          <table class="tbl"><thead><tr><th>Masa</th><th>Alan</th><th>Karekod</th><th></th></tr></thead><tbody>
            ${r.cards.map(c => `<tr>
              <td><b>${esc(c.name)}</b></td>
              <td class="muted">${esc(c.zone_name || '')}</td>
              <td>${c.url ? '<span class="badge badge--open">var</span>'
                          : '<span class="badge badge--gray">yok</span>'}</td>
              <td class="right">${c.url
                ? `<button class="btn btn--ghost btn--sm" data-one="${c.id}">Kartı</button>` : ''}</td>
            </tr>`).join('') || '<tr><td colspan="4"><div class="empty">Masa yok.</div></td></tr>'}
          </tbody></table></div>`;

      $('#qcAll').onclick = (e) => this.download('/api/guest/qr/cards.pdf', e.currentTarget);
      $$('#qmBody [data-one]').forEach(b => b.onclick = (e) =>
        this.download('/api/guest/qr/cards.pdf?table=' + b.dataset.one, e.currentTarget));
      $$('#qmBody [data-cd]').forEach(b => b.onclick = async () => {
        try {
          await api('POST', '/api/guest/qr/design', { card_design: b.dataset.cd });
          toast('Kart tasarımı kaydedildi', 'ok');
          this.qmCards();
        } catch (e) { err(e); }
      });
    } catch (e) { err(e); }
  },

  /** Which address each table's card opens, so a card can be checked by eye. */
  qmAddresses() {
    const tables = this._qm.tables || [];
    const base = location.origin;
    $('#qmBody').innerHTML = `<div class="card">
      <div class="card__head"><h3>Masa adresleri</h3><div class="spacer"></div>
        <span class="muted" style="font-size:12.5px">A5 kartları basmak için “Masa kartları” sekmesi.</span></div>
      <table class="tbl"><thead><tr><th>Masa</th><th>Adres</th><th></th></tr></thead><tbody>
        ${tables.map(t => `<tr>
          <td><b>${esc(t.name)}</b></td>
          <td class="gs-addr">${t.qr_token ? esc(base + '/menu.html?m=' + t.qr_token) : '<span class="muted">karekod yok</span>'}</td>
          <td class="right">${t.qr_token
            ? `<button class="btn btn--ghost btn--sm" data-open="${esc(t.qr_token)}">Aç</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="3"><div class="empty">Masa yok.</div></td></tr>'}
      </tbody></table></div>`;
    $$('#qmBody [data-open]').forEach(b => b.onclick = () =>
      window.open('/menu.html?m=' + encodeURIComponent(b.dataset.open), '_blank'));
  },

  /* ================================================================== */
  /* MÜŞTERİ KARTI                                                      */
  /* ================================================================== */
  async page_musteri(customerId) {
    if (customerId) this._gsCustomer = customerId;
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Müşteri kartı</h2><div class="spacer"></div>
        <input class="input" id="msQ" placeholder="ad veya telefon ara…" style="width:260px;height:36px">
        <button class="btn btn--primary btn--sm" id="msNew">Müşteri ekle</button>
      </div>
      <div class="split-2" style="align-items:start;grid-template-columns:340px 1fr">
        <div class="card" id="msList"><div class="empty">Aramak için yazın.</div></div>
        <div id="msDetail"><div class="empty">Soldan bir müşteri seçin.</div></div>
      </div></div>`;

    const search = async () => {
      const q = $('#msQ').value.trim();
      try {
        const r = await api('GET', '/api/guest/customers?q=' + encodeURIComponent(q));
        $('#msList').innerHTML = r.customers.length ? r.customers.map(c => `
          <button class="gs-pick${Number(this._gsCustomer) === Number(c.id) ? ' is-active' : ''}" data-c="${c.id}">
            <span class="gs-name"><b>${esc(this.gsName(c))}</b>
              <span class="muted" style="display:block;font-size:12.5px">${esc(c.phone || 'telefon yok')}</span></span>
          </button>`).join('') : '<div class="empty">Kayıt yok.</div>';
        $$('#msList [data-c]').forEach(b => b.onclick = () => this.msShow(Number(b.dataset.c)));
      } catch (e) { err(e); }
    };
    let t = null;
    $('#msQ').oninput = () => { clearTimeout(t); t = setTimeout(search, 220); };
    $('#msNew').onclick = () => this.msForm({});
    await search();
    if (this._gsCustomer) this.msShow(this._gsCustomer);
  },

  async msShow(id) {
    this._gsCustomer = id;
    $('#msDetail').innerHTML = '<div class="empty">Yükleniyor…</div>';
    try {
      const d = await api('GET', '/api/guest/customers/' + id);
      const c = d.customer, st = d.stats;
      $('#msDetail').innerHTML = `
        <div class="card" style="margin-bottom:14px">
          <div class="card__head"><h3>${esc(this.gsName(c))}</h3>
            <span class="badge badge--gray">${esc(c.phone || 'telefon yok')}</span><div class="spacer"></div>
            <button class="btn btn--ghost btn--sm" id="msEdit">Düzenle</button>
            <button class="btn btn--primary btn--sm" id="msAttach">Açık adisyona bağla</button></div>
          <div class="card__body">
            <div class="split-4">
              <div class="stat"><div class="stat__label">Ziyaret</div>
                <div class="stat__value">${st.visits}</div></div>
              <div class="stat"><div class="stat__label">Toplam harcama</div>
                <div class="stat__value">${tl(st.spend)} ₺</div></div>
              <div class="stat"><div class="stat__label">Ortalama adisyon</div>
                <div class="stat__value">${tl(st.average)} ₺</div></div>
              <div class="stat"><div class="stat__label">Son ziyaret</div>
                <div class="stat__value" style="font-size:18px">${st.last_visit ? esc(String(st.last_visit).slice(0, 10)) : '—'}</div></div>
            </div>
          </div></div>

        <div class="card" style="margin-bottom:14px">
          <div class="card__head"><h3>Sadakat kartları</h3></div>
          <div class="card__body">${d.cards.length ? d.cards.map(k => `
            <div class="loyal__card${k.rewards_available > 0 ? ' is-ready' : ''}" style="margin-bottom:8px">
              <div style="flex:1;min-width:0">
                <div class="loyal__title">${esc(k.title)}</div>
                ${this.gsStamps(k.progress_count, k.target_count)}
                ${k.rewards_available > 0
                  ? `<div style="font-size:12.5px;color:var(--orange-dark);margin-top:4px">
                       ${k.rewards_available} ödül hazır · ${esc(k.reward_text || '')}</div>` : ''}
              </div>
              <button class="btn btn--ghost btn--sm" data-stamp="${k.program_id}">Damga</button>
              ${k.rewards_available > 0
                ? `<button class="btn btn--primary btn--sm" data-redeem="${k.card_id}">Ödül kullan</button>` : ''}
            </div>`).join('') : '<div class="muted">Bu misafirin kartı yok. Sadakat ekranından damga verebilirsiniz.</div>'}
          </div></div>

        <div class="card"><div class="card__head"><h3>Geçmiş adisyonlar</h3></div>
          ${d.history.length ? `<table class="tbl"><thead><tr><th>Tarih</th><th>Adisyon</th>
            <th class="right">Tutar</th></tr></thead><tbody>
            ${d.history.map(h => `<tr><td>${esc(String(h.business_date || '').slice(0, 10))}</td>
              <td>#${esc(h.adisyon_no || h.id)}</td>
              <td class="right gs-mono">${tl(h.grand_total)} ₺</td></tr>`).join('')}
            </tbody></table>` : '<div class="empty">Henüz adisyon yok.</div>'}
        </div>`;

      $('#msEdit').onclick = () => this.msForm(c);
      $('#msAttach').onclick = () => this.msAttach(c);
      $$('#msDetail [data-stamp]').forEach(b => b.onclick = () =>
        this.loyStamp(c.id, Number(b.dataset.stamp), () => this.msShow(id)));
      $$('#msDetail [data-redeem]').forEach(b => b.onclick = () =>
        this.loyRedeem(c.id, Number(b.dataset.redeem), () => this.msShow(id)));
    } catch (e) { err(e); }
  },

  msForm(c) {
    modal(`
      <div class="modal__head"><h3>${c.id ? 'Müşteriyi düzenle' : 'Yeni müşteri'}</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="split-2">
          <div class="field"><label>Ad</label><input class="input" id="msF" value="${esc(c.first_name || '')}"></div>
          <div class="field"><label>Soyad</label><input class="input" id="msL" value="${esc(c.last_name || '')}"></div>
          <div class="field"><label>Telefon</label>
            <input class="input" id="msP" inputmode="numeric" value="${esc(c.phone || '')}" placeholder="5321234567"></div>
          <div class="field"><label>E-posta</label><input class="input" id="msE" value="${esc(c.email || '')}"></div>
        </div>
        <div class="field"><label>Doğum tarihi</label>
          <input class="input" id="msB" type="date" value="${esc((c.birth_date || '').slice(0, 10))}"></div>
        <div id="msAlert"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="msOk">Kaydet</button></div>`);
    $('#msOk').onclick = async () => {
      try {
        const r = await api('POST', '/api/guest/customers', {
          id: c.id || null, first_name: $('#msF').value, last_name: $('#msL').value,
          phone: $('#msP').value, email: $('#msE').value, birth_date: $('#msB').value || null });
        closeModal();
        toast('Müşteri kaydedildi', 'ok');
        this.page_musteri(r.id || c.id);
      } catch (e) { $('#msAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /**
   * Put this guest on an open bill.
   *
   * This is the action the whole record exists for: a bill that knows who is
   * sitting there stamps their card by itself when it closes. Only open bills
   * are offered, because a closed one has already decided its stamps.
   */
  async msAttach(c) {
    try {
      const r = await api('GET', '/api/pos/orders/open');
      const bills = r.orders || [];
      modal(`
        <div class="modal__head"><h3>${esc(this.gsName(c))} hangi adisyonda?</h3><div class="spacer"></div>
          <button class="close-x" data-close="1">✕</button></div>
        <div class="modal__body">
          <p class="muted" style="margin-top:0">Adisyon kapandığında sadakat damgaları bu misafire yazılır.</p>
          ${bills.length ? bills.map(b => `
            <button class="gs-pick" data-o="${b.id}">
              <span class="gs-name">${b.table_name ? esc(b.table_name) + ' · ' : ''}
                Adisyon #${esc(b.adisyon_no || b.id)}${b.bill_label ? ' · ' + esc(b.bill_label) : ''}</span>
              <b class="gs-mono">${tl(b.grand_total)} ₺</b></button>`).join('')
            : '<div class="empty">Şu anda açık adisyon yok.</div>'}
        </div>`);
      $$('#modal [data-o]').forEach(b => b.onclick = async () => {
        try {
          await api('POST', `/api/guest/orders/${b.dataset.o}/customer`, { customer_id: c.id });
          closeModal();
          toast('Misafir adisyona bağlandı', 'ok');
        } catch (e) { err(e); }
      });
    } catch (e) { err(e); }
  },

  /* ================================================================== */
  /* SADAKAT                                                            */
  /* ================================================================== */
  async page_sadakat(tab) {
    if (tab) this._gsLoyTab = tab;
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Sadakat</h2><div class="spacer"></div>
        <button class="btn btn--primary btn--sm" id="lyNew">Program ekle</button>
      </div>
      ${this.gsTabs('lyTabs', [['programlar', 'Programlar'], ['kartlar', 'Kartlar'], ['rapor', 'Rapor']], this._gsLoyTab)}
      <div id="lyBody"><div class="empty">Yükleniyor…</div></div></div>`;
    $$('#lyTabs [data-t]').forEach(b => b.onclick = () => this.page_sadakat(b.dataset.t));
    $('#lyNew').onclick = () => this.lyForm({});
    if (this._gsLoyTab === 'programlar') this.lyPrograms();
    else if (this._gsLoyTab === 'kartlar') this.lyCards();
    else this.lyReport();
  },

  async lyPrograms() {
    try {
      const r = await api('GET', '/api/guest/loyalty/programs');
      $('#lyBody').innerHTML = r.programs.length ? `<div class="card">
        <table class="tbl"><thead><tr><th>Program</th><th>Ürün</th><th class="right">Hedef</th>
          <th>Ödül</th><th>Durum</th><th></th></tr></thead><tbody>
          ${r.programs.map(p => `<tr>
            <td><b>${esc(p.title)}</b></td>
            <td>${esc(p.product_name || 'Her ziyaret')}</td>
            <td class="right gs-mono">${p.target_count}</td>
            <td class="muted">${esc(p.reward_text || '')}</td>
            <td><span class="badge ${p.is_active ? 'badge--open' : 'badge--gray'}">
              ${p.is_active ? 'çalışıyor' : 'durdu'}</span></td>
            <td class="right">
              <button class="btn btn--ghost btn--sm" data-edit="${p.id}">Düzenle</button>
              <button class="btn btn--ghost btn--sm" data-toggle="${p.id}">${p.is_active ? 'Durdur' : 'Başlat'}</button>
            </td></tr>`).join('')}
        </tbody></table></div>
        <p class="muted" style="font-size:12.5px;margin-top:12px">
          Ürünü olan program o üründen alınan her adet için bir damga verir. “Her ziyaret” seçilirse
          adisyon başına bir damga yazılır. Hedefi değiştirmek, yarıda kalan kartları bozmaz.</p>`
        : `<div class="empty">Henüz sadakat programı yok.
            <div style="margin-top:12px"><button class="btn btn--primary btn--sm" id="lyFirst">İlk programı oluştur</button></div></div>`;
      if ($('#lyFirst')) $('#lyFirst').onclick = () => this.lyForm({});
      const list = r.programs;
      $$('#lyBody [data-edit]').forEach(b => b.onclick = () =>
        this.lyForm(list.find(p => Number(p.id) === Number(b.dataset.edit)) || {}));
      $$('#lyBody [data-toggle]').forEach(b => b.onclick = async () => {
        try { await api('POST', `/api/guest/loyalty/programs/${b.dataset.toggle}/toggle`); this.lyPrograms(); }
        catch (e) { err(e); }
      });
    } catch (e) { err(e); }
  },

  async lyForm(p) {
    let flags = { categories: [] };
    try { flags = await api('GET', '/api/guest/qr/flags'); } catch (e) { /* the picker degrades to "her ziyaret" */ }
    modal(`
      <div class="modal__head"><h3>${p.id ? 'Programı düzenle' : 'Yeni sadakat programı'}</h3>
        <div class="spacer"></div><button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="field"><label>Program adı</label>
          <input class="input" id="lyTitle" value="${esc(p.title || '')}" placeholder="10 kahve 1 bedava"></div>
        <div class="split-2">
          <div class="field"><label>Hangi ürün</label>
            <select class="input" id="lyProd">
              <option value="">Her ziyaret (adisyon başına 1 damga)</option>
              ${flags.categories.map(c => `<optgroup label="${esc(c.name)}">
                ${c.products.map(x => `<option value="${x.id}"${Number(p.product_id) === Number(x.id) ? ' selected' : ''}>
                  ${esc(x.name)}</option>`).join('')}</optgroup>`).join('')}
            </select></div>
          <div class="field"><label>Kaç damga</label>
            <input class="input" id="lyTarget" type="number" min="1" max="999"
              value="${esc(p.target_count || 10)}"></div>
        </div>
        <div class="field"><label>Ödül nedir</label>
          <input class="input" id="lyReward" value="${esc(p.reward_text || '')}" placeholder="Bir filtre kahve bizden"></div>
        <p class="muted" style="font-size:12.5px;margin:0">
          Ödülün parasal karşılığı, seçilen ürünün güncel fiyatıdır; adisyondan o kadar düşülür.
          “Her ziyaret” seçilirse ödülün bir bedeli hesaplanamaz, açık yükümlülük raporunda 0 ₺ görünür.</p>
        <div id="lyAlert"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="lyOk">Kaydet</button></div>`);
    $('#lyOk').onclick = async () => {
      try {
        await api('POST', '/api/guest/loyalty/programs', {
          id: p.id || null, title: $('#lyTitle').value,
          product_id: $('#lyProd').value ? Number($('#lyProd').value) : null,
          target_count: Number($('#lyTarget').value), reward_text: $('#lyReward').value });
        closeModal();
        toast('Program kaydedildi', 'ok');
        this.page_sadakat('programlar');
      } catch (e) { $('#lyAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  async lyCards(q, ready) {
    const query = q === undefined ? (this._lyQ || '') : q;
    const onlyReady = ready === undefined ? !!this._lyReady : ready;
    this._lyQ = query; this._lyReady = onlyReady;
    try {
      const r = await api('GET', '/api/guest/loyalty/cards?q=' + encodeURIComponent(query)
        + (onlyReady ? '&ready=1' : ''));
      $('#lyBody').innerHTML = `
        <div class="row" style="margin-bottom:12px">
          <input class="input" id="lyQ" value="${esc(query)}" placeholder="misafir veya program ara…"
            style="width:280px;height:36px">
          <button class="btn btn--ghost btn--sm${onlyReady ? ' btn--dark' : ''}" id="lyReady">
            ${onlyReady ? 'Tüm kartlar' : 'Sadece ödülü hazır olanlar'}</button>
        </div>
        ${r.cards.length ? `<div class="card"><table class="tbl">
          <thead><tr><th>Misafir</th><th>Program</th><th>İlerleme</th><th class="right">Ödül</th>
            <th class="right">Karşılık</th><th></th></tr></thead><tbody>
          ${r.cards.map(c => `<tr>
            <td><b>${esc(this.gsName(c))}</b><div class="muted" style="font-size:12px">${esc(c.phone || '')}</div></td>
            <td>${esc(c.title)}<div class="muted" style="font-size:12px">${esc(c.product_name || 'Her ziyaret')}</div></td>
            <td style="min-width:120px">
              <div class="loyal__bar"><i style="width:${Math.round(c.progress_count / c.target_count * 100)}%"></i></div>
              <span class="muted gs-mono" style="font-size:12px">${c.progress_count} / ${c.target_count}</span></td>
            <td class="right gs-mono">${c.rewards_available > 0
              ? `<span class="badge badge--open">${c.rewards_available} hazır</span>` : '—'}</td>
            <td class="right gs-mono">${c.open_value ? tl(c.open_value) + ' ₺' : '—'}</td>
            <td class="right">
              <button class="btn btn--ghost btn--sm" data-hist="${c.card_id}">Geçmiş</button>
              <button class="btn btn--ghost btn--sm" data-stamp="${c.program_id}" data-cust="${c.customer_id}">Damga</button>
              ${c.rewards_available > 0
                ? `<button class="btn btn--primary btn--sm" data-redeem="${c.card_id}" data-cust="${c.customer_id}">Ödül</button>` : ''}
            </td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">Kart yok.</div>'}`;

      let t = null;
      $('#lyQ').oninput = () => { clearTimeout(t); t = setTimeout(() => this.lyCards($('#lyQ').value, onlyReady), 220); };
      $('#lyReady').onclick = () => this.lyCards(query, !onlyReady);
      $$('#lyBody [data-hist]').forEach(b => b.onclick = () => this.lyHistory(Number(b.dataset.hist)));
      $$('#lyBody [data-stamp]').forEach(b => b.onclick = () =>
        this.loyStamp(Number(b.dataset.cust), Number(b.dataset.stamp), () => this.lyCards()));
      $$('#lyBody [data-redeem]').forEach(b => b.onclick = () =>
        this.loyRedeem(Number(b.dataset.cust), Number(b.dataset.redeem), () => this.lyCards()));
    } catch (e) { err(e); }
  },

  async lyHistory(cardId) {
    try {
      const r = await api('GET', `/api/guest/loyalty/cards/${cardId}/history`);
      const KIND = { stamp: 'Damga', reward: 'Ödül', adjust: 'Düzeltme' };
      const SRC = { scan: 'okutma', order: 'adisyon', manual: 'elle' };
      modal(`
        <div class="modal__head"><h3>Kart hareketleri</h3><div class="spacer"></div>
          <button class="close-x" data-close="1">✕</button></div>
        <div class="modal__body" style="padding:0">
          ${r.events.length ? `<table class="tbl"><thead><tr><th>Tarih</th><th>Hareket</th>
            <th>Kaynak</th><th>Gerekçe</th></tr></thead><tbody>
            ${r.events.map(e => `<tr>
              <td class="gs-mono">${esc(String(e.created_at).slice(0, 16).replace('T', ' '))}</td>
              <td>${esc(KIND[e.kind] || e.kind)}${e.kind === 'stamp' ? ' ×' + e.qty : ''}</td>
              <td class="muted">${esc(SRC[e.source] || e.source)}${e.order_id ? ' #' + e.order_id : ''}</td>
              <td class="muted">${esc(e.note || '')}</td></tr>`).join('')}
            </tbody></table>` : '<div class="empty">Hareket yok.</div>'}
        </div>`, { wide: true });
    } catch (e) { err(e); }
  },

  /** Manual stamp: ask which programme if it was not named, then ask why. */
  async loyStamp(customerId, programId, after) {
    try {
      let pid = programId;
      if (!pid) {
        const r = await api('GET', '/api/guest/loyalty/programs');
        const active = r.programs.filter(p => p.is_active);
        if (!active.length) return toast('Tanımlı sadakat programı yok', 'error');
        pid = active[0].id;
      }
      const reason = await this.gsAskReason('Elle damga',
        'Adisyona bağlı olmayan damganın kaydı yalnızca bu gerekçedir.');
      const r = await api('POST', '/api/guest/loyalty/stamp',
        { customer_id: customerId, program_id: pid, qty: 1, reason });
      toast(r.earned ? `Damga verildi · ${r.earned} ödül hak edildi` : 'Damga verildi', 'ok');
      if (after) after();
    } catch (e) { err(e); }
  },

  async loyRedeem(customerId, cardId, after) {
    try {
      const reason = await this.gsAskReason('Ödül kullan',
        'Ödül karta kapatılır; açık adisyon varsa tutarı adisyondan düşmek için kasa ekranını kullanın.');
      const r = await api('POST', '/api/guest/loyalty/redeem',
        { customer_id: customerId, card_id: cardId, reason });
      toast(r.discount ? `Ödül kullanıldı · ${tl(r.discount)} ₺ düşüldü` : 'Ödül kullanıldı', 'ok');
      if (after) after();
    } catch (e) { err(e); }
  },

  /**
   * The report, and the number it exists for.
   *
   * AÇIK YÜKÜMLÜLÜK is rewards earned minus rewards used, valued at the reward
   * product's price today. It is money the restaurant owes in food and has
   * already collected in cash, and no other screen in the product tracks it.
   */
  async lyReport(from, to) {
    const R = this.gsRange();
    if (from) R.from = from;
    if (to) R.to = to;
    try {
      const r = await api('GET', `/api/guest/loyalty/report?from=${R.from}&to=${R.to}`);
      const T = r.totals;
      $('#lyBody').innerHTML = `
        <div class="row" style="margin-bottom:14px;flex-wrap:wrap">
          <input class="input" id="lyFrom" type="date" value="${R.from}" style="width:170px;height:36px">
          <input class="input" id="lyTo" type="date" value="${R.to}" style="width:170px;height:36px">
          <button class="btn btn--ghost btn--sm" data-d="7">7 gün</button>
          <button class="btn btn--ghost btn--sm" data-d="30">30 gün</button>
          <button class="btn btn--ghost btn--sm" data-d="90">90 gün</button>
          <div class="spacer"></div>
          <span class="muted" style="font-size:12.5px">Damga ve kullanım seçilen aralıktan;
            bakiye ve yükümlülük her zaman güncel toplamdır.</span>
        </div>

        ${T.open_rewards > 0 ? `<div class="gs-liab">
          <div><div class="gs-liab__big">${tl(T.liability)} ₺</div>
            <div style="font-size:12.5px">${T.open_rewards} ödül bekliyor</div></div>
          <div class="gs-liab__txt"><b>Açık yükümlülük.</b>
            Misafirlerin hak edip henüz almadığı ödüller. Bunlar tahsil edilmiş ama henüz
            verilmemiş üründür; kapanan her ay bu tutar kadar borçlu devredersiniz.</div>
        </div>` : ''}

        <div class="split-4" style="margin-bottom:14px">
          <div class="stat"><div class="stat__label">Verilen damga</div>
            <div class="stat__value">${T.stamps}</div>
            <div class="stat__sub">seçilen aralıkta</div></div>
          <div class="stat"><div class="stat__label">Hak edilen ödül</div>
            <div class="stat__value">${T.earned_rewards}</div>
            <div class="stat__sub">bugüne kadar</div></div>
          <div class="stat"><div class="stat__label">Kullanılan ödül</div>
            <div class="stat__value">${T.used_rewards}</div>
            <div class="stat__sub">kullanım oranı %${T.claim_rate}</div></div>
          <div class="stat"><div class="stat__label">Bekleyen ödül</div>
            <div class="stat__value">${T.open_rewards}</div>
            <div class="stat__sub">${tl(T.liability)} ₺ karşılık</div></div>
        </div>

        <div class="card" style="margin-bottom:14px">
          <div class="card__head"><h3>Programlara göre</h3><div class="spacer"></div>
            <span class="muted" style="font-size:12.5px">${T.cards} kart</span></div>
          ${r.programs.length ? `<table class="tbl"><thead><tr>
            <th>Program</th><th>Ürün</th><th class="right">Hedef</th><th class="right">Kart</th>
            <th class="right">Damga</th><th class="right">Hak edilen</th><th class="right">Kullanılan</th>
            <th class="right">Bekleyen</th><th class="right">Kullanım</th><th class="right">Yükümlülük</th>
          </tr></thead><tbody>
            ${r.programs.map(p => `<tr${p.is_active ? '' : ' class="gs-off"'}>
              <td><b>${esc(p.title)}</b>${p.is_active ? '' : ' <span class="badge badge--gray">durdu</span>'}</td>
              <td class="muted">${esc(p.product_name)}</td>
              <td class="right gs-mono">${p.target_count}</td>
              <td class="right gs-mono">${p.cards}</td>
              <td class="right gs-mono">${p.stamps}</td>
              <td class="right gs-mono">${p.earned_rewards}</td>
              <td class="right gs-mono">${p.used_rewards}</td>
              <td class="right gs-mono"><b>${p.open_rewards}</b></td>
              <td class="right gs-mono">%${p.claim_rate}</td>
              <td class="right gs-mono">${tl(p.liability)} ₺</td></tr>`).join('')}
          </tbody></table>` : '<div class="empty">Program yok.</div>'}
        </div>

        <div class="card"><div class="card__head"><h3>Kullanılan ödüller</h3></div>
          ${r.redemptions.length ? `<table class="tbl"><thead><tr><th>Tarih</th><th>Misafir</th>
            <th>Program</th><th>Adisyon</th><th class="right">Düşülen</th></tr></thead><tbody>
            ${r.redemptions.map(x => `<tr>
              <td class="gs-mono">${esc(String(x.created_at).slice(0, 16).replace('T', ' '))}</td>
              <td>${esc([x.first_name, x.last_name].filter(Boolean).join(' ') || 'Misafir')}
                <span class="muted">${esc(x.phone || '')}</span></td>
              <td>${esc(x.title || '')}</td>
              <td class="muted">${x.order_id ? '#' + x.order_id : 'adisyonsuz'}</td>
              <td class="right gs-mono">${Number(x.discount) ? tl(x.discount) + ' ₺' : '—'}</td>
            </tr>`).join('')}</tbody></table>`
            : '<div class="empty">Bu aralıkta kullanılan ödül yok.</div>'}
        </div>`;

      $('#lyFrom').onchange = () => this.lyReport($('#lyFrom').value, $('#lyTo').value);
      $('#lyTo').onchange = () => this.lyReport($('#lyFrom').value, $('#lyTo').value);
      $$('#lyBody [data-d]').forEach(b => b.onclick = () => {
        const days = Number(b.dataset.d);
        this.lyReport(new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10),
          new Date().toISOString().slice(0, 10));
      });
    } catch (e) { err(e); }
  },

  /* ================================================================== */
  /* KURULUM                                                            */
  /* ================================================================== */
  /*
   * The first-run wizard (screens.js `wizard`) asks four questions and then
   * gets out of the way, which is right - a new customer is standing there
   * wanting to sell something. Everything it could not ask lives here, and
   * unlike the wizard this screen is reachable forever, so a setup can be
   * finished on Tuesday instead of abandoned on Monday.
   */
  async page_kurulum() {
    $('#main').innerHTML = `<div class="page is-on">
      <h2 class="page-title">Kurulum</h2>
      <div id="kuBody"><div class="empty">Yükleniyor…</div></div></div>`;
    try {
      const st = await api('GET', '/api/guest/setup/state');
      this._ku = st;
      const pct = Math.round(st.done / st.total * 100);
      $('#kuBody').innerHTML = `
        <div class="split-2" style="align-items:start;grid-template-columns:1fr 380px">
          <div>
            <div class="card" style="margin-bottom:14px">
              <div class="card__head"><h3>KDV oranları</h3><div class="spacer"></div>
                <span class="muted" style="font-size:12.5px">Ürün eklerken önerilir</span></div>
              <div class="card__body">
                <div class="row" style="flex-wrap:wrap;gap:14px;margin-bottom:14px">
                  ${st.vat.catalogue.map(v => `<label class="row" style="gap:8px">
                    <input type="checkbox" class="kuVat" value="${v.rate}"
                      ${st.vat.rates.includes(v.rate) ? 'checked' : ''}>
                    <span>${esc(v.label)}</span></label>`).join('')}
                </div>
                <div class="split-2">
                  <div class="field" style="margin:0"><label>Varsayılan oran</label>
                    <select class="input" id="kuVatDef">
                      ${st.vat.catalogue.map(v => `<option value="${v.rate}"
                        ${st.vat.default_rate === v.rate ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
                    </select></div>
                  <div class="row" style="align-items:flex-end"><div class="spacer"></div>
                    <button class="btn btn--primary" id="kuVatSave">Kaydet</button></div>
                </div>
                <p class="muted" style="font-size:12.5px;margin-bottom:0">
                  Bu liste yalnızca ürün formunda ne önerileceğini belirler. Satılmış bir adisyonun
                  KDV'si burada bir şey değişince yeniden hesaplanmaz.</p>
              </div></div>

            <div class="card" style="margin-bottom:14px">
              <div class="card__head"><h3>İş günü ve para birimi</h3></div>
              <div class="card__body"><div class="split-3">
                <div class="field"><label>İş günü başlangıcı</label>
                  <input class="input" id="kuDay" type="time" value="${esc(st.general.business_day_start)}"></div>
                <div class="field"><label>Para birimi</label>
                  <select class="input" id="kuCur">
                    ${[['TRY', 'Türk Lirası (₺)'], ['USD', 'Dolar ($)'], ['EUR', 'Euro (€)'], ['GBP', 'Sterlin (£)']]
                      .map(([k, l]) => `<option value="${k}"${st.general.currency === k ? ' selected' : ''}>${l}</option>`).join('')}
                  </select></div>
                <div class="field"><label>Simge</label>
                  <input class="input" id="kuSym" value="${esc(st.general.currency_symbol)}" maxlength="4"></div>
              </div>
              <p class="muted" style="font-size:12.5px">
                Gece 02:00'de kesilen adisyon hangi güne yazılsın? Bu saatten öncesi bir önceki güne
                sayılır - gün sonu raporu ve Z raporu bu saate göre kapanır.</p>
              <div class="row"><div class="spacer"></div>
                <button class="btn btn--primary" id="kuGenSave">Kaydet</button></div>
              </div></div>

            <div class="card" style="margin-bottom:14px">
              <div class="card__head"><h3>Menüyü içe aktar</h3><div class="spacer"></div>
                <button class="btn btn--ghost btn--sm" id="kuTpl">Örnek dosya</button></div>
              <div class="card__body">
                <p class="muted" style="margin-top:0">Elinizdeki fiyat listesini yükleyin: 300 ürünü tek tek
                  yazmak yerine Excel veya CSV dosyanızdan aktarın. Önce ne olacağını gösterir, siz
                  onaylamadan hiçbir şey yazılmaz.</p>
                <div class="gs-drop" id="kuDrop">
                  <input type="file" id="kuFile" accept=".csv,.xlsx,.xls" style="display:none">
                  <button class="btn btn--ghost" id="kuPick">Dosya seç</button>
                  <div style="margin-top:8px" id="kuFileName">CSV veya XLSX · sütunlar: Kategori, Ürün Adı, Fiyat, KDV %</div>
                </div>
                <div id="kuPreview" style="margin-top:14px"></div>
              </div></div>

            <div class="card">
              <div class="card__head"><h3>Menü şablonları</h3></div>
              <div class="card__body">
                <p class="muted" style="margin-top:0">Boş bir menüye başlık takımı ekler. Var olanlara
                  dokunmaz, hiçbir şey silmez.</p>
                <div class="row" style="flex-wrap:wrap">
                  <button class="btn btn--ghost" data-preset="kafe">Kafe</button>
                  <button class="btn btn--ghost" data-preset="restoran">Restoran</button>
                  <button class="btn btn--ghost" data-preset="bar">Bar</button>
                  <div class="spacer"></div>
                  <button class="btn btn--ghost btn--sm" data-go="products">Ürünler ekranı</button>
                </div>
              </div></div>
          </div>

          <div class="card">
            <div class="card__head"><h3>Durum</h3><div class="spacer"></div>
              <span class="badge ${pct === 100 ? 'badge--closed' : 'badge--open'}">${st.done} / ${st.total}</span></div>
            <div class="card__body">
              ${st.steps.map(s => `<div class="gs-step">
                <span class="gs-tick${s.done ? ' is-done' : ''}">${s.done ? '✓' : ''}</span>
                <div><div class="strong">${esc(s.label)}</div>
                  <div class="muted" style="font-size:12.5px">${esc(s.help)}</div></div>
              </div>`).join('')}
              <p class="muted" style="font-size:12.5px;margin-bottom:0">
                Masa, personel ve yazıcı için Masa düzeni ile Ayarlar ekranlarını kullanın;
                aynı kayıtlara oradan da ulaşılır.</p>
            </div></div>
        </div>`;

      $('#kuVatSave').onclick = async () => {
        try {
          const rates = $$('.kuVat').filter(c => c.checked).map(c => Number(c.value));
          await api('POST', '/api/guest/setup/vat', { rates, default_rate: Number($('#kuVatDef').value) });
          toast('KDV oranları kaydedildi', 'ok');
          this.page_kurulum();
        } catch (e) { err(e); }
      };
      $('#kuGenSave').onclick = async () => {
        try {
          await api('POST', '/api/guest/setup/general', {
            business_day_start: $('#kuDay').value, currency: $('#kuCur').value,
            currency_symbol: $('#kuSym').value });
          toast('Kaydedildi', 'ok');
          this.page_kurulum();
        } catch (e) { err(e); }
      };
      $$('#kuBody [data-preset]').forEach(b => b.onclick = async () => {
        try {
          const r = await api('POST', '/api/guest/setup/categories/preset', { set: b.dataset.preset });
          toast(r.created ? `${r.created} kategori eklendi` : 'Bu şablondaki kategoriler zaten var', 'ok');
          this.page_kurulum();
        } catch (e) { err(e); }
      });
      /* was an <a href> with the token on the query string - it downloads
         through the authorised helper now, like every other export */
      $('#kuTpl').onclick = (e) =>
        this.download('/api/manage/products/template?format=xlsx', e.currentTarget);
      $('#kuPick').onclick = () => $('#kuFile').click();
      $('#kuFile').onchange = () => this.kuImport($('#kuFile').files[0]);
    } catch (e) { err(e); }
  },

  /**
   * Read the spreadsheet in the browser, send it as base64, show the plan.
   *
   * The preview is not optional and not a formality: a menu is the thing the
   * whole till is built on, and importing one nobody looked at is how a
   * restaurant opens on Friday with last year's prices.
   */
  async kuImport(file) {
    if (!file) return;
    $('#kuFileName').textContent = file.name;
    $('#kuDrop').classList.add('is-on');
    $('#kuPreview').innerHTML = '<div class="muted">Dosya okunuyor…</div>';
    try {
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = () => reject(new Error('Dosya okunamadı'));
        fr.onload = () => resolve(String(fr.result).split(',')[1]);
        fr.readAsDataURL(file);
      });
      const body = { filename: file.name, content_base64: b64 };
      this._gsImport = body;
      const pv = await api('POST', '/api/guest/setup/menu/preview', body);
      const rows = pv.plan.slice(0, 200);
      const LABEL = { create: 'yeni', update: 'güncelle', skip: 'atlandı' };
      $('#kuPreview').innerHTML = `
        <div class="row" style="margin-bottom:10px">
          <span class="badge badge--open">${pv.summary.create} yeni</span>
          <span class="badge badge--gray">${pv.summary.update} güncelleme</span>
          <span class="badge ${pv.summary.skip ? 'badge--gray' : 'badge--gray'}">${pv.summary.skip} atlandı</span>
          <div class="spacer"></div>
          <button class="btn btn--primary btn--sm" id="kuApply"
            ${pv.summary.create + pv.summary.update ? '' : 'disabled'}>Aktar</button>
        </div>
        <div class="card" style="max-height:340px;overflow:auto"><table class="tbl">
          <thead><tr><th>Satır</th><th>Ürün</th><th class="right">Fiyat</th><th>Ne olacak</th><th>Not</th></tr></thead>
          <tbody>${rows.map(x => `<tr>
            <td class="muted gs-mono">${esc(x.line || '')}</td>
            <td>${esc(x.name || '')}</td>
            <td class="right gs-mono">${x.data && x.data.price != null ? tl(x.data.price) + ' ₺' : ''}</td>
            <td><span class="badge ${x.action === 'create' ? 'badge--open' : 'badge--gray'}">${LABEL[x.action]}</span></td>
            <td class="muted" style="font-size:12.5px">${esc((x.errors || []).concat(x.warnings || []).join(' · '))}</td>
          </tr>`).join('')}</tbody></table></div>`;
      $('#kuApply').onclick = async () => {
        try {
          const r = await api('POST', '/api/guest/setup/menu/apply', this._gsImport);
          toast(`${r.created} ürün eklendi, ${r.updated} güncellendi`, 'ok');
          await Screens.loadMenu().catch(() => {});
          this.page_kurulum();
        } catch (e) { err(e); }
      };
    } catch (e) {
      $('#kuPreview').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`;
    }
  },
});
