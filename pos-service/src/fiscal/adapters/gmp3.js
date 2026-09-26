'use strict';
/**
 * GMP-3 client — TRANSPORT PROVEN, MESSAGE LAYER NOT.
 *
 * Read this before pointing it at a real device.
 *
 * WHAT IS TRUE. Yeni Nesil ÖKC devices in Turkey are driven over a local
 * socket, and the Ingenico MOVE 5000F in the reference restaurant is configured
 * exactly that way: `Bağlantı Tipi = TCP/IP`, `IP No 192.168.6.117`,
 * `Port No 4520` (serial is the alternative on the same screen). The
 * configuration model around it - VAT code table, department table pushed to
 * the device, payment codes, unit names, receipt and line limits - is read off
 * a working installation and is in adapters/base.js and the fiscal_* tables.
 *
 * WHAT IS NOT TRUE, AND MUST NOT BE MISTAKEN FOR TRUE. The framing below
 * (4-byte big-endian length + JSON) and every command name in this file -
 * CONNECT, START_SALE, GET_SALE_STATE, CANCEL_SALE, REFUND, Z_REPORT - are MY
 * DESIGN. They were written to a plausible shape, not to GİB's GMP-3
 * specification or to Ingenico's ECR integration document, neither of which I
 * have seen. The real protocol's framing, command set, field names and error
 * codes will differ.
 *
 * WHY THAT MATTERS MORE HERE THAN ANYWHERE ELSE IN THIS PRODUCT. An ÖKC prints
 * a legal fiscal receipt. A wrong message does not produce a broken screen, it
 * produces a wrong tax document in a restaurant that is legally answerable for
 * it. So this adapter refuses to drive a device that has not been marked
 * verified (fiscal_devices.wire_verified), and the simulator stays the default.
 *
 * TO MAKE IT REAL: get the ECR/GMP-3 integration document for the device's
 * ECRAPP build from the manufacturer or the TSM provider, correct the framing
 * and the command table here, prove it against the device, and only then set
 * wire_verified = 1. Nothing else in the product needs to change.
 */
const net = require('net');
const { FiscalAdapter } = require('./base');

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

class Gmp3Adapter extends FiscalAdapter {
  constructor(device, options = {}) {
    super(device, options);
    this.host = device.device_ip || '127.0.0.1';
    this.port = Number(device.device_port || options.defaultPort || 7500);
    this.timeout = Number(options.timeout || 60000);
    this.fieldMap = Object.assign({
      command: 'command', payload: 'data', sessionId: 'sessionId',
      state: 'state', receiptNo: 'receiptNo', zNo: 'zNo', ekuSerial: 'ekuSerial',
      fiscalId: 'fiscalId', approvalCode: 'approvalCode', errorCode: 'errorCode',
      errorMessage: 'errorMessage',
    }, options.fieldMap || {});
  }
  get name() { return 'gmp3'; }

  /** One request / one response, on a fresh socket - the devices prefer it. */
  request(command, data = {}, timeoutMs = null) {
    const F = this.fieldMap;
    const msg = { [F.command]: command, [F.payload]: data, ts: Date.now() };
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      let head = null, buf = Buffer.alloc(0), done = false;
      const finish = (err, val) => {
        if (done) return; done = true;
        try { sock.destroy(); } catch (_) {}
        err ? reject(err) : resolve(val);
      };
      sock.setTimeout(timeoutMs || this.timeout);
      sock.on('timeout', () => finish(new Error('OKC cihazi yanit vermedi')));
      sock.on('error', e => finish(new Error('OKC baglanti hatasi: ' + e.message)));
      sock.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        if (head === null && buf.length >= 4) { head = buf.readUInt32BE(0); buf = buf.slice(4); }
        if (head !== null && buf.length >= head) {
          try { finish(null, JSON.parse(buf.slice(0, head).toString('utf8'))); }
          catch (e) { finish(new Error('OKC gecersiz yanit')); }
        }
      });
      sock.connect(this.port, this.host, () => sock.write(frame(msg)));
    });
  }

  /**
   * The gate. Every method that would put a message on the wire to a real
   * device goes through here first.
   */
  assertVerified(what) {
    if (this.device.wire_verified) return;
    const e = new Error(
      'Bu OKC icin mesaj katmani henuz uretici dokumaniyla dogrulanmadi, '
      + `bu yuzden ${what} gercek cihaza gonderilmiyor. Simulatorde calisin, `
      + 'dogrulandiktan sonra Ayarlar > OKC ekranindan cihazi dogrulanmis isaretleyin.');
    e.status = 501;
    e.code = 'WIRE_UNVERIFIED';
    throw e;
  }

  async connect() {
    const r = await this.request('CONNECT', {
      appName: 'NOKTApp POS', appVersion: process.env.NOKTAPP_VERSION || '2.0.0',
      merchantId: this.device.merchant_id || undefined,
      terminalId: this.device.terminal_id || undefined,
    }, 15000);
    return { ok: true, device: r };
  }

  async status() {
    const r = await this.request('GET_STATUS', {}, 10000);
    const s = String(r[this.fieldMap.state] || r.status || '').toLowerCase();
    let state = 'ready';
    if (s.includes('busy') || s.includes('mesgul')) state = 'busy';
    else if (s.includes('z') && s.includes('need')) state = 'z_needed';
    else if (s.includes('error') || s.includes('hata')) state = 'error';
    return { state, raw: r };
  }

  buildSalePayload(sale) {
    return {
      externalId: sale.externalId,
      documentType: 'SALE',
      items: sale.items.map(i => ({
        name: String(i.name).slice(0, 40),
        quantity: Number(i.qty),
        unitPrice: Number(i.unitPriceMinor),
        vatRate: Number(i.vatRate),
        /* resolved from the DEVICE's department table, not from the rate */
        department: Number(i.department),
        unit: i.unit,
        total: Math.round(Number(i.qty) * Number(i.unitPriceMinor)),
      })),
      discount: Number(sale.discountMinor || 0),
      total: Number(sale.totalMinor),
      payment: {
        type: sale.payment.method === 'nakit' ? 'CASH' : 'CREDIT',
        amount: Number(sale.payment.amountMinor),
        installments: Number(sale.payment.installments || 0),
      },
      customer: sale.customer || undefined,
    };
  }

  async startSale(sale) {
    this.assertVerified('satis');
    const r = await this.request('START_SALE', this.buildSalePayload(sale), 20000);
    const F = this.fieldMap;
    if (r[F.errorCode]) {
      const e = new Error(r[F.errorMessage] || 'OKC satis baslatilamadi');
      e.code = r[F.errorCode]; throw e;
    }
    return { providerSessionId: r[F.sessionId] || sale.externalId, state: 'waiting_device', raw: r };
  }

  async pollSale(sessionId) {
    const F = this.fieldMap;
    const r = await this.request('GET_SALE_STATE', { [F.sessionId]: sessionId }, 15000);
    const s = String(r[F.state] || '').toUpperCase();
    let state = 'waiting_device';
    if (['APPROVED', 'COMPLETED', 'SUCCESS', 'OK'].includes(s)) state = 'approved';
    else if (['DECLINED', 'REJECTED', 'FAILED'].includes(s)) state = 'declined';
    else if (['CANCELLED', 'CANCELED', 'ABORTED'].includes(s)) state = 'cancelled';
    else if (['ERROR'].includes(s)) state = 'error';
    const out = { state, raw: r };
    if (state === 'approved') {
      out.receipt = {
        fiscalReceiptNo: r[F.receiptNo] || null,
        zNumber: r[F.zNo] || null,
        ekhSerial: r[F.ekuSerial] || this.device.serial_number || null,
        fiscalReference: r[F.fiscalId] || null,
        approvalCode: r[F.approvalCode] || null,
        cardBrand: r.cardBrand || null,
        cardMasked: r.maskedPan || r.cardMasked || null,
        bank: r.bankName || r.bank || null,
        batchNo: r.batchNo || null,
        stan: r.stan || null,
        installments: r.installments || 0,
      };
    }
    if (state === 'declined' || state === 'error') {
      out.error = { code: r[F.errorCode] || s, message: r[F.errorMessage] || 'Islem reddedildi' };
    }
    return out;
  }

  async cancelSale(sessionId) {
    const r = await this.request('CANCEL_SALE', { [this.fieldMap.sessionId]: sessionId }, 15000);
    return { ok: true, raw: r };
  }

  /* GMP-3 states 40 lines per receipt. This is where that number belongs -
     it is Ingenico's, not every ÖKC's. */
  get maxSaleLines() { return 40; }

  async refund(refund) {
    this.assertVerified('iade');
    const r = await this.request('REFUND', {
      externalId: refund.externalId,
      originalReceiptNo: refund.originalReceiptNo,
      originalZNo: refund.originalZNo,
      items: (refund.items || []).map(i => ({
        name: i.name, quantity: i.qty, unitPrice: Number(i.unitPriceMinor),
        vatRate: i.vatRate, department: Number(i.department),
      })),
      total: refund.totalMinor,
    }, 30000);
    const F = this.fieldMap;
    if (r[F.errorCode]) { const e = new Error(r[F.errorMessage] || 'Iade reddedildi'); e.code = r[F.errorCode]; throw e; }
    return { ok: true, receiptNo: r[F.receiptNo], raw: r };
  }

  async report(kind) {
    this.assertVerified('rapor');
    const r = await this.request(kind === 'Z' ? 'Z_REPORT' : 'X_REPORT', {}, 120000);
    return { ok: true, raw: r };
  }
}

module.exports = { Gmp3Adapter, frame };
