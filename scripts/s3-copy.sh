#!/usr/bin/env bash
#
# Copy the uploaded files from one S3-compatible store to another and prove the copy by
# content (SHA-256 of every copied object at both ends). Nothing is ever deleted, and it is
# safe to run repeatedly: only objects that are missing or different at the destination are
# copied, so a second run is the quick final pass.
#
# The usual jobs:
#
#   # Move an install off the old bundled MinIO onto the bundled Garage:
#   scripts/s3-copy.sh --from-minio --to-bundled
#
#   # Move onto an external store (or out of it):
#   scripts/s3-copy.sh --to-endpoint https://s3.example.org \
#       --to-access-key AKIA... --to-secret-key ... [--to-bucket church-files] [--to-region R]
#
# With neither --from-minio nor --from-endpoint, the source is the store this stack uses now
# (the bundled Garage, or your external store: what `scripts/compose.sh --s3-env` reports).
#
# Moving an install, with the stack running:
#   1. scripts/s3-copy.sh ...                 (the bulk of it; users can keep uploading)
#   2. scripts/compose.sh stop api web        (no more uploads)
#   3. scripts/s3-copy.sh ...                 (the last few files; it also verifies)
#   4. start the app on the new store (scripts/compose.sh up -d)
#
# Options:
#   --prod                   use the prod stack's network and settings
#   --from-minio             source: the old bundled MinIO (a container named `minio` on the
#                            stack's network, keys MINIO_ROOT_USER/MINIO_ROOT_PASSWORD in .env)
#   --from-endpoint URL --from-access-key K --from-secret-key S [--from-bucket B] [--from-region R]
#   --to-bundled             destination: the bundled Garage (keys derived from AUTH_SECRET)
#   --to-endpoint URL --to-access-key K --to-secret-key S [--to-bucket B] [--to-region R]
#                            (regions default to us-east-1; a Garage store needs `garage`)
#   --dry-run                show what would be copied
set -euo pipefail
cd "$(dirname "$0")/.."

PROD=()
FROM_MINIO=""; TO_BUNDLED=""
FROM_ENDPOINT=""; FROM_AK=""; FROM_SK=""; FROM_BUCKET=""; FROM_REGION=""
TO_ENDPOINT=""; TO_AK=""; TO_SK=""; TO_BUCKET=""; TO_REGION=""
DRY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prod) PROD=(--prod); shift ;;
    --from-minio) FROM_MINIO=1; shift ;;
    --to-bundled) TO_BUNDLED=1; shift ;;
    --from-endpoint) FROM_ENDPOINT="${2:?}"; shift 2 ;;
    --from-access-key) FROM_AK="${2:?}"; shift 2 ;;
    --from-secret-key) FROM_SK="${2:?}"; shift 2 ;;
    --from-bucket) FROM_BUCKET="${2:?}"; shift 2 ;;
    --from-region) FROM_REGION="${2:?}"; shift 2 ;;
    --to-endpoint) TO_ENDPOINT="${2:?}"; shift 2 ;;
    --to-access-key) TO_AK="${2:?}"; shift 2 ;;
    --to-secret-key) TO_SK="${2:?}"; shift 2 ;;
    --to-bucket) TO_BUCKET="${2:?}"; shift 2 ;;
    --to-region) TO_REGION="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
die() { echo "s3-copy: $*" >&2; exit 1; }

env_get() {
  [[ -f .env ]] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | sed -E 's/[[:space:]]+#.*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}
# What the stack uses now, as KEY=value lines (see scripts/compose.sh --s3-env).
stack_env() { bash scripts/compose.sh "${PROD[@]}" --s3-env; }
stack_get() { stack_env | sed -n "s/^$1=//p"; }

NET="church_internal"; IMG_DEFAULT="church-api"
if [[ ${#PROD[@]} -gt 0 ]]; then NET="church-prod_internal"; IMG_DEFAULT="church-prod-api"; fi

# ---- source ----
if [[ -n "$FROM_MINIO" ]]; then
  [[ -z "$FROM_ENDPOINT" ]] || die "use --from-minio or --from-endpoint, not both"
  FROM_ENDPOINT="http://minio:9000"
  FROM_AK="${FROM_AK:-$(env_get MINIO_ROOT_USER)}"; FROM_SK="${FROM_SK:-$(env_get MINIO_ROOT_PASSWORD)}"
  FROM_BUCKET="${FROM_BUCKET:-$(env_get MINIO_BUCKET)}"; FROM_REGION="${FROM_REGION:-$(env_get MINIO_REGION)}"
  [[ -n "$FROM_AK" && -n "$FROM_SK" ]] || die "--from-minio needs MINIO_ROOT_USER and MINIO_ROOT_PASSWORD in .env"
elif [[ -z "$FROM_ENDPOINT" ]]; then
  FROM_ENDPOINT="$(stack_get S3_ENDPOINT)"
  FROM_AK="$(stack_get S3_ACCESS_KEY)"; FROM_SK="$(stack_get S3_SECRET_KEY)"
  FROM_REGION="${FROM_REGION:-$(stack_get S3_REGION)}"; FROM_BUCKET="${FROM_BUCKET:-$(stack_get S3_BUCKET)}"
fi
[[ -n "$FROM_AK" && -n "$FROM_SK" ]] || die "no source credentials (pass --from-access-key / --from-secret-key)"
FROM_BUCKET="${FROM_BUCKET:-church-files}"

# ---- destination ----
if [[ -n "$TO_BUNDLED" ]]; then
  [[ -z "$TO_ENDPOINT" ]] || die "use --to-bundled or --to-endpoint, not both"
  [[ "$(stack_get S3_MODE)" == bundled ]] || die "--to-bundled needs S3_MODE=bundled (it is $(stack_get S3_MODE))"
  TO_ENDPOINT="$(stack_get S3_ENDPOINT)"; TO_AK="$(stack_get S3_ACCESS_KEY)"; TO_SK="$(stack_get S3_SECRET_KEY)"
  TO_REGION="$(stack_get S3_REGION)"; TO_BUCKET="${TO_BUCKET:-$(stack_get S3_BUCKET)}"
  [[ -n "$TO_AK" && -n "$TO_SK" ]] || die "the bundled store's keys could not be derived (is AUTH_SECRET set in .env?)"
fi
[[ -n "$TO_ENDPOINT" && -n "$TO_AK" && -n "$TO_SK" ]] || die "give a destination: --to-bundled, or --to-endpoint with --to-access-key and --to-secret-key (see --help)"
TO_BUCKET="${TO_BUCKET:-$FROM_BUCKET}"

# Both stores may be on the stack's network (the bundled ones are); join it when it exists.
NETARGS=(); docker network inspect "$NET" >/dev/null 2>&1 && NETARGS=(--network "$NET")
if [[ -n "$FROM_MINIO" || -n "$TO_BUNDLED" || "$FROM_ENDPOINT" == garage:* || "$FROM_ENDPOINT" == minio:* ]]; then
  [[ ${#NETARGS[@]} -gt 0 ]] || die "network $NET not found: is the stack running? (use --prod for the prod stack)"
fi

# The copy runs inside the api image: it has the S3 client and the app's own settings parser,
# so keys with / + = in them need no escaping and the endpoint forms are the app's.
IMG="${API_IMAGE:-$(env_get API_IMAGE)}"; IMG="${IMG:-$IMG_DEFAULT}"
docker image inspect "$IMG" >/dev/null 2>&1 || die "the api image $IMG is not here (build it, or set API_IMAGE)"

exec docker run --rm "${NETARGS[@]}" \
  -v "$PWD/scripts/s3-copy.cjs:/app/s3-copy.cjs:ro" \
  -e "SRC_ENDPOINT=$FROM_ENDPOINT" -e "SRC_ACCESS_KEY=$FROM_AK" -e "SRC_SECRET_KEY=$FROM_SK" -e "SRC_BUCKET=$FROM_BUCKET" -e "SRC_REGION=$FROM_REGION" \
  -e "DST_ENDPOINT=$TO_ENDPOINT" -e "DST_ACCESS_KEY=$TO_AK" -e "DST_SECRET_KEY=$TO_SK" -e "DST_BUCKET=$TO_BUCKET" -e "DST_REGION=$TO_REGION" \
  ${DRY:+-e DRY_RUN=1} \
  "$IMG" node /app/s3-copy.cjs
