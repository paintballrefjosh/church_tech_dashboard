#!/usr/bin/env bash
#
# Guided installer for the church dashboard: asks a few questions, writes .env, then starts
# the stack, migrates and seeds it. Covers every deployment shape (INSTALL.md):
#   A  one server, bundled database        B  one server, your own database
#   C  several servers, bundled databases  D  several servers, your own database
#
#   ./install.sh                     the wizard
#   ./install.sh --join <package>    add this machine to a cluster the first node set up
#   ./install.sh --answers FILE      take answers from FILE (KEY=value lines) instead of asking;
#                                    anything not in the file is still asked
#   ./install.sh --dry-run           ask and write .env (and, for a cluster, a preview of every
#                                    node's .env) but start nothing, touch no docker
#   ./install.sh --fresh             forget what an earlier run finished and start over
#   ./install.sh --check-requirements  check (and, if you agree, install) make, git, tar and Docker, then stop
#   ./install.sh --help
#
# Running it again is safe: finished steps are skipped (.install-state), the answers are kept
# (.install-answers, mode 600) and an existing .env is backed up before it is replaced.
# Everything the installer runs is logged to .install.log.
#
# Not for tests only, but they use it: the answer keys are the ANS[...] names below, and any
# ENV_<NAME>=value answer is written to .env as <NAME>=value (for example ENV_API_IMAGE).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
SELF="$PWD/$(basename "${BASH_SOURCE[0]}")"
ORIG_ARGS=("$@")

if (( BASH_VERSINFO[0] < 4 )); then
  echo "install.sh needs bash 4 or newer (this is $BASH_VERSION)." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------------------------
# Colours: questions stand out in cyan, what you type is green, defaults and explanations are dim.
# INSTALL_COLOR=1 forces colour (for tests), NO_COLOR=1 turns it off.
if [[ -z "${NO_COLOR:-}" && ( -t 1 || -n "${INSTALL_COLOR:-}" ) ]]; then
  B=$'\e[1m'; D=$'\e[2m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; Z=$'\e[0m'
  QC=$'\e[1;36m'   # a question
  HC=$'\e[1;35m'   # a section heading
  NC=$'\e[36m'     # a menu number
  IC=$'\e[1;32m'   # what you type
else
  B=''; D=''; R=''; G=''; Y=''; Z=''; QC=''; HC=''; NC=''; IC=''
fi
say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  %s[ok]%s %s\n' "$G" "$Z" "$*"; }
warn() { printf '  %s[!]%s %s\n' "$Y" "$Z" "$*" >&2; }
fail() { printf '  %s[x]%s %s\n' "$R" "$Z" "$*" >&2; }
die()  { fail "$*"; exit 1; }
heading() { printf '\n%s== %s ==%s\n' "$HC" "$*" "$Z"; }
hint() { printf '  %s%s%s\n' "$D" "$*" "$Z"; }

LOG=.install.log
STATE=.install-state
ANSWERS_FILE=.install-answers
DRY_RUN=0
FRESH=0
DEPS_ONLY=0
CHECK_REMOTE=""
SSH_TEST=""
CHECK_DB=0
JOIN_PKG=""
PRESET_FILE=""

usage() { sed -n "3,22p" "$0" | sed 's/^# \{0,1\}//'; }

trap 'echo; fail "Interrupted. Run ./install.sh again to carry on where you left off."; exit 130' INT

# ---------------------------------------------------------------------------------------------
# Answers: asked once, or taken from a file / earlier run. Every prompt checks ANS first.
# ---------------------------------------------------------------------------------------------
declare -A ANS=()
declare -A PREV=()   # earlier answers, offered as the default when a question is asked again
ASKED=()   # keys answered at a prompt (not from an answers file): forgotten if you redo the questions

load_answers() { # file
  local line k v
  [[ -f "$1" ]] || die "answers file not found: $1"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line == *=* ]] || continue
    k=${line%%=*}; v=${line#*=}
    [[ $k =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    ANS[$k]=$v
  done <"$1"
}

save_answers() {
  local k
  ( umask 077; : >"$ANSWERS_FILE" )
  for k in $(printf '%s\n' "${!ANS[@]}" | sort); do
    printf '%s=%s\n' "$k" "${ANS[$k]}" >>"$ANSWERS_FILE"
  done
  chmod 600 "$ANSWERS_FILE"
}

load_prev() { # file: earlier answers become defaults (not answers)
  local line
  [[ -f "$1" ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == *=* && $line != \#* ]] || continue
    PREV[${line%%=*}]=${line#*=}
  done <"$1"
}

have() { [[ -n ${ANS[$1]+x} ]]; }
ans() { printf '%s' "${ANS[$1]:-}"; }

# The answer prompt. On a terminal the line is read with readline (-e), so Backspace, Delete, the arrow
# keys and Home/End edit the answer instead of being typed into it (a plain read would store the terminal's
# erase key as text, a literal ^H); the \001 \002 markers tell readline the colour codes take no width.
if [[ -n $IC ]]; then PROMPT_RL=$'\001'"$IC"$'\002'"> "; else PROMPT_RL="> "; fi

read_line() { # [-s]: sets REPLY_LINE; -s does not echo; dies at end of input
  local -a flags=(-r)
  [[ ${1:-} == -s ]] && flags+=(-s)
  if [[ -t 0 ]]; then
    IFS= read -e "${flags[@]}" -p "$PROMPT_RL" REPLY_LINE || die "No input left."
    printf '%s' "$Z"
    [[ ${1:-} == -s ]] && printf '\n'
  else
    printf '%s>%s ' "$IC" "$Z"
    IFS= read "${flags[@]}" REPLY_LINE || die "No input left. Run this in a terminal, or pass --answers FILE with every answer in it."
  fi
  return 0
}

# ask_text KEY "Question" "default" [validator] [hint]
ask_text() {
  local key=$1 q=$2 def=${3-} validator=${4-} h=${5-} v
  if have "$key"; then
    v=${ANS[$key]}
    if [[ -n $validator ]] && ! "$validator" "$v"; then die "The answer $key='$v' is not valid."; fi
    return 0
  fi
  [[ -z ${PREV[$key]+x} ]] || def=${PREV[$key]}
  while :; do
    printf '\n'
    [[ -n $h ]] && hint "$h"
    printf '%s? %s%s' "$QC" "$q" "$Z"
    [[ -n $def ]] && printf ' %s[%s]%s' "$D" "$def" "$Z"
    printf '\n'
    read_line; v=${REPLY_LINE:-$def}
    if [[ -n $validator ]] && ! "$validator" "$v"; then continue; fi
    break
  done
  ANS[$key]=$v; ASKED+=("$key")
}

# ask_secret KEY "Question" [validator]: not echoed
ask_secret() {
  local key=$1 q=$2 validator=${3-} v
  if have "$key"; then
    v=${ANS[$key]}
    if [[ -n $validator ]] && ! "$validator" "$v"; then die "The answer $key is not valid."; fi
    return 0
  fi
  while :; do
    printf '\n%s? %s%s %s(hidden%s)%s\n' "$QC" "$q" "$Z" "$D" "$( [[ -n ${PREV[$key]+x} ]] && echo "; Enter keeps the one you gave before")" "$Z"
    read_line -s; v=$REPLY_LINE
    [[ -n $v || -z ${PREV[$key]+x} ]] || v=${PREV[$key]}
    if [[ -n $validator ]] && ! "$validator" "$v"; then continue; fi
    break
  done
  ANS[$key]=$v; ASKED+=("$key")
}

# ask_yn KEY "Question" yes|no  -> ANS[KEY] is "yes" or "no"
ask_yn() {
  local key=$1 q=$2 def=${3:-yes} v shown
  case "${PREV[$key]:-}" in yes|no) def=${PREV[$key]} ;; esac
  if have "$key"; then
    case "${ANS[$key]}" in y|Y|yes|YES|true|1) ANS[$key]=yes ;; n|N|no|NO|false|0) ANS[$key]=no ;; *) die "The answer $key must be yes or no." ;; esac
    return 0
  fi
  [[ $def == yes ]] && shown='Y/n' || shown='y/N'
  while :; do
    printf '\n%s? %s%s %s[%s]%s\n' "$QC" "$q" "$Z" "$D" "$shown" "$Z"
    read_line; v=${REPLY_LINE:-$def}
    case "$v" in y|Y|yes|YES) ANS[$key]=yes; ASKED+=("$key"); return 0 ;; n|N|no|NO) ANS[$key]=no; ASKED+=("$key"); return 0 ;; esac
    warn "Please answer yes or no."
  done
}

# ask_choice KEY "Question" default_value "value|Label|description" ...
ask_choice() {
  local key=$1 q=$2 def=$3; shift 3
  local -a vals=() labs=() descs=()
  local o v l d i defidx=1 reply
  for o in "$@"; do
    IFS='|' read -r v l d <<<"$o"
    vals+=("$v"); labs+=("$l"); descs+=("$d")
  done
  if [[ -n ${PREV[$key]+x} ]]; then for v in "${vals[@]}"; do [[ $v == "${PREV[$key]}" ]] && def=$v; done; fi
  for i in "${!vals[@]}"; do [[ ${vals[i]} == "$def" ]] && defidx=$((i + 1)); done
  if have "$key"; then
    for v in "${vals[@]}"; do [[ $v == "${ANS[$key]}" ]] && return 0; done
    die "The answer $key='${ANS[$key]}' must be one of: ${vals[*]}"
  fi
  while :; do
    printf '\n%s? %s%s\n' "$QC" "$q" "$Z"
    for i in "${!vals[@]}"; do
      printf '  %s%d)%s %s%s%s\n' "$NC" $((i + 1)) "$Z" "$B" "${labs[i]}" "$Z"
      [[ -n ${descs[i]} ]] && printf '     %s%s%s\n' "$D" "${descs[i]}" "$Z"
    done
    printf '%sChoose a number%s %s[%s]%s\n' "$QC" "$Z" "$D" "$defidx" "$Z"
    read_line; reply=${REPLY_LINE:-$defidx}
    if [[ $reply =~ ^[0-9]+$ ]] && (( reply >= 1 && reply <= ${#vals[@]} )); then ANS[$key]=${vals[reply-1]}; ASKED+=("$key"); return 0; fi
    for v in "${vals[@]}"; do [[ $v == "$reply" ]] && { ANS[$key]=$v; ASKED+=("$key"); return 0; }; done
    warn "Please enter a number from 1 to ${#vals[@]}."
  done
}

# Forget answers so a question is asked again.
forget() { local k; for k in "$@"; do [[ -z ${ANS[$k]+x} || $k == CONFIRM ]] || PREV[$k]=${ANS[$k]}; unset "ANS[$k]"; done; }

# ---------------------------------------------------------------------------------------------
# Validators: print why and return 1.
# ---------------------------------------------------------------------------------------------
v_any() { return 0; }
v_nonempty() { [[ -n $1 ]] || { fail "This cannot be empty."; return 1; }; }
v_port() { [[ $1 =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )) || { fail "Enter a port number between 1 and 65535."; return 1; }; }
v_count() { [[ $1 =~ ^[0-9]+$ ]] && (( $1 >= 2 && $1 <= 9 )) || { fail "Enter a number from 2 to 9."; return 1; }; }
v_host() {
  [[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { fail "That is not a host name or IP address."; return 1; }
}
v_dbhost() {
  v_host "$1" || return 1
  case "$1" in
    localhost|127.*|cockroach-1|cockroach) fail "The containers cannot reach '$1' (it would mean the container itself). Use the server's real address or name."; return 1 ;;
  esac
}
v_nodeid() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { fail "Use letters, digits, '.', '_' and '-' only."; return 1; }; }
# host or host:dbport:rpcport (the ports only matter when several nodes share one machine)
v_entry() {
  local h d r
  IFS=: read -r h d r <<<"$1"
  v_host "$h" || return 1
  [[ -z $d || $d =~ ^[0-9]+$ ]] && [[ -z $r || $r =~ ^[0-9]+$ ]] || { fail "Use host, or host:dbport:rpcport."; return 1; }
}
v_cidrs() {
  local c
  for c in $1; do
    [[ $c =~ ^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$ ]] || { fail "'$c' is not an address or CIDR (for example 10.0.0.0/24)."; return 1; }
  done
}
v_size() { [[ $1 =~ ^[0-9]+[MGT]$ ]] || { fail "Use a number and M, G or T (for example 100G)."; return 1; }; }
# Values written to .env without quoting: nothing that compose or a shell would reinterpret.
v_envsafe() {
  if [[ $1 == *[[:space:]\#\$\"\'\`\\]* ]]; then
    fail "Spaces and the characters # \$ \" ' \` \\ cannot be used here (they are not safe in .env)."
    return 1
  fi
}
v_secretkey() { v_nonempty "$1" && v_envsafe "$1"; }
# One or more database hosts: host or host:port, comma separated. None may be the container itself.
v_dbhosts() {
  local entry h
  [[ -n $1 ]] || { fail "Enter at least one host."; return 1; }
  IFS=, read -ra entries <<<"$1"
  for entry in "${entries[@]}"; do
    [[ $entry =~ ^[[:space:]]*(.*[^[:space:]])[[:space:]]*$ ]] && entry=${BASH_REMATCH[1]}
    h=${entry%%:*}
    [[ $entry =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]+)?$ ]] || { fail "'$entry' is not a host name or IP address (optionally :port)."; return 1; }
    v_dbhost "$h" || return 1
  done
}
v_url() {
  [[ $1 =~ ^postgres(ql)?://[^[:space:]]+@[^[:space:]/]+/[^[:space:]]+$ ]] || { fail "Expected postgresql://user:password@host:port/database (several hosts: host1:port,host2:port)"; return 1; }
  local authority hostlist h
  authority=${1#*://}; authority=${authority%%/*}; hostlist=${authority##*@}
  IFS=, read -ra entries <<<"$hostlist"
  for h in "${entries[@]}"; do
    case "${h%%:*}" in localhost|127.*|cockroach-1|cockroach) fail "The containers cannot reach '${h%%:*}'. Use the server's real address."; return 1 ;; esac
  done
}
v_endpoint() {
  v_envsafe "$1" || return 1
  [[ $1 =~ ^(https?://)?[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { fail "Enter host[:port] or https://host[:port], with no path."; return 1; }
}
v_bucket() { [[ $1 =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || { fail "Bucket names are 3-63 lowercase letters, digits, '.' and '-'."; return 1; }; }
v_garageid() { [[ $1 =~ ^[0-9a-f]{16,64}@[^@[:space:]]+:[0-9]+$ ]] || { fail "Paste the whole line printed by the other node (like 5c1f...@10.0.0.12:3901)."; return 1; }; }
v_path_exists() { [[ -f $1 ]] || { fail "No such file: $1"; return 1; }; }

# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------
rand_hex() { # bytes
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

urlenc() {
  local LC_ALL=C s=$1 i c out='' h
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in [a-zA-Z0-9.~_-]) out+=$c ;; *) printf -v h '%%%02X' "'$c"; out+=$h ;; esac
  done
  printf '%s' "$out"
}

env_read() { # file key
  [[ -f $1 ]] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1 | sed -E 's/[[:space:]]+#.*$//; s/^"(.*)"$/\1/'
}

# env_set FILE KEY VALUE: replace the active line, else the first commented example, else append.
env_set() {
  local f=$1 k=$2 v=$3 line done=0 tmp="$1.tmp.$$"
  : >"$tmp"
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$k="* ]]; then
      (( done )) || { printf '%s=%s\n' "$k" "$v" >>"$tmp"; done=1; }
      continue
    fi
    if (( ! done )) && [[ $line =~ ^#[[:space:]]*"$k"= ]]; then
      printf '%s=%s\n' "$k" "$v" >>"$tmp"; done=1; continue
    fi
    printf '%s\n' "$line" >>"$tmp"
  done <"$f"
  (( done )) || printf '%s=%s\n' "$k" "$v" >>"$tmp"
  mv "$tmp" "$f"
}

detect_ip() {
  local ip=''
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [[ -n $ip ]] || ip=$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)
  printf '%s' "$ip"
}

tcp_open() { timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1; }

port_listening() {
  if command -v ss >/dev/null 2>&1; then ss -tlnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
  elif command -v netstat >/dev/null 2>&1; then netstat -tln 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
  else tcp_open 127.0.0.1 "$1"; fi
}

compose_project() {
  if have ENV_COMPOSE_PROJECT_NAME; then ans ENV_COMPOSE_PROJECT_NAME
  elif [[ $(ans SETUP) == single && $(ans STACK) == standard ]]; then printf 'church'
  else printf 'church-prod'; fi
}

# A port taken by one of this install's own containers is fine (a re-run).
port_free_or_ours() {
  port_listening "$1" || return 0
  docker ps --filter "label=com.docker.compose.project=$(compose_project)" --format '{{.Ports}}' 2>/dev/null | grep -q ":$1->"
}

next_free_port() { local p=$1; while port_listening "$p"; do p=$((p + 1)); done; echo "$p"; }

network_fs() { # path: is it on a network file system?
  local t; t=$(stat -f -c %T "$1" 2>/dev/null || echo unknown)
  case "$t" in nfs*|cifs|smb*|fuse.sshfs|sshfs|9p|ceph|glusterfs|fuse.glusterfs|afs) return 0 ;; *) return 1 ;; esac
}

human_mem_gb() { awk '/^MemTotal:/ {printf "%d", $2/1048576}' /proc/meminfo 2>/dev/null || echo 0; }

# ---------------------------------------------------------------------------------------------
# Running things
# ---------------------------------------------------------------------------------------------
( umask 077; touch "$LOG" ) 2>/dev/null || true

# logrun "label" cmd...: output goes to the log; a heartbeat dot every 15 s for long ones.
logrun() {
  local label=$1 t0=$SECONDS ticker rc; shift
  printf '  %s ' "$label"
  printf '\n$ %s\n' "$*" >>"$LOG"
  ( while :; do sleep 15; printf '.'; done ) & ticker=$!
  "$@" >>"$LOG" 2>&1; rc=$?
  kill "$ticker" 2>/dev/null; wait "$ticker" 2>/dev/null
  if (( rc == 0 )); then
    printf ' %sok%s (%ss)\n' "$G" "$Z" "$((SECONDS - t0))"
    return 0
  fi
  printf ' %sFAILED%s\n' "$R" "$Z"
  [[ -n ${LOGRUN_QUIET:-} ]] && return 1   # the caller says what happened and what it does next
  tail -n 25 "$LOG" | sed 's/^/      /' >&2
  fail "The full output is in $LOG"
  return 1
}

# Docker's image store (containerd) can end up missing a layer it expects: "failed to prepare extraction
# snapshot ... parent snapshot ... does not exist". It is Docker's own state, not ours: a known race when several
# images build at once and share layers, or what an interrupted build or prune leaves behind. So: try again one
# image at a time; if the store is still confused, offer to clear the build cache (not images, not volumes).
BUILD_STORE_ERROR='failed to prepare extraction snapshot|parent snapshot .*does not exist|snapshot [^ ]+ does not exist|content digest .*not found|failed to get digest .*not found'
build_images() { # "label" then the compose command words, without "build"
  local label=$1; shift
  local -a base=("$@")
  local mark; mark=$(wc -c <"$LOG" 2>/dev/null || echo 0)
  LOGRUN_QUIET=1 logrun "$label" "${base[@]}" build && return 0
  if ! tail -c +"$((mark + 1))" "$LOG" | grep -qE "$BUILD_STORE_ERROR"; then
    tail -n 25 "$LOG" | sed 's/^/      /' >&2; fail "The full output is in $LOG"; return 1
  fi
  warn "Docker's image store reports a missing layer (a known problem when several images build at once, or after an interrupted build). Trying again, one image at a time."
  local svc services failed=0
  services=$("${base[@]}" config --services 2>>"$LOG")
  mark=$(wc -c <"$LOG")
  for svc in $services; do
    LOGRUN_QUIET=1 logrun "  building $svc" "${base[@]}" build "$svc" || { failed=1; break; }
  done
  (( failed == 0 )) && return 0
  tail -c +"$((mark + 1))" "$LOG" | grep -qE "$BUILD_STORE_ERROR" || { tail -n 25 "$LOG" | sed 's/^/      /' >&2; fail "The full output is in $LOG"; return 1; }
  warn "Still the same. Docker's build cache looks inconsistent."
  ask_yn AUTO_PRUNE_BUILD_CACHE "Clear Docker's build cache (docker builder prune -f) and build again? Your images, containers and volumes are not touched; the next build is just slower." yes
  if [[ $(ans AUTO_PRUNE_BUILD_CACHE) == yes ]]; then
    logrun "Clearing the build cache" docker builder prune -f || true
    logrun "$label" "${base[@]}" build && return 0
  fi
  fail "The image store is still reporting a missing layer. Things to try, in this order: check free disk space (df -h /var/lib/docker); restart Docker (sudo systemctl restart docker); docker system prune (removes unused images and containers); then run ./install.sh again, which carries on from here."
  return 1
}

stage_done() { [[ -f $STATE ]] && grep -qx "$1" "$STATE"; }
mark_done() { echo "$1" >>"$STATE"; }

# run_stage name "what it does" function: skipped when an earlier run finished it.
run_stage() {
  local name=$1 desc=$2 fn=$3
  if (( DRY_RUN )); then info "would: $desc"; return 0; fi
  if stage_done "$name"; then
    info "[skip] $desc (done in an earlier run)"
  else
    heading "$desc"
    "$fn" || die "That step failed. Fix the cause (see above and $LOG) and run ./install.sh again: finished steps are not repeated."
    mark_done "$name"
  fi
  if [[ ${INSTALL_STOP_AFTER:-} == "$name" ]]; then
    ok "Stopping after '$name' (INSTALL_STOP_AFTER)."
    exit 0
  fi
}

pause() {
  if [[ $(ans NOWAIT) == yes ]]; then info "(not waiting: NOWAIT=yes)"; return 0; fi
  printf '\n%s? %s%s\n%sPress Enter to continue%s\n' "$QC" "$*" "$Z" "$D" "$Z"
  read_line
}

http_ok() {
  if command -v curl >/dev/null 2>&1; then curl -fsS -m 5 -o /dev/null "$1" 2>/dev/null
  else
    local hp=${1#http://}; local host=${hp%%:*}; local rest=${hp#*:}; local port=${rest%%/*}; local path=/${rest#*/}
    timeout 5 bash -c "exec 3<>/dev/tcp/$host/$port; printf 'GET $path HTTP/1.0\r\nHost: $host\r\n\r\n' >&3; head -n1 <&3 | grep -q ' 200 '" 2>/dev/null
  fi
}

wait_for() { # "what" seconds cmd...
  local what=$1 secs=$2 i=0; shift 2
  printf '  waiting for %s ' "$what"
  until "$@" >/dev/null 2>&1; do
    i=$((i + 3)); (( i > secs )) && { printf ' %stimed out%s\n' "$R" "$Z"; return 1; }
    printf '.'; sleep 3
  done
  printf ' %sok%s\n' "$G" "$Z"
}

# ---------------------------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------------------------
# ---------------------------------------------------------------------------------------------
# Versions: every node must run the same code
# ---------------------------------------------------------------------------------------------
in_git_checkout() { command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; }

# Start this installer again, from the (possibly changed) files on disk. The running script must not
# be edited under bash's feet, so after an update it is replaced by a fresh run with the same arguments.
restart_installer() {
  say
  ok "Restarting the installer with the updated version."
  exec bash "$SELF" "${ORIG_ARGS[@]}"
}

# Make this checkout exactly commit $1 (the first node's), without discarding anything of yours.
sync_to_commit() {
  local sha=$1
  in_git_checkout || { fail "This is not a git checkout, so it cannot be updated."; return 1; }
  if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
    fail "This checkout has uncommitted changes, so it was not touched. Commit or stash them (git status), then run again."
    return 1
  fi
  if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
    GIT_TERMINAL_PROMPT=0 git fetch --quiet origin >>"$LOG" 2>&1 || true
  fi
  if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
    GIT_TERMINAL_PROMPT=0 git fetch --quiet origin "$sha" >>"$LOG" 2>&1 || true
  fi
  if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
    fail "This checkout does not have commit ${sha:0:10} even after fetching. The first node may be at a commit that was never pushed: push it there, or use the SSH install, which copies the first node's files."
    return 1
  fi
  if git merge-base --is-ancestor HEAD "$sha" 2>/dev/null; then
    git merge --quiet --ff-only "$sha" >>"$LOG" 2>&1 || { fail "Could not fast-forward to ${sha:0:10} (see $LOG)."; return 1; }
  else
    warn "This checkout has commits that commit ${sha:0:10} does not: switching to it leaves them on their branch."
    git checkout --quiet --detach "$sha" >>"$LOG" 2>&1 || { fail "Could not check out ${sha:0:10} (see $LOG)."; return 1; }
  fi
  ok "This checkout is now at ${sha:0:10}"
}

# At the start: is a newer version of the installer available? Offer to pull it. Quiet and quick when
# there is no network, no upstream, or nothing new.
offer_self_update() {
  in_git_checkout || return 0
  git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 || return 0
  GIT_TERMINAL_PROMPT=0 timeout 10 git fetch --quiet >>"$LOG" 2>&1 || return 0
  local behind; behind=$(git rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)
  [[ $behind =~ ^[0-9]+$ ]] && (( behind > 0 )) || return 0
  info "A newer version is available: $behind new commit(s) on $(git rev-parse --abbrev-ref '@{u}')."
  if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
    warn "This checkout has uncommitted changes, so it cannot be updated automatically (git pull)."
    return 0
  fi
  if ! git merge-base --is-ancestor HEAD '@{u}' 2>/dev/null; then
    warn "This checkout has commits of its own, so it cannot be fast-forwarded: update it by hand."
    return 0
  fi
  ask_yn UPDATE_SELF "Update to the latest version now (git pull)? Every other machine must run the same version, so update this one first." yes
  [[ $(ans UPDATE_SELF) == yes ]] || return 0
  git merge --quiet --ff-only '@{u}' >>"$LOG" 2>&1 || { fail "Could not update (see $LOG). Carrying on with this version."; return 0; }
  restart_installer
}

# ---------------------------------------------------------------------------------------------
# Requirements: check, and with your consent install what is missing (this machine or, over SSH, another)
# ---------------------------------------------------------------------------------------------
# What the machine has, as lines: PM (its package manager), SUDO (root | nopass | pass | none) and MISSING
# (any of: make git tar docker docker-access docker-daemon compose compose-old). Run with bash on the
# machine in question (locally, or over ssh).
read -r -d '' FACTS_SCRIPT <<'FACTS' || true
pm=none
for c in apt-get dnf yum zypper apk pacman; do command -v "$c" >/dev/null 2>&1 && { pm=$c; break; }; done
if [ "$(id -u)" = 0 ]; then sudo=root
elif command -v sudo >/dev/null 2>&1; then if sudo -n true >/dev/null 2>&1; then sudo=nopass; else sudo=pass; fi
else sudo=none; fi
m=""
for t in make git tar; do command -v "$t" >/dev/null 2>&1 || m="$m $t"; done
if ! command -v docker >/dev/null 2>&1; then
  m="$m docker"
else
  if ! out=$(docker info 2>&1); then
    if printf '%s' "$out" | grep -qi 'permission denied'; then m="$m docker-access"; else m="$m docker-daemon"; fi
  fi
  cv=$(docker compose version --short 2>/dev/null | sed 's/^v//; s/[^0-9.].*//')
  if [ -z "$cv" ]; then m="$m compose"
  elif [ "$(printf '%s\n2.20\n' "$cv" | sort -V | head -n 1)" != 2.20 ]; then m="$m compose-old"; fi
fi
echo "PM:$pm"; echo "SUDO:$sudo"; echo "MISSING:$m"
FACTS

pm_install_cmd() { # package-manager "packages"
  case $1 in
    apt-get) echo "DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $2" ;;
    dnf|yum) echo "$1 install -y $2" ;;
    zypper) echo "zypper --non-interactive install $2" ;;
    apk) echo "apk add --no-cache $2" ;;
    pacman) echo "pacman -Sy --noconfirm $2" ;;
  esac
}

# Run a shell command as root on node $1 (1 = this machine); the output goes to the log. Returns non-zero
# when it cannot: no sudo, or a password is needed and there is no terminal to ask on. With a password
# (sudo = pass) the command runs in the foreground so sudo's prompt reaches you.
priv_exec() { # node sudo-mode command
  local node=$1 mode=$2 cmd=$3
  # shellcheck disable=SC2024  # the log is meant to be written by this user, not by root
  if [[ $node == 1 ]]; then
    case $mode in
      root) sh -c "$cmd" >>"$LOG" 2>&1 ;;
      nopass) sudo -n sh -c "$cmd" >>"$LOG" 2>&1 ;;
      pass) [[ -t 0 ]] && sudo -v && sudo -n sh -c "$cmd" >>"$LOG" 2>&1 ;;
      *) return 1 ;;
    esac
  else
    case $mode in
      root) rsh "$node" "sh -c \"$cmd\"" >>"$LOG" 2>&1 ;;
      nopass) rsh "$node" "sudo -n sh -c \"$cmd\"" >>"$LOG" 2>&1 ;;
      pass) [[ -t 0 ]] && ssh_prep "$node" && ssh -t "${SSH_O[@]}" "$SSH_T" "sudo sh -c \"$cmd\"" ;;
      *) return 1 ;;
    esac
  fi
}

# why priv_exec cannot work on a machine
priv_blocker() { # sudo-mode
  case $1 in
    none) echo "it is neither root nor has sudo" ;;
    pass) [[ -t 0 ]] && echo "see $LOG" || echo "sudo needs a password and there is no terminal to ask on (use root or passwordless sudo)" ;;
    *) echo "see $LOG" ;;
  esac
}

facts_of() { # node -> the facts lines
  if [[ $1 == 1 ]]; then bash -c "$FACTS_SCRIPT" 2>/dev/null; else rsh "$1" 'bash -s' <<<"$FACTS_SCRIPT" 2>/dev/null; fi
}

req_text() { # token -> what to tell a person
  case $1 in
    make) echo "make is not installed" ;;
    git) echo "git is not installed" ;;
    tar) echo "tar is not installed" ;;
    docker) echo "Docker is not installed" ;;
    docker-access) echo "this user cannot use Docker (not in the docker group)" ;;
    docker-daemon) echo "Docker is installed but its service is not running" ;;
    compose) echo "the Docker Compose plugin is missing (need v2.20 or newer)" ;;
    compose-old) echo "Docker Compose is older than v2.20" ;;
    *) echo "$1" ;;
  esac
}

reconnect_remote() { # after a group change: a login session keeps its old groups, so make a new one
  ssh_prep "$1" && ssh "${SSH_O[@]}" -O exit "$SSH_T" >/dev/null 2>&1
  remote_connect "$1"
}

# ensure_requirements NODE: checks what the machine has, offers to install what it can (asking first), and
# sets REQ_LEFT to whatever is still missing afterwards. NODE 1 is this machine. Returns 0 when nothing is.
ensure_requirements() {
  local node=$1 where user facts pm sudo missing t pkgs=() left=() tok
  if [[ $node == 1 ]]; then where="this machine"; user=$(id -un)
  else where="$(ans "NODE_${node}_ID") ($SSH_T)"; user=$(node_ssh "$node" USER); fi
  refresh() { facts=$(facts_of "$node") || return 1; pm=$(sed -n 's/^PM://p' <<<"$facts"); sudo=$(sed -n 's/^SUDO://p' <<<"$facts"); missing=$(sed -n 's/^MISSING://p' <<<"$facts"); }
  REQ_LEFT=()
  refresh || { REQ_LEFT=("could-not-check"); return 1; }
  [[ -z ${missing// /} ]] && return 0

  for t in make git tar; do [[ " $missing " == *" $t "* ]] && pkgs+=("$t"); done
  if (( ${#pkgs[@]} )) && [[ $pm != none ]]; then
    ask_yn AUTO_INSTALL_DEPS "$where is missing: ${pkgs[*]}. Install ${pkgs[*]} now with $pm? (needs administrator rights$( [[ $sudo == pass ]] && echo "; you will be asked for your password" ))" yes
    if [[ $(ans AUTO_INSTALL_DEPS) == yes ]]; then
      if priv_exec "$node" "$sudo" "$(pm_install_cmd "$pm" "${pkgs[*]}")"; then
        ok "$where: installed ${pkgs[*]}"
      else
        fail "$where: could not install ${pkgs[*]}: $(priv_blocker "$sudo")."
        info "To do it by hand, as root:  $(pm_install_cmd "$pm" "${pkgs[*]}")"
      fi
      refresh || { REQ_LEFT=("could-not-check"); return 1; }
    fi
  fi

  if [[ " $missing " == *" docker "* ]]; then
    hint "Docker's own install script (https://get.docker.com) installs Docker Engine and the Compose plugin. It needs administrator rights$( [[ $user == root ]] || echo " and adds $user to the docker group")."
    ask_yn AUTO_INSTALL_DOCKER "Docker is not installed on $where. Install it now with Docker's official script (curl -fsSL https://get.docker.com | sh)?" no
    if [[ $(ans AUTO_INSTALL_DOCKER) == yes && $pm != none ]]; then
      local dcmd
      dcmd="command -v curl >/dev/null 2>&1 || { $(pm_install_cmd "$pm" curl); }; curl -fsSL https://get.docker.com | sh$( [[ $user == root ]] || echo " && usermod -aG docker $user")"
      printf '  installing Docker on %s (a few minutes) ...\n' "$where"
      if priv_exec "$node" "$sudo" "$dcmd"; then
        ok "$where: Docker installed, $user added to the docker group"
        if [[ $node == 1 ]]; then REQ_LEFT=("relogin"); return 1; fi
        reconnect_remote "$node" || { fail "Could not reconnect to $where."; REQ_LEFT=("could-not-check"); return 1; }
      else
        fail "$where: the Docker installation did not work: $(priv_blocker "$sudo"). Install Docker by hand: https://docs.docker.com/engine/install/"
      fi
      refresh || { REQ_LEFT=("could-not-check"); return 1; }
    fi
  fi

  if [[ " $missing " == *" docker-access "* ]]; then
    ask_yn AUTO_DOCKER_GROUP "$user cannot use Docker on $where. Add $user to the docker group now?" yes
    if [[ $(ans AUTO_DOCKER_GROUP) == yes ]] && priv_exec "$node" "$sudo" "usermod -aG docker $user"; then
      ok "$where: $user added to the docker group"
      if [[ $node == 1 ]]; then REQ_LEFT=("relogin"); return 1; fi
      reconnect_remote "$node" || { REQ_LEFT=("could-not-check"); return 1; }
      refresh || { REQ_LEFT=("could-not-check"); return 1; }
    fi
  fi

  for tok in $missing; do left+=("$tok"); done
  REQ_LEFT=("${left[@]}")
  (( ${#left[@]} == 0 ))
}

explain_requirements() { # where tokens...
  local where=$1 tok; shift
  fail "$where is not ready:"
  for tok in "$@"; do
    case $tok in
      could-not-check) fail "  could not run the check at all" ;;
      relogin) fail "  Log out and back in (or run: newgrp docker) so the new docker group applies, then run ./install.sh again: it carries on." ;;
      docker-daemon) fail "  $(req_text "$tok"): sudo systemctl enable --now docker" ;;
      compose|compose-old) fail "  $(req_text "$tok"): see https://docs.docker.com/compose/install/linux/" ;;
      *) fail "  $(req_text "$tok")" ;;
    esac
  done
}

preflight() {
  heading "Checking this machine"
  [[ -f scripts/compose.sh && -f .env.example ]] || die "Run this from the root of the church-dashboard checkout (scripts/compose.sh and .env.example must be here)."
  (( DRY_RUN )) && { info "(dry run: skipping the docker checks)"; return 0; }

  if ! ensure_requirements 1; then
    explain_requirements "This machine" "${REQ_LEFT[@]}"
    exit 1
  fi
  local cv; cv=$(docker compose version --short 2>/dev/null | sed 's/^v//; s/[^0-9.].*//')
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), Compose $cv, make and git"

  local mem free
  mem=$(human_mem_gb); free=$(df -Pk . | awk 'NR==2 {printf "%d", $4/1048576}')
  ok "Memory ${mem} GB, free disk here ${free} GB"
  (( free >= 10 )) || warn "Less than 10 GB free here. The images and data need about that much."
}

# ---------------------------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------------------------
# The hosts of a postgres URL, one URL per host (the same credentials and database).
url_hosts() { # url -> lines "host:port"
  local rest=${1#*://} userinfo='' authority hostlist
  authority=${rest%%/*}; hostlist=${authority##*@}
  tr ',' '\n' <<<"$hostlist"
}
url_with_host() { # url host:port
  local scheme=${1%%://*}:// rest=${1#*://} userinfo='' authority tail
  authority=${rest%%/*}; tail=${rest#"$authority"}
  [[ $authority == *@* ]] && userinfo=${authority%@*}@
  printf '%s%s%s%s' "$scheme" "$userinfo" "$2" "$tail"
}

# The app's Postgres driver (pg 8) reads sslmode differently from psql: require, prefer and verify-ca all mean
# verify-full (the certificate must be trusted and name the host); only no-verify means "encrypt, do not check".
# The connection test must behave like the app, or it passes where the app then fails, so translate for psql.
test_url_for_psql() { # url -> the url as psql must see it to behave like the app
  local url=$1 mode
  mode=$(sed -n 's/.*[?&]sslmode=\([^&]*\).*/\1/p' <<<"$url")
  case $mode in
    no-verify) sed 's/\([?&]sslmode=\)no-verify/\1require/' <<<"$url" ;;
    require|prefer|verify-ca|verify-full)
      url=$(sed "s/\([?&]sslmode=\)$mode/\1verify-full/" <<<"$url")
      [[ $url == *sslrootcert=* ]] || url="$url&sslrootcert=system"
      printf '%s' "$url" ;;
    *) printf '%s' "$url" ;;
  esac
}

test_one_host() { # full url with ONE host; prints the output, returns psql's status
  local script
  script=$'psql "$DBURL" -Atc "select version()" || exit 1\npsql "$DBURL" -Atc "select count(*) from pg_extension where extname = \'pgcrypto\'" 2>/dev/null || echo skip'
  DBURL=$(test_url_for_psql "$1") docker run --rm -e DBURL -e PGCONNECT_TIMEOUT=10 postgres:16-alpine sh -c "$script" 2>&1
}

DB_TEST_OUT=""   # what the failing host(s) said, for deciding what to suggest
test_db() { # DATABASE_URL in ANS; 0 = at least one host answered
  local url hostline out rc up=0 total=0 ver first_out=''
  url=$(ans DATABASE_URL); DB_TEST_OUT=""
  logrun "Fetching a small postgres client image" docker pull -q postgres:16-alpine || return 1
  while IFS= read -r hostline; do
    [[ -n $hostline ]] || continue
    total=$((total + 1))
    out=$(test_one_host "$(url_with_host "$url" "$hostline")"); rc=$?
    if (( rc == 0 )); then
      up=$((up + 1)); [[ -n $first_out ]] || first_out=$out
      ok "$hostline answers"
    else
      fail "$hostline did not answer:"
      DB_TEST_OUT+="$out"$'\n'
      printf '%s\n' "$out" | sed -E 's#postgres(ql)?://[^ ]*#<url hidden>#g; s/^/      /' >&2
    fi
  done < <(url_hosts "$url")
  (( up > 0 )) || return 1
  ver=$(printf '%s\n' "$first_out" | head -n 1)
  case "$ver" in
    *CockroachDB*) ok "CockroachDB" ;;
    *-YB-*) ok "YugabyteDB"
      [[ $(printf '%s\n' "$first_out" | tail -n 1) == 0 ]] && warn "YugabyteDB 2024.2 needs the pgcrypto extension. The migrations enable it if this login may CREATE EXTENSION; otherwise ask the DBA to run: CREATE EXTENSION IF NOT EXISTS pgcrypto;" ;;
    *) ok "${ver:0:60}" ;;
  esac
  (( up == total )) || warn "$up of $total hosts answered. The dashboard will use the ones that do, and switch to the others when they come back."
  return 0
}

# The URL from the pieces asked for: every host (the default port for those without one), the login, the
# database and the encryption choice.
build_db_url() {
  local hostlist='' entry
  IFS=, read -ra entries <<<"$(ans DB_HOST)"
  for entry in "${entries[@]}"; do
    entry=${entry// /}
    [[ $entry == *:* ]] || entry="$entry:$(ans DB_PORT)"
    hostlist+="${hostlist:+,}$entry"
  done
  printf 'postgresql://%s:%s@%s/%s?sslmode=%s' "$(urlenc "$(ans DB_USER)")" "$(urlenc "$(ans DB_PASSWORD)")" "$hostlist" "$(urlenc "$(ans DB_NAME)")" "$(ans DB_SSL)"
}

url_sslmode() { sed -n 's/.*[?&]sslmode=\([^&]*\).*/\1/p' <<<"$1"; }
# True when the URL asks for the certificate to be checked (in this app require, prefer and verify-ca do too)
url_verifies() { case $(url_sslmode "$1") in require|prefer|verify-ca|verify-full) return 0 ;; *) return 1 ;; esac; }
url_with_sslmode() { # url mode
  if [[ $1 == *sslmode=* ]]; then sed "s/\([?&]sslmode=\)[^&]*/\1$2/" <<<"$1"
  elif [[ $1 == *\?* ]]; then printf '%s&sslmode=%s' "$1" "$2"
  else printf '%s?sslmode=%s' "$1" "$2"; fi
}

# A certificate the containers do not trust: the failure that has an easy, informed way out.
db_cert_untrusted() { grep -qiE 'certificate verify failed|self[- ]signed|unable to get (local )?issuer|certificate has expired|SSL error' <<<"$DB_TEST_OUT"; }

ask_database() {
  heading "Database"
  ask_choice DB_MODE "Where should the database live?" bundled \
    "bundled|Bundled CockroachDB|Runs inside this install. Nothing to set up. The right choice for most churches." \
    "external|A database I already run|YugabyteDB or CockroachDB that you manage. The dashboard only needs a login and an empty database."
  [[ $(ans DB_MODE) == external ]] || return 0

  while :; do
    ask_choice DB_INPUT "How do you want to give the connection details?" parts \
      "parts|Fill in host, port, user and password|The installer builds the connection URL for you." \
      "url|Paste a connection URL|postgresql://user:password@host:5433/church?sslmode=verify-full (several hosts: host1:5433,host2:5433,host3:5433)"
    if [[ $(ans DB_INPUT) == parts ]]; then
      ask_choice DB_ENGINE "Which database is it?" yugabyte \
        "yugabyte|YugabyteDB|YSQL, port 5433 by default" \
        "cockroach|CockroachDB|port 26257 by default" \
        "other|Another PostgreSQL-compatible database|you give the port"
      local defport=5433; [[ $(ans DB_ENGINE) == cockroach ]] && defport=26257
      ask_text DB_HOST "Database host(s), comma separated (the containers must be able to reach them; not localhost)" "" v_dbhosts \
        "If the database is a cluster, list EVERY node: db1.example.org,db2.example.org,db3.example.org. The dashboard connects to whichever answers, spreads its connections over them and moves to another when one fails, so no load balancer is needed. One host works too, but then that host is a single point of failure (unless it is a load balancer's address)."
      ask_text DB_PORT "Port (used for any host above that does not give its own)" "$defport" v_port
      ask_text DB_NAME "Database name (it must already exist)" church v_envsafe
      ask_text DB_USER "Database user" church v_envsafe
      ask_secret DB_PASSWORD "Database password" v_nonempty
      ask_choice DB_SSL "Encrypt the connection?" verify-full \
        "verify-full|Yes, and check the certificate|The safe choice. The database's certificate must be from a CA the containers trust (a public one, such as Let's Encrypt) and name the host you gave." \
        "no-verify|Yes, but do not check the certificate|For a database with a self-signed certificate or a private CA. The traffic is encrypted, but a machine pretending to be the database would not be noticed." \
        "disable|No encryption|Only on a network you trust."
      ANS[DATABASE_URL]=$(build_db_url)
    else
      ask_text DATABASE_URL "Connection URL" "" v_url
      case $(url_sslmode "$(ans DATABASE_URL)") in
        require|prefer|verify-ca)
          warn "sslmode=$(url_sslmode "$(ans DATABASE_URL)") means VERIFY the certificate in this app (unlike psql). For encryption without checking it, use sslmode=no-verify." ;;
      esac
    fi
    if (( DRY_RUN )); then break; fi
    ask_yn DB_TEST "Test the connection now? (starts a small postgres client container)" yes
    [[ $(ans DB_TEST) == yes ]] || break
    test_db && break
    if url_verifies "$(ans DATABASE_URL)" && db_cert_untrusted; then
      info "The database answered, but its certificate is not trusted (self-signed, or from a private CA)."
      ask_yn DB_SSL_FALLBACK "Encrypt the connection without checking the certificate instead (sslmode=no-verify)?" yes
      if [[ $(ans DB_SSL_FALLBACK) == yes ]]; then
        if [[ $(ans DB_INPUT) == parts ]]; then ANS[DB_SSL]=no-verify; ANS[DATABASE_URL]=$(build_db_url)
        else ANS[DATABASE_URL]=$(url_with_sslmode "$(ans DATABASE_URL)" no-verify); fi
        test_db && break
      fi
    fi
    ask_choice DB_FAIL "What now?" again \
      "again|Enter the details again|" \
      "continue|Continue anyway|You can fix the database later and run ./install.sh again." \
      "abort|Stop here|"
    case $(ans DB_FAIL) in
      continue) break ;;
      abort) die "Stopped. Nothing has been started." ;;
    esac
    forget DB_INPUT DB_ENGINE DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL DATABASE_URL DB_TEST DB_FAIL DB_SSL_FALLBACK
  done
}

ask_objectstore() {
  heading "File storage (uploads: wiki attachments, note images)"
  ask_choice S3_MODE "Where should uploaded files be kept?" bundled \
    "bundled|Bundled Garage|An S3-compatible store inside this install. Nothing to set up." \
    "external|My own S3-compatible store|AWS S3, Backblaze B2, MinIO, your own Garage. The bucket must already exist."
  if [[ $(ans S3_MODE) == bundled ]]; then
    local meta_default=/var/lib/church-garage-meta
    if network_fs .; then
      warn "This folder is on a network file system. The bundled store's metadata must be on local disk (it refuses to start otherwise)."
      ask_text GARAGE_META_DIR "Local folder for the object store's metadata" "$meta_default" v_envsafe \
        "Created for you if possible."
    elif have GARAGE_META_DIR; then
      v_envsafe "$(ans GARAGE_META_DIR)" || die "GARAGE_META_DIR is not valid."
    fi
    return 0
  fi
  ask_text S3_ENDPOINT "Store address (host[:port], or https://host[:port])" "" v_endpoint "For example s3.example.org, or https://s3.us-west-004.backblazeb2.com"
  ask_text S3_BUCKET "Bucket name (it must already exist)" church-files v_bucket
  ask_text S3_ACCESS_KEY "Access key" "" v_secretkey
  ask_secret S3_SECRET_KEY "Secret key" v_secretkey
  local region_def=us-east-1
  ask_text S3_REGION "Region" "$region_def" v_envsafe "A Garage or MinIO store usually wants the region it was configured with (Garage: garage)."
  local style_def=yes
  [[ $(ans S3_ENDPOINT) == *amazonaws.com* ]] && style_def=no
  ask_yn S3_PATH_STYLE "Use path-style addressing (host/bucket/key)? Yes for Garage, MinIO and most self-hosted stores; no for AWS S3." "$style_def"
  [[ $(ans S3_PATH_STYLE) == no ]] && warn "Only path-style addressing has been tested. Virtual-hosted style (AWS S3) is untried: uploads are the first thing to check after installing."
  info "The installer cannot test the bucket without the app. After it starts, upload a file in a note or wiki page to confirm."
}

ask_network() {
  heading "Network"
  ask_text EXTERNAL_PORT "Port to serve the dashboard on" 8100 v_port "This is the only port users or your load balancer need."
  if [[ $(ans SETUP) == cluster ]]; then
    ask_text TRUSTED_PROXIES "Your load balancer's address(es), space separated CIDRs (blank = trust any)" "" v_cidrs \
      "Set this so audit logs and rate limits see real client addresses. Example: 10.0.0.0/24"
  else
    ask_yn BEHIND_LB "Will a load balancer or reverse proxy sit in front of this server?" no
    if [[ $(ans BEHIND_LB) == yes ]]; then
      ask_text TRUSTED_PROXIES "Its address(es), space separated CIDRs (blank = trust any)" "" v_cidrs \
        "Example: 10.0.0.5/32. HTTPS is expected to end at the load balancer."
    fi
  fi
}

node_letter() { local s=abcdefghi; printf '%s' "${s:$(( $1 - 1 )):1}"; }

ask_cluster_nodes() {
  heading "The nodes"
  info "Every node needs a unique name. Write down the addresses: the nodes reach each other on them."
  local c_db=0 c_s3=0
  [[ $(ans DB_MODE) == bundled ]] && c_db=1
  [[ $(ans S3_MODE) == bundled ]] && c_s3=1
  ask_text NODES "How many nodes will there be in total?" 3 v_count
  local n; n=$(ans NODES)
  if (( n == 2 && c_db && c_s3 )); then
    hint "Two nodes cannot fail over: losing either stops writes. A third, small server that only runs the database and"
    hint "object store (a witness) fixes that."
    ask_yn WITNESS "Add a witness as a third node?" yes
    if [[ $(ans WITNESS) == yes ]]; then n=3; ANS[NODES]=3; ANS[NODE_3_ROLE]=data; fi
  fi
  local i ipdef
  for ((i = 1; i <= n; i++)); do
    printf '\n%sNode %d%s\n' "$B" "$i" "$Z"
    ask_text "NODE_${i}_ID" "  Name" "node-$(node_letter "$i")" v_nodeid
    if (( c_db || c_s3 )); then
      ipdef=''; (( i == 1 )) && ipdef=$(detect_ip)
      ask_text "NODE_${i}_ADDR" "  Address the other nodes reach it on (IP or DNS name)" "$ipdef" v_entry \
        "$( ((i == 1)) && echo "Node 1 is this machine." )"
    fi
    have "NODE_${i}_ROLE" || ANS["NODE_${i}_ROLE"]=full
  done
  local ids='' k
  for ((i = 1; i <= n; i++)); do
    for ((k = i + 1; k <= n; k++)); do
      [[ $(ans "NODE_${i}_ID") != "$(ans "NODE_${k}_ID")" ]] || die "Two nodes are both called '$(ans "NODE_${i}_ID")': names must be unique."
    done
  done
  (( c_s3 )) && ask_text CLUSTER_S3_CAPACITY "How much disk may each node offer for uploaded files? (a ceiling, not reserved)" 100G v_size
  ask_remote
  return 0
}

v_sshuser() { [[ $1 =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]] || { fail "That is not a user name."; return 1; }; }
v_sshkey() { [[ -z $1 || -r $1 ]] || { fail "Cannot read $1."; return 1; }; }
v_remotedir() { v_envsafe "$1" && [[ -n $1 && $1 != -* ]] || { fail "Enter a folder name (not starting with '-', no spaces)."; return 1; }; }

ask_remote() {
  heading "The other machines"
  ask_choice REMOTE_MODE "How should the other machines be installed?" ssh \
    "ssh|Automatically over SSH|The installer connects to each machine, copies what it needs, installs there and starts everything, all from here. Each machine needs SSH access, Docker (Compose 2.20+), git and make. If one asks for a password, ssh asks you for it once." \
    "manual|I will copy the packages myself|The installer makes a package per machine; you copy it over and run ./install.sh --join there."
  [[ $(ans REMOTE_MODE) == ssh ]] || return 0
  ask_text REMOTE_DIR "Install folder on the other machines (in the SSH user's home)" church-dashboard v_remotedir \
    "The code is copied here. Docker's data folders live inside it."
  ask_text SSH_KEY "SSH private key file (blank: your ssh agent, default keys, or a password)" "" v_sshkey
  ask_text SSH_USER "SSH user on the other machines" "$(id -un)" v_sshuser
  ask_text SSH_PORT "SSH port" 22 v_port
  ask_yn SSH_SAME "Same SSH user and port on every other machine?" yes
  local i h
  for ((i = 2; i <= $(ans NODES); i++)); do
    split_entry "$(ans "NODE_${i}_ADDR")"; h=$ENTRY_HOST
    printf '\n%s%s%s\n' "$B" "$(ans "NODE_${i}_ID")" "$Z"
    ask_text "NODE_${i}_SSH_HOST" "  Host to connect to over SSH" "$h" v_host
    if [[ $(ans SSH_SAME) == yes ]]; then
      ANS["NODE_${i}_SSH_USER"]=${ANS["NODE_${i}_SSH_USER"]:-$(ans SSH_USER)}
      ANS["NODE_${i}_SSH_PORT"]=${ANS["NODE_${i}_SSH_PORT"]:-$(ans SSH_PORT)}
    else
      ask_text "NODE_${i}_SSH_USER" "  SSH user" "$(ans SSH_USER)" v_sshuser
      ask_text "NODE_${i}_SSH_PORT" "  SSH port" "$(ans SSH_PORT)" v_port
    fi
  done
  if bundled_s3; then
    ask_text REMOTE_GARAGE_META_DIR "Local folder for the object store's metadata on the other machines (blank: inside the install folder; NOT a network share)" "" v_envsafe
  fi
}

ask_stack() {
  heading "Stack"
  local mem; mem=$(human_mem_gb)
  local def=production
  if [[ $(ans DB_MODE) == bundled ]] && (( mem > 0 && mem < 6 )); then def=standard; fi
  ask_choice STACK "Which stack do you want to run?" "$def" \
    "production|Production|Production settings. With the bundled database this runs three database containers on this one machine (about 3 GB more memory; it survives a database container dying, not the machine). With your own database it is the lightest real choice." \
    "standard|Standard|One database container, development-mode settings. Fine for a trial or a small install on one machine."
}

ask_secrets() {
  heading "Secrets"
  local existing; existing=$(env_read .env AUTH_SECRET)
  if [[ -n $existing && $existing != replace-me-* ]] && ! have AUTH_SECRET; then
    ANS[AUTH_SECRET]=$existing
    ok "Keeping the AUTH_SECRET from the current .env (changing it would log everyone out and make saved SMTP/OAuth secrets unreadable)."
  elif have AUTH_SECRET; then
    ok "Using the AUTH_SECRET you supplied."
  else
    ask_yn REUSE_SECRET "Are you restoring a backup or moving servers, so you already have an AUTH_SECRET to reuse?" no
    if [[ $(ans REUSE_SECRET) == yes ]]; then
      ask_secret AUTH_SECRET "Your existing AUTH_SECRET" v_secretkey
    else
      ANS[AUTH_SECRET]=$(rand_hex 32)
      ok "Generated a new AUTH_SECRET."
    fi
  fi
  local meili; meili=$(env_read .env MEILI_MASTER_KEY)
  if have MEILI_MASTER_KEY; then :
  elif [[ -n $meili && $meili != dev-master-key-change-in-prod ]]; then ANS[MEILI_MASTER_KEY]=$meili
  else ANS[MEILI_MASTER_KEY]=$(rand_hex 16); fi
  ok "Search key ready."
}

shape_letter() {
  if [[ $(ans SETUP) == cluster ]]; then [[ $(ans DB_MODE) == bundled ]] && echo C || echo D
  else [[ $(ans DB_MODE) == bundled ]] && echo A || echo B; fi
}

summary() {
  heading "Review"
  local s; s=$(shape_letter)
  info "Shape:         $s ($( [[ $(ans SETUP) == cluster ]] && echo "several servers" || echo "one server" ), $( [[ $(ans DB_MODE) == bundled ]] && echo "bundled database" || echo "your own database" ))"
  [[ $(ans SETUP) == single ]] && info "Stack:         $(ans STACK)"
  info "Database:      $(ans DB_MODE)$( [[ $(ans DB_MODE) == external ]] && echo " ($(ans DATABASE_URL | sed -E 's#(://[^:/@]*):[^@]*@#\1:***@#'))" )"
  info "Files:         $(ans S3_MODE)$( [[ $(ans S3_MODE) == external ]] && echo " ($(ans S3_ENDPOINT), bucket $(ans S3_BUCKET))" )"
  info "Port:          $(ans EXTERNAL_PORT)"
  [[ -n $(ans TRUSTED_PROXIES) ]] && info "Load balancer: $(ans TRUSTED_PROXIES)"
  if [[ $(ans SETUP) == cluster ]]; then
    if [[ $(ans REMOTE_MODE) == ssh ]]; then
      info "Other nodes:   installed over SSH from here (folder ~/$(ans REMOTE_DIR))"
    else
      info "Other nodes:   you copy a package to each and run ./install.sh --join"
    fi
    local i; for ((i = 1; i <= $(ans NODES); i++)); do
      info "Node $i:        $(ans "NODE_${i}_ID")  $(ans "NODE_${i}_ADDR")$( [[ $(ans "NODE_${i}_ROLE") == data ]] && echo "  (witness)" )$( ((i == 1)) && echo "  <- this machine" )$( ((i > 1)) && [[ $(ans REMOTE_MODE) == ssh ]] && echo "  (ssh $(ans "NODE_${i}_SSH_USER")@$(ans "NODE_${i}_SSH_HOST"))" )"
    done
  fi
  local preset=0; have CONFIRM && preset=1
  ask_yn CONFIRM "Write the configuration and install?" yes
  if [[ $(ans CONFIRM) != yes ]]; then
    (( preset )) && die "Cancelled. Nothing was changed."
    return 1
  fi
}

# ---------------------------------------------------------------------------------------------
# .env
# ---------------------------------------------------------------------------------------------
split_entry() { IFS=: read -r ENTRY_HOST ENTRY_DB ENTRY_RPC <<<"$1"; }

# write_env FILE NODE_INDEX: the complete .env for node NODE_INDEX (1 = this machine).
write_env() {
  local f=$1 idx=$2 i k peers=''
  cp .env.example "$f"
  env_set "$f" AUTH_SECRET "$(ans AUTH_SECRET)"
  env_set "$f" MEILI_MASTER_KEY "$(ans MEILI_MASTER_KEY)"
  env_set "$f" EXTERNAL_PORT "$(ans EXTERNAL_PORT)"
  [[ -n $(ans TRUSTED_PROXIES) ]] && env_set "$f" TRUSTED_PROXIES "$(ans TRUSTED_PROXIES)"
  if [[ $(ans STACK) == production || $(ans SETUP) == cluster ]]; then env_set "$f" NODE_ENV production; fi
  env_set "$f" DB_MODE "$(ans DB_MODE)"
  [[ $(ans DB_MODE) == external ]] && env_set "$f" DATABASE_URL "$(ans DATABASE_URL)"
  env_set "$f" S3_MODE "$(ans S3_MODE)"
  if [[ $(ans S3_MODE) == external ]]; then
    env_set "$f" S3_ENDPOINT "$(ans S3_ENDPOINT)"
    env_set "$f" S3_BUCKET "$(ans S3_BUCKET)"
    env_set "$f" S3_ACCESS_KEY "$(ans S3_ACCESS_KEY)"
    env_set "$f" S3_SECRET_KEY "$(ans S3_SECRET_KEY)"
    env_set "$f" S3_REGION "$(ans S3_REGION)"
    [[ $(ans S3_PATH_STYLE) == yes ]] && env_set "$f" S3_PATH_STYLE true || env_set "$f" S3_PATH_STYLE false
  fi
  if (( idx == 1 )); then
    [[ -n $(ans GARAGE_META_DIR) ]] && env_set "$f" GARAGE_META_DIR "$(ans GARAGE_META_DIR)"
    [[ -n $(ans COCKROACH_UI_PORT) ]] && env_set "$f" COCKROACH_UI_PORT "$(ans COCKROACH_UI_PORT)"
  fi
  if [[ $(ans SETUP) == cluster ]]; then
    env_set "$f" DEPLOY_MODE cluster
    env_set "$f" NODE_ID "$(ans "NODE_${idx}_ID")"
    if [[ $(ans DB_MODE) == bundled || $(ans S3_MODE) == bundled ]]; then
      split_entry "$(ans "NODE_${idx}_ADDR")"
      env_set "$f" NODE_ADDR "$ENTRY_HOST"
      [[ -n $ENTRY_DB ]] && env_set "$f" CLUSTER_DB_PORT "$ENTRY_DB"
      [[ -n $ENTRY_RPC ]] && env_set "$f" CLUSTER_S3_RPC_PORT "$ENTRY_RPC"
      for ((i = 1; i <= $(ans NODES); i++)); do
        (( i == idx )) && continue
        peers+="${peers:+,}$(ans "NODE_${i}_ADDR")"
      done
      env_set "$f" CLUSTER_PEERS "$peers"
      [[ -n $(ans CLUSTER_S3_CAPACITY) ]] && env_set "$f" CLUSTER_S3_CAPACITY "$(ans CLUSTER_S3_CAPACITY)"
      [[ $(ans "NODE_${idx}_ROLE") == data ]] && env_set "$f" NODE_ROLE data
    fi
  fi
  if (( idx == 1 )); then
    for k in $(printf '%s\n' "${!ANS[@]}" | sort); do
      [[ $k == ENV_* ]] && env_set "$f" "${k#ENV_}" "${ANS[$k]}"
    done
  fi
  chmod 600 "$f"
}

install_env() {
  local ts new=".env.new.$$"; ts=$(date +%Y%m%d-%H%M%S)
  write_env "$new" 1
  if [[ -f .env ]] && cmp -s .env "$new"; then
    rm -f "$new"; ok ".env is already up to date"; return 0
  fi
  if [[ -f .env ]]; then
    cp -p .env ".env.bak-$ts"
    ok "The existing .env is saved as .env.bak-$ts"
  fi
  mv "$new" .env
  ok "Wrote .env"
}

# ---------------------------------------------------------------------------------------------
# Stacks
# ---------------------------------------------------------------------------------------------
setup_compose() {
  COMPOSE=(bash scripts/compose.sh)
  [[ $(ans SETUP) == cluster || $(ans STACK) == production ]] && COMPOSE=(bash scripts/compose.sh --prod)
  if have ENV_COMPOSE_PROJECT_NAME; then COMPOSE_PROJECT_NAME=$(ans ENV_COMPOSE_PROJECT_NAME); export COMPOSE_PROJECT_NAME; fi
}

st_prep() {
  logrun "Creating the data folders" make -s init-data || return 1
  if [[ -n $(ans GARAGE_META_DIR) ]]; then
    local d; d=$(ans GARAGE_META_DIR)
    if [[ ! -d $d ]]; then
      mkdir -p "$d" 2>/dev/null || { info "Creating $d needs administrator rights:"; sudo mkdir -p "$d" && sudo chown "$(id -u):$(id -g)" "$d"; } || return 1
    fi
    [[ -w $d ]] || { fail "$d exists but this user cannot write to it."; return 1; }
    ok "Object store metadata folder: $d"
  fi
  return 0
}

st_ports() {
  local ok_all=1 p label
  if [[ $(ans SETUP) == single && $(ans STACK) == standard && $(ans DB_MODE) == bundled ]]; then
    local ui; ui=$(env_read .env COCKROACH_UI_PORT); ui=${ui:-8180}
    if ! port_free_or_ours "$ui"; then
      local np; np=$(next_free_port "$((ui + 1))")
      env_set .env COCKROACH_UI_PORT "$np"; ANS[COCKROACH_UI_PORT]=$np
      info "Port $ui is taken; the database admin page will use $np instead."
    fi
  fi
  local -a checks=("$(ans EXTERNAL_PORT)|the dashboard")
  if [[ $(ans SETUP) == cluster ]]; then
    split_entry "$(ans NODE_1_ADDR)"
    [[ $(ans DB_MODE) == bundled ]] && checks+=("${ENTRY_DB:-26257}|the cluster database")
    [[ $(ans S3_MODE) == bundled ]] && checks+=("${ENTRY_RPC:-3901}|the object store")
  fi
  for c in "${checks[@]}"; do
    p=${c%%|*}; label=${c#*|}
    if port_free_or_ours "$p"; then ok "Port $p is free ($label)"
    else fail "Port $p ($label) is already in use by something else. Re-run and choose another port."; ok_all=0; fi
  done
  (( ok_all ))
}

st_build_single() { build_images "Building the images (the first time takes 5-10 minutes)" "${COMPOSE[@]}"; }

# The application cannot start on an empty database (it reads its settings at boot), so the
# database comes up first, then migrate and seed run in one-off containers, then the application.
st_db_single() {
  [[ $(ans DB_MODE) == bundled ]] || { ok "Using your own database: nothing to start."; return 0; }
  local svcs; svcs=$("${COMPOSE[@]}" config --services 2>>"$LOG" | grep -E '^cockroach' | tr '\n' ' ')
  [[ -n $svcs ]] || { fail "Could not work out which database services to start."; return 1; }
  # shellcheck disable=SC2086
  logrun "Starting the database ($svcs)" "${COMPOSE[@]}" up -d $svcs
}

# Output that means "the database is not there yet" (worth waiting for), as opposed to an error in what ran.
TRANSIENT_DB_ERROR='ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|timeout expired|connection timeout|Connection terminated|starting up|cannot connect now|57P03|53300|3D000|could not connect|Name or service not known|no route to host'

oneoff_api() { # script name: run it in a one-off container, retrying ONLY while the database is not reachable yet
  local script=$1 tries=40 i first_out='' out
  [[ $(ans DB_MODE) == external ]] && tries=6
  out=$(mktemp)
  printf '  running %s ' "$script"
  for ((i = 0; i < tries; i++)); do
    if "${COMPOSE[@]}" run -T --rm --no-deps api node "dist/scripts/$script.js" >"$out" 2>&1; then
      cat "$out" >>"$LOG"; rm -f "$out"; printf ' %sok%s\n' "$G" "$Z"; return 0
    fi
    cat "$out" >>"$LOG"
    [[ -n $first_out ]] || first_out=$(cat "$out")
    # An error that is not about reaching the database will not go away by trying again, and for a migration
    # a retry can run on top of a half-applied step: stop and show it.
    grep -qE "$TRANSIENT_DB_ERROR" "$out" || break
    printf '.'; sleep 3
  done
  printf ' %sFAILED%s\n' "$R" "$Z"
  # What went wrong, from the FIRST failure (a later attempt would only show the mess the first one left)
  {
    printf '%s\n' "$first_out" | grep -E '^\[(migrate|seed)\]|^ *(error|Error)|code:' | head -12
    printf '%s\n' "$first_out" | tail -n 6
  } | sed 's/^/      /' >&2
  rm -f "$out"
  fail "It did not run. If the message is about reaching the database, check its address, login and certificate settings; otherwise see $LOG (the first failure is the one that matters)."
  return 1
}
st_migrate_single() { oneoff_api migrate; }
st_seed_single() { oneoff_api seed; }
st_start_single() { logrun "Starting the application" "${COMPOSE[@]}" up -d; }

st_health() {
  wait_for "the dashboard to answer on port $(ans EXTERNAL_PORT)" 240 http_ok "http://127.0.0.1:$(ans EXTERNAL_PORT)/healthz" || {
    fail "It did not come up in time. Look at: ${COMPOSE[*]} logs --tail=100"; return 1; }
}

run_single() {
  setup_compose
  run_stage prep "Preparing" st_prep
  run_stage ports "Checking ports" st_ports
  run_stage build "Building" st_build_single
  run_stage db "Starting the database" st_db_single
  run_stage migrate "Migrating the database" st_migrate_single
  run_stage seed "Seeding the defaults" st_seed_single
  run_stage start "Starting the stack" st_start_single
  run_stage health "Waiting for the dashboard" st_health
}

# ---- cluster ----------------------------------------------------------------------------------
cc() { bash scripts/cluster.sh "$@"; }
bundled_db() { [[ $(ans DB_MODE) == bundled ]]; }
bundled_s3() { [[ $(ans S3_MODE) == bundled ]]; }
node_host() { split_entry "$(ans "NODE_$1_ADDR")"; printf '%s' "$ENTRY_HOST"; }

st_certs() {
  local hosts=() i h seen=' '
  for ((i = 1; i <= $(ans NODES); i++)); do
    h=$(node_host "$i")
    [[ $seen == *" $h "* ]] || { hosts+=("$h"); seen+="$h "; }
  done
  logrun "Creating the certificate authority and one certificate bundle per node" cc init-certs "${hosts[@]}" || return 1
  logrun "Installing this node's certificates" cc install-certs "data/cluster-certs/$(node_host 1 | tr ':/' '__')"
}

st_packages() {
  local i d pkg commit dirty=''
  commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)
  [[ -n $(git status --porcelain 2>/dev/null) ]] && dirty=dirty
  [[ -z $dirty ]] || warn "This checkout has uncommitted changes. Every node must run the same code: commit them, or copy this exact checkout to the other nodes."
  mkdir -p data/cluster-packages; chmod 700 data/cluster-packages
  for ((i = 2; i <= $(ans NODES); i++)); do
    d=$(mktemp -d); chmod 700 "$d"
    write_env "$d/.env" "$i"
    if bundled_db; then
      mkdir -p "$d/certs"
      cp "data/cluster-certs/$(node_host "$i" | tr ':/' '__')"/{ca.crt,node.crt,node.key,client.root.crt,client.root.key} "$d/certs/" || return 1
    fi
    printf '%s %s\n' "$commit" "$dirty" >"$d/COMMIT"
    pkg="data/cluster-packages/church-node-$(ans "NODE_${i}_ID").tar.gz"
    ( umask 077; tar -czf "$pkg" -C "$d" . ) || return 1
    rm -rf "$d"
    ok "Package for $(ans "NODE_${i}_ID"): $pkg"
  done
  if remote_ssh; then
    info "The packages go to the other machines over SSH in the next step."
    return 0
  fi
  cat <<EOF

  Each package holds that node's .env, which contains the secrets (AUTH_SECRET, database and
  storage keys), and its certificates. Copy one to each machine over a channel you trust
  (scp, a USB stick) and delete it from the machine afterwards. On each other machine, with
  this repository checked out at the same commit:

      ./install.sh --join church-node-<name>.tar.gz

  You can start those now: they build their images and start their database while this
  machine carries on.
EOF
}

st_build() { build_images "Building the images (the first time takes 5-10 minutes)" bash scripts/compose.sh --prod; }

st_start_data() { logrun "Starting the database and object store on this node" cc start-data; }

peer_ports_open() { # every other node's database/object store ports answer
  local i h ok_all=0
  for ((i = 2; i <= $(ans NODES); i++)); do
    split_entry "$(ans "NODE_${i}_ADDR")"
    if bundled_db && ! tcp_open "$ENTRY_HOST" "${ENTRY_DB:-26257}"; then ok_all=1; fi
    if bundled_s3 && ! tcp_open "$ENTRY_HOST" "${ENTRY_RPC:-3901}"; then ok_all=1; fi
  done
  return $ok_all
}

st_wait_peers() {
  if ! bundled_db && ! bundled_s3; then return 0; fi
  remote_ssh || pause "Start the other nodes now (./install.sh --join ...). When each has printed its node id (or 'Waiting for the first node'), continue here."
  wait_for "every other node's database and object store ports (open on the nodes' firewalls?)" 900 peer_ports_open || {
    fail "The other nodes' database and object store ports must be reachable from this machine (see INSTALL.md, Requirements)."
    return 1; }
}

st_init_db() { bundled_db || return 0; logrun "Forming the database cluster" cc init-db; }

# Every database node must have joined before the object store and the migrations. A node that was started
# long before the first one existed can wait for ever: restarting its database makes it join at once.
st_db_members() {
  bundled_db || return 0
  local want i dir; want=$(ans NODES)
  if wait_for "the $want database nodes to join" 90 cc db-members "$want" 1; then return 0; fi
  warn "Not every database node has joined. A node that started long before the first one can stall; restarting its database fixes that."
  if remote_ssh; then
    remote_connect_all || return 1
    for ((i = 2; i <= want; i++)); do
      dir=$(remote_dir "$i")
      logrun "Restarting the database on $(ans "NODE_${i}_ID")" rsh "$i" "cd -- '$dir' && bash scripts/compose.sh --prod restart cockroach" || return 1
    done
  else
    pause "On each other machine run:  scripts/compose.sh --prod restart cockroach"
  fi
  wait_for "the $want database nodes to join" 150 cc db-members "$want" 1 || {
    fail "The other database nodes did not join. Check that their database ports are reachable from each other (INSTALL.md, Requirements) and look at: scripts/cluster.sh status"
    return 1; }
}

st_garage() {
  bundled_s3 || return 0
  local ids=() i
  if remote_ssh; then remote_peer_ids || return 1; fi
  for ((i = 2; i <= $(ans NODES); i++)); do
    ask_text "PEERID_$i" "Node id line from $(ans "NODE_${i}_ID") (the line the --join run printed)" "" v_garageid \
      "It looks like 5c1f...@10.0.0.12:3901 and is also in data/node-id.txt on that node."
    ids+=("$(ans "PEERID_$i")")
  done
  save_answers
  logrun "Forming the object store across the nodes" cc garage-bootstrap "${ids[@]}"
}

st_migrate_cluster() { logrun "Applying database migrations" cc migrate; }
st_seed_cluster() { logrun "Creating the default groups and the admin account" cc seed; }
st_up_cluster() { logrun "Starting the application on this node" cc up; }
st_release_peers() {
  pause "The cluster is ready. Now press Enter on each of the other nodes so they start their application, then continue here."
}

# A package records the commit it was made at, and the remote copies and images were made from the code of
# the time. After the code changed (a git pull between two runs), those steps must be done again.
forget_stale_progress() {
  local now old
  now=$(bash scripts/build-id.sh 2>/dev/null || echo dev)
  old=$(sed -n 's/^buildid://p' "$STATE" 2>/dev/null | tail -n 1)
  if [[ -n $old && $old != "$now" ]]; then
    warn "The code changed since an earlier run ($old -> $now): redoing the steps that depend on it."
    local st
    for st in packages remote-prepare remote-start build migrate seed up remote-finish release health; do sed -i "/^$st\$/d" "$STATE"; done
  fi
  # packages are cheap and hold the secrets: always make fresh ones
  sed -i '/^packages$/d' "$STATE" 2>/dev/null
  sed -i '/^buildid:/d' "$STATE" 2>/dev/null
  echo "buildid:$now" >>"$STATE"
}

run_first_node() {
  setup_compose
  run_stage prep "Preparing" st_prep
  run_stage ports "Checking ports" st_ports
  bundled_db && run_stage certs "Creating certificates" st_certs
  forget_stale_progress
  run_stage packages "Packaging the other nodes" st_packages
  if remote_ssh; then
    run_stage remote-prepare "Connecting to the other machines and copying what they need" st_remote_prepare
    run_stage remote-start "Installing the other machines (all at once; the first time takes 5-10 minutes)" st_remote_start
  fi
  run_stage build "Building" st_build
  if bundled_db || bundled_s3; then run_stage start-data "Starting the data services" st_start_data; fi
  run_stage wait-peers "Waiting for the other nodes" st_wait_peers
  run_stage init-db "Initialising the database" st_init_db
  run_stage db-members "Waiting for every database node to join" st_db_members
  run_stage garage "Forming the object store" st_garage
  run_stage migrate "Migrating the database" st_migrate_cluster
  run_stage seed "Seeding the defaults" st_seed_cluster
  run_stage up "Starting the application" st_up_cluster
  if remote_ssh; then
    run_stage remote-finish "Starting the other machines' applications" st_remote_finish
  else
    run_stage release "Starting the other nodes' applications" st_release_peers
  fi
  run_stage health "Waiting for this node" st_health
}

# ---- the other machines, over SSH ----------------------------------------------------------------
# With REMOTE_MODE=ssh the first machine does what a person would otherwise do by hand on every other
# machine: connect, copy this checkout (with .git, so every node computes the same build id) and the node's
# package, run `./install.sh --join` there (all machines at once), read back each node's object-store id,
# start their applications when the cluster is ready, and delete the packages. Passwords are never handled
# here: ssh asks for one itself, once per machine, when it first connects (it needs a terminal for that;
# without one, keys must be set up). ssh's connection sharing (ControlMaster) then carries every later command.
remote_ssh() { [[ $(ans SETUP) == cluster && $(ans REMOTE_MODE) == ssh ]]; }
REMOTE_TMP=""
remote_tmp() {
  [[ -n $REMOTE_TMP ]] && return 0
  REMOTE_TMP=$(mktemp -d /tmp/church-ssh.XXXXXX) && chmod 700 "$REMOTE_TMP"
}
remote_close() { # close the shared connections when the installer exits
  [[ -n $REMOTE_TMP && -d $REMOTE_TMP ]] || return 0
  local i
  for ((i = 2; i <= ${ANS[NODES]:-1}; i++)); do
    ssh_prep "$i" 2>/dev/null && ssh "${SSH_O[@]}" -O exit "$SSH_T" >/dev/null 2>&1
  done
  rm -rf "$REMOTE_TMP"
}
trap remote_close EXIT

node_ssh() { ans "NODE_${1}_SSH_$2"; }
remote_dir() { local d; d=$(node_ssh "$1" DIR); printf '%s' "${d:-$(ans REMOTE_DIR)}"; }

# SSH_O: options, SSH_T: user@host for node $1
ssh_prep() {
  remote_tmp || return 1
  SSH_O=(-o ControlMaster=auto -o "ControlPath=$REMOTE_TMP/cm-%C" -o ControlPersist=30m -o ServerAliveInterval=15 -p "$(node_ssh "$1" PORT)")
  [[ -n $(ans SSH_KEY) ]] && SSH_O+=(-i "$(ans SSH_KEY)" -o IdentitiesOnly=yes)
  [[ -t 0 ]] || SSH_O+=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
  if [[ -n $(ans SSH_EXTRA_OPTS) ]]; then
    local -a extra; read -ra extra <<<"$(ans SSH_EXTRA_OPTS)"; SSH_O+=("${extra[@]}")
  fi
  SSH_T="$(node_ssh "$1" USER)@$(node_ssh "$1" HOST)"
}

# Run a command on node $1: no terminal, never prompts.
rsh() { local i=$1; shift; ssh_prep "$i" && ssh "${SSH_O[@]}" -o BatchMode=yes "$SSH_T" "$@"; }

remote_connect() { # may ask for a password or to trust the host: it has the terminal
  ssh_prep "$1" && ssh "${SSH_O[@]}" "$SSH_T" true
}

# Every step after the first one talks to the other machines through the shared ssh connection opened by
# remote_connect (the only place a password can be typed). A run that resumes an earlier one skips that
# step, so each remote step begins by making sure the connections are open, opening them (and asking for a
# password) where they are not. Without it, a machine that needs a password just says "Permission denied".
remote_connect_all() {
  local i name
  for ((i = 2; i <= $(ans NODES); i++)); do
    ssh_prep "$i" || return 1
    if ssh "${SSH_O[@]}" -O check "$SSH_T" >/dev/null 2>&1; then continue; fi
    name=$(ans "NODE_${i}_ID")
    info "$name: connecting to $SSH_T"
    if ! remote_connect "$i"; then
      if [[ -t 0 ]]; then fail "Could not connect to $SSH_T."
      else fail "Could not connect to $SSH_T without a terminal: a machine that needs a password needs a key (SSH_KEY or your ssh agent), or run the installer in a terminal so ssh can ask."; fi
      return 1
    fi
  done
}

remote_preflight() { # node $1: check, offer to install what is missing, fail with what is left
  ssh_prep "$1" || return 1
  if ensure_requirements "$1"; then
    ok "$(ans "NODE_${1}_ID") ($SSH_T): Docker, Compose, make, git and tar are there"
    return 0
  fi
  explain_requirements "$(ans "NODE_${1}_ID") ($SSH_T)" "${REQ_LEFT[@]}"
  return 1
}

# The checkout, without data, dependencies and build output, but WITH .git.
copy_checkout() { # node
  local dir; dir=$(remote_dir "$1")
  ssh_prep "$1" || return 1
  tar --exclude=./data --exclude=node_modules --exclude=.pnpm-store --exclude=.turbo --exclude=.next --exclude=dist \
      --exclude=./backups --exclude=./.env --exclude='./.env.bak*' --exclude=./.claude --exclude=tsconfig.tsbuildinfo \
      --exclude='./.install*' --exclude='./church-node-*' -czf - . \
    | ssh "${SSH_O[@]}" -o BatchMode=yes "$SSH_T" "mkdir -p -- '$dir' && tar -xzf - -C '$dir'"
}

# The remote answers file: what the --join run on node $1 would otherwise ask, plus any NODE_<n>_ANS_<KEY>.
remote_answers() { # node -> stdout
  local i=$1 k
  echo "NOWAIT=yes"
  echo "JOIN_COMMIT_OK=yes"   # the files were copied from here and their build id was compared
  echo "EXTERNAL_PORT=${ANS[NODE_${i}_ANS_EXTERNAL_PORT]:-$(ans EXTERNAL_PORT)}"
  local meta=${ANS[NODE_${i}_ANS_GARAGE_META_DIR]:-$(ans REMOTE_GARAGE_META_DIR)}
  [[ -z $meta ]] || echo "GARAGE_META_DIR=$meta"
  for k in $(printf '%s\n' "${!ANS[@]}" | sort); do
    [[ $k == NODE_${i}_ANS_* ]] || continue
    [[ $k == NODE_${i}_ANS_EXTERNAL_PORT || $k == NODE_${i}_ANS_GARAGE_META_DIR ]] && continue
    echo "${k#NODE_${i}_ANS_}=${ANS[$k]}"
  done
}

st_remote_prepare() {
  local i name dir pkg lb rb
  lb=$(bash scripts/build-id.sh)
  for ((i = 2; i <= $(ans NODES); i++)); do
    name=$(ans "NODE_${i}_ID"); dir=$(remote_dir "$i")
    pkg="data/cluster-packages/church-node-$name.tar.gz"
    info "$name: connecting (a password or host key question, if any, is ssh's own)"
    remote_connect "$i" || { fail "Could not connect to $SSH_T. Check the host name, user and key, or choose to copy the packages yourself."; return 1; }
    remote_preflight "$i" || return 1
    logrun "$name: copying this checkout to ~/$dir" copy_checkout "$i" || return 1
    # a fresh install: forget any progress an earlier run left there
    rsh "$i" "cd -- '$dir' && rm -f .install-state .install-answers" || return 1
    ( umask 077; rsh "$i" "umask 077; mkdir -p -- '$dir/data/cluster-packages' && cat > '$dir/data/cluster-packages/church-node-$name.tar.gz'" <"$pkg" ) || { fail "Could not copy the package to $name."; return 1; }
    ( umask 077; remote_answers "$i" | rsh "$i" "umask 077; cat > '$dir/.install-remote-answers'" ) || return 1
    rb=$(rsh "$i" "cd -- '$dir' && bash scripts/build-id.sh") || return 1
    if [[ $rb != "$lb" ]]; then
      fail "$name would build '$rb' but this machine builds '$lb': every node must run the same build. Is git installed there, and is the copy complete?"
      return 1
    fi
    ok "$name: same build ($lb)"
  done
}

# run `function i` for every other node at the same time; their output goes to .install-remote-<name>.log
remote_parallel() { # function
  local fn=$1 i n name failed=0; n=$(ans NODES)
  local -A pid=()
  remote_tmp || return 1
  for ((i = 2; i <= n; i++)); do
    name=$(ans "NODE_${i}_ID")
    ( "$fn" "$i" ) >"$REMOTE_TMP/$name.log" 2>&1 &
    pid[$i]=$!
    info "$name: started"
  done
  printf '  working '
  local alive=1
  while (( alive )); do
    alive=0
    for i in "${!pid[@]}"; do kill -0 "${pid[$i]}" 2>/dev/null && alive=1; done
    if (( alive )); then printf '.'; sleep 5; fi
  done
  printf '\n'
  for i in "${!pid[@]}"; do
    name=$(ans "NODE_${i}_ID")
    cp "$REMOTE_TMP/$name.log" ".install-remote-$name.log" 2>/dev/null; chmod 600 ".install-remote-$name.log" 2>/dev/null
    if wait "${pid[$i]}"; then ok "$name finished"
    else
      fail "$name failed. The end of its output:"
      tail -n 25 "$REMOTE_TMP/$name.log" | sed 's/^/      /' >&2
      fail "The whole of it is in .install-remote-$name.log"
      failed=1
    fi
  done
  return $failed
}

remote_join_first_phase() { # node: everything up to starting the data services and printing the node id
  local i=$1 dir stop_at=build name; dir=$(remote_dir "$i"); name=$(ans "NODE_${i}_ID")
  # shellcheck disable=SC2100  # a stage name, not arithmetic
  if bundled_db || bundled_s3; then stop_at=node-id; fi
  rsh "$i" "cd -- '$dir' && NO_COLOR=1 INSTALL_STOP_AFTER=$stop_at ./install.sh --join 'data/cluster-packages/church-node-$name.tar.gz' --answers .install-remote-answers"
}
remote_join_last_phase() { # node: start the application, wait until it answers, delete the package
  local i=$1 dir name; dir=$(remote_dir "$i"); name=$(ans "NODE_${i}_ID")
  rsh "$i" "cd -- '$dir' && NO_COLOR=1 ./install.sh --join 'data/cluster-packages/church-node-$name.tar.gz' --answers .install-remote-answers" || return 1
  rsh "$i" "cd -- '$dir' && rm -f 'data/cluster-packages/church-node-$name.tar.gz' .install-remote-answers"
}

st_remote_start() { remote_connect_all || return 1; remote_parallel remote_join_first_phase; }
st_remote_finish() {
  remote_connect_all || return 1
  remote_parallel remote_join_last_phase || return 1
  rm -f data/cluster-packages/church-node-*.tar.gz
  ok "The packages are deleted from every machine (they held the secrets)."
}

# the object-store id each other node printed, read from the node itself
remote_peer_ids() {
  local i dir id
  remote_connect_all || return 1
  for ((i = 2; i <= $(ans NODES); i++)); do
    have "PEERID_$i" && continue
    dir=$(remote_dir "$i")
    id=$(rsh "$i" "cat -- '$dir/data/node-id.txt'" 2>/dev/null) || { fail "Could not read the object store id of $(ans "NODE_${i}_ID")."; return 1; }
    v_garageid "$id" || return 1
    ANS[PEERID_$i]=$id
  done
}

# ---- joining ------------------------------------------------------------------------------------
st_join_env() {
  local tmp; tmp=$(mktemp -d); chmod 700 "$tmp"
  tar -xzf "$JOIN_PKG" -C "$tmp" || { fail "Could not read $JOIN_PKG."; return 1; }
  [[ -f $tmp/.env && -f $tmp/COMMIT ]] || { fail "$JOIN_PKG is not a node package from ./install.sh."; return 1; }
  local want have_commit
  want=$(cut -d' ' -f1 "$tmp/COMMIT"); have_commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)
  if [[ $want != unknown && $want != "$have_commit" && $(ans JOIN_COMMIT_OK) != yes ]]; then
    warn "This checkout is at ${have_commit:0:10} but the first node is at ${want:0:10}. Every node must run the same build."
    if in_git_checkout && { [[ -t 0 ]] || have JOIN_UPDATE; }; then
      ask_yn JOIN_UPDATE "Make this checkout match the first node's version now (git fetch, then check out ${want:0:10})?" yes
      if [[ $(ans JOIN_UPDATE) == yes ]]; then
        rm -rf "$tmp"
        sync_to_commit "$want" || return 1
        restart_installer
      fi
    fi
    if [[ ! -t 0 ]] && ! have JOIN_COMMIT_OK; then
      fail "Not continuing: the versions differ and there is no terminal to ask. Match them (git fetch && git checkout $want) or set JOIN_COMMIT_OK=yes."
      return 1
    fi
    ask_yn JOIN_COMMIT_OK "Continue with the different version anyway?" no
    [[ $(ans JOIN_COMMIT_OK) == yes ]] || { fail "Check out the same commit (git fetch && git checkout $want) and run again."; return 1; }
  fi
  [[ $(cut -d' ' -f2 "$tmp/COMMIT") != dirty ]] || warn "The first node had uncommitted changes, so a different checkout may build differently."
  if [[ -f .env ]]; then cp -p .env ".env.bak-$(date +%Y%m%d-%H%M%S)"; ok "The existing .env was saved as .env.bak-*"; fi
  cp "$tmp/.env" .env; chmod 600 .env
  # Settings that belong to this machine.
  env_set .env EXTERNAL_PORT "$(ans EXTERNAL_PORT)"
  [[ -n $(ans GARAGE_META_DIR) ]] && env_set .env GARAGE_META_DIR "$(ans GARAGE_META_DIR)"
  local k; for k in $(printf '%s\n' "${!ANS[@]}" | sort); do [[ $k == ENV_* ]] && env_set .env "${k#ENV_}" "${ANS[$k]}"; done
  if [[ -d $tmp/certs ]]; then
    logrun "Installing this node's certificates" cc install-certs "$tmp/certs" || return 1
  fi
  rm -rf "$tmp"
  ok "This node is configured as $(env_read .env NODE_ID)"
}

st_join_nodeid() {
  bundled_s3_env || return 0
  local line; line=$(cc node-id 2>>"$LOG") || { fail "Could not read this node's object store id (see $LOG)."; return 1; }
  printf '%s\n' "$line" >data/node-id.txt
  cat <<EOF

  This node's object store id (also saved in data/node-id.txt):

      $line

  Paste it into the installer on the first node when it asks.
EOF
}

bundled_s3_env() { [[ $(env_read .env S3_MODE) != external ]]; }
bundled_db_env() { [[ $(env_read .env DB_MODE) != external ]]; }

st_join_wait() {
  pause "Waiting for the first node. Once it says the cluster is ready, press Enter here to start this node's application."
}
st_join_up() { logrun "Starting the application on this node" cc up; }
st_join_health() {
  [[ $(env_read .env NODE_ROLE) == data ]] && { ok "This is a witness: it runs the database and object store only."; return 0; }
  wait_for "this node to answer on port $(env_read .env EXTERNAL_PORT)" 300 http_ok "http://127.0.0.1:$(env_read .env EXTERNAL_PORT)/healthz"
}

run_join() {
  heading "Joining a cluster"
  [[ -f $JOIN_PKG ]] || die "Package not found: $JOIN_PKG"
  have EXTERNAL_PORT || {
    local tmp; tmp=$(mktemp -d); tar -xzf "$JOIN_PKG" -C "$tmp" ./.env 2>/dev/null
    ask_text EXTERNAL_PORT "Port to serve the dashboard on (this machine)" "$(env_read "$tmp/.env" EXTERNAL_PORT)" v_port
    rm -rf "$tmp"
  }
  if network_fs . && ! have GARAGE_META_DIR && [[ ! -t 0 ]]; then
    die "This folder is on a network file system, and the object store's metadata must be on local disk. Give a local folder: the first machine asks for it ('Local folder for the object store metadata on the other machines'), or put GARAGE_META_DIR=/var/lib/church-garage-meta in the answers file."
  fi
  if network_fs . && ! have GARAGE_META_DIR; then
    ask_text GARAGE_META_DIR "Local folder for the object store's metadata (this folder is on a network file system)" /var/lib/church-garage-meta v_envsafe
  fi
  save_answers
  (( DRY_RUN )) && { info "would: install the package, certificates, start the data services, print the node id, start the application"; return 0; }
  run_stage join-env "Installing the package" st_join_env
  # From here on the settings come from the installed .env.
  ANS[SETUP]=cluster; ANS[DB_MODE]=$(env_read .env DB_MODE); ANS[S3_MODE]=$(env_read .env S3_MODE)
  [[ -n ${ANS[DB_MODE]} ]] || ANS[DB_MODE]=bundled
  [[ -n ${ANS[S3_MODE]} ]] || ANS[S3_MODE]=bundled
  ANS[EXTERNAL_PORT]=$(env_read .env EXTERNAL_PORT)
  setup_compose
  ANS[NODES]=1; ANS[NODE_1_ADDR]="$(env_read .env NODE_ADDR):$(env_read .env CLUSTER_DB_PORT):$(env_read .env CLUSTER_S3_RPC_PORT)"
  run_stage prep "Preparing" st_prep
  run_stage ports "Checking ports" st_ports
  run_stage build "Building" st_build
  if bundled_db_env || bundled_s3_env; then
    run_stage start-data "Starting the data services" st_start_data
    run_stage node-id "Reading this node's object store id" st_join_nodeid
  fi
  run_stage wait "Waiting for the first node" st_join_wait
  run_stage up "Starting the application" st_join_up
  run_stage health "Waiting for this node" st_join_health
  finish_join
}

# ---------------------------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------------------------
finish_single() {
  local ip port; ip=$(detect_ip); ip=${ip:-localhost}; port=$(ans EXTERNAL_PORT)
  heading "Done"
  cat <<EOF

  Open:      http://$ip:$port   (or http://localhost:$port on this machine)
  Sign in:   admin / admin      you will be asked to choose a new password straight away

  Next, in the browser at /admin/settings:
    - Email (SMTP), so notifications and password resets can be sent
    - Google or Microsoft sign-in, if you want single sign-on
    - Admin > Backups: schedule backups and download a copy to keep off this machine

  Keep safe:
    .env is the one file a data backup cannot recreate: its AUTH_SECRET protects the stored
    SMTP/OAuth secrets. Back it up together with data/ (and keep a copy somewhere else).

  Everyday commands:
    ${COMPOSE[*]} ps | logs -f --tail=100 | down      (from this folder)
    make rebuild                                  after pulling a new version
  HTTPS: this app speaks plain HTTP. Put your HTTPS load balancer or reverse proxy in front of port $port.
  Full documentation: INSTALL.md.  The installer's log: $LOG
EOF
}

finish_cluster() {
  heading "Done"
  local i
  cat <<EOF

  The cluster is running. Add every full node to your load balancer:
    - forward HTTP to each node's port $(ans EXTERNAL_PORT) (the balancer ends HTTPS), with WebSocket upgrades, no sticky sessions
    - health check:  GET /healthz  (200 while the node is healthy; 503 when it cannot reach the database or is drained)
EOF
  for ((i = 1; i <= $(ans NODES); i++)); do
    [[ $(ans "NODE_${i}_ROLE") == data ]] && continue
    printf '        node %s: http://%s:%s\n' "$(ans "NODE_${i}_ID")" "$(node_host "$i" 2>/dev/null || echo '<address>')" "$(ans EXTERNAL_PORT)"
  done
  cat <<EOF
  Sign in:   admin / admin   (you will be asked to change it), then check /admin/cluster
EOF
  if remote_ssh; then
    echo "  The node packages (they held the secrets) were deleted from every machine."
  else
    echo "  Delete the node packages (they hold the secrets):  rm -r data/cluster-packages"
  fi
  cat <<EOF

  Now:
    - Keep data/cluster-certs/ca.key somewhere safe and OFF the nodes (it signs new nodes' certificates)
    - Firewall the cluster ports (database, object store) to the other nodes only
    - Make sure NTP runs on every node: the database nodes shut down if their clocks drift
    - Back up .env (AUTH_SECRET) and schedule backups at /admin/backups
    - Status any time:  scripts/cluster.sh status
  Documentation: INSTALL.md ("Multi node"). The installer's log: $LOG
EOF
}

finish_join() {
  heading "Done"
  cat <<EOF

  This node is part of the cluster. Add it to your load balancer (health check GET /healthz on
  port $(env_read .env EXTERNAL_PORT)), then delete the package you copied here:  rm $JOIN_PKG
  Status any time: scripts/cluster.sh status
EOF
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------
while (( $# )); do
  case "$1" in
    --join) JOIN_PKG=${2:-}; [[ -n $JOIN_PKG ]] || die "--join needs the package file."; shift 2 ;;
    --answers) PRESET_FILE=${2:-}; [[ -n $PRESET_FILE ]] || die "--answers needs a file."; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --fresh) FRESH=1; shift ;;
    --check-requirements) DEPS_ONLY=1; shift ;;
    --check-database) CHECK_DB=1; shift ;;
    --ssh-test) SSH_TEST=${2:-}; [[ $SSH_TEST =~ ^[0-9]+$ ]] || die "--ssh-test needs a node number (with --answers)."; shift 2 ;;
    --check-remote) CHECK_REMOTE=${2:-}; [[ $CHECK_REMOTE =~ ^[0-9]+$ ]] || die "--check-remote needs a node number (with --answers)."; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

printf '\n%sChurch Dashboard installer%s\n' "$B" "$Z"
say "This asks a few questions, then installs. Press Ctrl-C at any time; running it again carries on."

(( FRESH )) && rm -f "$STATE"
[[ -z $PRESET_FILE ]] || load_answers "$PRESET_FILE"
if [[ $(ans DB_SSL) == require ]]; then
  warn "DB_SSL=require is now verify-full (that is what the app always did with it); use no-verify to encrypt without checking the certificate."
  ANS[DB_SSL]=verify-full
fi
preflight
(( DEPS_ONLY )) && { ok "Everything this installer needs is here."; exit 0; }
if (( CHECK_DB )); then   # ask the database questions (and test the connection), print the URL, stop
  ask_database; printf 'DATABASE_URL=%s\n' "$(ans DATABASE_URL)"; exit 0
fi
if [[ -n $SSH_TEST ]]; then   # test hook: open the shared connections as a resumed run would, then use them
  ANS[NODES]=$SSH_TEST
  remote_connect_all || exit 1
  rsh "$SSH_TEST" 'echo connected-without-a-prompt' || exit 1
  exit 0
fi
if [[ -n $CHECK_REMOTE ]]; then
  remote_connect "$CHECK_REMOTE" || die "Could not connect."
  remote_preflight "$CHECK_REMOTE" || exit 1
  exit 0
fi

[[ -n $JOIN_PKG || -n $PRESET_FILE ]] || offer_self_update

if [[ -n $PRESET_FILE ]]; then
  :
elif [[ -f $ANSWERS_FILE && $FRESH -eq 0 ]]; then
  ANS_EXISTING=1
fi

if [[ -n $JOIN_PKG ]]; then
  [[ -z ${ANS_EXISTING:-} ]] || load_answers "$ANSWERS_FILE"
  run_join
  exit 0
fi

if [[ -z $PRESET_FILE ]]; then
  if [[ -n ${ANS_EXISTING:-} ]]; then
    ask_choice EXISTING "An earlier run of the installer left its answers here. What do you want to do?" resume \
      "resume|Carry on with the same answers|Finished steps are skipped." \
      "again|Answer the questions again|The current .env is backed up first; its secrets are kept." \
      "cancel|Cancel|"
    case $(ans EXISTING) in
      resume) load_answers "$ANSWERS_FILE" ;;
      cancel) exit 0 ;;
      again) load_prev "$ANSWERS_FILE"; rm -f "$STATE"; forget EXISTING ;;
    esac
  elif [[ -f .env ]]; then
    warn "There is already a .env here. If you continue it is backed up first (its secrets are kept)."
    ask_yn OVERWRITE "Continue and replace it?" no
    [[ $(ans OVERWRITE) == yes ]] || exit 0
    forget OVERWRITE
  fi
fi

# Cluster nodes that join are not asked the questions below.
# The questions, up to the review. Saying no at the review asks them all again (nothing has been written).
while :; do
  heading "How will you run it?"
  ask_choice SETUP "How do you want to run the dashboard?" single \
    "single|On one server|The usual choice. One machine runs everything." \
    "cluster|On several servers behind a load balancer|Higher availability. Needs your own load balancer and 2 or more machines."

  if [[ $(ans SETUP) == cluster ]]; then
    ask_choice CLUSTER_ROLE "Is this the first machine, or are you adding a machine to a cluster you already started?" first \
      "first|This is the first machine|You will set up the cluster from here and get a package for each other machine." \
      "join|Add this machine to an existing cluster|You need the package the first machine made for this one."
    if [[ $(ans CLUSTER_ROLE) == join ]]; then
      ask_text JOIN_PACKAGE "Path to this machine's package (church-node-<name>.tar.gz)" "" v_path_exists
      JOIN_PKG=$(ans JOIN_PACKAGE)
      save_answers
      run_join
      exit 0
    fi
  fi

  ask_database
  ask_objectstore
  ask_network
  [[ $(ans SETUP) == cluster ]] && ask_cluster_nodes
  [[ $(ans SETUP) == single ]] && ask_stack
  ask_secrets
  if summary; then break; fi
  say
  say "Starting the questions again."
  for k in "${ASKED[@]}"; do [[ -z ${ANS[$k]+x} || $k == CONFIRM ]] || PREV[$k]=${ANS[$k]}; unset "ANS[$k]"; done
  ASKED=(); forget CONFIRM
done
save_answers

heading "Writing the configuration"
install_env
if [[ $(ans SETUP) == cluster ]] && (( DRY_RUN )); then
  mkdir -p data/cluster-packages
  for ((i = 1; i <= $(ans NODES); i++)); do write_env "data/cluster-packages/preview-$(ans "NODE_${i}_ID").env" "$i"; done
  ok "Wrote previews of every node's .env to data/cluster-packages/preview-*.env"
fi
(( DRY_RUN )) && { ok "Dry run finished: nothing was started."; exit 0; }

if [[ $(ans SETUP) == cluster ]]; then
  run_first_node
  finish_cluster
else
  run_single
  finish_single
fi
