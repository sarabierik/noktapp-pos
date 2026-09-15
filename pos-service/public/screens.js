/* =====================================================================
   NOKTApp POS - screens
   ===================================================================== */
'use strict';

/*
 * The screen registry.
 *
 * This started as one object literal in one file, which was fine at four
 * screens and unworkable at twenty: every new area meant editing the same
 * 1,700 lines, and two people could not touch it at once. Screens now live in
 * public/screens/*.js and attach themselves here with Screens.add(), so a
 * screen is a file and adding one touches nothing that already works.
 */
const Screens = {

  /** Register more screens. Later files may not silently replace earlier ones. */
  add(obj) {
    for (const [k, v] of Object.entries(obj)) {
      if (Object.prototype.hasOwnProperty.call(Screens, k) && k !== 'add') {
        console.warn('Screens: "' + k + '" is already defined and was not replaced');
        continue;
      }
      Screens[k] = v;
    }
    return Screens;
  },

  /* ------------------------------------------------------------ setup */
  async wizard(state) {
    let step = 1;
    const draw = () => {
      modal(`
        <div class="modal__head"><h3>Kurulum sihirbazı</h3><div class="spacer"></div>
          <span class="badge badge--gray">${step} / 4</span></div>
        <div class="modal__body" id="wizBody"></div>`, { wide: true });
      if (step === 1) {
        $('#wizBody').innerHTML = `
          <p class="muted" style="margin-top:0">Fişlerin üstünde görünecek işletme bilgileri.</p>
          <div class="split-2">
            <div class="field"><label>İşletme adı</label><input class="input" id="wBiz" placeholder="Örnek Restoran"></div>
            <div class="field"><label>Telefon</label><input class="input" id="wPhone"></div>
            <div class="field"><label>Vergi no</label><input class="input" id="wTax"></div>
            <div class="field"><label>Vergi dairesi</label><input class="input" id="wOffice"></div>
          </div>
          <div class="field"><label>Adres</label><input class="input" id="wAddr"></div>
          <div class="field"><label>Fiş altı yazısı</label><input class="input" id="wFoot" value="Bizi tercih ettiğiniz için teşekkürler"></div>
          <div class="row"><div class="spacer"></div><button class="btn btn--primary" id="wNext">Devam</button></div>`;
        $('#wNext').onclick = async () => {
          try {
            await api('POST', '/api/setup/seed');
            await api('POST', '/api/setup/business', {
              business_name: $('#wBiz').value, phone: $('#wPhone').value, tax_number: $('#wTax').value,
              tax_office: $('#wOffice').value, address: $('#wAddr').value, receipt_footer: $('#wFoot').value });
            step = 2; draw();
          } catch (e) { err(e); }
        };
      } else if (step === 2) {
        $('#wizBody').innerHTML = `
          <p class="muted" style="margin-top:0">İlk yönetici hesabı. PIN kasada kullanılır, şifre telefon uygulamasında.</p>
          <div class="split-2">
            <div class="field"><label>Ad soyad</label><input class="input" id="wName" placeholder="Yönetici"></div>
            <div class="field"><label>Kullanıcı adı</label><input class="input" id="wUser" value="yonetici"></div>
            <div class="field"><label>Kasa PIN (4-6 hane)</label><input class="input" id="wPin" inputmode="numeric" type="password"></div>
            <div class="field"><label>Telefon uygulaması şifresi</label><input class="input" id="wPw" type="password"></div>
          </div>
          <div id="wAlert"></div>
          <div class="row"><div class="spacer"></div><button class="btn btn--primary" id="wNext">Devam</button></div>`;
        $('#wNext').onclick = async () => {
          try {
            await api('POST', '/api/setup/first-user', {
              display_name: $('#wName').value, username: $('#wUser').value,
              pin: $('#wPin').value, password: $('#wPw').value });
            step = 3; draw();
          } catch (e) { $('#wAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
        };
      } else if (step === 3) {
        $('#wizBody').innerHTML = `
          <p class="muted" style="margin-top:0">Masalarınızı tek seferde oluşturun. Sonradan istediğiniz kadar ekleyebilirsiniz.</p>
          <div class="split-4">
            <div class="field"><label>Bölüm</label><input class="input" id="wZone" value="Salon"></div>
            <div class="field"><label>Ön ek</label><input class="input" id="wPrefix" value="Masa"></div>
            <div class="field"><label>Başlangıç</label><input class="input" id="wFrom" type="number" value="1"></div>
            <div class="field"><label>Bitiş</label><input class="input" id="wTo" type="number" value="12"></div>
          </div>
          <div class="row"><div class="spacer"></div><button class="btn btn--primary" id="wNext">Devam</button></div>`;
        $('#wNext').onclick = async () => {
          try {
            await api('POST', '/api/setup/tables', {
              zone_name: $('#wZone').value, prefix: $('#wPrefix').value,
              from: Number($('#wFrom').value), to: Number($('#wTo').value) });
            step = 4; draw();
          } catch (e) { err(e); }
        };
      } else {
        $('#wizBody').innerHTML = `
          <p class="muted" style="margin-top:0">Fiş yazıcınızı tanıtın. Şimdi atlayıp Ayarlar bölümünden de ekleyebilirsiniz.</p>
          <div class="split-2">
            <div class="field"><label>Yazıcı adı</label><input class="input" id="wPrName" value="Kasa Yazıcı"></div>
            <div class="field"><label>Bağlantı</label>
              <select class="input" id="wPrType">
                <option value="network">Ağ yazıcısı (IP)</option>
                <option value="usb">Windows yazıcısı (USB)</option>
              </select></div>
          </div>
          <div class="field"><label>IP adresi veya Windows yazıcı adı</label><input class="input" id="wPrAddr" placeholder="192.168.1.50"></div>
          <div class="row">
            <button class="btn btn--ghost" id="wSkip">Şimdilik atla</button><div class="spacer"></div>
            <button class="btn btn--primary" id="wDone">Kurulumu bitir</button></div>`;
        const finish = async () => {
          try { await api('POST', '/api/setup/finish'); closeModal(); showPinPad(); }
          catch (e) { err(e); }
        };
        $('#wSkip').onclick = finish;
        $('#wDone').onclick = async () => {
          try {
            if ($('#wPrAddr').value) {
              await api('POST', '/api/manage/printers', {
                name: $('#wPrName').value, type: $('#wPrType').value,
                ip_address: $('#wPrAddr').value, is_default: 1 });
            }
          } catch (e) { err(e); }
          finish();
        };
      }
    };
    draw();
  },

  async loadMenu() {
    const r = await api('GET', '/api/pos/menu');
    App.data.menu = r.menu;
  },

  render(page, arg) {
    const fn = this['page_' + page];
    if (fn) fn.call(this, arg);
  },

  /* ----------------------------------------------------------- tables */
  async page_tables() {
    const main = $('#main');
    if (!$('#pgTables')) {
      main.innerHTML = `<div class="page page--flush is-on" id="pgTables"><div class="plan">
        <div class="plan__zones" id="zoneTabs"></div><div class="plan__grid" id="tableGrid"></div>
        <div id="joinBar"></div></div></div>`;
    }
    try {
      const r = await api('GET', '/api/pos/tables');
      App.data.tables = r.tables; App.data.zones = r.zones;
      App.data.groups = r.groups || [];
      if (App.data.zone === null && r.zones.length) App.data.zone = r.zones[0].id;
      const joining = !!App.data.joinMode;
      const picked = App.data.joinPick || (App.data.joinPick = []);
      $('#zoneTabs').innerHTML =
        `<button class="zone-tab${App.data.zone === 0 ? ' is-active' : ''}" data-z="0">Tümü</button>` +
        r.zones.map(z => `<button class="zone-tab${App.data.zone === z.id ? ' is-active' : ''}" data-z="${z.id}">${esc(z.name)}</button>`).join('') +
        `<div class="spacer"></div>
         <button class="btn btn--${joining ? 'primary' : 'ghost'} btn--sm" id="btnJoin">Masa birleştir</button>
         <button class="btn btn--ghost btn--sm" id="btnQuick">Hızlı satış</button>`;
      $$('#zoneTabs .zone-tab').forEach(b => b.onclick = () => { App.data.zone = Number(b.dataset.z); this.page_tables(); });
      $('#btnQuick').onclick = async () => {
        try { const o = await api('POST', '/api/pos/orders', {}); go('order', o.order_id); } catch (e) { err(e); }
      };
      $('#btnJoin').onclick = () => {
        App.data.joinMode = !App.data.joinMode;
        App.data.joinPick = [];
        this.page_tables();
      };
      const list = App.data.zone ? r.tables.filter(t => t.zone_id === App.data.zone) : r.tables;
      /*
       * A joined table is drawn busy even though the bill is not filed against
       * it, and it says which group it is in. That is the whole point: six
       * people are sitting at masa 5 and the tile used to read "boş".
       */
      $('#tableGrid').innerHTML = list.length ? list.map(t => {
        const sel = picked.indexOf(t.id);
        return `
        <button class="table-card${t.open_bills ? ' is-busy' : ''}" data-t="${t.id}"${sel >= 0
          ? ' style="border-color:var(--orange);box-shadow:0 0 0 3px var(--orange-soft)"' : ''}>
          <div class="table-card__name"><span class="table-card__dot"></span>${esc(t.name)}${
            sel === 0 ? ' <span style="font-size:11px;color:var(--orange-dark)">ana masa</span>'
            : (sel > 0 ? ' <span style="font-size:11px;color:var(--orange-dark)">' + (sel + 1) + '.</span>' : '')}</div>
          ${t.group_name ? `<div class="table-card__meta" style="color:var(--orange-dark);font-weight:600">${
            esc(t.group_name)}${t.group_primary ? ' · hesap burada' : ''}</div>` : ''}
          <div class="table-card__meta">${t.group_id
            ? (t.group_size + ' masa · tek adisyon')
            : (t.open_bills
              ? t.open_bills + ' adisyon' + (t.labels ? ' · ' + esc(t.labels) : '')
              : 'boş')}</div>
          <div class="table-card__total">${t.open_bills ? tl(t.open_total) + ' ₺' : ''}</div>
        </button>`; }).join('') : `<div class="empty">Bu bölümde masa yok.</div>`;
      $$('#tableGrid .table-card').forEach(b => b.onclick = () => {
        const id = Number(b.dataset.t);
        if (!App.data.joinMode) return this.openTable(id);
        const at = App.data.joinPick.indexOf(id);
        if (at >= 0) App.data.joinPick.splice(at, 1); else App.data.joinPick.push(id);
        this.page_tables();
      });
      this.drawJoinBar();
    } catch (e) { err(e); }
  },

  /**
   * The bar under the floor plan while masalar are being picked.
   *
   * It names the group BEFORE anything is committed - "Masa 4+5+6" is what the
   * waiter is about to create, and reading it back is the only check that the
   * right three tiles were tapped on a busy screen.
   */
  drawJoinBar() {
    const bar = $('#joinBar');
    if (!bar) return;
    const groups = App.data.groups || [];
    if (!App.data.joinMode) {
      bar.innerHTML = groups.length
        ? `<div class="row" style="gap:8px;padding:0 18px 16px;flex-wrap:wrap;align-items:center">
             <span style="font-size:12.5px;color:var(--ink-3)">Birleşik masalar:</span>
             ${groups.map(g => `<button class="chip chip--warn" data-g="${g.id}">
               <b>${esc(g.name)}</b> · yönet</button>`).join('')}
           </div>`
        : '';
      $$('#joinBar [data-g]').forEach(b => b.onclick = () => this.groupMenu(Number(b.dataset.g)));
      return;
    }
    const picked = App.data.joinPick || [];
    const tables = App.data.tables || [];
    const names = picked.map(id => (tables.find(t => t.id === id) || {}).name).filter(Boolean);
    const inGroup = picked.map(id => tables.find(t => t.id === id)).filter(t => t && t.group_id);
    const target = inGroup.length ? inGroup[0].group_id : null;
    const preview = names.length ? names.join('+') : 'Birleştirilecek masaları seçin';
    bar.innerHTML = `
      <div class="row" style="gap:10px;padding:0 18px 16px;align-items:center;flex-wrap:wrap">
        <div class="chip chip--warn"><b>${esc(preview)}</b></div>
        <span style="font-size:12.5px;color:var(--ink-3)">${picked.length < 2
          ? 'En az iki masa seçin. İlk seçtiğiniz masa ana masadır - hesap orada durur.'
          : (target ? 'Seçilenler mevcut gruba eklenecek.' : 'İlk masa ana masa: hesap orada durur.')}</span>
        <div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="joinCancel">Vazgeç</button>
        <button class="btn btn--primary btn--sm" id="joinGo"${picked.length < 2 ? ' disabled' : ''}>Birleştir</button>
      </div>`;
    $('#joinCancel').onclick = () => { App.data.joinMode = false; App.data.joinPick = []; this.page_tables(); };
    $('#joinGo').onclick = async () => {
      try {
        if (target) {
          for (const id of picked) {
            const t = tables.find(x => x.id === id);
            if (t && t.group_id) continue;                 // already in it
            await api('POST', `/api/pos/table-groups/${target}/tables`, { table_id: id });
          }
          toast('Masalar gruba eklendi');
        } else {
          const g = await api('POST', '/api/pos/table-groups',
            { table_ids: picked, primary_table_id: picked[0] });
          toast(g.group.name + ' birleştirildi');
        }
        App.data.joinMode = false; App.data.joinPick = [];
        this.page_tables();
      } catch (e) { err(e); }
    };
  },

  /** Add a table, send one back, or break the group up. */
  async groupMenu(groupId) {
    try {
      const { group: g } = await api('GET', `/api/pos/table-groups/${groupId}`);
      const free = (App.data.tables || []).filter(t => !t.open_bills && !t.group_id);
      modal(`
        <div class="modal__head"><h3>${esc(g.name)}</h3><div class="spacer"></div>
          <button class="close-x" onclick="closeModal()">✕</button></div>
        <div class="modal__body">
          <div class="alert alert--info" style="margin-bottom:12px">
            ${g.tables.length} masa, tek adisyon. Hesap ana masada durur;
            grubu dağıtırsanız adisyon kapanmaz, ana masada açık kalır.</div>
          ${g.tables.map(t => `
            <div class="row" style="gap:8px;align-items:center;margin-bottom:8px">
              <b style="flex:1">${esc(t.name)}${Number(t.table_id) === Number(g.primary_table_id)
                ? ' <span style="font-weight:500;color:var(--orange-dark)">· ana masa</span>' : ''}</b>
              ${Number(t.table_id) === Number(g.primary_table_id) ? ''
                : `<button class="btn btn--ghost btn--sm" data-out="${t.table_id}">Çıkar</button>`}
            </div>`).join('')}
          <div class="field" style="margin-top:12px"><label>Gruba masa ekle</label>
            <select class="input" id="grpAdd">
              <option value="">Masa seçin…</option>
              ${free.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
            </select></div>
          <div class="row" style="gap:8px;margin-top:12px">
            <button class="btn btn--ghost" id="grpSplit">Grubu dağıt</button>
            <div class="spacer"></div>
            <button class="btn btn--primary" id="grpBill">Adisyonu aç</button>
          </div>
        </div>`);
      const again = async () => { closeModal(); await this.page_tables(); this.groupMenu(groupId); };
      $$('#modal [data-out]').forEach(b => b.onclick = async () => {
        try {
          const r = await api('DELETE', `/api/pos/table-groups/${groupId}/tables/${b.dataset.out}`);
          if (r.dissolved) { closeModal(); toast('Tek masa kaldı, grup dağıtıldı'); return this.page_tables(); }
          again();
        } catch (e) { err(e); }
      });
      $('#grpAdd').onchange = async (e) => {
        if (!e.target.value) return;
        try { await api('POST', `/api/pos/table-groups/${groupId}/tables`, { table_id: Number(e.target.value) }); again(); }
        catch (ex) { err(ex); }
      };
      $('#grpSplit').onclick = async () => {
        // confirmBox takes the modal over, so a "vazgeç" has to put this one back
        if (!await confirmBox('Grubu dağıt',
          `${g.name} ayrılacak. Adisyon kapanmaz - açık olarak ana masada kalır.`)) return this.groupMenu(groupId);
        try {
          await api('POST', `/api/pos/table-groups/${groupId}/ungroup`);
          closeModal(); toast('Grup dağıtıldı'); this.page_tables();
        } catch (e) { err(e); }
      };
      $('#grpBill').onclick = () => {
        closeModal();
        if (g.order_id) go('order', g.order_id); else this.openTable(g.primary_table_id);
      };
    } catch (e) { err(e); }
  },

  async openTable(tableId) {
    try {
      /*
       * A joined table has ONE bill for the whole party, so tapping any of its
       * tiles lands on that same adisyon. Without this masa 5 would open a
       * second bill and the group would be paying twice for one dinner.
       */
      const tile = (App.data.tables || []).find(t => Number(t.id) === Number(tableId));
      if (tile && tile.group_id) {
        const g = await api('GET', `/api/pos/tables/${tableId}/group`);
        if (g.group && g.group.order_id) return go('order', g.group.order_id);
      }
      const bills = (await api('GET', '/api/pos/orders/open')).orders.filter(o => o.table_id === tableId);
      if (bills.length === 0) {
        const o = await api('POST', '/api/pos/orders', { table_id: tableId });
        return go('order', o.order_id);
      }
      /*
       * A busy table ALWAYS asks, even when it holds a single bill.
       *
       * It used to walk straight into the only open adisyon, which read as
       * convenient and meant a second party on the same table had nowhere to
       * go - "still not multi table adisiyon". Two couples at a six-top, a
       * table that turns while the first bill is still being settled, a
       * takeaway added to an occupied table: all ordinary, all impossible.
       *
       * The server was ready the whole time - the second bill is labelled A,
       * the third B - the till just never offered it.
       */
      const tableName = (tile && tile.name) || 'Masa';
      modal(`
        <div class="modal__head"><h3>${esc(tableName)}</h3>
          <span class="badge badge--gray">${bills.length} açık adisyon</span>
          <div class="spacer"></div>
          <button class="close-x" onclick="closeModal()">✕</button></div>
        <div class="modal__body">
          ${bills.map(b => `<button class="btn btn--ghost btn--wide btn--lg"
             style="margin-bottom:8px;justify-content:space-between" data-o="${b.id}">
             <span>${b.bill_label
               ? '<span class="badge badge--label">' + esc(b.bill_label) + '</span> '
               : ''}Adisyon #${b.adisyon_no}</span><b>${tl(b.grand_total)} ₺</b></button>`).join('')}
          <button class="btn btn--primary btn--wide btn--lg" id="newBill">+ Yeni adisyon aç</button>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px">
            Yeni adisyon aynı masaya açılır ve kendi etiketini alır (A, B, C…).
            Her biri ayrı yazdırılır, ayrı ödenir.</p>
        </div>`);
      $$('#modal [data-o]').forEach(b => b.onclick = () => { closeModal(); go('order', Number(b.dataset.o)); });
      $('#newBill').onclick = async () => {
        closeModal();
        try {
          const o = await api('POST', '/api/pos/orders', { table_id: tableId });
          go('order', o.order_id);
        } catch (e) { err(e); }
      };
    } catch (e) { err(e); }
  },

  /* ------------------------------------------------------ order screen */
  async page_order(orderId) {
    /* a new bill always starts on the category cards; the last category a
       waiter opened on somebody else's table is not a useful starting point */
    if (orderId && orderId !== App.data.orderId) App.data.category = null;
    if (orderId) App.data.orderId = orderId;
    const id = App.data.orderId;
    if (!id) return go('tables');
    $('#main').innerHTML = `<div class="page page--flush is-on"><div class="order">
      <div class="order__menu">
        <div class="cat-bar" id="catBar"></div>
        <div class="prod-grid" id="prodGrid"></div>
      </div>
      <div class="bill" id="bill"></div>
    </div></div>`;
    this.drawMenu();
    await this.drawBill();
  },

  /**
   * KATEGORİLER KART OLARAK.
   *
   * They used to be one horizontal strip of tabs. With seven categories that
   * is fine; with sixteen - pizza, bira, ana yemekler, deniz ürünleri, türk
   * mutfağı, kokteyller… - the strip runs off the side of a touch screen and
   * the waiter has to drag it sideways to reach the one they want, during
   * service, with a plate in the other hand. Worse, the tab that WAS visible
   * often held four products, so the biggest area of the screen sat empty
   * while the thing being looked for was off-screen.
   *
   * So the menu opens on the categories themselves, as cards: every one of
   * them visible at once, named, with how many products it holds. Tapping one
   * opens it; "← Kategoriler" goes back. `App.data.category === null` is the
   * card view, and it is the state the screen now starts in.
   */
  drawMenu() {
    const cats = App.data.menu;
    const cat = cats.find(c => c.id === App.data.category);

    if (!cat) {
      $('#catBar').innerHTML = '';
      $('#prodGrid').className = 'cat-grid';
      $('#prodGrid').innerHTML = cats.length ? cats.map((c, i) => `
        <button class="cat-card" data-c="${c.id}" style="--k:${i % 8}">
          <span class="cat-card__sw"></span>
          <span class="cat-card__name">${esc(c.name)}</span>
          <span class="cat-card__count">${c.products.length} ürün</span>
        </button>`).join('') : '<div class="empty">Menüde kategori yok.</div>';
      $$('#prodGrid .cat-card').forEach(b => b.onclick = () => {
        App.data.category = Number(b.dataset.c); this.drawMenu();
      });
      return;
    }

    $('#catBar').innerHTML =
      `<button class="cat-back" id="catBack">← Kategoriler</button>` +
      `<span class="cat-title">${esc(cat.name)}</span>` +
      `<span class="cat-count">${cat.products.length} ürün</span>`;
    const back = $('#catBack');
    if (back) back.onclick = () => { App.data.category = null; this.drawMenu(); };
    $('#prodGrid').className = 'prod-grid';
    $('#prodGrid').innerHTML = cat ? cat.products.map(p => `
      <button class="prod${p.track_stock && Number(p.stock) <= 0 ? ' is-out' : ''}" data-p="${p.id}">
        <span class="prod__more" title="Adet, yarım porsiyon ve not">⋯</span>
        <div class="prod__name">${esc(p.name)}</div>
        <div>
          <div class="prod__price">${tl(p.price)} ₺</div>
          ${p.track_stock ? `<div class="prod__stock">stok ${Number(p.stock)}</div>` : ''}
        </div>
      </button>`).join('') : '<div class="empty">Bu kategoride ürün yok.</div>';
    /*
     * Tap adds one. The "..." corner opens adet/not.
     *
     * That corner is not decoration: the options dialog used to be on
     * right-click only, and a touch till has no right button - so on the
     * machine this product actually runs on, half portions and kitchen notes
     * were unreachable. Long-press works too, for anyone who expects it.
     */
    $$('#prodGrid .prod').forEach(b => {
      const id = Number(b.dataset.p);
      b.onclick = (e) => {
        if (e.target.closest('.prod__more')) return;
        this.addItem(id, 1);
      };
      b.oncontextmenu = (e) => { e.preventDefault(); this.itemOptions(id); };
      let held = null;
      const start = () => { held = setTimeout(() => { held = null; this.itemOptions(id); }, 450); };
      const stop = () => { if (held) { clearTimeout(held); held = null; } };
      b.addEventListener('touchstart', start, { passive: true });
      b.addEventListener('touchend', stop);
      b.addEventListener('touchmove', stop);
      const more = b.querySelector('.prod__more');
      if (more) more.onclick = (e) => { e.stopPropagation(); this.itemOptions(id); };
    });
  },

  async addItem(productId, qty, note) {
    try {
      const r = await api('POST', `/api/pos/orders/${App.data.orderId}/items`, { product_id: productId, qty, note });
      App.data.order = r.order;
      this.drawBill(true);
    } catch (e) { err(e); }
  },

  /**
   * Adet, yarim porsiyon and the kitchen note, in one dialog.
   *
   * Half portions are a real menu item in a Turkish kitchen, so 1/2 is a
   * first-class button and not something to be typed. Thirds are deliberately
   * absent - the server snaps to halves anyway, and offering a control that
   * silently rounds is worse than not offering it.
   */
  itemOptions(productId, presetQty) {
    const p = (App.data.menu.find(c => c.products.some(x => x.id === productId)) || { products: [] })
      .products.find(x => x.id === productId) || { name: '', price: 0 };
    let qty = presetQty || 1;
    modal(`
      <div class="modal__head"><h3>${esc(p.name)}</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <label style="font-size:13px;color:var(--ink-2)">Adet</label>
        <div class="row" style="gap:8px;margin:8px 0 4px;flex-wrap:wrap">
          ${[0.5, 1, 1.5, 2, 3, 4].map(q =>
            `<button class="btn btn--ghost qty-chip" data-q="${q}">${q === 0.5 ? '½ porsiyon' : (q === 1.5 ? '1½' : q)}</button>`).join('')}
        </div>
        <div class="split-2">
          <div class="field"><label>Adet (yarım için 0,5)</label>
            <input class="input" id="niQty" type="number" value="1" min="0.5" step="0.5" inputmode="decimal"></div>
          <div class="field"><label>Tutar</label>
            <input class="input" id="niSum" value="" disabled></div>
        </div>
        <div class="field"><label>Mutfak notu</label>
          <input class="input" id="niNote" placeholder="az pişmiş, soğansız..."></div>
        <div class="row" style="flex-wrap:wrap;gap:8px">
          ${['az pişmiş', 'orta', 'iyi pişmiş', 'soğansız', 'acısız', 'az buzlu', 'ayrı gelsin', 'servis en son']
            .map(t => `<button class="btn btn--ghost btn--sm" data-t="${t}">${t}</button>`).join('')}
        </div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="niOk">Adisyona ekle</button></div>`);

    const sum = () => { $('#niSum').value = tl(Number($('#niQty').value || 0) * Number(p.price || 0)) + ' ₺'; };
    const setQty = (q) => { qty = q; $('#niQty').value = q; sum(); };
    $$('#modal .qty-chip').forEach(b => b.onclick = () => setQty(Number(b.dataset.q)));
    $('#niQty').oninput = sum;
    setQty(qty);
    // notes append rather than replace: "az pişmiş" and "soğansız" are both true
    $$('#modal [data-t]').forEach(b => b.onclick = () => {
      const cur = $('#niNote').value.trim();
      const parts = cur ? cur.split(',').map(x => x.trim()) : [];
      if (parts.includes(b.dataset.t)) $('#niNote').value = parts.filter(x => x !== b.dataset.t).join(', ');
      else $('#niNote').value = [...parts, b.dataset.t].join(', ');
    });
    $('#niOk').onclick = () => {
      const q = Number($('#niQty').value) || 1, n = $('#niNote').value.trim() || null;
      closeModal(); this.addItem(productId, q, n);
    };
  },

  async drawBill(keepScroll) {
    const el = $('#bill');
    if (!el) return;
    const top = keepScroll && $('.bill__lines') ? $('.bill__lines').scrollTop : 0;
    let o;
    try { o = (await api('GET', `/api/pos/orders/${App.data.orderId}`)).order; }
    catch (e) { err(e); return go('tables'); }
    App.data.order = o;
    const pending = o.items.some(i => Number(i.qty) > Number(i.sent_qty));

    el.innerHTML = `
      <div class="bill__head">
        <div class="bill__title">
          <button class="btn btn--ghost btn--sm" id="bkTables">← Masalar</button>
          <h3>${esc(o.table_name || 'Hızlı satış')}</h3>
          ${o.table_id ? `<button class="badge badge--label" id="bLabel"
              title="Adisyon etiketi - masada birden fazla hesap varsa hangisi olduğunu söyler">${
              o.bill_label ? esc(o.bill_label) : '+ etiket'}</button>` : ''}
          <span class="badge ${o.status === 'open' ? 'badge--open' : 'badge--closed'}">#${o.adisyon_no}</span>
          <div class="spacer"></div>
          ${o.reopen_count > 0 ? '<span class="badge badge--gray">yeniden açıldı</span>' : ''}
        </div>
      </div>
      <div class="bill__tabs" id="billTabs" hidden></div>
      <div class="loyal" id="loyalStrip"></div>
      <div class="bill__lines" id="billLines">
        ${o.items.length ? o.items.map(i => `
          <div class="line" data-i="${i.id}">
            <div class="line__qty">${Number(i.qty)}</div>
            <div>
              <div class="line__name">${esc(i.product_name)}</div>
              ${i.note ? `<div class="line__note">${esc(i.note)}</div>` : ''}
              ${Number(i.sent_qty) > 0 ? `<div class="line__sent">${Number(i.sent_qty)} adet mutfağa gitti</div>` : ''}
            </div>
            <div class="line__total mono">${tl(i.line_total)}</div>
          </div>`).join('') : '<div class="empty">Soldan ürün seçin.</div>'}
      </div>
      <div class="bill__foot">
        <div class="total-row"><span>Ara toplam</span><span class="mono">${tl(o.total)} ₺</span></div>
        ${Number(o.discount_total) > 0 ? `<div class="total-row"><span>İndirim</span><span class="mono">-${tl(o.discount_total)} ₺</span></div>` : ''}
        <div class="total-row"><span>KDV</span><span class="mono">${tl(o.vat_total)} ₺</span></div>
        ${o.paid > 0 ? `<div class="total-row"><span>Ödenen</span><span class="mono">${tl(o.paid)} ₺</span></div>` : ''}
        <div class="total-row total-row--grand"><span>${o.paid > 0 ? 'Kalan' : 'Toplam'}</span>
          <span class="mono">${tl(o.paid > 0 ? o.due : o.grand_total)} ₺</span></div>
        <div class="pad">
          <button class="btn ${pending ? 'btn--dark' : 'btn--ghost'}" id="bSend">Gönder</button>
          <button class="btn btn--ghost" id="bPrint">Fiş yazdır</button>
          <button class="btn btn--ghost" id="bMore">İşlemler</button>
          <button class="btn btn--primary" id="bPay">Öde</button>
        </div>
      </div>`;
    $('#billLines').scrollTop = top;
    this.drawLoyalty(o);
    this.drawBillTabs(o);
    $('#bkTables').onclick = () => go('tables');
    /*
     * The label is what the waiter says out loud: "masa 4, B hesabi". Two
     * parties on one table is ordinary in a restaurant, and without a name for
     * each bill the only handle is a five-digit adisyon number nobody repeats.
     */
    if ($('#bLabel')) $('#bLabel').onclick = async () => {
      const v = await this.askText('Adisyon etiketi', o.bill_label || 'A',
        'Masada birden fazla hesap varsa ayırt etmek için. Boş bırakılabilir.');
      if (v === null) return;
      try {
        await api('POST', `/api/pos/orders/${o.id}/label`, { label: v });
        this.drawBill(true);
      } catch (e) { err(e); }
    };
    $('#bSend').onclick = () => this.sendKitchen();
    $('#bPrint').onclick = async () => {
      try { await api('POST', `/api/pos/orders/${o.id}/print`); toast('Hesap fişi yazıcıya gönderildi', 'ok'); }
      catch (e) { err(e); }
    };
    $('#bPay').onclick = () => this.payDialog(o);
    $('#bMore').onclick = () => this.moreDialog(o);
    $$('#billLines .line').forEach(l => l.onclick = () => this.lineDialog(o, Number(l.dataset.i)));
  },

  async sendKitchen() {
    try {
      const r = await api('POST', `/api/pos/orders/${App.data.orderId}/send`);
      if (!r.sent) toast('Gönderilecek yeni ürün yok');
      else if (r.print_error) {
        // the order DID go to the board; only the paper failed. Say which.
        toast(r.sent + ' ürün gönderildi — fiş basılamadı: ' + r.print_error, 'error');
      } else toast(r.sent + ' ürün gönderildi', 'ok');
      this.drawBill(true);
    } catch (e) { err(e); }
  },

  lineDialog(o, itemId) {
    const it = o.items.find(i => i.id === itemId);
    if (!it) return;
    const sent = Number(it.sent_qty) > 0;
    modal(`
      <div class="modal__head"><h3>${esc(it.product_name)}</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div class="split-2">
          <div class="field"><label>Adet (yarım için 0,5)</label>
            <input class="input" id="liQty" type="number" inputmode="decimal"
                   min="${sent ? Number(it.sent_qty) : 0.5}" step="0.5" value="${Number(it.qty)}"></div>
          <div class="field"><label>Birim fiyat</label>
            <input class="input" id="liPrice" type="number" step="0.01" value="${Number(it.unit_price)}" ${can('price.manage') ? '' : 'disabled'}></div>
        </div>
        <div class="row" style="gap:8px;margin:-4px 0 10px;flex-wrap:wrap">
          ${[0.5, 1, 1.5, 2, 3].filter(q => !sent || q >= Number(it.sent_qty))
            .map(q => `<button class="btn btn--ghost btn--sm liq" data-q="${q}">${q === 0.5 ? '½' : (q === 1.5 ? '1½' : q)}</button>`).join('')}
        </div>
        <div class="field"><label>Bu satıra indirim (₺)</label>
          <input class="input" id="liDisc" type="number" step="0.01" min="0"
                 value="${Number(it.discount_amount || 0) || ''}" placeholder="0,00"
                 ${can('order.discount') ? '' : 'disabled'}>
        </div>
        <div class="field"><label>Mutfak notu</label><input class="input" id="liNote" value="${esc(it.note || '')}"></div>
        ${sent ? '<div class="alert alert--info">Bu ürün mutfağa gitti. Azaltmak için iptal kullanın; mutfağa iptal fişi basılır.</div>' : ''}
      </div>
      <div class="modal__foot">
        <button class="btn btn--danger" id="liCancel">İptal et</button>
        <div class="spacer"></div>
        <button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="liSave">Kaydet</button>
      </div>`);
    $$('#modal .liq').forEach(b => b.onclick = () => { $('#liQty').value = b.dataset.q; });
    $('#liSave').onclick = async () => {
      try {
        await api('PUT', `/api/pos/orders/${o.id}/items/${itemId}`, {
          qty: Number($('#liQty').value), note: $('#liNote').value,
          unit_price: Number($('#liPrice').value),
          discount_amount: Number($('#liDisc').value) || 0 });
        closeModal(); this.drawBill(true);
      } catch (e) { err(e); }
    };
    $('#liCancel').onclick = async () => {
      closeModal();
      let approved = null;
      if (sent && !can('order.item.cancel')) approved = await askOverride('order.item.cancel', 'Mutfağa giden ürünü iptal etmek için yetkili onayı gerekli.');
      const reason = await this.askText('İptal sebebi', 'Müşteri vazgeçti');
      if (reason === null) return;
      try {
        await api('DELETE', `/api/pos/orders/${o.id}/items/${itemId}`, { reason, approved_by: approved });
        this.drawBill(true);
      } catch (e) { err(e); }
    };
  },

  askText(title, placeholder, hint) {
    return new Promise((resolve) => {
      modal(`
        <div class="modal__head"><h3>${esc(title)}</h3></div>
        <div class="modal__body"><div class="field">
          ${hint ? `<label>${esc(hint)}</label>` : ''}
          <input class="input" id="atVal" placeholder="${esc(placeholder || '')}"></div></div>
        <div class="modal__foot"><button class="btn btn--ghost" id="atNo">Vazgeç</button>
          <button class="btn btn--primary" id="atOk">Tamam</button></div>`);
      $('#atNo').onclick = () => { closeModal(); resolve(null); };
      $('#atOk').onclick = () => { const v = $('#atVal').value; closeModal(); resolve(v); };
      $('#atVal').onkeydown = (e) => { if (e.key === 'Enter') $('#atOk').click(); };
    });
  },

  /* -------------------------------------------------------- payments */
  payDialog(o) {
    const due = o.paid > 0 ? o.due : Number(o.grand_total);
    modal(`
      <div class="modal__head"><h3>Ödeme · Adisyon #${o.adisyon_no}</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div class="stat" style="margin-bottom:16px">
          <div class="stat__label">Kalan tutar</div>
          <div class="stat__value" id="pyDue">${tl(due)} ₺</div>
        </div>
        <div class="field"><label>Alınan tutar</label>
          <input class="input" id="pyAmount" type="number" step="0.01" value="${due.toFixed(2)}"></div>
        <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:16px">
          ${[50, 100, 200, 500, 1000].map(n => `<button class="btn btn--ghost btn--sm" data-cash="${n}">${n} ₺</button>`).join('')}
          <button class="btn btn--ghost btn--sm" data-cash="exact">Tam</button>
        </div>
        <label style="font-size:13px;color:var(--ink-2)">Ödeme türü</label>
        <div class="split-3" style="margin-top:8px">
          <button class="btn btn--dark btn--lg" data-m="nakit">Nakit</button>
          <button class="btn btn--ghost btn--lg" data-m="kredi_karti">Kredi kartı</button>
          <button class="btn btn--ghost btn--lg" data-m="yemek_karti">Yemek kartı</button>
        </div>
        <div class="split-3" style="margin-top:10px">
          <button class="btn btn--ghost" data-m="havale">Havale</button>
          <button class="btn btn--ghost" data-m="ikram">İkram</button>
          <button class="btn btn--ghost" data-m="acik_hesap">Açık hesap</button>
        </div>
        <div id="pyOkc" style="margin-top:16px"></div>
        <div id="pyInfo" style="margin-top:14px"></div>
      </div>`);
    $$('#modal [data-cash]').forEach(b => b.onclick = () => {
      $('#pyAmount').value = b.dataset.cash === 'exact' ? due.toFixed(2)
        : (Number($('#pyAmount').value || 0) + Number(b.dataset.cash)).toFixed(2);
    });
    /*
     * Not even asked for while ÖKC is off. The server refuses the sale anyway
     * (fiscal.beginSale), but a cashier must never see an "ÖKC ile öde" button
     * that answers with an error - in front of a guest, at the moment of
     * payment, is the worst place in this program to discover a switch.
     */
    if (featureOn('okc')) api('GET', '/api/manage/fiscal/devices').then(r => {
      if (!r.devices.length) return;
      $('#pyOkc').innerHTML = `
        <div class="alert alert--info" style="margin:0 0 10px">Yeni Nesil ÖKC bağlı: ${esc(r.devices[0].provider)}</div>
        <button class="btn btn--primary btn--wide btn--lg" id="pyFiscal">ÖKC ile öde (mali fiş)</button>`;
      $('#pyFiscal').onclick = () => this.fiscalPay(o, Number($('#pyAmount').value));
    }).catch(() => {});
    $$('#modal [data-m]').forEach(b => b.onclick = async () => {
      const amount = Number($('#pyAmount').value);
      try {
        const r = await api('POST', `/api/pos/orders/${o.id}/payments`, {
          method: b.dataset.m, amount, print_bill: b.dataset.m !== 'acik_hesap',
          open_drawer: b.dataset.m === 'nakit' });
        if (r.change > 0) {
          $('#pyInfo').innerHTML = `<div class="alert alert--ok">Para üstü: <b>${tl(r.change)} ₺</b></div>`;
          setTimeout(() => { closeModal(); r.closed ? go('tables') : this.drawBill(); }, 1800);
        } else {
          closeModal();
          if (r.closed) { toast('Adisyon kapatıldı', 'ok'); go('tables'); } else this.drawBill();
        }
        refreshHeader();
      } catch (e) { err(e); }
    });
  },

  async fiscalPay(o, amount) {
    try {
      const start = await api('POST', `/api/pos/orders/${o.id}/fiscal/pay`, { method: 'kredi_karti', amount });
      modal(`
        <div class="modal__head"><h3>ÖKC bekleniyor</h3></div>
        <div class="modal__body" style="text-align:center;padding:36px 20px">
          <div class="stat__value" style="font-size:34px">${tl(amount)} ₺</div>
          <p class="muted" id="fsState">Müşteri kartını cihaza okutsun...</p>
          <button class="btn btn--ghost" id="fsCancel" style="margin-top:12px">İşlemi iptal et</button>
        </div>`);
      $('#fsCancel').onclick = async () => {
        try { await api('POST', `/api/pos/fiscal/transactions/${start.transactionId}/cancel`); } catch (_) {}
        closeModal();
      };
      const started = Date.now();
      const iv = setInterval(async () => {
        if (Date.now() - started > 200000) { clearInterval(iv); return; }
        try {
          const t = (await api('GET', `/api/pos/fiscal/transactions/${start.transactionId}`)).transaction;
          if (t.state === 'approved') {
            clearInterval(iv); closeModal();
            toast('Mali fiş kesildi: ' + ((t.receipt && t.receipt.fiscal_receipt_no) || ''), 'ok');
            const cur = (await api('GET', `/api/pos/orders/${o.id}`)).order;
            cur.status === 'closed' ? go('tables') : this.drawBill();
          } else if (['declined', 'error', 'cancelled'].includes(t.state)) {
            clearInterval(iv); closeModal();
            toast('ÖKC işlemi tamamlanmadı: ' + (t.error_message || t.state), 'error');
          }
        } catch (_) {}
      }, 1000);
    } catch (e) { err(e); }
  },

  /* ------------------------------------------------------ other actions */
  moreDialog(o) {
    modal(`
      <div class="modal__head"><h3>Adisyon işlemleri</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div class="split-2" style="gap:10px">
          <button class="btn btn--ghost btn--lg" data-a="discount">Adisyona indirim</button>
          <button class="btn btn--ghost btn--lg" data-a="transfer">Masa değiştir</button>
          <button class="btn btn--ghost btn--lg" data-a="split">Adisyon böl</button>
          <button class="btn btn--ghost btn--lg" data-a="merge">Adisyon birleştir</button>
          <button class="btn btn--ghost btn--lg" data-a="mail">Hesabı e-posta ile gönder</button>
          <button class="btn btn--ghost btn--lg" data-a="loyalty">Sadakat / müşteri</button>
          <button class="btn btn--ghost btn--lg" data-a="drawer">Çekmeceyi aç</button>
          <button class="btn btn--danger btn--lg" data-a="cancel">Adisyonu iptal et</button>
        </div>
      </div>`);
    $$('#modal [data-a]').forEach(b => b.onclick = () => { closeModal(); this.moreAction(b.dataset.a, o); });
  },

  async moreAction(action, o) {
    try {
      if (action === 'discount') {
        /*
         * The discount dialog shows the BILL.
         *
         * It used to be two empty boxes and a reason, and it silently meant
         * "the whole adisyon" - so taking 10% off one starter meant working
         * out the lira yourself and typing it into a box labelled percent.
         * "indirim must be able to to by whole bill or by product", and to
         * choose you have to be able to see what is on the bill.
         */
        const lines = (o.items || []).filter(i => !i.is_deleted);
        let target = 'bill';           // 'bill' | an order_item id
        const lineOf = (id) => lines.find(l => Number(l.id) === Number(id));
        const baseOf = () => target === 'bill'
          ? Number(o.total)
          : Number(lineOf(target).qty) * Number(lineOf(target).unit_price);

        modal(`
          <div class="modal__head"><h3>İndirim</h3><div class="spacer"></div>
            <button class="close-x" onclick="closeModal()">✕</button></div>
          <div class="modal__body">
            <div class="dc-pick" id="dcPick">
              <button class="dc-opt is-active" data-t="bill">
                <span>Tüm adisyon</span>
                <b class="mono">${tl(o.total)} ₺</b></button>
              ${lines.map(i => `<button class="dc-opt" data-t="${i.id}">
                <span>${Number(i.qty)} × ${esc(i.product_name)}${
                  Number(i.discount_amount) > 0
                    ? ` <span class="muted">(-${tl(i.discount_amount)} ₺ indirimli)</span>` : ''}</span>
                <b class="mono">${tl(Number(i.qty) * Number(i.unit_price))} ₺</b></button>`).join('')}
            </div>
            <div class="split-2" style="margin-top:14px">
              <div class="field"><label>Yüzde (%)</label>
                <input class="input mono" id="dcPct" type="number" step="1" min="0" max="100" placeholder="10"></div>
              <div class="field"><label>Tutar (₺)</label>
                <input class="input mono" id="dcAmt" type="number" step="0.01" min="0" placeholder="50"></div>
            </div>
            <div class="field"><label>Sebep</label>
              <input class="input" id="dcWhy" placeholder="Sadık müşteri"></div>
            <div class="dc-sum" id="dcSum"></div>
          </div>
          <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
            <button class="btn btn--primary" id="dcOk">Uygula</button></div>`);

        /* One number wins: typing in either box clears the other, so there is
           never a percent and an amount both sitting there disagreeing. */
        const value = () => {
          const pct = Number($('#dcPct').value) || 0;
          const amt = Number($('#dcAmt').value) || 0;
          const base = baseOf();
          const off = pct > 0 ? Math.round(base * pct) / 100 : amt;
          return { pct, amt, base, off: Math.min(off, base) };
        };
        const paint = () => {
          const v = value();
          $('#dcSum').innerHTML = v.off > 0
            ? `<div class="dc-sum__row"><span>${target === 'bill' ? 'Adisyon' : 'Satır'} tutarı</span>
                 <b class="mono">${tl(v.base)} ₺</b></div>
               <div class="dc-sum__row"><span>İndirim</span>
                 <b class="mono" style="color:var(--red)">-${tl(v.off)} ₺</b></div>
               <div class="dc-sum__row dc-sum__row--grand"><span>Kalan</span>
                 <b class="mono">${tl(v.base - v.off)} ₺</b></div>`
            : '<p class="muted" style="margin:0;font-size:12.5px">Yüzde ya da tutar girin.</p>';
        };
        $('#dcPct').oninput = () => { if ($('#dcPct').value) $('#dcAmt').value = ''; paint(); };
        $('#dcAmt').oninput = () => { if ($('#dcAmt').value) $('#dcPct').value = ''; paint(); };
        $$('#dcPick [data-t]').forEach(b => b.onclick = () => {
          $$('#dcPick .dc-opt').forEach(x => x.classList.remove('is-active'));
          b.classList.add('is-active');
          target = b.dataset.t === 'bill' ? 'bill' : Number(b.dataset.t);
          paint();
        });
        paint();

        $('#dcOk').onclick = async () => {
          const v = value();
          if (v.off <= 0) return toast('Yüzde ya da tutar girin');
          const approved = can('order.discount') ? null : await askOverride('order.discount');
          try {
            if (target === 'bill') {
              await api('POST', `/api/pos/orders/${o.id}/discount`, {
                percent: v.pct > 0 ? v.pct : null,
                amount: v.pct > 0 ? null : v.off,
                reason: $('#dcWhy').value, approved_by: approved });
            } else {
              /*
               * A line discount is stored as an amount, so a percentage is
               * turned into one here against that line's own gross - not the
               * bill's, which is what made "10% off the pizza" impossible to
               * express before.
               */
              await api('PUT', `/api/pos/orders/${o.id}/items/${target}`, {
                discount_amount: v.off, reason: $('#dcWhy').value, approved_by: approved });
            }
            closeModal(); this.drawBill();
          } catch (e) { err(e); }
        };
      } else if (action === 'transfer') {
        const r = await api('GET', '/api/pos/tables');
        modal(`
          <div class="modal__head"><h3>Masa değiştir</h3></div>
          <div class="modal__body"><div class="plan__grid" style="padding:0">
            ${r.tables.map(t => `<button class="table-card${t.open_bills ? ' is-busy' : ''}" data-t="${t.id}">
              <div class="table-card__name">${esc(t.name)}</div>
              <div class="table-card__meta">${t.open_bills ? 'dolu' : 'boş'}</div></button>`).join('')}
          </div></div>`);
        $$('#modal [data-t]').forEach(b => b.onclick = async () => {
          try { await api('POST', `/api/pos/orders/${o.id}/transfer`, { table_id: Number(b.dataset.t) });
            closeModal(); toast('Masa değiştirildi', 'ok'); this.drawBill(); } catch (e) { err(e); }
        });
      } else if (action === 'split') {
        modal(`
          <div class="modal__head"><h3>Adisyon böl</h3></div>
          <div class="modal__body">
            <p class="muted" style="margin-top:0">Yeni adisyona taşınacak ürünleri seçin.</p>
            ${o.items.map(i => `<label class="row" style="padding:8px 0;border-bottom:1px solid var(--line)">
              <input type="checkbox" data-si="${i.id}" style="width:20px;height:20px">
              <span style="flex:1">${esc(i.product_name)}</span>
              <input class="input" style="width:70px;height:34px" type="number" min="1" max="${Number(i.qty)}" value="${Number(i.qty)}" data-sq="${i.id}">
              <span class="mono">${tl(i.line_total)}</span></label>`).join('')}
          </div>
          <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
            <button class="btn btn--primary" id="spOk">Böl</button></div>`);
        $('#spOk').onclick = async () => {
          const lines = $$('#modal [data-si]').filter(c => c.checked)
            .map(c => ({ itemId: Number(c.dataset.si), qty: Number($(`[data-sq="${c.dataset.si}"]`).value) }));
          if (!lines.length) return toast('Ürün seçilmedi');
          try { const r = await api('POST', `/api/pos/orders/${o.id}/split`, { lines });
            closeModal(); toast('Yeni adisyon açıldı', 'ok'); go('order', r.order_id); } catch (e) { err(e); }
        };
      } else if (action === 'merge') {
        const open = (await api('GET', '/api/pos/orders/open')).orders.filter(x => x.id !== o.id);
        modal(`
          <div class="modal__head"><h3>Bu adisyona birleştir</h3></div>
          <div class="modal__body">${open.length ? open.map(b => `
            <button class="btn btn--ghost btn--wide" style="margin-bottom:8px;justify-content:space-between" data-o="${b.id}">
              <span>#${b.adisyon_no} · ${esc(b.table_name || 'Hızlı satış')}</span><b>${tl(b.grand_total)} ₺</b></button>`).join('')
            : '<div class="empty">Başka açık adisyon yok.</div>'}</div>`);
        $$('#modal [data-o]').forEach(b => b.onclick = async () => {
          try { await api('POST', `/api/pos/orders/${o.id}/merge`, { source_order_id: Number(b.dataset.o) });
            closeModal(); toast('Adisyonlar birleştirildi', 'ok'); this.drawBill(); } catch (e) { err(e); }
        });
      } else if (action === 'mail') {
        const email = await this.askText('Hesabı e-posta ile gönder', 'misafir@ornek.com');
        if (!email) return;
        await api('POST', `/api/pos/orders/${o.id}/mail`, { email });
        toast('Hesap e-posta kuyruğuna alındı', 'ok');
      } else if (action === 'loyalty') {
        this.loyaltyDialog(o);
      } else if (action === 'drawer') {
        await api('POST', '/api/pos/drawer'); toast('Çekmece açıldı', 'ok');
      } else if (action === 'cancel') {
        /*
         * On the floor a bill is CANCELLED, not destroyed.
         *
         * The waiter who opened masa 4 by mistake wants it off the table and
         * out of the takings; he is not the person who decides that a sale
         * never happened and its record should stop existing. That decision
         * lives in Raporlar -> Islemler, with the owner, where it can be seen
         * next to the day it belongs to. So this leaves the bill in the books
         * as "iptal edildi" and reversible, and the permanent delete is a
         * separate act in a separate place.
         */
        const approved = can('order.delete') ? null : await askOverride('order.delete', 'Adisyon iptali için yetkili onayı gerekli.');
        const reason = await this.askText('İptal sebebi', 'Yanlış açıldı',
          'Zorunlu. Adisyon iptal edilir, raporlardan ve tahsilattan çıkar. Kaydı durur, gerekirse geri alınır.');
        if (reason === null || !reason.trim()) return;
        await api('DELETE', `/api/pos/orders/${o.id}`, { reason, approved_by: approved });
        toast('Adisyon iptal edildi', 'ok'); go('tables');
      }
    } catch (e) { err(e); }
  },

  /* ------------------------------------------------------- sadakat */

  /**
   * The guest strip above the bill. Two states only: nobody attached, or a
   * guest with their cards. A cashier at a queue should be able to read this
   * in a glance and press one thing.
   */
  /**
   * The other bills on this table, as tabs.
   *
   * Going back to Masalar to switch between "masa 4 A" and "masa 4 B" is three
   * taps for something that happens constantly while a table is being settled.
   * The strip only appears when there IS something to switch to, so a normal
   * single-bill table looks exactly as it did.
   */
  async drawBillTabs(o) {
    const strip = $('#billTabs');
    if (!strip || !o.table_id || o.status !== 'open') return;
    let bills = [];
    try {
      bills = (await api('GET', '/api/pos/orders/open')).orders
        .filter(b => Number(b.table_id) === Number(o.table_id));
    } catch (e) { return; }
    if (bills.length < 2) { strip.hidden = true; return; }
    strip.hidden = false;
    strip.innerHTML = bills.map(b => `
      <button class="bill-tab${Number(b.id) === Number(o.id) ? ' is-active' : ''}" data-b="${b.id}">
        ${b.bill_label ? esc(b.bill_label) : '#' + b.adisyon_no}
        <span class="mono">${tl(b.grand_total)}</span>
      </button>`).join('') +
      `<button class="bill-tab bill-tab--add" id="btAdd" title="Bu masaya yeni adisyon">+</button>`;
    $$('#billTabs [data-b]').forEach(b => b.onclick = () => {
      const id = Number(b.dataset.b);
      if (id !== Number(o.id)) go('order', id);
    });
    $('#btAdd').onclick = async () => {
      try {
        const n = await api('POST', '/api/pos/orders', { table_id: o.table_id });
        go('order', n.order_id);
      } catch (e) { err(e); }
    };
  },

  async drawLoyalty(order) {
    const el = $('#loyalStrip');
    if (!el) return;
    if (!order.customer_id) {
      el.innerHTML = `<button class="loyal__ask" id="loyAsk">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
          <rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM19 14h2M14 19h3M19 19h2"/></svg>
        Sadakat kartı var mı? — okut veya telefonla ara</button>`;
      $('#loyAsk').onclick = () => this.loyaltyDialog(order);
      return;
    }
    let data = { customer: null, cards: [] };
    try {
      const c = await api('GET', `/api/manage/customers?q=`);
      data.cards = (await api('GET', `/api/pos/loyalty/customers/${order.customer_id}/cards`)).cards;
      data.customer = (c.customers || []).find(x => x.id === order.customer_id) || null;
    } catch (_) {}
    const name = data.customer
      ? `${data.customer.first_name || ''} ${data.customer.last_name || ''}`.trim()
      : 'Müşteri #' + order.customer_id;
    el.innerHTML = `
      <div class="loyal__who">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--orange)" stroke-width="1.7">
          <circle cx="12" cy="8" r="3.2"/><path d="M5 20a7 7 0 0114 0"/></svg>
        <span class="loyal__name">${esc(name)}</span>
        <span class="loyal__phone">${esc(data.customer ? (data.customer.phone || '') : '')}</span>
        <div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="loyMore">Kart</button>
      </div>
      <div class="loyal__cards">
        ${data.cards.length ? data.cards.map(c => `
          <div class="loyal__card${c.rewards_available > 0 ? ' is-ready' : ''}">
            <span class="loyal__title">${esc(c.title)}</span>
            ${c.rewards_available > 0
              ? `<button class="btn btn--primary btn--sm" data-redeem="${c.card_id}">Ödül kullan (${c.rewards_available})</button>`
              : `<span class="loyal__bar"><i style="width:${Math.round(c.progress_count / c.target_count * 100)}%"></i></span>
                 <span class="loyal__count">${c.progress_count}/${c.target_count}</span>`}
          </div>`).join('')
          : '<div class="muted" style="font-size:12.5px">Bu müşterinin kartı yok.</div>'}
      </div>`;
    $('#loyMore').onclick = () => this.loyaltyCard(order, order.customer_id, name);
    $$('#loyalStrip [data-redeem]').forEach(b => b.onclick = () => this.redeem(order, order.customer_id, Number(b.dataset.redeem)));
  },

  /** Scan, type a phone, or enrol. One box, because a queue is not the place
   *  to choose between three buttons. Handheld QR scanners just type + Enter. */
  loyaltyDialog(order) {
    modal(`
      <div class="modal__head"><h3>Sadakat</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div class="field">
          <label>QR okutun veya telefon numarası yazın</label>
          <input class="input" id="loyIn" placeholder="5XX XXX XX XX" autocomplete="off"
                 style="font-size:19px;height:56px;letter-spacing:.5px">
        </div>
        <div id="loyAlert"></div>
        <div class="row"><div class="spacer"></div>
          <button class="btn btn--ghost" id="loyNew">Yeni müşteri kaydet</button>
          <button class="btn btn--primary" id="loyGo">Devam</button></div>
        <p class="muted" style="font-size:12px;margin-bottom:0">
          Adisyondaki ürünler kadar damga verilir. 3 kahve alan müşteri 3 damga alır.</p>
      </div>`);
    const run = async () => {
      const v = $('#loyIn').value.trim();
      if (!v) return;
      $('#loyGo').disabled = true;
      try {
        const r = await api('POST', `/api/pos/orders/${order.id}/loyalty/scan`, { token: v });
        closeModal();
        const gained = r.lines.reduce((s, l) => s + l.added, 0);
        const earned = r.lines.reduce((s, l) => s + l.earned, 0);
        toast(`${esc(r.customer.first_name || 'Müşteri')} · ${gained} damga` +
              (earned ? ` · ${earned} ÖDÜL KAZANDI` : ''), 'ok');
        this.drawBill(true);
      } catch (e) {
        $('#loyGo').disabled = false;
        $('#loyAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`;
      }
    };
    $('#loyGo').onclick = run;
    $('#loyIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    $('#loyNew').onclick = () => this.enrolDialog(order, $('#loyIn').value.trim());
  },

  enrolDialog(order, phone) {
    modal(`
      <div class="modal__head"><h3>Yeni sadakat müşterisi</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div class="split-2">
          <div class="field"><label>Ad</label><input class="input" id="enF"></div>
          <div class="field"><label>Soyad</label><input class="input" id="enL"></div>
        </div>
        <div class="split-2">
          <div class="field"><label>Telefon</label><input class="input" id="enP" value="${esc(phone || '')}" placeholder="5XX XXX XX XX"></div>
          <div class="field"><label>E-posta (isteğe bağlı)</label><input class="input" id="enE"></div>
        </div>
        <div id="enAlert"></div>
        <p class="muted" style="font-size:12px">Kayıt merkezi sistemde açılır; müşteri aynı kartı diğer NOKTApp
          işletmelerinde de kullanır. Bu adım için internet gerekir.</p>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="enOk">Kaydet ve damga ver</button></div>`);
    $('#enOk').onclick = async () => {
      try {
        const c = await api('POST', '/api/pos/loyalty/enrol', {
          first_name: $('#enF').value, last_name: $('#enL').value,
          phone: $('#enP').value, email: $('#enE').value });
        const r = await api('POST', `/api/pos/orders/${order.id}/loyalty/scan`, { token: c.customer.phone });
        closeModal();
        toast(`${esc(c.customer.first_name)} kaydedildi · ${r.lines.reduce((s, l) => s + l.added, 0)} damga`, 'ok');
        this.drawBill(true);
      } catch (e) { $('#enAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /** The card itself, drawn as stamps, because that is what the guest sees. */
  async loyaltyCard(order, customerId, name) {
    const r = await api('GET', `/api/pos/loyalty/customers/${customerId}/cards`);
    modal(`
      <div class="modal__head"><h3>${esc(name)}</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        ${r.cards.length ? r.cards.map(c => `
          <div class="card" style="margin-bottom:12px"><div class="card__body">
            <div class="row"><b>${esc(c.title)}</b><div class="spacer"></div>
              ${c.rewards_available > 0
                ? `<button class="btn btn--primary btn--sm" data-redeem="${c.card_id}">Ödül kullan (${c.rewards_available})</button>`
                : `<span class="muted">${c.remaining} tane kaldı</span>`}</div>
            <div class="stamps">
              ${Array.from({ length: c.target_count }, (_, i) =>
                `<span class="stamp${i < c.progress_count ? ' is-on' : ''}"></span>`).join('')}
            </div>
            <div class="muted" style="font-size:12.5px">${esc(c.reward_text || '')}
              ${c.rewards_used ? ` · bugüne kadar ${c.rewards_used} ödül kullandı` : ''}</div>
          </div></div>`).join('')
          : '<div class="empty">Bu müşterinin kartı yok.</div>'}
      </div>`);
    $$('#modal [data-redeem]').forEach(b => b.onclick = () => {
      closeModal(); this.redeem(order, customerId, Number(b.dataset.redeem));
    });
  },

  async redeem(order, customerId, cardId) {
    const okGo = await confirmBox('Ödülü kullan',
      'Ödül kullanılacak ve hediye ürünün tutarı adisyondan düşülecek. Devam edilsin mi?');
    if (!okGo) return;
    try {
      const r = await api('POST', '/api/pos/loyalty/redeem', {
        customer_id: customerId, card_id: cardId, order_id: order.id });
      toast(r.discount > 0
        ? `Ödül kullanıldı · ${tl(r.discount)} ₺ adisyondan düşüldü`
        : 'Ödül kullanıldı', 'ok');
      this.drawBill(true);
    } catch (e) { err(e); }
  },

  customerPicker(onPick) {
    modal(`
      <div class="modal__head"><h3>Müşteri seç</h3></div>
      <div class="modal__body">
        <div class="field"><input class="input" id="cpQ" placeholder="isim veya telefon"></div>
        <div id="cpList"></div>
      </div>`);
    const search = async () => {
      const r = await api('GET', '/api/manage/customers?q=' + encodeURIComponent($('#cpQ').value));
      $('#cpList').innerHTML = r.customers.map(c => `
        <button class="btn btn--ghost btn--wide" style="margin-bottom:6px;justify-content:space-between" data-c="${c.id}">
          <span>${esc(c.first_name)} ${esc(c.last_name || '')}</span>
          <span class="muted">${esc(c.phone || '')}</span></button>`).join('') || '<div class="empty">Kayıt yok</div>';
      $$('#cpList [data-c]').forEach(b => b.onclick = () => {
        const c = r.customers.find(x => x.id === Number(b.dataset.c));
        closeModal(); onPick(c);
      });
    };
    $('#cpQ').oninput = () => { clearTimeout(this._cpT); this._cpT = setTimeout(search, 250); };
    search();
  },
};

/* =====================================================================
   Screens, part two: kitchen board, bill history, reports, products,
   guests and settings.
   ===================================================================== */
Object.assign(Screens, {

  /* ---------------------------------------------------------- kitchen */
  /*
   * There is exactly ONE kitchen screen, and it is not here.
   *
   * This file used to carry a second one: a board that asked for a single
   * station and showed that station's items. `screens/floor.js` grew the real
   * one - every station at once, chips to filter, an Aktif/Gecmis split, and a
   * poll that stops itself - and for a while both were registered, which is how
   * the navigation ended up offering "Mutfak" twice.
   *
   * The old one is gone. `kitchen` stays as a name so an older phone, a saved
   * link or a badge that still says "kitchen" lands somewhere sensible instead
   * of a blank page, and it forwards to the board in floor.js.
   */
  async page_kitchen() { return this.page_mutfak(); },

  /* ------------------------------------------------------------ bills */
  /**
   * Adisyonlar - open and closed, and everything you can do to one.
   *
   * This screen used to list closed bills with a single "Geri ac" button and
   * nothing else: no way to see what was on a bill, no way to print it again,
   * no way to e-mail it. Finding out what a guest had ordered meant going to
   * the finance screen and hunting. Now the row opens the bill, and the bill
   * carries its own actions.
   */
  async page_bills() {
    const today = new Date().toISOString().slice(0, 10);
    App.data.billDate = App.data.billDate || today;
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <h2 class="page-title" style="margin:0">Adisyonlar</h2>
        <div class="spacer"></div>
        <input class="input" id="blQ" placeholder="Ara: masa, garson, adisyon no…" style="width:250px;height:36px">
        <input class="input" id="blDate" type="date" value="${App.data.billDate}" style="width:150px;height:36px">
        <button class="btn btn--ghost btn--sm" id="blGo">Getir</button>
      </div>
      <div class="split-2" style="align-items:start">
        <div class="card"><div class="card__head"><h3>Açık adisyonlar</h3>
          <div class="spacer"></div><span class="muted" style="font-size:12px" id="blOpenN"></span></div>
          <div id="blOpen"></div></div>
        <div class="card"><div class="card__head"><h3>Kapanan adisyonlar</h3>
          <div class="spacer"></div><span class="muted" style="font-size:12px">satıra tıklayın</span></div>
          <div id="blClosed"></div></div>
      </div></div>`;

    $('#blGo').onclick = () => { App.data.billDate = $('#blDate').value; this.page_bills(); };
    $('#blDate').onchange = () => $('#blGo').click();

    let closedRows = [];
    const paint = () => {
      const q = ($('#blQ').value || '').toLowerCase().trim();
      const hit = o => !q || [o.adisyon_no, o.table_name, o.waiter_name, o.bill_label]
        .some(v => String(v || '').toLowerCase().includes(q));
      const rows = closedRows.filter(hit);
      $('#blClosed').innerHTML = rows.length ? `<table class="tbl"><tbody>${rows.map(o => `
        <tr class="is-click" data-bill="${o.id}" style="cursor:pointer">
          <td><b>#${o.adisyon_no}</b>${o.bill_label ? ' <span class="badge badge--gray">' + esc(o.bill_label) + '</span>' : ''}</td>
          <td>${esc(o.table_name || 'Hızlı satış')}</td>
          <td class="muted">${String(o.closed_at || '').slice(11, 16)}</td>
          <td class="right mono">${tl(o.grand_total)} ₺</td>
          <td class="right">${o.reopen_count > 0 ? '<span class="badge badge--gray">tekrar açıldı</span>' : ''}</td>
        </tr>`).join('')}</tbody></table>`
        : `<div class="empty">${q ? 'Aramaya uyan adisyon yok.' : 'Bu günde kapanan adisyon yok.'}</div>`;
      $$('#blClosed [data-bill]').forEach(tr =>
        tr.onclick = () => this.billDialog(Number(tr.dataset.bill)));
    };
    $('#blQ').oninput = paint;

    try {
      const open = await api('GET', '/api/pos/orders/open');
      $('#blOpenN').textContent = open.orders.length + ' adisyon';
      $('#blOpen').innerHTML = open.orders.length ? `<table class="tbl"><tbody>${open.orders.map(o => `
        <tr><td><b>#${o.adisyon_no}</b>${o.bill_label ? ' <span class="badge badge--gray">' + esc(o.bill_label) + '</span>' : ''}</td>
        <td>${esc(o.table_name || 'Hızlı satış')}</td>
        <td class="muted">${esc(o.waiter_name || '')}</td><td class="right mono">${tl(o.grand_total)} ₺</td>
        <td class="right"><button class="btn btn--ghost btn--sm" data-open="${o.id}">Aç</button></td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Açık adisyon yok.</div>';
      $$('#blOpen [data-open]').forEach(b => b.onclick = () => go('order', Number(b.dataset.open)));

      const closed = await api('GET', `/api/pos/orders/recent-closed?date=${App.data.billDate}`);
      closedRows = closed.orders;
      paint();
    } catch (e) { err(e); }
  },

  /** One closed bill: what was on it, and everything you can do with it. */
  async billDialog(orderId) {
    let o;
    try { o = (await api('GET', `/api/pos/orders/${orderId}`)).order; }
    catch (e) { return err(e); }

    const vat = {};
    for (const i of o.items) {
      const k = Number(i.vat_rate || 0);
      if (k > 0) vat[k] = (vat[k] || 0) + Number(i.line_total) * k / (100 + k);
    }
    /*
     * Only the business owner may delete a bill. `App.user` is null when the
     * tenant is signed in on the licence rather than as a staff member - that
     * IS the owner - and `superadmin` is the owner's own staff identity.
     * A manager with role 'admin' deliberately does not qualify.
     */
    const isOwner = !App.user || App.user.role === 'superadmin';

    modal(`
      <div class="modal__head"><h3>Adisyon #${o.adisyon_no}${o.bill_label ? ' · ' + esc(o.bill_label) : ''}</h3>
        <div class="spacer"></div><button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div class="split-4" style="margin-bottom:14px">
          <div class="stat"><div class="stat__label">Masa</div><div class="stat__value" style="font-size:19px">${esc(o.table_name || 'Hızlı satış')}</div></div>
          <div class="stat"><div class="stat__label">Garson</div><div class="stat__value" style="font-size:19px">${esc(o.waiter_name || '—')}</div></div>
          <div class="stat"><div class="stat__label">Kapanış</div><div class="stat__value" style="font-size:19px">${String(o.closed_at || '').slice(11, 16) || '—'}</div></div>
          <div class="stat"><div class="stat__label">Toplam</div><div class="stat__value" style="font-size:19px">${tl(o.grand_total)} ₺</div></div>
        </div>

        <table class="tbl"><thead><tr>
          <th>Ürün</th><th class="right">Adet</th><th class="right">Birim</th><th class="right">Tutar</th>
        </tr></thead><tbody>
          ${o.items.map(i => `<tr>
            <td>${esc(i.product_name)}${i.note ? `<div class="muted" style="font-size:12px">${esc(i.note)}</div>` : ''}</td>
            <td class="right mono">${Number(i.qty)}</td>
            <td class="right mono">${tl(i.unit_price)}</td>
            <td class="right mono">${tl(i.line_total)}</td></tr>`).join('')}
        </tbody></table>

        <table class="tbl" style="margin-top:10px"><tbody>
          <tr><td>Ara toplam</td><td class="right mono">${tl(o.total)} ₺</td></tr>
          ${Number(o.discount_total) > 0 ? `<tr><td>İndirim</td><td class="right mono">-${tl(o.discount_total)} ₺</td></tr>` : ''}
          ${Object.keys(vat).sort().map(k => `<tr><td class="muted">KDV %${k} (dahil)</td>
            <td class="right mono muted">${tl(vat[k])} ₺</td></tr>`).join('')}
          <tr><td><b>Genel toplam</b></td><td class="right mono"><b>${tl(o.grand_total)} ₺</b></td></tr>
          ${(o.payments || []).map(p => `<tr><td class="muted">${esc(p.method)}</td>
            <td class="right mono muted">${tl(p.amount)} ₺</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="modal__foot" style="flex-wrap:wrap;gap:8px">
        <button class="btn btn--ghost" id="bdPrint">Fiş yazdır</button>
        <button class="btn btn--ghost" id="bdMail">E-posta gönder</button>
        ${o.status === 'closed' ? '<button class="btn btn--ghost" id="bdReopen">Masaya geri aç</button>' : ''}
        <div class="spacer"></div>
        ${isOwner ? '<button class="btn btn--danger" id="bdDelete">Adisyonu iptal et</button>' : ''}
      </div>`);

    $('#bdPrint').onclick = async () => {
      try { await api('POST', `/api/pos/orders/${o.id}/print`); toast('Fiş yazıcıya gönderildi', 'ok'); }
      catch (e) { err(e); }
    };
    $('#bdMail').onclick = async () => {
      const to = await this.askText('E-posta adresi', 'misafir@ornek.com');
      if (!to) return;
      try { await api('POST', `/api/pos/orders/${o.id}/mail`, { email: to }); toast('Adisyon gönderildi', 'ok'); }
      catch (e) { err(e); }
    };
    if ($('#bdReopen')) $('#bdReopen').onclick = async () => {
      const okGo = await confirmBox('Adisyonu geri aç',
        `Adisyon ${o.table_name ? esc(o.table_name) + ' masasına' : ''} geri açılacak. Devam edilsin mi?`);
      if (!okGo) return;
      const approved = can('order.reopen') ? null : await askOverride('order.reopen');
      try {
        await api('POST', `/api/pos/orders/${o.id}/reopen`, { reason: 'Yeniden açıldı', approved_by: approved });
        closeModal(); toast('Adisyon masaya geri açıldı', 'ok'); go('order', o.id);
      } catch (e) { err(e); }
    };
    /*
     * Deleting a bill is the owner's alone - a manager should not be able to
     * take money off the books - and the reason is mandatory, because a delete
     * with no reason is indistinguishable from a theft.
     */
    if ($('#bdDelete')) $('#bdDelete').onclick = async () => {
      const reason = await this.askText('İptal sebebi', 'Yanlış adisyon',
        'Zorunlu. İptal edilen adisyon kayıtta kalır, raporlardan çıkar. '
        + 'Kalıcı silme Raporlar → İşlemler ekranındadır.');
      if (!reason || !reason.trim()) return toast('Sebep girmeden iptal edilemez', 'error');
      try {
        await api('DELETE', `/api/pos/orders/${o.id}`, { reason });
        closeModal(); toast('Adisyon iptal edildi', 'ok'); this.page_bills();
      } catch (e) { err(e); }
    };
  },

  async page_reports() {
    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Raporlar</h2><div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="rpX">X raporu yazdır</button>
        <button class="btn btn--dark btn--sm" id="rpClose">Gün sonu</button>
      </div>
      <div class="split-4" id="rpStats"></div>
      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Z raporu (bugün)</h3><div class="spacer"></div>
          <button class="btn btn--ghost btn--sm" id="rpPrintZ">Yazdır</button></div>
        <div class="card__body" id="rpZ"></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Dönem raporları</h3><div class="spacer"></div>
          <input class="input" id="rpFrom" type="date" value="${monthAgo}" style="width:150px;height:36px">
          <input class="input" id="rpTo" type="date" value="${today}" style="width:150px;height:36px">
          <select class="input" id="rpKind" style="width:180px;height:36px">
            <option value="sales">Günlük satış</option>
            <option value="products">Ürün satışları</option>
            <option value="waiters">Garson performansı</option>
          </select>
          <button class="btn btn--ghost btn--sm" id="rpRun">Getir</button>
          <button class="btn btn--ghost btn--sm" id="rpCsv">CSV</button>
          <button class="btn btn--ghost btn--sm" id="rpPdf">PDF</button></div>
        <div id="rpRange"></div>
      </div></div>`;

    try {
      const d = await api('GET', '/api/reports/dashboard');
      $('#rpStats').innerHTML = `
        <div class="stat"><div class="stat__label">Bugünkü ciro</div><div class="stat__value">${tl(d.total)} ₺</div>
          <div class="stat__sub">${d.orders} adisyon</div></div>
        <div class="stat"><div class="stat__label">Ortalama adisyon</div><div class="stat__value">${tl(d.average)} ₺</div>
          <div class="stat__sub">indirim ${tl(d.discount)} ₺</div></div>
        <div class="stat"><div class="stat__label">Açık adisyon</div><div class="stat__value">${d.open_bills}</div>
          <div class="stat__sub">${tl(d.open_total)} ₺ masada</div></div>
        <div class="stat"><div class="stat__label">KDV</div><div class="stat__value">${tl(d.vat)} ₺</div>
          <div class="stat__sub">${d.by_method.map(m => label(m.method) + ' ' + tl(m.total)).join(' · ') || '—'}</div></div>`;

      const z = (await api('GET', '/api/reports/z')).report;
      $('#rpZ').innerHTML = `
        <div class="split-2">
          <table class="tbl">
            <tr><td>Brüt satış</td><td class="right mono">${tl(z.gross)} ₺</td></tr>
            <tr><td>İndirim</td><td class="right mono">-${tl(z.discount)} ₺</td></tr>
            <tr><td><b>Net satış</b></td><td class="right mono"><b>${tl(z.net)} ₺</b></td></tr>
            <tr><td>Maliyet</td><td class="right mono">${tl(z.cost_of_goods)} ₺</td></tr>
            <tr><td>Diğer gider</td><td class="right mono">${tl(z.extra_costs)} ₺</td></tr>
            <tr><td><b>Kâr</b></td><td class="right mono"><b>${tl(z.profit)} ₺</b> (%${tl(z.margin)})</td></tr>
          </table>
          <table class="tbl">
            <tr><th colspan="3">KDV dökümü</th></tr>
            ${z.vat_breakdown.map(v => `<tr><td>%${v.rate}</td><td class="right mono">matrah ${tl(v.base)}</td>
              <td class="right mono">${tl(v.vat)} ₺</td></tr>`).join('')}
            <tr><th colspan="3">Ödemeler</th></tr>
            ${z.payments.map(p => `<tr><td>${esc(label(p.method))}</td><td class="right mono">${p.count} işlem</td>
              <td class="right mono">${tl(p.total)} ₺</td></tr>`).join('')}
            <tr><td>İptal edilen satır</td><td class="right mono">${z.cancelled_items.count}</td>
              <td class="right mono">${tl(z.cancelled_items.total)} ₺</td></tr>
            <tr><td>Silinen adisyon</td><td class="right mono">${z.deleted_bills.count}</td>
              <td class="right mono">${tl(z.deleted_bills.total)} ₺</td></tr>
          </table>
        </div>`;

      $('#rpPrintZ').onclick = async () => { await api('POST', '/api/reports/z/print', { kind: 'Z' }); toast('Z raporu yazdırıldı', 'ok'); };
      $('#rpX').onclick = async () => { await api('POST', '/api/reports/z/print', { kind: 'X' }); toast('X raporu yazdırıldı', 'ok'); };
      $('#rpClose').onclick = () => this.closeDayDialog(z);
      const run = async () => {
        const q = `from=${$('#rpFrom').value}&to=${$('#rpTo').value}`;
        const r = await api('GET', `/api/reports/${$('#rpKind').value}?${q}`);
        const rows = r.rows;
        // whole numbers stay whole (7 adisyon, not 7,00) and money gets its symbol
        const counts = ['orders', 'qty', 'count', 'id'];
        const cell = (k, v) => {
          if (v === null || v === undefined) return '';
          const n = Number(v);
          if (!Number.isFinite(n) || typeof v === 'string' && !/^-?[\d.,]+$/.test(v)) return esc(v);
          return counts.includes(k) ? String(Math.round(n)) : tl(n) + ' ₺';
        };
        const numeric = (k, v) => Number.isFinite(Number(v)) && !(typeof v === 'string' && !/^-?[\d.,]+$/.test(v));
        $('#rpRange').innerHTML = rows.length ? `<table class="tbl"><thead><tr>${
          Object.keys(rows[0]).map(k => `<th class="${numeric(k, rows[0][k]) ? 'right' : ''}">${esc(COLUMN_LABEL[k] || k)}</th>`).join('')
          }</tr></thead><tbody>${
          rows.map(x => `<tr>${Object.entries(x).map(([k, v]) =>
            `<td class="${numeric(k, v) ? 'right mono' : ''}">${cell(k, v)}</td>`).join('')}</tr>`).join('')
          }</tbody></table>` : '<div class="empty">Bu aralıkta kayıt yok.</div>';
      };
      $('#rpRun').onclick = run;
      const rpExport = (fmt, e) => this.download(
        `/api/reports/export/${$('#rpKind').value}?from=${$('#rpFrom').value}&to=${$('#rpTo').value}`
        + (fmt === 'pdf' ? '&format=pdf' : ''), e.currentTarget);
      $('#rpCsv').onclick = (e) => rpExport('csv', e);
      $('#rpPdf').onclick = (e) => rpExport('pdf', e);
      run();
    } catch (e) { err(e); }
  },

  closeDayDialog(z) {
    modal(`
      <div class="modal__head"><h3>Gün sonu</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div class="alert alert--info">Gün sonu alındıktan sonra o güne yeni adisyon açılamaz ve kapanan adisyonlar geri açılamaz.</div>
        <div class="split-2">
          <div class="field"><label>Sayılan nakit</label><input class="input" id="cdCash" type="number" step="0.01"
            value="${(z.payments.find(p => p.method === 'nakit') || { total: 0 }).total.toFixed(2)}"></div>
          <div class="field"><label>Kart toplamı (POS ekstresi)</label><input class="input" id="cdCard" type="number" step="0.01"
            value="${z.payments.filter(p => p.method !== 'nakit').reduce((a, p) => a + p.total, 0).toFixed(2)}"></div>
        </div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--dark" id="cdOk">Gün sonunu al</button></div>`);
    $('#cdOk').onclick = async () => {
      try {
        const r = await api('POST', '/api/reports/close-day', {
          declared_cash: Number($('#cdCash').value), declared_card: Number($('#cdCard').value) });
        closeModal();
        toast('Gün sonu alındı. Kasa farkı: ' + tl(Number($('#cdCash').value) - r.report.expected_cash) + ' ₺', 'ok');
        refreshHeader(); this.page_reports();
      } catch (e) { err(e); }
    };
  },

  /* --------------------------------------------------------- products */
  /* ------------------------------------------------------ kar / zarar */
  /*
   * Save a file from an authorised endpoint.
   *
   * This used to be `window.open(path + '&token=' + App.token)`, and it was
   * wrong twice over. The token went out on the QUERY STRING - into the
   * address bar, the browser history and every access log on the way - and
   * nothing was ever saved: a window opened at a text/csv URL just renders
   * it, so pressing CSV appeared to do nothing at all.
   *
   * So the file is fetched with the same Authorization header as every other
   * call, read as a Blob and saved through a temporary <a download>. This runs
   * in Electron, where a blob download is a normal save; it is only sandboxed
   * artifacts that block one.
   *
   * `btn` is the button that was pressed. It is disabled for the duration,
   * because a report over a long range takes seconds and a second tap in that
   * gap runs the whole query again and saves the file twice.
   */
  /**
   * What to call the saved file.
   *
   * The server already names it in Content-Disposition, and that name carries
   * the report and its date range ("gun-sonu-2026-08-01_2026-08-31.csv"). Only
   * when the header is missing does the URL have to be guessed at, and a
   * folder full of "export.csv" is exactly what an accountant cannot work in.
   */
  downloadName(res, path) {
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (m) return decodeURIComponent(m[1]);
    const kind = (path.split('?')[0].split('/').filter(Boolean).pop() || 'rapor');
    const fmt = (path.match(/[?&]format=(\w+)/) || [])[1] || 'csv';
    return `${kind}.${fmt}`;
  },

  async download(path, btn) {
    const el = btn && btn.nodeType === 1 ? btn : null;
    if (el && el.disabled) return;
    const was = el ? el.textContent : '';
    if (el) { el.disabled = true; el.textContent = 'Hazırlanıyor…'; }
    try {
      const res = await fetch(path, {
        headers: App.token ? { Authorization: 'Bearer ' + App.token } : {},
      });
      if (res.status === 401) { lock(); throw new Error('Oturum sona erdi'); }
      if (!res.ok) {
        // the server answers JSON on failure; a blank window told the owner
        // nothing, so whatever it said is what the toast says
        let msg = 'Dosya indirilemedi';
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.downloadName(res, path);
      document.body.appendChild(a);
      a.click();
      a.remove();
      /* Revoked, but not in the same tick: the save is started by the click
         and reads the blob afterwards, so freeing it immediately cancels the
         download on some builds. */
      setTimeout(() => URL.revokeObjectURL(url), 20000);
    } catch (e) { err(e); }
    finally { if (el) { el.disabled = false; el.textContent = was; } }
  },

  /**
   * Profit and loss.
   *
   * Built around one question an owner actually asks: did we make money, and
   * on what. So the headline is net profit, the waterfall underneath shows
   * where the money went, and the product table is sorted by total
   * contribution - not by margin percentage, which flatters the dish sold
   * twice a week and buries the one paying the rent.
   */
  async page_pnl() {
    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    const from = App.data.pnlFrom || monthAgo;
    const to = App.data.pnlTo || today;
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <h2 class="page-title" style="margin:0">Kâr / Zarar</h2><div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" data-q="today">Bugün</button>
        <button class="btn btn--ghost btn--sm" data-q="week">Son 7 gün</button>
        <button class="btn btn--ghost btn--sm" data-q="month">Son 30 gün</button>
        <input class="input" id="plFrom" type="date" value="${from}" style="width:150px;height:36px">
        <input class="input" id="plTo" type="date" value="${to}" style="width:150px;height:36px">
        <button class="btn btn--primary btn--sm" id="plRun">Getir</button>
        <button class="btn btn--ghost btn--sm" id="plCsv">CSV</button>
        <button class="btn btn--ghost btn--sm" id="plPdf">PDF</button>
      </div>
      <div id="plBody"><div class="empty">Hesaplanıyor…</div></div></div>`;

    const setRange = (f, t) => { App.data.pnlFrom = f; App.data.pnlTo = t; this.page_pnl(); };
    $$('#main [data-q]').forEach(b => b.onclick = () => {
      const d = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
      if (b.dataset.q === 'today') setRange(today, today);
      else if (b.dataset.q === 'week') setRange(d(6), today);
      else setRange(d(29), today);
    });
    $('#plRun').onclick = () => setRange($('#plFrom').value, $('#plTo').value);
    $('#plCsv').onclick = (e) => this.download(`/api/reports/export/pnl?from=${from}&to=${to}`, e.currentTarget);
    $('#plPdf').onclick = (e) => this.download(`/api/reports/export/pnl?from=${from}&to=${to}&format=pdf`, e.currentTarget);

    let r;
    try { r = await api('GET', `/api/reports/pnl?from=${from}&to=${to}`); }
    catch (e) { $('#plBody').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; return; }
    const T = r.totals;

    const line = (label, val, kind) => `
      <div class="pl-line${kind ? ' pl-line--' + kind : ''}">
        <span>${label}</span><span class="mono">${tl(val)} ₺</span></div>`;

    $('#plBody').innerHTML = `
      <div class="split-4">
        <div class="stat"><div class="stat__label">Net kâr</div>
          <div class="stat__value ${T.net_profit < 0 ? 'is-loss' : 'is-profit'}">${tl(T.net_profit)} ₺</div>
          <div class="stat__sub">kâr marjı %${tl(T.net_margin)}</div></div>
        <div class="stat"><div class="stat__label">Ciro (KDV hariç)</div>
          <div class="stat__value">${tl(T.revenue_net)} ₺</div>
          <div class="stat__sub">KDV dahil ${tl(T.revenue_gross)} ₺</div></div>
        <div class="stat"><div class="stat__label">Ürün maliyeti</div>
          <div class="stat__value">${tl(T.cogs)} ₺</div>
          <div class="stat__sub">brüt kâr ${tl(T.gross_profit)} ₺ (%${tl(T.gross_margin)})</div></div>
        <div class="stat"><div class="stat__label">Adisyon</div>
          <div class="stat__value">${T.orders}</div>
          <div class="stat__sub">ortalama ${tl(T.average_ticket)} ₺</div></div>
      </div>

      ${r.uncosted.products.length ? `
        <div class="alert alert--warn" style="margin-top:14px">
          <b>${r.uncosted.products.length} ürünün maliyeti girilmemiş.</b>
          Bu ürünler ${tl(r.uncosted.revenue)} ₺ ciro yaptı (cironun %${tl(r.uncosted.share_of_revenue)}'i)
          ve maliyetsiz oldukları için kâr olduğundan yüksek görünüyor.
          <button class="btn btn--ghost btn--sm" id="plUncosted" style="margin-left:8px">Listeyi gör</button>
        </div>` : ''}

      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Dönem özeti</h3></div>
        <div class="card__body">
          ${line('Ciro (KDV dahil)', T.revenue_gross)}
          ${T.discounts > 0 ? line('İndirimler (ciroya dahil değil)', -T.discounts, 'muted') : ''}
          ${line('KDV', -T.vat, 'muted')}
          ${line('Ciro (KDV hariç)', T.revenue_net, 'sub')}
          ${line('Ürün maliyeti (SMM)', -T.cogs)}
          ${line('BRÜT KÂR', T.gross_profit, 'sub')}
          ${line('Giderler', -T.expenses)}
          ${line('NET KÂR', T.net_profit, T.net_profit < 0 ? 'loss' : 'grand')}
          ${T.cancelled_amount > 0 ? line(`İptal edilen ${T.cancelled_orders} adisyon (rapora dahil değil)`, T.cancelled_amount, 'muted') : ''}
        </div>
      </div>

      <div class="split-2" style="margin-top:14px;align-items:start">
        <div class="card">
          <div class="card__head"><h3>Giderler</h3></div>
          <div class="card__body">
            ${r.expenses_by_category.length ? `<table class="tbl"><thead><tr>
                <th>Kalem</th><th class="right">Tutar</th><th class="right">Pay</th></tr></thead><tbody>
              ${r.expenses_by_category.map(e => `<tr><td>${esc(e.category)}</td>
                <td class="right mono">${tl(e.total)} ₺</td>
                <td class="right mono">%${tl(e.share)}</td></tr>`).join('')}
            </tbody></table>` : '<div class="empty">Bu dönemde gider girilmemiş.</div>'}
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>Kategori kârlılığı</h3></div>
          <div class="card__body">
            ${r.categories.length ? `<table class="tbl"><thead><tr>
                <th>Kategori</th><th class="right">Ciro</th><th class="right">Kâr</th><th class="right">Marj</th>
              </tr></thead><tbody>
              ${r.categories.map(c => `<tr><td>${esc(c.category)}</td>
                <td class="right mono">${tl(c.revenue_net)} ₺</td>
                <td class="right mono ${c.profit < 0 ? 'is-loss' : ''}">${tl(c.profit)} ₺</td>
                <td class="right mono">%${tl(c.margin)}</td></tr>`).join('')}
            </tbody></table>` : '<div class="empty">Satış yok.</div>'}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Ürün kârlılığı</h3>
          <div class="spacer"></div>
          <span class="muted" style="font-size:12px">toplam kâra katkıya göre sıralı</span>
          <button class="btn btn--ghost btn--sm" id="plPCsv">CSV</button>
          <button class="btn btn--ghost btn--sm" id="plPPdf">PDF</button></div>
        <div class="card__body">
          ${r.products.length ? `<table class="tbl"><thead><tr>
              <th>Ürün</th><th>Kategori</th><th class="right">Adet</th>
              <th class="right">Ciro (hariç)</th><th class="right">Maliyet</th>
              <th class="right">Kâr</th><th class="right">Marj</th></tr></thead><tbody>
            ${r.products.map(p => `<tr>
              <td>${esc(p.name)}${p.costed ? '' : ' <span class="badge badge--gray">maliyet yok</span>'}</td>
              <td class="muted">${esc(p.category)}</td>
              <td class="right mono">${p.qty}</td>
              <td class="right mono">${tl(p.revenue_net)} ₺</td>
              <td class="right mono">${tl(p.cogs)} ₺</td>
              <td class="right mono ${p.profit < 0 ? 'is-loss' : ''}">${tl(p.profit)} ₺</td>
              <td class="right mono">%${tl(p.margin)}</td></tr>`).join('')}
          </tbody></table>` : '<div class="empty">Bu dönemde satış yok.</div>'}
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Gün gün</h3></div>
        <div class="card__body">
          ${r.rows.length ? `<table class="tbl"><thead><tr>
              <th>Gün</th><th class="right">Adisyon</th><th class="right">Ciro</th>
              <th class="right">Maliyet</th><th class="right">Gider</th>
              <th class="right">Net kâr</th><th class="right">Marj</th>
              <th class="right">Nakit</th><th class="right">Kart</th></tr></thead><tbody>
            ${r.rows.map(d => `<tr>
              <td>${d.date}</td>
              <td class="right mono">${d.orders}</td>
              <td class="right mono">${tl(d.revenue_gross)} ₺</td>
              <td class="right mono">${tl(d.cogs)} ₺</td>
              <td class="right mono">${tl(d.expenses)} ₺</td>
              <td class="right mono ${d.net_profit < 0 ? 'is-loss' : ''}">${tl(d.net_profit)} ₺</td>
              <td class="right mono">%${tl(d.net_margin)}</td>
              <td class="right mono">${tl(d.cash)} ₺</td>
              <td class="right mono">${tl(d.card)} ₺</td></tr>`).join('')}
          </tbody></table>` : '<div class="empty">Bu aralıkta kapanmış adisyon yok.</div>'}
        </div>
      </div>`;

    if ($('#plPCsv')) $('#plPCsv').onclick = (e) =>
      this.download(`/api/reports/export/pnl-products?from=${from}&to=${to}`, e.currentTarget);
    if ($('#plPPdf')) $('#plPPdf').onclick = (e) =>
      this.download(`/api/reports/export/pnl-products?from=${from}&to=${to}&format=pdf`, e.currentTarget);
    if ($('#plUncosted')) $('#plUncosted').onclick = () => modal(`
      <div class="modal__head"><h3>Maliyeti girilmemiş ürünler</h3><div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">Bu ürünlere Ürünler ekranından maliyet girin;
           kâr rakamı ancak ondan sonra doğru olur.</p>
        <table class="tbl"><thead><tr><th>Ürün</th><th class="right">Adet</th><th class="right">Ciro</th></tr></thead>
        <tbody>${r.uncosted.products.map(u => `<tr><td>${esc(u.name)}</td>
          <td class="right mono">${u.qty}</td><td class="right mono">${tl(u.revenue)} ₺</td></tr>`).join('')}
        </tbody></table>
      </div>`);
  },

  /**
   * Urunler - the ONE product screen.
   *
   * There used to be two. This one owned "Urun ekle", "Kategori ekle" and the
   * import/export; `screens/pricing.js` grew a second list that grouped by
   * category and showed margin, cost source and the product card behind it.
   * Both were in the navigation, both listed the same products, and a price
   * could be changed in either - which is exactly what Erik meant by "only one
   * place for pricing".
   *
   * So the good list won and the buttons moved onto it. `Fiyatlandirma` stays
   * a separate screen because it is a different job: it scans the whole menu
   * for margin and proposes changes, rather than editing one product.
   */
  async page_products() {
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px"><h2 class="page-title" style="margin:0">Ürünler</h2>
        <div class="spacer"></div>
        <input class="input" id="pdQ" placeholder="Ürün ya da kategori ara…"
          style="width:260px;height:36px" value="${esc(Screens._prQuery || '')}">
        <button class="btn btn--ghost btn--sm" id="pdPort">İçe / dışa aktar</button>
        <button class="btn btn--ghost btn--sm" id="pdCat">Kategori ekle</button>
        <button class="btn btn--primary btn--sm" id="pdNew">Ürün ekle</button></div>
      <div id="ukBody"><div class="empty">Yükleniyor…</div></div></div>`;

    let timer = null;
    $('#pdQ').oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { this._prQuery = $('#pdQ').value; this.prProductList(); }, 220);
    };
    $('#pdNew').onclick = () => this.productForm({});
    $('#pdCat').onclick = () => this.categoryForm();
    $('#pdPort').onclick = () => this.portageDialog();

    /* the card dialog and the forms both call this to redraw behind themselves */
    this._reloadProducts = () => this.prProductList();
    await this.prProductList();
  },

  /**
   * Menu import and export.
   *
   * Import is deliberately two steps. The menu is what the whole till is built
   * on, and a spreadsheet nobody checked can change three hundred prices in
   * one click; showing exactly what will change, and what will be skipped and
   * why, is the difference between a tool and an accident.
   */
  portageDialog() {
    let kind = 'products';
    const draw = () => {
      modal(`
        <div class="modal__head"><h3>Menüyü içe / dışa aktar</h3><div class="spacer"></div>
          <button class="close-x" onclick="closeModal()">✕</button></div>
        <div class="modal__body">
          <div class="row" style="gap:8px;margin-bottom:14px">
            <button class="btn ${kind === 'products' ? 'btn--dark' : 'btn--ghost'} btn--sm" data-k="products">Ürünler</button>
            <button class="btn ${kind === 'categories' ? 'btn--dark' : 'btn--ghost'} btn--sm" data-k="categories">Kategoriler</button>
          </div>

          <div class="card" style="margin-bottom:14px"><div class="card__body">
            <b>Dışa aktar</b>
            <p class="muted" style="margin:6px 0 10px">
              Mevcut listeyi indirir. Excel'de düzenleyip aşağıdan geri yükleyebilirsiniz —
              ID sütunu durduğu sürece kayıtlar çoğalmaz, güncellenir.</p>
            <div class="row" style="gap:8px">
              <button class="btn btn--primary btn--sm" id="poXlsx">Excel (.xlsx) indir</button>
              <button class="btn btn--ghost btn--sm" id="poCsv">CSV indir</button>
              <div class="spacer"></div>
              <button class="btn btn--ghost btn--sm" id="poTpl">Boş şablon</button>
            </div>
          </div></div>

          <div class="card"><div class="card__body">
            <b>İçe aktar</b>
            <p class="muted" style="margin:6px 0 10px">
              Excel (.xlsx) veya CSV. Sütun başlıkları Türkçe ya da İngilizce olabilir;
              fiyatı <b>1.250,00</b> gibi yazabilirsiniz.</p>
            <input type="file" id="poFile" accept=".xlsx,.xls,.csv,text/csv" class="input">
            <div id="poOut" style="margin-top:12px"></div>
          </div></div>
        </div>`);
      $$('#modal [data-k]').forEach(b => b.onclick = () => { kind = b.dataset.k; draw(); });
      $('#poXlsx').onclick = (e) => this.download(`/api/manage/${kind}/export?format=xlsx`, e.currentTarget);
      $('#poCsv').onclick = (e) => this.download(`/api/manage/${kind}/export?format=csv`, e.currentTarget);
      $('#poTpl').onclick = (e) => this.download(`/api/manage/${kind}/template?format=xlsx`, e.currentTarget);
      $('#poFile').onchange = () => this.portagePreview(kind);
    };
    draw();
  },

  async portagePreview(kind) {
    const f = $('#poFile').files[0];
    if (!f) return;
    const out = $('#poOut');
    out.innerHTML = '<div class="muted">Dosya okunuyor…</div>';
    const b64 = await new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => res(String(rd.result).split(',')[1]);
      rd.onerror = rej;
      rd.readAsDataURL(f);
    });

    let r;
    try {
      r = await api('POST', `/api/manage/${kind}/import/preview`, { filename: f.name, content_base64: b64 });
    } catch (e) { out.innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; return; }

    const s = r.summary;
    const bad = r.plan.filter(p => p.action === 'skip');
    const changed = r.plan.filter(p => p.action !== 'skip' && (p.warnings.length || p.action === 'create'));
    out.innerHTML = `
      <div class="alert ${s.skip ? 'alert--warn' : 'alert--ok'}">
        <b>${s.total} satır okundu.</b>
        ${s.create} yeni, ${s.update} güncelleme${s.skip ? `, <b>${s.skip} atlanacak</b>` : ''}.
      </div>
      ${changed.length ? `<div style="max-height:190px;overflow:auto;margin-bottom:10px">
        <table class="tbl"><tbody>${changed.slice(0, 200).map(p => `<tr>
          <td><span class="badge ${p.action === 'create' ? 'badge--open' : 'badge--gray'}">${p.action === 'create' ? 'yeni' : 'güncelle'}</span></td>
          <td>${esc(p.name)}</td>
          <td class="muted">${p.warnings.map(esc).join(' · ')}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
      ${bad.length ? `<div style="max-height:150px;overflow:auto;margin-bottom:10px">
        <table class="tbl"><tbody>${bad.slice(0, 200).map(p => `<tr>
          <td class="muted">satır ${p.line}</td><td>${esc(p.name || '—')}</td>
          <td class="is-loss">${p.errors.map(esc).join(', ')}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
      <button class="btn btn--primary btn--wide" id="poGo"
        ${s.create + s.update ? '' : 'disabled'}>${s.create + s.update} kaydı uygula</button>`;

    if (!$('#poGo')) return;
    $('#poGo').onclick = async () => {
      $('#poGo').disabled = true;
      $('#poGo').textContent = 'Uygulanıyor…';
      try {
        const res = await api('POST', `/api/manage/${kind}/import/apply`, { filename: f.name, content_base64: b64 });
        closeModal();
        toast(`${res.created} yeni, ${res.updated} güncellendi` +
              (res.categoriesCreated ? `, ${res.categoriesCreated} kategori açıldı` : ''), 'ok');
        App.data.menu = (await api('GET', '/api/pos/menu')).menu;
        if (this._reloadProducts) this._reloadProducts();
      } catch (e) { err(e); $('#poGo').disabled = false; $('#poGo').textContent = 'Tekrar dene'; }
    };
  },

  /**
   * The product form - one place, everything about a product.
   *
   * The old one was six fields in a narrow box and it had two faults that only
   * showed up after somebody used it. It compared `p.category_id === c.id`
   * strictly, and the API hands one of them back as a string, so EDITING a
   * product quietly moved it to whatever category happened to be first in the
   * list. And it never sent `use_in_pos`, which defaults to 1 on the way in -
   * so a product deliberately hidden from the till came back onto it every
   * time anybody opened this form and pressed Kaydet.
   *
   * It is also where the margin should be visible: the price and the cost are
   * both here, and a person setting a price is deciding a margin whether or
   * not the screen says so out loud.
   */
  async productForm(p) {
    p = p || {};
    const [cats, stations] = await Promise.all([
      api('GET', '/api/manage/categories').then(r => r.categories),
      api('GET', '/api/pos/stations').then(r => r.stations).catch(() => []),
    ]);
    if (!cats.length) {
      return modal(`
        <div class="modal__head"><h3>Önce kategori</h3></div>
        <div class="modal__body"><p style="margin:0">Ürün eklemeden önce en az bir kategori
          oluşturmanız gerekiyor. Kategori, ürünün kasada nerede duracağını ve
          mutfakta hangi istasyona basılacağını belirler.</p></div>
        <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
          <button class="btn btn--primary" id="pfGoCat">Kategori ekle</button></div>`);
    }
    const stName = (id) => {
      const st = stations.find(x => Number(x.id) === Number(id));
      return st ? (st.display_name || st.name) : '';
    };
    /* Number() on both sides: the id arrives as a string from one endpoint and
       a number from another, and the strict compare silently reset it. */
    const sameCat = (a, b) => Number(a) === Number(b);
    const VATS = [0, 1, 10, 20];
    const vat = Number(p.vat_rate === undefined ? 10 : p.vat_rate);

    modal(`
      <div class="modal__head"><h3>${p.id ? 'Ürünü düzenle' : 'Yeni ürün'}</h3>
        ${p.id ? `<span class="badge badge--gray">#${p.id}</span>` : ''}
        <div class="spacer"></div>
        <button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div id="pfErr"></div>
        <div class="split-2" style="gap:22px;align-items:start">
          <div>
            <div class="field"><label>Ürün adı</label>
              <input class="input" id="pfName" maxlength="120" value="${esc(p.name || '')}"
                placeholder="Adana Kebap" autocomplete="off"></div>
            <div class="field"><label>Kategori</label>
              <select class="input" id="pfCat">
                ${cats.map(c => `<option value="${c.id}"${sameCat(p.category_id, c.id) ? ' selected' : ''}
                  data-st="${c.station_id || ''}">${esc(c.name)}</option>`).join('')}
              </select>
              <div class="muted" style="font-size:12.5px;margin-top:5px" id="pfStHint"></div></div>
            <div class="field"><label>Açıklama <span class="muted">(QR menüde görünür)</span></label>
              <textarea class="input" id="pfDesc" rows="2" maxlength="400"
                placeholder="İnce lavaş, közlenmiş domates ve biberle">${esc(p.description || '')}</textarea></div>
            <div class="field" style="margin-bottom:0"><label>Görsel adresi <span class="muted">(isteğe bağlı)</span></label>
              <input class="input mono" id="pfImg" maxlength="255" value="${esc(p.image_url || '')}"
                placeholder="https://…/adana.jpg"></div>
          </div>

          <div>
            <div class="split-2">
              <div class="field"><label>Satış fiyatı <span class="muted">(KDV dahil)</span></label>
                <input class="input mono" id="pfPrice" type="number" step="0.01" min="0"
                  value="${Number(p.price || 0)}"></div>
              <div class="field"><label>KDV oranı</label>
                <select class="input" id="pfVat">
                  ${VATS.map(v => `<option value="${v}"${vat === v ? ' selected' : ''}>%${v}</option>`).join('')}
                </select></div>
            </div>
            <div class="field"><label>Maliyet <span class="muted">(bir porsiyona giren)</span></label>
              <input class="input mono" id="pfCost" type="number" step="0.01" min="0"
                value="${Number(p.cost_price || 0)}"></div>

            <div class="pf-calc" id="pfCalc"></div>

            <div class="pf-flags">
              <label class="pf-flag"><input type="checkbox" id="pfActive"
                ${Number(p.is_active) === 0 ? '' : 'checked'}>
                <span><b>Aktif</b><i>Pasif ürün hiçbir yerde görünmez</i></span></label>
              <label class="pf-flag"><input type="checkbox" id="pfPos"
                ${Number(p.use_in_pos) === 0 ? '' : 'checked'}>
                <span><b>Kasada göster</b><i>Adisyon ekranındaki ürün listesinde</i></span></label>
              <label class="pf-flag"><input type="checkbox" id="pfQr"
                ${Number(p.use_in_qr) === 1 ? 'checked' : ''}>
                <span><b>QR menüde göster</b><i>Misafirin telefonundan gördüğü menü</i></span></label>
              <label class="pf-flag"><input type="checkbox" id="pfStock"
                ${Number(p.track_stock) === 1 ? 'checked' : ''}>
                <span><b>Stok takibi</b><i>Satıldıkça stoktan düşer</i></span></label>
            </div>
          </div>
        </div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="pfOk">Kaydet</button></div>`, { wide: true });

    if ($('#pfGoCat')) { $('#pfGoCat').onclick = () => { closeModal(); this.categoryForm(); }; return; }

    /*
     * KDV in Turkey is INSIDE the price, so the net is price*100/(100+rate) -
     * never price*rate/100. Margin is against that net, because the tax is not
     * the restaurant's money and counting it as revenue flatters every figure
     * on the screen.
     */
    const calc = () => {
      const price = Number($('#pfPrice').value) || 0;
      const rate = Number($('#pfVat').value) || 0;
      const cost = Number($('#pfCost').value) || 0;
      const kdv = Math.round(price * rate / (100 + rate) * 100) / 100;
      const net = Math.round((price - kdv) * 100) / 100;
      const profit = Math.round((net - cost) * 100) / 100;
      const margin = net > 0 ? Math.round(profit / net * 1000) / 10 : null;
      $('#pfCalc').innerHTML = price <= 0 ? `<span class="muted">Fiyat girin.</span>` : `
        <div class="pf-calc__row"><span>KDV (%${rate})</span><b class="mono">${tl(kdv)} ₺</b></div>
        <div class="pf-calc__row"><span>Net (KDV hariç)</span><b class="mono">${tl(net)} ₺</b></div>
        ${cost > 0 ? `<div class="pf-calc__row"><span>Maliyet</span><b class="mono">-${tl(cost)} ₺</b></div>
        <div class="pf-calc__row pf-calc__row--grand ${profit < 0 ? 'is-loss' : ''}">
          <span>Kâr</span><b class="mono">${tl(profit)} ₺${margin === null ? '' : ' · %' + margin}</b></div>`
        : '<div class="pf-calc__row"><span class="muted">Maliyet girilirse kâr ve marj burada görünür.</span></div>'}`;
    };
    const hint = () => {
      const opt = $('#pfCat').selectedOptions[0];
      const st = opt && opt.dataset.st ? stName(opt.dataset.st) : '';
      $('#pfStHint').textContent = st
        ? 'Bu kategori mutfakta "' + st + '" istasyonuna basar.'
        : 'Bu kategoriye istasyon bağlı değil — siparişi hiçbir ekrana düşmez.';
    };
    ['pfPrice', 'pfVat', 'pfCost'].forEach(id => { $('#' + id).oninput = calc; $('#' + id).onchange = calc; });
    $('#pfCat').onchange = hint;
    calc(); hint();
    // the dialog can be closed before this fires; a focus on nothing throws
    setTimeout(() => { const el = $('#pfName'); if (el) el.focus(); }, 60);

    $('#pfOk').onclick = async () => {
      const name = $('#pfName').value.trim();
      const price = Number($('#pfPrice').value);
      if (!name) return this.pfFail('Ürün adı boş olamaz.');
      if (!(price > 0)) return this.pfFail('Satış fiyatı sıfırdan büyük olmalı.');
      const btn = $('#pfOk'); btn.disabled = true;
      try {
        await api('POST', '/api/manage/products', {
          id: p.id, name, category_id: Number($('#pfCat').value),
          price, cost_price: Number($('#pfCost').value) || 0,
          vat_rate: Number($('#pfVat').value),
          description: $('#pfDesc').value.trim(),
          image_url: $('#pfImg').value.trim(),
          track_stock: $('#pfStock').checked,
          use_in_pos: $('#pfPos').checked,
          use_in_qr: $('#pfQr').checked,
          is_active: $('#pfActive').checked });
        closeModal(); toast(p.id ? 'Ürün güncellendi' : 'Ürün eklendi', 'ok');
        await Screens.loadMenu(); this._reloadProducts && this._reloadProducts();
      } catch (e) { this.pfFail(e.message); btn.disabled = false; }
    };
  },

  /** Errors belong in the dialog, next to the field, not in a toast that
      disappears while the person is still reading the form. */
  pfFail(msg) {
    const box = $('#pfErr');
    if (box) box.innerHTML = `<div class="alert alert--error">${esc(msg)}</div>`;
    else toast(msg, 'error');
  },


  /**
   * The category form, for a new one AND an existing one.
   *
   * It only ever created. A category's station is the thing that decides which
   * screen a waiter's order lands on - get it wrong at setup and the pide
   * counter never sees an order - and there was no way to change it afterwards
   * from this screen at all.
   */
  async categoryForm(c) {
    c = c || {};
    const st = (await api('GET', '/api/pos/stations')).stations;
    modal(`
      <div class="modal__head"><h3>${c.id ? 'Kategoriyi düzenle' : 'Yeni kategori'}</h3>
        <div class="spacer"></div><button class="close-x" onclick="closeModal()">✕</button></div>
      <div class="modal__body">
        <div id="cfErr"></div>
        <div class="field"><label>Kategori adı</label>
          <input class="input" id="cfName" maxlength="120" value="${esc(c.name || '')}"
            placeholder="Ana Yemek" autocomplete="off"></div>
        <div class="field"><label>Hangi istasyona basılsın</label>
          <select class="input" id="cfSt">
            <option value="0">İstasyon yok (yazdırılmaz)</option>
            ${st.map(x => `<option value="${x.id}"${Number(c.station_id) === Number(x.id) ? ' selected' : ''}
              >${esc(x.display_name || x.name)}</option>`).join('')}
          </select>
          <div class="muted" style="font-size:12.5px;margin-top:5px">
            Bu kategorideki ürünler mutfakta bu istasyonun ekranına ve yazıcısına düşer.
          </div></div>
        <div class="field"><label>Sıra <span class="muted">(kasada soldan sağa)</span></label>
          <input class="input mono" id="cfSort" type="number" step="1" min="0"
            value="${Number(c.sort_order || 0)}" style="width:120px"></div>
        <div class="pf-flags" style="margin-top:4px">
          <label class="pf-flag"><input type="checkbox" id="cfActive"
            ${Number(c.is_active) === 0 ? '' : 'checked'}>
            <span><b>Aktif</b><i>Pasif kategori ve içindeki ürünler görünmez</i></span></label>
          <label class="pf-flag"><input type="checkbox" id="cfPos"
            ${Number(c.use_in_pos) === 0 ? '' : 'checked'}>
            <span><b>Kasada göster</b><i>Adisyon ekranındaki sekmelerde</i></span></label>
          <label class="pf-flag"><input type="checkbox" id="cfQr"
            ${Number(c.use_in_qr) === 1 ? 'checked' : ''}>
            <span><b>QR menüde göster</b><i>Misafirin telefonundaki menüde</i></span></label>
        </div>
      </div>
      <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="cfOk">Kaydet</button></div>`);
    setTimeout(() => { const el = $('#cfName'); if (el) el.focus(); }, 60);

    $('#cfOk').onclick = async () => {
      const name = $('#cfName').value.trim();
      if (!name) {
        $('#cfErr').innerHTML = '<div class="alert alert--error">Kategori adı boş olamaz.</div>';
        return;
      }
      const btn = $('#cfOk'); btn.disabled = true;
      try {
        await api('POST', '/api/manage/categories', {
          id: c.id, name,
          station_id: Number($('#cfSt').value) || null,
          sort_order: Number($('#cfSort').value) || 0,
          is_active: $('#cfActive').checked,
          use_in_pos: $('#cfPos').checked,
          use_in_qr: $('#cfQr').checked });
        closeModal(); toast(c.id ? 'Kategori güncellendi' : 'Kategori eklendi', 'ok');
        await Screens.loadMenu(); this._reloadProducts && this._reloadProducts();
      } catch (e) {
        $('#cfErr').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`;
        btn.disabled = false;
      }
    };
  },

  /* ----------------------------------------------------------- guests */
  async page_guests() {
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px"><h2 class="page-title" style="margin:0">Müşteriler</h2>
        <div class="spacer"></div>
        <input class="input" id="guQ" placeholder="ara..." style="width:220px;height:36px">
        <button class="btn btn--primary btn--sm" id="guNew">Müşteri ekle</button></div>
      <div class="split-2" style="align-items:start">
        <div class="card"><div id="guList"></div></div>
        <div class="card"><div class="card__head"><h3>Rezervasyonlar</h3><div class="spacer"></div>
          <button class="btn btn--ghost btn--sm" id="guRes">Rezervasyon ekle</button></div>
          <div id="guResList"></div></div>
      </div></div>`;
    const load = async () => {
      const r = await api('GET', '/api/manage/customers?q=' + encodeURIComponent($('#guQ').value || ''));
      $('#guList').innerHTML = r.customers.length ? `<table class="tbl"><tbody>${r.customers.map(c => `
        <tr><td><b>${esc(c.first_name)} ${esc(c.last_name || '')}</b></td>
        <td class="muted">${esc(c.phone || '')}</td><td class="muted">${esc(c.email || '')}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Kayıt yok.</div>';
      const res = await api('GET', '/api/manage/reservations?date=' + new Date().toISOString().slice(0, 10));
      $('#guResList').innerHTML = res.reservations.length ? `<table class="tbl"><tbody>${res.reservations.map(x => `
        <tr><td>${(x.starts_at || '').slice(11, 16)}</td><td><b>${esc(x.guest_name)}</b></td>
        <td>${x.party_size} kişi</td><td class="muted">${esc(x.table_name || '')}</td>
        <td class="right"><button class="btn btn--ghost btn--sm" data-seat="${x.id}">Masaya al</button></td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Bugün rezervasyon yok.</div>';
      $$('[data-seat]').forEach(b => b.onclick = async () => {
        try { const r2 = await api('POST', `/api/manage/reservations/${b.dataset.seat}/seat`); go('order', r2.order_id); }
        catch (e) { err(e); }
      });
    };
    $('#guQ').oninput = () => { clearTimeout(this._guT); this._guT = setTimeout(load, 250); };
    $('#guNew').onclick = () => {
      modal(`<div class="modal__head"><h3>Yeni müşteri</h3></div>
        <div class="modal__body"><div class="split-2">
          <div class="field"><label>Ad</label><input class="input" id="cuF"></div>
          <div class="field"><label>Soyad</label><input class="input" id="cuL"></div>
          <div class="field"><label>Telefon</label><input class="input" id="cuP"></div>
          <div class="field"><label>E-posta</label><input class="input" id="cuE"></div>
        </div></div>
        <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
          <button class="btn btn--primary" id="cuOk">Kaydet</button></div>`);
      $('#cuOk').onclick = async () => {
        try {
          await api('POST', '/api/manage/customers', { first_name: $('#cuF').value, last_name: $('#cuL').value,
            phone: $('#cuP').value, email: $('#cuE').value });
          closeModal(); load();
        } catch (e) { err(e); }
      };
    };
    $('#guRes').onclick = () => {
      api('GET', '/api/manage/tables').then(t => {
        modal(`<div class="modal__head"><h3>Rezervasyon</h3></div>
          <div class="modal__body"><div class="split-2">
            <div class="field"><label>Misafir</label><input class="input" id="rsName"></div>
            <div class="field"><label>Telefon</label><input class="input" id="rsPhone"></div>
            <div class="field"><label>Saat</label><input class="input" id="rsTime" type="datetime-local"></div>
            <div class="field"><label>Kişi</label><input class="input" id="rsSize" type="number" value="2"></div>
          </div>
          <div class="field"><label>Masa</label><select class="input" id="rsTable">
            <option value="">Belirtilmedi</option>
            ${t.tables.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div></div>
          <div class="modal__foot"><button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
            <button class="btn btn--primary" id="rsOk">Kaydet</button></div>`);
        $('#rsOk').onclick = async () => {
          try {
            await api('POST', '/api/manage/reservations', { guest_name: $('#rsName').value, guest_phone: $('#rsPhone').value,
              starts_at: $('#rsTime').value.replace('T', ' ') + ':00', party_size: Number($('#rsSize').value),
              table_id: $('#rsTable').value ? Number($('#rsTable').value) : null });
            closeModal(); load();
          } catch (e) { err(e); }
        };
      });
    };
    load();
  },

  /* --------------------------------------------------------- settings */
  /*
   * The "Ayarlar" screen that used to live here is gone.
   *
   * It was the screen a sidebar GROUP head rendered, with seven tabs of its
   * own - İşletme, Yazıcılar, ÖKC, Kullanıcılar, Telefonlar, Yedekleme, QR
   * menü - and six of the seven were a second copy of something a screen
   * beneath it already owned. Yazıcılar existed three times in this program.
   * Whichever copy was saved last won, and the others went on showing the
   * value they had loaded until somebody reopened them.
   *
   * Every subject found a single home: printers and stations on Yazıcı ve fiş
   * (screens/fis.js), phones on Cihazlar (screens/device.js), QR menü under
   * Müşteri (screens/guest.js), and İşletme, Kullanıcılar, ÖKC and Yedekleme
   * on their own screens in screens/settings.js - which is also where
   * page_settings now lives, as a redirect, so the old address still lands
   * somewhere that draws.
   */

});
