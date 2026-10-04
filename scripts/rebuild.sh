#!/usr/bin/env bash
#
# Selectively rebuild + restart api/web after code changes. Most Claude-driven
# iterations only touch one of the two apps, so unconditionally running
# `docker compose up -d --build api web` wastes the cache-verification + image
# tagging time on the service that didn't change. This script consults file
# mtimes against a marker, rebuilds only the services that actually have new
# source, restarts everything that wasn't rebuilt, and then runs migrations
# only if there are new SQL files since the last apply.
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
    \) -newer "$REBUILD_MARKER" -print -quit 2>/dev/null | grep -q .
}

services=()
if [ "$FORCE_ALL" = 1 ]; then
  services=(api web)
else
  # apps/api OR packages/shared change → rebuild api.
  # apps/web OR packages/shared change → rebuild web.
  # (shared is consumed by both apps, so a shared edit invalidates both.)
  api_changed=0
  web_changed=0
  needs_rebuild apps/api && api_changed=1
  needs_rebuild apps/web && web_changed=1
  if needs_rebuild packages/shared; then
    api_changed=1
    web_changed=1
  fi
  # Dockerfile or compose changes touch everything.
  if needs_rebuild infra || needs_rebuild apps/api/Dockerfile || needs_rebuild apps/web/Dockerfile; then
    api_changed=1
    web_changed=1
  fi
  [ "$api_changed" = 1 ] && services+=(api)
  [ "$web_changed" = 1 ] && services+=(web)
fi

if [ ${#services[@]} -eq 0 ]; then
  echo "==> No source changes detected since $(stat -c %y "$REBUILD_MARKER" 2>/dev/null || echo never)."
  echo "    Ensuring containers are running (no rebuild)."
  "${COMPOSE[@]}" up -d api web
else
  echo "==> Rebuilding: ${services[*]}"
  # DOCKER_BUILDKIT=1 is the modern default but force it for older daemons.
  DOCKER_BUILDKIT=1 "${COMPOSE[@]}" up -d --build "${services[@]}"
fi
touch "$REBUILD_MARKER"

if [ "$DO_MIGRATE" = 1 ]; then
  # Skip the migrate exec when nothing new is in migrations/. The script itself
  # is idempotent (it tracks applied entries in a DB table), so the worst-case
  # cost is one extra `docker compose exec` — but skipping shaves ~1s and keeps
  # the output cleaner when nothing's actually changed.
  if [ ! -f "$MIGRATE_MARKER" ] || find apps/api/migrations -name '*.sql' -newer "$MIGRATE_MARKER" -print -quit | grep -q .; then
    echo "==> Applying migrations"
    "${COMPOSE[@]}" exec api node dist/scripts/migrate.js
    touch "$MIGRATE_MARKER"
  else
    echo "==> Migrations: no new files since $(stat -c %y "$MIGRATE_MARKER")"
  fi
fi
