'use strict';
/** Product stock: only products with track_stock=1 are moved. */
const db = require('../db');

async function moveInTx(t, clientId, productId, delta, reason, orderItemId = null) {
  const p = await t.one('SELECT track_stock FROM products WHERE id=? AND client_id=?', [productId, clientId]);
  if (!p || !p.track_stock) return false;
  await t.exec(
    `INSERT INTO product_stock (client_id, product_id, quantity, stock, updated_at)
     VALUES (?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), stock = stock + VALUES(stock), updated_at=NOW()`,
    [clientId, productId, delta, delta]);
  await t.exec(
    'INSERT INTO product_stock_movements (client_id, product_id, qty, reason, order_item_id) VALUES (?,?,?,?,?)',
    [clientId, productId, delta, reason, orderItemId]);
  return true;
}

async function adjust(clientId, productId, newQty, userId) {
  return db.tx(async t => {
    const cur = await t.value('SELECT COALESCE(stock,0) FROM product_stock WHERE client_id=? AND product_id=?',
      [clientId, productId]);
    const delta = Number(newQty) - Number(cur || 0);
    await t.exec(
      `INSERT INTO product_stock (client_id, product_id, quantity, stock, updated_at) VALUES (?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE quantity=VALUES(quantity), stock=VALUES(stock), updated_at=NOW()`,
      [clientId, productId, newQty, newQty]);
    await t.exec('INSERT INTO product_stock_movements (client_id, product_id, qty, reason) VALUES (?,?,?,?)',
      [clientId, productId, delta, 'adjustment']);
    return newQty;
  });
}

async function levels(clientId) {
  return db.query(
    `SELECT p.id, p.name, p.track_stock, COALESCE(s.stock,0) AS stock, c.name AS category
       FROM products p
       LEFT JOIN product_stock s ON s.product_id=p.id AND s.client_id=p.client_id
       LEFT JOIN categories c ON c.id=p.category_id
      WHERE p.client_id=? AND p.is_active=1 AND p.track_stock=1
      ORDER BY c.sort_order, p.sort_order, p.name`, [clientId]);
}

module.exports = { moveInTx, adjust, levels };
