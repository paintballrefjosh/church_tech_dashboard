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

if (( BASH_VERSINFO[0] < 4 )); then
  echo "install.sh needs bash 4 or newer (this is $BASH_VERSION)." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  B=$'\e[1m'; D=$'\e[2m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; Z=$'\e[0m'
else
  B=''; D=''; R=''; G=''; Y=''; Z=''
fi
say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  %s[ok]%s %s\n' "$G" "$Z" "$*"; }
warn() { printf '  %s[!]%s %s\n' "$Y" "$Z" "$*" >&2; }
fail() { printf '  %s[x]%s %s\n' "$R" "$Z" "$*" >&2; }
die()  { fail "$*"; exit 1; }
heading() { printf '\n%s== %s ==%s\n' "$B" "$*" "$Z"; }
hint() { printf '  %s%s%s\n' "$D" "$*" "$Z"; }

LOG=.install.log
STATE=.install-state
ANSWERS_FILE=.install-answers
DRY_RUN=0
FRESH=0
JOIN_PKG=""
PRESET_FILE=""

usage() { sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//'; }

trap 'echo; fail "Interrupted. Run ./install.sh again to carry on where you left off."; exit 130' INT

# ---------------------------------------------------------------------------------------------
# Answers: asked once, or taken from a file / earlier run. Every prompt checks ANS first.
# ---------------------------------------------------------------------------------------------
declare -A ANS=()

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

have() { [[ -n ${ANS[$1]+x} ]]; }
ans() { printf '%s' "${ANS[$1]:-}"; }

read_line() { # sets REPLY_LINE; dies at end of input
  IFS= read -r REPLY_LINE || die "No input left. Run this in a terminal, or pass --answers FILE with every answer in it."
}

# ask_text KEY "Question" "default" [validator] [hint]
ask_text() {
  local key=$1 q=$2 def=${3-} validator=${4-} h=${5-} v
  if have "$key"; then
    v=${ANS[$key]}
    if [[ -n $validator ]] && ! "$validator" "$v"; then die "The answer $key='$v' is not valid."; fi
    return 0
  fi
  while :; do
    printf '\n'
    [[ -n $h ]] && hint "$h"
    printf '%s%s%s' "$B" "$q" "$Z"
    [[ -n $def ]] && printf ' [%s]' "$def"
    printf ': '
    read_line; v=${REPLY_LINE:-$def}
    if [[ -n $validator ]] && ! "$validator" "$v"; then continue; fi
    break
  done
  ANS[$key]=$v
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
    printf '\n%s%s%s: ' "$B" "$q" "$Z"
    if [[ -t 0 ]]; then IFS= read -rs v || die "No input left."; printf '\n'; else read_line; v=$REPLY_LINE; fi
    if [[ -n $validator ]] && ! "$validator" "$v"; then continue; fi
    break
  done
  ANS[$key]=$v
}

# ask_yn KEY "Question" yes|no  -> ANS[KEY] is "yes" or "no"
ask_yn() {
  local key=$1 q=$2 def=${3:-yes} v shown
  if have "$key"; then
    case "${ANS[$key]}" in y|Y|yes|YES|true|1) ANS[$key]=yes ;; n|N|no|NO|false|0) ANS[$key]=no ;; *) die "The answer $key must be yes or no." ;; esac
    return 0
  fi
  [[ $def == yes ]] && shown='Y/n' || shown='y/N'
  while :; do
    printf '\n%s%s%s [%s]: ' "$B" "$q" "$Z" "$shown"
    read_line; v=${REPLY_LINE:-$def}
    case "$v" in y|Y|yes|YES) ANS[$key]=yes; return 0 ;; n|N|no|NO) ANS[$key]=no; return 0 ;; esac
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
  for i in "${!vals[@]}"; do [[ ${vals[i]} == "$def" ]] && defidx=$((i + 1)); done
  if have "$key"; then
    for v in "${vals[@]}"; do [[ $v == "${ANS[$key]}" ]] && return 0; done
    die "The answer $key='${ANS[$key]}' must be one of: ${vals[*]}"
  fi
  while :; do
    printf '\n%s%s%s\n' "$B" "$q" "$Z"
    for i in "${!vals[@]}"; do
      printf '  %d) %s%s%s\n' $((i + 1)) "$B" "${labs[i]}" "$Z"
      [[ -n ${descs[i]} ]] && printf '     %s%s%s\n' "$D" "${descs[i]}" "$Z"
    done
    printf 'Choose [%s]: ' "$defidx"
    read_line; reply=${REPLY_LINE:-$defidx}
    if [[ $reply =~ ^[0-9]+$ ]] && (( reply >= 1 && reply <= ${#vals[@]} )); then ANS[$key]=${vals[reply-1]}; return 0; fi
    for v in "${vals[@]}"; do [[ $v == "$reply" ]] && { ANS[$key]=$v; return 0; }; done
    warn "Please enter a number from 1 to ${#vals[@]}."
  done
}

# Forget answers so a question is asked again.
forget() { local k; for k in "$@"; do unset "ANS[$k]"; done; }

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
v_url() {
  [[ $1 =~ ^postgres(ql)?://[^[:space:]]+@[^[:space:]/]+/[^[:space:]]+$ ]] || { fail "Expected postgresql://user:password@host:port/database"; return 1; }
  case "$1" in *@localhost[:/]*|*@127.*|*@cockroach-1[:/]*) fail "The containers cannot reach localhost. Use the server's real address."; return 1 ;; esac
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
  tail -n 25 "$LOG" | sed 's/^/      /' >&2
  fail "The full output is in $LOG"
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
  printf '\n%s%s%s\nPress Enter to continue: ' "$B" "$*" "$Z"
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
preflight() {
  heading "Checking this machine"
  [[ -f scripts/compose.sh && -f .env.example ]] || die "Run this from the root of the church-dashboard checkout (scripts/compose.sh and .env.example must be here)."
  (( DRY_RUN )) && { info "(dry run: skipping the docker checks)"; return 0; }

  command -v docker >/dev/null 2>&1 || die "Docker is not installed. On Linux: curl -fsSL https://get.docker.com | sh"
  if ! docker info >/dev/null 2>&1; then
    die "Docker is installed but this user cannot use it. Start it (sudo systemctl start docker) and, if it says permission denied, add yourself to the docker group: sudo usermod -aG docker \$USER (then log in again)."
  fi
  local cv; cv=$(docker compose version --short 2>/dev/null | sed 's/^v//; s/[^0-9.].*//')
  [[ -n $cv ]] || die "The Docker Compose plugin is missing. Install docker-compose-plugin (Compose v2.20 or newer)."
  if [[ $(printf '%s\n2.20\n' "$cv" | sort -V | head -n 1) != 2.20 ]]; then die "Docker Compose $cv is too old: v2.20 or newer is needed."; fi
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), Compose $cv"
  command -v make >/dev/null 2>&1 || die "make is not installed (sudo apt install make)."
  command -v git >/dev/null 2>&1 || warn "git is not installed: the build id will not name a commit (every cluster node must still run the same code)."

  local mem free
  mem=$(human_mem_gb); free=$(df -Pk . | awk 'NR==2 {printf "%d", $4/1048576}')
  ok "Memory ${mem} GB, free disk here ${free} GB"
  (( free >= 10 )) || warn "Less than 10 GB free here. The images and data need about that much."
}

# ---------------------------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------------------------
test_db() { # DATABASE_URL in ANS; 0 = connected
  local out rc script
  logrun "Fetching a small postgres client image" docker pull -q postgres:16-alpine || return 1
  script=$'psql "$DBURL" -Atc "select version()" || exit 1\npsql "$DBURL" -Atc "select count(*) from pg_extension where extname = \'pgcrypto\'" 2>/dev/null || echo skip'
  out=$(DBURL=$(ans DATABASE_URL) docker run --rm -e DBURL -e PGCONNECT_TIMEOUT=10 postgres:16-alpine sh -c "$script" 2>&1); rc=$?
  if (( rc != 0 )); then
    fail "Could not connect:"
    printf '%s\n' "$out" | sed -E 's#postgres(ql)?://[^ ]*#<url hidden>#g; s/^/      /' >&2
    return 1
  fi
  local ver; ver=$(printf '%s\n' "$out" | head -n 1)
  case "$ver" in
    *CockroachDB*) ok "Connected: CockroachDB" ;;
    *-YB-*) ok "Connected: YugabyteDB"
      [[ $(printf '%s\n' "$out" | tail -n 1) == 0 ]] && warn "YugabyteDB 2024.2 needs the pgcrypto extension. The migrations enable it if this login may CREATE EXTENSION; otherwise ask the DBA to run: CREATE EXTENSION IF NOT EXISTS pgcrypto;" ;;
    *) ok "Connected: ${ver:0:60}" ;;
  esac
}

ask_database() {
  heading "Database"
  ask_choice DB_MODE "Where should the database live?" bundled \
    "bundled|Bundled CockroachDB|Runs inside this install. Nothing to set up. The right choice for most churches." \
    "external|A database I already run|YugabyteDB or CockroachDB that you manage. The dashboard only needs a login and an empty database."
  [[ $(ans DB_MODE) == external ]] || return 0

  while :; do
    ask_choice DB_INPUT "How do you want to give the connection details?" parts \
      "parts|Fill in host, port, user and password|The installer builds the connection URL for you." \
      "url|Paste a connection URL|postgresql://user:password@host:5433/church?sslmode=require"
    if [[ $(ans DB_INPUT) == parts ]]; then
      ask_choice DB_ENGINE "Which database is it?" yugabyte \
        "yugabyte|YugabyteDB|YSQL, port 5433 by default" \
        "cockroach|CockroachDB|port 26257 by default" \
        "other|Another PostgreSQL-compatible database|you give the port"
      local defport=5433; [[ $(ans DB_ENGINE) == cockroach ]] && defport=26257
      ask_text DB_HOST "Database host (the containers must be able to reach it; not localhost)" "" v_dbhost
      ask_text DB_PORT "Database port" "$defport" v_port
      ask_text DB_NAME "Database name (it must already exist)" church v_envsafe
      ask_text DB_USER "Database user" church v_envsafe
      ask_secret DB_PASSWORD "Database password" v_nonempty
      ask_choice DB_SSL "Encrypt the connection?" require \
        "require|Yes, encrypted (certificate not verified)|Recommended when the database speaks TLS." \
        "disable|No|Only on a network you trust."
      ANS[DATABASE_URL]="postgresql://$(urlenc "$(ans DB_USER)"):$(urlenc "$(ans DB_PASSWORD)")@$(ans DB_HOST):$(ans DB_PORT)/$(urlenc "$(ans DB_NAME)")?sslmode=$(ans DB_SSL)"
    else
      ask_text DATABASE_URL "Connection URL" "" v_url
    fi
    if (( DRY_RUN )); then break; fi
    ask_yn DB_TEST "Test the connection now? (starts a small postgres client container)" yes
    [[ $(ans DB_TEST) == yes ]] || break
    test_db && break
    ask_choice DB_FAIL "What now?" again \
      "again|Enter the details again|" \
      "continue|Continue anyway|You can fix the database later and run ./install.sh again." \
      "abort|Stop here|"
    case $(ans DB_FAIL) in
      continue) break ;;
      abort) die "Stopped. Nothing has been started." ;;
    esac
    forget DB_INPUT DB_ENGINE DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL DATABASE_URL DB_TEST DB_FAIL
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
  return 0
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
    local i; for ((i = 1; i <= $(ans NODES); i++)); do
      info "Node $i:        $(ans "NODE_${i}_ID")  $(ans "NODE_${i}_ADDR")$( [[ $(ans "NODE_${i}_ROLE") == data ]] && echo "  (witness)" )$( ((i == 1)) && echo "  <- this machine" )"
    done
  fi
  ask_yn CONFIRM "Write the configuration and install?" yes
  [[ $(ans CONFIRM) == yes ]] || die "Cancelled. Nothing was changed."
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

st_build_single() { logrun "Building the images (the first time takes 5-10 minutes)" "${COMPOSE[@]}" build; }

# The application cannot start on an empty database (it reads its settings at boot), so the
# database comes up first, then migrate and seed run in one-off containers, then the application.
st_db_single() {
  [[ $(ans DB_MODE) == bundled ]] || { ok "Using your own database: nothing to start."; return 0; }
  local svcs; svcs=$("${COMPOSE[@]}" config --services 2>>"$LOG" | grep -E '^cockroach' | tr '\n' ' ')
  [[ -n $svcs ]] || { fail "Could not work out which database services to start."; return 1; }
  # shellcheck disable=SC2086
  logrun "Starting the database ($svcs)" "${COMPOSE[@]}" up -d $svcs
}

oneoff_api() { # script name; retried while the database finishes starting
  local script=$1 tries=40 i
  [[ $(ans DB_MODE) == external ]] && tries=4
  printf '  running %s ' "$script"
  for ((i = 0; i < tries; i++)); do
    if "${COMPOSE[@]}" run -T --rm --no-deps api node "dist/scripts/$script.js" >>"$LOG" 2>&1; then printf ' %sok%s\n' "$G" "$Z"; return 0; fi
    printf '.'; sleep 3
  done
  printf ' %sFAILED%s\n' "$R" "$Z"; tail -n 20 "$LOG" | sed 's/^/      /' >&2
  fail "It did not run. Common causes: the database login or address is wrong, or the database does not exist. See $LOG"
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

st_build() { logrun "Building the images (the first time takes 5-10 minutes)" bash scripts/compose.sh --prod build; }

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
  pause "Start the other nodes now (./install.sh --join ...). When each has printed its node id (or 'Waiting for the first node'), continue here."
  wait_for "every other node's database and object store ports (open on the nodes' firewalls?)" 900 peer_ports_open || {
    fail "The other nodes' database and object store ports must be reachable from this machine (see INSTALL.md, Requirements)."
    return 1; }
}

st_init_db() { bundled_db || return 0; logrun "Forming the database cluster" cc init-db; }

st_garage() {
  bundled_s3 || return 0
  local ids=() i
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

run_first_node() {
  setup_compose
  run_stage prep "Preparing" st_prep
  run_stage ports "Checking ports" st_ports
  bundled_db && run_stage certs "Creating certificates" st_certs
  run_stage packages "Packaging the other nodes" st_packages
  run_stage build "Building" st_build
  if bundled_db || bundled_s3; then run_stage start-data "Starting the data services" st_start_data; fi
  run_stage wait-peers "Waiting for the other nodes" st_wait_peers
  run_stage init-db "Initialising the database" st_init_db
  run_stage garage "Forming the object store" st_garage
  run_stage migrate "Migrating the database" st_migrate_cluster
  run_stage seed "Seeding the defaults" st_seed_cluster
  run_stage up "Starting the application" st_up_cluster
  run_stage release "Starting the other nodes' applications" st_release_peers
  run_stage health "Waiting for this node" st_health
}

# ---- joining ------------------------------------------------------------------------------------
st_join_env() {
  local tmp; tmp=$(mktemp -d); chmod 700 "$tmp"
  tar -xzf "$JOIN_PKG" -C "$tmp" || { fail "Could not read $JOIN_PKG."; return 1; }
  [[ -f $tmp/.env && -f $tmp/COMMIT ]] || { fail "$JOIN_PKG is not a node package from ./install.sh."; return 1; }
  local want have_commit
  want=$(cut -d' ' -f1 "$tmp/COMMIT"); have_commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)
  if [[ $want != unknown && $want != "$have_commit" ]]; then
    warn "This checkout is at ${have_commit:0:10} but the first node is at ${want:0:10}. Every node must run the same build."
    ask_yn JOIN_COMMIT_OK "Continue anyway?" no
    [[ $(ans JOIN_COMMIT_OK) == yes ]] || { fail "Check out the same commit (git checkout $want) and run again."; return 1; }
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

  Now:
    - Delete the node packages (they hold the secrets):  rm -r data/cluster-packages
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
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

printf '\n%sChurch Dashboard installer%s\n' "$B" "$Z"
say "This asks a few questions, then installs. Press Ctrl-C at any time; running it again carries on."

(( FRESH )) && rm -f "$STATE"
preflight

if [[ -n $PRESET_FILE ]]; then
  load_answers "$PRESET_FILE"
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
      again) rm -f "$STATE"; forget EXISTING ;;
    esac
  elif [[ -f .env ]]; then
    warn "There is already a .env here. If you continue it is backed up first (its secrets are kept)."
    ask_yn OVERWRITE "Continue and replace it?" no
    [[ $(ans OVERWRITE) == yes ]] || exit 0
    forget OVERWRITE
  fi
fi

# Cluster nodes that join are not asked the questions below.
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
summary
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
