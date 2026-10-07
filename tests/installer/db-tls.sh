#!/usr/bin/env bash
#
# A database with a SELF-SIGNED certificate (a PostgreSQL container), the situation that broke a real install:
# the wizard offered "encrypted, certificate not verified" but wrote sslmode=require, which this app's driver
# (pg 8) treats as verify-full, so the migrations failed with SELF_SIGNED_CERT_IN_CHAIN while the wizard's own
# psql-based connection test had passed. Checks what the APP does with each sslmode, and that the wizard's
# test now agrees with the app and offers the way out.
#
#   tests/installer/db-tls.sh        (needs docker; the host's address is reached from containers)
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${WIZ_HOST:-$(hostname -I | awk '{print $1}')}"
PORT=55433
pass=0; failn=0
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "  ok    $what"; else failn=$((failn + 1)); echo "  FAIL  $what"; fi; }
W=$(mktemp -d); trap 'docker rm -f tls-db >/dev/null 2>&1; rm -rf "$W"' EXIT

docker rm -f tls-db >/dev/null 2>&1
docker run -d --name tls-db -e POSTGRES_PASSWORD=pw -p "$PORT:5432" postgres:16-alpine sh -c '
  apk add -q --no-cache openssl >/dev/null 2>&1
  openssl req -new -x509 -days 2 -nodes -subj /CN=localhost -keyout /var/lib/postgresql/server.key -out /var/lib/postgresql/server.crt 2>/dev/null
  chown postgres /var/lib/postgresql/server.* && chmod 600 /var/lib/postgresql/server.key
  exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key' >/dev/null
for _ in $(seq 1 60); do docker exec tls-db pg_isready -U postgres >/dev/null 2>&1 && sleep 3 && break; sleep 2; done

# the app's pool, with each sslmode (the shared package is built to packages/shared/dist)
cat >"$W/probe.mjs" <<'JS'
import { createPool } from "/w/packages/shared/dist/db/index.js";
const pool = createPool({ name: "probe", url: process.env.URL, max: 1, retryAttempts: 1, log: () => undefined });
try { await pool.query("SELECT 1"); console.log("OK"); } catch (e) { console.log("FAIL " + (e.code || e.message)); }
await pool.end().catch(() => {});
process.exit(0);
JS
probe() { docker run --rm -v "$REPO":/w -v "$W/probe.mjs":/probe.mjs:ro -w /w -e URL="postgresql://postgres:pw@$HOST:$PORT/postgres?sslmode=$1" -e NODE_NO_WARNINGS=1 node:20-alpine node /probe.mjs 2>&1 | tail -1; }
echo "== what the app does with each sslmode against a self-signed certificate"
check "no-verify connects (encrypted, not checked)" bash -c "[ \"$(probe no-verify)\" = OK ]"
r=$(probe require); check "require is refused: it means verify-full here ($r)" bash -c "[[ '$r' =~ ^FAIL\ (DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$ ]]"
r=$(probe verify-full); check "verify-full is refused ($r)" bash -c "[[ '$r' =~ ^FAIL\ (DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$ ]]"

echo "== the wizard's own connection test"
base=(DB_MODE=external DB_INPUT=parts DB_ENGINE=other "DB_HOST=$HOST:$PORT" "DB_PORT=$PORT" DB_NAME=postgres DB_USER=postgres DB_PASSWORD=pw DB_TEST=yes S3_MODE=bundled)
ask() { # extra answers... -> output, exit code in $?
  printf '%s\n' "${base[@]}" "$@" >"$W/a.ans"
  (cd "$REPO" && NO_COLOR=1 ./install.sh --check-database --answers "$W/a.ans" </dev/null 2>&1)
}
out=$(ask DB_SSL=no-verify); rc=$?
check "no-verify: the test passes and the URL says no-verify" bash -c "[ $rc -eq 0 ] && grep -q 'sslmode=no-verify' <<<\"\$1\"" _ "$out"
out=$(ask DB_SSL=verify-full DB_SSL_FALLBACK=yes); rc=$?
check "verify-full against a self-signed certificate: it says the certificate is not trusted" bash -c "grep -q 'certificate is not trusted' <<<\"\$1\"" _ "$out"
check "and, when you agree, switches to no-verify and the test then passes" bash -c "[ $rc -eq 0 ] && grep -q 'sslmode=no-verify' <<<\"\$1\"" _ "$out"
out=$(ask DB_SSL=verify-full DB_SSL_FALLBACK=no DB_FAIL=abort); rc=$?
check "declining the fallback stops, it does not quietly lower the security" bash -c "[ $rc -ne 0 ] && ! grep -q 'sslmode=no-verify' <<<\"\$1\"" _ "$out"
url_answers() { printf '%s\n' DB_MODE=external DB_INPUT=url "DATABASE_URL=postgresql://postgres:pw@$HOST:$PORT/postgres?sslmode=require" DB_TEST=yes S3_MODE=bundled "$@" >"$W/a.ans"; }
url_answers DB_SSL_FALLBACK=no DB_FAIL=abort
out=$(cd "$REPO" && NO_COLOR=1 ./install.sh --check-database --answers "$W/a.ans" </dev/null 2>&1); rc=$?
check "a pasted sslmode=require FAILS the test, like the app (it used to pass)" bash -c "[ $rc -ne 0 ]"
check "and it says why" grep -q 'means VERIFY the certificate' <<<"$out"
url_answers DB_SSL_FALLBACK=yes
out=$(cd "$REPO" && NO_COLOR=1 ./install.sh --check-database --answers "$W/a.ans" </dev/null 2>&1); rc=$?
check "a pasted URL also gets the offer to use no-verify, and then connects" bash -c "[ $rc -eq 0 ] && grep -q 'certificate is not trusted' <<<\"\$1\" && grep -q '^DATABASE_URL=.*sslmode=no-verify' <<<\"\$1\"" _ "$out"
check "only the sslmode of the URL was changed" grep -q "^DATABASE_URL=postgresql://postgres:pw@$HOST:$PORT/postgres?sslmode=no-verify\$" <<<"$out"

echo
echo "installer database TLS tests: $pass passed, $failn failed"
[[ $failn -eq 0 ]]
