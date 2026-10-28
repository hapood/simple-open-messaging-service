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
import { InitResumableUploadDto } from '../dto/resumable-upload.dto.js';
import { ResumableUploadService } from './resumable-upload.service.js';

/** Message attachments use sequential sessions; only avatars use multipart transport. */
@ApiTags('upload')
@Controller()
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
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

  /** Group avatars are validated and stored verbatim outside message attachment shards. */
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
        img.reason === 'no-file'
          ? 'no file'
          : img.reason === 'too-large'
            ? 'file too large'
            : 'invalid image',
      );
    }
    if (!this.uploadService.isImage(img.mimetype, img.buffer)) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid image',
      );
    }
    try {
      return { avatar: await this.uploadService.saveAvatar(img.buffer) };
    } catch {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid image',
      );
    }
  }
}
