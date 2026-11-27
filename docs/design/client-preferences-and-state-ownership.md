# Client Preferences and State Ownership

Status: implemented.

This document defines the single-user client storage and login lifecycle model.
There is no multi-account selector, no scope column, and no migration from
older storage layouts.

## Stores

Browser persistence uses the `soms-client-preferences` IndexedDB (version 2).
Native persistence uses the device SQLite database (`soms-local.sqlite3`). Both
expose two independent key/value stores with JSON values and no scope column.

| Store | Contents | Logout |
| --- | --- | --- |
| `settings` | User settings: language, theme, notification enablement, sound, preview mode, alert policy, appearance, transfer, layout, debug, emoji recents | Kept |
| `app_state` | Installation, server configuration, and login lifecycle metadata | `forwardRecentThreads` removed; lifecycle transitions through `cleaning` to `signed-out`; `serverConfig` and `pushDeviceId` kept |

`app_state` keys:

| Key | Meaning |
| --- | --- |
| `schemaVersion` | Version `1` of this app-state layout. Missing or unversioned `app_state` is cleared on startup. |
| `lifecycleState` | Durable lifecycle: `unconfigured`, `signed-out`, `active`, or `cleaning`. Written by Rust only on native. |
| `sessionUuid` | Login identity written with `active`. Removed when cleanup finishes and the state becomes `signed-out`. Written by Rust only on native. |
| `serverConfig` | Server origins (`primary`, `secondary`) and public `firebaseConfig`. Written during server setup and kept on logout. |
| `cacheRebuild` | `pending` / `attempted` recovery marker. |
| `forwardRecentThreads` | Recent forwarding targets. Kept across restart, removed on explicit logout. |
| `pushDeviceId` | Installation push identity. Survives logout. |
| `pushRegistration:<origin><apiPrefix>` | Push registration checkpoint. |

Remote conversation settings (`muted`, `pinned`, `alias`) stay in their domain
caches and are not copied into either store.

## Confidential storage

Secure storage holds one pair: `{token, sessionUuid}`, written and deleted
together. On desktop, this is stored as JSON in the single `soms/session`
keyring entry (`secure_get_login`). On Android, `SomsSecureStore` stores both
values together.

Startup admits a login only when `lifecycleState` is `active`, both UUIDs are
present and equal, and the token is non-empty. A token without its UUID is
residue, not a credential.

## Login cache

The per-session message/domain cache uses a fixed name:

- Browser: IndexedDB `soms-session`
- Native: SQLite `soms-session.sqlite`

## Lifecycle and logout

- `unconfigured` → `signed-out`: server configuration committed.
- `signed-out` → `active`: login succeeds and activates the session.
- `active` → `cleaning` → `signed-out`: confirmed server logout or explicit
  local-only cleanup deletes the credential pair, clears `forwardRecentThreads`,
  deletes `soms-session` / `soms-session.sqlite`, and returns to `signed-out`.
- A restart during `cleaning` resumes local deletion only and never contacts the
  server.
