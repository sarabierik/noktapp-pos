/* =====================================================================
   NOKTApp POS - Stok / Depo
   =====================================================================
   The whole warehouse on one page, with a strip of tabs across the top,
   because the person using it is standing in a stockroom holding a phone in
   one hand and a crate in the other: eight separate menu entries would be
   eight wrong taps. The old system spread the same job over nine PHP pages
   and its stock screen was read-only - no button on it wrote anything.

   Same visual language as the rest of the till: .card, .tbl, .stat, .field,
   .badge, one accent (orange), success states in graphite. Nothing new is
   invented here and nothing is green.
   ===================================================================== */
'use strict';

/* The unit codes are an enum in the database and English there; the till is
   Turkish, so they are translated once, here, rather than in nine templates. */
const INV_UNITS = { pcs: 'Adet', kg: 'Kg', g: 'Gram', lt: 'Litre', ml: 'ml', pack: 'Paket' };
function inv_unit(u) { return INV_UNITS[u] || u || ''; }

registerIcon('stock',
  '<path d="M3 7l9-4 9 4v10l-9 4-9-4V7z"/><path d="M3 7l9 4 9-4M12 11v10"/><path d="M7.5 5.2l9 4"/>');
registerPage({ id: 'stock', label: 'Stok', icon: 'stock', perm: 'stock.manage' }, 'products');

Screens.add({

  /* remembered between visits so a half-finished sayim is one tap away */
  _stockTab: 'genel',

  async page_stock(tab) {
    if (tab) this._stockTab = tab;
    const TABS = [
      ['genel', 'Genel'],
      ['seviye', 'Stok durumu'],
      ['alis', 'Alış faturaları'],
      ['recete', 'Reçeteler'],
      ['sayim', 'Sayım'],
      ['zayi', 'Zayi'],
      ['transfer', 'Depo transferi'],
      ['tanim', 'Malzeme & tedarikçi'],
    ];
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Stok</h2><div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="skWaste">Zayi gir</button>
        <button class="btn btn--primary btn--sm" id="skNewDoc">Alış faturası</button>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px" id="skTabs">
        ${TABS.map(([id, label]) => `<button class="zone-tab${this._stockTab === id ? ' is-active' : ''}"
          data-t="${id}">${label}</button>`).join('')}
      </div>
      <div id="skBody"><div class="empty">Yükleniyor…</div></div></div>`;

    $$('#skTabs [data-t]').forEach(b => b.onclick = () => this.page_stock(b.dataset.t));
    $('#skNewDoc').onclick = () => this.stockDocForm({});
    $('#skWaste').onclick = () => this.stockWasteForm();

    const draw = {
      genel: () => this.stockOverview(),
      seviye: () => this.stockLevels(),
      alis: () => this.stockDocuments(),
      recete: () => this.stockRecipes(),
      sayim: () => this.stockCounts(),
      zayi: () => this.stockWaste(),
      transfer: () => this.stockTransfers(),
      tanim: () => this.stockDefinitions(),
    };
    try { await draw[this._stockTab](); } catch (e) { err(e); }
  },

  /** Redraw the current tab after a write, without losing where the user was. */
  stockReload() { return this.page_stock(this._stockTab); },

  /* ------------------------------------------------------------ genel */
  /*
   * Four tiles and the short list nobody wants to read but everybody needs:
   * what is about to run out. The old dashboard showed a total quantity - the
   * sum of kilos and bottles and litres, a number that means nothing - and had
   * no reorder level at all, only a filter box you retyped every visit.
   */
  async stockOverview() {
    const s = (await api('GET', '/api/inventory/summary')).summary;
    const crit = (await api('GET', '/api/inventory/levels?critical=1')).levels;
    const orphans = (await api('GET', '/api/inventory/orphans')).orphans;
    $('#skBody').innerHTML = `
      <div class="split-4">
        <div class="stat"><div class="stat__label">Stok değeri</div>
          <div class="stat__value">${tl(s.total_value)} ₺</div>
          <div class="stat__sub">${s.item_count} malzeme</div></div>
        <div class="stat"><div class="stat__label">Kritik seviye</div>
          <div class="stat__value">${s.critical_count}</div>
          <div class="stat__sub">azalan malzeme</div></div>
        <div class="stat"><div class="stat__label">Onay bekleyen fatura</div>
          <div class="stat__value">${s.draft_documents}</div>
          <div class="stat__sub">onaylanana kadar stoğa girmez</div></div>
        <div class="stat"><div class="stat__label">Açık sayım</div>
          <div class="stat__value">${s.open_counts}</div>
          <div class="stat__sub">${s.negative_count ? s.negative_count + ' malzeme eksi bakiyede' : 'eksi bakiye yok'}</div></div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Kritik seviyedeki malzemeler</h3><div class="spacer"></div>
          <button class="btn btn--primary btn--sm" id="skoBuy">Alış faturası gir</button></div>
        ${crit.length ? `<table class="tbl"><thead><tr>
          <th>Malzeme</th><th class="right">Kalan</th><th class="right">Kritik seviye</th>
          <th class="right">Birim maliyet</th><th></th></tr></thead><tbody>
          ${crit.map(r => `<tr>
            <td><b>${esc(r.name)}</b></td>
            <td class="right mono"><span class="badge badge--open">${tl(r.qty)} ${esc(r.unit_label)}</span></td>
            <td class="right mono muted">${tl(r.min_qty)}</td>
            <td class="right mono">${tl(r.avg_cost)} ₺</td>
            <td class="right"><button class="btn btn--ghost btn--sm" data-hist="${r.id}">Hareketler</button></td>
          </tr>`).join('')}</tbody></table>`
        : '<div class="empty">Kritik seviyeye düşen malzeme yok.</div>'}
      </div>

      ${orphans.length ? `<div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Sahipsiz stok hareketleri</h3></div>
        <div class="card__body">
          <div class="alert alert--warn" style="margin:0 0 12px">
            Eski sistemde silinen malzemelere ait ${orphans.length} hareket bulundu.
            Miktarları hâlâ defterde duruyor ama bağlı oldukları malzeme kaydı yok.
          </div>
          <table class="tbl"><thead><tr><th>Malzeme no</th><th class="right">Bakiye</th>
            <th class="right">Hareket</th></tr></thead><tbody>
            ${orphans.map(o => `<tr><td class="mono">#${o.item_id}</td>
              <td class="right mono">${tl(o.qty)}</td><td class="right mono">${o.moves}</td></tr>`).join('')}
          </tbody></table></div></div>` : ''}`;

    $('#skoBuy').onclick = () => this.stockDocForm({});
    $$('#skBody [data-hist]').forEach(b => b.onclick = () => this.stockHistory(Number(b.dataset.hist)));
  },

  /* ----------------------------------------------------------- seviye */
  /*
   * Every number on this screen comes from the ledger, recomputed on read.
   * The old system wrote the quantity to three different tables and read it
   * from none of them, so "how much flour is there" had three answers and no
   * way to tell which was true.
   */
  async stockLevels() {
    $('#skBody').innerHTML = `
      <div class="card">
        <div class="card__head"><h3>Stok durumu</h3><div class="spacer"></div>
          <input class="input" id="skqQ" placeholder="Malzeme ara" style="width:220px;height:36px">
          <label class="row" style="gap:7px;font-size:13px"><input type="checkbox" id="skqCrit">
            <span>Sadece kritik</span></label>
          <label class="row" style="gap:7px;font-size:13px"><input type="checkbox" id="skqAll">
            <span>Pasifler dahil</span></label></div>
        <div id="skqList"><div class="empty">Yükleniyor…</div></div>
      </div>`;
    const load = async () => {
      const qs = new URLSearchParams();
      if ($('#skqQ').value) qs.set('q', $('#skqQ').value);
      if ($('#skqCrit').checked) qs.set('critical', '1');
      if ($('#skqAll').checked) qs.set('all', '1');
      const rows = (await api('GET', '/api/inventory/levels?' + qs)).levels;
      const total = rows.reduce((a, r) => a + r.stock_value, 0);
      $('#skqList').innerHTML = rows.length ? `<table class="tbl"><thead><tr>
        <th>Malzeme</th><th>Kategori</th><th class="right">Miktar</th><th>Birim</th>
        <th class="right">Kritik</th><th class="right">Ort. maliyet</th><th class="right">Değer</th><th></th>
        </tr></thead><tbody>
        ${rows.map(r => `<tr>
          <td><b>${esc(r.name)}</b>${r.is_active ? '' : ' <span class="badge badge--gray">pasif</span>'}
            ${r.sku ? `<div class="muted" style="font-size:12px">${esc(r.sku)}</div>` : ''}</td>
          <td class="muted">${esc(r.category_name || '')}</td>
          <td class="right mono ${r.qty < 0 ? 'is-loss' : ''}"><b>${tl(r.qty)}</b></td>
          <td class="muted">${esc(r.unit_label)}</td>
          <td class="right mono muted">${Number(r.min_qty) ? tl(r.min_qty) : '—'}
            ${r.is_critical ? ' <span class="badge badge--open">az</span>' : ''}</td>
          <td class="right mono">${tl(r.avg_cost)} ₺</td>
          <td class="right mono">${tl(r.stock_value)} ₺</td>
          <td class="right"><button class="btn btn--ghost btn--sm" data-hist="${r.id}">Hareketler</button></td>
        </tr>`).join('')}
        <tr><td colspan="6"><b>Toplam stok değeri</b></td>
          <td class="right mono"><b>${tl(total)} ₺</b></td><td></td></tr>
        </tbody></table>` : '<div class="empty">Kayıt bulunamadı.</div>';
      $$('#skqList [data-hist]').forEach(b => b.onclick = () => this.stockHistory(Number(b.dataset.hist)));
    };
    $('#skqQ').oninput = load;
    $('#skqCrit').onchange = load;
    $('#skqAll').onchange = load;
    load();
  },

  /** Every movement of one malzeme, so the chef can argue with the number. */
  async stockHistory(itemId) {
    const r = await api('GET', '/api/inventory/items/' + itemId);
    const KIND = { document: 'Alış', sale: 'Satış', adjustment: 'Düzeltme',
      count: 'Sayım', waste: 'Zayi', transfer: 'Transfer' };
    modal(`
      <div class="modal__head"><h3>${esc(r.item.name)} — hareketler</h3><div class="spacer"></div>
        <span class="badge badge--closed mono">${tl(r.level ? r.level.qty : 0)} ${esc(inv_unit(r.item.unit))}</span>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        ${r.by_location.length > 1 ? `<div class="row" style="gap:8px;margin-bottom:12px;flex-wrap:wrap">
          ${r.by_location.map(l => `<span class="chip">${esc(l.location_name)}
            <b class="mono">${tl(l.qty)}</b></span>`).join('')}</div>` : ''}
        <div style="max-height:420px;overflow:auto">
        ${r.ledger.length ? `<table class="tbl"><thead><tr>
          <th>Tarih</th><th>Tür</th><th>Açıklama</th><th class="right">Giriş</th>
          <th class="right">Çıkış</th><th class="right">Birim maliyet</th></tr></thead><tbody>
          ${r.ledger.map(l => `<tr>
            <td class="mono">${esc(String(l.created_at).slice(0, 16))}</td>
            <td><span class="badge ${l.source_type === 'waste' ? 'badge--gray' : 'badge--open'}">${KIND[l.source_type] || l.source_type}</span></td>
            <td class="muted">${esc(l.note || '')}${l.user_name ? ' · ' + esc(l.user_name) : ''}</td>
            <td class="right mono">${Number(l.quantity_in) ? tl(l.quantity_in) : ''}</td>
            <td class="right mono is-loss">${Number(l.quantity_out) ? tl(l.quantity_out) : ''}</td>
            <td class="right mono muted">${l.unit_cost ? tl(l.unit_cost) + ' ₺' : ''}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Hareket yok.</div>'}
        </div>
      </div>`, { wide: true });
  },

  /* -------------------------------------------------------------- alış */
  /*
   * A draft here moves nothing. That is the point: in the old system saving a
   * "draft" had already written the stock ledger and approval only decided
   * whether the cost report counted it, so the owner approving an invoice was
   * pressing a button that did nothing to the stock he was looking at.
   */
  async stockDocuments() {
    const r = await api('GET', '/api/inventory/documents');
    const S = { draft: ['badge--open', 'Taslak'], approved: ['badge--closed', 'Onaylı'],
      cancelled: ['badge--gray', 'İptal'] };
    $('#skBody').innerHTML = `
      <div class="card">
        <div class="card__head"><h3>Alış faturaları</h3><div class="spacer"></div>
          <button class="btn btn--primary btn--sm" id="skdNew">Yeni fatura</button></div>
        <div class="card__body" style="padding-bottom:0">
          <div class="alert alert--info" style="margin-bottom:0">
            Fatura <b>onaylanana kadar stoğa girmez</b>. Taslakta düzeltebilir, onayladıktan sonra
            değiştirmek için önce iptal etmeniz gerekir.</div></div>
        ${r.documents.length ? `<table class="tbl"><thead><tr>
          <th>Tarih</th><th>Fatura no</th><th>Tedarikçi</th><th class="right">Satır</th>
          <th class="right">Tutar</th><th>Durum</th><th></th></tr></thead><tbody>
          ${r.documents.map(d => `<tr>
            <td class="mono">${esc(String(d.document_date).slice(0, 10))}</td>
            <td>${esc(d.document_no || '—')}</td>
            <td>${esc(d.supplier_name || '—')}</td>
            <td class="right mono">${d.line_count}</td>
            <td class="right mono"><b>${tl(d.total_amount)} ₺</b></td>
            <td><span class="badge ${S[d.status][0]}">${S[d.status][1]}</span></td>
            <td class="right"><button class="btn btn--ghost btn--sm" data-doc="${d.id}">Aç</button></td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Henüz alış faturası girilmemiş.</div>'}
      </div>`;
    $('#skdNew').onclick = () => this.stockDocForm({});
    $$('#skBody [data-doc]').forEach(b => b.onclick = () => this.stockDocOpen(Number(b.dataset.doc)));
  },

  async stockDocOpen(id) {
    const d = (await api('GET', '/api/inventory/documents/' + id)).document;
    if (d.status === 'draft') return this.stockDocForm(d);
    modal(`
      <div class="modal__head"><h3>Fatura ${esc(d.document_no || '#' + d.id)}</h3><div class="spacer"></div>
        <span class="badge ${d.status === 'approved' ? 'badge--closed' : 'badge--gray'}">
          ${d.status === 'approved' ? 'Onaylı' : 'İptal'}</span>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="row" style="gap:18px;margin-bottom:12px">
          <div><div class="muted" style="font-size:12.5px">Tedarikçi</div><b>${esc(d.supplier_name || '—')}</b></div>
          <div><div class="muted" style="font-size:12.5px">Tarih</div><b>${esc(String(d.document_date).slice(0, 10))}</b></div>
          <div class="spacer"></div>
          <div class="right"><div class="muted" style="font-size:12.5px">Toplam</div>
            <b style="font-size:19px">${tl(d.total_amount)} ₺</b></div>
        </div>
        <table class="tbl"><thead><tr><th>Malzeme</th><th class="right">Miktar</th><th>Birim</th>
          <th class="right">Birim fiyat</th><th class="right">KDV</th><th class="right">Tutar</th></tr></thead><tbody>
          ${d.items.map(l => `<tr>
            <td>${esc(l.item_name || l.raw_name)}</td>
            <td class="right mono">${tl(l.quantity)}</td><td class="muted">${esc(l.unit)}</td>
            <td class="right mono">${tl(l.unit_price)} ₺</td>
            <td class="right mono muted">%${Number(l.vat_rate)}</td>
            <td class="right mono">${tl(l.total_price)} ₺</td></tr>`).join('')}
        </tbody></table>
        ${d.note ? `<p class="muted" style="margin-bottom:0">${esc(d.note)}</p>` : ''}
      </div>
      <div class="modal__foot">
        ${d.status === 'approved' ? '<button class="btn btn--danger" id="skdCancel">Faturayı iptal et</button>' : ''}
        <button class="btn btn--ghost" data-close="1">Kapat</button></div>`, { wide: true });
    if ($('#skdCancel')) {
      $('#skdCancel').onclick = async () => {
        if (!await confirmBox('Fatura iptali',
          'Bu faturanın getirdiği stok geri alınacak. Hareket geçmişi silinmez, ters kayıt yazılır.', true)) return;
        try {
          await api('POST', `/api/inventory/documents/${id}/cancel`);
          closeModal(); toast('Fatura iptal edildi', 'ok'); this.stockReload();
        } catch (e) { err(e); }
      };
    }
  },

  /**
   * The purchase form.
   *
   * Lines are typed against a real malzeme, never against free text: the old
   * OCR importer created a fresh inventory_items row for every spelling on
   * every receipt, so the same flour existed nine times and no total was ever
   * right. An unmatched line can be saved as a draft but is refused at
   * approval, by name, so nothing enters stock under a name nobody owns.
   */
  async stockDocForm(doc) {
    const items = (await api('GET', '/api/inventory/items')).items;
    const sups = (await api('GET', '/api/inventory/suppliers')).suppliers;
    let lines = (doc.items || []).map(l => ({
      item_id: l.item_id, raw_name: l.raw_name, quantity: Number(l.quantity),
      unit: l.unit, unit_price: Number(l.unit_price), vat_rate: Number(l.vat_rate) }));
    if (!lines.length) lines = [{ item_id: '', quantity: 1, unit_price: 0, vat_rate: 1 }];

    const draw = () => {
      const total = lines.reduce((a, l) => a + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);
      modal(`
        <div class="modal__head"><h3>${doc.id ? 'Alış faturası (taslak)' : 'Yeni alış faturası'}</h3>
          <div class="spacer"></div><button class="close-x" data-close="1">✕</button></div>
        <div class="modal__body">
          <div class="split-3">
            <div class="field"><label>Tedarikçi</label><select class="input" id="sdSup">
              <option value="">— seçilmedi —</option>
              ${sups.map(s => `<option value="${s.id}" ${Number(doc.supplier_id) === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            </select></div>
            <div class="field"><label>Fatura no</label>
              <input class="input" id="sdNo" value="${esc(doc.document_no || '')}"></div>
            <div class="field"><label>Fatura tarihi</label>
              <input class="input" id="sdDate" type="date" value="${esc(String(doc.document_date || new Date().toISOString()).slice(0, 10))}"></div>
          </div>
          <table class="tbl"><thead><tr>
            <th style="width:36%">Malzeme</th><th class="right">Miktar</th><th class="right">Birim fiyat</th>
            <th class="right">KDV %</th><th class="right">Tutar</th><th></th></tr></thead><tbody id="sdLines">
            ${lines.map((l, i) => `<tr>
              <td><select class="input" data-f="item_id" data-i="${i}" style="height:36px">
                <option value="">— malzeme seçin —</option>
                ${items.map(it => `<option value="${it.id}" ${Number(l.item_id) === it.id ? 'selected' : ''}>${esc(it.name)}</option>`).join('')}
              </select>${l.item_id ? '' : `<div class="muted" style="font-size:12px">${esc(l.raw_name || 'onay için malzeme seçilmeli')}</div>`}</td>
              <td><input class="input right mono" data-f="quantity" data-i="${i}" type="number" step="0.001"
                value="${Number(l.quantity) || 0}" style="height:36px;width:96px"></td>
              <td><input class="input right mono" data-f="unit_price" data-i="${i}" type="number" step="0.0001"
                value="${Number(l.unit_price) || 0}" style="height:36px;width:110px"></td>
              <td><select class="input" data-f="vat_rate" data-i="${i}" style="height:36px;width:78px">
                ${[0, 1, 10, 20].map(v => `<option value="${v}" ${Number(l.vat_rate) === v ? 'selected' : ''}>${v}</option>`).join('')}
              </select></td>
              <td class="right mono">${tl((Number(l.quantity) || 0) * (Number(l.unit_price) || 0))} ₺</td>
              <td class="right"><button class="btn btn--ghost btn--sm" data-del="${i}">Sil</button></td>
            </tr>`).join('')}
          </tbody></table>
          <div class="row" style="margin-top:10px">
            <button class="btn btn--ghost btn--sm" id="sdAdd">Satır ekle</button>
            <div class="spacer"></div>
            <div class="right"><div class="muted" style="font-size:12.5px">Fatura toplamı (KDV dahil)</div>
              <b style="font-size:20px" class="mono">${tl(total)} ₺</b></div>
          </div>
          <div class="field" style="margin-top:12px"><label>Not</label>
            <input class="input" id="sdNote" value="${esc(doc.note || '')}"></div>
          <div class="alert alert--info" style="margin-bottom:0">
            Taslak kaydetmek stoğu değiştirmez. Stok ancak <b>onayladığınızda</b> girer.</div>
        </div>
        <div class="modal__foot">
          <button class="btn btn--ghost" data-close="1">Vazgeç</button>
          <button class="btn btn--dark" id="sdSave">Taslak kaydet</button>
          <button class="btn btn--primary" id="sdApprove">Kaydet ve onayla</button>
        </div>`, { wide: true });

      $$('#modal [data-f]').forEach(el => el.onchange = () => {
        const i = Number(el.dataset.i);
        lines[i][el.dataset.f] = el.value;
        draw();
      });
      $$('#modal [data-del]').forEach(b => b.onclick = () => {
        lines.splice(Number(b.dataset.del), 1);
        if (!lines.length) lines = [{ item_id: '', quantity: 1, unit_price: 0, vat_rate: 1 }];
        draw();
      });
      $('#sdAdd').onclick = () => { lines.push({ item_id: '', quantity: 1, unit_price: 0, vat_rate: 1 }); draw(); };

      const save = async () => {
        const payload = {
          id: doc.id, supplier_id: Number($('#sdSup').value) || null,
          document_no: $('#sdNo').value, document_date: $('#sdDate').value, note: $('#sdNote').value,
          items: lines.filter(l => Number(l.quantity) > 0).map(l => ({
            item_id: Number(l.item_id) || null,
            raw_name: l.raw_name || (items.find(i => i.id === Number(l.item_id)) || {}).name || 'Satır',
            quantity: Number(l.quantity),
            unit: (items.find(i => i.id === Number(l.item_id)) || {}).unit || 'pcs',
            unit_price: Number(l.unit_price), vat_rate: Number(l.vat_rate) })),
        };
        return (await api('POST', '/api/inventory/documents', payload)).id;
      };
      $('#sdSave').onclick = async () => {
        try { await save(); closeModal(); toast('Taslak kaydedildi — stok değişmedi', 'ok'); this.stockReload(); }
        catch (e) { err(e); }
      };
      $('#sdApprove').onclick = async () => {
        try {
          const id = await save();
          await api('POST', `/api/inventory/documents/${id}/approve`);
          closeModal(); toast('Fatura onaylandı, stok girildi', 'ok'); this.stockReload();
        } catch (e) { err(e); }
      };
    };
    draw();
  },

  /* ------------------------------------------------------------ reçete */
  /*
   * The link the old system never had. Until a product has a recipe, selling
   * it consumes nothing - which is exactly what happened to every product for
   * the whole life of the previous system, silently.
   */
  async stockRecipes() {
    const r = await api('GET', '/api/inventory/recipes');
    const withRecipe = r.products.filter(p => Number(p.line_count) > 0);
    const without = r.products.filter(p => !Number(p.line_count));
    $('#skBody').innerHTML = `
      <div class="card">
        <div class="card__head"><h3>Reçeteler</h3><div class="spacer"></div>
          <span class="muted" style="font-size:13px">${withRecipe.length} / ${r.products.length} üründe reçete var</span></div>
        <div class="card__body" style="padding-bottom:0">
          <div class="alert alert--info" style="margin-bottom:0">
            Reçetesi olan bir ürün satıldığında hammaddesi otomatik düşer.
            Reçetesi olmayan ürün <b>hiçbir stoğu tüketmez</b>.</div></div>
        <table class="tbl"><thead><tr>
          <th>Ürün</th><th>Kategori</th><th class="right">Satış fiyatı</th>
          <th class="right">Reçete maliyeti</th><th class="right">Girilen maliyet</th>
          <th class="right">Malzeme</th><th></th></tr></thead><tbody>
          ${r.products.map(p => `<tr>
            <td><b>${esc(p.name)}</b></td>
            <td class="muted">${esc(p.category_name || '')}</td>
            <td class="right mono">${tl(p.price)} ₺</td>
            <td class="right mono">${Number(p.line_count) ? tl(p.recipe_cost) + ' ₺' : '—'}</td>
            <td class="right mono muted">${tl(p.cost_price)} ₺</td>
            <td class="right">${Number(p.line_count)
              ? `<span class="badge badge--closed">${p.line_count} kalem</span>`
              : '<span class="badge badge--gray">yok</span>'}</td>
            <td class="right"><button class="btn btn--ghost btn--sm" data-rec="${p.id}"
              data-name="${esc(p.name)}">${Number(p.line_count) ? 'Düzenle' : 'Reçete ekle'}</button></td>
          </tr>`).join('')}
        </tbody></table>
      </div>
      ${without.length ? `<p class="muted" style="margin-top:12px">
        ${without.length} ürünün reçetesi yok; bu ürünler satıldığında hammadde stoğu değişmez.</p>` : ''}`;
    $$('#skBody [data-rec]').forEach(b =>
      b.onclick = () => this.stockRecipeForm(Number(b.dataset.rec), b.dataset.name));
  },

  async stockRecipeForm(productId, productName) {
    const items = (await api('GET', '/api/inventory/items')).items;
    const cur = await api('GET', '/api/inventory/recipes/' + productId);
    let lines = cur.recipe.map(l => ({ inventory_item_id: l.inventory_item_id, qty_per_unit: Number(l.qty_per_unit) }));
    if (!lines.length) lines = [{ inventory_item_id: '', qty_per_unit: 0 }];

    const draw = () => {
      const cost = lines.reduce((a, l) => {
        const c = (cur.costing.lines.find(x => x.inventory_item_id === Number(l.inventory_item_id)) || {}).avg_cost;
        return a + (Number(l.qty_per_unit) || 0) * (Number(c) || 0);
      }, 0);
      modal(`
        <div class="modal__head"><h3>${esc(productName)} — reçete</h3><div class="spacer"></div>
          <button class="close-x" data-close="1">✕</button></div>
        <div class="modal__body">
          <p class="muted" style="margin-top:0">Bir porsiyon için gereken miktarları girin.
            Miktar malzemenin kendi biriminde yazılır — kg'lık una <b>0,3</b> yazarsanız 300 gramdır.</p>
          <table class="tbl"><thead><tr><th style="width:55%">Malzeme</th>
            <th class="right">Porsiyon başına</th><th>Birim</th><th></th></tr></thead><tbody>
            ${lines.map((l, i) => {
              const it = items.find(x => x.id === Number(l.inventory_item_id));
              return `<tr>
              <td><select class="input" data-rf="inventory_item_id" data-i="${i}" style="height:36px">
                <option value="">— malzeme seçin —</option>
                ${items.map(x => `<option value="${x.id}" ${Number(l.inventory_item_id) === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
              </select></td>
              <td><input class="input right mono" data-rf="qty_per_unit" data-i="${i}" type="number" step="0.0001"
                value="${Number(l.qty_per_unit) || 0}" style="height:36px;width:120px"></td>
              <td class="muted">${it ? esc(inv_unit(it.unit)) : ''}</td>
              <td class="right"><button class="btn btn--ghost btn--sm" data-rdel="${i}">Sil</button></td></tr>`;
            }).join('')}
          </tbody></table>
          <div class="row" style="margin-top:10px">
            <button class="btn btn--ghost btn--sm" id="srAdd">Malzeme ekle</button>
            <div class="spacer"></div>
            <div class="right"><div class="muted" style="font-size:12.5px">Güncel alış fiyatlarıyla porsiyon maliyeti</div>
              <b style="font-size:20px" class="mono">${tl(cost)} ₺</b></div>
          </div>
          <p class="muted" style="margin-bottom:0">Bu tutar bilgi amaçlıdır; ürün kartındaki maliyeti değiştirmez.</p>
        </div>
        <div class="modal__foot">
          <button class="btn btn--ghost" data-close="1">Vazgeç</button>
          <button class="btn btn--primary" id="srOk">Kaydet</button></div>`, { wide: true });

      $$('#modal [data-rf]').forEach(el => el.onchange = () => {
        lines[Number(el.dataset.i)][el.dataset.rf] = el.value; draw();
      });
      $$('#modal [data-rdel]').forEach(b => b.onclick = () => {
        lines.splice(Number(b.dataset.rdel), 1);
        if (!lines.length) lines = [{ inventory_item_id: '', qty_per_unit: 0 }];
        draw();
      });
      $('#srAdd').onclick = () => { lines.push({ inventory_item_id: '', qty_per_unit: 0 }); draw(); };
      $('#srOk').onclick = async () => {
        try {
          await api('POST', '/api/inventory/recipes/' + productId, {
            lines: lines.filter(l => Number(l.inventory_item_id) && Number(l.qty_per_unit) > 0)
              .map(l => ({ inventory_item_id: Number(l.inventory_item_id), qty_per_unit: Number(l.qty_per_unit) })) });
          closeModal(); toast('Reçete kaydedildi', 'ok'); this.stockReload();
        } catch (e) { err(e); }
      };
    };
    draw();
  },

  /* ------------------------------------------------------------- sayım */
  /*
   * A sayim freezes what the ledger says at the moment it is opened, so the
   * variance answers "what was missing when we counted" and not "what is
   * missing now that three more bills have closed". Approving it is what
   * writes the difference; a draft moves nothing.
   */
  async stockCounts() {
    const r = await api('GET', '/api/inventory/counts');
    const S = { draft: ['badge--open', 'Açık'], approved: ['badge--closed', 'Kapandı'],
      cancelled: ['badge--gray', 'İptal'] };
    $('#skBody').innerHTML = `
      <div class="card">
        <div class="card__head"><h3>Sayımlar</h3><div class="spacer"></div>
          <button class="btn btn--primary btn--sm" id="scNew">Yeni sayım başlat</button></div>
        ${r.counts.length ? `<table class="tbl"><thead><tr>
          <th>Tarih</th><th>Not</th><th>Sayan</th><th class="right">Kalem</th>
          <th class="right">Fark (miktar)</th><th class="right">Fark (tutar)</th><th>Durum</th><th></th>
          </tr></thead><tbody>
          ${r.counts.map(c => `<tr>
            <td class="mono">${esc(String(c.count_date).slice(0, 10))}</td>
            <td>${esc(c.note || '—')}</td>
            <td class="muted">${esc(c.created_by_name || '')}</td>
            <td class="right mono">${c.line_count}</td>
            <td class="right mono">${tl(c.variance_qty)}</td>
            <td class="right mono ${Number(c.variance_value) < 0 ? 'is-loss' : ''}">${tl(c.variance_value)} ₺</td>
            <td><span class="badge ${S[c.status][0]}">${S[c.status][1]}</span></td>
            <td class="right"><button class="btn btn--ghost btn--sm" data-cnt="${c.id}">Aç</button></td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Henüz sayım yapılmamış.</div>'}
      </div>`;
    $('#scNew').onclick = async () => {
      const note = await this.stockAskText('Yeni sayım', 'Sayım notu (isteğe bağlı)');
      if (note === null) return;
      try {
        const c = await api('POST', '/api/inventory/counts', { note });
        toast('Sayım açıldı — şimdi rafı sayın', 'ok');
        this.stockCountSheet(c.id);
      } catch (e) { err(e); }
    };
    $$('#skBody [data-cnt]').forEach(b => b.onclick = () => this.stockCountSheet(Number(b.dataset.cnt)));
  },

  async stockCountSheet(countId) {
    const c = (await api('GET', '/api/inventory/counts/' + countId)).count;
    const open = c.status === 'draft';
    modal(`
      <div class="modal__head"><h3>Sayım — ${esc(String(c.count_date).slice(0, 10))}</h3><div class="spacer"></div>
        <span class="badge ${open ? 'badge--open' : 'badge--closed'}">${open ? 'Açık' : 'Kapandı'}</span>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        ${open ? `<div class="alert alert--info">Rafta ne varsa <b>Sayılan</b> sütununa yazın.
          Fark otomatik hesaplanır. Sayımı kapatana kadar stok değişmez.</div>` : ''}
        <div style="max-height:420px;overflow:auto">
        <table class="tbl"><thead><tr><th>Malzeme</th><th class="right">Sistem</th>
          <th class="right">Sayılan</th><th class="right">Fark</th><th class="right">Tutar</th></tr></thead><tbody>
          ${c.items.map(l => `<tr>
            <td><b>${esc(l.item_name)}</b> <span class="muted">${esc(inv_unit(l.unit))}</span></td>
            <td class="right mono muted">${tl(l.expected_qty)}</td>
            <td class="right">${open
              ? `<input class="input right mono" data-cq="${l.item_id}" type="number" step="0.001"
                   value="${Number(l.counted_qty)}" style="height:34px;width:110px">`
              : `<span class="mono">${tl(l.counted_qty)}</span>`}</td>
            <td class="right mono ${Number(l.variance) < 0 ? 'is-loss' : ''}" data-cv="${l.item_id}">${tl(l.variance)}</td>
            <td class="right mono muted">${tl(Number(l.variance) * Number(l.unit_cost || 0))} ₺</td>
          </tr>`).join('')}
        </tbody></table></div>
        <div class="row" style="margin-top:12px"><div class="spacer"></div>
          <div class="right"><div class="muted" style="font-size:12.5px">Toplam fark</div>
            <b style="font-size:20px" class="mono ${Number(c.variance_value) < 0 ? 'is-loss' : ''}">${tl(c.variance_value)} ₺</b></div></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-close="1">Kapat</button>
        ${open ? `<button class="btn btn--dark" id="scSave">Kaydet</button>
                  <button class="btn btn--primary" id="scOk">Sayımı kapat ve stoğa işle</button>` : ''}</div>`,
      { wide: true });

    if (!open) return;
    // the difference is shown live but always recomputed on the server on save
    $$('#modal [data-cq]').forEach(el => el.oninput = () => {
      const row = c.items.find(x => String(x.item_id) === el.dataset.cq);
      const v = Math.round((Number(el.value || 0) - Number(row.expected_qty)) * 1000) / 1000;
      const cell = $(`#modal [data-cv="${el.dataset.cq}"]`);
      cell.textContent = tl(v);
      cell.classList.toggle('is-loss', v < 0);
    });
    const collect = () => $$('#modal [data-cq]').map(el =>
      ({ item_id: Number(el.dataset.cq), counted_qty: Number(el.value || 0) }));
    $('#scSave').onclick = async () => {
      try { await api('POST', `/api/inventory/counts/${countId}/lines`, { lines: collect() });
        toast('Sayım kaydedildi', 'ok'); } catch (e) { err(e); }
    };
    $('#scOk').onclick = async () => {
      if (!await confirmBox('Sayımı kapat',
        'Farklar stok defterine işlenecek ve stok sayılan miktara gelecek. Bu işlem geri alınamaz.')) return;
      try {
        await api('POST', `/api/inventory/counts/${countId}/lines`, { lines: collect() });
        const r = await api('POST', `/api/inventory/counts/${countId}/approve`);
        closeModal(); toast(r.adjusted + ' kalemde fark stoğa işlendi', 'ok'); this.stockReload();
      } catch (e) { err(e); }
    };
  },

  /* -------------------------------------------------------------- zayi */
  async stockWaste() {
    const r = await api('GET', '/api/inventory/waste');
    const total = r.waste.reduce((a, w) => a + Number(w.cost), 0);
    $('#skBody').innerHTML = `
      <div class="card">
        <div class="card__head"><h3>Zayi kayıtları</h3><div class="spacer"></div>
          <span class="muted mono" style="font-size:13px">Toplam ${tl(total)} ₺</span>
          <button class="btn btn--primary btn--sm" id="swNew">Zayi gir</button></div>
        ${r.waste.length ? `<table class="tbl"><thead><tr>
          <th>Tarih</th><th>Malzeme</th><th class="right">Miktar</th><th>Neden</th>
          <th>Açıklama</th><th>Kaydeden</th><th class="right">Maliyet</th></tr></thead><tbody>
          ${r.waste.map(w => `<tr>
            <td class="mono">${esc(String(w.created_at).slice(0, 16))}</td>
            <td><b>${esc(w.item_name || '—')}</b></td>
            <td class="right mono">${tl(w.quantity)} ${esc(inv_unit(w.unit))}</td>
            <td><span class="badge badge--gray">${esc(w.reason_label)}</span></td>
            <td class="muted">${esc(w.note || '')}</td>
            <td class="muted">${esc(w.user_name || '')}</td>
            <td class="right mono is-loss">${tl(w.cost)} ₺</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Zayi kaydı yok.</div>'}
      </div>`;
    $('#swNew').onclick = () => this.stockWasteForm();
  },

  /**
   * Waste always carries a reason and the reason comes from a list. "Bozuldu"
   * and "mutfak hatası" and "personel yemeği" are three different problems for
   * the owner; a single zayi total that hides which one happened is worth very
   * little, which is why the free-text box was not the design chosen here.
   */
  async stockWasteForm() {
    const items = (await api('GET', '/api/inventory/items')).items;
    const reasons = (await api('GET', '/api/inventory/waste/reasons')).reasons;
    modal(`
      <div class="modal__head"><h3>Zayi girişi</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="field"><label>Malzeme</label><select class="input" id="swItem">
          ${items.map(i => `<option value="${i.id}">${esc(i.name)} (${esc(inv_unit(i.unit))})</option>`).join('')}
        </select></div>
        <div class="split-2">
          <div class="field"><label>Miktar</label>
            <input class="input mono" id="swQty" type="number" step="0.001" value="1"></div>
          <div class="field"><label>Neden</label><select class="input" id="swReason">
            ${reasons.map(x => `<option value="${x.code}">${esc(x.label)}</option>`).join('')}
          </select></div>
        </div>
        <div class="field"><label>Açıklama</label>
          <input class="input" id="swNote" placeholder="İsteğe bağlı — ne olduğu"></div>
        <div class="alert alert--warn" style="margin-bottom:0">
          Zayi stoktan düşer ve geri alınamaz. Yanlış girdiyseniz sayımla düzeltebilirsiniz.</div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--danger" id="swOk">Zayi olarak düş</button></div>`);
    $('#swOk').onclick = async () => {
      try {
        const r = await api('POST', '/api/inventory/waste', {
          item_id: Number($('#swItem').value), quantity: Number($('#swQty').value),
          reason: $('#swReason').value, note: $('#swNote').value });
        closeModal(); toast('Zayi kaydedildi — ' + tl(r.cost) + ' ₺', 'ok'); this.stockReload();
      } catch (e) { err(e); }
    };
  },

  /* ---------------------------------------------------------- transfer */
  async stockTransfers() {
    const locs = (await api('GET', '/api/inventory/locations')).locations;
    const r = await api('GET', '/api/inventory/transfers');
    $('#skBody').innerHTML = `
      <div class="card">
        <div class="card__head"><h3>Depolar</h3><div class="spacer"></div>
          <button class="btn btn--ghost btn--sm" id="stLoc">Depo ekle</button>
          <button class="btn btn--primary btn--sm" id="stNew" ${locs.length < 2 ? 'disabled' : ''}>Transfer yap</button></div>
        <div class="card__body">
          ${locs.length ? `<div class="row" style="gap:8px;flex-wrap:wrap">
            ${locs.map(l => `<span class="chip">${esc(l.name)}${l.is_default ? ' <b>ana</b>' : ''}</span>`).join('')}</div>`
          : `<div class="muted">Henüz depo tanımlanmamış. Transfer için en az iki depo gerekir.</div>`}
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Transfer geçmişi</h3></div>
        ${r.transfers.length ? `<table class="tbl"><thead><tr>
          <th>Tarih</th><th>Malzeme</th><th class="right">Miktar</th><th>Çıkış</th><th>Varış</th>
          <th>Açıklama</th><th>Yapan</th></tr></thead><tbody>
          ${r.transfers.map(t => `<tr>
            <td class="mono">${esc(String(t.created_at).slice(0, 16))}</td>
            <td><b>${esc(t.item_name || '—')}</b></td>
            <td class="right mono">${tl(t.quantity)} ${esc(inv_unit(t.unit))}</td>
            <td>${esc(t.from_name || '—')}</td><td>${esc(t.to_name || '—')}</td>
            <td class="muted">${esc(t.note || '')}</td><td class="muted">${esc(t.user_name || '')}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Transfer yapılmamış.</div>'}
      </div>`;
    $('#stLoc').onclick = async () => {
      const name = await this.stockAskText('Yeni depo', 'Depo adı (Bar dolabı, Soğuk oda…)');
      if (!name) return;
      try {
        if (!locs.length) await api('POST', '/api/inventory/locations/default');
        await api('POST', '/api/inventory/locations', { name });
        toast('Depo eklendi', 'ok'); this.stockReload();
      } catch (e) { err(e); }
    };
    if (locs.length >= 2) $('#stNew').onclick = () => this.stockTransferForm(locs);
  },

  async stockTransferForm(locs) {
    const items = (await api('GET', '/api/inventory/items')).items;
    modal(`
      <div class="modal__head"><h3>Depo transferi</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="field"><label>Malzeme</label><select class="input" id="stItem">
          ${items.map(i => `<option value="${i.id}">${esc(i.name)} (${esc(inv_unit(i.unit))})</option>`).join('')}
        </select></div>
        <div class="split-3">
          <div class="field"><label>Çıkış deposu</label><select class="input" id="stFrom">
            ${locs.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Varış deposu</label><select class="input" id="stTo">
            ${locs.map((l, i) => `<option value="${l.id}" ${i === 1 ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Miktar</label>
            <input class="input mono" id="stQty" type="number" step="0.001" value="1"></div>
        </div>
        <div class="field"><label>Açıklama</label><input class="input" id="stNote"></div>
        <p class="muted" style="margin-bottom:0">Transfer toplam stoğu değiştirmez, sadece nerede
          durduğunu değiştirir.</p>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="stOk">Transfer et</button></div>`);
    $('#stOk').onclick = async () => {
      try {
        await api('POST', '/api/inventory/transfers', {
          item_id: Number($('#stItem').value), from_location_id: Number($('#stFrom').value),
          to_location_id: Number($('#stTo').value), quantity: Number($('#stQty').value),
          note: $('#stNote').value });
        closeModal(); toast('Transfer yapıldı', 'ok'); this.stockReload();
      } catch (e) { err(e); }
    };
  },

  /* ------------------------------------------------------------ tanım */
  async stockDefinitions() {
    const items = (await api('GET', '/api/inventory/items?all=1')).items;
    const sups = (await api('GET', '/api/inventory/suppliers')).suppliers;
    $('#skBody').innerHTML = `
      <div class="card">
        <div class="card__head"><h3>Malzemeler</h3><div class="spacer"></div>
          <button class="btn btn--primary btn--sm" id="siNew">Malzeme ekle</button></div>
        ${items.length ? `<table class="tbl"><thead><tr>
          <th>Malzeme</th><th>Kod / barkod</th><th>Birim</th><th class="right">Kritik seviye</th><th></th>
          </tr></thead><tbody>
          ${items.map(i => `<tr>
            <td><b>${esc(i.name)}</b>${i.is_active ? '' : ' <span class="badge badge--gray">pasif</span>'}</td>
            <td class="muted mono">${esc(i.sku || '')}${i.barcode ? ' · ' + esc(i.barcode) : ''}</td>
            <td class="muted">${esc(inv_unit(i.unit))}</td>
            <td class="right mono">${Number(i.min_qty) ? tl(i.min_qty) : '—'}</td>
            <td class="right">
              <button class="btn btn--ghost btn--sm" data-item='${esc(JSON.stringify(i))}'>Düzenle</button>
              <button class="btn btn--ghost btn--sm" data-idel="${i.id}" data-iname="${esc(i.name)}">Sil</button></td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Henüz malzeme tanımlanmamış.</div>'}
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Tedarikçiler</h3><div class="spacer"></div>
          <button class="btn btn--primary btn--sm" id="ssNew">Tedarikçi ekle</button></div>
        ${sups.length ? `<table class="tbl"><thead><tr>
          <th>Tedarikçi</th><th>VKN</th><th>Telefon</th><th class="right">Fatura</th>
          <th class="right">Toplam alış</th><th></th></tr></thead><tbody>
          ${sups.map(s => `<tr>
            <td><b>${esc(s.name)}</b>${s.is_active ? '' : ' <span class="badge badge--gray">pasif</span>'}</td>
            <td class="muted mono">${esc(s.vkn || '')}</td>
            <td class="muted">${esc(s.phone || '')}</td>
            <td class="right mono">${s.doc_count}</td>
            <td class="right mono">${tl(s.total_purchased)} ₺</td>
            <td class="right"><button class="btn btn--ghost btn--sm" data-sup='${esc(JSON.stringify(s))}'>Düzenle</button></td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Henüz tedarikçi tanımlanmamış.</div>'}
      </div>`;
    $('#siNew').onclick = () => this.stockItemForm({});
    $('#ssNew').onclick = () => this.stockSupplierForm({});
    $$('#skBody [data-item]').forEach(b => b.onclick = () => this.stockItemForm(JSON.parse(b.dataset.item)));
    $$('#skBody [data-sup]').forEach(b => b.onclick = () => this.stockSupplierForm(JSON.parse(b.dataset.sup)));
    $$('#skBody [data-idel]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('Malzemeyi sil',
        b.dataset.iname + ' silinecek. Hareket geçmişi varsa silinmez, pasife alınır.', true)) return;
      try {
        const r = await api('DELETE', '/api/inventory/items/' + b.dataset.idel);
        toast(r.reason || 'Silindi', r.reason ? '' : 'ok');
        this.stockReload();
      } catch (e) { err(e); }
    });
  },

  async stockItemForm(item) {
    const units = (await api('GET', '/api/inventory/units')).units;
    const cats = (await api('GET', '/api/inventory/categories')).categories;
    modal(`
      <div class="modal__head"><h3>${item.id ? 'Malzemeyi düzenle' : 'Yeni malzeme'}</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="field"><label>Malzeme adı</label>
          <input class="input" id="siName" value="${esc(item.name || '')}" placeholder="Un, Kıyma, Kola Kutu…"></div>
        <div class="split-2">
          <div class="field"><label>Birim</label><select class="input" id="siUnit">
            ${units.map(u => `<option value="${u.code}" ${item.unit === u.code ? 'selected' : ''}>${esc(u.label)}</option>`).join('')}
          </select></div>
          <div class="field"><label>Kategori</label><select class="input" id="siCat">
            <option value="">— yok —</option>
            ${cats.map(c => `<option value="${c.id}" ${Number(item.category_id) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select></div>
          <div class="field"><label>Stok kodu</label><input class="input" id="siSku" value="${esc(item.sku || '')}"></div>
          <div class="field"><label>Barkod</label><input class="input" id="siBar" value="${esc(item.barcode || '')}"></div>
        </div>
        <div class="field"><label>Kritik seviye (bu miktarın altına düşünce uyarır)</label>
          <input class="input mono" id="siMin" type="number" step="0.001" value="${Number(item.min_qty || 0)}"></div>
        <label class="row" style="gap:9px"><input type="checkbox" id="siActive" ${item.is_active === 0 ? '' : 'checked'}>
          <span>Aktif</span></label>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="siOk">Kaydet</button></div>`);
    $('#siOk').onclick = async () => {
      try {
        await api('POST', '/api/inventory/items', {
          id: item.id, name: $('#siName').value, unit: $('#siUnit').value,
          category_id: Number($('#siCat').value) || null, sku: $('#siSku').value,
          barcode: $('#siBar').value, min_qty: Number($('#siMin').value),
          is_active: $('#siActive').checked });
        closeModal(); toast('Kaydedildi', 'ok'); this.stockReload();
      } catch (e) { err(e); }
    };
  },

  stockSupplierForm(s) {
    modal(`
      <div class="modal__head"><h3>${s.id ? 'Tedarikçiyi düzenle' : 'Yeni tedarikçi'}</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="field"><label>Tedarikçi adı</label><input class="input" id="spName" value="${esc(s.name || '')}"></div>
        <div class="split-2">
          <div class="field"><label>Vergi no (VKN)</label><input class="input mono" id="spVkn" value="${esc(s.vkn || '')}"></div>
          <div class="field"><label>Vergi dairesi</label><input class="input" id="spOffice" value="${esc(s.vergi_dairesi || '')}"></div>
          <div class="field"><label>Telefon</label><input class="input" id="spPhone" value="${esc(s.phone || '')}"></div>
          <div class="field"><label>E-posta</label><input class="input" id="spMail" value="${esc(s.email || '')}"></div>
        </div>
        <div class="field"><label>Adres</label><input class="input" id="spAddr" value="${esc(s.address || '')}"></div>
        <label class="row" style="gap:9px"><input type="checkbox" id="spActive" ${s.is_active === 0 ? '' : 'checked'}>
          <span>Aktif</span></label>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="spOk">Kaydet</button></div>`);
    $('#spOk').onclick = async () => {
      try {
        await api('POST', '/api/inventory/suppliers', {
          id: s.id, name: $('#spName').value, vkn: $('#spVkn').value,
          vergi_dairesi: $('#spOffice').value, phone: $('#spPhone').value,
          email: $('#spMail').value, address: $('#spAddr').value, is_active: $('#spActive').checked });
        closeModal(); toast('Kaydedildi', 'ok'); this.stockReload();
      } catch (e) { err(e); }
    };
  },

  /** A one-field prompt, in the till's own modal rather than the browser's. */
  stockAskText(title, label) {
    return new Promise((resolve) => {
      modal(`
        <div class="modal__head"><h3>${esc(title)}</h3></div>
        <div class="modal__body"><div class="field"><label>${esc(label)}</label>
          <input class="input" id="satVal"></div></div>
        <div class="modal__foot"><button class="btn btn--ghost" id="satNo">Vazgeç</button>
          <button class="btn btn--primary" id="satOk">Tamam</button></div>`);
      $('#satNo').onclick = () => { closeModal(); resolve(null); };
      $('#satOk').onclick = () => { const v = $('#satVal').value; closeModal(); resolve(v); };
      $('#satVal').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#satOk').click(); });
      $('#satVal').focus();
    });
  },
});
