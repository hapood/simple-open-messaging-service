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
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
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
 *
 * Handlers return raw data; the global SerializeInterceptor wraps the ApiResult envelope. Validation /
 * quota failures throw BusinessException (after persisting a staged failure, via failUpload); the global
 * AllExceptionsFilter renders the error body.
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

  /** Tick the local aggregate daily quota for a media upload; throws BusinessException(QUOTA_EXCEEDED)
   *  (after persisting a staged failure) when the budget is exhausted, else returns. Local uploads already
   *  enforce per-item size via the /upload pipeline, so this is the COUNT cap only (no byte 413). */
  private async tickLocal(req: FastifyRequest, category: 'images' | 'largeFiles'): Promise<void> {
    const q = await this.quota.tryTickLocal(category);
    if (q.exceeded) {
      await this.failUpload(
        req,
        BusinessCode.QUOTA_EXCEEDED,
        `daily ${category} quota reached (${q.limit}); resets in ${q.retryAfter}s`,
        { category, limit: q.limit, retryAfter: q.retryAfter },
      );
    }
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload')
  @ApiOperation({
    summary:
      'Upload an image (returns url + width/height provided by the client)',
  })
  @ApiConsumes('multipart/form-data')
  async upload(@Request() req: FastifyRequest) {
    const img = await this.withStageFailure(req, () =>
      this.uploadService.consumeImage(req),
    );
    if (img.kind === 'rejected') {
      return this.failUpload(req, BusinessCode.VALIDATION_FAILED, this.imageRejectMessage(img.reason));
    }
    // Magic-number second check: reject non-genuine images (defends against forged-mimetype malicious uploads).
    if (!this.uploadService.isImage(img.mimetype, img.buffer)) {
      return this.failUpload(req, BusinessCode.VALIDATION_FAILED, 'invalid image');
    }
    await this.tickLocal(req, 'images');
    const { url, size } = await this.withStageFailure(req, () =>
      this.uploadService.save(img.mimetype, img.buffer),
    );
    // Promote a staged IMAGE send if this upload carries a client-message-id. The promote payload is the
    // full server-authored content {url,w,h,size} — `size` (the real buffer length from saveCas) MUST be
    // carried here so the persisted Message.content carries it; parseImageContent reads it back to render
    // the meta bar (omit it and every reloaded/echoed image shows "unknown size"). Mirrors FILE/VIDEO/
    // AUDIO, which all pass the complete server-generated payload. The staged meta for an image is empty
    // — w/h come from consumeImage above.
    await this.withStageFailure(req, () =>
      this.maybePromote(req, { url, w: img.w, h: img.h, size }),
    );
    return { url, w: img.w, h: img.h, size };
  }

  /**
   * Avatar upload (user + group avatars): multipart/form-data, field file=<image>. Same image
   * validation as /upload (consumeImage + magic-byte), then the sharp multi-size webp avatar
   * pipeline (saveAvatars). Returns { avatar: representativeUrl } — the frontend stores it verbatim
   * as Group.avatar (create/update). User avatars still go through /user/update-avatar (which calls
   * saveAvatars directly); this endpoint is the canonical upload for GROUP avatars so they land in
   * uploads/avatars/ (outside the per-object authz gate's shards/ scope) instead of generic /upload
   * (which writes to shards/ and would 401 under thread-membership authz). Never carries a client-
   * message-id → never promotes → validation failures throw directly (no staged-failure persistence).
   */
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload/avatar')
  @ApiOperation({
    summary:
      'Upload avatar image (multi-size webp, returns representative url)',
  })
  @ApiConsumes('multipart/form-data')
  async uploadAvatar(@Request() req: FastifyRequest) {
    const img = await this.uploadService.consumeImage(req);
    if (img.kind === 'rejected') {
      throw new BusinessException(BusinessCode.VALIDATION_FAILED, this.imageRejectMessage(img.reason));
    }
    if (!this.uploadService.isImage(img.mimetype, img.buffer)) {
      throw new BusinessException(BusinessCode.VALIDATION_FAILED, 'invalid image');
    }
    try {
      const avatar = await this.uploadService.saveAvatars(img.buffer);
      return { avatar };
    } catch {
      // sharp decode failure (corrupt / pixel-bomb / non-image past the magic-byte check) → invalid.
      throw new BusinessException(BusinessCode.VALIDATION_FAILED, 'invalid image');
    }
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
  @ApiOperation({
    summary: 'Upload a generic file (returns url/name/size/mimeType)',
  })
  @ApiConsumes('multipart/form-data')
  async uploadFile(@Request() req: FastifyRequest) {
    const f = await this.withStageFailure(req, () =>
      this.uploadService.consumeFile(req),
    );
    if (f.kind === 'rejected') {
      return this.failUpload(req, BusinessCode.VALIDATION_FAILED, this.fileRejectMessage(f.reason));
    }
    await this.tickLocal(req, 'largeFiles');
    const data = await this.withStageFailure(req, () =>
      this.uploadService.saveFile(f.mimetype, f.filename, f.buffer),
    );
    // Promote a staged FILE send if a client-message-id is present (data is already the {url,name,size,
    // mimeType} FILE content shape; staged meta for a file is empty).
    await this.withStageFailure(req, () => this.maybePromote(req, data));
    return data;
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
  @ApiOperation({
    summary:
      'Upload a video (magic-byte validated; width/height/duration probed client-side)',
  })
  @ApiConsumes('multipart/form-data')
  async uploadVideo(@Request() req: FastifyRequest) {
    const v = await this.withStageFailure(req, () =>
      this.uploadService.consumeVideo(req),
    );
    if (v.kind === 'rejected') {
      return this.failUpload(req, BusinessCode.VALIDATION_FAILED, this.mediaRejectMessage(v.reason, 'video'));
    }
    await this.tickLocal(req, 'largeFiles');
    const data = await this.withStageFailure(req, () =>
      this.uploadService.saveMedia(v.ext, v.mime, v.filename, v.buffer),
    );
    // Promote a staged VIDEO send if a client-message-id is present. data is {url,name,size,mimeType};
    // the staged meta {w,h,duration} is merged in at promote → the full VIDEO content shape.
    await this.withStageFailure(req, () => this.maybePromote(req, data));
    return data;
  }

  /** Audio upload: same contract as video with the audio family + cap. */
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload/audio')
  @ApiOperation({
    summary: 'Upload audio (magic-byte validated; duration probed client-side)',
  })
  @ApiConsumes('multipart/form-data')
  async uploadAudio(@Request() req: FastifyRequest) {
    const a = await this.withStageFailure(req, () =>
      this.uploadService.consumeAudio(req),
    );
    if (a.kind === 'rejected') {
      return this.failUpload(req, BusinessCode.VALIDATION_FAILED, this.mediaRejectMessage(a.reason, 'audio'));
    }
    await this.tickLocal(req, 'largeFiles');
    const data = await this.withStageFailure(req, () =>
      this.uploadService.saveMedia(a.ext, a.mime, a.filename, a.buffer),
    );
    // Promote a staged AUDIO send if a client-message-id is present. data is {url,name,size,mimeType};
    // the staged meta {duration} is merged in at promote → the full AUDIO content shape.
    const promoted = await this.withStageFailure(req, () =>
      this.maybePromote(req, data),
    );
    return { ...data, promoted };
  }

  /** Map a ConsumedMedia image rejection reason to a user-facing message. */
  private imageRejectMessage(
    reason: 'no-file' | 'wrong-type' | 'too-large' | 'bad-name',
  ): string {
    if (reason === 'no-file') return 'no file';
    if (reason === 'too-large') return 'file too large';
    return 'invalid image';
  }

  /** Map a ConsumedMedia file rejection reason to a user-facing message. */
  private fileRejectMessage(
    reason: 'no-file' | 'wrong-type' | 'too-large' | 'bad-name',
  ): string {
    if (reason === 'no-file') return 'no file';
    if (reason === 'too-large') return 'file too large';
    if (reason === 'bad-name') return 'invalid filename';
    return 'invalid file type';
  }

  /** Map a ConsumedMedia media (video/audio) rejection reason to a user-facing message. */
  private mediaRejectMessage(
    reason: 'no-file' | 'wrong-type' | 'too-large' | 'bad-name',
    kind: 'video' | 'audio',
  ): string {
    if (reason === 'no-file') return 'no file';
    if (reason === 'too-large') return 'file too large';
    if (reason === 'bad-name') return 'invalid filename';
    return `invalid ${kind}`;
  }

  /** Persist a handled upload rejection as a staged failure, then throw it as a BusinessException
   *  (the global filter renders the error body). Never returns. */
  private async failUpload(
    req: FastifyRequest,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<never> {
    const clientMessageId = this.clientMessageId(req);
    if (clientMessageId) {
      await this.messageService.failStaged(req.user.userId, clientMessageId, message);
    }
    throw new BusinessException(code, message, HttpStatus.OK, data);
  }

  /** Unexpected parser/storage/promote errors still become durable failures, then retain their
   * original exception so the global filter can produce the normal system-error response. */
  private async withStageFailure<T>(
    req: FastifyRequest,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const clientMessageId = this.clientMessageId(req);
      if (clientMessageId) {
        await this.messageService.failStaged(
          req.user.userId,
          clientMessageId,
          'upload failed',
        );
      }
      throw error;
    }
  }

  private clientMessageId(req: FastifyRequest): string | undefined {
    const raw = req.headers['x-client-message-id'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
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
  ): Promise<boolean> {
    const clientMessageId = this.clientMessageId(req);
    if (!clientMessageId) return false; // plain upload — no staged send to promote
    const digest = extractDigests(String(contentPayload.url))[0];
    if (digest) {
      await this.messageService.linkStagedDigest(
        clientMessageId,
        digest,
        req.user.userId,
      );
    }
    const promoted = await this.messageService.promoteStaged(
      clientMessageId,
      contentPayload,
      req.user.userId,
    );
    // Fire-and-forget: promoteStaged already committed the Message (the upload response confirms that);
    // the recipient fan-out runs off the request critical path, same as the text send path.
    if (promoted) void this.fanout.dispatch(promoted);
    return promoted !== null;
  }
}
