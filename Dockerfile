# No `# syntax=docker/dockerfile:1` frontend pin: that directive makes BuildKit fetch the frontend
# image from Docker Hub, which breaks restricted-network builds. This project must build in
# Docker-Hub-unreachable environments (base images come via NODE_IMAGE/mirror, npm+apt via HTTP_PROXY);
# the xcaddy Go build lives in Dockerfile.base (soms-base). The builtin frontend shipped with BuildKit
# 0.13+ covers every feature used below (--mount=type=cache, multi-stage, COPY --chown, EXPOSE .../udp).

# Single published image: builds web + admin-web + server, then assembles them onto soms-base (node +
# caddy). The server build uses soms-build-base (Node + native compiler toolchain), which is never
# copied into the published image. The server is API-only (Fastify); Caddy is the TLS edge and serves
# frontends (web at /, admin at /admin/) + reverse-proxies /api/* and /uploads/* to the app. See
# docker/init.sh (Caddyfile generation) + src/bootstrap.ts + Dockerfile.base (soms-base).

# Base for the compile stages. Override via NODE_IMAGE if Docker Hub is unreachable:
#   NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim ./scripts/build-image.sh
ARG NODE_IMAGE=node:24-bookworm-slim
ARG SOMS_BASE=soms-base:latest
ARG SOMS_BUILD_BASE=soms-build-base:latest

# ---- Stage 1: build web (Angular) ----
FROM ${NODE_IMAGE} AS web-build
WORKDIR /build
COPY web/package.json web/package-lock.json ./web/
# BuildKit cache mount shares the npm tarball cache across the web/admin/server stages (cacache is
# content-addressed, so concurrent access from parallel stages is safe) and across rebuilds.
RUN --mount=type=cache,target=/root/.npm \
    cd web && npm ci
COPY web ./web
COPY shared ./shared
RUN cd web && npm run build

# ---- Stage 2: build admin-web (Vite) ----
FROM ${NODE_IMAGE} AS admin-build
WORKDIR /build
COPY admin-web/package.json admin-web/package-lock.json ./admin-web/
RUN --mount=type=cache,target=/root/.npm \
    cd admin-web && npm ci
COPY admin-web ./admin-web
RUN cd admin-web && npm run build

# ---- Stage 3: build server (reusable base supplies python/make/g++ for native Node dependencies) ----
FROM ${SOMS_BUILD_BASE} AS server-build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json tsconfig.build.json nest-cli.json ./
COPY tsconfig.migrations.json ./
COPY scripts/migrate-db.ts ./scripts/migrate-db.ts
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY src ./src
COPY shared ./shared
RUN npm run build
# Package the web SPA as a downloadable, SHA-256-integrity-checked bundle for the Tauri shell
# dynamic-update flow (scripts/package-web-bundle.mjs → shell-bundle/{manifest.json, soms-web-<ver>.tar.gz}).
# web/package.json + the Stage-1 browser build are copied in so the packager can read the version + tar
# the output. No signing key — integrity over the wire is TLS (https) + the bundle SHA-256.
COPY web/package.json ./web/package.json
COPY --from=web-build /build/web/dist/web/browser ./web/dist/web/browser
# scripts/ holds the packager invoked next (package-web-bundle.mjs); copy it in so `npm run
# bundle:package` can tgz the browser build and emit manifest.json under shell-bundle/.
COPY scripts ./scripts
COPY database ./database
RUN npm run bundle:package
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
# ca-certificates: Caddy's HTTPS to the DNS-01 provider + Let's Encrypt.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Secrets and runtime configuration are injected by Compose through env_file, never baked in.
# --chown=node:node so the non-root runtime user owns every file (node:*-slim ships uid-1000 `node`).
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=server-build /build/node_modules ./node_modules
COPY --chown=node:node --from=server-build /build/dist ./dist
# Pure SQL migrations + compiled checksum/lock runner used by the one-shot compose migrate service.
COPY --chown=node:node --from=server-build /build/database ./database
COPY --chown=node:node config ./config
# Angular's application builder emits client files under dist/web/browser/ (SSR-ready layout); copy its
# contents flat into public/web so index.html sits at public/web/index.html for Caddy file_server.
COPY --chown=node:node --from=web-build /build/web/dist/web/browser ./public/web
COPY --chown=node:node --from=admin-build /build/admin-web/dist ./public/admin
# The SHA-256-integrity-checked web bundle + manifest the Tauri shell downloads at init/reconfigure/update
# (soms-web-<ver>.tar.gz + manifest.json, produced by the Stage-3 packaging step). Baked at /app/shell-bundle
# — READ-ONLY and image-bound, deliberately OUTSIDE the bind-mounted /app/data volume so the bundle is
# immutable per image and an operator can never mutate the integrity-checked artifact the shell verifies.
# shell.service reads cwd/shell-bundle (= /app/shell-bundle under WORKDIR); no entrypoint seeding, no volume.
COPY --chown=node:node --from=server-build /build/shell-bundle ./shell-bundle
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
    && SOMS_DOMAIN=validate.local SOMS_TLS_MODE=standard CLOUDFLARE_API_TOKEN=dummy \
       PGPASSWORD=gatepw ADMIN_BOOTSTRAP_PASSWORD=gateadmin DATABASE_POOL_MAX=10 \
       SOMS_RUN_DIR=/tmp/gate/run /app/init.sh >/dev/null \
    && caddy adapt --config /tmp/gate/run/Caddyfile --adapter caddyfile >/dev/null
USER node
# Public liveness probe via Node's global fetch (no curl/wget install). /api/v1/health is
# unauthenticated (src/controller/health.controller.ts) — fit for an orchestrator probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/api/v1/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
# Only 7667 is published (Caddy edge: HTTPS web UI + API + SSE + federation S2S; +udp for HTTP/3).
EXPOSE 7667/tcp
EXPOSE 7667/udp
# ENTRYPOINT renders Caddy's internal configuration for the default supervisor command, then execs it.
# One-shot commands such as migrations receive their environment directly from Compose.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["/app/supervisor.sh"]
