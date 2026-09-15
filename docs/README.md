# NOKTApp POS — desktop product

This is your restaurant POS rebuilt the same way the hotel product works:
**the whole system runs on the restaurant's own computer.** Your server only
does two things — confirm the licence and hold the nightly backup — plus relay
the waiter phones when they are off the venue Wi-Fi.

Everything in the build came from your `tecofi_nokpos.sql` dump: 86 of its
tables run locally, the 25 tenant/billing/support tables stay on the panel.

---

## What you got

| Folder | What it is | Where it runs |
|---|---|---|
| `database/` | The local schema, split out of your dump, plus the seed and local tweaks | Restaurant PC |
| `pos-service/` | The brain: Node service with the whole POS domain, printing, ÖKC, mail, backup, LAN + relay APIs | Restaurant PC |
| `desktop-shell/` | Electron shell: starts MariaDB and the service, shows the till, auto-updates | Restaurant PC |
| `panel/` | PHP control panel + desktop/mobile APIs + QR menu | pos.noktapp.com |
| `mobile/` | Flutter waiter app (order, print bill, mail bill) | iOS / Android |
| `installer/` | Build scripts for the one-file Windows installer | Your build PC |

---

## The five-minute version of how it works

1. The customer runs one `.exe`. It installs the program, a **bundled MariaDB**
   (nothing to download or configure) and a firewall rule for the phones.
2. First start shows the **online login** — the e-mail and password you issue
   from the panel. That unlocks the machine and caches the licence locally.
3. From then on the till works with the internet unplugged. It re-checks the
   licence every 30 minutes; if your server is unreachable it keeps working for
   the grace period you set per tenant (default 7 days), then asks for internet.
4. Orders, payments, printing and the ÖKC all happen on that PC. Nothing about
   a bill travels over the internet.
5. What does travel: a licence heartbeat, a daily summary, each day-end Z
   figure, and one compressed database backup a night.
6. Waiter phones find the till by itself on the Wi-Fi (Bonjour, plus a subnet
   sweep for routers that block multicast). Off the Wi-Fi, the same request goes
   through `pos.noktapp.com`, which parks it until the PC picks it up — so
   **no static IP and no MikroTik at the restaurant.**

---

## What to do, in order

### 1. Put the panel up (30 minutes, once)

See `docs/INSTALL-panel.md`. Short version:

1. Create a database on cPanel, e.g. `tecofi_nokpos_panel`.
2. Upload the contents of `panel/` to `pos.noktapp.com`.
3. Edit `panel/lib/config.php` — database name/user/password, and set
   `backup_dir` to a folder **outside** `public_html`.
4. Open `https://pos.noktapp.com/setup.php`, create your admin account,
   then **delete `setup.php`**.
5. Log in at `https://pos.noktapp.com/admin/` and add your first restaurant.
   Creating one automatically issues a 30-day trial licence.

### 2. Build the installer (on your Windows machine)

See `docs/BUILD-desktop.md`. Short version:

```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1
```

That downloads and trims MariaDB once, installs dependencies, and produces
`dist\NoktAppPOS-Setup-2.0.0.exe` — one file, ~150 MB, nothing downloaded at
install time. Upload it to `pos.noktapp.com/indir/` and publish the version in
the panel (Sürümler → Yeni sürüm yayınla). `latest.yml` is generated from that,
so auto-update starts working immediately.

### 3. Build the phone app

See `docs/BUILD-mobile.md`. Android Studio, `flutter build appbundle`. iOS goes
through Codemagic as with your other apps.

### 4. Set up a restaurant

1. In the panel: create the tenant, set the plan, seats and expiry.
2. Give them the `.exe`, their e-mail and password.
3. They install, log in once online, and the setup wizard asks for four things:
   business details for the receipt, the first manager PIN, how many tables, and
   the printer. Under five minutes.
4. ÖKC: Ayarlar → ÖKC → add the device (brand, IP, port). Start on
   `simulator` to train the staff without touching a real device.

---

## Things worth knowing

- **A bill closed by accident can be reopened** on the same table for as long as
  the business day is open — Adisyonlar → Geri aç. That was your daily pain
  point and it is a first-class feature, with the reopen counted and logged.
- **The print agent is inside the program.** There is no second window and no
  second install. Jobs queue in `print_jobs`; a printer that is switched off
  delays a slip instead of losing it.
- **VAT is computed by the database triggers from your dump**, unchanged, so
  the Z report and KDV breakdown match what the old web POS produced.
- **The business day does not end at midnight.** It rolls at the hour you set
  (default 06:00), so a bill opened at 02:30 belongs to the previous day.
- **No default passwords anywhere.** The first user is created in the wizard,
  and staff PINs are set by the manager.
- **One accent colour.** Orange on light, graphite for "done". No green
  anywhere, in the till, the panel or the phone app.

## Sadakat (loyalty)

Wired to your existing system, not a copy of it — `pass.noktapp.com` already runs
on `tecofi_nokpos`, and that stays the guest registry. Regulars are recognised,
stamped and rewarded entirely on the restaurant's PC; the server is asked only
about a guest the till has never served, and to mint a new account. Full detail,
including the discount bug this fixes, in `docs/SADAKAT.md`.

## Tests

Four suites, all against a real MariaDB and a real browser:

```bash
cd pos-service
node test/smoke.js         # 26 checks: order → kitchen → payment → ÖKC → Z → day close
node test/loyalty.js       # 21 checks: stamps, rollover, redemption, shared registry
node test/integration.js   #  9 checks: login, grace period, heartbeat, backup, relay
node test/ui.js            # 15 checks: every screen in Chromium, zero JS errors
```

All 71 pass on this build.
