/* =====================================================================
   NOKTApp POS - Fiyatlandırma ve ürün kartları
   =====================================================================
   Two screens over one module.

   "Fiyatlandırma" is the pricing engine the old system shipped and could not
   reach: ten PHP files under finance/pricing/, none of them in the navigation,
   all of them reading a table nothing ever wrote. Its accept button never
   changed a price. Here a suggestion is arithmetic the owner can check on the
   screen - cost, KDV out, margin, target, the price that hits the target - and
   accepting it writes the price and the history through the same path a
   hand-typed price takes.

   "Ürün kartları" is the other half of the same job: the cost history, the
   price history, the delete that must not delete, the category switch that
   takes its products with it, the bulk raise, the duplicate. None of it
   existed. It sits beside Ürünler rather than inside it because the existing
   product list is another build's file and a screen is not worth breaking to
   save a menu entry.

   Same visual grammar as the rest of the till: .card, .tbl, .stat, .field,
   .badge, .right, .mono, .is-loss. One accent (orange), anything below target
   or losing money in red, NOTHING GREEN, no emoji.
   ===================================================================== */
'use strict';

registerIcon('fiyat',
  '<path d="M20.6 13.4L13.4 20.6a2 2 0 01-2.8 0l-7.2-7.2A2 2 0 013 12V5a2 2 0 012-2h7a2 2 0 011.4.6l7.2 7.2a2 2 0 010 2.6z"/><circle cx="7.5" cy="7.5" r="1.3"/>');
registerIcon('urunkart',
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16"/><path d="M12 13h6M12 16h4"/>');

registerPage({ id: 'fiyat', label: 'Fiyatlandırma', icon: 'fiyat', perm: 'price.manage' , group: 'products' }, 'products');
/*
 * No nav entry for the product cards any more.
 *
 * The list this file used to register under "Ürün kartları" IS the Ürünler
 * screen now - `page_products` draws it and owns the add / category /
 * import buttons. Two entries listing the same products, either of which
 * could change a price, was the crowding Erik pointed at.
 */

/* ------------------------------------------------------------ helpers */
const prMoney = (n) => tl(n) + ' ₺';
/** A margin, or an em dash: a product with no cost has no margin, not a 0%. */
const prPct = (n) => (n === null || n === undefined ? '—' : '%' + tl(n));

/**
 * The cost-source chip.
 *
 * The one thing on this screen that must never be quiet. A suggested price
 * built on a cost frozen onto real sold lines and one built on a figure
 * somebody typed on a card two years ago are different claims, and the old
 * module showed both as plain numbers in the same column. A measured cost gets
 * no chip at all - it is the normal case - and every guess is labelled.
 */
function prCostChip(row) {
  if (row.cost_source === 'none') return '<span class="badge badge--gray">maliyet yok</span>';
  if (!row.cost_is_fallback) return `<span class="muted">${esc(row.cost_source_label)}</span>`;
  return `<span class="badge badge--open" title="Bu maliyet ölçülmedi, tahmin edildi">
    ${esc(row.cost_source_label)} · tahmini</span>`;
}

/** A signed change, red only when it is money going the wrong way. */
function prDelta(n) {
  if (n === null || n === undefined) return '<span class="muted">—</span>';
  const s = (n > 0 ? '+' : '') + tl(n) + ' ₺';
  return n < 0 ? `<span class="is-loss">${s}</span>` : `<b>${s}</b>`;
}

Screens.add({

  /* remembered between visits, so coming back from a modal lands where the
     person left rather than on the first tab */
  _prTab: 'oneri',
  _prRound: 0.25,

  /* =================================================================== */
  /*  Fiyatlandırma                                                       */
  /* =================================================================== */

  async page_fiyat(tab) {
    if (tab) this._prTab = tab;
    const TABS = [
      ['oneri', 'Öneriler'],
      ['hedef', 'Hedef marj'],
      ['toplu', 'Toplu fiyat'],
      ['icgoru', 'İçgörüler'],
      ['karar', 'Kararlar'],
    ];
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Fiyatlandırma</h2><div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="fyPrev">Hesapla</button>
        <button class="btn btn--primary btn--sm" id="fyRun">Menüyü tara</button>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px" id="fyTabs">
        ${TABS.map(([id, l]) => `<button class="zone-tab${this._prTab === id ? ' is-active' : ''}"
          data-t="${id}">${l}</button>`).join('')}
      </div>
      <div id="fyBody"><div class="empty">Yükleniyor…</div></div></div>`;

    $$('#fyTabs [data-t]').forEach(b => b.onclick = () => this.page_fiyat(b.dataset.t));
    $('#fyRun').onclick = () => this.prRun();
    $('#fyPrev').onclick = () => this.page_fiyat('oneri');

    const draw = {
      oneri: () => this.prSuggestions(),
      hedef: () => this.prTargets(),
      toplu: () => this.prBulk(),
      icgoru: () => this.prInsights(),
      karar: () => this.prDecided(),
    };
    try { await draw[this._prTab](); } catch (e) { err(e); }
  },

  /**
   * The batch run.
   *
   * `pricing_batch_run.php` was misnamed - it ran no batch, it was an accept
   * list over an empty table. This is the batch, and it reports what it did
   * NOT do as loudly as what it did: how many products it could not price
   * because nobody has ever recorded a cost for them is the number that
   * decides whether the rest of the screen is worth reading.
   */
  async prRun() {
    try {
      const r = await api('POST', '/api/pricing/run', { round_to: this._prRound });
      const x = r.result;
      toast(`${x.scanned} ürün tarandı · ${x.created} yeni öneri, ${x.refreshed} güncellendi`);
      if (x.no_cost) toast(`${x.no_cost} üründe maliyet yok, önerilemedi`, 'error');
      this.page_fiyat('oneri');
    } catch (e) { err(e); }
  },

  /* ------------------------------------------------------- öneriler */
  async prSuggestions() {
    const [live, pend] = await Promise.all([
      api('GET', `/api/pricing/preview?round_to=${this._prRound}`),
      api('GET', '/api/pricing/suggestions'),
    ]);
    const s = pend.suggestions;
    const skipped = live.rows.filter(r => !r.suggestible);

    $('#fyBody').innerHTML = `
      ${s.length ? `<div class="card" style="margin-bottom:14px"><div class="card__head">
        <h3>Bekleyen öneri (${s.length})</h3><div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="fyAll">Tümünü uygula</button></div>
        <table class="tbl"><thead><tr>
          <th>Ürün</th><th>Maliyet</th><th class="right">Fiyat</th><th class="right">Marj</th>
          <th class="right">Hedef</th><th class="right">Önerilen</th><th class="right">Fark</th>
          <th class="right">Tahmini katkı</th><th></th></tr></thead><tbody>
          ${s.map(x => `<tr>
            <td><b>${esc(x.name)}</b><div class="muted" style="font-size:12px">${esc(x.category)}
              ${x.stale ? ' · <span class="is-loss">fiyat bu arada değişti</span>' : ''}</div></td>
            <td>${prMoney(x.cost)}<div style="font-size:12px">${prCostChip(x)}</div></td>
            <td class="right mono">${prMoney(x.current_price)}</td>
            <td class="right mono ${x.current_margin < x.target_margin ? 'is-loss' : ''}">${prPct(x.current_margin)}</td>
            <td class="right mono muted">${prPct(x.target_margin)}</td>
            <td class="right mono"><b>${prMoney(x.suggested_price)}</b>
              <div class="muted" style="font-size:12px">${prPct(x.suggested_margin)}</div></td>
            <td class="right mono">${prDelta(x.change)}</td>
            <td class="right mono">${prMoney(x.estimated_profit)}
              <div class="muted" style="font-size:12px">güven %${x.confidence}</div></td>
            <td class="right" style="white-space:nowrap">
              <button class="btn btn--ghost btn--sm" data-rej="${x.id}">Reddet</button>
              <button class="btn btn--primary btn--sm" data-acc="${x.id}">Uygula</button></td>
          </tr>`).join('')}
        </tbody></table></div>`
      : `<div class="card" style="margin-bottom:14px"><div class="empty">
          Bekleyen öneri yok. <b>Menüyü tara</b> ile yeniden hesaplayın.</div></div>`}

      <div class="card"><div class="card__head"><h3>Menünün tamamı</h3><div class="spacer"></div>
        <div class="row" style="gap:6px">
          <span class="muted" style="font-size:12.5px">Yuvarlama</span>
          ${[0, 0.25, 0.5, 1].map(v => `<button class="zone-tab${this._prRound === v ? ' is-active' : ''}"
            data-r="${v}">${v ? tl(v) : 'yok'}</button>`).join('')}
        </div></div>
        <table class="tbl"><thead><tr>
          <th>Ürün</th><th>Kategori</th><th>Maliyet</th><th class="right">Fiyat</th>
          <th class="right">Marj</th><th class="right">Hedef</th><th class="right">Hedef fiyat</th>
          <th>Durum</th></tr></thead><tbody>
          ${live.rows.map(r => `<tr>
            <td>${esc(r.name)}</td>
            <td class="muted">${esc(r.category)}</td>
            <td>${r.cost_source === 'none' ? '' : prMoney(r.cost) + ' '}${prCostChip(r)}</td>
            <td class="right mono">${prMoney(r.current_price)}</td>
            <td class="right mono ${r.below_target ? 'is-loss' : ''}">${prPct(r.current_margin)}</td>
            <td class="right mono muted">${prPct(r.target_margin)}</td>
            <td class="right mono">${r.suggested_price === null ? '<span class="muted">—</span>' : prMoney(r.suggested_price)}</td>
            <td>${r.suggestible
              ? '<span class="badge badge--open">öneri var</span>'
              : `<span class="muted" style="font-size:12.5px">${esc(r.skip_reason || 'hedefte')}</span>`}</td>
          </tr>`).join('')}
        </tbody></table>
        ${skipped.length ? `<div class="card__body muted" style="font-size:12.5px">
          ${skipped.length} ürün için öneri üretilmedi. Sebep her satırın yanında yazıyor —
          maliyeti girilmemiş bir ürünün marjı %100 değil, bilinmiyordur.</div>` : ''}
      </div>`;

    $$('#fyBody [data-r]').forEach(b => b.onclick = () => {
      this._prRound = Number(b.dataset.r); this.prSuggestions();
    });
    /* The row is looked up by id rather than serialised into the attribute:
       a Turkish apostrophe - "%1'in altinda" - inside a single-quoted attribute
       closes it early and the button silently stops working. */
    $$('#fyBody [data-acc]').forEach(b => b.onclick = () =>
      this.prAccept(s.find(y => String(y.id) === b.dataset.acc)));
    $$('#fyBody [data-rej]').forEach(b => b.onclick = () => this.prReject(b.dataset.rej));
    const all = $('#fyAll');
    if (all) all.onclick = () => this.prAcceptAll(s.length);
  },

  /**
   * Accepting one, with the arithmetic shown and the price editable.
   *
   * The band is not decoration: the module refuses a price outside it, so the
   * modal states it rather than letting the owner discover the rule from a red
   * error after typing. The margin the typed price would actually earn is
   * recomputed as he types, because that is the question - not "is this in the
   * band" but "what does this dish then make".
   */
  prAccept(x) {
    modal(`
      <div class="modal__head"><h3>${esc(x.name)} — fiyatı güncelle</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="split-3" style="margin-bottom:14px">
          <div class="stat"><div class="stat__label">Şu anki fiyat</div>
            <div class="stat__value">${prMoney(x.current_price)}</div>
            <div class="stat__sub">marj ${prPct(x.current_margin)}</div></div>
          <div class="stat"><div class="stat__label">Maliyet</div>
            <div class="stat__value">${prMoney(x.cost)}</div>
            <div class="stat__sub">${x.cost_is_fallback ? esc(x.cost_source_label) + ' — tahmini' : esc(x.cost_source_label)}</div></div>
          <div class="stat"><div class="stat__label">Hedef marj</div>
            <div class="stat__value">${prPct(x.target_margin)}</div>
            <div class="stat__sub">KDV %${tl(x.vat_rate)} hariç</div></div>
        </div>
        ${x.cost_is_fallback ? `<div class="alert alert--warn">
          Bu öneri <b>ölçülmüş bir maliyete</b> dayanmıyor: ${esc(x.cost_source_label)}.
          Ürün satıldıkça satır maliyeti birikir ve öneri kendiliğinden sağlamlaşır.</div>` : ''}
        ${x.stale ? `<div class="alert alert--warn">Öneri hazırlandığından beri fiyat
          ${prMoney(x.recorded_price)} → ${prMoney(x.current_price)} olarak değişti.</div>` : ''}
        <div class="field"><label>Yeni fiyat (KDV dahil)</label>
          <input class="input" id="fyPrice" type="number" step="0.25" value="${x.suggested_price}"></div>
        <p class="muted" style="margin:-6px 0 12px;font-size:12.5px">
          Kabul edilebilir aralık ${prMoney(x.suggested_min)} – ${prMoney(x.suggested_max)}.
          Bu aralığın dışındaki bir fiyatı ürün kartından kendiniz yazabilirsiniz.</p>
        <div class="pl-line"><span>Bu fiyatın marjı</span><b id="fyM">${prPct(x.suggested_margin)}</b></div>
        <div class="pl-line"><span>Fiyat farkı</span><b id="fyD">${prDelta(x.change)}</b></div>
        <div class="pl-line pl-line--muted"><span>Gerekçe</span><span>${esc(x.reason)}</span></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="fyOk">Fiyatı uygula</button></div>`, { wide: true });

    const recalc = () => {
      const p = Number($('#fyPrice').value) || 0;
      const net = p / (1 + Number(x.vat_rate) / 100);
      $('#fyM').textContent = net > 0 ? '%' + tl((net - x.cost) / net * 100) : '—';
      $('#fyD').innerHTML = prDelta(Math.round((p - x.current_price) * 100) / 100);
    };
    $('#fyPrice').oninput = recalc;
    $('#fyOk').onclick = async () => {
      try {
        await api('POST', `/api/pricing/suggestions/${x.id}/accept`, { price: Number($('#fyPrice').value) });
        closeModal(); toast('Fiyat güncellendi'); this.prSuggestions();
      } catch (e) { err(e); }
    };
  },

  /**
   * Rejecting, with a note.
   *
   * The note is the point. A rejection is remembered against this product AND
   * this price, so the same number is not put in front of the owner again
   * tomorrow - which is how the old screen, with no memory at all, trained
   * everyone to ignore it. Six weeks later "menü basıldı" is the sentence that
   * explains why the kebap is still under target.
   */
  prReject(id) {
    modal(`
      <div class="modal__head"><h3>Öneriyi reddet</h3></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">Bu fiyat bir daha önerilmeyecek. Maliyet ya da
          hedef değişip önerilen fiyat farklılaşırsa yeniden sorulur.</p>
        <div class="field"><label>Sebep (isteğe bağlı)</label>
          <input class="input" id="fyNote" placeholder="Menü basıldı, sezon sonuna kadar sabit…"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--danger" id="fyNo">Reddet</button></div>`);
    $('#fyNo').onclick = async () => {
      try {
        await api('POST', `/api/pricing/suggestions/${id}/reject`, { note: $('#fyNote').value });
        closeModal(); toast('Öneri reddedildi'); this.prSuggestions();
      } catch (e) { err(e); }
    };
  },

  async prAcceptAll(n) {
    if (!await confirmBox('Tüm önerileri uygula',
      `${n} ürünün fiyatı önerilen değere çekilecek. Her değişiklik fiyat geçmişine yazılır.`,
      true)) return;
    try {
      const r = await api('POST', '/api/pricing/suggestions/accept-all', {});
      toast(`${r.result.accepted} fiyat güncellendi`);
      if (r.result.failed.length) toast(`${r.result.failed.length} öneri uygulanamadı`, 'error');
      this.prSuggestions();
    } catch (e) { err(e); }
  },

  /* ------------------------------------------------------ hedef marj */

  /**
   * The target margin per category.
   *
   * This is the number the whole module runs on and the old system had no
   * field for anywhere - `pricing_strategy` held one enum, profit or volume,
   * which nothing read. A drinks list at 70% and a kitchen at 35% are two
   * different businesses sharing a till, so the target belongs to the category
   * and inherits from a menu-wide default when it has not been set.
   */
  async prTargets() {
    const t = await api('GET', '/api/pricing/targets');
    $('#fyBody').innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="card__body">
        <div class="row">
          <div><b>Menü geneli hedef marj</b>
            <div class="muted" style="font-size:12.5px">Kendi hedefi olmayan her kategori bunu kullanır.
              Marj <b>KDV hariç</b> ciro üzerinden hesaplanır — menü fiyatının içindeki KDV
              işletmenin parası değildir.</div></div>
          <div class="spacer"></div>
          <input class="input mono right" id="fyMenu" type="number" step="1" min="0" max="95"
            style="width:110px" value="${t.menu_target}">
          <span class="muted">%</span>
          <button class="btn btn--primary btn--sm" id="fyMenuOk">Kaydet</button>
        </div>
        ${t.menu_target_is_default ? `<div class="alert alert--info" style="margin:12px 0 0">
          Henüz hedef belirlenmedi; %${t.menu_target} varsayılan bir başlangıç değeridir.</div>` : ''}
      </div></div>

      <div class="card"><div class="card__head"><h3>Kategori hedefleri</h3></div>
        <table class="tbl"><thead><tr>
          <th>Kategori</th><th class="right">Ürün</th><th class="right">Hedef marj</th>
          <th>Kaynak</th><th></th></tr></thead><tbody>
          ${t.categories.map(c => `<tr>
            <td><b>${esc(c.name)}</b>${c.is_active ? '' : ' <span class="badge badge--gray">pasif</span>'}</td>
            <td class="right mono">${c.product_count}</td>
            <td class="right"><input class="input mono right" type="number" step="1" min="0" max="95"
              style="width:96px;height:34px" data-cat="${c.id}" value="${c.target_margin}"></td>
            <td>${c.own_target
              ? '<span class="badge badge--open">kendi hedefi</span>'
              : '<span class="muted">menü genelinden</span>'}</td>
            <td class="right" style="white-space:nowrap">
              <button class="btn btn--ghost btn--sm" data-save="${c.id}">Kaydet</button>
              ${c.own_target ? `<button class="btn btn--ghost btn--sm" data-clear="${c.id}">Sıfırla</button>` : ''}
            </td></tr>`).join('')}
        </tbody></table></div>`;

    const save = async (catId, val) => {
      try {
        await api('POST', '/api/pricing/targets', { category_id: catId, target_margin: val });
        toast('Hedef marj kaydedildi'); this.prTargets();
      } catch (e) { err(e); }
    };
    $('#fyMenuOk').onclick = () => save(0, Number($('#fyMenu').value));
    $$('#fyBody [data-save]').forEach(b => b.onclick = () =>
      save(Number(b.dataset.save), Number($(`[data-cat="${b.dataset.save}"]`).value)));
    $$('#fyBody [data-clear]').forEach(b => b.onclick = () => save(Number(b.dataset.clear), null));
  },

  /* ------------------------------------------------------ toplu fiyat */

  /**
   * The bulk raise, in two steps that cannot drift apart.
   *
   * The preview is the same call as the apply with a flag, so what is shown is
   * literally what will be written. A percentage typed into a box can move
   * three hundred prices in one click; being shown the list first, with the
   * rows that will not move at all called out, is the difference between a
   * tool and an accident.
   */
  async prBulk() {
    const cats = (await api('GET', '/api/pricing/targets')).categories;
    $('#fyBody').innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="card__body">
        <div class="split-4">
          <div class="field"><label>Kategori</label><select class="input" id="fbCat">
            <option value="0">Tüm menü</option>
            ${cats.map(c => `<option value="${c.id}">${esc(c.name)} (${c.product_count})</option>`).join('')}
          </select></div>
          <div class="field"><label>Değişim (%)</label>
            <input class="input mono" id="fbPct" type="number" step="0.5" value="10"></div>
          <div class="field"><label>Yuvarlama</label><select class="input" id="fbRound">
            <option value="0.25">0,25 ₺</option>
            <option value="0.5" selected>0,50 ₺</option>
            <option value="1">1,00 ₺</option>
            <option value="0">Yuvarlama yok</option>
          </select></div>
          <div class="field"><label>&nbsp;</label>
            <button class="btn btn--ghost btn--wide" id="fbPrev">Önizle</button></div>
        </div>
        <p class="muted" style="margin:0;font-size:12.5px">
          Zam için pozitif, indirim için negatif bir yüzde yazın. Yuvarlama en yakın adıma yapılır —
          bu yüzden küçük tutarlı ürünlerde fiyat hiç değişmeyebilir; liste bunu ayrıca gösterir.
          Her değişiklik fiyat geçmişine tek tek yazılır.</p>
      </div></div>
      <div id="fbOut"></div>`;

    $('#fbPrev').onclick = async () => {
      const body = {
        category_id: Number($('#fbCat').value),
        percent: Number($('#fbPct').value),
        round_to: Number($('#fbRound').value),
      };
      try {
        const r = await api('POST', '/api/pricing/bulk', body);
        $('#fbOut').innerHTML = `<div class="card">
          <div class="card__head"><h3>${r.changed} / ${r.count} üründe fiyat değişecek</h3>
            <div class="spacer"></div>
            <button class="btn btn--primary btn--sm" id="fbGo" ${r.changed ? '' : 'disabled'}>Uygula</button>
          </div>
          <table class="tbl"><thead><tr><th>Ürün</th><th class="right">Eski</th>
            <th class="right">Hesaplanan</th><th class="right">Yeni</th><th class="right">Fark</th>
            </tr></thead><tbody>
            ${r.plan.map(p => `<tr${p.unchanged ? ' class="muted"' : ''}>
              <td>${esc(p.name)}${p.unchanged ? ' <span class="badge badge--gray">değişmiyor</span>' : ''}</td>
              <td class="right mono">${prMoney(p.old_price)}</td>
              <td class="right mono muted">${prMoney(p.raw_price)}</td>
              <td class="right mono"><b>${prMoney(p.new_price)}</b></td>
              <td class="right mono">${prDelta(p.change)}</td></tr>`).join('')}
          </tbody></table></div>`;
        const go = $('#fbGo');
        if (go) go.onclick = async () => {
          if (!await confirmBox('Toplu fiyat değişikliği',
            `${r.changed} ürünün fiyatı değişecek. Bu işlem geri alınamaz; her değişiklik fiyat geçmişine yazılır.`,
            true)) return;
          try {
            const a = await api('POST', '/api/pricing/bulk/apply', body);
            toast(`${a.changed} ürünün fiyatı güncellendi`);
            this.prBulk();
          } catch (e) { err(e); }
        };
      } catch (e) { err(e); }
    };
  },

  /* --------------------------------------------------------- içgörüler */

  /**
   * What is losing money, and where the money is.
   *
   * `pricing_insights.php` counted rows in a table nothing wrote and labelled
   * them in English. This counts the menu, and it leads with the honesty line:
   * how much of the margin picture is measured and how much is recollection.
   */
  async prInsights() {
    const r = await api('GET', '/api/pricing/insights');
    const s = r.summary;
    $('#fyBody').innerHTML = `
      <div class="split-4" style="margin-bottom:14px">
        <div class="stat"><div class="stat__label">Hedefin altında</div>
          <div class="stat__value ${s.below_target ? 'is-loss' : ''}">${s.below_target}</div>
          <div class="stat__sub">${s.costed} maliyetli ürün içinde</div></div>
        <div class="stat"><div class="stat__label">Zararına satılan</div>
          <div class="stat__value ${s.losing ? 'is-loss' : ''}">${s.losing}</div>
          <div class="stat__sub">maliyetin altında fiyat</div></div>
        <div class="stat"><div class="stat__label">Ortalama marj</div>
          <div class="stat__value">${prPct(s.average_margin)}</div>
          <div class="stat__sub">KDV hariç ciro üzerinden</div></div>
        <div class="stat"><div class="stat__label">Erişilebilir katkı</div>
          <div class="stat__value">${prMoney(s.potential_gain)}</div>
          <div class="stat__sub">son ${s.sales_window_days} günün satışıyla</div></div>
      </div>

      <div class="card" style="margin-bottom:14px"><div class="card__body">
        <div class="pl-line"><span>Maliyeti satıştan ölçülmüş ürün</span>
          <b class="mono">${s.measured_cost}</b></div>
        <div class="pl-line"><span>Maliyeti tahmini olan ürün (kart ya da reçete)</span>
          <b class="mono">${s.fallback_cost}</b></div>
        <div class="pl-line"><span>Maliyeti hiç bilinmeyen ürün</span>
          <b class="mono ${s.uncosted ? 'is-loss' : ''}">${s.uncosted}</b></div>
        <p class="muted" style="margin:10px 0 0;font-size:12.5px">
          Maliyeti bilinmeyen ürün <b>%100 marjlı değildir</b>, marjı bilinmiyordur. Bu ürünler
          yukarıdaki ortalamaya ve önerilere hiç girmez; aşağıda tek tek listelenirler.</p>
      </div></div>

      <div class="split-2">
        <div class="card"><div class="card__head"><h3>Hedefin altındakiler</h3></div>
          ${r.below_target.length ? `<table class="tbl"><thead><tr>
            <th>Ürün</th><th class="right">Marj</th><th class="right">Hedef</th>
            <th class="right">Hedef fiyat</th></tr></thead><tbody>
            ${r.below_target.slice(0, 20).map(x => `<tr>
              <td>${esc(x.name)}<div class="muted" style="font-size:12px">${esc(x.category)}</div></td>
              <td class="right mono is-loss">${prPct(x.current_margin)}</td>
              <td class="right mono muted">${prPct(x.target_margin)}</td>
              <td class="right mono">${prMoney(x.suggested_price)}</td></tr>`).join('')}
          </tbody></table>` : '<div class="empty">Hedefin altında ürün yok.</div>'}</div>

        <div class="card"><div class="card__head"><h3>En büyük kazanç</h3></div>
          ${r.biggest_gains.length ? `<table class="tbl"><thead><tr>
            <th>Ürün</th><th class="right">Adet</th><th class="right">Fark</th>
            <th class="right">Tahmini katkı</th></tr></thead><tbody>
            ${r.biggest_gains.slice(0, 20).map(x => `<tr>
              <td>${esc(x.name)}<div style="font-size:12px">${prCostChip(x)}</div></td>
              <td class="right mono">${tl(x.units_sold)}</td>
              <td class="right mono">${prDelta(x.change)}</td>
              <td class="right mono"><b>${prMoney(x.estimated_profit)}</b></td></tr>`).join('')}
          </tbody></table>
          <div class="card__body muted" style="font-size:12.5px">
            Sıralama yüzdeye değil <b>paraya</b> göre: son ${s.sales_window_days} günde satılan adetle
            çarpılmış katkı. Kimsenin sipariş etmediği bir üründeki %40 zam, her gün satılan bir
            üründeki %5'ten daha az kazandırır.</div>` : '<div class="empty">Öneri yok.</div>'}</div>
      </div>

      ${r.uncosted.length ? `<div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Maliyeti girilmemiş ürünler (${r.uncosted.length})</h3></div>
        <table class="tbl"><thead><tr><th>Ürün</th><th>Kategori</th>
          <th class="right">Fiyat</th><th class="right">Satış adedi</th><th></th></tr></thead><tbody>
          ${r.uncosted.map(x => `<tr><td>${esc(x.name)}</td><td class="muted">${esc(x.category)}</td>
            <td class="right mono">${prMoney(x.current_price)}</td>
            <td class="right mono">${tl(x.units_sold)}</td>
            <td class="right"><button class="btn btn--ghost btn--sm" data-cost="${x.product_id}">Maliyet gir</button></td>
          </tr>`).join('')}
        </tbody></table></div>` : ''}

      <div class="card" style="margin-top:14px"><div class="card__body">
        <div class="row" style="gap:22px;flex-wrap:wrap">
          <span class="muted">Öneri geçmişi:</span>
          <span><b class="mono">${r.funnel.total}</b> toplam</span>
          <span><b class="mono">${r.funnel.pending}</b> bekleyen</span>
          <span><b class="mono">${r.funnel.accepted}</b> uygulanan</span>
          <span><b class="mono">${r.funnel.rejected}</b> reddedilen</span>
          <span class="muted">ortalama güven ${r.funnel.avg_confidence === null ? '—' : '%' + r.funnel.avg_confidence}</span>
        </div>
      </div></div>`;

    $$('#fyBody [data-cost]').forEach(b => b.onclick = () => this.prCostForm(Number(b.dataset.cost)));
  },

  /* ---------------------------------------------------------- kararlar */
  async prDecided() {
    const [acc, rej] = await Promise.all([
      api('GET', '/api/pricing/decided?kind=accepted'),
      api('GET', '/api/pricing/decided?kind=rejected'),
    ]);
    const table = (rows, kind) => rows.length ? `<table class="tbl"><thead><tr>
        <th>Ürün</th><th class="right">Eski</th><th class="right">${kind === 'acc' ? 'Yeni' : 'Önerilen'}</th>
        <th>Maliyet</th><th>Kim</th><th>Ne zaman</th>${kind === 'acc' ? '' : '<th>Sebep</th>'}
        </tr></thead><tbody>
        ${rows.map(x => `<tr>
          <td>${esc(x.name)}</td>
          <td class="right mono">${prMoney(x.old_price)}</td>
          <td class="right mono"><b>${prMoney(kind === 'acc' ? x.new_price : x.suggested_price)}</b></td>
          <td>${prMoney(x.cost)} ${prCostChip(x)}</td>
          <td>${esc(x.by || '—')}</td>
          <td class="muted mono">${esc(String(x.at || '').slice(0, 16).replace('T', ' '))}</td>
          ${kind === 'acc' ? '' : `<td class="muted">${esc(x.note || '—')}</td>`}
        </tr>`).join('')}
      </tbody></table>` : '<div class="empty">Kayıt yok.</div>';

    $('#fyBody').innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card__head"><h3>Uygulanan öneriler (${acc.rows.length})</h3></div>
        ${table(acc.rows, 'acc')}</div>
      <div class="card"><div class="card__head"><h3>Reddedilen öneriler (${rej.rows.length})</h3></div>
        ${table(rej.rows, 'rej')}
        <div class="card__body muted" style="font-size:12.5px">
          Reddedilen bir fiyat bir daha önerilmez. Maliyet ya da hedef marj değişip önerilen fiyat
          farklılaşırsa yeni bir soru sayılır ve yeniden sorulur.</div></div>`;
  },

  /* =================================================================== */
  /*  Ürün kartları                                                       */
  /* =================================================================== */

  _prQuery: '',

  /**
   * The product list the old system did not have: searchable by product OR
   * category, grouped under its category heading, with the station each
   * category routes to, and with inactive rows visible - you cannot
   * re-activate what the list refuses to show you.
   */
  /* An older link or a saved page can still say `urunkart`; send it home. */
  async page_urunkart() { return this.page_products(); },

  async prProductList() {
    const q = this._prQuery ? '?q=' + encodeURIComponent(this._prQuery) : '';
    const r = await api('GET', '/api/pricing/products' + q);
    if (!r.products.length) {
      $('#ukBody').innerHTML = '<div class="card"><div class="empty">Eşleşen ürün yok.</div></div>';
      return;
    }
    // grouped under the category heading, which is how a menu is read - the
    // existing flat list with a Kategori column is fine for 20 products and
    // unusable at 200
    const groups = [];
    for (const p of r.products) {
      const key = p.category_name;
      let g = groups.find(x => x.name === key);
      if (!g) { g = { name: key, id: p.category_id, station: p.station_name, rows: [] }; groups.push(g); }
      g.rows.push(p);
    }
    $('#ukBody').innerHTML = groups.map(g => `
      <div class="card" style="margin-bottom:14px">
        <div class="card__head"><h3>${esc(g.name)}</h3>
          ${g.station
            ? `<span class="badge badge--gray">${esc(g.station)}</span>`
            : '<span class="badge badge--open" title="Bu kategorinin siparişi hiçbir ekrana düşmez">istasyon yok</span>'}
          <div class="spacer"></div>
          <span class="muted" style="font-size:12.5px;margin-right:10px">${g.rows.length} ürün</span>
          <button class="btn btn--ghost btn--sm" data-cat="${g.id || ''}">Kategoriyi düzenle</button></div>
        <table class="tbl"><thead><tr>
          <th>Ürün</th><th class="right">Fiyat</th><th>Maliyet</th><th class="right">Marj</th>
          <th class="right">Hedef</th><th class="right">KDV</th><th></th></tr></thead><tbody>
          ${g.rows.map(p => `<tr>
            <td><b>${esc(p.name)}</b>
              ${p.is_active ? '' : ' <span class="badge badge--gray">pasif</span>'}
              ${p.use_in_pos ? '' : ' <span class="badge badge--gray">kasada gizli</span>'}
              ${p.use_in_qr ? ' <span class="badge badge--gray">QR</span>' : ''}</td>
            <td class="right mono">${prMoney(p.price)}</td>
            <td>${p.cost_source === 'none' ? '' : prMoney(p.cost) + ' '}${prCostChip(p)}</td>
            <td class="right mono ${p.below_target ? 'is-loss' : ''}">${prPct(p.margin)}</td>
            <td class="right mono muted">${prPct(p.target_margin)}</td>
            <td class="right mono">%${tl(p.vat_rate)}</td>
            <td class="right"><button class="btn btn--ghost btn--sm" data-card="${p.id}">Kart</button></td>
          </tr>`).join('')}
        </tbody></table></div>`).join('');
    $$('#ukBody [data-card]').forEach(b => b.onclick = () => this.prProductCard(Number(b.dataset.card)));
    /*
     * The category header is where somebody looks when the pide counter is not
     * getting its orders - the station is written right there - so that is
     * where the way to fix it belongs.
     */
    $$('#ukBody [data-cat]').forEach(b => b.onclick = async () => {
      const id = Number(b.dataset.cat);
      if (!id) return toast('Bu ürünler kategorisiz.', 'error');
      try {
        const all = (await api('GET', '/api/manage/categories')).categories;
        const c = all.find(x => Number(x.id) === id);
        if (!c) return toast('Kategori bulunamadı', 'error');
        this.categoryForm(c);
      } catch (e) { err(e); }
    });
  },

  /**
   * The product card: what it earns, both histories, and what may be done to it.
   *
   * Everything here was missing. `product_costs` was written and never read
   * back; `product_price_history` was written into four columns that did not
   * exist, inside a catch, so it was empty for months; there was no delete of
   * any kind and no guard to need one.
   */
  async prProductCard(id) {
    const c = await api('GET', `/api/pricing/products/${id}`);
    const p = c.product;
    const e = c.economics;
    const ph = c.price_history;

    modal(`
      <div class="modal__head"><h3>${esc(p.name)}</h3>
        ${p.is_active ? '' : '<span class="badge badge--gray">pasif</span>'}
        <div class="spacer"></div><button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="split-4" style="margin-bottom:14px">
          <div class="stat"><div class="stat__label">Satış fiyatı</div>
            <div class="stat__value">${prMoney(e.price)}</div>
            <div class="stat__sub">KDV %${tl(e.vat_rate)} · net ${prMoney(e.net)}</div></div>
          <div class="stat"><div class="stat__label">Maliyet</div>
            <div class="stat__value">${prMoney(e.cost)}</div>
            <div class="stat__sub">${esc(e.cost_source_label)}${e.cost_is_fallback ? ' · tahmini' : ''}</div></div>
          <div class="stat"><div class="stat__label">Marj</div>
            <div class="stat__value ${e.margin !== null && e.margin < e.target_margin ? 'is-loss' : ''}">${prPct(e.margin)}</div>
            <div class="stat__sub">hedef ${prPct(e.target_margin)}</div></div>
          <div class="stat"><div class="stat__label">Hedef fiyat</div>
            <div class="stat__value">${e.target_price === null ? '—' : prMoney(e.target_price)}</div>
            <div class="stat__sub">${esc(p.category_name || 'Kategorisiz')}${p.station_name ? ' · ' + esc(p.station_name) : ''}</div></div>
        </div>

        <div class="card" style="margin-bottom:14px">
          <div class="card__head"><h3>Maliyet geçmişi</h3><div class="spacer"></div>
            <button class="btn btn--ghost btn--sm" id="ukCost">Yeni maliyet gir</button></div>
          ${c.cost_history.length ? `<table class="tbl"><thead><tr>
            <th>Yürürlük</th><th class="right">Maliyet</th><th>Not</th><th>Giren</th></tr></thead><tbody>
            ${c.cost_history.map((h, i) => `<tr>
              <td class="mono">${esc(String(h.effective_date).slice(0, 10))}
                ${i === 0 ? ' <span class="badge badge--open">güncel</span>' : ''}</td>
              <td class="right mono">${prMoney(h.cost)}</td>
              <td class="muted">${esc(h.note || '—')}</td>
              <td class="muted">${esc(h.created_by_name || '—')}</td></tr>`).join('')}
          </tbody></table>` : `<div class="card__body muted">
            Bu ürün için maliyet kaydı yok. Kartındaki maliyet ${prMoney(e.card_cost)} —
            elle yazılmış, tarihi bilinmiyor.</div>`}
          <div class="card__body muted" style="font-size:12.5px">
            Geçerli maliyet <b>yürürlük tarihi en yeni</b> olan kayıttır; geriye dönük girilen bir
            irsaliye geçmişe yazılır ama bugünün maliyetini değiştirmez.
            ${e.recipe_cost !== null ? `Reçeteye göre hesap: <b>${prMoney(e.recipe_cost)}</b>.` : ''}
          </div>
        </div>

        <div class="card" style="margin-bottom:14px">
          <div class="card__head"><h3>Fiyat geçmişi</h3></div>
          ${ph.changes.length ? `<table class="tbl"><thead><tr>
            <th>Tarih</th><th class="right">Eski</th><th class="right">Yeni</th>
            <th class="right">Fark</th><th>Kaynak</th><th>Kim</th></tr></thead><tbody>
            ${ph.changes.map(h => `<tr>
              <td class="mono">${esc(String(h.changed_at).slice(0, 16).replace('T', ' '))}</td>
              <td class="right mono">${prMoney(h.old_price)}</td>
              <td class="right mono"><b>${prMoney(h.new_price)}</b></td>
              <td class="right mono">${prDelta(h.change)}</td>
              <td>${esc(h.source_label)}</td>
              <td class="muted">${esc(h.changed_by_name)}</td></tr>`).join('')}
          </tbody></table>` : '<div class="card__body muted">Fiyat hiç değişmemiş.</div>'}
        </div>

        <div class="card"><div class="card__head"><h3>İşlemler</h3></div>
          <div class="card__body">
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <button class="btn btn--primary btn--sm" id="ukEdit">Düzenle</button>
              <button class="btn btn--ghost btn--sm" id="ukDup">Kopyala</button>
              <button class="btn btn--ghost btn--sm" id="ukToggle">
                ${p.is_active ? 'Pasife al' : 'Yeniden aktif et'}</button>
              <div class="spacer"></div>
              <button class="btn btn--danger btn--sm" id="ukDel"
                ${c.usage.can_hard_delete ? '' : 'disabled'}>Kalıcı sil</button>
            </div>
            <p class="muted" style="margin:12px 0 0;font-size:12.5px">
              ${c.usage.can_hard_delete
                ? 'Bu ürün hiçbir adisyonda kullanılmamış, kalıcı olarak silinebilir.'
                : `Bu ürün <b>${c.usage.orders} adisyonda</b> (${c.usage.items} satır) kullanılmış.
                   Kalıcı silinemez — silinirse geçmiş raporlar boş satırlara dönerdi. Pasife
                   alındığında kasadan kalkar, geçmiş raporlar olduğu gibi çalışmaya devam eder.`}
            </p>
          </div></div>
      </div>`, { wide: true });

    /*
     * Name, category, price, VAT, station, stock: one form, the same one the
     * "Ürün ekle" button opens. The card is where you LOOK at a product, so
     * it is where the edit belongs - not on a second screen.
     */
    $('#ukEdit').onclick = () => { closeModal(); this.productForm(p); };
    $('#ukCost').onclick = () => this.prCostForm(id);
    $('#ukDup').onclick = () => this.prDuplicate(id, p.name);
    $('#ukToggle').onclick = async () => {
      try {
        if (p.is_active) await api('DELETE', `/api/pricing/products/${id}`);
        else await api('POST', `/api/pricing/products/${id}/activate`, {});
        closeModal(); toast(p.is_active ? 'Ürün pasife alındı' : 'Ürün aktif edildi');
        this.prProductList();
      } catch (err2) { err(err2); }
    };
    $('#ukDel').onclick = async () => {
      if (!await confirmBox('Ürünü kalıcı sil',
        `"${p.name}" ve maliyet / fiyat geçmişi kalıcı olarak silinecek. Bu işlem geri alınamaz.`,
        true)) return;
      try {
        await api('DELETE', `/api/pricing/products/${id}?hard=1`);
        closeModal(); toast('Ürün silindi'); this.prProductList();
      } catch (err2) { err(err2); }
    };
  },

  /** Record a cost as of a date. The date is the whole point of the table. */
  prCostForm(productId) {
    const today = new Date();
    const iso = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    modal(`
      <div class="modal__head"><h3>Yeni maliyet</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="split-2">
          <div class="field"><label>Maliyet (₺)</label>
            <input class="input mono" id="ucVal" type="number" step="0.01" min="0"></div>
          <div class="field"><label>Yürürlük tarihi</label>
            <input class="input" id="ucDate" type="date" value="${iso}"></div>
        </div>
        <div class="field"><label>Not (isteğe bağlı)</label>
          <input class="input" id="ucNote" placeholder="Mart alımı, yeni tedarikçi…"></div>
        <p class="muted" style="margin:0;font-size:12.5px">
          Kayıt geçmişe eklenir. Yürürlük tarihi en yeni olan kayıt ürünün güncel maliyeti olur —
          geçmiş bir tarih girerseniz bugünkü maliyet değişmez.</p>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="ucOk">Kaydet</button></div>`);
    $('#ucOk').onclick = async () => {
      try {
        await api('POST', `/api/pricing/products/${productId}/costs`, {
          cost: Number($('#ucVal').value),
          effective_date: $('#ucDate').value,
          note: $('#ucNote').value,
        });
        closeModal(); toast('Maliyet kaydedildi');
        if (this._prTab && App.page === 'fiyat') this.page_fiyat(this._prTab);
        else this.prProductList();
      } catch (e) { err(e); }
    };
  },

  prDuplicate(productId, name) {
    modal(`
      <div class="modal__head"><h3>Ürünü kopyala</h3></div>
      <div class="modal__body">
        <div class="field"><label>Yeni ürün adı</label>
          <input class="input" id="udName" value="${esc(name)} (kopya)"></div>
        <p class="muted" style="margin:0;font-size:12.5px">
          Fiyat, maliyet, KDV, kategori ve <b>reçete</b> kopyalanır. Maliyet ve fiyat geçmişi
          kopyalanmaz — o geçmiş ilk ürüne aittir.</p>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="udOk">Kopyala</button></div>`);
    $('#udOk').onclick = async () => {
      try {
        const r = await api('POST', `/api/pricing/products/${productId}/duplicate`,
          { name: $('#udName').value });
        closeModal(); toast(`"${r.result.name}" oluşturuldu`);
        this.prProductList();
      } catch (e) { err(e); }
    };
  },

  /**
   * Categories: deactivate (taking the products with it) or delete an empty one.
   *
   * One switch, one meaning. A category left active with its products hidden -
   * or hidden with its products still ringing up at the till - is the state
   * that produced "why is Kahvaltı empty" and "why can I still sell the
   * discontinued menu" in the same week.
   */
  async prCategoryList() {
    const t = await api('GET', '/api/pricing/targets');
    modal(`
      <div class="modal__head"><h3>Kategoriler</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <table class="tbl"><thead><tr><th>Kategori</th><th class="right">Ürün</th>
          <th class="right">Hedef marj</th><th></th></tr></thead><tbody>
          ${t.categories.map(c => `<tr>
            <td><b>${esc(c.name)}</b>${c.is_active ? '' : ' <span class="badge badge--gray">pasif</span>'}</td>
            <td class="right mono">${c.product_count}</td>
            <td class="right mono">${prPct(c.target_margin)}</td>
            <td class="right" style="white-space:nowrap">
              ${c.is_active
                ? `<button class="btn btn--ghost btn--sm" data-off="${c.id}" data-n="${esc(c.name)}"
                     data-c="${c.product_count}">Pasife al</button>`
                : `<button class="btn btn--ghost btn--sm" data-on="${c.id}">Aktif et</button>`}
              <button class="btn btn--danger btn--sm" data-del="${c.id}" data-n="${esc(c.name)}"
                ${c.product_count ? 'disabled' : ''}>Sil</button>
            </td></tr>`).join('')}
        </tbody></table>
        <p class="muted" style="margin:12px 0 0;font-size:12.5px">
          Bir kategoriyi pasife almak <b>içindeki bütün ürünleri de</b> pasife alır; aktif etmek
          geri getirir. Kalıcı silme yalnızca içi boş kategoriler için açıktır — ürünlü bir
          kategoriyi silmek o ürünleri hiçbir yere bağlı bırakmazdı.</p>
      </div>`, { wide: true });

    $$('#modal [data-off]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('Kategoriyi pasife al',
        `"${b.dataset.n}" ve içindeki ${b.dataset.c} ürün kasadan kalkacak.`, true)) return;
      try {
        const r = await api('DELETE', `/api/pricing/categories/${b.dataset.off}`);
        toast(`${r.result.products} ürün pasife alındı`);
        this.prCategoryList();
      } catch (e) { err(e); }
    });
    $$('#modal [data-on]').forEach(b => b.onclick = async () => {
      try {
        await api('POST', `/api/pricing/categories/${b.dataset.on}/activate`, { with_products: true });
        toast('Kategori aktif edildi'); this.prCategoryList();
      } catch (e) { err(e); }
    });
    $$('#modal [data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('Kategoriyi sil', `"${b.dataset.n}" kalıcı olarak silinecek.`, true)) return;
      try {
        await api('DELETE', `/api/pricing/categories/${b.dataset.del}?hard=1`);
        toast('Kategori silindi'); this.prCategoryList();
      } catch (e) { err(e); }
    });
  },
});
