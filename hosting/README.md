# What runs on your hosting, and what it changes

Two files. Only the first one touches a database you already depend on.

## `01-tecofi_nokpos-patch.sql` → your LIVE database

**Additive only.** One `CREATE TABLE IF NOT EXISTS`. Nothing dropped, nothing
renamed, no column changed, no row edited. Safe to run twice.

It creates `order_discounts`, which your order engine has been reading — and
failing to find — since the loyalty feature shipped. Your own comment in
`pos/loyalty/lib.php` describes the consequence: the failed read set the
discount to 0, the next line wrote `discount_total = 0`, and a redeemed reward
silently came back onto the bill. This fixes that on the **live web POS**, today,
independently of the desktop app.

I rehearsed it against your own 112-table dump loaded into a real MariaDB
10.11, twice in a row. Every index I would otherwise have added — `ix_phone`,
`ix_qr_uid`, `ix_order_kind`, `uq_card` — is already on your live tables, so the
patch is one table and nothing else.

**Before running it:** phpMyAdmin → select `tecofi_nokpos` → **Export** → Go.
Keep the file. It takes ten seconds and it is the difference between a bad
afternoon and a non-event.

## `02-tecofi_nokpos_panel-schema.sql` → a NEW, empty database

Only needed if you would rather import it by hand than let `setup.php` do it.
Create `tecofi_nokpos_panel` first, select it, then import. It touches nothing
that already exists.

## What is NOT run on your hosting

The desktop schema (`database/01_schema_core.sql` and friends) never goes near
your server. Those load into the bundled database on each restaurant's own PC,
and the installer does it by itself.
