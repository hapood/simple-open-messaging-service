import {
  Controller,
  Post,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { UploadService } from './upload.service.js';
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { extractDigests } from './file-content.js';
import { QuotaService } from '../quota/quota.service.js';

/**
 * Image upload: multipart/form-data, field file=<image bytes> + w/h (the dimensions the frontend read
 * via createImageBitmap). w/h are parsed by consumeImage (no DTO class; ValidationPipe is not involved)
 * and passed through verbatim.
 *
 * The four media routes (/upload, /upload/file, /upload/video, /upload/audio) double as the PROMOTE
 * step of a staged media send: when the request carries an `x-client-message-id` header (set by the
 * client after POST /send-media), the route — after writing the file — links the staged record to the
 * asset's digest and promotes it to a real Message (allocating seq, creating the MediaMessage authz
 * row, deleting the PendingMedia), then runs the unified fan-out. Without the header the route behaves
 * exactly as before (a plain upload). /upload/avatar never carries the header → never promotes.
 */
@ApiTags('upload')
@Controller()
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly messageService: MessageService,
    private readonly fanout: MessageFanoutService,
    private readonly quota: QuotaService,
  ) {}

  /** Tick the local aggregate daily quota for a media upload; returns an error ApiResult when the budget
   *  is exhausted (the caller returns it as HTTP 200 + QUOTA_EXCEEDED), else null (proceed). Local uploads
   *  already enforce per-item size via the /upload pipeline, so this is the COUNT cap only (no byte 413). */
  private async tickLocal(
    category: 'images' | 'largeFiles',
  ): Promise<ApiResult | null> {
    const q = await this.quota.tryTickLocal(category);
    if (!q.exceeded) return null;
    return {
      code: BusinessCode.QUOTA_EXCEEDED,
      message: `daily ${category} quota reached (${q.limit}); resets in ${q.retryAfter}s`,
      data: { category, limit: q.limit, retryAfter: q.retryAfter },
    };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload')
  @ApiOperation({ summary: 'Upload an image (returns url + width/height provided by the client)' })
  @ApiConsumes('multipart/form-data')
  async upload(@Request() req: FastifyRequest): Promise<ApiResult> {
    const img = await this.uploadService.consumeImage(req);
    if (img.kind === 'rejected') {
      return {
        code: BusinessCode.VALIDATION_FAILED,
        message:
          img.reason === 'no-file'
            ? 'no file'
            : img.reason === 'too-large'
              ? 'file too large'
              : 'invalid image',
      };
    }
    // Magic-number second check: reject non-genuine images (defends against forged-mimetype malicious uploads).
    if (!this.uploadService.isImage(img.mimetype, img.buffer)) {
      return { code: BusinessCode.VALIDATION_FAILED, message: 'invalid image' };
    }
    const blocked = await this.tickLocal('images');
    if (blocked) return blocked;
    const { url, size } = await this.uploadService.save(img.mimetype, img.buffer);
    // Promote a staged IMAGE send if this upload carries a client-message-id (the message content is
    // {url,w,h}; the staged meta for an image is empty — w/h come from consumeImage above).
    await this.maybePromote(req, { url, w: img.w, h: img.h });
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: { url, w: img.w, h: img.h, size },
    };
  }

  /**
   * Avatar upload (user + group avatars): multipart/form-data, field file=<image>. Same image
   * validation as /upload (consumeImage + magic-byte), then the sharp multi-size webp avatar
   * pipeline (saveAvatars). Returns { avatar: representativeUrl } — the frontend stores it verbatim
   * as Group.avatar (create/update). User avatars still go through /user/update-avatar (which calls
   * saveAvatars directly); this endpoint is the canonical upload for GROUP avatars so they land in
   * uploads/avatars/ (outside the per-object authz gate's shards/ scope) instead of generic /upload
   * (which writes to shards/ and would 401 under thread-membership authz).
   */
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload/avatar')
  @ApiOperation({ summary: 'Upload avatar image (multi-size webp, returns representative url)' })
  @ApiConsumes('multipart/form-data')
  async uploadAvatar(@Request() req: FastifyRequest): Promise<ApiResult> {
    const img = await this.uploadService.consumeImage(req);
    if (img.kind === 'rejected') {
      return {
        code: BusinessCode.VALIDATION_FAILED,
        message:
          img.reason === 'no-file'
            ? 'no file'
            : img.reason === 'too-large'
              ? 'file too large'
              : 'invalid image',
      };
    }
    if (!this.uploadService.isImage(img.mimetype, img.buffer)) {
      return { code: BusinessCode.VALIDATION_FAILED, message: 'invalid image' };
    }
    let avatar: string;
    try {
      avatar = await this.uploadService.saveAvatars(img.buffer);
    } catch {
      // sharp decode failure (corrupt / pixel-bomb / non-image past the magic-byte check) → invalid.
      return { code: BusinessCode.VALIDATION_FAILED, message: 'invalid image' };
    }
    return { code: BusinessCode.OK, message: 'successful', data: { avatar } };
  }

  /**
   * Generic file upload: multipart/form-data, field file=<binary>. Returns the server-generated
   * { url, name, size, mimeType } the client stores verbatim as a FILE message's content. The
   * client cannot forge any of these — url/name/mimeType are produced by the server, size is the
   * real buffer length, and parseFileContent re-validates the shape on send.
   */
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload/file')
  @ApiOperation({ summary: 'Upload a generic file (returns url/name/size/mimeType)' })
  @ApiConsumes('multipart/form-data')
  async uploadFile(@Request() req: FastifyRequest): Promise<ApiResult> {
    const f = await this.uploadService.consumeFile(req);
    if (f.kind === 'rejected') {
      return {
        code: BusinessCode.VALIDATION_FAILED,
        message:
          f.reason === 'no-file'
            ? 'no file'
            : f.reason === 'too-large'
              ? 'file too large'
              : f.reason === 'bad-name'
                ? 'invalid filename'
                : 'invalid file type',
      };
    }
    const blocked = await this.tickLocal('largeFiles');
    if (blocked) return blocked;
    const data = await this.uploadService.saveFile(
      f.mimetype,
      f.filename,
      f.buffer,
    );
    // Promote a staged FILE send if a client-message-id is present (data is already the {url,name,size,
    // mimeType} FILE content shape; staged meta for a file is empty).
    await this.maybePromote(req, data);
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  /**
   * Video upload: multipart/form-data, field file=<binary>. Backend validates only the container
   * family via magic bytes (detectMedia) — NO probe/extract/transcode. w/h/duration are client-probed
   * (<video> loadedmetadata) and carried in the VIDEO message content; the server neither reads nor
   * trusts them. Returns {url, name, size, mimeType}; the client stores it verbatim as VIDEO content.
   */
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload/video')
  @ApiOperation({ summary: 'Upload a video (magic-byte validated; width/height/duration probed client-side)' })
  @ApiConsumes('multipart/form-data')
  async uploadVideo(@Request() req: FastifyRequest): Promise<ApiResult> {
    const v = await this.uploadService.consumeVideo(req);
    if (v.kind === 'rejected') {
      return {
        code: BusinessCode.VALIDATION_FAILED,
        message: this.mediaRejectMessage(v.reason, 'video'),
      };
    }
    const blocked = await this.tickLocal('largeFiles');
    if (blocked) return blocked;
    const data = await this.uploadService.saveMedia(
      v.ext,
      v.mime,
      v.filename,
      v.buffer,
    );
    // Promote a staged VIDEO send if a client-message-id is present. data is {url,name,size,mimeType};
    // the staged meta {w,h,duration} is merged in at promote → the full VIDEO content shape.
    await this.maybePromote(req, data);
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  /** Audio upload: same contract as video with the audio family + cap. */
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload/audio')
  @ApiOperation({ summary: 'Upload audio (magic-byte validated; duration probed client-side)' })
  @ApiConsumes('multipart/form-data')
  async uploadAudio(@Request() req: FastifyRequest): Promise<ApiResult> {
    const a = await this.uploadService.consumeAudio(req);
    if (a.kind === 'rejected') {
      return {
        code: BusinessCode.VALIDATION_FAILED,
        message: this.mediaRejectMessage(a.reason, 'audio'),
      };
    }
    const blocked = await this.tickLocal('largeFiles');
    if (blocked) return blocked;
    const data = await this.uploadService.saveMedia(
      a.ext,
      a.mime,
      a.filename,
      a.buffer,
    );
    // Promote a staged AUDIO send if a client-message-id is present. data is {url,name,size,mimeType};
    // the staged meta {duration} is merged in at promote → the full AUDIO content shape.
    await this.maybePromote(req, data);
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  /** Map a ConsumedMedia rejection reason to a user-facing message. Shared by video + audio. */
  private mediaRejectMessage(
    reason: 'no-file' | 'wrong-type' | 'too-large' | 'bad-name',
    kind: 'video' | 'audio',
  ): string {
    if (reason === 'no-file') return 'no file';
    if (reason === 'too-large') return 'file too large';
    if (reason === 'bad-name') return 'invalid filename';
    return `invalid ${kind}`;
  }

  /**
   * Promote a staged media send when the upload carries an `x-client-message-id` header (the client
   * set it after POST /send-media). Links the staged record to the asset's digest (so a crash between
   * this and the promote leaves an attributable orphan), promotes it to a real Message — merging
   * `contentPayload` (the server-generated url/name/size/mimeType) with the staged client-probed meta
   * (w/h/duration) — and runs the unified fan-out. Without the header this is a plain upload (no-op).
   * A missing/stale stage → promoteStaged returns null → nothing is promoted (the upload still succeeds
   * and its result is returned; the orphan file is reclaimable by the GC).
   */
  private async maybePromote(
    req: FastifyRequest,
    contentPayload: Record<string, unknown>,
  ): Promise<void> {
    const raw = req.headers['x-client-message-id'];
    if (raw === undefined) return; // plain upload — no staged send to promote
    const clientMessageId = Array.isArray(raw) ? raw[0] : raw;
    if (typeof clientMessageId !== 'string' || clientMessageId.length === 0) return;
    const digest = extractDigests(String(contentPayload.url))[0];
    if (digest) await this.messageService.linkStagedDigest(clientMessageId, digest);
    const promoted = await this.messageService.promoteStaged(
      clientMessageId,
      contentPayload,
    );
    // Fire-and-forget: promoteStaged already committed the Message (the upload response confirms that);
    // the recipient fan-out runs off the request critical path, same as the text send path.
    if (promoted) void this.fanout.dispatch(promoted);
  }
}
