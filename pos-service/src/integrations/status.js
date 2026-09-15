'use strict';
/**
 * The normalised order lifecycle, and the rule that a transition has to be
 * legal before it is written.
 *
 * Four platforms, four vocabularies, and no two of them agree: Trendyol Go
 * calls a package "Picked", Yemeksepeti calls the same moment "picked up",
 * Migros says the courier "aldı". The till cannot have four state machines, so
 * every provider status is mapped onto ONE of these eight and the provider's
 * own word is kept alongside it in np_int_orders.provider_status - never
 * thrown away, because that is what support needs when the platform's screen
 * and ours disagree.
 *
 * The transition table is deliberately strict. An out-of-order event is normal
 * on a polling integration: the poll window overlaps by two minutes, so an
 * ACCEPTED that we already recorded arrives again after we have moved on to
 * PREPARING. Accepting it would walk the order backwards, print again, and
 * tell the kitchen to start over. Same-state is a no-op; backwards is refused.
 */

const STATUSES = ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY', 'DISPATCHED', 'DELIVERED', 'REJECTED', 'CANCELLED'];

const TERMINAL = new Set(['DELIVERED', 'REJECTED', 'CANCELLED']);

/* What may follow what. Cancellation is reachable from every live state -
   before acceptance AND after it - because both really happen: the guest
   cancels in the app, or the platform cancels an accepted order because no
   courier could be found. */
const NEXT = {
  RECEIVED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'READY', 'DISPATCHED', 'DELIVERED', 'CANCELLED'],
  PREPARING: ['READY', 'DISPATCHED', 'DELIVERED', 'CANCELLED'],
  READY: ['DISPATCHED', 'DELIVERED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  REJECTED: [],
  CANCELLED: [],
};

/** Turkish, for the screen and the slip. */
const LABELS = {
  RECEIVED: 'Yeni sipariş',
  ACCEPTED: 'Onaylandı',
  PREPARING: 'Hazırlanıyor',
  READY: 'Hazır',
  DISPATCHED: 'Yola çıktı',
  DELIVERED: 'Teslim edildi',
  REJECTED: 'Reddedildi',
  CANCELLED: 'İptal edildi',
};

function isStatus(s) { return STATUSES.includes(String(s)); }
function isTerminal(s) { return TERMINAL.has(String(s)); }

/**
 * May `from` become `to`?
 *
 * Returns { ok, reason, noop }. `noop` is true for a repeat of the state we
 * are already in, which is a SUCCESS - a provider re-sending an event it
 * already sent has not done anything wrong and must not be answered with an
 * error it will then retry for ever.
 */
function canTransition(from, to) {
  if (!isStatus(to)) return { ok: false, noop: false, reason: 'Bilinmeyen durum: ' + to };
  if (!from) return { ok: true, noop: false, reason: null };
  if (!isStatus(from)) return { ok: false, noop: false, reason: 'Bilinmeyen mevcut durum: ' + from };
  if (from === to) return { ok: true, noop: true, reason: null };
  if (isTerminal(from)) {
    return { ok: false, noop: false, reason: `${LABELS[from]} durumundaki sipariş ${LABELS[to]} yapılamaz` };
  }
  if (!NEXT[from].includes(to)) {
    return { ok: false, noop: false, reason: `${LABELS[from]} durumundan ${LABELS[to]} durumuna geçilemez` };
  }
  return { ok: true, noop: false, reason: null };
}

/** Throwing form, for the API layer. */
function assertTransition(from, to) {
  const r = canTransition(from, to);
  if (!r.ok) { const e = new Error(r.reason); e.status = 409; e.code = 'INVALID_TRANSITION'; throw e; }
  return r;
}

/**
 * How far along a status is, so an out-of-order poll can be recognised without
 * hard-coding pairs. Cancellation and rejection sit outside the ladder.
 */
const RANK = { RECEIVED: 0, ACCEPTED: 1, PREPARING: 2, READY: 3, DISPATCHED: 4, DELIVERED: 5 };
function rank(s) { return RANK[s] === undefined ? -1 : RANK[s]; }

module.exports = { STATUSES, TERMINAL, NEXT, LABELS, isStatus, isTerminal, canTransition, assertTransition, rank };
