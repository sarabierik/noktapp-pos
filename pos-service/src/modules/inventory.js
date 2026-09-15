'use strict';
/**
 * STOK / DEPO - raw materials, purchases, counts, waste, transfers, recipes.
 *
 * The system this replaces had two stock worlds that never spoke. Raw
 * materials lived in `inventory_items` and were filled by purchase documents;
 * menu items lived in `products` and had a `product_stock` row written by five
 * files and read by none. Nothing joined them, so selling a pide never
 * consumed a gram of flour. Five things are done differently here, and each
 * one is a bug that was in front of a customer:
 *
 *  1. `product_recipes` is the join that did not exist. A sold product now
 *     consumes its raw materials.
 *  2. Stock levels are DERIVED FROM THE LEDGER, every time, by one function
 *     (`levels`). The old code had a ledger, a cache table with two
 *     incompatible writers and no readers, and a per-product counter with no
 *     reader either. Three numbers, none of them trusted. There is now one.
 *  3. Deduction happens in exactly one place - `applyStockForOrder` - which
 *     every close path is expected to call. The old system had four
 *     near-identical copies and the OKC payment path had none at all, so
 *     paying by card banked the money and left the stock untouched.
 *  4. It is idempotent per LINE, via `order_items.stock_applied`. The old code
 *     set that flag on every row of the order - deleted lines, untracked
 *     products, everything - and its cancel path never reset it, so a
 *     re-closed bill deducted nothing.
 *  5. A draft purchase document moves NOTHING. In the old system approval was
 *     decorative: the draft had already written the ledger, and the only
 *     difference approval made was whether the cost report counted it.
 *
 * `inventory_stock_cache` is deliberately left alone. It is a fourth number
 * nobody reads and writing it would only make a fifth thing to disagree with.
 */
const db = require('../db');
// the one money() in the service - a private copy here is how two files start
// disagreeing about a kurus
const { money } = require('../util/http');

const UNITS = ['pcs', 'kg', 'g', 'lt', 'ml', 'pack'];
const UNIT_LABEL = { pcs: 'Adet', kg: 'Kg', g: 'Gram', lt: 'Litre', ml: 'ml', pack: 'Paket' };
/*
 * Why waste needs a reason list rather than a free-text box: "bozuldu" and
 * "düşürüldü" and "yanlış hazırlandı" are three different management problems.
 * A single zayi total that hides which one happened tells the owner nothing.
 */
const WASTE_REASONS = {
  spoiled: 'Bozuldu / son kullanma',
  broken: 'Kırıldı / döküldü',
  kitchen: 'Mutfak hatası',
  theft: 'Kayıp / çalıntı',
  staff: 'Personel yemeği',
  other: 'Diğer',
};

function q3(v) { return Math.round((Number(v) || 0) * 1000) / 1000; }
function cost4(v) { return Math.round((Number(v) || 0) * 10000) / 10000; }
function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/* ====================================================================== */
/*  Units and categories                                                   */
/* ====================================================================== */

/**
 * The unit list is fixed by the column: `inventory_items.unit` is an enum, and
 * the old OCR importer wrote free text into it, which MariaDB silently turned
 * into '' in a non-strict session. `inventory_units` stays available as the
 * owner's own naming, but it can never decide what goes in the column.
 */
function units() {
  return UNITS.map(u => ({ code: u, label: UNIT_LABEL[u] }));
}
function normUnit(u) {
  const s = String(u || '').trim().toLowerCase();
  if (UNITS.includes(s)) return s;
  const alias = { adet: 'pcs', ad: 'pcs', kilo: 'kg', kilogram: 'kg', gr: 'g', gram: 'g',
    litre: 'lt', l: 'lt', paket: 'pack', koli: 'pack' };
  return alias[s] || 'pcs';
}

async function customUnits(clientId) {
  return db.query('SELECT id, name FROM inventory_units WHERE client_id=? ORDER BY name', [clientId]);
}
async function saveCustomUnit(clientId, name) {
  const n = String(name || '').trim();
  if (!n) throw bad('Birim adı boş olamaz');
  await db.exec('INSERT IGNORE INTO inventory_units (client_id, name, created_at) VALUES (?,?,NOW())', [clientId, n]);
  return db.value('SELECT id FROM inventory_units WHERE client_id=? AND name=?', [clientId, n]);
}
async function deleteCustomUnit(clientId, id) {
  await db.exec('DELETE FROM inventory_units WHERE id=? AND client_id=?', [id, clientId]);
}

async function categories(clientId) {
  return db.query('SELECT id, name FROM inventory_categories WHERE client_id=? ORDER BY name', [clientId]);
}
async function saveCategory(clientId, name) {
  const n = String(name || '').trim();
  if (!n) throw bad('Kategori adı boş olamaz');
  await db.exec('INSERT IGNORE INTO inventory_categories (client_id, name, created_at) VALUES (?,?,NOW())', [clientId, n]);
  return db.value('SELECT id FROM inventory_categories WHERE client_id=? AND name=?', [clientId, n]);
}

/* ====================================================================== */
/*  Locations                                                              */
/* ====================================================================== */

/**
 * One depot is created on demand so a restaurant that never opens a second one
 * never has to think about locations at all. A ledger row with a NULL location
 * means the default depot - that is what every row written before this module
 * existed meant, and rewriting history to say so would be a lie.
 */
async function locations(clientId) {
  return db.query(
    'SELECT id, name, is_default, is_active FROM inventory_locations WHERE client_id=? ORDER BY is_default DESC, name',
    [clientId]);
}
async function defaultLocation(clientId) {
  let row = await db.one('SELECT id FROM inventory_locations WHERE client_id=? AND is_default=1', [clientId]);
  if (row) return row.id;
  row = await db.one('SELECT id FROM inventory_locations WHERE client_id=? ORDER BY id LIMIT 1', [clientId]);
  if (row) return row.id;
  return db.insert(
    'INSERT INTO inventory_locations (client_id, name, is_default, is_active, created_at) VALUES (?,?,1,1,NOW())',
    [clientId, 'Ana Depo']);
}
async function saveLocation(clientId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw bad('Depo adı boş olamaz');
  if (data.id) {
    await db.exec('UPDATE inventory_locations SET name=?, is_active=? WHERE id=? AND client_id=?',
      [name, data.is_active === false ? 0 : 1, data.id, clientId]);
    if (data.is_default) {
      await db.exec('UPDATE inventory_locations SET is_default=0 WHERE client_id=?', [clientId]);
      await db.exec('UPDATE inventory_locations SET is_default=1 WHERE id=? AND client_id=?', [data.id, clientId]);
    }
    return Number(data.id);
  }
  const id = await db.insert(
    'INSERT INTO inventory_locations (client_id, name, is_default, is_active, created_at) VALUES (?,?,?,1,NOW())',
    [clientId, name, data.is_default ? 1 : 0]);
  if (data.is_default) await db.exec('UPDATE inventory_locations SET is_default=0 WHERE client_id=? AND id<>?', [clientId, id]);
  return id;
}

/* ====================================================================== */
/*  Items                                                                  */
/* ====================================================================== */

async function items(clientId, { q = '', onlyActive = true } = {}) {
  const args = [clientId];
  let where = 'i.client_id=?';
  if (onlyActive) where += ' AND i.is_active=1';
  if (q) { where += ' AND (i.name LIKE ? OR i.sku LIKE ? OR i.barcode LIKE ?)'; args.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  return db.query(
    `SELECT i.*, c.name AS category_name
       FROM inventory_items i
       LEFT JOIN inventory_categories c ON c.id=i.category_id AND c.client_id=i.client_id
      WHERE ${where} ORDER BY i.name`, args);
}

async function getItem(clientId, id) {
  return db.one('SELECT * FROM inventory_items WHERE id=? AND client_id=?', [id, clientId]);
}

async function saveItem(clientId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw bad('Malzeme adı boş olamaz');
  const unit = normUnit(data.unit);
  if (data.id) {
    await db.exec(
      `UPDATE inventory_items SET name=?, sku=?, barcode=?, unit=?, category_id=?, min_qty=?, is_active=?,
              updated_at=NOW() WHERE id=? AND client_id=?`,
      [name, data.sku || null, data.barcode || null, unit, data.category_id || null,
       q3(data.min_qty), data.is_active === false ? 0 : 1, data.id, clientId]);
    return Number(data.id);
  }
  return db.insert(
    `INSERT INTO inventory_items (client_id, name, sku, barcode, unit, category_id, min_qty, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,1,NOW())`,
    [clientId, name, data.sku || null, data.barcode || null, unit, data.category_id || null, q3(data.min_qty)]);
}

/**
 * Deleting an item that has ever moved is refused.
 *
 * The PHP `item_delete.php` was one unguarded DELETE. It left the ledger, the
 * cache and the document lines pointing at an id that no longer existed - live
 * data still holds 210 units and 278.740 TL of purchase value belonging to two
 * items nobody can see, because the stock screen joins FROM `inventory_items`.
 * An item with history is deactivated instead: the history stays readable and
 * the item stops appearing on the purchase form.
 */
async function deleteItem(clientId, id) {
  const moved = Number(await db.value(
    'SELECT COUNT(*) FROM inventory_stock_ledger WHERE client_id=? AND item_id=?', [clientId, id]));
  const onDocs = Number(await db.value(
    `SELECT COUNT(*) FROM inventory_document_items di
       JOIN inventory_documents d ON d.id=di.document_id
      WHERE d.client_id=? AND di.item_id=?`, [clientId, id]));
  const inRecipes = Number(await db.value(
    'SELECT COUNT(*) FROM product_recipes WHERE client_id=? AND inventory_item_id=?', [clientId, id]));
  if (moved || onDocs || inRecipes) {
    await db.exec('UPDATE inventory_items SET is_active=0, updated_at=NOW() WHERE id=? AND client_id=?', [id, clientId]);
    return { deactivated: true, reason: 'Bu malzemenin hareket geçmişi var, silinmedi; pasife alındı.' };
  }
  await db.exec('DELETE FROM inventory_items WHERE id=? AND client_id=?', [id, clientId]);
  return { deleted: true };
}

/* ====================================================================== */
/*  Suppliers                                                              */
/* ====================================================================== */

async function suppliers(clientId, { onlyActive = false } = {}) {
  return db.query(
    `SELECT s.*,
            (SELECT COUNT(*) FROM inventory_documents d
              WHERE d.client_id=s.client_id AND d.supplier_id=s.id AND d.status='approved') AS doc_count,
            (SELECT COALESCE(SUM(d.total_amount),0) FROM inventory_documents d
              WHERE d.client_id=s.client_id AND d.supplier_id=s.id AND d.status='approved') AS total_purchased
       FROM suppliers s
      WHERE s.client_id=? ${onlyActive ? 'AND s.is_active=1' : ''}
      ORDER BY s.name`, [clientId]);
}

async function saveSupplier(clientId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw bad('Tedarikçi adı boş olamaz');
  /*
   * `suppliers` carries UNIQUE(client_id, vkn) and the column defaults to ''.
   * Two suppliers without a tax number therefore collide on the empty string,
   * which is why the old detector created duplicates under different names and
   * then failed outright on the third. An absent VKN is stored as NULL, which
   * a UNIQUE index lets repeat as often as it likes.
   */
  const vkn = String(data.vkn || '').trim() || null;
  if (data.id) {
    await db.exec(
      `UPDATE suppliers SET name=?, vkn=?, vergi_dairesi=?, phone=?, email=?, address=?, is_active=?, updated_at=NOW()
        WHERE id=? AND client_id=?`,
      [name, vkn, data.vergi_dairesi || '', data.phone || '', data.email || '', data.address || null,
       data.is_active === false ? 0 : 1, data.id, clientId]);
    return Number(data.id);
  }
  return db.insert(
    `INSERT INTO suppliers (client_id, name, vkn, vergi_dairesi, phone, email, address, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,1,NOW())`,
    [clientId, name, vkn, data.vergi_dairesi || '', data.phone || '', data.email || '', data.address || null]);
}

async function deleteSupplier(clientId, id) {
  const used = Number(await db.value(
    'SELECT COUNT(*) FROM inventory_documents WHERE client_id=? AND supplier_id=?', [clientId, id]));
  if (used) {
    await db.exec('UPDATE suppliers SET is_active=0, updated_at=NOW() WHERE id=? AND client_id=?', [id, clientId]);
    return { deactivated: true, reason: 'Bu tedarikçinin faturaları var, silinmedi; pasife alındı.' };
  }
  await db.exec('DELETE FROM suppliers WHERE id=? AND client_id=?', [id, clientId]);
  return { deleted: true };
}

/* ====================================================================== */
/*  Purchase documents:  draft -> approve -> ledger                        */
/* ====================================================================== */

async function documents(clientId, { status = null, from = null, to = null, limit = 200 } = {}) {
  const args = [clientId];
  let where = 'd.client_id=?';
  if (status) { where += ' AND d.status=?'; args.push(status); }
  if (from) { where += ' AND d.document_date>=?'; args.push(from); }
  if (to) { where += ' AND d.document_date<=?'; args.push(to); }
  args.push(Number(limit) || 200);
  return db.query(
    `SELECT d.*, s.name AS supplier_name,
            (SELECT COUNT(*) FROM inventory_document_items x WHERE x.document_id=d.id) AS line_count
       FROM inventory_documents d
       LEFT JOIN suppliers s ON s.id=d.supplier_id
      WHERE ${where} ORDER BY d.document_date DESC, d.id DESC LIMIT ?`, args);
}

async function getDocument(clientId, id) {
  const doc = await db.one(
    `SELECT d.*, s.name AS supplier_name FROM inventory_documents d
       LEFT JOIN suppliers s ON s.id=d.supplier_id
      WHERE d.id=? AND d.client_id=?`, [id, clientId]);
  if (!doc) return null;
  doc.items = await db.query(
    `SELECT di.*, i.name AS item_name, i.unit AS item_unit
       FROM inventory_document_items di
       LEFT JOIN inventory_items i ON i.id=di.item_id
      WHERE di.document_id=? ORDER BY di.id`, [id]);
  return doc;
}

/**
 * Save a purchase as a DRAFT. Nothing about stock happens here.
 *
 * This is the deviation that matters most. The PHP wrote `inventory_stock_ledger`
 * inside the same transaction that created the document, whatever status the
 * user picked, so a "draft" already had raised stock and "approval" only
 * decided whether the cost report counted it. Approval is now the event that
 * commits the movement, which is what everybody assumed it already was.
 */
async function saveDocument(clientId, data, userId) {
  const lines = (data.items || []).filter(l => l && (l.item_id || l.raw_name));
  if (!lines.length) throw bad('Faturada en az bir satır olmalı');
  return db.tx(async t => {
    let docId = data.id ? Number(data.id) : null;
    if (docId) {
      const cur = await t.one('SELECT status FROM inventory_documents WHERE id=? AND client_id=? FOR UPDATE',
        [docId, clientId]);
      if (!cur) throw bad('Belge bulunamadı', 404);
      // an approved document has already moved stock; editing it would move the
      // stock silently a second time, which is exactly how the old ledger drifted
      if (cur.status !== 'draft') throw bad('Onaylanmış belge değiştirilemez. Önce iptal edin.', 409);
      await t.exec(
        `UPDATE inventory_documents SET supplier_id=?, type=?, document_no=?, document_date=?, note=?
          WHERE id=? AND client_id=?`,
        [data.supplier_id || null, data.type || 'purchase', data.document_no || null,
         data.document_date, data.note || null, docId, clientId]);
      await t.exec('DELETE FROM inventory_document_items WHERE document_id=?', [docId]);
    } else {
      docId = await t.insert(
        `INSERT INTO inventory_documents (client_id, supplier_id, type, document_no, document_date,
            total_amount, status, source, note, created_by, created_at)
         VALUES (?,?,?,?,?,0,'draft',?,?,?,NOW())`,
        [clientId, data.supplier_id || null, data.type || 'purchase', data.document_no || null,
         data.document_date, data.source || 'manual', data.note || null, userId || 0]);
    }

    let total = 0;
    for (const l of lines) {
      const qty = q3(l.quantity);
      if (qty <= 0) throw bad('Miktar sıfırdan büyük olmalı: ' + (l.raw_name || l.item_id));
      const unitPrice = cost4(l.unit_price);
      const lineTotal = money(qty * unitPrice);
      const vatRate = Number(l.vat_rate) || 0;
      // Turkish invoice lines are quoted KDV-inclusive, so the VAT is taken out
      // of the line, not added on top of it. The PHP did the same sum but with
      // the rate as a divisor typo away from being wrong; it is spelled out here.
      const vatAmount = money(lineTotal * vatRate / (100 + vatRate));
      total += lineTotal;
      await t.insert(
        `INSERT INTO inventory_document_items (document_id, item_id, raw_name, quantity, unit,
            unit_price, total_price, vat_rate, vat_amount, matched_confidence, is_approved)
         VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
        [docId, l.item_id || null, String(l.raw_name || l.name || '').slice(0, 255), qty,
         normUnit(l.unit), unitPrice, lineTotal, vatRate, vatAmount, l.matched_confidence || null]);
    }
    await t.exec('UPDATE inventory_documents SET total_amount=? WHERE id=?', [money(total), docId]);
    return docId;
  });
}

/** Approving is what commits the stock. It is the only door into the ledger for a purchase. */
async function approveDocument(clientId, docId, userId) {
  return db.tx(async t => {
    const doc = await t.one('SELECT * FROM inventory_documents WHERE id=? AND client_id=? FOR UPDATE',
      [docId, clientId]);
    if (!doc) throw bad('Belge bulunamadı', 404);
    if (doc.status === 'approved') throw bad('Bu belge zaten onaylı', 409);
    if (doc.status === 'cancelled') throw bad('İptal edilmiş belge onaylanamaz', 409);

    const lines = await t.query('SELECT * FROM inventory_document_items WHERE document_id=?', [docId]);
    const unmatched = lines.filter(l => !l.item_id);
    if (unmatched.length) {
      throw bad('Eşleşmeyen satır var: ' + unmatched.map(l => l.raw_name).join(', ') +
                ' — her satırı bir malzemeye bağlayın.');
    }
    const locId = doc.location_id || null;
    for (const l of lines) {
      await t.insert(
        `INSERT INTO inventory_stock_ledger (client_id, item_id, source_type, source_id, location_id,
            quantity_in, quantity_out, unit_cost, note, created_by, created_at)
         VALUES (?,?, 'document', ?, ?, ?, 0, ?, ?, ?, NOW())`,
        [clientId, l.item_id, docId, locId, l.quantity, l.unit_price,
         'Alış: ' + (doc.document_no || ('#' + docId)), userId || null]);
      await t.exec('UPDATE inventory_document_items SET is_approved=1 WHERE id=?', [l.id]);
    }
    await t.exec(
      "UPDATE inventory_documents SET status='approved', approved_by=?, approved_at=NOW() WHERE id=?",
      [userId || null, docId]);
    return { approved: true, lines: lines.length };
  });
}

/**
 * Cancel a document. An approved one is reversed with offsetting ledger rows
 * rather than by deleting the originals: the arithmetic is the same and the
 * history survives, so "why did 40 kg appear and vanish on Tuesday" is a
 * question the ledger can still answer.
 */
async function cancelDocument(clientId, docId, userId) {
  return db.tx(async t => {
    const doc = await t.one('SELECT * FROM inventory_documents WHERE id=? AND client_id=? FOR UPDATE',
      [docId, clientId]);
    if (!doc) throw bad('Belge bulunamadı', 404);
    if (doc.status === 'cancelled') return { alreadyCancelled: true };
    if (doc.status === 'approved') {
      const rows = await t.query(
        `SELECT * FROM inventory_stock_ledger
          WHERE client_id=? AND source_type='document' AND source_id=?`, [clientId, docId]);
      for (const r of rows) {
        const inQ = Number(r.quantity_in), outQ = Number(r.quantity_out);
        await t.insert(
          `INSERT INTO inventory_stock_ledger (client_id, item_id, source_type, source_id, location_id,
              quantity_in, quantity_out, unit_cost, note, created_by, created_at)
           VALUES (?,?, 'document', ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [clientId, r.item_id, docId, r.location_id, outQ, inQ, r.unit_cost,
           'Fatura iptali #' + docId, userId || null]);
      }
    }
    await t.exec("UPDATE inventory_documents SET status='cancelled' WHERE id=?", [docId]);
    return { cancelled: true };
  });
}

/* ====================================================================== */
/*  Stock levels - derived from the ledger, and from nowhere else          */
/* ====================================================================== */

/*
 * The one query that says how much of anything there is.
 *
 * qty      = SUM(in) - SUM(out)
 * avg_cost = SUM(in * unit_cost) / SUM(in), over the rows that carry a cost
 *
 * Weighted average and not FIFO on purpose: a restaurant buys the same flour
 * from the same supplier every week, and the extra bookkeeping FIFO needs
 * would buy an accuracy nobody here can act on.
 */
const LEVEL_SQL = `
  SELECT i.id, i.name, i.sku, i.barcode, i.unit, i.min_qty, i.is_active, i.category_id,
         c.name AS category_name,
         COALESCE(l.qty, 0)            AS qty,
         COALESCE(l.avg_cost, 0)       AS avg_cost,
         ROUND(COALESCE(l.qty,0) * COALESCE(l.avg_cost,0), 2) AS stock_value,
         l.last_move_at
    FROM inventory_items i
    LEFT JOIN inventory_categories c ON c.id=i.category_id AND c.client_id=i.client_id
    LEFT JOIN (
      SELECT item_id,
             SUM(quantity_in) - SUM(quantity_out) AS qty,
             CASE WHEN SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE quantity_in END) > 0
                  THEN SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE quantity_in * unit_cost END)
                     / SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE quantity_in END)
                  ELSE 0 END AS avg_cost,
             MAX(created_at) AS last_move_at
        FROM inventory_stock_ledger WHERE client_id=:cid GROUP BY item_id
    ) l ON l.item_id = i.id
   WHERE i.client_id=:cid`;

function levelSql(extra = '') {
  return LEVEL_SQL.replace(/:cid/g, '?') + extra;
}

async function levels(clientId, { onlyActive = true, q = '', criticalOnly = false } = {}) {
  // :cid appears twice in the SQL above (inner aggregate + outer filter)
  const args = [clientId, clientId];
  let extra = onlyActive ? ' AND i.is_active=1' : '';
  if (q) { extra += ' AND (i.name LIKE ? OR i.sku LIKE ? OR i.barcode LIKE ?)'; args.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  if (criticalOnly) extra += ' AND i.min_qty > 0 AND COALESCE(l.qty,0) <= i.min_qty';
  extra += ' ORDER BY i.name';
  const rows = await db.query(levelSql(extra), args);
  for (const r of rows) {
    r.qty = q3(r.qty);
    r.avg_cost = cost4(r.avg_cost);
    r.stock_value = money(r.stock_value);
    r.min_qty = q3(r.min_qty);
    r.is_critical = Number(r.min_qty) > 0 && r.qty <= Number(r.min_qty);
    r.unit_label = UNIT_LABEL[r.unit] || r.unit;
  }
  return rows;
}

async function levelFor(clientId, itemId) {
  const rows = await db.query(levelSql(' AND i.id=?'), [clientId, clientId, itemId]);
  return rows.length ? { ...rows[0], qty: q3(rows[0].qty), avg_cost: cost4(rows[0].avg_cost) } : null;
}

/** Current weighted-average cost, used to value a sale, a count or a waste line. */
async function avgCostIn(t, clientId, itemId) {
  const v = await t.value(
    `SELECT CASE WHEN SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE quantity_in END) > 0
                 THEN SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE quantity_in * unit_cost END)
                    / SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE quantity_in END)
                 ELSE 0 END
       FROM inventory_stock_ledger WHERE client_id=? AND item_id=?`, [clientId, itemId]);
  return cost4(v || 0);
}

async function _qtyIn(t, clientId, itemId) {
  const v = await t.value(
    'SELECT COALESCE(SUM(quantity_in) - SUM(quantity_out), 0) FROM inventory_stock_ledger WHERE client_id=? AND item_id=?',
    [clientId, itemId]);
  return q3(v || 0);
}

/** Dashboard tiles: how many items, how much stock, what it is worth, what is short. */
async function summary(clientId) {
  const rows = await levels(clientId, { onlyActive: true });
  const critical = rows.filter(r => r.is_critical);
  return {
    item_count: rows.length,
    total_qty: q3(rows.reduce((s, r) => s + r.qty, 0)),
    total_value: money(rows.reduce((s, r) => s + r.stock_value, 0)),
    critical_count: critical.length,
    negative_count: rows.filter(r => r.qty < 0).length,
    draft_documents: Number(await db.value(
      "SELECT COUNT(*) FROM inventory_documents WHERE client_id=? AND status='draft'", [clientId])),
    open_counts: Number(await db.value(
      "SELECT COUNT(*) FROM inventory_counts WHERE client_id=? AND status='draft'", [clientId])),
  };
}

/** Every movement of one item, newest first - the screen a chef opens to argue with the numbers. */
async function ledger(clientId, itemId, limit = 200) {
  return db.query(
    `SELECT l.*, u.display_name AS user_name
       FROM inventory_stock_ledger l
       LEFT JOIN users u ON u.id=l.created_by
      WHERE l.client_id=? AND l.item_id=?
      ORDER BY l.id DESC LIMIT ?`, [clientId, itemId, Number(limit) || 200]);
}

/**
 * Ledger rows whose item no longer exists. The PHP deleted items outright and
 * left these behind, invisible to every screen because they all join FROM the
 * item table. `deleteItem` above stops new ones appearing; this reports the
 * ones already there so somebody can decide what they were.
 */
async function orphanLedger(clientId) {
  return db.query(
    `SELECT l.item_id, SUM(l.quantity_in) - SUM(l.quantity_out) AS qty, COUNT(*) AS moves
       FROM inventory_stock_ledger l
       LEFT JOIN inventory_items i ON i.id=l.item_id AND i.client_id=l.client_id
      WHERE l.client_id=? AND i.id IS NULL
      GROUP BY l.item_id`, [clientId]);
}

/* ====================================================================== */
/*  Recipes - the link that did not exist                                  */
/* ====================================================================== */

async function recipeFor(clientId, productId) {
  return db.query(
    `SELECT r.*, i.name AS item_name, i.unit, i.is_active AS item_active
       FROM product_recipes r
       JOIN inventory_items i ON i.id=r.inventory_item_id AND i.client_id=r.client_id
      WHERE r.client_id=? AND r.product_id=? ORDER BY i.name`, [clientId, productId]);
}

/** Products that have a recipe, for the "which products consume stock" list. */
async function recipeProducts(clientId) {
  return db.query(
    `SELECT p.id, p.name, p.price, p.cost_price, c.name AS category_name,
            COUNT(r.id) AS line_count,
            COALESCE(SUM(r.qty_per_unit * COALESCE(ac.avg_cost,0)), 0) AS recipe_cost
       FROM products p
       LEFT JOIN categories c ON c.id=p.category_id
       LEFT JOIN product_recipes r ON r.product_id=p.id AND r.client_id=p.client_id
       LEFT JOIN (
         SELECT item_id,
                CASE WHEN SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE quantity_in END) > 0
                     THEN SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE quantity_in * unit_cost END)
                        / SUM(CASE WHEN unit_cost IS NULL THEN 0 ELSE quantity_in END)
                     ELSE 0 END AS avg_cost
           FROM inventory_stock_ledger WHERE client_id=? GROUP BY item_id
       ) ac ON ac.item_id = r.inventory_item_id
      WHERE p.client_id=? AND p.is_active=1
      GROUP BY p.id, p.name, p.price, p.cost_price, c.name
      ORDER BY line_count DESC, p.name`, [clientId, clientId]);
}

/**
 * Replace a product's recipe with the lines given. Whole-recipe replace rather
 * than line edits: a recipe is read as one thing ("bir pide neyden yapılır"),
 * and a half-applied edit is a silently wrong cost on every sale after it.
 */
async function saveRecipe(clientId, productId, lines) {
  const p = await db.one('SELECT id FROM products WHERE id=? AND client_id=?', [productId, clientId]);
  if (!p) throw bad('Ürün bulunamadı', 404);
  return db.tx(async t => {
    await t.exec('DELETE FROM product_recipes WHERE client_id=? AND product_id=?', [clientId, productId]);
    let n = 0;
    for (const l of lines || []) {
      const itemId = Number(l.inventory_item_id || l.item_id);
      const qty = Number(l.qty_per_unit);
      if (!itemId || !(qty > 0)) continue;
      const item = await t.one('SELECT id FROM inventory_items WHERE id=? AND client_id=?', [itemId, clientId]);
      if (!item) throw bad('Malzeme bulunamadı: ' + itemId, 400);
      await t.exec(
        `INSERT INTO product_recipes (client_id, product_id, inventory_item_id, qty_per_unit, created_at, updated_at)
         VALUES (?,?,?,?,NOW(),NOW())
         ON DUPLICATE KEY UPDATE qty_per_unit=VALUES(qty_per_unit), updated_at=NOW()`,
        [clientId, productId, itemId, cost4(qty)]);
      n++;
    }
    return { lines: n };
  });
}

/**
 * What one portion costs at today's average purchase prices.
 *
 * Kept separate from `products.cost_price`, which the owner types by hand and
 * which the P&L already uses. Overwriting a hand-typed cost from a recipe
 * would change every historic margin the moment somebody bought expensive
 * flour, so this is offered as a suggestion on screen and never written back.
 */
async function recipeCost(clientId, productId) {
  const lines = await recipeFor(clientId, productId);
  let total = 0;
  const out = [];
  for (const l of lines) {
    const lvl = await levelFor(clientId, l.inventory_item_id);
    const unitCost = lvl ? Number(lvl.avg_cost) : 0;
    const cost = money(Number(l.qty_per_unit) * unitCost);
    total += cost;
    out.push({ ...l, avg_cost: unitCost, line_cost: cost });
  }
  return { lines: out, cost: money(total) };
}

/* ====================================================================== */
/*  The critical path: one function, called by every close path            */
/* ====================================================================== */

/**
 * Move the stock for a bill. THE only place a sale touches stock.
 *
 * Both worlds move together, because both exist and each is right for a
 * different kind of product: a bottle of beer is counted as itself
 * (products.track_stock -> product_stock), a portion of pide is counted as the
 * flour and mince it is made of (product_recipes -> inventory_stock_ledger).
 * A product may be either, both or neither.
 *
 * Idempotency is per LINE, held in `order_items.stock_applied`, and the rows
 * are locked FOR UPDATE so two close paths racing - the cashier's button and
 * the OKC's callback - cannot both deduct. The old code flagged every row of
 * the order including deleted ones and untracked products, so re-opening a
 * bill and adding an item deducted nothing at all for the new line.
 *
 * Returns what it did, so a caller can log or show it.
 */
async function applyStockForOrder(clientId, orderId, userId = null) {
  return db.tx(t => applyStockForOrderIn(t, clientId, orderId, userId));
}

/**
 * The same thing, inside a transaction the caller already owns.
 *
 * `orders.closeIfPaid` closes the bill inside its own transaction; calling the
 * version above from there would open a SECOND connection against rows the
 * first one has locked, which is a deadlock waiting for a busy Friday. Stock
 * moving in the same transaction as the close is also the only way the two can
 * never disagree - a crash between them is what left the old system with bills
 * that were paid and stock that never moved.
 */
async function applyStockForOrderIn(t, clientId, orderId, userId = null) {
  const lines = await t.query(
    `SELECT oi.id, oi.product_id, oi.qty, p.track_stock, p.name AS product_name
       FROM order_items oi
       JOIN products p ON p.id=oi.product_id AND p.client_id=oi.client_id
      WHERE oi.order_id=? AND oi.client_id=? AND oi.is_deleted=0 AND oi.stock_applied=0
      FOR UPDATE`, [orderId, clientId]);
  if (!lines.length) return { applied: 0, items: 0, products: 0 };

  let productMoves = 0, itemMoves = 0;
  for (const line of lines) {
    const qty = Number(line.qty);
    if (!(qty > 0)) { await t.exec('UPDATE order_items SET stock_applied=1 WHERE id=?', [line.id]); continue; }

    // finished goods - only when the product is actually tracked
    if (line.track_stock) {
      await moveProductStock(t, clientId, line.product_id, -qty, 'sale', line.id);
      productMoves++;
    }
    // raw materials - the link the old system never had
    itemMoves += await consumeRecipe(t, clientId, line, qty, orderId, userId, false);

    await t.exec('UPDATE order_items SET stock_applied=1 WHERE id=?', [line.id]);
  }
  return { applied: lines.length, products: productMoves, items: itemMoves };
}

/**
 * Give the stock back for a cancelled or voided bill.
 *
 * The flag IS reset here, which the old system never did: it reversed rows
 * `WHERE stock_applied=1` and left them at 1, so a bill cancelled and closed
 * again put the stock back and never took it out. Reversal writes new ledger
 * rows rather than deleting the sale rows - a stock figure that quietly
 * rewrites its own past is not a ledger.
 */
async function reverseStockForOrder(clientId, orderId, userId = null) {
  return db.tx(t => reverseStockForOrderIn(t, clientId, orderId, userId));
}

/** Reversal inside a transaction the caller already owns - see applyStockForOrderIn. */
async function reverseStockForOrderIn(t, clientId, orderId, userId = null) {
  const lines = await t.query(
    `SELECT oi.id, oi.product_id, oi.qty, p.track_stock, p.name AS product_name
       FROM order_items oi
       JOIN products p ON p.id=oi.product_id AND p.client_id=oi.client_id
      WHERE oi.order_id=? AND oi.client_id=? AND oi.stock_applied=1
      FOR UPDATE`, [orderId, clientId]);
  if (!lines.length) return { reversed: 0, items: 0, products: 0 };

  let productMoves = 0, itemMoves = 0;
  for (const line of lines) {
    const qty = Number(line.qty);
    if (qty > 0) {
      if (line.track_stock) { await moveProductStock(t, clientId, line.product_id, qty, 'cancel', line.id); productMoves++; }
      itemMoves += await consumeRecipe(t, clientId, line, qty, orderId, userId, true);
    }
    await t.exec('UPDATE order_items SET stock_applied=0 WHERE id=?', [line.id]);
  }
  return { reversed: lines.length, products: productMoves, items: itemMoves };
}

/**
 * One line, partly cancelled: the guest sent back one of the two pides.
 *
 * The line stays on the bill with a smaller qty, so `stock_applied` is NOT
 * touched - it still describes the line that remains. Only the difference goes
 * back. `orders.cancelItem` does this today for the finished-goods counter
 * only; this does both worlds through the same code as everything else.
 */
async function reverseLineIn(t, clientId, orderItemId, qty, userId = null) {
  const move = Number(qty);
  if (!(move > 0)) return { items: 0, products: 0 };
  const line = await t.one(
    `SELECT oi.id, oi.product_id, oi.order_id, oi.stock_applied, p.track_stock, p.name AS product_name
       FROM order_items oi
       JOIN products p ON p.id=oi.product_id AND p.client_id=oi.client_id
      WHERE oi.id=? AND oi.client_id=?`, [orderItemId, clientId]);
  if (!line || !line.stock_applied) return { items: 0, products: 0 };
  let products = 0;
  if (line.track_stock) { await moveProductStock(t, clientId, line.product_id, move, 'cancel', line.id); products = 1; }
  const items = await consumeRecipe(t, clientId, line, move, line.order_id, userId, true);
  return { items, products };
}

/** One order line's worth of raw material, in or out. Returns the number of ledger rows written. */
async function consumeRecipe(t, clientId, line, qty, orderId, userId, giveBack) {
  const recipe = await t.query(
    'SELECT inventory_item_id, qty_per_unit FROM product_recipes WHERE client_id=? AND product_id=?',
    [clientId, line.product_id]);
  let n = 0;
  for (const r of recipe) {
    const move = q3(qty * Number(r.qty_per_unit));
    if (!(move > 0)) continue;
    const unitCost = await avgCostIn(t, clientId, r.inventory_item_id);
    await t.insert(
      `INSERT INTO inventory_stock_ledger (client_id, item_id, source_type, source_id, location_id,
          order_id, quantity_in, quantity_out, unit_cost, note, created_by, created_at)
       VALUES (?,?, 'sale', ?, NULL, ?, ?, ?, ?, ?, ?, NOW())`,
      [clientId, r.inventory_item_id, line.id, orderId,
       giveBack ? move : 0, giveBack ? 0 : move, unitCost,
       (giveBack ? 'İptal: ' : 'Satış: ') + line.product_name, userId || null]);
    n++;
  }
  return n;
}

/**
 * The finished-goods counter. Kept here rather than in modules/stock.js so
 * that a sale has one implementation, but written to the same two tables that
 * module uses so nothing else has to change.
 *
 * The `INSERT ... ON DUPLICATE KEY` matters: the old code was a bare UPDATE,
 * and a product whose `track_stock` was switched on after creation had no row,
 * so the UPDATE hit zero rows, silently, forever.
 */
async function moveProductStock(t, clientId, productId, delta, reason, orderItemId) {
  await t.exec(
    `INSERT INTO product_stock (client_id, product_id, quantity, stock, updated_at)
     VALUES (?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), stock = stock + VALUES(stock), updated_at=NOW()`,
    [clientId, productId, delta, delta]);
  await t.exec(
    'INSERT INTO product_stock_movements (client_id, product_id, qty, reason, order_item_id) VALUES (?,?,?,?,?)',
    [clientId, productId, delta, reason, orderItemId || null]);
}

/**
 * What a bill consumed, for the screen that asks "where did the flour go".
 * Reads the ledger, so it is the same number the stock level came from.
 */
async function consumptionForOrder(clientId, orderId) {
  return db.query(
    `SELECT l.item_id, i.name AS item_name, i.unit,
            SUM(l.quantity_out) - SUM(l.quantity_in) AS qty,
            SUM((l.quantity_out - l.quantity_in) * COALESCE(l.unit_cost,0)) AS cost
       FROM inventory_stock_ledger l
       LEFT JOIN inventory_items i ON i.id=l.item_id
      WHERE l.client_id=? AND l.order_id=? AND l.source_type='sale'
      GROUP BY l.item_id, i.name, i.unit
     HAVING qty <> 0`, [clientId, orderId]);
}

/* ====================================================================== */
/*  Sayim - stock counts with variance                                     */
/* ====================================================================== */

/**
 * Open a count. The expected quantity is frozen at the moment the sheet is
 * printed, so the variance answers "what was missing when we counted", not
 * "what is missing now that three more bills have closed".
 */
async function openCount(clientId, { location_id = null, count_date = null, note = null, item_ids = null } = {}, userId) {
  const date = count_date || new Date().toISOString().slice(0, 10);
  const all = await levels(clientId, { onlyActive: true });
  const wanted = item_ids && item_ids.length
    ? all.filter(r => item_ids.map(Number).includes(Number(r.id)))
    : all;
  if (!wanted.length) throw bad('Sayılacak malzeme yok');
  return db.tx(async t => {
    const id = await t.insert(
      `INSERT INTO inventory_counts (client_id, location_id, count_date, status, note, created_by, created_at)
       VALUES (?,?,?, 'draft', ?, ?, NOW())`,
      [clientId, location_id || null, date, note || null, userId || null]);
    for (const r of wanted) {
      await t.insert(
        `INSERT INTO inventory_count_items (count_id, item_id, expected_qty, counted_qty, variance, unit_cost)
         VALUES (?,?,?,?,0,?)`,
        [id, r.id, r.qty, r.qty, r.avg_cost]);
    }
    return id;
  });
}

async function counts(clientId, limit = 60) {
  return db.query(
    `SELECT c.*, l.name AS location_name, u.display_name AS created_by_name,
            (SELECT COUNT(*) FROM inventory_count_items x WHERE x.count_id=c.id) AS line_count,
            (SELECT COALESCE(SUM(ABS(x.variance)),0) FROM inventory_count_items x WHERE x.count_id=c.id) AS variance_qty,
            (SELECT COALESCE(SUM(x.variance * COALESCE(x.unit_cost,0)),0) FROM inventory_count_items x WHERE x.count_id=c.id) AS variance_value
       FROM inventory_counts c
       LEFT JOIN inventory_locations l ON l.id=c.location_id
       LEFT JOIN users u ON u.id=c.created_by
      WHERE c.client_id=? ORDER BY c.id DESC LIMIT ?`, [clientId, Number(limit) || 60]);
}

async function getCount(clientId, id) {
  const c = await db.one(
    `SELECT c.*, l.name AS location_name FROM inventory_counts c
       LEFT JOIN inventory_locations l ON l.id=c.location_id
      WHERE c.id=? AND c.client_id=?`, [id, clientId]);
  if (!c) return null;
  c.items = await db.query(
    `SELECT ci.*, i.name AS item_name, i.unit
       FROM inventory_count_items ci
       JOIN inventory_items i ON i.id=ci.item_id
      WHERE ci.count_id=? ORDER BY i.name`, [id]);
  c.variance_value = money(c.items.reduce((s, r) => s + Number(r.variance) * Number(r.unit_cost || 0), 0));
  return c;
}

/** Type the shelf figures in. Variance is computed here, never sent by the client. */
async function saveCountLines(clientId, countId, lines) {
  return db.tx(async t => {
    const c = await t.one('SELECT * FROM inventory_counts WHERE id=? AND client_id=? FOR UPDATE', [countId, clientId]);
    if (!c) throw bad('Sayım bulunamadı', 404);
    if (c.status !== 'draft') throw bad('Kapanmış sayım değiştirilemez', 409);
    for (const l of lines || []) {
      const row = await t.one('SELECT * FROM inventory_count_items WHERE count_id=? AND item_id=?',
        [countId, Number(l.item_id)]);
      if (!row) continue;
      const counted = q3(l.counted_qty);
      await t.exec('UPDATE inventory_count_items SET counted_qty=?, variance=? WHERE id=?',
        [counted, q3(counted - Number(row.expected_qty)), row.id]);
    }
    return true;
  });
}

/**
 * Approve a count. Every non-zero variance becomes an adjustment in the
 * ledger, so the level the next screen reads IS the counted figure - which is
 * the entire point of counting and the entire thing the old system could not
 * do, having neither a count table nor a single 'adjustment' row anywhere.
 */
async function approveCount(clientId, countId, userId) {
  return db.tx(async t => {
    const c = await t.one('SELECT * FROM inventory_counts WHERE id=? AND client_id=? FOR UPDATE', [countId, clientId]);
    if (!c) throw bad('Sayım bulunamadı', 404);
    if (c.status !== 'draft') throw bad('Bu sayım zaten kapatılmış', 409);
    const rows = await t.query('SELECT * FROM inventory_count_items WHERE count_id=?', [countId]);
    let adjusted = 0;
    for (const r of rows) {
      const variance = q3(r.variance);
      if (variance === 0) continue;
      await t.insert(
        `INSERT INTO inventory_stock_ledger (client_id, item_id, source_type, source_id, location_id,
            quantity_in, quantity_out, unit_cost, note, created_by, created_at)
         VALUES (?,?, 'count', ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [clientId, r.item_id, countId, c.location_id,
         variance > 0 ? variance : 0, variance < 0 ? -variance : 0,
         r.unit_cost, 'Sayım farkı #' + countId, userId || null]);
      adjusted++;
    }
    await t.exec("UPDATE inventory_counts SET status='approved', approved_by=?, approved_at=NOW() WHERE id=?",
      [userId || null, countId]);
    return { adjusted, lines: rows.length };
  });
}

async function cancelCount(clientId, countId) {
  const c = await db.one('SELECT status FROM inventory_counts WHERE id=? AND client_id=?', [countId, clientId]);
  if (!c) throw bad('Sayım bulunamadı', 404);
  if (c.status === 'approved') throw bad('Onaylanmış sayım iptal edilemez', 409);
  await db.exec("UPDATE inventory_counts SET status='cancelled' WHERE id=? AND client_id=?", [countId, clientId]);
  return true;
}

/* ====================================================================== */
/*  Zayi - waste                                                           */
/* ====================================================================== */

function wasteReasons() {
  return Object.entries(WASTE_REASONS).map(([code, label]) => ({ code, label }));
}

/** Write off stock with a reason. The reason is required, and validated against the list. */
async function recordWaste(clientId, data, userId) {
  const itemId = Number(data.item_id);
  const qty = q3(data.quantity);
  const reason = String(data.reason || '').trim();
  if (!itemId) throw bad('Malzeme seçilmedi');
  if (!(qty > 0)) throw bad('Zayi miktarı sıfırdan büyük olmalı');
  if (!WASTE_REASONS[reason]) throw bad('Zayi nedeni seçilmeli');
  return db.tx(async t => {
    const item = await t.one('SELECT id, name FROM inventory_items WHERE id=? AND client_id=?', [itemId, clientId]);
    if (!item) throw bad('Malzeme bulunamadı', 404);
    const unitCost = await avgCostIn(t, clientId, itemId);
    const id = await t.insert(
      `INSERT INTO inventory_waste (client_id, item_id, location_id, quantity, reason, note, unit_cost, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,NOW())`,
      [clientId, itemId, data.location_id || null, qty, reason, data.note || null, unitCost, userId || null]);
    await t.insert(
      `INSERT INTO inventory_stock_ledger (client_id, item_id, source_type, source_id, location_id,
          quantity_in, quantity_out, unit_cost, note, created_by, created_at)
       VALUES (?,?, 'waste', ?, ?, 0, ?, ?, ?, ?, NOW())`,
      [clientId, itemId, id, data.location_id || null, qty, unitCost,
       'Zayi: ' + WASTE_REASONS[reason] + (data.note ? ' - ' + data.note : ''), userId || null]);
    return { id, cost: money(qty * unitCost) };
  });
}

async function wasteList(clientId, { from = null, to = null, limit = 200 } = {}) {
  const args = [clientId];
  let where = 'w.client_id=?';
  if (from) { where += ' AND w.created_at>=?'; args.push(from + ' 00:00:00'); }
  if (to) { where += ' AND w.created_at<=?'; args.push(to + ' 23:59:59'); }
  args.push(Number(limit) || 200);
  const rows = await db.query(
    `SELECT w.*, i.name AS item_name, i.unit, u.display_name AS user_name
       FROM inventory_waste w
       LEFT JOIN inventory_items i ON i.id=w.item_id
       LEFT JOIN users u ON u.id=w.created_by
      WHERE ${where} ORDER BY w.id DESC LIMIT ?`, args);
  for (const r of rows) {
    r.reason_label = WASTE_REASONS[r.reason] || r.reason;
    r.cost = money(Number(r.quantity) * Number(r.unit_cost || 0));
  }
  return rows;
}

/* ====================================================================== */
/*  Transfers between depots                                               */
/* ====================================================================== */

/**
 * Two ledger rows that net to zero across the business, so total stock never
 * changes when something moves from the cellar to the bar - only where it is.
 */
async function transfer(clientId, data, userId) {
  const itemId = Number(data.item_id);
  const qty = q3(data.quantity);
  const from = Number(data.from_location_id);
  const to = Number(data.to_location_id);
  if (!itemId) throw bad('Malzeme seçilmedi');
  if (!(qty > 0)) throw bad('Transfer miktarı sıfırdan büyük olmalı');
  if (!from || !to) throw bad('Çıkış ve varış deposu seçilmeli');
  if (from === to) throw bad('Aynı depoya transfer yapılamaz');
  return db.tx(async t => {
    const item = await t.one('SELECT id, name FROM inventory_items WHERE id=? AND client_id=?', [itemId, clientId]);
    if (!item) throw bad('Malzeme bulunamadı', 404);
    for (const locId of [from, to]) {
      const l = await t.one('SELECT id FROM inventory_locations WHERE id=? AND client_id=?', [locId, clientId]);
      if (!l) throw bad('Depo bulunamadı: ' + locId, 404);
    }
    const unitCost = await avgCostIn(t, clientId, itemId);
    const id = await t.insert(
      `INSERT INTO inventory_transfers (client_id, item_id, from_location_id, to_location_id, quantity, note, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,NOW())`,
      [clientId, itemId, from, to, qty, data.note || null, userId || null]);
    await t.insert(
      `INSERT INTO inventory_stock_ledger (client_id, item_id, source_type, source_id, location_id,
          quantity_in, quantity_out, unit_cost, note, created_by, created_at)
       VALUES (?,?, 'transfer', ?, ?, 0, ?, ?, ?, ?, NOW())`,
      [clientId, itemId, id, from, qty, unitCost, 'Depo çıkışı #' + id, userId || null]);
    await t.insert(
      `INSERT INTO inventory_stock_ledger (client_id, item_id, source_type, source_id, location_id,
          quantity_in, quantity_out, unit_cost, note, created_by, created_at)
       VALUES (?,?, 'transfer', ?, ?, ?, 0, ?, ?, ?, NOW())`,
      [clientId, itemId, id, to, qty, unitCost, 'Depo girişi #' + id, userId || null]);
    return { id };
  });
}

async function transfers(clientId, limit = 100) {
  return db.query(
    `SELECT tr.*, i.name AS item_name, i.unit,
            f.name AS from_name, tl.name AS to_name, u.display_name AS user_name
       FROM inventory_transfers tr
       LEFT JOIN inventory_items i ON i.id=tr.item_id
       LEFT JOIN inventory_locations f ON f.id=tr.from_location_id
       LEFT JOIN inventory_locations tl ON tl.id=tr.to_location_id
       LEFT JOIN users u ON u.id=tr.created_by
      WHERE tr.client_id=? ORDER BY tr.id DESC LIMIT ?`, [clientId, Number(limit) || 100]);
}

/** Per-depot balance for one item, for the transfer form's "you have this much there". */
async function levelsByLocation(clientId, itemId) {
  return db.query(
    `SELECT l.location_id, COALESCE(loc.name, 'Ana Depo') AS location_name,
            SUM(l.quantity_in) - SUM(l.quantity_out) AS qty
       FROM inventory_stock_ledger l
       LEFT JOIN inventory_locations loc ON loc.id=l.location_id
      WHERE l.client_id=? AND l.item_id=?
      GROUP BY l.location_id, loc.name`, [clientId, itemId]);
}

/* ====================================================================== */

module.exports = {
  UNIT_LABEL, WASTE_REASONS,
  units, customUnits, saveCustomUnit, deleteCustomUnit, categories, saveCategory,
  locations, defaultLocation, saveLocation,
  items, getItem, saveItem, deleteItem,
  suppliers, saveSupplier, deleteSupplier,
  documents, getDocument, saveDocument, approveDocument, cancelDocument,
  levels, levelFor, levelsByLocation, summary, ledger, orphanLedger,
  recipeFor, recipeProducts, saveRecipe, recipeCost,
  applyStockForOrder, applyStockForOrderIn,
  reverseStockForOrder, reverseStockForOrderIn, reverseLineIn,
  consumptionForOrder,
  openCount, counts, getCount, saveCountLines, approveCount, cancelCount,
  wasteReasons, recordWaste, wasteList,
  transfer, transfers,
};
