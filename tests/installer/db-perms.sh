#!/usr/bin/env bash
#
# A login that can CONNECT to the database but may not CREATE tables (what a freshly recreated database gives a
# non-owner on PostgreSQL 15+ and YugabyteDB releases based on it): the migrations then die at their first
# statement with "permission denied for schema public". The wizard's connection test must say so, with the
# commands that fix it, before anything is built. Uses a PostgreSQL 16 container (and CockroachDB for no-regression).
#   tests/installer/db-perms.sh        (needs docker)
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${WIZ_HOST:-$(hostname -I | awk '{print $1}')}"
PORT=55434; CPORT=55435
pass=0; failn=0
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "  ok    $what"; else failn=$((failn + 1)); echo "  FAIL  $what"; fi; }
W=$(mktemp -d); trap 'docker rm -f perm-pg perm-crdb >/dev/null 2>&1; rm -rf "$W"' EXIT

docker rm -f perm-pg perm-crdb >/dev/null 2>&1
docker run -d --name perm-pg -e POSTGRES_PASSWORD=pw -p "$PORT:5432" postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec perm-pg pg_isready -U postgres >/dev/null 2>&1 && sleep 2 && break; sleep 2; done
sql() { docker exec -i perm-pg psql -U postgres -v ON_ERROR_STOP=1 -q "$@" >/dev/null; }
sql -c "CREATE ROLE app LOGIN PASSWORD 'pw'" -c "CREATE DATABASE church" -c "CREATE DATABASE church_owned OWNER app"

check_db() { # database [extra answers...] -> output; exit status of the wizard in $?
  local db=$1; shift
  printf '%s\n' DB_MODE=external DB_INPUT=url "DATABASE_URL=postgresql://app:pw@$HOST:$PORT/$db?sslmode=disable" DB_TEST=yes DB_FAIL=abort S3_MODE=bundled "$@" >"$W/a.ans"
  (cd "$REPO" && NO_COLOR=1 ./install.sh --check-database --answers "$W/a.ans" </dev/null 2>&1)
}

echo "== a login with no right to create tables"
out=$(check_db church); rc=$?
check "the test fails" test $rc -ne 0
check "it says the login cannot create tables, naming the login and the database" bash -c "grep -q \"login 'app' can connect to 'church' but is not allowed to create tables\" <<<\"\$1\"" _ "$out"
check "it prints the GRANT commands that fix it" bash -c "grep -q 'GRANT ALL ON SCHEMA public TO \"app\"' <<<\"\$1\" && grep -q 'GRANT ALL ON DATABASE \"church\" TO \"app\"' <<<\"\$1\"" _ "$out"

echo "== after the grants"
sql -c 'GRANT ALL ON DATABASE church TO app'
docker exec -i perm-pg psql -U postgres -d church -q -c 'GRANT ALL ON SCHEMA public TO app' >/dev/null
out=$(check_db church); rc=$?
check "the test passes" test $rc -eq 0

echo "== a login that owns the database"
out=$(check_db church_owned); rc=$?
check "the test passes without any grants" test $rc -eq 0

echo "== a database whose public schema was dropped"
docker exec -i perm-pg psql -U postgres -d church_owned -q -c 'DROP SCHEMA public CASCADE' >/dev/null
out=$(check_db church_owned); rc=$?
check "it says the schema is missing and how to recreate it" bash -c "[ $rc -ne 0 ] && grep -q \"no 'public' schema\" <<<\"\$1\" && grep -q 'CREATE SCHEMA public AUTHORIZATION \"app\"' <<<\"\$1\"" _ "$out"

echo "== CockroachDB is not affected"
docker run -d --name perm-crdb -p "$CPORT:26257" cockroachdb/cockroach:v24.2.0 start-single-node --insecure >/dev/null
until docker exec perm-crdb cockroach sql --insecure -e 'select 1' >/dev/null 2>&1; do sleep 1; done
docker exec perm-crdb cockroach sql --insecure -e 'CREATE DATABASE church' >/dev/null
printf '%s\n' DB_MODE=external DB_INPUT=url "DATABASE_URL=postgresql://root@$HOST:$CPORT/church?sslmode=disable" DB_TEST=yes DB_FAIL=abort S3_MODE=bundled >"$W/a.ans"
(cd "$REPO" && NO_COLOR=1 ./install.sh --check-database --answers "$W/a.ans" </dev/null >"$W/crdb.out" 2>&1); rc=$?
check "the test passes and names the engine" bash -c "[ $rc -eq 0 ] && grep -q CockroachDB '$W/crdb.out'"

echo
echo "installer database permission tests: $pass passed, $failn failed"
[[ $failn -eq 0 ]]
