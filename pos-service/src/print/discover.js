'use strict';
/**
 * Find the printers on the restaurant's own network.
 *
 * The Yazici ekle dialog asked for "IP adresi" and left it at that. Nobody
 * behind a counter knows the address of the thermal printer screwed under the
 * till - it is on a label on the back, if the label survived, and the router's
 * DHCP page is not somewhere a waiter goes. So the field stayed empty and the
 * printer was never added.
 *
 * This sweeps the LAN the PC is already on and reports what answers. There is
 * no discovery protocol every ESC/POS box speaks, but there is one thing they
 * all do: they listen on 9100 (RAW / JetDirect). A TCP connect that completes
 * is a printer, near enough - a PC does not sit on 9100. 515 (LPD) and 631
 * (IPP) are reported too, because a few network print servers open those and
 * not 9100, and they are worth showing as "muhtemel".
 *
 * Deliberately not here: SNMP, mDNS, WSD. Each is another dependency and
 * another firewall prompt, and none of them tells us anything 9100 does not
 * for the devices this product actually meets.
 */
const net = require('net');
const os = require('os');
const dns = require('dns');
const log = require('../logger');

/** Ports worth knocking on, most telling first. */
const PORTS = [
  { port: 9100, kind: 'raw', sure: true },   // ESC/POS RAW - what we can print to
  { port: 515, kind: 'lpd', sure: false },
  { port: 631, kind: 'ipp', sure: false },
];

/**
 * The IPv4 /24s this machine sits on.
 *
 * Only /24 and smaller: a /16 is 65k probes and a restaurant is never on one.
 * Loopback, link-local (169.254) and virtual adapters with no netmask are out.
 */
function localSubnets() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      if (!a.address || a.address.startsWith('169.254.')) continue;
      const bits = Number(String(a.cidr || '').split('/')[1] || 0);
      if (bits && bits < 24) continue;             // too wide to sweep politely
      const base = a.address.split('.').slice(0, 3).join('.');
      if (!out.some(x => x.base === base)) out.push({ base, self: a.address, iface: name });
    }
  }
  return out;
}

/** One TCP knock. Resolves true only on a completed connection. */
function knock(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    try { s.connect(port, ip); } catch (e) { finish(false); }
  });
}

/** Best-effort name, so the list says "TM-T20" and not just an address. */
function reverseName(ip, timeoutMs = 400) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(''); } }, timeoutMs);
    dns.reverse(ip, (err, names) => {
      if (settled) return;
      settled = true; clearTimeout(t);
      resolve(err || !names || !names.length ? '' : String(names[0]).split('.')[0]);
    });
  });
}

/**
 * Sweep the local /24(s).
 *
 * `concurrency` is what keeps this bearable on a till: 64 sockets in flight
 * finishes 254 hosts in about four seconds at a 500 ms timeout, and a thermal
 * printer on the same switch answers in under 50.
 */
async function scan({ subnet = null, timeoutMs = 500, concurrency = 64, ports = null } = {}) {
  const started = Date.now();
  const nets = subnet
    ? [{ base: String(subnet).split('.').slice(0, 3).join('.'), self: null, iface: 'manuel' }]
    : localSubnets();
  if (!nets.length) return { subnets: [], found: [], scanned: 0, ms: 0, note: 'ag bulunamadi' };

  const wanted = ports && ports.length
    ? PORTS.filter(p => ports.includes(p.port))
    : PORTS;

  const targets = [];
  for (const n of nets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${n.base}.${i}`;
      if (n.self && ip === n.self) continue;        // do not probe ourselves
      targets.push(ip);
    }
  }

  const found = new Map();
  let cursor = 0;
  async function worker() {
    for (;;) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const ip = targets[idx];
      /*
       * 9100 first and alone: if it answers, the device can be printed to and
       * the other two ports tell us nothing more. Only when it does not do we
       * spend two more sockets asking whether this is a print server of some
       * other kind.
       */
      const raw = wanted.find(p => p.port === 9100);
      if (raw && await knock(ip, 9100, timeoutMs)) {
        found.set(ip, { ip, port: 9100, kind: 'raw', sure: true });
        continue;
      }
      for (const p of wanted) {
        if (p.port === 9100) continue;
        if (await knock(ip, p.port, timeoutMs)) {
          found.set(ip, { ip, port: p.port, kind: p.kind, sure: false });
          break;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 128)) }, worker));

  const list = Array.from(found.values());
  await Promise.all(list.map(async (f) => { f.name = await reverseName(f.ip); }));
  list.sort((a, b) => (b.sure - a.sure) ||
    (Number(a.ip.split('.')[3]) - Number(b.ip.split('.')[3])));

  const ms = Date.now() - started;
  log.info('print', 'network scan', { subnets: nets.map(n => n.base), found: list.length, ms });
  return {
    subnets: nets.map(n => n.base + '.0/24'),
    scanned: targets.length,
    found: list.map(f => ({
      ip: f.ip,
      port: f.port,
      address: f.port === 9100 ? f.ip : `${f.ip}:${f.port}`,
      name: f.name || '',
      sure: f.sure,
      label: f.sure ? 'Yazıcı' : (f.kind === 'lpd' ? 'LPD (muhtemel)' : 'IPP (muhtemel)'),
    })),
    ms,
  };
}

module.exports = { scan, localSubnets, knock };
