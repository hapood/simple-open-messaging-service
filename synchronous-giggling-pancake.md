# Plan: Phase 7 — GALLERY multi-file messages + unified type-agnostic upload

> **Status (2026-08-07):** Phases 1–6 of the download-inbox plan are DONE and committed on `dev`
> (`03270b7b` P1–4, `b9340ff3` P5, `284877b6` P6). Build green + 696/696 unit green. This file now
> drives **Phase 7 only**. Session memory: `download-inbox-implementation.md`.

## Context

Phase 7 closes the outbound side of federation design doc **§12.3 "出站与入站统一"** (unify outbound
onto the same `PendingMedia` + `FileSyncProgress` + batch-barrier machinery inbound already uses) AND
delivers multi-file messages. The user's locked decisions:

1. **Full multi-file feature** (not machinery-only).
2. **New `ContentType` value `GALLERY`** — a multi-asset bundle. Single-file sends keep their existing
   type (`IMAGE`/`VIDEO`/`FILE`/`AUDIO`) and single-object content shape (rendering unchanged).
3. **Upload layer unified + breaking** — the 4 typed endpoints (`/upload`, `/upload/file`, `/upload/video`,
   `/upload/audio`) are removed. **Decoupled, type-agnostic upload**: one endpoint accepts 1 or N file
   parts, magic-byte-detects each file's family, returns `{digest,url,size,family,name?,mimeType?}` per
   part. **Type is a message-level concern, not an upload-transport concern** — this matches what the CAS
   layer already does internally (`saveCas` is type-agnostic) and what federation inbound already does
   (download→CAS→typed message). No backward compatibility for the old endpoints.

**Why decouple (not merge into one polymorphic endpoint):** the 4 endpoints differ on more than path —
per-type size caps (image 10MB / file 50MB / video 100MB / audio 50MB), per-type magic-byte validation
(image `isImage()` + HEIC→FILE fallback; video/audio family gate; file open), image `w/h` form fields,
per-type payload shape. Collapsing into one polymorphic handler that branches on detected type for all of
these is a fatter, harder-to-audit contract and loses clean per-type cap enforcement. Decoupling is the
principled unification and is GALLERY-native.

## Locked design

### Send flow (stage-first, matches existing pattern + inbound model)

1. **`POST /send-media`** stages a batch: `PendingMedia(direction='OUTBOUND', contentType, clientMessageId,
   fileCnt=N, content='{}', digest=null)` + membership check. For GALLERY, `contentType='GALLERY'`,
   `fileCnt=N`. **No quota tick here** (moved to upload — see below). Returns `{clientMessageId}`.
2. **`POST /upload`** (type-agnostic, called N times in parallel for GALLERY, once for single), each with
   header `x-client-message-id` (= the batch id) + companion form fields per part
   `{name, mimeType, w?, h?, duration?}`:
   - `saveCas` → digest; detect family (`isImage`/`detectMedia`); build per-file payload
     `{digest,url,size,family,name?,mimeType?,w?,h?,duration?}`.
   - Upsert `FileSyncProgress(direction='OUTBOUND', batchId, digest, status='SUCCEEDED', kind=<family>,
     payload=<the per-file payload jsonb>)` — `onConflictDoNothing` (idempotent retry).
   - Quota: `assertWithinByteCap(userId, familyToCategory(family), bytes)` + tick 1 count by family
     (replaces the old stage-time tick; correctly handles mixed GALLERY items).
   - **Barrier check + promote** (see below).
3. **Promote at barrier** (one tx): re-check `count(FileSyncProgress SUCCEEDED for batch) == fileCnt`;
   if met, `DELETE FROM pendingMedia WHERE id=$batch RETURNING *` as the **win-guard** (only one of N
   racing uploads wins; losers get 0 rows → no-op) → assemble content → insert `Message` + N
   `messageAsset` rows → delete the batch's `FileSyncProgress` rows → commit → `fanout.dispatch`.

### Content shapes

- **Single (N=1):** unchanged per-type object — IMAGE `{url,w,h,size}`, FILE `{url,name,size,mimeType}`,
  VIDEO `{url,name,size,mimeType,w,h,duration}`, AUDIO `{url,name,size,mimeType,duration}`.
- **GALLERY (N≥1):** `{items:[{kind:'IMAGE'|'VIDEO'|'FILE'|'AUDIO', url, name?, size, mimeType?, w?, h?,
  duration?}, ...]}`. Item order = digest-sorted (deterministic; upload arrival order is unreliable).
- **Why `kind` per item:** GALLERY allows mixed types; each item self-describes so the renderer picks the
  right row component. `extractDigests` (regex scan of the whole JSON) already finds all N digests in this
  shape — verified during exploration. `contextualizeCasUrls` likewise rewrites all N URLs.

### Outbound vs inbound barrier (both unified on FileSyncProgress)

- **Inbound** (done): pre-creates N `PENDING` rows (digests known from peer content); barrier
  `NOT EXISTS (status != SUCCEEDED)`.
- **Outbound** (this phase): digests unknown at stage time → rows born `SUCCEEDED` at each upload; barrier
  `count(SUCCEEDED) == fileCnt`. `FileSyncProgress.payload jsonb` (new, nullable, outbound-only) carries
  the per-file payload so promote can assemble content without re-deriving display metadata from CAS.

### GC liveness

Outbound N-file liveness moves from `pendingMedia.digest` (single, can't hold N) to the N
`FileSyncProgress(SUCCEEDED)` rows. The Phase-5 reap query already checks `FileSyncProgress` liveness
(`media-asset-gc.service.ts:557-561`), so outbound staged digests are protected automatically once this
phase writes the rows. `pendingMedia.digest` becomes vestigial for outbound (leave the column; don't drop).

## Schema (migration `0032_gallery_and_upload.sql`)

- `ALTER TYPE "ContentType" ADD VALUE 'GALLERY';`
- `ALTER TABLE "FileSyncProgress" ADD COLUMN "payload" jsonb;` (nullable, outbound-only)
- Update `src/database/schema.ts`: add `'GALLERY'` to `contentType` pgEnum; add `payload: jsonb()` to
  `fileSyncProgress`. Update `src/database/enums.ts` `ContentType` const + type.
- Note: `migrate-db.ts` runs each `.sql` checksum-verified; `ALTER TYPE ... ADD VALUE` is tx-safe PG12+.

## Sub-phases (each build-green + committed on `dev`)

### 7a — Schema scaffolding (additive, no behavior change)
- Migration `0032`; `schema.ts` + `enums.ts` edits above. Build green, zero behavior change.

### 7b — Type-agnostic upload + single-file (N=1) path rewritten
- **`src/upload/upload.controller.ts`**: replace the 4 handlers with ONE `POST upload` that accepts
  multipart 1-or-N parts. New `consumeParts(req)` in `upload.service.ts` (multi-file; iterate `req.parts()`,
  buffer each file part up to the global cap, collect companion fields per part) — supersedes
  `consumeSingle`/`consumeChatImage`/`consumeFile`/`consumeVideo`/`consumeAudio` (delete the typed
  consumers). Keep `consumeImage` (avatar) + `/upload/avatar` untouched (separate, sharp, not CAS).
- Per part: detect family (`isImage` else `detectMedia` else `'FILE'`), `saveCas`, build payload. Apply
  **global per-part cap** (drop per-type `MAX_IMAGE/FILE/VIDEO/AUDIO_BYTES`; rely on the 100MB multipart
  ceiling + per-account byte quota). HEIC/AVIF/non-image bytes under an image intent → family `'FILE'`
  (the server decides; no client lie).
- **`src/upload/upload.service.ts`**: `save`/`saveFile`/`saveMedia` collapse into one type-agnostic
  `savePart(family, name, mimeType, buf)` returning `{digest,url,size,family,name?,mimeType?}`.
  `publishResumable` drops its `contentType` arg — detects family from bytes.
- **`src/upload/resumable-upload.service.ts`**: session becomes type-agnostic — drop the `contentType`
  validation gate (`:64`) and the per-type size-cap switch (`:68-83`); keep 1-file-per-session (N sessions
  share one `clientMessageId`/batch). `complete` upserts `FileSyncProgress(SUCCEEDED,payload)` + barrier
  instead of calling `promoteStaged` directly.
- **`src/message/message.service.ts`**: rewrite the N=1 promote to the barrier model — replace
  `linkStagedDigest` + `promoteStaged` with `markOutboundFileSucceeded(clientMessageId, digest, payload,
   userId)` (upsert FileSyncProgress) + `promoteOutboundBatchIfReady(clientMessageId)` (barrier + win-guard
  tx). For N=1 content stays the single-object shape. **Fix `extractDigests(content)[0]` → insert ALL
  digests** (`:688`; mirrors `writeMsgToThread:373-382` and `promotePendingMessage:5180-5185`).
- **Quota**: move the count tick from `stageMedia`/`sendMedia` (`message.controller.ts:524-529`) to the
  upload path (per file, by detected family). `stageMedia` keeps only the membership/quota-reservation
  intent + PendingMedia insert.
- **`src/dto/message.dto.ts`**: `SendMediaDto` gains optional `fileCnt` (default 1) + accepts `GALLERY` in
  `@IsIn`. Per-file `meta` moves off this DTO (rides with each upload part).
- Update tests: `upload.controller.spec.ts`, `upload.service.spec.ts`, `resumable-upload.e2e-spec.ts`.
- **Exit criteria:** single-file IMAGE/FILE/VIDEO/AUDIO sends still produce one `Message` with correct
  content shape; old endpoints gone; build + unit green.

### 7c — GALLERY multi-file (N>1)
- `SendMediaDto` `contentType='GALLERY'` + `fileCnt=N` (+ optional `assets` declaring intended kinds as
  hints, server-verified). `stageMedia` creates `PendingMedia(GALLERY, fileCnt=N)`.
- `promoteOutboundBatchIfReady`: when `stage.contentType==='GALLERY'`, assemble `content = {items:
  payloads.sort(byDigest).map(toItem)}`; else single-object. Insert `Message(GALLERY)` + N `messageAsset`.
- N parallel `POST /upload` calls (same `x-client-message-id`) → N `FileSyncProgress(SUCCEEDED)` → Nth
  triggers promote via the win-guard tx.
- **Targeted unit test** (Drizzle mocked, mirroring `message.service.spec.ts` style): simulate N
  `markOutboundFileSucceeded` calls → assert exactly one `Message` insert with N `messageAsset` rows +
  PendingMedia/FileSyncProgress cleanup; assert a concurrent double-promote is idempotent (win-guard).

### 7d — `ContentType` branch plumbing (drive GALLERY through the (A) sites)
From the exploration map, the must-change backend sites:
- `derivePreview` (`message.service.ts:119-174`) — add `case GALLERY` → `'[Gallery]'` (or item count).
- `writeMsgToThread` media gate (`message.service.ts:366-372`) — add `|| GALLERY` (so direct/forwarded
  GALLERY writes messageAsset rows).
- `media-access.service.ts:30-34` — add `|| GALLERY` (CAS URL authz).
- `searchMessages` (`message.service.ts:1013-1019`) — add GALLERY; search needs
  `jsonb_array_elements(content->'items')` for item names (not `content->>'name'`).
- `deriveReplyPreview` (`message.service.ts:790-793`) — GALLERY → first item's URL/thumb.
- `SendMediaDto` `@IsIn` (`message.dto.ts:219-223`), `message.controller.ts:527` quota category.
- Generic (no change, verified): `extractDigests`, `contextualizeCasUrls`, `attachMediaStatus:926-929`,
  `promotePendingMessage`, `localizeMedia`, `isMessageMediaReady`, message-fanout, SSE.

### 7e — Federation inbound GALLERY
- `isMediaContentType` (`federation.service.ts:4884`) — add `GALLERY` (else inbound GALLERY bypasses
  staging/localization).
- `fileSyncKindFor` (`:4895`) — `case GALLERY: return 'BUNDLE'` (the reserved `FileSyncKind` value).
- `mediaCategory` (`:4912`) + inline classify (`:5303`) — GALLERY → `'largeFiles'` (conservative) or
  per-item; keep consistent. Staging loop (`:4698-4709`) already creates one PENDING row per digest —
  GALLERY works as-is. `promotePendingMessage` already contextualizes + inserts all digests — works as-is.
- e2e: extend `test/federation.e2e-spec.ts` with an inbound GALLERY localize case.

### 7f — Forwarding GALLERY (may defer one round if scope bites)
- `forward-bundle.service.ts`: `directTypes` (`:147`) + `GALLERY`; relax `digests.length !== 1`
  (`:176`) for GALLERY; `assetsFromContent` (`:921`) parse `items[]` per-item kind; `summaryLine`
  (`:1013`); `localizeForwardMediaContent` (`:1136`) iterate items.

## Frontend impact (REQUIRED follow-up — breaking backend breaks the app until landed)

Tracked separately (Angular, PC/mobile split). Affected sites from the exploration map:
- Upload client rewrite to the type-agnostic `POST /upload` (drop the 4 typed calls).
- `contentType` union: `web/src/app/components/message-cards/chat-item.ts:102`; `create-item.ts:118`
  (route GALLERY to a gallery-row component); `merge-items.ts:29` (exclude GALLERY from album-merge).
- Previews: `thread-store.service.ts:1312` (`rawPreview`), `thread-list.component.ts:137`
  (`PREVIEW_MARKERS`), `message-copy.ts:20`.
- Forward view: `forward-detail.component.ts:50,257,308`.
- `message.service.ts:99,116` (`sendMedia`/`queryMediaStages` contentType).

## Reused utilities (do not reimplement)
- `saveCas` (`upload.service.ts:461`) — type-agnostic CAS write (already returns `{url,digest,ext,size}`).
- `isImage` (`upload.service.ts:409`) + `detectMedia` (`media-sig.ts:123`) — family detection.
- `extractDigests`/`extractDigestEntries` (`file-content.ts:136,145`), `contextualizeCasUrls`
  (`cas-url.ts:5`), `isUniqueViolation` (`database-error.ts:39`), `sanitizeName` (`upload.service.ts:821`).
- `KeyedMutex` (`common/keyed-mutex.js`) — optional per-batch promote serialization if the win-guard tx
  proves insufficient (prefer the DELETE-win-guard; no mutex needed).
- The Phase-6 inbox admin/GC paths (`listInboxState` is INBOUND-only by design — outbound staging stays
  user-facing via `queryMediaStages`, not an admin inbox).

## Verification
- **Each sub-phase:** `npm run build` green; affected unit specs pass; commit on `dev`.
- **7b:** single-file send e2e (adapt `resumable-upload.e2e-spec.ts`) → one `Message`, correct content
  shape, old endpoints 404.
- **7c:** unit test — N `markOutboundFileSucceeded` → one `Message` + N `messageAsset`; concurrent
  double-promote idempotent.
- **7d/7e:** `searchMessages` finds GALLERY item names; inbound GALLERY localizes then promotes.
- **Debt to clear alongside:** apply migrations 0029–0032 to the dev DB; federation e2e still blocked by
  the 2 pre-existing `localizeForwardAssets` "Expected 4 arguments, but got 3" errors (~federation.service.ts
  :4596/5373) — separate issue, user previously chose not to guess the auth-arg fix.

## Out of scope (future)
- Frontend GALLERY render polish (album layout) — covered by the frontend follow-up above.
- Background scheduler for crashed `DOWNLOADING` (§12.1) — still admin-driven via the Phase-6 UI.
- Per-type size caps (intentionally dropped for the type-agnostic upload; global cap + quota backstop).
