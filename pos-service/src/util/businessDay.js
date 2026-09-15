'use strict';
/**
 * A restaurant "business day" does not end at midnight. The day rolls over at
 * the hour configured in np_settings.business_day_start (default 06:00), so a
 * bill opened at 02:30 still belongs to the previous calendar date.
 */
const db = require('../db');

/**
 * The LOCAL calendar date, written out by hand.
 *
 * `toISOString()` is UTC, and this function has already shifted the clock by
 * the local business-day hour before it is called - so on any machine east of
 * Greenwich the shift was applied twice. In Istanbul (UTC+3) a bill opened at
 * 02:30 on the 4th came back as the 2nd: one day for the business-day roll,
 * one more for the trip through UTC. That bill was then filed under a day the
 * restaurant had closed the night before last, so opening it was refused with
 * "Gun sonu alinmis" - or, if that day was still open, its takings landed on
 * the wrong Z report and the cashier could not find it under any date.
 *
 * MariaDB is opened with timezone:'local' and every NOW() in the schema is
 * local, so the business date has to be local too.
 */
function ymdLocal(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function currentBusinessDate(now = new Date()) {
  const start = String(await db.getSetting('business_day_start', '06:00'));
  const [h, m] = start.split(':').map(Number);
  const d = new Date(now.getTime());
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins < (h * 60 + (m || 0))) d.setDate(d.getDate() - 1);
  return ymdLocal(d);
}

async function isDayClosed(clientId, date) {
  const row = await db.one('SELECT id FROM daily_closings WHERE client_id=? AND date=? AND (is_reopened=0 OR is_reopened IS NULL)',
    [clientId, date]);
  return !!row;
}

module.exports = { currentBusinessDate, isDayClosed, ymdLocal };
