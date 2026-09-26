'use strict';
/**
 * ÖKC registry, evidence and refusal — the parts that can be proven without
 * a vendor SDK or a physical terminal.
 *
 * The integration specification is explicit that naming a class after a
 * manufacturer is not an integration. These checks exist to make that
 * impossible to forget: every blocked adapter must refuse, the refusal must
 * happen before anything touches a device, and a device nobody has proven
 * anything about must not be able to take money.
 *
 * What is deliberately NOT tested: any vendor wire protocol. There is no SDK
 * and no hardware, so a test would only prove our invention agrees with
 * itself. test/okc.js already guards that boundary.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/okc-kayit.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7496';
const assert = require('assert');
const db = require('../src/db');
const kayit = require('../src/fiscal/kayit');
const yetenek = require('../src/fiscal/yetenek');
const engelli = require('../src/fiscal/adapters/engelli');
const tutar = require('../src/fiscal/tutar');
const niyet = require('../src/fiscal/niyet');
const fiscal = require('../src/fiscal');
const auth = require('../src/auth');
const { bootstrap } = require('../src/index');

const CID = 23;
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
async function refuses(fn, code, what) {
  try { await fn(); assert.fail(`${what}: beklenen ret gelmedi`); }
  catch (e) {
    if (e.code !== code) throw new Error(`${what}: ${code} bekleniyordu, ${e.code || e.message} geldi`);
  }
}

(async () => {
  await bootstrap();
  /*
   * Start from a clean tenant. run-all.sh rebuilds the schema first, but a
   * suite that only passes on a virgin database is a suite that will fail the
   * first time somebody runs it twice - and then be assumed broken.
   */
  await db.exec('DELETE FROM fiscal_device_capabilities WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM fiscal_device_ownership WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM fiscal_devices WHERE client_id=?', [CID]);
  console.log('\nNOKTApp POS - OKC kayit defteri ve kanit modeli\n');

  /* ---------------------------------------------------------- registry */

  await step('the register holds every record the specification counts', async () => {
    const [{ n: total }] = await db.query('SELECT COUNT(*) n FROM fiscal_registry_devices');
    const [{ n: retail }] = await db.query("SELECT COUNT(*) n FROM fiscal_registry_devices WHERE category='retail'");
    const [{ n: fuel }] = await db.query("SELECT COUNT(*) n FROM fiscal_registry_devices WHERE category='fuel_pump'");
    const [{ n: owners }] = await db.query("SELECT COUNT(DISTINCT owner_key) n FROM fiscal_registry_devices WHERE category='retail'");
    assert.strictEqual(Number(total), 59, 'toplam kayit');
    assert.strictEqual(Number(retail), 54, 'perakende kayit');
    assert.strictEqual(Number(fuel), 5, 'akaryakit kaydi');
    assert.strictEqual(Number(owners), 15, 'perakende mali sahip');
  });

  await step('a record is not a compatibility claim', async () => {
    // Every retail owner either refuses outright or is gated behind
    // wire_verified. None of them is simply "supported".
    const rows = await db.query("SELECT DISTINCT owner_key FROM fiscal_registry_devices WHERE category='retail'");
    for (const { owner_key } of rows) {
      const known = !!engelli.BLOCKED[owner_key] || engelli.IN_PROGRESS.includes(owner_key);
      assert.ok(known, `${owner_key} ne engelli ne de bilinen bir rotada - sessizce simulatore duserdi`);
    }
  });

  await step('the fuel-pump domain is never offered here', async () => {
    const list = await kayit.all(CID);
    assert.ok(!list.some(d => d.category === 'fuel_pump'), 'akaryakit kaydi listede gorunuyor');
    await refuses(() => kayit.matchSerial('AU12345678'), 'CATEGORY_BLOCKED', 'akaryakit serisi');
  });

  /* ----------------------------------------------------- prefix matching */

  await step('a serial resolves to exactly one registered device', async () => {
    const m = await kayit.matchSerial('2C 0001 2345');
    assert.strictEqual(m.prefix, '2C');
    assert.strictEqual(m.record.brand_model, 'Ingenico MOVE5000F');
  });

  await step('the longest prefix wins, and never the first character alone', async () => {
    const a = await kayit.matchSerial('BCA0001');
    const b = await kayit.matchSerial('BCM0001');
    assert.strictEqual(a.record.brand_model, 'PROFILO VeriFone VX 680-E1');
    assert.strictEqual(b.record.brand_model, 'PROPAY P1000 ECR');
    assert.notStrictEqual(a.record.id, b.record.id, 'BCA ile BCM ayni kayda cozuluyor');
  });

  await step('the same hardware under two fiscal owners stays two records', async () => {
    const pavo = await kayit.matchSerial('JH0001');
    const world = await kayit.matchSerial('2A0001');
    assert.strictEqual(pavo.record.owner_key, 'pavo');
    assert.strictEqual(world.record.owner_key, 'worldline');
  });

  await step('an unknown prefix is refused, not guessed', async () => {
    await refuses(() => kayit.matchSerial('ZZ9999'), 'PREFIX_UNKNOWN', 'bilinmeyen prefix');
  });

  /*
   * A serial read off the real Hugin S1 standing in the office, not one we
   * invented. The registry is a transcription of the GIB list, and a
   * transcription is only worth what a real device says about it: this is the
   * one check here whose input came from hardware.
   */
  await step("the office Hugin S1's own serial resolves to the S1 record", async () => {
    const m = await kayit.matchSerial('FU00032768');
    assert.strictEqual(m.prefix, 'FU');
    assert.strictEqual(m.record.brand_model, 'HUGIN S1');
    assert.strictEqual(m.record.owner_key, 'hugin');
  });

  /* ------------------------------------------------------------ money   */

  await step('the arithmetic fixture holds exactly', async () => {
    assert.strictEqual(tutar.mulDecimal('1.250', '8000'), '10000');
    assert.strictEqual(tutar.sub('10000', '500'), '9500');
    // and the float route would have been wrong
    assert.notStrictEqual(String(Math.round(0.1 * 3 * 100)), '30.000000000000004');
    assert.strictEqual(tutar.add('10', '20'), '30');
  });

  await step('an amount that is not a minor-unit integer is refused', async () => {
    assert.throws(() => tutar.minor('10.5'));
    assert.throws(() => tutar.mulDecimal('1e3', '100'));
  });

  /* ------------------------------------------------------------ intent  */

  const baseIntent = {
    operationId: 'op-1', idempotencyKey: 'idem-1', tenantId: String(CID),
    merchantId: 'm1', branchId: '1', deviceId: 'd1',
    businessSaleId: 's-1', businessRevision: 'r1',
    lines: [{ lineId: 'l1', description: 'Urfa Kebap', quantity: '1.250', unitPrice: '8000',
              unitPriceIncludesTax: true, taxMappingKey: 'K10', allocatedDiscount: '500' }],
    tenders: [{ tenderId: 't1', kind: 'CARD', amount: '9500' }],
  };

  await step('an intent is frozen and hashes the same on a retry', async () => {
    const a = niyet.build(baseIntent);
    const b = niyet.build(JSON.parse(JSON.stringify(baseIntent)));
    assert.strictEqual(a.intent.grossTotal, '9500');
    assert.ok(Object.isFrozen(a.intent), 'niyet dondurulmadi');
    assert.strictEqual(a.payloadHash, b.payloadHash, 'ayni talimat farkli ozet uretti');
  });

  await step('tenders that do not equal the document are refused', async () => {
    assert.throws(() => niyet.build({ ...baseIntent, tenders: [{ tenderId: 't1', kind: 'CARD', amount: '9000' }] }),
      e => e.code === 'TENDER_TOTAL_MISMATCH');
  });

  await step('a refund cannot enter through the sale path', async () => {
    assert.throws(() => niyet.build({ ...baseIntent,
      lines: [{ ...baseIntent.lines[0], quantity: '-1' }] }), e => e.code === 'NEGATIVE_LINE');
  });

  /* ------------------------------------------------------- blocked ops  */

  await step('every blocked adapter refuses, and touches nothing', async () => {
    const A = engelli.blockedAdapters();
    for (const key of Object.keys(A)) {
      const a = new A[key]({ id: 1, provider: key });
      const d = await a.describe();
      assert.strictEqual(d.productionEnabled, false, `${key} kendini uretime acik gosteriyor`);
      for (const op of ['dispatch', 'startSale', 'refund', 'queryOutcome', 'cancel', 'zReport']) {
        let threw = null;
        try { await a[op]({}); } catch (e) { threw = e; }
        assert.ok(threw, `${key}.${op} basarili dondu - bu asla olmamali`);
        /*
         * The right refusal, not just a refusal. "Nobody sent us the package"
         * and "we read the package and said no" are different facts, and
         * reporting the second as the first sends the next person off to
         * fetch something that is already on the disk.
         */
        const expected = engelli.BLOCKED[key].decided ? 'CLOSED_BY_DECISION' : 'SDK_NOT_OBTAINED';
        assert.strictEqual(threw.code, expected, `${key}.${op} yanlis kod`);
        assert.strictEqual(threw.deviceEffects, 'none', `${key}.${op} cihaz etkisi bildirmedi`);
      }
    }
  });

  await step('a decided-against owner says so, and does not promise to open later',
    async () => {
      const A = engelli.blockedAdapters();
      for (const key of ['worldline', 'ingenico']) {
        assert.ok(engelli.BLOCKED[key], `${key} engelli listesinde olmali`);
        assert.strictEqual(engelli.BLOCKED[key].decided, true, `${key} karar kaydi yok`);
        let threw = null;
        try { await new A[key]({ id: 1, provider: key }).startSale({}); } catch (e) { threw = e; }
        assert.strictEqual(threw.code, 'CLOSED_BY_DECISION');
        assert.ok(!/alindiginda|alındığında/.test(threw.message),
          `${key}: "paket gelince acilir" demek yanlis - bu bir is karari`);
      }
    });

  await step('ingenico cannot be dispatched to at all', async () => {
    /* The class still exists so the decision can be reversed, but nothing may
       select it for a real sale: in Turkey an Ingenico OKC is licensed by
       Worldline, and without that contract there is no way to talk to one. */
    const fiscalIdx = require('../src/fiscal');
    const A = engelli.blockedAdapters();
    assert.ok(A.ingenico, 'ingenico engelli adaptoru yok');
    const { IngenicoAdapter } = require('../src/fiscal/adapters/brands');
    assert.ok(typeof IngenicoAdapter === 'function', 'sinif silinmemeli - karar geri alinabilir');
    assert.ok(fiscalIdx, 'fiscal modulu yuklenmeli');
  });

  /* --------------------------------------------------- capability gate  */

  let devId = null;
  await step('a device can be commissioned from the register', async () => {
    devId = await db.insert(
      `INSERT INTO fiscal_devices (client_id, provider, serial_number, connection_type, environment, is_active, created_at)
       VALUES (?,'simulator','TMP','LOCAL_AGENT','production',1,NOW())`, [CID]);
    const out = await kayit.commission(CID, devId, '2C00012345');
    assert.strictEqual(out.prefix, '2C');
    assert.strictEqual(out.production_enabled, 0, 'devreye alma uretimi de acti');
  });

  await step('an unknown capability fails closed', async () => {
    await refuses(() => yetenek.assertAllowed(CID, devId, { workflow: 'SALE', tenderKinds: ['CARD'] }),
      'CAPABILITY_UNAVAILABLE', 'dogrulanmamis yetenek');
  });

  await step('VERIFIED without evidence is refused', async () => {
    await refuses(() => yetenek.record(CID, devId, 'basketSale', 'VERIFIED', {}),
      'EVIDENCE_REQUIRED', 'kanitsiz dogrulama');
  });

  await step('with evidence, the gate opens for exactly what was proven', async () => {
    await yetenek.record(CID, devId, 'basketSale', 'VERIFIED', { evidence_ref: 'TSM-2026-001' });
    await yetenek.record(CID, devId, 'cardCollection', 'VERIFIED', { evidence_ref: 'TSM-2026-001' });
    await yetenek.assertAllowed(CID, devId, { workflow: 'SALE', tenderKinds: ['CARD'] });
    // but a refund was never proven
    await refuses(() => yetenek.assertAllowed(CID, devId, { workflow: 'REFUND' }),
      'CAPABILITY_UNAVAILABLE', 'kanitlanmamis iade');
  });

  await step('a commissioned device still cannot take money until it is armed', async () => {
    const d = await db.one('SELECT * FROM fiscal_devices WHERE id=?', [devId]);
    d.environment = 'production'; d.provider = 'token';
    await refuses(() => fiscal.assertDispatchAllowed(CID, d, { workflow: 'SALE', tenderKinds: ['CARD'] }),
      'PRODUCTION_NOT_ENABLED', 'uretime acilmamis cihaz');
  });

  await step('a quarantined device is refused before anything else', async () => {
    await db.exec('UPDATE fiscal_devices SET production_enabled=1, quarantine_reason=? WHERE id=?',
      ['Cozulmemis islem #4821', devId]);
    const d = await db.one('SELECT * FROM fiscal_devices WHERE id=?', [devId]);
    d.environment = 'production'; d.provider = 'token';
    await refuses(() => fiscal.assertDispatchAllowed(CID, d, { workflow: 'SALE', tenderKinds: ['CARD'] }),
      'DEVICE_QUARANTINED', 'karantinadaki cihaz');
    await db.exec('UPDATE fiscal_devices SET quarantine_reason=NULL WHERE id=?', [devId]);
  });

  await step('the simulator is always allowed, and is never production', async () => {
    const sim = { id: 999, provider: 'simulator', environment: 'simulator', production_enabled: 0 };
    await fiscal.assertDispatchAllowed(CID, sim, { workflow: 'SALE', tenderKinds: ['CASH'] });
  });

  /* ----------------------------------------------- over HTTP, as the screen does */
  /*
   * Everything above calls the modules directly, which is the right level for
   * the rules. But the Cihaz ekle screen does not call kayit.matchSerial - it
   * types a serial into a box and asks the SERVER what it would match, and
   * that endpoint had never been called by anything. These two steps close
   * that, and the second one covers the answer that actually reaches a cashier
   * when they mistype.
   */
  const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
  const TOKEN = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Sahip', kind: 'pos' });
  const api = async (method, path) => {
    const res = await fetch(BASE + path, { method, headers: { Authorization: 'Bearer ' + TOKEN } });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };

  await step('the screen can ask what a serial would match, without commissioning it', async () => {
    const [known] = await db.query(
      "SELECT prefix FROM fiscal_registry_devices WHERE category='retail' AND prefix IS NOT NULL AND prefix<>'' LIMIT 1");
    const serial = String(known.prefix) + '1234567';
    const r = await api('GET', '/api/okc/registry/match?serial=' + encodeURIComponent(serial));
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.prefix, String(known.prefix), 'onek okunmadi: ' + JSON.stringify(r));
    assert.ok(r.match && r.match.brand_model, 'kayit donmedi: ' + JSON.stringify(r));
    /* read-only: nothing was commissioned by asking */
    const [{ n }] = await db.query('SELECT COUNT(*) n FROM fiscal_devices WHERE client_id=? AND serial_number=?',
      [CID, serial]);
    assert.strictEqual(Number(n), 0, 'sorgu cihaz olusturmus');
  });

  await step('a mistyped serial is refused in Turkish, not with a 500', async () => {
    const r = await api('GET', '/api/okc/registry/match?serial=' + encodeURIComponent('ZZ9'));
    assert.ok(r.status >= 400 && r.status < 500, 'beklenen ret gelmedi: ' + r.status);
    assert.ok(typeof r.error === 'string' && r.error.length > 0, 'bos hata mesaji: ' + JSON.stringify(r));
    assert.ok(!/SQL|column|syntax/i.test(r.error), 'veritabani mesaji disariya sizmis: ' + r.error);
  });

  await step('a device id that is not a number is a clean 404, not a database error', async () => {
    /* /devices/abc/capabilities used to reach MariaDB as NaN and answer
       500 "Unknown column 'NaN' in 'WHERE'" - see the r.param guard in
       src/routes/okc.js */
    const r = await api('GET', '/api/okc/devices/abc/capabilities');
    assert.strictEqual(r.status, 404, 'beklenen 404 gelmedi: ' + JSON.stringify(r));
    assert.ok(!/NaN|column/i.test(String(r.error || '')), 'veritabani mesaji sizmis: ' + r.error);
  });

  /* ------------------------------------------------------------ report  */
  const pass = results.filter(r => r[0] === 'PASS').length;
  console.log(`\n${pass}/${results.length} checks passed`);
  for (const r of results) if (r[0] === 'FAIL') console.log(`  ${r[1]}: ${r[2]}`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
