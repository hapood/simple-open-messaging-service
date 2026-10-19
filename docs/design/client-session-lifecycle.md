# Client login-session lifecycle

Status: accepted target design; implementation is not complete.

## Implementation status

Browser authentication, restoration, logout and push-worker admission use the
UUID journal and session-owned IndexedDB names. Browser fresh-login preparation
performs deferred deletion before sending authentication requests. Restoration
requires a durable recoverable journal: a residual cookie without one records a
signed-out state and releases resources without minting a UUID, adopting unknown
caches or deleting files. Explicit authentication remains possible afterward.
The renderer's
lifecycle mirror now captures cancellable work scopes carrying the host-supplied
UUID instead of generating numeric login epochs. Native admitted-work migration
is not complete.

Renderer authentication carries an immutable operation context instead of reading
a mutable pending UUID when a response arrives. Delayed HTTP responses, native
admission acknowledgments and restoration failures cannot publish renderer state
or start a later persistence/repair step for a successor. Thread-list reads carry
the original UUID work scope through asynchronous boundaries. Projection resets
within a login use separate cancellation, not another login counter. The unused
legacy resolution dispatcher has been removed. Native credential storage itself
still needs Rust owner-scoped admission; renderer checks do not make it atomic.

Native logout now releases the renderer's resources without deleting account
storage. Rust captures the ended bearer and origin before acknowledging logout;
only then does the Android adapter clear secure storage (which also clears the
Rust token). Rust starts a non-retrying, ten-second revocation attempt and exposes
a single-use operation ticket for waiting. The ticket is not a login UUID. A
silent-server transport test verifies actual socket cancellation on timeout.

Native persistent login metadata now exists in Rust: a device-scoped journal in
the preferences database records the login UUID, a credential fingerprint (never
the credential), and pending cache cleanup. Fresh-login preparation runs before
the authentication request: the renderer invokes `native_db_begin_login`, Rust drains
cache work, deletes retired per-login cache files, mints the UUID, and creates
the dedicated `soms-session-<uuid>.sqlite` cache file; cache schema metadata
lives inside that file. The native journal validates supplied UUIDs for activation
and logout, and a persisted credential whose login ended is discarded at
restoration instead of reviving the session. Runtime credential transitions are
strictly owner-scoped: setting and clearing a token requires the caller's login
UUID, and admission validates it against the active connection. Native cache
command admission captures the existing owner and its cancellable cache view
instead of a numeric login epoch. Fresh-login preparation is idempotent while
the journal holds an unactivated preparation: authentication retries and QR
polling reuse that UUID, its cache file and its installed physical connection
instead of minting a login per attempt; a retry after the connection was
released re-establishes the same file, and only an activated or ended login
runs the full boundary again.

UUID-named SQLite cache files are implemented: the shared preferences file keeps
only device/account preferences, and each login owns `soms-session-<uuid>.sqlite`
(retained at logout, deleted by the next fresh login). Legacy numeric admission
helpers and implicit cache-opening/current-path APIs have been removed. Schema
maintenance retains a plain read/write exclusion lock, without an epoch counter.

The Rust `LoginConnection` now owns an immutable UUID, one physical SQLite
connection, a credential and cancellation state. Shell and headless Android
initialization restore an existing cache connection; fresh-login preparation
installs a new owner only after releasing the old one. Repeated initialization
keeps the original connection. Validation and explicit schema repair capture the
owner before scheduling; repair retains the physical connection when present.
Missing files are created only by explicit repair or fresh preparation.

Activation permits survive asynchronous journal persistence and reject completion
after owner end. Token installation requires a UUID. Preparing connections admit
only explicit lifecycle schema access, not business reads. Renderer restoration
installs the recovered token before account-cache hydration, keeping its UI signed
out until hydration completes. Android bootstrap validates its stored token against
the journal. Logout ends and releases the captured connection without deleting it.

Local account-state, contact/profile, thread-list and profile-namespace commands,
plus pointwise message reads/writes and message counts, capture the active owner
before SQL scheduling and borrow its connection. These commands no longer open a
database or capture a numeric login epoch. Explicit cache/message repair and cache
clearing also retain the captured connection. SQL callbacks share a schema-maintenance
exclusion lock with explicit repair. Main-package tests use connection-local TEMP
state to prove reuse across initialization, repair and ordinary command execution.
A released old owner cannot remove a successor from the slot.

State-feed synchronization captures its owner and request context synchronously
before returning a future. Cursor reads, page commits and recovery commits retain
that owner across lane waits and HTTP. Its GET transport snapshots the credential,
clients and configured endpoint candidates; one reachability replay can select only
those candidates and never publishes a global origin change. Ending the owner
cancels the actual request, including a stalled response body. Socket tests verify
credential/endpoint isolation, local failover and transport cancellation.

Same-login schema repair has a separate cache-work cancellation domain, not a
second login identity or counter. Repair cancels old cache views while retaining
the UUID, credential and physical connection. Migrated local commands capture a
view before scheduling; state-feed and message history carry it across network
waits. A pre-repair page cannot commit into repaired tables. Ending a login cancels
every cache view.

Message-history intents capture their work, request and completion port together.
Bootstrap, directional/around reads, cursor recovery and page transactions never
reopen a database or reacquire the current login. Read-only POST query replay uses
the captured JSON body, credential and endpoint candidates. Cached-message writes
also retain their original work through commit and notification. Main-package
socket tests cover bootstrap/paging, cached around reads, cursor recovery, real
transport cancellation on end/repair, and invalid-page rollback. Queued history
and page commits cannot switch to an installed successor.

Native local completion ports now retain a captured cache view rather than a
numeric login epoch or a mutable global-token comparison. Every local completion
carries its original `loginSessionId`, including the state-feed SSE consumer.
Renderer completion admission rejects missing or mismatched UUIDs at delivery, so
an event already in the host queue cannot enter a same-account fresh login.
Realtime runs now bind one immutable login instead of numeric epochs and
global-token comparison. A run captures a cache view plus a request context
(credential, clients, endpoint candidates) at identity binding; connection
attempts, receipts, origin probing and publication all use that captured
context. Origin selection on a bound run is private: probes race only the
captured candidates and never publish global routing changes. Login end cancels
the stream through the owner's cancellation token; explicit lifecycle admission
(fresh login, restoration, deliberate repair) alone installs a new binding.

Android notification batches carry their assembling login's UUID instead of an
account epoch. Assembly runs through the captured cache view; batch delivery and
the queued platform actions re-check that UUID against the admitted owner. The
state-feed JNI envelope dropped its epoch echo; its worker already carries the
owner. Both native event adapters now forward the complete Rust envelope rather
than reconstructing a message from its type and data. Android live events,
HELLO replay, reconnect and force-logout commands retain `loginSessionId` through
JNI and WebView delivery. Background notification completion envelopes are also
serialized in Rust, not synthesized by Kotlin. The Android renderer checks its
captured UUID at delivery before publishing any event or acting on force logout;
missing or mismatched UUIDs are rejected without adopting the current identity.
Replay snapshots carry both the transport generation and a complete owned HELLO.
Main-package Rust tests, Angular bridge/storage tests and Android Rust/Kotlin
compilation cover these contracts; device instrumentation and on-device native
unit tests have been run and passed on arm64 hardware.

Thread-feed wakes now capture a `NativeThreadFeedIntent` before returning a
future. Its structural state-feed barrier, thread pages and Android notification
assembly share the exact cache view and request owner; none reacquires the run's
current binding after network waits. Cancellation releases a lane waiter even
while another task still holds the lane. Each blocking page task owns both its
transaction and publication port, so dropping its awaiter does not hide a page
that commits. Publication occurs after SQL and maintenance locks are released.
A state-feed-created account row with no thread cursor starts thread paging at
zero rather than failing on its nullable cursor.

Main-package regression tests cover delayed polling across end/repair, queued
page rejection, detached commit publication, actual socket cancellation during
a stalled response body, original endpoint/bearer retention across a structural
barrier and two thread pages, connection-local TEMP trigger evidence, and
preservation of an earlier committed cursor when a later page is invalid.

Profile materialization, group-meta drains and tombstone drains also use captured
cache views and request contexts rather than implicit cache opening. Dedicated
cross-network regression tests now cover them: a drain future first polled after
end or repair fails without touching any cache; a stalled Group Meta GET or
tombstone POST closes its actual socket; a page commit queued behind maintenance
rejects the superseded view without applying its roster, cursor, tomb or
high-water mark; the full Group Meta drain retains the original bearer, endpoint
and physical connection across pages, materializes referenced group and member
profiles through the same owner, and a failed profile reference cannot discard
already-committed pages; a tombstone drain commits its tombs and high-water mark
through the captured connection with the original bearer and endpoint.

Filesystem avatar reads and desktop notification scheduling no longer borrow a
dummy SQLite connection. They check their captured cache view before execution
and before returning a result, without holding SQL or maintenance locks across
platform operations. Tests cover admission rejection, result rejection after
end/repair, and independence from SQL/maintenance locks. These checks do not
cancel a platform side effect that has already started.

Global credential publication and platform secure-store writes are now
strictly owner-atomic:
- `set_session_token`, `clear_session_token`, desktop `secure_set_token` and
  `secure_clear_token` require the caller's login session UUID. Setting a
  credential validates that the active `LoginConnection` exists and matches the
  exact token; a mismatched token or obsolete UUID fails admission.
- Clearing a credential checks the UUID of the session being ended: if a successor
  login is already active, late clears from an earlier session are no-ops that
  never wipe the successor's token or keyring entry.
- Android's JNI `updateSessionToken` requires the session UUID and checks it
  against the active owner's credential via `update_session_token_admitted`.
  `SomsSecureStore` under its process monitor records `KEY_LOGIN_SESSION_ID`
  alongside the encrypted token, preventing delayed logout commands from wiping
  a successor login's Android credentials.
- Unowned residual credentials that fail restoration on cold start are purged
  only via dedicated `discardResidualToken` / `secure_clear_residual_token`
  entry points, which fail closed if any login session is active.

This is a partial integration, not complete native ownership.
Native voice/upload orchestration also remains outside the completed ownership
migration and requires a separate review of its desktop/mobile split.
These remaining areas must be resolved before connection isolation holds for all native work.

Device preferences and durable session metadata now share one physical
process-scoped `DeviceConnection`, explicitly initialized by the shell or
headless Android bootstrap. Repeated shell attachment does not reconnect.
Preference IPC commands and journal transitions capture this existing owner
before scheduling, then borrow its SQLite connection only for local work.
Uninitialized access fails rather than opening a database. Connection-local
TEMP state tests verify physical reuse, including concurrent initialization and
ordinary preference IPC.

## Purpose and related designs

Replace independent login/account epoch counters with one opaque local login
UUID and session-owned resources. This changes the representation of login
identity, not the requirement to reject obsolete asynchronous work.

This design refines [client session and realtime boundaries](client-session-realtime-boundaries.md)
and follows [shared Rust runtime ownership](native-client-runtime-boundaries.md).
Descriptions of account epochs in those documents describe existing mechanisms;
the target login-lifetime identity is the UUID defined here. Connection leases,
runtime-instance generations, task cancellation and protocol cursors remain
separate concepts.

## Accepted behavior

- A successful fresh login creates a new UUID, even for the same account.
- Refresh, process restart and credential restoration preserve that UUID and its
  cache. They are not fresh logins. Only client/server logout ends this identity.
- Physical cache deletion belongs exclusively to fresh-login preparation. Logout
  releases runtime resources and closes connections, but retains the old cache and
  its pending-cleanup descriptor. Deletion failure blocks the next authentication
  attempt and exposes retry; it does not prevent local logout.
- A logout API request has a bounded deadline, including queue waiting. Success,
  failure or timeout ends the local login; timeout aborts the actual transport.
- Browser operation remains single-active-document. Additional tabs wait before
  application bootstrap; they do not run separate accounts or share live stores.
- Local logout works offline. Server revocation is best effort, not a prerequisite
  for local invalidation.
- Drafts, outbox entries, uploads, calls and other unfinished session work are
  abandoned at logout and never resumed by another login. Their old persisted
  cache is deleted at fresh login, not necessarily at logout. A request already
  accepted by the server can still succeed.
- Only login-lifetime epochs are replaced. Independent ordering/cancellation
  mechanisms must not be removed merely because they use the word generation.

## Identity and authority

The UUID is an unguessable, locally generated resource identity, not an
authentication credential. It is distinct from server session IDs, user IDs,
origin IDs and authentication tokens. It must never authorize server requests.

A session descriptor contains a version, UUID, immutable database names and the
account/server identity established during authenticated initialization. Database
names are derived from the UUID, not selected by reading a mutable current user.
A descriptor must not contain plaintext credentials. Bindings are validated before
cache contents are exposed; a mismatched authenticated account cannot reuse it.

The browser has one session authority in the active document, backed by durable
metadata. Native clients have one Rust authority; the renderer receives a
credential-free mirror. Kotlin and other host adapters persist credentials and
execute OS operations, but do not decide session transitions. Headless native
work uses the same Rust authority as renderer calls.

The public current-session reference is either an active session or null. Internal
states include restoring, preparing, ending, cleanup-failed and signed-out. A
non-active state admits no authenticated business work. Consumers cannot mutate
the descriptor or publish authentication independently.

## Connection ownership

At application initialization, restore one physical cache connection for the
recoverable UUID, if any. A signed-out startup does not create a login cache.
Fresh-login preparation is the other initialization boundary: close the ended
connection, finish deferred cleanup, persist a new UUID, and initialize that
UUID's single connection. Authentication retries and QR polling reuse the
preparing connection rather than opening another one. Device preferences have
a separate process-scoped connection.

Capture the existing session `conn` when an operation's intent is created,
before scheduling or network I/O. Carry that same owner through requests,
transactions, retries and result publication. Ordinary operations cannot open
connections, resolve a current cache path, or obtain successor credentials.
Holding the owner across network I/O must not hold its database lock.

End is irreversible for that owner. Invalidate admission and capture its old
credential without waiting for database I/O. Drain and close the physical
connection before fresh-login cleanup; retained old references cannot reopen
it. A new login receives a new owner, never a rebound old object. Initialization
and publication of the process-wide current owner must themselves be serialized;
an abandoned initializer cannot replace a successor owner. The durable journal
remains necessary for restart recovery, independent of in-process cancellation.

## Durable recovery metadata

Keep device-level lifecycle metadata outside the deletable session database:

- the recoverable session descriptor and lifecycle phase;
- pending cache cleanup descriptors, including interrupted preparations;
- a durable local logout marker. Do not persist requests to revoke via whatever
  browser cookie a later login installs.

Persist preparation before creating a cache. Persist ending/logout intent before
reporting durable local logout completion. On restart, retain pending cleanup
without restoring an ended login or physically deleting its caches. Resume
cleanup only at fresh-login preparation. Track all orphan descriptors, not only one
previous UUID. Never clear a cleanup record before all of its owned stores have
been removed. Operations are idempotent and retryable after partial success.

If metadata cannot be persisted, invalidate the running session anyway, surface
the failure and block fresh activation. Do not claim durable logout succeeded.

Credential presence without recoverable local metadata does not authorize
restoration or creation of a replacement UUID. Do not infer a cache identity or
adopt an old layout. A fresh explicit authentication can create a new UUID only
after its required cleanup succeeds. An explicit logout marker always prevents
residual credentials from silently restoring the ended login.

## Transition ordering

### Fresh login

1. Serialize authentication transitions and reject duplicate submissions.
2. Invalidate any previous active identity and finish pending cleanup.
3. Complete authentication without exposing the returned credential to business
   consumers. Authentication requests have an explicit transition identity, not
   an arbitrary current authenticated session UUID.
4. Persist a preparing descriptor with a new UUID and create its dedicated cache.
5. Install credentials and initialize session resources under the owner. Keep
   business admission closed throughout preparation.
6. Durably publish the active descriptor, then expose the active session and
   start synchronization/navigation.

If authentication succeeds but preparation fails, keep the credential under the
preparing transition's ownership, not active. Retry preparation idempotently, or
explicitly end that transition and revoke/discard its credential. Never replay a
password login merely to retry database deletion. A failed or superseded
transition cannot publish an active session.

### Restore

Acquire browser document ownership first, then load lifecycle metadata and secure
credentials or cookie-backed login presence. Honor logout markers: an ended
session stays signed out and its databases remain pending until fresh login.
Restore the same active UUID/cache only after validating bindings
and initialization. A network failure is not evidence that the server logged out;
remain non-active/recoverable rather than deleting a valid session arbitrarily.
An authoritative revocation ends the session. WebView recreation does not end a
Rust-owned session or its calls.

### End session

1. Synchronously remove active publication/admission authority and reset the
   visible session state. Every old task immediately becomes obsolete.
2. Record durable ending intent with the old database descriptor. Stop scheduling
   and signal cancellation outside lifecycle locks. Release realtime, retry,
   media, notification and upload work.
3. Drain/exclude admitted local database operations and close owned connections.
   Do not delete IndexedDB databases or SQLite files. Keep them discoverable for
   cleanup at the next fresh login.
4. Attempt the logout API with captured old credentials and a deadline. This may
   run alongside resource release. Success, failure and timeout all finish local
   logout; timeout must abort the transport. Clear local credentials after the
   request has captured its old credential, independent of remote success.
5. Keep the ended UUID and pending database list in device metadata. A new login
   performs deletion once; neither logout nor restart repeats that work. Local
   metadata/resource failures remain visible and retryable, without reactivating
   the ended UUID.

The durable `ending` phase means that an ended session still has caches awaiting
fresh-login cleanup; it does not retain authentication or require the logout API
to remain in progress. Deferred deletion intentionally means logged-out cache
files may remain on disk. Do not claim physical erasure at logout.

A server logout request uses captured old credentials and a specific transition;
it must never clear or acquire a successor's credentials. New activation cannot
race an unresolved authentication-cookie mutation.

Offline browser logout cannot directly remove an httpOnly cookie. Persist the
local logout marker and deny authenticated business admission and restoration.
Fresh authentication replaces the cookie; it does not require a successful old
server logout or an extra cookie-clearing request. A late old logout response
must not clear a successor's cookie: serialize already-dispatched mutations,
abort on deadline, and discard an unissued logout after its deadline or successor
transition. Never replay a failed old logout with the new browser cookie.

## Work admission and publication

Work captures its owning UUID before enqueueing or asynchronous suspension. It
must not rebind itself by reading the latest current-session resource afterward.

- Authenticated HTTP binds its UUID at subscription/admission. Check before
  dispatch and before delivering either success or failure to business consumers.
- Native commands carry the UUID. Rust checks admission and resolves credentials
  and database handles from that owner before scheduling; queued old commands
  cannot acquire a replacement token or cache.
- SSE events, commit notifications, workers, notification actions, retries and
  delayed callbacks carry their source identity and validate before publication.
- Store publication after any later await needs another session-aware boundary;
  an HTTP interceptor alone cannot protect an entire asynchronous continuation.
- Old 401 responses never log out the new session. Session-superseded errors are
  typed control flow: no generic toast, account logout or automatic retry.

Cancel network work where useful, but correctness does not depend on successful
cancellation. Discarding a response does not roll back server side effects.

Identity comparison alone is not a database synchronization primitive. Bind
operations to immutable owner-specific handles and serialize database admission
with close/delete. A checked old UUID must not later resolve a current database.
No lifecycle lock is held across network or platform I/O. Already admitted local
transactions finish or abort against their original cache; teardown waits for
resource safety and never redirects them to a successor.

Same-login reconnects and renderer replacement still need runtime leases or
cancellation tokens; UUID equality does not establish which connection is newest.

## Single active browser document and workers

The existing [active-page lock](../../web/src/app/services/active-page.ts) wraps
[application bootstrap](../../web/src/main.ts). Keep its fail-closed behavior
without Web Locks, waiting-tab behavior and BFCache reacquisition. A failed
bootstrap retains ownership until document destruction to avoid live leftovers.

Service Workers do not hold that document lock. Their storage, push delivery and
notification handling must independently honor the durable session phase and
UUID. An old worker must not recreate an ended cache. A waiting tab may bootstrap
only after ownership transfers and must reread durable metadata, not cached
pre-wait identity. Existing feed/notification locks remain where they protect a
different resource; document exclusivity does not replace them.

## Migration

1. Introduce a credential-free UUID identity and testable lifecycle contracts.
   Inventory existing login epochs, persistence and native command entry points.
2. Implement durable descriptor/cleanup recovery and the browser authority;
   distinguish fresh login from restoration in all authentication paths.
3. Introduce the Rust authority, owner-specific SQLite lifecycle and credential
   admission. Connect desktop, Android and headless entry points to it.
4. Propagate UUID through HTTP, IPC, realtime, storage, notifications and workers.
   Remove replaced login counters only when every producer/consumer is migrated.
5. Remove compatibility paths and update existing ownership documents to describe
   implemented behavior. Do not declare completion with two independent authorities.

There is no compatibility path from pre-UUID cache layouts: this design shipped
in the alpha series, and alpha installs are not migrated. A pre-UUID install's
old cache files are left untouched (never read, never deleted by this client);
reinstalling or clearing application data removes them. Do not delete caches
merely because a valid session restarts.

## Verification gates

- Fresh same-account login gets a different UUID; ordinary restore retains it.
- Logout invalidates synchronously, closes runtime resources and retains physical
  caches. Remote failure is tolerated, and a deadline aborts the transport.
- Partial IndexedDB/SQLite deletion during fresh login survives restart and retries
  idempotently; new authentication stays blocked until cleanup succeeds. Merely
  restarting after logout does not perform deletion.
- Failed server logout does not add a cookie-clearing prerequisite to the next
  login. An expired queued logout is never dispatched later.
- Queued old native commands cannot use successor credentials or databases.
- Old HTTP success, errors and 401s cannot mutate successor state or log it out.
- A result delayed after an additional await cannot publish to a successor.
- Database admission versus close/delete is race-tested, including failed cleanup.
- Offline browser logout followed by refresh cannot restore via a residual cookie.
- Authentication success followed by cache failure retries initialization without
  issuing duplicate login requests or leaking a usable session.
- Waiting-tab takeover and BFCache restore preserve single ownership; worker push
  and notification callbacks reject an ended UUID and cannot reopen its cache.
- Native process restart and WebView recreation preserve the session appropriately;
  logout releases calls/media, and delayed adapter callbacks cannot affect a successor.
- Existing Angular dependency-graph, realtime and Rust lifecycle regressions pass.

Record exact executed checks separately. Unit tests do not establish physical
Android lifecycle or browser cookie/worker behavior; retain integration and device
acceptance gates for those boundaries.
