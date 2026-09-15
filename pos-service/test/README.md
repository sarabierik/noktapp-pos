# Tests

Four suites, all against a real MariaDB and a real browser — no mocks, because
the things that break in a POS are exactly the things mocks hide: a trigger that
rewrites VAT, a printer queue that never drains, a screen that throws on first
paint.

| Suite | What it proves | Checks |
|---|---|---|
| `smoke.js` | The trading day: setup → PIN → table → order → kitchen → cancel → discount → split → payment → ÖKC → reopen → phone → Z report → day close → backup | 26 |
| `integration.js` | The PC ↔ panel contract: online login, offline grace, expired grace, heartbeat, day-end push, cloud backup, phone relay both ways | 9 |
| `loyalty.js` | Sadakat: phone normalisation, stamps per item, rollover, no double-stamping, atomic redemption under concurrent taps, the reward surviving the next item change, and the round trip through the shared guest registry | 21 |
| `ui.js` | The till interface in Chromium: every screen renders, the bill adds up, the sadakat strip stamps a real guest, no JavaScript errors anywhere in the walk. Writes screenshots to `test/shots/` | 15 |

## Running them

```bash
# 1. a MariaDB with the local schema loaded
mariadb -e "CREATE DATABASE noktapp_pos CHARACTER SET utf8mb4"
mariadb noktapp_pos < ../database/01_schema_core.sql
mariadb noktapp_pos < ../database/02_schema_local.sql
mariadb noktapp_pos < ../database/04_local_tweaks.sql
sed 's/:client_id/19/g' ../database/03_seed.sql | mariadb noktapp_pos

# 2. point the service at it
export NOKTAPP_DATA_DIR=/tmp/nokdata      # holds config.json, logs, backups

node test/smoke.js
node test/ui.js
node test/loyalty.js
```

`loyalty.js` runs its local checks with no panel. Give it `PANEL` and a
`SHARED_DSN` (mariadb CLI arguments for the shared guest registry) and it also
proves the round trip to the server:

```bash
PANEL=http://127.0.0.1:8090 SHARED_DSN="tecofi_nokpos" node test/loyalty.js
```

### The panel half of the bench

Four suites — `integration`, the server half of `loyalty`, `zincir` and `geri` —
are about the CONTRACT between the restaurant PC and pos.noktapp.com, so they
cannot be proved with the PC alone. Without a panel they fail at their first
fixture and say nothing at all about the code, which is worse than not running
them: it looks like fourteen broken features.

One script builds that half and serves it:

```bash
test/panel-fixture.sh --serve
```

It rebuilds `nokpos_panel` and `nokpos_shared` from `panel/sql/*.sql` and the
product schema, seeds the tenant every local suite logs in as (client 19,
`restoran@ornek.com`), the chain tenant `zincir.js` works against (22 — MERKEZ
and KALEICI, Kofte price-locked at 180, Cay open at 20), and then starts four
`php -S` workers behind the round-robin proxy on 8090. Four, because PHP's dev
server is single threaded and the relay holds a request open while the phone
waits for its answer — one worker deadlocks against itself. On cPanel no proxy
is needed; PHP already runs one process per request.

It drops both databases every time it runs. It is a sandbox fixture: point it
at anything real and you lose it.

`test/run-all.sh` does NOT start the panel — it checks whether one is answering
and says so at the top of the run, so a red suite is never mistaken for a bug in
the till when it is really a missing server.

### Coverage, not vibes

Two of the suites measure the run itself rather than the product:

| `uclar.js` | Every endpoint the service declares, called at least once. A 500 is a failure; a 400/403/404/409 — and a 502/503 from an OKC or a panel this container does not have — is a pass, because the endpoint was reached and the handler decided. It is the floor, not the ceiling. |
| `kapsam.js` | Runs last. Holds every declared route against the trace `src/index.js` writes when `NOKTAPP_TRACE_ROUTES` is set, and names every endpoint no suite touched. `npm run test:coverage` wraps the same run in c8 for per-file line numbers. |
