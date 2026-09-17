'use strict';
/**
 * Karekod - eslestirme sembolu.
 *
 * This file exists because of one missing attribute. qrcode-svg emits
 * <svg width="300" height="300"> with no viewBox; the pairing screen's CSS
 * then stretches it to `width:100%` inside a 212 pixel box. Without a viewBox
 * that does not scale the drawing, it CROPS it - the right column and the
 * bottom row of modules, bottom-left finder pattern included, were never on
 * the screen. A symbol missing a finder pattern is not a marginal symbol that
 * a better camera might read; no decoder accepts it. "Karekod okutun" could
 * not have worked on any build, on any phone, on any network - and the six
 * digit code underneath it worked perfectly and hid that for months.
 *
 * So: the symbol must carry a viewBox, and the payload must stay short enough
 * to be read off a screen rather than merely to exist.
 */
const assert = require('assert');
const device = require('../src/modules/device');
const QRCode = require('qrcode-svg');

const testler = [];
const test = (ad, fn) => testler.push([ad, fn]);

const ORNEK = {
  qr_token: '3f'.repeat(16),
  client_id: 1,
  addresses: ['http://192.168.2.136:7451', 'http://172.16.3.253:7451',
    'http://192.168.56.1:7451', 'http://10.5.0.2:7451'],
};

test('sembol viewBox tasiyor - yoksa ekranda kirpilir', () => {
  const svg = device.qrSvg('noktapp://pair?t=' + ORNEK.qr_token);
  assert.ok(/<svg[^>]*viewBox="0 0 \d+ \d+"/.test(svg),
    'viewBox yok: sembol kutuya sigmaz, kirpilir ve hicbir telefon okuyamaz');
  assert.ok(/preserveAspectRatio/.test(svg), 'preserveAspectRatio yok');
});

test('viewBox olculeri width/height ile ayni', () => {
  const svg = device.qrSvg('noktapp://pair?t=' + ORNEK.qr_token, 240);
  const w = /width="(\d+)"/.exec(svg)[1];
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  assert.strictEqual(vb[1], w);
  assert.strictEqual(vb[2], w);
});

test('adresler kisa yaziliyor - sema ve yuzde kodlamasi yok', () => {
  const p = device.pairPayload(ORNEK);
  assert.ok(p.startsWith('noktapp://pair?'), p);
  assert.ok(!p.includes('%3A') && !p.includes('%2F'),
    'adresler yuzde kodlanmis, sembol gereksiz buyuyor: ' + p);
  assert.ok(!/b=https?:/.test(p), 'adreste sema var: ' + p);
});

test('yayin adresi ve jeton sembolde', () => {
  const p = device.pairPayload(ORNEK);
  assert.ok(p.includes('b=192.168.2.136:7451'), p);
  assert.ok(p.includes('t=' + ORNEK.qr_token), p);
  assert.ok(p.includes('c=1'), 'tenant numarasi yok - bulut uzerinden eslestirme calismaz');
});

test('dort adresli bir kasada bile sembol 45 modulun altinda', () => {
  const p = device.pairPayload(ORNEK);
  const n = new QRCode({ content: p, ecl: 'L' }).qrcode.moduleCount;
  assert.ok(n <= 45, `sembol ${n}x${n} - ekrandan okumak icin fazla yogun (payload ${p.length})`);
});

test('telefonun ayristirdigi bicim', () => {
  /* the app: startsWith('noktapp://pair'), t must be 32 hex, addresses get
     http:// put back on. If any of those stop being true the scanner will
     simply ignore our own symbol - silently, which is how this cost a day. */
  const p = device.pairPayload(ORNEK);
  const u = new URL(p);
  assert.strictEqual(u.protocol, 'noktapp:');
  assert.ok(/^[0-9a-f]{32}$/.test(u.searchParams.get('t')));
  for (const a of (u.searchParams.get('a') || '').split(',').filter(Boolean)) {
    assert.ok(/^\d+\.\d+\.\d+\.\d+:\d+$/.test(a), 'ek adres bicimi bozuk: ' + a);
  }
});

(async () => {
  let gecti = 0;
  for (const [ad, fn] of testler) {
    try { await fn(); gecti++; console.log('  ok   ' + ad); }
    catch (e) { console.log('  FAIL ' + ad + '\n       ' + e.message); process.exitCode = 1; }
  }
  console.log(`\nkarekod: ${gecti}/${testler.length}`);
})();
