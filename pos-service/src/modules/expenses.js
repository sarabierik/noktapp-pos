'use strict';
/** Day-to-day costs, suppliers and the little CRM the manager uses. */
const db = require('../db');
const { money, need } = require('../util/http');

async function dailyCosts(clientId, from, to) {
  return db.query('SELECT * FROM daily_costs WHERE client_id=? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC',
    [clientId, from, to]);
}
async function addCost(clientId, data, userId) {
  /* daily_costs.created_by is NOT NULL: a cost entered by something that is not
     a staff row - the setup wizard, an import, a tenant token - is 0, not NULL,
     which the database refuses with a 500 nobody can act on. */
  const date = need(data.date, 'Gider tarihi gerekli');
  return db.insert(
    'INSERT INTO daily_costs (client_id, date, category, description, amount, created_by, created_at) VALUES (?,?,?,?,?,?,NOW())',
    [clientId, date, data.category || 'genel', data.description || null, money(data.amount), Number(userId) || 0]);
}
async function deleteCost(clientId, id) {
  return db.exec('DELETE FROM daily_costs WHERE id=? AND client_id=?', [id, clientId]);
}

async function suppliers(clientId) {
  return db.query('SELECT * FROM suppliers WHERE client_id=? ORDER BY name', [clientId]);
}
async function saveSupplier(clientId, data) {
  const name = need(data.name, 'Tedarikci adi gerekli');
  /* phone and email are NOT NULL with an empty default in the schema, so an
     absent one is '' - never NULL, which the database refuses. */
  const phone = data.phone || '';
  const email = data.email || '';
  if (data.id) {
    await db.exec('UPDATE suppliers SET name=?, phone=?, email=?, address=?, vkn=?, vergi_dairesi=?, is_active=?, updated_at=NOW() WHERE id=? AND client_id=?',
      [name, phone, email, data.address || null, data.vkn || null,
       data.vergi_dairesi || null, data.is_active === false ? 0 : 1, data.id, clientId]);
    return data.id;
  }
  return db.insert('INSERT INTO suppliers (client_id, name, phone, email, address, vkn, vergi_dairesi, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,NOW(),NOW())',
    [clientId, name, phone, email, data.address || null, data.vkn || null, data.vergi_dairesi || null]);
}

async function tasks(clientId) {
  return db.query('SELECT * FROM crm_tasks WHERE client_id=? ORDER BY done_at IS NOT NULL, due_on, id DESC LIMIT 200', [clientId]);
}
async function saveTask(clientId, data, userId) {
  const title = need(data.title, 'Gorev basligi gerekli');
  /* crm_tasks.due_on is NOT NULL and the list is ordered by it: a task with no
     date would have no place in the manager's day. Ask for one. */
  const dueOn = need(data.due_on, 'Termin tarihi gerekli');
  if (data.id) {
    await db.exec('UPDATE crm_tasks SET title=?, detail=?, due_on=?, assigned_to=?, kind=? WHERE id=? AND client_id=?',
      [title, data.detail || null, dueOn, data.assigned_to || null, data.kind || 'genel', data.id, clientId]);
    return data.id;
  }
  return db.insert('INSERT INTO crm_tasks (client_id, title, detail, due_on, assigned_to, kind, created_by, created_at) VALUES (?,?,?,?,?,?,?,NOW())',
    [clientId, title, data.detail || null, dueOn, data.assigned_to || null, data.kind || 'genel', userId || null]);
}
async function completeTask(clientId, id, userId) {
  return db.exec('UPDATE crm_tasks SET done_at=NOW(), done_by=? WHERE id=? AND client_id=?', [userId || null, id, clientId]);
}

/* ------------------------ stock documents ------------------------- */
async function inventoryItems(clientId) {
  return db.query(
    `SELECT i.*, COALESCE(c.quantity,0) AS quantity FROM inventory_items i
       LEFT JOIN inventory_stock_cache c ON c.item_id=i.id AND c.client_id=i.client_id
      WHERE i.client_id=? AND i.is_active=1 ORDER BY i.name`, [clientId]);
}
async function saveInventoryItem(clientId, data) {
  if (data.id) {
    await db.exec('UPDATE inventory_items SET name=?, sku=?, barcode=?, unit=?, category_id=?, is_active=? WHERE id=? AND client_id=?',
      [data.name, data.sku || null, data.barcode || null, data.unit || 'pcs', data.category_id || null,
       data.is_active === false ? 0 : 1, data.id, clientId]);
    return data.id;
  }
  return db.insert('INSERT INTO inventory_items (client_id, name, sku, barcode, unit, category_id, is_active, created_at) VALUES (?,?,?,?,?,?,1,NOW())',
    [clientId, data.name, data.sku || null, data.barcode || null, data.unit || 'pcs', data.category_id || null]);
}

/** A purchase document: header + lines, approving it moves the stock. */
async function saveDocument(clientId, data, userId) {
  return db.tx(async t => {
    const docId = data.id || await t.insert(
      `INSERT INTO inventory_documents (client_id, supplier_id, type, document_no, document_date, total_amount, status, source, created_by, created_at)
       VALUES (?,?,?,?,?,?, 'draft', 'manual', ?, NOW())`,
      [clientId, data.supplier_id || null, data.type || 'purchase', data.document_no || null,
       data.document_date, money(data.total_amount || 0), userId || 0]);
    if (data.id) {
      await t.exec('UPDATE inventory_documents SET supplier_id=?, document_no=?, document_date=?, total_amount=? WHERE id=? AND client_id=?',
        [data.supplier_id || null, data.document_no || null, data.document_date, money(data.total_amount || 0), docId, clientId]);
      await t.exec('DELETE FROM inventory_document_items WHERE document_id=?', [docId]);
    }
    for (const l of data.items || []) {
      await t.insert(
        `INSERT INTO inventory_document_items (document_id, item_id, raw_name, quantity, unit, unit_price, total_price, vat_rate, vat_amount, is_approved)
         VALUES (?,?,?,?,?,?,?,?,?,0)`,
        [docId, l.item_id || null, l.raw_name || l.name, l.quantity, l.unit || 'pcs',
         money(l.unit_price), money(l.quantity * l.unit_price), l.vat_rate || 0,
         money((l.quantity * l.unit_price) * (l.vat_rate || 0) / (100 + (l.vat_rate || 0)))]);
    }
    return docId;
  });
}

async function approveDocument(clientId, docId, userId) {
  return db.tx(async t => {
    const doc = await t.one("SELECT * FROM inventory_documents WHERE id=? AND client_id=? AND status='draft'", [docId, clientId]);
    if (!doc) { const e = new Error('Belge bulunamadi veya zaten onayli'); e.status = 404; throw e; }
    const lines = await t.query('SELECT * FROM inventory_document_items WHERE document_id=?', [docId]);
    for (const l of lines) {
      if (!l.item_id) continue;
      await t.exec(
        `INSERT INTO inventory_stock_ledger (client_id, item_id, source_type, source_id, quantity_in, quantity_out, unit_cost, created_at)
         VALUES (?,?, 'document', ?, ?, 0, ?, NOW())`,
        [clientId, l.item_id, docId, l.quantity, l.unit_price]);
      await t.exec(
        `INSERT INTO inventory_stock_cache (client_id, item_id, quantity, updated_at) VALUES (?,?,?,NOW())
         ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), updated_at=NOW()`,
        [clientId, l.item_id, l.quantity]);
    }
    await t.exec("UPDATE inventory_documents SET status='approved', approved_by=?, approved_at=NOW() WHERE id=?", [userId || null, docId]);
    return true;
  });
}

module.exports = { dailyCosts, addCost, deleteCost, suppliers, saveSupplier, tasks, saveTask,
  completeTask, inventoryItems, saveInventoryItem, saveDocument, approveDocument };
