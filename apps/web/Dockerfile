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
# Dummy env vars so `next build` can collect page data without trying to connect
# to a real DB or read a real secret. Both are overridden at runtime by env_file.
ENV COCKROACH_URL=postgresql://build@127.0.0.1:5432/build?sslmode=disable
ENV AUTH_SECRET=build-time-placeholder-replaced-at-runtime
ENV AUTH_TRUST_HOST=true
COPY --from=deps /app /app
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @church/shared build && pnpm --filter @church/web build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Next standalone bundles only the files needed to run.
COPY --from=build /app/apps/web/.next/standalone /app
COPY --from=build /app/apps/web/.next/static /app/apps/web/.next/static
COPY --from=build /app/apps/web/public /app/apps/web/public
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "server.js"]
