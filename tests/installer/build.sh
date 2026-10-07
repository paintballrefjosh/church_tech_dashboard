#!/usr/bin/env bash
#
# The image build step and Docker's "failed to prepare extraction snapshot ... parent snapshot ... does not exist"
# (a damaged image store, hit on a real install): the installer retries one image at a time, then offers to clear
# the build cache, and does NOT mask an ordinary build error. A fake `compose` and a fake `docker` stand in; the
# error text is the real one.
#   tests/installer/build.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
pass=0; failn=0
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "  ok    $what"; else failn=$((failn + 1)); echo "  FAIL  $what"; fi; }

STORE_ERR='failed to solve: failed to prepare extraction snapshot "extract-407745076-EnAW sha256:d3505bf0": parent snapshot sha256:2aff1cef does not exist: not found'

cat >"$W/fake" <<'FAKE'
#!/usr/bin/env bash
# build (all)          : outcomes from $FAKE_ALL, one per call (last repeats): ok | store | other
# build <service>      : outcomes from $FAKE_SVC the same way (default ok)
# config --services    : api and web
echo "$*" >>"$FAKE_CALLS"
if [[ $1 == config ]]; then printf 'api\nweb\n'; exit 0; fi
if [[ $2 == "" ]]; then file=$FAKE_ALL; ctr="$FAKE_CALLS.all"; else file=$FAKE_SVC; ctr="$FAKE_CALLS.svc"; fi
n=$(cat "$ctr" 2>/dev/null || echo 0); n=$((n + 1)); echo $n >"$ctr"
out=$(sed -n "${n}p" "$file" 2>/dev/null); [[ -n $out ]] || out=$(tail -n 1 "$file" 2>/dev/null); [[ -n $out ]] || out=ok
case $out in
  ok) exit 0 ;;
  store) echo "$FAKE_STORE_ERR" >&2; exit 1 ;;
  other) echo "ERROR: web: Module not found: Can't resolve 'left-pad'" >&2; exit 1 ;;
esac
FAKE
chmod +x "$W/fake"

fns=$(sed -n '/^logrun() {/,/^st_start_single\|^# Output that means/p' "$REPO/install.sh")
run() { # all-outcomes... ; env: SVC (outcomes for per-service builds), PRUNE (yes|no)
  : >"$W/calls"; rm -f "$W/calls.all" "$W/calls.svc"
  printf '%s\n' "$@" >"$W/all"; printf '%s\n' "${SVC:-ok}" >"$W/svc"
  FAKE_ALL="$W/all" FAKE_SVC="$W/svc" FAKE_CALLS="$W/calls" FAKE_STORE_ERR="$STORE_ERR" PRUNE="${PRUNE:-yes}" LOG="$W/log" bash -c "
    G=''; Z=''; R=''; Y=''; D=''; QC=''
    sleep() { :; }
    warn() { echo \"[!] \$*\"; }; fail() { echo \"[x] \$*\"; }; info() { echo \"\$*\"; }
    ans() { case \$1 in AUTO_PRUNE_BUILD_CACHE) echo \"\$PRUNE\" ;; esac; }
    ask_yn() { :; }
    docker() { echo \"docker \$*\" >>'$W/calls'; return 0; }
    $fns
    : >'$W/log'
    build_images 'Building' '$W/fake'; echo \"rc=\$?\"" 2>&1
}
: >"$W/log"

echo "== a build that simply works"
out=$(run ok); check "one build, nothing else" bash -c "[ \"\$(cat '$W/calls' | wc -l)\" = 1 ] && grep -q 'rc=0' <<<\"\$1\"" _ "$out"

echo "== a damaged image store, fixed by building one image at a time"
out=$(run store)
check "it recognised the image store error and said so" grep -q 'image store reports a missing layer' <<<"$out"
check "it built each service on its own" bash -c "grep -qx 'build api' '$W/calls' && grep -qx 'build web' '$W/calls'"
check "and succeeded without clearing anything" bash -c "grep -q 'rc=0' <<<\"\$1\" && ! grep -q 'builder prune' '$W/calls'" _ "$out"

echo "== still damaged: it offers to clear the build cache, and builds again"
out=$(SVC=store PRUNE=yes run store ok)
check "it cleared only the build cache" grep -qx 'docker builder prune -f' "$W/calls"
check "then built again and succeeded" bash -c "grep -q 'rc=0' <<<\"\$1\"" _ "$out"
check "nothing that removes images or volumes was run" bash -c "! grep -qE 'system prune|image prune|volume|rmi' '$W/calls'"

echo "== still damaged and the cache is not cleared"
out=$(SVC=store PRUNE=no run store)
check "it stops and says what to try" bash -c "grep -q 'rc=1' <<<\"\$1\" && grep -q 'systemctl restart docker' <<<\"\$1\" && ! grep -q 'builder prune' '$W/calls'" _ "$out"

echo "== an ordinary build error is not mistaken for that"
out=$(run other)
check "no retries, no pruning" bash -c "[ \"\$(grep -c '^build' '$W/calls')\" = 1 ] && ! grep -q 'prune' '$W/calls'" _ "$out"
check "the real error is shown" grep -q "Module not found" <<<"$out"

echo
echo "installer build step tests: $pass passed, $failn failed"
[[ $failn -eq 0 ]]
