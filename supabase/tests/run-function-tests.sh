#!/usr/bin/env bash
# run-function-tests.sh
# Tests the create-quote function.
#   1. Unit tests: need only Node.js 20 or newer.
#   2. End-to-end tests: build a small copy of Supabase on this computer (see supabase/tests/functions/rig.mjs).
#      They need the Postgres server programs (initdb, pg_ctl, psql, version 15 or newer), the PostgREST program and Deno.
#
#   bash supabase/tests/run-function-tests.sh
#
# Settings (environment variables):
#   POSTGREST_BIN=/path/to/postgrest   required for the end-to-end tests (download from github.com/PostgREST/postgrest/releases)
#   PGBIN=/path/to/postgres/bin        optional, found automatically when pg_ctl is on the PATH
#   DENO_BIN=/path/to/deno             optional, defaults to `deno` on the PATH
#   SKIP_E2E=1                         run only the unit tests
# LOCAL TESTING ONLY: it never touches Supabase.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATUS=0

echo "== Unit tests (fake database) =="
node --test --test-reporter=spec "$HERE"/functions/*.unit.test.mjs || STATUS=1

if [ "${SKIP_E2E:-0}" = "1" ]; then
  echo
  echo "End-to-end tests SKIPPED (SKIP_E2E=1)."
  exit "$STATUS"
fi

if [ -z "${PGBIN:-}" ]; then
  if command -v pg_ctl >/dev/null 2>&1; then PGBIN="$(dirname "$(command -v pg_ctl)")"
  else PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"; fi
fi
DENO_BIN="${DENO_BIN:-$(command -v deno || true)}"
missing=""
[ -x "${PGBIN:-}/pg_ctl" ] || missing="$missing Postgres(PGBIN)"
[ -x "${POSTGREST_BIN:-}" ] || missing="$missing PostgREST(POSTGREST_BIN)"
[ -n "$DENO_BIN" ] && [ -x "$DENO_BIN" ] || missing="$missing Deno(DENO_BIN)"
if [ -n "$missing" ]; then
  echo "Cannot run the end-to-end tests, missing:$missing" >&2
  echo "Set the variables named above, or use SKIP_E2E=1 to run only the unit tests." >&2
  exit 2
fi

echo
echo "== End-to-end tests (real Deno + supabase-js + PostgREST + Postgres) =="
export PGBIN POSTGREST_BIN DENO_BIN
node --test --test-reporter=spec "$HERE/functions/create-quote.e2e.mjs" || STATUS=1
exit "$STATUS"
