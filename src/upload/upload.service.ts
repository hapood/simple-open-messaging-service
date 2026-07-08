import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, writeFile, readFile, unlink, rename, mkdir } from 'fs';
import { basename, dirname, join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { promisify } from 'util';
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

const writeFileAsync = promisify(writeFile);
const readFileAsync = promisify(readFile);
const unlinkAsync = promisify(unlink);
const renameAsync = promisify(rename);
const mkdirAsync = promisify(mkdir);

/** 允许的图片 mimetype → 扩展名（白名单 + 落盘扩展名映射）。 */
const IMG_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * consumeImage 的返回：成功带 buffer/宽高；失败按原因区分（控制器据 reason 映射业务码）。
 * 体积上限由 main.ts 的 @fastify/multipart limits.fileSize 兜底 → reason 'too-large'。
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
 * consumeFile 的返回：成功带 buffer/原始文件名；失败按原因区分（控制器据 reason 映射业务码）。
 * 体积上限 MAX_FILE_BYTES 由 main.ts 的 multipart limits.fileSize（已上调）兜底 + 此处二次校验。
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
 * 图片上传服务。
 *
 * 普通图片（聊天相册）：零图片库依赖——@fastify/multipart 读到 buffer + magic number 校验，
 * 宽高由前端 createImageBitmap 读后随 FormData 带上（后端不解析图片内容）。
 *
 * 头像管线（saveAvatars）：引入 sharp 做服务端重写——decode→按 EXIF 正向→cover 裁剪→
 * 多档 webp 重编码。重写天然剥离 EXIF/恶意 chunk（防隐私泄露与 polyglot 载荷），
 * decode 非图片即抛错，像素上限防解压炸弹；多档供前端按位置取用省带宽。
 *
 * 设计：
 * - @fastify/multipart 内存模式：文件进 buffer，先做 magic number 校验再落盘。
 * - 真实性校验两道：consumeImage 看 mimetype（粗筛，buffer 前即拒）+ isImage 读文件头 magic number（防伪造）。
 *
 * 存储目录 process.cwd()/uploads，与 main.ts 的 @fastify/static prefix:'/uploads/' 对齐。
 * 生产换对象存储（S3/OSS/MinIO）时，仅改 save()/saveAvatars() 的写入目标 + url 生成，接口契约不变。
 */
@Injectable()
export class UploadService {
  readonly uploadDir = join(process.cwd(), 'uploads');

  constructor(private readonly mediaAsset: MediaAssetService) {}

  /** 头像多档边长（2 的幂，覆盖侧栏/消息行/详情页 + retina）；按需可调。 */
  static readonly AVATAR_SIZES = [32, 64, 128, 256, 512] as const;
  /** 头像代表档：avatar 字段存该档完整 URL，其余档由前端 avatarUrl() 派生。 */
  static readonly AVATAR_MAX = 512;
  /** 头像像素上限（防解压炸弹：小文件解压成超大画布吃内存）。 */
  static readonly MAX_AVATAR_PIXELS = 4000 * 4000;
  /** Image size cap (avatars + chat images). Enforced in consumeImage so the global multipart
   * ceiling can be raised for generic files (MAX_FILE_BYTES) without also raising it for images. */
  static readonly MAX_IMAGE_BYTES = 10 * 1024 * 1024;

  /**
   * 从 multipart/form-data 请求里消费单张图片：单遍遍历 parts，粗筛 mimetype 后 toBuffer。
   * 替代 Express 时代的 multer FileInterceptor（Fastify 适配器下不可用）。
   * 10MB 上限由 main.ts 注册插件时的 limits.fileSize 兜底——超出时 toBuffer 抛
   * RequestFileTooLargeError，此处归一为 rejected('too-large')，避免被全局过滤器当 500。
   */
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
   * magic number 二次校验：读真实文件头字节判定是否为声明的图片格式。
   * consumeImage 的粗筛只看客户端声明的 mimetype（可伪造），此处不可绕过。
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
  private async saveCas(
    ext: string,
    buf: Buffer,
  ): Promise<{ url: string; digest: string; ext: string; size: number }> {
    const digest = createHash('sha256').update(buf).digest('hex');
    const rel = join(
      'shards',
      digest.slice(0, 2),
      digest.slice(2, 4),
      `${digest}.${ext}`,
    );
    const abs = join(this.uploadDir, rel);
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
   * 通用文件落盘：on-disk 文件名用 `<ts>-<randomHex>.<ext>`（ext 由 parseFileExt 从客户端原始
   * 文件名 sanitize 出，仅 [a-z0-9]{1,16}；无安全扩展名时省略扩展名）。防碰撞/可预测/路径穿越；
   * 返回 { url, name, size, mimeType } 作为 FILE 消息内容。展示名 name 取客户端原始文件名的安全化
   * 结果（剥目录 + 控制符 + 长度上限）。url 形态与 save() 一致，供 parseFileContent 校验。
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
   * 安全化展示文件名：basename 剥离客户端传入的目录分量（防穿越）；剔除控制符与 Windows/Unix
   * 非法字符；trim + 长度上限。空结果回退为 `<ext>` 或 `file`。仅当存在可信扩展名时才回补扩展名——
   * 无（安全）扩展名的文件按原样存储/展示（服务侧以 application/octet-stream + attachment 下发）。
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
   * 头像专用：sharp decode→按 EXIF 正向→cover 裁剪正方形→多档 webp 重编码。
   * - 重写剥离 EXIF/恶意 chunk（防隐私泄露与 polyglot 载荷）；sharp decode 非图片即抛错；
   * - 像素上限防解压炸弹；多档供前端按位置取用省带宽。
   * 返回最大档 URL 作代表，其余档按 /uploads/<base>-<size>.webp 由前端 avatarUrl() 派生。
   */
  async saveAvatars(buf: Buffer): Promise<string> {
    this.ensureDir();
    const meta = await sharp(buf).metadata();
    if (
      (meta.width ?? 0) * (meta.height ?? 0) >
      UploadService.MAX_AVATAR_PIXELS
    ) {
      throw new Error('avatar too large in pixels');
    }
    const base = `${Date.now()}-${randomBytes(6).toString('hex')}`;
    const src = sharp(buf).rotate();
    for (const size of UploadService.AVATAR_SIZES) {
      const out = await src
        .clone()
        .resize(size, size, { fit: 'cover', position: 'center' })
        .webp({ quality: 85 })
        .toBuffer();
      await writeFileAsync(join(this.uploadDir, `${base}-${size}.webp`), out);
    }
    return `/uploads/${base}-${UploadService.AVATAR_MAX}.webp`;
  }

  /**
   * Federation outbound: read a stored avatar file back as the S2S wire shape — base64 of the source
   * bytes + the source pixel dimensions (declared, never trusted on the receiving side). Null when the
   * user has no avatar. Used to embed the avatar inline in S2S profile responses + friend envelopes so
   * the receiver can localize without a second round-trip (and without the receiving client fetching
   * cross-origin /uploads/* that CSP would block).
   */
  async readAvatarAsWire(
    url: string,
  ): Promise<{ b64: string; w: number; h: number } | null> {
    if (!url?.startsWith('/uploads/')) return null;
    try {
      const buf = await readFileAsync(join(this.uploadDir, url.slice('/uploads/'.length)));
      const meta = await sharp(buf).metadata();
      return { b64: buf.toString('base64'), w: meta.width ?? 0, h: meta.height ?? 0 };
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
    const buf = Buffer.from(avatar.b64, 'base64');
    return this.saveAvatars(buf);
  }

  /**
   * 按 URL 删除落盘文件：多尺寸头像删该 base 全部档；单文件（外链/旧格式）删单个；非 /uploads/ 跳过。
   * 头像一人一份无共享，删除失败一律静默（unlink ENOENT 不影响主流程）。
   */
  async deleteByUrl(url: string): Promise<void> {
    if (!url?.startsWith('/uploads/')) return;
    const m = url.match(/^\/uploads\/(.+)-\d+\.webp$/);
    if (m) {
      const base = m[1];
      for (const size of UploadService.AVATAR_SIZES) {
        await unlinkAsync(join(this.uploadDir, `${base}-${size}.webp`)).catch(
          () => {},
        );
      }
    } else {
      await unlinkAsync(
        join(this.uploadDir, url.slice('/uploads/'.length)),
      ).catch(() => {});
    }
  }
}
