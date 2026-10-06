#!/usr/bin/env bash
#
# A machine that accepts only a PASSWORD over ssh (no keys), as a resumed install meets it: the earlier
# run's shared connection is gone, so the installer must reconnect (asking for the password once, on the
# terminal) before it uses ssh in the prompt-free way. Also: with no terminal it must say what to do.
#
#   tests/installer/ssh-password.sh        (needs docker, python3)
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; failn=0
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "  ok    $what"; else failn=$((failn + 1)); echo "  FAIL  $what"; fi; }
W=$(mktemp -d); trap 'docker rm -f pwd-sshd >/dev/null 2>&1; rm -rf "$W"' EXIT

docker rm -f pwd-sshd >/dev/null 2>&1
docker run -d --name pwd-sshd -p 127.0.0.1:2298:22 ubuntu:24.04 sh -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq openssh-server >/dev/null
  mkdir -p /run/sshd && useradd -m -s /bin/bash pwuser && echo "pwuser:secret" | chpasswd
  printf "PasswordAuthentication yes\nPubkeyAuthentication no\nUsePAM no\n" >> /etc/ssh/sshd_config
  exec /usr/sbin/sshd -D -e' >/dev/null
# sshd is ready when it refuses us for want of a password (the published port accepts before sshd is up)
for _ in $(seq 1 90); do
  ssh -p 2298 -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no pwuser@127.0.0.1 true 2>&1 | grep -q 'Permission denied' && break
  sleep 2
done

printf '%s\n' NODES=2 NODE_2_ID=far NODE_2_ADDR=10.9.9.9 NODE_2_SSH_HOST=127.0.0.1 NODE_2_SSH_USER=pwuser NODE_2_SSH_PORT=2298 \
  "SSH_EXTRA_OPTS=-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no -o PreferredAuthentications=password" \
  SETUP=cluster REMOTE_MODE=ssh >"$W/a.ans"

echo "== a password-only machine, in a terminal"
python3 - "$REPO" "$W/a.ans" >"$W/pty.out" 2>&1 <<'PY'
import os, pty, re, select, sys, time
repo, ans = sys.argv[1], sys.argv[2]
os.chdir(repo)
pid, fd = pty.fork()
if pid == 0:
    os.environ["NO_COLOR"] = "1"; os.environ["TERM"] = "xterm"
    os.execv("./install.sh", ["./install.sh", "--ssh-test", "2", "--answers", ans])
buf = ""; prompts = 0; end = time.time() + 90; handled = 0
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try: chunk = os.read(fd, 4096).decode(errors="replace")
        except OSError: break
        if not chunk: break
        buf += chunk
        n = len(re.findall(r"[Pp]assword:", buf))
        if n > handled:
            handled = n; time.sleep(0.3); os.write(fd, b"secret\r")
print("PASSWORD_PROMPTS=%d" % handled)
print("OUTPUT_HAS_RESULT=%s" % ("connected-without-a-prompt" in buf))
print("PASSWORD_ECHOED=%s" % ("secret" in re.sub(r"[Pp]assword:", "", buf)))
PY
check "it asked for the password once" grep -qx 'PASSWORD_PROMPTS=1' "$W/pty.out"
check "the commands after that went through the shared connection" grep -qx 'OUTPUT_HAS_RESULT=True' "$W/pty.out"
check "the password was not echoed" grep -qx 'PASSWORD_ECHOED=False' "$W/pty.out"

echo "== the same machine with no terminal"
(cd "$REPO" && NO_COLOR=1 ./install.sh --ssh-test 2 --answers "$W/a.ans" </dev/null >"$W/nopty.out" 2>&1); rc=$?
check "it fails, and says a machine that needs a password needs a key or a terminal" bash -c "[ $rc -ne 0 ] && grep -q 'without a terminal' '$W/nopty.out'"

echo
echo "installer ssh password tests: $pass passed, $failn failed"
[[ $failn -eq 0 ]]
