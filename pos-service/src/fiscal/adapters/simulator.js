'use strict';
/**
 * Software ÖKC. Behaves exactly like a real device (same states, same delays,
 * same receipt fields) but prints nothing and touches no hardware, so the whole
 * fiscal flow can be trained on, demoed and tested without risking a live
 * device. This is what a new installation starts on.
 */
const { FiscalAdapter } = require('./base');

const sessions = new Map();

class SimulatorAdapter extends FiscalAdapter {
  get name() { return 'simulator'; }
  async connect() { return { ok: true, device: { model: 'NOKTApp Sanal OKC', serial: 'SIM-0001' } }; }
  async status() { return { state: 'ready', raw: { simulator: true } }; }

  async startSale(sale) {
    const id = 'SIM' + Date.now();
    const declines = String(sale.externalId || '').endsWith('9'); // easy way to test a refusal
    sessions.set(id, { at: Date.now(), sale, declines });
    return { providerSessionId: id, state: 'waiting_device' };
  }

  async pollSale(id) {
    const s = sessions.get(id);
    if (!s) return { state: 'error', error: { code: 'NO_SESSION', message: 'Oturum bulunamadi' } };
    if (Date.now() - s.at < 1500) return { state: 'waiting_device' };
    sessions.delete(id);
    if (s.declines) return { state: 'declined', error: { code: '51', message: 'Yetersiz bakiye (simulasyon)' } };
    const n = Math.floor(Math.random() * 9000) + 1000;
    return {
      state: 'approved',
      receipt: {
        fiscalReceiptNo: String(n),
        zNumber: String(new Date().getDate()),
        ekhSerial: 'SIM-0001',
        fiscalReference: 'SIMFIS' + n,
        approvalCode: String(100000 + n),
        cardBrand: s.sale.payment.method === 'nakit' ? null : 'VISA',
        cardMasked: s.sale.payment.method === 'nakit' ? null : '4242********4242',
        bank: s.sale.payment.method === 'nakit' ? null : 'Simulasyon Bank',
        batchNo: '1', stan: String(n), installments: 0,
      },
    };
  }

  async cancelSale(id) { sessions.delete(id); return { ok: true }; }
  async refund(r) { return { ok: true, receiptNo: 'SIMIADE' + Date.now() }; }
  async report(kind) { return { ok: true, raw: { kind, simulator: true } }; }
}

module.exports = { SimulatorAdapter };
