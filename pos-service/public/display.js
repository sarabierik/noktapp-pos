'use strict';
/* Moved out of display.html so the page can be served under a Content
   Security Policy with script-src 'self'. Guest-facing pages are exactly where an
   inline-script exemption is least acceptable, so the exemption went instead. */
const tl = n => (Math.round(Number(n||0)*100)/100).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc = s => String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/*
 * The three marks come from /social-marks.js, which is also what the printed
 * A5 table card draws from. One source, because a mark that is defined twice
 * is a mark that is two different shapes by next spring.
 */
const SOCIAL_ORDER = NOKT_SOCIAL.ORDER;

function renderSocial(s){
  const el = document.getElementById('social');
  if(!el) return;
  const parts = [];
  if(Number(s.social_enabled)){
    for(const k of SOCIAL_ORDER){
      const v = s['social_' + k];
      if(!v) continue;
      /* Facebook pages are named, not handled: an @ in front of a page name is
         wrong, so only the two that use handles get one. */
      const shown = NOKT_SOCIAL.display(k, v);
      parts.push('<div class="soc"><svg viewBox="0 0 24 24">' + NOKT_SOCIAL.svgInner(k, '#FF9A4D') + '</svg>'
        + '<b>' + esc(shown) + '</b></div>');
    }
  }
  const html = parts.join('');
  if(el.dataset.html !== html){ el.innerHTML = html; el.dataset.html = html; }
}
async function tick(){
  try{
    const r = await (await fetch('/api/display')).json();
    if(!r.ok) return;
    if(r.business) document.getElementById('biz').textContent = r.business.company_name || 'NOKTApp';
    if(r.settings){
      const s = r.settings;
      renderSocial(s);
      document.getElementById('headline').textContent = s.headline || 'Hoş geldiniz';
      document.getElementById('subline').textContent  = s.subline  || 'Afiyet olsun';
      document.getElementById('footNote').textContent = s.foot_note || 'NOKTApp POS';
      /* The QR arrives already drawn (np_display_settings.qr_svg, rendered when
         it was saved), so this page needs no barcode library and does no work
         on a poll it makes twice a second. */
      /*
       * The box scales with the screen, with the pixel value as a floor.
       * A fixed 150 px looks like a postage stamp on the 1080p television
       * most of these are plugged into, which is what "not fit in the frame"
       * looked like from across a counter.
       */
      const px = s.media_size === 'buyuk' ? 300 : s.media_size === 'orta' ? 230 : 170;
      const box = `width:min(${px}px, 30vh);`;
      const parts = [];
      if(Number(s.qr_enabled) && s.qr_svg){
        parts.push(`<div class="xitem" style="${box}"><div class="xbox" style="${box}">${s.qr_svg}</div>`
          + (s.qr_caption ? `<div class="xcap">${esc(s.qr_caption)}</div>` : '') + '</div>');
      }
      if(Number(s.image_enabled) && s.image_data){
        parts.push(`<div class="xitem" style="${box}"><div class="xbox" style="${box}">`
          + `<img src="${esc(s.image_data)}" alt=""></div>`
          + (s.image_caption ? `<div class="xcap">${esc(s.image_caption)}</div>` : '') + '</div>');
      }
      const ex = document.getElementById('extras');
      const html = parts.join('');
      if(ex.dataset.html !== html){ ex.innerHTML = html; ex.dataset.html = html; }
    }
    const o = r.order;
    if(!o){
      document.getElementById('tableName').textContent = '—';
      document.getElementById('billNo').textContent = 'Adisyon';
      document.getElementById('lines').innerHTML = '<div class="idle">Şu anda açık adisyon yok.</div>';
      document.getElementById('sum').innerHTML = '';
      return;
    }
    document.getElementById('tableName').textContent = o.table_name || 'Hızlı satış';
    document.getElementById('billNo').textContent = 'Adisyon #' + o.adisyon_no;
    document.getElementById('lines').innerHTML = o.items.map(i=>`
      <div class="ln"><div class="q">${Number(i.qty)}</div>
        <div><div class="n">${esc(i.product_name)}</div></div>
        <div class="t">${tl(i.line_total)}</div></div>`).join('') || '<div class="idle">Adisyon boş.</div>';
    document.getElementById('sum').innerHTML = `
      <div class="row"><span>Ara toplam</span><span>${tl(o.total)} ₺</span></div>
      ${Number(o.discount_total)>0?`<div class="row"><span>İndirim</span><span>-${tl(o.discount_total)} ₺</span></div>`:''}
      <div class="row"><span>KDV</span><span>${tl(o.vat_total)} ₺</span></div>
      <div class="grand"><span>${o.paid>0?'Kalan':'Toplam'}</span><b>${tl(o.paid>0?o.due:o.grand_total)} ₺</b></div>`;
  }catch(e){}
}
tick(); setInterval(tick, 1500);
