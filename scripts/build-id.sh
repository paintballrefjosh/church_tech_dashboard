#!/usr/bin/env bash
#
# Prints the id of the source tree: the build id baked into the api, web and monitor
# images (the version a node reports, and Next.js's build and deployment id).
#
# Nodes of a cluster must run the same build. Built from the same commit they get the
# same id; a tree with uncommitted changes gets "<commit>-<hash of the changes>", so
# two such builds match only if the changes are identical. Set BUILD_ID yourself (in
# the environment or .env) to override. Outside a git checkout it prints "dev", which
# switches the Next.js deployment id off.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${BUILD_ID:-}" ]]; then
  echo "$BUILD_ID"
  exit 0
fi
if [[ -f .env ]]; then
  fromenv="$(sed -n 's/^BUILD_ID=//p' .env | tail -n 1 | sed -E 's/[[:space:]]+#.*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
  if [[ -n "$fromenv" ]]; then
    echo "$fromenv"
    exit 0
  fi
fi

if ! command -v git >/dev/null 2>&1 || ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "dev"
  exit 0
fi
sha="$(git rev-parse --short=12 HEAD 2>/dev/null || true)"
if [[ -z "$sha" ]]; then
  echo "dev"
  exit 0
fi
if [[ -z "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "$sha"
else
  # Tracked changes plus the contents of untracked (not ignored) files.
  h="$({ git diff HEAD; git ls-files -o --exclude-standard -z | xargs -0 -r sha1sum; } 2>/dev/null | sha1sum | cut -c1-8)"
  echo "${sha}-${h}"
fi
