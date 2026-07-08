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
    const { url, size } = await this.uploadService.save(img.mimetype, img.buffer);
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
  @UseGuards(JwtAuthGuard)
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

  /**
   * Video upload: multipart/form-data, field file=<binary>. Backend validates only the container
   * family via magic bytes (detectMedia) — NO probe/extract/transcode. w/h/duration are client-probed
   * (<video> loadedmetadata) and carried in the VIDEO message content; the server neither reads nor
   * trusts them. Returns {url, name, size, mimeType}; the client stores it verbatim as VIDEO content.
   */
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload/video')
  @ApiOperation({ summary: '上传视频（magic-byte 校验，宽高时长前端探测）' })
  @ApiConsumes('multipart/form-data')
  async uploadVideo(@Request() req: FastifyRequest): Promise<ApiResult> {
    const v = await this.uploadService.consumeVideo(req);
    if (v.kind === 'rejected') {
      return {
        code: BusinessCode.VALIDATION_FAILED,
        message: this.mediaRejectMessage(v.reason, 'video'),
      };
    }
    const data = await this.uploadService.saveMedia(
      v.ext,
      v.mime,
      v.filename,
      v.buffer,
    );
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  /** Audio upload: same contract as video with the audio family + cap. */
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('upload/audio')
  @ApiOperation({ summary: '上传音频（magic-byte 校验，时长前端探测）' })
  @ApiConsumes('multipart/form-data')
  async uploadAudio(@Request() req: FastifyRequest): Promise<ApiResult> {
    const a = await this.uploadService.consumeAudio(req);
    if (a.kind === 'rejected') {
      return {
        code: BusinessCode.VALIDATION_FAILED,
        message: this.mediaRejectMessage(a.reason, 'audio'),
      };
    }
    const data = await this.uploadService.saveMedia(
      a.ext,
      a.mime,
      a.filename,
      a.buffer,
    );
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
}
