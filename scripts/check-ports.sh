#!/usr/bin/env bash
# Pre-flight check: every host-bound port for this stack must be free, or already
# held by one of our own containers (a re-up is fine). On collision, suggest a
# next free port and tell the user which env var to set.
#
# Designed to be run as a `make` dependency, so it must succeed silently on the
# happy path and fail with a non-zero exit on real collisions.

set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-church}"

# Read defaults from .env if present, else fall back to compose defaults.
load_var() {
  local var="$1" default="$2"
  if [ -f "$ENV_FILE" ]; then
    local val
    val=$(grep -E "^${var}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//' | tr -d '"' | tr -d "'") || true
    [ -n "${val:-}" ] && { echo "$val"; return; }
  fi
  echo "$default"
}

EXTERNAL_PORT=$(load_var EXTERNAL_PORT 8100)
COCKROACH_UI_PORT=$(load_var COCKROACH_UI_PORT 8180)

# Map: "label:env-var-name:port"
declare -a CHECKS=(
  "Caddy proxy (browser entrypoint):EXTERNAL_PORT:${EXTERNAL_PORT}"
)
# A cluster node publishes its database and object-store RPC ports for the other nodes (the
# admin UI is not published there); a single node publishes only the dev admin UI port.
CLUSTER_ENV="$(bash "$(dirname "$0")/compose.sh" --prod --cluster-env 2>/dev/null || true)"
if [ "$(sed -n 's/^DEPLOY_MODE=//p' <<<"$CLUSTER_ENV")" = cluster ]; then
  if [ "$(sed -n 's/^DB_MODE=//p' <<<"$CLUSTER_ENV")" = bundled ]; then
    CHECKS+=("Cluster database:CLUSTER_DB_PORT:$(sed -n 's/^CLUSTER_DB_PORT=//p' <<<"$CLUSTER_ENV")")
  fi
  if [ "$(sed -n 's/^S3_MODE=//p' <<<"$CLUSTER_ENV")" = bundled ]; then
    CHECKS+=("Cluster object store RPC:CLUSTER_S3_RPC_PORT:$(sed -n 's/^CLUSTER_S3_RPC_PORT=//p' <<<"$CLUSTER_ENV")")
    api_port="$(sed -n 's/^CLUSTER_S3_API_PORT=//p' <<<"$CLUSTER_ENV")"
    [ -z "$api_port" ] || CHECKS+=("Cluster object store S3 API:CLUSTER_S3_API_PORT:$api_port")
  fi
elif [ "$(bash "$(dirname "$0")/compose.sh" --db-mode)" = bundled ]; then
  # The Cockroach admin UI port only exists with the bundled database.
  CHECKS+=("Cockroach admin UI:COCKROACH_UI_PORT:${COCKROACH_UI_PORT}")
fi

# What's listening? Prefer `ss` (faster, modern); fall back to `netstat`.
listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH 2>/dev/null | awk '{print $4}' | grep -E "[:.]${port}\$" -q
  else
    netstat -tln 2>/dev/null | awk '{print $4}' | grep -E "[:.]${port}\$" -q
  fi
}

# Is the listener one of our own containers? We treat that as "already up — fine".
ours() {
  local port="$1"
  if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
      | grep -E "^${COMPOSE_PROJECT}-" \
      | grep -q ":${port}->"
  else
    return 1
  fi
}

# Find the next free port at or above $1.
next_free() {
  local p="$1"
  while listening "$p"; do p=$((p+1)); done
  echo "$p"
}

fail=0
for spec in "${CHECKS[@]}"; do
  label=${spec%%:*}; rest=${spec#*:}
  var=${rest%%:*}; port=${rest#*:}
  if ! listening "$port"; then
    printf "  ok    %-32s :%-5s free\n" "$label" "$port"
    continue
  fi
  if ours "$port"; then
    printf "  ok    %-32s :%-5s held by our own container (re-up safe)\n" "$label" "$port"
    continue
  fi
  suggested=$(next_free "$((port+1))")
  printf "  FAIL  %-32s :%-5s in use by something else\n" "$label" "$port"
  printf "         set %s=%s in %s and re-run\n" "$var" "$suggested" "$ENV_FILE"
  fail=$((fail+1))
done

if [ "$fail" -gt 0 ]; then
  echo ""
  echo "$fail port(s) collide. Pick free ones (suggestions above), update $ENV_FILE, then re-run." >&2
  exit 1
fi
