# Client Preferences and State Ownership

Status: audited design; storage changes are not implemented.

Audit date: 2026-11-20. Findings describe the working tree, including concurrent
session-lifecycle work, rather than only the committed revision.

## Decision and scope

User-configurable local preferences have one application-wide scope: `global`.
There is no current requirement for device-versus-global preference inheritance
or account-specific overrides. Do not retain those options for hypothetical
future use.

`global` means local to this client installation/browser storage origin. It does
not mean cloud-backed, shared between devices, or shared between installations.
Logging in or out must not reset these preferences.

This decision does **not** make every record currently in the preference store a
global preference. That store also contains session journals, account history,
recovery markers, and push-registration checkpoints. Move those records to their
own typed domain stores before removing the old scope API. Never replace all
`device` and `account:*` strings with `global` mechanically.

This document records the inventory and target ownership. It does not authorize
changes to the concurrently maintained logout/recovery state machines. Native
notification formatting is a separate implementation in progress.

## Current storage

- [PreferenceStorage](../../web/src/app/services/preference-storage.ts) accepts
  `global`, `device`, and `account:${number}`. Browser persistence uses the
  `soms-client-preferences` IndexedDB, a `preferences` object store, and an ID
  composed from scope and key.
- Native preference IPC forwards both strings unchanged to
  [preferences.rs](../../src-tauri/src/native_db/preferences.rs).
- [DeviceConnection](../../src-tauri/src/native_db/device_connection.rs) creates
  `client_preferences(scope, key, value_json, updated_at)` with `(scope, key)` as
  the primary key. Physical connection ownership is independent of record scope.
  Removing `device` as a preference scope does not imply removing or renaming
  this process-scoped connection owner.
- A scope is a lookup namespace, not authorization, replication, encryption, or
  an account-lifecycle boundary. In particular, `account:<userId>` alone does
  not identify an account across multiple servers.
- Native and browser session journals currently reuse the preference store.
  Their stricter durability and validation contracts must survive separation.

## Audited inventory

### Local application preferences

All entries in this table belong to the global preference store. Their values
are local-authoritative and should survive account changes and logout.

| Key | Current scope | Current consumers / writers | Target |
| --- | --- | --- | --- |
| `language` | `global` | `language.service.ts`, push/state workers, native notification copy | Global language choice |
| `theme` | `global` in production UI | `theme.service.ts`, `theme-bootstrap.ts` | Global theme choice |
| `notificationEnabled` | `device` | `notification-prefs.service.ts`, push/request notification projection, native preferences | Global notification enablement |
| `notificationSound` | `device` | Same notification consumers | Global sound preference |
| `notificationPreviewMode` | `device` | Same consumers; Android `ClientStateDb` via Rust bridge | Global privacy preference; preserve `private` exactly |
| `notificationAlertPolicy` | `device` | Push worker, native runtime/desktop alert policy, Android `ClientStateDb` | Global alert preference; move storage only, not alert semantics |
| `soms.chat.showSelfAvatar` | `device` | `chat-appearance.service.ts` | Global appearance preference |
| `soms.maxConcurrentUploads` | `device` | `attachment-upload-queue.service.ts` | Global transfer preference |
| `soms.client.listWidth` | `device` | `home-shell.component.ts` | Global layout preference |
| `soms-debug` | `device` | `debug-tools.service.ts` | Global local debug preference |
| `soms.chat.emojiRecents` | `device` in active chat input | `chat-input.component.ts` | Global local UI history; no account/message identity |

Consumer paths above are relative to `web/src/app/services/`, except components,
workers, and the explicitly named native consumers. Related implementation:
[notification preferences](../../web/src/app/services/notification-prefs.service.ts),
[Android preference bridge](../../src-tauri/gen/android/app/src/main/java/com/soms/client/ClientStateDb.kt),
[push worker](../../web/src/push/push-worker.ts).

Two concrete inconsistencies were found:

1. The UI writes/restores `global/language`; native notification code originally
   read `device/language`. The notification work has started correcting that
   reader. This is a wrong-namespace read, not evidence that two independent
   language settings are needed.
2. Active emoji-history writes use `device`, but
   [UserService.clearSessionPreferences](../../web/src/app/services/user.service.ts)
   removes `account:<userId>/soms.chat.emojiRecents`. That removal does not target
   the active history. Under the global decision, logout should not remove this
   history. Coordinate removal of the obsolete cleanup with the logout owner.

Some tests store `device/theme` or account-scoped emoji history. Those fixtures
must not be mistaken for a current product requirement.

### Internal state currently stored as preferences

| Key | Current location | Actual owner / required target |
| --- | --- | --- |
| `soms.login-session.v1` | Browser `device` | Typed browser session journal; outside disposable account cache |
| `soms.native-login-session.v1` | Native `device` | Rust session journal; preserve transactional transitions and pending cleanup |
| `soms.lastUserId` | `device` | Session/cache-selection metadata; not an independent user preference |
| `soms.cacheRebuild` | `account:<userId>` | Typed cache-recovery state outside the cache it may need to rebuild |
| `forward-recent-threads` | `account:<userId>` | Account-local forwarding history with validated account/resource identity |
| `device_id` | Browser `device` | Local push installation identity; not a configurable setting |
| `push-registration:<origin><apiPrefix>` | `device` | Push-registration checkpoint, including session/revision ownership |

Sources:
[session-store.ts](../../web/src/app/services/session/session-store.ts),
[login_session_store.rs](../../src-tauri/src/login_session_store.rs),
[user.service.ts](../../web/src/app/services/user.service.ts),
[forward-recent-targets.service.ts](../../web/src/app/services/forward-recent-targets.service.ts),
[web-push.service.ts](../../web/src/app/services/web-push.service.ts),
[push-registration.service.ts](../../web/src/app/services/push-registration.service.ts).

Separation requirements:

- Preserve strict journal reads: storage failure is not signed-out/absent state.
- Do not put recovery markers inside the potentially damaged cache. Keep their
  `pending`/`attempted` semantics and bounded recovery behavior unchanged.
- Do not copy the last user ID into a global option and let it independently
  authorize cache selection. Integrate with the existing session owner.
- Forward-history isolation uses the current session owner's validated lifetime
  and reset boundary, not added multi-account identity columns. Thread IDs alone
  must never authorize reuse after account replacement. Whether history survives
  a fresh login is a separate retention decision to confirm before implementation;
  the current service intentionally stores it outside the signed-in message cache.
- Push installation identity and per-session registration checkpoints have
  different lifetimes. Do not delete installation identity simply because a
  session checkpoint is retired. Preserve existing checkpoint locking,
  generation checks, and cleanup behavior.
- Logical separation does not require one database file per domain. Dedicated
  typed tables/object stores may share an existing safely owned connection.
- Native business decisions stay in Rust; platform adapters must not acquire a
  new preference/state authority during this cleanup.

## Remote settings: authority and local persistence

Remote-authoritative data is not stored in `global` preferences or a generic
`account:*` preference bag. Persist it in the owning account domain's existing
cache and expose it through that domain's typed API.

Existing examples are conversation `muted`, `pinned`, and `alias`. They have
server mutation endpoints and local thread projections:
[message controller](../../src/controller/message.controller.ts),
[message service](../../web/src/app/services/message.service.ts),
[thread store](../../web/src/app/services/thread-store.service.ts), and
[native thread store](../../src-tauri/src/native_db/thread_store.rs).
Do not replace these with local preference keys or add a second authority.

For any future remote option:

1. Define its domain, server authority, account identity, validation, defaults,
   and existing synchronization contract first.
2. Reuse the account-owned cache lifetime and the applicable server feed/revision
   ordering. Do not invent a generic settings synchronization service for fields
   already owned by another domain.
3. Read the confirmed cached value offline. If not yet observed, represent that
   state explicitly unless the domain contract defines a safe default. Missing
   cache must not publish a fabricated default back to the server.
4. Submit changes through the domain endpoint. Apply confirmations according to
   that domain's existing response/feed contract. A successful HTTP response must
   not manufacture or advance a feed cursor.
5. If optimistic or offline editing is required, model pending intent separately
   from confirmed server state, with retry, conflict, and cancellation rules.
   It is not implemented by writing a global preference and hoping to sync later.
6. Reject asynchronous results from a superseded session. Server/account resource
   identity is provided by the session owner, not by an arbitrary caller's ID.
7. Logout removes/releases domain data according to session policy; it does not
   reset installation-wide global preferences.

There is no evidence from this preference-store audit that a generic remote
user-settings subsystem is required now. New fields should be designed when a
concrete product requirement exists.

### Local policy versus remote policy

Global notification enablement/sound/privacy and server-owned conversation mute
are different inputs. They are not competing copies of one setting. Shared Rust
notification policy combines them using the established rules. Storage cleanup
must not change unread counts, mention semantics, notification targets, click
routing, mute behavior, or alert timing.

## Single-account table layout

The current product supports one active account. Do not introduce multi-account
rows, account ID columns, or an account selector into these local stores for
hypothetical future support. A future multi-account release must design its own
explicit storage transition.

The target layout separates responsibilities without a `scope` column:

| Store / table | Responsibility |
| --- | --- |
| `client_preferences` | Global local options, keyed by `key`; no scope column |
| `account_local_state` | One current-account local record; recent forwarding targets and typed push-registration checkpoint fields; no account identity column |
| `login_session_state` | One durable login lifecycle record: phase, current login UUID, credential fingerprint where applicable, and pending cleanup descriptors |
| `cache_recovery_state` | Proposed dedicated recovery-control record outside the disposable cache; only if the existing rebuild control is retained |

`account_local_state` is distinct from the existing synchronized `account_state`
record. It must not turn that record into an arbitrary metadata dictionary. Its
fields are typed, not a new scoped key/value preference bag. A singleton key, if
needed by the database, is a structural constant rather than an account ID.
Push registration still retains its necessary session/revision checkpoint
coordinates; "no account identity column" does not mean removing those protocol
coordinates or the checks against the current session owner.

The session owner must reset/replace the singleton account-local record at an
account replacement boundary before the successor can use it. Outstanding writes
must be checked against the captured login generation. A single active account
simplifies cardinality, but does not eliminate old asynchronous work. This
lifecycle integration must be coordinated with the logout owner rather than
implemented as an independent state machine. Forward-history retention across a
fresh login remains a decision gate; do not silently carry thread IDs into an
unrelated account.

### Why retain the login UUID?

The UUID is not a multi-account feature or a server user ID. Existing code uses it
as the immutable identity of one local login lifetime and to derive the native
SQLite filename / browser IndexedDB name. It rejects stale asynchronous results
and identifies exactly which retired cache resources remain to be deleted after
a crash. Logging out and logging in again to the same account creates different
lifetimes; ordinary restart restoration preserves the existing lifetime.

Retain this UUID when moving the journal into `login_session_state`. Renaming
`Journal` to describe state more clearly does not justify removing its identity,
transaction semantics, or pending cleanup data. Ordinary diagnostic login logs
may go to log files, but those files are not a replacement for this state table.

Implementation handoff: preserve the current UUID/fingerprint binding protocol.
Do not bundle a secure-store `{session_uuid, token}` redesign or fingerprint
removal into the table split. That alternative was discussed but not approved.

### What cache recovery currently means

The audited `soms.cacheRebuild` marker is currently a preference, not a dedicated
recovery table. Its `pending`/`attempted` values request a reload/rebuild and prevent
an unbounded automatic rebuild loop. It does not hold backup messages and does
not restore a deleted message table from local copies.

Message storage already has dedicated tables. However, the current native
`recreate_cache_schema` operation in [native_db.rs](../../src-tauri/src/native_db.rs)
recreates the entire per-login cache schema, not only message rows. The source
explicitly states that this discards pending sends as well. Browser recovery
similarly calls the account-cache recreation API. Rebuilding permits subsequent
synchronization to repopulate server-backed data; it does not guarantee recovery
of unsent/local-only data.

Dedicated message tables and a dedicated recovery-control table solve different
problems. The latter must live outside the database being rebuilt so its attempt
marker survives. This document proposes a place for the existing control state;
it does not approve broadening cache deletion or introduce a new recovery
algorithm. Whether full-cache rebuilding remains the desired product policy must
be reviewed with the cache/session owner before moving or removing the marker.

## Target preference API

Once internal state is separated, expose key-based global preference operations:
`get(key)`, `getStrict(key)`, `set(key, value)`, and `remove(key)`. Remove caller-
selected scope from TypeScript and preference IPC. Do not leave a union containing
unused `device`/`account:*` cases or a constant scope argument every caller must
repeat.

The final store should be keyed by preference key, with validated values for
registered settings. Reserve no public escape hatch for session journals,
credentials, domain caches, or arbitrary account metadata. Lifecycle-sensitive
state uses its domain API rather than relying on `getStrict` of a generic setting.

This is a target contract, not the current implemented IPC/schema.

## Transition and collaboration gates

1. Agree on this ownership inventory and confirm forward-history retention.
2. Have the session/logout owner own journal, cache-selection, and recovery-state
   relocation. Preserve existing state machines; do not duplicate them here.
3. Separate push state and forwarding history into their domain stores with
   focused isolation/lifecycle tests.
4. Move local options to the one global API together with all readers, including
   background workers, Rust, and the Android Rust preference bridge.
5. Remove obsolete scope declarations, SQL/IDB scope keys, old IPC parameters,
   stale cleanup, fixtures, and compatibility paths once no live users remain.

No permanent dual reads, dual writes, or old-code fallback are part of the target.
However, deleting old data blindly is not an acceptable substitute for preserving
privacy and session safety. Before deployment, select an explicit one-time
storage transition or an explicitly authorized reset policy. A transition must
preserve hidden-preview, disabled-notification, and muted-sound choices; never
silently restore message previews because the key moved. Session journal data
must never be discarded by a preference schema cleanup. If old and new preference
records conflict, define and test the precedence before shipping rather than
assuming that the less restrictive value wins.

Native SQLite and browser IndexedDB upgrades require separate atomicity and
restart tests. This document does not introduce a backend database migration.
Existing physical device-connection ownership must remain intact.

## Required verification

- All local option readers/writers, including background-only native execution,
  agree on the same key and persisted value.
- Language restoration and explicit selection drive the same native copy;
  global preferences survive logout/account changes.
- Hidden preview, disabled notifications, and disabled sound remain protected
  through storage transition and restart, including interrupted transitions.
- No account, server, or login-generation cross-talk in forwarding, recovery,
  session selection, or push checkpoints; stale async writes are rejected.
- Journal and recovery storage errors remain errors, not empty/default state.
- Remote values follow existing revision/feed rules, retain offline confirmed
  state, and never advance cursors from an unrelated settings write.
- Removing scope support leaves no production caller or SQL query depending on
  `device`/`account:*` preference records. Test fixtures reflect actual ownership.
- Notification content tests separately verify the confirmed body contract:
  always show exact count (including one and values above 99), localize the unit,
  derive `[@]` from unread mention state, use only the latest unread summary,
  include the latest sender for groups, and hide sender/text in private mode.
  Retraction/removal/unknown/empty previews must never expose original text.

## Delivery status

This deliverable is the design and audited inventory only. No scope consolidation,
internal-state relocation, remote-option subsystem, or storage transition has
been implemented by this document task. No runtime test result is claimed.
Notification formatting is tracked separately in
[native-notification-content.md](native-notification-content.md), including its
implementation and validation boundaries. This document is not a completion
report for the preference/state storage refactor.
