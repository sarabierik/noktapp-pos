'use strict';
/**
 * Rate limiting and backoff.
 *
 * TGO documents 50 requests per 10 seconds PER ENDPOINT, so the bucket is keyed
 * by endpoint and not by provider: draining the package poll must not stop the
 * accept call from going out. The bucket is in memory because it protects a
 * limit measured in seconds and the process that makes the calls is the one
 * that must not exceed it - persisting it would only make a restart slower.
 *
 * Backoff is the other half and it IS persisted (np_int_cursors.backoff_until):
 * a till restarted in a loop must not turn a provider's 429 into a hammering.
 * Exponential with FULL JITTER - `random(0, base * 2^n)` - because every till
 * in the country sees the same outage at the same second, and synchronised
 * retries are how a provider's recovery is turned back into an outage.
 */
const buckets = new Map();

/** Take one token for `key`; resolves when the call is allowed to go out. */
async function take(key, { limit = 50, windowMs = 10000, maxWaitMs = 20000 } = {}) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start >= windowMs) { b = { start: now, count: 0 }; buckets.set(key, b); }
  if (b.count < limit) { b.count++; return 0; }
  const wait = Math.min(maxWaitMs, b.start + windowMs - now + 5);
  if (wait > maxWaitMs) throw new Error('Hiz siniri beklemesi cok uzun');
  await new Promise(r => setTimeout(r, wait));
  return take(key, { limit, windowMs, maxWaitMs });
}

/** How many tokens are left right now - the health card reads this. */
function remaining(key, { limit = 50, windowMs = 10000 } = {}) {
  const b = buckets.get(key);
  if (!b || Date.now() - b.start >= windowMs) return limit;
  return Math.max(0, limit - b.count);
}

function clear() { buckets.clear(); }

/**
 * Milliseconds to wait after `attempt` consecutive failures.
 * attempt 1 -> 0..2s, 2 -> 0..4s, 3 -> 0..8s … capped at five minutes.
 */
function backoffMs(attempt, { base = 1000, cap = 300000 } = {}) {
  const n = Math.max(1, Math.min(20, Number(attempt) || 1));
  const ceiling = Math.min(cap, base * Math.pow(2, n));
  return Math.floor(Math.random() * ceiling);
}

module.exports = { take, remaining, clear, backoffMs };
