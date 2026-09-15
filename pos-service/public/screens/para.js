/* =====================================================================
   NOKTApp POS - Para: döviz kurları, para birimi ve KDV
   =====================================================================
   Money got its own place in the sidebar, and the reason is not tidiness.

   The euro rate a restaurant accepts is written by whoever opens up in the
   morning. It changes more often than anything else in this program, and it
   used to be the sixth tab of a screen called "Yönetim", behind a group head
   called "Ayarlar" that rendered a seventh screen of its own. Seven rows in
   the search index pointed at page `settings` - the NAME of the group, not the
   screen holding those tabs - so typing "döviz" found the row, opened nothing
   useful, and the owner concluded the kur could not be changed at all. He was
   effectively right for a whole release.

   So: Para is a sidebar group of its own, above Ayarlar, and the first thing
   under it is the rate table.

     Döviz kurları  - the rate per currency, one Kaydet per row, the change
                      history underneath, and the "are you sure" the server
                      raises when a rate jumps by more than half.
     Para ve KDV    - the para birimi the whole till counts in, how the symbol
                      is written, kuruş yuvarlama, and where KDV actually comes
                      from. The KDV card is deliberately read-only: a rate lives
                      on the product, and a second control here would be a
                      second answer to one question.

   Same visual language as the rest of the till: .card, .tbl, .field, .badge,
   .alert. One accent, orange. Nothing green - a fresh rate and a stale one are
   told apart by the words "güncel" and "bayat".
   ===================================================================== */
'use strict';

registerIcon('para',
  '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/>' +
  '<path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>');

/* The head of the group carries `groupLabel`, so the sidebar says Para while
   this screen's own tab keeps its own name. See PAGES in app.js. */
registerPage({ id: 'doviz', label: 'Döviz kurları', icon: 'para', groupLabel: 'Para',
  perm: 'settings.manage' }, 'guests');
registerPage({ id: 'para', label: 'Para ve KDV', icon: 'para',
  perm: 'settings.manage', group: 'doviz' }, 'doviz');

/*
 * The keys this screen owns.
 *
 * Every one of them used to be drawn twice: once by the generated Ayarlar form
 * (which renders whatever the server declares) and once by the İşletme form's
 * "Para birimi görünümü" card. Two controls on one fact is not a convenience -
 * whichever screen was saved last won, and the other went on showing the value
 * it had loaded until somebody reopened it. The İşletme screen now hides these,
 * and this is the list it hides them by.
 */
const PARA_KEYS = ['currency', 'currency_symbol', 'currency_position', 'decimal_places',
                   'rounding_mode'];

Screens.add({

  /* =================================================================== *
   * DÖVİZ KURLARI                                                        *
   * =================================================================== */

  async page_doviz() {
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Döviz kurları</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">Kasanın bugün kabul ettiği kur</span>
      </div>
      <div id="fxBody"><div class="empty">Yükleniyor…</div></div></div>`;
    try { await this.fxDraw(); } catch (e) { err(e); }
  },

  async fxDraw() {
    const r = await api('GET', '/api/settings/currencies');
    $('#fxBody').innerHTML = `
      <div class="grid">
        <div class="card">
          <div class="card__head"><h3>Günlük kasa kuru</h3>
            <div class="spacer"></div>
            <span class="muted" style="font-size:12.5px">Fişte göster: ${r.show_on_receipt ? 'açık' : 'kapalı'}
              <button class="btn btn--ghost btn--sm" id="fxToFis">Yazıcı ve fiş → Fiş</button></span></div>
          <div class="card__body" style="padding-bottom:0"><p class="muted" style="margin-top:0">
            Kur elle girilir - kasa hiçbir yerden kur çekmez, çünkü kasada gösterilecek kur
            işletmenin kendi kabul ettiği kurdur. 24 saatten eski kurlar işaretlenir.</p></div>
          <table class="tbl">
            <thead><tr><th>Para birimi</th><th>Kur (1 birim = ? ₺)</th><th>Durum</th><th>Örnek</th><th></th></tr></thead>
            <tbody>${r.currencies.map(c => `<tr>
              <td><b>${esc(c.code)}</b> <span class="muted">${esc(c.name)}</span> ${esc(c.symbol)}</td>
              <td style="width:180px"><input class="input mono" data-rate="${c.id}" value="${c.rate > 0 ? esc(c.rate) : ''}"
                    placeholder="0,0000"></td>
              <td>${c.missing ? '<span class="badge badge--open">kur girilmedi</span>'
                : c.stale ? '<span class="badge badge--open">bayat</span>'
                : '<span class="badge badge--closed">güncel</span>'}
                ${c.is_active ? '' : ' <span class="badge badge--gray">kapalı</span>'}</td>
              <td class="muted mono">${c.example ? '1.000 ₺ = ' + tl(c.example) + ' ' + esc(c.symbol) : '—'}</td>
              <td class="right" style="white-space:nowrap">
                <button class="btn btn--primary btn--sm" data-save="${c.id}">Kaydet</button>
                <button class="btn btn--ghost btn--sm" data-cact="${c.id}" data-to="${c.is_active ? 0 : 1}">
                  ${c.is_active ? 'Kapat' : 'Aç'}</button></td></tr>`).join('')}
            </tbody></table>
        </div>

        <div class="card">
          <div class="card__head"><h3>Son kur değişiklikleri</h3></div>
          <table class="tbl"><thead><tr><th>Para birimi</th><th>Eski</th><th>Yeni</th><th>Kim</th><th>Ne zaman</th></tr></thead>
            <tbody>${r.history.map(h => `<tr><td><b>${esc(h.code)}</b></td>
              <td class="muted mono">${h.old_rate === null ? '—' : tl(h.old_rate)}</td>
              <td class="mono">${tl(h.new_rate)}</td>
              <td>${esc(h.changed_by_name || '—')}</td>
              <td class="muted">${esc(String(h.created_at).slice(0, 16))}</td></tr>`).join('')
              || '<tr><td colspan="5" class="muted">Henüz kur girilmemiş.</td></tr>'}
            </tbody></table>
        </div>
      </div>`;

    /* Whether the rate is PRINTED is a fiş decision and lives on the fiş
       screen. Saying so and then making the reader hunt for it is how the old
       "Ayarlar → Döviz" note wasted people's afternoons, so it is a button. */
    $('#fxToFis').onclick = () => this.page_fis('fis');

    const write = async (id, confirm) => {
      const val = $(`[data-rate="${id}"]`).value;
      try {
        await api('POST', `/api/settings/currencies/${id}/rate`, { rate: val, confirm });
        toast('Kur kaydedildi', 'ok'); this.fxDraw();
      } catch (e) {
        /* A jump of more than half is answered with 409 and asked again rather
           than written: 4,35 typed as 43,5 would otherwise print a wrong
           foreign total on every receipt until somebody noticed. */
        if (/emin misiniz/i.test(e.message)) {
          if (await confirmBox('Kur çok değişti', e.message)) return write(id, true);
          return;
        }
        err(e);
      }
    };
    $$('[data-save]').forEach(b => b.onclick = () => write(b.dataset.save, false));
    $$('[data-cact]').forEach(b => b.onclick = async () => {
      try { await api('POST', `/api/settings/currencies/${b.dataset.cact}/active`, { active: b.dataset.to === '1' });
        this.fxDraw(); } catch (e) { err(e); }
    });
  },

  /* =================================================================== *
   * PARA VE KDV                                                          *
   * =================================================================== */

  /** One control, drawn from the server's own definition of the key, so the
      label and the limits here cannot drift from the ones it validates with. */
  paraField(def, value) {
    if (!def) return '';
    const id = 'pa_' + def.key;
    const help = def.help ? `<div class="muted" style="font-size:12px;margin-top:5px">${esc(def.help)}</div>` : '';
    if (def.type === 'select') {
      return `<div class="field"><label>${esc(def.label)}</label>
        <select class="input" id="${id}" data-pk="${def.key}">
          ${def.options.map(([c, l]) =>
            `<option value="${esc(c)}"${String(value) === String(c) ? ' selected' : ''}>${esc(l)}</option>`).join('')}
        </select>${help}</div>`;
    }
    const t = def.type === 'number' ? 'number' : 'text';
    const range = def.type === 'number'
      ? `${def.min !== undefined ? ` min="${def.min}"` : ''}${def.max !== undefined ? ` max="${def.max}"` : ''}` : '';
    return `<div class="field"><label>${esc(def.label)}</label>
      <input class="input" type="${t}"${range} id="${id}" data-pk="${def.key}"
             value="${esc(value)}">${help}</div>`;
  },

  async page_para() {
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Para ve KDV</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">Kasanın saydığı para birimi ve menüdeki KDV oranları</span>
      </div>
      <div id="paraBody"><div class="empty">Yükleniyor…</div></div></div>`;
    try { await this.paraDraw(); } catch (e) { err(e); }
  },

  async paraDraw() {
    const [s, menu] = await Promise.all([
      api('GET', '/api/settings'),
      /* the till's own menu, not /api/manage/products: this screen is
         settings.manage and a manager without product.manage would otherwise
         get a 403 where a read-only summary was promised */
      api('GET', '/api/pos/menu'),
    ]);
    const def = (k) => s.defs.find(d => d.key === k);

    /* KDV oranları are a property of the product, and this is where somebody
       looking for "varsayılan KDV" arrives. Counting the menu answers the
       question they actually have - "which rates am I running?" - without
       putting a second control on a number the product screen owns. */
    const byRate = new Map();
    for (const cat of menu.menu || []) {
      for (const p of cat.products || []) {
        const k = Number(p.vat_rate) || 0;
        byRate.set(k, (byRate.get(k) || 0) + 1);
      }
    }
    const rates = Array.from(byRate.entries()).sort((a, b) => a[0] - b[0]);
    const total = rates.reduce((n, [, c]) => n + c, 0);

    $('#paraBody').innerHTML = `
      <div id="paraAlert"></div>
      <div class="grid">
        <div class="card"><div class="card__head"><h3>Para birimi</h3>
          <div class="spacer"></div><span class="muted" style="font-size:12.5px" id="paraEx"></span></div>
          <div class="card__body">
            <p class="muted" style="margin:0 0 14px;font-size:13px">Ekranda, fişte ve raporlarda kullanılan
              ana para birimi. Yabancı para karşılığı ayrı bir şeydir ve Döviz kurları ekranında durur.</p>
            <div class="split-4">
              ${this.paraField(def('currency'), s.values.currency)}
              ${this.paraField(def('currency_symbol'), s.values.currency_symbol)}
              ${this.paraField(def('currency_position'), s.values.currency_position)}
              ${this.paraField(def('decimal_places'), s.values.decimal_places)}
            </div>
          </div></div>

        <div class="card"><div class="card__head"><h3>Kuruş yuvarlama</h3></div>
          <div class="card__body">
            <p class="muted" style="margin:0 0 14px;font-size:13px">Nakit ödemede toplamın yuvarlanması.
              Kartla ödemede ve raporlarda tutar kuruşuna kadar yazılır - yuvarlama yalnızca çekmeceye
              girecek nakit içindir.</p>
            <div style="max-width:340px">${this.paraField(def('rounding_mode'), s.values.rounding_mode)}</div>
          </div></div>

        <div class="card"><div class="card__head"><h3>KDV oranları</h3>
          <div class="spacer"></div>
          <span class="muted" style="font-size:12.5px">${total} ürün · ${rates.length} oran</span></div>
          <table class="tbl"><thead><tr><th>Oran</th><th>Ürün</th><th></th></tr></thead>
            <tbody>${rates.map(([r, n]) => `<tr>
              <td><b>%${esc(String(r).replace('.', ','))}</b></td>
              <td>${n} ürün</td>
              <td class="muted">${r === 0 ? 'KDV uygulanmıyor' : ''}</td></tr>`).join('')
              || '<tr><td colspan="3" class="muted">Kasada gösterilen ürün yok.</td></tr>'}
            </tbody></table>
          <div class="card__body"><p class="muted" style="margin:0;font-size:13px">
            KDV oranı ürünün kendi bilgisidir, tek bir işletme ayarı değil: bir restoranda yemek ve
            içecek farklı orandadır. Oran <button class="btn btn--ghost btn--sm" id="paraToUrun">Ürünler</button>
            ekranından ürün ya da kategori bazında değiştirilir. Fişin altına KDV dökümü basılıp
            basılmayacağı ise fişin işidir:
            <button class="btn btn--ghost btn--sm" id="paraToFis">Yazıcı ve fiş → Fiş</button></p></div>
        </div>

        <div class="row"><div class="spacer"></div>
          <button class="btn btn--primary" id="paraSave">Kaydet</button></div>
      </div>`;

    /* The example is the whole point of three of the four controls above: "2
       hane, simge sonda" means nothing until you see 1.234,50 ₺ written out. */
    const drawEx = () => {
      const sym = $('#pa_currency_symbol').value;
      const d = Math.max(0, Math.min(2, Number($('#pa_decimal_places').value) || 0));
      const n = (1234.5).toFixed(d).replace('.', ',');
      $('#paraEx').textContent = 'Örnek: ' +
        ($('#pa_currency_position').value === 'before' ? `${sym} ${n}` : `${n} ${sym}`);
    };
    $$('#paraBody [data-pk]').forEach(el => { el.oninput = drawEx; el.onchange = drawEx; });
    drawEx();

    $('#paraToUrun').onclick = () => go('products');
    $('#paraToFis').onclick = () => this.page_fis('fis');

    $('#paraSave').onclick = async () => {
      $('#paraAlert').innerHTML = '';
      const patch = {};
      $$('#paraBody [data-pk]').forEach(el => { patch[el.dataset.pk] = el.value; });
      try {
        await api('POST', '/api/settings', { settings: patch });
        toast('Kaydedildi', 'ok');
        this.paraDraw();
      } catch (e) {
        // the server names the offending field in Turkish; show it, do not swallow it
        $('#paraAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`;
      }
    };
  },
});
