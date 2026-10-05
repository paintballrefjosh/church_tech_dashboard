#!/usr/bin/env bash
#
# Failure and recovery on the simulated cluster (tests/cluster/sim.sh up, 3 nodes):
#
#   A. Stop node 1, the node holding every background job: nodes 2 and 3 keep serving reads,
#      writes and uploads, the jobs move to them within the lease window, and an upload stored
#      beforehand still downloads. Start node 1 again and it rejoins both clusters.
#   A2. Kill whichever node now holds the jobs, with no clean shutdown (its leases must expire
#      first): the jobs move to a survivor, and the node rejoins when started again.
#   B. Stop nodes 2 and 3 (no database majority): writes are refused rather than lost. Start them
#      again: everything recovers and the stored upload is intact.
#
# Needs the regression test user (scripts/reset-test-user + the smoke suite, or TEST_PASSWORD).
set -uo pipefail
cd "$(dirname "$0")/../.."
SIM="tests/cluster/sim.sh"
SIM_DIR="${SIM_DIR:-$HOME/church-sim}"
HOST="${SIM_HOST:-$(hostname -I | awk '{print $1}')}"
url() { echo "http://$HOST:$((8200 + $1))"; }
fails=0
ok() { echo "  ok    $*"; }
bad() { echo "  FAIL  $*"; fails=$((fails + 1)); }

# Run the cross-node test in Node (the host has none).
xnode() {
  local mode="$1"; shift
  local nodes=""; for n in "$@"; do nodes+="${nodes:+,}$(url "$n")"; done
  docker run --rm --network=host -v "$PWD":/w -v "$SIM_DIR":/sim -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp \
    -e NODES="$nodes" -e MODE="$mode" -e STATE_FILE=/sim/state.json node:20-alpine node tests/cluster/cross-node.mjs
}
sql() { # <node> <statement> -> one value
  (cd "$SIM_DIR/node$1" && COMPOSE_PROJECT_NAME="sim$1" bash scripts/cluster.sh sql --database=church --format=csv -e "$2" 2>/dev/null | tail -n 1)
}
wait_until() { # <seconds> <description> <command...>
  local secs="$1" what="$2"; shift 2
  local i=0
  until "$@" >/dev/null 2>&1; do i=$((i + 1)); if [[ $i -gt $secs ]]; then bad "$what (waited ${secs}s)"; return 1; fi; sleep 1; done
  ok "$what (${i}s)"
}
healthy() { [[ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$(url "$1")/healthz")" == 200 ]]; }
kill_node() { (cd "$SIM_DIR/node$1" && COMPOSE_PROJECT_NAME="sim$1" bash scripts/compose.sh --prod kill >/dev/null 2>&1); }
stop_node() { (cd "$SIM_DIR/node$1" && COMPOSE_PROJECT_NAME="sim$1" bash scripts/compose.sh --prod stop >/dev/null 2>&1); }
start_node() { (cd "$SIM_DIR/node$1" && COMPOSE_PROJECT_NAME="sim$1" bash scripts/cluster.sh start-data >/dev/null 2>&1 && COMPOSE_PROJECT_NAME="sim$1" bash scripts/cluster.sh up >/dev/null 2>&1); }
held_by() { # <holder node id> <node to ask>: unexpired job leases held by that node
  sql "$2" "SELECT count(*) FROM cluster_leases WHERE name LIKE 'job:%' AND expires_at > now() AND holder LIKE '$1/%'"; }

echo "== seed: a note with a 6 MB upload, kept for the checks below"
xnode seed 1 2 3 | tail -n 3 || exit 1
total_jobs="$(sql 1 "SELECT count(*) FROM cluster_leases WHERE name LIKE 'job:%'")"
echo "   $total_jobs job leases; node 1 holds $(held_by sim-1 1)"

echo "== A. node 1 stops"
stop_node 1
jobs_left_node1() { [[ "$(held_by sim-1 2)" == 0 ]]; }
wait_until 90 "the jobs move off node 1" jobs_left_node1
[[ "$(( $(held_by sim-2 2) + $(held_by sim-3 2) ))" -ge "$total_jobs" ]] && ok "nodes 2 and 3 hold all $total_jobs jobs" || bad "jobs not all re-held ($(held_by sim-2 2) + $(held_by sim-3 2) of $total_jobs)"
xnode verify 2 3 | tail -n 9 | sed 's/^/   /'; [[ ${PIPESTATUS[0]} -eq 0 ]] && ok "nodes 2 and 3 serve reads, writes and uploads" || bad "nodes 2 and 3 with node 1 down"
echo "   node 1 returns"
start_node 1
wait_until 180 "node 1 answers /healthz again" healthy 1
(cd "$SIM_DIR/node1" && COMPOSE_PROJECT_NAME=sim1 bash scripts/cluster.sh status 2>&1 | grep -v '^#' | sed 's/^/   /')
xnode verify 1 2 3 | tail -n 2 | sed 's/^/   /'; [[ ${PIPESTATUS[0]} -eq 0 ]] && ok "all three nodes serve the stored upload and accept writes" || bad "after node 1 returned"

echo "== A2. the node holding the jobs is killed"
holder="$(sql 2 "SELECT holder FROM cluster_leases WHERE name LIKE 'job:%' GROUP BY holder ORDER BY count(*) DESC LIMIT 1")"
victim="${holder#sim-}"; victim="${victim%%/*}"
survivors=(); for n in 1 2 3; do [[ $n -ne $victim ]] && survivors+=("$n"); done
echo "   the jobs are on node $victim ($holder); killing it. Survivors: ${survivors[*]}"
kill_node "$victim"
t0=$SECONDS
victim_jobs_gone() { [[ "$(held_by "sim-$victim" "${survivors[0]}")" == 0 ]]; }
wait_until 90 "the leases of the killed node expire" victim_jobs_gone
echo "   (took $((SECONDS - t0))s from the kill)"
[[ "$(( $(held_by "sim-${survivors[0]}" "${survivors[0]}") + $(held_by "sim-${survivors[1]}" "${survivors[0]}") ))" -ge "$total_jobs" ]] \
  && ok "the survivors hold all $total_jobs jobs" || bad "jobs not all re-held after the kill"
xnode verify "${survivors[@]}" | tail -n 2 | sed 's/^/   /'; [[ ${PIPESTATUS[0]} -eq 0 ]] && ok "the survivors serve the stored upload and accept writes" || bad "survivors after the kill"
start_node "$victim"
wait_until 180 "the killed node answers /healthz again" healthy "$victim"
xnode verify 1 2 3 | tail -n 2 | sed 's/^/   /'; [[ ${PIPESTATUS[0]} -eq 0 ]] && ok "all three nodes healthy again" || bad "after the killed node returned"

echo "== B. nodes 2 and 3 stop (database majority lost)"
stop_node 2; stop_node 3
sleep 15
code="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$(url 1)/api/v1/readyz")"
[[ "$code" != 200 ]] && ok "node 1 reports itself not ready without a majority (readyz $code)" || bad "node 1 still claims ready with 1 of 3 databases"
echo "   nodes 2 and 3 return"
start_node 2; start_node 3
all_healthy() { healthy 1 && healthy 2 && healthy 3; }
wait_until 240 "all three nodes healthy" all_healthy
xnode verify 1 2 3 | tail -n 2 | sed 's/^/   /'; [[ ${PIPESTATUS[0]} -eq 0 ]] && ok "recovered: stored upload intact, writes accepted on every node" || bad "after the majority came back"

echo
[[ $fails -eq 0 ]] && echo "failover: all checks passed" || { echo "failover: $fails check(s) failed"; exit 1; }
