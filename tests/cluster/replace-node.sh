#!/usr/bin/env bash
#
# Replace a node that lost its disks, on the simulated cluster (tests/cluster/sim.sh up, 3 nodes):
# the procedure in INSTALL.md ("Replacing a lost node"), end to end.
#
#   tests/cluster/replace-node.sh [N]     N = the node that "loses its disks" (default 3)
#
# The disks are lost by moving the node's data directories aside (a node that comes back with
# empty ones is exactly what a rebuilt machine looks like). Afterwards the stored upload made
# before the loss must still download through every node, and every node must accept writes.
set -uo pipefail
cd "$(dirname "$0")/../.."
SIM="tests/cluster/sim.sh"
SIM_DIR="${SIM_DIR:-$HOME/church-sim}"
HOST="${SIM_HOST:-$(hostname -I | awk '{print $1}')}"
N="${1:-3}"
others=(); for n in 1 2 3; do [[ $n -ne $N ]] && others+=("$n"); done
A="${others[0]}"
fails=0
ok() { echo "  ok    $*"; }
bad() { echo "  FAIL  $*"; fails=$((fails + 1)); }
step() { echo "== $*"; }
node() { local n="$1"; shift; $SIM in "$n" "$@"; }
url() { echo "http://$HOST:$((8200 + $1))"; }
xnode() {
  local mode="$1"; shift
  local nodes=""; for n in "$@"; do nodes+="${nodes:+,}$(url "$n")"; done
  docker run --rm --network=host -v "$PWD":/w -v "$SIM_DIR":/sim -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp \
    -e NODES="$nodes" -e MODE="$mode" -e STATE_FILE=/sim/state.json node:20-alpine node tests/cluster/cross-node.mjs
}

step "seed: a note with a 6 MB upload, kept for the checks below"
xnode seed 1 2 3 | tail -n 1

step "node $N loses its disks"
node "$N" bash scripts/compose.sh --prod down >/dev/null 2>&1
stamp="$(date +%s)"
d="$SIM_DIR/node$N"
mv "$d/data/cockroach" "$d/data/cockroach.lost$stamp" && mv "$d/data/garage/data" "$d/data/garage/data.lost$stamp" \
  && mv "$d/garage-meta" "$d/garage-meta.lost$stamp" && mv "$d/data/meili" "$d/data/meili.lost$stamp" \
  && mkdir -p "$d/data/cockroach" "$d/data/garage/data" "$d/garage-meta" && mkdir -m 0777 "$d/data/meili" || { bad "could not move the data directories"; exit 1; }
ok "its data directories are empty"

step "the new machine starts its database and object store (certificates and .env are the same)"
node "$N" bash scripts/cluster.sh start-data >/dev/null 2>&1 && ok "started" || bad "start-data failed"
sleep 15

step "database: remove the lost member"
dead="$(node "$A" bash scripts/cluster.sh status 2>/dev/null | awk '/^  [0-9]+ / && $5 == "false" {print $1}' | head -n 1)"
if [[ -z "$dead" ]]; then bad "no dead database member shown by status"; else
  echo "   lost member: $dead (decommissioning waits until the cluster declares it dead, 5 minutes by default)"
  node "$A" bash scripts/cluster.sh db-remove-node "$dead" 2>&1 | tail -n 3 | sed 's/^/   /'
  ok "member $dead decommissioned"
fi

step "object store: join the new node, taking the lost one's place"
old="$(node "$A" bash scripts/cluster.sh status 2>/dev/null | awk '/FAILED NODES/ {f=1; next} f && length($1) == 16 && $1 ~ /^[0-9a-f]+$/ {print $1; exit}')"
peer="$(node "$A" bash scripts/cluster.sh node-id 2>/dev/null | tail -n 1)"
if [[ -z "$old" ]]; then bad "no failed object store node shown by status"; else
  node "$N" bash scripts/cluster.sh garage-join "$peer" --replace "$old" 2>&1 | grep -v '^#' | sed 's/^/   /'
fi
sleep 20
hist="$(node "$A" bash scripts/compose.sh --prod exec -T garage garage -c /tmp/garage.toml layout history 2>&1)"
grep -q "stable state with a single live layout version" <<<"$hist" && ok "object store layout is stable (single live version)" || { bad "object store layout is still migrating"; echo "$hist" | sed 's/^/   /'; }

step "node $N's application"
node "$N" bash scripts/cluster.sh up >/dev/null 2>&1
for i in $(seq 1 90); do [[ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$(url "$N")/healthz")" == 200 ]] && break; sleep 2; done
xnode verify 1 2 3 | tail -n 2 | sed 's/^/   /'; [[ ${PIPESTATUS[0]} -eq 0 ]] && ok "stored upload intact and writes accepted on every node" || bad "after the replacement"
node "$A" bash scripts/cluster.sh status 2>&1 | grep -v '^#' | sed 's/^/   /'

echo
[[ $fails -eq 0 ]] && echo "replace-node: all checks passed" || { echo "replace-node: $fails check(s) failed"; exit 1; }
