# No `# syntax=docker/dockerfile:1` frontend pin: that directive makes BuildKit fetch the frontend
# image from Docker Hub, which breaks restricted-network builds. This project must build in
# Docker-Hub-unreachable environments (base images come via NODE_IMAGE/mirror, npm+apt via HTTP_PROXY);
# the xcaddy Go build lives in Dockerfile.base (soms-base). The builtin frontend shipped with BuildKit
# 0.13+ covers every feature used below (--mount=type=cache, multi-stage, COPY --chown, EXPOSE .../udp).

# Single published image: builds web + admin-web + server, then assembles them onto soms-base (node +
# caddy). The server is API-only (Fastify); Caddy (from soms-base) is the TLS edge AND serves the built
# frontends (web at /, admin at /admin/) + reverse-proxies /api/* and /uploads/* to the app. See
# docker/init.sh (Caddyfile generation) + src/bootstrap.ts + Dockerfile.base (soms-base).

# Base for the compile stages. Override via NODE_IMAGE if Docker Hub is unreachable:
#   NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim ./scripts/build-image.sh
ARG NODE_IMAGE=node:24-bookworm-slim
ARG SOMS_BASE=soms-base:latest

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

# ---- Stage 4: app image = soms-base (node + caddy) + the compiled app + the all-in-one supervisor ----
# caddy comes from soms-base (Dockerfile.base), so building this image NEVER re-runs xcaddy — only the
# web/admin/server stages above re-run when their source changes. Build soms-base first:
#   docker build -t soms-base:latest -f Dockerfile.base .   (scripts/build-image.sh does this for you)
FROM ${SOMS_BASE} AS runtime
# App version, injected at build time (scripts/build-image.sh reads package.json). Surfaces in
# `docker image inspect`, /api/v1/health (reads package.json), and /.well-known/soms. Default "dev".
ARG APP_VERSION=dev
LABEL org.opencontainers.image.version="${APP_VERSION}"
WORKDIR /app
ENV NODE_ENV=production APP_VERSION=${APP_VERSION}
# Secrets (DATABASE_URL, JWT_*, etc.) are injected at run time via the init service, never baked in.
# --chown=node:node so the non-root runtime user owns every file (node:*-slim ships uid-1000 `node`).
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=server-build /build/node_modules ./node_modules
COPY --chown=node:node --from=server-build /build/dist ./dist
# Prisma schema + migrations + config: the compose `migrate` service runs `prisma migrate deploy`
# from this same image. The `prisma` CLI is a real dependency now.
COPY --chown=node:node --from=server-build /build/prisma ./prisma
COPY --chown=node:node --from=server-build /build/prisma.config.ts ./prisma.config.ts
# Angular's application builder emits client files under dist/web/browser/ (SSR-ready layout); copy its
# contents flat into public/web so index.html sits at public/web/index.html for Caddy file_server.
COPY --chown=node:node --from=web-build /build/web/dist/web/browser ./public/web
COPY --chown=node:node --from=admin-build /build/admin-web/dist ./public/admin
# Persistent state dir, mounted as a bind by compose. Pre-created + chowned to `node`.
RUN mkdir -p data && chown -R node:node data
# Image ENTRYPOINT (env-loader) + the node+caddy supervisor + the custom init program.
COPY --chown=node:node docker/entrypoint.sh docker/supervisor.sh docker/init.sh /app/
RUN chmod +x /app/entrypoint.sh /app/supervisor.sh /app/init.sh \
    && mkdir -p /app/data/caddy && chown -R node:node /app/data/caddy \
    # Build-time Caddyfile gate: generate a sample via init.sh (the SAME code path that runs at runtime)
    # and `caddy adapt` it (caddy is in soms-base). Single source of truth — no separate baked Caddyfile.
    # The token only needs to be NON-EMPTY to satisfy the `dns cloudflare` parse (adapt does not run
    # Provision(), unlike `caddy validate`); a real one is supplied at runtime.
    && mkdir -p /tmp/gate && printf 'SOMS_DOMAIN=validate.local\nCLOUDFLARE_API_TOKEN=dummy\n' > /tmp/gate/soms.conf \
    && SOMS_CONFIG=/tmp/gate/soms.conf SOMS_RUN_DIR=/tmp/gate/run APPDATA_DIR=/tmp/gate/data PGDATA_DIR=/tmp/gate/pg \
       /app/init.sh >/dev/null \
    && caddy adapt --config /tmp/gate/run/Caddyfile --adapter caddyfile >/dev/null
USER node
# Public liveness probe via Node's global fetch (no curl/wget install). /api/v1/health is
# unauthenticated (src/controller/health.controller.ts) — fit for an orchestrator probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/api/v1/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
# Only 7667 is published (Caddy edge: HTTPS web UI + API + SSE + federation S2S; +udp for HTTP/3).
EXPOSE 7667/tcp
EXPOSE 7667/udp
# ENTRYPOINT sources the init-generated /soms/run/app.env, then execs the command — so the `migrate`
# one-shot (`prisma migrate deploy`) and any `docker compose run app …` escape hatch still receive
# DATABASE_URL/SOMS_DOMAIN. Default CMD is the node+Caddy supervisor; override CMD to run something else.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["/app/supervisor.sh"]
