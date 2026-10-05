#!/usr/bin/env bash
#
# Several cluster nodes on ONE host, to try shape C (bundled database and object store on every
# node) without several machines. Each simulated node is a copy of this repository in its own
# directory with its own .env, data/, Compose project and ports, exactly as a real node would
# have, so the real scripts (scripts/cluster.sh, scripts/compose.sh) are what gets exercised.
#
#   tests/cluster/sim.sh up [N]      create and start N nodes (default 3), form the clusters,
#                                    migrate and seed
#   tests/cluster/sim.sh nodeonly N  just the files for node N (no start)
#   tests/cluster/sim.sh add N       add node N (the next number) to the running cluster
#   tests/cluster/sim.sh sync        copy the current source over every node (a new release)
#   tests/cluster/sim.sh in N cmd..  run a command inside node N's directory with its project
#   tests/cluster/sim.sh down        stop and delete everything, including the data
#
# SIM_WITNESS=N makes node N a witness (NODE_ROLE=data: database and object store only).
# Environment: SIM_DIR (default ~/church-sim; must be local disk, not NFS: Garage's metadata is
# LMDB), SIM_HOST (the host's address, default its first IP). The first node's `up` builds the
# church-sim-* images from the repository; the other nodes reuse them from cache.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SIM_DIR="${SIM_DIR:-$HOME/church-sim}"
SIM_HOST="${SIM_HOST:-$(hostname -I | awk '{print $1}')}"

die() { echo "sim: $*" >&2; exit 1; }
node_dir() { echo "$SIM_DIR/node$1"; }

# Ports for node N: distinct per node because they share one host.
ext_port() { echo $((8200 + $1)); }
db_port() { echo $((26300 + $1)); }
rpc_port() { echo $((3910 + $1)); }

# The repository without its data, dependencies, build output and .env: a node starts from a clone.
copy_repo() {
  (cd "$REPO" && tar --exclude=./data --exclude=node_modules --exclude=.pnpm-store --exclude=.turbo \
      --exclude=./.git --exclude=.next --exclude=dist --exclude=./backups --exclude=./.env \
      --exclude=./.claude --exclude=tsconfig.tsbuildinfo -cf - .) | tar -xf - -C "$1"
}

write_node() {
  local n="$1" total="$2" d; d="$(node_dir "$n")"
  mkdir -p "$d"
  copy_repo "$d"
  local peers="" i
  for ((i = 1; i <= total; i++)); do
    [[ $i -eq $n ]] && continue
    peers+="${peers:+,}${SIM_HOST}:$(db_port "$i"):$(rpc_port "$i")"
  done
  {
    echo "# simulated node $n of $total"
    echo "AUTH_SECRET=$(cat "$SIM_DIR/auth_secret")"
    echo "MEILI_MASTER_KEY=$(cat "$SIM_DIR/meili_key")"
    echo "EXTERNAL_PORT=$(ext_port "$n")"
    echo "DEPLOY_MODE=cluster"
    echo "NODE_ID=sim-$n"
    echo "NODE_ADDR=$SIM_HOST"
    echo "CLUSTER_PEERS=$peers"
    echo "CLUSTER_DB_PORT=$(db_port "$n")"
    echo "CLUSTER_S3_RPC_PORT=$(rpc_port "$n")"
    echo "CLUSTER_S3_CAPACITY=10G"
    echo "COMPOSE_PROJECT_NAME=sim$n"
    [[ "${SIM_WITNESS:-}" == "$n" ]] && echo "NODE_ROLE=data"
    echo "GARAGE_META_DIR=$d/garage-meta"
    # Own image names, so the simulation never moves the tags of the dev stack's images.
    echo "API_IMAGE=church-sim-api"
    echo "WEB_IMAGE=church-sim-web"
    echo "MONITOR_IMAGE=church-sim-monitor"
  } >"$d/.env"
  (cd "$d" && make -s init-data && mkdir -p garage-meta)
  ensure_net "$n"
}

# Docker's default address pool can be exhausted on a busy host: give the node's network an
# explicit subnet, labelled so that Compose adopts it as its own. (`compose down` removes it.)
ensure_net() {
  local n="$1"
  docker network inspect "sim${n}_internal" >/dev/null 2>&1 || docker network create \
    --subnet "10.99.$((100 + n)).0/24" --label "com.docker.compose.project=sim$n" \
    --label com.docker.compose.network=internal "sim${n}_internal" >/dev/null
}

in_node() {
  local n="$1"; shift
  ensure_net "$n"
  # COMPOSE_PROJECT_NAME comes from the node's .env, which compose.sh passes via --env-file but
  # the shell does not see: export it so every compose call of this node uses its own project.
  (cd "$(node_dir "$n")" && COMPOSE_PROJECT_NAME="sim$n" "$@")
}

case "${1:-}" in
  nodeonly)
    n="${2:?node number}"; total="${3:-3}"
    mkdir -p "$SIM_DIR"
    [[ -f "$SIM_DIR/auth_secret" ]] || openssl rand -hex 32 >"$SIM_DIR/auth_secret"
    [[ -f "$SIM_DIR/meili_key" ]] || openssl rand -hex 16 >"$SIM_DIR/meili_key"
    write_node "$n" "$total"
    ;;
  add)
    # A further node joins the running cluster (INSTALL.md, "Adding a node"): its files, the
    # certificate bundle (the simulated nodes share one address, hence one bundle), the data
    # services, the object store layout, then the application.
    n="${2:?node number of the new node}"
    [[ -d "$(node_dir $((n - 1)))" ]] || die "node $((n - 1)) does not exist: add nodes in order"
    write_node "$n" "$n"
    for ((i = 1; i < n; i++)); do   # the others learn of it for their next restart
      sed -i "s|^CLUSTER_PEERS=.*|&,${SIM_HOST}:$(db_port "$n"):$(rpc_port "$n")|" "$(node_dir "$i")/.env"
    done
    in_node "$n" bash scripts/cluster.sh install-certs "$(node_dir 1)/data/cluster-certs/${SIM_HOST//[:\/]/_}"
    in_node "$n" bash scripts/cluster.sh start-data
    in_node "$n" bash scripts/cluster.sh garage-join "$(in_node 1 bash scripts/cluster.sh node-id | tail -n 1)"
    in_node "$n" bash scripts/cluster.sh up
    ;;
  sync)
    # Copy the current source over every node (their .env and data stay): what a new release is.
    # Then `tests/cluster/sim.sh in N bash scripts/cluster.sh up` rebuilds and restarts a node.
    for d in "$SIM_DIR"/node*; do [[ -d "$d" ]] && copy_repo "$d"; done
    echo "sim: source copied to every node"
    ;;
  in)
    n="${2:?node number}"; shift 2
    in_node "$n" "$@"
    ;;
  up)
    total="${2:-3}"
    [[ ! -d "$SIM_DIR/node1" ]] || die "$SIM_DIR already has nodes: run 'tests/cluster/sim.sh down' first."
    mkdir -p "$SIM_DIR"
    openssl rand -hex 32 >"$SIM_DIR/auth_secret"
    openssl rand -hex 16 >"$SIM_DIR/meili_key"
    for ((n = 1; n <= total; n++)); do write_node "$n" "$total"; done

    echo "== certificates (made on node 1, as on a real machine you would keep the CA off the nodes)"
    addrs=("$SIM_HOST")   # every node shares the host address here
    in_node 1 bash scripts/cluster.sh init-certs "${addrs[@]}"
    bundle="$(node_dir 1)/data/cluster-certs/${SIM_HOST//[:\/]/_}"
    for ((n = 1; n <= total; n++)); do in_node "$n" bash scripts/cluster.sh install-certs "$bundle"; done

    echo "== database and object store on every node"
    for ((n = 1; n <= total; n++)); do in_node "$n" bash scripts/cluster.sh start-data; done
    in_node 1 bash scripts/cluster.sh init-db

    echo "== object store layout"
    ids=()
    for ((n = 2; n <= total; n++)); do ids+=("$(in_node "$n" bash scripts/cluster.sh node-id)"); done
    in_node 1 bash scripts/cluster.sh garage-bootstrap "${ids[@]}"

    echo "== migrate and seed (once, before the application starts)"
    in_node 1 bash scripts/cluster.sh migrate
    in_node 1 bash scripts/cluster.sh seed

    echo "== application on every node"
    for ((n = 1; n <= total; n++)); do in_node "$n" bash scripts/cluster.sh up; done
    echo "sim: ready. Node N is http://$SIM_HOST:$(ext_port 1) ... (ports 8201, 8202, ...)"
    ;;
  down)
    for d in "$SIM_DIR"/node*; do
      [[ -d "$d" ]] || continue
      n="${d##*node}"
      (cd "$d" && COMPOSE_PROJECT_NAME="sim$n" bash scripts/compose.sh --prod down -v --remove-orphans 2>&1 | tail -n 3) || true
    done
    # Files written by containers are root-owned: delete through a container.
    if [[ -d "$SIM_DIR" ]]; then
      docker run --rm -v "$SIM_DIR:/sim" alpine:3.20 sh -c 'rm -rf /sim/* /sim/.[!.]* 2>/dev/null; true'
      rmdir "$SIM_DIR" 2>/dev/null || true
    fi
    echo "sim: removed"
    ;;
  *)
    sed -n '3,21p' "$0"
    exit 2
    ;;
esac
