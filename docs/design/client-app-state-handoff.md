# Client storage and login lifecycle: handoff

Status: work in progress, uncommitted on `dev`. The native library compiles. Native tests do
not compile. Web code is only partly wired. `client-preferences-and-state-ownership.md` in the
same directory is outdated and must be rewritten to this model.

## Confirmed decisions

- Single user. No multi-account, no account selector.
- No migration of old data. Schema version is 1. Old records are not read: a missing table is
  created, the old scoped table is dropped, and `app_state` without this version is cleared.
- Two key/value stores in one database file. Values are JSON.
  - `settings`: user settings only, keyed by `key`. No scope column. Never changed by logout.
  - `app_state`: installation and lifecycle records.
  - Native: the device database (`soms-local.sqlite3`). Web: IndexedDB, new layout not built yet.
- `app_state` keys: `schemaVersion`, `lifecycleState`, `sessionUuid`, `serverConfig`,
  `cacheRebuild`, `forwardRecentThreads`, `pushDeviceId`,
  `pushRegistration:<origin><apiPrefix>`.
  - `serverConfig` is one value holding the server origins and the public Firebase config. It
    belongs to server setup, is written before any login, and is kept on logout.
  - `forwardRecentThreads` is removed on explicit logout. `pushDeviceId` survives logout.
- Lifecycle, the durable part:
  `unconfigured` (no server configured) → `signed-out` → `active` → `cleaning` → `signed-out`.
  - Signing in is memory-only and is never a stored value. A process that dies mid-login next
    starts signed out.
  - Table checks and table creation are an independent step at start, not a lifecycle state.
  - Server setup is allowed only from `unconfigured` or `signed-out`. It is kept out of login
    by the existing in-memory `AuthLifecycle`, which stays as it is and is not persisted.
  - A committed server configuration moves the state to `signed-out`.
- Secure storage holds one pair: the token and the `sessionUuid` it was saved with, written and
  deleted together. A login is restored only while the state is `active` and both UUIDs are
  equal. A token without its UUID is residue, not a credential. A storage read failure is an
  error, never "logged out".
- In-flight work captures the UUID and is cancelled unless the state is still `active` with the
  same UUID. The login completion path is exempt: it is what writes the UUID.
- Logout stores nothing while the user decides. A confirmed server logout, or an explicit choice
  to delete local evidence, moves the state to `cleaning`; deletion then removes the pair and the
  cache and ends at `signed-out`. If the user declines, the login stays `active`. A restart in
  `cleaning` resumes local deletion only and never calls the server. A restart during the
  decision is still logged in.
- Cache name is fixed: IndexedDB `soms-session`, native `soms-session.sqlite`. Decided, not
  implemented.
- Deleted without replacement: `soms.lastUserId`, `account:*` keys, the credential fingerprint,
  the pending-cleanup list, the stored `preparing` / `revoking` / `ending` phases, `PreferenceScope`
  on the web, the scope argument of the preference commands. No compatibility layers.
- `cacheRebuild` keeps its `pending` / `attempted` meaning as its own `app_state` key.
- Firebase public config is not secret. Kotlin reads it through Rust; Rust owns the decisions.
- Notification body and presentation belong to another session. Do not change them.

## What is in the working tree now

Committed in `43a3193c` and superseded: an earlier partial step that rebuilt the scoped table
outside a transaction and dropped `device_id` and push checkpoints. The uncommitted changes
below replace its storage part.

Native, done and compiling (`cargo check --lib` has no errors):

- `src-tauri/src/native_db/app_state.rs`: key/value helpers and the key names.
- `src-tauri/src/native_db/device_connection.rs`: the start check in one transaction. It creates
  `settings` and `app_state`, drops `client_preferences`, and clears an unversioned `app_state`.
  Three tests were added.
- `src-tauri/src/native_db/preferences.rs` and five test fixtures: SQL now targets `settings`.
- `src-tauri/src/login_session_store.rs`: rewritten. `LifecycleState`, `LoginRecord`, and
  `SessionStore::{initialize, read, activate, begin_cleaning, finish_cleaning, restore}`. The old
  journal, fingerprint and pending-cleanup list are gone. `read` fails when the record is missing
  or inconsistent. `activate` also admits from `unconfigured`; tighten this if Rust should
  refuse a login before a server exists.
- `src-tauri/src/native_db.rs`: `initialize_preferences` now runs the start check and establishes
  the lifecycle. Added `record_server_configured`, `resume_local_cleanup` and
  `delete_login_cache_files`. `end_login_durable` ends the login, records `cleaning`, deletes the
  cache and ends at `signed-out`; a login that never completed only releases its preparation.
  `prepare_fresh_login(preferences, guard)` stores no preparation and reuses this process's
  installed owner while signed out. `restore_login_credential` and
  `reconcile_cold_start_credential` take the UUID next to the token.
- `src-tauri/src/native_logout.rs`: no persisted revoking. Cleanup is `begin_cleaning`, platform
  cleanup, cache deletion, `finish_cleaning`.
- `src-tauri/src/origin_commands.rs`: `set_session_token` calls `activate(conn, &id)`;
  `login_session_for_token(token, session_uuid)`.
- `src-tauri/src/secure_storage.rs`: a second keyring entry `soms/session-uuid` and a
  `secure_get_session_uuid` command. This is temporary; see step 1.
- `src-tauri/src/server_setup.rs`: `has_persisted_configuration`; the commit command records
  `signed-out`. `src-tauri/src/native_db/location.rs`: `directory()` is `pub(crate)`.
- `src-tauri/src/lib.rs`: registers the command above and calls `resume_local_cleanup` at start.
- `src-tauri/src/android_runtime.rs`: `initializeRuntime` receives the login UUID next to the
  token and resumes cleanup at start.
- Kotlin: `RustRuntimeBridge.kt` passes `getLoginSessionId`; `MainActivity.kt` exposes a
  `getLoginSessionId()` bridge method.

Native, not done:

- Tests do not compile. `cargo check --tests` reports errors in `native_db.rs` (about 67; the
  login cache tests still use the journal API), in the `login_session_store.rs` tests (they pass
  `Some(..)` to `restore`), in `secure_storage.rs` tests, and in `origin_commands.rs` tests.
- Two warnings: `token` is unused in `login_session_for_token`, and `end_login_connection`
  (`native_db.rs:310`) is unused. Delete or use them.
- Cache files are still named `soms-session-<uuid>.sqlite`. A login interrupted before
  completion leaves such a file behind until step 3.
- There is no `app_state` command for the renderer yet. The Linux notification registry
  (`linux-message-notifications`) is still written through the settings command.
- `serverConfig` is not in `app_state`; the server configuration is still the
  `server_origins.json` file.

Web:

- `runtime.ts` has the `getLoginSessionId` type. `auth.service.ts` passes the token and the UUID
  to `login_session_for_token`, and the UUID is still typed `string | null`.
- Nothing else changed. `preference-storage.ts` still sends a scope, which native now ignores.
  IndexedDB still has the old layout. `session-store.ts` is still the browser journal.
- `user.service.ts` still uses `soms.lastUserId`.
- Specs that still expect the old commands: `auth.service.native.spec.ts` (lines 99, 106, 450,
  456, 492, 735, 751) and `session/browser-auth.integration.spec.ts` (line 227).

`src-tauri/src/native_db/mentions.rs` has uncommitted changes from another session. Do not
touch it.

## Next steps, in order

1. Make the credential one pair.
   - Desktop: keep the pair in the single `soms/session` keyring entry as
     `{token, sessionUuid}`. Replace `secure_get_token` and `secure_get_session_uuid` with one
     `secure_get_login` command that returns the pair or nothing. An entry that is not a complete
     pair is removed and reported as absent.
   - Update the handler list in `lib.rs` and `permissions/app-commands.toml`
     (`allow-secure-get-token` becomes `allow-secure-get-login`). Check any capability that names
     the permission. `src-tauri/gen/schemas/*.json` are generated files.
   - Rust: `login_session_for_token(token, session_uuid: String)`,
     `SessionStore::restore(conn, &str)`, `restore_login_credential(token, &str)`,
     `reconcile_cold_start_credential(Option<(&str, &str)>)`.
   - Web: `restoreNativeSession(credential, work)` with `{token, sessionUuid}`. On Android
     restore only when both are present, otherwise call `discardResidualNativeToken()`. On
     desktop read the pair with `secure_get_login`.
   - Update the two specs.
2. Make the native tests compile and pass. Rewrite the login cache tests in `native_db.rs` for
   the lifecycle. Cover: restart restores only the matching pair; a rejected credential deletes
   the cache and ends at `signed-out`; an interrupted logout before the decision stays `active`;
   `cleaning` resumes at start; a fresh login over an admitted login passes through `cleaning`;
   a failed cache deletion leaves `cleaning`. Tests reset state by writing `lifecycleState` and
   `sessionUuid` in `app_state` directly.
3. Fixed cache name. Delete unreferenced `soms-session-<uuid>.sqlite*` files. Native tests share
   one directory, so they need isolation or serialization before they share one cache file.
4. Add the `app_state` commands for the renderer. `lifecycleState` and `sessionUuid` are written
   by Rust only. Move the notification registry and `serverConfig`, including the Firebase
   config, into `app_state`. Kotlin reads the Firebase config through Rust.
5. Web: the new IndexedDB layout with `settings` and `app_state`; remove `PreferenceScope` and
   the scope argument in every caller and in the two workers; replace `session-store.ts` and
   `browser-session-owner.ts`; remove `soms.lastUserId` from `user.service.ts` and move
   `cacheRebuild` to `app_state`; clear `forwardRecentThreads` on logout; update `webdb-storage`,
   the forward-recent and push services, and the specs.
6. Rewrite `client-preferences-and-state-ownership.md` to this model.
7. Verify and report: `cd src-tauri && cargo test`, the web unit tests, and both builds.

## Hazards

- Other sessions commit the whole tree. `43a3193c` swept an earlier partial step into `dev`.
  The tree is mid-change now: the native library compiles and the native tests do not. Finish
  step 2 before letting it be committed.
- By the decision not to migrate, a device upgrading from the previous build starts with default
  settings, including notification preview mode, and is signed out. The server configuration
  file is separate and is kept, so the user only logs in again. The push installation ID is
  created anew.
- The old login caches on such a device stay on disk until step 3.

## Commands

```sh
cd src-tauri && cargo check --lib
cd src-tauri && cargo check --tests
cd src-tauri && cargo test --lib -- login_session_store:: device_connection::
```
