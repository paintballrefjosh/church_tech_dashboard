FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY services/monitor/package.json services/monitor/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app /app
COPY packages/shared packages/shared
COPY services/monitor services/monitor
RUN pnpm --filter @church/shared build && pnpm --filter @church/monitor build

FROM base AS runner
ENV NODE_ENV=production
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID
# Alpine's busybox provides a `ping` capable of unprivileged ICMP via
# SOCK_DGRAM, which is what our probe spawns. No extra package needed; if
# DNS reaches alpinelinux.org, `apk add iputils` would give a feature-rich
# replacement but it's optional.
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/services/monitor/package.json services/monitor/
COPY --from=build /app/services/monitor/dist services/monitor/dist
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
RUN pnpm install --prod --frozen-lockfile --filter @church/monitor --filter @church/shared
WORKDIR /app/services/monitor
CMD ["node", "dist/main.js"]
