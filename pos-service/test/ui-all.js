'use strict';
/**
 * Every screen, in a real browser, signed in.
 *
 * test/ui.js walks the trading path - the screens a waiter touches during
 * service. This one is the breadth check: it signs in and opens EVERY page in
 * the navigation, every tab inside those pages, and asserts that each one
 * actually painted and raised no JavaScript error.
 *
 * It exists because ten screens were built in parallel, each of them tested on
 * its own. A screen can pass its own suite and still be unreachable, or throw
 * the moment it is drawn next to the others - a duplicate id, a helper one file
 * assumed another had defined, a nav entry that registered under a name the
 * router does not know. None of that shows up until they are all loaded
 * together, which is exactly what a customer does on first launch.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/ui-all.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7482';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const db = require('../src/db');
const catalog = require('../src/modules/catalog');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
const SHOTS = path.join(__dirname, 'shots', 'all');

const results = [];
const errors = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('\nNOKTApp POS - every screen\n');

  // a manager with a PIN we know, and a finished setup so the till opens
  await db.setSetting('setup_done', '1');
  const existing = await db.one('SELECT id FROM users WHERE client_id=? AND pin_hash IS NOT NULL LIMIT 1', [CID]);
  if (!existing) {
    await catalog.saveUser(CID, {
      display_name: 'Erik Yonetici', username: 'erik', role: 'admin', pin: '4321', password: 'Sifre1234',
    }, null);
  }
  const bd = require('../src/util/businessDay');
const { tarayiciAc } = require('./tarayici');
  await db.exec('DELETE FROM daily_closings WHERE client_id=? AND date=?', [CID, await bd.currentBusinessDate()]);

  const browser = await tarayiciAc();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  /*
   * Collected per-screen rather than globally: a page that throws must name
   * itself, or the report is "something, somewhere, broke".
   */
  let current = 'boot';
  page.on('pageerror', e => errors.push(`${current}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // a 404 for a favicon is not a broken screen
    if (/favicon/i.test(t)) return;
    errors.push(`${current}: ${t.slice(0, 160)}`);
  });

  await step('the shell loads and the PIN pad appears', async () => {
    await page.goto(BASE + '/');
    await page.waitForSelector('.pinpad', { timeout: 15000 });
  });

  await step('the manager signs in and the navigation is drawn', async () => {
    for (const d of ['4', '3', '2', '1']) await page.click(`.pinpad button[data-k="${d}"]`);
    await page.waitForSelector('.nav__item', { timeout: 15000 });
    const n = await page.locator('.nav__item').count();
    assert.ok(n >= 8, 'expected the full navigation, got ' + n + ' entries');
  });

  /* Which pages exist is asked of the running app, not hard-coded here: a
   * screen added later is then covered automatically instead of being missed. */
  const pages = await page.evaluate(() =>
    PAGES.filter(p => !p.hidden).map(p => ({ id: p.id, label: p.label })));

  await step('every registered screen has a handler behind it', async () => {
    const missing = await page.evaluate(() =>
      PAGES.filter(p => !p.hidden && typeof Screens['page_' + p.id] !== 'function').map(p => p.id));
    assert.strictEqual(missing.length, 0,
      'nav entries with no screen: ' + missing.join(', '));
  });

  await step('no screen was registered twice under the same name', async () => {
    const dupes = await page.evaluate(() => {
      const seen = {}, bad = [];
      for (const p of PAGES) { if (seen[p.id]) bad.push(p.id); seen[p.id] = 1; }
      return bad;
    });
    assert.strictEqual(dupes.length, 0, 'duplicate page ids: ' + dupes.join(', '));
  });

  console.log('\n  --- ' + pages.length + ' screens ---');
  for (const p of pages) {
    await step(`${p.label} (${p.id}) opens and paints`, async () => {
      current = p.id;
      const before = errors.length;
      await page.evaluate((id) => go(id), p.id);
      // give the screen its data round trip
      await page.waitForTimeout(1200);

      const painted = await page.evaluate(() => {
        const m = document.getElementById('main');
        return { html: m ? m.innerHTML.length : 0, text: m ? m.innerText.trim().length : 0 };
      });
      assert.ok(painted.html > 300, `${p.id} rendered almost nothing (${painted.html} chars)`);
      assert.ok(painted.text > 20, `${p.id} rendered no readable text`);

      // the classic symptoms of a half-wired screen
      const text = await page.evaluate(() => document.getElementById('main').innerText);
      assert.ok(!/\bundefined\b/.test(text), `${p.id} shows the word "undefined" on screen`);
      assert.ok(!/\bNaN\b/.test(text), `${p.id} shows NaN on screen`);
      assert.ok(!/\[object Object\]/.test(text), `${p.id} shows [object Object] on screen`);

      assert.strictEqual(errors.length, before,
        `${p.id} raised: ` + errors.slice(before).join(' | '));
      await page.screenshot({ path: path.join(SHOTS, p.id + '.png') });
    });
  }

  await step('every tab inside every screen opens without throwing', async () => {
    /*
     * Most of the new screens are tabbed, and a tab is where the second and
     * third data loads live - the parts most likely to be wired to an endpoint
     * that does not exist yet.
     */
    const broken = [];
    for (const p of pages) {
      current = p.id;
      await page.evaluate((id) => go(id), p.id);
      await page.waitForTimeout(700);
      const tabs = await page.locator('#main [data-tab]').count();
      for (let i = 0; i < tabs; i++) {
        const before = errors.length;
        try {
          await page.locator('#main [data-tab]').nth(i).click({ timeout: 4000 });
          await page.waitForTimeout(600);
        } catch (e) { broken.push(`${p.id} tab ${i}: ${e.message.split('\n')[0]}`); continue; }
        if (errors.length > before) broken.push(`${p.id} tab ${i}: ${errors[before]}`);
      }
    }
    assert.strictEqual(broken.length, 0, broken.slice(0, 6).join(' | '));
  });

  await step('there is one product screen, and a price is edited from it', async () => {
    /*
     * The screen was two: "Urunler" (a flat table with Duzenle) and "Urun
     * kartlari" (a grouped list with the cost and price history behind it).
     * Both listed the same products and both could change a price. They are
     * one now, so this walks the path that has to survive: the list, the card,
     * and the edit form the card opens.
     */
    current = 'products';
    const before = errors.length;
    await page.evaluate(() => go('products'));
    await page.waitForSelector('#ukBody [data-card]', { timeout: 8000 });

    const stale = await page.evaluate(() =>
      PAGES.filter(x => x.id === 'urunkart' && !x.hidden).length);
    assert.strictEqual(stale, 0, 'the second product screen is still in the navigation');

    await page.locator('#ukBody [data-card]').first().click();
    await page.waitForSelector('#ukEdit', { timeout: 8000 });
    await page.click('#ukEdit');
    await page.waitForSelector('#pfName', { timeout: 8000 });
    const name = await page.inputValue('#pfName');
    assert.ok(name && name.length > 0, 'the edit form opened empty');
    const price = await page.inputValue('#pfPrice');
    assert.ok(Number(price) > 0, 'the edit form did not carry the price');
    await page.screenshot({ path: path.join(SHOTS, 'products-card-edit.png') });
    await page.evaluate(() => closeModal());
    assert.strictEqual(errors.length, before, 'raised: ' + errors.slice(before).join(' | '));
  });

  await step('the search box finds a setting by name and by what it is called', async () => {
    /*
     * The point of the box is that you do NOT have to know the screen. So the
     * checks are the words somebody would actually type - "kdv" for a tax rate
     * that lives under two different screens, "vergi" for the same thing in
     * plain Turkish, and "yazici" without the dotted i, because nobody hunts
     * for ı on a keyboard while a guest is waiting.
     */
    current = 'search';
    const before = errors.length;
    await page.evaluate(() => go('tables'));
    await page.waitForTimeout(400);

    const ask = async (q) => {
      await page.fill('#searchIn', '');
      await page.type('#searchIn', q, { delay: 12 });
      await page.waitForTimeout(220);
      return page.evaluate(() => Array.from(document.querySelectorAll('.search__hit'))
        .map(h => h.querySelector('.search__label').textContent.trim()));
    };

    const kdv = await ask('kdv');
    assert.ok(kdv.length >= 2, 'kdv found ' + kdv.length + ' places: ' + kdv.join(', '));
    assert.ok(kdv.some(x => /KDV/.test(x)), 'no KDV entry for "kdv": ' + kdv.join(', '));

    const vergi = await ask('vergi');
    assert.ok(vergi.some(x => /KDV/.test(x)), '"vergi" did not reach KDV: ' + vergi.join(', '));

    const plain = await ask('yazici');
    assert.ok(plain.some(x => /Yaz/.test(x)), 'undotted "yazici" missed Yazıcılar: ' + plain.join(', '));

    // one letter is not a search - it would list the whole app
    await page.fill('#searchIn', 'k');
    await page.waitForTimeout(200);
    const one = await page.locator('.search__hit').count();
    assert.strictEqual(one, 0, 'a single letter opened the list');

    assert.strictEqual(errors.length, before, 'raised: ' + errors.slice(before).join(' | '));
  });

  await step('a search hit opens the screen it names', async () => {
    current = 'search-open';
    await page.fill('#searchIn', '');
    await page.type('#searchIn', 'istasyon', { delay: 12 });
    await page.waitForTimeout(260);
    await page.locator('.search__hit').first().click();
    await page.waitForTimeout(1400);
    const where = await page.evaluate(() => App.page);
    assert.ok(where && where !== 'tables', 'the hit did not navigate anywhere');
    const gone = await page.locator('.search__hit').count();
    assert.strictEqual(gone, 0, 'the result list stayed open over the new screen');
    await page.screenshot({ path: path.join(SHOTS, 'search.png') });
  });

  await step('the sidebar reads in the order a shift runs', async () => {
    current = 'nav';
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.nav__item span:first-of-type')).map(s => s.textContent.trim()));
    assert.ok(labels.length >= 8, 'only ' + labels.length + ' nav entries');
    assert.strictEqual(labels[0], 'Masalar', 'first entry is ' + labels[0]);
    assert.strictEqual(labels[1], 'Adisyonlar', 'second entry is ' + labels[1]);
    assert.strictEqual(labels[2], 'Kasa', 'third entry is ' + labels[2]);
    /* Paket Servis comes after the service run, not before it: the floor is
       the front door of the till and stays first. */
    assert.ok(labels.indexOf('Paket Servis') > labels.indexOf('Kasa'),
      'Paket Servis is above the till screens: ' + labels.join(', '));
    // the station board is not only the kitchen - a bartender uses it too
    assert.ok(labels.includes('Ekranlar'), 'no "Ekranlar" entry: ' + labels.join(', '));
    assert.ok(!labels.includes('Mutfak'), '"Mutfak" is still a top-level entry');
  });

  await step('a product can be edited, and the form does not undo its own settings', async () => {
    /*
     * The old form compared the category id strictly against a value the API
     * hands back as a string, so EDITING a product silently moved it to
     * whichever category was first; and it never sent `use_in_pos`, which
     * defaults to 1, so a product deliberately hidden from the till came back
     * onto it every time anybody pressed Kaydet. Both are checked by round
     * trip here, not by reading the code.
     */
    current = 'product-edit';
    const before = errors.length;

    const target = await page.evaluate(async () => {
      const r = await api('GET', '/api/manage/products');
      const cats = (await api('GET', '/api/manage/categories')).categories;
      /*
       * A product in the LAST category, so a reset to the first one is
       * visible - and one that is actually SOLD for money, because the
       * readout this asserts on is a KDV and margin calculation. The hidden
       * "Teslimat ücreti" service line sits in a late category on any install
       * that has taken a delivery, and is priced at nothing, so picking it
       * would fail this check for a reason that has nothing to do with the
       * form. Walk back through the categories until one has a real product.
       */
      for (let i = cats.length - 1; i >= 0; i--) {
        const p = r.products.find(x => Number(x.category_id) === Number(cats[i].id)
                                    && Number(x.price) > 0);
        if (!p) continue;
        await api('POST', '/api/manage/products', { ...p, use_in_pos: false });
        return { id: p.id, category_id: Number(cats[i].id), name: p.name };
      }
      return null;
    });
    if (!target) return;                       // one category only: nothing to prove

    await page.evaluate(() => go('products'));
    await page.waitForSelector('#ukBody [data-card]', { timeout: 10000 });
    await page.evaluate((id) => Screens.prProductCard(id), target.id);
    await page.waitForSelector('#ukEdit', { timeout: 8000 });
    await page.click('#ukEdit');
    await page.waitForSelector('#pfName', { timeout: 8000 });

    const shown = await page.evaluate(() => ({
      name: document.getElementById('pfName').value,
      cat: Number(document.getElementById('pfCat').value),
      pos: document.getElementById('pfPos').checked,
      calc: document.getElementById('pfCalc').innerText,
    }));
    assert.strictEqual(shown.name, target.name, 'the form opened with the wrong product');
    assert.strictEqual(shown.cat, target.category_id,
      'the form reset the category to ' + shown.cat + ' instead of ' + target.category_id);
    assert.strictEqual(shown.pos, false, 'the form re-ticked "Kasada göster" on a hidden product');
    assert.ok(/KDV/.test(shown.calc), 'no KDV / margin readout on the form');

    await page.click('#pfOk');
    await page.waitForTimeout(1400);
    const after = await page.evaluate(async (id) => {
      const r = await api('GET', '/api/manage/products');
      const p = r.products.find(x => Number(x.id) === Number(id));
      return { cat: Number(p.category_id), pos: Number(p.use_in_pos) };
    }, target.id);
    assert.strictEqual(after.cat, target.category_id, 'saving moved the product to another category');
    assert.strictEqual(after.pos, 0, 'saving put a hidden product back on the till');
    await page.screenshot({ path: path.join(SHOTS, 'product-form.png') });
    assert.strictEqual(errors.length, before, 'raised: ' + errors.slice(before).join(' | '));
  });

  await step('a category can be edited from the product list', async () => {
    current = 'category-edit';
    const before = errors.length;
    await page.evaluate(() => go('products'));
    await page.waitForSelector('#ukBody [data-cat]', { timeout: 10000 });
    await page.locator('#ukBody [data-cat]').first().click();
    await page.waitForSelector('#cfName', { timeout: 8000 });
    const name = await page.inputValue('#cfName');
    assert.ok(name && name.length, 'the category form opened empty');
    const stations = await page.locator('#cfSt option').count();
    assert.ok(stations >= 2, 'no station choice on the category form');
    await page.evaluate(() => closeModal());
    assert.strictEqual(errors.length, before, 'raised: ' + errors.slice(before).join(' | '));
  });

  await step('the guest QR menu page loads on its own', async () => {
    /*
     * On a SECOND tab, not on the one the till is signed in on.
     *
     * It used to page.goto() straight over the app, and everything after it
     * ran against menu.html: `go`, `PAGES` and `SEARCH` are declared by the
     * till's own scripts, so every later check died with "is not defined" -
     * including the one that walks the whole search index. That check is the
     * only thing standing between us and another release where every row in
     * the index points at a screen that is not there, and it had been reporting
     * "the search index did not load: 0" instead of doing its job.
     */
    current = 'menu.html';
    const before = errors.length;
    const guest = await browser.newPage({ viewport: { width: 900, height: 900 } });
    guest.on('pageerror', e => errors.push('menu.html: ' + e.message));
    await guest.goto(BASE + '/menu.html');
    await guest.waitForTimeout(1200);
    const text = await guest.evaluate(() => document.body.innerText.trim());
    assert.ok(text.length > 10, 'the guest menu rendered nothing');
    await guest.screenshot({ path: path.join(SHOTS, 'guest-menu.png') });
    await guest.close();
    assert.strictEqual(errors.length, before, 'guest menu raised: ' + errors.slice(before).join(' | '));
  });

  /*
   * EVERY hit, not a sample.
   *
   * The index is a promise that each row opens something, and it was quietly
   * broken for seven of them: they named page 'settings', which is the NAME of
   * a sidebar GROUP, while the screen holding those tabs is registered as
   * 'admin'. Searching "döviz" found the row, showed it, and opened a screen
   * whose tab keys did not match - so the owner who typed the word he wanted
   * ended up somewhere else and concluded the rate could not be changed.
   *
   * A hand-picked example would never have caught it, because the examples
   * anybody writes are the screens they already know how to reach. So walk the
   * whole index and demand that each entry lands on a real screen - and, where
   * it names a tab, that a tab by that key exists on the screen it opened.
   *
   * Placed near the end on purpose: it opens a dozen screens in a few seconds,
   * which is not a state any check after it should have to start from.
   */
  await step('arama listesindeki her satır gerçekten bir ekran açıyor', async () => {
    current = 'search-targets';
    const before = errors.length;

    const entries = await page.evaluate(() =>
      /* SEARCH is a module-scope const: a lexical global, reachable by name
         in here, but never a property of window. */
      (typeof SEARCH === 'undefined' ? [] : SEARCH)
        .map(e => ({ page: e.page, tab: e.tab || null, label: e.label })));
    assert.ok(entries.length > 20, 'the search index did not load: ' + entries.length);

    const known = await page.evaluate(() => {
      const out = [];
      for (const k in Screens) if (k.startsWith('page_')) out.push(k.slice(5));
      return out;
    });

    const brokenPage = entries.filter(e => !known.includes(e.page));
    assert.deepStrictEqual(brokenPage, [],
      'bu satırlar var olmayan bir ekrana gidiyor: '
      + brokenPage.map(b => b.label + ' -> ' + b.page).join(', '));

    /* and the tabs: open each screen that names one and look for the key */
    const withTab = entries.filter(e => e.tab);
    const missing = [];
    for (const e of withTab) {
      await page.evaluate((p) => go(p), e.page);
      await page.waitForTimeout(420);
      const found = await page.evaluate((tab) => !!document.querySelector(
        `#main [data-tab="${tab}"], #main [data-t="${tab}"], #main [data-st="${tab}"], #main [data-k="${tab}"]`), e.tab);
      if (!found) missing.push(e.label + ' -> ' + e.page + '#' + e.tab);
    }
    assert.deepStrictEqual(missing, [],
      'bu satırların sekmesi açtıkları ekranda yok: ' + missing.join(', '));

    await page.evaluate(() => go('tables'));
    await page.waitForTimeout(300);
    assert.strictEqual(errors.length, before, 'raised: ' + errors.slice(before).join(' | '));
  });

  /* =====================================================================
     THE MENU CONTRACT
     =====================================================================

     Four things were true of the settings menu before it was rebuilt, and all
     four are the kind of thing that passes every unit test in the building:

       - Yazıcılar existed on THREE screens, ÖKC on two, Kullanıcılar on two,
         and each copy wrote through a different endpoint. Whichever was saved
         last won and the others went on showing what they had loaded.
       - Yedekleme - and geri yükleme with it, the one screen that can put a
         lost month back - was reachable only by clicking a sidebar group head.
       - Seven search rows named a screen that did not exist.
       - "Döviz" found one row out of the four places it touches.

     None of that is visible from inside a screen. It is only visible when you
     ask the running app where a subject lives and get more than one answer.
     ===================================================================== */

  await step('her konu tam olarak tek bir ekranda duruyor', async () => {
    /*
     * Asked of the DOM, not of the code: "which screens can add a printer".
     * A marker per subject, chosen to be the thing you press to CHANGE it -
     * a screen that only shows a rate is a link, and links are allowed; a
     * screen with a Kaydet next to the rate is a second owner, and is not.
     *
     * Every tab of every screen is opened, because a subject hiding on the
     * fourth tab of a screen is exactly as duplicated as one on the first.
     */
    current = 'ownership';
    /* A dialog left open by an earlier check swallows every click that follows
       and turns this into "the subject is nowhere", which is a lie in the most
       reassuring possible direction. */
    await page.evaluate(() => closeModal());
    const found = {};
    for (const p of pages) {
      current = p.id;
      await page.evaluate(() => closeModal());
      await page.evaluate((id) => go(id), p.id);
      await page.waitForTimeout(700);
      const tabs = await page.locator('#main [data-t]').count();
      for (let i = -1; i < tabs; i++) {
        if (i >= 0) {
          try {
            await page.locator('#main [data-t]').nth(i).click({ timeout: 4000 });
            await page.waitForTimeout(500);
          } catch (e) { continue; }
        }
        const hit = await page.evaluate(() => {
          const main = document.getElementById('main');
          const btn = (t) => Array.from(main.querySelectorAll('button'))
            .some(b => b.textContent.trim() === t);
          return {
            yazici: btn('Yazıcı ekle'),
            okc: btn('Cihaz ekle') || btn('ÖKC cihazı ekle'),
            kullanici: btn('Personel ekle') || btn('Kullanıcı ekle'),
            kur: !!main.querySelector('input[data-rate]'),
          };
        });
        for (const k of Object.keys(hit)) {
          if (!hit[k]) continue;
          (found[k] = found[k] || new Set()).add(p.id);
        }
      }
    }
    const at = (k) => Array.from(found[k] || []).sort();
    assert.deepStrictEqual(at('yazici'), ['fis'],
      '"Yazıcı ekle" ekranları: ' + (at('yazici').join(', ') || 'hiçbiri'));
    assert.deepStrictEqual(at('okc'), ['okc'],
      'ÖKC cihazı eklenen ekranlar: ' + (at('okc').join(', ') || 'hiçbiri'));
    assert.deepStrictEqual(at('kullanici'), ['kullanici'],
      'Personel eklenen ekranlar: ' + (at('kullanici').join(', ') || 'hiçbiri'));
    assert.deepStrictEqual(at('kur'), ['doviz'],
      'Kur yazılan ekranlar: ' + (at('kur').join(', ') || 'hiçbiri'));
  });

  await step('eski adresler hâlâ çizen bir ekrana düşüyor', async () => {
    /*
     * `settings` is in every ?p= anybody ever bookmarked and in the phone
     * app's idea of where the settings live; `admin` is what seven search rows
     * and one button on the fiş screen named for a release. Deleting the
     * screens was right. Deleting the ADDRESSES would have been a phone call
     * from a restaurant in the middle of service.
     */
    current = 'old-addresses';
    await page.evaluate(() => closeModal());
    const before = errors.length;

    /* Always from somewhere else, so "it drew" cannot be the previous screen
       still sitting in #main. */
    const lands = async (act) => {
      await page.evaluate(() => go('tables'));
      await page.waitForTimeout(400);
      await act();
      await page.waitForTimeout(1200);
      return page.evaluate(() => ({
        page: App.page,
        html: document.getElementById('main').innerHTML.length,
        text: document.getElementById('main').innerText.trim().length,
        drawn: !!Screens['page_' + App.page],
      }));
    };

    for (const old of ['settings', 'admin']) {
      const r = await lands(() => page.evaluate((x) => go(x), old));
      assert.ok(r.html > 300 && r.text > 20, `go('${old}') çizmedi (${r.html} karakter)`);
      assert.ok(r.drawn, `go('${old}') ekranı olmayan bir sayfada durdu: ${r.page}`);
      assert.ok(r.page !== old, `go('${old}') silinen ekranda kaldı`);
    }

    /* every tab key the deleted Yönetim screen used, the way the fiş screen
       and the old search rows called it */
    for (const tab of ['ayar', 'isletme', 'kullanici', 'yazici', 'okc', 'doviz', 'denetim']) {
      const r = await lands(() => page.evaluate((x) => Screens.page_admin(x), tab));
      assert.ok(r.html > 300 && r.text > 20, `admin#${tab} çizmedi (${r.html} karakter)`);
      assert.ok(r.page !== 'admin', `admin#${tab} hâlâ silinen ekranda duruyor`);
    }

    /* and the subjects the deleted Ayarlar screen's own tabs owned - each one
       now has a screen of its own, and each of those screens has to draw */
    const MOVED = { biz: 'isletme', printers: 'fis', okc: 'okc', users: 'kullanici',
                    phones: 'cihazlar', backup: 'yedek', qr: 'qrmenu' };
    for (const [was, now] of Object.entries(MOVED)) {
      const r = await lands(() => page.evaluate((x) => go(x), now));
      assert.ok(r.html > 300 && r.text > 20,
        `settings#${was} yerine geçen ${now} ekranı çizmedi`);
    }
    assert.strictEqual(errors.length, before, 'raised: ' + errors.slice(before).join(' | '));
  });

  await step('Yedekleme ve geri yükleme kenar çubuğundan görünüyor', async () => {
    /*
     * Not "does the screen exist" - it existed before, as the last tab of a
     * page only a group head opened. The check is that it is a LISTED member
     * of its group, so it is on the strip a person can see without knowing it
     * is there, and that opening it really does offer geri yükleme.
     */
    current = 'yedek';
    await page.evaluate(() => closeModal());
    const before = errors.length;
    const listed = await page.evaluate(() =>
      PAGES.some(p => p.id === 'yedek' && !p.hidden && p.group === 'isletme'));
    assert.ok(listed, 'Yedekleme kenar çubuğunda bir grup üyesi değil');

    await page.click('.nav__item[data-page="isletme"]');
    await page.waitForTimeout(900);
    const tab = page.locator('#main .subnav__tab[data-sub="yedek"]');
    assert.strictEqual(await tab.count(), 1, 'Ayarlar şeridinde Yedekleme sekmesi yok');
    assert.strictEqual((await tab.textContent()).trim(), 'Yedekleme');
    await tab.click();
    await page.waitForTimeout(1400);

    const text = await page.textContent('#main');
    assert.ok(/Yedekler/.test(text), 'Yedekleme ekranında yedek listesi yok');
    assert.ok(/geri yükle/i.test(text), 'Yedekleme ekranında geri yükleme yok');
    await page.screenshot({ path: path.join(SHOTS, 'yedek.png') });
    assert.strictEqual(errors.length, before, 'raised: ' + errors.slice(before).join(' | '));
  });

  await step('"döviz" aramak dövizle ilgili her yeri getiriyor', async () => {
    /*
     * The owner's own words: "if we type doviz all related things must come."
     * Döviz is not one row. It is where the rate is written, where the para
     * birimi is set, whether it is printed on the fiş, and who changed it
     * last - and which of those he means depends on what he is standing in
     * front of. One row was not an answer, it was a coin toss.
     *
     * Written undotted on purpose: nobody reaches for ö while a guest waits.
     */
    current = 'search-doviz';
    await page.evaluate(() => closeModal());
    await page.evaluate(() => go('tables'));
    await page.waitForTimeout(400);

    const ask = async (q) => {
      await page.fill('#searchIn', '');
      await page.type('#searchIn', q, { delay: 12 });
      await page.waitForTimeout(260);
      return page.evaluate(() => Array.from(document.querySelectorAll('.search__hit'))
        .map(h => h.querySelector('.search__label').textContent.trim()));
    };

    for (const q of ['doviz', 'döviz']) {
      const hits = await ask(q);
      const want = [/^Döviz kurları$/, /kur değişiklik/i, /Para birimi/i, /Fişte döviz/i];
      const missing = want.filter(w => !hits.some(h => w.test(h)));
      assert.strictEqual(missing.length, 0,
        `"${q}" şunları getirmedi: ${missing.join(', ')} — gelenler: ${hits.join(', ')}`);
    }

    /* and the other subjects a person thinks of as one thing */
    const kur = await ask('kur');
    assert.ok(kur.some(h => /^Döviz kurları$/.test(h)), '"kur" kur ekranını getirmedi: ' + kur.join(', '));

    const yedek = await ask('yedek');
    assert.ok(yedek.some(h => /^Yedekleme$/.test(h)) && yedek.some(h => /Geri yükleme/.test(h)),
      '"yedek" geri yüklemeyi getirmedi: ' + yedek.join(', '));

    const geri = await ask('geri yükle');
    assert.ok(geri.some(h => /Geri yükleme/.test(h)), '"geri yükle" bulunamadı: ' + geri.join(', '));

    const okc = await ask('okc');
    assert.ok(okc.some(h => /ÖKC/.test(h)), '"okc" ÖKC ekranını getirmedi: ' + okc.join(', '));

    const yazici = await ask('yazici');
    assert.ok(yazici.some(h => /Yazıcılar/.test(h)), '"yazici" yazıcıları getirmedi: ' + yazici.join(', '));

    const kullanici = await ask('kullanici');
    assert.ok(kullanici.some(h => /Kullanıcılar/.test(h)),
      '"kullanici" kullanıcıları getirmedi: ' + kullanici.join(', '));

    /* the sidebar the owner asked for: Para, with the rate in it, above Ayarlar */
    await page.evaluate(() => closeSearch());
    const nav = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.nav__item span:first-of-type')).map(s => s.textContent.trim()));
    assert.ok(nav.includes('Para'), 'kenar çubuğunda Para yok: ' + nav.join(', '));
    assert.ok(nav.includes('Ayarlar'), 'kenar çubuğunda Ayarlar yok: ' + nav.join(', '));
    assert.ok(nav.indexOf('Para') < nav.indexOf('Ayarlar'), 'Para, Ayarlar\'ın altında kalmış');
    assert.ok(!nav.includes('Yönetim'), '"Yönetim" hâlâ kenar çubuğunda');
  });

  /* ============================== ÖKC ================================= *
   *
   * Off by default and INVISIBLE while off - not greyed out, not "coming
   * soon". Almost none of these restaurants is obliged to cut a mali fiş, and
   * a sidebar entry, two search rows and a page of instructions for a device
   * the owner does not own are four separate invitations to a support call.
   *
   * The other half is just as important: it is switched off, not removed. The
   * adapters and the GMP3 work are still in the tree, and the customer who is
   * later obliged gets the whole area back by ticking a box.
   * ==================================================================== */
  const okcWas = await db.getSetting('fiscal_enabled', '0');

  /** Sign in from scratch, the way a customer's first morning does. */
  const reSignIn = async () => {
    await page.goto(BASE + '/');
    await page.waitForSelector('.pinpad', { timeout: 15000 });
    for (const d of ['4', '3', '2', '1']) await page.click(`.pinpad button[data-k="${d}"]`);
    await page.waitForSelector('.nav__item', { timeout: 15000 });
    await page.waitForTimeout(500);
  };

  await step('a fresh installation shows no ÖKC in the sidebar, the tabs or search', async () => {
    current = 'okc-off';
    await db.setSetting('fiscal_enabled', '0');
    await reSignIn();

    const seen = await page.evaluate(() => ({
      offered: pageOffered('okc'),
      nav: Array.from(document.querySelectorAll('.nav__item span:first-of-type')).map(s => s.textContent.trim()),
      tabs: groupMembers('isletme').map(m => m.id),
      hits: searchHits('ökc', 20).map(e => e.page),
      hits2: searchHits('yazarkasa', 20).map(e => e.page),
    }));
    assert.strictEqual(seen.offered, false, 'the ÖKC screen is still on offer');
    assert.ok(!seen.nav.some(n => /ÖKC/.test(n)), 'ÖKC is in the sidebar: ' + seen.nav.join(', '));
    assert.ok(!seen.tabs.includes('okc'), 'ÖKC is a tab under Ayarlar: ' + seen.tabs.join(', '));
    assert.ok(!seen.hits.includes('okc'), 'search still offers the ÖKC screen');
    assert.ok(!seen.hits2.includes('okc'), '"yazarkasa" still offers the ÖKC screen');
    /*
     * And the way back is still findable, which is the whole point of a switch:
     * searching for it must still reach the setting that turns it on.
     */
    assert.ok(seen.hits.includes('isletme'),
      'nothing tells the one customer who needs ÖKC where the switch is');
    await page.screenshot({ path: path.join(SHOTS, 'okc-off.png') });
  });

  await step('switching ÖKC on brings the screen and the search rows back', async () => {
    current = 'okc-on';
    await db.setSetting('fiscal_enabled', '1');
    await page.evaluate(() => refreshFeatures());
    await page.waitForTimeout(300);
    const seen = await page.evaluate(() => ({
      offered: pageOffered('okc'),
      tabs: groupMembers('isletme').map(m => m.id),
      hits: searchHits('ökc', 20).map(e => e.page),
    }));
    assert.strictEqual(seen.offered, true, 'the switch did not bring the screen back');
    assert.ok(seen.tabs.includes('okc'), 'ÖKC did not come back as a tab: ' + seen.tabs.join(', '));
    assert.ok(seen.hits.includes('okc'), 'ÖKC did not come back into search');

    /* and it still paints - a screen that is only reachable is not restored */
    await page.evaluate(() => go('okc'));
    await page.waitForTimeout(1000);
    const text = await page.evaluate(() => document.getElementById('main').innerText);
    assert.ok(/ÖKC/.test(text), 'the ÖKC screen did not draw: ' + text.slice(0, 120));
  });

  await db.setSetting('fiscal_enabled', okcWas);

  await step('no screen raised a JavaScript error anywhere in that walk', async () => {
    assert.strictEqual(errors.length, 0, errors.slice(0, 8).join('\n      '));
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  console.log('screenshots: ' + SHOTS);
  await browser.close();
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
