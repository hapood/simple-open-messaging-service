# Server-owned attachment metadata and local thumbnails

Status: agreed direction; implementation pending. This document defines the target
contract, not the current schema or deployed federation protocol.

## Current implementation slice

The server implementation includes `MediaAsset.meta` in the reset baseline,
processes local staged uploads and received originals, generates local
WebP derivatives under the configured data directory's `thumbnails/` tree, and
preserves current client-facing message fields. Federation now uses nested media
metadata without MIME; client restructuring remains deferred. Stored upload
results retain local metadata privately; upload
responses omit that internal field.

UploadSession enters COMPLETING after complete byte receipt, before media
processing. Startup and periodic server recovery re-drive those durable sessions
using the existing upload/batch locks, without requiring another client request.
Existing federation recovery remains responsible for interrupted inbound jobs.

Thumbnail serving is implemented through contextual `/uploads/thumbnails/` URLs:
thread/sequence authorization checks the original, then its local metadata selects
the derivative. READY message responses hydrate local metadata; STUB responses do
not. Web images request thumbnails until the user selects the original. Native
hosts proxy thumbnail requests through Rust's authenticated derivative cache.
Client size gates and local thumbnail generation are removed.

Automated server-side orphan-thumbnail collection and historical backfill remain
out of scope. There is no eager thumbnail deletion, so shared derivatives cannot
be prematurely removed; a later collector must implement the publication and
reference synchronization described below before deleting any files.

## 1. Decisions and scope

- The server processes complete uploads before moving originals into final CAS
  storage. Images and videos receive server-generated static thumbnails.
- A federated receiver downloads the complete original, verifies its digest, and
  generates its own thumbnail through the same domain capability.
- Federation never transfers thumbnail bytes, thumbnail digests, or local
  thumbnail processing state. Its binary transport remains type-agnostic.
- Common file fields are top-level; media-specific fields live in `meta`.
  Single attachments and gallery items share one file contract.
- `meta.kind` is the discriminant: `IMAGE | VIDEO | AUDIO | FILE`. `mimeType`
  describes the format, not the rendering or processing policy. `FILE` is the
  fallback and may have a specific MIME such as `application/pdf`.
- Message `contentType` remains a presentation choice. Sending a video as FILE
  does not suppress detection, dimensions, duration, or thumbnail generation.
- Thumbnail storage is independent of original CAS storage. Thumbnail digests
  are SHA-256 hashes of the actual encoded thumbnail bytes.
- Client-generated image thumbnails and video frame capture are removed.
  Clients download thumbnails independently of original-file downloads.

Avatars, link-preview generation, and profile federation are outside this
attachment change. Existing unrelated media uses must keep working.

## 2. Current baseline

Relevant implementations:

- [Database schema](../../src/database/schema.ts): `MediaAsset` currently stores
  digest, bytes, deletion state, and timestamps, but no media metadata.
- [Attachment content](../../src/upload/file-content.ts): local message content
  uses CAS URLs, flat `w`, `h`, and `duration`; gallery items have top-level `kind`.
- [Upload service](../../src/upload/upload.service.ts): `resolveStagedPart`
  already hashes and inspects the complete staged original before
  `landStagedPart` moves it into CAS.
- [Metadata extraction](../../src/upload/media-metadata.service.ts): sharp and
  ffprobe already extract dimensions and duration. FILE currently skips probing.
- [Federation conversion](../../src/federation/federated-message-content.ts)
  and [wire schema](../../spec/v1/schema/message-content.schema.json): federation
  uses digest references, flat media fields, no attachment size, and strict keys.
- [S2S controller](../../src/federation/s2s.controller.ts): `/media/:digest`
  serves authenticated byte ranges as `application/octet-stream`.
- [Rust cache](../../src-tauri/src/media_cache.rs): image thumbnails are in
  `chat-thumbnails`; video captures are stored beside original cache entries.

Inbound messages can already be visible before original materialization finishes.
Keep that property; do not introduce a new timeline visibility barrier. See the
[existing availability model](./cas-media-download-status.md) and
[transfer management](./media-transfer-management.md). Their readiness conditions
will need to include the processing phase when this design is implemented.

## 3. Shared metadata vocabulary

```ts
type FileMeta =
  | { kind: 'IMAGE'; width: number; height: number }
  | { kind: 'VIDEO'; width: number; height: number; duration: number }
  | { kind: 'AUDIO'; duration: number }
  | { kind: 'FILE' };
```

Dimensions are positive safe integers in display orientation. Duration remains
positive finite seconds, preserving the existing federation unit and constraint.
Do not introduce `durationMs` in this change. Unknown fields are rejected.

For locally authored attachments, MIME and metadata come from server inspection,
not client claims or filename extensions. A FILE presentation intent must not
turn recognized media into uninspected generic bytes. Unsupported formats may be
classified as FILE; a transient decoder failure must not silently change kind.

Federated metadata is an immutable publisher assertion. Receiving nodes validate
its structure and inspect downloaded bytes for safe local processing. They never
rewrite signed/canonical message metadata with local probe results. A material
contradiction is a terminal materialization error; ordinary decoder tolerance
must be specified and tested rather than comparing floating-point duration with
strict equality. Local decoder support differences must not rewrite the message.

## 4. Federation file contract

```ts
interface FederationFile {
  digest: string;
  name: string;
  meta: FileMeta;
}

// Single IMAGE, VIDEO, AUDIO, or FILE message content:
type SingleFileContent = FederationFile;

// GALLERY message content:
interface GalleryContent { items: FederationFile[] }
```

The examples describe attachment bodies; existing message-envelope and quote
contracts remain separate and must be retained by the conversion code.

Changes from the existing wire format:

| Existing field | Target |
| --- | --- |
| Single attachment body | File object directly, no wrapper |
| `digest`, `name` | Common fields on the file object |
| `mimeType` | Removed from federation; retained locally |
| `width`, `height`, `duration` | Move under `meta` |
| Gallery item `kind` | Move to `meta.kind` |
| Single attachment type inferred only from contentType | Explicit `meta.kind` |

No `size`, URL, thumbnail, processing version, or node-local availability fields
are added to federation. MIME is removed from the wire. This is a structural
breaking change, not a new binary transport.
Gallery item order remains governed by the existing canonical ordering rules.

`GET /somfp/v1/media/:digest` continues to fetch originals only. Range handling,
message-coordinate authorization, resumability, and integrity checks are reused.
There is no federation thumbnail endpoint or thumbnail FileSyncProgress row.

Payload digests are calculated from the new canonical wire shape, using explicit
allowlisted projection. Never hash or serialize the enriched client response as
federation content. Forward bundles use the same thumbnail-free projection.

## 5. Local persisted content and client projection

The future client/local contract can use the same digest-based file structure
as federation (a direct single-file object or `items`). Until that separate client
migration, retain original URLs and flat `w`/`h` fields in local content. Preserve
publisher `meta` explicitly for media sent as FILE so retransmission does not lose
its actual category. Do not persist local thumbnails in `Message.content`.

This keeps canonical message content immutable while local derivatives can be
regenerated. Filename remains message-owned: identical original bytes may be
sent with different names. Do not store filenames on a digest-owned asset row.

The client API enriches each file:

```ts
interface Thumbnail {
  digest: string;
  size: number;
  mimeType: 'image/webp';
  width: number;
  height: number;
}

type LocalFileMeta =
  | (Extract<FileMeta, { kind: 'IMAGE' | 'VIDEO' }> & {
      thumbnail: Thumbnail | null;
    })
  | Extract<FileMeta, { kind: 'AUDIO' | 'FILE' }>;

interface LocalFile {
  digest: string;
  name: string;
  mimeType: string;
  size: number | null;
  meta: LocalFileMeta;
}
```

- A ready image/video has a non-null thumbnail. `null` means the local derivative
  is not available yet; existing availability state distinguishes pending/failure.
- Audio and generic files omit `thumbnail` entirely.
- `size` is verified original bytes when materialized. A known transfer total
  can be projected before completion; otherwise it is `null`, never a fabricated
  zero. Federation does not gain a size field merely to populate this projection.
- Metadata/thumbnail hydration uses batched digest lookups, not one query per item.
- Client persistence stores the enriched projection and refreshes it after server
  readiness events/reconciliation. Thumbnail changes do not mutate message hashes.
- Clients construct authenticated original/thumbnail request paths from digests.
  No filesystem path or origin URL is part of the file object.

Local upload session payloads retain the inspected identity/metadata and staged
processing result needed for recovery. They are not reusable federation DTOs.

## 6. Target database structure

### 6.1 Extend `MediaAsset` with local metadata JSON

Keep existing columns and original-blob semantics: `digest` primary key, `bytes`,
`isDeleted`, `createdAt`, `updatedAt`. Add one nullable `meta jsonb` column.
Do not add a separate `MediaAssetMetadata` table. Media-specific fields evolve
with formats and processing capabilities; they are not stable relational columns.

`meta` contains a completed, locally verified result:

```ts
type StoredMediaMetadata = { mimeType: string } & (
    | { kind: 'IMAGE'; width: number; height: number; thumbnail: Thumbnail }
    | {
        kind: 'VIDEO'; width: number; height: number; duration: number;
        thumbnail: Thumbnail;
      }
    | { kind: 'AUDIO'; duration: number }
    | { kind: 'FILE' }
);
```

Stored metadata is flat: MIME, kind, dimensions, duration, and the complete
thumbnail descriptor share one JSON object. Client projection moves MIME to the
common file fields and uses the remaining media fields as attachment `meta`.
No metadata version or processor version is stored.

Metadata extraction and thumbnail generation are one processing operation. Build
the complete result in staging, publish the required files, then write `meta` once
as a whole in the publication transaction. Do not first persist dimensions and
later patch in the thumbnail. Retries are idempotent; deliberate regeneration
replaces the complete result atomically rather than updating individual fields.

SQL NULL means no completed local inspection, not FILE. Do not store JSON null or
partial processing results. Add a basic CHECK that a non-null `meta` is a JSON
object. A shared runtime validator enforces the discriminated shape,
positive dimensions, positive finite duration, MIME syntax, and digest syntax on
write and read. JSON flexibility does not permit arbitrary unvalidated metadata.
Pending/retry/error state remains in durable execution records.

Create a partial expression index on
`meta #>> '{thumbnail,digest}'` where that expression is non-null. This is
used for reverse-reference checks and cleanup. There is no thumbnail entity table
or foreign key: publication and garbage collection must serialize on the same
thumbnail resource lock, then recheck references in the transaction. Publish the
thumbnail file before committing the complete referencing metadata object.
Database-backed concurrency tests must prove that cleanup cannot race a new
reference into a missing thumbnail. If metadata paths evolve, migrate the
expression index and every reference reader together.

Soft deletion does not automatically remove JSON references. Original reaping
must clear `meta` under the same resource protocol; soft-deleted originals never
authorize thumbnail reads. Immutable original bytes may be restored later and
processed again. Do not store thumbnail blobs in `MediaAsset` itself: existing
original-only CAS consumers must not resolve thumbnail digests into that directory.
Filename stays message-owned, not in digest-owned metadata. Local inspection facts
remain distinct from publisher metadata in Message.content.

### 6.2 No thumbnail entity table

Thumbnails are parent-owned local derivatives, not independent business assets.
Do not add `MediaThumbnail`. Store digest, size, MIME, and dimensions together in
`MediaAsset.meta.thumbnail`. The filesystem stores the actual bytes in the
separate thumbnail directory. Multiple originals can reference identical bytes.

A completed metadata result must reference published thumbnail bytes. Physical
deletion and reference removal use the same resource locks as publication.
Unreferenced files and crash leftovers are reclaimed after a grace period;
deletion is recoverable if database/file operations are interrupted. No eager
unlink on the first original deletion. Soft-deleted originals cannot authorize
thumbnail reads. Missing derivatives can be regenerated from the original through
the same processing operation without changing canonical message content.

### 6.3 Execution and accounting

Keep original-only `FileSyncProgress` accounting and identity. Do not reinterpret
its `kind` as `meta.kind`; it currently also represents batch/business categories.
Processing checkpoints must survive restart and cover original verification,
metadata extraction, thumbnail staging, filesystem publication, and DB commit.
Use existing upload/materialization durable execution mechanisms; their exact
checkpoint payload migration is an implementation step, not a second media model.

Existing original quotas retain their meaning. Track derivative disk usage
separately for storage maintenance; do not count a thumbnail as another user file
or duplicate the original transfer charge.

## 7. Storage, publication, and authorization

```text
uploads/msg-assets/<aa>/<bb>/<original-digest>
uploads/thumbnails/<aa>/<bb>/<thumbnail-digest>
```

Use bounded temporary files on the destination filesystem for atomic rename.
Both local upload and federated localization follow:

1. On resume, inspect the existing publication checkpoint and final original CAS
   file before requiring a staging file. A verified final original means byte
   transfer/publication is complete; do not re-download it merely because `meta`
   is missing. Existence alone must not bypass digest verification when no trusted
   verification/publication checkpoint is available.
2. If no verified final original exists, complete and hash the staged original;
   verify the expected digest when supplied.
3. If a live original already has a complete valid `meta`, reuse it and proceed
   directly to the remaining authorization/batch commit and task finalization.
   Do not re-extract metadata or regenerate thumbnails on ordinary resume.
4. Otherwise detect media, extract metadata, and generate a bounded static WebP
   as one operation. Normally process the staged original before final placement;
   recovery processes the final original when it was already moved. Missing
   staging bytes are not an error when a verified final original exists.
5. Persist/checkpoint the complete processing result;
   publish any not-yet-published original and thumbnail files idempotently.
6. Commit the original blob row, the complete `meta` JSON in one write, and
   required references.
7. Finish existing message/batch commit requirements, then mark the existing
   UploadSession/FileSyncProgress task successful and remove staging artifacts.

The existing task status remains the authority for upload/download completion.
A final original proves only the byte phase is complete; complete `meta` permits
skipping processing, but does not bypass task finalization or authorization.
A crash after the metadata commit resumes at finalization, not at generation.
Repair of externally missing/corrupt published files is a separate recovery case,
not a reason to regenerate derivatives on every ordinary resume.

Two renames and a database transaction are not jointly atomic. Recovery must
handle every boundary; no ready result may claim a missing blob. Expensive decode
runs outside database transactions and lifecycle locks. Deduplication reuses a
completed compatible processing result, but original presence alone is not proof
that a thumbnail exists. Regeneration must atomically replace the local relation
without changing canonical message content.

Expose thumbnails through an authenticated client resource handler, not an
unprotected static directory. Authorize a request using the parent original's
existing message/audience visibility and verify its thumbnail relation. Knowing
a thumbnail digest is insufficient. A shared thumbnail is readable only when an
authorized live parent reference exists. Preserve federation commit-time audience
checks and the established resource acquisition order. Prefer FOR NO KEY UPDATE
for non-key writes; physical deletion locks require explicit justification.

## 8. Processing and client behavior

Start with static WebP, maximum 960px long edge, no upscaling, corrected image
orientation and video rotation. Animated images use a static frame. Video capture
uses a documented bounded frame-selection recipe.
Set decoder concurrency, time, pixel, output-size, and stderr/stdout limits;
restrict ffmpeg to local inputs and necessary protocols, with no shell invocation.
Transient errors retry through durable execution; corrupt/unsupported media uses
explicit terminal-error or generic-file classification rules, never silent
inconsistent success.

Inbound timeline entries remain visible while originals download/process. Keep
existing pending/downloading/ready/failed external availability states initially;
processing is a non-ready internal phase even when all bytes have arrived. Ready
requires the completed processing result for every required attachment. A remote
video cannot have a local thumbnail until its full original has arrived.

Reuse the native `chat-thumbnails` directory with a new cache-key version and
origin/session isolation. Rust owns authenticated thumbnail downloads, dedup,
cancellation, digest verification, atomic writes, retries, and pruning. Kotlin
remains a platform adapter. Do not trust legacy original-keyed entries as new
server-generated thumbnail entries.

Lists, file cards, gallery items, and quote/detail previews request only the
thumbnail. Opening an original retains existing original-download/playback rules.
Thumbnail failure never silently falls back to downloading the original.

Remove client image resizing, post-original thumbnail warm-up, video frame
capture, loopback thumbnail upload capabilities, and associated adapter plumbing.
Preserve video Range caching and playback; those are not thumbnail-generation
mechanisms. Include dormant Android player code in the cleanup inventory.

## 9. Breaking-change rollout

This document does not amend the released wire schema by itself. Implementation
must update the specification, strict validators, conversion, canonical digest
vectors, forward bundles, compatibility declaration, and client DTOs together.
Follow [protocol governance](../../spec/GOVERNANCE.md); old peers must be explicitly
rejected or upgraded, not silently sent unrecognized fields.

The operator explicitly selected a database reset for this breaking change.
Keep the new metadata column and index in `0000_base.sql`; do not retain a data
conversion migration, legacy wire parser, or historical digest compatibility path.
The local development database is reset during development; deployment databases
must be reset by the operator before upgrade. Existing message history and upload
checkpoints are not migrated. Client caches must be invalidated or cleared at
cutover so they cannot reuse coordinates from the reset database.

This reset exception is specific to the operator-authorized baseline change; it
does not establish a general policy of rewriting deployed migrations.

## 10. Implementation order and acceptance

1. Apply the coordinated protocol/schema cutover with a database reset. Add shared
   discriminated validators and conversion tests for the contracts above.
2. Add the metadata JSON column/index, storage, protected thumbnail reads, and
   lifecycle tests.
3. Build one domain-owned completed-file processor and resumable publication path.
4. Integrate local upload and inbound federation; preserve original-only transport.
5. Project local metadata into client responses and reconcile readiness changes.
6. Implement Rust thumbnail download/cache, migrate all UI surfaces, remove client
   generation and obsolete loopback endpoints.
7. Backfill/migrate, update deployment dependencies, and run end-to-end validation.

Required tests include:

- Strict local/wire shapes; no local thumbnail or size leaks into federation.
- Stable canonical payload digest before/after local thumbnail regeneration.
- IMAGE/VIDEO/AUDIO/FILE and mixed galleries, including media sent as FILE.
- Full original federation fetch followed by local generation; no S2S thumbnail
  requests, and no thumbnail required from the publisher.
- Rotated/animated media, malformed inputs, decoder bounds, timeout and retry.
- Dedup, same bytes with different names, concurrent publication, restart at each
  filesystem/DB boundary, and shared-thumbnail garbage collection.
- PostgreSQL-backed authorization/revocation/publication/cleanup races.
- Pending inbound metadata with unknown size, ready-state refresh, terminal failure.
- Android account/origin switch during downloads and legacy cache invalidation.
- List rendering downloads thumbnails only, never original image/video bytes.

The remaining sections describe the complete target; only the implementation
slice above is implemented at this stage.
