import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { exhaustMap, merge, of, switchMap, takeWhile, timer } from 'rxjs';
import type { FastifyRequest } from 'fastify';
import { Public } from '../common/public.decorator.js';
import { Raw } from '../common/raw.decorator.js';
import { withSseHeartbeat } from '../common/sse-heartbeat.js';
import { AdminRole } from '../database/enums.js';
import { FederationDownloadAdminService } from '../federation/federation-download-admin.service.js';
import { FederationDownloadScheduler } from '../federation/federation-download-scheduler.js';
import { ResumableUploadService } from '../upload/resumable-upload.service.js';
import { MediaCatalogService } from '../media/media-catalog.service.js';
import { MediaMaintenanceService } from '../media/media-maintenance.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';
import { ADMIN_SESSION_COOKIE } from './admin-session.js';
import {
  MediaBatchesDto,
  MediaDigestDto,
  MediaFilesDto,
  MediaPageDto,
} from './media-admin.dto.js';

/** Explicit privacy-safe projections and commands; never expose client upload/message payloads. */
@ApiTags('admin')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Roles(AdminRole.SUPER_ADMIN)
@Public()
@Controller('admin/media')
export class MediaTransferAdminController {
  constructor(
    private readonly downloads: FederationDownloadAdminService,
    private readonly uploads: ResumableUploadService,
    private readonly catalog: MediaCatalogService,
    private readonly maintenance: MediaMaintenanceService,
    private readonly scheduler: FederationDownloadScheduler,
    private readonly auth: AdminAuthService,
  ) {}

  @Post('files')
  @HttpCode(200)
  files(@Body() dto: MediaFilesDto) {
    return this.catalog.files(dto);
  }

  @Post('temporary')
  @HttpCode(200)
  async temporary(@Body() dto: MediaFilesDto) {
    void dto;
    throw new ConflictException(
      'Use the explicit scan in Garbage file cleanup',
    );
  }

  @Audit('media.temporary.clean', {
    targetType: 'media-asset',
    targetBody: 'digest',
  })
  @Post('temporary/clean')
  @HttpCode(200)
  async cleanTemporary(@Body() dto: MediaDigestDto) {
    void dto;
    throw new ConflictException(
      'Use Garbage file cleanup: scan and confirm an individual cleanup candidate',
    );
  }

  @Post('uploads')
  @HttpCode(200)
  activeUploads(@Body() dto: MediaPageDto) {
    return this.uploads.listForAdmin(dto);
  }

  @Audit('media.upload.stop', {
    targetType: 'upload',
    targetParam: 'id',
  })
  @Post('uploads/:id/stop')
  @HttpCode(200)
  stopUpload(@Param('id') id: string) {
    return this.uploads.stopForAdmin(id);
  }

  @Audit('media.upload.retry', {
    targetType: 'upload',
    targetParam: 'id',
  })
  @Post('uploads/:id/retry')
  @HttpCode(200)
  retryUpload(@Param('id') id: string) {
    return this.uploads.retryForAdmin(id);
  }

  @Post('downloads')
  @HttpCode(200)
  downloadsInbox(@Body() dto: MediaBatchesDto) {
    return this.catalog.batches(dto);
  }

  @Audit('media.download.stop', {
    targetType: 'media-batch',
    targetParam: 'batchId',
  })
  @Post('downloads/:batchId/stop')
  @HttpCode(200)
  async stopDownload(@Param('batchId', new ParseUUIDPipe()) batchId: string) {
    await this.downloads.stop(batchId);
    return { stopped: true };
  }

  @Audit('media.download.retry', {
    targetType: 'media-batch',
    targetParam: 'batchId',
  })
  @Post('downloads/:batchId/retry')
  @HttpCode(200)
  retryDownload(@Param('batchId', new ParseUUIDPipe()) batchId: string) {
    return this.downloads.retry(batchId);
  }

  @Audit('media.file.reclaim', {
    targetType: 'media-asset',
    targetBody: 'digest',
  })
  @Post('files/reclaim')
  @HttpCode(200)
  reclaim(@Body() dto: MediaDigestDto) {
    return this.maintenance.reclaim(dto.digest);
  }

  @Audit('media.download.stop', {
    targetType: 'media-asset',
    targetBody: 'digest',
  })
  @Post('downloader/stop')
  @HttpCode(200)
  async stopPhysicalDownload(@Body() dto: MediaDigestDto) {
    await this.scheduler.stopDigest(dto.digest);
    return { stopped: true };
  }

  @Raw()
  @Sse('downloader/stream')
  stream(@Query() dto: MediaPageDto, @Req() request: FastifyRequest) {
    const snapshots = this.scheduler.observe(dto.skip, dto.take).pipe(
      switchMap(
        async (snapshot): Promise<MessageEvent> => ({
          type: 'snapshot',
          data: {
            ...snapshot,
            list: await this.catalog.annotateRuntime(snapshot.list),
          },
        }),
      ),
    );
    // Revoked/expired sessions and role changes must not keep observing an established stream.
    const authorization = timer(30_000, 30_000).pipe(
      exhaustMap(() =>
        this.auth.validateAdminSession(
          request.cookies[ADMIN_SESSION_COOKIE] ?? '',
          request.ip,
        ),
      ),
      exhaustMap((principal) =>
        principal?.role === AdminRole.SUPER_ADMIN
          ? of<MessageEvent>()
          : of<MessageEvent>({ type: 'access-revoked', data: {} }),
      ),
    );
    return merge(snapshots, authorization).pipe(
      takeWhile((event) => event.type !== 'access-revoked', true),
      withSseHeartbeat(),
    );
  }
}
