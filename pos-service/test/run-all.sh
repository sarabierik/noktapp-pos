#!/usr/bin/env bash
#
# Run every suite, from a clean database, in dependency order.
#
# The suites share one database and are not independent: smoke creates the
# staff and the menu that loyalty and ui then use, and each one leaves the day
# and the shift in whatever state its last check needed. Run them twice over
# the same data and you get failures that say nothing about the code - a
# closed day, a spent shift, a table that is already occupied.
#
# So: rebuild the schema first, every time, and run them in this order.
#
#   test/run-all.sh
#
# Environment (all optional, defaults are the sandbox's):
#   DB_PORT     MariaDB port                     3399
#   DB_USER     MariaDB user                     noktapp
#   DB_PASS     MariaDB password                 nokpass
#   PANEL       panel base URL                   http://127.0.0.1:8090
#   SHARED_DB   the shared guest registry        nokpos_shared
#
# integration and the server half of loyalty need the panel running. Locally
# that is eight `php -S` workers behind test/panel-proxy.js, because PHP's dev
# server is single threaded - see test/README.md.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DB_PORT="${DB_PORT:-3399}"
DB_USER="${DB_USER:-noktapp}"
DB_PASS="${DB_PASS:-nokpass}"
DB_NAME="${DB_NAME:-noktapp_pos}"
PANEL="${PANEL:-http://127.0.0.1:8090}"
SHARED_DB="${SHARED_DB:-nokpos_shared}"
export NOKTAPP_DATA_DIR="${NOKTAPP_DATA_DIR:-/tmp/nokdata}"
export PANEL
export SHARED_DSN="${SHARED_DSN:---port=$DB_PORT --protocol=tcp -u$DB_USER -p$DB_PASS $SHARED_DB}"

M="mysql --port=$DB_PORT --protocol=tcp -u$DB_USER -p$DB_PASS"

echo "Rebuilding $DB_NAME…"
$M -e "DROP DATABASE IF EXISTS \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4" || exit 1
for f in 01_schema_core 02_schema_local 04_local_tweaks 05_loyalty; do
  $M "$DB_NAME" < "$ROOT/../database/$f.sql" || exit 1
done
# migrations are part of the schema, not an afterthought: a fresh install runs
# them on first boot too, so the tests must see the same shape a customer does
for m in "$ROOT"/../database/migrations/*.sql; do
  [ -e "$m" ] && $M "$DB_NAME" < "$m"
done
sed 's/:client_id/19/g' "$ROOT/../database/03_seed.sql" | $M "$DB_NAME" || exit 1

# THE RELAY IS OFF FOR THE RUN, AND integration.js TURNS IT ON FOR ITS OWN CHECKS.
#
# Every service bootstrap calls relay.start(), which long-polls the panel and
# holds one PHP worker for up to twenty seconds at a time. A suite that exits
# mid-poll leaves that worker asleep, because PHP only notices a dropped client
# when the script writes output and a long-poll writes nothing until it has an
# answer. Enough quick suites in a row and every worker on the sandbox panel is
# asleep; the next suite's first call then queues and times out, which is what
# made zincir fail six checks about branch codes - none of them about branches.
#
# So no suite holds a panel worker by accident. The relay's own behaviour is
# still proved, in the one suite that is about it: integration.js switches this
# back on around its two relay checks and off again afterwards.
$M "$DB_NAME" -e "UPDATE np_settings SET v='0' WHERE k='relay_enabled'" || exit 1

# the panel's device list is per-licence and seat-limited; leftovers from an
# earlier run make the next login fail with "your licence is for N computers"
$M -e "DELETE FROM nokpos_panel.np_devices" 2>/dev/null

# Every endpoint the run touches is written here, and test/kapsam.js holds it
# against the list the service declares. Cleared first so a stale file cannot
# make an untested endpoint look tested.
export NOKTAPP_TRACE_ROUTES="${NOKTAPP_TRACE_ROUTES:-/tmp/noktapp-routes.txt}"
: > "$NOKTAPP_TRACE_ROUTES"

# integration, the server half of loyalty, zincir and geri all speak to the
# panel. Without it they fail at their first fixture and say nothing about the
# code, so the run says plainly which half of the bench is missing.
if curl -s -o /dev/null --max-time 3 "$PANEL/"; then
  echo "panel: $PANEL"
else
  echo "panel: NOT RUNNING at $PANEL - integration, loyalty, zincir and geri will fail."
  echo "       build and serve it with:  test/panel-fixture.sh --serve"
fi

echo
FAILED=0

# The shell cannot be RUN here - it needs Electron and Windows - but its engine
# resolution can be read, and that is the code that took a till down. Before
# any suite, because if the shell cannot find a database engine, nothing below
# this line would be running on a customer's machine at all.
printf '%-13s ' motor
if node "$ROOT/../desktop-shell/test/motor.js" 2>&1 | tail -1; then :; else FAILED=1; fi
# The update channel, for the same reason and one step further: this is the one
# path where being wrong means administrator code on every till we have sold.
printf '%-13s ' guncelleme
if node "$ROOT/../desktop-shell/test/guncelleme.js" 2>&1 | tail -3; then :; else FAILED=1; fi
# Printer discovery: sockets and an interface table, no database and no server,
# so it belongs up here with the other two. It is in the suite because the bug
# it covers made the till report a fact about the restaurant's network that it
# had never gone and looked at.
printf '%-13s ' yazici-tarama
if node "$ROOT/test/yazici-tarama.js" 2>&1 | tail -1; then :; else FAILED=1; fi
# The pairing symbol. No database either, and it guards the one attribute whose
# absence made "karekod okutun" impossible on every build we ever shipped.
printf '%-13s ' karekod
if node "$ROOT/test/karekod.js" 2>&1 | tail -1; then :; else FAILED=1; fi
# geri is LAST and has to stay last: it is the only suite that drops and
# reloads the whole database, several times. Anything after it would be running
# against whichever dump its final restore put back.
#
# roller and yetki come AFTER zincir for a smaller version of the same reason.
# Between them they make some fifteen hundred requests in three minutes, and
# the test panel is a handful of single-threaded `php -S` workers; zincir's
# branch bind waits on one of them and times out after thirty seconds if they
# are still draining. Nothing is wrong with either suite - the sandbox panel is
# simply not a cPanel server, and the suites that test the panel contract go
# first. (The bigger half of that problem - abandoned relay long-polls holding
# a worker asleep for twenty seconds - is dealt with above, by switching the
# relay off for the run.)
# The four suites that need the PHP panel. On CI there is no panel, so they are
# skipped by name rather than left to fail with a timeout that says nothing.
PANEL_SUITES=" integration loyalty zincir geri "

for t in schema gocler smoke akis integration loyalty ui ui-all yardim menu stock settings station floor tablegroup finance export till matematik pricing guest device qrmenu entegrasyon yemeksepeti migros paket okc okc-kayit hugin zincir teshis roller yetki pda senkron eslestirme demoveri kilit zaman uclar geri kapsam; do
  if [ "${CI_SKIP_PANEL:-0}" = "1" ] && [[ "$PANEL_SUITES" == *" $t "* ]]; then
    printf '%-13s %s\n' "$t" "atlandi (panel yok)"
    continue
  fi
  printf '%-13s ' "$t"
  OUT="$(timeout 600 node "$HERE/$t.js" 2>&1 | grep -v '^\[')"
  LINE="$(echo "$OUT" | grep -E 'checks passed|kontrol geçti')"
  if [ -z "$LINE" ]; then
    echo "DID NOT COMPLETE"
    echo "$OUT" | tail -5 | sed 's/^/              /'
    FAILED=1
    continue
  fi
  echo "$LINE"
  BAD="$(echo "$OUT" | grep -E '^  ! |^  FAIL')"
  if [ -n "$BAD" ]; then echo "$BAD" | sed 's/^/  /'; FAILED=1; fi
done

echo
[ "$FAILED" = 0 ] && echo "ALL GREEN" || echo "SOME CHECKS FAILED"
exit $FAILED
