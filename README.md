# SOMS · Simple Open Chat Service

A self-hosted instant messaging service with accounts, friend and group threads, media messages,
real-time delivery, push notifications, voice/video calls, administration, and server federation.
The design goal is to remain straightforward for third-party applications to integrate.

- **Backend**: NestJS 11 + Drizzle ORM + PostgreSQL + SSE + opaque per-device session tokens
- **Web client**: Angular 20 (standalone components, Signals, zoneless change detection)
- **Admin console**: React 19 + Vite
- **Native shell**: Tauri 2, including the Android calling integration

> The application codename is **SOMS** (Simple Open Message Service). This monorepo contains the
> backend, user-facing web client, admin console, and Tauri native shell.

---

## Table of Contents

- [Feature Overview](#feature-overview)
- [Federation Protocol](#federation-protocol)
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

| Module         | Capabilities                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Account        | Password, OTP, and QR login; opaque per-device sessions; trusted devices; session revocation; brute-force protection |
| User           | Profile, search by username, batch query                                                                             |
| Friends        | Local and federated friend invitations, approval, rejection, blocking, and unread badges                             |
| Threads        | P2P and group threads, revisions/delta sync, aliases, mute, pin, and history clearing                                |
| Messages       | Text and media messages, cursor pagination, search, read state, SSE delivery, and link previews                      |
| Groups         | Creation, membership, roles, invitations, ownership transfer, and federated groups                                   |
| Media          | Image, video, audio, file and avatar upload; content-addressed storage and access control                            |
| Notifications  | In-app notifications, Web Push, FCM, missed-message summaries, and notification actions                              |
| Calls          | Android-native one-to-one audio/video calls with SSE signaling and optional TURN credentials                         |
| Administration | RBAC, audit logs, users/groups/media, quotas, diagnostics, federation, 2FA, and WebAuthn                             |

## Federation Protocol

Federation is a core part of SOMS, not an implementation-specific extension. Independent servers
communicate through a versioned, signed, pull-based protocol with explicit identity continuity,
bounded feeds, deterministic recovery, media authorization, and call signaling.

Federation v1 is currently a release candidate: its model and required feature set are complete,
while editorial clarification and conformance corrections may still be made before v1.0 is frozen.

- [Federation specification index](spec/README.md)
- [Federation Protocol v1 release candidate](spec/v1/README.md)
- [Machine-readable schemas and conformance suite](spec/v1/schema/README.md)

## Tech Stack

**Backend**

| Category         | Choice                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Framework        | NestJS 11                                                                                   |
| Database         | PostgreSQL (Drizzle ORM + `node-postgres`)                                                  |
| Real-time        | SSE (`GET /api/v1/events`, `text/event-stream`) — a one-way downstream-only push channel    |
| Authentication   | Passport Local + opaque database-backed session tokens + Argon2id password hashing          |
| Federation       | RFC 9421-style HTTP message signatures, Ed25519 keys, discovery, quotas, and media transfer |
| Real-time / push | SSE, Web Push, FCM, and call signaling                                                      |

**Frontend**

| Category         | Choice                                                      |
| ---------------- | ----------------------------------------------------------- |
| Framework        | Angular 20 (standalone components)                          |
| Change Detection | Zoneless Angular change detection                           |
| State            | Angular Signal + RxJS                                       |
| UI               | In-house components plus Angular CDK/Material primitives    |
| Real-time        | Fetch-based SSE worker with reconnect and liveness handling |

## Project Structure

```
simple-open-chat-service/
├── src/                      # Backend NestJS service
│   ├── main.ts               # App entry and Fastify adapter
│   ├── bootstrap.ts          # HTTP plugins, validation, CORS, static/media serving
│   ├── app.module.ts         # Root module
│   ├── database/             # Drizzle schema, relations, and DatabaseService
│   ├── auth/                 # Session, password, OTP, QR, throttling and guards
│   ├── controller/           # User-facing HTTP controllers
│   ├── message/              # Messages and fan-out
│   ├── gateway/              # Authenticated SSE downstream
│   ├── upload/               # Media ingest, storage and access control
│   ├── notification/         # Notification query/action logic
│   ├── calls/                # Call lifecycle, signaling and TURN credentials
│   ├── federation/           # Discovery, signatures, S2S protocol and delivery
│   └── admin/                # Administration, RBAC, audit, 2FA and WebAuthn
├── database/
│   └── migrations/           # Versioned SQL migrations
├── test/                     # e2e tests
├── web/                      # Angular frontend
├── admin-web/                # React administration console
├── src-tauri/                # Tauri desktop/mobile shell and Android native code
├── deploy/                   # Public and NAS Docker Compose templates
├── spec/                     # Versioned SOMS Federation protocol specification
├── docs/                     # Architecture, API, operations and implementation notes
└── package.json
```

## Quick Start

### Prerequisites

- Node.js 24 recommended
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

# Admin console
npm install --prefix admin-web
```

### 3. Initialize the Database

```bash
# Apply database migrations (create tables)
npm run db:migrate
# Inspect or baseline an existing database
npm run db:status
npm run db:baseline
```

`database/migrations/0000_base.sql` is the current greenfield baseline. Because
the migration history was intentionally compacted, databases carrying an older
`schema_migrations` ledger must be recreated from this baseline; the runner will
reject a mixed old/new ledger instead of silently accepting an unverifiable
schema.

### 4. Start the Services

```bash
# Backend (listens on http://localhost:3000)
npm run start:dev

# Frontend (another terminal, default http://localhost:4200)
npm start --prefix web

# Admin console (another terminal)
npm run dev --prefix admin-web
```

`npm run dev` starts the bundle watcher, API, web client, and admin console together.

## Configuration

| Location                                                               | Setting                                                                        | Description                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `.env` → `DATABASE_URL` or `PGHOST`/`PGDATABASE`/`PGUSER`/`PGPASSWORD` | PostgreSQL connection                                                          | URL form remains supported; Docker deployment uses the standard `PG*` variables |
| `.env` → `SOMS_DOMAIN`                                                 | Public domain of this service (federation identity)                            | Required (`@user@<domain>`, host of `/.well-known/soms`)                        |
| `.env` → `SOMS_WEB_DOMAIN`                                             | Optional public Web/native-client entry hostname; defaults to `SOMS_DOMAIN`    |
| `.env` → `ADMIN_BOOTSTRAP_PASSWORD`                                    | Password used to create the first `admin` account when no administrator exists |
| `.env` → `SOMS_TLS_MODE`                                               | Public origin mode: `standard`, `single-port`, or `disabled`                   |
| `.env` → `SOMS_LAN_DOMAIN`                                             | Optional alternate LAN hostname used by native clients                         |
| `.env` → `SOMS_S2S_KEY_PATH`                                           | Optional path for the persisted federation Ed25519 key                         |
| `.env` → `SOMS_STUN_URLS` / `SOMS_TURN_*`                              | Optional WebRTC ICE/TURN configuration                                         |
| `.env` → `GOOGLE_APPLICATION_CREDENTIALS` / `FIREBASE_CLIENT_CONFIG`   | Optional FCM server/client configuration                                       |
| `.env` → `LOG_LEVEL` / `LOG_DIR`                                       | Structured logging level and directory                                         |
| `.env` → `TLS_CERT` / `TLS_KEY`                                        | Optional direct TLS/HTTP2 mode; normally omitted behind Caddy                  |

## Architecture and Design

See [docs/overview/architecture.md](docs/overview/architecture.md) for details. Key points:

- **Unified response format**: HTTP endpoints return `{ code, message, data? }`, where `code: 0` indicates success.
- **Thread abstraction**: Both P2P and groups are abstracted as `MessageThread`; each user holds one `UserMessageThread` record per thread, whose `status` field drives the thread lifecycle (pending / established / blocked / deleted).
- **HTTP handles writes and queries; SSE handles push**: the server pushes complete message and lifecycle events through `GET /api/v1/events`.
- **Session authentication**: browsers use a `SameSite=Strict`, HTTP-only session cookie; native clients use the same opaque token as a Bearer credential. Untrusted sessions have a sliding 14-day deadline, while explicitly trusted native/desktop sessions remain valid until revoked.
- **Secure by default**: a global session guard protects routes unless they explicitly opt out or use the separate admin/S2S authentication mechanism.

## API and Real-Time Communication Quick Reference

See [docs/api/api.md](docs/api/api.md) for the full documentation. Business commands and queries
primarily use `POST`; streaming, configuration, health, and selected resource endpoints use
`GET`/`DELETE`.

**HTTP (partial)**

| Method | Path                                   | Auth    | Description                                          |
| ------ | -------------------------------------- | ------- | ---------------------------------------------------- |
| POST   | `/auth/login`                          | Public  | Password login, returns one per-device session token |
| POST   | `/auth/otp/login`                      | Public  | Login with a one-time code                           |
| POST   | `/auth/qr/create`, `/auth/qr/poll`     | Public  | Create or poll a QR login challenge                  |
| POST   | `/auth/logout`                         | Public  | Revoke the presented session and clear cookies       |
| POST   | `/auth/logout-all`                     | Session | Revoke all sessions                                  |
| POST   | `/auth/sessions`, `/revoke-session`    | Session | List or revoke devices                               |
| POST   | `/user/register`                       | –       | Register                                             |
| POST   | `/user/my-profile`                     | Session | Current user profile                                 |
| POST   | `/invite/friend`, `/accept`, `/reject` | Session | Friend invitation lifecycle                          |
| POST   | `/user/query-thread/delta`             | Session | Incremental thread synchronization                   |
| POST   | `/send-message`, `/send-media`         | Session | Send text or media                                   |
| POST   | `/query-messages`, `/search-messages`  | Session | History and search                                   |
| POST   | `/group/create`, `/invite`, `/leave`   | Session | Group lifecycle                                      |
| POST   | `/upload/*`                            | Session | Upload images, avatars, files, video, or audio       |
| GET    | `/events`                              | Session | SSE event stream                                     |

**SSE Events (backend → frontend, `GET /api/v1/events`)**

| Event                        | Description                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEW_MESSAGE`                | New message notification; `data` is the complete message body (`threadId` / `id` / `content` / `createdAt`…), rendered by the frontend on receipt |
| `FORCE_LOGOUT`               | All-device logout / password change / admin force-offline; the frontend disconnects and forces a re-login                                         |
| `CALL_EVENT` / `CALL_SIGNAL` | Call lifecycle and WebRTC signaling                                                                                                               |

> SSE authentication is part of the HTTP request: same-origin browsers send the session cookie,
> while native/desktop clients send `Authorization: Bearer <session_token>`. Credentials are never
> placed in the URL.

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
npm run db:status       # Migration status
```

**Frontend**

```bash
npm start --prefix web          # Development server (ng serve)
npm run build --prefix web      # Production build
npm test --prefix web           # Karma tests
```

**Admin console**

```bash
npm run dev --prefix admin-web
npm run build --prefix admin-web
npm test --prefix admin-web
```

## Deployment (Docker)

The project ships as a single self-contained Docker stack: PostgreSQL + migration runner + the app, behind a Caddy TLS edge. Two image variants are built from one `Dockerfile`:

| Tag                             | Variant  | Contents                                 | Public port                               |
| ------------------------------- | -------- | ---------------------------------------- | ----------------------------------------- |
| `soms:<ver>` / `soms:latest`    | **full** | app **+ Caddy** bundled in one container | `7667` (HTTPS)                            |
| `soms:<ver>-slim` / `soms:slim` | **slim** | app only                                 | `3000` (HTTP, for your own reverse proxy) |

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

`deploy/` holds **two launch-template profiles** — copy the one that matches your deployment to a deployment directory and run from there (not inside the source checkout, so `./data` doesn't land in the tree):

- **`deploy/public/`** — public internet: TLS on `80`/`443` (+ `7667` for federation), DNS-01 cert, admin open to all source IPs (`SOMS_TLS_MODE=standard`, `SOMS_ADMIN_ACCESS=public`).
- **`deploy/nas/`** — intranet/NAS: TLS on a single `7667`, served by the public domain **and** an optional LAN domain (`SOMS_LAN_DOMAIN`) — both real DNS-01 certs, so native clients can reach the box from inside the LAN when the public domain is hairpin-NAT-unreachable (no self-signed cert / click-through; works on iOS PWA too). Admin locked to private-range IPs (`SOMS_TLS_MODE=single-port`, `SOMS_ADMIN_ACCESS=lan`).

```bash
cp -r deploy/public/ /opt/soms/ && cd /opt/soms   # or deploy/nas/ for an intranet/NAS box
cp .env.example .env                               # then edit .env (profile-specific fields)
docker compose up -d
```

The deployment directory contains `docker-compose.yml`, the operator-managed `.env`, and a `data/` directory for persistent application state. Required values include `SOMS_DOMAIN`, `PGPASSWORD`, and `ADMIN_BOOTSTRAP_PASSWORD`; Compose injects the standard PostgreSQL `PG*` variables directly into the app and migration runner. For the default **Cloudflare** DNS setup, also set `CLOUDFLARE_API_TOKEN` (Zone:DNS:Edit on the `SOMS_DOMAIN` zone).

Published ports depend on the profile and can be changed in `.env`: NAS uses `SOMS_PORT`; public uses `SOMS_HTTP_PORT`, `SOMS_HTTPS_PORT`, and `SOMS_FEDERATION_PORT`. Container ports remain 80/443/7667. Caddy terminates TLS and reverse-proxies to the in-process node app over loopback HTTP/1.1. Do **not** set `TLS_CERT`/`TLS_KEY` — Caddy is the TLS edge.

- **First-run certs**: Caddy issues the Let's Encrypt certificate(s) via **DNS-01** on startup (no ports 80/443 needed) — one for `SOMS_DOMAIN` and, if `SOMS_LAN_DOMAIN` is set, one for it too (both via the same provider/zone; the LAN domain **must share** `SOMS_DOMAIN`'s registrable domain). This takes ~10–60s; until then HTTPS returns a TLS error. Watch `docker compose logs -f app` for `certificate obtained successfully`. Issued certs persist under `./data/caddy` across restarts, so they are not re-issued.
- **LAN domain & client fallback** (optional, `SOMS_LAN_DOMAIN`): native clients (desktop/Android) accept either domain in server settings — the other is auto-filled from `/shell/compat` and confirmed via a modal, then the client races `GET /api/v1/health` on both and uses whichever is reachable (auto-fallback as you move between LAN and WAN; same backend ⇒ one session works on both). Browser/PWA clients can use the LAN domain manually. **DNS-rebinding note:** if the LAN domain's public A record points directly at a private IP, some resolvers (pi-hole, dnsmasq `stop-dns-rebind`, OpenWrt) may drop it — use split-horizon DNS or allowlist the domain (not observed on most home/ISP resolvers).
- **Persistent state** lives under one bind mount (`./data` → `/app/data`): S2S + JWT keys, app logs, Caddy state, uploads, and the operator-provided Firebase files. Postgres keeps its own dedicated `postgres-data` volume. Put `firebase-service-account.json` and `google-services.json` in `./data` to enable FCM; the corresponding paths are already documented in `.env.example`.
- **Bootstrap admin** is self-seeded by the app on startup: on every boot it creates `account=admin` from `ADMIN_BOOTSTRAP_PASSWORD` if no admin exists yet (a no-op once one does) — no separate seed container, no manual `docker compose run`. If `ADMIN_BOOTSTRAP_PASSWORD` is left empty, the app still boots but logs a WARN and the `/admin` console has no login until you set it and restart. Log in to `/admin` with `admin` + the password.
- **HTTP/2**: clients negotiate h2 (and h3 over UDP) with Caddy on `7667`. The origin leg to node is HTTP/1.1 (a loopback hop inside the container).

### DNS provider (certificate signing)

The bundled Caddy ships **76 buildable** DNS-01 providers from `github.com/caddy-dns` — Cloudflare + all the China providers (**AliDNS** `alidns`, **Tencent** `tencentcloud` + `edgeone`, plus `huaweicloud`, `volcengine`, `westcn`) and the other major ones. So switching DNS providers is a **config change, not a rebuild**. (The other caddy-dns modules are excluded at build: archived, no resolvable version, or stuck on the pre-1.0 `libdns` API — notably `dnspod` is unmaintained, so Tencent users use `tencentcloud`/`edgeone`.)

- **Cloudflare (default)**: set `CLOUDFLARE_API_TOKEN` in `.env`; the app entrypoint renders its internal Caddyfile.
- **Any other provider**: set `CADDY_DNS_DIRECTIVE` in `.env` to that provider's `dns ...` line plus its credential variables; `{KEY}` references are transcribed into the generated Caddyfile. Examples are in each profile's `.env.example`. Each module's exact syntax is at `https://github.com/caddy-dns/<provider>`.

### Bring your own reverse proxy (slim image)

Use the slim image and run it behind your own nginx/Caddy/Traefik. The app speaks plain HTTP/1.1 on `:3000`; terminate TLS at your edge and forward to it. The full image's Caddy is not present in slim.

## Project Status

The account, friend, thread, message, group, upload, notification, administration, and federation
flows are implemented and covered by unit and/or end-to-end tests. Android audio/video calling is
actively evolving; see [android-calls-followup.md](docs/roadmap/android-calls-followup.md) for its
remaining platform work. Roadmap documents describe future work and are not statements that the
corresponding current modules are absent.

## More Documentation

The normative Federation protocol lives at the repository root under [`spec/`](spec/README.md).
Architecture, API, operational, implementation, and roadmap documentation lives under `docs/`.

**Federation protocol** (`spec/`):

- [Specification index](spec/README.md) — Version status, authority, and release policy
- [Federation v1](spec/v1/README.md) — Normative reading order and protocol contract
- [Schemas and conformance suite](spec/v1/schema/README.md) — Machine-readable validation package

**Architecture and product design** (`docs/overview/`) — the SOMS implementation as it is:

- [architecture.md](docs/overview/architecture.md) — System architecture, module responsibilities, authentication, SSE real-time, core business flows
- [database.md](docs/overview/database.md) — Data models and relationships
- [account-naming.md](docs/overview/account-naming.md) — `account` grammar spec (single source of truth)
- [chat-message-list-design.md](docs/overview/chat-message-list-design.md) — Mobile 1v1 chat message-list UI spec (WhatsApp style)
- [federation-protocol.md](docs/overview/federation-protocol.md) — Federation protocol & deployment guide (what federation is + how to deploy a node)
- [federation/README.md](docs/federation/README.md) — SOMS federation implementation notes, audits, and design history

**API & interface contracts** (`docs/api/`):

- [api.md](docs/api/api.md) — Complete HTTP API + SSE event reference (consumer + admin)
- [federation-s2s-api.md](docs/api/federation-s2s-api.md) — Federation server-to-server API reference

**Architecture evolution / roadmap** (`docs/roadmap/`) — phase designs, reviews, follow-ups, planned items:

- [protocol-plan.md](docs/roadmap/protocol-plan.md) — Core protocol-stack plan + P0–P3 roadmap
- [push-fcm-runtime-config.md](docs/roadmap/push-fcm-runtime-config.md) — FCM runtime-config fetch (planned)

> `docs/requests.http` is a VS Code REST Client scratch script for the business-code regression.

## License

This project is released under the [MIT License](LICENSE).

Copyright (c) 2026 [hapood](https://github.com/hapood).
Third-party software and asset notices are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
