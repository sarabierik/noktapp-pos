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

/** The /24 an address sits in. */
function slashTwentyFour(ip) {
  return String(ip).split('.').slice(0, 3).join('.');
}

/**
 * The IPv4 /24s this machine sits on.
 *
 * ONE PER ADDRESS, AND THE MASK IS NOT ALLOWED TO VETO IT.
 *
 * This used to skip any interface whose mask was wider than /24 - "a /16 is
 * 65k probes and a restaurant is never on one". Both halves were wrong. A
 * restaurant absolutely is on one: an office or a hotel hands out 172.16.x.x
 * as a /16 and a shared building network does the same, and on those machines
 * localSubnets() returned an empty list, scan() answered "found: []" in under
 * a millisecond, and the screen said "ag tarandi, yazici bulunamadi" - a
 * sentence that was not true, because nothing had been scanned at all. That is
 * the worst kind of bug this program can have: it reports a fact about the
 * restaurant's network that it never went and looked at.
 *
 * A wide mask does not mean we must sweep it all. It means we sweep the /24
 * the PC itself is standing in, which is where the printer on the same switch
 * is, and we SAY SO (`wide`) so the screen can offer to try another block.
 *
 * Loopback and link-local (169.254 - an address that means "no DHCP answered")
 * are still out; they lead nowhere by definition.
 */
function localSubnets() {
  return subnetsFrom(os.networkInterfaces());
}

/** The same thing over a supplied interface table, so it can be tested. */
function subnetsFrom(ifaces) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      if (!a.address || a.address.startsWith('169.254.')) continue;
      const bits = Number(String(a.cidr || '').split('/')[1] || 0);
      const base = slashTwentyFour(a.address);
      if (out.some(x => x.base === base)) continue;
      out.push({ base, self: a.address, iface: name, bits: bits || null, wide: !!bits && bits < 24 });
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
 * Sweep the local /24(s), plus any block the caller names.
 *
 * `extra` is how a printer that stayed behind on the old network is still
 * found: the caller passes the addresses already saved against this till, we
 * take their /24s, and a machine that has since moved from 192.168.1.x to
 * 192.168.2.x still gets told "your printer is over there, on the other
 * network" instead of a blank list.
 *
 * The three ports are knocked TOGETHER, not one after the other. A dead
 * address on a LAN does not refuse a connection - there is nobody there to
 * refuse it, the ARP simply goes unanswered - so every probe to it costs the
 * full timeout. Sequentially that was three timeouts per empty address; in
 * parallel it is one, which is what buys the longer fuse below.
 *
 * `timeoutMs` defaults to 900, not the 500 it was. A thermal printer that has
 * been idle on wifi since the morning does not answer a first SYN in half a
 * second - the radio has to wake, and 500ms was losing exactly the printers
 * this feature exists to find, on exactly the networks where typing the IP by
 * hand is hardest.
 */
async function scan({ subnet = null, timeoutMs = 900, concurrency = 64, ports = null, extra = [] } = {}) {
  const started = Date.now();
  const nets = subnet
    ? [{ base: slashTwentyFour(subnet), self: null, iface: 'manuel', bits: 24, wide: false }]
    : localSubnets();

  /* Blocks we were told about - the saved printers' own networks. */
  if (!subnet) {
    for (const raw of extra || []) {
      const ip = String(raw || '').split(':')[0].trim();
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
      const base = slashTwentyFour(ip);
      if (nets.some(n => n.base === base)) continue;
      nets.push({ base, self: null, iface: 'kayitli', bits: 24, wide: false, remote: true });
    }
  }

  if (!nets.length) {
    return { subnets: [], found: [], scanned: 0, ms: Date.now() - started,
      note: 'Bu bilgisayarda taranabilecek bir ag baglantisi bulunamadi.' };
  }

  const wanted = ports && ports.length ? PORTS.filter(p => ports.includes(p.port)) : PORTS;

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
      const hits = await Promise.all(wanted.map(p => knock(ip, p.port, timeoutMs)));
      const i = hits.findIndex(Boolean);
      if (i < 0) continue;
      /* 9100 wins when more than one answers: it is the only one we can
         actually print to, so it is the one the address field should get. */
      const raw = wanted.findIndex(p => p.port === 9100);
      const pick = (raw >= 0 && hits[raw]) ? wanted[raw] : wanted[i];
      found.set(ip, { ip, port: pick.port, kind: pick.kind, sure: pick.sure });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 128)) }, worker));

  const list = Array.from(found.values());
  await Promise.all(list.map(async (f) => { f.name = await reverseName(f.ip); }));
  list.sort((a, b) => (b.sure - a.sure) ||
    (Number(a.ip.split('.')[3]) - Number(b.ip.split('.')[3])));

  const ms = Date.now() - started;
  log.info('print', 'network scan', { subnets: nets.map(n => n.base), found: list.length, ms });

  const wide = nets.filter(n => n.wide);
  return {
    subnets: nets.map(n => n.base + '.0/24'),
    scanned: targets.length,
    /*
     * What was actually looked at, in the owner's words. The screen prints
     * this under the result, because "yazici bulunamadi" on its own has twice
     * been read as "this feature is broken" when the truth was that the
     * printer was on a network this PC is no longer connected to.
     */
    note: wide.length
      ? `${wide.map(n => n.base + '.0/24').join(', ')} tarandi. Bu ag /${wide[0].bits} genisliginde, `
        + 'yani yazici baska bir blokta olabilir - biliyorsaniz adresini elle yazin.'
      : null,
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

module.exports = { scan, localSubnets, subnetsFrom, knock };
