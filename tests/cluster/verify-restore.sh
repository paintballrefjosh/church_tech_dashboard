#!/usr/bin/env bash
#
# Restore rehearsal: proves that a REAL backup can be restored, by restoring it into a throwaway cluster and
# checking the result against the file.
#
#   tests/cluster/verify-restore.sh                 take a fresh backup of the dev stack and rehearse with it
#   tests/cluster/verify-restore.sh --archive FILE  rehearse with a backup file you already have (a download)
#   options: --keep        leave the cluster running afterwards (a cluster this script started is removed otherwise)
#            --no-signin   skip signing in as the test user afterwards (a file that does not contain that user)
#
# What it does, in order:
#   1. (default) signs in to the LIVE dev stack as the regression test user, makes a backup (reads only), downloads it,
#      deletes it again, disables the test user. Nothing on the dev stack is changed.
#   2. uses the running simulated cluster (tests/cluster/sim.sh), or builds one (SIM_NODES, default 3) and removes it
#      at the end. The cluster has its own AUTH_SECRET and its own, different, data: the restore must replace all of it.
#   3. uploads the file to node 1 (the app checks every row count and file checksum), runs the stored-backup check
#      (the app's "Check" button), compares, and restores with the safety copy on.
#   4. watches the restore from inside the cluster (it replaces the account that asked, so the session ends), then
#      compares the database with the file on EVERY node with the app's own comparison: the result must be identical.
#   5. signs in as the restored test user and reads notes, tickets, wiki, checklists and monitors.
#
# Run it after a release, or monthly: `0 3 1 * * cd /path/to/church-dashboard && tests/cluster/verify-restore.sh`.
# It needs docker, the dev stack running (unless --archive), and a cluster built from the current source
# (`tests/cluster/sim.sh sync` then rebuild a node, or `down` and `up`). Never run it against anything but the
# throwaway cluster: the restore replaces everything in it.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
SIM="tests/cluster/sim.sh"
SIM_DIR="${SIM_DIR:-$HOME/church-sim}"
export SIM_DIR
HOST="${SIM_HOST:-$(hostname -I | awk '{print $1}')}"
export SIM_HOST="$HOST"
DEV_URL="${DEV_URL:-http://localhost:8100}"
NODES="${SIM_NODES:-3}"
ARCHIVE=""
KEEP=0
SIGNIN=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive) ARCHIVE="${2:?--archive needs a file}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --no-signin) SIGNIN=0; shift ;;
    -h|--help) sed -n '3,25p' "$0"; exit 0 ;;
    *) echo "verify-restore: unknown option $1" >&2; exit 2 ;;
  esac
done

say() { echo "== $*"; }
die() { echo "verify-restore: $*" >&2; exit 1; }
url() { echo "http://$HOST:$((8200 + $1))"; }
WORK="$(mktemp -d)"
STARTED=0
DEV_USER_ON=0

cleanup() {
  local code=$?
  [[ $DEV_USER_ON -eq 1 ]] && bash scripts/compose.sh exec -T api node dist/scripts/disable-test-user.js >/dev/null 2>&1
  if [[ $STARTED -eq 1 && $KEEP -eq 0 ]]; then say "removing the cluster this run built"; $SIM down >/dev/null 2>&1; fi
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT

# The HTTP steps run in a node container on the host network (no node on the host).
http_step() {
  local base="$1"; shift
  docker run --rm --network=host -v "$PWD":/w -v "$WORK":/work -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp \
    -e BASE="$base" -e OUT=/work/dev.tar.gz -e ARCHIVE=/work/archive.tar.gz node:20-alpine node tests/cluster/verify-restore.mjs "$@"
}
in_api() { local n="$1"; shift; $SIM in "$n" bash scripts/compose.sh --prod exec -T api "$@"; }

# ---- 1. the backup file
if [[ -z "$ARCHIVE" ]]; then
  say "taking a backup of the dev stack (reads only)"
  curl -fsS "$DEV_URL/api/v1/readyz" >/dev/null || die "the dev stack does not answer at $DEV_URL (start it, or pass --archive)"
  DEV_USER_ON=1
  bash scripts/compose.sh exec -T api node dist/scripts/reset-test-user.js >/dev/null || die "could not prepare the test user on the dev stack"
  http_step "$DEV_URL" fetch-dev || die "could not take the backup of the dev stack"
  mv "$WORK/dev.tar.gz" "$WORK/archive.tar.gz"
else
  [[ -f "$ARCHIVE" ]] || die "$ARCHIVE is not a file"
  cp "$ARCHIVE" "$WORK/archive.tar.gz"
fi
ls -l "$WORK/archive.tar.gz" | awk '{print "  " $5 " bytes"}'

# ---- 2. the throwaway cluster
if [[ ! -d "$SIM_DIR/node1" ]]; then
  say "building a $NODES-node throwaway cluster (several minutes)"
  $SIM up "$NODES" >"$WORK/sim-up.log" 2>&1 || { tail -n 30 "$WORK/sim-up.log" >&2; die "the cluster did not start"; }
  STARTED=1
fi
in_api 1 test -f dist/scripts/rehearse-restore.js 2>/dev/null \
  || die "the cluster was built from older source (no rehearse-restore helper): tests/cluster/sim.sh down, then run this again"
NODE_DIRS=$(ls -d "$SIM_DIR"/node* | wc -l)
say "using the cluster in $SIM_DIR ($NODE_DIRS nodes), node 1 is $(url 1)"
in_api 1 node dist/scripts/reset-test-user.js >/dev/null || die "could not prepare the test user in the cluster"

# ---- 3. upload, check, compare, restore
say "uploading, checking, comparing and starting the restore on node 1"
OUTPUT="$(http_step "$(url 1)" restore)" || { echo "$OUTPUT" >&2; die "the restore could not be started"; }
echo "$OUTPUT" | grep -v '^OPERATION '
OP="$(echo "$OUTPUT" | sed -n 's/^OPERATION \([0-9a-f-]*\)$/\1/p')"
[[ -n "$OP" ]] || die "no restore operation id came back"

# ---- 4. watch it from the inside, then compare every node with the file
say "restoring (watching the operation inside the cluster)"
for ((i = 0; i < 600; i++)); do
  ROW="$(in_api 1 node dist/scripts/rehearse-restore.js operation "$OP" 2>/dev/null | tail -n 1)"
  STATUS="$(echo "$ROW" | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p')"
  [[ "$STATUS" == "succeeded" || "$STATUS" == "failed" || "$STATUS" == "missing" ]] && break
  sleep 3
done
echo "  $ROW" | cut -c1-400
[[ "$STATUS" == "succeeded" ]] || die "the restore did not succeed ($STATUS)"

FAILED=0
for ((n = 1; n <= NODE_DIRS; n++)); do
  in_api "$n" sh -c 'cat > /tmp/rehearsal.tar.gz' <"$WORK/archive.tar.gz"
  RESULT="$(in_api "$n" node dist/scripts/rehearse-restore.js diff /tmp/rehearsal.tar.gz 2>"$WORK/diff-err.log" | tail -n 1)"
  if echo "$RESULT" | grep -q '"identical":true' && echo "$RESULT" | grep -q '"compatible":true'; then
    TABLES="$(echo "$RESULT" | sed -n 's/.*"tablesCompared":\([0-9]*\).*/\1/p')"
    echo "  node $n: identical to the file ($TABLES tables compared)"
  else
    FAILED=1
    echo "  node $n: DIFFERS FROM THE FILE: ${RESULT:-no answer}" | cut -c1-1500
    head -n 5 "$WORK/diff-err.log" >&2
  fi
  in_api "$n" rm -f /tmp/rehearsal.tar.gz
done
[[ $FAILED -eq 0 ]] || die "the restored data does not match the backup"

# ---- 5. the restored site works
if [[ $SIGNIN -eq 1 ]]; then
  say "signing in to the restored site"
  http_step "$(url 1)" answers || die "the restored site did not answer as expected"
fi
say "OK: a real backup was restored into a different cluster and matches the file on every node"
