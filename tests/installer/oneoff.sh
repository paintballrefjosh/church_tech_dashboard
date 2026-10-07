#!/usr/bin/env bash
#
# The installer's one-off steps (migrate, seed): they retry ONLY while the database cannot be reached yet.
# Any other error stops at once and the FIRST failure is what is shown: retrying a migration on top of a
# half-applied step buries the real cause under a confusing second error.
#
# Uses a fake `compose` whose output and exit status the test controls (no docker involved).
#   tests/installer/oneoff.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
pass=0; failn=0
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "  ok    $what"; else failn=$((failn + 1)); echo "  FAIL  $what"; fi; }

# a fake compose: $FAKE_SCRIPT lists, one per call, "<exit status>|<text to print>" (the last line repeats)
cat >"$W/fake" <<'FAKE'
#!/usr/bin/env bash
n=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0); n=$((n + 1)); echo $n >"$FAKE_COUNT"
line=$(sed -n "${n}p" "$FAKE_SCRIPT"); [[ -n $line ]] || line=$(tail -n 1 "$FAKE_SCRIPT")
printf '%b\n' "${line#*|}"; exit "${line%%|*}"
FAKE
chmod +x "$W/fake"

fn=$(sed -n '/^TRANSIENT_DB_ERROR=/,/^st_migrate_single() {/p' "$REPO/install.sh" | sed '$d')
run() { # script-lines... -> output; calls counted in $W/count
  printf '%s\n' "$@" >"$W/script"; : >"$W/count"
  FAKE_SCRIPT="$W/script" FAKE_COUNT="$W/count" LOG="$W/log" G='' Z='' R='' bash -c "
    sleep() { :; }
    ans() { case \$1 in DB_MODE) echo external ;; esac; }
    fail() { echo \"[x] \$*\"; }
    COMPOSE=('$W/fake')
    $fn
    oneoff_api migrate" 2>&1
}

echo "== an error in what ran is not retried, and is shown"
out=$(run '1|[migrate] failed: relation "x" does not exist\nerror: relation "x" does not exist\n  code: 42P01')
check "one attempt only" test "$(cat "$W/count")" = 1
check "the message is shown" grep -q 'relation "x" does not exist' <<<"$out"
check "and it says to look at the first failure" grep -q 'first failure' <<<"$out"

echo "== a database that is not reachable yet is waited for"
out=$(run '1|Error: connect ECONNREFUSED 10.0.0.5:5433' '1|Error: connect ECONNREFUSED 10.0.0.5:5433' '0|[migrate] done')
check "it retried until the database answered" test "$(cat "$W/count")" = 3
check "and then succeeded" grep -q 'ok' <<<"$out"

echo "== the FIRST failure is the one shown, not what a later retry left"
out=$(run '1|connect ETIMEDOUT 10.0.0.5:5433' '1|[migrate] failed: relation "y" already exists')
check "a later non-connection error stops the retries" test "$(cat "$W/count")" = 2
check "the first (connection) failure is the one reported" grep -q 'ETIMEDOUT' <<<"$out"

echo "== it gives up after the retries when the database never comes up"
out=$(run '1|connect ECONNREFUSED')
check "six attempts for an external database, then it fails" test "$(cat "$W/count")" = 6

echo
echo "installer one-off step tests: $pass passed, $failn failed"
[[ $failn -eq 0 ]]
