/* =====================================================================
   NOKTApp POS - Finans: İşlemler, Gün sonu, Finans raporu
   =====================================================================
   Three screens, one language. The old system had a finance dashboard, a day
   list, a day detail, a transactions list and a drilldown browser, and each of
   them had its own idea of what a Tuesday was worth. Here every figure on all
   three comes from /api/finance, which computes it once from pnl.js.

   Same visual grammar as the rest of the till: .card, .tbl, .stat, .field,
   .badge, .pl-line, .right, .mono. One accent (orange), loss in red, nothing
   green, no emoji.

   The destructive buttons on İşlemler are hidden from anyone who is not the
   owner - and hiding them is decoration, not security: the server refuses them
   as well, which is why the screen asks /api/finance/context who it is talking
   to instead of guessing from the role.
   ===================================================================== */
'use strict';

registerIcon('finans',
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6M7 17h4"/>');
registerIcon('gunsonu',
  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>');
registerIcon('islemler',
  '<path d="M4 6h13M4 12h9M4 18h7"/><path d="M16 15l3 3 3-4"/>');

registerPage({ id: 'finans', label: 'Finans', icon: 'finans', perm: 'report.view' , group: 'reports' }, 'pnl');
registerPage({ id: 'gunsonu', label: 'Gün sonu', icon: 'gunsonu', perm: 'report.view' , group: 'reports' }, 'finans');
registerPage({ id: 'islemler', label: 'İşlemler', icon: 'islemler', perm: 'report.view' , group: 'reports' }, 'gunsonu');

/* ------------------------------------------------------------ helpers */
const FIN_TODAY = () => new Date().toISOString().slice(0, 10);
const FIN_AGO = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const fmoney = (n) => tl(n) + ' ₺';
const fpct = (n) => '%' + tl(n);

/** The six period chips the owner actually uses. */
function finPresets() {
  const t = new Date();
  const first = new Date(t.getFullYear(), t.getMonth(), 1);
  const prevFirst = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  const prevLast = new Date(t.getFullYear(), t.getMonth(), 0);
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return [
    ['bugun', 'Bugün', FIN_TODAY(), FIN_TODAY()],
    ['dun', 'Dün', FIN_AGO(1), FIN_AGO(1)],
    ['son7', 'Son 7 gün', FIN_AGO(6), FIN_TODAY()],
    ['son30', 'Son 30 gün', FIN_AGO(29), FIN_TODAY()],
    ['buay', 'Bu ay', iso(first), FIN_TODAY()],
    ['gecenay', 'Geçen ay', iso(prevFirst), iso(prevLast)],
  ];
}

/**
 * A labelled bar. The share is drawn clamped to the width of the card but the
 * NUMBER is printed unclamped, because an İptal figure over 100% of takings is
 * precisely the day somebody needs to look at - the old screen clamped both and
 * hid it.
 */
function finBar(label, value, share, tone) {
  const w = Math.max(0, Math.min(100, Number(share) || 0));
  const colour = tone === 'loss' ? 'var(--red)' : 'var(--orange)';
  return `<div style="padding:10px 2px;border-bottom:1px solid var(--line)">
    <div class="row" style="gap:10px">
      <span style="font-size:14px">${esc(label)}</span><div class="spacer"></div>
      <span class="mono strong">${fmoney(value)}</span>
      <span class="mono muted" style="min-width:62px;text-align:right">${fpct(share)}</span>
      ${share > 100 ? '<span class="badge badge--open" title="Ciroyu aşıyor">!</span>' : ''}
    </div>
    <div style="height:6px;border-radius:3px;background:var(--line);margin-top:7px;overflow:hidden">
      <i style="display:block;height:100%;width:${w}%;background:${colour};border-radius:3px"></i>
    </div>
  </div>`;
}

function finStat(label, value, sub, tone) {
  return `<div class="stat"><div class="stat__label">${esc(label)}</div>
    <div class="stat__value${tone ? ' ' + tone : ''}">${value}</div>
    <div class="stat__sub">${sub || ''}</div></div>`;
}

function finEmpty(text) { return `<div class="empty">${esc(text)}</div>`; }

/** The toolbar shared by all three screens: chips + two dates + Getir. */
function finToolbar(idPrefix, from, to, extra = '') {
  return `<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px">
    ${finPresets().map(([k, l, f, t]) =>
      `<button class="zone-tab" data-preset="${k}" data-f="${f}" data-t="${t}">${l}</button>`).join('')}
    <div class="spacer"></div>
    <input class="input" id="${idPrefix}From" type="date" value="${from}" style="width:150px;height:36px">
    <input class="input" id="${idPrefix}To" type="date" value="${to}" style="width:150px;height:36px">
    <button class="btn btn--primary btn--sm" id="${idPrefix}Run">Getir</button>
    ${extra}
  </div>`;
}

Screens.add({

  /* remembered between visits so a chosen period survives a trip to a bill */
  _finFrom: null, _finTo: null,
  _daysFrom: null, _daysTo: null, _daysOnlyClosed: false,
  _txFrom: null, _txTo: null, _txStatus: 'all', _txQ: '',
  _finCtx: { is_owner: false, checkpoint: null, can_close: false },

  /** Who are we, and where is the checkpoint. Asked once per screen draw. */
  async finContext() {
    try { this._finCtx = await api('GET', '/api/finance/context'); }
    catch (_) { this._finCtx = { is_owner: false, checkpoint: null, can_close: false }; }
    return this._finCtx;
  },

  finBindPresets(setRange) {
    $$('#main [data-preset]').forEach(b => b.onclick = () => setRange(b.dataset.f, b.dataset.t));
  },

  /* ===================================================================
     FİNANS RAPORU
     =================================================================== */
  async page_finans() {
    const from = this._finFrom || FIN_AGO(29);
    const to = this._finTo || FIN_TODAY();
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Finans raporu</h2><div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="fnCsv">CSV</button>
        <button class="btn btn--ghost btn--sm" id="fnXls">Excel</button>
        <button class="btn btn--ghost btn--sm" id="fnPdf">PDF</button>
        <button class="btn btn--ghost btn--sm" id="fnDays">Gün sonu</button>
      </div>
      ${finToolbar('fn', from, to)}
      <div id="fnBody"><div class="empty">Hesaplanıyor…</div></div></div>`;

    const setRange = (f, t) => { this._finFrom = f; this._finTo = t; this.page_finans(); };
    this.finBindPresets(setRange);
    $('#fnRun').onclick = () => setRange($('#fnFrom').value, $('#fnTo').value);
    $('#fnDays').onclick = () => go('gunsonu');
    const fnEx = (fmt) => `/api/finance/export/report?from=${from}&to=${to}${fmt ? '&format=' + fmt : ''}`;
    $('#fnCsv').onclick = (e) => this.download(fnEx(''), e.currentTarget);
    $('#fnXls').onclick = (e) => this.download(fnEx('xlsx'), e.currentTarget);
    $('#fnPdf').onclick = (e) => this.download(fnEx('pdf'), e.currentTarget);

    let r;
    try { r = await api('GET', `/api/finance/report?from=${from}&to=${to}`); }
    catch (e) { $('#fnBody').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; return; }
    const T = r.totals, S = r.summary, B = r.purchases;
    /* Every panel exports both ways: the spreadsheet to work in, the PDF to file. */
    const ex = (kind, fmt) => `/api/finance/export/${kind}?from=${from}&to=${to}`
      + (fmt ? `&format=${fmt}` : '');
    const exPair = (kind) => `<button class="btn btn--ghost btn--sm" data-ex="${kind}">CSV</button>
      <button class="btn btn--ghost btn--sm" data-ex="${kind}" data-fmt="pdf">PDF</button>`;

    $('#fnBody').innerHTML = `
      <div class="split-4">
        ${finStat('Bugünkü satış', fmoney(r.kpi.today_sales), `${r.kpi.today_orders} adisyon`)}
        ${finStat('Son 30 gün satış', fmoney(r.kpi.last30_sales), 'canlı')}
        ${finStat('Son 7 gün nakit', fmoney(r.kpi.last7_cash), '')}
        ${finStat('Son 7 gün kart', fmoney(r.kpi.last7_card), 've diğer yöntemler')}
      </div>

      <div class="split-4" style="margin-top:14px">
        ${finStat('Ciro (KDV dahil)', fmoney(T.revenue_gross), `${T.orders} adisyon · ort. ${fmoney(T.average_ticket)}`)}
        ${finStat('Net kâr', fmoney(T.net_profit), 'marj ' + fpct(T.net_margin),
          T.net_profit < 0 ? 'is-loss' : 'is-profit')}
        ${finStat('Ürün maliyeti', fmoney(T.cogs), 'brüt kâr ' + fmoney(T.gross_profit))}
        ${finStat('Giderler', fmoney(T.expenses), 'KDV ' + fmoney(T.vat))}
      </div>

      <div class="split-2" style="margin-top:14px;align-items:start">
        <div class="card">
          <div class="card__head"><h3>Dönem özeti</h3><div class="spacer"></div>
            <span class="muted" style="font-size:12px">ciroya oranla</span></div>
          <div class="card__body" style="padding-top:4px">
            ${finBar('Kâr', S.profit, S.profit_share, S.profit < 0 ? 'loss' : '')}
            ${finBar('Maliyet', S.cost, S.cost_share)}
            ${finBar('KDV', S.vat, S.vat_share)}
            ${finBar('İndirim', S.discounts, S.discount_share)}
            ${finBar('İptal / rapor dışı', S.cancelled, S.cancelled_share, S.cancelled_share > 100 ? 'loss' : '')}
            ${S.cancelled_share > 100 ? `<div class="alert alert--warn" style="margin:12px 0 0">
              İptaller ciroyu aşıyor — kontrol edin.</div>` : ''}
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>Alımlar</h3><div class="spacer"></div>
            <span class="muted" style="font-size:12px">${B.count} fatura</span></div>
          <div class="card__body">
            <div class="pl-line"><span>Toplam alım</span><span class="mono">${fmoney(B.total)}</span></div>
            <div class="pl-line"><span>Alım KDV</span><span class="mono">${fmoney(B.vat)} · ${fpct(B.vat_share)}</span></div>
            <div class="pl-line"><span>Alım net</span><span class="mono">${fmoney(B.net)} · ${fpct(B.net_share)}</span></div>
            <div class="pl-line pl-line--sub"><span>Alım / satış</span><span class="mono">${fpct(B.vs_sales)}</span></div>
            ${B.vs_sales > 60 ? `<div class="alert alert--warn" style="margin:12px 0 0">
              Alımlar cironun ${fpct(B.vs_sales)}'i. Stok fazlası veya fiyat artışı olabilir.</div>` : ''}
          </div>
        </div>
      </div>

      <div class="split-2" style="margin-top:14px;align-items:start">
        <div class="card">
          <div class="card__head"><h3>Ödeme yöntemleri</h3><div class="spacer"></div>
            ${exPair('payments')}</div>
          <div class="card__body" style="padding-top:4px">
            ${r.payments.length ? r.payments.map(p =>
              finBar(label(p.method) + ` (${p.count})`, p.total, p.share)).join('')
              + `<div class="pl-line pl-line--sub" style="margin-top:10px">
                   <span>Toplam tahsilat</span><span class="mono">${fmoney(r.payments_total)}</span></div>`
              : finEmpty('Bu dönemde tahsilat yok.')}
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>Kategoriler</h3><div class="spacer"></div>
            ${exPair('categories')}</div>
          <div class="card__body">
            ${r.categories.length ? `<table class="tbl"><thead><tr>
                <th>Kategori</th><th class="right">Adet</th><th class="right">Ciro</th>
                <th class="right">Kâr</th><th class="right">Marj</th></tr></thead><tbody>
              ${r.categories.map(c => `<tr><td>${esc(c.category)}</td>
                <td class="right mono">${c.qty}</td>
                <td class="right mono">${fmoney(c.revenue_net)}</td>
                <td class="right mono ${c.profit < 0 ? 'is-loss' : ''}">${fmoney(c.profit)}</td>
                <td class="right mono">${fpct(c.margin)}</td></tr>`).join('')}
            </tbody></table>` : finEmpty('Satış yok.')}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Ürün satışları</h3><div class="spacer"></div>
          <span class="muted" style="font-size:12px">kâra katkıya göre sıralı</span>
          ${exPair('products')}</div>
        <div class="card__body">
          ${r.products.length ? `<table class="tbl"><thead><tr>
              <th>Ürün</th><th>Kategori</th><th class="right">Adet</th>
              <th class="right">Ciro</th><th class="right">Maliyet</th>
              <th class="right">Kâr</th><th class="right">Marj</th></tr></thead><tbody>
            ${r.products.slice(0, 100).map(p => `<tr>
              <td>${esc(p.name)}${p.costed ? '' : ' <span class="badge badge--gray">maliyet yok</span>'}</td>
              <td class="muted">${esc(p.category)}</td>
              <td class="right mono">${p.qty}</td>
              <td class="right mono">${fmoney(p.revenue_net)}</td>
              <td class="right mono">${fmoney(p.cogs)}</td>
              <td class="right mono ${p.profit < 0 ? 'is-loss' : ''}">${fmoney(p.profit)}</td>
              <td class="right mono">${fpct(p.margin)}</td></tr>`).join('')}
          </tbody></table>` : finEmpty('Bu dönemde satış yok.')}
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>İndirimler</h3><div class="spacer"></div>
          <span class="muted" style="font-size:12px">${r.discounts.count} adisyon · ${fmoney(r.discounts.total)}</span>
          ${exPair('discounts')}</div>
        <div class="card__body">
          ${r.discounts.rows.length ? `<table class="tbl"><thead><tr>
              <th>Tarih</th><th>Adisyon</th><th>Masa</th><th>Personel</th>
              <th class="right">Ara toplam</th><th class="right">İndirim</th>
              <th class="right">Oran</th><th class="right">Tutar</th></tr></thead><tbody>
            ${r.discounts.rows.slice(0, 60).map(d => `<tr data-order="${d.id}" style="cursor:pointer">
              <td class="mono">${esc(d.date)}</td>
              <td>#${d.adisyon_no || d.id}${d.bill_label ? ' · ' + esc(d.bill_label) : ''}</td>
              <td class="muted">${esc(d.table_name)}</td>
              <td class="muted">${esc(d.waiter_name)}</td>
              <td class="right mono">${fmoney(d.total)}</td>
              <td class="right mono">${fmoney(d.discount_total)}</td>
              <td class="right mono">${fpct(d.share)}</td>
              <td class="right mono">${fmoney(d.grand_total)}</td></tr>`).join('')}
          </tbody></table>
          ${r.discounts.by_waiter.length > 1 ? `<div style="margin-top:14px">
            <div class="muted" style="font-size:12px;margin-bottom:6px">Personel kırılımı</div>
            ${r.discounts.by_waiter.map(w => `<div class="pl-line"><span>${esc(w.waiter_name)}
              <span class="muted">· ${w.count} adisyon</span></span>
              <span class="mono">${fmoney(w.discount)}</span></div>`).join('')}</div>` : ''}`
            : finEmpty('Bu dönemde indirim yapılmamış.')}
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>İptaller ve silinenler</h3><div class="spacer"></div>
          ${exPair('cancellations')}</div>
        <div class="card__body">
          ${this.finCancelBlock(r.cancellations)}
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Günlük kırılım</h3><div class="spacer"></div>
          <span class="muted" style="font-size:12px">satıra tıklayın</span>
          ${exPair('daily')}</div>
        <div class="card__body">
          ${r.daily.length ? `<table class="tbl"><thead><tr>
              <th>Gün</th><th class="right">Adisyon</th><th class="right">Ciro</th>
              <th class="right">Maliyet</th><th class="right">Gider</th>
              <th class="right">Net kâr</th><th class="right">Marj</th></tr></thead><tbody>
            ${[...r.daily].reverse().map(d => `<tr data-day="${d.date}" style="cursor:pointer">
              <td class="mono">${d.date}</td>
              <td class="right mono">${d.orders}</td>
              <td class="right mono">${fmoney(d.revenue_gross)}</td>
              <td class="right mono">${fmoney(d.cogs)}</td>
              <td class="right mono">${fmoney(d.expenses)}</td>
              <td class="right mono ${d.net_profit < 0 ? 'is-loss' : ''}">${fmoney(d.net_profit)}</td>
              <td class="right mono">${fpct(d.net_margin)}</td></tr>`).join('')}
          </tbody></table>` : finEmpty('Bu aralıkta kapanmış adisyon yok.')}
        </div>
      </div>`;

    $$('#main [data-ex]').forEach(b => b.onclick = (e) =>
      this.download(ex(b.dataset.ex, b.dataset.fmt || ''), e.currentTarget));
    $$('#main [data-day]').forEach(tr => tr.onclick = () => this.finDayDetail(tr.dataset.day));
    $$('#main [data-order]').forEach(tr => tr.onclick = () => this.finOrderModal(tr.dataset.order));
  },

  finCancelBlock(c) {
    const rows = [
      ...c.orders.map(o => ({ tip: o.status === 'cancelled' ? 'İptal adisyon' : 'Rapor dışı',
        tarih: o.date, ne: `#${o.adisyon_no || o.id} ${o.table_name || ''}`, tutar: o.grand_total, id: o.id })),
      ...c.items.map(i => ({ tip: 'İptal ürün', tarih: String(i.cancelled_at || '').slice(0, 10),
        ne: `${i.product_name} × ${i.qty}`, tutar: i.line_total, id: i.order_id })),
      ...c.deleted.map(b => ({ tip: 'Silinen adisyon', tarih: String(b.deleted_at || '').slice(0, 10),
        ne: `#${b.adisyon_no || b.order_id} ${b.reason || ''}`, tutar: b.grand_total, id: b.order_id })),
    ].sort((a, b) => String(b.tarih).localeCompare(String(a.tarih)));
    if (!rows.length) return finEmpty('Bu dönemde iptal veya silme yok.');
    const total = rows.reduce((s, x) => s + Number(x.tutar || 0), 0);
    return `<table class="tbl"><thead><tr><th>Tür</th><th>Tarih</th><th>Açıklama</th>
        <th class="right">Tutar</th></tr></thead><tbody>
      ${rows.slice(0, 80).map(x => `<tr data-order="${x.id}" style="cursor:pointer">
        <td><span class="badge badge--gray">${esc(x.tip)}</span></td>
        <td class="mono">${esc(x.tarih)}</td>
        <td>${esc(x.ne)}</td>
        <td class="right mono is-loss">${fmoney(x.tutar)}</td></tr>`).join('')}
      </tbody></table>
      <div class="pl-line pl-line--sub" style="margin-top:10px">
        <span>Toplam</span><span class="mono is-loss">${fmoney(total)}</span></div>`;
  },

  /* ===================================================================
     GÜN SONU - liste
     =================================================================== */
  async page_gunsonu(dateArg) {
    if (dateArg) return this.finDayDetail(dateArg);
    const from = this._daysFrom || FIN_AGO(29);
    const to = this._daysTo || FIN_TODAY();
    await this.finContext();
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Gün sonu</h2><div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="dyX">X raporu</button>
        <button class="btn btn--ghost btn--sm" id="dyCsv">CSV</button>
        <button class="btn btn--ghost btn--sm" id="dyXls">Excel</button>
        <button class="btn btn--ghost btn--sm" id="dyPdf">PDF</button>
        ${this._finCtx.can_close ? '<button class="btn btn--dark btn--sm" id="dyClose">Günü kapat</button>' : ''}
      </div>
      ${finToolbar('dy', from, to, `<label class="chip" style="cursor:pointer">
        <input type="checkbox" id="dyOnly" ${this._daysOnlyClosed ? 'checked' : ''}>
        Sadece kapatılan günler</label>`)}
      <div id="dyBody"><div class="empty">Yükleniyor…</div></div></div>`;

    const setRange = (f, t) => { this._daysFrom = f; this._daysTo = t; this.page_gunsonu(); };
    this.finBindPresets(setRange);
    $('#dyRun').onclick = () => setRange($('#dyFrom').value, $('#dyTo').value);
    $('#dyOnly').onchange = () => { this._daysOnlyClosed = $('#dyOnly').checked; this.page_gunsonu(); };
    const q = `from=${from}&to=${to}${this._daysOnlyClosed ? '&only_closed=1' : ''}`;
    $('#dyCsv').onclick = (e) => this.download(`/api/finance/export/days?${q}`, e.currentTarget);
    $('#dyXls').onclick = (e) => this.download(`/api/finance/export/days?${q}&format=xlsx`, e.currentTarget);
    $('#dyPdf').onclick = (e) => this.download(`/api/finance/export/days?${q}&format=pdf`, e.currentTarget);
    $('#dyX').onclick = () => this.finXReport();
    if ($('#dyClose')) $('#dyClose').onclick = () => this.finCloseDialog(FIN_TODAY());

    let r;
    try { r = await api('GET', `/api/finance/days?${q}`); }
    catch (e) { $('#dyBody').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; return; }
    const T = r.totals;

    $('#dyBody').innerHTML = `
      <div class="split-4">
        ${finStat('Toplam ciro', fmoney(T.net_sales), `${T.orders} adisyon`)}
        ${finStat('Toplam maliyet', fmoney(T.total_cost), `ürün ${fmoney(T.cogs)} · gider ${fmoney(T.expenses)}`)}
        ${finStat('Toplam kâr', fmoney(T.profit), 'marj ' + fpct(T.margin), T.profit < 0 ? 'is-loss' : 'is-profit')}
        ${finStat('Tahsilat', fmoney(T.cash + T.card + T.other), `nakit ${fmoney(T.cash)} · kart ${fmoney(T.card)}`)}
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Günler</h3><div class="spacer"></div>
          <span class="muted" style="font-size:12px">satıra tıklayın</span></div>
        <div class="card__body">
        ${r.rows.length ? `<table class="tbl"><thead><tr>
            <th>Tarih</th><th>Durum</th><th class="right">Adisyon</th><th class="right">Ciro</th>
            <th class="right">İndirim</th><th class="right">KDV</th><th class="right">Maliyet</th>
            <th class="right">Kâr</th><th class="right">Marj</th>
            <th class="right">Nakit</th><th class="right">Kart</th></tr></thead><tbody>
          ${r.rows.map(d => `<tr data-day="${d.date}" style="cursor:pointer">
            <td class="mono">${d.date}<div class="muted" style="font-size:12px">${esc(d.weekday)}</div></td>
            <td>${this.finDayBadge(d)}</td>
            <td class="right mono">${d.orders}</td>
            <td class="right mono">${fmoney(d.net_sales)}
              ${d.stored && Math.abs(d.stored.sales - d.net_sales) >= 0.01
                ? `<div class="muted" style="font-size:11.5px">kapanış ${fmoney(d.stored.sales)}</div>` : ''}</td>
            <td class="right mono">${fmoney(d.discounts)}</td>
            <td class="right mono">${fmoney(d.vat)}</td>
            <td class="right mono">${fmoney(d.total_cost)}</td>
            <td class="right mono ${d.profit < 0 ? 'is-loss' : ''}">${fmoney(d.profit)}</td>
            <td class="right mono">${fpct(d.margin)}</td>
            <td class="right mono">${fmoney(d.cash)}</td>
            <td class="right mono">${fmoney(d.card + d.other)}</td></tr>`).join('')}
        </tbody><tfoot><tr>
          <td colspan="2"><b>TOPLAM</b></td>
          <td class="right mono"><b>${T.orders}</b></td>
          <td class="right mono"><b>${fmoney(T.net_sales)}</b></td>
          <td class="right mono">${fmoney(T.discounts)}</td>
          <td class="right mono">${fmoney(T.vat)}</td>
          <td class="right mono">${fmoney(T.total_cost)}</td>
          <td class="right mono ${T.profit < 0 ? 'is-loss' : ''}"><b>${fmoney(T.profit)}</b></td>
          <td class="right mono">${fpct(T.margin)}</td>
          <td class="right mono">${fmoney(T.cash)}</td>
          <td class="right mono">${fmoney(T.card + T.other)}</td>
        </tr></tfoot></table>` : finEmpty('Bu aralıkta gün yok.')}
        </div>
      </div>`;
    $$('#main [data-day]').forEach(tr => tr.onclick = () => this.finDayDetail(tr.dataset.day));
  },

  finDayBadge(d) {
    if (d.is_closed) {
      return `<span class="badge badge--closed">Kapatıldı</span>`
        + (d.closed_by ? `<div class="muted" style="font-size:11.5px">${esc(d.closed_by)}</div>` : '');
    }
    if (d.is_reopened) return '<span class="badge badge--open">Yeniden açıldı</span>';
    return '<span class="badge badge--gray">Açık</span>';
  },

  /* ===================================================================
     GÜN SONU - detay
     =================================================================== */
  async finDayDetail(date) {
    await this.finContext();
    $('#main').innerHTML = `<div class="page is-on" id="ddPage">
      <div class="row" style="margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <button class="btn btn--ghost btn--sm" id="ddBack">← Listeye dön</button>
        <h2 class="page-title" style="margin:0">${esc(date)}</h2>
        <span id="ddPill"></span>
        <div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="ddPrev">Önceki gün</button>
        <button class="btn btn--ghost btn--sm" id="ddNext">Sonraki gün</button>
        <button class="btn btn--ghost btn--sm" id="ddMail">E-posta</button>
        <button class="btn btn--ghost btn--sm" id="ddCsv">CSV</button>
        <button class="btn btn--ghost btn--sm" id="ddPdf">PDF</button>
        <button class="btn btn--ghost btn--sm" id="ddPrint">Yazdır</button>
        <span id="ddAct"></span>
      </div>
      <div id="ddBody"><div class="empty">Yükleniyor…</div></div></div>`;

    $('#ddBack').onclick = () => this.page_gunsonu();
    $('#ddPrint').onclick = () => window.print();
    $('#ddCsv').onclick = (e) => this.download(`/api/finance/export/day?date=${date}`, e.currentTarget);
    $('#ddPdf').onclick = (e) => this.download(`/api/finance/export/day?date=${date}&format=pdf`, e.currentTarget);
    $('#ddMail').onclick = () => this.finMailDialog(date);

    let r;
    try { r = await api('GET', `/api/finance/days/${date}`); }
    catch (e) { $('#ddBody').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; return; }
    const s = r.summary;
    $('#ddPrev').onclick = () => this.finDayDetail(r.prev);
    $('#ddNext').onclick = () => this.finDayDetail(r.next);
    $('#ddPill').innerHTML = this.finDayBadge(s)
      + (s.closed_at ? ` <span class="muted" style="font-size:12px">${esc(String(s.closed_at).slice(0, 16))}</span>` : '');
    $('#ddAct').innerHTML = s.is_closed
      ? (this._finCtx.is_owner ? '<button class="btn btn--danger btn--sm" id="ddReopen">Günü yeniden aç</button>' : '')
      : (this._finCtx.can_close ? '<button class="btn btn--dark btn--sm" id="ddClose">Günü kapat</button>' : '');
    if ($('#ddClose')) $('#ddClose').onclick = () => this.finCloseDialog(date);
    if ($('#ddReopen')) $('#ddReopen').onclick = () => this.finReopen(date);

    $('#ddBody').innerHTML = `
      <div class="split-4">
        ${finStat('Ciro', fmoney(s.net_sales), `brüt ${fmoney(s.gross_sales)} · indirim ${fmoney(s.discounts)}`)}
        ${finStat('Toplam maliyet', fmoney(s.total_cost), `ürün ${fmoney(s.cogs)} · gider ${fmoney(s.expenses)}`)}
        ${finStat('Kâr', fmoney(s.profit), 'marj ' + fpct(s.margin), s.profit < 0 ? 'is-loss' : 'is-profit')}
        ${finStat('Adisyon', String(s.orders), `iptal / hariç ${fmoney(s.cancelled)}`)}
      </div>
      <div class="split-4" style="margin-top:14px">
        ${finStat('Nakit', fmoney(s.cash), '')}
        ${finStat('Kart', fmoney(s.card), '')}
        ${finStat('Diğer', fmoney(s.other), 'yemek kartı, havale…')}
        ${finStat('KDV', fmoney(s.vat), `ort. adisyon ${fmoney(s.average_ticket)}`)}
      </div>

      ${s.stored ? `<div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Kapanışta kaydedilen rakamlar</h3><div class="spacer"></div>
          <span class="muted" style="font-size:12px">${s.close_seq}. kapanış</span></div>
        <div class="card__body">
          <p class="muted" style="margin-top:0;font-size:13px">Bu rakamlar gün kapatılırken yazıldı.
            Yandaki canlı rakamla farklıysa, kapanıştan sonra bir adisyon değişmiş demektir.</p>
          <table class="tbl"><thead><tr><th>Kalem</th><th class="right">Kapanışta</th>
            <th class="right">Şu an</th><th class="right">Fark</th></tr></thead><tbody>
            ${[['Ciro', s.stored.sales, s.net_sales], ['Adisyon', s.stored.orders, s.orders],
               ['Maliyet', s.stored.cost, s.total_cost], ['Kâr', s.stored.net, s.profit],
               ['Nakit', s.stored.cash, s.cash], ['Kart / diğer', s.stored.card, s.card + s.other]]
              .map(([k, a, b]) => `<tr><td>${k}</td>
                <td class="right mono">${k === 'Adisyon' ? a : fmoney(a)}</td>
                <td class="right mono">${k === 'Adisyon' ? b : fmoney(b)}</td>
                <td class="right mono ${Math.abs(b - a) >= 0.01 ? 'is-loss' : 'muted'}">${
                  k === 'Adisyon' ? (b - a) : fmoney(b - a)}</td></tr>`).join('')}
            ${s.stored.declared_cash || s.stored.declared_card ? `
              <tr><td>Sayılan nakit</td><td class="right mono">${fmoney(s.stored.declared_cash)}</td>
                <td class="right mono">${fmoney(s.stored.cash)}</td>
                <td class="right mono ${Math.abs(s.stored.cash_difference) >= 0.01 ? 'is-loss' : 'muted'}">${
                  fmoney(s.stored.cash_difference)}</td></tr>
              <tr><td>Sayılan kart</td><td class="right mono">${fmoney(s.stored.declared_card)}</td>
                <td class="right mono">${fmoney(s.stored.card)}</td>
                <td class="right mono ${Math.abs(s.stored.card_difference) >= 0.01 ? 'is-loss' : 'muted'}">${
                  fmoney(s.stored.card_difference)}</td></tr>` : ''}
          </tbody></table>
        </div></div>` : ''}

      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Adisyonlar</h3><div class="spacer"></div>
          <span class="muted" style="font-size:12px">${r.orders.length} adisyon · satıra tıklayın</span></div>
        <div class="card__body">
        ${r.orders.length ? `<table class="tbl"><thead><tr>
            <th>Adisyon</th><th>Masa</th><th>Personel</th><th>Kapanış</th>
            <th class="right">Tutar</th><th class="right">İndirim</th>
            <th class="right">Ödenen</th><th>Durum</th></tr></thead><tbody>
          ${r.orders.map(o => `<tr data-order="${o.id}" style="cursor:pointer${
              (o.excluded || o.status === 'cancelled') ? ';opacity:.55' : ''}">
            <td>#${o.adisyon_no || o.id}${o.bill_label ? ' · ' + esc(o.bill_label) : ''}</td>
            <td class="muted">${esc(o.table_name || '')}</td>
            <td class="muted">${esc(o.waiter_name || '')}</td>
            <td class="mono">${String(o.closed_at || '').slice(11, 16)}</td>
            <td class="right mono">${fmoney(o.grand_total)}</td>
            <td class="right mono">${fmoney(o.discount_total)}</td>
            <td class="right mono">${fmoney(o.paid)}</td>
            <td>${(o.excluded || o.status === 'cancelled')
              ? '<span class="badge badge--gray">Hariç / İptal</span>'
              : '<span class="badge badge--closed">Geçerli</span>'}</td></tr>`).join('')}
        </tbody></table>` : finEmpty('Bu gün adisyon kapanmamış.')}
        </div>
      </div>

      <div class="split-2" style="margin-top:14px;align-items:start">
        <div class="card">
          <div class="card__head"><h3>Ürün kırılımı</h3></div>
          <div class="card__body">
          ${r.products.length ? `<table class="tbl"><thead><tr><th>Ürün</th>
              <th class="right">Adet</th><th class="right">Ciro</th>
              <th class="right">Maliyet</th><th class="right">Kâr</th></tr></thead><tbody>
            ${r.products.map(p => `<tr><td>${esc(p.name)}</td>
              <td class="right mono">${p.qty}</td>
              <td class="right mono">${fmoney(p.revenue_net)}</td>
              <td class="right mono">${fmoney(p.cogs)}</td>
              <td class="right mono ${p.profit < 0 ? 'is-loss' : ''}">${fmoney(p.profit)}</td></tr>`).join('')}
          </tbody></table>` : finEmpty('Satış yok.')}
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>Garson performansı</h3></div>
          <div class="card__body">
          ${r.waiters.length ? `<table class="tbl"><thead><tr><th>Garson</th>
              <th class="right">Adisyon</th><th class="right">Ciro</th>
              <th class="right">Ortalama</th></tr></thead><tbody>
            ${r.waiters.map(w => `<tr><td>${esc(w.display_name || '-')}</td>
              <td class="right mono">${w.orders}</td>
              <td class="right mono">${fmoney(w.total)}</td>
              <td class="right mono">${fmoney(w.avg_ticket)}</td></tr>`).join('')}
          </tbody></table>` : finEmpty('Kayıt yok.')}
          </div>
        </div>
      </div>

      <div class="split-2" style="margin-top:14px;align-items:start">
        <div class="card">
          <div class="card__head"><h3>Gün giderleri</h3></div>
          <div class="card__body">
          ${r.costs.length ? `<table class="tbl"><thead><tr><th>Kategori</th><th>Açıklama</th>
              <th class="right">Tutar</th></tr></thead><tbody>
            ${r.costs.map(c => `<tr><td>${esc(c.category)}</td>
              <td class="muted">${esc(c.description || '')}</td>
              <td class="right mono">${fmoney(c.amount)}</td></tr>`).join('')}
          </tbody><tfoot><tr><td colspan="2"><b>TOPLAM</b></td>
            <td class="right mono"><b>${fmoney(r.costs_total)}</b></td></tr></tfoot></table>`
            : finEmpty('Bu güne gider girilmemiş.')}
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>İptal edilen ürünler</h3></div>
          <div class="card__body">
          ${r.cancels.length ? `<table class="tbl"><thead><tr><th>Saat</th><th>Ürün</th>
              <th class="right">Adet</th><th class="right">Tutar</th></tr></thead><tbody>
            ${r.cancels.map(c => `<tr><td class="mono">${String(c.cancelled_at || '').slice(11, 16)}</td>
              <td>${esc(c.product_name)}</td>
              <td class="right mono">${c.qty}</td>
              <td class="right mono is-loss">${fmoney(c.line_total)}</td></tr>`).join('')}
          </tbody></table>` : finEmpty('İptal edilen ürün yok.')}
          </div>
        </div>
      </div>`;

    $$('#main [data-order]').forEach(tr => tr.onclick = () => this.finOrderModal(tr.dataset.order));
  },

  /** Close the day, with the blind cash count the old system never had a screen for. */
  finCloseDialog(date) {
    modal(`
      <div class="modal__head"><h3>Gün sonu — ${esc(date)}</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="alert alert--info">Gün kapatıldıktan sonra o ana kadar kapanmış adisyonlar
          silinemez veya geri alınamaz. Düzeltmek için günü yeniden açmanız gerekir.</div>
        <p class="muted" style="margin-top:0;font-size:13px">Kasadaki parayı sayıp yazın; sistem
          beklenen tutarla farkı kapanış kaydına işler.</p>
        <div class="split-2">
          <div class="field"><label>Sayılan nakit</label>
            <input class="input" id="cdCash" type="number" step="0.01" value="0"></div>
          <div class="field"><label>Kart toplamı (POS ekstresi)</label>
            <input class="input" id="cdCard" type="number" step="0.01" value="0"></div>
        </div>
        <div class="field"><label>Not (isteğe bağlı)</label><input class="input" id="cdNote"></div>
        <div id="cdAlert"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--dark" id="cdOk">Günü kapat</button></div>`);
    $('#cdOk').onclick = async () => {
      try {
        const r = await api('POST', `/api/finance/days/${date}/close`, {
          declared_cash: Number($('#cdCash').value) || 0,
          declared_card: Number($('#cdCard').value) || 0,
          reason: $('#cdNote').value, print: true,
        });
        closeModal();
        const c = r.closing;
        toast(`Gün kapatıldı. Kasa farkı ${tl(c.cash_difference)} ₺`, 'ok');
        this.finDayDetail(date);
      } catch (e) { $('#cdAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  async finReopen(date) {
    const yes = await confirmBox('Günü yeniden aç',
      `${date} günü yeniden açılacak. Bu güne kadar kilitlenmiş adisyonlar tekrar `
      + 'silinebilir hale gelir ve işlem denetim kaydına yazılır. Devam edilsin mi?', true);
    if (!yes) return;
    try {
      await api('POST', `/api/finance/days/${date}/reopen`, {});
      toast('Gün yeniden açıldı', 'ok');
      this.finDayDetail(date);
    } catch (e) { err(e); }
  },

  finMailDialog(date) {
    modal(`
      <div class="modal__head"><h3>Gün sonu özetini gönder</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">${esc(date)} gününün özeti e-posta olarak gönderilir.</p>
        <div class="field"><label>Alıcı e-posta</label><input class="input" id="dmTo" type="email"></div>
        <div id="dmAlert"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="dmOk">Gönder</button></div>`);
    $('#dmOk').onclick = async () => {
      try {
        await api('POST', `/api/finance/days/${date}/mail`, { to: $('#dmTo').value });
        closeModal(); toast('Özet gönderim kuyruğuna alındı', 'ok');
      } catch (e) { $('#dmAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /** X raporu: the same figures as the Z, mid-shift, and nothing is closed. */
  async finXReport() {
    modal(`<div class="modal__head"><h3>X raporu</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body" id="xrBody"><div class="empty">Hesaplanıyor…</div></div>
      <div class="modal__foot"><button class="btn btn--ghost" data-close="1">Kapat</button>
        <button class="btn btn--primary" id="xrPrint">Yazdır</button></div>`, { wide: true });
    let x;
    try { x = (await api('GET', '/api/finance/x-report')).report; }
    catch (e) { $('#xrBody').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; return; }
    $('#xrPrint').onclick = async () => {
      try { await api('POST', '/api/finance/x-report/print', { date: x.date }); toast('X raporu yazdırıldı', 'ok'); }
      catch (e) { err(e); }
    };
    $('#xrBody').innerHTML = `
      <p class="muted" style="margin-top:0">${esc(x.date)} · ${esc(x.taken_at)} ·
        gün ${x.day_closed ? 'kapatılmış' : 'henüz kapatılmamış'}</p>
      <div class="split-2">
        <table class="tbl">
          <tr><td>Adisyon</td><td class="right mono">${x.orders}</td></tr>
          <tr><td>Brüt satış</td><td class="right mono">${fmoney(x.gross)}</td></tr>
          <tr><td>İndirim</td><td class="right mono">-${tl(x.discount)} ₺</td></tr>
          <tr><td><b>Net satış</b></td><td class="right mono"><b>${fmoney(x.net)}</b></td></tr>
          <tr><td>KDV</td><td class="right mono">${fmoney(x.vat_total)}</td></tr>
          <tr><td>Maliyet</td><td class="right mono">${fmoney(x.cost_of_goods)}</td></tr>
          <tr><td>Gider</td><td class="right mono">${fmoney(x.extra_costs)}</td></tr>
          <tr><td><b>Kâr</b></td><td class="right mono"><b>${fmoney(x.profit)}</b> (${fpct(x.margin)})</td></tr>
        </table>
        <table class="tbl">
          <tr><th colspan="2">Ödemeler</th></tr>
          ${x.payments.map(p => `<tr><td>${esc(label(p.method))} (${p.count})</td>
            <td class="right mono">${fmoney(p.total)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">—</td></tr>'}
          <tr><th colspan="2">Masadaki açık adisyonlar</th></tr>
          ${x.open_bills.length ? x.open_bills.map(b => `<tr>
            <td>${esc(b.table_name || '#' + (b.adisyon_no || b.id))}
              ${b.bill_label ? '<span class="badge badge--gray">' + esc(b.bill_label) + '</span>' : ''}</td>
            <td class="right mono">${fmoney(b.grand_total)}</td></tr>`).join('')
            : '<tr><td colspan="2" class="muted">Açık adisyon yok.</td></tr>'}
          <tr><td><b>Masada toplam</b></td><td class="right mono"><b>${fmoney(x.open_total)}</b></td></tr>
        </table>
      </div>`;
  },

  /* ===================================================================
     İŞLEMLER - kapalı adisyonlar
     =================================================================== */
  async page_islemler() {
    const from = this._txFrom || FIN_TODAY();
    const to = this._txTo || FIN_TODAY();
    const ctx = await this.finContext();
    /*
     * Three chips, not four. "Iptal" (a bill voided before it closed) and
     * "Silindi" (a closed bill taken off the books afterwards) are the same
     * fact to a restaurant - that sale did not happen - and splitting them
     * meant a removed bill could be in the list you were not looking at.
     */
    const CHIPS = [['all', 'Tümü'], ['paid', 'Geçerli'], ['deleted', 'İptal edilenler']];

    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">İşlemler</h2><div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="txCsv">CSV</button>
        <button class="btn btn--ghost btn--sm" id="txXls">Excel</button>
        <button class="btn btn--ghost btn--sm" id="txPdf">PDF</button>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px">
        ${CHIPS.map(([k, l]) => `<button class="zone-tab${this._txStatus === k ? ' is-active' : ''}"
          data-st="${k}">${l}</button>`).join('')}
        <div class="spacer"></div>
        <input class="input" id="txQ" placeholder="Adisyon no, masa, tutar…"
          value="${esc(this._txQ)}" style="width:210px;height:36px">
        <input class="input" id="txFrom" type="date" value="${from}" style="width:150px;height:36px">
        <input class="input" id="txTo" type="date" value="${to}" style="width:150px;height:36px">
        <button class="btn btn--primary btn--sm" id="txRun">Yükle</button>
      </div>
      ${ctx.is_owner ? `<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px" id="txOwner">
        <button class="btn btn--ghost btn--sm" id="txDelSel" disabled>Seçilenleri iptal et (0)</button>
        <button class="btn btn--danger btn--sm" id="txPurgeSel" disabled>Seçilenleri kalıcı sil (0)</button>
        <button class="btn btn--ghost btn--sm" id="txDelCash">Aralıktaki nakitleri iptal et</button>
        <button class="btn btn--ghost btn--sm" id="txDelCard">Aralıktaki kartları iptal et</button>
        <span class="muted" style="font-size:12px;align-self:center;max-width:520px">
          <b>İptal</b> adisyonu raporlardan ve tahsilattan çıkarır; kaydı durur, geri alınabilir.
          <b>Kalıcı sil</b> adisyonu sistemden tamamen kaldırır — geri alınamaz.
          Kapanmış güne ait adisyon hiçbir şekilde silinemez.</span>
      </div>` : `<div class="alert alert--info">Adisyon iptali ve geri alma yalnızca işletme sahibi
        hesabıyla yapılabilir. Yetkiniz varsa Ayarlar → Kullanıcılar'dan rolünüzü
        "İşletme sahibi" yapabilirsiniz.</div>`}
      <div id="txBody"><div class="empty">Yükleniyor…</div></div></div>`;

    const reload = () => {
      this._txFrom = $('#txFrom').value; this._txTo = $('#txTo').value;
      this._txQ = $('#txQ').value; this.page_islemler();
    };
    $('#txRun').onclick = reload;
    $('#txQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') reload(); });
    $$('#main [data-st]').forEach(b => b.onclick = () => { this._txStatus = b.dataset.st; this.page_islemler(); });
    const q = `from=${from}&to=${to}&status=${this._txStatus}&q=${encodeURIComponent(this._txQ)}`;
    $('#txCsv').onclick = (e) => this.download(`/api/finance/export/transactions?${q}`, e.currentTarget);
    $('#txXls').onclick = (e) =>
      this.download(`/api/finance/export/transactions?${q}&format=xlsx`, e.currentTarget);
    $('#txPdf').onclick = (e) =>
      this.download(`/api/finance/export/transactions?${q}&format=pdf`, e.currentTarget);

    let r;
    try { r = await api('GET', `/api/finance/transactions?${q}`); }
    catch (e) { $('#txBody').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; return; }

    $('#txBody').innerHTML = `
      <div class="split-4" style="margin-bottom:14px">
        ${finStat('Adisyon', String(r.totals.count), `geçerli ${fmoney(r.totals.counted)}`)}
        ${finStat('Tahsilat', fmoney(r.totals.paid), `indirim ${fmoney(r.totals.discount_total)}`)}
        ${finStat('İptal edilen', fmoney(r.totals.deleted),
           (r.totals.deleted_count || 0) + ' adisyon · tahsilata girmez',
           r.totals.deleted > 0 ? 'is-loss' : '')}
        ${finStat('Kilitli', String(r.totals.locked), r.checkpoint
          ? 'son kapanış ' + esc(String(r.checkpoint).slice(0, 16)) : 'kapanış yok')}
      </div>
      <div class="card"><div class="card__body">
      ${r.rows.length ? `<table class="tbl"><thead><tr>
          ${ctx.is_owner ? '<th style="width:34px"><input type="checkbox" id="txAll"></th>' : ''}
          <th>Kapanış</th><th>Adisyon</th><th>Masa</th><th>Personel</th><th>Ödeme</th>
          <th class="right">Tutar</th><th class="right">Tahsilat</th><th>Durum</th>
          <th class="right">İşlem</th></tr></thead><tbody>
        ${r.rows.map(o => `<tr style="${o.excluded ? 'opacity:.5' : (o.cancelled ? 'opacity:.72' : '')}">
          ${ctx.is_owner ? `<td>${o.locked ? ''
            : `<input type="checkbox" class="txSel" value="${o.id}"
                 data-excluded="${o.excluded || o.cancelled ? 1 : 0}">`}</td>` : ''}
          <td class="mono">${String(o.closed_at || '').slice(0, 16)}</td>
          <td>#${o.adisyon_no || o.id}${o.bill_label ? ' · ' + esc(o.bill_label) : ''}</td>
          <td class="muted">${esc(o.table_name)}</td>
          <td class="muted">${esc(o.waiter_name)}</td>
          <td>${this.finPayBadge(o)}</td>
          <td class="right mono">${fmoney(o.grand_total)}</td>
          <td class="right mono">${fmoney(o.paid)}</td>
          <td>${o.cancelled || o.excluded ? '<span class="badge badge--gray">İptal edildi</span> ' : ''}
              ${!o.cancelled && !o.excluded ? '<span class="badge badge--closed">Geçerli</span>' : ''}
              ${o.locked ? '<span class="badge badge--gray" title="Kapanmış güne ait">Kilitli</span>' : ''}</td>
          <td class="right">
            <button class="btn btn--ghost btn--sm" data-detail="${o.id}">Detay</button>
            ${ctx.is_owner && !o.locked ? (o.excluded || o.cancelled
              ? `<button class="btn btn--ghost btn--sm" data-restore="${o.id}">Geri al</button>`
              : `<button class="btn btn--ghost btn--sm" data-del="${o.id}">İptal et</button>`) : ''}
            ${ctx.is_owner && !o.locked
              ? `<button class="btn btn--danger btn--sm" data-purge="${o.id}">Kalıcı sil</button>` : ''}
          </td></tr>`).join('')}
      </tbody></table>` : finEmpty('Bu aralıkta kapanmış adisyon yok.')}
      </div></div>`;

    this._txRows = r.rows;
    $$('#main [data-detail]').forEach(b => b.onclick = () => this.finOrderModal(b.dataset.detail));
    $$('#main [data-del]').forEach(b => b.onclick = () => this.finDelete(b.dataset.del));
    $$('#main [data-purge]').forEach(b => b.onclick = () => this.finPurge([Number(b.dataset.purge)]));
    $$('#main [data-restore]').forEach(b => b.onclick = () => this.finRestore(b.dataset.restore));

    if (ctx.is_owner) {
      const sel = () => $$('.txSel').filter(c => c.checked).map(c => Number(c.value));
      const sync = () => {
        const n = sel().length;
        /* Only a bill still ON the books can be cancelled; any selected bill
           can be purged, including one that was cancelled earlier. */
        const cancellable = $$('.txSel').filter(c => c.checked && c.dataset.excluded !== '1').length;
        $('#txDelSel').textContent = `Seçilenleri iptal et (${cancellable})`;
        $('#txDelSel').disabled = cancellable === 0;
        $('#txPurgeSel').textContent = `Seçilenleri kalıcı sil (${n})`;
        $('#txPurgeSel').disabled = n === 0;
      };
      $$('.txSel').forEach(c => c.onchange = sync);
      if ($('#txAll')) $('#txAll').onchange = (e) => {
        $$('.txSel').forEach(c => { c.checked = e.target.checked; });
        sync();
      };
      $('#txDelSel').onclick = () => this.finDeleteSelected(
        $$('.txSel').filter(c => c.checked && c.dataset.excluded !== '1').map(c => Number(c.value)));
      $('#txPurgeSel').onclick = () => this.finPurge(sel());
      $('#txDelCash').onclick = () => this.finBulk('nakit', 'nakit', from, to);
      $('#txDelCard').onclick = () => this.finBulk('kredi_karti', 'kredi kartı', from, to);
      sync();
    }
  },

  finPayBadge(o) {
    if (o.method_count > 1) return '<span class="badge badge--gray">KARIŞIK</span>';
    if (o.method_count === 1) return `<span class="badge badge--gray">${esc(label(o.methods[0]).toUpperCase())}</span>`;
    return '<span class="muted">—</span>';
  },

  async finDelete(id) {
    const yes = await confirmBox('Adisyonu iptal et',
      'Adisyon bütün raporlardan ve tahsilattan çıkar; ödemeleri iptal edilmiş sayılır. '
      + 'Kaydı ve kim iptal etti bilgisi durur, gerekirse geri alabilirsiniz.', true);
    if (!yes) return;
    try {
      await api('POST', `/api/finance/transactions/${id}/delete`, {});
      toast('Adisyon iptal edildi', 'ok');
      this.page_islemler();
    } catch (e) { err(e); }
  },

  /**
   * Kalici silme. Irreversible, so it asks twice and asks for the word.
   *
   * A confirm box is the thing people press without reading; typing the word
   * is the smallest gesture that cannot be made by reflex. The dialog names
   * the count AND the money, because "3 adisyon" and "3 adisyon, 41.250 TL"
   * are not the same sentence to somebody about to remove them for good.
   */
  async finPurge(ids) {
    if (!ids || !ids.length) return;
    const rows = (this._txRows || []).filter(r => ids.includes(r.id));
    const money = rows.reduce((s, r) => s + Number(r.grand_total || 0), 0);
    const frozen = rows.filter(r => r.locked).length;

    modal(`
      <div class="modal__head"><h3>Kalıcı sil</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="alert alert--error" style="margin-bottom:14px">
          <b>${ids.length} adisyon${money ? ' · ' + fmoney(money) : ''}</b> sistemden
          tamamen kaldırılacak. Satırları, ödemeleri ve indirimleri silinecek.
          <b>Bu işlem geri alınamaz.</b>
        </div>
        ${frozen ? `<div class="alert alert--warn" style="margin-bottom:14px">
          Seçilenlerin ${frozen} tanesi kapanmış güne ait ve silinmeyecek.
          Önce o günü yeniden açmanız gerekir.</div>` : ''}
        <p class="muted" style="margin:0 0 14px;font-size:12.5px">
          Adisyonun ne olduğu, kimin, ne zaman ve neden sildiği
          <b>işlem günlüğünde</b> kalır — silinen bir satışın hiç iz bırakmaması
          muhasebe açısından kabul edilemez.</p>
        <div class="field"><label>Silme sebebi (zorunlu)</label>
          <input class="input" id="pgWhy" placeholder="Test adisyonu, yanlış giriş…"></div>
        <div class="field" style="margin-bottom:0"><label>Onaylamak için <b>SİL</b> yazın</label>
          <input class="input mono" id="pgWord" autocomplete="off" placeholder="SİL"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--danger" id="pgOk" disabled>Kalıcı sil</button></div>`);

    /* Accept both spellings: a Turkish keyboard gives SİL, an English one SIL,
       and refusing the second would be a puzzle, not a safeguard. */
    const check = () => {
      const word = String($('#pgWord').value || '').trim().toLocaleUpperCase('tr');
      $('#pgOk').disabled = !(word === 'SİL' || word === 'SIL') || !$('#pgWhy').value.trim();
    };
    $('#pgWord').oninput = check;
    $('#pgWhy').oninput = check;

    $('#pgOk').onclick = async () => {
      $('#pgOk').disabled = true;
      try {
        const r = await api('POST', '/api/finance/transactions/purge',
          { ids, reason: $('#pgWhy').value });
        closeModal();
        let msg = `${r.purged} adisyon kalıcı silindi`;
        if (r.locked) msg += `, ${r.locked} tanesi kapalı güne ait olduğu için atlandı`;
        toast(msg, r.locked ? '' : 'ok');
        this.page_islemler();
      } catch (e) { err(e); $('#pgOk').disabled = false; }
    };
  },

  async finRestore(id) {
    try {
      await api('POST', `/api/finance/transactions/${id}/restore`, {});
      toast('Adisyon raporlara geri alındı', 'ok');
      this.page_islemler();
    } catch (e) { err(e); }
  },

  async finDeleteSelected(ids) {
    if (!ids.length) return;
    const yes = await confirmBox('Seçilenleri iptal et',
      `${ids.length} adisyon iptal edilecek ve raporlardan çıkacak. Kapanmış güne ait olanlar atlanır.`, true);
    if (!yes) return;
    try {
      const r = await api('POST', '/api/finance/transactions/delete', { ids });
      let msg = `${r.deleted} adisyon iptal edildi`;
      if (r.locked) msg += `, ${r.locked} tanesi kapalı güne ait olduğu için atlandı`;
      toast(msg, r.locked ? '' : 'ok');
      this.page_islemler();
    } catch (e) { err(e); }
  },

  async finBulk(method, human, from, to) {
    const yes = await confirmBox('Toplu iptal',
      `${from} – ${to} aralığındaki bütün ${human} adisyonları iptal edilecek ve raporlardan çıkacak. `
      + 'Aralıkta kapanmış güne ait adisyon varsa işlem hiç yapılmaz.', true);
    if (!yes) return;
    try {
      const r = await api('POST', '/api/finance/transactions/bulk-delete', { method, from, to });
      toast(`${r.deleted} adisyon iptal edildi`, 'ok');
      this.page_islemler();
    } catch (e) { err(e); }
  },

  /* ------------------------------------------------------ bill modal */
  /**
   * The bill detail. The PHP version read a column nothing writes and rebuilt
   * the line total from it, so every line showed 0,00 - these are the till's own
   * unit_price / line_total, which is why the lines add up to the bill.
   */
  async finOrderModal(id) {
    modal(`<div class="modal__head"><h3>Adisyon detayı</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body" id="odBody"><div class="empty">Yükleniyor…</div></div>`, { wide: true });
    let r;
    try { r = await api('GET', `/api/finance/transactions/${id}`); }
    catch (e) { $('#odBody').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; return; }
    const o = r.order, T = r.totals;
    $('#odBody').innerHTML = `
      <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <span class="strong">#${o.adisyon_no || o.id}</span>
        ${o.bill_label ? `<span class="badge badge--gray">${esc(o.bill_label)}</span>` : ''}
        ${o.table_name ? `<span class="chip">${esc(o.table_name)}</span>` : ''}
        ${o.waiter_name ? `<span class="chip">${esc(o.waiter_name)}</span>` : ''}
        <div class="spacer"></div>
        ${o.excluded ? '<span class="badge badge--open">Silindi</span>' : ''}
        ${o.status === 'cancelled' ? '<span class="badge badge--gray">İptal</span>' : ''}
        ${o.locked ? '<span class="badge badge--gray">Kilitli</span>' : ''}
      </div>
      <div class="muted" style="font-size:12.5px;margin-bottom:10px">
        Açılış ${esc(String(o.opened_at || '').slice(0, 16))} ·
        Kapanış ${esc(String(o.closed_at || '').slice(0, 16))}</div>
      ${r.items.length ? `<table class="tbl"><thead><tr><th>Ürün</th><th class="right">Adet</th>
          <th class="right">Birim</th><th class="right">İndirim</th><th class="right">Tutar</th>
        </tr></thead><tbody>
        ${r.items.map(i => `<tr><td>${esc(i.product_name)}
            ${i.note ? `<div class="muted" style="font-size:12px">${esc(i.note)}</div>` : ''}</td>
          <td class="right mono">${i.qty}</td>
          <td class="right mono">${fmoney(i.unit_price)}</td>
          <td class="right mono">${i.discount_amount ? '-' + tl(i.discount_amount) + ' ₺' : '—'}</td>
          <td class="right mono">${fmoney(i.line_total)}</td></tr>`).join('')}
      </tbody></table>` : finEmpty('Adisyonda ürün yok.')}
      <div style="margin-top:14px">
        <div class="pl-line"><span>Ara toplam</span><span class="mono">${fmoney(T.subtotal)}</span></div>
        ${T.discount ? `<div class="pl-line"><span>İndirim</span>
          <span class="mono">-${tl(T.discount)} ₺</span></div>` : ''}
        <div class="pl-line pl-line--muted"><span>KDV (dahil)</span><span class="mono">${fmoney(T.vat)}</span></div>
        <div class="pl-line pl-line--sub"><span>Genel toplam</span><span class="mono">${fmoney(T.grand)}</span></div>
        ${Math.abs(T.balance) >= 0.01 ? `<div class="pl-line"><span>Kalan</span>
          <span class="mono is-loss">${fmoney(T.balance)}</span></div>` : ''}
      </div>
      <div style="margin-top:14px">
        <div class="muted" style="font-size:12px;margin-bottom:6px">Ödemeler</div>
        ${r.payments.length ? `<table class="tbl"><tbody>
          ${r.payments.map(p => `<tr><td>${esc(label(p.method))}
            ${p.is_deleted ? '<span class="badge badge--gray">silindi</span>' : ''}
            ${p.voided ? '<span class="badge badge--gray">iptal</span>' : ''}</td>
            <td class="muted mono">${esc(String(p.created_at || '').slice(0, 16))}</td>
            <td class="right mono${p.is_deleted || p.voided ? ' muted' : ''}">${fmoney(p.amount)}</td></tr>`).join('')}
        </tbody></table>` : finEmpty('Ödeme kaydı yok.')}
      </div>`;
  },
});
