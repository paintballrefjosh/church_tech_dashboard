#!/usr/bin/env bash
#
# Version matching, with real throwaway git repositories (no docker started):
#   - a --join on a checkout that differs from the first node's offers to check out the first node's commit,
#     does it, and carries on with the updated installer;
#   - it will not touch a checkout with uncommitted changes, and says why;
#   - with no terminal and no answer it stops with a clear message instead of "No input left";
#   - the first machine offers `git pull` when it is behind its upstream.
#
#   tests/installer/update.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
pass=0; failn=0
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "  ok    $what"; else failn=$((failn + 1)); echo "  FAIL  $what"; fi; }
g() { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}"; }

# origin with two commits made from the installer as it is now: c1, then c2 (a harmless change)
SRC="$WORK/src"; mkdir -p "$SRC"
(cd "$REPO" && tar --exclude=./data --exclude=node_modules --exclude=.git --exclude=dist --exclude=.next --exclude=./.env --exclude='./.install*' -cf - .) | tar -xf - -C "$SRC"
git -C "$SRC" init -q -b master && g "$SRC" add -A && g "$SRC" commit -qm c1
git clone -q --bare "$SRC" "$WORK/origin.git"
C1=$(git -C "$SRC" rev-parse HEAD)
git -C "$SRC" remote add origin "$WORK/origin.git"; git -C "$SRC" fetch -q origin; git -C "$SRC" branch -q -u origin/master master
echo "newer" >"$SRC/NEWER.txt"; g "$SRC" add -A && g "$SRC" commit -qm c2 && git -C "$SRC" push -q origin master
C2=$(git -C "$SRC" rev-parse HEAD)

mkpkg() { # sha -> a node package whose commit is sha
  local d; d=$(mktemp -d -p "$WORK"); cp "$SRC/.env.example" "$d/.env"; printf '%s \n' "$1" >"$d/COMMIT"
  tar -czf "$WORK/pkg-$1.tar.gz" -C "$d" . ; echo "$WORK/pkg-$1.tar.gz"
}
node() { # name -> a checkout at c1 (behind origin)
  git clone -q "$WORK/origin.git" "$WORK/$1" && g "$WORK/$1" checkout -q "$C1"
  git -C "$WORK/$1" checkout -q -B master "$C1" && git -C "$WORK/$1" branch -q -u origin/master master
}
printf '%s\n' EXTERNAL_PORT=8123 NOWAIT=yes > "$WORK/join.ans"

echo "== --join: a checkout behind the first node's commit"
node b
pkg=$(mkpkg "$C2")
(cd "$WORK/b" && printf 'JOIN_UPDATE=yes\n' | cat - "$WORK/join.ans" >join.ans && INSTALL_STOP_AFTER=join-env NO_COLOR=1 ./install.sh --join "$pkg" --answers join.ans </dev/null >"$WORK/b.out" 2>&1); rc=$?
check "it offered to match and carried on (exit 0)" test $rc -eq 0
check "the checkout is now at the first node's commit" test "$(git -C "$WORK/b" rev-parse HEAD)" = "$C2"
check "it restarted the installer with the new files" grep -q 'Restarting the installer' "$WORK/b.out"
check "the new file from that commit is there" test -f "$WORK/b/NEWER.txt"
check "the node's .env was written after the update" test -f "$WORK/b/.env"

echo "== --join: uncommitted changes are never discarded"
node c; echo "mine" >"$WORK/c/README.md"
(cd "$WORK/c" && printf 'JOIN_UPDATE=yes\n' | cat - "$WORK/join.ans" >join.ans && NO_COLOR=1 ./install.sh --join "$pkg" --answers join.ans </dev/null >"$WORK/c.out" 2>&1); rc=$?
check "it refuses" test $rc -ne 0
check "and says why" grep -q 'uncommitted changes' "$WORK/c.out"
check "the checkout and the change are untouched" bash -c "test \"\$(git -C '$WORK/c' rev-parse HEAD)\" = '$C1' && grep -q mine '$WORK/c/README.md'"

echo "== --join: no terminal and no answer"
node d
(cd "$WORK/d" && NO_COLOR=1 ./install.sh --join "$pkg" --answers "$WORK/join.ans" </dev/null >"$WORK/d.out" 2>&1); rc=$?
check "it stops with an explanation, not 'No input left'" bash -c "[ $rc -ne 0 ] && grep -q 'there is no terminal to ask' '$WORK/d.out' && ! grep -q 'No input left' '$WORK/d.out'"

echo "== --join: a commit this checkout cannot get"
node e
pkg3=$(mkpkg "0000000000000000000000000000000000000001")
(cd "$WORK/e" && printf 'JOIN_UPDATE=yes\n' | cat - "$WORK/join.ans" >join.ans && NO_COLOR=1 ./install.sh --join "$pkg3" --answers join.ans </dev/null >"$WORK/e.out" 2>&1); rc=$?
check "it explains that the commit is missing (maybe never pushed)" bash -c "[ $rc -ne 0 ] && grep -q 'never pushed' '$WORK/e.out'"

echo "== the first machine offers to pull when it is behind"
node f
(cd "$WORK/f" && printf 'REUSE_SECRET=no\n' >/dev/null; NO_COLOR=1 ./install.sh --dry-run </dev/null >"$WORK/f.out" 2>&1); rc=$?
check "it said a newer version exists" grep -q 'newer version is available' "$WORK/f.out"
node f2
# answer yes through the real prompt: the update question comes first, then (after the restart) the check runs
(cd "$WORK/f2" && printf "y\n" | NO_COLOR=1 ./install.sh --dry-run >"$WORK/f2.out" 2>&1)
check "answering yes pulled and restarted" bash -c "grep -q 'Restarting the installer' '$WORK/f2.out' && test \"\$(git -C '$WORK/f2' rev-parse HEAD)\" = '$C2'"
node f3; echo "x" >"$WORK/f3/README.md"
(cd "$WORK/f3" && NO_COLOR=1 ./install.sh --dry-run </dev/null >"$WORK/f3.out" 2>&1)
check "with uncommitted changes it says it cannot update, and does not" bash -c "grep -q 'cannot be updated automatically' '$WORK/f3.out' && test \"\$(git -C '$WORK/f3' rev-parse HEAD)\" = '$C1'"

echo "== progress from an earlier run when the code has changed since (stale packages)"
fn=$(sed -n '/^forget_stale_progress() {/,/^}/p' "$REPO/install.sh")
st="$WORK/state"
printf '%s\n' prep ports certs packages remote-prepare remote-start build start-data init-db garage migrate seed up remote-finish health buildid:oldbuild >"$st"
bash -c "warn() { :; }; STATE='$st'; cd '$SRC'; $fn; forget_stale_progress" >/dev/null 2>&1
check "steps that depend on the code are redone" bash -c "! grep -qxE 'packages|remote-prepare|remote-start|build|migrate|seed|up|remote-finish|health' '$st'"
check "steps that do not depend on it are kept" bash -c "grep -qx prep '$st' && grep -qx certs '$st' && grep -qx start-data '$st' && grep -qx init-db '$st' && grep -qx garage '$st'"
check "the current build id is recorded" grep -qx "buildid:$(bash "$SRC/scripts/build-id.sh")" "$st"
printf '%s\n' prep packages build "buildid:$(bash "$SRC/scripts/build-id.sh")" >"$st"
bash -c "warn() { :; }; STATE='$st'; cd '$SRC'; $fn; forget_stale_progress" >/dev/null 2>&1
check "unchanged code: packages are still made afresh, the rest is kept" bash -c "! grep -qx packages '$st' && grep -qx build '$st'"

echo
echo "installer version tests: $pass passed, $failn failed"
[[ $failn -eq 0 ]]
