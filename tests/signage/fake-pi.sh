#!/usr/bin/env bash
# Signage end to end against simulated Pis: builds tests/signage/fake-pi, starts two on the dev stack's network (A: stock
# Pi OS sudo; B: sudo asks for a password that is not the login's), resets the regression user, runs fake-pi.mjs through
# the proxy, then disables the user and removes the containers. Needs the dev stack up with the current code (make rebuild).
# It changes the dev stack's signage key generation (a rotation test); nothing else it makes is left behind.
set -euo pipefail
cd "$(dirname "$0")/../.."
NET="${SIGNAGE_TEST_NET:-church_internal}"
A=church-fake-pi-a
B=church-fake-pi-b
cleanup() {
  docker rm -f "$A" "$B" >/dev/null 2>&1 || true
  make -s disable-test-user >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build -q -t church-fake-pi tests/signage/fake-pi >/dev/null
# The test reads the Pis' state with docker exec, so its node needs the docker client.
printf 'FROM node:22-alpine\nRUN apk add --no-cache docker-cli\n' | docker build -q -t church-fake-pi-runner - >/dev/null
docker rm -f "$A" "$B" >/dev/null 2>&1 || true
# NET_ADMIN: the agent loads a real nftables firewall inside the container.
docker run -d --name "$A" --hostname fake-pi-a --network "$NET" --cap-add NET_ADMIN \
  -e FAKE_PI_PASSWORD=raspberry church-fake-pi >/dev/null
docker run -d --name "$B" --hostname fake-pi-b --network "$NET" --cap-add NET_ADMIN \
  -e FAKE_PI_PASSWORD=raspberry -e FAKE_PI_SUDO=rootpw -e FAKE_PI_ROOT_PASSWORD=sudo-secret-b church-fake-pi >/dev/null
ip_of() { docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$1"; }
PI_A=$(ip_of "$A"); PI_B=$(ip_of "$B")
echo "fake Pis: A $PI_A, B $PI_B"
make -s reset-test-user >/dev/null
docker run --rm --network=host -v "$PWD":/w -w /w -u "$(id -u):$(id -g)" -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c %g /var/run/docker.sock)" \
  -e HOME=/tmp -e BASE="http://localhost:${EXTERNAL_PORT:-8100}" -e PI_A="$PI_A" -e PI_B="$PI_B" -e PI_A_NAME="$A" -e PI_B_NAME="$B" \
  church-fake-pi-runner node tests/signage/fake-pi.mjs
