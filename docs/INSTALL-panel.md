# Putting the panel on pos.noktapp.com

The panel is plain PHP 8 — upload and run, no build step, no Composer, the same
way your other NOKTApp panels work.

## 1. Database

In cPanel → MySQL Databases:

* create a database, e.g. `tecofi_nokpos_panel`
* create a user with the same name and a strong password
* give the user **All Privileges** on it

## 2. Files

Upload everything inside `panel/` to the document root of `pos.noktapp.com`.
The layout should end up like this:

```
public_html/            (or the subdomain root)
  admin/
  api/desktop/
  api/mobile/
  assets/
  bayi/                 <- the reseller login, a door of its own
  indir/                <- put the .exe files here
  lib/
  qr/
  sql/
  setup.php             <- delete after step 4
  .htaccess
```

Create the backup folder **outside** the web root, for example:

```
/home/<cpanel-user>/noktapp-backups
```

## 3. Configure

Edit `lib/config.php`:

```php
'db' => [
    'host' => 'localhost',
    'name' => 'tecofi_nokpos_panel',
    'user' => 'tecofi_nokpos_panel',
    'pass' => '……',
],
'backup_dir' => '/home/<cpanel-user>/noktapp-backups',
```

and the mail block if you want bills mailed through `noreply@noktapp.com`.

## 4. Run setup once

Open `https://pos.noktapp.com/setup.php`, fill in your name, e-mail and a
password. It creates the tables and your admin account.

**Then delete `setup.php` from the server.** It is the only file that can
create an admin.

## 5. Check it

* `https://pos.noktapp.com/admin/` → you should be able to log in.
* `https://pos.noktapp.com/bayi/` → the reseller door. It is a SEPARATE login
  with its own session cookie: your admin account cannot open it and a reseller
  cannot open `/admin/`. Resellers are created under **Bayiler** in the panel.
* Create a test restaurant. It gets a 30-day trial licence automatically.
* `https://pos.noktapp.com/indir/latest.yml` → should answer (empty until you
  publish a version).

## Notes for shared hosting

* The relay holds a request open for up to ~20 seconds per restaurant. On
  iFastNet this is fine for a handful of tenants; once you pass roughly 30
  active restaurants, move the panel to the Turkcell VPS — the relay is the one
  part that wants real processes rather than a shared PHP pool.
* `api/desktop/backup.php` receives up to a few hundred MB per night per
  restaurant. Check `post_max_size` and `upload_max_filesize` in cPanel's PHP
  settings; 256M is a sensible value.
* Old backups are pruned as new ones arrive, so nothing has to be scheduled
  for them. The **one** cron job the panel wants is the alerts one below.

## 6. The alerts cron

Without this the panel still works and still knows a licence expires on Friday;
it just never tells you. With it, you find out by e-mail seven days ahead and
never open a screen to check.

Open **Panel → Sistem → Uyarılar** once. The screen shows the exact line to
paste, with this panel's own key already in it — copy it from there rather than
from here, because the key is generated per installation:

```
0 * * * * /usr/bin/curl -sS -m 60 -H "X-NP-Alert-Key: <panelin kendi anahtari>" https://pos.noktapp.com/cron/uyari.php > /dev/null 2>&1
```

In cPanel: **Cron Jobs → Add New Cron Job**, schedule **Once Per Hour**, and
that line as the command.

Three things worth knowing:

* **The key travels in a header, never in the URL.** A key in the address is
  written into the hosting account's access log, the cron listing itself, and
  the browser history of anybody who ever pastes it. The endpoint therefore
  REFUSES a request that carries the key in the query string rather than
  quietly doing the work.
* **Calling it more often than hourly is harmless.** A second call inside five
  minutes does nothing and says so; and even without that, the same alert
  cannot go out twice — `np_alert_sent` holds one row per (rule, customer,
  occasion) and the row is claimed before the e-mail is sent.
* **The Uyarılar screen says when the cron last ran.** If that figure is hours
  old on an hourly job, the line is not installed or the host has stopped it,
  and the screen says so in red. Rolling the key from that screen invalidates
  the old one immediately — paste the new line into cPanel at the same time.

Alerts go to every active panel administrator unless a rule names an address of
its own. The four rules — licence expiring, till silent, no backup, day not
closed — all have thresholds you can change on that screen.
