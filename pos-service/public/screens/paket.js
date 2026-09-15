/* =====================================================================
   NOKTApp POS - Paket Servis
   =====================================================================
   Four tabs, one job each:

     Siparişler   the board. Four lanes, one button per card, refreshing
                  itself - an order arriving on a screen nobody is touching
                  is the whole point.
     Kuryeler     who is out, what they are carrying, and how much of the
                  restaurant's cash is in their pocket. The settlement lives
                  here.
     Adresler     the address book, searchable, because "who was that in
                  Bahçelievler" is a question a cashier asks out loud.
     Paket raporu the day in numbers, split by where the order came from.

   PHONE ORDERS AND PLATFORM ORDERS SHARE THE BOARD, deliberately. Once an
   order is here it is worked the same way whatever door it came through -
   somebody cooks it, somebody carries it, somebody marks it delivered.
   Giving the platforms a screen of their own is how an order goes unnoticed
   at 20:30 on a Friday.

   Same visual language as the rest of the till: .card, .tbl, .btn, .chip.
   One accent, orange, and it means ONE thing on this screen - late. Lane
   headers are graphite so the two overdue cards are the only warm thing on
   a 15" display and can be seen from across the kitchen.
   ===================================================================== */
'use strict';

registerIcon('paket',
  '<path d="M3 8l9-5 9 5v8l-9 5-9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>');

registerPage({ id: 'paket', label: 'Siparişler', icon: 'paket', groupLabel: 'Paket Servis',
  perm: 'delivery.order' }, 'tables');
registerPage({ id: 'kurye', label: 'Kuryeler', icon: 'paket', perm: 'delivery.order',
  group: 'paket' }, 'paket');
registerPage({ id: 'adresler', label: 'Adresler', icon: 'paket', perm: 'delivery.order',
  group: 'paket' }, 'kurye');
registerPage({ id: 'platformlar', label: 'Platformlar', icon: 'paket', perm: 'delivery.order',
  group: 'paket' }, 'adresler');
registerPage({ id: 'paketrapor', label: 'Paket raporu', icon: 'paket', perm: 'report.view',
  group: 'paket' }, 'platformlar');

/* The lanes, in the order a delivery actually happens, with the one action
   that moves a card out of each. Declared once so the board and the detail
   drawer cannot disagree about what comes next. */
const PK_LANES = [
  ['NEW', 'Yeni', 'PREPARING', 'Hazırlığa al', 'btn--dark'],
  ['PREPARING', 'Hazırlanıyor', 'ON_ROUTE', 'Yola çıkar', 'btn--dark'],
  ['ON_ROUTE', 'Yolda', 'DELIVERED', 'Teslim edildi', 'btn--dark'],
  ['DELIVERED', 'Teslim edildi', null, null, null],
];
const PK_SOURCE = {
  PHONE: 'Telefon', COUNTER: 'Tezgâh', UBER_EATS_TGO: 'Trendyol Go',
  YEMEKSEPETI: 'Yemeksepeti', MIGROS_YEMEK: 'Migros Yemek', GETIR_YEMEK: 'Getir Yemek',
};
const PK_PAY = [['nakit', 'Nakit'], ['kredi_karti', 'Kredi kartı'], ['yemek_karti', 'Yemek kartı']];

Screens.add({

  /* =================================================================== *
   * SİPARİŞLER - the board                                              *
   * =================================================================== */
  async page_paket() {
    /* A column, because go() injects the tab strip as this page's first
       child after the screen has drawn. Left as a plain block, the board
       would be one strip-height taller than the space it has and the last
       row of every lane would sit under the bottom edge. */
    $('#main').innerHTML = `<div class="page is-on page--flush" style="display:flex;flex-direction:column">
      <div class="pk">
        <div class="pk__top">
          <button class="btn btn--primary" id="pkNew">+ Yeni paket siparişi</button>
          <button class="btn btn--ghost" id="pkFind">Adres ara</button>
          <div class="spacer"></div>
          <div class="pk__chips" id="pkChips"></div>
        </div>
        <div></div>
        <div class="pk__board" id="pkBoard"><div class="empty">Yükleniyor…</div></div>
      </div></div>`;
    $('#pkNew').onclick = () => this.pkNewOrder();
    $('#pkFind').onclick = () => go('adresler');
    try { await this.pkBoard(); } catch (e) { err(e); }
  },

  pkStopTimers() { if (this._pkTimer) { clearInterval(this._pkTimer); this._pkTimer = null; } },

  async pkBoard() {
    const d = await api('GET', '/api/delivery/board');
    const s = d.summary;
    $('#pkChips').innerHTML = `
      <span class="chip"><b>${s.couriers_on_shift}</b> kurye vardiyada</span>
      ${s.late ? `<span class="chip chip--warn"><b>${s.late}</b> sipariş gecikti</span>` : ''}
      ${s.scheduled ? `<span class="chip"><b>${s.scheduled}</b> ileri tarihli</span>` : ''}
      <span class="chip"><b>Bugün</b> ${s.delivered} teslim · ₺${tl(s.revenue)}</span>
      ${s.avg_minutes ? `<span class="chip"><b>Ort. teslim</b> ${s.avg_minutes} dk</span>` : ''}`;

    $('#pkBoard').innerHTML = PK_LANES.map(([key, label, next, btn, kind]) => {
      const rows = d.lanes[key] || [];
      return `<section class="lane">
        <div class="lane__head">${label}<span class="lane__count">${rows.length}</span></div>
        <div class="lane__body">${rows.map(o => this.pkCard(o, next, btn, kind)).join('')
          || '<div class="muted" style="padding:8px 4px;font-size:13px">—</div>'}</div>
      </section>`;
    }).join('');

    $$('#pkBoard [data-open]').forEach(el => el.onclick = (ev) => {
      if (ev.target.closest('button[data-next],button[data-kur]')) return;
      this.pkDetail(el.dataset.open);
    });
    $$('#pkBoard [data-next]').forEach(b => b.onclick = () =>
      this.pkMove(b.dataset.id, b.dataset.next));
    $$('#pkBoard [data-kur]').forEach(b => b.onclick = () => this.pkPickCourier(b.dataset.kur));

    /* Refreshes itself, for the same reason the Entegrasyonlar list does:
       the order that matters is the one that arrived while nobody was
       looking at the screen. */
    this.pkStopTimers();
    this._pkTimer = setInterval(() => {
      if (!$('#pkBoard')) return this.pkStopTimers();
      this.pkBoard().catch(() => {});
    }, 15000);
  },

  pkCard(o, next, btn, kind) {
    const src = PK_SOURCE[o.source] || o.source;
    const platform = o.source !== 'PHONE' && o.source !== 'COUNTER';
    /* A courier is a NAME, never a colour. The initials are there so a
       cashier can tell two cards apart at a glance without reading. */
    const ini = (o.courier_name || '').split(/\s+/).map(x => x[0] || '').join('').slice(0, 2).toUpperCase();
    const kur = o.courier_name
      ? `<span class="kur"><span class="kur__pin">${esc(ini)}</span>${esc(o.courier_name)}</span>`
      : `<button class="kur kur--none" data-kur="${o.id}"><span class="kur__pin">?</span>Kurye seç</button>`;
    /* ON_ROUTE without a courier is refused by the server, so the button is
       not offered either - a button that always fails is worse than none. */
    const action = next && !(next === 'ON_ROUTE' && !o.courier_id)
      ? `<button class="btn ${kind} btn--sm btn--wide" data-id="${o.id}" data-next="${next}">${btn}</button>`
      : (next === 'ON_ROUTE'
        ? `<button class="btn btn--ghost btn--sm btn--wide" data-kur="${o.id}">Kurye ata</button>` : '');

    /* A scheduled order counts down to its hour instead of ageing, so it is
       not shouting at the cashier for the five hours it is legitimately
       sitting there. */
    const clock = o.is_scheduled
      ? `<span class="pkc__age pkc__sched">${o.due_in_min > 0
          ? esc(String(o.scheduled_at).slice(11, 16)) : o.age_min + ' dk'}</span>`
      : `<span class="pkc__age">${o.age_min} dk</span>`;
    return `<div class="pkc${o.late ? ' is-late' : ''}" data-open="${o.id}">
      <div class="pkc__top">
        <span class="src ${platform ? 'src--platform' : 'src--phone'}"><i></i>${esc(src)}</span>
        <span class="pkc__no">#${esc(o.adisyon_no || o.order_id)}</span>
        ${clock}
      </div>
      <div>
        <div class="pkc__who">${esc(o.customer_name || 'İsimsiz')}</div>
        ${o.phone ? `<div class="pkc__phone">${esc(o.phone)}</div>` : ''}
      </div>
      <div class="pkc__addr">${esc(o.address_text || 'Adres yok')}${
        o.directions ? ' — ' + esc(o.directions) : ''}</div>
      ${Number(o.change_for) > 0
        ? `<div class="pkc__note">₺${tl(o.change_for)} ile ödeyecek · para üstü ₺${
            tl(Math.max(0, Number(o.change_for) - Number(o.total)))}</div>` : ''}
      ${o.is_scheduled && o.due_in_min > 0
        ? `<div class="pkc__note">İleri tarihli · ${esc(String(o.scheduled_at).slice(5, 16))}</div>` : ''}
      <div class="pkc__foot">${kur}<div class="spacer"></div>
        <span class="pkc__total">₺${tl(o.total)}</span></div>
      ${action}</div>`;
  },

  async pkMove(id, next, force = false) {
    /* Teslim edildi is the moment the money exists, so it is the moment we
       ask about it - and the ONLY place a delivery touches the takings. */
    if (next === 'DELIVERED') return this.pkDeliver(id);
    try {
      await api('POST', `/api/delivery/orders/${id}/status`, { status: next, force });
      await this.pkBoard();
    } catch (e) {
      /*
       * The zone minimum. A warning is a question - the guest often says yes
       * to the difference - and a block is still a question, because a till
       * that cannot take the order is a till that gets worked around. What
       * differs is the wording and who is expected to answer.
       */
      if (/alt limitinin altında/.test(e.message)) {
        const hard = /Engelle/.test(e.message);
        const okGo = await confirmBox('Alt limitin altında', e.message +
          '\n\nYine de hazırlığa alınsın mı?', hard);
        if (okGo) return this.pkMove(id, next, true);
        return;
      }
      err(e);
    }
  },

  async pkDeliver(id) {
    const d = await api('GET', `/api/delivery/orders/${id}`);
    const due = Number(d.order?.grand_total || 0)
      - (d.order?.payments || []).filter(p => !p.voided_at).reduce((s, p) => s + Number(p.amount), 0);
    modal(`
      <div class="modal__head"><h3>Teslim edildi</h3><div class="spacer"></div>
        <span class="badge badge--gray">#${esc(d.delivery.adisyon_no || d.delivery.order_id)}</span></div>
      <div class="modal__body">
        ${d.delivery.is_prepaid || due <= 0
          ? `<div class="alert alert--ok">Bu siparişin ödemesi alınmış. Tahsilat yapılmayacak.</div>`
          : `<p class="muted" style="margin-top:0">Kuryenin kapıda tahsil ettiği tutar.
               Bu ödeme adisyona işlenir; kuryeden kasaya teslim ayrı bir adımdır.</p>
             <div class="field"><label>Tutar</label>
               <input class="input mono" id="pkAmt" value="${tl(due)}"></div>
             <div class="field"><label>Ödeme türü</label>
               <select class="input" id="pkMethod">${PK_PAY.map(([k, l]) =>
                 `<option value="${k}">${l}</option>`).join('')}</select></div>`}
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" id="pkCancel">Vazgeç</button>
        <div class="spacer"></div>
        <button class="btn btn--primary" id="pkOk">Teslim edildi olarak işaretle</button></div>`);
    $('#pkCancel').onclick = closeModal;
    $('#pkOk').onclick = async () => {
      const body = { status: 'DELIVERED' };
      if ($('#pkAmt')) {
        body.payment = {
          amount: String($('#pkAmt').value).replace(/\./g, '').replace(',', '.'),
          method: $('#pkMethod').value,
        };
      }
      try {
        await api('POST', `/api/delivery/orders/${id}/status`, body);
        closeModal(); toast('Teslim edildi', 'ok'); this.pkBoard();
      } catch (e) { err(e); }
    };
  },

  async pkPickCourier(id) {
    const { rows } = await api('GET', '/api/delivery/couriers');
    if (!rows.length) {
      return toast('Önce Kuryeler sekmesinden kurye ekleyin', 'error');
    }
    modal(`
      <div class="modal__head"><h3>Kurye seç</h3></div>
      <div class="modal__body"><div class="adr">${rows.map(k => `
        <button class="adr__item" data-pick="${k.id}">
          <span class="adr__tag">${esc((k.name || '').slice(0, 2).toUpperCase())}</span>
          <span class="adr__text"><b>${esc(k.name)}</b><br>
            <span class="muted">${k.on_shift ? 'vardiyada' : 'vardiya dışı'} ·
              ${k.carrying} üzerinde · bugün ${k.delivered_today}</span></span>
          <span class="adr__dist">₺${tl(k.cash)}</span>
        </button>`).join('')}</div>
        <p class="mk__note" style="margin-bottom:0">Vardiyası kapalı bir kuryeye sipariş verilirse
          vardiyası kendiliğinden açılır.</p></div>
      <div class="modal__foot"><button class="btn btn--ghost" id="pkcClose">Kapat</button></div>`);
    $('#pkcClose').onclick = closeModal;
    $$('[data-pick]').forEach(b => b.onclick = async () => {
      try {
        await api('POST', `/api/delivery/orders/${id}/courier`, { courier_id: Number(b.dataset.pick) });
        closeModal(); this.pkBoard();
      } catch (e) { err(e); }
    });
  },

  async pkDetail(id) {
    const d = await api('GET', `/api/delivery/orders/${id}`);
    const o = d.delivery;
    modal(`
      <div class="modal__head"><h3>${esc(PK_SOURCE[o.source] || o.source)} · #${esc(o.adisyon_no || o.order_id)}</h3>
        <div class="spacer"></div><span class="badge badge--gray">${esc(o.status)}</span></div>
      <div class="modal__body">
        <div class="grid" style="gap:10px">
          <div><div class="muted" style="font-size:12.5px">Müşteri</div>
            <div class="strong">${esc(o.customer_name || '—')} ${o.phone ? '· ' + esc(o.phone) : ''}</div></div>
          <div><div class="muted" style="font-size:12.5px">Adres</div>
            <div>${esc(o.address_text || '—')}</div>
            ${o.directions ? `<div class="muted" style="font-size:12.5px">${esc(o.directions)}</div>` : ''}</div>
          <div class="row">
            <div><div class="muted" style="font-size:12.5px">Tutar</div>
              <div class="strong mono">₺${tl(o.grand_total)}</div></div>
            <div style="margin-left:24px"><div class="muted" style="font-size:12.5px">Teslimat ücreti</div>
              <div class="mono">₺${tl(o.delivery_fee)}</div></div>
            <div style="margin-left:24px"><div class="muted" style="font-size:12.5px">Kurye</div>
              <div>${esc(o.courier_name || '—')}</div></div>
          </div>
          <div><div class="muted" style="font-size:12.5px;margin-bottom:4px">Geçmiş</div>
            <table class="tbl"><tbody>${d.events.map(e => `<tr>
              <td class="muted" style="width:130px">${esc(String(e.created_at).slice(5, 16))}</td>
              <td>${esc(e.note || (e.from_status ? e.from_status + ' → ' : '') + e.to_status)}</td>
              <td class="right muted">${esc(e.display_name || e.actor_name || '')}</td></tr>`).join('')}
            </tbody></table></div>
        </div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--danger" id="pkKill">Siparişi iptal et</button>
        <div class="spacer"></div>
        <button class="btn btn--ghost" id="pkSlip">Kurye fişi yazdır</button>
        <button class="btn btn--ghost" id="pkToBill">Adisyonu aç</button>
        <button class="btn btn--primary" id="pkClose2">Kapat</button></div>`, { wide: true });
    $('#pkClose2').onclick = closeModal;
    $('#pkSlip').onclick = async () => {
      try { await api('POST', `/api/delivery/orders/${id}/slip`, {}); toast('Kurye fişi yazıcıya gönderildi', 'ok'); }
      catch (e) { err(e); }
    };
    $('#pkToBill').onclick = () => { closeModal(); go('order', o.order_id); };
    $('#pkKill').onclick = () => this.pkCancel(id);
  },

  /**
   * Cancelling asks WHY, from a list.
   *
   * Free text cannot be counted, and "the kitchen threw away four orders a
   * night this week" is exactly the sentence the report has to be able to
   * produce. The box stays for the detail; the code is what totals.
   */
  async pkCancel(id) {
    const { codes } = await api('GET', '/api/delivery/cancel-codes');
    modal(`
      <div class="modal__head"><h3>Siparişi iptal et</h3></div>
      <div class="modal__body">
        <div class="alert alert--error">Adisyon silinir, ciro ve stok geri alınır.</div>
        <div class="field"><label>Sebep</label>
          <select class="input" id="pkcCode">${codes.map(c =>
            `<option value="${esc(c.code)}">${esc(c.label)}</option>`).join('')}</select></div>
        <div class="field" style="margin-bottom:0"><label>Açıklama (isteğe bağlı)</label>
          <input class="input" id="pkcWhy" placeholder="Kısa not"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" id="pkcNo">Vazgeç</button>
        <div class="spacer"></div>
        <button class="btn btn--danger" id="pkcYes">İptal et</button></div>`);
    $('#pkcNo').onclick = closeModal;
    $('#pkcYes').onclick = async () => {
      try {
        await api('POST', `/api/delivery/orders/${id}/status`, {
          status: 'CANCELLED', cancel_code: $('#pkcCode').value, reason: $('#pkcWhy').value || null });
        closeModal(); this.pkBoard();
      } catch (e) { err(e); }
    };
  },

  /* =================================================================== *
   * YENİ PAKET SİPARİŞİ - phone first                                    *
   * =================================================================== */
  async pkNewOrder() {
    modal(`
      <div class="modal__head"><h3>Yeni paket siparişi</h3><div class="spacer"></div>
        <span class="chip">Adım 1/2 · Müşteri</span></div>
      <div class="modal__body">
        <div class="field" style="margin:0"><label>Telefon numarası</label>
          <div class="find"><input class="input mono" id="pkPhone" placeholder="0532 000 00 00" autofocus>
            <button class="btn btn--dark" id="pkSearch">Ara</button></div></div>
        <div id="pkWho"></div>
        <div class="row" style="gap:12px;margin-top:4px">
          <div class="field" style="flex:1;margin:0"><label>Teslim süresi (dk)</label>
            <input class="input mono" id="pkMin" placeholder="bölgeye göre"></div>
          <div class="field" style="flex:1;margin:0"><label>İleri tarihli (saat)</label>
            <input class="input" id="pkSched" type="datetime-local"></div>
          <div class="field" style="flex:1;margin:0"><label>Kaç TL ile ödeyecek</label>
            <input class="input mono" id="pkChange" placeholder="para üstü için"></div>
        </div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" id="pkNoClose">Vazgeç</button>
        <div class="spacer"></div>
        <button class="btn btn--primary" id="pkGo" disabled>Devam — ürün ekle</button></div>`, { wide: true });
    $('#pkNoClose').onclick = closeModal;

    const state = { customer: null, addressId: null, repeatFrom: null, flag: null, forced: false };
    const search = async () => {
      const phone = $('#pkPhone').value;
      let r;
      try { r = await api('GET', '/api/delivery/lookup?phone=' + encodeURIComponent(phone)); }
      catch (e) { return err(e); }
      state.customer = r.customer;
      state.addressId = null;
      $('#pkGo').disabled = true;
      if (!r.customer) {
        /* An unknown number is the common case at a new restaurant, so it is
           a form and not an error. */
        $('#pkWho').innerHTML = `
          <div class="alert alert--info">Bu numara kayıtlı değil. Yeni müşteri olarak kaydedilecek.</div>
          <div class="field"><label>Ad soyad</label><input class="input" id="pkName" placeholder="Ad soyad"></div>
          ${this.pkAddressForm()}`;
        this.pkWireAddressForm(state);
        return;
      }
      const st = r.stats || {};
      state.flag = r.flag || null;
      state.repeatFrom = null;
      $('#pkWho').innerHTML = `
        ${r.flag ? `<div class="alert ${r.flag.level === 'block' ? 'alert--error' : 'alert--warn'}">
          <b>${r.flag.level === 'block' ? 'Bu müşteri engellenmiş' : 'Dikkat edilecek müşteri'}</b><br>
          ${esc(r.flag.reason)}${r.flag.by ? ' — ' + esc(r.flag.by) : ''}
          ${r.flag.at ? ' · ' + esc(String(r.flag.at).slice(0, 10)) : ''}</div>` : ''}
        <div class="hit"><div class="hit__name">${esc([r.customer.first_name, r.customer.last_name]
          .filter(Boolean).join(' '))}</div>
          <div class="hit__meta">${st.orders || 0} sipariş${
            st.last_date ? ' · son sipariş ' + esc(String(st.last_date).slice(0, 10)) : ''}${
            st.avg ? ' · ortalama ₺' + tl(st.avg) : ''}</div></div>
        ${(r.recent || []).length ? `
          <div style="margin-top:14px">
            <div class="strong" style="font-size:13.5px;margin-bottom:8px">Son siparişleri</div>
            <div class="adr">${r.recent.map(o => `
              <button class="adr__item" data-rep="${o.order_id}">
                <span class="adr__tag">${esc(String(o.date).slice(5, 10))}</span>
                <span class="adr__text">${esc(o.items || '—')}</span>
                <span class="adr__dist">₺${tl(o.total)}</span>
              </button>`).join('')}</div>
            <p class="mk__note" style="margin:8px 0 0">Bir siparişe dokunursanız aynı ürünlerle
              yeni adisyon açılır; fiyatlar bugünün fiyatıdır.</p>
          </div>` : ''}
        <div>
          <div class="row" style="margin:14px 0 9px">
            <span class="strong" style="font-size:13.5px">Kayıtlı adresler</span><div class="spacer"></div>
            <button class="btn btn--ghost btn--sm" id="pkAddAddr">+ Yeni adres</button></div>
          <div class="adr" id="pkAddrs">${r.addresses.map(a => `
            <button class="adr__item${a.is_default ? ' is-on' : ''}" data-addr="${a.id}">
              <span class="adr__tag">${esc(a.tag)}</span>
              <span class="adr__text">${esc(a.address_text)}${
                a.directions ? `<br><span class="muted">${esc(a.directions)}</span>` : ''}</span>
              <span class="adr__dist">${a.zone_name ? esc(a.zone_name) : ''}${
                Number(a.zone_fee) > 0 ? ' ₺' + tl(a.zone_fee) : ''}</span>
            </button>`).join('') || '<div class="muted" style="font-size:13px">Kayıtlı adres yok.</div>'}</div>
        </div>
        <div id="pkNewAddr"></div>
        <p class="mk__note">Devam edince adisyon ekranı açılır ve ürünler normal şekilde eklenir.
          Teslimat ücreti bölgeye göre otomatik eklenir; kurye, sipariş hazırlandığında seçilir.</p>`;

      const def = r.addresses.find(a => a.is_default) || r.addresses[0];
      if (def) { state.addressId = def.id; $('#pkGo').disabled = false; }
      $$('#pkAddrs [data-addr]').forEach(b => b.onclick = () => {
        $$('#pkAddrs [data-addr]').forEach(x => x.classList.remove('is-on'));
        b.classList.add('is-on');
        state.addressId = Number(b.dataset.addr);
        $('#pkGo').disabled = false;
      });
      $('#pkAddAddr').onclick = () => {
        $('#pkNewAddr').innerHTML = this.pkAddressForm();
        this.pkWireAddressForm(state);
      };
      $$('#pkWho [data-rep]').forEach(b => b.onclick = () => {
        const on = state.repeatFrom === Number(b.dataset.rep);
        $$('#pkWho [data-rep]').forEach(x => x.classList.remove('is-on'));
        state.repeatFrom = on ? null : Number(b.dataset.rep);
        if (!on) b.classList.add('is-on');
        $('#pkGo').textContent = state.repeatFrom ? 'Aynı siparişi aç' : 'Devam — ürün ekle';
      });
    };
    $('#pkSearch').onclick = search;
    $('#pkPhone').onkeydown = (e) => { if (e.key === 'Enter') search(); };

    $('#pkGo').onclick = async () => {
      try {
        let customerId = state.customer ? state.customer.id : null;
        if (!customerId) {
          const name = ($('#pkName')?.value || '').trim();
          if (!name) return toast('Ad soyad gerekli', 'error');
          const c = await api('POST', '/api/manage/customers', {
            first_name: name.split(' ')[0], last_name: name.split(' ').slice(1).join(' ') || null,
            phone: $('#pkPhone').value,
          });
          customerId = c.id || c.customer_id;
        }
        if (!state.addressId) {
          state.addressId = await this.pkSaveAddress(customerId);
          if (!state.addressId) return;
        }
        const body = {
          customer_id: customerId, address_id: state.addressId,
          repeat_order_id: state.repeatFrom || null,
          promised_minutes: $('#pkMin').value || null,
          scheduled_at: $('#pkSched').value ? $('#pkSched').value.replace('T', ' ') + ':00' : null,
          change_for_minor: $('#pkChange').value
            ? Math.round(Number(String($('#pkChange').value).replace(/\./g, '').replace(',', '.')) * 100) : 0,
          force: state.forced === true,
        };
        const r = await api('POST', '/api/delivery/orders', body);
        closeModal();
        if (r.skipped) {
          toast(`${r.repeated} ürün eklendi, ${r.skipped} ürün artık menüde yok`, 'error');
        }
        /* Straight to the ordinary adisyon screen. A second product picker
           for deliveries would be a second thing to keep in step with the
           menu, the stock and the price list. */
        go('order', r.orderId);
      } catch (e) {
        /* A blocked customer is a decision, not a dialog to click past: the
           reason and the person who wrote it are shown, and only then is the
           override offered. */
        if (/engellenmiş/.test(e.message)) {
          if (await confirmBox('Engelli müşteri', e.message
              + '\n\nYine de sipariş alınsın mı? Bu tercih kayda geçer.', true)) {
            state.forced = true;
            return $('#pkGo').click();
          }
          return;
        }
        err(e);
      }
    };
  },

  pkAddressForm() {
    return `<div class="grid" style="gap:10px;margin-top:12px">
      <div class="row" style="gap:10px">
        <div class="field" style="flex:0 0 120px;margin:0"><label>Etiket</label>
          <input class="input" id="pkTag" value="EV"></div>
        <div class="field" style="flex:1;margin:0"><label>Mahalle / semt</label>
          <input class="input" id="pkDistrict" placeholder="Bahçelievler"></div>
        <div class="field" style="flex:0 0 200px;margin:0"><label>Bölge</label>
          <select class="input" id="pkZone"><option value="">Varsayılan</option></select></div>
      </div>
      <div class="field" style="margin:0"><label>Adres</label>
        <textarea class="input" id="pkAddrText" placeholder="Sokak, bina, daire"></textarea></div>
      <div class="field" style="margin:0"><label>Tarif / kapı notu</label>
        <input class="input" id="pkDirections" placeholder="Zil çalışmıyor, arayın · 3. kat"></div>
    </div>`;
  },

  async pkWireAddressForm(state) {
    state.addressId = null;
    $('#pkGo').disabled = false;
    try {
      const { rows } = await api('GET', '/api/delivery/zones');
      const sel = $('#pkZone');
      if (sel) {
        sel.innerHTML = rows.map(z => `<option value="${z.id}"${z.is_default ? ' selected' : ''}>${
          esc(z.name)}${Number(z.fee) > 0 ? ' · ₺' + tl(z.fee) : ''}</option>`).join('');
      }
    } catch (_) { /* zones are a convenience here; the server falls back */ }
  },

  async pkSaveAddress(customerId) {
    const text = ($('#pkAddrText')?.value || '').trim();
    if (text.length < 8) { toast('Adres girin', 'error'); return null; }
    const r = await api('POST', '/api/delivery/addresses', {
      customer_id: customerId, tag: $('#pkTag')?.value || 'EV',
      district: $('#pkDistrict')?.value || null, zone_id: $('#pkZone')?.value || null,
      address_text: text, directions: $('#pkDirections')?.value || null, is_default: true,
    });
    return r.id;
  },

  /* =================================================================== *
   * KURYELER - who is out, and whose pocket the cash is in              *
   * =================================================================== */
  async page_kurye() {
    $('#main').innerHTML = `<div class="page is-on page--flush" style="display:flex;flex-direction:column">
      <div class="kr">
        <div class="kr__list" id="krList"><div class="empty">Yükleniyor…</div></div>
        <section class="kr__panel" id="krPanel">
          <div class="kr__head"><div class="muted">Soldan bir kurye seçin</div></div>
          <div class="kr__body"></div><div class="kr__foot"></div>
        </section>
      </div></div>`;
    try { await this.krList(); } catch (e) { err(e); }
  },

  async krList(selectId) {
    const { rows } = await api('GET', '/api/delivery/couriers?all=1');
    this._krRows = rows;
    const sel = selectId || this._krSel || (rows.find(r => r.on_shift) || rows[0] || {}).id;
    this._krSel = sel;

    $('#krList').innerHTML = `
      <div class="row" style="padding:2px 2px 4px">
        <h2 class="page-title" style="margin:0;font-size:15px">Kuryeler</h2>
        <div class="spacer"></div>
        ${can('delivery.manage') ? '<button class="btn btn--ghost btn--sm" id="krAdd">Kurye ekle</button>' : ''}
      </div>
      ${rows.map(k => {
        const ini = (k.name || '').split(/\s+/).map(x => x[0] || '').join('').slice(0, 2).toUpperCase();
        return `<button class="kr-card${k.id === sel ? ' is-active' : ''}" data-k="${k.id}">
          <div class="kr-card__top">
            <span class="kur__pin" style="width:30px;height:30px;font-size:12px">${esc(ini)}</span>
            <span class="kr-card__name">${esc(k.name)}</span>
            <span class="shift ${k.on_shift ? 'shift--on' : 'shift--off'}">${
              k.on_shift ? 'Vardiyada' : 'Vardiya dışı'}</span>
          </div>
          <div class="kr-card__stats">
            <span><b>${k.carrying}</b>üzerinde</span>
            <span><b>${k.delivered_today}</b>bugün</span>
            <span><b>₺${tl(k.cash)}</b>nakit</span>
            <span><b>${k.avg_minutes || '—'}${k.avg_minutes ? ' dk' : ''}</b>ortalama</span>
          </div></button>`;
      }).join('') || '<div class="muted" style="font-size:13px;padding:8px 2px">Henüz kurye eklenmemiş.</div>'}`;

    if ($('#krAdd')) $('#krAdd').onclick = () => this.krEdit(null);
    $$('#krList [data-k]').forEach(b => b.onclick = () => this.krPanel(Number(b.dataset.k)));
    if (sel) await this.krPanel(sel);
  },

  async krPanel(id) {
    this._krSel = id;
    $$('#krList [data-k]').forEach(b => b.classList.toggle('is-active', Number(b.dataset.k) === id));
    const d = await api('GET', `/api/delivery/couriers/${id}`);
    const k = d.courier;
    const ini = (k.name || '').split(/\s+/).map(x => x[0] || '').join('').slice(0, 2).toUpperCase();
    const carrying = d.orders.filter(o => o.status === 'PREPARING' || o.status === 'ON_ROUTE');

    $('#krPanel').innerHTML = `
      <div class="kr__head">
        <span class="kur__pin" style="width:34px;height:34px;font-size:13px">${esc(ini)}</span>
        <div><div style="font-size:16px;font-weight:600">${esc(k.name)}</div>
          <div class="muted" style="font-size:12.5px">${d.shift
            ? 'Vardiya ' + esc(String(d.shift.opened_at).slice(11, 16)) + "'dan beri açık"
            : 'Vardiyası kapalı'} · ${d.orders.filter(o => o.status === 'DELIVERED').length} teslimat</div></div>
        <div class="spacer"></div>
        ${can('delivery.manage') ? `<button class="btn btn--ghost btn--sm" id="krEdit">Düzenle</button>` : ''}
      </div>
      <div class="kr__body">
        <table class="tbl">
          <thead><tr><th>Adisyon</th><th>Müşteri</th><th>Adres</th><th>Ödeme</th><th>Durum</th>
            <th class="right">Tutar</th></tr></thead>
          <tbody>${d.orders.map(o => `<tr>
            <td class="mono strong">#${esc(o.adisyon_no || o.order_id)}</td>
            <td>${esc(o.customer_name || '—')}</td>
            <td class="muted" style="max-width:280px">${esc(o.address_text || '—')}</td>
            <td>${o.is_prepaid ? 'Platformda ödendi' : esc(label(o.payment_method) || 'Kapıda')}</td>
            <td>${esc(PK_LANE_LABEL[o.status] || o.status)}</td>
            <td class="right mono strong">₺${tl(o.total)}</td></tr>`).join('')
            || '<tr><td colspan="6" class="muted">Bu vardiyada teslimat yok.</td></tr>'}
          </tbody></table>
      </div>
      <div class="kr__foot">
        <div class="settle">
          <div><div class="settle__lbl">Kuryede bekleyen nakit</div>
            <div class="settle__fig">₺${tl(d.cash)}</div></div>
          <div><div class="settle__lbl">Üzerinde</div>
            <div class="settle__fig">${carrying.length} adisyon</div></div>
          <div><div class="settle__lbl">Hakediş</div>
            <div class="settle__fig">₺${tl(d.earned)}</div></div>
          <div style="flex:1;min-width:200px">
            <div class="settle__lbl" style="line-height:1.45">Nakit teslim sırasında adisyona
              işlendi; devir yalnızca paranın kuryeden kasaya geçtiğini kaydeder, ciroya ikinci kez
              eklenmez. Hakediş kasadan otomatik düşülmez.</div></div>
          <button class="btn btn--primary" id="krSettle"${d.shift ? '' : ' disabled'}>Kasaya teslim al</button>
        </div>
      </div>`;

    if ($('#krEdit')) $('#krEdit').onclick = () => this.krEdit(k);
    if ($('#krSettle')) $('#krSettle').onclick = () => this.krSettle(k, d);
  },

  /**
   * The hand-over.
   *
   * The expected figure is shown and the counted figure is typed, because a
   * settlement that cannot record a difference is a settlement nobody trusts.
   * A short courier is a conversation, not a silent write.
   */
  async krSettle(k, d) {
    modal(`
      <div class="modal__head"><h3>Kasaya teslim al</h3><div class="spacer"></div>
        <span class="badge badge--gray">${esc(k.name)}</span></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">Kuryenin getirdiği nakdi sayın ve girin.
          Fark varsa kaydedilir; ciro değişmez.</p>
        <div class="row" style="gap:12px">
          <div class="field" style="flex:1"><label>Beklenen</label>
            <input class="input mono" value="${tl(d.cash)}" disabled></div>
          <div class="field" style="flex:1"><label>Sayılan</label>
            <input class="input mono" id="krTaken" value="${tl(d.cash)}"></div>
        </div>
        ${Number(d.earned) > 0 ? `<div class="alert alert--info" style="margin:0 0 14px">
          Bu vardiyada kuryenin hakedişi <b>₺${tl(d.earned)}</b>. Kasadan otomatik düşülmez -
          ödemeyi nasıl yaptığınız sizin kaydınız.</div>` : ''}
        <div class="field" style="margin-bottom:0"><label>Not (isteğe bağlı)</label>
          <input class="input" id="krNote" placeholder="Eksik / fazla açıklaması"></div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" id="krNo">Vazgeç</button>
        <div class="spacer"></div>
        <button class="btn btn--primary" id="krYes">Teslim aldım</button></div>`);
    $('#krNo').onclick = closeModal;
    $('#krYes').onclick = async () => {
      const raw = String($('#krTaken').value).replace(/\./g, '').replace(',', '.');
      try {
        const r = await api('POST', `/api/delivery/couriers/${k.id}/settle`, {
          taken_minor: Math.round(Number(raw) * 100), note: $('#krNote').value || null,
        });
        closeModal();
        toast(r.variance ? `Teslim alındı · fark ₺${tl(r.variance)}` : 'Teslim alındı', 'ok');
        this.krList(k.id);
      } catch (e) { err(e); }
    };
  },

  async krEdit(k) {
    modal(`
      <div class="modal__head"><h3>${k ? 'Kurye' : 'Yeni kurye'}</h3></div>
      <div class="modal__body">
        <div class="field"><label>Ad soyad</label>
          <input class="input" id="kuName" value="${esc(k?.name || '')}"></div>
        <div class="field"><label>Telefon</label>
          <input class="input mono" id="kuPhone" value="${esc(k?.phone || '')}"></div>
        <div class="field"><label>Teslimat başına hakediş (₺)</label>
          <input class="input mono" id="kuFee" placeholder="boş = bölgeye göre"
                 value="${k && k.fee_per_delivery !== null && k.fee_per_delivery !== undefined
                   ? tl(k.fee_per_delivery) : ''}">
          <div class="muted" style="font-size:12px;margin-top:5px">Boş bırakılırsa bölgeye yazılan
            tutar kullanılır. 0 yazmak "teslimat başına ödenmiyor" demektir.</div></div>
        ${k ? `<label class="row" style="gap:8px;font-size:14px">
          <input type="checkbox" id="kuActive" ${k.is_active ? 'checked' : ''}> Aktif</label>` : ''}
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" id="kuNo">Vazgeç</button>
        <div class="spacer"></div><button class="btn btn--primary" id="kuYes">Kaydet</button></div>`);
    $('#kuNo').onclick = closeModal;
    $('#kuYes').onclick = async () => {
      try {
        await api('POST', '/api/delivery/couriers', {
          id: k?.id, name: $('#kuName').value, phone: $('#kuPhone').value || null,
          fee_per_delivery: $('#kuFee').value === '' ? null
            : String($('#kuFee').value).replace(/\./g, '').replace(',', '.'),
          is_active: $('#kuActive') ? $('#kuActive').checked : true,
        });
        closeModal(); this.krList(k?.id);
      } catch (e) { err(e); }
    };
  },

  /* =================================================================== *
   * ADRESLER                                                            *
   * =================================================================== */
  async page_adresler() {
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Adresler</h2><div class="spacer"></div>
        <input class="input" id="adQ" placeholder="İsim, telefon, sokak ya da mahalle"
               style="width:320px;height:38px">
      </div>
      ${can('delivery.manage') ? `<div class="card" style="margin-bottom:14px">
        <div class="card__head"><h3>Teslimat bölgeleri ve ücretleri</h3><div class="spacer"></div>
          <button class="btn btn--ghost btn--sm" id="adZoneAdd">Bölge ekle</button></div>
        <div id="adZones"></div></div>` : ''}
      <div class="card"><div class="card__head"><h3>Kayıtlı adresler</h3></div>
        <div id="adBody"><div class="empty">Aramak için yazın.</div></div></div></div>`;

    const run = async () => {
      const q = $('#adQ').value.trim();
      if (q.length < 2) { $('#adBody').innerHTML = '<div class="empty">Aramak için yazın.</div>'; return; }
      const { rows } = await api('GET', '/api/delivery/addresses?q=' + encodeURIComponent(q));
      $('#adBody').innerHTML = `<table class="tbl">
        <thead><tr><th>Müşteri</th><th>Telefon</th><th>Etiket</th><th>Adres</th><th>Bölge</th>
          <th></th></tr></thead>
        <tbody>${rows.map(a => `<tr>
          <td class="strong">${esc([a.first_name, a.last_name].filter(Boolean).join(' '))}</td>
          <td class="mono">${esc(a.phone || '—')}</td>
          <td>${esc(a.tag)}</td>
          <td>${esc(a.address_text)}${a.directions
            ? `<div class="muted" style="font-size:12.5px">${esc(a.directions)}</div>` : ''}</td>
          <td class="muted">${esc(a.zone_name || 'Varsayılan')}</td>
          <td class="right"><button class="btn btn--ghost btn--sm" data-flag="${a.customer_id}"
            data-name="${esc([a.first_name, a.last_name].filter(Boolean).join(' '))}">Kayıt</button></td>
          </tr>`).join('')
          || '<tr><td colspan="6" class="muted">Eşleşen adres yok.</td></tr>'}
        </tbody></table>`;
      $$('#adBody [data-flag]').forEach(b => b.onclick = () =>
        this.adFlag(Number(b.dataset.flag), b.dataset.name));
    };
    let t = null;
    $('#adQ').oninput = () => { clearTimeout(t); t = setTimeout(() => run().catch(err), 250); };
    if (can('delivery.manage')) { $('#adZoneAdd').onclick = () => this.adZone(null); await this.adZones(); }
  },

  /**
   * The customer's record: the standing flag, and every flag ever raised.
   *
   * The history is shown and not only the live one, because "blocked twice
   * and forgiven twice" is a different customer from "flagged once last
   * year", and a screen that hides that makes the same argument happen again
   * every few months.
   */
  async adFlag(customerId, name) {
    const d = await api('GET', `/api/delivery/customers/${customerId}/flag`);
    const f = d.flag;
    modal(`
      <div class="modal__head"><h3>${esc(name || 'Müşteri')}</h3><div class="spacer"></div>
        ${f ? `<span class="badge ${f.level === 'block' ? 'badge--open' : 'badge--gray'}">${
          f.level === 'block' ? 'engelli' : 'dikkat'}</span>` : ''}</div>
      <div class="modal__body">
        ${f ? `<div class="alert ${f.level === 'block' ? 'alert--error' : 'alert--warn'}">
            <b>${f.level === 'block' ? 'Engelli' : 'Dikkat'}</b> — ${esc(f.reason)}
            ${f.by_name ? '<br><span class="muted">' + esc(f.by_name) + ' · '
              + esc(String(f.created_at).slice(0, 16)) + '</span>' : ''}</div>`
          : '<p class="muted" style="margin-top:0">Bu müşteri için bir kayıt yok.</p>'}
        ${can('delivery.manage') ? `
          <div class="row" style="gap:12px;align-items:flex-end">
            <div class="field" style="flex:0 0 170px;margin:0"><label>Kayıt türü</label>
              <select class="input" id="cfLevel">
                <option value="watch">Dikkat — uyarır, engellemez</option>
                <option value="block">Engelli — sipariş alınamaz</option></select></div>
            <div class="field" style="flex:1;margin:0"><label>Sebep</label>
              <input class="input" id="cfWhy" placeholder="Üç kez sipariş verip kapıyı açmadı"></div>
          </div>` : '<p class="muted" style="font-size:12.5px">Kayıt açmak için yönetici izni gerekir.</p>'}
        ${(d.history || []).length ? `
          <div style="margin-top:16px">
            <div class="strong" style="font-size:13.5px;margin-bottom:6px">Geçmiş</div>
            <table class="tbl"><tbody>${d.history.map(h => `<tr>
              <td class="muted" style="width:120px">${esc(String(h.created_at).slice(0, 10))}</td>
              <td>${h.level === 'block' ? 'Engelli' : 'Dikkat'} — ${esc(h.reason)}</td>
              <td class="right muted">${h.cleared_at ? 'kaldırıldı' : 'yürürlükte'}</td></tr>`).join('')}
            </tbody></table></div>` : ''}
      </div>
      <div class="modal__foot">
        ${f && can('delivery.manage') ? '<button class="btn btn--ghost" id="cfClear">Kaydı kaldır</button>' : ''}
        <div class="spacer"></div>
        <button class="btn btn--ghost" id="cfNo">Kapat</button>
        ${can('delivery.manage') ? '<button class="btn btn--primary" id="cfYes">Kaydet</button>' : ''}
      </div>`, { wide: true });
    $('#cfNo').onclick = closeModal;
    if ($('#cfLevel') && f) $('#cfLevel').value = f.level;
    if ($('#cfClear')) $('#cfClear').onclick = async () => {
      try { await api('DELETE', `/api/delivery/customers/${customerId}/flag`); closeModal();
        toast('Kayıt kaldırıldı', 'ok'); } catch (e) { err(e); }
    };
    if ($('#cfYes')) $('#cfYes').onclick = async () => {
      try {
        await api('POST', `/api/delivery/customers/${customerId}/flag`, {
          level: $('#cfLevel').value, reason: $('#cfWhy').value });
        closeModal(); toast('Kaydedildi', 'ok');
      } catch (e) { err(e); }
    };
  },

  async adZones() {
    const { rows } = await api('GET', '/api/delivery/zones?all=1');
    $('#adZones').innerHTML = `<table class="tbl">
      <thead><tr><th>Bölge</th><th>Teslimat ücreti</th><th>Alt limit</th><th>Kurye hakedişi</th>
        <th>Süre</th><th></th></tr></thead>
      <tbody>${rows.map(z => `<tr>
        <td><b>${esc(z.name)}</b> ${z.is_default ? '<span class="badge badge--gray">varsayılan</span>' : ''}
          ${z.is_active ? '' : '<span class="badge badge--gray">kapalı</span>'}</td>
        <td class="mono">₺${tl(z.fee)}</td>
        <td class="mono">${Number(z.min_order) > 0 ? '₺' + tl(z.min_order) : '—'}</td>
        <td class="mono">${Number(z.courier_fee) > 0 ? '₺' + tl(z.courier_fee) : '—'}</td>
        <td class="muted">${z.est_minutes} dk</td>
        <td class="right"><button class="btn btn--ghost btn--sm" data-z="${z.id}">Düzenle</button></td>
        </tr>`).join('')}
      </tbody></table>
      <div class="card__body" style="padding-top:0"><p class="muted" style="margin:0;font-size:12.5px">
        Tek ücret uygulayan bir işletme yalnızca varsayılan bölgenin ücretini değiştirir; ikinci bir
        bölge eklemek zorunda değildir.</p></div>`;
    $$('#adZones [data-z]').forEach(b => b.onclick = () =>
      this.adZone(rows.find(z => z.id === Number(b.dataset.z))));
  },

  async adZone(z) {
    modal(`
      <div class="modal__head"><h3>${z ? 'Bölge' : 'Yeni bölge'}</h3></div>
      <div class="modal__body">
        <div class="field"><label>Bölge adı</label>
          <input class="input" id="zName" value="${esc(z?.name || '')}" placeholder="Merkez"></div>
        <div class="row" style="gap:12px">
          <div class="field" style="flex:1"><label>Teslimat ücreti</label>
            <input class="input mono" id="zFee" value="${tl(z?.fee || 0)}"></div>
          <div class="field" style="flex:1"><label>Alt limit</label>
            <input class="input mono" id="zMin" value="${tl(z?.min_order || 0)}"></div>
          <div class="field" style="flex:1"><label>Tahmini süre (dk)</label>
            <input class="input mono" id="zEst" value="${z?.est_minutes || 30}"></div>
        </div>
        <div class="field"><label>Kurye hakedişi (₺ / teslimat)</label>
          <input class="input mono" id="zKfee" value="${tl(z?.courier_fee || 0)}">
          <div class="muted" style="font-size:12px;margin-top:5px">Bu bölgeye yapılan her teslimat
            için kuryeye ödenen tutar. Kuryenin kendi tutarı yazılmışsa o geçerlidir.</div></div>
        <label class="row" style="gap:8px;font-size:14px">
          <input type="checkbox" id="zDef" ${z?.is_default ? 'checked disabled' : ''}> Varsayılan bölge</label>
      </div>
      <div class="modal__foot">
        ${z && !z.is_default ? '<button class="btn btn--danger" id="zDel">Sil</button>' : ''}
        <div class="spacer"></div>
        <button class="btn btn--ghost" id="zNo">Vazgeç</button>
        <button class="btn btn--primary" id="zYes">Kaydet</button></div>`);
    $('#zNo').onclick = closeModal;
    if ($('#zDel')) $('#zDel').onclick = async () => {
      try { await api('DELETE', '/api/delivery/zones/' + z.id); closeModal(); this.adZones(); }
      catch (e) { err(e); }
    };
    $('#zYes').onclick = async () => {
      const num = (v) => String(v).replace(/\./g, '').replace(',', '.');
      try {
        await api('POST', '/api/delivery/zones', {
          id: z?.id, name: $('#zName').value, fee: num($('#zFee').value),
          min_order: num($('#zMin').value), courier_fee: num($('#zKfee').value),
          est_minutes: $('#zEst').value,
          is_default: $('#zDef').checked,
        });
        closeModal(); this.adZones();
      } catch (e) { err(e); }
    };
  },

  /* =================================================================== *
   * PLATFORMLAR - the four delivery platforms, from the board's side     *
   * =================================================================== */
  /*
   * WHY THIS TAB EXISTS NEXT TO THE ENTEGRASYON SCREEN.
   *
   * Entegrasyon is a settings screen: API keys, product mapping, logs - an
   * owner opens it twice and never again. But the person working the board
   * needs to know one thing several times a night: are the platforms
   * actually connected and taking orders, or is the reason nothing has come
   * in for an hour that something is switched off?
   *
   * So this is a status board, not a second settings form. Everything that
   * writes a credential still lives in one place, and the button here goes
   * there.
   */
  async page_platformlar() {
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Platformlar</h2><div class="spacer"></div>
        ${can('integration.manage')
          ? '<button class="btn btn--ghost btn--sm" id="plSettings">Bağlantı ayarları</button>' : ''}
      </div>
      <div id="plBody"><div class="empty">Yükleniyor…</div></div></div>`;
    if ($('#plSettings')) $('#plSettings').onclick = () => go('entegrasyon');
    try { await this.plDraw(); } catch (e) { err(e); }
  },

  async plDraw() {
    const [d, board] = await Promise.all([
      api('GET', '/api/integrations'),
      api('GET', '/api/delivery/board').catch(() => ({ lanes: {} })),
    ]);
    const countBySource = {};
    for (const lane of Object.values(board.lanes || {})) {
      for (const o of lane) countBySource[o.source] = (countBySource[o.source] || 0) + 1;
    }

    $('#plBody').innerHTML = `
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
        ${d.providers.map(p => {
          const live = p.environment === 'production';
          const onBoard = countBySource[p.key] || 0;
          return `<div class="card">
            <div class="card__head">
              <h3>${esc(p.label)}</h3><div class="spacer"></div>
              ${p.connected
                ? `<span class="badge ${p.enabled ? 'badge--closed' : 'badge--gray'}">${
                    p.enabled ? 'açık' : 'kapalı'}</span>`
                : '<span class="badge badge--gray">bağlanmadı</span>'}
            </div>
            <div class="card__body">
              <p class="muted" style="margin:0 0 12px;font-size:12.5px">${esc(p.note || '')}</p>
              <div class="row" style="gap:18px;margin-bottom:12px">
                <div><div class="muted" style="font-size:12px">Ortam</div>
                  <div class="strong">${live ? 'Canlı' : (p.environment === 'stage' ? 'Test' : 'Simülatör')}</div></div>
                <div><div class="muted" style="font-size:12px">Panoda</div>
                  <div class="strong mono">${onBoard}</div></div>
                <div><div class="muted" style="font-size:12px">Son bağlantı</div>
                  <div class="strong">${p.last_ok_at ? esc(String(p.last_ok_at).slice(5, 16)) : '—'}</div></div>
              </div>
              ${p.last_error ? `<div class="alert alert--error" style="margin:0 0 12px">${esc(p.last_error)}</div>` : ''}
              ${!p.connected
                ? `<div class="alert alert--info" style="margin:0 0 12px">Bu platform henüz bağlanmadı.
                     Bağlanmak için iş ortağı paketinizdeki bilgiler gerekir.</div>` : ''}
              <div class="row" style="gap:8px;flex-wrap:wrap">
                ${can('integration.manage')
                  ? `<button class="btn btn--ghost btn--sm" data-set="${p.key}">${
                      p.connected ? 'Ayarlar' : 'Bağlan'}</button>` : ''}
                ${p.connected && !live && can('integration.manage')
                  ? `<button class="btn btn--dark btn--sm" data-demo="${p.key}">Deneme siparişi gönder</button>` : ''}
                ${p.connected && p.enabled
                  ? `<button class="btn btn--ghost btn--sm" data-poll="${p.key}">Şimdi kontrol et</button>` : ''}
              </div>
            </div></div>`;
        }).join('')}
      </div>
      <p class="muted" style="font-size:12.5px;margin-top:14px;max-width:760px">
        Simülatör ortamındaki bir bağlantıya deneme siparişi gönderebilirsiniz: sipariş gerçek
        boru hattından geçer, adisyon açılır, mutfak fişi çıkar ve Siparişler panosuna düşer.
        Canlı bağlantıya deneme siparişi gönderilemez.</p>`;

    $$('#plBody [data-set]').forEach(b => b.onclick = () => go('entegrasyon'));
    $$('#plBody [data-poll]').forEach(b => b.onclick = async () => {
      try { await api('POST', '/api/integrations/poll', { provider: b.dataset.poll });
        toast('Kontrol edildi', 'ok'); this.plDraw(); } catch (e) { err(e); }
    });
    $$('#plBody [data-demo]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try {
        await api('POST', `/api/integrations/${b.dataset.demo}/demo-order`, {});
        toast('Deneme siparişi panoya düştü', 'ok');
        go('paket');
      } catch (e) { err(e); b.disabled = false; }
    });
  },

  /* =================================================================== *
   * PAKET RAPORU                                                        *
   * =================================================================== */
  async page_paketrapor() {
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Paket raporu</h2><div class="spacer"></div>
        <input class="input" type="date" id="prFrom" style="width:170px;height:38px">
        <input class="input" type="date" id="prTo" style="width:170px;height:38px">
        <button class="btn btn--dark btn--sm" id="prGo">Getir</button>
      </div>
      <div id="prBody"><div class="empty">Yükleniyor…</div></div></div>`;
    const draw = async () => {
      const qs = [];
      if ($('#prFrom').value) qs.push('from=' + $('#prFrom').value);
      if ($('#prTo').value) qs.push('to=' + $('#prTo').value);
      const r = await api('GET', '/api/delivery/report' + (qs.length ? '?' + qs.join('&') : ''));
      $('#prFrom').value = r.from; $('#prTo').value = r.to;
      $('#prBody').innerHTML = `
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(190px,1fr));margin-bottom:14px">
          <div class="stat"><div class="stat__label">Paket sipariş</div>
            <div class="stat__value">${r.totals.orders}</div>
            ${r.totals.cancelled ? `<div class="stat__sub">${r.totals.cancelled} iptal</div>` : ''}</div>
          <div class="stat"><div class="stat__label">Ciro</div>
            <div class="stat__value">₺${tl(r.totals.revenue)}</div></div>
          <div class="stat"><div class="stat__label">Teslimat ücreti</div>
            <div class="stat__value">₺${tl(r.totals.fees)}</div></div>
          <div class="stat"><div class="stat__label">Ortalama teslim</div>
            <div class="stat__value">${r.totals.avg_minutes} dk</div></div>
        </div>
        <div class="grid" style="grid-template-columns:1fr 1fr">
          <div class="card"><div class="card__head"><h3>Nereden geldi</h3></div>
            <table class="tbl"><thead><tr><th>Kanal</th><th class="right">Adet</th>
              <th class="right">Ciro</th></tr></thead>
              <tbody>${r.by_source.map(x => `<tr><td>${esc(PK_SOURCE[x.source] || x.source)}</td>
                <td class="right mono">${x.orders}</td>
                <td class="right mono">₺${tl(x.revenue)}</td></tr>`).join('')
                || '<tr><td colspan="3" class="muted">Kayıt yok.</td></tr>'}</tbody></table></div>
          <div class="card"><div class="card__head"><h3>Kurye performansı</h3></div>
            <table class="tbl"><thead><tr><th>Kurye</th><th class="right">Teslimat</th>
              <th class="right">Ort.</th><th class="right">En yavaş</th>
              <th class="right">Zamanında</th></tr></thead>
              <tbody>${r.by_courier.map(x => `<tr>
                <td class="strong">${esc(x.name)}</td>
                <td class="right mono">${x.orders}</td>
                <td class="right mono">${x.avg_minutes} dk</td>
                <td class="right mono">${x.max_minutes} dk</td>
                <td class="right mono${x.on_time_pct < 80 ? ' is-loss' : ''}">%${x.on_time_pct}${
                  x.late ? ` <span class="muted">(${x.late} geç)</span>` : ''}</td></tr>`).join('')
                || '<tr><td colspan="5" class="muted">Kayıt yok.</td></tr>'}</tbody></table></div>
        </div>

        <div class="card" style="margin-top:14px">
          <div class="card__head"><h3>Kurye kasası</h3><div class="spacer"></div>
            <span class="muted" style="font-size:12.5px">Teslim edilen para ve kasa farkı</span></div>
          <table class="tbl">
            <thead><tr><th>Kurye</th><th class="right">Taşıdığı ciro</th>
              <th class="right">Tahsil ettiği nakit</th><th class="right">Hakediş</th>
              <th class="right">Vardiya</th>
              <th class="right">Kasaya teslim</th><th class="right">Fark</th></tr></thead>
            <tbody>${r.by_courier.map(x => `<tr>
              <td class="strong">${esc(x.name)}</td>
              <td class="right mono">₺${tl(x.revenue)}</td>
              <td class="right mono">₺${tl(x.cash)}</td>
              <td class="right mono">₺${tl(x.pay)}</td>
              <td class="right mono">${x.shifts}</td>
              <td class="right mono">₺${tl(x.settled)}</td>
              <td class="right mono ${Number(x.variance) < 0 ? 'is-loss' : ''}">${
                Number(x.variance) === 0 ? '—'
                  : (Number(x.variance) > 0 ? '+' : '') + '₺' + tl(x.variance)}</td></tr>`).join('')
              || '<tr><td colspan="7" class="muted">Kayıt yok.</td></tr>'}</tbody></table>
          <div class="card__body" style="padding-top:0"><p class="muted" style="margin:0;font-size:12.5px">
            Fark, kuryenin kasaya getirdiği para ile beklenen tutar arasındaki toplam farktır.
            Sürekli eksi veren bir kurye tek bir akşama bakarak görülmez.
            Hakediş kasaya teslimden düşülmez; ayrı ödenir.</p></div>
        </div>

        ${(r.cancels || []).length ? `<div class="card" style="margin-top:14px">
          <div class="card__head"><h3>İptal sebepleri</h3><div class="spacer"></div>
            <span class="muted" style="font-size:12.5px">Mutfak mı, kurye mi, müşteri mi</span></div>
          <table class="tbl">
            <thead><tr><th>Sebep</th><th class="right">Adet</th>
              <th class="right">Kaybedilen ciro</th></tr></thead>
            <tbody>${r.cancels.map(c => `<tr>
              <td>${esc(c.label)}</td>
              <td class="right mono">${c.orders}</td>
              <td class="right mono is-loss">₺${tl(c.revenue)}</td></tr>`).join('')}
            </tbody></table></div>` : ''}`;
    };
    $('#prGo').onclick = () => draw().catch(err);
    try { await draw(); } catch (e) { err(e); }
  },
});

/* The lane a row is in, in words, for the courier table. Mirrors LANE_LABEL
   on the server - the two are small enough that sharing them over the wire
   would cost more than it saves, and the test suite checks they agree. */
const PK_LANE_LABEL = {
  NEW: 'Yeni', PREPARING: 'Hazırlanıyor', ON_ROUTE: 'Yolda',
  DELIVERED: 'Teslim edildi', CANCELLED: 'İptal',
};
