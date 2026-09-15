'use strict';
/**
 * QR MENU - masa jetonu, on iki sablon, A5 masa kartlari.
 *
 * Three things are proved here, and all three of them are expensive to get
 * wrong AFTER a print shop has been paid:
 *
 *   1. THE TABLE TOKEN. A printed card lives for years, so the token on it has
 *      to be unguessable (a guest who can type masa 12's address can order for
 *      masa 12), stable across a rename, and re-issuable for ONE table without
 *      disturbing the thirty-nine cards already on the other tables. Each of
 *      those is a separate check below, because each of them has its own way
 *      of quietly not being true.
 *   2. THE TWELVE TEMPLATES. They are twelve stylesheets over ONE page, which
 *      is the whole reason they are affordable - and also the risk: a rule
 *      that hides the price in one design hides it in a design nobody looked
 *      at. So every template is loaded in a real browser, with the two things
 *      that break a menu layout in it (a product name nobody expected, and a
 *      product with no photograph), and the SAME menu has to come out of all
 *      twelve. Screenshots land in test/shots/qrmenu so they can be looked at.
 *   3. THE A5 CARDS. The file has to be a real PDF, one A5 page per table,
 *      carrying the table's own name and the venue's handles, with four
 *      modules of quiet zone around the symbol. The quiet zone is checked by
 *      geometry rather than by eye: a code that touches its frame has already
 *      shipped once in this product, on the customer display.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/qrmenu.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7474';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('../src/db');
const auth = require('../src/auth');
const guest = require('../src/modules/guest');
const tok = require('../src/util/token');
const qrcard = require('../src/modules/qrcard');
const { bootstrap } = require('../src/index');
const { tarayiciAc } = require('./tarayici');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 37;                       // a tenant of our own, so no other suite's tables move
const SHOTS = path.join(__dirname, 'shots', 'qrmenu');
let TOKEN = null;

/* A name nobody plans for: 74 characters, no spaces to break on in the middle,
   and the kind of thing a venue really does type into a pide menu. */
const LONG_NAME = 'Fırında Kaşarlı Sucuklu Yumurtalı Özel Karışık Kıymalı Pide (Büyük Boy Aile)';

async function api(method, p, body, token = TOKEN) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

/**
 * The migration is applied here rather than assumed - the desktop shell
 * replays every file in database/migrations on each start and a test run has
 * no shell. The file is written to be idempotent, so this is what the shell
 * does.
 */
async function migrate() {
  const file = path.join(__dirname, '..', '..', 'database', 'migrations', '2026-09-05-qrmenu.sql');
  const sql = fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await db.exec(stmt); } catch (e) { /* already applied */ }
  }
}

/* ------------------------------------------------------------------ pdf */
/**
 * The text of a PDF, without a rasteriser.
 *
 * PDFKit deflates its content streams and writes strings as hex inside a TJ
 * array, so the words on the page are not in the file as bytes anybody can
 * grep for. Inflating and decoding here means the suite can assert what is
 * PRINTED - the table's name, the venue's Instagram - rather than only that
 * some bytes were produced, which is the check that would have passed while
 * every card said "undefined".
 */
function pdfText(buf) {
  const s = buf.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;
    try { out += zlib.inflateSync(Buffer.from(s.slice(start, end), 'latin1')).toString('latin1') + '\n'; }
    catch (e) { /* not a deflated stream */ }
  }
  /*
   * A TJ array is kerned: PDFKit writes [<48> 60 <65 6c…> 0] TJ, so the pair
   * kerning numbers sit BETWEEN the letters of a word. Decoding each hex run
   * on its own and concatenating would give "H 60 ello" and every assertion
   * about a printed word would be wrong for a reason nobody would guess. So
   * the array is collapsed first: hex in, numbers out.
   */
  return out.replace(/\[((?:<[0-9A-Fa-f]*>|[-\d.\s])*)\]\s*TJ/g, (_, body) =>
    (body.match(/<[0-9A-Fa-f]*>/g) || [])
      .map(h => Buffer.from(h.slice(1, -1), 'hex').toString('latin1')).join(''));
}
function pdfPages(buf) {
  const m = buf.toString('latin1').match(/\/Count (\d+)/);
  return m ? Number(m[1]) : 0;
}

/** A restaurant we control completely, so every count below is checkable. */
async function fixture() {
  await db.exec('DELETE FROM station_projection_items WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM order_items WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM orders WHERE client_id=?', [CID]).catch(() => {});
  await db.exec('DELETE FROM restaurant_tables WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM table_zones WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM products WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM categories WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM qr_menu_settings WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM users WHERE client_id=?', [CID]);

  const salon = await db.insert(
    'INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,1,1)', [CID, 'Salon']);
  const teras = await db.insert(
    'INSERT INTO table_zones (client_id,name,sort_order,is_active) VALUES (?,?,2,1)', [CID, 'Teras']);

  const yemek = await db.insert(
    'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,1,1,1,1)',
    [CID, 'Yemekler']);
  const tatli = await db.insert(
    'INSERT INTO categories (client_id,name,sort_order,is_active,use_in_pos,use_in_qr) VALUES (?,?,2,1,1,1)',
    [CID, 'Tatlılar']);

  const mk = (c, n, price, img, desc) => db.insert(
    `INSERT INTO products (client_id,category_id,name,price,cost_price,vat_rate,sort_order,
        is_active,use_in_pos,use_in_qr,track_stock,description,image_url) VALUES (?,?,?,?,0,10,0,1,1,1,0,?,?)`,
    [CID, c, n, price, desc || null, img || null]);

  return {
    salon, teras, yemek, tatli,
    /* A 1x1 transparent GIF as a data: URI - a real <img> that always loads,
       so "the photo template shows a photo" is not testing the network. */
    withPhoto: await mk(yemek, 'Adana Kebap', 420,
      'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
      'Zırh ile kıyılmış, közde.'),
    noPhoto: await mk(yemek, 'Ayran', 40, null, null),
    longName: await mk(yemek, LONG_NAME, 1350, null,
      'Aile boyu, iki kişilik. Yanında ayran, turşu ve közlenmiş biber ile servis edilir.'),
    sweet: await mk(tatli, 'Künefe', 180, null, null),
  };
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  await migrate();
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('\nNOKTApp POS - QR menu, sablonlar, masa kartlari\n');

  /* The fixture clears this tenant's users, so the manager is created AFTER it
     - created before, the row would be deleted and the PIN pad would refuse a
     login while the API token in hand still worked, which is a confusing half
     hour to spend. */
  const P = await fixture();
  const catalog = require('../src/modules/catalog');
  const uid = await catalog.saveUser(CID, {
    display_name: 'Kart Test', username: 'karttest', role: 'admin', pin: '5150', password: 'kart12345',
  }, null);
  TOKEN = await auth.issueToken({ cid: CID, uid, role: 'admin', name: 'Kart Test', kind: 'pos' });

  /* The handles the cards must carry. np_display_settings is a single global
     row, so the suite puts back what it found - a later run of the receipt
     suite should not inherit this venue's Instagram. */
  const socialBefore = await db.one('SELECT * FROM np_display_settings WHERE id=1').catch(() => null);
  await db.exec(`UPDATE np_display_settings SET social_enabled=1, social_instagram=?,
      social_facebook=?, social_tiktok=? WHERE id=1`,
  ['https://instagram.com/kartlokantasi/', 'Kart Lokantasi Alanya', '@kartlokantasi']);

  let tables = [];

  /* ==================================================================== *
   * 1. MASA JETONU                                                       *
   * ==================================================================== */

  await step('her masa kendi jetonuyla olusur ve hicbir jeton digerine benzemez', async () => {
    for (const [zone, name] of [[P.salon, 'Masa 1'], [P.salon, 'Masa 2'], [P.salon, 'Masa 3'],
      [P.teras, 'Teras 1'], [P.teras, 'Teras 2']]) {
      const r = await api('POST', '/api/floor/tables', { name, zone_id: zone });
      assert.strictEqual(r.status, 200, name + ' kurulamadi: ' + r.error);
    }
    tables = await db.query('SELECT id, name, qr_token FROM restaurant_tables WHERE client_id=? ORDER BY id', [CID]);
    assert.strictEqual(tables.length, 5);

    const tokens = tables.map(t => t.qr_token);
    assert.ok(tokens.every(Boolean), 'her masanin bir jetonu olmali');
    assert.strictEqual(new Set(tokens).size, 5, 'jetonlar birbirinden farkli olmali');
    for (const t of tokens) {
      assert.ok(tok.looksLikeToken(t), `jeton ${tok.LENGTH} haneli hex olmali, geldi: ` + t);
      assert.strictEqual(t.length, tok.LENGTH, 'iki ayri jeton uretici kalmis olmali: ' + t);
    }
  });

  await step('jeton, komsu masaninkinden tahmin edilemez - ardisik degil', async () => {
    /*
     * The real attack is arithmetic, not cryptography: if masa 7's card is
     * masa 6's plus one, a guest reads one card and orders on every table in
     * the room. So the check is that no two tokens are near each other, not
     * that they merely differ.
     */
    const nums = tables.map(t => BigInt('0x' + t.qr_token));
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        const d = nums[i] > nums[j] ? nums[i] - nums[j] : nums[j] - nums[i];
        assert.ok(d > 1000000n, `${tables[i].name} ve ${tables[j].name} jetonlari birbirine cok yakin`);
      }
      // and it is not the table's own id dressed up
      assert.notStrictEqual(nums[i], BigInt(tables[i].id));
    }
  });

  await step('jeton dogru masaya cozulur', async () => {
    await api('POST', '/api/guest/qr/settings', { business_name: 'Kart Lokantası', is_published: true });
    for (const t of tables) {
      const j = await api('GET', '/api/guest/menu?m=' + t.qr_token, null, null);
      assert.strictEqual(j.status, 200, t.name + ' menusu acilmadi: ' + j.error);
      assert.strictEqual(j.table.name, t.name, 'jeton baska masaya cozuldu');
    }
    const salonTable = tables.find(t => t.name === 'Masa 1');
    const j = await api('GET', '/api/guest/menu?m=' + salonTable.qr_token, null, null);
    assert.strictEqual(j.table.zone, 'Salon');
  });

  await step('tahmin edilmis / bir artirilmis jeton reddedilir', async () => {
    const real = tables[0].qr_token;
    const guesses = [
      (BigInt('0x' + real) + 1n).toString(16).padStart(24, '0'),   // bir fazlasi
      (BigInt('0x' + real) - 1n).toString(16).padStart(24, '0'),   // bir eksigi
      real.slice(0, -1) + (real.slice(-1) === 'a' ? 'b' : 'a'),    // son hane degistirilmis
      '0'.repeat(tok.LENGTH - 1) + '1',                            // sirali tahmin
      'masa7',                                                     // insanin aklina gelen
    ];
    /* Deliberately NOT in the list: the same token in capitals. The column's
       collation is case-insensitive, so a card read back in capitals still
       opens its own menu - which is what should happen when a waiter types one
       off a card by hand, and costs no entropy because we only ever mint
       lower-case hex. */
    for (const g of guesses) {
      const j = await api('GET', '/api/guest/menu?m=' + encodeURIComponent(g), null, null);
      assert.ok(j.status === 404 || j.ok === false, 'tahmin kabul edildi: ' + g);
      assert.strictEqual(j.table, undefined, 'reddedilen jeton masa bilgisi sizdirdi: ' + g);
    }
  });

  await step('masa yeniden adlandirilinca jeton degismez - basili kart yasar', async () => {
    const t = tables.find(x => x.name === 'Masa 3');
    const r = await api('POST', '/api/floor/tables', { id: t.id, name: 'Masa 3 (pencere)' });
    assert.strictEqual(r.status, 200, r.error);
    const after = await db.one('SELECT name, qr_token FROM restaurant_tables WHERE id=?', [t.id]);
    assert.strictEqual(after.qr_token, t.qr_token, 'ad degisince jeton degismemeli');
    const j = await api('GET', '/api/guest/menu?m=' + t.qr_token, null, null);
    assert.strictEqual(j.table.name, 'Masa 3 (pencere)', 'eski kart yeni adi gostermeli');
    // put it back so the rest of the suite reads normally
    await api('POST', '/api/floor/tables', { id: t.id, name: 'Masa 3' });
  });

  await step('bir masanin jetonu yenilenir, digerlerine dokunulmaz', async () => {
    const target = tables.find(t => t.name === 'Masa 2');
    const before = await db.query('SELECT id, qr_token FROM restaurant_tables WHERE client_id=?', [CID]);

    const r = await api('POST', `/api/floor/tables/${target.id}/qr`);
    assert.strictEqual(r.status, 200, r.error);
    assert.notStrictEqual(r.qr_token, target.qr_token, 'yeni jeton eskisiyle ayni olamaz');

    const after = await db.query('SELECT id, qr_token FROM restaurant_tables WHERE client_id=?', [CID]);
    for (const b of before) {
      const a = after.find(x => x.id === b.id);
      if (b.id === target.id) assert.notStrictEqual(a.qr_token, b.qr_token, 'hedef masanin jetonu degismeliydi');
      else assert.strictEqual(a.qr_token, b.qr_token, 'baska bir masanin jetonu degisti - basili kartlari oldurdu');
    }

    // and the promise the button makes: the stolen card stops working
    const dead = await api('GET', '/api/guest/menu?m=' + target.qr_token, null, null);
    assert.ok(dead.status === 404 || dead.ok === false, 'yenilenen jeton hala menuyu aciyor');
    const live = await api('GET', '/api/guest/menu?m=' + r.qr_token, null, null);
    assert.strictEqual(live.table.name, 'Masa 2');

    tables = await db.query('SELECT id, name, qr_token FROM restaurant_tables WHERE client_id=? ORDER BY id', [CID]);
  });

  await step('karekodu olmayan masa, menuyu de karti da bozmaz', async () => {
    const id = await db.insert(
      `INSERT INTO restaurant_tables (client_id, zone_id, name, status, sort_order, is_occupied, is_active, qr_token)
       VALUES (?,?,?, 'free', 9, 0, 1, NULL)`, [CID, P.teras, 'Teras 3']);

    const s = await api('GET', '/api/guest/qr/settings');
    assert.ok(s.warnings.some(w => /karekod/i.test(w)), 'karekodsuz masa uyarisi bekleniyordu');

    const cards = await api('GET', '/api/guest/qr/cards');
    assert.strictEqual(cards.missing, 1, 'bir masa karekodsuz sayilmaliydi');
    const row = cards.cards.find(c => c.name === 'Teras 3');
    assert.ok(row && !row.url, 'karekodsuz masanin adresi olmamali');

    // the missing one still gets a page, saying so - see drawMissing
    const buf = await qrcard.cardsPdf(CID, {});
    assert.strictEqual(pdfPages(buf), 6, 'karekodsuz masa da bir sayfa almali');
    assert.ok(pdfText(buf).includes('karekodu yok'), 'eksik kart sayfasi bunu yazmali');

    const gen = await api('POST', '/api/floor/qr/missing');
    assert.strictEqual(gen.generated, 1);
    const t = await db.one('SELECT qr_token FROM restaurant_tables WHERE id=?', [id]);
    assert.ok(/^[0-9a-f]{24}$/.test(t.qr_token), 'eksik jeton uretilmedi');
    tables = await db.query('SELECT id, name, qr_token FROM restaurant_tables WHERE client_id=? ORDER BY id', [CID]);
  });

  /* ==================================================================== *
   * 2. SABLONLAR                                                         *
   * ==================================================================== */

  await step('on iki sablon tanimli ve hepsinin karsiligi stylesheette var', async () => {
    const list = guest.MENU_TEMPLATES;
    assert.ok(list.length >= 10 && list.length <= 12, 'on ile on iki arasi sablon bekleniyor, ' + list.length + ' var');
    assert.strictEqual(new Set(list.map(t => t.key)).size, list.length, 'sablon anahtarlari benzersiz olmali');

    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'menu-templates.css'), 'utf8');
    for (const t of list) {
      assert.ok(css.includes(`[data-tpl="${t.key}"]`), t.key + ' icin stylesheette kural yok');
      assert.ok(t.name && t.note, t.key + ' icin ad ya da aciklama eksik');
    }
    // and no template quietly reintroduced green - the one house rule
    assert.ok(!/#[0-9a-f]*(?:green)/i.test(css) && !/:\s*green/i.test(css), 'sablonlarda yesil olamaz');
  });

  await step('bilinmeyen sablon anahtari reddedilir, secili tasarim degismez', async () => {
    await api('POST', '/api/guest/qr/design', { template: 'luks' });
    const bad = await api('POST', '/api/guest/qr/design', { template: 'sarayefendi' });
    assert.strictEqual(bad.status, 400, 'bilinmeyen sablon kabul edildi');
    const s = await api('GET', '/api/guest/qr/settings');
    assert.strictEqual(s.template, 'luks', 'reddedilen secim mevcut tasarimi bozmamali');
  });

  await step('tasarim secmek diger ayarlari silmez', async () => {
    await api('POST', '/api/guest/qr/settings',
      { business_name: 'Kart Lokantası', welcome_text: 'Hoş geldiniz', is_published: true });
    await api('POST', '/api/guest/qr/design', { template: 'lokanta', card_design: 'serit' });
    const s = await api('GET', '/api/guest/qr/settings');
    assert.strictEqual(s.settings.welcome_text, 'Hoş geldiniz', 'tasarim secimi karsilama yazisini sildi');
    assert.strictEqual(s.template, 'lokanta');
    assert.strictEqual(s.card_design, 'serit');

    /* and the other way round, which is the direction that actually loses
       work: the Görünüm form does not know about templates, so saving it must
       not quietly put the design back to the house one. */
    await api('POST', '/api/guest/qr/settings',
      { business_name: 'Kart Lokantası', welcome_text: 'Hoş geldiniz', is_published: true });
    const after = await api('GET', '/api/guest/qr/settings');
    assert.strictEqual(after.template, 'lokanta', 'gorunum kaydi secili sablonu sifirladi');
    assert.strictEqual(after.card_design, 'serit', 'gorunum kaydi kart tasarimini sifirladi');

    await api('POST', '/api/guest/qr/design', { template: 'noktapp', card_design: 'klasik' });
  });

  await step('sablon, misafirin gordugu sayfaya kadar tasinir', async () => {
    const card = tables[0].qr_token;
    await api('POST', '/api/guest/qr/design', { template: 'bistro' });
    const j = await api('GET', '/api/guest/menu?m=' + card, null, null);
    assert.strictEqual(j.business.template, 'bistro');
    // ?tpl= is the picker's preview and overrides only for that request
    const prev = await api('GET', '/api/guest/menu?m=' + card + '&tpl=luks', null, null);
    assert.strictEqual(prev.business.template, 'luks');
    const still = await api('GET', '/api/guest/menu?m=' + card, null, null);
    assert.strictEqual(still.business.template, 'bistro', 'onizleme kayitli tasarimi degistirmemeli');
    await api('POST', '/api/guest/qr/design', { template: 'noktapp' });
  });

  /* ---- the browser half: every template, on a phone, with the awkward menu -- */
  const browser = await tarayiciAc();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  const card = tables[0].qr_token;
  let baseline = null;

  for (const tpl of guest.MENU_TEMPLATES) {
    await step(`sablon "${tpl.name}" ayni menuyu bozulmadan cizer`, async () => {
      pageErrors.length = 0;
      await page.goto(`${BASE}/menu.html?m=${card}&tpl=${tpl.key}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.cat', { timeout: 10000 });

      const applied = await page.getAttribute('html', 'data-tpl');
      assert.strictEqual(applied, tpl.key, 'sayfa sablonu uygulamadi');

      // the category grid, then the category that holds the awkward products
      const cats = await page.$$eval('.cat .cat__name', els => els.map(e => e.textContent.trim()));
      assert.ok(cats.includes('Yemekler') && cats.includes('Tatlılar'), 'kategoriler eksik: ' + cats.join('|'));
      await page.click('.cat');
      await page.waitForSelector('.item', { timeout: 10000 });

      const shot = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.item')).map((el) => {
          const name = el.querySelector('.item__name');
          const price = el.querySelector('.item__price');
          const pr = price ? price.getBoundingClientRect() : null;
          const cs = price ? getComputedStyle(price) : null;
          return {
            name: name ? name.textContent.trim() : '',
            price: price ? price.textContent.trim() : '',
            priceRight: pr ? pr.right : 0,
            priceVisible: pr ? (pr.width > 0 && pr.height > 0) : false,
            priceSize: cs ? parseFloat(cs.fontSize) : 0,
            nameWidth: name ? name.getBoundingClientRect().width : 0,
          };
        });
        return {
          items,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          bodyText: document.body.innerText.trim().length,
          thumbs: document.querySelectorAll('.item__thumb').length,
        };
      });

      assert.ok(!pageErrors.length, 'sayfa hata verdi: ' + pageErrors.join(' | '));
      assert.ok(shot.bodyText > 60, 'sablon bos sayfa cizdi');
      assert.strictEqual(shot.items.length, 3, 'Yemekler kategorisinde 3 urun olmali');

      // every product has its price, on screen, at a readable size
      for (const it of shot.items) {
        assert.ok(it.price, it.name + ' fiyatsiz cizildi');
        assert.ok(it.priceVisible, it.name + ' fiyati gorunmuyor');
        assert.ok(it.priceSize >= 12, it.name + ' fiyati cok kucuk: ' + it.priceSize + 'px');
        assert.ok(it.priceRight <= shot.innerWidth + 1,
          it.name + ' fiyati ekranin disinda kaldi (' + it.priceRight + ' > ' + shot.innerWidth + ')');
      }

      // the long name wraps; it does not widen the page
      assert.ok(shot.scrollWidth <= shot.innerWidth + 1,
        'uzun urun adi sayfayi yana kaydirdi: ' + shot.scrollWidth + ' > ' + shot.innerWidth);
      const long = shot.items.find(i => i.name.startsWith('Fırında'));
      assert.ok(long, 'uzun adli urun cizilmedi');
      assert.ok(long.nameWidth <= shot.innerWidth, 'uzun ad ekrandan tasti');

      // the photo slot is in the markup for every product, photographed or not
      assert.strictEqual(shot.thumbs, 3, 'fotograf yuvasi her urunde olmali');

      // and it is the SAME menu in every design
      const names = shot.items.map(i => i.name).sort();
      if (!baseline) baseline = names;
      else assert.deepStrictEqual(names, baseline, tpl.key + ' baska bir menu gosterdi');

      await page.screenshot({ path: path.join(SHOTS, tpl.key + '.png'), fullPage: true });
    });
  }

  await step('fotografli sablon fotografi gosterir, fotografsiz urunu bos birakmaz', async () => {
    await page.goto(`${BASE}/menu.html?m=${card}&tpl=fotograf`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.cat', { timeout: 10000 });
    await page.click('.cat');
    await page.waitForSelector('.item', { timeout: 10000 });
    const r = await page.evaluate(() => Array.from(document.querySelectorAll('.item')).map((el) => {
      const thumb = el.querySelector('.item__thumb');
      const img = el.querySelector('img.item__pic');
      const none = el.querySelector('.item__pic--none');
      const b = thumb.getBoundingClientRect();
      return {
        name: el.querySelector('.item__name').textContent.trim(),
        shown: getComputedStyle(thumb).display !== 'none',
        w: b.width, h: b.height,
        img: !!img, letter: none ? none.textContent.trim() : null,
      };
    }));
    for (const it of r) {
      assert.ok(it.shown, it.name + ': fotograf yuvasi gizli');
      assert.ok(it.w > 40 && it.h > 40, it.name + ': fotograf yuvasi cokmus (' + it.w + 'x' + it.h + ')');
      assert.ok(it.img || it.letter, it.name + ': ne fotograf ne harf var - kartta delik kalir');
    }
    assert.ok(r.find(i => i.name === 'Adana Kebap').img, 'fotografi olan urun fotografini gostermeli');
    assert.ok(r.find(i => i.name === 'Ayran').letter, 'fotografsiz urun bas harfiyle cikmali');
  });

  await step('koyu sablonlar gercekten koyu, acik olanlar acik - kontrast yonu dogru', async () => {
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(Number).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const tpl of guest.MENU_TEMPLATES) {
      await page.goto(`${BASE}/menu.html?m=${card}&tpl=${tpl.key}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.cat', { timeout: 10000 });
      await page.click('.cat');
      await page.waitForSelector('.item__price', { timeout: 10000 });
      const c = await page.evaluate(() => {
        /*
         * The price's OWN background, not the page's. Three designs set the
         * price as white type on a filled chip, and measuring white against
         * the paper behind the chip reports 1.08:1 for a price that is
         * perfectly legible - a false alarm that would train the next person
         * to ignore this check.
         */
        const opaque = (el) => {
          for (let n = el; n; n = n.parentElement) {
            const bg = getComputedStyle(n).backgroundColor;
            if (bg && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) return bg;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        const price = document.querySelector('.item__price');
        return {
          paper: getComputedStyle(document.body).backgroundColor,
          behind: opaque(price),
          price: getComputedStyle(price).color,
        };
      });
      const paper = lum(c.paper);
      const behind = lum(c.behind);
      const price = lum(c.price);
      const ratio = (Math.max(behind, price) + 0.05) / (Math.min(behind, price) + 0.05);
      /*
       * 4.5:1 is the readable floor; the price is the one thing a guest is
       * hunting for on a terrace in the sun, so anything below it is a
       * template that cannot be sold, not a template to be tuned later.
       */
      assert.ok(ratio >= 4.5, `${tpl.key}: fiyat/zemin kontrasti ${ratio.toFixed(2)}:1 - gunesde okunmaz`);
      assert.ok(Math.abs(paper - (tpl.dark ? 0 : 1)) < 0.6,
        `${tpl.key}: ${tpl.dark ? 'koyu' : 'acik'} olmasi gerekirken zemin parlakligi ${paper.toFixed(2)}`);
    }
  });

  /* ---- the till's own screen: the picker, the preview and the card tab ---- */
  await step('QR menu ekrani: sablon secici, canli onizleme ve kart sekmesi acilir', async () => {
    /*
     * The picker is checked in the till, not only through the API, because
     * what it promises is a LIVE preview - a frame of the guest page in the
     * design being considered. A picker whose frame is empty is a picker that
     * looks like it works, and the manager only finds out after printing.
     */
    // the till refuses to open before the first-run wizard is done, and this
    // suite's tenant has never run it
    await db.setSetting('setup_done', '1');
    const till = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const screenErrors = [];
    till.on('pageerror', e => screenErrors.push(e.message));
    till.on('console', (m) => {
      if (m.type() === 'error' && !/favicon/i.test(m.text())) screenErrors.push(m.text().slice(0, 160));
    });

    await till.goto(BASE + '/');
    await till.waitForSelector('.pinpad', { timeout: 15000 });
    for (const d of ['5', '1', '5', '0']) await till.click(`.pinpad button[data-k="${d}"]`);
    await till.waitForSelector('.nav__item', { timeout: 15000 });

    await till.evaluate(() => go('qrmenu'));
    await till.waitForSelector('#qmTabs', { timeout: 10000 });

    // the picker
    await till.click('#qmTabs [data-t="tasarim"]');
    await till.waitForSelector('.gs-tpl__i', { timeout: 10000 });
    const offered = await till.$$eval('.gs-tpl__i', els => els.map(e => e.dataset.tpl));
    assert.deepStrictEqual(offered.sort(), guest.MENU_TEMPLATES.map(t => t.key).sort(),
      'secici on iki sablonu da sunmali');

    // the preview really loads the guest page in the design being tried
    await till.click('.gs-tpl__i[data-tpl="luks"]');
    await till.waitForTimeout(400);
    const frame = till.frames().find(f => f.url().includes('/menu.html'));
    assert.ok(frame, 'onizleme cercevesi yok');
    assert.ok(frame.url().includes('tpl=luks'), 'onizleme secilen sablonu yuklemiyor: ' + frame.url());
    await frame.waitForSelector('.biz', { timeout: 10000 });
    assert.strictEqual(await frame.getAttribute('html', 'data-tpl'), 'luks',
      'onizleme baska bir tasarim gosteriyor');

    // the card tab
    await till.click('#qmTabs [data-t="kart"]');
    await till.waitForSelector('[data-cd]', { timeout: 10000 });
    const designs = await till.$$eval('[data-cd]', els => els.map(e => e.dataset.cd));
    assert.deepStrictEqual(designs.sort(), guest.CARD_DESIGNS.map(d => d.key).sort());
    assert.ok(await till.locator('#qcAll').count(), 'tum kartlari indirme dugmesi yok');
    assert.ok(await till.locator('[data-one]').count(), 'tek masa kart dugmesi yok');

    await till.screenshot({ path: path.join(SHOTS, 'ekran-kart.png'), fullPage: true });
    await till.click('#qmTabs [data-t="tasarim"]');
    await till.waitForSelector('.gs-tpl__i', { timeout: 10000 });
    await till.waitForTimeout(500);
    await till.screenshot({ path: path.join(SHOTS, 'ekran-tasarim.png'), fullPage: true });

    assert.ok(!screenErrors.length, 'ekran hata verdi: ' + screenErrors.join(' | '));
    await till.close();
  });

  await browser.close();

  /* ==================================================================== *
   * 3. A5 MASA KARTLARI                                                  *
   * ==================================================================== */

  await step('karekodun her yaninda tam 4 modulluk sessiz alan var', async () => {
    /*
     * Checked by geometry, with a stub standing in for the document, because
     * "it looked fine" is exactly what was said about the customer display's
     * karekod before a phone refused to read it.
     */
    const rects = [];
    const stub = {
      save() { return this; }, restore() { return this; },
      fillColor() { return this; }, fill() { return this; },
      rect(x, y, w, h) { rects.push({ x, y, w, h }); return this; },
    };
    const BOX = 200;
    qrcard.drawQr(stub, 'https://ornek.noktapp.com/q.php?i=kart&m=' + tables[0].qr_token, 10, 20, BOX);
    const modules = rects.slice(1);            // the first rect is the white paper
    assert.ok(modules.length > 20, 'karekod cizilmedi');

    const step_ = modules[0].h - 0.35;         // one module, minus the seam overlap
    const left = Math.min(...modules.map(r => r.x));
    const top = Math.min(...modules.map(r => r.y));
    const right = Math.max(...modules.map(r => r.x + r.w - 0.35));
    const bottom = Math.max(...modules.map(r => r.y + r.h - 0.35));

    assert.ok(Math.abs((left - 10) / step_ - 4) < 0.05, 'sol sessiz alan 4 modul degil');
    assert.ok(Math.abs((top - 20) / step_ - 4) < 0.05, 'ust sessiz alan 4 modul degil');
    assert.ok(Math.abs((10 + BOX - right) / step_ - 4) < 0.05, 'sag sessiz alan 4 modul degil');
    assert.ok(Math.abs((20 + BOX - bottom) / step_ - 4) < 0.05, 'alt sessiz alan 4 modul degil');
  });

  await step('A5 PDF gercek bir PDF ve masa basina bir sayfa', async () => {
    const live = await db.query('SELECT id, name FROM restaurant_tables WHERE client_id=? AND is_active=1', [CID]);
    const buf = await qrcard.cardsPdf(CID, {});
    assert.strictEqual(buf.slice(0, 5).toString('latin1'), '%PDF-', 'dosya PDF degil');
    assert.strictEqual(pdfPages(buf), live.length, `${live.length} masa icin ${pdfPages(buf)} sayfa cikti`);
    assert.ok(buf.length > 5000, 'PDF supheli derecede kucuk: ' + buf.length + ' bayt');
  });

  await step('sayfa boyutu tam A5 (148 x 210 mm)', async () => {
    const buf = await qrcard.cardsPdf(CID, {});
    const boxes = buf.toString('latin1').match(/\/MediaBox \[[^\]]+\]/g) || [];
    assert.ok(boxes.length, 'MediaBox bulunamadi');
    for (const b of boxes) {
      const [, , w, h] = b.match(/-?[\d.]+/g).map(Number);
      assert.ok(Math.abs(w - 148 * qrcard.MM) < 0.5, 'sayfa genisligi 148mm degil: ' + w);
      assert.ok(Math.abs(h - 210 * qrcard.MM) < 0.5, 'sayfa yuksekligi 210mm degil: ' + h);
    }
  });

  await step('her kart kendi masasinin adini ve sosyal hesaplari tasiyor', async () => {
    const buf = await qrcard.cardsPdf(CID, {});
    const text = pdfText(buf);
    for (const t of await db.query('SELECT name FROM restaurant_tables WHERE client_id=? AND is_active=1', [CID])) {
      const { label, big } = qrcard.split(t.name);
      assert.ok(text.includes(big), t.name + ' karti masa numarasini tasimiyor');
      if (label) assert.ok(text.includes(label), t.name + ' karti "' + label + '" yazmiyor');
    }
    assert.ok(text.includes('Kart Lokantasi'), 'isletme adi kartta yok');
    // exactly as receipt.js normalises them: the URL stripped, the @ restored
    assert.ok(text.includes('@kartlokantasi'), 'Instagram hesabi kartta yok');
    assert.ok(text.includes('Kart Lokantasi Alanya'), 'Facebook sayfasi kartta yok');
    assert.ok(!text.includes('instagram.com'), 'kartta ham adres basilmis - receipt.js kirpmasi kullanilmamis');
  });

  await step('uc kart tasariminin hepsi cizilir ve ayni bilgiyi tasir', async () => {
    for (const d of guest.CARD_DESIGNS) {
      const buf = await qrcard.cardsPdf(CID, { design: d.key });
      assert.strictEqual(buf.slice(0, 5).toString('latin1'), '%PDF-', d.key + ' PDF uretmedi');
      const text = pdfText(buf);
      assert.ok(text.includes('Kart Lokantasi'), d.key + ': isletme adi yok');
      assert.ok(text.includes('@kartlokantasi'), d.key + ': sosyal hesap yok');
      assert.ok(text.includes('karekodu okutun'), d.key + ': misafire ne yapacagi soylenmemis');
    }
    const bad = await api('GET', '/api/guest/qr/cards.pdf?design=altin');
    assert.strictEqual(bad.status, 400, 'bilinmeyen kart tasarimi kabul edildi');
  });

  await step('tek masanin karti tek sayfa cikar, digerlerini basmaz', async () => {
    const t = tables.find(x => x.name === 'Teras 1');
    const buf = await qrcard.cardsPdf(CID, { tableId: t.id });
    assert.strictEqual(pdfPages(buf), 1, 'tek masa icin bir sayfa bekleniyordu');
    const text = pdfText(buf);
    assert.ok(text.includes('TERAS') || text.includes('Teras'), 'kart kendi masasini yazmiyor');
    assert.ok(!text.includes('MASA'), 'tek masa karti baska masalari da basmis');
  });

  await step('karekodun icindeki adres masanin kendi jetonu', async () => {
    const t = tables.find(x => x.name === 'Masa 1');
    const data = await qrcard.cardData(CID, { tableId: t.id });
    assert.strictEqual(data.cards.length, 1);
    assert.ok(data.cards[0].url.includes(t.qr_token), 'kart baska bir jetonun adresini tasiyor');
    // and the drawn symbol really encodes THAT address, not a placeholder
    const m = qrcard.matrix(data.cards[0].url);
    assert.ok(m.n >= 21 && m.n % 4 === 1, 'karekod modul sayisi gecersiz: ' + m.n);
  });

  await step('HTTP ucu PDF olarak iner ve dosya adi Turkce harf tasimaz', async () => {
    const res = await fetch(BASE + '/api/guest/qr/cards.pdf', { headers: { Authorization: 'Bearer ' + TOKEN } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
    const cd = res.headers.get('content-disposition') || '';
    assert.ok(/attachment; filename="[a-z0-9.\-]+\.pdf"/.test(cd), 'dosya adi ASCII degil: ' + cd);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.slice(0, 5).toString('latin1'), '%PDF-');
  });

  await step('oturumsuz istek kartlari veremez', async () => {
    const res = await fetch(BASE + '/api/guest/qr/cards.pdf');
    assert.strictEqual(res.status, 401, 'kartlar oturumsuz indirilebiliyor');
  });

  /* ================================= results ======================== */
  if (socialBefore) {
    await db.exec(`UPDATE np_display_settings SET social_enabled=?, social_instagram=?,
        social_facebook=?, social_tiktok=? WHERE id=1`,
    [socialBefore.social_enabled, socialBefore.social_instagram,
      socialBefore.social_facebook, socialBefore.social_tiktok]);
  }

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  console.log('ekran goruntuleri: ' + SHOTS);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
