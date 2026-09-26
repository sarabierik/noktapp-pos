/* =====================================================================
   NOKTApp POS - Kasa: vardiya, kasa hareketi, kasa sayımı, X raporu,
                        çekmece kaydı, vardiya geçmişi
   =====================================================================
   Until now the entire shift lifecycle existed only as a chip in the header
   saying "Vardiya kapalı". The routes were there, the ledger was there, and a
   cashier had no way to open a drawer, put money into it, take money out of
   it, count it or close it. This is that screen.

   Two pages:
     Kasa            - the drawer as it stands right now, and everything you
                       can do to it. One screen, no sub-tabs: a cashier at the
                       end of a ten hour shift should not be navigating.
     Vardiya geçmişi - past drawers with their variances, because one short
                       night is a bad night and the same person short eight
                       times is a conversation.

   Same visual grammar as the rest of the till: .card, .tbl, .stat, .field,
   .badge, .pad, .total-row, .right, .mono. One accent (orange). Nothing green
   - a drawer that balances is ink-coloured; red is kept for the one number
   that needs attention, the shortfall.
   ===================================================================== */
'use strict';

registerIcon('kasa',
  '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 12h18M9 12v3M15 12v3"/>' +
  '<path d="M7 7V5.5A2.5 2.5 0 019.5 3h5A2.5 2.5 0 0117 5.5V7"/>');
registerIcon('vardiyalar',
  '<path d="M3.5 12a8.5 8.5 0 103-6.5"/><path d="M3 4v5h5"/><path d="M12 8v4.2l3 1.8"/>');

registerPage({ id: 'kasa', label: 'Kasa', icon: 'kasa', perm: 'payment.take' }, 'tables');
registerPage({ id: 'vardiyalar', label: 'Vardiya geçmişi', icon: 'vardiyalar', perm: 'report.view' , group: 'kasa' }, 'kasa');

/* ------------------------------------------------------------ helpers */
const tillTl = (n) => tl(n) + ' ₺';

/** The denomination list, as the server defines it. Cached after the first read. */
let TILL_DENOMS = null;

/**
 * How a variance is written.
 *
 * A drawer that is short is the only figure on this screen that gets a colour,
 * and it gets red. An over drawer is not good news either - it usually means a
 * sale that was never rung up - so it is called out by name but stays ink, and
 * a drawer that balances says so in plain words instead of turning green.
 */
function tillVariance(v) {
  const n = Number(v || 0);
  if (Math.abs(n) < 0.005) return { cls: '', label: 'Kasa tam', text: tillTl(0) };
  if (n < 0) return { cls: 'is-loss', label: 'Kasa açığı', text: '− ' + tillTl(Math.abs(n)) };
  return { cls: '', label: 'Kasa fazlası', text: '+ ' + tillTl(n) };
}

/** "03.09.2026 14:20" from what MariaDB hands back as a string. */
function tillWhen(s) {
  if (!s) return '—';
  const t = String(s).replace('T', ' ').slice(0, 16);
  const [d, hm] = t.split(' ');
  const p = d.split('-');
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}${hm ? ' ' + hm : ''}` : t;
}
const tillDay = (s) => (s ? String(s).slice(0, 10).split('-').reverse().join('.') : '—');

function tillStat(label, value, sub, cls) {
  return `<div class="stat"><div class="stat__label">${esc(label)}</div>
    <div class="stat__value${cls ? ' ' + cls : ''}">${value}</div>
    <div class="stat__sub">${sub || ''}</div></div>`;
}

/** One line of the drawer ledger. `strong` marks the line that is the answer. */
function tillLine(label, value, opts = {}) {
  return `<div class="total-row${opts.grand ? ' total-row--grand' : ''}">
    <span>${esc(label)}${opts.hint ? ` <span class="muted" style="font-size:12px">${esc(opts.hint)}</span>` : ''}</span>
    <span class="mono${opts.cls ? ' ' + opts.cls : ''}${opts.strong ? ' strong' : ''}">${value}</span></div>`;
}

Screens.add({

  /* ==================================================================
     KASA
     ================================================================== */
  async page_kasa() {
    $('#main').innerHTML = `<div class="page is-on"><div id="tillBody">
      <div class="empty">Yükleniyor…</div></div></div>`;
    await this.tillLoad();
  },

  async tillLoad() {
    try {
      const s = await api('GET', '/api/till/state');
      TILL_DENOMS = s.denominations;
      if (s.shift) this.tillDrawOpen(s); else this.tillDrawClosed(s);
    } catch (e) {
      $('#tillBody').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`;
    }
  },

  /* ------------------------------------------------------- kasa kapalı */
  /*
   * With no drawer open the screen has exactly two jobs: take the opening
   * float, and show how the last shift came out. The second one is not
   * decoration - "how did the previous cashier finish" is the first thing the
   * one taking over asks, and it used to mean opening a report.
   */
  tillDrawClosed(s) {
    const prev = s.last_closed;
    const v = prev ? tillVariance(prev.variance) : null;
    $('#tillBody').innerHTML = `
      <div class="split-2">
        <div class="card">
          <div class="card__head"><h3>Kasa kapalı</h3><div class="spacer"></div>
            <span class="badge badge--gray">İş günü ${tillDay(s.business_date)}</span></div>
          <div class="card__body">
            <p class="muted" style="margin-top:0">
              Satış alabilmek için vardiyayı açın. Çekmeceye koyduğunuz bozukluk
              açılış kasasıdır ve gün sonunda sayılan tutardan düşülür.</p>
            <div class="field"><label>Açılış kasası (₺)</label>
              <input class="input mono" id="tkFloat" type="number" step="0.01" min="0" value="0.00"></div>
            <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:16px">
              ${[250, 500, 1000, 2000].map(n =>
                `<button class="btn btn--ghost btn--sm" data-float="${n}">${n} ₺</button>`).join('')}
              <button class="btn btn--ghost btn--sm" data-float="0">Sıfırla</button>
            </div>
            <div class="field"><label>Not (isteğe bağlı)</label>
              <input class="input" id="tkNote" placeholder="Sabah vardiyası"></div>
            <button class="btn btn--primary btn--wide btn--lg" id="tkOpen"
              ${can('shift.open') ? '' : 'disabled'}>Vardiyayı aç</button>
            ${can('shift.open') ? '' :
              '<p class="muted" style="font-size:12.5px;margin-bottom:0">Vardiya açma yetkiniz yok.</p>'}
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Son kapanan vardiya</h3></div>
          ${prev ? `<div class="card__body">
            <div class="row" style="margin-bottom:12px">
              <span class="badge badge--closed">#${prev.shift.shift_no}</span>
              <span class="muted">${tillDay(prev.shift.business_date)}</span>
              <div class="spacer"></div>
              <span class="muted">${esc(prev.shift.closed_by_name || '')}</span>
            </div>
            ${tillLine('Kasada olması gereken', tillTl(prev.expected_cash))}
            ${tillLine('Sayılan', tillTl(prev.counted_cash))}
            ${tillLine(v.label, v.text, { grand: true, cls: v.cls })}
            <button class="btn btn--ghost btn--wide" id="tkPrev" style="margin-top:12px">Özeti aç</button>
          </div>` : '<div class="empty">Henüz kapanmış vardiya yok.</div>'}
        </div>
      </div>`;

    $$('#tillBody [data-float]').forEach(b => b.onclick = () => {
      const cur = Number($('#tkFloat').value || 0);
      const add = Number(b.dataset.float);
      $('#tkFloat').value = (add === 0 ? 0 : cur + add).toFixed(2);
    });
    if (prev) $('#tkPrev').onclick = () => this.tillShiftDetail(prev.shift.id);
    $('#tkOpen').onclick = async () => {
      try {
        await api('POST', '/api/till/shift/open', {
          opening_float: Number($('#tkFloat').value || 0), note: $('#tkNote').value || null });
        toast('Vardiya açıldı', 'ok');
        refreshHeader();
        this.tillLoad();
      } catch (e) { err(e); }
    };
  },

  /* -------------------------------------------------------- kasa açık */
  tillDrawOpen(s) {
    const k = s.shift;
    const nonCash = k.breakdown.filter(b => b.method !== 'nakit');
    $('#tillBody').innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <span class="badge badge--open">Vardiya #${k.shift.shift_no} açık</span>
        <span class="muted">${esc(k.shift.opened_by_name || '')} açtı · ${tillWhen(k.shift.opened_at)}</span>
      </div>

      <div class="split-4" style="margin-bottom:14px">
        ${tillStat('Kasada olması gereken', tillTl(k.expected_cash),
          'açılış + nakit + giren − çıkan')}
        ${tillStat('Nakit satış', tillTl(k.cash_sales), k.order_count + ' adisyon')}
        ${tillStat('Kart / diğer', tillTl(k.card_sales), 'çekmecede değil')}
        ${tillStat('Açılış kasası', tillTl(k.opening_float), k.shift.note ? esc(k.shift.note) : '')}
      </div>

      <div class="pad" style="margin-bottom:10px">
        <button class="btn btn--ghost" id="tkIn">Para girişi</button>
        <button class="btn btn--ghost" id="tkOut">Para çıkışı</button>
        <button class="btn btn--ghost" id="tkCount">Kasa sayımı</button>
        <button class="btn btn--ghost" id="tkX">X raporu</button>
      </div>
      <div class="row" style="margin-bottom:14px">
        <button class="btn btn--ghost" id="tkDrawer">Çekmeceyi aç</button>
        <button class="btn btn--ghost" id="tkRefresh">Yenile</button>
        <div class="spacer"></div>
        <button class="btn btn--primary btn--lg" id="tkClose"
          ${can('shift.close') ? '' : 'disabled'}>Vardiyayı kapat</button>
      </div>

      <div class="split-2">
        <div class="card">
          <div class="card__head"><h3>Kasa defteri</h3></div>
          <div class="card__body">
            ${tillLine('Açılış kasası', tillTl(k.opening_float))}
            ${tillLine('Nakit satış', tillTl(k.cash_sales))}
            ${tillLine('Kart / diğer satış', tillTl(k.card_sales), { hint: '(çekmecede değil)', cls: 'muted' })}
            ${tillLine('Kasaya giren', tillTl(k.paid_in))}
            ${tillLine('Kasadan çıkan', '− ' + tillTl(k.paid_out))}
            ${tillLine('Kasada olması gereken', tillTl(k.expected_cash), { grand: true })}
            ${nonCash.length ? `<div class="muted" style="font-size:12.5px;margin-top:6px">
              ${nonCash.map(b => `${esc(label(b.method))} ${tl(b.total)} ₺ (${b.count})`).join(' · ')}</div>` : ''}
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Kasa hareketleri</h3><div class="spacer"></div>
            <span class="badge badge--gray">${s.movements.length}</span></div>
          ${s.movements.length ? `<table class="tbl"><thead><tr>
            <th>Saat</th><th>Yön</th><th>Açıklama</th><th>Kim</th><th class="right">Tutar</th>
            </tr></thead><tbody>
            ${s.movements.map(m => `<tr>
              <td class="mono muted">${tillWhen(m.created_at).slice(-5)}</td>
              <td>${m.direction === 'in'
                ? '<span class="badge badge--closed">Giriş</span>'
                : '<span class="badge badge--open">Çıkış</span>'}</td>
              <td>${esc(m.reason || '—')}</td>
              <td class="muted">${esc(m.user_name || '—')}</td>
              <td class="right mono ${m.direction === 'out' ? 'is-loss' : ''}">
                ${m.direction === 'out' ? '− ' : '+ '}${tl(m.amount)} ₺</td>
            </tr>`).join('')}</tbody></table>`
            : '<div class="empty">Bu vardiyada kasa hareketi yok.</div>'}
        </div>
      </div>

      ${s.counts.length ? `<div class="card" style="margin-top:14px">
        <div class="card__head"><h3>Ara sayımlar</h3></div>
        <table class="tbl"><thead><tr><th>Saat</th><th>Sayan</th><th>Not</th>
          <th class="right">Sayılan</th><th class="right">Beklenen</th><th class="right">Fark</th>
        </tr></thead><tbody>
          ${s.counts.map(c => { const cv = tillVariance(c.variance); return `<tr>
            <td class="mono muted">${tillWhen(c.created_at).slice(-5)}</td>
            <td>${esc(c.counted_by_name || '—')}</td>
            <td class="muted">${esc(c.note || '')}</td>
            <td class="right mono">${tl(c.total)} ₺</td>
            <td class="right mono muted">${c.expected === null ? '—' : tl(c.expected) + ' ₺'}</td>
            <td class="right mono ${cv.cls}">${cv.text}</td></tr>`; }).join('')}
        </tbody></table></div>` : ''}`;

    $('#tkIn').onclick = () => this.tillMovementDialog('in');
    $('#tkOut').onclick = () => this.tillMovementDialog('out');
    $('#tkCount').onclick = () => this.tillCountDialog(k);
    $('#tkX').onclick = () => this.tillXReport();
    $('#tkDrawer').onclick = () => this.tillDrawerDialog();
    $('#tkRefresh').onclick = () => this.tillLoad();
    $('#tkClose').onclick = () => this.tillCloseDialog(k);
  },

  /* ------------------------------------------------- kasa hareketi */
  /*
   * One dialog, two directions. The reason box is mandatory going out and
   * optional coming in, and the form says so - money leaving a drawer with no
   * note beside it is indistinguishable from money being taken. The server
   * refuses it as well; this is the polite half.
   */
  tillMovementDialog(direction) {
    const out = direction === 'out';
    const quick = out
      ? ['Tedarikçi ödemesi', 'Gider ödemesi', 'Personel avansı', 'Kasa transferi']
      : ['Bozukluk takviyesi', 'Devir', 'Kasa transferi'];
    modal(`
      <div class="modal__head"><h3>${out ? 'Kasadan para çıkışı' : 'Kasaya para girişi'}</h3>
        <div class="spacer"></div><button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <div class="field"><label>Tutar (₺)</label>
          <input class="input mono" id="tmAmount" type="number" step="0.01" min="0" placeholder="0,00"></div>
        <div class="field">
          <label>Açıklama${out ? ' <span style="color:var(--red)">(zorunlu)</span>' : ' (isteğe bağlı)'}</label>
          <input class="input" id="tmReason" placeholder="${out ? 'Manav ödemesi' : 'Bozuk para takviyesi'}"></div>
        <div class="row" style="flex-wrap:wrap;gap:8px">
          ${quick.map(q => `<button class="btn btn--ghost btn--sm" data-why="${esc(q)}">${esc(q)}</button>`).join('')}
        </div>
        <div id="tmAlert" style="margin-top:14px"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="tmOk">${out ? 'Çıkışı kaydet' : 'Girişi kaydet'}</button>
      </div>`);
    $$('#modal [data-why]').forEach(b => b.onclick = () => { $('#tmReason').value = b.dataset.why; });
    $('#tmOk').onclick = async () => {
      try {
        await api('POST', '/api/till/movements', {
          direction, amount: Number($('#tmAmount').value || 0), reason: $('#tmReason').value });
        closeModal();
        toast(out ? 'Kasa çıkışı kaydedildi' : 'Kasa girişi kaydedildi', 'ok');
        this.tillLoad();
      } catch (e) {
        $('#tmAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`;
      }
    };
  },

  /* -------------------------------------------------- kupür sayacı */
  /**
   * The denomination counter.
   *
   * The cashier enters how many of each note and coin is in the drawer; the
   * TOTAL is added up by the server on every change, which is the whole point.
   * A till that adds up its own notes could post a total that does not match
   * them, and the variance - the only figure anybody reads afterwards - would
   * rest on the cashier's arithmetic instead of the count.
   *
   * `onTotal(total, counts)` is called whenever the figure changes, so the
   * close dialog can show the fark live without a second adder.
   */
  tillCounterHtml(idPrefix) {
    const d = TILL_DENOMS || [];
    return `<table class="tbl" id="${idPrefix}Grid"><thead><tr>
        <th>Kupür</th><th style="width:120px">Adet</th><th class="right">Tutar</th>
      </tr></thead><tbody>
      ${d.map(x => `<tr>
        <td><b>${esc(x.label)}</b> <span class="muted" style="font-size:12px">${esc(x.kind)}</span></td>
        <td><input class="input mono" data-den="${x.minor}" type="number" min="0" step="1"
             inputmode="numeric" placeholder="0" style="height:38px"></td>
        <td class="right mono" data-line="${x.minor}">—</td>
      </tr>`).join('')}
      </tbody></table>`;
  },

  /** Wire a counter grid up to the server adder. Returns a reader for the counts. */
  tillWireCounter(idPrefix, onTotal) {
    const read = () => {
      const counts = {};
      $$(`#${idPrefix}Grid [data-den]`).forEach(i => {
        const n = Math.trunc(Number(i.value || 0));
        if (n > 0) counts[i.dataset.den] = n;
      });
      return counts;
    };
    let timer = null;
    const recalc = async () => {
      const counts = read();
      try {
        const r = await api('POST', '/api/till/count/total', { counts });
        for (const l of r.lines) {
          const cell = $(`#${idPrefix}Grid [data-line="${l.minor}"]`);
          if (cell) cell.textContent = l.count ? tl(l.total_minor / 100) + ' ₺' : '—';
        }
        onTotal(r.total, counts);
      } catch (e) { err(e); }
    };
    $$(`#${idPrefix}Grid [data-den]`).forEach(i => i.oninput = () => {
      clearTimeout(timer); timer = setTimeout(recalc, 160);
    });
    return { read, recalc };
  },

  /** A mid-shift count: check the drawer without closing it. */
  tillCountDialog(k) {
    modal(`
      <div class="modal__head"><h3>Kasa sayımı</h3><div class="spacer"></div>
        <span class="badge badge--gray">Vardiya #${k.shift.shift_no}</span>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">Çekmecedeki her kupürden kaç adet olduğunu girin.
          Vardiya kapanmaz, sayım kayda geçer.</p>
        ${this.tillCounterHtml('tc')}
        <div style="margin-top:14px">
          ${tillLine('Kasada olması gereken', tillTl(k.expected_cash))}
          <div class="total-row"><span>Sayılan</span><span class="mono strong" id="tcTotal">0,00 ₺</span></div>
          <div class="total-row total-row--grand"><span id="tcVarLabel">Fark</span>
            <span class="mono" id="tcVar">0,00 ₺</span></div>
        </div>
        <div class="field" style="margin-top:10px"><label>Not (isteğe bağlı)</label>
          <input class="input" id="tcNote" placeholder="Ara kontrol"></div>
        <div id="tcAlert"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="tcOk">Sayımı kaydet</button>
      </div>`, { wide: true });

    const c = this.tillWireCounter('tc', (total) => {
      const v = tillVariance(total - k.expected_cash);
      $('#tcTotal').textContent = tillTl(total);
      $('#tcVarLabel').textContent = v.label;
      $('#tcVar').textContent = v.text;
      $('#tcVar').className = 'mono ' + v.cls;
    });
    $('#tcOk').onclick = async () => {
      try {
        await api('POST', '/api/till/count', { counts: c.read(), note: $('#tcNote').value || null });
        closeModal();
        toast('Kasa sayımı kaydedildi', 'ok');
        this.tillLoad();
      } catch (e) { $('#tcAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /* -------------------------------------------------- vardiya kapat */
  /*
   * Closing IS the count. The old screen asked for a number and got whatever
   * the cashier believed; here the denominations are the form and the total is
   * derived, so "the drawer was 340 short" can be re-checked afterwards -
   * nobody had to guess whether the 200s were miscounted or the money was
   * actually gone. Typing a total is still allowed, deliberately behind a
   * link, for the night the counter is in the way.
   */
  tillCloseDialog(k) {
    let manual = false;
    let counted = 0;
    const draw = () => {
      modal(`
        <div class="modal__head"><h3>Vardiyayı kapat</h3><div class="spacer"></div>
          <span class="badge badge--open">#${k.shift.shift_no}</span>
          <button class="close-x" data-close="1">✕</button></div>
        <div class="modal__body">
          <div class="alert alert--info" style="margin-top:0">
            Kasada olması gereken <b>${tillTl(k.expected_cash)}</b>.
            Çekmeceyi sayın; fark otomatik hesaplanır ve kayda geçer.</div>
          ${manual
            ? `<div class="field"><label>Sayılan nakit (₺)</label>
                 <input class="input mono" id="tzManual" type="number" step="0.01" min="0" value="${counted.toFixed(2)}"></div>`
            : this.tillCounterHtml('tz')}
          <div style="margin-top:14px">
            ${tillLine('Kasada olması gereken', tillTl(k.expected_cash))}
            <div class="total-row"><span>Sayılan</span><span class="mono strong" id="tzTotal">${tillTl(counted)}</span></div>
            <div class="total-row total-row--grand"><span id="tzVarLabel">Fark</span>
              <span class="mono" id="tzVar">${tillTl(0)}</span></div>
          </div>
          <div class="field" style="margin-top:10px"><label>Not (isteğe bağlı)</label>
            <input class="input" id="tzNote" placeholder="Devir notu"></div>
          <button class="btn btn--ghost btn--sm" id="tzToggle">
            ${manual ? 'Kupür sayarak gir' : 'Tutarı elle gir'}</button>
          <div id="tzAlert" style="margin-top:12px"></div>
        </div>
        <div class="modal__foot">
          <button class="btn btn--ghost" data-close="1">Vazgeç</button>
          <button class="btn btn--primary" id="tzOk">Kasayı kapat</button>
        </div>`, { wide: true });

      const show = (total) => {
        counted = Number(total || 0);
        const v = tillVariance(counted - k.expected_cash);
        $('#tzTotal').textContent = tillTl(counted);
        $('#tzVarLabel').textContent = v.label;
        $('#tzVar').textContent = v.text;
        $('#tzVar').className = 'mono ' + v.cls;
      };
      let counter = null;
      if (manual) $('#tzManual').oninput = () => show(Number($('#tzManual').value || 0));
      else counter = this.tillWireCounter('tz', show);
      show(counted);

      $('#tzToggle').onclick = () => { manual = !manual; draw(); };
      $('#tzOk').onclick = async () => {
        const body = { note: $('#tzNote').value || null };
        if (manual) body.counted_cash = Number($('#tzManual').value || 0);
        else body.counts = counter.read();
        const v = tillVariance(counted - k.expected_cash);
        const okToGo = Math.abs(counted - k.expected_cash) < 0.005
          ? true
          : await confirmBox('Vardiyayı kapat',
              `${v.label}: ${v.text}. Vardiya bu farkla kapatılsın mı?`, counted < k.expected_cash);
        if (!okToGo) return draw();
        try {
          const r = await api('POST', '/api/till/shift/close', body);
          closeModal();
          toast('Vardiya kapatıldı', 'ok');
          refreshHeader();
          await this.tillLoad();
          this.tillShiftDetail(r.shift.shift.id);
        } catch (e) { $('#tzAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
      };
    };
    draw();
  },

  /* ------------------------------------------------------- X raporu */
  /**
   * X raporu - the shift so far, nothing closed and nothing reset.
   *
   * Every figure comes from the same endpoint the screen above it reads, so
   * the report and the drawer cannot drift apart. The drawer-open count is on
   * it because an X report is the moment somebody is actually looking.
   */
  async tillXReport() {
    try {
      const x = (await api('GET', '/api/till/x-report')).report;
      modal(`
        <div class="modal__head"><h3>X raporu</h3><div class="spacer"></div>
          <span class="badge badge--open">Vardiya #${x.shift.shift_no}</span>
          <button class="close-x" data-close="1">✕</button></div>
        <div class="modal__body">
          <div class="split-3" style="margin-bottom:16px">
            ${tillStat('Tahsilat', tillTl(x.takings), 'vardiya başından beri')}
            ${tillStat('Adisyon', String(x.bill_count), 'ödeme alınan')}
            ${tillStat('Ortalama adisyon', tillTl(x.average_bill), '')}
          </div>
          <div class="card" style="margin-bottom:14px">
            <div class="card__head"><h3>Ödeme türleri</h3></div>
            ${x.breakdown.length ? `<table class="tbl"><tbody>
              ${x.breakdown.map(b => `<tr><td>${esc(label(b.method))}</td>
                <td class="right muted mono">${b.count} işlem</td>
                <td class="right mono strong">${tl(b.total)} ₺</td></tr>`).join('')}
              </tbody></table>` : '<div class="empty">Henüz ödeme alınmadı.</div>'}
          </div>
          <div class="card"><div class="card__head"><h3>Çekmece</h3></div><div class="card__body">
            ${tillLine('Açılış kasası', tillTl(x.opening_float))}
            ${tillLine('Nakit satış', tillTl(x.cash_sales))}
            ${tillLine('Kart / diğer', tillTl(x.card_sales), { hint: '(çekmecede değil)', cls: 'muted' })}
            ${tillLine('Kasaya giren', tillTl(x.paid_in))}
            ${tillLine('Kasadan çıkan', '− ' + tillTl(x.paid_out))}
            ${tillLine('Kasada olması gereken', tillTl(x.expected_cash), { grand: true })}
            <div class="muted" style="font-size:12.5px;margin-top:10px">
              Çekmece ${x.drawer_opens} kez açıldı${x.drawer_opens_no_sale
                ? `, bunun <b class="is-loss">${x.drawer_opens_no_sale}</b> tanesi satışsız` : ''}.
            </div>
          </div></div>
          <p class="muted" style="font-size:12.5px">
            X raporu vardiyayı kapatmaz, hiçbir sayacı sıfırlamaz.</p>
        </div>
        <div class="modal__foot">
          <button class="btn btn--ghost" data-close="1">Kapat</button>
          <button class="btn btn--primary" id="txPrint">Yazıcıya gönder</button>
        </div>`, { wide: true });
      $('#txPrint').onclick = async () => {
        try { await api('POST', '/api/till/x-report/print'); toast('X raporu yazıcıya gönderildi', 'ok'); }
        catch (e) { err(e); }
      };
    } catch (e) { err(e); }
  },

  /* -------------------------------------------------------- çekmece */
  /*
   * Opening the drawer with no sale behind it is the oldest theft signal in
   * hospitality, so the dialog asks for a reason before it fires the pulse and
   * shows what has already been recorded this shift. Nothing here is a
   * punishment - it is simply the difference between a drawer that opens
   * anonymously and one that does not.
   */
  tillDrawerDialog() {
    modal(`
      <div class="modal__head"><h3>Çekmeceyi aç</h3><div class="spacer"></div>
        <button class="close-x" data-close="1">✕</button></div>
      <div class="modal__body">
        <p class="muted" style="margin-top:0">Satış olmadan açılan her çekmece adınızla kayda geçer.</p>
        <div class="field"><label>Neden <span style="color:var(--red)">(zorunlu)</span></label>
          <input class="input" id="tdReason" placeholder="Bozuk para almak için"></div>
        <div class="row" style="flex-wrap:wrap;gap:8px">
          ${['Bozuk para', 'Para üstü düzeltme', 'Sayım', 'Yanlış tuş']
            .map(q => `<button class="btn btn--ghost btn--sm" data-why="${esc(q)}">${esc(q)}</button>`).join('')}
        </div>
        <div id="tdList" style="margin-top:16px"></div>
        <div id="tdAlert"></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-close="1">Vazgeç</button>
        <button class="btn btn--primary" id="tdOk">Çekmeceyi aç</button>
      </div>`);
    $$('#modal [data-why]').forEach(b => b.onclick = () => { $('#tdReason').value = b.dataset.why; });
    const list = async () => {
      try {
        const r = await api('GET', '/api/till/drawer/log?no_sale=1&limit=8');
        $('#tdList').innerHTML = r.events.length ? `<div class="card">
          <div class="card__head"><h3>Son satışsız açılışlar</h3></div>
          <table class="tbl"><tbody>${r.events.map(e => `<tr>
            <td class="mono muted">${tillWhen(e.created_at)}</td>
            <td>${esc(e.user_name || '—')}</td>
            <td class="muted">${esc(e.reason || '—')}</td></tr>`).join('')}</tbody></table></div>` : '';
      } catch (_) { /* the log is context, not the action */ }
    };
    list();
    $('#tdOk').onclick = async () => {
      const reason = $('#tdReason').value.trim();
      if (!reason) {
        $('#tdAlert').innerHTML = '<div class="alert alert--error">Çekmeceyi neden açtığınızı yazın.</div>';
        return;
      }
      try {
        const r = await api('POST', '/api/till/drawer', { reason });
        closeModal();
        toast(r.printed ? 'Çekmece açıldı ve kayda geçti' : 'Kayda geçti - yazıcıya ulaşılamadı',
          r.printed ? 'ok' : 'error');
      } catch (e) { $('#tdAlert').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
    };
  },

  /* ==================================================================
     VARDİYA GEÇMİŞİ
     ================================================================== */
  /*
   * The list exists for the pattern, not the row. A single short drawer is a
   * bad night; the same name short again and again is the thing the owner
   * bought a POS to be able to see, and it was invisible until now.
   */
  async page_vardiyalar() {
    $('#main').innerHTML = `<div class="page is-on"><div id="tvBody">
      <div class="empty">Yükleniyor…</div></div></div>`;
    try {
      const r = await api('GET', '/api/till/shifts?limit=60');
      const drawer = await api('GET', '/api/till/drawer/log?limit=60').catch(() => ({ events: [], by_user: [] }));
      const short = r.shifts.filter(s => Number(s.variance || 0) < 0);
      const net = r.shifts.reduce((a, s) => a + Number(s.variance || 0), 0);
      const noSale = drawer.events.filter(e => !e.order_id);

      $('#tvBody').innerHTML = `
        <div class="split-4" style="margin-bottom:14px">
          ${tillStat('Kapanan vardiya', String(r.shifts.length), 'son 60 kayıt')}
          ${tillStat('Açık veren', String(short.length), 'sayılan beklenenin altında',
            short.length ? 'is-loss' : '')}
          ${tillStat('Toplam fark', tillVariance(net).text, tillVariance(net).label, tillVariance(net).cls)}
          ${tillStat('Satışsız çekmece', String(noSale.length), 'son 60 açılış',
            noSale.length ? 'is-loss' : '')}
        </div>

        ${r.by_user.length ? `<div class="card" style="margin-bottom:14px">
          <div class="card__head"><h3>Kasiyer bazında fark</h3></div>
          <table class="tbl"><thead><tr><th>Kasiyer</th><th class="right">Vardiya</th>
            <th class="right">Açık veren</th><th class="right">Fazla veren</th>
            <th class="right">Net fark</th></tr></thead><tbody>
            ${r.by_user.map(u => { const v = tillVariance(u.net); return `<tr>
              <td><b>${esc(u.name)}</b></td>
              <td class="right mono">${u.shifts}</td>
              <td class="right mono ${u.short ? 'is-loss' : ''}">${u.short}</td>
              <td class="right mono">${u.over}</td>
              <td class="right mono ${v.cls}"><b>${v.text}</b></td></tr>`; }).join('')}
          </tbody></table></div>` : ''}

        <div class="card" style="margin-bottom:14px">
          <div class="card__head"><h3>Geçmiş vardiyalar</h3></div>
          ${r.shifts.length ? `<table class="tbl"><thead><tr>
            <th>İş günü</th><th>#</th><th>Açan</th><th>Kapatan</th><th>Kapanış</th>
            <th class="right">Nakit satış</th><th class="right">Beklenen</th>
            <th class="right">Sayılan</th><th class="right">Fark</th><th></th>
            </tr></thead><tbody>
            ${r.shifts.map(s => { const v = tillVariance(s.variance); return `<tr>
              <td>${tillDay(s.business_date)}</td>
              <td class="mono muted">${s.shift_no}</td>
              <td>${esc(s.opened_by_name || '—')}</td>
              <td>${esc(s.closed_by_name || '—')}</td>
              <td class="mono muted">${tillWhen(s.closed_at).slice(-5)}</td>
              <td class="right mono">${tl(s.cash_sales)} ₺</td>
              <td class="right mono">${tl(s.expected_cash)} ₺</td>
              <td class="right mono">${s.counted_cash === null ? '—' : tl(s.counted_cash) + ' ₺'}</td>
              <td class="right mono ${v.cls}"><b>${v.text}</b></td>
              <td class="right"><button class="btn btn--ghost btn--sm" data-shift="${s.id}">Özet</button></td>
            </tr>`; }).join('')}
          </tbody></table>` : '<div class="empty">Henüz kapanmış vardiya yok.</div>'}
        </div>

        <div class="card">
          <div class="card__head"><h3>Çekmece kayıtları</h3><div class="spacer"></div>
            <label class="row" style="gap:7px;font-size:13px"><input type="checkbox" id="tvNoSale">
              <span>Sadece satışsız</span></label></div>
          <div id="tvDrawer"></div>
        </div>`;

      const drawDrawer = () => {
        const only = $('#tvNoSale').checked;
        const rows = only ? noSale : drawer.events;
        $('#tvDrawer').innerHTML = rows.length ? `<table class="tbl"><thead><tr>
          <th>Zaman</th><th>Kim</th><th>Vardiya</th><th>Adisyon</th><th>Neden</th>
          </tr></thead><tbody>
          ${rows.map(e => `<tr>
            <td class="mono muted">${tillWhen(e.created_at)}</td>
            <td><b>${esc(e.user_name || '—')}</b></td>
            <td class="mono muted">${e.shift_no ? '#' + e.shift_no : '—'}</td>
            <td>${e.order_id
              ? '<span class="badge badge--gray">#' + esc(e.adisyon_no || e.order_id) + '</span>'
              : '<span class="badge badge--open">satışsız</span>'}</td>
            <td class="muted">${esc(e.reason || '—')}</td></tr>`).join('')}
          </tbody></table>` : '<div class="empty">Kayıt yok.</div>';
      };
      $('#tvNoSale').onchange = drawDrawer;
      drawDrawer();
      $$('#tvBody [data-shift]').forEach(b => b.onclick = () => this.tillShiftDetail(Number(b.dataset.shift)));
    } catch (e) {
      $('#tvBody').innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`;
    }
  },

  /* ------------------------------------------------- vardiya özeti */
  /**
   * One shift, whole. A closed shift answers with the figures it was closed
   * on - not a fresh query - so a payment that syncs in from an offline device
   * an hour later can never silently restate a drawer somebody already counted
   * and signed off. That is the difference between a record and a report.
   */
  async tillShiftDetail(id) {
    try {
      const r = await api('GET', '/api/till/shifts/' + id);
      const k = r.shift;
      const closed = k.shift.status === 'closed';
      const v = tillVariance(k.variance);
      const noSale = r.drawer.filter(e => !e.order_id);
      modal(`
        <div class="modal__head"><h3>Vardiya #${k.shift.shift_no} · ${tillDay(k.shift.business_date)}</h3>
          <div class="spacer"></div>
          <span class="badge ${closed ? 'badge--closed' : 'badge--open'}">${closed ? 'kapalı' : 'açık'}</span>
          <button class="close-x" data-close="1">✕</button></div>
        <div class="modal__body">
          <div class="row" style="gap:18px;margin-bottom:14px;flex-wrap:wrap">
            <span class="muted">Açan <b>${esc(k.shift.opened_by_name || '—')}</b> · ${tillWhen(k.shift.opened_at)}</span>
            ${closed ? `<span class="muted">Kapatan <b>${esc(k.shift.closed_by_name || '—')}</b> · ${tillWhen(k.shift.closed_at)}</span>` : ''}
          </div>
          ${k.shift.note ? `<div class="alert alert--info" style="margin-top:0">${esc(k.shift.note)}</div>` : ''}

          <div class="split-2">
            <div class="card"><div class="card__head"><h3>Kasa defteri</h3></div><div class="card__body">
              ${tillLine('Açılış kasası', tillTl(k.opening_float))}
              ${tillLine('Nakit satış', tillTl(k.cash_sales))}
              ${tillLine('Kart / diğer', tillTl(k.card_sales), { hint: '(çekmecede değil)', cls: 'muted' })}
              ${tillLine('Kasaya giren', tillTl(k.paid_in))}
              ${tillLine('Kasadan çıkan', '− ' + tillTl(k.paid_out))}
              ${tillLine('Kasada olması gereken', tillTl(k.expected_cash), { strong: true })}
              ${closed ? tillLine('Sayılan', tillTl(k.counted_cash), { strong: true }) : ''}
              ${closed ? tillLine(v.label, v.text, { grand: true, cls: v.cls }) : ''}
            </div></div>

            <div class="card"><div class="card__head"><h3>Ödeme türleri</h3></div>
              ${k.breakdown.length ? `<table class="tbl"><tbody>
                ${k.breakdown.map(b => `<tr><td>${esc(label(b.method))}</td>
                  <td class="right muted mono">${b.count}</td>
                  <td class="right mono strong">${tl(b.total)} ₺</td></tr>`).join('')}
                <tr><td><b>Adisyon</b></td><td></td>
                  <td class="right mono strong">${k.order_count}</td></tr>
                </tbody></table>` : '<div class="empty">Ödeme yok.</div>'}
            </div>
          </div>

          ${r.movements.length ? `<div class="card" style="margin-top:14px">
            <div class="card__head"><h3>Kasa hareketleri</h3></div>
            <table class="tbl"><thead><tr><th>Zaman</th><th>Yön</th><th>Açıklama</th><th>Kim</th>
              <th class="right">Tutar</th></tr></thead><tbody>
              ${r.movements.map(m => `<tr>
                <td class="mono muted">${tillWhen(m.created_at)}</td>
                <td>${m.direction === 'in' ? 'Giriş' : 'Çıkış'}</td>
                <td>${esc(m.reason || '—')}</td>
                <td class="muted">${esc(m.user_name || '—')}</td>
                <td class="right mono ${m.direction === 'out' ? 'is-loss' : ''}">
                  ${m.direction === 'out' ? '− ' : '+ '}${tl(m.amount)} ₺</td></tr>`).join('')}
            </tbody></table></div>` : ''}

          ${r.counts.length ? `<div class="card" style="margin-top:14px">
            <div class="card__head"><h3>Sayımlar</h3></div>
            <div class="card__body">
              ${r.counts.map(c => { const cv = tillVariance(c.variance); return `
                <div style="padding:10px 0;border-bottom:1px solid var(--line)">
                  <div class="row">
                    <span class="badge ${c.kind === 'close' ? 'badge--closed' : 'badge--gray'}">
                      ${c.kind === 'close' ? 'kapanış' : 'ara'}</span>
                    <span class="muted">${tillWhen(c.created_at)} · ${esc(c.counted_by_name || '—')}</span>
                    <div class="spacer"></div>
                    <span class="mono strong">${tl(c.total)} ₺</span>
                    <span class="mono ${cv.cls}">${cv.text}</span>
                  </div>
                  ${c.lines.length ? `<div class="muted mono" style="font-size:12.5px;margin-top:6px">
                    ${c.lines.map(l => `${l.count} × ${tl(l.minor / 100)} ₺`).join('  ·  ')}</div>`
                    : '<div class="muted" style="font-size:12.5px;margin-top:6px">Kupür dökümü yok - tutar elle girilmiş.</div>'}
                </div>`; }).join('')}
            </div></div>` : ''}

          ${r.drawer.length ? `<div class="card" style="margin-top:14px">
            <div class="card__head"><h3>Çekmece açılışları</h3><div class="spacer"></div>
              ${noSale.length ? `<span class="badge badge--open">${noSale.length} satışsız</span>` : ''}</div>
            <table class="tbl"><tbody>
              ${r.drawer.map(e => `<tr>
                <td class="mono muted">${tillWhen(e.created_at)}</td>
                <td>${esc(e.user_name || '—')}</td>
                <td>${e.order_id ? '<span class="badge badge--gray">satış</span>'
                  : '<span class="badge badge--open">satışsız</span>'}</td>
                <td class="muted">${esc(e.reason || '—')}</td></tr>`).join('')}
            </tbody></table></div>` : ''}
        </div>
        <div class="modal__foot">
          <button class="btn btn--ghost" data-close="1">Kapat</button>
        </div>`, { wide: true });
    } catch (e) { err(e); }
  },
});
