import { Public } from '../common/public.decorator.js';
import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRole } from '../database/enums.js';
import { FederationDownloadAdminService } from '../federation/federation-download-admin.service.js';
import { ResumableUploadService } from '../upload/resumable-upload.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';

/** Administrative views and explicit operations for active media transfers. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Roles(AdminRole.SUPER_ADMIN)
@Public()
@Controller()
export class MediaTransferAdminController {
  constructor(
    private readonly downloads: FederationDownloadAdminService,
    private readonly uploads: ResumableUploadService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('admin/media/uploads')
  @ApiOperation({ summary: 'List active resumable upload sessions' })
  activeUploads() {
    return this.uploads.listForAdmin();
  }

  @Audit('media.upload.abort', {
    targetType: 'upload',
    targetParam: 'uploadId',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/uploads/:uploadId/abort')
  @ApiOperation({ summary: 'Terminate an active resumable upload session' })
  abortUpload(@Param('uploadId', new ParseUUIDPipe()) uploadId: string) {
    return this.uploads.abortForAdmin(uploadId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/media/downloads')
  @ApiOperation({ summary: 'List inbound federation download batches' })
  downloadsInbox() {
    return this.downloads.list();
  }

  @Audit('media.download.retry', {
    targetType: 'media-batch',
    targetParam: 'batchId',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/downloads/:batchId/retry')
  @ApiOperation({ summary: 'Retry a failed inbound federation download' })
  retryDownload(@Param('batchId', new ParseUUIDPipe()) batchId: string) {
    return this.downloads.retry(batchId);
  }

  @Audit('media.download.clean', {
    targetType: 'media-batch',
    targetParam: 'batchId',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/downloads/:batchId/clean')
  @ApiOperation({ summary: 'Remove an inbound federation download job' })
  cleanDownload(@Param('batchId', new ParseUUIDPipe()) batchId: string) {
    return this.downloads.clean(batchId);
  }
}
