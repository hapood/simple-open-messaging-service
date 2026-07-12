# syntax=docker/dockerfile:1

# Single image: builds web + admin-web + server, then runs the server, which also serves the
# frontends same-origin via @fastify/static in src/bootstrap.ts (web at /, admin at /admin/).

# Base image — used by all four stages (web-build, admin-build, server-build, runtime). Override via
# the NODE_IMAGE env var (consumed by scripts/build-image.sh) if Docker Hub is unreachable:
#   NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim ./scripts/build-image.sh
# Node 24 slim. The project is ESM-native now, so the former 24.16 pin (a workaround for a
# CJS/Prisma module-detection regression) is no longer needed — track the latest 24.x.
ARG NODE_IMAGE=node:24-bookworm-slim

# ---- Stage 1: build web (Angular) ----
FROM ${NODE_IMAGE} AS web-build
WORKDIR /build
COPY web/package.json web/package-lock.json ./web/
# BuildKit cache mount shares the npm tarball cache across the web/admin/server stages (cacache is
# content-addressed, so concurrent access from parallel stages is safe) and across rebuilds.
RUN --mount=type=cache,target=/root/.npm \
    cd web && npm ci
COPY web ./web
RUN cd web && npm run build

# ---- Stage 2: build admin-web (Vite) ----
FROM ${NODE_IMAGE} AS admin-build
WORKDIR /build
COPY admin-web/package.json admin-web/package-lock.json ./admin-web/
RUN --mount=type=cache,target=/root/.npm \
    cd admin-web && npm ci
COPY admin-web ./admin-web
RUN cd admin-web && npm run build

# ---- Stage 3: build server (argon2 native-compiles via node-gyp, needing python/make/g++; slim lacks them) ----
FROM ${NODE_IMAGE} AS server-build
# Official npm + apt registries (no CN mirrors). Reach them through the build-time proxy forwarded
# by scripts/build-image.sh (HTTP_PROXY/HTTPS_PROXY from your shell env, or unset = direct).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# `npm ci` triggers the postinstall `prisma generate`, so schema + config + tsconfig must precede it.
# tsconfig is still consulted at generate time (prisma reads `module` to shape its output); with the
# project now ESM-native this is the natural state, not a CJS workaround.
COPY package.json package-lock.json prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY src ./src
RUN npm run build
# Drop devDependencies; keep prod deps with the compiled argon2 .node + prebuilt sharp binaries.
RUN npm prune --omit=dev

# ---- Stage 4: runtime ----
FROM ${NODE_IMAGE} AS runtime
# App version, injected at build time (scripts/build-image.sh reads package.json). Surfaces in
# `docker image inspect`, /api/v1/health (reads package.json), and /.well-known/soms. Default "dev"
# for local builds without the arg.
ARG APP_VERSION=dev
LABEL org.opencontainers.image.version="${APP_VERSION}"
WORKDIR /app
ENV NODE_ENV=production APP_VERSION=${APP_VERSION}
# Secrets (DATABASE_URL, JWT_*, etc.) are injected at run time via env / --env-file, never baked in.
# --chown=node:node so the non-root runtime user owns every file (node:*-slim ships uid-1000 `node`).
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=server-build /build/node_modules ./node_modules
COPY --chown=node:node --from=server-build /build/dist ./dist
# Prisma schema + migrations + config: the compose `migrate` service runs `prisma migrate deploy`
# from this same image (no separate migrate build). The `prisma` CLI is a real dependency now.
COPY --chown=node:node --from=server-build /build/prisma ./prisma
COPY --chown=node:node --from=server-build /build/prisma.config.ts ./prisma.config.ts
# Angular's application builder emits client files under dist/web/browser/ (SSR-ready layout); copy its
# contents flat into public/web so index.html sits at public/web/index.html for serve-static.
COPY --chown=node:node --from=web-build /build/web/dist/web/browser ./public/web
COPY --chown=node:node --from=admin-build /build/admin-web/dist ./public/admin
# Persistent state dirs, mounted as named volumes by compose. Pre-created + chowned to `node`: on
# first mount Docker copies the image path's ownership into the named volume, so the app can write
# them as non-root without a root+gosu entrypoint dance.
RUN mkdir -p uploads data logs && chown -R node:node uploads data logs
# Run as non-root.
USER node
# Public liveness probe via Node's global fetch (no curl/wget install). /api/v1/health is
# unauthenticated (src/controller/health.controller.ts) — fit for an orchestrator probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/api/v1/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
