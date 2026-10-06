#!/usr/bin/env bash
#
# Runs ./install.sh for real, in throwaway copies of the repository (own .env, data/, Compose
# project, ports and image names, like tests/cluster/sim.sh), so the live dev stack is never touched.
#
#   tests/installer/e2e.sh single     shape A, standard stack: one server, everything bundled, then
#                                     the smoke suite against it
#   tests/installer/e2e.sh external   shape B, production stack: the database is a throwaway CockroachDB
#                                     container published on the host's address (like a real external
#                                     one); includes the wizard's connection test; then the smoke suite
#   tests/installer/e2e.sh cluster    shape C: three nodes on this host, driven the way three people
#                                     would (first node, then --join on the others), then
#                                     tests/cluster/cross-node.mjs against all three
#   tests/installer/e2e.sh down       remove everything
#
# Environment: WIZ_DIR (default ~/church-wiz; local disk, not NFS), WIZ_HOST (this host's address).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WIZ_DIR="${WIZ_DIR:-$HOME/church-wiz}"
WIZ_HOST="${WIZ_HOST:-$(hostname -I | awk '{print $1}')}"

die() { echo "e2e: $*" >&2; exit 1; }
ndir() { echo "$WIZ_DIR/node$1"; }
ext_port() { echo $((8290 + $1)); }
db_port() { echo $((26390 + $1)); }
rpc_port() { echo $((3950 + $1)); }

copy_repo() {
  mkdir -p "$1"
  (cd "$REPO" && tar --exclude=./data --exclude=node_modules --exclude=.pnpm-store --exclude=.turbo \
      --exclude=./.git --exclude=.next --exclude=dist --exclude=./backups --exclude=./.env \
      --exclude=./.claude --exclude=tsconfig.tsbuildinfo --exclude='./.install*' --exclude='./.env.bak*' -cf - .) | tar -xf - -C "$1"
}

# Docker's default address pool can be exhausted on a busy host: give the node's network an explicit subnet.
ensure_net() {
  local proj=$1 octet=$2
  docker network inspect "${proj}_internal" >/dev/null 2>&1 || docker network create \
    --subnet "10.98.$octet.0/24" --label "com.docker.compose.project=$proj" \
    --label com.docker.compose.network=internal "${proj}_internal" >/dev/null
}

# Answers every node shares: its own project, images and local object-store metadata.
node_answers() { # n
  local n=$1 d; d="$(ndir "$n")"
  cat <<EOF
ENV_COMPOSE_PROJECT_NAME=wiz$n
ENV_API_IMAGE=church-wiz-api
ENV_WEB_IMAGE=church-wiz-web
ENV_MONITOR_IMAGE=church-wiz-monitor
ENV_GARAGE_IMAGE=church-wiz-garage
GARAGE_META_DIR=$d/garage-meta
EXTERNAL_PORT=$(ext_port "$n")
REUSE_SECRET=no
CONFIRM=yes
NOWAIT=yes
EOF
}

case "${1:-}" in
  single)
    d="$(ndir 1)"; rm -rf "$d"; copy_repo "$d"; mkdir -p "$d/garage-meta"
    ensure_net wiz1 101
    {
      node_answers 1
      echo SETUP=single; echo DB_MODE=bundled; echo S3_MODE=bundled; echo BEHIND_LB=no; echo STACK=standard
      echo ENV_COCKROACH_UI_PORT=8191
    } >"$d/answers"
    (cd "$d" && NO_COLOR=1 ./install.sh --answers answers)
    echo "e2e: single node installed in $d (http://localhost:$(ext_port 1)); running the smoke suite"
    (cd "$d" && COMPOSE_PROJECT_NAME=wiz1 bash scripts/compose.sh exec -T api node dist/scripts/reset-test-user.js >/dev/null)
    (cd "$d" && docker run --rm --network=host -v "$PWD":/w -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp \
      -e BASE="http://localhost:$(ext_port 1)" node:20-alpine node tests/smoke/run.mjs | tail -n 3)
    ;;

  external)
    d="$(ndir 1)"; rm -rf "$d"; copy_repo "$d"; mkdir -p "$d/garage-meta"
    ensure_net wiz1 101
    docker rm -f wizdb >/dev/null 2>&1 || true
    docker run -d --name wizdb -p 26599:26257 cockroachdb/cockroach:v24.2.0 start-single-node --insecure >/dev/null
    until docker exec wizdb cockroach sql --insecure -e 'select 1' >/dev/null 2>&1; do sleep 1; done
    docker exec wizdb cockroach sql --insecure -e 'CREATE DATABASE church' >/dev/null
    {
      node_answers 1
      echo SETUP=single; echo DB_MODE=external; echo DB_INPUT=parts; echo DB_ENGINE=cockroach
      echo "DB_HOST=$WIZ_HOST"; echo DB_PORT=26599; echo DB_NAME=church; echo DB_USER=root; echo DB_PASSWORD=unused
      echo DB_SSL=disable; echo DB_TEST=yes; echo S3_MODE=bundled; echo BEHIND_LB=no; echo STACK=production
    } >"$d/answers"
    (cd "$d" && NO_COLOR=1 ./install.sh --answers answers)
    echo "e2e: installed against an external database; running the smoke suite"
    (cd "$d" && COMPOSE_PROJECT_NAME=wiz1 bash scripts/compose.sh --prod exec -T api node dist/scripts/reset-test-user.js >/dev/null)
    (cd "$d" && docker run --rm --network=host -v "$PWD":/w -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp \
      -e BASE="http://localhost:$(ext_port 1)" node:20-alpine node tests/smoke/run.mjs | tail -n 3)
    ;;

  cluster)
    for n in 1 2 3; do d="$(ndir "$n")"; rm -rf "$d"; copy_repo "$d"; mkdir -p "$d/garage-meta"; ensure_net "wiz$n" $((100 + n)); done
    # Node 1: everything up to the point where it needs the others (the wizard's own steps, in order).
    {
      node_answers 1
      echo SETUP=cluster; echo CLUSTER_ROLE=first; echo DB_MODE=bundled; echo S3_MODE=bundled; echo TRUSTED_PROXIES=
      echo NODES=3; echo CLUSTER_S3_CAPACITY=10G
      for i in 1 2 3; do echo "NODE_${i}_ID=wiz-$i"; echo "NODE_${i}_ADDR=$WIZ_HOST:$(db_port "$i"):$(rpc_port "$i")"; done
    } >"$(ndir 1)/answers"
    (cd "$(ndir 1)" && INSTALL_STOP_AFTER=packages NO_COLOR=1 ./install.sh --answers answers)
    # Nodes 2 and 3: they join with their packages and stop once their data services run.
    for n in 2 3; do
      cp "$(ndir 1)/data/cluster-packages/church-node-wiz-$n.tar.gz" "$(ndir "$n")/"
      node_answers "$n" >"$(ndir "$n")/answers"
      (cd "$(ndir "$n")" && INSTALL_STOP_AFTER=node-id NO_COLOR=1 ./install.sh --join "church-node-wiz-$n.tar.gz" --answers answers)
    done
    # Node 1 carries on: the other nodes' object store ids go in as answers.
    {
      echo "PEERID_2=$(cat "$(ndir 2)/data/node-id.txt")"
      echo "PEERID_3=$(cat "$(ndir 3)/data/node-id.txt")"
    } >>"$(ndir 1)/answers"
    (cd "$(ndir 1)" && NO_COLOR=1 ./install.sh --answers answers)
    # Nodes 2 and 3 carry on once the first says the cluster is ready.
    for n in 2 3; do
      (cd "$(ndir "$n")" && NO_COLOR=1 ./install.sh --join "church-node-wiz-$n.tar.gz" --answers answers)
    done
    echo "e2e: three nodes installed under $WIZ_DIR; running the cross-node checks"
    (cd "$(ndir 1)" && COMPOSE_PROJECT_NAME=wiz1 bash scripts/compose.sh --prod exec -T api node dist/scripts/reset-test-user.js >/dev/null)
    nodes="http://$WIZ_HOST:$(ext_port 1),http://$WIZ_HOST:$(ext_port 2),http://$WIZ_HOST:$(ext_port 3)"
    (cd "$(ndir 1)" && docker run --rm --network=host -v "$PWD":/w -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp \
      -e NODES="$nodes" node:20-alpine node tests/cluster/cross-node.mjs | tail -n 8)
    ;;

  down)
    docker rm -f wizdb >/dev/null 2>&1 || true
    for n in 1 2 3; do
      d="$(ndir "$n")"
      if [[ -d $d ]]; then
        (cd "$d" && COMPOSE_PROJECT_NAME="wiz$n" bash scripts/compose.sh --prod down -v >/dev/null 2>&1 || true)
        (cd "$d" && COMPOSE_PROJECT_NAME="wiz$n" bash scripts/compose.sh down -v >/dev/null 2>&1 || true)
      fi
      docker network rm "wiz${n}_internal" >/dev/null 2>&1 || true
    done
    # data/ holds root-owned files from the database containers: remove them through docker.
    if [[ -d $WIZ_DIR ]]; then
      docker run --rm -v "$WIZ_DIR:/w" alpine sh -c 'rm -rf /w/node*' >/dev/null 2>&1 || true
      rmdir "$WIZ_DIR" 2>/dev/null || true
    fi
    echo "e2e: removed"
    ;;

  *)
    sed -n '3,14p' "$0"; exit 2 ;;
esac
