# No `# syntax=docker/dockerfile:1` frontend pin: that directive makes BuildKit fetch the frontend
# image from Docker Hub, which breaks restricted-network builds. This project must build in
# Docker-Hub-unreachable environments (base images come via NODE_IMAGE/DaoCloud, npm+apt via HTTP_PROXY,
# Go modules via GOPROXY) and the host docker daemon is deliberately NOT given a registry mirror
# (restarting it would stop other workloads). The builtin frontend shipped with BuildKit 0.13+ covers
# every feature used below (--mount=type=cache, multi-stage, COPY --chown, --target, EXPOSE .../udp).

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
RUN mkdir -p data && chown -R node:node data
# Run as non-root.
USER node
# Public liveness probe via Node's global fetch (no curl/wget install). /api/v1/health is
# unauthenticated (src/controller/health.controller.ts) — fit for an orchestrator probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/api/v1/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
EXPOSE 3000
CMD ["node", "dist/src/main.js"]

# ---- Stage 5: caddy-build (consumed only by `full`; skipped on `--target runtime`) ----
# xcaddy compiles a Caddy binary with the buildable DNS-01 providers baked in, so an operator can sign
# certs via their OWN DNS provider with ZERO rebuild — edit the Caddyfile's `dns <provider>` line (and
# set that provider's credential env) and bind-mount it (see docker-compose.yml). DNS-01 needs no ports
# 80/443; the only published port stays 7667. This folds the former standalone Dockerfile.caddy in.
#
# The list is the non-archived caddy-dns modules MINUS those that can't build today. Excluded:
#   - archived: google-domains, lego-deprecated
#   - not a provider: template
#   - no resolvable version (0 git tags → 404 @latest on both goproxy.cn and proxy.golang.org, so xcaddy's
#     `go get` dies "no matching versions"): autodns, nicrudns, totaluptime
#   - stuck on the pre-1.0 libdns API: libdns v1.0 renamed the Record fields, and these never migrated,
#     so they fail to compile against the libdns v1.x that Caddy + the migrated providers require (old and
#     new API can't coexist in one binary): civo, ddnss, dinahosting, dnsexit, dnsmadeeasy, dnspod,
#     dreamhost, exoscale, hexonet, hosttech, katapult, leaseweb, namedotcom, openstack-designate, vercel.
#     Notably dnspod (Tencent DNSPod, unmaintained at v0.0.3) — Tencent users use `tencentcloud`/`edgeone`.
# Re-add a line if a provider publishes a release / migrates to libdns v1. That leaves 76 buildable
# providers today (Cloudflare + all China providers except dnspod + the other major ones).
# Pinned to the 2.11 minor line; pin both tags to a patch for exact reproducibility.
FROM caddy:2.11-builder AS caddy-build
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
# Go verifies every module against the checksum DB (GOSUMDB), default sum.golang.org. When GOPROXY is
# goproxy.cn, sumdb lookups route through goproxy.cn's /sumdb/ proxy — which intermittently 504s under
# the load of 76 providers' worth of transitive deps, failing the build mid-way on a single timeout.
# Point GOSUMDB at Google's dedicated mirror instead: identical data, globally reachable, no flaky
# intermediary. This is goproxy.cn's own recommended pairing. Overridable via --build-arg GOSUMDB=... .
ARG GOSUMDB=sum.golang.google.cn
ENV GOSUMDB=${GOSUMDB}
RUN xcaddy build \
    --with github.com/caddy-dns/acmedns \
    --with github.com/caddy-dns/acmeproxy \
    --with github.com/caddy-dns/alidns \
    --with github.com/caddy-dns/all-inkl \
    --with github.com/caddy-dns/arvancloud \
    --with github.com/caddy-dns/azure \
    --with github.com/caddy-dns/bluecat \
    --with github.com/caddy-dns/bunny \
    --with github.com/caddy-dns/cloudflare \
    --with github.com/caddy-dns/cloudns \
    --with github.com/caddy-dns/conoha \
    --with github.com/caddy-dns/desec \
    --with github.com/caddy-dns/digitalocean \
    --with github.com/caddy-dns/directadmin \
    --with github.com/caddy-dns/dnsimple \
    --with github.com/caddy-dns/dode \
    --with github.com/caddy-dns/domainnameshop \
    --with github.com/caddy-dns/duckdns \
    --with github.com/caddy-dns/dynu \
    --with github.com/caddy-dns/dynv6 \
    --with github.com/caddy-dns/easydns \
    --with github.com/caddy-dns/edgeone \
    --with github.com/caddy-dns/gandi \
    --with github.com/caddy-dns/gcore \
    --with github.com/caddy-dns/glesys \
    --with github.com/caddy-dns/godaddy \
    --with github.com/caddy-dns/googleclouddns \
    --with github.com/caddy-dns/he \
    --with github.com/caddy-dns/hetzner \
    --with github.com/caddy-dns/httpnet \
    --with github.com/caddy-dns/huaweicloud \
    --with github.com/caddy-dns/infomaniak \
    --with github.com/caddy-dns/inwx \
    --with github.com/caddy-dns/ionos \
    --with github.com/caddy-dns/linode \
    --with github.com/caddy-dns/loopia \
    --with github.com/caddy-dns/luadns \
    --with github.com/caddy-dns/mailinabox \
    --with github.com/caddy-dns/metaname \
    --with github.com/caddy-dns/mijnhost \
    --with github.com/caddy-dns/mythicbeasts \
    --with github.com/caddy-dns/namecheap \
    --with github.com/caddy-dns/namesilo \
    --with github.com/caddy-dns/nanelo \
    --with github.com/caddy-dns/neoserv \
    --with github.com/caddy-dns/netcup \
    --with github.com/caddy-dns/netlify \
    --with github.com/caddy-dns/netnod \
    --with github.com/caddy-dns/nfsn \
    --with github.com/caddy-dns/njalla \
    --with github.com/caddy-dns/oraclecloud \
    --with github.com/caddy-dns/ovh \
    --with github.com/caddy-dns/parspack \
    --with github.com/caddy-dns/porkbun \
    --with github.com/caddy-dns/powerdns \
    --with github.com/caddy-dns/pph \
    --with github.com/caddy-dns/regery \
    --with github.com/caddy-dns/regfish \
    --with github.com/caddy-dns/rfc2136 \
    --with github.com/caddy-dns/route53 \
    --with github.com/caddy-dns/scaleway \
    --with github.com/caddy-dns/selectel \
    --with github.com/caddy-dns/servercow \
    --with github.com/caddy-dns/simplydotcom \
    --with github.com/caddy-dns/spaceship \
    --with github.com/caddy-dns/tecnocratica \
    --with github.com/caddy-dns/tencentcloud \
    --with github.com/caddy-dns/thelittlehost \
    --with github.com/caddy-dns/timeweb \
    --with github.com/caddy-dns/transip \
    --with github.com/caddy-dns/unifi \
    --with github.com/caddy-dns/volcengine \
    --with github.com/caddy-dns/vultr \
    --with github.com/caddy-dns/websupport \
    --with github.com/caddy-dns/wedos \
    --with github.com/caddy-dns/westcn

# ---- Stage 6: full (all-in-one: the runtime app + the Caddy TLS edge in ONE container) ----
# Default build target — `docker build .` yields this; the slim app-only image is `--target runtime`.
# `FROM runtime` inherits USER node, so re-root to root ONLY to place system files (the caddy binary in
# /usr/bin, the Caddyfile in /etc/caddy) and to create/chown the Caddy state dir, then drop back to the
# unprivileged node user. Caddy binds 7667 fine as uid 1000 (it is >1024). The statically-compiled caddy
# binary (CGO disabled) copied from the debian builder runs cleanly on this debian runtime.
FROM runtime AS full
USER root
COPY --from=caddy-build /usr/bin/caddy /usr/bin/caddy
RUN mkdir -p /etc/caddy && chown node:node /etc/caddy
COPY --chown=node:node Caddyfile /etc/caddy/Caddyfile
COPY --chown=node:node docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /usr/bin/caddy /app/entrypoint.sh \
    && mkdir -p /app/data/caddy && chown -R node:node /app/data/caddy \
    # Build-time Caddyfile gate: `caddy adapt` parses the Caddyfile and translates it to JSON config,
    # catching syntax/structural errors here, not at first run. It does NOT run the modules' Provision()
    # (unlike `caddy validate`, which rejects a dummy Cloudflare token by format), so the token only needs
    # to be NON-EMPTY to satisfy the `dns cloudflare` parse — a real one is supplied at run.
    && SOMS_DOMAIN=validate.local CLOUDFLARE_API_TOKEN=dummy \
       caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
USER node
# 3000 is inherited from `runtime` (the loopback origin Caddy proxies to); leaving it is harmless — only
# compose `ports:` actually publishes, and the full image publishes just 7667 (tcp for h2/h1.1, udp for h3).
EXPOSE 7667/tcp
EXPOSE 7667/udp
# CMD, NOT ENTRYPOINT: compose's `migrate` one-shot service (and any `docker compose run app ...` escape
# hatch, e.g. `node prisma/seed-admin.cjs`) override CMD with their own command. An ENTRYPOINT would turn
# those into args to this script and boot caddy+node instead of prisma/node. See docker/entrypoint.sh.
CMD ["/app/entrypoint.sh"]
