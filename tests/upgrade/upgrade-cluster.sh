#!/usr/bin/env bash
#
# scripts/upgrade-cluster.sh against fake nodes: an `ssh` that runs the command in a per-host folder, a stub
# scripts/upgrade.sh on every node that records its arguments, and a fake curl for /healthz. The order, the
# arguments each node gets, stopping at the first failure, what is left untouched, a re-run, --check, --rollback,
# the witness skip, the refusals. No Docker, no real SSH.
#   tests/upgrade/upgrade-cluster.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
W=$(mktemp -d); export W; trap 'rm -rf "$W"' EXIT
pass=0; failn=0
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "  ok    $what"; else failn=$((failn + 1)); echo "  FAIL  $what"; fi; }

mkdir -p "$W/bin" "$W/homes"
# ssh: skip options, take user@host, run the rest as a command in that host's home.
cat >"$W/bin/ssh" <<'FAKE'
#!/usr/bin/env bash
while [[ "${1:-}" == -* ]]; do case "$1" in -o|-p) shift 2 ;; *) shift ;; esac; done
target="$1"; shift; host="${target#*@}"
[[ ",${FAKE_SSH_DOWN:-}," == *",$host,"* ]] && { echo "ssh: connect to host $host port 22: No route to host" >&2; exit 255; }
cd "$FAKE_HOMES/$host" || exit 255
HOME="$FAKE_HOMES/$host" exec bash -c "$*"
FAKE
# curl: /healthz answers unless a file down.<port> exists.
cat >"$W/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url="${*: -1}"; port="${url#*127.0.0.1:}"; port="${port%%/*}"
[[ -f "$FAKE_RUN/down.$port" ]] && exit 22
exit 0
FAKE
# docker: only `manifest inspect <ref>` matters (is the image in the registry?): true when $FAKE_RUN/published/<ref> exists.
cat >"$W/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"${FAKE_RUN:?}/dockercalls"
if [[ "$1 $2" == "manifest inspect" ]]; then [[ -f "$FAKE_RUN/published/$(printf '%s' "$3" | tr '/:' '__')" ]]; exit $?; fi
exit 0
FAKE
chmod +x "$W/bin/ssh" "$W/bin/curl" "$W/bin/docker"

# The stub upgrade.sh every node has: records "<node id> <args>", moves the checkout to --to unless told to fail.
STUB='#!/usr/bin/env bash
id="$(sed -n "s/^NODE_ID=//p" .env)"
if [[ "${1:-}" == --status ]]; then
  [[ -f "${FAKE_RUN:?}/stale.$id" ]] && echo "stale oldbuild" || echo current
  exit 0
fi
echo "$id $*" >>"${FAKE_RUN:?}/calls"
echo "$0 ${UPGRADE_ROOT:-}" >"${FAKE_RUN:?}/via.$id"
echo "stub upgrade on $id"
to=""; chk=""; while [[ $# -gt 0 ]]; do case "$1" in --to) to="$2"; shift 2 ;; --check) chk=1; shift ;; *) shift ;; esac; done
[[ -n "$chk" ]] && exit 0
[[ -f "$FAKE_RUN/fail.$id" ]] && { echo "build failed on $id" >&2; exit 1; }
rm -f "$FAKE_RUN/stale.$id"
if [[ -n "$to" ]]; then git fetch -q origin 2>/dev/null; git merge -q --ff-only "$to" 2>/dev/null || git checkout -q --detach "$to"; fi
exit 0'

# scripts/release.sh as a stub: records its arguments and "publishes" the checkout's build id (unless FAKE_RELEASE_FAIL=1).
RELEASE_STUB='#!/usr/bin/env bash
echo "release $*" >>"${FAKE_RUN:?}/release.calls"
[[ "${FAKE_RELEASE_FAIL:-}" == 1 ]] && exit 1
id="$(git rev-parse --short=12 HEAD)"; mkdir -p "$FAKE_RUN/published"
for s in api web monitor; do : >"$FAKE_RUN/published/$(printf "%s" "${2%/}-$s:$id" | tr "/:" "__")"; done'

# fresh <name>... : an origin with two commits; the local checkout and one clone per named remote node, all on the
# first commit. The remote node names: alpha beta gamma (app nodes), witness (NODE_ROLE=data).
fresh() {
  rm -rf "${W:?}/origin.git" "${W:?}/dev" "${W:?}/local" "${W:?}/homes" "${W:?}/run"; mkdir -p "$W/run" "$W/homes"
  git init -q --bare -b master "$W/origin.git"
  git clone -q "$W/origin.git" "$W/dev" 2>/dev/null
  ( cd "$W/dev" && git config user.email t@t && git config user.name t
    mkdir -p scripts; printf '%s\n' "${FIRST_STUB:-$STUB}" >scripts/upgrade.sh; printf '%s\n' "$RELEASE_STUB" >scripts/release.sh; echo one >f
    git add -A && git commit -q -m first && git push -q origin master 2>/dev/null )
  git clone -q "$W/origin.git" "$W/local" 2>/dev/null
  cp "$REPO/scripts/upgrade-cluster.sh" "$W/local/scripts/"
  # The real repo ignores .env and data/ and tracks the script itself; here they are not, and a tree with untracked files is not clean.
  printf '.env\ndata/\nscripts/upgrade-cluster.sh\n' >>"$W/local/.git/info/exclude"
  printf 'NODE_ID=main\nEXTERNAL_PORT=9000\n' >"$W/local/.env"
  mkdir -p "$W/local/data/upgrade"
  local n port=9001
  for n in "$@"; do
    mkdir -p "$W/homes/$n"; git clone -q "$W/origin.git" "$W/homes/$n/church-dashboard" 2>/dev/null
    printf 'NODE_ID=%s\nEXTERNAL_PORT=%s\n%s' "$n" "$port" "$([[ $n == witness ]] && echo NODE_ROLE=data)" >"$W/homes/$n/church-dashboard/.env"
    port=$((port + 1))
  done
  ( cd "$W/dev" && echo two >f && printf '%s\n' "$STUB" >scripts/upgrade.sh && git commit -q -am second && git push -q origin master 2>/dev/null )
  NEW=$(git -C "$W/dev" rev-parse HEAD); OLD=$(git -C "$W/local" rev-parse HEAD)
}
nodes_file() { printf '%s\n' "$@" >"$W/local/data/upgrade/nodes"; }
head_of() { git -C "$W/homes/$1/church-dashboard" rev-parse HEAD; }
calls() { cat "$W/run/calls" 2>/dev/null; }
# up_ args : run in the local checkout; output in $W/out, exit code in $W/rc
up_() {
  ( cd "$W/local" && PATH="$W/bin:$PATH" FAKE_HOMES="$W/homes" FAKE_RUN="$W/run" FAKE_SSH_DOWN="${FAKE_SSH_DOWN:-}" \
      FAKE_RELEASE_FAIL="${FAKE_RELEASE_FAIL:-}" UC_POLL_SEC=0.2 UC_HEALTH_WAIT=2 bash scripts/upgrade-cluster.sh --settle 0 "$@" >"$W/out" 2>&1 ); echo $? >"$W/rc"
}
rc() { cat "$W/rc"; }
export -f calls head_of rc   # the checks below run them in a child bash
APP4=(local u@alpha u@beta u@gamma u@witness)

echo "== --check"
fresh alpha beta gamma witness; nodes_file "${APP4[@]}"
up_ --check
check "exits 0" test "$(rc)" = 0
check "asks every app node, with --check and no --yes" bash -c "[[ \$(grep -c -- '--check' <<<\"$(calls)\") == 4 ]] && ! grep -q -- '--yes' <<<\"$(calls)\""
check "leaves the witness alone" bash -c "! grep -q witness <<<\"$(calls)\""
check "changes no version" test "$(head_of alpha)" = "$OLD"

echo "== upgrade, all nodes"
fresh alpha beta gamma witness; nodes_file "${APP4[@]}"
up_ --yes
check "exits 0" test "$(rc)" = 0
check "every app node is on the new commit" bash -c "[[ \$(git -C '$W/local' rev-parse HEAD) == $NEW && $(head_of alpha) == $NEW && $(head_of beta) == $NEW && $(head_of gamma) == $NEW ]]"
check "the witness is untouched" test "$(head_of witness)" = "$OLD"
check "one at a time, in list order" bash -c "[[ \$(calls | awk '{print \$1}' | tr '\n' ' ') == 'main alpha beta gamma ' ]]"
check "every node gets the same --to commit" bash -c "[[ \$(calls | grep -o -- '--to [0-9a-f]*' | sort -u | wc -l) == 1 ]] && grep -q -- '--to $NEW' <<<\"$(calls)\""
check "only the first node takes a backup" bash -c "grep -q 'main .*--backup' <<<\"$(calls)\" && ! grep -E '^(alpha|beta|gamma) ' <<<\"$(calls)\" | grep -q -- '--backup'"
check "every node runs unattended (--yes)" bash -c "[[ \$(grep -c -- '--yes' <<<\"$(calls)\") == 4 ]]"
check "shows each node's output under its name" grep -q "\[alpha\].*stub upgrade on alpha" "$W/out"
check "says it is done" grep -q "Done in" "$W/out"
up_ --yes
check "a second run has nothing to do" bash -c "grep -q 'nothing to do' '$W/out' && [[ \$(wc -l <'$W/run/calls') == 4 ]]"

echo "== every node upgrades with the TARGET version's upgrade.sh"
# The first commit's upgrade.sh (what every node has) is broken, like the real one that exited 141; the target's works.
BROKEN='#!/usr/bin/env bash
echo "the old upgrade.sh ran on this node" >&2; exit 141'
FIRST_STUB="$BROKEN" fresh alpha beta; nodes_file local u@alpha u@beta
up_ --yes
check "exits 0 although the nodes' own upgrade.sh is broken" test "$(rc)" = 0
check "every node is on the new commit" bash -c "[[ \$(head_of alpha) == $NEW && \$(head_of beta) == $NEW ]]"
check "the old script never ran" bash -c "! grep -q 'old upgrade.sh ran' '$W/out'"
check "a remote node ran the copy from git, rooted in its checkout" bash -c "[[ \$(cat '$W/run/via.alpha') == 'data/upgrade/upgrade.next.sh $W/homes/alpha/church-dashboard' ]]"
check "the local node did too" bash -c "[[ \$(cat '$W/run/via.main') == 'data/upgrade/upgrade.next.sh $W/local' ]]"
check "the copy is the target's file" bash -c "cmp -s '$W/homes/beta/church-dashboard/data/upgrade/upgrade.next.sh' <(git -C '$W/dev' show $NEW:scripts/upgrade.sh)"
check "the copy's folder is git-ignored in the real repo (it must not change the build id)" git -C "$REPO" check-ignore -q data/upgrade/upgrade.next.sh

echo "== a node that cannot fetch the target uses its own upgrade.sh"
fresh alpha; nodes_file local u@alpha
git -C "$W/homes/alpha/church-dashboard" remote set-url origin "$W/nowhere.git"
up_ --yes
check "the run goes on with the node's own copy" bash -c "[[ \$(cut -d' ' -f1 '$W/run/via.alpha') == scripts/upgrade.sh ]] && grep -q '^alpha ' <<<\"$(calls)\""

echo "== --rollback uses each node's own upgrade.sh (there is no target)"
fresh alpha; nodes_file local u@alpha
up_ --yes --rollback
check "no copy is fetched" bash -c "[[ \$(cut -d' ' -f1 '$W/run/via.alpha') == scripts/upgrade.sh && ! -e '$W/homes/alpha/church-dashboard/data/upgrade/upgrade.next.sh' ]]"

echo "== a node whose checkout is on the target but whose containers are old is upgraded"
fresh alpha beta; nodes_file local u@alpha u@beta
for n in alpha beta; do git -C "$W/homes/$n/church-dashboard" pull -q origin master 2>/dev/null; done
touch "$W/run/stale.beta"
up_ --yes
check "exits 0" test "$(rc)" = 0
check "the stale node is upgraded and says why" bash -c "grep -q '^beta ' <<<\"$(calls)\" && grep -q \"runs build 'oldbuild'\" '$W/out'"
check "the node that really runs it is skipped" bash -c "! grep -q '^alpha ' <<<\"$(calls)\""
up_ --yes
check "a second run has nothing to do" grep -q "nothing to do" "$W/out"

echo "== a failing node stops the run"
fresh alpha beta gamma witness; nodes_file "${APP4[@]}"
touch "$W/run/fail.beta"
up_ --yes
check "exits non-zero" test "$(rc)" != 0
check "the node before it is upgraded" test "$(head_of alpha)" = "$NEW"
check "the failing node was tried" bash -c "grep -q '^beta ' <<<\"$(calls)\""
check "the node after it is not touched" bash -c "! grep -q '^gamma ' <<<\"$(calls)\" && [[ \$(head_of gamma) == $OLD ]]"
check "the summary says which is which" bash -c "grep -q 'Stopped at beta' '$W/out' && grep -q 'done .*alpha' '$W/out' && grep -q 'untouched .*gamma' '$W/out'"
rm "$W/run/fail.beta"; : >"$W/run/calls"
up_ --yes
check "run again: finished nodes are skipped, the rest continue" bash -c "[[ \$(calls | awk '{print \$1}' | tr '\n' ' ') == 'beta gamma ' ]] && [[ \$(head_of gamma) == $NEW ]] && [[ \$(rc) == 0 ]]"

echo "== a node that does not come back healthy stops the run"
fresh alpha beta gamma; nodes_file local u@alpha u@beta u@gamma
touch "$W/run/down.9002"   # beta's port
up_ --yes
check "stops at that node" bash -c "[[ \$(rc) != 0 ]] && grep -q 'healthz does not answer 200' '$W/out' && ! grep -q '^gamma ' <<<\"$(calls)\""

echo "== --no-backup, --drain-wait and --no-prune are passed on"
fresh alpha; nodes_file local u@alpha
up_ --yes --no-backup --drain-wait 5 --no-prune
check "every node gets them" bash -c "[[ \$(grep -c -- '--no-backup' <<<\"$(calls)\") == 2 && \$(grep -c -- '--drain-wait 5' <<<\"$(calls)\") == 2 && \$(grep -c -- '--no-prune' <<<\"$(calls)\") == 2 ]] && ! grep -q -- '--backup ' <<<\"$(calls)\""

echo "== --to"
fresh alpha; nodes_file local u@alpha
up_ --yes --to "$OLD"
check "a node already there is skipped" bash -c "grep -q 'nothing to do' '$W/out'"
up_ --yes --to "$NEW"
check "moves every node to that commit" bash -c "[[ \$(head_of alpha) == $NEW ]]"

echo "== --rollback"
fresh alpha beta; nodes_file local u@alpha u@beta
up_ --yes --rollback
check "goes last node first, with --rollback" bash -c "[[ \$(calls | awk '{print \$1}' | tr '\n' ' ') == 'beta alpha main ' ]] && [[ \$(grep -c -- '--rollback' <<<\"$(calls)\") == 3 ]]"

echo "== a node list derived from CLUSTER_PEERS"
fresh alpha beta
printf 'NODE_ID=main\nEXTERNAL_PORT=9000\nCLUSTER_PEERS=alpha:26257:3901,beta\n' >"$W/local/.env"
rm -f "$W/local/data/upgrade/nodes"
up_ --yes
check "uses this machine and each peer" bash -c "[[ \$(calls | awk '{print \$1}' | tr '\n' ' ') == 'main alpha beta ' ]] && grep -q 'no node list' '$W/out'"

echo "== refusals"
fresh alpha beta; nodes_file local u@alpha u@beta
FAKE_SSH_DOWN=beta up_ --yes
check "an unreachable node stops everything before any upgrade" bash -c "[[ \$(rc) != 0 ]] && grep -q 'cannot reach u@beta' '$W/out' && [[ -z \$(calls) ]]"
echo dirty >>"$W/homes/alpha/church-dashboard/f"
up_ --yes
check "a node with uncommitted changes is refused" bash -c "[[ \$(rc) != 0 ]] && grep -q 'uncommitted changes' '$W/out' && [[ -z \$(calls) ]]"
git -C "$W/homes/alpha/church-dashboard" checkout -q f
nodes_file local local
up_ --yes
check "'local' twice is refused" grep -q "more than once" "$W/out"
nodes_file local "u@alpha;rm"
up_ --yes
check "a bad SSH target is refused" grep -q "not a usable SSH target" "$W/out"
up_ --yes --to nonexistent-ref
nodes_file local u@alpha
up_ --yes --to nonexistent-ref
check "an unknown --to is refused" grep -q "is not a commit" "$W/out"
up_ --yes --rollback --to "$NEW"
check "--to with --rollback is refused" grep -q "either --to or --rollback" "$W/out"

echo "== images from a registry (IMAGE_REGISTRY)"
REG=ghcr.io/o/church
publish() { # a build id: the three images are in the registry
  mkdir -p "$W/run/published"; local s
  for s in api web monitor; do : >"$W/run/published/$(printf '%s' "$REG-$s:$1" | tr '/:' '__')"; done
}
newid() { git -C "$W/dev" rev-parse --short=12 "$NEW"; }
fresh alpha beta; nodes_file local u@alpha u@beta
IMAGE_REGISTRY=$REG up_ --yes
check "images not published: stops before any node is touched, and says how to publish" bash -c "[[ \$(rc) != 0 ]] && grep -q 'missing: api web monitor' '$W/out' && grep -q -- '--publish' '$W/out' && [[ -z \$(calls) ]] && [[ \$(head_of alpha) == $OLD ]]"
check "it looked for the target's build id" bash -c "grep -q 'docker manifest inspect $REG-api:$(newid)' '$W/run/dockercalls'"
fresh alpha beta; nodes_file local u@alpha u@beta; publish "$(newid)"
IMAGE_REGISTRY=$REG up_ --yes
check "published: upgrades every node" bash -c "[[ \$(rc) == 0 ]] && [[ \$(head_of alpha) == $NEW && \$(head_of beta) == $NEW ]] && grep -q 'are published; each node pulls them' '$W/out'"
check "the nodes are not told to build" bash -c "! grep -q -- '--build' <<<\"$(calls)\""
fresh alpha beta; nodes_file local u@alpha u@beta
IMAGE_REGISTRY=$REG up_ --check
check "--check on unpublished images warns and still exits 0" bash -c "[[ \$(rc) == 0 ]] && grep -q 'images not published' '$W/out'"
fresh alpha beta; nodes_file local u@alpha u@beta
IMAGE_REGISTRY=$REG up_ --yes --build
check "--build: no registry lookup, every node told to build" bash -c "[[ \$(rc) == 0 ]] && ! grep -q 'manifest inspect' '$W/run/dockercalls' && [[ \$(grep -c -- '--build' <<<\"$(calls)\") == 3 ]]"
fresh alpha beta; nodes_file local u@alpha u@beta
IMAGE_REGISTRY=$REG up_ --yes --publish
check "--publish from a checkout that is not on the target is refused, nothing is pushed" bash -c "[[ \$(rc) != 0 ]] && grep -q 'not the target' '$W/out' && [[ ! -e '$W/run/release.calls' ]] && [[ -z \$(calls) ]]"
fresh alpha beta; nodes_file local u@alpha u@beta
git -C "$W/local" pull -q --ff-only origin master 2>/dev/null
IMAGE_REGISTRY=$REG up_ --yes --publish
check "--publish builds and pushes once, before the nodes" bash -c "[[ \$(rc) == 0 ]] && [[ \$(wc -l <'$W/run/release.calls') == 1 ]] && grep -q -- '--push $REG' '$W/run/release.calls' && [[ \$(head_of alpha) == $NEW && \$(head_of beta) == $NEW ]]"
fresh alpha beta; nodes_file local u@alpha u@beta
git -C "$W/local" pull -q --ff-only origin master 2>/dev/null; publish "$(newid)"
IMAGE_REGISTRY=$REG up_ --yes --publish
check "--publish with everything already published pushes nothing" bash -c "[[ \$(rc) == 0 ]] && [[ ! -e '$W/run/release.calls' ]]"
fresh alpha beta; nodes_file local u@alpha u@beta
git -C "$W/local" pull -q --ff-only origin master 2>/dev/null
IMAGE_REGISTRY=$REG FAKE_RELEASE_FAIL=1 up_ --yes --publish
check "a failed publish stops before any node" bash -c "[[ \$(rc) != 0 ]] && grep -q 'no node was touched' '$W/out' && [[ -z \$(calls) ]]"
fresh alpha beta; nodes_file local u@alpha u@beta
up_ --yes --publish
check "--publish without IMAGE_REGISTRY is refused" grep -q "needs IMAGE_REGISTRY" "$W/out"
fresh alpha beta; nodes_file local u@alpha u@beta
up_ --yes --publish --build
check "--publish with --build is refused" grep -q "either --publish or --build" "$W/out"
fresh alpha beta; nodes_file local u@alpha u@beta
IMAGE_REGISTRY=$REG up_ --yes --rollback
check "--rollback does not look in the registry" bash -c "[[ \$(rc) == 0 ]] && ! grep -q 'manifest inspect' '$W/run/dockercalls'"
fresh alpha beta; nodes_file local u@alpha u@beta
up_ --yes
check "no IMAGE_REGISTRY: nothing changes (no lookup, no --build)" bash -c "[[ \$(rc) == 0 ]] && [[ ! -e '$W/run/dockercalls' ]] && ! grep -q -- '--build' <<<\"$(calls)\""

echo "== colour"
fresh alpha; nodes_file local u@alpha
( cd "$W/local" && PATH="$W/bin:$PATH" FAKE_HOMES="$W/homes" FAKE_RUN="$W/run" UC_POLL_SEC=0.2 UPGRADE_COLOR=always bash scripts/upgrade-cluster.sh --check >"$W/out" 2>&1 )
check "UPGRADE_COLOR=always colours the output" grep -q $'\033\\[' "$W/out"
fresh alpha; nodes_file local u@alpha
up_ --check
check "no escape codes when not on a terminal" bash -c "! grep -q \$'\\033' '$W/out'"

echo
echo "passed: $pass, failed: $failn"
[[ $failn -eq 0 ]]
