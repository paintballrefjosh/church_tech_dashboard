#!/usr/bin/env bash
#
# Backup and restore across a simulated cluster (tests/cluster/sim.sh up 3): resets the regression
# test user on node 1, then runs tests/cluster/backup-restore.mjs against the three nodes. The
# test restores over the data, so it only ever runs against the throwaway simulation.
#
#   tests/cluster/backup-restore.sh            (SCHEDULER=0 to skip the scheduled-backup wait)
set -uo pipefail
cd "$(dirname "$0")/../.."
HOST="${SIM_HOST:-$(hostname -I | awk '{print $1}')}"
url() { echo "http://$HOST:$((8200 + $1))"; }
tests/cluster/sim.sh in 1 bash scripts/compose.sh --prod exec -T api node dist/scripts/reset-test-user.js >/dev/null 2>&1 \
  || { echo "backup-restore: the simulated cluster is not running (tests/cluster/sim.sh up 3)" >&2; exit 2; }
docker run --rm --network=host -v "$PWD":/w -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e NODES="$(url 1),$(url 2),$(url 3)" -e SCHEDULER="${SCHEDULER:-1}" node:20-alpine node tests/cluster/backup-restore.mjs
