# Media Transfer Lifecycle Proposal

Status: approved three-outcome and atomic-publication design; implementation and acceptance validation are in progress. The rebuilt `0000_base.sql` and Drizzle schema describe the transfer model. This rollout requires database recreation, not an incremental upgrade of an existing migration ledger.

This document defines transfer task ownership, resumability, publication, temporary cleanup, and client saving behavior. Implementation status and test results are tracked separately from these design contracts.

## 1. Scope and deployment model

- One backend process owns the configured temporary storage. Concurrent backend processes and overlapping rolling deployments against that storage are out of scope.
- Reuse `UploadSession`, `PendingMedia`, and `FileSyncProgress`; do not introduce a new backend task registry table.
- Upload and download stop/failure preserve task records and resumable data, except that final integrity-validation failure deletes invalid temporary content.
- Stop is not pause. A stopped task can be explicitly retried.
- Runtime progress, speed, cancellation, timers, and attempt identity are in memory. Process startup reconstructs eligible work from database state and disk checkpoints.
- Existing checkpoint formats and transfer data are not supported by this rollout. Old tasks and artifacts must be explicitly retired while old writers are stopped.

## 2. Timeout and execution ownership

Both client upload attempts and server upload reception enforce 30 seconds without new data using renewable timers: each new-data observation resets the idle deadline. Stop, completion, failure, and execution replacement cancel the old timer. Federation downloads retain their 30-second idle timeout. The timer measures activity, not total file duration and not completion of an entire chunk.

On the server, receiving activity must be observed before the existing full-buffer upload handler. A slow but progressing request is not idle. Receiving, waiting for the next chunk, waiting for a response, and media processing are distinct phases; processing must not be failed for having no upload traffic.

An attempt-level idle timeout ends that attempt. Bounded retries may create a new execution attempt using the same logical identity and checkpoint. A server task already marked `FAILED` may be explicitly re-admitted by the authorized retry path if its failure is recoverable. An explicit stop is stored as `FAILED` with a machine-readable stop reason; it never restarts because of a stale request or automatic retry. There is no additional indefinite server grace period merely to accommodate client retries.

The periodic recovery job is not an upload-idle detector. It reconstructs eligible `PENDING` execution from checkpoints and committed task results; processing is not a persisted task status. Receiving activity has its own renewable deadline. A sweep every 30 seconds alone would detect 30 seconds of inactivity approximately 30–60 seconds after the last activity, not precisely at the threshold. Runtime deadlines should drive idle cancellation; periodic sweeps provide recovery/reconciliation.

Use a monotonic clock for runtime idle deadlines. `updatedAt` remains a general task update time and may change for progress, status, and retry admission; it is not an exact last-network-byte timestamp. Persist progress activity at a bounded cadence, not per byte. Startup applies a fresh runtime deadline to reconstructed waiting work rather than claiming database timestamps precisely reconstruct an interrupted timer.

No database generation or lease fields are proposed. However, single-process execution still needs in-memory attempt identity/cancellation ownership and serialized admission. Stop/retry, chunk reception, completion, and cleanup must reject callbacks from obsolete attempts. Existing operation mutexes alone are not assumed to cover socket body reception or detached asynchronous callbacks. An alternative implementation may avoid numeric generations by proving that the old execution has fully quiesced before any replacement is admitted.

## 3. Backend persistence model

### 3.1 UploadSessionStatus

Target enum values:

```text
PENDING
COMPLETED
FAILED
```

- Persist task outcomes only. Receiving, queued, processing, and publishing are in-memory execution phases.
- Errors and explicit stops use `FAILED`, distinguished by machine-readable reasons. The UI renders explicit stop as stopped, not as an unexplained error. Retry returns the durable outcome to `PENDING`.
- Task rows exist before successful transfer; verified CAS asset publication is a separate operation. No formal usable asset is published for an incomplete file.
- Preserve task history with nullable `pendingMediaId` and `messageId` ownership. Message publication transfers ownership atomically before deleting staging. Tasks use database IDs for ownership; upload responses expose the task `id` as a decimal string, and subsequent commands use that ID with owner authorization. `tmpKey` is server-internal storage information, never a client retry parameter. Message admission and idempotency use `clientMessageId` and `partId`.
- `abortedAt` is a retained legacy column, not a newly defined failure-history timestamp. New lifecycle APIs use status and `updatedAt`; do not quietly overload the old column with conflicting meanings.
- Progress/status mutations maintain `updatedAt` correctly. Retry clears the current error and reuses the same task and temporary key when recovery is valid.
- No immutable per-attempt history or durable cleanup timestamp is promised. Existing administrator auditing remains separate.

### 3.2 FileSyncStatus

Use exactly `PENDING`, `COMPLETED`, and `FAILED`, matching uploads. Required `messageId` ownership survives removal of temporary coordination; physical message deletion must explicitly retire its tasks. Keep `bytesReceived` as a display projection; disk checkpoints remain authoritative for resume. Existing `errorKind`, `createdAt`, and `updatedAt` cover current-state reporting. The UI merges a durable task with its current runtime entry; absence of an entry means not running, not necessarily failed.

### 3.3 PendingMedia

Outbound staging owns message content, authorship, and the submission barrier. File tasks are the sole authority for transfer outcomes; batch transfer summaries are derived from them. Inbound staging coordinates attachment materialization for an existing message. Published messages already have sequence coordinates; inbound attachment completion must not rewrite quotes or allocate message sequences.

### 3.4 Migration constraints

`database/migrations/0000_base.sql` defines the database baseline, including task ownership, required message authors, and the three durable task outcomes.

This is an explicit database-recreation rollout. It is not compatible with applying migrations over an existing baseline ledger. Operators own backups, recreation, and retirement of obsolete temporary files; the baseline does not convert old tasks or checkpoints. Automated validation recreates only isolated test databases.

Keep `src/database/schema.ts` and the rebuilt baseline synchronized. The native SQLite download registry remains a separate concern.

## 4. Checkpoints and retry

- Metadata contains committed offset and the identity needed for its owner, but no format-version field and no per-block hash manifest.
- Resume does not hash the already stored prefix.
- Check record readability, file presence, offset bounds, declared total length, and actual file length.
- A tail beyond committed offset is uncommitted and may be truncated. A file shorter than committed offset cannot resume.
- Download retries inspect disk under the digest lock. If all temporary artifacts are absent, start at zero regardless of historical progress or failure reason. If any artifact remains, require a valid checkpoint and partial file; incomplete or corrupt pairs produce an explicit recovery error rather than being overwritten.
- Upload retry retains its task-owned staging checks; the download rule does not implicitly reset upload staging.
- Final download digest mismatch deletes invalid temporary content and records failure. Deletion errors are reported; do not claim successful cleanup if invalid files remain.
- Error reasons describe failures, not temporary-file state. Display byte counts do not authorize or prohibit a zero-offset restart. Cleanup failures are reported; the next admitted execution inspects the actual artifacts.
- The physical download scheduler coalesces all sources by digest. The admitted source determines routing and per-peer limits, while later consumers share its result and progress. Source replacement must wait for cancellation and writer draining. Progress subscriptions authenticate message access and digest membership before observing shared bytes; unsubscribing does not cancel the download.
- Uploads do not require a client-provided whole-file digest. At completion the server computes CAS identity and validates media as required. Computing a digest alone does not compare against a client expectation.
- Final integrity-invalid content is removed; transient processing errors are not automatically classified as corrupt content.
- Explicit stop and ordinary transport failures preserve checkpoints.
- Retry after a lost response first queries authoritative server state and never duplicates message publication.
- Administrator upload retry can admit waiting-for-client work or resume complete-file processing; it cannot supply missing client bytes.

### Atomic file publication and crash recovery

Keep the original task-owned partial file until the database completion transaction succeeds. Uploads retain their UUID `tmpKey`; do not rename the source to its digest. After full reception, compute the digest and atomically add it to the existing progress metadata before starting publication.

1. Copy the complete source to a uniquely named publication temporary file on the destination filesystem.
2. Synchronize the copied data and atomically publish it at the canonical digest path without replacing an existing target. Ordinary POSIX rename can overwrite targets; use a primitive with atomic no-replace semantics rather than an existence check followed by rename.
3. Commit verified asset data and the owning task/message results through their domain transaction boundaries.
4. Remove the original partial file and checkpoint only after the owning task is durably completed.

Recovery does not resume the copy itself: while the task is incomplete and its complete source is retained, copy again through a new publication temporary file. An already published canonical regular file may be reused and the missing database/message commit must still be completed idempotently. Completed tasks only need leftover cleanup, not retransmission or duplicate message creation.

Only an already-existing valid canonical file during atomic publication is a warning-and-success outcome. Directories, symlinks, and unexpected targets are errors. Other filesystem failures are logged as errors and propagated, never hidden by empty catch blocks. Cleanup after a successful database commit may fail and leave garbage, but must not turn a completed task back into a transfer failure. Callers distinguish idempotent absence from an operation that was actually attempted and failed; no blanket exception suppression is allowed.

The CAS owner provides shared publication primitives for buffers, uploads, and federation downloads. Hashing/media validation and task/message commits belong to their respective domain owners. Publication preserves the resumable source until its owning task commits.

## 5. Temporary-file cleanup

Create a separate administrator navigation entry for temporary garbage cleanup. Only an explicit scan action starts enumeration. Return at most 20 cleanup items, without pagination; another click performs a new scan.

Allowed roots are the configured upload resumable directory and CAS temporary directory. They are flat for this feature. Group known companion files by upload `tmpKey` or download digest, with separate namespaces. Unknown files are individual items. Unexpected subdirectories are single items; do not descend into them during listing. Use `lstat` and do not follow symlinks.

Sort oldest first. For a known file group, use the maximum member modification time; for an unexpected directory, use its own modification time, explicitly not a recursive latest-content time. Exact sorting generally requires inspecting the root entries before selecting the oldest 20 groups; the result limit does not bound enumeration to 20 entries.

Upload candidates include pending and failed tasks. Deleting their temporary files is a cancellation command: invalidate execution, abort reception, drain resources, and delete task-specific artifacts. Retry conflicts while cancellation is settling and may explicitly start from zero afterward. No separate maintenance lock requires an active upload to become idle first.

Download candidates require failed owners and no active shared transfer; a digest can serve multiple tasks. Artifacts without matching task records are also candidates. Recheck ownership and file identity at deletion time, not only when scanning. Scanning creates no durable filesystem catalog.

A directory is not deleted with a file-only unlink. Directory cleanup requires explicit confirmation and constrained recursive removal without following symlinks or leaving the authorized root. Unexpected directory rows must be clearly labeled; the server must reject a directory that is active or cannot be safely classified. Directory mtime alone does not prove inactivity.

Stopping a task never invokes cleanup. Cleanup preserves task records. A future download retry determines resumability from disk: no artifacts means offset zero, while an incomplete or invalid checkpoint pair is an error. The UI must not promise durable cleanup history beyond the audit trail.

## 6. Client upload contract

The client upload API provides resumable init, status, append, complete, stop, retry, and cancellation commands. Client upload tasks exist only for the current application session; failed-message placeholders are not a task-restoration mechanism.

Retry is supported while the client retains the original source and logical upload identity. Selecting a file again always creates a new task. This release does not restore client upload tasks or reopen/reselect source files after application restart.

Recoverable client failures preserve batch staging and checkpoints. Web and Rust upload execution uses bounded automatic retry and phase-aware 30-second idle detection. Rust owns native retry and cancellation policy; Android adapters do not duplicate it.

## 7. Client downloads and local persistence

Browser save actions target the original resource URL and delegate to browser downloads, using same-origin media-cookie authentication. The application cannot promise browser download progress, cancellation, or resume controls. Saving an image must download its original resource, not its thumbnail or display preview.

Native downloads are Rust-owned tasks writing directly to their destination. Desktop targets use ordinary files. Android 10+ automatically creates app-owned MediaStore entries: positively identified supported images go to `Pictures/SOMS`, and everything else goes to `Download/SOMS`. Do not prompt for a directory or retain a directory preference on this path. Identify images conservatively using trusted metadata and a bounded file-signature sniff in Rust, not an extension or a generic image MIME alone; write the buffered prefix into the same destination afterward. Publish the entry only after successful completion and show a toast with the logical saved location. MediaStore publication does not require an extra media scan.

Android 9 and earlier use the system CreateDocument save picker, allowing the user to select a location and filename without broad storage permission. Do not copy the completed file through private media cache. Private metadata is permitted and is not a duplicate large-file payload.

Android adapters create/publish MediaStore entries or open the legacy save picker, retain supported URI grants, and reopen descriptors. Rust owns task/session state, transport, retries, cancellation, and validation. Unsupported seeking/readback or revoked access causes an actionable error. Do not persist descriptor numbers or silently fall back to a private full-file copy.

Native downloads use a local persistent task registry independent of media viewing caches and backend task storage. Task records include account/server scope, resource coordinates, destination identity, state, committed offset, validators/expected digest, errors, and timestamps. Do not persist bearer tokens. Resolve current credentials and recheck access before resume.

Exact SQLite DDL and destination-grant representation require a separate implementation review. Persistence across restarts does not imply guaranteed execution after Android terminates the process.

## 8. UI

- Global and user-specific admin upload views show file, user, conversation, progress, speed, phase, error, stop, and retry.
- Distinguish received-in-flight bytes from committed resumable bytes.
- A native client download-management webview lists Rust-owned tasks and exposes progress, stop, and retry. It is not an externally accessible unauthenticated local web server.
- Compact/medium layouts: place the download icon immediately left of the add-friend icon in the conversation-list header.
- Expanded layout: place the entry in the icon rail.
- Animate only during active downloading; honor reduced-motion settings. Failed/stopped tasks do not animate. The browser does not invent progress for browser-owned downloads.
- Media viewing/playback caches remain separate from explicit save tasks.

## 9. Verification requirements

- Database-backed tests verify atomic task/message ownership transfer and stop/complete, retry/cleanup races.
- Filesystem tests verify checkpoint durability, publication source retention, integrity rejection, and cleanup failure reporting.
- Transport tests distinguish idle streams from slow progressing streams and reject stale execution callbacks.
- Recovery tests verify retained task history and checkpoints across process restarts without duplicate publication.
- Administrator tests verify explicit scanning, grouped limits, authorization, and safe directory deletion.
- Client tests verify session-scoped uploads, original-resource browser saving, and Rust-owned persistent native downloads.

Test lost acknowledgements, duplicate chunks, stale callbacks, stop versus retry/complete, shared-digest consumers, cleanup races, missing/truncated checkpoints, corruption at EOF, idle versus slow streams, restarts, unsupported Android providers, revoked grants, and account switching.

## 10. Source references

- [Database schema](../../src/database/schema.ts)
- [Upload lifecycle](../../src/upload/resumable-upload.service.ts)
- [Upload recovery](../../src/upload/upload-recovery.service.ts)
- [CAS checkpoints](../../src/upload/upload.service.ts)
- [Download scheduler](../../src/federation/federation-download-scheduler.ts)
- [Inbound file execution](../../src/federation/federation-inbound-file-sync.ts)
- [Inbound batch lifecycle](../../src/federation/federation-inbound-media-batch.service.ts)
- [Temporary maintenance](../../src/media/media-maintenance.service.ts)
- [Native media cache](../../src-tauri/src/media_cache.rs)
- [Native database](../../src-tauri/src/native_db.rs)
- [Client save facade](../../web/src/app/services/media-save.service.ts)
