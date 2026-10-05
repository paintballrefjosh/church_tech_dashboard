# syntax=docker/dockerfile:1.6
# 1.6 enables RUN --mount=type=cache so pnpm's content-addressed store survives
# across builds. Without it, every lockfile change re-downloads + re-extracts
# every dependency from scratch.

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app
# Keep the pnpm store in a stable path so the build-time cache mount and the
# runner-stage prod install both target it.
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PNPM_STORE_PATH=/root/.local/share/pnpm/store

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app /app
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @church/shared build && pnpm --filter @church/api build
# Materialise a production-only node_modules tree at /app/deploy via pnpm's
# deploy command. This collapses the workspace + transitive deps into a
# self-contained directory the runner stage can just COPY. Saves ~5-15 s
# vs. re-running `pnpm install --prod` in the runner stage, and keeps the
# final image leaner because dev/test deps never reach it.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm deploy --filter @church/api --prod /app/deploy

FROM base AS runner
ENV NODE_ENV=production
# Shown as this node's version on the cluster heartbeat.
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID
WORKDIR /app
# pnpm deploy flattens the @church/api package into /app: package.json sits
# at /app/package.json, node_modules at /app/node_modules. Workspace deps
# (e.g. @church/shared) are copied in under node_modules.
COPY --from=build /app/deploy /app
# Built dist + migrations are gitignored so the deploy bundle didn't carry
# them. Place them at /app/dist + /app/migrations so the migrate script's
# `path.resolve(__dirname, "../../migrations")` still hits the right dir.
COPY --from=build /app/apps/api/dist /app/dist
COPY --from=build /app/apps/api/migrations /app/migrations
EXPOSE 3001
CMD ["node", "dist/main.js"]
