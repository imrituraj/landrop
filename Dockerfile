# syntax=docker/dockerfile:1.7
# LanDrop: one image serving the web app, signaling WebSocket, and health checks.
# The server runs TypeScript directly via Node's built-in type stripping (Node >= 22.18 / 24).

ARG NODE_IMAGE=node:24.15.0-alpine3.22

# --- build: install all deps, build the static web app -----------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY packages/transfer-core/package.json packages/transfer-core/
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
RUN pnpm --filter @landrop/web build

# --- runtime: production deps for the server only, non-root -----------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
# Workspace packages are linked (symlinks), so Node sees their real paths outside
# node_modules and can strip their TypeScript types.
RUN pnpm install --prod --frozen-lockfile --filter "@landrop/server..." && pnpm store prune
COPY apps/server/src apps/server/src
COPY packages/protocol/src packages/protocol/src
COPY packages/shared/src packages/shared/src
COPY --from=build /app/apps/web/dist /app/web

ENV HOST=0.0.0.0 \
    PORT=8787 \
    STATIC_DIR=/app/web
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/readyz || exit 1
CMD ["node", "apps/server/src/main.ts"]
