#!/bin/sh
# One-shot setup of the bundled Garage, safe to run on every start.
#
# Single node: give the node a role in the cluster layout (a Garage node does nothing until it
# has one), then import the access key (derived by scripts/compose.sh; Garage only accepts its
# own key format, GK + 24 hex characters, so the key cannot be chosen freely), create the bucket
# and allow the key to use it.
#
# Cluster (GARAGE_CLUSTER=1): the layout of several nodes is formed once, from one of them, by
# `scripts/cluster.sh garage-bootstrap`; this does not touch it. If the cluster has no layout yet
# it says so and stops, otherwise it does the key and bucket steps (they replicate).
# Environment: S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET GARAGE_RPC_SECRET [GARAGE_CLUSTER].
set -eu
. /usr/local/bin/garage-render.sh
G="garage -c /tmp/garage.toml"
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is not set}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is not set}"
BUCKET="${S3_BUCKET:-church-files}"

echo "garage-init: waiting for Garage ..."
i=0
until $G status >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "garage-init: Garage did not come up" >&2; exit 1; }
  sleep 1
done

# Run a Garage command and keep its output quiet (it can contain the key's secret), unless it
# fails: then say which command and show its output with anything secret-looking hidden.
quiet() {
  if ! out="$("$@" 2>&1)"; then
    echo "garage-init: failed: $*" >&2
    echo "$out" | sed 's/[0-9a-fA-F]\{40,\}/<hidden>/g' >&2
    return 1
  fi
}

layout_version() {
  $G layout show 2>/dev/null | sed -n 's/.*Current cluster layout version: *\([0-9][0-9]*\).*/\1/p'
}

if [ "${GARAGE_CLUSTER:-}" = "1" ]; then
  if [ "$(layout_version || true)" = "" ] || [ "$(layout_version)" = "0" ]; then
    echo "garage-init: this cluster has no layout yet. Form it once, from one node, with:"
    echo "garage-init:   scripts/cluster.sh garage-bootstrap --peer <host> ..."
    echo "garage-init: (the bucket and key are set up then, and on every later start)"
    exit 0
  fi
elif $G status 2>/dev/null | grep -q "NO ROLE ASSIGNED"; then
  node="$($G node id -q 2>/dev/null | cut -d@ -f1 | cut -c1-16)"
  echo "garage-init: assigning this node to the layout ($node)"
  quiet $G layout assign -z dc1 -c 100G "$node"
  quiet $G layout apply --version "$(( $(layout_version || echo 0) + 1 ))"
fi

if ! $G key info "$S3_ACCESS_KEY" >/dev/null 2>&1; then
  echo "garage-init: importing the access key"
  quiet $G key import --yes -n church "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
fi
if ! $G bucket info "$BUCKET" >/dev/null 2>&1; then
  echo "garage-init: creating bucket $BUCKET"
  quiet $G bucket create "$BUCKET"
fi
quiet $G bucket allow --read --write --owner "$BUCKET" --key "$S3_ACCESS_KEY"
echo "garage-init: ready (bucket $BUCKET)"
