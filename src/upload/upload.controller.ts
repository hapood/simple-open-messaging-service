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
  @Get('uploads/resumable/:id')
  @ApiOperation({ summary: 'Get the authoritative resumable upload offset' })
  resumableStatus(@Request() req: FastifyRequest, @Param('id') id: string) {
    return this.resumable.status(req.user.userId, id);
  }

  @ApiBearerAuth()
  @Put('uploads/resumable/:id')
  @ApiConsumes('application/octet-stream')
  @ApiOperation({ summary: 'Append one ordered upload chunk' })
  appendResumable(
    @Request() req: FastifyRequest,
    @Param('id') id: string,
    @Headers('content-range') contentRange: string | undefined,
    @Body() body: Buffer,
  ) {
    return this.resumable.append(
      req.user.userId,
      id,
      contentRange,
      Buffer.isBuffer(body) ? body : Buffer.from(body ?? ''),
    );
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('uploads/resumable/:id/complete')
  @ApiOperation({ summary: 'Validate, publish and promote a completed upload' })
  completeResumable(@Request() req: FastifyRequest, @Param('id') id: string) {
    return this.resumable.complete(req.user.userId, id);
  }

  @ApiBearerAuth()
  @Post('uploads/resumable/:id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reactivate a failed upload using its retained checkpoint when available',
  })
  retryResumable(@Request() req: FastifyRequest, @Param('id') id: string) {
    return this.resumable.retry(req.user.userId, id);
  }

  @ApiBearerAuth()
  @Post('uploads/resumable/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel one uncommitted upload and delete its temporary files',
  })
  cancelResumable(@Request() req: FastifyRequest, @Param('id') id: string) {
    return this.resumable.cancel(req.user.userId, id);
  }

  @ApiBearerAuth()
  @Post('uploads/resumable/batch/:clientMessageId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel a media batch, deleting its temporary files and message stage',
  })
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
