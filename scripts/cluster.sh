#!/usr/bin/env bash
#
# Setting up and operating one node of a multi-node deployment (docs/multi-node.md).
#
# Every node, day to day:
#   scripts/cluster.sh drain     take this node out of the load balancer's rotation
#   scripts/cluster.sh undrain   put it back
#   scripts/cluster.sh status    this node's health check, and (bundled cluster) the database
#                                nodes and the object store's nodes as this node sees them
#
# Bringing up a bundled cluster (DEPLOY_MODE=cluster, shape C; see INSTALL.md):
#   init-certs <addr>...         ONCE, on one machine: a certificate authority and a certificate
#                                bundle per node address, in data/cluster-certs/
#   install-certs <bundle-dir>   on each node: install that node's bundle into data/certs/
#   start-data                   on each node: start the database and object store (not the app)
#   init-db                      ONCE, on one node: initialise the database cluster, create the
#                                church database and the app's database user (safe to run again,
#                                e.g. after restoring a backup made on a single-node install)
#   db-members <count> [secs]    wait until <count> database nodes have joined (after init-db)
#   node-id                      print this node's object-store id, for the others to connect to
#   garage-bootstrap <id@addr:port>...
#                                ONCE, on one node: connect the other nodes, form the object
#                                store's layout, create the bucket and access key
#   migrate, seed                ONCE, on one node: apply the migrations and seed the defaults
#                                (in a one-off container: the app cannot start on an empty database)
#   up                           on each node (not NODE_ROLE=data): start everything
#
# Changing the cluster later:
#   garage-join <id@addr:port> [--replace <old node id>]
#                                on a NEW node: join an existing object store cluster; with
#                                --replace, in the same step take a lost node's place
#   garage-remove-node <id>      take a node out of the object store layout
#   db-remove-node <id>          decommission a database node (ids: `status`)
#   sql [args]                   a SQL shell (or `-e 'query'`) on this node's database, as root
#
# Draining makes the node's /healthz answer 503 "draining" (the proxy checks for the
# flag file data/caddy/drain), so the load balancer stops sending it new requests.
# Requests and WebSocket connections already open are not cut: wait for them to finish
# (or for the load balancer's own drain timeout) before restarting the node.
set -euo pipefail
cd "$(dirname "$0")/.."

FLAG=data/caddy/drain
PORT="${EXTERNAL_PORT:-}"
if [[ -z "$PORT" && -f .env ]]; then
  PORT="$(sed -n 's/^EXTERNAL_PORT=//p' .env | tail -n 1 | sed -E 's/[[:space:]]+#.*$//; s/^"(.*)"$/\1/')"
fi
PORT="${PORT:-8100}"

# One request to this node's own health check: prints "<status> <body>".
health() {
  local out code body
  if command -v curl >/dev/null 2>&1; then
    out="$(curl -s -m 5 -w '\n%{http_code}' "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)"
    code="$(tail -n 1 <<<"$out")"
    body="$(head -n -1 <<<"$out" | tr -d '\n' | head -c 120)"
    echo "${code:-000} ${body}"
  else
    docker run --rm --network=host node:20-alpine node -e '
      require("http").get({host:"127.0.0.1",port:process.argv[1],path:"/healthz",timeout:5000},r=>{let b="";r.on("data",d=>b+=d);r.on("end",()=>console.log(r.statusCode,b.replace(/\s+/g," ").slice(0,120)))}).on("error",e=>console.log("000",e.message))' "$PORT"
  fi
}


CERT_DIR=data/certs
CA_DIR=data/cluster-certs
CRDB_IMAGE=cockroachdb/cockroach:v24.2.0

die() { echo "cluster.sh: $*" >&2; exit 1; }
dc() { bash scripts/compose.sh --prod "$@"; }
# KEY from compose.sh's resolved cluster settings.
cfg() { dc --cluster-env | sed -n "s/^$1=//p"; }
need_cluster() {
  [[ "$(dc --deploy-mode)" == cluster ]] || die "this needs DEPLOY_MODE=cluster in .env (see INSTALL.md, shape C)."
}
need_bundled_db() {
  need_cluster
  [[ "$(dc --db-mode)" == bundled ]] || die "this is for the bundled database (DB_MODE=bundled)."
}
need_bundled_s3() {
  need_cluster
  [[ "$(dc --s3-mode)" == bundled ]] || die "this is for the bundled object store (S3_MODE=bundled)."
}
crdb_exec() { dc exec -T cockroach cockroach "$@"; }
SQLARGS=(--certs-dir=/certs --host=127.0.0.1:26257)
garage() { dc exec -T garage garage -c /tmp/garage.toml "$@"; }
# The current layout version of the object store as this node knows it (0 = none yet).
layout_version() { garage layout show 2>/dev/null | sed -n 's/.*Current cluster layout version: *\([0-9][0-9]*\).*/\1/p' | head -n 1; }

# Wait (up to $2 seconds) for a command to succeed.
wait_for() {
  local what="$1" secs="$2"; shift 2
  local i=0
  until "$@" >/dev/null 2>&1; do
    i=$((i + 1))
    [[ $i -gt $secs ]] && die "timed out waiting for $what"
    sleep 1
  done
}

cmd="${1:-status}"
shift || true
case "$cmd" in
  drain)
    mkdir -p "$(dirname "$FLAG")"
    touch "$FLAG"
    echo "drain flag set ($FLAG)."
    sleep 1
    echo "health check now: $(health)"
    echo "The load balancer stops sending new requests after its next failed checks. Wait for"
    echo "open requests and WebSocket connections to finish, then upgrade or restart this node."
    ;;
  undrain)
    rm -f "$FLAG"
    echo "drain flag cleared."
    sleep 1
    echo "health check now: $(health)"
    ;;
  status)
    if [[ -e "$FLAG" ]]; then echo "drain flag: set"; else echo "drain flag: not set"; fi
    echo "health check:  $(health)"
    if [[ "$(dc --deploy-mode)" == cluster ]]; then
      if [[ "$(dc --db-mode)" == bundled ]]; then
        echo
        echo "== database nodes (as seen from this node) =="
        if out="$(crdb_exec node status "${SQLARGS[@]}" --format=csv 2>&1)"; then
          awk -F, 'NR==1 {printf "  %-4s %-24s %-9s %-10s %s\n", "id", "address", "build", "available", "live"; next}
                   {printf "  %-4s %-24s %-9s %-10s %s\n", $1, $2, $4, $8, $9}' <<<"$out"
        else
          echo "  (this node's database is not answering)"
        fi
      fi
      if [[ "$(dc --s3-mode)" == bundled ]]; then
        echo
        echo "== object store nodes (as seen from this node) =="
        garage status 2>&1 | head -n 20 || echo "  (this node's object store is not answering)"
      fi
    fi
    ;;

  init-certs)
    [[ $# -ge 1 ]] || die "usage: scripts/cluster.sh init-certs <node address>...   (each node's NODE_ADDR: an IP or a DNS name)"
    command -v docker >/dev/null || die "docker is needed to run the certificate tool."
    mkdir -p "$CA_DIR"
    chmod 700 "$CA_DIR"
    crt() { docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/$CA_DIR:/ca" "$CRDB_IMAGE" "$@"; }
    if [[ ! -f "$CA_DIR/ca.key" ]]; then
      echo "creating the certificate authority in $CA_DIR (keep ca.key safe and OFF the nodes)"
      mkdir -p "$CA_DIR/.ca-work"
      crt cert create-ca --certs-dir=/ca/.ca-work --ca-key=/ca/ca.key
      cp "$CA_DIR/.ca-work/ca.crt" "$CA_DIR/ca.crt"
      rm -rf "$CA_DIR/.ca-work"
      chmod 600 "$CA_DIR/ca.key"
    else
      echo "using the existing certificate authority in $CA_DIR"
    fi
    for addr in "$@"; do
      name="${addr//[:\/]/_}"
      bundle="$CA_DIR/$name"
      mkdir -p "$bundle"
      cp "$CA_DIR/ca.crt" "$bundle/ca.crt"
      # Valid for the node's address, the in-stack name the app uses (`cockroach`) and local use.
      crt cert create-node "$addr" cockroach localhost 127.0.0.1 --certs-dir="/ca/$name" --ca-key=/ca/ca.key --overwrite
      crt cert create-client root --certs-dir="/ca/$name" --ca-key=/ca/ca.key --overwrite
      chmod 600 "$bundle"/*.key
      echo "bundle for $addr: $bundle  (copy it to that node, then: scripts/cluster.sh install-certs <dir>)"
    done
    ;;

  install-certs)
    src="${1:-}"
    [[ -n "$src" && -d "$src" ]] || die "usage: scripts/cluster.sh install-certs <bundle directory from init-certs>"
    for f in ca.crt node.crt node.key client.root.crt client.root.key; do
      [[ -f "$src/$f" ]] || die "$src/$f is missing: that is not a certificate bundle."
    done
    [[ ! -f "$src/ca.key" ]] || die "$src contains ca.key. Never put the CA key on a node: copy only the bundle."
    mkdir -p "$CERT_DIR"
    for f in ca.crt node.crt node.key client.root.crt client.root.key; do cp "$src/$f" "$CERT_DIR/$f"; done
    chmod 644 "$CERT_DIR"/*.crt
    chmod 600 "$CERT_DIR"/*.key
    echo "installed into $CERT_DIR. (After replacing certificates on a running node: docker kill -s HUP <the cockroach container>)"
    ;;

  start-data)
    need_cluster
    services=()
    [[ "$(dc --db-mode)" == bundled ]] && services+=(cockroach)
    [[ "$(dc --s3-mode)" == bundled ]] && services+=(garage garage-init)
    [[ ${#services[@]} -gt 0 ]] || die "nothing to start: this node uses an external database and object store."
    dc up -d "${services[@]}"
    echo "started: ${services[*]}"
    echo "The database reports unhealthy until the cluster is initialised (init-db, once, on one node)."
    ;;

  init-db)
    need_bundled_db
    echo "waiting for this node's database to accept connections ..."
    wait_for "the database process" 60 dc exec -T cockroach cockroach sql "${SQLARGS[@]}" --help
    # The first start of a cluster: init is refused with "already been initialized" afterwards,
    # which is fine. Every node must be started (start-data) before this is useful, because init
    # only wakes the nodes that this one can reach.
    if out="$(crdb_exec init "${SQLARGS[@]}" 2>&1)"; then
      echo "cluster initialised."
    elif grep -qi "already been initialized" <<<"$out"; then
      echo "the cluster was already initialised."
    else
      echo "$out" >&2
      die "cockroach init failed (is every node started and reachable on its CLUSTER_DB_PORT?)"
    fi
    wait_for "the database to be ready" 90 dc exec -T cockroach cockroach sql "${SQLARGS[@]}" -e "SELECT 1"
    pass="$(dc --db-url | sed -n 's#^postgresql://church:\([^@]*\)@.*#\1#p')"
    [[ -n "$pass" ]] || die "could not work out the database password (is AUTH_SECRET set?)"
    # The password goes in on stdin, not on a command line.
    printf '%s\n' \
      "CREATE DATABASE IF NOT EXISTS church;" \
      "CREATE USER IF NOT EXISTS church;" \
      "ALTER USER church WITH PASSWORD '$pass';" \
      "GRANT ALL ON DATABASE church TO church;" \
      "ALTER DATABASE church OWNER TO church;" \
      | dc exec -T cockroach cockroach sql "${SQLARGS[@]}" >/dev/null
    # Tables made by another user (a backup restored from a single-node install, whose owner was
    # root) are handed to the app's user. Nothing happens on a database the app made itself.
    printf '%s\n' "REASSIGN OWNED BY root TO church;" \
      | dc exec -T cockroach cockroach sql "${SQLARGS[@]}" --database=church >/dev/null
    echo "database 'church' and user 'church' are ready. Next: node-id / garage-bootstrap (object store), then 'up' on each node."
    ;;

  db-members)
    # Wait until <count> database nodes have joined (live and available), as this node sees it. A node
    # that was started long before the first one existed can sit waiting without ever joining: restart
    # its database (scripts/compose.sh --prod restart cockroach) and it joins at once.
    need_bundled_db
    want="${1:-}"; secs="${2:-60}"
    [[ "$want" =~ ^[0-9]+$ ]] || die "usage: scripts/cluster.sh db-members <count> [seconds]"
    members() {
      crdb_exec node status "${SQLARGS[@]}" --format=csv 2>/dev/null | awk -F, 'NR > 1 && $8 == "true" && $9 == "true" {n++} END {print n + 0}'
    }
    i=0
    while :; do
      n="$(members)"
      [[ "$n" -ge "$want" ]] && { echo "$n of $want database nodes have joined."; exit 0; }
      i=$((i + 3)); [[ $i -gt $secs ]] && { echo "only $n of $want database nodes have joined." >&2; exit 1; }
      sleep 3
    done
    ;;

  node-id)
    need_bundled_s3
    wait_for "this node's object store" 60 garage status
    id="$(garage node id -q 2>/dev/null | head -n 1 | cut -d@ -f1)"
    [[ -n "$id" ]] || die "could not read this node's id"
    addr="$(cfg NODE_ADDR)"; port="$(cfg CLUSTER_S3_RPC_PORT)"
    echo "$id@$addr:$port"
    ;;

  garage-bootstrap)
    need_bundled_s3
    [[ $# -ge 1 ]] || die "usage: scripts/cluster.sh garage-bootstrap <id@addr:port>...   (the other nodes' output of 'scripts/cluster.sh node-id')"
    cap="$(cfg CLUSTER_S3_CAPACITY)"; rf="$(cfg GARAGE_REPLICATION_FACTOR)"
    wait_for "this node's object store" 60 garage status
    if [[ "$(layout_version)" =~ ^[1-9][0-9]*$ ]]; then
      die "the object store already has a layout. Use garage-join (new node) or garage-remove-node instead."
    fi
    for peer in "$@"; do
      echo "connecting $peer ..."
      garage node connect "$peer" || die "could not connect to $peer (is its RPC port open to this node?)"
    done
    want=$(( $# + 1 ))
    echo "waiting for $want nodes to be connected ..."
    wait_for "$want connected nodes" 60 bash -c "[ \"\$(bash scripts/compose.sh --prod exec -T garage garage -c /tmp/garage.toml status 2>/dev/null | grep -c 'NO ROLE ASSIGNED')\" -ge $want ]"
    ids="$(garage status 2>/dev/null | awk '/NO ROLE ASSIGNED/ {print $1}')"
    (( rf <= want )) || die "replication factor $rf needs at least $rf nodes."
    for id in $ids; do
      garage layout assign -z "z-${id:0:8}" -c "$cap" "$id" >/dev/null
    done
    garage layout apply --version 1 >/dev/null
    echo "layout applied for $want nodes (replication factor $rf, $cap each). Creating the bucket and key ..."
    dc run -T --rm --no-deps garage-init
    ;;

  garage-join)
    need_bundled_s3
    [[ $# -ge 1 ]] || die "usage: scripts/cluster.sh garage-join <id@addr:port> [--replace <old node id>]   (the id@addr:port is an existing node's output of 'scripts/cluster.sh node-id')"
    peer="$1"; shift
    old=""
    if [[ "${1:-}" == "--replace" ]]; then
      old="${2:-}"; [[ -n "$old" ]] || die "--replace needs the lost node's id (see 'scripts/cluster.sh status')"
      shift 2
    fi
    [[ $# -eq 0 ]] || die "unexpected argument: $1"
    cap="$(cfg CLUSTER_S3_CAPACITY)"
    wait_for "this node's object store" 60 garage status
    garage node connect "$peer" || die "could not connect to $peer"
    mine="$(garage node id -q 2>/dev/null | head -n 1 | cut -d@ -f1)"
    # A node that has not heard the layout yet reports an empty one, "version 0": wait for a real one.
    layout_known() { [[ "$(layout_version)" =~ ^[1-9][0-9]*$ ]]; }
    wait_for "the object store's layout to reach this node" 60 layout_known
    ver="$(layout_version)"
    garage layout assign -z "z-${mine:0:8}" -c "$cap" "$mine" >/dev/null
    # Taking the lost node's place in the same layout change keeps the cluster from waiting on
    # two intermediate versions that the dead node can never acknowledge.
    [[ -z "$old" ]] || garage layout remove "$old" >/dev/null
    garage layout apply --version "$(( ver + 1 ))" >/dev/null
    if [[ -n "$old" ]]; then
      # The lost node can never acknowledge the new layout: tell the cluster not to wait for it.
      garage layout skip-dead-nodes --version "$(( ver + 1 ))" >/dev/null || true
    fi
    echo "this node joined the object store layout (version $(( ver + 1 ))); data moves onto it in the background."
    dc run -T --rm --no-deps garage-init
    ;;

  garage-remove-node)
    need_bundled_s3
    id="${1:-}"
    [[ -n "$id" ]] || die "usage: scripts/cluster.sh garage-remove-node <node id>   (ids: scripts/cluster.sh status)"
    ver="$(layout_version)"
    garage layout remove "$id"
    garage layout apply --version "$(( ver + 1 ))"
    echo "removed from the layout; its data is copied to the remaining nodes in the background (watch: garage status, garage stats)."
    ;;

  db-remove-node)
    need_bundled_db
    id="${1:-}"
    [[ "$id" =~ ^[0-9]+$ ]] || die "usage: scripts/cluster.sh db-remove-node <numeric node id>   (ids: scripts/cluster.sh status)"
    crdb_exec node decommission "$id" "${SQLARGS[@]}"
    ;;

  sql)
    need_bundled_db
    if [[ -t 0 && -t 1 ]]; then dc exec cockroach cockroach sql "${SQLARGS[@]}" "$@"
    else crdb_exec sql "${SQLARGS[@]}" "$@"; fi
    ;;

  migrate|seed)
    need_cluster
    [[ "$(cfg NODE_ROLE)" == full ]] || die "a data node does not run the app."
    # A one-off container, not `exec api`: on an empty database the app itself cannot start.
    # --build: run the code of THIS checkout. Without it an image left over from an earlier release
    # would be used, and its migrations would be the old ones.
    dc run -T --rm --no-deps --build api node "dist/scripts/$cmd.js"
    ;;

  up)
    need_cluster
    if [[ "$(cfg NODE_ROLE)" == data ]]; then
      exec bash "$0" start-data
    fi
    exec bash scripts/compose.sh --prod up -d --build
    ;;

  *)
    sed -n '3,40p' "$0" >&2
    exit 2
    ;;
esac
