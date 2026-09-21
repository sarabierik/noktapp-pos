'use strict';
/**
 * HUGIN PC Link adapter — against a device that behaves like the documentation.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. It runs the real adapter against a
 * local HTTPS server that implements developer.hugin.com.tr's documented
 * protocol: the three identity headers, the SUCCESS/ERROR envelope, GET
 * /v1/settings for pairing, POST + PUT on /v1/documents for the sale. So it
 * proves OUR side is correct against the specification as published.
 *
 * It proves nothing about a Hugin terminal. No device has answered this code.
 * The specification could be incomplete, the firmware could differ, and a
 * fiscal receipt has never been printed. That distinction is the whole reason
 * PROTOCOL_SOURCE.hugin.deviceProven is false, and this file does not get to
 * change it.
 *
 * The certificate is generated here with a Subject carrying a fiscal serial
 * instead of a hostname, because that is what makes the real device's
 * certificate unverifiable the ordinary way and is the reason the adapter pins
 * instead. The pinning checks below are the most important ones in the file.
 *
 * The last section boots the service and drives POST /api/okc/devices/:id/pair
 * over HTTP, because pairing has to write the right row - the serial, the
 * firmware version and the pinned certificate - and a unit test of the adapter
 * alone would not notice if the route wrote none of them.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/hugin.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7498';
const assert = require('assert');
const https = require('https');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HuginPcLinkAdapter, amountString, primaryMac } = require('../src/fiscal/adapters/hugin');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;
let TOKEN = null;
async function api(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = {};
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, ...json };
}

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + ' -> ' + e.message); }
}

/* ---------------------------------------------------------------- */
/* a certificate shaped like an ÖKC one: no FQDN, a fiscal serial     */
/* ---------------------------------------------------------------- */
function makeCert(commonName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hugin-'));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', crt, '-days', '2', '-subj', `/CN=${commonName}/O=HUGIN`],
    { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

/* ---------------------------------------------------------------- */
/* a device that answers the way the documentation says               */
/* ---------------------------------------------------------------- */
function fakeDevice(creds, { serialNo = 'FU00000123', expect = {} } = {}) {
  const seen = [];
  const docs = new Map();
  let nextId = 900;

  const server = https.createServer({ key: creds.key, cert: creds.cert }, (req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const h = req.headers;
      seen.push({ method: req.method, url: req.url, headers: h, body });

      const send = (code, obj) => {
        const out = Buffer.from(JSON.stringify(obj), 'utf8');
        res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': out.length });
        res.end(out);
      };
      const ok = data => send(200, {
        status: 'SUCCESS', data,
        metadata: { sfaVersion: '1.1.0a', timestamp: new Date().toISOString() },
      });
      const err = (code, description) => send(200, {
        status: 'ERROR',
        error: { code, title: 'Reddedildi', description },
        metadata: { timestamp: new Date().toISOString() },
      });

      /* The documented rule: any of the three headers wrong and the device
         refuses. SoftwareId and HardwareId always; SerialNo everywhere except
         the pairing call. */
      if (h['x-softwareid'] !== expect.softwareId) return err('ERR_AUTH', 'SoftwareId hatali');
      if (h['x-hardwareid'] !== expect.hardwareId) return err('ERR_AUTH', 'HardwareId hatali');

      if (req.method === 'GET' && req.url === '/v1/settings') {
        if (h['x-serialno'] && h['x-serialno'] !== serialNo) {
          return err('ERR_AUTH', 'SerialNo hatali');
        }
        return ok({ serialNo, model: 'HUGIN S1', vatCodes: [0, 1, 10, 20] });
      }

      if (h['x-serialno'] !== serialNo) return err('ERR_AUTH', 'SerialNo hatali');

      if (req.method === 'POST' && req.url === '/v1/documents') {
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch (_) {}
        if (p.docCategory !== 'SALE') return err('ERR_INVALID_STATE', 'docCategory SALE olmali');
        const id = String(++nextId);
        docs.set(id, { status: 'OPEN' });
        return ok({ documentId: id, status: 'OPEN' });
      }

      const m = req.method === 'PUT' && req.url.match(/^\/v1\/documents\/(.+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!docs.has(id)) return err('ERR_INVALID_STATE', 'Belge bulunamadi');
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch (_) {}
        docs.set(id, { status: 'COMPLETED' });
        return ok({
          documentId: id, status: 'COMPLETED', receiptNo: '000457', zNo: '0031',
          approvalCode: '123456', cardBrand: 'VISA', maskedPan: '4242********4242',
          bankName: 'Garanti', echo: p,
        });
      }

      send(404, { status: 'ERROR', error: { code: 'ERR_NOT_FOUND', description: 'yok' },
                  metadata: { timestamp: new Date().toISOString() } });
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

const SOFTWARE_ID = '4640507936';          // a VKN-shaped value, not a real one
const HARDWARE_ID = '3C:52:82:91:4D:2A';

function deviceRow(port, extra = {}) {
  return {
    id: 1, provider: 'hugin', device_ip: '127.0.0.1', device_port: port,
    serial_number: 'FU00000123',
    pclink_software_id: SOFTWARE_ID,
    pclink_hardware_id: HARDWARE_ID,
    pclink_cert_sha256: null,
    ...extra,
  };
}

(async () => {
  console.log('\nHUGIN PC Link - belgelenmis protokole karsi\n');

  const creds = makeCert('FU00000123');            // Subject = fiscal serial, as on a real ÖKC
  const bench = await fakeDevice(creds, { expect: { softwareId: SOFTWARE_ID, hardwareId: HARDWARE_ID } });
  const PORT = bench.port;

  /* ------------------------------ money ----------------------------- */

  await step('minor units become the string the device documents, never a float', () => {
    assert.strictEqual(amountString('19000'), '190.00');
    assert.strictEqual(amountString('2250'), '22.50');
    assert.strictEqual(amountString('5'), '0.05');
    assert.strictEqual(amountString('0'), '0.00');
    assert.strictEqual(typeof amountString('2250'), 'string');
  });

  await step('a float or a Number is refused outright', () => {
    assert.throws(() => amountString(22.5), /amount|gecersiz|invalid/i);
    assert.throws(() => amountString('22.50'), /amount|gecersiz|invalid/i);
  });

  /* ----------------------------- pairing ---------------------------- */

  let paired = null;
  await step('pairing asks GET /v1/settings WITHOUT the serial and learns it', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { serial_number: null }));
    paired = await a.pair();
    assert.strictEqual(paired.serialNo, 'FU00000123');
    assert.strictEqual(paired.sfaVersion, '1.1.0a');
    const call = bench.seen[bench.seen.length - 1];
    assert.strictEqual(call.url, '/v1/settings');
    assert.ok(!call.headers['x-serialno'], 'eslesme isteginde X-SerialNo gonderilmemeli');
  });

  await step('pairing brings back the certificate to pin', () => {
    assert.ok(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/i.test(paired.certSha256 || ''),
      'SHA-256 parmak izi gelmedi: ' + paired.certSha256);
    assert.ok(/FU00000123/.test(paired.certSubject || ''),
      'sertifika subject alani mali sicil noyu tasimali: ' + paired.certSubject);
  });

  await step('pairing does not write anything by itself', () => {
    /* pair() returns what to persist; deciding to persist it is a human act on
       the ÖKC screen. An adapter that re-pairs on its own can attach a till to
       the wrong device without anyone noticing. */
    assert.ok(!('save' in paired) && !('persisted' in paired));
  });

  /* --------------------------- the headers -------------------------- */

  await step('every later request carries all three headers', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    await a.connect();
    const call = bench.seen[bench.seen.length - 1];
    assert.strictEqual(call.headers['x-softwareid'], SOFTWARE_ID);
    assert.strictEqual(call.headers['x-hardwareid'], HARDWARE_ID);
    assert.strictEqual(call.headers['x-serialno'], 'FU00000123');
  });

  await step('a missing SoftwareId is refused here, before the network', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_software_id: null }));
    const before = bench.seen.length;
    await assert.rejects(() => a.connect(), e => e.code === 'PCLINK_NOT_CONFIGURED');
    assert.strictEqual(bench.seen.length, before, 'cihaza istek gitmemeliydi');
  });

  await step('the device refusing a header comes back with ITS code, not ours', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, {
      pclink_software_id: '9999999999', pclink_cert_sha256: paired.certSha256,
    }));
    await assert.rejects(() => a.connect(), e => e.code === 'ERR_AUTH' && /SoftwareId/.test(e.message));
  });

  /* ------------------------ certificate pinning --------------------- */

  await step('a DIFFERENT certificate on the same address stops everything', async () => {
    const other = makeCert('FU00000123');          // same subject, different key
    const impostor = await fakeDevice(other, { expect: { softwareId: SOFTWARE_ID, hardwareId: HARDWARE_ID } });
    const a = new HuginPcLinkAdapter(deviceRow(impostor.port, { pclink_cert_sha256: paired.certSha256 }));
    await assert.rejects(() => a.connect(), e => e.code === 'PCLINK_CERT_MISMATCH');
    assert.strictEqual(impostor.seen.length, 0,
      'sertifika uymazken cihaza tek bir istek bile gitmemeli');
    impostor.server.close();
  });

  await step('a mismatched certificate is never softened into "offline"', async () => {
    const other = makeCert('FU00000123');
    const impostor = await fakeDevice(other, { expect: { softwareId: SOFTWARE_ID, hardwareId: HARDWARE_ID } });
    const a = new HuginPcLinkAdapter(deviceRow(impostor.port, { pclink_cert_sha256: paired.certSha256 }));
    /* status() swallows connection problems on purpose. It must NOT swallow
       this one: "cihaz kapali" and "biri araya girmis" are not the same
       sentence and must not produce the same screen. */
    await assert.rejects(() => a.status(), e => e.code === 'PCLINK_CERT_MISMATCH');
    impostor.server.close();
  });

  await step('the pin is checked on the SECOND request too, not only the first', async () => {
    /*
     * The regression this exists for: the check used to hang off the socket's
     * 'secureConnect' event, and a pooled keep-alive socket is already secure
     * - so the event never fired again and the pin was enforced exactly once
     * per connection, then silently never. A control that switches itself off
     * after one use is worse than none, because it looks present.
     */
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    await a.connect();
    await a.connect();
    assert.ok(true);

    /* And with the WRONG pin, the second call must fail just like the first. */
    const b = new HuginPcLinkAdapter(deviceRow(PORT, {
      pclink_cert_sha256: 'AA:' + 'BB:'.repeat(30) + 'CC',
    }));
    await assert.rejects(() => b.connect(), e => e.code === 'PCLINK_CERT_MISMATCH');
    await assert.rejects(() => b.connect(), e => e.code === 'PCLINK_CERT_MISMATCH',
      'ikinci istekte pin kontrolu atlanmis');
  });

  await step('every response carries a certificate we checked', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const r = await a.request('GET', '/settings');
    assert.ok(r.peerCert && r.peerCert.fingerprint256,
      'yanit dogrulanmis sertifika tasimali');
    assert.strictEqual(r.peerCert.fingerprint256, paired.certSha256);
  });

  await step('pinning does not disable TLS anywhere else in the till', () => {
    assert.ok(!process.env.NODE_TLS_REJECT_UNAUTHORIZED
      || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '1',
      'NODE_TLS_REJECT_UNAUTHORIZED kurcalanmis - lisans ve yedek trafigi de korumasiz kalirdi');
  });

  /* ------------------------------ the sale -------------------------- */

  let session = null;
  await step('step 1 opens a document with docCategory SALE', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const r = await a.startSale({ externalId: 'ORD-1' });
    session = r.providerSessionId;
    assert.ok(session, 'belge numarasi gelmedi');
    assert.strictEqual(r.state, 'waiting_device');
    const call = bench.seen[bench.seen.length - 1];
    assert.strictEqual(call.method, 'POST');
    assert.strictEqual(call.url, '/v1/documents');
    assert.deepStrictEqual(JSON.parse(call.body), { docCategory: 'SALE' });
  });

  await step('step 2 sends the basket and the payment as documented strings', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const r = await a.finishSale(session, {
      items: [
        { name: 'FILTRE KAHVE', qty: '1', unitPriceMinor: '19000', vatRate: 10 },
        { name: 'SU', qty: '2', unitPriceMinor: '1500', vatRate: 1 },
      ],
      payment: { method: 'kart', amountMinor: '22000' },
    });
    assert.strictEqual(r.state, 'approved');
    assert.strictEqual(r.receipt.fiscalReceiptNo, '000457');
    assert.strictEqual(r.receipt.zNumber, '0031');

    const call = bench.seen[bench.seen.length - 1];
    assert.strictEqual(call.method, 'PUT');
    assert.strictEqual(call.url, '/v1/documents/' + session);
    const sent = JSON.parse(call.body);
    assert.deepStrictEqual(sent.items[0], { name: 'FILTRE KAHVE', amount: '190.00', vatRate: 10 });
    assert.deepStrictEqual(sent.items[1], { name: 'SU', amount: '30.00', vatRate: 1 });
    assert.deepStrictEqual(sent.payments, [{ type: 'EFT_POS', amount: '220.00' }]);
    for (const it of sent.items) assert.strictEqual(typeof it.amount, 'string');
  });

  await step('quantities multiply exactly - no floating point in the total', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const s = await a.startSale({ externalId: 'ORD-2' });
    await a.finishSale(s.providerSessionId, {
      items: [{ name: 'CAY', qty: '3', unitPriceMinor: '1010', vatRate: 10 }],
      payment: { method: 'nakit', amountMinor: '3030' },
    });
    const sent = JSON.parse(bench.seen[bench.seen.length - 1].body);
    assert.strictEqual(sent.items[0].amount, '30.30');
    assert.strictEqual(sent.payments[0].type, 'CASH');
  });

  await step('an unknown payment method is an error, never a silent CASH', () => {
    assert.strictEqual(HuginPcLinkAdapter.paymentType('nakit'), 'CASH');
    assert.strictEqual(HuginPcLinkAdapter.paymentType('kart'), 'EFT_POS');
    assert.strictEqual(HuginPcLinkAdapter.paymentType('yemek'), 'VOUCHER');
    assert.throws(() => HuginPcLinkAdapter.paymentType('kripto'),
      e => e.code === 'PAYMENT_TYPE_UNSUPPORTED');
  });

  await step('an empty basket never reaches the device', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const before = bench.seen.length;
    await assert.rejects(
      () => a.finishSale('999', { items: [], payment: { method: 'nakit', amountMinor: '0' } }),
      e => e.code === 'SALE_EMPTY');
    assert.strictEqual(bench.seen.length, before);
  });

  /* ------------------- what we deliberately do not know ------------- */

  await step('cancel, refund and Z refuse instead of guessing a URL', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const before = bench.seen.length;
    for (const fn of ['cancelSale', 'refund', 'report']) {
      await assert.rejects(() => a[fn]('x'), e =>
        e.code === 'ENDPOINT_UNDOCUMENTED' && e.status === 501 && e.deviceEffects === 'none',
        fn + ' uydurma bir uc noktaya gitmemeli');
    }
    assert.strictEqual(bench.seen.length, before, 'belgelenmemis islem cihaza dokunmamali');
  });

  await step('poll says plainly that PC Link has no poll', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    await assert.rejects(() => a.pollSale('x'), e => e.code === 'POLL_NOT_APPLICABLE');
  });

  /* --------------------------- provenance --------------------------- */

  await step('the register still says no device has ever answered', () => {
    const engelli = require('../src/fiscal/adapters/engelli');
    const h = engelli.PROTOCOL_SOURCE.hugin;
    assert.strictEqual(h.source, 'vendor_documented');
    assert.strictEqual(h.deviceProven, false,
      'bu suite bir Hugin cihazina dokunmadi; deviceProven true olamaz');
    assert.strictEqual(h.contract, 'required_not_signed');
  });

  await step('the hardware id is stable and never a virtual interface', () => {
    const a = primaryMac();
    const b = primaryMac();
    assert.strictEqual(a, b, 'iki cagri farkli MAC verdi - eslesme her acilista duserdi');
    if (a !== null) {
      assert.ok(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(a), 'MAC bicimi bozuk: ' + a);
      assert.notStrictEqual(a, '00:00:00:00:00:00');
    }
  });

  await step('a device that is unreachable reports offline, not approved', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(1, { pclink_cert_sha256: paired.certSha256 }));
    const s = await a.status();
    assert.strictEqual(s.state, 'offline');
  });

  /* ------------------------------------------------------------------ */
  /* the pairing endpoint, over HTTP, writing a real row                  */
  /* ------------------------------------------------------------------ */

  const server = await bootstrap();
  db.setClientId(CID);
  const uid = await db.value('SELECT id FROM users WHERE client_id=? ORDER BY id LIMIT 1', [CID]);
  TOKEN = await auth.issueToken({ cid: CID, uid: uid || 1, role: 'admin', name: 'OKC Yonetici', kind: 'pos' });

  await db.exec("DELETE FROM fiscal_devices WHERE client_id=? AND serial_number IN ('TEST-HUGIN','FU00000123')", [CID]);
  const devId = await db.insert(
    `INSERT INTO fiscal_devices (client_id, provider, device_model, serial_number, connection_type,
        device_ip, device_port, environment, is_active, created_at)
     VALUES (?, 'hugin', 'HUGIN S1', 'TEST-HUGIN', 'TCP', '127.0.0.1', ?, 'TEST', 1, NOW())`,
    [CID, PORT]);

  await step('pairing over HTTP records the serial, the firmware and the pin', async () => {
    const r = await api('POST', `/api/okc/devices/${devId}/pair`,
      { software_id: SOFTWARE_ID, hardware_id: HARDWARE_ID, device_ip: '127.0.0.1', device_port: PORT });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.serial_number, 'FU00000123');
    assert.strictEqual(r.sfa_version, '1.1.0a');

    const row = await db.one('SELECT * FROM fiscal_devices WHERE id=?', [devId]);
    assert.strictEqual(row.serial_number, 'FU00000123');
    assert.strictEqual(row.pclink_software_id, SOFTWARE_ID);
    assert.strictEqual(row.pclink_hardware_id, HARDWARE_ID);
    assert.strictEqual(row.pclink_sfa_version, '1.1.0a');
    assert.ok(row.pclink_cert_sha256, 'sertifika parmak izi kaydedilmedi');
    assert.ok(row.pclink_paired_at, 'eslesme zamani yazilmadi');
  });

  await step('pairing is not permission to trade', async () => {
    const row = await db.one('SELECT production_enabled FROM fiscal_devices WHERE id=?', [devId]);
    assert.strictEqual(Number(row.production_enabled), 0,
      'eslesme uretime acmamali - o ayri ve kanit isteyen bir adim');
  });

  await step('re-pairing an already paired device demands the serial', async () => {
    const r = await api('POST', `/api/okc/devices/${devId}/pair`,
      { software_id: SOFTWARE_ID, hardware_id: HARDWARE_ID });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.code, 'CONFIRMATION_REQUIRED');
  });

  await step('re-pairing with the serial typed goes through', async () => {
    const r = await api('POST', `/api/okc/devices/${devId}/pair`,
      { software_id: SOFTWARE_ID, hardware_id: HARDWARE_ID, confirm_serial: 'FU00000123' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
  });

  await step('a VKN that is not a VKN is refused before the device is touched', async () => {
    const before = bench.seen.length;
    const r = await api('POST', `/api/okc/devices/${devId}/pair`,
      { software_id: 'abc', hardware_id: HARDWARE_ID, confirm_serial: 'FU00000123' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.code, 'SOFTWARE_ID_REQUIRED');
    assert.strictEqual(bench.seen.length, before);
  });

  await step('pairing is refused for a provider that does not speak PC Link', async () => {
    await db.exec('UPDATE fiscal_devices SET provider=? WHERE id=?', ['ingenico', devId]);
    const r = await api('POST', `/api/okc/devices/${devId}/pair`,
      { software_id: SOFTWARE_ID, hardware_id: HARDWARE_ID, confirm_serial: 'FU00000123' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.code, 'PAIR_NOT_SUPPORTED');
    await db.exec('UPDATE fiscal_devices SET provider=? WHERE id=?', ['hugin', devId]);
  });

  await db.exec('DELETE FROM fiscal_devices WHERE id=?', [devId]);
  try { server.close(); } catch (_) {}

  bench.server.close();
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  failed.forEach(f => console.log('  ! ' + f[1] + ': ' + f[2]));
  process.exit(failed.length ? 1 : 0);
})();
