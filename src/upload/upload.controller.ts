import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { UploadService } from './upload.service.js';

/**
 * 图片上传：multipart/form-data，字段 file=图片二进制 + w/h（前端 createImageBitmap 读出的宽高）。
 * @Body 内联解构类型（无 DTO class）→ ValidationPipe 跳过（见 main.ts P1b 注释），w/h 原样保留。
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
  @UseInterceptors(FileInterceptor('file', UploadService.multerOptions))
  async upload(
    @Request() _req,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { w?: string; h?: string },
  ): Promise<ApiResult> {
    if (!file) {
      return { code: BusinessCode.VALIDATION_FAILED, message: 'no file' };
    }
    // magic number 二次校验：非真实图片拒绝（防伪造 mimetype 的恶意上传）。
    if (!this.uploadService.isImage(file.mimetype, file.buffer)) {
      return { code: BusinessCode.VALIDATION_FAILED, message: 'invalid image' };
    }
    const url = await this.uploadService.save(file.mimetype, file.buffer);
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: { url, w: Number(body.w) || 0, h: Number(body.h) || 0 },
    };
  }
}
