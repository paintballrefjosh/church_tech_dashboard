#!/usr/bin/env bash
#
# Selectively rebuild + restart api/web after code changes. Most Claude-driven
# iterations only touch one of the two apps, so unconditionally running
# `docker compose up -d --build api web` wastes the cache-verification + image
# tagging time on the service that didn't change. This script consults file
# mtimes against a marker, rebuilds only the services that actually have new
# source, runs migrations (with the new api image) only if there are new SQL
# files since the last apply, and then restarts the rebuilt services.
#
# Usage: scripts/rebuild.sh        # rebuild what changed, then migrate
#        scripts/rebuild.sh --all  # force-rebuild both services
#        scripts/rebuild.sh --no-migrate
#
# Marker files (.last-rebuild, .last-migrate) live at the repo root and are
# gitignored. They're touched only on success so an interrupted run re-tries
# the work next time.

set -euo pipefail

cd "$(dirname "$0")/.."

# Through the wrapper so DB_MODE (bundled vs external database) applies.
COMPOSE=(bash scripts/compose.sh)
REBUILD_MARKER=".last-rebuild"
MIGRATE_MARKER=".last-migrate"
FORCE_ALL=0
DO_MIGRATE=1

for arg in "$@"; do
  case "$arg" in
    --all) FORCE_ALL=1 ;;
    --no-migrate) DO_MIGRATE=0 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# A file is "newer than the marker" if either:
#  - the marker doesn't exist yet (first run → rebuild everything), OR
#  - find -newer reports the path
needs_rebuild() {
  local path="$1"
  [ ! -f "$REBUILD_MARKER" ] && return 0
  find "$path" -type f \( \
      -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \
      -o -name '*.json' -o -name '*.css' -o -name 'Dockerfile' -o -name '*.sql' \
      -o -name '*.yml' -o -name 'Caddyfile' -o -name '*.sh' \
    \) -newer "$REBUILD_MARKER" -print -quit 2>/dev/null | grep -q .
}

# The proxy is not built, but its config (the Caddyfile and its environment in compose)
# is read at start: a change needs the proxy recreated or restarted.
proxy_changed=0
needs_rebuild infra && proxy_changed=1
[ "$FORCE_ALL" = 1 ] && proxy_changed=1

services=()
if [ "$FORCE_ALL" = 1 ]; then
  services=(api web monitor)
else
  # apps/api OR packages/shared change → rebuild api.
  # apps/web OR packages/shared change → rebuild web.
  # services/monitor OR packages/shared change → rebuild monitor.
  # (shared is consumed by all three, so a shared edit invalidates them all.)
  api_changed=0
  web_changed=0
  monitor_changed=0
  needs_rebuild apps/api && api_changed=1
  needs_rebuild apps/web && web_changed=1
  needs_rebuild services/monitor && monitor_changed=1
  if needs_rebuild packages/shared; then
    api_changed=1
    web_changed=1
    monitor_changed=1
  fi
  # Dockerfile or compose changes touch everything.
  if needs_rebuild infra/docker-compose.yml || needs_rebuild infra/docker-compose.prod.yml \
    || needs_rebuild apps/api/Dockerfile || needs_rebuild apps/web/Dockerfile \
    || needs_rebuild services/monitor/Dockerfile || needs_rebuild apps/web/entrypoint.sh; then
    api_changed=1
    web_changed=1
    monitor_changed=1
  fi
  [ "$api_changed" = 1 ] && services+=(api)
  [ "$web_changed" = 1 ] && services+=(web)
  [ "$monitor_changed" = 1 ] && services+=(monitor)
fi

migrations_pending() {
  [ "$DO_MIGRATE" = 1 ] || return 1
  [ ! -f "$MIGRATE_MARKER" ] && return 0
  find apps/api/migrations -name '*.sql' -newer "$MIGRATE_MARKER" -print -quit | grep -q .
}

# Order matters: build the new images, migrate with the NEW api image, and only
# then swap the running containers. Starting the new api first meant its code
# queried columns the migration hadn't added yet (search indexing and anything
# else touching them failed until the next restart or retry).
if [ ${#services[@]} -gt 0 ]; then
  echo "==> Rebuilding: ${services[*]}"
  # DOCKER_BUILDKIT=1 is the modern default but force it for older daemons.
  DOCKER_BUILDKIT=1 "${COMPOSE[@]}" build "${services[@]}"
fi

if migrations_pending; then
  # The migrate script is idempotent (it tracks applied entries in a DB
  # table); the marker only saves a container start when nothing is new.
  # `run` brings up the database first if it isn't running.
  echo "==> Applying migrations"
  "${COMPOSE[@]}" run --rm api node dist/scripts/migrate.js
  touch "$MIGRATE_MARKER"
elif [ "$DO_MIGRATE" = 1 ]; then
  echo "==> Migrations: no new files since $(stat -c %y "$MIGRATE_MARKER")"
fi

if [ ${#services[@]} -eq 0 ]; then
  echo "==> No source changes detected since $(stat -c %y "$REBUILD_MARKER" 2>/dev/null || echo never)."
  echo "    Ensuring containers are running (no rebuild)."
  "${COMPOSE[@]}" up -d api web monitor
else
  "${COMPOSE[@]}" up -d "${services[@]}"
fi
if [ "$proxy_changed" = 1 ]; then
  echo "==> Proxy config changed: recreating/restarting the proxy"
  "${COMPOSE[@]}" up -d proxy
  "${COMPOSE[@]}" restart proxy
fi
touch "$REBUILD_MARKER"
