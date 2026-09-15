'use strict';
/**
 * The only way an adapter is allowed to touch the network.
 *
 * Three things every provider call needs and no adapter should re-implement:
 *
 *  - a TIMEOUT. A platform that stops answering must not hold a connection
 *    open until Node gives up on its own; the restaurant's till is not allowed
 *    to care that Trendyol is slow.
 *  - REDACTION. Authorization, api keys, cookies and anything that looks like
 *    a customer's phone number or address never reach the log or np_int_logs.
 *  - a CLASSIFIED error. A 401 is not a 429 is not a socket reset, and the
 *    retry policy above depends on telling them apart: permanent 4xx is never
 *    retried, 429 and transient 5xx are backed off, a timeout is transient.
 */
const log = require('../logger');

const REDACT_HEADERS = ['authorization', 'x-api-key', 'apikey', 'api-key', 'cookie', 'set-cookie',
  'x-api-secret', 'proxy-authorization', 'x-auth-token'];

/** Header map with every secret replaced, safe to log or store. */
function safeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT_HEADERS.includes(String(k).toLowerCase()) ? '***' : v;
  }
  return out;
}

/**
 * Personal data out of a body before it is logged.
 *
 * The mirror row keeps the raw payload on purpose - support cannot answer
 * "the order came in wrong" without it - but the LOG is a different thing: it
 * is read casually, it is exported, and it is kept for months. KVKK says keep
 * the minimum, so the log gets the shape of the payload and not the guest.
 */
const PERSONAL_KEYS = /^(phone|gsm|mobile|tel|telefon|address|adres|addressline|fulladdress|email|mail|customername|firstname|lastname|name|latitude|longitude|lat|lng|doorno|apartment|floor|note|notes|description)$/i;

function redactBody(value, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map(v => redactBody(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PERSONAL_KEYS.test(k.replace(/[_-]/g, ''))) out[k] = '***';
      else out[k] = redactBody(v, depth + 1);
    }
    return out;
  }
  return value;
}

class ProviderError extends Error {
  constructor(message, { status = 0, kind = 'transient', body = null, url = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    /** transient | rate_limited | permanent | auth | timeout | network */
    this.kind = kind;
    this.body = body;
    this.url = url;
  }
  get retryable() { return this.kind !== 'permanent' && this.kind !== 'auth'; }
}

function classify(status) {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'transient';
  if (status >= 400) return 'permanent';
  return 'transient';
}

/**
 * One request. Returns { status, headers, body } for 2xx and throws a
 * ProviderError for everything else, including the transport failing.
 */
async function request(url, { method = 'GET', headers = {}, body = null, timeout = 15000, area = 'entegrasyon' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === null || body === undefined ? undefined
        : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = { raw: text.slice(0, 2000) }; }
    log.debug(area, `${method} ${strip(url)} -> ${res.status} (${Date.now() - started}ms)`,
      { headers: safeHeaders(headers) });
    if (!res.ok) {
      throw new ProviderError(`${method} ${strip(url)} -> ${res.status}`,
        { status: res.status, kind: classify(res.status), body: redactBody(parsed), url: strip(url) });
    }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsed, text };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (e.name === 'AbortError') {
      throw new ProviderError('Saglayici zaman asimina ugradi (' + timeout + 'ms)',
        { kind: 'timeout', url: strip(url) });
    }
    throw new ProviderError('Saglayiciya ulasilamadi: ' + e.message, { kind: 'network', url: strip(url) });
  } finally {
    clearTimeout(timer);
  }
}

/** Query strings can carry keys too; only the path is ever logged. */
function strip(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch (_) { return String(url).split('?')[0]; }
}

module.exports = { request, ProviderError, safeHeaders, redactBody, strip };
