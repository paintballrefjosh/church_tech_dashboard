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
# Usage: scripts/compose.sh [--prod] <docker compose args...>
#        scripts/compose.sh [--prod] --db-mode   # print the resolved mode
#        scripts/compose.sh [--prod] --db-url    # print the resolved DATABASE_URL
#
# Running docker compose by hand instead: export DATABASE_URL and, for the
# bundled database, add `--profile bundled-db`.

set -euo pipefail
cd "$(dirname "$0")/.."

FILE=infra/docker-compose.yml
if [[ "${1:-}" == "--prod" ]]; then
  FILE=infra/docker-compose.prod.yml
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
DB_MODE="${DB_MODE:-$(env_get DB_MODE)}"
DB_MODE="${DB_MODE:-bundled}"
DATABASE_URL="${DATABASE_URL:-$(env_get DATABASE_URL)}"
BUNDLED_URL="postgresql://root@cockroach-1:26257/church?sslmode=disable"

case "$DB_MODE" in
  bundled)
    if [[ -n "$DATABASE_URL" && "$DATABASE_URL" != *"@cockroach-1:"* ]]; then
      die "DB_MODE=bundled, but DATABASE_URL points somewhere else. Set DB_MODE=external to use that database, or remove DATABASE_URL."
    fi
    DATABASE_URL="$BUNDLED_URL"
    PROFILE="bundled-db"
    ;;
  external)
    [[ -n "$DATABASE_URL" ]] || die "DB_MODE=external needs DATABASE_URL in .env (e.g. postgresql://user:pass@yb-host:5433/church)."
    if [[ "$DATABASE_URL" == *"@cockroach-1:"* ]]; then
      die "DB_MODE=external, but DATABASE_URL points at the bundled cockroach-1. Use DB_MODE=bundled, or point DATABASE_URL at your database."
    fi
    PROFILE=""
    ;;
  *)
    die "DB_MODE must be 'bundled' or 'external' (got '$DB_MODE')."
    ;;
esac

if [[ "${1:-}" == "--db-mode" ]]; then
  echo "$DB_MODE"
  exit 0
fi
if [[ "${1:-}" == "--db-url" ]]; then
  echo "$DATABASE_URL"
  exit 0
fi

export DATABASE_URL
# Keep any profiles the caller already enabled.
profiles="${COMPOSE_PROFILES:-}"
if [[ -n "$PROFILE" ]]; then
  profiles="${profiles:+$profiles,}$PROFILE"
fi
export COMPOSE_PROFILES="$profiles"

exec docker compose -f "$FILE" "$@"
