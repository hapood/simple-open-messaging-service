import { Injectable } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  writeFile,
  readFile,
  rename,
  mkdir,
  createReadStream,
  unlink,
  stat,
  copyFile,
  appendFile,
  truncate,
} from 'fs';
import { basename, dirname, join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { promisify } from 'util';
import sharp from 'sharp';
import type { FastifyRequest } from 'fastify';
import { dataDirectory } from '../common/data-directory.js';
import {
  MAX_AUDIO_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_LEN,
  MAX_VIDEO_BYTES,
  parseFileExt,
  resolveFileType,
  type OutboundFilePayload,
} from './file-content.js';
import { ContentType } from '../database/enums.js';
import { MediaAssetService } from './media-asset.service.js';
import { detectMedia, type DetectedMedia } from './media-sig.js';
import { AVATAR_SIZES, AVATAR_MAX } from './avatar-path.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { MediaMetadataService } from './media-metadata.service.js';

const writeFileAsync = promisify(writeFile);
const readFileAsync = promisify(readFile);
const renameAsync = promisify(rename);
const mkdirAsync = promisify(mkdir);
const unlinkAsync = promisify(unlink);
const statAsync = promisify(stat);
const copyFileAsync = promisify(copyFile);
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
 * Chat-image upload result. Unlike consumeImage (used by avatars too), the chat upload keeps an
 * unsupported image selection as a generic file so formats such as HEIC/AVIF can still be sent.
 * Supported image MIME types remain subject to the controller's magic-byte check; a corrupt or
 * forged JPEG/PNG/GIF/WebP is preserved through the same forced-download file fallback.
 */
export type ConsumedChatImage =
  | {
      kind: 'file';
      mimetype: string;
      buffer: Buffer;
      filename: string;
      w: number;
      h: number;
    }
  | {
      kind: 'fallback-file';
      mimetype: string;
      buffer: Buffer;
      filename: string;
    }
  | { kind: 'rejected'; reason: 'no-file' | 'wrong-type' | 'too-large' };

/**
 * consumeFile return: success carries buffer + original filename; failure is discriminated by
 * reason (the controller maps reason → business code). The size cap MAX_FILE_BYTES is backed by
 * main.ts's multipart limits.fileSize (raised) + a second check here.
 */
export type ConsumedFile =
  | {
      kind: 'file';
      mimetype: string;
      buffer: Buffer;
      filename: string;
    }
  | {
      kind: 'rejected';
      reason: 'no-file' | 'wrong-type' | 'too-large' | 'bad-name';
    };

/**
 * consumeVideo / consumeAudio return: on success carries the trusted ext (derived from magic bytes,
 * NOT the client filename), the display mime, the buffer, and the original filename. ext is what gets
 * written to disk and served; the controller maps a 'rejected' to the matching business code.
 */
export type ConsumedMedia =
  | {
      kind: 'file';
      ext: string;
      mime: string;
      buffer: Buffer;
      filename: string;
    }
  | {
      kind: 'rejected';
      reason: 'no-file' | 'wrong-type' | 'too-large' | 'bad-name';
    };

/** One buffered file part collected by {@link UploadService.consumeParts} (Phase 7 type-agnostic upload). */
export interface ConsumedPartFile {
  mimetype: string;
  buffer: Buffer;
  filename?: string;
}

/** Multi-file multipart consumer result. The primary contract is ONE file per request (GALLERY is the
 *  client sending N parallel single-file requests sharing one x-client-message-id); multiple files in
 *  one request are tolerated, with companion form fields shared across them. */
export type ConsumedParts =
  | {
      kind: 'ok';
      files: ConsumedPartFile[];
      fields: Record<string, string>;
    }
  | { kind: 'rejected'; reason: 'no-file' | 'too-large' };

/**
 * Image / media upload service.
 *
 * Chat images (albums): zero image-library dependency — @fastify/multipart reads into a buffer +
 * magic-number check; width/height are read client-side via createImageBitmap and sent with the
 * FormData (the backend never parses the image content).
 *
 * Avatar pipeline (saveAvatars): sharp does a server-side rewrite — decode → EXIF-orient → cover
 * crop → multi-size webp re-encode. The rewrite naturally strips EXIF/malicious chunks (privacy +
 * polyglot-payload defense); a non-image decode throws; a pixel cap guards against decompression
 * bombs; the multi-size set lets the client pick by position to save bandwidth.
 *
 * Design:
 * - @fastify/multipart in-memory mode: file → buffer, magic-number-checked before landing on disk.
 * - Two authenticity checks: consumeImage checks the mimetype (coarse filter, rejects before the
 *   buffer is materialized) + isImage reads the real file-header magic bytes (anti-forgery).
 *
 * Storage lives below the configured application data directory, aligned with bootstrap.ts's
 * @fastify/static prefix '/uploads/'.
 * Switching to object storage (S3/OSS/MinIO) in production means changing only save()/saveAvatars()'s
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

  /** Avatar pixel cap (decompression-bomb defense: a tiny file expanding into a huge canvas). */
  static readonly MAX_AVATAR_PIXELS = 4000 * 4000;
  /** Image size cap (avatars + chat images). Enforced in consumeImage so the global multipart
   * ceiling can be raised for generic files (MAX_FILE_BYTES) without also raising it for images. */
  static readonly MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  /** Cap on an inbound federated avatar's base64 string length (pre-decode). A real federated avatar is
   *  the ~55 KB 512-representative (`readAvatarAsWire` reads `User.avatar` = the representative that
   *  `saveAvatars` wrote, NOT the upload source), so 1 MiB of base64 (~750 KB decoded) is ~18× headroom.
   *  This exists ONLY to stop a trusted-but-broken peer OOM-ing us with a huge b64 before `Buffer.from`
   *  allocates — a round number avoids the imprecise base64 4/3 ceil math. See design-review item C3. */
  static readonly MAX_AVATAR_WIRE_B64_LEN = 1024 * 1024;

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
   * Consume the chat-image route without discarding unsupported MIME types. The photo picker can
   * yield HEIC/HEIF/AVIF (or application/octet-stream on less capable WebViews); those bytes are
   * stored through the generic-file path and served as an attachment. This deliberately retains the
   * image route's 10 MiB cap rather than inheriting the generic-file route's larger allowance.
   */
  async consumeChatImage(req: FastifyRequest): Promise<ConsumedChatImage> {
    const r = await this.consumeSingle(req, {
      maxBytes: UploadService.MAX_IMAGE_BYTES,
    });
    if (r.kind === 'rejected') {
      return { kind: 'rejected', reason: r.reason };
    }
    if (r.buffer.length === 0) {
      return { kind: 'rejected', reason: 'no-file' };
    }
    if (!r.filename) {
      return { kind: 'rejected', reason: 'wrong-type' };
    }
    if (!(r.mimetype in IMG_EXT)) {
      return {
        kind: 'fallback-file',
        mimetype: r.mimetype,
        buffer: r.buffer,
        filename: r.filename,
      };
    }
    return {
      kind: 'file',
      mimetype: r.mimetype,
      buffer: r.buffer,
      filename: r.filename,
      w: Number(r.fields.w) || 0,
      h: Number(r.fields.h) || 0,
    };
  }

  /**
   * Consume a single generic file from multipart/form-data: buffer it (capped at MAX_FILE_BYTES),
   * require a filename, reject an empty body, then resolve a safe on-disk extension + a display
   * MIME. The open model accepts ANY file type — there is no whitelist, and the client-declared
   * Content-Type is used only for the display MIME (icon tint), never for a security decision.
   * Serving-side headers (Content-Disposition: attachment + nosniff for non-images) are what make
   * an uploaded .html/.svg/.exe safe. Delegates the multipart draining to consumeSingle with no
   * `allowed` MIME filter; url/name/size/mimeType are all server-generated downstream.
   */
  async consumeFile(req: FastifyRequest): Promise<ConsumedFile> {
    const r = await this.consumeSingle(req, {
      maxBytes: MAX_FILE_BYTES,
    });
    if (r.kind === 'rejected') {
      return { kind: 'rejected', reason: r.reason };
    }
    if (!r.filename) {
      return { kind: 'rejected', reason: 'bad-name' };
    }
    if (r.buffer.length === 0) {
      return { kind: 'rejected', reason: 'no-file' };
    }
    const ft = resolveFileType(r.filename, r.mimetype);
    return {
      kind: 'file',
      mimetype: ft.mime,
      buffer: r.buffer,
      filename: r.filename,
    };
  }

  /**
   * Consume a single video from multipart/form-data: buffer it (capped at MAX_VIDEO_BYTES), require a
   * filename, then gate on a video-container magic-byte signature (detectMedia family === 'video').
   * The client-declared MIME is NOT trusted for the on-disk extension — detectMedia derives ext from
   * the actual bytes. w/h/duration are NOT read server-side; the client probes them via <video>
   * loadedmetadata and carries them in the VIDEO message content (parseVideoContent validates on send).
   */
  async consumeVideo(req: FastifyRequest): Promise<ConsumedMedia> {
    return this.consumeMedia(req, 'video', MAX_VIDEO_BYTES);
  }

  /** Consume a single audio clip. Same contract as consumeVideo with the audio family + cap. */
  async consumeAudio(req: FastifyRequest): Promise<ConsumedMedia> {
    return this.consumeMedia(req, 'audio', MAX_AUDIO_BYTES);
  }

  /**
   * Shared video/audio consumer: drain the multipart (single-file contract via consumeSingle), then
   * detect the container family from magic bytes and gate on the expected family. The on-disk ext is
   * the detected ext (trusted); the display mime is `<family>/<ext>` (display only — @fastify/static
   * maps ext→Content-Type at serving time, and parseVideo/AudioContent carries this mime for the UI).
   */
  private async consumeMedia(
    req: FastifyRequest,
    family: 'video' | 'audio',
    maxBytes: number,
  ): Promise<ConsumedMedia> {
    const r = await this.consumeSingle(req, { maxBytes });
    if (r.kind === 'rejected') {
      return { kind: 'rejected', reason: r.reason };
    }
    if (!r.filename) {
      return { kind: 'rejected', reason: 'bad-name' };
    }
    if (r.buffer.length === 0) {
      return { kind: 'rejected', reason: 'no-file' };
    }
    const detected = detectMedia(r.buffer);
    if (!detected) {
      return { kind: 'rejected', reason: 'wrong-type' };
    }
    // detectMedia cannot split a shared container by family alone: EBML is BOTH webm-audio
    // (what MediaRecorder emits on Chrome / Android WebView / Tauri webview2 / webkit2gtk) and
    // webm-video, and ISO-BMFF `ftyp` is BOTH m4a (audio) and mp4 (video). The route name carries
    // the client's media intent, so the AUDIO route additionally accepts those recorder-emitted
    // containers (webm, mp4) as audio. detectMedia still proved a real container signature
    // (anti-forgery — not a forged MIME or arbitrary file), serving is per-object authz-gated
    // (MediaMessage) + nosniff, and <audio> plays webm/opus + mp4 natively. The VIDEO route stays
    // strict (no shared-container acceptance) — a video uploaded to /upload/video is unambiguous.
    const sharedAsAudio =
      family === 'audio' &&
      detected.family === 'video' &&
      (detected.ext === 'webm' || detected.ext === 'mp4');
    if (detected.family !== family && !sharedAsAudio) {
      return { kind: 'rejected', reason: 'wrong-type' };
    }
    return {
      kind: 'file',
      ext: detected.ext,
      mime: `${family}/${detected.ext}`,
      buffer: r.buffer,
      filename: r.filename,
    };
  }

  /**
   * Core single-file multipart consumer shared by every upload route (avatar, chat image, chat
   * file). Owns the one copy of the @fastify/multipart draining logic so the backpressure bug
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

  // ─── Phase 7: type-agnostic upload (design doc §12.3) ─────────────────────────────────────

  /**
   * Type-agnostic multi-file multipart consumer (Phase 7). Iterates req.parts(), buffering each file
   * part up to the global per-part cap and collecting the companion form fields ({name, mimeType, w,
   * h, duration}) that describe it. Supersedes consumeChatImage/consumeFile/consumeVideo/consumeAudio:
   * the upload transport no longer branches on media family — {@link savePart} detects family from the
   * bytes.
   *
   * Backpressure: every file part is drained inside the loop (toBuffer before the iterator advances) —
   * the same invariant consumeSingle owns. Deferring the drain stalls the parts() iterator once a file
   * spans more than one read chunk. A 0-byte part is dropped; if no non-empty file arrived → 'no-file'.
   */
  async consumeParts(
    req: FastifyRequest,
    opts: { maxBytes: number },
  ): Promise<ConsumedParts> {
    const files: ConsumedPartFile[] = [];
    const fields: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type !== 'file') {
        fields[part.fieldname] = String(part.value);
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = await part.toBuffer();
      } catch {
        return { kind: 'rejected', reason: 'too-large' };
      }
      if (buffer.length > opts.maxBytes) {
        return { kind: 'rejected', reason: 'too-large' };
      }
      if (buffer.length === 0) continue; // drop empty parts
      files.push({
        mimetype: part.mimetype,
        buffer,
        ...(part.filename ? { filename: part.filename } : {}),
      });
    }
    if (files.length === 0) return { kind: 'rejected', reason: 'no-file' };
    return { kind: 'ok', files, fields };
  }

  /**
   * Detect the outbound file family from magic bytes WITHOUT persisting (Phase 7). Used by the upload
   * route to enforce per-category byte/count quota BEFORE saveCas lands the file, so a quota failure
   * leaves no orphan on disk. Mirrors the detection inside {@link savePart}.
   */
  detectFamily(buf: Buffer): OutboundFilePayload['family'] {
    const detected = detectMedia(buf);
    if (detected?.family === 'image') return 'IMAGE';
    if (detected?.family === 'video') return 'VIDEO';
    if (detected?.family === 'audio') return 'AUDIO';
    return 'FILE';
  }

  /**
   * Type-agnostic content-addressed save for one uploaded file (Phase 7). Detects the file family from
   * the bytes (image/video/audio via magic-byte signatures, else FILE), derives the trusted on-disk
   * extension, saves through the shared CAS pipeline, and returns the per-file payload the barrier-
   * promote assembles message content from.
   *
   * `intent` is the staged message-level contentType (NOT a transport concern) and is used only to gate
   * family mismatches the way the legacy typed routes did: an IMAGE intent whose bytes are not an
   * inline-renderable image (HEIC/AVIF/…) is stored as a downloadable FILE and signals an
   * `overrideContentType: FILE` so the message lands as FILE; a VIDEO/AUDIO intent rejects a
   * non-matching container; AUDIO accepts the recorder-shared webm/mp4 containers (mapped to audio);
   * GALLERY detects freely (a webm in a bundle is VIDEO by signature — an accepted limitation).
   *
   * Collapses the legacy save/saveFile/saveMedia trio into one type-agnostic writer.
   */
  async savePart(
    buf: Buffer,
    intent: ContentType,
    opts: {
      filename?: string;
      declaredMime?: string;
    },
  ): Promise<{
    payload: OutboundFilePayload;
    overrideContentType?: ContentType;
  }> {
    if (buf.length === 0) {
      throw new Error('empty upload part');
    }
    const resolved = this.resolveOutboundFile(
      detectMedia(buf),
      intent,
      opts.filename ?? '',
      opts.declaredMime ?? '',
    );
    const metadata = await this.mediaMetadata.fromBuffer(buf, resolved.family);
    const { url, digest, size } = await this.saveCas(resolved.ext, buf);
    const payload: OutboundFilePayload = {
      digest,
      url,
      size,
      family: resolved.family,
      ...(resolved.name !== undefined ? { name: resolved.name } : {}),
      ...(resolved.mime !== undefined ? { mimeType: resolved.mime } : {}),
      ...metadata,
    };
    return {
      payload,
      ...(resolved.overrideContentType
        ? { overrideContentType: resolved.overrideContentType }
        : {}),
    };
  }

  /**
   * Shared family/ext/mime/name resolution for one outbound file (Phase 7). Used by both
   * {@link savePart} (in-memory buffer) and {@link publishResumable} (streamed tmp file) so the two
   * paths gate identically on the staged `intent`:
   *   - IMAGE intent whose bytes are not an inline-renderable image (HEIC/AVIF/…) → downloadable FILE,
   *     signaling `overrideContentType: FILE`;
   *   - VIDEO/AUDIO intent rejects a non-matching container (AUDIO accepts the recorder-shared
   *     webm/mp4 containers, mapped to audio);
   *   - GALLERY detects freely (a webm in a bundle is VIDEO by signature — an accepted limitation).
   * Returns the detected family, the trusted on-disk ext, the display MIME (omitted for IMAGE), and the
   * sanitized display name (omitted for IMAGE).
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
    name?: string;
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
          throw new Error('invalid video');
        }
        family = 'VIDEO';
        ext = detected.ext;
        break;
      case ContentType.AUDIO: {
        const sharedAsAudio =
          detected?.family === 'video' &&
          (detected.ext === 'webm' || detected.ext === 'mp4');
        if (!detected || (detected.family !== 'audio' && !sharedAsAudio)) {
          throw new Error('invalid audio');
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
    let name: string | undefined;
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

  /** Ensure the flat uploads/ root exists (avatar multi-size files still land here). */
  private ensureDir() {
    if (!existsSync(this.uploadDir)) {
      mkdirSync(this.uploadDir, { recursive: true });
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
    const digest = createHash('sha256').update(buf).digest('hex');
    const { abs, url } = this.casShardPath(digest);
    await mkdirAsync(dirname(abs), { recursive: true });
    await mkdirAsync(this.casTmpDir, { recursive: true });
    // Atomic publish: write a unique tmp path in the CAS tmp dir, then rename onto the shard (same
    // filesystem → atomic). Identical concurrent uploads overwrite each other harmlessly. File-first
    // (rename before the row): keeps the reader invariant that a MediaAsset row implies a present shard.
    const tmp = join(
      this.casTmpDir,
      `${digest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    let renamed = false;
    try {
      await writeFileAsync(tmp, buf);
      await renameAsync(tmp, abs);
      renamed = true;
      await this.mediaAsset.publishReady(digest, BigInt(buf.length));
    } finally {
      if (!renamed) await unlinkAsync(tmp).catch(() => {});
    }
    return { url, digest, ext, size: buf.length };
  }

  /**
   * Publish a completed resumable-upload temporary file without materializing it in memory (Phase 7
   * type-agnostic). Streams the tmp file once to SHA-256 it + capture the leading magic bytes, resolves
   * the outbound family/ext/mime/name through the SAME {@link resolveOutboundFile} path as
   * {@link savePart} (so buffered and resumable uploads gate identically on the staged `intent`),
   * publishes the blob through the CAS tmp-then-rename path, and returns the per-file payload the
   * barrier-promote assembles message content from. `companion` carries the client-probed w/h/duration.
   */
  async publishResumable(
    tmpPath: string,
    intent: ContentType,
    originalName: string,
    declaredMime: string,
  ): Promise<{
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
    const { abs, url } = this.casShardPath(digest);
    await mkdirAsync(dirname(abs), { recursive: true });
    await mkdirAsync(this.casTmpDir, { recursive: true });
    // Keep the resumable source until UploadSession has durably recorded the result. Publishing through
    // a unique CAS tmp path preserves atomic rename (same filesystem) while making a DB failure safely
    // retryable. File-first, like saveCas — the row is written only after the shard lands.
    const publishTmp = join(
      this.casTmpDir,
      `${digest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    let renamed = false;
    try {
      await copyFileAsync(tmpPath, publishTmp);
      await renameAsync(publishTmp, abs);
      renamed = true;
      await this.mediaAsset.publishReady(digest, BigInt(info.size));
    } finally {
      if (!renamed) await unlinkAsync(publishTmp).catch(() => {});
    }
    const payload: OutboundFilePayload = {
      digest,
      url,
      size: info.size,
      family: resolved.family,
      ...(resolved.name !== undefined ? { name: resolved.name } : {}),
      ...(resolved.mime !== undefined ? { mimeType: resolved.mime } : {}),
      ...metadata,
    };
    return {
      payload,
      ...(resolved.overrideContentType
        ? { overrideContentType: resolved.overrideContentType }
        : {}),
    };
  }

  /**
   * Chat image save — content-addressed + deduped. Stored RAW (EXIF preserved, no sharp re-encode);
   * only the on-disk extension is derived from the magic-byte-validated mimetype. Returns the serving
   * URL and byte size so the client can store both in the IMAGE message content ({url,w,h,size}) for
   * size-tiered lazy loading.
   */
  async save(
    mimetype: string,
    buf: Buffer,
  ): Promise<{ url: string; size: number }> {
    const ext = IMG_EXT[mimetype];
    const { url, size } = await this.saveCas(ext, buf);
    return { url, size };
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
   * Generic file save — content-addressed + deduped via the shared CAS pipeline (sha256 → shard path
   * → MediaAsset ref++). The on-disk ext is sanitized from the client's original filename by
   * parseFileExt ([a-z0-9]{1,16} only); when the filename has no safe extension it falls back to
   * 'bin' so the shard path always carries one. Returns { url, name, size, mimeType } as the FILE
   * message content. The display `name` is the client's original filename, sanitized (strip directory
   * + control chars + length cap). The url shape matches save() so parseFileContent validates it.
   */
  async saveFile(
    mimetype: string,
    originalName: string,
    buf: Buffer,
    forceAttachment = false,
  ): Promise<{ url: string; name: string; size: number; mimeType: string }> {
    const ext = parseFileExt(originalName);
    // Open model: any file type is accepted, so the on-disk ext comes from the sanitized client
    // filename (there is no trustworthy magic byte for arbitrary file types). Fall back to 'bin' so
    // the CAS path always carries an extension — served as application/octet-stream + attachment.
    // Image-route fallbacks use .bin even when the claimed filename ends in .png/.jpg. Static
    // serving decides inline-vs-attachment from the trusted CAS extension, so .bin guarantees that
    // corrupt/forged image bytes are downloaded rather than fed to an inline image decoder.
    const casExt = forceAttachment ? 'bin' : ext || 'bin';
    const { url, size } = await this.saveCas(casExt, buf);
    return {
      url,
      name: this.sanitizeName(originalName, ext),
      size,
      mimeType: mimetype,
    };
  }

  /**
   * Persist a video/audio asset through the SAME CAS pipeline as images/files (sha256 dedup + ref
   * count). The on-disk ext is the magic-byte-derived `ext` (trusted); the display name preserves the
   * client's original extension (sanitizeName with ext='' keeps the original as-is), so a .mov
   * uploaded and detected as mp4 still shows as "clip.mov" while the CAS blob remains extensionless.
   * Returns the shape stored verbatim in a VIDEO/AUDIO message's content.
   */
  async saveMedia(
    ext: string,
    mime: string,
    originalName: string,
    buf: Buffer,
  ): Promise<{ url: string; name: string; size: number; mimeType: string }> {
    const { url, size } = await this.saveCas(ext, buf);
    return {
      url,
      name: this.sanitizeName(originalName, ''),
      size,
      mimeType: mime,
    };
  }

  /**
   * Persist a media asset fetched from a federated peer — receiver-side media localize (Step 2 §3.3 /
   * §4.5). Same CAS pipeline as a local upload (sha256 → shard path → MediaAsset ref++), so a
   * peer-sourced file is byte-identical on disk to a locally-uploaded one and serves same-origin via
   * /uploads/cas/* with no new serving code. The caller passes the on-disk `ext` (from the peer's
   * content URL) + the fetched bytes; the returned `digest` lets the caller VERIFY integrity (it must
   * equal the digest the peer advertised — a mismatch means corrupt/tampered bytes → drop the file).
   * Idempotent: a re-fetch of the same digest overwrites the byte-identical file + re-bumps the ref.
   */
  async saveCasFromPeer(
    ext: string,
    buf: Buffer,
  ): Promise<{ url: string; digest: string; size: number }> {
    const { url, digest, size } = await this.saveCas(ext, buf);
    return { url, digest, size };
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
    ext: string,
    chunksFromOffset: (offset: number) => AsyncIterable<Buffer>,
    expectedDigest: string,
    opts?: {
      /** Notified as bytes are appended (throttle at the caller — fires once per buffered chunk). */
      onProgress?: (received: number) => void;
      /** Declared file size; if the stream exceeds it, {@link CasOversizeError} is thrown (excess still counts
       *  toward quota — the caller charges it before abandoning the file). */
      declaredBytes?: number;
    },
  ): Promise<{ url: string; digest: string; size: number }> {
    if (!/^[0-9a-f]{64}$/.test(expectedDigest))
      throw new Error('invalid CAS digest');
    return this.casIngestLocks.runExclusive(expectedDigest, async () => {
      const { abs, url } = this.casShardPath(expectedDigest);
      await mkdirAsync(dirname(abs), { recursive: true });
      await mkdirAsync(this.casTmpDir, { recursive: true });
      if (existsSync(abs)) {
        const size = (await statAsync(abs)).size;
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

        // GC normally excludes claimed downloads, but a stale scan, manual filesystem cleanup, or an
        // operator can still remove/truncate a live partial. Never append at a now-invalid logical
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
            if (
              opts?.declaredBytes !== undefined &&
              offset > opts.declaredBytes
            ) {
              // The stream exceeded its declared size — abandon. The excess bytes still counts toward quota;
              // the caller (driveFileSync) charges the delta via addFileBytesDelta before this surfaces as FAILED.
              await unlinkAsync(part).catch(() => {});
              await unlinkAsync(resume).catch(() => {});
              await unlinkAsync(complete).catch(() => {});
              throw new CasOversizeError(BigInt(offset - opts.declaredBytes));
            }
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

  /**
   * Avatar-only: sharp decode→EXIF-orient→cover-crop square→multi-size webp re-encode. Strips
   * EXIF/malicious chunks (privacy + anti-polyglot); sharp decode throws on non-image; pixel cap
   * defuses decompression bombs; multi-size saves bandwidth by position.
   *
   * Avatars live in their own namespace `uploads/avatars/<base>-<size>.webp`, deliberately OUTSIDE
   * `uploads/cas/` so the per-object media-authz gate (which authorizes by thread membership)
   * never applies to them — avatars must render cross-thread (member lists, search, federation
   * profiles). Returns the largest size's URL as the representative; the frontend derives the other
   * sizes by substituting the `-<size>` suffix.
   */
  async saveAvatars(buf: Buffer): Promise<string> {
    this.ensureDir();
    const avatarsDir = join(this.uploadDir, 'avatars');
    await mkdirAsync(avatarsDir, { recursive: true });
    const meta = await sharp(buf).metadata();
    if (
      (meta.width ?? 0) * (meta.height ?? 0) >
      UploadService.MAX_AVATAR_PIXELS
    ) {
      throw new Error('avatar too large in pixels');
    }
    const base = `${Date.now()}-${randomBytes(6).toString('hex')}`;
    const src = sharp(buf).rotate();
    for (const size of AVATAR_SIZES) {
      const out = await src
        .clone()
        .resize(size, size, { fit: 'cover', position: 'center' })
        .webp({ quality: 85 })
        .toBuffer();
      await writeFileAsync(join(avatarsDir, `${base}-${size}.webp`), out);
    }
    return `/uploads/avatars/${base}-${AVATAR_MAX}.webp`;
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
  ): Promise<{ b64: string; w: number; h: number } | null> {
    if (!url?.startsWith('/uploads/')) return null;
    try {
      const buf = await readFileAsync(
        join(this.uploadDir, url.slice('/uploads/'.length)),
      );
      const meta = await sharp(buf).metadata();
      return {
        b64: buf.toString('base64'),
        w: meta.width ?? 0,
        h: meta.height ?? 0,
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

  /**
   * Federation inbound: decode an S2S wire avatar (base64 + declared dims) and persist it through the
   * SAME multi-size webp pipeline as a local upload (saveAvatars center-crops to square + emits 32/64/
   * 128/256/512 + strips EXIF). The declared w/h get a cheap pre-validation (reject an obviously-oversized
   * source before spending CPU on a sharp decode); sharp's own metadata read is the authoritative pixel-bomb
   * check (a compromised peer can lie about w/h, but can't lie past sharp). Returns the representative
   * (512) URL, exactly like a local avatar upload.
   */
  async saveAvatarFromWire(avatar: {
    b64: string;
    w: number;
    h: number;
  }): Promise<string> {
    if (
      !Number.isSafeInteger(avatar.w) ||
      avatar.w <= 0 ||
      !Number.isSafeInteger(avatar.h) ||
      avatar.h <= 0
    ) {
      throw new Error('federated avatar dimensions are invalid');
    }
    if (avatar.w * avatar.h > UploadService.MAX_AVATAR_PIXELS) {
      throw new Error('federated avatar too large in pixels');
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
    const metadata = await sharp(buf).metadata();
    if (
      metadata.width !== avatar.w ||
      metadata.height !== avatar.h ||
      metadata.width * metadata.height > UploadService.MAX_AVATAR_PIXELS
    ) {
      throw new Error('federated avatar dimensions do not match image');
    }
    return this.saveAvatars(buf);
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
