#!/usr/bin/env bash
#
# Upgrade this node to a newer version of the dashboard with as little downtime and as little risk as
# possible. Run it on the machine (each node of a cluster, one at a time), from anywhere inside the checkout.
#
#   scripts/upgrade.sh                  upgrade to the newest commit of this branch's upstream
#   scripts/upgrade.sh --check          show what would change, touch nothing
#   scripts/upgrade.sh --to <ref>       upgrade (or move) to a commit, tag or branch
#   scripts/upgrade.sh --rollback       go back to the version this node ran before the last upgrade
#
#   --prod | --dev       which stack to upgrade (default: the one that is running; a cluster is always prod)
#   --backup | --no-backup
#                        take a database backup first (bundled database; default: yes on a single node, no in
#                        a cluster, where one backup before the FIRST node is enough: run --backup there)
#   --drain-wait <sec>   cluster: how long to wait after draining before the app is restarted (default 15)
#   --prune              afterwards remove dangling images left by the builds
#   --yes                do not ask for confirmation
#
# What it does, in this order, and why:
#   1. Looks first: fetches, lists the commits, the new migrations and the new .env.example settings, and stops
#      if there is nothing to do or the working tree has local changes (nothing is changed yet).
#   2. Builds the new images WHILE THE OLD VERSION KEEPS SERVING. This is the slow part (minutes) and it costs no
#      downtime. A failed build puts the code back and leaves the running site untouched.
#   3. Migrates with the new image before anything is swapped. Migrations must work with the previous release
#      (expand/contract, see CLAUDE.md), so the old containers keep working while it runs, and the new ones find
#      the schema they need the moment they start.
#   4. Swaps only the api, web and monitor containers (and the proxy or other services only if their
#      configuration changed): the databases and the object store are not restarted. In a cluster the node is
#      drained first and put back only once it is healthy and running the new build.
#   5. Checks that the new containers are healthy and run the new build id. If not, it goes back to the previous
#      version by itself (the migrations are not undone, which is safe because they are additive).
#
# State and logs are in data/upgrade/ (git-ignored). --rollback uses the commit recorded there.
set -euo pipefail
cd "$(dirname "$0")/.."

CHECK=0 ROLLBACK=0 YES=0 PRUNE=0 TO="" STACK="" BACKUP="" DRAIN_WAIT=15
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --to) TO="${2:?--to needs a commit, tag or branch}"; shift 2 ;;
    --prod) STACK=prod; shift ;;
    --dev) STACK=dev; shift ;;
    --backup) BACKUP=yes; shift ;;
    --no-backup) BACKUP=no; shift ;;
    --drain-wait) DRAIN_WAIT="${2:?--drain-wait needs a number of seconds}"; shift 2 ;;
    --prune) PRUNE=1; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "upgrade.sh: unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
[[ "$DRAIN_WAIT" =~ ^[0-9]+$ ]] || { echo "upgrade.sh: --drain-wait must be a number of seconds" >&2; exit 2; }
[[ -z "$TO" || $ROLLBACK -eq 0 ]] || { echo "upgrade.sh: use either --to or --rollback" >&2; exit 2; }

if [[ -t 1 ]]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; Z=$'\033[0m'; else B=""; G=""; Y=""; R=""; Z=""; fi
say()  { printf '%s\n' "$*"; }
head1() { printf '\n%s==> %s%s\n' "$B" "$*" "$Z"; }
ok()   { printf '%s  ok%s  %s\n' "$G" "$Z" "$*"; }
warn() { printf '%s  !!%s  %s\n' "$Y" "$Z" "$*" >&2; }
die()  { printf '%supgrade.sh: %s%s\n' "$R" "$*" "$Z" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is needed."
command -v docker >/dev/null 2>&1 || die "docker is needed."
git rev-parse --git-dir >/dev/null 2>&1 || die "this is not a git checkout, so there is nothing to upgrade from. Use install.sh for a fresh install."

STATE_DIR=data/upgrade
mkdir -p "$STATE_DIR"
STATE="$STATE_DIR/state"
state_get() { [[ -f "$STATE" ]] && sed -n "s/^$1=//p" "$STATE" | tail -n 1 || true; }

# ---- one upgrade at a time, and a log of this one --------------------------------------------------
if (( CHECK == 0 )); then
  exec 9>"$STATE_DIR/lock"
  command -v flock >/dev/null 2>&1 && { flock -n 9 || die "another upgrade is running on this node."; }
  LOG="$STATE_DIR/upgrade-$(date +%Y%m%d-%H%M%S).log"
  exec > >(tee -a "$LOG") 2>&1
  say "log: $LOG"
fi

# ---- which stack ------------------------------------------------------------------------------------
conf_env() { [[ -f .env ]] && sed -n "s/^$1=//p" .env | tail -n 1 | sed -E 's/[[:space:]]+#.*$//; s/^"(.*)"$/\1/' || true; }
DEPLOY_MODE="${DEPLOY_MODE:-$(conf_env DEPLOY_MODE)}"; DEPLOY_MODE="${DEPLOY_MODE:-single}"
NODE_ROLE="${NODE_ROLE:-$(conf_env NODE_ROLE)}"; NODE_ROLE="${NODE_ROLE:-full}"
if [[ "$DEPLOY_MODE" == cluster ]]; then
  [[ -z "$STACK" || "$STACK" == prod ]] || die "a cluster node is always the prod stack."
  STACK=prod
fi
if [[ -z "$STACK" ]]; then
  p="$(bash scripts/compose.sh --prod ps -q api 2>/dev/null | head -n 1 || true)"
  d="$(bash scripts/compose.sh ps -q api 2>/dev/null | head -n 1 || true)"
  if   [[ -n "$p" && -z "$d" ]]; then STACK=prod
  elif [[ -z "$p" && -n "$d" ]]; then STACK=dev
  else die "cannot tell which stack to upgrade (${p:+prod and }${d:+dev }running: ${p:-}${d:-nothing}). Say --prod or --dev."; fi
fi
if [[ "$STACK" == prod ]]; then DC=(bash scripts/compose.sh --prod); else DC=(bash scripts/compose.sh); fi
[[ "$NODE_ROLE" == full ]] || die "this node only runs the database and object store (NODE_ROLE=data): there is no app here to upgrade. Pull the new code and follow INSTALL.md."
DB_MODE="$("${DC[@]}" --db-mode 2>/dev/null || echo bundled)"
say "stack: $STACK ($DEPLOY_MODE), database: $DB_MODE"

dc() { "${DC[@]}" "$@"; }
running() { [[ -n "$(dc ps -q api 2>/dev/null | head -n 1)" ]]; }

# ---- pick the target ------------------------------------------------------------------------------
BRANCH="$(git symbolic-ref --short -q HEAD || true)"
OLD="$(git rev-parse HEAD)"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  git status --short --untracked-files=no | head -n 10 >&2
  die "the working tree has uncommitted changes (above). Commit or stash them: an upgrade must run exactly the version it names, and every node of a cluster must run the same one."
fi
[[ -z "$(git ls-files -o --exclude-standard | head -n 1)" ]] || warn "untracked files are present; they change the build id, so this node's build will differ from a clean checkout of the same commit."

if (( ROLLBACK )); then
  TARGET="$(state_get PREV_COMMIT)"
  [[ -n "$TARGET" ]] || die "nothing recorded to roll back to ($STATE). Use --to <commit> to move to a specific version."
  git rev-parse --verify -q "$TARGET^{commit}" >/dev/null || die "the recorded commit $TARGET is not in this checkout any more. Use --to <commit>."
elif [[ -n "$TO" ]]; then
  git fetch --quiet --tags origin 2>/dev/null || warn "could not reach the remote; using what is already here."
  TARGET="$(git rev-parse --verify -q "$TO^{commit}" || git rev-parse --verify -q "origin/$TO^{commit}" || true)"
  [[ -n "$TARGET" ]] || die "'$TO' is not a commit, tag or branch this checkout knows."
else
  if [[ -z "$BRANCH" ]]; then
    prev="$(state_get BRANCH)"
    die "HEAD is detached (a rollback leaves it so). Return to your branch first: git checkout ${prev:-<branch>} -- or name a version with --to."
  fi
  git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || die "branch '$BRANCH' has no upstream. Use --to <ref>."
  git fetch --quiet --tags origin || die "cannot reach the remote to look for a newer version."
  TARGET="$(git rev-parse '@{u}')"
  git merge-base --is-ancestor "$OLD" "$TARGET" || die "this checkout has commits the upstream does not (or the history was rewritten), so it cannot fast-forward. Resolve that by hand, or name a version with --to."
fi

short() { git rev-parse --short=12 "$1"; }
if [[ "$TARGET" == "$OLD" ]]; then
  if running; then ok "already on $(short "$OLD"); nothing to upgrade."; exit 0; fi
  warn "already on $(short "$OLD") but the stack is not running."
fi

BACK=0; git merge-base --is-ancestor "$TARGET" "$OLD" 2>/dev/null && BACK=1

# ---- the plan ---------------------------------------------------------------------------------------
head1 "$(short "$OLD") -> $(short "$TARGET")$( ((BACK)) && echo '  (moving BACK to an older version)')"
if (( BACK )); then
  git log --oneline --no-decorate "$TARGET..$OLD" | head -n 15 | sed 's/^/  - removes: /'
else
  git log --oneline --no-decorate "$OLD..$TARGET" | head -n 15 | sed 's/^/  + /'
  n=$(git rev-list --count "$OLD..$TARGET"); (( n > 15 )) && say "  ... and $((n - 15)) more"
fi
NEWMIG="$(git diff --name-only --diff-filter=A "$OLD" "$TARGET" -- apps/api/migrations | grep -c '\.sql$' || true)"
if (( BACK )); then
  say "  migrations: none are undone; the older code runs against the newer schema (they are additive)."
else
  say "  migrations: ${NEWMIG:-0} new"
fi
NEWENV="$(git diff "$OLD" "$TARGET" -- .env.example | grep -E '^\+#? ?[A-Z][A-Z0-9_]*=' | sed -E 's/^\+#? ?//; s/=.*//' | sort -u | tr '\n' ' ' || true)"
[[ -z "${NEWENV// /}" ]] || warn "new settings in .env.example: ${NEWENV}(optional unless INSTALL.md says otherwise)"
INFRA_CHANGED=0
git diff --quiet "$OLD" "$TARGET" -- infra/caddy infra/docker-compose.yml infra/docker-compose.prod.yml infra/docker-compose.cluster.yml infra/garage 2>/dev/null || INFRA_CHANGED=1
(( INFRA_CHANGED )) && warn "infrastructure files changed: the proxy, and any service whose definition changed, are recreated too."
git diff --quiet "$OLD" "$TARGET" -- INSTALL.md || say "  INSTALL.md changed: read what is new before relying on old habits."

if [[ -z "$BACKUP" ]]; then if [[ "$DEPLOY_MODE" == cluster ]]; then BACKUP=no; else BACKUP=yes; fi; fi
if [[ "$BACKUP" == yes && "$DB_MODE" != bundled ]]; then
  warn "the database is external: this script cannot back it up. Use your database's tooling (or Admin > Backups for the app's data)."
  BACKUP=no
fi
say "  database backup first: $BACKUP$([[ "$DEPLOY_MODE" == cluster && "$BACKUP" == no ]] && echo ' (cluster: take one before the first node with --backup)')"
say "  swap: $([[ "$DEPLOY_MODE" == cluster ]] && echo "drain, wait ${DRAIN_WAIT}s, restart api/web/monitor, wait healthy, undrain" || echo 'restart api/web/monitor (a short interruption)')"
(( CHECK )) && { say; say "--check: nothing was changed."; exit 0; }

running || die "the stack is not running. Start it first (scripts/compose.sh$([[ $STACK == prod ]] && echo ' --prod') up -d), then upgrade."

# Space for the new images: warn, never block (the check is a guess).
root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
if [[ -n "$root" && -d "$root" ]]; then
  free_mb=$(df -Pm "$root" 2>/dev/null | awk 'NR==2 {print $4}' || true)
  [[ -z "$free_mb" || "$free_mb" -ge 4096 ]] || warn "only ${free_mb} MB free under $root; the new images need a few GB (--prune afterwards frees the old ones)."
fi

if (( YES == 0 )); then
  [[ -t 0 ]] || die "no terminal to ask on. Add --yes to go ahead."
  read -r -p "Go ahead? [y/N] " a
  [[ "$a" =~ ^[Yy] ]] || { say "Nothing was changed."; exit 0; }
fi

START=$SECONDS
HEALTH_WAIT="${UPGRADE_HEALTH_WAIT:-150}"   # seconds the new version gets to become healthy (tests shorten it)
phase() { printf '%s  (%ds)\n' "$1" "$((SECONDS - START))"; }

# ---- helpers for the steps ----------------------------------------------------------------------------
# Inside the containers, so the answer does not depend on the proxy, the drain flag or the load balancer.
api_ready() { dc exec -T api node -e "fetch('http://127.0.0.1:3001/api/v1/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1; }
web_ready() { dc exec -T web node -e "fetch('http://127.0.0.1:3000/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))" >/dev/null 2>&1; }
runs_build() { # service, build id
  [[ "$(dc exec -T "$1" printenv BUILD_ID 2>/dev/null | tr -d '\r\n')" == "$2" ]]
}
wait_healthy() { # build id, seconds
  local want=$1 secs=$2 i=0
  until api_ready && web_ready && runs_build api "$want" && runs_build web "$want"; do
    i=$((i + 2)); (( i > secs )) && return 1
    sleep 2
  done
}
# Docker's image store can lose a layer when images build in parallel (see install.sh build_images): one at a time.
STORE_ERR='failed to prepare extraction snapshot|parent snapshot .*does not exist|snapshot [^ ]+ does not exist|content digest .*not found|failed to get digest .*not found'
build_images() {
  local out; out="$(mktemp)"
  if dc build api web monitor 2>&1 | tee "$out"; then rm -f "$out"; return 0; fi
  if grep -qE "$STORE_ERR" "$out"; then
    warn "Docker's image store reports a missing layer; building one image at a time."
    local s; for s in api web monitor; do dc build "$s" || { rm -f "$out"; return 1; }; done
    rm -f "$out"; return 0
  fi
  rm -f "$out"; return 1
}
write_state() {
  { echo "PREV_COMMIT=$OLD"; echo "BRANCH=${BRANCH:-$(state_get BRANCH)}"; echo "TARGET=$TARGET"; echo "STACK=$STACK"; echo "WHEN=$(date -u +%FT%TZ)"; } >"$STATE.new"
  mv "$STATE.new" "$STATE"
}
goto_commit() { # sync the working tree to a commit
  if [[ -n "$BRANCH" ]] && git merge-base --is-ancestor "$(git rev-parse HEAD)" "$1" 2>/dev/null; then
    git merge --ff-only --quiet "$1"
  else
    git checkout --quiet --detach "$1"
  fi
}
swap() { # recreate what changed; the databases and the object store are left alone
  if (( INFRA_CHANGED )); then
    dc up -d --no-build
    dc restart proxy >/dev/null 2>&1 || true
  else
    dc up -d --no-build --no-deps api web monitor
  fi
}
drained=0
undrain() { (( drained )) && bash scripts/cluster.sh undrain && drained=0; return 0; }

# ---- 0. a backup first --------------------------------------------------------------------------------
if [[ "$BACKUP" == yes ]]; then
  head1 "Backing up the database"
  if [[ "$STACK" == prod ]]; then bash scripts/db-s3.sh --prod backup; else bash scripts/db-s3.sh backup; fi \
    || die "the backup failed, so nothing was changed. Fix that, or run again with --no-backup if you accept the risk."
  phase "backup done"
fi

# ---- 1. the new code, and the new images while the old version keeps serving ---------------------------
head1 "Fetching the new version and building it (the site keeps running the old one)"
write_state
goto_commit "$TARGET"
NEWID="$(bash scripts/build-id.sh)"
say "build id: $NEWID"
if ! build_images; then
  warn "the build failed. Putting the code back; the running site was not touched."
  goto_commit "$OLD"
  exit 1
fi
phase "images built"

# ---- 2. migrate with the new image, before the swap ----------------------------------------------------
if (( BACK == 0 )); then
  head1 "Applying migrations (the old version keeps running: they are additive)"
  if ! dc run -T --rm --no-deps api node dist/scripts/migrate.js; then
    warn "the migration failed. Putting the code back; the running site was not touched."
    warn "(A migration that stopped halfway can be run again; on YugabyteDB it resumes. Read the error above first.)"
    goto_commit "$OLD"
    exit 1
  fi
  phase "migrations done"
fi

# ---- 3. swap ------------------------------------------------------------------------------------------------
head1 "Swapping the containers"
if [[ "$DEPLOY_MODE" == cluster ]]; then
  bash scripts/cluster.sh drain
  drained=1
  (( DRAIN_WAIT > 0 )) && { say "waiting ${DRAIN_WAIT}s for open requests to finish"; sleep "$DRAIN_WAIT"; }
fi
SWAP_AT=$SECONDS
swap || true   # judged by the health check below, which also catches a half-started swap

# ---- 4. verify, and go back by itself if it is not right ------------------------------------------------------------------
head1 "Checking the new version"
if wait_healthy "$NEWID" "$HEALTH_WAIT"; then
  ok "api and web are healthy and run build $NEWID (interruption: about $((SECONDS - SWAP_AT))s)"
else
  warn "the new version did not become healthy within ${HEALTH_WAIT}s. Going back to $(short "$OLD")."
  dc logs --tail 30 api web 2>&1 | sed 's/^/    /' || true
  goto_commit "$OLD"
  OLDID="$(bash scripts/build-id.sh)"
  if build_images && swap && wait_healthy "$OLDID" "$HEALTH_WAIT"; then
    undrain
    # The failed target must not be what --rollback goes back to.
    { echo "PREV_COMMIT=$TARGET"; echo "BRANCH=${BRANCH:-$(state_get BRANCH)}"; echo "TARGET=$OLD"; echo "STACK=$STACK"; echo "WHEN=$(date -u +%FT%TZ)"; } >"$STATE"
    die "the upgrade to $(short "$TARGET") failed and the previous version ($(short "$OLD")) is running again. Look at the log above (and $LOG)."
  fi
  die "the upgrade failed AND going back did not come up cleanly. This node$([[ $drained -eq 1 ]] && echo ' is still drained') needs a look: scripts/compose.sh$([[ $STACK == prod ]] && echo ' --prod') ps / logs. The previous commit is $OLD."
fi
if [[ "$DEPLOY_MODE" == cluster ]]; then
  undrain
  sleep 2
  bash scripts/cluster.sh status | head -n 3 || true
fi

# ---- 5. tidy up ----------------------------------------------------------------------------------------------------
if (( PRUNE )); then
  head1 "Removing dangling images"
  docker image prune -f | tail -n 1
fi
head1 "Done in $((SECONDS - START))s: now on $(short "$TARGET") (build $NEWID)"
say "  roll back with: scripts/upgrade.sh --rollback"
[[ "$DEPLOY_MODE" == cluster ]] && say "  next node: run this script there. Admin > Cluster shows the nodes' builds."
exit 0
