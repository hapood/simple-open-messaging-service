# CAS Media Download Status and Client Refresh

Status: implemented. All review checkpoints were accepted before implementation.

## 1. Purpose and scope

An inbound federated media message is committed to the local timeline before
its CAS objects necessarily exist locally. The committed `Message` is therefore
immediately visible at its final `seq`, while a background job downloads and
verifies its media.

This design makes that lifecycle explicit in the client. It covers:

1. persisting the latest media availability state with the message in the
   frontend database;
2. showing distinct waiting, downloading, ready, and failed states in message
   cards and immersive/detail viewers;
3. reconciling mounted media once on registration and again after SSE
   reconnect, with later state transitions delivered by SSE;
4. retaining inbound `PendingMedia` rows after both success and failure, with a
   bounded error message on failure; and
5. cleaning failed transfer artifacts without automatically deleting the
   terminal task record.

This design does not add automatic retry, download priority controls, detailed
byte progress in the message DTO, download-progress SSE, or automatic cleanup
of retained inbound task rows. Retention limits and a cleanup policy are
explicitly deferred. Status SSE is used only as a four-state transition wake;
it does not carry byte progress.

`MEDIA_STATUS` uses the application's existing authenticated `/events` stream.
It does not own a media-specific SSE connection. Profile resolution reuses the
same stream as defined in
[Profile Version Storage and Resolution](./profile-version-resolution.md); the
two features differ only by named event type and subscriber.

### 1.1 Current implementation baseline

The repository already has most of the delivery path:

- `Message.localState` is `STUB | FAILED | READY`;
- history responses attach `mediaStatus` and the frontend stores the returned
  message object in IndexedDB;
- message cards, the gallery viewer, and the file detail viewer already render
  `downloading` and `failed` variants;
- `/message/media-status` can probe up to 50 message sequences in one thread;
- `MediaProbeScheduler` probes tracked `downloading` messages after scrolling,
  rate-limited to five seconds;
- the frontend subscribes to the existing terminal-only `MEDIA_STATUS`, but the
  backend currently has no caller of `SseService.onMediaStatus`; and
- terminal inbound success and failure currently delete both
  `FileSyncProgress` and `PendingMedia`; failure first changes the `Message` to
  `FAILED`.

The current path has four gaps:

- `STUB` is always exposed as `downloading`, so queued work cannot be presented
  as waiting;
- the existing probe is scroll-triggered; the target flow instead queries on
  registration/reconnect and receives later state transitions through SSE;
- immersive/detail viewers keep a local status snapshot instead of following a
  single shared persisted status; and
- deleting terminal tasks discards durable outcome/error context. The stale
  pending GC would later delete retained rows unless inbound work is excluded.

**Review checkpoint 1 — accepted:** the scope, the four public states, and the
deliberately deferred cleanup policy.

## 2. Public state model

The stable client/API state is:

```text
MediaStatus = pending | downloading | ready | failed
```

| State         | Meaning                                                                                                                  | User action                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `pending`     | A durable download job exists, but no file in the batch is actively transferring. This includes scheduler/quota waiting. | None; continue background reconciliation.    |
| `downloading` | At least one required file is actively transferring.                                                                     | None; continue background reconciliation.    |
| `ready`       | Every referenced digest is a live local CAS object and the message has authorization bindings for all of them.           | Open, play, or save normally.                |
| `failed`      | Materialization reached a terminal failure. The message remains visible and may be retried explicitly.                   | Offer retry in the detail/immersive surface. |

`pending` means server-side CAS materialization is queued. It is different from
the existing local optimistic upload bubble whose send status is `sending`.
Those two state machines must remain separate.

For a multi-file message, the aggregate state is derived in this order:

1. `Message.localState = READY`, all digests/auth bindings are present, and any
   retained inbound job is `ready`: `ready`;
2. `Message.localState = FAILED`, or a retained inbound job is failed:
   `failed`;
3. the retained inbound job has `PendingMedia.status = downloading`:
   `downloading`;
4. the retained inbound job has `PendingMedia.status = pending`: `pending`;
5. an inconsistent `STUB` without a durable job is reported as `failed` and
   logged, rather than spinning forever.

One failed member makes the whole message failed. Once the batch driver admits
the job, the non-failed batch remains downloading while some members may still
be pending or already succeeded.

For inbound work, `PendingMedia.status` is the durable batch-level state:
`pending | downloading | ready | failed`. The batch driver changes it from
`pending` to `downloading` before claiming its files. A quota/scheduler pause
before that claim remains `pending`; a process crash after the claim remains
recoverably `downloading`. Promotion changes it to `ready` and terminal failure
changes it to `failed`. `FileSyncProgress` continues to own per-file state and
byte accounting, but the public API does not reconstruct a different message
state from transient combinations of file rows.

The raw `failReason` is operational data. The first UI iteration shows a
localized generic failure and does not expose arbitrary remote or exception
text. A later design may introduce a stable, sanitized `failureCode` contract.

**Review checkpoint 2 — accepted:** the state meanings, aggregate precedence,
and separation from optimistic outbound upload state.

## 3. Durable backend state and API contract

### 3.1 Inbound task retention

On terminal inbound failure, one transaction must:

1. change the carrier `Message.localState` from `STUB` to `FAILED`;
2. change its inbound `PendingMedia.status` to `failed`;
3. copy a bounded aggregate error message into
   `PendingMedia.failReason` (maximum 255 characters);
4. delete the spent `FileSyncProgress` rows after their useful error has been
   copied.

The transaction must not delete the failed `PendingMedia` row.

Successful promotion similarly changes `PendingMedia.status` to `ready` in the
same transaction that changes `Message.localState` to `READY`; it does not
delete the completed `PendingMedia`. Both success and failure delete their spent
`FileSyncProgress` rows after the terminal outcome has been summarized in the
retained batch row.

After the transaction, cleanup removes resumable/partial temporary transfer
artifacts. It must not blindly delete a verified CAS object: a digest may be
deduplicated and referenced by another message. Formal CAS objects remain
subject to the existing liveness-aware/manual media GC.

`gcStalePending` must exclude all inbound rows. Inbound rows are durable server
jobs, not abandoned client upload intents, and a long quota pause must not make
one disappear. Explicit administrator clean, an authoritative tombstone, and
message/thread deletion may still remove them when the associated business
object is deliberately removed. No TTL-based inbound-row cleanup is introduced
in this change.

Existing code that treats the mere presence of `PendingMedia` as proof that a
message is unresolved must be narrowed to active statuses (`pending` and
`downloading`). In particular, retained `ready` rows must not block dependent
quote promotion, appear as active admin transfer work, protect files as an
in-flight GC root, or cause startup recovery to enqueue a completed batch.
Terminal rows are history only.

Manual retry reuses the retained job identity instead of inserting a second
row that conflicts with the unique inbound `messageId` constraint. Under the
message lock it changes `PendingMedia.status` back to `pending`, clears
`failReason`, recreates the per-file progress rows from the server-authored
message content, changes `Message.localState` to `STUB`, and starts the existing
batch driver. Concurrent retries are
idempotent: only the caller that changes `failed` to `pending` starts work.

### 3.2 Status API

Every response carries:

```ts
interface MediaStatusSnapshot {
  seq: number;
  status: 'pending' | 'downloading' | 'ready' | 'failed';
}
```

Initial STUB creation exposes `pending`. The batch claim atomically changes
`PendingMedia` to `downloading`; promotion persists `ready`; terminal failure
persists `failed`; and manual retry persists `pending` before a later
`downloading`. Every committed public transition emits `MEDIA_STATUS` with one
of the four states. No per-file or byte-progress event is introduced.

Both normal history serialization and `POST /message/media-status` use the same
bulk status derivation function. The probe remains thread-authorized and capped
at 50 sequences per request. Missing/deleted sequences are omitted.

`POST /message/relocalize-media` returns the post-action status and schedules
the same mounted refresh lane. No persisted status version is introduced. The
frontend guarantees only that its own registration/reconnect queries and retry
requests for one thread are serialized and applied in request order. Any newer
SSE state invalidates an older in-flight query result for that key.

**Review checkpoint 3 — accepted:** retain terminal inbound rows after both
success and failure, clean spent progress/temporary files, reuse the failed job
for retry, and keep the status API unversioned.

## 4. Frontend persistence and live status service

The IndexedDB message record stores the status returned by the backend:

```ts
mediaStatus?: MediaStatus;
```

The existing `sv`/`StoredMediaStatus` version machinery is removed from this
media-status path; the stored enum is the complete client value.

For a CAS-bearing message, repository ingestion normalizes this field before
writing the message. Absence remains backward compatible for non-media and old
local messages and is interpreted as `ready` only when the content is not an
inbound CAS placeholder. A newly queried inbound media message must always have
an explicit status.

One root-provided `MediaAvailabilityService` owns live media state and refresh
demand. Its key is the server message identity `(threadId, seq)`, never a card
component instance or gallery index. It receives updates from:

- history/`NEW_MESSAGE` ingestion;
- `MEDIA_STATUS` SSE;
- its registration/reconnect query; and
- the manual retry response.

Cards and viewers call `register(threadId, seq, initialStatus)` and receive a
handle exposing the same read-only status signal plus `unregister()`. Multiple
registrations for one key share one service entry and are reference-counted.
Components render the signal; they do not own a second business-status
`statusOverride`. A retry button may keep a separate request-in-flight flag
solely to prevent duplicate clicks.

Registration queries and retries for one thread run through one serialized
service lane: the next request cannot start until the current request has
completed and its result has been applied. A service-local request token is
sufficient to discard an older in-flight query result after a newer SSE; no
backend status version is added.

After a backend result, the service writes the message status through
`MessageRepository`, updates the shared signal, and wakes every registration for
that key. Therefore a mounted card and an open viewer cannot hold different CAS
states. An unmounted card reads the persisted status when it registers again.

No IndexedDB index depends on these fields, so the intended change is an
additive record-shape update rather than a destructive client database
migration.

**Review checkpoint 4 — accepted:** use the IndexedDB shape and one shared
`MediaAvailabilityService` as the live state, registration, persistence, and
request-serialization boundary.

## 5. Registration and refresh lifecycle

`MediaAvailabilityService` owns mount/reconnect reconciliation, grouped per
thread. A card or viewer must not create an interval.

The existing scroll-only `MediaProbeScheduler` is replaced by the service's
registration-driven coordinator with this lifecycle:

1. when a CAS-bearing card mounts, register each server message member in that
   card; an album registers every member `seq` represented by the card;
2. debounce one immediate bulk probe so a batch of registrations produces one
   request;
3. after the registration query completes, create no timer; subsequent
   `pending`, `downloading`, `ready`, and `failed` transitions arrive through
   `MEDIA_STATUS`;
4. when a card is unmounted, call every registration handle immediately;
5. when a card absorbs or removes an album member in place, register or
   unregister that member without remounting the fixed-height card;
6. release all remaining card registrations when the pane is idled or the
   component is destroyed; and
7. on SSE reconnect, debounce one immediate bulk query for all still-registered
   keys, repairing any transitions missed while disconnected.

Card creation registers after the real component mounts. The returned
`CbElement.destroy()` wrapper unregisters before destroying the Angular
component, so every virtual-scroll trim, re-seed, or teardown releases demand.
`CbElement.update()` diffs album member sequences and updates registrations.
No sequence discovered during an earlier mount may survive solely in an
add-only tracking set.

Requests are grouped by `threadId`, chunked to the endpoint's 50-sequence
limit, and serialized per thread. Registration and reconnect bursts coalesce
into one request lane. Network errors preserve the last known state; they never
convert a message to `failed`. A later registration or SSE reconnect performs
the next reconciliation attempt.

The gallery and file-detail overlays register their currently displayed
message with the same service for their lifetime. They receive the exact same
signal as a card registered for that `(threadId, seq)`. Registration triggers an
immediate query even if the underlying chat row has been virtualized out.
Changing gallery slides replaces the registration. Closing the overlay releases
it.

Card demand and overlay demand are independently reference-counted. Unmounting
a card always releases the card registration; it does not cancel an active
viewer registration for the same message. Conversely, a closed viewer cannot
keep an unmounted card registered.

SSE is the only post-registration state-change path. On every four-state event,
the service updates the shared signal, persists it, and invalidates an older
in-flight query result for that key. If events are missed while disconnected,
the reconnect query observes the current database state. Manual retry updates
the shared entry from its HTTP response; the later batch-claim and terminal
transitions arrive through SSE.

No byte-level download progress is pushed to this service. `downloading` uses an
indeterminate presentation. Existing outbound-upload and user-initiated
save/download progress are separate features and remain unchanged.

Message withdrawal is authoritative over media availability. When a mounted
message is withdrawn, the repository deletion event removes its shared service
entry, notifies every registration, closes any gallery/file viewer displaying
it, and lets the card's normal tombstone path remove the card. A later HTTP
snapshot or `MEDIA_STATUS` frame for that key is ignored. If withdrawal deletes
the server-side staged task while a transfer is running, the transfer's late
completion cannot recreate the message or its frontend availability entry.

**Review checkpoint 5 — accepted:** use reference-counted mount registration,
one registration/reconnect reconciliation query, four-state SSE transitions,
no periodic timer, and strict unregister-on-destroy behavior.

## 6. Presentation behavior

Message-card geometry is fixed before media becomes ready. Card height does not
depend on download state, and image/video cells use the width and height
metadata already stored in the message rather than intrinsic media dimensions.
Status layers therefore replace content in place inside the existing box: a
`pending -> downloading -> ready | failed` update neither changes layout nor
triggers reflow or virtual-scroll remeasurement.

Status layers remain overlays or fixed-height meta slots. Any new vertical CSS
measurements must follow the repository's integer-pixel rule. Implementations
must not add a status label, border, padding, or gap that contributes a different
height in one state.

### 6.1 Message cards

| State         | Image/video/album card                                                                       | File card                                                      | Interaction                                                                   |
| ------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pending`     | Muted preview/placeholder with a static cloud-clock or queue icon and “Waiting to download”. | Static pending icon and the same label in the fixed meta slot. | Opening the detail viewer is allowed; media playback/download is disabled.    |
| `downloading` | Existing dim overlay and indeterminate spinner with “Downloading”.                           | Existing spinner.                                              | Opening detail is allowed; media playback/download is disabled.               |
| `ready`       | Existing media presentation.                                                                 | Existing download icon.                                        | Normal interaction.                                                           |
| `failed`      | Existing failure overlay/icon with “Download failed”.                                        | Existing failure icon.                                         | Card opens detail; retry is offered there rather than as a small card target. |

A single `GALLERY` message uses one aggregate message status for all files it
owns. A chat album produced by absorbing several independent messages keeps the
status of each cell's owning `(threadId, seq)`: one message becoming ready must
not unlock another message's cell. If the album meta slot needs one summary, it
uses `failed` when any member failed, otherwise `downloading`, then `pending`,
and finally `ready`. Per-file byte progress is not exposed in this iteration.

### 6.2 Immersive gallery and file detail

- `pending`: centered static pending treatment and “Waiting to download”; no
  retry button because the job has not failed.
- `downloading`: centered spinner and “Downloading”.
- `failed`: generic failure message plus explicit retry action.
- `ready`: initialize/refresh the actual image, player, or download link. A
  transition to ready cache-busts or refreshes viewer content once.

The viewer reads the repository's live status for `(threadId, seq)` and does
not keep a divergent status override. HTTP/media decode failure after a
`ready` state remains a distinct rendering/network error with its existing
retry-load action; it must not rewrite CAS materialization status to `failed`.

Accessibility labels and Simplified Chinese/English translations are required
for the new pending state. Motion remains indeterminate only for active
`downloading`; `pending` is visually static so waiting is not misrepresented as
active transfer.

**Review checkpoint 6 — accepted:** use the card/viewer behavior and the
height-neutral presentation constraint.

## 7. Verification plan

### 7.1 Backend

- status derivation covers pending, mixed pending/downloading batches, ready,
  failed, and inconsistent orphan STUBs;
- failure atomically retains `PendingMedia.failReason` and removes spent
  progress rows;
- stale pending GC does not remove pending, downloading, ready, or failed
  inbound rows;
- retry reuses one row and only one concurrent caller starts the batch;
- successful promotion retains a ready task row but removes spent progress
  rows;
- retained ready rows do not block quote promotion, appear as active work,
  become in-flight GC roots, or enter startup recovery; and
- media-status access remains scoped by `ThreadAccessGuard`.

### 7.2 Frontend

- one thread's mounted probes/retries are serialized, and each completed result
  is persisted before views are notified;
- initial mount creates one batched probe;
- registration and reconnect bursts coalesce into serialized per-thread status
  queries with no interval;
- unmount, pane idle, overlay close, and destroy release their registrations;
- albums expand to member sequences without duplicate requests;
- a transient probe failure preserves the current state;
- card and open viewer update together from probe/SSE/retry; and
- withdrawal closes an active viewer, invalidates all registrations, and drops
  late query/SSE results;
- each of the four states has stable-height, accessible rendering.

### 7.3 Integration

An end-to-end scenario should commit a STUB, observe `pending`, hold the batch
queued, start transfer and observe `downloading`, then complete and observe
`ready`. A second scenario forces a download error, verifies `failed` in the
client and retained `PendingMedia.failReason`, retries the same task, and reaches
`ready` without inserting a duplicate pending row.

**Review checkpoint 7 — accepted:** use the verification matrix before
implementation is declared complete.

## 8. Suggested implementation order

Implementation should follow the accepted checkpoints in dependency order:

1. backend state derivation, failed-row retention, and retry reuse;
2. OpenAPI DTO regeneration and the shared `MediaAvailabilityService`;
3. card/viewer registration and four-state SSE integration;
4. pending-state card/viewer presentation and translations; and
5. backend, frontend, and end-to-end verification.

The deferred task-record cleanup policy must be handled by a separate reviewed
design. Until then, retained terminal inbound rows are expected operational
history, not stale rows for the automatic TTL sweep.
