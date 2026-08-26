<p align="center">
  <img src="web/public/logo.svg" width="112" height="112" alt="SOMS logo">
</p>

<h1 align="center">SOMS</h1>

<p align="center">
  <strong>Simple Open Messaging Service</strong><br>
  A self-hosted, federated chat platform for the web and native devices.
</p>

<p align="center">
  <a href="https://github.com/hapood/simple-open-messaging-service/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/hapood/simple-open-messaging-service/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/hapood/simple-open-messaging-service/actions/workflows/pages.yml"><img alt="Playground deployment" src="https://github.com/hapood/simple-open-messaging-service/actions/workflows/pages.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2f855a.svg"></a>
  <img alt="SOMS 0.1.0 alpha 0" src="https://img.shields.io/badge/SOMS-0.1.0--alpha.0-7c3aed.svg">
  <a href="spec/v1/README.md"><img alt="SOMFP v1 release candidate" src="https://img.shields.io/badge/SOMFP-v1.0.0--rc.0-e95420.svg"></a>
</p>

<p align="center">
  <a href="https://hapood.github.io/simple-open-messaging-service/"><strong>Try the live UI playground — no server required</strong></a>
  ·
  <a href="spec/README.md">Federation specification</a>
  ·
  <a href="docs/development/local-development.md">Development setup</a>
  ·
  <a href="docs/deployment/nas.md">NAS deployment</a>
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
- **Strictly versioned protocol** — each wire major has a fixed, closed surface; incompatible fields,
  types, or behavior ship under a new integer major.
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

## Deployment

SOMS ships as a self-contained Docker stack with PostgreSQL, automatic migrations, the application,
and a Caddy TLS edge. The first published deployment guide covers the NAS profile: administration
stays on the home LAN while the client and federation endpoint can be reached from the internet.

| Profile | Documentation status | Intended environment                                                       | Example                            |
| ------- | -------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| NAS     | **Published**        | Home LAN administration with a publicly reachable client                   | [`deploy/nas/`](deploy/nas/)       |
| Public  | In progress          | Internet-facing server with standard HTTPS ports and public administration | [`deploy/public/`](deploy/public/) |

The [NAS deployment guide](docs/deployment/nas.md) explains how to build the image, configure the NAS
profile, initialize the administrator, obtain DNS-01 certificates, verify the deployment, and update
it safely. The public-server deployment guide is still being written.

## Platform Roadmap

SOMS uses one Angular client and a Tauri 2 native shell, keeping the core experience shared while
allowing platform-specific capabilities such as notifications, secure storage, media handling, and
calls.

| Platform  | Status         | Distribution                                                                                    |
| --------- | -------------- | ----------------------------------------------------------------------------------------------- |
| Web / PWA | **Released**   | Runs in modern desktop and mobile browsers                                                      |
| Android   | In development | Tauri application with native calling and FCM integration                                       |
| Windows   | Planned        | Tauri desktop application                                                                       |
| macOS     | Planned        | Tauri desktop application                                                                       |
| Linux     | Planned        | Tauri desktop application                                                                       |
| iOS       | Deferred       | Development is paused because App Store distribution is not currently practical for the project |

The roadmap describes delivery priority, not protocol compatibility. Any conforming client can use a
SOMS server through its documented APIs.

## Architecture

```text
 Web / PWA ───────┐                         ┌──── Web / PWA
 Android (Tauri) ─┼─ HTTPS + SSE ─ SOMS ───┼──── Android (Tauri)
 Desktop (Tauri) ─┘               server   └──── Third-party clients
                                      │
                                signed SOMFP v1
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
| Federation                | SOMFP v1, Ed25519 HTTP message signatures, pull-based feeds, CAS media |

For the full component model and request flows, see the
[architecture guide](docs/overview/architecture.md). The consumer and administrator endpoints are
documented in the [HTTP API reference](docs/api/api.md).

## Documentation

| Topic                     | Entry point                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Documentation             | [Documentation index](docs/README.md)                                                                                       |
| Development               | [Local initialization and development](docs/development/local-development.md) · [Repository conventions](AGENTS.md)         |
| Federation protocol       | [Specification index](spec/README.md) · [SOMFP v1](spec/v1/README.md) · [Schemas and conformance](spec/v1/schema/README.md) |
| Server architecture       | [Architecture](docs/overview/architecture.md) · [Database model](docs/overview/database.md)                                 |
| APIs                      | [Client/admin HTTP API](docs/api/api.md) · [Federation HTTP surface](spec/v1/protocol.md#3-federation-v1-http-surface)      |
| Deployment and federation | [NAS deployment](docs/deployment/nas.md) · [Federation specification](spec/README.md)                                       |
| Operations                | [Rate limiting](docs/operations/rate-limiting.md)                                                                           |
| Native client             | [Tauri workspace](src-tauri/README.md) · [Android calls](docs/platform/android/calls.md)                                    |
| Security and governance   | [Protocol security](spec/SECURITY.md) · [Protocol governance](spec/GOVERNANCE.md)                                           |

## License

SOMS is released under the [MIT License](LICENSE). Third-party software and asset notices are listed
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Copyright © 2026 [hapood](https://github.com/hapood).
