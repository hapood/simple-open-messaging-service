# Local Account State Storage Contract

Status: first-round review contract; runtime integration is incomplete.

## Layout and ownership

Web uses one fixed `accountState` record, keyed by the constant `account` in each
login-session IndexedDB. Native uses one `account_state` row per `user_id` in
SQLite. Cache resource selection belongs to the login-session owner, not this
record. Both expose the `AccountState` shape; the schema version remains 1. There is no
metadata dictionary, sync-state KV, request-record cache, or account_meta table.
No old-layout migration or compatibility reader is provided.

Fields:

| Field | Representation and owner |
| --- | --- |
| schemaVersion | Literal 1 |
| selfProfile | Typed profile or null; self-profile writer |
| selfIdentity | Typed account identity or null; written atomically with profile |
| composerDrafts | Typed array; draft writer |
| threadFeedCursor | Existing integer cursor or null; ThreadFeed executor |
| stateFeedId | Existing integer cursor or null; StateFeed executor |
| stateFeedFullThrough | Recovery boundary or null; StateFeed executor |
| profileNamespaceChangeEndId | Existing integer cursor or null; namespace executor |
| intentRequestEndId | Server-confirmed incoming request head or null; StateFeed executor |
| intentRequestReadId | Server-confirmed read head or null; StateFeed executor |
| intentRequestOptimisticReadId | Pending local received-request read target or null |

Request coordinates are decimal strings in JavaScript and IPC JSON, and signed
64-bit integers in Rust/SQLite. Null is unobserved, not a fabricated server head.
Confirmed end/read coordinates are either both null or both nonnegative with
read <= end. No SENT coordinates exist.

## Storage and IPC methods

The shared interfaces are defined in
[account-state-ipc.ts](../../shared/account-state-ipc.ts), with field types in
[account-state.ts](../../shared/account-state.ts).

| Storage method | Native command | Arguments | Result |
| --- | --- | --- | --- |
| initializeAccountState | native_db_initialize_account_state | userId | void |
| readAccountState | native_db_read_account_state | userId | AccountState |
| writeSelfProfile | native_db_write_self_profile | userId, profile | void |
| writeComposerDrafts | native_db_write_composer_drafts | userId, drafts | void |
| advanceIntentRequestRead | native_db_advance_intent_request_read | userId, observedEndId | AccountState |

Initialization is explicit and idempotent. It does not fetch data or mark anything
read. Browser schema creation initializes the record; native initialization must
be called by the account owner before strict reads or writes. Reads never create
or repair state. Missing/unreadable state rejects instead of returning empty data.

Each writer updates only its owned fields. Profile and identity update together.
Optimistic read intent advances monotonically from an end ID observed in a
successful RECEIVED page. This storage operation performs no HTTP submission and
never advances confirmed heads or feed cursors. StateFeed confirmation clears
only optimistic intent covered by the confirmed read ID, in the same transaction
as its complete server head and cursor. A target may be ahead of the stored feed
head when the online page arrived first.

Storage failures reject. Rust commands use the existing account-cache lifetime
executor; Web uses account operation guards. Epoch invalidation and concurrent
account-switch behavior must be verified when callers are integrated. These
commands do not authorize access to another account or replace session ownership.
Message-cache metadata, preferences, credentials, and session state remain separate.

## ID boundary rules

Ordinary request IDs are opaque operation/page tokens in the client. Do not
revalidate them in every UI, HTTP, or storage call, and do not convert to Number.
Head decoding validates untrusted wire shape and canonical decimal coordinates.
SQLite conversion is an explicit lossless boundary operation. BigInt comparison
is used only for notification/read watermark ordering, not lifecycle decisions.
The server validates action tokens and owns request-round semantics.

## Remaining implementation and verification

The commands and shared argument/result contracts are registered, including the
Tauri permissions. Profile/draft callers now use the fixed record. Web spec type
checking passes and Rust library tests pass (144 tests). This does not establish
complete runtime integration: the Web received-read signal currently publishes
before persistence, lacks restoration/reset with account state, and has no
persistent retry loop. Monotonic publication, session ownership, confirmation,
and restart/retry behavior must be completed before this feature is runnable.
Native initialization and session-race behavior also require dedicated coverage.
Browser and native fixtures must exercise fresh layout creation, field ownership
under concurrent writers, bigint IPC precision, strict missing-record errors,
restart, and account invalidation. Passing command registration or compilation
does not establish these behavior guarantees.
