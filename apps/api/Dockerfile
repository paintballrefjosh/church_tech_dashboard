# syntax=docker/dockerfile:1.6
# 1.6 enables RUN --mount=type=cache so pnpm's content-addressed store survives
# across builds. Without it, every lockfile change re-downloads + re-extracts
# every dependency from scratch.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
# Keep the pnpm store in a stable path so the build-time cache mount and the
# runner-stage prod install both target it.
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PNPM_STORE_PATH=/root/.local/share/pnpm/store

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
# pnpm patchedDependencies (see package.json) are applied at install time.
COPY patches patches
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Production dependencies from the manifests alone. Nothing here reads the source, so this stage (and the
# 195 MB layer built from it) is rebuilt only when a package.json or the lockfile changes, never for a code
# edit. `pnpm deploy` collapses the workspace + transitive deps into a self-contained directory; @church/shared
# lands in it as a package.json-only stub that the runner stage fills in with the built package.
FROM deps AS proddeps
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm deploy --filter @church/api --prod /app/deploy

# The shared package is built in its own stage so an api-only edit does not recompile it.
FROM deps AS shared-build
COPY packages/shared packages/shared
RUN pnpm --filter @church/shared build

FROM shared-build AS build
COPY apps/api apps/api
RUN pnpm --filter @church/api build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
# Layers run from the one that changes least to the one that changes most, and each holds one kind of thing, so
# a code edit rewrites only dist (a few MB) and a registry pull moves only that.
#   1. production dependencies (package.json + node_modules)
COPY --from=proddeps /app/deploy/package.json /app/package.json
COPY --from=proddeps /app/deploy/node_modules /app/node_modules
#   2. migrations, placed so the migrate script's `path.resolve(__dirname, "../../migrations")` still hits
#      the right directory (straight from the context: they do not depend on any build stage)
COPY apps/api/migrations /app/migrations
#   3. the built @church/shared, over the stub pnpm deploy left in node_modules (the directory name is what
#      pnpm derives from the workspace path; the check below fails the build if that ever stops being true)
COPY --from=shared-build /app/packages/shared/package.json /app/node_modules/.pnpm/@church+shared@file+packages+shared/node_modules/@church/shared/package.json
COPY --from=shared-build /app/packages/shared/dist /app/node_modules/.pnpm/@church+shared@file+packages+shared/node_modules/@church/shared/dist
RUN node -e "require.resolve('@church/shared',{paths:['/app']});require.resolve('@church/shared/db',{paths:['/app']})"
#   4. the api's own code
COPY --from=build /app/apps/api/dist /app/dist
# Declared last, after every RUN: the id changes with every commit, and an ARG invalidates the cache of each RUN
# that follows it. Shown as this node's version on the cluster heartbeat.
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID
# Not root: the app writes nothing under /app, and the one thing that wants a privilege (the IPAM scanner's
# ping) gets it from the NET_RAW capability the compose files add, or from unprivileged ICMP sockets.
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
