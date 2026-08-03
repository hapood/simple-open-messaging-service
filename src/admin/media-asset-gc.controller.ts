import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Body,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';
import { AdminRole } from '../database/enums.js';
import { MediaAssetGcService } from './media-asset-gc.service.js';
import { Raw } from '../common/raw.decorator.js';
import { ResumableUploadService } from '../upload/resumable-upload.service.js';

/**
 * Admin-only media garbage-collection endpoints. Not exposed to regular users. The primary trigger
 * (POST admin/media/gc) reclaims READY blobs unused by live messages or active staging + sweeps
 * stale tmp; the reconcile scan (POST admin/media/reconcile) walks the shards dir vs the table and is
 * O(files) — run sparingly. A daily @Cron can be wired later; for now these are manual triggers.
 *
 * All three are SUPER_ADMIN-only (reclaiming/deleting on-disk content is high-impact) and audited.
 * Handlers return raw data; the global SerializeInterceptor wraps the ApiResult envelope.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Roles(AdminRole.SUPER_ADMIN)
@Public()
@Controller()
export class MediaAssetGcController {
  constructor(
    private readonly gc: MediaAssetGcService,
    private readonly resumable: ResumableUploadService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('admin/media/uploads')
  @ApiOperation({ summary: 'List active resumable upload sessions' })
  activeUploads() {
    return this.resumable.listForAdmin();
  }

  @Audit('media.upload.abort', {
    targetType: 'upload',
    targetParam: 'uploadId',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/uploads/:uploadId/abort')
  @ApiOperation({ summary: 'Terminate an active resumable upload session' })
  abortUpload(@Param('uploadId', new ParseUUIDPipe()) uploadId: string) {
    return this.resumable.abortForAdmin(uploadId);
  }

  @Audit('media.gc')
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/gc')
  @ApiOperation({
    summary: 'Manually reclaim media unused by live messages or active staging',
  })
  async triggerGc() {
    return this.gc.startTask('gc');
  }

  @Audit('media.reconcile')
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/reconcile')
  @ApiOperation({
    summary:
      'Scan-driven reconcile of shards vs MediaAsset (O(files); run sparingly)',
  })
  async reconcile() {
    return this.gc.startTask('reconcile');
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/media/tasks/current')
  @ApiOperation({
    summary: 'Get the current or most recent media maintenance task',
  })
  currentTask() {
    return this.gc.getCurrentTask();
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/media/tasks/:id/status')
  @ApiOperation({ summary: 'Get a media maintenance task snapshot' })
  taskStatus(@Param('id') id: string) {
    return this.gc.getTask(id);
  }

  @Audit('media.task.cancel')
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/tasks/:id/cancel')
  @ApiOperation({
    summary: 'Request cooperative cancellation of a media maintenance task',
  })
  cancelTask(@Param('id') id: string) {
    return this.gc.cancelTask(id);
  }

  @Raw()
  @Get('admin/media/tasks/:id/progress')
  @ApiOperation({ summary: 'Stream media maintenance task progress over SSE' })
  taskProgress(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): void {
    this.gc.getTask(id);
    reply.hijack();
    this.gc.attachProgress(id, reply.raw, req.headers.origin);
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/media/pending/list')
  @ApiOperation({ summary: 'List PENDING CAS uploads for manual review' })
  listPending() {
    return this.gc.listPendingAssets();
  }

  @Audit('media.pending.force_terminate')
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/pending/force-terminate')
  @ApiOperation({
    summary: 'Best-effort terminate and clean one PENDING CAS upload',
  })
  forceTerminatePending(@Body() body: { digest: string }) {
    return this.gc.forceTerminatePending(body.digest);
  }

  @Audit('media.gc_avatars')
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/gc-avatars')
  @ApiOperation({
    summary:
      'Reap orphaned avatars (no longer any User current avatar) from uploads/avatars',
  })
  async gcAvatars() {
    return this.gc.gcOrphanedAvatars();
  }

  @Audit('media.inspect_forward_bundles')
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/forward-bundles/inspect')
  @ApiOperation({ summary: 'Inspect unreachable forward bundles (read-only)' })
  inspectForwardBundles() {
    return this.gc.inspectOrphanedForwardBundles();
  }

  @Audit('media.gc_forward_bundles')
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/forward-bundles/gc')
  @ApiOperation({
    summary: 'Delete unreachable forward bundle metadata',
  })
  gcForwardBundles() {
    return this.gc.gcOrphanedForwardBundles();
  }
}
