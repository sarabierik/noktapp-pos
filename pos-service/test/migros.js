'use strict';
/**
 * MIGROS YEMEK — the config-only adapter.
 *
 * Migros Türkiye publishes no developer portal and no specification. Every
 * avenue was tried: the obvious hostnames are NXDOMAIN, the merchant panel is
 * a single-page app with no docs behind it, code search finds no client, and
 * the one document that exists sits behind a paywall. The contract is handed
 * to POS vendors under agreement, and — the part that matters more — a POS
 * must already be listed in Migros' own "Pos Firması" dropdown before a
 * restaurant can generate a key for it at all.
 *
 * So this suite does not pretend to test a protocol. It tests the PROMISE the
 * adapter makes instead: that when the partner pack lands, it is a form to
 * fill in and not a release to cut.
 *
 * It proves that by standing up a server at paths the pack has NOT been
 * written for, handing those paths to the adapter as configuration, and
 * watching it speak to them correctly. Different paths, a different auth
 * header, a different scheme - all from the connection record, none from the
 * code. And it proves the other half too: with nothing configured, nothing
 * invented goes on the wire.
 *
 * Run:  node test/migros.js
 */
const assert = require('assert');
const http = require('http');
const { MigrosAdapter } = require('../src/integrations/adapters/migros');

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

const seen = [];
function stub() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
        headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      /* whatever the pack's shape turns out to be, the adapter must cope with
         a list under a name it was not told about */
      if (/orders$/.test(url.pathname)) {
        return res.end(JSON.stringify({ content: [{ id: 'M-1', storeId: 'ST-1', status: 'NEW',
          totalPrice: 250, items: [{ id: 'I1', productId: 'P1', name: 'Lahmacun', quantity: 2, price: 125 }] }] }));
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
}

(async () => {
  const server = stub();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  console.log('\nNOKTApp POS - Migros Yemek yapılandırması\n');

  const conn = { provider: 'MIGROS_YEMEK', environment: 'production', provider_store_id: 'ST-1',
    chain_id: 'GRP-9', default_prep_minutes: 20, branch_id: 1 };
  const bare = () => new MigrosAdapter({ ...conn }, { apiKey: 'ANAHTAR' });

  /* the partner pack, as an operator would type it into the screen */
  const packed = () => new MigrosAdapter({ ...conn }, {
    apiKey: 'ANAHTAR',
    productionBase: BASE,
    apiKeyHeader: 'X-Restaurant-Key',
    authScheme: '',
    extraHeaders: { 'X-Restaurant-Id': '{storeId}', 'X-Group-Id': '{chainId}' },
    paths: {
      fetchOrders: '/is-ortagi/v1/restoran/{storeId}/orders',
      getOrder: '/is-ortagi/v1/orders/{orderId}',
      accept: '/is-ortagi/v1/orders/{orderId}/approve',
      reject: '/is-ortagi/v1/orders/{orderId}/reject',
      setRestaurantOpen: '/is-ortagi/v1/restoran/{storeId}/status',
    },
  });

  /* ------------------------------------------- nothing is invented */

  await step('yol verilmeden hiçbir işlem ağa çıkmaz', async () => {
    seen.length = 0;
    const a = bare();
    for (const op of ['fetchOrders', 'getOrder', 'accept', 'reject', 'markReady', 'syncMenu', 'setRestaurantOpen']) {
      const r = await a.call(op, { externalOrderId: 'X' });
      assert.strictEqual(r.ok, false, op + ' yapılandırmasız çalıştı');
      assert.strictEqual(r.code, 'AWAITING_PARTNER_SPEC', op + ' kodu: ' + r.code);
    }
    assert.strictEqual(seen.length, 0, 'uydurma bir adrese ' + seen.length + ' istek gitti');
  });

  await step('hiçbir başlık adı koda gömülü değil: anahtar tek başına Authorization ile gider', async () => {
    const h = new MigrosAdapter({ ...conn }, { apiKey: 'ANAHTAR' }).headers();
    assert.strictEqual(h.Authorization, 'Bearer ANAHTAR', 'varsayılan yetki başlığı: ' + h.Authorization);
    for (const invented of ['X-Api-Key', 'X-Store-Id', 'X-Chain-Id']) {
      assert.ok(!(invented in h), 'uydurma başlık hâlâ gönderiliyor: ' + invented);
    }
  });

  await step('paket ne diyorsa o gider: başlık adı, şema ve ek başlıklar', async () => {
    const h = packed().headers();
    assert.strictEqual(h['X-Restaurant-Key'], 'ANAHTAR', 'anahtar başlığı: ' + JSON.stringify(h));
    assert.ok(!h.Authorization, 'hem özel başlık hem Authorization gönderildi');
    assert.strictEqual(h['X-Restaurant-Id'], 'ST-1', 'restoran kimliği yerleşmedi');
    assert.strictEqual(h['X-Group-Id'], 'GRP-9', 'grup kimliği yerleşmedi');
  });

  await step('şema istenirse anahtarın önüne konur', async () => {
    const h = new MigrosAdapter({ ...conn },
      { apiKey: 'ANAHTAR', apiKeyHeader: 'Authorization', authScheme: 'ApiKey' }).headers();
    assert.strictEqual(h.Authorization, 'ApiKey ANAHTAR', 'şema uygulanmadı: ' + h.Authorization);
  });

  /* ------------------------------------ the pack, once it arrives */

  await step('sipariş çekme, pakette yazan yoldan ve pakette yazan başlıklarla', async () => {
    seen.length = 0;
    const r = await packed().call('fetchOrders', {});
    assert.ok(r.ok, JSON.stringify(r));
    const hit = seen[0];
    assert.strictEqual(hit.path, '/is-ortagi/v1/restoran/ST-1/orders', 'yol: ' + hit.path);
    assert.strictEqual(hit.headers['x-restaurant-key'], 'ANAHTAR', 'anahtar gitmedi');
    assert.strictEqual(hit.headers['x-group-id'], 'GRP-9', 'grup kimliği gitmedi');
    assert.strictEqual(r.orders.length, 1, 'liste okunmadı');
    assert.strictEqual(r.orders[0].externalOrderId, 'M-1', 'sipariş çözümlenmedi');
    assert.strictEqual(r.orders[0].status, 'RECEIVED', 'durum eşlenmedi: ' + r.orders[0].status);
  });

  await step('onay ve ret, her biri pakette yazan kendi yoluna', async () => {
    seen.length = 0;
    const a = packed();
    assert.ok((await a.call('accept', { externalOrderId: 'M-1', prepMinutes: 35 })).ok, 'onay');
    assert.strictEqual(seen[0].path, '/is-ortagi/v1/orders/M-1/approve', 'onay yolu: ' + seen[0].path);
    assert.strictEqual(seen[0].body.preparationTime, 35, 'hazırlama süresi taşınmadı');
    assert.ok((await a.call('reject', { externalOrderId: 'M-1', reason: 'Stok yok' })).ok, 'ret');
    assert.strictEqual(seen[1].path, '/is-ortagi/v1/orders/M-1/reject', 'ret yolu: ' + seen[1].path);
  });

  await step('pakette olmayan işlem, paket gelmiş olsa bile uydurulmaz', async () => {
    seen.length = 0;
    const r = await packed().call('markReady', { externalOrderId: 'M-1' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'AWAITING_PARTNER_SPEC', 'kod: ' + r.code);
    assert.strictEqual(seen.length, 0, 'tanımsız işlem için istek gitti');
  });

  await step('hazırlık durumu, eksik olanı tek tek söyler', async () => {
    const empty = (await bare().call('health', {})).readiness;
    assert.strictEqual(empty.hasBase, false, 'adres yokken var göründü');
    assert.ok(empty.missingOperations.includes('accept'), 'eksik işlemler sayılmadı');
    assert.strictEqual(empty.configuredOperations.length, 0);

    const full = (await packed().call('health', {})).readiness;
    assert.strictEqual(full.hasBase, true);
    assert.strictEqual(full.hasKey, true);
    assert.ok(full.configuredOperations.includes('accept'), 'yapılandırılan işlemler görünmüyor');
    assert.ok(full.missingOperations.includes('markReady'), 'eksik kalan işlem gizlendi');
  });

  await step('sağlık notu, asıl engelin sözleşme olduğunu söyler', async () => {
    const r = await bare().call('health', {});
    assert.ok(/Pos Firması/.test(r.note),
      'not, Migros listesinde yer alma şartından söz etmiyor: ' + r.note);
  });

  await step('simülasyon kipi paketten bağımsız çalışır - ekran bugün gösterilebilir', async () => {
    const sim = new MigrosAdapter({ ...conn, environment: 'simulator' }, {});
    const r = await sim.call('fetchOrders', {});
    assert.ok(r.ok, JSON.stringify(r));
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
