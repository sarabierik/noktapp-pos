'use strict';
/**
 * The order (adisyon) engine - the heart of the till.
 *
 * Design notes
 *  - VAT is Turkish KDV, included in the price. A database trigger works out
 *    each LINE's vat_total from its own gross, but only `recalc` knows the
 *    bill-level discount, so `recalc` is the single author of orders.vat_total
 *    along with total / discount / grand_total. The roll-up triggers that used
 *    to write it were dropped: they summed deleted lines back in, knew nothing
 *    about a discount, and fired again at close time - when inventory stamps
 *    stock_applied on every line - undoing whatever recalc had just settled.
 *  - Numbering is per business day through app_order_counters.
 *  - Nothing is hard-deleted while a day is open: bills are soft-deleted with a
 *    full log so a mistake can always be traced.
 */
const db = require('../db');
const log = require('../logger');
const { money, minor } = require('../util/http');
const kdv = require('../util/vat');
const bd = require('../util/businessDay');
const _stock = require('./stock');
const inventory = require('./inventory');
const printing = require('../print');

/* ------------------------------------------------------------------ */
/* numbering                                                          */
/* ------------------------------------------------------------------ */
/*
 * This PC's own series is prefix 0 - modules/device says so in one sentence
 * ("the PC itself holds prefix 0 and counts 1, 2, 3") and every other reader
 * of this table agrees: device.prefixState reports the server's next number
 * from prefix 0, and allocatePrefix hands 1..9 out to TABLETS.
 *
 * This function used to bump prefix 1 and then read back WITHOUT naming a
 * prefix at all. The primary key is (client_id, business_date, prefix), so the
 * SELECT returned the LOWEST prefix present - and the moment a prefix-0 row
 * appeared (device.observeNumber writes one as soon as a phone replays an
 * offline op numbered on the PC's series) the counter it incremented and the
 * counter it read were two different rows. It then handed out the SAME number
 * for every bill of the day, and uq_adisyon_day turned that into "Duplicate
 * entry" on every attempt to open one: the till stopped taking orders. It also
 * meant the first tablet to be allocated prefix 1 shared the PC's counter row.
 *
 * One prefix, named in both statements, and the two can never diverge.
 */
const OWN_PREFIX = 0;

async function nextAdisyonNo(t, clientId, date) {
  /*
   * The row is SEEDED from the day's own bills rather than from 1, so an
   * install that has been counting on the wrong prefix all day does not restart
   * at 1 and collide with the bills it has already written. Numbers above 9999
   * belong to a tablet's series and are excluded.
   */
  await t.exec(
    `INSERT INTO app_order_counters (client_id, business_date, prefix, next_no)
     SELECT ?,?,?, COALESCE(MAX(adisyon_no),0)+1 FROM orders
      WHERE client_id=? AND business_date=? AND adisyon_no<=9999
     ON DUPLICATE KEY UPDATE next_no = next_no + 1`,
    [clientId, date, OWN_PREFIX, clientId, date]);
  const row = await t.one(
    'SELECT next_no FROM app_order_counters WHERE client_id=? AND business_date=? AND prefix=?',
    [clientId, date, OWN_PREFIX]);
  return row ? row.next_no : 1;
}

/* ------------------------------------------------------------------ */
/* reading                                                            */
/* ------------------------------------------------------------------ */
async function getOrder(clientId, orderId) {
  const o = await db.one(
    `SELECT o.*, t.name AS table_name, z.name AS zone_name, u.display_name AS waiter_name
       FROM orders o
       LEFT JOIN restaurant_tables t ON t.id=o.table_id AND t.client_id=o.client_id
       LEFT JOIN table_zones z ON z.id=t.zone_id
       LEFT JOIN users u ON u.id=o.waiter_id AND u.client_id=o.client_id
      WHERE o.id=? AND o.client_id=?`, [orderId, clientId]);
  if (!o) return null;
  o.items = await db.query(
    `SELECT i.*, p.name AS product_name, s.name AS station_name
       FROM order_items i
       LEFT JOIN products p ON p.id=i.product_id
       LEFT JOIN stations s ON s.id=i.station_id
      WHERE i.order_id=? AND i.client_id=? AND i.is_deleted=0
      ORDER BY i.id`, [orderId, clientId]);
  o.payments = await db.query(
    `SELECT * FROM order_payments WHERE order_id=? AND client_id=? AND is_deleted=0 AND voided_at IS NULL
      ORDER BY id`, [orderId, clientId]);
  o.paid = money(o.payments.reduce((s, p) => s + Number(p.amount), 0));
  o.due = money(Number(o.grand_total) - o.paid);
  return o;
}

async function openOrdersForTable(clientId, tableId) {
  return db.query(
    `SELECT id, adisyon_no, bill_label, grand_total, opened_at
       FROM orders WHERE client_id=? AND table_id=? AND status='open' AND is_deleted=0
      ORDER BY id`, [clientId, tableId]);
}

async function tablePlan(clientId) {
  const zones = await db.query(
    'SELECT id, name, sort_order FROM table_zones WHERE client_id=? AND is_active=1 ORDER BY sort_order, id',
    [clientId]);
  const tables = await db.query(
    `SELECT t.id, t.zone_id, t.name, t.sort_order, t.is_active, t.qr_token,
            t.etiket, t.etiket_kalici,
            (SELECT COUNT(*) FROM orders o WHERE o.table_id=t.id AND o.client_id=t.client_id
               AND o.status='open' AND o.is_deleted=0) AS open_bills,
            (SELECT COALESCE(SUM(o.grand_total),0) FROM orders o WHERE o.table_id=t.id
               AND o.client_id=t.client_id AND o.status='open' AND o.is_deleted=0) AS open_total,
            (SELECT MIN(o.opened_at) FROM orders o WHERE o.table_id=t.id AND o.client_id=t.client_id
               AND o.status='open' AND o.is_deleted=0) AS opened_at,
            -- so the floor plan can say "3 adisyon - A, B, C" instead of just
            -- "3 adisyon", which tells a waiter nothing about which is whose
            (SELECT GROUP_CONCAT(NULLIF(o.bill_label,'') ORDER BY o.bill_label SEPARATOR ', ')
               FROM orders o WHERE o.table_id=t.id AND o.client_id=t.client_id
               AND o.status='open' AND o.is_deleted=0) AS labels
       FROM restaurant_tables t WHERE t.client_id=? AND t.is_active=1
      ORDER BY t.sort_order, t.id`, [clientId]);
  for (const t of tables) {
    t.open_bills = Number(t.open_bills);
    t.open_total = money(t.open_total);
    t.labels = t.labels || '';
    t.etiket = t.etiket || '';
    t.etiket_kalici = !!Number(t.etiket_kalici);
    t.status = t.open_bills > 0 ? 'occupied' : 'free';
  }
  return { zones, tables };
}

/* ------------------------------------------------------------------ */
/* opening / closing                                                  */
/* ------------------------------------------------------------------ */
/**
 * The next free label for a second bill on the same table.
 *
 * A table with one bill needs no label at all - "Masa 4" is unambiguous. The
 * moment a second party sits down it does, because the waiter has to say which
 * bill they mean out loud, and "adisyon 10042" is not something anyone says.
 * So the first bill is unlabelled and the second onward get A, B, C.
 */
async function nextBillLabel(t, clientId, tableId) {
  if (!tableId) return null;
  const rows = await t.query(
    `SELECT bill_label FROM orders
      WHERE client_id=? AND table_id=? AND status='open' AND is_deleted=0`, [clientId, tableId]);
  if (!rows.length) return null;
  const used = new Set(rows.map(r => String(r.bill_label || '').trim().toUpperCase()).filter(Boolean));
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    if (!used.has(letter)) return letter;
  }
  return String(rows.length + 1);
}

/** Rename a bill's label, so a waiter can call it what the guests call it. */
async function renameBill(clientId, orderId, label) {
  const clean = String(label == null ? '' : label).trim().slice(0, 20) || null;
  const n = await db.exec(
    "UPDATE orders SET bill_label=?, updated_at=NOW() WHERE id=? AND client_id=? AND status='open'",
    [clean, orderId, clientId]);
  if (!n) { const e = new Error('Adisyon acik degil'); e.status = 409; throw e; }
  return clean;
}

async function openOrder(clientId, { tableId, waiterId, userId, label, deviceId, offline }) {
  const date = await bd.currentBusinessDate();
  if (await bd.isDayClosed(clientId, date)) {
    const e = new Error('Gun sonu alinmis. Yeni adisyon acilamaz.'); e.status = 409; throw e;
  }
  return db.tx(async t => {
    const no = await nextAdisyonNo(t, clientId, date);
    const billLabel = (label && String(label).trim())
      ? String(label).trim().slice(0, 20)
      : await nextBillLabel(t, clientId, tableId);
    const shift = await t.one(
      "SELECT id FROM pos_shifts WHERE client_id=? AND status='open' ORDER BY id DESC LIMIT 1", [clientId]);
    /*
     * created_by 0 is not "nobody": it is the licence holder. The owner signs
     * in against the panel rather than against a staff row, so their uid is 0
     * all the way down - and these audit columns are NOT NULL, which put the
     * one person allowed to delete a bill in front of "Column 'deleted_by'
     * cannot be null". 0 is what the schema itself defaults to, and a LEFT
     * JOIN on users still comes back empty, which is the honest answer.
     */
    const id = await t.insert(
      `INSERT INTO orders (adisyon_no, client_id, business_date, table_id, waiter_id, status,
          opened_at, total, discount_total, vat_total, grand_total, bill_label, created_by,
          created_at, updated_at, is_closed, app_device_id, app_created_offline, shift_id)
       VALUES (?,?,?,?,?, 'open', NOW(), 0,0,0,0, ?, ?, NOW(), NOW(), 0, ?, ?, ?)`,
      [no, clientId, date, tableId || null, waiterId || userId || null,
       billLabel, userId || 0, deviceId || null, offline ? 1 : 0, shift ? shift.id : null]);
    if (tableId) await t.exec('UPDATE restaurant_tables SET is_occupied=1 WHERE id=? AND client_id=?', [tableId, clientId]);
    return id;
  });
}

/** Find the table's open bill, or start one. */
async function openOrGetOrder(clientId, opts) {
  if (opts.orderId) return opts.orderId;
  /*
   * `forceNew` is checked BEFORE the table is looked at, and that ordering is
   * the whole point. It used to sit only on the "more than one bill" branch,
   * so a table with exactly ONE open bill ignored it and handed back that bill
   * - which is precisely the case somebody asks for a second one: a couple
   * sits down at a six-top where another couple is already eating. The caller
   * asked for a new bill; there is no reading of that request under which the
   * right answer is somebody else's tab.
   */
  if (opts.forceNew) return openOrder(clientId, opts);
  if (opts.tableId) {
    const rows = await openOrdersForTable(clientId, opts.tableId);
    if (rows.length) return rows[0].id;
  }
  return openOrder(clientId, opts);
}

/* ------------------------------------------------------------------ */
/* items                                                              */
/* ------------------------------------------------------------------ */
/**
 * Portions come in halves and nothing finer.
 *
 * Half a portion is a real thing a Turkish kitchen sells (yarim porsiyon) and
 * the qty column is decimal, so it costs nothing to support. Thirds are not:
 * they leave a remainder no one can plate and no one can price, so a typed
 * 0.33 snaps to a half rather than being stored and charged.
 */
function halves(q) {
  const n = Number(q);
  if (!Number.isFinite(n) || n <= 0) {
    const e = new Error('Adet sifirdan buyuk olmali'); e.status = 400; throw e;
  }
  const snapped = Math.round(n * 2) / 2;
  return snapped < 0.5 ? 0.5 : snapped;
}

/**
 * The note on the bill itself, as opposed to the note on a line.
 *
 * A line note is about a dish - "acisiz", "buzsuz". This is about the table:
 * "pasta 21:30 gelecek", "fatura istiyor", "alerji: fistik". It had nowhere to
 * live, so it was told to the waiter and then existed only in his head until
 * he happened to be standing next to the person who needed it.
 *
 * TWO fields, because they print in two different places and mixing them is a
 * real mistake: `notes` is the party's note and appears on the hesap fisi AND
 * the mutfak fisi; `kitchen_note` is for the kitchen alone - "acele", "cocuk
 * icin once ciksin" - and must never turn up on what the guest is handed.
 */
async function setNotes(clientId, orderId, { notes, kitchenNote } = {}, userId = null) {
  const o = await db.one(
    'SELECT id, status FROM orders WHERE id=? AND client_id=? AND is_deleted=0', [orderId, clientId]);
  if (!o) { const e = new Error('Adisyon bulunamadi'); e.status = 404; throw e; }
  if (o.status !== 'open') { const e = new Error('Kapanmis adisyona not eklenemez'); e.status = 409; throw e; }

  const kes = (v) => {
    if (v === undefined) return undefined;
    const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return t === '' ? null : t.slice(0, 255);
  };
  const n = kes(notes);
  const k = kes(kitchenNote);

  const set = [];
  const args = [];
  if (n !== undefined) { set.push('notes=?'); args.push(n); }
  if (k !== undefined) { set.push('kitchen_note=?'); args.push(k); }
  if (!set.length) return { id: Number(orderId) };
  set.push('notes_at=NOW()', 'notes_by=?', 'updated_at=NOW()');
  args.push(userId || null, orderId, clientId);

  await db.exec(`UPDATE orders SET ${set.join(', ')} WHERE id=? AND client_id=?`, args);
  log.info('orders', 'Adisyon notu guncellendi', { order: Number(orderId), by: userId || null });
  return { id: Number(orderId), notes: n, kitchen_note: k };
}

async function addItem(clientId, orderId, { productId, qty = 1, note = null, unitPrice = null, userId, appLocalId = null }) {
  qty = halves(qty);
  return db.tx(async t => {
    const o = await t.one("SELECT * FROM orders WHERE id=? AND client_id=? AND status='open' AND is_deleted=0 FOR UPDATE",
      [orderId, clientId]);
    if (!o) { const e = new Error('Adisyon acik degil'); e.status = 409; throw e; }
    const p = await t.one('SELECT * FROM products WHERE id=? AND client_id=? AND is_active=1', [productId, clientId]);
    if (!p) { const e = new Error('Urun bulunamadi'); e.status = 404; throw e; }
    const price = unitPrice !== null ? money(unitPrice) : money(p.price);

    /*
     * Every tap is its own line.
     *
     * Merging six pizzas into "pizza x6" reads tidily and is wrong at the
     * counter: the six are not interchangeable. One of them gets a note, one
     * goes back, one is on the other guest's half of a split bill - and none of
     * that can be said about a line that has been collapsed into a quantity.
     * The kitchen slip has the same problem: "6 pizza" tells the cook nothing
     * about which is soganli.
     *
     * Set the `merge_lines` setting to 1 to get the old behaviour back.
     */
    const mergeLines = String(await db.getSetting('merge_lines', '0')) === '1';
    const existing = mergeLines ? await t.one(
      `SELECT * FROM order_items WHERE order_id=? AND client_id=? AND product_id=? AND is_deleted=0
         AND COALESCE(note,'')=COALESCE(?,'') AND unit_price=? AND sent_qty=0 LIMIT 1`,
      [orderId, clientId, productId, note, price]) : null;

    let itemId;
    if (existing) {
      const newQty = money(Number(existing.qty) + Number(qty));
      // a line total is qty * unit_price MINUS its discount; merging into a
      // line that already carried one used to hand the discount back
      const lineTotal = money(newQty * price - Number(existing.discount_amount));
      await t.exec('UPDATE order_items SET qty=?, total=?, line_total=?, updated_at=NOW() WHERE id=?',
        [newQty, lineTotal, lineTotal, existing.id]);
      itemId = existing.id;
    } else {
      itemId = await t.insert(
        `INSERT INTO order_items (client_id, order_id, product_id, qty, note, price, unit_price,
            cost_price, total, line_total, discount_amount, stock_applied, sent_qty, is_deleted, app_local_id, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,?,NOW())`,
        [clientId, orderId, productId, qty, note, price, price, p.cost_price || 0,
         money(qty * price), money(qty * price), appLocalId]);
    }
    await recalc(t, clientId, orderId);
    return itemId;
  });
}

/**
 * A line may only be changed while its bill is OPEN.
 *
 * addItem has always taken this lock; updateItem and cancelItem did not, and
 * that was a hole with money in it. Anyone with the till's ordinary keys could
 * edit or void a line on a bill that had been CLOSED and PAID: recalc dutifully
 * rewrote the total - 616 TL of sold food became 0 - while order_payments still
 * held the 616 the guest had handed over. The Z report's sales fell below its
 * own takings, and the stock was handed back for food that had been eaten. It
 * worked on yesterday's bills too, because nothing on that path looked at the
 * day either. Reopening the bill is the sanctioned way to change it, and that
 * one is audited, counted and refused once the day has been closed over.
 */
async function assertOpenForEdit(t, clientId, orderId) {
  const o = await t.one(
    "SELECT id FROM orders WHERE id=? AND client_id=? AND status='open' AND is_deleted=0 FOR UPDATE",
    [orderId, clientId]);
  if (!o) {
    const e = new Error('Adisyon acik degil. Once adisyonu geri acin.'); e.status = 409; throw e;
  }
  return o;
}

async function updateItem(clientId, orderId, itemId, { qty, note, unitPrice, discountAmount, reason, userId }) {
  return db.tx(async t => {
    await assertOpenForEdit(t, clientId, orderId);
    const it = await t.one('SELECT * FROM order_items WHERE id=? AND order_id=? AND client_id=? AND is_deleted=0',
      [itemId, orderId, clientId]);
    if (!it) { const e = new Error('Satir bulunamadi'); e.status = 404; throw e; }
    const newQty = qty === undefined ? Number(it.qty) : halves(qty);
    if (newQty < Number(it.sent_qty)) {
      const e = new Error('Mutfaga gonderilen adetten daha aza dusurulemez. Iptal islemi kullanin.');
      e.status = 409; throw e;
    }
    const price = unitPrice === undefined ? Number(it.unit_price) : money(unitPrice);
    const disc = discountAmount === undefined ? Number(it.discount_amount) : money(discountAmount);
    await t.exec(
      `UPDATE order_items SET qty=?, note=?, unit_price=?, price=?, discount_amount=?,
          total=?, line_total=?, updated_at=NOW() WHERE id=?`,
      [newQty, note === undefined ? it.note : note, price, price, disc,
       money(newQty * price - disc), money(newQty * price - disc), itemId]);
    /*
     * A discount on ONE line is written down like a discount on the whole
     * bill. It used to be the only kind of money coming off a bill that left
     * no trace of who took it off or why - an owner reading `order_discounts`
     * the next morning saw the bill-wide ones and nothing else, which is a
     * strange gap in a table whose entire purpose is that question.
     *
     * source='line' because the row is a RECORD, not a charge: the money is
     * already inside line_total, and recalc counting it a second time gave the
     * guest every line discount twice over.
     */
    if (discountAmount !== undefined && disc !== Number(it.discount_amount)) {
      await t.exec(
        `INSERT INTO order_discounts (client_id, order_id, discount_value, reason, source, created_by, created_at)
         VALUES (?,?,?,?, 'line', ?, NOW())`,
        [clientId, orderId, money(disc - Number(it.discount_amount)),
         (reason || ('Satir indirimi: ' + (it.product_name || ''))).slice(0, 190), userId || null]);
      await t.insert(
        `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id, after_json, created_at)
         VALUES (?,?,?,?,?,?,?,NOW())`,
        [clientId, userId || 0, 'cashier', 'line.discount', 'order_item', String(itemId),
         JSON.stringify({ order_id: orderId, amount: disc, was: Number(it.discount_amount), reason: reason || null })]);
    }
    await recalc(t, clientId, orderId);
    return true;
  });
}

/**
 * Cancel a line. If it was never sent to the kitchen it simply disappears;
 * if it was, the cancellation is recorded and the station gets a void slip.
 */
async function cancelItem(clientId, orderId, itemId, { qty = null, reason = '', userId, approvedBy = null }) {
  const out = await db.tx(async t => {
    await assertOpenForEdit(t, clientId, orderId);   // see assertOpenForEdit
    const it = await t.one('SELECT * FROM order_items WHERE id=? AND order_id=? AND client_id=? AND is_deleted=0',
      [itemId, orderId, clientId]);
    if (!it) { const e = new Error('Satir bulunamadi'); e.status = 404; throw e; }
    const cancelQty = qty === null ? Number(it.qty) : Math.min(halves(qty), Number(it.qty));
    const remaining = money(Number(it.qty) - cancelQty);
    const wasSent = Number(it.sent_qty) > 0;
    /*
     * A discounted line keeps its discount in proportion when only part of it
     * goes back. Rebuilding the remainder as qty * unit_price alone quietly
     * cancelled the discount too, so sending one of two half-price portions
     * back put the other one up to full price.
     */
    const disc = money(it.discount_amount);
    const keptDisc = Number(it.qty) > 0 ? money(disc * remaining / Number(it.qty)) : 0;
    const cancelledGross = money(cancelQty * Number(it.unit_price) - (disc - keptDisc));

    await t.insert(
      `INSERT INTO order_item_cancel_events (client_id, order_id, product_id, qty, line_total, vat_total, vat_rate, cancelled_at)
       VALUES (?,?,?,?,?,?,?,NOW())`,
      [clientId, orderId, it.product_id, cancelQty,
       cancelledGross, kdv.vatOf(cancelledGross, it.vat_rate), it.vat_rate]);
    await t.insert(
      `INSERT INTO deleted_activity_log (client_id, user_id, entity_type, entity_id, json_data, reason, created_at)
       VALUES (?,?, 'item', ?, ?, ?, NOW())`,
      [clientId, userId || 0, itemId, JSON.stringify({ ...it, cancelQty, approvedBy }), reason || null]);

    if (remaining <= 0) {
      // discount_amount goes with it: a line worth nothing owes nothing
      await t.exec(
        `UPDATE order_items SET is_deleted=1, qty=?, total=0, line_total=0, discount_amount=0,
            vat_total=0, updated_at=NOW() WHERE id=?`, [it.qty, itemId]);
    } else {
      const sent = Math.min(Number(it.sent_qty), remaining);
      const lineTotal = money(remaining * Number(it.unit_price) - keptDisc);
      await t.exec(
        `UPDATE order_items SET qty=?, sent_qty=?, discount_amount=?, total=?, line_total=?,
            updated_at=NOW() WHERE id=?`,
        [remaining, sent, keptDisc, lineTotal, lineTotal, itemId]);
    }
    /*
     * TELL THE KITCHEN SCREEN, not just the kitchen printer.
     *
     * A cancelled line queued a void slip and nothing else, so on a station
     * running as a BOARD rather than a printer the ticket stayed on the rail
     * as 'new' and the dish was cooked and plated for a line the guest had
     * already sent back. The whole-bill path (see softDelete) has withdrawn
     * its tickets for a while now; this, the far commoner act, never did.
     *
     * A part-cancel reduces the ticket instead of withdrawing it: two of three
     * köfte going back leaves one köfte to make, and the cook must still see
     * the one.
     */
    if (wasSent) {
      if (remaining <= 0) {
        await t.exec(
          "UPDATE station_projection_items SET station_status='cancelled', updated_at=NOW() " +
          "WHERE client_id=? AND order_item_id=? AND station_status<>'done'", [clientId, itemId]);
      } else {
        await t.exec(
          'UPDATE station_projection_items SET qty=?, updated_at=NOW() ' +
          "WHERE client_id=? AND order_item_id=? AND station_status<>'done'",
          [Math.min(Number(it.sent_qty), remaining), clientId, itemId]);
      }
    }
    if (it.stock_applied) await inventory.reverseLineIn(t, clientId, itemId, cancelQty, userId);
    await recalc(t, clientId, orderId);
    return { wasSent, cancelQty, item: it };
  });
  if (out.wasSent) {
    printing.queueVoidSlip(clientId, orderId, out.item, out.cancelQty, reason).catch(e =>
      log.error('print', 'void slip failed', e.message));
  }
  return out;
}

/**
 * Recompute order totals from its live lines and its discount ledger.
 *
 * Bill-level discounts - a manual one from the cashier, a redeemed loyalty
 * reward - all live in order_discounts, and this is the only place that turns
 * them into money. That matters: the old engine wrote discount_total directly,
 * so the next item change recomputed it as zero and quietly gave a redeemed
 * reward back. Reading the ledger every time makes that impossible.
 */
async function recalc(t, clientId, orderId) {
  const items = await t.query(
    `SELECT line_total, vat_rate FROM order_items
      WHERE order_id=? AND client_id=? AND is_deleted=0`, [orderId, clientId]);
  const subtotal = money(items.reduce((s, i) => s + Number(i.line_total), 0));
  /*
   * Only BILL-level rows count here. A per-line discount is already inside the
   * line_total this sums, so counting its audit row as well took the same money
   * off the bill twice - a 20 TL line discount made the guest 40 TL better off,
   * every time, silently. Line rows are filed under source='line' and are read
   * by the discount reports, never by the arithmetic.
   */
  const ledger = money(await t.value(
    `SELECT COALESCE(SUM(discount_value),0) FROM order_discounts
      WHERE order_id=? AND client_id=? AND source<>'line'`, [orderId, clientId]));
  const discount = money(Math.min(Math.max(0, ledger), subtotal));   // never below zero
  const grand = money(subtotal - discount);
  // the tax the bill actually contains, with the bill discount spread over the
  // lines first - see util/vat.js for why that has to happen before the sum
  const vatTotal = kdv.billVat(items, discount).vatTotal;
  await t.exec(
    `UPDATE orders SET total=?, discount_total=?, vat_total=?, grand_total=?, updated_at=NOW()
      WHERE id=? AND client_id=?`,
    [subtotal, discount, vatTotal, grand, orderId, clientId]);
  return grand;
}

/* ------------------------------------------------------------------ */
/* sending to the kitchen / bar                                       */
/* ------------------------------------------------------------------ */
async function sendToStations(clientId, orderId, userId) {
  /*
   * Which station a line goes to is COALESCE(i.station_id, c.station_id) - the
   * category's station, with a per-line override if one was ever written. This
   * is the rule the kitchen board has always used (modules/floor STATION_EXPR)
   * and the rule the PHP used before it, but this function did not: it read
   * i.station_id alone, and NOTHING on the add path ever writes that column.
   *
   * So every line resolved to station 0, every bill went into a single bucket,
   * and queueStationSlip was called with stationId=null - which means the slip
   * was queued against no printer at all. The board still showed the ticket
   * (it does its own COALESCE), so it looked like the send had worked while
   * nothing came out of the kitchen printer. That is the "garson istasyona
   * gönderemiyor" complaint, and it is why the İstasyonlar screen can now say
   * "yazıcı bağlı değil" and mean it.
   */
  /*
   * The read and the write are ONE transaction, and the lines are locked.
   *
   * Reading `pending` on the pool and then writing in a separate transaction
   * meant two sends of the same bill at the same moment - a double-tapped
   * Gonder, or the till and the waiter's phone - each saw the same lines as
   * unsent. Both queued a kitchen slip and both added their quantity to the
   * projection, so a table that ordered two kebaps had four coming and two
   * tickets on the pass. The second caller now blocks on the row lock and
   * finds qty = sent_qty when it gets in, which is "nothing to send".
   */
  const byStation = new Map();
  const pending = await db.tx(async t => {
    const rows = await t.query(
      `SELECT i.*, COALESCE(i.station_id, c.station_id) AS route_station_id,
              p.name AS product_name, s.name AS station_name
         FROM order_items i
         LEFT JOIN products p ON p.id=i.product_id AND p.client_id=i.client_id
         LEFT JOIN categories c ON c.id=p.category_id AND c.client_id=p.client_id
         LEFT JOIN stations s ON s.id=COALESCE(i.station_id, c.station_id) AND s.client_id=i.client_id
        WHERE i.order_id=? AND i.client_id=? AND i.is_deleted=0 AND i.qty > i.sent_qty
        FOR UPDATE`,
      [orderId, clientId]);
    if (!rows.length) return rows;
    for (const it of rows) {
      const key = it.route_station_id || 0;
      if (!byStation.has(key)) byStation.set(key, []);
      byStation.get(key).push({ ...it, send_qty: money(Number(it.qty) - Number(it.sent_qty)) });
    }
    for (const it of rows) {
      await t.exec('UPDATE order_items SET sent_qty=qty, station_status=?, station_updated_at=NOW() WHERE id=?',
        ['new', it.id]);
      await t.exec(
        /*
         * UPSERT, because station_projection_items is UNIQUE on
         * (client_id, order_item_id) - one row per line, not per send.
         *
         * A plain INSERT threw ER_DUP_ENTRY the second time a line was sent,
         * which is the ordinary "the guest wants one more of the same" - the
         * waiter raises the qty on a line that has already gone and taps
         * Gonder. The whole transaction rolled back, so the extra portions
         * never reached the kitchen and could never be made to: every retry
         * hit the same duplicate.
         *
         * What the kitchen gets back: if it has not finished the earlier
         * portions the quantities add up; if it HAS (done / cancelled) the row
         * shows only the new ones, because the finished plates are on the
         * pass. Either way the ticket goes back to 'new' - there is something
         * to cook again.
         */
        `INSERT INTO station_projection_items (client_id, station_id, order_id, order_item_id, product_id,
            qty, station_status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'new',NOW(),NOW())
         ON DUPLICATE KEY UPDATE
            station_id = VALUES(station_id),
            order_id   = VALUES(order_id),
            qty = IF(station_status IN ('done','cancelled'), VALUES(qty), qty + VALUES(qty)),
            station_status = 'new', updated_at = NOW()`,
        // NOT rounded: the column is decimal now, and rounding here sent a
        // yarim porsiyon to the kitchen as a whole one - the cook made the
        // wrong thing and the guest was charged for half
        [clientId, it.route_station_id || null, orderId, it.id, it.product_id,
         money(Number(it.qty) - Number(it.sent_qty))]);
      /*
       * Stock is NOT moved here any more.
       *
       * Deducting at send-to-kitchen time set stock_applied=1 before the bill
       * closed, so the close then skipped the line - and the raw materials its
       * recipe consumes were never taken out of the store at all. It also
       * deducted for a bill that might still be cancelled before anyone paid.
       * The deduction now happens once, at close, in closeIfPaid.
       */
    }
    return rows;
  });
  if (!pending.length) return { sent: 0, stations: 0, printed: 0, print_error: null };
  /*
   * Printing is a side effect AFTER the commit, and it must never fail the
   * send. A restaurant that has not set up stations yet - or has the kitchen
   * printer switched off - still needs the order to reach the kitchen board;
   * a throw here left the lines marked sent and showed the waiter an error,
   * which read as "it did not go" when it had.
   */
  let printed = 0;
  const printErrors = [];
  for (const [stationId, items] of byStation) {
    try {
      await printing.queueStationSlip(clientId, orderId, stationId || null, items, userId);
      printed++;
    } catch (e) {
      printErrors.push(e.message);
      log.warn('orders', 'station slip not queued', { stationId, error: e.message });
    }
  }
  return {
    sent: pending.length, stations: byStation.size, printed,
    print_error: printErrors.length ? printErrors[0] : null,
  };
}

/* ------------------------------------------------------------------ */
/* discounts, transfer, split, merge                                  */
/* ------------------------------------------------------------------ */
async function setBillDiscount(clientId, orderId, { amount = null, percent = null, userId, approvedBy = null, reason = '' }) {
  return db.tx(async t => {
    const o = await t.one("SELECT * FROM orders WHERE id=? AND client_id=? AND status='open' FOR UPDATE",
      [orderId, clientId]);
    if (!o) { const e = new Error('Adisyon acik degil'); e.status = 409; throw e; }
    const lines = await t.one(
      'SELECT COALESCE(SUM(line_total),0) v FROM order_items WHERE order_id=? AND client_id=? AND is_deleted=0',
      [orderId, clientId]);
    const base = money(lines.v);
    let disc = amount !== null ? money(amount) : money(base * (Number(percent) || 0) / 100);
    disc = Math.max(0, Math.min(disc, base));
    // one manual row in the ledger, replaced each time the cashier changes it;
    // loyalty rows are left alone so a reward survives a later discount edit
    await t.exec("DELETE FROM order_discounts WHERE order_id=? AND client_id=? AND source='manual'",
      [orderId, clientId]);
    if (disc > 0) {
      await t.exec(
        `INSERT INTO order_discounts (client_id, order_id, discount_value, reason, source, created_by, created_at)
         VALUES (?,?,?,?, 'manual', ?, NOW())`,
        [clientId, orderId, disc, (reason || 'Indirim').slice(0, 190), userId || null]);
    }
    await recalc(t, clientId, orderId);
    await t.insert(
      `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id, after_json, created_at)
       VALUES (?,?,?,?,?,?,?,NOW())`,
      [clientId, userId || null, 'cashier', 'bill.discount', 'bill', String(orderId),
       JSON.stringify({ amount: disc, percent, reason, approvedBy })]);
    const o2 = await t.one('SELECT grand_total FROM orders WHERE id=?', [orderId]);
    return money(o2.grand_total);
  });
}

async function transferTable(clientId, orderId, targetTableId, userId) {
  return db.tx(async t => {
    const o = await t.one("SELECT * FROM orders WHERE id=? AND client_id=? AND status='open'", [orderId, clientId]);
    if (!o) { const e = new Error('Adisyon acik degil'); e.status = 409; throw e; }
    /*
     * The target table has to be THIS restaurant's, and it has to exist.
     *
     * Nothing checked it: `UPDATE orders SET table_id=?` took whatever number
     * arrived, so a mistyped id - or an id belonging to another tenant in the
     * same engine - filed the bill against a table this restaurant does not
     * have. Every screen finds its bills by joining restaurant_tables on
     * client_id, so the bill simply disappeared off the floor plan while the
     * table it came from was freed underneath it, and the only way back was
     * through the database.
     */
    const dest = await t.one(
      'SELECT id, is_active FROM restaurant_tables WHERE id=? AND client_id=?', [targetTableId, clientId]);
    if (!dest) { const e = new Error('Masa bulunamadi'); e.status = 404; throw e; }
    if (!Number(dest.is_active)) { const e = new Error('Kapali bir masaya adisyon tasinamaz'); e.status = 409; throw e; }
    await t.exec('UPDATE orders SET table_id=?, updated_at=NOW() WHERE id=?', [targetTableId, orderId]);
    await t.exec('UPDATE restaurant_tables SET is_occupied=1 WHERE id=? AND client_id=?', [targetTableId, clientId]);
    if (o.table_id) {
      const left = await t.value(
        "SELECT COUNT(*) FROM orders WHERE table_id=? AND client_id=? AND status='open' AND is_deleted=0",
        [o.table_id, clientId]);
      if (!Number(left)) {
        await t.exec('UPDATE restaurant_tables SET is_occupied=0 WHERE id=?', [o.table_id]);
        /*
         * The table's etiket goes with the guests who earned it.
         *
         * "Ahmet Bey", "dogum gunu", "sirket yemegi" describe the party
         * sitting there, not the table, and the next party at 21:30 must not
         * inherit them - a waiter reading a stale name off the floor plan
         * greets the wrong person. So a label dies with the last open bill,
         * IN THE SAME TRANSACTION as the close so it can never outlive it.
         *
         * etiket_kalici=1 is the opposite case and keeps its label: "VIP",
         * "Sigara icilir", "Deniz manzarali" are facts about the table itself
         * and are still true when it is empty.
         */
        await t.exec(
          'UPDATE restaurant_tables SET etiket=NULL, etiket_at=NULL, etiket_by=NULL' +
          ' WHERE id=? AND client_id=? AND COALESCE(etiket_kalici,0)=0', [o.table_id, clientId]);
      }
    }
    await t.insert(
      `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,NOW())`,
      [clientId, userId || null, 'cashier', 'bill.transfer', 'bill', String(orderId),
       JSON.stringify({ table_id: o.table_id }), JSON.stringify({ table_id: targetTableId })]);
    return true;
  });
}

/** Move selected lines (or part of a line) onto a brand new bill. */
async function splitBill(clientId, orderId, lines, userId) {
  const date = await bd.currentBusinessDate();
  return db.tx(async t => {
    const o = await t.one("SELECT * FROM orders WHERE id=? AND client_id=? AND status='open' FOR UPDATE",
      [orderId, clientId]);
    if (!o) { const e = new Error('Adisyon acik degil'); e.status = 409; throw e; }
    const no = await nextAdisyonNo(t, clientId, date);
    /*
     * The split half gets the next free letter on the table, not "A-B". The
     * label is what the waiter reads out, and it has to stay short enough to
     * say and short enough to fit on the floor plan.
     */
    const label = await nextBillLabel(t, clientId, o.table_id);
    const newId = await t.insert(
      `INSERT INTO orders (adisyon_no, client_id, business_date, table_id, waiter_id, status, opened_at,
          total, discount_total, vat_total, grand_total, bill_label, parent_order_id, created_by, created_at, updated_at, shift_id)
       VALUES (?,?,?,?,?, 'open', NOW(), 0,0,0,0, ?, ?, ?, NOW(), NOW(), ?)`,
      [no, clientId, date, o.table_id, o.waiter_id, label, orderId, userId || 0, o.shift_id]);

    for (const l of lines) {
      const it = await t.one('SELECT * FROM order_items WHERE id=? AND order_id=? AND client_id=? AND is_deleted=0',
        [l.itemId, orderId, clientId]);
      if (!it) continue;
      const moveQty = Math.min(money(l.qty || it.qty), Number(it.qty));
      const rest = money(Number(it.qty) - moveQty);
      /*
       * The discount travels with the portions it was given on. Moving the line
       * at plain qty * unit_price left the discount behind on the half that
       * stayed - so splitting a discounted line overcharged one guest and
       * doubled the discount for the other.
       */
      const disc = money(it.discount_amount);
      const moveDisc = money(disc * moveQty / Number(it.qty));
      const restDisc = money(disc - moveDisc);
      const moveTotal = money(moveQty * it.unit_price - moveDisc);
      const sentMoved = Math.min(Number(it.sent_qty), moveQty);
      const newItemId = await t.insert(
        `INSERT INTO order_items (client_id, order_id, product_id, station_id, qty, note, price, unit_price,
            cost_price, total, line_total, discount_amount, vat_rate, stock_applied, sent_qty, is_deleted, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NOW())`,
        [clientId, newId, it.product_id, it.station_id, moveQty, it.note, it.unit_price, it.unit_price,
         it.cost_price, moveTotal, moveTotal, moveDisc, it.vat_rate,
         it.stock_applied, sentMoved]);
      /*
       * The kitchen ticket splits with the line.
       *
       * The board reads station_projection_items, which is keyed on the ORDER
       * ITEM - and a split makes a new item. Nothing moved the projection, so
       * after splitting two of four kebaps the board still showed four against
       * the bill that now only has two, the new bill showed nothing, and the
       * half that walked out with the guest who paid first was still on the
       * pass. Rows are only there for portions that were actually sent, so a
       * line the kitchen never saw stays absent from both bills.
       */
      if (sentMoved > 0) {
        await t.exec(
          `INSERT INTO station_projection_items (client_id, station_id, order_id, order_item_id, product_id,
              qty, station_status, created_at, updated_at)
           SELECT client_id, station_id, ?, ?, product_id, ?, station_status, created_at, NOW()
             FROM station_projection_items WHERE client_id=? AND order_item_id=?
           ON DUPLICATE KEY UPDATE qty=VALUES(qty), order_id=VALUES(order_id), updated_at=NOW()`,
          [newId, newItemId, sentMoved, clientId, it.id]);
      }
      const sentLeft = Math.max(0, Number(it.sent_qty) - moveQty);
      if (sentLeft > 0) {
        await t.exec(
          'UPDATE station_projection_items SET qty=?, updated_at=NOW() WHERE client_id=? AND order_item_id=?',
          [money(sentLeft), clientId, it.id]);
      } else {
        await t.exec(
          'DELETE FROM station_projection_items WHERE client_id=? AND order_item_id=?', [clientId, it.id]);
      }
      if (rest <= 0) {
        await t.exec(
          `UPDATE order_items SET is_deleted=1, total=0, line_total=0, discount_amount=0, updated_at=NOW()
            WHERE id=?`, [it.id]);
      } else {
        const restTotal = money(rest * it.unit_price - restDisc);
        await t.exec(
          `UPDATE order_items SET qty=?, sent_qty=?, discount_amount=?, total=?, line_total=?, updated_at=NOW()
            WHERE id=?`,
          [rest, Math.max(0, Number(it.sent_qty) - moveQty), restDisc, restTotal, restTotal, it.id]);
      }
    }
    await recalc(t, clientId, orderId);
    await recalc(t, clientId, newId);
    // a split moves money onto a bill somebody else will pay - the same class
    // of action as a transfer, and it was the only one with no record of who
    await t.exec(
      `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,NOW())`,
      [clientId, userId || null, 'cashier', 'bill.split', 'bill', String(orderId),
       JSON.stringify({ lines }), JSON.stringify({ new_order_id: newId, table_id: o.table_id })]);
    return newId;
  });
}

/** Pull every line of `sourceId` onto `targetId` and close the source. */
async function mergeBills(clientId, targetId, sourceId, userId) {
  return db.tx(async t => {
    const src = await t.one("SELECT * FROM orders WHERE id=? AND client_id=? AND status='open' FOR UPDATE", [sourceId, clientId]);
    const dst = await t.one("SELECT * FROM orders WHERE id=? AND client_id=? AND status='open' FOR UPDATE", [targetId, clientId]);
    if (!src || !dst) { const e = new Error('Adisyonlardan biri acik degil'); e.status = 409; throw e; }
    await t.exec('UPDATE order_items SET order_id=?, updated_at=NOW() WHERE order_id=? AND client_id=? AND is_deleted=0',
      [targetId, sourceId, clientId]);
    await t.exec('UPDATE order_payments SET order_id=? WHERE order_id=? AND client_id=? AND is_deleted=0',
      [targetId, sourceId, clientId]);
    /*
     * The discount ledger moves too. The lines came across but their discount
     * did not, so merging a bill that had been given 10% off charged that 10%
     * back to the guest at the moment two tables were put together.
     */
    await t.exec('UPDATE order_discounts SET order_id=? WHERE order_id=? AND client_id=?',
      [targetId, sourceId, clientId]);
    /*
     * The kitchen ticket follows the food. Without this the board went on
     * showing the lines against an adisyon that had been cancelled out from
     * under them, so a cook who marked one ready updated a bill nobody was
     * going to be handed.
     */
    await t.exec('UPDATE station_projection_items SET order_id=?, updated_at=NOW() WHERE order_id=? AND client_id=?',
      [targetId, sourceId, clientId]);
    await t.exec("UPDATE orders SET status='cancelled', is_closed=1, closed_at=NOW(), closed_by=?, exclude_from_reports=1, notes=CONCAT(COALESCE(notes,''),' [birlestirildi #',?,']') WHERE id=?",
      [userId || null, targetId, sourceId]);
    await recalc(t, clientId, targetId);
    // the emptied bill is left reading zero rather than keeping the totals of
    // lines it no longer owns, so nothing can ever count them on both bills
    await recalc(t, clientId, sourceId);
    /*
     * Free the table the source bill was standing on.
     *
     * Every other way a bill leaves a table does this - paid, cancelled,
     * transferred - and merge was the one that did not. Putting masa 6's bill
     * onto masa 4 therefore left masa 6 red with nothing open on it, for the
     * rest of the day, and no screen could talk it out of that. If the source
     * was a joined group, the group goes too: its bill no longer exists.
     */
    if (src.table_id && Number(src.table_id) !== Number(dst.table_id)) {
      const left = await t.value(
        "SELECT COUNT(*) FROM orders WHERE table_id=? AND client_id=? AND status='open' AND is_deleted=0",
        [src.table_id, clientId]);
      if (!Number(left)) {
        await require('./tablegroup').freeIfIdle(t, clientId, src.table_id);
      }
    }
    await require('./tablegroup').releaseOnCloseIn(t, clientId, sourceId, userId);
    /*
     * Merging moves other people's money onto this bill and makes an adisyon
     * disappear from the floor. `order_delete_logs` never sees it and neither
     * did audit_logs, so "who put masa 6 onto masa 4" had no answer anywhere.
     */
    await t.exec(
      `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,NOW())`,
      [clientId, userId || null, 'cashier', 'bill.merge', 'bill', String(targetId),
       JSON.stringify({ source_order_id: sourceId, source_table_id: src.table_id, source_total: src.grand_total }),
       JSON.stringify({ target_order_id: targetId, target_table_id: dst.table_id })]);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* closing, reopening, deleting                                       */
/* ------------------------------------------------------------------ */
async function closeIfPaid(t, clientId, orderId, userId) {
  const o = await t.one('SELECT * FROM orders WHERE id=? AND client_id=?', [orderId, clientId]);
  const paid = await t.value(
    'SELECT COALESCE(SUM(amount),0) FROM order_payments WHERE order_id=? AND client_id=? AND is_deleted=0 AND voided_at IS NULL',
    [orderId, clientId]);
  /*
   * A bill with LINES on it and nothing left to pay is finished, and that
   * includes the one that owes nothing at all.
   *
   * The old guard also demanded grand_total > 0, so a bill given away whole -
   * 100% ikram, or a loyalty reward that covered the lot - could never close.
   * addPayment refused it ("odenecek tutar kalmadi"), this refused it, and the
   * bill sat open for ever: the table stayed red, the stock never moved and
   * gun sonu refused to run because a bill was still open. The count of live
   * lines replaces that guard - an EMPTY bill is not "paid", it is empty.
   *
   * Compared in kurus, not with a float epsilon: 0.001 either side of a figure
   * that is exact to the kurus is a tolerance for a problem that no longer exists.
   */
  const lineCount = Number(await t.value(
    'SELECT COUNT(*) FROM order_items WHERE order_id=? AND client_id=? AND is_deleted=0', [orderId, clientId]));
  if (minor(paid) >= minor(o.grand_total) && lineCount > 0) {
    await t.exec("UPDATE orders SET status='closed', is_closed=1, closed_at=NOW(), closed_by=?, updated_at=NOW() WHERE id=?",
      [userId || null, orderId]);

    /*
     * Stock moves in the SAME transaction as the close, through the one funnel
     * every payment path already goes through. In the old system only the
     * "Adisyonu Kapat" button deducted, so a bill settled on the OKC banked the
     * money and never moved the stock - same sale, two different outcomes.
     * Idempotent per line via order_items.stock_applied.
     */
    await inventory.applyStockForOrderIn(t, clientId, orderId, userId);

    if (o.table_id) {
      const left = await t.value(
        "SELECT COUNT(*) FROM orders WHERE table_id=? AND client_id=? AND status='open' AND is_deleted=0",
        [o.table_id, clientId]);
      if (!Number(left)) await t.exec('UPDATE restaurant_tables SET is_occupied=0 WHERE id=?', [o.table_id]);
    }
    // masa birlestirme: the bill covered several tables, so paying it has to
    // free all of them - the loop above only knows about the one it is filed
    // against. Same transaction as the close, or masa 5 stays red.
    await require('./tablegroup').releaseOnCloseIn(t, clientId, orderId, userId);
    // a guest attached to the bill earns their stamps the moment it closes;
    // fired after the transaction so a loyalty problem can never block payment
    setImmediate(() => require('./loyalty').awardForOrder(clientId, orderId, userId).catch(() => {}));
    return true;
  }
  return false;
}

/**
 * Reopen a bill that was closed by mistake.
 * This is the daily pain point the old system could not do: as long as the
 * business day is still open, the same table gets its bill back.
 */
async function reopen(clientId, orderId, { userId, userName, reason = '' }) {
  return db.tx(async t => {
    const o = await t.one('SELECT * FROM orders WHERE id=? AND client_id=? AND is_deleted=0 FOR UPDATE', [orderId, clientId]);
    if (!o) { const e = new Error('Adisyon bulunamadi'); e.status = 404; throw e; }
    if (o.status === 'open') return { alreadyOpen: true };
    const closed = await t.one('SELECT id FROM daily_closings WHERE client_id=? AND date=?', [clientId, o.business_date]);
    if (closed) { const e = new Error('Gun sonu alinmis adisyon acilamaz.'); e.status = 409; throw e; }
    await t.exec(
      `UPDATE orders SET status='open', is_closed=0, closed_at=NULL, closed_by=NULL,
          reopen_count=reopen_count+1, reopened_at=NOW(), reopened_by=?, reopened_label=?, updated_at=NOW()
        WHERE id=?`, [userId || null, userName || null, orderId]);
    if (o.table_id) await t.exec('UPDATE restaurant_tables SET is_occupied=1 WHERE id=?', [o.table_id]);
    /*
     * Put the stock back. The close took it out; a bill that is open again has
     * not been sold, and leaving the deduction in place meant re-closing it
     * never deducted a second time (stock_applied was still 1) - so a bill
     * reopened and closed again came out of the store exactly once for two
     * closes, or never for the second guest.
     */
    await inventory.reverseStockForOrderIn(t, clientId, orderId, userId);
    await t.insert(
      `INSERT INTO audit_logs (client_id, actor_client_id, role, action, entity_type, entity_id, after_json, created_at)
       VALUES (?,?,?,?,?,?,?,NOW())`,
      [clientId, userId || null, 'cashier', 'bill.reopen', 'bill', String(orderId), JSON.stringify({ reason })]);
    return { reopened: true };
  });
}

/*
 * The cancel itself, joined to a transaction the caller already owns.
 *
 * The permanent delete in `modules/finance` has to unwind a bill - stock,
 * recipe materials, the kitchen board, the table, the group - and then remove
 * what is left, and those two halves must be one transaction or a crash
 * between them leaves stock counting a dinner that no longer exists. So the
 * body lives here and `deleteBill` is the wrapper that opens its own.
 */
async function deleteBillIn(t, clientId, orderId, { userId, reason, ip, ua, approvedBy }) {
  {
    const o = await t.one('SELECT * FROM orders WHERE id=? AND client_id=? FOR UPDATE', [orderId, clientId]);
    if (!o) { const e = new Error('Adisyon bulunamadi'); e.status = 404; throw e; }
    const items = await t.query('SELECT * FROM order_items WHERE order_id=? AND client_id=?', [orderId, clientId]);
    const pays = await t.query('SELECT * FROM order_payments WHERE order_id=? AND client_id=?', [orderId, clientId]);
    await t.insert(
      `INSERT INTO order_delete_logs (client_id, order_id, bill_label, adisyon_no, table_id, waiter_id,
          opened_at, closed_at, total, discount_total, grand_total, deleted_at, deleted_by, reason,
          ip_address, user_agent, original_data)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),?,?,?,?,?)`,
      [clientId, orderId, o.bill_label, o.adisyon_no, o.table_id, o.waiter_id, o.opened_at, o.closed_at,
       o.total, o.discount_total, o.grand_total, userId || 0, reason || '', ip || null, ua || null,
       JSON.stringify({ order: o, items, payments: pays, approvedBy })]);
    /*
     * Give back the finished goods AND the raw materials the recipe ate, and
     * reset stock_applied so a re-closed bill deducts again. The old system
     * reversed the movement but left the flag at 1, so a cancelled and
     * re-closed bill put stock back and never took it out a second time.
     */
    await inventory.reverseStockForOrderIn(t, clientId, orderId, userId);
    await t.exec('UPDATE orders SET is_deleted=1, exclude_from_reports=1, status=\'cancelled\', is_closed=1, updated_at=NOW() WHERE id=?', [orderId]);
    await t.exec('UPDATE order_items SET is_deleted=1 WHERE order_id=? AND client_id=?', [orderId, clientId]);
    await t.exec('UPDATE order_payments SET is_deleted=1, deleted_at=NOW(), deleted_by=? WHERE order_id=? AND client_id=?',
      [userId || null, orderId, clientId]);
    /*
     * The kitchen has to be told. A bill taken off the books left its tickets
     * sitting on the station board as 'new', so the cook went on making food
     * for an adisyon that no longer existed and nobody was going to pay for.
     */
    await t.exec(
      "UPDATE station_projection_items SET station_status='cancelled', updated_at=NOW() WHERE client_id=? AND order_id=?",
      [clientId, orderId]);
    if (o.table_id) {
      const left = await t.value("SELECT COUNT(*) FROM orders WHERE table_id=? AND client_id=? AND status='open' AND is_deleted=0",
        [o.table_id, clientId]);
      if (!Number(left)) await t.exec('UPDATE restaurant_tables SET is_occupied=0 WHERE id=?', [o.table_id]);
    }
    /*
     * masa birlestirme: deleting the group's ONLY bill has to break the group
     * up, exactly as paying it does. It did not, so the other tables of the
     * join stayed red for ever with nothing open on them - and because the
     * group was still 'open' they could not be joined to anything else either.
     */
    await require('./tablegroup').releaseOnCloseIn(t, clientId, orderId, userId);
    return true;
  }
}

async function deleteBill(clientId, orderId, opts) {
  return db.tx(async t => deleteBillIn(t, clientId, orderId, opts || {}));
}

/** Bills a cashier may want back: closed today, still inside the open day. */
/**
 * Closed bills, newest first.
 *
 * `date` is the BUSINESS day, not the calendar day - a bill closed at 02:00
 * belongs to the night still being worked, and looking for it under tomorrow's
 * date is exactly how a cashier concludes it has vanished.
 */
async function recentClosed(clientId, limit = 40, date = null) {
  const day = date || await bd.currentBusinessDate();
  return db.query(
    `SELECT o.id, o.adisyon_no, o.bill_label, o.grand_total, o.closed_at, o.reopen_count,
            t.name AS table_name, u.display_name AS closed_by_name
       FROM orders o
       -- scoped, like every other join in this file: without client_id these
       -- two hand back another tenant's table name and another tenant's staff
       LEFT JOIN restaurant_tables t ON t.id=o.table_id AND t.client_id=o.client_id
       LEFT JOIN users u ON u.id=o.closed_by AND u.client_id=o.client_id
      WHERE o.client_id=? AND o.business_date=? AND o.status='closed' AND o.is_deleted=0
      ORDER BY o.closed_at DESC LIMIT ?`, [clientId, day, Number(limit) || 40]);
}

module.exports = {
  setNotes,
  nextBillLabel, renameBill,
  getOrder, openOrdersForTable, tablePlan, openOrder, openOrGetOrder, addItem, updateItem,
  cancelItem, sendToStations, setBillDiscount, transferTable, splitBill, mergeBills,
  reopen, deleteBill, deleteBillIn, recentClosed, recalc, closeIfPaid, nextAdisyonNo,
};

/* ------------------------------------------------------------------ */
/* masa birlestirme overlay                                           */
/* ------------------------------------------------------------------ */
/**
 * Joined tables, seen by everything that already reads a bill or the plan.
 *
 * Both queries above are left exactly as they were and are wrapped instead,
 * for two reasons. The name a group prints under is needed by the kitchen
 * slip, the hesap fisi, the e-mailed copy and the till header, and every one
 * of those reaches the bill through getOrder - stamping it once here is the
 * only way they cannot disagree. And the floor plan counts a table as busy by
 * the bills filed against it, which the other tables of a group do not have;
 * without the overlay masa 5 reads "bos" with four people sitting at it.
 *
 * Both are a no-op when nothing is joined: a bill with no table_session_id and
 * a restaurant with no open group come back byte-identical.
 */
const _plainGetOrder = getOrder;
const _plainTablePlan = tablePlan;

module.exports.getOrder = async function getOrderWithGroup(clientId, orderId) {
  const o = await _plainGetOrder(clientId, orderId);
  if (!o || !o.table_session_id) return o;
  return require('./tablegroup').decorateOrder(clientId, o);
};

module.exports.tablePlan = async function tablePlanWithGroups(clientId) {
  return require('./tablegroup').overlayPlan(clientId, await _plainTablePlan(clientId));
};
