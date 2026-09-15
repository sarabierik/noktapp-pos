'use strict';
/* Moved out of menu.html so the page can be served under a Content
   Security Policy with script-src 'self'. Guest-facing pages are exactly where an
   inline-script exemption is least acceptable, so the exemption went instead. */
'use strict';
/*
 * Everything below runs on the guest's phone and talks to exactly one
 * endpoint. It holds no token of its own: the table's code in the address IS
 * the credential, which is why the page is harmless if it is screenshotted -
 * it can only ever read a menu.
 */
(function () {
  var app = document.getElementById('app');
  var DATA = null;
  var view = { cat: null, q: '' };

  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  /* 1.350,00 ₺ - the same shape as the receipt, so the table and the till agree */
  var tl = function (n) {
    return Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
  };
  var firstLetter = function (s) {
    var t = String(s || '').trim();
    return t ? t.charAt(0).toLocaleUpperCase('tr-TR') : '•';
  };

  /* The token: /menu.html?m=<jeton>, or /menu/<jeton> if a tidier address is
     ever put in front of this file. The query string is what the printed card
     carries, because it needs no server rewrite rule to keep working. */
  function tokenFromUrl() {
    var q = new URLSearchParams(location.search);
    var t = q.get('m') || q.get('masa') || q.get('token');
    if (t) return t.trim();
    var m = location.pathname.match(/\/menu\/([A-Za-z0-9]{8,64})\/?$/);
    return m ? m[1] : '';
  }

  function problem(title, text) {
    app.innerHTML = '<div class="msg"><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p></div>';
  }

  function head() {
    var b = DATA.business, t = DATA.table;
    return ''
      + '<header>'
      + (b.logo ? '<img class="logo" src="' + esc(b.logo) + '" alt="">' : '')
      + '<h1 class="biz">' + esc(b.name) + '</h1>'
      + (b.welcome ? '<p class="welcome">' + esc(b.welcome) + '</p>' : '')
      + (t && t.name ? '<div class="table-chip">' + esc(t.name)
          + (t.zone ? ' · ' + esc(t.zone) : '') + '</div>' : '')
      + '</header>';
  }

  function foot() {
    var b = DATA.business, l = [];
    if (b.phone) l.push('<a href="tel:' + esc(String(b.phone).replace(/\s+/g, '')) + '">Telefon</a>');
    if (b.instagram) l.push('<a href="' + esc(b.instagram) + '" rel="noopener">Instagram</a>');
    if (b.google) l.push('<a href="' + esc(b.google) + '" rel="noopener">Yol tarifi</a>');
    if (b.website) l.push('<a href="' + esc(b.website) + '" rel="noopener">Web sitesi</a>');
    return '<footer>'
      + (b.about ? '<p class="about">' + esc(b.about) + '</p>' : '')
      + (l.length ? '<div class="links">' + l.join('') + '</div>' : '')
      + (b.address ? '<div>' + esc(b.address) + '</div>' : '')
      + '<div class="brand">NOKTApp ile hazırlanmıştır</div>'
      + '</footer>';
  }

  function itemHtml(p) {
    /* The photo slot is written whether or not there is a photo: a template
       that shows photos must not have to cope with half its rows being a
       different shape, and a missing image is the normal case. */
    var pic = p.image
      ? '<img class="item__pic" src="' + esc(p.image) + '" alt="" loading="lazy">'
      : '<span class="item__pic item__pic--none">' + esc(firstLetter(p.name)) + '</span>';
    return '<div class="item">'
      + '<div class="item__thumb">' + pic + '</div>'
      + '<div class="item__body">'
      + '<div class="item__name">' + esc(p.name) + '</div>'
      + (p.description ? '<div class="item__desc">' + esc(p.description) + '</div>' : '')
      + '</div>'
      + (p.price === null ? '' : '<span class="item__lead"></span><div class="item__price">' + tl(p.price) + '</div>')
      + '</div>';
  }

  /* The search deliberately flattens the two steps: somebody typing "künefe"
     wants the künefe, not the category it is filed under. */
  function searchResults(q) {
    var needle = q.toLocaleLowerCase('tr-TR');
    var out = '', hits = 0;
    DATA.categories.forEach(function (c) {
      var found = c.products.filter(function (p) {
        return (p.name || '').toLocaleLowerCase('tr-TR').indexOf(needle) >= 0
            || (p.description || '').toLocaleLowerCase('tr-TR').indexOf(needle) >= 0;
      });
      if (!found.length) return;
      hits += found.length;
      out += '<h2 class="sec-title sec-title--sub">' + esc(c.name) + '</h2><div class="items">'
           + found.map(itemHtml).join('') + '</div>';
    });
    return hits ? out
      : '<div class="msg"><h2>Sonuç yok</h2><p>“' + esc(q) + '” için bir şey bulamadık.</p></div>';
  }

  function body() {
    if (view.q) return searchResults(view.q);

    if (view.cat === null) {
      if (!DATA.categories.length) {
        return '<div class="msg"><h2>Menü hazırlanıyor</h2>'
             + '<p>Bu menüde henüz ürün yok. Siparişiniz için garsonu çağırabilirsiniz.</p></div>';
      }
      return '<div class="cats">' + DATA.categories.map(function (c, i) {
        return '<button class="cat" data-i="' + i + '">'
          + '<span class="cat__mark">' + esc(firstLetter(c.name)) + '</span>'
          + '<span><span class="cat__name">' + esc(c.name) + '</span>'
          + '<span class="cat__count">' + c.products.length + ' ürün</span></span></button>';
      }).join('') + '</div>';
    }

    var cat = DATA.categories[view.cat];
    return '<button class="back" data-back="1">← Tüm kategoriler</button>'
      + '<h2 class="sec-title">' + esc(cat.name) + '</h2>'
      + '<div class="items">' + cat.products.map(itemHtml).join('') + '</div>';
  }

  function draw() {
    app.innerHTML = head()
      + '<div class="search">'
      + '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke-width="2"'
      + ' stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>'
      + '<input id="q" type="search" inputmode="search" placeholder="Menüde ara…"'
      + ' value="' + esc(view.q) + '" autocomplete="off"></div>'
      + '<div class="rule"></div>'
      + body() + foot();

    var q = document.getElementById('q');
    q.addEventListener('input', function () {
      view.q = q.value.trim();
      var at = q.selectionStart;
      draw();
      // redrawing replaces the input, so the caret has to be put back or
      // typing a second letter jumps to the start of the box
      var nq = document.getElementById('q');
      nq.focus();
      try { nq.setSelectionRange(at, at); } catch (e) {}
    });

    Array.prototype.forEach.call(app.querySelectorAll('.cat'), function (b) {
      b.addEventListener('click', function () {
        view.cat = Number(b.dataset.i);
        /* pushState so the phone's own back button returns to the category
           grid instead of leaving the menu entirely */
        history.pushState({ cat: view.cat }, '', location.href);
        window.scrollTo(0, 0);
        draw();
      });
    });
    var back = app.querySelector('[data-back]');
    if (back) back.addEventListener('click', function () { history.back(); });
  }

  window.addEventListener('popstate', function () {
    view.cat = null;
    draw();
  });

  var token = tokenFromUrl();
  if (!token) {
    problem('Karekod okunamadı', 'Lütfen masanızdaki karekodu tekrar okutun.');
    return;
  }

  /* ?tpl= is the manager's live preview, not a guest feature: the QR menü
     screen loads this page in a frame while they try designs on. It can only
     name one of the twelve stylesheets, so it is safe on a public route. */
  var tpl = new URLSearchParams(location.search).get('tpl');
  fetch('/api/guest/menu?m=' + encodeURIComponent(token)
        + (tpl ? '&tpl=' + encodeURIComponent(tpl) : ''), { cache: 'no-store' })
    .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
    .then(function (res) {
      if (!res.j || res.j.ok === false) {
        return problem(res.s === 403 ? 'Menü şu anda kapalı' : 'Menü bulunamadı',
          (res.j && res.j.error) || 'Lütfen garsona bildirin.');
      }
      DATA = res.j;
      /* The template owns the palette. The old light/dark switch still works
         for the house design, but a template that has decided it is dark (Lüks,
         Gece) is not asked twice - which is why the stylesheet is linked after
         these rules rather than before them. */
      if (DATA.business && DATA.business.template) {
        document.documentElement.setAttribute('data-tpl', String(DATA.business.template));
      }
      if (DATA.business && DATA.business.theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
      document.title = DATA.business.name + ' · Menü';
      draw();
    })
    .catch(function () {
      problem('Bağlantı kurulamadı',
        'Menüye ulaşılamadı. Lütfen restoranın kablosuz ağına bağlı olduğunuzdan emin olun.');
    });
})();
