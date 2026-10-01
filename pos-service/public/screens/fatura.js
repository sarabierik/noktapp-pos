/* =====================================================================
   NOKTApp POS — Fatura, e-Fatura / e-Arşiv, gelen faturalar
   =====================================================================
   Kasanın mali belgesi ÖKC fişidir ve öyle kalıyor. Bu ekranlar
   müşterinin "fatura istiyorum" dediği anı karşılıyor: kapanmış adisyon
   açılır, alıcı bilgileri girilir, belge QNB eSolutions üzerinden GİB'e
   gider. Fatura her zaman kesilmiş fişe İSTİNADEN düzenlenir ve bunu
   üstünde yazar — yoksa aynı yemek iki kez beyan edilmiş olur.

   Üç ekran, üç ayrı iş:
     Faturalar      kestiğimiz faturalar ve her birinin QNB durumu
     Gelen faturalar tedarikçinin bize kestiği e-Faturalar, 8 günlük
                    kabul/red süresi ve taslak alışa aktarım
     e-Fatura ayarı işletmenin KENDİ QNB hesabı, kontörü, QNB kaydı

   Ekranın taşıdığı tek fikir: DURUM TAHMİN EDİLMEZ. "Gönderildi" diye
   bir durum yok; QNB'nin ve GİB'in söylediği ne ise o yazar, ve sonucu
   bilinmeyen bir fatura "belirsiz" olarak durur — çünkü o faturayı
   yeniden kesmek ikinci bir yasal belge üretir.

   Renk: tek aksan turuncu, yeşil yok. Kırmızı yalnızca insanın
   müdahalesi gereken iki şey için: QNB'nin reddettiği belge ve parola
   yüzünden durmuş gönderim.
   ===================================================================== */
'use strict';

registerIcon('faturalar',
  '<path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17z"/><path d="M9 8h6M9 11.5h6M9 15h3"/>');
registerIcon('gelenfatura',
  '<path d="M4 13v6.5h16V13"/><path d="M12 3.5v9.5"/><path d="M8.5 9.5 12 13l3.5-3.5"/>');
registerIcon('efatura',
  '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M7 9.5h6M7 13h4"/><path d="M15.5 15.5h2.5"/>');

registerPage({ id: 'faturalar', label: 'Faturalar', icon: 'faturalar',
  perm: 'report.view', group: 'reports' }, 'islemler');
registerPage({ id: 'gelenfatura', label: 'Gelen faturalar', icon: 'gelenfatura',
  perm: 'report.view', group: 'reports' }, 'faturalar');
registerPage({ id: 'efatura', label: 'e-Fatura / e-Arşiv', icon: 'efatura',
  perm: 'fatura.manage', group: 'isletme' }, 'okcdefter');

/* ------------------------------------------------------------ durumlar */
/*
 * Bir e-belgenin durumu QNB'nin ve GİB'in söylediğidir. "gonderiliyor"
 * ile "kuyrukta" ile "belirsiz" ayrı ayrı yazılır, çünkü kasiyerin
 * yapacağı şey her birinde başkadır: birincisinde beklemek,
 * ikincisinde beklemek ve sormak, üçüncüsünde YENİ FATURA KESMEMEK.
 */
const EB_DURUM = {
  gonderiliyor: ['badge--open', 'Gönderiliyor'],
  kuyrukta: ['badge--open', 'GİB kuyruğunda'],
  tamam: ['badge--closed', 'Oluştu'],
  hata: ['badge--red', 'Hata'],
  belirsiz: ['badge--red', 'Sonuç bilinmiyor'],
  iptal: ['badge--gray', 'İptal edildi'],
};
function ebDurum(s) {
  const d = EB_DURUM[s];
  if (!d) return '<span class="badge badge--gray">Gönderilmedi</span>';
  return `<span class="badge ${d[0]}">${d[1]}</span>`;
}
const EB_SENARYO = { TEMELFATURA: 'Temel', TICARIFATURA: 'Ticari', IHRACAT: 'İhracat', KAMU: 'Kamu' };
const trTarih = (d) => {
  const s = String(d || '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (s || '—');
};
const trAn = (d) => {
  const s = String(d || '');
  return s ? trTarih(s) + (s.slice(11, 16) ? ' ' + s.slice(11, 16) : '') : '—';
};
const kr = (m) => tl((Number(m) || 0) / 100);

Screens.add({

  /* =================================================================== */
  /*  1. FATURALAR                                                       */
  /* =================================================================== */
  async page_faturalar() {
    $('#main').innerHTML = `<div class="page is-on">
      ${subnavHtml('faturalar')}
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Faturalar</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px;margin-right:10px" id="ftEbDurum"></span>
        ${can('fatura.manage') ? '<button class="btn btn--ghost" id="ftAyar">e-Fatura ayarları</button>' : ''}
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px">
        <input class="input" id="ftQ" placeholder="fatura no, ünvan ya da VKN" style="max-width:280px">
        <select class="input" id="ftDurum" style="max-width:200px">
          <option value="">Tümü</option>
          <option value="bekleyen">Sonuçlanmamışlar</option>
          <option value="tamam">Oluşanlar</option>
          <option value="hata">Hatalılar</option>
          <option value="belirsiz">Sonucu bilinmeyenler</option>
        </select>
        <button class="btn btn--ghost" id="ftAra">Ara</button>
      </div>
      <div id="ftBody"><div class="empty">Yükleniyor…</div></div></div>`;

    if (can('fatura.manage')) $('#ftAyar').onclick = () => go('efatura');
    $('#ftAra').onclick = () => this.ftDraw();
    $('#ftQ').onkeydown = (e) => { if (e.key === 'Enter') this.ftDraw(); };
    $('#ftDurum').onchange = () => this.ftDraw();
    for (const b of $$('[data-sub]')) b.onclick = () => go(b.getAttribute('data-sub'));
    await this.ftDraw();
  },

  async ftDraw() {
    let r;
    try { r = await api('GET', `/api/ebelge/faturalar?q=${encodeURIComponent($('#ftQ').value || '')}&durum=${$('#ftDurum').value}&gun=180`); }
    catch (e) { return err(e); }
    $('#ftEbDurum').textContent = r.ebelge.aktif
      ? 'e-Belge açık · ' + (r.ebelge.ortam === 'canli' ? 'CANLI' : 'TEST ortamı')
      : 'e-Belge kapalı';

    if (!r.faturalar.length) {
      $('#ftBody').innerHTML = `<div class="empty">Bu aralıkta fatura yok.
        <div class="muted" style="margin-top:6px">Müşteri fatura isterse Adisyonlar ekranından
        kapanmış adisyonu açıp <b>Fatura kes</b> deyin.</div></div>`;
      return;
    }
    $('#ftBody').innerHTML = `<div class="card"><div class="card__head">
        <h3>Kesilen faturalar</h3><div class="spacer"></div>
        <span class="muted">${r.faturalar.length} kayıt</span></div>
      <table class="tbl"><thead><tr>
        <th>Fatura no</th><th>Tarih</th><th>Alıcı</th><th>Belge</th>
        <th class="right">Tutar</th><th>Durum</th><th class="right">İşlem</th>
      </tr></thead><tbody>
      ${r.faturalar.map(f => `<tr>
        <td class="mono">${esc(f.full_no)}${f.kind === 'return' ? ' <span class="badge badge--gray">İADE</span>' : ''}
          ${f.status === 'cancelled' ? ' <span class="badge badge--gray">iptal</span>' : ''}
          ${f.fis_no ? `<div class="muted" style="font-size:12px">ÖKC fişi ${esc(f.fis_no)}</div>` : ''}</td>
        <td>${trTarih(f.issue_date)}</td>
        <td>${esc(f.cust_title)}<div class="muted" style="font-size:12px mono">${esc(f.cust_tax_no)}</div></td>
        <td>${f.edoc_type ? `${f.edoc_type === 'EFATURA' ? 'e-Fatura' : 'e-Arşiv'}
              <div class="muted mono" style="font-size:12px">${esc(f.edoc_no || '—')}</div>` : '<span class="muted">—</span>'}
          ${f.edoc_env === 'test' ? '<div class="muted" style="font-size:12px">TEST</div>' : ''}</td>
        <td class="right mono">${kr(f.total_minor)} ₺</td>
        <td>${ebDurum(f.edoc_state)}</td>
        <td class="right"><button class="btn btn--ghost btn--sm" data-fid="${f.id}">Aç</button></td>
      </tr>`).join('')}
      </tbody></table></div>`;
    for (const b of $$('[data-fid]')) b.onclick = () => this.faturaDialog(b.getAttribute('data-fid'));
  },

  /** Bir fatura: kalemleri, e-belge kartı ve yapılabilecek her şey. */
  async faturaDialog(id) {
    let f;
    try { f = (await api('GET', `/api/ebelge/faturalar/${id}`)).fatura; } catch (e) { return err(e); }
    const gonderilebilir = f.status !== 'cancelled' && (!f.edoc_state || f.edoc_state === 'hata' || f.edoc_state === 'belirsiz');
    const sorulabilir = ['kuyrukta', 'belirsiz', 'gonderiliyor', 'tamam'].includes(f.edoc_state);
    const pdfVar = ['tamam', 'iptal'].includes(f.edoc_state);

    modal(`
      <div class="modal__head"><h3>Fatura ${esc(f.full_no)}</h3>
        ${f.kind === 'return' ? '<span class="badge badge--gray" style="margin-left:8px">İADE</span>' : ''}
        <div class="spacer"></div><button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="split-4" style="margin-bottom:14px">
          <div class="stat"><div class="stat__label">Tarih</div><div class="stat__value" style="font-size:19px">${trTarih(f.issue_date)}</div></div>
          <div class="stat"><div class="stat__label">Alıcı</div><div class="stat__value" style="font-size:16px">${esc(f.cust_title)}</div></div>
          <div class="stat"><div class="stat__label">VKN / TCKN</div><div class="stat__value mono" style="font-size:16px">${esc(f.cust_tax_no)}</div></div>
          <div class="stat"><div class="stat__label">Toplam</div><div class="stat__value" style="font-size:19px">${kr(f.total_minor)} ₺</div></div>
        </div>

        <div class="card" style="margin-bottom:14px"><div class="card__head">
            <h3>${f.edoc_type === 'EFATURA' ? 'e-Fatura' : f.edoc_type === 'EARSIV' ? 'e-Arşiv' : 'e-Belge'}</h3>
            <div class="spacer"></div>${ebDurum(f.edoc_state)}
            ${f.edoc_env === 'test' ? '<span class="badge badge--gray" style="margin-left:6px">TEST — yasal geçerliliği yok</span>' : ''}
          </div>
          <div class="card__body">
          ${f.edoc_type ? `<table class="tbl"><tbody>
              <tr><td style="width:170px">Belge no</td><td class="mono"><b>${esc(f.edoc_no || '—')}</b></td></tr>
              <tr><td>ETTN</td><td class="mono" style="font-size:12.5px">${esc(f.edoc_uuid || '—')}</td></tr>
              ${f.edoc_label ? `<tr><td>Alıcı posta kutusu</td><td class="mono" style="font-size:12.5px">${esc(f.edoc_label)}</td></tr>` : ''}
              ${f.edoc_sent_at ? `<tr><td>Gönderim</td><td>${trAn(f.edoc_sent_at)}</td></tr>` : ''}
            </tbody></table>`
            : `<p class="muted" style="margin:0">Alıcı e-Fatura mükellefiyse e-Fatura, değilse
                 e-Arşiv olarak gönderilir. Hangisi olduğuna QNB'ye sorulan mükellef kaydı karar verir.</p>`}
          ${f.edoc_error ? `<div class="alert alert--${f.edoc_state === 'tamam' ? 'warn' : 'error'}" style="margin-top:12px">${esc(f.edoc_error)}</div>` : ''}
          ${f.edoc_state === 'belirsiz' ? `<div class="alert alert--error" style="margin-top:12px">
              <b>Yeni fatura kesmeyin.</b> Bu faturanın QNB'de oluşup oluşmadığı bilinmiyor.
              "Durumu sorgula" deyin: oluştuysa numarası buraya yazılır, oluşmadıysa aynı kimlikle
              yeniden gönderilir. İkinci bir fatura kesmek ikinci bir yasal belge üretir.</div>` : ''}
          <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:14px">
            ${gonderilebilir ? `<button class="btn btn--primary" id="fdGonder">${f.edoc_state === 'hata' || f.edoc_state === 'belirsiz' ? 'Yeniden gönder' : 'e-Belge olarak gönder'}</button>` : ''}
            ${sorulabilir ? '<button class="btn btn--ghost" id="fdDurum">Durumu sorgula</button>' : ''}
            ${pdfVar ? `<a class="btn btn--ghost" href="/api/ebelge/faturalar/${f.id}/pdf" target="_blank" rel="noopener" id="fdPdf">Resmî PDF</a>` : ''}
            ${f.edoc_url && f.edoc_state === 'tamam' ? `<a class="btn btn--ghost" href="${esc(f.edoc_url)}" target="_blank" rel="noopener">QNB görüntüleme</a>` : ''}
          </div></div></div>

        <table class="tbl"><thead><tr>
          <th>Mal / hizmet</th><th class="right">Miktar</th><th class="right">Matrah</th>
          <th class="right">KDV</th><th class="right">Tutar</th>
        </tr></thead><tbody>
          ${f.kalemler.map(k => `<tr>
            <td>${esc(k.name)}${Number(k.is_gift) ? ' <span class="badge badge--gray">ikram</span>' : ''}</td>
            <td class="right mono">${(Number(k.qty) / 1000).toFixed(3).replace(/\.?0+$/, '')}</td>
            <td class="right mono">${kr(k.base_amount)}</td>
            <td class="right mono">%${Number(k.vat_rate)} · ${kr(k.vat_amount)}</td>
            <td class="right mono">${kr(Number(k.base_amount) + Number(k.vat_amount))}</td></tr>`).join('')}
          ${f.ekler.map(e => `<tr>
            <td>${esc(e.reason)} <span class="badge badge--gray">${Number(e.is_charge) ? 'ilave' : 'indirim'}</span></td>
            <td class="right muted">—</td>
            <td class="right mono">${Number(e.is_charge) ? '' : '-'}${kr(e.base_amount)}</td>
            <td class="right mono">%${Number(e.vat_rate)} · ${kr(e.vat_amount)}</td>
            <td class="right mono">${Number(e.is_charge) ? '' : '-'}${kr(Number(e.base_amount) + Number(e.vat_amount))}</td></tr>`).join('')}
        </tbody></table>
        <table class="tbl" style="margin-top:10px"><tbody>
          <tr><td>Matrah</td><td class="right mono">${kr(f.subtotal_minor)} ₺</td></tr>
          <tr><td>KDV</td><td class="right mono">${kr(f.vat_minor)} ₺</td></tr>
          <tr><td><b>Genel toplam</b></td><td class="right mono"><b>${kr(f.total_minor)} ₺</b></td></tr>
        </tbody></table>
        ${f.note ? `<p class="muted" style="margin:12px 0 0;font-size:12.5px">${esc(f.note)}</p>` : ''}
        ${f.iadeler && f.iadeler.length ? `<p class="muted" style="margin:8px 0 0;font-size:12.5px">
            İade faturası: ${f.iadeler.map(i => esc(i.full_no)).join(', ')}</p>` : ''}
      </div>
      <div class="modal__foot" style="flex-wrap:wrap;gap:8px">
        ${f.status !== 'cancelled' && f.kind !== 'return' && can('fatura.kes')
          ? '<button class="btn btn--ghost" id="fdIade">İade faturası kes</button>' : ''}
        <div class="spacer"></div>
        ${f.status !== 'cancelled' && can('fatura.manage')
          ? '<button class="btn btn--danger" id="fdIptal">Faturayı iptal et</button>' : ''}
      </div>`, { wide: true });

    const yenile = () => { closeModal(); this.ftDraw(); };
    if ($('#fdGonder')) {
      $('#fdGonder').onclick = async () => {
        $('#fdGonder').disabled = true; $('#fdGonder').textContent = 'Gönderiliyor…';
        try {
          const r = await api('POST', `/api/ebelge/faturalar/${f.id}/gonder`);
          toast(r.tip === 'EFATURA' ? 'e-Fatura GİB kuyruğuna alındı: ' + r.no : 'e-Arşiv faturası oluştu: ' + r.no, 'ok');
          if (r.uyari) toast(r.uyari, 'warn');
          this.faturaDialog(f.id);
        } catch (e) {
          err(e);
          this.faturaDialog(f.id);
        }
      };
    }
    if ($('#fdDurum')) {
      $('#fdDurum').onclick = async () => {
        try {
          const r = await api('POST', `/api/ebelge/faturalar/${f.id}/durum`);
          toast('Durum: ' + ((EB_DURUM[r.durum] || [])[1] || r.durum)
            + (r.bulunamadi ? ' — QNB\'de yok; yeniden gönderebilirsiniz.' : ''), r.durum === 'tamam' ? 'ok' : '');
        } catch (e) { err(e); }
        this.faturaDialog(f.id);
      };
    }
    if ($('#fdIade')) {
      $('#fdIade').onclick = async () => {
        const ok = await confirmBox('İade faturası',
          'Bu faturanın tamamı için iade faturası kesilecek. e-Belge açık ve "hemen gönder" seçiliyse QNB\'ye kendiliğinden gider.');
        if (!ok) return;
        try {
          const r = await api('POST', `/api/ebelge/faturalar/${f.id}/iade`, { reason: '' });
          toast('İade faturası kesildi: ' + r.full_no, 'ok');
          yenile();
        } catch (e) { err(e); }
      };
    }
    if ($('#fdIptal')) {
      $('#fdIptal').onclick = async () => {
        const sebep = await this.ftSebep(f.edoc_type === 'EARSIV' && f.edoc_state === 'tamam'
          ? 'Fatura önce QNB\'de iptal edilecek, sonra burada. e-Arşiv iptali geri alınamaz.'
          : 'Fatura iptal edilecek ve adisyon satırları yeniden faturalanabilir hale gelecek.');
        if (sebep === null) return;
        try {
          await api('POST', `/api/ebelge/faturalar/${f.id}/iptal`, { reason: sebep });
          toast('Fatura iptal edildi', 'ok');
          yenile();
        } catch (e) { err(e); }
      };
    }
  },

  /** Tek satırlık sebep sorusu. İptal ve red tedarikçiye/denetime gider. */
  ftSebep(aciklama) {
    return new Promise((resolve) => {
      modal(`<div class="modal__head"><h3>Sebep</h3></div>
        <div class="modal__body">
          <p class="muted" style="margin-top:0">${esc(aciklama)}</p>
          <div class="field"><label>Sebep</label>
            <input class="input" id="fsNeden" placeholder="kısaca yazın" autocomplete="off"></div>
        </div>
        <div class="modal__foot"><button class="btn btn--ghost" id="fsNo">Vazgeç</button>
          <div class="spacer"></div><button class="btn btn--danger" id="fsYes">Devam</button></div>`);
      $('#fsNo').onclick = () => { closeModal(); resolve(null); };
      $('#fsYes').onclick = () => { const v = $('#fsNeden').value.trim(); closeModal(); resolve(v); };
    });
  },

  /* =================================================================== */
  /*  2. ADISYONDAN FATURA KESME                                         */
  /* =================================================================== */
  /*
   * Buraya kapanmış adisyondan gelinir. Ekran önce faturanın NE OLACAĞINI
   * gösterir — satırlar, ikramlar, indirimin payı, toplam — sonra alıcı
   * bilgilerini ister. Önizleme ile kesilen fatura aynı hesaptan çıkar;
   * kasiyere "güven" denmiyor, aynı sayı iki yerde gösteriliyor.
   */
  async faturaKesDialog(orderId) {
    let on;
    try { on = await api('GET', `/api/ebelge/adisyon/${orderId}/onizle`); } catch (e) { return err(e); }

    const kalanYok = !on.satirlar.length;
    const ciz = (servis) => {
      modal(`
        <div class="modal__head"><h3>Fatura kes — adisyon #${on.order.adisyon_no || on.order.id}</h3>
          <div class="spacer"></div><button class="close-x" data-close="1">✕</button></div>
        <div class="modal__body">
          ${on.fis ? `<div class="alert alert--info">Fatura, <b>${trTarih(on.fis.tarih)}</b> tarihli
              <b>${esc(on.fis.no)}</b> numaralı ÖKC fişine <b>istinaden</b> düzenlenir ve bu not faturanın
              üstüne yazılır. Aynı yemek iki kez beyan edilmez.</div>`
            : `<div class="alert alert--warn">Bu adisyonun ÖKC fişi bulunamadı. Fatura istinat notu
              olmadan kesilir; mali fiş kesilmemişse önce onu kesin.</div>`}
          ${on.zaten_faturalanmis.length ? `<div class="alert alert--warn">Bu adisyonun
              ${on.zaten_faturalanmis.length} satırı zaten faturalandı; faturaya girmeyecek.</div>` : ''}
          ${kalanYok ? '<div class="alert alert--error">Faturaya girecek satır kalmadı.</div>' : `
          <table class="tbl"><thead><tr><th>Ürün</th><th class="right">Adet</th>
            <th class="right">Matrah</th><th class="right">KDV</th><th class="right">Tutar</th></tr></thead><tbody>
            ${on.satirlar.map(s => `<tr>
              <td>${esc(s.name)}${s.is_gift ? ' <span class="badge badge--gray">ikram</span>' : ''}</td>
              <td class="right mono">${(s.qty / 1000).toFixed(3).replace(/\.?0+$/, '')}</td>
              <td class="right mono">${kr(s.base_amount)}</td>
              <td class="right mono">%${s.vat_rate} · ${kr(s.vat_amount)}</td>
              <td class="right mono">${kr(s.base_amount + s.vat_amount)}</td></tr>`).join('')}
          </tbody></table>
          <table class="tbl" style="margin-top:8px"><tbody>
            ${on.indirim_minor ? `<tr><td class="muted">İndirim (satırlara yayıldı)</td>
              <td class="right mono muted">-${kr(on.indirim_minor)} ₺</td></tr>` : ''}
            ${on.ikram_minor ? `<tr><td class="muted">İkram (satırlara yayıldı)</td>
              <td class="right mono muted">-${kr(on.ikram_minor)} ₺</td></tr>` : ''}
            <tr><td>Matrah</td><td class="right mono">${kr(on.subtotal_minor)} ₺</td></tr>
            <tr><td>KDV</td><td class="right mono">${kr(on.vat_minor)} ₺</td></tr>
            <tr><td><b>Fatura toplamı</b></td><td class="right mono"><b>${kr(on.total_minor)} ₺</b></td></tr>
          </tbody></table>
          <p class="muted" style="font-size:12.5px;margin:8px 0 16px">Adisyonun kendi KDV hesabı:
            <b>${tl(on.adisyon_kdv.vatTotal)} ₺</b> — fatura ile aynı olması gerekir.</p>

          <div class="split-2">
            <div class="field"><label>Fatura ünvanı ya da ad soyad</label>
              <input class="input" id="fkUnvan" autocomplete="off" placeholder="Örnek Gıda Ltd. Şti.">
              <div class="muted" style="font-size:12px;margin-top:5px">"Nihai Tüketici" yazılamaz (GİB).</div></div>
            <div class="field"><label>VKN / TCKN</label>
              <input class="input mono" id="fkVkn" maxlength="11" autocomplete="off" placeholder="1234567890"></div>
          </div>
          <div class="split-2">
            <div class="field"><label>Vergi dairesi</label><input class="input" id="fkVd" autocomplete="off"></div>
            <div class="field"><label>e-Posta (isteğe bağlı)</label>
              <input class="input" id="fkMail" autocomplete="off" placeholder="fatura@ornek.com">
              <div class="muted" style="font-size:12px;margin-top:5px">e-Arşiv faturasını QNB bu adrese
                kendisi yollar; boşsa kağıt olarak işaretlenir.</div></div>
          </div>
          <div class="field"><label>Adres</label>
            <input class="input" id="fkAdres" autocomplete="off" placeholder="Saray Mah. Atatürk Cad. 12, Alanya/Antalya">
            <div class="muted" style="font-size:12px;margin-top:5px">Sonundaki "İlçe/İl" ayrı alanlara
              yazılır; böylece QNB'nin PDF'inde ilçe iki kez basılmaz.</div></div>
          <div class="split-2">
            <div class="field"><label>Servis ücreti (₺, isteğe bağlı)</label>
              <input class="input mono" id="fkServis" value="${servis || ''}" autocomplete="off" placeholder="0,00">
              <div class="muted" style="font-size:12px;margin-top:5px">Ürün satırı olarak değil,
                faturanın kendi "ilave" alanında gösterilir.</div></div>
            <div class="field"><label>Not (isteğe bağlı)</label><input class="input" id="fkNot" autocomplete="off"></div>
          </div>`}
          <div id="fkMsg"></div>
        </div>
        <div class="modal__foot">
          <button class="btn btn--ghost" data-close="1">Vazgeç</button><div class="spacer"></div>
          ${kalanYok ? '' : '<button class="btn btn--primary" id="fkGo">Faturayı kes</button>'}
        </div>`, { wide: true });

      if (kalanYok) return;
      $('#fkServis').onchange = async () => {
        const v = $('#fkServis').value.replace(',', '.');
        try { on = await api('GET', `/api/ebelge/adisyon/${orderId}/onizle?servis=${encodeURIComponent(v || 0)}`); }
        catch (e) { return err(e); }
        ciz(v);
      };
      $('#fkGo').onclick = async () => {
        const govde = {
          cust_title: $('#fkUnvan').value.trim(),
          cust_tax_no: $('#fkVkn').value.trim(),
          cust_tax_office: $('#fkVd').value.trim(),
          cust_address: $('#fkAdres').value.trim(),
          cust_email: $('#fkMail').value.trim(),
          note: $('#fkNot').value.trim(),
          servis: Number(String($('#fkServis').value || '0').replace(',', '.')) || 0,
        };
        if (!govde.cust_title || !govde.cust_tax_no) {
          $('#fkMsg').innerHTML = '<div class="alert alert--error">Ünvan ve VKN / TCKN zorunlu.</div>';
          return;
        }
        $('#fkGo').disabled = true; $('#fkGo').textContent = 'Kesiliyor…';
        try {
          const r = await api('POST', `/api/ebelge/adisyon/${orderId}/kes`, govde);
          closeModal();
          toast('Fatura kesildi: ' + r.full_no, 'ok');
          if (r.ebelge && r.ebelge.ok) {
            toast(r.ebelge.tip === 'EFATURA'
              ? 'e-Fatura GİB kuyruğuna alındı: ' + r.ebelge.no
              : 'e-Arşiv faturası oluştu: ' + r.ebelge.no, 'ok');
          } else if (r.ebelge && r.ebelge.error) {
            toast('Fatura kesildi ama gönderilemedi: ' + r.ebelge.error, 'error');
          }
          this.faturaDialog(r.id);
        } catch (e) {
          $('#fkGo').disabled = false; $('#fkGo').textContent = 'Faturayı kes';
          $('#fkMsg').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`;
        }
      };
    };
    ciz('');
  },

  /* =================================================================== */
  /*  3. GELEN FATURALAR                                                 */
  /* =================================================================== */
  async page_gelenfatura() {
    $('#main').innerHTML = `<div class="page is-on">
      ${subnavHtml('gelenfatura')}
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">Gelen faturalar</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px;margin-right:10px" id="glSon"></span>
        ${can('fatura.manage') ? '<button class="btn btn--primary" id="glCek">QNB\'den şimdi çek</button>' : ''}
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px">
        <input class="input" id="glQ" placeholder="fatura no, tedarikçi ya da VKN" style="max-width:280px">
        <label class="row" style="gap:6px;font-size:13.5px">
          <input type="checkbox" id="glBekleyen"> Yalnız yanıt bekleyenler</label>
        <button class="btn btn--ghost" id="glAra">Ara</button>
      </div>
      <div id="glBody"><div class="empty">Yükleniyor…</div></div></div>`;

    for (const b of $$('[data-sub]')) b.onclick = () => go(b.getAttribute('data-sub'));
    $('#glAra').onclick = () => this.glDraw();
    $('#glQ').onkeydown = (e) => { if (e.key === 'Enter') this.glDraw(); };
    $('#glBekleyen').onchange = () => this.glDraw();
    if ($('#glCek')) {
      $('#glCek').onclick = async () => {
        $('#glCek').disabled = true; $('#glCek').textContent = 'Çekiliyor…';
        try { const r = await api('POST', '/api/ebelge/gelen/cek'); toast(`QNB'den çekildi: ${r.yeni} yeni fatura.`, 'ok'); }
        catch (e) { err(e); }
        this.page_gelenfatura();
      };
    }
    await this.glDraw();
  },

  async glDraw() {
    let r;
    try {
      r = await api('GET', `/api/ebelge/gelen?q=${encodeURIComponent($('#glQ').value || '')}`
        + `&bekleyen=${$('#glBekleyen').checked ? '1' : '0'}`);
    } catch (e) { return err(e); }

    if (!r.aktif) {
      $('#glBody').innerHTML = `<div class="empty">Gelen e-Faturalar işletmenin QNB hesabından çekilir.
        <div class="muted" style="margin-top:6px">Önce <b>e-Fatura / e-Arşiv</b> ayarlarını yapın.</div>
        ${can('fatura.manage') ? '<div style="margin-top:12px"><button class="btn btn--primary" id="glAyar">Ayarlara git</button></div>' : ''}</div>`;
      if ($('#glAyar')) $('#glAyar').onclick = () => go('efatura');
      return;
    }
    $('#glSon').textContent = (r.son_cekme ? 'Son çekme: ' + trAn(String(r.son_cekme).replace('T', ' ')) : 'Hiç çekilmedi')
      + (r.ortam === 'canli' ? '' : ' · TEST ortamı');

    if (!r.gelen.length) {
      $('#glBody').innerHTML = `<div class="empty">Henüz gelen e-Fatura yok.
        <div class="muted" style="margin-top:6px">Tedarikçileriniz size e-Fatura kestiğinde burada görünür.</div></div>`;
      return;
    }
    $('#glBody').innerHTML = `<div class="card"><div class="card__head">
        <h3>Gelen faturalar</h3><div class="spacer"></div>
        ${r.sayac.bekleyen ? `<span class="badge badge--open">${r.sayac.bekleyen} yanıt bekliyor</span>` : ''}
        <span class="muted" style="margin-left:8px">${r.gelen.length} kayıt</span></div>
      <table class="tbl"><thead><tr>
        <th>Fatura no</th><th>Tarih</th><th>Tedarikçi</th><th>Tür</th>
        <th class="right">Tutar</th><th>Yanıt</th><th>Alış</th><th class="right">İşlem</th>
      </tr></thead><tbody>
      ${r.gelen.map(g => `<tr>
        <td class="mono">${esc(g.belge_no || '—')}</td>
        <td>${trTarih(g.belge_tarihi || g.gelis_tarihi)}</td>
        <td>${esc(g.gonderen || '—')}<div class="muted mono" style="font-size:12px">${esc(g.gonderen_vkn || '')}</div></td>
        <td><span class="badge badge--gray">${EB_SENARYO[g.senaryo] || esc(g.senaryo || '—')}</span></td>
        <td class="right mono">${kr(g.tutar_minor)} ₺</td>
        <td>${this.glYanitRozet(g, r.yanit_gun)}</td>
        <td>${g.document_id ? `<span class="muted">Alış #${g.document_id}</span>` : '<span class="muted">—</span>'}</td>
        <td class="right"><button class="btn btn--ghost btn--sm" data-gid="${g.id}">Aç</button></td>
      </tr>`).join('')}
      </tbody></table></div>`;
    for (const b of $$('[data-gid]')) b.onclick = () => this.gelenDialog(b.getAttribute('data-gid'));
  },

  glYanitRozet(g) {
    if (g.yanit) {
      return `<span class="badge ${g.yanit === 'KABUL' ? 'badge--closed' : 'badge--red'}">${g.yanit === 'KABUL' ? 'Kabul' : 'Red'}${
        g.yanit_durum === 'hata' ? ' — gitmedi' : ''}</span>`;
    }
    if (g.senaryo !== 'TICARIFATURA') return '<span class="muted">yanıt gerekmez</span>';
    return '<span class="badge badge--open">Yanıt bekliyor</span>';
  },

  async gelenDialog(id) {
    let r;
    try { r = await api('GET', `/api/ebelge/gelen/${id}`); } catch (e) { return err(e); }
    const g = r.gelen;
    const y = r.yanitlanabilir;
    const tekrar = g.yanit_durum === 'hata' && g.yanit;

    modal(`
      <div class="modal__head"><h3 class="mono">${esc(g.belge_no || '—')}</h3>
        <span class="badge badge--gray" style="margin-left:8px">${EB_SENARYO[g.senaryo] || esc(g.senaryo || '')}</span>
        ${g.ortam === 'test' ? '<span class="badge badge--gray" style="margin-left:6px">TEST</span>' : ''}
        <div class="spacer"></div>
        <a class="btn btn--primary btn--sm" href="/api/ebelge/gelen/${g.id}/pdf" target="_blank" rel="noopener">Resmî PDF</a>
        <button class="close-x" data-close="1" style="margin-left:8px">✕</button></div>
      <div class="modal__body">
        <div class="split-2" style="gap:14px">
          <table class="tbl"><tbody>
            <tr><td style="width:150px">Tedarikçi</td><td>${esc(g.gonderen || '—')}</td></tr>
            <tr><td>VKN / TCKN</td><td class="mono">${esc(g.gonderen_vkn || '—')}</td></tr>
            <tr><td>Fatura tarihi</td><td>${trTarih(g.belge_tarihi)}</td></tr>
            <tr><td>Bize geliş</td><td>${trTarih(g.gelis_tarihi)}</td></tr>
            <tr><td>ETTN</td><td class="mono" style="font-size:12px">${esc(g.uuid)}</td></tr>
            <tr><td>Ödenecek tutar</td><td class="mono"><b>${kr(g.tutar_minor)} ₺</b></td></tr>
          </tbody></table>
          <div>
            ${g.senaryo !== 'TICARIFATURA' ? `<div class="alert alert--info">TEMEL faturaya kabul/red
                yanıtı verilmez. İtirazınız varsa tedarikçiyle görüşün: iade faturası ya da noter/KEP.</div>`
              : g.yanit ? `<div class="alert alert--${g.yanit === 'KABUL' ? 'ok' : 'error'}">
                  <b>${g.yanit === 'KABUL' ? 'Kabul edildi' : 'Reddedildi'}</b>${g.yanit_neden ? ' — ' + esc(g.yanit_neden) : ''}
                  <div class="muted" style="font-size:12px;margin-top:4px">${trAn(g.yanit_at)}</div></div>
                  ${tekrar ? `<div class="alert alert--error"><b>QNB'ye iletilemedi:</b> ${esc(g.yanit_hata || '')}
                    <div style="margin-top:8px"><button class="btn btn--primary btn--sm" id="gdTekrar">Yeniden gönder</button></div>
                    <div class="muted" style="font-size:12px;margin-top:6px">Aynı yanıt kimliğiyle gider;
                      tedarikçiye ikinci bir yanıt ulaşmaz.</div></div>` : ''}`
              : y.ok ? `<div class="alert alert--warn">TİCARİ faturayı <b>${r.yanit_gun} gün</b> içinde kabul
                    ya da reddedebilirsiniz. Süre dolarsa kabul edilmiş sayılır.</div>
                  ${can('fatura.manage') ? `
                  <div class="field"><label>Red sebebi (red için zorunlu)</label>
                    <input class="input" id="gdNeden" autocomplete="off" placeholder="tedarikçi bu yazıyı görür"></div>
                  <div class="row" style="gap:8px">
                    <button class="btn btn--primary" id="gdKabul">Kabul et</button>
                    <button class="btn btn--danger" id="gdRed">Reddet</button></div>`
                  : '<p class="muted">Yanıt vermek için yetkiniz yok.</p>'}`
              : `<div class="alert alert--info">${esc(y.neden)}</div>`}

            <h4 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-3)">Alış</h4>
            ${g.document_id ? `<p style="margin:0">Taslak alış belgesi <b>#${g.document_id}</b> oluşturuldu.
                <button class="btn btn--ghost btn--sm" id="gdAc" style="margin-left:8px">Stok ekranında aç</button></p>`
              : g.yanit === 'RED' ? '<p class="muted" style="margin:0">Reddedilen fatura alışa aktarılmaz.</p>'
              : can('stock.manage') ? `<button class="btn btn--ghost" id="gdAlis">Alışa aktar</button>
                  <div class="muted" style="font-size:12px;margin-top:6px">Tedarikçi VKN ile bulunur (yoksa açılır),
                    satırlar taslak alışa yazılır. Ürün eşleştirmesini ve stoğa işlemeyi siz onaylarsınız.</div>`
              : '<p class="muted" style="margin:0">Alışa aktarmak için stok yetkisi gerekir.</p>'}
          </div>
        </div>

        <div class="card" style="margin-top:14px"><div class="card__head"><h3>Kalemler</h3>
            <div class="spacer"></div><span class="muted">${r.satirlar.length} satır</span></div>
          ${r.satirlar.length ? `<table class="tbl"><thead><tr>
            <th>Mal / hizmet</th><th class="right">Miktar</th><th class="right">Birim fiyat</th>
            <th class="right">KDV</th><th class="right">Matrah</th></tr></thead><tbody>
            ${r.satirlar.map(s => `<tr><td>${esc(s.ad)}</td>
              <td class="right mono">${s.miktar}</td>
              <td class="right mono">${kr(s.birimFiyat)}</td>
              <td class="right mono">%${s.kdvOran}</td>
              <td class="right mono">${kr(s.tutar)}</td></tr>`).join('')}
          </tbody></table>` : '<div class="card__body"><p class="muted" style="margin:0">Kalemler QNB\'den alınamadı; Resmî PDF\'e bakın.</p></div>'}
        </div>
      </div>`, { wide: true });

    const yanit = async (karar) => {
      const neden = $('#gdNeden') ? $('#gdNeden').value.trim() : (g.yanit_neden || '');
      const onay = await confirmBox(karar === 'KABUL' ? 'Faturayı kabul et' : 'Faturayı reddet',
        karar === 'KABUL' ? 'Fatura KABUL edilecek. Bu yanıt geri alınamaz.' : 'Fatura REDDEDİLECEK. Bu yanıt geri alınamaz.',
        karar === 'RED');
      if (!onay) return;
      try {
        await api('POST', `/api/ebelge/gelen/${g.id}/yanit`, { karar, neden });
        toast(karar === 'KABUL' ? 'Kabul yanıtı QNB\'ye gönderildi.' : 'Red yanıtı QNB\'ye gönderildi.', 'ok');
        closeModal(); this.glDraw();
      } catch (e) { err(e); }
    };
    if ($('#gdKabul')) $('#gdKabul').onclick = () => yanit('KABUL');
    if ($('#gdRed')) $('#gdRed').onclick = () => yanit('RED');
    if ($('#gdTekrar')) $('#gdTekrar').onclick = () => yanit(g.yanit);
    if ($('#gdAlis')) {
      $('#gdAlis').onclick = async () => {
        $('#gdAlis').disabled = true; $('#gdAlis').textContent = 'Aktarılıyor…';
        try {
          const a = await api('POST', `/api/ebelge/gelen/${g.id}/alis`);
          toast(a.zaten ? 'Bu fatura zaten alışa aktarılmış.'
            : `Taslak alış oluşturuldu${a.yeniTedarikci ? ' (tedarikçi de açıldı)' : ''}. Satırları eşleştirip stoğa işleyin.`, 'ok');
          closeModal(); this.glDraw();
        } catch (e) { err(e); this.gelenDialog(g.id); }
      };
    }
    if ($('#gdAc')) $('#gdAc').onclick = () => { closeModal(); go('stock'); };
  },

  /* =================================================================== */
  /*  4. e-FATURA / e-ARŞİV AYARLARI                                     */
  /* =================================================================== */
  async page_efatura() {
    $('#main').innerHTML = `<div class="page is-on">
      ${subnavHtml('efatura')}
      <div class="row" style="margin-bottom:14px">
        <h2 class="page-title" style="margin:0">e-Fatura / e-Arşiv</h2><div class="spacer"></div>
        <span class="muted" style="font-size:13px">QNB eSolutions</span>
      </div>
      <div id="efBody"><div class="empty">Yükleniyor…</div></div></div>`;
    for (const b of $$('[data-sub]')) b.onclick = () => go(b.getAttribute('data-sub'));
    await this.efDraw();
  },

  async efDraw(sinama) {
    let r;
    try { r = await api('GET', '/api/ebelge/ayarlar'); } catch (e) { return err(e); }
    const a = r.ayar;
    const canli = a.ortam === 'canli';

    $('#efBody').innerHTML = `
      ${r.kilit ? `<div class="alert alert--error" style="margin-bottom:14px">
          <b>Gönderim durduruldu.</b> ${esc(r.kilit.error)}</div>` : ''}

      ${sinama ? `<div class="split-2" style="margin-bottom:14px">
        <div class="alert alert--${sinama.efatura.ok ? 'ok' : 'error'}"><b>e-Fatura servisi:</b>
          ${sinama.efatura.ok
            ? 'bağlandı' + (sinama.efatura.unvan ? ' · ' + esc(sinama.efatura.unvan) : '')
              + (sinama.efatura.etiket ? ' · ' + esc(sinama.efatura.etiket) : ' · bu VKN e-Fatura mükellefi görünmüyor')
            : esc(sinama.efatura.error)}</div>
        <div class="alert alert--${sinama.earsiv.ok ? 'ok' : 'error'}"><b>e-Arşiv servisi:</b>
          ${sinama.earsiv.ok ? 'bağlandı' : esc(sinama.earsiv.error)}</div>
      </div>` : ''}

      <div class="card" style="margin-bottom:14px"><div class="card__head">
          <h3>Kendi QNB hesabınızı bağlamak</h3><div class="spacer"></div>
          <span class="badge badge--gray">her işletme kendi hesabıyla</span></div>
        <div class="card__body">
          <ol style="margin:0;padding-left:20px;line-height:1.75">
            <li><b>QNB eSolutions</b>'tan işletmenizin <b>kendi VKN</b>'siyle e-Fatura ve e-Arşiv hizmeti alın.</li>
            <li>QNB portalinde (portal.qnbesolutions.com.tr/yonetim) <b>Yönetim → Genel → Kullanıcı
              Tanımları</b>'ndan NOKTApp için <b>ayrı bir kullanıcı</b> açın. QNB'de portal ve web servis
              kullanıcısı aynıdır; ayrı açmak önemli, çünkü <b>portal parolası üç ayda bir değişir</b> ve
              eski parolayla denemeye devam eden program kullanıcıyı bloke ettirir.</li>
            <li>O kullanıcının adını ve parolasını aşağıya yazın; Ortam: <b>Canlı</b>. Servis adresleri
              kendiliğinden doludur — canlı adresler bütün müşteriler için aynıdır.</li>
            <li><b>Bağlantıyı sına</b>, sonra ilk faturanızı kesin. ERP kodu (${esc(r.erp_kodu)}) QNB'de
              NOKTApp için tanımlıdır; işletmenin ayrıca bir şey yapması gerekmez.</li>
          </ol>
          <p class="muted" style="font-size:12.5px;margin:14px 0 0">Kullanıcı adı ve parola yalnızca bu
            bilgisayarda, şifreli saklanır. NOKTApp sunucusuna gitmez, bulut yedeğine girmez.</p>
        </div></div>

      ${a.aktif ? this.efKontorKarti(r) : ''}

      <div class="split-2" style="gap:14px;align-items:start">
        <div class="card"><div class="card__head"><h3>QNB eSolutions</h3><div class="spacer"></div>
            <span class="badge ${a.aktif ? 'badge--closed' : 'badge--gray'}">${a.aktif ? 'Açık' : 'Kapalı'}</span>
            <span class="badge ${canli ? 'badge--open' : 'badge--gray'}" style="margin-left:6px">${canli ? 'CANLI' : 'TEST'}</span></div>
          <div class="card__body">
            <label class="row" style="gap:8px;margin-bottom:10px"><input type="checkbox" id="efAktif" ${a.aktif ? 'checked' : ''}>
              <span><b>e-Fatura / e-Arşiv açık</b> — kesilen faturalar QNB üzerinden GİB'e gider</span></label>
            <label class="row" style="gap:8px;margin-bottom:14px"><input type="checkbox" id="efOtomatik" ${a.otomatik ? 'checked' : ''}>
              <span>Fatura kesilince <b>hemen gönder</b></span></label>
            <div class="field"><label>Ortam</label>
              <select class="input" id="efOrtam">
                <option value="test" ${canli ? '' : 'selected'}>Test — QNB test hesabı (yasal geçerliliği yok)</option>
                <option value="canli" ${canli ? 'selected' : ''}>Canlı — işletmenin kendi QNB hesabı</option>
              </select>
              <div class="muted" style="font-size:12px;margin-top:5px">Ortam değişince kayıtlı parolalar
                silinir; yeni ortamın parolasını yazın.</div></div>
            <div class="field"><label>İşletme VKN / TCKN</label>
              <input class="input mono" id="efVkn" maxlength="11" value="${esc(a.vkn || '')}" ${canli ? 'readonly' : ''} autocomplete="off">
              ${canli ? '<div class="muted" style="font-size:12px;margin-top:5px">Canlıda Ayarlar\'daki işletme VKN\'si kullanılır.</div>' : ''}</div>
            <div class="split-2">
              <div class="field"><label>e-Fatura seri (3 harf)</label>
                <input class="input mono" id="efSeri" maxlength="3" value="${esc(a.efatura_seri || 'NKT')}" autocomplete="off"></div>
              <div class="field"><label>Fatura seri (yerel, 3 harf)</label>
                <input class="input mono" id="efFtSeri" maxlength="3" value="${esc(a.fatura_seri || 'FTR')}" autocomplete="off"></div>
            </div>
            <div class="split-2">
              <div class="field"><label>İl</label><input class="input" id="efIl" value="${esc(a.il || '')}" placeholder="Antalya" autocomplete="off"></div>
              <div class="field"><label>İlçe</label><input class="input" id="efIlce" value="${esc(a.ilce || '')}" placeholder="Alanya" autocomplete="off"></div>
            </div>
            <div class="split-2">
              <div class="field"><label>e-Arşiv şube</label><input class="input mono" id="efSube" value="${esc(a.sube || 'DFLT')}" autocomplete="off"></div>
              <div class="field"><label>e-Arşiv kasa</label><input class="input mono" id="efKasa" value="${esc(a.kasa || 'DFLT')}" autocomplete="off"></div>
            </div>
            <div class="field"><label>Gönderen posta kutusu (isteğe bağlı)</label>
              <input class="input mono" id="efEtiket" value="${esc(a.gonderen_etiket || '')}" placeholder="urn:mail:defaultgb@…" autocomplete="off"></div>
            <p class="muted" style="font-size:12.5px;margin:0">NOKTApp ERP kodu: <b>${esc(r.erp_kodu)}</b>
              — QNB'de tanımlıdır, her işletmede aynıdır.</p>
          </div></div>

        <div class="card"><div class="card__head"><h3>Kullanıcılar</h3><div class="spacer"></div>
            ${a.sifre_korumali ? '<span class="badge badge--closed">Parolalar bu bilgisayarda şifreli</span>'
              : '<span class="badge badge--red">Parola şifrelenemiyor</span>'}</div>
          <div class="card__body">
            <p class="muted" style="margin-top:0;font-size:12.5px">QNB'de portal ve web servis kullanıcısı
              aynıdır. NOKTApp için ayrı bir kullanıcı açın: portalde o kullanıcının parolası değişirse
              yenisini buraya da yazın, yoksa QNB kullanıcıyı bloke eder.</p>
            ${a.sifre_korumali ? '' : `<div class="alert alert--warn">Parolalar bu bilgisayarda
              şifrelenemiyor (${esc(a.sifre_yontemi || 'yöntem yok')}). Kaydedilir ama korumasız durur.</div>`}
            <h4 style="margin:14px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-3)">e-Fatura</h4>
            <div class="field"><label>Kullanıcı</label>
              <input class="input mono" id="efKul" value="${esc(a.efatura_kullanici || '')}" autocomplete="off"></div>
            <div class="field"><label>Parola</label>
              <input class="input" type="password" id="efSifre" autocomplete="new-password"
                placeholder="${a.efatura_sifre_var ? '•••••• (değiştirmek için yazın)' : ''}"></div>
            <div class="field"><label>Servis adresi</label>
              <input class="input mono" id="efUrl" value="${esc(a.efatura_url || '')}"
                placeholder="${esc(r.varsayilan[a.ortam].efatura)}" autocomplete="off"></div>
            <h4 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-3)">e-Arşiv</h4>
            <div class="field"><label>Kullanıcı</label>
              <input class="input mono" id="eaKul" value="${esc(a.earsiv_kullanici || '')}" autocomplete="off"></div>
            <div class="field"><label>Parola</label>
              <input class="input" type="password" id="eaSifre" autocomplete="new-password"
                placeholder="${a.earsiv_sifre_var ? '•••••• (değiştirmek için yazın)' : ''}"></div>
            <div class="field"><label>Servis adresi</label>
              <input class="input mono" id="eaUrl" value="${esc(a.earsiv_url || '')}"
                placeholder="${esc(r.varsayilan[a.ortam].earsiv)}" autocomplete="off"></div>
          </div></div>
      </div>

      <div class="row" style="gap:8px;margin:16px 0" id="efMsg2">
        <button class="btn btn--primary" id="efKaydet">Kaydet</button>
        <button class="btn btn--ghost" id="efSina">Bağlantıyı sına</button>
        <span class="muted" style="font-size:12.5px">Sınama belge oluşturmaz.</span>
      </div>
      <div id="efMsg"></div>
      <div id="efGunluk"></div>`;

    const topla = () => ({
      aktif: $('#efAktif').checked ? 1 : 0,
      otomatik: $('#efOtomatik').checked ? 1 : 0,
      ortam: $('#efOrtam').value,
      vkn: $('#efVkn').value.trim(),
      efatura_seri: $('#efSeri').value.trim(),
      fatura_seri: $('#efFtSeri').value.trim(),
      il: $('#efIl').value.trim(), ilce: $('#efIlce').value.trim(),
      sube: $('#efSube').value.trim(), kasa: $('#efKasa').value.trim(),
      gonderen_etiket: $('#efEtiket').value.trim(),
      efatura_kullanici: $('#efKul').value.trim(), efatura_sifre: $('#efSifre').value,
      earsiv_kullanici: $('#eaKul').value.trim(), earsiv_sifre: $('#eaSifre').value,
      efatura_url: $('#efUrl').value.trim(), earsiv_url: $('#eaUrl').value.trim(),
    });
    const kaydet = async () => {
      await api('POST', '/api/ebelge/ayarlar', topla());
    };
    $('#efKaydet').onclick = async () => {
      try { await kaydet(); toast('e-Belge ayarları kaydedildi.', 'ok'); this.efDraw(); }
      catch (e) { $('#efMsg').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
    $('#efSina').onclick = async () => {
      $('#efSina').disabled = true; $('#efSina').textContent = 'Sınanıyor…';
      try {
        await kaydet();
        const s = await api('POST', '/api/ebelge/sina');
        this.efDraw(s.sonuc);
      } catch (e) {
        $('#efSina').disabled = false; $('#efSina').textContent = 'Bağlantıyı sına';
        $('#efMsg').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`;
      }
    };
    await this.efGunluk();
  },

  /*
   * Kalan kontör. Bitince fatura gönderilemez ve bunu faturayı kesmeye
   * çalışırken öğrenmek istemezsiniz; 50'nin altına düşünce söylenir.
   */
  efKontorKarti(r) {
    const k = r.kontor;
    const hucre = (ad, v) => {
      if (!v) return `<div class="stat"><div class="stat__label">${ad}</div><div class="stat__value">—</div></div>`;
      if (!v.ok) return `<div class="stat"><div class="stat__label">${ad}</div>
        <div class="stat__value" style="font-size:13px;color:var(--red)">${esc(v.error || 'sorgulanamadı')}</div></div>`;
      if (v.yok) return `<div class="stat"><div class="stat__label">${ad}</div>
        <div class="stat__value" style="font-size:14px">bilgi yok${k.ortam === 'test' ? '<div class="muted" style="font-size:12px">test hesabında kontör tutulmaz</div>' : ''}</div></div>`;
      const az = v.kalan < r.kontor_az;
      return `<div class="stat"><div class="stat__label">${ad}</div>
        <div class="stat__value" style="font-size:20px${az ? ';color:var(--red)' : ''}">${v.kalan}</div>
        <div class="muted" style="font-size:12px">/ ${v.toplam} alınan${v.bitis
          ? ' · bitiş ' + String(v.bitis).slice(6, 8) + '.' + String(v.bitis).slice(4, 6) + '.' + String(v.bitis).slice(0, 4) : ''}</div></div>`;
    };
    const az = k && ['efatura', 'earsiv'].some(s => k[s] && k[s].ok && !k[s].yok && k[s].kalan < r.kontor_az);
    setTimeout(() => {
      const b = $('#efKontorYenile');
      if (b) {
        b.onclick = async () => {
          b.disabled = true; b.textContent = 'Sorguluyor…';
          try { await api('POST', '/api/ebelge/kontor'); } catch (e) { err(e); }
          this.efDraw();
        };
      }
    }, 0);
    return `<div class="card" style="margin-bottom:14px"><div class="card__head"><h3>Kalan kontör</h3>
        <div class="spacer"></div>
        <span class="muted" style="font-size:12.5px;margin-right:10px">${k && k.t
          ? 'son sorgu ' + new Date(k.t).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
          : 'henüz sorgulanmadı'}</span>
        <button class="btn btn--ghost btn--sm" id="efKontorYenile">Yenile</button></div>
      <div class="card__body">
        <div class="split-2">${hucre('e-Fatura', k && k.efatura)}${hucre('e-Arşiv', k && k.earsiv)}</div>
        ${az ? `<div class="alert alert--warn" style="margin-top:12px">Kontör azaldı. Bitince fatura
          gönderilemez; QNB'den kontör alın.</div>` : ''}
      </div></div>`;
  },

  /** QNB ile yapılan her konuşma. Parola bu kayda yazılmaz. */
  async efGunluk() {
    let r;
    try { r = await api('GET', '/api/ebelge/gunluk?n=30'); } catch (e) { return; }
    if (!r.kayitlar.length) return;
    $('#efGunluk').innerHTML = `<div class="card"><div class="card__head">
        <h3>QNB iletişim kaydı</h3><div class="spacer"></div>
        <span class="badge badge--gray">son ${r.kayitlar.length}</span></div>
      <table class="tbl"><thead><tr>
        <th>Zaman</th><th>Servis</th><th>İşlem</th><th class="right">HTTP</th>
        <th>Kod</th><th>Açıklama</th><th class="right">Süre</th></tr></thead><tbody>
      ${r.kayitlar.map(k => `<tr>
        <td class="muted" style="font-size:12.5px">${trAn(String(k.created_at).replace('T', ' '))}</td>
        <td>${k.servis === 'efatura' ? 'e-Fatura' : 'e-Arşiv'}</td>
        <td class="mono" style="font-size:12.5px">${esc(k.islem)}</td>
        <td class="right mono">${k.http_status || '—'}</td>
        <td class="mono${/^(AE00000|OK|1|3)$/.test(String(k.sonuc_kodu || '')) ? '' : ' neg'}">${esc(k.sonuc_kodu || '—')}</td>
        <td class="muted" style="font-size:12.5px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k.sonuc_metni || '')}</td>
        <td class="right mono">${k.duration_ms || 0} ms</td></tr>`).join('')}
      </tbody></table>
      <div class="card__body"><p class="muted" style="margin:0;font-size:12.5px">Parolalar kayda yazılmaz.</p></div></div>`;
  },

});
