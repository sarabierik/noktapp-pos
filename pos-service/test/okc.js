'use strict';
/**
 * ÖKC — the fiscal device, as the device actually behaves.
 *
 * Written against the settings of a real Ingenico MOVE 5000F (YNÖKC) running
 * in a restaurant, because until those photographs arrived this integration was
 * built on assumptions and two of them were wrong in ways that matter:
 *
 *   * the default port was 7500, a number nobody had ever read off a device.
 *     The Ingenico listens on 4520. A till shipped with 7500 could not have
 *     reached the device at all.
 *
 *   * the department was computed from the VAT rate by a table in our code.
 *     It is not ours to compute. A sale line carries a DEPARTMENT, the
 *     department carries a VAT CODE, the VAT code indexes the device's own VAT
 *     table, and all of it lives on the device. Getting it wrong does not break
 *     a screen - it prints the wrong VAT on a legal receipt.
 *
 * What is deliberately NOT tested here is the wire: the framing and command
 * names in adapters/gmp3.js are our design, not GİB's GMP-3 nor Ingenico's ECR
 * document. A test would only prove our invention agrees with itself. What IS
 * tested is that the invention cannot reach a real device by accident.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/okc.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7495';
const assert = require('assert');
const db = require('../src/db');
const fiscal = require('../src/fiscal');
const base = require('../src/fiscal/adapters/base');
const { IngenicoAdapter } = require('../src/fiscal/adapters/brands');
const { bootstrap } = require('../src/index');

const CID = 19;
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - ÖKC (Ingenico MOVE 5000F)\n');

  /* A device row to hang the tables off. Simulator provider, so nothing here
     can put a byte on a wire even if a check is wrong. */
  await db.exec("DELETE FROM fiscal_devices WHERE client_id=? AND serial_number='TEST-OKC-1'", [CID]);
  const deviceId = await db.insert(
    `INSERT INTO fiscal_devices (client_id, provider, device_model, serial_number, connection_type,
        device_ip, device_port, environment, is_active, created_at)
     VALUES (?, 'simulator', 'MOVE 5000F', 'TEST-OKC-1', 'TCP', '192.168.6.117', 4520, 'SIMULATOR', 1, NOW())`,
    [CID]);
  const device = await db.one('SELECT * FROM fiscal_devices WHERE id=?', [deviceId]);

  await step('the device port default is the one the device listens on', async () => {
    const a = new IngenicoAdapter({ device_ip: '192.168.6.117' });
    assert.strictEqual(a.port, 4520, 'Ingenico varsayilan portu 4520 olmali');
  });

  await step("the device's VAT and department tables are seeded on first use", async () => {
    const t = await fiscal.deviceTables(CID, device);
    assert.strictEqual(t.vatCodes.length, 8, 'KDV tablosu 8 satir olmali (kod 0-7)');
    assert.strictEqual(t.departments.length, 12, 'kisim tablosu 12 satir olmali');
    const rate = c => Number(t.vatCodes.find(v => Number(v.vat_code) === c).rate);
    assert.strictEqual(rate(0), 0);
    assert.strictEqual(rate(1), 1);
    assert.strictEqual(rate(2), 10);
    assert.strictEqual(rate(3), 20);
  });

  await step('the department index the device uses is zero-based, the till\'s is one-based', async () => {
    const t = await fiscal.deviceTables(CID, device);
    for (const d of t.departments) {
      assert.strictEqual(Number(d.okc_index), Number(d.erp_index) - 1,
        `kisim ${d.erp_index} icin cihaz indeksi ${d.okc_index}`);
    }
  });

  await step('a line lands in a department whose VAT code carries its own rate', async () => {
    const t = await fiscal.deviceTables(CID, device);
    const check = (rate, wantCode) => {
      const dep = base.resolveDepartment(rate, t);
      assert.strictEqual(Number(dep.vat_code), wantCode,
        `%${rate} icin kisim KDV kodu ${dep.vat_code} geldi, ${wantCode} bekleniyordu`);
      const vat = t.vatCodes.find(v => Number(v.vat_code) === Number(dep.vat_code));
      assert.strictEqual(Number(vat.rate), rate, 'kisim baska bir orana bagli');
    };
    check(0, 0); check(1, 1); check(10, 2); check(20, 3);
  });

  await step('a rate with no department is refused, not quietly taxed at 20%', async () => {
    const t = await fiscal.deviceTables(CID, device);
    /* %8 was abolished in Turkey and no department carries it. The old code
       answered 4 for anything it did not recognise, so an %8 line would have
       been printed at %20 on a legal receipt without a word to anybody. */
    assert.throws(() => base.resolveDepartment(8, t), /kisim yok|KDV/i,
      'tanimsiz oran sessizce bir kisma dusuruldu');
  });

  await step('units map to the four the device knows, and default to Adet', async () => {
    assert.strictEqual(base.unitFor('kg'), 'Kilogram');
    assert.strictEqual(base.unitFor('gram'), 'Gram');
    assert.strictEqual(base.unitFor('lt'), 'Litre');
    assert.strictEqual(base.unitFor('porsiyon'), 'Adet', 'eslesmeyen birim adet olmali');
    assert.strictEqual(base.unitFor(null), 'Adet');
  });

  await step('the payment codes are the ones the device numbers', async () => {
    assert.strictEqual(base.PAYMENT_CODES.CASH, 1);
    assert.strictEqual(base.PAYMENT_CODES.CARD, 4);
    assert.strictEqual(base.PAYMENT_CODES.TRANSFER, 2048);
  });

  /* ------------------------------------------------------------------ */
  /* The gate. This is the check that matters most in this file.         */
  /* ------------------------------------------------------------------ */

  await step('an unverified message layer refuses to drive a real device', async () => {
    const a = new IngenicoAdapter({ ...device, wire_verified: 0, device_ip: '127.0.0.1', device_port: 1 });
    await assert.rejects(
      () => a.startSale({ externalId: '1', items: [], totalMinor: 100, payment: { method: 'nakit', amountMinor: 100 } }),
      (e) => {
        assert.strictEqual(e.code, 'WIRE_UNVERIFIED', 'yanlis hata: ' + e.message);
        assert.strictEqual(e.status, 501);
        /* and it must refuse BEFORE opening a socket - port 1 would give
           ECONNREFUSED, which is what a wire attempt looks like */
        assert.ok(!/ECONNREFUSED|baglanti hatasi/i.test(e.message), 'once sokete gitmis');
        return true;
      });
  });

  await step('a verified device is allowed through to the wire', async () => {
    const a = new IngenicoAdapter({ ...device, wire_verified: 1, device_ip: '127.0.0.1', device_port: 1 });
    await assert.rejects(
      () => a.startSale({ externalId: '1', items: [], totalMinor: 100, payment: { method: 'nakit', amountMinor: 100 } }),
      /baglanti hatasi|yanit vermedi/i,
      'dogrulanmis cihazda gate hala kapali');
  });

  await step('the report and refund paths are behind the same gate', async () => {
    const a = new IngenicoAdapter({ ...device, wire_verified: 0 });
    await assert.rejects(() => a.report('X'), (e) => e.code === 'WIRE_UNVERIFIED');
    await assert.rejects(() => a.refund({ externalId: '1', items: [], totalMinor: 1 }),
      (e) => e.code === 'WIRE_UNVERIFIED');
  });

  /* ------------------------------------------------------------------ */
  /* The device's own limits, refused here rather than by the device      */
  /* halfway through a sale with the guest waiting.                       */
  /* ------------------------------------------------------------------ */

  await step('the receipt limit and the line limit are the device\'s, and are read from it', async () => {
    const d = await db.one('SELECT receipt_limit_minor, max_sale_lines, cashier_no, open_drawer FROM fiscal_devices WHERE id=?',
      [deviceId]);
    assert.strictEqual(Number(d.receipt_limit_minor), 1200000, 'fis limiti 12000,00 olmali');
    assert.strictEqual(Number(d.max_sale_lines), 40, 'satis paket limiti 40 olmali');
    assert.strictEqual(Number(d.cashier_no), 1);
    assert.strictEqual(Number(d.open_drawer), 0, 'varsayilan "Cekmeceyi Acma" olmali');
  });

  await db.exec('DELETE FROM fiscal_departments WHERE fiscal_device_id=?', [deviceId]);
  await db.exec('DELETE FROM fiscal_vat_codes WHERE fiscal_device_id=?', [deviceId]);
  await db.exec('DELETE FROM fiscal_devices WHERE id=?', [deviceId]);

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
