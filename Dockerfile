# syntax=docker/dockerfile:1

# Single image: builds web + admin-web + server, then runs the server, which also serves the
# frontends same-origin via @nestjs/serve-static (web at /, admin at /admin/).

# Base images. Override via --build-arg if Docker Hub is unreachable, e.g. behind a CN mirror:
#   --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim \
#   --build-arg NODE_IMAGE_FULL=docker.m.daocloud.io/library/node:22-bookworm
# Node 24 slim. The project is ESM-native now, so the former 24.16 pin (a workaround for a
# CJS/Prisma module-detection regression) is no longer needed — track the latest 24.x.
ARG NODE_IMAGE=node:24-bookworm-slim

# ---- Stage 1: build web (Angular) ----
FROM ${NODE_IMAGE} AS web-build
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
WORKDIR /build
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

# ---- Stage 2: build admin-web (Vite) ----
FROM ${NODE_IMAGE} AS admin-build
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
WORKDIR /build
COPY admin-web/package.json admin-web/package-lock.json ./admin-web/
RUN cd admin-web && npm ci
COPY admin-web ./admin-web
RUN cd admin-web && npm run build

# ---- Stage 3: build server (argon2 native-compiles via node-gyp, needing python/make/g++; slim lacks them) ----
FROM ${NODE_IMAGE} AS server-build
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
# Use the Tsinghua Debian mirror so apt-get is fast inside CN without any proxy.
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# `npm ci` triggers the postinstall `prisma generate`, so schema + config + tsconfig must precede it.
# tsconfig is still consulted at generate time (prisma reads `module` to shape its output); with the
# project now ESM-native this is the natural state, not a CJS workaround.
COPY package.json package-lock.json prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
RUN npm ci
COPY src ./src
RUN npm run build
# Drop devDependencies; keep prod deps with the compiled argon2 .node + prebuilt sharp binaries.
RUN npm prune --omit=dev

# ---- Stage 4: runtime ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Secrets (DATABASE_URL, JWT_*, etc.) are injected at run time via env / --env-file, never baked in.
COPY package.json ./
COPY --from=server-build /build/node_modules ./node_modules
COPY --from=server-build /build/dist ./dist
# Angular's application builder emits client files under dist/web/browser/ (SSR-ready layout); copy its
# contents flat into public/web so index.html sits at public/web/index.html for serve-static.
COPY --from=web-build /build/web/dist/web/browser ./public/web
COPY --from=admin-build /build/admin-web/dist ./public/admin
RUN mkdir -p uploads
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
