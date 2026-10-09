#!/usr/bin/env bash
# run-local.sh
# Builds a throwaway Postgres, applies the migration, and runs the database tests.
# LOCAL TESTING ONLY: it never touches Supabase. Needs the Postgres server programs
# (initdb, pg_ctl, psql), Postgres 15 or newer, and Node.js for the formula cross-check.
#
#   bash supabase/tests/run-local.sh
#
# Optional: PGBIN=/path/to/postgres/bin  MIGRATION=path/to/other.sql (used to test deliberately broken copies)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MIGRATION="${MIGRATION:-$ROOT/supabase/migrations/20261009120000_core_schema.sql}"

if [ -z "${PGBIN:-}" ]; then
  if command -v pg_ctl >/dev/null 2>&1; then PGBIN="$(dirname "$(command -v pg_ctl)")"
  else PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"; fi
fi
[ -x "${PGBIN:-}/pg_ctl" ] || { echo "Cannot find Postgres programs. Set PGBIN." >&2; exit 2; }

# Postgres refuses to run as root, so when we are root we run it as the 'postgres' user.
RUN=()
if [ "$(id -u)" = "0" ]; then RUN=(runuser -u postgres --); BASE="/var/lib/postgresql/fuel-surcharge-test"; else BASE="${TMPDIR:-/tmp}/fuel-surcharge-test-$$"; fi
DATA="$BASE/data"; SOCK="$BASE/sock"; PORT="${PGTESTPORT:-54329}"
"${RUN[@]}" rm -rf "$BASE"; "${RUN[@]}" mkdir -p "$SOCK"

cleanup() { "${RUN[@]}" "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; "${RUN[@]}" rm -rf "$BASE"; }
trap cleanup EXIT

"${RUN[@]}" "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >/dev/null
"${RUN[@]}" "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=''" -l "$BASE/log" -w start >/dev/null

export PGHOST="$SOCK" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres
PSQL=("$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -At)

echo "Postgres: $("$PGBIN/postgres" --version)"
"${PSQL[@]}" -f "$HERE/support/00_supabase_stub.sql"
"${PSQL[@]}" -f "$HERE/support/01_harness.sql"
echo "Applying migration: $(basename "$MIGRATION")"
"${PSQL[@]}" -f "$MIGRATION"

echo
echo "== Schema and security tests =="
set +e
"${PSQL[@]}" -f "$HERE/schema_and_security.test.sql" 2>&1 | sed 's/^psql:[^ ]* //'
STATUS=${PIPESTATUS[0]}
set -e

echo
echo "== Formula cross-check (JavaScript engine vs the database rule) =="
node "$HERE/formula_crosscheck.mjs" || STATUS=1
exit "$STATUS"
