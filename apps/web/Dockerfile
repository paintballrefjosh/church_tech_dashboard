# syntax=docker/dockerfile:1.6
# 1.6 enables RUN --mount=type=cache so pnpm's content-addressed store survives
# across builds. Without it, every lockfile change re-downloads + re-extracts
# every dependency from scratch.

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PNPM_STORE_PATH=/root/.local/share/pnpm/store

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
# Which build this is: the Next.js build id and deployment id (see next.config.mjs),
# shown as the node's version. Every node of a cluster must run the same build.
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID
# Dummy env vars so `next build` can collect page data without trying to connect
# to a real DB or read a real secret. Both are overridden at runtime by env_file.
ENV COCKROACH_URL=postgresql://build@127.0.0.1:5432/build?sslmode=disable
ENV AUTH_SECRET=build-time-placeholder-replaced-at-runtime
ENV AUTH_TRUST_HOST=true
COPY --from=deps /app /app
COPY packages/shared packages/shared
COPY apps/web apps/web
# Server Action ids are hashed with the build's encryption key, and Next generates a
# random key for every build, so two builds of the same source gave two incompatible
# sets of ids (a sign-in form rendered by one node was rejected by another). Building
# with a fixed key makes the ids identical in every build, on every node. It is only a
# salt for the ids and is public (it is in this file); the key that actually encrypts
# values at run time is a secret derived from AUTH_SECRET by entrypoint.sh.
RUN export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update("church-dashboard/server-actions/build-salt/v1").digest("base64"))')" \
 && pnpm --filter @church/shared build && pnpm --filter @church/web build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID
# Next standalone bundles only the files needed to run.
COPY --from=build /app/apps/web/.next/standalone /app
COPY --from=build /app/apps/web/.next/static /app/apps/web/.next/static
COPY --from=build /app/apps/web/public /app/apps/web/public
COPY apps/web/entrypoint.sh /app/apps/web/entrypoint.sh
WORKDIR /app/apps/web
EXPOSE 3000
ENTRYPOINT ["sh", "/app/apps/web/entrypoint.sh"]
CMD ["node", "server.js"]
