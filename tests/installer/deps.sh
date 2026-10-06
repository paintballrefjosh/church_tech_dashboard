#!/usr/bin/env bash
#
# Does `./install.sh --check-requirements` install what is missing? Runs it in clean containers that have
# neither make nor git (Ubuntu, Debian, Fedora, Alpine as root; Ubuntu as a user with passwordless sudo) with
# the answers "install them, but not Docker", and checks make and git exist afterwards and that it then
# stops, as it must, on the missing Docker. Docker's own install script is NOT run here (it would install
# Docker inside a throwaway container, which proves nothing about a real machine).
#
#   tests/installer/deps.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; failn=0
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "  ok    $what"; else failn=$((failn + 1)); echo "  FAIL  $what"; fi; }

work() { # image prepare-command  -> runs the installer as root inside a container, prints its output
  local image=$1 prep=$2
  docker run --rm -v "$REPO":/src:ro "$image" sh -c "
    $prep
    mkdir -p /t && cd /src && tar --exclude=./data --exclude=node_modules --exclude=.git --exclude=dist --exclude=.next -cf - . | tar -xf - -C /t
    cd /t && printf 'AUTO_INSTALL_DEPS=yes\nAUTO_INSTALL_DOCKER=no\n' > a.ans
    NO_COLOR=1 ./install.sh --check-requirements --answers a.ans </dev/null; echo \"rc=\$?\"
    for t in make git; do command -v \$t >/dev/null 2>&1 && echo \"HAVE \$t\" || echo \"MISSING \$t\"; done
  " 2>&1
}

for spec in \
  "ubuntu:24.04|apt-get update -qq >/dev/null && apt-get install -y -qq bash >/dev/null" \
  "debian:12|apt-get update -qq >/dev/null && apt-get install -y -qq bash >/dev/null" \
  "fedora:41|dnf install -y -q bash which findutils >/dev/null" \
  "alpine:3.20|apk add --no-cache bash coreutils findutils >/dev/null"; do
  image=${spec%%|*}; prep=${spec#*|}
  echo "== $image (root)"
  out=$(work "$image" "$prep")
  check "$image: make and git are installed" bash -c "grep -q 'HAVE make' <<<'$(printf '%s' "$out" | tr "'" ' ')' && grep -q 'HAVE git' <<<'$(printf '%s' "$out" | tr "'" ' ')'"
  check "$image: it said what it installed" grep -q 'installed make git' <<<"$out"
  check "$image: then stopped on the missing Docker, with a way forward" bash -c "grep -q 'Docker is not installed' <<<\"\$1\" && grep -q 'rc=1' <<<\"\$1\"" _ "$out"
done

echo "== ubuntu:24.04 (a user with passwordless sudo)"
out=$(docker run --rm -v "$REPO":/src:ro ubuntu:24.04 sh -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq bash sudo >/dev/null
  useradd -m tester && echo "tester ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/tester
  mkdir -p /home/tester/t && cd /src && tar --exclude=./data --exclude=node_modules --exclude=.git --exclude=dist --exclude=.next -cf - . | tar -xf - -C /home/tester/t
  chown -R tester /home/tester
  su tester -c "cd ~/t && printf \"AUTO_INSTALL_DEPS=yes\nAUTO_INSTALL_DOCKER=no\n\" > a.ans && NO_COLOR=1 ./install.sh --check-requirements --answers a.ans </dev/null; echo rc=\$?; command -v make >/dev/null && echo HAVE-make; command -v git >/dev/null && echo HAVE-git"
' 2>&1)
check "make and git installed through sudo" bash -c "grep -q 'HAVE-make' <<<\"\$1\" && grep -q 'HAVE-git' <<<\"\$1\"" _ "$out"
echo "== answering no installs nothing"
out=$(docker run --rm -v "$REPO":/src:ro ubuntu:24.04 sh -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq bash >/dev/null
  mkdir -p /t && cd /src && tar --exclude=./data --exclude=node_modules --exclude=.git --exclude=dist --exclude=.next -cf - . | tar -xf - -C /t
  cd /t && printf "AUTO_INSTALL_DEPS=no\nAUTO_INSTALL_DOCKER=no\n" > a.ans
  NO_COLOR=1 ./install.sh --check-requirements --answers a.ans </dev/null; echo rc=$?; command -v make >/dev/null && echo HAVE-make || echo NO-make
' 2>&1)
check "make is still missing and the installer says so" bash -c "grep -q 'NO-make' <<<\"\$1\" && grep -q 'make is not installed' <<<\"\$1\"" _ "$out"

echo "== over SSH: another machine with no make or git"
SSHD_DIR=$(mktemp -d); chmod 700 "$SSHD_DIR"
ssh-keygen -q -t ed25519 -N '' -f "$SSHD_DIR/id"
docker rm -f deps-sshd >/dev/null 2>&1
docker run -d --name deps-sshd -p 127.0.0.1:2299:22 -v "$SSHD_DIR/id.pub":/id.pub:ro ubuntu:24.04 sh -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq openssh-server sudo bash >/dev/null
  mkdir -p /run/sshd
  useradd -m -s /bin/bash nopw && echo "nopw ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/nopw
  useradd -m -s /bin/bash withpw && echo "withpw:secret" | chpasswd && echo "withpw ALL=(ALL) ALL" > /etc/sudoers.d/withpw
  for u in nopw withpw; do mkdir -p /home/$u/.ssh && cp /id.pub /home/$u/.ssh/authorized_keys && chown -R $u /home/$u/.ssh && chmod 700 /home/$u/.ssh && chmod 600 /home/$u/.ssh/authorized_keys; done
  exec /usr/sbin/sshd -D -e' >/dev/null
for _ in $(seq 1 90); do ssh -p 2299 -i "$SSHD_DIR/id" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null nopw@127.0.0.1 true 2>/dev/null && break; sleep 2; done
remote_answers() { # user extra...
  local user=$1; shift
  printf '%s\n' NODES=2 NODE_2_ID=far NODE_2_ADDR=10.9.9.9 NODE_2_SSH_HOST=127.0.0.1 "NODE_2_SSH_USER=$user" NODE_2_SSH_PORT=2299 "SSH_KEY=$SSHD_DIR/id" \
    "SSH_EXTRA_OPTS=-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" SETUP=cluster REMOTE_MODE=ssh AUTO_INSTALL_DOCKER=no "$@" >"$SSHD_DIR/a.ans"
}
remote_has() { ssh -p 2299 -i "$SSHD_DIR/id" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$1@127.0.0.1" "command -v $2" >/dev/null 2>&1; }

remote_answers withpw AUTO_INSTALL_DEPS=yes
out=$(cd "$REPO" && NO_COLOR=1 ./install.sh --check-remote 2 --answers "$SSHD_DIR/a.ans" </dev/null 2>&1)
check "a sudo that needs a password, with no terminal, is refused with the reason" bash -c "grep -q 'sudo needs a password and there is no terminal' <<<\"\$1\"" _ "$out"
check "and nothing was installed" bash -c "! ssh -p 2299 -i '$SSHD_DIR/id' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null withpw@127.0.0.1 'command -v make' >/dev/null 2>&1"

remote_answers nopw AUTO_INSTALL_DEPS=no
out=$(cd "$REPO" && NO_COLOR=1 ./install.sh --check-remote 2 --answers "$SSHD_DIR/a.ans" </dev/null 2>&1)
check "answering no leaves the remote machine alone and lists what is missing" bash -c "grep -q 'make is not installed' <<<\"\$1\" && grep -q 'git is not installed' <<<\"\$1\"" _ "$out"

remote_answers nopw AUTO_INSTALL_DEPS=yes
out=$(cd "$REPO" && NO_COLOR=1 ./install.sh --check-remote 2 --answers "$SSHD_DIR/a.ans" </dev/null 2>&1)
check "passwordless sudo: make and git are installed on the other machine" bash -c "ssh -p 2299 -i '$SSHD_DIR/id' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null nopw@127.0.0.1 'command -v make && command -v git' >/dev/null 2>&1"
check "and it says what it installed" bash -c "grep -q 'installed make git' <<<\"\$1\"" _ "$out"
check "then stops on the missing Docker (the container has none)" bash -c "grep -q 'Docker is not installed' <<<\"\$1\"" _ "$out"
docker rm -f deps-sshd >/dev/null 2>&1; rm -rf "$SSHD_DIR"

echo
echo "installer requirement tests: $pass passed, $failn failed"
[[ $failn -eq 0 ]]
