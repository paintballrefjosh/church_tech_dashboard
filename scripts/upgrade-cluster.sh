#!/usr/bin/env bash
#
# Upgrade every node of a cluster, one after another, by running scripts/upgrade.sh on each. Run it from any
# machine that can SSH to the nodes with a key (normally the first node, which is then "local").
#
#   scripts/upgrade-cluster.sh                  upgrade all nodes to the newest commit of this branch's upstream
#   scripts/upgrade-cluster.sh --check          look at every node (versions, what would change), touch nothing
#   scripts/upgrade-cluster.sh --to <ref>       upgrade (or move) every node to one commit, tag or branch
#   scripts/upgrade-cluster.sh --rollback       put every node back on the version it ran before its last upgrade
#
#   --nodes <file>       the node list (default: data/upgrade/nodes, else derived from CLUSTER_PEERS in .env)
#   --no-backup          no database backup first (default: one, on the first node, with a bundled database)
#   --drain-wait <sec>   passed to each node's upgrade.sh (how long a drained node waits for open requests)
#   --settle <sec>       pause after a node is back, before the next one (default 10)
#   --prune              passed to each node's upgrade.sh (remove dangling images afterwards)
#   --yes                do not ask for confirmation
#
# The node list is one node per line, `local` for the machine running this script and `[user@]host[:port] [folder]`
# for the others (the folder is the checkout, relative to the SSH user's home or absolute; default
# church-dashboard). Lines starting with # are comments.
#
#   local
#   josh@10.0.0.12
#   josh@10.0.0.13:2222 /srv/church
#
# Without a file, the nodes are this machine plus every entry of CLUSTER_PEERS (host name or address only) reached as
# your own user, with the checkout in ~/church-dashboard, and it says so before it does anything.
#
# How it keeps a cluster up:
#   * One node at a time. A node's own upgrade.sh drains it, builds, migrates (the first node does that for the
#     shared database; migrations are additive, so nodes still on the old version keep working), swaps, checks
#     it runs the new build and puts it back. This script then waits for the node's /healthz to answer 200
#     before it touches the next one.
#   * Every node gets the same commit: it is resolved once, here, and passed as `--to <sha>`.
#   * It STOPS at the first node that fails. That node has already put itself back on its previous version
#     (upgrade.sh does that), the nodes after it are untouched, and the nodes before it stay upgraded. The
#     summary says which is which. Fix the cause and run this again (finished nodes are skipped), or run
#     --rollback to bring the upgraded ones back.
#   * A remote upgrade runs detached on the node and this script follows its log, so a dropped SSH connection
#     (or Ctrl-C here) does not interrupt it halfway; run this again and it carries on.
#   * Nodes that only hold the database and object store (NODE_ROLE=data) are skipped: there is no app to upgrade.
#
# SSH is key-only (BatchMode): this script never asks for or stores a password. Extra ssh options (a key file, a
# jump host) go in UC_SSH_OPTIONS, e.g. UC_SSH_OPTIONS="-i ~/.ssh/church".
set -euo pipefail

# Run from a copy: upgrading the local node replaces files in this checkout, this one included.
if [[ -z "${UC_ROOT:-}" ]]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  COPY="$(mktemp)"
  cp "$0" "$COPY"
  UC_ROOT="$ROOT" UC_COPY="$COPY" exec bash "$COPY" "$@"
fi
cd "$UC_ROOT"
CM_DIR="$(mktemp -d)"
trap 'rm -rf "$CM_DIR" "${UC_COPY:-}"' EXIT

POLL_SEC="${UC_POLL_SEC:-3}"           # how often a remote upgrade's log is read (tests shorten these)
HEALTH_WAIT="${UC_HEALTH_WAIT:-90}"    # how long a finished node gets to answer /healthz
CHECK=0 ROLLBACK=0 YES=0 PRUNE=0 TO="" NODES_FILE="" BACKUP=yes DRAIN_WAIT="" SETTLE=10
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --to) TO="${2:?--to needs a commit, tag or branch}"; shift 2 ;;
    --nodes) NODES_FILE="${2:?--nodes needs a file}"; shift 2 ;;
    --no-backup) BACKUP=no; shift ;;
    --drain-wait) DRAIN_WAIT="${2:?--drain-wait needs a number of seconds}"; shift 2 ;;
    --settle) SETTLE="${2:?--settle needs a number of seconds}"; shift 2 ;;
    --prune) PRUNE=1; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,45p' "${UC_COPY:-$0}"; exit 0 ;;
    *) echo "upgrade-cluster.sh: unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
[[ "$SETTLE" =~ ^[0-9]+$ ]] || { echo "upgrade-cluster.sh: --settle must be a number of seconds" >&2; exit 2; }
[[ -z "$DRAIN_WAIT" || "$DRAIN_WAIT" =~ ^[0-9]+$ ]] || { echo "upgrade-cluster.sh: --drain-wait must be a number of seconds" >&2; exit 2; }
[[ -z "$TO" || $ROLLBACK -eq 0 ]] || { echo "upgrade-cluster.sh: use either --to or --rollback" >&2; exit 2; }

if [[ ( -t 1 && -z "${NO_COLOR:-}" ) || "${UPGRADE_COLOR:-}" == always ]]; then
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; Z=$'\033[0m'
else B=""; D=""; G=""; Y=""; R=""; C=""; Z=""; fi
say()   { printf '%s\n' "$*"; }
note()  { printf '%s%s%s\n' "$D" "$*" "$Z"; }
head1() { printf '\n%s%s==>%s %s%s%s\n' "$B" "$C" "$Z" "$B" "$*" "$Z"; }
ok()    { printf '%s  ok%s  %s\n' "$G" "$Z" "$*"; }
warn()  { printf '%s  !!%s  %s%s%s\n' "$Y" "$Z" "$Y" "$*" "$Z" >&2; }
die()   { printf '%s%supgrade-cluster.sh:%s %s%s%s\n' "$B" "$R" "$Z" "$R" "$*" "$Z" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is needed."
command -v ssh >/dev/null 2>&1 || die "ssh is needed."
git rev-parse --git-dir >/dev/null 2>&1 || die "this is not a git checkout."

# ---- the node list ---------------------------------------------------------------------------------------
N_TARGET=() N_PORT=() N_DIR=() N_NAME=() N_ROLE=() N_PORTHTTP=() N_HEAD=() N_STATE=()
add_node() { # target (local | [user@]host[:port]) [folder]
  local t=$1 dir=${2:-church-dashboard} port=""
  if [[ "$t" != local ]]; then
    if [[ "$t" =~ ^(.+):([0-9]+)$ ]]; then t=${BASH_REMATCH[1]}; port=${BASH_REMATCH[2]}; fi
    [[ "$t" =~ ^([A-Za-z0-9._-]+@)?[A-Za-z0-9._:-]+$ ]] || die "not a usable SSH target: '$1'"
  fi
  [[ "$dir" =~ ^[A-Za-z0-9._/~-]+$ ]] || die "not a usable folder: '$dir'"
  N_TARGET+=("$t"); N_PORT+=("$port"); N_DIR+=("$dir"); N_NAME+=("${t#*@}"); N_ROLE+=(""); N_PORTHTTP+=(""); N_HEAD+=(""); N_STATE+=("")
}

conf_env() { [[ -f .env ]] && sed -n "s/^$1=//p" .env | tail -n 1 | sed -E 's/[[:space:]]+#.*$//; s/^"(.*)"$/\1/' || true; }

DERIVED=0
[[ -n "$NODES_FILE" || ! -f data/upgrade/nodes ]] || NODES_FILE=data/upgrade/nodes
if [[ -n "$NODES_FILE" ]]; then
  [[ -f "$NODES_FILE" ]] || die "the node list $NODES_FILE does not exist."
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    # shellcheck disable=SC2086
    set -- $line
    [[ $# -gt 0 ]] || continue
    add_node "$1" "${2:-}"
  done <"$NODES_FILE"
else
  DERIVED=1
  add_node local
  peers="$(conf_env CLUSTER_PEERS)"
  IFS=',' read -ra PEER_LIST <<<"$peers"
  for p in "${PEER_LIST[@]:-}"; do
    p="${p// /}"; [[ -n "$p" ]] || continue
    add_node "${USER:-$(id -un)}@${p%%:*}"   # CLUSTER_PEERS entries may be host:dbport:rpcport
  done
fi
(( ${#N_TARGET[@]} > 0 )) || die "no nodes: list them in data/upgrade/nodes (see --help)."
LOCALS=0; for t in "${N_TARGET[@]}"; do [[ "$t" == local ]] && LOCALS=$((LOCALS + 1)); done
(( LOCALS <= 1 )) || die "'local' appears more than once in the node list."

# ---- talking to a node -------------------------------------------------------------------------------------
ssh_args() { # node index
  SSH_A=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ControlMaster=auto -o "ControlPath=$CM_DIR/cm-%C" -o ControlPersist=10m)
  [[ -z "${N_PORT[$1]}" ]] || SSH_A+=(-p "${N_PORT[$1]}")
  # Extra ssh options for every node (a key file, a jump host...): UC_SSH_OPTIONS="-i ~/.ssh/church -J bastion".
  # shellcheck disable=SC2206
  [[ -z "${UC_SSH_OPTIONS:-}" ]] || SSH_A+=($UC_SSH_OPTIONS)
}
# Run a command in the node's checkout (the local one for `local`). Output on stdout; its status is the result.
nsh() { # index command
  local i=$1 cmd=$2 d
  if [[ "${N_TARGET[$i]}" == local ]]; then
    ( cd "$UC_ROOT" && bash -c "$cmd" )
  else
    d="$(printf '%q' "${N_DIR[$i]}")"
    ssh_args "$i"
    ssh "${SSH_A[@]}" "${N_TARGET[$i]}" "cd $d && $cmd"
  fi
}
label() { printf '%s' "${N_NAME[$1]}"; }
prefixed() { # index: prefix every line of stdin with the node's name
  local p; p="$(printf '%s  [%s]%s ' "$D" "$(label "$1")" "$Z")"
  while IFS= read -r l || [[ -n "$l" ]]; do printf '%s%s\n' "$p" "$l"; done
}

# What each node looks like now: version, role, port, whether it has local changes.
head1 "Looking at the nodes"
(( DERIVED )) && warn "no node list (data/upgrade/nodes): using this machine plus CLUSTER_PEERS, over SSH as $(id -un), checkout ~/church-dashboard."
for i in "${!N_TARGET[@]}"; do
  if ! info="$(nsh "$i" 'test -f scripts/upgrade.sh || { echo NOUPGRADE; exit 0; }; printf "%s\n" "$(git rev-parse HEAD)" "$(sed -n "s/^NODE_ID=//p" .env | tail -n 1)" "$(sed -n "s/^NODE_ROLE=//p" .env | tail -n 1)" "$(sed -n "s/^EXTERNAL_PORT=//p" .env | tail -n 1)" "$(git status --porcelain --untracked-files=no | head -n 1)"' 2>&1)"; then
    die "cannot reach ${N_TARGET[$i]} (${info:-no output}). SSH uses keys only here: check the host, user and key, and that the folder '${N_DIR[$i]}' exists."
  fi
  [[ "$info" != NOUPGRADE ]] || die "${N_TARGET[$i]}: no scripts/upgrade.sh in '${N_DIR[$i]}'. Is that the checkout?"
  mapfile -t f <<<"$info"
  N_HEAD[i]="${f[0]:-}"
  [[ -z "${f[1]:-}" ]] || N_NAME[i]="${f[1]}"
  N_ROLE[i]="${f[2]:-full}"; [[ -n "${N_ROLE[$i]}" ]] || N_ROLE[i]=full
  N_PORTHTTP[i]="${f[3]:-8100}"; [[ -n "${N_PORTHTTP[$i]}" ]] || N_PORTHTTP[i]=8100
  [[ -z "${f[4]:-}" ]] || die "$(label "$i"): the checkout has uncommitted changes (${f[4]}). Commit or stash them there first."
done

# ---- the target commit, resolved once ------------------------------------------------------------------------
BRANCH="$(git symbolic-ref --short -q HEAD || true)"
if (( ROLLBACK )); then
  TARGET=""
else
  git fetch --quiet --tags origin 2>/dev/null || warn "could not reach the remote; using what is already here."
  if [[ -n "$TO" ]]; then
    TARGET="$(git rev-parse --verify -q "$TO^{commit}" || git rev-parse --verify -q "origin/$TO^{commit}" || true)"
    [[ -n "$TARGET" ]] || die "'$TO' is not a commit, tag or branch this checkout knows."
  else
    [[ -n "$BRANCH" ]] || die "HEAD is detached here; name the version with --to."
    git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || die "branch '$BRANCH' has no upstream. Use --to <ref>."
    TARGET="$(git rev-parse '@{u}')"
  fi
fi
short() { printf '%s' "${1:0:12}"; }

# ---- the plan --------------------------------------------------------------------------------------------------
printf '\n'
if (( ROLLBACK )); then say "${B}Roll back${Z} every node to the version it ran before its last upgrade (last node first)."
else say "${B}Target${Z} ${C}$(short "$TARGET")${Z}$( [[ -n "$TO" ]] && echo "  ($TO)")"; fi
for i in "${!N_TARGET[@]}"; do
  if [[ "${N_ROLE[$i]}" != full ]]; then
    N_STATE[i]="skip-data"; what="${D}witness (database and object store only): skipped${Z}"
  elif (( ROLLBACK )); then
    N_STATE[i]=todo; what="roll back from $(short "${N_HEAD[$i]}")"
  elif [[ "${N_HEAD[$i]}" == "$TARGET" ]]; then
    N_STATE[i]=current; what="${G}already on $(short "$TARGET")${Z}"
  else
    N_STATE[i]=todo; what="$(short "${N_HEAD[$i]}") -> ${C}$(short "$TARGET")${Z}"
  fi
  printf '  %s%-18s%s %-28s %s\n' "$B" "$(label "$i")" "$Z" "${N_TARGET[$i]}${N_PORT[$i]:+:${N_PORT[$i]}}" "$what"
done
TODO=(); for i in "${!N_TARGET[@]}"; do [[ ${N_STATE[$i]} == todo ]] && TODO+=("$i"); done
if (( ${#TODO[@]} == 0 )); then ok "nothing to do: every app node is already there."; exit 0; fi
if (( ! ROLLBACK )); then
  heads=$(printf '%s\n' "${N_HEAD[@]}" | sort -u | wc -l)
  (( heads <= 1 )) || warn "the nodes are not all on the same version now (see above)."
  [[ "$BACKUP" == yes ]] && note "  database backup: first, on $(label "${TODO[0]}") (skipped by upgrade.sh when the database is external)" || note "  database backup: none (--no-backup)"
  note "  each node: drain, build, migrate (first node), swap, check, back in rotation; then ${SETTLE}s before the next"
fi
(( CHECK )) && note "  --check: each node will only report what it would do."

if (( YES == 0 && CHECK == 0 )); then
  [[ -t 0 ]] || die "no terminal to ask on. Add --yes to go ahead."
  read -r -p "Go ahead, one node at a time? [y/N] " a
  [[ "$a" =~ ^[Yy] ]] || { say "Nothing was changed."; exit 0; }
fi

# ---- running upgrade.sh on a node ----------------------------------------------------------------------------------
node_args() { # index -> the arguments for that node's upgrade.sh
  local i=$1; local -a a=()
  if (( ROLLBACK )); then a+=(--rollback)
  else
    a+=(--to "$TARGET")
    if [[ "$BACKUP" == no ]]; then a+=(--no-backup)
    elif [[ "$i" == "${TODO[0]}" ]]; then a+=(--backup)
    else a+=(--no-backup); fi
  fi
  (( CHECK )) && a+=(--check) || a+=(--yes)
  [[ -z "$DRAIN_WAIT" ]] || a+=(--drain-wait "$DRAIN_WAIT")
  (( PRUNE )) && a+=(--prune)
  printf '%s ' "${a[@]}"
}

# Local: in the foreground. Remote: detached on the node, followed through its log.
run_node() { # index -> exit status of that node's upgrade.sh
  local i=$1 args; args="$(node_args "$i")"
  [[ "$args" =~ ^[A-Za-z0-9._\ =/-]+$ ]] || die "unexpected characters in the arguments: $args"
  if [[ "${N_TARGET[$i]}" == local ]]; then
    # shellcheck disable=SC2086
    bash scripts/upgrade.sh $args 2>&1 | prefixed "$i"
    return "${PIPESTATUS[0]}"
  fi
  local d; d="$(printf '%q' "${N_DIR[$i]}")"
  ssh_args "$i"
  ssh "${SSH_A[@]}" "${N_TARGET[$i]}" "cd $d && mkdir -p data/upgrade && rm -f data/upgrade/remote.rc && : >data/upgrade/remote.log && (setsid nohup bash -c 'bash scripts/upgrade.sh $args >data/upgrade/remote.log 2>&1; echo \$? >data/upgrade/remote.rc' >/dev/null 2>&1 </dev/null &)" \
    || { echo "could not start the upgrade on ${N_TARGET[$i]}" >&2; return 255; }
  local off=0 fails=0 out rc size chunk
  while :; do
    if out="$(ssh "${SSH_A[@]}" "${N_TARGET[$i]}" "cd $d && rc=\$(cat data/upgrade/remote.rc 2>/dev/null); size=\$(wc -c <data/upgrade/remote.log); echo \"\$rc\"; echo \"\$size\"; tail -c +$((off + 1)) data/upgrade/remote.log | head -c \$((size - $off))" 2>/dev/null)"; then
      fails=0
      rc="$(sed -n 1p <<<"$out")"; size="$(sed -n 2p <<<"$out")"
      chunk="$(tail -n +3 <<<"$out")"
      [[ -z "$chunk" ]] || prefixed "$i" <<<"$chunk"
      [[ "$size" =~ ^[0-9]+$ ]] && off="$size"
      [[ -z "$rc" ]] || { return "$rc"; }
    else
      fails=$((fails + 1))
      (( fails < 40 )) || { echo "lost contact with ${N_TARGET[$i]}; its upgrade carries on there (log: $(label "$i"):${N_DIR[$i]}/data/upgrade/remote.log). Run this again later." >&2; return 254; }
    fi
    sleep "$POLL_SEC"
  done
}

# 200 from the node's own /healthz means the API reaches the database and the node is not draining.
wait_in_rotation() { # index
  local i=$1 deadline=$((SECONDS + HEALTH_WAIT))
  until nsh "$i" "curl -fsS -m 5 -o /dev/null http://127.0.0.1:${N_PORTHTTP[$i]}/healthz" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || return 1
    sleep "$POLL_SEC"
  done
}

DONE=() FAILED="" UNTOUCHED=()
order=("${TODO[@]}")
if (( ROLLBACK )); then order=(); for ((k=${#TODO[@]}-1; k>=0; k--)); do order+=("${TODO[$k]}"); done; fi
START=$SECONDS
n=0
for i in "${order[@]}"; do
  n=$((n + 1))
  head1 "$(label "$i")  ($n of ${#order[@]})$( ((CHECK)) && echo '  --check' )"
  if run_node "$i"; then
    if (( CHECK )); then DONE+=("$i"); continue; fi
    if wait_in_rotation "$i"; then
      ok "$(label "$i") answers /healthz with 200 and is back in rotation"
      DONE+=("$i")
      (( n < ${#order[@]} && SETTLE > 0 )) && { note "waiting ${SETTLE}s before the next node"; sleep "$SETTLE"; }
    else
      warn "$(label "$i") finished but its /healthz does not answer 200 within ${HEALTH_WAIT}s."
      FAILED="$i"; break
    fi
  else
    rc=$?
    FAILED="$i"; warn "$(label "$i"): upgrade.sh exited with status $rc."; break
  fi
done

# ---- the summary --------------------------------------------------------------------------------------------------------
if [[ -n "$FAILED" ]]; then
  seen=0; UNTOUCHED=()
  for i in "${order[@]}"; do [[ "$i" == "$FAILED" ]] && { seen=1; continue; }; (( seen )) && UNTOUCHED+=("$i"); done
  head1 "Stopped at $(label "$FAILED")"
  for i in "${DONE[@]:-}"; do [[ -n "$i" ]] && say "  ${G}done${Z}       $(label "$i")"; done
  say "  ${R}failed${Z}     $(label "$FAILED")   (its upgrade.sh puts it back on its previous version by itself; its log is in ${N_DIR[$FAILED]}/data/upgrade/)"
  for i in "${UNTOUCHED[@]:-}"; do [[ -n "$i" ]] && say "  ${D}untouched${Z}  $(label "$i")"; done
  say
  say "The cluster is running mixed versions until this is resolved (migrations are additive, so that is safe for a while)."
  say "  Fix the cause, then run this again: finished nodes are skipped.   Or go back with: scripts/upgrade-cluster.sh --rollback"
  exit 1
fi
head1 "Done in $((SECONDS - START))s"
for i in "${DONE[@]}"; do say "  ${G}ok${Z}  $(label "$i")"; done
if (( CHECK )); then say; ok "--check: nothing was changed."
elif (( ROLLBACK )); then say; note "  nodes are on a detached commit now: git checkout <your branch> before the next upgrade."
else note "  Admin > Cluster shows every node's build."; fi
exit 0
