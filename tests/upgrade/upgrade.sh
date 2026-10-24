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

# A fake docker on PATH: `docker info` has no root dir (skips the space check), the prunes succeed (and are recorded).
mkdir -p "$W/bin"
cat >"$W/bin/docker" <<'EOF'
#!/usr/bin/env bash
[[ -n "${FAKE_RUN:-}" ]] && echo "docker $*" >>"$FAKE_RUN/dockercalls"
# A fake registry: $FAKE_RUN/published/<ref> holds the build id the published image claims; `pull` copies it to
# $FAKE_RUN/img.<ref> (the local store), which `image inspect` reads. Refs have / and : turned into _.
safe() { printf "%s" "$1" | tr "/:" "__"; }
case "$1" in
  image) case "$2" in
           inspect) f="$FAKE_RUN/img.$(safe "${!#}")"; [[ -f "$f" ]] || exit 1; echo "BUILD_ID=$(cat "$f")"; echo "NODE_ENV=production"; exit 0 ;;
           *) echo "Total reclaimed space: 0B" ;;
         esac ;;
  pull) f="$FAKE_RUN/published/$(safe "$2")"; [[ -f "$f" ]] || { echo "Error response from daemon: manifest for $2 not found" >&2; exit 1; }
        cp "$f" "$FAKE_RUN/img.$(safe "$2")"; echo "pulled $2" ;;
  tag) f="$FAKE_RUN/img.$(safe "$2")"; [[ -f "$f" ]] || exit 1; cp "$f" "$FAKE_RUN/img.$(safe "$3")" ;;
  builder) [[ "${FAKE_PRUNE:-}" == fail ]] && { echo "prune failed" >&2; exit 1; } ;;
esac
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
  config) printf "name: t\nservices:\n  api:\n    image: church-prod-api\n    build:\n      context: /x\n  monitor:\n    image: church-prod-monitor\n  web:\n    image: church-prod-web\nvolumes: {}\n"; exit 0 ;;
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

echo "== more than 15 new commits (head closing the pipe must not fail the run)"
fresh none
( cd "$W/dev" && for i in $(seq 1 20); do git commit -q --allow-empty -m "change $i"; done && git push -q origin master 2>/dev/null )
up_ --prod --check
check "exits 0" test "$(rc)" = 0
check "lists 15 and counts the rest" grep -q "and 6 more" "$W/out"
up_ --prod --yes
check "upgrades" test "$(rc)" = 0
up_ --prod --yes --rollback
check "rolling back across them exits 0" test "$(rc)" = 0

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

echo "== tidying Docker's disk use after an upgrade"
dcalls() { cat "$W/run/dockercalls" 2>/dev/null; }
fresh none
up_ --prod --yes
check "removes dangling images and trims the build cache by default" bash -c "grep -q 'docker image prune -f' <<<\"$(dcalls)\" && grep -q 'docker builder prune -f --keep-storage 10GB' <<<\"$(dcalls)\""
check "never removes volumes or tagged images" bash -c "! grep -qE 'volume|system prune|image prune -a|rmi' <<<\"$(dcalls)\""
fresh none
up_ --prod --yes --no-prune
check "--no-prune leaves them alone" bash -c "[[ $(rc) == 0 ]] && ! grep -q prune <<<\"$(dcalls)\""
fresh none
FAKE_PRUNE=fail up_ --prod --yes
check "a prune that fails does not fail the upgrade" test "$(rc)" = 0
fresh none
FAKE_BUILD=fail up_ --prod --yes
check "a failed upgrade prunes nothing" bash -c "[[ $(rc) != 0 ]] && ! grep -q prune <<<\"$(dcalls)\""

echo "== the checkout is on the target but the containers run an older build (git pull builds nothing)"
fresh none
git -C "$W/work" pull -q origin master 2>/dev/null
check "the checkout is on the new commit" test "$(head_)" = "$NEW"
up_ --prod --status
check "--status says stale and names the running build" bash -c "[[ \$(tail -n 1 '$W/out') == \"stale $(running_id)\" ]]"
check "--status builds nothing" bash -c "! grep -qE 'compose (build|up|run)' <<<\"$(calls)\""
up_ --prod --yes
check "it is not called up to date: exits 0 and builds" bash -c "[[ $(rc) == 0 ]] && grep -q 'compose build' <<<\"$(calls)\" && grep -q 'containers run build' '$W/out'"
check "now runs the checkout's build" test "$(running_id)" = "$(git -C "$W/work" rev-parse --short=12 HEAD)"
up_ --prod --status
check "--status now says current" bash -c "[[ \$(tail -n 1 '$W/out') == current ]]"
fresh none
up_ --prod --yes
echo oldbuild >"$W/run/running"
up_ --prod --yes
check "a rebuild of the same commit keeps the real rollback target" test "$(state PREV_COMMIT)" = "$OLD"

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

echo "== images from a registry (IMAGE_REGISTRY)"
REG=ghcr.io/o/church
publish() { # build id [the id the image claims, if it should be wrong]
  mkdir -p "$W/run/published"
  local s; for s in api web monitor; do printf '%s' "${2:-$1}" >"$W/run/published/$(printf '%s' "$REG-$s:$1" | tr '/:' '__')"; done
}
newid() { git -C "$W/dev" rev-parse --short=12 HEAD; }
oldid() { git -C "$W/dev" rev-parse --short=12 "$OLD"; }
dcl() { cat "$W/run/dockercalls" 2>/dev/null; }
fresh none; publish "$(newid)"
IMAGE_REGISTRY=$REG up_ --prod --yes
check "exits 0" test "$(rc)" = 0
check "pulls all three images for the new build id" bash -c "[[ \$(grep -c '^docker pull $REG-.*:$(newid)\$' '$W/run/dockercalls') == 3 ]]"
check "builds nothing" bash -c "! grep -q 'compose build' '$W/run/calls'"
check "tags each pulled image with the name compose uses" bash -c "grep -q 'docker tag $REG-api:$(newid) church-prod-api' '$W/run/dockercalls' && grep -q 'docker tag $REG-web:$(newid) church-prod-web' '$W/run/dockercalls' && grep -q 'docker tag $REG-monitor:$(newid) church-prod-monitor' '$W/run/dockercalls'"
check "migrates and swaps as before" bash -c "grep -q 'compose run -T --rm --no-deps api node dist/scripts/migrate.js' '$W/run/calls' && grep -q 'compose up -d --no-build --no-deps api web monitor' '$W/run/calls'"
check "now runs the new build" test "$(running_id)" = "$(newid)"
fresh none; publish "$(newid)"
echo .env >>"$W/work/.git/info/exclude"   # as in the real repo, where .env is ignored (an untracked file changes the build id)
echo "IMAGE_REGISTRY=$REG/" >>"$W/work/.env"
up_ --prod --yes
check "IMAGE_REGISTRY from .env (a trailing slash is ignored)" bash -c "[[ \$(cat '$W/rc') == 0 ]] && grep -q '^docker pull $REG-api:$(newid)\$' '$W/run/dockercalls'"

fresh none
IMAGE_REGISTRY=$REG up_ --prod --yes
check "not published: falls back to building, and says so" bash -c "[[ \$(cat '$W/rc') == 0 ]] && grep -q 'compose build' '$W/run/calls' && grep -q 'falling back to building' '$W/out' && grep -q 'could not pull' '$W/out'"
check "nothing is tagged from a partial pull" bash -c "! grep -q 'docker tag' '$W/run/dockercalls'"
fresh none
IMAGE_REGISTRY=$REG up_ --prod --yes --pull
check "--pull fails instead of building" bash -c "[[ \$(cat '$W/rc') != 0 ]] && ! grep -q 'compose build' '$W/run/calls'"
check "--pull puts the code back and swaps nothing" bash -c "[[ \$(git -C '$W/work' rev-parse HEAD) == $OLD ]] && ! grep -qE 'compose (run|up)' '$W/run/calls'"
fresh none; publish "$(newid)" "not-this-build"
IMAGE_REGISTRY=$REG up_ --prod --yes
check "an image that claims another build id is not used" bash -c "grep -q 'not using it' '$W/out' && ! grep -q 'docker tag' '$W/run/dockercalls'"
check "... the node builds instead and still upgrades" bash -c "[[ \$(cat '$W/rc') == 0 ]] && grep -q 'compose build' '$W/run/calls'"
fresh none; publish "$(newid)"
IMAGE_REGISTRY=$REG up_ --prod --yes --build
check "--build ignores the registry" bash -c "[[ \$(cat '$W/rc') == 0 ]] && ! grep -q 'docker pull' '$W/run/dockercalls' && grep -q 'compose build' '$W/run/calls'"
fresh none; publish "$(newid)"
cp "$W/run/published/$(printf '%s' "$REG-api:$(newid)" | tr '/:' '__')" "$W/run/img.$(printf '%s' "$REG-api:$(newid)" | tr '/:' '__')"
IMAGE_REGISTRY=$REG up_ --prod --yes
check "an image already on the node is not pulled again" bash -c "! grep -q 'docker pull $REG-api:' '$W/run/dockercalls' && grep -q 'docker pull $REG-web:' '$W/run/dockercalls'"
fresh none; publish "$(newid)"
echo .env >>"$W/work/.git/info/exclude"; echo "API_IMAGE=somewhere/api:1" >>"$W/work/.env"
IMAGE_REGISTRY=$REG up_ --prod --yes
check "API_IMAGE together with IMAGE_REGISTRY is refused before anything changes" bash -c "[[ \$(cat '$W/rc') != 0 ]] && grep -q 'two ways of choosing the images' '$W/out' && [[ \$(git -C '$W/work' rev-parse HEAD) == $OLD ]]"
fresh none
up_ --prod --yes --pull
check "--pull without a registry is refused" grep -q "needs IMAGE_REGISTRY" "$W/out"
fresh none
IMAGE_REGISTRY='bad registry;rm' up_ --prod --yes
check "a registry prefix with odd characters is refused" grep -q "is not a registry prefix" "$W/out"
fresh none; publish "$(newid)"
IMAGE_REGISTRY=$REG up_ --prod --check
check "--check says where the images come from and pulls nothing" bash -c "grep -q 'pulled from' '$W/out' && ! grep -q 'docker pull' '$W/run/dockercalls'"
fresh none
up_ --prod --check
check "without a registry the plan says images are built here" grep -q "built on this node" "$W/out"

fresh none; publish "$(newid)"; publish "$(oldid)"
IMAGE_REGISTRY=$REG up_ --prod --yes
IMAGE_REGISTRY=$REG up_ --prod --yes --rollback
check "--rollback pulls the older version's images when they are published" bash -c "[[ \$(cat '$W/rc') == 0 ]] && grep -q '^docker pull $REG-api:$(oldid)\$' '$W/run/dockercalls' && [[ \$(grep -c 'compose build' '$W/run/calls') == 0 ]]"
check "... and runs the old build" test "$(running_id)" = "$(oldid)"
fresh none; publish "$(newid)"
IMAGE_REGISTRY=$REG up_ --prod --yes
IMAGE_REGISTRY=$REG up_ --prod --yes --rollback
check "--rollback to an unpublished version builds it" bash -c "[[ \$(cat '$W/rc') == 0 ]] && grep -q 'compose build' '$W/run/calls' && [[ \$(tail -c 300 '$W/out') == *'falling back'* || \$(grep -c 'falling back' '$W/out') -ge 1 ]]"
fresh none; publish "$(newid)"; publish "$(oldid)"
IMAGE_REGISTRY=$REG FAKE_BAD_ID="$(newid)" up_ --prod --yes
check "an unhealthy new version goes back to the old images (pulled)" bash -c "[[ \$(cat '$W/rc') != 0 ]] && [[ \$(git -C '$W/work' rev-parse HEAD) == $OLD ]] && grep -q '^docker pull $REG-api:$(oldid)\$' '$W/run/dockercalls' && grep -q 'previous version' '$W/out'"

echo "== colour"
fresh none
( cd "$W/work" && PATH="$W/bin:$PATH" FAKE_RUN="$W/run" UPGRADE_HEALTH_WAIT=3 UPGRADE_COLOR=always bash scripts/upgrade.sh --prod --yes >"$W/out" 2>&1 )
ESC=$'\033'
check "UPGRADE_COLOR=always colours the screen output" grep -q "$ESC\\[" "$W/out"
check "the log file has no escape codes" bash -c "! grep -q \$'\\033' \"$W\"/work/data/upgrade/upgrade-*.log && grep -q 'Done in' \"$W\"/work/data/upgrade/upgrade-*.log"
fresh none
( cd "$W/work" && PATH="$W/bin:$PATH" FAKE_RUN="$W/run" UPGRADE_HEALTH_WAIT=3 bash scripts/upgrade.sh --prod --check >"$W/out" 2>&1 )
check "no escape codes when not on a terminal" bash -c "! grep -q \$'\\033' \"$W/out\""

echo
echo "passed: $pass, failed: $failn"
[[ $failn -eq 0 ]]
