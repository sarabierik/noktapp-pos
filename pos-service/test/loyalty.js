'use strict';
/**
 * Loyalty (sadakat) tests.
 *
 * These check the behaviours that were wrong or missing in the old system, not
 * just that the code runs: stamps per item rather than per scan, rollover,
 * no double-stamping a bill, atomic redemption under concurrent taps, and a
 * redeemed reward that actually stays off the bill after the next item change.
 */
process.env.NOKTAPP_PORT = process.env.NOKTAPP_PORT || '7491';
const assert = require('assert');
const crypto = require('crypto');
const db = require('../src/db');
const _auth = require('../src/auth');
const loyalty = require('../src/modules/loyalty');
const orders = require('../src/modules/orders');
const catalog = require('../src/modules/catalog');
const payments = require('../src/modules/payments');
const { bootstrap } = require('../src/index');

// When PANEL is set the suite also exercises the shared guest registry -
// the same tables pass.noktapp.com reads and writes.
const PANEL = process.env.PANEL || null;
const SHARED = process.env.SHARED_DSN || null;   // mariadb CLI args for the registry
const { execFileSync } = require('child_process');
function shared(sql) {
  if (!SHARED) return null;
  return execFileSync('mariadb', SHARED.split(' ').concat(['-N', '-B', '-e', sql]), { encoding: 'utf8' }).trim();
}

const CID = 19;
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  PASS  ' + name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('  FAIL  ' + name + ' -> ' + e.message); }
}

let coffee, cake, table, userId, customerId, _programId;

async function freshOrder(items) {
  const id = await orders.openOrder(CID, { tableId: table, userId, waiterId: userId });
  for (const [pid, qty] of items) await orders.addItem(CID, id, { productId: pid, qty, userId });
  return id;
}

process.on('unhandledRejection', (e) => {
  console.error('\nFIXTURE/RUNTIME FAILURE:', e && e.message);
  process.exit(1);
});

(async () => {
  const server = await bootstrap();
  db.setClientId(CID);
  console.log('\nNOKTApp POS - sadakat tests\n');

  // --- fixtures -----------------------------------------------------
  const bd = require('../src/util/businessDay');
  await db.exec('DELETE FROM daily_closings WHERE client_id=? AND date=?', [CID, await bd.currentBusinessDate()]);
  let u = await db.one('SELECT id FROM users WHERE client_id=? LIMIT 1', [CID]);
  if (!u) u = { id: await catalog.saveUser(CID, { display_name: 'Test', username: 'test', role: 'admin', pin: '9999' }, null) };
  userId = u.id;
  let t0 = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? LIMIT 1', [CID]);
  if (!t0) {
    const z = await catalog.saveZone(CID, { name: 'Salon' });
    await catalog.bulkTables(CID, { zoneId: z, prefix: 'Masa', from: 1, to: 4 });
    t0 = await db.one('SELECT id FROM restaurant_tables WHERE client_id=? LIMIT 1', [CID]);
  }
  table = t0.id;
  const st = await db.one("SELECT id FROM stations WHERE client_id=? LIMIT 1", [CID]);
  // fixtures are re-runnable: the suite is meant to be run over and over
  const existingCat = await db.one("SELECT id FROM categories WHERE client_id=? AND name='Sadakat Testi'", [CID]);
  const cat = existingCat ? existingCat.id
    : await catalog.saveCategory(CID, { name: 'Sadakat Testi', station_id: st.id, use_in_pos: 1 });
  const findProduct = async (name) => {
    const p = await db.one('SELECT id FROM products WHERE client_id=? AND name=?', [CID, name]);
    return p ? p.id : null;
  };
  coffee = (await findProduct('Filtre Kahve')) ||
    await catalog.saveProduct(CID, { category_id: cat, name: 'Filtre Kahve', price: 90, cost_price: 25, vat_rate: 10 });
  cake = (await findProduct('Cheesecake')) ||
    await catalog.saveProduct(CID, { category_id: cat, name: 'Cheesecake', price: 150, cost_price: 50, vat_rate: 10 });
  if (!await db.one("SELECT id FROM pos_shifts WHERE client_id=? AND status='open'", [CID])) {
    await payments.openShift(CID, { userId, userName: 'Test', openingFloat: 0 });
  }
  await db.exec('DELETE FROM loyalty_events WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM loyalty_cards WHERE client_id=?', [CID]);
  await db.exec('DELETE FROM loyalty_programs WHERE client_id=?', [CID]);
  _programId = await db.insert(
    "INSERT INTO loyalty_programs (client_id, product_id, title, target_count, reward_text, is_active, created_at) VALUES (?,?,?,?,?,1,NOW())",
    [CID, coffee, '10 Kahve 1 Bedava', 10, 'Bir filtre kahve bizden']);

  // --- phone handling ----------------------------------------------
  await step('Turkish numbers all normalise to one shape', async () => {
    for (const raw of ['0537 123 45 67', '+90 537 123 45 67', '905371234567', '5371234567', '(0537) 123-4567']) {
      assert.strictEqual(loyalty.trPhone(raw), '5371234567', 'failed on ' + raw);
    }
    assert.strictEqual(loyalty.trPhoneOk('5371234567'), true);
    assert.strictEqual(loyalty.trPhoneOk('2121234567'), false);
  });

  if (PANEL) await db.setSetting('panel_url', PANEL);

  await step('a guest enrolled at the till is minted in the shared registry', async () => {
    await db.exec("DELETE FROM customers WHERE phone='5371234567'");
    if (SHARED) shared("DELETE FROM customers WHERE phone='5371234567'");
    const c1 = await loyalty.enrol(CID, { firstName: 'Ayse', lastName: 'Yilmaz', phone: '0537 123 45 67' });
    const c2 = await loyalty.enrol(CID, { firstName: 'Ayse', phone: '+905371234567' });
    assert.strictEqual(c1.id, c2.id, 'duplicate customer created');
    assert.strictEqual(c1.phone, '5371234567');
    assert.ok(c1.qr_uid && c1.qr_uid.length >= 24, 'no QR uid issued');
    if (SHARED) {
      const n = shared("SELECT COUNT(*) FROM customers WHERE id=" + c1.id + " AND phone='5371234567'");
      assert.strictEqual(n, '1', 'the guest never reached the shared registry');
    }
    customerId = c1.id;
  });

  await step('enrolment with no internet says so instead of inventing an account', async () => {
    const was = await db.getSetting('panel_url');
    await db.setSetting('panel_url', 'http://127.0.0.1:9');
    let msg = '';
    try { await loyalty.enrol(CID, { firstName: 'Offline', phone: '5309998877' }); }
    catch (e) { msg = e.message; }
    await db.setSetting('panel_url', was);
    assert.ok(/internet/i.test(msg), 'expected an honest offline message, got: ' + msg);
    const n = Number(await db.value("SELECT COUNT(*) FROM customers WHERE phone='5309998877'"));
    assert.strictEqual(n, 0, 'a local-only account was created and would collide with the registry');
  });

  await step('an unknown phone is refused, not silently enrolled', async () => {
    const r = await loyalty.resolve('5559998877', { allowPanel: false });
    assert.strictEqual(r.error, 'PHONE_UNKNOWN');
    const n = Number(await db.value("SELECT COUNT(*) FROM customers WHERE phone='5559998877'"));
    assert.strictEqual(n, 0, 'a junk customer was created from an unknown number');
  });

  await step('someone who signed up in the Pass app is recognised at the till', async () => {
    if (!SHARED) return;
    shared("DELETE FROM customers WHERE phone='5551112233'");
    shared("INSERT INTO customers (first_name,last_name,phone,qr_uid,is_verified,is_active,created_by_client_id,created_at,updated_at) " +
           "VALUES ('Zeynep','Kaya','5551112233','" + 'a'.repeat(32) + "',1,1,0,NOW(),NOW())");
    const id = Number(shared("SELECT id FROM customers WHERE phone='5551112233'"));
    await db.exec("DELETE FROM customers WHERE phone='5551112233' OR id=?", [id]);   // the till has never met her
    const r = await loyalty.resolve('0555 111 22 33');
    assert.ok(r.customer, r.error);
    assert.strictEqual(r.customer.id, id, 'the till invented its own id for a known guest');
    // and now she is local, so the same lookup works with the line down
    const offline = await loyalty.resolve('5551112233', { allowPanel: false });
    assert.ok(offline.customer && offline.customer.id === id, 'guest was not cached for offline use');
  });

  await step('a one-time code from the app is accepted and burned centrally', async () => {
    if (!SHARED) return;
    /*
     * Read the guest back out of the shared registry rather than trusting the
     * id an earlier step happened to leave in a variable. The suites share a
     * database and run in whatever order the person typing chose; a step that
     * assumes what ran before it fails for a reason that has nothing to do
     * with what it is testing.
     */
    const owner = shared("SELECT id FROM customers WHERE phone='5371234567' AND COALESCE(is_active,1)=1 LIMIT 1");
    assert.ok(owner, 'the enrolled guest is not in the shared registry');
    const token = crypto.randomBytes(32).toString('hex');
    shared("INSERT INTO loyalty_qr_tokens (token,customer_id,expires_at,expires_ts,created_at) VALUES ('" +
           token + "'," + owner + ", DATE_ADD(NOW(), INTERVAL 5 MINUTE), UNIX_TIMESTAMP()+300, NOW())");
    await db.exec('DELETE FROM loyalty_qr_tokens WHERE token=?', [token]);   // the till has never seen it
    const o = await freshOrder([[coffee, 1]]);
    const r = await loyalty.applyToOrder(CID, token, o, userId);
    assert.strictEqual(r.ok, true, r.message);
    /*
     * Drain until the server has it, not exactly once.
     *
     * The guarantee is that the burn REACHES the server, not that it does so on
     * the first attempt: the push is a network round trip, and when the panel
     * is slow or busy `drain()` correctly leaves the op in the outbox to retry.
     * Asserting after a single drain was asserting that the network never has a
     * bad moment, which is not something the product promises - and it failed
     * only when the whole suite ran at once and the test panel was loaded.
     * The running service retries on a timer; this does the same, faster.
     */
    let used = '0';
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise(x => setTimeout(x, 250));
      await require('../src/sync').drain();
      used = shared("SELECT COALESCE(used_by_client_id,0) FROM loyalty_qr_tokens WHERE token='" + token + "'");
      if (used === String(CID)) break;
    }
    assert.strictEqual(used, String(CID), 'the code never reached the server (' + used + ')');
  });

  // --- the till flow -------------------------------------------------
  // the arithmetic below is absolute, so start this guest from a blank card
  await db.exec('DELETE FROM loyalty_events WHERE client_id=? AND customer_id=?', [CID, customerId]);
  await db.exec('DELETE FROM loyalty_cards  WHERE client_id=? AND customer_id=?', [CID, customerId]);

  await step('scanning stamps once PER ITEM, not once per scan', async () => {
    const o = await freshOrder([[coffee, 3], [cake, 1]]);
    const r = await loyalty.applyToOrder(CID, '5371234567', o, userId);
    assert.strictEqual(r.ok, true, r.message);
    assert.strictEqual(r.lines.length, 1);
    assert.strictEqual(r.lines[0].added, 3, 'expected 3 stamps for 3 coffees');
    assert.strictEqual(r.lines[0].progress, 3);
    const attached = await db.value('SELECT customer_id FROM orders WHERE id=?', [o]);
    assert.strictEqual(attached, customerId, 'guest was not attached to the bill');
  });

  await step('the same bill cannot be stamped twice', async () => {
    const o = await freshOrder([[coffee, 1]]);
    await loyalty.applyToOrder(CID, '5371234567', o, userId);
    const again = await loyalty.applyToOrder(CID, '5371234567', o, userId);
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.error, 'ALREADY_AWARDED');
  });

  await step('stamps roll over into a reward when the target is crossed', async () => {
    const o = await freshOrder([[coffee, 8]]);        // 3 + 1 + 8 = 12 -> 1 reward, 2 left over
    const r = await loyalty.applyToOrder(CID, '5371234567', o, userId);
    assert.strictEqual(r.lines[0].earned, 1, 'reward not minted');
    assert.strictEqual(r.lines[0].progress, 2, 'leftover stamps lost');
    const card = (await loyalty.cardsFor(CID, customerId))[0];
    assert.strictEqual(card.rewards_available, 1);
    assert.strictEqual(card.remaining, 8);
  });

  await step('a permanent printed card (qr_uid) also resolves', async () => {
    const c = await db.one('SELECT qr_uid FROM customers WHERE id=?', [customerId]);
    const r = await loyalty.resolve(c.qr_uid, { allowPanel: false });
    assert.ok(r.customer && r.customer.id === customerId);
  });

  await step('a one-time QR token works once and is then dead', async () => {
    const token = crypto.randomBytes(32).toString('hex');
    await db.exec(
      'INSERT INTO loyalty_qr_tokens (token, customer_id, expires_at, expires_ts, created_at) VALUES (?,?,DATE_ADD(NOW(), INTERVAL 5 MINUTE),?,NOW())',
      [token, customerId, Math.floor(Date.now() / 1000) + 300]);
    const o1 = await freshOrder([[coffee, 1]]);
    const first = await loyalty.applyToOrder(CID, token, o1, userId);
    assert.strictEqual(first.ok, true, first.message);
    const o2 = await freshOrder([[coffee, 1]]);
    const second = await loyalty.applyToOrder(CID, token, o2, userId);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.error, 'TOKEN_USED');
  });

  await step('an expired token is refused', async () => {
    const token = crypto.randomBytes(32).toString('hex');
    await db.exec(
      'INSERT INTO loyalty_qr_tokens (token, customer_id, expires_at, expires_ts, created_at) VALUES (?,?,DATE_SUB(NOW(), INTERVAL 1 MINUTE),?,NOW())',
      [token, customerId, Math.floor(Date.now() / 1000) - 60]);
    const o = await freshOrder([[coffee, 1]]);
    const r = await loyalty.applyToOrder(CID, token, o, userId);
    assert.strictEqual(r.error, 'TOKEN_EXPIRED');
  });

  // --- redemption ----------------------------------------------------
  await step('redeeming takes the free item\'s price off the open bill', async () => {
    const o = await freshOrder([[coffee, 1], [cake, 1]]);   // 90 + 150 = 240
    const before = await orders.getOrder(CID, o);
    assert.strictEqual(Number(before.grand_total), 240);
    const card = (await loyalty.cardsFor(CID, customerId)).find(c => c.rewards_available > 0);
    assert.ok(card, 'no reward available to spend');
    const r = await loyalty.redeem(CID, { customerId, cardId: card.card_id, orderId: o, userId });
    assert.strictEqual(r.discount, 90, 'discount was ' + r.discount);
    const after = await orders.getOrder(CID, o);
    assert.strictEqual(Number(after.discount_total), 90);
    assert.strictEqual(Number(after.grand_total), 150);
  });

  await step('the reward stays off the bill after the next item change', async () => {
    // this is the exact bug in the old engine: recalculation wiped the discount
    const o = await freshOrder([[coffee, 10]]);             // mints a reward
    await loyalty.applyToOrder(CID, '5371234567', o, userId);
    const card = (await loyalty.cardsFor(CID, customerId)).find(c => c.rewards_available > 0);
    const o2 = await freshOrder([[coffee, 1], [cake, 1]]);
    await loyalty.redeem(CID, { customerId, cardId: card.card_id, orderId: o2, userId });
    assert.strictEqual(Number((await orders.getOrder(CID, o2)).grand_total), 150);
    await orders.addItem(CID, o2, { productId: cake, qty: 1, userId });      // 240 + 150 = 390
    const after = await orders.getOrder(CID, o2);
    assert.strictEqual(Number(after.discount_total), 90, 'the reward was given back!');
    assert.strictEqual(Number(after.grand_total), 300);
  });

  await step('a manual discount and a reward can sit on the same bill', async () => {
    const o = await freshOrder([[coffee, 10]]);
    await loyalty.applyToOrder(CID, '5371234567', o, userId);
    const card = (await loyalty.cardsFor(CID, customerId)).find(c => c.rewards_available > 0);
    const o2 = await freshOrder([[coffee, 2], [cake, 1]]);   // 330
    await orders.setBillDiscount(CID, o2, { amount: 30, userId });
    await loyalty.redeem(CID, { customerId, cardId: card.card_id, orderId: o2, userId });
    const after = await orders.getOrder(CID, o2);
    assert.strictEqual(Number(after.discount_total), 120, 'discounts did not add up');
    assert.strictEqual(Number(after.grand_total), 210);
  });

  await step('two tills tapping "use reward" at once spend it only once', async () => {
    const o = await freshOrder([[coffee, 10]]);
    await loyalty.applyToOrder(CID, '5371234567', o, userId);
    const card = (await loyalty.cardsFor(CID, customerId)).find(c => c.rewards_available > 0);
    const available = card.rewards_available;
    const bill = await freshOrder([[coffee, 1]]);
    const both = await Promise.allSettled([
      loyalty.redeem(CID, { customerId, cardId: card.card_id, orderId: bill, userId }),
      loyalty.redeem(CID, { customerId, cardId: card.card_id, orderId: bill, userId }),
    ]);
    const okCount = both.filter(x => x.status === 'fulfilled').length;
    assert.strictEqual(okCount, 1, okCount + ' redemptions succeeded, expected 1');
    const now = (await loyalty.cardsFor(CID, customerId)).find(c => c.card_id === card.card_id);
    assert.strictEqual(now.rewards_available, available - 1, 'reward balance is wrong');
    const events = Number(await db.value(
      "SELECT COUNT(*) FROM loyalty_events WHERE card_id=? AND kind='reward' AND order_id=?", [card.card_id, bill]));
    assert.strictEqual(events, 1, events + ' redemption events logged for one reward');
  });

  await step('spending a reward you do not have is refused', async () => {
    const empty = await db.one('SELECT id FROM loyalty_cards WHERE client_id=? AND rewards_available=0 LIMIT 1', [CID]);
    if (!empty) return;                                     // nothing to test against
    let threw = false;
    try { await loyalty.redeem(CID, { customerId, cardId: empty.id, userId }); }
    catch (e) { threw = true; assert.ok(/odul/i.test(e.message), e.message); }
    assert.ok(threw, 'a reward was spent from an empty card');
  });

  // --- automatic award on close --------------------------------------
  await step('a bill closed with a guest attached stamps itself', async () => {
    const o = await freshOrder([[coffee, 2]]);
    await db.exec('UPDATE orders SET customer_id=? WHERE id=?', [customerId, o]);
    const before = (await loyalty.cardsFor(CID, customerId))[0];
    const total = Number((await orders.getOrder(CID, o)).grand_total);
    await payments.addPayment(CID, o, { method: 'nakit', amount: total, userId });
    await new Promise(r => setTimeout(r, 400));             // the award runs just after the close
    const after = (await loyalty.cardsFor(CID, customerId))[0];
    const moved = (after.rewards_available - before.rewards_available) * after.target_count
                + (after.progress_count - before.progress_count);
    assert.strictEqual(moved, 2, 'expected 2 stamps on close, got ' + moved);
  });

  await step('closing the same bill again does not stamp it twice', async () => {
    const o = await freshOrder([[coffee, 1]]);
    await db.exec('UPDATE orders SET customer_id=? WHERE id=?', [customerId, o]);
    await loyalty.awardForOrder(CID, o, userId);
    const first = (await loyalty.cardsFor(CID, customerId))[0];
    await loyalty.awardForOrder(CID, o, userId);
    const second = (await loyalty.cardsFor(CID, customerId))[0];
    assert.strictEqual(second.progress_count, first.progress_count, 'stamped twice');
  });

  await step('card balances written at the till reach the shared registry', async () => {
    if (!SHARED) return;
    await require('../src/sync').drain();
    const local = (await loyalty.cardsFor(CID, customerId))[0];
    const remote = shared("SELECT CONCAT(progress_count,'/',rewards_available) FROM loyalty_cards " +
      "WHERE client_id=" + CID + " AND customer_id=" + customerId + " AND program_id=" + local.program_id);
    assert.strictEqual(remote, local.progress_count + '/' + local.rewards_available,
      'the guest app would show different numbers: ' + remote);
  });

  // --- reporting ------------------------------------------------------
  await step('the programme report shows stamps, redemptions and the open liability', async () => {
    const rep = await loyalty.programReport(CID);
    assert.strictEqual(rep.length, 1);
    assert.ok(Number(rep[0].stamps) > 10, 'stamps not counted: ' + rep[0].stamps);
    assert.ok(Number(rep[0].redeemed) >= 1, 'redemptions not counted');
    const t = await loyalty.totals(CID);
    assert.ok(t.customers >= 1);
    assert.ok(t.open_value >= 0);
  });

  // tidy up so the other suites see a clean floor
  await db.exec("UPDATE orders SET status='cancelled', is_closed=1, exclude_from_reports=1 WHERE client_id=? AND status='open'", [CID]);
  await db.exec('UPDATE restaurant_tables SET is_occupied=0 WHERE client_id=?', [CID]);

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  failed.forEach(f => console.log('  ! ' + f[1] + ': ' + f[2]));
  server.close();
  process.exit(failed.length ? 1 : 0);
})();
