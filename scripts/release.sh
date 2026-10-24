#!/usr/bin/env bash
#
# Build the api, web and monitor images once, tagged with the build id, so every node of
# a cluster can run exactly the same build instead of each building its own.
#
#   scripts/release.sh                         build here, tagged church-<service>:<build id>
#   scripts/release.sh --prod                  the same, for the prod compose file
#   scripts/release.sh --push registry/church  also push (registry/church-api:<id>, ...)
#   scripts/release.sh --push                  the same, to IMAGE_REGISTRY from .env / the environment
#   scripts/release.sh --save images.tar       also write them to a tar for `docker load`
#
# With IMAGE_REGISTRY=<that prefix> in a node's .env, scripts/upgrade.sh PULLS these images for the target's build id
# instead of building (only the layers the node lacks are transferred) and scripts/upgrade-cluster.sh checks they are
# published first. A push needs a clean tree: the tag is the commit, so a dirty tree would publish a name nobody can
# reproduce (and the nodes could never ask for it).
#
# Without a registry it prints the lines to put in each node's .env. With those set, `scripts/compose.sh up -d`
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
    --push)
      if [[ -n "${2:-}" && "$2" != -* ]]; then PUSH="$2"; shift 2
      else PUSH="${IMAGE_REGISTRY:-$(sed -n 's/^IMAGE_REGISTRY=//p' .env 2>/dev/null | tail -n 1 | sed -E 's/[[:space:]]+#.*$//; s/^"(.*)"$/\1/')}"
        [[ -n "$PUSH" ]] || { echo "release.sh: --push needs a registry prefix (registry.example.org/church) or IMAGE_REGISTRY in .env" >&2; exit 2; }
        shift; fi ;;
    --save) SAVE="${2:?--save needs a file name}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
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

if [[ -n "$PUSH" && "$ID" == *-* ]]; then
  echo "release.sh: refusing to push build $ID: the tree has uncommitted or untracked files, so no node could ask for this id." >&2
  echo "Commit (or stash) first, or build without --push." >&2
  exit 1
fi
PUSH="${PUSH%/}"
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

if [[ -n "$PUSH" ]]; then
  echo
  echo "pushed $ID to $PUSH. With IMAGE_REGISTRY=$PUSH in a node's .env, scripts/upgrade.sh pulls it."
  exit 0
fi
echo
echo "Put these in .env on every node, then run: scripts/compose.sh ${PROD[*]:-} up -d"
echo "BUILD_ID=$ID"
echo "API_IMAGE=$API"
echo "WEB_IMAGE=$WEB"
echo "MONITOR_IMAGE=$MON"
