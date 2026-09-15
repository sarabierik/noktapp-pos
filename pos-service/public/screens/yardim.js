/* =====================================================================
   NOKTApp POS - Yardım: the manual, over the screen you are stuck on
   =====================================================================
   F1 did nothing until now, and a restaurant PC has no manual next to it. The
   person who needs one is mid-service with a guest waiting, so the whole design
   follows from one rule: HELP MUST NOT COST YOU YOUR PLACE.

   It is therefore a panel over the screen, never a navigation. Nothing calls
   go(), nothing replaces #main, and the half-typed adisyon behind it is exactly
   where it was when the panel closes. That is also why it is not a screen in
   the sidebar: a screen would have replaced the one the question is about.

   THE "?" BUTTON MATTERS MORE THAN F1 DOES. Most of these machines are
   fifteen inch touch screens with no keyboard at all, and the ones that have a
   keyboard have it under the counter. F1 is for the office PC; the button in
   the header is for the till.

   The tab, not just the screen. Stok is eight tabs and Yazıcı ve fiş is four,
   and "what is this" on the Zayi tab is not answered by an entry about the
   warehouse. Which tab is open is read from the DOM - the active tab button
   the screen itself drew - rather than from each screen's private tab state:
   there are nine of those variables in six files, and a second copy of the
   answer here would be a tenth that drifts.

   Search is the SAME fold the main search box uses (fold() in app.js). Writing
   a second Turkish fold is how "yazici" comes to find the printer in one box
   and nothing in the other.

   No fetch, no font, no CDN. The one moment this is needed most is the moment
   the internet is down.

   Same visual language as the rest of the till: .card, .btn, .badge, .input,
   .modal-back's dim. One accent (orange) and nothing green.
   ===================================================================== */
'use strict';

/*
 * Injected into <head> once, the way fis.js and floor.js do it - NOT into
 * #main, which every screen replaces wholesale on every draw.
 */
const HELP_CSS = `<style id="helpCss">
.help-back{position:fixed;inset:0;background:rgba(20,20,24,.45);display:none;z-index:60}
.help-back.is-on{display:block}
.help{position:absolute;top:0;right:0;bottom:0;width:min(560px,100%);
  background:var(--surface);border-left:1px solid var(--line);
  display:flex;flex-direction:column;overflow:hidden}
.help__head{padding:16px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px}
.help__head h3{margin:0;font-size:17px;font-weight:600}
.help__head .help__where{font-size:12.5px;color:var(--ink-3)}
.help__tools{padding:12px 18px;border-bottom:1px solid var(--line);display:flex;gap:8px}
.help__body{flex:1;overflow:auto;padding:18px 18px 28px}
.help__lead{margin:0 0 16px;font-size:15.5px;line-height:1.5}
.help h4{margin:20px 0 8px;font-size:12px;font-weight:700;letter-spacing:.6px;
  text-transform:uppercase;color:var(--ink-3)}
.help ol,.help ul{margin:0;padding-left:20px}
.help ol li,.help ul li{margin-bottom:9px;line-height:1.5}
.help ol li::marker{color:var(--orange);font-weight:700}
.help__note{border-left:3px solid var(--orange);background:var(--orange-soft);
  padding:10px 12px;border-radius:0 8px 8px 0;margin-bottom:9px;line-height:1.5;font-size:14px}
.help__see{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.help__hit{display:block;width:100%;text-align:left;padding:11px 12px;border-radius:10px;
  border:1px solid var(--line);background:var(--surface);margin-bottom:8px}
.help__hit:hover{border-color:var(--orange);background:var(--orange-soft)}
.help__hit b{display:block;font-weight:600;margin-bottom:2px}
.help__hit span{font-size:12.5px;color:var(--ink-3)}
.help__foot{padding:12px 18px;border-top:1px solid var(--line);display:flex;
  align-items:center;gap:8px;font-size:12.5px;color:var(--ink-3)}
.btn--help{width:34px;padding:0;font-size:16px;font-weight:700;flex:none}
/* Above the dim, so the button that opened the help can also close it.
   The backdrop covers the whole window - header included - so without this the
   second tap lands on the backdrop instead of the button. On a keyboard that
   is a shrug; on a touch till, where there is no Esc key at all, it makes the
   one control a person can see a one-way door. */
#btnHelp{position:relative;z-index:70}
#btnHelp.is-on{background:var(--orange);border-color:var(--orange);color:#fff}
</style>`;

/* Where the panel is right now, so Escape and a second F1 know there is
   something to close and the tests can read what is being shown. */
let HELP_KEY = null;

/** 'stock' or 'stock:zayi' - the address of one entry, used by see: too. */
function helpKey(page, tab) { return tab ? page + ':' + tab : String(page || ''); }

/**
 * One entry by address, following an alias.
 *
 * `alias` exists because page_kitchen, page_settings and page_admin are
 * addresses that redirect: a person who arrives on one of them is looking at
 * another screen and must get that screen's answer, not "this page redirects".
 * One hop only - an alias chain would be a way to write a loop.
 */
function helpEntry(key) {
  const hit = HELP.find(e => helpKey(e.page, e.tab) === key);
  if (!hit || !pageOffered(hit.page)) return null;
  return hit.alias ? (HELP.find(e => helpKey(e.page, e.tab) === hit.alias) || null) : hit;
}

/**
 * Every entry a person can actually be shown.
 *
 * Aliases are addresses, not answers. And an entry for a screen this
 * installation does not offer is not an answer either: the index still carries
 * the ÖKC page so that test/yardim.js keeps proving every screen has help, but
 * a restaurant running with ÖKC switched off must not be able to find, read and
 * follow instructions for a device it has no way to reach. See pageOffered().
 */
function helpAll() { return HELP.filter(e => !e.alias && pageOffered(e.page)); }

/**
 * Which tab is open, asked of the screen rather than of the screen's code.
 *
 * Every tabbed screen in this till draws its strip the same way - a
 * `.zone-tab` carrying `data-t`, with `is-active` on the current one - so the
 * DOM already holds the answer and cannot disagree with itself. `data-preset`
 * is excluded: the finance screens reuse .zone-tab for date shortcuts, and a
 * date is not a tab.
 */
function helpOpenTab() {
  const el = document.querySelector('#main .zone-tab.is-active[data-t]:not([data-preset])');
  return el ? el.dataset.t : null;
}

/** The entry for the screen (and tab) in front of the person, tab first. */
function helpHere() {
  const page = App.page;
  const tab = helpOpenTab();
  if (tab && helpEntry(helpKey(page, tab))) return helpKey(page, tab);
  return helpEntry(page) ? page : null;
}

/* --------------------------------------------------------------- search */
/**
 * Over the whole body, not just the titles.
 *
 * Somebody looking for help does not know what the screen is called - that is
 * usually the problem. They know the word that is on the till in front of them
 * ("bayat", "eşleşmemiş", "ön ek"), and those words are in the notes. So the
 * haystack is title + lead + steps + notes, folded once with app.js's fold().
 */
function helpHay(e) {
  return fold([e.title, e.lead, (e.steps || []).join(' '), (e.notes || []).join(' ')].join(' '));
}

function helpSearch(query) {
  const q = fold(query);
  if (q.length < 2) return [];
  const out = [];
  for (const e of helpAll()) {
    const title = fold(e.title);
    let score = 0;
    if (title === q) score = 100;
    else if (title.startsWith(q)) score = 80;
    else if (title.includes(q)) score = 60;
    else if (fold(e.lead).includes(q)) score = 40;
    else if (helpHay(e).includes(q)) score = 20;
    if (score) out.push({ e, score });
  }
  out.sort((a, b) => b.score - a.score || a.e.title.localeCompare(b.e.title, 'tr'));
  return out.slice(0, 12).map(x => x.e);
}

/* ---------------------------------------------------------------- panel */
function helpShell() {
  if (!document.getElementById('helpCss')) {
    document.head.insertAdjacentHTML('beforeend', HELP_CSS);
  }
  let back = document.getElementById('helpBack');
  if (back) return back;
  back = document.createElement('div');
  back.className = 'help-back';
  back.id = 'helpBack';
  back.innerHTML = `
    <aside class="help" id="helpPanel" role="dialog" aria-modal="true" aria-label="Yardım">
      <div class="help__head">
        <div>
          <h3 id="helpTitle">Yardım</h3>
          <div class="help__where" id="helpWhere"></div>
        </div>
        <div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" id="helpGo">Ekranı aç</button>
        <button class="close-x" id="helpClose" aria-label="Kapat">✕</button>
      </div>
      <div class="help__tools">
        <input class="input" id="helpIn" type="search" autocomplete="off" spellcheck="false"
               placeholder="Yardımda ara: kdv, yedek, vardiya…" aria-label="Yardımda ara">
      </div>
      <div class="help__body" id="helpBody"></div>
      <div class="help__foot">Kapatmak için Esc ya da F1</div>
    </aside>`;
  document.body.appendChild(back);

  /* Clicking the dimmed half means "put me back where I was", which is the
     whole point of a panel rather than a screen. */
  back.addEventListener('mousedown', (ev) => { if (ev.target === back) closeHelp(); });
  back.querySelector('#helpClose').onclick = () => closeHelp();
  back.querySelector('#helpGo').onclick = () => {
    const e = helpEntry(HELP_KEY);
    if (!e) return;
    closeHelp();
    go(e.page);
  };
  const inp = back.querySelector('#helpIn');
  let t = null;
  inp.oninput = () => { clearTimeout(t); t = setTimeout(() => helpDraw(inp.value), 90); };
  inp.onkeydown = (ev) => {
    /* Escape in the box clears the search first and closes the panel second:
       losing the whole panel because you wanted to retype a word is a way of
       making people stop using the box. */
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    if (inp.value) { inp.value = ''; helpDraw(''); } else closeHelp();
  };
  return back;
}

function helpList(hits, heading) {
  return `<h4>${esc(heading)}</h4>` + (hits.length
    ? hits.map(e => `<button class="help__hit" data-key="${esc(helpKey(e.page, e.tab))}">
         <b>${esc(e.title)}</b><span>${esc(e.lead)}</span></button>`).join('')
    : `<p class="muted">Eşleşen bir şey yok.</p>`);
}

/** Draw either the current entry or, while something is typed, the results. */
function helpDraw(query) {
  const body = document.getElementById('helpBody');
  if (!body) return;
  const q = String(query || '');

  if (fold(q).length >= 2) {
    document.getElementById('helpTitle').textContent = 'Yardımda arama';
    document.getElementById('helpWhere').textContent = q;
    document.getElementById('helpGo').hidden = true;
    body.innerHTML = helpList(helpSearch(q), q + ' için sonuçlar');
    helpWireHits(body);
    return;
  }

  const e = helpEntry(HELP_KEY);
  document.getElementById('helpGo').hidden = false;
  if (!e) {
    /* A screen with no entry cannot happen while test/yardim.js passes, but a
       panel that throws on an unknown page would take the till's F1 down with
       it, so it says so instead. */
    document.getElementById('helpTitle').textContent = 'Yardım';
    document.getElementById('helpWhere').textContent = '';
    body.innerHTML = helpList(helpAll().slice(0, 12), 'Bütün konular');
    helpWireHits(body);
    return;
  }

  document.getElementById('helpTitle').textContent = e.title;
  document.getElementById('helpWhere').textContent = e.tab ? 'sekme' : 'ekran';

  const see = (e.see || []).map(k => helpEntry(k)).filter(Boolean);
  body.innerHTML = `
    <p class="help__lead">${esc(e.lead)}</p>
    ${(e.steps || []).length ? `<h4>Ne yapılır</h4><ol>${
      e.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
    ${(e.notes || []).length ? `<h4>Bilinmesi gereken</h4>${
      e.notes.map(n => `<div class="help__note">${esc(n)}</div>`).join('')}` : ''}
    ${see.length ? `<h4>İlgili</h4><div class="help__see">${see.map(s =>
      `<button class="btn btn--ghost btn--sm" data-key="${esc(helpKey(s.page, s.tab))}">${esc(s.title)}</button>`
    ).join('')}</div>` : ''}`;
  helpWireHits(body);
}

/* An İlgili link moves the PANEL, not the till: the person is reading, not
   navigating, and the screen behind has to still be there afterwards. */
function helpWireHits(root) {
  root.querySelectorAll('[data-key]').forEach(b => b.onclick = () => {
    HELP_KEY = b.dataset.key;
    const inp = document.getElementById('helpIn');
    if (inp) inp.value = '';
    document.getElementById('helpPanel').dataset.key = HELP_KEY;
    helpDraw('');
    document.getElementById('helpBody').scrollTop = 0;
  });
}

function openHelp(key) {
  const back = helpShell();
  HELP_KEY = (key && helpEntry(key)) ? key : (helpHere() || key || null);
  document.getElementById('helpPanel').dataset.key = HELP_KEY || '';
  document.getElementById('helpIn').value = '';
  helpDraw('');
  back.classList.add('is-on');
  helpMark(true);
  document.getElementById('helpBody').scrollTop = 0;
}

function closeHelp() {
  const back = document.getElementById('helpBack');
  if (back) back.classList.remove('is-on');
  helpMark(false);
}

/* The "?" stays lit while the panel is open, because it is the only thing
   still visible above the dim and a person has to be able to see that it is
   the way back out. */
function helpMark(on) {
  const btn = document.getElementById('btnHelp');
  if (btn) btn.classList.toggle('is-on', !!on);
}

function helpIsOpen() {
  const back = document.getElementById('helpBack');
  return !!(back && back.classList.contains('is-on'));
}

function toggleHelp() { return helpIsOpen() ? closeHelp() : openHelp(); }

/* ----------------------------------------------------------- deep link */
/**
 * ?yardim=kasa - so a support call can end with "şu adresi açın" instead of
 * "soldan dördüncü sekmeye basın".
 *
 * The hash form is read too, and on hashchange, because a person who is
 * already signed in should not have to reload (and a reload would land them
 * back on the PIN pad - the session lives in memory, not in a cookie).
 */
function helpLinked() {
  const q = new URLSearchParams(location.search).get('yardim');
  const h = /(?:^|[#&])yardim=([^&]+)/.exec(location.hash || '');
  const raw = q || (h ? decodeURIComponent(h[1]) : '');
  return raw ? raw.replace('/', ':') : '';
}

function helpDeepLink() {
  const key = helpLinked();
  if (key && helpEntry(key)) openHelp(key);
}

/* --------------------------------------------------------------- wiring */
function wireHelp() {
  helpShell();
  const btn = document.getElementById('btnHelp');
  if (btn) btn.onclick = () => toggleHelp();

  if (wireHelp._keys) return;      // enterApp runs again after every lock
  wireHelp._keys = true;
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'F1') {
      /* Or the browser opens ITS help, over a till, in a language nobody in
         the restaurant asked for. */
      ev.preventDefault();
      /* Not over the PIN pad. The listener outlives a lock - it is on the
         document, and enterApp only adds it once - and a manual floating over
         a locked till is a screen nobody can dismiss without signing in. */
      if (!document.getElementById('shell').classList.contains('is-on')) return;
      toggleHelp();
      return;
    }
    if (ev.key === 'Escape' && helpIsOpen()) closeHelp();
  });
  window.addEventListener('hashchange', helpDeepLink);
}
