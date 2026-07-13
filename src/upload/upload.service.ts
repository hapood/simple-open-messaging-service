import { Injectable } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  writeFile,
  readFile,
  rename,
  mkdir,
  createWriteStream,
  unlink,
} from 'fs';
import { basename, dirname, join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { promisify } from 'util';
import { finished } from 'stream/promises';
import sharp from 'sharp';
import type { FastifyRequest } from 'fastify';
import {
  MAX_AUDIO_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_LEN,
  MAX_VIDEO_BYTES,
  parseFileExt,
  resolveFileType,
} from './file-content.js';
import { MediaAssetService } from './media-asset.service.js';
import { detectMedia } from './media-sig.js';
import { AVATAR_SIZES, AVATAR_MAX } from './avatar-path.js';

const writeFileAsync = promisify(writeFile);
const readFileAsync = promisify(readFile);
const renameAsync = promisify(rename);
const mkdirAsync = promisify(mkdir);
const unlinkAsync = promisify(unlink);

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
 * Storage dir is process.cwd()/data/uploads, aligned with bootstrap.ts's @fastify/static prefix '/uploads/'.
 * Switching to object storage (S3/OSS/MinIO) in production means changing only save()/saveAvatars()'s
 * write target + url generation — the interface contract stays the same.
 */
@Injectable()
export class UploadService {
  readonly uploadDir = join(process.cwd(), 'data', 'uploads');

  constructor(private readonly mediaAsset: MediaAssetService) {}

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
    if (!detected || detected.family !== family) {
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
   * Content-addressed save: sha256 → uploads/shards/<digest[0:2]>/<digest[2:4]>/<digest>.<ext>.
   *
   * Atomic publish via a tmp file + rename on the same filesystem: two concurrent writers of the
   * same digest produce byte-identical files, the second rename overwrites the first, and there is
   * no TOCTOU window (no existsSync pre-check). The MediaAsset ref bump is the CALLER's job — file
   * write first, then ref, so a DB failure leaves a reclaimable orphan (refs = 0 → GC), never a
   * dangling reference to a missing file. `ext` is the trusted on-disk extension (the caller decides
   * the source: magic-byte-derived for images/video/audio, sanitized client-name-derived for files).
   */
  /** The content-addressed shard path (relative + absolute) for a digest + ext:
   *  uploads/shards/<digest[0:2]>/<digest[2:4]>/<digest>.<ext>. Shared by saveCas (buffer) and
   *  saveCasFromStream (streaming) so both land byte-identical files at the identical location. */
  private casShardPath(
    digest: string,
    ext: string,
  ): { abs: string; rel: string } {
    const rel = join(
      'shards',
      digest.slice(0, 2),
      digest.slice(2, 4),
      `${digest}.${ext}`,
    );
    return { abs: join(this.uploadDir, rel), rel };
  }

  private async saveCas(
    ext: string,
    buf: Buffer,
  ): Promise<{ url: string; digest: string; ext: string; size: number }> {
    const digest = createHash('sha256').update(buf).digest('hex');
    const { abs, rel } = this.casShardPath(digest, ext);
    await mkdirAsync(dirname(abs), { recursive: true });
    // Atomic publish: write a unique tmp path, then rename (same filesystem → atomic). Identical
    // concurrent uploads overwrite each other harmlessly (byte-identical content).
    const tmp = `${abs}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFileAsync(tmp, buf);
    await renameAsync(tmp, abs);
    return { url: `/uploads/${rel}`, digest, ext, size: buf.length };
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
    const { url, digest, size } = await this.saveCas(ext, buf);
    await this.mediaAsset.upsertAndRef(digest, BigInt(size));
    return { url, size };
  }

  /**
   * Generic file save: the on-disk filename is `<ts>-<randomHex>.<ext>` (ext is sanitized from the
   * client's original filename by parseFileExt, [a-z0-9]{1,16} only; omitted when there is no safe
   * extension). Collision-safe / unpredictable / traversal-proof; returns { url, name, size, mimeType }
   * as the FILE message content. The display `name` is the client's original filename, sanitized
   * (strip directory + control chars + length cap). The url shape matches save() so parseFileContent
   * validates it.
   */
  async saveFile(
    mimetype: string,
    originalName: string,
    buf: Buffer,
  ): Promise<{ url: string; name: string; size: number; mimeType: string }> {
    const ext = parseFileExt(originalName);
    // Open model: any file type is accepted, so the on-disk ext comes from the sanitized client
    // filename (there is no trustworthy magic byte for arbitrary file types). Fall back to 'bin' so
    // the CAS path always carries an extension — served as application/octet-stream + attachment,
    // matching the legacy no-ext behavior.
    const casExt = ext || 'bin';
    const { url, digest, size } = await this.saveCas(casExt, buf);
    await this.mediaAsset.upsertAndRef(digest, BigInt(size));
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
   * uploaded and detected as mp4 shows as "clip.mov" to the user while the shard file is <digest>.mp4.
   * Returns the shape stored verbatim in a VIDEO/AUDIO message's content.
   */
  async saveMedia(
    ext: string,
    mime: string,
    originalName: string,
    buf: Buffer,
  ): Promise<{ url: string; name: string; size: number; mimeType: string }> {
    const { url, digest, size } = await this.saveCas(ext, buf);
    await this.mediaAsset.upsertAndRef(digest, BigInt(size));
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
   * /uploads/shards/* with no new serving code. The caller passes the on-disk `ext` (from the peer's
   * content URL) + the fetched bytes; the returned `digest` lets the caller VERIFY integrity (it must
   * equal the digest the peer advertised — a mismatch means corrupt/tampered bytes → drop the file).
   * Idempotent: a re-fetch of the same digest overwrites the byte-identical file + re-bumps the ref.
   */
  async saveCasFromPeer(
    ext: string,
    buf: Buffer,
  ): Promise<{ url: string; digest: string; size: number }> {
    const { url, digest, size } = await this.saveCas(ext, buf);
    await this.mediaAsset.upsertAndRef(digest, BigInt(size));
    return { url, digest, size };
  }

  /**
   * Streaming CAS ingest (Step 2 §4.5): land a media asset fetched from a federated peer in resumable
   * chunks WITHOUT buffering the whole file in memory. Consumes an ordered async iterable of byte
   * chunks (the federation transport yields one fully-accumulated Range unit at a time, so the write is
   * atomic per chunk — a dropped chunk is discarded upstream and re-fetched, never re-written here),
   * writes them to a tmp file while incrementally hashing, then on completion verifies the digest ===
   * the peer-advertised `expectedDigest` (the corruption/tamper/truncation backstop), atomically
   * renames into the shard path, and bumps the MediaAsset refcount. Same CAS pipeline as
   * saveCasFromPeer — byte-identical on disk to a local upload, served same-origin. Idempotent: a
   * re-fetch of the same digest overwrites the byte-identical file + re-bumps the ref.
   *
   * Failure handling: a digest mismatch OR any stream error deletes the tmp file and throws —
   * localizeMedia catches that and leaves the message inert for a later retry. The tmp file is ALWAYS
   * cleaned up (try/finally), whether we renamed it away or not (no orphan leak on any path).
   */
  async saveCasFromStream(
    ext: string,
    chunks: AsyncIterable<Buffer>,
    expectedDigest: string,
  ): Promise<{ url: string; digest: string; size: number }> {
    const { abs, rel } = this.casShardPath(expectedDigest, ext);
    await mkdirAsync(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const hash = createHash('sha256');
    let size = 0;
    let renamed = false;
    const writeStream = createWriteStream(tmp);
    try {
      for await (const buf of chunks) {
        hash.update(buf);
        size += buf.length;
        // Respect backpressure: if the write buffer is full, wait for 'drain' before the next write
        // so a fast producer (the network) can't outrun a slow disk and balloon memory.
        if (!writeStream.write(buf)) {
          await new Promise<void>((resolve, reject) => {
            writeStream.once('drain', resolve);
            writeStream.once('error', reject);
          });
        }
      }
      writeStream.end();
      await finished(writeStream);
      const digest = hash.digest('hex');
      if (digest !== expectedDigest) {
        // Corrupt/tampered/truncated peer bytes — drop the file, leave no asset. The caller leaves the
        // message inert for a retry rather than rendering garbage.
        throw new Error(
          `CAS digest mismatch (expected ${expectedDigest}, got ${digest}) — corrupt/tampered/truncated peer bytes`,
        );
      }
      await renameAsync(tmp, abs);
      renamed = true;
      await this.mediaAsset.upsertAndRef(digest, BigInt(size));
      return { url: `/uploads/${rel}`, digest, size };
    } finally {
      writeStream.destroy();
      if (!renamed) await unlinkAsync(tmp).catch(() => {});
    }
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
   * `uploads/shards/` so the per-object media-authz gate (which authorizes by thread membership)
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
    const w = avatar.w | 0;
    const h = avatar.h | 0;
    if (w > 0 && h > 0 && w * h > UploadService.MAX_AVATAR_PIXELS) {
      throw new Error('federated avatar too large in pixels');
    }
    // Pre-decode byte cap: reject BEFORE `Buffer.from` allocates, so a trusted-but-broken peer can't
    // OOM us with a huge b64 string (the pixel check above can't see raw byte size — a small-declared
    // but gigabyte-encoded blob would pass it, then exhaust memory on decode). The existing sharp
    // metadata read remains the authoritative pixel-bomb check; this is the byte-bomb guard. A round
    // 1 MiB cap (~18× a real representative) avoids the imprecise base64 4/3 ceil math. Trusted-peer
    // path only — low threat, but cheap defense-in-depth. See design-review item C3.
    if (avatar.b64.length > UploadService.MAX_AVATAR_WIRE_B64_LEN) {
      throw new Error('federated avatar too large in bytes');
    }
    const buf = Buffer.from(avatar.b64, 'base64');
    return this.saveAvatars(buf);
  }
}
