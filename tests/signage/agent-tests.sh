#!/usr/bin/env bash
# The signage agent's unit tests (pytest) in a Debian trixie container, the OS the Pis run.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
docker run --rm -v "$here/services/signage-agent:/src:ro" -w /tmp debian:trixie-slim sh -c '
  export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq python3 python3-pytest >/dev/null &&
  cp -r /src /tmp/agent && cd /tmp/agent && python3 -m pytest -q -p no:cacheprovider tests'
