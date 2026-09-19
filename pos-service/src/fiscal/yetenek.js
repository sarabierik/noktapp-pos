'use strict';
/**
 * Capability profiles — what this exact configuration has been PROVEN to do.
 *
 * A manufacturer-wide boolean like supportsRefunds = true is too broad to be
 * useful and too broad to be safe. A capability belongs to the combination of
 * fiscal owner, model, firmware, integration application, SDK version,
 * transport and bank application. Change the firmware and the evidence is
 * about a device that no longer exists.
 *
 * THREE STATES, AND THE MIDDLE ONE IS THE POINT.
 *
 *   VERIFIED     tested on this configuration, with evidence on file
 *   UNSUPPORTED  the vendor contract or a verified limitation says no
 *   UNKNOWN      nobody has established either
 *
 * UNKNOWN FAILS CLOSED for anything that moves money or issues a document. It
 * is not "probably fine" and it is not "try it and see" — trying it and seeing
 * is how a restaurant ends up with a tax document it cannot explain. UNKNOWN
 * stays visible in the admin screen as awaiting vendor confirmation.
 *
 * UNSUPPORTED means a contract or a test said no. It does not mean a web
 * search came up empty.
 */
const db = require('../db');

/** §7.3 — every capability is a question that has to be answered. */
const CAPABILITIES = {
  basketSale:         'Bu yapilandirma amaclanan mali satisi kesebiliyor mu?',
  cashCollection:     'Nakit bu belge akisinda temsil edilebiliyor mu?',
  cardCollection:     'Adaptor saglanan banka uygulamasini cagirabiliyor mu?',
  mixedTender:        'Hangi siralar, odeme turleri ve azami adet destekleniyor?',
  mealCard:           'Hangi yemek karti uygulamasi ve hangi sepet kurallari?',
  advanceCollection:  'Avans tahsilatini hangi belge temsil ediyor?',
  invoiceCollection:  'Mevcut fatura ikinci bir satis olmadan nasil baglaniyor?',
  refundAndVoid:      'Hangi bagimsiz banka ve mali islemler gerekiyor?',
  preauthorization:   'Hem API hem uye isyeri kurulumunda acikca destekleniyor mu?',
  queryOutcome:       'Kesilen bir islemi hangi kimlik guvenilir sekilde cozuyor?',
  resumeDocument:     'Hangi ara durumlar yeniden toplamadan surdurulebilir?',
  reprint:            'Var olan belge yeni satis olmadan kopyalanabiliyor mu?',
  xReportZReport:     'Rapor okuma, rapor URETEN islemden ayri mi?',
  eDocumentIssue:     'Hangi yetkili model, servis ve belge gecerli?',
  offlineOperation:   'Hangi yerel, banka, mali ve senkron sartlari buna izin veriyor?',
};
const CAPABILITY_KEYS = Object.keys(CAPABILITIES);

/** Financial execution requires these to be VERIFIED, per workflow. */
const REQUIRED_FOR = {
  SALE:                ['basketSale'],
  ADVANCE_COLLECTION:  ['basketSale', 'advanceCollection'],
  INVOICE_COLLECTION:  ['basketSale', 'invoiceCollection'],
  REFUND:              ['refundAndVoid'],
};
const TENDER_CAPABILITY = {
  CASH: 'cashCollection', CARD: 'cardCollection',
  MEAL_CARD: 'mealCard', BANK_TRANSFER: 'cashCollection',
};

async function profile(clientId, deviceId) {
  const rows = await db.query(
    `SELECT capability, state, evidence_ref, tested_at, config_fingerprint,
            limits_json, operator_requirements
       FROM fiscal_device_capabilities WHERE client_id=? AND fiscal_device_id=?`,
    [clientId, deviceId]);
  const byKey = new Map(rows.map(r => [r.capability, r]));
  // Every known capability is reported, so the screen shows the unanswered
  // questions rather than silently omitting them.
  return CAPABILITY_KEYS.map(k => {
    const r = byKey.get(k);
    return {
      capability: k,
      question: CAPABILITIES[k],
      state: r ? r.state : 'UNKNOWN',
      evidence_ref: r ? r.evidence_ref : null,
      tested_at: r ? r.tested_at : null,
      config_fingerprint: r ? r.config_fingerprint : null,
      limits: r && r.limits_json ? JSON.parse(r.limits_json) : null,
      operator_requirements: r ? r.operator_requirements : null,
    };
  });
}

async function stateOf(clientId, deviceId, capability) {
  const r = await db.one(
    `SELECT state FROM fiscal_device_capabilities
      WHERE client_id=? AND fiscal_device_id=? AND capability=?`,
    [clientId, deviceId, capability]);
  return r ? r.state : 'UNKNOWN';
}

/**
 * The gate every financial dispatch passes through.
 *
 * Returns nothing on success. Throws CAPABILITY_UNAVAILABLE with the exact
 * missing capability and its state — never a generic "not supported".
 */
async function assertAllowed(clientId, deviceId, { workflow = 'SALE', tenderKinds = [] } = {}) {
  const needed = new Set(REQUIRED_FOR[workflow] || REQUIRED_FOR.SALE);
  for (const k of tenderKinds) {
    const cap = TENDER_CAPABILITY[k];
    if (cap) needed.add(cap);
  }
  if (tenderKinds.length > 1) needed.add('mixedTender');

  const missing = [];
  for (const cap of needed) {
    const st = await stateOf(clientId, deviceId, cap);
    if (st !== 'VERIFIED') missing.push({ capability: cap, state: st, question: CAPABILITIES[cap] });
  }
  if (missing.length) {
    const e = new Error(
      'Bu cihaz icin gerekli yetenek dogrulanmadi: ' +
      missing.map(m => `${m.capability} (${m.state})`).join(', '));
    e.status = 409; e.code = 'CAPABILITY_UNAVAILABLE'; e.missing = missing;
    throw e;
  }
}

/**
 * Record what a test or a vendor letter established.
 *
 * Setting VERIFIED without an evidence_ref is refused: a capability with no
 * evidence behind it is indistinguishable from a guess, and six months from
 * now nobody will remember which it was.
 */
async function record(clientId, deviceId, capability, state, opts = {}) {
  if (!CAPABILITY_KEYS.includes(capability)) {
    const e = new Error(`Bilinmeyen yetenek: ${capability}`); e.status = 400; throw e;
  }
  if (!['VERIFIED', 'UNSUPPORTED', 'UNKNOWN'].includes(state)) {
    const e = new Error(`Bilinmeyen durum: ${state}`); e.status = 400; throw e;
  }
  if (state === 'VERIFIED' && !opts.evidence_ref) {
    const e = new Error('VERIFIED icin kanit referansi zorunlu (sozlesme, test raporu, uretici yazisi).');
    e.status = 400; e.code = 'EVIDENCE_REQUIRED'; throw e;
  }
  await db.exec(
    `INSERT INTO fiscal_device_capabilities
       (client_id, fiscal_device_id, capability, state, evidence_ref, tested_at,
        config_fingerprint, limits_json, operator_requirements)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE state=VALUES(state), evidence_ref=VALUES(evidence_ref),
       tested_at=VALUES(tested_at), config_fingerprint=VALUES(config_fingerprint),
       limits_json=VALUES(limits_json), operator_requirements=VALUES(operator_requirements)`,
    [clientId, deviceId, capability, state, opts.evidence_ref || null,
     opts.tested_at || (state === 'VERIFIED' ? new Date() : null),
     opts.config_fingerprint || null,
     opts.limits ? JSON.stringify(opts.limits) : null,
     opts.operator_requirements || null]);
  return { capability, state };
}

module.exports = {
  CAPABILITIES, CAPABILITY_KEYS, REQUIRED_FOR, TENDER_CAPABILITY,
  profile, stateOf, assertAllowed, record,
};
