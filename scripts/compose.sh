#!/usr/bin/env bash
#
# docker compose wrapper that wires up the database choice from .env.
#
#   DB_MODE=bundled   (default) run the CockroachDB bundled in the compose
#                     stack: single node in dev, 3 nodes in prod. DATABASE_URL
#                     is set for you.
#   DB_MODE=external  use a database you already run: YugabyteDB (YSQL) or
#                     CockroachDB. DATABASE_URL is required and must be
#                     reachable from the containers. The engine is detected
#                     at runtime; you never declare it.
#
# The bundled database lives in the `bundled-db` compose profile; this script
# switches that profile on or off and exports DATABASE_URL for the compose
# files to interpolate. Everything else is passed straight to docker compose.
#
# Several nodes (docs/multi-node.md): DEPLOY_MODE=cluster (prod only) adds
# infra/docker-compose.cluster.yml. With DB_MODE=bundled every node then runs one CockroachDB in
# secure mode (TLS certificates from scripts/cluster.sh init-certs), joined into one cluster;
# with S3_MODE=bundled the Garage nodes form one cluster. Settings (all in .env, per node):
#   NODE_ID  NODE_ADDR  CLUSTER_PEERS  CLUSTER_BIND_ADDR  NODE_ROLE  CLUSTER_DB_PORT
#   CLUSTER_S3_RPC_PORT  GARAGE_REPLICATION_FACTOR  CLUSTER_S3_CAPACITY  CLUSTER_S3_API_PORT (optional)
#
# Usage: scripts/compose.sh [--prod] <docker compose args...>
#        scripts/compose.sh [--prod] --deploy-mode   # print the resolved DEPLOY_MODE
#        scripts/compose.sh [--prod] --cluster-env   # the resolved cluster settings (KEY=value)
#        scripts/compose.sh [--prod] --s3-mode   # print the resolved S3_MODE
#        scripts/compose.sh [--prod] --s3-env    # the store settings the app uses (KEY=value)
#        scripts/compose.sh [--prod] --db-mode   # print the resolved mode
#        scripts/compose.sh [--prod] --db-url    # print the resolved DATABASE_URL
#
# Running docker compose by hand instead: export DATABASE_URL and, for the
# bundled database, add `--profile bundled-db`.

set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(infra/docker-compose.yml)
PROD=0
if [[ "${1:-}" == "--prod" ]]; then
  FILES=(infra/docker-compose.prod.yml)
  PROD=1
  shift
fi

die() {
  echo "compose.sh: $*" >&2
  exit 1
}

# Read KEY from .env: last assignment wins, an unquoted trailing "# comment"
# is dropped, surrounding quotes are stripped (matching compose's env_file).
env_get() {
  [[ -f .env ]] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | sed -E 's/[[:space:]]+#.*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

# The shell environment wins over .env, so a one-off `DB_MODE=external make up` works.
conf() { local v="${!1:-}"; [[ -n "$v" ]] || v="$(env_get "$1")"; printf '%s' "${v:-${2:-}}"; }

DEPLOY_MODE="$(conf DEPLOY_MODE single)"
NODE_ID_VALUE="$(conf NODE_ID)"
NODE_ROLE="$(conf NODE_ROLE full)"
NODE_ADDR="$(conf NODE_ADDR)"
CLUSTER_PEERS="$(conf CLUSTER_PEERS)"
CLUSTER_BIND_ADDR="$(conf CLUSTER_BIND_ADDR 0.0.0.0)"
CLUSTER_DB_PORT="$(conf CLUSTER_DB_PORT 26257)"
CLUSTER_S3_RPC_PORT="$(conf CLUSTER_S3_RPC_PORT 3901)"
CLUSTER_S3_CAPACITY="$(conf CLUSTER_S3_CAPACITY 100G)"
CLUSTER_S3_API_PORT="$(conf CLUSTER_S3_API_PORT)"
case "$DEPLOY_MODE" in
  single|cluster) ;;
  *) die "DEPLOY_MODE must be 'single' or 'cluster' (got '$DEPLOY_MODE')." ;;
esac
case "$NODE_ROLE" in
  full|data) ;;
  *) die "NODE_ROLE must be 'full' or 'data' (got '$NODE_ROLE')." ;;
esac
if [[ "$DEPLOY_MODE" == single ]]; then
  [[ "$NODE_ROLE" == full ]] || die "NODE_ROLE=data is for a cluster node (a database and object-store witness). Set DEPLOY_MODE=cluster."
else
  [[ "$PROD" == 1 ]] || die "DEPLOY_MODE=cluster is for the production stack: use scripts/compose.sh --prod (or make prod-*)."
  [[ -n "$NODE_ID_VALUE" ]] || die "DEPLOY_MODE=cluster needs NODE_ID in .env, different on every node (e.g. NODE_ID=node-a)."
  [[ "$NODE_ID_VALUE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "NODE_ID may only contain letters, digits, '.', '_' and '-' (got '$NODE_ID_VALUE')."
  [[ "$CLUSTER_DB_PORT$CLUSTER_S3_RPC_PORT" =~ ^[0-9]+$ ]] || die "CLUSTER_DB_PORT and CLUSTER_S3_RPC_PORT must be port numbers."
  FILES+=(infra/docker-compose.cluster.yml)
  if [[ -n "$CLUSTER_S3_API_PORT" ]]; then
    [[ "$CLUSTER_S3_API_PORT" =~ ^[0-9]+$ ]] || die "CLUSTER_S3_API_PORT must be a port number."
    FILES+=(infra/docker-compose.cluster-s3-api.yml)
  fi
  # Whether the bundled database is in use is decided below (DB_MODE); see `case "$DB_MODE"`.
fi

# CLUSTER_PEERS: the other nodes, comma separated. An entry is a host, or host:dbport:rpcport when
# that node uses other ports than CLUSTER_DB_PORT / CLUSTER_S3_RPC_PORT (only needed when several
# nodes share one host, as in tests). PEER_HOSTS / PEER_DB / PEER_RPC are parallel arrays.
PEER_HOSTS=(); PEER_DB=(); PEER_RPC=()
if [[ "$DEPLOY_MODE" == cluster && -n "$CLUSTER_PEERS" ]]; then
  IFS=, read -ra _peers <<<"$CLUSTER_PEERS"
  for _p in "${_peers[@]}"; do
    _p="${_p// /}"
    IFS=: read -r _h _d _r <<<"$_p"
    [[ -n "$_h" ]] || die "CLUSTER_PEERS has an empty entry ('$CLUSTER_PEERS')."
    [[ "${_d:-1}${_r:-1}" =~ ^[0-9]+$ ]] || die "CLUSTER_PEERS entry '$_p': ports must be numbers (host or host:dbport:rpcport)."
    PEER_HOSTS+=("$_h"); PEER_DB+=("${_d:-$CLUSTER_DB_PORT}"); PEER_RPC+=("${_r:-$CLUSTER_S3_RPC_PORT}")
  done
fi

# SHA-256 of stdin as hex, with whatever this host has.
sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  else openssl dgst -sha256 -r | cut -d' ' -f1; fi
}
AUTH_SECRET_VALUE="${AUTH_SECRET:-$(env_get AUTH_SECRET)}"
# Secrets derived from AUTH_SECRET, so there is nothing more to configure and every node of a
# cluster (which shares AUTH_SECRET) gets the same ones. `derive_ns <namespace>` is the general
# form (the bundled cluster database's password); `derive <name>` is the Garage namespace, whose
# strings must never change (they are the live access key). Garage only accepts its own key
# format: GK + 24 hex characters, and a 64-hex secret.
derive_ns() { [[ -n "$AUTH_SECRET_VALUE" ]] && printf '%s' "church-dashboard/$1/v1:$AUTH_SECRET_VALUE" | sha256_hex || true; }
derive() { derive_ns "garage/$1"; }

DB_MODE="${DB_MODE:-$(env_get DB_MODE)}"
DB_MODE="${DB_MODE:-bundled}"
DATABASE_URL="${DATABASE_URL:-$(env_get DATABASE_URL)}"
BUNDLED_URL="postgresql://root@cockroach-1:26257/church?sslmode=disable"

case "$DB_MODE" in
  bundled)
    if [[ "$DEPLOY_MODE" == cluster ]]; then
      # Secure mode: the app signs in as the `church` user (password derived from AUTH_SECRET)
      # and verifies the node's certificate against the cluster CA.
      if [[ -n "$DATABASE_URL" && "$DATABASE_URL" != *"@cockroach:"* ]]; then
        die "DB_MODE=bundled, but DATABASE_URL points somewhere else. Set DB_MODE=external to use that database, or remove DATABASE_URL."
      fi
      [[ -n "$AUTH_SECRET_VALUE" ]] || die "DEPLOY_MODE=cluster with DB_MODE=bundled needs AUTH_SECRET in .env (the database password is derived from it)."
      [[ -n "$NODE_ADDR" ]] || die "DEPLOY_MODE=cluster with DB_MODE=bundled needs NODE_ADDR in .env: the address the other nodes reach this one on."
      [[ -n "$CLUSTER_PEERS" ]] || die "DEPLOY_MODE=cluster with DB_MODE=bundled needs CLUSTER_PEERS in .env: the other nodes' addresses, comma separated."
      DB_PASSWORD="$(derive_ns db/password)"
      DATABASE_URL="postgresql://church:${DB_PASSWORD}@cockroach:26257/church?sslmode=verify-full&sslrootcert=/certs/ca.crt"
      CLUSTER_JOIN="${NODE_ADDR}:${CLUSTER_DB_PORT}"
      for _i in "${!PEER_HOSTS[@]}"; do CLUSTER_JOIN+=",${PEER_HOSTS[$_i]}:${PEER_DB[$_i]}"; done
      PROFILE="cluster-db"
      FILES+=(infra/docker-compose.cluster-db.yml)
    else
      if [[ -n "$DATABASE_URL" && "$DATABASE_URL" != *"@cockroach-1:"* ]]; then
        die "DB_MODE=bundled, but DATABASE_URL points somewhere else. Set DB_MODE=external to use that database, or remove DATABASE_URL."
      fi
      DATABASE_URL="$BUNDLED_URL"
      PROFILE="bundled-db"
    fi
    ;;
  external)
    [[ -n "$DATABASE_URL" ]] || die "DB_MODE=external needs DATABASE_URL in .env (e.g. postgresql://user:pass@yb-host:5433/church)."
    if [[ "$DATABASE_URL" == *"@cockroach-1:"* ]]; then
      die "DB_MODE=external, but DATABASE_URL points at the bundled cockroach-1. Use DB_MODE=bundled, or point DATABASE_URL at your database."
    fi
    PROFILE=""
    [[ "$NODE_ROLE" == full ]] || die "NODE_ROLE=data runs the bundled database, so it needs DB_MODE=bundled."
    ;;
  *)
    die "DB_MODE must be 'bundled' or 'external' (got '$DB_MODE')."
    ;;
esac

# Where uploaded files live, chosen the same way:
#   S3_MODE=bundled   (default) the Garage in this stack (profile bundled-s3).
#   S3_MODE=external  an S3-compatible store you run or rent: S3_ENDPOINT, S3_ACCESS_KEY
#                     and S3_SECRET_KEY (and S3_BUCKET, which must exist) in .env.
S3_MODE="${S3_MODE:-$(env_get S3_MODE)}"
S3_MODE="${S3_MODE:-bundled}"
S3_ENDPOINT="${S3_ENDPOINT:-$(env_get S3_ENDPOINT)}"
BUNDLED_S3="garage:3900"
# The bundled endpoint, or the old bundled MinIO's (an existing .env may still name it).
bundled_s3_endpoint() {
  case "${1%/}" in
    ""|"$BUNDLED_S3"|"http://$BUNDLED_S3"|"minio:9000"|"http://minio:9000") return 0 ;;
    *) return 1 ;;
  esac
}

# What the compose files interpolate for the bundled Garage; single node: one copy of the data.
GARAGE_RF_SET="$(conf GARAGE_REPLICATION_FACTOR)"
GARAGE_CLUSTER=""
GARAGE_RPC_PUBLIC_ADDR="garage:3901"
GARAGE_REPLICATION_FACTOR=1
GARAGE_ADMIN_TOKEN=""
case "$S3_MODE" in
  bundled)
    bundled_s3_endpoint "$S3_ENDPOINT" || die "S3_MODE=bundled, but S3_ENDPOINT points somewhere else. Set S3_MODE=external to use that store, or remove S3_ENDPOINT."
    S3_ENDPOINT="$BUNDLED_S3"
    S3_PROFILE="bundled-s3"
    S3_REGION="garage"
    S3_ACCESS_KEY="${S3_ACCESS_KEY:-$(env_get S3_ACCESS_KEY)}"
    S3_SECRET_KEY="${S3_SECRET_KEY:-$(env_get S3_SECRET_KEY)}"
    if [[ -z "$S3_ACCESS_KEY$S3_SECRET_KEY" ]]; then
      id="$(derive key-id)"; S3_ACCESS_KEY="${id:+GK${id:0:24}}"
      S3_SECRET_KEY="$(derive secret)"
    else
      [[ "$S3_ACCESS_KEY" =~ ^GK[0-9a-f]{24}$ && "$S3_SECRET_KEY" =~ ^[0-9a-f]{64}$ ]] \
        || die "S3_ACCESS_KEY / S3_SECRET_KEY: the bundled store only accepts keys in its own format (GK + 24 hex characters, and 64 hex characters). Remove both from .env to have them derived from AUTH_SECRET."
    fi
    GARAGE_RPC_SECRET="${GARAGE_RPC_SECRET:-$(env_get GARAGE_RPC_SECRET)}"
    GARAGE_RPC_SECRET="${GARAGE_RPC_SECRET:-$(derive rpc)}"
    GARAGE_ADMIN_TOKEN="$(derive admin)"
    if [[ "$DEPLOY_MODE" == cluster ]]; then
      [[ -n "$NODE_ADDR" ]] || die "DEPLOY_MODE=cluster with S3_MODE=bundled needs NODE_ADDR in .env: the address the other nodes reach this one on."
      [[ -n "$CLUSTER_PEERS" ]] || die "DEPLOY_MODE=cluster with S3_MODE=bundled needs CLUSTER_PEERS in .env: the other nodes' addresses, comma separated."
      GARAGE_CLUSTER=1
      GARAGE_RPC_PUBLIC_ADDR="${NODE_ADDR}:${CLUSTER_S3_RPC_PORT}"
      # Fixed when the cluster is created: 3 copies when there are 3 or more nodes, else 2.
      GARAGE_REPLICATION_FACTOR="${GARAGE_RF_SET:-$(( ${#PEER_HOSTS[@]} + 1 >= 3 ? 3 : 2 ))}"
      [[ "$GARAGE_REPLICATION_FACTOR" =~ ^[1-9]$ ]] || die "GARAGE_REPLICATION_FACTOR must be a single digit (got '$GARAGE_REPLICATION_FACTOR')."
      (( GARAGE_REPLICATION_FACTOR <= ${#PEER_HOSTS[@]} + 1 )) || die "GARAGE_REPLICATION_FACTOR=$GARAGE_REPLICATION_FACTOR needs at least that many nodes (this cluster has $(( ${#PEER_HOSTS[@]} + 1 )))."
    fi
    ;;
  external)
    [[ -n "$S3_ENDPOINT" ]] || die "S3_MODE=external needs S3_ENDPOINT in .env (e.g. https://s3.example.org), plus S3_ACCESS_KEY, S3_SECRET_KEY and S3_BUCKET."
    bundled_s3_endpoint "$S3_ENDPOINT" && die "S3_MODE=external, but S3_ENDPOINT is the bundled store (garage:3900 / minio:9000). Use S3_MODE=bundled, or point S3_ENDPOINT at your store."
    S3_ACCESS_KEY="${S3_ACCESS_KEY:-$(env_get S3_ACCESS_KEY)}"; S3_ACCESS_KEY="${S3_ACCESS_KEY:-$(env_get MINIO_ROOT_USER)}"
    S3_SECRET_KEY="${S3_SECRET_KEY:-$(env_get S3_SECRET_KEY)}"; S3_SECRET_KEY="${S3_SECRET_KEY:-$(env_get MINIO_ROOT_PASSWORD)}"
    [[ -n "$S3_ACCESS_KEY" && -n "$S3_SECRET_KEY" ]] || die "S3_MODE=external needs S3_ACCESS_KEY and S3_SECRET_KEY in .env."
    S3_PROFILE=""
    S3_REGION="${S3_REGION:-$(env_get S3_REGION)}"; S3_REGION="${S3_REGION:-$(env_get MINIO_REGION)}"; S3_REGION="${S3_REGION:-us-east-1}"
    # Compose reads the whole file, inactive services included, so give the Garage ones a value.
    GARAGE_RPC_SECRET="not-used-with-S3_MODE-external"
    [[ "$NODE_ROLE" == full ]] || die "NODE_ROLE=data runs the bundled object store, so it needs S3_MODE=bundled."
    ;;
  *)
    die "S3_MODE must be 'bundled' or 'external' (got '$S3_MODE')."
    ;;
esac
S3_BUCKET_VALUE="${S3_BUCKET:-$(env_get S3_BUCKET)}"; S3_BUCKET_VALUE="${S3_BUCKET_VALUE:-$(env_get MINIO_BUCKET)}"; S3_BUCKET_VALUE="${S3_BUCKET_VALUE:-church-files}"

if [[ "${1:-}" == "--db-mode" ]]; then
  echo "$DB_MODE"
  exit 0
fi
if [[ "${1:-}" == "--db-url" ]]; then
  echo "$DATABASE_URL"
  exit 0
fi
if [[ "${1:-}" == "--deploy-mode" ]]; then
  echo "$DEPLOY_MODE"
  exit 0
fi
if [[ "${1:-}" == "--cluster-env" ]]; then
  # The resolved cluster settings, for scripts/cluster.sh and check-ports.sh (KEY=value lines).
  echo "DEPLOY_MODE=$DEPLOY_MODE"
  echo "DB_MODE=$DB_MODE"
  echo "S3_MODE=$S3_MODE"
  echo "NODE_ID=$NODE_ID_VALUE"
  echo "NODE_ROLE=$NODE_ROLE"
  echo "NODE_ADDR=$NODE_ADDR"
  echo "CLUSTER_BIND_ADDR=$CLUSTER_BIND_ADDR"
  echo "CLUSTER_DB_PORT=$CLUSTER_DB_PORT"
  echo "CLUSTER_S3_RPC_PORT=$CLUSTER_S3_RPC_PORT"
  echo "CLUSTER_S3_CAPACITY=$CLUSTER_S3_CAPACITY"
  echo "CLUSTER_S3_API_PORT=$CLUSTER_S3_API_PORT"
  echo "CLUSTER_JOIN=${CLUSTER_JOIN:-}"
  echo "GARAGE_REPLICATION_FACTOR=$GARAGE_REPLICATION_FACTOR"
  echo "PEERS=$(for i in "${!PEER_HOSTS[@]}"; do printf '%s:%s:%s ' "${PEER_HOSTS[$i]}" "${PEER_DB[$i]}" "${PEER_RPC[$i]}"; done)"
  exit 0
fi
if [[ "${1:-}" == "--s3-mode" ]]; then
  echo "$S3_MODE"
  exit 0
fi
if [[ "${1:-}" == "--s3-env" ]]; then
  # What the app uses to reach the store, for the scripts that talk to it (KEY=value lines).
  # In bundled mode the endpoint is inside the stack's network.
  echo "S3_MODE=$S3_MODE"
  echo "S3_ENDPOINT=$S3_ENDPOINT"
  echo "S3_ACCESS_KEY=$S3_ACCESS_KEY"
  echo "S3_SECRET_KEY=$S3_SECRET_KEY"
  echo "S3_REGION=$S3_REGION"
  echo "S3_BUCKET=$S3_BUCKET_VALUE"
  exit 0
fi

export DATABASE_URL
export S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY S3_REGION GARAGE_RPC_SECRET
export GARAGE_CLUSTER GARAGE_RPC_PUBLIC_ADDR GARAGE_REPLICATION_FACTOR GARAGE_ADMIN_TOKEN
# Interpolated by infra/docker-compose.cluster.yml (harmless defaults in single mode).
export NODE_ADDR CLUSTER_BIND_ADDR CLUSTER_DB_PORT CLUSTER_S3_RPC_PORT CLUSTER_S3_API_PORT CLUSTER_JOIN="${CLUSTER_JOIN:-}"
# The build id of this source tree, passed to the image builds (see scripts/build-id.sh).
BUILD_ID="$(scripts/build-id.sh)"
export BUILD_ID
# Keep any profiles the caller already enabled.
profiles="${COMPOSE_PROFILES:-}"
if [[ -n "$PROFILE" ]]; then
  profiles="${profiles:+$profiles,}$PROFILE"
fi
if [[ -n "$S3_PROFILE" ]]; then
  profiles="${profiles:+$profiles,}$S3_PROFILE"
fi
export COMPOSE_PROFILES="$profiles"

# An install that used the old bundled MinIO has its files in data/minio. Starting the stack
# now would use an empty Garage and those files would seem to be gone: say so.
if [[ "${1:-}" == "up" && "$S3_MODE" == bundled && -n "$(ls -A data/minio 2>/dev/null)" ]] \
   && [[ -z "$(ls -A data/garage/data 2>/dev/null)" ]]; then
  echo "compose.sh: warning: data/minio has files from the old bundled MinIO, but the bundled store is now" >&2
  echo "compose.sh: Garage and its data directory is empty. Move the files first (see INSTALL.md," >&2
  echo "compose.sh: 'Moving from MinIO to Garage'): scripts/s3-copy.sh --from-minio --to-bundled" >&2
fi

# A cluster node's database refuses to start without its certificates.
if [[ "${1:-}" == "up" && "$DEPLOY_MODE" == cluster && "$DB_MODE" == bundled ]]; then
  for f in ca.crt node.crt node.key client.root.crt client.root.key; do
    [[ -f "data/certs/$f" ]] || die "data/certs/$f is missing. Create the cluster certificates once with 'scripts/cluster.sh init-certs <node address>...' and install this node's with 'scripts/cluster.sh install-certs <dir>' (INSTALL.md, shape C)."
  done
fi

# Compose looks for .env next to the compose file (infra/), not here, so
# without this the ${VAR} values in the compose files ignore the root .env.
env_args=()
[[ -f .env ]] && env_args=(--env-file .env)

file_args=()
for f in "${FILES[@]}"; do file_args+=(-f "$f"); done
exec docker compose "${env_args[@]}" "${file_args[@]}" "$@"
