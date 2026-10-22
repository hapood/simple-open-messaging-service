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
  <a href="https://hapood.github.io/simple-open-messaging-service/"><img alt="Playground deployment" src="https://github.com/hapood/simple-open-messaging-service/actions/workflows/pages.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2f855a.svg"></a>
  <img alt="SOMS 0.1.0 alpha 0" src="https://img.shields.io/badge/SOMS-0.1.0--alpha.0-7c3aed.svg">
  <a href="spec/v1/README.md"><img alt="SOMFP v1 final-review draft" src="https://img.shields.io/badge/SOMFP-v1.0.0--draft.0-e95420.svg"></a>
</p>

<p align="center">
  <a href="spec/README.md">Federation specification</a>
  ·
  <a href="docs/development/local-development.md">Development setup</a>
  ·
  <a href="docs/deployment/nas.md">NAS deployment</a>
</p>

<p align="center">
  <img src="docs/design/assets/playground-preview.png" alt="SOMS Web Client Preview - Self-Hosted Federated Chat UI" width="850">
</p>

<p align="center">
  <a href="https://hapood.github.io/simple-open-messaging-service/"><strong>Try the live playground</strong></a> — client-only demo.
</p>

> [!IMPORTANT]
> SOMS `0.1.0-alpha.0` and the federation protocol (`v1.0.0-draft.0`) are under active development; the wire contract remains subject to closeout revisions prior to stable release.

## Features

SOMS connects independently operated chat servers. Users can become friends, exchange messages
and media, form groups, and place calls across servers without a shared account database or
central account authority. The server and administration console are self-hosted.

### Federation

- **Independent identities** — users keep an address on their own server.
- **Signed server-to-server traffic** — peer discovery, key continuity, HTTP message signatures, and
  replay protection support authenticated communication between servers.
- **Recoverable synchronization** — pull-based state, message, and deletion feeds let peers catch up
  after downtime; authorized media transfers verify content digests and declared sizes.
- **Open protocol** — SOMFP defines cross-server friendship, messaging, group membership, media,
  read state, deletion, and call signaling. Its versioned contract, schemas, security model, and
  conformance suite live in [`spec/`](spec/README.md).

### Chat and administration

- Direct and group conversations with message history, search, replies, mentions, link
  previews, unread state, mute, pin, and history clearing
- Images, video, audio, files, avatars, and access-controlled media storage
- OTP and QR sign-in with per-device sessions, sliding inactivity expiry, and remote revocation; registration
  and password sign-in are temporarily hidden in the client UI during alpha
- Real-time delivery over SSE, Web Push and FCM notifications, plus missed-message summaries
- One-to-one audio/video calls with WebRTC signaling and optional TURN credentials
- Administration console with RBAC, audit logs, quotas, diagnostics, federation controls, 2FA, and
  WebAuthn
- Responsive, installable web client with a shared Tauri shell for native platform integrations

## Deployment

SOMS ships as a self-contained Docker stack with PostgreSQL, automatic migrations, the application,
and a Caddy TLS edge.

| Profile | Status      | Intended environment                                                       | Guide / Compose                                                    |
| ------- | ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| NAS     | In progress | Home LAN administration with a publicly reachable client                   | [NAS guide](docs/deployment/nas.md) · [`deploy/nas/`](deploy/nas/) |
| Public  | In progress | Internet-facing server with standard HTTPS ports and public administration | [`deploy/public/`](deploy/public/)                                 |

## Platform Status

The Angular client runs in the browser and is shared with the Tauri native applications.
Native platform availability is tracked separately below; planned applications are not yet available.

| Platform                | Status                | Delivery                                                  |
| ----------------------- | --------------------- | --------------------------------------------------------- |
| Web / PWA               | **Available (Alpha)** | Modern desktop and mobile browsers                        |
| Android                 | In development        | Tauri application with native calling and FCM integration |
| Windows / macOS / Linux | Planned               | Tauri desktop applications                                |
| iOS                     | Deferred              | Paused due to App Store distribution constraints          |

## Documentation

| Topic                   | Entry point                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Documentation           | [Documentation index](docs/README.md)                                                                                       |
| Development             | [Local initialization and development](docs/development/local-development.md) · [Repository conventions](AGENTS.md)         |
| Federation protocol     | [Specification index](spec/README.md) · [SOMFP v1](spec/v1/README.md) · [Schemas and conformance](spec/v1/schema/README.md) |
| Architecture and stack  | [Architecture and technology stack](docs/overview/architecture.md) · [Database model](docs/overview/database.md)            |
| APIs                    | [Client/admin HTTP API](docs/api/api.md) · [Federation HTTP surface](spec/v1/protocol.md#3-federation-v1-http-surface)      |
| Deployment              | [NAS deployment (in progress)](docs/deployment/nas.md) · [Public server (in progress)](deploy/public/)                      |
| Operations              | [Rate limiting](docs/operations/rate-limiting.md)                                                                           |
| Native client           | [Tauri workspace](src-tauri/README.md) · [Android calls](docs/platform/android/calls.md)                                    |
| Security and governance | [Protocol security](spec/SECURITY.md) · [Protocol governance](spec/GOVERNANCE.md)                                           |

## License

SOMS is released under the [MIT License](LICENSE). Third-party software and asset notices are listed
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Copyright © 2026 [hapood](https://github.com/hapood).
