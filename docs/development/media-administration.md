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
  scheduler. Concurrent consumers of one `(peer, digest)` share a physical entry.
  SSE sends bounded full snapshots on connection and on changes, throttled to at
  most twice per second. Reconnect replaces the snapshot. The instance ID is
  explicit: these are not cluster-wide metrics. Session access is revalidated
  every 30 seconds; disconnect releases timers and subscriptions.
- **Download tasks** queries persistent inbound `PendingMedia` batches with
  pagination and status filters. Task state is not evidence of active network IO.
  Completed historical jobs show their completed file count, but unknown byte
  totals and missing historical details are not represented as zero.
- **Client uploads** lists non-completed `UploadSession` records, including failed
  and interrupted sessions. Committed offsets come from existing sidecars.
- **Download temporary files** scans the CAS staging directory only on demand.
  It groups recognized artifacts by digest, including orphaned checkpoints, and
  returns a bounded page. Staging-byte totals include checkpoint metadata.
  Client upload staging is managed through the upload panel instead.

## Commands

### Upload: stop and clean

Stopping an upload cancels its entire uncommitted message batch. This prevents
unfinished siblings from leaving an impossible batch-completion barrier.
Existing upload/batch exclusion protects cancellation, waits for in-flight writes,
and prevents completion after abort. Aborted session rows and staging artifacts
are physically removed. Cleanup treats only missing files as success; an IO
failure retains the session for another cleanup attempt. Completed uploads are
not cancellable through this path.

### Download: stop, retry, delete

Stopping an inbound job marks it failed and aborts its consumer. Physical IO is
aborted when its final consumer stops; another consumer of a shared transfer is
not cancelled by stopping only one job. Stopping a physical downloader entry
stops the current transfers for that digest and can fail every sharing consumer.

Failure retains execution rows and validated partial data until explicit task
deletion. Both administrator retry and client failed-attachment retry delegate to
the same message-driven restaging capability. It can reconstruct missing task
rows from the retained message and current conversation/source context. It
preserves existing byte progress and succeeded file rows. The source peer still
authorizes signed requests; reconstructed addressing is not an authorization
token. Startup recovery continues to use the admitted persisted request context.

Task deletion requires a terminal job and physically removes its temporary
execution records. Active dependent jobs must be stopped first. Temporary data
is removed only when no remaining job references the digest and no physical
writer still uses it. The retained message is not deleted. An authenticated
client can later reconstruct a failed attachment job from that message.

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
filters accept `pending`, `downloading`, `failed`, or `ready`.

| Path                        | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `/files`                    | Paginated registered CAS inventory             |
| `/uploads`                  | Paginated non-completed client uploads         |
| `/downloads`                | Paginated durable inbound batches              |
| `/temporary`                | On-demand CAS temporary-file inventory         |
| `/uploads/:uploadId/stop`   | Stop and physically clean the upload batch     |
| `/downloads/:batchId/stop`  | Stop an inbound batch                          |
| `/downloads/:batchId/retry` | Retry/restage a failed batch                   |
| `/downloads/:batchId/clean` | Physically remove a terminal task              |
| `/downloader/stop`          | Stop physical transfers for `{ digest }`       |
| `/temporary/clean`          | Clean unused artifacts for `{ digest }`        |
| `/files/reclaim`            | Reclaim an unreferenced asset for `{ digest }` |

`GET /admin/media/downloader/stream?skip=0&take=25` is the SSE exception. It emits
`snapshot`, transport `heartbeat`, and terminal `access-revoked` events.

Destructive commands use the existing administrator audit mechanism. Reads and
SSE updates are not audit actions. The previous full-list API projections,
client-name-bearing administrator upload views, and filesystem-scanning storage
statistics endpoint have been removed rather than maintained as parallel APIs.
