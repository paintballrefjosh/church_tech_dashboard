#!/usr/bin/env bash
#
# Does the app's database pool survive database nodes failing, with several hosts listed in DATABASE_URL
# and nothing in between? Builds a throwaway 3-node YugabyteDB cluster (yb1..yb3 on the docker network
# `ybnet`), runs steady traffic through createPool (tests/db/yb-load.mjs, 4 workers) and, underneath it,
# makes each node fail in turn, including the FIRST host of the URL:
#   blackhole  the host hangs or loses power: open connections go silent, new ones are never answered
#   refuse     the host is down: open connections are reset, new ones are refused
#   stop       a real node stopped (docker stop)
# The faults are injected by tests/db/tcp-fault-proxy.mjs, one listener per node, which the URL names
# instead of the nodes (YugabyteDB itself does not survive its container being frozen or its network cut,
# which would test the container, not the pool). A process that STARTS while the first host is hung must
# also connect.
#
#   tests/db/yb-failover.sh            run everything, then remove the cluster
#   KEEP=1 tests/db/yb-failover.sh     leave the cluster running afterwards
#   KEEP_LOG=1                         keep .yb-load.log (the per-second traffic) in the repository root
#
# Needs docker and the image yugabytedb/yugabyte:2024.2.3.0-b116. Never touches the dev stack.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IMG=yugabytedb/yugabyte:2024.2.3.0-b116
NET=ybnet; SUBNET=10.97.1.0/24
HOSTS=(10.97.1.11 10.97.1.12 10.97.1.13)
PROXY=10.97.1.50
PORTS=(5441 5442 5443)            # the proxy's listener for yb1, yb2, yb3
URL_ALL="postgresql://yugabyte:yugabyte@${PROXY}:${PORTS[0]},${PROXY}:${PORTS[1]},${PROXY}:${PORTS[2]}/church?sslmode=disable"
URL_FIRST_ONLY="postgresql://yugabyte:yugabyte@${PROXY}:${PORTS[0]}/church?sslmode=disable"
pass=0; failn=0
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "  ok    $what"; else failn=$((failn + 1)); echo "  FAIL  $what"; fi; }
node_run() { docker run --rm --net "$NET" -v "$REPO":/w -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp "$@"; }
ysql() { timeout 20 docker exec "$1" bin/ysqlsh -h "${2}" -Atc "$3" 2>/dev/null; }
cleanup() { [[ -n "${KEEP:-}" ]] || { docker rm -f yb1 yb2 yb3 ybload ybproxy >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }; }
trap cleanup EXIT

# fault N MODE: node N (1-3) behaves as MODE (pass | blackhole | refuse)
fault() { docker exec ybproxy wget -qO- "http://127.0.0.1:5450/mode?port=${PORTS[$(($1 - 1))]}&mode=$2" >/dev/null; }

echo "== a 3-node YugabyteDB cluster"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" "$NET" >/dev/null
docker rm -f yb1 yb2 yb3 ybload ybproxy >/dev/null 2>&1
docker run -d --name yb1 --net "$NET" --ip "${HOSTS[0]}" "$IMG" bin/yugabyted start --advertise_address="${HOSTS[0]}" --background=false >/dev/null
until ysql yb1 "${HOSTS[0]}" 'select 1' >/dev/null; do sleep 2; done
for i in 2 3; do
  docker run -d --name "yb$i" --net "$NET" --ip "${HOSTS[$((i - 1))]}" "$IMG" bin/yugabyted start --advertise_address="${HOSTS[$((i - 1))]}" --join="${HOSTS[0]}" --background=false >/dev/null
done
until [[ "$(ysql yb1 "${HOSTS[0]}" 'select count(*) from yb_servers()')" == 3 ]]; do sleep 2; done
ysql yb1 "${HOSTS[0]}" 'CREATE DATABASE church' >/dev/null
check "three nodes in the cluster" test "$(ysql yb1 "${HOSTS[0]}" 'select count(*) from yb_servers()')" = 3
sleep 30
docker run -d --name ybproxy --net "$NET" --ip "$PROXY" -v "$REPO/tests/db":/p -w /p node:20-alpine node tcp-fault-proxy.mjs 5450 \
  "${PORTS[0]}=${HOSTS[0]}:5433" "${PORTS[1]}=${HOSTS[1]}:5433" "${PORTS[2]}=${HOSTS[2]}:5433" >/dev/null
until docker logs ybproxy 2>&1 | grep -q "proxy ready"; do sleep 1; done

echo "== steady traffic (4 workers), one node failing at a time"
docker run -d --name ybload --net "$NET" -v "$REPO":/w -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e DATABASE_URL="$URL_ALL" -e SECONDS=900 -e DB_QUERY_TIMEOUT_MS=15000 -e POOL_NAME=load node:20-alpine node tests/db/yb-load.mjs >/dev/null
sleep 15
echo "   yb2 hangs (blackhole), 30 s";  fault 2 blackhole; sleep 30; fault 2 pass; echo "   yb2 answers again"; sleep 25
echo "   yb1, the FIRST host of the URL, hangs (blackhole)"; fault 1 blackhole; sleep 6

echo "== a process that STARTS while the first host hangs"
r=$(node_run -e DATABASE_URL="$URL_ALL" node:20-alpine node tests/db/yb-connect.mjs 2>&1 | tail -1)
echo "   hosts listed, first one hung: $r"
check "starts from another host of the list" bash -c "[[ '$r' == OK* ]]"
r1=$(timeout 150 docker run --rm --net "$NET" -v "$REPO":/w -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp -e DATABASE_URL="$URL_FIRST_ONLY" node:20-alpine node tests/db/yb-connect.mjs 2>&1 | tail -1)
echo "   only the hung first host listed (for the record): $r1"
check "listing only the hung host cannot start (so list them all)" bash -c "[[ '$r1' == FAIL* ]]"
sleep 10; fault 1 pass; echo "   yb1 answers again"; sleep 25
echo "   yb3 goes down (refuse: connections reset, new ones refused), 30 s"; fault 3 refuse; sleep 30; fault 3 pass; echo "   yb3 answers again"; sleep 25
echo "   yb3 really stopped (docker stop)"; docker stop yb3 >/dev/null; sleep 40

echo "== stop the traffic"
docker kill -s TERM ybload >/dev/null
docker wait ybload >/dev/null
docker logs ybload >"$REPO/.yb-load.log" 2>&1
tail -n 1 "$REPO/.yb-load.log"

echo "   stretches with no successful request:"
awk '/^t=/ { split($2, a, "="); if (a[2] == 0) { if (!z) start = $1; z++ } else { if (z) printf "     %ds ending at %s\n", z, $1; z = 0 } } END { if (z) printf "     %ds at the end\n", z }' "$REPO/.yb-load.log"
longest=$(awk '/^t=/ { split($2, a, "="); if (a[2] == 0) { run++; if (run > best) best = run } else run = 0 } END { print best + 0 }' "$REPO/.yb-load.log")
fails=$(grep -c 'fail=[1-9]' "$REPO/.yb-load.log")
echo "   seconds with a failed request: $fails"
check "traffic resumed after every failure (longest stretch ${longest}s, limit 40 s)" test "$longest" -lt 40
check "no acknowledged write was lost" grep -q 'missing=0' "$REPO/.yb-load.log"
check "the load process finished normally" grep -q '^RESULT' "$REPO/.yb-load.log"
check "all three nodes served requests" bash -c "[ \$(grep '^RESULT' '$REPO/.yb-load.log' | grep -o '10\.97\.1\.1[123]' | sort -u | wc -l) = 3 ]"
# A node that came back is used again as connections turn over (they live at most 30 minutes, and a new
# one goes to the host with the fewest): yb1 and yb2 were hung and came back, then served again.
check "a node that came back was used again" bash -c "awk '/^t=/ && /10.97.1.12:/' '$REPO/.yb-load.log' | tail -n 80 | grep -q ."

[[ -n "${KEEP_LOG:-}" ]] || rm -f "$REPO/.yb-load.log"
echo
echo "yb failover: $pass passed, $failn failed"
[[ $failn -eq 0 ]]
