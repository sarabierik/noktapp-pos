'use strict';
/**
 * F1 - the manual inside the till.
 *
 * Two halves, and the first one is the reason this file exists at all.
 *
 * THE COVERAGE CHECK. Every screen the app registers must have a help entry,
 * both directions: no screen without an answer, and no answer pointing at a
 * screen that is not there. Documentation rots because nothing fails when it
 * does - a screen added next month with no entry ships blank, and the person
 * who finds out is a cashier at 20:30. This check is the only thing standing
 * between that and the customer, so it asks the RUNNING app which pages exist
 * rather than reading a list somebody would have to remember to update.
 *
 * THE BEHAVIOUR CHECK. The panel's whole promise is that it does not cost you
 * your place: F1 over a half-typed adisyon, read, Escape, and the adisyon is
 * still there. So the checks below assert not only that it opened but that
 * App.page and #main are untouched afterwards - a help that navigates is worse
 * than no help, because it loses work.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/yardim.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7493';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const db = require('../src/db');
const catalog = require('../src/modules/catalog');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
const SHOTS = path.join(__dirname, 'shots', 'yardim');

const results = [];
const errors = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

/* Sign in the way a person does, because the help panel only exists inside the
   signed-in shell - the header it lives in is not drawn on the PIN pad. */
async function signIn(page, url) {
  await page.goto(url);
  await page.waitForSelector('.pinpad', { timeout: 15000 });
  for (const d of ['4', '3', '2', '1']) await page.click(`.pinpad button[data-k="${d}"]`);
  await page.waitForSelector('.nav__item', { timeout: 15000 });
  await page.waitForTimeout(600);
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('\nNOKTApp POS - yardım (F1)\n');

  await db.setSetting('setup_done', '1');
  const existing = await db.one('SELECT id FROM users WHERE client_id=? AND pin_hash IS NOT NULL LIMIT 1', [CID]);
  if (!existing) {
    await catalog.saveUser(CID, {
      display_name: 'Erik Yonetici', username: 'erik', role: 'admin', pin: '4321', password: 'Sifre1234',
    }, null);
  }
  const bd = require('../src/util/businessDay');
  await db.exec('DELETE FROM daily_closings WHERE client_id=? AND date=?', [CID, await bd.currentBusinessDate()]);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/favicon/i.test(t)) return;
    errors.push(t.slice(0, 160));
  });

  await step('the till signs in and the help index is loaded with it', async () => {
    await signIn(page, BASE + '/');
    const n = await page.evaluate(() => (typeof HELP === 'undefined' ? -1 : HELP.length));
    assert.ok(n > 20, 'the help index did not load (' + n + ' entries)');
  });

  /* ---------------------------------------------------------- coverage */

  await step('every registered screen has a help entry', async () => {
    const missing = await page.evaluate(() => {
      const has = new Set(HELP.map(e => e.page));
      return PAGES.map(p => p.id).filter(id => !has.has(id));
    });
    assert.strictEqual(missing.length, 0,
      'screens with no help entry: ' + missing.join(', '));
  });

  await step('every help entry names a screen that exists', async () => {
    const orphans = await page.evaluate(() => {
      const real = new Set(PAGES.map(p => p.id));
      return HELP.filter(e => !real.has(e.page)).map(e => e.page + (e.tab ? ':' + e.tab : ''));
    });
    assert.strictEqual(orphans.length, 0,
      'help for screens that do not exist: ' + orphans.join(', '));
  });

  await step('no two entries claim the same address', async () => {
    const dupes = await page.evaluate(() => {
      const seen = new Set(), bad = [];
      for (const e of HELP) {
        const k = helpKey(e.page, e.tab);
        if (seen.has(k)) bad.push(k);
        seen.add(k);
      }
      return bad;
    });
    assert.strictEqual(dupes.length, 0, 'duplicate help entries: ' + dupes.join(', '));
  });

  await step('every "İlgili" link resolves to a real entry', async () => {
    /*
     * A dead see: is invisible in use - the link simply is not drawn - so
     * nothing but this check would ever notice one.
     */
    const dead = await page.evaluate(() => {
      const bad = [];
      for (const e of HELP) {
        for (const s of (e.see || [])) if (!helpEntry(s)) bad.push(helpKey(e.page, e.tab) + ' -> ' + s);
        if (e.alias && !helpEntry(e.alias)) bad.push(helpKey(e.page, e.tab) + ' alias -> ' + e.alias);
      }
      return bad;
    });
    assert.strictEqual(dead.length, 0, 'broken links: ' + dead.join(', '));
  });

  await step('every tab entry names a tab its screen actually has', async () => {
    /*
     * The tab key has to be the one the screen's own strip uses (data-t), or
     * F1 on that tab silently falls back to the screen's entry and nobody ever
     * finds out. Checked against the DOM the screen draws, not against a list.
     */
    const tabbed = await page.evaluate(() => {
      const out = {};
      for (const e of HELP) if (e.tab) (out[e.page] = out[e.page] || []).push(e.tab);
      return out;
    });
    const wrong = [];
    for (const [id, tabs] of Object.entries(tabbed)) {
      await page.evaluate((p) => go(p), id);
      await page.waitForTimeout(1100);
      const real = await page.evaluate(() => Array.from(
        document.querySelectorAll('#main .zone-tab[data-t]:not([data-preset])')).map(b => b.dataset.t));
      for (const t of tabs) if (!real.includes(t)) wrong.push(id + ':' + t);
    }
    assert.strictEqual(wrong.length, 0,
      'help written for tabs that are not on the screen: ' + wrong.join(', '));
  });

  await step('no entry is empty, and none is shorter than its title', async () => {
    const thin = await page.evaluate(() => {
      const bad = [];
      for (const e of HELP) {
        if (e.alias) continue;
        const k = helpKey(e.page, e.tab);
        if (!e.title || !e.lead) { bad.push(k + ' (boş)'); continue; }
        if (!(e.steps || []).length) bad.push(k + ' (adım yok)');
        else if (!(e.notes || []).length) bad.push(k + ' (not yok)');
        else if (e.lead.length <= e.title.length) bad.push(k + ' (başlıktan kısa)');
      }
      return bad;
    });
    assert.strictEqual(thin.length, 0, 'thin entries: ' + thin.join(', '));
  });

  /* --------------------------------------------------------- behaviour */

  await step('F1 opens the panel and Escape closes it', async () => {
    await page.evaluate(() => go('kasa'));
    await page.waitForTimeout(900);
    await page.keyboard.press('F1');
    await page.waitForSelector('#helpBack.is-on', { timeout: 4000 });
    const title = await page.textContent('#helpTitle');
    assert.strictEqual(title.trim(), 'Kasa', 'F1 on Kasa showed "' + title + '"');
    await page.screenshot({ path: path.join(SHOTS, 'f1-kasa.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const open = await page.evaluate(() => helpIsOpen());
    assert.strictEqual(open, false, 'Escape did not close the panel');
  });

  await step('F1 again closes it, and the screen behind is untouched', async () => {
    /*
     * The promise the whole panel rests on. If reading the manual moved the
     * till, a waiter would lose a half-typed adisyon to a question - which is
     * a worse outcome than not answering the question at all.
     */
    const before = await page.evaluate(() => ({
      page: App.page, html: document.getElementById('main').innerHTML.length,
    }));
    await page.keyboard.press('F1');
    await page.waitForSelector('#helpBack.is-on', { timeout: 4000 });
    await page.keyboard.press('F1');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      page: App.page, html: document.getElementById('main').innerHTML.length,
      open: helpIsOpen(),
    }));
    assert.strictEqual(after.open, false, 'a second F1 did not close the panel');
    assert.strictEqual(after.page, before.page, 'the till navigated: ' + before.page + ' -> ' + after.page);
    assert.strictEqual(after.html, before.html, 'the screen behind the panel was redrawn');
  });

  await step('the "?" button in the header does the same as F1', async () => {
    /* And it matters more: these tills are operated by finger. */
    await page.click('#btnHelp');
    await page.waitForSelector('#helpBack.is-on', { timeout: 4000 });
    const key = await page.getAttribute('#helpPanel', 'data-key');
    assert.strictEqual(key, 'kasa', 'the button opened "' + key + '" on Kasa');
    await page.click('#btnHelp');
    await page.waitForTimeout(300);
    assert.strictEqual(await page.evaluate(() => helpIsOpen()), false,
      'the button did not close the panel again');
  });

  await step('the entry shown matches the screen you were on', async () => {
    const want = [['tables', 'Masalar'], ['bills', 'Adisyonlar'], ['reports', 'Raporlar'],
      ['products', 'Ürünler'], ['doviz', 'Döviz kurları'], ['yedek', 'Yedekleme'],
      ['isletme', 'İşletme bilgileri']];
    for (const [id, title] of want) {
      await page.evaluate((p) => go(p), id);
      await page.waitForTimeout(1100);
      await page.keyboard.press('F1');
      await page.waitForSelector('#helpBack.is-on', { timeout: 4000 });
      const shown = (await page.textContent('#helpTitle')).trim();
      assert.strictEqual(shown, title, id + ' showed "' + shown + '"');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
  });

  await step('on a tabbed screen it answers about the TAB, not the screen', async () => {
    /*
     * Stok is eight tabs. "What is this" on Zayi is not answered by an entry
     * about the warehouse, and the till already knows which tab is open - the
     * panel reads the active tab off the strip the screen drew rather than
     * keeping a second copy of nine screens' tab state.
     */
    await page.evaluate(() => go('stock'));
    await page.waitForSelector('#skTabs .zone-tab', { timeout: 8000 });
    await page.click('#skTabs [data-t="zayi"]');
    await page.waitForTimeout(1000);
    await page.keyboard.press('F1');
    await page.waitForSelector('#helpBack.is-on', { timeout: 4000 });
    const key = await page.getAttribute('#helpPanel', 'data-key');
    assert.strictEqual(key, 'stock:zayi', 'the Zayi tab showed "' + key + '"');
    const body = await page.textContent('#helpBody');
    assert.ok(/zayi|Zayi/.test(body), 'the Zayi entry did not mention zayi');
    await page.screenshot({ path: path.join(SHOTS, 'f1-stok-zayi.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  });

  await step('the search inside it folds Turkish the way the main box does', async () => {
    /*
     * "yazici" without the dotted i, because nobody hunts for ı on a keyboard
     * with a guest waiting - and because the fold is app.js's fold(), not a
     * second one written here that would drift from it.
     */
    await page.keyboard.press('F1');
    await page.waitForSelector('#helpBack.is-on', { timeout: 4000 });
    const ask = async (q) => {
      await page.fill('#helpIn', '');
      await page.type('#helpIn', q, { delay: 12 });
      await page.waitForTimeout(260);
      return page.evaluate(() => Array.from(document.querySelectorAll('#helpBody .help__hit b'))
        .map(b => b.textContent.trim()));
    };

    const undotted = await ask('yazici');
    assert.ok(undotted.some(t => /Yaz/.test(t)), 'undotted "yazici" missed Yazıcılar: ' + undotted.join(', '));

    // a word that is only in an entry's BODY, never in its title
    const body = await ask('bayat');
    assert.ok(body.some(t => /Döviz/.test(t)), '"bayat" did not reach Döviz kurları: ' + body.join(', '));

    const vat = await ask('kdv');
    assert.ok(vat.length >= 2, '"kdv" found ' + vat.length + ' place(s): ' + vat.join(', '));

    await page.screenshot({ path: path.join(SHOTS, 'search.png') });
    await page.keyboard.press('Escape');   // clears the box
    await page.keyboard.press('Escape');   // closes the panel
    await page.waitForTimeout(300);
  });

  await step('an "İlgili" link moves the panel and not the till', async () => {
    await page.evaluate(() => go('doviz'));
    await page.waitForTimeout(1000);
    await page.keyboard.press('F1');
    await page.waitForSelector('#helpBack.is-on', { timeout: 4000 });
    const was = await page.evaluate(() => App.page);
    await page.click('.help__see [data-key="para"]');
    await page.waitForTimeout(300);
    const key = await page.getAttribute('#helpPanel', 'data-key');
    assert.strictEqual(key, 'para', 'the İlgili link showed "' + key + '"');
    assert.strictEqual(await page.evaluate(() => App.page), was,
      'reading a related entry navigated the till');

    // and the button that DOES navigate, when the person asks for it
    await page.click('#helpGo');
    await page.waitForTimeout(900);
    assert.strictEqual(await page.evaluate(() => App.page), 'para',
      '"Ekranı aç" did not open the screen');
    assert.strictEqual(await page.evaluate(() => helpIsOpen()), false,
      '"Ekranı aç" left the panel over the screen it opened');
  });

  await step('?yardim=kasa opens the till with that entry showing', async () => {
    /*
     * So a support call can end with "open this link" instead of "click the
     * fourth tab". The PIN pad still comes first - the session is in memory,
     * not in a cookie - which is the honest behaviour: the link takes you to
     * the answer, it does not take you into somebody's till.
     */
    await signIn(page, BASE + '/?yardim=kasa');
    await page.waitForSelector('#helpBack.is-on', { timeout: 6000 });
    const key = await page.getAttribute('#helpPanel', 'data-key');
    assert.strictEqual(key, 'kasa', 'the link opened "' + key + '"');
    assert.strictEqual((await page.textContent('#helpTitle')).trim(), 'Kasa');
    await page.screenshot({ path: path.join(SHOTS, 'deep-link.png') });
  });

  await step('a deep link can name a tab too', async () => {
    await signIn(page, BASE + '/?yardim=fis:yazici');
    await page.waitForSelector('#helpBack.is-on', { timeout: 6000 });
    assert.strictEqual((await page.textContent('#helpTitle')).trim(), 'Yazıcılar');
  });

  await step('an address that only redirects still answers F1', async () => {
    /*
     * page_settings and page_admin go to İşletme. Somebody who arrived on one
     * of them - an old bookmark, a phone that learned the name - is looking at
     * İşletme and must be told about İşletme, not about a redirect.
     */
    const shown = await page.evaluate(() => {
      const e = helpEntry('settings');
      return e ? e.title : null;
    });
    assert.strictEqual(shown, 'İşletme', 'the settings address resolved to "' + shown + '"');
  });

  /* ============================== ÖKC ================================= *
   *
   * The F1 index is the third place ÖKC has to disappear from, and the one
   * that would have been missed: a restaurant with the area switched off could
   * otherwise search the manual, find a page of instructions for a device it
   * has no way to reach, and follow them.
   *
   * The declaration is NOT pruned - HELP still carries the entry, so the two
   * coverage checks at the top of this file keep proving that every screen has
   * help and no help points at a screen that is not there. What changes is what
   * a person is offered. See app.js pageOffered().
   * ==================================================================== */
  const okcWas = await db.getSetting('fiscal_enabled', '0');

  await step('with ÖKC off the manual does not offer it', async () => {
    await db.setSetting('fiscal_enabled', '0');
    await signIn(page, BASE + '/');
    const seen = await page.evaluate(() => ({
      declared: HELP.some(e => e.page === 'okc'),
      offered: helpAll().some(e => e.page === 'okc'),
      found: helpSearch('ökc').map(e => e.page),
      entry: helpEntry('okc'),
    }));
    assert.strictEqual(seen.declared, true,
      'the entry must stay in the index, or the coverage checks stop meaning anything');
    assert.strictEqual(seen.offered, false, 'the manual still lists ÖKC');
    assert.ok(!seen.found.includes('okc'), 'searching the manual still finds ÖKC');
    assert.strictEqual(seen.entry, null, 'a saved ?yardim=okc link still opens it');
  });

  await step('switching ÖKC on brings its help entry back', async () => {
    await db.setSetting('fiscal_enabled', '1');
    await page.evaluate(() => refreshFeatures());
    await page.waitForTimeout(200);
    const seen = await page.evaluate(() => ({
      offered: helpAll().some(e => e.page === 'okc'),
      found: helpSearch('ökc').map(e => e.page),
      title: (helpEntry('okc') || {}).title || null,
    }));
    assert.strictEqual(seen.offered, true, 'the manual did not get ÖKC back');
    assert.ok(seen.found.includes('okc'), 'searching the manual still does not find ÖKC');
    assert.strictEqual(seen.title, 'ÖKC', 'the entry came back as "' + seen.title + '"');
  });

  await step('the İstasyonlar entry says the default is the screen', async () => {
    /* The pilot sites run with no kitchen printer at all. If the manual does
       not say that a station with no printer is normal, the first owner to
       read it goes looking for the printer he is supposed to buy. */
    const e = await page.evaluate(() => helpEntry('fis:istasyon'));
    assert.ok(e, 'the İstasyonlar tab has no help entry');
    const body = [e.lead, (e.steps || []).join(' '), (e.notes || []).join(' ')].join(' ');
    assert.ok(/Ekrana/.test(body), 'the entry never mentions the screen: ' + body.slice(0, 200));
    assert.ok(/[Vv]arsayılan ekran/.test(body),
      'the entry does not say the default is the screen');
    assert.ok(/eksik kurulmuş değildir|olağan olan odur/.test(body),
      'the entry does not say a station with no printer is normal');
  });

  await db.setSetting('fiscal_enabled', okcWas);

  await step('nothing in the manual raised a JavaScript error', async () => {
    assert.strictEqual(errors.length, 0, errors.slice(0, 4).join(' | '));
  });

  await browser.close();
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log('screenshots: ' + SHOTS + '\n');
  failed.forEach(f => console.log('  ! ' + f[1] + ': ' + f[2]));
  server.close();
  process.exit(failed.length ? 1 : 0);
})();
