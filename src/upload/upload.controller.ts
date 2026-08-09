import {
  Controller,
  Post,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
  Body,
  Get,
  Headers,
  Param,
  Put,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RouteConfig } from '@nestjs/platform-fastify';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { UploadService } from './upload.service.js';
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { MAX_VIDEO_BYTES } from './file-content.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { InitResumableUploadDto } from '../dto/resumable-upload.dto.js';
import {
  RESUMABLE_CHUNK_SIZE,
  ResumableUploadService,
} from './resumable-upload.service.js';
import { ContentType } from '../database/enums.js';

/**
 * Phase 7 type-agnostic upload (design doc §12.3). ONE `POST /upload` accepts 1 or N file parts,
 * magic-byte-detects each file's family, and returns `{digest,url,size,family,name?,mimeType?,w?,
 * h?,duration?}` per part. Media TYPE is a message-level concern, not a transport concern — the
 * staged contentType (`x-client-message-id`) supplies the upload `intent` for family gating
 * (IMAGE→FILE HEIC fallback, VIDEO/AUDIO container checks); GALLERY detects freely.
 *
 * The route doubles as the PROMOTE step of a staged media send: each part upserts a
 * FileSyncProgress(OUTBOUND, SUCCEEDED) row for the batch, and the part that completes the barrier
 * (`fileCnt` files) promotes the staged PendingMedia into a real Message via the win-guard
 * transaction, then fires the unified fan-out. `/upload/avatar` never carries a client-message-id →
 * never promotes; it stays a separate sharp-pipeline route.
 *
 * Handlers return raw data; the global SerializeInterceptor wraps the ApiResult envelope. Validation /
 * handled failures throw BusinessException (after persisting a staged failure, via failUpload); the
 * global AllExceptionsFilter renders the error body.
 */
@ApiTags('upload')
@Controller()
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly messageService: MessageService,
    private readonly fanout: MessageFanoutService,
    private readonly userQuota: UserQuotaService,
    private readonly resumable: ResumableUploadService,
  ) {}

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('uploads/resumable/init')
  @ApiOperation({
    summary: 'Initialize or recover a sequential upload session',
  })
  initResumable(
    @Request() req: FastifyRequest,
    @Body() dto: InitResumableUploadDto,
  ) {
    return this.resumable.init(req.user.userId, dto);
  }

  @ApiBearerAuth()
  @Get('uploads/resumable/:uploadId')
  @ApiOperation({ summary: 'Get the authoritative resumable upload offset' })
  resumableStatus(
    @Request() req: FastifyRequest,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
  ) {
    return this.resumable.status(req.user.userId, uploadId);
  }

  @ApiBearerAuth()
  @Put('uploads/resumable/:uploadId')
  @RouteConfig({ bodyLimit: RESUMABLE_CHUNK_SIZE })
  @ApiConsumes('application/octet-stream')
  @ApiOperation({ summary: 'Append one ordered upload chunk' })
  appendResumable(
    @Request() req: FastifyRequest,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
    @Headers('content-range') contentRange: string | undefined,
    @Body() body: Buffer,
  ) {
    return this.resumable.append(
      req.user.userId,
      uploadId,
      contentRange,
      Buffer.isBuffer(body) ? body : Buffer.from(body ?? ''),
    );
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('uploads/resumable/:uploadId/complete')
  @ApiOperation({ summary: 'Validate, publish and promote a completed upload' })
  completeResumable(
    @Request() req: FastifyRequest,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
  ) {
    return this.resumable.complete(req.user.userId, uploadId);
  }

  /**
   * Type-agnostic media upload + staged-send promote (Phase 7). Accepts 1 or N file parts; each part
   * carries its companion form fields (w/h/duration). For a single file the per-file payload object is
   * returned; for multiple files in one request, `{ items: [...] }`. GALLERY sends are N parallel
   * single-file requests sharing one `x-client-message-id`; the Nth request's barrier check promotes
   * the batch into one Message and fires the fan-out.
   */
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload')
  @ApiOperation({
    summary:
      'Upload one or more media files (type-agnostic; promotes a staged send at the batch barrier)',
  })
  @ApiConsumes('multipart/form-data')
  async upload(@Request() req: FastifyRequest) {
    const clientMessageId = this.clientMessageId(req);
    if (!clientMessageId) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'missing x-client-message-id',
        HttpStatus.OK,
      );
    }
    const intent = await this.messageService.getStagedIntent(
      clientMessageId,
      req.user.userId,
    );
    if (!intent) {
      return this.failUpload(
        req,
        BusinessCode.VALIDATION_FAILED,
        'media send is not pending',
      );
    }
    const consumed = await this.withStageFailure(req, () =>
      this.uploadService.consumeParts(req, { maxBytes: MAX_VIDEO_BYTES }),
    );
    if (consumed.kind === 'rejected') {
      return this.failUpload(
        req,
        BusinessCode.VALIDATION_FAILED,
        this.partRejectMessage(consumed.reason),
      );
    }
    if (consumed.files.length !== 1) {
      return this.failUpload(
        req,
        BusinessCode.VALIDATION_FAILED,
        'exactly one file part is required per request',
      );
    }
    let part: ReturnType<UploadController['uploadPartFields']>;
    try {
      part = this.uploadPartFields(consumed.fields, intent);
    } catch (error) {
      if (error instanceof BusinessException) {
        return this.failUpload(req, error.bizCode, error.message, error.data);
      }
      throw error;
    }
    const payloads = [];
    for (const file of consumed.files) {
      // Quota BEFORE saveCas: charge file cnt + total bytes at admission (the real byte size is known
      // here), so a quota failure leaves no orphan file on disk. Type-agnostic — media family no longer
      // affects quota (savePart detects family from the staged intent for storage, not for quota).
      await this.admitUpload(req, file.buffer.length);
      const saved = await this.withStageFailure(req, () =>
        this.uploadService.savePart(file.buffer, part.intent, {
          filename: file.filename,
          declaredMime: file.mimetype,
        }),
      );
      const result = await this.withStageFailure(req, () =>
        this.messageService.markOutboundFileSucceeded(
          clientMessageId,
          part.partId,
          part.position,
          saved.payload.digest,
          saved.payload,
          req.user.userId,
          saved.overrideContentType,
        ),
      );
      // Only the request that newly commits the Message fires the fan-out (win-guard makes the rest
      // no-ops). Promote may be null while the barrier is not yet met (more files still to come).
      if (result?.newlyPromoted) void this.fanout.dispatch(result.message);
      payloads.push(saved.payload);
    }
    return payloads.length === 1 ? payloads[0] : { items: payloads };
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
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        this.imageRejectMessage(img.reason),
      );
    }
    if (!this.uploadService.isImage(img.mimetype, img.buffer)) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid image',
      );
    }
    try {
      const avatar = await this.uploadService.saveAvatars(img.buffer);
      return { avatar };
    } catch {
      // sharp decode failure (corrupt / pixel-bomb / non-image past the magic-byte check) → invalid.
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid image',
      );
    }
  }

  /** Map a ConsumedImage image rejection reason to a user-facing message (avatar path). */
  private imageRejectMessage(
    reason: 'no-file' | 'wrong-type' | 'too-large',
  ): string {
    if (reason === 'no-file') return 'no file';
    if (reason === 'too-large') return 'file too large';
    return 'invalid image';
  }

  /** Map a type-agnostic consumeParts rejection reason to a user-facing message. */
  private partRejectMessage(reason: 'no-file' | 'too-large'): string {
    if (reason === 'no-file') return 'no file';
    return 'file too large';
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
      await this.messageService.failStaged(
        req.user.userId,
        clientMessageId,
        message,
      );
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
      if (
        error instanceof Error &&
        /^(?:invalid (?:image|video|audio|media)|audio upload|video upload)/.test(
          error.message,
        )
      ) {
        return this.failUpload(
          req,
          BusinessCode.VALIDATION_FAILED,
          error.message,
        );
      }
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
   * Charge the account's daily file quota — file cnt + file total size — at the admission point, BEFORE
   * CAS persistence, where the real byte size is known. This is where BOTH the staged-send file count
   * (deferred from POST /send-media) and any plain upload are consumed. Type-agnostic: media family no
   * longer factors into quota (the old images/largeFiles split is gone). assertCanSend gates the user's
   * breaker; preCheckFile refuses a claim that would exceed; tickLax + tickFileBytes record it. A quota
   * failure persists a staged failure (failUpload) and aborts the send, leaving no orphan file on disk.
   */
  private async admitUpload(req: FastifyRequest, bytes: number): Promise<void> {
    try {
      const userId = req.user.userId;
      await this.userQuota.assertCanSend(userId);
      await this.userQuota.preCheckFile(userId, 1, BigInt(bytes));
      await this.userQuota.tickLax(userId, 'files');
      await this.userQuota.tickFileBytes(userId, BigInt(bytes));
    } catch (error) {
      if (error instanceof BusinessException) {
        return this.failUpload(req, error.bizCode, error.message, error.data);
      }
      throw error;
    }
  }

  private uploadPartFields(
    fields: Record<string, string>,
    stagedType: ContentType,
  ): {
    partId: string;
    position: number;
    intent: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';
  } {
    const partId = fields.partId;
    const position = Number(fields.position);
    const intent = fields.intent;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        partId ?? '',
      ) ||
      !Number.isInteger(position) ||
      position < 0 ||
      position > 9 ||
      !['IMAGE', 'VIDEO', 'AUDIO', 'FILE'].includes(intent)
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid upload part identity',
      );
    }
    if (stagedType !== ContentType.GALLERY && stagedType !== intent) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'upload intent does not match the staged message',
      );
    }
    return {
      partId,
      position,
      intent: intent as 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE',
    };
  }
}
