'use strict';
/**
 * KAT PLANI API - /api/floor
 *
 * Alanlar, masalar, rezervasyonlar, karekod kartlari ve mutfak panosu.
 *
 * The old system spread the same job over eight PHP files with a different
 * security check in each: `tables.php` verified a CSRF token, `kitchen/ack.php`
 * checked a role, and `reservations.php` checked a permission - so which of the
 * three you got depended on which URL you happened to hit. Here there is one
 * `requireAuth` on the router and one permission per group of writes.
 */
const express = require('express');
const auth = require('../auth');
const floor = require('../modules/floor');
const { ok, fail, wrap } = require('../util/http');
const report = require('../report');

const r = express.Router();
r.use(auth.requireAuth);

const canManage = auth.requirePerm('table.manage');

/*
 * A validation failure is an ordinary answer the screen shows next to a field -
 * "Bu alanda 4 aktif masa var" is not a crash. Letting it reach the global
 * handler would print a stack trace into the service log for every mistyped
 * form, which is exactly how a real fault gets lost in the noise. Anything
 * without a status is still a bug and still goes to the handler.
 *
 * `conflicts` rides along on the response because a double-booking refusal is
 * useless without the bookings it collided with.
 */
function safe(fn) {
  return wrap(async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e) {
      if (e && e.status) {
        if (e.conflicts) {
          return res.status(e.status).json({ ok: false, error: e.message, code: e.code || null, conflicts: e.conflicts });
        }
        return fail(res, e.message, e.status, e.code || null);
      }
      throw e;
    }
  });
}

/* ------------------------------- alanlar -------------------------- */
r.get('/zones', safe(async (req, res) => ok(res, {
  zones: await floor.zones(req.clientId, { includeInactive: req.query.all === '1' }) })));

r.post('/zones', canManage, safe(async (req, res) =>
  ok(res, { id: await floor.saveZone(req.clientId, req.body) })));

r.delete('/zones/:id', canManage, safe(async (req, res) =>
  ok(res, await floor.deleteZone(req.clientId, req.params.id))));

r.post('/zones/reorder', canManage, safe(async (req, res) =>
  ok(res, await floor.reorderZones(req.clientId, req.body.ids))));

/* ------------------------------- masalar -------------------------- */
r.get('/tables', safe(async (req, res) => ok(res, {
  tables: await floor.tables(req.clientId, {
    zoneId: req.query.zone_id, includeInactive: req.query.all !== '0' }) })));

r.post('/tables', canManage, safe(async (req, res) =>
  ok(res, { id: await floor.saveTable(req.clientId, req.body) })));

r.post('/tables/bulk', canManage, safe(async (req, res) =>
  ok(res, await floor.bulkCreate(req.clientId, req.body))));

r.post('/tables/reorder', canManage, safe(async (req, res) =>
  ok(res, await floor.reorderTables(req.clientId, req.body.ids))));

/*
 * Deactivating is a POST rather than a DELETE because it is not a deletion:
 * the row stays, the bills that were served on it stay joinable, and the same
 * endpoint brings it back with active:true.
 */
r.post('/tables/:id/active', canManage, safe(async (req, res) =>
  ok(res, await floor.setTableActive(req.clientId, req.params.id, req.body.active !== false))));

r.post('/tables/:id/move', canManage, safe(async (req, res) =>
  ok(res, await floor.moveTable(req.clientId, req.params.id, req.body.zone_id))));

r.post('/tables/:id/seats', canManage, safe(async (req, res) =>
  ok(res, await floor.setSeats(req.clientId, req.params.id, req.body.seats))));

/* ------------------------------ karekod --------------------------- */
r.get('/qr/cards', safe(async (req, res) => ok(res, await floor.qrCards(req.clientId, req.query))));

r.post('/qr/missing', canManage, safe(async (req, res) =>
  ok(res, await floor.generateMissingTokens(req.clientId))));

r.post('/tables/:id/qr', canManage, safe(async (req, res) =>
  ok(res, await floor.regenerateToken(req.clientId, req.params.id))));

/*
 * What a scanned card resolves to. A regenerated token must answer 404 here -
 * that is what "the old card stops working" means, and it is the only place it
 * can be proved.
 */
r.get('/qr/resolve/:token', safe(async (req, res) => {
  const t = await floor.resolveToken(req.clientId, req.params.token);
  if (!t) return fail(res, 'Karekod gecersiz', 404, 'unknown_token');
  ok(res, { table: t });
}));

/* --------------------------- rezervasyonlar ----------------------- */
r.get('/reservations', safe(async (req, res) => ok(res, await floor.reservations(req.clientId, {
  from: req.query.from || req.query.date, to: req.query.to || req.query.date,
  status: req.query.status, tableId: req.query.table_id }))));

/** A single day, for the screen's default view and for the phone. */
r.get('/reservations/day/:date', safe(async (req, res) =>
  ok(res, await floor.reservations(req.clientId, { from: req.params.date, to: req.params.date }))));

/*
 * The book, downloadable. Same permission as seeing the list - a host who may
 * read the reservations may print them; nothing here is money.
 */
r.get('/reservations/export', safe(async (req, res) => {
  const pack = await floor.reservationExport(req.clientId, {
    from: req.query.from || req.query.date, to: req.query.to || req.query.date,
    status: req.query.status, tableId: req.query.table_id,
  });
  await report.deliver(res, req.clientId, pack, {
    format: req.query.format || 'pdf',
    producedBy: (req.auth && (req.auth.name || req.auth.role)) || '-',
  });
}));

/** Ask before saving: "is this table already promised at this hour?" */
r.get('/reservations/conflicts', safe(async (req, res) => ok(res, {
  conflicts: await floor.conflicts(req.clientId, {
    tableId: req.query.table_id ? Number(req.query.table_id) : null,
    startsAt: req.query.starts_at,
    durationMin: req.query.duration_min || 120,
    excludeId: req.query.exclude_id || null }) })));

r.post('/reservations', safe(async (req, res) =>
  ok(res, await floor.createReservation(req.clientId, req.body, req.auth.uid))));

r.put('/reservations/:id', safe(async (req, res) =>
  ok(res, await floor.updateReservation(req.clientId, req.params.id, req.body))));

r.post('/reservations/:id/status', safe(async (req, res) =>
  ok(res, await floor.setReservationStatus(req.clientId, req.params.id, req.body.status))));

/*
 * Seating opens a real bill, so it needs the permission that opening a bill
 * needs - not the reservation-editing one. A waiter who may not open an
 * adisyon may not create one through the reservation screen either.
 */
r.post('/reservations/:id/seat', auth.requirePerm('order.create'), safe(async (req, res) =>
  ok(res, await floor.seatReservation(req.clientId, req.params.id, {
    tableId: req.body.table_id, userId: req.auth.uid }))));

/* ----------------------------- mutfak ----------------------------- */
r.get('/kitchen/stations', safe(async (req, res) => ok(res, await floor.boardStations(req.clientId))));

r.get('/kitchen/board', safe(async (req, res) => ok(res, await floor.kitchenBoard(req.clientId, {
  stationId: req.query.station_id || null }))));

r.get('/kitchen/history', safe(async (req, res) => ok(res, await floor.kitchenHistory(req.clientId, {
  stationId: req.query.station_id || null, date: req.query.date }))));

r.post('/kitchen/items/:id/state', safe(async (req, res) =>
  ok(res, await floor.setItemState(req.clientId, req.params.id, req.body.state))));

module.exports = r;
