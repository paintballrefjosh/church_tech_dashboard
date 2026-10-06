#!/usr/bin/env bash
#
# Tests of ./install.sh that need no docker: it runs the wizard with --dry-run (ask, validate,
# write .env, preview each cluster node's .env) in a throwaway copy of the scripts, for several
# answer sets, and checks what it wrote and what it refused. Also drives the real prompts by
# piping keystrokes into it.
#
#   tests/installer/dry-run.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0; failn=0

check() { # "what" command...
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); printf '  ok    %s\n' "$what"
  else failn=$((failn + 1)); printf '  FAIL  %s\n' "$what"; fi
}
val() { sed -n "s/^$2=//p" "$1" | tail -n 1; }
has() { grep -qx -- "$2" "$1"; }

# A clean copy of what the installer needs, one per scenario.
fresh() {
  local d="$WORK/$1"; rm -rf "$d"; mkdir -p "$d"
  cp "$REPO/install.sh" "$REPO/.env.example" "$d/"
  cp -r "$REPO/scripts" "$d/scripts"
  echo "$d"
}
run() { # dir answers-file [extra args]
  local d=$1 a=$2; shift 2
  (cd "$d" && NO_COLOR=1 ./install.sh --dry-run --answers "$a" "$@" 2>&1)
}
answers() { local f="$WORK/$1.ans"; shift; printf '%s\n' REUSE_SECRET=no "$@" >"$f"; echo "$f"; }

echo "== single server, bundled everything, standard stack"
d=$(fresh a)
a=$(answers a SETUP=single DB_MODE=bundled S3_MODE=bundled EXTERNAL_PORT=8123 BEHIND_LB=no STACK=standard CONFIRM=yes)
run "$d" "$a" >/dev/null; rc=$?
check "exits 0" test $rc -eq 0
check "AUTH_SECRET is 64 hex" grep -Eq '^AUTH_SECRET=[0-9a-f]{64}$' "$d/.env"
check "MEILI key is not the dev key" bash -c "! grep -q dev-master-key '$d/.env'"
check "port written" has "$d/.env" EXTERNAL_PORT=8123
check "DB_MODE bundled" has "$d/.env" DB_MODE=bundled
check "no cluster mode" bash -c "! grep -q '^DEPLOY_MODE=cluster' '$d/.env'"
check ".env is mode 600" test "$(stat -c %a "$d/.env")" = 600
check "answers kept, mode 600" test "$(stat -c %a "$d/.install-answers")" = 600
check "dry run starts nothing" bash -c "! test -f '$d/.install-state'"

echo "== second run keeps the secret; an unchanged .env is left alone, a changed one is backed up"
s1=$(val "$d/.env" AUTH_SECRET)
rm -f "$d/.install-answers"
run "$d" "$a" >/dev/null; rc=$?
check "AUTH_SECRET unchanged" test "$(val "$d/.env" AUTH_SECRET)" = "$s1"
check "identical answers: no backup, .env untouched" bash -c "! ls '$d'/.env.bak-* >/dev/null 2>&1"
a2=$(answers a2 SETUP=single DB_MODE=bundled S3_MODE=bundled EXTERNAL_PORT=8124 BEHIND_LB=no STACK=standard CONFIRM=yes)
rm -f "$d/.install-answers"
run "$d" "$a2" >/dev/null; rc=$?
check "a changed answer is written" has "$d/.env" EXTERNAL_PORT=8124
check "and the old .env is backed up" bash -c "ls '$d'/.env.bak-* >/dev/null 2>&1"
check "AUTH_SECRET still unchanged" test "$(val "$d/.env" AUTH_SECRET)" = "$s1"

echo "== single server, production, own database with an awkward password, own S3, behind a load balancer"
d=$(fresh b)
a=$(answers b SETUP=single DB_MODE=external DB_INPUT=parts DB_ENGINE=yugabyte DB_HOST=db.example.org DB_PORT=5433 \
  DB_NAME=church DB_USER=church 'DB_PASSWORD=p@ss#w/rd$1 x' DB_SSL=verify-full \
  S3_MODE=external S3_ENDPOINT=https://s3.example.org S3_BUCKET=church-files S3_ACCESS_KEY=AKIAEXAMPLE S3_SECRET_KEY=abc/def+ghi= S3_REGION=garage S3_PATH_STYLE=yes \
  EXTERNAL_PORT=8100 BEHIND_LB=yes 'TRUSTED_PROXIES=10.0.0.0/24 192.168.1.5/32' STACK=production CONFIRM=yes)
run "$d" "$a" >"$WORK/b.out"; rc=$?
check "exits 0" test $rc -eq 0
url=$(val "$d/.env" DATABASE_URL)
check "password is percent-encoded in the URL" test "$url" = 'postgresql://church:p%40ss%23w%2Frd%241%20x@db.example.org:5433/church?sslmode=verify-full'
check "DB_MODE external" has "$d/.env" DB_MODE=external
check "S3 external with keys" bash -c "grep -qx S3_ACCESS_KEY=AKIAEXAMPLE '$d/.env' && grep -qx 'S3_SECRET_KEY=abc/def+ghi=' '$d/.env' && grep -qx S3_PATH_STYLE=true '$d/.env'"
check "trusted proxies written" has "$d/.env" 'TRUSTED_PROXIES=10.0.0.0/24 192.168.1.5/32'
check "production NODE_ENV" has "$d/.env" NODE_ENV=production
check "the summary hides the password" bash -c "! grep -q 'p@ss' '$WORK/b.out'"
check "the password is not in the summary encoded either" bash -c "! grep -q 'p%40ss' '$WORK/b.out'"

echo "== several servers installed over SSH from the first machine"
d=$(fresh ssh)
a=$(answers ssh SETUP=cluster CLUSTER_ROLE=first DB_MODE=bundled S3_MODE=bundled EXTERNAL_PORT=8100 TRUSTED_PROXIES= \
  NODES=3 NODE_1_ID=node-a NODE_1_ADDR=10.0.0.11 NODE_2_ID=node-b NODE_2_ADDR=10.0.0.12 NODE_3_ID=node-c NODE_3_ADDR=10.0.0.13 \
  CLUSTER_S3_CAPACITY=100G REMOTE_MODE=ssh REMOTE_DIR=church-dashboard SSH_KEY= SSH_USER=deploy SSH_PORT=2222 SSH_SAME=yes \
  NODE_2_SSH_HOST=b.example.org NODE_3_SSH_HOST=10.0.0.13 REMOTE_GARAGE_META_DIR=/var/lib/church-garage-meta CONFIRM=yes)
run "$d" "$a" >"$WORK/ssh.out"; rc=$?
check "exits 0" test $rc -eq 0
check "the summary names the ssh target of each other machine" bash -c "grep -q 'ssh deploy@b.example.org' '$WORK/ssh.out' && grep -q 'ssh deploy@10.0.0.13' '$WORK/ssh.out'"
check "the same user and port are filled in for every machine" has "$d/.install-answers" NODE_3_SSH_PORT=2222
check "nothing is contacted on a dry run" bash -c "! grep -q 'connecting' '$WORK/ssh.out'"
d=$(fresh ssh2)
a=$(answers ssh2 SETUP=cluster CLUSTER_ROLE=first DB_MODE=bundled S3_MODE=bundled EXTERNAL_PORT=8100 TRUSTED_PROXIES= \
  NODES=2 WITNESS=no NODE_1_ID=a NODE_1_ADDR=10.0.0.11 NODE_2_ID=b NODE_2_ADDR=10.0.0.12 CLUSTER_S3_CAPACITY=100G \
  REMOTE_MODE=ssh REMOTE_DIR=church-dashboard SSH_KEY= SSH_USER=deploy SSH_PORT=22 SSH_SAME=no NODE_2_SSH_HOST=10.0.0.12 NODE_2_SSH_USER=ops NODE_2_SSH_PORT=2200 REMOTE_GARAGE_META_DIR= CONFIRM=yes)
run "$d" "$a" >"$WORK/ssh2.out"; rc=$?
check "a different user and port per machine" bash -c "[ $rc -eq 0 ] && grep -q 'ssh ops@10.0.0.12' '$WORK/ssh2.out' && grep -qx NODE_2_SSH_PORT=2200 '$d/.install-answers'"

echo "== own database as a three node cluster: every host in one URL"
d=$(fresh m)
a=$(answers m SETUP=single DB_MODE=external DB_INPUT=parts DB_ENGINE=yugabyte 'DB_HOST=db1.example.org, db2.example.org:5434,10.0.0.3' DB_PORT=5433 \
  DB_NAME=church DB_USER=church DB_PASSWORD=pw DB_SSL=verify-full S3_MODE=bundled EXTERNAL_PORT=8100 BEHIND_LB=no STACK=production CONFIRM=yes)
run "$d" "$a" >/dev/null; rc=$?
check "exits 0" test $rc -eq 0
check "every host is in the URL, with the default port where none was given" has "$d/.env" 'DATABASE_URL=postgresql://church:pw@db1.example.org:5433,db2.example.org:5434,10.0.0.3:5433/church?sslmode=verify-full'
d=$(fresh m2)
a=$(answers m2 SETUP=single DB_MODE=external DB_INPUT=url 'DATABASE_URL=postgresql://u:p@a.example.org:5433,b.example.org:5433,c.example.org:5433/church?sslmode=require' DB_TEST=no \
  S3_MODE=bundled EXTERNAL_PORT=8100 BEHIND_LB=no STACK=production CONFIRM=yes)
run "$d" "$a" >/dev/null; rc=$?
check "a pasted multi-host URL is kept as it is" has "$d/.env" 'DATABASE_URL=postgresql://u:p@a.example.org:5433,b.example.org:5433,c.example.org:5433/church?sslmode=require'

echo "== database encryption choices"
d=$(fresh tls)
a=$(answers tls SETUP=single DB_MODE=external DB_INPUT=parts DB_ENGINE=yugabyte DB_HOST=db.example.org DB_PORT=5433 DB_NAME=church DB_USER=c DB_PASSWORD=pw DB_SSL=no-verify S3_MODE=bundled EXTERNAL_PORT=8100 BEHIND_LB=no STACK=production CONFIRM=yes)
run "$d" "$a" >/dev/null
check "no-verify (encrypt, do not check the certificate) is written as such" bash -c "grep -q '^DATABASE_URL=.*sslmode=no-verify' '$d/.env'"
d=$(fresh tls2)
a=$(answers tls2 SETUP=single DB_MODE=external DB_INPUT=parts DB_ENGINE=yugabyte DB_HOST=db.example.org DB_PORT=5433 DB_NAME=church DB_USER=c DB_PASSWORD=pw DB_SSL=require S3_MODE=bundled EXTERNAL_PORT=8100 BEHIND_LB=no STACK=production CONFIRM=yes)
run "$d" "$a" >"$WORK/tls2.out"
check "an old answer of 'require' becomes verify-full, with a warning (that is what the app always did with it)" bash -c "grep -q '^DATABASE_URL=.*sslmode=verify-full' '$d/.env' && grep -q 'DB_SSL=require is now verify-full' '$WORK/tls2.out'"
d=$(fresh tls3)
a=$(answers tls3 SETUP=single DB_MODE=external DB_INPUT=url 'DATABASE_URL=postgresql://u:p@db.example.org:5433/church?sslmode=require' DB_TEST=no S3_MODE=bundled EXTERNAL_PORT=8100 BEHIND_LB=no STACK=production CONFIRM=yes)
run "$d" "$a" >"$WORK/tls3.out"
check "a pasted sslmode=require is flagged: it verifies in this app" grep -q 'means VERIFY the certificate' "$WORK/tls3.out"

echo "== several servers, bundled database and store (shape C), three nodes"
d=$(fresh c)
a=$(answers c REMOTE_MODE=manual SETUP=cluster CLUSTER_ROLE=first DB_MODE=bundled S3_MODE=bundled EXTERNAL_PORT=8100 TRUSTED_PROXIES=10.0.0.0/24 \
  NODES=3 NODE_1_ID=node-a NODE_1_ADDR=10.0.0.11 NODE_2_ID=node-b NODE_2_ADDR=10.0.0.12 NODE_3_ID=node-c NODE_3_ADDR=10.0.0.13 \
  CLUSTER_S3_CAPACITY=200G CONFIRM=yes)
run "$d" "$a" >/dev/null; rc=$?
check "exits 0" test $rc -eq 0
p="$d/data/cluster-packages"
check "this node: cluster mode, id, address, peers" bash -c "grep -qx DEPLOY_MODE=cluster '$d/.env' && grep -qx NODE_ID=node-a '$d/.env' && grep -qx NODE_ADDR=10.0.0.11 '$d/.env' && grep -qx CLUSTER_PEERS=10.0.0.12,10.0.0.13 '$d/.env'"
check "node b: its own id, address and the other two as peers" bash -c "grep -qx NODE_ID=node-b '$p/preview-node-b.env' && grep -qx NODE_ADDR=10.0.0.12 '$p/preview-node-b.env' && grep -qx CLUSTER_PEERS=10.0.0.11,10.0.0.13 '$p/preview-node-b.env'"
check "node c: peers" has "$p/preview-node-c.env" CLUSTER_PEERS=10.0.0.11,10.0.0.12
check "every node shares AUTH_SECRET and MEILI key" bash -c "[ \"\$(grep -h ^AUTH_SECRET= '$d/.env' '$p'/preview-*.env | sort -u | wc -l)\" = 1 ] && [ \"\$(grep -h ^MEILI_MASTER_KEY= '$d/.env' '$p'/preview-*.env | sort -u | wc -l)\" = 1 ]"
check "capacity written" has "$d/.env" CLUSTER_S3_CAPACITY=200G
check "no node is a witness" bash -c "! grep -q '^NODE_ROLE=' '$d/.env' '$p'/preview-*.env"

echo "== two nodes plus a witness"
d=$(fresh w)
a=$(answers w REMOTE_MODE=manual SETUP=cluster CLUSTER_ROLE=first DB_MODE=bundled S3_MODE=bundled EXTERNAL_PORT=8100 TRUSTED_PROXIES= \
  NODES=2 WITNESS=yes NODE_1_ID=a NODE_1_ADDR=10.0.0.11 NODE_2_ID=b NODE_2_ADDR=10.0.0.12 NODE_3_ID=w NODE_3_ADDR=10.0.0.13 CLUSTER_S3_CAPACITY=100G CONFIRM=yes)
run "$d" "$a" >/dev/null; rc=$?
check "exits 0" test $rc -eq 0
check "the witness is a data node" has "$d/data/cluster-packages/preview-w.env" NODE_ROLE=data
check "the others are full nodes" bash -c "! grep -q '^NODE_ROLE=' '$d/.env' '$d/data/cluster-packages/preview-b.env'"
check "the first node lists both peers" has "$d/.env" CLUSTER_PEERS=10.0.0.12,10.0.0.13

echo "== several servers, own database and own store (shape D)"
d=$(fresh d)
a=$(answers d REMOTE_MODE=manual SETUP=cluster CLUSTER_ROLE=first DB_MODE=external DB_INPUT=url 'DATABASE_URL=postgresql://church:pw@db.example.org:5433/church?sslmode=require' DB_TEST=no \
  S3_MODE=external S3_ENDPOINT=s3.example.org S3_BUCKET=church-files S3_ACCESS_KEY=k S3_SECRET_KEY=s S3_REGION=garage S3_PATH_STYLE=yes \
  EXTERNAL_PORT=8100 TRUSTED_PROXIES=10.1.0.0/16 NODES=2 NODE_1_ID=web-1 NODE_2_ID=web-2 CONFIRM=yes)
run "$d" "$a" >/dev/null; rc=$?
check "exits 0" test $rc -eq 0
check "cluster mode and node id only" bash -c "grep -qx DEPLOY_MODE=cluster '$d/.env' && grep -qx NODE_ID=web-1 '$d/.env' && ! grep -q '^NODE_ADDR=' '$d/.env' && ! grep -q '^CLUSTER_PEERS=' '$d/.env'"
check "node 2 shares the database URL" has "$d/data/cluster-packages/preview-web-2.env" 'DATABASE_URL=postgresql://church:pw@db.example.org:5433/church?sslmode=require'
check "node 2 has its own id" has "$d/data/cluster-packages/preview-web-2.env" NODE_ID=web-2

echo "== bundled object store on a network file system (only when this checkout is on one)"
if stat -f -c %T "$REPO" | grep -Eq '^(nfs|cifs|smb|fuse\.sshfs)'; then
  nd="$REPO/tests/installer/.nfs-scratch"; rm -rf "$nd"; mkdir -p "$nd"
  cp "$REPO/install.sh" "$REPO/.env.example" "$nd/"; cp -r "$REPO/scripts" "$nd/scripts"
  printf '%s\n' REUSE_SECRET=no SETUP=single DB_MODE=bundled S3_MODE=bundled EXTERNAL_PORT=8100 BEHIND_LB=no STACK=standard CONFIRM=yes >"$WORK/nfs.ans"
  (cd "$nd" && NO_COLOR=1 ./install.sh --dry-run --answers "$WORK/nfs.ans" >"$WORK/nfs.out" 2>&1 </dev/null)
  check "asks for a local metadata folder instead of using the network share" grep -q 'Local folder for the object store' "$WORK/nfs.out"
  printf '%s\n' GARAGE_META_DIR=/var/lib/x >>"$WORK/nfs.ans"
  (cd "$nd" && NO_COLOR=1 ./install.sh --dry-run --answers "$WORK/nfs.ans" >/dev/null 2>&1 </dev/null)
  check "uses the folder it was given" has "$nd/.env" GARAGE_META_DIR=/var/lib/x
  rm -rf "$nd"
else
  echo "  (skipped: this checkout is on local disk)"
fi

echo "== things it must refuse"
refuse() { # name key=value ... (applied on top of the shape A answers)
  local name=$1; shift
  local d; d=$(fresh "r-$name")
  local f; f=$(answers "r-$name" SETUP=single DB_MODE=bundled S3_MODE=bundled EXTERNAL_PORT=8100 BEHIND_LB=no STACK=standard CONFIRM=yes "$@")
  run "$d" "$f" >/dev/null; local rc=$?
  check "refuses $name" test $rc -ne 0
}
refuse "a port out of range" EXTERNAL_PORT=99999
refuse "a bad load balancer address" BEHIND_LB=yes TRUSTED_PROXIES=not-an-ip
refuse "localhost as the database host" DB_MODE=external DB_INPUT=parts DB_ENGINE=yugabyte DB_HOST=localhost DB_PORT=5433 DB_NAME=church DB_USER=c DB_PASSWORD=x DB_SSL=verify-full
refuse "a database URL pointing at localhost" DB_MODE=external DB_INPUT=url 'DATABASE_URL=postgresql://u:p@localhost:5433/church'
refuse "localhost among several database hosts" DB_MODE=external DB_INPUT=parts DB_ENGINE=yugabyte DB_HOST=db1.example.org,localhost DB_PORT=5433 DB_NAME=church DB_USER=c DB_PASSWORD=x DB_SSL=verify-full
refuse "localhost among the hosts of a pasted URL" DB_MODE=external DB_INPUT=url 'DATABASE_URL=postgresql://u:p@a.example.org:5433,127.0.0.1:5433/church'
refuse "a malformed host in the list" DB_MODE=external DB_INPUT=parts DB_ENGINE=yugabyte 'DB_HOST=db1.example.org,bad host' DB_PORT=5433 DB_NAME=church DB_USER=c DB_PASSWORD=x DB_SSL=verify-full
refuse "an ssh user with a space" SETUP=cluster CLUSTER_ROLE=first NODES=2 WITNESS=no NODE_1_ID=a NODE_1_ADDR=10.0.0.11 NODE_2_ID=b NODE_2_ADDR=10.0.0.12 CLUSTER_S3_CAPACITY=1G TRUSTED_PROXIES= REMOTE_MODE=ssh REMOTE_DIR=x SSH_KEY= 'SSH_USER=bad user' SSH_PORT=22 SSH_SAME=yes NODE_2_SSH_HOST=10.0.0.12
refuse "an S3 secret with a space" S3_MODE=external S3_ENDPOINT=s3.example.org S3_BUCKET=church-files S3_ACCESS_KEY=k 'S3_SECRET_KEY=a b' S3_REGION=r S3_PATH_STYLE=yes
refuse "an unknown choice" STACK=turbo
d=$(fresh dup)
a=$(answers dup REMOTE_MODE=manual SETUP=cluster CLUSTER_ROLE=first DB_MODE=bundled S3_MODE=bundled EXTERNAL_PORT=8100 TRUSTED_PROXIES= NODES=2 WITNESS=no NODE_1_ID=same NODE_1_ADDR=10.0.0.1 NODE_2_ID=same NODE_2_ADDR=10.0.0.2 CLUSTER_S3_CAPACITY=1G CONFIRM=yes)
run "$d" "$a" >/dev/null; rc=$?
check "refuses two nodes with one name" test $rc -ne 0
d=$(fresh no)
a=$(answers no SETUP=single DB_MODE=bundled S3_MODE=bundled EXTERNAL_PORT=8100 BEHIND_LB=no STACK=standard CONFIRM=no)
run "$d" "$a" >/dev/null; rc=$?
check "declining the review exits non-zero" test $rc -ne 0
check "and writes nothing" bash -c "! test -f '$d/.env'"

echo "== the real prompts, driven by keystrokes"
d=$(fresh k)
# SETUP 1 (one server), DB 1 (bundled), S3 1 (bundled), port: Enter, behind a load balancer: Enter (no),
# stack: 2 (standard), existing-secret question: Enter (no), review: Enter (yes)
(cd "$d" && printf '1\n1\n1\n\n\n2\n\n\n' | NO_COLOR=1 ./install.sh --dry-run >/dev/null 2>&1); rc=$?
check "exits 0" test $rc -eq 0
check "defaults used: port 8100, bundled" bash -c "grep -qx EXTERNAL_PORT=8100 '$d/.env' && grep -qx DB_MODE=bundled '$d/.env' && grep -qx S3_MODE=bundled '$d/.env'"
check "chose the standard stack" has "$d/.install-answers" STACK=standard
(cd "$d" && printf "" | NO_COLOR=1 ./install.sh --dry-run --fresh >/dev/null 2>&1); rc=$?
check "no input at all is an error, not a loop" test $rc -ne 0
d=$(fresh k2)
(cd "$d" && printf '9\n1\n1\n1\n\n\n2\n\n\n' | NO_COLOR=1 ./install.sh --dry-run --fresh >"$WORK/oor.out" 2>&1)
check "a menu number out of range is asked again" grep -q 'Please enter a number' "$WORK/oor.out"

echo "== editing an answer on a real terminal"
if command -v python3 >/dev/null 2>&1; then
  d=$(fresh pty)
  python3 "$REPO/tests/installer/pty-edit.py" "$d" >/dev/null 2>&1; rc=$?
  check "Backspace (^H and DEL) edits an answer instead of adding garbage to it" test $rc -eq 0
else
  echo "  (skipped: python3 is not installed)"
fi

echo "== saying no at the review asks the questions again"
d=$(fresh again)
# first pass: one server, bundled, bundled, port 8111, no proxy, standard stack, no old secret, review: no
# second pass: the same menus, port 8222, review: yes
(cd "$d" && printf '1\n1\n1\n8111\n\n2\n\nn\n1\n1\n1\n8222\n\n2\n\n\n' | NO_COLOR=1 ./install.sh --dry-run >"$WORK/again.out" 2>&1); rc=$?
check "exits 0 after the second pass" test $rc -eq 0
check "says it is starting again" grep -q 'Starting the questions again' "$WORK/again.out"
check "only the second pass's answers are used" bash -c "grep -qx EXTERNAL_PORT=8222 '$d/.env' && ! grep -q 8111 '$d/.env'"

echo "== colours"
d=$(fresh col)
(cd "$d" && printf '1\n1\n1\n\n\n2\n\n\n' | INSTALL_COLOR=1 ./install.sh --dry-run >"$WORK/col.out" 2>&1)
check "questions are cyan, typed answers green" bash -c "grep -q \$'\\e\\[1;36m? How do you want' '$WORK/col.out' && grep -q \$'\\e\\[1;32m>' '$WORK/col.out'"
(cd "$d" && printf '1\n1\n1\n\n\n2\n\n\n' | NO_COLOR=1 INSTALL_COLOR=1 ./install.sh --dry-run --fresh >"$WORK/nocol.out" 2>&1)
check "NO_COLOR removes every escape" bash -c "! grep -q \$'\\e' '$WORK/nocol.out'"

echo
echo "installer dry-run tests: $pass passed, $failn failed"
[[ $failn -eq 0 ]]
