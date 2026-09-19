/* =====================================================================
   NOKTApp POS - ÖKC: kayıt defteri, kanıt ve üretime açma
   =====================================================================
   Bu ekran, ÖKC entegrasyon şartnamesinin ürüne bakan yüzü.

   Neden gerekti. Bir kasiyer cihazının markasını bir metin kutusuna
   yazıyordu. Marka adı bir kimlik değil: aynı donanım iki ayrı mali
   sahibin altında kayıtlı olabiliyor (Ingenico iWE280 hem PAVO hem
   Worldline), ve BCA ile BCM bambaşka iki cihaz. Artık cihaz GİB
   listesinden seçiliyor ve mali seri prefixi ile doğrulanıyor.

   Ekranın taşıdığı tek fikir: LİSTEDE OLMAK ÇALIŞIYOR DEMEK DEĞİLDİR.
   Üç ayrı kanıt boyutu ayrı ayrı gösterilir ve hiçbiri diğerinin yerine
   geçmez - kayıt ne diyor, geliştirici ne görebiliyor, biz neyi
   kanıtladık. Bir cihaz mali işlem yapabilsin diye açılması ayrı, açık
   ve denetlenen bir iştir.

   Renk: tek aksan turuncu. Yeşil yok - "doğrulandı" ile "bilinmiyor"
   kelimeyle ayrılır, kırmızı yalnızca insan müdahalesi gereken iki şey
   için: karantina ve üretime kapalı bir cihazda bekleyen işlem.
   ===================================================================== */
'use strict';

registerIcon('okcdefter',
  '<rect x="3.5" y="3" width="17" height="18" rx="2.5"/><path d="M7 7.5h10M7 11h10"/>' +
  '<rect x="7" y="14.5" width="4.5" height="3" rx="1"/><path d="M14 16h3"/>');

registerPage({ id: 'okcdefter', label: 'ÖKC kayıt defteri', icon: 'okcdefter',
  perm: 'settings.manage', group: 'isletme' }, 'okc');

/* ------------------------------------------------------------ helpers */

const OKC_EVIDENCE_LABEL = {
  registry_observation: 'Kayıt gözlemi',
  documentation_access: 'Doküman erişimi',
  implementation_state: 'Bizim kanıtımız',
};
const OKC_EVIDENCE_TEXT = {
  live_register: 'Canlı GİB listesinde',
  pdf_only: 'Yalnızca resmî PDF',
  not_commissioned: 'Cihaz listeden seçilmemiş',
  not_obtained: 'SDK / sözleşme alınmadı',
  partial: 'Başlanmış rota, mesaj katmanı doğrulanmadı',
  unknown: 'Bilinmiyor',
  design_only: 'Yalnızca tasarım',
  laboratory_tested: 'Laboratuvarda doğrulandı',
};
function okcEvidence(v) { return OKC_EVIDENCE_TEXT[v] || v || '—'; }

/** Doğrulandı / bilinmiyor / desteklenmiyor - kelimeyle, renkle değil. */
function okcCapBadge(state) {
  if (state === 'VERIFIED') return '<span class="badge badge--open">doğrulandı</span>';
  if (state === 'UNSUPPORTED') return '<span class="badge">desteklenmiyor</span>';
  return '<span class="badge badge--gray">bilinmiyor</span>';
}

Screens.add({

  async page_okcdefter(tab) {
    if (tab) this._okdTab = tab;
    if (!this._okdTab) this._okdTab = 'cihazlar';
    const TABS = [['cihazlar', 'Cihazlar'], ['defter', 'Kayıt defteri'], ['teshis', 'Teşhis']];

    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">ÖKC</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">Yeni Nesil ödeme kaydedici cihaz</span>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px" id="okdTabs">
        ${TABS.map(([id, label]) => `<button class="zone-tab${this._okdTab === id ? ' is-active' : ''}"
          data-t="${id}">${label}</button>`).join('')}
      </div>
      <div id="okdBody"><div class="empty">Yükleniyor…</div></div></div>`;

    $$('#okdTabs [data-t]').forEach(b => b.onclick = () => this.page_okcdefter(b.dataset.t));
    const draw = { cihazlar: () => this.okdDevices(), defter: () => this.okdRegistry(), teshis: () => this.okdDiag() };
    try { await draw[this._okdTab](); } catch (e) { err(e); }
  },

  okdReload() { return this.page_okcdefter(this._okdTab); },

  /* ------------------------------------------------------- cihazlar */

  async okdDevices() {
    const r = await api('GET', '/api/okc/devices');
    const list = (r && r.devices) || [];
    if (!list.length) {
      $('#okdBody').innerHTML = `<div class="card"><div class="empty">
        <b>Tanımlı ÖKC yok</b>
        <p class="muted">Ayarlar &rsaquo; Mali cihazlar ekranından cihazı ekleyin,
           sonra buradan GİB listesinden seçip devreye alın.</p></div></div>`;
      return;
    }
    $('#okdBody').innerHTML = list.map(d => {
      const reg = d.registry;
      const warn = d.quarantine_reason
        ? `<div class="alert alert--error" style="margin-bottom:12px"><b>Karantina:</b> ${esc(d.quarantine_reason)}
             — çözülmemiş bir işlem var, cihaz mali işlem almaz.</div>` : '';
      const notArmed = !d.production_enabled
        ? `<div class="alert alert--warn" style="margin-bottom:12px">Bu cihaz <b>üretime kapalı</b>.
             Mali işlem yapamaz; satışlar simülatöre düşer veya reddedilir.</div>` : '';
      return `<div class="card" style="margin-bottom:16px" data-dev="${d.id}">
        <div class="row" style="align-items:flex-start;gap:14px;margin-bottom:14px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:16px">
              ${esc(reg ? reg.brand_model : d.provider)}</div>
            <div class="muted" style="font-size:13px;margin-top:3px">
              ${reg ? esc(reg.fiscal_owner) : 'GİB listesinden seçilmemiş'}</div>
            <div class="muted mono" style="font-size:12.5px;margin-top:5px">
              Seri ${esc(d.serial || '—')}${d.prefix ? ` · prefix <b>${esc(d.prefix)}</b>` : ''}
              ${reg ? ` · ${reg.fiscal_class === 'eft_pos' ? 'EFT POS' : 'Bilgisayar bağlantılı'}` : ''}</div>
          </div>
          <button class="btn" data-act="commission" data-id="${d.id}">Cihazı seç</button>
        </div>
        ${warn}${notArmed}
        ${reg && reg.note ? `<div class="alert alert--warn" style="margin-bottom:12px"><b>Kayıt notu:</b> ${esc(reg.note)}</div>` : ''}

        <div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:14px">
          ${Object.keys(OKC_EVIDENCE_LABEL).map(k => `
            <div class="stat" style="flex:1;min-width:190px">
              <div class="stat__label">${OKC_EVIDENCE_LABEL[k]}</div>
              <div class="stat__value" style="font-size:14px;font-weight:600">${esc(okcEvidence(d.evidence[k]))}</div>
            </div>`).join('')}
        </div>

        <div class="row" style="margin-bottom:10px">
          <b style="font-size:14px">Yetenekler</b>
          <span class="muted" style="font-size:13px;margin-left:8px">
            ${d.verified_count}/${d.capability_total} doğrulandı</span>
          <div class="spacer"></div>
          <button class="btn btn--ghost" data-act="prod" data-id="${d.id}" data-on="${d.production_enabled ? 0 : 1}">
            ${d.production_enabled ? 'Üretimden al' : 'Üretime aç'}</button>
        </div>
        <table class="tbl"><tbody>
          ${d.capabilities.map(c => `<tr>
            <td style="width:190px"><span class="mono" style="font-size:12.5px">${esc(c.capability)}</span></td>
            <td>${okcCapBadge(c.state)}</td>
            <td class="muted" style="font-size:12.5px">${esc(c.evidence_ref || c.question)}</td>
            <td style="text-align:right;width:120px">
              <button class="btn btn--ghost btn--sm" data-act="cap" data-id="${d.id}"
                data-cap="${esc(c.capability)}">Kanıt gir</button></td>
          </tr>`).join('')}
        </tbody></table>
      </div>`;
    }).join('');

    $$('#okdBody [data-act="commission"]').forEach(b => b.onclick = () => this.okdCommission(b.dataset.id));
    $$('#okdBody [data-act="cap"]').forEach(b => b.onclick = () => this.okdCapability(b.dataset.id, b.dataset.cap));
    $$('#okdBody [data-act="prod"]').forEach(b => b.onclick = () => this.okdProduction(b.dataset.id, b.dataset.on === '1'));
  },

  /* ------------------------------------------------- cihazı devreye al */

  async okdCommission(id) {
    const r = await api('GET', '/api/okc/registry');
    const devices = (r && r.devices) || [];
    const groups = {};
    for (const d of devices) (groups[d.fiscal_owner] = groups[d.fiscal_owner] || []).push(d);

    modal(`
      <div class="modal__head"><h3>Cihazı GİB listesinden seç</h3></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">Bu liste GİB kaydıdır, uyumluluk listesi
          değildir. Bir cihazın burada olması NOKTApp ile çalıştığı anlamına gelmez.</p>
        <div class="field"><label>Mali seri numarası</label>
          <input class="input" id="okcSerial" placeholder="Cihazın üstündeki mali seri" autocomplete="off"></div>
        <div class="field"><label>Cihaz</label>
          <select class="input" id="okcPick" size="10">
            <option value="">— seriyi yazın, otomatik bulunsun —</option>
            ${Object.keys(groups).sort().map(owner => `<optgroup label="${esc(owner)}">
              ${groups[owner].map(d => `<option value="${d.id}">${esc(d.brand_model)} · ${esc(d.prefix)}</option>`).join('')}
            </optgroup>`).join('')}
          </select></div>
        <div id="okcMatch" class="muted" style="min-height:20px"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="okcCommitGo">Devreye al</button>
      </div>`);

    $('#okcCommitGo').onclick = async () => {
      try {
        const out = await api('POST', `/api/okc/devices/${id}/commission`, {
          serial: $('#okcSerial').value.trim(),
          registry_device_id: $('#okcPick').value ? Number($('#okcPick').value) : null,
        });
        closeModal();
        toast(`${out.registry.brand_model} devreye alındı. Üretim hâlâ kapalı.`);
        this.okdReload();
      } catch (e) { err(e); }
    };

    /* Live prefix preview: the operator sees which device the serial resolves
       to before committing, including the refusal when it is ambiguous. */
    const box = $('#okcSerial');
    let t = null;
    box.oninput = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const v = box.value.trim();
        if (v.length < 3) { $('#okcMatch').textContent = ''; return; }
        try {
          const m = await api('GET', '/api/okc/registry/match?serial=' + encodeURIComponent(v));
          $('#okcMatch').innerHTML = `Eşleşti: <b>${esc(m.match.brand_model)}</b> · prefix ${esc(m.prefix)}`;
          $('#okcPick').value = String(m.match.id);
        } catch (e) {
          $('#okcMatch').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
        }
      }, 250);
    };
  },

  /* --------------------------------------------------------- kanıt gir */

  async okdCapability(id, capability) {
    modal(`
      <div class="modal__head"><h3>Yetenek kanıtı — ${esc(capability)}</h3></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0"><b>Doğrulandı</b> yalnızca bu yapılandırmada
          test edilmişse seçilir ve kanıt referansı ister. <b>Desteklenmiyor</b> üreticinin
          yazılı sınırıdır, arama sonucu değil. <b>Bilinmiyor</b> mali işlemde kapalı
          tarafa düşer.</p>
        <div class="field"><label>Durum</label>
          <select class="input" id="okcCapState">
            <option value="UNKNOWN">Bilinmiyor</option>
            <option value="VERIFIED">Doğrulandı</option>
            <option value="UNSUPPORTED">Desteklenmiyor</option>
          </select></div>
        <div class="field"><label>Kanıt referansı</label>
          <input class="input" id="okcCapRef" placeholder="Sözleşme no, test raporu, üretici yazısı"></div>
        <div class="field"><label>Operatör şartı (varsa)</label>
          <input class="input" id="okcCapOp" placeholder="ör. yalnızca gün sonu öncesi"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="okcCapGo">Kaydet</button>
      </div>`);

    $('#okcCapGo').onclick = async () => {
      try {
        await api('POST', `/api/okc/devices/${id}/capabilities`, {
          capability,
          state: $('#okcCapState').value,
          evidence_ref: $('#okcCapRef').value.trim() || null,
          operator_requirements: $('#okcCapOp').value.trim() || null,
        });
        closeModal(); toast('Kanıt kaydedildi'); this.okdReload();
      } catch (e) { err(e); }
    };
  },

  /* ----------------------------------------------------- üretime açma */

  async okdProduction(id, enable) {
    if (!enable) {
      await api('POST', `/api/okc/devices/${id}/production`, { enabled: false });
      toast('Cihaz üretimden alındı');
      return this.okdReload();
    }
    modal(`
      <div class="modal__head"><h3>Cihazı üretime aç</h3></div>
      <div class="modal__body">
        <div class="alert alert--error" style="margin-top:0">
          Bu cihaz bundan sonra <b>gerçek mali fiş</b> kesebilecek. Yanlış bir mesaj ekranı
          bozmaz — hukuken sorumlu olduğunuz yanlış bir vergi belgesi üretir.</div>
        <p class="muted">Onaylamak için cihazın mali seri numarasını yazın.</p>
        <div class="field"><label>Seri numarası</label>
          <input class="input" id="okcConfirm" autocomplete="off"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--danger" id="okcProdGo">Üretime aç</button>
      </div>`);

    $('#okcProdGo').onclick = async () => {
      try {
        await api('POST', `/api/okc/devices/${id}/production`,
          { enabled: true, confirm_serial: $('#okcConfirm').value.trim() });
        closeModal(); toast('Cihaz üretime açıldı'); this.okdReload();
      } catch (e) { err(e); }
    };
  },

  /* ------------------------------------------------------ kayıt defteri */

  async okdRegistry() {
    const r = await api('GET', '/api/okc/registry?fuel=1');
    const devices = (r && r.devices) || [];
    const blocked = (r && r.blocked_owners) || {};
    const inprog = (r && r.in_progress_owners) || [];
    const retail = devices.filter(d => d.category === 'retail');
    const fuel = devices.filter(d => d.category === 'fuel_pump');

    $('#okdBody').innerHTML = `
      <div class="alert alert--info" style="margin-bottom:14px">${esc(r.note || '')}</div>
      <div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:14px">
        <div class="stat" style="flex:1;min-width:150px"><div class="stat__label">Perakende kayıt</div>
          <div class="stat__value">${retail.length}</div></div>
        <div class="stat" style="flex:1;min-width:150px"><div class="stat__label">Mali sahip</div>
          <div class="stat__value">${new Set(retail.map(d => d.owner_key)).size}</div></div>
        <div class="stat" style="flex:1;min-width:150px"><div class="stat__label">Başlanmış rota</div>
          <div class="stat__value">${inprog.length}</div></div>
        <div class="stat" style="flex:1;min-width:150px"><div class="stat__label">Akaryakit (kapalı)</div>
          <div class="stat__value">${fuel.length}</div></div>
      </div>
      <div class="field" style="max-width:320px"><input class="input" id="okdFind" placeholder="Marka, model veya prefix ara"></div>
      <table class="tbl"><thead><tr>
        <th>Mali sahip</th><th>Marka ve model</th><th>Prefix</th><th>Sınıf</th><th>Durum</th>
      </tr></thead><tbody id="okdRows">${retail.concat(fuel).map(d => {
        const b = blocked[d.owner_key];
        const state = d.rollout_blocked ? 'Akaryakıt alanı — bu üründe kullanılmaz'
          : inprog.includes(d.owner_key) ? 'Rota başlandı, mesaj katmanı doğrulanmadı'
          : b ? b.reason : 'Adaptör tanımlı değil';
        return `<tr data-find="${esc((d.fiscal_owner + ' ' + d.brand_model + ' ' + d.prefix).toLowerCase())}">
          <td class="muted" style="font-size:12.5px">${esc(d.fiscal_owner)}</td>
          <td><b>${esc(d.brand_model)}</b>${d.evidence_kind === 'pdf_only'
              ? ' <span class="badge">PDF</span>' : ''}</td>
          <td class="mono">${esc(d.prefix)}</td>
          <td class="muted" style="font-size:12.5px">${d.fiscal_class === 'eft_pos' ? 'EFT POS' : 'Bilgisayar bağlantılı'}</td>
          <td class="muted" style="font-size:12.5px">${esc(state)}</td></tr>`;
      }).join('')}</tbody></table>`;

    $('#okdFind').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      $$('#okdRows tr').forEach(tr => {
        tr.style.display = !q || tr.dataset.find.includes(q) ? '' : 'none';
      });
    };
  },

  /* ------------------------------------------------------------ teşhis */

  async okdDiag() {
    const r = await api('GET', '/api/okc/devices');
    const list = (r && r.devices) || [];
    if (!list.length) { $('#okdBody').innerHTML = '<div class="card"><div class="empty">Tanımlı ÖKC yok</div></div>'; return; }
    const id = this._okdDiagId || list[0].id;
    this._okdDiagId = id;

    const d = await api('POST', `/api/okc/devices/${id}/diagnostics`, {});
    $('#okdBody').innerHTML = `
      <div class="field" style="max-width:340px"><label>Cihaz</label>
        <select class="input" id="okcDiagPick">${list.map(x => `<option value="${x.id}"${x.id === id ? ' selected' : ''}>
          ${esc((x.registry && x.registry.brand_model) || x.provider)} · ${esc(x.serial || '')}</option>`).join('')}</select></div>
      <div class="alert alert--info" style="margin-bottom:14px">
        Bu kontrollerin hiçbiri cihaza komut göndermez. Cihaz üzerinde etkisi olan bir
        test çalıştırılmadı.</div>
      <table class="tbl"><thead><tr><th>Kontrol</th><th>Sonuç</th><th>Ayrıntı</th></tr></thead><tbody>
        ${d.checks.map(c => `<tr>
          <td><b>${esc(c.name)}</b></td>
          <td>${c.pass ? '<span class="badge badge--open">tamam</span>'
                       : '<span class="badge">eksik</span>'}</td>
          <td class="muted" style="font-size:12.5px">${esc(c.detail)}</td></tr>`).join('')}
      </tbody></table>
      ${d.adapter ? `<div class="card" style="margin-top:16px">
        <b style="font-size:14px">Adaptör</b>
        <pre class="mono" style="background:var(--surface-2);border:1px solid var(--line);border-radius:10px;
          padding:12px;overflow:auto;font-size:12.5px;margin:10px 0 0;white-space:pre-wrap">${esc(JSON.stringify(d.adapter, null, 2))}</pre>
      </div>` : ''}`;

    $('#okcDiagPick').onchange = (e) => { this._okdDiagId = Number(e.target.value); this.okdDiag(); };
  },

});
