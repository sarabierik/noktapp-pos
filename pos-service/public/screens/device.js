/* =====================================================================
   NOKTApp POS - Cihazlar: eşleşen telefonlar, adisyon ön ekleri,
                            senkron durumu, bağlantı, işlem günlüğü
   =====================================================================
   Everything on this screen already worked in the service and none of it
   could be seen. A phone was paired by typing a six digit code that only
   existed inside a POST response; a tablet whose access had to be cut could
   not be found; the outbox queued rows nobody could count; the offline
   number prefix - the thing that lets a tablet keep opening bills when the
   router dies - was handed out by a function no screen ever called; and the
   licence quietly counted down to a morning when the till would refuse to
   open, without saying so on any day before that one.

   Two pages:
     Cihazlar        - four tabs, because they are four answers to one
                       question ("the phones stopped working"): which devices
                       exist, which number prefix each holds, what the queue
                       is doing, and whether this PC is reaching anything.
     İşlem günlüğü   - np_app_log, filtered. A support call should start with
                       what actually happened, not with "bir şeyler oldu".

   Same visual grammar as the rest of the till: .card, .tbl, .stat, .field,
   .badge, .alert, .zone-tab. One accent (orange), and nothing is green: a
   healthy queue and a stuck one are told apart by the words and by the
   figures, and red is kept for the two things that genuinely need a person -
   a blocked operation and a licence that has run out.
   ===================================================================== */
'use strict';

registerIcon('cihazlar',
  '<rect x="4" y="2.5" width="11" height="19" rx="2.5"/><path d="M9 18.5h1"/>' +
  '<path d="M17 8h3.5v9a2 2 0 01-2 2H17"/>');
registerIcon('gunluk',
  '<path d="M5 3.5h11l3.5 3.5v13.5H5z"/><path d="M15.5 3.5V7h3.5"/><path d="M8.5 12h7M8.5 16h5"/>');

registerPage({ id: 'cihazlar', label: 'Cihazlar', icon: 'cihazlar', perm: 'settings.manage' , group: 'isletme' }, 'fis');
/* The log is `report.view`, not `settings.manage`: the person who has to
   answer "saat yedide ne oldu" is usually the manager on shift. */
registerPage({ id: 'gunluk', label: 'İşlem günlüğü', icon: 'gunluk', perm: 'report.view' , group: 'isletme' }, 'cihazlar');

/* ------------------------------------------------------------ helpers */

/** "03.09.2026 14:20" from what MariaDB hands back as a string. */
function devWhen(s) {
  if (!s) return '—';
  const t = String(s).replace('T', ' ').slice(0, 16);
  const [d, hm] = t.split(' ');
  const p = d.split('-');
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}${hm ? ' ' + hm : ''}` : t;
}

/** "4 dakika önce" - a timestamp answers "when", this answers "is it alive". */
function devAgo(seconds) {
  if (seconds === null || seconds === undefined) return 'hiç görülmedi';
  const s = Number(seconds);
  if (s < 60) return 'az önce';
  if (s < 3600) return Math.floor(s / 60) + ' dakika önce';
  if (s < 86400) return Math.floor(s / 3600) + ' saat önce';
  return Math.floor(s / 86400) + ' gün önce';
}

function devMinutes(m) {
  const n = Number(m || 0);
  if (n < 1) return 'yeni';
  if (n < 60) return n + ' dakika';
  if (n < 1440) return Math.floor(n / 60) + ' saat';
  return Math.floor(n / 1440) + ' gün';
}

/* A big figure that is a moment in time: today's is a clock, an older one is
   a date. "23:10" alone on a push that happened the day before yesterday is
   the kind of reassurance nobody asked for. */
function devMoment(s) {
  if (!s) return '—';
  const day = String(s).slice(0, 10);
  const today = new Date();
  const iso = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') +
    '-' + String(today.getDate()).padStart(2, '0');
  return day === iso ? String(s).replace('T', ' ').slice(11, 16) : devWhen(s).slice(0, 10);
}

function devStat(label, value, sub, cls) {
  return `<div class="stat"><div class="stat__label">${esc(label)}</div>
    <div class="stat__value${cls ? ' ' + cls : ''}">${value}</div>
    <div class="stat__sub">${sub || ''}</div></div>`;
}

/* The four states a paired device can be in, in the till's own words. A
   working device is graphite, not green - only the two that need a person
   (revoked, expired) get the orange "look at me" badge. */
const DEV_STATE = {
  online: ['badge--closed', 'Bağlı'],
  idle: ['badge--gray', 'Bekliyor'],
  expired: ['badge--open', 'Süresi doldu'],
  revoked: ['badge--open', 'Erişim kesildi'],
};

const DEV_PLATFORM = { android: 'Android', ios: 'iPhone / iPad', windows: 'Windows', web: 'Tarayıcı' };
const devPlatform = (p) => (p ? (DEV_PLATFORM[String(p).toLowerCase()] || p) : 'Bilinmiyor');

const DEV_ROLE = { waiter: 'Garson', cashier: 'Kasiyer', manager: 'Müdür',
  admin: 'Yönetici', superadmin: 'Yönetici' };
const devRole = (r) => (r ? (DEV_ROLE[String(r).toLowerCase()] || r) : '—');

/* The panel's own status words, in the owner's language. */
const DEV_LICENCE = {
  active: 'Etkin', suspended: 'Askıya alındı', expired: 'Süresi doldu',
  cancelled: 'İptal edildi', trial: 'Deneme',
};
const devLicence = (s) => (s ? (DEV_LICENCE[String(s).toLowerCase()] || s) : '—');

const DEV_LEVEL = {
  error: ['badge--open', 'Hata'], warn: ['badge--open', 'Uyarı'],
  info: ['badge--gray', 'Bilgi'], debug: ['badge--gray', 'Ayrıntı'],
};

Screens.add({

  /* Timers live on the screen object, not in the closure, so that leaving the
     page can stop them. A countdown that keeps ticking against elements that
     no longer exist throws once a second into the console for the rest of the
     session. */
  _devTimer: null,
  _devTab: 'liste',

  devStopTimers() {
    if (this._devTimer) { clearInterval(this._devTimer); this._devTimer = null; }
    if (this._devPairWatch) { clearInterval(this._devPairWatch); this._devPairWatch = null; }
  },

  /* ==================================================================
     CİHAZLAR
     ================================================================== */
  async page_cihazlar(tab) {
    this.devStopTimers();
    if (tab) this._devTab = tab;
    /* "Telefonlar", not "Cihazlar": the tab used to repeat the screen's own
       name, and the deleted Ayarlar screen had a tab literally called
       Telefonlar that did half of this. Somebody looking for the phone list
       types telefon, and now the word is on the thing. */
    const TABS = [
      ['liste', 'Telefonlar'],
      ['onek', 'Adisyon ön ekleri'],
      ['senkron', 'Senkron durumu'],
      ['baglanti', 'Bağlantı durumu'],
    ];
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Cihazlar</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">Telefonlar, çevrimdışı numaralar ve bulut bağlantısı</span>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px" id="devTabs">
        ${TABS.map(([id, label]) => `<button class="zone-tab${this._devTab === id ? ' is-active' : ''}"
          data-t="${id}">${label}</button>`).join('')}
      </div>
      <div id="devBody"><div class="empty">Yükleniyor…</div></div></div>`;

    $$('#devTabs [data-t]').forEach(b => b.onclick = () => this.page_cihazlar(b.dataset.t));

    const draw = {
      liste: () => this.devDevices(),
      onek: () => this.devPrefixes(),
      senkron: () => this.devSync(),
      baglanti: () => this.devConnection(),
    };
    try { await draw[this._devTab](); } catch (e) { err(e); }
  },

  /** Redraw the tab you are on, after a write. */
  devReload() { return this.page_cihazlar(this._devTab); },

  /* ---------------------------------------------------------- cihazlar */
  async devDevices() {
    const r = await api('GET', '/api/device/devices');
    const live = (await api('GET', '/api/device/pair-code')).pairing;

    $('#devBody').innerHTML = `
      <div id="devPairBox"></div>
      <div class="card">
        <div class="card__head"><h3>Eşleşen cihazlar</h3><div class="spacer"></div>
          <span class="badge badge--gray">${r.devices.filter(d => !d.revoked_at).length} etkin</span>
          <button class="btn btn--primary btn--sm" id="devPair">Telefon bağla</button></div>
        <div class="card__body" style="padding:0">${
          r.devices.length ? `<table class="tbl">
            <thead><tr><th>Cihaz</th><th>Tür</th><th>Sürüm</th><th>Kullanan</th>
              <th>Ön ek</th><th>Son görülme</th><th>Durum</th><th></th></tr></thead>
            <tbody>${r.devices.map(d => this.devRow(d)).join('')}</tbody></table>`
          : `<div class="empty">Henüz bağlı telefon yok.<br>
               <span style="font-size:13px">"Telefon bağla" deyin, personeli seçin ve çıkan karekodu
               telefondaki NOKTApp Garson uygulamasına okutun. Şifre sorulmaz.</span></div>`}
        </div>
      </div>`;

    $('#devPair').onclick = () => this.devMakePairCode();
    $$('#devBody [data-rename]').forEach(b => b.onclick = () => this.devRename(b.dataset.rename, b.dataset.name));
    $$('#devBody [data-revoke]').forEach(b => b.onclick = () => this.devRevoke(b.dataset.revoke, b.dataset.name));
    $$('#devBody [data-retire]').forEach(b => b.onclick = () =>
      this.devRetire(b.dataset.retire, b.dataset.name, b.dataset.prefix));
    if (live) this.devDrawPairCode(live);
  },

  devRow(d) {
    const [cls, label] = DEV_STATE[d.state] || DEV_STATE.idle;
    return `<tr>
      <td><div class="strong">${esc(d.name)}</div>
        <div class="muted mono" style="font-size:11.5px">${esc(d.device_id)}</div></td>
      <td>${esc(devPlatform(d.platform))}</td>
      <td class="mono">${d.app_version ? esc(d.app_version) : '—'}</td>
      <td>${d.user_name ? esc(d.user_name) : '<span class="muted">—</span>'}</td>
      <td class="mono">${d.prefix === null
        ? '<span class="muted">yok</span>'
        : `<span class="badge badge--gray">${d.prefix}</span>`}</td>
      <td>${devWhen(d.last_seen_at)}<div class="muted" style="font-size:11.5px">${esc(devAgo(d.seconds_since_seen))}</div></td>
      <td><span class="badge ${cls}">${label}</span>${
        d.sessions > 1 ? `<div class="muted" style="font-size:11.5px">${d.sessions} açık oturum</div>` : ''}</td>
      <td class="right" style="white-space:nowrap">
        <button class="btn btn--ghost btn--sm" data-rename="${d.id}" data-name="${esc(d.name)}">Adı değiştir</button>
        ${d.revoked_at ? '' :
          `<button class="btn btn--ghost btn--sm" data-revoke="${d.id}" data-name="${esc(d.name)}">Erişimi kes</button>`}
        <button class="btn btn--ghost btn--sm" data-retire="${d.id}" data-name="${esc(d.name)}"
          data-prefix="${d.prefix === null ? '' : d.prefix}">Emekliye ayır</button>
      </td></tr>`;
  },

  /**
   * "Telefon bağla" - pick the member of staff, then show the symbol.
   *
   * Choosing the person here rather than on the phone is what removes the
   * password from the flow entirely. The owner already knows whose phone is
   * in their hand; making the waiter type a phone password they were never
   * given (waiters are created PIN-only) was the single most common reason a
   * pairing failed.
   */
  async devMakePairCode() {
    let staff = [];
    try { staff = (await api('GET', '/api/device/pair-staff')).staff || []; } catch (_) {}

    modal(`
      <div class="modal__head"><h3>Telefon bağla</h3></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">Telefon kimin adına bağlanacak? Seçtiğiniz kişinin
          yetkileri telefonda da aynen geçerli olur.</p>
        <div class="field"><label>Personel</label>
          <select class="input" id="devPairFor">
            ${staff.map(u => `<option value="${u.id}">${esc(u.name)} — ${esc(devRole(u.role))}</option>`).join('')}
            <option value="">Genel kod (telefon kullanıcı adı ve şifre soracak)</option>
          </select></div>
        ${staff.length ? '' : `<div class="alert alert--warn" style="margin-bottom:0">
          Bağlanabilecek personel bulunamadı. Ayarlar &gt; Kullanıcılar ekranından
          garson ekleyin.</div>`}
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="devPairGo">Karekodu göster</button>
      </div>`);

    $('#devPairGo').onclick = async () => {
      const forUser = $('#devPairFor').value;
      try {
        const r = await api('POST', '/api/device/pair-code', forUser ? { for_user_id: Number(forUser) } : {});
        closeModal();
        this.devDrawPairCode(r.pairing);
        const box = $('#devPairBox');
        if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (e) { err(e); }
    };
  },

  /**
   * The symbol, the six digits under it, and the seconds it has left.
   *
   * The countdown is not decoration. The code lives ten minutes and the waiter
   * is walking over from the other end of the room; without a visible clock
   * the first thing anybody learns about the expiry is that pairing failed.
   *
   * The digits stay on screen next to the QR rather than behind a "or type it"
   * link: a cracked camera, a phone that will not focus on a glossy screen and
   * a tablet with no camera at all are all ordinary, and on those the typed
   * path is not a fallback, it is the path.
   */
  devDrawPairCode(p) {
    this.devStopTimers();
    const who = p.for_user
      ? `<b>${esc(p.for_user.name)}</b> adına`
      : '<b>genel</b> (telefon kullanıcı adı ve şifre soracak)';

    $('#devPairBox').innerHTML = `
      <div class="card" style="margin-bottom:14px;border-color:var(--orange)">
        <div class="card__head"><h3>Telefon bağla</h3><div class="spacer"></div>
          <button class="btn btn--ghost btn--sm" id="devPairCancel">Kodu iptal et</button></div>
        <div class="card__body">
          <div class="pair">
            <div class="pair__qr">
              ${p.qr && p.qr.svg ? p.qr.svg : '<div class="muted">Karekod üretilemedi</div>'}
            </div>
            <div class="pair__side">
              <div class="pair__lead">Telefondaki <b>NOKTApp Garson</b> uygulamasını açın,
                <b>"Karekodu okut"</b> deyin ve bu kareyi gösterin.</div>
              <p class="muted" style="font-size:13.5px;margin:10px 0 14px">
                Kod ${who} üretildi. Telefon bu kasayla <b>aynı Wi-Fi ağındaysa</b> bağlantı
                doğrudan kurulur, internet gerekmez. Değilse — garson evdeyse, telefonu
                mobil veride ya da misafir ağındaysa — karekod <b>internet üzerinden de</b>
                çalışır; bunun için bu bilgisayarın internete bağlı olması yeterli.</p>
              <p class="muted" style="font-size:12.5px;margin:-6px 0 14px">
                Karekod <b>10 dakika</b> geçerlidir ve <b>tek bir</b> telefon bağlar.
                Ekran görüntüsünü paylaşmayın.</p>

              <div class="pair__code">
                <div class="pair__codelbl">Kamerası yoksa bu kodu elle yazsın</div>
                <div class="mono" id="devPairCode">${esc(p.code)}</div>
              </div>

              <div class="pair__meta">
                <div>Kalan süre: <b class="mono" id="devPairLeft">—</b></div>
                <div>Bu kasanın adresi:
                  ${(p.addresses || []).length
                    ? `<b class="mono">${esc(p.addresses[0])}</b>`
                    : '<span class="muted">okunamadı</span>'}</div>
                ${(p.addresses || []).length > 1
                  ? `<div class="muted" style="font-size:12.5px">Diğer adresler:
                       <span class="mono">${p.addresses.slice(1).map(a => esc(a)).join(' · ')}</span></div>`
                  : ''}
              </div>
            </div>
          </div>
        </div>
      </div>`;

    $('#devPairCancel').onclick = async () => {
      try { await api('DELETE', '/api/device/pair-code'); this.devStopTimers(); this.devReload(); }
      catch (e) { err(e); }
    };

    let left = Number(p.seconds_left) || 0;
    const tick = () => {
      const el = $('#devPairLeft');
      if (!el) return this.devStopTimers();          // the screen moved on
      if (left <= 0) {
        this.devStopTimers();
        const box = $('#devPairBox');
        if (box) box.innerHTML = `<div class="alert alert--warn">Eşleştirme kodunun süresi doldu.
          Yeni bir kod üretip tekrar deneyin.</div>`;
        return;
      }
      el.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      left--;
    };
    tick();
    this._devTimer = setInterval(tick, 1000);

    /* A phone that has just paired should make the list under the symbol true
       without anybody pressing anything - the owner is looking at the till
       while the waiter scans, and "did it work" is the only question. */
    this._devPairWatch = setInterval(async () => {
      try {
        const live = (await api('GET', '/api/device/pair-code')).pairing;
        if (!live) { this.devStopTimers(); this.devReload(); }
      } catch (_) {}
    }, 4000);
  },

  async devRename(id, name) {
    modal(`
      <div class="modal__head"><h3>Cihaz adı</h3></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">Bu ad yalnızca burada görünür - "Salon tableti", "Erdal'ın telefonu".</p>
        <div class="field"><label>Ad</label><input class="input" id="devName" value="${esc(name)}" maxlength="120"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="devNameOk">Kaydet</button></div>`);
    $('#devName').focus();
    $('#devNameOk').onclick = async () => {
      try {
        await api('POST', `/api/device/devices/${id}/rename`, { name: $('#devName').value });
        closeModal(); toast('Cihaz adı değişti'); this.devReload();
      } catch (e) { err(e); }
    };
  },

  async devRevoke(id, name) {
    const yes = await confirmBox('Erişimi kes',
      `${name} artık kasaya bağlanamayacak. Cihazda gönderilmemiş sipariş varsa önce senkron olmasını bekleyin.`,
      true);
    if (!yes) return;
    try {
      const r = await api('POST', `/api/device/devices/${id}/revoke`);
      toast(r.revoked > 1 ? `${r.revoked} oturum kapatıldı` : 'Erişim kesildi');
      this.devReload();
    } catch (e) { err(e); }
  },

  /**
   * Retire is the only action that takes the number prefix back, and it says
   * so before doing it: a prefix handed to the next tablet while this one
   * still holds unsynced bills is how two adisyons get the same number.
   */
  async devRetire(id, name, prefix) {
    const yes = await confirmBox('Cihazı emekliye ayır',
      `${name} erişimi kesilecek${prefix ? ` ve ${prefix} numaralı adisyon ön eki serbest bırakılacak` : ''}. ` +
      'Cihazda gönderilmemiş adisyon kalmadığından emin olun.', true);
    if (!yes) return;
    try {
      const r = await api('POST', `/api/device/devices/${id}/retire`);
      toast(r.released_prefix
        ? `Cihaz emekliye ayrıldı, ${r.released_prefix} numaralı ön ek boşa çıktı`
        : 'Cihaz emekliye ayrıldı');
      this.devReload();
    } catch (e) { err(e); }
  },

  /* ------------------------------------------------- adisyon ön ekleri */
  /*
   * The scheme in one screen. It is explained in words on the page itself
   * because the first question everybody asks is "why does that tablet's
   * adisyon start with a 3", and the answer is the reason bills can still be
   * opened when the network is down.
   */
  async devPrefixes() {
    const p = await api('GET', '/api/device/prefixes');
    const held = p.prefixes.length;

    const rows = [];
    for (let i = 1; i <= p.max_prefix; i++) {
      const h = p.prefixes.find(x => x.prefix === i);
      rows.push(h ? `<tr>
          <td class="mono strong">${i}</td>
          <td class="mono">${h.example ? esc(String(h.example)) : '—'}</td>
          <td><div class="strong">${esc(h.device_name || h.device_id)}</div>
            <div class="muted mono" style="font-size:11.5px">${esc(h.device_id)}</div></td>
          <td>${devWhen(h.last_seen_at)}</td>
          <td class="mono">${h.used_today ? (h.next_no - 1) + ' adisyon' : '<span class="muted">yok</span>'}</td>
          <td>${h.revoked ? '<span class="badge badge--open">Erişim kesildi</span>'
                          : '<span class="badge badge--closed">Kullanımda</span>'}</td>
          <td class="right"><button class="btn btn--ghost btn--sm" data-release="${i}"
            data-name="${esc(h.device_name || h.device_id)}" data-used="${h.next_no - 1}">Serbest bırak</button></td>
        </tr>`
        : `<tr>
          <td class="mono strong">${i}</td>
          <td class="mono muted">${esc(String(i * 10000 + 1))}</td>
          <td colspan="4" class="muted">Boşta - sıradaki cihaza verilecek</td>
          <td></td></tr>`);
    }

    $('#devBody').innerHTML = `
      ${p.all_taken ? `<div class="alert alert--warn">
        <b>Dokuz ön ekin hepsi dağıtıldı.</b> Bundan sonra eşleşecek cihazlar yalnızca
        çevrimiçi çalışır: internet ya da kasa bağlantısı kesildiğinde adisyon açamazlar.
        Kullanılmayan bir cihazı emekliye ayırıp ön ekini serbest bırakın.</div>` : ''}
      <div class="split-3" style="margin-bottom:14px">
        ${devStat('Dağıtılan ön ek', `${held} / ${p.max_prefix}`,
          p.free.length ? `boşta: ${p.free.join(', ')}` : 'boşta ön ek kalmadı')}
        ${devStat('Bu bilgisayar', p.server.next_no > 1 ? String(p.server.next_no - 1) : '0',
          `bugün açılan adisyon · seri ${p.server.example || 1}`)}
        ${devStat('İş günü', devWhen(p.business_date).slice(0, 10), 'sayaçlar her iş günü sıfırlanır')}
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card__head"><h3>Adisyon numarası ön ekleri</h3></div>
        <div class="card__body">
          <p class="muted" style="margin-top:0;font-size:13.5px">
            Bu bilgisayar adisyonları <b>1, 2, 3…</b> diye numaralar. Her telefona kalıcı bir ön ek
            verilir: ön eki 3 olan cihaz <b>30001, 30002…</b> üretir. Numara böylece rezervasyona
            değil <b>numara alanına</b> dayanır - cihaz saatlerce bağlantısız kalsa bile adisyon
            açmaya devam eder ve numarası hiçbir zaman başka bir cihazınkiyle çakışmaz.
            Bir cihaz günde en fazla ${p.series_max} adisyon açabilir; ön ek sayısı dokuzdur.</p>
          <table class="tbl">
            <thead><tr><th>Ön ek</th><th>Sıradaki numara</th><th>Cihaz</th><th>Son görülme</th>
              <th>Bugün</th><th>Durum</th><th></th></tr></thead>
            <tbody>${rows.join('')}</tbody></table>
        </div>
      </div>

      ${(p.history || []).length ? `<div class="card">
        <div class="card__head"><h3>Serbest bırakılan ön ekler</h3></div>
        <div class="card__body" style="padding:0"><table class="tbl">
          <thead><tr><th>Ön ek</th><th>Cihaz</th><th>Verildi</th><th>Bırakıldı</th>
            <th>Bırakan</th><th>O günkü sayaç</th></tr></thead>
          <tbody>${p.history.map(h => `<tr>
            <td class="mono strong">${h.prefix}</td>
            <td>${esc(h.device_name || h.device_id)}</td>
            <td>${devWhen(h.allocated_at)}</td>
            <td>${devWhen(h.released_at)}</td>
            <td>${h.released_by ? esc(h.released_by) : '<span class="muted">—</span>'}</td>
            <td class="mono">${h.numbers_seen || 0}</td></tr>`).join('')}</tbody></table>
        </div></div>` : ''}`;

    $$('#devBody [data-release]').forEach(b => b.onclick = () =>
      this.devRelease(b.dataset.release, b.dataset.name, Number(b.dataset.used)));
  },

  async devRelease(prefix, name, usedToday) {
    const yes = await confirmBox('Ön eki serbest bırak',
      `${prefix} numaralı ön ek ${name} cihazından alınacak ve sıradaki cihaza verilebilecek.` +
      (usedToday > 0
        ? ` Dikkat: bu ön ekle bugün ${usedToday} adisyon açıldı. Cihazda gönderilmemiş adisyon varsa` +
          ' aynı numara ikinci kez üretilebilir.'
        : ''), true);
    if (!yes) return;
    try {
      await api('POST', `/api/device/prefixes/${prefix}/release`);
      toast('Ön ek serbest bırakıldı');
      this.devPrefixes();
    } catch (e) { err(e); }
  },

  /* ----------------------------------------------------------- senkron */
  /*
   * Until this tab existed a stuck outbox was completely invisible: the drain
   * logs its failure at debug level and returns, so a queue that the panel has
   * been refusing for three days looked exactly like an idle one. The number
   * that matters is "takılan" - rows the drain will never pick up again
   * because they have used all ten attempts.
   */
  async devSync() {
    const [s, f] = await Promise.all([
      api('GET', '/api/device/sync'),
      api('GET', '/api/device/sync/failed'),
    ]);
    const q = s.sync;

    $('#devBody').innerHTML = `
      ${q.stuck ? `<div class="alert alert--error">
        <b>${q.stuck} işlem takıldı.</b> ${q.max_attempts} denemenin ardından kuyruk bunları
        kendiliğinden tekrar denemez. Aşağıdaki listeden sebebini görüp "Tekrar dene" deyin.</div>` : ''}
      ${!q.stuck && q.queue_age_min > 120 && q.waiting ? `<div class="alert alert--warn">
        Kuyruktaki en eski kayıt ${devMinutes(q.queue_age_min)} bekliyor. Bağlantı durumunu kontrol edin.</div>` : ''}

      <div class="split-4" style="margin-bottom:14px">
        ${devStat('Bekleyen işlem', String(q.pending), q.waiting ? 'gönderilmeyi bekliyor' : 'kuyruk boş')}
        ${devStat('Takılan', String(q.stuck), q.stuck ? 'elle müdahale gerekiyor' : 'yok',
          q.stuck ? 'is-loss' : '')}
        ${devStat('Son başarılı gönderim', devMoment(q.last_sent_at),
          q.last_sent_at ? devWhen(q.last_sent_at) : 'hiç gönderilmedi')}
        ${devStat('Kuyruk yaşı', q.waiting ? devMinutes(q.queue_age_min) : '—',
          q.oldest_pending_at ? 'en eski: ' + devWhen(q.oldest_pending_at) : 'bekleyen yok')}
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card__head"><h3>Buluta gönderim</h3><div class="spacer"></div>
          <button class="btn btn--primary btn--sm" id="devPush">Şimdi gönder</button></div>
        <div class="card__body">
          <p class="muted" style="margin-top:0;font-size:13.5px">
            Gün sonu rakamları, özetler ve yedekler bu kuyrukta sıraya girer ve dakikada bir
            gönderilir. Kasadaki satış bu kuyruğa bağlı değildir: kuyruk dursa da restoran
            çalışmaya devam eder, yalnızca panelde görünen rakamlar geride kalır.</p>
          ${q.last_error ? `<div class="alert alert--error" style="margin-bottom:0">
            <b>Son hata:</b> ${esc(q.last_error.message)}<br>
            <span style="font-size:13px">${esc(q.last_error.entity)} · ${esc(String(q.last_error.entity_id))}
            · ${q.last_error.attempts} deneme · ${devWhen(q.last_error.at)}</span></div>`
          : '<div class="muted" style="font-size:13.5px">Kayıtlı hata yok.</div>'}
          ${q.by_entity.length ? `<div style="margin-top:14px">
            ${q.by_entity.map(e => `<div class="total-row"><span>${esc(e.entity)}</span>
              <span class="mono">${e.n}</span></div>`).join('')}</div>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card__head"><h3>Başarısız işlemler</h3><div class="spacer"></div>
          ${f.ops.length ? '<button class="btn btn--ghost btn--sm" id="devRetryAll">Tümünü tekrar dene</button>' : ''}
        </div>
        <div class="card__body" style="padding:0">${
          f.ops.length ? `<table class="tbl">
            <thead><tr><th>Kayıt</th><th>İşlem</th><th>Deneme</th><th>Sebep</th><th>Eklendi</th><th></th></tr></thead>
            <tbody>${f.ops.map(o => `<tr>
              <td><div class="strong">${esc(o.entity)}</div>
                <div class="muted mono" style="font-size:11.5px">${esc(String(o.entity_id))}</div></td>
              <td>${esc(o.op)}</td>
              <td class="mono">${o.attempts}</td>
              <td>${o.blocked ? '<span class="badge badge--open">Takıldı</span> ' : ''}
                <span class="${o.blocked ? 'is-loss' : ''}">${esc(o.reason)}</span></td>
              <td>${devWhen(o.created_at)}</td>
              <td class="right"><button class="btn btn--ghost btn--sm" data-retry="${o.id}">Tekrar dene</button></td>
            </tr>`).join('')}</tbody></table>`
          : '<div class="empty">Başarısız işlem yok.</div>'}
        </div>
      </div>`;

    $('#devPush').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Gönderiliyor…';
      try {
        const r = await api('POST', '/api/device/sync/push');
        toast(r.sync.pushed
          ? `${r.sync.pushed} kayıt gönderildi`
          : (r.sync.waiting ? 'Gönderilemedi - bağlantı durumunu kontrol edin' : 'Kuyruk zaten boştu'),
          r.sync.pushed || !r.sync.waiting ? 'ok' : 'error');
      } catch (e2) { err(e2); }
      this.devSync();
    };
    const all = $('#devRetryAll');
    if (all) all.onclick = async () => {
      try { const r = await api('POST', '/api/device/sync/failed/retry-all');
        toast(`${r.retried} işlem tekrar kuyruğa alındı`); } catch (e2) { err(e2); }
      this.devSync();
    };
    $$('#devBody [data-retry]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await api('POST', `/api/device/sync/failed/${b.dataset.retry}/retry`); toast('Tekrar kuyruğa alındı'); }
      catch (e2) { err(e2); }
      this.devSync();
    });
  },

  /* ---------------------------------------------------------- bağlantı */
  /*
   * The rule this tab exists for: an expiring licence must be visible BEFORE
   * it expires. Everything else here answers "why can the phone outside not
   * reach us" without anybody having to read a log file.
   */
  async devConnection() {
    const c = await api('GET', '/api/device/connection');
    const l = c.licence;
    const g = c.grace;

    $('#devBody').innerHTML = `
      ${c.warnings.map(w => `<div class="alert alert--${w.level === 'error' ? 'error' : 'warn'}">${esc(w.text)}</div>`).join('')}
      ${this.devBranchCard(c.branch)}

      <div class="split-4" style="margin-bottom:14px">
        ${devStat('Lisans', l.licensed ? 'Geçerli' : 'Sorunlu',
          l.plan ? esc(l.plan) : (l.status ? esc(devLicence(l.status)) : 'lisans yok'), l.licensed ? '' : 'is-loss')}
        ${devStat('Bitiş tarihi', l.expires_at ? devWhen(l.expires_at).slice(0, 10) : 'süresiz',
          l.days_to_expiry === null ? '' :
            (l.days_to_expiry > 0 ? l.days_to_expiry + ' gün kaldı' : 'süresi doldu'),
          l.days_to_expiry !== null && l.days_to_expiry <= 14 ? 'is-loss' : '')}
        ${devStat('İnternetsiz çalışma', g.expired ? 'doldu' : g.days_left + ' gün',
          `son doğrulama: ${devWhen(g.last_ok_at)}`, g.expired || g.days_left <= 2 ? 'is-loss' : '')}
        ${devStat('Uzaktan bağlantı', c.relay.connected ? 'Açık' : 'Kapalı',
          c.relay.last_poll_at ? 'son yoklama: ' + devMoment(c.relay.last_poll_at) : 'hiç yoklanmadı',
          c.relay.connected ? '' : 'is-loss')}
      </div>

      <div class="split-2">
        <div class="card">
          <div class="card__head"><h3>Lisans</h3><div class="spacer"></div>
            <button class="btn btn--ghost btn--sm" id="devCheck">Şimdi doğrula</button></div>
          <div class="card__body">
            <div class="total-row"><span>İşletme</span><span>${esc(l.company || '—')}</span></div>
            <div class="total-row"><span>Paket</span><span>${esc(l.plan || '—')}</span></div>
            <div class="total-row"><span>Durum</span><span>${esc(devLicence(l.status))}</span></div>
            <div class="total-row"><span>Lisans no</span>
              <span class="mono">${l.key_tail ? '••••' + esc(l.key_tail) : '—'}</span></div>
            <div class="total-row"><span>Son doğrulama denemesi</span><span>${devWhen(l.last_check_at)}</span></div>
            <div class="total-row"><span>Son başarılı doğrulama</span><span>${devWhen(l.last_ok_at)}</span></div>
            ${l.last_check_failed ? `<div class="alert alert--warn" style="margin:12px 0 0">
              Son doğrulama denemesi sunucuya ulaşamadı. İnternetsiz çalışma süresi
              ${g.expired ? 'doldu' : g.days_left + ' gün'} sonra bitiyor.</div>` : ''}
            <p class="muted" style="font-size:13px;margin-bottom:0">
              Lisans her yarım saatte bir doğrulanır. İnternet kesilse bile kasa
              ${g.grace_days} gün boyunca çalışmaya devam eder.</p>
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Ağ ve telefonlar</h3></div>
          <div class="card__body">
            <div class="total-row"><span>Bu bilgisayar</span><span class="mono">${esc(c.lan.hostname || '—')}</span></div>
            <div class="total-row"><span>Servis portu</span><span class="mono">${c.lan.port}</span></div>
            <div class="total-row"><span>Cihaz kimliği</span>
              <span class="mono" style="font-size:12px">${esc(c.device_id || '—')}</span></div>
            <div class="total-row"><span>Panel adresi</span>
              <span class="mono" style="font-size:12px">${esc(c.panel_url || '—')}</span></div>
            ${c.branch && c.branch.bound ? `<div class="total-row"><span>Şube</span>
              <span>${esc(c.branch.branch_name || '')} <span class="muted mono">${esc(c.branch.branch_code || '')}</span></span></div>`
              : `<div class="total-row"><span>Şube</span>
              <span class="muted">tek işletme
                <button class="btn btn--ghost btn--sm" id="devBranchBind"
                  style="margin-left:8px">Şube kodu gir</button></span></div>`}
            <div style="margin-top:12px">
              <div class="muted" style="font-size:13px;margin-bottom:6px">
                Telefonlar kasayı kendiliğinden bulamazsa bu adreslerden birini yazsınlar:</div>
              ${(c.lan.addresses || []).length
                ? `<div class="mono" style="font-size:13.5px">${c.lan.addresses.map(a => esc(a)).join('<br>')}</div>`
                : '<div class="muted" style="font-size:13px">Ağ adresi okunamadı.</div>'}
            </div>
            <div class="total-row" style="margin-top:14px"><span>Bulut aktarımı</span>
              <span>${c.relay.enabled
                ? (c.relay.connected ? 'bağlı' : `bağlı değil (${c.relay.consecutive_errors} hata)`)
                : 'kapalı'}</span></div>
            <p class="muted" style="font-size:13px;margin-bottom:0">
              Bulut aktarımı, restoranın Wi-Fi'ında olmayan telefonların kasaya panel üzerinden
              ulaşmasını sağlar. Kapalıyken yalnızca aynı ağdaki telefonlar çalışır.</p>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Kuyruk</h3><div class="spacer"></div>
          <button class="btn btn--ghost btn--sm" id="devToSync">Senkron durumu</button></div>
        <div class="card__body">
          <div class="total-row"><span>Bekleyen işlem</span><span class="mono">${c.outbox.pending}</span></div>
          <div class="total-row"><span>Takılan işlem</span>
            <span class="mono${c.outbox.stuck ? ' is-loss' : ''}">${c.outbox.stuck}</span></div>
          <div class="total-row"><span>Son başarılı gönderim</span><span>${devWhen(c.outbox.last_sent_at)}</span></div>
        </div>
      </div>`;

    $('#devCheck').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Doğrulanıyor…';
      try {
        const r = await api('POST', '/api/device/connection/check');
        toast(r.check && r.check.ok ? 'Lisans doğrulandı' : 'Sunucuya ulaşılamadı',
          r.check && r.check.ok ? 'ok' : 'error');
      } catch (e2) { err(e2); }
      this.devConnection();
    };
    $('#devToSync').onclick = () => this.page_cihazlar('senkron');
    const bindBtn = $('#devBranchBind');
    if (bindBtn) bindBtn.onclick = () => this.devBranchAsk();
    const pullBtn = $('#devBranchPull');
    if (pullBtn) pullBtn.onclick = () => this.devBranchPull();
    const reBind = $('#devBranchRebind');
    if (reBind) reBind.onclick = () => this.devBranchAsk(c.branch.branch_code);
  },

  /* ==================================================================
     ŞUBE (zincir)
     ==================================================================
     Everything below draws NOTHING on a till that has not been given a
     branch code, and the till asks head office for nothing either - the
     whole feature is inert until somebody types the code. That is the point:
     the thousands of one-shop installs did not ask for a chain layer and
     must not be shown one. All a single-shop owner ever sees is the "Şube:
     tek işletme" row in the network card above, which is also the door.
     ================================================================== */

  /** The branch, the version it is on, and the button that catches it up. */
  devBranchCard(b) {
    if (!b || !b.bound) return '';
    const a = b.last_apply;
    return `<div class="card" style="margin-bottom:14px;border-color:var(--orange)">
      <div class="card__head"><h3>Şube menüsü</h3><div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="devBranchRebind">Şubeyi değiştir</button>
        <button class="btn btn--primary btn--sm" id="devBranchPull">Şimdi güncelle</button></div>
      <div class="card__body">
        <div class="split-4" style="margin-bottom:12px">
          ${devStat('Şube', esc(b.branch_name || b.branch_code), esc(b.branch_code || ''))}
          ${devStat('Menü sürümü', 'v' + (b.menu_version || 0),
            a ? devWhen(a.applied_at) : 'henüz uygulanmadı')}
          ${devStat('Merkez ürünleri', b.products ? b.products.master : 0,
            b.products && b.products.master_off ? b.products.master_off + ' tanesi kapalı' : 'tümü açık')}
          ${devStat('Şubenin kendi ürünleri', b.products ? b.products.local : 0,
            'merkez güncellemesi bunlara dokunmaz')}
        </div>
        ${a ? `<div class="total-row"><span>Son güncelleme</span>
          <span>${a.inserted} eklendi · ${a.updated} güncellendi · ${a.deactivated} kapatıldı</span></div>
          <div class="total-row"><span>Merkeze bildirildi</span>
            <span>${a.acked ? 'evet' : 'hayır — sonraki denemede tekrar bildirilecek'}</span></div>` : ''}
        <div class="total-row"><span>Son deneme</span><span>${devWhen(b.last_pull_at)}</span></div>
        ${b.last_error ? `<div class="alert alert--warn" style="margin:12px 0 0">
          Merkeze ulaşılamadı: ${esc(b.last_error)}. Kasa mevcut menüyle çalışmaya devam ediyor.</div>` : ''}
        <p class="muted" style="font-size:13px;margin-bottom:0">
          Menü merkezden gelir ve lisans doğrulamasıyla birlikte kendiliğinden güncellenir.
          Şubenin kendi eklediği ürünlere dokunulmaz; merkezden kaldırılan ürünler silinmez,
          yalnızca satışa kapatılır - eski adisyonlar onlara bağlı kalır.</p>
      </div>
    </div>`;
  },

  /**
   * The code head office read out over the phone.
   *
   * Deliberately a typed code and not a list: the till has no business asking
   * the panel "which branches exist" before it is entitled to one of them.
   */
  devBranchAsk(current) {
    modal(`
      <div class="modal__head"><h3>${current ? 'Şubeyi değiştir' : 'Şubeye bağlan'}</h3></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">
          Merkezin size verdiği şube kodunu yazın - örneğin MERKEZ ya da KALEICI.
          Kasa bu şubeye bağlanır ve merkez menüsünü ilk kez indirir.</p>
        <div class="field"><label>Şube kodu</label>
          <input class="input mono" id="devBranchCode" maxlength="32" autocomplete="off"
            style="text-transform:uppercase" value="${esc(current || '')}"></div>
        <p class="muted" style="font-size:13px;margin-bottom:0">
          Merkez menüsü indirildikten sonra bu kasadaki fiyatlar merkezden yönetilir.
          Şubenin kendi eklediği ürünler olduğu gibi kalır.</p>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" onclick="closeModal()">Vazgeç</button>
        <button class="btn btn--primary" id="devBranchOk">Bağlan</button></div>`);
    $('#devBranchCode').focus();
    $('#devBranchOk').onclick = async (e) => {
      const code = ($('#devBranchCode').value || '').trim().toUpperCase();
      if (!code) return;
      e.target.disabled = true; e.target.textContent = 'Bağlanıyor…';
      try {
        const r = await api('POST', '/api/device/branch/bind', { code });
        closeModal();
        toast(`${r.state.branch_name || code} şubesine bağlanıldı · menü v${r.version || 0}`);
        this.devConnection();
      } catch (e2) {
        e.target.disabled = false; e.target.textContent = 'Bağlan';
        err(e2);
      }
    };
  },

  /** "Şimdi güncelle" - the heartbeat's pull, without the half hour wait. */
  async devBranchPull() {
    const btn = $('#devBranchPull');
    if (btn) { btn.disabled = true; btn.textContent = 'Güncelleniyor…'; }
    try {
      const r = await api('POST', '/api/device/branch/pull');
      if (r.offline) toast('Merkeze ulaşılamadı, mevcut menüyle devam ediliyor', 'error');
      else if (!r.changed) toast('Menü zaten güncel · v' + (r.version || 0));
      else toast(`Menü v${r.version} uygulandı · ${r.inserted} eklendi, ${r.updated} güncellendi`);
    } catch (e) { err(e); }
    this.devConnection();
  },

  /* ==================================================================
     İŞLEM GÜNLÜĞÜ
     ================================================================== */
  /*
   * np_app_log is written by every part of the service and was readable only
   * by opening the log file on the PC's disk. A support call that starts with
   * "yazıcı 19:40'ta cevap vermemiş" is a different call from one that starts
   * with "bir şeyler çalışmıyor".
   */
  _devLog: { level: '', area: '', q: '', from: '', to: '', offset: 0, limit: 100 },

  async page_gunluk() {
    this.devStopTimers();
    this._devLog.offset = 0;
    $('#main').innerHTML = `<div class="page is-on">
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">İşlem günlüğü</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">Servisin kendi kaydı - son 30 günün özeti filtrelerde</span>
      </div>
      <div id="devLogBody"><div class="empty">Yükleniyor…</div></div></div>`;
    await this.devLogLoad();
  },

  async devLogLoad() {
    const f = this._devLog;
    const qs = new URLSearchParams();
    /* "Yalnızca sorunlar" is not a level, it is two of them: the server takes
       it as its own flag rather than pretending 'problem' is a value np_app_log
       could ever contain. */
    if (f.level === 'problem') qs.set('only_problems', '1');
    else if (f.level) qs.set('level', f.level);
    if (f.area) qs.set('area', f.area);
    if (f.q) qs.set('q', f.q);
    if (f.from) qs.set('from', f.from);
    if (f.to) qs.set('to', f.to);
    qs.set('limit', f.limit); qs.set('offset', f.offset);

    let r;
    try { r = await api('GET', '/api/device/log?' + qs.toString()); }
    catch (e) { $('#devLogBody').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; return; }

    const from = r.total ? f.offset + 1 : 0;
    const to = Math.min(f.offset + r.rows.length, r.total);

    $('#devLogBody').innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card__body">
          <div class="split-4">
            <div class="field"><label>Seviye</label>
              <select class="input" id="lgLevel">
                <option value="">Hepsi</option>
                <option value="problem"${f.level === 'problem' ? ' selected' : ''}>Yalnızca sorunlar</option>
                <option value="error"${f.level === 'error' ? ' selected' : ''}>Hata</option>
                <option value="warn"${f.level === 'warn' ? ' selected' : ''}>Uyarı</option>
                <option value="info"${f.level === 'info' ? ' selected' : ''}>Bilgi</option>
              </select></div>
            <div class="field"><label>Bölüm</label>
              <select class="input" id="lgArea"><option value="">Hepsi</option>
                ${r.areas.map(a => `<option value="${esc(a.area)}"${f.area === a.area ? ' selected' : ''}>${esc(a.area)} (${a.n})</option>`).join('')}
              </select></div>
            <div class="field"><label>Başlangıç</label><input class="input" id="lgFrom" type="date" value="${esc(f.from)}"></div>
            <div class="field"><label>Bitiş</label><input class="input" id="lgTo" type="date" value="${esc(f.to)}"></div>
          </div>
          <div class="row">
            <div class="field" style="flex:1;margin:0"><label>Ara</label>
              <input class="input" id="lgQ" value="${esc(f.q)}" placeholder="mesaj veya ayrıntı içinde ara - yazıcı, 192.168.1.50, adisyon"></div>
            <button class="btn btn--primary" id="lgGo" style="margin-top:20px">Ara</button>
            <button class="btn btn--ghost" id="lgClear" style="margin-top:20px">Temizle</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card__head"><h3>Kayıtlar</h3><div class="spacer"></div>
          <span class="muted" style="font-size:13px">${r.total ? `${from}-${to} / ${r.total}` : 'kayıt yok'}</span>
          <button class="btn btn--ghost btn--sm" id="lgPrev"${f.offset ? '' : ' disabled'}>Önceki</button>
          <button class="btn btn--ghost btn--sm" id="lgNext"${to >= r.total ? ' disabled' : ''}>Sonraki</button></div>
        <div class="card__body" style="padding:0">${
          r.rows.length ? `<table class="tbl">
            <thead><tr><th style="width:150px">Zaman</th><th style="width:70px">Seviye</th>
              <th style="width:110px">Bölüm</th><th>Olay</th><th></th></tr></thead>
            <tbody>${r.rows.map(x => {
              const [cls, label] = DEV_LEVEL[x.level] || DEV_LEVEL.info;
              return `<tr>
                <td class="mono" style="font-size:12.5px">${devWhen(x.created_at)}</td>
                <td><span class="badge ${cls}">${label}</span></td>
                <td class="muted">${esc(x.area)}</td>
                <td class="${x.level === 'error' ? 'is-loss' : ''}">${esc(x.message)}</td>
                <td class="right">${x.detail
                  ? `<button class="btn btn--ghost btn--sm" data-detail="${x.id}">Ayrıntı</button>` : ''}</td>
              </tr>`;
            }).join('')}</tbody></table>`
          : '<div class="empty">Bu filtrelerle kayıt bulunamadı.</div>'}
        </div>
      </div>`;

    const apply = () => {
      this._devLog.level = $('#lgLevel').value;
      this._devLog.area = $('#lgArea').value;
      this._devLog.q = $('#lgQ').value.trim();
      this._devLog.from = $('#lgFrom').value;
      this._devLog.to = $('#lgTo').value;
      this._devLog.offset = 0;
      this.devLogLoad();
    };
    $('#lgGo').onclick = apply;
    $('#lgLevel').onchange = apply;
    $('#lgArea').onchange = apply;
    $('#lgQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    $('#lgClear').onclick = () => {
      this._devLog = { level: '', area: '', q: '', from: '', to: '', offset: 0, limit: 100 };
      this.devLogLoad();
    };
    $('#lgPrev').onclick = () => { this._devLog.offset = Math.max(0, f.offset - f.limit); this.devLogLoad(); };
    $('#lgNext').onclick = () => { this._devLog.offset = f.offset + f.limit; this.devLogLoad(); };
    $$('#devLogBody [data-detail]').forEach(b => b.onclick = () => {
      const row = r.rows.find(x => String(x.id) === b.dataset.detail);
      if (!row) return;
      let pretty = row.detail;
      try { pretty = JSON.stringify(JSON.parse(row.detail), null, 2); } catch (_) { /* not JSON, show as is */ }
      modal(`
        <div class="modal__head"><h3>${esc(row.message)}</h3><div class="spacer"></div>
          <button class="close-x" onclick="closeModal()">✕</button></div>
        <div class="modal__body">
          <div class="muted" style="margin-bottom:10px;font-size:13px">
            ${devWhen(row.created_at)} · ${esc(row.area)} · ${esc(row.level)}</div>
          <pre class="mono" style="background:var(--surface-2);border:1px solid var(--line);border-radius:10px;
            padding:12px;overflow:auto;max-height:50vh;font-size:12.5px;margin:0;white-space:pre-wrap">${esc(pretty)}</pre>
        </div>`, { wide: true });
    });
  },
});
