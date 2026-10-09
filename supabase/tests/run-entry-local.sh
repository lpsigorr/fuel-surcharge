#!/usr/bin/env bash
# run-entry-local.sh
# Step 4 tests. Builds a throwaway Postgres, applies the Step 2 migration AND the Step 4 migration, then runs:
#   1. the Step 2 tests again (proof that Step 4 changed nothing that Step 2 promised)
#   2. the Step 4 tests (diesel_price_entry.test.sql)
#   3. a cross-check of the 5 % rule and the rounding against the Step 1 engine, on thousands of random price pairs
# LOCAL TESTING ONLY: it never touches Supabase. Needs the Postgres server programs (initdb, pg_ctl, psql),
# Postgres 15 or newer, and Node.js 20 or newer.
#
#   bash supabase/tests/run-entry-local.sh
#
# Optional: PGBIN=/path/to/postgres/bin   MIGRATION=other core migration   ENTRY_MIGRATION=other Step 4 migration
#           (the last two are used to test deliberately broken copies)   SKIP_REGRESSION=1   SKIP_CROSSCHECK=1

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MIGRATION="${MIGRATION:-$ROOT/supabase/migrations/20261009120000_core_schema.sql}"
ENTRY_MIGRATION="${ENTRY_MIGRATION:-$ROOT/supabase/migrations/20261009150000_diesel_price_entry.sql}"

if [ -z "${PGBIN:-}" ]; then
  if command -v pg_ctl >/dev/null 2>&1; then PGBIN="$(dirname "$(command -v pg_ctl)")"
  else PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"; fi
fi
[ -x "${PGBIN:-}/pg_ctl" ] || { echo "Cannot find Postgres programs. Set PGBIN." >&2; exit 2; }

# Postgres refuses to run as root, so when we are root we run it as the 'postgres' user.
RUN=()
if [ "$(id -u)" = "0" ]; then RUN=(runuser -u postgres --); BASE="/var/lib/postgresql/fuel-surcharge-entry-$$"; else BASE="${TMPDIR:-/tmp}/fuel-surcharge-entry-$$"; fi
DATA="$BASE/data"; SOCK="$BASE/sock"; PORT="${PGTESTPORT:-$((54400 + $$ % 500))}"
"${RUN[@]}" rm -rf "$BASE"; "${RUN[@]}" mkdir -p "$SOCK"

cleanup() { "${RUN[@]}" "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; "${RUN[@]}" rm -rf "$BASE"; }
trap cleanup EXIT

"${RUN[@]}" "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >/dev/null
"${RUN[@]}" "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=''" -l "$BASE/log" -w start >/dev/null

export PGBIN PGHOST="$SOCK" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres
PSQL=("$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -At)

echo "Postgres: $("$PGBIN/postgres" --version)"
"${PSQL[@]}" -f "$HERE/support/00_supabase_stub.sql"
"${PSQL[@]}" -f "$HERE/support/01_harness.sql"
echo "Applying: $(basename "$MIGRATION")"
"${PSQL[@]}" -f "$MIGRATION"
echo "Applying: $(basename "$ENTRY_MIGRATION")"
"${PSQL[@]}" -f "$ENTRY_MIGRATION"

STATUS=0
set +e
if [ "${SKIP_REGRESSION:-0}" != "1" ]; then
  echo
  echo "== Step 2 tests, re-run with the Step 4 migration applied =="
  "${PSQL[@]}" -f "$HERE/schema_and_security.test.sql" 2>&1 | sed 's/^psql:[^ ]* //'
  [ "${PIPESTATUS[0]}" = "0" ] || STATUS=1
fi

echo
echo "== Step 4 tests: publishing a diesel price =="
"${PSQL[@]}" -f "$HERE/diesel_price_entry.test.sql" 2>&1 | sed 's/^psql:[^ ]* //'
[ "${PIPESTATUS[0]}" = "0" ] || STATUS=1

if [ "${SKIP_CROSSCHECK:-0}" != "1" ]; then
  echo
  echo "== Cross-check: the 5 % rule and the rounding, Step 1 engine vs the database =="
  node "$HERE/entry_crosscheck.mjs" || STATUS=1
fi
set -e
exit "$STATUS"
