# The guest API — what the NOKTA app talks to

`https://pos.noktapp.com/api/guest/*`

Nine endpoints. The restaurant-facing API in `api/desktop/` authenticates a
machine we sold, with `client_id` + `licence_key`. This one authenticates a
member of the public holding a phone, and the only thing they own is a session
token. That difference is the reason it is a separate folder with its own
helper (`lib/guest.php`) rather than three more files in `api/desktop/`.

## The three rules the whole thing rests on

1. **A guest sees their own rows and nothing else.** Every query filters on the
   customer id that came out of the token, never out of the request body. An
   endpoint that takes a `customer_id` from the caller is an endpoint that hands
   one guest another guest's card balances. `card.php` does take a `tenant_id`
   and a `program_id` — but only to filter the guest's own cards, so guessing a
   tenant id returns your own (empty) card there and teaches you nothing.

2. **Tokens are stored hashed.** A session row is a bearer credential. A database
   dump containing them would log an attacker in as every guest at once, so
   `np_guest_sessions` keeps `sha256(token)` and the plain token exists only in
   the app.

3. **Nothing here writes a stamp.** The till is the only thing that may move a
   balance, at the counter, with the guest present. This API reads the mirror,
   hands out one-time codes, and edits the guest's own profile.

The token travels in `Authorization: Bearer <64 hex>` and **never** in a URL —
a URL ends up in access logs, in referrers and in the user's own history.

---

## Endpoints

| | Method | Auth | What |
|---|---|---|---|
| `register.php` | POST | — | Sign up, or claim a till-enrolled account |
| `login.php` | POST | — | Phone + password → token |
| `logout.php` | POST | ✓ | End this session (`all: true` for every device) |
| `cards.php` | GET | ✓ | Kartlarım: every card, grouped by restaurant |
| `card.php` | POST | ✓ | One card + its movements |
| `history.php` | GET | ✓ | Geçmiş: every movement, every restaurant |
| `qr.php` | POST | ✓ | Mint a one-time code (5 minutes, single use) |
| `restaurants.php` | GET | ✓ | Keşfet: live campaigns |
| `profile.php` | GET/POST | ✓ | Read, edit, change password |
| `delete.php` | POST | ✓ | Erase the account |

Every reply is `{"ok": true, ...}` or `{"ok": false, "error": "...", "code": "..."}`.

### The three codes that change what the app does

- **`NEEDS_REGISTER`** (login, 409) — the number is known but has no password.
  The app switches to sign-up rather than letting somebody retype a password
  they never set. This does admit the number is known to the platform: a
  deliberate trade, because without it every till-enrolled guest hits a dead end
  on the login screen, and the fact leaked is one a restaurant already knows.
- **`NEEDS_PROOF`** (register, 409) — the number is known AND carries stamps.
  The app asks for the card code.
- **`ALREADY_REGISTERED`** (register, 409) — send them to login.

A wrong password and an unknown number both answer **401 with the same text**,
and the login endpoint runs `password_verify` against a throwaway hash when
there is no row, so the two take the same time. Otherwise this endpoint is a
directory of who has a NOKTA account.

---

## Sign-up, and the hole that is deliberately left closed

Most people who install NOKTA were enrolled at a counter months ago: the account
exists, with real stamps, and has never had a password. Handing it over to
anyone who can type the phone number would hand a stranger somebody's free
pizzas and the list of restaurants they eat at. So possession has to be proved,
and the only proof available offline is the `qr_uid` printed on the guest's own
card.

**An SMS one-time code is the right second channel and is NOT implemented.** It
needs a Turkish SMS provider under contract; inventing an endpoint would make
this look finished when it is not. It plugs in at exactly the point
`register.php` checks the card code, and nothing else changes.

A brand-new number is created without any verification. Nothing exists on it to
steal, and the row is marked `is_verified=0`, which the till already reads.

---

## Rate limiting

`np_guest_attempts`, in the shared database rather than the panel's
`np_login_attempts`, because a guest is not a tenant and the two limits must not
share a bucket.

Only **failed** attempts count, and there are two limits at once:
**5 per phone number** and **40 per IP address**, both over 15 minutes. By phone
alone, one attacker walks the whole number space from one machine. By address
alone, a phone behind a carrier NAT locks out a neighbourhood.

---

## Where the data comes from

The guest's phone is three hops from the cashier's hand:

```
till (restaurant PC)  --sync-->  panel (pos.noktapp.com)  --this API-->  phone
```

The till pushes three things, all keyed so they cannot collide between
restaurants:

| Pushed | Lands in | Key |
|---|---|---|
| `loyalty_cards` | `pass_db.loyalty_cards` | (client, customer, program) |
| `loyalty_programs` | `pass_db.np_tenant_programs` | **(tenant, program_id)** |
| `loyalty_events` | `pass_db.np_guest_events` | **(tenant, event_id)** |

The two bold keys are the whole reason those tables exist. `loyalty_programs`
and `loyalty_events` auto-increment **per till**, so every restaurant we have
ever sold to has a programme 3 and an event 41. Writing a till's local id into a
table keyed by that id alone would let one restaurant's campaign land on
another's — silently, with the guest's card still pointing at the row. The
shapes live in `panel/lib/pass_tables.php`, in one file, because
`api/desktop/sync.php` writes them and `api/guest/*` reads them and the one
thing worse than an unmigrated table is two files disagreeing about its columns.

Legacy web-POS tenants are untouched: they keep writing `pass_db.loyalty_programs`
as they always have, and `guest_cards()` joins that table on **(id AND
client_id)** so a legacy row can only ever match its own tenant. If that table is
not present at all — a panel that has only ever sold the desktop product — the
join is built without it rather than 502-ing the guest's Kartlarım screen.

**A card whose campaign is missing from both sources is dropped, not shown as
"?".** A card with no campaign is the exact bug this chain was built to fix, and
a restaurant that has not synced yet should look absent rather than broken.

---

## Deleting an account

Both stores require it, reachable from inside the app; it is two taps from
Profil and is not hidden behind a support e-mail.

**Erased:** every personal field on the guest row (name, phone, e-mail, date of
birth, password, card code), every session on every device, every unspent
one-time code, the whole mirrored movement history.

**Kept, anonymised:** the loyalty card rows. A restaurant's stamp ledger is its
own accounting record — the open liability on its books is money it owes.
Pointing at a row with no personal data on it, those are numbers about a card,
not facts about a person.

**Not reached, and the guest is told so:** the restaurants' own computers. A till
caches a guest it has served so it can recognise them with the internet
unplugged — that is the feature that makes the counter work — and those caches
sit on machines we do not control. They fall out of use because nothing resolves
to them any more, but the name is in a local database until that restaurant is
asked directly. Saying otherwise in a privacy screen would be a lie, and the kind
a regulator reads out loud. Pushing a deletion instruction down to the tills is
real work and is not built.

---

## Tests

`php panel/tests/guest.php` — 38 checks against the real MariaDB and the real
HTTP endpoints, nothing mocked. It creates its own tenants and guests and
deletes them again, so it never touches the tenant the desktop suites use.

The ones worth knowing are there:

```
a till-enrolled account cannot be taken over with the phone number alone
a wrong card code does not take it over either
the real card code claims the account and keeps its stamps
a wrong password and an unknown number give the same answer
the session token is stored hashed, never in the clear
a token in the query string is not a token
one guest cannot see another guest's card
restaurants that all call their campaign number 3 do not overwrite each other
a legacy web-POS card still resolves through loyalty_programs
a card whose campaign never synced is left out, not shown broken
a password change signs the other phones out but not this one
delete erases the person, keeps the restaurant's ledger, and says so
```
