#!/usr/bin/env bash
#
# Two application nodes plus a witness (NODE_ROLE=data) survive the loss of either application
# node. Run on a simulation made with:   SIM_WITNESS=3 tests/cluster/sim.sh up 3
#
# For each of nodes 1 and 2 in turn: stop it entirely, check that the other one (with the witness
# making up the majority) still serves reads, writes and uploads, including an upload stored
# before, then start it again and check both.
set -uo pipefail
cd "$(dirname "$0")/../.."
SIM_DIR="${SIM_DIR:-$HOME/church-sim}"
HOST="${SIM_HOST:-$(hostname -I | awk '{print $1}')}"
url() { echo "http://$HOST:$((8200 + $1))"; }
fails=0
ok() { echo "  ok    $*"; }
bad() { echo "  FAIL  $*"; fails=$((fails + 1)); }
xnode() {
  local mode="$1"; shift
  local nodes=""; for n in "$@"; do nodes+="${nodes:+,}$(url "$n")"; done
  docker run --rm --network=host -v "$PWD":/w -v "$SIM_DIR":/sim -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp \
    -e NODES="$nodes" -e MODE="$mode" -e STATE_FILE=/sim/state.json node:20-alpine node tests/cluster/cross-node.mjs
}
healthy() { [[ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$(url "$1")/healthz")" == 200 ]]; }
in_node() { local n="$1"; shift; (cd "$SIM_DIR/node$n" && COMPOSE_PROJECT_NAME="sim$n" "$@"); }

echo "== the witness runs no application"
[[ -z "$(docker ps --format '{{.Names}}' | grep -E '^sim3-(api|web|proxy)')" ]] && ok "node 3 has no api, web or proxy" || bad "node 3 runs application containers"
docker ps --format '{{.Names}}' | grep -qE '^sim3-cockroach' && docker ps --format '{{.Names}}' | grep -qE '^sim3-garage' && ok "node 3 runs the database and object store" || bad "node 3 is missing its database or object store"

echo "== seed: a note with a 6 MB upload"
xnode seed 1 2 | tail -n 1

for victim in 1 2; do
  survivor=$((3 - victim))
  echo "== node $victim stops; node $survivor and the witness remain"
  in_node "$victim" bash scripts/compose.sh --prod stop >/dev/null 2>&1
  sleep 5
  xnode verify "$survivor" | tail -n 3 | sed 's/^/   /'; [[ ${PIPESTATUS[0]} -eq 0 ]] \
    && ok "node $survivor serves the stored upload and accepts writes" || bad "node $survivor with node $victim down"
  in_node "$victim" bash scripts/cluster.sh start-data >/dev/null 2>&1
  in_node "$victim" bash scripts/cluster.sh up >/dev/null 2>&1
  for i in $(seq 1 90); do healthy "$victim" && break; sleep 2; done
  xnode verify 1 2 | tail -n 2 | sed 's/^/   /'; [[ ${PIPESTATUS[0]} -eq 0 ]] && ok "both nodes serve after node $victim returned" || bad "after node $victim returned"
done

echo
[[ $fails -eq 0 ]] && echo "witness: all checks passed" || { echo "witness: $fails check(s) failed"; exit 1; }
