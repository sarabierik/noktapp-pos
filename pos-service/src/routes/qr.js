'use strict';
/**
 * QR table menu. The menu itself is published to pos.noktapp.com so a guest's
 * phone never has to reach the restaurant's PC; what lives here is the content
 * and the publish button.
 */
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const catalog = require('../modules/catalog');
const licence = require('../licence');
const sync = require('../sync');
const { ok, fail, wrap, need } = require('../util/http');

const r = express.Router();
r.use(auth.requireAuth);

r.get('/settings', wrap(async (req, res) => {
  const s = await db.one('SELECT * FROM qr_menu_settings WHERE client_id=?', [req.clientId]);
  const tables = await db.query('SELECT id, name, qr_token FROM restaurant_tables WHERE client_id=? AND is_active=1 ORDER BY sort_order', [req.clientId]);
  ok(res, { settings: s, tables, base_url: (await licence.panelUrl()) + '/qr/' });
}));

/** "Nokta Restoran" -> "nokta-restoran": the address a guest can actually type. */
function slugify(text) {
  const tr = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u',
               'Ç': 'c', 'Ğ': 'g', 'İ': 'i', 'Ö': 'o', 'Ş': 's', 'Ü': 'u' };
  return String(text || '').replace(/[çğıöşüÇĞİÖŞÜ]/g, c => tr[c])
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

r.post('/settings', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  const b = req.body;
  const exists = await db.one('SELECT client_id, slug FROM qr_menu_settings WHERE client_id=?', [req.clientId]);
  /*
   * The slug is the address on the printed card, so it is NOT NULL and it must
   * not be lost by a save that simply did not mention it: an unchanged save
   * keeps the slug the cards were printed with, a first save can borrow the
   * business name, and only a client with neither is asked for one.
   */
  const slug = slugify(b.slug) || (exists && exists.slug) || slugify(b.business_name);
  need(slug, 'Dijital menu adresi (slug) gerekli');
  if (exists) {
    await db.exec(
      'UPDATE qr_menu_settings SET slug=?, phone=?, google_url=?, instagram_url=?, website_url=?, business_name=?, about=?, currency=?, theme=?, is_published=? WHERE client_id=?',
      [slug, b.phone || null, b.google_url || null, b.instagram_url || null, b.website_url || null,
       b.business_name || null, b.about || null, b.currency || 'TRY', b.theme || 'orange',
       b.is_published ? 1 : 0, req.clientId]);
  } else {
    await db.exec(
      'INSERT INTO qr_menu_settings (client_id, slug, phone, google_url, instagram_url, website_url, business_name, about, currency, theme, is_published) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [req.clientId, slug, b.phone || null, b.google_url || null, b.instagram_url || null,
       b.website_url || null, b.business_name || null, b.about || null, b.currency || 'TRY',
       b.theme || 'orange', b.is_published ? 1 : 0]);
  }
  ok(res);
}));

/** Push the current menu up so the QR pages show today's prices. */
r.post('/publish', auth.requirePerm('settings.manage'), wrap(async (req, res) => {
  const settings = await db.one('SELECT * FROM qr_menu_settings WHERE client_id=?', [req.clientId]);
  if (!settings || !settings.slug) return fail(res, 'Once QR menu ayarlarini kaydedin');
  const menu = await catalog.menu(req.clientId, { forQr: true });
  const tables = await db.query('SELECT id, name, qr_token FROM restaurant_tables WHERE client_id=? AND is_active=1', [req.clientId]);
  await sync.push('qr_menu', String(req.clientId), { settings, menu, tables });
  await sync.drain();
  ok(res, { categories: menu.length, tables: tables.length });
}));

module.exports = r;
