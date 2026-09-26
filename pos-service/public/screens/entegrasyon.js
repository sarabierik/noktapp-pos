/* =====================================================================
   NOKTApp POS - Entegrasyonlar: Uber Eats Trendyol Go, Yemeksepeti,
                                  Migros Yemek, Getir (eski)
   =====================================================================
   Four platforms, one screen, four tabs - because they are four different
   questions and a restaurant asks them at four different moments:

     Bağlantılar   once, when the platform is first connected. Credentials,
                   stage or production, which branch, who accepts the order,
                   which printer it comes out of.
     Siparişler    every few minutes, all evening. What came in, from where,
                   what has to be done with it now.
     Eşleştirme    once at the start and then whenever the menu changes. Which
                   of our products is which of theirs - and, more usefully,
                   which of theirs is nobody's.
     Günlük        when something has gone wrong. Every sync, every action,
                   every failed event, with a button to try it again.

   Same visual grammar as the rest of the till: .card, .tbl, .stat, .field,
   .badge, .alert, .zone-tab, one accent (orange) and nothing green. A working
   connection is graphite; orange is reserved for the two things that want a
   person - an unmapped product and a connection in error.

   A CREDENTIAL IS NEVER SHOWN. The service does not return one and this file
   does not ask for one: every secret field is empty on open, and leaving it
   empty means "leave what is stored alone". The masked hint under the form is
   how you tell which key is in there.
   ===================================================================== */
'use strict';

registerIcon('entegrasyon',
  '<path d="M4 7h6a2 2 0 012 2v6a2 2 0 002 2h4"/><rect x="2.5" y="4.5" width="5" height="5" rx="1.5"/>' +
  '<rect x="16.5" y="14.5" width="5" height="5" rx="1.5"/><path d="M12 4.5h9.5"/>');

registerPage({ id: 'entegrasyon', label: 'Entegrasyon', icon: 'entegrasyon',
  perm: 'integration.order', group: 'isletme' }, 'cihazlar');

/* Declared the way search-index.js declares everything else: `tab` is the key
   this screen's own tab strip uses, and the keywords are what somebody types
   INSTEAD of the label - the platform's name, nearly always. */
registerSearch([
  { page: 'entegrasyon', tab: 'baglantilar', label: 'Yemek platformu bağlantıları',
    area: 'Entegrasyon', perm: 'integration.manage',
    keywords: ['trendyol', 'trendyol go', 'uber eats', 'tgo', 'yemeksepeti', 'migros yemek',
      'getir', 'galaxy', 'api anahtarı', 'entegrasyon', 'platform'] },
  { page: 'entegrasyon', tab: 'siparisler', label: 'Platform siparişleri',
    area: 'Entegrasyon', perm: 'integration.order',
    keywords: ['paket sipariş', 'online sipariş', 'siparişi onayla', 'reddet', 'kurye',
      'gel al', 'kapıda ödeme'] },
  { page: 'entegrasyon', tab: 'eslestirme', label: 'Ürün eşleştirme ve menü gönderimi',
    area: 'Entegrasyon', perm: 'integration.manage',
    keywords: ['menü gönder', 'eşleştirme', 'platformda kapat', 'ürün kapat', 'stok bitti',
      'platform fiyatı'] },
  { page: 'entegrasyon', tab: 'gunluk', label: 'Entegrasyon günlüğü',
    area: 'Entegrasyon', perm: 'integration.order',
    keywords: ['entegrasyon hatası', 'kuyruk', 'yeniden dene', 'sipariş gelmiyor'] },
]);

/* ------------------------------------------------------------ helpers */

function entWhen(s) {
  if (!s) return '—';
  const t = String(s).replace('T', ' ').slice(0, 16);
  const [d, hm] = t.split(' ');
  const p = d.split('-');
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}${hm ? ' ' + hm : ''}` : t;
}

function entAgo(s) {
  if (!s) return 'hiç';
  const secs = Math.floor((Date.now() - new Date(String(s).replace(' ', 'T')).getTime()) / 1000);
  if (!Number.isFinite(secs) || secs < 0) return entWhen(s);
  if (secs < 60) return 'az önce';
  if (secs < 3600) return Math.floor(secs / 60) + ' dakika önce';
  if (secs < 86400) return Math.floor(secs / 3600) + ' saat önce';
  return Math.floor(secs / 86400) + ' gün önce';
}

const entTl = (v) => (Number(v) || 0).toFixed(2);

/* The three states a connection can be in, in the owner's words. A healthy
   one is graphite: only "error" earns the orange badge, because only it wants
   somebody to stop what they are doing. */
const ENT_STATE = {
  connected: ['badge--closed', 'Bağlı'],
  disconnected: ['badge--gray', 'Bağlı değil'],
  error: ['badge--open', 'Hata'],
};

const ENT_ENV = { simulator: 'Simülasyon', stage: 'Test', production: 'Canlı' };
const ENT_ACCEPT = { PROVIDER_TABLET: 'Platform tableti', POS_DIRECT: 'Doğrudan kasa' };
const ENT_FULFIL = { PLATFORM_COURIER: 'Platform kuryesi', RESTAURANT_COURIER: 'Restoran kuryesi', PICKUP: 'Gel-al' };

/* Order status colours follow the same rule: a live order is graphite, one
   that ended badly is orange. Nothing is green anywhere in this product. */
const ENT_ORDER_STATE = {
  RECEIVED: ['badge--open', 'Yeni sipariş'],
  ACCEPTED: ['badge--closed', 'Onaylandı'],
  PREPARING: ['badge--closed', 'Hazırlanıyor'],
  READY: ['badge--closed', 'Hazır'],
  DISPATCHED: ['badge--gray', 'Yola çıktı'],
  DELIVERED: ['badge--gray', 'Teslim edildi'],
  REJECTED: ['badge--open', 'Reddedildi'],
  CANCELLED: ['badge--open', 'İptal edildi'],
};

/* What the buttons on an order row are called, and what they do next. */
const ENT_ACTIONS = [
  ['accept', 'Onayla', 'ACCEPTED'],
  ['preparing', 'Hazırlanıyor', 'PREPARING'],
  ['ready', 'Hazır', 'READY'],
  ['dispatched', 'Yola çıktı', 'DISPATCHED'],
  ['delivered', 'Teslim edildi', 'DELIVERED'],
];

function entStat(label, value, sub, cls) {
  return `<div class="stat"><div class="stat__label">${esc(label)}</div>
    <div class="stat__value${cls ? ' ' + cls : ''}">${value}</div>
    <div class="stat__sub">${sub || ''}</div></div>`;
}

Screens.add({

  _entTab: 'siparisler',
  _entProvider: null,
  _entTimer: null,

  entStopTimers() { if (this._entTimer) { clearInterval(this._entTimer); this._entTimer = null; } },

  /* ==================================================================
     THE PAGE
     ================================================================== */
  async page_entegrasyon(tab) {
    this.entStopTimers();
    if (tab) this._entTab = tab;
    /* A cashier holds integration.order and not integration.manage: they get
       the orders and the log, and the two tabs that hold API secrets are not
       drawn at all rather than drawn and refused. */
    const manage = can('integration.manage');
    if (!manage && (this._entTab === 'baglantilar' || this._entTab === 'eslestirme')) this._entTab = 'siparisler';
    const TABS = [
      ['siparisler', 'Siparişler'],
      ...(manage ? [['baglantilar', 'Bağlantılar'], ['eslestirme', 'Eşleştirme']] : []),
      ['gunluk', 'Günlük'],
    ];
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Entegrasyon</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">Uber Eats Trendyol Go · Yemeksepeti · Migros Yemek · Getir</span>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px" id="entTabs">
        ${TABS.map(([id, label]) => `<button class="zone-tab${this._entTab === id ? ' is-active' : ''}"
          data-t="${id}" data-tab="${id}">${label}</button>`).join('')}
      </div>
      <div id="entBody"><div class="empty">Yükleniyor…</div></div></div>`;

    $$('#entTabs [data-t]').forEach(b => b.onclick = () => this.page_entegrasyon(b.dataset.t));

    const draw = {
      baglantilar: () => this.entConnections(),
      siparisler: () => this.entOrders(),
      eslestirme: () => this.entMapping(),
      gunluk: () => this.entLog(),
    };
    try { await draw[this._entTab](); } catch (e) { err(e); }
  },

  entReload() { return this.page_entegrasyon(this._entTab); },

  /* ==================================================================
     1. BAĞLANTILAR
     ================================================================== */
  async entConnections() {
    const d = await api('GET', '/api/integrations');
    this._entCatalogue = d.providers;

    const dead = d.providers.filter(p => p.connected && p.enabled && p.state === 'error');
    const unmapped = d.providers.reduce((s, p) => s + Number(p.unmapped_products || 0), 0);

    $('#entBody').innerHTML = `
      ${dead.length ? `<div class="alert alert--error" style="margin-bottom:14px">
        <b>${dead.length} bağlantı hata veriyor.</b>
        ${esc(dead.map(p => p.label + ': ' + (p.last_error || 'bilinmeyen hata')).join(' · '))}
        <br><span style="font-size:13px">Kasa çalışmaya devam eder; yalnızca bu platformdan sipariş gelmez.</span>
      </div>` : ''}
      ${d.master_key_source === 'db' ? `<div class="alert alert--warn" style="margin-bottom:14px">
        <b>Şifreleme anahtarı diske yazılamadı.</b>
        Platform anahtarlarınız yine şifreli saklanıyor, ancak anahtar veritabanının içinde durduğu için
        gece yedeği anahtarı da beraberinde götürüyor. NoktAppPOS veri klasörüne yazma izni verin;
        bir sonraki kayıtta anahtar dosyaya taşınır.</div>` : ''}
      ${unmapped ? `<div class="alert alert--warn" style="margin-bottom:14px">
        <b>${unmapped} platform ürünü menünüzde karşılıksız.</b> Otomatik olarak gizli birer ürün
        oluşturuldu; siparişler doğru fiyatla geliyor ama stok ve reçete işlemiyor.
        "Eşleştirme" sekmesinden gerçek ürünlerinizle eşleştirin.</div>` : ''}

      <div class="split-3" style="margin-bottom:14px">
        ${entStat('Bağlı platform', String(d.providers.filter(p => p.enabled && p.state === 'connected').length),
          d.providers.length + ' platform tanımlı')}
        ${entStat('Bekleyen olay', String(d.queue.pending), d.queue.pending ? 'işleniyor' : 'kuyruk boş')}
        ${entStat('Ölü mektup', String(d.queue.dead),
          d.queue.dead ? 'Günlük sekmesinden yeniden deneyin' : 'başarısız olay yok',
          d.queue.dead ? 'is-loss' : '')}
      </div>

      <div id="entCards">${d.providers.map(p => this.entCard(p)).join('')}</div>`;

    $$('#entCards [data-edit]').forEach(b => b.onclick = () => this.entEdit(b.dataset.edit));
    $$('#entCards [data-test]').forEach(b => b.onclick = () => this.entTest(b.dataset.test));
    $$('#entCards [data-toggle]').forEach(b => b.onclick = () => this.entToggle(b.dataset.toggle, b.dataset.on === '1'));
    $$('#entCards [data-open]').forEach(b => b.onclick = () => this.entRestaurantOpen(b.dataset.open, b.dataset.state === '1'));
    $$('#entCards [data-poll]').forEach(b => b.onclick = () => this.entPollNow(b.dataset.poll));
  },

  /**
   * One platform, as a card.
   *
   * The four things an owner actually looks at are on the face of it and not
   * behind a dialog: is it on, when did it last work, which key is in there
   * (masked), and is the restaurant open on that platform right now.
   */
  entCard(p) {
    const [cls, label] = ENT_STATE[p.state] || ENT_STATE.disconnected;
    const health = p.health || {};
    const unverified = (health.adapter && health.adapter.unverifiedOperations) || [];
    return `<div class="card" style="margin-bottom:14px${p.state === 'error' ? ';border-color:var(--orange)' : ''}">
      <div class="card__head">
        <h3>${esc(p.label)}</h3>
        <span class="badge ${cls}">${label}</span>
        ${p.connected ? `<span class="badge badge--gray">${esc(ENT_ENV[p.environment] || p.environment)}</span>` : ''}
        ${p.legacy ? '<span class="badge badge--gray">Eski bağlantı</span>' : ''}
        <div class="spacer"></div>
        ${p.connected && p.enabled ? `<button class="btn btn--ghost btn--sm" data-poll="${p.key}">Şimdi çek</button>` : ''}
        ${p.connected ? `<button class="btn btn--ghost btn--sm" data-test="${p.key}">Bağlantıyı test et</button>` : ''}
        <button class="btn btn--ghost btn--sm" data-edit="${p.key}">${p.connected ? 'Düzenle' : 'Bağlan'}</button>
        ${p.connected ? `<button class="btn ${p.enabled ? 'btn--ghost' : 'btn--primary'} btn--sm"
          data-toggle="${p.key}" data-on="${p.enabled ? '0' : '1'}">${p.enabled ? 'Kapat' : 'Aç'}</button>` : ''}
      </div>
      <div class="card__body">
        <p class="muted" style="margin-top:0;font-size:13.5px">${esc(p.note)}</p>
        ${p.connected ? `
          <div class="split-4" style="margin-bottom:10px">
            <div class="field"><label>Son başarılı işlem</label>
              <div class="strong">${entAgo(p.last_ok_at)}</div>
              <div class="muted mono" style="font-size:11.5px">${entWhen(p.last_ok_at)}</div></div>
            <div class="field"><label>Son menü gönderimi</label>
              <div class="strong">${entAgo(p.last_sync_at)}</div>
              <div class="muted mono" style="font-size:11.5px">${entWhen(p.last_sync_at)}</div></div>
            <div class="field"><label>Sipariş kabulü</label>
              <div class="strong">${esc(ENT_ACCEPT[p.acceptance_mode] || p.acceptance_mode)}</div>
              <div class="muted" style="font-size:11.5px">${p.auto_accept ? 'otomatik onay açık' : 'elle onaylanır'}</div></div>
            <div class="field"><label>Hazırlama süresi</label>
              <div class="strong">${p.default_prep_minutes} dakika</div>
              <div class="muted" style="font-size:11.5px">teslimat ${p.delivery_minutes} dakika</div></div>
          </div>
          <div class="split-3" style="margin-bottom:10px">
            <div class="field"><label>Mağaza / restoran kimliği</label>
              <div class="mono">${esc(p.provider_store_id || '—')}</div></div>
            <div class="field"><label>Tedarikçi / zincir</label>
              <div class="mono">${esc(p.supplier_id || p.chain_id || '—')}</div></div>
            <div class="field"><label>Kayıtlı kimlik bilgileri</label>
              <div class="mono" style="font-size:12px">${esc(p.cred_hint || 'yok')}</div></div>
          </div>
          <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
            <span class="muted" style="font-size:13px">Restoran bu platformda:</span>
            <span class="badge ${p.restaurant_open ? 'badge--closed' : 'badge--open'}">${p.restaurant_open ? 'Açık' : 'Kapalı'}</span>
            <button class="btn btn--ghost btn--sm" data-open="${p.key}" data-state="${p.restaurant_open ? '0' : '1'}">
              ${p.restaurant_open ? 'Kapat' : 'Aç'}</button>
            ${p.unmapped_products ? `<span class="badge badge--open">${p.unmapped_products} eşleşmemiş ürün</span>` : ''}
          </div>
          ${p.last_error ? `<div class="alert alert--error" style="margin-top:10px">
            <b>Son hata (${entWhen(p.last_error_at)}):</b> ${esc(p.last_error)}</div>` : ''}
          ${unverified.length ? `<div class="alert alert--info" style="margin-top:10px">
            <b>Bu platformda ${unverified.length} işlemin resmî uç nokta tanımı elimizde yok.</b>
            Simülasyon kipinde çalışırlar; canlıda "Uç noktalar" bölümüne iş ortağı dokümanındaki
            adresleri girene kadar bu işlemler <span class="mono">AWAITING_PARTNER_SPEC</span> yanıtı verir.
            <div class="muted mono" style="font-size:11.5px;margin-top:4px">${esc(unverified.join(', '))}</div>
          </div>` : ''}
        ` : `<div class="muted" style="font-size:13.5px">Henüz bağlanmadı.
          "Bağlan" ile mağaza kimliğini ve API anahtarlarını girin. Anahtarlar şifrelenerek saklanır
          ve bir daha ekranda gösterilmez.</div>`}
      </div>
    </div>`;
  },

  /**
   * The connection form.
   *
   * Secret fields open EMPTY and say why. There is no endpoint that returns a
   * stored secret - not for an administrator either - so a form pre-filled
   * with dots would be a lie about what the browser holds.
   */
  async entEdit(providerKey) {
    const d = this._entCatalogue.find(p => p.key === providerKey);
    if (!d) return;
    const stations = await api('GET', '/api/settings/stations').catch(() => ({ stations: [] }));
    const stationOpts = (stations.stations || []).map(s =>
      `<option value="${s.id}"${Number(d.station_id) === Number(s.id) ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    const receiptOpts = (stations.stations || []).map(s =>
      `<option value="${s.id}"${Number(d.receipt_station_id) === Number(s.id) ? ' selected' : ''}>${esc(s.name)}</option>`).join('');

    const field = (f) => {
      if (f.column) return '';
      return `<div class="field">
        <label>${esc(f.label)}${f.required ? ' *' : ''}</label>
        <input class="input" id="entF_${f.key}" ${f.secret ? 'type="password" autocomplete="new-password"' : ''}
          placeholder="${esc(f.placeholder || (f.secret ? 'Değiştirmek için yazın' : ''))}">
        ${f.secret ? '<span class="muted" style="font-size:11.5px">Boş bırakırsanız kayıtlı anahtar korunur.</span>' : ''}
      </div>`;
    };

    modal(`
      <div class="modal__head"><h3>${esc(d.label)}</h3><div class="spacer"></div>
        <span class="badge badge--gray">${esc(d.transport === 'polling' ? 'Periyodik sorgu' : 'Webhook')}</span></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">${esc(d.note)}</p>
        <div id="entFormAlert"></div>

        <div class="split-2">
          <div class="field"><label>Ortam</label>
            <select class="input" id="entEnv">${d.environments.map(e =>
              `<option value="${e}"${d.environment === e ? ' selected' : ''}>${esc(ENT_ENV[e] || e)}</option>`).join('')}</select>
            <span class="muted" style="font-size:11.5px">Simülasyon, iş ortağı anahtarı gelmeden her şeyi
              denemenizi sağlar; hiçbir ağ isteği yapılmaz.</span></div>
          <div class="field"><label>Şube</label>
            <input class="input" id="entBranch" type="number" min="1" value="1">
            <span class="muted" style="font-size:11.5px">Tek kurulum tek şubedir. Zincirde her şubenin
              kendi mağaza kimliği ve anahtarı olur.</span></div>
        </div>

        <div class="split-3">
          ${d.fields.filter(f => f.column === 'provider_store_id').length ? `<div class="field">
            <label>Mağaza / restoran kimliği *</label>
            <input class="input" id="entStore" value="${esc(d.provider_store_id || '')}"></div>` : ''}
          ${d.fields.filter(f => f.column === 'supplier_id').length ? `<div class="field">
            <label>${esc((d.fields.find(f => f.column === 'supplier_id') || {}).label || 'Tedarikçi kimliği')}</label>
            <input class="input" id="entSupplier" value="${esc(d.supplier_id || '')}"></div>` : ''}
          ${d.fields.filter(f => f.column === 'chain_id').length ? `<div class="field">
            <label>${esc((d.fields.find(f => f.column === 'chain_id') || {}).label || 'Grup kimliği')}</label>
            <input class="input" id="entChain" value="${esc(d.chain_id || '')}"></div>` : ''}
        </div>

        <h4 style="margin:16px 0 6px;font-size:14px">Kimlik bilgileri</h4>
        <div class="split-2">${d.fields.map(field).join('')}</div>
        ${d.cred_hint ? `<div class="muted mono" style="font-size:12px">Kayıtlı: ${esc(d.cred_hint)}</div>` : ''}

        <h4 style="margin:16px 0 6px;font-size:14px">Çalışma biçimi</h4>
        <div class="split-4">
          <div class="field"><label>Sipariş kabulü</label>
            <select class="input" id="entAccept">${(d.acceptanceModes || []).map(m =>
              `<option value="${m}"${d.acceptance_mode === m ? ' selected' : ''}>${esc(ENT_ACCEPT[m])}</option>`).join('')}</select>
            <span class="muted" style="font-size:11.5px">Tablet: siparişi platformun cihazında onaylarsınız.
              Doğrudan kasa: onay bu ekrandan verilir.</span></div>
          <div class="field"><label>Otomatik onay</label>
            <select class="input" id="entAuto">
              <option value="0"${d.auto_accept ? '' : ' selected'}>Kapalı - elle onaylanır</option>
              <option value="1"${d.auto_accept ? ' selected' : ''}>Açık - gelen sipariş onaylanır</option>
            </select></div>
          <div class="field"><label>Hazırlama süresi (dk)</label>
            <input class="input" id="entPrep" type="number" min="1" max="240" value="${d.default_prep_minutes}"></div>
          <div class="field"><label>Teslimat süresi (dk)</label>
            <input class="input" id="entDelivery" type="number" min="1" max="240" value="${d.delivery_minutes}"></div>
        </div>
        <div class="split-2">
          <div class="field"><label>Sorgu aralığı (saniye)</label>
            <input class="input" id="entPoll" type="number" min="5" max="10" value="${d.poll_interval_sec}">
            <span class="muted" style="font-size:11.5px">5-10 saniye. Sorgu tedarikçi genelinde yapılır,
              şube başına ayrı sorgu açılmaz.</span></div>
          <div class="field"><label>Mutfak fişi istasyonu</label>
            <select class="input" id="entStation"><option value="">Varsayılan</option>${stationOpts}</select>
            <span class="muted" style="font-size:11.5px">Boş bırakılırsa ürünün kendi kategorisinin
              istasyonu kullanılır - kasadaki adisyonla aynı kural.</span></div>
        </div>
        <div class="split-2">
          <div class="field"><label>Paket fişi yazıcısı</label>
            <select class="input" id="entReceiptStation"><option value="">Kasanın fiş yazıcısı</option>${receiptOpts}</select>
            <span class="muted" style="font-size:11.5px">Paket fişi ve iptal bildirimi bu istasyonun
              yazıcısından çıkar. Boş bırakılırsa kasanın kendi fiş yazıcısı kullanılır.</span></div>
        </div>

        <details style="margin-top:14px">
          <summary class="muted" style="cursor:pointer;font-size:13px">Uç noktalar (iş ortağı dokümanından)</summary>
          <p class="muted" style="font-size:12.5px">Resmî dokümanı yayımlanmayan işlemler için adresleri
            buraya girin. Her satır <span class="mono">işlem = /yol/{orderId}</span> biçimindedir. Girilmeyen
            işlemler <span class="mono">AWAITING_PARTNER_SPEC</span> yanıtı verir - uydurulmuş bir adrese
            istek atılmaz.</p>
          <textarea class="input" id="entPaths" rows="5" placeholder="accept = /orders/{orderId}/accept
reject = /orders/{orderId}/reject
markReady = /orders/{orderId}/ready"></textarea>
        </details>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="entSave">Kaydet</button>
      </div>`, { wide: true });

    $('#entSave').onclick = async () => {
      const body = {
        environment: $('#entEnv').value,
        branch_id: Number($('#entBranch').value) || 1,
        acceptance_mode: $('#entAccept') ? $('#entAccept').value : undefined,
        auto_accept: $('#entAuto').value === '1',
        default_prep_minutes: Number($('#entPrep').value),
        delivery_minutes: Number($('#entDelivery').value),
        poll_interval_sec: Number($('#entPoll').value),
        station_id: $('#entStation').value || null,
        receipt_station_id: $('#entReceiptStation').value || null,
      };
      if ($('#entStore')) body.provider_store_id = $('#entStore').value.trim();
      if ($('#entSupplier')) body.supplier_id = $('#entSupplier').value.trim();
      if ($('#entChain')) body.chain_id = $('#entChain').value.trim();
      for (const f of d.fields) {
        if (f.column) continue;
        const el = $('#entF_' + f.key);
        if (el && el.value.trim()) body[f.key] = el.value.trim();
      }
      const raw = ($('#entPaths').value || '').trim();
      if (raw) {
        const paths = {};
        for (const line of raw.split('\n')) {
          const [k, ...rest] = line.split('=');
          if (k && rest.length) paths[k.trim()] = rest.join('=').trim();
        }
        body.paths = paths;
      }
      try {
        await api('POST', `/api/integrations/${d.key}/connection`, body);
        closeModal(); toast('Bağlantı kaydedildi'); this.entReload();
      } catch (e) {
        $('#entFormAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`;
      }
    };
  },

  async entTest(providerKey) {
    try {
      const r = await api('POST', `/api/integrations/${providerKey}/test`, {});
      const t = r.test;
      modal(`<div class="modal__head"><h3>Bağlantı testi</h3></div>
        <div class="modal__body">
          <div class="alert ${t.ok ? 'alert--ok' : 'alert--error'}">
            <b>${t.ok ? 'Bağlantı çalışıyor.' : 'Bağlantı kurulamadı.'}</b><br>
            ${esc(t.message || '')}
            ${t.code ? `<div class="mono" style="font-size:12px;margin-top:6px">${esc(t.code)}</div>` : ''}
          </div>
          ${t.code === 'AWAITING_PARTNER_SPEC' ? `<p class="muted" style="font-size:13px">
            Bu platformun resmî uç nokta dokümanı yayımlanmıyor. Kimlik bilgileriniz kaydedildi;
            iş ortağı paketindeki adresleri "Uç noktalar" bölümüne girdiğinizde canlıya alınabilir.</p>` : ''}
        </div>
        <div class="modal__foot"><button class="btn btn--primary" data-close="1">Tamam</button></div>`);
      this.entReload();
    } catch (e) { err(e); }
  },

  async entToggle(providerKey, on) {
    try {
      await api('POST', `/api/integrations/${providerKey}/enable`, { enabled: on });
      toast(on ? 'Bağlantı açıldı' : 'Bağlantı kapatıldı');
      this.entReload();
    } catch (e) { err(e); }
  },

  async entRestaurantOpen(providerKey, open) {
    if (!open) {
      const yes = await confirmBox('Restoranı kapat',
        'Bu platformda yeni sipariş alınmayacak. Açık siparişler etkilenmez.', true);
      if (!yes) return;
    }
    try {
      const r = await api('POST', `/api/integrations/${providerKey}/restaurant-open`, { open });
      if (!r.result.ok) toast('Kasada kaydedildi, platforma bildirilemedi: ' + r.result.message, 'error');
      else toast(open ? 'Restoran açıldı' : 'Restoran kapatıldı');
      this.entReload();
    } catch (e) { err(e); }
  },

  async entPollNow(providerKey) {
    try {
      const r = await api('POST', '/api/integrations/poll', { provider: providerKey });
      const got = (r.polled || []).reduce((s, p) => s + Number(p.queued || 0), 0);
      toast(got ? `${got} yeni sipariş alındı` : 'Yeni sipariş yok');
      this.entReload();
    } catch (e) { err(e); }
  },

  /* ==================================================================
     2. SİPARİŞLER
     ================================================================== */
  async entOrders(state) {
    if (state !== undefined) this._entOrderState = state;
    const st = this._entOrderState || '';
    const d = await api('GET', '/api/integrations/orders?limit=80' + (st ? '&state=' + st : ''));

    const FILTERS = [['', 'Tümü'], ['RECEIVED', 'Yeni'], ['ACCEPTED', 'Onaylı'],
      ['PREPARING', 'Hazırlanıyor'], ['READY', 'Hazır'], ['DISPATCHED', 'Yolda'],
      ['DELIVERED', 'Teslim'], ['CANCELLED', 'İptal']];

    $('#entBody').innerHTML = `
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px" id="entFilters">
        ${FILTERS.map(([k, l]) => `<button class="zone-tab${st === k ? ' is-active' : ''}"
          data-s="${k}">${l}</button>`).join('')}
        <div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="entRefresh">Yenile</button>
      </div>
      <div class="card"><div class="card__body" style="padding:0">${
        d.rows.length ? `<table class="tbl">
          <thead><tr><th>Sipariş</th><th>Platform</th><th>Tutar</th><th>Ödeme</th>
            <th>Teslimat</th><th>Durum</th><th>Geldi</th><th></th></tr></thead>
          <tbody>${d.rows.map(o => this.entOrderRow(o)).join('')}</tbody></table>`
        : `<div class="empty">Platform siparişi yok.<br>
             <span style="font-size:13px">Bağlantı açıksa siparişler birkaç saniye içinde buraya düşer.</span></div>`}
      </div></div>`;

    $$('#entFilters [data-s]').forEach(b => b.onclick = () => this.entOrders(b.dataset.s));
    $('#entRefresh').onclick = () => this.entOrders();
    $$('#entBody [data-detail]').forEach(b => b.onclick = () => this.entOrderDetail(b.dataset.detail));
    $$('#entBody [data-act]').forEach(b => b.onclick = () =>
      this.entAct(b.dataset.id, b.dataset.act, b.dataset.label));

    /* The list refreshes itself: a new order arriving on a screen nobody is
       touching is the whole point of the integration. */
    this.entStopTimers();
    this._entTimer = setInterval(() => {
      if (!$('#entFilters')) return this.entStopTimers();
      this.entOrders().catch(() => {});
    }, 20000);
  },

  entOrderRow(o) {
    const [cls, label] = ENT_ORDER_STATE[o.status] || ENT_ORDER_STATE.RECEIVED;
    const next = ENT_ACTIONS.find(a => a[2] === this.entNextOf(o.status));
    return `<tr>
      <td><div class="strong">${esc(o.external_no || o.external_order_id)}</div>
        <div class="muted mono" style="font-size:11.5px">${o.adisyon_no ? 'Adisyon #' + o.adisyon_no : 'adisyon bekliyor'}</div></td>
      <td>${esc(({ UBER_EATS_TGO: 'Trendyol Go', YEMEKSEPETI: 'Yemeksepeti',
          MIGROS_YEMEK: 'Migros Yemek', GETIR_YEMEK: 'Getir' })[o.provider] || o.provider)}
        ${o.source_application ? `<div class="muted" style="font-size:11.5px">${esc(o.source_application)}</div>` : ''}</td>
      <td class="mono">${entTl(o.provider_total)}
        ${Number(o.delivery_charge) ? `<div class="muted" style="font-size:11.5px">teslimat ${entTl(o.delivery_charge)}</div>` : ''}</td>
      <td>${o.is_prepaid ? '<span class="badge badge--gray">Ödendi</span>'
        : `<span class="badge badge--open">Kapıda</span>`}
        <div class="muted" style="font-size:11.5px">${esc(o.payment_type || '—')}</div></td>
      <td>${esc(ENT_FULFIL[o.fulfillment_type] || '—')}
        ${o.scheduled_at ? `<div class="muted" style="font-size:11.5px">ileri tarihli ${entWhen(o.scheduled_at)}</div>` : ''}</td>
      <td><span class="badge ${cls}">${label}</span>
        ${o.unmapped_count ? `<div class="muted" style="font-size:11.5px">${o.unmapped_count} eşleşmemiş ürün</div>` : ''}</td>
      <td>${entWhen(o.received_at)}<div class="muted" style="font-size:11.5px">${entAgo(o.received_at)}</div></td>
      <td class="right" style="white-space:nowrap">
        ${next ? `<button class="btn btn--primary btn--sm" data-id="${o.id}" data-act="${next[0]}"
          data-label="${esc(next[1])}">${next[1]}</button>` : ''}
        ${o.status === 'RECEIVED' ? `<button class="btn btn--ghost btn--sm" data-id="${o.id}" data-act="reject"
          data-label="Reddet">Reddet</button>` : ''}
        <button class="btn btn--ghost btn--sm" data-detail="${o.id}">Ayrıntı</button>
      </td></tr>`;
  },

  /** The single most useful next step for an order in this state. */
  entNextOf(status) {
    return ({ RECEIVED: 'ACCEPTED', ACCEPTED: 'PREPARING', PREPARING: 'READY',
      READY: 'DISPATCHED', DISPATCHED: 'DELIVERED' })[status] || null;
  },

  async entAct(id, action, label) {
    if (action === 'reject') return this.entReject(id);
    if (action === 'accept') return this.entAccept(id);
    try {
      await api('POST', `/api/integrations/orders/${id}/${action}`, {});
      toast(label + ' olarak işaretlendi');
      this.entOrders();
    } catch (e) { err(e); }
  },

  async entAccept(id) {
    modal(`<div class="modal__head"><h3>Siparişi onayla</h3></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">Hazırlama süresi platforma bildirilir ve müşteriye
          gösterilir. Onaylandığı anda mutfak fişi ve paket fişi bir kez basılır.</p>
        <div class="field"><label>Hazırlama süresi (dakika)</label>
          <input class="input" id="entAcceptPrep" type="number" min="1" max="240" value="20"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="entAcceptOk">Onayla</button></div>`);
    $('#entAcceptOk').onclick = async () => {
      try {
        await api('POST', `/api/integrations/orders/${id}/accept`,
          { prep_minutes: Number($('#entAcceptPrep').value) || 20 });
        closeModal(); toast('Sipariş onaylandı'); this.entOrders();
      } catch (e) { err(e); }
    };
  },

  async entReject(id) {
    const REASONS = [
      ['ITEM_OUT_OF_STOCK', 'Üründe stok yok'],
      ['KITCHEN_BUSY', 'Mutfak çok yoğun'],
      ['CLOSING_SOON', 'Kapanış saati'],
      ['TECHNICAL_PROBLEM', 'Teknik sorun'],
      ['DELIVERY_AREA', 'Teslimat bölgesi dışında'],
      ['OTHER', 'Diğer'],
    ];
    modal(`<div class="modal__head"><h3>Siparişi reddet</h3></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">Platformlar yalnızca onaylı sebep kodlarını kabul eder.
          Reddedilen sipariş kasada da silinir ve stok geri alınır.</p>
        <div class="field"><label>Sebep</label>
          <select class="input" id="entRejReason">${REASONS.map(([k, l]) =>
            `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div class="field"><label>Açıklama (isteğe bağlı)</label>
          <input class="input" id="entRejNote" maxlength="190"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--danger" id="entRejOk">Reddet</button></div>`);
    $('#entRejOk').onclick = async () => {
      try {
        await api('POST', `/api/integrations/orders/${id}/reject`,
          { reason_code: $('#entRejReason').value, reason: $('#entRejNote').value });
        closeModal(); toast('Sipariş reddedildi'); this.entOrders();
      } catch (e) { err(e); }
    };
  },

  async entOrderDetail(id) {
    const d = await api('GET', `/api/integrations/orders/${id}`);
    const o = d.order;
    const [cls, label] = ENT_ORDER_STATE[o.status] || ENT_ORDER_STATE.RECEIVED;
    modal(`
      <div class="modal__head"><h3>${esc(o.external_no || o.external_order_id)}</h3>
        <span class="badge ${cls}">${label}</span>
        ${o.source_application ? `<span class="badge badge--gray">${esc(o.source_application)}</span>` : ''}
        <div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="entReprint">Fişi yeniden bas</button></div>
      <div class="modal__body">
        <div class="split-4" style="margin-bottom:12px">
          ${entStat('Platform tutarı', entTl(o.provider_total), o.is_prepaid ? 'platformda ödendi' : 'kapıda ödeme')}
          ${entStat('Teslimat', entTl(o.delivery_charge), esc(ENT_FULFIL[o.fulfillment_type] || '—'))}
          ${entStat('Kampanya', entTl(Number(o.promotion_total) + Number(o.coupon_total)),
            'kupon ' + entTl(o.coupon_total))}
          ${entStat('Adisyon', o.adisyon_no ? '#' + o.adisyon_no : '—',
            d.bill ? entTl(d.bill.grand_total) + ' kasa toplamı' : 'adisyon yok')}
        </div>
        <div class="split-2" style="margin-bottom:12px">
          <div class="field"><label>Müşteri (maskeli)</label>
            <div>${esc(o.customer_label || '—')} · <span class="mono">${esc(o.customer_phone || '—')}</span></div>
            <div class="muted" style="font-size:12px">${esc(o.address_label || 'adres platformda')}</div></div>
          <div class="field"><label>Platform durumu</label>
            <div class="mono">${esc(o.provider_status || '—')}</div>
            <div class="muted" style="font-size:12px">kabul: ${esc(ENT_ACCEPT[o.acceptance_mode] || '—')}</div></div>
        </div>
        ${o.customer_note ? `<div class="alert alert--info" style="margin-bottom:12px">
          <b>Müşteri notu:</b> ${esc(o.customer_note)}</div>` : ''}

        <h4 style="margin:12px 0 6px;font-size:14px">Satırlar</h4>
        <table class="tbl"><thead><tr><th>Ürün</th><th>Adet</th><th>Birim</th><th>Tutar</th><th>Durum</th></tr></thead>
          <tbody>${d.items.map(i => `<tr>
            <td>${esc(i.external_name || '—')}
              ${i.role !== 'item' ? `<span class="badge badge--gray">${i.role === 'fee' ? 'ücret' : 'seçenek'}</span>` : ''}
              ${Number(i.mapped) ? '' : '<span class="badge badge--open">eşleşmemiş</span>'}</td>
            <td class="mono">${Number(i.qty)}</td><td class="mono">${entTl(i.unit_price)}</td>
            <td class="mono">${entTl(i.line_total)}</td>
            <td>${i.status === 'CANCELLED' ? '<span class="badge badge--open">İptal</span>'
              : '<span class="badge badge--gray">Geçerli</span>'}</td></tr>`).join('')}</tbody></table>

        <h4 style="margin:16px 0 6px;font-size:14px">Bu siparişin günlüğü</h4>
        <table class="tbl"><thead><tr><th>Zaman</th><th>İşlem</th><th>Açıklama</th></tr></thead>
          <tbody>${d.logs.map(l => `<tr>
            <td class="mono">${entWhen(l.created_at)}</td>
            <td>${esc(l.action)}</td>
            <td class="${l.level === 'error' ? 'is-loss' : ''}">${esc(l.message)}</td></tr>`).join('')}</tbody></table>
      </div>
      <div class="modal__foot"><button class="btn btn--primary" data-close="1">Kapat</button></div>`,
      { wide: true });

    $('#entReprint').onclick = async () => {
      try {
        await api('POST', `/api/integrations/orders/${id}/reprint`, {});
        toast('Kopya fiş kuyruğa alındı ve günlüğe yazıldı');
      } catch (e) { err(e); }
    };
  },

  /* ==================================================================
     3. EŞLEŞTİRME
     ================================================================== */
  async entMapping(providerKey) {
    if (providerKey) this._entProvider = providerKey;
    const overview = await api('GET', '/api/integrations');
    const connected = overview.providers.filter(p => p.connected);
    if (!connected.length) {
      $('#entBody').innerHTML = `<div class="empty">Önce bir platforma bağlanın.<br>
        <span style="font-size:13px">"Bağlantılar" sekmesinden mağaza kimliğinizi ve anahtarlarınızı girin.</span></div>`;
      return;
    }
    if (!this._entProvider || !connected.find(p => p.key === this._entProvider)) {
      this._entProvider = connected[0].key;
    }
    const d = await api('GET', `/api/integrations/${this._entProvider}/mapping`);

    /* The server decides what counts as unmapped (a placeholder counts, an
       auto-matched real product does not); the screen just renders it. */
    const unmappedIds = new Set(d.unmapped.map(u => String(u.external_id)));

    const posOptions = (selected) => `<option value="">— eşleşme yok —</option>` +
      d.pos.products.map(p => `<option value="${p.id}"${Number(selected) === Number(p.id) ? ' selected' : ''}
        >${esc(p.name)} (${entTl(p.price)})</option>`).join('');

    $('#entBody').innerHTML = `
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px" id="entMapProv">
        ${connected.map(p => `<button class="zone-tab${this._entProvider === p.key ? ' is-active' : ''}"
          data-p="${p.key}">${esc(p.label)}</button>`).join('')}
        <div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="entAutoMap">Otomatik eşleştir</button>
        <button class="btn btn--primary btn--sm" id="entMenuSync">Menüyü gönder</button>
      </div>

      ${d.unmapped.length ? `<div class="alert alert--warn" style="margin-bottom:14px">
        <b>${d.unmapped.length} platform ürünü menünüzde karşılıksız.</b>
        Siparişler doğru fiyatla geliyor ama bu ürünler için stok düşülmez ve reçete işlemez.
        Aşağıdan gerçek ürününüzü seçin.
        <div class="muted" style="font-size:12.5px;margin-top:4px">${
          esc(d.unmapped.map(u => u.external_name).join(', '))}</div>
      </div>` : ''}

      <div class="card" style="margin-bottom:14px">
        <div class="card__head"><h3>Ürünler</h3><div class="spacer"></div>
          <span class="badge badge--gray">${d.provider_menu.products.length} platform ürünü</span>
          <span class="badge badge--gray">${d.pos.products.length} kasa ürünü</span></div>
        <div class="card__body" style="padding:0"><table class="tbl">
          <thead><tr><th>Platformdaki ürün</th><th>Platform fiyatı</th><th>Kasadaki karşılığı</th>
            <th>Eşleştirme</th></tr></thead>
          <tbody>${d.provider_menu.products.map(p => `<tr>
            <td><div class="strong">${esc(p.name)}</div>
              <div class="muted mono" style="font-size:11.5px">${esc(p.id)}</div></td>
            <td class="mono">${entTl(p.price)}</td>
            <td><select class="input" data-map="product" data-ext="${esc(p.id)}"
                  data-name="${esc(p.name)}">${posOptions(p.local_id)}</select></td>
            <td>${unmappedIds.has(String(p.id))
              ? '<span class="badge badge--open">Eşleşmedi</span>'
              : `<span class="badge badge--closed">${p.mapped_by === 'manual' ? 'Elle' : 'Otomatik'}</span>`}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>

      ${d.provider_menu.modifiers.length ? `<div class="card" style="margin-bottom:14px">
        <div class="card__head"><h3>Seçenekler ve ekstralar</h3><div class="spacer"></div>
          <span class="muted" style="font-size:13px">Bir ürünle eşleştirilen seçenek adisyonda kendi
            satırı olur ve stoktan düşer; eşleşmeyen seçenek satırın notuna yazılır.</span></div>
        <div class="card__body" style="padding:0"><table class="tbl">
          <thead><tr><th>Grup</th><th>Seçenek</th><th>Fiyat</th><th>Kasadaki karşılığı</th></tr></thead>
          <tbody>${d.provider_menu.modifiers.map(m => `<tr>
            <td class="muted">${esc(m.groupName || '—')}</td>
            <td><div class="strong">${esc(m.name)}</div>
              <div class="muted mono" style="font-size:11.5px">${esc(m.id)}</div></td>
            <td class="mono">${entTl(m.price)}</td>
            <td><select class="input" data-map="modifier" data-ext="${esc(m.id)}"
                  data-name="${esc(m.name)}">${posOptions(m.local_id)}</select></td></tr>`).join('')}</tbody>
        </table></div>
      </div>` : ''}

      <div class="card">
        <div class="card__head"><h3>Ürün açık / kapalı</h3><div class="spacer"></div>
          <span class="muted" style="font-size:13px">Biten bir ürünü platformda kapatın; menüyü yeniden
            göndermeye gerek yoktur.</span></div>
        <div class="card__body" style="padding:0"><table class="tbl">
          <thead><tr><th>Kasa ürünü</th><th>Kategori</th><th>Fiyat</th><th></th></tr></thead>
          <tbody>${d.pos.products.map(p => `<tr>
            <td class="strong">${esc(p.name)}</td>
            <td class="muted">${esc(p.category_name)}</td>
            <td class="mono">${entTl(p.price)}</td>
            <td class="right" style="white-space:nowrap">
              <button class="btn btn--ghost btn--sm" data-avail="${p.id}" data-on="0">Platformda kapat</button>
              <button class="btn btn--ghost btn--sm" data-avail="${p.id}" data-on="1">Aç</button>
            </td></tr>`).join('')}</tbody>
        </table></div>
      </div>`;

    $$('#entMapProv [data-p]').forEach(b => b.onclick = () => this.entMapping(b.dataset.p));
    $('#entAutoMap').onclick = () => this.entAutoMap();
    $('#entMenuSync').onclick = () => this.entMenuSync();
    $$('#entBody [data-map]').forEach(sel => sel.onchange = () => this.entSetMap(sel));
    $$('#entBody [data-avail]').forEach(b => b.onclick = () =>
      this.entAvailability(b.dataset.avail, b.dataset.on === '1'));
  },

  async entSetMap(sel) {
    try {
      await api('POST', `/api/integrations/${this._entProvider}/mapping`, {
        entity_type: sel.dataset.map, external_id: sel.dataset.ext,
        external_name: sel.dataset.name, local_id: sel.value ? Number(sel.value) : null,
      });
      toast('Eşleştirme kaydedildi');
    } catch (e) { err(e); this.entMapping(); }
  },

  async entAutoMap() {
    try {
      const r = await api('POST', `/api/integrations/${this._entProvider}/mapping/auto`, {});
      toast(`${r.mapped} ürün eşleşti` +
        (r.ambiguous ? `, ${r.ambiguous} isim birden fazla ürüne uyduğu için atlandı` : '') +
        (r.missed ? `, ${r.missed} ürünün karşılığı yok` : ''));
      this.entMapping();
    } catch (e) { err(e); }
  },

  async entMenuSync() {
    const yes = await confirmBox('Menüyü gönder',
      'Kasadaki menünüz bu platforma gönderilecek. Platformdaki fiyatlar ve ürün listesi ' +
      'kasadakiyle değiştirilir.', false);
    if (!yes) return;
    try {
      const r = await api('POST', `/api/integrations/${this._entProvider}/menu/sync`, {});
      if (r.result.ok) toast(`${r.result.counts.products} ürün gönderildi`);
      else toast('Menü gönderilemedi: ' + r.result.message, 'error');
      this.entMapping();
    } catch (e) { err(e); }
  },

  async entAvailability(productId, available) {
    try {
      const r = await api('POST', `/api/integrations/${this._entProvider}/product/${productId}/availability`,
        { available });
      if (!r.result.ok) toast('Platform bildirimi başarısız: ' + r.result.message, 'error');
      else toast(available ? 'Ürün platformda açıldı' : 'Ürün platformda kapatıldı');
    } catch (e) { err(e); }
  },

  /* ==================================================================
     4. GÜNLÜK
     ================================================================== */
  async entLog(level) {
    if (level !== undefined) this._entLogLevel = level;
    const lv = this._entLogLevel || '';
    const manage = can('integration.manage');
    const logs = await api('GET', '/api/integrations/logs?limit=120' + (lv ? '&level=' + lv : ''));
    const events = manage
      ? await api('GET', '/api/integrations/events?limit=60').catch(() => ({ rows: [] }))
      : { rows: [] };
    const stuck = events.rows.filter(e => e.status === 'dead' || e.status === 'failed');

    $('#entBody').innerHTML = `
      ${stuck.length ? `<div class="card" style="margin-bottom:14px;border-color:var(--orange)">
        <div class="card__head"><h3>İşlenemeyen olaylar</h3><div class="spacer"></div>
          <span class="badge badge--open">${stuck.length}</span>
          <button class="btn btn--primary btn--sm" id="entRetryAll">Hepsini yeniden dene</button></div>
        <div class="card__body" style="padding:0"><table class="tbl">
          <thead><tr><th>Zaman</th><th>Platform</th><th>Sipariş</th><th>Kaynak</th>
            <th>Deneme</th><th>Hata</th><th></th></tr></thead>
          <tbody>${stuck.map(e => `<tr>
            <td class="mono">${entWhen(e.created_at)}</td>
            <td>${esc(e.provider)}</td>
            <td class="mono">${esc(e.external_order_id || '—')}</td>
            <td>${esc(e.source === 'webhook' ? 'Webhook' : 'Sorgu')}
              ${Number(e.signature_ok) ? '' : '<span class="badge badge--open">imzasız</span>'}</td>
            <td class="mono">${e.attempts}</td>
            <td class="is-loss">${esc(e.last_error || '')}</td>
            <td class="right"><button class="btn btn--ghost btn--sm" data-retry="${e.id}">Yeniden dene</button></td>
          </tr>`).join('')}</tbody></table></div>
      </div>` : ''}

      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px" id="entLogLevels">
        ${[['', 'Tümü'], ['info', 'Bilgi'], ['warn', 'Uyarı'], ['error', 'Hata']].map(([k, l]) =>
          `<button class="zone-tab${lv === k ? ' is-active' : ''}" data-l="${k}">${l}</button>`).join('')}
        <div class="spacer"></div>
        <span class="muted" style="font-size:13px">${logs.total} kayıt</span>
      </div>

      <div class="card"><div class="card__body" style="padding:0">${
        logs.rows.length ? `<table class="tbl">
          <thead><tr><th>Zaman</th><th>Platform</th><th>İşlem</th><th>Açıklama</th><th>Yapan</th></tr></thead>
          <tbody>${logs.rows.map(l => `<tr>
            <td class="mono">${entWhen(l.created_at)}</td>
            <td>${esc(l.provider || '—')}</td>
            <td>${esc(l.action || '—')}</td>
            <td class="${l.level === 'error' ? 'is-loss' : ''}">${esc(l.message)}
              ${l.external_order_id ? `<div class="muted mono" style="font-size:11.5px">${esc(l.external_order_id)}</div>` : ''}</td>
            <td class="muted">${esc(l.actor || 'sistem')}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">Henüz kayıt yok.</div>'}
      </div></div>`;

    $$('#entLogLevels [data-l]').forEach(b => b.onclick = () => this.entLog(b.dataset.l));
    $$('#entBody [data-retry]').forEach(b => b.onclick = async () => {
      try { await api('POST', `/api/integrations/events/${b.dataset.retry}/retry`, {}); toast('Yeniden denendi'); this.entLog(); }
      catch (e) { err(e); }
    });
    const all = $('#entRetryAll');
    if (all) {
      all.onclick = async () => {
        try {
          const r = await api('POST', '/api/integrations/events/retry-all', {});
          toast(`${r.requeued} olay yeniden kuyruğa alındı`);
          this.entLog();
        } catch (e) { err(e); }
      };
    }
  },
});
