'use strict';
/** Customers and reservations. Loyalty lives in modules/loyalty.js. */
const db = require('../db');
const crypto = require('crypto');
const { _money, need } = require('../util/http');

async function search(clientId, q, limit = 30) {
  const like = '%' + String(q || '') + '%';
  return db.query(
    `SELECT id, first_name, last_name, phone, email, birth_date, is_active
       FROM customers WHERE created_by_client_id=? AND (first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR email LIKE ?)
      ORDER BY first_name LIMIT ?`, [clientId, like, like, like, like, Number(limit)]);
}

async function save(clientId, data) {
  if (data.id) {
    await db.exec(
      'UPDATE customers SET first_name=?, last_name=?, phone=?, email=?, birth_date=?, is_active=?, updated_at=NOW() WHERE id=? AND created_by_client_id=?',
      [data.first_name, data.last_name || null, data.phone || null, data.email || null,
       data.birth_date || null, data.is_active === false ? 0 : 1, data.id, clientId]);
    return data.id;
  }
  return db.insert(
    `INSERT INTO customers (first_name, last_name, phone, email, birth_date, qr_uid, is_verified, is_active, created_by_client_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0,1,?,NOW(),NOW())`,
    [data.first_name, data.last_name || null, data.phone || null, data.email || null,
     data.birth_date || null, crypto.randomBytes(12).toString('hex'), clientId]);
}

async function history(clientId, customerId) {
  return db.query(
    `SELECT o.id, o.adisyon_no, o.business_date, o.grand_total, o.closed_at
       FROM orders o WHERE o.client_id=? AND o.customer_id=? AND o.is_deleted=0
      ORDER BY o.id DESC LIMIT 50`, [clientId, customerId]);
}

/* ---------------------------- loyalty ----------------------------- */
async function programs(clientId) {
  return db.query(
    `SELECT lp.*, p.name AS product_name FROM loyalty_programs lp
       LEFT JOIN products p ON p.id=lp.product_id WHERE lp.client_id=? ORDER BY lp.id`, [clientId]);
}

async function saveProgram(clientId, data) {
  /* The card the guest sees is the title, so it cannot be blank; reward_text is
     NOT NULL in the schema, so an absent one is '' rather than NULL. */
  const title = need(data.title || data.name, 'Program adi gerekli');
  const reward = data.reward_text || '';
  if (data.id) {
    await db.exec('UPDATE loyalty_programs SET product_id=?, title=?, target_count=?, reward_text=?, is_active=? WHERE id=? AND client_id=?',
      [data.product_id || null, title, data.target_count || 10, reward,
       data.is_active === false ? 0 : 1, data.id, clientId]);
    return data.id;
  }
  return db.insert('INSERT INTO loyalty_programs (client_id, product_id, title, target_count, reward_text, is_active, created_at) VALUES (?,?,?,?,?,1,NOW())',
    [clientId, data.product_id || null, title, data.target_count || 10, reward]);
}

/* Stamping and redemption live in modules/loyalty.js - one implementation,
   because two would drift and a guest's card is not a place for drift. */

async function cards(clientId, customerId) {
  return db.query(
    `SELECT c.*, p.title, p.target_count, p.reward_text FROM loyalty_cards c
       JOIN loyalty_programs p ON p.id=c.program_id
      WHERE c.client_id=? AND c.customer_id=?`, [clientId, customerId]);
}

/* -------------------------- reservations -------------------------- */
async function reservations(clientId, date) {
  return db.query(
    `SELECT r.*, t.name AS table_name FROM reservations r
       LEFT JOIN restaurant_tables t ON t.id=r.table_id
      WHERE r.client_id=? AND DATE(r.starts_at)=? ORDER BY r.starts_at`, [clientId, date]);
}

async function saveReservation(clientId, data, userId) {
  const guest = need(data.guest_name || data.customer_name, 'Misafir adi gerekli');
  const startsAt = need(data.starts_at, 'Rezervasyon saati gerekli');
  const phone = data.guest_phone || data.phone || null;
  const party = Number(data.party_size || data.people) || 2;
  if (data.id) {
    await db.exec(
      'UPDATE reservations SET table_id=?, guest_name=?, guest_phone=?, party_size=?, starts_at=?, duration_min=?, status=?, note=?, updated_at=NOW() WHERE id=? AND client_id=?',
      [data.table_id || null, guest, phone, party,
       startsAt, data.duration_min || 90, data.status || 'booked', data.note || null, data.id, clientId]);
    return data.id;
  }
  return db.insert(
    `INSERT INTO reservations (client_id, table_id, guest_name, guest_phone, party_size, starts_at, duration_min, status, note, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, 'booked', ?, ?, NOW(), NOW())`,
    [clientId, data.table_id || null, guest, phone,
     party, startsAt, data.duration_min || 90, data.note || null, userId || null]);
}

/** Seat a reservation: opens the bill and links it. */
async function seat(clientId, reservationId, userId) {
  const orders = require('./orders');
  const r = await db.one('SELECT * FROM reservations WHERE id=? AND client_id=?', [reservationId, clientId]);
  if (!r) { const e = new Error('Rezervasyon bulunamadi'); e.status = 404; throw e; }
  const orderId = await orders.openOrder(clientId, { tableId: r.table_id, userId, waiterId: userId });
  await db.exec("UPDATE reservations SET status='seated', order_id=?, updated_at=NOW() WHERE id=?", [orderId, reservationId]);
  return orderId;
}

module.exports = { search, save, history, programs, saveProgram, cards,
  reservations, saveReservation, seat };
