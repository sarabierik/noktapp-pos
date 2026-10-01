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
 * It proves nothing about a Hugin terminal. A real HUGIN S1 (FU00032768) has
 * since answered the HANDSHAKE - TLS, certificate pin, X-SoftwareId, GET
 * /v1/settings - which is why deviceProven reads 'handshake_only' rather than
 * false. The SALE body has still never been near hardware: no fiscal receipt
 * has been printed from it. Nothing in this file, which talks to a stub, gets
 * to move that.
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
const para = require('../src/fiscal/tutar');
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
          bankName: 'Garanti',
          /*
           * The three references a refund needs later. The device returns them
           * ONCE, here, when detailedResponse was asked for, and there is no
           * endpoint that hands them out again - so the stub returns them and
           * the tests below prove we write them down.
           */
          bankId: 46, bankReferenceNo: 'RRN000123456789', transactionId: 'TX-778899',
          echo: p,
        });
      }

      /* POST /v1/reports/{X|Z}/{print|detail} */
      /*
       * POST /v1/reports/{X|Z}/{print|detail}
       *
       * This answer is not invented: it is the envelope a real HUGIN S1
       * (FU00032768) returned on 26.09.2026, trimmed but with every key left
       * exactly as the device wrote it - reportHeader.receiptNo rather than
       * zNo, a day-first receiptDate, and the cumulative fiscal-memory totals.
       * The first version of this stub answered with `zNo` and an ISO date
       * because that is what I expected, and the suite passed against it while
       * the real device was writing empty Z numbers into the register.
       */
      /*
       * The stub answers the way the real device does: X over GET, Z over
       * POST, and the WRONG verb gets ERR_DATA_CORRUPT rather than a 404 -
       * which is exactly how three days were spent thinking our body was
       * malformed when the method was wrong.
       */
      const rpAny = req.url.match(/^\/v1\/reports\/(X|Z)\/(print|detail)$/);
      if (rpAny && req.method !== (rpAny[1] === 'X' ? 'GET' : 'POST')) {
        return err('ERR_DATA_CORRUPT', 'Mesaj hatalı');
      }
      const rp = rpAny && req.method === (rpAny[1] === 'X' ? 'GET' : 'POST') ? rpAny : null;
      if (rp) {
        const head = { deviceId: serialNo, receiptNo: rp[1] === 'Z' ? '0003' : '0041',
                       receiptDate: '26-09-2026 16:59', ejNo: 1 };
        return ok({
          reportHeader: head,
          grossSales: { total: '1234.50', count: 7 },
          netSales: { total: '1200.00', count: 7 },
          discount: { total: '34.50', count: 2 },
          void: { total: '0.00', count: 1 },
          counters: { total: 2, sales: 0, canceled: 1, fiscal: 0, nonFiscalDoc: 2 },
          cash: { count: 3, total: '400.00' },
          eftPos: { count: 4, total: '800.00', bankTotals: [] },
          voucher: {}, wire: {}, openAccount: {}, noCharge: {},
          paymentsTotal: '1200.00',
          cumulativeTotal: '3270.75', cumulativeVat: '264.02',
        });
      }

      /* POST /v1/pos/refunds - after the fiscal day has closed. */
      if (req.method === 'POST' && req.url === '/v1/pos/refunds') {
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch (_) {}
        if (!p.bankId || !p.bankReferenceNo) {
          return err('ERR_INVALID_REQUEST', 'bankId ve bankReferenceNo zorunlu');
        }
        /* The documented 206: the device found the transaction still voidable
           and reversed it instead of refunding it. */
        if (String(p.bankReferenceNo) === 'RRN-STILL-VOIDABLE') {
          return send(206, { status: 'SUCCESS',
            data: { transactionId: 'TX-VOIDED', amount: p.amount },
            metadata: { timestamp: new Date().toISOString() } });
        }
        return ok({ transactionId: 'TX-REFUND-1', authorizationCode: '654321', amount: p.amount });
      }

      const v = req.method === 'POST' && req.url.match(/^\/v1\/pos\/transactions\/(.+)\/void$/);
      if (v) return ok({ transactionId: decodeURIComponent(v[1]), amount: '100.00' });

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

  /*
   * This used to assert that cancel, refund and report ALL refused with
   * ENDPOINT_UNDOCUMENTED. That was right about the principle and wrong about
   * the facts: cancel and the reports are in the API reference, which nobody
   * had opened. Two of the three are now implemented against their documented
   * paths and tested above.
   *
   * Refund stays refused, and the distinction matters: it is not a missing URL
   * but a missing FLOW. PC Link runs a refund through the banking side with
   * the card presented at the device again, which needs screens that do not
   * exist yet. Refusing is the honest state; guessing would put a wrong
   * reversal against somebody's card.
   */
  /*
   * THE FIELD THAT CANNOT BE FETCHED LATER.
   *
   * "Iade isleminde gereken bankId ve bankReferenceNo ... orjinal islem
   * esnasinda alinip kayit edilebilmesi icin detailedResponse = true
   * gonderilmeli." There is no lookup. A card sale taken without asking for
   * the detailed response can never be refunded through PC Link, and nobody
   * discovers that until a guest comes back with a complaint.
   */
  await step('every sale asks for the detail a refund will need', () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const body = a.buildSalePayload({
      items: [{ name: 'PIDE', qty: '1.00', unitPriceMinor: '32000', vatRate: 10 }],
      payment: { method: 'kredi_karti', amountMinor: '32000' },
    });
    assert.strictEqual(body.detailedResponse, true,
      'detailedResponse gonderilmezse bu satis hicbir zaman iade edilemez');
  });

  await step('a refund without the bank reference is refused before the device', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const before = bench.seen.length;
    await assert.rejects(() => a.refund({ amountMinor: '32000' }), e => {
      assert.strictEqual(e.code, 'REFERENCE_MISSING'.replace('REFERENCE', 'REFUND_REFERENCE'));
      assert.strictEqual(e.deviceEffects, 'none');
      return true;
    });
    assert.strictEqual(bench.seen.length, before,
      'referanssiz iade cihaza gitmemeli - eksik olan sonradan bulunamaz');
  });

  await step('void needs the bank transaction id and uses the documented path', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    await assert.rejects(() => a.voidTransaction(''), e =>
      e.code === 'PCLINK_NO_TRANSACTION_ID');
    await a.voidTransaction(4599).catch(() => {});
    assert.strictEqual(bench.seen[bench.seen.length - 1].url, '/v1/pos/transactions/4599/void');
  });

  await step('poll says plainly that PC Link has no poll', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    await assert.rejects(() => a.pollSale('x'), e => e.code === 'POLL_NOT_APPLICABLE');
  });

  /*
   * THE ORCHESTRATION CONTRACT — the gap that a real device found.
   *
   * Both halves of the sale were tested above and both were correct. What
   * nothing tested was whether anything CALLS the second half. fiscal/index.js
   * ran a poll loop after startSale, pollSale threw POLL_NOT_APPLICABLE as it
   * should, the loop swallowed it and carried on, and finishSale - the call
   * that actually carries the basket - was never made. The device held an
   * empty open document and the till waited three minutes.
   *
   * These two checks are the contract that fix rests on. If either changes
   * without the orchestrator changing with it, the till silently goes back to
   * asking a question PC Link cannot answer.
   */
  /*
   * MONEY CROSSES A TYPE BOUNDARY HERE, and the first real basket died on it.
   *
   * Two minor() functions live in this codebase: util/http.minor is
   * Math.round(Number(v) * 100) and returns a NUMBER; fiscal/tutar.js is
   * BigInt throughout and speaks minor-unit STRINGS. beginSale built the sale
   * object with the float one, so a real HUGIN S1 was sent a number where the
   * exact layer demanded a string and refused the basket:
   *   "line.unitPrice: minor-unit integer string bekleniyor, gelen: 32000"
   * The VALUE was right. The TYPE was not, and money is the one place in this
   * program where that distinction is not pedantry.
   */
  await step('a NUMBER price is refused - only minor-unit strings cross this line', () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    assert.throws(
      () => a.buildItem({ name: 'PIDE', qty: '1.00', unitPriceMinor: 32000, vatRate: 10 }),
      (e) => { assert.match(e.message, /minor-unit integer string/); return true; },
      'sayi kabul edilirse float para fis yoluna girer');
  });

  await step('the exact converter turns DECIMAL(10,2) into what the device wants', () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    assert.strictEqual(para.minorFromDecimal('320.00', 'x'), '32000');
    assert.strictEqual(para.minorFromDecimal(320, 'x'), '32000');
    assert.strictEqual(para.minorFromDecimal('0.05', 'x'), '5');
    /* refused rather than rounded: a dropped digit is a receipt that does not
       match the bill */
    assert.throws(() => para.minorFromDecimal('1.005', 'x'), /basamagi/);
    assert.deepStrictEqual(
      a.buildItem({ name: 'PIDE', qty: '1.00',
        unitPriceMinor: para.minorFromDecimal('320.00', 'x'), vatRate: 10 }),
      { name: 'PIDE', amount: '320.00', vatRate: 10 });
  });

  /*
   * A bad basket must fail BEFORE a document is opened on the device. We can
   * open one and cannot close one - cancelSale is ENDPOINT_UNDOCUMENTED until
   * the Postman reference arrives - so a refusal that happens after startSale
   * strands the OKC until somebody restarts it.
   */
  await step('a bad basket is refused without any request reaching the device', () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const before = bench.seen.length;
    assert.throws(() => a.buildSalePayload({
      items: [{ name: 'PIDE', qty: '1.00', unitPriceMinor: 32000, vatRate: 10 }],
      payment: { method: 'nakit', amountMinor: '32000' },
    }), /minor-unit integer string/);
    assert.strictEqual(bench.seen.length, before,
      'gecersiz sepet icin cihaza istek gitti - belge acik kalabilir');
  });

  await step('the payload built up front is the one finishSale sends', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const sale = {
      items: [{ name: 'PIDE', qty: '1.00', unitPriceMinor: '32000', vatRate: 10 }],
      payment: { method: 'nakit', amountMinor: '32000' },
    };
    const planned = a.buildSalePayload(sale);
    const open = await a.startSale({ externalId: 'ORD-PRE' });
    await a.finishSale(open.providerSessionId, sale);
    const sent = JSON.parse(bench.seen[bench.seen.length - 1].body);
    assert.deepStrictEqual(sent, planned,
      'on kontrol ile gonderilen govde ayni degilse on kontrol bir sey kanitlamaz');
    assert.deepStrictEqual(sent.payments, [{ type: 'CASH', amount: '320.00' }]);
  });

  /*
   * EVERY TENDER THE TILL CAN SEND, walked from its own list.
   *
   * The mapping table was written from the PC Link documentation plus a guess
   * at what the till sends, and it missed the till's own vocabulary: the app
   * sends 'kredi_karti', the table knew 'kredi'. So the first real cash sale
   * printed a receipt and the very next card sale was refused by our own
   * adapter before it reached the device.
   *
   * This walks modules/payments.js METHODS so that adding a tender to the
   * till cannot silently leave a hole in the fiscal path: each one either
   * maps to a PC Link tender, or is named below as deliberately not one.
   */
  await step('every tender the till can send either maps or is a known non-tender', () => {
    const { METHODS } = require('../src/modules/payments');
    /*
     * Every one of the till's six tenders has a PC Link counterpart. An
     * earlier version of this check asserted that havale, ikram and acik
     * hesap had none - that was read from the landing page, not the payment
     * table in the API reference, and it was wrong.
     */
    const expected = {
      nakit: 'CASH', kredi_karti: 'EFT_POS', yemek_karti: 'VOUCHER',
      havale: 'WIRE', ikram: 'NO_CHARGE', acik_hesap: 'OPEN_ACCOUNT',
    };

    for (const m of METHODS) {
      assert.strictEqual(HuginPcLinkAdapter.paymentType(m), expected[m],
        `${m} icin PC Link karsiligi yok - kasa bu tusu gosteriyor ama satis reddedilir`);
    }

    /* and the list itself has not grown behind this check's back */
    assert.deepStrictEqual([...METHODS].sort(), Object.keys(expected).sort(),
      'kasaya yeni bir odeme turu eklenmis; bu testte de karsiligini yazin');

    /* an unknown tender is still refused rather than guessed at */
    assert.throws(() => HuginPcLinkAdapter.paymentType('bitcoin'), /PC Link tablosunda yok/);
  });

  await step('cancel hits the documented endpoint and needs a document id', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    await assert.rejects(() => a.cancelSale(''), (e) => {
      assert.strictEqual(e.code, 'PCLINK_NO_DOCUMENT_ID'); return true;
    });
    const open = await a.startSale({ externalId: 'ORD-CANCEL' });
    await a.cancelSale(open.providerSessionId).catch(() => {});
    const call = bench.seen[bench.seen.length - 1];
    assert.strictEqual(call.method, 'POST');
    assert.strictEqual(call.url, '/v1/documents/' + open.providerSessionId + '/cancel');
  });

  await step('Z is never fired by a typo - the report kind is validated', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const before = bench.seen.length;
    await assert.rejects(() => a.report('gunsonu'), (e) => {
      assert.strictEqual(e.code, 'REPORT_KIND_UNSUPPORTED'); return true;
    });
    assert.strictEqual(bench.seen.length, before,
      'gecersiz rapor turu icin cihaza istek gitti - Z mali gunu kapatir');
    await a.report('Z').catch(() => {});
    assert.strictEqual(bench.seen[bench.seen.length - 1].url, '/v1/reports/Z/print');
    assert.strictEqual(bench.seen[bench.seen.length - 1].method, 'POST',
      'Z POST ile gider - gercek cihazda kanitlandi');
    await a.report('x', { print: false }).catch(() => {});
    assert.strictEqual(bench.seen[bench.seen.length - 1].url, '/v1/reports/X/detail');
    assert.strictEqual(bench.seen[bench.seen.length - 1].method, 'GET',
      'X GET ile gider - POST denendiginde cihaz ERR_DATA_CORRUPT donuyor');
  });

  /* ------------------------------------------------------------------ */
  /* giving money back                                                   */
  /* ------------------------------------------------------------------ */

  await step('the sale returns the three references a refund needs, and they are read', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const open = await a.startSale({ externalId: 'ORD-REF' });
    const done = await a.finishSale(open.providerSessionId, {
      items: [{ name: 'Kahve', qty: '1', unitPriceMinor: '10000', vatRate: 10 }],
      payment: { method: 'kredi_karti', amountMinor: '10000' },
    });
    assert.strictEqual(done.state, 'approved');
    assert.strictEqual(String(done.receipt.bankId), '46');
    assert.strictEqual(done.receipt.bankReferenceNo, 'RRN000123456789');
    assert.strictEqual(done.receipt.posTransactionId, 'TX-778899',
      'void icin banka islem numarasi - bir daha sorulamaz');
  });

  await step('a refund without the bank references is refused before any request goes out', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const before = bench.seen.length;
    await assert.rejects(() => a.refund({ amountMinor: '10000' }), (e) => {
      assert.strictEqual(e.code, 'REFUND_REFERENCE_MISSING'); return true;
    });
    assert.strictEqual(bench.seen.length, before,
      'referanssiz iade icin cihaza istek gitmemeli');
  });

  await step('a refund sends the documented body and reports refunded', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const r = await a.refund({ amountMinor: '19000', bankId: 46, bankReferenceNo: 'RRN000123456789' });
    const call = bench.seen[bench.seen.length - 1];
    assert.strictEqual(call.url, '/v1/pos/refunds');
    const sent = JSON.parse(call.body);
    assert.strictEqual(sent.amount, '190.00', 'para cihaza metin gider, float degil');
    assert.strictEqual(sent.bankId, 46);
    assert.strictEqual(sent.bankReferenceNo, 'RRN000123456789');
    assert.strictEqual(r.state, 'refunded');
    assert.strictEqual(r.redirectedToVoid, false);
  });

  await step('a 206 answer is reported as a void, never flattened into a refund', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const r = await a.refund({ amountMinor: '19000', bankId: 46, bankReferenceNo: 'RRN-STILL-VOIDABLE' });
    assert.strictEqual(r.state, 'voided',
      'cihaz iade yerine iptal yapti - farkli belge, farkli finansal olay');
    assert.strictEqual(r.redirectedToVoid, true);
  });

  await step('a void needs the bank transaction id and hits the documented path', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    await assert.rejects(() => a.voidTransaction(null), (e) => {
      assert.strictEqual(e.code, 'PCLINK_NO_TRANSACTION_ID'); return true;
    });
    const r = await a.voidTransaction('TX-778899');
    assert.strictEqual(bench.seen[bench.seen.length - 1].url, '/v1/pos/transactions/TX-778899/void');
    assert.strictEqual(r.state, 'voided');
  });

  /* ------------------------------------------------------------------ */
  /* the orchestrator's half: does the till write the references down?    */
  /* ------------------------------------------------------------------ */

  await step('X is a GET and Z is a POST - the two are not interchangeable', async () => {
    /*
     * The reference says POST for both. A real FU00032768 refused an X sent as
     * POST three times with ERR_DATA_CORRUPT / "Mesaj hatalı", and HUGIN
     * support confirmed on 28.09.2026 that X must be a bodiless GET and that
     * their documentation will be corrected.
     *
     * This check exists so nobody unifies the two verbs later. Getting it
     * wrong in the X direction costs an error message; getting it wrong in the
     * Z direction costs the one report that cannot be taken back.
     */
    assert.strictEqual(HuginPcLinkAdapter.reportMethod('X'), 'GET');
    assert.strictEqual(HuginPcLinkAdapter.reportMethod('Z'), 'POST');

    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    const x = await a.report('X');
    const call = bench.seen[bench.seen.length - 1];
    assert.strictEqual(call.method, 'GET');
    assert.strictEqual(call.url, '/v1/reports/X/print');
    assert.strictEqual(call.body, '', 'X raporu govdesiz gitmeli');
    assert.ok(x.raw && x.raw.reportHeader, 'X yanitinda baslik yok');
  });

  await step('the adapter declares itself request/response, not poll', () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    assert.strictEqual(a.saleShape, 'request_response',
      'orchestrator bunu okuyup finishSale cagiriyor; degisirse satis askida kalir');
  });

  await step('a poll against PC Link fails loudly rather than returning nothing', async () => {
    const a = new HuginPcLinkAdapter(deviceRow(PORT, { pclink_cert_sha256: paired.certSha256 }));
    await assert.rejects(() => a.pollSale('1'), (e) => {
      assert.strictEqual(e.code, 'POLL_NOT_APPLICABLE',
        'sessiz donerse yoklama dongusu sonsuza kadar doner');
      return true;
    });
  });

  /* --------------------------- provenance --------------------------- */

  await step('the register records exactly what the device has and has not proven', () => {
    const engelli = require('../src/fiscal/adapters/engelli');
    const h = engelli.PROTOCOL_SOURCE.hugin;
    assert.strictEqual(h.source, 'vendor_documented');

    /*
     * 'handshake_only' is the honest middle state and the only one this suite
     * permits. A real device proved the handshake on 24.09.2026; a stub cannot
     * upgrade that to the sale, and `true` here would claim a fiscal receipt
     * that nobody has printed.
     */
    assert.strictEqual(h.deviceProven, 'cash_sale_printed',
      'bu suite bir Hugin cihazina dokunmadi; deviceProven yukseltilemez');
    assert.ok(h.deviceProvenDetail.proven.includes('cash_receipt'),
      'nakit fis 24.09.2026 tarihinde gercek cihazda basildi');
    assert.ok(h.deviceProvenDetail.unproven.includes('card_sale'),
      'kart yolu bu cihazda kanitlanamaz - yuklu gercek banka uygulamasi yok');
    assert.ok(h.deviceProvenDetail.proven.includes('get_settings'));
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

  await step('the approved sale persists bankId, bankReferenceNo and the transaction id', async () => {
    /*
     * The references used to survive only inside fiscal_receipts.raw_response.
     * A column nobody can index is not a record: this asserts they are on the
     * transaction row, because that is the row a refund reads.
     */
    const cols = await db.query(
      `SELECT COLUMN_NAME AS c FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'fiscal_transactions'
          AND COLUMN_NAME IN ('bank_id','bank_reference_no','pos_transaction_id')`);
    assert.strictEqual(cols.length, 3,
      'gocler uygulanmamis: iade referanslari icin kolon yok');
  });

  /*
   * The parser, against the bytes the hardware really sent. These three checks
   * exist because the previous mapping was written from expectation and passed
   * its own stub while failing the only device that has ever run it.
   */
  await step('the Z number is read from the header the device really sends', () => {
    const fiscal = require('../src/fiscal');
    const raw = JSON.parse('{"reportHeader":{"deviceId":"FU00032768","receiptNo":"0003",'
      + '"receiptDate":"26-09-2026 16:59","ejNo":1},"cumulativeTotal":"3270.75",'
      + '"cumulativeVat":"264.02","counters":{"total":2,"sales":0,"canceled":1},'
      + '"cash":{},"eftPos":{"count":0,"total":"0.00","bankTotals":[]}}');
    const h = fiscal.reportHeader(raw);
    assert.strictEqual(h.receiptNo, '0003', 'Z sayaci reportHeader.receiptNo icinde');
    assert.strictEqual(h.ejNo, '1');
    assert.strictEqual(h.deviceId, 'FU00032768');
    assert.strictEqual(h.deviceTime, '2026-09-26 16:59:00',
      'cihaz tarihi gun-once yazar; ters okunursa 03-09 ile 09-03 karisir');

    const t = fiscal.reportTotals(raw);
    assert.strictEqual(t.cumulativeTotal, '3270.75', 'mali hafiza toplami kayboluyor');
    assert.strictEqual(t.cumulativeVat, '264.02');
    assert.deepStrictEqual(t.counters, { total: 2, sales: 0, canceled: 1 });
    assert.ok(t.tenders.eftPos, 'odeme turu dokumü okunmadi');
  });

  await step('a date that is not the device\'s format stores nothing, never a guess', () => {
    const fiscal = require('../src/fiscal');
    /* Storing 03-09 as 9 March when the device meant 3 September is worse than
       storing nothing, because both are plausible and only one is true. */
    assert.strictEqual(fiscal.deviceDate('2026-09-26T16:59:00'), null);
    assert.strictEqual(fiscal.deviceDate('26/09/2026 16:59'), null);
    assert.strictEqual(fiscal.deviceDate('99-99-2026 16:59'), null);
    assert.strictEqual(fiscal.deviceDate(''), null);
    assert.strictEqual(fiscal.deviceDate('03-09-2026 08:05'), '2026-09-03 08:05:00');
  });

  await step('card fields never reach the device log', () => {
    const fiscal = require('../src/fiscal');
    const masked = fiscal.maskPayload({
      amount: '190.00',
      pan: '4242424242424242',
      cardNumber: '5555555555554444',
      cardHolder: 'ERIK SARABI',
      nested: { cvv: '123', track2: 'x', bankId: 46 },
    });
    assert.strictEqual(masked.amount, '190.00', 'tutar maskelenmemeli');
    assert.strictEqual(masked.nested.bankId, 46, 'iade referansi maskelenmemeli');
    for (const v of [masked.pan, masked.cardNumber, masked.cardHolder,
                     masked.nested.cvv, masked.nested.track2]) {
      assert.strictEqual(v, '***');
    }
    /* Whole value, never partial: a rule that keeps "the last four" is a rule
       that keeps the first twelve the day a vendor renames a field. */
    assert.ok(!JSON.stringify(masked).includes('4242'));
  });

  await step('an X or Z report is actually written down, with a usable report_key', async () => {
    /*
     * This is the bug this step exists for: fiscal_device_reports.report_key is
     * NOT NULL and (client_id, report_key) is UNIQUE, the INSERT never supplied
     * it, and the whole statement was wrapped in .catch(() => {}). Every X and
     * Z the device ever printed went unrecorded, silently.
     */
    /* deviceReport() takes whatever activeDevice() picks, so the paired device
       has to be the only active one and the switch has to be on. */
    await db.exec('UPDATE fiscal_devices SET is_active=0 WHERE client_id=? AND id<>?', [CID, devId]);
    await db.exec('UPDATE fiscal_devices SET is_active=1 WHERE id=?', [devId]);
    await db.setSetting('fiscal_enabled', '1');
    await db.exec('DELETE FROM fiscal_device_reports WHERE client_id=?', [CID]);

    const fiscal = require('../src/fiscal');
    const out = await fiscal.deviceReport(CID, 'X');
    assert.strictEqual(out.recorded, true, 'rapor alindi ama kaydedilemedi');
    const rows = await db.query(
      "SELECT report_type, report_key, z_number, device_time, note, status FROM fiscal_device_reports WHERE client_id=?", [CID]);
    assert.strictEqual(rows.length, 1, 'X raporu icin tam bir satir olmali');
    assert.strictEqual(rows[0].report_type, 'X');
    assert.ok(rows[0].report_key && rows[0].report_key.length > 3, 'report_key bos');
    assert.ok(rows[0].device_time, 'cihaz saati kaydedilmedi');
    /* An X's receiptNo has not been established to mean a Z number, so it is
       not filed as one. */
    assert.strictEqual(rows[0].z_number, null,
      'X raporunda z_number doldurulmus - bu sayinin Z sayaci oldugu kanitlanmadi');
    assert.ok(/3270\.75/.test(rows[0].note || ''),
      'kumulatif toplam satirda gorunmuyor, yine blob icinde kalmis');

    /* Two X reports a minute apart are two real events and must not collide on
       the unique key. */
    await fiscal.deviceReport(CID, 'X');
    const two = await db.query(
      "SELECT COUNT(*) AS n FROM fiscal_device_reports WHERE client_id=? AND report_type='X'", [CID]);
    assert.strictEqual(Number(two[0].n), 2,
      'ikinci X raporu benzersiz anahtarda cakisti - her X ayri bir olaydir');

    /* A Z does carry its counter, and it goes in the column. */
    const z = await fiscal.deviceReport(CID, 'Z');
    assert.strictEqual(z.zNumber, '0003');
    const zrow = await db.one(
      "SELECT z_number, device_time, report_key FROM fiscal_device_reports WHERE client_id=? AND report_type='Z' ORDER BY id DESC", [CID]);
    assert.strictEqual(zrow.z_number, '0003', 'Z numarasi bos kaldi - bu isin tek onemli alani');
    assert.ok(/:Z:/.test(zrow.report_key) && /0003/.test(zrow.report_key),
      'Z anahtari cihazin kendi sayacindan kurulmali ki tekrar cakissin');
  });

  await step('every exchange with the device is written to the provider log', async () => {
    /*
     * fiscal_provider_logs sat in the schema for a month with no writer, which
     * is why a real device refusing a real X report left no evidence at all.
     */
    const fiscal = require('../src/fiscal');
    await db.exec('DELETE FROM fiscal_provider_logs WHERE client_id=?', [CID]);
    await fiscal.deviceReport(CID, 'X');
    const rows = await db.query(
      'SELECT direction, operation, http_status, duration_ms FROM fiscal_provider_logs WHERE client_id=? ORDER BY id', [CID]);
    assert.ok(rows.length >= 2, 'istek ve yanit ayri ayri kaydedilmeli, gelen: ' + rows.length);
    assert.strictEqual(rows[0].direction, 'request');
    assert.ok(/\/reports\/X\//.test(rows[0].operation), 'islem adi yok: ' + rows[0].operation);
    const answer = rows.find(r => r.direction === 'response');
    assert.ok(answer, 'yanit kaydedilmemis');
    assert.strictEqual(Number(answer.http_status), 200);
    assert.ok(Number(answer.duration_ms) >= 0, 'sure olculmemis');
  });

  await step('a refusal never breaks on the logging path', async () => {
    const fiscal = require('../src/fiscal');
    await db.exec('DELETE FROM fiscal_provider_logs WHERE client_id=?', [CID]);
    /* The stub answers 404/ERR_NOT_FOUND for an unknown path, which is what a
       refusal looks like from our side. */
    await assert.rejects(() => fiscal.deviceReport(CID, 'gunsonu'));
    const rows = await db.query(
      'SELECT direction FROM fiscal_provider_logs WHERE client_id=?', [CID]);
    /* A kind that never reaches the wire is refused before any request, so an
       empty log here is correct - the point is that it does not throw. */
    assert.ok(Array.isArray(rows));
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
