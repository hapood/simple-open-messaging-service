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
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { UploadService } from './upload.service.js';

/**
 * 图片上传：multipart/form-data，字段 file=图片二进制 + w/h（前端 createImageBitmap 读出的宽高）。
 * w/h 经 consumeImage 解析（无 DTO class，ValidationPipe 不介入），原样回填。
 */
@ApiTags('upload')
@Controller()
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload')
  @ApiOperation({ summary: '上传图片（返回 url + 前端传入的宽高）' })
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
    // magic number 二次校验：非真实图片拒绝（防伪造 mimetype 的恶意上传）。
    if (!this.uploadService.isImage(img.mimetype, img.buffer)) {
      return { code: BusinessCode.VALIDATION_FAILED, message: 'invalid image' };
    }
    const url = await this.uploadService.save(img.mimetype, img.buffer);
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: { url, w: img.w, h: img.h },
    };
  }

  /**
   * Generic file upload: multipart/form-data, field file=<binary>. Returns the server-generated
   * { url, name, size, mimeType } the client stores verbatim as a FILE message's content. The
   * client cannot forge any of these — url/name/mimeType are produced by the server, size is the
   * real buffer length, and parseFileContent re-validates the shape on send.
   */
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload/file')
  @ApiOperation({ summary: '上传通用文件（返回 url/name/size/mimeType）' })
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
    const data = await this.uploadService.saveFile(
      f.mimetype,
      f.filename,
      f.buffer,
    );
    return { code: BusinessCode.OK, message: 'successful', data };
  }
}
