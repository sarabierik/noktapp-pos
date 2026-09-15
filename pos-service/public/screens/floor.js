/* =====================================================================
   NOKTApp POS - Kat planı: Masa düzeni, Rezervasyon, Mutfak panosu
   =====================================================================
   Three screens the old system could not give the owner:

   * MASA DÜZENİ - zones and tables were built once, by the first-run wizard,
     and then became unreachable. A restaurant that added a terrace in June had
     no way to say so. Everything the wizard can do is here, permanently, plus
     the things it never could: move a table between zones, set how many people
     it seats, put the tiles in the order the room is actually laid out.
   * REZERVASYON - the PHP could create and cancel, and that was all. No edit,
     no range, no warning when two parties were promised the same table at
     eight o'clock, and the one genuinely good idea it had - turning a booking
     into a real bill - was buried behind a form post.
   * MUTFAK PANOSU - a kitchen board with no sense of time is not a kitchen
     board. Tickets are grouped per adisyon, coloured by how long they have
     been waiting, filtered per station, and there is a history tab that
     answers "did that go out, and if not what happened to it".

   Same visual language as the rest of the till: .card, .tbl, .stat, .field,
   .badge, .table-card, one accent (orange), graphite for settled states.
   Nothing is green - late is red because late is the only thing on these
   screens that needs the eye pulled to it.
   ===================================================================== */
'use strict';

registerIcon('duzen',
  '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>'
  + '<rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7M17.5 14v7"/>');
registerIcon('rezervasyon',
  '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><circle cx="12" cy="15" r="2"/>');
registerIcon('mutfak',
  '<path d="M4 4h16v5H4z"/><path d="M6 9v11M18 9v11M4 14h16"/><path d="M9 12.5h6"/>');

registerPage({ id: 'duzen', label: 'Masa düzeni', icon: 'duzen', perm: 'table.manage' , group: 'tables' }, 'tables');
registerPage({ id: 'rezervasyon', label: 'Rezervasyon', icon: 'rezervasyon' , group: 'tables' }, 'duzen');
/*
 * "Ekranlar", not "Mutfak".
 *
 * The board is driven by whatever stations the restaurant configured - bar,
 * pide, tatli, a pass, a second kitchen - and calling the whole screen Mutfak
 * told a bartender it was not for him. The heading inside names the station
 * that is actually being shown.
 */
registerPage({ id: 'mutfak', label: 'Ekranlar', icon: 'mutfak' }, 'tables');

/* Status vocabulary, translated once here rather than in six templates. */
const RES_LABEL = { booked: 'Bekliyor', seated: 'Oturdu', done: 'Tamamlandı', cancelled: 'İptal', noshow: 'Gelmedi' };
const RES_BADGE = { booked: 'badge--open', seated: 'badge--closed', done: 'badge--gray',
  cancelled: 'badge--gray', noshow: 'fl-badge--red' };
const KIT_LABEL = { new: 'Yeni', preparing: 'Hazırlanıyor', ready: 'Hazır', served: 'Servis edildi', cancelled: 'İptal' };

/*
 * The handful of classes this area needs that app.css does not already have.
 * Injected from here rather than added to the shared stylesheet: they are only
 * ever used by these three screens, and a rule nobody else can accidentally
 * inherit is a rule nobody else can accidentally break.
 */
(function floorCss() {
  if (document.getElementById('flCss')) return;
  const s = document.createElement('style');
  s.id = 'flCss';
  s.textContent = `
    .fl-badge--red{background:var(--red-soft);color:var(--red);border:1px solid #F5C6C2}
    /* the age badge. Fresh is quiet on purpose - a board where everything
       shouts tells the kitchen nothing about what to cook next. */
    .fl-age{display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:12px;
      font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;
      background:var(--surface-2);color:var(--ink-3);border:1px solid var(--line)}
    .fl-age.is-warn{background:var(--orange-soft);color:var(--orange-dark);border-color:#FFD5B0}
    .fl-age.is-late{background:var(--red-soft);color:var(--red);border-color:#F5C6C2}
    .fl-tick{border-left:3px solid var(--line)}
    .fl-tick.is-warn{border-left-color:var(--orange)}
    .fl-tick.is-late{border-left-color:var(--red)}
    .fl-item{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--line)}
    .fl-item:last-child{border-bottom:0}
    .fl-qty{min-width:32px;height:26px;border-radius:6px;background:var(--ink);color:#fff;
      display:grid;place-items:center;font-size:13px;font-weight:700;flex:none}
    .fl-item.is-ready .fl-qty{background:var(--orange)}
    .fl-item.is-preparing .fl-qty{background:var(--ink-2)}
    .fl-note{font-size:12px;color:var(--orange-dark);margin-top:2px}
    .fl-drag{display:flex;flex-direction:column;gap:2px}
    .fl-drag button{width:26px;height:19px;border:1px solid var(--line);border-radius:5px;
      background:var(--surface);color:var(--ink-3);font-size:10px;line-height:1}
    .fl-drag button:hover{border-color:var(--orange);color:var(--orange-dark)}
    .fl-off{opacity:.5}
    /* karekod kartları - 6 to an A4 sheet, which is what the old print tip said */
    .fl-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
    .fl-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-lg);
      padding:14px;text-align:center}
    .fl-card svg{width:100%;height:auto;max-width:170px}
    .fl-card__brand{font-size:11px;color:var(--ink-3);letter-spacing:.4px;text-transform:uppercase}
    .fl-card__name{font-size:19px;font-weight:700;margin:6px 0 2px}
    .fl-card__zone{font-size:12px;color:var(--ink-3)}
    .fl-card__hint{font-size:11px;color:var(--ink-3);margin-top:6px}
    .fl-card__none{height:150px;display:grid;place-items:center;color:var(--ink-3);
      border:1px dashed var(--line-strong);border-radius:8px;font-size:12px}
    #flPrint{display:none}
    @media print{
      body{overflow:visible}
      .shell,.toast-wrap,.modal-back{display:none!important}
      #flPrint{display:block!important;padding:0}
      #flPrint .fl-cards{grid-template-columns:repeat(2,1fr);gap:10mm}
      #flPrint .fl-card{break-inside:avoid;border:1px dashed #999}
      .fl-noprint{display:none!important}
    }`;
  document.head.appendChild(s);
})();

Screens.add({

  /* remembered between visits so a half-finished job is one tap away */
  _flTab: 'alan',
  _flKitTab: 'aktif',
  _flStation: null,
  _flRes: null,

  /* ================================================================== */
  /* MASA DÜZENİ                                                        */
  /* ================================================================== */
  async page_duzen(tab) {
    if (tab) this._flTab = tab;
    const TABS = [['alan', 'Alanlar ve masalar'], ['qr', 'Karekod kartları']];
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Masa düzeni</h2><div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="dzZone">Alan ekle</button>
        <button class="btn btn--ghost btn--sm" id="dzBulk">Toplu masa</button>
        <button class="btn btn--primary btn--sm" id="dzTable">Masa ekle</button>
      </div>
      <div class="split-4" id="dzStats" style="margin-bottom:14px"></div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px" id="dzTabs">
        ${TABS.map(([id, label]) => `<button class="zone-tab${this._flTab === id ? ' is-active' : ''}"
          data-t="${id}">${label}</button>`).join('')}
      </div>
      <div id="dzBody"><div class="empty">Yükleniyor…</div></div></div>`;

    $$('#dzTabs [data-t]').forEach(b => b.onclick = () => this.page_duzen(b.dataset.t));
    $('#dzZone').onclick = () => this.flZoneForm({});
    $('#dzTable').onclick = () => this.flTableForm({});
    $('#dzBulk').onclick = () => this.flBulkForm();

    try {
      const [z, t] = await Promise.all([
        api('GET', '/api/floor/zones'),
        api('GET', '/api/floor/tables'),
      ]);
      this._zones = z.zones;
      this._tables = t.tables;
      const live = this._tables.filter(x => Number(x.is_active));
      $('#dzStats').innerHTML = [
        ['Alan', this._zones.length, 'aktif alan'],
        ['Masa', live.length, this._tables.length - live.length ? (this._tables.length - live.length) + ' kapalı' : 'hepsi açık'],
        ['Dolu masa', live.filter(x => x.open_bills > 0).length, 'açık adisyon var'],
        ['Karekodsuz', live.filter(x => !x.has_qr).length, 'kart basılamaz'],
      ].map(([l, v, s]) => `<div class="stat"><div class="stat__label">${l}</div>
        <div class="stat__value">${v}</div><div class="stat__sub">${esc(s)}</div></div>`).join('');

      if (this._flTab === 'alan') this.flLayout(); else await this.flQrTab();
    } catch (e) { err(e); }
  },

  flReload() { return this.page_duzen(this._flTab); },

  /** Zones down the left, the tables of the whole floor down the right. */
  flLayout() {
    const zones = this._zones;
    const tables = this._tables;
    const zoneName = (id) => (zones.find(z => z.id === id) || {}).name || 'Genel alan';

    $('#dzBody').innerHTML = `
      <div class="split-2" style="align-items:start;grid-template-columns:340px 1fr">
        <div class="card">
          <div class="card__head"><h3>Alanlar</h3><div class="spacer"></div>
            <span class="muted">${zones.length}</span></div>
          <div class="card__body" style="padding:0">
            ${zones.length ? `<table class="tbl"><tbody>${zones.map((z, i) => `
              <tr>
                <td style="width:34px">
                  <div class="fl-drag">
                    <button title="Yukarı" data-zup="${z.id}" data-i="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
                    <button title="Aşağı" data-zdn="${z.id}" data-i="${i}" ${i === zones.length - 1 ? 'disabled' : ''}>▼</button>
                  </div>
                </td>
                <td><div class="strong">${esc(z.name)}</div>
                  <div class="muted" style="font-size:12px">${z.table_count} masa</div></td>
                <td class="right" style="white-space:nowrap">
                  <button class="btn btn--ghost btn--sm" data-zed="${z.id}">Düzenle</button>
                  <button class="btn btn--danger btn--sm" data-zdel="${z.id}"
                    ${Number(z.table_count) ? 'disabled title="Önce masaları taşıyın"' : ''}>Sil</button>
                </td>
              </tr>`).join('')}</tbody></table>`
              : '<div class="empty">Henüz alan yok. Salon, teras, bahçe… ekleyin.</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Masalar</h3><div class="spacer"></div>
            <input class="input" id="dzSearch" placeholder="Masa ara" style="height:36px;width:200px">
          </div>
          <div class="card__body" style="padding:0">
            ${tables.length ? `<table class="tbl">
              <thead><tr><th style="width:34px"></th><th>Masa</th><th>Alan</th><th>Kişi</th>
                <th>Durum</th><th>Karekod</th><th class="right">İşlem</th></tr></thead>
              <tbody id="dzRows">${tables.map((t, i) => `
                <tr data-name="${esc(String(t.name).toLowerCase())}" class="${Number(t.is_active) ? '' : 'fl-off'}">
                  <td>
                    <div class="fl-drag">
                      <button title="Yukarı" data-tup="${t.id}" data-i="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
                      <button title="Aşağı" data-tdn="${t.id}" data-i="${i}" ${i === tables.length - 1 ? 'disabled' : ''}>▼</button>
                    </div>
                  </td>
                  <td class="strong">${esc(t.name)}</td>
                  <td class="muted">${esc(zoneName(t.zone_id))}</td>
                  <td class="mono">${t.seats === null ? '<span class="muted">—</span>' : t.seats}</td>
                  <td>${Number(t.is_active)
                      ? (t.open_bills > 0
                          ? `<span class="badge badge--open">${t.open_bills} adisyon</span>`
                          : '<span class="badge badge--gray">Boş</span>')
                      : '<span class="badge badge--gray">Kapalı</span>'}
                    ${t.upcoming_reservations ? `<span class="badge badge--closed" style="margin-left:4px">${t.upcoming_reservations} rez.</span>` : ''}</td>
                  <td>${t.has_qr ? '<span class="muted mono" style="font-size:12px">' + esc(String(t.qr_token).slice(0, 8)) + '…</span>'
                      : '<span class="badge fl-badge--red">Yok</span>'}</td>
                  <td class="right" style="white-space:nowrap">
                    <button class="btn btn--ghost btn--sm" data-ted="${t.id}">Düzenle</button>
                    ${Number(t.is_active)
                      ? `<button class="btn btn--danger btn--sm" data-toff="${t.id}">Kapat</button>`
                      : `<button class="btn btn--ghost btn--sm" data-ton="${t.id}">Aç</button>`}
                  </td>
                </tr>`).join('')}</tbody></table>`
              : '<div class="empty">Henüz masa yok. "Toplu masa" ile Masa 1…20 tek seferde kurulur.</div>'}
          </div>
        </div>
      </div>`;

    /* live search - the floor of a busy place is sixty rows long */
    const search = $('#dzSearch');
    if (search) {
      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        $$('#dzRows tr').forEach(tr => { tr.hidden = q && !tr.dataset.name.includes(q); });
      };
    }

    $$('[data-zed]').forEach(b => b.onclick = () =>
      this.flZoneForm(zones.find(z => z.id === Number(b.dataset.zed))));
    $$('[data-zdel]').forEach(b => b.onclick = async () => {
      const z = zones.find(x => x.id === Number(b.dataset.zdel));
      if (!await confirmBox('Alanı sil', `"${z.name}" alanı silinsin mi? Eski adisyonlar bu alanın adını taşımaya devam eder.`, true)) return;
      try { await api('DELETE', '/api/floor/zones/' + z.id); toast('Alan silindi', 'ok'); this.flReload(); }
      catch (e) { err(e); }
    });
    $$('[data-ted]').forEach(b => b.onclick = () =>
      this.flTableForm(tables.find(t => t.id === Number(b.dataset.ted))));
    $$('[data-toff]').forEach(b => b.onclick = async () => {
      const t = tables.find(x => x.id === Number(b.dataset.toff));
      if (!await confirmBox('Masayı kapat', `"${t.name}" kat planından kaldırılsın mı? Sonradan geri açabilirsiniz.`, true)) return;
      try { await api('POST', `/api/floor/tables/${t.id}/active`, { active: false }); toast('Masa kapatıldı', 'ok'); this.flReload(); }
      catch (e) { err(e); }
    });
    $$('[data-ton]').forEach(b => b.onclick = async () => {
      try { await api('POST', `/api/floor/tables/${b.dataset.ton}/active`, { active: true }); toast('Masa açıldı', 'ok'); this.flReload(); }
      catch (e) { err(e); }
    });

    /*
     * Reorder with arrows rather than drag-and-drop: this runs on a touch
     * screen with a cashier's thumb on it, and a drag that starts a scroll
     * instead is worse than no reordering at all.
     */
    const swap = async (list, i, j, url) => {
      const ids = list.map(x => x.id);
      const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
      try { await api('POST', url, { ids }); this.flReload(); } catch (e) { err(e); }
    };
    $$('[data-zup]').forEach(b => b.onclick = () => swap(zones, Number(b.dataset.i), Number(b.dataset.i) - 1, '/api/floor/zones/reorder'));
    $$('[data-zdn]').forEach(b => b.onclick = () => swap(zones, Number(b.dataset.i), Number(b.dataset.i) + 1, '/api/floor/zones/reorder'));
    $$('[data-tup]').forEach(b => b.onclick = () => swap(tables, Number(b.dataset.i), Number(b.dataset.i) - 1, '/api/floor/tables/reorder'));
    $$('[data-tdn]').forEach(b => b.onclick = () => swap(tables, Number(b.dataset.i), Number(b.dataset.i) + 1, '/api/floor/tables/reorder'));
  },

  flZoneForm(zone) {
    const z = zone || {};
    modal(`
      <div class="modal__head"><h3>${z.id ? 'Alanı düzenle' : 'Yeni alan'}</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div class="field"><label>Alan adı</label>
          <input class="input" id="zfName" value="${esc(z.name || '')}" placeholder="Salon, Teras, Bahçe…"></div>
        <div id="zfAlert"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="zfSave">Kaydet</button></div>`);
    $('#zfSave').onclick = async () => {
      try {
        await api('POST', '/api/floor/zones', { id: z.id, name: $('#zfName').value });
        closeModal(); toast('Alan kaydedildi', 'ok'); this.flReload();
      } catch (e) { $('#zfAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  flTableForm(table) {
    const t = table || {};
    const zones = this._zones || [];
    modal(`
      <div class="modal__head"><h3>${t.id ? 'Masayı düzenle' : 'Yeni masa'}</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div class="split-2">
          <div class="field"><label>Masa adı</label>
            <input class="input" id="tfName" value="${esc(t.name || '')}" placeholder="Masa 1"></div>
          <div class="field"><label>Kaç kişilik</label>
            <input class="input" id="tfSeats" type="number" min="0" max="99"
              value="${t.seats === null || t.seats === undefined ? '' : t.seats}" placeholder="4"></div>
        </div>
        <div class="field"><label>Alan</label>
          <select class="input" id="tfZone">
            <option value="">Genel alan</option>
            ${zones.map(z => `<option value="${z.id}"${Number(t.zone_id) === z.id ? ' selected' : ''}>${esc(z.name)}</option>`).join('')}
          </select></div>
        ${t.id ? `<div class="row" style="margin-top:4px">
          <button class="btn btn--ghost btn--sm" id="tfQr">Karekodu yenile</button>
          <span class="muted" style="font-size:12.5px">Yenilenince basılı kart çalışmaz.</span></div>` : ''}
        <div id="tfAlert"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="tfSave">Kaydet</button></div>`);
    if ($('#tfQr')) {
      $('#tfQr').onclick = async () => {
        if (!await confirmBox('Karekodu yenile',
          `"${t.name}" için basılmış bütün kartlar bu andan sonra çalışmaz. Devam edilsin mi?`, true)) return;
        try { await api('POST', `/api/floor/tables/${t.id}/qr`); toast('Karekod yenilendi', 'ok'); closeModal(); this.flReload(); }
        catch (e) { err(e); }
      };
    }
    $('#tfSave').onclick = async () => {
      try {
        await api('POST', '/api/floor/tables', {
          id: t.id, name: $('#tfName').value, zone_id: $('#tfZone').value || null,
          seats: $('#tfSeats').value === '' ? null : $('#tfSeats').value });
        closeModal(); toast('Masa kaydedildi', 'ok'); this.flReload();
      } catch (e) { $('#tfAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /** "Masa 1..20" in one go - what every new customer needs on day one. */
  flBulkForm() {
    const zones = this._zones || [];
    modal(`
      <div class="modal__head"><h3>Toplu masa oluştur</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">Ön ek ve numara aralığı verin: <b>Masa 1</b> … <b>Masa 20</b> gibi.</p>
        <div class="split-2">
          <div class="field"><label>Alan</label>
            <select class="input" id="bfZone"><option value="">Genel alan</option>
              ${zones.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Ön ek</label><input class="input" id="bfPrefix" value="Masa"></div>
        </div>
        <div class="split-3">
          <div class="field"><label>Başlangıç</label><input class="input" id="bfFrom" type="number" value="1"></div>
          <div class="field"><label>Bitiş</label><input class="input" id="bfTo" type="number" value="10"></div>
          <div class="field"><label>Kaç kişilik</label><input class="input" id="bfSeats" type="number" min="0" max="99" placeholder="4"></div>
        </div>
        <div id="bfAlert"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="bfSave">Oluştur</button></div>`);
    $('#bfSave').onclick = async () => {
      try {
        const r = await api('POST', '/api/floor/tables/bulk', {
          zone_id: $('#bfZone').value || null, prefix: $('#bfPrefix').value,
          from: $('#bfFrom').value, to: $('#bfTo').value,
          seats: $('#bfSeats').value === '' ? null : $('#bfSeats').value });
        closeModal(); toast(r.created + ' masa oluşturuldu', 'ok'); this.flReload();
      } catch (e) { $('#bfAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /* ---------------------------- karekod kartları --------------------- */
  async flQrTab() {
    const r = await api('GET', '/api/floor/qr/cards');
    const card = (c) => `
      <div class="fl-card">
        <div class="fl-card__brand">${esc(r.brand)}</div>
        ${c.svg ? c.svg : '<div class="fl-card__none">Karekod üretilmedi</div>'}
        <div class="fl-card__name">${esc(c.name)}</div>
        <div class="fl-card__zone">${esc(c.zone_name)}${c.seats ? ' · ' + c.seats + ' kişilik' : ''}</div>
        <div class="fl-card__hint">Menü için okutun</div>
      </div>`;

    $('#dzBody').innerHTML = `
      ${r.warnings.map(w => `<div class="alert alert--warn">${esc(w.text)}</div>`).join('')}
      <div class="card fl-noprint" style="margin-bottom:14px">
        <div class="card__body row">
          <div>
            <div class="strong">${r.cards.length} kart</div>
            <div class="muted" style="font-size:12.5px">A4 sayfaya 6 kart sığar. Yazdırırken
              "Kenar boşlukları: Yok" ve "Arka plan grafikleri: Açık" seçin.</div>
          </div>
          <div class="spacer"></div>
          ${r.missing ? `<button class="btn btn--ghost btn--sm" id="qrFill">Eksik karekodları üret (${r.missing})</button>` : ''}
          <button class="btn btn--primary btn--sm" id="qrPrint">Kartları yazdır</button>
        </div>
      </div>
      <div class="fl-cards">${r.cards.map(card).join('')}</div>`;

    if ($('#qrFill')) {
      $('#qrFill').onclick = async () => {
        try { const g = await api('POST', '/api/floor/qr/missing'); toast(g.generated + ' masa için karekod üretildi', 'ok'); this.flReload(); }
        catch (e) { err(e); }
      };
    }
    /*
     * Printing writes the sheet into a hidden container in this same document
     * rather than opening a second window: the till runs inside an Electron
     * shell where window.open is not guaranteed, and a print button that does
     * nothing on the customer's machine is worse than no print button.
     */
    $('#qrPrint').onclick = () => {
      let host = document.getElementById('flPrint');
      if (!host) { host = document.createElement('div'); host.id = 'flPrint'; document.body.appendChild(host); }
      host.innerHTML = `<div class="fl-cards">${r.cards.map(card).join('')}</div>`;
      window.print();
    };
  },

  /* ================================================================== */
  /* REZERVASYON                                                        */
  /* ================================================================== */
  async page_rezervasyon(range) {
    const today = new Date().toISOString().slice(0, 10);
    if (range) this._flRes = range;
    if (!this._flRes) this._flRes = { from: today, to: today, status: '' };
    const R = this._flRes;

    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Rezervasyonlar</h2><div class="spacer"></div>
        <button class="btn btn--primary btn--sm" id="rvNew">Yeni rezervasyon</button>
      </div>
      <div class="card" style="margin-bottom:14px"><div class="card__body row" style="flex-wrap:wrap;gap:10px">
        <div class="field" style="margin:0"><label>Başlangıç</label>
          <input class="input" id="rvFrom" type="date" value="${R.from}" style="height:38px"></div>
        <div class="field" style="margin:0"><label>Bitiş</label>
          <input class="input" id="rvTo" type="date" value="${R.to}" style="height:38px"></div>
        <div class="field" style="margin:0"><label>Durum</label>
          <select class="input" id="rvStatus" style="height:38px;width:150px">
            <option value="">Hepsi</option>
            ${Object.entries(RES_LABEL).map(([k, v]) => `<option value="${k}"${R.status === k ? ' selected' : ''}>${v}</option>`).join('')}
          </select></div>
        <div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="rvToday">Bugün</button>
        <button class="btn btn--ghost btn--sm" id="rvWeek">7 gün</button>
        <button class="btn btn--dark btn--sm" id="rvGo">Listele</button>
        <button class="btn btn--ghost btn--sm" id="rvPdf" title="Listeyi yazdırmak için indir">PDF</button>
        <button class="btn btn--ghost btn--sm" id="rvXls" title="Excel'de aç">Excel</button>
      </div></div>
      <div class="split-4" id="rvStats" style="margin-bottom:14px"></div>
      <div id="rvBody"><div class="empty">Yükleniyor…</div></div></div>`;

    const apply = () => this.page_rezervasyon({
      from: $('#rvFrom').value, to: $('#rvTo').value, status: $('#rvStatus').value });
    $('#rvGo').onclick = apply;
    $('#rvStatus').onchange = apply;
    $('#rvToday').onclick = () => this.page_rezervasyon({ from: today, to: today, status: R.status });
    $('#rvWeek').onclick = () => this.page_rezervasyon({
      from: today, to: new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10), status: R.status });
    $('#rvNew').onclick = () => this.flResForm({ date: R.from });
    /*
     * The list, on paper. On a full Saturday the reservations live at the host
     * stand next to the telephone, and the host stand is not where the till
     * is - so the screen only replaces the diary if it can still produce the
     * page somebody writes on. Whatever is filtered on screen is what comes
     * out: same dates, same status, same rows.
     */
    const exq = () => `from=${encodeURIComponent($('#rvFrom').value)}`
      + `&to=${encodeURIComponent($('#rvTo').value)}`
      + ($('#rvStatus').value ? `&status=${encodeURIComponent($('#rvStatus').value)}` : '');
    $('#rvPdf').onclick = (e) => this.download(`/api/floor/reservations/export?${exq()}&format=pdf`, e.currentTarget);
    $('#rvXls').onclick = (e) => this.download(`/api/floor/reservations/export?${exq()}&format=xlsx`, e.currentTarget);

    try {
      const [r, t] = await Promise.all([
        api('GET', `/api/floor/reservations?from=${R.from}&to=${R.to}${R.status ? '&status=' + R.status : ''}`),
        api('GET', '/api/floor/tables?all=0'),
      ]);
      this._tables = t.tables;
      const S = r.summary;
      $('#rvStats').innerHTML = [
        ['Bekleyen', S.booked, 'henüz gelmedi'],
        ['Misafir', S.guests, 'bekleyen rezervasyonlarda'],
        ['Oturdu', S.seated, 'adisyonu açıldı'],
        ['Gelmedi / iptal', S.noshow + S.cancelled, S.noshow + ' gelmedi, ' + S.cancelled + ' iptal'],
      ].map(([l, v, s]) => `<div class="stat"><div class="stat__label">${l}</div>
        <div class="stat__value">${v}</div><div class="stat__sub">${esc(s)}</div></div>`).join('');
      this.flResRows(r.rows);
    } catch (e) { err(e); }
  },

  flResReload() { return this.page_rezervasyon(this._flRes); },

  flResRows(rows) {
    if (!rows.length) {
      $('#rvBody').innerHTML = '<div class="empty">Bu tarihlerde rezervasyon yok.</div>';
      return;
    }
    $('#rvBody').innerHTML = `<div class="card"><div class="card__body" style="padding:0">
      <table class="tbl">
        <thead><tr><th>Tarih</th><th>Saat</th><th>Misafir</th><th>Kişi</th><th>Masa</th>
          <th>Durum</th><th class="right">İşlem</th></tr></thead>
        <tbody>${rows.map(r => `
          <tr>
            <td class="mono">${esc(String(r.starts_at).slice(0, 10))}</td>
            <td class="mono strong">${esc(String(r.starts_at).slice(11, 16))}</td>
            <td>
              <div class="strong">${esc(r.guest_name)}</div>
              ${r.guest_phone ? `<div class="muted" style="font-size:12px">${esc(r.guest_phone)}</div>` : ''}
              ${r.note ? `<div class="fl-note">${esc(r.note)}</div>` : ''}
            </td>
            <td class="mono">${r.party_size}</td>
            <td>${r.table_name ? esc(r.table_name) : '<span class="muted">Masasız</span>'}</td>
            <td><span class="badge ${RES_BADGE[r.status] || 'badge--gray'}">${esc(RES_LABEL[r.status] || r.status)}</span></td>
            <td class="right" style="white-space:nowrap">
              ${r.status === 'booked' ? `
                <button class="btn btn--primary btn--sm" data-seat="${r.id}">Masaya otur</button>
                <button class="btn btn--ghost btn--sm" data-edit="${r.id}">Düzenle</button>
                <button class="btn btn--ghost btn--sm" data-noshow="${r.id}">Gelmedi</button>
                <button class="btn btn--danger btn--sm" data-cancel="${r.id}">İptal</button>` : ''}
              ${r.status === 'seated' ? `
                <button class="btn btn--dark btn--sm" data-goto="${r.order_id}">Adisyona git</button>
                <button class="btn btn--ghost btn--sm" data-done="${r.id}">Tamamlandı</button>` : ''}
              ${r.status === 'cancelled' || r.status === 'noshow'
                ? `<button class="btn btn--ghost btn--sm" data-reopen="${r.id}">Geri al</button>` : ''}
            </td>
          </tr>`).join('')}</tbody></table></div></div>`;

    const move = async (id, status, ask) => {
      if (ask && !await confirmBox(ask[0], ask[1], true)) return;
      try { await api('POST', `/api/floor/reservations/${id}/status`, { status }); toast('Kaydedildi', 'ok'); this.flResReload(); }
      catch (e) { err(e); }
    };
    $$('[data-noshow]').forEach(b => b.onclick = () => move(b.dataset.noshow, 'noshow',
      ['Gelmedi', 'Misafir gelmedi olarak işaretlensin mi? Masa boşa çıkar.']));
    $$('[data-cancel]').forEach(b => b.onclick = () => move(b.dataset.cancel, 'cancelled',
      ['Rezervasyonu iptal et', 'Bu rezervasyon iptal edilsin mi?']));
    $$('[data-done]').forEach(b => b.onclick = () => move(b.dataset.done, 'done'));
    $$('[data-reopen]').forEach(b => b.onclick = () => move(b.dataset.reopen, 'booked'));
    $$('[data-edit]').forEach(b => b.onclick = () =>
      this.flResForm(rows.find(r => r.id === Number(b.dataset.edit))));
    $$('[data-goto]').forEach(b => b.onclick = () => go('order', Number(b.dataset.goto)));

    /*
     * SEAT - the whole reason reservations live in the till. The booking stops
     * being a note and becomes a bill on a table, opened through the same path
     * a waiter uses, so it is numbered and labelled like every other adisyon.
     */
    $$('[data-seat]').forEach(b => b.onclick = async () => {
      const r = rows.find(x => x.id === Number(b.dataset.seat));
      let tableId = r.table_id;
      if (!tableId) {
        tableId = await this.flPickTable('Misafir hangi masaya oturuyor?');
        if (!tableId) return;
      }
      try {
        const s = await api('POST', `/api/floor/reservations/${r.id}/seat`, { table_id: tableId });
        toast(r.guest_name + ' masaya oturtuldu', 'ok');
        go('order', s.order_id);              // straight into the bill, like the old system did
      } catch (e) { err(e); }
    });
  },

  /** A table chooser for a booking that was taken without one. */
  flPickTable(title) {
    const tables = (this._tables || []).filter(t => Number(t.is_active));
    return new Promise((resolve) => {
      modal(`
        <div class="modal__head"><h3>${esc(title)}</h3><div class="spacer"></div>
          <button class="close-x" onclick="closeModal()">✕</button></div>
        <div class="modal__body">
          <div class="plan__grid" style="padding:0;grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">
            ${tables.map(t => `<button class="table-card${t.open_bills > 0 ? ' is-busy' : ''}" data-pk="${t.id}">
              <div class="table-card__name">${esc(t.name)}</div>
              <div class="table-card__meta"><span class="table-card__dot"></span>${
                t.open_bills > 0 ? t.open_bills + ' adisyon' : (t.seats ? t.seats + ' kişilik' : 'Boş')}</div>
            </button>`).join('') || '<div class="empty">Masa yok.</div>'}
          </div>
        </div>`, { wide: true });
      $$('[data-pk]').forEach(b => b.onclick = () => { closeModal(); resolve(Number(b.dataset.pk)); });
      $('#modalBack').addEventListener('mousedown', function once(e) {
        if (e.target.id === 'modalBack') { $('#modalBack').removeEventListener('mousedown', once); resolve(null); }
      });
    });
  },

  /**
   * The booking form.
   *
   * The clash check runs while the form is open, not after Kaydet: telling
   * someone the table is taken AFTER they have read the guest their booking
   * time back over the phone is telling them too late.
   */
  flResForm(res) {
    const r = res || {};
    const tables = (this._tables || []).filter(t => Number(t.is_active));
    const date = r.starts_at ? String(r.starts_at).slice(0, 10) : (r.date || new Date().toISOString().slice(0, 10));
    const time = r.starts_at ? String(r.starts_at).slice(11, 16) : '19:00';
    modal(`
      <div class="modal__head"><h3>${r.id ? 'Rezervasyonu düzenle' : 'Yeni rezervasyon'}</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div class="split-2">
          <div class="field"><label>Misafir adı</label>
            <input class="input" id="rfName" value="${esc(r.guest_name || '')}" placeholder="Yılmaz Ailesi"></div>
          <div class="field"><label>Telefon</label>
            <input class="input" id="rfPhone" value="${esc(r.guest_phone || '')}" placeholder="05xx"></div>
        </div>
        <div class="split-4">
          <div class="field"><label>Tarih</label><input class="input" id="rfDate" type="date" value="${date}"></div>
          <div class="field"><label>Saat</label><input class="input" id="rfTime" type="time" value="${time}"></div>
          <div class="field"><label>Kişi</label>
            <input class="input" id="rfParty" type="number" min="1" value="${r.party_size || 2}"></div>
          <div class="field"><label>Süre (dk)</label>
            <input class="input" id="rfDur" type="number" min="15" step="15" value="${r.duration_min || 120}"></div>
        </div>
        <div class="field"><label>Masa</label>
          <select class="input" id="rfTable">
            <option value="">Masasız (sonra seçilecek)</option>
            ${tables.map(t => `<option value="${t.id}"${Number(r.table_id) === t.id ? ' selected' : ''}>${esc(t.name)}${t.seats ? ' · ' + t.seats + ' kişilik' : ''}</option>`).join('')}
          </select></div>
        <div class="field"><label>Not</label>
          <input class="input" id="rfNote" value="${esc(r.note || '')}" placeholder="Doğum günü, pencere kenarı…"></div>
        <div id="rfWarn"></div>
        <div id="rfAlert"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="rfSave">Kaydet</button></div>`);

    let forced = false;
    const check = async () => {
      const tid = $('#rfTable').value;
      $('#rfWarn').innerHTML = '';
      forced = false;
      if (!tid || !$('#rfDate').value || !$('#rfTime').value) return;
      try {
        const q = await api('GET', '/api/floor/reservations/conflicts'
          + `?table_id=${tid}&starts_at=${$('#rfDate').value} ${$('#rfTime').value}:00`
          + `&duration_min=${$('#rfDur').value || 120}${r.id ? '&exclude_id=' + r.id : ''}`);
        if (!q.conflicts.length) return;
        forced = true;                       // saving now is a deliberate override
        $('#rfWarn').innerHTML = `<div class="alert alert--warn">Bu masa aynı saatte
          ${q.conflicts.map(c => esc(c.guest_name) + ' (' + String(c.starts_at).slice(11, 16) + ')').join(', ')}
          adına ayrılmış. Yine de kaydederseniz iki rezervasyon aynı masayı paylaşır.</div>`;
      } catch (_) { /* the check is advice; never let it block the form */ }
    };
    ['#rfTable', '#rfDate', '#rfTime', '#rfDur'].forEach(s => { $(s).onchange = check; });
    check();

    $('#rfSave').onclick = async () => {
      const body = {
        guest_name: $('#rfName').value, guest_phone: $('#rfPhone').value,
        party_size: $('#rfParty').value, duration_min: $('#rfDur').value,
        table_id: $('#rfTable').value || null, note: $('#rfNote').value,
        date: $('#rfDate').value, time: $('#rfTime').value, force: forced,
      };
      try {
        const out = r.id
          ? await api('PUT', '/api/floor/reservations/' + r.id, body)
          : await api('POST', '/api/floor/reservations', body);
        closeModal();
        (out.warnings || []).forEach(w => toast(w.text));
        toast('Rezervasyon kaydedildi', 'ok');
        this.flResReload();
      } catch (e) { $('#rfAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /* ================================================================== */
  /* MUTFAK PANOSU                                                      */
  /* ================================================================== */
  async page_mutfak(tab) {
    if (tab) this._flKitTab = tab;
    $('#main').innerHTML = `<div class="page is-on" id="pgMutfak">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">İstasyon ekranları</h2>
        <div class="spacer"></div>
        <div class="row" id="mtTabs" style="gap:8px">
          <button class="zone-tab${this._flKitTab === 'aktif' ? ' is-active' : ''}" data-k="aktif">Aktif</button>
          <button class="zone-tab${this._flKitTab === 'gecmis' ? ' is-active' : ''}" data-k="gecmis">Geçmiş</button>
        </div>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px" id="mtStations"></div>
      <div id="mtBody"><div class="empty">Yükleniyor…</div></div></div>`;
    $$('#mtTabs [data-k]').forEach(b => b.onclick = () => this.page_mutfak(b.dataset.k));

    try {
      const st = await api('GET', '/api/floor/kitchen/stations');
      const chips = [{ id: '', name: 'Tümü', pending: st.stations.reduce((s, x) => s + x.pending, 0) }]
        .concat(st.stations.map(s => ({ id: String(s.id), name: s.display_name || s.name, pending: s.pending })));
      if (st.unassigned) chips.push({ id: 'unassigned', name: 'İstasyonsuz', pending: st.unassigned });
      const active = this._flStation === null ? '' : this._flStation;
      $('#mtStations').innerHTML = chips.map(c =>
        `<button class="zone-tab${String(active) === c.id ? ' is-active' : ''}" data-s="${c.id}">
          ${esc(c.name)}${c.pending ? ' · ' + c.pending : ''}</button>`).join('');
      $$('#mtStations [data-s]').forEach(b => b.onclick = () => {
        this._flStation = b.dataset.s; this.page_mutfak();
      });

      if (this._flKitTab === 'aktif') await this.flBoard(); else await this.flHistory();
      this.flKitchenPoll();
    } catch (e) { err(e); }
  },

  /*
   * The board refreshes itself every seven seconds, the interval the old PHP
   * used and the kitchen is used to. There is no teardown hook in the shell, so
   * the timer checks whether its own page is still on screen and stops itself -
   * a poll that outlives its screen is a poll that fights the next one.
   */
  flKitchenPoll() {
    clearInterval(this._flTimer);
    this._flTimer = setInterval(() => {
      if (App.page !== 'mutfak' || !document.getElementById('pgMutfak')) { clearInterval(this._flTimer); return; }
      if ($('#modalBack').classList.contains('is-on')) return;   // never redraw under an open dialog
      (this._flKitTab === 'aktif' ? this.flBoard() : this.flHistory()).catch(() => {});
    }, 7000);
  },

  stationQuery() {
    const s = this._flStation;
    return s ? '?station_id=' + encodeURIComponent(s) : '';
  },

  async flBoard() {
    const r = await api('GET', '/api/floor/kitchen/board' + this.stationQuery());
    setBadge('mutfak', r.counts.new);
    if (!r.tickets.length) {
      $('#mtBody').innerHTML = '<div class="empty">Bekleyen sipariş yok.</div>';
      return;
    }
    $('#mtBody').innerHTML = `
      <div class="row" style="margin-bottom:12px;gap:10px">
        <span class="chip"><b>${r.counts.tickets}</b> adisyon</span>
        <span class="chip"><b>${r.counts.items}</b> satır</span>
        ${r.counts.warn ? `<span class="chip chip--warn"><b>${r.counts.warn}</b> ${r.thresholds.warn} dk üzeri</span>` : ''}
        ${r.counts.late ? `<span class="chip" style="background:var(--red-soft);border-color:#F5C6C2;color:var(--red)">
          <b>${r.counts.late}</b> ${r.thresholds.late} dk üzeri</span>` : ''}
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(290px,1fr))">
        ${r.tickets.map(t => `
          <div class="card fl-tick is-${t.age_level}">
            <div class="card__head">
              <b>${esc(t.table_name)}</b>
              ${t.bill_label ? `<span class="badge badge--gray">${esc(t.bill_label)}</span>` : ''}
              <div class="spacer"></div>
              <span class="fl-age is-${t.age_level}">${esc(t.age_text)}</span>
            </div>
            <div class="card__body" style="padding:4px 16px 12px">
              ${t.items.map(i => `
                <div class="fl-item is-${i.station_status}">
                  <div class="fl-qty">${i.qty}</div>
                  <div style="flex:1;min-width:0">
                    <div class="strong">${esc(i.product_name)}</div>
                    ${i.note ? `<div class="fl-note">${esc(i.note)}</div>` : ''}
                    <div class="muted" style="font-size:11.5px">${esc(KIT_LABEL[i.station_status] || i.station_status)}${
                      i.station_name ? ' · ' + esc(i.station_name) : ''}</div>
                    <div class="row" style="gap:6px;margin-top:6px">
                      <button class="btn btn--ghost btn--sm" data-st="preparing" data-id="${i.id}">Hazırlanıyor</button>
                      <button class="btn btn--ghost btn--sm" data-st="ready" data-id="${i.id}">Hazır</button>
                      <button class="btn btn--dark btn--sm" data-st="served" data-id="${i.id}">Servis</button>
                    </div>
                  </div>
                </div>`).join('')}
              <div class="row" style="margin-top:10px">
                <button class="btn btn--ghost btn--sm" data-all="ready" data-ids="${t.items.map(i => i.id).join(',')}">Hepsi hazır</button>
                <button class="btn btn--dark btn--sm" data-all="served" data-ids="${t.items.map(i => i.id).join(',')}">Masaya çıktı</button>
              </div>
            </div>
          </div>`).join('')}
      </div>`;

    const set = async (ids, state) => {
      try {
        for (const id of ids) await api('POST', `/api/floor/kitchen/items/${id}/state`, { state });
        if (navigator.vibrate) navigator.vibrate(10);
        this.flBoard();
      } catch (e) { err(e); }
    };
    $$('#mtBody [data-st]').forEach(b => b.onclick = () => set([b.dataset.id], b.dataset.st));
    $$('#mtBody [data-all]').forEach(b => b.onclick = () => set(b.dataset.ids.split(','), b.dataset.all));
  },

  /**
   * Geçmiş - what this station actually put out today, cancellations included.
   * A history that hides the cancellations cannot answer the only question
   * anybody asks it: "that table says their food never came, what happened?"
   */
  async flHistory(date) {
    if (date) this._flDate = date;
    const d = this._flDate || new Date().toISOString().slice(0, 10);
    const q = this.stationQuery();
    const r = await api('GET', `/api/floor/kitchen/history${q ? q + '&' : '?'}date=${d}`);
    $('#mtBody').innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="card__body row" style="gap:10px">
        <div class="field" style="margin:0"><label>Tarih</label>
          <input class="input" id="htDate" type="date" value="${d}" style="height:38px"></div>
        <div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="htToday">Bugün</button>
      </div></div>
      <div class="split-4" style="margin-bottom:14px">
        ${[['Gönderilen', r.summary.total, 'adet'], ['Servis edilen', r.summary.served, 'adet'],
           ['Bekleyen', r.summary.open, 'adet'], ['Ortalama süre', r.summary.avg_min, 'dakika']]
          .map(([l, v, s]) => `<div class="stat"><div class="stat__label">${l}</div>
            <div class="stat__value">${v}</div><div class="stat__sub">${s}</div></div>`).join('')}
      </div>
      ${r.summary.cancelled ? `<div class="alert alert--warn">Bu gün ${r.summary.cancelled} adet iptal edildi.</div>` : ''}
      <div class="card"><div class="card__body" style="padding:0">
        ${r.rows.length ? `<table class="tbl">
          <thead><tr><th>Saat</th><th>Masa</th><th>Ürün</th><th>Adet</th><th>Süre</th><th>Durum</th></tr></thead>
          <tbody>${r.rows.map(x => `
            <tr>
              <td class="mono">${esc(String(x.sent_at).slice(11, 16))}</td>
              <td>${esc(x.table_name)}</td>
              <td><div>${esc(x.product_name)}</div>${x.note ? `<div class="fl-note">${esc(x.note)}</div>` : ''}</td>
              <td class="mono">${x.qty}</td>
              <td class="mono muted">${esc(x.took_text)}</td>
              <td><span class="badge ${x.status === 'served' ? 'badge--closed'
                  : x.status === 'cancelled' ? 'fl-badge--red' : 'badge--open'}">${esc(KIT_LABEL[x.status] || x.status)}</span></td>
            </tr>`).join('')}</tbody></table>` : '<div class="empty">Bu tarihte kayıt yok.</div>'}
      </div></div>`;
    $('#htDate').onchange = () => this.flHistory($('#htDate').value);
    $('#htToday').onclick = () => this.flHistory(new Date().toISOString().slice(0, 10));
  },
});
