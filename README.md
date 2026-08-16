<p align="center">
  <img src="web/public/logo.svg" width="112" height="112" alt="SOMS logo">
</p>

<h1 align="center">SOMS</h1>

<p align="center">
  <strong>Simple Open Message Service</strong><br>
  A self-hosted, federated chat platform for the web and native devices.
</p>

<p align="center">
  <a href="https://github.com/hapood/simple-open-chat-service/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/hapood/simple-open-chat-service/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/hapood/simple-open-chat-service/actions/workflows/pages.yml"><img alt="Playground deployment" src="https://github.com/hapood/simple-open-chat-service/actions/workflows/pages.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2f855a.svg"></a>
  <img alt="SOMS 0.1.0 alpha 0" src="https://img.shields.io/badge/SOMS-0.1.0--alpha.0-7c3aed.svg">
  <a href="spec/v1/README.md"><img alt="SOCFP v1 release candidate" src="https://img.shields.io/badge/SOCFP-v1.0.0--rc.0-e95420.svg"></a>
</p>

<p align="center">
  <a href="https://hapood.github.io/simple-open-chat-service/playground/chatbox"><strong>Try the live UI playground</strong></a>
  ·
  <a href="spec/README.md">Federation specification</a>
  ·
  <a href="docs/development.md">Development setup</a>
  ·
  <a href="docs/deployment.md">Docker deployment</a>
</p>

> [!IMPORTANT]
> SOMS `0.1.0-alpha.0` is under active development and has not published its first stable release.
> The independently versioned federation protocol is currently `v1.0.0-rc.0`; operators should
> expect changes before the v1.0 freeze.

## Why SOMS?

Most self-hosted chat applications stop at the boundary of one installation. SOMS treats federation
as a first-class feature: people on independently operated servers can discover one another, become
friends, exchange messages and media, form groups, and place calls without sharing an account
database or trusting a central service.

At the same time, SOMS is one product across form factors. The Angular client runs directly in a
browser and is packaged with Tauri for native platforms, while the NestJS server and administration
console remain fully self-hostable.

### Federation by design

- **Independent identities** — users keep an address on their own server; no global account authority
  or hosted control plane is required.
- **Signed server-to-server traffic** — peer discovery, key continuity, HTTP message signatures, and
  replay protection establish trust between servers.
- **Recoverable, pull-based synchronization** — bounded state, message, and tombstone feeds make
  delivery deterministic and allow peers to recover after downtime.
- **Federated conversations** — friendship, direct messages, group membership, media, read state,
  message deletion, and call signaling cross server boundaries.
- **Content-addressed media** — authorized CAS transfer identifies blobs by digest and verifies their
  declared size before acceptance.
- **Versioned and extensible protocol** — explicit capability discovery allows one-way enablement of
  compatible extensions while v1 implementations safely ignore unsupported extension messages.
- **Open specification** — the protocol contract, JSON schemas, security model, and conformance suite
  live in [`spec/`](spec/README.md), independently of the SOMS implementation.

### A complete chat experience

- Direct and group conversations with message history, search, replies, mentions, link
  previews, unread state, mute, pin, and history clearing
- Images, video, audio, files, avatars, and access-controlled media storage
- OTP and QR sign-in with per-device sessions, trusted devices, and remote revocation; registration
  and password sign-in are temporarily hidden in the client UI
- Real-time delivery over SSE, Web Push and FCM notifications, plus missed-message summaries
- One-to-one audio/video calls with WebRTC signaling and optional TURN credentials
- Administration console with RBAC, audit logs, quotas, diagnostics, federation controls, 2FA, and
  WebAuthn
- Responsive, installable web client with a shared Tauri shell for native platform integrations

## UI Playground

The [chat UI playground](https://hapood.github.io/simple-open-chat-service/playground/chatbox) is a
static, interactive build of the real message-list and composer components. It uses deterministic
in-memory data, so it needs no account, server, or network API. Use its controls to try responsive
layouts, themes, virtual scrolling, loading states, optimistic sends, replies, media, and connection
states.

GitHub Pages publishes the playground from this repository after changes to the web client. It is a
component demonstration, not a public SOMS server: data entered there stays in the browser session.

## Platform Roadmap

SOMS uses one Angular client and a Tauri 2 native shell, keeping the core experience shared while
allowing platform-specific capabilities such as notifications, secure storage, media handling, and
calls.

| Platform  | Status            | Distribution                                                                                    |
| --------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| Web / PWA | **Released**      | Runs in modern desktop and mobile browsers                                                      |
| Android   | **Released**      | Tauri application with native calling and FCM integration                                       |
| Windows   | Planned           | Tauri desktop application                                                                       |
| macOS     | Planned           | Tauri desktop application                                                                       |
| Linux     | Planned           | Tauri desktop application                                                                       |
| iOS       | Deferred          | Development is paused because App Store distribution is not currently practical for the project |

The roadmap describes delivery priority, not protocol compatibility. Any conforming client can use a
SOMS server through its documented APIs.

## Architecture

```text
 Web / PWA ───────┐                         ┌──── Web / PWA
 Android (Tauri) ─┼─ HTTPS + SSE ─ SOMS ───┼──── Android (Tauri)
 Desktop (Tauri) ─┘               server   └──── Third-party clients
                                      │
                                signed SOCFP v1
                                      │
                                  peer servers
```

| Layer                     | Technology                                                             |
| ------------------------- | ---------------------------------------------------------------------- |
| API and federation server | NestJS 11, Fastify, Drizzle ORM, PostgreSQL                            |
| User client               | Angular 20, Signals, RxJS, Angular CDK/Material primitives             |
| Native applications       | Tauri 2 with platform integrations in Rust/Kotlin                      |
| Administration console    | React 19 and Vite                                                      |
| Real-time and calls       | SSE, Web Push, FCM, WebRTC, optional TURN                              |
| Federation                | SOCFP v1, Ed25519 HTTP message signatures, pull-based feeds, CAS media |

For the full component model and request flows, see the
[architecture guide](docs/overview/architecture.md). The consumer and administrator endpoints are
documented in the [HTTP API reference](docs/api/api.md).

## Deployment

SOMS ships as a self-contained Docker stack with PostgreSQL, automatic migrations, the application,
and a Caddy TLS edge. The repository provides two ready-to-copy Compose examples:

| Profile | Intended environment                                             | Example                            |
| ------- | ---------------------------------------------------------------- | ---------------------------------- |
| Public  | Internet-facing server with standard HTTPS ports                 | [`deploy/public/`](deploy/public/) |
| NAS     | LAN/NAS server with single-port TLS and an optional LAN hostname | [`deploy/nas/`](deploy/nas/)       |

The [Docker deployment guide](docs/deployment.md) explains how to choose a profile, build the image,
copy and configure the example, initialize the administrator, obtain DNS-01 certificates, verify the
deployment, and update it safely. For federation identity, DNS, key continuity, and peer operations,
also read the [federated deployment guide](docs/overview/federation-protocol.md).

## Documentation

| Topic                     | Entry point                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Development               | [Local initialization and development](docs/development.md) · [Repository conventions](AGENTS.md)                           |
| Federation protocol       | [Specification index](spec/README.md) · [SOCFP v1](spec/v1/README.md) · [Schemas and conformance](spec/v1/schema/README.md) |
| Server architecture       | [Architecture](docs/overview/architecture.md) · [Database model](docs/overview/database.md)                                 |
| APIs                      | [Client/admin HTTP API](docs/api/api.md) · [Federation S2S API](docs/api/federation-s2s-api.md)                             |
| Deployment and federation | [Docker deployment](docs/deployment.md) · [Federated deployment guide](docs/overview/federation-protocol.md)                |
| Operations                | [Rate limiting](docs/operations/rate-limiting.md) · [Call release checklist](docs/calls-release-checklist.md)               |
| Native client             | [Tauri workspace](src-tauri/README.md) · [Android calls](docs/android-calls-client.md)                                      |
| Security and governance   | [Protocol security](spec/SECURITY.md) · [Protocol governance](spec/GOVERNANCE.md)                                           |

## License

SOMS is released under the [MIT License](LICENSE). Third-party software and asset notices are listed
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Copyright © 2026 [hapood](https://github.com/hapood).
