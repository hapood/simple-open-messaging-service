import {
  Controller,
  Post,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { MediaAssetGcService } from './media-asset-gc.service.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * Admin-only media garbage-collection endpoints. Not exposed to regular users. The primary trigger
 * (POST admin/media/gc) reclaims orphaned content-addressed files (MediaAsset refs <= 0) + sweeps
 * stale tmp; the reconcile scan (POST admin/media/reconcile) walks the shards dir vs the table and is
 * O(files) — run sparingly. A daily @Cron can be wired later; for now these are manual triggers.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller()
export class MediaAssetGcController {
  constructor(private readonly gc: MediaAssetGcService) {}

  @HttpCode(HttpStatus.OK)
  @Post('admin/media/gc')
  @ApiOperation({ summary: 'Reclaim orphaned media (MediaAsset refs<=0) + sweep stale tmp' })
  async triggerGc(): Promise<ApiResult> {
    const data = await this.gc.gcOrphanedAssets();
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/media/reconcile')
  @ApiOperation({
    summary: 'Scan-driven reconcile of shards vs MediaAsset (O(files); run sparingly)',
  })
  async reconcile(): Promise<ApiResult> {
    const reapedFiles = await this.gc.reconcileShards();
    return { code: BusinessCode.OK, message: 'successful', data: { reapedFiles } };
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/media/gc-avatars')
  @ApiOperation({
    summary: 'Reap orphaned avatars (no longer any User/Group current avatar) from uploads/avatars + legacy flat',
  })
  async gcAvatars(): Promise<ApiResult> {
    const data = await this.gc.gcOrphanedAvatars();
    return { code: BusinessCode.OK, message: 'successful', data };
  }
}
