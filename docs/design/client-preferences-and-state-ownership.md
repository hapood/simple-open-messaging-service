# Client Preferences and State Ownership

Status: confirmed storage model; not implemented.

This document replaces the earlier single-account journal layout. The product is
one local login at a time. There is no multi-account selector and no persisted
login phase machine.

## Stores

Browser persistence stays in the `soms-client-preferences` IndexedDB. Native
persistence stays in the existing device SQLite database. Both expose two
independent key/value stores. Neither store has a scope column.

| Store | Contents | Logout |
| --- | --- | --- |
| `preferences` | User settings: language, theme, notification enablement, sound, preview mode, alert policy, appearance, transfer, layout, debug, emoji recents | Kept |
| `app_state` | Installation and login metadata listed below | Login keys cleared only by the cleanup described below; settings are never cleared here |

`app_state` keys:

| Key | Meaning |
| --- | --- |
| `schemaVersion` | Version of this app-state layout. Native SQLite uses this key, not a second `user_version` authority. |
| `loginState` | Login lifecycle: `signed-out`, `active`, or `cleaning`. |
| `sessionUuid` | Login identity written with `active`. Removed only when cleanup finishes and the state becomes `signed-out`. |
| `cacheRebuild` | Existing `pending` / `attempted` recovery marker. Own key, not a field of a session record. |
| `forwardRecentThreads` | Recent forwarding targets. Kept across restart, removed on explicit logout. |
| `pushDeviceId` | Installation push identity. Not removed because a login ended. |
| `pushRegistration:<origin><apiPrefix>` | Existing push checkpoint. Not a user setting. |

Remote conversation settings (`muted`, `pinned`, `alias`) stay in their domain
caches. They are not copied into either store.

## Confidential storage

Secure storage holds the session token and the same `sessionUuid`. It does not
hold a credential fingerprint, user id, or server session id.

Startup admits business work only when `loginState` is `active`, both UUID
copies exist and are equal, and the token exists. Any other combination is not
admitted. Storage read failure is an error, not a change of `loginState`.

The login request itself does not carry or check this UUID. Its success path is
what writes `active` and the UUID. Business work started after that write
captures the UUID and is cancelled unless the state is still `active` with the
same UUID. `signed-out` and `cleaning` both cancel that work.

## Login lifecycle

`loginState` is the login lifecycle. It has three values and no `revoking`
value:

| State | Meaning |
| --- | --- |
| `signed-out` | Logged out. No admitted session. |
| `active` | Login succeeded. Token and UUID are present. Restart restores this login. |
| `cleaning` | Local evidence deletion is in progress. |

The user decision after a timed-out logout is not a fourth state. It either
leaves the lifecycle at `active`, or moves it to `cleaning`.

- Server logout confirmed, or the user explicitly chooses to delete local
  evidence: write `cleaning` first, then delete the token, the secure-store
  UUID, and the local login cache. Remove `sessionUuid` and write `signed-out`
  only after that deletion finishes.
- User declines local deletion: state stays `active`.
- Restart in `cleaning` resumes local deletion only. It does not call the server
  logout endpoint again.
- Restart in `active` is still logged in. Restart in `signed-out` is logged out.
- App settings and server-owned settings are not part of cleanup.

Deletion is not one transaction. `cleaning` is what makes a partial deletion
retryable, and it is entered only after logout was confirmed or the user chose
local deletion.

## Cache identity

The login cache name is fixed: browser IndexedDB `soms-session`, native
`soms-session.sqlite` plus its WAL/SHM companions. Login UUID selects the
generation of in-flight work; it is not part of the cache filename.

Because every login reuses that cache, stale writes must be rejected by the
captured UUID and by the existing cache teardown fence. File-name isolation is
not available.

One-time migration may copy an existing `soms-session-<uuid>` cache into the
fixed name. It must not keep the old name as another login record. Pending
sends in the adopted cache are retained until an explicit logout cleanup.

## Preference migration

IndexedDB upgrades from the scoped `preferences` object store. Native SQLite
rebuilds `client_preferences` without `scope` and creates `app_state` in the
same transaction.

Known keys keep their current authority instead of the newer timestamp:

- `language` and `theme` come from `global`.
- Notification enablement, sound, and preview mode come from `device`. If both
  scopes exist and disagree, keep the stricter value (`false`, or preview
  `private`).
- Other device settings move under the same key with the scope prefix removed.
- `soms.lastUserId`, credential fingerprints, and login journals are not copied
  into `preferences`. A restorable journal UUID may seed `sessionUuid` only when
  its paired token is still present.

An interrupted migration must not clear a hidden preview, disabled
notifications, or muted sound, and must not report a storage failure as a
missing setting.
