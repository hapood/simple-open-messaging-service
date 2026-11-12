# Changelog

## 0.1.0-alpha.2

### Clients

- Add Windows x64 and ARM64 NSIS installer builds to CI and release publishing,
  with native Rust runtime tests on both architectures and SHA-256 checksums.
  Installers are currently unsigned.
- Add a native Windows launch presentation without layered-window startup overhead.
- Align Android native libraries for 16 KB page-size devices and improve notification
  badges and launcher-specific guidance.
- Add macOS and Linux alpha clients, desktop notifications, and a macOS Dock unread badge.
- Unify native notification policy in Rust and align Web delivery, cooldowns, and
  click navigation. Silently restore surviving cards on restart where supported;
  Linux starts fresh without clearing old cards. Warn on uncertain delivery results
  without blocking later notifications.
- Add system notifications for friend and group join requests across Web, desktop,
  and Android, with clicks opening the corresponding request list or review panel.
- Coordinate Web service-worker updates and session restoration to avoid startup
  races between authentication, push registration, and notification delivery.
- Fix Android startup hangs and native login restoration by making Rust the single
  owner of credential activation and session transitions.
- Fix native profile and avatar updates, account cache initialization, and namespace
  catch-up when an empty page is already current.
- Preserve conversation drafts and composer state across message-window jumps and
  initial-load retries. Cancel abandoned window requests without cancelling
  account-level uploads or already-admitted database commits.
- Reconcile refreshed messages and deletion notices without moving the reading
  position, and persist deletion markers so stale cached messages do not reappear.
- Improve synchronous cached-history pagination, message navigation, contact lookup,
  mentions, responsive layouts, and playground regression coverage.
- Rework login methods with a Material 3 segmented selector and runtime language updates.
- Improve native calls, SSE reconnection, Android launch presentation, and retryable
  voice-upload handling.

### Server and deployment

- Prevent group creation from generating a spurious invitation or unread request
  for the founding owner.
- Expand administrator user, session, media, and federation diagnostic tools.
- Unify daily quotas and add configurable per-file size limits.
- Add TLS-ALPN-01 certificate challenges for standard-port deployments through
  `CADDY_CERT_MODE`, alongside the existing certificate modes.
- Generate Caddy configuration in TypeScript at supervisor bootstrap, with golden
  configuration checks and real routing tests.
- When a separate Web domain is configured, serve federation only on the identity
  domain and application routes only on the Web/LAN domains. Deployments without
  a separate Web domain keep the combined surface.
- Extend CI coverage for native IPC permissions, Rust and Android contracts,
  PostgreSQL integration, deployment tooling, and browser lifecycle behavior.
- Update federation to SOMFP 1.0.0-draft.2; see the [protocol changelog](spec/CHANGELOG.md).

### Compatibility and upgrade

- SOMFP draft.2 is incompatible with draft.1. Upgrade peers together and use matching
  alpha.2 clients and servers.
- Discovery moves from `/.well-known/somfp` to `/somfp/discovery`; federation APIs
  move from `/s2s/v1/*` to `/somfp/v1/*`. The old routes have no compatibility aliases.
  Update custom reverse proxies and monitoring probes before switching traffic.
- With a separate Web domain, clients must use the application domain rather than
  the federation-only identity domain. DNS SRV changes the connection destination,
  not the identity domain used for TLS validation, SNI, or HTTP authority.
- Alpha.1 databases cannot be upgraded in place. Back up needed data and use a fresh
  test database; do not bypass migration checksum checks.
- See the [deployment guide](docs/deployment/deployment.md) for certificate modes,
  domain configuration, and routing requirements.

## 0.1.0-alpha.1

- Add a Docker Compose configuration generator for public and LAN/NAS deployments.
- Improve container startup, automatic database migrations, and multi-platform image publishing.
- Add administrator account security controls and improve user management.
- Expand network self-checks with public IP detection, DNS checks, and federation diagnostics.
- Allow runtime log output levels to be managed from the administration console.
- Update the federation profile contract to SOMFP 1.0.0-draft.1.
- Fix web client asset loading on sub-path deployments and deep links.
- Fix profile resolution and login configuration handling.

## 0.1.0-alpha.0

- Initial alpha release.
