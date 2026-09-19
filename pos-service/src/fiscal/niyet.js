'use strict';
/**
 * The fiscal intent: what we are asking the device to do, frozen.
 *
 * The browser's copy of the basket is not authoritative. Neither is its idea
 * of the merchant, the tax map, the permissions or the total. This module
 * takes the product's own current sale, recomputes the amounts under the
 * approved price policy, and freezes the result into an immutable snapshot
 * with a hash. Everything after this point refers to the snapshot, not to a
 * table that a waiter may still be editing.
 *
 * REFUNDS ARE NOT NEGATIVE LINES. A refund is a separate workflow with its own
 * capability check and its own authorization. Accepting a negative sale line
 * here would let a cashier issue money back through the sale path, which no
 * vendor contract covers and no audit would accept.
 */
const crypto = require('crypto');
const t = require('./tutar');

const TENDER_KINDS = ['CASH', 'CARD', 'MEAL_CARD', 'BANK_TRANSFER'];
const WORKFLOWS = ['SALE', 'ADVANCE_COLLECTION', 'INVOICE_COLLECTION', 'REFUND'];

function bad(msg, code = 'INTENT_INVALID') {
  const e = new Error(msg); e.status = 400; e.code = code; return e;
}

/**
 * Canonical JSON: keys sorted at every level, so two structurally identical
 * intents hash the same regardless of how they were built. The hash is what
 * decides whether a repeated idempotency key is a retry or a conflict.
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
/**
 * The payload hash covers the FINANCIAL INSTRUCTION, not the moment it was
 * serialized.
 *
 * createdAt is deliberately excluded. A cashier whose first request times out
 * and retries one second later is sending the same instruction; if the clock
 * were inside the hash, that retry would look like a different payload under
 * the same idempotency key and be refused with 409 — which is precisely the
 * situation the idempotency key exists to survive. Two genuinely different
 * baskets differ in lines or tenders, and those are hashed.
 */
const UNHASHED = new Set(['createdAt']);
function hash(intent) {
  const financial = {};
  for (const k of Object.keys(intent)) if (!UNHASHED.has(k)) financial[k] = intent[k];
  return crypto.createHash('sha256').update(canonical(financial)).digest('hex');
}

function validateLine(line, i) {
  const where = `lines[${i}]`;
  if (!line || typeof line !== 'object') throw bad(`${where}: satir nesnesi bekleniyor`);
  if (!line.lineId) throw bad(`${where}.lineId zorunlu`);
  if (!t.isDecimal(line.quantity)) throw bad(`${where}.quantity ondalik metin olmali`);
  if (line.quantity.startsWith('-')) throw bad(`${where}.quantity negatif olamaz. Iade ayri bir is akisidir.`, 'NEGATIVE_LINE');
  if (t.minor(t.mulDecimal(line.quantity, '1')) === BigInt(0) && Number(line.quantity) === 0) {
    throw bad(`${where}.quantity sifir olamaz`);
  }
  if (!t.isMinor(line.unitPrice)) throw bad(`${where}.unitPrice minor birim metin olmali`);
  if (t.isNegative(line.unitPrice)) throw bad(`${where}.unitPrice negatif olamaz`, 'NEGATIVE_LINE');
  if (typeof line.unitPriceIncludesTax !== 'boolean') throw bad(`${where}.unitPriceIncludesTax boolean olmali`);
  if (!line.taxMappingKey) throw bad(`${where}.taxMappingKey zorunlu - cihazin onayli vergi haritasina cozulur`);
  if (!line.description || String(line.description).length > 190) {
    throw bad(`${where}.description zorunlu ve en fazla 190 karakter`);
  }

  const gross = t.mulDecimal(line.quantity, line.unitPrice, where);
  const discount = line.allocatedDiscount || '0';
  if (!t.isMinor(discount) || t.isNegative(discount)) throw bad(`${where}.allocatedDiscount negatif olamaz`);
  if (t.cmp(discount, gross) > 0) throw bad(`${where}: indirim satir tutarini asiyor`, 'DISCOUNT_EXCEEDS_LINE');
  const payable = t.sub(gross, discount);

  // Declared totals, if the caller sent them, must agree exactly. A device
  // rejecting a basket for a one-kuruş disagreement is a support call; finding
  // it here is a bug report.
  if (line.grossBeforeDiscount && t.cmp(line.grossBeforeDiscount, gross) !== 0) {
    throw bad(`${where}.grossBeforeDiscount ${line.grossBeforeDiscount} beklenen ${gross}`, 'LINE_TOTAL_MISMATCH');
  }
  if (line.grossPayable && t.cmp(line.grossPayable, payable) !== 0) {
    throw bad(`${where}.grossPayable ${line.grossPayable} beklenen ${payable}`, 'LINE_TOTAL_MISMATCH');
  }
  return { ...line, grossBeforeDiscount: gross, allocatedDiscount: discount, grossPayable: payable };
}

function validateTender(tender, i) {
  const where = `tenders[${i}]`;
  if (!tender || typeof tender !== 'object') throw bad(`${where}: nesne bekleniyor`);
  if (!tender.tenderId) throw bad(`${where}.tenderId zorunlu`);
  if (!TENDER_KINDS.includes(tender.kind)) {
    throw bad(`${where}.kind gecersiz: ${tender.kind}. Izin verilen: ${TENDER_KINDS.join(', ')}`);
  }
  if (!tender.amount || !t.isMinor(tender.amount)) throw bad(`${where}.amount minor birim metin olmali`);
  if (t.isNegative(tender.amount) || t.isZero(tender.amount)) {
    throw bad(`${where}.amount sifirdan buyuk olmali`, 'NONPOSITIVE_TENDER');
  }
  return { ...tender };
}

/**
 * Build and freeze. Returns { intent, payloadHash }.
 *
 * `intent` is deep-frozen so that a later stage cannot quietly adjust a total
 * between validation and dispatch.
 */
function build(input) {
  const i = input || {};
  if (!WORKFLOWS.includes(i.workflow || 'SALE')) throw bad(`Bilinmeyen is akisi: ${i.workflow}`);
  t.assertCurrency(i.currency || t.CURRENCY);

  for (const f of ['operationId', 'idempotencyKey', 'tenantId', 'merchantId', 'branchId', 'deviceId',
                   'businessSaleId', 'businessRevision']) {
    if (!i[f]) throw bad(`${f} zorunlu`);
  }
  if (!Array.isArray(i.lines) || !i.lines.length) throw bad('lines bos olamaz');
  if (!Array.isArray(i.tenders) || !i.tenders.length) throw bad('tenders bos olamaz');
  if (i.lines.length > 500) throw bad('Tek belgede 500 satirdan fazla olamaz', 'TOO_MANY_LINES');

  const lines = i.lines.map(validateLine);
  const tenders = i.tenders.map(validateTender);

  const linesTotal = t.add(...lines.map(l => l.grossPayable));
  const tenderTotal = t.add(...tenders.map(x => x.amount));
  if (i.grossTotal && t.cmp(i.grossTotal, linesTotal) !== 0) {
    throw bad(`grossTotal ${i.grossTotal} satir toplami ${linesTotal} ile uyusmuyor`, 'TOTAL_MISMATCH');
  }
  if (t.cmp(tenderTotal, linesTotal) !== 0) {
    throw bad(
      `Odeme toplami ${t.human(tenderTotal)} belge toplami ${t.human(linesTotal)} ile esit degil.`,
      'TENDER_TOTAL_MISMATCH');
  }

  const intent = {
    schemaVersion: '1',
    operationId: String(i.operationId),
    idempotencyKey: String(i.idempotencyKey),
    tenantId: String(i.tenantId),
    merchantId: String(i.merchantId),
    branchId: String(i.branchId),
    deviceId: String(i.deviceId),
    businessSaleId: String(i.businessSaleId),
    businessRevision: String(i.businessRevision),
    workflow: i.workflow || 'SALE',
    documentPolicyVersion: String(i.documentPolicyVersion || '1'),
    fiscalMappingVersion: String(i.fiscalMappingVersion || '1'),
    currency: t.CURRENCY,
    lines,
    tenders,
    grossTotal: linesTotal,
    customerRef: i.customerRef || undefined,
    existingInvoiceRef: i.existingInvoiceRef || undefined,
    createdAt: i.createdAt || new Date().toISOString(),
  };

  deepFreeze(intent);
  return { intent, payloadHash: hash(intent), tenderKinds: [...new Set(tenders.map(x => x.kind))] };
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

module.exports = { build, hash, canonical, deepFreeze, TENDER_KINDS, WORKFLOWS, bad };
