# Media administration

The media console separates physical transfers, durable jobs, upload staging, and
verified CAS assets. Its file inventory and upload panels are reused in the user
detail page. Every endpoint is restricted to authenticated super administrators.

## Privacy boundary

Inventory responses contain explicit projections, not database rows or client
upload views. They do not expose original file names, MIME types, message bodies,
message coordinates, preview URLs, download URLs, local paths, or raw errors.
An upload without a verified digest displays an unknown digest, never its name.

A file's associated users are message authors or completed uploaders. Association
is not exclusive ownership or a list of everyone who can read a file. Repeated
references by one author are deduplicated. A shared CAS object appears once in
the inventory; the console shows up to three associated identities and their
total count. A user's inventory filters the same query by the local account.
Files with no known association remain visible in the global inventory.

## Views

- **All files** queries registered `MediaAsset` records with digest-prefix and
  availability filters. Pagination, counts, and recorded logical byte totals
  share one database statement/snapshot. Reclaimed records remain queryable.
  Availability is the recorded state, not a fresh filesystem integrity check.
- **Live downloader** observes physical entries in the process-local download
  scheduler. Concurrent consumers of one digest share a physical entry across peers; the admitted source determines per-peer concurrency accounting.
  SSE sends bounded full snapshots on connection and on changes, throttled to at
  most twice per second. Reconnect replaces the snapshot. The instance ID is
  explicit: these are not cluster-wide metrics. Session access is revalidated
  every 30 seconds; disconnect releases timers and subscriptions.
- **Download tasks** groups persistent `FileSyncProgress` rows by batch with
  pagination and outcome filters. Temporary `PendingMedia` coordination is not
  required for completed history. Task outcomes are not evidence of active network IO.
- **Client uploads** lists non-completed `UploadSession` records, including failed
  and interrupted sessions. Committed offsets come from existing sidecars.
- **Garbage management** has its own navigation entry. It scans `resumable` and
  `cas/tmp` only on explicit request, groups recognized companions, and shows at
  most 20 candidates ordered by oldest latest-modification time, without pagination.
  Unexpected directories are single entries requiring recursive-delete confirmation;
  symbolic links and special files cannot be deleted through this interface.

## Commands

### Upload: stop and retry

Stopping an upload stops its entire uncommitted message batch. Task records and
staging artifacts are retained. Durable outcomes are `PENDING`, `COMPLETED`, and
`FAILED`; stopping records `FAILED` with `USER_STOPPED`. Completed uploads are
not stoppable through this path.
Retry validates the retained checkpoint instead of discarding the partial file.
An administrator can admit another attempt, but cannot send missing client bytes.
The client must retain the original source file to continue uploading.

### Download: stop and retry

Stopping an inbound job marks it stopped and aborts its consumer. Physical IO is
aborted when its final consumer stops; another consumer of a shared transfer is
not cancelled by stopping only one job. Stopping a physical downloader entry
stops the current transfers for that digest and can fail every sharing consumer.

Ordinary transport failure retains execution rows and committed partial data.
Final integrity failure removes invalid temporary content. Both administrator retry and client failed-attachment retry delegate to
the same message-driven restaging capability. It can reconstruct missing task
rows from the retained message and current conversation/source context. It
preserves existing byte progress and succeeded file rows. The source peer still
authorizes signed requests; reconstructed addressing is not an authorization
token. Startup recovery continues to use the admitted persisted request context.

The task deletion endpoint and action have been removed. Stopping is never a
cleanup operation. Temporary garbage cleanup is a separate capability; active
shared download users must be excluded and task records remain available.

Completed downloads retain their checkpoint until all durable tasks sharing the
digest have completed. The last completion cleans the companions after committing
its outcome; cleanup errors are logged without reversing completion or blocking
message promotion. Startup recovery also retries cleanup from completed task
history, including batches whose temporary coordination has already been removed.

Deleting upload garbage invokes the upload cancellation state machine, including
for active uploads. Cancellation invalidates execution before draining resources
and deleting task-specific files. Retry conflicts during cancellation; once deletion
settles, an explicit retry starts from zero while the stage and task history remain.
Cleanup failure is reported and the delete command can be retried. Unowned entries
are rechecked before direct filesystem cleanup.

### Formal file: reclaim only when unreferenced

Reclamation never removes user or message references. It rejects any digest with
message references, forward-bundle references, staged publishers, or durable
file-task references. Only an unreferenced asset can have its physical bytes
removed; its existing `MediaAsset.isDeleted` flag records reclamation.

No new table, column, enum, index, trigger, or migration is required. Because
existing references do not share a per-digest admission lock, explicit
reclamation uses short table-write exclusion to make the reference check and
unlink mutually exclusive with reference admission. Physical CAS publication
also participates in a short database exclusion boundary, including generated
buffers and forwarded avatar snapshots. Network downloads never hold this
publication transaction open.

Reclamation is not a permanent block. A later valid publication can resurrect the
asset. Recovery is not guaranteed: a local upload without another source requires
re-uploading, and a remote source must still be available and authorize access.

## HTTP surface

All JSON endpoints below are POST requests under `/admin/media`. Page bodies use
`{ skip, take, userId? }`, with `take` limited to 100. File filters additionally
accept a lowercase hex digest prefix and `available`/`reclaimed` status; task
filters accept `pending`, `downloading`, `failed`, `stopped`, or `ready`.

| Path                        | Purpose                                         |
| --------------------------- | ----------------------------------------------- |
| `/files`                    | Paginated registered CAS inventory              |
| `/uploads`                  | Paginated non-completed client uploads          |
| `/downloads`                | Paginated durable inbound batches               |
| `/uploads/:id/stop`   | Stop the upload batch and retain its checkpoint |
| `/uploads/:id/retry`  | Retry a failed or stopped upload                |
| `/downloads/:batchId/stop`  | Stop an inbound batch                           |
| `/downloads/:batchId/retry` | Retry/restage a failed batch                    |
| `/downloader/stop`          | Stop physical transfers for `{ digest }`        |
| `/files/reclaim`            | Reclaim an unreferenced asset for `{ digest }`  |

Garbage endpoints are separate: `POST /admin/garbage/scan` takes no pagination
parameters; `POST /admin/garbage/clean` accepts `{ token, confirmDirectory? }`.
Tokens identify a scanned group, expire after 15 minutes, and never accept a
client-supplied path. The old `/admin/media/temporary` and `/temporary/clean`
endpoints reject requests and direct administrators to explicit garbage scanning.

`GET /admin/media/downloader/stream?skip=0&take=25` is the SSE exception. It emits
`snapshot`, transport `heartbeat`, and terminal `access-revoked` events.

Destructive commands use the existing administrator audit mechanism. Reads and
SSE updates are not audit actions. The previous full-list API projections,
client-name-bearing administrator upload views, and filesystem-scanning storage
statistics endpoint have been removed rather than maintained as parallel APIs.
