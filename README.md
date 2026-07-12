# SOMS · Simple Open Chat Service

A concise instant messaging (IM) service that provides a user system, friend/group threads, real-time message push, and file upload capabilities. The design goal is to be "easy for third-party applications to integrate".

- **Backend**: NestJS 11 + Prisma 7 + PostgreSQL + SSE (Server-Sent Events, downstream push) + Passport (Local + JWT)
- **Frontend**: Angular 18 (Standalone + Signal + experimental Zoneless), in-house Material-style component library

> The application codename is **SOMS** (Simple Open Message Service). The repository contains both the backend service (root directory) and the Angular frontend (`web/`).

---

## Table of Contents

- [Feature Overview](#feature-overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Architecture and Design](#architecture-and-design)
- [API and Real-Time Communication Quick Reference](#api-and-real-time-communication-quick-reference)
- [Development Commands](#development-commands)
- [Deployment (Docker)](#deployment-docker)
- [Project Status](#project-status)
- [More Documentation](#more-documentation)

---

## Feature Overview

| Module | Capabilities |
| --- | --- |
| Account | Registration, login, logout, JWT dual-token (access + refresh) auto-renewal, login-failure IP rate-limiting and banning |
| User | Profile, search by username, batch query |
| Friends | Send/accept friend requests (based on the `UserMessageThread` state machine), pending request list |
| Threads | P2P threads, group threads, unified `MessageThread` abstraction |
| Messages | Plain-text message sending, cursor-based paginated history query, real-time SSE push |
| Groups | Create groups, invite friends to join via JWT invite links |
| Files | Image/video/audio/general file upload (🚧 see [Project Status](#project-status)) |
| Notifications | Notification table and notification box modeled (🚧 module not yet wired up) |

## Tech Stack

**Backend**

| Category | Choice |
| --- | --- |
| Framework | NestJS 11 |
| Database | PostgreSQL (Prisma 7 ORM, Rust-free client + `@prisma/adapter-pg` driver adapter) |
| Real-time | SSE (`GET /api/v1/events`, `text/event-stream`) — a one-way downstream-only push channel |
| Authentication | Passport `local` + `jwt`, `@nestjs/jwt`, `argon2` password hashing |
| Utilities | `dayjs` for time, `jsonwebtoken` for group invite tokens |

**Frontend**

| Category | Choice |
| --- | --- |
| Framework | Angular 18 (Standalone Components, no NgModule) |
| Change Detection | `provideExperimentalZonelessChangeDetection()` (no zone.js) |
| State | Angular Signal + RxJS |
| UI | In-house Material Design-style components (no Angular Material dependency) |
| Real-time | `@microsoft/fetch-event-source` (SSE client, controllable reconnection) |

## Project Structure

```
simple-open-chat-service/
├── src/                      # Backend NestJS service
│   ├── main.ts               # App entry, listens on port 3000, CORS + helmet + global ValidationPipe
│   ├── app.module.ts         # Root module
│   ├── config.ts             # Global configuration (domain)
│   ├── prisma.service.ts     # PrismaClient wrapper
│   ├── auth/                 # Authentication: local/jwt strategies, guards, token management
│   ├── controller/           # HTTP controllers: auth/user/message/group/file
│   ├── message/              # Messages and friend-request state machine
│   ├── user/                 # User queries and registration
│   ├── group/                # Groups and invite tokens
│   ├── gateway/              # SSE downstream push (events.controller + sse.service)
│   ├── notify/               # Notifications (🚧 not yet wired up)
│   ├── user-manage/          # User management (🚧 not yet wired up)
│   └── file/                 # File upload (🚧 not yet wired up)
├── prisma/
│   ├── schema.prisma         # Data model definitions
│   └── migrations/           # Database migrations
├── test/                     # e2e tests
├── web/                      # Angular frontend
│   └── src/app/
│       ├── app.config.ts     # Global providers (zoneless / router / http / interceptors)
│       ├── app.routes.ts     # Routes
│       ├── services/         # HTTP services, SSE service, routing/popup services
│       ├── pages/            # Page components (home / login / register / ...)
│       └── components/       # Business components + in-house Material components
├── config.ts
└── package.json
```

## Quick Start

### Prerequisites

- Node.js ≥ 18 (Node 24 in the development environment)
- An accessible **PostgreSQL** instance

### 1. Prepare the Database Connection

```bash
cp .env.example .env
# Edit .env and fill in your PostgreSQL connection string:
# DATABASE_URL="postgresql://username:password@host:5432/database?schema=public"
```

### 2. Install Dependencies

```bash
# Backend
npm install

# Frontend
npm install --prefix web
```

### 3. Initialize the Database

```bash
# Generate Prisma Client
npx prisma generate

# Apply database migrations (create tables)
npx prisma migrate deploy
# Or during development: npx prisma migrate dev
```

### 4. Start the Services

```bash
# Backend (listens on http://localhost:3000)
npm run start:dev

# Frontend (in another terminal, default http://localhost:4200)
npm start --prefix web
```

The frontend accesses the backend via `//<current-hostname>:3000` by default (see [Configuration](#configuration)).

## Configuration

| Location | Setting | Description |
| --- | --- | --- |
| `.env` → `DATABASE_URL` | PostgreSQL connection string | Read by Prisma, required |
| `.env` → `SOMS_DOMAIN` | Public domain of this service (federation identity) | Required (`@user@<domain>`, host of `/.well-known/soms`) |
| `.env` → `APP_DOMAIN` | Service domain | Recommended reference; actually used by `config.ts`'s `server.domain` |
| `.env` → `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `JWT_ADMIN_SECRET` | JWT signing secrets | Optional; if unset, auto-generated on first startup into `./data/jwt-*.key` (no longer fail-fast) |
| `.env` → `CORS_ORIGIN` | Allowed frontend origins (comma-separated) | Falls back to dev default `http://localhost:4200` when unset; must be explicitly configured in production |
| `web/src/app/services/constants.ts` | `apiPrefix` | Address prefix for the frontend to reach the backend, default `//${location.hostname}:3000` |

## Architecture and Design

See [docs/architecture.md](docs/architecture.md) for details. Key points:

- **Unified response format**: All HTTP endpoints return `{ status, message, data? }`, where `status: 0` indicates success.
- **Thread abstraction**: Both P2P and groups are abstracted as `MessageThread`; each user holds one `UserMessageThread` record per thread, whose `status` field drives the thread lifecycle (pending / established / blocked / deleted).
- **HTTP handles "writes and queries", SSE handles "push"**: Message sending goes through HTTP; the server pushes the **complete message body** one-way via SSE (`GET /api/v1/events`), so the client can render it on receipt without a second fetch. SSE auth reuses the `Authorization: Bearer <access_token>` header (the same `JwtAuthGuard` as HTTP), never in the URL.
- **Dual-token auth**: access_token (15 minutes, in memory) + refresh_token (14 days, stored), with automatic renewal on the frontend.

## API and Real-Time Communication Quick Reference

See [docs/api.md](docs/api.md) for the full documentation. Except for the SSE downstream stream (`GET /api/v1/events`), all read/write endpoints use `POST`.

**HTTP (partial)**

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/login` | Local | Login, returns dual tokens |
| POST | `/auth/renew-access` | – | Refresh access_token |
| POST | `/auth/renew-refresh` | – | Refresh both access + refresh |
| POST | `/auth/logout` | JWT | Logout |
| POST | `/user/register` | – | Register |
| POST | `/user/my-profile` | JWT | Current user profile |
| POST | `/user/send-friend-request` | JWT | Send a friend request |
| POST | `/user/approve-friend-request` | JWT | Accept a friend request |
| POST | `/user/query-thread/valid` | JWT | Valid thread list |
| POST | `/user/query-thread/to-pending` | JWT | Pending friend requests |
| POST | `/send-message` | JWT | Send a message |
| POST | `/query-messages` | JWT | Paginated history message query |
| POST | `/group/create` | JWT | Create a group |
| POST | `/group/invite` | JWT | Invite a friend to a group |
| POST | `/group/join` | JWT | Join a group via token |

**SSE Events (backend → frontend, `GET /api/v1/events`)**

| Event | Description |
| --- | --- |
| `NEW_MESSAGE` | New message notification; `data` is the complete message body (`threadId` / `id` / `content` / `createdAt`…), rendered by the frontend on receipt |
| `FORCE_LOGOUT` | All-device logout / password change / admin force-offline; the frontend disconnects and forces a re-login |

> SSE auth is not in-frame — it goes over HTTP: the `Authorization: Bearer <access_token>` header. If it expires, the connection is rejected (401) by `JwtAuthGuard`, and the frontend automatically renews and reconnects. Hence there is no `AUTH` frame as in the WebSocket era.

## Development Commands

**Backend**

```bash
npm run start           # Start
npm run start:dev       # Hot reload
npm run build           # Build
npm run lint            # ESLint
npm run format          # Prettier formatting
npm test                # Unit tests
npm run test:e2e        # e2e tests
npx prisma studio       # Visual data browser
```

**Frontend**

```bash
npm start --prefix web          # Development server (ng serve)
npm run build --prefix web      # Production build
npm test --prefix web           # Karma tests
```

## Deployment (Docker)

The project ships as a single self-contained Docker stack: PostgreSQL + migration runner + the app, behind a Caddy TLS edge. Two image variants are built from one `Dockerfile`:

| Tag | Variant | Contents | Public port |
| --- | --- | --- | --- |
| `soms:<ver>` / `soms:latest` | **full** | app **+ Caddy** bundled in one container | `7667` (HTTPS) |
| `soms:<ver>-slim` / `soms:slim` | **slim** | app only | `3000` (HTTP, for your own reverse proxy) |

The **full** variant is the default/simple path: one container runs the node origin on `:3000` and Caddy (TLS termination + reverse proxy) on `:7667`, supervised fail-fast by `docker/entrypoint.sh`. The **slim** variant is for operators who already run their own reverse proxy and only want the app.

### Build

```bash
./scripts/build-image.sh        # release flow: builds BOTH variants (full + slim), tags soms:latest + soms:slim
# or, for local dev — yields the FULL image (the tag compose runs):
docker build -t soms:latest .
# slim only:
docker build --target runtime -t soms:slim .
```

`docker compose up` does **not** build the app image — it fails fast if it is missing. Build it first (`./scripts/build-image.sh` tags `soms:latest`); compose runs that tag. Override `NODE_IMAGE` (Docker Hub mirror) and `GOPROXY` (Go modules for the Caddy plugin) for restricted networks — see `scripts/build-image.sh`.

### Run (all-in-one, full image)

```bash
SOMS_DOMAIN=chat.example.com \
CLOUDFLARE_API_TOKEN=... \
docker compose up -d
```

Required environment (compose fails fast if missing): `SOMS_DOMAIN` — your public domain / federation identity (`@user@<SOMS_DOMAIN>`). `POSTGRES_PASSWORD` ships a working default (postgres is internal-only — not published); set it to override. For the default **Cloudflare** DNS setup, also set `CLOUDFLARE_API_TOKEN` (a token with **Zone:DNS:Edit** on the `SOMS_DOMAIN` zone) — see [DNS provider](#dns-provider-certificate-signing) below for other providers. `ADMIN_BOOTSTRAP_PASSWORD` is optional — see the bootstrap-admin note below.

Only **one port** is published: `7667` (HTTPS; `7667/udp` for HTTP/3). Caddy terminates TLS and reverse-proxies to the in-process node app over loopback HTTP/1.1. Web UI, API, SSE, and federation S2S all ride on `7667`. Do **not** set `TLS_CERT`/`TLS_KEY` — Caddy is the TLS edge.

- **First-run certs**: Caddy issues the Let's Encrypt certificate via Let's Encrypt **DNS-01** on startup (no ports 80/443 needed). This takes ~10–60s; until then HTTPS returns a TLS error. Watch `docker compose logs -f app` for `certificate obtained successfully`. Issued certs persist in the `app-data` volume (under `/app/data/caddy`) across restarts, so they are not re-issued.
- **Persistent state** lives under one volume (`app-data` → `/app/data`): S2S + JWT keys, app logs (`data/logs/soms.log`, own rotation), Caddy state (`data/caddy`), and uploads (`data/uploads`). Postgres keeps its own dedicated `pgdata` volume (it requires exclusive ownership of its data dir).
- **Bootstrap admin** is self-seeded by the app on startup: on every boot it creates `account=admin` from `ADMIN_BOOTSTRAP_PASSWORD` if no admin exists yet (a no-op once one does) — no separate seed container, no manual `docker compose run`. If `ADMIN_BOOTSTRAP_PASSWORD` is left empty, the app still boots but logs a WARN and the `/admin` console has no login until you set it and restart. Log in to `/admin` with `admin` + the password.
- **HTTP/2**: clients negotiate h2 (and h3 over UDP) with Caddy on `7667`. The origin leg to node is HTTP/1.1 (a loopback hop inside the container).

### DNS provider (certificate signing)

The bundled Caddy ships **76 buildable** DNS-01 providers from `github.com/caddy-dns` — Cloudflare + all the China providers (**AliDNS** `alidns`, **Tencent** `tencentcloud` + `edgeone`, plus `huaweicloud`, `volcengine`, `westcn`) and the other major ones. So switching DNS providers is a **config change, not a rebuild**. (The other caddy-dns modules are excluded at build: archived, no resolvable version, or stuck on the pre-1.0 `libdns` API — notably `dnspod` is unmaintained, so Tencent users use `tencentcloud`/`edgeone`.)

- **Cloudflare (default)**: just set `CLOUDFLARE_API_TOKEN` — the baked Caddyfile uses it as-is.
- **Any other provider**: edit `./Caddyfile`'s `tls { dns <provider> ... }` block to that provider's syntax + credential env (examples in the Caddyfile header), then uncomment the `- ./Caddyfile:/etc/caddy/Caddyfile:ro` volume in `docker-compose.yml`. Each module's exact Caddyfile syntax is at `https://github.com/caddy-dns/<provider>`.

### Bring your own reverse proxy (slim image)

Use the slim image and run it behind your own nginx/Caddy/Traefik. The app speaks plain HTTP/1.1 on `:3000`; terminate TLS at your edge and forward to it. The full image's Caddy is not present in slim.

## Project Status

The core flows of this project (registration/login, friends, P2P/group threads, message send/receive, and real-time push) are functional. The following parts are still under development; please note before integrating:

- 🚧 **File upload**: The original `file` domain dead code was removed domain-wide in P1b (`src/controller/file.controller.ts` no longer exists); reimplementation is deferred to P3 (persist to Message + return an accessible URL).
- 🚧 **Notification system** (`src/notify`): `NotifyModule` is written but not imported into `AppModule`; Prisma already models `Notify` / `userNotiBox`, but the code does not yet consume them.
- 🚧 **User management** (`src/user-manage`): The service has `getUserList`, but the module is not wired up and has no controller endpoints.
- ✅ **Hardcoded secrets** (fixed in P0): JWT access/refresh/admin signing secrets are now externalized; when not explicitly set, they are auto-generated on first startup into `./data/jwt-*.key` (no longer fail-fast). Group invites changed to the `GROUP_INVITE` message type, requiring no signing secret.
- ✅ **Frontend route guards**: `authGuard` / `guestGuard` are mounted on routes (home/nav use authGuard, login/register use guestGuard).

## More Documentation

- [docs/architecture.md](docs/architecture.md) — System architecture, module responsibilities, authentication flow, SSE real-time communication, core business flows
- [docs/api.md](docs/api.md) — Complete HTTP API and SSE event reference
- [docs/database.md](docs/database.md) — Data models and relationship diagrams
- [docs/protocol-plan.md](docs/protocol-plan.md) — Backend interface and frontend-backend interaction protocol stack plan (layered target contracts, error codes, WS event catalog, P0–P3 roadmap)
- [docs/chat-message-list-design.md](docs/chat-message-list-design.md) — Mobile 1v1 chat message list design spec (WhatsApp style: bubbles/avatars/names/tails/grouping/light-dark themes/sizing)
