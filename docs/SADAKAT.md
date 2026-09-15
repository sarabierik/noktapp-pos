# Sadakat — the loyalty system on the desktop

Yes, it works with your existing system. Not a parallel copy of it — the same
guests, the same QR codes, the same Pass app.

## What I found in your source

`pass.noktapp.com/app/config.php` already points at **`tecofi_nokpos`**, not at
`tecofi_passnoktapp`. You moved Pass onto the POS database precisely so a guest
who signs up in the app is visible at the till, and `pos/loyalty/lib.php` is
where the real engine lives. The old `tecofi_passnoktapp` dump is the dead
version. So the desktop is wired to `tecofi_nokpos` — nothing about the Pass app
changes, and no guest has to re-register.

## The one thing that had to change

The till's tables now live on the restaurant's own PC, but a guest is **global**:
one person, one QR, every NOKTApp restaurant. So the guest registry stays on the
server, and the till talks to it exactly twice:

| Moment | What happens |
|---|---|
| A guest the till has never served | One question to the panel: "who is this?" The answer is cached locally. |
| Enrolling someone new at the counter | The panel mints the account, because only the server can issue an identity that will not collide. Needs internet, and says so plainly if there is none. |

**Everything else is local.** A regular is recognised, stamped and given their
reward with the internet unplugged. Balances are written on the PC first and
mirrored up afterwards, so the guest's app shows the same numbers without the
counter ever waiting on our server.

## Logic ported exactly

From `pos/loyalty/lib.php`, behaviour unchanged:

- **One stamp per item, not per scan.** Three coffees move a 10-coffee card
  three forward. Your own comment calls the old one-per-scan behaviour "the main
  thing that made it feel broken".
- **Rollover.** Buying 12 on a 10-card gives one reward and leaves 2 on the next.
- **A bill is never stamped twice**, whichever route the stamp came from.
- **Redemption is atomic.** The UPDATE is the check, so two tills tapping "use
  reward" at the same instant spend one reward, log one event, and the second
  is told there is nothing to spend.
- **Turkish phone normalisation.** `0537…`, `+90 537…`, `90537…`, `(0537) …`
  all resolve to the same person.
- **An unknown phone is never silently enrolled** — a typo would make a junk
  account.
- **A one-time QR is single use and time limited**; a printed card's permanent
  `qr_uid` also works.

## One bug fixed on the way

`loy_discount_table()` in your lib carries the note: the order engine
recalculated `discount_total` from a table that never existed, so a redeemed
reward came off the bill and the next item change put it straight back. The
customer was told "free coffee" and still paid for it.

On the desktop, `order_discounts` exists (`database/05_loyalty.sql`) and
`orders.recalc()` is the only thing that turns discounts into money — it reads
the ledger every time. A manual discount and a redeemed reward now stack
correctly and neither can erase the other. There is a test for exactly this:
*"the reward stays off the bill after the next item change"*.

## At the counter

Above the bill there is one line: **"Sadakat kartı var mı? — okut veya telefonla
ara."** One box takes all three inputs, because a queue is no place to choose
between three buttons:

- a handheld QR scanner just types the code and presses Enter
- or the cashier types the phone number
- or presses **Yeni müşteri kaydet**

After the scan the guest's cards sit above the bill with a progress bar, and a
completed card turns into an orange **Ödül kullan** button. Pressing it takes
the free item's price off the bill and says how much came off.

A bill closed with a guest attached stamps itself, so a waiter who forgot to
scan at the start does not cost the guest their stamps.

## Programme setup

Ayarlar → the programmes come from `loyalty_programs` as they already are:
a title, a product, a target count and the reward text. A programme with no
product gives one stamp per visit instead of per item.

Reporting is in the manager screens: stamps issued, rewards redeemed, and the
**open liability** — rewards earned but not yet collected, valued at the
product's price. That last number is the one worth watching; it is money the
restaurant already owes.

## Tests

`pos-service/test/loyalty.js` — 21 checks, all passing, including the
concurrency case and the round trip through the shared registry:

```
someone who signed up in the Pass app is recognised at the till
a one-time code from the app is accepted and burned centrally
card balances written at the till reach the shared registry
two tills tapping "use reward" at once spend it only once
the reward stays off the bill after the next item change
```

## What you have to set

In `panel/lib/config.php`, `pass_db` points at `tecofi_nokpos` with that
database's user and password. Leave the name empty to switch loyalty off.
