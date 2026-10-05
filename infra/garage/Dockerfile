# The Garage image is a single static binary with no shell, so the entrypoint and init
# scripts could not run in it. This adds the binary to a minimal image that has one.
# The config and scripts are bind-mounted (see the compose files), not baked in, so
# changing them needs no rebuild.
FROM dxflrs/garage:v2.1.0 AS garage
FROM alpine:3.20
COPY --from=garage /garage /usr/local/bin/garage
