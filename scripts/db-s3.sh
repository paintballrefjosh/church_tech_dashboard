#!/usr/bin/env bash
#
# Back up and restore the bundled CockroachDB through the object store, so a backup is
# not tied to one node's disk: any node (or a rebuilt one) can restore it.
#
#   scripts/db-s3.sh backup                  full backup of the church database
#   scripts/db-s3.sh list                    the backups in the store
#   scripts/db-s3.sh restore [--confirm]     replace the church database with the latest backup
#   scripts/db-s3.sh --prod ...              the prod stack
#
# Backups go to s3://<bucket>/db-backups/ in the same store as the uploaded files (the
# bundled Garage, or the S3_* store). Uses the same settings as the app.
# Not for DB_MODE=external: back an external database up with its own tooling.
#
# restore stops the api, web and monitor, restores into a copy, and only once that has
# succeeded drops church and renames the copy into place (a failed restore leaves church
# untouched), then starts them again. If there is no church database yet (a fresh cluster)
# it restores straight into place. Without --confirm it only says what it would do.
#
# In a cluster (DEPLOY_MODE=cluster) the SQL runs on this node's own database member, over its
# certificates. A restore replaces the database for every node, so it refuses to run while
# another node's application is still up: stop api, web and monitor on all the other nodes
# first, run the restore on one node, then start them again. Afterwards run
# the restored database is handed to the app's database user. A backup made on a single-node
# install restores into a cluster the same way (restore it on one node once the cluster's
# object store holds the backup: INSTALL.md, "Converting a single node install").
#
# DB_S3_CONTAINER=<name> runs the SQL in that Cockroach container instead of the stack's
# cockroach-1, and leaves api/web/monitor alone: for trying a restore on a throwaway
# database (this is how the script is tested) without touching the real one.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD=()
CMD=""
CONFIRM=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prod) PROD=(--prod); shift ;;
    --confirm) CONFIRM=yes; shift ;;
    backup|list|restore) CMD="$1"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$CMD" ]] || { echo "usage: scripts/db-s3.sh [--prod] backup|list|restore [--confirm]" >&2; exit 2; }
die() { echo "db-s3: $*" >&2; exit 1; }

COMPOSE=(bash scripts/compose.sh "${PROD[@]}")
DEPLOY="$("${COMPOSE[@]}" --deploy-mode)"
[[ "$("${COMPOSE[@]}" --db-mode)" == external ]] && die "DB_MODE=external: back the database up with its own tooling (ysql_dump / cockroach BACKUP)."

env_get() {
  [[ -f .env ]] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | sed -E 's/[[:space:]]+#.*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}
get() { local v="${!1:-}"; [[ -n "$v" ]] || v="$(env_get "$1")"; printf '%s' "$v"; }
urlenc() {
  local s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in [a-zA-Z0-9.~_-]) out+="$c" ;; *) out+="$(printf '%%%02X' "'$c")" ;; esac
  done
  printf '%s' "$out"
}

# The store the app uses now (the bundled Garage with its derived keys, or the external one).
# compose.sh fails with a clear message if S3_MODE / S3_ENDPOINT are inconsistent.
s3env() { "${COMPOSE[@]}" --s3-env | sed -n "s/^$1=//p"; }
ENDPOINT="$(s3env S3_ENDPOINT)"
case "$ENDPOINT" in http://*|https://*) ;; *) ENDPOINT="http://$ENDPOINT" ;; esac
AK="$(s3env S3_ACCESS_KEY)"; SK="$(s3env S3_SECRET_KEY)"; REGION="$(s3env S3_REGION)"; BUCKET="$(s3env S3_BUCKET)"
[[ -n "$AK" && -n "$SK" ]] || die "no S3 credentials (is AUTH_SECRET set in .env, or S3_ACCESS_KEY / S3_SECRET_KEY for an external store?)"

URI="s3://${BUCKET}/db-backups?AWS_ACCESS_KEY_ID=$(urlenc "$AK")&AWS_SECRET_ACCESS_KEY=$(urlenc "$SK")&AWS_ENDPOINT=$(urlenc "$ENDPOINT")&AWS_REGION=$(urlenc "$REGION")"
sql() {
  if [[ -n "${DB_S3_CONTAINER:-}" ]]; then docker exec -i "$DB_S3_CONTAINER" cockroach sql --insecure "$@"
  elif [[ "$DEPLOY" == cluster ]]; then "${COMPOSE[@]}" exec -T cockroach cockroach sql --certs-dir=/certs --host=127.0.0.1:26257 "$@"
  else "${COMPOSE[@]}" exec -T cockroach-1 cockroach sql --insecure "$@"; fi
}
# A restore is run as root, so the restored tables belong to root. In a cluster the app signs in
# as its own user (`church`), so hand the database and its tables over to it.
hand_over() {
  [[ "$DEPLOY" == cluster && -z "${DB_S3_CONTAINER:-}" ]] || return 0
  sql -e "ALTER DATABASE church OWNER TO church" >/dev/null
  sql --database=church -e "REASSIGN OWNED BY root TO church" >/dev/null
}
# Cluster: application nodes other than this one that have checked in within the last 30 s.
other_nodes_running() {
  [[ "$DEPLOY" == cluster && -z "${DB_S3_CONTAINER:-}" ]] || { echo 0; return; }
  local me; me="$("${COMPOSE[@]}" --cluster-env | sed -n 's/^NODE_ID=//p')"
  sql --format=csv --database=church -e "SELECT count(*) FROM cluster_nodes WHERE role = 'full' AND id <> '$me' AND last_seen > now() - interval '30 seconds'" 2>/dev/null | tail -n 1
}
services() { [[ -n "${DB_S3_CONTAINER:-}" ]] || "${COMPOSE[@]}" "$@"; }

case "$CMD" in
  backup)
    echo "backing up church to s3://$BUCKET/db-backups (via $ENDPOINT) ..."
    sql -e "BACKUP DATABASE church INTO '$URI'" | sed -E 's/(AWS_SECRET_ACCESS_KEY=)[^&]*/\1xxxx/'
    echo "done. List them with: scripts/db-s3.sh ${PROD[*]:-} list"
    ;;
  list)
    sql --format=table -e "SHOW BACKUPS IN '$URI'" | sed -E 's/(AWS_SECRET_ACCESS_KEY=)[^&]*/\1xxxx/'
    ;;
  restore)
    have_db="$(sql --format=csv -e "SELECT count(*) FROM [SHOW DATABASES] WHERE database_name = 'church'" | tail -n 1)"
    if [[ "$CONFIRM" != yes ]]; then
      if [[ "$have_db" == 1 ]]; then
        echo "This DROPS the current church database and replaces it with the latest backup in s3://$BUCKET/db-backups."
      else
        echo "There is no church database here: this restores the latest backup in s3://$BUCKET/db-backups into place."
      fi
      echo "Re-run with --confirm to go ahead."
      exit 1
    fi
    if [[ "$have_db" != 1 ]]; then
      sql -e "RESTORE DATABASE church FROM LATEST IN '$URI'" | sed -E 's/(AWS_SECRET_ACCESS_KEY=)[^&]*/\1xxxx/'
      hand_over
      echo "restored church (there was none)."
      exit 0
    fi
    others="$(other_nodes_running)"
    if [[ "$others" =~ ^[1-9][0-9]*$ ]]; then
      die "$others other node(s) still have the application running. Stop api, web and monitor on every other node first (scripts/compose.sh --prod stop api web monitor), then run the restore on one node."
    fi
    services stop api web monitor
    status=0
    sql -e "DROP DATABASE IF EXISTS church_restoring CASCADE" \
        -e "RESTORE DATABASE church FROM LATEST IN '$URI' WITH new_db_name = 'church_restoring'" \
        -e "DROP DATABASE IF EXISTS church CASCADE" \
        -e "ALTER DATABASE church_restoring RENAME TO church" | sed -E 's/(AWS_SECRET_ACCESS_KEY=)[^&]*/\1xxxx/' || status=$?
    [[ $status -ne 0 ]] || hand_over || status=$?
    services start api web monitor
    [[ $status -eq 0 ]] || die "restore failed; the church database was not replaced"
    echo "restored church from the latest backup."
    [[ "$DEPLOY" == cluster ]] && echo "In a cluster, start the application again on every other node too (scripts/cluster.sh up)."
    ;;
esac
