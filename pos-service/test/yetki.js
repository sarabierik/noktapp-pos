'use strict';
/**
 * YETKİ - every gated endpoint the service declares, asked by every role.
 *
 * test/roller.js walks three shifts and proves the product works for the three
 * people who use it. This does the opposite and the boring half: it takes the
 * permission keys off the ROUTES THEMSELVES - `requirePerm` now carries the
 * key it enforces, and `requireOwner` a flag - and for every one of them asks
 * two questions that a hand-written list would eventually stop asking:
 *
 *   1. Does somebody WITHOUT the key get 403? Not 200 (a hole), not 500 (a
 *      permission check that throws is not a refusal), not 401 (which would
 *      mean the token never got as far as the gate).
 *   2. Does somebody WITH the key get past it? A 400, 404 or 409 beyond the
 *      gate is fine and expected - the bodies here are deliberately empty.
 *      A 403 is not: it means a key that exists grants nothing, which is how
 *      a cashier ends up unable to do the job the owner ticked for them.
 *
 * The value is that it cannot go stale. A new endpoint added with a permission
 * on it is swept the day it is written, and one added with NO permission on it
 * is listed at the end, so "did anybody think about who may call this" is
 * asked once per endpoint rather than once per release.
 *
 * Run:  NOKTAPP_DATA_DIR=/tmp/nokdata node test/yetki.js
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7488';
const assert = require('assert');
const db = require('../src/db');
const auth = require('../src/auth');
const { app, bootstrap } = require('../src/index');

const BASE = 'http://127.0.0.1:' + process.env.NOKTAPP_PORT;
const CID = 19;

/* Endpoints deliberately left open to anybody who can sign in, each with the
   reason. Anything else with no permission on it is reported, not failed -
   the judgement is the owner's, but it should be made knowingly. */
const OPEN_ON_PURPOSE = {
  /* --- before anybody has signed in, or about signing in --------------- */
  'GET /api/health': 'the shell polls it before anybody has signed in',
  'GET /api/auth/state': 'drawn on the login screen itself',
  'POST /api/auth/tenant-login': 'this IS the licence login',
  'POST /api/auth/pin': 'this IS the PIN pad',
  'POST /api/auth/pair': 'redeems a pairing code the manager already issued',
  'POST /api/auth/logout': 'ending your own session',
  'POST /api/auth/override': 'a supervisor typing their PIN to authorise ONE act; the PIN is the check',
  'GET /api/auth/permissions': 'what am I allowed to do - the client draws its menu from it',
  'GET /api/auth/features': 'which areas this installation uses; a waiter needs it to draw a sidebar',
  'GET /api/auth/devices': 'the paired-phone list; revoking one is gated, reading it is not',

  /* --- the handheld's own delta ----------------------------------------- */
  'GET /api/mobile/pull': 'the phone\'s own copy of the menu, the floor and the open bills - '
    + 'the same rows its screens already draw, and it is reached with a device token that only '
    + 'exists because a pairing code was redeemed at the till',

  /* --- the waiter's own screens ---------------------------------------- */
  'GET /api/pos/menu': 'a waiter has to be able to read the menu',
  'GET /api/pos/tables': 'the floor plan is the waiter\'s screen',
  'GET /api/pos/stations': 'which kitchen printer a line goes to',
  'GET /api/pos/business-date': 'in the header on every screen',
  'GET /api/pos/shift': 'in the header on every screen; the money in it is cut for anyone without payment.take',
  'GET /api/pos/orders/open': 'the open-table badge',
  'GET /api/pos/orders/recent-closed': 'the "what did I just close" list on the same screen',
  'GET /api/pos/orders/:id': 'the bill you are standing in front of',
  'GET /api/pos/table-groups': 'joined tables, drawn on the floor plan',
  'GET /api/pos/table-groups/:id': 'as above',
  'GET /api/pos/tables/:id/group': 'as above',
  'GET /api/pos/stock': 'the sold-out marks on the menu buttons',
  'GET /api/pos/stations/:id/board': 'the kitchen screen',
  'POST /api/pos/stations/items/:id/state': 'the kitchen marking a dish ready - the kitchen has no other keys',
  'GET /api/pos/loyalty/customers/:id/cards': 'the stamp strip on the bill',
  'GET /api/pos/fiscal/transactions/:id': 'polling the OKC for the sale you just sent',
  'POST /api/pos/orders/:id/print': 'printing the bill you may already edit',
  'POST /api/pos/orders/:id/mail': 'e-mailing the same bill to the guest who asked',
  'DELETE /api/pos/orders/:id': 'gated INSIDE the handler: owner only, with a reason - see test/akis.js',

  /* --- reading the catalogue ------------------------------------------- */
  'GET /api/manage/categories': 'the menu, read', 'GET /api/manage/products': 'the menu, read',
  'GET /api/manage/zones': 'the floor, read', 'GET /api/manage/tables': 'the floor, read',
  'GET /api/manage/printers': 'the printer list, read', 'GET /api/manage/print-jobs': 'the print queue, read',
  'POST /api/manage/print-jobs/:id/retry': 'anybody who can see a jammed receipt can ask for it again',
  'GET /api/manage/fiscal/devices': 'which OKC is attached',
  'GET /api/manage/customers': 'the guest search behind the bill',
  'GET /api/manage/customers/:id/history': 'that guest\'s previous visits',
  'GET /api/manage/loyalty/programs': 'which stamp card is running',
  'GET /api/manage/reservations': 'the booking book', 'GET /api/manage/costs': 'read-only costing',
  'GET /api/manage/suppliers': 'read-only supplier list',
  'GET /api/manage/tasks': 'the shift task list',
  'POST /api/manage/tasks': 'a waiter writing "tuz bitti" on the shift list',
  'POST /api/manage/tasks/:id/done': 'and ticking it off',
  'GET /api/manage/inventory/items': 'read-only stock', 'GET /api/manage/inventory/documents': 'read-only stock',
  'GET /api/manage/settings': 'the client reads its own configuration to draw itself',
  'GET /api/manage/backups': 'the backup list, read',


  /* --- your own account ------------------------------------------------ */
  'GET /api/settings/profile': 'your own profile',
  'POST /api/settings/profile': 'your own profile',
  'POST /api/settings/profile/password': 'your own phone password',
  'POST /api/settings/profile/pin': 'your own PIN',

  /* --- floor and kitchen ----------------------------------------------- */
  'GET /api/floor/zones': 'the floor, read', 'GET /api/floor/tables': 'the floor, read',
  'GET /api/floor/qr/cards': 'the QR cards for the tables', 'GET /api/floor/qr/resolve/:token': 'a guest scanning one',
  'GET /api/floor/reservations': 'the booking book', 'GET /api/floor/reservations/day/:date': 'one day of it',
  'GET /api/floor/reservations/export': 'the same book, printed',
  'GET /api/floor/reservations/conflicts': 'double-booking warnings',
  'POST /api/floor/reservations': 'whoever answers the phone takes the booking',
  'PUT /api/floor/reservations/:id': 'and changes it when they ring back',
  'POST /api/floor/reservations/:id/status': 'and marks them arrived',
  'GET /api/floor/kitchen/stations': 'the kitchen screen', 'GET /api/floor/kitchen/board': 'the kitchen screen',
  'GET /api/floor/kitchen/history': 'what the kitchen already sent out',
  'POST /api/floor/kitchen/items/:id/state': 'the kitchen marking a dish ready',

  /* --- the till and the figures ---------------------------------------- */
  'GET /api/till/denominations': 'the list of Turkish notes and coins - a constant',
  'GET /api/till/movements': 'movements of the drawer you are working',
  'GET /api/till/shifts/:id': 'one past shift, by id',
  'POST /api/till/count/total': 'a calculator: it adds up the notes you typed and writes nothing',
  'GET /api/finance/context': 'which periods are open - drawn before any figure is asked for',

  /* --- the outside world ----------------------------------------------- */
  'POST /api/integrations/webhook/:provider': 'the platform pushes to it; the signature is the check',
  'POST /api/device/prefixes/allocate': 'a till registering itself; idempotent, and it allocates nothing twice',
  'GET *': 'the single-page app itself - index.html, not an endpoint',

  /* --- the handheld ---------------------------------------------------- */
  'GET /api/mobile/ping': 'how the app finds the till on the wifi, before it has a token',
  'GET /api/mobile/bootstrap': 'what am I allowed to do - the app draws its buttons from it',
  'GET /api/mobile/stations': 'which kitchen a line will go to',
  'GET /api/mobile/tables': 'the floor plan is the waiter\'s screen',
  'GET /api/mobile/orders/:id': 'the bill you are standing in front of',
  'GET /api/mobile/tables/:id/order': 'the bills open on that table',
  'GET /api/mobile/print-jobs': 'did my receipt come out',
  'POST /api/mobile/print-jobs/:id/retry': 'it did not; send it again',
  'POST /api/mobile/orders/:id/print': 'asking for the bill is the waiter\'s job, taking the money is not',
  'POST /api/mobile/orders/:id/mail': 'the same bill, to the guest who asked for it',
  'POST /api/mobile/sync': 'the offline queue draining; every op inside it is gated on its own',

  /* --- the first-run wizard -------------------------------------------- */
  'GET /api/setup/state': 'drawn on the login screen, before any user exists',
  'POST /api/setup/seed': 'open only while setup_done is 0 - settings.manage after it, see wizardOrSettings',
  'POST /api/setup/business': 'as above',
  'POST /api/setup/tables': 'as above',
  'POST /api/setup/finish': 'as above',
  'POST /api/setup/first-user': 'the only user it can create is the first one; 409 once anybody exists',

  /* --- the digital menu ------------------------------------------------ */
  'GET /api/guest/menu': 'a stranger\'s phone, from the street, with only what is printed on the table card',
  'GET /api/guest/qr/settings': 'the QR screen, read', 'GET /api/guest/qr/flags': 'which categories show on it',
  'GET /api/guest/qr/preview': 'what the guest will see', 'GET /api/guest/qr/cards': 'the printable cards',
  'GET /api/guest/qr/cards.pdf': 'the same cards, as a PDF to print',
  'GET /api/guest/customers': 'the guest search behind the bill',
  'GET /api/guest/customers/top': 'the regulars list on the same screen',
  'GET /api/guest/customers/:id': 'one guest, for the bill in front of you',
  'GET /api/guest/loyalty/programs': 'which stamp card is running',
  'GET /api/guest/loyalty/cards': 'the stamp strip', 'GET /api/guest/loyalty/cards/:id/history': 'its stamps',
  'GET /api/guest/setup/state': 'how far through the menu wizard this installation is',
  'GET /api/qr/settings': 'the QR menu configuration, read',
};

/* Path parameters get a value that is syntactically right and semantically
   absent: the gate runs before the handler, so a 404 past it is a pass. */
function fill(p) {
  return p.replace(/:([A-Za-z_]+)(\([^)]*\))?/g, (_, name) => {
    if (/date/i.test(name)) return '2026-01-01';
    if (/kind|provider|type|slug|format/i.test(name)) return 'sales';
    return '999999';
  });
}

function declared(app) {
  const out = [];
  /*
   * `inherited` is how a router-level gate is seen. `r.use(requirePerm('x'))`
   * is not attached to any one route - it is a layer of its own, and it
   * applies to every route registered after it in that stack. Walking the
   * stack in order and carrying the keys forward is what a request does, so
   * it is what this does.
   */
  const walk = (stack, prefix, inherited) => {
    let carried = inherited.slice();
    for (const layer of stack || []) {
      if (layer.route) {
        const p = prefix + (layer.route.path === '/' ? '' : layer.route.path);
        const perms = carried.slice();
        let ownerOnly = carried.ownerOnly || false;
        for (const l of layer.route.stack || []) {
          if (l.handle && l.handle.perm) perms.push(l.handle.perm);
          if (l.handle && l.handle.ownerOnly) ownerOnly = true;
        }
        for (const m of Object.keys(layer.route.methods)) {
          if (layer.route.methods[m]) {
            out.push({ method: m.toUpperCase(), path: p, perms: [...new Set(perms)], ownerOnly });
          }
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        const src = layer.regexp && layer.regexp.source;
        let mount = '';
        if (src) {
          const m = src.match(/^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)/);
          if (m) mount = '/' + m[1].replace(/\\\//g, '/');
        }
        walk(layer.handle.stack, prefix + mount, carried);
      } else if (layer.handle && layer.handle.perm) {
        carried = carried.concat(layer.handle.perm);     // r.use(requirePerm(...))
      }
    }
  };
  walk(app._router && app._router.stack, '', []);
  return out;
}

async function call(method, path, token) {
  const res = await fetch(BASE + fill(path), {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
  });
  let json = {};
  try { json = JSON.parse(await res.text()); } catch (_) { /* html error page */ }
  return { status: res.status, ...json };
}

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + '  -> ' + e.message); }
}

/* Endpoints that do something a sweep must not do twice, or at all: they close
   the day, wipe a table, restore a database or talk to a device that is not
   here. The GATE is still checked from the refusing side, which is the side
   this suite is about; only the allowed-side call is skipped. */
const NO_HAPPY_CALL = [
  /restore/, /backups\/run/, /close-day/, /reopen-day/, /\/purge/, /bulk-delete/,
  /demo\/clear/, /demo\/load/,   // empty or refill the database this suite stands in
  /\/factory/, /\/wipe/, /shutdown/, /update/, /\/print/, /\/mail/, /fiscal/,
  /\/sync/, /webhook/, /\/import/, /\/export/,
  /*
   * And anything that goes on to ask pos.noktapp.com something. The gate this
   * suite is about has already run and answered by then, so calling through
   * proves nothing extra - and on the test bench the panel is four
   * single-threaded `php -S` workers, so a thousand sweep requests queue
   * behind each other and the next suite's branch bind times out. The suites
   * that exist to test the panel contract - integration, loyalty, zincir,
   * geri - call these properly, one at a time.
   */
  /loyalty/, /\/guest/, /cloud/, /\/branch/, /relay/, /licence/, /lisans/,
];
const skipHappy = (p) => NO_HAPPY_CALL.some(re => re.test(p));


(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - her uc nokta, her rol\n');

  /* A user per role, with nothing but the role's own defaults. */
  const mk = async (username, name, role) => {
    const e = await db.one('SELECT id FROM users WHERE client_id=? AND username=?', [CID, username]);
    const id = e ? e.id : await db.insert(
      `INSERT INTO users (client_id, username, email, display_name, role, password_hash, pin_hash,
          created_at, updated_at, is_active) VALUES (?,?,?,?,?,'','', NOW(), NOW(), 1)`,
      [CID, username, username + '@yetki.local', name, role]);
    await db.exec('UPDATE users SET role=?, is_active=1 WHERE id=?', [role, id]);
    await db.exec('DELETE FROM user_permissions WHERE client_id=? AND user_id=?', [CID, id]);
    return id;
  };
  const WHO = {
    waiter:  { uid: await mk('yetki_garson', 'Yetki Garson', 'waiter'),  role: 'waiter' },
    cashier: { uid: await mk('yetki_kasiyer', 'Yetki Kasiyer', 'cashier'), role: 'cashier' },
  };
  for (const w of Object.values(WHO)) {
    w.perms = await auth.permissionsFor(CID, w.uid, w.role);
    w.token = await auth.issueToken({ cid: CID, uid: w.uid, role: w.role, name: 'Yetki', kind: 'pos' });
  }
  const MANAGER = await auth.issueToken({ cid: CID, uid: await mk('yetki_mudur', 'Yetki Mudur', 'admin'),
    role: 'admin', name: 'Yetki Mudur', kind: 'pos' });
  const OWNER = await auth.issueToken({ cid: CID, uid: 0, role: 'admin', name: 'Sahip', kind: 'tenant' });

  const routes = declared(app);
  const gated = routes.filter(r => r.perms.length || r.ownerOnly);
  const ungated = routes.filter(r => !r.perms.length && !r.ownerOnly);

  console.log(`  ${routes.length} endpoints declared, ${gated.length} of them gated\n`);

  /* ------------------------------------------------- the refusing side */
  await step('every gated endpoint refuses a role that lacks its key - with 403, not 500 and not silence', async () => {
    const holes = [], crashes = [], wrong = [];
    for (const r of gated) {
      for (const [label, w] of Object.entries(WHO)) {
        const lacks = r.ownerOnly || r.perms.some(p => !w.perms.includes(p));
        if (!lacks) continue;
        const res = await call(r.method, r.path, w.token);
        const tag = `${label}: ${r.method} ${r.path} [${r.ownerOnly ? 'owner' : r.perms.join(',')}]`;
        if (res.status >= 500) crashes.push(tag + ' -> ' + res.status);
        else if (res.status === 200) holes.push(tag + ' -> 200');
        else if (res.status !== 403) wrong.push(tag + ' -> ' + res.status);
      }
    }
    const lines = [];
    if (holes.length) lines.push('LET THROUGH:\n      ' + holes.join('\n      '));
    if (crashes.length) lines.push('CRASHED:\n      ' + crashes.join('\n      '));
    if (wrong.length) lines.push('REFUSED FOR THE WRONG REASON:\n      ' + wrong.join('\n      '));
    assert.strictEqual(lines.length, 0, '\n    ' + lines.join('\n    '));
  });

  /* -------------------------------------------------- the allowed side */
  await step('a key that exists actually opens its endpoint', async () => {
    const blocked = [], crashes = [];
    for (const r of gated) {
      if (r.ownerOnly || skipHappy(r.path)) continue;
      for (const [label, w] of Object.entries(WHO)) {
        if (!r.perms.every(p => w.perms.includes(p))) continue;
        const res = await call(r.method, r.path, w.token);
        const tag = `${label}: ${r.method} ${r.path} [${r.perms.join(',')}]`;
        if (res.status === 403) blocked.push(tag);
        else if (res.status >= 500) crashes.push(tag + ' -> ' + res.status + ' ' + (res.error || ''));
      }
    }
    const lines = [];
    if (blocked.length) lines.push('HELD A KEY AND WAS STILL REFUSED:\n      ' + blocked.join('\n      '));
    if (crashes.length) lines.push('CRASHED PAST THE GATE:\n      ' + crashes.join('\n      '));
    assert.strictEqual(lines.length, 0, '\n    ' + lines.join('\n    '));
  });

  /* ------------------------------------------------------ owner-only */
  await step('owner-only endpoints refuse a hired manager and admit the owner', async () => {
    const bad = [];
    for (const r of routes.filter(x => x.ownerOnly)) {
      const m = await call(r.method, r.path, MANAGER);
      if (m.status !== 403) bad.push(`a manager got ${m.status} from ${r.method} ${r.path}`);
      if (m.code && m.code !== 'OWNER_ONLY') bad.push(`${r.method} ${r.path} refused a manager for ${m.code}`);
      if (!skipHappy(r.path)) {
        const o = await call(r.method, r.path, OWNER);
        if (o.status === 403) bad.push(`the owner was refused ${r.method} ${r.path}`);
      }
    }
    assert.strictEqual(bad.length, 0, '\n      ' + bad.join('\n      '));
  });

  /* ------------------------------------------------ nothing without a token */
  await step('no gated endpoint answers anybody at all without a token', async () => {
    const open = [];
    for (const r of gated) {
      const res = await call(r.method, r.path, null);
      if (res.status !== 401) open.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    assert.strictEqual(open.length, 0, '\n      ' + open.join('\n      '));
  });

  /* --------------------------------- the ungated ones, named out loud */
  await step('every endpoint with no permission on it is on the list of ones that should not have one', async () => {
    const unexplained = [];
    for (const r of ungated) {
      const key = `${r.method} ${r.path}`;
      if (OPEN_ON_PURPOSE[key]) continue;
      /* whole routers with a door of their own: the setup wizard runs before
         any user exists, /mobile carries a device token, /qr and /display are
         the guest's side of the glass */
      if (/^\/api\/(display|public)/.test(r.path)) continue;
      unexplained.push(key);
    }
    assert.strictEqual(unexplained.length, 0,
      `${unexplained.length} endpoint(s) are open to anybody who can sign in, and nobody has written down why:\n      `
      + unexplained.join('\n      '));
  });

  /* ------------------------------------- a bad id in the address bar */
  await step('a nonsense id in the path is a refusal, not a 500 with the database in it', async () => {
    const crashes = [];
    for (const r of routes) {
      if (!/:/.test(r.path)) continue;
      if (skipHappy(r.path)) continue;
      const path = r.path.replace(/:([A-Za-z_]+)(\([^)]*\))?/g, 'abc');
      const res = await fetch(BASE + path, {
        method: r.method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OWNER },
        body: r.method === 'GET' || r.method === 'HEAD' ? undefined : '{}',
      });
      if (res.status >= 500) {
        let msg = '';
        try { msg = (JSON.parse(await res.text()).error || '').slice(0, 90); } catch (_) {}
        crashes.push(`${r.method} ${path} -> ${res.status} ${msg}`);
      }
    }
    assert.strictEqual(crashes.length, 0, '\n      ' + crashes.join('\n      '));
  });

  /*
   * Let the sandbox panel drain before the next suite starts.
   *
   * The sweep asks a thousand-odd questions in a couple of minutes, and a
   * handful of them - loyalty lookups, the guest registry - are answered by
   * pos.noktapp.com. On a real server that is nothing; the test panel is four
   * single-threaded `php -S` workers, and a queue of those requests was still
   * draining when zincir ran next, whose branch bind then timed out after
   * thirty seconds and failed a check about a typo'd branch code. Nothing was
   * wrong with either suite. This waits for the panel to answer promptly
   * again, and says so if it does not.
   */
  const panel = process.env.PANEL || 'http://127.0.0.1:8090';
  for (let i = 0; i < 30; i++) {
    const t = Date.now();
    const alive = await fetch(panel + '/', { signal: AbortSignal.timeout(3000) })
      .then(() => Date.now() - t < 1500).catch(() => false);
    if (alive) break;
    if (i === 29) console.log('  (panel still busy after 30s - the next suite may time out)');
    await new Promise(r => setTimeout(r, 1000));
  }

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  for (const f of failed) console.log('  ! ' + f[1] + ': ' + f[2]);
  server.close();
  await db.close?.();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FIXTURE/RUNTIME FAILURE:', e.stack || e.message); process.exit(1); });
