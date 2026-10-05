#!/usr/bin/env bash
#
# Build the api, web and monitor images once, tagged with the build id, so every node of
# a cluster can run exactly the same build instead of each building its own.
#
#   scripts/release.sh                         build here, tagged church-<service>:<build id>
#   scripts/release.sh --prod                  the same, for the prod compose file
#   scripts/release.sh --push registry/church  also push (registry/church-api:<id>, ...)
#   scripts/release.sh --save images.tar       also write them to a tar for `docker load`
#
# It prints the lines to put in each node's .env. With those set, `scripts/compose.sh up -d`
# runs the pre-built images (pulling them if they are not local) and does not build.
#
# Why: two builds of the same source are not interchangeable for the web app unless they
# share a build id, so a cluster should run one build everywhere. Building from the same
# clean commit on each node also works (see scripts/build-id.sh), but a pre-built image is
# the only way to be certain.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD=()
PUSH=""
SAVE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prod) PROD=(--prod); shift ;;
    --push) PUSH="${2:?--push needs a registry prefix, e.g. registry.example.org/church}"; shift 2 ;;
    --save) SAVE="${2:?--save needs a file name}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ID="$(scripts/build-id.sh)"
if [[ "$ID" == "dev" ]]; then
  echo "release.sh: no build id (not a git checkout). Set BUILD_ID=<something> and run again." >&2
  exit 1
fi
if [[ "$ID" == *-* ]]; then
  echo "note: the working tree has uncommitted changes, so this build id ($ID) is specific to them." >&2
fi

PREFIX="${PUSH:-church}"
API="${PREFIX}-api:${ID}"
WEB="${PREFIX}-web:${ID}"
MON="${PREFIX}-monitor:${ID}"
# `registry/church` -> registry/church-api:<id>; plain `church` -> church-api:<id>.

echo "building $ID ..."
API_IMAGE="$API" WEB_IMAGE="$WEB" MONITOR_IMAGE="$MON" BUILD_ID="$ID" \
  scripts/compose.sh "${PROD[@]}" build api web monitor

if [[ -n "$PUSH" ]]; then
  for img in "$API" "$WEB" "$MON"; do docker push "$img"; done
fi
if [[ -n "$SAVE" ]]; then
  docker save -o "$SAVE" "$API" "$WEB" "$MON"
  echo "saved to $SAVE (on each node: docker load -i $SAVE)"
fi

echo
echo "Put these in .env on every node, then run: scripts/compose.sh ${PROD[*]:-} up -d"
echo "BUILD_ID=$ID"
echo "API_IMAGE=$API"
echo "WEB_IMAGE=$WEB"
echo "MONITOR_IMAGE=$MON"
