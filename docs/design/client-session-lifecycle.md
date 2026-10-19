# Client login-session lifecycle

Status: accepted target design; implementation is not complete.

## Implementation status

Browser authentication, restoration, logout and push-worker admission use the
UUID journal and session-owned IndexedDB names. Browser fresh-login preparation
performs deferred deletion before sending authentication requests. The renderer's
lifecycle mirror now captures cancellable work scopes carrying the host-supplied
UUID instead of generating numeric login epochs. Native admitted-work migration
is not complete.

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
lives inside that file. Activation and logout transitions validate the UUID
captured by the original operation, and a persisted credential whose login ended
is discarded at restoration instead of reviving the session. Per-request native
command admission still uses the existing numeric epochs.

UUID-named SQLite cache files are implemented: the shared preferences file keeps
only device/account preferences, and each login owns `soms-session-<uuid>.sqlite`
(retained at logout, deleted by the next fresh login). Existing native login
epochs remain in use for admitted work.

The Rust `LoginConnection` core now owns an immutable UUID, one physical SQLite
connection, a credential and cancellation state. Activation permits survive
asynchronous persistence without holding lifecycle locks and reject completion
after end. Database tasks capture the owner before scheduling. End cancels
admission without waiting for SQLite; close drains access and retains the cache
file. This core has unit coverage in the main Cargo package, but it is not yet
wired into application initialization or existing native command entry points.
Those entry points still open caches through the current-path API and must be
migrated; UUID-named files alone do not establish connection ownership.

Device preferences and durable session metadata now share one physical
process-scoped `DeviceConnection`, explicitly initialized by the shell or
headless Android bootstrap. Repeated shell attachment does not reconnect.
Preference IPC commands and journal transitions capture this existing owner
before scheduling, then borrow its SQLite connection only for local work.
Uninitialized access fails rather than opening a database. Connection-local TEMP
state tests verify physical reuse, including concurrent initialization and
ordinary preference IPC. This device-database integration does not yet migrate
the UUID-owned login cache commands or make runtime credential transitions atomic.

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
