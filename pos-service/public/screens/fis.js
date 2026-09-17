/* =====================================================================
   NOKTApp POS - Yazıcı ve fiş
   =====================================================================
   The one screen that owns a printer.

   There were three. This one, a "Yazıcılar" tab on Yönetim reading a second
   API, and a third list on the deleted Ayarlar screen - each of them able to
   add a printer, none of them aware of the others, and a machine added on one
   turning up unexplained on the next. The other two are gone; stations,
   printers, the queue and the paper width all live here, together, because
   they are one subject and every question about them ("mutfağa niye fiş
   çıkmıyor") is answered by looking at two of them at once.

   The four areas:

     Fiş ayarları     - what is written on the thermal slip, next to a preview
                        rendered at the TRUE paper width. The preview is not
                        drawn here: the server builds the real ESC/POS bytes and
                        sends back the lines they will print, so what is on this
                        screen is what comes out of the printer. 48 characters
                        at 80 mm, 32 at 58 mm, wrapped where the printer wraps.
     Yazıcılar        - every printer, the paper width, which machine is the
                        kasa printer, the test print and the live queue.
     İstasyonlar      - what a printer prints FOR, and which categories fall to
                        it. On the next tab rather than on another screen: a
                        station with no printer and a printer with no station
                        are the same fault seen from two sides.
     Müşteri ekranı   - the welcome text, and a small QR or image inside the
                        display template that already exists. The layout of
                        display.html is not touched; these drop into it.

   Two later additions live on the Fiş ayarları tab, both asked for by an
   Alanya restaurant whose guests pay in lira and think in euros:

     Döviz karşılığı  - which currencies get a courtesy line under the total,
                        and how old a rate may be before its date is printed
                        beside it. The rates themselves are NOT edited here -
                        they belong to Ayarlar → Döviz, which already keeps a
                        history of every change - so this tab shows them
                        read-only, with their age, and says where they come
                        from rather than pretending to own them. They are on
                        Para → Döviz kurları, one click away from the note.
     Karekod          - what the QR on the bill carries: the dijital menü
                        address, a sadakat sign-up address, free text, or
                        nothing. A mode whose address does not exist prints no
                        square at all, and the warning above the control is the
                        only place that can be said before a night of bills.

   Same visual language as the rest of the till: .card, .tbl, .btn, .field,
   .stat, .badge. One accent, orange. Nothing green.
   ===================================================================== */
'use strict';

registerIcon('fis',
  '<path d="M6 3h12v18l-2.5-1.6L13 21l-2.5-1.6L8 21l-2-1.6z"/><path d="M9 8h6M9 12h6M9 16h3"/>');
registerPage({ id: 'fis', label: 'Yazıcı ve fiş', icon: 'fis', perm: 'settings.manage', group: 'isletme' }, 'kullanici');

/* The paper is drawn with real characters in a real monospace font, so a line
   that will not fit is visibly a line that does not fit. Double-width lines are
   stretched to two cells per character - that is what the printer does with
   them, and a preview that ignored it would understate the paper by half. */
const FIS_CSS = `
<style id="fisCss">
.fis-wrap{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:14px;align-items:start}
@media (max-width:1180px){.fis-wrap{grid-template-columns:1fr}}
.fis-paper{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px 14px;
  font:13px/1.42 "Cascadia Mono","Consolas","DejaVu Sans Mono",monospace;color:#141417;
  white-space:pre;overflow-x:auto;box-shadow:inset 0 0 0 1px #fff}
.fis-paper .l{display:block;min-height:1.42em}
.fis-paper .b{font-weight:700}
.fis-paper .d{display:inline-block;transform:scaleX(2);transform-origin:left center;font-weight:700}
.fis-rule{border-top:1px dashed var(--line-strong);margin:10px 0}
.fis-sticky{position:sticky;top:8px}
.fis-mm{font-variant-numeric:tabular-nums}
.fis-screen{background:#141417;border-radius:12px;color:#fff;padding:18px;display:grid;
  grid-template-columns:1fr 130px;gap:14px;min-height:150px}
.fis-screen h4{margin:0 0 6px;font-size:20px;letter-spacing:-.4px}
.fis-screen p{margin:0;color:#B9B9C2;font-size:13px}
.fis-screen .foot{color:#7A7A85;font-size:11px;margin-top:auto}
.fis-screen .media{background:#fff;border-radius:8px;padding:6px;display:grid;place-items:center;align-self:start}
.fis-screen .media svg,.fis-screen .media img{width:100%;height:auto;display:block;max-height:118px;object-fit:contain}
.fis-screen .cap{color:#B9B9C2;font-size:10.5px;text-align:center;margin-top:4px}
/* preview of the sosyal medya row - same marks, same stroke, smaller */
.fis-screen .socs{display:flex;gap:14px;flex-wrap:wrap;margin-top:12px}
.fis-screen .soc{display:flex;align-items:center;gap:6px;font-size:12px;color:#D4D4DA}
.fis-screen .soc svg{width:15px;height:15px;flex:none;fill:none;stroke:#FF9A4D;stroke-width:1.9;
  stroke-linecap:round;stroke-linejoin:round}
.fis-screen .soc b{font-weight:600;color:#F0F0F3}
/* the media column follows the chosen size, so Buyuk is visibly bigger here too */
.fis-screen .media svg,.fis-screen .media img{max-height:150px}
.fis-multi{display:flex;gap:8px;flex-wrap:wrap}
.fis-chip{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border:1px solid var(--line);
  border-radius:20px;cursor:pointer;font-size:13px;color:var(--ink);background:#fff;user-select:none}
.fis-chip.is-on{border-color:var(--orange);background:var(--orange-soft);color:var(--orange-dark)}
.fis-chip input{margin:0}
.fis-rates{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:4px}
.fis-rates td{padding:5px 0;border-bottom:1px solid var(--line)}
.fis-rates td:last-child{text-align:right;color:var(--ink-3);font-variant-numeric:tabular-nums}
.fis-rates .code{font-weight:600}
.fis-note{font-size:12.5px;color:var(--ink-3);margin:0 0 12px}
/* İstasyonlar. A broken station has to be legible from across the office, so
   the fault is a line under the name in the accent - not a red dot, not a
   tooltip, and not a colour this product does not own. */
.fis-st-name{font-weight:600;color:var(--ink)}
.fis-st-key{font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.fis-st-warn{display:block;font-size:12px;color:var(--orange-dark);margin-top:4px}
.fis-st-warn::before{content:"•";margin-right:6px}
.fis-st-off td{opacity:.55}
.fis-st-off .fis-st-name{font-weight:500}
.fis-st-ord{display:inline-flex;flex-direction:column;gap:2px}
.fis-st-ord button{width:24px;height:17px;line-height:1;padding:0;border:1px solid var(--line);
  background:var(--surface);border-radius:5px;color:var(--ink-3);font-size:10px;cursor:pointer}
.fis-st-ord button:hover:not(:disabled){border-color:var(--orange);color:var(--orange-dark)}
.fis-st-ord button:disabled{opacity:.3;cursor:default}
.fis-st-link{background:none;border:0;padding:0;font:inherit;color:var(--orange-dark);
  text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.fis-cats{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px;
  max-height:340px;overflow-y:auto;padding:2px}
</style>`;

Screens.add({

  _fisTab: 'fis',
  _fisDirty: false,

  async page_fis(tab) {
    if (tab) this._fisTab = tab;
    const TABS = [['fis', 'Fiş ayarları'], ['yazici', 'Yazıcılar'],
      ['istasyon', 'İstasyonlar'], ['ekran', 'Müşteri ekranı']];
    /*
     * The style goes in <head>, once - the way floor.js and guest.js do it.
     *
     * It used to be emitted INTO #main, guarded by "is it already there". The
     * guard read the old element before the assignment that replaced #main, so
     * from the second draw on it saw a stylesheet, emitted nothing, and then
     * deleted the one it had seen. Every tab except the first was rendered
     * unstyled, which is why the İstasyonlar warnings first appeared as one
     * run-on sentence with no bullet.
     */
    if (!$('#fisCss')) document.head.insertAdjacentHTML('beforeend', FIS_CSS);
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Yazıcı ve fiş</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">Yazıcı bir istasyona basar, kategori bir istasyona düşer.</span>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px" id="fisTabs">
        ${TABS.map(([id, label]) => `<button class="zone-tab${this._fisTab === id ? ' is-active' : ''}"
          data-t="${id}">${label}</button>`).join('')}
      </div>
      <div id="fisBody"><div class="empty">Yükleniyor…</div></div></div>`;
    $$('#fisTabs [data-t]').forEach(b => b.onclick = () => this.page_fis(b.dataset.t));
    const draw = { fis: () => this.fisReceipt(), yazici: () => this.fisPrinters(),
      istasyon: () => this.fisStations(), ekran: () => this.fisDisplay() };
    try { await draw[this._fisTab](); } catch (e) { err(e); }
  },

  /* =================================================================== *
   * FİŞ AYARLARI                                                         *
   * =================================================================== */

  /** One field from its server definition - the same rules the server validates with. */
  fisField(def, value) {
    const id = 'fs_' + def.key;
    const help = def.help ? `<div class="muted" style="font-size:12px;margin-top:5px">${esc(def.help)}</div>` : '';
    if (def.type === 'bool') {
      return `<div class="field" style="margin-bottom:10px">
        <label class="row" style="cursor:pointer;margin:0">
          <input type="checkbox" id="${id}" data-k="${def.key}" data-type="bool" ${String(value) === '1' ? 'checked' : ''}>
          <span style="font-weight:500;color:var(--ink)">${esc(def.label)}</span></label>${help}</div>`;
    }
    if (def.type === 'select') {
      return `<div class="field"><label>${esc(def.label)}</label>
        <select class="input" id="${id}" data-k="${def.key}" data-type="select">
          ${def.options.map(([c, l]) => `<option value="${esc(c)}"${String(value) === String(c) ? ' selected' : ''}>${esc(l)}</option>`).join('')}
        </select>${help}</div>`;
    }
    /*
     * A "multi" is several answers to one question - which currencies go on
     * the fiş - so it is a row of tick boxes and not a multi-select list. A
     * multi-select is the control people ctrl-click one item out of by
     * accident, and doing that here silently stops printing a currency. The
     * value is a comma list, which is what the server stores and validates.
     */
    if (def.type === 'multi') {
      const on = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
      const opts = def.options || [];
      return `<div class="field"><label>${esc(def.label)}</label>
        <div class="fis-multi" id="${id}" data-k="${def.key}" data-type="multi">
          ${opts.length ? opts.map(([c, l]) => `<label class="fis-chip${on.includes(c) ? ' is-on' : ''}">
            <input type="checkbox" data-code="${esc(c)}"${on.includes(c) ? ' checked' : ''}>
            <span>${esc(l)}</span></label>`).join('')
            : '<span class="muted" style="font-size:13px">Tanımlı para birimi yok.</span>'}
        </div>${help}</div>`;
    }
    const t = def.type === 'number' ? 'number' : 'text';
    const range = def.type === 'number'
      ? `${def.min !== undefined ? ` min="${def.min}"` : ''}${def.max !== undefined ? ` max="${def.max}"` : ''}` : '';
    return `<div class="field"><label>${esc(def.label)}</label>
      <input class="input" type="${t}"${range} id="${id}" data-k="${def.key}" data-type="${def.type}"
             value="${esc(value)}">${help}</div>`;
  },

  /** Everything on the form, in the shape both the preview and the save want. */
  fisCollect() {
    const out = {};
    $$('#fisForm [data-k]').forEach(el => {
      if (el.dataset.type === 'multi') {
        out[el.dataset.k] = $$('input:checked', el).map(i => i.dataset.code).join(',');
      } else if (el.dataset.type === 'bool') {
        out[el.dataset.k] = el.checked ? '1' : '0';
      } else {
        out[el.dataset.k] = el.value;
      }
    });
    out.receipt_header = $('#fsHeader').value;
    out.receipt_footer = $('#fsFooter').value;
    return out;
  },

  async fisReceipt() {
    const r = await api('GET', '/api/receipt');
    this._fis = r;
    const v = r.values;

    /*
     * Where the rate on the paper comes from, said as a fact and not as a
     * setting: the code, the number, and how old it is. "Kur kaynağı" as a
     * dropdown with one entry would have told the owner nothing; this tells
     * him the euro on tonight's bills is the 42,15 he typed on Tuesday.
     */
    const rateTable = () => {
      const c = r.currencies || [];
      if (!c.length) return '<p class="fis-note">Henüz para birimi tanımlı değil.</p>';
      const age = (row) => {
        if (row.missing) return 'kur girilmedi';
        if (!row.rate_updated_at) return '—';
        const h = (Date.now() - new Date(String(row.rate_updated_at).replace(' ', 'T')).getTime()) / 3600000;
        if (h < 1) return 'az önce';
        if (h < 24) return Math.round(h) + ' saat önce';
        return Math.round(h / 24) + ' gün önce';
      };
      return `<table class="fis-rates"><tbody>${c.map(x => `<tr>
        <td class="code">${esc(x.code)}${Number(x.is_active) ? '' : ' <span class="muted">(kapalı)</span>'}</td>
        <td>${x.missing ? '<span class="muted">—</span>' : '1 ' + esc(x.code) + ' = ' + String(x.rate).replace('.', ',') + ' TL'}</td>
        <td>${esc(age(x))}</td></tr>`).join('')}</tbody></table>
        <p class="fis-note" style="margin:10px 0 0">
          Kurlar <a href="#" id="fxGo"><b>Para → Döviz kurları</b></a> ekranından girilir.
          Fişteki tutar <b>toplam ÷ kur</b> ile bulunur ve yalnızca bilgi amaçlıdır.</p>`;
    };

    const warn = (list) => (list || []).map(w => `<div class="alert alert--warn">${esc(w)}</div>`).join('');

    const group = (g) => `<div class="card">
      <div class="card__head"><h3>${esc(g.label)}</h3></div>
      <div class="card__body">
        ${g.help ? `<p class="muted" style="margin:0 0 14px;font-size:13px">${esc(g.help)}</p>` : ''}
        ${g.id === 'doviz' ? warn(r.fx_warnings) : ''}
        ${g.id === 'karekod' ? warn(r.qr_warning ? [r.qr_warning] : []) : ''}
        ${g.id === 'metin' ? `
          <div class="field"><label>Fiş başlığı yazısı (üst)</label>
            <textarea class="input" id="fsHeader" rows="3"
              placeholder="Örnek Restoran&#10;Bağdat Cad. No 12">${esc(v.receipt_header)}</textarea>
            <div class="muted" style="font-size:12px;margin-top:5px">İşletme adının altına basılır.
              Her satır ${r.width} karakteri geçemez, aksi halde yazıcı satırı ikiye böler.</div></div>` : ''}
        ${g.defs.map(d => this.fisField(d, v[d.key])).join('')}
        ${g.id === 'metin' ? `
          <div class="field" style="margin-bottom:0"><label>Fiş altı yazısı</label>
            <textarea class="input" id="fsFooter" rows="3"
              placeholder="Bizi tercih ettiğiniz için teşekkürler&#10;instagram.com/ornek">${esc(v.receipt_footer)}</textarea>
            <div class="muted" style="font-size:12px;margin-top:5px">Toplamın altına ortalanmış basılır.</div></div>` : ''}
        ${g.id === 'doviz' ? `<div class="fis-rule"></div>${rateTable()}` : ''}
      </div></div>`;

    $('#fisBody').innerHTML = `
      <div class="fis-wrap">
        <div class="grid" id="fisForm">
          ${r.groups.map(group).join('')}
          <div class="row">
            <button class="btn btn--primary" id="fsSave">Kaydet</button>
            <button class="btn btn--ghost" id="fsUndo">Değişiklikleri geri al</button>
            <div class="spacer"></div>
            <span class="muted" id="fsState" style="font-size:13px"></span>
          </div>
        </div>

        <div class="card fis-sticky">
          <div class="card__head"><h3>Önizleme</h3><div class="spacer"></div>
            <span class="badge badge--gray fis-mm" id="fsWidth">${r.paper} mm · ${r.width} karakter</span></div>
          <div class="card__body">
            <p class="muted" style="margin:0 0 12px;font-size:12.5px">Örnek bir adisyon, gerçek kağıt
              genişliğinde. Yazıcıya giden baytlar çözülerek çizilir - burada ne görüyorsanız kağıtta o çıkar.</p>
            <div id="fsPaper" class="fis-paper">Hazırlanıyor…</div>
            <div class="fis-rule"></div>
            <div class="muted" style="font-size:12.5px" id="fsNote">
              ${r.receipt_printer
                ? `Fiş yazıcısı: <b>${esc(r.receipt_printer.name)}</b> · ${Number(r.receipt_printer.paper_width) || 80} mm`
                : 'Fiş yazıcısı seçilmemiş. Yazıcılar sekmesinden birini işaretleyin.'}
            </div>
          </div>
        </div>
      </div>`;

    const paint = () => this.fisPreview();
    /*
     * This line has now been wrong twice. It first said "Ayarlar → Döviz",
     * which was not a place; then "Yönetim → Döviz", which was, until Yönetim
     * stopped being a screen. Being sent somewhere that does not exist is
     * worse than being told nothing, so it is a link as well as a path - and
     * go() rather than a page function, so the sidebar and the tab strip
     * follow the reader to Para.
     */
    if ($('#fxGo')) {
      $('#fxGo').onclick = (e) => { e.preventDefault(); go('doviz'); };
    }
    $$('#fisForm [data-k]').forEach(el => { el.oninput = paint; el.onchange = paint; });
    /* the tick boxes inside a multi are not themselves [data-k], so they carry
       their own handler - and the chip follows the box so the state is legible
       from across the room, not only from the 13px square */
    $$('#fisForm [data-type="multi"] input').forEach(box => {
      box.onchange = () => { box.closest('.fis-chip').classList.toggle('is-on', box.checked); paint(); };
    });
    $('#fsHeader').oninput = paint; $('#fsFooter').oninput = paint;
    $('#fsUndo').onclick = () => this.fisReceipt();
    $('#fsSave').onclick = async () => {
      const btn = $('#fsSave'); btn.disabled = true;
      try {
        await api('POST', '/api/receipt', { settings: this.fisCollect() });
        toast('Fiş ayarları kaydedildi', 'ok');
        this.fisReceipt();
      } catch (e) { err(e); btn.disabled = false; }
    };
    paint();
  },

  /** Ask the server what the current form would print. Debounced: typing a
      footer should not open a socket on every keystroke. */
  fisPreview() {
    clearTimeout(this._fisTimer);
    /*
     * Every write is guarded, because the 280 ms this waits is long enough for
     * the owner to have moved to another tab: the round trip then resolves
     * against a #fsState that no longer exists and the whole screen dies on
     * "Cannot set properties of null". It only became reachable when the tab
     * strip grew a fourth entry, but it was always one impatient click away.
     */
    const say = (id, prop, value) => { const el = $(id); if (el) el[prop] = value; };
    say('#fsState', 'textContent', 'Önizleme güncelleniyor…');
    this._fisTimer = setTimeout(async () => {
      try {
        const draft = this.fisCollect();
        const r = await api('POST', '/api/receipt/preview', { paper: draft.receipt_paper, draft });
        say('#fsWidth', 'textContent', `${r.paper} mm · ${r.width} karakter`);
        say('#fsPaper', 'innerHTML', r.lines.map(l => {
          const cls = l.dw ? 'd' : (l.bold ? 'b' : '');
          return `<span class="l">${cls ? `<span class="${cls}">${esc(l.text.replace(/\s+$/, '')) || ' '}</span>` : esc(l.text.replace(/\s+$/, '')) || '&nbsp;'}</span>`;
        }).join(''));
        say('#fsState', 'textContent', 'Kaydedilmedi - önizleme yazdığınızı gösteriyor.');
      } catch (e) {
        say('#fsState', 'textContent', e.message);
      }
    }, 280);
  },

  /* =================================================================== *
   * YAZICILAR                                                            *
   * =================================================================== */

  async fisPrinters() {
    const p = await api('GET', '/api/receipt/printers');
    const q = p.queue;
    this._fisPrn = p;

    $('#fisBody').innerHTML = `
      <div class="grid">
        ${q.warnings.map(w => `<div class="alert alert--warn">${esc(w)}</div>`).join('')}
        <div class="split-4">
          <div class="stat"><div class="stat__label">Kuyrukta</div>
            <div class="stat__value">${q.counts.pending || 0}</div><div class="stat__sub">bekleyen iş</div></div>
          <div class="stat"><div class="stat__label">Başarısız</div>
            <div class="stat__value">${q.counts.failed || 0}</div><div class="stat__sub">yeniden denenebilir</div></div>
          <div class="stat"><div class="stat__label">Fiş genişliği</div>
            <div class="stat__value">${p.receipt_width}</div><div class="stat__sub">karakter</div></div>
          <div class="stat"><div class="stat__label">Son baskı</div>
            <div class="stat__value" style="font-size:18px">${esc(q.last_print_at ? String(q.last_print_at).slice(5, 16) : '—')}</div>
            <div class="stat__sub">gün / saat</div></div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Yazıcılar</h3><div class="spacer"></div>
            <button class="btn btn--primary btn--sm" id="fpNew">Yazıcı ekle</button></div>
          <table class="tbl">
            <thead><tr><th>Ad</th><th>Bağlantı</th><th>Adres</th><th>Kağıt</th><th>Nereye basar</th><th></th></tr></thead>
            <tbody>${p.printers.map(x => `<tr>
              <td><b>${esc(x.name)}</b>${x.is_receipt ? ' <span class="badge badge--open">fiş (kasa)</span>' : ''}</td>
              <td>${esc((p.types.find(t => t[0] === x.type) || [null, x.type])[1])}</td>
              <td class="mono">${esc(x.ip_address || '—')}</td>
              <td class="mono">${x.paper_width} mm · ${x.chars} kr</td>
              <td>${esc(x.station_name || 'Fiş / kasa')}</td>
              <td class="right" style="white-space:nowrap">
                <button class="btn btn--ghost btn--sm" data-ftest="${x.id}">Test fişi</button>
                ${x.is_receipt ? '' : `<button class="btn btn--ghost btn--sm" data-frcpt="${x.id}">Fiş yazıcısı yap</button>`}
                <button class="btn btn--ghost btn--sm" data-fedit="${x.id}">Düzenle</button>
                <button class="btn btn--danger btn--sm" data-fdel="${x.id}">Sil</button>
              </td></tr>`).join('') || `<tr><td colspan="6" class="muted">Yazıcı yok. Fişler kuyrukta bekler,
                yazıcı tanımlanınca kendiliğinden basılır.</td></tr>`}
            </tbody></table>
          <div class="card__body"><p class="muted" style="margin:0;font-size:13px">
            ${p.windows_printers.length
              ? `Bu bilgisayardaki Windows yazıcıları: ${p.windows_printers.map(esc).join(' · ')}<br>` : ''}
            Kağıt genişliği yalnızca bir tercih değildir: 58 mm satıra 32, 80 mm satıra 48 karakter sığar.
            Fiş yazıcısını işaretlediğinizde fişin karakter genişliği o yazıcının kağıdına göre ayarlanır.</p></div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Yazdırma kuyruğu</h3><div class="spacer"></div>
            <button class="btn btn--ghost btn--sm" id="fqAll">Başarısızları yeniden dene</button></div>
          <table class="tbl">
            <thead><tr><th>#</th><th>Tür</th><th>Adisyon</th><th>İstasyon</th><th>Durum</th><th>Zaman</th><th></th></tr></thead>
            <tbody>${q.jobs.map(j => `<tr>
              <td class="mono">${j.id}</td>
              <td>${esc({ order: 'Mutfak', receipt: 'Fiş', report: 'Rapor', drawer: 'Çekmece', test: 'Test' }[j.job_type] || j.job_type)}</td>
              <td>${j.adisyon_no ? '#' + esc(j.adisyon_no) : '—'}</td>
              <td>${esc(j.station_name || '—')}</td>
              <td><span class="badge ${j.status === 'done' ? 'badge--closed' : j.status === 'failed' ? 'badge--open' : 'badge--gray'}">
                ${esc({ pending: 'bekliyor', sent: 'gönderildi', done: 'basıldı', failed: 'başarısız' }[j.status] || j.status)}</span></td>
              <td class="muted">${esc(String(j.sent_at || j.created_at || '').slice(5, 16))}</td>
              <td class="right">${j.status === 'done' ? '' :
                `<button class="btn btn--ghost btn--sm" data-fjr="${j.id}">Yeniden</button>` +
                (j.status === 'pending' ? ` <button class="btn btn--ghost btn--sm" data-fjc="${j.id}">İptal</button>` : '')}
              </td></tr>`).join('') || '<tr><td colspan="7" class="muted">Kuyruk boş.</td></tr>'}
            </tbody></table>
        </div>
      </div>`;

    const find = (id) => p.printers.find(x => Number(x.id) === Number(id));
    $('#fpNew').onclick = () => this.fisPrinterForm({}, p);
    $$('[data-fedit]').forEach(b => b.onclick = () => this.fisPrinterForm(find(b.dataset.fedit), p));
    $$('[data-fdel]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('Yazıcı silinsin mi?', 'Bu yazıcıya giden işler fiş yazıcısına düşer.')) return;
      try { await api('DELETE', `/api/receipt/printers/${b.dataset.fdel}`); toast('Silindi', 'ok'); this.fisPrinters(); }
      catch (e) { err(e); }
    });
    $$('[data-frcpt]').forEach(b => b.onclick = async () => {
      try {
        const o = await api('POST', `/api/receipt/printers/${b.dataset.frcpt}/receipt`);
        toast(`Fiş yazıcısı seçildi · fiş genişliği ${o.chars} karakter`, 'ok');
        this.fisPrinters();
      } catch (e) { err(e); }
    });
    /* The test answers {printed:false, message} when nothing came out, so the
       screen reads the answer instead of assuming a 200 means paper moved. */
    $$('[data-ftest]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Deneniyor…';
      try {
        const out = await api('POST', `/api/receipt/printers/${b.dataset.ftest}/test`);
        if (out.printed) toast(out.message, 'ok');
        else modal(`<div class="modal__head"><h3>Test fişi basılamadı</h3></div>
          <div class="modal__body"><div class="alert alert--error">${esc(out.message)}</div>
            <p class="muted">Sık görülen sebepler: yazıcı kapalı, ağ kablosu takılı değil, IP adresi
              değişmiş ya da başka bir program yazıcıyı meşgul ediyor.</p></div>
          <div class="modal__foot"><button class="btn btn--primary" onclick="closeModal()">Tamam</button></div>`);
      } catch (e) { err(e); }
      finally { b.disabled = false; b.textContent = 'Test fişi'; }
    });
    $('#fqAll').onclick = async () => {
      try { const o = await api('POST', '/api/receipt/queue/retry-failed');
        toast(o.retried + ' iş kuyruğa geri kondu', 'ok'); this.fisPrinters(); } catch (e) { err(e); }
    };
    $$('[data-fjr]').forEach(b => b.onclick = async () => {
      try { await api('POST', `/api/receipt/queue/${b.dataset.fjr}/retry`); this.fisPrinters(); } catch (e) { err(e); }
    });
    $$('[data-fjc]').forEach(b => b.onclick = async () => {
      try { await api('POST', `/api/receipt/queue/${b.dataset.fjc}/cancel`); this.fisPrinters(); } catch (e) { err(e); }
    });

    /*
     * Arriving from İstasyonlar. "Bu istasyonun yazıcısı" is a question asked
     * on the other tab and answered on this one, so the jump lands on the
     * machine itself - or, when the station has none, on an empty printer form
     * already pointed at it. Sending the owner to a list and expecting him to
     * find the row is how the old settings screen lost people.
     */
    const jump = this._fisPrnJump; this._fisPrnJump = null;
    if (jump && jump.printer_id) {
      const target = find(jump.printer_id);
      if (target) this.fisPrinterForm(target, p);
    } else if (jump && jump.station_id) {
      this.fisPrinterForm({ station_id: jump.station_id, name: jump.station_label || '' }, p);
    }
  },

  fisPrinterForm(p, ctx) {
    p = p || {};
    modal(`<div class="modal__head"><h3>${p.id ? 'Yazıcı' : 'Yeni yazıcı'}</h3></div>
      <div class="modal__body">
        <div id="fpAlert"></div>
        <div class="split-2">
          <div class="field"><label>Ad</label><input class="input" id="fpName" value="${esc(p.name || 'Kasa Yazıcı')}"></div>
          <div class="field"><label>Bağlantı</label><select class="input" id="fpType">
            ${ctx.types.map(([k, l]) => `<option value="${k}"${p.type === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}
          </select></div>
        </div>
        <div class="field"><label id="fpAddrLbl">IP adresi (gerekirse :port)</label>
          <div class="row" style="gap:8px">
            <input class="input mono" id="fpAddr" value="${esc(p.ip_address || '')}"
              placeholder="192.168.1.50:9100" style="flex:1">
            <button class="btn btn--ghost btn--sm" id="fpScan" style="flex:none">Ağı tara</button>
          </div>
          <div id="fpFound"></div></div>
        <div class="split-2">
          <div class="field"><label>Kağıt genişliği</label><select class="input" id="fpPaper">
            ${ctx.papers.map(([mm, l]) => `<option value="${mm}"${Number(p.paper_width || 80) === mm ? ' selected' : ''}>${esc(l)}</option>`).join('')}
          </select></div>
          <div class="field"><label>Hangi istasyona basar</label><select class="input" id="fpSt">
            <option value="0">Fiş / kasa (istasyonsuz)</option>
            ${ctx.stations.map(s => `<option value="${s.id}"${Number(p.station_id) === s.id ? ' selected' : ''}>${esc(s.display_name || s.name)}</option>`).join('')}
          </select></div>
        </div>
        <label class="row"><input type="checkbox" id="fpRcpt" ${p.is_receipt ? 'checked' : ''}>
          <span>Hesap fişi bu yazıcıdan çıksın (kasa yazıcısı)</span></label>
        <p class="muted" style="font-size:12.5px">Kasa yazıcısını işaretlerseniz fişin karakter genişliği
          bu yazıcının kağıdına göre ayarlanır.</p>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="fpOk">Kaydet</button></div>`);

    const relabel = () => {
      const t = $('#fpType').value;
      $('#fpAddrLbl').textContent = t === 'network' ? 'IP adresi (gerekirse :port)'
        : t === 'file' ? 'Dosya yolu' : 'Windows yazıcı adı';
      $('#fpAddr').placeholder = t === 'network' ? '192.168.1.50:9100'
        : t === 'file' ? 'C:\\NoktApp\\fis.txt' : 'EPSON TM-T20';
    };
    $('#fpType').onchange = relabel; relabel();

    /*
     * "Agi tara": knock on 9100 across the /24 this PC is on and list what
     * answered, so the address is chosen rather than remembered. Takes a few
     * seconds, so the button says so while it works - a dead-looking dialog is
     * how people conclude a feature is broken and type the IP anyway.
     */
    $('#fpScan').onclick = async () => {
      const btn = $('#fpScan');
      btn.disabled = true; btn.textContent = 'Taranıyor…';
      $('#fpFound').innerHTML = '<p class="muted" style="margin:8px 0 0;font-size:12.5px">'
        + 'Ağdaki yazıcılar aranıyor, birkaç saniye sürebilir…</p>';
      try {
        const r = await api('POST', '/api/receipt/printers/scan',
          this._fisSubnet ? { subnet: this._fisSubnet } : {});
        /* What was looked at, always - "bulunamadı" alone has twice been read
           as "bu özellik bozuk" when the truth was that the printer sits on a
           network this PC is no longer plugged into. */
        const where = `<p class="muted" style="margin:8px 0 0;font-size:12.5px">
            Taranan ağ: <span class="mono">${esc(r.subnets.join(', ') || '—')}</span>
            ${r.note ? `<br>${esc(r.note)}` : ''}</p>
          <div class="row" style="gap:8px;margin-top:8px">
            <input class="input mono" id="fpSubnet" placeholder="192.168.1.0"
              value="${esc(this._fisSubnet || '')}" style="flex:1">
            <button class="btn btn--ghost btn--sm" id="fpSubnetGo" style="flex:none">Bu ağı tara</button>
          </div>`;
        if (!r.found.length) {
          $('#fpFound').innerHTML = `<p class="muted" style="margin:8px 0 0;font-size:12.5px">
            Yazıcı bulunamadı. Yazıcının açık ve aynı ağa bağlı olduğundan emin olun.</p>${where}`;
        } else {
          $('#fpFound').innerHTML = `<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:8px">
            ${r.found.map(f => `<button class="chip${f.sure ? '' : ' chip--warn'}" data-ip="${esc(f.address)}"
              title="${esc(f.label)}">${esc(f.name || f.address)}
              ${f.name ? `<span class="muted mono">${esc(f.address)}</span>` : ''}</button>`).join('')}
          </div>
          <p class="muted" style="margin:8px 0 0;font-size:12.5px">
            ${r.found.length} cihaz bulundu. Seçmek için üstüne dokunun.</p>${where}`;
          $$('#fpFound [data-ip]').forEach(b => b.onclick = () => {
            $('#fpAddr').value = b.dataset.ip;
            $('#fpType').value = 'network'; relabel();
          });
        }
        /* Any other block, typed once. A restaurant with a printer VLAN or a
           till that has just moved router needs to say where to look, and
           "192.168.1.0" is a thing the person standing there can find out. */
        const go = $('#fpSubnetGo');
        if (go) go.onclick = () => {
          this._fisSubnet = ($('#fpSubnet').value || '').trim() || null;
          $('#fpScan').onclick();
        };
      } catch (e) {
        $('#fpFound').innerHTML = `<div class="alert alert--error" style="margin-top:8px">${esc(e.message)}</div>`;
      }
      btn.disabled = false; btn.textContent = 'Ağı tara';
    };

    $('#fpOk').onclick = async () => {
      try {
        await api('POST', '/api/receipt/printers', {
          id: p.id, name: $('#fpName').value, type: $('#fpType').value, ip_address: $('#fpAddr').value,
          station_id: Number($('#fpSt').value) || 0, paper_width: Number($('#fpPaper').value),
          is_receipt: $('#fpRcpt').checked });
        closeModal(); toast('Kaydedildi', 'ok'); this.fisPrinters();
      } catch (e) { $('#fpAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /* =================================================================== *
   * İSTASYONLAR                                                          *
   * =================================================================== *
   *
   * Mutfak, Bar, Pide, Tatlı were referenced by everything and editable by
   * nothing: the only way one existed was the seed, so a restaurant that added
   * a pide oven after opening had nowhere to say so, and a station whose
   * printer had been unplugged for a week looked exactly like one that worked.
   *
   * The tab is HERE, beside Yazıcılar, because a station is only ever half a
   * thing on its own - it is a printer's destination and a category's route,
   * and both of those are one tab away. It is not a plain list: the silent
   * misconfigurations are written on the row in the words the owner would use,
   * because "garson istasyona gönderemiyor" turned out to be a station nothing
   * routed to and there was no screen in the program that could have said so.
   *
   * "Siparişler nereye gitsin" is on the FORM rather than inferred from whether
   * a printer happens to be attached, and that is the point of it. This till is
   * screen-first - Ekranlar is the output and most of these restaurants own no
   * kitchen printer at all - so a station with nothing plugged into it is the
   * normal case, and the screen has to be able to tell it apart from a station
   * that was promised paper and is not getting any. Guessing from the printer
   * count could not: it painted every correct kitchen in the country as broken.
   */

  async fisStations() {
    const s = await api('GET', '/api/receipt/stations');
    this._fisSt = s;

    const broken = s.stations.filter(x => x.problems.length);
    const active = s.stations.filter(x => x.is_active);
    const label = (x) => x.display_name || x.name;

    $('#fisBody').innerHTML = `
      <div class="grid">
        ${broken.length ? `<div class="alert alert--warn">
          ${broken.length} istasyon eksik kurulmuş. Aşağıda kırmızıya değil, adının altına yazdık:
          kategorisi olmayan istasyona hiç sipariş düşmez, siparişini yazıcıya gönderdiğini
          söyleyip yazıcısı olmayan istasyonun fişi hiçbir yerden çıkmaz. Yazıcısı olmayan
          "Ekrana" istasyonu eksik değildir — bu programda olağan olan odur.</div>` : ''}
        ${s.unassigned_categories ? `<div class="alert alert--info">
          ${s.unassigned_categories} kategori hiçbir istasyona bağlı değil. Bu kategorilerin
          siparişleri mutfak panosunda "İstasyonsuz" başlığı altında birikir.</div>` : ''}

        <div class="split-4">
          <div class="stat"><div class="stat__label">İstasyon</div>
            <div class="stat__value">${s.stations.length}</div><div class="stat__sub">tanımlı</div></div>
          <div class="stat"><div class="stat__label">Etkin</div>
            <div class="stat__value">${active.length}</div><div class="stat__sub">sipariş alabilir</div></div>
          <div class="stat"><div class="stat__label">Eksik kurulmuş</div>
            <div class="stat__value">${broken.length}</div><div class="stat__sub">çıkışı ya da kategorisi eksik</div></div>
          <div class="stat"><div class="stat__label">Bağsız kategori</div>
            <div class="stat__value">${s.unassigned_categories}</div><div class="stat__sub">istasyonu seçilmemiş</div></div>
        </div>

        <div class="card">
          <div class="card__head"><h3>İstasyonlar</h3><div class="spacer"></div>
            <button class="btn btn--primary btn--sm" id="stAdd">İstasyon ekle</button></div>
          <table class="tbl">
            <thead><tr><th style="width:52px">Sıra</th><th>İstasyon</th><th>Kategori</th>
              <th>Siparişler</th><th>Yazıcı</th><th>Durum</th><th></th></tr></thead>
            <tbody>${s.stations.map((x, i) => `<tr${x.is_active ? '' : ' class="fis-st-off"'}>
              <td><span class="fis-st-ord">
                <button data-sup="${x.id}" ${i === 0 ? 'disabled' : ''} title="Yukarı">▲</button>
                <button data-sdn="${x.id}" ${i === s.stations.length - 1 ? 'disabled' : ''} title="Aşağı">▼</button>
              </span></td>
              <td>
                <span class="fis-st-name">${esc(label(x))}</span>
                ${x.is_default ? ' <span class="badge badge--open">varsayılan</span>' : ''}
                ${x.is_receipt_station ? ' <span class="badge badge--gray">fiş / kasa</span>' : ''}
                <div class="fis-st-key">yazıcı anahtarı: ${esc(x.name)}</div>
                ${x.problems.map(pr => `<span class="fis-st-warn">${esc(pr.text)}</span>`).join('')}
                ${x.last_active_with_categories ? `<span class="fis-st-warn">Son etkin istasyon.
                  Pasife alınırsa mutfak sipariş almayı bırakır.</span>` : ''}
              </td>
              <td>${x.category_count
                ? `<button class="fis-st-link" data-scat="${x.id}">${x.category_count} kategori</button>`
                : `<button class="fis-st-link" data-scat="${x.id}">Kategori bağla</button>`}</td>
              <td>${esc(x.output_mode_label || 'Ekrana')}</td>
              <td>${x.printers.length
                ? x.printers.map(pr => `<button class="fis-st-link" data-sprn="${pr.id}"
                    title="Yazıcılar sekmesinde aç">${esc(pr.name)}</button>`).join('<br>')
                : `<button class="fis-st-link" data-snewprn="${x.id}">Yazıcı bağla</button>`}</td>
              <td><span class="badge ${x.is_active ? 'badge--open' : 'badge--gray'}">
                ${x.is_active ? 'etkin' : 'pasif'}</span></td>
              <td class="right" style="white-space:nowrap">
                <button class="btn btn--ghost btn--sm" data-sedit="${x.id}">Düzenle</button>
                ${x.is_active
                  ? `<button class="btn btn--ghost btn--sm" data-soff="${x.id}">Pasife al</button>`
                  : `<button class="btn btn--ghost btn--sm" data-son="${x.id}">Geri aç</button>`}
                ${x.can_hard_delete ? `<button class="btn btn--danger btn--sm" data-sdel="${x.id}">Sil</button>` : ''}
              </td></tr>`).join('') || `<tr><td colspan="7" class="muted">Hiç istasyon yok.
                Mutfağa ve bara sipariş gidebilmesi için en az bir istasyon gerekir.</td></tr>`}
            </tbody></table>
          <div class="card__body"><p class="muted" style="margin:0;font-size:13px">
            Yeni istasyon "Ekrana" olarak açılır: siparişleri Ekranlar'da görünür ve yazıcı gerekmez.
            Yazıcı isteyen istasyonu "Yazıcıya" ya da "İkisine" çevirin.
            Sıra, mutfak panosundaki istasyon şeritlerinin sırasıdır. İstasyon adını değiştirmek
            serbesttir: açık adisyonlar ve panodaki fişler istasyona numarasıyla bağlıdır, adıyla değil.
            Kendisine sipariş gönderilmiş bir istasyon silinemez — pasife alınır, geçmiş raporlar bozulmasın diye.</p></div>
        </div>
      </div>`;

    const find = (id) => s.stations.find(x => Number(x.id) === Number(id));
    $('#stAdd').onclick = () => this.fisStationForm({}, s);
    $$('[data-sedit]').forEach(b => b.onclick = () => this.fisStationForm(find(b.dataset.sedit), s));
    $$('[data-scat]').forEach(b => b.onclick = () => this.fisStationCats(find(b.dataset.scat), s));

    /* The jump. The printer that serves this station, opened on the tab that
       owns printers - not a second copy of the printer form living here. */
    $$('[data-sprn]').forEach(b => b.onclick = () => {
      this._fisPrnJump = { printer_id: Number(b.dataset.sprn) };
      this.page_fis('yazici');
    });
    $$('[data-snewprn]').forEach(b => b.onclick = () => {
      const st = find(b.dataset.snewprn);
      this._fisPrnJump = { station_id: Number(st.id), station_label: label(st) + ' Yazıcı' };
      this.page_fis('yazici');
    });

    const move = async (id, dir) => {
      const ids = s.stations.map(x => Number(x.id));
      const i = ids.indexOf(Number(id));
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      try { await api('POST', '/api/receipt/stations/order', { ids }); this.fisStations(); }
      catch (e) { err(e); }
    };
    $$('[data-sup]').forEach(b => b.onclick = () => move(b.dataset.sup, -1));
    $$('[data-sdn]').forEach(b => b.onclick = () => move(b.dataset.sdn, 1));

    $$('[data-soff]').forEach(b => b.onclick = async () => {
      const st = find(b.dataset.soff);
      if (!await confirmBox(`"${label(st)}" pasife alınsın mı?`,
        'Pasif istasyon mutfak panosunda görünmez ve kendisine yeni sipariş düşmez. '
        + 'Geçmiş fişler ve raporlar olduğu gibi kalır.')) return;
      try {
        await api('POST', `/api/receipt/stations/${st.id}/active`, { active: false });
        toast('Pasife alındı', 'ok'); this.fisStations();
      } catch (e) { err(e); }
    });
    $$('[data-son]').forEach(b => b.onclick = async () => {
      try {
        await api('POST', `/api/receipt/stations/${b.dataset.son}/active`, { active: true });
        toast('Geri açıldı', 'ok'); this.fisStations();
      } catch (e) { err(e); }
    });
    $$('[data-sdel]').forEach(b => b.onclick = async () => {
      const st = find(b.dataset.sdel);
      if (!await confirmBox(`"${label(st)}" kalıcı olarak silinsin mi?`,
        'Bu istasyona hiç sipariş gönderilmemiş, bu yüzden silinebilir. Geri alınamaz.')) return;
      try { await api('DELETE', `/api/receipt/stations/${st.id}`); toast('Silindi', 'ok'); this.fisStations(); }
      catch (e) { err(e); }
    });
  },

  /**
   * Add or rename. The two names are kept apart on purpose and the form says
   * which is which: `name` is what the print agent routes on and is sent to the
   * printer verbatim, `display_name` is what the kitchen board and this screen
   * show. Restaurants want "Üst Kat Mutfak" on the board; a queue name with a
   * Turkish capital İ in it is how a slip silently stops printing.
   */
  fisStationForm(st, ctx) {
    st = st || {};
    modal(`<div class="modal__head"><h3>${st.id ? 'İstasyon' : 'Yeni istasyon'}</h3></div>
      <div class="modal__body">
        <div id="sfAlert"></div>
        <div class="split-2">
          <div class="field"><label>Görünen ad</label>
            <input class="input" id="sfLabel" value="${esc(st.display_name || st.name || '')}"
              placeholder="Mutfak">
            <div class="muted" style="font-size:12px;margin-top:5px">Mutfak panosunda ve bu ekranda yazan ad.</div></div>
          <div class="field"><label>Yazıcı anahtarı</label>
            <input class="input mono" id="sfName" value="${esc(st.name || '')}" placeholder="Mutfak">
            <div class="muted" style="font-size:12px;margin-top:5px">Yazıcıya olduğu gibi gider.
              Harf, rakam, boşluk, - ve _.</div></div>
        </div>
        <div class="field"><label>Siparişler nereye gitsin?</label>
          <select class="input" id="sfOut">
            ${[['screen', 'Ekrana'], ['printer', 'Yazıcıya'], ['both', 'İkisine']].map(([v, t]) =>
              `<option value="${v}"${(st.output_mode || 'screen') === v ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
          <div class="muted" style="font-size:12px;margin-top:5px">Ekrana: siparişler Ekranlar
            panosunda görünür, yazıcı gerekmez — çoğu işletme böyle çalışır. Yazıcıya ya da
            İkisine seçtiyseniz bu istasyona bir yazıcı bağlamanız gerekir.</div></div>
        <div class="split-2">
          <div class="field"><label>Panodaki sırası</label>
            <input class="input mono" id="sfOrder" type="number" min="0" step="1"
              value="${Number(st.sort_order || 0)}"></div>
          <div class="field"><label>Durum</label>
            <select class="input" id="sfActive">
              <option value="1"${st.id && !st.is_active ? '' : ' selected'}>Etkin</option>
              <option value="0"${st.id && !st.is_active ? ' selected' : ''}>Pasif</option>
            </select></div>
        </div>
        <label class="row"><input type="checkbox" id="sfDef" ${st.is_default ? 'checked' : ''}>
          <span>Varsayılan istasyon</span></label>
        <p class="muted" style="font-size:12.5px;margin-bottom:0">İstasyonu olmayan bir kategorinin
          siparişi varsayılan istasyona düşer. Adı değiştirmek açık adisyonları etkilemez.</p>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="sfOk">Kaydet</button></div>`);

    /* A new station gets its queue name typed for it from the visible one -
       nobody wants to fill two boxes with the same word, and the pair only
       diverges when somebody deliberately makes it. */
    if (!st.id) {
      $('#sfLabel').oninput = () => { $('#sfName').value = $('#sfLabel').value; };
    }

    $('#sfOk').onclick = async () => {
      try {
        await api('POST', '/api/receipt/stations', {
          id: st.id, name: $('#sfName').value.trim(), display_name: $('#sfLabel').value.trim(),
          output_mode: $('#sfOut').value,
          sort_order: Number($('#sfOrder').value) || 0,
          is_active: $('#sfActive').value === '1' ? 1 : 0,
          is_default: $('#sfDef').checked ? 1 : 0,
        });
        closeModal(); toast('Kaydedildi', 'ok'); this.fisStations();
      } catch (e) { $('#sfAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /** Which categories route here - the fix for the "kategori yok" warning. */
  fisStationCats(st, ctx) {
    const mine = ctx.categories.filter(c => Number(c.station_id) === Number(st.id)).map(c => Number(c.id));
    modal(`<div class="modal__head"><h3>${esc(st.display_name || st.name)} · kategoriler</h3></div>
      <div class="modal__body">
        <div id="scAlert"></div>
        <p class="muted" style="margin-top:0">İşaretli kategorilerin siparişleri bu istasyona düşer ve
          bu istasyonun yazıcısından çıkar. Bir kategori aynı anda tek bir istasyona bağlanabilir —
          işaretlediğiniz kategori varsa bağlı olduğu istasyondan alınır.</p>
        <div class="fis-cats">
          ${ctx.categories.map(c => `<label class="fis-chip${mine.includes(Number(c.id)) ? ' is-on' : ''}"
            data-cc="${c.id}">
            <input type="checkbox" data-cid="${c.id}" ${mine.includes(Number(c.id)) ? 'checked' : ''}>
            <span>${esc(c.name)}${c.station_id && Number(c.station_id) !== Number(st.id)
              ? ` <span class="badge badge--gray">${esc(c.station_name || 'başka istasyon')}</span>` : ''}</span>
          </label>`).join('') || '<p class="muted">Hiç kategori yok.</p>'}
        </div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="scOk">Kaydet</button></div>`);

    $$('.fis-cats [data-cid]').forEach(i => i.onchange = () =>
      i.closest('.fis-chip').classList.toggle('is-on', i.checked));

    $('#scOk').onclick = async () => {
      const ids = $$('.fis-cats [data-cid]:checked').map(i => Number(i.dataset.cid));
      try {
        const out = await api('POST', `/api/receipt/stations/${st.id}/categories`, { category_ids: ids });
        closeModal(); toast(out.assigned + ' kategori bu istasyona bağlandı', 'ok'); this.fisStations();
      } catch (e) { $('#scAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /* =================================================================== *
   * MÜŞTERİ EKRANI                                                       *
   * =================================================================== */

  async fisDisplay() {
    const r = await api('GET', '/api/receipt/display');
    const s = r.settings || {};
    this._fisDisp = { image: s.image_data || '', qr_svg: s.qr_svg || '' };

    $('#fisBody').innerHTML = `
      <div class="fis-wrap">
        <div class="grid">
          <div class="card">
            <div class="card__head"><h3>Karşılama yazısı</h3></div>
            <div class="card__body">
              <p class="muted" style="margin:0 0 14px;font-size:13px">Misafirin gördüğü ikinci ekran.
                Adisyon ve tutar zaten canlı gelir; buradan yalnızca yazılar ve küçük görsel değişir -
                ekranın düzeni aynı kalır.</p>
              <label class="row" style="cursor:pointer;margin-bottom:14px">
                <input type="checkbox" id="fdOn" ${Number(s.enabled) ? 'checked' : ''}>
                <span style="font-weight:500">Müşteri ekranını kullan</span></label>
              <div class="field"><label>Büyük yazı</label>
                <input class="input" id="fdHead" maxlength="120" value="${esc(s.headline || '')}"
                       placeholder="${esc(r.defaults.headline)}"></div>
              <div class="field"><label>Alt yazı</label>
                <input class="input" id="fdSub" maxlength="200" value="${esc(s.subline || '')}"
                       placeholder="${esc(r.defaults.subline)}"></div>
              <div class="field" style="margin-bottom:0"><label>Sol alt köşe yazısı</label>
                <input class="input" id="fdFoot" maxlength="120" value="${esc(s.foot_note || '')}"
                       placeholder="${esc(r.defaults.foot_note)}"></div>
            </div></div>

          <div class="card">
            <div class="card__head"><h3>Karekod</h3></div>
            <div class="card__body">
              <label class="row" style="cursor:pointer;margin-bottom:14px">
                <input type="checkbox" id="fdQrOn" ${Number(s.qr_enabled) ? 'checked' : ''}>
                <span style="font-weight:500">Ekranda küçük bir karekod göster</span></label>
              <div class="field"><label>Karekodun içi</label>
                <input class="input" id="fdQr" maxlength="500" value="${esc(s.qr_data || '')}"
                       placeholder="https://instagram.com/ornek · WIFI:S=Ornek;P=sifre;;">
                <div class="muted" style="font-size:12px;margin-top:5px">İnternet adresi, wifi bilgisi ya da düz yazı.
                  Karekod kaydederken üretilir, ekran her seferinde yeniden hesaplamaz.</div></div>
              <div class="field" style="margin-bottom:0"><label>Karekodun altındaki yazı</label>
                <input class="input" id="fdQrCap" maxlength="120" value="${esc(s.qr_caption || '')}"
                       placeholder="Bizi takip edin"></div>
            </div></div>

          <div class="card">
            <div class="card__head"><h3>Görsel</h3></div>
            <div class="card__body">
              <label class="row" style="cursor:pointer;margin-bottom:14px">
                <input type="checkbox" id="fdImgOn" ${Number(s.image_enabled) ? 'checked' : ''}>
                <span style="font-weight:500">Küçük bir görsel göster (logo ya da kampanya)</span></label>
              <div class="field"><label>Görsel dosyası</label>
                <input class="input" type="file" id="fdFile" accept="image/*">
                <div class="muted" style="font-size:12px;margin-top:5px">En fazla ${r.image_max_kb} KB.
                  Görsel veritabanında saklanır, böylece ekran başka bir bilgisayarda da açılır.</div></div>
              <div class="field"><label>Görselin altındaki yazı</label>
                <input class="input" id="fdImgCap" maxlength="120" value="${esc(s.image_caption || '')}"></div>
              <div class="field" style="margin-bottom:0"><label>Boyut</label>
                <select class="input" id="fdSize">
                  ${r.sizes.map(([k, l]) => `<option value="${k}"${(s.media_size || 'kucuk') === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}
                </select></div>
              ${s.image_data ? '<div class="muted" style="font-size:12.5px;margin-top:10px">Kayıtlı bir görsel var. Yeni dosya seçmezseniz aynı kalır.</div>' : ''}
            </div></div>

          <div class="card">
            <div class="card__head"><h3>Sosyal medya</h3></div>
            <div class="card__body">
              <label class="row" style="cursor:pointer;margin-bottom:14px">
                <input type="checkbox" id="fdSocOn" ${Number(s.social_enabled) ? 'checked' : ''}>
                <span style="font-weight:500">Hesaplarımızı ekranda göster</span></label>
              ${(r.socials || []).map(([k, l]) => `
                <div class="field"><label>${esc(l)}</label>
                  <input class="input" id="fdSoc_${k}" maxlength="80"
                    value="${esc(s['social_' + k] || '')}"
                    placeholder="${k === 'facebook' ? 'sayfaadi' : '@kullaniciadi'}"></div>`).join('')}
              <p class="muted" style="margin:0;font-size:12.5px">
                Adres yapıştırabilirsiniz — <b>instagram.com/…</b> ya da <b>@</b> yazsanız da
                sadece hesap adı görünür. Boş bıraktığınız hesap ekranda çıkmaz.</p>
            </div></div>

          <div class="row">
            <button class="btn btn--primary" id="fdSave">Kaydet</button>
            <button class="btn btn--ghost" id="fdOpen">Müşteri ekranını aç</button>
            <div class="spacer"></div>
            <span class="muted" id="fdState" style="font-size:13px"></span>
          </div>
        </div>

        <div class="card fis-sticky">
          <div class="card__head"><h3>Ekranın sol tarafı</h3></div>
          <div class="card__body">
            <p class="muted" style="margin:0 0 12px;font-size:12.5px">Sağdaki adisyon listesi ve tutar
              olduğu gibi kalır; değişen yalnızca burası.</p>
            <div class="fis-screen" id="fdPrev"></div>
          </div></div>
      </div>`;

    const paint = () => this.fisDisplayPreview();
    ['fdHead', 'fdSub', 'fdFoot', 'fdQr', 'fdQrCap', 'fdImgCap'].forEach(id => { $('#' + id).oninput = paint; });
    ['fdQrOn', 'fdImgOn', 'fdSize', 'fdSocOn'].forEach(id => { $('#' + id).onchange = paint; });
    (r.socials || []).forEach(([k]) => { $('#fdSoc_' + k).oninput = paint; });
    $('#fdOpen').onclick = () => window.open('/display.html', 'noktapp-display');

    /* The file never goes anywhere on its own: it is read into a data URI and
       posted with the rest of the form, so "seç" and "kaydet" are still two
       separate decisions. */
    $('#fdFile').onchange = () => {
      const f = $('#fdFile').files[0];
      if (!f) return;
      if (f.size > r.image_max_kb * 1024) {
        $('#fdState').textContent = `Görsel çok büyük (${Math.round(f.size / 1024)} KB).`;
        $('#fdFile').value = ''; return;
      }
      const fr = new FileReader();
      fr.onload = () => { this._fisDisp.image = String(fr.result); $('#fdImgOn').checked = true; paint(); };
      fr.readAsDataURL(f);
    };

    $('#fdSave').onclick = async () => {
      const btn = $('#fdSave'); btn.disabled = true;
      try {
        const out = await api('POST', '/api/receipt/display', {
          enabled: $('#fdOn').checked,
          headline: $('#fdHead').value, subline: $('#fdSub').value, foot_note: $('#fdFoot').value,
          qr_enabled: $('#fdQrOn').checked, qr_data: $('#fdQr').value, qr_caption: $('#fdQrCap').value,
          image_enabled: $('#fdImgOn').checked, image_data: this._fisDisp.image,
          image_caption: $('#fdImgCap').value, media_size: $('#fdSize').value,
          social_enabled: $('#fdSocOn').checked,
          ...Object.fromEntries((r.socials || []).map(([k]) => ['social_' + k, $('#fdSoc_' + k).value])),
        });
        this._fisDisp.qr_svg = (out.settings && out.settings.qr_svg) || '';
        toast('Müşteri ekranı kaydedildi', 'ok');
        this.fisDisplay();
      } catch (e) { err(e); btn.disabled = false; }
    };
    paint();
  },

  /** The left half of display.html, at a quarter of the size. The QR shown is
      the one already generated on the server; a QR that has not been saved yet
      shows as "kaydedince çizilir" rather than as a wrong picture. */
  fisDisplayPreview() {
    const d = this._fisDisp || {};
    const size = $('#fdSize').value === 'buyuk' ? 160 : $('#fdSize').value === 'orta' ? 130 : 96;
    const qrOn = $('#fdQrOn').checked, imgOn = $('#fdImgOn').checked;
    const media = [];
    if (qrOn) {
      media.push(`<div class="media" style="width:${size}px">${d.qr_svg
        ? d.qr_svg
        : '<div class="muted" style="font-size:10px;padding:12px;text-align:center;color:#8E8E96">Kaydedince çizilir</div>'}</div>
        ${$('#fdQrCap').value ? `<div class="cap">${esc($('#fdQrCap').value)}</div>` : ''}`);
    }
    if (imgOn && d.image) {
      media.push(`<div class="media" style="width:${size}px"><img src="${esc(d.image)}" alt=""></div>
        ${$('#fdImgCap').value ? `<div class="cap">${esc($('#fdImgCap').value)}</div>` : ''}`);
    }
    /* The same three marks the display draws, at preview scale. */
    const MARKS = {
      instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/>'
               + '<circle cx="17.2" cy="6.8" r="1.1" fill="#FF9A4D" stroke="none"/>',
      facebook: '<path d="M14.5 8.5h2.2V5.6h-2.4c-2.2 0-3.6 1.4-3.6 3.7v1.8H8.4v2.9h2.3V21h3.1v-7h2.4l.4-2.9h-2.8V9.6c0-.7.3-1.1.7-1.1z"/>',
      tiktok: '<path d="M14.4 3v10.9a3.3 3.3 0 1 1-2.7-3.2"/><path d="M14.4 3c.3 2.3 1.9 3.9 4.2 4.2"/>',
    };
    let socials = '';
    if ($('#fdSocOn') && $('#fdSocOn').checked) {
      const rows = ['instagram', 'facebook', 'tiktok'].map(k => {
        const el = $('#fdSoc_' + k);
        const v = el ? String(el.value || '').trim().replace(/^@+/, '') : '';
        if (!v) return '';
        const shown = (k === 'facebook' ? '' : '@') + v;
        return `<div class="soc"><svg viewBox="0 0 24 24">${MARKS[k]}</svg><b>${esc(shown)}</b></div>`;
      }).filter(Boolean).join('');
      if (rows) socials = `<div class="socs">${rows}</div>`;
    }
    $('#fdPrev').innerHTML = `
      <div style="display:flex;flex-direction:column">
        <h4>${esc($('#fdHead').value || 'Hoş geldiniz')}</h4>
        <p>${esc($('#fdSub').value || 'Afiyet olsun')}</p>
        ${socials}
        <div class="foot" style="margin-top:18px">${esc($('#fdFoot').value || 'NOKTApp POS')}</div>
      </div>
      <div>${media.join('') || '<div class="muted" style="font-size:11px;color:#7A7A85">Karekod ve görsel kapalı.</div>'}</div>`;
  },
});
