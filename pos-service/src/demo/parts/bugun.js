'use strict';
/**
 * BUGÜN — the handful of rows that only matter on the day the demo is shown.
 *
 * Everything else in the seeder is history, and history is safe: it was true
 * yesterday and it will be true next month. The live screens are not. Kasa
 * draws the OPEN shift and says "bu vardiyada kasa hareketi yok" if nobody has
 * put money in or taken it out today; Rezervasyon opens on this week and says
 * "bu tarihlerde rezervasyon yok" if the diary happens to be clear; the guest
 * screen asks about tonight.
 *
 * The other parts seed those tables by probability across seven years, which
 * is right for a report and wrong for a demonstration: a one-in-three chance
 * of an empty Kasa screen is a one-in-three chance of the empty screen being
 * the one somebody is shown. So this part runs last and GUARANTEES the live
 * ones, rather than leaving them to the dice.
 */
const { bulk, ymd, dt, atTime, addDays } = require('../lib');

async function has(db, table) {
  return !!Number(await db.value(
    'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?',
    [table]));
}

async function build(ctx) {
  const { db, clientId, rand: r, today } = ctx;
  const pick = (a) => a[Math.floor(r() * a.length)];
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));
  const date = ymd(today);
  const done = [];

  /* ------------------------------------------------------- kasa hareketi */
  const shift = await db.one(
    "SELECT id FROM pos_shifts WHERE client_id=? AND business_date=? AND status='open' ORDER BY id DESC LIMIT 1",
    [clientId, date]);
  if (shift) {
    const cashier = ctx.users.sevim || ctx.users.erdal;
    const crypto = require('crypto');
    await bulk(db, 'pos_shift_movements',
      ['client_id', 'shift_id', 'movement_uid', 'direction', 'amount_minor', 'reason', 'user_id', 'created_at'], [
        { client_id: clientId, shift_id: shift.id, movement_uid: crypto.randomUUID(),
          direction: 'out', amount_minor: 145000, reason: 'Sebzeci ödemesi',
          user_id: cashier.id, created_at: dt(atTime(today, 11, 40)) },
        { client_id: clientId, shift_id: shift.id, movement_uid: crypto.randomUUID(),
          direction: 'out', amount_minor: 62000, reason: 'Kömür alımı',
          user_id: cashier.id, created_at: dt(atTime(today, 16, 5)) },
        { client_id: clientId, shift_id: shift.id, movement_uid: crypto.randomUUID(),
          direction: 'in', amount_minor: 200000, reason: 'Kasaya bozuk para takviyesi',
          user_id: ctx.users.erdal.id, created_at: dt(atTime(today, 17, 20)) },
      ]);
    /* an opening count as well, so the drawer screen has both halves */
    if (await has(db, 'pos_cash_counts')) {
      await db.exec(
        `INSERT INTO pos_cash_counts (client_id, shift_id, count_uid, kind, total_minor,
            expected_minor, variance_minor, counted_by, counted_by_name, note, created_at)
         VALUES (?,?,?,'open',250000,250000,0,?,?,?,?)`,
        [clientId, shift.id, crypto.randomUUID(), cashier.id, cashier.name,
         'Vardiya açılış sayımı', dt(atTime(today, 10, 45))]);
    }
    done.push('kasa hareketi');
  }

  /* ------------------------------------------------------- rezervasyonlar */
  /*
   * Tonight and the rest of the week. The diary is the screen a restaurateur
   * looks at first and an empty one reads as "this feature does not work",
   * even though the seven years behind it are full.
   */
  if (await has(db, 'reservations') && ctx.tables.length) {
    const NAMES = [
      ['Serpil Tunçer', 6, 'Doğum günü - pasta getirecekler'],
      ['Kadir Yalçın', 4, 'Pencere kenarı rica edildi'],
      ['Nihan Aksoy', 2, null],
      ['Ercan Baturalp', 8, 'Şirket yemeği - fatura kesilecek'],
      ['Gülşen Erdem', 3, 'Çocuk sandalyesi'],
      ['Tarık Menteş', 5, null],
      ['Hülya Sarı', 4, 'Tekerlekli sandalye erişimi'],
      ['Volkan Işık', 2, 'Nişan teklifi - sessiz masa'],
      ['Berna Küçük', 6, null],
      ['Mahmut Özkan', 10, 'Aile yemeği - iki masa birleştirilecek'],
    ];
    const rows = [];
    let n = 0;
    for (let dayOff = 0; dayOff <= 9; dayOff++) {
      const day = addDays(today, dayOff);
      /* Friday and Saturday take more bookings, the same as the takings do */
      const count = [5, 3, 3, 3, 4, 6, 6][day.getDay()] - (dayOff > 4 ? 2 : 0);
      for (let i = 0; i < Math.max(1, count); i++) {
        const [name, party, note] = NAMES[n++ % NAMES.length];
        const table = pick(ctx.tables.filter(t => t.seats >= party)) || pick(ctx.tables);
        const at = atTime(day, between(18, 21), pick([0, 30]));
        /* tonight's early ones are already sitting down */
        const past = dayOff === 0 && at < new Date();
        rows.push({
          client_id: clientId, table_id: table.id, guest_name: name,
          guest_phone: '05' + between(30, 55) + String(between(1000000, 9999999)),
          party_size: party, starts_at: dt(at), duration_min: 90,
          status: past ? (r() < 0.75 ? 'seated' : 'done') : 'booked',
          note, created_by: ctx.users.nurcan.id,
          created_at: dt(addDays(day, -between(1, 12))),
          seated_at: past ? dt(at) : null, seated_by: past ? ctx.users.nurcan.id : null,
        });
      }
    }
    await bulk(db, 'reservations', ['client_id', 'table_id', 'guest_name', 'guest_phone',
      'party_size', 'starts_at', 'duration_min', 'status', 'note', 'created_by', 'created_at',
      'seated_at', 'seated_by'], rows);
    done.push(`${rows.length} rezervasyon (bugün ve bu hafta)`);
  }

  /* ------------------------------------------------------- paket panosu */
  /*
   * The board prints how many minutes are left on the promise, and an order
   * that was created at noon is 400 minutes late by the evening. The history
   * is allowed to be stale - the LIVE lanes are not, so today's undelivered
   * ones are pulled forward to the last half hour and one is put back into
   * "Yeni" so the first lane is not an empty column.
   */
  if (await has(db, 'delivery_orders')) {
    const live = await db.query(
      "SELECT id, order_id, status FROM delivery_orders WHERE client_id=? AND business_date=? " +
      "AND status IN ('NEW','PREPARING','ON_ROUTE') ORDER BY id DESC LIMIT 6", [clientId, date]);
    let back = 6;
    for (const d of live) {
      const created = new Date(Date.now() - (back += 7) * 60000);
      await db.exec(
        'UPDATE delivery_orders SET created_at=?, dispatched_at=?, promised_minutes=? WHERE id=?',
        [dt(created), d.status === 'ON_ROUTE' ? dt(new Date(created.getTime() + 14 * 60000)) : null,
         between(35, 50), d.id]);
    }
    /* and a brand new one that nobody has touched yet */
    const first = live[0];
    if (first) await db.exec("UPDATE delivery_orders SET status='NEW', dispatched_at=NULL, " +
      'delivered_at=NULL, created_at=? WHERE id=?', [dt(new Date(Date.now() - 4 * 60000)), first.id]);
    done.push('paket panosu tazelendi');
  }

  /* --------------------------------------------------------- açık adisyon */
  /* The floor plan is the first screen anybody sees. trading.js leaves the
     last few of today's bills open; this only makes sure the tables under
     them are marked busy even if the update above raced a later write. */
  await db.exec(
    "UPDATE restaurant_tables t JOIN orders o ON o.table_id=t.id AND o.status='open' AND o.is_deleted=0 " +
    'SET t.is_occupied=1 WHERE t.client_id=?', [clientId]).catch(() => {});

  ctx.log('bugün: ' + (done.join(', ') || 'değişiklik yok'));
}

module.exports = { build };
