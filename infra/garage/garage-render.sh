#!/bin/sh
# Writes /tmp/garage.toml from the template, for the Garage server and for the CLI (which must
# read the same config to reach the daemon). Sourced by the entrypoint and the init script.
#   GARAGE_RPC_PUBLIC_ADDR      how other nodes reach this one (default garage:3901)
#   GARAGE_REPLICATION_FACTOR   copies of each object (default 1)
set -eu
sed -e "s|@RPC_PUBLIC_ADDR@|${GARAGE_RPC_PUBLIC_ADDR:-garage:3901}|" \
    -e "s|@REPLICATION_FACTOR@|${GARAGE_REPLICATION_FACTOR:-1}|" \
    /etc/garage.toml.tpl > /tmp/garage.toml
