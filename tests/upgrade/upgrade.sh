#!/usr/bin/env bash
#
# scripts/upgrade.sh in throwaway git repos with a fake compose, fake cluster.sh and fake db-s3.sh: the order of
# the steps, what is left untouched when a step fails, the automatic rollback, --rollback, a cluster node's drain,
# and the refusals. No Docker stack is touched. (A real stack is covered by running the script on the dev stack.)
#   tests/upgrade/upgrade.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
pass=0; failn=0
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "  ok    $what"; else failn=$((failn + 1)); echo "  FAIL  $what"; fi; }

# A fake docker on PATH: `docker info` has no root dir (skips the space check), `image prune` succeeds.
mkdir -p "$W/bin"
cat >"$W/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in image) echo "Total reclaimed space: 0B" ;; esac
exit 0
EOF
chmod +x "$W/bin/docker"

FAKE_COMPOSE='#!/usr/bin/env bash
RUN="${FAKE_RUN:?}"
[[ "${1:-}" == "--prod" ]] && shift
echo "compose $*" >>"$RUN/calls"
case "$1" in
  --db-mode) echo bundled; exit 0 ;;
  --deploy-mode) echo "${DEPLOY_MODE:-single}"; exit 0 ;;
  ps) [[ -f "$RUN/running" ]] && echo abc123; exit 0 ;;
  build) [[ "${FAKE_BUILD:-}" == fail ]] && { echo "ERROR: web: Module not found" >&2; exit 1; }; exit 0 ;;
  run) [[ "${FAKE_MIGRATE:-}" == fail ]] && { echo "migration 0002 failed" >&2; exit 1; }; exit 0 ;;
  up) id="$(bash scripts/build-id.sh)"
      if [[ -n "${FAKE_BAD_ID:-}" && "$id" == "$FAKE_BAD_ID"* ]]; then echo broken >"$RUN/running"; else echo "$id" >"$RUN/running"; fi
      exit 0 ;;
  exec) shift; shift   # -T
        svc="$1"; shift
        if [[ "$1" == printenv ]]; then cat "$RUN/running"; exit 0; fi
        [[ "$(cat "$RUN/running")" == broken ]] && exit 1; exit 0 ;;
  restart|logs) exit 0 ;;
esac
exit 0'
FAKE_CLUSTER='#!/usr/bin/env bash
echo "cluster $*" >>"${FAKE_RUN:?}/calls"; echo "ok"; exit 0'
FAKE_DBS3='#!/usr/bin/env bash
echo "db-s3 $*" >>"${FAKE_RUN:?}/calls"; [[ "${FAKE_BACKUP:-}" == fail ]] && exit 1; exit 0'

# fresh: origin with one commit, a clone running it ("work"), and a second commit on origin that work is behind.
# $1 = extra change in the second commit: none | infra | env
fresh() {
  rm -rf "${W:?}/origin.git" "${W:?}/work" "${W:?}/dev" "${W:?}/run"; mkdir -p "$W/run"
  git init -q --bare -b master "$W/origin.git"
  git clone -q "$W/origin.git" "$W/dev" 2>/dev/null
  ( cd "$W/dev" && git config user.email t@t && git config user.name t
    mkdir -p scripts apps/api/migrations infra/caddy
    cp "$REPO/scripts/upgrade.sh" "$REPO/scripts/build-id.sh" scripts/
    printf '%s\n' "$FAKE_COMPOSE" >scripts/compose.sh; printf '%s\n' "$FAKE_CLUSTER" >scripts/cluster.sh; printf '%s\n' "$FAKE_DBS3" >scripts/db-s3.sh
    printf '/data/\n' >.gitignore; echo "select 1;" >apps/api/migrations/0001.sql; echo "A=1" >.env.example; echo x >infra/docker-compose.prod.yml; echo y >infra/caddy/Caddyfile
    git add -A && git commit -q -m "first" && git push -q origin master 2>/dev/null )
  git clone -q "$W/origin.git" "$W/work" 2>/dev/null
  ( cd "$W/work" && git config user.email t@t && git config user.name t; bash scripts/build-id.sh >"$W/run/running" )
  ( cd "$W/dev" || exit
    echo "select 2;" >apps/api/migrations/0002.sql
    [[ "${1:-}" == infra ]] && echo z >>infra/caddy/Caddyfile
    [[ "${1:-}" == env ]] && echo "NEW_SETTING=1" >>.env.example
    git add -A && git commit -q -m "add a thing" && git push -q origin master 2>/dev/null )
  OLD=$(git -C "$W/work" rev-parse HEAD); NEW=$(git -C "$W/dev" rev-parse HEAD)
}
up_() { # args; runs the script in work; output in $W/out, exit code in $W/rc
  ( cd "$W/work" && PATH="$W/bin:$PATH" FAKE_RUN="$W/run" UPGRADE_HEALTH_WAIT=3 bash scripts/upgrade.sh "$@" >"$W/out" 2>&1 ); echo $? >"$W/rc"
}
rc() { cat "$W/rc"; }
head_() { git -C "$W/work" rev-parse HEAD; }
calls() { cat "$W/run/calls" 2>/dev/null; }
running_id() { cat "$W/run/running"; }
state() { sed -n "s/^$1=//p" "$W/work/data/upgrade/state"; }

echo "== --check"
fresh env
up_ --prod --check
check "exits 0" test "$(rc)" = 0
check "lists the new commit" grep -q "add a thing" "$W/out"
check "counts one new migration" grep -q "migrations: 1 new" "$W/out"
check "warns about the new .env.example setting" grep -q "NEW_SETTING" "$W/out"
check "changes nothing" test "$(head_)" = "$OLD"
check "starts no build and no container" bash -c "! grep -qE 'compose (build|up|run)' <<<\"$(calls)\""

echo "== upgrade, single node"
fresh none
up_ --prod --yes
check "exits 0" test "$(rc)" = 0
check "fast-forwarded to the upstream commit" test "$(head_)" = "$NEW"
check "now runs the new build id" test "$(running_id)" = "$(git -C "$W/work" rev-parse --short=12 HEAD)"
check "backed up first" bash -c "grep -q 'db-s3 --prod backup' <<<\"$(calls)\""
seq=$(calls | grep -nE 'db-s3|compose build|compose run|compose up' | cut -d: -f2 | awk '{print $1" "$2}' | tr '\n' '|')
check "order: backup, build, migrate, up" bash -c "[[ '$seq' == db-s3*compose*build*compose*run*compose*up* ]]"
check "swaps only api web monitor (no database, no proxy)" bash -c "grep -q 'compose up -d --no-build --no-deps api web monitor' <<<\"$(calls)\" && ! grep -q 'restart proxy' <<<\"$(calls)\""
check "migrates with the new image in a one-off container" bash -c "grep -q 'compose run -T --rm --no-deps api node dist/scripts/migrate.js' <<<\"$(calls)\""
check "records the previous commit" test "$(state PREV_COMMIT)" = "$OLD"
check "does not drain a single node" bash -c "! grep -q cluster <<<\"$(calls)\""
up_ --prod --yes
check "a second run says it is up to date" grep -q "nothing to upgrade" "$W/out"

echo "== rollback"
up_ --prod --yes --rollback
check "exits 0" test "$(rc)" = 0
check "goes back to the previous commit" test "$(head_)" = "$OLD"
check "runs the old build again" test "$(running_id)" = "$(git -C "$W/work" rev-parse --short=12 HEAD)"
check "runs no migration going back" bash -c "! grep -q 'compose run' <<<\"$(calls | tail -n 6)\""
up_ --prod --yes
check "an upgrade from a detached head says how to get back" bash -c "grep -q 'HEAD is detached' '$W/out'"

echo "== build fails"
fresh none
FAKE_BUILD=fail up_ --prod --yes
check "exits non-zero" test "$(rc)" != 0
check "puts the code back" test "$(head_)" = "$OLD"
check "never migrates or swaps" bash -c "! grep -qE 'compose (run|up)' <<<\"$(calls)\""
check "the old version still runs" test "$(running_id)" = "$(git -C "$W/work" rev-parse --short=12 HEAD)"

echo "== migration fails"
fresh none
FAKE_MIGRATE=fail up_ --prod --yes
check "exits non-zero" test "$(rc)" != 0
check "puts the code back, swaps nothing" bash -c "[[ \$(git -C '$W/work' rev-parse HEAD) == $OLD ]] && ! grep -q 'compose up' <<<\"$(calls)\""

echo "== backup fails"
fresh none
FAKE_BACKUP=fail up_ --prod --yes
check "stops before changing anything" bash -c "[[ \$(git -C '$W/work' rev-parse HEAD) == $OLD ]] && ! grep -qE 'compose (build|run|up)' <<<\"$(calls)\""
fresh none
up_ --prod --yes --no-backup
check "--no-backup skips it" bash -c "! grep -q db-s3 <<<\"$(calls)\""

echo "== the new version is unhealthy"
fresh none
FAKE_BAD_ID="$(git -C "$W/dev" rev-parse --short=12 HEAD)" up_ --prod --yes
check "exits non-zero" test "$(rc)" != 0
check "went back to the previous commit by itself" test "$(head_)" = "$OLD"
check "the old build runs again" test "$(running_id)" = "$(git -C "$W/work" rev-parse --short=12 HEAD)"
check "says what happened" grep -q "previous version" "$W/out"

echo "== a cluster node"
fresh none
DEPLOY_MODE=cluster up_ --yes --drain-wait 0
check "exits 0" test "$(rc)" = 0
check "drains before the swap and undrains after it" bash -c "c=\"$(calls)\"; d=\$(grep -n 'cluster drain' <<<\"\$c\" | head -1 | cut -d: -f1); u=\$(grep -n 'compose up' <<<\"\$c\" | head -1 | cut -d: -f1); n=\$(grep -n 'cluster undrain' <<<\"\$c\" | head -1 | cut -d: -f1); [[ -n \$d && \$d -lt \$u && \$u -lt \$n ]]"
check "takes no backup by default" bash -c "! grep -q db-s3 <<<\"$(calls)\""
fresh none
DEPLOY_MODE=cluster up_ --yes --drain-wait 0 --backup
check "--backup takes one" bash -c "grep -q 'db-s3 --prod backup' <<<\"$(calls)\""
fresh none
DEPLOY_MODE=cluster FAKE_BAD_ID="$(git -C "$W/dev" rev-parse --short=12 HEAD)" up_ --yes --drain-wait 0
check "an unhealthy node is rolled back and put back into rotation" bash -c "[[ \$(git -C '$W/work' rev-parse HEAD) == $OLD ]] && grep -q 'cluster undrain' <<<\"$(calls)\""
fresh none
DEPLOY_MODE=cluster up_ --dev --yes
check "a cluster node refuses --dev" grep -q "always the prod stack" "$W/out"

echo "== infrastructure changed"
fresh infra
up_ --prod --yes
check "recreates what changed and restarts the proxy" bash -c "grep -q 'compose up -d --no-build$' <<<\"$(calls)\" && grep -q 'restart proxy' <<<\"$(calls)\""

echo "== refusals"
fresh none
echo "local edit" >>"$W/work/.env.example"; git -C "$W/work" add -A
up_ --prod --yes
check "uncommitted changes" bash -c "[[ \$(cat '$W/rc') != 0 ]] && grep -q 'uncommitted changes' '$W/out'"
git -C "$W/work" reset -q --hard
up_ --prod --to nonexistent-ref --yes
check "an unknown --to" grep -q "is not a commit" "$W/out"
up_ --prod --to "$NEW" --rollback
check "--to with --rollback" test "$(rc)" = 2
up_ --prod --rollback --yes
check "--rollback with nothing recorded" grep -q "nothing recorded" "$W/out"
rm -f "$W/run/running"
up_ --prod --yes
check "a stack that is not running" grep -q "not running" "$W/out"
up_ --yes
check "no stack running and none named" grep -q "cannot tell which stack" "$W/out"

echo
echo "passed: $pass, failed: $failn"
[[ $failn -eq 0 ]]
