'use strict';
/**
 * Ag taramasi - yazici bulma.
 *
 * The bug this file exists for: an office network handed out as 172.16.x.x/16
 * made localSubnets() return nothing at all, so the scan finished instantly,
 * found nothing, and the screen said "ag tarandi, yazici bulunamadi" about a
 * network it had never sent a single packet to. A wrong answer delivered
 * confidently is worse than a slow one.
 *
 * No database and no server: this is sockets and an interface table.
 */
const assert = require('assert');
const net = require('net');
const { subnetsFrom, scan, knock } = require('../src/print/discover');

const testler = [];
const test = (ad, fn) => testler.push([ad, fn]);

test('genis maskeli bir ag artik atlanmiyor', () => {
  const nets = subnetsFrom({
    Ethernet: [{ family: 'IPv4', internal: false, address: '172.16.3.253', cidr: '172.16.3.253/16' }],
  });
  assert.strictEqual(nets.length, 1, '/16 bir ag tamamen yok sayildi');
  assert.strictEqual(nets[0].base, '172.16.3');
  assert.strictEqual(nets[0].wide, true, 'genis maske isaretlenmedi');
});

test('loopback, link-local ve IPv6 disarida', () => {
  const nets = subnetsFrom({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', cidr: '127.0.0.1/8' }],
    Wifi: [{ family: 'IPv4', internal: false, address: '169.254.7.9', cidr: '169.254.7.9/16' }],
    Eth: [{ family: 'IPv6', internal: false, address: 'fe80::1', cidr: 'fe80::1/64' }],
  });
  assert.deepStrictEqual(nets, []);
});

test('ayni /24 iki kez taranmiyor', () => {
  const nets = subnetsFrom({
    Eth: [{ family: 'IPv4', internal: false, address: '192.168.1.40', cidr: '192.168.1.40/24' }],
    Wifi: [{ family: 'IPv4', internal: false, address: '192.168.1.41', cidr: '192.168.1.41/24' }],
  });
  assert.strictEqual(nets.length, 1);
});

test('normal /24 wide degil', () => {
  const nets = subnetsFrom({
    Eth: [{ family: 'IPv4', internal: false, address: '192.168.2.136', cidr: '192.168.2.136/24' }],
  });
  assert.strictEqual(nets[0].wide, false);
  assert.strictEqual(nets[0].base, '192.168.2');
});

test('9100 dinleyen bir kutu bulunuyor', async () => {
  const srv = net.createServer(s => s.end());
  await new Promise((res, rej) => srv.listen(9100, '127.0.0.9', res).once('error', rej));
  try {
    assert.strictEqual(await knock('127.0.0.9', 9100, 800), true);
    const out = await scan({ subnet: '127.0.0.9', timeoutMs: 300, concurrency: 64 });
    const hit = out.found.find(f => f.ip === '127.0.0.9');
    assert.ok(hit, 'dinleyen yazici bulunamadi');
    assert.strictEqual(hit.port, 9100);
    assert.strictEqual(hit.sure, true);
    assert.strictEqual(hit.address, '127.0.0.9');           // 9100 adrese yazilmaz
    assert.ok(out.subnets.includes('127.0.0.0/24'));
  } finally { srv.close(); }
});

test('kapali bir port yazici sayilmiyor', async () => {
  const out = await scan({ subnet: '127.0.0.200', timeoutMs: 200, concurrency: 64, ports: [9100] });
  assert.strictEqual(out.found.length, 0);
  assert.ok(out.scanned > 250, 'tum blok taranmadi');
});

test('kayitli yazicinin agi da taraniyor', async () => {
  /* Kasa 192.168.2'ye tasindi, yazici 192.168.1'de kaldi: her iki blok da
     listede olmali, yoksa ekran "bulunamadi" der ve yazici acik durur. */
  const out = await scan({ timeoutMs: 120, concurrency: 128, ports: [9100], extra: ['10.77.88.50:9100'] });
  assert.ok(out.subnets.includes('10.77.88.0/24'),
    'kayitli yazicinin blogu taranmadi: ' + out.subnets.join(', '));
});

(async () => {
  let gecti = 0;
  for (const [ad, fn] of testler) {
    try { await fn(); gecti++; console.log('  ok   ' + ad); }
    catch (e) { console.log('  FAIL ' + ad + '\n       ' + e.message); process.exitCode = 1; }
  }
  console.log(`\nyazici-tarama: ${gecti}/${testler.length}`);
})();
