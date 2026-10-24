# syntax=docker/dockerfile:1.6
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PNPM_STORE_PATH=/root/.local/share/pnpm/store

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY services/monitor/package.json services/monitor/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# The shared package is built in its own stage so a monitor-only edit does not recompile it.
FROM deps AS shared-build
COPY packages/shared packages/shared
RUN pnpm --filter @church/shared build

FROM shared-build AS build
COPY services/monitor services/monitor
RUN pnpm --filter @church/monitor build

FROM base AS runner
ENV NODE_ENV=production
# Production dependencies first, from the manifests alone: this layer is rebuilt only when a package.json or the
# lockfile changes, never for a code edit (it used to be installed again after every build).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY services/monitor/package.json services/monitor/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter @church/monitor --filter @church/shared
COPY --from=shared-build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/monitor/dist services/monitor/dist
# Declared last, after every RUN: the id changes with every commit, and an ARG invalidates the cache of each RUN
# that follows it.
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID
WORKDIR /app/services/monitor
# Alpine's busybox provides a `ping` capable of unprivileged ICMP via SOCK_DGRAM, which is what our probe
# spawns. No extra package needed; if DNS reaches alpinelinux.org, `apk add iputils` would give a
# feature-rich replacement but it's optional.
# Not root: the probes use unprivileged sockets (see the ping note above).
USER node
CMD ["node", "dist/main.js"]
