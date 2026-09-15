#!/usr/bin/env bash
#
# THE WHOLE PRODUCT, both halves, one command.
#
# `npm test` proves the restaurant PC. It does not touch the panel's own code -
# the admin screens, the chain menu, the reports, the diagnostics, the alerts -
# which is PHP and has its own suites under panel/tests/. Running only one half
# and calling it "the tests passed" is how a half ships broken.
#
# This runs, in order:
#   1. test/panel-fixture.sh   the panel database, rebuilt from scratch
#   2. test/run-all.sh         30 till suites, ending with the endpoint gap
#   3. panel/tests/*.php       5 panel suites
#
# The panel must already be SERVING before this starts - four php workers behind
# the proxy on 8090. If it is not, run test/panel-fixture.sh --serve once and
# then come back here.
#
#   test/tumu.sh                 everything      (npm run test:full)
#   test/tumu.sh --panel-only    only the panel  (npm run test:panel)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PANEL="${PANEL:-http://127.0.0.1:8090}"
ONLY_PANEL=0
[ "${1:-}" = "--panel-only" ] && ONLY_PANEL=1
FAILED=0

if ! curl -s -o /dev/null --max-time 5 "$PANEL/"; then
  echo "The panel is not answering at $PANEL."
  echo "Start it once with:  test/panel-fixture.sh --serve"
  exit 1
fi

if [ "$ONLY_PANEL" = 0 ]; then
  echo "═══ 1/3  panel database ═══════════════════════════════════════════════"
  bash "$HERE/panel-fixture.sh" || exit 1

  echo
  echo "═══ 2/3  the restaurant PC ════════════════════════════════════════════"
  bash "$HERE/run-all.sh" || FAILED=1
  echo
  echo "═══ 3/3  the panel ════════════════════════════════════════════════════"
else
  bash "$HERE/panel-fixture.sh" || exit 1
  echo
fi
for t in panel chain rapor teshis uyari; do
  printf '%-13s ' "$t"
  OUT="$(cd "$ROOT/panel" && timeout 600 php "tests/$t.php" 2>&1)"
  LINE="$(echo "$OUT" | grep -E 'checks passed|kontrol geçti' | tail -1)"
  if [ -z "$LINE" ]; then
    echo "DID NOT COMPLETE"; echo "$OUT" | tail -5 | sed 's/^/              /'; FAILED=1; continue
  fi
  echo "$LINE"
  BAD="$(echo "$OUT" | grep -E '^  FAIL')"
  if [ -n "$BAD" ]; then echo "$BAD" | sed 's/^/  /'; FAILED=1; fi
done

echo
if [ "$FAILED" = 0 ]; then
  [ "$ONLY_PANEL" = 1 ] && echo "PANEL GREEN" || echo "EVERYTHING GREEN - both halves"
else
  echo "SOME CHECKS FAILED"
fi
exit $FAILED
