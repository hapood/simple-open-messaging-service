import { AVATAR_URL_RE } from './avatar-path.js';
import { saveContentAddressedBuffer } from './cas-storage.js';
import { Injectable } from '@nestjs/common';
import {
  existsSync,
  writeFile,
  readFile,
  rename,
  mkdir,
  createReadStream,
  unlink,
  stat,
  appendFile,
  truncate,
} from 'fs';
import { basename, dirname, join } from 'path';
import { createHash } from 'crypto';
import { promisify } from 'util';
import sharp from 'sharp';
import type { FastifyRequest } from 'fastify';
import { dataDirectory } from '../common/data-directory.js';
import {
  MAX_FILE_NAME_LEN,
  parseFileExt,
  resolveFileType,
  type OutboundFilePayload,
} from './file-content.js';
import { ContentType } from '../database/enums.js';
import { MediaAssetService } from './media-asset.service.js';
import { detectMedia, type DetectedMedia } from './media-sig.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { FileSizeLimitError } from './file-size-limit.js';
import { MediaMetadataService } from './media-metadata.service.js';

export class InvalidUploadMediaError extends Error {}

const writeFileAsync = promisify(writeFile);
const readFileAsync = promisify(readFile);
const renameAsync = promisify(rename);
const mkdirAsync = promisify(mkdir);
const unlinkAsync = promisify(unlink);
const statAsync = promisify(stat);
const appendFileAsync = promisify(appendFile);
const truncateAsync = promisify(truncate);

/** Allowed image mimetype → on-disk extension (whitelist + landing-ext mapping). */
const IMG_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * consumeImage return: success carries buffer + width/height; failure is discriminated by reason
 * (the controller maps reason → business code). The size cap is backed by main.ts's
 * @fastify/multipart limits.fileSize → reason 'too-large'.
 */
export type ConsumedImage =
  | {
      kind: 'file';
      mimetype: string;
      buffer: Buffer;
      w: number;
      h: number;
    }
  | { kind: 'rejected'; reason: 'no-file' | 'wrong-type' | 'too-large' };

/**
 * Image / media upload service.
 *
 * Message attachments are inspected from sequential staging files; media metadata and family
 * are derived from the bytes before the batch is published.
 *
 * Avatars are fully validated against the federation byte, format, and dimension limits, then stored
 * byte-for-byte as one file. Invalid or oversized input is rejected rather than transformed.
 *
 * Design:
 * - @fastify/multipart in-memory mode: file → buffer, magic-number-checked before landing on disk.
 * - Two authenticity checks: consumeImage checks the mimetype (coarse filter, rejects before the
 *   buffer is materialized) + isImage reads the real file-header magic bytes (anti-forgery).
 *
 * Storage lives below the configured application data directory, aligned with bootstrap.ts's
 * @fastify/static prefix '/uploads/'.
 * Switching to object storage (S3/OSS/MinIO) in production requires changing the CAS/avatar
 * write target + url generation — the interface contract stays the same.
 */
@Injectable()
export class UploadService {
  readonly uploadDir = dataDirectory('uploads');
  readonly casDir = dataDirectory('cas');
  /** Transient CAS ingest artifacts: the resumable writer's `.part`/`.resume.json`/`.complete` and the
   *  `*.tmp` crash-leftovers from the buffer publish paths. Kept out of the shard tree so the formal CAS
   *  dirs hold only published blobs and the GC temp pass is a single flat scan (design doc §12.4/§12.6). */
  readonly casTmpDir = dataDirectory('cas', 'tmp');
  private readonly casIngestLocks = new KeyedMutex();

  constructor(
    private readonly mediaAsset: MediaAssetService,
    private readonly mediaMetadata: MediaMetadataService,
  ) {}

  /** Federation avatar edge and pixel caps. Local storage accepts exactly the wire-safe shape. */
  static readonly MAX_AVATAR_EDGE = 512;
  static readonly MAX_AVATAR_PIXELS =
    UploadService.MAX_AVATAR_EDGE * UploadService.MAX_AVATAR_EDGE;
  /** Avatar buffer cap, independent of message attachment policies. */
  static readonly MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  /** Federation's strict pre-decode Base64 ceiling. */
  static readonly MAX_AVATAR_WIRE_B64_LEN = 1024 * 1024;
  /** Maximum decoded bytes represented by the federation Base64 ceiling. */
  static readonly MAX_AVATAR_WIRE_BYTES =
    (UploadService.MAX_AVATAR_WIRE_B64_LEN / 4) * 3;

  /**
   * Consume a single image from multipart/form-data: whitelist the image mimetype, cap at
   * MAX_IMAGE_BYTES, and surface the frontend-supplied w/h fields. Magic-number and sharp
   * decoding stay the caller's job (two independent authenticity checks). Delegates the
   * multipart draining to consumeSingle so the backpressure-safe loop lives in exactly one place.
   */
  async consumeImage(req: FastifyRequest): Promise<ConsumedImage> {
    const r = await this.consumeSingle(req, {
      allowed: (mimetype) => mimetype in IMG_EXT,
      maxBytes: UploadService.MAX_IMAGE_BYTES,
    });
    if (r.kind === 'rejected') {
      return { kind: 'rejected', reason: r.reason };
    }
    return {
      kind: 'file',
      mimetype: r.mimetype,
      buffer: r.buffer,
      w: Number(r.fields.w) || 0,
      h: Number(r.fields.h) || 0,
    };
  }

  /**
   * Single-file multipart consumer for avatars. Owns the @fastify/multipart draining logic so the backpressure bug
   * below can never again diverge across routes:
   *
   * Each file part MUST be drained inside the loop. The parser can only find the next part (or
   * EOF) by reading through the current file's stream; deferring toBuffer() to after the loop
   * leaves the stream unconsumed, and once the body spans more than one read chunk (>~128KB)
   * backpressure stalls the parts() iterator forever — the request hangs with no backend log.
   * (Tiny files happen to fit one chunk, which is why this regressed silently.)
   *
   * Single-file contract: only the first file is kept; extras are resumed so the parser can
   * advance. `allowed`, when present, is a coarse mimetype whitelist that rejects BEFORE buffering
   * (the image route uses it — browsers set image MIME reliably, so it avoids buffering a huge
   * non-image part). It is forgeable, so the image route re-verifies on the buffer via isImage;
   * the generic-file route omits `allowed` entirely (the open model accepts any type, with
   * security at the serving layer). `maxBytes` is the explicit per-route cap beneath the global
   * multipart ceiling. The filename is captured when present (the generic-file route requires it;
   * image routes ignore it). Non-file parts are collected into `fields` (bounded by multipart
   * field-size limits).
   */
  private async consumeSingle(
    req: FastifyRequest,
    opts: { allowed?: (mimetype: string) => boolean; maxBytes: number },
  ): Promise<
    | {
        kind: 'file';
        mimetype: string;
        buffer: Buffer;
        filename?: string;
        fields: Record<string, string>;
      }
    | { kind: 'rejected'; reason: 'no-file' | 'wrong-type' | 'too-large' }
  > {
    let file:
      | { mimetype: string; buffer: Buffer; filename?: string }
      | undefined;
    const fields: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type !== 'file') {
        fields[part.fieldname] = String(part.value);
        continue;
      }
      // Single-file contract: drain extras so the parser can advance, then ignore them.
      if (file) {
        part.file.resume();
        continue;
      }
      // Coarse mimetype filter (forgeable; image route only): reject before buffering. Omitted by
      // the generic-file route, which validates content (extension + magic bytes) after buffering.
      if (opts.allowed && !opts.allowed(part.mimetype)) {
        part.file.resume();
        return { kind: 'rejected', reason: 'wrong-type' };
      }
      // Drain NOW, inside the loop (see method doc) — never defer toBuffer() past it.
      let buffer: Buffer;
      try {
        buffer = await part.toBuffer();
      } catch {
        // Over the multipart fileSize limit (RequestFileTooLargeError) or a stream error.
        return { kind: 'rejected', reason: 'too-large' };
      }
      // Explicit per-route cap below the global multipart ceiling: reject rather than buffering
      // all the way to the limit.
      if (buffer.length > opts.maxBytes) {
        return { kind: 'rejected', reason: 'too-large' };
      }
      file = {
        mimetype: part.mimetype,
        buffer,
        ...(part.filename ? { filename: part.filename } : {}),
      };
    }

    if (!file) return { kind: 'rejected', reason: 'no-file' };
    return { kind: 'file', ...file, fields };
  }

  /**
   * Shared family/ext/mime/name resolution for one outbound file (Phase 7). Used by
   * {@link resolveStagedPart} to gate each part on the staged `intent`:
   *   - IMAGE intent whose bytes are not an inline-renderable image (HEIC/AVIF/…) → downloadable FILE,
   *     signaling `overrideContentType: FILE`;
   *   - VIDEO/AUDIO intent rejects a non-matching container (AUDIO accepts the recorder-shared
   *     webm/mp4 containers, mapped to audio);
   *   - GALLERY detects freely (a webm in a bundle is VIDEO by signature — an accepted limitation).
   * Returns the detected family, the trusted on-disk ext, the display MIME (omitted for IMAGE), and the
   * sanitized display name.
   */
  private resolveOutboundFile(
    detected: DetectedMedia | null,
    intent: ContentType,
    filename: string,
    declaredMime: string,
  ): {
    family: OutboundFilePayload['family'];
    ext: string;
    mime?: string;
    name: string;
    overrideContentType?: ContentType;
  } {
    let family: OutboundFilePayload['family'];
    let ext: string;
    let overrideContentType: ContentType | undefined;
    switch (intent) {
      case ContentType.IMAGE:
        if (detected?.family === 'image') {
          family = 'IMAGE';
          ext = detected.ext;
        } else {
          // Unsupported/corrupt image formats are still safe as attachment downloads. Keep the
          // original display metadata, store them as FILE, and atomically override the staged
          // message type at promotion so no client tries to render unverified bytes inline.
          family = 'FILE';
          ext = parseFileExt(filename) || 'bin';
          overrideContentType = ContentType.FILE;
        }
        break;
      case ContentType.FILE:
        family = 'FILE';
        ext = parseFileExt(filename) || 'bin';
        break;
      case ContentType.VIDEO:
        if (!detected || detected.family !== 'video') {
          throw new InvalidUploadMediaError('invalid video');
        }
        family = 'VIDEO';
        ext = detected.ext;
        break;
      case ContentType.AUDIO: {
        const sharedAsAudio =
          detected?.family === 'video' &&
          (detected.ext === 'webm' || detected.ext === 'mp4');
        if (!detected || (detected.family !== 'audio' && !sharedAsAudio)) {
          throw new InvalidUploadMediaError('invalid audio');
        }
        family = 'AUDIO';
        ext = detected.ext;
        break;
      }
      case ContentType.GALLERY:
      default:
        if (detected?.family === 'image') {
          family = 'IMAGE';
          ext = detected.ext;
        } else if (detected?.family === 'video') {
          family = 'VIDEO';
          ext = detected.ext;
        } else if (detected?.family === 'audio') {
          family = 'AUDIO';
          ext = detected.ext;
        } else {
          family = 'FILE';
          ext = parseFileExt(filename) || 'bin';
        }
        break;
    }
    let mime: string | undefined;
    let name = this.sanitizeName(filename, ext);
    if (family === 'FILE') {
      const ft = resolveFileType(filename, declaredMime);
      mime = ft.mime;
      if (ext === 'bin' && ft.ext) ext = ft.ext;
      name = this.sanitizeName(filename, ext);
    } else if (family === 'VIDEO') {
      mime = `video/${ext}`;
      // VIDEO keeps the client's original display extension; the CAS blob uses the detected ext.
      name = this.sanitizeName(filename, '');
    } else if (family === 'AUDIO') {
      mime = `audio/${ext}`;
      name = this.sanitizeName(filename, '');
    }
    return { family, ext, mime, name, overrideContentType };
  }

  /**
   * Second-pass magic-number check: read the real file-header bytes to confirm the declared image
   * format. consumeImage's coarse filter only looks at the client-declared mimetype (forgeable); this
   * check cannot be bypassed.
   */
  isImage(mimetype: string, buf: Buffer): boolean {
    if (!buf || buf.length < 12) return false;
    switch (mimetype) {
      case 'image/png':
        return (
          buf[0] === 0x89 &&
          buf[1] === 0x50 &&
          buf[2] === 0x4e &&
          buf[3] === 0x47
        );
      case 'image/jpeg':
        return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      case 'image/gif':
        return (
          buf[0] === 0x47 &&
          buf[1] === 0x49 &&
          buf[2] === 0x46 &&
          buf[3] === 0x38
        );
      case 'image/webp':
        return buf.slice(8, 12).toString('ascii') === 'WEBP';
      default:
        return false;
    }
  }

  /**
   * Content-addressed save: sha256 → data/cas/<digest[0:2]>/<digest[2:4]>/<digest>.
   *
   * The blob is atomically published via a tmp file + rename on the same filesystem; the MediaAsset
   * row is written after the rename. Two concurrent writers of the
   * same digest produce byte-identical files, the second rename overwrites the first, and there is
   * no TOCTOU window (no existsSync pre-check). `ext` is the trusted on-disk extension (the caller decides
   * the source: magic-byte-derived for images/video/audio, sanitized client-name-derived for files).
   */
  /** The extensionless content-addressed path for a digest. Shared by saveCas (buffer) and
   *  saveCasFromStream (streaming) so both land byte-identical files at the identical location. */
  private casShardPath(digest: string): { abs: string; url: string } {
    const shard = join(digest.slice(0, 2), digest.slice(2, 4), digest);
    return {
      abs: join(this.casDir, shard),
      url: `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`,
    };
  }

  private async saveCas(
    ext: string,
    buf: Buffer,
  ): Promise<{ url: string; digest: string; ext: string; size: number }> {
    const digest = await saveContentAddressedBuffer(
      buf,
      (hash) => this.casShardPath(hash).abs,
      this.casTmpDir,
    );
    await this.mediaAsset.publishReady(digest, BigInt(buf.length));
    const { url } = this.casShardPath(digest);
    return { url, digest, ext, size: buf.length };
  }

  /**
   * Resolve a completed resumable-upload temporary file WITHOUT publishing it (batch-commit model).
   * Streams the tmp file once to SHA-256 it + capture the leading magic bytes, resolves the outbound
   * family/ext/mime/name through the shared resolver (so buffered and resumable uploads gate identically
   * on the staged `intent`), and returns the per-file
   * payload the batch commit assembles message content from. The bytes stay in the resumable staging
   * directory; landing into the CAS shard tree happens later, idempotently, at the batch barrier via
   * {@link landStagedPart}.
   */
  async resolveStagedPart(
    tmpPath: string,
    intent: ContentType,
    originalName: string,
    declaredMime: string,
  ): Promise<{
    digest: string;
    payload: OutboundFilePayload;
    overrideContentType?: ContentType;
  }> {
    const info = await statAsync(tmpPath);
    const hash = createHash('sha256');
    const headerChunks: Buffer[] = [];
    let headerBytes = 0;
    for await (const chunk of createReadStream(tmpPath)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      if (headerBytes < 4096) {
        const part = buffer.subarray(0, 4096 - headerBytes);
        headerChunks.push(part);
        headerBytes += part.length;
      }
    }
    const header = Buffer.concat(headerChunks);
    const resolved = this.resolveOutboundFile(
      detectMedia(header),
      intent,
      originalName,
      declaredMime,
    );
    const metadata = await this.mediaMetadata.fromFile(
      tmpPath,
      resolved.family,
    );
    const digest = hash.digest('hex');
    const payload: OutboundFilePayload = {
      digest,
      url: this.casShardPath(digest).url,
      size: info.size,
      family: resolved.family,
      name: resolved.name,
      ...(resolved.mime !== undefined ? { mimeType: resolved.mime } : {}),
      ...metadata,
    };
    return {
      digest,
      payload,
      ...(resolved.overrideContentType
        ? { overrideContentType: resolved.overrideContentType }
        : {}),
    };
  }

  /** Shard-tree destination for a digest. Public read-only view for the batch-commit orchestrator. */
  casTarget(digest: string): { abs: string; url: string } {
    return this.casShardPath(digest);
  }

  /** True iff the formal CAS shard tree already holds this digest (dedup / prior landing). */
  casShardExists(digest: string): boolean {
    return existsSync(this.casShardPath(digest).abs);
  }

  /**
   * Land a staged temporary file into its CAS shard, idempotently. Same-filesystem rename keeps the
   * landing atomic; a concurrent or repeat landing of the identical digest is a harmless no-op
   * (content addressing makes last-writer-wins byte-identical). Returns 'dedup' when the shard
   * already exists, 'landed' after a successful rename. Throws 'staged part lost' when neither the
   * source nor the destination exists — the caller must fail that part (never commit a DB claim for
   * bytes that are not on disk; the MediaAsset row is the durable liveness claim).
   */
  async landStagedPart(
    tmpPath: string,
    digest: string,
  ): Promise<'landed' | 'dedup'> {
    const { abs } = this.casShardPath(digest);
    await mkdirAsync(dirname(abs), { recursive: true });
    if (existsSync(abs)) return 'dedup';
    try {
      await renameAsync(tmpPath, abs);
      return 'landed';
    } catch (error) {
      if (existsSync(abs)) return 'dedup'; // lost the rename race to an identical digest
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error('staged part lost');
      throw error;
    }
  }

  /** Store a server-generated WebP in the shared CAS and expose its digest to non-message owners. */
  async saveGeneratedWebp(
    buf: Buffer,
  ): Promise<{ url: string; digest: string; size: number }> {
    const saved = await this.saveCas('webp', buf);
    return { url: saved.url, digest: saved.digest, size: saved.size };
  }

  /** Resolve immutable CAS bytes for an authenticated semantic serving endpoint. */
  casPath(digest: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(digest)) return null;
    return this.casShardPath(digest).abs;
  }

  /**
   * Streaming CAS ingest (federation design doc §12.4): land a media asset fetched from a federated
   * peer in resumable chunks WITHOUT buffering the whole file in memory. Consumes an ordered async
   * iterable of byte chunks (the federation transport yields one fully-accumulated Range unit at a
   * time, so the write is atomic per chunk — a dropped chunk is discarded upstream and re-fetched,
   * never re-written here), appends them to a tmp `.part` while incrementally hashing, then on
   * completion verifies the digest === the peer-advertised `expectedDigest` (the corruption/tamper/
   * truncation backstop) and publishes the blob. Same content as a local upload — byte-identical on
   * disk, served same-origin. Idempotent: a re-fetch of the same digest re-publishes the live row.
   *
   * Crash-safety (DB-first + `.complete` marker). All transient artifacts live in the CAS tmp dir:
   *   `<digest>.part`       — the accumulated bytes (resumable across restarts)
   *   `<digest>.resume.json` — the verified-offset sidecar (atomically rewritten per chunk)
   *   `<digest>.complete`    — written AFTER the digest verifies, BEFORE the DB publish + rename
   * On verification success the order is: drop `.complete` → publishReady (commit the live MediaAsset
   * row) → atomic rename `.part` → shard. The `.complete` marker therefore means "bytes verified, only
   * the final landing was interrupted"; GC salvage re-runs publishReady + rename idempotently from the
   * `.part`, recovering a crash anywhere after the marker. A transport failure retains the `.part` +
   * `.resume.json` for a later resume; a digest mismatch removes all three (no prefix can be trusted).
   * Per-digest FIFO locking prevents concurrent writers; only a whole-file SHA-256 match is published.
   */
  async saveCasFromStream(
    chunksFromOffset: (offset: number) => AsyncIterable<Buffer>,
    expectedDigest: string,
    opts: {
      /** Notified as bytes are appended (throttle at the caller — fires once per buffered chunk). */
      onProgress?: (received: number) => void;
      /** Declared file size; if the stream exceeds it, {@link CasOversizeError} is thrown (excess still counts
       *  toward quota — the caller charges it before abandoning the file). */
      maxFileBytes: number;
      declaredBytes: number;
    },
  ): Promise<{ url: string; digest: string; size: number }> {
    if (!/^[0-9a-f]{64}$/.test(expectedDigest))
      throw new Error('invalid CAS digest');
    FileSizeLimitError.assert(opts.declaredBytes, opts.maxFileBytes);
    return this.casIngestLocks.runExclusive(expectedDigest, async () => {
      const { abs, url } = this.casShardPath(expectedDigest);
      await mkdirAsync(dirname(abs), { recursive: true });
      await mkdirAsync(this.casTmpDir, { recursive: true });
      if (existsSync(abs)) {
        const size = (await statAsync(abs)).size;
        if (size !== opts.declaredBytes)
          throw new Error('CAS file size mismatch');
        FileSizeLimitError.assert(size, opts.maxFileBytes);
        await this.mediaAsset.publishReady(expectedDigest, BigInt(size));
        return { url, digest: expectedDigest, size };
      }

      const part = join(this.casTmpDir, `${expectedDigest}.part`);
      const resume = join(this.casTmpDir, `${expectedDigest}.resume.json`);
      const resumeTmp = `${resume}.tmp`;
      const complete = join(this.casTmpDir, `${expectedDigest}.complete`);
      const completeTmp = `${complete}.tmp`;
      let offset = 0;
      let verifiedChunks: Array<{
        offset: number;
        bytes: number;
        sha256: string;
      }> = [];
      try {
        const meta = JSON.parse(await readFileAsync(resume, 'utf8')) as {
          version?: number;
          digest?: string;
          offset?: number;
          chunks?: Array<{ offset?: number; bytes?: number; sha256?: string }>;
        };
        const partSize = (await statAsync(part)).size;
        if (
          meta.version !== 1 ||
          meta.digest !== expectedDigest ||
          !Number.isSafeInteger(meta.offset) ||
          meta.offset! < 0 ||
          partSize < meta.offset! ||
          !Array.isArray(meta.chunks)
        ) {
          throw new Error('invalid resume state');
        }

        // Validate blocks strictly from byte zero. At the first missing/corrupt/non-contiguous block,
        // discard that block and everything after it; sequential Range download resumes from the end of
        // the last trustworthy prefix. A malformed manifest that cannot establish any boundary falls
        // through to the full reset below.
        let expectedOffset = 0;
        for (const item of meta.chunks) {
          if (
            item.offset !== expectedOffset ||
            !Number.isSafeInteger(item.bytes) ||
            item.bytes! <= 0 ||
            !/^[0-9a-f]{64}$/.test(item.sha256 ?? '') ||
            expectedOffset + item.bytes! > partSize
          ) {
            break;
          }
          const hash = createHash('sha256');
          for await (const piece of createReadStream(part, {
            start: expectedOffset,
            end: expectedOffset + item.bytes! - 1,
          })) {
            hash.update(piece);
          }
          if (hash.digest('hex') !== item.sha256) break;
          verifiedChunks.push({
            offset: expectedOffset,
            bytes: item.bytes!,
            sha256: item.sha256!,
          });
          expectedOffset += item.bytes!;
        }
        offset = expectedOffset;
        if (partSize !== offset) await truncateAsync(part, offset);
      } catch {
        await unlinkAsync(part).catch(() => {});
        await unlinkAsync(resume).catch(() => {});
        offset = 0;
        verifiedChunks = [];
      }

      const persistOffset = async () => {
        await writeFileAsync(
          resumeTmp,
          JSON.stringify({
            version: 1,
            digest: expectedDigest,
            offset,
            chunks: verifiedChunks,
          }),
        );
        await renameAsync(resumeTmp, resume);
      };
      if (offset === 0) {
        // Establish both halves of the checkpoint. A missing part is normal only before the first
        // byte; creating it here lets the live-download checks distinguish that from later deletion.
        await appendFileAsync(part, Buffer.alloc(0));
        await persistOffset();
      }

      // Drop the `.complete` marker (digest verified), then commit the live row and atomically land the
      // shard. GC salvage re-runs exactly these two steps from the `.part` if this process dies between
      // them, so a crash after the marker never loses a verified blob.
      const markComplete = async () => {
        if (offset !== opts.declaredBytes) {
          await unlinkAsync(part).catch(() => {});
          await unlinkAsync(resume).catch(() => {});
          await unlinkAsync(complete).catch(() => {});
          throw new Error('CAS file size mismatch');
        }
        FileSizeLimitError.assert(offset, opts.maxFileBytes);
        await writeFileAsync(
          completeTmp,
          JSON.stringify({
            version: 1,
            digest: expectedDigest,
            bytes: offset,
          }),
        );
        await renameAsync(completeTmp, complete);
      };
      const finishPublish = async () => {
        await this.mediaAsset.publishReady(expectedDigest, BigInt(offset));
        await renameAsync(part, abs);
        await unlinkAsync(complete).catch(() => {});
        await unlinkAsync(resume).catch(() => {});
      };

      try {
        // A crash can happen after the last offset checkpoint but before verification/publish. Avoid an
        // unsatisfiable Range request at EOF: recognize and publish an already-complete valid part.
        if (offset > 0) {
          const resumedHash = createHash('sha256');
          for await (const piece of createReadStream(part))
            resumedHash.update(piece);
          if (resumedHash.digest('hex') === expectedDigest) {
            await markComplete();
            await finishPublish();
            return { url, digest: expectedDigest, size: offset };
          }
        }

        // External filesystem maintenance can still remove or truncate a live partial. Never append
        // at a now-invalid logical
        // offset: abandon that response and open a fresh Range stream. TOMBSTONED cancellation is
        // enforced by the caller's iterable and is not converted into this storage recovery path.
        let storageRestarts = 0;
        for (;;) {
          let partialLost = false;
          for await (const buf of chunksFromOffset(offset)) {
            if (buf.length === 0) continue;
            const actualSize = await statAsync(part)
              .then((value) => value.size)
              .catch(() => -1);
            if (actualSize !== offset) {
              partialLost = true;
              break;
            }
            if (offset + buf.length > opts.declaredBytes) {
              await unlinkAsync(part).catch(() => {});
              await unlinkAsync(resume).catch(() => {});
              await unlinkAsync(complete).catch(() => {});
              throw new CasOversizeError(
                BigInt(offset + buf.length - opts.declaredBytes),
              );
            }
            FileSizeLimitError.assert(offset + buf.length, opts.maxFileBytes);
            const chunkOffset = offset;
            await appendFileAsync(part, buf);
            offset += buf.length;
            verifiedChunks.push({
              offset: chunkOffset,
              bytes: buf.length,
              sha256: createHash('sha256').update(buf).digest('hex'),
            });
            await persistOffset();
            opts?.onProgress?.(offset);
          }
          const finalPartSize = await statAsync(part)
            .then((value) => value.size)
            .catch(() => -1);
          if (!partialLost && finalPartSize === offset) break;
          storageRestarts += 1;
          if (storageRestarts > 2) {
            throw new Error(
              'CAS partial repeatedly disappeared during download',
            );
          }
          await unlinkAsync(part).catch(() => {});
          await unlinkAsync(resume).catch(() => {});
          offset = 0;
          verifiedChunks = [];
          await appendFileAsync(part, Buffer.alloc(0));
          await persistOffset();
        }

        const hash = createHash('sha256');
        for await (const piece of createReadStream(part)) hash.update(piece);
        const digest = hash.digest('hex');
        if (digest !== expectedDigest) {
          await unlinkAsync(part).catch(() => {});
          await unlinkAsync(resume).catch(() => {});
          await unlinkAsync(complete).catch(() => {});
          throw new Error(
            `CAS digest mismatch (expected ${expectedDigest}, got ${digest})`,
          );
        }
        await markComplete();
        await finishPublish();
        return { url, digest, size: offset };
      } catch (error) {
        // Transport failures deliberately retain the verified prefix + sidecar for a later retry.
        // Integrity failures above remove all three tmp artifacts because no prefix can be trusted.
        throw error;
      } finally {
        await unlinkAsync(resumeTmp).catch(() => {});
        await unlinkAsync(completeTmp).catch(() => {});
      }
    });
  }

  /**
   * Sanitize a display filename: basename strips any directory component the client passed
   * (anti-traversal); drop control chars + Windows/Unix illegal chars; trim + length cap. An empty
   * result falls back to `<ext>` or `file`. The extension is re-appended only when a trusted one
   * exists — files with no (safe) extension are stored/served as-is (application/octet-stream +
   * attachment on the serving side).
   */
  private sanitizeName(raw: string, ext: string): string {
    let base = basename(raw ?? 'file');
    base = base
      .replace(/[\x00-\x1f<>:"/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (base.length > MAX_FILE_NAME_LEN)
      base = base.slice(0, MAX_FILE_NAME_LEN).trim();
    // Strip a trailing dot/dot-extension so we can re-append the trusted extension cleanly.
    base = base.replace(/\.+$/, '');
    if (!base) base = ext || 'file';
    if (!ext) return base; // no trusted extension → don't invent one
    // Re-append the validated extension if the (sanitized) base lacks it.
    return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
  }

  /** Validate and persist one wire-safe avatar without changing its bytes. */
  async saveAvatar(buf: Buffer): Promise<string> {
    if (buf.length === 0 || buf.length > UploadService.MAX_AVATAR_WIRE_BYTES)
      throw new Error('avatar exceeds federation byte limit');
    const detected = detectMedia(buf);
    if (detected?.family !== 'image') throw new Error('invalid avatar image');
    const meta = await sharp(buf, {
      limitInputPixels: UploadService.MAX_AVATAR_PIXELS,
    }).metadata();
    if (
      !meta.width ||
      !meta.height ||
      meta.width > UploadService.MAX_AVATAR_EDGE ||
      meta.height > UploadService.MAX_AVATAR_EDGE ||
      meta.width * meta.height > UploadService.MAX_AVATAR_PIXELS
    ) {
      throw new Error('avatar exceeds federation dimension limit');
    }
    const avatarsDir = join(this.uploadDir, 'avatars');
    const digest = await saveContentAddressedBuffer(
      buf,
      (hash) => join(avatarsDir, `${hash}.${detected.ext}`),
      join(avatarsDir, 'tmp'),
    );
    return `/uploads/avatars/${digest}.${detected.ext}`;
  }

  /** Resolve an avatar URL within its dedicated storage directory. */
  private async readAvatarBytes(url: string): Promise<Buffer | null> {
    if (!AVATAR_URL_RE.test(url)) return null;
    return readFileAsync(join(this.uploadDir, url.slice('/uploads/'.length)));
  }

  /** Decode an authenticated client's canonical base64 avatar and run the normal image pipeline. */
  async saveAvatarFromClientBase64(base64: string): Promise<string> {
    if (
      typeof base64 !== 'string' ||
      base64.length < 4 ||
      base64.length > UploadService.MAX_AVATAR_WIRE_B64_LEN ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        base64,
      )
    ) {
      throw new Error('avatar base64 is invalid');
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0 || bytes.toString('base64') !== base64) {
      throw new Error('avatar base64 is not canonical');
    }
    return this.saveAvatar(bytes);
  }

  /**
   * Federation outbound: read a stored avatar file back as the S2S wire shape — base64 of the source
   * bytes + the source pixel dimensions (declared, never trusted on the receiving side). Null when the
   * user has no avatar. Used to embed the avatar inline in S2S profile responses + friend payloads so
   * the receiver can localize without a second round-trip (and without the receiving client fetching
   * cross-origin /uploads/* that CSP would block).
   */
  async readAvatarAsWire(
    url: string,
  ): Promise<{ b64: string; w: number; h: number; mimeType: string } | null> {
    try {
      const buf = await this.readAvatarBytes(url);
      if (!buf) return null;
      const meta = await sharp(buf).metadata();
      const detected = detectMedia(buf);
      if (detected?.family !== 'image') return null;
      return {
        b64: buf.toString('base64'),
        w: meta.width ?? 0,
        h: meta.height ?? 0,
        mimeType: `image/${detected.ext === 'jpg' ? 'jpeg' : detected.ext}`,
      };
    } catch {
      // Missing/corrupt avatar file (operational edge case — disk wiped, manual deletion, etc.).
      // Degrade to "no avatar" on the wire rather than 500-ing the whole S2S profile response. The
      // wire null is ambiguous (genuinely-no-avatar vs. couldn't-read-file), and localizeForeignProfile
      // clears on null — so a transiently-missing file mis-clears the peer's localized copy. That only
      // happens in an already-broken state (the peer's own users can't see the avatar either), and it
      // self-corrects when the user re-uploads (which bumps User.updatedAt → the staleness probe re-fetches).
      return null;
    }
  }

  /** Federation inbound: validate the strict wire shape, then preserve the authenticated bytes. */
  async saveAvatarFromWire(avatar: {
    b64: string;
    w: number;
    h: number;
    mimeType: string;
  }): Promise<string> {
    if (
      !Number.isSafeInteger(avatar.w) ||
      avatar.w <= 0 ||
      !Number.isSafeInteger(avatar.h) ||
      avatar.h <= 0
    ) {
      throw new Error('federated avatar dimensions are invalid');
    }
    if (
      avatar.w > UploadService.MAX_AVATAR_EDGE ||
      avatar.h > UploadService.MAX_AVATAR_EDGE ||
      avatar.w * avatar.h > UploadService.MAX_AVATAR_PIXELS
    ) {
      throw new Error('federated avatar exceeds dimension limit');
    }
    // Pre-decode byte cap: reject BEFORE `Buffer.from` allocates, so a trusted-but-broken peer can't
    // OOM us with a huge b64 string (the pixel check above can't see raw byte size — a small-declared
    // but gigabyte-encoded blob would pass it, then exhaust memory on decode). The existing sharp
    // metadata read remains the authoritative pixel-bomb check; this is the byte-bomb guard. A round
    // 1 MiB cap (~18× a real representative) avoids the imprecise base64 4/3 ceil math. Trusted-peer
    // path only — low threat, but cheap defense-in-depth. See design-review item C3.
    if (
      typeof avatar.b64 !== 'string' ||
      avatar.b64.length < 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        avatar.b64,
      )
    ) {
      throw new Error('federated avatar base64 is invalid');
    }
    if (avatar.b64.length > UploadService.MAX_AVATAR_WIRE_B64_LEN) {
      throw new Error('federated avatar too large in bytes');
    }
    const buf = Buffer.from(avatar.b64, 'base64');
    if (buf.length === 0 || buf.toString('base64') !== avatar.b64) {
      throw new Error('federated avatar base64 is not canonical');
    }
    const detected = detectMedia(buf);
    const actualMimeType = detected
      ? `image/${detected.ext === 'jpg' ? 'jpeg' : detected.ext}`
      : null;
    if (detected?.family !== 'image' || actualMimeType !== avatar.mimeType) {
      throw new Error('federated avatar media type does not match image');
    }
    const metadata = await sharp(buf, {
      limitInputPixels: UploadService.MAX_AVATAR_PIXELS,
    }).metadata();
    if (
      metadata.width !== avatar.w ||
      metadata.height !== avatar.h ||
      metadata.width * metadata.height > UploadService.MAX_AVATAR_PIXELS
    ) {
      throw new Error('federated avatar dimensions do not match image');
    }
    return this.saveAvatar(buf);
  }
}

/** Thrown by {@link UploadService.saveCasFromStream} when an inbound stream exceeds its declared size. The
 *  `extraBytes` (offset − declared) must still be charged toward file-total-size quota by the caller before
 *  the file is abandoned as FAILED. */
export class CasOversizeError extends Error {
  constructor(readonly extraBytes: bigint) {
    super(`CAS oversize: stream exceeded declared size by ${extraBytes} bytes`);
    this.name = 'CasOversizeError';
  }
}
