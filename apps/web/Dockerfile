# syntax=docker/dockerfile:1.6
# 1.6 enables RUN --mount=type=cache so pnpm's content-addressed store survives
# across builds. Without it, every lockfile change re-downloads + re-extracts
# every dependency from scratch.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PNPM_STORE_PATH=/root/.local/share/pnpm/store

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
# pnpm patchedDependencies (see package.json) are applied at install time.
COPY patches patches
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# The shared package is built in its own stage so a web-only edit does not recompile it.
FROM deps AS shared-build
COPY packages/shared packages/shared
RUN pnpm --filter @church/shared build

FROM shared-build AS build
ENV NEXT_TELEMETRY_DISABLED=1
# Dummy env vars so `next build` can collect page data without trying to connect
# to a real DB or read a real secret. Both are overridden at runtime by env_file.
ENV COCKROACH_URL=postgresql://build@127.0.0.1:5432/build?sslmode=disable
ENV AUTH_SECRET=build-time-placeholder-replaced-at-runtime
ENV AUTH_TRUST_HOST=true
COPY apps/web apps/web
# Declared here, after the COPYs, not at the top of the stage: the id changes with every edit
# (scripts/build-id.sh), and an ARG/ENV invalidates the cache of every instruction below it. Up
# top it made each build copy the whole ~870 MB node_modules tree from the deps stage again.
# Which build this is: the Next.js build id and deployment id (see next.config.mjs),
# shown as the node's version. Every node of a cluster must run the same build.
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID
# Server Action ids are hashed with the build's encryption key, and Next generates a
# random key for every build, so two builds of the same source gave two incompatible
# sets of ids (a sign-in form rendered by one node was rejected by another). Building
# with a fixed key makes the ids identical in every build, on every node. It is only a
# salt for the ids and is public (it is in this file); the key that actually encrypts
# values at run time is a secret derived from AUTH_SECRET by entrypoint.sh.
#
# .next/cache is Next's own build cache (compiled modules, minified chunks): kept between builds so a small edit
# recompiles a small part. It holds only things Next re-derives from the source and checks by content, so the
# output is the same with or without it. `locked` because two builds of the same cache must not write at once.
RUN --mount=type=cache,id=next-build-cache,target=/app/apps/web/.next/cache,sharing=locked \
    export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update("church-dashboard/server-actions/build-salt/v1").digest("base64"))')" \
 && pnpm --filter @church/web build
# Next traces the packages the server needs into standalone/node_modules. They change only when the dependencies
# or the imports do, so they ship as a layer of their own, apart from the server code.
RUN mv apps/web/.next/standalone/node_modules /app/standalone-node_modules

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Layers run from the one that changes least to the one that changes most (see apps/api/Dockerfile).
# Next standalone bundles only the files needed to run.
COPY --from=build /app/standalone-node_modules /app/node_modules
COPY --from=build /app/apps/web/.next/standalone /app
COPY --from=build /app/apps/web/.next/static /app/apps/web/.next/static
COPY --from=build /app/apps/web/public /app/apps/web/public
COPY apps/web/entrypoint.sh /app/apps/web/entrypoint.sh
WORKDIR /app/apps/web
# Not root. Next writes its response cache under .next/cache; everything else stays read-only to the app.
RUN mkdir -p .next/cache && chown -R node:node .next/cache
# Declared last, after every RUN: the id changes with every commit, and an ARG invalidates the cache of each RUN
# that follows it.
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID
USER node
EXPOSE 3000
ENTRYPOINT ["sh", "/app/apps/web/entrypoint.sh"]
CMD ["node", "server.js"]
