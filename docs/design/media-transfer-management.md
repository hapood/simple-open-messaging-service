# Media Transfer Management

Status: implemented.

## 1. Boundary

Media administration follows the subsystem that owns each transfer. It does
not infer global CAS liveness and does not expose garbage collection, shard
reconciliation, stale-pending sweeps, or orphan-file deletion.

This is an application implementation design. It does not add or change a
federation wire endpoint. Peer-facing media behavior remains defined under
[`spec/v1`](../../spec/v1/).

The administration route remains `/media`, but its product name is **Media
Transfers**. All transfer mutation endpoints require `SUPER_ADMIN`; storage
totals are also included in the authenticated dashboard summary.

## 2. Ownership

| State or artifact                                        | Owner                          | Supported administration                                                                          |
| -------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Inbound federation `PendingMedia` and `FileSyncProgress` | Federation download manager    | List batches, retry a failed batch, or explicitly clean a batch and its staged dependency closure |
| Client `UploadSession` and resumable `.part` file        | Resumable upload manager       | List active sessions or abort one                                                                 |
| Verified `MediaAsset` rows and CAS shard files           | Upload/CAS store               | Read-only totals                                                                                  |
| `FederatedMessageTombstone`                              | Federation message convergence | No media-administration view or deletion action                                                   |
| Diagnostic report archives                               | Diagnostics subsystem          | Existing diagnostics retention and deletion flow                                                  |

The tombstone table remains part of federation message convergence because an
authoritative deletion may arrive before its message. Removing its former
media-page table does not remove or weaken that state machine.

## 3. Federation downloads

The administrator inbox reads durable inbound batches and their per-file
progress. It includes terminal `ready` and `failed` rows as operational history,
in addition to active `pending` and `downloading` rows.

Retry delegates to the normal inbound batch retry path. It is accepted only for
a failed inbound batch and reuses the existing batch identity and message.

Clean accepts only a terminal `ready` or `failed` root. It locks that root, then
deletes its task rows and every staged quote dependency that transitively waits
on that origin coordinate. The database operation is a single transaction. It
deletes `FileSyncProgress` before `PendingMedia`, does not scan the CAS
directory, and does not delete verified CAS objects. A missing or non-inbound
batch is a no-op response; an active root is rejected.

Temporary download artifacts remain owned by the download lifecycle. Valid
partial prefixes may survive a retryable transport failure for resumable retry;
integrity failures remove untrusted prefixes. The administration clean action
does not pretend to determine whether an arbitrary filesystem artifact is live.

## 4. Client uploads

The upload table lists active resumable sessions directly from the upload
manager. Abort uses the existing upload lifecycle, which changes the session to
its terminal state, marks its staged message failed where applicable, and
removes the session's known temporary file.

There is no separate stale `MediaAsset`-pending view. `MediaAsset` represents
verified CAS objects; transfer state belongs to `UploadSession`, `PendingMedia`,
and `FileSyncProgress`.

## 5. Storage totals

Storage reporting is intentionally read-only:

- database bytes and row counts, split into live and deleted `MediaAsset` rows;
- filesystem bytes and file count for canonical 64-character digest files in
  the two-level CAS shard tree.

The totals do not report “reclaimable” bytes. Such a number would require a
protocol-aware reachability model covering ordinary messages, immutable forward
bundles, retained profile versions, staging, and future owners. The removed GC
model did not cover that complete graph and therefore was not safe to retain.

## 6. Removed maintenance surface

The following implementation surface is removed rather than deprecated:

- global media GC and its progress/cancel SSE task;
- CAS shard reconciliation and orphan-file deletion;
- stale `PendingMedia` sweeping;
- forward-bundle reachability GC;
- the media-page pending federated-deletion inspector; and
- the media-page stale CAS-publish panel.

Normal transfer completion and explicit abort/retry/clean operations remain. A
future storage reclamation design must begin with a reviewed ownership and
reachability model; it must not restore the removed assumptions implicitly.
