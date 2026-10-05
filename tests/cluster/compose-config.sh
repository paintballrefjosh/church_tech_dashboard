#!/usr/bin/env bash
#
# What scripts/compose.sh accepts and rejects for DEPLOY_MODE=cluster, and what the compose file
# list resolves to. Needs no running containers (only `docker compose config`, which only reads).
#
#   tests/cluster/compose-config.sh
#
# Everything is set through the environment, which wins over .env, so the result does not depend
# on the .env of the machine it runs on (the .env is only read for what the cases leave unset).
set -uo pipefail
cd "$(dirname "$0")/../.."
pass=0; fail=0
# Start from a clean slate for every variable the cases touch.
CLEAN=(env -u DEPLOY_MODE -u NODE_ID -u NODE_ROLE -u NODE_ADDR -u CLUSTER_PEERS -u CLUSTER_BIND_ADDR
  -u CLUSTER_DB_PORT -u CLUSTER_S3_RPC_PORT -u CLUSTER_S3_API_PORT -u GARAGE_REPLICATION_FACTOR
  -u DB_MODE -u DATABASE_URL -u S3_MODE -u S3_ENDPOINT AUTH_SECRET=0123456789abcdef0123456789abcdef)

# expect_fail "<message fragment>" [env VAR=value ...] -- [--prod] <compose.sh args>
expect_fail() {
  local frag="$1"; shift
  local out
  out="$("${CLEAN[@]}" "$@" 2>&1)"; local rc=$?
  if [[ $rc -ne 0 && "$out" == *"$frag"* ]]; then pass=$((pass + 1)); echo "  ok    rejects: $frag"
  else fail=$((fail + 1)); echo "  FAIL  expected a failure mentioning '$frag' (exit $rc): $out" | head -n 3; fi
}
# expect_out "<line>" [env ...] -- command: succeeds and prints the line
expect_out() {
  local line="$1"; shift
  local out
  out="$("${CLEAN[@]}" "$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]] && grep -qxF -- "$line" <<<"$out"; then pass=$((pass + 1)); echo "  ok    $line"
  else fail=$((fail + 1)); echo "  FAIL  expected the line '$line' (exit $rc); got:"; echo "$out" | head -n 8 | sed 's/^/        /'; fi
}
expect_contains() {
  local frag="$1"; shift
  local out
  out="$("${CLEAN[@]}" "$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 && "$out" == *"$frag"* ]]; then pass=$((pass + 1)); echo "  ok    config has: $frag"
  else fail=$((fail + 1)); echo "  FAIL  expected '$frag' in the output (exit $rc)"; fi
}
C="bash scripts/compose.sh --prod --cluster-env"
G=(DEPLOY_MODE=cluster NODE_ID=a NODE_ADDR=10.0.0.11 CLUSTER_PEERS=10.0.0.12,10.0.0.13)

echo "== rejected"
expect_fail "needs NODE_ID"            DEPLOY_MODE=cluster $C
expect_fail "production stack"         "${G[@]}" bash scripts/compose.sh --cluster-env
expect_fail "Set DEPLOY_MODE=cluster"  NODE_ROLE=data $C
expect_fail "needs NODE_ADDR"          DEPLOY_MODE=cluster NODE_ID=a CLUSTER_PEERS=10.0.0.12 $C
expect_fail "needs CLUSTER_PEERS"      DEPLOY_MODE=cluster NODE_ID=a NODE_ADDR=10.0.0.11 $C
expect_fail "may only contain"         DEPLOY_MODE=cluster NODE_ID='a b' NODE_ADDR=10.0.0.11 CLUSTER_PEERS=10.0.0.12 $C
expect_fail "needs at least that many" "${G[@]:0:3}" CLUSTER_PEERS=10.0.0.12 GARAGE_REPLICATION_FACTOR=3 $C
expect_fail "ports must be numbers"    "${G[@]:0:3}" CLUSTER_PEERS=10.0.0.12:abc $C
expect_fail "empty entry"              "${G[@]:0:3}" CLUSTER_PEERS=10.0.0.12,,10.0.0.13 $C
expect_fail "needs DB_MODE=bundled"    "${G[@]}" NODE_ROLE=data DB_MODE=external DATABASE_URL=postgresql://u@h/db $C
expect_fail "needs S3_MODE=bundled"    "${G[@]}" NODE_ROLE=data S3_MODE=external S3_ENDPOINT=https://s3.example.org S3_ACCESS_KEY=a S3_SECRET_KEY=b $C
expect_fail "points somewhere else"    "${G[@]}" DATABASE_URL=postgresql://u:p@db.example.org:5432/x $C
expect_fail "must be 'single' or"      DEPLOY_MODE=both $C
expect_fail "must be 'full' or"        "${G[@]}" NODE_ROLE=half $C

echo "== resolved"
expect_out "CLUSTER_JOIN=10.0.0.11:26257,10.0.0.12:26257,10.0.0.13:26257" "${G[@]}" $C
expect_out "GARAGE_REPLICATION_FACTOR=3" "${G[@]}" $C
expect_out "GARAGE_REPLICATION_FACTOR=2" "${G[@]:0:3}" CLUSTER_PEERS=10.0.0.12 $C
expect_out "GARAGE_REPLICATION_FACTOR=1" $C
expect_out "PEERS=10.0.0.12:26257:3901 h2:26301:3911 " "${G[@]:0:3}" CLUSTER_PEERS=10.0.0.12,h2:26301:3911 $C
expect_out "CLUSTER_JOIN=10.0.0.11:26301,10.0.0.12:26301,h2:26302" "${G[@]:0:3}" CLUSTER_DB_PORT=26301 CLUSTER_PEERS=10.0.0.12,h2:26302:3912 $C
expect_out "NODE_ROLE=data" "${G[@]}" NODE_ROLE=data $C
expect_out "DEPLOY_MODE=single" $C
# A remote database and a remote object store need no node addresses at all.
expect_out "DEPLOY_MODE=cluster" DEPLOY_MODE=cluster NODE_ID=a DB_MODE=external DATABASE_URL=postgresql://u:p@db.example.org:5432/x S3_MODE=external S3_ENDPOINT=https://s3.example.org S3_ACCESS_KEY=a S3_SECRET_KEY=b $C

echo "== compose files"
expect_contains "--advertise-addr=10.0.0.11:26257" "${G[@]}" bash scripts/compose.sh --prod config
expect_contains "--join=10.0.0.11:26257,10.0.0.12:26257,10.0.0.13:26257" "${G[@]}" bash scripts/compose.sh --prod config
expect_contains "sslmode=verify-full&sslrootcert=/certs/ca.crt" "${G[@]}" bash scripts/compose.sh --prod config
expect_contains 'published: "3901"' "${G[@]}" bash scripts/compose.sh --prod config
expect_contains 'published: "3999"' "${G[@]}" CLUSTER_S3_API_PORT=3999 bash scripts/compose.sh --prod config
# The single-node file list does not mention the cluster database at all.
out="$("${CLEAN[@]}" bash scripts/compose.sh --prod config 2>&1)"
if grep -q -- "--certs-dir=/certs" <<<"$out"; then fail=$((fail + 1)); echo "  FAIL  single mode config contains the secure cockroach"; else pass=$((pass + 1)); echo "  ok    single mode config has no secure cockroach"; fi

echo; echo "compose-config: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
