# Running a day on NOKTApp POS

Written in English for you; the product's own screens are all Turkish.

## Opening

1. The PC starts, the program starts with it.
2. Staff sign in with their PIN. The tenant login only happens on the first
   install (and after a licence lapse).
3. Cashier opens the shift with the float in the drawer: **Vardiya aç**.

## During service

* **Masalar** — the floor plan. Orange means a bill is open, with its total.
* Tap a table → the order screen. Left is the menu, right is the bill.
  Long-press (or right-click) a product to add a kitchen note.
* **Mutfak** sends everything not yet sent, one slip per station. Stock comes
  off at that moment, not at payment.
* Tap a line to change quantity, price (with the right permission) or to cancel
  it. Cancelling something already sent prints a void slip so the kitchen stops.
* **Diğer** covers discount, table transfer, split, merge, mail the bill, link a
  customer, open the drawer, delete the bill. Anything sensitive asks for a
  supervisor PIN if the signed-in user lacks the permission.
* **Öde** takes cash, card, meal card, transfer, comp or account — or hands the
  sale to the ÖKC for a fiscal receipt.

## Closing

1. **Vardiya kapat** with the counted cash. The variance is recorded.
2. **Raporlar → Gün sonu**. It refuses while a bill is open or a shift is still
   running, and tells you which. The Z report prints automatically.

## The reopen

A bill closed by mistake: **Adisyonlar → Kapanan adisyonlar → Geri aç**. The
bill comes back to its table with everything on it. It works until the day is
closed, and every reopen is counted and written to the audit log.

## When a customer rings

**Panel → Destek → Kasa teşhis**, or the customer's own page → *Kasa teşhis*.

Each till reports its own health on the licence heartbeat, at most once an
hour: application and database versions, the operating system, free disk,
database size, every printer with its type and what happened to the last job
sent to it, station count, print jobs still queued, open bills, the last day
close, whether an ÖKC is set up, and the last error lines from its own log. The
last two dozen of those documents are kept, so a printer that has been failing
since Tuesday or a disk that has lost 4 GB a day is visible as a slope rather
than as one bad morning.

It carries **no customer, guest or bill data of any kind** — counts, versions,
dates and machine facts only, scrubbed on the till and again in the panel.

A till that has never sent a document reads **bilinmiyor**, never "fine": it is
usually a till on an older build. Update it and the next heartbeat fills the
screen in.

## When the internet is down

Everything keeps working. The till shows nothing different. What pauses: the
licence heartbeat, the nightly cloud backup, mailing a bill, and phones that are
off the venue Wi-Fi. All of them resume by themselves.

If the internet is down for longer than the grace period (7 days by default),
the till asks for a connection at the next staff login. You can raise that per
tenant in the panel.

## Backups

* Local snapshot every 15 minutes into `C:\ProgramData\NoktAppPOS\backups`,
  kept 14 days.
* One compressed upload a night at 03:00 to your server, kept 30 days, verified
  by SHA-256 on arrival.
* **Ayarlar → Yedekleme → Şimdi yedekle** before anything risky.

To restore: install the program on the new PC, log in online, then load the
`.sql.gz` into `noktapp_pos` with the bundled `mariadb.exe`.

## Support checklist

| Symptom | First thing to check |
|---|---|
| Phones cannot find the till | Are they on the same Wi-Fi? Firewall rule for 7451 still there? |
| Phone works outside but not inside | Router blocks multicast — the sweep should still find it; check the phone is not on a guest VLAN |
| Nothing prints | Ayarlar → Yazıcılar → Test. Jobs stay queued, so fix the printer and they flush |
| "Gün sonu alınmış" on a new bill | The day was closed; reopen it from Raporlar or start the next day |
| Licence warning | Panel → the tenant → licence status and expiry |
| Till will not start | `C:\ProgramData\NoktAppPOS\logs\shell.log` says which step failed |
