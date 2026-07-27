import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';
import { AdminRole } from '../prisma/generated/client.js';
import { MediaAssetGcService } from './media-asset-gc.service.js';

/**
 * Admin-only media garbage-collection endpoints. Not exposed to regular users. The primary trigger
 * (POST admin/media/gc) reclaims orphaned content-addressed files (MediaAsset refs <= 0) + sweeps
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
  constructor(private readonly gc: MediaAssetGcService) {}

  @Audit('media.gc')
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/gc')
  @ApiOperation({ summary: 'Reclaim orphaned media (MediaAsset refs<=0) + sweep stale tmp' })
  async triggerGc() {
    return this.gc.gcOrphanedAssets();
  }

  @Audit('media.reconcile')
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/reconcile')
  @ApiOperation({
    summary: 'Scan-driven reconcile of shards vs MediaAsset (O(files); run sparingly)',
  })
  async reconcile() {
    return { reapedFiles: await this.gc.reconcileShards() };
  }

  @Audit('media.gc_avatars')
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/gc-avatars')
  @ApiOperation({
    summary: 'Reap orphaned avatars (no longer any User current avatar) from uploads/avatars',
  })
  async gcAvatars() {
    return this.gc.gcOrphanedAvatars();
  }
}
