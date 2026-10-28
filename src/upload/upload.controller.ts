import {
  Controller,
  Post,
  Request,
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
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { UploadService } from './upload.service.js';
import { MessageService } from '../message/message.service.js';
import { MAX_VIDEO_BYTES } from './file-content.js';
import { InitResumableUploadDto } from '../dto/resumable-upload.dto.js';
import { ResumableUploadService } from './resumable-upload.service.js';
import { ContentType } from '../database/enums.js';

/**
 * Phase 7 type-agnostic upload (design doc §12.3). ONE `POST /upload` accepts 1 or N file parts,
 * magic-byte-detects each file's family, and returns `{digest,url,size,family,name?,mimeType?,w?,
 * h?,duration?}` per part. Media TYPE is a message-level concern, not a transport concern — the
 * staged contentType (`x-client-message-id`) supplies the upload `intent` for family gating
 * (IMAGE→FILE HEIC fallback, VIDEO/AUDIO container checks); GALLERY detects freely.
 *
 * The buffered route ingests each part onto the SAME UploadSession state machine as the resumable
 * transport (batch-commit model): the part that completes the batch barrier (`fileCnt` files)
 * idempotently lands every staged part into the CAS shard tree and commits the staged PendingMedia
 * into a real Message via the win-guard transaction, then fires the unified fan-out.
 * `/upload/avatar` never carries a client-message-id → never commits; it stays a separate
 * sharp-pipeline route.
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

  @ApiBearerAuth()
  @Post('uploads/resumable/:uploadId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an uncommitted resumable upload' })
  cancelResumable(
    @Request() req: FastifyRequest,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
  ) {
    return this.resumable.cancel(req.user.userId, uploadId);
  }

  @ApiBearerAuth()
  @Post('uploads/resumable/batch/:clientMessageId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel all uncommitted files in a media batch' })
  cancelResumableBatch(
    @Request() req: FastifyRequest,
    @Param('clientMessageId', new ParseUUIDPipe()) clientMessageId: string,
  ) {
    return this.resumable.cancelBatch(req.user.userId, clientMessageId);
  }

  @ApiBearerAuth()
  @Post('uploads/resumable/batch/:clientMessageId/send-completed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send completed files and discard unfinished files',
  })
  sendCompletedResumableBatch(
    @Request() req: FastifyRequest,
    @Param('clientMessageId', new ParseUUIDPipe()) clientMessageId: string,
  ) {
    return this.resumable.sendCompleted(req.user.userId, clientMessageId);
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
      // Ingest onto the shared UploadSession state machine: quota admission (session insert only,
      // retries free), record-first digest/result, then the batch commit when this part completes
      // the barrier. A quota failure leaves no file on disk; handled failures persist a staged
      // failure via withStageFailure / the BusinessException branch below.
      try {
        const view = await this.withStageFailure(req, () =>
          this.resumable.ingestBuffered(
            req.user.userId,
            {
              clientMessageId,
              partId: part.partId,
              position: part.position,
              intent: part.intent,
              originalName: file.filename ?? 'attachment',
              mimeType: file.mimetype,
            },
            file.buffer,
          ),
        );
        if (!view.result) {
          return this.failUpload(
            req,
            BusinessCode.VALIDATION_FAILED,
            'upload produced no result',
          );
        }
        payloads.push(view.result);
      } catch (error) {
        if (error instanceof BusinessException) {
          return this.failUpload(req, error.bizCode, error.message, error.data);
        }
        throw error;
      }
    }
    return payloads.length === 1 ? payloads[0] : { items: payloads };
  }

  /**
   * Avatar upload (user + group avatars): multipart/form-data, field file=<image>. Same image
   * validation as /upload (consumeImage + magic-byte), then stores one wire-safe avatar without
   * transforming its bytes. Returns { avatar } — the frontend stores it verbatim
   * as Group.avatar (create/update). User avatars are submitted as base64 together with name and bio;
   * this endpoint is the canonical upload for GROUP avatars so they land in
   * uploads/avatars/ (outside the per-object authz gate's shards/ scope) instead of generic /upload
   * (which writes to shards/ and would 401 under thread-membership authz). Never carries a client-
   * message-id → never promotes → validation failures throw directly (no staged-failure persistence).
   */
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload/avatar')
  @ApiOperation({
    summary: 'Upload one federation-sized avatar without transformation',
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
      const avatar = await this.uploadService.saveAvatar(img.buffer);
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

  /** Parse the staged upload address and reject inconsistent routing fields. */
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
